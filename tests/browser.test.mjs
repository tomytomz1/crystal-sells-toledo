/* Browser-level behaviour: attribution, submit states, and keyboard access.
   Skips cleanly (rather than failing) where Playwright or a browser binary
   is unavailable, so `npm test` still runs in a bare environment. */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");

let chromium = null;
try { ({ chromium } = await import("playwright")); } catch { /* not installed */ }
const EXEC = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium";
const canRun = Boolean(chromium) && existsSync(PUBLIC);

const TYPES = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png",
  ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain",
};

function serve() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p === "/") p = "/index.html";
      let f = join(PUBLIC, p);
      if (!existsSync(f) && existsSync(f + ".html")) f += ".html";
      if (!existsSync(f)) { res.statusCode = 404; return res.end("nf"); }
      res.setHeader("Content-Type", TYPES[extname(f)] || "application/octet-stream");
      res.end(readFileSync(f));
    });
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

describe("browser behaviour", { skip: canRun ? false : "playwright or build output unavailable" }, () => {
  let browser, server, base;

  before(async () => {
    ({ server, port: base } = await serve().then((r) => ({ server: r.server, port: r.port })));
    base = `http://127.0.0.1:${base}`;
    browser = await chromium.launch({ executablePath: EXEC });
  });
  after(async () => { await browser?.close(); server?.close(); });

  /** New page with the lead endpoint stubbed to a chosen outcome. */
  async function page({ apiStatus = 200, apiBody = { ok: true, submission_id: "csv_stub" } } = {}) {
    const p = await browser.newPage();
    await p.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/lead")) {
        return route.fulfill({
          status: apiStatus,
          contentType: "application/json",
          body: JSON.stringify(apiBody),
        });
      }
      if (url.startsWith(base)) return route.continue();
      return route.abort();
    });
    return p;
  }

  async function fillContact(p) {
    await p.fill("#c-first", "Jane");
    await p.fill("#c-last", "Doe");
    await p.fill("#c-email", "jane@example.com");
    await p.fill("#c-message", "Please call me about selling.");
  }

  /* ---------------------------------------------------- attribution --- */

  test("captures first-touch attribution and never overwrites it", async () => {
    const p = await page();
    await p.goto(`${base}/?utm_source=google&utm_medium=cpc&utm_campaign=spring&gclid=GC1`,
      { waitUntil: "load" });
    const first = await p.evaluate(() => JSON.parse(localStorage.getItem("csv_attr_v1")));
    assert.equal(first.utm_source, "google");
    assert.equal(first.gclid, "GC1");
    assert.ok(first.first_touch_at);

    // A later visit from a different source must not rewrite acquisition.
    await p.goto(`${base}/sell?utm_source=facebook&utm_medium=social&fbclid=FB9`, { waitUntil: "load" });
    const second = await p.evaluate(() => JSON.parse(localStorage.getItem("csv_attr_v1")));
    assert.equal(second.utm_source, "google", "first touch was overwritten");
    assert.equal(second.gclid, "GC1");
    assert.equal(second.first_touch_at, first.first_touch_at);
    await p.close();
  });

  test("attribution travels with the submitted payload", async () => {
    const p = await page();
    let sent = null;
    p.on("request", (r) => { if (r.url().includes("/api/lead")) sent = JSON.parse(r.postData() || "{}"); });
    await p.goto(`${base}/contact?utm_source=bing&msclkid=MS7`, { waitUntil: "load" });
    await fillContact(p);
    await p.click("#c-first"); // ensure focus is inside the form
    await p.locator("form[data-form] button[type=submit]").click();
    await p.waitForTimeout(500);
    assert.ok(sent, "no request was sent");
    assert.equal(sent.form_type, "contact");
    assert.equal(sent.attribution.utm_source, "bing");
    assert.equal(sent.attribution.msclkid, "MS7");
    assert.equal(sent.email, "jane@example.com");
    await p.close();
  });

  /* -------------------------------------------------- submit states --- */

  test("a successful response shows success, resets the form and fires the event", async () => {
    const p = await page({ apiBody: { ok: true, submission_id: "csv_abc123" } });
    await p.goto(`${base}/contact`, { waitUntil: "load" });
    await p.evaluate(() => {
      window.__events = [];
      window.addEventListener("lead_submit_success", (e) => window.__events.push(e.detail));
    });
    await fillContact(p);
    await p.locator("form[data-form] button[type=submit]").click();
    await p.waitForTimeout(600);

    const cls = await p.getAttribute(".form-status", "class");
    assert.match(cls, /form-status--ok/, "success state not shown");
    assert.equal(await p.inputValue("#c-first"), "", "form was not reset after acceptance");
    const events = await p.evaluate(() => window.__events);
    assert.equal(events.length, 1);
    assert.equal(events[0].submission_id, "csv_abc123");
    assert.equal(events[0].form_type, "contact");
    await p.close();
  });

  test("a failed response keeps every value and does not claim success", async () => {
    const p = await page({ apiStatus: 502, apiBody: { ok: false, code: "DELIVERY_FAILED", message: "Could not submit." } });
    await p.goto(`${base}/contact`, { waitUntil: "load" });
    await p.evaluate(() => {
      window.__errs = [];
      window.addEventListener("lead_submit_error", (e) => window.__errs.push(e.detail));
    });
    await fillContact(p);
    await p.locator("form[data-form] button[type=submit]").click();
    await p.waitForTimeout(600);

    const cls = await p.getAttribute(".form-status", "class");
    assert.match(cls, /form-status--err/);
    assert.ok(!/form-status--ok/.test(cls), "claimed success on a failure");
    assert.equal(await p.inputValue("#c-first"), "Jane", "form was cleared on failure");
    assert.equal(await p.inputValue("#c-message"), "Please call me about selling.");

    const errs = await p.evaluate(() => window.__errs);
    assert.equal(errs[0].error_code, "DELIVERY_FAILED");

    // Recovery is offered, never forced.
    assert.equal(p.url(), `${base}/contact`, "navigated the visitor away automatically");
    const mailto = await p.locator('.form-status a[href^="mailto:"]').count();
    assert.ok(mailto >= 1, "no secondary mailto recovery offered");
    await p.close();
  });

  test("a 200 carrying ok:false is treated as a failure", async () => {
    const p = await page({ apiStatus: 200, apiBody: { ok: false, code: "NOT_CONFIGURED" } });
    await p.goto(`${base}/contact`, { waitUntil: "load" });
    await fillContact(p);
    await p.locator("form[data-form] button[type=submit]").click();
    await p.waitForTimeout(600);
    assert.match(await p.getAttribute(".form-status", "class"), /form-status--err/);
    assert.equal(await p.inputValue("#c-first"), "Jane");
    await p.close();
  });

  /* ------------------------------------------- progressive home-value -- */

  test("home-value step 2 is hidden from tab order until step 1 is complete", async () => {
    const p = await page();
    await p.goto(`${base}/home-value`, { waitUntil: "load" });
    assert.equal(await p.locator('[data-step="1"]').isVisible(), true);
    assert.equal(await p.locator('[data-step="2"]').isVisible(), false);
    // hidden attribute removes it from the a11y tree, not just from view
    assert.ok(await p.locator('[data-step="2"]').getAttribute("hidden") !== null);
    await p.close();
  });

  test("home-value is fully keyboard operable", async () => {
    const p = await page();
    await p.goto(`${base}/home-value`, { waitUntil: "load" });

    await p.focus("#v-address");
    await p.keyboard.type("123 Louisiana Ave, Perrysburg, OH 43551");
    await p.keyboard.press("Tab");
    const onNext = await p.evaluate(() => document.activeElement?.hasAttribute("data-step-next"));
    assert.ok(onNext, "Tab from the address field does not reach the advance button");

    await p.keyboard.press("Enter");
    await p.waitForTimeout(400);
    assert.equal(await p.locator('[data-step="2"]').isVisible(), true, "Enter did not advance");
    assert.equal(await p.locator('[data-step="1"]').isVisible(), false);

    const focused = await p.evaluate(() => document.activeElement?.id);
    assert.equal(focused, "v-first", "focus was not moved into the new step");

    // Back returns to step 1 with the address preserved.
    await p.locator("[data-step-back]").click();
    await p.waitForTimeout(300);
    assert.equal(await p.inputValue("#v-address"), "123 Louisiana Ave, Perrysburg, OH 43551");
    await p.close();
  });

  test("step 1 refuses to advance without an address", async () => {
    const p = await page();
    await p.goto(`${base}/home-value`, { waitUntil: "load" });
    await p.locator("[data-step-next]").click();
    await p.waitForTimeout(300);
    assert.equal(await p.locator('[data-step="2"]').isVisible(), false,
      "advanced past a required empty field");
    await p.close();
  });

  test("the step indicator announces progress", async () => {
    const p = await page();
    await p.goto(`${base}/home-value`, { waitUntil: "load" });
    const ind = p.locator("[data-step-indicator]");
    assert.equal(await ind.getAttribute("aria-live"), "polite");
    assert.match(await ind.textContent(), /Step 1 of 2/);
    await p.fill("#v-address", "1 Main St");
    await p.locator("[data-step-next]").click();
    await p.waitForTimeout(300);
    assert.match(await ind.textContent(), /Step 2 of 2/);
    await p.close();
  });

  /* ------------------------------------------- homepage hero (CRO) ---- */

  async function fillHomeStep1(p, addr = "55 Louisiana Ave, Perrysburg, OH 43551") {
    await p.fill("#v-address", addr);
    await p.locator("[data-step-next]").click();
    await p.waitForTimeout(350);
  }

  test("homepage hero carries the home_value form, not a link to it", async () => {
    const p = await page();
    await p.goto(`${base}/`, { waitUntil: "load" });
    const form = p.locator("form[data-form]");
    assert.equal(await form.count(), 1, "expected exactly one form on the homepage");
    assert.equal(await form.getAttribute("data-form-type"), "home_value");
    assert.equal(await p.locator("#v-address").count(), 1);
    /* The form must live inside the hero, not merely on the page. */
    const inHero = await p.evaluate(() =>
      Boolean(document.querySelector(".hero--capture .hero__content form[data-form]")));
    assert.ok(inHero, "form is not inside the hero content column");
    await p.close();
  });

  test("homepage h1 is the control copy and has no salesperson name", async () => {
    const p = await page();
    await p.goto(`${base}/`, { waitUntil: "load" });
    const h1s = p.locator("h1");
    assert.equal(await h1s.count(), 1);
    assert.equal((await h1s.textContent()).trim(), "What could your Perrysburg home sell for?");
    assert.ok(!/Crystal\s+Saylor/.test(await h1s.textContent()));
    await p.close();
  });

  test("homepage step 2 is hidden until step 1 completes", async () => {
    const p = await page();
    await p.goto(`${base}/`, { waitUntil: "load" });
    assert.equal(await p.locator('[data-step="2"]').isVisible(), false);
    assert.ok(await p.locator('[data-step="2"]').getAttribute("hidden") !== null,
      "step 2 must use the hidden attribute so it leaves the a11y tree");
    await fillHomeStep1(p);
    assert.equal(await p.locator('[data-step="2"]').isVisible(), true);
    assert.equal(await p.inputValue("#v-address"), "55 Louisiana Ave, Perrysburg, OH 43551",
      "address was not preserved across the step change");
    await p.close();
  });

  test("homepage hero is keyboard operable and moves focus into step 2", async () => {
    const p = await page();
    await p.goto(`${base}/`, { waitUntil: "load" });
    await p.focus("#v-address");
    await p.keyboard.type("9 Elm St, Perrysburg, OH");
    await p.keyboard.press("Tab");
    assert.ok(await p.evaluate(() => document.activeElement?.hasAttribute("data-step-next")),
      "Tab from the address field does not reach the advance button");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(350);
    assert.equal(await p.evaluate(() => document.activeElement?.id), "v-first");
    await p.locator("[data-step-back]").click();
    await p.waitForTimeout(250);
    assert.equal(await p.inputValue("#v-address"), "9 Elm St, Perrysburg, OH");
    await p.close();
  });

  test("homepage lead posts to /api/lead with attribution and page '/'", async () => {
    const p = await page({ apiBody: { ok: true, submission_id: "csv_home" } });
    let sent = null, urls = [];
    p.on("request", (r) => {
      if (/\/api\//.test(r.url())) urls.push(new URL(r.url()).pathname);
      if (r.url().includes("/api/lead")) sent = JSON.parse(r.postData() || "{}");
    });
    await p.goto(`${base}/?utm_source=google&utm_medium=cpc&gclid=HOMEQA`, { waitUntil: "load" });
    await fillHomeStep1(p);
    await p.fill("#v-first", "Sam"); await p.fill("#v-last", "Rivera");
    await p.fill("#v-email", "sam@example.com");
    await p.locator('form[data-form] button[type=submit]').click();
    await p.waitForTimeout(600);

    assert.deepEqual([...new Set(urls)], ["/api/lead"], "a second API endpoint was contacted");
    assert.equal(sent.form_type, "home_value");
    assert.equal(sent.page, "/");
    assert.equal(sent.attribution.utm_source, "google");
    assert.equal(sent.attribution.gclid, "HOMEQA");
    assert.ok(sent.property_address.startsWith("55 Louisiana"));
    /* The address must never travel in the URL. */
    assert.ok(!p.url().includes("Louisiana"), "property address leaked into the URL");
    await p.close();
  });

  test("homepage confirms only after server acceptance", async () => {
    const p = await page({ apiBody: { ok: true, submission_id: "csv_ok9" } });
    await p.goto(`${base}/`, { waitUntil: "load" });
    await p.evaluate(() => { window.__ok = []; window.addEventListener("lead_submit_success", (e) => window.__ok.push(e.detail)); });
    await fillHomeStep1(p);
    await p.fill("#v-first", "Sam"); await p.fill("#v-last", "Rivera");
    await p.fill("#v-email", "sam@example.com");
    await p.locator('form[data-form] button[type=submit]').click();
    await p.waitForTimeout(600);
    assert.equal((await p.evaluate(() => window.__ok))[0].submission_id, "csv_ok9");
    /* Success is now a persistent panel that REPLACES the form, rather than
       an inline note beside a form reset back to an empty step 1. */
    assert.ok(await p.isVisible("[data-form-success]"), "no confirmation after acceptance");
    assert.ok(await p.isHidden("form[data-form]"), "the form was left in place");
    await p.close();
  });

  test("homepage failure preserves every field and offers recovery", async () => {
    const p = await page({ apiStatus: 502, apiBody: { ok: false, code: "DELIVERY_FAILED", message: "Could not submit." } });
    await p.goto(`${base}/`, { waitUntil: "load" });
    await fillHomeStep1(p, "9 Elm St");
    await p.fill("#v-first", "Ann"); await p.fill("#v-last", "Lee");
    await p.fill("#v-email", "ann@example.com");
    await p.locator('form[data-form] button[type=submit]').click();
    await p.waitForTimeout(600);
    assert.match(await p.getAttribute(".form-status", "class"), /form-status--err/);
    assert.equal(await p.inputValue("#v-address"), "9 Elm St");
    assert.equal(await p.inputValue("#v-first"), "Ann");
    assert.equal(await p.inputValue("#v-email"), "ann@example.com");
    assert.ok(await p.locator('.form-status a[href^="mailto:"]').count() >= 1);
    assert.equal(p.url(), `${base}/`);
    await p.close();
  });

  test("hero shows no development placeholder and no fake proof", async () => {
    const p = await page();
    await p.goto(`${base}/`, { waitUntil: "load" });
    const heroText = await p.evaluate(() =>
      document.querySelector(".hero--capture").innerText.replace(/\s+/g, " "));
    for (const banned of ["HERO IMAGE", "Degnan", "5-star", "top agent", "#1 ", "specialist", "guarantee"])
      assert.ok(!new RegExp(banned, "i").test(heroText), `hero contains "${banned}"`);
    const imgs = await p.evaluate(() =>
      [...document.querySelectorAll(".hero--capture img")].map((i) => i.getAttribute("src")));
    for (const src of imgs)
      assert.ok(!/placeholder/i.test(src || ""), `hero uses a placeholder image: ${src}`);
    await p.close();
  });

  test("secondary action is subordinate and targets /sell", async () => {
    const p = await page();
    await p.goto(`${base}/`, { waitUntil: "load" });
    const sec = p.locator(".hero__secondary a");
    assert.equal(await sec.getAttribute("href"), "/sell");
    const cls = (await sec.getAttribute("class")) || "";
    assert.ok(!/\bbtn\b/.test(cls), "secondary action is styled as a button");
    const [secFs, ctaFs] = await p.evaluate(() => [
      parseFloat(getComputedStyle(document.querySelector(".hero__secondary a")).fontSize),
      parseFloat(getComputedStyle(document.querySelector("[data-step-next]")).fontSize),
    ]);
    assert.ok(secFs > 0 && ctaFs > 0);
    await p.close();
  });

  test("no horizontal overflow, no CTA wrap, across every target viewport", async () => {
    for (const [w, h] of [[320,568],[360,640],[375,667],[390,844],[393,852],[414,896],[430,932],
                          [1024,768],[1280,800],[1440,900],[1600,900],[1920,1080]]) {
      const p = await browser.newPage({ viewport: { width: w, height: h } });
      await p.route("**/*", (r) => r.request().url().startsWith(base) ? r.continue() : r.abort());
      await p.goto(`${base}/`, { waitUntil: "load" });
      await p.waitForTimeout(150);
      const m = await p.evaluate(() => {
        const de = document.documentElement;
        const cta = document.querySelector("[data-step-next]");
        const eb = document.querySelector(".hero--capture .eyebrow");
        /* body{overflow-x:hidden} clips the document scroll width, so a
           document-level measurement alone can miss real overflow. Measure
           the boxes instead. The honeypot is parked off-canvas on purpose. */
        const vw = de.clientWidth;
        const escapes = [...document.querySelectorAll(".hero--capture *")]
          .filter((el) => !el.classList.contains("hp"))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.right > vw + 1 || r.left < -1);
          })
          .map((el) => el.tagName.toLowerCase() + "." + String(el.className || "").split(" ")[0]);
        return {
          heroEscapes: escapes,
          overflow: de.scrollWidth - de.clientWidth,
          ctaWraps: cta.scrollWidth > cta.clientWidth + 1,
          ctaNowrap: getComputedStyle(cta).whiteSpace === "nowrap",
          ctaH: Math.round(cta.getBoundingClientRect().height),
          ebStartsWithSep: /^\s*[·]/.test(eb.textContent),
        };
      });
      assert.equal(m.overflow, 0, `document horizontal overflow at ${w}x${h}`);
      assert.deepEqual(m.heroEscapes, [],
        `hero content escapes the viewport at ${w}x${h}: ${m.heroEscapes.join(", ")}`);
      assert.ok(!m.ctaWraps, `CTA text wraps at ${w}x${h}`);
      assert.ok(m.ctaNowrap, `CTA lost white-space:nowrap at ${w}x${h}`);
      assert.ok(m.ctaH >= 48, `CTA is only ${m.ctaH}px tall at ${w}x${h}`);
      assert.ok(!m.ebStartsWithSep, `eyebrow starts with a separator at ${w}x${h}`);
      await p.close();
    }
  });

  test("the address field keeps a real label, not placeholder-only UI", async () => {
    for (const path of ["/", "/home-value"]) {
      const p = await page();
      await p.goto(`${base}${path}`, { waitUntil: "load" });
      const a11y = await p.evaluate(() => {
        const input = document.querySelector("#v-address");
        const label = document.querySelector('label[for="v-address"]');
        return {
          hasLabel: Boolean(label),
          labelText: label ? label.textContent.trim() : "",
          autocomplete: input.getAttribute("autocomplete"),
        };
      });
      assert.ok(a11y.hasLabel, `no <label for="v-address"> on ${path}`);
      assert.match(a11y.labelText, /Property address/i, `label text wrong on ${path}`);
      assert.equal(a11y.autocomplete, "street-address", `autocomplete wrong on ${path}`);
      await p.close();
    }
  });

  test("address and CTA are reachable near the fold on mainstream phones", async () => {
    for (const [w, h] of [[375,667],[390,844],[393,852],[414,896],[430,932]]) {
      const p = await browser.newPage({ viewport: { width: w, height: h } });
      await p.route("**/*", (r) => r.request().url().startsWith(base) ? r.continue() : r.abort());
      await p.goto(`${base}/`, { waitUntil: "load" });
      await p.waitForTimeout(150);
      const ok = await p.evaluate(() => {
        const b = (s) => document.querySelector(s).getBoundingClientRect().bottom;
        return b("#v-address") <= innerHeight && b("[data-step-next]") <= innerHeight;
      });
      assert.ok(ok, `address + CTA are below the fold at ${w}x${h}`);
      await p.close();
    }
  });

  test("/home-value still runs the identical funnel", async () => {
    const p = await page({ apiBody: { ok: true, submission_id: "csv_hv" } });
    let sent = null;
    p.on("request", (r) => { if (r.url().includes("/api/lead")) sent = JSON.parse(r.postData() || "{}"); });
    await p.goto(`${base}/home-value`, { waitUntil: "load" });
    assert.equal(await p.locator('[data-step="2"]').isVisible(), false);
    await fillHomeStep1(p, "1 Front St, Perrysburg, OH");
    assert.equal(await p.locator('[data-step="2"]').isVisible(), true);
    await p.fill("#v-first", "Jo"); await p.fill("#v-last", "Kim");
    await p.fill("#v-email", "jo@example.com");
    await p.locator('form[data-form] button[type=submit]').click();
    await p.waitForTimeout(600);
    assert.equal(sent.form_type, "home_value");
    assert.equal(sent.page, "/home-value");
    assert.ok(await p.isVisible("[data-form-success]"), "no confirmation on /home-value");
    await p.close();
  });

  /* -------------------------------------------------------- analytics - */

  test("CTA and contact-intent events fire", async () => {
    const p = await page();
    await p.goto(`${base}/`, { waitUntil: "load" });

    /* Listener registration, navigation suppression, dispatch and collection
       all happen in one evaluation: a synthetic click on an anchor performs
       its default action, and any navigation between two evaluate() calls
       destroys the execution context. Suppression is capture-phase, and the
       tracker listens on document in the bubble phase, so it still runs. */
    const seen = await p.evaluate(() => {
      const out = [];
      ["cta_home_value_click", "cta_sell_click", "phone_click", "email_click"]
        .forEach((n) => window.addEventListener(n, (e) => out.push([n, e.detail])));
      document.addEventListener("click", (e) => e.preventDefault(), true);

      const click = (sel) => {
        const el = document.querySelector(sel);
        if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      };
      click('a[href^="tel:"]');
      click('a[href^="mailto:"]');
      click('a[href="/home-value"]');
      click('a[href="/sell"]');
      return out;
    });

    const names = seen.map((s) => s[0]);
    assert.ok(names.includes("phone_click"), "phone_click did not fire");
    assert.ok(names.includes("cta_home_value_click"), "cta_home_value_click did not fire");
    assert.ok(names.includes("cta_sell_click"), "cta_sell_click did not fire");

    const detail = seen[0][1];
    for (const key of ["page", "utm_source", "utm_medium", "utm_campaign"])
      assert.ok(key in detail, `event detail missing ${key}`);
    await p.close();
  });

  test("lead_form_start fires on first input", async () => {
    const p = await page();
    await p.goto(`${base}/contact`, { waitUntil: "load" });
    await p.evaluate(() => {
      window.__start = [];
      window.addEventListener("lead_form_start", (e) => window.__start.push(e.detail));
    });
    await p.fill("#c-first", "J");
    await p.fill("#c-last", "D");
    const starts = await p.evaluate(() => window.__start);
    assert.equal(starts.length, 1, "lead_form_start should fire once per form");
    assert.equal(starts[0].form_type, "contact");
    await p.close();
  });

  /* =====================================================================
     Google Places address autocomplete
     =====================================================================
     Google is stubbed. These prove OUR behaviour - the list, the keyboard,
     what lands in the input, and that a lead is never blocked - not that
     Google's API returns what we expect. Only a live key proves that.
     ===================================================================== */
  const SUGGESTIONS = [
    "4108 N Holland Sylvania Rd, Toledo, OH 43623, USA",
    "4108 Watermill Ln, Perrysburg, OH 43551, USA",
    "4108 Kingsway Dr, Toledo, OH 43606, USA",
  ];

  /** Install a fake google.maps before any page script runs. */
  async function withMaps(p, { suggestions = SUGGESTIONS, fail = false, rejectTypes = false, delayMs = 0 } = {}) {
    await p.addInitScript(({ suggestions, fail, rejectTypes, delayMs }) => {
      window.__mapsCalls = [];
      window.__csvMapsReady = Promise.resolve(true);
      window.google = {
        maps: {
          importLibrary: () => Promise.resolve({
            AutocompleteSessionToken: function () { this.id = Math.random(); },
            AutocompleteSuggestion: {
              fetchAutocompleteSuggestions: (req) => {
                window.__mapsCalls.push({
                  input: req.input,
                  hasToken: !!req.sessionToken,
                  tokenId: req.sessionToken && req.sessionToken.id,
                  bias: req.locationBias || null,
                  types: req.includedPrimaryTypes || null,
                });
                if (fail) return Promise.reject(new Error("stub failure"));
                const answer = () => ({
                  suggestions: suggestions.map((t) => ({ placePrediction: { text: t } })),
                });
                /* Resolving LATE is how the live reopen bug reproduces: a
                   response for the query before the click lands after it. */
                if (delayMs) return new Promise((r) => setTimeout(() => r(answer()), delayMs));
                /* Places rejects the whole request over one bad type value. */
                if (rejectTypes && req.includedPrimaryTypes)
                  return Promise.reject(new Error("INVALID_ARGUMENT: includedPrimaryTypes"));
                return Promise.resolve({
                  suggestions: suggestions.map((t) => ({ placePrediction: { text: t } })),
                });
              },
            },
          }),
        },
      };
    }, { suggestions, fail, rejectTypes, delayMs });
    return p;
  }

  const openList = async (p, text = "4108") => {
    await p.fill("#v-address", text);
    await p.waitForSelector(".addr-suggest:not([hidden]) [role=option]", { timeout: 3000 });
  };

  test("suggestions appear as the visitor types", async () => {
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await openList(p);
    const opts = await p.$$eval(".addr-suggest [role=option]", (n) => n.map((x) => x.textContent));
    assert.equal(opts.length, 3);
    assert.ok(opts[0].includes("N Holland Sylvania"));
    await p.close();
  });

  test("the lookup is debounced and carries a session token", async () => {
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await p.click("#v-address");
    await p.type("#v-address", "4108 Water", { delay: 20 });
    await openList(p, "4108 Watermill");
    const calls = await p.evaluate(() => window.__mapsCalls);
    assert.ok(calls.length <= 3, `expected few calls for fast typing, got ${calls.length}`);
    assert.ok(calls.every((c) => c.hasToken), "every request must carry a session token");
    await p.close();
  });

  test("a new session token starts after each selection", async () => {
    /* Session tokens are what make autocomplete billed per session rather
       than per keystroke. Reusing one across selections is a billing bug
       that nothing else would surface. */
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await openList(p);
    const before = (await p.evaluate(() => window.__mapsCalls)).slice(-1)[0].tokenId;
    await p.click(".addr-suggest [role=option]");
    await p.fill("#v-address", "");
    await openList(p, "4108 King");
    const after = (await p.evaluate(() => window.__mapsCalls)).slice(-1)[0].tokenId;
    assert.ok(before && after, "both lookups must carry a token");
    assert.notEqual(after, before, "the session token must rotate after a selection");
    await p.close();
  });

  test("every lookup is biased to the Toledo area", async () => {
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await openList(p);
    const calls = await p.evaluate(() => window.__mapsCalls);
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.ok(c.bias, "a request went out with no location bias");
      assert.equal(c.bias.center.lat, 41.557);
      assert.ok(c.bias.radius > 0);
    }
    await p.close();
  });

  test("the bias survives a rejected type filter", async () => {
    /* The regression that put Detroit above Perrysburg: `subpremise` is not
       supported by Places Autocomplete, so the typed request was rejected on
       every keystroke and the retry dropped the bias with it, leaving
       prominence-ranked national results. */
    const p = await withMaps(await page(), { rejectTypes: true });
    await p.goto(base + "/");
    await openList(p);
    const calls = await p.evaluate(() => window.__mapsCalls);
    const retries = calls.filter((c) => !c.types);
    assert.ok(retries.length > 0, "expected a retry without the type filter");
    for (const c of retries)
      assert.ok(c.bias, "the retry dropped the location bias — local results will not rank");
    await p.close();
  });

  test("only address types Places actually supports are requested", async () => {
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await openList(p);
    const typed = (await p.evaluate(() => window.__mapsCalls)).filter((c) => c.types);
    assert.ok(typed.length > 0, "expected a typed request");
    for (const c of typed) {
      assert.ok(!c.types.includes("subpremise"),
        "Places Autocomplete does not support subpremise — it rejects the whole request");
      assert.ok(c.types.length <= 5, "Places allows at most five primary types");
      for (const t of c.types)
        assert.ok(["street_address", "premise"].includes(t), "unexpected type " + t);
    }
    await p.close();
  });

  test("nothing is requested for very short input", async () => {
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await p.fill("#v-address", "41");
    await p.waitForTimeout(500);
    assert.equal((await p.evaluate(() => window.__mapsCalls)).length, 0);
    assert.ok(await p.isHidden(".addr-suggest"));
    await p.close();
  });

  test("clicking a suggestion fills the real input", async () => {
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await openList(p);
    await p.click(".addr-suggest [role=option]:nth-child(2)");
    assert.equal(await p.inputValue("#v-address"), SUGGESTIONS[1]);
    assert.ok(await p.isHidden(".addr-suggest"), "list should close after choosing");
    await p.close();
  });

  test("arrow keys and Enter choose a suggestion", async () => {
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await openList(p);
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("Enter");
    assert.equal(await p.inputValue("#v-address"), SUGGESTIONS[1]);
    await p.close();
  });

  test("Enter on a highlighted suggestion does not advance the step", async () => {
    /* Enter must select the address, not skip past the field. */
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await openList(p);
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("Enter");
    assert.equal(await p.getAttribute('[data-step="2"]', "hidden"), "",
      "step 2 must still be hidden");
    await p.close();
  });

  test("Escape closes the list and keeps what was typed", async () => {
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await openList(p);
    await p.keyboard.press("Escape");
    assert.ok(await p.isHidden(".addr-suggest"));
    assert.equal(await p.inputValue("#v-address"), "4108");
    await p.close();
  });

  test("the field is a labelled combobox for assistive tech", async () => {
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await openList(p);
    const a = await p.evaluate(() => {
      const i = document.querySelector("#v-address");
      const opt = document.querySelector(".addr-suggest [role=option]");
      return {
        role: i.getAttribute("role"),
        expanded: i.getAttribute("aria-expanded"),
        controls: i.getAttribute("aria-controls"),
        listRole: document.querySelector(".addr-suggest").getAttribute("role"),
        optId: opt.id,
        label: document.querySelector('label[for="v-address"]') !== null,
      };
    });
    assert.equal(a.role, "combobox");
    assert.equal(a.expanded, "true");
    assert.equal(a.listRole, "listbox");
    assert.ok(a.controls && a.optId.startsWith(a.controls));
    assert.ok(a.label, "the visible label must survive");
    await p.keyboard.press("ArrowDown");
    assert.equal(await p.getAttribute("#v-address", "aria-activedescendant"),
      await p.getAttribute(".addr-suggest [role=option]", "id"));
    await p.close();
  });

  test("a typed address that matches nothing still submits", async () => {
    /* The whole point: Google not knowing an address must never cost a lead. */
    const p = await withMaps(await page(), { suggestions: [] });
    await p.goto(base + "/");
    await p.fill("#v-address", "Rural Route 2, Wood County, OH");
    await p.waitForTimeout(400);
    assert.ok(await p.isHidden(".addr-suggest"));
    await p.click("[data-step-next]");
    await p.waitForSelector('[data-step="2"]:not([hidden])');
    assert.equal(await p.inputValue("#v-address"), "Rural Route 2, Wood County, OH");
    await p.close();
  });

  test("a Google failure degrades to a plain text field", async () => {
    const p = await withMaps(await page(), { fail: true });
    const errors = [];
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(base + "/");
    await p.fill("#v-address", "4108 Watermill");
    await p.waitForTimeout(600);
    assert.ok(await p.isHidden(".addr-suggest"), "no list on failure");
    assert.equal(errors.length, 0, "a Places failure must not throw at the visitor");
    await p.click("[data-step-next]");
    await p.waitForSelector('[data-step="2"]:not([hidden])', { timeout: 3000 });
    await p.close();
  });

  test("with no Maps key the field is an ordinary input", async () => {
    /* The default build. No key, no script, no combobox, no regression. */
    const p = await page();
    await p.goto(base + "/");
    assert.equal(await p.getAttribute("#v-address", "role"), null);
    assert.equal(await p.locator(".addr-suggest").count(), 0);
    await p.fill("#v-address", "123 Main St, Perrysburg, OH");
    await p.click("[data-step-next]");
    await p.waitForSelector('[data-step="2"]:not([hidden])');
    await p.close();
  });

  test("a chosen address is never longer than the server accepts", async () => {
    const long = "9".repeat(260) + " Long Rd, Toledo, OH, USA";
    const p = await withMaps(await page(), { suggestions: [long] });
    await p.goto(base + "/");
    await openList(p);
    await p.click(".addr-suggest [role=option]");
    const v = await p.inputValue("#v-address");
    assert.ok(v.length <= 200, `address ${v.length} chars exceeds the 200 limit`);
    await p.close();
  });

  test("a chosen address reaches the lead payload", async () => {
    const p = await withMaps(await page());
    let sent = null;
    await p.route("**/api/lead", async (route) => {
      sent = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, submission_id: "csv_stub" }) });
    });
    await p.goto(base + "/");
    await openList(p);
    await p.click(".addr-suggest [role=option]:nth-child(2)");
    await p.click("[data-step-next]");
    await p.waitForSelector('[data-step="2"]:not([hidden])');
    await p.fill("#v-first", "Sam");
    await p.fill("#v-last", "Rivera");
    await p.fill("#v-email", "sam@example.com");
    await p.click('[data-step="2"] button[type=submit]');
    await p.waitForFunction(() => document.querySelector(".form-status")?.textContent?.length > 0);
    assert.equal(sent.property_address, SUGGESTIONS[1]);
    await p.close();
  });

  /* =====================================================================
     Post-submission success state
     =====================================================================
     Measured in a real browser: scroll position, document height and focus
     are exactly the things a DOM-unit assumption gets wrong. The previous
     behaviour reset a two-step form on success, which collapsed a tall
     step 2 into a short step 1, shrank the document, let the browser clamp
     the scroll, and hid the confirmation (it lived inside step 2).
     ===================================================================== */

  /** Fill and submit the home-value funnel on whichever page is given. */
  async function submitHomeValue(p, path = "/") {
    await p.goto(base + path);
    await p.fill("#v-address", "123 Louisiana Ave, Perrysburg, OH 43551");
    await p.click("[data-step-next]");
    await p.waitForSelector('[data-step="2"]:not([hidden])');
    await p.fill("#v-first", "Sam");
    await p.fill("#v-last", "Rivera");
    await p.fill("#v-email", "sam@example.com");
    const before = await p.evaluate(() => ({
      scrollY: window.scrollY,
      docHeight: document.documentElement.scrollHeight,
      formTop: document.querySelector("form[data-form]").getBoundingClientRect().top,
    }));
    await p.click('[data-step="2"] button[type=submit]');
    await p.waitForSelector("[data-form-success]:not([hidden])", { timeout: 5000 });
    await settleScroll(p);
    return before;
  }

  /* `html { scroll-behavior: smooth }` means scrollIntoView ANIMATES. Reading
     a rect the instant the panel appears samples the scroll mid-flight and
     reports a position the visitor never actually sees. Wait for it to stop. */
  async function settleScroll(p) {
    await p.waitForFunction(() => {
      const y = window.scrollY;
      if (window.__lastY === y) return true;
      window.__lastY = y;
      return false;
    }, null, { timeout: 5000, polling: 100 });
    await p.evaluate(() => { delete window.__lastY; });
  }

  for (const [label, path] of [["the homepage", "/"], ["/home-value", "/home-value"]]) {
    test(`a successful submission on ${label} leaves a visible confirmation`, async () => {
      const p = await page();
      await submitHomeValue(p, path);
      const panel = p.locator("[data-form-success]");
      await panel.waitFor({ state: "visible" });
      assert.match(await panel.innerText(), /Your request is in/i);
      assert.match(await panel.innerText(), /\(419\)\s*245-4655/);
      const box = await panel.boundingBox();
      assert.ok(box && box.height > 0, "the confirmation has no visible box");
      await p.close();
    });

    test(`the form is replaced, not reset to step 1, on ${label}`, async () => {
      const p = await page();
      await submitHomeValue(p, path);
      assert.ok(await p.isHidden("form[data-form]"), "the form should be hidden, not reset");
      /* The old bug: step 1 came back and the visitor saw an empty address
         field where their confirmation should have been. */
      assert.ok(await p.isHidden('[data-step="1"]'), "step 1 was shown again after success");
      assert.equal(await p.locator("#v-address").count(), 1);
      assert.ok(!(await p.isVisible("#v-address")), "the address field is visible again");
      await p.close();
    });

    test(`the confirmation is in view, not off-screen, on ${label}`, async () => {
      const p = await page();
      await submitHomeValue(p, path);
      const v = await p.evaluate(() => {
        const el = document.querySelector("[data-form-success]");
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight;
        return { top: r.top, bottom: r.bottom, vh };
      });
      assert.ok(v.bottom > 0 && v.top < v.vh,
        `confirmation is outside the viewport (top ${v.top}, vh ${v.vh})`);
      await p.close();
    });

    test(`focus moves to the confirmation heading on ${label}`, async () => {
      const p = await page();
      await submitHomeValue(p, path);
      const focused = await p.evaluate(() => ({
        hasAttr: document.activeElement.hasAttribute("data-success-heading"),
        text: document.activeElement.textContent.trim(),
      }));
      assert.ok(focused.hasAttr, "focus did not land on the success heading");
      assert.match(focused.text, /Your request is in/i);
      await p.close();
    });
  }

  test("the visitor is left looking at the confirmation, not stranded mid-page", async () => {
    /* The reported symptom: after submitting, the visitor was left roughly
       halfway down the homepage with no confirmation in sight.

       The assertion is NOT that nothing scrolls. A visitor submits from the
       bottom of a tall step 2, so the short panel that replaces it lands
       above the viewport and SHOULD be brought into view. What must hold is
       that the confirmation ends up fully visible and is what they are
       looking at - not some unrelated section further down the page. */
    const p = await page();
    await submitHomeValue(p, "/");
    const v = await p.evaluate(() => {
      const panel = document.querySelector("[data-form-success]");
      const r = panel.getBoundingClientRect();
      const vh = window.innerHeight;
      /* What is at the middle of the screen right now? */
      const mid = document.elementFromPoint(window.innerWidth / 2, vh / 2);
      return {
        top: r.top, bottom: r.bottom, vh,
        midInsidePanel: !!(mid && panel.contains(mid)),
      };
    });
    assert.ok(v.top >= 0 && v.bottom <= v.vh,
      `the confirmation is not fully visible (top ${Math.round(v.top)}, bottom ` +
      `${Math.round(v.bottom)}, viewport ${v.vh})`);
    assert.ok(v.midInsidePanel,
      "the middle of the screen is not the confirmation — the visitor was left elsewhere");
    await p.close();
  });

  test("the submission id is never shown to the visitor", async () => {
    const p = await page({ apiBody: { ok: true, submission_id: "csv_deadbeefdeadbeefdeadbeef" } });
    await submitHomeValue(p, "/");
    const text = await p.innerText("body");
    assert.ok(!text.includes("csv_deadbeefdeadbeefdeadbeef"), "the submission id is on screen");
    /* Still recorded on the form for support. */
    assert.equal(
      await p.getAttribute("form[data-form]", "data-submission-id"),
      "csv_deadbeefdeadbeefdeadbeef");
    await p.close();
  });

  test("the confirmation survives a later scroll and does not revert", async () => {
    const p = await page();
    await submitHomeValue(p, "/");
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.waitForTimeout(400);
    assert.ok(await p.isVisible("[data-form-success]"), "the confirmation disappeared");
    assert.ok(await p.isHidden("form[data-form]"), "the form came back");
    await p.close();
  });

  test("a failed submission keeps the form and everything typed", async () => {
    const p = await page({ apiStatus: 502, apiBody: { ok: false, code: "DELIVERY_FAILED", message: "nope" } });
    await p.goto(base + "/");
    await p.fill("#v-address", "123 Louisiana Ave, Perrysburg, OH 43551");
    await p.click("[data-step-next]");
    await p.waitForSelector('[data-step="2"]:not([hidden])');
    await p.fill("#v-first", "Sam");
    await p.fill("#v-last", "Rivera");
    await p.fill("#v-email", "sam@example.com");
    await p.click('[data-step="2"] button[type=submit]');
    await p.waitForFunction(() => /could not|call|email/i.test(
      document.querySelector(".form-status")?.textContent || ""));

    assert.ok(await p.isHidden("[data-form-success]"), "a failure must not show the confirmation");
    assert.ok(await p.isVisible("form[data-form]"), "the form was hidden on a failure");
    assert.equal(await p.inputValue("#v-first"), "Sam");
    assert.equal(await p.inputValue("#v-email"), "sam@example.com");
    assert.equal(await p.inputValue("#v-address"), "123 Louisiana Ave, Perrysburg, OH 43551");
    await p.close();
  });

  test("a 200 carrying ok:false is a failure, not a confirmation", async () => {
    const p = await page({ apiStatus: 200, apiBody: { ok: false, code: "DELIVERY_FAILED" } });
    await p.goto(base + "/");
    await p.fill("#v-address", "1 Test St");
    await p.click("[data-step-next]");
    await p.waitForSelector('[data-step="2"]:not([hidden])');
    await p.fill("#v-first", "Sam");
    await p.fill("#v-last", "Rivera");
    await p.fill("#v-email", "sam@example.com");
    await p.click('[data-step="2"] button[type=submit]');
    await p.waitForFunction(() => (document.querySelector(".form-status")?.textContent || "").length > 0);
    assert.ok(await p.isHidden("[data-form-success]"));
    await p.close();
  });

  /* =====================================================================
     Google Analytics wiring
     =====================================================================
     The built pages under test are a LOCAL build, so they carry no tag.
     These prove the site's own event layer would feed GA4 correctly once
     the tag is present, and that nothing depends on GA4 being there.
     ===================================================================== */

  test("site events reach gtag when a Google tag is present", async () => {
    const p = await page();
    await p.addInitScript(() => {
      window.__gtag = [];
      window.gtag = function () { window.__gtag.push([].slice.call(arguments)); };
    });
    await p.goto(base + "/");
    /* A real click on a tel: link navigates and destroys the execution
       context, so dispatch synthetically with capture-phase suppression -
       the same technique the CTA tracking test uses. */
    const calls = await p.evaluate(() => {
      document.addEventListener("click", (e) => e.preventDefault(), true);
      const el = document.querySelector('a[href^="tel:"]');
      if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return window.__gtag;
    });
    const evt = calls.find((c) => c[0] === "event" && c[1] === "phone_click");
    assert.ok(evt, "phone_click never reached gtag: " + JSON.stringify(calls));
    assert.equal(typeof evt[2], "object", "the event carried no payload");
    await p.close();
  });

  test("lead submission reports success to gtag", async () => {
    const p = await page({ apiBody: { ok: true, submission_id: "csv_ga4" } });
    await p.addInitScript(() => {
      window.__gtag = [];
      window.gtag = function () { window.__gtag.push([].slice.call(arguments)); };
    });
    await submitHomeValue(p, "/");
    const calls = await p.evaluate(() => window.__gtag);
    const evt = calls.find((c) => c[1] === "lead_submit_success");
    assert.ok(evt, "lead_submit_success never reached gtag");
    assert.equal(evt[2].submission_id, "csv_ga4");
    await p.close();
  });

  test("the site works with no analytics vendor at all", async () => {
    /* gtag is absent in this build. Nothing may throw, and the funnel must
       still complete - analytics is never load-bearing. */
    const p = await page({ apiBody: { ok: true, submission_id: "csv_noga" } });
    const errors = [];
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(base + "/");
    assert.equal(await p.evaluate(() => typeof window.gtag), "undefined",
      "a local build must not ship a Google tag");
    await submitHomeValue(p, "/");
    assert.ok(await p.isVisible("[data-form-success]"));
    assert.equal(errors.length, 0, "page errors without gtag: " + errors.join("; "));
    await p.close();
  });

  test("a local build ships no Google tag at all", async () => {
    const p = await page();
    await p.goto(base + "/");
    const n = await p.evaluate(() =>
      document.querySelectorAll('script[src*="googletagmanager.com"]').length);
    assert.equal(n, 0, "a non-production build must not report to GA4");
    await p.close();
  });

  /* =====================================================================
     Choosing an address suggestion is terminal
     =====================================================================
     Live bug: after clicking a suggestion the address was written correctly,
     then the menu immediately reopened underneath it showing the same address
     and its neighbours. Two causes: the post-selection `input` event we
     dispatch re-entered our own listener and scheduled another lookup, and a
     response already in flight could render after the menu had closed.
     ===================================================================== */

  const menuOpen = (p) => p.evaluate(() => {
    const l = document.querySelector(".addr-suggest");
    return !!l && !l.hidden && l.querySelectorAll("[role=option]").length > 0;
  });

  test("clicking a suggestion closes the menu and it stays closed", async () => {
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await openList(p);
    await p.click(".addr-suggest [role=option]:nth-child(2)");

    assert.equal(await p.inputValue("#v-address"), SUGGESTIONS[1]);
    assert.equal(await menuOpen(p), false, "the menu did not close");
    /* Well past the 250ms debounce and any queued work. */
    await p.waitForTimeout(900);
    assert.equal(await menuOpen(p), false, "the menu reopened after selection");
    assert.equal(await p.inputValue("#v-address"), SUGGESTIONS[1], "the address changed");
    await p.close();
  });

  test("Enter on a highlighted suggestion closes the menu and it stays closed", async () => {
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await openList(p);
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("Enter");

    assert.equal(await p.inputValue("#v-address"), SUGGESTIONS[0]);
    assert.equal(await menuOpen(p), false);
    await p.waitForTimeout(900);
    assert.equal(await menuOpen(p), false, "the menu reopened after keyboard selection");
    await p.close();
  });

  test("a stale response resolving AFTER selection cannot reopen the menu", async () => {
    /* The live failure, reproduced: the lookup for what was typed resolves
       only after the visitor has already clicked a suggestion. */
    const p = await withMaps(await page(), { delayMs: 700 });
    await p.goto(base + "/");
    await p.fill("#v-address", "4108");
    await p.waitForSelector(".addr-suggest:not([hidden]) [role=option]", { timeout: 4000 });

    /* Start another lookup, then choose before it can answer. */
    await p.fill("#v-address", "4108 W");
    await p.waitForTimeout(300);            // debounce fired, request in flight
    await p.evaluate(() => {
      const opt = document.querySelector(".addr-suggest [role=option]");
      if (opt) opt.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    });
    const chosen = await p.inputValue("#v-address");
    assert.ok(chosen.length > 6, "nothing was selected: " + chosen);

    await p.waitForTimeout(1200);           // the stale response has landed by now
    assert.equal(await menuOpen(p), false, "a stale response reopened the menu");
    assert.equal(await p.inputValue("#v-address"), chosen, "a stale response changed the address");
    await p.close();
  });

  test("the programmatic write on selection triggers no new Places request", async () => {
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await openList(p);
    const before = (await p.evaluate(() => window.__mapsCalls)).length;
    await p.click(".addr-suggest [role=option]");
    await p.waitForTimeout(900);
    const after = (await p.evaluate(() => window.__mapsCalls)).length;
    assert.equal(after, before, `selection caused ${after - before} extra lookup(s)`);
    await p.close();
  });

  test("editing the selected address makes autocomplete active again", async () => {
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await openList(p);
    await p.click(".addr-suggest [role=option]");
    await p.waitForTimeout(400);
    assert.equal(await menuOpen(p), false);

    /* The visitor changes what they picked. */
    await p.click("#v-address");
    await p.keyboard.press("End");
    await p.keyboard.type(" Apt 4");
    await p.waitForSelector(".addr-suggest:not([hidden]) [role=option]", { timeout: 4000 });
    assert.equal(await menuOpen(p), true, "autocomplete did not come back after an edit");
    await p.close();
  });

  test("selection still rotates the session token", async () => {
    const p = await withMaps(await page());
    await p.goto(base + "/");
    await openList(p);
    const before = (await p.evaluate(() => window.__mapsCalls)).slice(-1)[0].tokenId;
    await p.click(".addr-suggest [role=option]");
    await p.fill("#v-address", "");
    await openList(p, "4108 King");
    const after = (await p.evaluate(() => window.__mapsCalls)).slice(-1)[0].tokenId;
    assert.ok(before && after);
    assert.notEqual(after, before, "the session token stopped rotating");
    await p.close();
  });

  test("a chosen address still submits and reaches the lead payload", async () => {
    const p = await withMaps(await page());
    let sent = null;
    await p.route("**/api/lead", async (route) => {
      sent = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, submission_id: "csv_sel" }) });
    });
    await p.goto(base + "/");
    await openList(p);
    await p.click(".addr-suggest [role=option]:nth-child(2)");
    await p.click("[data-step-next]");
    await p.waitForSelector('[data-step="2"]:not([hidden])');
    await p.fill("#v-first", "Sam");
    await p.fill("#v-last", "Rivera");
    await p.fill("#v-email", "sam@example.com");
    await p.click('[data-step="2"] button[type=submit]');
    await p.waitForSelector("[data-form-success]:not([hidden])");
    assert.equal(sent.property_address, SUGGESTIONS[1]);
    await p.close();
  });


  /* =====================================================================
     Success panel heading contrast
     ===================================================================== */

  /** WCAG relative luminance, compositing any alpha over its backdrop. */
  const CONTRAST_FN = () => {
    window.__contrast = (sel) => {
      const el = document.querySelector(sel);
      const parse = (c) => { const n = c.match(/[\d.]+/g).map(Number); return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 }; };
      const over = (f, b) => ({ r: f.a * f.r + (1 - f.a) * b.r, g: f.a * f.g + (1 - f.a) * b.g, b: f.a * f.b + (1 - f.a) * b.b, a: 1 });
      const lum = (o) => { const [r, g, b] = [o.r, o.g, o.b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      let node = el, bg = null;
      while (node && node !== document.documentElement) {
        const c = getComputedStyle(node).backgroundColor;
        if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) {
          const p = parse(c);
          bg = bg ? over(bg, p) : p;
          if (p.a === 1) break;
        }
        node = node.parentElement;
      }
      if (!bg || bg.a < 1) bg = over(bg || { r: 0, g: 0, b: 0, a: 0 }, { r: 20, g: 18, b: 15, a: 1 });
      const fg = over(parse(getComputedStyle(el).color), bg);
      const L1 = lum(fg), L2 = lum(bg);
      const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
      return { ratio: (hi + 0.05) / (lo + 0.05), color: getComputedStyle(el).color };
    };
  };

  for (const [label, path] of [["the homepage hero", "/"], ["/home-value", "/home-value"]]) {
    test(`the success heading is readable on ${label}`, async () => {
      const p = await page();
      await p.addInitScript(CONTRAST_FN);
      await submitHomeValue(p, path);
      const r = await p.evaluate(() => window.__contrast(".success-panel__title"));
      /* Large text needs 3:1; this clears the 4.5:1 normal-text bar anyway.
         The live bug was near-black on near-black, around 1:1. */
      assert.ok(r.ratio >= 4.5,
        `success heading contrast is ${r.ratio.toFixed(2)}:1 (${r.color}) on ${label}`);
      await p.close();
    });

    test(`the success heading colour is set explicitly on ${label}`, async () => {
      /* `h1,h2,h3,h4 { color: var(--ink) }` beats a colour inherited from the
         panel, so the heading must name its own. */
      const p = await page();
      await submitHomeValue(p, path);
      const same = await p.evaluate(() => {
        const t = document.querySelector(".success-panel__title");
        const panel = document.querySelector("[data-form-success]");
        return { heading: getComputedStyle(t).color, panel: getComputedStyle(panel).color };
      });
      assert.equal(same.heading, same.panel,
        "the heading colour does not match its panel — it is falling back to the global heading ink");
      await p.close();
    });
  }

  test("the gold confirmation mark survives the contrast fix", async () => {
    const p = await page();
    await submitHomeValue(p, "/");
    const mark = await p.evaluate(() => {
      const m = document.querySelector(".success-panel__mark");
      return m ? getComputedStyle(m).backgroundColor : null;
    });
    assert.ok(mark && !/rgba\(0, 0, 0, 0\)/.test(mark), "the accent mark lost its background");
    await p.close();
  });


  /* =====================================================================
     US phone formatting
     ===================================================================== */

  async function phonePage(path = "/") {
    const p = await page();
    await p.goto(base + path);
    if (path === "/") {
      await p.fill("#v-address", "123 Louisiana Ave, Perrysburg, OH 43551");
      await p.click("[data-step-next]");
      await p.waitForSelector('[data-step="2"]:not([hidden])');
    }
    return p;
  }

  test("typing ten digits formats to (586) 324-1248", async () => {
    const p = await phonePage();
    await p.click("#v-phone");
    await p.keyboard.type("5863241248", { delay: 10 });
    assert.equal(await p.inputValue("#v-phone"), "(586) 324-1248");
    await p.close();
  });

  test("the display progresses sensibly as digits arrive", async () => {
    const p = await phonePage();
    await p.click("#v-phone");
    const seen = [];
    for (const ch of "586324") {
      await p.keyboard.type(ch);
      seen.push(await p.inputValue("#v-phone"));
    }
    assert.deepEqual(seen, ["5", "58", "586", "(586) 3", "(586) 32", "(586) 324"]);
    await p.close();
  });

  for (const [name, pasted] of [
    ["raw digits", "5863241248"],
    ["already formatted", "(586) 324-1248"],
    ["hyphenated", "586-324-1248"],
    ["spaced", "586 324 1248"],
    ["with +1 country code", "+1 586 324 1248"],
    ["with 1 country code, no plus", "15863241248"],
  ]) {
    test(`pasting ${name} normalises to (586) 324-1248`, async () => {
      const p = await phonePage();
      await p.evaluate((v) => {
        const el = document.querySelector("#v-phone");
        el.focus();
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, pasted);
      assert.equal(await p.inputValue("#v-phone"), "(586) 324-1248");
      await p.close();
    });
  }

  test("Backspace deletes through generated punctuation", async () => {
    const p = await phonePage();
    await p.click("#v-phone");
    await p.keyboard.type("5863241248");
    assert.equal(await p.inputValue("#v-phone"), "(586) 324-1248");
    for (const expected of ["(586) 324-124", "(586) 324-12", "(586) 324-1", "(586) 324", "(586) 32"]) {
      await p.keyboard.press("Backspace");
      assert.equal(await p.inputValue("#v-phone"), expected);
    }
    await p.close();
  });

  test("Backspace mid-field deletes a digit rather than trapping on punctuation", async () => {
    /* The real trap: the caret sits just after ") ", so a native Backspace
       removes the space, reformatting puts it straight back, and nothing is
       ever deleted. Deleting at the END of the field never reproduces this. */
    const p = await phonePage();
    await p.click("#v-phone");
    await p.keyboard.type("5863241248");
    assert.equal(await p.inputValue("#v-phone"), "(586) 324-1248");
    /* Caret directly after "(586) " — position 6. */
    await p.evaluate(() => document.querySelector("#v-phone").setSelectionRange(6, 6));
    await p.keyboard.press("Backspace");
    /* The nearest digit BEFORE the caret is the "6" of 586, so that is what
       goes: 586 324 1248 -> 58 324 1248. */
    assert.equal(await p.inputValue("#v-phone"), "(583) 241-248",
      "Backspace on punctuation deleted nothing — the caret is trapped");
    await p.close();
  });

  test("held Backspace empties the field rather than sticking on punctuation", async () => {
    const p = await phonePage();
    await p.click("#v-phone");
    await p.keyboard.type("5863241248");
    for (let i = 0; i < 14; i++) await p.keyboard.press("Backspace");
    assert.equal(await p.inputValue("#v-phone"), "", "the caret got trapped on punctuation");
    await p.close();
  });

  test("Delete forward works through punctuation", async () => {
    const p = await phonePage();
    await p.click("#v-phone");
    await p.keyboard.type("5863241248");
    await p.evaluate(() => document.querySelector("#v-phone").setSelectionRange(0, 0));
    await p.keyboard.press("Delete");
    assert.equal(await p.inputValue("#v-phone"), "(863) 241-248");
    await p.close();
  });

  test("selecting all and replacing works", async () => {
    const p = await phonePage();
    await p.click("#v-phone");
    await p.keyboard.type("5863241248");
    await p.keyboard.press("Control+a");
    await p.keyboard.type("4192454655");
    assert.equal(await p.inputValue("#v-phone"), "(419) 245-4655");
    await p.close();
  });

  test("clearing the field leaves it empty, not punctuation", async () => {
    const p = await phonePage();
    await p.click("#v-phone");
    await p.keyboard.type("5863241248");
    await p.fill("#v-phone", "");
    assert.equal(await p.inputValue("#v-phone"), "");
    await p.close();
  });

  test("more than ten digits are ignored", async () => {
    const p = await phonePage();
    await p.click("#v-phone");
    await p.keyboard.type("58632412489999");
    assert.equal(await p.inputValue("#v-phone"), "(586) 324-1248");
    await p.close();
  });

  test("a formatted phone reaches /api/lead and a blank one stays blank", async () => {
    for (const [typed, expected] of [["5863241248", "(586) 324-1248"], ["", ""]]) {
      const p = await page();
      let sent = null;
      await p.route("**/api/lead", async (route) => {
        sent = JSON.parse(route.request().postData() || "{}");
        await route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ ok: true, submission_id: "csv_ph" }) });
      });
      await p.goto(base + "/");
      await p.fill("#v-address", "123 Louisiana Ave, Perrysburg, OH 43551");
      await p.click("[data-step-next]");
      await p.waitForSelector('[data-step="2"]:not([hidden])');
      await p.fill("#v-first", "Sam");
      await p.fill("#v-last", "Rivera");
      await p.fill("#v-email", "sam@example.com");
      if (typed) { await p.click("#v-phone"); await p.keyboard.type(typed); }
      await p.click('[data-step="2"] button[type=submit]');
      await p.waitForSelector("[data-form-success]:not([hidden])");
      assert.equal(sent.phone, expected,
        `phone reached the endpoint as ${JSON.stringify(sent.phone)}`);
      await p.close();
    }
  });

  test("the /contact form is formatted by the same code", async () => {
    const p = await page();
    await p.goto(base + "/contact");
    const sel = 'input[name="phone"]';
    await p.click(sel);
    await p.keyboard.type("5863241248");
    assert.equal(await p.inputValue(sel), "(586) 324-1248");
    await p.close();
  });

  test("autofilling a value without an input event is still formatted", async () => {
    const p = await phonePage();
    await p.evaluate(() => {
      const el = document.querySelector("#v-phone");
      el.value = "5863241248";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(await p.inputValue("#v-phone"), "(586) 324-1248");
    await p.close();
  });
});
