/* The outbound SMS sender — Tier 4.
 * =====================================================================
 * This is the first module in the repository that can cause an external
 * messaging side effect. No test here contacts Twilio, HubSpot or Neon:
 * every sender under test is built over injected boundaries by
 * `_senderForTest()`, and the sender's own control flow, validation,
 * ordering, failure classification and result handling are the real
 * ones.
 *
 * THE STATIC GUARDS LIVE IN tests/sms-sender-guards.test.mjs. They are
 * split out so the mutation cases there can run THIS file against a
 * throwaway copy of the tree without recursing into themselves.
 *
 * The cases that matter most are not the happy path:
 *   - does a disabled system stay completely inert;
 *   - can gate 8 be replaced on the exported sendSms (it cannot);
 *   - is the number that was authorized the number that is texted;
 *   - is there exactly ONE create attempt, ever;
 *   - is a provider REFUSAL told apart from an AMBIGUOUS failure, by
 *     identity rather than by fields on whatever was thrown;
 *   - does a malformed call refuse instead of throwing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import VersionModule from "twilio/lib/base/Version.js";
import RestExceptionModule from "twilio/lib/base/RestException.js";
import TwilioServiceExceptionModule from "twilio/lib/base/TwilioServiceException.js";

import {
  OUTBOUND_SMS_FLAG,
  TWILIO_ACCOUNT_SID_VAR,
  TWILIO_API_KEY_SID_VAR,
  TWILIO_API_KEY_SECRET_VAR,
  TWILIO_MESSAGING_SERVICE_SID_VAR,
  MAX_SMS_BODY_CHARS,
  SMS_STATUS,
  SMS_REASON,
  RestException,
  TwilioServiceException,
  outboundSmsEnabled,
  outboundConfig,
  providerRejection,
  sendSms,
  smsSendLogShape,
  _senderForTest,
} from "../api/_lib/sms-sender.mjs";
import * as sender from "../api/_lib/sms-sender.mjs";

const hex32 = (c) => String(c).repeat(32);
const ACCOUNT = "AC" + hex32("a");
const KEY_SID = "SK" + hex32("b");
const KEY_SECRET = "s3cr3t-value-never-logged";
const SERVICE = "MG" + hex32("c");
const MESSAGE_SID = "SM" + hex32("d");

const EMAIL = "lead@example.test";
const PHONE = "(419) 555-1234";
const E164 = "+14195551234";
const BODY = "Crystal Sells Toledo: thanks for your inquiry. Reply STOP to opt out.";

const ON = {
  [OUTBOUND_SMS_FLAG]: "true",
  [TWILIO_ACCOUNT_SID_VAR]: ACCOUNT,
  [TWILIO_API_KEY_SID_VAR]: KEY_SID,
  [TWILIO_API_KEY_SECRET_VAR]: KEY_SECRET,
  [TWILIO_MESSAGING_SERVICE_SID_VAR]: SERVICE,
};

/**
 * A sender over injected boundaries, plus everything it observed in
 * order. Each call builds its OWN sender, so nothing leaks between
 * tests and no reset hook is needed.
 */
function harness(opts = {}) {
  const { allowed = true, create, authorizeThrows = false, clientThrows = false } = opts;
  /* `decision` is looked up by PRESENCE, not by value: `{ decision:
     undefined }` is a real case (gate 8 returning nothing) and must not
     fall through to the permissive default. */
  const hasDecision = Object.prototype.hasOwnProperty.call(opts, "decision");
  const order = [];
  const creates = [];
  const seen = [];
  const send = _senderForTest({
    authorize: async (args) => {
      order.push("authorize");
      seen.push(args);
      if (authorizeThrows) throw new Error(`gate 8 exploded for ${E164}`);
      if (hasDecision) return opts.decision;
      return { allowed, reason: allowed ? "ALLOWED" : "SUPPRESSED" };
    },
    clientFactory: () => {
      order.push("client");
      if (clientThrows) throw new Error(`bad credentials ${KEY_SECRET}`);
      return {
        messages: {
          create: async (opts) => {
            order.push("create");
            creates.push(opts);
            if (typeof create === "function") return create(opts);
            return { sid: MESSAGE_SID };
          },
        },
      };
    },
  });
  return { send, order, creates, seen };
}

/* The SDK's OWN thrower, driven directly. Building the error by hand
   would only prove this file agrees with itself; this way the class and
   the fields are chosen by node_modules/twilio, at the lowest real
   boundary reachable without a network call. */
const Version = typeof VersionModule === "function" ? VersionModule : VersionModule.default;
function sdkError(statusCode, body) {
  try {
    Version.prototype.throwException.call({}, { statusCode, body });
  } catch (err) {
    return err;
  }
  throw new Error("the SDK's throwException() did not throw — this test proves nothing");
}
const legacyBody = (code) => ({ message: "Failed", code });
const rfc9457Body = (status, code) =>
  ({ type: "https://www.twilio.com/docs/errors/" + code, title: "Failed", status, code });

describe("the outbound SMS sender", () => {
  /* ---- the provider exception classes are the SDK's own ------------- */

  describe("the SDK contract this module reads", () => {
    test("the interop unwrap produced the classes the SDK actually throws", () => {
      assert.equal(typeof RestException, "function", "RestException did not unwrap to a class");
      assert.equal(typeof TwilioServiceException, "function", "TwilioServiceException did not unwrap to a class");
      assert.equal(RestException,
        typeof RestExceptionModule === "function" ? RestExceptionModule : RestExceptionModule.default);
      assert.equal(TwilioServiceException,
        typeof TwilioServiceExceptionModule === "function" ? TwilioServiceExceptionModule : TwilioServiceExceptionModule.default);

      const legacy = sdkError(400, legacyBody(21211));
      assert.ok(legacy instanceof RestException,
        "the SDK's legacy error is not an instance of the class this module imports");
      assert.equal(legacy.status, 400);

      const rfc = sdkError(401, rfc9457Body(401, 20003));
      assert.ok(rfc instanceof TwilioServiceException,
        "the SDK's RFC-9457 error is not an instance of the class this module imports");
      assert.equal(rfc.status, 401);
    });
  });

  /* ---- gate 8 cannot be replaced on the production sender ----------- */

  describe("gate 8 is not replaceable", () => {
    test("the module exports NO mutator", () => {
      for (const name of Object.keys(sender))
        assert.ok(!/^_set/.test(name), `the module exports a mutator: ${name}`);
      assert.equal(sender._setAuthorizer, undefined, "the bypass seam is back");
      assert.equal(sender._setClientFactory, undefined, "the client seam is back");
    });

    test("building a permissive test sender does NOT affect the exported sendSms", async () => {
      const creates = [];
      const permissive = _senderForTest({
        authorize: async () => ({ allowed: true }),
        clientFactory: () => ({ messages: { create: async (o) => { creates.push(o); return { sid: MESSAGE_SID }; } } }),
      });
      const viaTest = await permissive({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.equal(viaTest.status, SMS_STATUS.ACCEPTED, "the test sender itself did not work");
      assert.equal(creates.length, 1);

      /* THE REAL ONE, over the REAL gate 8. The env carries only the
         Twilio variables: COMMUNICATIONS_CONSENT_ENABLED is absent, so
         gate 8 decides locally and denies WITHOUT any network I/O -
         see api/_lib/send-permission.mjs, which short-circuits to the
         resolver when the consent feature is off. */
      const real = await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env: { ...ON } });
      assert.deepEqual(real, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.NOT_AUTHORIZED },
        "the exported sendSms did not reach the real gate 8 and refuse");
      assert.equal(creates.length, 1, "the exported sendSms used the test double's client");
    });

    test("two independent test senders do not share boundaries", async () => {
      const a = harness({ allowed: true });
      const b = harness({ allowed: false });
      const ra = await a.send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      const rb = await b.send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.equal(ra.status, SMS_STATUS.ACCEPTED);
      assert.deepEqual(rb, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.NOT_AUTHORIZED });
      assert.equal(a.creates.length, 1);
      assert.equal(b.creates.length, 0);
    });
  });

  /* ---- the call itself --------------------------------------------- */

  describe("a malformed call is a refusal, never an exception", () => {
    const BAD_MESSAGES = [
      ["no argument", undefined],
      ["null", null],
      ["a number", 42],
      ["a string", "send this"],
      ["an array", []],
      ["a boolean", true],
      ["a function", () => {}],
    ];
    for (const [label, bad] of BAD_MESSAGES) {
      test(`sendSms(${label}) refuses and reaches nothing`, async () => {
        const { send, order } = harness();
        const r = await send(bad, { env: ON });
        assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.MALFORMED_CALL },
          `${label} was not refused`);
        assert.deepEqual(order, [], `${label} still did work`);
      });
    }

    test("sendSms() with no arguments at all resolves", async () => {
      const r = await sendSms();
      assert.equal(r.status, SMS_STATUS.NOT_SENT);
      assert.ok(typeof r.reason === "string" && r.reason.length > 0);
    });

    const BAD_OPTIONS = [
      ["null options", null],
      ["numeric options", 42],
      ["string options", "env"],
      ["array options", []],
      ["env: null", { env: null }],
      ["env: a string", { env: "bad" }],
      ["env: a number", { env: 7 }],
      ["env: a function", { env: () => {} }],
    ];
    for (const [label, bad] of BAD_OPTIONS) {
      test(`sendSms(message, ${label}) refuses and reaches nothing`, async () => {
        const { send, order } = harness();
        const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, bad);
        assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.MALFORMED_CALL },
          `${label} was not refused`);
        assert.deepEqual(order, [], `${label} still did work`);
      });
    }

    test("an omitted options object is not malformed — it defaults to process.env", async () => {
      const { send, order } = harness();
      const r = await send({ email: EMAIL, phone: PHONE, body: BODY });
      /* process.env carries no OUTBOUND_SMS_ENABLED in any test run, so
         this is the DISABLED refusal and not a malformed call. */
      assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.DISABLED });
      assert.deepEqual(order, []);
    });

    test("an empty object is a well-formed call with nothing in it", async () => {
      const { send, order } = harness();
      const r = await send({}, { env: ON });
      assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.INVALID_TARGET },
        "an empty message should be refused on its target, not as a malformed call");
      assert.deepEqual(order, []);
    });

    test("a throwing getter on the message is a refusal", async () => {
      const { send, order } = harness();
      const hostile = { email: EMAIL, get phone() { throw new Error(`boom ${E164}`); }, body: BODY };
      const r = await send(hostile, { env: ON });
      assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.MALFORMED_CALL });
      assert.deepEqual(order, []);
    });

    test("a throwing getter on options.env is a refusal", async () => {
      const { send, order } = harness();
      const r = await send({ email: EMAIL, phone: PHONE, body: BODY },
        { get env() { throw new Error("boom"); } });
      assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.MALFORMED_CALL });
      assert.deepEqual(order, []);
    });

    test("a Proxy that throws on every read is a refusal", async () => {
      const { send, order } = harness();
      const hostile = new Proxy({}, { get() { throw new Error("nope"); } });
      const r = await send(hostile, { env: ON });
      assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.MALFORMED_CALL });
      assert.deepEqual(order, []);
    });

    test("an env whose getters throw is DISABLED, not an exception", async () => {
      const { send, order } = harness();
      const hostileEnv = new Proxy({}, { get() { throw new Error("nope"); } });
      const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: hostileEnv });
      assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.DISABLED });
      assert.deepEqual(order, []);
    });

    test("no malformed call ever reveals what was passed", async () => {
      const { send } = harness();
      const secrets = ["hunter2", E164, EMAIL, BODY];
      for (const s of secrets) {
        const r = await send(s, { env: ON });
        assert.ok(!JSON.stringify(r).includes(s), `a refusal echoed the input: ${JSON.stringify(r)}`);
      }
    });
  });

  /* ---- the flag ---------------------------------------------------- */

  describe("disabled", () => {
    test("only the exact string \"true\" enables it", () => {
      for (const v of [undefined, "", "1", "yes", "TRUE", "True", "true ", " true", "on"])
        assert.equal(outboundSmsEnabled({ [OUTBOUND_SMS_FLAG]: v }), false,
          `${JSON.stringify(v)} enabled outbound SMS`);
      assert.equal(outboundSmsEnabled({ [OUTBOUND_SMS_FLAG]: "true" }), true);
    });

    test("the flag OFF reaches NOTHING — no gate 8, no client, no provider", async () => {
      for (const v of [undefined, "", "1", "TRUE", "true "]) {
        const { send, order } = harness();
        const env = { ...ON, [OUTBOUND_SMS_FLAG]: v };
        const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env });
        assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.DISABLED });
        assert.deepEqual(order, [],
          "a disabled sender performed work — gate 8 would have reached HubSpot and Neon");
      }
    });
  });

  /* ---- configuration ----------------------------------------------- */

  describe("configuration", () => {
    test("any missing variable is NOT_CONFIGURED and sends nothing", async () => {
      for (const missing of [TWILIO_ACCOUNT_SID_VAR, TWILIO_API_KEY_SID_VAR,
                             TWILIO_API_KEY_SECRET_VAR, TWILIO_MESSAGING_SERVICE_SID_VAR]) {
        const { send, order } = harness();
        const env = { ...ON, [missing]: "" };
        const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env });
        assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.NOT_CONFIGURED },
          `missing ${missing} did not fail closed`);
        assert.deepEqual(order, [], `missing ${missing} still did work`);
      }
    });

    test("a structurally impossible SID is CONFIG_MALFORMED, not a provider round trip", async () => {
      const cases = [
        [TWILIO_ACCOUNT_SID_VAR, "AC-not-hex"],
        [TWILIO_ACCOUNT_SID_VAR, "SK" + hex32("a")],          /* right shape, wrong prefix */
        [TWILIO_API_KEY_SID_VAR, "AC" + hex32("b")],
        [TWILIO_API_KEY_SID_VAR, "SK" + "b".repeat(31)],
        [TWILIO_MESSAGING_SERVICE_SID_VAR, "PN" + hex32("c")],
        [TWILIO_MESSAGING_SERVICE_SID_VAR, "MG" + "c".repeat(33)],
      ];
      for (const [name, bad] of cases) {
        const { send, order } = harness();
        const r = await send({ email: EMAIL, phone: PHONE, body: BODY },
          { env: { ...ON, [name]: bad } });
        assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.CONFIG_MALFORMED },
          `${name}=${bad} was accepted`);
        assert.deepEqual(order, []);
      }
    });

    test("the API key secret is never shape-checked away or echoed", () => {
      const c = outboundConfig(ON);
      assert.equal(c.ok, true);
      /* A secret has no documented shape, so it is only required to be
         present. It must never appear in a refusal. */
      const refusal = outboundConfig({ ...ON, [TWILIO_API_KEY_SECRET_VAR]: "" });
      assert.deepEqual(refusal, { ok: false, reason: SMS_REASON.NOT_CONFIGURED });
      assert.ok(!JSON.stringify(refusal).includes(KEY_SECRET));
    });

    test("a non-string environment value is not configuration", () => {
      for (const v of [42, true, {}, [], null])
        assert.deepEqual(outboundConfig({ ...ON, [TWILIO_ACCOUNT_SID_VAR]: v }),
          { ok: false, reason: SMS_REASON.NOT_CONFIGURED }, `${JSON.stringify(v)} was read as a SID`);
    });
  });

  /* ---- input ------------------------------------------------------- */

  describe("input", () => {
    test("an unusable target never reaches gate 8 or the provider", async () => {
      for (const phone of [undefined, null, "", "   ", "not-a-phone", "419", "+", 12345]) {
        const { send, order } = harness();
        const r = await send({ email: EMAIL, phone, body: BODY }, { env: ON });
        assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.INVALID_TARGET },
          `phone=${JSON.stringify(phone)} was accepted`);
        assert.deepEqual(order, []);
      }
    });

    test("an empty body is refused", async () => {
      for (const body of [undefined, null, "", "   ", "\n\t ", 42, {}]) {
        const { send, order } = harness();
        const r = await send({ email: EMAIL, phone: PHONE, body }, { env: ON });
        assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.EMPTY_BODY },
          `body=${JSON.stringify(body)} was accepted`);
        assert.deepEqual(order, []);
      }
    });

    test("an overlength body is REFUSED, never truncated", async () => {
      const tooLong = "x".repeat(MAX_SMS_BODY_CHARS + 1);
      const { send, order, creates } = harness();
      const r = await send({ email: EMAIL, phone: PHONE, body: tooLong }, { env: ON });
      assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.BODY_TOO_LONG });
      assert.deepEqual(order, []);
      assert.equal(creates.length, 0, "a truncated message was sent");
    });

    test("a body exactly at the limit is allowed through unchanged", async () => {
      const exact = "y".repeat(MAX_SMS_BODY_CHARS);
      const { send, creates } = harness();
      const r = await send({ email: EMAIL, phone: PHONE, body: exact }, { env: ON });
      assert.equal(r.status, SMS_STATUS.ACCEPTED);
      assert.equal(creates[0].body, exact);
      assert.equal(creates[0].body.length, MAX_SMS_BODY_CHARS);
    });
  });

  /* ---- gate 8 ------------------------------------------------------ */

  describe("gate 8", () => {
    test("a denial sends nothing, whatever the reason was", async () => {
      const { send, order, creates } = harness({ allowed: false });
      const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.NOT_AUTHORIZED });
      assert.deepEqual(order, ["client", "authorize"], "the provider was reached after a denial");
      assert.equal(creates.length, 0);
    });

    test("anything that is not exactly allowed === true is a refusal", async () => {
      const notTrue = [undefined, null, {}, { allowed: "true" }, { allowed: 1 },
                       { allowed: "yes" }, { allowed: false }, { allowed: undefined }, []];
      for (const decision of notTrue) {
        const { send, creates } = harness({ decision });
        const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
        assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.NOT_AUTHORIZED },
          `${JSON.stringify(decision)} was treated as permission`);
        assert.equal(creates.length, 0);
      }
    });

    test("gate 8 THROWING is a refusal — never a rejection, never permission", async () => {
      const { send, order, creates } = harness({ authorizeThrows: true });
      const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.NOT_AUTHORIZED });
      assert.deepEqual(order, ["client", "authorize"], "a message was sent past a broken gate 8");
      assert.equal(creates.length, 0);
      assert.ok(!JSON.stringify(r).includes(E164), "the thrown error's text escaped");
    });

    test("a client that cannot be built is a refusal reached BEFORE gate 8", async () => {
      const { send, order, creates } = harness({ clientThrows: true });
      const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.CLIENT_UNAVAILABLE });
      assert.deepEqual(order, ["client"], "gate 8 was consulted for a send that could never happen");
      assert.equal(creates.length, 0);
      assert.ok(!JSON.stringify(r).includes(KEY_SECRET), "the constructor's error text leaked");
    });

    test("gate 8 is asked about the NORMALISED target, not the raw input", async () => {
      const { send, seen, creates } = harness();
      for (const raw of [PHONE, "419-555-1234", "4195551234", "+1 (419) 555-1234"])
        await send({ email: EMAIL, phone: raw, body: BODY }, { env: ON });
      assert.equal(seen.length, 4);
      for (const args of seen) assert.equal(args.phone, E164, "gate 8 was asked about a different number");
      for (const c of creates) assert.equal(c.to, E164);
    });

    test("THE SAME number is authorized and texted", async () => {
      const { send, seen, creates } = harness();
      await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.equal(seen.length, 1);
      assert.equal(creates.length, 1);
      assert.equal(seen[0].phone, creates[0].to,
        "the number gate 8 authorized is not the number that was texted");
    });
  });

  /* ---- the order and the absence of caching ------------------------ */

  describe("ordering", () => {
    test("the observable order is authorize then create, exactly once each", async () => {
      const { send, order } = harness();
      const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.equal(r.status, SMS_STATUS.ACCEPTED);
      assert.deepEqual(order, ["client", "authorize", "create"]);
    });

    test("every send performs a FRESH authorization — no cached ALLOWED", async () => {
      const { send, order } = harness();
      for (let i = 0; i < 3; i++)
        await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.deepEqual(order.filter((o) => o === "authorize").length, 3,
        "an earlier authorization was reused");
      assert.deepEqual(order.filter((o) => o === "create").length, 3);
    });

    test("a later denial stops a later send even after an earlier one succeeded", async () => {
      let allowed = true;
      const creates = [];
      const send = _senderForTest({
        authorize: async () => ({ allowed }),
        clientFactory: () => ({ messages: { create: async (o) => { creates.push(o); return { sid: MESSAGE_SID }; } } }),
      });
      const first = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.equal(first.status, SMS_STATUS.ACCEPTED);
      allowed = false;
      const second = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.deepEqual(second, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.NOT_AUTHORIZED });
      assert.equal(creates.length, 1, "a suppressed number was texted on a cached allowance");
    });

    test("the sender returns no authorization object a caller could stash", async () => {
      const { send } = harness({ decision: { allowed: true, reason: "ALLOWED", secret: "x" } });
      const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.deepEqual(Object.keys(r).sort(), ["message_sid", "status"]);
      assert.equal(r.reason, undefined);
    });
  });

  /* ---- what reaches the provider ----------------------------------- */

  describe("the provider call", () => {
    test("sends through the Messaging Service and offers no arbitrary sender", async () => {
      const { send, creates } = harness();
      await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.deepEqual(Object.keys(creates[0]).sort(), ["body", "messagingServiceSid", "to"]);
      assert.equal(creates[0].messagingServiceSid, SERVICE);
      assert.equal(creates[0].from, undefined, "an arbitrary from number reached Twilio");
    });

    test("a caller cannot smuggle a from number through the message object", async () => {
      const { send, creates } = harness();
      await send({ email: EMAIL, phone: PHONE, body: BODY, from: "+15550000000",
                   messagingServiceSid: "MG" + hex32("f") }, { env: ON });
      assert.equal(creates[0].from, undefined);
      assert.equal(creates[0].messagingServiceSid, SERVICE, "the caller chose the Messaging Service");
    });

    test("the body reaches the provider byte for byte", async () => {
      const odd = "Tëst — emoji 🏠, quote \" and newline\nend.";
      const { send, creates } = harness();
      await send({ email: EMAIL, phone: PHONE, body: odd }, { env: ON });
      assert.equal(creates[0].body, odd);
    });
  });

  /* ---- the outcome, and only what it proves ------------------------ */

  describe("classifying the outcome", () => {
    test("a valid SID is an acceptance", async () => {
      for (const prefix of ["SM", "MM"]) {
        const sid = prefix + hex32("e");
        const { send } = harness({ create: async () => ({ sid }) });
        const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
        assert.deepEqual(r, { status: SMS_STATUS.ACCEPTED, message_sid: sid });
      }
    });

    test("a malformed provider success does NOT claim acceptance", async () => {
      const bad = [null, undefined, {}, { sid: null }, { sid: 42 }, { sid: "garbage" },
                   { sid: "SM" + "z".repeat(32) }, { sid: "PN" + hex32("e") }, "SM" + hex32("e")];
      for (const value of bad) {
        const { send } = harness({ create: async () => value });
        const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
        assert.equal(r.status, SMS_STATUS.UNKNOWN,
          `${JSON.stringify(value)} was treated as an acceptance`);
        assert.equal(r.reason, SMS_REASON.MALFORMED_PROVIDER_RESPONSE);
      }
    });

    /* THE PART A REVIEW CALLED OUT. Collapsing every throw into
       "unknown" misreports a definite refusal; collapsing a timeout into
       "not sent" misreports an attempt that may have landed. */
    const REJECTIONS = [
      ["a legacy 400", () => sdkError(400, legacyBody(21211)), SMS_REASON.REJECTED],
      ["an RFC-9457 400", () => sdkError(400, rfc9457Body(400, 21211)), SMS_REASON.REJECTED],
      ["a legacy 401", () => sdkError(401, legacyBody(20003)), SMS_REASON.REJECTED_UNAUTHORIZED],
      ["an RFC-9457 403", () => sdkError(403, rfc9457Body(403, 20003)), SMS_REASON.REJECTED_UNAUTHORIZED],
      ["a legacy 404", () => sdkError(404, legacyBody(20404)), SMS_REASON.REJECTED],
      ["a legacy 429", () => sdkError(429, legacyBody(20429)), SMS_REASON.REJECTED_RATE_LIMITED],
      ["an RFC-9457 429", () => sdkError(429, rfc9457Body(429, 20429)), SMS_REASON.REJECTED_RATE_LIMITED],
    ];
    for (const [label, make, reason] of REJECTIONS) {
      test(`${label} from the provider is DEFINITELY NOT SENT`, async () => {
        const { send, creates } = harness({ create: async () => { throw make(); } });
        const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
        assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason },
          `${label} was not reported as a refusal`);
        assert.equal(creates.length, 1, "more than one attempt was made");
      });
    }

    const AMBIGUOUS = [
      ["a legacy 500", () => sdkError(500, legacyBody(20500)), SMS_REASON.PROVIDER_ERROR_UNCONFIRMED],
      ["an RFC-9457 503", () => sdkError(503, rfc9457Body(503, 20503)), SMS_REASON.PROVIDER_ERROR_UNCONFIRMED],
      ["a legacy 502", () => sdkError(502, legacyBody(20502)), SMS_REASON.PROVIDER_ERROR_UNCONFIRMED],
      ["a timeout", () => Object.assign(new Error("timeout of 30000ms exceeded"), { code: "ECONNABORTED" }),
        SMS_REASON.SEND_UNCONFIRMED],
      ["a socket reset", () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        SMS_REASON.SEND_UNCONFIRMED],
      ["a DNS failure", () => Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" }),
        SMS_REASON.SEND_UNCONFIRMED],
      ["a bare Error", () => new Error("something went wrong"), SMS_REASON.SEND_UNCONFIRMED],
      ["a TypeError", () => new TypeError("client.messages is undefined"), SMS_REASON.SEND_UNCONFIRMED],
      ["a thrown null", () => null, SMS_REASON.SEND_UNCONFIRMED],
      ["a thrown string", () => "boom", SMS_REASON.SEND_UNCONFIRMED],
    ];
    for (const [label, make, reason] of AMBIGUOUS) {
      test(`${label} is UNKNOWN — never a false "not sent"`, async () => {
        const { send, creates } = harness({ create: async () => { throw make(); } });
        const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
        assert.deepEqual(r, { status: SMS_STATUS.UNKNOWN, reason },
          `${label} was misclassified`);
        assert.equal(creates.length, 1, "the attempt was retried");
      });
    }

    /* IDENTITY, NOT DUCK TYPING. */
    test("a FORGED error carrying status 400 is NOT accepted as proof of refusal", async () => {
      const forgeries = [
        Object.assign(new Error("nice try"), { status: 400, code: 21211 }),
        { status: 400 },
        Object.assign(new Error("x"), { status: 401, moreInfo: "https://example.test" }),
        Object.create({ status: 429 }),
      ];
      for (const forged of forgeries) {
        const { send } = harness({ create: async () => { throw forged; } });
        const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
        assert.equal(r.status, SMS_STATUS.UNKNOWN,
          "an arbitrary thrown object talked the sender into a definite answer");
        assert.equal(r.reason, SMS_REASON.SEND_UNCONFIRMED);
      }
    });

    test("an SDK error whose status getter throws is UNKNOWN", async () => {
      const err = sdkError(400, legacyBody(21211));
      Object.defineProperty(err, "status", { get() { throw new Error("hostile"); } });
      const { send } = harness({ create: async () => { throw err; } });
      const r = await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.equal(r.status, SMS_STATUS.UNKNOWN);
      assert.equal(r.reason, SMS_REASON.PROVIDER_ERROR_UNCONFIRMED);
    });

    test("an SDK error with a non-integer status is UNKNOWN", async () => {
      for (const status of ["400", 400.5, NaN, null, undefined]) {
        const err = sdkError(400, legacyBody(21211));
        Object.defineProperty(err, "status", { value: status, configurable: true });
        assert.equal(providerRejection(err), null, `status=${String(status)} was read as a refusal`);
      }
    });

    test("providerRejection() answers null for anything that is not an SDK exception", () => {
      for (const v of [null, undefined, 0, "", "x", {}, [], new Error("x"), { status: 400 }])
        assert.equal(providerRejection(v), null, `${JSON.stringify(v)} was read as a refusal`);
    });

    test("EXACTLY ONE attempt in every outcome — nothing retries", async () => {
      const outcomes = [
        async () => ({ sid: MESSAGE_SID }),
        async () => ({ sid: "garbage" }),
        async () => { throw sdkError(400, legacyBody(21211)); },
        async () => { throw sdkError(500, legacyBody(20500)); },
        async () => { throw new Error("ETIMEDOUT"); },
      ];
      for (const create of outcomes) {
        const { send, creates } = harness({ create });
        await send({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
        assert.equal(creates.length, 1, "the provider call was not made exactly once");
      }
    });
  });

  /* ---- nothing leaks ----------------------------------------------- */

  describe("the result and log shape carry nothing sensitive", () => {
    const SECRETS = [E164, PHONE, "4195551234", EMAIL, "example.test", BODY,
                     KEY_SECRET, KEY_SID, ACCOUNT, "api.twilio.com", "ETIMEDOUT",
                     "21211", "Failed", "hunter2"];

    async function everyOutcome() {
      const out = [];
      const push = async (opts, msg = { email: EMAIL, phone: PHONE, body: BODY }, env = ON) => {
        const { send } = harness(opts);
        out.push(await send(msg, env === null ? null : { env }));
      };
      await push({}, "hunter2");
      await push({}, { email: EMAIL, phone: PHONE, body: BODY }, null);
      await push({}, undefined, { ...ON, [OUTBOUND_SMS_FLAG]: "" });
      await push({}, undefined, { ...ON, [TWILIO_ACCOUNT_SID_VAR]: "" });
      await push({}, undefined, { ...ON, [TWILIO_ACCOUNT_SID_VAR]: "AC-bad" });
      await push({}, { email: EMAIL, phone: "nope", body: BODY });
      await push({}, { email: EMAIL, phone: PHONE, body: "" });
      await push({}, { email: EMAIL, phone: PHONE, body: "z".repeat(MAX_SMS_BODY_CHARS + 1) });
      await push({ clientThrows: true });
      await push({ authorizeThrows: true });
      await push({ allowed: false });
      await push({ create: async () => { throw sdkError(400, legacyBody(21211)); } });
      await push({ create: async () => { throw sdkError(401, legacyBody(20003)); } });
      await push({ create: async () => { throw sdkError(500, legacyBody(20500)); } });
      await push({ create: async () => { throw new Error(`failed sending to ${E164}: ${BODY} key ${KEY_SECRET}`); } });
      await push({ create: async () => ({ sid: "garbage" }) });
      await push({});
      return out;
    }

    test("no result carries a phone, email, body, credential or provider text", async () => {
      const results = await everyOutcome();
      assert.equal(results.length, 17, "the sweep stopped covering every outcome");
      for (const r of results) {
        const blob = JSON.stringify(r);
        for (const s of SECRETS)
          assert.ok(!blob.includes(s), `a result leaked "${s}": ${blob}`);
        for (const k of Object.keys(r))
          assert.ok(["status", "reason", "message_sid"].includes(k), `unexpected result field "${k}"`);
      }
    });

    test("no log shape carries any of it either", async () => {
      for (const r of await everyOutcome()) {
        const blob = JSON.stringify(smsSendLogShape(r));
        for (const s of SECRETS)
          assert.ok(!blob.includes(s), `a log shape leaked "${s}": ${blob}`);
        for (const k of Object.keys(smsSendLogShape(r)))
          assert.ok(["sms_status", "sms_reason", "sms_message_sid"].includes(k),
            `unexpected log field "${k}"`);
      }
    });

    test("every reason is a stable machine token", () => {
      for (const v of Object.values(SMS_REASON))
        assert.match(v, /^[A-Z][A-Z0-9_]*$/, `${v} is not a stable token`);
      for (const v of Object.values(SMS_STATUS))
        assert.match(v, /^[a-z_]+$/, `${v} is not a stable token`);
      assert.equal(new Set(Object.values(SMS_REASON)).size, Object.values(SMS_REASON).length,
        "two reasons share a token");
    });
  });
});
