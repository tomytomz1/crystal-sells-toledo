import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  _websiteSmsReoptinForTest,
  WEBSITE_REOPTIN_STATUS,
  WEBSITE_REOPTIN_REASON,
} from "../api/_lib/website-sms-reoptin.mjs";
import { TWILIO_CONSENT_STATUS } from "../api/_lib/twilio-consent.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PHONE = "+14195550000";
const EMAIL = "seller@example.com";
const CONSENT_AT = "2026-09-21T16:05:49.036Z";
const CONSENT_KEY = "website:csv_abc:sms:consent_selected";

const activeEnv = {
  COMMUNICATIONS_CONSENT_ENABLED: "true",
  SMS_REOPTIN_ENABLED: "true",
  CONSENT_LEDGER_REOPTIN_URL: "postgresql://example.invalid/db",
};

function readiness(overrides = {}) {
  const base = {
    phone: PHONE,
    blocked: {
      sms: "2026-09-21T13:35:54.575Z",
      ai_voice: null,
      all: null,
    },
    consent: {
      dedupeKey: CONSENT_KEY,
      occurredAt: CONSENT_AT,
      version: "CST_SMS_CONSENT_2026_09_V1",
      formType: "home_value",
      pagePath: "/home-value",
      submissionId: "csv_abc",
    },
  };
  return {
    ...base,
    ...overrides,
    blocked: { ...base.blocked, ...(overrides.blocked || {}) },
    consent: overrides.consent === null ? null : { ...base.consent, ...(overrides.consent || {}) },
  };
}

function deps(overrides = {}) {
  const calls = { provider: 0, store: 0, durable: 0, lookup: 0, write: 0 };
  const value = {
    readinessLookup: async () => readiness(),
    providerUpsert: async () => {
      calls.provider += 1;
      return {
        status: TWILIO_CONSENT_STATUS.CONFIRMED,
        service_correlation_id: "1".repeat(32),
        sender_correlation_id: "2".repeat(32),
        service_sid: "MG" + "a".repeat(32),
      };
    },
    storeComplete: async () => { calls.store += 1; return { rowsAffected: 1 }; },
    durableLookup: async () => { calls.durable += 1; return { status: "ok", channels: [] }; },
    contactLookup: async () => { calls.lookup += 1; return { id: "123" }; },
    contactWrite: async () => { calls.write += 1; return { written: true }; },
    ...overrides,
  };
  return { calls, value };
}

describe("automatic website SMS re-opt-in", () => {
  test("fresh post-STOP website consent completes provider, durable and HubSpot reconciliation", async () => {
    const h = deps();
    const run = _websiteSmsReoptinForTest(h.value);
    const result = await run({ email: EMAIL, phone: PHONE }, { env: activeEnv });
    assert.equal(result.status, WEBSITE_REOPTIN_STATUS.COMPLETED);
    assert.equal(h.calls.provider, 1);
    assert.equal(h.calls.store, 1);
    assert.equal(h.calls.durable, 1);
    assert.equal(h.calls.lookup, 1);
    assert.equal(h.calls.write, 1);
  });

  test("a global do-not-contact can never reach the provider or clearance", async () => {
    const h = deps({
      readinessLookup: async () => readiness({ blocked: { all: "2026-09-21T14:00:00Z" } }),
    });
    const result = await _websiteSmsReoptinForTest(h.value)(
      { email: EMAIL, phone: PHONE }, { env: activeEnv });
    assert.equal(result.status, WEBSITE_REOPTIN_STATUS.BLOCKED);
    assert.equal(result.reason, WEBSITE_REOPTIN_REASON.GLOBAL_BLOCK);
    assert.equal(h.calls.provider, 0);
    assert.equal(h.calls.store, 0);
  });

  test("no fresh website consent cannot reach provider re-opt-in", async () => {
    const h = deps({ readinessLookup: async () => readiness({ consent: null }) });
    const result = await _websiteSmsReoptinForTest(h.value)(
      { email: EMAIL, phone: PHONE }, { env: activeEnv });
    assert.equal(result.status, WEBSITE_REOPTIN_STATUS.BLOCKED);
    assert.equal(result.reason, WEBSITE_REOPTIN_REASON.NO_FRESH_CONSENT);
    assert.equal(h.calls.provider, 0);
    assert.equal(h.calls.store, 0);
  });

  test("provider partial/failure leaves Neon and HubSpot untouched", async () => {
    const h = deps({
      providerUpsert: async () => {
        h.calls.provider += 1;
        return { status: TWILIO_CONSENT_STATUS.NOT_CONFIRMED, reason: "PARTIAL" };
      },
    });
    const result = await _websiteSmsReoptinForTest(h.value)(
      { email: EMAIL, phone: PHONE }, { env: activeEnv });
    assert.equal(result.status, WEBSITE_REOPTIN_STATUS.FAILED);
    assert.equal(result.reason, WEBSITE_REOPTIN_REASON.PROVIDER_FAILED);
    assert.equal(h.calls.store, 0);
    assert.equal(h.calls.write, 0);
  });

  test("a STOP racing after provider completion prevents the HubSpot clear", async () => {
    const h = deps({ durableLookup: async () => ({ status: "ok", channels: ["sms"] }) });
    const result = await _websiteSmsReoptinForTest(h.value)(
      { email: EMAIL, phone: PHONE }, { env: activeEnv });
    assert.equal(result.status, WEBSITE_REOPTIN_STATUS.FAILED);
    assert.equal(result.reason, WEBSITE_REOPTIN_REASON.STILL_BLOCKED);
    assert.equal(h.calls.write, 0);
  });

  test("a replay with durable lane already clear repairs HubSpot without a second provider call", async () => {
    const h = deps({
      readinessLookup: async () => readiness({ blocked: { sms: null } }),
    });
    const result = await _websiteSmsReoptinForTest(h.value)(
      { email: EMAIL, phone: PHONE }, { env: activeEnv });
    assert.equal(result.status, WEBSITE_REOPTIN_STATUS.COMPLETED);
    assert.equal(result.reason, WEBSITE_REOPTIN_REASON.NOT_BLOCKED);
    assert.equal(h.calls.provider, 0);
    assert.equal(h.calls.store, 0);
    assert.equal(h.calls.lookup, 1);
    assert.equal(h.calls.write, 1);
  });

  test("feature off preserves the old Gate 8 path without provider I/O", async () => {
    const h = deps();
    const result = await _websiteSmsReoptinForTest(h.value)(
      { email: EMAIL, phone: PHONE },
      { env: { ...activeEnv, SMS_REOPTIN_ENABLED: "false" } },
    );
    assert.equal(result.status, WEBSITE_REOPTIN_STATUS.SKIPPED);
    assert.equal(h.calls.provider, 0);
    assert.equal(h.calls.store, 0);
  });

  test("public copy no longer requires a consumer to know or send START", () => {
    const html = readFileSync(join(ROOT, "src/partials/consent-block.html"), "utf8");
    assert.doesNotMatch(html, /Reply\s+<b>START<\/b>/i);
    assert.match(html, /check the text-message box again/i);
    assert.match(html, /fresh consent/i);
  });
});
