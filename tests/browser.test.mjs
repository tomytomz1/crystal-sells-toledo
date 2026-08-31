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
});
