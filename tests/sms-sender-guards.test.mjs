/* The outbound sender's guards — permanent mutation cases.
 * =====================================================================
 * tests/sms-sender.test.mjs proves what the sender DOES. This file
 * proves the repository REFUSES the refactors that would quietly undo
 * it — a reintroduced gate 8 override, a second send site, a send from
 * somewhere else, a suspension point between the decision and the send,
 * a raw REST bypass, an endpoint reaching for the dark sender, and the
 * two runtime invariants an independent review of PR #51 found missing.
 *
 * TWO KINDS OF CASE, and they are not interchangeable:
 *
 *   STATIC   — break one invariant in a throwaway copy of the tree and
 *              assert the real `tools/check.mjs` refuses it, with the
 *              message that invariant owns.
 *   RUNTIME  — break one invariant in a throwaway copy and assert the
 *              real `tests/sms-sender.test.mjs` FAILS. Some invariants
 *              cannot be read off the source (whether a 4xx is
 *              classified as a refusal, whether a malformed call
 *              throws), and for those the test suite is the guard. A
 *              suite nobody has seen fail is a suite nobody knows works.
 *              This file is deliberately NOT in the copy's run, so the
 *              cases cannot recurse into themselves.
 *
 * Every mutation asserts its target is present BEFORE it is applied and
 * that the text actually changed. A mutation test that does not mutate
 * reports green while proving nothing, which this project has already
 * shipped once.
 *
 * THE LIMIT, STATED. The adjacency guard proves there is no suspension
 * point between the two call sites IN THE SENDER'S OWN SOURCE. It
 * cannot prove adjacency in general: move the authorization into a
 * helper two frames away and no regex would notice. That case is
 * carried by "the observable order is authorize then create" in the
 * behavioural file, which watches the real call order through an
 * injected double. The containment guards likewise constrain the shapes
 * they name, and a name assembled from fragments at runtime defeats
 * them. The working tree is never mutated.
 */

import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SENDER = "api/_lib/sms-sender.mjs";
const GATE8 = "api/_lib/send-permission.mjs";
const LEAD = "api/lead.js";
const BEHAVIOUR = "tests/sms-sender.test.mjs";
const GATE8_BEHAVIOUR = "tests/send-permission.test.mjs";

describe("the outbound sender guards", () => {
  let dir, root;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cst-sender-guard-"));
    root = join(dir, "tree");
    for (const item of ["src", "assets", "tools", "api", "db", "tests", "package.json",
                        "robots.txt", "site.webmanifest", ".env.example"])
      cpSync(join(REPO, item), join(root, item), { recursive: true });
    /* node_modules is SYMLINKED, not copied: the behavioural suite
       imports the real twilio SDK and must keep doing so — the whole
       point of the classification tests is that the SDK decides which
       exception class it throws. Copying 44 MB would add no evidence. */
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
    /* This file must NOT run inside the copy — the runtime cases below
       invoke the behavioural suite there, and a copy of this file would
       build another tree from inside it. */
    rmSync(join(root, "tests", "sms-sender-guards.test.mjs"), { force: true });
    execFileSync(process.execPath, ["tools/build.mjs"], { cwd: root, stdio: "pipe" });
  });
  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const pristine = (rel) => readFileSync(join(REPO, rel), "utf8");
  afterEach(() => {
    for (const rel of [SENDER, GATE8, LEAD, BEHAVIOUR, GATE8_BEHAVIOUR])
      writeFileSync(join(root, rel), pristine(rel));
  });

  /* NODE_TEST_CONTEXT MUST NOT BE INHERITED. Node sets it in every test
     process; a nested `node --test` that sees it behaves as a child
     reporter and exits 0 whatever its tests did. Inheriting it made an
     earlier version of the six runtime cases below report the mutated
     suite as PASSING in ~70ms — a mutation harness that proves nothing
     while looking green, which is the exact failure this file's own
     header warns about. */
  const { NODE_TEST_CONTEXT, ...CHILD_ENV } = process.env;

  function run(args) {
    try {
      const out = execFileSync(process.execPath, args,
        { cwd: root, stdio: "pipe", env: CHILD_ENV });
      return { ok: true, output: String(out || "") };
    } catch (err) {
      return { ok: false, output: String(err.stdout || "") + String(err.stderr || "") };
    }
  }
  const runCheck = () => run(["tools/check.mjs"]);
  const runBehaviour = (file = BEHAVIOUR) => run(["--test", file]);

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

  function refusedByCheck(pattern, why) {
    const { ok, output } = runCheck();
    assert.ok(!ok, `check.mjs accepted ${why}`);
    assert.match(output, pattern);
  }

  function caughtByTests(why, file = BEHAVIOUR) {
    const { ok, output } = runBehaviour(file);
    assert.ok(!ok, `the behavioural suite passed with ${why}`);
    return output;
  }

  /* ===================================================================
     THE CONTROLS. Without them every assertion below could be passing
     because the copied tree was already broken.
     =================================================================== */

  test("the copied tree passes tools/check.mjs before anything is broken", () => {
    const { ok, output } = runCheck();
    assert.ok(ok, "an unmodified copy already fails check.mjs:\n" + output);
  });

  test("the copied tree passes the behavioural suite before anything is broken", () => {
    const { ok, output } = runBehaviour();
    assert.ok(ok, "an unmodified copy already fails the sender tests:\n" + output.slice(-4000));
  });

  test("the copied tree passes the gate 8 suite before anything is broken", () => {
    const { ok, output } = runBehaviour(GATE8_BEHAVIOUR);
    assert.ok(ok, "an unmodified copy already fails the gate 8 tests:\n" + output.slice(-4000));
  });

  /* ===================================================================
     1  GATE 8 CANNOT BE SWAPPED AT RUNTIME
     ===================================================================
     The finding an independent review raised against head 8b2ec3b: the
     module shipped `_setAuthorizer()`, so any importer could replace
     gate 8 with `async () => ({ allowed: true })`. Proving the DEFAULT
     pointed at gate 8 never addressed it.
     =================================================================== */

  test("reintroducing an exported authorizer setter is refused", () => {
    append(SENDER, "\nexport function _setAuthorizer(fn) { authorizeOverride = fn; }\n");
    refusedByCheck(/exports a _set\* mutator/,
      "a runtime switch for gate 8 back inside the production module");
  });

  test("reintroducing a module-scope mutable binding is refused", () => {
    append(SENDER, "\nlet authorizeOverride = authorizeSms;\n");
    refusedByCheck(/module-scope mutable binding/,
      "something the send path could look up and something else could rewrite");
  });

  test("a module-scope `var` is refused too", () => {
    append(SENDER, "\nvar clientOverride = realClient;\n");
    refusedByCheck(/module-scope mutable binding/, "a var-shaped runtime switch");
  });

  test("binding the exported sendSms to anything but gate 8 is refused", () => {
    mutate(SENDER, "export const sendSms = makeSender({ authorize: authorizeSms, clientFactory: realClient });",
      "export const sendSms = makeSender({ authorize: async () => ({ allowed: true }), clientFactory: realClient });");
    refusedByCheck(/not built over authorizeSms/,
      "a production sender that authorizes itself");
  });

  test("binding the exported sendSms to a fake provider is refused", () => {
    mutate(SENDER, "export const sendSms = makeSender({ authorize: authorizeSms, clientFactory: realClient });",
      "export const sendSms = makeSender({ authorize: authorizeSms, clientFactory: () => ({ messages: {} }) });");
    refusedByCheck(/not built over realClient/, "a production sender wired to something other than Twilio");
  });

  test("another api/ module using the test-only sender factory is refused", () => {
    append(LEAD, "\nimport { _senderForTest } from \"./_lib/sms-sender.mjs\";\n" +
      "export const back = _senderForTest({ authorize: async () => ({ allowed: true }) });\n");
    refusedByCheck(/builds a sender over injected boundaries|deliberately unreachable/,
      "production code building its own sender over boundaries of its choosing");
  });

  /* ===================================================================
     1b  GATE 8 ITSELF CANNOT BE SWAPPED AT RUNTIME
     ===================================================================
     Found during the correction-verification pass, one layer below the
     sender: `_setSuppressionExecutor(async () => [])` turned a number
     carrying a durable SMS block from
     `{ allowed: false, reason: "DURABLE_SMS_BLOCK" }` into
     `{ allowed: true, reason: "ALLOWED" }`. Same shape, higher stakes —
     a sender that cannot replace gate 8 is still bypassable if gate 8
     can be converted into an always-allow.
     =================================================================== */

  test("reintroducing an exported executor setter in gate 8 is refused", () => {
    append(GATE8, "\nexport function _setSuppressionExecutor(fn) { executorOverride = fn; }\n");
    refusedByCheck(/exports a _set\*\/_reset\* mutator/,
      "a runtime switch that can turn a gate 8 deny into an allow");
  });

  test("a module-scope mutable binding in gate 8 is refused", () => {
    append(GATE8, "\nlet executorOverride = neonExecutor;\n");
    refusedByCheck(/module-scope mutable binding/,
      "something gate 8 could look up and something else could rewrite");
  });

  test("binding gate 8 to a fake suppression executor is refused", () => {
    mutate(GATE8, "const GATE = makeGate({ suppressionExecutor: neonExecutor, contactLookup: findContactByEmail });",
      "const GATE = makeGate({ suppressionExecutor: async () => [], contactLookup: findContactByEmail });");
    refusedByCheck(/not built over neonExecutor/,
      "a gate 8 whose durable suppression read is fabricated");
  });

  test("binding gate 8 to a fake consent read is refused", () => {
    mutate(GATE8, "const GATE = makeGate({ suppressionExecutor: neonExecutor, contactLookup: findContactByEmail });",
      "const GATE = makeGate({ suppressionExecutor: neonExecutor, contactLookup: async () => null });");
    refusedByCheck(/not built over findContactByEmail/,
      "a gate 8 whose consent read is fabricated");
  });

  test("exporting authorizeSms from anything but the bound gate is refused", () => {
    mutate(GATE8, "export const authorizeSms = GATE.authorizeSms;",
      "export const authorizeSms = (a, o) => authorizeWith({ suppressionExecutor: async () => [], contactLookup: findContactByEmail }, \"sms\", a, o);");
    refusedByCheck(/authorizeSms is not exported from the bound gate/,
      "an export that carries boundaries of its own choosing");
  });

  test("another api/ module using the test-only gate factory is refused", () => {
    append(LEAD, "\nimport { _gateForTest } from \"./_lib/send-permission.mjs\";\n" +
      "export const g = _gateForTest({ suppressionExecutor: async () => [] });\n");
    refusedByCheck(/only api\/_lib\/send-permission\.mjs may name _gateForTest/,
      "production code building its own gate 8");
  });

  test("letting a test gate share the exported gate's boundaries fails the gate 8 suite", () => {
    /* No static reading can tell whether _gateForTest() hands back an
       independent gate or the shipped one. The suite is the guard. */
    mutate(GATE8, `export function _gateForTest({
  suppressionExecutor = neonExecutor,
  contactLookup = findContactByEmail,
} = {}) {
  return makeGate({ suppressionExecutor, contactLookup });
}`,
      `export function _gateForTest() {
  return GATE;
}`);
    const output = caughtByTests("_gateForTest() handing back the shipped gate", GATE8_BEHAVIOUR);
    assert.match(output, /DIFFERENT function|share boundaries|bypass/,
      "the gate 8 suite failed, but not on the non-replaceability invariant");
  });

  /* ===================================================================
     2  CONTAINMENT — one send site, and it is the sender
     =================================================================== */

  test("a second message-create site in the sender is refused", () => {
    mutate(SENDER, "    return { status: SMS_STATUS.ACCEPTED, message_sid: sid };",
      "    if (sid === null) await client.messages.create({ to, body: text });\n" +
      "    return { status: SMS_STATUS.ACCEPTED, message_sid: sid };");
    refusedByCheck(/exactly one/, "a sender with two provider side-effect sites");
  });

  test("computed access to create() inside the sender is refused", () => {
    mutate(SENDER, "      result = await client.messages.create({",
      "      result = await client.messages[\"create\"]({");
    refusedByCheck(/computed access|exactly one/,
      "a send site shaped so the counter cannot see it");
  });

  test("another api/ module creating a Twilio message is refused", () => {
    append(LEAD, "\nexport async function elsewhere(client) {\n" +
      "  return client.messages.create({ to: \"+14195550000\", body: \"hi\" });\n}\n");
    refusedByCheck(/only api\/_lib\/sms-sender\.mjs may cause an outbound Twilio side effect/,
      "a send from outside the designated sender");
  });

  test("another api/ module reaching create() by computed access is refused", () => {
    append(LEAD, "\nexport const go = (c) => c.messages[\"create\"]({ body: \"hi\" });\n");
    refusedByCheck(/computed access/, "a bracket-access bypass of the send guard");
  });

  test("another api/ module reaching the messages resource by computed access is refused", () => {
    append(LEAD, "\nexport const go2 = (c) => c[\"messages\"].create({ body: \"hi\" });\n");
    refusedByCheck(/computed access/, "a bracket-access bypass on the resource");
  });

  test("another api/ module taking a BARE REFERENCE to create is refused", () => {
    /* No call parenthesis at all — the shape the first version of this
       guard missed, because it required `create(`. */
    append(LEAD, "\nexport const grab = (c) => { const fn = c.messages.create; return fn; };\n");
    refusedByCheck(/reaches the Twilio message-create API/,
      "a reference to the send function handed out of the sender");
  });

  test("another api/ module DESTRUCTURING create() off messages is refused", () => {
    /* The one shape on the reviewer's list that the first three patterns
       missed: the text never contains "messages.create". */
    append(LEAD, "\nexport const go3 = (c) => { const { create } = c.messages; return create({}); };\n");
    refusedByCheck(/destructures create\(\) off a Twilio messages resource/,
      "a destructuring bypass of the send guard");
  });

  test("another api/ module aliasing the messages resource is refused", () => {
    append(LEAD, "\nexport const go4 = (c) => { const messages = c.messages; return messages.create({}); };\n");
    refusedByCheck(/reaches the Twilio message-create API/, "an aliased messages resource");
  });

  test("another api/ module re-exporting the sender is refused", () => {
    append(LEAD, "\nexport { sendSms } from \"./_lib/sms-sender.mjs\";\n");
    refusedByCheck(/deliberately unreachable/, "a re-export of the dark sender");
  });

  test("another api/ module constructing a Twilio client is refused", () => {
    append(LEAD, "\nimport twilioSdk from \"twilio\";\n" +
      "export const client = twilio(\"SK\", \"secret\", {});\n");
    refusedByCheck(/constructs a Twilio API client/, "a Twilio client built outside the sender");
  });

  test("another api/ module reading an outbound Twilio credential is refused", () => {
    append(LEAD, "\nexport const svc = process.env.TWILIO_MESSAGING_SERVICE_SID;\n");
    refusedByCheck(/reads an outbound Twilio credential/,
      "the outbound sender identity read outside the sender");
  });

  test("the sender reading TWILIO_AUTH_TOKEN is refused", () => {
    /* The inbound master secret. Reaching for it from the outbound path
       would undo the whole reason outbound has its own key pair. */
    append(SENDER, "\nexport const fallbackToken = process.env.TWILIO_AUTH_TOKEN;\n");
    refusedByCheck(/reads TWILIO_AUTH_TOKEN/,
      "the outbound sender reaching for the inbound master credential");
  });

  test("a raw Twilio REST send from the SENDER is refused", () => {
    mutate(SENDER, "    let result;",
      "    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`);\n" +
      "    let result;");
    refusedByCheck(/addresses the Twilio REST API directly/,
      "a hand-rolled REST call that bypasses the SDK");
  });

  test("a raw Twilio REST send from another api/ module is refused", () => {
    append(LEAD, "\nexport const send = (b) => fetch(\"https://api.twilio.com/2010-04-01/Accounts/AC/Messages.json\", { method: \"POST\", body: b });\n");
    refusedByCheck(/addresses the Twilio REST API directly/, "a REST bypass outside the sender");
  });

  /* ===================================================================
     3  DARKNESS
     =================================================================== */

  test("an endpoint importing the sender is refused while outbound is dark", () => {
    append(LEAD, "\nimport { sendSms } from \"./_lib/sms-sender.mjs\";\n");
    refusedByCheck(/deliberately unreachable/,
      "an endpoint wired to the sender while outbound messaging is dark");
  });

  test("a namespace import of the sender is refused too", () => {
    append(LEAD, "\nimport * as outbound from \"./_lib/sms-sender.mjs\";\nexport const o = outbound;\n");
    refusedByCheck(/deliberately unreachable/, "a namespace import of the dark sender");
  });

  test("a dynamic import of the sender is refused too", () => {
    append(LEAD, "\nexport const later = () => import(\"./_lib/sms-sender.mjs\");\n");
    refusedByCheck(/deliberately unreachable/, "a deferred import of the dark sender");
  });

  /* ===================================================================
     4  ADJACENCY — nothing between the decision and the send
     =================================================================== */

  const DENIAL = "    if (!decision || decision.allowed !== true) return notSent(SMS_REASON.NOT_AUTHORIZED);";

  for (const [label, inserted] of [
    ["an await", "    await Promise.resolve();"],
    ["a .then()", "    Promise.resolve().then(() => {});"],
    ["a timer", "    setTimeout(() => {}, 0);"],
    ["a queueMicrotask", "    queueMicrotask(() => {});"],
    ["a new Promise", "    const p = new Promise((r) => r());"],
  ]) {
    test(`${label} between the gate 8 decision and the send is refused`, () => {
      mutate(SENDER, DENIAL, DENIAL + "\n" + inserted);
      refusedByCheck(/between the gate 8 decision and the Twilio send/,
        `${label} opened between authorization and the provider call`);
    });
  }

  test("an await inside the send's OWN ARGUMENTS is refused", () => {
    /* It resolves before the request is made, so it sits in exactly the
       window the region guard exists to close — and it falls outside the
       region, which ends where the call begins. */
    mutate(SENDER, "create({ to, body: text, messagingServiceSid: config.messagingServiceSid })",
      "create({ to, body: await Promise.resolve(text), messagingServiceSid: config.messagingServiceSid })");
    refusedByCheck(/inside the Twilio send's own arguments/,
      "a suspension point smuggled into the provider call's argument list");
  });

  test("weakening the denial to `allowed === false` is refused", () => {
    mutate(SENDER, "!decision || decision.allowed !== true",
      "decision && decision.allowed === false");
    refusedByCheck(/allowed !== true/,
      "a denial shape that lets a malformed or missing decision through");
  });

  test("deleting the denial entirely is refused", () => {
    mutate(SENDER, DENIAL + "\n", "");
    refusedByCheck(/allowed !== true/, "a sender with no refusal between gate 8 and the send");
  });

  test("authorizing AFTER the send is refused", () => {
    const AUTH = "      decision = await authorize({ email, phone: to }, { env });";
    const SEND = "      result = await client.messages.create({ to, body: text, messagingServiceSid: config.messagingServiceSid });";
    const src = pristine(SENDER);
    assert.ok(src.includes(AUTH) && src.includes(SEND),
      "a call site moved — this test would prove nothing");
    const out = src
      .replace(AUTH, "      decision = { allowed: true };")
      .replace(SEND, SEND + "\n      await authorize({ email, phone: to }, { env });");
    assert.notEqual(out, src, "the mutation changed nothing");
    writeFileSync(join(root, SENDER), out);
    refusedByCheck(/sends before it authorizes/, "a sender that texts first and asks gate 8 afterwards");
  });

  /* ===================================================================
     5  THE FLAG
     =================================================================== */

  test("checking the outbound flag after gate 8 is refused", () => {
    mutate(SENDER, "    if (!outboundSmsEnabled(env)) return notSent(SMS_REASON.DISABLED);", "");
    refusedByCheck(/before checking the outbound feature flag/,
      "a dark sender that still reaches HubSpot and Neon through gate 8");
  });

  test("a non-strict outbound flag is refused", () => {
    mutate(SENDER, 'readEnv(env, OUTBOUND_SMS_FLAG) === "true"',
      'readEnv(env, OUTBOUND_SMS_FLAG) !== "false"');
    refusedByCheck(/strictly to "true"|loosely/,
      "a flag that switches outbound messaging on by default");
  });

  /* ===================================================================
     6  THE RUNTIME INVARIANTS — the suite is the guard
     ===================================================================
     Nothing in the source text says whether a 4xx is read as a refusal
     or whether a malformed call throws. These prove the behavioural
     suite actually catches it when they stop being true.
     =================================================================== */

  test("misclassifying a provider-confirmed rejection as UNKNOWN fails the suite", () => {
    mutate(SENDER, "      const rejected = providerRejection(err);\n      if (rejected) return notSent(rejected);\n",
      "");
    const output = caughtByTests("every provider error collapsed back into unknown");
    assert.match(output, /DEFINITELY NOT SENT/,
      "the suite failed, but not on the rejection classification");
  });

  test("misclassifying an ambiguous failure as NOT SENT fails the suite", () => {
    mutate(SENDER, "      const rejected = providerRejection(err);\n      if (rejected) return notSent(rejected);\n",
      "      return notSent(SMS_REASON.REJECTED);\n");
    const output = caughtByTests("a timeout reported as definitely not sent");
    assert.match(output, /UNKNOWN/, "the suite failed, but not on the ambiguity classification");
  });

  test("trusting a forged error's status field fails the suite", () => {
    /* Duck typing instead of identity: exactly the bypass the
       `instanceof` check exists to refuse. */
    mutate(SENDER, `  const answered =
    (typeof RestException === "function" && err instanceof RestException) ||
    (typeof TwilioServiceException === "function" && err instanceof TwilioServiceException);
  if (!answered) return null;`,
      "  if (!err || typeof err !== \"object\") return null;");
    const output = caughtByTests("an arbitrary thrown object accepted as proof of refusal");
    assert.match(output, /FORGED/, "the suite failed, but not on the forgery case");
  });

  test("letting a malformed call throw fails the suite", () => {
    mutate(SENDER, `      if (message === null || typeof message !== "object" || Array.isArray(message))
        return notSent(SMS_REASON.MALFORMED_CALL);
      ({ email, phone, body } = message);`,
      "      ({ email, phone, body } = message);");
    caughtByTests("a malformed call rejecting instead of refusing");
  });

  test("letting a malformed options object through fails the suite", () => {
    mutate(SENDER, `      } else if (options === null || typeof options !== "object" || Array.isArray(options)) {
        return notSent(SMS_REASON.MALFORMED_CALL);`,
      `      } else if (false) {
        return notSent(SMS_REASON.MALFORMED_CALL);`);
    caughtByTests("malformed options reinterpreted instead of refused");
  });

  test("retrying the provider call once fails the suite", () => {
    mutate(SENDER, "      const rejected = providerRejection(err);",
      "      await client.messages.create({ to, body: text, messagingServiceSid: config.messagingServiceSid });\n" +
      "      const rejected = providerRejection(err);");
    /* This one is caught twice over: check.mjs counts two send sites,
       and the suite counts two attempts. Assert the SUITE catches it,
       because that is the invariant with no static reading. */
    const output = caughtByTests("a second provider attempt after a failure");
    assert.match(output, /EXACTLY ONE attempt|retried/,
      "the suite failed, but not on the one-attempt invariant");
  });
});
