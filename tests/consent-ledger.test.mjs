/* The append-only consent ledger — Phase 3.
 *
 * Tier 4: compliance, evidence and permission. NOTHING here reaches a
 * database. The module's I/O is one narrow function behind an injected
 * executor seam, exactly as the HubSpot tests stub `globalThis.fetch`, so
 * no Neon project, no connection string and no row is ever involved.
 *
 * The invariants worth the most: a failed append never becomes a silent
 * success; an unticked box is never recorded as a revocation; the ledger
 * carries no PII beyond the number the consent binds to; and `event_id` is
 * the database's to mint, not this process's.
 */

import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  LEDGER_URL_VAR, LEDGER_TABLE, LEDGER_COLUMNS, SCHEMA_VERSION,
  CHANNEL, EVENT_TYPE, SOURCE_WEBSITE,
  LEDGER_NOT_CONFIGURED, LEDGER_PHONE_NOT_E164, LEDGER_EVIDENCE_INCOMPLETE,
  LEDGER_TIMEOUT, LEDGER_APPEND_FAILED,
  consentLedgerConfigured, toE164, dedupeKey, buildLedgerEvents, buildInsert,
  appendConsentEvents, ledgerLogShape, driverShape, _setExecutor, _resetExecutor,
} from "../api/_lib/consent-ledger.mjs";
import { buildConsentEvidence, SMS_CONSENT, AI_VOICE_CONSENT } from "../api/_lib/consent.mjs";
import { validateLead } from "../api/_lib/validate.mjs";
import { validHomeValue } from "./helpers.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SID = "csv_test000000000000000000";
const URL_VALUE = "postgres://app:secret@ledger.example/neondb";
const ENV = { [LEDGER_URL_VAR]: URL_VALUE };

/** Server-owned evidence for one submission, exactly as api/lead.js builds it. */
function evidenceFor(over = {}) {
  const payload = validateLead({ ...validHomeValue, ...over });
  payload.meta.submission_id = SID;
  return buildConsentEvidence(payload);
}

/** Capture every statement the module would send. */
function captureExecutor({ fail = null, delayMs = 0 } = {}) {
  const calls = [];
  _setExecutor(async (text, params, opts) => {
    calls.push({ text, params, opts });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (fail) throw fail;
    return [];
  });
  return calls;
}

afterEach(() => _resetExecutor());

/* =====================================================================
   1  CONFIGURATION
   ===================================================================== */
describe("configuration", () => {
  test("the ledger is configured only by a nonblank connection string", () => {
    assert.equal(consentLedgerConfigured({}), false);
    assert.equal(consentLedgerConfigured({ [LEDGER_URL_VAR]: "" }), false);
    assert.equal(consentLedgerConfigured({ [LEDGER_URL_VAR]: "   " }), false);
    assert.equal(consentLedgerConfigured(ENV), true);
  });

  /* A missing URL is an evidence outage, not a lead outage. It must fail
     the APPEND — which withholds the grant — and nothing else. */
  test("a missing URL fails the append without reaching an executor", async () => {
    const calls = captureExecutor();
    await assert.rejects(
      () => appendConsentEvents(evidenceFor({ sms_consent: true }), { env: {} }),
      (err) => err.token === LEDGER_NOT_CONFIGURED && err.ledgerFailed === true);
    assert.equal(calls.length, 0, "an unconfigured ledger still tried to write");
  });

  /* The connection string is a credential. It must never reach a log line
     through an error message. */
  test("no failure classification carries the connection string", () => {
    for (const err of [
      Object.assign(new Error("connect ECONNREFUSED " + URL_VALUE), {}),
      { ledgerFailed: true, token: LEDGER_NOT_CONFIGURED, detail: LEDGER_URL_VAR },
    ]) {
      const shape = JSON.stringify(ledgerLogShape(err));
      assert.ok(!shape.includes("secret"), "a credential leaked into the log shape");
      assert.ok(!shape.includes("ledger.example"), "a host leaked into the log shape");
    }
    /* An unclassified driver error is still classified, never passed through.
       The class name is allowed out; the message is not. */
    assert.deepEqual(ledgerLogShape(new Error("relation does not exist")),
      { ledger_error: LEDGER_APPEND_FAILED, ledger_driver_error: "Error" });
    assert.deepEqual(ledgerLogShape(undefined), { ledger_error: LEDGER_APPEND_FAILED });
  });

  /* The two structural fields exist to tell "the driver is not in the
     bundle" apart from "the database refused the credential". They are the
     only things allowed out of a driver error, and they are whitelisted to
     identifier characters so that no message, host or value can occupy
     them. */
  test("the driver's class and symbolic code identify the failure", () => {
    const missing = Object.assign(new Error("Cannot find package '@neondatabase/serverless'"),
      { code: "ERR_MODULE_NOT_FOUND" });
    assert.deepEqual(ledgerLogShape(missing), {
      ledger_error: LEDGER_APPEND_FAILED,
      ledger_driver_error: "Error",
      ledger_driver_code: "ERR_MODULE_NOT_FOUND",
    });

    const refused = Object.assign(new Error("password authentication failed"),
      { name: "NeonDbError", code: "28P01" });
    assert.deepEqual(ledgerLogShape(refused), {
      ledger_error: LEDGER_APPEND_FAILED,
      ledger_driver_error: "NeonDbError",
      ledger_driver_code: "28P01",
    });

    /* Node wraps some failures; the useful code sits on the cause. */
    const wrapped = Object.assign(new Error("fetch failed"),
      { name: "TypeError", cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }) });
    assert.equal(ledgerLogShape(wrapped).ledger_driver_code, "ENOTFOUND");
  });

  /* Failing towards silence: anything that is not an identifier is dropped
     entirely rather than logged. A driver that puts free text, a host or a
     connection string in `code` therefore contributes nothing. */
  test("only identifier-shaped structure escapes a driver error", () => {
    for (const value of [
      "connect ECONNREFUSED " + URL_VALUE,
      "ledger.example.neon.tech",
      "postgresql://app:secret@host/db",
      "role \"consent_ledger_app\" was refused",
      "(419) 555-0000",
      "_leading",
      "4195550000",
      "",
      42,
      { toString: () => "ERR_OBJECT" },
    ]) {
      const shape = ledgerLogShape(Object.assign(new Error("x"), { name: "Error", code: value }));
      assert.equal(shape.ledger_driver_code, undefined,
        "a non-identifier code reached the log: " + String(value));
    }
    assert.equal(driverShape(null), null);
    assert.equal(driverShape("a string"), null);
    assert.equal(driverShape({}), null);
    /* Neither the message nor the cause object is ever a field of its own. */
    const shape = ledgerLogShape(Object.assign(new Error("FATAL: " + URL_VALUE),
      { cause: new Error(URL_VALUE) }));
    assert.deepEqual(Object.keys(shape).sort(), ["ledger_driver_error", "ledger_error"]);
  });
});

/* =====================================================================
   2  E.164
   ===================================================================== */
describe("E.164 conversion", () => {
  test("ten digits and a 1-prefixed eleven become +1", () => {
    assert.equal(toE164("4195551234"), "+14195551234");
    assert.equal(toE164("(419) 555-1234"), "+14195551234");
    assert.equal(toE164("419.555.1234"), "+14195551234");
    assert.equal(toE164("14195551234"), "+14195551234");
    assert.equal(toE164("1 (419) 555-1234"), "+14195551234");
    /* validHomeValue's normalised phone — the real production shape. */
    assert.equal(toE164("(419) 555-0000"), "+14195550000");
  });

  test("an already-E.164 number is accepted as given, never reformatted", () => {
    assert.equal(toE164("+14195551234"), "+14195551234");
    assert.equal(toE164("+442071234567"), "+442071234567");
    assert.equal(toE164("+61 2 9374 4000"), "+61293744000");
  });

  /* Refusal is the fail-closed direction: no ledger row, so no grant, while
     the lead itself is stored and worked normally. */
  test("anything else throws rather than guessing", () => {
    for (const bad of ["", "   ", null, undefined, "555-1234", "12345",
                       "+1", "+0123456789012", "+1234567890123456",
                       "abcdefghij", "24195551234", {}, []])
      assert.throws(() => toE164(bad),
        (err) => err.token === LEDGER_PHONE_NOT_E164 && err.ledgerFailed === true,
        `${JSON.stringify(bad)} was converted`);
  });

  /* The one that would be easy to get wrong: a refusal must surface as an
     APPEND failure the caller can swallow, never as a thrown lead. */
  test("a refused number fails the append, and nothing is written", async () => {
    const calls = captureExecutor();
    const evidence = evidenceFor({ sms_consent: true });
    evidence.phone = "+44 20 7123";                 // unconvertible
    await assert.rejects(
      () => appendConsentEvents(evidence, { env: ENV }),
      (err) => err.token === LEDGER_PHONE_NOT_E164);
    assert.equal(calls.length, 0, "an unconvertible number still produced a write");
  });
});

/* =====================================================================
   3  DEDUPE KEYS
   ===================================================================== */
describe("dedupe keys", () => {
  const key = (over = {}) => dedupeKey({
    source: SOURCE_WEBSITE, sourceEventId: SID,
    channel: CHANNEL.SMS, eventType: EVENT_TYPE.CONSENT_SELECTED, ...over,
  });

  test("the key is deterministic and matches the documented shape", () => {
    assert.equal(key(), `website:${SID}:sms:consent_selected`);
    assert.equal(key(), key(), "the same event produced two different keys");
  });

  test("a key is distinct per channel and per event type", () => {
    const keys = new Set([
      key(),
      key({ channel: CHANNEL.AI_VOICE }),
      key({ eventType: EVENT_TYPE.CONSENT_NOT_SELECTED }),
      key({ channel: CHANNEL.AI_VOICE, eventType: EVENT_TYPE.CONSENT_NOT_SELECTED }),
      key({ sourceEventId: "csv_other" }),
    ]);
    assert.equal(keys.size, 5, "two distinct events share a dedupe key");
  });

  /* The worst failure this module could have. A blank submission id would
     collapse every submission onto one key, and ON CONFLICT DO NOTHING
     would then discard the SECOND submission's events while reporting
     success — a missing consent record that looks like a present one. */
  test("a blank or colon-bearing component is refused, never defaulted", () => {
    for (const field of ["source", "sourceEventId", "channel", "eventType"])
      for (const bad of ["", "   ", null, undefined, "a:b"])
        assert.throws(() => key({ [field]: bad }),
          (err) => err.token === LEDGER_EVIDENCE_INCOMPLETE && err.detail === field,
          `${field}=${JSON.stringify(bad)} produced a key`);
  });
});

/* =====================================================================
   4  BUILDING THE EVENTS
   ===================================================================== */
describe("building the ledger events", () => {
  test("one row per channel, always both", () => {
    for (const over of [{}, { sms_consent: true }, { ai_voice_consent: true },
                        { sms_consent: true, ai_voice_consent: true }]) {
      const rows = buildLedgerEvents(evidenceFor(over));
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.channel), [CHANNEL.SMS, CHANNEL.AI_VOICE]);
    }
  });

  /* `consent_not_selected` must never mean revocation. Reading it as one
     would silently destroy a lawful permission granted on an earlier
     submission. */
  test("an unticked box is consent_not_selected and never a revocation", () => {
    const rows = buildLedgerEvents(evidenceFor({ sms_consent: true }));
    const [sms, voice] = rows;
    assert.equal(sms.event_type, EVENT_TYPE.CONSENT_SELECTED);
    assert.equal(voice.event_type, EVENT_TYPE.CONSENT_NOT_SELECTED);
    for (const r of rows)
      for (const forbidden of [EVENT_TYPE.REVOKED, EVENT_TYPE.SUPPRESSED,
                               EVENT_TYPE.UNSUPPRESSED, EVENT_TYPE.REOPTIN_REQUESTED])
        assert.notEqual(r.event_type, forbidden,
          "the website path emitted a suppression or revocation event");
  });

  test("the disclosure text and version are the server's, not the request's", () => {
    const rows = buildLedgerEvents(evidenceFor({
      sms_consent: true,
      /* A forged request cannot substitute its own wording: nothing here
         is read from the body. */
      sms_consent_text: "I agree to absolutely anything",
      sms_consent_version: "ATTACKER_V9",
    }));
    const [sms, voice] = rows;
    assert.equal(sms.consent_copy_version, SMS_CONSENT.version);
    assert.equal(sms.consent_copy_text, SMS_CONSENT.text);
    assert.equal(voice.consent_copy_version, AI_VOICE_CONSENT.version);
    assert.equal(voice.consent_copy_text, AI_VOICE_CONSENT.text);
    assert.ok(!JSON.stringify(rows).includes("ATTACKER_V9"));
    assert.ok(!JSON.stringify(rows).includes("absolutely anything"));
  });

  /* The phone is required on EVERY row, ticked or not: an event that does
     not say which line it concerns proves nothing about that line. */
  test("every row carries the number, including a not-selected one", () => {
    const rows = buildLedgerEvents(evidenceFor({}));
    for (const r of rows) {
      assert.equal(r.event_type, EVENT_TYPE.CONSENT_NOT_SELECTED);
      assert.equal(r.phone_e164, "+14195550000");
    }
  });

  test("the server timestamp, submission id, form type and page are carried", () => {
    const evidence = evidenceFor({ sms_consent: true });
    const [sms] = buildLedgerEvents(evidence);
    assert.equal(sms.occurred_at, new Date(evidence.captured_at).toISOString());
    assert.equal(sms.submission_id, SID);
    assert.equal(sms.source_event_id, SID);
    assert.equal(sms.source, SOURCE_WEBSITE);
    assert.equal(sms.form_type, "home_value");
    assert.equal(sms.page_path, "/home-value");
    assert.equal(sms.schema_version, SCHEMA_VERSION);
  });

  test("incomplete evidence produces no rows at all", () => {
    for (const [field, mutate] of [
      ["evidence", () => null],
      ["submission_id", (e) => { e.submission_id = ""; return e; }],
      ["captured_at", (e) => { e.captured_at = "not a date"; return e; }],
      ["sms", (e) => { e.sms = null; return e; }],
      ["sms.version", (e) => { e.sms.version = ""; return e; }],
      ["ai_voice.exact_text", (e) => { e.ai_voice.exact_text = ""; return e; }],
    ]) {
      const evidence = mutate(evidenceFor({ sms_consent: true }));
      assert.throws(() => buildLedgerEvents(evidence),
        (err) => err.token === LEDGER_EVIDENCE_INCOMPLETE && err.detail === field,
        `a ledger row survived a broken ${field}`);
    }
  });
});

/* =====================================================================
   5  PII CONTAINMENT
   ---------------------------------------------------------------------
   Asserted against the ACTUAL values in a real submission, not against a
   column allow-list. A list can be extended by the same commit that leaks
   something; the visitor's own name cannot.
   ===================================================================== */
describe("PII containment", () => {
  test("nothing but the phone and the submission id identifies the person", () => {
    const rows = buildLedgerEvents(evidenceFor({ sms_consent: true, ai_voice_consent: true }));
    const blob = JSON.stringify(rows);
    for (const secret of [
      validHomeValue.first_name, validHomeValue.last_name, validHomeValue.email,
      validHomeValue.property_address, validHomeValue.notes, validHomeValue.condition,
      validHomeValue.timeline,
    ])
      assert.ok(!blob.includes(secret), `the ledger row carries "${secret}"`);
    /* And no IP: the privacy notice says addresses are held in memory for
       rate limiting and never added to a record. */
    assert.ok(!blob.includes("203.0.113"), "an IP address reached the ledger");
    assert.ok(!/\bip\b/i.test(Object.keys(rows[0]).join(" ")), "an IP column exists");
  });

  test("the written column list is exactly the documented one", () => {
    const rows = buildLedgerEvents(evidenceFor({}));
    for (const r of rows) assert.deepEqual(Object.keys(r), [...LEDGER_COLUMNS]);
  });
});

/* =====================================================================
   6  THE STATEMENT — event_id is the database's
   ===================================================================== */
describe("the INSERT statement", () => {
  /* REGRESSION, 10 September 2026. This clause named its conflict target —
     `ON CONFLICT (dedupe_key)` — and every preview submission failed with
     NeonDbError 42501, permission denied, while a plain INSERT under the
     same role succeeded. Naming a target, as a column list OR as
     `ON CONSTRAINT <name>`, makes Postgres require SELECT on the table:
     inferring the arbiter index is a read. The application role holds
     INSERT and nothing else by design, so the target had to go, not the
     grant.

     Reproduced and fixed against Postgres 16 with db/001 applied verbatim
     and a role granted INSERT only:

       plain INSERT                              -> INSERT 0 2
       ON CONFLICT (dedupe_key) DO NOTHING       -> ERROR 42501
       ON CONFLICT ON CONSTRAINT <name> DO ...   -> ERROR 42501
       ON CONFLICT DO NOTHING                    -> INSERT 0 2, replay 0,
                                                    replay after one row
                                                    deleted -> 1
       SELECT / UPDATE / DELETE / TRUNCATE       -> still all refused

     This test is what stops the clause being "tidied" back into the more
     readable form, which would silently withhold every consent grant in
     production while the lead itself still succeeded. */
  test("the conflict clause names no target, so INSERT alone suffices", async () => {
    const calls = captureExecutor();
    await appendConsentEvents(evidenceFor({ sms_consent: true }), { env: ENV });
    const { text } = calls[0];

    assert.match(text, /ON CONFLICT DO NOTHING$/,
      "the conflict clause is not the bare, INSERT-only form");
    assert.ok(!/ON CONFLICT\s*\(/.test(text),
      "a column conflict target is back — it requires SELECT, which the role lacks");
    assert.ok(!/ON\s+CONSTRAINT/i.test(text),
      "a named constraint target is back — it requires SELECT too");
    /* DO UPDATE would need UPDATE, which no append-only role may hold. */
    assert.ok(!/DO\s+UPDATE/i.test(text), "DO UPDATE would need UPDATE privilege");
    /* RETURNING would need SELECT on the returned columns. */
    assert.ok(!/RETURNING/i.test(text), "RETURNING would need SELECT privilege");
  });

  test("one parameterised multi-row INSERT, with the conflict clause", async () => {
    const calls = captureExecutor();
    const res = await appendConsentEvents(evidenceFor({ sms_consent: true }), { env: ENV });
    assert.deepEqual(res, { appended: true, events: 2 });
    assert.equal(calls.length, 1, "the two channel rows were not written in one statement");

    const { text, params } = calls[0];
    assert.equal((text.match(/INSERT INTO/g) || []).length, 1);
    assert.match(text, new RegExp("INSERT INTO " + LEDGER_TABLE));
    assert.match(text, /ON CONFLICT DO NOTHING$/);
    assert.equal(params.length, LEDGER_COLUMNS.length * 2);
    /* Parameterised, not interpolated: no value appears in the statement. */
    for (const p of params)
      if (typeof p === "string" && p.length > 3)
        assert.ok(!text.includes(p), `the value "${p}" was interpolated into the SQL`);
    assert.equal(calls[0].opts.url, URL_VALUE);
  });

  /* The uniqueness guarantee of a primary key belongs to the store that
     enforces it. A later "helpful" client-side UUID fails here rather than
     quietly taking that guarantee away. */
  test("event_id and recorded_at are the database's, in the statement and in the source", () => {
    const { text, params } = buildInsert(buildLedgerEvents(evidenceFor({})));
    const columnList = /\(([^)]*)\)\s*\n?VALUES/.exec(text)[1];
    for (const dbOwned of ["event_id", "recorded_at"]) {
      /* Not a substring test: `source_event_id` legitimately ends in
         `event_id` and is the module's own column. */
      const named = new RegExp("(^|[\\s(,])" + dbOwned + "\\b");
      assert.ok(!named.test(columnList), `${dbOwned} is named in the INSERT column list`);
      assert.ok(!named.test(text), `${dbOwned} appears in the statement`);
    }
    assert.equal(params.length, LEDGER_COLUMNS.length * 2,
      "a parameter was supplied for a column the database owns");

    const src = readFileSync(join(REPO, "api/_lib/consent-ledger.mjs"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ");
    assert.ok(!/randomUUID/.test(src), "the module mints an event_id in Node");
    assert.ok(!/node:crypto/.test(src), "the module imports node:crypto");
  });

  test("the migration declares the default the statement relies on", () => {
    const sql = readFileSync(join(REPO, "db/001_communication_consent_events.sql"), "utf8");
    assert.match(sql, /event_id\s+uuid\s+PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    assert.match(sql, /recorded_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
    assert.match(sql, /dedupe_key\s+text\s+NOT NULL UNIQUE/);
    /* APPEND-ONLY IS THE GRANT, and the grant is INSERT and nothing else.
       SELECT is refused along with UPDATE, DELETE and TRUNCATE: the
       application never reads this table, and table-wide read access to a
       ledger of phone numbers and consent decisions is a standing
       disclosure risk a leaked CONSENT_LEDGER_URL would cash in. No
       sequence grant either — a uuid default uses none. */
    assert.match(sql, /^GRANT INSERT ON communication_consent_events TO /m);
    const grants = sql.split("\n").filter((l) => /^\s*GRANT\b/.test(l)).join("\n");
    for (const forbidden of ["SELECT", "UPDATE", "DELETE", "TRUNCATE", "SEQUENCE", "ALL"])
      assert.ok(!grants.includes(forbidden), `the migration grants ${forbidden}`);
    /* And the human procedure has to actually check all four refusals, as
       the application role, or nobody ever finds out the grant is wrong. */
    const verify = sql.slice(sql.indexOf("VERIFY THE GRANT"));
    for (const refused of ["SELECT", "UPDATE", "DELETE", "TRUNCATE"])
      assert.match(verify, new RegExp(refused + "[\\s\\S]{0,120}must be REFUSED"),
        `the verification procedure does not require ${refused} to be refused`);
    /* Every column the module writes must exist in the table. */
    for (const col of LEDGER_COLUMNS)
      assert.match(sql, new RegExp("^\\s*" + col + "\\s", "m"), `the table has no ${col} column`);
  });
});

/* =====================================================================
   7  THE STATIC GUARD ACTUALLY CATCHES ITS REGRESSION
   ---------------------------------------------------------------------
   tools/check.mjs refuses an api/lead.js whose ledger append does not
   precede the CRM write. A guard nobody has ever seen fail is a guard
   nobody knows works — and this one did not: it searched for the bare
   identifier `appendConsentEvents`, which matches the IMPORT at the top of
   the file. An import precedes everything, so the comparison could never
   fail and the presence check would have survived deleting the call.

   Proven by running the real tools/check.mjs against a THROWAWAY COPY of
   the tree with a deliberately broken api/lead.js. The working tree is
   never mutated: the same technique tests/consent.test.mjs already uses to
   build the site twice, and the one the workflow permits for a Tier 4
   invariant.
   ===================================================================== */
describe("the append-order guard in tools/check.mjs", () => {
  /* The strings tools/check.mjs matches on. Pinned here so renaming one
     there without updating this file fails a test rather than quietly
     disarming the guard. */
  const LEDGER_APPEND_CALL = "await appendConsentEvents(";
  const CRM_WRITE_CALL = "await createLead(";

  let dir, root;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cst-ledger-guard-"));
    root = join(dir, "tree");
    /* Everything tools/build.mjs and tools/check.mjs read. `.env.example`
       is one of check.mjs's own subjects, so its absence would fail the
       run for a reason that has nothing to do with this guard. */
    for (const item of ["src", "assets", "tools", "api", "package.json",
                        "robots.txt", "site.webmanifest", ".env.example"])
      cpSync(join(REPO, item), join(root, item), { recursive: true });
    /* check.mjs reads public/, so the copy needs one. Built once; every
       mutation below touches only api/lead.js, which check.mjs re-reads
       from disk on each run. */
    execFileSync(process.execPath, ["tools/build.mjs"], { cwd: root, stdio: "pipe" });
  });
  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const LEAD = () => join(root, "api", "lead.js");
  const pristine = () => readFileSync(join(REPO, "api/lead.js"), "utf8");

  /** Run the real check.mjs in the copy. Returns { ok, output }. */
  function runCheck() {
    try {
      execFileSync(process.execPath, ["tools/check.mjs"], { cwd: root, stdio: "pipe" });
      return { ok: true, output: "" };
    } catch (err) {
      return { ok: false, output: String(err.stdout || "") + String(err.stderr || "") };
    }
  }

  test("check.mjs matches the call sites this test pins", () => {
    const checkSrc = readFileSync(join(REPO, "tools/check.mjs"), "utf8");
    for (const call of [LEDGER_APPEND_CALL, CRM_WRITE_CALL])
      assert.ok(checkSrc.includes(JSON.stringify(call)),
        `tools/check.mjs no longer matches on ${JSON.stringify(call)}`);
    /* And the bug itself: the guard must not compare on the bare
       identifier, which the import line satisfies. */
    assert.ok(!/indexOf\("appendConsentEvents"\)/.test(checkSrc),
      "the ordering guard compares on the identifier, which matches the import and can never fail");
  });

  test("the unmodified tree passes", () => {
    writeFileSync(LEAD(), pristine());
    const { ok, output } = runCheck();
    assert.ok(ok, "check.mjs rejected the real api/lead.js:\n" + output);
  });

  /* THE REGRESSION THE OLD GUARD MISSED. The append is moved after the CRM
     write; the import stays exactly where it was. The old comparison saw
     the import and passed. */
  test("an append moved after the CRM write is refused", () => {
    const src = pristine();
    const APPEND_STMT = "await appendConsentEvents(payload.consent);";
    const CREATE_STMT = "const result = await createLead(payload);";
    assert.ok(src.includes(APPEND_STMT), "the append statement changed shape");
    assert.ok(src.includes(CREATE_STMT), "the CRM write statement changed shape");

    const moved = src
      .replace(APPEND_STMT, "/* append moved below the CRM write */")
      .replace(CREATE_STMT, CREATE_STMT + "\n    " + APPEND_STMT);
    /* The import is untouched — that is the whole point. */
    assert.ok(moved.includes('from "./_lib/consent-ledger.mjs"'));
    assert.ok(moved.indexOf(LEDGER_APPEND_CALL) > moved.indexOf(CRM_WRITE_CALL));

    writeFileSync(LEAD(), moved);
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted an append that happens after the CRM write");
    assert.match(output, /appends to the consent ledger after the CRM write/);
  });

  /* The other half the identifier match would have survived: deleting the
     call while leaving the import behind. */
  test("deleting the append call while keeping the import is refused", () => {
    const src = pristine();
    const removed = src.replace("await appendConsentEvents(payload.consent);", "/* removed */");
    assert.ok(removed.includes("appendConsentEvents"), "the import should still be present");
    assert.ok(!removed.includes(LEDGER_APPEND_CALL), "the call should be gone");

    writeFileSync(LEAD(), removed);
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted an api/lead.js that never appends to the ledger");
    assert.match(output, /nothing appends to the consent ledger/);
  });

  test("removing the durability requirement from the write gate is refused", () => {
    /* Restore lead.js first — this mutation is about hubspot.mjs. */
    writeFileSync(LEAD(), pristine());
    const hubspotPath = join(root, "api", "_lib", "hubspot.mjs");
    const src = readFileSync(join(REPO, "api/_lib/hubspot.mjs"), "utf8");
    const GATE = "const consentOn = consentStateEnabled() && payload.consent?.durable === true;";
    assert.ok(src.includes(GATE), "the consent write gate changed shape");
    writeFileSync(hubspotPath,
      src.replace(GATE, "const consentOn = consentStateEnabled() && Boolean(payload.consent);"));

    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a grant that no longer requires durable evidence");
    assert.match(output, /no longer requires payload\.consent\.durable === true/);
    writeFileSync(hubspotPath, src);
  });
});

/* =====================================================================
   8  ATOMICITY, IDEMPOTENCY AND TIMEOUT
   ===================================================================== */
describe("failure semantics", () => {
  /* One statement, in its own transaction, so a FAILURE cannot leave one of
     the two new rows behind. That is the guarantee worth having: an SMS
     grant recorded with no trace of the voice decision beside it is not a
     state a failed append can produce.

     It is NOT the stronger claim that the table always holds 0 or 2 rows
     for a submission — see the retry test below, where per-row conflict
     resolution deliberately fills a gap rather than refusing to. */
  test("a failing executor appends neither row", async () => {
    const calls = captureExecutor({ fail: new Error("could not connect") });
    await assert.rejects(
      () => appendConsentEvents(evidenceFor({ sms_consent: true }), { env: ENV }),
      (err) => err.token === LEDGER_APPEND_FAILED && err.ledgerFailed === true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.length, LEDGER_COLUMNS.length * 2,
      "a partial statement was sent");
  });

  test("the driver's error text never survives the failure", async () => {
    captureExecutor({ fail: new Error("FATAL: password authentication failed for user \"app\" " + URL_VALUE) });
    try {
      await appendConsentEvents(evidenceFor({}), { env: ENV });
      assert.fail("a driver failure was reported as success");
    } catch (err) {
      assert.ok(!err.message.includes("password"), "the driver message leaked");
      assert.ok(!err.message.includes(URL_VALUE), "the connection string leaked");
      assert.deepEqual(ledgerLogShape(err),
        { ledger_error: LEDGER_APPEND_FAILED, ledger_driver_error: "Error" });
      assert.ok(!JSON.stringify(ledgerLogShape(err)).includes("password"),
        "the driver message reached the log shape");
    }
  });

  /* Replaying one submission produces byte-identical keys and parameters,
     so whatever is already in the ledger is found by its own key. That is
     what deterministic keys are for, and it is the property every retry
     claim below rests on. */
  test("replaying a submission produces the same keys and reports success", async () => {
    const calls = captureExecutor();
    const evidence = evidenceFor({ sms_consent: true });
    const first = await appendConsentEvents(evidence, { env: ENV });
    const second = await appendConsentEvents(evidence, { env: ENV });
    assert.deepEqual(first, second);
    assert.deepEqual(calls[0].params, calls[1].params);
    assert.equal(calls[0].text, calls[1].text);
    /* A FULLY duplicated retry inserts nothing and succeeds: Postgres
       answers it with no rows, which is not an error and is not treated as
       one. Nothing was written and nothing needed to be. */
    assert.deepEqual(await appendConsentEvents(evidence, { env: ENV }), { appended: true, events: 2 });
  });

  /* THE PER-ROW SEMANTICS, stated exactly, because the convenient summary
     ("both rows land together or neither does") is wrong about retries and
     the difference is a healed gap versus a permanent one.

     ON CONFLICT DO NOTHING is evaluated per row. A retry
     against a ledger that already holds ONE of the two rows no-ops that
     one and inserts the MISSING one, converging on the complete pair.
     All-or-nothing on retry would leave the gap forever.

     Asserted here on the statement, which is what this repository can
     honestly prove without a database: the same statement carries both
     rows with independent dedupe keys, and DO NOTHING is per row, so the
     outcome for one row does not depend on the other. Confirmed against a
     real Postgres 16 with this migration and an INSERT-only role: the
     first run inserted 2, a replay inserted 0, and a replay after one row
     was deleted inserted exactly 1. */
  test("the statement lets a retry fill a missing row beside an existing one", async () => {
    const calls = captureExecutor();
    await appendConsentEvents(evidenceFor({ sms_consent: true }), { env: ENV });
    const { text, params } = calls[0];

    /* Per row, and with NO conflict target — see the regression test below
       for why naming one is not available to this role. */
    assert.match(text, /ON CONFLICT DO NOTHING$/);

    /* Two rows, two DIFFERENT keys — so one can conflict while the other
       inserts. If both rows ever shared a key, the second would be
       silently discarded and a submission would be half-recorded on the
       FIRST attempt, which is the failure dedupeKey() refuses outright. */
    const keyIdx = LEDGER_COLUMNS.indexOf("dedupe_key");
    const keys = [params[keyIdx], params[LEDGER_COLUMNS.length + keyIdx]];
    assert.equal(new Set(keys).size, 2, "the two channel rows share a dedupe key");
    assert.deepEqual(keys, [
      `website:${SID}:sms:consent_selected`,
      `website:${SID}:ai_voice:consent_not_selected`,
    ]);
  });

  /* A hanging evidence write must never become a hanging lead. */
  test("a slow executor is abandoned, and the abort is signalled", async () => {
    const calls = captureExecutor({ delayMs: 200 });
    await assert.rejects(
      () => appendConsentEvents(evidenceFor({}), { env: ENV, timeoutMs: 20 }),
      (err) => err.token === LEDGER_TIMEOUT && err.ledgerFailed === true);
    assert.equal(calls[0].opts.signal.aborted, true, "the in-flight request was not aborted");
  });
});
