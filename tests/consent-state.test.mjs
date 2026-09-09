/* HubSpot consent CURRENT-STATE wiring — Phase 2.
 *
 * Tier 4. Every HubSpot request here is a stubbed `fetch`: no portal, no
 * token, no contact is ever touched. Nothing sends, nothing calls.
 *
 * The invariants worth the most: a form submission can never clear a STOP,
 * a DNC or a global do-not-contact; an unticked box never blanks a prior
 * consent; and the 409 race cannot grant through a suppression that
 * appeared while this request was in flight.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createLead, findContactByEmail } from "../api/_lib/hubspot.mjs";
import {
  CONSENT_PROPERTIES, SMS_STATE_PROPERTIES, AI_VOICE_STATE_PROPERTIES,
  SUPPRESSION_PROPERTIES, REOPTIN_PROPERTIES, PERMISSION_STATUS_VALUES,
  REOPTIN_CHANNEL_VALUES, HUBSPOT_SUPPRESSION_VOCABULARY,
  fromHubSpotConsentProperties, toHubSpotConsentProperties, toHubSpotDateTime,
  parseHubSpotBoolean, consentPropertiesToRead, emptyConsentState,
  assertConsentEnum, requireConsentProperties,
  MALFORMED_RESPONSE, MALFORMED_VALUE, DATETIME_INVALID, ENUM_REJECTED,
} from "../api/_lib/hubspot-consent-state.mjs";
import {
  PERMISSION_STATE, FEATURE_FLAG, buildConsentEvidence, applySubmissionConsent,
} from "../api/_lib/consent.mjs";
import { canSendSms, canPlaceAutomatedVoiceCall, REASON } from "../api/_lib/permission.mjs";
import { validateLead } from "../api/_lib/validate.mjs";
import { _resetRateLimit } from "../api/_lib/security.mjs";
import { validHomeValue } from "./helpers.mjs";

const { NEVER_GRANTED, GRANTED, REVOKED, SUPPRESSED } = PERMISSION_STATE;
const S = SUPPRESSION_PROPERTIES;
const SMS = SMS_STATE_PROPERTIES;
const AIV = AI_VOICE_STATE_PROPERTIES;

const PORTAL = "247240486";
const GUID = "536a356d-d854-49ec-b204-b76e591cecaa";
const SEARCH = "POST /crm/v3/objects/contacts/search";
const CREATE = "POST /crm/v3/objects/contacts";
const FORM = "POST /submissions/v3/integration/secure/submit/" + PORTAL + "/" + GUID;
const PHONE = "(419) 555-0000";              // validHomeValue's normalised phone
const OLD_PHONE = "(419) 555-1111";

const realFetch = globalThis.fetch;
const saved = {};
const KEYS = [FEATURE_FLAG, "HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PORTAL_ID", "HUBSPOT_FORM_GUID"];

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
});

const httpRes = ({ status = 200, json = null }) => ({
  ok: status >= 200 && status < 300, status,
  async text() { return json === null ? "" : JSON.stringify(json); },
});

/**
 * Stub HubSpot.
 * `existing` — properties of a contact the search finds (null = none).
 * `raced`    — properties of a contact that appears only after a 409.
 */
function stubHubspot({ existing = null, raced = null, formStatus = 200,
                       searchHit, refetchBody } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    const method = options.method || "GET";
    const key = method + " " + u.pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ key, method, path: u.pathname, search: u.search, body });

    if (key === SEARCH) {
      /* `searchHit` replaces the matched result wholesale, so a test can
         hand back a hit whose `properties` is missing, null or an array. */
      if (searchHit !== undefined) return httpRes({ json: { total: 1, results: [searchHit] } });
      return httpRes({ json: existing
        ? { total: 1, results: [{ id: "77", properties: { email: "x@y.co", ...existing } }] }
        : { total: 0, results: [] } });
    }
    if (key === CREATE) {
      if (raced) return httpRes({ status: 409, json: { message: "Contact already exists. Existing ID: 88" } });
      return httpRes({ json: { id: "1" } });
    }
    if (method === "GET" && u.pathname.startsWith("/crm/v3/objects/contacts/")) {
      if (refetchBody !== undefined) return httpRes({ json: refetchBody });
      return httpRes({ json: { id: "88", properties: raced || {} } });
    }
    if (method === "PATCH" && u.pathname.startsWith("/crm/v3/objects/contacts/")) {
      return httpRes({ json: { id: "88" } });
    }
    if (key === FORM) {
      return formStatus === 200 ? httpRes({ json: { inlineMessage: "ok" } })
                                : httpRes({ status: formStatus, json: { message: "no" } });
    }
    throw new Error("unstubbed " + key);
  };
  return calls;
}

/** Run one submission through createLead and return the calls made. */
async function submit(over = {}, stub = {}) {
  const calls = stubHubspot(stub);
  const payload = validateLead({ ...validHomeValue, ...over });
  payload.meta.submission_id = "csv_test000000000000000000";
  if (process.env[FEATURE_FLAG] === "true") payload.consent = buildConsentEvidence(payload);
  await createLead(payload);
  return calls;
}

/* The write that actually persisted. On the 409 path the CREATE was
   REJECTED by HubSpot, so its body never reached the contact - the PATCH
   that followed is the real write, and it is the one every assertion here
   is about. Taking the create body instead would report a grant that was
   thrown away. */
const contactWrite = (calls) => {
  const patch = [...calls].reverse().find((c) => c.method === "PATCH");
  if (patch) return patch.body?.properties || {};
  return calls.find((c) => c.key === CREATE)?.body?.properties || {};
};
const cstKeys = (props) => Object.keys(props).filter((k) => k.startsWith("cst_")).sort();

/** A HubSpot contact that granted SMS a while ago, for OLD_PHONE. */
const grantedSmsProps = {
  [SMS.status]: GRANTED,
  [SMS.at]: "2026-08-01T10:00:00.000Z",
  [SMS.phone]: OLD_PHONE,
  [SMS.source]: "home_value",
  [SMS.page]: "/home-value",
  [SMS.version]: "CST_SMS_CONSENT_2026_09_V1",
};

/* =====================================================================
   1-3  FEATURE OFF — production equivalence
   ===================================================================== */
describe("feature off", () => {
  beforeEach(() => { delete process.env[FEATURE_FLAG]; });

  test("no consent properties are requested", async () => {
    const calls = await submit({ sms_consent: true, ai_voice_consent: true });
    const search = calls.find((c) => c.key === SEARCH);
    assert.deepEqual(search.body.properties, ["email"]);
    assert.equal(consentPropertiesToRead({}).length, 0);
  });

  test("no cst_ property is written", async () => {
    const calls = await submit({ sms_consent: true, ai_voice_consent: true });
    assert.deepEqual(cstKeys(contactWrite(calls)), []);
  });

  test("an existing contact is updated exactly as before", async () => {
    const calls = await submit({ sms_consent: true }, { existing: grantedSmsProps });
    const patch = calls.find((c) => c.method === "PATCH");
    assert.ok(patch, "no contact update was made");
    assert.deepEqual(cstKeys(patch.body.properties), []);
    /* And no extra HubSpot round trip was introduced. */
    assert.equal(calls.filter((c) => c.method === "GET").length, 0);
    assert.equal(calls.filter((c) => c.method === "PATCH").length, 1);
  });
});

/* =====================================================================
   4-10  READ ADAPTER
   ===================================================================== */
describe("reading HubSpot properties into consent state", () => {
  test("a blank status is never_granted", () => {
    for (const value of [undefined, null, "", "   "]) {
      const st = fromHubSpotConsentProperties({ [SMS.status]: value });
      assert.equal(st.sms.status, NEVER_GRANTED, `"${value}" should read as never_granted`);
    }
    assert.equal(emptyConsentState().sms.status, NEVER_GRANTED);
    assert.equal(emptyConsentState().ai_voice.status, NEVER_GRANTED);
    for (const value of PERMISSION_STATUS_VALUES)
      assert.equal(fromHubSpotConsentProperties({ [SMS.status]: value }).sms.status,
        value === SUPPRESSED ? SUPPRESSED : value);
  });

  /* Normalising an unknown status to never_granted is how a permission gets
     erased: a fresh grant would then overwrite whatever it actually meant.
     A nonblank value outside the vocabulary is a fault, not a default. */
  test("a nonblank unrecognised status is malformed CRM state, not never_granted", () => {
    /* Surrounding whitespace is HubSpot's, not a fault - `" granted "` is
       still granted. Everything else here is a fault. */
    assert.equal(fromHubSpotConsentProperties({ [SMS.status]: " granted " }).sms.status, GRANTED);
    for (const value of ["GRANTED", "yes", "enabled", "granted!", 1, 0, true, {}, []]) {
      assert.throws(
        () => fromHubSpotConsentProperties({ [SMS.status]: value }),
        (err) => err.token === MALFORMED_VALUE && err.property === SMS.status,
        `${JSON.stringify(value)} was silently normalised`);
    }
    assert.throws(
      () => fromHubSpotConsentProperties({ [AIV.status]: "unknown_future_value" }),
      (err) => err.property === AIV.status);
  });

  /* The error names the property so an operator can find the bad field, and
     never the value - a mis-mapped CRM field can hold anything, PII
     included. */
  test("a malformed-state error carries no value", () => {
    try {
      fromHubSpotConsentProperties({ [S.smsSuppressed]: "banana(419) 555-0000" });
      assert.fail("a malformed suppression flag was accepted");
    } catch (err) {
      assert.equal(err.token, MALFORMED_VALUE);
      assert.equal(err.property, S.smsSuppressed);
      assert.ok(!err.message.includes("banana"), "the bad value leaked into the message");
      assert.ok(!err.message.includes("419"), "the bad value leaked into the message");
      assert.equal(err.consentStateInvalid, true);
    }
  });

  /* The bug this exists to prevent: Boolean("false") is true. */
  test("HubSpot's string booleans are parsed, never coerced", () => {
    assert.equal(parseHubSpotBoolean("false"), false, '"false" must not be true');
    assert.equal(parseHubSpotBoolean("FALSE"), false);
    assert.equal(parseHubSpotBoolean(" true "), true);
    assert.equal(parseHubSpotBoolean("true"), true);
    assert.equal(parseHubSpotBoolean("True"), true);
    assert.equal(parseHubSpotBoolean(true), true, "a real boolean must still work");
    assert.equal(parseHubSpotBoolean(false), false);
    /* An unset HubSpot boolean genuinely means "not suppressed", and that is
       the ordinary case for almost every contact. */
    assert.equal(parseHubSpotBoolean(""), false);
    assert.equal(parseHubSpotBoolean("   "), false);
    assert.equal(parseHubSpotBoolean(null), false);
    assert.equal(parseHubSpotBoolean(undefined), false);
  });

  /* "banana" is not a way of saying "not suppressed". It is a sign this
     field does not hold what this code believes it holds, and answering
     "no, not suppressed" to that question is how a STOP gets ignored. */
  test("a nonblank uninterpretable boolean throws rather than reading as false", () => {
    for (const value of ["banana", "yes", "no", "1", "0", 1, 0, {}, [], "TRUE.", "falsey"])
      assert.throws(
        () => parseHubSpotBoolean(value, S.smsSuppressed),
        (err) => err.token === MALFORMED_VALUE && err.property === S.smsSuppressed,
        `${JSON.stringify(value)} was read as a boolean`);
  });

  test("a malformed suppression flag fails the whole read, on every flag", () => {
    for (const flag of [S.smsSuppressed, S.doNotCall, S.doNotContact])
      assert.throws(
        () => fromHubSpotConsentProperties({ ...grantedSmsProps, [flag]: "maybe" }),
        (err) => err.token === MALFORMED_VALUE && err.property === flag,
        `${flag} was interpreted`);
  });

  test('a "false" suppression flag does not suppress', () => {
    const st = fromHubSpotConsentProperties({
      ...grantedSmsProps, [S.smsSuppressed]: "false", [S.doNotCall]: "false",
    });
    assert.equal(st.sms.status, GRANTED);
    assert.deepEqual(st.suppression, {});
  });

  /* Suppression always wins, from either direction. */
  test("an SMS suppression flag overrides a granted status", () => {
    const st = fromHubSpotConsentProperties({
      ...grantedSmsProps,
      [S.smsSuppressed]: "true",
      [S.smsSuppressionReason]: "stop_keyword",
      [S.smsSuppressedAt]: "2026-09-02T00:00:00.000Z",
    });
    assert.equal(st.sms.status, SUPPRESSED, "a flagged STOP was read as granted");
    assert.equal(st.suppression.sms.reason, "stop_keyword");
    assert.equal(canSendSms(st, OLD_PHONE, { env: { [FEATURE_FLAG]: "true" } }).reason,
      REASON.SMS_SUPPRESSED_STOP);
  });

  test("a voice DNC flag overrides a granted voice status, and leaves SMS alone", () => {
    const st = fromHubSpotConsentProperties({
      ...grantedSmsProps,
      [AIV.status]: GRANTED, [AIV.phone]: OLD_PHONE,
      [S.doNotCall]: "true", [S.doNotCallReason]: "voice_request",
    });
    assert.equal(st.ai_voice.status, SUPPRESSED);
    assert.equal(st.sms.status, GRANTED, "a voice DNC silently suppressed SMS");
  });

  test("a global do-not-contact suppresses both channels", () => {
    const st = fromHubSpotConsentProperties({
      ...grantedSmsProps,
      [AIV.status]: GRANTED, [AIV.phone]: OLD_PHONE,
      [S.doNotContact]: "true", [S.doNotContactReason]: "consumer_request",
    });
    const env = { [FEATURE_FLAG]: "true" };
    assert.equal(st.sms.status, SUPPRESSED);
    assert.equal(st.ai_voice.status, SUPPRESSED);
    assert.equal(canSendSms(st, OLD_PHONE, { env }).reason, REASON.GLOBAL_DNC);
    assert.equal(canPlaceAutomatedVoiceCall(st, OLD_PHONE, { env }).reason, REASON.GLOBAL_DNC);
  });

  test("a conflicting record is interpreted, never repaired", () => {
    const props = { ...grantedSmsProps, [S.smsSuppressed]: "true" };
    const st = fromHubSpotConsentProperties(props);
    /* Reading it produced no write, and no attempt to "fix" the status. */
    const write = toHubSpotConsentProperties(applySubmissionConsent(st, {
      sms: { granted: false }, ai_voice: { granted: false },
      form_type: "home_value", source_page: "/", submission_id: "csv_x",
    }), {});
    assert.deepEqual(write, {}, "reading a conflict produced a self-healing write");
  });
});

/* =====================================================================
   11-17  GRANT
   ===================================================================== */
describe("granting", () => {
  const evidenceFor = (over) => {
    const p = validateLead({ ...validHomeValue, ...over });
    p.meta.submission_id = "csv_test000000000000000000";
    return { payload: p, evidence: buildConsentEvidence(p) };
  };

  test("an SMS-only grant writes only SMS state", async () => {
    const props = contactWrite(await submit({ sms_consent: true }));
    assert.deepEqual(cstKeys(props), Object.values(SMS).sort());
    assert.equal(props[SMS.status], GRANTED);
    for (const k of Object.values(AIV))
      assert.ok(!(k in props), `an AI voice property (${k}) was written for an SMS grant`);
  });

  test("an AI-voice-only grant writes only voice state", async () => {
    const props = contactWrite(await submit({ ai_voice_consent: true }));
    assert.deepEqual(cstKeys(props), Object.values(AIV).sort());
    assert.equal(props[AIV.status], GRANTED);
    for (const k of Object.values(SMS))
      assert.ok(!(k in props), `an SMS property (${k}) was written for a voice grant`);
  });

  test("granting both writes both", async () => {
    const props = contactWrite(await submit({ sms_consent: true, ai_voice_consent: true }));
    assert.deepEqual(cstKeys(props), [...Object.values(SMS), ...Object.values(AIV)].sort());
    assert.equal(props[SMS.status], GRANTED);
    assert.equal(props[AIV.status], GRANTED);
  });

  test("the server timestamp is serialised as a full ISO-8601 instant", () => {
    const { payload, evidence } = evidenceFor({ sms_consent: true });
    const props = toHubSpotConsentProperties(applySubmissionConsent({}, evidence), evidence);
    const at = props[SMS.at];
    assert.equal(at, payload.meta.submitted_at, "the property is not the server's own timestamp");
    assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    /* The whole reason these are datetime and not date properties: the time
       survives. A midnight value would mean the format silently truncated. */
    assert.equal(new Date(at).toISOString(), at);
    assert.equal(toHubSpotDateTime("2026-09-09T14:02:11.004Z"), "2026-09-09T14:02:11.004Z");
    assert.equal(toHubSpotDateTime(new Date("2026-09-09T14:02:11.004Z")), "2026-09-09T14:02:11.004Z");
  });

  /* Returning "" for a bad instant made `granted` with no timestamp a
     reachable write - a grant that looks complete and records nothing about
     when it was given. */
  test("an invalid timestamp throws instead of serialising to blank", () => {
    for (const bad of ["", "   ", null, undefined, "not a date", {}, [], NaN, new Date("x")])
      assert.throws(
        () => toHubSpotDateTime(bad, SMS.at),
        (err) => err.token === DATETIME_INVALID && err.property === SMS.at,
        `${JSON.stringify(bad)} produced a datetime`);
  });

  test("a granted status can never be written without a valid timestamp", () => {
    /* The transition result is well-formed except for the one thing that
       cannot be recovered: when it happened. */
    const broken = { sms: { changed: true, consent_at: "the other day", consent_phone: PHONE } };
    assert.throws(
      () => toHubSpotConsentProperties(broken, { sms: { captured_at: "" } }),
      (err) => err.token === DATETIME_INVALID && err.property === SMS.at);

    const missing = { sms: { changed: true, consent_phone: PHONE } };
    assert.throws(
      () => toHubSpotConsentProperties(missing, { sms: {} }),
      (err) => err.token === DATETIME_INVALID);

    /* A pending re-opt-in has the same invariant. */
    assert.throws(
      () => toHubSpotConsentProperties(
        { sms: { outcome: "pending_reoptin", pending_reoptin: {} } }, {}),
      (err) => err.token === DATETIME_INVALID && err.property === REOPTIN_PROPERTIES.at);
  });

  test("the submitted normalised phone, version, source and page are stored", async () => {
    const props = contactWrite(await submit({ sms_consent: true, page: "/43551-seller-review" }));
    assert.equal(props[SMS.phone], PHONE);
    assert.equal(props[SMS.version], "CST_SMS_CONSENT_2026_09_V1");
    assert.equal(props[SMS.source], "home_value");
    assert.equal(props[SMS.page], "/43551-seller-review");
  });
});

/* =====================================================================
   18-20  NO NEW CONSENT
   ===================================================================== */
describe("an unticked box changes nothing", () => {
  test("a later unticked submission does not blank a prior consent", async () => {
    const calls = await submit({}, { existing: grantedSmsProps });
    const props = contactWrite(calls);
    assert.deepEqual(cstKeys(props), [],
      "an unticked box wrote consent properties over the existing record");
  });

  test("an unticked box does not revoke", async () => {
    const before = fromHubSpotConsentProperties(grantedSmsProps);
    const p = validateLead({ ...validHomeValue });
    p.meta.submission_id = "csv_x";
    const after = applySubmissionConsent(before, buildConsentEvidence(p));
    assert.equal(after.sms.status, GRANTED);
    assert.equal(after.sms.consent_phone, OLD_PHONE, "the stored consent phone moved");
  });

  test("a new contact with neither box ticked writes no consent property at all", async () => {
    const calls = await submit({});
    const create = calls.find((c) => c.key === CREATE);
    assert.ok(create, "no contact was created");
    assert.deepEqual(cstKeys(create.body.properties), [],
      "blank-means-never_granted was not honoured; a redundant write was made");
  });
});

/* =====================================================================
   21-24  SUPPRESSION SURVIVES
   ===================================================================== */
describe("suppression survives a later form submission", () => {
  const suppressedSms = {
    ...grantedSmsProps,
    [S.smsSuppressed]: "true",
    [S.smsSuppressionReason]: "stop_keyword",
    [S.smsSuppressedAt]: "2026-09-02T00:00:00.000Z",
  };

  test("an SMS STOP survives a later ticked SMS box", async () => {
    const props = contactWrite(await submit({ sms_consent: true }, { existing: suppressedSms }));
    assert.notEqual(props[SMS.status], GRANTED, "a re-ticked box granted through a STOP");
    assert.ok(!(SMS.status in props), "the suppressed status was overwritten");
    assert.equal(props[REOPTIN_PROPERTIES.channel], "sms");
  });

  test("a voice DNC survives a later ticked voice box", async () => {
    const props = contactWrite(await submit({ ai_voice_consent: true }, {
      existing: { [AIV.status]: GRANTED, [AIV.phone]: OLD_PHONE, [S.doNotCall]: "true" },
    }));
    assert.ok(!(AIV.status in props), "a re-ticked box granted through a DNC");
    assert.equal(props[REOPTIN_PROPERTIES.channel], "ai_voice");
  });

  test("a global do-not-contact survives both boxes ticked", async () => {
    const props = contactWrite(await submit({ sms_consent: true, ai_voice_consent: true }, {
      existing: { ...grantedSmsProps, [S.doNotContact]: "true" },
    }));
    assert.ok(!(SMS.status in props));
    assert.ok(!(AIV.status in props));
    assert.equal(props[REOPTIN_PROPERTIES.channel], "both");
  });

  /* The hard rule for this phase: an ordinary website submission never
     writes a suppression field, on any path, in any combination. */
  test("no suppression property is ever written by a form submission", async () => {
    const scenarios = [
      [{ sms_consent: true, ai_voice_consent: true }, { existing: suppressedSms }],
      [{ sms_consent: true }, { existing: { ...grantedSmsProps, [S.doNotContact]: "true" } }],
      [{ ai_voice_consent: true }, { existing: { [S.doNotCall]: "true" } }],
      [{}, { existing: suppressedSms }],
      [{ sms_consent: true, ai_voice_consent: true }, {}],
      [{ sms_consent: true }, { raced: suppressedSms }],
    ];
    for (const [over, stub] of scenarios) {
      const props = contactWrite(await submit(over, stub));
      for (const name of Object.values(S))
        assert.ok(!(name in props), `${name} was written by an ordinary submission`);
    }
  });
});

/* =====================================================================
   25-29  RE-OPT-IN REQUEST
   ===================================================================== */
describe("re-opt-in requests are recorded, never honoured automatically", () => {
  const suppressedBoth = {
    ...grantedSmsProps,
    [S.smsSuppressed]: "true",
    [AIV.status]: GRANTED, [AIV.phone]: OLD_PHONE,
    [S.doNotCall]: "true",
  };

  test("the pending channel is sms, ai_voice or both, matching what was ticked", async () => {
    const only = async (over) =>
      contactWrite(await submit(over, { existing: suppressedBoth }))[REOPTIN_PROPERTIES.channel];
    assert.equal(await only({ sms_consent: true }), "sms");
    assert.equal(await only({ ai_voice_consent: true }), "ai_voice");
    assert.equal(await only({ sms_consent: true, ai_voice_consent: true }), "both");
  });

  test("a re-opt-in request carries a timestamp and grants nothing", async () => {
    const props = contactWrite(await submit({ sms_consent: true }, { existing: suppressedBoth }));
    assert.match(props[REOPTIN_PROPERTIES.at], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(cstKeys(props), Object.values(REOPTIN_PROPERTIES).sort(),
      "a re-opt-in wrote something other than the two re-opt-in properties");
  });

  test("a re-opt-in request does not clear the suppression", async () => {
    const props = contactWrite(await submit({ sms_consent: true, ai_voice_consent: true }, {
      existing: suppressedBoth,
    }));
    for (const name of Object.values(S))
      assert.ok(!(name in props), `${name} was cleared by a re-opt-in request`);
  });

  test("a revoked channel behaves like a suppressed one", async () => {
    const props = contactWrite(await submit({ sms_consent: true }, {
      existing: { ...grantedSmsProps, [SMS.status]: REVOKED },
    }));
    assert.ok(!(SMS.status in props), "a re-ticked box granted through a revocation");
    assert.equal(props[REOPTIN_PROPERTIES.channel], "sms");
  });
});

/* =====================================================================
   30-32  PHONE BINDING
   ===================================================================== */
describe("consent stays tied to the number it was given for", () => {
  test("an existing consent keeps its historical number", async () => {
    const calls = await submit({}, { existing: grantedSmsProps });
    assert.deepEqual(cstKeys(contactWrite(calls)), []);
    const st = fromHubSpotConsentProperties(grantedSmsProps);
    assert.equal(st.sms.consent_phone, OLD_PHONE);
    /* And the resolver refuses the NEW number on the old permission. */
    assert.equal(canSendSms(st, PHONE, { env: { [FEATURE_FLAG]: "true" } }).reason,
      REASON.CONSENT_PHONE_MISMATCH);
  });

  test("a new grant records the submitted number", async () => {
    const props = contactWrite(await submit({ sms_consent: true, phone: "419.555.7788" }));
    assert.equal(props[SMS.phone], "(419) 555-7788");
  });

  /* The contact's `phone` property is ordinary lead data and moves freely.
     The consent phone is evidence and must come only from the validated
     submission that carried the disclosure. */
  test("the contact's current phone cannot substitute as the consent phone", async () => {
    const calls = await submit({ sms_consent: true, phone: "4195557788" }, {
      existing: { ...grantedSmsProps, phone: "(999) 999-9999" },
    });
    const props = contactWrite(calls);
    assert.equal(props[SMS.phone], "(419) 555-7788");
    assert.notEqual(props[SMS.phone], "(999) 999-9999");
  });
});

/* =====================================================================
   33-35  THE 409 RACE
   ===================================================================== */
describe("a contact that appears mid-request", () => {
  const racedStop = {
    [SMS.status]: GRANTED, [SMS.phone]: OLD_PHONE,
    [S.smsSuppressed]: "true", [S.smsSuppressionReason]: "stop_keyword",
  };

  test("a 409 causes the actual consent state to be refetched", async () => {
    const calls = await submit({ sms_consent: true }, { raced: racedStop });
    const reads = calls.filter((c) => c.method === "GET" && c.path.startsWith("/crm/v3/objects/contacts/"));
    assert.equal(reads.length, 1, "the conflicting contact's consent state was never read");
    for (const name of CONSENT_PROPERTIES)
      assert.ok(reads[0].search.includes(name), `the refetch did not ask for ${name}`);
  });

  /* The compliance-critical one. Before the create, this process believed
     the contact did not exist and its state was empty. If it reused that
     belief, a ticked box would grant straight through the STOP that the
     racing writer had just recorded. */
  test("a suppression discovered only after the conflict is preserved", async () => {
    const props = contactWrite(await submit({ sms_consent: true }, { raced: racedStop }));
    assert.ok(!(SMS.status in props),
      "the conflict fallback granted through a STOP it had not seen at create time");
    assert.equal(props[REOPTIN_PROPERTIES.channel], "sms");
    for (const name of Object.values(S))
      assert.ok(!(name in props), `${name} was written on the conflict path`);
  });

  test("a 409 onto a clean contact still grants normally", async () => {
    const props = contactWrite(await submit({ sms_consent: true }, { raced: {} }));
    assert.equal(props[SMS.status], GRANTED);
    assert.equal(props[SMS.phone], PHONE);
  });

  test("with the feature off a 409 makes no extra read", async () => {
    delete process.env[FEATURE_FLAG];
    const calls = await submit({ sms_consent: true }, { raced: racedStop });
    assert.equal(calls.filter((c) => c.method === "GET").length, 0);
    assert.deepEqual(cstKeys(contactWrite(calls)), []);
  });
});

/* =====================================================================
   A MALFORMED RESPONSE IS NOT AN EMPTY CONSENT STATE
   =====================================================================
   `json?.properties || {}` is the shape of this bug. A 200 whose body is
   not what the code expects falls through it into a consent state that says
   "this contact has never granted anything and is not suppressed" - a claim
   about a real person, invented from a response that made no such claim.

   A contact that was FOUND and a contact that does not EXIST are different
   facts. Only the second one may become emptyConsentState().
   ===================================================================== */
describe("a malformed HubSpot response fails rather than inventing a state", () => {
  const malformed = (err) => err.token === MALFORMED_RESPONSE && err.consentStateInvalid === true;

  test("a search hit with no properties at all", async () => {
    await assert.rejects(
      () => submit({ sms_consent: true }, { searchHit: { id: "77" } }),
      (err) => malformed(err) && err.property === "SEARCH");
  });

  test("a search hit whose properties is null", async () => {
    await assert.rejects(
      () => submit({ sms_consent: true }, { searchHit: { id: "77", properties: null } }),
      malformed);
  });

  test("a search hit whose properties is an array", async () => {
    await assert.rejects(
      () => submit({ sms_consent: true }, { searchHit: { id: "77", properties: [] } }),
      malformed);
  });

  test("no contact is written when the search response is malformed", async () => {
    const calls = stubHubspot({ searchHit: { id: "77", properties: null } });
    const payload = validateLead({ ...validHomeValue, sms_consent: true });
    payload.meta.submission_id = "csv_test000000000000000000";
    payload.consent = buildConsentEvidence(payload);
    await assert.rejects(() => createLead(payload), malformed);
    assert.equal(calls.filter((c) => c.method === "PATCH" || c.key === CREATE).length, 0,
      "a contact was written despite an uninterpretable consent state");
    assert.equal(calls.filter((c) => c.key === FORM).length, 0);
  });

  test("a 409 refetch with no properties", async () => {
    await assert.rejects(
      () => submit({ sms_consent: true }, { raced: {}, refetchBody: { id: "88" } }),
      (err) => malformed(err) && err.property === "READ");
  });

  test("a 409 refetch with a malformed properties value", async () => {
    for (const properties of [null, [], "granted", 7]) {
      await assert.rejects(
        () => submit({ sms_consent: true }, { raced: {}, refetchBody: { id: "88", properties } }),
        malformed, `properties=${JSON.stringify(properties)} was accepted`);
    }
  });

  /* The whole point. The empty state is correct in exactly one place: a
     contact the search genuinely did not find. */
  test("a genuinely new contact still uses the empty state", async () => {
    const props = contactWrite(await submit({ sms_consent: true }));
    assert.equal(props[SMS.status], GRANTED);
    assert.equal(emptyConsentState().sms.status, NEVER_GRANTED);
    assert.deepEqual(emptyConsentState().suppression, {});
  });

  test("requireConsentProperties accepts an object and only an object", () => {
    assert.deepEqual(requireConsentProperties({}, "SEARCH"), {});
    const ok = { [SMS.status]: GRANTED };
    assert.equal(requireConsentProperties(ok, "READ"), ok);
    for (const bad of [null, undefined, [], "x", 0, true])
      assert.throws(() => requireConsentProperties(bad, "SEARCH"),
        (err) => err.token === MALFORMED_RESPONSE);
  });

  test("with the feature off a malformed response is not even looked at", async () => {
    delete process.env[FEATURE_FLAG];
    const calls = await submit({ sms_consent: true }, { searchHit: { id: "77" } });
    assert.ok(calls.some((c) => c.method === "PATCH"), "the submission did not proceed");
    assert.deepEqual(cstKeys(contactWrite(calls)), []);
  });
});

/* =====================================================================
   36-38  FAILURE SEMANTICS ARE UNCHANGED
   ===================================================================== */
describe("HubSpot remains critical", () => {
  const payloadWithConsent = () => {
    const p = validateLead({ ...validHomeValue, sms_consent: true });
    p.meta.submission_id = "csv_test000000000000000000";
    p.consent = buildConsentEvidence(p);
    return p;
  };

  test("a contact write failure fails the submission", async () => {
    globalThis.fetch = async (url, options = {}) => {
      const u = new URL(String(url));
      const key = (options.method || "GET") + " " + u.pathname;
      if (key === SEARCH) return httpRes({ json: { total: 0, results: [] } });
      if (key === CREATE) return httpRes({ status: 500, json: { message: "boom" } });
      throw new Error("unstubbed " + key);
    };
    await assert.rejects(() => createLead(payloadWithConsent()));
  });

  /* No transaction spans the CRM API and the Forms API. The contact may
     already carry the consent state when the form submission fails - and
     this still throws, so the visitor gets the recovery panel rather than a
     false success. That is a real partial write and it is not hidden. */
  test("a form-activity failure after a successful contact write still fails", async () => {
    const calls = stubHubspot({ formStatus: 500 });
    await assert.rejects(() => createLead(payloadWithConsent()));
    const create = calls.find((c) => c.key === CREATE);
    assert.ok(create, "the contact write did not happen");
    assert.equal(create.body.properties[SMS.status], GRANTED,
      "precondition: the consent state was written before the form failed");
  });
});

/* =====================================================================
   39-40  SCHEMA CONTRACT
   ===================================================================== */
describe("the HubSpot schema contract", () => {
  test("exactly the 23 approved internal names, no duplicates", () => {
    assert.equal(CONSENT_PROPERTIES.length, 23);
    assert.equal(new Set(CONSENT_PROPERTIES).size, 23, "a name is duplicated");
    assert.deepEqual([...CONSENT_PROPERTIES].sort(), [
      "cst_ai_voice_consent_at", "cst_ai_voice_consent_copy_version",
      "cst_ai_voice_consent_page", "cst_ai_voice_consent_phone",
      "cst_ai_voice_consent_source", "cst_ai_voice_permission_status",
      "cst_do_not_call", "cst_do_not_call_at", "cst_do_not_call_reason",
      "cst_do_not_contact", "cst_do_not_contact_at", "cst_do_not_contact_reason",
      "cst_reoptin_requested_at", "cst_reoptin_requested_channel",
      "cst_sms_consent_at", "cst_sms_consent_copy_version", "cst_sms_consent_page",
      "cst_sms_consent_phone", "cst_sms_consent_source", "cst_sms_permission_status",
      "cst_sms_suppressed", "cst_sms_suppressed_at", "cst_sms_suppression_reason",
    ]);
    for (const name of CONSENT_PROPERTIES) assert.match(name, /^cst_[a-z_]+$/);
  });

  /* HubSpot answers an out-of-vocabulary dropdown value with a 400, which
     fails the lead. The guard turns that into a loud local failure before
     the request is built, rather than a lost submission in production. */
  test("an unsupported dropdown value cannot be emitted", () => {
    assert.deepEqual([...PERMISSION_STATUS_VALUES],
      ["never_granted", "granted", "revoked", "suppressed"]);
    assert.deepEqual([...REOPTIN_CHANNEL_VALUES], ["sms", "ai_voice", "both"]);

    /* Every status this adapter can write is in the vocabulary: a granted
       channel writes exactly `granted` and nothing else can reach the
       property, because no other branch emits it. */
    const granted = toHubSpotConsentProperties(
      { sms: { changed: true, consent_at: "2026-09-09T00:00:00.000Z" } }, { sms: {} });
    assert.ok(PERMISSION_STATUS_VALUES.includes(granted[SMS.status]));

    /* And every channel value it can write is in that vocabulary too - the
       three combinations are the only reachable ones. */
    const pending = (sms, voice) => toHubSpotConsentProperties({
      sms: sms ? { outcome: "pending_reoptin", pending_reoptin: { requested_at: "2026-09-09T00:00:00.000Z" } } : {},
      ai_voice: voice ? { outcome: "pending_reoptin", pending_reoptin: { requested_at: "2026-09-09T00:00:00.000Z" } } : {},
    }, {})[REOPTIN_PROPERTIES.channel];
    assert.equal(pending(true, false), "sms");
    assert.equal(pending(false, true), "ai_voice");
    assert.equal(pending(true, true), "both");
    assert.equal(pending(false, false), undefined, "a channel was written with nothing pending");
    for (const v of ["sms", "ai_voice", "both"]) assert.ok(REOPTIN_CHANNEL_VALUES.includes(v));

    /* The guard itself bites when handed something outside the set. It is
       tested directly rather than through a production override: the
       function that writes consent must not take a parameter naming the
       status, because a caller could then use it. */
    assert.throws(
      () => assertConsentEnum(SMS.status, "definitely_yes", PERMISSION_STATUS_VALUES),
      (err) => err.token === ENUM_REJECTED && err.property === SMS.status,
      "an arbitrary status was accepted");
    assert.throws(
      () => assertConsentEnum(REOPTIN_PROPERTIES.channel, "everything", REOPTIN_CHANNEL_VALUES),
      (err) => err.token === ENUM_REJECTED);
    for (const v of PERMISSION_STATUS_VALUES)
      assert.equal(assertConsentEnum(SMS.status, v, PERMISSION_STATUS_VALUES), v);
  });

  /* The seam that used to exist. toHubSpotConsentProperties took an `opts`
     object whose `forceStatus` overrode the transition result; it was there
     only to make the test above possible, and a production caller could
     have reached for it just as easily. */
  test("no caller can override the status a grant writes", () => {
    assert.equal(toHubSpotConsentProperties.length, 2,
      "toHubSpotConsentProperties grew a third parameter");
    const state = { sms: { changed: true, consent_at: "2026-09-09T00:00:00.000Z" } };
    const forced = toHubSpotConsentProperties(state, { sms: {} }, { forceStatus: SUPPRESSED });
    assert.equal(forced[SMS.status], GRANTED,
      "a third argument still influenced the status written");
    /* Comments stripped: the module explains in prose why the seam was
       removed, and that sentence is not the seam. */
    const code = readFileSync(new URL("../api/_lib/hubspot-consent-state.mjs", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    assert.ok(!/forceStatus|\bopts\b/.test(code), "the status override seam is still in the module");
  });

  /* The footgun this phase must not walk into: consent.mjs has internal
     event classifications (`voice_dnc`, `global_dnc`) that are NOT valid
     values for these HubSpot dropdowns. Nothing writes them today, and the
     vocabulary is written down so a future phase maps rather than passes
     through. */
  test("internal suppression classifications are not HubSpot enum values", () => {
    const callReasons = HUBSPOT_SUPPRESSION_VOCABULARY[S.doNotCallReason];
    const contactReasons = HUBSPOT_SUPPRESSION_VOCABULARY[S.doNotContactReason];
    assert.ok(!callReasons.includes("voice_dnc"),
      "voice_dnc is not a value cst_do_not_call_reason accepts");
    assert.ok(!contactReasons.includes("global_dnc"),
      "global_dnc is not a value cst_do_not_contact_reason accepts");
    assert.deepEqual(callReasons, ["voice_request", "natural_language", "manual"]);
    assert.deepEqual(contactReasons, ["consumer_request", "manual"]);
    assert.deepEqual(HUBSPOT_SUPPRESSION_VOCABULARY[S.smsSuppressionReason],
      ["stop_keyword", "natural_language", "manual", "carrier"]);
  });
});
