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
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  verifyTwilioSignature, requestUrl,
  parseFormParams, optOutType, twilioConfigured,
  TWILIO_TOKEN_VAR, TWILIO_NOT_CONFIGURED, TWILIO_SIGNATURE_MISSING,
  TWILIO_SIGNATURE_INVALID, TWILIO_URL_UNRESOLVABLE,
  readFormBody, bodyErrorReason, BODY_READ_TIMEOUT_MS, BODY_READ_TIMED_OUT,
  MAX_WEBHOOK_BYTES,
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
import { NOTIFICATION_DEADLINE_MS } from "../api/_lib/mail.mjs";
import inboundHandler, {
  MAX_PROJECTION_CONTACTS, PROJECTION_DEADLINE_MS, MIN_WRITE_MS, MIN_SEARCH_MS,
  WEBHOOK_BODY_TIMEOUT_MS,
} from "../api/twilio-inbound.js";
import { withRawRequest } from "./helpers.mjs";

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
    /* AND SO DOES THE BODY READ, since 11 September 2026. Both phases
       before the projection are capped now, so `budget_exhausted` is
       unreachable by arithmetic rather than by hope — and this is the
       assertion that notices if any of the four constants moves. */
    assert.ok(WEBHOOK_BODY_TIMEOUT_MS + LEDGER_TIMEOUT_MS + MIN_SEARCH_MS < PROJECTION_DEADLINE_MS,
      `a ${WEBHOOK_BODY_TIMEOUT_MS}ms body read plus a ${LEDGER_TIMEOUT_MS}ms ledger append plus a ${MIN_SEARCH_MS}ms minimum search does not fit inside the ${PROJECTION_DEADLINE_MS}ms projection deadline`);
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

  /* THE BODY READ IS NOW BOUNDED TOO, AND THIS TEST RECORDS THE CHANGE.

     Until 11 September 2026 readFormBody() was bounded in SIZE and not in
     time, and a request that dribbled its body was the ONLY way to reach
     `budget_exhausted`. The test that stood here proved exactly that.

     It no longer can, and that is the point: the body read is refused at
     WEBHOOK_BODY_TIMEOUT_MS, long before the projection deadline, so the
     handler answers 400 having interpreted nothing. What this test asserts
     is the new, stronger behaviour — a stalled body costs the request and
     NOTHING ELSE: no classification, no ledger row, no HubSpot call. */
  test("a request that stalls its body is refused, and nothing is classified or written", async () => {
    const raw = new URLSearchParams({
      MessageSid: SID, From: PHONE, Body: "STOP", AccountSid: "AC1",
    }).toString();

    /* THE BODY SIMPLY NEVER ARRIVES. `body` is absent so readFormBody()
       takes its streaming path, and this mock delivers nothing — which is
       what "stalls" means, and needs no timer to express.

       AN EARLIER VERSION SCHEDULED "LATE EVENTS" HERE, at
       PROJECTION_DEADLINE_MS + 500, and then asserted below that they
       "have already fired by now". They had not: the handler answers at
       about WEBHOOK_BODY_TIMEOUT_MS, roughly seven seconds earlier, and
       the timer was unref()'d so it may never have fired at all. It also
       carried a guard that would have FAILED had it fired, because the
       listeners it checked for are removed at timeout. A test that claims
       to exercise something it does not is worse than one that does not
       claim it — post-timeout `data`, `end` and `error` are exercised for
       real in the readFormBody section, against an EventEmitter that
       actually emits them. This test keeps only what it can prove: the
       handler-level consequences of a body that never came. */
    const handlers = {};
    let destroyed = 0;
    let paused = 0;
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
      on(ev, cb) { handlers[ev] = cb; return this; },
      off(ev) { delete handlers[ev]; return this; },
      destroy() { destroyed += 1; this.destroyed = true; },
      pause() { paused += 1; return this; },
    };

    const calls = captureExecutor();
    let reached = 0;
    globalThis.fetch = async () => {
      reached += 1;
      throw new Error("NETWORK_NOT_ALLOWED_IN_TESTS");
    };

    const res = mockRes();
    const started = Date.now();
    const { parsed } = await projectionLines(() => inboundHandler(stalling, res));
    const elapsed = Date.now() - started;

    /* BOUNDED, and bounded at the BODY read rather than at anything later. */
    assert.ok(elapsed < WEBHOOK_BODY_TIMEOUT_MS + 1500,
      `the handler took ${elapsed}ms against a ${WEBHOOK_BODY_TIMEOUT_MS}ms body-read bound`);
    assert.ok(elapsed < PROJECTION_DEADLINE_MS,
      `the handler took ${elapsed}ms - it outlived the projection deadline, so the body read is not bounded`);

    /* FAIL CLOSED, AND INTERPRET NOTHING. */
    assert.equal(res.statusCode, 400, "a stalled body was not refused");
    assert.equal(calls.length, 0, "a ledger row was written from a body that never arrived");
    assert.equal(reached, 0, "HubSpot was called for a body that never arrived");
    assert.ok(!parsed.some((o) => o && String(o.event || "").startsWith("twilio.inbound.projection")),
      "a projection ran on a timed-out body");
    assert.ok(!parsed.some((o) => o && o.event === "twilio.inbound.ledger_appended"),
      "something was classified and recorded from a timed-out body");

    /* The refusal says WHY, in a fixed vocabulary, and carries no body. */
    const rejected = parsed.find((o) => o && o.event === "twilio.inbound.body_rejected");
    assert.ok(rejected, "no body_rejected line was logged");
    assert.equal(rejected.reason, "timed_out",
      "a timed-out body was reported as something else");

    /* THE READ WAS ACTUALLY STOPPED, not merely ignored — and the socket
       was NOT destroyed, because `res` shares it and the 400 above still
       has to reach Twilio. A test that only checked the status code would
       pass against an implementation that left the stream running, and one
       that asserted destruction would pass against the bug. */
    assert.equal(destroyed, 0, "the stalled stream was destroyed - that kills the 400");
    assert.equal(paused, 1, "the stalled stream was not paused");
    assert.ok(!handlers.data && !handlers.end,
      "the data/end listeners were left attached after the timeout");
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

/* =====================================================================
   8  readFormBody() IS BOUNDED IN TIME, NOT ONLY IN SIZE
   =====================================================================
   Carried forward from PR #26 and PR #27, and a prerequisite for Twilio
   activation. The streaming path used to resolve only on the stream's own
   `end`, so a client that stalled held the promise pending until the
   platform killed the function.

   THE FAKE REQUEST IS A REAL EventEmitter, deliberately. A hand-rolled
   stub would let listener removal and the "error with no listener throws"
   rule be whatever the test wanted them to be — and those are two of the
   things most worth proving here.
   ===================================================================== */
describe("readFormBody time bound", () => {
  const FORM = "MessageSid=SM1&From=%2B14195550123&Body=STOP";

  /** A request whose body never arrives unless this test makes it. */
  function fakeReq({ contentLength = Buffer.byteLength(FORM) } = {}) {
    const req = new EventEmitter();
    req.method = "POST";
    req.url = "/api/twilio-inbound";
    req.headers = {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(contentLength),
    };
    req.destroyed = false;
    req.destroyCount = 0;
    req.pauseCount = 0;
    req.destroy = function destroy() {
      this.destroyCount += 1;
      this.destroyed = true;
    };
    req.pause = function pause() { this.pauseCount += 1; return this; };
    return req;
  }

  const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

  /* ---- A STREAM THAT NEVER ENDS ------------------------------------ */
  test("a body that never arrives is rejected, not awaited forever", async () => {
    const req = fakeReq();
    const started = Date.now();
    const out = await settle(readFormBody(req, { timeoutMs: 120 }));
    const elapsed = Date.now() - started;

    assert.equal(out.ok, false, "a body that never arrived resolved");
    assert.equal(out.e.token, BODY_READ_TIMED_OUT);
    assert.equal(bodyErrorReason(out.e), "timed_out");
    assert.ok(elapsed < 1000, `took ${elapsed}ms - the bound did not fire`);

    /* STOPPED, not merely ignored — and NOT destroyed. Destroying `req`
       destroys the socket `res` shares, which loses the caller's 400
       entirely (measured; see the node:http section below). The earlier
       version of this test asserted destroyCount === 1 and called it
       proof of cancellation, so it PASSED BECAUSE IT ASSERTED THE BUG. */
    assert.equal(req.destroyCount, 0, "the stalled stream was destroyed - that kills the caller's response");
    assert.equal(req.pauseCount, 1, "the stalled stream was not paused, so it may still be flowing");
    assert.equal(req.listenerCount("data"), 0, "the data listener was left attached");
    assert.equal(req.listenerCount("end"), 0, "the end listener was left attached");
  });

  /* ---- SOME BYTES, THEN A STALL ------------------------------------ */
  test("a body that starts and then stalls is rejected, and nothing partial is returned", async () => {
    const req = fakeReq();
    const p = settle(readFormBody(req, { timeoutMs: 120 }));
    req.emit("data", Buffer.from("MessageSid=SM1&Bo", "utf8"));
    const out = await p;

    assert.equal(out.ok, false, "a half-arrived body resolved");
    assert.equal(out.e.token, BODY_READ_TIMED_OUT);
    /* CLAUDE.md rule 11: reject, never truncate. Nothing partial escapes. */
    assert.equal(out.v, undefined);
    assert.equal(req.destroyCount, 0, "the socket was destroyed - the caller's response would be lost");
    assert.equal(req.pauseCount, 1);
  });

  /* ---- LATE EVENTS AFTER THE TIMEOUT ------------------------------- */
  test("data and end arriving after the timeout change nothing and throw nothing", async () => {
    const req = fakeReq();
    const out = await settle(readFormBody(req, { timeoutMs: 60 }));
    assert.equal(out.e.token, BODY_READ_TIMED_OUT);

    /* The stream keeps going, as a real stalled socket might. None of this
       may resurrect the request, double-settle, or throw. */
    req.emit("data", Buffer.from(FORM, "utf8"));
    req.emit("end");
    /* An `error` with no listener THROWS on an EventEmitter, which on a
       serverless runtime takes the invocation down after the answer has
       been sent. The absorbing listener is why this does not. */
    assert.ok(req.listenerCount("error") > 0,
      "no error listener remains - a post-timeout stream error would throw");
    req.emit("error", new Error("ECONNRESET"));

    await new Promise((r) => setImmediate(r));
    assert.equal(req.destroyCount, 0, "the socket was destroyed");
  });

  /* ---- A NORMAL STREAMED BODY -------------------------------------- */
  /* THE NAME MATTERS HERE. This test used to be called "…leaves no timer
     or listeners behind", which was FALSE and contradicted the source:
     readFormBody() DELIBERATELY retains the `error` listener after it
     settles, because a stream can emit `error` afterwards and an `error`
     with no listener is THROWN by EventEmitter — which on a serverless
     runtime kills the invocation after it has already answered.

     So the invariant is not "nothing behind". It is: the timer is
     cleared, `data` and `end` are removed, `error` is retained and
     NEUTRALISED, and a late error changes neither the settled result nor
     the process. That is what is asserted. The retained listener is a
     design decision, not an oversight, and the test now says so rather
     than being quietly wrong about it. */
  test("an ordinary streamed body resolves: timer cleared, data/end removed, error listener retained and inert", async () => {
    const req = fakeReq();
    const p = settle(readFormBody(req, { timeoutMs: 5000 }));
    req.emit("data", Buffer.from(FORM.slice(0, 10), "utf8"));
    req.emit("data", Buffer.from(FORM.slice(10), "utf8"));
    req.emit("end");
    const out = await p;

    assert.equal(out.ok, true, "a complete body was rejected");
    assert.equal(out.v.MessageSid, "SM1");
    assert.equal(out.v.From, "+14195550123");
    assert.equal(out.v.Body, "STOP");

    /* Nothing is destroyed or paused on success. */
    assert.equal(req.destroyCount, 0, "a successful read destroyed the stream");
    assert.equal(req.pauseCount, 0, "a successful read paused the stream");

    /* The two body listeners go. */
    assert.equal(req.listenerCount("data"), 0, "the data listener was left attached");
    assert.equal(req.listenerCount("end"), 0, "the end listener was left attached");

    /* THE ERROR LISTENER STAYS, ON PURPOSE. Asserted as an invariant so
       that removing it — which would make the old test name true — fails
       here instead of failing in production as an uncaught 'error'. */
    assert.ok(req.listenerCount("error") > 0,
      "the error listener was removed - a later stream error would be thrown, not absorbed");

    /* AND IT IS INERT: a late error neither throws nor re-settles. */
    req.emit("error", new Error("ECONNRESET"));
    assert.equal(out.ok, true, "a late error changed the settled result");
    assert.equal(out.v.MessageSid, "SM1");

    /* THE TIMER MUST NOT FIRE AFTER SUCCESS. If it were still armed it
       would reject an already-resolved promise — invisible — and keep the
       handle alive. Waiting past the original bound would expose it. */
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(out.ok, true);
    assert.equal(out.v.MessageSid, "SM1", "the settled value changed after the bound elapsed");
  });

  /* ---- OVERSIZE STILL WINS ----------------------------------------- */
  test("oversize is still refused, by declared length and by actual bytes", async () => {
    const declared = await settle(readFormBody(
      fakeReq({ contentLength: MAX_WEBHOOK_BYTES + 1 }), { timeoutMs: 5000 }));
    assert.equal(declared.ok, false);
    assert.equal(declared.e.token, "PAYLOAD_TOO_LARGE");
    assert.equal(bodyErrorReason(declared.e), "too_large");

    /* And when the declared length lies, the running total still catches
       it — before the time bound, and without waiting for it. */
    const req = fakeReq();
    const p = settle(readFormBody(req, { timeoutMs: 5000 }));
    req.emit("data", Buffer.alloc(MAX_WEBHOOK_BYTES + 1));
    const actual = await p;
    assert.equal(actual.ok, false);
    assert.equal(actual.e.token, "PAYLOAD_TOO_LARGE");
    /* The oversize branch has destroyed the socket since #20. It stops the
       stream the same way as the timeout now: paused, never destroyed. */
    assert.equal(req.destroyCount, 0, "an oversize body destroyed the socket - the 400 would be lost");
    assert.equal(req.pauseCount, 1, "an oversize stream was not stopped");
    assert.equal(req.listenerCount("data"), 0);
  });

  /* ---- THE FAST PATHS ARE NOT DELAYED ------------------------------ */
  test("a pre-parsed string or object body resolves immediately and arms no timer", async () => {
    const asString = fakeReq();
    asString.body = FORM;
    const s = Date.now();
    const outString = await readFormBody(asString, { timeoutMs: 1 });
    /* timeoutMs: 1 is the proof. If the fast path armed a timer at all,
       a 1 ms bound would race it and this would be flaky-to-failing. */
    assert.equal(outString.MessageSid, "SM1");
    assert.ok(Date.now() - s < 50);
    assert.equal(asString.listenerCount("data"), 0, "the fast path attached a stream listener");

    const asObject = fakeReq();
    asObject.body = { MessageSid: "SM2", From: "+14195550123", Empty: null };
    const outObject = await readFormBody(asObject, { timeoutMs: 1 });
    assert.equal(outObject.MessageSid, "SM2");
    assert.equal(outObject.Empty, "", "a null value was not flattened to an empty string");
    assert.equal(asObject.listenerCount("data"), 0);

    /* An oversize pre-parsed string is still refused. */
    const big = fakeReq();
    big.body = "x".repeat(MAX_WEBHOOK_BYTES + 1);
    const outBig = await settle(readFormBody(big, { timeoutMs: 5000 }));
    assert.equal(outBig.e.token, "PAYLOAD_TOO_LARGE");
  });

  /* ---- A STREAM ERROR STILL REJECTS -------------------------------- */
  test("a stream error rejects and is not reported as a timeout", async () => {
    const req = fakeReq();
    const p = settle(readFormBody(req, { timeoutMs: 5000 }));
    req.emit("error", new Error("ECONNRESET"));
    const out = await p;
    assert.equal(out.ok, false);
    assert.notEqual(out.e.token, BODY_READ_TIMED_OUT);
    assert.equal(bodyErrorReason(out.e), "unreadable");
  });

  /* ---- THE MUTATION PROOF ------------------------------------------ */
  /* The assertions above pass against the fixed module. This proves they
     would NOT pass against the code they replaced — run against a
     THROWAWAY COPY of the tree with the bound removed, never against the
     deployment candidate, and never by breaking the working tree. */
  test("without the bound, the same stalled request never settles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cst-body-bound-"));
    try {
      const lib = join(dir, "twilio.mjs");
      const src = readFileSync(join(REPO, "api/_lib/twilio.mjs"), "utf8");

      /* TWO EDITS, and both are stated rather than hidden.

         1. The timer that arms the bound — the mutation under test.
         2. The `twilio` package import, which cannot resolve from a
            temp directory outside the repo. It is used ONLY by
            verifyTwilioSignature(), which this test never calls, and the
            reference lives inside a function body so the module still
            loads. readFormBody() itself is byte-identical to the real
            one apart from edit 1, which is the whole point. */
      const TIMER = "const timer = setTimeout(() => finish(bodyError(BODY_READ_TIMED_OUT)), Math.max(1, timeoutMs));";
      const IMPORT = 'import twilio from "twilio";';
      assert.ok(src.includes(TIMER),
        "the bound's timer moved - this mutation would prove nothing");
      assert.ok(src.includes(IMPORT), "the twilio import moved");
      const mutated = src
        .replace(TIMER, "const timer = { unref() {} };")
        .replace(IMPORT, "const twilio = { validateRequest() { throw new Error('not used here'); } };");
      assert.notEqual(mutated, src, "the mutation changed nothing");
      /* The ONLY difference inside readFormBody is the disarmed timer. */
      const fn = (t) => t.slice(t.indexOf("export function readFormBody"),
        t.indexOf("/* ---------------------------------------------------------------------\n   OptOutType"));
      assert.equal(fn(mutated), fn(src).replace(TIMER, "const timer = { unref() {} };"),
        "the copy differs from the real readFormBody by more than the timer");
      writeFileSync(lib, mutated);

      const { readFormBody: unbounded } = await import(pathToFileURL(lib).href);

      const req = fakeReq();
      const race = await Promise.race([
        settle(unbounded(req, { timeoutMs: 60 })),
        new Promise((r) => setTimeout(() => r("STILL_PENDING"), 400)),
      ]);
      assert.equal(race, "STILL_PENDING",
        "the pre-fix implementation settled - the bound is not what makes the fixed one settle");
      assert.equal(req.pauseCount, 0, "the pre-fix implementation stopped the read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /* ---- THE CALL SITE THE WEBHOOK ACTUALLY USES --------------------- */
  test("the webhook's bound is tighter than the module default, and fits its budget", () => {
    assert.ok(WEBHOOK_BODY_TIMEOUT_MS < BODY_READ_TIMEOUT_MS,
      "the webhook no longer overrides the default - it shares Twilio's ~15 s clock and needs the tighter bound");
    /* The unclassified path is the binding one: body + notification +
       rendering must leave room inside a 15 s maxDuration. */
    assert.ok(WEBHOOK_BODY_TIMEOUT_MS + NOTIFICATION_DEADLINE_MS + 1000 < 15000,
      `a ${WEBHOOK_BODY_TIMEOUT_MS}ms body read plus a ${NOTIFICATION_DEADLINE_MS}ms notification does not leave room inside the 15 s maxDuration`);
  });
});

/* =====================================================================
   9  AGAINST A REAL SOCKET — node:http, not a stub
   =====================================================================
   Everything in section 8 drives an EventEmitter. That proved the bound
   fires and the listeners go, and it proved NOTHING about what the bound
   does to the HTTP response — because a stub has no socket to lose.

   THE DEFECT THIS SECTION EXISTS TO HAVE CAUGHT. readFormBody() called
   req.destroy() on timeout, and the oversize branch had called it since
   the gate 7 SMS work merged in #20. `req` and `res` share ONE socket, so
   destroying the request destroyed the response with it. Measured here on
   11 September 2026, before the fix:

     req.destroy()  ->  socket.destroyed = true
                        res.end() DOES NOT THROW
                        res.writableEnded becomes true
                        the client receives ECONNRESET, never the 400

   The handler is told nothing. It logs a refusal it did not deliver —
   which for the webhook means Twilio records a connection reset for a
   request this endpoint believed it had answered.

   The stub tests could not see any of it, and two of them asserted
   `destroyCount === 1` as PROOF OF CORRECT CANCELLATION. They passed
   because they asserted the bug.
   ===================================================================== */
describe("readFormBody against a real node:http socket", () => {
  /**
   * Run one request against a real server and report what the CLIENT saw.
   * `handler` gets (req, res) and decides how to read and answer.
   */
  async function withServer(handler, { write = "MessageSid=SM1&Bo", contentLength = 200 } = {}) {
    const seen = { server: {}, clientStatus: null, clientBody: "", clientError: null };
    const server = createServer((req, res) => { handler(req, res, seen); });
    /* RECORDED, NEVER DESTROYED. Node's default clientError handler
       destroys the socket, and an earlier draft of this harness copied
       that — which killed the very response under test and made the
       fixed code look broken. The harness observes; it does not
       intervene. */
    server.on("clientError", (err) => { seen.serverClientError = err.code; });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();

    let clientReq;
    try {
      await new Promise((resolve) => {
        let done = false;
        let guard;
        /* THE GUARD IS CLEARED ON THE WAY OUT, and an earlier draft of
           this harness did not clear it. The stalled client never
           finishes its body, so server.close() below waits on that
           lingering connection — long enough for a still-armed 4 s guard
           to fire and overwrite `clientError` with NO_ANSWER AFTER the
           400 had already been received. The harness then reported a
           delivered response as lost, and the fixed code looked broken.
           An observation that can be rewritten after the fact is not an
           observation. */
        const fin = () => {
          if (done) return;
          done = true;
          clearTimeout(guard);
          resolve();
        };
        clientReq = httpRequest({
          host: "127.0.0.1", port, method: "POST", path: "/api/twilio-inbound",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "content-length": String(contentLength),
          },
        });
        clientReq.on("response", (res) => {
          seen.clientStatus = res.statusCode;
          res.on("data", (d) => { seen.clientBody += d; });
          res.on("end", fin);
        });
        clientReq.on("error", (err) => { seen.clientError = err.code || err.message; fin(); });
        /* A partial body, and then nothing — ever. */
        clientReq.write(write);
        /* A ceiling so a regression fails the assertion, not the suite. */
        guard = setTimeout(() => {
          seen.clientError = seen.clientError || "NO_ANSWER";
          fin();
        }, 4000);
      });
    } finally {
      /* The CLIENT's half is torn down here — never the server's socket,
         which is what carries the response under test. Without this,
         server.close() waits on a connection whose body never completes. */
      try { clientReq?.destroy(); } catch { /* already gone */ }
      /* The stalled request's body never completes, so its connection
         lingers and server.close() alone never calls back — the test
         would hang rather than fail. Every observation has already been
         recorded by this point, so dropping the sockets here cannot
         affect what was measured. */
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
    return seen;
  }

  /* ---- THE REGRESSION ---------------------------------------------- */
  test("a stalled body times out AND the caller's 400 still reaches the client", async () => {
    const seen = await withServer(async (req, res, out) => {
      try {
        await readFormBody(req, { timeoutMs: 150 });
        out.server.reason = "resolved";
      } catch (err) {
        out.server.reason = err?.token;
      }
      /* Exactly what both endpoints do next. */
      out.server.socketDestroyedBeforeAnswer = res.socket ? res.socket.destroyed : null;
      res.statusCode = 400;
      res.end("Not recorded");
    });

    assert.equal(seen.server.reason, BODY_READ_TIMED_OUT, "the bound did not fire");

    /* THE ASSERTION THE STUBS COULD NOT MAKE. */
    assert.equal(seen.server.socketDestroyedBeforeAnswer, false,
      "the socket was already destroyed when the handler went to answer - the response cannot be delivered");
    assert.equal(seen.clientError, null,
      `the client got ${seen.clientError} instead of a response - the refusal was lost on the wire`);
    assert.equal(seen.clientStatus, 400, "the client did not receive the 400");
    assert.equal(seen.clientBody, "Not recorded");
  });

  /* ---- THE SAME FOR OVERSIZE, which has had this since #20 ---------- */
  test("an oversize body is refused AND the caller's 400 still reaches the client", async () => {
    const seen = await withServer(async (req, res, out) => {
      try {
        await readFormBody(req, { timeoutMs: 5000 });
        out.server.reason = "resolved";
      } catch (err) {
        out.server.reason = err?.token;
      }
      out.server.socketDestroyedBeforeAnswer = res.socket ? res.socket.destroyed : null;
      res.statusCode = 400;
      res.end("Not recorded");
      /* WHICH REFUSAL PATH THIS ACTUALLY EXERCISES, corrected on
         11 September 2026. The declared Content-Length is itself over the
         cap, so readFormBody() refuses at the HEADER FAST PATH, before a
         byte is accumulated. The comment here previously claimed the
         opposite — that the refusal came "from the running byte total
         rather than from the header check" — and that claim was false;
         #30 recorded it as a sequenced follow-up.

         The test is still worth what it asserts: the oversize refusal
         reaches the client and the socket was not destroyed to deliver
         it. It is simply evidence about the HEADER path.

         THE STREAMING size check is reached only by a chunked body with
         no Content-Length, and is proved on a raw socket in section 10
         below. */
    }, { write: "x".repeat(MAX_WEBHOOK_BYTES + 64), contentLength: MAX_WEBHOOK_BYTES + 64 });

    assert.equal(seen.server.reason, "PAYLOAD_TOO_LARGE", "an oversize body was not refused");
    assert.equal(seen.server.socketDestroyedBeforeAnswer, false,
      "the socket was destroyed on the oversize path - the response cannot be delivered");
    assert.equal(seen.clientStatus, 400, "the client did not receive the oversize refusal");
  });

  /* ---- AND AN ORDINARY REQUEST IS UNAFFECTED ----------------------- */
  test("a complete body over a real socket resolves and answers 200", async () => {
    const body = "MessageSid=SM1&From=%2B14195550123&Body=STOP";
    const seen = await withServer(async (req, res, out) => {
      try {
        const params = await readFormBody(req, { timeoutMs: 5000 });
        out.server.reason = "resolved";
        out.server.sid = params.MessageSid;
        out.server.body = params.Body;
      } catch (err) {
        out.server.reason = err?.token || err?.message;
      }
      res.statusCode = 200;
      res.end("ok");
    }, { write: body, contentLength: Buffer.byteLength(body) });

    assert.equal(seen.server.reason, "resolved", "a complete body was refused");
    assert.equal(seen.server.sid, "SM1");
    assert.equal(seen.server.body, "STOP");
    assert.equal(seen.clientStatus, 200);
    assert.equal(seen.clientBody, "ok");
  });

  /* ---- THE MUTATION PROOF, ON A REAL SOCKET ------------------------ */
  /* Section 8's mutation disarmed the timer. This one restores the
     destroy() and shows the client loses the response — run against a
     THROWAWAY COPY of the tree, never the deployment candidate. */
  test("restoring req.destroy() loses the response on the wire", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cst-destroy-"));
    try {
      const lib = join(dir, "twilio.mjs");
      const src = readFileSync(join(REPO, "api/_lib/twilio.mjs"), "utf8");
      const PAUSE = `      if (err && typeof req.pause === "function") {
        try { req.pause(); } catch { /* already ended; nothing to pause */ }
      }`;
      assert.ok(src.includes(PAUSE), "the pause block moved - this mutation would prove nothing");
      const mutated = src
        .replace(PAUSE, `      if (err && typeof req.destroy === "function" && req.destroyed !== true) {
        try { req.destroy(); } catch { /* already gone */ }
      }`)
        .replace('import twilio from "twilio";',
          "const twilio = { validateRequest() { throw new Error('not used here'); } };");
      assert.notEqual(mutated, src, "the mutation changed nothing");
      writeFileSync(lib, mutated);
      const { readFormBody: destroying } = await import(pathToFileURL(lib).href);

      const seen = await withServer(async (req, res, out) => {
        try { await destroying(req, { timeoutMs: 150 }); } catch (err) { out.server.reason = err?.token; }
        out.server.socketDestroyedBeforeAnswer = res.socket ? res.socket.destroyed : null;
        res.statusCode = 400;
        /* res.end() does NOT throw here, which is exactly why the bug is
           invisible from inside the handler. */
        res.end("Not recorded");
        out.server.writableEnded = res.writableEnded;
      });

      assert.equal(seen.server.reason, BODY_READ_TIMED_OUT);
      assert.equal(seen.server.socketDestroyedBeforeAnswer, true,
        "the pre-fix code did not destroy the socket - this mutation proves nothing");
      /* The handler believes it answered... */
      assert.equal(seen.server.writableEnded, true,
        "res.end() reported failure - the bug would have been visible without this test");
      /* ...and the client got nothing. */
      assert.notEqual(seen.clientStatus, 400,
        "the client received the 400 from the pre-fix code - the defect does not reproduce");
      assert.ok(seen.clientError, "the client saw neither a response nor an error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* =====================================================================
   10  THE CONNECTION, NOT ONLY THE RESPONSE — RAW SOCKET
   =====================================================================
   Section 9 proves what the CLIENT RECEIVED. It cannot prove what state
   the exchange LEFT BEHIND, because its harness tears the connection
   down as soon as the response has been seen — and a teardown that runs
   before the observation is not a teardown, it is the experiment. That
   is the lesson #30 paid for and the reason CLAUDE.md rule 15 now says
   the observable outcome includes connection state and framing.

   THE DEFECT REPAIRED HERE. api/twilio-inbound.js could answer while a
   declared request body had not been completely consumed and still send
   `Connection: keep-alive`. The socket survives, so the response's own
   framing metadata advertised a connection that becomes usable again
   only once the client sends the rest of the body it declared — which,
   on a refused read, is by definition what it did not do. Same shape,
   same rule, same mechanism as the six paths #30 fixed in api/lead.js.

   WHAT EACH CASE BELOW IS FOR. A and B are a CONTROLLED PAIR: the same
   branch, the same status, one bodyless and one with a declared body
   outstanding. They are the evidence that the signal is the REQUEST'S
   OWN STATE and not which branch refused — and A is the guard against
   the over-blunt `!req.complete` rule, which a first draft of the lead
   fix used and which closes the connection on every ordinary bodyless
   probe.

   C reaches the STREAMING size check, which needs chunked framing and
   no Content-Length: a declared oversize length is refused at the header
   fast path instead (section 9's oversize test, whose prose used to
   claim otherwise). D is the ordinary complete request that must keep
   keep-alive.

   These drive the REAL EXPORTED HANDLER, not a re-implementation of it.
   ===================================================================== */
describe("the webhook's connection lifecycle, on a raw socket", () => {
  const ENV = [TWILIO_TOKEN_VAR];
  let saved;

  before(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env[TWILIO_TOKEN_VAR] = TOKEN;
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const CRLF = "\r\n";
  const req = (line, headers = [], body = "") =>
    line + CRLF + ["Host: 127.0.0.1", ...headers].join(CRLF) + CRLF + CRLF + body;

  /* A second request written once a response head has been seen. If the
     connection is genuinely reusable the server dispatches it. */
  const SECOND = req("PUT /api/twilio-inbound HTTP/1.1");

  /* THE WHOLE RESPONSE, not merely "a response arrived". Closing the
     connection must not truncate what was already being written, and the
     refusals on this endpoint carry an EMPTY body — so "the body is
     non-empty" would prove nothing here. The response's OWN
     Content-Length is what it promised to deliver; compare the bytes
     actually received against it. */
  function assertWholeResponse(seen) {
    const head = seen.raw.split("\r\n\r\n")[0] || "";
    assert.ok(seen.raw.includes("\r\n\r\n"), "the response head never terminated");
    const declared = Number((head.match(/\r\nContent-Length: *(\d+)/i) || [])[1]);
    assert.ok(Number.isFinite(declared),
      "the response declared no Content-Length - completeness cannot be checked from the client");
    assert.equal(Buffer.byteLength(seen.body), declared,
      `the response body arrived truncated: ${Buffer.byteLength(seen.body)} of ${declared} bytes`);
  }

  /* ---- A. BODYLESS EARLY REFUSAL — keep-alive is KEPT --------------- */
  test("a bodyless unsupported request keeps keep-alive and the socket is reused", async () => {
    const seen = await withRawRequest(inboundHandler, {
      request: req("PUT /api/twilio-inbound HTTP/1.1"),
      afterResponse: SECOND,
    });

    assert.equal(seen.status, 405, "the bodyless unsupported request was not refused 405");
    assert.notEqual(String(seen.connection || "").toLowerCase(), "close",
      "a request with NOTHING outstanding was closed - the rule is over-blunt and every scanner probe loses keep-alive");
    assert.equal(seen.serverClosed, false, "the server closed a connection with nothing outstanding");
    assert.equal(seen.dispatched.length, 2,
      `the second request was not dispatched (${seen.dispatched.join(", ")}) - the connection was not actually reusable`);
    assert.equal(seen.responseCount, 2, "the second request got no response");
  });

  /* ---- B. PRE-BODY REFUSAL WITH A DECLARED BODY — closed ------------ */
  test("an early refusal with a declared, unconsumed body closes the connection", async () => {
    const seen = await withRawRequest(inboundHandler, {
      /* The SAME branch and the SAME status as A. Only the request's own
         state differs, which is the whole point of the pair. */
      request: req("PUT /api/twilio-inbound HTTP/1.1",
        ["Content-Type: application/x-www-form-urlencoded", "Content-Length: 400"],
        "MessageSid=SM1&Bo"),
      afterResponse: SECOND,
    });

    assert.equal(seen.status, 405, "the existing status changed");
    assert.equal(String(seen.connection || "").toLowerCase(), "close",
      "the refusal advertised a reusable connection while 383 declared bytes were still outstanding");
    assertWholeResponse(seen);
    assert.equal(seen.serverClosed, true, "the server did not close the connection it said it would close");
    assert.equal(seen.dispatched.length, 1,
      `something else was dispatched on a connection that was closed (${seen.dispatched.join(", ")})`);
    assert.equal(seen.responseCount, 1, "a second response was produced on a closed connection");
  });

  /* ---- C. THE STREAMING SIZE CHECK, chunked, never completed -------- */
  test("a chunked oversize body is refused 400 AND the connection is closed", async () => {
    /* CHUNKED AND NO CONTENT-LENGTH. That is the only framing that
       reaches readFormBody()'s running-byte check; a declared oversize
       length is refused at the header fast path instead. The terminating
       zero-length chunk is never sent, so the body is genuinely
       incomplete when the refusal is written. */
    const chunk = "1000" + CRLF + "x".repeat(4096) + CRLF;
    const seen = await withRawRequest(inboundHandler, {
      request: req("POST /api/twilio-inbound HTTP/1.1",
        ["Content-Type: application/x-www-form-urlencoded", "Transfer-Encoding: chunked"],
        chunk.repeat(5)),
      afterResponse: SECOND,
    });

    assert.equal(seen.status, 400, "the existing oversize response semantics changed");
    assert.equal(String(seen.connection || "").toLowerCase(), "close",
      "an oversize chunked body was refused on a connection still advertised as reusable");
    assertWholeResponse(seen);
    assert.equal(seen.serverClosed, true, "the server did not close after refusing an unfinished chunked body");
    assert.equal(seen.dispatched.length, 1,
      `something else was dispatched after the refusal (${seen.dispatched.join(", ")})`);
    assert.equal(seen.responseCount, 1, "a second response was produced after the refusal");
  });

  /* ---- D. A COMPLETE BODY — keep-alive is KEPT --------------------- */
  test("a complete POST refused 403 keeps keep-alive and the socket is reused", async () => {
    /* Complete, small, and refused for a reason that has nothing to do
       with the transport: no X-Twilio-Signature. Nothing is written,
       nothing is classified, and NOTHING is outstanding. */
    const body = "MessageSid=SM1&From=%2B14195550123&Body=STOP";
    const seen = await withRawRequest(inboundHandler, {
      request: req("POST /api/twilio-inbound HTTP/1.1",
        ["Content-Type: application/x-www-form-urlencoded",
         `Content-Length: ${Buffer.byteLength(body)}`],
        body),
      afterResponse: SECOND,
    });

    assert.equal(seen.status, 403, "the existing signature-refusal status changed");
    assert.notEqual(String(seen.connection || "").toLowerCase(), "close",
      "a fully received request lost keep-alive");
    assert.equal(seen.serverClosed, false, "the server closed a connection with nothing outstanding");
    assert.equal(seen.dispatched.length, 2,
      `the second request was not dispatched (${seen.dispatched.join(", ")})`);
    assert.equal(seen.responseCount, 2, "the second request got no response");
  });
});
