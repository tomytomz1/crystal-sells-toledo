/* Gate 8 + outbound SMS security guards.
 *
 * This file is intentionally separate from the site's long-standing static
 * checker. PR #51 was reconciled after Turnstile and operator-unsuppression
 * added new guards to tools/check.mjs on main. Keeping those later guards
 * byte-for-byte and composing this checker from a tiny wrapper avoids a
 * conflict resolution that could silently discard either protection set.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = join(REPO, "api");
const PUBLIC = join(REPO, "public");
const errors = [];
const fail = (file, message) => errors.push(`${file}: ${message}`);
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? walk(join(dir, entry.name))
    : /\.(?:mjs|js)$/.test(entry.name) ? [join(dir, entry.name)] : []);

/* Outbound credentials are server-side only. The original site checker still
 * owns all pre-existing secret names; these are new with the sender. */
if (existsSync(PUBLIC)) {
  const publicFiles = readdirSync(PUBLIC).filter((name) => name.endsWith(".html"))
    .map((name) => join(PUBLIC, name));
  for (const rel of ["assets/js/main.js", "assets/css/styles.css"])
    if (existsSync(join(PUBLIC, rel))) publicFiles.push(join(PUBLIC, rel));
  for (const file of publicFiles) {
    const text = readFileSync(file, "utf8");
    for (const secret of ["TWILIO_API_KEY_SECRET", "TWILIO_API_KEY_SID"])
      if (text.includes(secret))
        fail(file.slice(REPO.length + 1), `references server secret ${secret} in client-delivered output`);
  }
}

/* Gate 8 itself cannot expose a runtime seam that converts a deny into allow. */
const GATE8_REL = "api/_lib/send-permission.mjs";
const gate8Path = join(REPO, GATE8_REL);
if (!existsSync(gate8Path)) {
  fail(GATE8_REL, "missing - there is no send-time authorization boundary");
} else {
  const gate8Raw = readFileSync(gate8Path, "utf8");
  const gate8Src = strip(gate8Raw);

  if (!/get_suppression_state\(\$1\)/.test(gate8Raw))
    fail(GATE8_REL, "does not call public.get_suppression_state($1) - the durable suppression authority is not consulted");
  if (/communication_consent_events/.test(gate8Src))
    fail(GATE8_REL, "names the ledger table - the sender role may only EXECUTE the lookup function");
  if (!/CONSENT_LEDGER_SENDER_URL/.test(gate8Raw))
    fail(GATE8_REL, "does not use the least-privilege sender credential");
  if (/CONSENT_LEDGER_URL\b/.test(gate8Src))
    fail(GATE8_REL, "reuses the append credential for send authorization - the sender role must be separate");

  if (/^(?:let|var)\s/m.test(gate8Src))
    fail(GATE8_REL, "declares a module-scope mutable binding - gate 8 must close over its boundaries, not look them up");
  if (/export\s+(?:function|const|let|var)\s+_(?:set|reset)/.test(gate8Raw))
    fail(GATE8_REL, "exports a _set*/_reset* mutator - a runtime switch inside gate 8 can turn a deny into an allow");
  if (!/\bconst\s+GATE\s*=\s*makeGate\(\s*\{[^}]*\bsuppressionExecutor:\s*neonExecutor\b/.test(gate8Raw))
    fail(GATE8_REL, "the bound gate is not built over neonExecutor - the durable suppression read must be the real one");
  if (!/\bconst\s+GATE\s*=\s*makeGate\(\s*\{[^}]*\bcontactLookup:\s*findContactByEmail\b/.test(gate8Raw))
    fail(GATE8_REL, "the bound gate is not built over findContactByEmail - the consent read must be the real one");
  for (const name of ["authorizeSms", "authorizeAutomatedVoice", "lookupDurableSuppression"])
    if (!new RegExp(`export\\s+const\\s+${name}\\s*=\\s*GATE\\.${name}\\s*;`).test(gate8Raw))
      fail(GATE8_REL, `${name} is not exported from the bound gate - every export must carry the real boundaries`);

  for (const abs of walk(API)) {
    const rel = "api" + abs.slice(API.length).replace(/\\/g, "/");
    if (rel === GATE8_REL || rel === "api/_lib/permission.mjs") continue;
    const code = strip(readFileSync(abs, "utf8"));
    for (const fn of ["canSendSms", "canPlaceAutomatedVoiceCall"])
      if (new RegExp(`\\b${fn}\\b`).test(code))
        fail(rel, `calls ${fn}() directly - every sender must go through ${GATE8_REL}, which reads durable suppression last`);
    if (/\b_gateForTest\b/.test(code))
      fail(rel, `builds a gate 8 over injected boundaries - only ${GATE8_REL} may name _gateForTest`);
    /* Same rule, the other bound boundary. An injected readiness lookup
       answering "blocked, and a fresh consent exists" manufactures an
       unsuppression for a number that never asked for one. */
    if (rel !== "api/_lib/reoptin.mjs" && /\b_reoptinGateForTest\b/.test(code))
      fail(rel, "builds a re-opt-in readiness gate over injected boundaries - only api/_lib/reoptin.mjs may name _reoptinGateForTest");
  }
}

/* The only outbound SMS side-effect site is the sender, and Gate 9 gives that
 * sender exactly one production importer: the internal seller acknowledgement
 * orchestrator. The only production importer of that orchestrator is /api/lead. */
const SENDER_REL = "api/_lib/sms-sender.mjs";
const ACK_REL = "api/_lib/lead-sms-ack.mjs";
const LEAD_REL = "api/lead.js";
const senderPath = join(REPO, SENDER_REL);
if (!existsSync(senderPath)) {
  fail(SENDER_REL, "missing - the designated outbound sender is gone");
} else {
  const senderRaw = readFileSync(senderPath, "utf8");
  const senderSrc = strip(senderRaw);
  const CREATE_SHAPES = [
    [/\bmessages\s*\.\s*create\b/, "reaches the Twilio message-create API"],
    [/\bmessages\s*\[\s*["'`]create["'`]\s*\]/, "reaches the Twilio message-create API by computed access"],
    [/\[\s*["'`]messages["'`]\s*\]/, "reaches the Twilio messages resource by computed access"],
    [/\{[^{}]*\bcreate\b[^{}]*\}\s*=\s*[^;=]*\bmessages\b/, "destructures create() off a Twilio messages resource"],
  ];
  const SENDER_ONLY = [
    ...CREATE_SHAPES,
    [/\btwilio\s*\(/, "constructs a Twilio API client"],
    [/\b_senderForTest\b/, "builds a sender over injected boundaries"],
    [/\bmessagingServiceSid\b/, "names a Twilio Messaging Service as an outbound parameter"],
    [/TWILIO_MESSAGING_SERVICE_SID|TWILIO_API_KEY_SID|TWILIO_API_KEY_SECRET/, "reads an outbound Twilio credential"],
  ];
  const REST_BYPASS = [
    [/api\.twilio\.com/i, "addresses the Twilio REST API directly"],
    [/\/Messages\.json/i, "addresses the Twilio Messages REST resource directly"],
  ];

  for (const abs of walk(API)) {
    const rel = "api" + abs.slice(API.length).replace(/\\/g, "/");
    const code = strip(readFileSync(abs, "utf8"));
    for (const [re, what] of REST_BYPASS)
      if (re.test(code))
        fail(rel, `${what} - outbound Twilio traffic goes through the SDK inside ${SENDER_REL}`);
    if (rel === SENDER_REL) continue;
    for (const [re, what] of SENDER_ONLY)
      if (re.test(code))
        fail(rel, `${what} - only ${SENDER_REL} may cause an outbound Twilio side effect`);
    if (/\bsms-sender\b/.test(code) && rel !== ACK_REL)
      fail(rel, `imports ${SENDER_REL} - deliberately unreachable from this module; only ${ACK_REL} may reach the outbound transport`);
    if (/\blead-sms-ack\b/.test(code) && rel !== LEAD_REL)
      fail(rel, `imports ${ACK_REL} - only ${LEAD_REL} may invoke the automatic acknowledgement`);
  }

  const ackPath = join(REPO, ACK_REL);
  if (!existsSync(ackPath)) {
    fail(ACK_REL, "missing - Gate 9 has no closed acknowledgement orchestrator");
  } else {
    const ackSrc = strip(readFileSync(ackPath, "utf8"));
    if (!/import\s*\{[^}]*\bsendSms\b[^}]*\}\s*from\s*"\.\/sms-sender\.mjs"/.test(ackSrc))
      fail(ACK_REL, `does not import sendSms from ${SENDER_REL}`);
    if (!/export\s+const\s+sendLeadSmsAcknowledgement\s*=\s*makeLeadSmsAcknowledgement\(\s*sendSms\s*\)/.test(ackSrc))
      fail(ACK_REL, "the production acknowledgement is not closed over the real sendSms transport");
    if (/^(?:let|var)\s/m.test(ackSrc))
      fail(ACK_REL, "declares module-scope mutable state - acknowledgement boundaries must be closed over");
    if (/export\s+(?:function|const|let|var)\s+_(?:set|reset)/.test(ackSrc))
      fail(ACK_REL, "exports a mutable production seam");
  }

  const leadPath = join(REPO, LEAD_REL);
  if (!existsSync(leadPath)) {
    fail(LEAD_REL, "missing");
  } else {
    const leadSrc = strip(readFileSync(leadPath, "utf8"));
    if (!/from\s*"\.\/_lib\/lead-sms-ack\.mjs"/.test(leadSrc))
      fail(LEAD_REL, `does not import the designated ${ACK_REL} orchestrator`);
  }

  const sites = senderSrc.match(/\bmessages\s*\.\s*create\s*\(/g) || [];
  if (sites.length !== 1)
    fail(SENDER_REL, `has ${sites.length} Twilio message-create call sites - there must be exactly one`);
  for (const [re, what] of CREATE_SHAPES.slice(1))
    if (re.test(senderSrc))
      fail(SENDER_REL, `${what} - the one send site must be a plain messages.create() call so it can be counted`);

  if (!/import\s*\{[^}]*\bauthorizeSms\b[^}]*\}\s*from\s*"\.\/send-permission\.mjs"/.test(senderSrc))
    fail(SENDER_REL, "does not import authorizeSms from ./send-permission.mjs - the sender must go through gate 8");
  if (!/export\s+const\s+sendSms\s*=\s*makeSender\(\s*\{[^}]*\bauthorize:\s*authorizeSms\b/.test(senderSrc))
    fail(SENDER_REL, "the exported sendSms is not built over authorizeSms - the production sender must close over gate 8 itself");
  if (!/export\s+const\s+sendSms\s*=\s*makeSender\(\s*\{[^}]*\bclientFactory:\s*realClient\b/.test(senderSrc))
    fail(SENDER_REL, "the exported sendSms is not built over realClient - the production sender must close over the real provider");
  if (/^(?:let|var)\s/m.test(senderSrc))
    fail(SENDER_REL, "declares a module-scope mutable binding - the send path must close over its boundaries, not look them up");
  if (/export\s+(?:function|const|let|var)\s+_set/.test(senderSrc))
    fail(SENDER_REL, "exports a _set* mutator - there must be no runtime switch inside the sender");
  if (/TWILIO_AUTH_TOKEN/.test(senderSrc))
    fail(SENDER_REL, "reads TWILIO_AUTH_TOKEN - the outbound sender must use its own API Key pair, never the inbound master secret");

  if (!/OUTBOUND_SMS_FLAG[^\n]{0,60}===\s*"true"/.test(senderSrc))
    fail(SENDER_REL, "the outbound flag is not compared strictly to \"true\" - outbound messaging must not switch on through a typo");
  if (/OUTBOUND_SMS_FLAG[^\n]{0,60}(?:!==?\s*"false"|[^!=]==\s*"true")/.test(senderSrc))
    fail(SENDER_REL, "compares the outbound flag loosely - only the exact string \"true\" may enable outbound messaging");
  if (!/timeout\s*:\s*TWILIO_REQUEST_TIMEOUT_MS/.test(senderSrc) ||
      !/TWILIO_REQUEST_TIMEOUT_MS\s*=\s*5000/.test(senderSrc))
    fail(SENDER_REL, "does not enforce the 5-second Twilio request bound for the courtesy acknowledgement");

  const flagAt = senderSrc.search(/outboundSmsEnabled\s*\(\s*env\s*\)/);
  const authAt = senderSrc.search(/\bawait\s+authorize\s*\(/);
  const sendAt = senderSrc.search(/\bmessages\s*\.\s*create\s*\(/);
  if (authAt === -1) {
    fail(SENDER_REL, "has no `await authorize(` call site - nothing asks gate 8 before sending");
  } else if (sendAt === -1) {
    fail(SENDER_REL, "has no Twilio message-create call site");
  } else if (authAt > sendAt) {
    fail(SENDER_REL, "sends before it authorizes - gate 8 is consulted after the message has left");
  } else {
    if (flagAt === -1 || flagAt > authAt)
      fail(SENDER_REL, "reaches gate 8 before checking the outbound feature flag - a dark system would still read HubSpot and Neon");
    const semi = senderSrc.indexOf(";", authAt);
    if (semi === -1 || semi > sendAt) {
      fail(SENDER_REL, "the gate 8 call site is not a single statement - the adjacency region cannot be bounded");
    } else {
      const region = senderSrc.slice(semi + 1, sendAt);
      const SEND_PREFIX = /\bawait\s+[A-Za-z_$][\w$]*\s*\.\s*$/;
      if (!SEND_PREFIX.test(region)) {
        fail(SENDER_REL, "the Twilio message-create call is not awaited directly off a local client - the send must be the statement that follows the authorization");
      } else {
        const between = region.replace(SEND_PREFIX, " ");
        if (!/allowed\s*!==\s*true/.test(between))
          fail(SENDER_REL, "does not refuse on `allowed !== true` between gate 8 and the send - a malformed or missing decision must not send");
        if (!/\breturn\b/.test(between))
          fail(SENDER_REL, "does not return between gate 8 and the send - a denial has no way to stop the message");
        const SUSPENSIONS = [
          [/\bawait\b/, "an await"],
          [/\.\s*then\s*\(/, "a .then()"],
          [/\byield\b/, "a yield"],
          [/\bnew\s+Promise\b/, "a new Promise"],
          [/\bset(?:Timeout|Interval|Immediate)\s*\(/, "a timer"],
          [/\bqueueMicrotask\s*\(/, "a queueMicrotask()"],
          [/\bprocess\s*\.\s*nextTick\s*\(/, "a process.nextTick()"],
        ];
        for (const [re, what] of SUSPENSIONS)
          if (re.test(between))
            fail(SENDER_REL, `has ${what} between the gate 8 decision and the Twilio send - every suspension point there is a window in which a STOP can arrive and be ignored`);
        const argEnd = senderSrc.indexOf(";", sendAt);
        const args = argEnd === -1 ? senderSrc.slice(sendAt) : senderSrc.slice(sendAt, argEnd);
        for (const [re, what] of SUSPENSIONS)
          if (re.test(args))
            fail(SENDER_REL, `has ${what} inside the Twilio send's own arguments - it resolves before the request is made, which is the same window`);
      }
    }
  }
}

if (errors.length) {
  console.log("\nOutbound/Gate 8 errors:");
  for (const error of errors) console.log("  ✗ " + error);
  console.log(`\n${errors.length} outbound/Gate 8 error(s).`);
  process.exit(1);
}
console.log("✓ outbound SMS / Gate 8 guards passed");