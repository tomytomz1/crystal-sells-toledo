/* Website SMS re-opt-in — the two-factor clearance.
   =====================================================================
   TIER 4. This is the first path in the repository that can lift a
   suppression without a human, so wrong in one direction is a TCPA
   violation and wrong in the other silently strands a consumer who asked
   to come back.

   THE CLAIM UNDER TEST, in one sentence: a previous STOP stays in force
   until BOTH a fresh, phone-matched, durably evidenced website consent AND
   a provider-confirmed START from that handset are on record, and every
   other outcome leaves the suppression exactly where it was.

   NOTHING HERE REACHES A DATABASE, TWILIO OR HUBSPOT.

   HOW THE DATABASE BOUNDARY IS DRIVEN, and why it is not a stubbed
   function. api/_lib/reoptin.mjs deliberately holds NO injectable executor:
   a fabricated answer saying "blocked, and a fresh consent exists" would
   manufacture a clearance for a number that never asked for one, which is
   the sharper twin of the bypass PR #51 removed from gate 8. So these tests
   drive the REAL @neondatabase/serverless driver against a stubbed
   `globalThis.fetch` speaking Neon's own HTTP wire format — arrays of raw
   column values plus a `fields` descriptor, which the driver parses into
   Dates and strings exactly as it does in production. CLAUDE.md rule 14:
   the lowest practical real boundary, one layer below the code under test.

   The SQL itself is not tested here. db/004's fold runs against a real
   PostgreSQL 16 cluster in tests/reoptin-fold.test.mjs.
   ===================================================================== */

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  reoptinEnabled, reoptinConfigured, reoptinActive,
  evaluateReoptin, buildReoptinUnsuppression, appendReoptinUnsuppression,
  lookupReoptinReadiness, reoptinLogShape,
  REOPTIN_FLAG, REOPTIN_LEDGER_URL_VAR, REOPTIN_DECISION, REOPTIN_ERROR,
  REOPTIN_LOOKUP_TIMEOUT_MS, REOPTIN_APPEND_TIMEOUT_MS, REOPTIN_MIN_BUDGET_MS,
  REOPTIN_CONSENT_MAX_AGE_SECONDS,
} from "../api/_lib/reoptin.mjs";
import {
  buildSuppressionEvent, ConsentLedgerError, LEDGER_EVIDENCE_INCOMPLETE,
  CHANNEL, EVENT_TYPE, SOURCE_TWILIO, SOURCE_OPERATOR, SOURCE_WEBSITE,
  SOURCE_RETELL, REOPTIN_CONFIRMATION, LEDGER_URL_VAR,
  AUTOMATIC_UNSUPPRESSION_SOURCES, AUTOMATIC_UNSUPPRESSION_CHANNELS,
} from "../api/_lib/consent-ledger.mjs";
import {
  UNSUPPRESSION_REASON, UNSUPPRESSION_ERROR_ORIGIN, PERMISSION_STATE,
  applySubmissionConsent, buildConsentEvidence, FEATURE_FLAG,
} from "../api/_lib/consent.mjs";
import {
  toHubSpotReoptinGrantProperties, toHubSpotConsentProperties,
  SUPPRESSION_PROPERTIES, SMS_STATE_PROPERTIES, AI_VOICE_STATE_PROPERTIES,
  REOPTIN_PROPERTIES,
} from "../api/_lib/hubspot-consent-state.mjs";
import { canSendSms, canPlaceAutomatedVoiceCall, REASON } from "../api/_lib/permission.mjs";
import {
  MIN_SEARCH_MS, MIN_WRITE_MS, PROJECTION_DEADLINE_MS, WEBHOOK_BODY_TIMEOUT_MS,
} from "../api/twilio-inbound.js";
import inboundHandler from "../api/twilio-inbound.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const PHONE = "+14195550123";
const OTHER_PHONE = "+14195559999";
const SID = "SM_start_0000000000000000000000001";
const TOKEN = "test_auth_token_not_a_real_credential";
const REOPTIN_URL = "postgresql://reopt:secret@db.example.neon.tech/neondb";
const LEDGER_URL = "postgresql://app:secret@db.example.neon.tech/neondb";
const CONSENT_KEY = "website:sub-abc-123:sms:consent_selected";
const CONSENT_AT = "2026-09-20T12:00:00.000Z";
const BLOCKED_AT = "2026-09-18T09:00:00.000Z";

/* =====================================================================
   0  THE READINESS ANSWER, AS THE WIRE ACTUALLY CARRIES IT
   ===================================================================== */
const READINESS_FIELDS = [
  ["blocked_sms_at", 1184], ["blocked_ai_voice_at", 1184], ["blocked_all_at", 1184],
  ["consent_dedupe_key", 25], ["consent_occurred_at", 1184], ["consent_version", 25],
  ["consent_form_type", 25], ["consent_page_path", 25], ["consent_submission_id", 25],
].map(([name, dataTypeID]) => ({ name, dataTypeID }));

/* Postgres sends a timestamptz on the wire as `YYYY-MM-DD HH:MM:SS.mmm+00`,
   and @neondatabase/serverless parses THAT into a Date. Feeding the stub an
   ISO string instead would exercise a format the real database never sends
   and would prove nothing about the parser this code actually runs behind. */
const pg = (iso) => new Date(iso).toISOString().replace("T", " ").replace("Z", "+00");

/** One db/004 row, in Neon's own array-of-values wire shape. */
function readinessRow({
  smsAt = BLOCKED_AT, voiceAt = null, allAt = null,
  key = CONSENT_KEY, at = CONSENT_AT, version = "CST_SMS_CONSENT_2026_09_V1",
  formType = "home_value", page = "/home-value", submission = "sub-abc-123",
} = {}) {
  const ts = (v) =>
    (v == null ? null : (Number.isNaN(new Date(v).getTime()) ? v : pg(v)));
  return [ts(smsAt), ts(voiceAt), ts(allAt), key,
          at == null ? null : (Number.isNaN(new Date(at).getTime()) ? at : pg(at)),
          version, formType, page, submission];
}

const SELECT_OK = (rows) => ({
  command: "SELECT", rowCount: rows.length, rowAsArray: true,
  fields: READINESS_FIELDS, rows,
});

const INSERT_OK = (rowCount) => ({
  command: "INSERT", rowCount, rowAsArray: true, fields: [], rows: [],
});

/**
 * Stub `globalThis.fetch` with a queue of Neon HTTP responses, and record
 * every statement that was actually sent.
 *
 * `plan` entries are either a response object, or a function receiving the
 * decoded `{ query, params }` so a test can answer per statement, or an
 * Error to throw, or a number of milliseconds to stall for.
 */
function neonFetch(plan) {
  const sent = [];
  let i = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    const step = typeof plan === "function" ? plan(body, sent.length - 1) : plan[i++];
    if (step instanceof Error) throw step;
    if (typeof step === "number") {
      /* A server that accepts the request and never answers. The driver's
         own abort signal is what must end this, not the test. */
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, step);
        init?.signal?.addEventListener?.("abort", () => {
          clearTimeout(t);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
      return new Response(JSON.stringify(SELECT_OK([])), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(step), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  return sent;
}

const realFetch = globalThis.fetch;

/* =====================================================================
   1  CONFIGURATION — TWO SWITCHES, BOTH REQUIRED
   ===================================================================== */
describe("the re-opt-in switches", () => {
  test("the flag is an exact \"true\" and nothing else", () => {
    for (const value of ["true"])
      assert.equal(reoptinEnabled({ [REOPTIN_FLAG]: value }), true, value);
    for (const value of ["TRUE", "True", "1", "yes", "on", " true", "true ", ""])
      assert.equal(reoptinEnabled({ [REOPTIN_FLAG]: value }), false,
        `"${value}" enabled a feature that clears suppressions`);
    assert.equal(reoptinEnabled({}), false);
  });

  test("a blank credential is not a configured credential", () => {
    assert.equal(reoptinConfigured({ [REOPTIN_LEDGER_URL_VAR]: "  " }), false);
    assert.equal(reoptinConfigured({ [REOPTIN_LEDGER_URL_VAR]: REOPTIN_URL }), true);
  });

  /* THREE SWITCHES, AND NO TWO OF THEM ARE ENOUGH. The consent feature is
     the third because api/twilio-inbound.js skips the HubSpot projection
     while it is off, so a clearance written then would open the durable lane
     and leave the CRM asserting a suppression. */
  test("active requires all three — no subset turns it on", () => {
    const all = {
      [FEATURE_FLAG]: "true",
      [REOPTIN_FLAG]: "true",
      [REOPTIN_LEDGER_URL_VAR]: REOPTIN_URL,
    };
    assert.equal(reoptinActive(all), true);
    for (const missing of Object.keys(all)) {
      const env = { ...all };
      delete env[missing];
      assert.equal(reoptinActive(env), false, `${missing} alone did not hold it off`);
    }
  });
});

/* =====================================================================
   2  THE DECISION — PURE, AND EVERY REFUSAL NAMES ITSELF
   ===================================================================== */
describe("evaluateReoptin", () => {
  const blocked = (over = {}) => ({
    phone: PHONE,
    blocked: { sms: BLOCKED_AT, ai_voice: null, all: null, ...over },
    consent: { dedupeKey: CONSENT_KEY, occurredAt: CONSENT_AT, version: "v1" },
  });

  test("blocked SMS lane plus a fresh consent is eligible", () => {
    assert.deepEqual(evaluateReoptin({ channel: "sms", readiness: blocked() }),
      { eligible: true, reason: REOPTIN_DECISION.ELIGIBLE });
  });

  /* TEST 9 — provider/consent evidence absent means the block stands. */
  test("no qualifying consent leaves the suppression in force", () => {
    const r = { ...blocked(), consent: null };
    assert.deepEqual(evaluateReoptin({ channel: "sms", readiness: r }),
      { eligible: false, reason: REOPTIN_DECISION.NO_FRESH_CONSENT });
  });

  /* A GLOBAL DO-NOT-CONTACT IS NOT AN SMS SUPPRESSION. "Remove me from your
     list" spoke about every channel; a ticked SMS box does not answer it. */
  test("a global do-not-contact refuses the whole transition", () => {
    const r = blocked({ all: BLOCKED_AT });
    assert.deepEqual(evaluateReoptin({ channel: "sms", readiness: r }),
      { eligible: false, reason: REOPTIN_DECISION.GLOBAL_BLOCK });
  });

  test("an unblocked lane is not cleared again", () => {
    const r = blocked({ sms: null });
    assert.deepEqual(evaluateReoptin({ channel: "sms", readiness: r }),
      { eligible: false, reason: REOPTIN_DECISION.NOT_BLOCKED });
  });

  /* TEST 8 — AI VOICE IS NEVER TOUCHED BY THIS PATH. */
  test("no channel but sms can be cleared automatically", () => {
    for (const channel of ["ai_voice", "all", "voice", "", null, undefined, "SMS"])
      assert.deepEqual(
        evaluateReoptin({ channel, readiness: blocked({ ai_voice: BLOCKED_AT }) }),
        { eligible: false, reason: REOPTIN_DECISION.UNSUPPORTED_CHANNEL },
        `channel ${String(channel)} was allowed through the lane fence`);
    assert.deepEqual([...AUTOMATIC_UNSUPPRESSION_CHANNELS], ["sms"]);
  });

  test("a missing or malformed readiness object is not an eligibility", () => {
    for (const readiness of [null, undefined, {}, "ok", [], { blocked: null }])
      assert.equal(evaluateReoptin({ channel: "sms", readiness }).eligible, false);
  });
});

/* =====================================================================
   3  THE LEDGER CONTRACT FOR AN AUTOMATIC CLEARANCE
   ===================================================================== */
describe("the unsuppressed contract, automatic branch", () => {
  const base = {
    occurredAt: "2026-09-21T10:00:00.000Z",
    channel: CHANNEL.SMS,
    phone: PHONE,
    sourceEventId: SID,
    consent: { dedupeKey: CONSENT_KEY, occurredAt: CONSENT_AT, version: "v1", submissionId: "s" },
  };
  const detail = (fn) => {
    try { fn(); } catch (err) {
      assert.ok(err instanceof ConsentLedgerError, `not a ledger error: ${err}`);
      assert.equal(err.token, LEDGER_EVIDENCE_INCOMPLETE);
      return err.detail;
    }
    assert.fail("expected a refusal");
  };

  test("a provider-confirmed START clearance is well formed", () => {
    const row = buildReoptinUnsuppression(base);
    assert.equal(row.event_type, EVENT_TYPE.UNSUPPRESSED);
    assert.equal(row.channel, CHANNEL.SMS);
    assert.equal(row.source, SOURCE_TWILIO);
    assert.equal(row.reason_code, UNSUPPRESSION_REASON.CONSUMER_REQUEST);
    /* The provider's own message id, so a redelivery collides with itself. */
    assert.equal(row.dedupe_key, `${SOURCE_TWILIO}:${SID}:sms:unsuppressed`);
    /* A START is a keyword, not evidence, and this table is not a message
       archive. */
    assert.equal(row.evidence_text, null);
    const meta = JSON.parse(row.metadata);
    assert.equal(meta.reoptin_confirmation, REOPTIN_CONFIRMATION.TWILIO_START);
    assert.equal(meta.consent_dedupe_key, CONSENT_KEY);
    assert.equal(meta.consent_occurred_at, CONSENT_AT);
  });

  /* THE FENCE THAT REPLACED "ONLY A HUMAN MAY LIFT A BLOCK". It was
     narrowed to one source, not deleted. */
  test("no source but twilio and operator may write a clearance", () => {
    assert.deepEqual([...AUTOMATIC_UNSUPPRESSION_SOURCES], [SOURCE_TWILIO]);
    for (const source of [SOURCE_WEBSITE, SOURCE_RETELL, "manual", "system"])
      assert.ok(detail(() => buildSuppressionEvent({
        occurredAt: base.occurredAt, channel: CHANNEL.SMS,
        eventType: EVENT_TYPE.UNSUPPRESSED, phone: PHONE, source,
        sourceEventId: "x", reasonCode: UNSUPPRESSION_REASON.CONSUMER_REQUEST,
        metadata: {
          reoptin_confirmation: REOPTIN_CONFIRMATION.TWILIO_START,
          consent_dedupe_key: CONSENT_KEY, consent_occurred_at: CONSENT_AT,
        },
      })), `${source} was allowed to lift a block`);
  });

  /* A START IS A MESSAGING KEYWORD. It clears an SMS lane and nothing else:
     an ai_voice permission is a separate permission and a global
     do-not-contact is a human's to lift. */
  test("an automatic clearance cannot reach the voice or global lane", () => {
    for (const channel of [CHANNEL.AI_VOICE, CHANNEL.ALL])
      assert.equal(detail(() => buildReoptinUnsuppression({ ...base, channel })),
        "channel:not_automatic", `${channel} was clearable automatically`);
  });

  /* Deciding a record was wrong is a judgement about a record. */
  test("recorded_in_error stays operator-only", () => {
    assert.equal(detail(() => buildSuppressionEvent({
      occurredAt: base.occurredAt, channel: CHANNEL.SMS,
      eventType: EVENT_TYPE.UNSUPPRESSED, phone: PHONE, source: SOURCE_TWILIO,
      sourceEventId: SID, reasonCode: UNSUPPRESSION_REASON.RECORDED_IN_ERROR,
      metadata: {
        error_origin: UNSUPPRESSION_ERROR_ORIGIN.CLASSIFIER,
        invalidates: [`${SOURCE_TWILIO}:SM9:sms:suppressed`],
      },
    })), "reason_code:not_automatic");
  });

  test("the clearance must NAME a website consent in its own lane", () => {
    const cases = [
      [undefined, "metadata.consent_dedupe_key:not_a_key"],
      [42, "metadata.consent_dedupe_key:not_a_key"],
      ["a:b:c", "metadata.consent_dedupe_key:malformed_key"],
      ["a:b::d", "metadata.consent_dedupe_key:malformed_key"],
      /* A provider or operator row carries no disclosure to have agreed to. */
      ["twilio:SM1:sms:consent_selected", "metadata.consent_dedupe_key:not_website"],
      ["operator:op1:sms:consent_selected", "metadata.consent_dedupe_key:not_website"],
      /* Another channel's agreement is not this channel's. */
      ["website:s1:ai_voice:consent_selected", "metadata.consent_dedupe_key:cross_channel"],
      /* THE RECORD OF NOT TICKING IS NOT A GRANT. */
      ["website:s1:sms:consent_not_selected", "metadata.consent_dedupe_key:not_a_consent"],
      ["website:s1:sms:reoptin_requested", "metadata.consent_dedupe_key:not_a_consent"],
      ["website:s1:sms:unsuppressed", "metadata.consent_dedupe_key:not_a_consent"],
    ];
    for (const [dedupeKey, expected] of cases)
      assert.equal(
        detail(() => buildReoptinUnsuppression({
          ...base, consent: { ...base.consent, dedupeKey },
        })), expected, `key ${String(dedupeKey)}`);
  });

  test("a clearance with no consent timestamp is refused", () => {
    assert.equal(detail(() => buildReoptinUnsuppression({
      ...base, consent: { ...base.consent, occurredAt: "" },
    })), "metadata.consent_occurred_at");
    assert.equal(detail(() => buildReoptinUnsuppression({
      ...base, consent: { ...base.consent, occurredAt: "not a date" },
    })), "metadata.consent_occurred_at");
  });

  test("an unknown confirmation kind is refused", () => {
    assert.equal(detail(() => buildSuppressionEvent({
      occurredAt: base.occurredAt, channel: CHANNEL.SMS,
      eventType: EVENT_TYPE.UNSUPPRESSED, phone: PHONE, source: SOURCE_TWILIO,
      sourceEventId: SID, reasonCode: UNSUPPRESSION_REASON.CONSUMER_REQUEST,
      metadata: {
        reoptin_confirmation: "web_form",
        consent_dedupe_key: CONSENT_KEY, consent_occurred_at: CONSENT_AT,
      },
    })), "metadata.reoptin_confirmation:unknown");
  });

  /* CANONICALISATION IS NOT COSMETIC. A key stored with surrounding
     whitespace would match nothing an auditor joined on, and the rule that
     checked it would have been decorative. */
  test("the stored key and timestamp are the canonical ones", () => {
    const row = buildReoptinUnsuppression({
      ...base,
      consent: { dedupeKey: `  ${CONSENT_KEY}  `, occurredAt: "2026-09-20T12:00:00Z" },
    });
    const meta = JSON.parse(row.metadata);
    assert.equal(meta.consent_dedupe_key, CONSENT_KEY);
    assert.equal(meta.consent_occurred_at, CONSENT_AT);
  });

  /* THE HUMAN WORKFLOW IS UNCHANGED — it is the documented fallback. */
  test("the operator clearance still behaves exactly as before", () => {
    const row = buildSuppressionEvent({
      occurredAt: base.occurredAt, channel: CHANNEL.ALL,
      eventType: EVENT_TYPE.UNSUPPRESSED, phone: PHONE, source: SOURCE_OPERATOR,
      sourceEventId: "op-1", reasonCode: UNSUPPRESSION_REASON.CONSUMER_REQUEST,
      metadata: { attestation: "spoke to the consumer" },
    });
    assert.equal(row.source, SOURCE_OPERATOR);
    assert.equal(row.channel, CHANNEL.ALL);
    /* No confirmation block is demanded of a human, and none is invented. */
    assert.deepEqual(JSON.parse(row.metadata), { attestation: "spoke to the consumer" });

    const corrected = buildSuppressionEvent({
      occurredAt: base.occurredAt, channel: CHANNEL.SMS,
      eventType: EVENT_TYPE.UNSUPPRESSED, phone: PHONE, source: SOURCE_OPERATOR,
      sourceEventId: "op-2", reasonCode: UNSUPPRESSION_REASON.RECORDED_IN_ERROR,
      metadata: {
        error_origin: UNSUPPRESSION_ERROR_ORIGIN.CLASSIFIER,
        invalidates: [` ${SOURCE_TWILIO}:SM9:sms:suppressed `],
      },
    });
    assert.deepEqual(JSON.parse(corrected.metadata).invalidates,
      [`${SOURCE_TWILIO}:SM9:sms:suppressed`]);
  });
});

/* =====================================================================
   4  THE READINESS LOOKUP, THROUGH THE REAL DRIVER
   ===================================================================== */
describe("lookupReoptinReadiness", () => {
  afterEach(() => { globalThis.fetch = realFetch; });
  const env = { [REOPTIN_LEDGER_URL_VAR]: REOPTIN_URL };

  test("it asks db/004 for one number, one lane and one window", async () => {
    const sent = neonFetch([SELECT_OK([readinessRow()])]);
    const out = await lookupReoptinReadiness(PHONE, { channel: CHANNEL.SMS, env });
    assert.match(sent[0].query, /public\.get_reoptin_readiness\(\$1, \$2, \$3\)/);
    assert.deepEqual(sent[0].params,
      [PHONE, "sms", String(REOPTIN_CONSENT_MAX_AGE_SECONDS)]);
    /* It names a FUNCTION and never the table. */
    assert.ok(!/communication_consent_events/.test(sent[0].query));
    assert.equal(out.phone, PHONE);
    assert.equal(out.blocked.sms, BLOCKED_AT);
    assert.equal(out.blocked.all, null);
    assert.equal(out.consent.dedupeKey, CONSENT_KEY);
    assert.equal(out.consent.occurredAt, CONSENT_AT);
  });

  test("an unknown number comes back as one all-null row", async () => {
    neonFetch([SELECT_OK([readinessRow({
      smsAt: null, key: null, at: null, version: null,
      formType: null, page: null, submission: null,
    })])]);
    const out = await lookupReoptinReadiness(PHONE, { channel: CHANNEL.SMS, env });
    assert.deepEqual(out.blocked, { sms: null, ai_voice: null, all: null });
    assert.equal(out.consent, null);
  });

  /* TEST 18 — a database that will not answer never means "not suppressed". */
  test("an unconfigured credential fails closed", async () => {
    await assert.rejects(
      () => lookupReoptinReadiness(PHONE, { channel: CHANNEL.SMS, env: {} }),
      (err) => err.token === REOPTIN_ERROR.NOT_CONFIGURED);
  });

  test("a driver failure fails closed and leaks nothing", async () => {
    neonFetch([new Error(`connect ECONNREFUSED ${REOPTIN_URL}`)]);
    await assert.rejects(
      () => lookupReoptinReadiness(PHONE, { channel: CHANNEL.SMS, env }),
      (err) => {
        assert.equal(err.token, REOPTIN_ERROR.FAILED);
        const shape = JSON.stringify(reoptinLogShape(err));
        assert.ok(!shape.includes("secret"), `the log shape carried a credential: ${shape}`);
        assert.ok(!shape.includes(PHONE), `the log shape carried a number: ${shape}`);
        return true;
      });
  });

  /* THE TIMEOUT ABORTS THE SOCKET rather than racing a promise and leaving
     the query running past the moment the caller stopped waiting. */
  test("a stalled answer times out, aborts, and fails closed", async () => {
    neonFetch([10_000]);
    const started = Date.now();
    await assert.rejects(
      () => lookupReoptinReadiness(PHONE, { channel: CHANNEL.SMS, env, timeoutMs: 150 }),
      (err) => err.token === REOPTIN_ERROR.TIMEOUT);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `the lookup took ${elapsed}ms against a 150ms bound`);
  });

  /* THE DRIVER PARSES TIMESTAMPS, AND WHAT IT CANNOT PARSE IT NULLS.
     Measured rather than assumed: a `timestamptz` the driver cannot read
     arrives here as `null`, indistinguishable from a SQL NULL. This code
     cannot recover the distinction, so what matters is which way the
     ambiguity falls — and it falls toward refusing. */
  test("an unreadable block timestamp refuses rather than unblocking", async () => {
    neonFetch([SELECT_OK([readinessRow({ smsAt: "yesterday" })])]);
    const out = await lookupReoptinReadiness(PHONE, { channel: CHANNEL.SMS, env });
    assert.equal(out.blocked.sms, null);
    assert.equal(evaluateReoptin({ channel: "sms", readiness: out }).reason,
      REOPTIN_DECISION.NOT_BLOCKED);
  });

  test("a non-timestamp value that survives the driver is refused", async () => {
    /* `infinity` reaches this code as a JS number, not a Date. */
    neonFetch([SELECT_OK([readinessRow({ smsAt: "infinity" })])]);
    await assert.rejects(
      () => lookupReoptinReadiness(PHONE, { channel: CHANNEL.SMS, env }),
      (err) => err.token === REOPTIN_ERROR.MALFORMED_RESPONSE);
  });

  test("a number that will not normalise is never queried", async () => {
    const sent = neonFetch([SELECT_OK([readinessRow()])]);
    await assert.rejects(
      () => lookupReoptinReadiness("nonsense", { channel: CHANNEL.SMS, env }),
      (err) => err.token === REOPTIN_ERROR.MALFORMED_RESPONSE);
    assert.equal(sent.length, 0, "an unusable number reached the database");
  });

  /* A SHAPE THIS CODE CANNOT READ TRUTHFULLY IS AN ERROR, NEVER A DEFAULT.
     The fabrication that matters here is the opposite of gate 8's: a row
     forging "blocked AND consented" manufactures a clearance. */
  test("malformed answers fail closed, every one of them", async () => {
    const malformed = [
      /* db/004 always returns exactly one row. Zero or two means the caller
         is not talking to the function this code was written against. */
      [SELECT_OK([]), "no rows"],
      [SELECT_OK([readinessRow(), readinessRow()]), "two rows"],
      /* A consent key with no timestamp, or the reverse, is half an answer
         and both halves are written into the clearance. */
      [SELECT_OK([readinessRow({ at: null })]), "key without a timestamp"],
      [SELECT_OK([readinessRow({ key: null })]), "timestamp without a key"],
      /* A key that cannot have come from this system. */
      [SELECT_OK([readinessRow({ key: "not-a-key" })]), "malformed key"],
      [SELECT_OK([readinessRow({ key: "website:s:ai_voice:consent_selected" })]), "other lane"],
      [SELECT_OK([readinessRow({ key: "website:s:sms:consent_not_selected" })]), "not a grant"],
    ];
    for (const [response, label] of malformed) {
      neonFetch([response]);
      await assert.rejects(
        () => lookupReoptinReadiness(PHONE, { channel: CHANNEL.SMS, env }),
        (err) => err.token === REOPTIN_ERROR.MALFORMED_RESPONSE,
        `${label} did not fail closed`);
    }
  });
});

/* =====================================================================
   5  THE HUBSPOT PROJECTION
   ===================================================================== */
describe("toHubSpotReoptinGrantProperties", () => {
  const consent = {
    occurredAt: CONSENT_AT, phone: PHONE, version: "CST_SMS_CONSENT_2026_09_V1",
    formType: "home_value", pagePath: "/home-value",
  };

  /* TEST 13 — one transition, both halves, and nothing else. */
  test("it clears the suppression AND grants, bound to the durable consent", () => {
    const props = toHubSpotReoptinGrantProperties({ channel: "sms", consent });
    assert.equal(props[SUPPRESSION_PROPERTIES.smsSuppressed], "false");
    assert.equal(props[SUPPRESSION_PROPERTIES.smsSuppressedAt], "");
    assert.equal(props[SUPPRESSION_PROPERTIES.smsSuppressionReason], "");
    assert.equal(props[SMS_STATE_PROPERTIES.status], PERMISSION_STATE.GRANTED);
    assert.equal(props[SMS_STATE_PROPERTIES.at], CONSENT_AT);
    assert.equal(props[SMS_STATE_PROPERTIES.phone], PHONE);
    assert.equal(props[SMS_STATE_PROPERTIES.version], consent.version);
  });

  /* TEST 8 — SMS AND AI VOICE ARE COMPLETELY SEPARATE. */
  test("it never writes a voice or a global property", () => {
    const props = toHubSpotReoptinGrantProperties({ channel: "sms", consent });
    for (const name of [
      ...Object.values(AI_VOICE_STATE_PROPERTIES),
      SUPPRESSION_PROPERTIES.doNotCall, SUPPRESSION_PROPERTIES.doNotCallAt,
      SUPPRESSION_PROPERTIES.doNotCallReason,
      SUPPRESSION_PROPERTIES.doNotContact, SUPPRESSION_PROPERTIES.doNotContactAt,
      SUPPRESSION_PROPERTIES.doNotContactReason,
    ])
      assert.ok(!(name in props), `${name} was written by an SMS re-opt-in`);
  });

  test("it leaves the re-opt-in request properties alone", () => {
    const props = toHubSpotReoptinGrantProperties({ channel: "sms", consent });
    for (const name of Object.values(REOPTIN_PROPERTIES))
      assert.ok(!(name in props), `${name} was overwritten`);
  });

  test("no lane but sms can be projected", () => {
    for (const channel of ["ai_voice", "all", "", undefined])
      assert.throws(() => toHubSpotReoptinGrantProperties({ channel, consent }));
  });

  /* A GRANT THAT CANNOT BE TIED TO A DISCLOSURE IS NOT WRITTEN. */
  test("a blank timestamp, number or version throws rather than granting", () => {
    for (const over of [{ occurredAt: "" }, { occurredAt: "nope" },
                        { phone: "" }, { version: "" }])
      assert.throws(() => toHubSpotReoptinGrantProperties({
        channel: "sms", consent: { ...consent, ...over },
      }), `${JSON.stringify(over)} produced a grant`);
  });
});

/* =====================================================================
   6  THE CONSENT MODEL IS UNCHANGED WHERE IT SHOULD BE
   ===================================================================== */
describe("the website fold, unchanged", () => {
  const evidenceFor = (granted, phone = PHONE) => buildConsentEvidence({
    lead: {
      form_type: "home_value", phone,
      sms_consent: granted, ai_voice_consent: false,
    },
    meta: { submitted_at: CONSENT_AT, page: "/home-value", submission_id: "sub-abc-123" },
  });

  /* TEST 1 */
  test("never granted plus a ticked box grants", () => {
    const next = applySubmissionConsent({}, evidenceFor(true));
    assert.equal(next.sms.status, PERMISSION_STATE.GRANTED);
    assert.equal(next.sms.outcome, "granted");
  });

  /* TEST 2 */
  test("granted plus a ticked box refreshes the consent", () => {
    const prior = { sms: { status: PERMISSION_STATE.GRANTED, consent_version: "old" } };
    const next = applySubmissionConsent(prior, evidenceFor(true));
    assert.equal(next.sms.status, PERMISSION_STATE.GRANTED);
    assert.equal(next.sms.consent_version, "CST_SMS_CONSENT_2026_09_V1");
    assert.equal(next.sms.changed, true);
  });

  /* TEST 3 — an unticked box is NEVER a revocation and NEVER a re-opt-in. */
  test("suppressed plus an unticked box stays suppressed and requests nothing", () => {
    const prior = { sms: { status: PERMISSION_STATE.SUPPRESSED } };
    const next = applySubmissionConsent(prior, evidenceFor(false));
    assert.equal(next.sms.status, PERMISSION_STATE.SUPPRESSED);
    assert.equal(next.sms.outcome, "no_new_consent");
    assert.equal(next.sms.pending_reoptin, undefined);
    assert.equal(toHubSpotConsentProperties(next, evidenceFor(false))[REOPTIN_PROPERTIES.at],
      undefined);
  });

  /* TEST 5 — and it is a REQUEST, not a clearance. */
  test("suppressed plus a ticked box records a request and clears nothing", () => {
    const prior = { sms: { status: PERMISSION_STATE.SUPPRESSED }, suppression: { sms: { reason: "stop_keyword" } } };
    const next = applySubmissionConsent(prior, evidenceFor(true));
    assert.equal(next.sms.status, PERMISSION_STATE.SUPPRESSED);
    assert.equal(next.sms.outcome, "pending_reoptin");
    assert.equal(next.sms.changed, false);
    assert.deepEqual(next.suppression, { sms: { reason: "stop_keyword" } });

    /* TEST 19, first half — the browser's ONLY input is the checkbox, and a
       ticked one writes the two request properties and NO grant and NO
       suppression change. */
    const props = toHubSpotConsentProperties(next, evidenceFor(true));
    assert.equal(props[REOPTIN_PROPERTIES.channel], "sms");
    assert.ok(!(SMS_STATE_PROPERTIES.status in props), "a form submission granted through a STOP");
    assert.ok(!(SUPPRESSION_PROPERTIES.smsSuppressed in props),
      "a form submission wrote a suppression property");
  });

  /* TEST 8 — voice is not dragged along by an SMS decision. */
  test("an SMS re-opt-in request never touches the voice channel", () => {
    const prior = {
      sms: { status: PERMISSION_STATE.SUPPRESSED },
      ai_voice: { status: PERMISSION_STATE.SUPPRESSED },
    };
    const next = applySubmissionConsent(prior, evidenceFor(true));
    assert.equal(next.ai_voice.status, PERMISSION_STATE.SUPPRESSED);
    assert.equal(next.ai_voice.outcome, "no_new_consent");
  });
});

/* =====================================================================
   7  GATE 8 BEFORE AND AFTER — THE POINT OF THE WHOLE EXERCISE
   ===================================================================== */
describe("send-time authorization across the transition", () => {
  const env = { [FEATURE_FLAG]: "true" };
  const suppressedState = {
    sms: { status: PERMISSION_STATE.SUPPRESSED, consent_phone: PHONE },
    suppression: { sms: { reason: "stop_keyword", at: BLOCKED_AT } },
  };
  const grantedState = {
    sms: {
      status: PERMISSION_STATE.GRANTED, consent_phone: PHONE,
      consent_at: CONSENT_AT, consent_version: "CST_SMS_CONSENT_2026_09_V1",
    },
    suppression: {},
  };

  /* TEST 14 — and TEST 4: a ticked box while suppressed cannot send. */
  test("gate 8 denies while the durable block stands", () => {
    const decision = canSendSms(suppressedState, PHONE, {
      env, consentStateAvailable: true,
      durableSuppression: { status: "ok", channels: ["sms"] },
    });
    assert.deepEqual(decision, { allowed: false, reason: REASON.DURABLE_SMS_BLOCK });
  });

  test("a pending re-opt-in is still a denial, not a weaker one", () => {
    const pending = {
      ...suppressedState,
      sms: { ...suppressedState.sms, outcome: "pending_reoptin" },
    };
    assert.equal(canSendSms(pending, PHONE, {
      env, consentStateAvailable: true,
      durableSuppression: { status: "ok", channels: ["sms"] },
    }).allowed, false);
  });

  /* TEST 15 — ONLY the later append-only clearance plus the projected grant
     makes this allowed. */
  test("gate 8 allows once the lane is cleared and the grant projected", () => {
    assert.deepEqual(canSendSms(grantedState, PHONE, {
      env, consentStateAvailable: true,
      durableSuppression: { status: "ok", channels: [] },
    }), { allowed: true, reason: REASON.ALLOWED });
  });

  /* TEST 6 — consent binds to the line it was given for, everywhere. */
  test("a cleared lane still refuses a different number", () => {
    assert.deepEqual(canSendSms(grantedState, OTHER_PHONE, {
      env, consentStateAvailable: true,
      durableSuppression: { status: "ok", channels: [] },
    }), { allowed: false, reason: REASON.CONSENT_PHONE_MISMATCH });
  });

  /* TEST 12 — the HubSpot projection alone never unblocks. */
  test("a cleared CRM projection cannot outvote a durable block", () => {
    assert.deepEqual(canSendSms(grantedState, PHONE, {
      env, consentStateAvailable: true,
      durableSuppression: { status: "ok", channels: ["sms"] },
    }), { allowed: false, reason: REASON.DURABLE_SMS_BLOCK });
  });

  /* TEST 18 — no answer from the system of record is not "not suppressed". */
  test("an unavailable durable lookup denies", () => {
    assert.deepEqual(canSendSms(grantedState, PHONE, {
      env, consentStateAvailable: true,
      durableSuppression: { status: "unavailable", channels: [] },
    }), { allowed: false, reason: REASON.SUPPRESSION_LOOKUP_UNAVAILABLE });
  });

  /* TEST 8 — an SMS re-opt-in grants no voice permission, at the gate too. */
  test("the voice channel is untouched by the SMS transition", () => {
    assert.equal(canPlaceAutomatedVoiceCall(grantedState, PHONE, {
      env, consentStateAvailable: true,
      durableSuppression: { status: "ok", channels: [] },
    }).reason, REASON.NO_CONSENT);
  });
});

/* =====================================================================
   8  THE WEBHOOK, END TO END
   ===================================================================== */
describe("the inbound START reconciliation", () => {
  const ENV_KEYS = [
    "TWILIO_AUTH_TOKEN", LEDGER_URL_VAR, REOPTIN_LEDGER_URL_VAR, REOPTIN_FLAG,
    FEATURE_FLAG, "HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PORTAL_ID", "HUBSPOT_FORM_GUID",
  ];
  const SAVED = {};
  let realValidate;

  before(async () => {
    for (const k of ENV_KEYS) SAVED[k] = process.env[k];
    const twilio = (await import("twilio")).default;
    realValidate = twilio.validateRequest;
    /* The signature scheme has its own independent-implementation coverage
       in tests/suppression.test.mjs. Here it is stubbed so the subject is
       the reconciliation, not the HMAC. */
    twilio.validateRequest = () => true;
  });
  after(async () => {
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const twilio = (await import("twilio")).default;
    twilio.validateRequest = realValidate;
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    process.env[LEDGER_URL_VAR] = LEDGER_URL;
    process.env[REOPTIN_LEDGER_URL_VAR] = REOPTIN_URL;
    process.env[REOPTIN_FLAG] = "true";
    process.env[FEATURE_FLAG] = "true";
    /* HubSpot stays UNCONFIGURED so the projection is skipped for a stated
       reason. What these tests are about is the durable transition; the
       property patch has its own section above. */
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  function mockRes() {
    return {
      statusCode: 0, headers: {}, body: "", ended: false,
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
      end(payload) { this.body = payload == null ? "" : String(payload); this.ended = true; },
    };
  }

  function inboundReq(fields) {
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
  }

  /** Drive one webhook and return the response plus every log line. */
  async function call(fields, plan) {
    const sent = neonFetch(plan);
    const real = console.log;
    const lines = [];
    console.log = (...a) => { lines.push(a.map(String).join(" ")); };
    const res = mockRes();
    try { await inboundHandler(inboundReq(fields), res); }
    finally { console.log = real; }
    const events = lines.map((l) => {
      const at = l.indexOf("{");
      if (at === -1) return null;
      try { return JSON.parse(l.slice(at)); } catch { return null; }
    }).filter(Boolean);
    return { res, sent, events, has: (e) => events.find((o) => o.event === e) };
  }

  const START = {
    MessageSid: SID, From: PHONE, Body: "START", AccountSid: "AC1",
    MessagingServiceSid: "MG1", OptOutType: "START",
  };

  /** Statements the ledger actually sent, split by kind. */
  const inserts = (sent) => sent.filter((s) => /^INSERT INTO/.test(s.query));
  const clearances = (sent) =>
    inserts(sent).filter((s) => s.params.includes(EVENT_TYPE.UNSUPPRESSED));

  /* TEST 10 + THE FULL SEQUENCE. */
  test("a provider START beside a fresh consent appends a clearance", async () => {
    const { res, sent, has } = await call(START, (body) =>
      /get_reoptin_readiness/.test(body.query)
        ? SELECT_OK([readinessRow()])
        : INSERT_OK(1));

    assert.equal(res.statusCode, 200);
    /* THE REQUEST IS RECORDED FIRST, THEN THE CLEARANCE. Both appends, and
       the old STOP row is not named by either. */
    const rows = inserts(sent);
    assert.equal(rows.length, 2, "expected the request row and the clearance row");
    assert.ok(rows[0].params.includes(EVENT_TYPE.REOPTIN_REQUESTED));
    const clearance = rows[1];
    assert.ok(clearance.params.includes(EVENT_TYPE.UNSUPPRESSED));
    assert.ok(clearance.params.includes(UNSUPPRESSION_REASON.CONSUMER_REQUEST));
    assert.ok(clearance.params.includes(`${SOURCE_TWILIO}:${SID}:sms:unsuppressed`));
    /* TEST 11 — APPEND ONLY. Nothing updates, deletes or names an earlier
       row; the STOP stands in the ledger forever and is superseded, not
       erased. */
    for (const stmt of sent)
      assert.ok(!/\b(UPDATE|DELETE|TRUNCATE)\b/i.test(stmt.query),
        `a clearance path sent a mutation: ${stmt.query}`);
    /* The clearance names the consent it rests on. */
    const meta = JSON.parse(clearance.params.find(
      (p) => typeof p === "string" && p.includes("reoptin_confirmation")));
    assert.equal(meta.reoptin_confirmation, REOPTIN_CONFIRMATION.TWILIO_START);
    assert.equal(meta.consent_dedupe_key, CONSENT_KEY);
    assert.ok(has("twilio.inbound.reoptin_cleared"));
  });

  /* TEST 9 — the other half of the pair missing means nothing happens. */
  test("a START with no qualifying consent clears nothing", async () => {
    const { res, sent, has } = await call(START, (body) =>
      /get_reoptin_readiness/.test(body.query)
        ? SELECT_OK([readinessRow({ key: null, at: null })])
        : INSERT_OK(1));
    assert.equal(res.statusCode, 200);
    assert.equal(clearances(sent).length, 0);
    assert.equal(has("twilio.inbound.reoptin_declined").reason,
      REOPTIN_DECISION.NO_FRESH_CONSENT);
  });

  test("a START while a global do-not-contact stands clears nothing", async () => {
    const { sent, has } = await call(START, (body) =>
      /get_reoptin_readiness/.test(body.query)
        ? SELECT_OK([readinessRow({ allAt: BLOCKED_AT })])
        : INSERT_OK(1));
    assert.equal(clearances(sent).length, 0);
    assert.equal(has("twilio.inbound.reoptin_declined").reason,
      REOPTIN_DECISION.GLOBAL_BLOCK);
  });

  /* THE ONE LINE THAT KEEPS OUR LEDGER AND TWILIO IN AGREEMENT.
     Our own classifier recognises opt-in words Twilio does not act on. If
     one of those cleared our block, gate 8 would permit a send the provider
     still refuses — our database saying "allowed" while Twilio says "opted
     out", which is the exact split this workflow exists to prevent. */
  test("a locally classified opt-in word never clears a block", async () => {
    for (const body of ["START", "UNSTOP", "YES", "optin", "opt in"]) {
      /* No OptOutType: Advanced Opt-Out did not classify it, so only our own
         keyword layer did. */
      const { sent, has } = await call(
        { MessageSid: SID, From: PHONE, Body: body, AccountSid: "AC1" },
        (b) => /get_reoptin_readiness/.test(b.query)
          ? SELECT_OK([readinessRow()])
          : INSERT_OK(1));
      assert.equal(clearances(sent).length, 0, `${body} cleared a block locally`);
      /* The readiness lookup is not even attempted. */
      assert.ok(!sent.some((s) => /get_reoptin_readiness/.test(s.query)),
        `${body} reached the readiness lookup`);
      assert.equal(has("twilio.inbound.reoptin_skipped").reason, "not_provider_start");
      /* And it is still RECORDED as a request, exactly as before. */
      assert.equal(inserts(sent).length, 1);
      assert.ok(inserts(sent)[0].params.includes(EVENT_TYPE.REOPTIN_REQUESTED));
    }
  });

  /* A STOP IS STILL A STOP. The reconciliation must not touch the
     suppression path at all. */
  test("a STOP still suppresses and reaches no re-opt-in machinery", async () => {
    const { res, sent, has } = await call(
      { ...START, Body: "STOP", OptOutType: "STOP" }, () => INSERT_OK(1));
    assert.equal(res.statusCode, 200);
    const rows = inserts(sent);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].params.includes(EVENT_TYPE.SUPPRESSED));
    assert.ok(!sent.some((s) => /get_reoptin_readiness/.test(s.query)));
    assert.equal(has("twilio.inbound.reoptin_skipped"), undefined,
      "the suppression path consulted the re-opt-in reconciliation");
  });

  test("HELP is still informational and writes nothing", async () => {
    const { res, sent } = await call(
      { ...START, Body: "HELP", OptOutType: "HELP" }, () => INSERT_OK(1));
    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 0);
  });

  /* TEST 16 — A REPLAYED START CREATED NO TRANSITION NOW. */
  test("a replayed START appends nothing new and projects nothing", async () => {
    const { res, sent, has } = await call(START, (body) =>
      /get_reoptin_readiness/.test(body.query)
        ? SELECT_OK([readinessRow()])
        /* ON CONFLICT DO NOTHING: the rows are already there. */
        : INSERT_OK(0));
    assert.equal(res.statusCode, 200);
    /* The statement is still sent — that is what makes it idempotent — but
       it inserted nothing, and nothing downstream may act as though it had. */
    assert.equal(clearances(sent).length, 1);
    assert.equal(has("twilio.inbound.reoptin_cleared"), undefined,
      "a replay was reported as a fresh clearance");
    assert.equal(has("twilio.inbound.reoptin_replay").rows_affected, 0);
  });

  test("a driver that does not report a row count is not a clearance", async () => {
    const { has } = await call(START, (body) =>
      /get_reoptin_readiness/.test(body.query)
        ? SELECT_OK([readinessRow()])
        : ({ command: "INSERT", rowAsArray: true, fields: [], rows: [] }));
    assert.equal(has("twilio.inbound.reoptin_cleared"), undefined,
      "a silent driver was read as a successful append");
    assert.ok(has("twilio.inbound.reoptin_replay"));
  });

  /* TEST 17 / 18 — EVERY DEPENDENCY FAILURE LEAVES THE SUPPRESSION ALONE,
     and none of them fails the webhook: the record this endpoint exists to
     make is already durable by then. */
  test("a readiness lookup failure fails closed and still answers 200", async () => {
    const { res, sent, has } = await call(START, (body) =>
      /get_reoptin_readiness/.test(body.query)
        ? new Error("connect ECONNREFUSED")
        : INSERT_OK(1));
    assert.equal(res.statusCode, 200);
    assert.equal(clearances(sent).length, 0);
    assert.equal(has("twilio.inbound.reoptin_failed").stage, "lookup");
  });

  test("a readiness lookup that stalls fails closed", async () => {
    const { res, sent, has } = await call(START, (body) =>
      /get_reoptin_readiness/.test(body.query) ? 10_000 : INSERT_OK(1));
    assert.equal(res.statusCode, 200);
    assert.equal(clearances(sent).length, 0);
    assert.equal(has("twilio.inbound.reoptin_failed").stage, "lookup");
    assert.equal(has("twilio.inbound.reoptin_failed").reoptin_error, REOPTIN_ERROR.TIMEOUT);
  });

  test("a clearance append failure projects nothing", async () => {
    const { res, has } = await call(START, (body) => {
      if (/get_reoptin_readiness/.test(body.query)) return SELECT_OK([readinessRow()]);
      if (body.params.includes(EVENT_TYPE.UNSUPPRESSED)) return new Error("write failed");
      return INSERT_OK(1);
    });
    assert.equal(res.statusCode, 200);
    assert.equal(has("twilio.inbound.reoptin_failed").stage, "append");
    assert.equal(has("twilio.inbound.reoptin_cleared"), undefined);
  });

  /* THE REQUEST ROW MUST BE DURABLE BEFORE ANY OF THIS RUNS. */
  test("a failed request append answers 503 and reconciles nothing", async () => {
    const { res, sent, has } = await call(START, () => new Error("ledger down"));
    assert.equal(res.statusCode, 503);
    assert.ok(!sent.some((s) => /get_reoptin_readiness/.test(s.query)));
    assert.equal(has("twilio.inbound.reoptin_skipped"), undefined);
  });

  /* PRODUCTION-EQUIVALENCE WITH THE FEATURE OFF. */
  test("with the flag off the endpoint behaves exactly as before", async () => {
    delete process.env[REOPTIN_FLAG];
    const { res, sent, has } = await call(START, () => INSERT_OK(1));
    assert.equal(res.statusCode, 200);
    assert.equal(inserts(sent).length, 1);
    assert.ok(inserts(sent)[0].params.includes(EVENT_TYPE.REOPTIN_REQUESTED));
    assert.ok(!sent.some((s) => /get_reoptin_readiness/.test(s.query)));
    assert.equal(has("twilio.inbound.reoptin_skipped").reason, "disabled");
  });

  test("with the flag on but no credential nothing is attempted", async () => {
    delete process.env[REOPTIN_LEDGER_URL_VAR];
    const { sent, has } = await call(START, () => INSERT_OK(1));
    assert.equal(clearances(sent).length, 0);
    assert.equal(has("twilio.inbound.reoptin_skipped").reason, "not_configured");
  });

  test("with the consent feature off nothing is attempted", async () => {
    delete process.env[FEATURE_FLAG];
    const { res, sent, has } = await call(START, () => INSERT_OK(1));
    assert.equal(res.statusCode, 200);
    assert.equal(clearances(sent).length, 0);
    assert.equal(has("twilio.inbound.reoptin_skipped").reason, "consent_disabled");
  });

  /* TEST 19 — THE BROWSER SUPPLIES NOTHING BUT A CHECKBOX. There is no
     request field, header or body value that can reach the clearance: the
     webhook's inputs are Twilio's, and the consent it reads is one the
     SERVER wrote. Proven by feeding the webhook every flag a forger would
     try. */
  test("no request field can manufacture a clearance", async () => {
    const forged = {
      MessageSid: SID, From: PHONE, Body: "I would like texts again please",
      AccountSid: "AC1",
      unsuppress: "true", reoptin: "true", OptOutType: "",
      cst_sms_suppressed: "false", sms_consent: "true",
      reason_code: "consumer_request", event_type: "unsuppressed",
      source: "operator", consent_dedupe_key: CONSENT_KEY,
    };
    const { sent } = await call(forged, (body) =>
      /get_reoptin_readiness/.test(body.query)
        ? SELECT_OK([readinessRow()])
        : INSERT_OK(1));
    assert.equal(clearances(sent).length, 0, "a forged field cleared a suppression");
    /* Unclassified, so it is surfaced to a human — and with mail
       unconfigured that is a loud 503, never a silent success. */
    assert.equal(inserts(sent).length, 0);
  });

  test("a forged OptOutType=START still needs the fresh consent", async () => {
    const { sent, has } = await call(
      { ...START, unsuppress: "true" },
      (body) => /get_reoptin_readiness/.test(body.query)
        ? SELECT_OK([readinessRow({ key: null, at: null })])
        : INSERT_OK(1));
    assert.equal(clearances(sent).length, 0);
    assert.equal(has("twilio.inbound.reoptin_declined").reason,
      REOPTIN_DECISION.NO_FRESH_CONSENT);
  });

  /* THE NUMBER THE LOOKUP ASKS ABOUT IS THE SENDER'S, never a field. */
  test("the readiness lookup is keyed by the provider's From and nothing else", async () => {
    const { sent } = await call(
      { ...START, phone: OTHER_PHONE, To: OTHER_PHONE },
      (body) => /get_reoptin_readiness/.test(body.query)
        ? SELECT_OK([readinessRow()])
        : INSERT_OK(1));
    const lookup = sent.find((s) => /get_reoptin_readiness/.test(s.query));
    assert.deepEqual(lookup.params.slice(0, 2), [PHONE, "sms"]);
  });

  /* NOTHING IN THE CONSUMER'S MESSAGE OR NUMBER REACHES A LOG. */
  test("the re-opt-in log lines carry no number and no message", async () => {
    const { events } = await call(
      { ...START, Body: "START please, this is Jane on 419-555-0123" },
      (body) => /get_reoptin_readiness/.test(body.query)
        ? SELECT_OK([readinessRow()])
        : INSERT_OK(1));
    const text = JSON.stringify(events.filter((e) => /reoptin/.test(String(e.event))));
    for (const secret of [PHONE, "4195550123", "Jane", REOPTIN_URL, "secret"])
      assert.ok(!text.includes(secret), `a re-opt-in log line carried ${secret}: ${text}`);
  });
});

/* =====================================================================
   9  THE TIME BUDGET
   =====================================================================
   The reconciliation runs inside api/twilio-inbound.js's ABSOLUTE 10 s
   deadline, measured from handler entry, under a 15 s platform maxDuration
   and Twilio's own ~15 s clock which starts before ours. These are the
   arithmetic facts the comments claim; asserted here so changing a constant
   in the wrong direction fails a test rather than a production webhook. */
describe("the re-opt-in time budget", () => {
  test("whenever the reconciliation runs, a searchable projection survives it", () => {
    assert.ok(
      REOPTIN_LOOKUP_TIMEOUT_MS + REOPTIN_APPEND_TIMEOUT_MS + MIN_SEARCH_MS
        <= REOPTIN_MIN_BUDGET_MS,
      `${REOPTIN_LOOKUP_TIMEOUT_MS} + ${REOPTIN_APPEND_TIMEOUT_MS} + ${MIN_SEARCH_MS} ` +
      `exceeds the ${REOPTIN_MIN_BUDGET_MS}ms floor the reconciliation starts above`);
  });

  test("the floor itself fits inside the absolute projection deadline", () => {
    assert.ok(REOPTIN_MIN_BUDGET_MS < PROJECTION_DEADLINE_MS,
      "the reconciliation could never start");
    /* The existing gate 7 arithmetic, restated with this phase added: the
       body read and the ledger append are both capped, and what is left is
       what this phase is allowed to ask for. */
    assert.ok(WEBHOOK_BODY_TIMEOUT_MS + MIN_SEARCH_MS < PROJECTION_DEADLINE_MS);
    assert.ok(MIN_WRITE_MS <= REOPTIN_APPEND_TIMEOUT_MS);
  });

  test("the freshness window is a bounded number of days", () => {
    const days = REOPTIN_CONSENT_MAX_AGE_SECONDS / 86400;
    assert.ok(Number.isInteger(days) && days > 0 && days <= 30,
      `a ${days}-day arming window is outside the range this design argued for`);
  });
});

/* =====================================================================
   10  THE STATIC GUARDS, PROVEN TO FIRE
   =====================================================================
   A guard nobody has ever seen fail is a guard nobody knows works, and this
   repository has paid for that three times. Each mutation below is a real
   regression in the clearance path, applied to a THROWAWAY COPY of the tree
   — the working tree is never mutated, per CLAUDE.md's testing rules.
   ===================================================================== */
describe("the re-opt-in guards in tools/check.mjs", () => {
  let dir, root;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cst-reoptin-guard-"));
    root = join(dir, "tree");
    for (const item of ["src", "assets", "tools", "api", "db", "package.json",
                        "robots.txt", "site.webmanifest", ".env.example"])
      cpSync(join(REPO, item), join(root, item), { recursive: true });
    execFileSync(process.execPath, ["tools/build.mjs"], { cwd: root, stdio: "pipe" });
  });
  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function runCheck() {
    try {
      execFileSync(process.execPath, ["tools/check.mjs"], { cwd: root, stdio: "pipe" });
      return { ok: true, output: "" };
    } catch (err) {
      return { ok: false, output: String(err.stdout || "") + String(err.stderr || "") };
    }
  }

  const FILES = {
    hook: "api/twilio-inbound.js",
    mod: "api/_lib/reoptin.mjs",
    ledger: "api/_lib/consent-ledger.mjs",
    mig: "db/004_website_reoptin.sql",
  };
  const pristine = (key) => readFileSync(join(REPO, FILES[key]), "utf8");
  const restore = () => {
    for (const key of Object.keys(FILES))
      writeFileSync(join(root, FILES[key]), pristine(key));
  };

  afterEach(restore);

  test("the unmodified tree passes", () => {
    restore();
    const { ok, output } = runCheck();
    assert.ok(ok, "check.mjs rejected the real tree:\n" + output);
  });

  const mutation = (key, from, to, expected) => {
    const src = pristine(key);
    assert.ok(src.includes(from), `the mutation target changed shape in ${FILES[key]}: ${from}`);
    writeFileSync(join(root, FILES[key]), src.replace(from, to));
    const { ok, output } = runCheck();
    assert.ok(!ok, `check.mjs accepted: ${from} -> ${to}`);
    assert.match(output, expected);
  };

  /* WIDENING THE TRIGGER TO OUR OWN CLASSIFIER. This is the regression that
     would split our ledger from Twilio's opt-out state. */
  test("accepting a locally classified opt-in as the trigger is refused", () => {
    mutation("hook",
      'decision.source !== "twilio" || decision.rule !== "opt_out_type_start"',
      'decision.kind !== "reoptin"',
      /OptOutType=START/);
  });

  /* PROJECTING A REPLAY. */
  test("projecting without checking rowsAffected is refused", () => {
    mutation("hook",
      "if (!(Number(result?.rowsAffected) > 0)) {",
      "if (!result?.appended) {",
      /rowsAffected/);
  });

  /* DELETING THE LANE FENCE IN THE LEDGER. */
  test("letting an automatic clearance reach any lane is refused", () => {
    mutation("ledger",
      "if (automatic && !AUTOMATIC_UNSUPPRESSION_CHANNELS.includes(ch))",
      "if (false && !AUTOMATIC_UNSUPPRESSION_CHANNELS_UNUSED.includes(ch))",
      /automatic-clearance lane fence/);
  });

  /* DELETING THE SOURCE FENCE — "only a human may lift a block" becoming
     "anyone may". */
  test("letting any source write a clearance is refused", () => {
    mutation("ledger",
      "if (automatic && !AUTOMATIC_UNSUPPRESSION_SOURCES.includes(src))",
      "if (false)",
      /automatic-clearance source fence/);
  });

  /* THE SQL TIE. `>` becoming `>=` lets a form filled at the instant of a
     STOP supersede it. */
  test("a non-strict post-dating rule in db/004 is refused", () => {
    mutation("mig",
      "AND e.occurred_at > bar.occurred_bar",
      "AND e.occurred_at >= bar.occurred_bar",
      /STRICTLY post-date/);
  });

  /* THE SECOND CLOCK. Dropping it discards a delayed or redelivered STOP. */
  test("folding on event time alone in db/004 is refused", () => {
    mutation("mig",
      "AND e.recorded_at > bar.recorded_bar",
      "AND true",
      /second clock/);
  });

  /* THE DOMINATING LANE. */
  test("ignoring the global lane in the refusal bar is refused", () => {
    mutation("mig",
      "WHERE b.channel = p_channel OR b.channel = 'all'",
      "WHERE b.channel = p_channel",
      /global do-not-contact/);
  });

  /* THE RECORD OF NOT TICKING READ AS A GRANT. */
  test("dropping the consent_selected scope in db/004 is refused", () => {
    mutation("mig",
      "AND e.event_type  = 'consent_selected'",
      "AND e.event_type IS NOT NULL",
      /consent_selected/);
  });

  /* THE ARMING WINDOW. */
  test("dropping the freshness window in db/004 is refused", () => {
    mutation("mig",
      "AND e.occurred_at >= now() - make_interval(secs => p_max_age_seconds)",
      "AND true",
      /freshness window/);
  });

  /* THE CREDENTIAL SEPARATION db/002 states and db/004 must not undo. */
  test("granting the readiness lookup to the website role is refused", () => {
    mutation("mig",
      "GRANT  EXECUTE ON FUNCTION get_reoptin_readiness(text, text, integer) TO <reoptin_role>;",
      "GRANT  EXECUTE ON FUNCTION get_reoptin_readiness(text, text, integer) TO <reoptin_role>;\n" +
      "GRANT  EXECUTE ON FUNCTION get_reoptin_readiness(text, text, integer) TO <application_role>;",
      /belongs to the dedicated re-opt-in credential alone/);
  });

  /* THE BOUND BOUNDARY. */
  test("a module-scope mutable readiness executor is refused", () => {
    mutation("mod",
      "const GATE = makeGate({ executor: neonExecutor });",
      "let executor = neonExecutor;\nconst GATE = makeGate({ executor: neonExecutor });",
      /module-scope mutable executor/);
  });

  test("turning the flag into a truthy test is refused", () => {
    mutation("mod",
      'return env?.[REOPTIN_FLAG] === "true";',
      "return Boolean(env?.[REOPTIN_FLAG]);",
      /exact "true" comparison|typo/);
  });
});

/* =====================================================================
   11  TEST 20 — THERE IS STILL EXACTLY ONE OUTBOUND SMS PATH
   =====================================================================
   This change adds a ledger write and a CRM patch. It must not have added
   a way to SEND anything, and it must not have widened the one that exists.
   ===================================================================== */
describe("no second outbound path", () => {
  /* EXECUTABLE CODE ONLY. Both modules explain at length what they are NOT
     allowed to reach, and a rule that tripped on its own documentation would
     simply get the documentation deleted. */
  const code = (rel) => readFileSync(join(REPO, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  test("the re-opt-in module cannot send and cannot authorize a send", () => {
    const src = code("api/_lib/reoptin.mjs");
    for (const forbidden of [
      "sms-sender.mjs", "lead-sms-ack.mjs", "send-permission.mjs",
      "messages.create", 'from "twilio"', "TWILIO_AUTH_TOKEN",
      "canSendSms", "canPlaceAutomatedVoiceCall",
    ])
      assert.ok(!src.includes(forbidden),
        `api/_lib/reoptin.mjs references ${forbidden}`);
  });

  test("the inbound webhook still imports no sender", () => {
    const src = code("api/twilio-inbound.js");
    for (const forbidden of ["sms-sender.mjs", "lead-sms-ack.mjs"])
      assert.ok(!src.includes(forbidden),
        `api/twilio-inbound.js imports ${forbidden}`);
  });

  /* The existing guard that owns this invariant must still run and pass —
     it is what actually enforces it, and this is a statement that the
     enforcement was not disabled by this change. */
  test("the outbound / gate 8 guards still pass on this tree", () => {
    execFileSync(process.execPath, ["tools/check-sms-sender.mjs"],
      { cwd: REPO, stdio: "pipe" });
  });
});
