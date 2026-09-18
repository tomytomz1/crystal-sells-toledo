import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import handler, {
  UNSUPPRESS_CONFIRM_LITERAL, MIN_ATTESTATION_CHARS,
} from "../api/operator-unsuppress.js";
import {
  UNSUPPRESS_SECRET_VAR, sealUnsuppressToken,
} from "../api/_lib/operator-unsuppress-token.mjs";
import {
  OPERATOR_LEDGER_URL_VAR, _setOperatorLedgerExecutor, _resetOperatorLedgerExecutor,
} from "../api/_lib/operator-ledger.mjs";
import { _setExecutor, _resetExecutor } from "../api/_lib/consent-ledger.mjs";

const SECRET = "endpoint_unsuppress_test_secret_0123456789";
const DB = "postgres://operator:not-real@ledger.example/neondb";
const PHONE = "+14195550123";
const LAST4 = "0123";
const AID = "approval_endpoint_0123456789";
const SID1 = "SM0123456789abcdef0123456789abcdef";
const SID2 = "SMfedcba9876543210fedcba9876543210";
const ATTESTATION = "Consumer asked on 2026-09-18 to restore this communication channel.";

const envKeys = [UNSUPPRESS_SECRET_VAR, OPERATOR_LEDGER_URL_VAR, "COMMUNICATIONS_CONSENT_ENABLED"];
const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
let originalConsoleLog;

beforeEach(() => {
  process.env[UNSUPPRESS_SECRET_VAR] = SECRET;
  process.env[OPERATOR_LEDGER_URL_VAR] = DB;
  process.env.COMMUNICATIONS_CONSENT_ENABLED = "false";
  originalConsoleLog = console.log;
});

afterEach(() => {
  _resetOperatorLedgerExecutor();
  _resetExecutor();
  console.log = originalConsoleLog;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function block(sid = SID1, { channel = "sms", reason = "stop_keyword" } = {}) {
  return {
    channel,
    dedupe_key: `twilio:${sid}:${channel}:suppressed`,
    event_type: "suppressed",
    reason_code: reason,
    source: "twilio",
    source_event_id: sid,
    occurred_at: "2026-09-17T12:00:00.000Z",
    recorded_at: "2026-09-17T12:00:01.000Z",
  };
}

function token(scope = "sms", approvalId = AID) {
  return sealUnsuppressToken({ approvalId, phone: PHONE, scope });
}

function req(method, { body, t } = {}) {
  return {
    method,
    url: method === "GET" && t
      ? `/api/operator-unsuppress?t=${encodeURIComponent(t)}`
      : "/api/operator-unsuppress",
    query: method === "GET" && t ? { t } : {},
    headers: {},
    body,
    complete: true,
  };
}

function res() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v); },
    end(v = "") { this.body += String(v); this.writableEnded = true; },
  };
}

function postBody(t, extra = {}) {
  return {
    t,
    confirm: UNSUPPRESS_CONFIRM_LITERAL,
    last4: LAST4,
    attestation: ATTESTATION,
    reason: "consumer_request",
    error_origin: "",
    ...extra,
  };
}

function ledgerReads({ active = [block()], lanes = [] } = {}) {
  _setOperatorLedgerExecutor(async (text) => {
    if (text.includes("get_active_blocks")) return active;
    if (text.includes("get_suppression_state"))
      return lanes.map((channel) => ({ channel, suppressed_at: "2026-09-17T12:00:00.000Z" }));
    throw new Error("unexpected operator query");
  });
}

describe("GET confirmation", () => {
  test("reads current state but cannot append or project", async () => {
    ledgerReads({ active: [block()] });
    _setExecutor(async () => assert.fail("GET reached the ledger append"));
    const r = res();
    await handler(req("GET", { t: token() }), r);
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /Review an unsuppression/);
    assert.match(r.body, /No consent was granted|does not grant consent/i);
  });

  test("the selectable blocking-event controls are inside the POST form", async () => {
    ledgerReads({ active: [block()] });
    const r = res();
    await handler(req("GET", { t: token() }), r);
    assert.equal(r.statusCode, 200);
    const formAt = r.body.indexOf('<form method="POST"');
    const targetAt = r.body.indexOf('name="target_0"');
    const formEnd = r.body.indexOf("</form>", formAt);
    assert.ok(formAt >= 0 && targetAt > formAt && targetAt < formEnd,
      "target checkbox must submit with the POST form");
  });
});

describe("POST refusals", () => {
  test("requires the confirmation literal before any durable read or write", async () => {
    let reads = 0;
    _setOperatorLedgerExecutor(async () => { reads += 1; return []; });
    _setExecutor(async () => assert.fail("append reached"));
    const r = res();
    await handler(req("POST", { body: { ...postBody(token()), confirm: "nope" } }), r);
    assert.equal(r.statusCode, 400);
    assert.equal(reads, 0);
  });

  test("requires matching last four and bounded attestation", async () => {
    ledgerReads();
    _setExecutor(async () => assert.fail("append reached"));

    let r = res();
    await handler(req("POST", { body: { ...postBody(token()), last4: "9999" } }), r);
    assert.equal(r.statusCode, 400);

    r = res();
    await handler(req("POST", { body: { ...postBody(token()), attestation: "x".repeat(MIN_ATTESTATION_CHARS - 1) } }), r);
    assert.equal(r.statusCode, 400);
  });

  test("recorded-in-error needs an origin and at least one still-active target", async () => {
    ledgerReads({ active: [block()] });
    _setExecutor(async () => assert.fail("append reached"));
    const t = token();

    let r = res();
    await handler(req("POST", { body: postBody(t, { reason: "recorded_in_error", error_origin: "" }) }), r);
    assert.equal(r.statusCode, 400);

    r = res();
    await handler(req("POST", { body: postBody(t, {
      reason: "recorded_in_error", error_origin: "classifier",
    }) }), r);
    assert.equal(r.statusCode, 400);

    r = res();
    await handler(req("POST", { body: postBody(t, {
      reason: "recorded_in_error", error_origin: "classifier",
      target_0: "twilio:SMno_longer_active:sms:suppressed",
    }) }), r);
    assert.equal(r.statusCode, 400);
    assert.match(r.body, /no longer active/i);
  });

  test("consumer-request clearance refuses individual error targets", async () => {
    ledgerReads({ active: [block()] });
    _setExecutor(async () => assert.fail("append reached"));
    const r = res();
    await handler(req("POST", { body: postBody(token(), { target_0: block().dedupe_key }) }), r);
    assert.equal(r.statusCode, 400);
    assert.match(r.body, /must not name individual error targets/i);
  });

  test("the sealed scope cannot be widened by POST fields", async () => {
    ledgerReads({ active: [block(undefined, { channel: "ai_voice" })] });
    _setExecutor(async () => assert.fail("append reached"));
    const r = res();
    await handler(req("POST", { body: postBody(token("sms"), { scope: "ai_voice" }) }), r);
    assert.equal(r.statusCode, 400);
    assert.match(r.body, /sealed lane no longer has an active blocking event/i);
  });
});

describe("POST durable transition", () => {
  test("a new consumer-request clearance appends once, post-reads, and reports no consent grant", async () => {
    ledgerReads({ active: [block()], lanes: [] });
    let appendCalls = 0;
    let insertParams = null;
    _setExecutor(async (_text, params) => {
      appendCalls += 1;
      insertParams = params;
      return { rowCount: 1, rows: [] };
    });

    const logs = [];
    console.log = (line) => logs.push(String(line));
    const r = res();
    await handler(req("POST", { body: postBody(token()) }), r);

    assert.equal(r.statusCode, 200);
    assert.equal(appendCalls, 1);
    assert.match(r.body, /A new unsuppression event was recorded/);
    assert.match(r.body, /No consent was granted/);
    assert.match(r.body, /SMS carrier\/Messaging Service opt-out state in Twilio was not changed/i);

    const metadata = insertParams.find((v) => typeof v === "string" && v.includes('"approval_id"'));
    assert.ok(metadata, "ledger insert did not carry metadata");
    const m = JSON.parse(metadata);
    assert.equal(m.approval_id, AID);
    assert.equal(m.approved_by, "operator");
    assert.equal(m.entered_via, "operator_unsuppress");
    assert.equal(m.twilio_reconciled, false);
    assert.deepEqual(m.invalidates, []);
    assert.equal(m.intent.observed_active.length, 1);

    const logged = logs.join("\n");
    assert.ok(!logged.includes(PHONE));
    assert.ok(!logged.includes(ATTESTATION));
    assert.ok(!logged.includes(block().dedupe_key));
  });

  test("replaying an old approval after a later STOP inserts zero and cannot project", async () => {
    ledgerReads({ active: [block(SID2)], lanes: ["sms"] });
    _setExecutor(async () => ({ rowCount: 0, rows: [] }));
    const r = res();
    await handler(req("POST", { body: postBody(token()) }), r);
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /No new unsuppression event was recorded/);
    assert.match(r.body, /Effective durable blocks now: <strong>SMS<\/strong>/);
    assert.match(r.body, /CRM projection was deliberately skipped because no new ledger row was confirmed/i);
  });

  test("targeted correction records only selected active keys and a surviving block stays blocked", async () => {
    const b1 = block(SID1);
    const b2 = block(SID2);
    ledgerReads({ active: [b1, b2], lanes: ["sms"] });
    let params;
    _setExecutor(async (_text, p) => { params = p; return { rowCount: 1, rows: [] }; });

    const r = res();
    await handler(req("POST", { body: postBody(token(), {
      reason: "recorded_in_error",
      error_origin: "classifier",
      target_0: b1.dedupe_key,
    }) }), r);
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /Effective durable blocks now: <strong>SMS<\/strong>/);
    assert.match(r.body, /no communication channel became unblocked/i);

    const metadata = params.find((v) => typeof v === "string" && v.includes('"approval_id"'));
    const m = JSON.parse(metadata);
    assert.deepEqual(m.invalidates, [b1.dedupe_key]);
    assert.equal(m.error_origin, "classifier");
    assert.equal(m.intent.targets.length, 1);
    assert.equal(m.intent.observed_active.length, 2);
  });
});
