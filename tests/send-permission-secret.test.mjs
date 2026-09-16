/* Gate 8 secret-containment guard.
 *
 * CI builds the production site before Node tests run. Scan the actual
 * browser-delivered output, not source assumptions, so introducing the
 * sender-role variable name into generated HTML/JS/CSS cannot pass silently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SENDER_LEDGER_URL_VAR } from "../api/_lib/send-permission.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...filesUnder(path));
    else if (/\.(?:html|js|css|json|xml|txt|webmanifest)$/.test(name)) out.push(path);
  }
  return out;
}

test("CONSENT_LEDGER_SENDER_URL never appears in browser-delivered output", () => {
  const hits = filesUnder(ROOT).filter((path) =>
    readFileSync(path, "utf8").includes(SENDER_LEDGER_URL_VAR));
  assert.deepEqual(hits, [], `${SENDER_LEDGER_URL_VAR} leaked into built output`);
});
