/* The outbound SMS sender — Tier 4.
 * =====================================================================
 * This is the first module in the repository that can cause an external
 * messaging side effect. No test here contacts Twilio, HubSpot or Neon:
 * the two boundaries — gate 8 and the Twilio client — are injected, and
 * the sender's own control flow, validation, ordering and result
 * handling are the real ones.
 *
 * The cases that matter most are not the happy path. They are: does a
 * disabled system stay completely inert; does a denial reach the
 * provider; is the number that was authorized the number that is texted;
 * is there exactly ONE create attempt; and does a failure that might
 * have sent report itself honestly rather than as "not sent".
 */

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  OUTBOUND_SMS_FLAG,
  TWILIO_ACCOUNT_SID_VAR,
  TWILIO_API_KEY_SID_VAR,
  TWILIO_API_KEY_SECRET_VAR,
  TWILIO_MESSAGING_SERVICE_SID_VAR,
  MAX_SMS_BODY_CHARS,
  SMS_STATUS,
  SMS_REASON,
  outboundSmsEnabled,
  outboundConfig,
  sendSms,
  smsSendLogShape,
  _setClientFactory,
  _resetClientFactory,
  _setAuthorizer,
  _resetAuthorizer,
} from "../api/_lib/sms-sender.mjs";

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

/** Records every observable event in order. Nothing leaves the process. */
function harness({ allowed = true, create, authorizeThrows = false } = {}) {
  const order = [];
  const creates = [];
  _setAuthorizer(async (args) => {
    order.push("authorize");
    if (authorizeThrows) throw new Error("gate 8 exploded");
    return { allowed, reason: allowed ? "ALLOWED" : "SUPPRESSED", _args: args };
  });
  _setClientFactory(() => {
    order.push("client");
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
  });
  return { order, creates };
}

beforeEach(() => { _resetClientFactory(); _resetAuthorizer(); });
afterEach(() => { _resetClientFactory(); _resetAuthorizer(); });

describe("the outbound SMS sender", () => {
  /* ---- the flag ---------------------------------------------------- */

  describe("disabled", () => {
    test("only the exact string \"true\" enables it", () => {
      for (const v of [undefined, "", "1", "yes", "TRUE", "True", "true ", " true", "on"])
        assert.equal(outboundSmsEnabled({ [OUTBOUND_SMS_FLAG]: v }), false,
          `${JSON.stringify(v)} enabled outbound SMS`);
      assert.equal(outboundSmsEnabled({ [OUTBOUND_SMS_FLAG]: "true" }), true);
    });

    test("the flag OFF reaches NOTHING — no gate 8, no client, no provider", async () => {
      const { order } = harness();
      for (const v of [undefined, "", "1", "TRUE", "true "]) {
        const env = { ...ON, [OUTBOUND_SMS_FLAG]: v };
        const r = await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env });
        assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.DISABLED });
      }
      assert.deepEqual(order, [],
        "a disabled sender performed work — gate 8 would have reached HubSpot and Neon");
    });
  });

  /* ---- configuration ----------------------------------------------- */

  describe("configuration", () => {
    test("any missing variable is NOT_CONFIGURED and sends nothing", async () => {
      for (const missing of [TWILIO_ACCOUNT_SID_VAR, TWILIO_API_KEY_SID_VAR,
                             TWILIO_API_KEY_SECRET_VAR, TWILIO_MESSAGING_SERVICE_SID_VAR]) {
        const { order } = harness();
        const env = { ...ON, [missing]: "" };
        const r = await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env });
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
        const { order } = harness();
        const r = await sendSms({ email: EMAIL, phone: PHONE, body: BODY },
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
  });

  /* ---- input ------------------------------------------------------- */

  describe("input", () => {
    test("an unusable target never reaches gate 8 or the provider", async () => {
      for (const phone of [undefined, null, "", "   ", "not-a-phone", "419", "+", 12345]) {
        const { order } = harness();
        const r = await sendSms({ email: EMAIL, phone, body: BODY }, { env: ON });
        assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.INVALID_TARGET },
          `phone=${JSON.stringify(phone)} was accepted`);
        assert.deepEqual(order, []);
      }
    });

    test("an empty body is refused", async () => {
      for (const body of [undefined, null, "", "   ", "\n\t ", 42, {}]) {
        const { order } = harness();
        const r = await sendSms({ email: EMAIL, phone: PHONE, body }, { env: ON });
        assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.EMPTY_BODY },
          `body=${JSON.stringify(body)} was accepted`);
        assert.deepEqual(order, []);
      }
    });

    test("an overlength body is REFUSED, never truncated", async () => {
      const tooLong = "x".repeat(MAX_SMS_BODY_CHARS + 1);
      const { order, creates } = harness();
      const r = await sendSms({ email: EMAIL, phone: PHONE, body: tooLong }, { env: ON });
      assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.BODY_TOO_LONG });
      assert.deepEqual(order, [], "an overlength message still reached a provider");
      assert.deepEqual(creates, [], "CLAUDE.md rule 11 — never silently truncate");
    });

    test("a body exactly at the limit is allowed through unchanged", async () => {
      const exact = "y".repeat(MAX_SMS_BODY_CHARS);
      const { creates } = harness();
      const r = await sendSms({ email: EMAIL, phone: PHONE, body: exact }, { env: ON });
      assert.equal(r.status, SMS_STATUS.ACCEPTED);
      assert.equal(creates[0].body, exact);
      assert.equal(creates[0].body.length, MAX_SMS_BODY_CHARS);
    });
  });

  /* ---- gate 8 ------------------------------------------------------ */

  describe("gate 8", () => {
    test("a denial sends nothing, whatever the reason was", async () => {
      for (const decision of [
        { allowed: false, reason: "SUPPRESSED" },
        { allowed: false, reason: "NO_CONSENT" },
        { allowed: false, reason: "DURABLE_SMS_BLOCK" },
        { allowed: false, reason: "SUPPRESSION_LOOKUP_UNAVAILABLE" },
        { allowed: false, reason: "CONSENT_STATE_UNAVAILABLE" },
        { allowed: false, reason: "CONSENT_PHONE_MISMATCH" },
      ]) {
        const order = [];
        _setAuthorizer(async () => { order.push("authorize"); return decision; });
        _setClientFactory(() => ({ messages: { create: async () => { order.push("create"); return { sid: MESSAGE_SID }; } } }));
        const r = await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
        assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.NOT_AUTHORIZED },
          `${decision.reason} did not stop the send`);
        assert.ok(!order.includes("create"), `${decision.reason} reached the provider`);
      }
    });

    test("anything that is not exactly allowed === true is a refusal", async () => {
      for (const decision of [undefined, null, {}, { allowed: "true" }, { allowed: 1 },
                              { allowed: "yes" }, { reason: "ALLOWED" }, "ALLOWED"]) {
        const order = [];
        _setAuthorizer(async () => { order.push("authorize"); return decision; });
        _setClientFactory(() => ({ messages: { create: async () => { order.push("create"); return { sid: MESSAGE_SID }; } } }));
        const r = await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
        assert.equal(r.status, SMS_STATUS.NOT_SENT,
          `${JSON.stringify(decision)} was treated as permission`);
        assert.ok(!order.includes("create"));
      }
    });

    test("gate 8 is asked about the NORMALISED target, not the raw input", async () => {
      const seen = [];
      const { creates } = harness();
      _setAuthorizer(async (args) => { seen.push(args); return { allowed: true }; });
      for (const raw of [PHONE, "419-555-1234", "4195551234", "+1 (419) 555-1234"]) {
        await sendSms({ email: EMAIL, phone: raw, body: BODY }, { env: ON });
      }
      assert.equal(seen.length, 4);
      for (const args of seen) assert.equal(args.phone, E164, "gate 8 was asked about a different number");
      for (const c of creates) assert.equal(c.to, E164);
    });

    test("THE SAME number is authorized and texted", async () => {
      const seen = [];
      const { creates } = harness();
      _setAuthorizer(async (args) => { seen.push(args.phone); return { allowed: true }; });
      await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.equal(seen.length, 1);
      assert.equal(creates.length, 1);
      assert.equal(seen[0], creates[0].to,
        "the number gate 8 authorized is not the number that was texted");
    });
  });

  /* ---- ordering, which is the TOCTOU argument ---------------------- */

  describe("ordering", () => {
    test("the observable order is authorize then create, exactly once each", async () => {
      const { order, creates } = harness();
      const r = await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.equal(r.status, SMS_STATUS.ACCEPTED);
      assert.deepEqual(order, ["client", "authorize", "create"],
        "the client must be built BEFORE authorization so nothing sits between authorize and create");
      assert.equal(order.filter((e) => e === "authorize").length, 1);
      assert.equal(creates.length, 1);
      assert.equal(order.at(-1), "create", "the provider call is not the last thing that happens");
    });

    test("every send performs a FRESH authorization — no cached ALLOWED", async () => {
      const { order, creates } = harness();
      for (let i = 0; i < 3; i++)
        await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.deepEqual(order, ["client", "authorize", "create",
                               "client", "authorize", "create",
                               "client", "authorize", "create"]);
      assert.equal(order.filter((e) => e === "authorize").length, 3, "an authorization was reused");
      assert.equal(creates.length, 3);
    });

    test("a later denial stops a later send even after an earlier one succeeded", async () => {
      /* The shape a cached decision would break. */
      const order = [];
      let allowed = true;
      _setAuthorizer(async () => { order.push("authorize"); return { allowed }; });
      _setClientFactory(() => ({ messages: { create: async () => { order.push("create"); return { sid: MESSAGE_SID }; } } }));

      const first = await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.equal(first.status, SMS_STATUS.ACCEPTED);

      allowed = false;   /* a STOP arrives between the two sends */
      const second = await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.deepEqual(second, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.NOT_AUTHORIZED });
      assert.equal(order.filter((e) => e === "create").length, 1,
        "the second send reused the first ALLOWED and texted a suppressed number");
    });

    test("gate 8 THROWING is a refusal — never a rejection, never permission", async () => {
      const { order } = harness({ authorizeThrows: true });
      const r = await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.NOT_AUTHORIZED },
        "a boundary that throws was not treated as a refusal");
      assert.deepEqual(order, ["client", "authorize"], "a message was sent past a broken gate 8");
    });

    test("a client that cannot be built is a refusal — never a rejection", async () => {
      const order = [];
      _setAuthorizer(async () => { order.push("authorize"); return { allowed: true }; });
      _setClientFactory(() => { throw new Error(`bad credentials ${KEY_SECRET}`); });
      const r = await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.deepEqual(r, { status: SMS_STATUS.NOT_SENT, reason: SMS_REASON.CLIENT_UNAVAILABLE });
      assert.deepEqual(order, [], "gate 8 was consulted for a send that could never happen");
      assert.ok(!JSON.stringify(r).includes(KEY_SECRET), "the constructor's error text leaked");
    });

    test("the sender returns no authorization object a caller could stash", async () => {
      harness();
      const r = await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.deepEqual(Object.keys(r).sort(), ["message_sid", "status"]);
      assert.ok(!("allowed" in r), "the ALLOWED decision escaped the stack frame");
      assert.ok(!("decision" in r));
    });
  });

  /* ---- the provider call shape ------------------------------------- */

  describe("the provider call", () => {
    test("sends through the Messaging Service and offers no arbitrary sender", async () => {
      const { creates } = harness();
      await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.equal(creates.length, 1);
      assert.deepEqual(Object.keys(creates[0]).sort(), ["body", "messagingServiceSid", "to"]);
      assert.equal(creates[0].messagingServiceSid, SERVICE);
      assert.ok(!("from" in creates[0]), "an arbitrary from number reached the provider");
      assert.ok(!("From" in creates[0]));
    });

    test("a caller cannot smuggle a from number through the message object", async () => {
      const { creates } = harness();
      await sendSms(
        { email: EMAIL, phone: PHONE, body: BODY, from: "+15550001111", messagingServiceSid: "MG" + hex32("f") },
        { env: ON });
      assert.ok(!("from" in creates[0]));
      assert.equal(creates[0].messagingServiceSid, SERVICE, "the configured service was overridden");
    });

    test("the body reaches the provider byte for byte", async () => {
      const tricky = "Line one\nLine two — em dash, emoji 🙂, quote \" and 'apostrophe'";
      const { creates } = harness();
      await sendSms({ email: EMAIL, phone: PHONE, body: tricky }, { env: ON });
      assert.equal(creates[0].body, tricky);
    });
  });

  /* ---- provider outcomes ------------------------------------------- */

  describe("provider outcomes", () => {
    test("a valid SID is an acceptance", async () => {
      for (const sid of [MESSAGE_SID, "MM" + hex32("e")]) {
        harness({ create: async () => ({ sid }) });
        const r = await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
        assert.deepEqual(r, { status: SMS_STATUS.ACCEPTED, message_sid: sid });
      }
    });

    test("a throw is UNKNOWN, never a false 'not sent', and is attempted ONCE", async () => {
      let attempts = 0;
      harness({ create: async () => { attempts++; throw new Error("ETIMEDOUT connecting to api.twilio.com"); } });
      const r = await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
      assert.deepEqual(r, { status: SMS_STATUS.UNKNOWN, reason: SMS_REASON.SEND_UNCONFIRMED });
      assert.equal(attempts, 1, "the sender retried an ambiguous provider failure");
      assert.notEqual(r.status, SMS_STATUS.NOT_SENT,
        "an attempted send that may have succeeded was reported as not sent");
    });

    test("a malformed provider success does NOT claim acceptance", async () => {
      for (const bad of [undefined, null, {}, "SM", 42, { sid: null }, { sid: 42 },
                         { sid: "" }, { sid: "not-a-sid" }, { sid: "SM123" },
                         { sid: "PN" + hex32("d") }, []]) {
        harness({ create: async () => bad });
        const r = await sendSms({ email: EMAIL, phone: PHONE, body: BODY }, { env: ON });
        assert.equal(r.status, SMS_STATUS.UNKNOWN,
          `${JSON.stringify(bad)} was treated as an acceptance`);
        assert.equal(r.reason, SMS_REASON.MALFORMED_PROVIDER_RESPONSE);
      }
    });
  });

  /* ---- nothing leaks ----------------------------------------------- */

  describe("the result and log shape carry nothing sensitive", () => {
    const SECRETS = [E164, PHONE, "4195551234", EMAIL, "example.test", BODY,
                     KEY_SECRET, KEY_SID, ACCOUNT, "api.twilio.com", "ETIMEDOUT"];

    async function everyOutcome() {
      const out = [];
      const push = async (setup, msg = { email: EMAIL, phone: PHONE, body: BODY }, env = ON) => {
        setup(); out.push(await sendSms(msg, { env }));
      };
      await push(() => harness(), undefined, { ...ON, [OUTBOUND_SMS_FLAG]: "" });
      await push(() => harness(), undefined, { ...ON, [TWILIO_ACCOUNT_SID_VAR]: "" });
      await push(() => harness(), undefined, { ...ON, [TWILIO_ACCOUNT_SID_VAR]: "AC-bad" });
      await push(() => harness(), { email: EMAIL, phone: "nope", body: BODY });
      await push(() => harness(), { email: EMAIL, phone: PHONE, body: "" });
      await push(() => harness(), { email: EMAIL, phone: PHONE, body: "z".repeat(MAX_SMS_BODY_CHARS + 1) });
      await push(() => harness({ allowed: false }));
      await push(() => harness({ authorizeThrows: true }));
      await push(() => {
        _setAuthorizer(async () => ({ allowed: true }));
        _setClientFactory(() => { throw new Error(`bad key ${KEY_SECRET} for ${E164}`); });
      });
      await push(() => harness({ create: async () => { throw new Error(`failed sending to ${E164}: ${BODY} key ${KEY_SECRET}`); } }));
      await push(() => harness({ create: async () => ({ sid: "garbage" }) }));
      await push(() => harness());
      return out;
    }

    test("no result carries a phone, email, body, credential or provider text", async () => {
      const results = await everyOutcome();
      assert.equal(results.length, 12, "the sweep stopped covering every outcome");
      for (const r of results) {
        const blob = JSON.stringify(r);
        for (const s of SECRETS)
          assert.ok(!blob.includes(s), `a result leaked "${s}": ${blob}`);
        for (const k of Object.keys(r))
          assert.ok(["status", "reason", "message_sid"].includes(k),
            `unexpected result field "${k}"`);
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
    });
  });
});

/* =====================================================================
   THE STATIC GUARDS — run the real check.mjs against a broken tree
   =====================================================================
   The tests above prove what the sender DOES. These prove that the
   repository refuses the refactors that would quietly undo it: a second
   send site, a send from somewhere else, a suspension point opened
   between the gate 8 decision and the provider call, a raw REST bypass,
   or an endpoint reaching for the sender while outbound messaging is
   still dark.

   Each case breaks one invariant in a THROWAWAY COPY and asserts the
   real tools/check.mjs refuses it, with the message that invariant owns.
   The working tree is never mutated. Every mutation asserts its target
   is present BEFORE it is applied and that the text actually changed —
   a mutation test that does not mutate reports green while proving
   nothing, which this project has already shipped once.

   THE LIMIT, STATED. The region guard proves there is no suspension
   point between the two call sites IN THE SENDER'S OWN SOURCE. It
   cannot prove adjacency in general: move the authorization into a
   helper two frames away and no regex would notice. That case is
   carried by "the observable order is authorize then create" above,
   which watches the real call order through an injected double.
   ===================================================================== */
describe("the outbound sender static guards", () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
  const SENDER = "api/_lib/sms-sender.mjs";
  const LEAD = "api/lead.js";
  let dir, root;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cst-sender-guard-"));
    root = join(dir, "tree");
    for (const item of ["src", "assets", "tools", "api", "db", "package.json",
                        "robots.txt", "site.webmanifest", ".env.example"])
      cpSync(join(REPO, item), join(root, item), { recursive: true });
    execFileSync(process.execPath, ["tools/build.mjs"], { cwd: root, stdio: "pipe" });
  });
  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const pristine = (rel) => readFileSync(join(REPO, rel), "utf8");
  afterEach(() => {
    for (const rel of [SENDER, LEAD]) writeFileSync(join(root, rel), pristine(rel));
  });

  function runCheck() {
    try {
      execFileSync(process.execPath, ["tools/check.mjs"], { cwd: root, stdio: "pipe" });
      return { ok: true, output: "" };
    } catch (err) {
      return { ok: false, output: String(err.stdout || "") + String(err.stderr || "") };
    }
  }

  /** Apply one textual mutation, proving first that it is a real one. */
  function mutate(rel, from, to) {
    const src = pristine(rel);
    assert.ok(src.includes(from),
      `the mutation target moved in ${rel} — this test would prove nothing:\n  ${from}`);
    const out = src.replace(from, to);
    assert.notEqual(out, src, `the mutation changed nothing in ${rel}`);
    writeFileSync(join(root, rel), out);
  }

  /** Append, for the mutations that add a bypass rather than move one. */
  const append = (rel, text) => writeFileSync(join(root, rel), pristine(rel) + text);

  function refused(pattern, why) {
    const { ok, output } = runCheck();
    assert.ok(!ok, `check.mjs accepted ${why}`);
    assert.match(output, pattern);
  }

  /* The control. Without it every assertion below could be passing
     because the copied tree was already broken. */
  test("the copied tree passes before anything is broken", () => {
    const { ok, output } = runCheck();
    assert.ok(ok, "an unmodified copy already fails check.mjs:\n" + output);
  });

  /* ---- adjacency: the region between the decision and the send ------ */

  const DENIAL = "  if (!decision || decision.allowed !== true) return notSent(SMS_REASON.NOT_AUTHORIZED);";

  for (const [label, inserted] of [
    ["an await", "  await Promise.resolve();"],
    ["a .then()", "  Promise.resolve().then(() => {});"],
    ["a timer", "  setTimeout(() => {}, 0);"],
    ["a queueMicrotask", "  queueMicrotask(() => {});"],
    ["a new Promise", "  const p = new Promise((r) => r());"],
  ]) {
    test(`${label} between the gate 8 decision and the send is refused`, () => {
      mutate(SENDER, DENIAL, DENIAL + "\n" + inserted);
      refused(/between the gate 8 decision and the Twilio send/,
        `${label} opened between authorization and the provider call`);
    });
  }

  test("weakening the denial to `allowed === false` is refused", () => {
    mutate(SENDER, "!decision || decision.allowed !== true",
      "decision && decision.allowed === false");
    refused(/allowed !== true/,
      "a denial shape that lets a malformed or missing decision through");
  });

  test("deleting the denial entirely is refused", () => {
    mutate(SENDER, DENIAL + "\n", "");
    refused(/allowed !== true/, "a sender with no refusal between gate 8 and the send");
  });

  /* ---- ordering ------------------------------------------------------ */

  test("authorizing AFTER the send is refused", () => {
    const src = pristine(SENDER);
    const AUTH = "    decision = await authorize({ email, phone: to }, { env });";
    const SEND = "    result = await client.messages.create({ to, body: text, messagingServiceSid: config.messagingServiceSid });";
    assert.ok(src.includes(AUTH) && src.includes(SEND),
      "a call site moved — this test would prove nothing");
    const out = src
      .replace(AUTH, "    decision = { allowed: true };")
      .replace(SEND, SEND + "\n    await authorize({ email, phone: to }, { env });");
    assert.notEqual(out, src, "the mutation changed nothing");
    writeFileSync(join(root, SENDER), out);
    refused(/sends before it authorizes/, "a sender that texts first and asks gate 8 afterwards");
  });

  test("checking the outbound flag after gate 8 is refused", () => {
    mutate(SENDER, "  if (!outboundSmsEnabled(env)) return notSent(SMS_REASON.DISABLED);", "");
    refused(/before checking the outbound feature flag/,
      "a dark sender that still reaches HubSpot and Neon through gate 8");
  });

  test("a non-strict outbound flag is refused", () => {
    mutate(SENDER, 'env[OUTBOUND_SMS_FLAG] === "true"', 'env[OUTBOUND_SMS_FLAG] !== "false"');
    refused(/compared strictly to "true"/, "a flag that switches outbound messaging on by default");
  });

  /* ---- containment: exactly one send site, and it is the sender ------ */

  test("an await inside the send's OWN ARGUMENTS is refused", () => {
    /* It resolves before the request is made, so it sits in exactly the
       window the region guard exists to close — and it falls outside the
       region, which ends where the call begins. */
    mutate(SENDER, "create({ to, body: text, messagingServiceSid: config.messagingServiceSid })",
      "create({ to, body: await Promise.resolve(text), messagingServiceSid: config.messagingServiceSid })");
    refused(/inside the Twilio send's own arguments/,
      "a suspension point smuggled into the provider call's argument list");
  });

  test("a second message-create site in the sender is refused", () => {
    mutate(SENDER, "  return { status: SMS_STATUS.ACCEPTED, message_sid: sid };",
      "  if (sid === null) await client.messages.create({ to, body: text });\n" +
      "  return { status: SMS_STATUS.ACCEPTED, message_sid: sid };");
    refused(/exactly one/, "a sender with two provider side-effect sites");
  });

  test("another api/ module creating a Twilio message is refused", () => {
    append(LEAD, "\nexport async function elsewhere(client) {\n" +
      "  return client.messages.create({ to: \"+14195550000\", body: \"hi\" });\n}\n");
    refused(/only api\/_lib\/sms-sender\.mjs may cause an outbound Twilio side effect/,
      "a send from outside the designated sender");
  });

  test("another api/ module constructing a Twilio client is refused", () => {
    append(LEAD, "\nimport twilioSdk from \"twilio\";\n" +
      "export const client = twilio(\"SK\", \"secret\", {});\n");
    refused(/constructs a Twilio API client/, "a Twilio client built outside the sender");
  });

  test("another api/ module reading an outbound Twilio credential is refused", () => {
    append(LEAD, "\nexport const svc = process.env.TWILIO_MESSAGING_SERVICE_SID;\n");
    refused(/reads an outbound Twilio credential/,
      "the outbound sender identity read outside the sender");
  });

  /* ---- containment: raw REST is not a side door ---------------------- */

  test("a raw Twilio REST send from the SENDER is refused", () => {
    mutate(SENDER, "  let result;",
      "  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`);\n" +
      "  let result;");
    refused(/addresses the Twilio REST API directly/,
      "a hand-rolled REST call that bypasses the SDK");
  });

  test("a raw Twilio REST send from another api/ module is refused", () => {
    append(LEAD, "\nexport const send = (b) => fetch(\"https://api.twilio.com/2010-04-01/Accounts/AC/Messages.json\", { method: \"POST\", body: b });\n");
    refused(/addresses the Twilio REST API directly/, "a REST bypass outside the sender");
  });

  /* ---- routing through gate 8 ---------------------------------------- */

  test("the sender calling canSendSms() directly is refused", () => {
    const src = pristine(SENDER);
    const out = src
      .replace('import { authorizeSms } from "./send-permission.mjs";',
               'import { canSendSms } from "./permission.mjs";')
      .replace("let authorize = authorizeSms;", "let authorize = async (a) => canSendSms(a);");
    assert.notEqual(out, src, "the mutation changed nothing");
    writeFileSync(join(root, SENDER), out);
    refused(/calls canSendSms\(\) directly/,
      "a sender that decides on CRM state alone and never reads durable suppression");
  });

  test("a test seam whose default is not gate 8 is refused", () => {
    mutate(SENDER, "function _resetAuthorizer() { authorize = authorizeSms; }",
      "function _resetAuthorizer() { authorize = async () => ({ allowed: true }); }");
    refused(/_resetAuthorizer\(\) does not restore authorizeSms/,
      "a reset that leaves the gate permanently open");
  });

  /* ---- darkness ------------------------------------------------------ */

  test("an endpoint importing the sender is refused while outbound is dark", () => {
    append(LEAD, "\nimport { sendSms } from \"./_lib/sms-sender.mjs\";\n");
    refused(/deliberately unreachable/,
      "an endpoint wired to the sender while outbound messaging is dark");
  });
});
