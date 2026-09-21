/* Static guards for automatic website SMS re-opt-in through Twilio Consent
 * Management API. This is intentionally separate from check-sms-sender.mjs:
 * provider consent synchronization is not an outbound message send and uses
 * a separate credential with a separate blast radius.
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

const PROVIDER_REL = "api/_lib/twilio-consent.mjs";
const ORCHESTRATOR_REL = "api/_lib/website-sms-reoptin.mjs";
const STORE_REL = "api/_lib/website-reoptin-store.mjs";
const ACK_REL = "api/_lib/lead-sms-ack.mjs";
const MIGRATION_REL = "db/005_automatic_website_sms_reoptin.sql";
const ENDPOINT = "https://accounts.twilio.com/v1/Consents/Bulk";
const SECRET_NAMES = [
  "TWILIO_CONSENT_API_KEY_SID",
  "TWILIO_CONSENT_API_KEY_SECRET",
];

/* Dedicated consent credentials must never ship to a browser artifact. */
if (existsSync(PUBLIC)) {
  const files = readdirSync(PUBLIC).filter((name) => name.endsWith(".html"))
    .map((name) => join(PUBLIC, name));
  for (const rel of ["assets/js/main.js", "assets/css/styles.css"])
    if (existsSync(join(PUBLIC, rel))) files.push(join(PUBLIC, rel));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const name of SECRET_NAMES)
      if (text.includes(name))
        fail(file.slice(REPO.length + 1), `references server secret ${name}`);
  }
}

const providerPath = join(REPO, PROVIDER_REL);
if (!existsSync(providerPath)) {
  fail(PROVIDER_REL, "missing");
} else {
  const raw = readFileSync(providerPath, "utf8");
  const src = strip(raw);
  if (!raw.includes(ENDPOINT)) fail(PROVIDER_REL, "does not use the documented Consent Management bulk endpoint");
  if (/TWILIO_AUTH_TOKEN/.test(src)) fail(PROVIDER_REL, "reuses the inbound master auth token");
  if (/TWILIO_API_KEY_(?:SID|SECRET)|TWILIO_MESSAGING_SERVICE_SID/.test(src))
    fail(PROVIDER_REL, "reuses the outbound message-sender credential instead of the dedicated consent credential");
  for (const name of [
    "TWILIO_CONSENT_API_KEY_SID",
    "TWILIO_CONSENT_API_KEY_SECRET",
    "TWILIO_CONSENT_MESSAGING_SERVICE_SID",
    "TWILIO_CONSENT_SENDER_NUMBER",
  ]) if (!raw.includes(name)) fail(PROVIDER_REL, `missing required provider config ${name}`);
  if (!/body\.append\("Items",\s*JSON\.stringify\(item\)\)/.test(src))
    fail(PROVIDER_REL, "does not encode the documented repeated Items form field");
  if (!/status:\s*"opt-in"/.test(src) || !/source:\s*"website"/.test(src))
    fail(PROVIDER_REL, "does not pin website opt-in semantics");
  if (!/sender_id:\s*config\.serviceSid/.test(src) || !/sender_id:\s*config\.senderNumber/.test(src))
    fail(PROVIDER_REL, "does not submit both Messaging Service and sender-number opt-ins");
  if (/^(?:let|var)\s/m.test(src))
    fail(PROVIDER_REL, "declares module-scope mutable state");
  if (!/const CLIENT = makeClient\(\{ fetchImpl: globalThis\.fetch, uuidFactory: randomUUID \}\)/.test(src))
    fail(PROVIDER_REL, "production client is not closed over real fetch and randomUUID");
}

/* No other application module may know the provider endpoint or credential
 * names. The orchestrator consumes only the provider function. */
if (existsSync(API)) {
  for (const abs of walk(API)) {
    const rel = "api" + abs.slice(API.length).replace(/\\/g, "/");
    if (rel === PROVIDER_REL) continue;
    const src = strip(readFileSync(abs, "utf8"));
    if (src.includes(ENDPOINT)) fail(rel, `addresses Twilio Consent Management directly; only ${PROVIDER_REL} may`);
    for (const name of SECRET_NAMES)
      if (src.includes(name)) fail(rel, `reads ${name}; only ${PROVIDER_REL} may`);
    if (/\btwilio-consent\b/.test(src) && rel !== ORCHESTRATOR_REL)
      fail(rel, `imports ${PROVIDER_REL}; only ${ORCHESTRATOR_REL} may reconcile provider consent`);
    if (/\bwebsite-sms-reoptin\b/.test(src) && rel !== ACK_REL)
      fail(rel, `imports ${ORCHESTRATOR_REL}; only ${ACK_REL} may invoke automatic website re-opt-in`);
  }
}

const storePath = join(REPO, STORE_REL);
if (!existsSync(storePath)) {
  fail(STORE_REL, "missing");
} else {
  const src = strip(readFileSync(storePath, "utf8"));
  if (/communication_consent_events/.test(src))
    fail(STORE_REL, "names the ledger table; db/005 must own the append shape");
  if (!/complete_website_sms_reoptin\(\$1,\$2,\$3,\$4::jsonb,\$5\)/.test(src))
    fail(STORE_REL, "does not call the narrow db/005 completion function");
  if (!/CONSENT_LEDGER_REOPTIN_URL/.test(readFileSync(join(REPO, "api/_lib/reoptin.mjs"), "utf8")))
    fail(STORE_REL, "re-opt-in credential contract missing");
}

const migrationPath = join(REPO, MIGRATION_REL);
if (!existsSync(migrationPath)) {
  fail(MIGRATION_REL, "missing");
} else {
  const sql = readFileSync(migrationPath, "utf8");
  for (const required of [
    "CREATE FUNCTION complete_website_sms_reoptin(",
    "SECURITY DEFINER",
    "SET search_path = pg_catalog, public",
    "'twilio_consent_api'",
    "'unsuppressed'",
    "'consumer_request'",
    "REVOKE EXECUTE ON FUNCTION complete_website_sms_reoptin",
    "GRANT EXECUTE ON FUNCTION complete_website_sms_reoptin",
    "TO <reoptin_role>",
  ]) if (!sql.includes(required)) fail(MIGRATION_REL, `missing hardening contract: ${required}`);
}

if (errors.length) {
  console.error("\nTwilio consent/re-opt-in checks failed:\n" + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}

console.log("Twilio consent/re-opt-in checks passed.");
