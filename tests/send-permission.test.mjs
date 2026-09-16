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

  test("a missing sender credential fails closed after a potentially valid grant is read", async () => {
    let crmCalls = 0;
    _setContactLookup(async () => { crmCalls++; return contact(granted({ sms: true })); });

    assert.deepEqual(
      await authorizeSms({ email: EMAIL, phone: PHONE }, { env: { [FEATURE_FLAG]: "true" } }),
      { allowed: false, reason: REASON.SUPPRESSION_LOOKUP_UNAVAILABLE },
    );
    assert.equal(crmCalls, 1);
  });

  test("no durable block plus a current matching SMS grant allows", async () => {
    const order = [];
    _setContactLookup(async () => {
      order.push("hubspot");
      return contact(granted({ sms: true }));
    });
    _setSuppressionExecutor(async () => {
      order.push("suppression");
      return [];
    });

    assert.deepEqual(await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: true, reason: REASON.ALLOWED });
    assert.deepEqual(order, ["hubspot", "suppression"],
      "durable suppression must be the final provider read on an allow path");
  });

  test("a durable SMS block overrides an earlier current grant", async () => {
    const order = [];
    _setContactLookup(async () => {
      order.push("hubspot");
      return contact(granted({ sms: true }));
    });
    _setSuppressionExecutor(async () => {
      order.push("suppression");
      return [{ channel: "sms", suppressed_at: "2026-09-16T00:00:00.000Z" }];
    });

    assert.deepEqual(await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: false, reason: REASON.DURABLE_SMS_BLOCK });
    assert.deepEqual(order, ["hubspot", "suppression"]);
  });

  test("an SMS-only durable block does not suppress an independently granted voice lane", async () => {
    _setContactLookup(async () => contact(granted({ voice: true })));
    _setSuppressionExecutor(async () => [
      { channel: "sms", suppressed_at: "2026-09-16T00:00:00.000Z" },
    ]);

    assert.deepEqual(await authorizeAutomatedVoice({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: true, reason: REASON.ALLOWED });
  });

  test("a durable all-channel block overrides an earlier current voice grant", async () => {
    _setContactLookup(async () => contact(granted({ voice: true })));
    _setSuppressionExecutor(async () => [
      { channel: "all", suppressed_at: "2026-09-16T00:00:00.000Z" },
    ]);

    assert.deepEqual(await authorizeAutomatedVoice({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: false, reason: REASON.DURABLE_GLOBAL_BLOCK });
  });

  test("database failure is not interpreted as no suppression", async () => {
    _setContactLookup(async () => contact(granted({ sms: true })));
    _setSuppressionExecutor(async () => { throw new Error("contains +14195551234 and a host"); });

    assert.deepEqual(await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: false, reason: REASON.SUPPRESSION_LOOKUP_UNAVAILABLE });
  });

  test("malformed or unknown suppression rows fail closed", async () => {
    _setContactLookup(async () => contact(granted({ sms: true })));
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

  test("a HubSpot read failure refuses without doing the later suppression lookup", async () => {
    let dbCalls = 0;
    _setContactLookup(async () => { throw new Error("CRM unavailable"); });
    _setSuppressionExecutor(async () => { dbCalls++; return []; });

    assert.deepEqual(await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: false, reason: REASON.CONSENT_STATE_UNAVAILABLE });
    assert.equal(dbCalls, 0);
  });

  test("a genuinely absent contact is no consent and needs no suppression lookup", async () => {
    let dbCalls = 0;
    _setContactLookup(async () => null);
    _setSuppressionExecutor(async () => { dbCalls++; return []; });

    assert.deepEqual(await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: false, reason: REASON.NO_CONSENT });
    assert.equal(dbCalls, 0);
  });

  test("an already-denied current state never spends a durable lookup", async () => {
    let dbCalls = 0;
    _setContactLookup(async () => contact(granted({})));
    _setSuppressionExecutor(async () => { dbCalls++; return []; });

    assert.deepEqual(await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: false, reason: REASON.NO_CONSENT });
    assert.equal(dbCalls, 0);
  });

  test("the old grant cannot travel to a different target number", async () => {
    let dbCalls = 0;
    _setContactLookup(async () => contact(granted({ sms: true, phone: PHONE })));
    _setSuppressionExecutor(async () => { dbCalls++; return []; });

    assert.deepEqual(await authorizeSms({ email: EMAIL, phone: OTHER_PHONE }, { env: ON }),
      { allowed: false, reason: REASON.CONSENT_PHONE_MISMATCH });
    assert.equal(dbCalls, 0, "phone mismatch is already a definitive denial");
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

/* =====================================================================
   Tier-4 completion — the cases the first review did not pin.
   =====================================================================
   Added when Gate 8 was brought forward onto current main. Two of these
   cover defects found in that re-review and fixed in the same change:
   an absent target reached the CRM pre-decision as ALLOWED and was
   refused only because toE164() happened to throw inside the suppression
   lookup, and an unknown channel was silently dispatched as voice.
   ===================================================================== */
describe("Gate 8 — Tier-4 completion", () => {
  /** Record the exact order of provider reads for one authorization. */
  function recordingHarness({ consent, rows = [], crmThrows = false, lookupThrows = false }) {
    const order = [];
    _setContactLookup(async () => {
      order.push("crm");
      if (crmThrows) throw new Error("hubspot unavailable");
      return contact(consent);
    });
    _setSuppressionExecutor(async () => {
      order.push("durable");
      if (lookupThrows) throw new Error("neon unavailable");
      return { rows };
    });
    return order;
  }

  /* ---- the two lanes authorize independently ---------------------- */

  test("a clean voice grant on the exact number allows", async () => {
    recordingHarness({ consent: granted({ voice: true }) });
    assert.deepEqual(await authorizeAutomatedVoice({ email: EMAIL, phone: PHONE }, { env: ON }),
      { allowed: true, reason: REASON.ALLOWED });
  });

  test("SMS consent does not authorize a voice call", async () => {
    recordingHarness({ consent: granted({ sms: true }) });
    const d = await authorizeAutomatedVoice({ email: EMAIL, phone: PHONE }, { env: ON });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, REASON.NO_CONSENT);
  });

  test("voice consent does not authorize an SMS", async () => {
    recordingHarness({ consent: granted({ voice: true }) });
    const d = await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, REASON.NO_CONSENT);
  });

  /* ---- suppression, per lane and global --------------------------- */

  test("an active ai_voice durable block denies voice and leaves SMS alone", async () => {
    recordingHarness({
      consent: granted({ sms: true, voice: true }),
      rows: [{ channel: "ai_voice", suppressed_at: "2026-09-16T10:00:00.000Z" }],
    });
    assert.equal((await authorizeAutomatedVoice({ email: EMAIL, phone: PHONE }, { env: ON })).reason,
      REASON.DURABLE_VOICE_BLOCK);
    assert.equal((await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON })).allowed, true);
  });

  test("an active all-channel durable block denies BOTH lanes", async () => {
    recordingHarness({
      consent: granted({ sms: true, voice: true }),
      rows: [{ channel: "all", suppressed_at: "2026-09-16T10:00:00.000Z" }],
    });
    for (const fn of [authorizeSms, authorizeAutomatedVoice]) {
      const d = await fn({ email: EMAIL, phone: PHONE }, { env: ON });
      assert.equal(d.allowed, false);
      assert.equal(d.reason, REASON.DURABLE_GLOBAL_BLOCK);
    }
  });

  test("CRM suppression alone denies, even with a clean durable lookup", async () => {
    const state = granted({ sms: true });
    state.suppression = { sms: true };
    recordingHarness({ consent: state, rows: [] });
    const d = await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, REASON.SMS_SUPPRESSED_STOP);
  });

  test("a global CRM do-not-contact denies both lanes on its own", async () => {
    const state = granted({ sms: true, voice: true });
    state.suppression = { global: true };
    recordingHarness({ consent: state, rows: [] });
    for (const fn of [authorizeSms, authorizeAutomatedVoice])
      assert.equal((await fn({ email: EMAIL, phone: PHONE }, { env: ON })).reason, REASON.GLOBAL_DNC);
  });

  /* ---- consent and suppression are separate facts ----------------- */

  test("clearing a suppression does not create consent — START alone never authorizes", async () => {
    /* The durable lookup returns NOTHING: the block is gone. There is
       still no grant, so there is still nothing to send. This is the
       invariant that stops a carrier-level START being read as
       first-party consent. */
    recordingHarness({ consent: granted({ sms: false, voice: false }), rows: [] });
    for (const fn of [authorizeSms, authorizeAutomatedVoice]) {
      const d = await fn({ email: EMAIL, phone: PHONE }, { env: ON });
      assert.equal(d.allowed, false, "an unsuppressed contact with no grant was authorized");
      assert.equal(d.reason, REASON.NO_CONSENT);
    }
  });

  test("a historical grant does not survive a later durable STOP", async () => {
    /* CRM still says granted because a form was submitted; the ledger
       carries the newer STOP. The consumer wins. */
    recordingHarness({
      consent: granted({ sms: true }),
      rows: [{ channel: "sms", suppressed_at: "2026-09-16T23:59:00.000Z" }],
    });
    assert.equal((await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON })).reason,
      REASON.DURABLE_SMS_BLOCK);
  });

  /* ---- fail-closed on every dependency story ---------------------- */

  test("a suppression lookup timeout is not 'not suppressed'", async () => {
    _setContactLookup(async () => contact(granted({ sms: true })));
    _setSuppressionExecutor(() => new Promise(() => {}));   /* never settles */
    const d = await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON, timeoutMs: 20 });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, REASON.SUPPRESSION_LOOKUP_UNAVAILABLE);
  });

  test("a malformed CRM consent shape is a dependency failure, not an absence of consent", async () => {
    for (const bad of ["a string", 42, [], true]) {
      _setContactLookup(async () => ({ id: "1", consent: bad }));
      _setSuppressionExecutor(async () => { throw new Error("must not be reached"); });
      const d = await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON });
      assert.equal(d.allowed, false);
      assert.equal(d.reason, REASON.CONSENT_STATE_UNAVAILABLE, `consent=${JSON.stringify(bad)}`);
    }
  });

  /* ---- the target is the target ------------------------------------ */

  test("an absent or unusable target denies BEFORE any provider is contacted", async () => {
    /* REGRESSION. Before the target was validated up front, an absent
       phone fell through to the resolver's `target || consent_phone`
       fallback, passed the CRM pre-decision as ALLOWED, and was refused
       only because toE164() threw inside the suppression lookup - which
       reported SUPPRESSION_LOOKUP_UNAVAILABLE and would have sent an
       operator to debug a database that was working perfectly. */
    for (const phone of [undefined, null, "", "   ", "not-a-phone", "419", "+", 12345]) {
      const order = recordingHarness({ consent: granted({ sms: true, voice: true }) });
      for (const fn of [authorizeSms, authorizeAutomatedVoice]) {
        const d = await fn({ email: EMAIL, phone }, { env: ON });
        assert.equal(d.allowed, false, `phone=${JSON.stringify(phone)} was authorized`);
        assert.equal(d.reason, REASON.INVALID_PHONE,
          `phone=${JSON.stringify(phone)} denied for the wrong reason: ${d.reason}`);
      }
      assert.deepEqual(order, [],
        `phone=${JSON.stringify(phone)} contacted a provider before validating the target`);
    }
  });

  test("consent for one line never authorizes a different line", async () => {
    recordingHarness({ consent: granted({ sms: true, voice: true, phone: PHONE }) });
    for (const fn of [authorizeSms, authorizeAutomatedVoice]) {
      const d = await fn({ email: EMAIL, phone: OTHER_PHONE }, { env: ON });
      assert.equal(d.allowed, false);
      assert.equal(d.reason, REASON.CONSENT_PHONE_MISMATCH);
    }
  });

  /* ---- ordering, which is the whole TOCTOU argument ---------------- */

  test("on an ALLOWED path the durable lookup is the FINAL provider read", async () => {
    const order = recordingHarness({ consent: granted({ sms: true, voice: true }), rows: [] });
    assert.equal((await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON })).allowed, true);
    assert.equal((await authorizeAutomatedVoice({ email: EMAIL, phone: PHONE }, { env: ON })).allowed, true);
    assert.deepEqual(order, ["crm", "durable", "crm", "durable"],
      "the durable suppression read is not the last provider read before ALLOWED");
    assert.equal(order.at(-1), "durable");
  });

  test("a denial reached before the durable read spends no lookup at all", async () => {
    const order = recordingHarness({ consent: granted({ sms: false }) });
    assert.equal((await authorizeSms({ email: EMAIL, phone: PHONE }, { env: ON })).allowed, false);
    assert.deepEqual(order, ["crm"], "a hopeless send still queried the ledger");
  });

  /* ---- the decision object is safe to log -------------------------- */

  test("no decision carries PII, credentials or provider text", async () => {
    const SECRETS = [PHONE, OTHER_PHONE, EMAIL, URL, "sender", "password", "example.invalid",
                     "hubspot", "neon", "123"];
    const decisions = [];

    const collect = async (setup, fn, args, env = ON) => {
      setup();
      decisions.push(await fn(args, env === ON ? { env: ON } : env));
    };

    await collect(() => recordingHarness({ consent: granted({ sms: true }), rows: [] }),
      authorizeSms, { email: EMAIL, phone: PHONE });
    await collect(() => recordingHarness({ consent: granted({ sms: true }), crmThrows: true }),
      authorizeSms, { email: EMAIL, phone: PHONE });
    await collect(() => recordingHarness({ consent: granted({ sms: true }), lookupThrows: true }),
      authorizeSms, { email: EMAIL, phone: PHONE });
    await collect(() => recordingHarness({ consent: granted({ sms: true }) }),
      authorizeSms, { email: EMAIL, phone: OTHER_PHONE });
    await collect(() => recordingHarness({ consent: granted({ sms: true }) }),
      authorizeSms, { email: EMAIL, phone: "nope" });

    assert.equal(decisions.length, 5);
    for (const d of decisions) {
      assert.deepEqual(Object.keys(d).sort(), ["allowed", "reason"],
        `a decision carries extra fields: ${JSON.stringify(d)}`);
      assert.equal(typeof d.allowed, "boolean");
      assert.equal(typeof d.reason, "string");
      const blob = JSON.stringify(d).toLowerCase();
      for (const secret of SECRETS)
        assert.ok(!blob.includes(String(secret).toLowerCase()),
          `decision leaked "${secret}": ${JSON.stringify(d)}`);
    }
  });

  test("every reason code is a stable machine token, never prose", async () => {
    for (const value of Object.values(REASON))
      assert.match(value, /^[A-Z][A-Z0-9_]*$/, `${value} is not a stable machine token`);
  });

  /* ---- an unknown channel is not a channel ------------------------- */

  test("an unsupported channel is refused and never dispatched as voice", async () => {
    /* REGRESSION. `decisionFor` is a two-way ternary, so before the
       explicit guard anything that was not "sms" was treated as voice -
       meaning a future "whatsapp" or "rcs" lane would have been
       authorized by the AI-VOICE consent record. */
    const mod = await import("../api/_lib/send-permission.mjs");
    assert.equal(typeof mod.authorizeSms, "function");
    assert.equal(typeof mod.authorizeAutomatedVoice, "function");
    /* Only these two lanes may be authorized at all. */
    const exported = Object.keys(mod).filter((k) => /^authorize/.test(k));
    assert.deepEqual(exported.sort(), ["authorizeAutomatedVoice", "authorizeSms"],
      "a third authorize* entry point exists and is not covered by these tests");
    assert.ok(REASON.UNSUPPORTED_CHANNEL, "there is no reason code for an unknown channel");
  });
});
