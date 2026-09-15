/* db/003 — the two-clearance-kind fold, against a REAL PostgreSQL.
   =====================================================================
   CLAUDE.md rule 14: when a claim depends on behaviour owned by
   Postgres/Neon, the strongest evidence is a test at the lowest practical
   real boundary — "a real role against a real database" for privileges,
   and a real server for SQL semantics. The approved design said plainly
   that its SQL had been executed against NOTHING; this file is what
   changes that, and it found two fail-open defects in that SQL on the
   first run (see FINDING A and FINDING B below).

   NO MOCKS HERE, AND NO DRIVER EITHER. The application talks to Neon over
   HTTP with @neondatabase/serverless, which does not speak to a local
   TCP cluster; adding `pg` would be a new PRODUCTION dependency for a
   test-only need. So these drive `psql` as a subprocess. That is a real
   PostgreSQL parsing and executing the real migration text.

   HOW THIS BEHAVES WHEN THERE IS NO DATABASE
   -----------------------------------------------------------------
   `CST_TEST_PG_URL` ABSENT  -> every test SKIPS, loudly. A developer
                               without a cluster is not told these passed.
   `CST_TEST_PG_URL` PRESENT -> they RUN, and a connection failure is a
                               FAILURE, never a skip.

   That asymmetry is deliberate. A test that silently skips when it was
   supposed to run is the vacuous guard this repository has paid for three
   times, so CI sets the variable and therefore cannot skip.

   WHAT THIS FILE APPLIES. db/001, db/002 and db/003 in order, with the
   role placeholders substituted exactly as an operator would — so it also
   proves the migration APPLIES, that CREATE OR REPLACE accepts db/003's
   body against db/002's live function, and that the contract did not
   drift. It owns its cluster and drops what it created.
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

/* A SKIPPED SUITE REPORTS "tests 0", WHICH IS INVISIBLE inside `npm test`'s
   aggregate across every file. Silence is how a guard stops guarding, so say
   it out loud. CI sets the variable, so CI can never take this branch — and
   if the variable IS set, a connection failure below is a FAILURE, not a
   skip. */
if (skip) {
  console.warn(`\n!! ${skip}.\n` +
    "!! db/003's fold and privilege matrix were NOT exercised in this run.\n" +
    "!! Set it to a psql-compatible conninfo for an owner of a scratch cluster.\n");
}

const OWNER = "pgowner";
const APP = "consent_ledger_app";
const SENDER = "consent_ledger_sender";
const OPERATOR = "consent_ledger_operator";

let dir;

/** Run SQL as the owner. Throws with the server's message on error. */
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

/** Rows as arrays of column strings. */
const rows = (statement) =>
  sql(statement).split("\n").filter(Boolean).map((line) => line.split("|"));

/** Run one statement AS another role. db/002's own verification block
 *  sanctions SET ROLE for exactly this, and RESET ROLE is not optional:
 *  without it every later statement silently runs as the wrong role. */
function asRole(role, statement) {
  try {
    sql(`SET ROLE ${role};\n${statement}\nRESET ROLE;`);
    return { ok: true, error: null };
  } catch (err) {
    sql("RESET ROLE;");
    return { ok: false, error: err.message };
  }
}

/** Assert a role is refused, and refused for the RIGHT reason — an
 *  assertion that passes on a syntax error proves nothing. */
function assertDenied(role, statement, what) {
  const r = asRole(role, statement);
  assert.equal(r.ok, false, `${role} was ALLOWED to ${what}`);
  assert.match(r.error, /permission denied/i,
    `${role} failed to ${what} but not with a permission error: ${r.error}`);
}

/* ---- inserting events -------------------------------------------------
   recorded_at is a server DEFAULT the application never supplies. These
   tests set it explicitly because the fold's ordering rules are ABOUT
   recorded_at, and a test that cannot control it cannot exercise them.
   Only the OWNER can do this; no application role is given the ability. */
function event({ phone, at, recorded, channel, type, reason = null,
                 key, source = "twilio", sourceId = null, metadata = null }) {
  const lit = (v) => (v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
  sql(`INSERT INTO communication_consent_events
         (occurred_at, recorded_at, channel, event_type, phone_e164, source,
          source_event_id, dedupe_key, reason_code, metadata)
       VALUES (${lit(at)}, ${lit(recorded || at)}, ${lit(channel)}, ${lit(type)},
               ${lit(phone)}, ${lit(source)}, ${lit(sourceId || key)}, ${lit(key)},
               ${lit(reason)}, ${metadata === null ? "'{}'::jsonb" : `${lit(metadata)}::jsonb`});`);
}

const block = (o) => event({ ...o, type: o.type || "suppressed" });
const laneClear = (o) => event({ ...o, type: "unsuppressed", reason: "consumer_request" });
const invalidate = (o) => event({
  ...o, type: "unsuppressed", reason: "recorded_in_error",
  metadata: JSON.stringify({ invalidates: o.invalidates }),
});

/** get_suppression_state as the sender — the real send-time caller. */
const state = (phone) => {
  const out = sql(`SET ROLE ${SENDER};
    SELECT channel || '@' || suppressed_at FROM get_suppression_state('${phone}') ORDER BY 1;
    RESET ROLE;`);
  return out.split("\n").filter(Boolean);
};

/** Just the blocked lanes, for readability. */
const blockedLanes = (phone) => state(phone).map((r) => r.split("@")[0]).sort();

/** get_active_blocks as the operator. */
const activeBlocks = (phone) => {
  const out = sql(`SET ROLE ${OPERATOR};
    SELECT channel || '/' || dedupe_key FROM get_active_blocks('${phone}');
    RESET ROLE;`);
  return out.split("\n").filter(Boolean);
};

describe("db/003 — the unsuppression fold, against a real PostgreSQL", { skip }, () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cst-db003-"));

    /* PREFLIGHT. `psql` missing, or a cluster that will not answer, must
       produce a sentence a human can act on — not an ENOENT from deep inside
       the first migration. And it must FAIL: the variable is set, so a
       database was promised. */
    try {
      execFileSync("psql", ["--version"], { stdio: "pipe" });
    } catch {
      assert.fail("psql is not on PATH, but " + URL_VAR + " is set. " +
        "These tests drive a real PostgreSQL through psql and cannot run without it.");
    }
    try {
      sql("SELECT 1;");
    } catch (err) {
      assert.fail(`${URL_VAR} is set but the cluster did not answer: ${err.message}`);
    }

    /* Idempotent teardown first, so a rerun against a dirty cluster is
       clean rather than confusing. */
    sql(`DROP FUNCTION IF EXISTS get_active_blocks(text);
         DROP FUNCTION IF EXISTS get_suppression_state(text);
         DROP FUNCTION IF EXISTS _active_consent_blocks(text);
         DROP TABLE IF EXISTS communication_consent_events;`);
    for (const r of [APP, SENDER, OPERATOR]) {
      sql(`DO $$BEGIN
             IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN
               EXECUTE 'DROP OWNED BY ${r}'; EXECUTE 'DROP ROLE ${r}';
             END IF;
           END$$;`);
    }
    sql(`CREATE ROLE ${APP} LOGIN PASSWORD 'pw_app';`);

    /* The real migration text, with the placeholders an operator fills in.
       If any of the three fails to apply, these tests fail here. */
    const migration = (file, subs) => {
      let text = readFileSync(join(REPO, "db", file), "utf8");
      for (const [from, to] of subs) text = text.split(from).join(to);
      return text;
    };
    sql(migration("001_communication_consent_events.sql",
      [["<application_role>", APP]]));
    sql(migration("002_suppression_lookup.sql",
      [["<sender_role>", SENDER], ["<sender_password>", "pw_sender"]]));
    sql(migration("003_unsuppression_lookup.sql",
      [["<operator_role>", OPERATOR], ["<operator_password>", "pw_operator"],
       ["<sender_role>", SENDER]]));
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /* ===================================================================
     THE SIX APPROVED SEMANTIC CASES
     =================================================================== */

  test("CASE 1 — legitimate STOP survives the correction of a later bad suppression", () => {
    const p = "+15555550001";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "sms", key: "k:c1:legit" });
    block({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms", key: "k:c1:bad" });
    invalidate({ phone: p, at: "2026-01-03T00:00:00Z", channel: "sms",
      key: "k:c1:fix", invalidates: ["k:c1:bad"] });

    /* THE WHOLE POINT. Under the superseded lane-wide semantics this lane
       unblocks and a real consumer refusal is erased. */
    assert.deepEqual(blockedLanes(p), ["sms"], "the legitimate STOP was erased");
    assert.match(state(p)[0], /2026-01-01/,
      "suppressed_at did not fall back to the legitimate STOP's own timestamp");
    assert.deepEqual(activeBlocks(p), ["sms/k:c1:legit"],
      "the wrong set of events is active");
  });

  test("CASE 2 — erroneous first, legitimate second, correction kills only the erroneous", () => {
    const p = "+15555550002";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "sms", key: "k:c2:bad" });
    block({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms", key: "k:c2:legit" });
    invalidate({ phone: p, at: "2026-01-03T00:00:00Z", channel: "sms",
      key: "k:c2:fix", invalidates: ["k:c2:bad"] });

    assert.deepEqual(blockedLanes(p), ["sms"]);
    assert.match(state(p)[0], /2026-01-02/,
      "suppressed_at should be the surviving legitimate STOP");
  });

  test("CASE 3 — a MISTAKEN correction of one of two legitimate STOPs costs nothing", () => {
    const p = "+15555550003";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "sms", key: "k:c3:a" });
    block({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms", key: "k:c3:b" });
    /* The operator is wrong: both were legitimate. */
    invalidate({ phone: p, at: "2026-01-03T00:00:00Z", channel: "sms",
      key: "k:c3:oops", invalidates: ["k:c3:a"] });

    assert.deepEqual(blockedLanes(p), ["sms"],
      "a mistaken correction unblocked the lane — model B's failure mode");
    assert.deepEqual(activeBlocks(p), ["sms/k:c3:b"]);
  });

  test("CASE 4 — a lone erroneous suppression, corrected, unblocks", () => {
    const p = "+15555550004";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "sms", key: "k:c4:bad" });
    invalidate({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms",
      key: "k:c4:fix", invalidates: ["k:c4:bad"] });

    assert.deepEqual(blockedLanes(p), [], "the intended correction did not unblock");
    assert.deepEqual(activeBlocks(p), []);
  });

  test("CASE 5 — consumer_request clears the lane over MULTIPLE legitimate blocks", () => {
    const p = "+15555550005";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "sms", key: "k:c5:a" });
    block({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms", key: "k:c5:b",
      type: "revoked" });
    laneClear({ phone: p, at: "2026-01-03T00:00:00Z", channel: "sms", key: "k:c5:clear" });

    assert.deepEqual(blockedLanes(p), [],
      "a lane clearance failed to clear the lane — the correction over-narrowed it");
  });

  test("CASE 6a — correcting an erroneous SMS STOP leaves the legitimate global block", () => {
    const p = "+15555550006";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "all", key: "k:c6a:dnc" });
    block({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms", key: "k:c6a:bad" });
    invalidate({ phone: p, at: "2026-01-03T00:00:00Z", channel: "sms",
      key: "k:c6a:fix", invalidates: ["k:c6a:bad"] });

    /* The function returns LANES; `all` dominating sms/ai_voice is applied
       by the permission resolver, which the design makes the only decider.
       What must be true HERE is that the `all` lane survived intact. */
    assert.deepEqual(blockedLanes(p), ["all"],
      "the legitimate global block did not survive");
  });

  test("CASE 6b — correcting an erroneous global DNC leaves the legitimate SMS STOP", () => {
    const p = "+15555550007";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "all", key: "k:c6b:baddnc" });
    block({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms", key: "k:c6b:legit" });
    invalidate({ phone: p, at: "2026-01-03T00:00:00Z", channel: "all",
      key: "k:c6b:fix", invalidates: ["k:c6b:baddnc"] });

    assert.deepEqual(blockedLanes(p), ["sms"],
      "the independent legitimate SMS refusal did not survive");
  });

  /* ===================================================================
     THE FAIL-CLOSED RULES
     =================================================================== */

  test("an EMPTY invalidates clears nothing, and is not a lane clearance", () => {
    const p = "+15555550010";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "sms", key: "k:e:blk" });
    invalidate({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms",
      key: "k:e:fix", invalidates: [] });
    assert.deepEqual(blockedLanes(p), ["sms"],
      "an empty invalidates became a lane clearance — the original defect, mirrored");
  });

  test("a MALFORMED invalidates clears nothing and does not raise", () => {
    /* FINDING B. The design's illustrative SQL called
       jsonb_array_elements_text() directly, which RAISES on a scalar or an
       object ("cannot extract elements from a scalar") and aborted the whole
       fold. A raised error is not "fails toward more blocking": the caller
       gets an exception where it expected an answer. Each shape below must
       return the block, not throw. */
    const shapes = [
      ['"k:m:blk"', "a bare string"],
      ["123", "a number"],
      ["{\"k\":\"k:m:blk\"}", "an object"],
      ["null", "a JSON null"],
      ["true", "a boolean"],
    ];
    shapes.forEach(([json, label], i) => {
      const p = `+1555555002${i}`;
      block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "sms", key: `k:m${i}:blk` });
      event({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms", key: `k:m${i}:fix`,
        type: "unsuppressed", reason: "recorded_in_error",
        metadata: `{"invalidates": ${json}}` });
      assert.deepEqual(blockedLanes(p), ["sms"], `${label} cleared the lane`);
    });
  });

  test("a MISSING invalidates key clears nothing", () => {
    const p = "+15555550030";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "sms", key: "k:miss:blk" });
    event({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms", key: "k:miss:fix",
      type: "unsuppressed", reason: "recorded_in_error", metadata: '{"note":"none"}' });
    assert.deepEqual(blockedLanes(p), ["sms"]);
  });

  test("invalidating an UNKNOWN dedupe_key clears nothing", () => {
    const p = "+15555550031";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "sms", key: "k:unk:blk" });
    invalidate({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms",
      key: "k:unk:fix", invalidates: ["k:unk:does-not-exist"] });
    assert.deepEqual(blockedLanes(p), ["sms"]);
  });

  test("PRE-EXISTENCE — an invalidation cannot kill a block recorded AFTER it", () => {
    const p = "+15555550032";
    invalidate({ phone: p, at: "2026-01-01T00:00:00Z", recorded: "2026-01-01T00:00:00Z",
      channel: "sms", key: "k:pre:fix", invalidates: ["k:pre:later"] });
    /* The named key arrives afterwards. It must NOT be born invalidated. */
    block({ phone: p, at: "2026-01-02T00:00:00Z", recorded: "2026-01-02T00:00:00Z",
      channel: "sms", key: "k:pre:later" });
    assert.deepEqual(blockedLanes(p), ["sms"],
      "a later-recorded block was pre-killed by an earlier invalidation");
  });

  test("PRE-EXISTENCE tie — equal recorded_at does NOT invalidate", () => {
    const p = "+15555550033";
    const t = "2026-01-01T00:00:00Z";
    block({ phone: p, at: t, recorded: t, channel: "sms", key: "k:tie:blk" });
    invalidate({ phone: p, at: t, recorded: t, channel: "sms",
      key: "k:tie:fix", invalidates: ["k:tie:blk"] });
    assert.deepEqual(blockedLanes(p), ["sms"],
      "an exact recorded_at tie invalidated the block — must be strictly <");
  });

  test("LANE-CLEARANCE tie — equal timestamps leave the block STANDING", () => {
    /* FINDING A. The design's prose says "if a blocking event and a clearing
       event carry the identical occurred_at, the BLOCK WINS", but its
       illustrative SQL tested survival with strict `>`, so a tie CLEARED the
       block. Prose and SQL disagreed and the SQL was the permissive one. */
    const p = "+15555550034";
    const t = "2026-01-01T00:00:00Z";
    block({ phone: p, at: t, recorded: t, channel: "sms", key: "k:lct:blk" });
    laneClear({ phone: p, at: t, recorded: t, channel: "sms", key: "k:lct:clear" });
    assert.deepEqual(blockedLanes(p), ["sms"],
      "an exact tie let a lane clearance win — equality must fail closed");
  });

  test("CROSS-LANE — an invalidation cannot reach a block in another lane", () => {
    const p = "+15555550035";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "all", key: "k:x:all" });
    /* Named from the sms lane, targeting the `all` lane's key. */
    invalidate({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms",
      key: "k:x:fix", invalidates: ["k:x:all"] });
    assert.deepEqual(blockedLanes(p), ["all"],
      "a cross-lane invalidation reached another lane");
  });

  test("a LANE CLEARANCE clears only its own lane", () => {
    const p = "+15555550036";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "sms", key: "k:lc:sms" });
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "all", key: "k:lc:all" });
    laneClear({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms", key: "k:lc:clear" });
    assert.deepEqual(blockedLanes(p), ["all"], "a lane clearance crossed lanes");
  });

  test("an UNKNOWN unsuppression reason_code clears nothing", () => {
    const p = "+15555550037";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "sms", key: "k:ur:blk" });
    event({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms", key: "k:ur:a",
      type: "unsuppressed", reason: "something_else",
      metadata: '{"invalidates":["k:ur:blk"]}' });
    /* And a NULL reason_code, which matches neither branch. */
    event({ phone: p, at: "2026-01-03T00:00:00Z", channel: "sms", key: "k:ur:b",
      type: "unsuppressed", reason: null, metadata: '{"invalidates":["k:ur:blk"]}' });
    assert.deepEqual(blockedLanes(p), ["sms"],
      "an unknown or NULL reason_code cleared a block");
  });

  test("a DELAYED STOP recorded after a lane clearance still blocks", () => {
    /* occurred_at BEFORE the clearance, recorded_at AFTER it — a redelivered
       or delayed webhook. Folding on event time alone discards it silently. */
    const p = "+15555550038";
    laneClear({ phone: p, at: "2026-01-05T00:00:00Z", recorded: "2026-01-05T00:00:00Z",
      channel: "sms", key: "k:dl:clear" });
    block({ phone: p, at: "2026-01-01T00:00:00Z", recorded: "2026-01-09T00:00:00Z",
      channel: "sms", key: "k:dl:late" });
    assert.deepEqual(blockedLanes(p), ["sms"],
      "a delayed STOP was discarded — the second clock is not being consulted");
  });

  test("DUPLICATE and REPLAYED invalidations do not widen the clearance", () => {
    const p = "+15555550039";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "sms", key: "k:dup:a" });
    block({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms", key: "k:dup:b" });
    /* The same key named twice in one row, and again in a second row. */
    invalidate({ phone: p, at: "2026-01-03T00:00:00Z", channel: "sms",
      key: "k:dup:fix1", invalidates: ["k:dup:a", "k:dup:a"] });
    invalidate({ phone: p, at: "2026-01-04T00:00:00Z", channel: "sms",
      key: "k:dup:fix2", invalidates: ["k:dup:a"] });
    assert.deepEqual(blockedLanes(p), ["sms"], "a duplicate invalidation widened the clearance");
    assert.deepEqual(activeBlocks(p), ["sms/k:dup:b"]);
  });

  test("an INSERT replay is a no-op and cannot change the fold", () => {
    const p = "+15555550040";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "sms", key: "k:rep:blk" });
    const before = blockedLanes(p);
    /* dedupe_key is UNIQUE; the application inserts ON CONFLICT DO NOTHING. */
    sql(`INSERT INTO communication_consent_events
           (occurred_at, channel, event_type, phone_e164, source, dedupe_key)
         VALUES ('2026-01-01T00:00:00Z','sms','suppressed','${p}','twilio','k:rep:blk')
         ON CONFLICT DO NOTHING;`);
    assert.deepEqual(blockedLanes(p), before, "a replay changed the fold");
    assert.equal(rows(`SELECT count(*) FROM communication_consent_events
                        WHERE dedupe_key='k:rep:blk';`)[0][0], "1");
  });

  /* ===================================================================
     THE TWO FUNCTIONS MUST AGREE
     =================================================================== */

  test("get_active_blocks and get_suppression_state never disagree", () => {
    /* One definition of "active" or the operator is shown a set the
       enforcement path does not accept. Checked across EVERY phone number
       these tests created, not a hand-picked one. */
    const mismatches = rows(`
      SELECT DISTINCT e.phone_e164
        FROM communication_consent_events e
       WHERE (SELECT count(*) FROM get_suppression_state(e.phone_e164)) <>
             (SELECT count(DISTINCT channel) FROM get_active_blocks(e.phone_e164));`);
    assert.deepEqual(mismatches, [],
      `the summary and the detailed list disagree for: ${JSON.stringify(mismatches)}`);
  });

  /* ===================================================================
     REGRESSIONS — these must FAIL under the superseded semantics
     =================================================================== */

  test("REGRESSION — the superseded lane-wide fold erases the legitimate STOP", () => {
    /* The defect this migration corrects, reproduced against the SAME data
       as CASE 1 and CASE 3 using the OLD fold, so the difference is the
       semantics and not the fixture. Built as a throwaway function and
       dropped; it is never granted to anything. */
    sql(`CREATE FUNCTION _superseded_fold(p_phone text)
         RETURNS TABLE (channel text, suppressed_at timestamptz)
         LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
           WITH last_clear AS (
             SELECT DISTINCT ON (u.channel) u.channel,
                    u.occurred_at AS cleared_at, u.recorded_at AS cleared_recorded_at
             FROM public.communication_consent_events u
             WHERE u.phone_e164 = p_phone AND u.event_type = 'unsuppressed'
             ORDER BY u.channel, u.occurred_at DESC, u.recorded_at DESC, u.event_id
           )
           SELECT e.channel, min(e.occurred_at)
           FROM public.communication_consent_events e
           LEFT JOIN last_clear c ON c.channel = e.channel
           WHERE e.phone_e164 = p_phone
             AND e.event_type IN ('suppressed','revoked')
             AND (c.channel IS NULL OR e.occurred_at > c.cleared_at
                  OR e.recorded_at > c.cleared_recorded_at)
           GROUP BY e.channel;
         $$;`);
    try {
      const old1 = rows(`SELECT channel FROM _superseded_fold('+15555550001');`);
      const old3 = rows(`SELECT channel FROM _superseded_fold('+15555550003');`);
      assert.deepEqual(old1, [],
        "CASE 1 did not unblock under the superseded fold - the regression proves nothing");
      assert.deepEqual(old3, [],
        "CASE 3 did not unblock under the superseded fold - the regression proves nothing");
      /* And the corrected fold keeps both blocked. */
      assert.deepEqual(blockedLanes("+15555550001"), ["sms"]);
      assert.deepEqual(blockedLanes("+15555550003"), ["sms"]);
    } finally {
      sql(`DROP FUNCTION _superseded_fold(text);`);
    }
  });

  test("REGRESSION — the unguarded jsonb call raises on malformed metadata", () => {
    /* FINDING B, shown failing against the design's own illustrative form. */
    sql(`CREATE FUNCTION _unguarded(p_phone text)
         RETURNS TABLE (dedupe_key text)
         LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
           SELECT k.dedupe_key
           FROM public.communication_consent_events i
           CROSS JOIN LATERAL jsonb_array_elements_text(
                  COALESCE(i.metadata -> 'invalidates', '[]'::jsonb)) AS k(dedupe_key)
           WHERE i.phone_e164 = p_phone AND i.event_type = 'unsuppressed';
         $$;`);
    try {
      let raised = null;
      try { sql(`SELECT * FROM _unguarded('+15555550020');`); }
      catch (err) { raised = err.message; }
      assert.ok(raised, "the unguarded form did not raise - the guard would be unnecessary");
      assert.match(raised, /cannot extract elements from a scalar/i);
      /* The shipped, guarded function answers instead of raising. */
      assert.deepEqual(blockedLanes("+15555550020"), ["sms"]);
    } finally {
      sql(`DROP FUNCTION _unguarded(text);`);
    }
  });

  /* ===================================================================
     PRIVILEGES — read back from PostgreSQL, not from the migration text
     =================================================================== */

  test("the hardening actually landed on all three functions", () => {
    const got = rows(`SELECT p.proname, p.prosecdef,
                             coalesce(array_to_string(p.proconfig,','),'NONE')
                        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                       WHERE n.nspname='public'
                         AND p.proname IN ('get_suppression_state','get_active_blocks',
                                           '_active_consent_blocks')
                       ORDER BY p.proname;`);
    assert.equal(got.length, 3, "a function is missing");
    for (const [name, secdef, config] of got) {
      assert.match(config, /search_path=pg_catalog, public/,
        `${name} has no fixed search_path - drop and recreate it, do not patch`);
      const expected = name === "_active_consent_blocks" ? "f" : "t";
      assert.equal(secdef, expected,
        `${name} prosecdef is ${secdef}, expected ${expected}`);
    }
  });

  test("get_suppression_state's contract is byte-identical to db/002's", () => {
    const [[args, ret]] = rows(`
      SELECT pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='get_suppression_state';`);
    assert.equal(args, "p_phone text", "the input signature changed - gate 8's contract broke");
    assert.equal(ret, "TABLE(channel text, suppressed_at timestamp with time zone)",
      "the return shape changed - gate 8 would need a new caller contract");
  });

  test("PUBLIC can execute neither read function, nor the internal one", () => {
    const acls = rows(`SELECT p.proname, coalesce(array_to_string(p.proacl,' '),'DEFAULT')
                         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public'
                          AND p.proname IN ('get_suppression_state','get_active_blocks',
                                            '_active_consent_blocks');`);
    for (const [name, acl] of acls) {
      assert.notEqual(acl, "DEFAULT",
        `${name} has a null ACL - PostgreSQL grants EXECUTE to PUBLIC by default`);
      assert.ok(!/(^| )=X\//.test(acl),
        `${name} still grants EXECUTE to PUBLIC: ${acl}`);
    }
  });

  test("the SENDER gets the summary and NOTHING else", () => {
    assert.equal(asRole(SENDER, `SELECT * FROM get_suppression_state('+15555550001');`).ok,
      true, "the sender cannot call the function gate 8 depends on");
    assertDenied(SENDER, `SELECT * FROM get_active_blocks('+15555550001');`,
      "call get_active_blocks - it has no use for event identity");
    assertDenied(SENDER, `SELECT count(*) FROM communication_consent_events;`,
      "read the table");
    assertDenied(SENDER, `INSERT INTO communication_consent_events
      (occurred_at,channel,event_type,phone_e164,source,dedupe_key)
      VALUES (now(),'sms','suppressed','+1','manual','x');`, "insert");
  });

  test("the WEBSITE role gets neither read function and cannot read the table", () => {
    assertDenied(APP, `SELECT * FROM get_suppression_state('+15555550001');`,
      "call get_suppression_state");
    assertDenied(APP, `SELECT * FROM get_active_blocks('+15555550001');`,
      "call get_active_blocks");
    assertDenied(APP, `SELECT count(*) FROM communication_consent_events;`, "read the table");
    assertDenied(APP, `UPDATE communication_consent_events SET channel='x';`, "update");
    assertDenied(APP, `DELETE FROM communication_consent_events;`, "delete");
  });

  test("the OPERATOR gets summary + active blocks + insert, and nothing more", () => {
    assert.equal(asRole(OPERATOR, `SELECT * FROM get_suppression_state('+15555550001');`).ok, true);
    assert.equal(asRole(OPERATOR, `SELECT * FROM get_active_blocks('+15555550001');`).ok, true);
    assert.equal(asRole(OPERATOR, `INSERT INTO communication_consent_events
      (occurred_at,channel,event_type,phone_e164,source,dedupe_key)
      VALUES (now(),'sms','suppressed','+15555550099','manual','k:op:probe');`).ok, true,
      "the operator cannot append - it could not record an unsuppression");
    assertDenied(OPERATOR, `SELECT count(*) FROM communication_consent_events;`,
      "read the table");
    assertDenied(OPERATOR, `UPDATE communication_consent_events SET channel='x';`, "update");
    assertDenied(OPERATOR, `DELETE FROM communication_consent_events;`, "delete");
    assertDenied(OPERATOR, `TRUNCATE communication_consent_events;`, "truncate");
  });

  test("NO role can reach the internal definition of \"active\"", () => {
    for (const role of [APP, SENDER, OPERATOR]) {
      assertDenied(role, `SELECT * FROM _active_consent_blocks('+15555550001');`,
        "call the internal function");
    }
  });

  test("SECURITY DEFINER search_path cannot be subverted by a shadow table", () => {
    /* THE CLASSIC SECURITY DEFINER HOLE, attacked rather than asserted.
       Without a pinned search_path a caller creates their own table named
       communication_consent_events in a schema they control, puts it first
       in their search_path, and the function reads THAT with the owner's
       rights — silently returning "not suppressed" for a number that is. */
    sql(`CREATE SCHEMA IF NOT EXISTS evil;
         DROP TABLE IF EXISTS evil.communication_consent_events;
         CREATE TABLE evil.communication_consent_events AS
           SELECT * FROM public.communication_consent_events WHERE false;
         GRANT USAGE ON SCHEMA evil TO ${SENDER};
         GRANT SELECT ON evil.communication_consent_events TO ${SENDER};`);
    try {
      /* CASE 1's number is genuinely blocked. The shadow table is empty, so
         if the pin failed this returns nothing and the STOP is invisible. */
      const out = sql(`SET ROLE ${SENDER};
        SET search_path = evil, public;
        SELECT channel FROM get_suppression_state('+15555550001');
        RESET ROLE;`);
      assert.match(out, /sms/,
        "the shadow table was read - the search_path pin is not holding, and a " +
        "legitimate STOP just became invisible to send-time enforcement");
    } finally {
      sql(`RESET ROLE; DROP TABLE IF EXISTS evil.communication_consent_events;
           DROP SCHEMA IF EXISTS evil CASCADE;`);
    }
  });

  test("CREATE OR REPLACE preserves the ACL — measured, not assumed", () => {
    /* The design listed this as a documented expectation it had not
       measured, and db/003 re-issues every grant so nothing depends on it.
       Measure it anyway: if a future migration ever DOES rely on it, this
       says whether it may. */
    sql(`CREATE FUNCTION _acl_probe(p text) RETURNS text
         LANGUAGE sql STABLE AS $$ SELECT 'a'::text $$;
         REVOKE EXECUTE ON FUNCTION _acl_probe(text) FROM PUBLIC;
         GRANT EXECUTE ON FUNCTION _acl_probe(text) TO ${SENDER};`);
    try {
      const before = rows(`SELECT array_to_string(proacl,' ') FROM pg_proc
                            WHERE proname='_acl_probe';`)[0][0];
      sql(`CREATE OR REPLACE FUNCTION _acl_probe(p text) RETURNS text
           LANGUAGE sql STABLE AS $$ SELECT 'b'::text $$;`);
      const after = rows(`SELECT array_to_string(proacl,' ') FROM pg_proc
                           WHERE proname='_acl_probe';`)[0][0];
      assert.equal(after, before,
        "CREATE OR REPLACE changed the ACL - db/003's unconditional re-grants are " +
        "not belt and braces, they are load-bearing");
      assert.match(after, new RegExp(SENDER), "the grant vanished");
      assert.ok(!/(^| )=X\//.test(after), "PUBLIC reappeared on replace");
    } finally {
      sql(`DROP FUNCTION IF EXISTS _acl_probe(text);`);
    }
  });

  test("a JSON null inside invalidates matches nothing", () => {
    /* jsonb_array_elements_text yields SQL NULL for a JSON null element. If
       `v.killed_key = e.dedupe_key` ever became NULL-tolerant, one null in
       the array would kill every block in the lane. */
    const p = "+15555550041";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "sms", key: "k:nul:a" });
    block({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms", key: "k:nul:b" });
    event({ phone: p, at: "2026-01-03T00:00:00Z", channel: "sms", key: "k:nul:fix",
      type: "unsuppressed", reason: "recorded_in_error",
      metadata: '{"invalidates":[null]}' });
    assert.deepEqual(blockedLanes(p), ["sms"], "a JSON null cleared the lane");
    assert.equal(activeBlocks(p).length, 2, "a JSON null killed a block");
  });

  test("MULTIPLE distinct targets in one invalidation kill exactly those", () => {
    const p = "+15555550042";
    block({ phone: p, at: "2026-01-01T00:00:00Z", channel: "sms", key: "k:mt:a" });
    block({ phone: p, at: "2026-01-02T00:00:00Z", channel: "sms", key: "k:mt:b" });
    block({ phone: p, at: "2026-01-03T00:00:00Z", channel: "sms", key: "k:mt:c" });
    invalidate({ phone: p, at: "2026-01-04T00:00:00Z", channel: "sms",
      key: "k:mt:fix", invalidates: ["k:mt:a", "k:mt:c"] });
    assert.deepEqual(activeBlocks(p), ["sms/k:mt:b"],
      "a multi-target invalidation killed the wrong set");
    assert.match(state(p)[0], /2026-01-02/);
  });

  test("MULTIPLE lane clearances fold to the latest, with both clocks paired", () => {
    /* DISTINCT ON picks one row and takes BOTH timestamps from it. A block is
       cleared only if it precedes that clearance on BOTH clocks. */
    const p = "+15555550043";
    laneClear({ phone: p, at: "2026-01-05T00:00:00Z", recorded: "2026-01-20T00:00:00Z",
      channel: "sms", key: "k:mc:clear1" });
    laneClear({ phone: p, at: "2026-01-09T00:00:00Z", recorded: "2026-01-06T00:00:00Z",
      channel: "sms", key: "k:mc:clear2" });
    /* Precedes clear2 on event time but NOT on ingest time -> survives. */
    block({ phone: p, at: "2026-01-07T00:00:00Z", recorded: "2026-01-07T00:00:00Z",
      channel: "sms", key: "k:mc:blk" });
    assert.deepEqual(blockedLanes(p), ["sms"],
      "a block later than the clearance by ingest time was cleared anyway");
  });

  test("no role can enumerate the ledger through either function", () => {
    /* Both take ONE number. There is no argument-free form, and no way to
       ask "which numbers are suppressed". */
    for (const fn of ["get_suppression_state", "get_active_blocks"]) {
      const overloads = rows(`SELECT count(*) FROM pg_proc p
                                JOIN pg_namespace n ON n.oid=p.pronamespace
                               WHERE n.nspname='public' AND p.proname='${fn}';`);
      assert.equal(overloads[0][0], "1", `${fn} has more than one overload`);
      assert.equal(rows(`SELECT pg_get_function_identity_arguments(p.oid)
                           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                          WHERE n.nspname='public' AND p.proname='${fn}';`)[0][0],
        "p_phone text", `${fn} does not take exactly one phone argument`);
    }
  });
});
