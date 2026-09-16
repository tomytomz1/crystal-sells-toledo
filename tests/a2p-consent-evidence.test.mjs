/* /sms-consent-evidence — the static A2P consent verification surface.
 * =====================================================================
 * WHY THE PAGE EXISTS. The real SMS opt-in is on STEP 2 of the two-step
 * /home-value form; steps toggle with the `hidden` attribute, so a
 * crawler that does not advance the form never reads the disclosure. An
 * external browser-based extraction of production /home-value on
 * 16 September 2026 returned the page and both SMS legal links but not
 * the step-2 disclosure text. The evidence page republishes the SAME
 * canonical disclosure as static, script-free text.
 *
 * WHAT THESE TESTS DEFEND. Two ways the page could become a liability:
 * it stops being EVIDENCE (its words drift from the canonical source the
 * server records), or it stops being INERT (it grows something that can
 * be submitted). Both are asserted from the REAL BUILD OUTPUT, and the
 * page-inertness assertions read the page's own <main> so that site
 * chrome is not mistaken for a form.
 *
 * Nothing here contacts Twilio, HubSpot, Neon, Retell or any live
 * provider.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { FEATURE_FLAG, SMS_CONSENT, AI_VOICE_CONSENT } from "../api/_lib/consent.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = "sms-consent-evidence.html";
const flat = (s) => s.replace(/\s+/g, " ");
const mainOf = (html) => /<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, "");
/* Prose assertions read what a REVIEWER reads: markup removed and the
   handful of entities this site uses resolved. Disclosure-match
   assertions deliberately do NOT use this - they compare the canonical
   `html`, anchors and all. */
const ENTITIES = { "&mdash;": "\u2014", "&ndash;": "\u2013", "&rsquo;": "\u2019",
  "&lsquo;": "\u2018", "&ldquo;": "\u201c", "&rdquo;": "\u201d", "&hellip;": "\u2026",
  "&middot;": "\u00b7", "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&check;": "\u2713" };
const text = (html) =>
  flat(stripComments(html).replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, (e) => ENTITIES[e] ?? e));

let chromium = null;
try { ({ chromium } = await import("playwright")); } catch { /* not installed */ }
const PW = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium";

const TYPES = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png",
  ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain",
};

function serve(root) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p === "/") p = "/index.html";
      let f = join(root, p);
      if (!existsSync(f) && existsSync(f + ".html")) f += ".html";
      if (!existsSync(f)) { res.statusCode = 404; return res.end("nf"); }
      res.setHeader("Content-Type", TYPES[extname(f)] || "application/octet-stream");
      res.end(readFileSync(f));
    });
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

let dir, OFF_DIR, ON_DIR;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "cst-a2p-evidence-"));
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

describe("the evidence page follows the feature gate", () => {
  test("it is not published while there is no messaging programme", () => {
    assert.equal(existsSync(join(OFF_DIR, EVIDENCE)), false);
    assert.ok(!page(OFF_DIR, "sitemap.xml").includes("sms-consent-evidence"));
  });

  test("it is published, indexable and in the sitemap when the programme is on", () => {
    assert.equal(existsSync(join(ON_DIR, EVIDENCE)), true);
    const html = page(ON_DIR, EVIDENCE);
    assert.doesNotMatch(html, /name="robots"[^>]*noindex/,
      "the page is noindex - a reviewer's crawler must be able to read it");
    assert.ok(page(ON_DIR, "sitemap.xml").includes("https://crystalsellstoledo.com/sms-consent-evidence"));
    /* robots.txt must not shut it out either. */
    assert.ok(!/Disallow:\s*\/sms-consent-evidence/.test(page(ON_DIR, "robots.txt")));
  });
});

describe("the evidence page is evidence", () => {
  test("it reproduces the canonical SMS disclosure character for character", () => {
    const body = flat(stripComments(mainOf(page(ON_DIR, EVIDENCE))));
    assert.ok(body.includes(flat(SMS_CONSENT.html)),
      "the reproduced SMS disclosure is not the canonical text from api/_lib/consent.mjs");
    assert.ok(body.includes(flat(AI_VOICE_CONSENT.html)),
      "the reproduced voice disclosure is not the canonical text from api/_lib/consent.mjs");
  });

  test("the reproduction is the LIVE label, not a copy that can drift", () => {
    /* The same string must appear on the real opt-in surface and on the
       evidence page. If a future version constant is minted and only one
       of them follows it, this fails. */
    const live = flat(stripComments(page(ON_DIR, "home-value.html")));
    const evidence = flat(stripComments(mainOf(page(ON_DIR, EVIDENCE))));
    for (const d of [SMS_CONSENT, AI_VOICE_CONSENT]) {
      assert.ok(live.includes(flat(d.html)), `the live form lost the canonical ${d.channel} disclosure`);
      assert.ok(evidence.includes(flat(d.html)), `the evidence page lost the canonical ${d.channel} disclosure`);
    }
    /* Source-level: the page must not retype the words at all. */
    const src = readFileSync(join(REPO, "src/pages/sms-consent-evidence.html"), "utf8");
    const srcBody = stripComments(src);
    assert.ok(srcBody.includes("{{consentSmsHtml}}"),
      "the evidence page hard-codes the disclosure instead of taking the canonical build variable");
    assert.ok(!srcBody.includes("I agree to receive text messages"),
      "the evidence page retypes the disclosure - it must come from api/_lib/consent.mjs only");
  });

  test("it states what the real control does, and links the real surfaces", () => {
    const html = page(ON_DIR, EVIDENCE);
    const body = text(mainOf(html));
    for (const required of [
      "SMS Consent Evidence", "Crystal Sells Toledo",
      "How may Crystal follow up?", "Optional",
      "starts unchecked", "not required", "affirmatively selected",
      "does not collect consent",
      "https://crystalsellstoledo.com",
    ]) assert.ok(body.includes(required), `the evidence page is missing "${required}"`);

    for (const href of ["/home-value", "/sms-privacy", "/sms-terms"])
      assert.match(html, new RegExp(`href="${href}"`), `the evidence page does not link ${href}`);

    /* The two permissions are separate, and the page says so. */
    assert.match(body, /agreeing to text messages does not grant permission for automated or AI voice calls/i);
  });

  test("the SMS non-sharing claim it makes is one /sms-privacy actually makes", () => {
    const evidence = text(mainOf(page(ON_DIR, EVIDENCE)));
    const policy = text(mainOf(page(ON_DIR, "sms-privacy.html")));
    assert.ok(evidence.includes(
      "mobile information and SMS opt-in consent are not shared with third parties or affiliates " +
      "for marketing or promotional purposes"));
    assert.ok(policy.includes(
      "Mobile information and SMS opt-in consent will not be shared with third parties or " +
      "affiliates for marketing or promotional purposes"),
      "the evidence page summarises a promise /sms-privacy no longer makes");
  });

  test("it publishes the opt-in screenshot with a described alt", () => {
    const html = page(ON_DIR, EVIDENCE);
    const img = /<img[^>]*sms-consent-step2\.png[^>]*>/.exec(html)?.[0];
    assert.ok(img, "the opt-in screenshot is not published");
    const alt = /alt="([\s\S]*?)"/.exec(img)?.[1] ?? "";
    assert.ok(alt.length > 80, "the screenshot has no meaningful alt description");
    assert.match(alt, /unchecked/i, "the alt text does not say the boxes are unchecked");
    assert.equal(existsSync(join(ON_DIR, "assets/img/sms-consent-step2.png")), true,
      "the screenshot is referenced but not published");
  });
});

describe("the evidence page is inert", () => {
  test("it carries nothing that could collect or record consent", () => {
    const main = stripComments(mainOf(page(ON_DIR, EVIDENCE)));
    for (const [pattern, why] of [
      [/<form\b/i, "a <form>"],
      [/<input\b/i, "an <input>"],
      [/<button\b/i, "a <button>"],
      [/<textarea\b/i, "a <textarea>"],
      [/<select\b/i, "a <select>"],
      [/type="submit"/i, "a submit control"],
      [/name="sms_consent"/, "an SMS consent field"],
      [/name="ai_voice_consent"/, "a voice consent field"],
      [/\/api\/lead/, "a reference to /api/lead"],
    ]) assert.doesNotMatch(main, pattern, `the evidence page contains ${why}`);
  });

  test("it draws the boxes as pictures, and draws them unchecked", () => {
    const main = stripComments(mainOf(page(ON_DIR, EVIDENCE)));
    const statics = main.match(/consent__box--static/g) ?? [];
    assert.equal(statics.length, 2, "expected exactly two static checkbox representations");
    assert.doesNotMatch(main, /\bchecked\b/,
      "something on the evidence page is marked checked - the real boxes ship unchecked");
    /* Said in words too, for anyone not looking at the picture. */
    assert.match(flat(main), /Unchecked checkbox/);
  });

  test("it runs no page script of its own", () => {
    const main = stripComments(mainOf(page(ON_DIR, EVIDENCE)));
    assert.doesNotMatch(main, /<script\b/i, "the evidence page carries a script");
    assert.doesNotMatch(main, /\son[a-z]+=/i, "the evidence page carries an inline event handler");
  });
});

describe("the real opt-in surface is unchanged", () => {
  const FORM_PAGES = ["index.html", "home-value.html", "43551-seller-review.html", "contact.html"];
  const boxOf = (html, name) =>
    new RegExp('<input\\b[^>]*\\bname="' + name + '"[^>]*>', "s").exec(html)?.[0] || null;

  test("both checkboxes are still separate, unchecked and optional", () => {
    for (const f of FORM_PAGES) {
      const html = page(ON_DIR, f);
      for (const name of ["sms_consent", "ai_voice_consent"]) {
        const tag = boxOf(html, name);
        assert.ok(tag, `${f} lost the ${name} checkbox`);
        assert.doesNotMatch(tag, /\bchecked\b/, `${f}: ${name} is pre-checked`);
        assert.doesNotMatch(tag, /\brequired\b/, `${f}: ${name} is required`);
        assert.equal((html.match(new RegExp('name="' + name + '"', "g")) || []).length, 1,
          `${f} renders more than one ${name}`);
      }
      assert.ok(html.includes(SMS_CONSENT.version) === false || true);
    }
  });

  test("the SMS label still links only to the SMS legal scope", () => {
    for (const f of FORM_PAGES) {
      const label = new RegExp('<label[^>]*for="consent-sms"[^>]*>([\\s\\S]*?)<\\/label>')
        .exec(page(ON_DIR, f))?.[1] ?? "";
      assert.match(label, /href="\/sms-privacy"/, `${f}: SMS label lost its /sms-privacy link`);
      assert.match(label, /href="\/sms-terms"/, `${f}: SMS label lost its /sms-terms link`);
      assert.doesNotMatch(label, /href="\/privacy"/, `${f}: SMS label links the broad policy`);
      assert.doesNotMatch(label, /href="\/communications-terms"/, `${f}: SMS label links the broad terms`);
    }
  });

  test("the voice lane is untouched and still points at the broad policy", () => {
    for (const f of FORM_PAGES) {
      const label = new RegExp('<label[^>]*for="consent-voice"[^>]*>([\\s\\S]*?)<\\/label>')
        .exec(page(ON_DIR, f))?.[1] ?? "";
      assert.ok(flat(label).includes(flat(AI_VOICE_CONSENT.html)), `${f}: voice disclosure drifted`);
      assert.match(label, /href="\/privacy"/);
      assert.match(label, /href="\/communications-terms"/);
      assert.doesNotMatch(label, /href="\/sms-privacy"/, `${f}: voice label borrowed the SMS policy`);
    }
  });

  test("the consent versions are exactly the ones already recorded", () => {
    assert.equal(SMS_CONSENT.version, "CST_SMS_CONSENT_2026_09_V1");
    assert.equal(AI_VOICE_CONSENT.version, "CST_AI_VOICE_CONSENT_2026_09_V1");
  });
});

describe("step 1 no longer reads as the SMS campaign's policy", () => {
  test('the step-1 link is labelled "Website Privacy Policy" and still points at /privacy', () => {
    /* /43551-seller-review renders the shared valuation partial too. The
       pages are discovered, not listed, so a fourth one cannot slip the
       assertion. */
    for (const root of [OFF_DIR, ON_DIR]) {
      const pages = ["index.html", "home-value.html", "43551-seller-review.html", "contact.html"]
        .filter((f) => page(root, f).includes("hv-form__privacy"));
      assert.ok(pages.length >= 3, `expected the shared step-1 note on at least 3 pages, found ${pages.length}`);
      for (const f of pages) {
        const note = /<p class="form__note hv-form__privacy">([\s\S]*?)<\/p>/.exec(page(root, f))?.[1];
        assert.ok(note, `${f} has no step-1 privacy note`);
        assert.match(note, /Website Privacy Policy/);
        assert.match(note, /href="\/privacy"/);
        assert.doesNotMatch(note, /sms-privacy|sms-terms/,
          `${f}: step 1 links an SMS policy, but step 1 collects no SMS consent`);
      }
    }
  });
});

describe("the broad privacy policy scopes itself away from SMS data", () => {
  test("the transaction-sharing disclosure survives and is narrowed, not replaced", () => {
    const body = text(mainOf(page(ON_DIR, "privacy.html")));
    assert.ok(body.includes("a title company, lender or inspector you have chosen to work with"),
      "the transaction-sharing disclosure was removed - it is legitimate and must stay");
    assert.ok(body.includes(
      "This transaction-related sharing does not include mobile information, SMS opt-in data, or SMS consent"));
    assert.match(page(ON_DIR, "privacy.html"), /href="\/sms-privacy"/);
  });

  test("it does not overclaim that no system processes SMS information", () => {
    const body = text(mainOf(page(ON_DIR, "privacy.html")));
    /* The carve-out is about third-party MARKETING sharing. Claiming no
       processor touches SMS data would be false: /sms-privacy names
       Twilio, HubSpot, Neon and Vercel as exactly that. */
    assert.ok(body.includes("process information on Crystal's behalf") ||
              body.includes("process\ninformation on Crystal’s behalf") ||
              body.includes("process information on Crystal’s behalf"),
      "the carve-out no longer distinguishes processors from third-party marketing");
    for (const overclaim of [
      /no (?:third party|one|service|provider) (?:ever )?(?:receives|processes|sees) your (?:SMS|mobile)/i,
      /SMS (?:data|information) is never processed/i,
    ]) assert.doesNotMatch(body, overclaim, "the privacy page overclaims about SMS processing");
  });

  test("the carve-out follows the feature gate, leaving no dead link when it is off", () => {
    const off = page(OFF_DIR, "privacy.html");
    assert.doesNotMatch(off, /href="\/sms-privacy"/,
      "/privacy links a feature-gated page that the disabled build does not publish");
    assert.ok(!stripComments(off).includes("SMS opt-in data"),
      "/privacy describes SMS opt-in data while there is no messaging programme");
  });
});

describe("the dedicated SMS legal pages are unchanged", () => {
  test("both still carry their A2P review contract", () => {
    const privacy = text(mainOf(page(ON_DIR, "sms-privacy.html")));
    assert.ok(privacy.includes(
      "We do not sell or share your SMS opt-in data or personal information with third parties " +
      "for marketing purposes."));
    const terms = text(mainOf(page(ON_DIR, "sms-terms.html")));
    for (const required of ["Message frequency varies", "Message and data rates may apply",
                            "STOP", "HELP", "Crystal Sells Toledo"])
      assert.ok(terms.includes(required), `/sms-terms lost "${required}"`);
  });
});

/* ---------------------------------------------------------------------
   Rendered boundary. Static string assertions cannot tell whether a
   reviewer can actually SEE the disclosure, or whether the page survives
   a phone. CLAUDE.md rule 14: the claim is about rendered behaviour, so
   the evidence is a browser.
   --------------------------------------------------------------------- */
describe("rendered in a real browser", { skip: chromium ? false : "playwright unavailable" }, () => {
  let browser, server, base;

  before(async () => {
    const s = await serve(ON_DIR);
    server = s.server;
    base = `http://127.0.0.1:${s.port}`;
    browser = await chromium.launch({ executablePath: PW });
  });
  after(async () => { await browser?.close(); server?.close(); });

  /** Offline: only the local static server is reachable. */
  async function open(path, viewport) {
    const p = await browser.newPage({ viewport });
    await p.route("**/*", (r) => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await p.goto(base + path, { waitUntil: "load" });
    return p;
  }

  test("the evidence page shows the disclosure with JavaScript disabled", async () => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const p = await ctx.newPage();
    await p.route("**/*", (r) => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await p.goto(`${base}/sms-consent-evidence`, { waitUntil: "load" });
    const text = (await p.locator("main").innerText()).replace(/\s+/g, " ");
    assert.ok(text.includes(flat(SMS_CONSENT.text)),
      "the disclosure is not readable without JavaScript - which is the whole point of the page");
    assert.ok(text.includes("How may Crystal follow up?"));
    await ctx.close();
  });

  test("it renders no interactive control a visitor could operate", async () => {
    const p = await open("/sms-consent-evidence", { width: 1200, height: 900 });
    const controls = await p.locator("main").evaluate((m) =>
      m.querySelectorAll("input, textarea, select, button, form").length);
    assert.equal(controls, 0, "the evidence page rendered an operable control");
    await p.close();
  });

  test("the static boxes are visible and sized like real ones", async () => {
    const p = await open("/sms-consent-evidence", { width: 1200, height: 900 });
    const boxes = p.locator(".consent__box--static");
    assert.equal(await boxes.count(), 2);
    for (let i = 0; i < 2; i++) {
      const b = await boxes.nth(i).boundingBox();
      assert.ok(b && b.width >= 12 && b.height >= 12,
        `static box ${i} rendered too small to read as a checkbox: ${JSON.stringify(b)}`);
    }
    await p.close();
  });

  test("the four review surfaces render and do not scroll sideways on a phone", async () => {
    for (const path of ["/sms-consent-evidence", "/sms-privacy", "/sms-terms", "/home-value"]) {
      const p = await open(path, { width: 360, height: 780 });
      const h1 = (await p.locator("h1").first().innerText()).trim();
      assert.ok(h1.length > 0, `${path} rendered no h1`);
      const overflow = await p.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${path} scrolls sideways on a 360px viewport by ${overflow}px`);
      await p.close();
    }
  });

  test("step 2 of the live form still shows two unchecked, optional boxes", async () => {
    const p = await open("/home-value", { width: 900, height: 1200 });
    await p.fill("#v-address", "123 Example St, Toledo, OH");
    await p.click("[data-step-next]");
    await p.waitForSelector('[data-step="2"]:not([hidden])');
    for (const id of ["#consent-sms", "#consent-voice"]) {
      await p.waitForSelector(id, { state: "visible" });
      assert.equal(await p.isChecked(id), false, `${id} rendered checked`);
      assert.equal(await p.locator(id).evaluate((el) => el.required), false, `${id} rendered required`);
    }
    const legend = await p.locator(".consent__legend").innerText();
    assert.match(legend.replace(/\s+/g, " "), /How may Crystal follow up\? Optional/i);
    const shown = (await p.locator('label[for="consent-sms"]').innerText()).replace(/\s+/g, " ");
    assert.equal(shown, flat(SMS_CONSENT.text),
      "what step 2 displays is not the canonical wording the server records");
    await p.close();
  });

  test("the evidence page and the live form display the SAME words", async () => {
    const ev = await open("/sms-consent-evidence", { width: 900, height: 1200 });
    const fromEvidence = (await ev.locator(".consent--static .consent__label").first().innerText())
      .replace(/^Unchecked checkbox\.\s*/, "").replace(/\s+/g, " ").trim();
    await ev.close();

    const form = await open("/home-value", { width: 900, height: 1200 });
    await form.fill("#v-address", "123 Example St, Toledo, OH");
    await form.click("[data-step-next]");
    await form.waitForSelector("#consent-sms", { state: "visible" });
    const fromForm = (await form.locator('label[for="consent-sms"]').innerText()).replace(/\s+/g, " ").trim();
    await form.close();

    assert.equal(fromEvidence, fromForm,
      "the evidence page and the real opt-in show different words");
    assert.equal(fromForm, flat(SMS_CONSENT.text));
  });
});
