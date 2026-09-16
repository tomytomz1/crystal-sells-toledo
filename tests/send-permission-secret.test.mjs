/* Gate 8 secret containment — and every other server-side credential.
 * =====================================================================
 * CI builds the production site before the Node tests run, so this scans
 * the ACTUAL browser-delivered output rather than asserting something
 * about the source. A variable name reaching a page is the cheap, visible
 * half of a leak; a value reaching one is the expensive half. Both fail.
 *
 * Widened from the original, which looked only for the sender-role
 * variable. A guard that names one secret is a guard that says nothing
 * about the next one somebody adds.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SENDER_LEDGER_URL_VAR } from "../api/_lib/send-permission.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(REPO, "public");

/* Every server-only name. NEXT_PUBLIC_ prefixing any of these is itself a
   CLAUDE.md rule 10 violation, so the bare name is what is searched. */
const SERVER_ONLY_VARS = Object.freeze([
  SENDER_LEDGER_URL_VAR,
  "CONSENT_LEDGER_URL",
  "TWILIO_AUTH_TOKEN",
  "OPERATOR_ACTION_SECRET",
  "HUBSPOT_ACCESS_TOKEN",
  "HUBSPOT_PORTAL_ID",
  "HUBSPOT_FORM_GUID",
  "ZOHO_SMTP_HOST",
  "ZOHO_SMTP_PORT",
  "ZOHO_SMTP_USER",
  "ZOHO_SMTP_PASSWORD",
]);

/** Every file under a directory, whatever its extension. */
function allFilesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...allFilesUnder(path));
    else out.push(path);
  }
  return out;
}

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (/\.(?:html|js|css|json|xml|txt|webmanifest|svg)$/.test(name)) out.push(path);
  }
  return out;
}

describe("server secrets never reach the browser", { skip: existsSync(PUBLIC) ? false : "no build output" }, () => {
  const built = filesUnder(PUBLIC).map((path) => [path, readFileSync(path, "utf8")]);

  test("the built site is not empty, so the scan is not vacuous", () => {
    assert.ok(built.length > 5, `only ${built.length} built files scanned - the guard would pass on nothing`);
    assert.ok(built.some(([p]) => p.endsWith("index.html")), "index.html was not scanned");
  });

  for (const name of SERVER_ONLY_VARS) {
    test(`${name} never appears in browser-delivered output`, () => {
      const hits = built.filter(([, body]) => body.includes(name))
        .map(([path]) => path.slice(PUBLIC.length + 1));
      assert.deepEqual(hits, [], `${name} leaked into built output`);
    });
  }

  test("no server credential is exposed under a NEXT_PUBLIC_ prefix anywhere in the repo", () => {
    /* CLAUDE.md rule 10. Checked in SOURCE, not output: the point is that
       such a variable must never be introduced, not merely that today's
       build happens not to print it. */
    const sources = ["api", "src", "tools", "assets"]
      .map((d) => join(REPO, d)).filter(existsSync).flatMap(allFilesUnder);
    assert.ok(sources.length > 20, `only ${sources.length} source files scanned - the guard is vacuous`);
    const offenders = [];
    for (const path of sources) {
      const body = readFileSync(path, "utf8");
      for (const name of SERVER_ONLY_VARS)
        if (body.includes("NEXT_PUBLIC_" + name))
          offenders.push(`${path.slice(REPO.length + 1)}: ${name}`);
    }
    assert.deepEqual(offenders, [], "a server credential is prefixed NEXT_PUBLIC_");
  });

  test("the sender credential is named only by the Gate 8 boundary, never by anything that ships", () => {
    const gate8 = readFileSync(join(REPO, "api/_lib/send-permission.mjs"), "utf8");
    assert.ok(gate8.includes(SENDER_LEDGER_URL_VAR),
      "Gate 8 does not read the sender credential at all");

    /* src/ and assets/ become the browser bundle. Neither may name it. */
    const shipped = ["src", "assets"].map((d) => join(REPO, d))
      .filter(existsSync).flatMap(allFilesUnder);
    assert.ok(shipped.length > 10, `only ${shipped.length} shipped files scanned - the guard is vacuous`);
    const hits = shipped
      .filter((path) => readFileSync(path, "utf8").includes(SENDER_LEDGER_URL_VAR))
      .map((path) => path.slice(REPO.length + 1));
    assert.deepEqual(hits, [], "the sender credential is named in a file that ships to the browser");
  });
});
