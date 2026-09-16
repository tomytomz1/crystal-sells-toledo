/* Gate 8 — send-time authorization.
 *
 * Tier 4: these tests exercise the point that will stand immediately in
 * front of every future automated SMS and AI-voice send. No test sends a
 * message, places a call, reaches HubSpot, or reaches Neon. The two I/O
 * boundaries are injected; the permission resolver itself is real.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { FEATURE_FLAG, PERMISSION_STATE } from "../api/_lib/consent.mjs";
import { REASON } from "../api/_lib/permission.mjs";
import {
  SENDER_LEDGER_URL_VAR,
  LOOKUP_ERROR,
  authorizeSms,
  authorizeAutomatedVoice,
  lookupDurableSuppression,
  suppressionLookupLogShape,
  _setSuppressionExecutor,
  _resetSuppressionExecutor,
  _setContactLookup,
  _resetContactLookup,
} from "../api/_lib/send-permission.mjs";

const { GRANTED, NEVER_GRANTED } = PERMISSION_STATE;
const PHONE = "(419) 555-1234";
const OTHER_PHONE = "(419) 555-9999";
const EMAIL = "lead@example.test";
const URL = "postgresql://sender:password@example.invalid/neondb";
const ON = { [FEATURE_FLAG]: "true", [SENDER_LEDGER_URL_VAR]: URL };
const OFF = { [SENDER_LEDGER_URL_VAR]: URL };

function granted({ sms = false, voice = false, phone = PHONE } = {}) {
  const channel = () => ({
    status: GRANTED,
    consent_phone: phone,
    consent_at: "2026-09-16T00:00:00.000Z",
    consent_version: "v1",
  });
  return {
    sms: sms ? channel() : { status: NEVER_GRANTED },
    ai_voice: voice ? channel() : { status: NEVER_GRANTED },
    suppression: {},
  };
}

const contact = (state) => ({ id: "123", consent: state });

beforeEach(() => {
  _resetSuppressionExecutor();
  _resetContactLookup();
});

afterEach(() => {
  _resetSuppressionExecutor();
  _resetContactLookup();
});

describe("Gate 8 send-time enforcement", () => {
  test("feature off refuses without touching either provider boundary", async () => {
    let dbCalls = 0;
    let crmCalls = 0;
    _setSuppressionExecutor(async () => { dbCalls++; return []; });
    _setContactLookup(async () => { crmCalls++; return contact(granted({ sms: true })); });

    assert.deepEqual(await authorizeSms({ email: EMAIL, phone: PHONE }, { env: OFF }),
      { allowed: false, reason: REASON.FEATURE_DISABLED });
    assert.equal(dbCalls, 0);
    assert.equal(crmCalls, 0);
  });

  test("missing sender credential fails closed before the CRM read", async () => {
    let crmCalls = 0;
    _setContactLookup(async () => { crmCalls++; return contact(granted({ sms: true })); });

    assert.deepEqual(
      await authorizeSms({ email: EMAIL, phone: PHONE }, { env: { [FEATURE_FLAG]: "true" } }),
      { allowed: false, reason: REASON.SUPPRESSION_LOOKUP_UNAVAILABLE },
    );
    assert.equal(crmCalls, 0);
  });

  test("no durable block plus a current matching SMS grant allows", async () => {
    _setSuppressionExecutor(async () => []);
    _setContactLookup(async () => contact(granted({ sms: true })));

    assert.deepEqual(await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: true, reason: REASON.ALLOWED });
  });

  test("a durable SMS block refuses before HubSpot is queried", async () => {
    let crmCalls = 0;
    _setSuppressionExecutor(async () => [
      { channel: "sms", suppressed_at: "2026-09-16T00:00:00.000Z" },
    ]);
    _setContactLookup(async () => { crmCalls++; return contact(granted({ sms: true })); });

    assert.deepEqual(await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: false, reason: REASON.DURABLE_SMS_BLOCK });
    assert.equal(crmCalls, 0, "a known durable refusal should not need a CRM read");
  });

  test("an SMS-only durable block does not suppress an independently granted voice lane", async () => {
    _setSuppressionExecutor(async () => [
      { channel: "sms", suppressed_at: "2026-09-16T00:00:00.000Z" },
    ]);
    _setContactLookup(async () => contact(granted({ voice: true })));

    assert.deepEqual(await authorizeAutomatedVoice({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: true, reason: REASON.ALLOWED });
  });

  test("a durable all-channel block refuses automated voice before HubSpot is queried", async () => {
    let crmCalls = 0;
    _setSuppressionExecutor(async () => [
      { channel: "all", suppressed_at: "2026-09-16T00:00:00.000Z" },
    ]);
    _setContactLookup(async () => { crmCalls++; return contact(granted({ voice: true })); });

    assert.deepEqual(await authorizeAutomatedVoice({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: false, reason: REASON.DURABLE_GLOBAL_BLOCK });
    assert.equal(crmCalls, 0);
  });

  test("database failure is not interpreted as no suppression", async () => {
    _setSuppressionExecutor(async () => { throw new Error("contains +14195551234 and a host"); });
    _setContactLookup(async () => contact(granted({ sms: true })));

    assert.deepEqual(await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: false, reason: REASON.SUPPRESSION_LOOKUP_UNAVAILABLE });
  });

  test("malformed or unknown suppression rows fail closed", async () => {
    for (const rows of [
      [{ channel: "sms", suppressed_at: "not-a-date" }],
      [{ channel: "other", suppressed_at: "2026-09-16T00:00:00.000Z" }],
      [{ channel: "sms" }],
      [null],
    ]) {
      _setSuppressionExecutor(async () => rows);
      assert.deepEqual(await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON }),
        { allowed: false, reason: REASON.SUPPRESSION_LOOKUP_UNAVAILABLE });
    }
  });

  test("a HubSpot read failure is distinguishable from no consent and still refuses", async () => {
    _setSuppressionExecutor(async () => []);
    _setContactLookup(async () => { throw new Error("CRM unavailable"); });

    assert.deepEqual(await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: false, reason: REASON.CONSENT_STATE_UNAVAILABLE });
  });

  test("a genuinely absent contact is simply no consent", async () => {
    _setSuppressionExecutor(async () => []);
    _setContactLookup(async () => null);

    assert.deepEqual(await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: false, reason: REASON.NO_CONSENT });
  });

  test("the old grant cannot travel to a different target number", async () => {
    _setSuppressionExecutor(async () => []);
    _setContactLookup(async () => contact(granted({ sms: true, phone: PHONE })));

    assert.deepEqual(await authorizeSms({ email: EMAIL, phone: OTHER_PHONE }, { env: ON }),
      { allowed: false, reason: REASON.CONSENT_PHONE_MISMATCH });
  });

  test("the sender asks only the narrow db/003 function for the E.164 target", async () => {
    let observed;
    _setSuppressionExecutor(async (text, params, options) => {
      observed = { text, params, url: options.url };
      return [];
    });

    assert.deepEqual(await lookupDurableSuppression("419-555-1234", { env: ON }),
      { status: "ok", channels: [] });
    assert.deepEqual(observed, {
      text: "SELECT channel, suppressed_at FROM public.get_suppression_state($1)",
      params: ["+14195551234"],
      url: URL,
    });
    assert.ok(!observed.text.includes("communication_consent_events"),
      "the sender credential must not name or read the ledger table");
  });

  test("lookup diagnostics expose structure, never driver text or PII", () => {
    const err = new Error("password=secret phone=+14195551234 host=db.example");
    err.name = "TypeError";
    err.code = "ENOTFOUND";
    const shape = suppressionLookupLogShape(err);
    assert.deepEqual(shape, {
      suppression_lookup_error: LOOKUP_ERROR.FAILED,
      suppression_driver_error: "TypeError",
      suppression_driver_code: "ENOTFOUND",
    });
    assert.ok(!JSON.stringify(shape).includes("14195551234"));
    assert.ok(!JSON.stringify(shape).includes("db.example"));
    assert.ok(!JSON.stringify(shape).includes("secret"));
  });
});
