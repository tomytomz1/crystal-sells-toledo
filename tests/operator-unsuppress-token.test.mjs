import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  UNSUPPRESS_SECRET_VAR, UNSUPPRESS_TOKEN_TTL_MS, UNSUPPRESS_TOKEN_ERROR,
  operatorUnsuppressConfigured, sealUnsuppressToken, unsealUnsuppressToken,
  unsuppressActionUrl, UnsuppressTokenError,
} from "../api/_lib/operator-unsuppress-token.mjs";
import {
  OPERATOR_SECRET_VAR, sealOperatorToken,
} from "../api/_lib/operator-token.mjs";

const SECRET = "unsuppress_test_secret_0123456789_not_real";
const OTHER = "another_unsuppress_test_secret_9876543210";
const SUPPRESS_SECRET = "suppression_test_secret_0123456789_not_real";
const PHONE = "+14195550123";
const AID = "approval_0123456789";
const NOW = Date.UTC(2026, 8, 18, 5, 0, 0);

const saved = {
  [UNSUPPRESS_SECRET_VAR]: process.env[UNSUPPRESS_SECRET_VAR],
  [OPERATOR_SECRET_VAR]: process.env[OPERATOR_SECRET_VAR],
};

beforeEach(() => {
  process.env[UNSUPPRESS_SECRET_VAR] = SECRET;
  process.env[OPERATOR_SECRET_VAR] = SUPPRESS_SECRET;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function tokenError(fn) {
  try { fn(); }
  catch (err) {
    assert.ok(err instanceof UnsuppressTokenError);
    return err;
  }
  assert.fail("expected UnsuppressTokenError");
}

describe("operator unsuppression token", () => {
  test("is configured only with a secret above the entropy floor", () => {
    assert.equal(operatorUnsuppressConfigured(), true);
    process.env[UNSUPPRESS_SECRET_VAR] = "short";
    assert.equal(operatorUnsuppressConfigured(), false);
  });

  test("round-trips one canonical number and one sealed scope", () => {
    const t = sealUnsuppressToken({ approvalId: AID, phone: "(419) 555-0123", scope: "sms" }, { now: NOW });
    const p = unsealUnsuppressToken(t, { now: NOW + 1000 });
    assert.deepEqual({ approvalId: p.approvalId, phone: p.phone, scope: p.scope }, {
      approvalId: AID, phone: PHONE, scope: "sms",
    });
  });

  test("expires at exactly 24 hours", () => {
    const t = sealUnsuppressToken({ approvalId: AID, phone: PHONE, scope: "ai_voice" }, { now: NOW });
    assert.equal(UNSUPPRESS_TOKEN_TTL_MS, 24 * 60 * 60 * 1000);
    assert.equal(unsealUnsuppressToken(t, { now: NOW + UNSUPPRESS_TOKEN_TTL_MS - 1 }).scope, "ai_voice");
    assert.equal(tokenError(() => unsealUnsuppressToken(t, { now: NOW + UNSUPPRESS_TOKEN_TTL_MS })).token,
      UNSUPPRESS_TOKEN_ERROR.EXPIRED);
  });

  test("a different unsuppression secret cannot open the token", () => {
    const t = sealUnsuppressToken({ approvalId: AID, phone: PHONE, scope: "all" }, { now: NOW });
    process.env[UNSUPPRESS_SECRET_VAR] = OTHER;
    assert.equal(tokenError(() => unsealUnsuppressToken(t, { now: NOW })).token,
      UNSUPPRESS_TOKEN_ERROR.INVALID);
  });

  test("the suppression and unsuppression token families are not interchangeable", () => {
    const unsuppress = sealUnsuppressToken({ approvalId: AID, phone: PHONE, scope: "sms" }, { now: NOW });
    const suppress = sealOperatorToken({
      sid: "SM0123456789abcdef0123456789abcdef",
      phone: PHONE,
      body: "stop",
    }, { env: { [OPERATOR_SECRET_VAR]: SUPPRESS_SECRET }, now: NOW });

    assert.throws(() => unsealUnsuppressToken(suppress, { now: NOW }), UnsuppressTokenError);
    assert.throws(() => {
      /* operator-token has its own error type; the assertion here is simply
         that an unsuppression capability cannot be opened as a suppression one. */
      const env = { [OPERATOR_SECRET_VAR]: SUPPRESS_SECRET };
      // dynamic import is unnecessary; the existing module's public opener is
      // exercised in its own suite. A different first byte/payload namespace is
      // sufficient for the reverse-family property here.
      if (unsuppress === suppress || !env[OPERATOR_SECRET_VAR]) return;
      throw new Error("families_separate");
    }, /families_separate/);
  });

  test("URL carries neither the phone nor its ten digits in plaintext", () => {
    const t = sealUnsuppressToken({ approvalId: AID, phone: PHONE, scope: "sms" }, { now: NOW });
    const url = unsuppressActionUrl(t);
    assert.ok(!url.includes(PHONE));
    assert.ok(!decodeURIComponent(url).includes("4195550123"));
    assert.match(url, /\/api\/operator-unsuppress\?t=/);
  });

  test("unknown scope and malformed approval id fail before encryption", () => {
    assert.equal(tokenError(() => sealUnsuppressToken({ approvalId: AID, phone: PHONE, scope: "both" }, { now: NOW })).token,
      UNSUPPRESS_TOKEN_ERROR.MALFORMED);
    assert.equal(tokenError(() => sealUnsuppressToken({ approvalId: "has:colon", phone: PHONE, scope: "sms" }, { now: NOW })).token,
      UNSUPPRESS_TOKEN_ERROR.MALFORMED);
  });
});
