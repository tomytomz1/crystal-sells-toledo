import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  _twilioConsentClientForTest,
  TWILIO_CONSENT_STATUS,
  TWILIO_CONSENT_REASON,
  TWILIO_CONSENT_ENDPOINT,
} from "../api/_lib/twilio-consent.mjs";

const PHONE = "+14195550000";
const SERVICE = "MG" + "a".repeat(32);
const SENDER = "+14195551234";
const KEY = "SK" + "b".repeat(32);
const CONSENT_AT = "2026-09-21T16:05:49.036Z";

function env(overrides = {}) {
  return {
    TWILIO_CONSENT_API_KEY_SID: KEY,
    TWILIO_CONSENT_API_KEY_SECRET: "secret-value",
    TWILIO_CONSENT_MESSAGING_SERVICE_SID: SERVICE,
    TWILIO_CONSENT_SENDER_NUMBER: SENDER,
    ...overrides,
  };
}

function uuids() {
  const values = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  return () => values.shift();
}

function responseFor(ids, codes = [0, 0]) {
  return {
    ok: true,
    json: async () => ({
      items: ids.map((id, i) => ({ correlation_id: id, error_code: codes[i], error_messages: [] })),
    }),
  };
}

describe("Twilio Consent Management client", () => {
  test("fails closed when dedicated provider credentials are absent", async () => {
    const client = _twilioConsentClientForTest({ fetchImpl: async () => { throw new Error("should not call"); }, uuidFactory: uuids() });
    const result = await client({ phone: PHONE, consentAt: CONSENT_AT }, { env: {} });
    assert.equal(result.status, TWILIO_CONSENT_STATUS.NOT_CONFIRMED);
    assert.equal(result.reason, TWILIO_CONSENT_REASON.NOT_CONFIGURED);
  });

  test("posts exactly two website opt-ins: Messaging Service and sender number", async () => {
    const calls = [];
    const ids = ["1".repeat(32), "2".repeat(32)];
    const client = _twilioConsentClientForTest({
      uuidFactory: uuids(),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return responseFor(ids);
      },
    });

    const result = await client({ phone: PHONE, consentAt: CONSENT_AT }, { env: env() });
    assert.equal(result.status, TWILIO_CONSENT_STATUS.CONFIRMED);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, TWILIO_CONSENT_ENDPOINT);
    assert.equal(calls[0].options.method, "POST");
    assert.match(calls[0].options.headers.Authorization, /^Basic /);

    const body = new URLSearchParams(calls[0].options.body);
    const items = body.getAll("Items").map((x) => JSON.parse(x));
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((x) => x.sender_id), [SERVICE, SENDER]);
    for (const item of items) {
      assert.equal(item.contact_id, PHONE);
      assert.equal(item.status, "opt-in");
      assert.equal(item.source, "website");
      assert.equal(item.date_of_consent, CONSENT_AT);
      assert.match(item.correlation_id, /^[0-9a-f]{32}$/);
    }
  });

  test("one failed provider item means the re-opt-in is not confirmed", async () => {
    const ids = ["1".repeat(32), "2".repeat(32)];
    const client = _twilioConsentClientForTest({
      uuidFactory: uuids(),
      fetchImpl: async () => responseFor(ids, [0, 30646]),
    });
    const result = await client({ phone: PHONE, consentAt: CONSENT_AT }, { env: env() });
    assert.equal(result.status, TWILIO_CONSENT_STATUS.NOT_CONFIRMED);
    assert.equal(result.reason, TWILIO_CONSENT_REASON.PARTIAL_FAILURE);
  });

  test("missing or duplicate correlation results fail closed", async () => {
    const client = _twilioConsentClientForTest({
      uuidFactory: uuids(),
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ items: [{ correlation_id: "1".repeat(32), error_code: 0 }] }),
      }),
    });
    const result = await client({ phone: PHONE, consentAt: CONSENT_AT }, { env: env() });
    assert.equal(result.reason, TWILIO_CONSENT_REASON.MALFORMED_RESPONSE);
  });

  test("HTTP/provider exceptions never become confirmed consent", async () => {
    const rejected = _twilioConsentClientForTest({
      uuidFactory: uuids(),
      fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
    });
    assert.equal(
      (await rejected({ phone: PHONE, consentAt: CONSENT_AT }, { env: env() })).reason,
      TWILIO_CONSENT_REASON.HTTP_REJECTED,
    );

    const failed = _twilioConsentClientForTest({
      uuidFactory: uuids(),
      fetchImpl: async () => { throw new Error("raw provider detail with PII"); },
    });
    const result = await failed({ phone: PHONE, consentAt: CONSENT_AT }, { env: env() });
    assert.equal(result.reason, TWILIO_CONSENT_REASON.REQUEST_FAILED);
    assert.ok(!JSON.stringify(result).includes("raw provider detail"));
  });
});
