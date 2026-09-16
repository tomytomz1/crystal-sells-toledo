/* Gate 8 — send-time permission enforcement.
 *
 * Tier 4: this is the compliance boundary a future Twilio/Retell sender must
 * cross immediately before a side effect. These tests assert the important
 * negative property from the boundary's side: if authoritative suppression
 * state cannot be obtained and interpreted, the answer is DENY.
 *
 * Database fold semantics and the sender role's real privileges are already
 * exercised against PostgreSQL by tests/unsuppression-fold.test.mjs. This file
 * proves the application-side query, union and failure semantics. It does NOT
 * claim a live Neon request has been made.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FEATURE_FLAG, PERMISSION_STATE } from "../api/_lib/consent.mjs";
import { REASON } from "../api/_lib/permission.mjs";
import {
  SENDER_LEDGER_URL_VAR, SUPPRESSION_QUERY, SEND_TIME_REASON,
  canSendSmsNow, canPlaceAutomatedVoiceCallNow, withDurableSuppression,
  _setSuppressionLookupExecutor, _resetSuppressionLookupExecutor,
} from "../api/_lib/send-permission.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const { GRANTED, NEVER_GRANTED, SUPPRESSED } = PERMISSION_STATE;
const PHONE = "(419) 555-1234";
const E164 = "+14195551234";
const ENV = {
  [FEATURE_FLAG]: "true",
  [SENDER_LEDGER_URL_VAR]: "postgresql://sender:secret@example.invalid/neondb",
};

function state({ sms = false, voice = false, suppression = {} } = {}) {
  const grant = () => ({
    status: GRANTED,
    consent_phone: PHONE,
    consent_at: "2026-09-16T00:00:00.000Z",
    consent_version: "v1",
  });
  return {
    sms: sms ? grant() : { status: NEVER_GRANTED },
    ai_voice: voice ? grant() : { status: NEVER_GRANTED },
    suppression,
  };
}

function capture(result = []) {
  const calls = [];
  _setSuppressionLookupExecutor(async (text, params, opts) => {
    calls.push({ text, params, opts });
    if (result instanceof Error) throw result;
    return typeof result === "function" ? result(calls.length, opts) : result;
  });
  return calls;
}

const block = (channel, at = "2026-09-16T00:10:00.000Z") =>
  ({ channel, suppressed_at: at });

afterEach(() => _resetSuppressionLookupExecutor());

describe("local/current-state denials short-circuit before the durable read", () => {
  test("feature off denies and sends no query", async () => {
    const calls = capture();
    const got = await canSendSmsNow(state({ sms: true }), PHONE, { env: {} });
    assert.deepEqual(got, { allowed: false, reason: REASON.FEATURE_DISABLED });
    assert.equal(calls.length, 0);
  });

  test("no SMS consent denies and sends no query", async () => {
    const calls = capture();
    const got = await canSendSmsNow(state(), PHONE, { env: ENV });
    assert.deepEqual(got, { allowed: false, reason: REASON.NO_CONSENT });
    assert.equal(calls.length, 0);
  });

  test("HubSpot/current SMS suppression denies and sends no query", async () => {
    const calls = capture();
    const got = await canSendSmsNow(state({ sms: true, suppression: { sms: { reason: "stop" } } }), PHONE, { env: ENV });
    assert.deepEqual(got, { allowed: false, reason: REASON.SMS_SUPPRESSED_STOP });
    assert.equal(calls.length, 0);
  });

  test("a suppressed channel status also denies before the lookup", async () => {
    const s = state({ sms: true });
    s.sms.status = SUPPRESSED;
    const calls = capture();
    const got = await canSendSmsNow(s, PHONE, { env: ENV });
    assert.deepEqual(got, { allowed: false, reason: REASON.SMS_SUPPRESSED_STOP });
    assert.equal(calls.length, 0);
  });
});

describe("the durable fold is queried by E.164 destination immediately before allow", () => {
  test("no durable block preserves an otherwise-valid SMS grant", async () => {
    const calls = capture([]);
    const got = await canSendSmsNow(state({ sms: true }), PHONE, { env: ENV });
    assert.deepEqual(got, { allowed: true, reason: REASON.ALLOWED });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, SUPPRESSION_QUERY);
    assert.deepEqual(calls[0].params, [E164]);
    assert.equal(calls[0].opts.url, ENV[SENDER_LEDGER_URL_VAR]);
    assert.equal(calls[0].opts.signal instanceof AbortSignal, true);
  });

  test("an SMS lane from the durable ledger blocks SMS", async () => {
    capture([block("sms")]);
    const got = await canSendSmsNow(state({ sms: true }), PHONE, { env: ENV });
    assert.deepEqual(got, { allowed: false, reason: REASON.SMS_SUPPRESSED_STOP });
  });

  test("an AI-voice lane from the durable ledger blocks voice", async () => {
    capture([block("ai_voice")]);
    const got = await canPlaceAutomatedVoiceCallNow(state({ voice: true }), PHONE, { env: ENV });
    assert.deepEqual(got, { allowed: false, reason: REASON.VOICE_DNC });
  });

  test("the all lane blocks both channels", async () => {
    capture([block("all")]);
    assert.deepEqual(
      await canSendSmsNow(state({ sms: true }), PHONE, { env: ENV }),
      { allowed: false, reason: REASON.GLOBAL_DNC });
    capture([block("all")]);
    assert.deepEqual(
      await canPlaceAutomatedVoiceCallNow(state({ voice: true }), PHONE, { env: ENV }),
      { allowed: false, reason: REASON.GLOBAL_DNC });
  });

  test("channel isolation is preserved", async () => {
    capture([block("ai_voice")]);
    assert.deepEqual(
      await canSendSmsNow(state({ sms: true }), PHONE, { env: ENV }),
      { allowed: true, reason: REASON.ALLOWED });

    capture([block("sms")]);
    assert.deepEqual(
      await canPlaceAutomatedVoiceCallNow(state({ voice: true }), PHONE, { env: ENV }),
      { allowed: true, reason: REASON.ALLOWED });
  });

  test("the destination actually being contacted is the lookup key", async () => {
    const calls = capture([]);
    const got = await canSendSmsNow(state({ sms: true }), "1 419 555 1234", { env: ENV });
    assert.equal(got.allowed, true);
    assert.deepEqual(calls[0].params, [E164]);
  });

  test("there is no cache: two otherwise-sendable attempts cause two reads", async () => {
    const calls = capture([]);
    const s = state({ sms: true });
    assert.equal((await canSendSmsNow(s, PHONE, { env: ENV })).allowed, true);
    assert.equal((await canSendSmsNow(s, PHONE, { env: ENV })).allowed, true);
    assert.equal(calls.length, 2, "a prior clean read was reused at send time");
  });
});

describe("authoritative-read failures fail closed", () => {
  test("missing sender credential is a denial", async () => {
    const calls = capture([]);
    const got = await canSendSmsNow(state({ sms: true }), PHONE, {
      env: { [FEATURE_FLAG]: "true" },
    });
    assert.deepEqual(got, { allowed: false, reason: SEND_TIME_REASON.LOOKUP_NOT_CONFIGURED });
    assert.equal(calls.length, 0);
  });

  test("a driver failure is a denial and its text never escapes", async () => {
    const secretText = "postgresql://sender:password@private-host/neondb";
    capture(new Error(secretText));
    const got = await canSendSmsNow(state({ sms: true }), PHONE, { env: ENV });
    assert.deepEqual(got, { allowed: false, reason: SEND_TIME_REASON.LOOKUP_FAILED });
    assert.ok(!JSON.stringify(got).includes("private-host"));
    assert.ok(!JSON.stringify(got).includes("password"));
  });

  test("a read that misses its deadline is a denial", async () => {
    _setSuppressionLookupExecutor(() => new Promise(() => {}));
    const got = await canSendSmsNow(state({ sms: true }), PHONE, { env: ENV, timeoutMs: 5 });
    assert.deepEqual(got, { allowed: false, reason: SEND_TIME_REASON.LOOKUP_TIMEOUT });
  });

  for (const [label, rows] of [
    ["non-array response", { channel: "sms" }],
    ["null response", null],
    ["primitive row", ["sms"]],
    ["unknown lane", [block("voice")]],
    ["missing timestamp", [{ channel: "sms" }]],
    ["invalid timestamp", [{ channel: "sms", suppressed_at: "not-a-time" }]],
    ["duplicate lane", [block("sms"), block("sms", "2026-09-16T00:11:00Z")]],
  ]) {
    test(`${label} is malformed and therefore denied`, async () => {
      capture(rows);
      const got = await canSendSmsNow(state({ sms: true }), PHONE, { env: ENV });
      assert.deepEqual(got, { allowed: false, reason: SEND_TIME_REASON.LOOKUP_MALFORMED });
    });
  }
});

describe("union semantics do not mutate or clear caller-owned state", () => {
  test("withDurableSuppression returns a new state and a new suppression object", () => {
    const before = state({ sms: true, suppression: { voice: { reason: "existing" } } });
    const snapshot = structuredClone(before);
    const after = withDurableSuppression(before, [block("sms")]);

    assert.notEqual(after, before);
    assert.notEqual(after.suppression, before.suppression);
    assert.deepEqual(before, snapshot, "the caller's current state was mutated");
    assert.equal(after.suppression.voice.reason, "existing");
    assert.equal(after.suppression.sms.reason, "durable_ledger");
  });

  test("a durable clean result never clears an existing HubSpot block", () => {
    const before = state({ sms: true, suppression: { sms: { reason: "existing" } } });
    const after = withDurableSuppression(before, []);
    assert.deepEqual(after.suppression, before.suppression);
  });
});

describe("static integration guardrails", () => {
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

  test("no API sender may bypass Gate 8 by importing the pure send decision directly", () => {
    const api = join(REPO, "api");
    const offenders = [];
    const importRe = /import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;
    for (const file of walk(api)) {
      if (!/\.(?:mjs|js)$/.test(file)) continue;
      if (file.endsWith("/permission.mjs") || file.endsWith("/send-permission.mjs")) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(importRe)) {
        const [, names, source] = match;
        if (!/permission\.mjs$/.test(source)) continue;
        if (/\bcanSendSms\b|\bcanPlaceAutomatedVoiceCall\b/.test(names))
          offenders.push(file.slice(REPO.length + 1));
      }
    }
    assert.deepEqual([...new Set(offenders)], [],
      "an API module imports a pure send decision instead of the durable Gate 8 boundary");
  });

  test("the sender credential name appears in no client-delivered source", () => {
    const offenders = [];
    for (const root of [join(REPO, "src"), join(REPO, "assets")]) {
      for (const file of walk(root)) {
        if (!statSync(file).isFile()) continue;
        let text;
        try { text = readFileSync(file, "utf8"); } catch { continue; }
        if (text.includes(SENDER_LEDGER_URL_VAR)) offenders.push(file.slice(REPO.length + 1));
      }
    }
    assert.deepEqual(offenders, [], "the Gate 8 database credential reached client source");
  });
});
