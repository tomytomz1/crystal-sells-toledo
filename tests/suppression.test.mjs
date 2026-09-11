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

import { test, describe, before, after, afterEach, beforeEach } from "node:test";
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
  LEDGER_TIMEOUT_MS,
  _setExecutor, _resetExecutor,
} from "../api/_lib/consent-ledger.mjs";
import {
  toHubSpotSuppressionProperties, toHubSpotReoptinProperties,
  SUPPRESSION_TRIGGER, SUPPRESSION_PROPERTIES, REOPTIN_PROPERTIES,
  HUBSPOT_SUPPRESSION_VOCABULARY,
} from "../api/_lib/hubspot-consent-state.mjs";
import { phoneSearchVariants, HUBSPOT_TIMEOUT_MS } from "../api/_lib/hubspot.mjs";
import { SUPPRESSION_SCOPE, applySuppression, canSendSms, canPlaceAutomatedVoiceCall } from "../api/_lib/permission.mjs";
import { SUPPRESSION_REASON, FEATURE_FLAG } from "../api/_lib/consent.mjs";
import inboundHandler, {
  MAX_PROJECTION_CONTACTS, PROJECTION_DEADLINE_MS, MIN_WRITE_MS, MIN_SEARCH_MS,
} from "../api/twilio-inbound.js";

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

  /* REGRESSION. This branch was two-way — voice or "everything else" —
     so every all-channel request was recorded as `stop_keyword`. "stop
     contacting me" is not the STOP keyword, and the ledger row exists to
     describe the act accurately. Caught in review. */
  test("an all-channel request records GLOBAL_DNC, not a keyword stop", () => {
    for (const text of ["stop contacting me", "remove me from your list",
                        "do not contact me"]) {
      const r = classifyInbound(text);
      assert.equal(r.scope, SUPPRESSION_SCOPE.GLOBAL, text);
      assert.equal(r.channel, CHANNEL.ALL, text);
      assert.equal(r.eventType, EVENT_TYPE.REVOKED, text);
      assert.equal(r.reasonCode, SUPPRESSION_REASON.GLOBAL_DNC, text);
    }
  });

  test("each scope records its own reason, and no two share one", () => {
    const reasonFor = (t) => classifyInbound(t).reasonCode;
    assert.equal(reasonFor("stop texting me"), SUPPRESSION_REASON.STOP_KEYWORD);
    assert.equal(reasonFor("stop calling me"), SUPPRESSION_REASON.VOICE_DNC);
    assert.equal(reasonFor("stop contacting me"), SUPPRESSION_REASON.GLOBAL_DNC);
    assert.equal(new Set([
      reasonFor("stop texting me"), reasonFor("stop calling me"),
      reasonFor("stop contacting me"),
    ]).size, 3, "two scopes collapsed onto one ledger reason");
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
    /* THE TARGET IS ASSERTED BEFORE IT IS USED. This call site grew a
       `startedAt` argument on 11 September 2026 and this `replace()`
       silently stopped matching — the "mutation that does not mutate"
       failure the test below already documents, arriving here by a
       different route. A moved target must fail loudly, not quietly. */
    const PROJECT_CALL =
      "  await projectToHubSpot({ decision, from, occurredAt, shape, startedAt });";
    assert.ok(src.includes(PROJECT_CALL),
      "the projection call site moved - this test would prove nothing");
    const swapped = src
      .replace("    await appendSuppressionEvents([event]);", "/*MOVED*/")
      .replace(PROJECT_CALL, PROJECT_CALL + "\n  await appendSuppressionEvents([event]);");
    writeFileSync(WEBHOOK(), swapped);
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a webhook that writes HubSpot before the ledger");
    assert.match(output, /before the ledger/);
  });

  test("logging the consumer's message body is refused", () => {
    /* Retargeted 10 September 2026. This mutation used to rewrite the
       `unclassified_not_surfaced` line, which the operator-surfacing
       implementation moved into surfaceToOperator() and reshaped — so the
       replace silently matched nothing and the test passed while proving
       NOTHING. The assertion below is the fix for the class of defect,
       not just for this instance: a mutation test that does not mutate is
       worse than no test, because it reports green. */
    const target = 'log("twilio.inbound.unclassified_notified", { ...shape, ms: Date.now() - started });';
    const pristine = pristineWebhook();
    assert.ok(pristine.includes(target),
      "the mutation target moved - this test would prove nothing");
    const mutated = pristine.replace(target,
      'log("twilio.inbound.unclassified_notified", { ...shape, body: params.Body });');
    assert.notEqual(mutated, pristine, "the mutation changed nothing");
    writeFileSync(WEBHOOK(), mutated);
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

  /* THE PROJECTION BOUND. Each of these deletes the bound in a way that
     breaks no visible behaviour — the endpoint still answers 200 against a
     CRM holding one contact, which is every test that is not this one. */
  test("removing the per-request timeout from the search is refused", () => {
    const src = pristineWebhook();
    const target = "await findContactsByPhone(from, { timeoutMs: requestMs() });";
    assert.ok(src.includes(target), "the search call site moved - this test would prove nothing");
    writeFileSync(WEBHOOK(), src.replace(target, "await findContactsByPhone(from);"));
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a search outside the projection deadline");
    assert.match(output, /findContactsByPhone/);
  });

  test("checking the deadline only BETWEEN writes is refused", () => {
    /* The exact defect found in `4397f00`: the loop still consults the
       clock, so the mutation looks harmless — but the request itself is
       unbounded and runs on under HubSpot's own 8 s timeout. */
    const src = pristineWebhook();
    const target = "await writeSuppressionProperties(contact.id, props,\n          { timeoutMs: requestMs() });";
    assert.ok(src.includes(target), "the write call site moved - this test would prove nothing");
    const mutated = src.replace(target, "await writeSuppressionProperties(contact.id, props);");
    assert.notEqual(mutated, src, "the mutation changed nothing");
    writeFileSync(WEBHOOK(), mutated);
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a write that outlives the projection deadline");
    assert.match(output, /only BETWEEN requests/);
  });

  test("a projection-local deadline instead of one from handler entry is refused", () => {
    const src = pristineWebhook();
    const target = "const deadline = entry + PROJECTION_DEADLINE_MS;";
    assert.ok(src.includes(target), "the deadline moved - this test would prove nothing");
    writeFileSync(WEBHOOK(),
      src.replace(target, "const deadline = Date.now() + PROJECTION_DEADLINE_MS;"));
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a budget that stacks on top of the ledger append");
    assert.match(output, /handler entry/);
  });

  test("dropping the contact cap is refused", () => {
    const src = pristineWebhook();
    const target = "if (attempted >= MAX_PROJECTION_CONTACTS || remaining() < MIN_WRITE_MS) {";
    assert.ok(src.includes(target), "the cap moved - this test would prove nothing");
    writeFileSync(WEBHOOK(), src.replace(target, "if (remaining() < MIN_WRITE_MS) {"));
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted an uncapped per-contact loop");
    assert.match(output, /MAX_PROJECTION_CONTACTS/);
  });

  /* THE BUCKET THAT WENT MISSING. Deleting `unchanged` is the original
     defect: the endpoint still works, still answers 200, still writes what
     it should — and quietly loses a contact from the only record of what
     the projection did. */
  test("losing the already-marked bucket is refused", () => {
    const src = pristineWebhook();
    const target = "        unchanged += 1;\n        continue;";
    assert.ok(src.includes(target), "the unchanged bucket moved - this test would prove nothing");
    /* Both increments go, so the constant is declared and never counted —
       exactly the shape a guard reading the whole file would miss. */
    const mutated = src.split("unchanged += 1;").join("/* dropped */");
    assert.notEqual(mutated, src, "the mutation changed nothing");
    writeFileSync(WEBHOOK(), mutated);
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a tally that does not sum to the contacts found");
    assert.match(output, /never increments `unchanged`/);
  });

  test("the guard is anchored to the projection body, not to the file", () => {
    /* A guard that searched the whole source would be satisfied by the
       constants and the call sites merely EXISTING somewhere. Deleting the
       function body while leaving the declarations must still fail. */
    const src = pristineWebhook();
    const start = src.indexOf("async function projectToHubSpot");
    assert.notEqual(start, -1, "projectToHubSpot moved - this test would prove nothing");
    const end = src.indexOf("\n/* ---", start);
    const body = src.slice(start, end === -1 ? src.length : end);
    const gutted = src.replace(body,
      "async function projectToHubSpot() {\n  /* findContactsByPhone( writeSuppressionProperties( timeoutMs: requestMs() */\n  return;\n}\n");
    assert.notEqual(gutted, src, "the mutation changed nothing");
    writeFileSync(WEBHOOK(), gutted);
    const { ok, output } = runCheck();
    assert.ok(!ok, "check.mjs accepted a gutted projection whose constants still exist");
    assert.match(output, /projectToHubSpot/);
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

/* =====================================================================
   7  THE HUBSPOT PROJECTION IS BOUNDED
   =====================================================================
   Tier 4, and the risk is not compliance. By the time the projection runs
   the ledger has committed, so the suppression is durable and enforcement
   resolves by number. What an unbounded projection costs is THE ANSWER TO
   TWILIO: a phone held by 100 contacts is 100 sequential HubSpot requests
   inside a 15 s maxDuration, shared with Twilio's own ~15 s webhook
   timeout, and the function is killed before it can reply.

   Four things are proved here, each of which a refactor could break with
   no visible symptom until a real STOP arrives from a well-known number:

     1. the request count is capped
     2. the deadline is ABSOLUTE from handler entry, not per-phase, and an
        in-flight write is ABORTED at it rather than running on under
        HubSpot's own 8 s timeout
     3. every contact found lands in exactly one bucket, and the buckets
        sum to the population — including the already-marked contact the
        previous version of this loop counted nowhere
     4. none of it changes what Twilio is told, or what the ledger holds

   NOTHING HERE REACHES HUBSPOT, TWILIO OR A DATABASE: `globalThis.fetch`
   is stubbed, the ledger executor is injected, and the Twilio SDK's
   verifier is stubbed because the signature scheme is section 1's subject
   and is proved there against an independent HMAC.
   ===================================================================== */
describe("the HubSpot projection is bounded", () => {
  const SID = "SM0123456789abcdef0123456789abcdef";
  const S = SUPPRESSION_PROPERTIES;

  const ENV_KEYS = [TWILIO_TOKEN_VAR, LEDGER_URL_VAR, FEATURE_FLAG,
                    "HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PORTAL_ID", "HUBSPOT_FORM_GUID"];
  const SAVED = {};
  const realFetch = globalThis.fetch;
  let realValidate;

  before(async () => {
    for (const k of ENV_KEYS) SAVED[k] = process.env[k];
    const twilio = (await import("twilio")).default;
    realValidate = twilio.validateRequest;
    twilio.validateRequest = () => true;
  });
  after(async () => {
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = realFetch;
    const twilio = (await import("twilio")).default;
    twilio.validateRequest = realValidate;
    _resetExecutor();
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env[TWILIO_TOKEN_VAR] = TOKEN;
    process.env[LEDGER_URL_VAR] = URL_VALUE;
    process.env[FEATURE_FLAG] = "true";
    process.env.HUBSPOT_ACCESS_TOKEN = "pat-test-not-a-real-credential";
    process.env.HUBSPOT_PORTAL_ID = "1";
    process.env.HUBSPOT_FORM_GUID = "g";
    /* A real network call from these tests is a bug in the test. */
    globalThis.fetch = async () => { throw new Error("NETWORK_NOT_ALLOWED_IN_TESTS"); };
  });
  afterEach(() => { globalThis.fetch = realFetch; _resetExecutor(); });

  function mockRes() {
    return {
      statusCode: 0, headers: {}, body: "", ended: false,
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
      end(payload) { this.body = payload == null ? "" : String(payload); this.ended = true; },
    };
  }

  function inboundReq(body) {
    const raw = new URLSearchParams({
      MessageSid: SID, From: PHONE, Body: body, AccountSid: "AC1",
    }).toString();
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

  const callInbound = async (body = "STOP") => {
    const res = mockRes();
    await inboundHandler(inboundReq(body), res);
    return res;
  };

  /** Every projection log line one call emitted, parsed back into objects. */
  async function projectionLines(fn) {
    const real = console.log;
    const lines = [];
    console.log = (...args) => { lines.push(args.map(String).join(" ")); };
    let result;
    try { result = await fn(); } finally { console.log = real; }
    const parsed = lines.map((l) => {
      const at = l.indexOf("{");
      if (at === -1) return null;
      try { return JSON.parse(l.slice(at)); } catch { return null; }
    }).filter(Boolean);
    return { result, lines, parsed };
  }

  const doneLine = (parsed) =>
    parsed.find((o) => o && o.event === "twilio.inbound.projection_done");
  const skipLine = (parsed) =>
    parsed.find((o) => o && o.event === "twilio.inbound.projection_skipped");

  /** A search answering `results`, and a PATCH responder for every write. */
  function stubHubSpot(results, onPatch) {
    const patches = [];
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).includes("/objects/contacts/search"))
        return new Response(JSON.stringify({ results }),
          { status: 200, headers: { "content-type": "application/json" } });
      patches.push(String(url));
      if (onPatch) return onPatch(String(url), options);
      return new Response(JSON.stringify({ id: "1" }),
        { status: 200, headers: { "content-type": "application/json" } });
    };
    return patches;
  }

  const needsWrite = (id) => ({ id: String(id), properties: {} });
  const alreadyMarked = (id) => ({
    id: String(id),
    properties: {
      [S.smsSuppressed]: "true",
      [S.smsSuppressedAt]: "2026-09-01T00:00:00.000Z",
      [S.smsSuppressionReason]: "stop_keyword",
    },
  });

  /* ---- 1. THE CAP -------------------------------------------------- */
  test("more contacts than the cap: the extra are skipped, and SAID to be skipped", async () => {
    const total = MAX_PROJECTION_CONTACTS + 7;
    const patches = stubHubSpot(Array.from({ length: total }, (_, i) => needsWrite(i + 1)));
    const calls = captureExecutor();

    const { result: res, parsed } = await projectionLines(() => callInbound("STOP"));

    assert.equal(res.statusCode, 200, "the cap changed what Twilio was told");
    assert.equal(calls.length, 1, "the ledger row was not written");
    assert.equal(patches.length, MAX_PROJECTION_CONTACTS,
      `the loop made ${patches.length} HubSpot writes against a cap of ${MAX_PROJECTION_CONTACTS}`);

    const done = doneLine(parsed);
    assert.ok(done, "no projection_done line was logged");
    assert.equal(done.contacts, total);
    assert.equal(done.written, MAX_PROJECTION_CONTACTS);
    assert.equal(done.skipped, total - MAX_PROJECTION_CONTACTS,
      "the contacts beyond the cap were dropped without being counted");
  });

  /* ---- 2. THE DEADLINE, AND THAT IT IS ABSOLUTE -------------------- */
  /* THE DEFECT THIS EXISTS TO PREVENT, in two parts.

     (a) A budget that starts when the projection starts STACKS on top of
         everything before it. Here the ledger append burns most of the
         budget first; a projection-local deadline would still give the
         write a full window, so the function would finish near
         ledger + PROJECTION_DEADLINE_MS and be killed at 15 s.

     (b) A deadline checked only BETWEEN requests bounds when a write may
         START and says nothing about when it ends. This write never
         resolves on its own — only the AbortSignal can end it, which is
         exactly the point: a Promise.race would leave it running. */
  test("the deadline runs from handler entry and ABORTS an in-flight write", async () => {
    const ledgerMs = 2800;            // just inside the real LEDGER_TIMEOUT_MS
    const searchMs = 5000;
    const aborts = [];

    _setExecutor(async () => {
      await new Promise((r) => setTimeout(r, ledgerMs));
      return [];
    });

    globalThis.fetch = async (url, options = {}) => {
      if (String(url).includes("/objects/contacts/search")) {
        await new Promise((r) => setTimeout(r, searchMs));
        return new Response(JSON.stringify({ results: [needsWrite(1)] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Promise((_, reject) => {
        const sig = options.signal;
        assert.ok(sig, "no AbortSignal reached the HubSpot write");
        const onAbort = () => {
          aborts.push(Date.now());
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        };
        if (sig.aborted) onAbort();
        else sig.addEventListener("abort", onAbort, { once: true });
      });
    };

    const started = Date.now();
    const { result: res, parsed } = await projectionLines(() => callInbound("STOP"));
    const elapsed = Date.now() - started;

    /* The ledger already succeeded, so Twilio still gets its empty TwiML. */
    assert.equal(res.statusCode, 200, "a CRM overrun changed the response to Twilio");
    assert.equal(aborts.length, 1, "the in-flight write was never aborted");

    assert.ok(elapsed >= ledgerMs + searchMs,
      `finished in ${elapsed}ms - the earlier phases did not consume what they were given`);

    /* THE TWO ASSERTIONS THAT MATTER. */
    assert.ok(elapsed < PROJECTION_DEADLINE_MS + 1500,
      `the handler took ${elapsed}ms against a ${PROJECTION_DEADLINE_MS}ms deadline measured from ENTRY - a projection-local budget would have allowed ~${ledgerMs + PROJECTION_DEADLINE_MS}ms`);
    assert.ok(elapsed < ledgerMs + searchMs + HUBSPOT_TIMEOUT_MS,
      `the handler took ${elapsed}ms - the write ran to HubSpot's own ${HUBSPOT_TIMEOUT_MS}ms timeout, so the bound is soft`);

    /* And the contact it could not reach is counted, not dropped. */
    const done = doneLine(parsed);
    assert.ok(done, "no projection_done line was logged");
    assert.equal(done.contacts, 1);
    assert.equal(done.skipped, 1, "the aborted write was not reported as unreached");
    assert.equal(done.written, 0);
  });

  /* ---- 3. THE TALLY INVARIANT -------------------------------------- */
  /* THE DEFECT THIS REPLACES, and it is the one #24 found in the operator
     action and left standing here: an already-marked contact produces an
     EMPTY patch, writeSuppressionProperties() answers `{ written: false }`
     without making a request, and the old loop counted it in no bucket at
     all. `written + failed` did not sum to the contacts found and a
     contact vanished from the only record of what the projection did. */
  test("every contact found lands in exactly one bucket, and they sum to the population", async () => {
    const marked = 4;
    const declines = 3;
    const writable = MAX_PROJECTION_CONTACTS + 2;   // two beyond the cap
    const total = marked + declines + writable;

    /* ids 1..marked are already suppressed; the next `declines` are
       refused by HubSpot; the rest are ordinary writes. */
    const results = [
      ...Array.from({ length: marked }, (_, i) => alreadyMarked(i + 1)),
      ...Array.from({ length: declines }, (_, i) => needsWrite(marked + i + 1)),
      ...Array.from({ length: writable }, (_, i) => needsWrite(marked + declines + i + 1)),
    ];
    const declineIds = new Set(
      Array.from({ length: declines }, (_, i) => String(marked + i + 1)));

    const patches = stubHubSpot(results, (url) => {
      const id = url.split("/").pop();
      if (declineIds.has(id))
        return new Response(JSON.stringify({ message: "nope" }),
          { status: 400, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ id }),
        { status: 200, headers: { "content-type": "application/json" } });
    });

    const calls = captureExecutor();
    const { result: res, parsed } = await projectionLines(() => callInbound("STOP"));

    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1, "the ledger row was not written");

    const done = doneLine(parsed);
    assert.ok(done, "no projection_done line was logged");

    /* THE INVARIANT. */
    assert.equal(done.written + done.unchanged + done.failed + done.skipped, done.contacts,
      `the buckets (${done.written}/${done.unchanged}/${done.failed}/${done.skipped}) do not sum to the ${done.contacts} contacts found`);
    assert.equal(done.contacts, total);

    /* And no bucket is a synonym for another. An already-marked contact is
       `unchanged` — never written, never failed, never unreached. */
    assert.equal(done.unchanged, marked,
      "an already-marked contact was not reported as unchanged");
    assert.equal(done.failed, declines,
      "a HubSpot refusal was not reported as a failure");
    assert.equal(done.written, MAX_PROJECTION_CONTACTS - declines,
      "the successful writes were miscounted");
    assert.equal(done.skipped, total - marked - MAX_PROJECTION_CONTACTS,
      "the contacts beyond the cap were not reported as unreached");

    /* An empty patch costs no request: only contacts needing one are
       subject to the cap. */
    assert.equal(patches.length, MAX_PROJECTION_CONTACTS,
      `${patches.length} HubSpot requests were made against a cap of ${MAX_PROJECTION_CONTACTS}`);
  });

  /* ---- 4. THE BUDGET ARITHMETIC, AND THE BRANCH IT LEAVES ---------- */
  /* THE LEDGER CANNOT BE WHAT SPENDS THE BUDGET, stated as an assertion
     rather than as a comment that ages badly. The append is hard-capped at
     LEDGER_TIMEOUT_MS, and so long as that cap plus a searchable minimum
     fits inside PROJECTION_DEADLINE_MS, a slow ledger always leaves the
     projection enough budget to run its search. Change either constant in
     the wrong direction and this fails. */
  test("the ledger's own cap always leaves the projection a searchable budget", () => {
    assert.ok(LEDGER_TIMEOUT_MS + MIN_SEARCH_MS < PROJECTION_DEADLINE_MS,
      `a ${LEDGER_TIMEOUT_MS}ms ledger append plus a ${MIN_SEARCH_MS}ms minimum search does not fit inside the ${PROJECTION_DEADLINE_MS}ms projection deadline - the projection could start with no budget`);
    /* And the whole endpoint still fits its function budget, which is the
       reason the deadline is 10 s here and 12 s in the operator action. */
    assert.ok(PROJECTION_DEADLINE_MS + 1000 < 15000,
      `a ${PROJECTION_DEADLINE_MS}ms deadline plus rendering does not fit inside the 15 s maxDuration in vercel.json`);
    assert.ok(MIN_WRITE_MS > 0 && MIN_WRITE_MS < MIN_SEARCH_MS,
      "the write floor is not a sane fraction of the search floor");
  });

  /* AND THE PHASE THAT COULD HAVE SPENT IT FAILS CLOSED FIRST. A ledger
     that hangs does not silently eat the projection's budget: it is cut at
     its own timeout and answers 503, so HubSpot is never reached and no
     suppression is reported as projected. */
  test("a hanging ledger is cut at its own timeout, before the projection can start", async () => {
    _setExecutor(async () => {
      await new Promise((r) => setTimeout(r, PROJECTION_DEADLINE_MS + 2000));
      return [];
    });
    let reached = 0;
    globalThis.fetch = async () => {
      reached += 1;
      throw new Error("NETWORK_NOT_ALLOWED_IN_TESTS");
    };

    const started = Date.now();
    const { result: res, parsed } = await projectionLines(() => callInbound("STOP"));
    const elapsed = Date.now() - started;

    /* Fail closed: the evidence is not durable, so this is never a 200. */
    assert.equal(res.statusCode, 503,
      "a ledger that never answered was reported to Twilio as success");
    assert.equal(reached, 0, "HubSpot was reached after the ledger failed");
    assert.ok(!parsed.some((o) => o && String(o.event || "").startsWith("twilio.inbound.projection")),
      "a projection ran after the durable record failed");
    assert.ok(elapsed < PROJECTION_DEADLINE_MS,
      `the handler took ${elapsed}ms - the ledger cap did not bound it below the projection deadline`);
  });

  /* SO WHAT DOES REACH IT: THE BODY READ, which is bounded in SIZE
     (MAX_WEBHOOK_BYTES) and NOT IN TIME. readFormBody() resolves when the
     stream ends, and a request that dribbles its body holds it open for as
     long as it likes.

     THIS IS THE REGRESSION FOR A DEFECT IN THIS PULL REQUEST'S OWN FIRST
     DRAFT, found by the pre-handoff review: the source asserted in prose
     that `budget_exhausted` was unreachable because the ledger was capped,
     having never checked whether anything ELSE before the projection was
     bounded in time. It is not. The prose claimed a guarantee the code did
     not make — the exact failure docs/WORKFLOW.md's second question asks
     about — and the branch is reachable, which is what this proves.

     It is also what makes the ABSOLUTE deadline load-bearing rather than
     merely tidy: a projection-local budget would hand a stalled request a
     fresh 10 s on top of the time it had already burned. */
  test("a request that stalls its body past the deadline skips the search and says so", async () => {
    const raw = new URLSearchParams({
      MessageSid: SID, From: PHONE, Body: "STOP", AccountSid: "AC1",
    }).toString();

    /* A request whose body arrives only after the deadline has passed.
       `body` is deliberately absent so readFormBody() takes its streaming
       path, and the stream is fed once the LAST listener is attached. */
    const stallMs = PROJECTION_DEADLINE_MS + 500;
    const handlers = {};
    const stalling = {
      method: "POST",
      url: "/api/twilio-inbound",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(raw)),
        "x-forwarded-proto": "https",
        "x-forwarded-host": "crystalsellstoledo.com",
        "x-twilio-signature": "stub",
      },
      on(ev, cb) {
        handlers[ev] = cb;
        /* Scheduled once, on the FIRST listener, rather than on a
           particular one: readFormBody() attaches data, end and error in
           the same tick, and keying the timer to the last of them by name
           would silently never fire — and hang this test rather than fail
           it — if that order ever changed. */
        if (!this._fed) {
          this._fed = true;
          setTimeout(() => {
            assert.ok(handlers.data && handlers.end,
              "readFormBody no longer streams - this test would prove nothing");
            handlers.data(Buffer.from(raw, "utf8"));
            handlers.end();
          }, stallMs);
        }
        return this;
      },
      destroy() {},
    };

    const calls = captureExecutor();
    /* Any HubSpot call at all is the failure this test looks for. */
    let reached = 0;
    globalThis.fetch = async () => {
      reached += 1;
      throw new Error("NETWORK_NOT_ALLOWED_IN_TESTS");
    };

    const res = mockRes();
    const { parsed } = await projectionLines(() => inboundHandler(stalling, res));

    /* The message was still classified and the suppression still recorded:
       the budget costs the projection and nothing above it. */
    assert.equal(calls.length, 1, "the durable record was lost to a slow body read");
    assert.equal(res.statusCode, 200, "an exhausted budget changed what Twilio was told");

    assert.equal(reached, 0, "a search was started with no budget left to run it");
    const skipped = skipLine(parsed);
    assert.ok(skipped, "no projection_skipped line was logged");
    assert.equal(skipped.reason, "budget_exhausted",
      "an exhausted budget was reported as something else");
    /* AND NOT AS A HUBSPOT FAILURE, which is the wrong story about the
       same facts: nothing was asked of HubSpot, so nothing declined. */
    assert.ok(!parsed.some((o) => o && o.event === "twilio.inbound.projection_failed"),
      "an exhausted budget was reported as a HubSpot failure");
  });

  /* ---- 5. THE RE-OPT-IN PATH IS BOUNDED THE SAME WAY --------------- */
  /* toHubSpotReoptinProperties() ALWAYS returns a non-empty patch, so
     every contact needs a request and the cap is the only thing between a
     100-contact number and 100 sequential writes. */
  test("a re-opt-in projection is capped too, and still grants nothing", async () => {
    const total = MAX_PROJECTION_CONTACTS + 5;
    const patches = stubHubSpot(Array.from({ length: total }, (_, i) => needsWrite(i + 1)),
      (url, options) => {
        const body = JSON.parse(String(options.body || "{}"));
        for (const forbidden of ["permission_status", "consent_at", "copy_version"])
          assert.ok(!JSON.stringify(body).includes(forbidden),
            `a re-opt-in projection wrote ${forbidden}`);
        return new Response(JSON.stringify({ id: "1" }),
          { status: 200, headers: { "content-type": "application/json" } });
      });
    const calls = captureExecutor();

    const { result: res, parsed } = await projectionLines(() => callInbound("START"));

    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1, "the re-opt-in request was not recorded");
    assert.equal(patches.length, MAX_PROJECTION_CONTACTS,
      `the re-opt-in loop made ${patches.length} writes against a cap of ${MAX_PROJECTION_CONTACTS}`);
    const done = doneLine(parsed);
    assert.equal(done.written + done.unchanged + done.failed + done.skipped, done.contacts,
      "the re-opt-in buckets do not sum to the contacts found");
    assert.equal(done.skipped, total - MAX_PROJECTION_CONTACTS);
  });

  /* ---- 6. THE BOUND NEVER COSTS THE DURABLE RECORD ----------------- */
  test("a projection that reaches nothing still leaves the ledger row and a 200", async () => {
    stubHubSpot([needsWrite(1)], () => { throw new Error("hubspot is down"); });
    const calls = captureExecutor();

    const { result: res } = await projectionLines(() => callInbound("STOP"));

    assert.equal(res.statusCode, 200,
      "a HubSpot outage turned a recorded suppression into a Twilio error");
    assert.equal(calls.length, 1, "the durable record was lost to a projection failure");
    assert.match(res.body, /<Response><\/Response>/,
      "the empty TwiML Twilio expects was not returned");
  });
});
