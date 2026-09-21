/* db/004 — the re-opt-in readiness lookup, against a REAL PostgreSQL.
   =====================================================================
   CLAUDE.md rule 14. This function decides whether a previous STOP may be
   superseded, and every rule that makes it safe is a SQL predicate: a
   strict inequality, a second clock, a lane scope, a freshness window, a
   privilege grant. None of those can be proven by a mock — they are owned
   by PostgreSQL, so they are tested against PostgreSQL.

   NO MOCKS AND NO DRIVER. The application talks to Neon over HTTP with
   @neondatabase/serverless, which does not speak to a local TCP cluster,
   and adding `pg` would be a new PRODUCTION dependency for a test-only
   need. So these drive `psql` as a subprocess — the same technique
   tests/unsuppression-fold.test.mjs uses, and the same cluster CI provides.

   HOW THIS BEHAVES WHEN THERE IS NO DATABASE
   -----------------------------------------------------------------
   `CST_TEST_PG_URL` ABSENT  -> every test SKIPS, loudly.
   `CST_TEST_PG_URL` PRESENT -> they RUN, and a connection failure is a
                               FAILURE, never a skip.

   CI sets the variable unconditionally, so CI cannot skip.

   WHAT THIS FILE APPLIES. db/001 through db/004 in order, with the role
   placeholders substituted exactly as an operator would — so it also proves
   db/004 APPLIES against a database already carrying db/003. It owns its
   cluster and drops what it created.
   ===================================================================== */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL_VAR = "CST_TEST_PG_URL";
const CONN = process.env[URL_VAR];
const skip = CONN ? false : `${URL_VAR} is not set — no real PostgreSQL to test against`;

if (skip) {
  console.warn(`\n!! ${skip}.\n` +
    "!! db/004's readiness rules and privilege matrix were NOT exercised in this run.\n" +
    "!! Set it to a psql-compatible conninfo for an owner of a scratch cluster.\n");
}

const APP = "consent_ledger_app";
const SENDER = "consent_ledger_sender";
const OPERATOR = "consent_ledger_operator";
const REOPTIN = "consent_ledger_reoptin";

/* The application's own window, restated as a literal rather than imported:
   if api/_lib/reoptin.mjs changes it, the case below that relies on 14 days
   should be read again rather than silently following. */
const WINDOW = 14 * 24 * 60 * 60;

let dir;

function sql(statement) {
  const file = join(dir, "stmt.sql");
  writeFileSync(file, statement);
  try {
    return execFileSync("psql", [CONN, "-v", "ON_ERROR_STOP=1", "-X", "-q",
      "--no-align", "--tuples-only", "--field-separator=|", "-f", file],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    const e = new Error(String(err.stderr || err.stdout || err.message).trim());
    e.pgFailed = true;
    throw e;
  }
}

/** Run one statement AS another role. RESET ROLE is not optional. */
function asRole(role, statement) {
  try {
    sql(`SET ROLE ${role};\n${statement}\nRESET ROLE;`);
    return { ok: true, error: null };
  } catch (err) {
    sql("RESET ROLE;");
    return { ok: false, error: err.message };
  }
}

/** Refused, and refused for the RIGHT reason — an assertion satisfied by a
 *  syntax error proves nothing. */
function assertDenied(role, statement, what) {
  const r = asRole(role, statement);
  assert.equal(r.ok, false, `${role} was ALLOWED to ${what}`);
  assert.match(r.error, /permission denied/i,
    `${role} failed to ${what} but not with a permission error: ${r.error}`);
}

const lit = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

/* recorded_at is a server DEFAULT the application never supplies. These
   tests set it explicitly because db/004's ordering rules are ABOUT
   recorded_at, and a test that cannot control it cannot exercise them.
   Only the OWNER can; no application role is given the ability. */
function event({
  phone, at, recorded, channel, type, reason = null, key,
  source = "twilio", sourceId = null, version = null, formType = null,
  page = null, submission = null,
}) {
  sql(`INSERT INTO communication_consent_events
         (occurred_at, recorded_at, channel, event_type, phone_e164, source,
          source_event_id, dedupe_key, reason_code, submission_id, form_type,
          page_path, consent_copy_version)
       VALUES (${lit(at)}, ${lit(recorded || at)}, ${lit(channel)}, ${lit(type)},
               ${lit(phone)}, ${lit(source)}, ${lit(sourceId || key)}, ${lit(key)},
               ${lit(reason)}, ${lit(submission)}, ${lit(formType)}, ${lit(page)},
               ${lit(version)});`);
}

const stop = (o) => event({ ...o, channel: o.channel || "sms", type: "suppressed",
                            reason: "stop_keyword" });
const consent = (o) => event({
  ...o, channel: o.channel || "sms", type: o.type || "consent_selected",
  source: o.source || "website",
  version: o.version || "CST_SMS_CONSENT_2026_09_V1",
  formType: o.formType || "home_value", page: o.page || "/home-value",
  submission: o.submission || o.key.split(":")[1],
});
const laneClear = (o) => event({
  ...o, channel: o.channel || "sms", type: "unsuppressed", reason: "consumer_request",
});

/** get_reoptin_readiness as the role that actually calls it. */
function readiness(phone, { channel = "sms", window = WINDOW, role = REOPTIN } = {}) {
  const out = sql(`SET ROLE ${role};
    SELECT coalesce(blocked_sms_at::text,'-')       || '|' ||
           coalesce(blocked_ai_voice_at::text,'-')  || '|' ||
           coalesce(blocked_all_at::text,'-')       || '|' ||
           coalesce(consent_dedupe_key,'-')         || '|' ||
           coalesce(consent_occurred_at::text,'-')  || '|' ||
           coalesce(consent_version,'-')            || '|' ||
           coalesce(consent_form_type,'-')          || '|' ||
           coalesce(consent_page_path,'-')          || '|' ||
           coalesce(consent_submission_id,'-')
      FROM get_reoptin_readiness('${phone}', '${channel}', ${window === null ? "NULL" : window});
    RESET ROLE;`).split("\n").filter(Boolean);
  assert.equal(out.length, 1,
    `get_reoptin_readiness returned ${out.length} rows — it must always return exactly one`);
  const [smsAt, voiceAt, allAt, key, at, version, formType, page, submission] =
    out[0].split("|");
  return { smsAt, voiceAt, allAt, key, at, version, formType, page, submission };
}

/** The send-time answer, as gate 8's own caller sees it. */
const blockedLanes = (phone) =>
  sql(`SET ROLE ${SENDER};
       SELECT channel FROM get_suppression_state('${phone}') ORDER BY 1;
       RESET ROLE;`).split("\n").filter(Boolean);

/** Every row this number has, ever. Owner only — the point is that history
 *  is still there. */
const allRows = (phone) =>
  sql(`SELECT event_type || '/' || dedupe_key FROM communication_consent_events
        WHERE phone_e164 = '${phone}' ORDER BY recorded_at, dedupe_key;`)
    .split("\n").filter(Boolean);

/** Relative to now, so the freshness window is exercised against the
 *  DATABASE's clock rather than this process's. */
const agoDays = (d) => `now() - interval '${d} days'`;

function eventRelative({ phone, atExpr, recordedExpr, channel, type, reason = null,
                         key, source = "twilio", version = null, formType = null,
                         page = null, submission = null }) {
  sql(`INSERT INTO communication_consent_events
         (occurred_at, recorded_at, channel, event_type, phone_e164, source,
          source_event_id, dedupe_key, reason_code, submission_id, form_type,
          page_path, consent_copy_version)
       VALUES (${atExpr}, ${recordedExpr || atExpr}, ${lit(channel)}, ${lit(type)},
               ${lit(phone)}, ${lit(source)}, ${lit(key)}, ${lit(key)},
               ${lit(reason)}, ${lit(submission)}, ${lit(formType)}, ${lit(page)},
               ${lit(version)});`);
}

describe("db/004 — re-opt-in readiness, against a real PostgreSQL", { skip }, () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cst-db004-"));

    try { execFileSync("psql", ["--version"], { stdio: "pipe" }); }
    catch {
      assert.fail("psql is not on PATH, but " + URL_VAR + " is set. " +
        "These tests drive a real PostgreSQL through psql and cannot run without it.");
    }
    try { sql("SELECT 1;"); }
    catch (err) {
      assert.fail(`${URL_VAR} is set but the cluster did not answer: ${err.message}`);
    }

    /* Idempotent teardown first, so a rerun against a dirty cluster is clean
       rather than confusing. */
    sql(`DROP FUNCTION IF EXISTS get_reoptin_readiness(text, text, integer);
         DROP FUNCTION IF EXISTS get_active_blocks(text);
         DROP FUNCTION IF EXISTS get_suppression_state(text);
         DROP FUNCTION IF EXISTS _active_consent_blocks(text);
         DROP TABLE IF EXISTS communication_consent_events;`);
    for (const r of [APP, SENDER, OPERATOR, REOPTIN])
      sql(`DO $$BEGIN
             IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN
               EXECUTE 'DROP OWNED BY ${r}'; EXECUTE 'DROP ROLE ${r}';
             END IF;
           END$$;`);
    sql(`CREATE ROLE ${APP} LOGIN PASSWORD 'pw_app';`);

    const migration = (file, subs) => {
      let text = readFileSync(join(REPO, "db", file), "utf8");
      for (const [from, to] of subs) text = text.split(from).join(to);
      return text;
    };
    sql(migration("001_communication_consent_events.sql", [["<application_role>", APP]]));
    sql(migration("002_suppression_lookup.sql",
      [["<sender_role>", SENDER], ["<sender_password>", "pw_sender"]]));
    sql(migration("003_unsuppression_lookup.sql",
      [["<operator_role>", OPERATOR], ["<operator_password>", "pw_operator"],
       ["<sender_role>", SENDER]]));
    /* THE MIGRATION UNDER TEST, applied on top of a database that already
       carries db/003 — which is the only way it will ever be applied. */
    sql(migration("004_website_reoptin.sql",
      [["<reoptin_role>", REOPTIN], ["<reoptin_password>", "pw_reoptin"]]));
  });

  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  /* ===================================================================
     1  THE SHAPE OF THE ANSWER
     =================================================================== */

  test("an unknown number is exactly one all-null row, not zero rows", () => {
    const r = readiness("+15555554000");
    assert.deepEqual(r, {
      smsAt: "-", voiceAt: "-", allAt: "-", key: "-", at: "-",
      version: "-", formType: "-", page: "-", submission: "-",
    });
  });

  /* ===================================================================
     2  THE HAPPY PATH, AND THE WHOLE SEQUENCE
     =================================================================== */

  test("STOP -> fresh website consent -> readiness names the consent", () => {
    const p = "+15555554001";
    stop({ phone: p, at: "2026-09-18T09:00:00Z", key: "twilio:SM1:sms:suppressed" });
    consent({ phone: p, at: "2026-09-20T12:00:00Z", key: "website:sub1:sms:consent_selected" });

    const r = readiness(p);
    assert.equal(r.key, "website:sub1:sms:consent_selected");
    assert.match(r.smsAt, /2026-09-18 09:00:00/);
    assert.equal(r.allAt, "-");
    assert.equal(r.version, "CST_SMS_CONSENT_2026_09_V1");
    assert.equal(r.formType, "home_value");
    assert.equal(r.page, "/home-value");
    assert.equal(r.submission, "sub1");

    /* STILL BLOCKED. A readiness answer clears nothing: the lane opens only
       when an `unsuppressed` row is APPENDED. */
    assert.deepEqual(blockedLanes(p), ["sms"]);
  });

  test("the later append-only clearance is what unblocks, and only it", () => {
    const p = "+15555554002";
    stop({ phone: p, at: "2026-09-18T09:00:00Z", key: "twilio:SM2:sms:suppressed" });
    consent({ phone: p, at: "2026-09-20T12:00:00Z", key: "website:sub2:sms:consent_selected" });
    assert.deepEqual(blockedLanes(p), ["sms"]);

    laneClear({ phone: p, at: "2026-09-21T10:00:00Z", key: "twilio:SM3:sms:unsuppressed" });

    /* Gate 8's own question now answers "nothing blocks this number". */
    assert.deepEqual(blockedLanes(p), []);
    /* And the readiness lookup reports the lane open, so a second START
       cannot write a clearance for a lane that is not blocked. */
    assert.equal(readiness(p).smsAt, "-");

    /* THE OLD STOP IS STILL THERE. Superseded, never erased — the whole
       point of an append-only ledger. */
    const rows = allRows(p);
    assert.ok(rows.includes("suppressed/twilio:SM2:sms:suppressed"),
      `the STOP row was lost: ${rows.join(", ")}`);
    assert.ok(rows.includes("unsuppressed/twilio:SM3:sms:unsuppressed"));
    assert.ok(rows.includes("consent_selected/website:sub2:sms:consent_selected"));
  });

  test("a STOP after a clearance blocks again", () => {
    const p = "+15555554003";
    stop({ phone: p, at: "2026-09-18T09:00:00Z", key: "twilio:SM4:sms:suppressed" });
    consent({ phone: p, at: "2026-09-19T12:00:00Z", key: "website:sub3:sms:consent_selected" });
    laneClear({ phone: p, at: "2026-09-20T10:00:00Z", key: "twilio:SM5:sms:unsuppressed" });
    assert.deepEqual(blockedLanes(p), []);

    stop({ phone: p, at: "2026-09-22T08:00:00Z", key: "twilio:SM6:sms:suppressed" });
    assert.deepEqual(blockedLanes(p), ["sms"]);
    /* AND THE OLD CONSENT NO LONGER QUALIFIES. It pre-dates the new refusal,
       so the number cannot be re-cleared by the submission that cleared it
       the first time. */
    assert.equal(readiness(p).key, "-");
  });

  /* THE RACE THE RECONCILIATION CANNOT SERIALIZE, AND WHY IT IS SAFE.
     The readiness read and the clearance append are two statements, not one
     transaction. A STOP can land between them. Nothing in the application
     can prevent that — so what matters is which way db/003's fold resolves
     it, and it resolves toward the block, on either clock:

       * a STOP RECEIVED AFTER the START carries a LATER occurred_at than the
         clearance (whose occurred_at is the START's receipt time), so
         `e.occurred_at >= c.cleared_at` keeps it;
       * a STOP DELIVERED LATE but sent earlier carries an EARLIER
         occurred_at and a LATER recorded_at, so `e.recorded_at >=
         c.cleared_recorded_at` keeps it.

     Both are measured here rather than argued. */
  test("a STOP racing the clearance still blocks — by event time", () => {
    const p = "+15555554050";
    stop({ phone: p, at: "2026-09-18T09:00:00Z", key: "twilio:SM50:sms:suppressed" });
    consent({ phone: p, at: "2026-09-19T12:00:00Z", key: "website:sub50:sms:consent_selected" });
    /* The clearance, as the webhook would write it: occurred_at is the
       START's receipt time, recorded_at is when the INSERT lands. */
    laneClear({ phone: p, at: "2026-09-20T10:00:00Z", recorded: "2026-09-20T10:00:02Z",
                key: "twilio:SM51:sms:unsuppressed" });
    /* A STOP received a second after the START, recorded a second before the
       clearance's INSERT landed. */
    stop({ phone: p, at: "2026-09-20T10:00:01Z", recorded: "2026-09-20T10:00:01Z",
           key: "twilio:SM52:sms:suppressed" });
    assert.deepEqual(blockedLanes(p), ["sms"],
      "a STOP that arrived after the START was cleared by it");
  });

  test("a STOP racing the clearance still blocks — by ingest time", () => {
    const p = "+15555554051";
    stop({ phone: p, at: "2026-09-18T09:00:00Z", key: "twilio:SM53:sms:suppressed" });
    consent({ phone: p, at: "2026-09-19T12:00:00Z", key: "website:sub51:sms:consent_selected" });
    laneClear({ phone: p, at: "2026-09-20T10:00:00Z", recorded: "2026-09-20T10:00:02Z",
                key: "twilio:SM54:sms:unsuppressed" });
    /* Sent BEFORE the START, delivered after the clearance landed. */
    stop({ phone: p, at: "2026-09-20T09:59:00Z", recorded: "2026-09-20T10:00:05Z",
           key: "twilio:SM55:sms:suppressed" });
    assert.deepEqual(blockedLanes(p), ["sms"],
      "a delayed STOP was discarded by a clearance recorded before it arrived");
  });

  /* ===================================================================
     3  THE RULES THAT KEEP A STOP AUTHORITATIVE
     =================================================================== */

  test("a consent made BEFORE the STOP is not a re-opt-in", () => {
    const p = "+15555554010";
    consent({ phone: p, at: "2026-09-10T12:00:00Z", key: "website:sub10:sms:consent_selected" });
    stop({ phone: p, at: "2026-09-18T09:00:00Z", key: "twilio:SM10:sms:suppressed" });
    const r = readiness(p);
    assert.match(r.smsAt, /2026-09-18/);
    assert.equal(r.key, "-", "a submission made before the refusal was read as a re-opt-in");
  });

  /* THE TIE. db/003 resolves its ties toward more blocking; so must this. */
  test("a consent at the EXACT instant of the STOP does not supersede it", () => {
    const p = "+15555554011";
    stop({ phone: p, at: "2026-09-18T09:00:00Z", key: "twilio:SM11:sms:suppressed" });
    consent({ phone: p, at: "2026-09-18T09:00:00Z", key: "website:sub11:sms:consent_selected" });
    assert.equal(readiness(p).key, "-", "an exact timestamp tie cleared the block");
  });

  /* THE SECOND CLOCK — the delayed or redelivered STOP. A webhook can land
     AFTER a consent while carrying an EARLIER occurred_at. Folding on event
     time alone would silently discard a real, later-arriving opt-out. */
  test("a STOP recorded after a consent still outranks it, whatever its event time", () => {
    const p = "+15555554012";
    consent({ phone: p, at: "2026-09-20T12:00:00Z", recorded: "2026-09-20T12:00:01Z",
              key: "website:sub12:sms:consent_selected" });
    /* Event time EARLIER than the consent; ingest time LATER. */
    stop({ phone: p, at: "2026-09-19T09:00:00Z", recorded: "2026-09-21T09:00:00Z",
           key: "twilio:SM12:sms:suppressed" });
    assert.deepEqual(blockedLanes(p), ["sms"]);
    assert.equal(readiness(p).key, "-",
      "a consent recorded before a delayed STOP arrived was read as post-dating it");
  });

  /* TEST 7 — a stale consent cannot unsuppress. Measured against the
     DATABASE's clock, which is where the rule lives. */
  test("a consent older than the freshness window does not qualify", () => {
    const p = "+15555554013";
    eventRelative({ phone: p, atExpr: agoDays(40), channel: "sms", type: "suppressed",
                    reason: "stop_keyword", key: "twilio:SM13:sms:suppressed" });
    eventRelative({ phone: p, atExpr: agoDays(30), channel: "sms",
                    type: "consent_selected", source: "website",
                    key: "website:sub13:sms:consent_selected",
                    version: "v1", formType: "home_value", page: "/home-value",
                    submission: "sub13" });
    assert.equal(readiness(p).key, "-", "a 30-day-old consent qualified inside a 14-day window");
    /* The same rows, with a window wide enough to admit them. The rule is
       the window, not a missing row. */
    assert.equal(readiness(p, { window: 60 * 24 * 60 * 60 }).key,
      "website:sub13:sms:consent_selected");
  });

  test("a null or negative window matches nothing", () => {
    const p = "+15555554014";
    stop({ phone: p, at: "2026-09-18T09:00:00Z", key: "twilio:SM14:sms:suppressed" });
    eventRelative({ phone: p, atExpr: "now()", channel: "sms", type: "consent_selected",
                    source: "website", key: "website:sub14:sms:consent_selected",
                    version: "v1", submission: "sub14" });
    assert.equal(readiness(p).key, "website:sub14:sms:consent_selected");
    assert.equal(readiness(p, { window: null }).key, "-", "a NULL window admitted a consent");
    assert.equal(readiness(p, { window: -1 }).key, "-", "a negative window admitted a consent");
  });

  test("a future-dated consent cannot evidence a decision that has not happened", () => {
    const p = "+15555554015";
    eventRelative({ phone: p, atExpr: agoDays(1), channel: "sms", type: "suppressed",
                    reason: "stop_keyword", key: "twilio:SM15:sms:suppressed" });
    eventRelative({ phone: p, atExpr: "now() + interval '2 days'", channel: "sms",
                    type: "consent_selected", source: "website",
                    key: "website:sub15:sms:consent_selected",
                    version: "v1", submission: "sub15" });
    assert.equal(readiness(p).key, "-");
  });

  /* ===================================================================
     4  WHAT IS AND IS NOT A CONSENT
     =================================================================== */

  test("consent_not_selected — the record of NOT ticking — is never a grant", () => {
    const p = "+15555554020";
    stop({ phone: p, at: "2026-09-18T09:00:00Z", key: "twilio:SM20:sms:suppressed" });
    consent({ phone: p, at: "2026-09-20T12:00:00Z", type: "consent_not_selected",
              key: "website:sub20:sms:consent_not_selected" });
    assert.equal(readiness(p).key, "-");
  });

  test("only a website submission can evidence a disclosure", () => {
    const p = "+15555554021";
    stop({ phone: p, at: "2026-09-18T09:00:00Z", key: "twilio:SM21:sms:suppressed" });
    for (const source of ["twilio", "operator", "retell"])
      event({ phone: p, at: "2026-09-20T12:00:00Z", channel: "sms",
              type: "consent_selected", source,
              key: `${source}:sub21:sms:consent_selected`, version: "v1" });
    assert.equal(readiness(p).key, "-");
  });

  /* TEST 8 — SMS AND AI VOICE ARE COMPLETELY SEPARATE. */
  test("a voice consent does not answer for the SMS lane, or the reverse", () => {
    const p = "+15555554022";
    stop({ phone: p, at: "2026-09-18T09:00:00Z", key: "twilio:SM22:sms:suppressed" });
    stop({ phone: p, at: "2026-09-18T09:00:00Z", channel: "ai_voice",
           key: "twilio:SM22:ai_voice:suppressed" });
    consent({ phone: p, at: "2026-09-20T12:00:00Z", channel: "ai_voice",
              key: "website:sub22:ai_voice:consent_selected" });

    const sms = readiness(p, { channel: "sms" });
    assert.match(sms.smsAt, /2026-09-18/);
    assert.match(sms.voiceAt, /2026-09-18/);
    assert.equal(sms.key, "-", "a voice consent qualified for the SMS lane");

    /* The voice lane's own answer exists — the function is lane-generic —
       and the application refuses to act on it. */
    assert.equal(readiness(p, { channel: "ai_voice" }).key,
      "website:sub22:ai_voice:consent_selected");
  });

  /* TEST 6 — consent binds to the line it was given for. */
  test("another number's consent is invisible here", () => {
    const p = "+15555554023";
    const other = "+15555554024";
    stop({ phone: p, at: "2026-09-18T09:00:00Z", key: "twilio:SM23:sms:suppressed" });
    consent({ phone: other, at: "2026-09-20T12:00:00Z",
              key: "website:sub23:sms:consent_selected" });
    assert.equal(readiness(p).key, "-");
    /* And the other number is not blocked at all. */
    assert.equal(readiness(other).smsAt, "-");
  });

  test("the newest qualifying consent is the one named", () => {
    const p = "+15555554025";
    stop({ phone: p, at: "2026-09-18T09:00:00Z", key: "twilio:SM25:sms:suppressed" });
    consent({ phone: p, at: "2026-09-19T12:00:00Z", key: "website:subA:sms:consent_selected" });
    consent({ phone: p, at: "2026-09-20T12:00:00Z", key: "website:subB:sms:consent_selected" });
    const r = readiness(p);
    assert.equal(r.key, "website:subB:sms:consent_selected");
    assert.match(r.at, /2026-09-20/);
  });

  /* ===================================================================
     5  THE DOMINATING LANE
     =================================================================== */

  test("a global do-not-contact is reported so the caller can refuse", () => {
    const p = "+15555554030";
    stop({ phone: p, at: "2026-09-18T09:00:00Z", channel: "all",
           key: "twilio:SM30:all:suppressed" });
    consent({ phone: p, at: "2026-09-20T12:00:00Z", key: "website:sub30:sms:consent_selected" });
    const r = readiness(p);
    /* THE FUNCTION REPORTS, THE APPLICATION DECIDES. db/004 is lane-generic
       and says what is true: the `all` lane is blocked, and this consent
       does post-date that refusal. It is api/_lib/reoptin.mjs that refuses
       the transition outright while `blocked_all_at` is set — a global
       do-not-contact spoke about every channel and a ticked SMS box does not
       answer it. tests/reoptin.test.mjs pins that refusal (GLOBAL_BLOCK);
       what matters HERE is that the fact reaches the caller at all, because
       a function that returned only the lane it was asked about would hide
       it. */
    assert.match(r.allAt, /2026-09-18/, "the global lane was hidden from the caller");
    assert.equal(r.key, "website:sub30:sms:consent_selected");
    assert.deepEqual(blockedLanes(p), ["all"]);
  });

  test("an SMS consent cannot step over a LATER global refusal", () => {
    const p = "+15555554031";
    stop({ phone: p, at: "2026-09-18T09:00:00Z", key: "twilio:SM31:sms:suppressed" });
    consent({ phone: p, at: "2026-09-19T12:00:00Z", key: "website:sub31:sms:consent_selected" });
    assert.equal(readiness(p).key, "website:sub31:sms:consent_selected");
    stop({ phone: p, at: "2026-09-20T09:00:00Z", channel: "all",
           key: "twilio:SM31b:all:suppressed" });
    assert.equal(readiness(p).key, "-",
      "a consent predating a global do-not-contact still qualified");
  });

  /* ===================================================================
     6  IDEMPOTENCY
     =================================================================== */

  test("the same clearance written twice inserts once", () => {
    const p = "+15555554040";
    stop({ phone: p, at: "2026-09-18T09:00:00Z", key: "twilio:SM40:sms:suppressed" });
    const insert = `INSERT INTO communication_consent_events
        (occurred_at, channel, event_type, phone_e164, source, source_event_id,
         dedupe_key, reason_code, metadata, schema_version)
      VALUES ('2026-09-21T10:00:00Z','sms','unsuppressed','${p}','twilio','SM41',
              'twilio:SM41:sms:unsuppressed','consumer_request',
              '{"reoptin_confirmation":"twilio_start"}'::jsonb, 1)
      ON CONFLICT DO NOTHING;`;
    /* As the role that actually writes it — which holds INSERT and no
       SELECT, so the bare ON CONFLICT (no target) is the only form
       available. Naming a target would need SELECT and fail with 42501. */
    assert.equal(asRole(REOPTIN, insert).ok, true);
    assert.deepEqual(blockedLanes(p), []);
    assert.equal(asRole(REOPTIN, insert).ok, true, "the replay raised instead of no-opping");
    assert.equal(
      sql(`SELECT count(*) FROM communication_consent_events
            WHERE dedupe_key = 'twilio:SM41:sms:unsuppressed';`).trim(), "1");
  });

  /* ===================================================================
     7  THE PRIVILEGE MATRIX
     =================================================================== */

  test("the hardening landed", () => {
    const row = sql(`SELECT prosecdef::text || '|' || coalesce(array_to_string(proconfig, ','), '-')
                       FROM pg_proc WHERE proname = 'get_reoptin_readiness';`).trim();
    const [secdef, config] = row.split("|");
    assert.equal(secdef, "true", "the readiness function is not SECURITY DEFINER");
    assert.match(config, /search_path=pg_catalog, public/,
      "the search_path hardening is missing — a caller could shadow the table");
  });

  test("PUBLIC does not hold EXECUTE", () => {
    const acl = sql(`SELECT coalesce(array_to_string(proacl, ','), '-')
                       FROM pg_proc WHERE proname = 'get_reoptin_readiness';`).trim();
    assert.ok(!/(^|,)=X\//.test(acl), `PUBLIC holds EXECUTE: ${acl}`);
    assert.match(acl, new RegExp(`${REOPTIN}=X/`), `the re-opt-in role has no EXECUTE: ${acl}`);
  });

  /* THE CREDENTIAL SEPARATION db/002 states, still standing. */
  test("no other application role may ask the readiness question", () => {
    for (const role of [APP, SENDER, OPERATOR])
      assertDenied(role, `SELECT * FROM get_reoptin_readiness('+15555550100','sms',${WINDOW});`,
        "call get_reoptin_readiness");
  });

  test("the re-opt-in role can append and ask, and can do nothing else", () => {
    assert.equal(
      asRole(REOPTIN, `SELECT * FROM get_reoptin_readiness('+15555550100','sms',${WINDOW});`).ok,
      true, "the re-opt-in role cannot call its own function");

    assertDenied(REOPTIN, "SELECT count(*) FROM communication_consent_events;",
      "read the ledger table");
    assertDenied(REOPTIN, "UPDATE communication_consent_events SET channel = 'x';",
      "update the ledger");
    assertDenied(REOPTIN, "DELETE FROM communication_consent_events;",
      "delete from the ledger");
    assertDenied(REOPTIN, "TRUNCATE communication_consent_events;", "truncate the ledger");
    /* IT CORRECTS NOTHING, so it has no use for whole blocking rows. */
    assertDenied(REOPTIN, "SELECT * FROM get_active_blocks('+15555550100');",
      "read whole blocking rows");
    /* And it is not the sender. */
    assertDenied(REOPTIN, "SELECT * FROM get_suppression_state('+15555550100');",
      "run the send-time lookup");
    /* The internal fold is reachable from inside the wrappers and from
       nowhere else. */
    assertDenied(REOPTIN, "SELECT * FROM _active_consent_blocks('+15555550100');",
      "call the internal fold directly");
  });

  test("db/002's and db/003's own matrix is unchanged by this migration", () => {
    assertDenied(APP, "SELECT * FROM get_suppression_state('+15555550100');",
      "run the send-time lookup as the website role");
    assertDenied(SENDER, "SELECT count(*) FROM communication_consent_events;",
      "read the ledger as the sender");
    assertDenied(SENDER, "SELECT * FROM get_active_blocks('+15555550100');",
      "read whole blocking rows as the sender");
    assert.equal(
      asRole(SENDER, "SELECT * FROM get_suppression_state('+15555550100');").ok, true);
    assert.equal(
      asRole(OPERATOR, "SELECT * FROM get_active_blocks('+15555550100');").ok, true);
  });
});
