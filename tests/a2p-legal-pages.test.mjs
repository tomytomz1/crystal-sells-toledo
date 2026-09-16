/* A2P legal-page release invariants.
 *
 * The live Twilio Campaign registration form reviews the rendered legal pages,
 * not the source templates. Build with communications consent enabled in a
 * throwaway tree so these assertions run in CI regardless of CI's own feature
 * flag value and cannot pass merely because the gated copy was omitted.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { FEATURE_FLAG } from "../api/_lib/consent.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function visibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;/g, "’")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/\s+/g, " ")
    .trim();
}

function tagText(html, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html);
  assert.ok(match, `missing <${tag}>`);
  return visibleText(match[1]);
}

describe("rendered A2P legal pages", () => {
  let dir;
  let publicDir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cst-a2p-legal-"));
    const root = join(dir, "enabled");
    for (const item of [
      "src", "assets", "tools", "api", "package.json", "robots.txt", "site.webmanifest",
    ]) {
      cpSync(join(REPO, item), join(root, item), { recursive: true });
    }
    execFileSync(process.execPath, ["tools/build.mjs"], {
      cwd: root,
      env: { ...process.env, [FEATURE_FLAG]: "true" },
      stdio: "pipe",
    });
    publicDir = join(root, "public");
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const page = (name) => readFileSync(join(publicDir, name), "utf8");

  test("privacy page matches the live Twilio Campaign review contract", () => {
    assert.equal(existsSync(join(publicDir, "privacy.html")), true);
    const html = page("privacy.html");
    const text = visibleText(html);

    assert.equal(tagText(html, "title"), "Privacy Policy | Crystal Sells Toledo");
    assert.equal(tagText(html, "h1"), "Privacy Policy");

    for (const required of [
      "Crystal Sells Toledo",
      "We do not sell or share your SMS opt-in data or personal information with third parties for marketing purposes.",
      "Message frequency varies.",
      "Message and data rates may apply",
      "STOP",
      "HELP",
    ]) {
      assert.ok(text.includes(required), `privacy.html is missing \"${required}\"`);
    }
  });

  test("terms page matches the live Twilio Campaign review contract", () => {
    assert.equal(existsSync(join(publicDir, "communications-terms.html")), true);
    const html = page("communications-terms.html");
    const text = visibleText(html);

    assert.equal(tagText(html, "title"), "Terms & Conditions | Crystal Sells Toledo");
    assert.equal(tagText(html, "h1"), "Terms & Conditions");
    assert.match(html, /<h2>SMS Terms<\/h2>/);

    for (const required of [
      "Crystal Sells Toledo",
      "Message frequency varies.",
      "Message and data rates may apply.",
      "Reply STOP to opt out.",
      "Reply HELP for help.",
      "(419) 245-4655",
      "crystal@crystalsellstoledo.com",
      "Carriers are not liable for any delayed or undelivered messages.",
      "Automated and AI voice calls",
    ]) {
      assert.ok(text.includes(required), `communications-terms.html is missing \"${required}\"`);
    }
  });
});
