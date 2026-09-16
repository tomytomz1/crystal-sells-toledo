/* A2P 10DLC SMS-specific legal pages — rendered-boundary regression.
 *
 * Twilio rejected the first Campaign with 30882 (Terms & Conditions).
 * These tests build the real static site in both feature-gate states and
 * assert the exact public surfaces a reviewer is meant to visit. They do
 * not contact Twilio or any other live provider.
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
const FORM_PAGES = ["index.html", "home-value.html", "43551-seller-review.html", "contact.html"];

const flat = (html) => html.replace(/\s+/g, " ");

function h1Of(html) {
  return /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1]
    ?.replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .trim();
}

describe("A2P SMS legal surfaces", () => {
  let dir, OFF_DIR, ON_DIR;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cst-a2p-sms-legal-"));
    for (const mode of ["off", "on"]) {
      const root = join(dir, mode);
      for (const item of ["src", "assets", "tools", "api", "package.json",
                          "robots.txt", "site.webmanifest"])
        cpSync(join(REPO, item), join(root, item), { recursive: true });
      execFileSync(process.execPath, ["tools/build.mjs"], {
        cwd: root,
        env: { ...process.env, [FEATURE_FLAG]: mode === "on" ? "true" : "false" },
        stdio: "pipe",
      });
    }
    OFF_DIR = join(dir, "off", "public");
    ON_DIR = join(dir, "on", "public");
  });

  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const page = (root, name) => readFileSync(join(root, name), "utf8");

  test("disabled builds do not publish SMS-program promises", () => {
    for (const f of ["sms-privacy.html", "sms-terms.html"])
      assert.equal(existsSync(join(OFF_DIR, f)), false, `${f} exists with consent disabled`);
    const sitemap = page(OFF_DIR, "sitemap.xml");
    assert.ok(!sitemap.includes("sms-privacy"));
    assert.ok(!sitemap.includes("sms-terms"));
  });

  test("enabled builds publish and index both dedicated legal pages", () => {
    for (const f of ["sms-privacy.html", "sms-terms.html"])
      assert.equal(existsSync(join(ON_DIR, f)), true, `${f} was not built`);
    const sitemap = page(ON_DIR, "sitemap.xml");
    assert.ok(sitemap.includes("https://crystalsellstoledo.com/sms-privacy"));
    assert.ok(sitemap.includes("https://crystalsellstoledo.com/sms-terms"));
  });

  test("every live opt-in surface links directly to the SMS-specific policies", () => {
    for (const f of FORM_PAGES) {
      const html = page(ON_DIR, f);
      assert.match(html, /href="\/sms-privacy" target="_blank" rel="noopener"/,
        `${f} has no direct SMS Privacy Policy link`);
      assert.match(html, /href="\/sms-terms" target="_blank" rel="noopener"/,
        `${f} has no direct SMS Terms link`);
    }
  });

  test("SMS Privacy Policy contains the A2P non-sharing contract without transaction-sharing ambiguity", () => {
    const html = page(ON_DIR, "sms-privacy.html");
    const text = flat(html);
    assert.equal(h1Of(html), "Privacy Policy");
    for (const required of [
      "Crystal Sells Toledo",
      "We do not sell or share your SMS opt-in data or personal information with third parties for marketing purposes.",
      "Mobile information and SMS opt-in consent will not be shared with third parties or affiliates for marketing or promotional purposes.",
      "Message frequency varies.",
      "Message and data rates may apply.",
      "Reply STOP to opt out.",
      "Reply HELP for help.",
    ]) assert.ok(text.includes(required), `sms-privacy is missing: ${required}`);

    for (const unrelated of ["title company", "lender or inspector", "AI-generated voice"])
      assert.ok(!text.includes(unrelated), `sms-privacy carries unrelated policy language: ${unrelated}`);
  });

  test("SMS Terms contain Twilio's review checklist and nothing that broadens the campaign", () => {
    const html = page(ON_DIR, "sms-terms.html");
    const text = flat(html);
    assert.equal(h1Of(html), "Terms & Conditions");
    for (const required of [
      "SMS Terms",
      "Crystal Sells Toledo",
      "Message frequency varies.",
      "Message and data rates may apply.",
      "Reply STOP to opt out.",
      "Reply HELP for help.",
      "Carriers are not liable for any delayed or undelivered messages.",
      "Consent is not a condition of service",
      "(419)&nbsp;245-4655",
      "crystal@crystalsellstoledo.com",
      "href=\"/sms-privacy\"",
    ]) assert.ok(text.includes(required), `sms-terms is missing: ${required}`);

    assert.ok(text.includes("does not conduct affiliate marketing or third-party lead generation"));
    assert.ok(!text.includes("Automated and AI voice calls"),
      "the SMS-only terms were broadened into the separate voice program");
  });

  test("the dedicated pages cross-link within the same SMS program", () => {
    assert.match(page(ON_DIR, "sms-privacy.html"), /href="\/sms-terms"/);
    assert.match(page(ON_DIR, "sms-terms.html"), /href="\/sms-privacy"/);
  });
});
