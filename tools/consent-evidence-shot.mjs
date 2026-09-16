/* Regenerate assets/img/sms-consent-step2.png — the A2P consent evidence
   screenshot published on /sms-consent-evidence.
   ---------------------------------------------------------------------
   WHY A SCRIPT AND NOT A MANUAL CAPTURE. The image is compliance
   evidence: it is offered to a carrier reviewer as a picture of the
   opt-in a consumer actually sees. A hand-cropped screenshot cannot be
   re-derived, drifts the moment the form changes, and — the part that
   matters — nothing stops it showing a real consumer's data. This
   script drives the real built page in a real browser, so the picture is
   reproducible and provably contains no one's information.

   WHAT IT DOES NOT DO. It never contacts Twilio, HubSpot, Neon, Retell,
   an SMTP server or /api/lead. Every request that is not the local
   static server is aborted, so no analytics or font call leaves the box.

   PRIVACY. Only step 1's address field is filled, and only because the
   form will not advance past an invalid required field — the capture is
   of step 2, where the address does not appear. Every step-2 field is
   left empty and untouched. The value used is a literal placeholder,
   not a real address.

   RUN:  COMMUNICATIONS_CONSENT_ENABLED=true node tools/build.mjs
         node tools/consent-evidence-shot.mjs
   Playwright and a Chromium binary are required; set PW_CHROMIUM to
   point at one, exactly as tests/browser.test.mjs does. */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const OUT = join(ROOT, "assets/img/sms-consent-step2.png");
const EXEC = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium";

/* Not a real address. The capture never includes it; it exists only to
   satisfy the required-field check that gates the step transition. */
const PLACEHOLDER_ADDRESS = "123 Example St, Toledo, OH";

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
      if (!existsSync(f)) { res.statusCode = 404; return res.end("not found"); }
      res.setHeader("Content-Type", TYPES[extname(f)] || "application/octet-stream");
      res.end(readFileSync(f));
    });
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

const { chromium } = await import("playwright");

if (!existsSync(join(PUBLIC, "home-value.html")))
  throw new Error("public/home-value.html is missing - build with COMMUNICATIONS_CONSENT_ENABLED=true first");

const { server, port } = await serve();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: EXEC });

try {
  const page = await browser.newPage({
    viewport: { width: 900, height: 1400 },
    deviceScaleFactor: 2,          /* retina, so the published PNG is not soft */
    reducedMotion: "reduce",
  });

  /* Nothing but the local static server. An aborted request is how this
     stays offline even though the built page references Google Fonts. */
  await page.route("**/*", (route) =>
    route.request().url().startsWith(base) ? route.continue() : route.abort());

  await page.goto(`${base}/home-value`, { waitUntil: "load" });

  const consentEnabled = await page.locator("#consent-sms").count();
  if (!consentEnabled)
    throw new Error("the consent control is absent - rebuild with COMMUNICATIONS_CONSENT_ENABLED=true");

  await page.fill("#v-address", PLACEHOLDER_ADDRESS);
  await page.click("[data-step-next]");
  await page.waitForSelector('[data-step="2"]:not([hidden])');
  await page.waitForSelector("#consent-sms", { state: "visible" });

  /* Assert the captured state rather than trusting it: a screenshot that
     silently records a ticked box would be evidence of the opposite of
     what this page claims. */
  for (const id of ["#consent-sms", "#consent-voice"]) {
    if (await page.isChecked(id)) throw new Error(`${id} is checked - refusing to publish that as evidence`);
    if (await page.locator(id).evaluate((el) => el.required))
      throw new Error(`${id} is required - refusing to publish that as evidence`);
  }
  /* No consumer data in the frame. Step 2's fields must all be empty. */
  const dirty = await page.locator('[data-step="2"]').evaluate((step) =>
    [...step.querySelectorAll("input:not([type=checkbox]), textarea, select")]
      .filter((el) => el.value !== "").map((el) => el.name));
  if (dirty.length) throw new Error(`step 2 fields carry data: ${dirty.join(", ")}`);

  /* Capture the PANEL, not the bare step. `[data-step="2"]` is a plain
     div with no padding of its own, so screenshotting it crops flush to
     the text and clips the right-hand edge of a wrapped disclosure - the
     exact line a reviewer needs to read. `.valueform` is the card the
     form sits in and supplies the gutter. Step 1 is hidden by now, so the
     panel frames step 2 with its own heading and spacing. */
  const panel = page.locator(".valueform");
  if (await panel.count() !== 1) throw new Error("expected exactly one .valueform panel");
  await panel.screenshot({ path: OUT });
  console.log(`wrote ${OUT}`);
} finally {
  await browser.close();
  server.close();
}
