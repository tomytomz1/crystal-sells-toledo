/* Ledger hardening — the closed vocabularies, the `unsuppressed` contract,
   and real rows-affected reporting.
   =====================================================================
   docs/updates/2026-09-15-unsuppression-reoptin-decision.md §12.1, §12.2
   and the replay-after-re-suppression hazard in §9.1.

   THREE THINGS ARE PROVED HERE, and they are not equally easy:

   1  A typo'd event_type or channel is REFUSED BEFORE ANY DATABASE CALL.
      Pure, and asserted from the executor's side: the seam records every
      statement the module would send, so "no write was attempted" is a
      measurement rather than an inference from a thrown error.

   2  An `unsuppressed` row carries the contract the fold in db/003
      actually reads. Pure.

   3  appendSuppressionEvents() reports what POSTGRES DID, not what it was
      handed. This one cannot be proved by a mock alone, and the last
      section does not try to: it drives THIS MODULE'S REAL PRODUCTION
      PATH — the real @neondatabase/serverless driver, its real result
      parsing — against a local HTTP endpoint speaking Neon's wire format
      whose row counts come from a REAL PostgreSQL running the real
      statement. The number asserted at the end of that chain is a number
      Postgres produced.
   ===================================================================== */

import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CHANNEL, EVENT_TYPE, SOURCE_TWILIO, SOURCE_OPERATOR, SOURCE_WEBSITE,
  SUPPRESSION_EVENT_TYPES, SUPPRESSION_CHANNELS,
  LEDGER_URL_VAR, LEDGER_EVIDENCE_INCOMPLETE, LEDGER_APPEND_FAILED,
  buildSuppressionEvent, appendSuppressionEvents, rowsAffectedOf,
  dedupeKey, _setExecutor, _resetExecutor,
} from "../api/_lib/consent-ledger.mjs";
import {
  UNSUPPRESSION_REASON, UNSUPPRESSION_ERROR_ORIGIN,
} from "../api/_lib/consent.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = { [LEDGER_URL_VAR]: "postgres://app:secret@ledger.example/neondb" };
const PHONE = "+14195550147";

/** Capture every statement the module would send, and answer as told. */
function captureExecutor({ result = [], fail = null } = {}) {
  const calls = [];
  _setExecutor(async (text, params, opts) => {
    calls.push({ text, params, opts });
    if (fail) throw fail;
    return typeof result === "function" ? result(calls.length) : result;
  });
  return calls;
}

/** A valid suppression event, overridable one field at a time. */
function suppression(over = {}) {
  return buildSuppressionEvent({
    occurredAt: "2026-09-15T10:00:00Z",
    channel: CHANNEL.SMS,
    eventType: EVENT_TYPE.SUPPRESSED,
    phone: PHONE,
    source: SOURCE_TWILIO,
    sourceEventId: "SM_" + (over.sourceEventId || "base"),
    ...over,
  });
}

/** The arguments for an unsuppression, valid unless a test breaks one. */
function unsuppressionArgs(over = {}) {
  return {
    occurredAt: "2026-09-15T12:00:00Z",
    channel: CHANNEL.SMS,
    eventType: EVENT_TYPE.UNSUPPRESSED,
    phone: PHONE,
    source: SOURCE_OPERATOR,
    sourceEventId: "approval_1",
    reasonCode: UNSUPPRESSION_REASON.CONSUMER_REQUEST,
    metadata: { approval_id: "approval_1", invalidates: [] },
    ...over,
  };
}

/** A well-formed dedupe_key for a blocking event in `channel`. */
const blockingKey = (channel = CHANNEL.SMS, id = "SM1", type = EVENT_TYPE.SUPPRESSED) =>
  dedupeKey({ source: SOURCE_TWILIO, sourceEventId: id, channel, eventType: type });

/** Assert the refusal happened AND that it refused for the stated reason.
 *  assert.throws() does not hand back the error, and a test that only
 *  asserted "it threw" would pass for a refusal on the wrong field. */
function caught(fn) {
  try { fn(); } catch (err) { return err; }
  return assert.fail("expected a refusal, but the value was accepted");
}

const refuses = (fn, detail) => {
  const err = caught(fn);
  assert.equal(err.token, LEDGER_EVIDENCE_INCOMPLETE,
    `refused with ${err.token}, expected ${LEDGER_EVIDENCE_INCOMPLETE}`);
  assert.equal(err.detail, detail, `refused, but for "${err.detail}" not "${detail}"`);
  return err;
};

afterEach(() => _resetExecutor());

/* =====================================================================
   1  THE CLOSED EVENT-TYPE VOCABULARY
   ===================================================================== */
describe("closed event_type vocabulary", () => {
  test("every suppression-path event type is accepted", () => {
    for (const type of SUPPRESSION_EVENT_TYPES) {
      const extra = type === EVENT_TYPE.UNSUPPRESSED
        ? { reasonCode: UNSUPPRESSION_REASON.CONSUMER_REQUEST, metadata: { invalidates: [] },
            source: SOURCE_OPERATOR }
        : {};
      assert.equal(suppression({ eventType: type, ...extra }).event_type, type);
    }
  });

  test("the four are exactly suppressed, revoked, reoptin_requested, unsuppressed", () => {
    assert.deepEqual([...SUPPRESSION_EVENT_TYPES].sort(),
      ["reoptin_requested", "revoked", "suppressed", "unsuppressed"]);
  });

  /* THE DEFECT THIS CLOSES. Before 15 September 2026 requireText() accepted
     any non-empty string, so each of these was written successfully into an
     append-only table and then matched no fold, forever. */
  for (const typo of ["supressed", "revoke", "unsupressed", "SUPPRESSED",
                      "stop", "opt_out", "suppressed;drop", "1"]) {
    test(`an unknown event_type is refused: ${JSON.stringify(typo)}`, () => {
      refuses(() => suppression({ eventType: typo }), "event_type:unknown");
    });
  }

  /* Deliberately narrower than EVENT_TYPE: these two are real members of
     the enum and belong only to the website form path. A suppression row
     claiming one would assert a consent decision no visitor made — which a
     vocabulary built from Object.values(EVENT_TYPE) would have allowed. */
  for (const websiteOnly of [EVENT_TYPE.CONSENT_SELECTED, EVENT_TYPE.CONSENT_NOT_SELECTED]) {
    test(`the website-only event type ${websiteOnly} is refused`, () => {
      refuses(() => suppression({ eventType: websiteOnly }), "event_type:unknown");
      assert.ok(Object.values(EVENT_TYPE).includes(websiteOnly),
        "this test is vacuous unless the value really is a member of EVENT_TYPE");
    });
  }

  /* SURROUNDING WHITESPACE IS TRIMMED, NOT REFUSED — and that is the safe
     direction, not a hole. requireText() has trimmed every field in this
     module since gate 3, so " suppressed " lands on the CANONICAL value
     and the row is readable by every fold. The alternative — validating
     before trimming — would insert "suppressed " as a distinct string that
     matches nothing, which is the exact defect this vocabulary closes.
     What is refused is an UNKNOWN value, and trimming cannot create one. */
  test("surrounding whitespace is trimmed onto the canonical value", () => {
    assert.equal(suppression({ eventType: "  suppressed  " }).event_type, "suppressed");
    assert.equal(suppression({ channel: " sms " }).channel, "sms");
    /* And trimming still cannot rescue an unknown value. */
    refuses(() => suppression({ eventType: "  supressed  " }), "event_type:unknown");
    refuses(() => suppression({ channel: "  voice  " }), "channel:unknown");
  });

  /* Internal whitespace is NOT trimmed away, so it stays unknown. */
  test("internal whitespace is still an unknown value", () => {
    refuses(() => suppression({ eventType: "sup pressed" }), "event_type:unknown");
    refuses(() => suppression({ channel: "ai voice" }), "channel:unknown");
  });

  test("an absent or blank event_type is still refused as incomplete", () => {
    refuses(() => suppression({ eventType: "" }), "event_type");
    refuses(() => suppression({ eventType: null }), "event_type");
    refuses(() => suppression({ eventType: undefined }), "event_type");
  });

  test("the refusal names the FIELD and never echoes the value", () => {
    const err = caught(() => suppression({ eventType: "+14195550147" }));
    assert.equal(err.detail, "event_type:unknown");
    assert.ok(!err.message.includes("4195550147"), "the rejected value leaked into the message");
  });
});

/* =====================================================================
   2  THE CLOSED CHANNEL VOCABULARY
   ===================================================================== */
describe("closed channel vocabulary", () => {
  test("the three lanes are accepted", () => {
    for (const ch of SUPPRESSION_CHANNELS)
      assert.equal(suppression({ channel: ch }).channel, ch);
    assert.deepEqual([...SUPPRESSION_CHANNELS].sort(), ["ai_voice", "all", "sms"]);
  });

  for (const typo of ["voice", "SMS", "ai-voice", "aivoice", "email", "*", "any"]) {
    test(`an unknown channel is refused: ${JSON.stringify(typo)}`, () => {
      refuses(() => suppression({ channel: typo }), "channel:unknown");
    });
  }

  test("an absent channel is refused as incomplete", () => {
    refuses(() => suppression({ channel: "" }), "channel");
  });
});

/* =====================================================================
   3  NO WRITE IS ATTEMPTED — asserted from the executor's side
   =====================================================================
   The point of validating in the builder is that the refusal happens
   BEFORE the database is reached. A thrown error does not prove that on
   its own, so this measures it at the seam. */
describe("an unknown value never reaches the database", () => {
  test("a typo'd event_type sends no statement", async () => {
    const calls = captureExecutor();
    assert.throws(() => suppression({ eventType: "supressed" }));
    assert.equal(calls.length, 0, "a statement was sent for a refused event type");
  });

  test("a typo'd channel sends no statement", async () => {
    const calls = captureExecutor();
    assert.throws(() => suppression({ channel: "voice" }));
    assert.equal(calls.length, 0, "a statement was sent for a refused channel");
  });

  test("a malformed unsuppression sends no statement", async () => {
    const calls = captureExecutor();
    assert.throws(() => buildSuppressionEvent(unsuppressionArgs({ reasonCode: "because" })));
    assert.equal(calls.length, 0, "a statement was sent for a refused unsuppression");
  });

  /* And the whole path stays closed: even if a caller ignored the throw and
     tried to append, there is no event object to append. */
  test("appendSuppressionEvents refuses an empty batch rather than sending an empty INSERT", async () => {
    const calls = captureExecutor();
    await assert.rejects(() => appendSuppressionEvents([], { env: ENV }),
      { token: LEDGER_EVIDENCE_INCOMPLETE });
    assert.equal(calls.length, 0);
  });
});

/* =====================================================================
   4  `unsuppressed` IS FORMALLY ADMITTED
   ===================================================================== */
describe("unsuppressed is a first-class suppression-ledger event", () => {
  test("it is in the builder's closed vocabulary, not merely in the enum", () => {
    assert.ok(SUPPRESSION_EVENT_TYPES.includes(EVENT_TYPE.UNSUPPRESSED));
  });

  test("a consumer_request unsuppression builds a complete row", () => {
    const row = buildSuppressionEvent(unsuppressionArgs());
    assert.equal(row.event_type, "unsuppressed");
    assert.equal(row.channel, "sms");
    assert.equal(row.reason_code, "consumer_request");
    assert.equal(row.phone_e164, PHONE);
    assert.equal(row.source, SOURCE_OPERATOR);
    assert.equal(row.dedupe_key, "operator:approval_1:sms:unsuppressed");
    /* It is about a number, not a submission, and agrees to no disclosure. */
    assert.equal(row.submission_id, null);
    assert.equal(row.consent_copy_version, null);
    assert.equal(row.consent_copy_text, null);
  });

  test("a recorded_in_error unsuppression builds a complete row", () => {
    const key = blockingKey(CHANNEL.SMS, "SM9");
    const row = buildSuppressionEvent(unsuppressionArgs({
      reasonCode: UNSUPPRESSION_REASON.RECORDED_IN_ERROR,
      metadata: { error_origin: UNSUPPRESSION_ERROR_ORIGIN.CLASSIFIER, invalidates: [key] },
    }));
    assert.equal(row.reason_code, "recorded_in_error");
    assert.deepEqual(JSON.parse(row.metadata).invalidates, [key]);
    assert.equal(JSON.parse(row.metadata).error_origin, "classifier");
  });

  test("an unsuppression may never claim to come from the website", () => {
    refuses(() => buildSuppressionEvent(unsuppressionArgs({ source: SOURCE_WEBSITE })),
      "source:website");
  });

  /* FOUND IN ADVERSARIAL REVIEW, 15 September 2026. Refusing only
     SOURCE_WEBSITE left `twilio` and `retell` able to format a valid
     clearance — so an inbound webhook could lift the suppression a STOP had
     just created. The design's FIRST decision is that no automatic path
     writes `unsuppressed` (§4.1, §11). */
  test("ONLY the operator may lift a block — no automated source may", () => {
    for (const src of [SOURCE_TWILIO, "retell", "system", "classifier", "cron"])
      refuses(() => buildSuppressionEvent(unsuppressionArgs({ source: src })),
        "source:not_operator");
    assert.equal(buildSuppressionEvent(unsuppressionArgs()).source, SOURCE_OPERATOR);
  });

  test("the operator-only rule applies to a suppression path that may still use twilio", () => {
    /* The restriction is specific to `unsuppressed`; an ordinary suppression
       from Twilio must keep working, or gate 7 breaks. */
    assert.equal(suppression({ source: SOURCE_TWILIO }).source, SOURCE_TWILIO);
  });

  test("the vocabularies are frozen", () => {
    for (const v of [UNSUPPRESSION_REASON, UNSUPPRESSION_ERROR_ORIGIN,
                     SUPPRESSION_EVENT_TYPES, SUPPRESSION_CHANNELS])
      assert.ok(Object.isFrozen(v));
    assert.deepEqual(Object.values(UNSUPPRESSION_REASON),
      ["consumer_request", "recorded_in_error"]);
    assert.deepEqual(Object.values(UNSUPPRESSION_ERROR_ORIGIN),
      ["operator", "classifier", "system", "undetermined"]);
  });
});

/* =====================================================================
   5  UNSUPPRESSION VALIDATION — every rule, failing closed
   ===================================================================== */
describe("unsuppression reason_code", () => {
  test("it is required", () => {
    refuses(() => buildSuppressionEvent(unsuppressionArgs({ reasonCode: null })), "reason_code");
  });

  for (const bad of ["operator_error", "consumer", "mistake", "CONSUMER_REQUEST", "stop_keyword"]) {
    test(`an unknown reason_code fails closed: ${bad}`, () => {
      refuses(() => buildSuppressionEvent(unsuppressionArgs({ reasonCode: bad })),
        "reason_code:unknown");
    });
  }

  /* A suppression reason is not an unsuppression reason. The two
     vocabularies are separate on purpose and must not cross. */
  test("a SUPPRESSION_REASON value is not accepted as an unsuppression reason", () => {
    refuses(() => buildSuppressionEvent(unsuppressionArgs({ reasonCode: "manual" })),
      "reason_code:unknown");
  });
});

describe("unsuppression metadata must be an object", () => {
  for (const [label, value] of [["null", null], ["a string", "invalidates"],
                                ["a number", 7], ["an array", [blockingKey()]],
                                ["a boolean", true]]) {
    test(`metadata as ${label} is refused, never coerced to {}`, () => {
      refuses(() => buildSuppressionEvent(unsuppressionArgs({ metadata: value })), "metadata");
    });
  }

  /* Why coercion would be dangerous rather than merely sloppy: the old
     builder turned any non-object into `{}`, which would have made a
     malformed `recorded_in_error` into one naming nothing. */
  test("a malformed recorded_in_error cannot become one that names nothing", () => {
    refuses(() => buildSuppressionEvent(unsuppressionArgs({
      reasonCode: UNSUPPRESSION_REASON.RECORDED_IN_ERROR, metadata: "oops",
    })), "metadata");
  });
});

describe("consumer_request is a lane clearance and names nothing", () => {
  test("invalidates absent is accepted", () => {
    const row = buildSuppressionEvent(unsuppressionArgs({ metadata: { approval_id: "a" } }));
    assert.equal(JSON.parse(row.metadata).invalidates, undefined);
  });

  test("invalidates [] is accepted", () => {
    const row = buildSuppressionEvent(unsuppressionArgs({ metadata: { invalidates: [] } }));
    assert.deepEqual(JSON.parse(row.metadata).invalidates, []);
  });

  /* THE HAZARD. A targeted correction wearing a lane clearance's reason
     code would be applied by db/003 under the LANE rule — clearing far
     more than the operator named. */
  test("a non-empty invalidates is REFUSED, not ignored", () => {
    refuses(() => buildSuppressionEvent(unsuppressionArgs({
      metadata: { invalidates: [blockingKey()] },
    })), "metadata.invalidates:not_empty");
  });

  test("a non-array invalidates is refused", () => {
    refuses(() => buildSuppressionEvent(unsuppressionArgs({
      metadata: { invalidates: blockingKey() },
    })), "metadata.invalidates");
  });

  test("error_origin is refused: no cause is being asserted", () => {
    refuses(() => buildSuppressionEvent(unsuppressionArgs({
      metadata: { invalidates: [], error_origin: "operator" },
    })), "metadata.error_origin:not_applicable");
  });
});

describe("recorded_in_error is a targeted invalidation", () => {
  const inError = (metadata) => unsuppressionArgs({
    reasonCode: UNSUPPRESSION_REASON.RECORDED_IN_ERROR, metadata,
  });
  const ORIGIN = UNSUPPRESSION_ERROR_ORIGIN.OPERATOR;

  test("error_origin is REQUIRED", () => {
    refuses(() => buildSuppressionEvent(inError({ invalidates: [blockingKey()] })),
      "metadata.error_origin");
  });

  for (const origin of Object.values(UNSUPPRESSION_ERROR_ORIGIN)) {
    test(`error_origin ${origin} is accepted`, () => {
      const row = buildSuppressionEvent(inError({
        error_origin: origin, invalidates: [blockingKey()] }));
      assert.equal(JSON.parse(row.metadata).error_origin, origin);
    });
  }

  for (const bad of ["human", "agent", "OPERATOR", "unknown", "", null, 3]) {
    test(`an unknown error_origin fails closed: ${JSON.stringify(bad)}`, () => {
      const err = caught(() => buildSuppressionEvent(inError({
        error_origin: bad, invalidates: [blockingKey()] })));
      assert.equal(err.token, LEDGER_EVIDENCE_INCOMPLETE);
      assert.match(err.detail, /^metadata\.error_origin/);
    });
  }

  test("invalidates is REQUIRED", () => {
    refuses(() => buildSuppressionEvent(inError({ error_origin: ORIGIN })),
      "metadata.invalidates");
  });

  /* §5.4 rule 3, and the original defect in its mirror image: a
     recorded_in_error naming nothing must never degrade into a clearance. */
  test("an EMPTY invalidates is refused — it must never become a lane clearance", () => {
    refuses(() => buildSuppressionEvent(inError({ error_origin: ORIGIN, invalidates: [] })),
      "metadata.invalidates:empty");
  });

  for (const [label, value] of [["a string", "k"], ["an object", { k: 1 }], ["null", null]]) {
    test(`invalidates as ${label} is refused`, () => {
      refuses(() => buildSuppressionEvent(inError({ error_origin: ORIGIN, invalidates: value })),
        "metadata.invalidates");
    });
  }

  for (const [label, value] of [["a number", 1], ["null", null], ["an object", {}],
                                ["an array", []], ["a boolean", false]]) {
    test(`a non-string target is refused: ${label}`, () => {
      refuses(() => buildSuppressionEvent(inError({ error_origin: ORIGIN, invalidates: [value] })),
        "metadata.invalidates:not_a_key");
    });
  }

  test("a blank target is refused", () => {
    refuses(() => buildSuppressionEvent(inError({ error_origin: ORIGIN, invalidates: ["   "] })),
      "metadata.invalidates:empty_key");
  });

  for (const malformed of ["twilio:SM1:sms", "twilio:SM1:sms:suppressed:extra",
                           "nocolons", "twilio::sms:suppressed", ":SM1:sms:suppressed",
                           "twilio:SM1::suppressed", "twilio:SM1:sms:"]) {
    test(`a malformed dedupe_key is refused: ${JSON.stringify(malformed)}`, () => {
      refuses(() => buildSuppressionEvent(inError({
        error_origin: ORIGIN, invalidates: [malformed] })),
        "metadata.invalidates:malformed_key");
    });
  }

  /* §5.4 rule 2. The lane is readable from the key itself — a dedupe_key is
     source:source_event_id:channel:event_type — so this needs no table
     access, which is the whole reason the rule can live in the builder. */
  test("a CROSS-CHANNEL target is refused", () => {
    refuses(() => buildSuppressionEvent(inError({
      error_origin: ORIGIN, invalidates: [blockingKey(CHANNEL.AI_VOICE)] })),
      "metadata.invalidates:cross_channel");
  });

  test("an `all`-lane key is refused by an `sms`-lane invalidation", () => {
    refuses(() => buildSuppressionEvent(inError({
      error_origin: ORIGIN, invalidates: [blockingKey(CHANNEL.ALL)] })),
      "metadata.invalidates:cross_channel");
  });

  test("one bad target among good ones still refuses the whole event", () => {
    refuses(() => buildSuppressionEvent(inError({
      error_origin: ORIGIN,
      invalidates: [blockingKey(CHANNEL.SMS, "A"), blockingKey(CHANNEL.AI_VOICE, "B")],
    })), "metadata.invalidates:cross_channel");
  });

  /* Case 6a/6b of §5.5: the same rule, applied in the `all` lane. */
  test("an `all`-lane invalidation may name `all`-lane keys", () => {
    const row = buildSuppressionEvent(unsuppressionArgs({
      channel: CHANNEL.ALL,
      reasonCode: UNSUPPRESSION_REASON.RECORDED_IN_ERROR,
      metadata: { error_origin: ORIGIN, invalidates: [blockingKey(CHANNEL.ALL, "DNC1")] },
    }));
    assert.equal(row.channel, "all");
  });

  /* db/003 treats only `suppressed` and `revoked` as blocking, so naming
     anything else is inert there — fail-closed for the consumer, but it
     would let an operator believe she had fixed something. */
  for (const type of [EVENT_TYPE.UNSUPPRESSED, EVENT_TYPE.REOPTIN_REQUESTED,
                      EVENT_TYPE.CONSENT_SELECTED, EVENT_TYPE.CONSENT_NOT_SELECTED]) {
    test(`a target naming a non-blocking event type is refused: ${type}`, () => {
      refuses(() => buildSuppressionEvent(inError({
        error_origin: ORIGIN, invalidates: [blockingKey(CHANNEL.SMS, "X", type)] })),
        "metadata.invalidates:not_a_blocking_event");
    });
  }

  test("both blocking event types are accepted as targets", () => {
    for (const type of [EVENT_TYPE.SUPPRESSED, EVENT_TYPE.REVOKED])
      assert.ok(buildSuppressionEvent(inError({
        error_origin: ORIGIN, invalidates: [blockingKey(CHANNEL.SMS, "Y", type)] })));
  });

  test("a DUPLICATE target is rejected, not silently de-duplicated", () => {
    const k = blockingKey(CHANNEL.SMS, "SAME");
    refuses(() => buildSuppressionEvent(inError({ error_origin: ORIGIN, invalidates: [k, k] })),
      "metadata.invalidates:duplicate");
  });

  test("a duplicate that differs only by surrounding whitespace is still a duplicate", () => {
    const k = blockingKey(CHANNEL.SMS, "SAME");
    refuses(() => buildSuppressionEvent(inError({
      error_origin: ORIGIN, invalidates: [k, "  " + k + "  "] })),
      "metadata.invalidates:duplicate");
  });

  /* FOUND IN ADVERSARIAL REVIEW, 15 September 2026. The builder validated
     the TRIMMED key and stored the RAW one. db/003 joins
     metadata.invalidates to dedupe_key with `=`, so a stored key carrying
     surrounding whitespace matches nothing: the correction is silently
     inert while the operator is told it worked — the exact failure §5.4
     exists to prevent, reintroduced by the validation meant to stop it. */
  test("a target is STORED canonically, not as it was handed in", () => {
    const key = blockingKey(CHANNEL.SMS, "TRIMME");
    const row = buildSuppressionEvent(inError({
      error_origin: ORIGIN, invalidates: ["\t  " + key + "  \n"] }));
    const stored = JSON.parse(row.metadata).invalidates;
    assert.deepEqual(stored, [key]);
    assert.equal(stored[0], key, "db/003 compares with `=`; an untrimmed key matches nothing");
  });

  test("canonicalising the targets does not edit the operator's own words", () => {
    const key = blockingKey(CHANNEL.SMS, "KEEP");
    const row = buildSuppressionEvent(inError({
      error_origin: ORIGIN,
      invalidates: [" " + key + " "],
      attestation: "  she said stop by phone  ",
      approval_id: "ap_1",
      intent: { targets: [{ dedupe_key: key }], observed_active: [], selected_of_active: "1 of 1" },
    }));
    const m = JSON.parse(row.metadata);
    assert.deepEqual(m.invalidates, [key], "the fold-read field is canonical");
    assert.equal(m.attestation, "  she said stop by phone  ",
      "the operator's attestation was edited — only `invalidates` may be rewritten");
    assert.equal(m.approval_id, "ap_1");
    assert.deepEqual(m.intent.targets, [{ dedupe_key: key }]);
  });

  test("a consumer_request's metadata is stored unchanged apart from nothing", () => {
    const row = buildSuppressionEvent(unsuppressionArgs({
      metadata: { approval_id: "ap_2", attestation: "  asked for sms back  ", invalidates: [] },
    }));
    const m = JSON.parse(row.metadata);
    assert.equal(m.attestation, "  asked for sms back  ");
    assert.deepEqual(m.invalidates, []);
  });

  test("several distinct targets are accepted", () => {
    const keys = ["A", "B", "C"].map((i) => blockingKey(CHANNEL.SMS, i));
    const row = buildSuppressionEvent(inError({ error_origin: ORIGIN, invalidates: keys }));
    assert.deepEqual(JSON.parse(row.metadata).invalidates, keys);
  });

  /* WHAT THIS LAYER CANNOT PROVE, asserted so the limit is visible in the
     suite rather than only in a comment. The builder holds no SELECT and
     cannot know whether a well-formed key names a row that exists or is
     active — that is the endpoint's pre-append read (§4.2, §7.4). */
  test("a well-formed key naming no existing row is ACCEPTED here", () => {
    const row = buildSuppressionEvent(inError({
      error_origin: ORIGIN,
      invalidates: [blockingKey(CHANNEL.SMS, "NEVER_EXISTED")],
    }));
    assert.ok(row, "the builder cannot and must not claim to verify existence");
  });
});

/* =====================================================================
   6  rowsAffectedOf — unknown is neither zero nor one
   ===================================================================== */
describe("rowsAffectedOf", () => {
  test("a real count is returned", () => {
    for (const n of [0, 1, 2, 17])
      assert.equal(rowsAffectedOf({ rowCount: n }), n);
  });

  /* Every one of these is a shape a driver, proxy or stub can produce. A
     guess here would be indistinguishable from a measurement. */
  for (const [label, value] of [
    ["the driver's default bare-array result", []],
    ["a populated bare array", [{ a: 1 }]],
    ["null", null],
    ["undefined", undefined],
    ["a result with no rowCount", { rows: [], command: "INSERT" }],
    ["rowCount as a string", { rowCount: "2" }],
    ["rowCount null (pg's own 'not applicable')", { rowCount: null }],
    ["a negative rowCount", { rowCount: -1 }],
    ["a fractional rowCount", { rowCount: 1.5 }],
    ["NaN", { rowCount: NaN }],
    ["Infinity", { rowCount: Infinity }],
    ["a string result", "INSERT 0 2"],
    ["a number result", 2],
  ]) {
    test(`unknown is null, never a guess: ${label}`, () => {
      assert.equal(rowsAffectedOf(value), null);
    });
  }

  test("null fails closed against every `> 0` test a caller would write", () => {
    assert.equal(rowsAffectedOf([]) > 0, false);
    assert.equal(rowsAffectedOf({ rowCount: 0 }) > 0, false);
    assert.equal(rowsAffectedOf({ rowCount: 1 }) > 0, true);
  });
});

/* =====================================================================
   7  THE REPLAY HAZARD — §9.1
   ===================================================================== */
describe("appendSuppressionEvents reports what the database did", () => {
  const one = () => [suppression({ sourceEventId: "replay" })];

  /* A  first append: one row actually inserted. */
  test("A — a genuine append reports rowsAffected 1", async () => {
    captureExecutor({ result: { rowCount: 1, command: "INSERT" } });
    const res = await appendSuppressionEvents(one(), { env: ENV });
    assert.equal(res.rowsAffected, 1);
    assert.equal(res.appended, true);
    assert.equal(res.requested, 1);
  });

  /* B  the same dedupe_key replayed: the INSERT succeeds and affects 0. */
  test("B — a replay succeeds and reports rowsAffected 0", async () => {
    captureExecutor({ result: { rowCount: 0, command: "INSERT" } });
    const res = await appendSuppressionEvents(one(), { env: ENV });
    assert.equal(res.appended, true, "a replay is not an error");
    assert.equal(res.rowsAffected, 0);
  });

  /* C  THE DEFECT ITSELF. The old return value was the INPUT count, which
     is 1 on a genuine append and 1 on a replay that inserted nothing. */
  test("C — a replay does NOT report the input count", async () => {
    captureExecutor({ result: { rowCount: 0, command: "INSERT" } });
    const res = await appendSuppressionEvents(one(), { env: ENV });
    assert.notEqual(res.rowsAffected, 1, "the input count is standing in for a measurement");
    assert.equal(res.rowsAffected, 0);
    assert.equal(res.requested, 1, "`requested` is the input count, and says so");
    assert.notEqual(res.rowsAffected, res.requested,
      "a genuine append and a replay are indistinguishable again");
  });

  /* The question §9 requires to be asked in words, answered as a test. */
  test("an old approval URL replayed after a new STOP cannot report a new clearance", async () => {
    const clearance = [buildSuppressionEvent(unsuppressionArgs({
      sourceEventId: "approval_old",
      metadata: { approval_id: "approval_old", invalidates: [] },
    }))];
    /* The consumer has since sent STOP again; the old URL is replayed. The
       dedupe key is unchanged, so Postgres inserts nothing. */
    captureExecutor({ result: { rowCount: 0, command: "INSERT" } });
    const res = await appendSuppressionEvents(clearance, { env: ENV });
    assert.equal(res.rowsAffected, 0,
      "this layer reported a new clearance for a replay — §9.1 defence 1 is absent");
    assert.equal(res.rowsAffected > 0, false, "a caller gating projection on > 0 would project");
  });

  /* D  a multi-event batch reflects rows inserted, not rows requested. */
  test("D — a partial conflict reports the inserted count, not the batch size", async () => {
    captureExecutor({ result: { rowCount: 1, command: "INSERT" } });
    const batch = [suppression({ sourceEventId: "a" }), suppression({ sourceEventId: "b" })];
    const res = await appendSuppressionEvents(batch, { env: ENV });
    assert.equal(res.requested, 2);
    assert.equal(res.rowsAffected, 1, "the healed-gap case must be visible as a partial");
  });

  test("D2 — a fully new batch reports the full count", async () => {
    captureExecutor({ result: { rowCount: 2, command: "INSERT" } });
    const batch = [suppression({ sourceEventId: "c" }), suppression({ sourceEventId: "d" })];
    const res = await appendSuppressionEvents(batch, { env: ENV });
    assert.equal(res.rowsAffected, 2);
    assert.equal(res.requested, 2);
  });

  /* E  a database error stays a failure and is never flattened to 0. */
  test("E — a driver error throws and is not converted into rowsAffected 0", async () => {
    const boom = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    captureExecutor({ fail: boom });
    await assert.rejects(() => appendSuppressionEvents(one(), { env: ENV }),
      (err) => {
        assert.equal(err.token, LEDGER_APPEND_FAILED);
        assert.equal(err.rowsAffected, undefined, "a failure must not carry a row count at all");
        return true;
      });
  });

  test("E2 — an unconfigured ledger throws rather than reporting 0 rows", async () => {
    captureExecutor({ result: { rowCount: 0 } });
    await assert.rejects(() => appendSuppressionEvents(one(), { env: {} }),
      { token: "CONSENT_LEDGER_NOT_CONFIGURED" });
  });

  /* The silent-driver case: neither a genuine append nor a proven replay. */
  test("a driver that says nothing yields null, which is not 0 and not the input count",
    async () => {
      captureExecutor({ result: [] });
      const res = await appendSuppressionEvents(one(), { env: ENV });
      assert.equal(res.rowsAffected, null);
      assert.equal(res.rowsAffected > 0, false, "unknown must fail closed like a replay");
      assert.notEqual(res.rowsAffected, res.requested);
    });

  test("the legacy `events` field is now the measurement, never the input count", async () => {
    captureExecutor({ result: { rowCount: 0, command: "INSERT" } });
    const res = await appendSuppressionEvents(one(), { env: ENV });
    assert.equal(res.events, 0, "`events` still reported the input count on a replay");
  });
});

/* =====================================================================
   8  BOUNDARY EVIDENCE — the real driver, real Neon wire, real Postgres
   =====================================================================
   Everything above proves the module's logic. None of it proves the claim
   that actually matters: that `rowCount` REACHES this module from a real
   database through the real driver.

   So this section drives api/_lib/consent-ledger.mjs's OWN production
   executor — the lazily imported @neondatabase/serverless, its real
   `fullResults` handling, its real result parsing — against a local HTTP
   endpoint speaking Neon's wire format, whose command tag and row count
   come from a REAL PostgreSQL running the real statement with the real
   parameters. The only stubbed component is the transport peer.

   It is gated on CST_TEST_PG_URL, the same variable the db/003 fold suite
   uses, and CI sets it unconditionally against a postgres:16 service. With
   the variable SET, an unreachable database is a FAILURE, never a skip: a
   suite that skips reports `tests 0`, which is invisible inside npm test's
   aggregate and is the vacuous guard this repository has paid for.
   ===================================================================== */
const PG_URL = String(process.env.CST_TEST_PG_URL || "").trim();
/* A DATABASE AND A ROLE OF THIS SUITE'S OWN, and the role name matters.
   tests/unsuppression-fold.test.mjs runs `DROP OWNED BY consent_ledger_app;
   DROP ROLE consent_ledger_app` against the default database, and node's
   test runner runs files in PARALLEL. `DROP ROLE` fails while that role
   still holds a privilege in ANY database in the cluster — so granting
   db/001's INSERT to `consent_ledger_app` here would make that suite fail
   intermittently, on interleaving rather than on a defect. A separate role
   removes the shared name entirely. */
const DB = "cst_ledger_hardening_test";
const ROLE = "cst_ledger_hardening_role";

let server = null, endpoint = null, statements = [];

function psql(url, sql, { allowFail = false } = {}) {
  try {
    return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-X", "-q"],
      { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    if (allowFail) return String(err.stderr || "");
    throw new Error("psql failed: " + String(err.stderr || err.message).slice(0, 400));
  }
}

/** Neon's SQL-over-HTTP shape, with the numbers taken from real Postgres. */
function startNeonWireStub(dbUrl) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload;
      try {
        const { query, params = [] } = JSON.parse(body);
        statements.push({ query, params });
        /* PREPARE/EXECUTE so the REAL parameterised statement runs, rather
           than a reassembled one. Values are test-owned and dollar-quoted.

           THE PARAMETER TYPES ARE DELIBERATELY NOT DECLARED. Declaring them
           all `text` makes Postgres refuse the INSERT outright — "column
           occurred_at is of type timestamp with time zone but expression is
           of type text" — because a bare PREPARE gives no assignment
           context. Untyped, Postgres infers each parameter's type from the
           COLUMN it is being inserted into, which is what the real driver's
           bind does. So this stub exercises the same type resolution the
           production path gets, rather than a text-flattened imitation. */
        const tag = "cstq";
        const lit = (v) => (v === null || v === undefined ? "NULL" : `$${tag}$${String(v)}$${tag}$`);
        const sql = params.length
          ? `PREPARE s AS ${query};\nEXECUTE s (${params.map(lit).join(", ")});\nDEALLOCATE s;\n`
          : `${query};\n`;
        const out = execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-X"],
          { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        const m = out.match(/^INSERT (\d+) (\d+)\s*$/m);
        payload = {
          command: "INSERT", rowCount: m ? Number(m[2]) : 0,
          fields: [], rows: [], rowAsArray: true,
        };
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ message: "statement failed", code: "42601" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return srv;
}

describe("BOUNDARY — rowsAffected through the real driver and a real PostgreSQL", () => {
  let adminUrl = "", dbUrl = "", ready = false;

  before(async () => {
    if (!PG_URL) {
      console.warn(
        "\n!! SKIPPING the ledger-hardening BOUNDARY suite: CST_TEST_PG_URL is not set.\n" +
        "!! rowsAffected is proven against MOCKS ONLY in this run. CI sets the variable\n" +
        "!! against a postgres:16 service, which is where this claim is actually tested.\n");
      return;
    }
    adminUrl = PG_URL;
    /* An unreachable database with the variable SET is a failure, not a skip. */
    psql(adminUrl, "SELECT 1;");
    psql(adminUrl, `DROP DATABASE IF EXISTS ${DB};`);
    psql(adminUrl, `CREATE DATABASE ${DB};`);
    dbUrl = PG_URL.replace(/\/[^/?]*(\?|$)/, `/${DB}$1`);

    psql(adminUrl, `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ` +
      `'${ROLE}') THEN CREATE ROLE ${ROLE} LOGIN PASSWORD 'x'; END IF; END $$;`);
    const ddl = readFileSync(join(REPO, "db/001_communication_consent_events.sql"), "utf8")
      .replace(/<application_role>/g, ROLE);
    psql(dbUrl, ddl);

    server = startNeonWireStub(dbUrl);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { neonConfig } = await import("@neondatabase/serverless");
    endpoint = `http://127.0.0.1:${server.address().port}/sql`;
    neonConfig.fetchEndpoint = () => endpoint;
    ready = true;
  });

  after(() => {
    if (server) server.close();
    /* Database first: while it exists, its GRANT makes the role undroppable.
       Both are best-effort — a failure to clean up a disposable CI service
       must not turn a passing suite red. */
    if (dbUrl) {
      psql(adminUrl, `DROP DATABASE IF EXISTS ${DB};`, { allowFail: true });
      psql(adminUrl, `DROP ROLE IF EXISTS ${ROLE};`, { allowFail: true });
    }
  });

  /* The module's REAL executor, reached by not replacing it. */
  const realEnv = () => ({ [LEDGER_URL_VAR]: "postgresql://consent_ledger_app:x@db.neon.tech/neondb" });

  test("a genuine append reports the count PostgreSQL actually applied", async (t) => {
    if (!ready) return t.skip("CST_TEST_PG_URL not set");
    _resetExecutor();
    statements = [];
    const res = await appendSuppressionEvents(
      [suppression({ sourceEventId: "REAL_A" })], { env: realEnv() });
    assert.equal(res.rowsAffected, 1);
    assert.equal(statements.length, 1, "the statement did not reach the database");
    assert.match(statements[0].query, /ON CONFLICT DO NOTHING/);
  });

  test("a replay reports 0 — measured, not mocked", async (t) => {
    if (!ready) return t.skip("CST_TEST_PG_URL not set");
    _resetExecutor();
    const ev = [suppression({ sourceEventId: "REAL_B" })];
    assert.equal((await appendSuppressionEvents(ev, { env: realEnv() })).rowsAffected, 1);
    const replay = await appendSuppressionEvents(ev, { env: realEnv() });
    assert.equal(replay.rowsAffected, 0, "a real ON CONFLICT DO NOTHING replay did not report 0");
    assert.equal(replay.appended, true);
    assert.notEqual(replay.rowsAffected, replay.requested);
  });

  test("a partial conflict reports the healed count, not the batch size", async (t) => {
    if (!ready) return t.skip("CST_TEST_PG_URL not set");
    _resetExecutor();
    const first = [suppression({ sourceEventId: "REAL_C1" })];
    await appendSuppressionEvents(first, { env: realEnv() });
    const batch = [suppression({ sourceEventId: "REAL_C1" }), suppression({ sourceEventId: "REAL_C2" })];
    const res = await appendSuppressionEvents(batch, { env: realEnv() });
    assert.equal(res.requested, 2);
    assert.equal(res.rowsAffected, 1, "the per-row conflict semantics are not being measured");
  });

  test("a real unsuppression row is accepted by the real table and counted", async (t) => {
    if (!ready) return t.skip("CST_TEST_PG_URL not set");
    _resetExecutor();
    const row = buildSuppressionEvent(unsuppressionArgs({
      sourceEventId: "REAL_APPROVAL",
      reasonCode: UNSUPPRESSION_REASON.RECORDED_IN_ERROR,
      metadata: {
        error_origin: UNSUPPRESSION_ERROR_ORIGIN.CLASSIFIER,
        invalidates: [blockingKey(CHANNEL.SMS, "REAL_TARGET")],
      },
    }));
    const res = await appendSuppressionEvents([row], { env: realEnv() });
    assert.equal(res.rowsAffected, 1, "db/001 rejected the unsuppression row this builder produces");
    /* And the replay of that same approval — §9.1's exact scenario. */
    assert.equal((await appendSuppressionEvents([row], { env: realEnv() })).rowsAffected, 0);
  });

  test("a database error still throws rather than reporting 0 rows", async (t) => {
    if (!ready) return t.skip("CST_TEST_PG_URL not set");
    _resetExecutor();
    /* A row whose event_type violates db/001's own CHECK — the stub returns
       the 400 the real Neon endpoint returns for a failed statement. */
    const bad = { ...suppression({ sourceEventId: "REAL_E" }), schema_version: "not-an-int" };
    await assert.rejects(() => appendSuppressionEvents([bad], { env: realEnv() }),
      (err) => { assert.equal(err.ledgerFailed, true); return true; });
  });
});
