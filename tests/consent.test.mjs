/* Communications consent — SMS and automated/AI voice.
 *
 * Tier 4: this touches PII, consent, revocation and an external-integration
 * contract, so the tests aim at the invariants that would be expensive to
 * get wrong rather than at coverage.
 *
 * NOTHING here sends a message, places a call, or contacts HubSpot: the
 * resolver is pure, the evidence builder is pure, and the endpoint tests
 * run against a stubbed fetch and an injected mail transport. The feature
 * gate is exercised by BUILDING THE SITE TWICE into a throwaway copy of the
 * tree, so the real renderer is what gets asserted and the working public/
 * is never disturbed.
 */

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import handler from "../api/lead.js";
import {
  SMS_CONSENT, AI_VOICE_CONSENT, PERMISSION_STATE, FEATURE_FLAG,
  parseConsentFlag, buildConsentEvidence, applySubmissionConsent,
  consentFeatureEnabled, assertConsentCopyIntact, consentRows,
} from "../api/_lib/consent.mjs";
import {
  canSendSms, canPlaceAutomatedVoiceCall, applySuppression, REASON, SUPPRESSION_SCOPE,
} from "../api/_lib/permission.mjs";
import { validateLead } from "../api/_lib/validate.mjs";
import { buildDescription, buildSummary, CONSENT_LABELS } from "../api/_lib/description.mjs";
import { LEDGER_URL_VAR, _setExecutor, _resetExecutor } from "../api/_lib/consent-ledger.mjs";
import { DETAIL_MAX_BYTES } from "../api/_lib/hubspot.mjs";
import { setTransportFactory } from "../api/_lib/mail.mjs";
import { _resetRateLimit } from "../api/_lib/security.mjs";
import { mockReq, mockRes, validHomeValue, validContact } from "./helpers.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const { NEVER_GRANTED, GRANTED, REVOKED, SUPPRESSED } = PERMISSION_STATE;

const ON = { [FEATURE_FLAG]: "true" };
const OFF = {};

const PHONE = "(419) 555-1234";
const OTHER_PHONE = "(419) 555-9999";

/** A contact whose SMS and/or voice consent was granted for PHONE. */
function granted({ sms = false, voice = false, phone = PHONE } = {}) {
  const ch = () => ({
    status: GRANTED, consent_phone: phone, consent_at: "2026-09-09T00:00:00.000Z",
    consent_version: "v1",
  });
  return {
    sms: sms ? ch() : { status: NEVER_GRANTED },
    ai_voice: voice ? ch() : { status: NEVER_GRANTED },
    suppression: {},
  };
}

/* =====================================================================
   1-10  Validation and the trust boundary
   ===================================================================== */
describe("consent validation", () => {
  const lead = (over) => validateLead({ ...validHomeValue, ...over }).lead;

  test("neither box, SMS only, voice only, both", () => {
    assert.deepEqual(
      [lead({}).sms_consent, lead({}).ai_voice_consent], [false, false]);
    assert.deepEqual(
      [lead({ sms_consent: true }).sms_consent, lead({ sms_consent: true }).ai_voice_consent],
      [true, false], "SMS consent must not grant voice");
    assert.deepEqual(
      [lead({ ai_voice_consent: true }).sms_consent, lead({ ai_voice_consent: true }).ai_voice_consent],
      [false, true], "voice consent must not grant SMS");
    const both = lead({ sms_consent: true, ai_voice_consent: true });
    assert.deepEqual([both.sms_consent, both.ai_voice_consent], [true, true]);
  });

  /* The forged-payload case. The client reads input.checked, which is
     already a real boolean, so there is no honest reason for any of these
     to arrive - and every one of them is what a hand-rolled request trying
     to manufacture consent looks like. */
  test("no value other than a JSON boolean true can grant consent", () => {
    const hostile = [
      "yes", "on", "1", "true", "TRUE", "True", 1, -1, "checked",
      {}, { granted: true }, { valueOf: () => true }, [], [true], ["true"],
      "sms_consent", null, "null", 0.1, Infinity,
    ];
    for (const value of hostile) {
      const l = lead({ sms_consent: value, ai_voice_consent: value });
      assert.equal(l.sms_consent, false, `${JSON.stringify(value)} granted SMS consent`);
      assert.equal(l.ai_voice_consent, false, `${JSON.stringify(value)} granted voice consent`);
    }
    assert.equal(parseConsentFlag(true), true, "a real boolean true must still work");
  });

  test("missing consent fields mean false, not undefined", () => {
    const l = lead({});
    assert.equal(l.sms_consent, false);
    assert.equal(l.ai_voice_consent, false);
    assert.equal(typeof l.sms_consent, "boolean");
    assert.equal(typeof l.ai_voice_consent, "boolean");
  });

  /* Consent is not a condition of service, and the disclosure says so. A
     lead with neither box ticked is an ordinary, complete, valid lead. */
  test("consent is never required for a lead to be accepted", () => {
    for (const base of [validHomeValue, validContact]) {
      assert.doesNotThrow(() => validateLead(base));
      assert.doesNotThrow(() => validateLead({ ...base, sms_consent: false, ai_voice_consent: false }));
    }
  });

  test("consent cannot bypass any existing field requirement", () => {
    const bypass = { sms_consent: true, ai_voice_consent: true };
    for (const [field, code] of [
      ["phone", "MISSING_PHONE"], ["property_address", "MISSING_ADDRESS"],
      ["timeline", "MISSING_TIMELINE"], ["condition", "MISSING_CONDITION"],
      ["first_name", "MISSING_FIRST_NAME"], ["email", "MISSING_EMAIL"],
    ]) {
      assert.throws(
        () => validateLead({ ...validHomeValue, ...bypass, [field]: "" }),
        (e) => e.code === code, `consent bypassed the ${field} requirement`);
    }
  });

  test("the recognised form types are unchanged", () => {
    for (const t of ["home_value", "contact"])
      assert.doesNotThrow(() => validateLead({ ...validHomeValue, form_type: t, message: "hi", topic: "Selling my home" }));
    assert.throws(() => validateLead({ ...validHomeValue, form_type: "sms_optin" }),
      (e) => e.code === "UNKNOWN_FORM_TYPE");
  });

  /* The whole trust boundary in one test: the client says only "ticked",
     and the server supplies every fact that gives it meaning. */
  test("version, exact text and timestamp are server-owned and unforgeable", () => {
    const payload = validateLead({
      ...validHomeValue,
      sms_consent: true,
      /* All of this is a lie the client is trying to tell. */
      consent: { sms: { version: "ATTACKER_V9", exact_text: "I agree to anything" } },
      sms_consent_version: "ATTACKER_V9",
      sms_consent_text: "I agree to anything",
      sms_consent_at: "1999-01-01T00:00:00.000Z",
      consent_captured_at: "1999-01-01T00:00:00.000Z",
    });
    payload.meta.submission_id = "csv_test000000000000000000";
    const ev = buildConsentEvidence(payload);

    assert.equal(ev.sms.version, SMS_CONSENT.version);
    assert.equal(ev.sms.exact_text, SMS_CONSENT.text);
    assert.equal(ev.ai_voice.version, AI_VOICE_CONSENT.version);
    assert.equal(ev.ai_voice.exact_text, AI_VOICE_CONSENT.text);
    assert.equal(ev.sms.captured_at, payload.meta.submitted_at);
    assert.equal(ev.submission_id, "csv_test000000000000000000");

    const flat = JSON.stringify(ev);
    assert.ok(!flat.includes("ATTACKER_V9"), "a client-supplied version reached the evidence");
    assert.ok(!flat.includes("I agree to anything"), "a client-supplied disclosure reached the evidence");
    assert.ok(!flat.includes("1999-01-01"), "a client-supplied timestamp reached the evidence");
  });

  /* The privacy notice says IPs are held in memory for rate limiting and
     are not added to contact records. Adding consent is not a licence to
     start collecting more PII than the notice describes. */
  test("consent evidence stores no IP address", () => {
    const payload = validateLead({ ...validHomeValue, sms_consent: true });
    payload.meta.submission_id = "csv_test000000000000000000";
    const flat = JSON.stringify(buildConsentEvidence(payload));
    for (const ip of ["203.0.113", "198.51.100", "127.0.0.1", "x-forwarded-for"])
      assert.ok(!flat.includes(ip), `the evidence carries ${ip}`);
    assert.ok(!/"ip"/.test(flat));
  });

  test("a declined disclosure is still recorded, with no phone and no time", () => {
    const payload = validateLead({ ...validHomeValue, sms_consent: true });
    payload.meta.submission_id = "csv_test000000000000000000";
    const ev = buildConsentEvidence(payload);
    assert.equal(ev.ai_voice.granted, false);
    /* Which disclosure they declined is the point - "declined" is
       meaningless without knowing what was on the screen. */
    assert.equal(ev.ai_voice.exact_text, AI_VOICE_CONSENT.text);
    assert.equal(ev.ai_voice.phone, "");
    assert.equal(ev.ai_voice.captured_at, "");
    assert.equal(ev.sms.phone, "(419) 555-0000");
  });
});

/* =====================================================================
   11-12  Consent binds to the number it was given for
   ===================================================================== */
describe("consent binds to a phone number", () => {
  test("evidence records the normalised submitted number", () => {
    const payload = validateLead({ ...validHomeValue, phone: "419.555.1234", sms_consent: true });
    payload.meta.submission_id = "csv_test000000000000000000";
    const ev = buildConsentEvidence(payload);
    assert.equal(ev.sms.phone, PHONE, "consent must bind to the normalised number");
  });

  /* A number changes hands. The person who agreed is not the person now
     holding the line, and the old permission does not travel. */
  test("a changed phone number does not inherit the old permission", () => {
    const state = granted({ sms: true, voice: true, phone: PHONE });
    assert.equal(canSendSms(state, PHONE, { env: ON }).allowed, true);
    assert.deepEqual(canSendSms(state, OTHER_PHONE, { env: ON }),
      { allowed: false, reason: REASON.CONSENT_PHONE_MISMATCH });
    assert.deepEqual(canPlaceAutomatedVoiceCall(state, OTHER_PHONE, { env: ON }),
      { allowed: false, reason: REASON.CONSENT_PHONE_MISMATCH });
  });

  test("formatting differences are not a mismatch", () => {
    const state = granted({ sms: true, phone: "(419) 555-1234" });
    for (const same of ["4195551234", "419-555-1234", "(419) 555-1234", "1 419 555 1234"])
      assert.equal(canSendSms(state, same, { env: ON }).allowed, true, same + " should match");
  });

  test("an undialable number is refused before anything else about it", () => {
    const state = granted({ sms: true, phone: PHONE });
    assert.equal(canSendSms(state, "419", { env: ON }).reason, REASON.INVALID_PHONE);
  });
});

/* =====================================================================
   13-15  Repeat submissions must never rewrite history
   ===================================================================== */
describe("a later submission cannot undo an earlier decision", () => {
  /* Pinned to PHONE, the number granted() records consent against -
     otherwise every assertion here would be measuring a phone mismatch
     instead of the suppression rule it is aimed at. */
  const evidenceFor = (over) => {
    const p = validateLead({ ...validHomeValue, phone: PHONE, ...over });
    p.meta.submission_id = "csv_test000000000000000000";
    return buildConsentEvidence(p);
  };

  /* Not re-ticking is not withdrawing. Someone who opted in last month and
     simply did not tick again this month has revoked nothing. */
  test("an unticked box on a later submission does not revoke anything", () => {
    const before = granted({ sms: true, voice: true });
    const after = applySubmissionConsent(before, evidenceFor({}));
    assert.equal(after.sms.status, GRANTED);
    assert.equal(after.ai_voice.status, GRANTED);
    assert.equal(after.sms.consent_phone, PHONE, "the original consent record was disturbed");
    assert.equal(canSendSms(after, PHONE, { env: ON }).allowed, true);
  });

  test("an unticked box does not fabricate consent either", () => {
    const after = applySubmissionConsent({}, evidenceFor({}));
    assert.equal(after.sms.status, NEVER_GRANTED);
    assert.equal(after.ai_voice.status, NEVER_GRANTED);
    assert.equal(canSendSms(after, PHONE, { env: ON }).reason, REASON.NO_CONSENT);
  });

  /* The scenario from the brief: opt in, reply STOP, submit another form
     thirty days later. The form must not resurrect the channel. */
  test("a ticked box cannot silently clear an existing STOP", () => {
    let state = granted({ sms: true });
    state = applySuppression(state, {
      scope: SUPPRESSION_SCOPE.SMS, reason: "stop_keyword", at: "2026-09-02T00:00:00.000Z",
    });
    assert.equal(canSendSms(state, PHONE, { env: ON }).reason, REASON.SMS_SUPPRESSED_STOP);

    const after = applySubmissionConsent(state, evidenceFor({ sms_consent: true }));
    assert.deepEqual(canSendSms(after, PHONE, { env: ON }),
      { allowed: false, reason: REASON.SMS_SUPPRESSED_STOP },
      "a re-ticked box resurrected a stopped number");
    assert.ok(after.suppression.sms, "the suppression record was removed");
    /* The request is not thrown away - it is recorded for a deliberate
       re-opt-in workflow to act on, beside the suppression rather than on
       top of it. */
    assert.equal(after.sms.outcome, "pending_reoptin");
    assert.equal(after.sms.pending_reoptin.phone, PHONE);
  });

  test("a ticked box cannot silently clear a voice DNC", () => {
    let state = granted({ voice: true });
    state = applySuppression(state, {
      scope: SUPPRESSION_SCOPE.VOICE, reason: "voice_dnc", at: "2026-09-02T00:00:00.000Z",
    });
    const after = applySubmissionConsent(state, evidenceFor({ ai_voice_consent: true }));
    assert.deepEqual(canPlaceAutomatedVoiceCall(after, PHONE, { env: ON }),
      { allowed: false, reason: REASON.VOICE_DNC });
    assert.equal(after.ai_voice.outcome, "pending_reoptin");
  });

  test("a ticked box cannot clear a global do-not-contact", () => {
    let state = granted({ sms: true, voice: true });
    state = applySuppression(state, {
      scope: SUPPRESSION_SCOPE.GLOBAL, reason: "global_dnc", at: "2026-09-02T00:00:00.000Z",
    });
    const after = applySubmissionConsent(state,
      evidenceFor({ sms_consent: true, ai_voice_consent: true }));
    assert.equal(canSendSms(after, PHONE, { env: ON }).reason, REASON.GLOBAL_DNC);
    assert.equal(canPlaceAutomatedVoiceCall(after, PHONE, { env: ON }).reason, REASON.GLOBAL_DNC);
  });

  test("a first ticked box on a clean contact does grant permission", () => {
    const after = applySubmissionConsent({}, evidenceFor({ sms_consent: true }));
    assert.equal(after.sms.status, GRANTED);
    assert.equal(after.sms.consent_version, SMS_CONSENT.version);
    assert.equal(canSendSms(after, PHONE, { env: ON }).allowed, true);
    assert.equal(canPlaceAutomatedVoiceCall(after, PHONE, { env: ON }).reason, REASON.NO_CONSENT);
  });
});

/* =====================================================================
   16-23  The permission resolver
   ===================================================================== */
describe("permission resolver", () => {
  test("SMS: consent and no suppression is allowed", () => {
    assert.deepEqual(canSendSms(granted({ sms: true }), PHONE, { env: ON }),
      { allowed: true, reason: REASON.ALLOWED });
  });

  test("SMS: no consent is blocked", () => {
    assert.equal(canSendSms(granted({}), PHONE, { env: ON }).reason, REASON.NO_CONSENT);
    assert.equal(canSendSms({}, PHONE, { env: ON }).reason, REASON.NO_CONSENT);
    assert.equal(canSendSms(null, PHONE, { env: ON }).reason, REASON.NO_CONSENT);
  });

  test("voice: consent and no DNC is allowed; no consent is blocked", () => {
    assert.equal(canPlaceAutomatedVoiceCall(granted({ voice: true }), PHONE, { env: ON }).allowed, true);
    assert.equal(canPlaceAutomatedVoiceCall(granted({}), PHONE, { env: ON }).reason, REASON.NO_CONSENT);
  });

  /* The channels are independent in both directions. This is the test
     that stops "they said yes to texts" ever becoming "so we may call
     them with a robot". */
  test("the two channels never imply each other", () => {
    const smsOnly = granted({ sms: true });
    assert.equal(canSendSms(smsOnly, PHONE, { env: ON }).allowed, true);
    assert.equal(canPlaceAutomatedVoiceCall(smsOnly, PHONE, { env: ON }).allowed, false);

    const voiceOnly = granted({ voice: true });
    assert.equal(canSendSms(voiceOnly, PHONE, { env: ON }).allowed, false);
    assert.equal(canPlaceAutomatedVoiceCall(voiceOnly, PHONE, { env: ON }).allowed, true);
  });

  test("an SMS STOP does not create a voice DNC", () => {
    const state = applySuppression(granted({ sms: true, voice: true }),
      { scope: SUPPRESSION_SCOPE.SMS, reason: "stop_keyword", at: "2026-09-02T00:00:00.000Z" });
    assert.equal(canSendSms(state, PHONE, { env: ON }).reason, REASON.SMS_SUPPRESSED_STOP);
    assert.equal(canPlaceAutomatedVoiceCall(state, PHONE, { env: ON }).allowed, true,
      "an SMS opt-out silently stopped calls the consumer did not object to");
  });

  test("a voice DNC does not create an SMS STOP", () => {
    const state = applySuppression(granted({ sms: true, voice: true }),
      { scope: SUPPRESSION_SCOPE.VOICE, reason: "voice_dnc", at: "2026-09-02T00:00:00.000Z" });
    assert.equal(canPlaceAutomatedVoiceCall(state, PHONE, { env: ON }).reason, REASON.VOICE_DNC);
    assert.equal(canSendSms(state, PHONE, { env: ON }).allowed, true);
  });

  test("a global do-not-contact blocks both", () => {
    const state = applySuppression(granted({ sms: true, voice: true }),
      { scope: SUPPRESSION_SCOPE.GLOBAL, reason: "global_dnc", at: "2026-09-02T00:00:00.000Z" });
    assert.equal(canSendSms(state, PHONE, { env: ON }).reason, REASON.GLOBAL_DNC);
    assert.equal(canPlaceAutomatedVoiceCall(state, PHONE, { env: ON }).reason, REASON.GLOBAL_DNC);
  });

  /* Precedence. A contact whose status still reads `granted` because a
     form arrived after the STOP must still be refused: the resolver
     answers to the consumer, not to the most recent form. */
  test("suppression outranks a granted consent record", () => {
    const state = {
      ...granted({ sms: true }),
      suppression: { sms: { reason: "stop_keyword", at: "2026-09-02T00:00:00.000Z" } },
    };
    assert.equal(state.sms.status, GRANTED, "precondition: the record still says granted");
    assert.equal(canSendSms(state, PHONE, { env: ON }).reason, REASON.SMS_SUPPRESSED_STOP);
  });

  test("a revoked status reads differently from never having been asked", () => {
    const state = { sms: { status: REVOKED, consent_phone: PHONE }, suppression: {} };
    assert.equal(canSendSms(state, PHONE, { env: ON }).reason, REASON.CONSENT_REVOKED);
    assert.equal(canSendSms({ sms: { status: NEVER_GRANTED } }, PHONE, { env: ON }).reason,
      REASON.NO_CONSENT);
  });

  test("a suppressed status blocks on its own channel's reason", () => {
    assert.equal(canSendSms({ sms: { status: SUPPRESSED } }, PHONE, { env: ON }).reason,
      REASON.SMS_SUPPRESSED_STOP);
    assert.equal(canPlaceAutomatedVoiceCall({ ai_voice: { status: SUPPRESSED } }, PHONE, { env: ON }).reason,
      REASON.VOICE_DNC);
  });

  /* The gate is the outermost check: while the feature is off, nothing is
     permitted regardless of what any record says. */
  test("the feature gate blocks everything when off", () => {
    const state = granted({ sms: true, voice: true });
    assert.deepEqual(canSendSms(state, PHONE, { env: OFF }),
      { allowed: false, reason: REASON.FEATURE_DISABLED });
    assert.deepEqual(canPlaceAutomatedVoiceCall(state, PHONE, { env: OFF }),
      { allowed: false, reason: REASON.FEATURE_DISABLED });
  });

  test("suppression is additive and never removes a record", () => {
    let s = granted({ sms: true, voice: true });
    s = applySuppression(s, { scope: SUPPRESSION_SCOPE.SMS, reason: "stop_keyword", at: "t1" });
    s = applySuppression(s, { scope: SUPPRESSION_SCOPE.VOICE, reason: "voice_dnc", at: "t2" });
    assert.equal(s.suppression.sms.at, "t1", "the first suppression was overwritten");
    assert.equal(s.suppression.voice.at, "t2");
    assert.throws(() => applySuppression(s, { scope: "everything", reason: "x", at: "t3" }));
  });
});

/* =====================================================================
   24-26  Failure semantics — a lead is never lost, and never faked
   ===================================================================== */
describe("failure isolation with consent enabled", () => {
  const realFetch = globalThis.fetch;
  const saved = {};
  const KEYS = [FEATURE_FLAG, "HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PORTAL_ID", "HUBSPOT_FORM_GUID",
                "ZOHO_SMTP_HOST", "ZOHO_SMTP_PORT", "ZOHO_SMTP_USER", "ZOHO_SMTP_PASSWORD"];
  const PORTAL = "247240486";
  const GUID = "536a356d-d854-49ec-b204-b76e591cecaa";
  const FORM = "POST /submissions/v3/integration/secure/submit/" + PORTAL + "/" + GUID;

  const httpRes = ({ status = 200, json = null }) => ({
    ok: status >= 200 && status < 300, status, async text() { return json === null ? "" : JSON.stringify(json); },
  });

  function stubHubspot({ formStatus = 200 } = {}) {
    const bodies = [];
    globalThis.fetch = async (url, options = {}) => {
      const u = new URL(String(url));
      const key = (options.method || "GET") + " " + u.pathname;
      if (options.body) bodies.push({ key, body: JSON.parse(options.body) });
      if (key.endsWith("/contacts/search")) return httpRes({ json: { total: 0, results: [] } });
      if (key === "POST /crm/v3/objects/contacts") return httpRes({ json: { id: "1" } });
      if (key === FORM) {
        return formStatus === 200 ? httpRes({ json: { inlineMessage: "ok" } })
                                  : httpRes({ status: formStatus, json: { message: "no" } });
      }
      throw new Error("unstubbed " + key);
    };
    return bodies;
  }

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env[FEATURE_FLAG] = "true";
    process.env.HUBSPOT_ACCESS_TOKEN = "pat-na1-TEST";
    process.env.HUBSPOT_PORTAL_ID = PORTAL;
    process.env.HUBSPOT_FORM_GUID = GUID;
    _resetRateLimit();
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    globalThis.fetch = realFetch;
    setTransportFactory();
  });

  const post = async (body) => {
    _resetRateLimit();
    const res = mockRes();
    await handler(mockReq({ body }), res);
    return res;
  };

  /* Consent evidence is CRITICAL, not a courtesy: it rides inside the same
     HubSpot form submission that stores the lead. There is no path where
     the contact is saved and the consent is quietly lost. */
  test("consent evidence travels in the same write as the lead", async () => {
    const bodies = stubHubspot();
    setTransportFactory(async () => ({ async sendMail() { return {}; } }));
    const res = await post({ ...validHomeValue, sms_consent: true });
    assert.equal(res.statusCode, 200);

    const form = bodies.find((b) => b.key === FORM);
    const block = form.body.fields.find((f) => f.name === "message").value;
    assert.match(block, /SMS CONSENT: GRANTED/);
    assert.match(block, new RegExp("SMS CONSENT VERSION: " + SMS_CONSENT.version));
    assert.match(block, /AI VOICE CONSENT: NOT GRANTED/);
    assert.match(block, /SMS CONSENT PHONE: \(419\) 555-0000/);

    /* The disclosure itself, in the record that reaches HubSpot. A version
       identifier alone only answers "what did they agree to" for someone
       holding the right revision of the source; the text answers it on its
       own, years later, from the CRM. */
    assert.ok(block.includes("SMS CONSENT TEXT: " + SMS_CONSENT.text),
      "the exact SMS disclosure did not reach HubSpot");
    assert.ok(block.includes("AI VOICE CONSENT TEXT: " + AI_VOICE_CONSENT.text),
      "the exact AI voice disclosure did not reach HubSpot");
  });

  /* A declined disclosure keeps its text too. "They said no" is only
     meaningful alongside what they were saying no to. */
  test("a declined disclosure still records its exact wording", async () => {
    const bodies = stubHubspot();
    setTransportFactory(async () => ({ async sendMail() { return {}; } }));
    await post({ ...validHomeValue });
    const block = bodies.find((b) => b.key === FORM).body.fields.find((f) => f.name === "message").value;
    assert.match(block, /SMS CONSENT: NOT GRANTED/);
    assert.ok(block.includes("SMS CONSENT TEXT: " + SMS_CONSENT.text));
    assert.match(block, /SMS CONSENT AT: -/);
    assert.match(block, /SMS CONSENT PHONE: -/);
  });

  /* The exact text is taken from the canonical module, never echoed back
     out of the request. */
  test("a browser-supplied disclosure cannot replace the canonical text in HubSpot", async () => {
    const bodies = stubHubspot();
    setTransportFactory(async () => ({ async sendMail() { return {}; } }));
    await post({
      ...validHomeValue,
      sms_consent: true,
      ai_voice_consent: true,
      sms_consent_text: "I agree to unlimited marketing from anyone",
      ai_voice_consent_text: "I agree to unlimited marketing from anyone",
      consent: { sms: { exact_text: "I agree to unlimited marketing from anyone" } },
    });
    const block = bodies.find((b) => b.key === FORM).body.fields.find((f) => f.name === "message").value;
    assert.ok(!block.includes("unlimited marketing"),
      "a client-supplied disclosure was written to the CRM as the agreed wording");
    assert.ok(block.includes("SMS CONSENT TEXT: " + SMS_CONSENT.text));
    assert.ok(block.includes("AI VOICE CONSENT TEXT: " + AI_VOICE_CONSENT.text));
  });

  test("a HubSpot failure still fails the submission, consent or not", async () => {
    stubHubspot({ formStatus: 500 });
    setTransportFactory(async () => ({ async sendMail() { return {}; } }));
    const res = await post({ ...validHomeValue, sms_consent: true });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().code, "DELIVERY_FAILED");
  });

  test("an acknowledgement-email failure after HubSpot success does not fail the lead", async () => {
    stubHubspot();
    process.env.ZOHO_SMTP_HOST = "smtppro.zoho.com";
    process.env.ZOHO_SMTP_PORT = "465";
    process.env.ZOHO_SMTP_USER = "crystal@crystalsellstoledo.com";
    process.env.ZOHO_SMTP_PASSWORD = "pw";
    setTransportFactory(async () => ({
      async sendMail() { throw Object.assign(new Error("nope"), { code: "EAUTH" }); },
    }));
    const res = await post({ ...validHomeValue, sms_consent: true, ai_voice_consent: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  });

  /* The public contract does not move. No consent status, no permission
     decision, nothing about messaging reaches the browser. */
  test("the success response carries no consent or messaging status", async () => {
    stubHubspot();
    setTransportFactory(async () => ({ async sendMail() { return {}; } }));
    const res = await post({ ...validHomeValue, sms_consent: true, ai_voice_consent: true });
    assert.deepEqual(Object.keys(res.json()).sort(), ["ok", "submission_id"]);
    for (const leak of ["consent", "sms", "voice", "twilio", "retell"])
      assert.ok(!res.body.toLowerCase().includes(leak), `the response leaked "${leak}"`);
  });

  test("with the feature off, no consent rows are written at all", async () => {
    process.env[FEATURE_FLAG] = "false";
    const bodies = stubHubspot();
    setTransportFactory(async () => ({ async sendMail() { return {}; } }));
    const res = await post({ ...validHomeValue, sms_consent: true });
    assert.equal(res.statusCode, 200);
    const block = bodies.find((b) => b.key === FORM).body.fields.find((f) => f.name === "message").value;
    assert.ok(!block.includes("SMS CONSENT"),
      "consent was recorded while the feature was off - the UI that collects it is not even rendered");
  });

  test("no consent PII reaches the logs", async () => {
    stubHubspot();
    setTransportFactory(async () => ({ async sendMail() { return {}; } }));
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try {
      await post({ ...validHomeValue, sms_consent: true });
    } finally { console.log = realLog; }
    const logged = lines.join("\n");
    assert.match(logged, /lead\.consent\.captured/);
    assert.match(logged, /"sms_consent":true/);
    for (const pii of ["sam@example.com", "555-0000", "Louisiana", "Rivera",
                       "I agree to receive text messages"])
      assert.ok(!logged.includes(pii), `a log line leaked "${pii}"`);
  });
});

/* =====================================================================
   27-39  Rendered UX, legal routes and the feature gate
   ---------------------------------------------------------------------
   Built twice, for real, in a throwaway copy of the tree. Asserting the
   actual renderer's output is the only way to prove the gate; asserting
   the source templates would prove nothing about what ships.
   ===================================================================== */
describe("rendered output and the feature gate", () => {
  let dir, OFF_DIR, ON_DIR;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cst-consent-"));
    for (const mode of ["off", "on"]) {
      const root = join(dir, mode);
      /* Everything tools/build.mjs reads or copies. robots.txt and
         site.webmanifest are copied into the output, so their absence is a
         build failure rather than a missing page. */
      for (const item of ["src", "assets", "tools", "api", "package.json",
                          "robots.txt", "site.webmanifest"])
        cpSync(join(REPO, item), join(root, item), { recursive: true });
      execFileSync(process.execPath, ["tools/build.mjs"], {
        cwd: root,
        env: { ...process.env, [FEATURE_FLAG]: mode === "on" ? "true" : "false" },
        stdio: "pipe",
      });
    }
    OFF_DIR = join(dir, "off", "public");
    ON_DIR = join(dir, "on", "public");
  });
  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const page = (root, name) => readFileSync(join(root, name), "utf8");
  const FORM_PAGES = ["index.html", "home-value.html", "43551-seller-review.html", "contact.html"];
  const boxOf = (html, name) =>
    new RegExp('<input\\b[^>]*\\bname="' + name + '"[^>]*>', "s").exec(html)?.[0] || null;

  /* ---- disabled mode: production as it is today ---------------------- */
  test("disabled: no consent control renders on any form page", () => {
    for (const f of FORM_PAGES) {
      const html = page(OFF_DIR, f);
      assert.equal(boxOf(html, "sms_consent"), null, `${f} rendered an SMS consent box`);
      assert.equal(boxOf(html, "ai_voice_consent"), null, `${f} rendered a voice consent box`);
      assert.ok(!html.includes(SMS_CONSENT.version));
    }
  });

  test("disabled: no consent promise is displayed that is not being persisted", () => {
    for (const f of FORM_PAGES) {
      const html = page(OFF_DIR, f);
      for (const phrase of ["Reply STOP", "AI-generated voice", "text messages from Crystal"])
        assert.ok(!html.includes(phrase), `${f} promises "${phrase}" while the feature is off`);
    }
  });

  test("disabled: /communications-terms is not built and not in the sitemap", () => {
    assert.equal(existsSync(join(OFF_DIR, "communications-terms.html")), false);
    const sitemap = page(OFF_DIR, "sitemap.xml");
    assert.ok(!sitemap.includes("communications-terms"));
    assert.equal((sitemap.match(/<loc>/g) || []).length, 9, "the sitemap changed while the feature is off");
  });

  test("disabled: the privacy page names no messaging provider", () => {
    const text = page(OFF_DIR, "privacy.html").replace(/<!--[\s\S]*?-->/g, "");
    for (const provider of ["Twilio", "Retell"])
      assert.ok(!text.includes(provider),
        `privacy.html names ${provider} before any message is sent`);
  });

  /* ---- enabled mode ------------------------------------------------- */
  test("enabled: exactly one of each control, on every form page", () => {
    for (const f of FORM_PAGES) {
      const html = page(ON_DIR, f);
      for (const name of ["sms_consent", "ai_voice_consent"])
        assert.equal((html.match(new RegExp('name="' + name + '"', "g")) || []).length, 1,
          `${f} does not render exactly one ${name}`);
    }
  });

  test("enabled: both boxes are unchecked and optional", () => {
    for (const f of FORM_PAGES) {
      for (const name of ["sms_consent", "ai_voice_consent"]) {
        const tag = boxOf(page(ON_DIR, f), name);
        assert.ok(tag, `${f} is missing ${name}`);
        assert.ok(!/\bchecked\b/.test(tag), `${f}: ${name} is pre-checked`);
        assert.ok(!/\brequired\b/.test(tag), `${f}: ${name} is required`);
        assert.match(tag, /type="checkbox"/);
      }
    }
  });

  test("enabled: the displayed disclosure is the canonical text, character for character", () => {
    for (const f of FORM_PAGES) {
      const flat = page(ON_DIR, f).replace(/\s+/g, " ");
      for (const d of [SMS_CONSENT, AI_VOICE_CONSENT])
        assert.ok(flat.includes(d.html.replace(/\s+/g, " ")),
          `${f} shows different words from the ones recorded for ${d.version}`);
    }
  });

  /* A screen reader announces the label, not a nearby paragraph. Without
     a matching for/id the disclosure is not attached to the control at
     all, and the box is a smaller tap target than it looks. */
  test("enabled: each box is labelled, focusable and pointer-friendly", () => {
    const html = page(ON_DIR, "contact.html");
    for (const [name, id] of [["sms_consent", "consent-sms"], ["ai_voice_consent", "consent-voice"]]) {
      const tag = boxOf(html, name);
      assert.match(tag, new RegExp('id="' + id + '"'));
      assert.match(html, new RegExp('<label[^>]*for="' + id + '"'), `${name} has no <label for>`);
      /* A native checkbox: in the tab order, operable with Space, and
         never given a tabindex that removes it. */
      assert.ok(!/tabindex="-1"/.test(tag), `${name} is removed from the tab order`);
      assert.ok(!/\bdisabled\b/.test(tag));
      assert.ok(!/display:\s*none|hidden/.test(tag), `${name} is hidden`);
    }
    assert.match(html, /<fieldset class="consent">/);
    assert.match(html, /<legend/);
  });

  test("enabled: the disclosure links resolve to pages that exist", () => {
    const html = page(ON_DIR, "contact.html");
    for (const href of ["/privacy", "/communications-terms"])
      assert.ok(html.includes(`href="${href}"`), `no ${href} link`);
    /* Opened in a new tab so a part-filled form is not discarded. */
    assert.match(html, /href="\/communications-terms" target="_blank" rel="noopener"/);
    assert.ok(existsSync(join(ON_DIR, "privacy.html")));
    assert.ok(existsSync(join(ON_DIR, "communications-terms.html")));
  });

  test("enabled: /communications-terms carries the required disclosures", () => {
    const terms = page(ON_DIR, "communications-terms.html");
    for (const required of [
      "Crystal Saylor", "Key Realty LTD", "Message frequency varies",
      "Message and data rates may apply", "STOP", "HELP",
      "not a condition of service", "(419)&nbsp;245-4655",
      "crystal@crystalsellstoledo.com", "href=\"/privacy\"",
    ]) assert.ok(terms.includes(required), `communications-terms is missing "${required}"`);
    /* Nothing may imply recording while recording is not enabled. */
    assert.match(terms, /not<\/strong> recorded or transcribed/);
  });

  test("enabled: the privacy page discloses the messaging runtime", () => {
    const privacy = page(ON_DIR, "privacy.html");
    /* Collapsed: the source wraps these sentences across lines. */
    const flat = privacy.replace(/\s+/g, " ");
    for (const required of [
      "Twilio", "Retell AI",
      "Mobile information will not be shared with third parties or affiliates",
      "opt-in data and consent will not be shared with third parties",
      "not</strong> stored",
    ]) assert.ok(flat.includes(required), `privacy.html is missing "${required}"`);
    /* Recording is not enabled, and the page must not imply it is. */
    assert.ok(flat.includes("Calls are not recorded or transcribed."),
      "privacy.html does not state that calls are not recorded");
    assert.ok(!/\bcall recordings?\b|\btranscripts are\b/i.test(flat),
      "privacy.html implies calls are recorded, which nothing enables");
  });

  test("enabled: the terms page is reachable from the footer", () => {
    for (const f of ["index.html", "privacy.html"])
      assert.match(page(ON_DIR, f), /href="\/communications-terms"/,
        `${f} footer has no communications-terms link`);
    /* The existing privacy link is untouched in both modes. */
    for (const root of [OFF_DIR, ON_DIR])
      assert.match(page(root, "index.html"), /href="\/privacy">Privacy &amp; terms<\/a>/);
  });

  test("the licensed name never appears in an h1 or h2 on the new page", () => {
    const terms = page(ON_DIR, "communications-terms.html");
    for (const m of terms.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/g))
      assert.ok(!/Crystal Saylor|Key Realty/.test(m[1]),
        "the licensed name appears in a heading: " + m[1].trim());
  });
});

/* =====================================================================
   Copy integrity
   ===================================================================== */
describe("consent copy cannot drift", () => {
  test("stripping the markup from what is shown reproduces what is stored", () => {
    assert.equal(assertConsentCopyIntact(), true);
    for (const d of [SMS_CONSENT, AI_VOICE_CONSENT])
      assert.equal(d.html.replace(/<[^>]+>/g, ""), d.text);
  });

  test("the versions are distinct and namespaced", () => {
    assert.notEqual(SMS_CONSENT.version, AI_VOICE_CONSENT.version);
    assert.match(SMS_CONSENT.version, /^CST_SMS_CONSENT_/);
    assert.match(AI_VOICE_CONSENT.version, /^CST_AI_VOICE_CONSENT_/);
  });

  test("each disclosure carries what its channel legally needs", () => {
    assert.match(SMS_CONSENT.text, /Message frequency varies\./);
    assert.match(SMS_CONSENT.text, /Message and data rates may apply\./);
    assert.match(SMS_CONSENT.text, /Reply STOP to opt out or HELP for help\./);
    assert.match(AI_VOICE_CONSENT.text, /artificial, prerecorded, or AI-generated voice/);
    for (const d of [SMS_CONSENT, AI_VOICE_CONSENT])
      assert.match(d.text, /Consent is not a condition of service\./);
    /* Neither disclosure may quietly become a marketing permission. */
    for (const d of [SMS_CONSENT, AI_VOICE_CONSENT])
      for (const broad of ["marketing", "promotional", "offers", "newsletter", "partners"])
        assert.ok(!d.text.toLowerCase().includes(broad),
          `${d.version} has widened into ${broad} permission`);
  });

  test("the feature flag is off unless it is exactly \"true\"", () => {
    for (const v of [undefined, "", "false", "1", "yes", "TRUE", "True", " true"])
      assert.equal(consentFeatureEnabled({ [FEATURE_FLAG]: v }), false, `"${v}" enabled the feature`);
    assert.equal(consentFeatureEnabled({ [FEATURE_FLAG]: "true" }), true);
  });

  test("the evidence carries both the version and the exact wording", () => {
    const payload = validateLead({ ...validHomeValue, sms_consent: true });
    payload.meta.submission_id = "csv_test000000000000000000";
    const rows = Object.fromEntries(consentRows(buildConsentEvidence(payload)));
    assert.equal(rows["SMS CONSENT VERSION"], SMS_CONSENT.version);
    assert.equal(Object.keys(rows)[0], "CONSENT LEDGER",
      "the durability caveat is not the first row an operator reads");
    assert.equal(rows["SMS CONSENT TEXT"], SMS_CONSENT.text);
    assert.equal(rows["AI VOICE CONSENT VERSION"], AI_VOICE_CONSENT.version);
    assert.equal(rows["AI VOICE CONSENT TEXT"], AI_VOICE_CONSENT.text);
    /* The labels list and the rows must stay in step - the labels are what
       the setup document and the verification procedure describe. */
    assert.deepEqual(Object.keys(rows), CONSENT_LABELS);
  });

  /* A disclosure is a paragraph, and the enquiry block is capped before it
     is sent. If a future rewording ever pushed the block over the cap the
     visitor's own words would be truncated to make room for boilerplate,
     which is the wrong trade. Checked against the largest lead the
     validator will accept. */
  test("the consent rows leave ample room inside the CRM byte cap", () => {
    const payload = validateLead({
      ...validHomeValue,
      notes: "n".repeat(4000),
      property_address: "a".repeat(200),
      sms_consent: true, ai_voice_consent: true,
    });
    payload.meta.submission_id = "csv_test000000000000000000";
    payload.consent = buildConsentEvidence(payload);
    const bytes = Buffer.byteLength(buildDescription(payload), "utf8");
    assert.ok(bytes < DETAIL_MAX_BYTES,
      `the largest possible block is ${bytes} bytes, over the ${DETAIL_MAX_BYTES} cap`);
    assert.ok(bytes < DETAIL_MAX_BYTES / 2,
      `only ${DETAIL_MAX_BYTES - bytes} bytes of headroom left - too tight for comfort`);
  });

  test("the enquiry block gains consent rows only when evidence exists", () => {
    const payload = validateLead({ ...validHomeValue, sms_consent: true });
    payload.meta.submission_id = "csv_test000000000000000000";
    const without = buildDescription(payload).split("\n");
    payload.consent = buildConsentEvidence(payload);
    const withRows = buildDescription(payload).split("\n");
    assert.equal(withRows.length - without.length, consentRows(payload.consent).length);
    assert.ok(!without.some((l) => l.startsWith("SMS CONSENT")));
    assert.ok(withRows.some((l) => l === "SMS CONSENT: GRANTED"));
    /* Eleven rows since the ledger phase, and the block gains exactly one
       line versus the pre-ledger row set. */
    assert.equal(consentRows(payload.consent).length, 11);
    assert.ok(!without.some((l) => l.startsWith("CONSENT LEDGER")));
  });

  /* =====================================================================
     THE CONSENT LEDGER ROW
     ---------------------------------------------------------------------
     The row exists to explain a discrepancy an operator would otherwise
     meet with no explanation: an activity saying SMS CONSENT: GRANTED
     beside a contact whose permission property correctly says
     never_granted, because the durable evidence never landed.
     ===================================================================== */
  describe("the CONSENT LEDGER row", () => {
    const blockFor = (durable) => {
      const payload = validateLead({ ...validHomeValue, sms_consent: true });
      payload.meta.submission_id = "csv_test000000000000000000";
      payload.consent = buildConsentEvidence(payload);
      if (durable === "absent") delete payload.consent.durable;
      else payload.consent.durable = durable;
      return buildDescription(payload).split("\n");
    };

    test("a confirmed append renders RECORDED", () => {
      /* Whole lines, not substrings: "NOT CONFIRMED" contains "RECORDED". */
      assert.ok(blockFor(true).includes("CONSENT LEDGER: RECORDED"));
      assert.ok(!blockFor(true).includes("CONSENT LEDGER: NOT CONFIRMED"));
    });

    /* Deny by default: a missing marker, an undefined, or anything that is
       merely truthy all read NOT CONFIRMED. An evidence object built by some
       future path that never heard of the ledger must not claim durability
       it does not have. */
    test("everything that is not exactly true renders NOT CONFIRMED", () => {
      for (const marker of [false, undefined, "absent", null, "true", 1, {}])
        assert.ok(blockFor(marker).includes("CONSENT LEDGER: NOT CONFIRMED"),
          `durable=${JSON.stringify(marker)} claimed durable evidence`);
    });

    /* buildDescription() substitutes "-" for a blank value, so a design
       that emitted nothing on success would print "CONSENT LEDGER: -" -
       worse than either real value. Both values are non-empty strings. */
    test("the row never renders as a dash", () => {
      for (const marker of [true, false, "absent"])
        assert.ok(!blockFor(marker).includes("CONSENT LEDGER: -"));
    });

    test("it is the first consent row, above every claim it qualifies", () => {
      const lines = blockFor(false);
      const ledger = lines.findIndex((l) => l.startsWith("CONSENT LEDGER:"));
      const sms = lines.findIndex((l) => l.startsWith("SMS CONSENT:"));
      assert.ok(ledger >= 0 && sms >= 0);
      assert.ok(ledger < sms, "the caveat renders below the claim it qualifies");
    });

    /* The contact's `message` sidebar property is the short summary of the
       latest enquiry, and has never carried consent. It still does not. */
    test("buildSummary carries no CONSENT LEDGER line", () => {
      const payload = validateLead({ ...validHomeValue, sms_consent: true });
      payload.meta.submission_id = "csv_test000000000000000000";
      payload.consent = buildConsentEvidence(payload);
      payload.consent.durable = true;
      const summary = buildSummary(payload);
      assert.ok(!summary.includes("CONSENT LEDGER"));
      assert.ok(!summary.includes("SMS CONSENT"));
    });

    /* ORDERING IS LOAD-BEARING FOR RENDERING, not just for the grant.
       api/lead.js appends to the ledger BEFORE createLead() builds the
       block. An append moved after the CRM write would print NOT CONFIRMED
       on every successful submission and grant nothing, and every other
       test in this repository would still pass. This one would not. */
    test("a successful append is already recorded when the block is built", async () => {
      const PORTAL = "247240486";
      const GUID = "536a356d-d854-49ec-b204-b76e591cecaa";
      const FORM_KEY = "POST /submissions/v3/integration/secure/submit/" + PORTAL + "/" + GUID;
      const realFetch = globalThis.fetch;
      const httpRes = ({ status = 200, json = null }) => ({
        ok: status >= 200 && status < 300, status,
        async text() { return json === null ? "" : JSON.stringify(json); },
      });
      const savedEnv = {};
      const KEYS = [FEATURE_FLAG, "HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PORTAL_ID",
                    "HUBSPOT_FORM_GUID", LEDGER_URL_VAR];
      for (const k of KEYS) savedEnv[k] = process.env[k];
      process.env[FEATURE_FLAG] = "true";
      process.env.HUBSPOT_ACCESS_TOKEN = "pat-na1-TEST";
      process.env.HUBSPOT_PORTAL_ID = PORTAL;
      process.env.HUBSPOT_FORM_GUID = GUID;
      process.env[LEDGER_URL_VAR] = "postgres://app:secret@ledger.invalid/db";

      const bodies = [];
      globalThis.fetch = async (url, options = {}) => {
        const u = new URL(String(url));
        const key = (options.method || "GET") + " " + u.pathname;
        if (options.body) bodies.push({ key, body: JSON.parse(options.body) });
        if (key.endsWith("/contacts/search")) return httpRes({ json: { total: 0, results: [] } });
        if (key === "POST /crm/v3/objects/contacts") return httpRes({ json: { id: "1" } });
        if (key === FORM_KEY) return httpRes({ json: { inlineMessage: "ok" } });
        throw new Error("unstubbed " + key);
      };
      _setExecutor(async () => []);

      try {
        _resetRateLimit();
        const res = mockRes();
        await handler(mockReq({ body: { ...validHomeValue, sms_consent: true } }), res);
        assert.equal(res.statusCode, 200);
        const message = bodies.find((b) => b.key === FORM_KEY).body.fields
          .find((f) => f.name === "message").value;
        assert.ok(message.split("\n").includes("CONSENT LEDGER: RECORDED"),
          "the block was built before the ledger append resolved");
      } finally {
        globalThis.fetch = realFetch;
        _resetExecutor();
        for (const k of KEYS) {
          if (savedEnv[k] === undefined) delete process.env[k];
          else process.env[k] = savedEnv[k];
        }
      }
    });
  });
});
