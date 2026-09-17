/* =====================================================================
   Search Console + GA4 snapshot. Run: npm run seo:report

   Why this exists
   ---------------
   Search performance was reaching this project as spreadsheets exported
   by hand from the Search Console and GA4 web UIs, carried into a chat
   session, and then lost when the session ended. Three problems with
   that, in increasing order of seriousness:

     1. Nobody can re-run it. The numbers are a claim about a moment,
        detached from the query that produced them.
     2. The export carries whatever date range the UI happened to have
        selected. One export read "Last 3 months" in its filter sheet and
        contained fifteen days, because that was all the data that
        existed - true, but only legible to someone who noticed.
     3. Search Console discards performance data after 16 months. An
        un-snapshotted month is gone permanently.

   This asks Google directly, on a date range it states, and writes a
   dated JSON snapshot the repository keeps. The snapshots outlive
   Google's retention window and make trend questions answerable later
   without trusting anyone's memory.

   NOT part of `npm test`, for the reason tools/verify-live.mjs gives:
   the release gate must not depend on a live third party, and CI has no
   credentials to offer it on a pull request from a fork.

   No new dependency
   -----------------
   Google's own client library is very large and this needs two POSTs and
   an OAuth2 assertion. The service-account JWT is signed here with
   node:crypto, which is ~20 lines and adds nothing to the lockfile.

   Credentials
   -----------
   Server-side only. Per CLAUDE.md rule 10 no variable here may ever be
   prefixed NEXT_PUBLIC_ - these are read in CI and on a workstation, and
   never by a browser.

     GOOGLE_SERVICE_ACCOUNT_EMAIL   ...iam.gserviceaccount.com
     GOOGLE_SERVICE_ACCOUNT_KEY     the PEM private key
     GSC_SITE_URL                   sc-domain:example.com, or the
                                    URL-prefix form https://example.com/
     GA4_PROPERTY_ID                numeric, no "properties/" prefix

   docs/seo/README.md carries the one-time Google console setup.
   ===================================================================== */
import { createSign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* SEO_OUT_DIR exists so tests never write into the working tree. CLAUDE.md
   forbids mutating it to prove a test, and here the stakes are higher than
   untidiness: .github/workflows/seo-report.yml commits whatever is under
   docs/seo, so a snapshot left behind by an interrupted test run would be
   committed as though it were real search data. The tests point this at a
   temporary directory instead. */
const OUT_DIR = process.env.SEO_OUT_DIR || join(ROOT, "docs", "seo");
const TIMEOUT_MS = 30000;
const ROW_LIMIT = 250;

/* The `aud` claim is what Google validates the assertion against, so it is
   ALWAYS this, never whatever endpoint the request is posted to. Signing
   the override below would leave the test exercising an assertion shaped
   differently from the one production sends - a green test proving the
   wrong thing. That is not hypothetical: this constant exists because the
   first version of that test caught exactly it. */
const TOKEN_AUDIENCE = "https://oauth2.googleapis.com/token";

/* GOOGLE_TOKEN_URL and GOOGLE_API_BASE are overridable ONLY to a loopback
   address, and only so that tests/seo-report.test.mjs can stand real
   node:http servers in for Google and verify the signed assertion against
   a real public key, and the written snapshot against real responses.
   Mocks cannot carry those claims (CLAUDE.md rule 14).

   The loopback restriction is what makes the overrides safe to ship: the
   assertion and the access token are both bearer credentials for this
   service account, and without the check these variables would be an
   exfiltration route. It is not a meaningful escalation either way -
   anyone who can set them can already read GOOGLE_SERVICE_ACCOUNT_KEY -
   but a credential must not leave the machine because an environment
   variable said so. */
function loopbackOnly(value, name) {
  const { hostname } = new URL(value);
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
    console.error(
      `✗ ${name} may only point at a loopback address (got ${hostname}).\n` +
        `  It exists for tests. An access token is a credential and must not be sent elsewhere.`,
    );
    process.exit(1);
  }
  return value;
}

const TOKEN_URL = process.env.GOOGLE_TOKEN_URL
  ? loopbackOnly(process.env.GOOGLE_TOKEN_URL, "GOOGLE_TOKEN_URL")
  : TOKEN_AUDIENCE;

/* Same restriction, same reason: tests/seo-report.test.mjs stands a real
   server in for both API hosts so the snapshot this script writes can be
   asserted end to end. Distinguished by path, since the two live on
   different Google hostnames. */
const API_BASE = process.env.GOOGLE_API_BASE
  ? loopbackOnly(process.env.GOOGLE_API_BASE, "GOOGLE_API_BASE").replace(/\/$/, "")
  : null;

const GSC_BASE = API_BASE || "https://searchconsole.googleapis.com";
const GA4_BASE = API_BASE || "https://analyticsdata.googleapis.com";

const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
].join(" ");

/* --- date window ------------------------------------------------------
   Search Console finalises a day's data roughly two to three days after
   it ends. Asking for "up to today" therefore returns a tail of numbers
   that are real but incomplete, which read as a decline. End the window
   three days back so every day in a snapshot is settled, and state the
   window in the output rather than leaving the reader to infer it. */
const LAG_DAYS = 3;

/* Reached from a workflow_dispatch input, so it is operator-supplied text.
   Number("") is 0 and Number("abc") is NaN, either of which would produce
   an Invalid Date and fail three frames later inside toISOString with a
   RangeError that says nothing about the cause. */
const WINDOW_DAYS = (() => {
  const raw = process.env.SEO_WINDOW_DAYS;
  if (raw === undefined || raw === "") return 28;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 480) {
    console.error(
      `✗ SEO_WINDOW_DAYS must be a whole number of days from 1 to 480 (got ${JSON.stringify(raw)}).\n` +
        `  Search Console holds about 16 months, so nothing beyond 480 can return data.`,
    );
    process.exit(1);
  }
  return n;
})();

const iso = (d) => d.toISOString().slice(0, 10);
const endDate = new Date(Date.now() - LAG_DAYS * 864e5);
const startDate = new Date(endDate.getTime() - (WINDOW_DAYS - 1) * 864e5);
const RANGE = { start: iso(startDate), end: iso(endDate), days: WINDOW_DAYS };

/* --- configuration ---------------------------------------------------- */
const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
const gscSite = process.env.GSC_SITE_URL;
const ga4Property = process.env.GA4_PROPERTY_ID;

const missing = [];
if (!email) missing.push("GOOGLE_SERVICE_ACCOUNT_EMAIL");
if (!rawKey) missing.push("GOOGLE_SERVICE_ACCOUNT_KEY");
if (missing.length) {
  console.error(
    `✗ missing credentials: ${missing.join(", ")}\n` +
      `  docs/seo/README.md has the one-time Google console setup.`,
  );
  process.exit(1);
}
if (!gscSite && !ga4Property) {
  console.error(
    "✗ neither GSC_SITE_URL nor GA4_PROPERTY_ID is set — there is nothing to fetch.\n" +
      "  docs/seo/README.md has the one-time Google console setup.",
  );
  process.exit(1);
}

/* A key pasted into a CI secret or a .env line arrives with its newlines
   escaped. A key read from a mounted file arrives with real ones. Accept
   both rather than failing at the signature with an opaque OpenSSL
   error. */
const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;

/* --- OAuth2, via a signed service-account assertion -------------------- */
const b64url = (input) => Buffer.from(input).toString("base64url");

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: email,
      scope: SCOPES,
      aud: TOKEN_AUDIENCE,
      iat: now,
      exp: now + 3600,
    }),
  );

  const signingInput = `${header}.${claims}`;
  let signature;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signature = signer.sign(privateKey).toString("base64url");
  } catch (e) {
    /* Deliberately reports only the failure class. The key itself must
       never reach a log, and an OpenSSL error can quote its input. */
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_KEY could not sign the assertion (${e.code || e.name}). ` +
        `Expected a PEM private key beginning "-----BEGIN PRIVATE KEY-----".`,
    );
  }

  const res = await post(TOKEN_URL, new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${signingInput}.${signature}`,
  }), { "content-type": "application/x-www-form-urlencoded" });

  if (!res.ok) {
    /* Google returns {error, error_description} here, and the two cases
       that actually happen are worth naming rather than dumping JSON:
       a clock skew, and a service account that exists but was never
       granted anything. */
    const hint =
      res.body?.error === "invalid_grant"
        ? " — the assertion was rejected. Usually a bad key, the wrong service-account email, or a system clock more than 5 minutes off."
        : "";
    throw new Error(`token request failed (${res.status} ${res.body?.error || ""})${hint}`);
  }
  return res.body.access_token;
}

/* --- HTTP -------------------------------------------------------------
   Errors from here are printed. They must never carry the Authorization
   header or the assertion, so nothing in this helper echoes its own
   request. */
async function post(url, body, headers) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: body instanceof URLSearchParams ? body : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* A non-JSON body is a proxy or an outage page. Keep a bounded
         excerpt for the operator; do not let an HTML error page become
         the whole console output. */
      parsed = { error: text.slice(0, 200) };
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (e) {
    const why = e.name === "AbortError" ? `no response in ${TIMEOUT_MS / 1000}s` : e.message;
    throw new Error(`${new URL(url).host} could not be reached (${why})`);
  } finally {
    clearTimeout(timer);
  }
}

const authed = (token) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

/* --- Search Console ---------------------------------------------------- */
async function searchConsole(token) {
  /* siteUrl sits in the path and both of its legal forms need encoding:
     "sc-domain:example.com" for a Domain property, and the full origin
     for a URL-prefix one. */
  const endpoint =
    `${GSC_BASE}/webmasters/v3/sites/` +
    `${encodeURIComponent(gscSite)}/searchAnalytics/query`;

  const query = async (dimensions) => {
    const res = await post(
      endpoint,
      {
        startDate: RANGE.start,
        endDate: RANGE.end,
        dimensions,
        rowLimit: ROW_LIMIT,
        type: "web",
      },
      authed(token),
    );
    if (!res.ok) {
      const hint =
        res.status === 403
          ? ` — the service account is not a user on ${gscSite}. Add it in Search Console → Settings → Users and permissions.`
          : res.status === 404
            ? ` — no Search Console property matches ${gscSite}. A Domain property must be written "sc-domain:example.com".`
            : "";
      throw new Error(
        `Search Console rejected the ${dimensions?.join("+") || "totals"} query ` +
          `(${res.status} ${res.body?.error?.message || ""})${hint}`,
      );
    }
    return res.body.rows || [];
  };

  const shape = (row, key) => ({
    [key]: row.keys[0],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  });

  const [totals, queries, pages, dates] = await Promise.all([
    query(undefined),
    query(["query"]),
    query(["page"]),
    query(["date"]),
  ]);

  const t = totals[0];
  return {
    site: gscSite,
    totals: t
      ? { clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position }
      : { clicks: 0, impressions: 0, ctr: 0, position: null },
    /* Search Console withholds queries issued by too few people, so these
       rows routinely sum to less than `totals`. The gap is anonymised
       demand, not a bug and not a number that can be recovered - record
       it so a later reader does not treat the query table as complete. */
    queries: queries.map((r) => shape(r, "query")),
    pages: pages.map((r) => shape(r, "page")),
    daily: dates.map((r) => shape(r, "date")),
    anonymisedImpressions: t
      ? t.impressions - queries.reduce((n, r) => n + r.impressions, 0)
      : 0,
  };
}

/* --- GA4 --------------------------------------------------------------- */
async function analytics(token) {
  const endpoint =
    `${GA4_BASE}/v1beta/properties/${encodeURIComponent(ga4Property)}:runReport`;

  const report = async (dimensions, metrics) => {
    const res = await post(
      endpoint,
      {
        dateRanges: [{ startDate: RANGE.start, endDate: RANGE.end }],
        dimensions: dimensions.map((name) => ({ name })),
        metrics: metrics.map((name) => ({ name })),
        limit: ROW_LIMIT,
      },
      authed(token),
    );
    if (!res.ok) {
      const hint =
        res.status === 403
          ? ` — the service account has no access to property ${ga4Property}. Add it as a Viewer in GA4 → Admin → Property access management.`
          : "";
      throw new Error(
        `GA4 rejected the ${dimensions.join("+") || "totals"} report ` +
          `(${res.status} ${res.body?.error?.message || ""})${hint}`,
      );
    }
    return res.body;
  };

  const rows = (r, dimension) =>
    (r.rows || []).map((row) => ({
      [dimension]: row.dimensionValues[0].value,
      sessions: Number(row.metricValues[0].value),
      users: Number(row.metricValues[1].value),
      keyEvents: Number(row.metricValues[2].value),
    }));

  const METRICS = ["sessions", "totalUsers", "keyEvents"];
  const [totals, channels, landing] = await Promise.all([
    report([], METRICS),
    report(["sessionDefaultChannelGroup"], METRICS),
    report(["landingPagePlusQueryString"], METRICS),
  ]);

  const t = totals.rows?.[0]?.metricValues;
  return {
    property: ga4Property,
    totals: {
      sessions: Number(t?.[0].value || 0),
      users: Number(t?.[1].value || 0),
      keyEvents: Number(t?.[2].value || 0),
    },
    channels: rows(channels, "channel"),
    landingPages: rows(landing, "page"),
  };
}

/* --- run --------------------------------------------------------------- */
const snapshot = {
  generated: new Date().toISOString(),
  range: RANGE,
  /* Which sources were actually queried, recorded in the artefact itself.
     A snapshot missing a section because a variable was unset must not
     look like a snapshot whose numbers were genuinely zero. */
  sources: {
    searchConsole: gscSite ? "queried" : "skipped — GSC_SITE_URL unset",
    analytics: ga4Property ? "queried" : "skipped — GA4_PROPERTY_ID unset",
  },
};

try {
  const token = await accessToken();
  if (gscSite) snapshot.searchConsole = await searchConsole(token);
  if (ga4Property) snapshot.analytics = await analytics(token);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, `${RANGE.end}.json`);
writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n");

/* --- human summary ----------------------------------------------------- */
const pct = (n) => (n == null ? "—" : (n * 100).toFixed(2) + "%");
const pos = (n) => (n == null ? "—" : n.toFixed(1));

console.log(`\nSearch performance, ${RANGE.start} to ${RANGE.end} (${RANGE.days} days)\n`);

if (snapshot.searchConsole) {
  const { totals, queries, anonymisedImpressions } = snapshot.searchConsole;
  console.log(
    `  Search Console  ${totals.clicks} clicks, ${totals.impressions} impressions, ` +
      `CTR ${pct(totals.ctr)}, avg position ${pos(totals.position)}`,
  );
  if (queries.length) {
    console.log(`\n  Top queries`);
    for (const q of queries.slice(0, 15)) {
      console.log(
        `    ${String(q.impressions).padStart(5)} impr  pos ${pos(q.position).padStart(5)}  ` +
          `${q.clicks} clicks  ${q.query}`,
      );
    }
  } else {
    console.log(`  No query rows — Google has withheld every query in this window.`);
  }
  if (anonymisedImpressions > 0) {
    console.log(
      `\n  ${anonymisedImpressions} of ${totals.impressions} impressions came from queries ` +
        `Google withholds for privacy. They are not recoverable by any tool.`,
    );
  }
} else {
  console.log(`  Search Console  ${snapshot.sources.searchConsole}`);
}

if (snapshot.analytics) {
  const { totals, channels } = snapshot.analytics;
  console.log(
    `\n  GA4             ${totals.sessions} sessions, ${totals.users} users, ` +
      `${totals.keyEvents} key events`,
  );
  if (channels.length) {
    console.log(`\n  Sessions by channel`);
    for (const c of channels.slice(0, 10)) {
      console.log(`    ${String(c.sessions).padStart(5)}  ${c.keyEvents} key events  ${c.channel}`);
    }
  }
} else {
  console.log(`\n  GA4             ${snapshot.sources.analytics}`);
}

console.log(`\n✓ snapshot written to docs/seo/${RANGE.end}.json\n`);
