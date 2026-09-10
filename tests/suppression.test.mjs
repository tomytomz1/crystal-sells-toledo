/* Gate 7 — STOP / DNC suppression.
 *
 * Tier 4: compliance, and the highest-risk write in the phase. Wrong in one
 * direction is a TCPA violation; wrong in the other silently destroys a
 * lawful permission.
 *
 * NOTHING HERE REACHES A DATABASE, TWILIO, OR HUBSPOT. The ledger's
 * executor seam is injected and no Twilio credential is involved.
 *
 * The production verifier delegates the cryptography to the Twilio SDK's
 * `validateRequest`. These tests SIGN with an independent local HMAC —
 * standing in for Twilio — so a passing test means two separate
 * implementations of the scheme agree, rather than one implementation
 * agreeing with itself.
 *
 * The invariants worth the most, in order:
 *   1. an unverified request is never interpreted
 *   2. "stop by Sunday" is not an opt-out
 *   3. a suppression is never cleared, by anything
 *   4. the consumer's message reaches the ledger and never a log
 *   5. a retry is a no-op, and a ledger failure is never reported as success
 */

import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  verifyTwilioSignature, requestUrl,
  parseFormParams, optOutType, twilioConfigured,
  TWILIO_TOKEN_VAR, TWILIO_NOT_CONFIGURED, TWILIO_SIGNATURE_MISSING,
  TWILIO_SIGNATURE_INVALID, TWILIO_URL_UNRESOLVABLE,
} from "../api/_lib/twilio.mjs";
import {
  classifyInbound, normalise, classificationLogShape, OPT_OUT_RULES, STOP_KEYWORDS,
} from "../api/_lib/optout.mjs";
import {
  buildSuppressionEvent, appendSuppressionEvents, buildInsert,
  SUPPRESSION_COLUMNS, LEDGER_COLUMNS, EVIDENCE_TEXT_MAX_BYTES,
  CHANNEL, EVENT_TYPE, SOURCE_TWILIO, SOURCE_WEBSITE, LEDGER_URL_VAR,
  LEDGER_EVIDENCE_INCOMPLETE, LEDGER_NOT_CONFIGURED, LEDGER_APPEND_FAILED,
  _setExecutor, _resetExecutor,
} from "../api/_lib/consent-ledger.mjs";
import {
  toHubSpotSuppressionProperties, toHubSpotReoptinProperties,
  SUPPRESSION_TRIGGER, SUPPRESSION_PROPERTIES, REOPTIN_PROPERTIES,
  HUBSPOT_SUPPRESSION_VOCABULARY,
} from "../api/_lib/hubspot-consent-state.mjs";
import { phoneSearchVariants } from "../api/_lib/hubspot.mjs";
import { SUPPRESSION_SCOPE, applySuppression, canSendSms, canPlaceAutomatedVoiceCall } from "../api/_lib/permission.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "test_auth_token_not_a_real_credential";
const URL_VALUE = "postgres://app:secret@ledger.example/neondb";
const ENV = { [LEDGER_URL_VAR]: URL_VALUE };
const PHONE = "+14195550123";

/** Capture every statement the ledger would send. */
function captureExecutor({ fail = null } = {}) {
  const calls = [];
  _setExecutor(async (text, params, opts) => {
    calls.push({ text, params, opts });
    if (fail) throw fail;
    return [];
  });
  return calls;
}
afterEach(() => _resetExecutor());

/* =====================================================================
   1  SIGNATURE VERIFICATION — authenticate before interpreting
   ===================================================================== */
describe("twilio signature verification", () => {
  const url = "https://crystalsellstoledo.com/api/twilio-inbound";
  const params = { From: PHONE, Body: "STOP", MessageSid: "SM1", AccountSid: "AC1" };

  /* Stands in for Twilio. Deliberately NOT imported from the module under
     test: the whole value of this file is that the signer and the verifier
     are independent implementations. */
  const sign = (target, fields) => {
    let data = String(target);
    for (const key of Object.keys(fields).sort()) data += key + String(fields[key]);
    return createHmac("sha1", TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
  };

  const reqFor = (signature, over = {}) => ({
    url: "/api/twilio-inbound",
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "crystalsellstoledo.com",
      ...(signature === null ? {} : { "x-twilio-signature": signature }),
      ...over,
    },
  });

  test("a correctly signed request verifies", () => {
    assert.deepEqual(
      verifyTwilioSignature(reqFor(sign(url, params)), params,
        { env: { [TWILIO_TOKEN_VAR]: TOKEN } }),
      { ok: true });
  });

  /* The SDK is the implementation; this asserts it agrees with the scheme
     Twilio documents, computed here independently. If the two ever
     disagree, this fails rather than every real webhook being refused. */
  test("the SDK accepts a signature built from the documented scheme", () => {
    const base = "https://x/ya1b2c3";
    const sig = createHmac("sha1", TOKEN).update(Buffer.from(base, "utf8")).digest("base64");
    const req = {
      url: "/y",
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "x",
                 "x-twilio-signature": sig },
    };
    assert.equal(
      verifyTwilioSignature(req, { b: "2", a: "1", c: "3" },
        { env: { [TWILIO_TOKEN_VAR]: TOKEN } }).ok,
      true, "the SDK disagreed with the documented URL + sorted key/value scheme");
  });

  /* EVERY received parameter participates. Nothing is filtered, dropped or
     whitelisted before validation, so an injected field invalidates the
     signature instead of sailing past a filter. */
  test("an added parameter invalidates the signature", () => {
    const sig = sign(url, params);
    const injected = { ...params, Injected: "anything" };
    assert.equal(
      verifyTwilioSignature(reqFor(sig), injected, { env: { [TWILIO_TOKEN_VAR]: TOKEN } }).reason,
      TWILIO_SIGNATURE_INVALID);
  });

  test("a removed parameter invalidates the signature", () => {
    const sig = sign(url, params);
    const { AccountSid, ...fewer } = params;
    assert.equal(
      verifyTwilioSignature(reqFor(sig), fewer, { env: { [TWILIO_TOKEN_VAR]: TOKEN } }).reason,
      TWILIO_SIGNATURE_INVALID);
  });

  test("production holds no hand-rolled signature arithmetic", () => {
    /* The point of delegating: a subtly wrong HMAC fails closed and is
       therefore invisible until every real webhook is refused. */
    const src = readFileSync(join(REPO, "api/_lib/twilio.mjs"), "utf8");
    assert.match(src, /twilio\.validateRequest\(/);
    for (const banned of ["createHmac", "timingSafeEqual"])
      assert.ok(!src.includes(banned),
        `api/_lib/twilio.mjs still computes its own signature (${banned})`);
  });

  test("a wrong signature, a missing one, and a missing token are each refused", () => {
    const env = { [TWILIO_TOKEN_VAR]: TOKEN };
    assert.equal(verifyTwilioSignature(reqFor("not-the-signature"), params, { env }).reason,
      TWILIO_SIGNATURE_INVALID);
    assert.equal(verifyTwilioSignature(reqFor(null), params, { env }).reason,
      TWILIO_SIGNATURE_MISSING);
    assert.equal(verifyTwilioSignature(reqFor("x"), params, { env: {} }).reason,
      TWILIO_NOT_CONFIGURED);
  });

  /* The attack the signature exists to stop: a forged opt-out, and — far
     worse — a forged re-opt-in against someone who really did say stop. */
  test("a tampered parameter invalidates a signature computed over the original", () => {
    const sig = sign(url, params);
    const tampered = { ...params, Body: "START" };
    assert.equal(
      verifyTwilioSignature(reqFor(sig), tampered, { env: { [TWILIO_TOKEN_VAR]: TOKEN } }).reason,
      TWILIO_SIGNATURE_INVALID);
  });

  test("a signature for a different URL does not verify", () => {
    const sig = sign("https://evil.example/api/twilio-inbound", params);
    assert.equal(
      verifyTwilioSignature(reqFor(sig), params, { env: { [TWILIO_TOKEN_VAR]: TOKEN } }).reason,
      TWILIO_SIGNATURE_INVALID);
  });

  /* The design names URL reconstruction the most likely thing to get
     subtly wrong. It is pinned here so a change to it fails a test rather
     than every production webhook. */
  test("the URL is rebuilt from the forwarded headers, one value each", () => {
    assert.equal(requestUrl({ url: "/api/twilio-inbound", headers: {
      "x-forwarded-proto": "https", "x-forwarded-host": "crystalsellstoledo.com",
    } }), url);
    /* A comma-joined forwarded chain takes the first hop, not the whole
       string, or the HMAC is computed over a header artefact. */
    assert.equal(requestUrl({ url: "/x", headers: {
      "x-forwarded-proto": "https,http", "x-forwarded-host": "a.example, b.example",
    } }), "https://a.example/x");
    assert.equal(requestUrl({ url: "/x", headers: { host: "h.example" } }), "https://h.example/x");
    assert.equal(requestUrl({ url: "/x", headers: {} }), "");
  });

  test("an unresolvable URL is refused rather than guessed at", () => {
    assert.equal(
      verifyTwilioSignature({ url: "/x", headers: { "x-twilio-signature": "s" } }, {},
        { env: { [TWILIO_TOKEN_VAR]: TOKEN } }).reason,
      TWILIO_URL_UNRESOLVABLE);
  });

  test("the query string is part of what is signed", () => {
    const withQuery = "https://crystalsellstoledo.com/api/twilio-inbound?x=1";
    assert.equal(requestUrl({ url: "/api/twilio-inbound?x=1", headers: {
      "x-forwarded-proto": "https", "x-forwarded-host": "crystalsellstoledo.com" } }), withQuery);
    assert.notEqual(sign(withQuery, params), sign(url, params));
  });

  test("verification never throws, whatever it is handed", () => {
    for (const bad of [null, undefined, {}, { headers: null }])
      assert.doesNotThrow(() => verifyTwilioSignature(bad, {}, { env: { [TWILIO_TOKEN_VAR]: TOKEN } }));
  });

  test("form bodies decode, and OptOutType is read case-insensitively", () => {
    assert.deepEqual(parseFormParams("From=%2B14195550123&Body=STOP"),
      { From: PHONE, Body: "STOP" });
    assert.equal(optOutType({ OptOutType: "stop" }), "STOP");
    assert.equal(optOutType({ OptOutType: "  Start " }), "START");
    assert.equal(optOutType({ OptOutType: "nonsense" }), null);
    assert.equal(optOutType({}), null);
    assert.equal(twilioConfigured({}), false);
    assert.equal(twilioConfigured({ [TWILIO_TOKEN_VAR]: TOKEN }), true);
  });
});

/* =====================================================================
   2  CLASSIFICATION — the near-misses are the point
   ===================================================================== */
describe("opt-out classification", () => {
  const kindOf = (t) => {
    const r = classifyInbound(t);
    return r ? `${r.kind}/${r.channel || "-"}` : "null";
  };

  test("whole-message keywords are opt-outs", () => {
    for (const kw of STOP_KEYWORDS)
      assert.equal(kindOf(kw), "suppress/sms", `${kw} was not treated as an opt-out`);
    assert.equal(kindOf("STOP"), "suppress/sms");
    assert.equal(kindOf("  Stop.  "), "suppress/sms");
  });

  /* Twilio's default English long-code list, in full. REVOKE was missing
     from the fallback set until an independent review caught it: Twilio
     would have opted the consumer out while our layer classified nothing,
     leaving no evidence of an opt-out Twilio had already enforced. */
  test("every Twilio default English opt-out keyword is covered", () => {
    for (const kw of ["STOP", "UNSUBSCRIBE", "END", "QUIT", "STOPALL",
                      "REVOKE", "OPTOUT", "CANCEL"]) {
      assert.ok(STOP_KEYWORDS.includes(kw.toLowerCase()),
        `${kw} is not in STOP_KEYWORDS - Twilio would block the number and we would record nothing`);
      assert.equal(kindOf(kw), "suppress/sms", `${kw} did not classify as an opt-out`);
    }
  });

  test("REVOKE is a keyword, not a substring", () => {
    assert.equal(kindOf("REVOKE"), "suppress/sms");
    /* Ordinary language using the word must not suppress. */
    assert.equal(kindOf("revoke my offer please"), "null");
    assert.equal(kindOf("did they revoke the listing?"), "null");
  });

  test("natural-language opt-outs are caught, per channel", () => {
    for (const [text, expected] of [
      ["please stop texting me", "suppress/sms"],
      ["stop sending me messages", "suppress/sms"],
      ["no more texts please", "suppress/sms"],
      ["don't text me", "suppress/sms"],
      ["do not message me", "suppress/sms"],
      ["stop calling me", "suppress/ai_voice"],
      ["do not call me again", "suppress/ai_voice"],
      ["no more calls", "suppress/ai_voice"],
      ["remove me from your list", "suppress/all"],
      ["stop contacting me", "suppress/all"],
      ["do not contact me", "suppress/all"],
    ]) assert.equal(kindOf(text), expected, `misclassified: ${text}`);
  });

  /* THE REASON SUBSTRING MATCHING IS BANNED. Each of these contains a word
     from the keyword list and none of them is an opt-out. A false positive
     here does not merely lose a lead — it writes a legal state the
     consumer never asked for, into a ledger that cannot delete it. */
  test("ordinary language containing a keyword is NOT an opt-out", () => {
    for (const text of [
      "stop by the open house on Sunday",
      "can you stop by Sunday?",
      "I want to stop by and see the kitchen",
      "cancel my appointment please",
      "can you call me back?",
      "please call me tomorrow",
      "what time is the showing?",
      "not interested",
      "is the end of the street quiet?",
      "quit my job last week, so timing is good",
      "help me understand the offer",
      "text me the address",
    ]) assert.equal(kindOf(text), "null", `false positive: ${text}`);
  });

  test("'not interested' suppresses only alongside an explicit stop clause", () => {
    assert.equal(kindOf("not interested"), "null");
    assert.equal(classifyInbound("not interested, stop texting me")?.kind, "suppress");
  });

  test("START is a re-opt-in request and HELP is neither", () => {
    assert.equal(classifyInbound("START").kind, "reoptin");
    assert.equal(classifyInbound("START").eventType, EVENT_TYPE.REOPTIN_REQUESTED);
    assert.equal(classifyInbound("HELP").kind, "help");
  });

  test("a natural-language opt-out is `revoked`, a keyword is `suppressed`", () => {
    /* Both deny sending; recording them identically would lose the reason
       a future reader needs. */
    assert.equal(classifyInbound("STOP").eventType, EVENT_TYPE.SUPPRESSED);
    assert.equal(classifyInbound("please stop texting me").eventType, EVENT_TYPE.REVOKED);
  });

  test("normalisation folds case, punctuation and curly apostrophes", () => {
    assert.equal(normalise("  DON’T   TEXT  me!! "), "dont text me");
    assert.equal(normalise("stop.texting"), "stop texting");
    assert.equal(normalise(null), "");
  });

  test("no rule is a bare substring — every one binds a verb to an object", () => {
    for (const rule of OPT_OUT_RULES) {
      const src = rule.pattern.source;
      assert.ok(/\\b/.test(src) || /\\s\+/.test(src),
        `rule ${rule.id} has no word boundary or word separator - it may match inside a word`);
    }
  });

  test("the log shape carries the decision and never the message", () => {
    const shape = classificationLogShape(classifyInbound("please stop texting me"));
    assert.deepEqual(Object.keys(shape).sort(), ["channel", "classified", "kind", "rule"]);
    assert.ok(!JSON.stringify(shape).includes("texting me"));
    assert.deepEqual(classificationLogShape(null), { classified: false });
  });
});

/* =====================================================================
   3  THE LEDGER EVENT
   ===================================================================== */
describe("the suppression ledger event", () => {
  const base = {
    occurredAt: "2026-09-10T04:00:00.000Z",
    channel: CHANNEL.SMS,
    eventType: EVENT_TYPE.SUPPRESSED,
    phone: PHONE,
    source: SOURCE_TWILIO,
    sourceEventId: "SM_abc",
    reasonCode: "stop_keyword",
    evidenceText: "STOP",
    metadata: { MessageSid: "SM_abc" },
  };

  test("the dedupe key is the provider's own message id", () => {
    assert.equal(buildSuppressionEvent(base).dedupe_key, "twilio:SM_abc:sms:suppressed");
  });

  test("submission_id is NULL — a suppression is about a NUMBER", () => {
    const e = buildSuppressionEvent(base);
    assert.equal(e.submission_id, null);
    assert.equal(e.form_type, null);
    assert.equal(e.page_path, null);
    assert.equal(e.consent_copy_version, null);
    assert.equal(e.consent_copy_text, null);
    assert.equal(e.phone_e164, PHONE);
  });

  test("a suppression may never claim to come from the website", () => {
    assert.throws(() => buildSuppressionEvent({ ...base, source: SOURCE_WEBSITE }),
      (err) => err.token === LEDGER_EVIDENCE_INCOMPLETE);
  });

  test("a number that will not normalise is refused, not guessed at", () => {
    assert.throws(() => buildSuppressionEvent({ ...base, phone: "not a phone" }));
  });

  test("the statement writes the three extra columns and keeps the bare conflict clause", () => {
    const { text, params } = buildInsert([buildSuppressionEvent(base)], { columns: SUPPRESSION_COLUMNS });
    assert.equal(SUPPRESSION_COLUMNS.length, LEDGER_COLUMNS.length + 3);
    for (const col of ["reason_code", "evidence_text", "metadata"])
      assert.ok(SUPPRESSION_COLUMNS.includes(col));
    assert.equal(params.length, SUPPRESSION_COLUMNS.length);
    /* The clause that took four sessions to get right: naming a conflict
       target requires SELECT, which no role on this table has. */
    assert.match(text, /ON CONFLICT DO NOTHING$/);
    assert.ok(!/ON CONFLICT\s*\(/.test(text));
    /* `source_event_id` CONTAINS `event_id`, so a bare substring test
       here would fail against a perfectly correct statement — the same
       trap tests/consent-ledger.test.mjs hit in September 2026. */
    const columnList = text.split("VALUES")[0];
    for (const dbOwned of ["event_id", "recorded_at"])
      assert.ok(!new RegExp("(^|[\\s(,])" + dbOwned + "\\b").test(columnList),
        `${dbOwned} is named in the column list - it is a database default`);
  });

  test("evidence text is capped without writing a broken character", () => {
    const long = "x".repeat(EVIDENCE_TEXT_MAX_BYTES * 2);
    const e = buildSuppressionEvent({ ...base, evidenceText: long });
    assert.ok(Buffer.byteLength(e.evidence_text, "utf8") <= EVIDENCE_TEXT_MAX_BYTES);
    assert.match(e.evidence_text, /…\[truncated\]$/);
    const emoji = buildSuppressionEvent({ ...base, evidenceText: "🙂".repeat(1000) });
    assert.ok(!emoji.evidence_text.includes("�"), "truncation produced a replacement character");
  });

  test("metadata is always valid JSON, even when absent", () => {
    assert.deepEqual(JSON.parse(buildSuppressionEvent({ ...base, metadata: null }).metadata), {});
    assert.deepEqual(JSON.parse(buildSuppressionEvent(base).metadata), { MessageSid: "SM_abc" });
  });

  test("an append with no configured ledger fails rather than succeeding quietly", async () => {
    const calls = captureExecutor();
    await assert.rejects(() => appendSuppressionEvents([buildSuppressionEvent(base)], { env: {} }),
      (err) => err.token === LEDGER_NOT_CONFIGURED);
    assert.equal(calls.length, 0);
  });

  test("a driver failure is classified, never passed through", async () => {
    captureExecutor({ fail: new Error("FATAL: password authentication failed " + URL_VALUE) });
    await assert.rejects(
      () => appendSuppressionEvents([buildSuppressionEvent(base)], { env: ENV }),
      (err) => err.token === LEDGER_APPEND_FAILED && !err.message.includes("password"));
  });

  test("a replayed webhook produces a byte-identical statement", async () => {
    const calls = captureExecutor();
    await appendSuppressionEvents([buildSuppressionEvent(base)], { env: ENV });
    await appendSuppressionEvents([buildSuppressionEvent(base)], { env: ENV });
    assert.equal(calls[0].text, calls[1].text);
    const keyIdx = SUPPRESSION_COLUMNS.indexOf("dedupe_key");
    assert.equal(calls[0].params[keyIdx], calls[1].params[keyIdx]);
  });
});

/* =====================================================================
   4  THE HUBSPOT PROJECTION — additive, never clearing
   ===================================================================== */
describe("the HubSpot suppression projection", () => {
  const at = "2026-09-10T04:00:00.000Z";
  const S = SUPPRESSION_PROPERTIES;

  test("a scope sets only its own channel's flags", () => {
    const sms = toHubSpotSuppressionProperties({ scope: "sms", at });
    assert.equal(sms[S.smsSuppressed], "true");
    assert.equal(sms[S.doNotCall], undefined);
    const voice = toHubSpotSuppressionProperties({ scope: "voice", at });
    assert.equal(voice[S.doNotCall], "true");
    assert.equal(voice[S.smsSuppressed], undefined);
  });

  test("global cascades to both channels", () => {
    const g = toHubSpotSuppressionProperties({ scope: "global", at });
    for (const prop of [S.doNotContact, S.smsSuppressed, S.doNotCall])
      assert.equal(g[prop], "true");
  });

  /* THE INVARIANT THAT MATTERS MOST IN THIS FILE. There must be no input
     at all that produces a false, a blank, or a cleared timestamp. */
  test("no scope, trigger or prior state ever writes false or clears anything", () => {
    const states = [
      null,
      { suppression: {} },
      { suppression: { sms: { reason: "stop_keyword", at: "2026-09-01T00:00:00Z" } } },
      { suppression: { global: { reason: "consumer_request", at: "2026-09-01T00:00:00Z" } } },
      { suppression: { sms: { reason: "manual", at: "" } } },
    ];
    for (const scope of ["sms", "voice", "global"])
      for (const trigger of Object.values(SUPPRESSION_TRIGGER))
        for (const current of states) {
          const props = toHubSpotSuppressionProperties({ scope, trigger, at, current });
          for (const [key, value] of Object.entries(props)) {
            assert.notEqual(value, "false", `${key} was written false`);
            assert.notEqual(value, false, `${key} was written false`);
            assert.notEqual(value, "", `${key} was cleared`);
            assert.ok(value !== null && value !== undefined, `${key} was blanked`);
          }
        }
  });

  test("the earliest refusal stands — a duplicate STOP writes nothing", () => {
    const current = { suppression: { sms: { reason: "stop_keyword", at: "2026-09-01T00:00:00Z" } } };
    assert.deepEqual(toHubSpotSuppressionProperties({ scope: "sms", at, current }), {});
  });

  test("an unreadable prior state still suppresses", () => {
    /* Failing to read is never a reason to leave someone un-suppressed. */
    const props = toHubSpotSuppressionProperties({ scope: "sms", at, current: null });
    assert.equal(props[S.smsSuppressed], "true");
  });

  test("internal reasons are mapped onto HubSpot's vocabulary, never passed through", () => {
    for (const scope of ["sms", "voice", "global"])
      for (const trigger of Object.values(SUPPRESSION_TRIGGER)) {
        const props = toHubSpotSuppressionProperties({ scope, trigger, at });
        for (const [prop, value] of Object.entries(props)) {
          const allowed = HUBSPOT_SUPPRESSION_VOCABULARY[prop];
          if (allowed) assert.ok(allowed.includes(value),
            `${prop} got ${value}, which HubSpot would reject`);
        }
      }
  });

  test("a re-opt-in records the request and grants nothing", () => {
    const props = toHubSpotReoptinProperties({ channel: "sms", at });
    assert.deepEqual(Object.keys(props).sort(),
      [REOPTIN_PROPERTIES.at, REOPTIN_PROPERTIES.channel].sort());
    /* No status, no consent timestamp, no version, no phone. A START from
       the handset is stronger than a ticked box and is still not a grant:
       it carries no disclosure for anyone to have agreed to. */
    const serialised = JSON.stringify(props);
    for (const forbidden of ["permission_status", "consent_at", "copy_version"])
      assert.ok(!serialised.includes(forbidden), `a re-opt-in wrote ${forbidden}`);
  });

  test("phone variants cover the forms a CRM actually holds", () => {
    const v = phoneSearchVariants(PHONE);
    assert.ok(v.includes(PHONE));
    assert.ok(v.includes("(419) 555-0123"));
    assert.ok(v.includes("4195550123"));
    /* Non-US numbers are passed through rather than mangled into a wrong
       US shape. */
    assert.deepEqual(phoneSearchVariants("+442071234567"), ["+442071234567"]);
    assert.deepEqual(phoneSearchVariants(""), []);
  });
});

/* =====================================================================
   5  SUPPRESSION OUTRANKS CONSENT, ALWAYS
   ===================================================================== */
describe("suppression and the permission resolver", () => {
  /* The resolver refuses everything while the feature gate is off, which
     is production's state today — so these tests pass the gate ON, which
     is the only configuration in which the suppression logic is reachable
     at all. */
  const ON = { env: { COMMUNICATIONS_CONSENT_ENABLED: "true" } };

  test("a suppression denies the channel even with a granted consent", () => {
    let state = {
      sms: { status: "granted", consent_phone: PHONE },
      ai_voice: { status: "granted", consent_phone: PHONE },
      suppression: {},
    };
    assert.equal(canSendSms(state, PHONE, ON).allowed, true);
    state = applySuppression(state, {
      scope: SUPPRESSION_SCOPE.SMS, reason: "stop_keyword", at: "2026-09-10T04:00:00Z", source: "twilio",
    });
    assert.equal(canSendSms(state, PHONE, ON).allowed, false);
    /* And only that channel — someone who stopped texts did not withdraw
       permission to call. */
    assert.equal(canPlaceAutomatedVoiceCall(state, PHONE, ON).allowed, true);
  });

  test("the feature gate denies before any of this is consulted", () => {
    const granted = { sms: { status: "granted", consent_phone: PHONE }, suppression: {} };
    assert.equal(canSendSms(granted, PHONE, { env: {} }).allowed, false);
  });

  test("a global suppression denies both channels", () => {
    const state = applySuppression({
      sms: { status: "granted", consent_phone: PHONE },
      ai_voice: { status: "granted", consent_phone: PHONE },
    }, { scope: SUPPRESSION_SCOPE.GLOBAL, reason: "consumer_request", at: "2026-09-10T04:00:00Z" });
    assert.equal(canSendSms(state, PHONE, ON).allowed, false);
    assert.equal(canPlaceAutomatedVoiceCall(state, PHONE, ON).allowed, false);
  });

  test("applySuppression never removes anything it did not add", () => {
    const before = {
      sms: { status: "granted", consent_phone: PHONE, consent_at: "2026-09-01T00:00:00Z" },
      ai_voice: { status: "granted", consent_phone: PHONE },
      suppression: { voice: { reason: "voice_dnc", at: "2026-08-01T00:00:00Z" } },
    };
    const after = applySuppression(before, {
      scope: SUPPRESSION_SCOPE.SMS, reason: "stop_keyword", at: "2026-09-10T04:00:00Z",
    });
    assert.equal(after.suppression.voice.at, "2026-08-01T00:00:00Z");
    assert.equal(after.sms.consent_at, "2026-09-01T00:00:00Z");
    assert.equal(before.suppression.sms, undefined, "the input state was mutated");
  });
});

/* =====================================================================
   6  THE STATIC GUARDS — run the real check.mjs against a broken tree
   =====================================================================
   A guard nobody has seen fail is a guard nobody knows works. Each case
   breaks one invariant in a THROWAWAY COPY and asserts the real script
   refuses it. The working tree is never mutated.
   ===================================================================== */
describe("the gate 7 static guards", () => {
  let dir, root;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cst-gate7-guard-"));
    root = join(dir, "tree");
    for (const item of ["src", "assets", "tools", "api", "db", "package.json",
                        "robots.txt", "site.webmanifest", ".env.example"])
      cpSync(join(REPO, item), join(root, item), { recursive: true });
    execFileSync(process.execPath, ["tools/build.mjs"], { cwd: root, stdio: "pipe" });
  });
  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const WEBHOOK = () => join(root, "api", "twilio-inbound.js");
  const MIGRATION = () => join(root, "db", "002_suppression_lookup.sql");
  const pristineWebhook = () => readFileSync(join(REPO, "api/twilio-inbound.js"), "utf8");
  const pristineMigration = () => readFileSync(join(REPO, "db/002_suppression_lookup.sql"), "utf8");

  function runCheck() {
    try {
      execFileSync(process.execPath, ["tools/check.mjs"], { cwd: root, stdio: "pipe" });
      return { ok: true, output: "" };
    } catch (err) {
      return { ok: false, output: String(err.stdout || "") + String(err.stderr || "") };
    }
  }

  afterEach(() => {
    writeFileSync(WEBHOOK(), pristineWebhook());
    writeFileSync(MIGRATION(), pristineMigration());
  });

  test("the copied tree passes before anything is broken", () => {
    const { ok, output } = runCheck();
    assert.ok(ok, "an unmodified copy already fails check.mjs:\n" + output);
  });

  test("classifying before verifying the signature is refused", () => {
    /* Move the verification below the classification — the exact refactor
       that would let an attacker's body be interpreted. */
    const src = pristineWebhook();
    const swapped = src
      .replace("const verdict = verifyTwilioSignature(req, params);", "const verdict = { ok: true };")
      .replace("const decision = classify(params);",
        "const decision = classify(params);\n  const late = verifyTwilioSignature(req, params);");
    writeFileSync(WEBHOOK(), swapped);
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a webhook that classifies before verifying");
    assert.match(output, /before verifying the signature/);
  });

  test("deleting the signature check entirely is refused", () => {
    writeFileSync(WEBHOOK(),
      pristineWebhook().replace("verifyTwilioSignature(req, params)", "({ ok: true })"));
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a webhook with no signature verification");
    assert.match(output, /forge an opt-out/);
  });

  test("writing to HubSpot before the ledger is refused", () => {
    const src = pristineWebhook();
    const swapped = src
      .replace("    await appendSuppressionEvents([event]);", "/*MOVED*/")
      .replace("  await projectToHubSpot({ decision, from, occurredAt, shape });",
        "  await projectToHubSpot({ decision, from, occurredAt, shape });\n  await appendSuppressionEvents([event]);");
    writeFileSync(WEBHOOK(), swapped);
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a webhook that writes HubSpot before the ledger");
    assert.match(output, /before the ledger/);
  });

  test("logging the consumer's message body is refused", () => {
    writeFileSync(WEBHOOK(),
      pristineWebhook().replace('log("twilio.inbound.unclassified_not_surfaced", shape);',
        'log("twilio.inbound.unclassified_not_surfaced", { ...shape, body: params.Body });'));
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a webhook that logs the message body");
    assert.match(output, /logs the inbound message body/);
  });

  test("dropping SET search_path from the migration is refused", () => {
    writeFileSync(MIGRATION(),
      pristineMigration().replace("SET search_path = pg_catalog, public", "-- removed"));
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a SECURITY DEFINER function with no fixed search_path");
    assert.match(output, /search_path/);
  });

  test("dropping REVOKE EXECUTE FROM PUBLIC is refused", () => {
    writeFileSync(MIGRATION(),
      pristineMigration().replace(/REVOKE EXECUTE ON FUNCTION[^;]*;/, "-- removed"));
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a function still granted to PUBLIC");
    assert.match(output, /PUBLIC/);
  });

  test("granting the sender a table privilege is refused", () => {
    writeFileSync(MIGRATION(),
      pristineMigration() + "\nGRANT SELECT ON communication_consent_events TO <sender_role>;\n");
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a table grant to the sender role");
    assert.match(output, /table privilege/);
  });

  /* THE MIS-PAIRING REGRESSION.
     `min(occurred_at), min(reason_code)` are two INDEPENDENT aggregates and
     return values from DIFFERENT rows. Measured on PostgreSQL 16 with two
     suppressions on one number, the timestamp order the opposite of the
     lexical reason order:

       rows    2026-09-01 stop_keyword      2026-09-05 natural_language
       buggy   2026-09-01 natural_language  <- the wrong pairing
       truth   2026-09-01 stop_keyword

     The fix is the narrowest contract: the sender decides from the
     PRESENCE of a suppression, so the function returns no reason at all
     and a column that is not returned cannot be mis-paired. This test is
     structural — the SQL-level proof is section 4 of the migration, run by
     the operator against the real database. */
  test("the lookup function cannot return a mis-paired reason", () => {
    const mig = pristineMigration();
    const code = mig.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.ok(!/min\s*\(\s*[a-z_.]*reason_code\s*\)/i.test(code),
      "reason_code is aggregated independently of occurred_at - they would come from different rows");
    assert.match(code, /RETURNS\s+TABLE\s*\(\s*channel\s+text\s*,\s*suppressed_at\s+timestamptz\s*\)/,
      "the function's result shape changed - it must return channel and suppressed_at only");
    /* And the operator's own SQL-level check must stay in the file. */
    assert.match(mig, /THE MIS-PAIRING REGRESSION/,
      "the migration no longer tells the operator how to prove this against the real database");
  });

  test("reintroducing min(reason_code) is refused", () => {
    writeFileSync(MIGRATION(), pristineMigration()
      .replace("min(e.occurred_at) AS suppressed_at",
        "min(e.occurred_at) AS suppressed_at, min(e.reason_code) AS reason_code")
      .replace("RETURNS TABLE (channel text, suppressed_at timestamptz)",
        "RETURNS TABLE (channel text, suppressed_at timestamptz, reason_code text)"));
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted independently aggregated reason_code");
    assert.match(output, /different row|mis-pairing/);
  });

  test("the guard pins the call sites this test depends on", () => {
    const checkSrc = readFileSync(join(REPO, "tools/check.mjs"), "utf8");
    for (const call of ["verifyTwilioSignature(req", "= classify(params)",
                        "await appendSuppressionEvents(", "await projectToHubSpot("])
      assert.ok(checkSrc.includes(JSON.stringify(call)),
        `tools/check.mjs no longer matches on ${JSON.stringify(call)}`);
    /* And the bug this guard was born with: matching the bare identifier
       also matches the function DECLARATION, which sits above the handler,
       making the ordering comparison vacuous. */
    assert.ok(!checkSrc.includes('CLASSIFY_CALL = "classify(params)"'),
      "the classify guard matches the declaration as well as the call - the ordering check would prove nothing");
  });
});
