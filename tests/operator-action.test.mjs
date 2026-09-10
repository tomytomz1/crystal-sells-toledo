/* Gate 7 — operator surfacing, and the operator's suppression entry.
 *
 * Tier 4: compliance and data loss. Two failure directions, both bad and
 * neither visible from a log line:
 *
 *   * an unrecognised opt-out reaches nobody and is enforced by nobody —
 *     which is what a SILENT 200 on the unclassified branch produces; or
 *   * a link scanner, a prefetch or a stray GET records a PERMANENT,
 *     un-undoable suppression against a number with no human involved.
 *
 * NOTHING HERE REACHES A DATABASE, AN SMTP SERVER, TWILIO OR HUBSPOT. The
 * ledger's executor seam is injected, the mail transport factory is
 * replaced, `globalThis.fetch` is stubbed, and no real credential is read.
 *
 * The invariants worth the most, in order:
 *   1. a GET writes nothing, ever, whoever or whatever sent it
 *   2. a POST without an explicit scope and an explicit confirmation
 *      writes nothing
 *   3. the row is `revoked` / `manual` / `operator` and carries the
 *      consumer's EXACT words
 *   4. `unsuppressed` is unreachable — nothing here can clear anything
 *   5. a ledger failure is never reported as success; a HubSpot failure
 *      never weakens a ledger success
 *   6. the number, the words, the note and the token never reach a log,
 *      and never appear in plaintext in a URL
 */

import { test, describe, before, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import operatorHandler, { CONFIRM_LITERAL } from "../api/operator-action.js";
import inboundHandler from "../api/twilio-inbound.js";
import {
  sealOperatorToken, unsealOperatorToken, operatorActionUrl, operatorActionConfigured,
  OperatorTokenError, OPERATOR_SECRET_VAR, TOKEN_EXPIRED, TOKEN_INVALID,
  TOKEN_MALFORMED, TOKEN_MISSING, TOKEN_TOO_LARGE, OPERATOR_NOT_CONFIGURED,
  MAX_TOKEN_CHARS, MAX_ACTION_URL_BYTES, TOKEN_TTL_MS, ACTION_PATH,
  MIN_SECRET_BYTES,
} from "../api/_lib/operator-token.mjs";
import {
  capEvidence, EVIDENCE_TEXT_MAX_BYTES, SOURCE_OPERATOR, SUPPRESSION_COLUMNS,
  LEDGER_URL_VAR, EVENT_TYPE, CHANNEL, _setExecutor, _resetExecutor,
} from "../api/_lib/consent-ledger.mjs";
import {
  buildInboundNotification, lastFour, setTransportFactory, sendInboundNotification,
  NOTIFICATION_SUBJECT_PREFIX, NOTIFICATION_DEADLINE_MS, NOTIFICATION_TIMED_OUT,
} from "../api/_lib/mail.mjs";
import { SUPPRESSION_REASON, FEATURE_FLAG } from "../api/_lib/consent.mjs";
import { TWILIO_TOKEN_VAR } from "../api/_lib/twilio.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const SECRET = "test_operator_secret_not_a_real_credential";
/* A SECOND secret, also over the entropy floor, used to prove that a
   token sealed with one key is refused by another. */
const OTHER_SECRET = "a_completely_different_test_secret_not_a_credential";
const LEDGER_URL = "postgres://app:secret@ledger.example/neondb";
const PHONE = "+14195550123";
const SID = "SM0123456789abcdef0123456789abcdef";
const WORDS = "quit hassling me, I never signed up for this";

/* =====================================================================
   HARNESS
   ===================================================================== */

/** Capture every statement the ledger would send, and never send one. */
function captureLedger({ fail = null } = {}) {
  const calls = [];
  _setExecutor(async (text, params, opts) => {
    calls.push({ text, params, opts });
    if (fail) throw fail;
    /* The real driver answers [] for an INSERT ... DO NOTHING that
       inserted nothing, and for one that inserted. The application cannot
       tell them apart and must not try — SELECT is a privilege this role
       deliberately does not hold. */
    return [];
  });
  return calls;
}

/** The value written into one column of the first captured row. */
function column(calls, name, row = 0) {
  const idx = SUPPRESSION_COLUMNS.indexOf(name);
  assert.notEqual(idx, -1, `unknown column ${name}`);
  return calls[0].params[row * SUPPRESSION_COLUMNS.length + idx];
}

function mockRes() {
  const res = {
    statusCode: 0, headers: {}, body: "", ended: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(payload) { this.body = payload == null ? "" : String(payload); this.ended = true; },
  };
  return res;
}

function formReq({ method = "POST", fields = {}, url = ACTION_PATH, raw = null } = {}) {
  const body = raw != null ? raw : new URLSearchParams(fields).toString();
  return {
    method,
    url,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(Buffer.byteLength(body)),
    },
    body,
    on() {}, destroy() {},
  };
}

async function callOperator(req) {
  const res = mockRes();
  await operatorHandler(req, res);
  return res;
}

/** Every console.log line one call emitted, parsed. */
async function capturingLogs(fn) {
  const real = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  try { return { result: await fn(), lines, text: lines.join("\n") }; }
  finally { console.log = real; }
}

/* Environment is set per-file rather than per-test: every test in here
   needs the secret, and the ones that need it ABSENT say so explicitly. */
const SAVED = {};
const ENV_KEYS = [OPERATOR_SECRET_VAR, LEDGER_URL_VAR, FEATURE_FLAG, TWILIO_TOKEN_VAR,
                  "HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PORTAL_ID", "HUBSPOT_FORM_GUID",
                  "ZOHO_SMTP_HOST", "ZOHO_SMTP_PORT", "ZOHO_SMTP_USER", "ZOHO_SMTP_PASSWORD"];
const realFetch = globalThis.fetch;

function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

before(() => { for (const k of ENV_KEYS) SAVED[k] = process.env[k]; });
after(() => {
  for (const k of ENV_KEYS) setEnv({ [k]: SAVED[k] });
  globalThis.fetch = realFetch;
  _resetExecutor();
  setTransportFactory(null);
});

beforeEach(() => {
  for (const k of ENV_KEYS) setEnv({ [k]: undefined });
  setEnv({ [OPERATOR_SECRET_VAR]: SECRET, [LEDGER_URL_VAR]: LEDGER_URL });
  /* Any real network call from these tests is a bug in the test, not a
     slow test: fail loudly rather than reaching HubSpot. */
  globalThis.fetch = async () => { throw new Error("NETWORK_NOT_ALLOWED_IN_TESTS"); };
});

afterEach(() => {
  _resetExecutor();
  setTransportFactory(null);
  globalThis.fetch = realFetch;
});

/** assert.throws() returns nothing, so the error is captured by hand. */
function tokenError(fn) {
  try { fn(); } catch (err) {
    assert.ok(err instanceof OperatorTokenError,
      `expected an OperatorTokenError, got ${err && err.name}`);
    return err;
  }
  assert.fail("expected a refusal, got a value");
}

/** A sealed token for the standard message. */
const tokenFor = (over = {}) =>
  sealOperatorToken({ sid: SID, phone: PHONE, body: WORDS, ...over });

/** A complete, valid POST. */
const validPost = (over = {}) => formReq({
  fields: { t: tokenFor(), scope: "sms", confirm: CONFIRM_LITERAL, ...over },
});

/* =====================================================================
   1  THE SEAL — what the URL may carry
   ===================================================================== */
describe("the sealed token", () => {
  test("a sealed token round-trips exactly", () => {
    const opened = unsealOperatorToken(tokenFor());
    assert.equal(opened.sid, SID);
    assert.equal(opened.phone, PHONE);
    assert.equal(opened.body, WORDS);
    assert.equal(opened.v, 1);
  });

  test("two seals of the same message differ — the nonce is fresh", () => {
    assert.notEqual(tokenFor(), tokenFor(),
      "a repeated ciphertext leaks that two notifications carry the same message");
  });

  /* THE REASON THE TOKEN IS SEALED RATHER THAN SIGNED. A URL is a log
     line: Vercel records paths, the browser records history. */
  test("the token and its URL carry no plaintext number and no plaintext words", () => {
    const url = operatorActionUrl(tokenFor());
    for (const secret of [PHONE, PHONE.slice(1), "4195550123", WORDS,
                          "quit hassling", "hassling", SID]) {
      assert.ok(!url.includes(secret),
        `the operator action URL contains ${JSON.stringify(secret)} in plaintext`);
    }
    /* And nothing that merely looks like a North American number. */
    assert.ok(!/\+?1?\d{10}/.test(decodeURIComponent(url.split("?t=")[1])),
      "the token decodes to something shaped like a phone number");
  });

  test("a tampered ciphertext is refused, and says nothing about why", () => {
    const t = tokenFor();
    /* Flip one character in the ciphertext body, past the version byte,
       the nonce and the tag. */
    const i = t.length - 5;
    const flipped = t.slice(0, i) + (t[i] === "A" ? "B" : "A") + t.slice(i + 1);
    assert.notEqual(flipped, t);
    assert.equal(tokenError(() => unsealOperatorToken(flipped)).token, TOKEN_INVALID);
  });

  test("a token sealed with a different secret is refused", () => {
    const other = sealOperatorToken({ sid: SID, phone: PHONE, body: WORDS },
      { env: { [OPERATOR_SECRET_VAR]: OTHER_SECRET } });
    assert.equal(tokenError(() => unsealOperatorToken(other)).token, TOKEN_INVALID);
  });

  test("a truncated token is refused", () => {
    const err = tokenError(() => unsealOperatorToken(tokenFor().slice(0, 12)));
    assert.ok([TOKEN_MALFORMED, TOKEN_INVALID].includes(err.token));
  });

  test("a token outside the base64url alphabet is refused before any cipher runs", () => {
    assert.equal(tokenError(() => unsealOperatorToken("not a token!!")).token, TOKEN_MALFORMED);
  });

  test("an empty token is refused", () => {
    assert.equal(tokenError(() => unsealOperatorToken("")).token, TOKEN_MISSING);
  });

  test("an oversized token is refused on length alone", () => {
    const huge = "A".repeat(MAX_TOKEN_CHARS + 1);
    assert.equal(tokenError(() => unsealOperatorToken(huge)).token, TOKEN_TOO_LARGE);
  });

  test("an expired token is refused, distinguishably from a forged one", () => {
    const t = tokenFor();
    assert.equal(
      tokenError(() => unsealOperatorToken(t, { now: Date.now() + TOKEN_TTL_MS + 1000 })).token,
      TOKEN_EXPIRED);
  });

  test("a token one second inside its expiry still opens", () => {
    const t = tokenFor();
    assert.equal(unsealOperatorToken(t, { now: Date.now() + TOKEN_TTL_MS - 1000 }).sid, SID);
  });

  test("with no secret, nothing can be sealed or unsealed", () => {
    setEnv({ [OPERATOR_SECRET_VAR]: undefined });
    assert.equal(operatorActionConfigured(), false);
    assert.equal(tokenError(() => tokenFor()).token, OPERATOR_NOT_CONFIGURED);
  });

  /* THE KEY MINTS BEARER CAPABILITIES, and HKDF cannot make a guessable
     input unguessable — it stretches, it does not add entropy. A short
     secret must read exactly like an absent one. */
  describe("the secret's entropy floor", () => {
    test("an empty secret is not configured", () => {
      for (const value of ["", "   ", undefined]) {
        setEnv({ [OPERATOR_SECRET_VAR]: value });
        assert.equal(operatorActionConfigured(), false, `accepted ${JSON.stringify(value)}`);
      }
    });

    test("a short secret is not configured, and cannot seal or unseal", () => {
      const short = "a".repeat(MIN_SECRET_BYTES - 1);
      setEnv({ [OPERATOR_SECRET_VAR]: short });
      assert.equal(operatorActionConfigured(), false, "a short secret passed the gate");
      assert.equal(tokenError(() => tokenFor()).token, OPERATOR_NOT_CONFIGURED);
      assert.equal(tokenError(() => unsealOperatorToken("AAAA")).token, OPERATOR_NOT_CONFIGURED);
    });

    test("`hunter2` is refused, however well-formed the derived key would be", () => {
      setEnv({ [OPERATOR_SECRET_VAR]: "hunter2" });
      assert.equal(operatorActionConfigured(), false);
    });

    test("whitespace does not pad a short secret over the floor", () => {
      setEnv({ [OPERATOR_SECRET_VAR]: "  " + "a".repeat(MIN_SECRET_BYTES - 1) + "  " });
      assert.equal(operatorActionConfigured(), false, "trimmed whitespace counted toward the floor");
    });

    test("exactly the floor is enough, and round-trips", () => {
      const exact = "b".repeat(MIN_SECRET_BYTES);
      assert.equal(Buffer.byteLength(exact, "utf8"), MIN_SECRET_BYTES);
      setEnv({ [OPERATOR_SECRET_VAR]: exact });
      assert.equal(operatorActionConfigured(), true);
      assert.equal(unsealOperatorToken(tokenFor()).sid, SID);
    });

    test("the floor is on BYTES, not characters", () => {
      /* Ten four-byte characters are 10 characters and 40 bytes. A
         character count would be the wrong measure of a search space. */
      const multi = "🙃".repeat(10);
      assert.equal(multi.length < MIN_SECRET_BYTES, true);
      assert.equal(Buffer.byteLength(multi, "utf8") >= MIN_SECRET_BYTES, true);
      setEnv({ [OPERATOR_SECRET_VAR]: multi });
      assert.equal(operatorActionConfigured(), true);
    });

    test("the existing test credential is over the floor and still works", () => {
      assert.ok(Buffer.byteLength(SECRET, "utf8") >= MIN_SECRET_BYTES);
      assert.ok(Buffer.byteLength(OTHER_SECRET, "utf8") >= MIN_SECRET_BYTES);
      assert.equal(operatorActionConfigured(), true);
      assert.equal(unsealOperatorToken(tokenFor()).body, WORDS);
    });

    /* One rule, three callers: the gate, sealing and unsealing must not be
       able to disagree about what "configured" means. */
    test("the gate and the cipher agree on every value", () => {
      for (const value of ["", "short", "a".repeat(MIN_SECRET_BYTES - 1),
                           "a".repeat(MIN_SECRET_BYTES), SECRET]) {
        setEnv({ [OPERATOR_SECRET_VAR]: value });
        const gate = operatorActionConfigured();
        let sealed = true;
        try { tokenFor(); } catch { sealed = false; }
        assert.equal(gate, sealed,
          `the gate says ${gate} and sealing says ${sealed} for the same value`);
      }
    });

    test("a refusal names the variable and never the value or its length", () => {
      setEnv({ [OPERATOR_SECRET_VAR]: "a".repeat(MIN_SECRET_BYTES - 1) });
      const err = tokenError(() => tokenFor());
      assert.equal(err.detail, OPERATOR_SECRET_VAR);
      assert.ok(!/\d/.test(err.message), "the refusal carries a number - a length is a search space");
      assert.ok(!err.message.includes("aaa"));
    });
  });

  /* THE SIZE BOUND, MEASURED RATHER THAN ARITHMETIC. The design document
     estimated ~1.6 KB and said to measure the worst case; this is that
     measurement, and it fails if a field is ever added that breaks it. */
  test("the worst-case URL — a full-length multi-byte message — is inside the hard bound", () => {
    /* Four bytes per character, so the byte cap bites at a quarter of the
       characters, which is the largest plaintext capEvidence() can pass
       through. */
    const capped = capEvidence("🙃".repeat(EVIDENCE_TEXT_MAX_BYTES));
    assert.ok(Buffer.byteLength(capped, "utf8") <= EVIDENCE_TEXT_MAX_BYTES);
    const url = operatorActionUrl(sealOperatorToken({ sid: SID, phone: PHONE, body: capped }));
    const bytes = Buffer.byteLength(url, "utf8");
    assert.ok(bytes <= MAX_ACTION_URL_BYTES,
      `worst-case action URL is ${bytes} bytes, over the ${MAX_ACTION_URL_BYTES} bound`);
    /* And it survives the round trip byte-for-byte. */
    assert.equal(unsealOperatorToken(url.split("?t=")[1] && decodeURIComponent(url.split("?t=")[1])).body,
      capped);
  });

  test("a MessageSid carrying a colon is refused at seal time, not at dedupe time", () => {
    assert.equal(tokenError(() => tokenFor({ sid: "SM:1" })).token, TOKEN_MALFORMED);
  });
});

/* =====================================================================
   2  GET — reads no database state, writes nothing, records nothing
   ===================================================================== */
describe("GET /api/operator-action", () => {
  test("renders the confirmation page and writes nothing", async () => {
    const calls = captureLedger();
    const res = await callOperator({ method: "GET", url: `${ACTION_PATH}?t=${tokenFor()}`, headers: {} });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 0, "the GET touched the ledger");
    assert.match(res.body, /Record an opt-out/);
    /* It must show the words, because the operator cannot judge a message
       she cannot see. */
    assert.ok(res.body.includes("quit hassling me"));
    assert.ok(res.body.includes(PHONE));
  });

  /* THE INVARIANT THIS ENDPOINT EXISTS FOR. Outlook Safe Links, Gmail
     prefetch, mail-gateway antivirus and iOS previews all issue these. */
  test("a scanner-like GET — repeated, unattended, HEAD-ish — writes nothing", async () => {
    const calls = captureLedger();
    const t = tokenFor();
    for (const headers of [
      { "user-agent": "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1) SkypeUriPreview" },
      { "user-agent": "Microsoft Office Existence Discovery" },
      { "user-agent": "Google-Safety" },
      {},
    ]) {
      const res = await callOperator({ method: "GET", url: `${ACTION_PATH}?t=${t}`, headers });
      assert.equal(res.statusCode, 200);
    }
    assert.equal(calls.length, 0,
      "an unattended GET reached the ledger - a link scanner would suppress a number by itself");
  });

  test("the page sets no-store, no-referrer and noindex", async () => {
    const res = await callOperator({ method: "GET", url: `${ACTION_PATH}?t=${tokenFor()}`, headers: {} });
    assert.match(res.headers["cache-control"], /no-store/);
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.match(res.headers["x-robots-tag"], /noindex/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.match(res.headers["content-security-policy"], /default-src 'none'/);
  });

  test("the page loads no third-party resource", async () => {
    const res = await callOperator({ method: "GET", url: `${ACTION_PATH}?t=${tokenFor()}`, headers: {} });
    assert.ok(!/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//.test(res.body),
      "the confirmation page references an off-site resource");
    assert.ok(!/<script/i.test(res.body), "the confirmation page carries script");
  });

  test("the form offers three scopes and pre-selects none", async () => {
    const res = await callOperator({ method: "GET", url: `${ACTION_PATH}?t=${tokenFor()}`, headers: {} });
    for (const v of ["sms", "ai_voice", "all"])
      assert.ok(res.body.includes(`value="${v}"`), `the page does not offer scope ${v}`);
    assert.ok(!/checked/i.test(res.body), "a scope is pre-selected - the human's judgement is being made for her");
    assert.match(res.body, /method="POST"/);
  });

  test("an expired token renders a page that says so, and writes nothing", async () => {
    const calls = captureLedger();
    /* Sealed with a TTL already in the past. */
    const stale = sealOperatorToken({ sid: SID, phone: PHONE, body: WORDS }, { ttlMs: -1000 });
    const res = await callOperator({ method: "GET", url: `${ACTION_PATH}?t=${stale}`, headers: {} });
    assert.equal(res.statusCode, 410);
    assert.match(res.body, /expired/i);
    assert.equal(calls.length, 0);
  });

  test("a malformed token renders a refusal, and writes nothing", async () => {
    const calls = captureLedger();
    const res = await callOperator({ method: "GET", url: `${ACTION_PATH}?t=%%%`, headers: {} });
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  test("with the secret absent the endpoint is inert — 503, no page", async () => {
    setEnv({ [OPERATOR_SECRET_VAR]: undefined });
    const calls = captureLedger();
    const res = await callOperator({ method: "GET", url: `${ACTION_PATH}?t=anything`, headers: {} });
    assert.equal(res.statusCode, 503);
    assert.equal(calls.length, 0);
  });

  for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
    test(`rejects ${method}`, async () => {
      const calls = captureLedger();
      const res = await callOperator({ method, url: ACTION_PATH, headers: {} });
      assert.equal(res.statusCode, 405);
      assert.equal(calls.length, 0);
    });
  }
});

/* =====================================================================
   3  POST — the only writer, and only with all three
   ===================================================================== */
describe("POST /api/operator-action — what it refuses", () => {
  test("no scope: 400, and nothing is written", async () => {
    const calls = captureLedger();
    const res = await callOperator(formReq({
      fields: { t: tokenFor(), confirm: CONFIRM_LITERAL },
    }));
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0, "a POST with no scope reached the ledger");
    assert.match(res.body, /Not recorded/);
  });

  test("an unknown scope is not silently narrowed or widened", async () => {
    const calls = captureLedger();
    const res = await callOperator(validPost({ scope: "everything" }));
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  test("no confirmation: 400, and nothing is written", async () => {
    const calls = captureLedger();
    const res = await callOperator(formReq({ fields: { t: tokenFor(), scope: "sms" } }));
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  test("a wrong confirmation literal: 400, and nothing is written", async () => {
    const calls = captureLedger();
    const res = await callOperator(validPost({ confirm: "yes" }));
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  test("no token: 400, and nothing is written", async () => {
    const calls = captureLedger();
    const res = await callOperator(formReq({ fields: { scope: "sms", confirm: CONFIRM_LITERAL } }));
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  /* THE TOKEN IS A LIVE CAPABILITY. In a query string it lands in
     Vercel's request log and in every proxy on the way. */
  test("a token in the POST query string is refused outright", async () => {
    const calls = captureLedger();
    const t = tokenFor();
    const req = formReq({
      fields: { t, scope: "sms", confirm: CONFIRM_LITERAL },
      url: `${ACTION_PATH}?t=${t}`,
    });
    const res = await callOperator(req);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0, "a token in the URL was accepted as a write");
  });

  test("an expired token on a POST writes nothing", async () => {
    const calls = captureLedger();
    const stale = sealOperatorToken({ sid: SID, phone: PHONE, body: WORDS }, { ttlMs: -1000 });
    const res = await callOperator(validPost({ t: stale }));
    assert.equal(res.statusCode, 410);
    assert.equal(calls.length, 0);
  });

  test("a tampered token on a POST writes nothing", async () => {
    const calls = captureLedger();
    const t = tokenFor();
    const i = t.length - 5;
    const res = await callOperator(validPost({
      t: t.slice(0, i) + (t[i] === "A" ? "B" : "A") + t.slice(i + 1),
    }));
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  /* CLAUDE.md rule 11: reject overlength input, never silently truncate
     user data. This path used to slice(0, MAX_NOTE_CHARS) and carry on,
     writing a note that stops mid-sentence into an append-only table the
     application cannot correct — and telling the operator it had recorded
     what she typed. */
  test("an overlength note is REFUSED, not truncated, and writes nothing", async () => {
    const calls = captureLedger();
    const res = await callOperator(validPost({ note: "n".repeat(281) }));
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0, "an overlength note reached the ledger");
    assert.match(res.body, /Not recorded/);
    assert.match(res.body, /not shortened for you/);
  });

  test("a note at exactly the limit is accepted whole", async () => {
    const note = "n".repeat(280);
    const calls = captureLedger();
    const res = await callOperator(validPost({ note }));
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(column(calls, "metadata")).operator_note, note,
      "the note was altered on its way into metadata");
  });

  test("an overlength note is refused before HubSpot is consulted", async () => {
    setEnv({
      [FEATURE_FLAG]: "true",
      HUBSPOT_ACCESS_TOKEN: "pat-test", HUBSPOT_PORTAL_ID: "1", HUBSPOT_FORM_GUID: "g",
    });
    let reached = false;
    globalThis.fetch = async () => { reached = true; throw new Error("should not be reached"); };
    const calls = captureLedger();
    const res = await callOperator(validPost({ note: "n".repeat(400) }));
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
    assert.equal(reached, false, "a refused POST still projected to the CRM");
  });

  test("the refusal logs the limit and not one character of the note", async () => {
    captureLedger();
    const { text } = await capturingLogs(() =>
      callOperator(validPost({ note: "hassling secret note ".repeat(20) })));
    assert.match(text, /note_too_long/);
    assert.ok(!text.includes("hassling"), "the operator's note reached a log");
  });

  test("the confirmation page still hints the limit in the browser", async () => {
    const res = await callOperator({ method: "GET", url: `${ACTION_PATH}?t=${tokenFor()}`, headers: {} });
    assert.match(res.body, /maxlength="280"/,
      "the browser hint is gone - server validation is authoritative, but the hint is still worth having");
  });

  test("with CONSENT_LEDGER_URL absent the POST is 503, not a page saying recorded", async () => {
    setEnv({ [LEDGER_URL_VAR]: undefined });
    const calls = captureLedger();
    const res = await callOperator(validPost());
    assert.equal(res.statusCode, 503);
    assert.equal(calls.length, 0);
    assert.match(res.body, /Not recorded/);
  });
});

/* =====================================================================
   4  POST — the row it writes
   ===================================================================== */
describe("POST /api/operator-action — the durable record", () => {
  test("writes exactly one revoked / manual / operator row", async () => {
    const calls = captureLedger();
    const res = await callOperator(validPost());

    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Recorded/);
    assert.equal(calls.length, 1, "more than one statement was sent");
    assert.equal(calls[0].params.length, SUPPRESSION_COLUMNS.length, "more than one row was written");

    assert.equal(column(calls, "event_type"), EVENT_TYPE.REVOKED);
    assert.equal(column(calls, "reason_code"), SUPPRESSION_REASON.MANUAL);
    assert.equal(column(calls, "source"), SOURCE_OPERATOR);
    assert.equal(column(calls, "source_event_id"), SID);
    assert.equal(column(calls, "phone_e164"), PHONE);
    assert.equal(column(calls, "channel"), CHANNEL.SMS);
    assert.equal(column(calls, "submission_id"), null);
  });

  /* `revoked` AND NOT `suppressed`, because that is the act that
     happened: this message reached a human BECAUSE it was not a keyword. */
  test("it never writes `suppressed`, and cannot write `unsuppressed`", async () => {
    const calls = captureLedger();
    await callOperator(validPost());
    assert.notEqual(column(calls, "event_type"), EVENT_TYPE.SUPPRESSED);
    assert.notEqual(column(calls, "event_type"), EVENT_TYPE.UNSUPPRESSED);

    const src = readFileSync(join(REPO, "api/operator-action.js"), "utf8");
    assert.ok(!src.includes("UNSUPPRESSED"),
      "the endpoint names UNSUPPRESSED - there is deliberately no unsuppression route in this phase");
  });

  test("the dedupe key converges as operator:<MessageSid>:<channel>:revoked", async () => {
    for (const [scope, channel] of [["sms", "sms"], ["ai_voice", "ai_voice"], ["all", "all"]]) {
      const calls = captureLedger();
      const res = await callOperator(validPost({ scope }));
      assert.equal(res.statusCode, 200);
      assert.equal(column(calls, "dedupe_key"), `operator:${SID}:${channel}:revoked`);
      assert.equal(column(calls, "channel"), channel);
      _resetExecutor();
    }
  });

  test("a duplicate POST produces the identical dedupe key — the second is a no-op at the database", async () => {
    const first = captureLedger();
    await callOperator(validPost());
    const one = column(first, "dedupe_key");
    _resetExecutor();

    /* A SECOND, INDEPENDENTLY SEALED token for the same message — a
       forwarded copy of the email, or a redelivered webhook. The key must
       still converge, because idempotency is derived from the MessageSid
       and not from the token. */
    const second = captureLedger();
    const res = await callOperator(validPost({ t: tokenFor() }));
    assert.equal(res.statusCode, 200);
    assert.equal(column(second, "dedupe_key"), one);
    assert.match(calls0Text(second), /ON CONFLICT DO NOTHING/i);
  });

  test("the statement is an INSERT with ON CONFLICT DO NOTHING and no conflict target", async () => {
    const calls = captureLedger();
    await callOperator(validPost());
    const text = calls0Text(calls);
    assert.match(text, /^\s*INSERT INTO/i);
    assert.match(text, /ON CONFLICT DO NOTHING/i);
    /* Naming a conflict target requires SELECT, which this role
       deliberately lacks — the 42501 outage of 9 September 2026. */
    assert.ok(!/ON CONFLICT\s*\(/i.test(text), "the statement names a conflict target");
    assert.ok(!/\bUPDATE\b|\bDELETE\b/i.test(text));
  });

  /* THE COLUMN THAT DEPENDS ON BEING VERBATIM. */
  test("evidence_text is the consumer's exact words, byte for byte", async () => {
    const calls = captureLedger();
    await callOperator(validPost());
    assert.equal(column(calls, "evidence_text"), WORDS);
  });

  test("an over-long message is capped by the same 1 KB rule, and says it was cut", async () => {
    const long = "x".repeat(EVIDENCE_TEXT_MAX_BYTES * 3);
    const calls = captureLedger();
    const res = await callOperator(validPost({
      t: sealOperatorToken({ sid: SID, phone: PHONE, body: capEvidence(long) }),
    }));
    assert.equal(res.statusCode, 200);
    const written = column(calls, "evidence_text");
    assert.ok(Buffer.byteLength(written, "utf8") <= EVIDENCE_TEXT_MAX_BYTES,
      "evidence_text exceeded the ledger's 1 KB cap");
    assert.match(written, /…\[truncated\]$/);
    /* And what is written is byte-identical to what the operator read. */
    assert.equal(written, capEvidence(long));
  });

  test("the operator's note goes in metadata and never into evidence_text", async () => {
    const calls = captureLedger();
    await callOperator(validPost({ note: "she called me too, same person" }));
    assert.equal(column(calls, "evidence_text"), WORDS);
    const meta = JSON.parse(column(calls, "metadata"));
    assert.equal(meta.operator_note, "she called me too, same person");
    assert.equal(meta.classified_by, "operator");
    assert.equal(meta.entered_via, "email_action");
    assert.equal(meta.MessageSid, SID);
  });

  test("no note means no operator_note key at all", async () => {
    const calls = captureLedger();
    await callOperator(validPost());
    assert.equal("operator_note" in JSON.parse(column(calls, "metadata")), false);
  });

  test("a ledger failure fails the POST — 503, never a page saying recorded", async () => {
    const calls = captureLedger({ fail: new Error("connection refused") });
    const res = await callOperator(validPost());
    assert.equal(res.statusCode, 503);
    assert.equal(calls.length, 1, "the append was not even attempted");
    assert.match(res.body, /Not recorded/);
    assert.ok(!/>Recorded</.test(res.body));
  });
});

function calls0Text(calls) { return String(calls[0].text); }

/* =====================================================================
   5  THE HUBSPOT PROJECTION — visibility, never compliance
   ===================================================================== */
describe("the HubSpot projection after an operator entry", () => {
  test("with the consent feature off, HubSpot is never touched", async () => {
    /* Configured, but the flag is absent — Production's state today. */
    setEnv({
      HUBSPOT_ACCESS_TOKEN: "pat-test", HUBSPOT_PORTAL_ID: "1", HUBSPOT_FORM_GUID: "g",
      [FEATURE_FLAG]: undefined,
    });
    let reached = false;
    globalThis.fetch = async () => { reached = true; throw new Error("should not be reached"); };

    const calls = captureLedger();
    const res = await callOperator(validPost());
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1, "the ledger row is still written");
    assert.equal(reached, false, "HubSpot was contacted with the consent feature off");
    assert.match(res.body, /CRM consent tracking is switched\s+off/);
  });

  test("with HubSpot unconfigured the suppression still stands", async () => {
    setEnv({ [FEATURE_FLAG]: "true" });
    const calls = captureLedger();
    const res = await callOperator(validPost());
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.match(res.body, /CRM is not connected/);
  });

  /* THE INVARIANT THE WHOLE ORDERING EXISTS FOR. */
  test("a HubSpot failure after a ledger success does not invalidate the suppression", async () => {
    setEnv({
      [FEATURE_FLAG]: "true",
      HUBSPOT_ACCESS_TOKEN: "pat-test", HUBSPOT_PORTAL_ID: "1", HUBSPOT_FORM_GUID: "g",
    });
    globalThis.fetch = async () => { throw new Error("HubSpot is down"); };

    const calls = captureLedger();
    const res = await callOperator(validPost());
    assert.equal(res.statusCode, 200, "a CRM outage turned a recorded opt-out into an error");
    assert.equal(calls.length, 1, "the ledger row was not written");
    assert.equal(column(calls, "event_type"), EVENT_TYPE.REVOKED);
    assert.match(res.body, /display problem only/);
  });

  test("it projects with the MANUAL trigger, and marks every matching contact", async () => {
    setEnv({
      [FEATURE_FLAG]: "true",
      HUBSPOT_ACCESS_TOKEN: "pat-test", HUBSPOT_PORTAL_ID: "1", HUBSPOT_FORM_GUID: "g",
    });
    const patches = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target.includes("/objects/contacts/search")) {
        return new Response(JSON.stringify({
          results: [{ id: "101", properties: {} }, { id: "102", properties: {} }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      patches.push({ url: target, body: JSON.parse(options.body || "{}") });
      return new Response(JSON.stringify({ id: "101" }),
        { status: 200, headers: { "content-type": "application/json" } });
    };

    const calls = captureLedger();
    const res = await callOperator(validPost());
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(patches.length, 2, "not every matching contact was marked");
    /* The MANUAL trigger's value in the SMS reason dropdown. No new
       dropdown option: `manual` already exists in all three maps. */
    assert.ok(res.body.includes("2 CRM contacts holding this number were marked as well."),
      "the full-success outcome is not stated exactly");
    const props = patches[0].body.properties;
    assert.equal(props.cst_sms_suppressed, "true");
    assert.equal(props.cst_sms_suppression_reason, "manual");
    /* And nothing is ever cleared. */
    for (const v of Object.values(props)) assert.notEqual(v, "false");
  });

  /* A PARTIAL OUTCOME MUST BE SHOWN, NOT HIDDEN. projectionSentence()
     read only `written` and ignored `failed`, so a page could say two
     contacts were marked when one of them was not. */
  test("one contact written and one failed is reported as exactly that", async () => {
    setEnv({
      [FEATURE_FLAG]: "true",
      HUBSPOT_ACCESS_TOKEN: "pat-test", HUBSPOT_PORTAL_ID: "1", HUBSPOT_FORM_GUID: "g",
    });
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("/objects/contacts/search"))
        return new Response(JSON.stringify({
          results: [{ id: "101", properties: {} }, { id: "102", properties: {} }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      /* The second contact's write is refused; the first succeeds. */
      if (target.includes("/102"))
        return new Response(JSON.stringify({ message: "nope" }), { status: 500 });
      return new Response(JSON.stringify({ id: "101" }),
        { status: 200, headers: { "content-type": "application/json" } });
    };

    const calls = captureLedger();
    const res = await callOperator(validPost());
    assert.equal(res.statusCode, 200, "a partial CRM outcome changed the response");
    assert.equal(calls.length, 1, "the ledger row was not written");
    /* Asserted as the exact sentence, not as a loose pattern: a dotall
       `.*` across a whole HTML page will match almost anything, which is
       how an assertion passes while proving nothing. */
    assert.ok(res.body.includes(
      "1 of 2 CRM contacts holding this number was marked; 1 could not be updated."),
      "the partial outcome is not stated exactly");
    assert.match(res.body, /the record above is the one that counts/i);
    assert.ok(!/2 CRM contacts holding this number were marked as well/.test(res.body),
      "the page claims both contacts were marked when one failed");
  });

  test("matching contacts whose writes ALL fail is reported as a failed projection", async () => {
    setEnv({
      [FEATURE_FLAG]: "true",
      HUBSPOT_ACCESS_TOKEN: "pat-test", HUBSPOT_PORTAL_ID: "1", HUBSPOT_FORM_GUID: "g",
    });
    globalThis.fetch = async (url) => {
      if (String(url).includes("/objects/contacts/search"))
        return new Response(JSON.stringify({
          results: [{ id: "101", properties: {} }, { id: "102", properties: {} }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ message: "nope" }), { status: 500 });
    };

    const calls = captureLedger();
    const res = await callOperator(validPost());
    assert.equal(res.statusCode, 200, "a failed CRM projection changed the response");
    assert.equal(calls.length, 1, "the ledger row was not written");
    assert.equal(column(calls, "event_type"), EVENT_TYPE.REVOKED);
    assert.ok(res.body.includes(
      "The CRM copy could not be updated for any of the 2 contacts holding this number."),
      "the total projection failure is not stated exactly");
    assert.match(res.body, /display problem only/i);
    /* The one thing that must never be in doubt on that page. */
    assert.match(res.body, /the record above is the one that counts/i);
    assert.ok(!/were marked as well/.test(res.body),
      "the page claims contacts were marked when none were");
  });

  test("contacts that were already marked read as already marked, not as marked now", async () => {
    setEnv({
      [FEATURE_FLAG]: "true",
      HUBSPOT_ACCESS_TOKEN: "pat-test", HUBSPOT_PORTAL_ID: "1", HUBSPOT_FORM_GUID: "g",
    });
    /* An already-suppressed contact produces an empty patch, and
       writeSuppressionProperties() then reports `written: false` without
       calling HubSpot at all — so this is neither a success nor a
       failure and must not read as either. */
    globalThis.fetch = async (url) => {
      if (String(url).includes("/objects/contacts/search"))
        return new Response(JSON.stringify({
          results: [{
            id: "101",
            properties: { cst_sms_suppressed: "true", cst_sms_suppressed_at: "2026-09-01T00:00:00Z" },
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error("no contact should have been patched");
    };

    const calls = captureLedger();
    const res = await callOperator(validPost());
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.ok(res.body.includes(
      "1 CRM contact holding this number was already marked, so nothing needed changing there."),
      "an already-marked contact is not stated exactly");
  });

  test("nobody in the CRM holding the number is not a failure", async () => {
    setEnv({
      [FEATURE_FLAG]: "true",
      HUBSPOT_ACCESS_TOKEN: "pat-test", HUBSPOT_PORTAL_ID: "1", HUBSPOT_FORM_GUID: "g",
    });
    globalThis.fetch = async () => new Response(JSON.stringify({ results: [] }),
      { status: 200, headers: { "content-type": "application/json" } });

    const calls = captureLedger();
    const res = await callOperator(validPost());
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.match(res.body, /Nobody in the CRM holds this number/);
  });
});

/* =====================================================================
   6  THE NOTIFICATION — never a silent 200
   ===================================================================== */
describe("the operator notification", () => {
  test("the subject exposes the last four digits and nothing more", () => {
    const msg = buildInboundNotification({
      from: PHONE, body: WORDS, messageSid: SID,
      receivedAt: "2026-09-10T12:00:00.000Z", actionUrl: "https://example.test/x",
    });
    assert.equal(msg.subject, NOTIFICATION_SUBJECT_PREFIX + "0123");
    assert.ok(!msg.subject.includes(PHONE), "the full number is in the subject - a subject is a lock screen");
    assert.ok(!msg.subject.includes("4195550"), "more than four digits are in the subject");
    assert.ok(!msg.subject.includes("hassling"), "the consumer's words are in the subject");
    assert.ok(!msg.subject.includes(SID));
  });

  test("lastFour never throws and never returns more than four digits", () => {
    assert.equal(lastFour(PHONE), "0123");
    assert.equal(lastFour(""), "unknown");
    assert.equal(lastFour(null), "unknown");
    assert.equal(lastFour("+1 (419) 555-0123"), "0123");
    assert.equal(lastFour("12"), "unknown");
  });

  /* Mail clients render the opening of the body as the preview line. */
  test("the first body line is fixed text, not the consumer's words", () => {
    const msg = buildInboundNotification({
      from: PHONE, body: "STOP TEXTING ME YOU CREEP", messageSid: SID,
      receivedAt: "2026-09-10T12:00:00.000Z", actionUrl: "https://example.test/x",
    });
    const first = msg.text.split("\n")[0];
    assert.match(first, /did not recognise/);
    assert.ok(!first.includes("CREEP"), "the consumer's words are the preview line");
    assert.ok(!first.includes(PHONE), "the number is the preview line");
  });

  test("the body carries the full number, tel:/sms: actions, the sid, the time and the link", () => {
    const msg = buildInboundNotification({
      from: PHONE, body: WORDS, messageSid: SID,
      receivedAt: "2026-09-10T12:00:00.000Z", actionUrl: "https://example.test/act?t=abc",
    });
    assert.ok(msg.text.includes(PHONE));
    assert.ok(msg.text.includes(WORDS));
    assert.ok(msg.text.includes(SID));
    assert.ok(msg.text.includes("2026-09-10T12:00:00.000Z"));
    assert.ok(msg.text.includes("https://example.test/act?t=abc"));
    assert.match(msg.html, /href="tel:/);
    assert.match(msg.html, /href="sms:/);
    /* And it says, in both parts, that a reply reaches nobody. */
    assert.match(msg.text, /REPLYING TO THIS EMAIL REACHES NOBODY/);
    assert.match(msg.html, /Replying to this email reaches nobody/);
  });

  test("the Message-ID is deterministic from the MessageSid", () => {
    const of = () => buildInboundNotification({
      from: PHONE, body: WORDS, messageSid: SID, receivedAt: "t", actionUrl: "u",
    }).messageId;
    assert.equal(of(), of());
    assert.equal(of(), `<inbound-${SID}@crystalsellstoledo.com>`);
  });

  test("the HTML escapes the consumer's words", () => {
    const msg = buildInboundNotification({
      from: PHONE, body: '<img src=x onerror="alert(1)">', messageSid: SID,
      receivedAt: "t", actionUrl: "u",
    });
    assert.ok(!msg.html.includes("<img src=x"), "the message body was injected into the HTML unescaped");
    assert.ok(msg.html.includes("&lt;img"));
  });
});

/* =====================================================================
   7  THE UNCLASSIFIED BRANCH — 200 only when it actually reached her
   ===================================================================== */
describe("an unclassified inbound message", () => {
  /* The webhook is exercised with signature verification satisfied by a
     stub, because what is under test here is the SURFACING branch and not
     the signature scheme — tests/suppression.test.mjs owns that, and
     proves it against an independent HMAC. */
  const inboundReq = (body) => {
    const fields = { MessageSid: SID, From: PHONE, Body: body, AccountSid: "AC1" };
    const raw = new URLSearchParams(fields).toString();
    return {
      method: "POST",
      url: "/api/twilio-inbound",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(raw)),
        "x-forwarded-proto": "https",
        "x-forwarded-host": "crystalsellstoledo.com",
        "x-twilio-signature": "stub",
      },
      body: raw,
      on() {}, destroy() {},
    };
  };

  let realValidate;
  before(async () => {
    const twilio = (await import("twilio")).default;
    realValidate = twilio.validateRequest;
    twilio.validateRequest = () => true;
  });
  after(async () => {
    const twilio = (await import("twilio")).default;
    twilio.validateRequest = realValidate;
  });

  const mailConfigured = () => setEnv({
    ZOHO_SMTP_HOST: "smtp.test", ZOHO_SMTP_PORT: "465",
    ZOHO_SMTP_USER: "u@test", ZOHO_SMTP_PASSWORD: "not-a-real-password",
  });

  const callInbound = async (body = "what time is the showing?") => {
    setEnv({ [TWILIO_TOKEN_VAR]: "test_auth_token_not_a_real_credential" });
    const res = mockRes();
    await inboundHandler(inboundReq(body), res);
    return res;
  };

  test("a successful SMTP handoff answers 200 and writes no ledger row", async () => {
    mailConfigured();
    const sent = [];
    setTransportFactory(async () => ({ sendMail: async (m) => { sent.push(m); return { messageId: "x" }; } }));
    const calls = captureLedger();

    const res = await callInbound();
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 0, "an unclassified message wrote to the compliance ledger");
    assert.equal(sent.length, 1, "no notification was sent");
    assert.match(sent[0].subject, /inbound message ending 0123$/);
    /* The link is a real, openable token for this exact message. */
    const url = sent[0].text.match(/https:\/\/\S*operator-action\S*/)[0];
    const opened = unsealOperatorToken(decodeURIComponent(url.split("?t=")[1]));
    assert.equal(opened.sid, SID);
    assert.equal(opened.phone, PHONE);
    assert.equal(opened.body, "what time is the showing?");
  });

  /* THE DEFECT THIS WHOLE PATH REMOVES. */
  test("a failed send answers 503 — never a silent 200", async () => {
    mailConfigured();
    setTransportFactory(async () => ({
      sendMail: async () => { const e = new Error("connect ECONNREFUSED"); e.code = "ECONNREFUSED"; throw e; },
    }));
    const res = await callInbound();
    assert.equal(res.statusCode, 503);
  });

  test("an SMTP auth failure answers 503", async () => {
    mailConfigured();
    setTransportFactory(async () => ({
      sendMail: async () => { const e = new Error("Invalid login"); e.code = "EAUTH"; throw e; },
    }));
    const res = await callInbound();
    assert.equal(res.statusCode, 503);
  });

  /* One overall deadline, because three independent SMTP bounds do not
     add up to a promise inside Twilio's ~15 s webhook timeout. */
  test("a send that never resolves answers 503 at the deadline", async () => {
    mailConfigured();
    setTransportFactory(async () => ({ sendMail: () => new Promise(() => {}) }));
    const started = Date.now();
    const res = await callInbound();
    const elapsed = Date.now() - started;
    assert.equal(res.statusCode, 503);
    assert.ok(elapsed >= NOTIFICATION_DEADLINE_MS - 250,
      `answered in ${elapsed}ms - the deadline did not bound the send`);
    assert.ok(elapsed < 15000, `answered in ${elapsed}ms - past Twilio's webhook timeout`);
  });

  /* THE DEFECT THIS PAIR EXISTS FOR. The deadline used to start AFTER
     `await transportFactory()`, so transport creation was outside it. The
     real factory does a dynamic `import("nodemailer")`, and a stuck
     import would have consumed the whole webhook budget before the clock
     started. */
  test("a transport factory that never resolves answers 503 at the deadline", async () => {
    mailConfigured();
    setTransportFactory(() => new Promise(() => {}));
    const started = Date.now();
    const res = await callInbound();
    const elapsed = Date.now() - started;
    assert.equal(res.statusCode, 503);
    assert.ok(elapsed >= NOTIFICATION_DEADLINE_MS - 250,
      `answered in ${elapsed}ms - the deadline did not cover transport creation`);
    assert.ok(elapsed < 15000,
      `answered in ${elapsed}ms - past Twilio's webhook timeout`);
  });

  test("a factory resolving AFTER the deadline never gets to send", async () => {
    /* Exercised directly, with a short deadline, so the assertion about
       what happens after it can be made without waiting 8 seconds. */
    mailConfigured();
    let sendMailCalled = 0;
    let resolveFactory;
    setTransportFactory(() => new Promise((resolve) => { resolveFactory = resolve; }));

    const started = Date.now();
    await assert.rejects(
      sendInboundNotification({ to: "x" }, { deadlineMs: 120 }),
      (err) => err && err.message === NOTIFICATION_TIMED_OUT);
    assert.ok(Date.now() - started < 2000, "the short deadline did not bound the attempt");

    /* NOW let the factory finish, as a slow dynamic import eventually
       would. The send must never start: the caller has already answered
       503 and nobody is waiting on this. */
    resolveFactory({ sendMail: async () => { sendMailCalled += 1; return {}; } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sendMailCalled, 0,
      "sendMail was started after the deadline had already been reported as a failure");
  });

  test("a send that had already started is not claimed to be cancelled", async () => {
    /* The documented, accepted risk: a send in flight when the deadline
       passes may still deliver, because nodemailer has no cancellation.
       Asserted so the claim in the docs stays honest. */
    mailConfigured();
    let settle;
    let sendMailCalled = 0;
    setTransportFactory(async () => ({
      sendMail: () => { sendMailCalled += 1; return new Promise((r) => { settle = r; }); },
    }));

    await assert.rejects(
      sendInboundNotification({ to: "x" }, { deadlineMs: 120 }),
      (err) => err && err.message === NOTIFICATION_TIMED_OUT);
    assert.equal(sendMailCalled, 1, "the send never started, so this proves nothing");
    settle({});   // the socket completes afterwards; nothing throws
    await new Promise((r) => setTimeout(r, 20));
  });

  test("a fast factory and a fast send still answer 200 well inside the deadline", async () => {
    mailConfigured();
    setTransportFactory(async () => ({ sendMail: async () => ({ messageId: "x" }) }));
    const started = Date.now();
    const res = await callInbound();
    assert.equal(res.statusCode, 200);
    assert.ok(Date.now() - started < 1000, "the happy path is not fast");
  });

  test("mail unconfigured answers 503, not a silent 200", async () => {
    /* SMTP absent; the secret is present, so this is the mail half alone. */
    const res = await callInbound();
    assert.equal(res.statusCode, 503);
  });

  test("the operator secret absent answers 503 — an email with no lever is half a workflow", async () => {
    mailConfigured();
    setEnv({ [OPERATOR_SECRET_VAR]: undefined });
    setTransportFactory(async () => ({ sendMail: async () => ({}) }));
    const res = await callInbound();
    assert.equal(res.statusCode, 503);
  });

  test("HELP is untouched — still 200, still nothing sent, still no row", async () => {
    mailConfigured();
    const sent = [];
    setTransportFactory(async () => ({ sendMail: async (m) => { sent.push(m); return {}; } }));
    const calls = captureLedger();
    const res = await callInbound("HELP");
    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 0, "HELP was surfaced - Twilio answers HELP itself");
    assert.equal(calls.length, 0);
  });

  test("a classified opt-out is untouched — it still writes a suppression and sends nothing", async () => {
    mailConfigured();
    const sent = [];
    setTransportFactory(async () => ({ sendMail: async (m) => { sent.push(m); return {}; } }));
    const calls = captureLedger();
    const res = await callInbound("STOP");
    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 0, "a classified STOP was emailed - it is already durable and projected");
    assert.equal(calls.length, 1);
    assert.equal(column(calls, "event_type"), EVENT_TYPE.SUPPRESSED);
  });
});

/* =====================================================================
   8  WHAT NEVER REACHES A LOG
   ===================================================================== */
describe("logging", () => {
  const forbidden = (text, label) => {
    for (const secret of [PHONE, "4195550123", "5550123", WORDS, "hassling"])
      assert.ok(!text.includes(secret),
        `${label} logged ${JSON.stringify(secret)}`);
  };

  test("a GET logs the MessageSid and neither the number nor the words", async () => {
    const { lines, text } = await capturingLogs(() =>
      callOperator({ method: "GET", url: `${ACTION_PATH}?t=${tokenFor()}`, headers: {} }));
    assert.ok(lines.length, "the GET emitted no log line at all");
    assert.ok(text.includes(SID), "the MessageSid is missing - a decision cannot be traced");
    forbidden(text, "the GET");
  });

  test("a successful POST logs the outcome and neither the number, the words nor the note", async () => {
    captureLedger();
    const { text } = await capturingLogs(() =>
      callOperator(validPost({ note: "hassling note text" })));
    assert.ok(text.includes(SID));
    forbidden(text, "the POST");
    assert.ok(!text.includes("hassling note text"), "the operator's note reached a log");
  });

  test("a refused POST logs a reason class and no value", async () => {
    captureLedger();
    const { text } = await capturingLogs(() => callOperator(validPost({ scope: "everything" })));
    assert.match(text, /scope_unknown/);
    forbidden(text, "the refusal");
  });

  test("the token itself never reaches a log", async () => {
    const t = tokenFor();
    const { text } = await capturingLogs(() =>
      callOperator({ method: "GET", url: `${ACTION_PATH}?t=${t}`, headers: {} }));
    assert.ok(!text.includes(t), "the sealed token was logged - it is a live capability");
    assert.ok(!text.includes(t.slice(0, 40)), "part of the sealed token was logged");
  });

  test("a ledger failure logs a driver class, not a driver message", async () => {
    const err = new Error("password authentication failed for user consent_ledger_app");
    err.code = "28P01";
    captureLedger({ fail: err });
    const { text } = await capturingLogs(() => callOperator(validPost()));
    assert.ok(!text.includes("password authentication failed"),
      "the driver's message reached a log - it can carry a host or a role");
    assert.match(text, /28P01/);
  });
});

/* =====================================================================
   9  CONTAINMENT — the secret, and the files that may name what
   ===================================================================== */
/** Files matching a literal, across tracked AND untracked source. `git
    grep` exits 1 for "no match", which is an answer and not an error. */
function gitGrep(literal) {
  try {
    return execFileSync("git",
      ["grep", "-l", "-F", "--untracked", "--exclude-standard", "--", literal],
      { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean).sort();
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
}

describe("containment", () => {
  test("the secret's VALUE appears in no source, test or document", () => {
    /* The name is expected in several places; a value never is. Guards
       the one mistake that would make every other guard pointless. */
    assert.deepEqual(gitGrep(SECRET), ["tests/operator-action.test.mjs"],
      "the test secret appears outside this test file");
    /* And it is obviously not a credential. */
    assert.match(SECRET, /not_a_real_credential/);
  });

  test("OPERATOR_ACTION_SECRET is guarded against reaching the browser", () => {
    const check = readFileSync(join(REPO, "tools/check.mjs"), "utf8");
    const at = check.indexOf("const SECRET_NAMES");
    assert.notEqual(at, -1);
    assert.ok(check.slice(at, check.indexOf("];", at)).includes("OPERATOR_ACTION_SECRET"),
      "OPERATOR_ACTION_SECRET is not in SECRET_NAMES - it could ship to a browser unnoticed");
  });

  test("no secret name is read anywhere but its owning module", () => {
    const files = gitGrep("OPERATOR_ACTION_SECRET").filter((f) => f.startsWith("api/"));
    assert.deepEqual(files, ["api/_lib/operator-token.mjs"],
      "the secret name is read outside api/_lib/operator-token.mjs");
  });

  test("the token module emits no log line of its own", () => {
    const src = readFileSync(join(REPO, "api/_lib/operator-token.mjs"), "utf8");
    assert.ok(!/\bconsole\.\w+\(/.test(src));
    assert.ok(!/\blog\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, " ")),
      "the module holding the plaintext number and message logs");
  });

  test("the endpoint names no ledger table or column", () => {
    const src = readFileSync(join(REPO, "api/operator-action.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ");
    for (const name of ["communication_consent_events", "phone_e164", "dedupe_key",
                        "source_event_id", "occurred_at"])
      assert.ok(!src.includes(name),
        `api/operator-action.js names ${name} - the schema belongs to api/_lib/consent-ledger.mjs`);
  });

  test("nothing reads CONSENT_LEDGER_URL or the owner credential directly", () => {
    /* Comments stripped: the header explains WHICH credential the write
       goes through, which is worth saying. What must not exist is a READ
       of the variable — that belongs to consentLedgerConfigured(). */
    const src = readFileSync(join(REPO, "api/operator-action.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ");
    assert.ok(!src.includes("CONSENT_LEDGER_URL"),
      "the endpoint reads the connection string - it must go through consentLedgerConfigured()");
    assert.ok(!/neondb_owner|consent_ledger_sender/.test(src),
      "the endpoint names a credential it must never hold");
  });
});

/* =====================================================================
   10  THE STATIC GUARDS — run against a throwaway copy of the tree
   =====================================================================
   NEVER against the working tree. A timeout between break and restore
   once left production source damaged, so every mutation below happens in
   a temporary directory that is deleted afterwards.
   ===================================================================== */
describe("the operator-action static guards", () => {
  let dir, root;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cst-operator-guard-"));
    root = join(dir, "tree");
    for (const item of ["src", "assets", "tools", "api", "db", "package.json",
                        "robots.txt", "site.webmanifest", ".env.example"])
      cpSync(join(REPO, item), join(root, item), { recursive: true });
    execFileSync(process.execPath, ["tools/build.mjs"], { cwd: root, stdio: "pipe" });
  });
  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const ENDPOINT = () => join(root, "api", "operator-action.js");
  const WEBHOOK = () => join(root, "api", "twilio-inbound.js");
  const pristineEndpoint = () => readFileSync(join(REPO, "api/operator-action.js"), "utf8");
  const pristineWebhook = () => readFileSync(join(REPO, "api/twilio-inbound.js"), "utf8");

  function runCheck() {
    try {
      execFileSync(process.execPath, ["tools/check.mjs"], { cwd: root, stdio: "pipe" });
      return { ok: true, output: "" };
    } catch (err) {
      return { ok: false, output: String(err.stdout || "") + String(err.stderr || "") };
    }
  }

  afterEach(() => {
    writeFileSync(ENDPOINT(), pristineEndpoint());
    writeFileSync(WEBHOOK(), pristineWebhook());
  });

  /* A MUTATION TEST THAT DOES NOT MUTATE REPORTS GREEN AND PROVES
     NOTHING. That is not hypothetical: the `unclassified_not_surfaced`
     mutation in tests/suppression.test.mjs went vacuous the moment this
     implementation reshaped the line it targeted, and passed anyway. So
     every mutation below goes through here, and a no-op replace is a
     failure. */
  function mutate(pathOf, pristineOf, from, to) {
    const pristine = pristineOf();
    const mutated = typeof from === "function" ? from(pristine) : pristine.replace(from, to);
    assert.notEqual(mutated, pristine,
      "the mutation changed nothing - this test would prove nothing about the guard");
    writeFileSync(pathOf(), mutated);
  }

  test("the unmodified tree passes", () => {
    assert.ok(runCheck().ok, "the guards fail on the tree as committed");
  });

  test("a GET that writes is refused", () => {
    mutate(ENDPOINT, pristineEndpoint,
      "  log(\"operator.action.confirmation_rendered\", { message_sid: payload.sid });",
      "  await appendSuppressionEvents([]);");
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a GET that appends to the ledger");
    assert.match(output, /link scanner/);
  });

  test("emitting `unsuppressed` from this endpoint is refused", () => {
    mutate(ENDPOINT, pristineEndpoint,
      "eventType: EVENT_TYPE.REVOKED,", "eventType: EVENT_TYPE.UNSUPPRESSED,");
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted an unsuppression from the operator endpoint");
    assert.match(output, /may emit only/);
  });

  test("projecting to HubSpot before the ledger is refused", () => {
    const src = pristineEndpoint();
    const ledger = "    await appendSuppressionEvents([event]);";
    const projection = "  const projection = await projectToHubSpot({ scope, phone: payload.phone, occurredAt, shape });";
    assert.ok(src.includes(ledger), "the ledger call site moved - this mutation no longer reorders anything");
    assert.ok(src.includes(projection), "the projection call site moved");
    /* Actually move it above the append, which is the mistake the guard
       exists to catch: the durable record would become the one whose
       failure is swallowed. */
    mutate(ENDPOINT, pristineEndpoint, (t) => t
      .replace(projection, "")
      .replace(ledger, projection.trim() + "\n" + ledger));
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted the projection running before the ledger append");
    assert.match(output, /before the ledger/);
  });

  test("dropping the scope refusal is refused", () => {
    mutate(ENDPOINT, pristineEndpoint, (t) => t.replace(/scope_missing/g, "scope_absent"));
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted an endpoint with no explicit no-scope refusal");
    assert.match(output, /default scope/);
  });

  test("an off-site resource on the confirmation page is refused", () => {
    mutate(ENDPOINT, pristineEndpoint,
      "<blockquote>", "<img src=\"https://tracker.example/p.gif\"><blockquote>");
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a third-party asset on the confirmation page");
    assert.match(output, /off-site resource/);
  });

  test("removing the notification from the unclassified branch is refused", () => {
    mutate(WEBHOOK, pristineWebhook,
      "await sendInboundNotification(", "await Promise.resolve(");
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a webhook that surfaces nothing");
    assert.match(output, /reach nobody/);
  });

  test("dropping the secret's entropy floor is refused", () => {
    const tokenPath = join(root, "api", "_lib", "operator-token.mjs");
    const pristine = readFileSync(join(REPO, "api/_lib/operator-token.mjs"), "utf8");
    const mutated = pristine.replace(/MIN_SECRET_BYTES/g, "SUGGESTED_SECRET_BYTES");
    assert.notEqual(mutated, pristine, "the mutation changed nothing");
    writeFileSync(tokenPath, mutated);
    try {
      const { ok, output } = runCheck();
      assert.ok(!ok, "check.mjs accepted a sealing key with no minimum length");
      assert.match(output, /HKDF does not turn a weak secret into a strong key/);
    } finally {
      writeFileSync(tokenPath, pristine);
    }
  });

  test("dropping the token module's size bound is refused", () => {
    const tokenPath = join(root, "api", "_lib", "operator-token.mjs");
    const pristine = readFileSync(join(REPO, "api/_lib/operator-token.mjs"), "utf8");
    const mutated = pristine.replace(/MAX_ACTION_URL_BYTES/g, "URL_BUDGET_HINT");
    assert.notEqual(mutated, pristine, "the mutation changed nothing");
    writeFileSync(tokenPath, mutated);
    try {
      const { ok, output } = runCheck();
      assert.ok(!ok, "check.mjs accepted a token module with no hard size bound");
      assert.match(output, /hard size bound/);
    } finally {
      writeFileSync(tokenPath, pristine);
    }
  });
});
