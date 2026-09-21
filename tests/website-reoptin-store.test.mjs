import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  _websiteReoptinStoreForTest,
  providerEventId,
  WEBSITE_REOPTIN_STORE_ERROR,
} from "../api/_lib/website-reoptin-store.mjs";

const KEY = "website:csv_abc:sms:consent_selected";
const PHONE = "+14195550000";
const ENV = { CONSENT_LEDGER_REOPTIN_URL: "postgresql://example.invalid/db" };
const provider = {
  service_correlation_id: "1".repeat(32),
  sender_correlation_id: "2".repeat(32),
  service_sid: "MG" + "a".repeat(32),
};

describe("website re-opt-in durable store", () => {
  test("provider event id is deterministic and colon-free", () => {
    const a = providerEventId(KEY);
    const b = providerEventId(KEY);
    assert.equal(a, b);
    assert.match(a, /^consentapi_[0-9a-f]{32}$/);
    assert.ok(!a.includes(":"));
  });

  test("calls only the narrow db/005 completion function", async () => {
    const calls = [];
    const store = _websiteReoptinStoreForTest(async (text, params) => {
      calls.push({ text, params });
      return [{ rows_inserted: 1 }];
    });
    const result = await store({
      phone: PHONE,
      consent: { dedupeKey: KEY },
      provider,
    }, { env: ENV });
    assert.equal(result.rowsAffected, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /^SELECT public\.complete_website_sms_reoptin\(/);
    assert.equal(calls[0].params[0], PHONE);
    assert.equal(calls[0].params[1], KEY);
    assert.match(calls[0].params[2], /^consentapi_/);
    const metadata = JSON.parse(calls[0].params[3]);
    assert.equal(metadata.provider, "twilio_consent_api");
    assert.equal(metadata.service_correlation_id, provider.service_correlation_id);
  });

  test("a replay rowCount of zero remains distinguishable from a new append", async () => {
    const store = _websiteReoptinStoreForTest(async () => [{ rows_inserted: 0 }]);
    const result = await store({ phone: PHONE, consent: { dedupeKey: KEY }, provider }, { env: ENV });
    assert.equal(result.rowsAffected, 0);
  });

  test("missing credential and malformed function result fail closed", async () => {
    const store = _websiteReoptinStoreForTest(async () => [{ rows_inserted: 1 }]);
    await assert.rejects(
      () => store({ phone: PHONE, consent: { dedupeKey: KEY }, provider }, { env: {} }),
      (err) => err.token === WEBSITE_REOPTIN_STORE_ERROR.NOT_CONFIGURED,
    );

    const bad = _websiteReoptinStoreForTest(async () => [{ rows_inserted: 2 }]);
    await assert.rejects(
      () => bad({ phone: PHONE, consent: { dedupeKey: KEY }, provider }, { env: ENV }),
      (err) => err.token === WEBSITE_REOPTIN_STORE_ERROR.MALFORMED_RESPONSE,
    );
  });
});
