import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  OPERATOR_LEDGER_URL_VAR, operatorLedgerConfigured,
  getActiveBlocks, getSuppressionLanes, appendOperatorUnsuppression,
  _setOperatorLedgerExecutor, _resetOperatorLedgerExecutor,
} from "../api/_lib/operator-ledger.mjs";
import {
  _setExecutor, _resetExecutor, buildSuppressionEvent,
  EVENT_TYPE, SOURCE_OPERATOR,
} from "../api/_lib/consent-ledger.mjs";
import {
  suppressionFromLedgerRows, canSendSms, canPlaceAutomatedVoiceCall,
} from "../api/_lib/permission.mjs";
import {
  fromHubSpotConsentProperties, toHubSpotUnsuppressionProperties,
  SMS_STATE_PROPERTIES as SMS, AI_VOICE_STATE_PROPERTIES as VOICE,
  SUPPRESSION_PROPERTIES as S, REOPTIN_PROPERTIES as R,
} from "../api/_lib/hubspot-consent-state.mjs";
import { PERMISSION_STATE } from "../api/_lib/consent.mjs";

const URL = "postgres://operator:not-real@ledger.example/neondb";
const PHONE = "+14195550123";
const savedUrl = process.env[OPERATOR_LEDGER_URL_VAR];

beforeEach(() => {
  process.env[OPERATOR_LEDGER_URL_VAR] = URL;
});

afterEach(() => {
  _resetOperatorLedgerExecutor();
  _resetExecutor();
  if (savedUrl === undefined) delete process.env[OPERATOR_LEDGER_URL_VAR];
  else process.env[OPERATOR_LEDGER_URL_VAR] = savedUrl;
});

const iso = (day) => `2026-09-${String(day).padStart(2, "0")}T12:00:00.000Z`;
const active = ({ channel = "sms", key = "twilio:SM0123456789abcdef0123456789abcdef:sms:suppressed", type = "suppressed" } = {}) => ({
  channel,
  dedupe_key: key,
  event_type: type,
  reason_code: "stop_keyword",
  source: "twilio",
  source_event_id: "SM0123456789abcdef0123456789abcdef",
  occurred_at: iso(17),
  recorded_at: iso(17),
});

describe("operator ledger client", () => {
  test("configuration is the dedicated operator credential, not the website credential", () => {
    assert.equal(operatorLedgerConfigured(), true);
    delete process.env[OPERATOR_LEDGER_URL_VAR];
    assert.equal(operatorLedgerConfigured(), false);
  });

  test("active-block lookup calls only the db/003 function and validates rows", async () => {
    const calls = [];
    _setOperatorLedgerExecutor(async (text, params, opts) => {
      calls.push({ text, params, opts });
      return [active()];
    });
    const rows = await getActiveBlocks(PHONE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].channel, "sms");
    assert.match(calls[0].text, /public\.get_active_blocks\(\$1\)/);
    assert.ok(!calls[0].text.includes("communication_consent_events"));
    assert.deepEqual(calls[0].params, [PHONE]);
    assert.equal(calls[0].opts.url, URL);
  });

  test("suppression-state lookup reads lanes from db/003", async () => {
    _setOperatorLedgerExecutor(async () => [
      { channel: "all", suppressed_at: iso(15) },
      { channel: "sms", suppressed_at: iso(16) },
    ]);
    const rows = await getSuppressionLanes(PHONE);
    assert.deepEqual(rows.map((r) => r.channel), ["all", "sms"]);
  });

  test("malformed provider rows fail closed", async () => {
    _setOperatorLedgerExecutor(async () => [{ channel: "mystery", suppressed_at: iso(15) }]);
    await assert.rejects(() => getSuppressionLanes(PHONE), /OPERATOR_LEDGER_MALFORMED_RESPONSE/);
  });

  test("operator append uses the dedicated operator URL while retaining canonical ledger SQL", async () => {
    const calls = [];
    _setExecutor(async (text, params, opts) => {
      calls.push({ text, params, opts });
      return { rowCount: 1, rows: [] };
    });
    const event = buildSuppressionEvent({
      occurredAt: iso(18),
      channel: "sms",
      eventType: EVENT_TYPE.UNSUPPRESSED,
      phone: PHONE,
      source: SOURCE_OPERATOR,
      sourceEventId: "approval_0123456789",
      reasonCode: "consumer_request",
      metadata: { invalidates: [] },
    });
    const result = await appendOperatorUnsuppression(event);
    assert.equal(result.rowsAffected, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.url, URL);
    assert.match(calls[0].text, /INSERT INTO communication_consent_events/);
  });
});

describe("durable lane fold", () => {
  test("all dominates both effective communication channels", () => {
    const f = suppressionFromLedgerRows([{ channel: "all" }]);
    assert.deepEqual(f.lanes, { sms: false, ai_voice: false, all: true });
    assert.deepEqual(f.effective, { sms: true, ai_voice: true });
  });

  test("an independent sms lane affects only sms", () => {
    const f = suppressionFromLedgerRows([{ channel: "sms" }]);
    assert.deepEqual(f.effective, { sms: true, ai_voice: false });
  });

  test("an unknown row cannot become an unblocked answer", () => {
    assert.throws(() => suppressionFromLedgerRows([{ channel: "unknown" }]), /SUPPRESSION_ROWS_MALFORMED/);
  });
});

function fullProps() {
  return {
    [SMS.status]: "granted",
    [SMS.at]: iso(1),
    [SMS.phone]: PHONE,
    [SMS.source]: "website",
    [SMS.page]: "/home-value",
    [SMS.version]: "CST_SMS_CONSENT_2026_09_V1",
    [VOICE.status]: "granted",
    [VOICE.at]: iso(1),
    [VOICE.phone]: PHONE,
    [VOICE.source]: "website",
    [VOICE.page]: "/home-value",
    [VOICE.version]: "CST_AI_VOICE_CONSENT_2026_09_V1",
    [S.smsSuppressed]: "true",
    [S.smsSuppressedAt]: iso(10),
    [S.smsSuppressionReason]: "stop_keyword",
    [S.doNotCall]: "false",
    [S.doNotCallAt]: "",
    [S.doNotCallReason]: "",
    [S.doNotContact]: "false",
    [S.doNotContactAt]: "",
    [S.doNotContactReason]: "",
    [R.at]: iso(11),
    [R.channel]: "sms",
  };
}

function applyPatch(base, patch) {
  return { ...base, ...patch };
}

describe("HubSpot unsuppression current-state projection", () => {
  test("a durable SMS unblock resets permission and clears all five grant artefacts", () => {
    const current = fromHubSpotConsentProperties(fullProps(), "TEST");
    const before = suppressionFromLedgerRows([{ channel: "sms" }]);
    const after = suppressionFromLedgerRows([]);
    const patch = toHubSpotUnsuppressionProperties({ current, before, after });

    assert.equal(patch[S.smsSuppressed], "false");
    assert.equal(patch[S.smsSuppressedAt], "");
    assert.equal(patch[S.smsSuppressionReason], "");
    assert.equal(patch[SMS.status], PERMISSION_STATE.NEVER_GRANTED);
    for (const p of [SMS.at, SMS.phone, SMS.source, SMS.page, SMS.version])
      assert.equal(patch[p], "", `${p} was not cleared`);
    assert.equal(Object.hasOwn(patch, R.at), false);
    assert.equal(Object.hasOwn(patch, R.channel), false);

    const roundTrip = fromHubSpotConsentProperties(applyPatch(fullProps(), patch), "ROUNDTRIP");
    assert.equal(roundTrip.sms.status, PERMISSION_STATE.NEVER_GRANTED);
    assert.equal(roundTrip.sms.consent_at, "");
    assert.equal(roundTrip.sms.consent_phone, "");
    assert.equal(canSendSms(roundTrip, PHONE).reason, "NO_CONSENT");
  });

  test("clearing an SMS row while a global durable block survives writes nothing for SMS", () => {
    const current = fromHubSpotConsentProperties(fullProps(), "TEST");
    const before = suppressionFromLedgerRows([{ channel: "all" }, { channel: "sms" }]);
    const after = suppressionFromLedgerRows([{ channel: "all" }]);
    const patch = toHubSpotUnsuppressionProperties({ current, before, after });
    assert.deepEqual(patch, {});
  });

  test("clearing global while an independent SMS block survives clears voice but not SMS", () => {
    const p = fullProps();
    p[S.doNotContact] = "true";
    p[S.doNotContactAt] = iso(9);
    p[S.doNotContactReason] = "consumer_request";
    p[S.doNotCall] = "true";
    p[S.doNotCallAt] = iso(9);
    p[S.doNotCallReason] = "voice_request";
    const current = fromHubSpotConsentProperties(p, "TEST");
    const before = suppressionFromLedgerRows([{ channel: "all" }, { channel: "sms" }]);
    const after = suppressionFromLedgerRows([{ channel: "sms" }]);
    const patch = toHubSpotUnsuppressionProperties({ current, before, after });

    assert.equal(patch[S.doNotContact], "false");
    assert.equal(patch[S.doNotCall], "false");
    assert.equal(patch[VOICE.status], PERMISSION_STATE.NEVER_GRANTED);
    assert.equal(Object.hasOwn(patch, SMS.status), false);
    assert.equal(Object.hasOwn(patch, S.smsSuppressed), false);

    const roundTrip = fromHubSpotConsentProperties(applyPatch(p, patch), "ROUNDTRIP");
    assert.equal(canSendSms(roundTrip, PHONE).reason, "SUPPRESSED");
    assert.equal(canPlaceAutomatedVoiceCall(roundTrip, PHONE).reason, "NO_CONSENT");
  });

  test("projection never emits a granted value", () => {
    const current = fromHubSpotConsentProperties(fullProps(), "TEST");
    const patch = toHubSpotUnsuppressionProperties({
      current,
      before: suppressionFromLedgerRows([{ channel: "sms" }]),
      after: suppressionFromLedgerRows([]),
    });
    assert.ok(!Object.values(patch).includes(PERMISSION_STATE.GRANTED));
  });
});
