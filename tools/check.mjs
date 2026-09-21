/* Composite repository checker.
 *
 * The canonical current-main checks live in check-base.mjs. PR #51 adds the
 * outbound/Gate 8 checks in check-sms-sender.mjs. This entry point runs both.
 *
 * Some permanent mutation tests intentionally inspect tools/check.mjs itself
 * to pin the exact call-site strings and browser-secret containment contract
 * those tests depend on. Because the implementation is delegated, keep those
 * pins meaningful here by verifying that the delegated base checker still
 * contains the same contracts before either checker runs.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_PATH = join(HERE, "check-base.mjs");
const baseSrc = readFileSync(BASE_PATH, "utf8");

/* These are the exact source anchors pinned by the existing Tier-4 mutation
   suites. They are not decorative: this entry point refuses to delegate to a
   base checker that no longer carries any one of them. */
const BASE_CALLSITE_ANCHORS = [
  "await appendConsentEvents(",
  "await createLead(",
  "verifyTwilioSignature(req",
  "= classify(params)",
  "await appendSuppressionEvents(",
  "await projectToHubSpot(",
];
for (const anchor of BASE_CALLSITE_ANCHORS) {
  if (!baseSrc.includes(JSON.stringify(anchor))) {
    console.error(`tools/check-base.mjs lost pinned call-site anchor: ${JSON.stringify(anchor)}`);
    process.exit(1);
  }
}

/* Existing containment tests inspect this named list in tools/check.mjs.
   Mirror the base checker's browser-secret contract and verify the delegate
   still carries every name, so the source-level assertion remains evidence
   about the checker that actually runs rather than a stale compatibility
   string. */
const SECRET_NAMES = [
  "HUBSPOT_ACCESS_TOKEN",
  "ZOHO_SMTP_PASSWORD", "ZOHO_SMTP_USER", "ZOHO_SMTP_HOST", "ZOHO_SMTP_PORT",
  "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_CLIENT_ID",
  "CONSENT_LEDGER_URL",
  "TWILIO_AUTH_TOKEN",
  "OPERATOR_ACTION_SECRET",
  "OPERATOR_UNSUPPRESS_SECRET", "CONSENT_LEDGER_OPERATOR_URL",
  "CONSENT_LEDGER_REOPTIN_URL",
  "TURNSTILE_SECRET_KEY",
];
const secretListAt = baseSrc.indexOf("const SECRET_NAMES");
const secretListEnd = secretListAt === -1 ? -1 : baseSrc.indexOf("];", secretListAt);
const delegatedSecrets = secretListAt === -1 || secretListEnd === -1
  ? ""
  : baseSrc.slice(secretListAt, secretListEnd);
for (const name of SECRET_NAMES) {
  if (!delegatedSecrets.includes(JSON.stringify(name))) {
    console.error(`tools/check-base.mjs lost browser-secret guard: ${name}`);
    process.exit(1);
  }
}

await import("./check-base.mjs");
await import("./check-sms-sender.mjs");
