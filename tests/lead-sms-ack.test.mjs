import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEAD_SMS_ACK_REASON,
  buildLeadSmsAcknowledgement,
  leadSmsAckLogShape,
  _leadSmsAckForTest,
} from "../api/_lib/lead-sms-ack.mjs";
import { SMS_STATUS } from "../api/_lib/sms-sender.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADDRESS = "123 Louisiana Ave, Perrysburg, OH 43551";
const PHONE = "(419) 555-0000";
const EMAIL = "sam@example.com";
const SUBMISSION = "csv_0123456789abcdef01234567";
const APPROVED_COPY =
  "Crystal Sells Toledo: Thanks for your real estate inquiry about your property. " +
  "I'll follow up with the information you requested and help with the next step. " +
  "Reply STOP to opt out.";

function payload(overrides = {}) {
  const base = {
    lead: {
      form_type: "home_value",
      first_name: "Sam",
      last_name: "Rivera",
      email: EMAIL,
      phone: PHONE,
      property_address: ADDRESS,
      sms_consent: true,
    },
    meta: { submission_id: SUBMISSION },
    consent: {
      durable: true,
      submission_id: SUBMISSION,
      form_type: "home_value",
      sms: { granted: true, phone: PHONE },
    },
  };
  return {
    ...base,
    ...overrides,
    lead: { ...base.lead, ...(overrides.lead || {}) },
    meta: { ...base.meta, ...(overrides.meta || {}) },
    consent: overrides.consent === null
      ? null
      : {
          ...base.consent,
          ...(overrides.consent || {}),
          sms: { ...base.consent.sms, ...(overrides.consent?.sms || {}) },
        },
  };
}

function harness(result = { status: SMS_STATUS.ACCEPTED, message_sid: "SM" + "d".repeat(32) }) {
  const calls = [];
  const send = _leadSmsAckForTest({
    sender: async (message, options) => {
      calls.push({ message, options });
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return { send, calls };
}

describe("Gate 9 seller acknowledgement", () => {
  test("uses a fixed A2P-aligned acknowledgement body", () => {
    assert.equal(buildLeadSmsAcknowledgement(), APPROVED_COPY);
  });

  test("a fresh durable /home-value SMS grant invokes the sender exactly once", async () => {
    const { send, calls } = harness();
    const result = await send(payload(), { env: { OUTBOUND_SMS_ENABLED: "true" } });
    assert.equal(result.status, SMS_STATUS.ACCEPTED);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].message, {
      email: EMAIL,
      phone: PHONE,
      body: APPROVED_COPY,
    });
    assert.equal(calls[0].options.env.OUTBOUND_SMS_ENABLED, "true");
  });

  test("malformed options fail shut instead of rejecting before the function body", async () => {
    for (const options of [null, [], "bad", { env: null }, { env: [] }]) {
      const { send, calls } = harness();
      const result = await send(payload(), options);
      assert.deepEqual(result, {
        status: SMS_STATUS.NOT_SENT,
        reason: LEAD_SMS_ACK_REASON.MALFORMED_CALL,
      });
      assert.equal(calls.length, 0);
    }
  });

  test("malformed payloads fail shut without reaching the sender", async () => {
    for (const bad of [null, [], "bad", {}, { lead: {}, meta: null }]) {
      const { send, calls } = harness();
      const result = await send(bad);
      assert.deepEqual(result, {
        status: SMS_STATUS.NOT_SENT,
        reason: LEAD_SMS_ACK_REASON.MALFORMED_PAYLOAD,
      });
      assert.equal(calls.length, 0);
    }
  });

  test("visitor-controlled property text cannot become SMS body content", async () => {
    const injected = "123 Main St, Toledo, OH 43604 BUY CRYPTO NOW https://example.invalid";
    const { send, calls } = harness();
    const result = await send(payload({ lead: { property_address: injected } }));
    assert.equal(result.status, SMS_STATUS.ACCEPTED);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message.body, APPROVED_COPY);
    assert.ok(!calls[0].message.body.includes("BUY CRYPTO"));
    assert.ok(!calls[0].message.body.includes(injected));
  });

  test("an unticked current submission cannot ride an older contact grant", async () => {
    const { send, calls } = harness();
    const result = await send(payload({
      lead: { sms_consent: false },
      /* Deliberately leave the evidence-looking object otherwise granted: the
         current visitor choice alone must be sufficient to stop the path. */
    }));
    assert.deepEqual(result, {
      status: SMS_STATUS.NOT_SENT,
      reason: LEAD_SMS_ACK_REASON.NO_FRESH_CONSENT,
    });
    assert.equal(calls.length, 0);
  });

  test("server consent evidence must also record the current grant", async () => {
    const { send, calls } = harness();
    const result = await send(payload({ consent: { sms: { granted: false } } }));
    assert.equal(result.reason, LEAD_SMS_ACK_REASON.NO_FRESH_CONSENT);
    assert.equal(calls.length, 0);
  });

  test("unconfirmed durable evidence never reaches the sender", async () => {
    const { send, calls } = harness();
    const result = await send(payload({ consent: { durable: false } }));
    assert.deepEqual(result, {
      status: SMS_STATUS.NOT_SENT,
      reason: LEAD_SMS_ACK_REASON.CONSENT_NOT_DURABLE,
    });
    assert.equal(calls.length, 0);
  });

  test("only the seller /home-value form is eligible", async () => {
    const { send, calls } = harness();
    const result = await send(payload({
      lead: { form_type: "contact", property_address: "" },
      consent: { form_type: "contact" },
    }));
    assert.equal(result.reason, LEAD_SMS_ACK_REASON.FORM_NOT_ELIGIBLE);
    assert.equal(calls.length, 0);
  });

  test("evidence must bind to this exact submission and target", async () => {
    for (const bad of [
      payload({ consent: { submission_id: "csv_other" } }),
      payload({ consent: { sms: { phone: "(419) 555-9999" } } }),
      payload({ meta: { submission_id: "csv_different" } }),
    ]) {
      const { send, calls } = harness();
      const result = await send(bad);
      assert.equal(result.reason, LEAD_SMS_ACK_REASON.EVIDENCE_MISMATCH);
      assert.equal(calls.length, 0);
    }
  });

  test("Gate 8 / provider denial is propagated without a retry", async () => {
    const denied = { status: SMS_STATUS.NOT_SENT, reason: "NOT_AUTHORIZED" };
    const { send, calls } = harness(denied);
    assert.deepEqual(await send(payload()), denied);
    assert.equal(calls.length, 1);
  });

  test("an unconfirmed provider result is propagated without a retry", async () => {
    const unknown = { status: SMS_STATUS.UNKNOWN, reason: "TWILIO_SEND_UNCONFIRMED" };
    const { send, calls } = harness(unknown);
    assert.deepEqual(await send(payload()), unknown);
    assert.equal(calls.length, 1);
  });

  test("an unexpected sender rejection is contained and does not leak its text", async () => {
    const marker = "consumer@example.com +14195550000 raw provider response";
    const { send, calls } = harness(new Error(marker));
    const result = await send(payload());
    assert.deepEqual(result, {
      status: SMS_STATUS.NOT_SENT,
      reason: LEAD_SMS_ACK_REASON.UNEXPECTED_FAILURE,
    });
    assert.equal(calls.length, 1);
    assert.ok(!JSON.stringify(result).includes(marker));
  });

  test("the acknowledgement log shape carries status tokens, never message PII", () => {
    const shaped = leadSmsAckLogShape({
      status: SMS_STATUS.ACCEPTED,
      message_sid: "SM" + "a".repeat(32),
      phone: PHONE,
      email: EMAIL,
      body: APPROVED_COPY,
    });
    assert.deepEqual(Object.keys(shaped).sort(), ["sms_message_sid", "sms_status"]);
    const text = JSON.stringify(shaped);
    assert.ok(!text.includes(PHONE));
    assert.ok(!text.includes(EMAIL));
    assert.ok(!text.includes(ADDRESS));
  });

  test("lead delivery is proven before acknowledgements and both courtesies are settled", () => {
    const source = readFileSync(join(ROOT, "api/lead.js"), "utf8");
    const delivered = source.indexOf("const result = await createLead(payload)");
    const sms = source.indexOf("sendLeadSmsAcknowledgement(payload)");
    const settled = source.indexOf("Promise.allSettled([emailAckTask, smsAckTask])");
    const success = source.indexOf("return send(req, res, 200, { ok: true, submission_id: sid })");
    assert.ok(delivered >= 0 && sms > delivered, "SMS acknowledgement moved before HubSpot delivery");
    assert.ok(settled > sms, "acknowledgement tasks are not awaited through allSettled");
    assert.ok(success > settled, "the 200 response is sent before courtesy tasks settle");
  });

  test("the production reachability guard names one closed lead -> ack -> sender path", () => {
    const source = readFileSync(join(ROOT, "tools/check-sms-sender.mjs"), "utf8");
    assert.match(source, /ACK_REL = "api\/_lib\/lead-sms-ack\.mjs"/);
    assert.match(source, /LEAD_REL = "api\/lead\.js"/);
    assert.match(source, /only .*ACK_REL.*outbound transport/i);
    assert.match(source, /only .*LEAD_REL.*automatic acknowledgement/i);
  });
});
