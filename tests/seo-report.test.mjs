/* tools/seo-report.mjs — configuration, credential hygiene, and the
 * snapshot it writes.
 *
 * NO REQUEST IS EVER MADE TO GOOGLE. Every exchange runs against a real
 * node:http server on loopback, reached through the GOOGLE_TOKEN_URL and
 * GOOGLE_API_BASE overrides the script restricts to loopback addresses.
 * Real sockets, real RSA keys, real signature verification — not mocks,
 * because the claims here are about bytes on a wire and a file on disk
 * (CLAUDE.md rule 14).
 *
 * Every test drives the script as a REAL CHILD PROCESS and asserts on what
 * an operator would actually see — exit status, stderr, and the snapshot
 * file itself — rather than on internals, because the failures being
 * guarded against are a private key reaching a CI log and a committed
 * artefact that misstates its own completeness (CLAUDE.md rule 15).
 *
 * That is deliberate, and also the limit. These prove the assertion this
 * code signs is well-formed and verifiable against the matching public
 * key, that a rejection is reported without echoing the credential, that
 * missing configuration fails loudly, and that the snapshot records its
 * window, its sources and its anonymised-impression gap correctly.
 *
 * They do NOT prove Google accepts the assertion, that the service account
 * has been granted anything, or that the real APIs return the response
 * shapes assumed here — only a live run proves that, and NO LIVE RUN HAS
 * BEEN MADE (CLAUDE.md rule 13). The response shapes below are taken from
 * Google's published API documentation, not from observed traffic.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "seo-report.mjs");

/* --- a credential that must never escape ------------------------------
   A real RSA key, so signing genuinely succeeds. The marker rides in the
   PEM body: if any code path ever echoes the key, this string turns up in
   stderr and the assertions below fail. */
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const SERVICE_ACCOUNT = "seo-report@testonly.iam.gserviceaccount.com";

/* Every run writes into a throwaway directory. Nothing in this file may
   write into docs/seo — see the SEO_OUT_DIR comment in the script. An
   earlier draft of these tests wrote real snapshot filenames into the
   repository and deleted them afterwards, which is the working-tree
   mutation CLAUDE.md forbids: a run interrupted between the write and the
   delete leaves a file that the weekly workflow's `git add docs/seo`
   would commit as though it were real search data. */
const OUT = mkdtempSync(join(tmpdir(), "seo-report-test-"));
process.on("exit", () => rmSync(OUT, { recursive: true, force: true }));

/* Runs the script to completion and hands back what an operator sees.
   Never rejects on a non-zero exit — the exit code is the assertion. */
function run(env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      {
        env: {
          PATH: process.env.PATH,
          SEO_OUT_DIR: OUT,
          /* Start from nothing, so a variable set on the developer's own
             machine cannot make a test pass that would fail in CI. */
          ...env,
        },
        timeout: 20000,
      },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }),
    );
  });
}

describe("configuration is refused loudly, never silently", () => {
  test("no credentials at all — exits non-zero and names both variables", async () => {
    const { code, stderr } = await run();
    assert.equal(code, 1);
    assert.match(stderr, /GOOGLE_SERVICE_ACCOUNT_EMAIL/);
    assert.match(stderr, /GOOGLE_SERVICE_ACCOUNT_KEY/);
  });

  test("credentials but nothing to query — exits non-zero rather than writing an empty snapshot", async () => {
    const { code, stderr } = await run({
      GOOGLE_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
      GOOGLE_SERVICE_ACCOUNT_KEY: privateKey,
    });
    assert.equal(code, 1);
    assert.match(stderr, /GSC_SITE_URL/);
    assert.match(stderr, /GA4_PROPERTY_ID/);
    /* The whole point of failing here: a snapshot carrying no sections
       would be indistinguishable from a week with no traffic. */
    assert.match(stderr, /nothing to fetch/i);
  });

  /* SEO_WINDOW_DAYS is a workflow_dispatch input, so it is operator-typed
     text arriving from outside. Rejected with a message that names the
     variable, rather than surfacing as a RangeError from toISOString three
     frames away. */
  for (const bad of ["abc", "0", "-7", "9999", "28.5"]) {
    test(`SEO_WINDOW_DAYS=${bad} is refused by name`, async () => {
      const { code, stderr } = await run({
        GOOGLE_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
        GOOGLE_SERVICE_ACCOUNT_KEY: privateKey,
        GSC_SITE_URL: "sc-domain:example.com",
        SEO_WINDOW_DAYS: bad,
      });
      assert.equal(code, 1);
      assert.match(stderr, /SEO_WINDOW_DAYS/);
      assert.ok(!/RangeError|Invalid Date/.test(stderr), "fails on the input, not on a date");
    });
  }
});

describe("the signed assertion", () => {
  /* A real HTTP server on loopback, standing where Google's token endpoint
     stands. It captures the assertion the script actually put on the wire. */
  async function withTokenServer(handler, fn) {
    const received = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push(Object.fromEntries(new URLSearchParams(body)));
        handler(res);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/token`;
    try {
      return { result: await fn(url), received };
    } finally {
      server.close();
      await once(server, "close");
    }
  }

  test("is a verifiable RS256 JWT carrying the right issuer, audience and scopes", async () => {
    const { received } = await withTokenServer(
      (res) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_scope" }));
      },
      (tokenUrl) =>
        run({
          GOOGLE_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
          GOOGLE_SERVICE_ACCOUNT_KEY: privateKey,
          GSC_SITE_URL: "sc-domain:example.com",
          GOOGLE_TOKEN_URL: tokenUrl,
        }),
    );

    assert.equal(received.length, 1, "the script made exactly one token request");
    const form = received[0];
    assert.equal(form.grant_type, "urn:ietf:params:oauth:grant-type:jwt-bearer");

    const [header, claims, signature] = form.assertion.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
      alg: "RS256",
      typ: "JWT",
    });

    /* The signature verifies against the public half — this is the part a
       mock could not establish. */
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    assert.ok(
      verifier.verify(publicKey, Buffer.from(signature, "base64url")),
      "assertion signature verifies against the service account's public key",
    );

    const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
    assert.equal(payload.iss, SERVICE_ACCOUNT);
    /* aud must be the endpoint Google expects, NOT the loopback override.
       Signing the test's own URL would make this test pass while every
       real run failed. */
    assert.equal(payload.aud, "https://oauth2.googleapis.com/token");
    assert.match(payload.scope, /webmasters\.readonly/);
    assert.match(payload.scope, /analytics\.readonly/);
    assert.ok(payload.exp > payload.iat, "the assertion expires after it was issued");
    assert.ok(payload.exp - payload.iat <= 3600, "and lives no longer than Google's one-hour ceiling");
  });

  test("a rejected token request reports the cause without echoing the key or the assertion", async () => {
    const { result, received } = await withTokenServer(
      (res) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." }));
      },
      (tokenUrl) =>
        run({
          GOOGLE_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
          GOOGLE_SERVICE_ACCOUNT_KEY: privateKey,
          GSC_SITE_URL: "sc-domain:example.com",
          GOOGLE_TOKEN_URL: tokenUrl,
        }),
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid_grant/);
    assert.match(result.stderr, /clock/i, "names the cause an operator can actually act on");

    const everythingPrinted = result.stdout + result.stderr;
    /* The key, in either of the two shapes it can be held in. */
    assert.ok(!everythingPrinted.includes(privateKey), "the PEM key is not printed");
    for (const line of privateKey.trim().split("\n").slice(1, -1)) {
      assert.ok(!everythingPrinted.includes(line), "no line of the key body is printed");
    }
    /* The assertion is itself a bearer credential for the account. */
    assert.ok(
      !everythingPrinted.includes(received[0].assertion),
      "the signed assertion is not printed",
    );
  });

  test("an unusable key fails on the signature without quoting it", async () => {
    const MARKER = "pem-body-TESTONLY-must-never-appear-anywhere";
    const { code, stdout, stderr } = await run({
      GOOGLE_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
      GOOGLE_SERVICE_ACCOUNT_KEY: `-----BEGIN PRIVATE KEY-----\n${MARKER}\n-----END PRIVATE KEY-----\n`,
      GSC_SITE_URL: "sc-domain:example.com",
    });

    assert.equal(code, 1);
    assert.match(stderr, /GOOGLE_SERVICE_ACCOUNT_KEY/);
    assert.ok(
      !(stdout + stderr).includes(MARKER),
      "an OpenSSL failure must not carry the key body into the log",
    );
  });

  test("escaped newlines in the key are accepted, as a CI secret delivers them", async () => {
    const { received } = await withTokenServer(
      (res) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_scope" }));
      },
      (tokenUrl) =>
        run({
          GOOGLE_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
          /* Exactly what a single-line secret store hands back. */
          GOOGLE_SERVICE_ACCOUNT_KEY: privateKey.replace(/\n/g, "\\n"),
          GSC_SITE_URL: "sc-domain:example.com",
          GOOGLE_TOKEN_URL: tokenUrl,
        }),
    );

    assert.equal(received.length, 1, "the escaped key still produced a signed assertion");
    const [header, claims, signature] = received[0].assertion.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    assert.ok(verifier.verify(publicKey, Buffer.from(signature, "base64url")));
  });
});

describe("the snapshot it writes", () => {
  /* Real servers for both Google hosts, so the artefact the weekly
     workflow commits is asserted from the file on disk rather than from
     the script's own idea of what it wrote (CLAUDE.md rule 15). */
  async function withGoogle(fn) {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const json = (payload) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (req.url.endsWith("/token")) return json({ access_token: "test-token", expires_in: 3599 });

        if (req.url.includes("searchAnalytics")) {
          const { dimensions } = JSON.parse(body);
          if (!dimensions) {
            /* 80 impressions in total ... */
            return json({ rows: [{ keys: [], clicks: 2, impressions: 80, ctr: 0.025, position: 18.4 }] });
          }
          if (dimensions[0] === "query") {
            /* ... of which Google will name only 15. The remaining 65 are
               the anonymised demand the snapshot has to account for. */
            return json({
              rows: [
                { keys: ["sellers agents toledo oh"], clicks: 0, impressions: 9, ctr: 0, position: 61.5 },
                { keys: ["crystal saylor"], clicks: 2, impressions: 6, ctr: 0.33, position: 8 },
              ],
            });
          }
          if (dimensions[0] === "page") {
            return json({
              rows: [{ keys: ["https://example.com/"], clicks: 2, impressions: 57, ctr: 0.035, position: 6.75 }],
            });
          }
          return json({ rows: [{ keys: ["2026-09-14"], clicks: 0, impressions: 13, ctr: 0, position: 48.6 }] });
        }

        const { dimensions } = JSON.parse(body);
        const row = (v, s, u, k) => ({
          dimensionValues: v.map((value) => ({ value })),
          metricValues: [s, u, k].map((value) => ({ value: String(value) })),
        });
        if (!dimensions?.length) return json({ rows: [row([], 68, 46, 1)] });
        if (dimensions[0].name === "sessionDefaultChannelGroup")
          return json({ rows: [row(["Direct"], 38, 30, 1), row(["Organic Search"], 3, 3, 0)] });
        return json({ rows: [row(["/"], 40, 35, 1)] });
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      return await fn(base);
    } finally {
      server.close();
      await once(server, "close");
    }
  }

  test("records the anonymised impressions the query table cannot show", async () => {
    const snapshot = await withGoogle(async (base) => {
      const { code, stdout } = await run({
        GOOGLE_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
        GOOGLE_SERVICE_ACCOUNT_KEY: privateKey,
        GSC_SITE_URL: "sc-domain:example.com",
        GA4_PROPERTY_ID: "123456",
        GOOGLE_TOKEN_URL: `${base}/token`,
        GOOGLE_API_BASE: base,
      });
      assert.equal(code, 0, stdout);

      const written = stdout.match(/([\d-]{10})\.json/);
      assert.ok(written, "the run names the file it wrote");
      const parsed = JSON.parse(readFileSync(join(OUT, `${written[1]}.json`), "utf8"));
      return { parsed, stdout };
    });

    const { searchConsole } = snapshot.parsed;
    assert.equal(searchConsole.totals.impressions, 80);
    /* 80 total, 15 attributable to a named query. If this arithmetic is
       wrong the snapshot understates how much demand is invisible, which
       is the single thing docs/seo/README.md promises it records. */
    assert.equal(searchConsole.anonymisedImpressions, 65);
    assert.match(snapshot.stdout, /65 of 80 impressions/);

    assert.equal(searchConsole.queries.length, 2);
    assert.equal(searchConsole.queries[0].query, "sellers agents toledo oh");
    assert.equal(searchConsole.queries[0].position, 61.5);
    assert.equal(snapshot.parsed.analytics.totals.sessions, 68);
    assert.equal(snapshot.parsed.analytics.channels[0].channel, "Direct");
  });

  test("states which sources it queried, so a skipped one cannot read as a zero", async () => {
    const parsed = await withGoogle(async (base) => {
      const { code, stdout } = await run({
        GOOGLE_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
        GOOGLE_SERVICE_ACCOUNT_KEY: privateKey,
        /* GA4 deliberately absent. */
        GSC_SITE_URL: "sc-domain:example.com",
        GOOGLE_TOKEN_URL: `${base}/token`,
        GOOGLE_API_BASE: base,
      });
      assert.equal(code, 0, stdout);
      const written = stdout.match(/([\d-]{10})\.json/);
      return JSON.parse(readFileSync(join(OUT, `${written[1]}.json`), "utf8"));
    });

    assert.equal(parsed.sources.searchConsole, "queried");
    assert.match(parsed.sources.analytics, /skipped/);
    assert.equal(parsed.analytics, undefined, "no empty analytics section is invented");
  });

  test("covers a settled window — never up to today", async () => {
    const parsed = await withGoogle(async (base) => {
      const { stdout } = await run({
        GOOGLE_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
        GOOGLE_SERVICE_ACCOUNT_KEY: privateKey,
        GSC_SITE_URL: "sc-domain:example.com",
        GOOGLE_TOKEN_URL: `${base}/token`,
        GOOGLE_API_BASE: base,
        SEO_WINDOW_DAYS: "7",
      });
      const written = stdout.match(/([\d-]{10})\.json/);
      return JSON.parse(readFileSync(join(OUT, `${written[1]}.json`), "utf8"));
    });

    const today = new Date().toISOString().slice(0, 10);
    assert.ok(parsed.range.end < today, "the window ends before today, because Search Console lags");
    const span = (Date.parse(parsed.range.end) - Date.parse(parsed.range.start)) / 864e5;
    assert.equal(span, 6, "a 7-day window spans 7 inclusive days");
    assert.equal(parsed.range.days, 7);
  });
});

describe("the token endpoint override cannot exfiltrate the assertion", () => {
  for (const hostile of [
    "https://oauth2.googleapis.com.evil.test/token",
    "http://169.254.169.254/token",
    "https://example.com/token",
  ]) {
    test(`refuses ${new URL(hostile).hostname}`, async () => {
      const { code, stderr } = await run({
        GOOGLE_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
        GOOGLE_SERVICE_ACCOUNT_KEY: privateKey,
        GSC_SITE_URL: "sc-domain:example.com",
        GOOGLE_TOKEN_URL: hostile,
      });
      assert.equal(code, 1);
      assert.match(stderr, /loopback/i);
    });
  }
});
