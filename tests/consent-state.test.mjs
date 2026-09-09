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

import { createLead, findContactByEmail } from "../api/_lib/hubspot.mjs";
import {
  CONSENT_PROPERTIES, SMS_STATE_PROPERTIES, AI_VOICE_STATE_PROPERTIES,
  SUPPRESSION_PROPERTIES, REOPTIN_PROPERTIES, PERMISSION_STATUS_VALUES,
  REOPTIN_CHANNEL_VALUES, HUBSPOT_SUPPRESSION_VOCABULARY,
  fromHubSpotConsentProperties, toHubSpotConsentProperties, toHubSpotDateTime,
  parseHubSpotBoolean, consentPropertiesToRead, emptyConsentState,
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
function stubHubspot({ existing = null, raced = null, formStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    const method = options.method || "GET";
    const key = method + " " + u.pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ key, method, path: u.pathname, search: u.search, body });

    if (key === SEARCH) {
      return httpRes({ json: existing
        ? { total: 1, results: [{ id: "77", properties: { email: "x@y.co", ...existing } }] }
        : { total: 0, results: [] } });
    }
    if (key === CREATE) {
      if (raced) return httpRes({ status: 409, json: { message: "Contact already exists. Existing ID: 88" } });
      return httpRes({ json: { id: "1" } });
    }
    if (method === "GET" && u.pathname.startsWith("/crm/v3/objects/contacts/")) {
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
  test("blank or unrecognised status is never_granted", () => {
    for (const value of [undefined, null, "", "   ", "GRANTED", "yes", "enabled", 1]) {
      const st = fromHubSpotConsentProperties({ [SMS.status]: value });
      assert.equal(st.sms.status, NEVER_GRANTED, `"${value}" should read as never_granted`);
    }
    assert.equal(emptyConsentState().sms.status, NEVER_GRANTED);
    assert.equal(emptyConsentState().ai_voice.status, NEVER_GRANTED);
  });

  /* The bug this exists to prevent: Boolean("false") is true. */
  test("HubSpot's string booleans are parsed, never coerced", () => {
    assert.equal(parseHubSpotBoolean("false"), false, '"false" must not be true');
    assert.equal(parseHubSpotBoolean("FALSE"), false);
    assert.equal(parseHubSpotBoolean("no"), false);
    assert.equal(parseHubSpotBoolean("0"), false);
    assert.equal(parseHubSpotBoolean(""), false);
    assert.equal(parseHubSpotBoolean(null), false);
    assert.equal(parseHubSpotBoolean(undefined), false);
    assert.equal(parseHubSpotBoolean("true"), true);
    assert.equal(parseHubSpotBoolean("True"), true);
    assert.equal(parseHubSpotBoolean(" true "), true);
    assert.equal(parseHubSpotBoolean(true), true, "a real boolean must still work");
    assert.equal(parseHubSpotBoolean(false), false);
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
    /* Never send garbage as a date. */
    for (const bad of ["", null, undefined, "not a date", {}])
      assert.equal(toHubSpotDateTime(bad), "");
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
  /* Reaches the enum guard through the public function by forcing a status
     the transition layer could never legitimately produce. */
  const assertEnumEscapeHatch = (status) =>
    toHubSpotConsentProperties({
      sms: { changed: true, consent_at: "2026-09-09T00:00:00.000Z" },
    }, { sms: {} }, { forceStatus: status });

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

    /* The guard itself bites when handed something outside the set. */
    assert.throws(
      () => assertEnumEscapeHatch("definitely_yes"),
      /HUBSPOT_CONSENT_ENUM_REJECTED/,
      "an arbitrary status was accepted");
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
