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
  appendConsentEvents, ledgerLogShape, _setExecutor, _resetExecutor,
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
    /* An unclassified driver error is still classified, never passed through. */
    assert.deepEqual(ledgerLogShape(new Error("relation does not exist")),
      { ledger_error: LEDGER_APPEND_FAILED });
    assert.deepEqual(ledgerLogShape(undefined), { ledger_error: LEDGER_APPEND_FAILED });
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
  test("one parameterised multi-row INSERT, with the conflict clause", async () => {
    const calls = captureExecutor();
    const res = await appendConsentEvents(evidenceFor({ sms_consent: true }), { env: ENV });
    assert.deepEqual(res, { appended: true, events: 2 });
    assert.equal(calls.length, 1, "the two channel rows were not written in one statement");

    const { text, params } = calls[0];
    assert.equal((text.match(/INSERT INTO/g) || []).length, 1);
    assert.match(text, new RegExp("INSERT INTO " + LEDGER_TABLE));
    assert.match(text, /ON CONFLICT \(dedupe_key\) DO NOTHING/);
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
    /* Append-only is the grant. UPDATE, DELETE and TRUNCATE are not in it,
       and no sequence grant is needed by a uuid default. */
    assert.match(sql, /GRANT INSERT, SELECT ON communication_consent_events/);
    const grants = sql.split("\n").filter((l) => /^\s*GRANT\b/.test(l)).join("\n");
    for (const forbidden of ["UPDATE", "DELETE", "TRUNCATE", "SEQUENCE", "ALL"])
      assert.ok(!grants.includes(forbidden), `the migration grants ${forbidden}`);
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
  /* One statement, so both rows land or neither does. A half-recorded
     submission — an SMS grant with no record of the voice decision beside
     it — is not a state this system can be in. */
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
      assert.deepEqual(ledgerLogShape(err), { ledger_error: LEDGER_APPEND_FAILED });
    }
  });

  /* Replaying one submission produces byte-identical keys, so the second
     attempt is absorbed by ON CONFLICT DO NOTHING and reported as success.
     That is what deterministic keys are for. */
  test("replaying a submission produces the same keys and reports success", async () => {
    const calls = captureExecutor();
    const evidence = evidenceFor({ sms_consent: true });
    const first = await appendConsentEvents(evidence, { env: ENV });
    const second = await appendConsentEvents(evidence, { env: ENV });
    assert.deepEqual(first, second);
    assert.deepEqual(calls[0].params, calls[1].params);
    assert.equal(calls[0].text, calls[1].text);
    /* Postgres answers a fully-conflicting insert with no rows. That is a
       success, not an error. */
    assert.deepEqual(await appendConsentEvents(evidence, { env: ENV }), { appended: true, events: 2 });
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
