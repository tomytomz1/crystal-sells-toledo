import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(ROOT, "api", "lead.js"), "utf8");

function logBody(eventName) {
  const escaped = eventName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = SOURCE.match(new RegExp(`log\\("${escaped}", \\{([\\s\\S]*?)\\n\\s*\\}\\);`));
  assert.ok(match, `missing ${eventName} log block`);
  return match[1];
}

test("website lead consent uses an 8 second cold-start-tolerant ledger budget", () => {
  assert.match(SOURCE, /const LEAD_CONSENT_LEDGER_TIMEOUT_MS = 8000;/);
  assert.match(
    SOURCE,
    /appendConsentEvents\(payload\.consent,\s*\{\s*timeoutMs: LEAD_CONSENT_LEDGER_TIMEOUT_MS,?\s*\}\)/,
  );
});

test("ledger success and failure logs include safe elapsed timing", () => {
  const success = logBody("lead.consent.ledger_appended");
  const failure = logBody("lead.consent.ledger_failed");

  assert.match(success, /ledger_ms:\s*Date\.now\(\) - ledgerStarted/);
  assert.match(success, /ledger_events:\s*ledgerResult\.events/);
  assert.match(failure, /ledger_ms:\s*Date\.now\(\) - ledgerStarted/);
  assert.match(failure, /\.\.\.ledgerLogShape\(ledgerErr\)/);

  for (const block of [success, failure]) {
    for (const forbidden of [
      "phone", "email", "address", "consent_copy_text", "query", "params", "database_url",
    ]) {
      assert.equal(block.includes(forbidden), false, `${forbidden} leaked into ledger telemetry`);
    }
  }
});
