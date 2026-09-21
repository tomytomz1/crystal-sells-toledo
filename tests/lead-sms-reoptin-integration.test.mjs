import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  _leadSmsAckForTest,
  LEAD_SMS_ACK_REASON,
} from "../api/_lib/lead-sms-ack.mjs";
import { SMS_STATUS } from "../api/_lib/sms-sender.mjs";
import { WEBSITE_REOPTIN_STATUS } from "../api/_lib/website-sms-reoptin.mjs";

const PHONE = "(419) 555-0000";
const EMAIL = "seller@example.com";
const SUBMISSION = "csv_reoptin_abc";

function payload() {
  return {
    lead: {
      form_type: "home_value",
      first_name: "Seller",
      last_name: "Test",
      email: EMAIL,
      phone: PHONE,
      property_address: "123 Main St, Toledo, OH 43604",
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
}

describe("seller acknowledgement automatic re-opt-in integration", () => {
  test("successful reconciliation is completed before the sender is invoked", async () => {
    const order = [];
    const run = _leadSmsAckForTest({
      reoptin: async () => {
        order.push("reoptin");
        return { status: WEBSITE_REOPTIN_STATUS.COMPLETED };
      },
      sender: async () => {
        order.push("sender");
        return { status: SMS_STATUS.ACCEPTED, message_sid: "SM" + "a".repeat(32) };
      },
    });
    const result = await run(payload(), { env: {} });
    assert.equal(result.status, SMS_STATUS.ACCEPTED);
    assert.deepEqual(order, ["reoptin", "sender"]);
  });

  test("failed or blocked reconciliation never reaches the sender", async () => {
    for (const status of [WEBSITE_REOPTIN_STATUS.FAILED, WEBSITE_REOPTIN_STATUS.BLOCKED]) {
      let sends = 0;
      const run = _leadSmsAckForTest({
        reoptin: async () => ({ status }),
        sender: async () => { sends += 1; return { status: SMS_STATUS.ACCEPTED }; },
      });
      const result = await run(payload(), { env: {} });
      assert.deepEqual(result, {
        status: SMS_STATUS.NOT_SENT,
        reason: LEAD_SMS_ACK_REASON.REOPTIN_FAILED,
      });
      assert.equal(sends, 0);
    }
  });

  test("feature-inactive/skipped reconciliation preserves the existing Gate 8 sender path", async () => {
    let sends = 0;
    const run = _leadSmsAckForTest({
      reoptin: async () => ({ status: WEBSITE_REOPTIN_STATUS.SKIPPED }),
      sender: async () => { sends += 1; return { status: SMS_STATUS.NOT_SENT, reason: "DURABLE_SMS_BLOCK" }; },
    });
    const result = await run(payload(), { env: {} });
    assert.equal(sends, 1);
    assert.equal(result.reason, "DURABLE_SMS_BLOCK");
  });
});
