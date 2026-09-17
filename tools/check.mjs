/* =====================================================================
   Pre-flight checks for the built site. Run: npm run check
   Catches the things that quietly break a small marketing site:
   dead internal links, missing alt text, unreplaced template tokens,
   malformed JSON-LD, duplicate or missing meta.
   ===================================================================== */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import {
  SMS_CONSENT, AI_VOICE_CONSENT, consentFeatureEnabled, assertConsentCopyIntact,
} from "../api/_lib/consent.mjs";

/* The same gate tools/build.mjs read. check.mjs runs against whatever that
   build produced, so it has to expect the same shape. */
const CONSENT_ON = consentFeatureEnabled();
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const errors = [];
const warnings = [];
const fail = (f, m) => errors.push(`${f}: ${m}`);
const warn = (f, m) => warnings.push(`${f}: ${m}`);

/* Copy still standing in for something real. Delete a row once it is
   genuinely resolved site-wide. */
const PLACEHOLDERS = [];

const pages = readdirSync(ROOT).filter((f) => f.endsWith(".html"));
if (!pages.length) fail("build", "no HTML pages found in public/ — run `npm run build` first");

const titles = new Map();
const descs = new Map();

for (const file of pages) {
  const html = readFileSync(join(ROOT, file), "utf8");

  /* --- unreplaced template tokens --------------------------------- */
  const leftover = html.match(/\{\{[^}]*\}\}/g);
  if (leftover) fail(file, `unreplaced template tokens: ${[...new Set(leftover)].join(", ")}`);

  /* --- title / description ---------------------------------------- */
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
  const desc = html.match(/<meta name="description" content="([^"]*)"/)?.[1];
  if (!title) fail(file, "missing <title>");
  else {
    if (title.length > 65) warn(file, `title is ${title.length} chars — Google truncates around 60`);
    if (titles.has(title)) fail(file, `duplicate <title> shared with ${titles.get(title)}`);
    titles.set(title, file);
  }
  if (!desc) fail(file, "missing meta description");
  else {
    if (desc.length > 165) warn(file, `meta description is ${desc.length} chars — aim for under 160`);
    if (descs.has(desc)) fail(file, `duplicate meta description shared with ${descs.get(desc)}`);
    descs.set(desc, file);
  }

  /* --- exactly one h1 --------------------------------------------- */
  const h1s = html.match(/<h1[\s>]/g) || [];
  if (h1s.length !== 1) fail(file, `expected exactly one <h1>, found ${h1s.length}`);

  /* --- images: alt text + resolvable src -------------------------- */
  for (const tag of html.match(/<img\b[^>]*>/g) || []) {
    if (!/\balt=/.test(tag)) fail(file, `<img> without alt attribute: ${tag.slice(0, 80)}`);
    const fb = tag.match(/data-fallback="([^"]+)"/)?.[1];
    if (fb && !existsSync(join(ROOT, fb.replace(/^\//, "")))) fail(file, `data-fallback missing on disk: ${fb}`);
  }

  /* --- internal links resolve ------------------------------------- */
  for (const m of html.matchAll(/\bhref="(\/[^"#?]*)(?:[#?][^"]*)?"/g)) {
    const path = m[1];
    if (path === "/") continue;
    const rel = path.replace(/^\//, "");
    const candidates = [rel, rel + ".html", join(rel, "index.html")];
    if (!candidates.some((c) => existsSync(join(ROOT, c)) && statSync(join(ROOT, c)).isFile()))
      fail(file, `internal link goes nowhere: ${path}`);
  }

  /* --- JSON-LD parses --------------------------------------------- */
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(m[1]); } catch (e) { fail(file, `invalid JSON-LD — ${e.message}`); }
  }

  /* --- anchors used in nav actually exist on their page ----------- */
  for (const m of html.matchAll(/\bhref="\/([a-z0-9-]+)#([a-z0-9-]+)"/g)) {
    const target = join(ROOT, m[1] + ".html");
    if (existsSync(target)) {
      const t = readFileSync(target, "utf8");
      if (!new RegExp(`\\bid="${m[2]}"`).test(t)) fail(file, `anchor #${m[2]} not found on /${m[1]}`);
    }
  }

  /* --- OAC 1301:5-1-02(E): displayed content-review date ----------- */
  if (!/Website information last updated:\s*\w+ \d{1,2}, \d{4}/.test(html))
    fail(file, "no content-review date disclosed — OAC 1301:5-1-02(E)");

  /* --- OAC 1301:5-1-02(B): legal identity lockup ------------------- */
  const names = [...html.matchAll(/<span class="legalid__name">([^<]+)<\/span>/g)].map((m) => m[1]);
  if (!names.includes("Crystal Saylor") || !names.includes("Key Realty LTD"))
    fail(file, "legal identity lockup missing — OAC 1301:5-1-02(B)");

  /* The licensed name must never be set at display scale. The brokerage
     appears at body scale, so an h1/h2 carrying the salesperson's name is
     an equal-prominence failure by construction. */
  for (const m of html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/g))
    if (/Crystal\s+Saylor/.test(m[1]))
      fail(file, `licensed name in a display heading — equal prominence risk: "${m[1].trim().slice(0, 60)}"`);

  /* --- every lead form carries a stable identifier ----------------- */
  for (const tag of html.match(/<form\b[^>]*data-form\b[^>]*>/g) || []) {
    const type = tag.match(/data-form-type="([a-z_]+)"/);
    if (!type) fail(file, "a data-form form has no data-form-type");
    else if (!["home_value", "contact", "buyer_inquiry"].includes(type[1]))
      fail(file, `unknown data-form-type: ${type[1]}`);
    if (!/novalidate/.test(tag)) warn(file, "form is missing novalidate");
  }

  /* --- lang + viewport -------------------------------------------- */
  if (!/<html lang="en">/.test(html)) fail(file, "missing lang attribute on <html>");
  if (!/name="viewport"/.test(html)) fail(file, "missing viewport meta");

  /* --- placeholder details still in place -------------------------- */
  for (const [pattern, label] of PLACEHOLDERS)
    if (pattern.test(html)) warn(file, `still contains a placeholder: ${label}`);
}

/* --- required files --------------------------------------------------- */
for (const f of ["robots.txt", "sitemap.xml", "site.webmanifest", "assets/css/styles.css", "assets/js/main.js"])
  if (!existsSync(join(ROOT, f))) fail("site", `missing required file: ${f}`);

/* --- real photography still to be supplied ---------------------------- */
const missingArt = new Set();
for (const file of pages)
  for (const tag of readFileSync(join(ROOT, file), "utf8").match(/<img\b[^>]*data-fallback[^>]*>/g) || []) {
    const src = tag.match(/\ssrc="([^"]+)"/)?.[1];
    if (src && !existsSync(join(ROOT, src.replace(/^\//, "")))) missingArt.add(src);
  }
if (missingArt.size)
  warn("site", `still showing placeholder art for ${missingArt.size} image(s): ${[...missingArt].sort().join(", ")}`);

/* --- lead pipeline ---------------------------------------------------- */
const js = readFileSync(join(ROOT, "assets/js/main.js"), "utf8");

/* The production bundle must post to the server endpoint. A null or absent
   destination would silently return the site to mailto-only delivery. */
if (/leadEndpoint:\s*(null|""|'')/.test(js))
  fail("site", "leadEndpoint is null — forms would fall back to mailto as the normal path");
if (!/leadEndpoint:\s*"\/api\/lead"/.test(js))
  fail("site", "main.js does not post to /api/lead");

/* mailto must never be triggered for the visitor automatically. */
if (/window\.location\.href\s*=\s*(href|mailto)/.test(js))
  fail("site", "main.js navigates the visitor to a mailto: URL automatically");

/* Attribution + analytics must be present in the shipped bundle. */
for (const needle of ["csv_attr_v1", "lead_submit_success", "lead_submit_error",
                      "lead_form_start", "lead_form_step_complete",
                      "cta_home_value_click", "cta_sell_click", "phone_click", "email_click"])
  if (!js.includes(needle)) fail("site", `main.js is missing analytics/attribution hook: ${needle}`);

/* Contact points must not drift. */
if (!js.includes("+14192454655")) fail("site", "main.js lost the +14192454655 phone number");
if (!js.includes("crystal@crystalsellstoledo.com"))
  fail("site", "main.js lost the crystal@crystalsellstoledo.com address");

/* --- server endpoint -------------------------------------------------- */
const API = join(ROOT, "..", "api");
if (!existsSync(join(API, "lead.js"))) fail("site", "api/lead.js is missing");
else {
  const api = readFileSync(join(API, "lead.js"), "utf8");
  if (!/req\.method\s*!==\s*"POST"/.test(api)) fail("api/lead.js", "does not restrict method to POST");
}

/* No secret may ever appear in anything that ships to the browser. */
const SECRET_NAMES = [
  "HUBSPOT_ACCESS_TOKEN",
  /* Zoho Mail SMTP. The mailbox password above all, but the host, port and
     user have no business in browser code either - the acknowledgement is
     sent entirely inside the Vercel function. */
  "ZOHO_SMTP_PASSWORD", "ZOHO_SMTP_USER", "ZOHO_SMTP_HOST", "ZOHO_SMTP_PORT",
  "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_CLIENT_ID",
  /* The append-only consent ledger's connection string. A database
     credential, and one for the store that exists to be trustworthy. */
  "CONSENT_LEDGER_URL",
  /* The Twilio auth token. It is the ONLY thing standing between the
     suppression endpoint and anyone who can guess its URL: the inbound
     webhook's signature is computed with it, so a leak makes forged
     opt-outs — and forged opt-in requests — indistinguishable from real
     ones. */
  "TWILIO_AUTH_TOKEN",
  /* The OUTBOUND credential pair. Separate from the auth token on
     purpose - see api/_lib/sms-sender.mjs - and the secret half is a
     standing authority to send messages on this account's behalf. */
  "TWILIO_API_KEY_SECRET", "TWILIO_API_KEY_SID",
  /* The operator action's sealing key. Whoever holds it can mint a link
     that records a permanent, un-undoable opt-out against any number they
     can name — so it must never appear in anything a browser receives. */
  "OPERATOR_ACTION_SECRET",
];
for (const file of [...pages.map((p) => p), "assets/js/main.js", "assets/css/styles.css"]) {
  const text = readFileSync(join(ROOT, file), "utf8");
  for (const name of SECRET_NAMES)
    if (text.includes(name)) fail(file, `references server secret ${name} in client-delivered output`);
  if (/Zoho-oauthtoken/i.test(text)) fail(file, "contains a Zoho OAuth token header in client output");
  if (/api\.hubapi\.com/i.test(text)) fail(file, "calls the HubSpot API directly from client output");
  if (/\bpat-na\d/i.test(text)) fail(file, "contains what looks like a HubSpot private app token");
}

/* --- homepage hero CRO contract --------------------------------------- */
{
  const home = readFileSync(join(ROOT, "index.html"), "utf8");
  const H1 = "What could your Perrysburg home sell for?";

  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(home);
  if (!h1) fail("index.html", "no h1");
  else if (h1[1].replace(/<[^>]+>/g, "").trim() !== H1)
    fail("index.html", `hero h1 is not the control copy: "${h1[1].replace(/<[^>]+>/g, "").trim()}"`);

  /* The hero must carry the real form, not a link to it. */
  if (!/<form[^>]*data-form-type="home_value"/.test(home))
    fail("index.html", "hero has no home_value form");
  if (!/name="property_address"[^>]*required/.test(home) &&
      !/required[^>]*name="property_address"/.test(home))
    fail("index.html", "hero address field is not required");
  if (!/name="property_address"[^>]*maxlength="200"/.test(home))
    fail("index.html", "hero address field lost maxlength=200");

  /* One form per page: a second would mean a duplicated contract. */
  const formCount = (home.match(/<form\s/g) || []).length;
  if (formCount !== 1) fail("index.html", `expected exactly 1 form, found ${formCount}`);

  /* The form must sit inside the hero. A build-time include expanded inside
     an HTML comment once terminated the comment early and hoisted the form
     out of the hero entirely - this catches that class of bug. */
  const hero = /<section class="hero hero--capture">([\s\S]*?)<\/section>/.exec(home);
  if (!hero) fail("index.html", "hero--capture section missing");
  else if (!/<form\s/.test(hero[1])) fail("index.html", "the form is not inside the hero section");
  if (/<form\s/.test(home.slice(0, home.indexOf('<section class="hero'))))
    fail("index.html", "a form appears before the hero - markup was hoisted");

  /* Secondary action is subordinate and points at /sell. */
  if (!/class="hero__secondary"[\s\S]{0,200}href="\/sell"/.test(home))
    fail("index.html", "secondary selling-process link missing or not pointing at /sell");
  if (/hero__secondary[\s\S]{0,200}class="btn/.test(home))
    fail("index.html", "secondary action is styled as a button - it must stay subordinate");

  /* Required microcopy, and no unverifiable proof claims. */
  if (!/No obligation[\s\S]{0,20}Human valuation[\s\S]{0,20}Not an automated estimate/.test(home))
    fail("index.html", "hero microcopy missing");

  /* Proof claims are banned in the HERO specifically, and the scan runs on
     the hero's visible text so a hex colour or an href cannot trip it. */
  const heroText = hero ? hero[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") : "";
  const BANNED = [
    /\B#1\b/, /\btop agent\b/i, /\bbest realtor\b/i, /\bleading\b/i,
    /\baward[- ]winning\b/i, /\b5[- ]star\b/i, /\bgoogle rating\b/i,
    /\bspecialist\b/i, /\bexpert\b/i, /\bguarantee\b/i, /\binstant valuation\b/i,
  ];
  for (const re of BANNED)
    if (re.test(heroText)) fail("index.html", `unsupported claim in hero text: ${re}`);

  /* No development placeholder may reach the production hero. */
  if (/placeholder-hero|HERO IMAGE/i.test(home))
    fail("index.html", "development hero placeholder is visible in production output");
}

/* --- the home_value form has exactly one source ----------------------- */
{
  const SRC = join(ROOT, "..", "src");
  const partial = join(SRC, "partials/home-value-form.html");
  if (!existsSync(partial)) fail("site", "shared home-value-form partial is missing");
  for (const page of ["index.html", "home-value.html"]) {
    const src = readFileSync(join(SRC, "pages", page), "utf8");
    if (!/\{\{>\s*home-value-form\s*\}\}/.test(src))
      fail(`src/pages/${page}`, "does not consume the shared home-value-form partial");
    if (/<form\s/.test(src))
      fail(`src/pages/${page}`, "contains an inline form - the partial is the only source");
  }
  /* The success state ships in the shared partial so the two pages cannot
     diverge, and must not be inlined into either page. */
  const partialSrc = readFileSync(partial, "utf8");
  if (!/data-form-success/.test(partialSrc))
    fail("src/partials/home-value-form.html", "no success panel — a submission has no confirmation");
  if (!/data-form-region/.test(partialSrc))
    fail("src/partials/home-value-form.html", "no form region wrapper for the success swap");
  if (!/data-success-heading[^>]*tabindex="-1"|tabindex="-1"[^>]*data-success-heading/.test(partialSrc))
    fail("src/partials/home-value-form.html", "the success heading cannot receive focus");
  for (const page of ["index.html", "home-value.html"]) {
    const src = readFileSync(join(SRC, "pages", page), "utf8");
    if (/data-form-success/.test(src))
      fail(`src/pages/${page}`, "inlines a success panel — the partial is the only source");
    const html = readFileSync(join(ROOT, page), "utf8");
    const n = (html.match(/data-form-success/g) || []).length;
    if (n !== 1) fail(page, `has ${n} success panels, expected exactly 1`);
    if (!/Your request is in/.test(html)) fail(page, "the success panel lost its confirmation heading");
    if (!/tel:\+14192454655/.test(html)) fail(page, "the success panel lost the phone fallback");
  }

  /* A visible label is required - placeholder-only UI is not accessible. */
  for (const page of ["index.html", "home-value.html"]) {
    const html = readFileSync(join(ROOT, page), "utf8");
    if (!/<label[^>]*for="v-address"[^>]*>\s*Property address/.test(html))
      fail(page, "the property address field has no visible label");
    if (!/name="property_address"[^>]*autocomplete="street-address"|autocomplete="street-address"[^>]*name="property_address"/.test(html))
      fail(page, "the property address field lost autocomplete=street-address");
  }

  /* Both rendered pages must expose an identical field contract. */
  const fields = (html) =>
    [...html.matchAll(/name="([a-z_]+)"/g)].map((m) => m[1]).filter((n) => n !== "_gotcha").sort().join(",");
  const a = fields(readFileSync(join(ROOT, "index.html"), "utf8"));
  const b2 = fields(readFileSync(join(ROOT, "home-value.html"), "utf8"));
  if (a !== b2) fail("site", `home_value field contract has drifted between / and /home-value:\n      / = ${a}\n      /home-value = ${b2}`);
}

/* --- live UX guards ---------------------------------------------------- */
{
  const css = readFileSync(join(ROOT, "assets/css/styles.css"), "utf8");
  const mainJs = readFileSync(join(ROOT, "assets/js/main.js"), "utf8");

  /* `h1, h2, h3, h4 { color: var(--ink) }` beats a colour inherited from the
     panel, so the confirmation heading must name its own or it renders
     near-black on the dark hero. */
  if (!/\.success-panel__title\s*\{[^}]*\bcolor\s*:/.test(css))
    fail("assets/css/styles.css", "the success heading has no explicit colour");
  if (!/\.hero \.success-panel__title\s*\{[^}]*color\s*:\s*#fff/i.test(css))
    fail("assets/css/styles.css", "the success heading is not light on the dark hero");

  /* Choosing a suggestion must be terminal: the announcement we dispatch must
     not re-enter our own listener, and a late response must not render. */
  if (!/programmatic/.test(mainJs))
    fail("assets/js/main.js",
      "the post-selection input event is not distinguished from typing — the menu will reopen");
  if (!/chosenValue/.test(mainJs))
    fail("assets/js/main.js", "nothing remembers the chosen address, so a lookup can reopen the menu");
  if (!/clearTimeout\(timer\);\s*\n\s*\/\* Any response still in flight/.test(mainJs))
    fail("assets/js/main.js", "selection does not cancel the pending debounce");
  if (!/seq\+\+;/.test(mainJs))
    fail("assets/js/main.js", "selection does not invalidate in-flight requests");

  /* Presentation only — the server stays authoritative. */
  if (!/function phoneDigits/.test(mainJs) || !/function phoneFormat/.test(mainJs))
    fail("assets/js/main.js", "no US phone formatter");
  if (!/d\.length === 11 && d\.charAt\(0\) === "1"/.test(mainJs))
    fail("assets/js/main.js", "a leading US country code is not normalised away");
  if (!/d\.slice\(0, 10\)/.test(mainJs))
    fail("assets/js/main.js", "the phone formatter does not cap at ten digits");
}

/* --- Google Analytics 4 ------------------------------------------------ */
{
  const buildSrc = readFileSync(join(ROOT, "..", "tools/build.mjs"), "utf8");

  /* The measurement ID is public, but WHERE it runs is not incidental:
     preview deploys and local builds must not pollute the numbers. */
  if (!/VERCEL_ENV === "production"/.test(buildSrc))
    fail("tools/build.mjs", "the analytics tag is not limited to production builds");
  if (!/\^G-\[A-Z0-9\]/.test(buildSrc))
    fail("tools/build.mjs", "the GA4 measurement ID is not validated before being emitted");

  for (const file of pages) {
    const html = readFileSync(join(ROOT, file), "utf8");
    const tags = (html.match(/googletagmanager\.com\/gtag\/js/g) || []).length;
    /* Google is explicit: never more than one Google tag on a page. */
    if (tags > 1) fail(file, `has ${tags} Google tags — a page must carry at most one`);
    if (tags === 1) {
      if (!/<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-/.test(html))
        fail(file, "the Google tag is not the documented async gtag.js snippet");
      if (!/gtag\('config', 'G-/.test(html))
        fail(file, "the Google tag loads but never configures a measurement ID");
      /* A blocking tag in the head would cost the LCP the hero pass bought. */
      if (/<script src="https:\/\/www\.googletagmanager\.com/.test(html))
        fail(file, "the Google tag is render-blocking — it must be async");
    }
  }

  /* Analytics must never become the reason an event exists. The site's own
     event layer stays vendor-neutral and simply forwards when gtag is there. */
  const mainJs = readFileSync(join(ROOT, "assets/js/main.js"), "utf8");
  if (/googletagmanager|G-[A-Z0-9]{6,12}/.test(mainJs))
    fail("assets/js/main.js", "hardcodes an analytics vendor — the build injects the tag");
  if (!/typeof window\.gtag === "function"/.test(mainJs))
    fail("assets/js/main.js", "no longer forwards events to gtag when present");
}

/* --- Google Places address autocomplete -------------------------------- */
{
  const mainJs = readFileSync(join(ROOT, "assets/js/main.js"), "utf8");
  const buildSrc = readFileSync(join(ROOT, "..", "tools/build.mjs"), "utf8");

  /* The Maps key is a browser key, but it still must not be committed. It is
     injected at build time from GOOGLE_MAPS_API_KEY, so it can be rotated by
     redeploying and a fork simply gets no autocomplete. */
  for (const file of ["assets/js/main.js", "assets/css/styles.css"]) {
    const text = readFileSync(join(ROOT, file), "utf8");
    if (/AIza[0-9A-Za-z_-]{10,}/.test(text)) fail(file, "contains a hardcoded Google API key");
    if (/maps\.googleapis\.com/.test(text))
      fail(file, "loads the Maps API directly — it must be injected by the build");
  }
  if (!/GOOGLE_MAPS_API_KEY/.test(buildSrc))
    fail("tools/build.mjs", "no GOOGLE_MAPS_API_KEY gate for the Maps loader");
  if (!/\/\^\[[^/]*\]\{\d+,\d+\}\$\/\.test\(\s*MAPS_KEY\s*\)/.test(buildSrc))
    fail("tools/build.mjs",
      "the Maps key is not pattern-validated before being written into a script tag");
  if (!/MAPS_KEY_OK\s*\n?\s*\?/.test(buildSrc))
    fail("tools/build.mjs", "the Maps loader is emitted unconditionally — it must be key-gated");

  /* Autocomplete is an enhancement. Without a key nothing is emitted and the
     address field must still be an ordinary, submittable text input. */
  if (!/__csvMapsReady\b/.test(mainJs))
    fail("assets/js/main.js", "address autocomplete is not gated on the Maps loader");
  if (!existsSync(join(ROOT, "index.html"))) fail("site", "index.html missing");
  else {
    const home = readFileSync(join(ROOT, "index.html"), "utf8");
    const hasLoader = /maps\.googleapis\.com/.test(home);
    if (hasLoader && !/loading=async/.test(home))
      fail("index.html", "the Maps loader must use loading=async");
    if (hasLoader && !/callback=csvMapsReady/.test(home))
      fail("index.html", "the Maps loader has no ready callback");
    if (!hasLoader && /__csvMapsReady\b/.test(home))
      fail("index.html", "declares a Maps ready promise with no loader to resolve it");
  }

  /* The deprecated widget is unavailable to any key created after March 2025,
     and it would replace our real input with its own shadow-DOM one. */
  if (/places\.Autocomplete\s*\(|new\s+google\.maps\.places\.Autocomplete/.test(mainJs))
    fail("assets/js/main.js",
      "uses the deprecated Places Autocomplete widget — use the Autocomplete Data API");

  /* Suggestions are BIASED toward Perrysburg, never RESTRICTED to it.
     A restriction would drop legitimate addresses just outside the box and
     would make the site look like it refuses other areas. */
  if (/locationRestriction/.test(mainJs))
    fail("assets/js/main.js",
      "restricts address suggestions to an area — bias them instead, never restrict");
  if (!/locationBias/.test(mainJs))
    fail("assets/js/main.js", "no location bias — local addresses will not rank first");
  /* Inspect the DECLARATION, not the file: the comment that explains why
     subpremise is absent would otherwise trip the guard enforcing its absence. */
  const types = /var ADDRESS_TYPES = \[([^\]]*)\]/.exec(mainJs);
  if (!types) fail("assets/js/main.js", "no ADDRESS_TYPES declared for the address lookup");
  else {
    const values = (types[1].match(/"([^"]+)"/g) || []).map((v) => v.slice(1, -1));
    /* Places Autocomplete does not support subpremise; including it makes
       Google reject the ENTIRE request, which silently costs the bias too. */
    if (values.includes("subpremise"))
      fail("assets/js/main.js",
        "requests the subpremise type — Places Autocomplete rejects the whole request over it");
    if (values.length > 5)
      fail("assets/js/main.js",
        `requests ${values.length} primary types — Places allows at most five`);
    if (!values.length)
      fail("assets/js/main.js", "ADDRESS_TYPES is empty");
  }

  /* The real input must remain the source of truth. */
  if (!/input\[name="property_address"\]/.test(mainJs))
    fail("assets/js/main.js", "autocomplete is not bound to the real property_address input");
  if (!/maxlength/.test(mainJs))
    fail("assets/js/main.js", "a chosen suggestion is not capped to the field's maxlength");
}

/* --- HubSpot delivery conformance -------------------------------------- */
const hubspotSrc = existsSync(join(API, "_lib/hubspot.mjs"))
  ? readFileSync(join(API, "_lib/hubspot.mjs"), "utf8") : "";
if (!hubspotSrc) fail("site", "api/_lib/hubspot.mjs is missing");
else {
  const leadSrc = readFileSync(join(API, "lead.js"), "utf8");

  /* The live delivery path must actually be HubSpot. Importing both would
     make it ambiguous which CRM a lead reaches. */
  if (!/from\s+"\.\/_lib\/hubspot\.mjs"/.test(leadSrc))
    fail("api/lead.js", "does not import the HubSpot client");
  if (/from\s+"\.\/_lib\/zoho\.mjs"/.test(leadSrc))
    fail("api/lead.js", "still imports the Zoho client — the runtime path must be HubSpot only");

  /* Least privilege: the token is the only credential this phase may need. */
  if (/ZOHO_/.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs", "references a Zoho variable");
  const cfg = /export function isConfigured\(\)[\s\S]*?\n}/.exec(hubspotSrc);
  if (!cfg) fail("api/_lib/hubspot.mjs", "no isConfigured()");
  else {
    if (!/HUBSPOT_ACCESS_TOKEN/.test(cfg[0]))
      fail("api/_lib/hubspot.mjs", "isConfigured does not require HUBSPOT_ACCESS_TOKEN");
    /* All three are required: the form submission is a mandatory half of
       delivery, so a missing portal id or form guid must refuse up front
       rather than accept a lead it cannot record on the timeline. */
    for (const needed of ["portalId()", "formGuid()"])
      if (!cfg[0].includes(needed))
        fail("api/_lib/hubspot.mjs", `isConfigured does not require ${needed}`);
  }

  /* The enquiry block goes to a STANDARD HubSpot property. A custom property
     would need a scope this integration deliberately does not have. */
  const prop = /export const DETAIL_PROPERTY = "([^"]+)"/.exec(hubspotSrc);
  if (!prop) fail("api/_lib/hubspot.mjs", "DETAIL_PROPERTY is not declared");
  else if (prop[1] !== "message")
    fail("api/_lib/hubspot.mjs",
      `DETAIL_PROPERTY is "${prop[1]}" — only the standard writable property "message" is confirmed`);

  /* Scope budget: no Notes API, no properties/schema API. Engagement objects
     are not offered to a Service Key at all. */
  if (/\/crm\/v3\/objects\/notes|\/engagements\//.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs", "uses the Notes/engagements API — a Service Key has no notes scope");
  if (/\/crm\/v3\/properties\//.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs", "uses the properties API — this token has no schema scope");

  /* Every submission must become a dated timeline activity, via the form. */
  if (!/\/submissions\/v3\/integration\/secure\/submit\//.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs",
      "does not submit to the authenticated HubSpot form endpoint — enquiries would leave no activity");
  if (/integration\/submit\//.test(hubspotSrc) &&
      !/integration\/secure\/submit\//.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs", "uses the UNauthenticated form endpoint");
  if (!/await submitForm\(payload\)/.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs", "the form submission is not awaited in the delivery path");
  if (/submitForm\(payload\)\s*\.catch|catch[^)]*\{\s*\}\s*\/\* best.effort/i.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs", "the form submission is treated as best-effort");

  /* HubSpot validates a submission against the form definition and rejects
     anything carrying a field the form does not define. */
  const ff = /export const FORM_FIELDS = \[([^\]]*)\]/.exec(hubspotSrc);
  if (!ff) fail("api/_lib/hubspot.mjs", "FORM_FIELDS is not declared");
  else {
    const values = (ff[1].match(/"([^"]+)"/g) || []).map((v) => v.slice(1, -1));
    const expected = ["email", "firstname", "lastname", "phone", "address", "message"];
    if (values.join(",") !== expected.join(","))
      fail("api/_lib/hubspot.mjs",
        `FORM_FIELDS is [${values}] — the HubSpot form defines exactly [${expected}]`);
  }
  /* email is the dedupe key and HubSpot requires it on this form: it must be
     seeded into the array, never pushed behind a condition. */
  if (!/const fields = \[field\("email", lead\.email\)\]/.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs", "email is not unconditionally submitted");
  if (/if \([^)]*\) fields\.push\(field\("email"/.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs", "email is submitted conditionally");
  for (const [f, prop] of [["phone", "lead.phone"], ["address", "lead.property_address"]])
    if (!new RegExp(`if \\(${prop.replace(".", "\\.")}\\) fields\\.push\\(field\\("${f}"`).test(hubspotSrc))
      fail("api/_lib/hubspot.mjs",
        `${f} is submitted unconditionally — a blank would erase the stored value`);
  if (!/submittedAt:/.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs", "no submittedAt — the activity would be dated on ingest");

  /* Dedupe must exist, or repeat submissions pile up duplicate contacts. */
  if (!/\/crm\/v3\/objects\/contacts\/search/.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs", "no email lookup — repeat submissions would duplicate contacts");
  if (!/409/.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs", "no 409 conflict handling — a search-index lag would duplicate or fail");

  /* The seller's address must reach HubSpot's standard visible field, and
     must never be sent blank (that would erase what HubSpot already holds). */
  if (!/props\.address = lead\.property_address/.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs", "property_address is not mapped to the standard `address` field");
  if (!/if \(lead\.property_address\) props\.address/.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs",
      "address is sent unconditionally — a blank would erase the stored address");
  if (!/if \(lead\.phone\) props\.phone/.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs",
      "phone is sent unconditionally — a blank would erase the stored phone");

  /* The enquiry detail must never be quietly dropped to make a write succeed. */
  if (!/detailPropertyRejected/.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs", "no detection of a rejected detail property");
  if (/withoutDetail|delete\s+\w*\[DETAIL_PROPERTY\]|retryWithoutMessage/.test(hubspotSrc))
    fail("api/_lib/hubspot.mjs", "retries without the enquiry detail — that would silently discard the lead body");
}

/* --- Zoho Lead schema conformance ------------------------------------- */
const zohoSrc = existsSync(join(API, "_lib/zoho.mjs"))
  ? readFileSync(join(API, "_lib/zoho.mjs"), "utf8") : "";
if (!zohoSrc) fail("site", "api/_lib/zoho.mjs is missing");
else {
  /* Company is mandatory on a Zoho Lead; omitting it fails every create. */
  if (!/Company:/.test(zohoSrc)) fail("api/_lib/zoho.mjs", "Lead record has no mandatory Company field");
  for (const form of ["home_value", "contact"])
    if (!new RegExp(form + ":").test(zohoSrc))
      fail("api/_lib/zoho.mjs", `no Company mapping for form type ${form}`);
  /* Picklist values must come from configuration, never a hardcoded guess. */
  if (/Lead_Status:\s*"/.test(zohoSrc))
    fail("api/_lib/zoho.mjs", "Lead_Status is hardcoded — it is a picklist and must be configured or omitted");
  if (!/withoutPicklists/.test(zohoSrc))
    fail("api/_lib/zoho.mjs", "no picklist-free retry — an unconfirmed picklist value could lose a lead");
}

/* Client maxlength must not drift from the server limits. */
const limitsSrc = existsSync(join(API, "_lib/validate.mjs"))
  ? readFileSync(join(API, "_lib/validate.mjs"), "utf8") : "";
const ZOHO_MAX = { first_name: 40, last_name: 80, email: 100, phone: 30 };
for (const [field, max] of Object.entries(ZOHO_MAX)) {
  const m = new RegExp(field + ":\\s*(\\d+)").exec(limitsSrc);
  if (!m) fail("api/_lib/validate.mjs", `no limit declared for ${field}`);
  else if (Number(m[1]) > max)
    fail("api/_lib/validate.mjs", `${field} limit ${m[1]} exceeds the agreed maximum ${max}`);
}
for (const file of pages.filter((f) => ["contact.html", "home-value.html"].includes(f))) {
  const html = readFileSync(join(ROOT, file), "utf8");
  for (const [field, max] of Object.entries(ZOHO_MAX)) {
    const tag = new RegExp(`<input[^>]*name="${field}"[^>]*>`).exec(html);
    if (!tag) continue;
    const ml = /maxlength="(\d+)"/.exec(tag[0]);
    if (!ml) fail(file, `${field} input has no maxlength`);
    else if (Number(ml[1]) !== max) fail(file, `${field} maxlength ${ml[1]} disagrees with the server limit ${max}`);
  }
}

/* --- asset cache busting ---------------------------------------------- */
for (const file of pages) {
  const html = readFileSync(join(ROOT, file), "utf8");
  if (!/main\.js\?v=[a-f0-9]{6,}/.test(html))
    fail(file, "main.js is not fingerprinted — immutable caching would pin old form code");
}

/* --- Phase 3 integrity guards ------------------------------------------
   Narrow, structural checks for four regressions that are silent: nothing
   breaks, the site still builds, and the repository simply starts lying
   about what it does. They assert facts and shapes, not prose - a rewrite
   that keeps the facts keeps passing. */
{
  const REPO = join(ROOT, "..");

  /* 1. .env.example must document the live HubSpot path, and must not
        present Zoho as the path to configure. Zoho is retained rollback
        code that nothing imports; a fresh operator following an
        active-Zoho .env.example would configure the wrong CRM and get a
        503 with no clue why. Checked by ORDER rather than by wording:
        every Zoho variable must sit below a heading that marks the
        section as rollback-only. */
  const envPath = join(REPO, ".env.example");
  if (!existsSync(envPath)) fail(".env.example", "missing - the live configuration is undocumented");
  else {
    const env = readFileSync(envPath, "utf8");
    for (const v of ["HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PORTAL_ID", "HUBSPOT_FORM_GUID"])
      if (!new RegExp(`^${v}=`, "m").test(env))
        fail(".env.example", `does not document the required live variable ${v}`);
    for (const v of ["HUBSPOT_API_BASE", "HUBSPOT_FORMS_BASE", "GOOGLE_MAPS_API_KEY",
                     "GA4_MEASUREMENT_ID", "ALLOWED_ORIGINS"])
      if (!new RegExp(`^${v}=`, "m").test(env))
        fail(".env.example", `does not document the optional variable ${v}`);

    /* Zoho Mail SMTP is a LIVE path that happens to share the vendor name
       with the dormant CRM client. It is documented in its own section and
       is deliberately exempt from the rollback ordering rule below - which
       is about Zoho CRM never reading as the live lead destination, and has
       nothing to say about a mailbox. Both halves are asserted so the two
       can never be merged back into one confusing block. */
    for (const v of ["ZOHO_SMTP_HOST", "ZOHO_SMTP_PORT", "ZOHO_SMTP_USER", "ZOHO_SMTP_PASSWORD"])
      if (!new RegExp(`^${v}=`, "m").test(env))
        fail(".env.example", `does not document the Zoho Mail variable ${v}`);
    if (/^ZOHO_SMTP_PASSWORD=.+/m.test(env))
      fail(".env.example", "ZOHO_SMTP_PASSWORD carries a value - it must be documented empty");

    const rollbackAt = env.search(/ROLLBACK ONLY/i);
    const smtpAt = env.search(/^ZOHO_SMTP_/m);
    if (smtpAt !== -1 && rollbackAt !== -1 && smtpAt > rollbackAt)
      fail(".env.example",
        "the Zoho Mail SMTP variables sit below the ROLLBACK ONLY heading - they are the live acknowledgement path, not rollback");

    /* Zoho CRM variables only: ZOHO_SMTP_* is excluded by the lookahead. */
    const firstCrmZohoAt = env.search(/^ZOHO_(?!SMTP_)/m);
    if (firstCrmZohoAt !== -1) {
      if (rollbackAt === -1)
        fail(".env.example", "documents Zoho CRM variables with no ROLLBACK ONLY heading - reads as the live path");
      else if (firstCrmZohoAt < rollbackAt)
        fail(".env.example", "a Zoho CRM variable appears above the ROLLBACK ONLY heading - reads as the live path");
    }
  }

  /* 2. The lead endpoint must not accept every hostname on a shared
        preview domain. vercel.app is shared: anyone can hold a hostname on
        it in seconds, so a suffix match let any Vercel project on earth
        drive a browser into posting here. The deployment's own host comes
        from VERCEL_URL and VERCEL_BRANCH_URL instead. */
  const secPath = join(REPO, "api/_lib/security.mjs");
  if (!existsSync(secPath)) fail("api/_lib/security.mjs", "missing");
  else {
    const sec = readFileSync(secPath, "utf8");
    if (/endsWith\(\s*["'`]\.vercel\.app/.test(sec))
      fail("api/_lib/security.mjs", "accepts any *.vercel.app origin by suffix - vercel.app is a shared domain");
    for (const v of ["VERCEL_URL", "VERCEL_BRANCH_URL"])
      if (!new RegExp(v).test(sec))
        fail("api/_lib/security.mjs", `does not consult ${v} - preview deploys cannot submit at all`);
    for (const host of ["crystalsellstoledo.com", "localhost"])
      if (!sec.includes(host))
        fail("api/_lib/security.mjs", `lost ${host} from the origin allow-list`);
  }

  /* 3. /privacy must describe the runtime that actually ships. The page
        once named Vercel Analytics as the only analytics, said the site
        set no analytics cookies, and said nothing was collected unless a
        form was submitted - all three untrue while GA4, Google Fonts and
        Google Places are in the build. Positive facts are asserted (a
        rewrite keeping them keeps passing); the two negatives target the
        exact retired claims. */
  const privacy = existsSync(join(ROOT, "privacy.html"))
    ? readFileSync(join(ROOT, "privacy.html"), "utf8") : null;
  const buildSrc = existsSync(join(REPO, "tools/build.mjs"))
    ? readFileSync(join(REPO, "tools/build.mjs"), "utf8") : "";
  const shellSrc = existsSync(join(REPO, "src/partials/_shell.html"))
    ? readFileSync(join(REPO, "src/partials/_shell.html"), "utf8") : "";

  if (!privacy) fail("site", "privacy.html is missing");
  else {
    /* Only what a visitor actually reads counts: an HTML comment explaining
       what the page used to claim must not satisfy - or trip - these. */
    const text = privacy.replace(/<!--[\s\S]*?-->/g, "");
    const ships = [
      [/googletagmanager\.com\/gtag/.test(buildSrc), "Google Analytics", "GA4 ships on production builds"],
      [/fonts\.googleapis\.com/.test(shellSrc), "Google Fonts", "the shell loads Google Fonts"],
      [/maps\.googleapis\.com/.test(buildSrc), "Google Places", "the build can emit the Maps/Places loader"],
      [/_vercel\/insights/.test(shellSrc), "Vercel", "the shell loads Vercel Web Analytics"],
      [true, "HubSpot", "leads are delivered to HubSpot"],
    ];
    for (const [inBuild, name, why] of ships)
      if (inBuild && !text.includes(name))
        fail("privacy.html", `does not mention ${name}, but ${why}`);

    if (/googletagmanager\.com\/gtag/.test(buildSrc) && !/_ga\b/.test(text))
      fail("privacy.html", "does not disclose the Google Analytics cookies (_ga) that GA4 sets");

    const retired = [
      [/sets? no[^.]{0,60}cookies/i, "claims the site sets no cookies"],
      [/collected about you unless/i, "claims nothing is collected unless a form is submitted"],
    ];
    for (const [re, what] of retired)
      if (re.test(text)) fail("privacy.html", `${what} - untrue while GA4 and Google Fonts ship`);

    if (!/(January|February|March|April|May|June|July|August|September|October|November|December)&nbsp;?\s*\d{1,2},&nbsp;?\s*\d{4}/.test(text))
      fail("privacy.html", "carries no exact effective/last-updated date");
  }
}

/* ---------------------------------------------------------------------
   COMMUNICATIONS CONSENT
   ---------------------------------------------------------------------
   Only the invariants worth a build failure. Everything here is something
   that breaks nothing, renders fine, and quietly turns a lawful consent
   record into an unlawful one.
   --------------------------------------------------------------------- */
{
  /* Displayed words must equal recorded words. Throws with its own
     message; this is the same assertion the build runs. */
  assertConsentCopyIntact();

  const FORM_PAGES = ["index.html", "home-value.html", "43551-seller-review.html", "contact.html"];
  const CONSENT_BOXES = ["sms_consent", "ai_voice_consent"];
  const boxOf = (html, name) =>
    new RegExp('<input\\b[^>]*\\bname="' + name + '"[^>]*>', "s").exec(html)?.[0] || null;

  for (const file of FORM_PAGES) {
    if (!existsSync(join(ROOT, file))) continue;
    const html = readFileSync(join(ROOT, file), "utf8");

    if (!CONSENT_ON) {
      /* Gate off means gate off: no checkbox, no disclosure, nowhere. A
         visitor must never be shown a consent promise the backend is not
         configured to preserve. */
      for (const name of CONSENT_BOXES)
        if (boxOf(html, name))
          fail(file, `renders the ${name} checkbox while COMMUNICATIONS_CONSENT_ENABLED is off - consent would be collected and not persisted`);
      if (html.includes(SMS_CONSENT.version) || html.includes(AI_VOICE_CONSENT.version))
        fail(file, "carries a consent disclosure while the feature is off");
      continue;
    }

    for (const name of CONSENT_BOXES) {
      const tag = boxOf(html, name);
      if (!tag) { fail(file, `the ${name} checkbox is missing while the feature is on`); continue; }
      /* A pre-ticked box is not consent, and a mandatory one contradicts
         the disclosure's own promise that consent is not a condition of
         service. Both are the classic way a consent UI goes bad. */
      if (/\bchecked\b/.test(tag)) fail(file, `${name} is pre-checked - a pre-ticked box is not consent`);
      if (/\brequired\b/.test(tag)) fail(file, `${name} is required - the disclosure promises consent is not a condition of service`);
      if (!/type="checkbox"/.test(tag)) fail(file, `${name} is not a checkbox`);
    }

    /* Exactly one of each. Five copies of the fieldset shipped once,
       because a partial named its own template token in a comment and
       re-inserted itself on every render pass. */
    for (const name of CONSENT_BOXES) {
      const count = (html.match(new RegExp('name="' + name + '"', "g")) || []).length;
      if (count !== 1) fail(file, `renders ${count} ${name} inputs - expected exactly 1`);
    }

    /* The exact words, and both links, on the page itself. */
    for (const d of [SMS_CONSENT, AI_VOICE_CONSENT]) {
      const flat = html.replace(/\s+/g, " ");
      if (!flat.includes(d.html.replace(/\s+/g, " ")))
        fail(file, `the rendered ${d.channel} disclosure does not match the canonical text in api/_lib/consent.mjs`);
    }
    for (const href of ["/privacy", "/communications-terms"])
      if (!html.includes(`href="${href}"`))
        fail(file, `the consent disclosure links to ${href}, but the page has no such link`);
  }

  /* The legal routes exist exactly when the feature does. */
  const termsBuilt = existsSync(join(ROOT, "communications-terms.html"));
  if (CONSENT_ON && !termsBuilt)
    fail("site", "/communications-terms is not built, but the consent disclosures link to it");
  if (!CONSENT_ON && termsBuilt)
    fail("site", "/communications-terms is built while the feature is off - it describes a programme that is not running");
  if (CONSENT_ON) {
    const terms = readFileSync(join(ROOT, "communications-terms.html"), "utf8");
    for (const required of ["STOP", "HELP", "Message frequency varies",
                            "Message and data rates may apply",
                            "not a condition of service", "/privacy"])
      if (!terms.includes(required))
        fail("communications-terms.html", `is missing the required disclosure "${required}"`);
    const privacy = readFileSync(join(ROOT, "privacy.html"), "utf8");
    for (const required of ["Twilio", "Retell",
                            "will not be shared with third parties"])
      if (!privacy.includes(required))
        fail("privacy.html", `does not disclose ${required}, but messaging is enabled`);

    /* The broad website policy legitimately describes transaction-related
       sharing with a title company, lender or inspector. An A2P reviewer
       reading that sentence must not be left to guess whether it reaches
       mobile and SMS opt-in data. The scope statement is what stops
       error 30882 turning on ordinary real-estate prose.

       Read from the page BODY, with comments stripped. A source comment
       explaining a rule is not the rule being kept, and this repository
       has already shipped four content checks that matched their own
       commentary. */
    const privacyBody = privacy.replace(/<!--[\s\S]*?-->/g, "");
    const privacyText = privacyBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    if (!privacyText.includes("SMS opt-in and your SMS consent are never transferred"))
      fail("privacy.html", "does not say the SMS opt-in and consent are not transferred by transaction-related sharing");
    if (!privacyText.includes("not sold, and is not shared with third parties or affiliates for their own marketing"))
      fail("privacy.html", "does not carry the mobile-information no-sale / no-marketing-sharing statement");
    if (!privacyBody.includes('href="/sms-privacy"'))
      fail("privacy.html", "does not point at the SMS Privacy Policy that actually governs SMS data");
    if (!privacyText.includes("title company, lender or inspector"))
      fail("privacy.html", "lost the transaction-sharing disclosure - the SMS clarification narrows it, it does not replace it");
    /* The overclaim this wording was corrected AWAY from. A title company
       completing a transaction the consumer asked for may legitimately
       receive their phone number; promising otherwise is a false promise
       that happens to read well to a carrier reviewer. */
    if (/does not include mobile information/.test(privacyText))
      fail("privacy.html", "claims transaction sharing excludes mobile information outright - it does not, and only the SMS opt-in and consent are withheld");

    /* Step 1 of the two-step valuation form carries no SMS consent - the
       checkbox is on step 2 - so its privacy link must not read as the
       messaging campaign's policy to a crawler that never advances the
       form. The destination stays /privacy; only the label is pinned.
       Pages are DISCOVERED, not listed: /43551-seller-review renders the
       shared partial too, and a hand-written pair of filenames silently
       exempted it. */
    const stepOnePages = FORM_PAGES.filter((f) =>
      existsSync(join(ROOT, f)) && readFileSync(join(ROOT, f), "utf8").includes("hv-form__privacy"));
    if (!stepOnePages.length)
      fail("site", "no page renders the step-1 privacy note - the shared valuation form is gone or was renamed");
    for (const file of stepOnePages) {
      const html = readFileSync(join(ROOT, file), "utf8");
      const stepOneLink = /<p class="form__note hv-form__privacy">([\s\S]*?)<\/p>/.exec(html)?.[1];
      if (!stepOneLink) { fail(file, "step 1 has no privacy link at all"); continue; }
      if (!stepOneLink.includes("Website Privacy Policy"))
        fail(file, 'step 1\'s privacy link is not labelled "Website Privacy Policy" - an unqualified label reads as the SMS campaign policy');
      if (!stepOneLink.includes('href="/privacy"'))
        fail(file, "step 1's privacy link no longer points at the website policy");
      if (/sms-privacy|sms-terms/.test(stepOneLink))
        fail(file, "step 1 links to an SMS policy, but step 1 collects no SMS consent");
    }

    /* -----------------------------------------------------------------
       /sms-consent-evidence - the static A2P verification surface.
       -----------------------------------------------------------------
       The real opt-in is on step 2 of a JavaScript two-step form, which a
       crawler may never reach. This page republishes the same disclosure
       as static text. Two failure modes are worth a build failure: it
       stops being evidence (the words drift from the canonical source),
       or it stops being INERT (it grows something submittable). */
    const evidenceRel = "sms-consent-evidence.html";
    const evidencePath = join(ROOT, evidenceRel);
    if (!existsSync(evidencePath)) {
      fail("site", "/sms-consent-evidence is not built, but it is the published A2P consent evidence surface");
    } else {
      const ev = readFileSync(evidencePath, "utf8");
      /* Scope to <main>. The shared shell's header carries a nav-toggle
         <button> and the sticky CTA sits after </main>; both are site
         chrome on every page and neither collects anything. What must be
         inert is the PAGE, so the guard reads the page's own region.
         Comments are stripped next, so a guard can never be satisfied -
         or tripped - by this page's own comment quoting a tag name. */
      const evMain = /<main[^>]*>([\s\S]*?)<\/main>/.exec(ev)?.[1];
      const evBody = (evMain ?? "").replace(/<!--[\s\S]*?-->/g, "");
      const evFlat = evBody.replace(/\s+/g, " ");
      /* One clear failure rather than a cascade of derived ones: with no
         region to read, every check below would fail against "". */
      if (evMain === undefined) fail(evidenceRel, "has no <main> region to check");
      else {

      /* INERT. A page that can be submitted is a second opt-in surface
         with no server contract behind it, not evidence of consent. */
      if (/<form\b/i.test(evBody))
        fail(evidenceRel, "contains a <form> - the evidence page must not be submittable");
      if (/<input\b/i.test(evBody))
        fail(evidenceRel, "contains an <input> - the static representation must not be a real control");
      if (/<(button|textarea|select)\b/i.test(evBody))
        fail(evidenceRel, "contains a form control - the evidence page must collect nothing");
      if (/type="submit"/i.test(evBody))
        fail(evidenceRel, "contains a submit control");
      if (evBody.includes("/api/lead"))
        fail(evidenceRel, "references /api/lead - the evidence page must reach no endpoint");
      for (const name of CONSENT_BOXES)
        if (new RegExp('name="' + name + '"').test(evBody))
          fail(evidenceRel, `carries a ${name} control - evidence must never be able to record consent`);

      /* EVIDENCE. The disclosure must be the canonical one, byte for
         byte, read from the RENDERED BODY - comments are stripped first
         so a guard can never be satisfied by a comment quoting itself. */
      for (const d of [SMS_CONSENT, AI_VOICE_CONSENT])
        if (!evFlat.includes(d.html.replace(/\s+/g, " ")))
          fail(evidenceRel, `the reproduced ${d.channel} disclosure does not match the canonical text in api/_lib/consent.mjs`);

      /* The claims the page makes about the real control. */
      for (const required of ["Crystal Sells Toledo", "/home-value", "/sms-privacy", "/sms-terms",
                              "How may Crystal follow up?", "Optional",
                              "starts unchecked", "not required",
                              "does not collect consent"])
        if (!evFlat.includes(required))
          fail(evidenceRel, `is missing the required evidence statement "${required}"`);
      if (!/consent__box--static/.test(evBody))
        fail(evidenceRel, "draws no static checkbox representation");
      if (!/sms-consent-step2\.png/.test(evBody))
        fail(evidenceRel, "does not publish the opt-in screenshot");

      /* An indexable page. Twilio has to be able to fetch it. */
      if (/name="robots"[^>]*noindex/.test(ev))
        fail(evidenceRel, "is noindex - a reviewer's crawler must be able to read it");
      const sitemap = readFileSync(join(ROOT, "sitemap.xml"), "utf8");
      if (!sitemap.includes("https://crystalsellstoledo.com/sms-consent-evidence"))
        fail("sitemap.xml", "omits /sms-consent-evidence");
      }
    }
  } else {
    const privacy = readFileSync(join(ROOT, "privacy.html"), "utf8");
    for (const premature of ["Twilio", "Retell AI"])
      if (privacy.replace(/<!--[\s\S]*?-->/g, "").includes(premature))
        fail("privacy.html", `names ${premature} while messaging is off - the page must describe the runtime that ships`);
    /* Gate off means gate off here too: a page describing an SMS opt-in
       experience must not be published while there is no SMS programme. */
    if (existsSync(join(ROOT, "sms-consent-evidence.html")))
      fail("site", "/sms-consent-evidence is built while the feature is off - it documents a consent flow that does not render");
  }

  /* The server half. The browser sends two booleans; everything that gives
     them meaning is attached server-side, and consent is never required. */
  const validateSrc = readFileSync(join(ROOT, "..", "api/_lib/validate.mjs"), "utf8");
  if (!/parseConsentFlag/.test(validateSrc))
    fail("api/_lib/validate.mjs", "no longer parses consent through api/_lib/consent.mjs");
  if (/MISSING_(SMS|AI_VOICE)_CONSENT/.test(validateSrc))
    fail("api/_lib/validate.mjs", "rejects a lead for missing consent - consent is never a condition of service");

  const consentSrc = readFileSync(join(ROOT, "..", "api/_lib/consent.mjs"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  if (/\bip\b|remoteAddress|x-forwarded-for/i.test(consentSrc))
    fail("api/_lib/consent.mjs", "reads an IP address - consent evidence deliberately stores no IP");
  /* The HubSpot consent adapter owns every cst_ name. Scattering them back
     into hubspot.mjs is how a schema contract quietly drifts from the
     portal it describes - and how a suppression property gets written by
     something that had no business writing one. */
  const adapterPath = join(ROOT, "..", "api/_lib/hubspot-consent-state.mjs");
  if (!existsSync(adapterPath))
    fail("api/_lib/hubspot-consent-state.mjs", "missing - the consent state adapter is gone");
  else {
    const adapter = readFileSync(adapterPath, "utf8");
    const hubspotSrcAll = readFileSync(join(ROOT, "..", "api/_lib/hubspot.mjs"), "utf8");
    const strayNames = (hubspotSrcAll.match(/\bcst_[a-z_]+/g) || []);
    if (strayNames.length)
      fail("api/_lib/hubspot.mjs",
        `hard-codes HubSpot consent property names (${[...new Set(strayNames)].join(", ")}) - they belong to api/_lib/hubspot-consent-state.mjs`);

    const declared = (adapter.match(/"(cst_[a-z_]+)"/g) || []).map((m) => m.slice(1, -1));
    if (new Set(declared).size !== 23)
      fail("api/_lib/hubspot-consent-state.mjs",
        `declares ${new Set(declared).size} consent properties - the approved HubSpot schema has exactly 23`);

    /* Phase 2 reads suppression and never writes it. The write function is
       the only place that could, so it is the only place checked. */
    const writeFn = /export function toHubSpotConsentProperties[\s\S]*?\n}/.exec(adapter)?.[0] || "";
    for (const suppression of ["smsSuppressed", "doNotCall", "doNotContact"])
      if (new RegExp(`SUPPRESSION_PROPERTIES\\.${suppression}\\b`).test(writeFn))
        fail("api/_lib/hubspot-consent-state.mjs",
          `the write path references SUPPRESSION_PROPERTIES.${suppression} - an ordinary form submission must never write a suppression`);
  }

  /* ---------------------------------------------------------------
     THE APPEND-ONLY CONSENT LEDGER
     ---------------------------------------------------------------
     Four static guards. All cheap, and each one guards an invariant a
     well-meaning refactor could delete without breaking anything that
     looks important. */
  const ledgerPath = join(ROOT, "..", "api/_lib/consent-ledger.mjs");
  if (!existsSync(ledgerPath))
    fail("api/_lib/consent-ledger.mjs", "missing - the durable consent evidence sink is gone");
  else {
    const ledgerSrc = readFileSync(ledgerPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
    /* The same rule the evidence builder follows: consent evidence stores
       no IP, and adding a ledger is not a reason to start. */
    if (/\bip\b|remoteAddress|x-forwarded-for/i.test(ledgerSrc))
      fail("api/_lib/consent-ledger.mjs", "reads an IP address - consent evidence deliberately stores no IP");
    /* An event's identity is the database's. A client-side UUID puts the
       uniqueness guarantee of a primary key in a process holding no UPDATE
       privilege to repair a collision with. */
    if (/randomUUID/.test(ledgerSrc))
      fail("api/_lib/consent-ledger.mjs",
        "mints an event_id in Node - event_id is a database default (db/001_communication_consent_events.sql)");

    /* Containment, exactly as for the cst_ names: one module owns the
       table and its columns. Scattering them is how a schema contract
       drifts from the database it describes. db/ and tests/ name them
       legitimately; nothing else under api/ may. */
    /* `consent_copy_version` is deliberately absent: HubSpot's own
       `cst_sms_consent_copy_version` contains it, and a containment rule
       that fires on the adapter that legitimately owns those names would
       just get deleted. The five below are unambiguous. */
    const LEDGER_NAMES = ["communication_consent_events", "phone_e164", "dedupe_key",
                          "source_event_id", "occurred_at"];
    for (const rel of ["api/lead.js", "api/_lib/consent.mjs", "api/_lib/hubspot.mjs",
                       "api/_lib/hubspot-consent-state.mjs", "api/_lib/description.mjs",
                       "api/_lib/permission.mjs",
                       /* The second ledger writer and its token module. A new
                          writer is exactly when a containment rule earns its
                          keep, so it is added to the rule rather than exempted
                          from it. */
                       "api/operator-action.js", "api/_lib/operator-token.mjs"]) {
      const text = readFileSync(join(ROOT, "..", rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
      const stray = LEDGER_NAMES.filter((n) => text.includes(n));
      if (stray.length)
        fail(rel, `names consent ledger schema (${stray.join(", ")}) - it belongs to api/_lib/consent-ledger.mjs`);
    }
  }

  /* The invariant a refactor is most likely to delete, because deleting it
     breaks nothing visible: a `cst_*` grant requires durable evidence.
     Without it a permission can be written that this business could not
     later prove it was given.

     tests/consent-ledger.test.mjs builds the exact regressions this guard
     exists to catch, in a throwaway copy of the tree, and confirms this
     script still refuses them - a guard nobody has ever seen fail is a
     guard nobody knows works. It pins the two call-site strings below, so
     renaming one here without updating the test fails the test rather than
     silently disarming the guard. */
  {
    /* The awaited CALL SITES, matched literally. */
    const LEDGER_APPEND_CALL = "await appendConsentEvents(";
    const CRM_WRITE_CALL = "await createLead(";
    const hubspotSrc = readFileSync(join(ROOT, "..", "api/_lib/hubspot.mjs"), "utf8");
    if (!/const consentOn\s*=\s*consentStateEnabled\(\)\s*&&\s*payload\.consent\?\.durable\s*===\s*true/
      .test(hubspotSrc))
      fail("api/_lib/hubspot.mjs",
        "the consent write gate no longer requires payload.consent.durable === true - a cst_ grant " +
        "could be written with no durable ledger evidence behind it");
    /* THE CALL SITES, NOT THE IMPORT.
       An earlier version of this guard searched for the bare identifier
       `appendConsentEvents`, which matches the import statement at the top
       of the file. An import is always before everything else, so the
       ordering comparison was between the import and the CRM write and
       could never fail - it proved nothing at all, and the presence check
       would have kept passing after the call itself was deleted.
       Both halves now look for the awaited call. */
    const leadSrc = readFileSync(join(ROOT, "..", "api/lead.js"), "utf8");
    const appendAt = leadSrc.indexOf(LEDGER_APPEND_CALL);
    const createAt = leadSrc.indexOf(CRM_WRITE_CALL);
    if (appendAt === -1)
      fail("api/lead.js",
        `does not call \`${LEDGER_APPEND_CALL}…\` - nothing appends to the consent ledger, so no ` +
        "submission could ever be granted a permission");
    if (createAt === -1)
      fail("api/lead.js", `does not call \`${CRM_WRITE_CALL}…\` - the CRM write is gone`);
    /* Order is load-bearing twice: the append must resolve before
       createLead() decides whether a grant may happen AND before it builds
       the enquiry block, or every good submission prints
       CONSENT LEDGER: NOT CONFIRMED and no grant is ever written.
       `indexOf` takes the FIRST CRM write, which is the conservative
       comparison - the append must precede the earliest one. */
    else if (appendAt !== -1 && appendAt > createAt)
      fail("api/lead.js", "appends to the consent ledger after the CRM write - the grant and the block would both be wrong");
  }

  const permissionSrc = readFileSync(join(ROOT, "..", "api/_lib/permission.mjs"), "utf8");
  for (const fn of ["canSendSms", "canPlaceAutomatedVoiceCall"])
    if (!new RegExp(`export function ${fn}\\b`).test(permissionSrc))
      fail("api/_lib/permission.mjs", `no exported ${fn} - the resolver is the only place permission may be decided`);

  /* -------------------------------------------------------------------
     GATE 8 — THE SEND-TIME AUTHORIZATION BOUNDARY
     -------------------------------------------------------------------
     THE BYPASS THIS GUARD EXISTS FOR. `canSendSms()` is PURE. Handed no
     durable suppression answer it decides on CRM state alone and can
     return ALLOWED - which is correct for the consent model and
     catastrophic for a sender, because the phone-keyed ledger is the
     suppression authority and would never have been consulted. A future
     Twilio or Retell caller that imports the resolver directly therefore
     texts people who sent STOP, and every test in the suite still passes.

     Convention cannot carry that. So: inside api/, ONLY
     api/_lib/send-permission.mjs may name the send predicates. Every other
     module must go through Gate 8, which performs the durable lookup as
     its final provider read. Comments are stripped first - a doc comment
     naming the function is not a call to it.
     ------------------------------------------------------------------- */
  const GATE8_REL = "api/_lib/send-permission.mjs";
  const gate8Path = join(ROOT, "..", GATE8_REL);
  if (!existsSync(gate8Path)) {
    fail(GATE8_REL, "missing - there is no send-time authorization boundary");
  } else {
    const gate8Src = readFileSync(gate8Path, "utf8");
    const stripped = (src) =>
      src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

    /* Gate 8 must actually consult the durable ledger, through the
       least-privilege function and never the table. */
    if (!/get_suppression_state\(\$1\)/.test(gate8Src))
      fail(GATE8_REL, "does not call public.get_suppression_state($1) - the durable suppression authority is not consulted");
    if (/communication_consent_events/.test(stripped(gate8Src)))
      fail(GATE8_REL, "names the ledger table - the sender role may only EXECUTE the lookup function");
    if (!/CONSENT_LEDGER_SENDER_URL/.test(gate8Src))
      fail(GATE8_REL, "does not use the least-privilege sender credential");
    if (/CONSENT_LEDGER_URL\b/.test(stripped(gate8Src)))
      fail(GATE8_REL, "reuses the append credential for send authorization - the sender role must be separate");

    /* Nothing in api/ may decide a send for itself. */
    const apiDir = join(ROOT, "..", "api");
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name))
        : /\.(?:mjs|js)$/.test(e.name) ? [join(dir, e.name)] : []);
    for (const abs of walk(apiDir)) {
      const rel = "api" + abs.slice(apiDir.length).replace(/\\/g, "/");
      if (rel === GATE8_REL || rel === "api/_lib/permission.mjs") continue;
      const code = stripped(readFileSync(abs, "utf8"));
      for (const fn of ["canSendSms", "canPlaceAutomatedVoiceCall"])
        if (new RegExp(`\\b${fn}\\b`).test(code))
          fail(rel, `calls ${fn}() directly - every sender must go through ${GATE8_REL}, which reads durable suppression last`);
    }
  }

  /* -------------------------------------------------------------------
     GATE 8 — THE OUTBOUND SENDER
     -------------------------------------------------------------------
     api/_lib/sms-sender.mjs is the first component in this repository
     that can cause an external messaging side effect. These guards are
     about CONTAINMENT: exactly one place in the tree may text a
     consumer, that place must ask gate 8 first, and neither fact may be
     undone by a refactor that breaks no visible behaviour.

     WHAT IS AND IS NOT PROVED HERE. A static reader cannot prove
     adjacency in general — the authorization could be moved into a
     helper, the decision stored on an object, the provider call wrapped
     two frames down, and no regex would notice. What the region guard
     below genuinely proves is narrower and stated as such: BETWEEN THE
     AUTHORIZATION CALL SITE AND THE PROVIDER CALL SITE, IN THE SENDER'S
     OWN SOURCE, THERE IS NO SUSPENSION POINT. Insert `await log(...)`,
     a `.then()`, a timer or a `new Promise` there and this fails. Move
     the authorization out of the function entirely and it does not —
     that case is carried by the executable ordering test in
     tests/sms-sender.test.mjs, which observes the real call order
     through an injected provider double.

     tests/sms-sender.test.mjs runs this script against a throwaway copy
     of the tree with each of these broken, so none of them is a guard
     nobody has seen fail.
     ------------------------------------------------------------------- */
  {
    const SENDER_REL = "api/_lib/sms-sender.mjs";
    const senderPath = join(ROOT, "..", SENDER_REL);
    const apiDir = join(ROOT, "..", "api");
    const strip = (src) =>
      src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const walkApi = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walkApi(join(dir, e.name))
        : /\.(?:mjs|js)$/.test(e.name) ? [join(dir, e.name)] : []);

    if (!existsSync(senderPath)) {
      fail(SENDER_REL, "missing - the designated outbound sender is gone");
    } else {
      const senderSrc = strip(readFileSync(senderPath, "utf8"));

      /* 1. ONE SIDE-EFFECT SITE, AND IT IS HERE.
            Every outbound shape is refused outside the sender. Comments
            are stripped first: a doc comment naming messages.create() is
            documentation, not a send. */
      /* THE SHAPES, NOT ONE SPELLING. `messages.create(` alone is a
         one-line bypass: `client.messages["create"]`, `client["messages"]`
         and `const fn = client.messages.create` all reach the same API and
         all used to pass. The call parenthesis is deliberately NOT
         required - taking a REFERENCE to the send function outside the
         sender is already the thing being forbidden.

         What this still does not catch: a name assembled from fragments
         at runtime. Nothing here is a parser, and this is stated rather
         than papered over. */
      const CREATE_SHAPES = [
        [/\bmessages\s*\.\s*create\b/, "reaches the Twilio message-create API"],
        [/\bmessages\s*\[\s*["'`]create["'`]\s*\]/, "reaches the Twilio message-create API by computed access"],
        [/\[\s*["'`]messages["'`]\s*\]/, "reaches the Twilio messages resource by computed access"],
      ];
      const SENDER_ONLY = [
        ...CREATE_SHAPES,
        [/\btwilio\s*\(/, "constructs a Twilio API client"],
        /* The test-only sender factory. Production code calling it would
           be building a second sender over boundaries of its choosing,
           which is the bypass in a different shape. */
        [/\b_senderForTest\b/, "builds a sender over injected boundaries"],
        /* The SDK's outbound parameter spelling, and the outbound
           credentials. Deliberately CASE-SENSITIVE and deliberately not
           `MessagingServiceSid`: api/twilio-inbound.js legitimately
           records the inbound webhook's own `params.MessagingServiceSid`
           as opt-out evidence, and a containment rule that fires on the
           module it is supposed to protect just gets deleted. The raw
           REST route is covered by REST_BYPASS below instead. That is a
           narrower claim than it looks: it catches the host written as a
           literal, which is how such a call actually gets written, and
           not a host assembled from fragments at runtime. */
        [/\bmessagingServiceSid\b/, "names a Twilio Messaging Service as an outbound parameter"],
        [/TWILIO_MESSAGING_SERVICE_SID|TWILIO_API_KEY_SID|TWILIO_API_KEY_SECRET/, "reads an outbound Twilio credential"],
      ];
      /* Forbidden EVERYWHERE, the sender included. The SDK is the only
         sanctioned path to Twilio; a hand-rolled REST call would carry
         its own credentials, its own account scoping and none of the
         one-attempt discipline this module documents. */
      const REST_BYPASS = [
        [/api\.twilio\.com/i, "addresses the Twilio REST API directly"],
        [/\/Messages\.json/i, "addresses the Twilio Messages REST resource directly"],
      ];

      for (const abs of walkApi(apiDir)) {
        const rel = "api" + abs.slice(apiDir.length).replace(/\\/g, "/");
        const code = strip(readFileSync(abs, "utf8"));
        for (const [re, what] of REST_BYPASS)
          if (re.test(code))
            fail(rel, `${what} - outbound Twilio traffic goes through the SDK inside ${SENDER_REL}`);
        if (rel === SENDER_REL) continue;
        for (const [re, what] of SENDER_ONLY)
          if (re.test(code))
            fail(rel, `${what} - only ${SENDER_REL} may cause an outbound Twilio side effect`);
        /* 2. AND IT STAYS DARK. Nothing reaches the sender, so merging
              it cannot make production capable of sending. Wiring it up
              is a deliberate act that has to delete this line. */
        if (/\bsms-sender\b/.test(code))
          fail(rel, `imports ${SENDER_REL} - the sender is deliberately unreachable while outbound messaging is dark`);
      }

      /* Exactly one, not merely at least one. Two call sites is two
         places to forget the gate. And the computed-access shapes must
         not appear in the sender either, because a second route through
         them would not be counted here. */
      const sites = senderSrc.match(/\bmessages\s*\.\s*create\s*\(/g) || [];
      if (sites.length !== 1)
        fail(SENDER_REL, `has ${sites.length} Twilio message-create call sites - there must be exactly one`);
      for (const [re, what] of CREATE_SHAPES.slice(1))
        if (re.test(senderSrc))
          fail(SENDER_REL, `${what} - the one send site must be a plain messages.create() call so it can be counted`);

      /* 3. THE SENDER ROUTES THROUGH GATE 8, AND GATE 8 CANNOT BE SWAPPED.
            ---------------------------------------------------------------
            An earlier version of this module exported `_setAuthorizer()`
            and read a module-level `let authorize`. Independent review of
            PR #51 called that what it was: an authorization-bypass
            mechanism shipped inside the production path. Any importer
            could replace gate 8 with `async () => ({ allowed: true })`,
            and the guard proving the DEFAULT pointed at gate 8 did not
            help, because the default was never the problem.

            So the production sender is now BUILT ONCE over the real
            boundaries and closes over them, and these three guards keep
            it that way. */
      if (!/import\s*\{[^}]*\bauthorizeSms\b[^}]*\}\s*from\s*"\.\/send-permission\.mjs"/.test(senderSrc))
        fail(SENDER_REL, "does not import authorizeSms from ./send-permission.mjs - the sender must go through gate 8");

      /* (a) The exported sender is bound to the REAL gate 8 and the REAL
             client factory, at module load. */
      if (!/export\s+const\s+sendSms\s*=\s*makeSender\(\s*\{[^}]*\bauthorize:\s*authorizeSms\b/.test(senderSrc))
        fail(SENDER_REL, "the exported sendSms is not built over authorizeSms - the production sender must close over gate 8 itself");
      if (!/export\s+const\s+sendSms\s*=\s*makeSender\(\s*\{[^}]*\bclientFactory:\s*realClient\b/.test(senderSrc))
        fail(SENDER_REL, "the exported sendSms is not built over realClient - the production sender must close over the real provider");

      /* (b) NO MODULE-SCOPE MUTABLE BINDING. A `let` or `var` at column
             zero is exactly the shape the bypass had: something the send
             path reads at call time and an exported setter can rewrite.
             `const` is fine; a `let` inside a function is indented. */
      if (/^(?:let|var)\s/m.test(senderSrc))
        fail(SENDER_REL, "declares a module-scope mutable binding - the send path must close over its boundaries, not look them up");

      /* (c) NO EXPORTED SETTER. Belt and braces with (b): even a setter
             over something other than the authorizer is a runtime switch
             inside a module that can text a consumer. */
      if (/export\s+(?:function|const|let|var)\s+_set/.test(senderSrc))
        fail(SENDER_REL, "exports a _set* mutator - there must be no runtime switch inside the sender");

      /* (d) THE OUTBOUND PATH NEVER READS THE INBOUND MASTER SECRET.
             TWILIO_AUTH_TOKEN is the account's master credential and the
             signature key api/_lib/twilio.mjs verifies inbound webhooks
             with. Separating the two is the entire reason outbound has
             its own API Key pair; a sender that reaches for the auth
             token silently undoes that, and would send on a credential
             that cannot be rotated without breaking gate 7. */
      if (/TWILIO_AUTH_TOKEN/.test(senderSrc))
        fail(SENDER_REL, "reads TWILIO_AUTH_TOKEN - the outbound sender must use its own API Key pair, never the inbound master secret");

      /* 4. THE FLAG IS STRICT, AND FIRST. Off by default, on only for
            the exact string, and checked before the gate 8 call so a
            dark system spends no provider round trip. */
      if (!/OUTBOUND_SMS_FLAG[^\n]{0,60}===\s*"true"/.test(senderSrc))
        fail(SENDER_REL, "the outbound flag is not compared strictly to \"true\" - outbound messaging must not switch on through a typo");
      /* And not by any looser test alongside it. `!== "false"` is the
         shape that turns a compliance switch on by default. */
      if (/OUTBOUND_SMS_FLAG[^\n]{0,60}(?:!==?\s*"false"|[^!=]==\s*"true")/.test(senderSrc))
        fail(SENDER_REL, "compares the outbound flag loosely - only the exact string \"true\" may enable outbound messaging");

      const flagAt = senderSrc.search(/outboundSmsEnabled\s*\(\s*env\s*\)/);
      const authAt = senderSrc.search(/\bawait\s+authorize\s*\(/);
      const sendAt = senderSrc.search(/\bmessages\s*\.\s*create\s*\(/);

      if (authAt === -1)
        fail(SENDER_REL, "has no `await authorize(` call site - nothing asks gate 8 before sending");
      else if (sendAt === -1)
        fail(SENDER_REL, "has no Twilio message-create call site");
      else if (authAt > sendAt)
        fail(SENDER_REL, "sends before it authorizes - gate 8 is consulted after the message has left");
      else {
        if (flagAt === -1 || flagAt > authAt)
          fail(SENDER_REL, "reaches gate 8 before checking the outbound feature flag - a dark system would still read HubSpot and Neon");

        /* 5. NO SUSPENSION POINT BETWEEN THE DECISION AND THE SEND.
              Bounded exactly as the header of this section says: the
              region is the sender's own source between the end of the
              authorization statement and the provider call. The final
              `await <client>.` belongs to the send itself and is
              removed before the scan - and if the send is NOT awaited
              directly off a local identifier, that is itself refused,
              because then the region boundary would be a guess. */
        const semi = senderSrc.indexOf(";", authAt);
        if (semi === -1 || semi > sendAt)
          fail(SENDER_REL, "the gate 8 call site is not a single statement - the adjacency region cannot be bounded");
        else {
          const region = senderSrc.slice(semi + 1, sendAt);
          const SEND_PREFIX = /\bawait\s+[A-Za-z_$][\w$]*\s*\.\s*$/;
          if (!SEND_PREFIX.test(region)) {
            fail(SENDER_REL, "the Twilio message-create call is not awaited directly off a local client - the send must be the statement that follows the authorization");
          } else {
            const between = region.replace(SEND_PREFIX, " ");
            /* The fail-closed shape, not `allowed === false`: anything
               that is not exactly an allowance is a refusal. */
            if (!/allowed\s*!==\s*true/.test(between))
              fail(SENDER_REL, "does not refuse on `allowed !== true` between gate 8 and the send - a malformed or missing decision must not send");
            if (!/\breturn\b/.test(between))
              fail(SENDER_REL, "does not return between gate 8 and the send - a denial has no way to stop the message");
            const SUSPENSIONS = [
              [/\bawait\b/, "an await"],
              [/\.\s*then\s*\(/, "a .then()"],
              [/\byield\b/, "a yield"],
              [/\bnew\s+Promise\b/, "a new Promise"],
              [/\bset(?:Timeout|Interval|Immediate)\s*\(/, "a timer"],
              [/\bqueueMicrotask\s*\(/, "a queueMicrotask()"],
              [/\bprocess\s*\.\s*nextTick\s*\(/, "a process.nextTick()"],
            ];
            for (const [re, what] of SUSPENSIONS)
              if (re.test(between))
                fail(SENDER_REL, `has ${what} between the gate 8 decision and the Twilio send - every suspension point there is a window in which a STOP can arrive and be ignored`);

            /* AND THE SEND'S OWN ARGUMENTS. An `await` in the argument
               list resolves BEFORE the request is made, so it sits
               between the decision and the side effect just as surely as
               one on the line above - and it falls outside the region
               scanned above, which ends where the call begins. Bounded
               by the statement's terminating semicolon. */
            const argEnd = senderSrc.indexOf(";", sendAt);
            const args = argEnd === -1 ? senderSrc.slice(sendAt) : senderSrc.slice(sendAt, argEnd);
            for (const [re, what] of SUSPENSIONS)
              if (re.test(args))
                fail(SENDER_REL, `has ${what} inside the Twilio send's own arguments - it resolves before the request is made, which is the same window`);
          }
        }
      }
    }
  }

  /* -------------------------------------------------------------------
     GATE 7 — THE INBOUND SUPPRESSION ENDPOINT
     -------------------------------------------------------------------
     Four invariants, each of which a refactor could delete without
     breaking a single visible behaviour. tests/suppression.test.mjs runs
     this script against a throwaway copy of the tree with each one broken,
     so a guard nobody has seen fail is not what is being relied on here.
     ------------------------------------------------------------------- */
  const webhookRel = "api/twilio-inbound.js";
  const webhookPath = join(ROOT, "..", webhookRel);
  if (!existsSync(webhookPath))
    fail(webhookRel, "missing - nothing records a STOP, so an opt-out would be silently lost");
  else {
    const raw = readFileSync(webhookPath, "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, " ");

    /* 1. AUTHENTICATE BEFORE INTERPRETING. The body is attacker-controlled
          until the signature says otherwise, so the verification call must
          come before the classification call. Matched as CALL SITES, not
          bare identifiers - an import is always first and would make the
          ordering comparison prove nothing (the mistake this project
          already made once, in the ledger append guard below). */
    const VERIFY_CALL = "verifyTwilioSignature(req";
    /* `= classify(params)` and not `classify(params)`: the bare form also
       matches the FUNCTION DECLARATION `function classify(params)`, which
       sits above the handler and would make this comparison prove nothing.
       That is exactly the bug the ledger append guard shipped with in
       September 2026, caught here the first time this guard was run. */
    const CLASSIFY_CALL = "= classify(params)";
    const verifyAt = src.indexOf(VERIFY_CALL);
    const classifyAt = src.indexOf(CLASSIFY_CALL);
    if (verifyAt === -1)
      fail(webhookRel, `does not call \`${VERIFY_CALL}…\` - an unauthenticated request would be processed, so anyone could forge an opt-out or a re-opt-in`);
    if (classifyAt === -1)
      fail(webhookRel, `does not call \`${CLASSIFY_CALL}\` - nothing classifies the message`);
    else if (verifyAt !== -1 && verifyAt > classifyAt)
      fail(webhookRel, "classifies the message before verifying the signature - an attacker's body would be interpreted");

    /* 2. LEDGER BEFORE HUBSPOT. The ledger is the enforcement source of
          truth; the HubSpot write is a projection whose failure is
          swallowed. Reversed, a swallowed failure would be the durable
          record, and the endpoint would answer 200 having recorded
          nothing. */
    const LEDGER_CALL = "await appendSuppressionEvents(";
    const PROJECT_CALL = "await projectToHubSpot(";
    const ledgerAt = src.indexOf(LEDGER_CALL);
    const projectAt = src.indexOf(PROJECT_CALL);
    if (ledgerAt === -1)
      fail(webhookRel, `does not call \`${LEDGER_CALL}…\` - a STOP would leave no durable evidence`);
    if (projectAt !== -1 && ledgerAt !== -1 && ledgerAt > projectAt)
      fail(webhookRel, "writes to HubSpot before the ledger - the durable record would be the one whose failure is ignored");

    /* 3. THE CONSUMER'S MESSAGE NEVER REACHES A LOG. `params.Body` may be
          read for classification and for evidence_text, and must never be
          an argument to log(). */
    for (const m of src.matchAll(/\blog\(([^;]*?)\);/gs))
      if (/\bBody\b/.test(m[1]))
        fail(webhookRel, "logs the inbound message body - the consent ledger stores it as evidence, a log line is not evidence and is not access-controlled");

    /* 3b. THE PROJECTION IS BOUNDED, AND THE BOUND IS HARD. The webhook's
           per-contact HubSpot loop runs AFTER the ledger has committed and
           inside a 15 s maxDuration shared with Twilio's own ~15 s webhook
           timeout. Unbounded — which it was until 11 September 2026 — a
           number held by 100 contacts is 100 sequential requests and the
           function is killed before it can answer.

           Anchored to projectToHubSpot()'s BODY, not to the file. A guard
           that searched the whole source would be satisfied by the
           constants merely being declared at the top while the loop that
           is supposed to honour them no longer did — the shape proved by
           mutation to be worthless in guard 5 on 10 September 2026. */
    const projStart = src.indexOf("async function projectToHubSpot");
    if (projStart === -1)
      fail(webhookRel, "has no projectToHubSpot - the suppression would reach no contact");
    else {
      const nextFn = src.indexOf("\nasync function ", projStart + 1);
      const projBody = src.slice(projStart, nextFn === -1 ? src.length : nextFn);

      /* THE DEADLINE MUST REACH THE REQUESTS. Checking the clock only
         between requests bounds when a write may START and says nothing
         about when it ends: a write beginning a moment before the deadline
         runs on under HubSpot's own 8 s timeout. Both calls must carry a
         per-request timeout derived from the remaining budget. */
      for (const call of ["findContactsByPhone(", "writeSuppressionProperties("]) {
        const at = projBody.indexOf(call);
        if (at === -1)
          fail(webhookRel, `projectToHubSpot does not call ${call}…) - the projection cannot do its job`);
        else if (!/timeoutMs:\s*requestMs\(\)/.test(projBody.slice(at, at + 220)))
          fail(webhookRel, `${call}…) in projectToHubSpot is not given \`timeoutMs: requestMs()\` - the deadline would be checked only BETWEEN requests, so a request starting just inside it would run on under HubSpot's own timeout`);
      }

      /* THE BUDGET MUST BE ABSOLUTE. Derived from handler entry, so the
         ledger append and the body read spend the same budget rather than
         stacking on top of a projection-local one. */
      if (!/const\s+deadline\s*=\s*entry\s*\+\s*PROJECTION_DEADLINE_MS/.test(projBody))
        fail(webhookRel, "projectToHubSpot does not derive its deadline from handler entry - a projection-local budget stacks on top of the ledger append and the two together can outlive the function");
      if (!/\bstartedAt\b/.test(projBody))
        fail(webhookRel, "projectToHubSpot ignores startedAt - its deadline would not be measured from handler entry");

      /* THE REQUEST COUNT MUST BE CAPPED. A phone can match up to 100
         contacts; the time bound alone would spend the whole budget on
         them and leave the endpoint no room to answer. */
      if (!/attempted\s*>=\s*MAX_PROJECTION_CONTACTS/.test(projBody))
        fail(webhookRel, "projectToHubSpot does not cap attempted writes at MAX_PROJECTION_CONTACTS - up to 100 sequential HubSpot requests would run inside a 15 s function");

      /* EVERY CONTACT LANDS IN EXACTLY ONE BUCKET. The buckets must sum to
         the contacts found, or the log line quietly loses a contact — the
         defect this endpoint shipped with, and the one #24 found in the
         operator action. A bucket that is never incremented is a bucket
         that does not exist. */
      for (const bucket of ["written", "unchanged", "failed", "skipped"])
        if (!new RegExp(`\\b${bucket}\\s*\\+=\\s*1`).test(projBody))
          fail(webhookRel, `projectToHubSpot never increments \`${bucket}\` - the projection tally would not sum to the contacts found, and a contact would vanish from the record`);
      if (!/contacts:\s*contacts\.length[\s\S]{0,160}skipped/.test(projBody))
        fail(webhookRel, "the projection_done log line does not report the population alongside the skipped count - a partial projection could not be told from a complete one");
    }

    /* 4. THE WEBSITE PATH STILL WRITES NO SUPPRESSION. The separation is
          the point: different path, different credential, different
          authority. */
    const leadSuppression = readFileSync(join(ROOT, "..", "api/lead.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ");
    for (const name of ["appendSuppressionEvents", "toHubSpotSuppressionProperties",
                        "writeSuppressionProperties"])
      if (leadSuppression.includes(name))
        fail("api/lead.js", `calls ${name} - an ordinary form submission must never write a suppression`);
  }

  /* -------------------------------------------------------------------
     GATE 7 — SURFACING, AND THE OPERATOR ACTION
     -------------------------------------------------------------------
     Each of these is an invariant a refactor could delete without
     breaking a single visible behaviour, on code that is inert in
     production and therefore has no live traffic to notice.
     ------------------------------------------------------------------- */
  {
    /* 5. AN UNCLASSIFIED MESSAGE IS NEVER A SILENT 200. The whole reason
          the surfacing path exists is that a log line is not an operator
          workflow, so the branch must both notify and be able to fail
          loudly. */
    const inbound = readFileSync(webhookPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
    if (!inbound.includes("sendInboundNotification("))
      fail(webhookRel, "does not send the operator notification - an unrecognised opt-out would reach nobody");
    /* ANCHORED TO THE FUNCTION BODY, and that is the whole point.
       This was an OR whose first alternative matched the CALL SITE in the
       `!decision` branch, which happens to sit within 400 characters of
       the unrelated `ledger_absent` 503. Proved by mutation on
       10 September 2026: replacing EVERY 503 reply inside
       surfaceToOperator() with a 200 left check.mjs passing — the guard
       was syntactically satisfied while the invariant it names was
       destroyed. Now the body is extracted and counted on its own.

       AND IT NO LONGER ENCODES reply()'s ARGUMENT SHAPE. It used to
       match the literal `reply(res, 503)`. On 11 September 2026 the
       connection-lifecycle repair changed that call to
       `reply(req, res, 503)` — at which point the old pattern would have
       counted ZERO failure paths and the guard would have fired on
       correct code; loosening it to make `npm run check` pass is how a
       guard becomes decoration. The pattern below asks the question the
       invariant is actually about — "does this reply carry a 503?" —
       so a further signature change cannot silently empty it, while a
       status change still fails it. The mutation tests in
       tests/operator-action.test.mjs assert their target exists before
       replacing it, so a stale mutation cannot report green either. */
    const surfaceStart = inbound.indexOf("async function surfaceToOperator");
    if (surfaceStart === -1)
      fail(webhookRel, "has no surfaceToOperator - the unclassified branch surfaces nothing");
    else {
      /* To the next top-level function declaration, or end of file. */
      const nextFn = inbound.indexOf("\nasync function ", surfaceStart + 1);
      const surfaceBody = inbound.slice(surfaceStart, nextFn === -1 ? inbound.length : nextFn);
      /* Any reply() whose arguments carry 503, whatever precedes them. */
      const failing = surfaceBody.match(/\breply\([^)]*\b503\b[^)]*\)/g) || [];
      /* Four ways to fail to surface, and every one of them is a 503:
         unconfigured, seal failure, send failure, and a send that
         declined without throwing. Fewer than four means one of them
         became a silent 200. */
      if (failing.length < 4)
        fail(webhookRel, `surfaceToOperator answers 503 on only ${failing.length} of its 4 failure paths - a failure to surface would be a silent 200`);
      const lastFailure = surfaceBody.lastIndexOf(failing[failing.length - 1] || "\u0000");
      if (lastFailure > 0 && /\breply\([^)]*\b200\b/.test(surfaceBody.slice(0, lastFailure)))
        fail(webhookRel, "surfaceToOperator answers 200 before its last failure check - a failure would be reported as success");
    }

    /* 5b. EVERY RESPONSE GOES THROUGH THE LIFECYCLE-AWARE BOUNDARY.
           Both gate 7 endpoints decide `Connection: close` at ONE place —
           reply() here, page() in the operator action — because a request
           answered while its declared body is still outstanding leaves
           HTTP/1.1 advertising a connection the server may never serve
           (the shape #30 fixed on the live lead path). A response written
           directly with res.end() would bypass that decision and reopen
           the defect on exactly one path, which is the kind of hole no
           behavioural test is guaranteed to be pointed at. */
    for (const [rel, srcText, helper] of [
      [webhookRel, inbound, "reply"],
      ["api/operator-action.js", null, "page"],
    ]) {
      const path = join(ROOT, "..", rel);
      /* A missing file is reported by its own guard below; crashing here
         with ENOENT would replace that message with a stack trace. */
      if (srcText === null && !existsSync(path)) continue;
      const text = srcText ?? readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");

      /* EXACTLY ONE, and that is what makes the slice below exact. */
      const ends = (text.match(/\bres\.end\(/g) || []).length;
      if (ends !== 1)
        fail(rel, `writes res.end() ${ends} times - every response must go through ${helper}(), which is where the connection lifecycle is decided`);

      /* ANCHORED TO THE HELPER'S OWN BODY, not to a character window.
         A window is satisfiable by code that merely sits near the helper,
         and it goes stale the moment a header is added — the two ways a
         guard stops guarding. The slice runs from the declaration to the
         file's single res.end(), so the decision must be INSIDE it and
         must come BEFORE the response is written. */
      const declared = text.indexOf(`function ${helper}(req, res`);
      const writes = text.indexOf("res.end(");
      if (declared === -1)
        fail(rel, `has no ${helper}(req, res, ...) - the response boundary that decides the connection is gone`);
      else if (writes < declared)
        fail(rel, `writes its response outside ${helper}() - the connection decision would be bypassed`);
      else {
        const boundary = text.slice(declared, writes);
        if (!boundary.includes("bodyStillOutstanding(req)") || !boundary.includes("Connection"))
          fail(rel, `${helper}() does not set Connection: close from bodyStillOutstanding(req) before answering - a refusal with an unconsumed body would advertise a reusable connection`);
      }
    }

    const operatorRel = "api/operator-action.js";
    const operatorPath = join(ROOT, "..", operatorRel);
    if (!existsSync(operatorPath))
      fail(operatorRel, "missing - the operator has no way to record an opt-out without a database credential");
    else {
      const raw = readFileSync(operatorPath, "utf8");
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, " ");

      /* 6. THE GET WRITES NOTHING. Link scanners, mail-gateway antivirus
            and prefetch all issue unattended GETs, and a suppression
            cannot be undone. The write calls must not be reachable from
            the GET path at all. */
      const getStart = src.indexOf("async function handleGet(");
      if (getStart === -1)
        fail(operatorRel, "has no handleGet - the GET/POST split is the whole safety model");
      else {
        const getEnd = src.indexOf("async function handlePost(", getStart);
        const getBody = src.slice(getStart, getEnd === -1 ? src.length : getEnd);
        for (const call of ["appendSuppressionEvents", "buildSuppressionEvent",
                            "writeSuppressionProperties", "projectToHubSpot"])
          if (getBody.includes(call))
            fail(operatorRel, `the GET path calls ${call} - a link scanner would suppress a number with no human involved`);
      }

      /* 7. ONLY `revoked` IS REACHABLE. `unsuppressed` from this endpoint
            would be an unsuppression route, which this phase deliberately
            does not have. */
      if (!src.includes("EVENT_TYPE.REVOKED"))
        fail(operatorRel, "does not emit EVENT_TYPE.REVOKED - the operator entry would record the wrong act");
      for (const forbidden of ["EVENT_TYPE.UNSUPPRESSED", "EVENT_TYPE.SUPPRESSED",
                               "EVENT_TYPE.CONSENT_SELECTED"])
        if (src.includes(forbidden))
          fail(operatorRel, `names ${forbidden} - this endpoint may emit only \`revoked\``);

      /* 8. LEDGER BEFORE HUBSPOT, and the ledger's failure is never
            swallowed. Reversed, the durable record would be the one whose
            failure is ignored. */
      const ledgerAt2 = src.indexOf("await appendSuppressionEvents(");
      const projectAt2 = src.indexOf("await projectToHubSpot(");
      if (ledgerAt2 === -1)
        fail(operatorRel, "does not append to the ledger - the operator entry would leave no durable evidence");
      if (projectAt2 !== -1 && ledgerAt2 !== -1 && ledgerAt2 > projectAt2)
        fail(operatorRel, "writes to HubSpot before the ledger - the durable record would be the one whose failure is ignored");

      /* 9. NEITHER THE NUMBER NOR THE WORDS REACH A LOG. The sealed token
            exists so a URL carries ciphertext; logging the plaintext would
            undo that in one line. */
      for (const m of src.matchAll(/\blog\(([^;]*?)\);/gs))
        if (/payload\.(phone|body)|\bparams\.t\b|\bpayload\.p\b|\bactionUrl\b|\bnote\b/.test(m[1]))
          fail(operatorRel, "logs the consumer's number, words, note or the token - a log line is not access-controlled");

      /* 10. NO SCOPE DEFAULT. "stop texting me" and "stop contacting me"
             are different suppressions, and only the human reading the
             message can choose. A default here is the endpoint making the
             judgement the human is there to make. */
      if (!/scope_missing/.test(src))
        fail(operatorRel, "does not refuse a POST with no scope - a default scope would suppress more or less than was asked");

      /* 11. THE CONFIRMATION PAGE LOADS NOTHING REMOTE. A third-party
             asset on a page carrying a live capability and a consumer's
             words is a referrer leak and a tracking surface. */
      for (const m of src.matchAll(/(?:src|href)\s*=\s*["'`]?(https?:)?\/\//g))
        fail(operatorRel, "the confirmation page references an off-site resource - it must load nothing remote");
    }

    /* 12. THE TOKEN MODULE BOUNDS ITS OWN OUTPUT. The URL size was an
           arithmetic estimate in the design document; an estimate is
           correct until a field is added. */
    const tokenRel = "api/_lib/operator-token.mjs";
    const tokenPath = join(ROOT, "..", tokenRel);
    if (!existsSync(tokenPath))
      fail(tokenRel, "missing - the operator action has no sealed token");
    else {
      const tok = readFileSync(tokenPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
      if (!/aes-256-gcm/.test(tok))
        fail(tokenRel, "does not seal with aes-256-gcm - a signed plaintext token would put a phone number in a URL");
      if (!/MAX_ACTION_URL_BYTES/.test(tok) || !/MAX_TOKEN_CHARS/.test(tok))
        fail(tokenRel, "has no hard size bound - a URL over the header budget fails in production, not in a test");
      /* 13. THE SECRET HAS AN ENTROPY FLOOR. This key mints bearer
             capabilities and HKDF cannot make a guessable input
             unguessable, so a short secret must read as "not configured"
             rather than deriving a well-formed key from `hunter2`. */
      if (!/MIN_SECRET_BYTES/.test(tok))
        fail(tokenRel, "has no minimum length for the sealing secret - HKDF does not turn a weak secret into a strong key");
      for (const m of tok.matchAll(/\blog\(/g))
        fail(tokenRel, "logs - this module holds the plaintext number and message and must emit nothing");
    }
  }

  /* The suppression lookup migration, and the two hardening steps that are
     silent when missing: without SET search_path a caller can shadow the
     table and be read with the owner's rights, and without the REVOKE the
     function is granted to PUBLIC - including the website's role. */
  const migRel = "db/002_suppression_lookup.sql";
  const migPath = join(ROOT, "..", migRel);
  if (!existsSync(migPath))
    fail(migRel, "missing - send-time enforcement has no way to resolve suppression by number");
  else {
    const mig = readFileSync(migPath, "utf8");
    if (!/SECURITY DEFINER/.test(mig))
      fail(migRel, "the lookup function is not SECURITY DEFINER - it would run as the caller and return nothing");
    if (!/SET\s+search_path\s*=/.test(mig))
      fail(migRel, "no SET search_path on a SECURITY DEFINER function - a caller could shadow the table and have it read with the owner's rights");
    if (!/REVOKE\s+EXECUTE\s+ON\s+FUNCTION[\s\S]*?FROM\s+PUBLIC/i.test(mig))
      fail(migRel, "does not REVOKE EXECUTE FROM PUBLIC - PostgreSQL grants EXECUTE to PUBLIC by default, so every role including the website's would get it");
    /* The sender must never gain a table privilege. Comments are stripped
       first so the documented refusals in section 4 do not trip this. */
    const migCode = mig.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    if (/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|ALL)[\s\S]*?ON\s+(?:TABLE\s+)?communication_consent_events/i.test(migCode))
      fail(migRel, "grants a table privilege - the sender role must hold EXECUTE on the function and nothing else");
    /* THE MIS-PAIRING. `min(occurred_at), min(reason_code)` are two
       INDEPENDENT aggregates: they return a timestamp from one row and a
       reason from a different one. Measured on PostgreSQL 16 with two
       suppressions on one number, the buggy form paired 2026-09-01 with the
       2026-09-05 row's reason. The sender does not need the reason at all,
       so the function returns only channel and timestamp — and a column
       that is not returned cannot be mis-paired. */
    if (/min\s*\(\s*[a-z_.]*reason_code\s*\)/i.test(migCode))
      fail(migRel, "aggregates reason_code independently of occurred_at - it would return a reason belonging to a different row than the timestamp");
    if (/RETURNS\s+TABLE\s*\([^)]*reason_code/i.test(migCode))
      fail(migRel, "returns reason_code - the sender decides from the PRESENCE of a suppression, and returning it invites the independent-aggregate mis-pairing");
  }

  /* ---------------------------------------------------------------------
     db/003 — THE UNSUPPRESSION FOLD
     ---------------------------------------------------------------------
     Every invariant below is one a refactor could delete without breaking a
     visible behaviour, on a migration nothing calls yet. The semantic ones
     are the point: if the two clearance kinds stop being distinguished, a
     correction of one erroneous row silently erases unrelated legitimate
     consumer refusals again, and the audit trail says otherwise.
     --------------------------------------------------------------------- */
  const unsupRel = "db/003_unsuppression_lookup.sql";
  const unsupPath = join(ROOT, "..", unsupRel);
  if (!existsSync(unsupPath))
    fail(unsupRel, "missing - the unsuppression fold has no migration and suppression stays permanent by construction");
  else {
    const raw = readFileSync(unsupPath, "utf8");
    const code = raw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

    /* The same hardening db/002 requires, on two more functions. */
    if ((code.match(/SECURITY DEFINER/g) || []).length < 2)
      fail(unsupRel, "fewer than two SECURITY DEFINER functions - both read wrappers must run with the owner's rights or they return nothing");
    if ((code.match(/SET\s+search_path\s*=/g) || []).length < 3)
      fail(unsupRel, "a function has no SET search_path - a caller could shadow the table and have it read with the owner's rights");
    for (const fn of ["_active_consent_blocks", "get_suppression_state", "get_active_blocks"])
      if (!new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${fn}\\s*\\(text\\)\\s+FROM\\s+PUBLIC`, "i").test(code))
        fail(unsupRel, `does not REVOKE EXECUTE ON ${fn} FROM PUBLIC - PostgreSQL grants EXECUTE to PUBLIC by default, so every role including the website's would get it`);

    /* THE SENDER MUST NOT GET EVENT IDENTITY. Gate 8 asks "may I send?" and
       needs allow/deny plus a timestamp; handing it dedupe_keys widens the
       live send path for nothing. */
    if (/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+get_active_blocks\s*\(text\)\s+TO\s+<sender_role>/i.test(code))
      fail(unsupRel, "grants get_active_blocks to the sender - the send path has no use for event identity");

    /* No role gains a READ or a MUTATION on the table. The operator's INSERT
       is approved and is the one table grant this migration may make. */
    if (/GRANT\s+(?:SELECT|UPDATE|DELETE|TRUNCATE|ALL)[\s\S]{0,80}?ON\s+(?:TABLE\s+)?communication_consent_events/i.test(code))
      fail(unsupRel, "grants a table read or mutation - append-only is a database grant, and no role may read this table");

    /* db/002's mis-pairing correction, preserved. */
    if (/min\s*\(\s*[a-z_.]*reason_code\s*\)/i.test(code))
      fail(unsupRel, "aggregates reason_code independently of occurred_at - it would return a reason belonging to a different row than the timestamp");

    /* ---- THE SEMANTICS THAT ACTUALLY PROTECT A CONSUMER REFUSAL ----
       A lane clearance MUST be scoped to consumer_request. Without that
       predicate every unsuppressed row clears the whole lane again - which
       is precisely the defect db/003 exists to correct, and it is one
       deleted line away. */
    if (!/event_type\s*=\s*'unsuppressed'[\s\S]{0,200}?reason_code\s*=\s*'consumer_request'/i.test(code))
      fail(unsupRel, "the lane-clearance branch is not scoped to reason_code = 'consumer_request' - every unsuppressed row would clear the whole lane and erase unrelated legitimate refusals");
    if (!/reason_code\s*=\s*'recorded_in_error'/i.test(code))
      fail(unsupRel, "no targeted-invalidation branch - recorded_in_error would clear nothing or everything, never the events it names");
    if (!/metadata\s*->\s*'invalidates'/i.test(code))
      fail(unsupRel, "the fold never reads metadata.invalidates - naming the corrected event would be decorative, which is the defect this migration corrects");

    /* FINDING B: jsonb_array_elements_text RAISES on a scalar or an object,
       so a malformed invalidates aborted the whole fold instead of being
       inert. The typeof guard is what makes non-array metadata fail toward
       MORE blocking. */
    if (!/jsonb_typeof\s*\([\s\S]{0,60}?'invalidates'[\s\S]{0,40}?=\s*'array'/i.test(code))
      fail(unsupRel, "no jsonb_typeof array guard - a malformed metadata.invalidates raises instead of invalidating nothing");

    /* FINDING A: the lane-clearance test asks "does this block SURVIVE", so
       an exact tie must answer YES. Strict '>' cleared on a tie while the
       design's own prose said the block wins. */
    if (!/occurred_at\s*>=\s*c\.cleared_at/i.test(code))
      fail(unsupRel, "the lane-clearance survival test is not >= - an exact timestamp tie would clear the block, and equality must fail closed");
    if (!/recorded_at\s*>=\s*c\.cleared_recorded_at/i.test(code))
      fail(unsupRel, "the second clock is not consulted with >= - a delayed or redelivered STOP would be discarded");

    /* PRE-EXISTENCE: the invalidation test asks "is this block KILLED", so
       an exact tie must answer NO. Strict '<', never '<='. */
    if (!/e\.recorded_at\s*<\s*v\.killed_at/.test(code) || /e\.recorded_at\s*<=\s*v\.killed_at/.test(code))
      fail(unsupRel, "the pre-existence rule is not a strict < - an invalidation could kill a block recorded at the same instant or later");

    /* SAME LANE ONLY. */
    if (!/v\.channel\s*=\s*e\.channel/i.test(code))
      fail(unsupRel, "the invalidation join is not scoped to the same lane - a correction in one channel could reach another");
  }
}

/* ---------------------------------------------------------------------
   THE ZOHO MAIL ACKNOWLEDGEMENT IS SECONDARY, AND MUST STAY THAT WAY
   ---------------------------------------------------------------------
   One short email is sent from Crystal's mailbox after a lead reaches
   HubSpot. Three ways that quietly stops being harmless, none of which
   breaks a test or a build on its own:

     1. The send stops being awaited. On Vercel the container can be
        frozen the instant the response is written, so a fire-and-forget
        sendMail() is a coin flip that looks fine in every log.
     2. The send moves above createLead, so a visitor is thanked for a
        lead that was never stored.
     3. A mail failure stops being swallowed, and an SMTP outage starts
        telling people with saved leads to submit the form again.
   --------------------------------------------------------------------- */
{
  const REPO = join(ROOT, "..");
  const leadPath = join(REPO, "api/lead.js");
  const mailPath = join(REPO, "api/_lib/mail.mjs");

  if (!existsSync(mailPath)) fail("api/_lib/mail.mjs", "missing - the acknowledgement path is gone");
  if (!existsSync(leadPath)) fail("api/lead.js", "missing");

  /* Only executable code counts. These modules explain themselves at
     length, and a comment saying "this is NOT api/_lib/zoho.mjs" or "use
     log(), not logError()" must not trip the very rules it documents.
     `//` is stripped only when it does not follow a colon, so the https://
     URLs inside the signature template survive. */
  const codeOnly = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  if (existsSync(leadPath) && existsSync(mailPath)) {
    const lead = codeOnly(readFileSync(leadPath, "utf8"));
    const mail = codeOnly(readFileSync(mailPath, "utf8"));

    if (!/await\s+sendAcknowledgement\(/.test(lead))
      fail("api/lead.js", "sendAcknowledgement is not awaited - Vercel can freeze the container before SMTP finishes");

    const createAt = lead.indexOf("await createLead(");
    const ackAt = lead.indexOf("await sendAcknowledgement(");
    if (createAt === -1) fail("api/lead.js", "no awaited createLead call - HubSpot is no longer the authoritative store");
    else if (ackAt !== -1 && ackAt < createAt)
      fail("api/lead.js", "the acknowledgement is sent before HubSpot confirms - a visitor would be thanked for a lead that was never stored");

    /* The swallow. Without it an SMTP outage becomes a 502 on leads that
       are already safely in the CRM. */
    if (!/catch\s*\(\s*mailErr\s*\)/.test(lead))
      fail("api/lead.js", "the acknowledgement is not wrapped in its own catch - a mail failure would fail the lead");

    /* Zoho CRM rollback code must stay out of the live path. */
    if (/from\s+["'`]\.\/_lib\/zoho\.mjs["'`]/.test(lead))
      fail("api/lead.js", "imports the dormant Zoho CRM client - that is rollback code, not the live path");
    if (/zoho\.mjs/.test(mail))
      fail("api/_lib/mail.mjs", "references the Zoho CRM client - Zoho Mail and Zoho CRM share only a vendor name");

    /* logError() emits err.message, and a Nodemailer message carries the
       recipient address and the raw server response. */
    if (/logError\(/.test(mail))
      fail("api/_lib/mail.mjs", "uses logError - a Nodemailer error message carries the recipient address; classify instead");
    if (/logError\([^)]*mailErr/.test(lead))
      fail("api/lead.js", "passes the mail error to logError - log the classification only");

    for (const fn of ["isMailConfigured", "classifyMailError", "setTransportFactory"])
      if (!new RegExp(`export function ${fn}\\b`).test(mail))
        fail("api/_lib/mail.mjs", `no exported ${fn} - the mail path is no longer configurable or testable in isolation`);
  }

  /* Awaiting SMTP inside a function that already makes sequential HubSpot
     calls needs headroom. 15s was the pre-acknowledgement budget. */
  const vercelPath = join(REPO, "vercel.json");
  if (existsSync(vercelPath)) {
    const cfg = JSON.parse(readFileSync(vercelPath, "utf8"));
    const fn = cfg.functions && cfg.functions["api/lead.js"];
    if (!fn) fail("vercel.json", "api/lead.js has no function configuration");
    else if (!(fn.maxDuration >= 30))
      fail("vercel.json", `api/lead.js maxDuration is ${fn.maxDuration} - awaiting SMTP after HubSpot needs at least 30s`);
  }
}

/* ---------------------------------------------------------------------
   THE LEAD FORM IS ONE IMPLEMENTATION, AND TWO PAGES OWN ITS WORDING
   ---------------------------------------------------------------------
   /43551-seller-review needs different button text, so six presentation
   strings in src/partials/home-value-form.html became build variables.
   Parameterising shared copy is exactly how the homepage quietly acquires
   somebody else's call to action six months later, so both halves are
   pinned here:

     1. index.html and home-value.html must still render the ORIGINAL
        wording, character for character.
     2. every page carrying the form must expose an identical set of field
        names, so "presentation only" cannot quietly become "and one extra
        input".
   --------------------------------------------------------------------- */
{
  const DEFAULT_FORM_COPY = [
    ["step-1 button", "Get My Home Value"],
    ["microcopy", "No obligation &middot; Human valuation &middot; Not an automated estimate"],
    ["submit button", "Send My Valuation Request"],
    ["success heading", "Your request is in"],
    ["success lede", "Crystal will review your property details and follow up about your valuation."],
    ["privacy note", "Crystal uses your details to prepare and follow up about your home valuation."],
    ["email subject", 'data-subject="Home valuation request"'],
  ];

  for (const file of ["index.html", "home-value.html"]) {
    if (!existsSync(join(ROOT, file))) { fail(file, "expected page is missing"); continue; }
    const html = readFileSync(join(ROOT, file), "utf8");
    const flat = html.replace(/\s+/g, " ");
    for (const [what, copy] of DEFAULT_FORM_COPY)
      if (!flat.includes(copy))
        fail(file, `form ${what} no longer renders the default wording - formCopy defaults in tools/build.mjs must keep this page unchanged`);
  }

  /* The header and footer promotional CTAs are overridable too, so the
     pages that never override them must still render the site-wide
     destination and label. Navigation, legal identity and contact details
     are not parameterised at all and are covered by the other checks. */
  for (const file of pages) {
    if (file === "43551-seller-review.html") continue;
    const html = readFileSync(join(ROOT, file), "utf8").replace(/\s+/g, " ");
    if (!/class="nav__cta" href="\/home-value"[^>]*>What&rsquo;s My Home Worth\?/.test(html))
      fail(file, "header CTA no longer renders the default destination and label - chromeCta defaults in tools/build.mjs must keep this page unchanged");
    if (!/class="btn btn--gold" href="\/home-value"[^>]*>Get My Home&rsquo;s Value/.test(html))
      fail(file, "footer CTA no longer renders the default destination and label - chromeCta defaults in tools/build.mjs must keep this page unchanged");
  }

  /* The lead contract, spelled out. Comparing the pages only against each
     other passes happily when a field is added to the SHARED partial, which
     is the likeliest way it would actually happen, so the expected set is
     absolute. Changing this list means changing /api/lead and the HubSpot
     mapping too - that is the point of making it noisy. */
  const EXPECTED_FIELDS = (CONSENT_ON
    ? ["_gotcha", "ai_voice_consent", "condition", "email", "first_name", "last_name",
       "notes", "phone", "property_address", "sms_consent", "timeline"]
    : ["_gotcha", "condition", "email", "first_name", "last_name", "notes", "phone",
       "property_address", "timeline"]).join(",");
  /* Same reasoning for the sticky bar: its second cell is overridable, so
     the pages that never override it must still render the site-wide
     wording and destination. */
  for (const file of ["index.html", "home-value.html", "sell.html"]) {
    if (!existsSync(join(ROOT, file))) continue;
    const bar = readFileSync(join(ROOT, file), "utf8").match(/<div class="sticky-cta"[\s\S]*?<\/div>/);
    if (!bar) { fail(file, "sticky CTA bar is missing"); continue; }
    const flat = bar[0].replace(/\s+/g, " ");
    if (!flat.includes('href="/home-value"') || !flat.includes("Free Home Value"))
      fail(file, "sticky CTA no longer renders the default destination and label - stickyCta defaults in tools/build.mjs must keep this page unchanged");
  }

  const FIELDS = /<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/g;
  let formPages = 0;
  for (const file of pages) {
    const html = readFileSync(join(ROOT, file), "utf8");
    if (!/data-form-type="home_value"/.test(html)) continue;
    formPages++;
    const got = [...html.matchAll(FIELDS)].map((m) => m[1]).sort().join(",");
    if (got !== EXPECTED_FIELDS)
      fail(file, `home_value form fields changed\n      expected: ${EXPECTED_FIELDS}\n      found:    ${got}`);
  }
  if (!formPages) fail("site", "no page carries the home_value form - the funnel has gone missing");

  /* Every visitor-facing field except `notes` is mandatory. A lead reached
     HubSpot with no phone number because `phone` carried no `required`
     attribute and the server accepted a blank; a contact row with no way to
     call the person is not a lead. The markup and the server must agree, so
     both are pinned: losing either half is how the blank comes back.

     Two fields must NOT be required, and are pinned in that direction for the
     same reason. `_gotcha` is the honeypot - a bot filling it is the point.
     `notes` asks "Anything I should know?", which has no answer for a
     homeowner with nothing to add; requiring it produced "N/A" and "none"
     rather than better leads, so re-requiring it must be a deliberate change
     and not a copy-paste. */
  const MUST_BE_REQUIRED =
    ["property_address", "first_name", "last_name", "email", "phone", "timeline",
     "condition"];
  const MUST_NOT_BE_REQUIRED = { home_value: ["notes"], contact: [] };
  for (const file of new Set([...pages, "contact.html"])) {
    if (!existsSync(join(ROOT, file))) continue;
    const html = readFileSync(join(ROOT, file), "utf8");
    const isHomeValue = /data-form-type="home_value"/.test(html);
    const isContact = /data-form-type="contact"/.test(html);
    if (!isHomeValue && !isContact) continue;
    const want = isHomeValue
      ? MUST_BE_REQUIRED
      : ["first_name", "last_name", "email", "phone", "topic", "message"];
    for (const name of want) {
      const tag = new RegExp(
        '<(?:input|select|textarea)\\b[^>]*\\bname="' + name + '"[^>]*>').exec(html);
      if (!tag) { fail(file, `the ${name} field is missing from the form`); continue; }
      if (!/\brequired\b/.test(tag[0]))
        fail(file, `${name} is not marked required - every form field except notes is`);
    }
    for (const name of MUST_NOT_BE_REQUIRED[isHomeValue ? "home_value" : "contact"]) {
      const tag = new RegExp(
        '<(?:input|select|textarea)\\b[^>]*\\bname="' + name + '"[^>]*>').exec(html);
      if (tag && /\brequired\b/.test(tag[0]))
        fail(file, `${name} is marked required - it is deliberately optional`);
    }
    const hp = /<input[^>]*\bname="_gotcha"[^>]*>/.exec(html);
    if (hp && /\brequired\b/.test(hp[0]))
      fail(file, "the honeypot is marked required - it must stay empty and invisible");
  }

  /* The server half of the same contract. `required` in markup is a
     convenience the visitor can bypass; api/_lib/validate.mjs is the
     guarantee, and CI must notice if a rejection is ever quietly dropped. */
  const validateSrc = readFileSync(join(ROOT, "..", "api/_lib/validate.mjs"), "utf8");
  for (const code of ["MISSING_PHONE", "INVALID_PHONE", "MISSING_TIMELINE",
                      "MISSING_CONDITION", "MISSING_TOPIC",
                      "MISSING_ADDRESS", "MISSING_MESSAGE"]) {
    if (!validateSrc.includes(code))
      fail("api/_lib/validate.mjs", `${code} is gone - that field is no longer enforced server-side`);
  }
  /* And the other direction: `notes` is optional by decision, so a rejection
     for it reappearing is a regression, not a tightening. */
  if (/MISSING_NOTES/.test(validateSrc))
    fail("api/_lib/validate.mjs", "notes is rejected when blank - it is deliberately optional");
}

/* =====================================================================
   LEDGER HARDENING — the closed vocabularies and real rows-affected
   =====================================================================
   Two invariants a refactor could delete without breaking any visible
   behaviour, on code paths that are still inert. Both were real gaps until
   15 September 2026, and both fail SILENTLY when reintroduced — which is
   exactly the class this file exists to catch.

   1  buildSuppressionEvent() must validate event_type and channel against
      CLOSED lists. With requireText() there instead, a typo'd event type is
      inserted into an append-only table and then matches no fold, forever:
      no UPDATE grant to fix it, no DELETE grant to remove it, no SELECT
      grant to find it.

   2  appendSuppressionEvents() must report what POSTGRES DID. Reporting the
      input count makes a genuine append and a replay that inserted nothing
      indistinguishable, and a future unsuppression caller would clear a
      HubSpot suppression for a number that is currently and correctly
      suppressed (the decision document's §9.1).
   --------------------------------------------------------------------- */
{
  const ledgerRel = "api/_lib/consent-ledger.mjs";
  const ledgerPath = join(API, "_lib/consent-ledger.mjs");
  if (!existsSync(ledgerPath)) {
    fail(ledgerRel, "missing - the append-only ledger module is gone");
  } else {
    const src = readFileSync(ledgerPath, "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

    /* 1. THE CLOSED VOCABULARIES EXIST AND ARE USED. Declaring the lists and
          then still calling requireText() would pass a grep for the names
          alone, so both the declaration AND the call site are pinned. */
    for (const name of ["SUPPRESSION_EVENT_TYPES", "SUPPRESSION_CHANNELS"])
      if (!new RegExp(`export const ${name}\\s*=\\s*Object\\.freeze`).test(code))
        fail(ledgerRel, `${name} is not an exported frozen list - the suppression vocabulary is open again`);

    const builderAt = code.indexOf("export function buildSuppressionEvent(");
    if (builderAt === -1) {
      fail(ledgerRel, "buildSuppressionEvent is gone");
    } else {
      const builder = code.slice(builderAt, builderAt + 1200);
      if (!/requireOneOf\(\s*channel\s*,\s*SUPPRESSION_CHANNELS/.test(builder))
        fail(ledgerRel, "buildSuppressionEvent does not validate channel against SUPPRESSION_CHANNELS - an unknown lane would be written to an append-only table");
      if (!/requireOneOf\(\s*eventType\s*,\s*SUPPRESSION_EVENT_TYPES/.test(builder))
        fail(ledgerRel, "buildSuppressionEvent does not validate eventType against SUPPRESSION_EVENT_TYPES - a typo'd event type would be invisible to every fold, forever");
      /* The regression in its exact original shape. */
      if (/\brequireText\(\s*(?:channel|eventType)\s*,/.test(builder))
        fail(ledgerRel, "buildSuppressionEvent validates channel or eventType with requireText - that accepts ANY non-empty string, which is the defect closed on 15 September 2026");
    }

    /* 2. THE WEBSITE-ONLY EVENT TYPES STAY OUT. A vocabulary built from
          Object.values(EVENT_TYPE) would admit them and look correct. */
    const vocabAt = code.indexOf("export const SUPPRESSION_EVENT_TYPES");
    if (vocabAt !== -1) {
      const vocab = code.slice(vocabAt, code.indexOf("]", vocabAt));
      for (const forbidden of ["CONSENT_SELECTED", "CONSENT_NOT_SELECTED"])
        if (vocab.includes(forbidden))
          fail(ledgerRel, `SUPPRESSION_EVENT_TYPES admits EVENT_TYPE.${forbidden} - a suppression row would assert a consent decision no visitor made`);
      if (!vocab.includes("UNSUPPRESSED"))
        fail(ledgerRel, "SUPPRESSION_EVENT_TYPES does not admit EVENT_TYPE.UNSUPPRESSED - the builder contract no longer names the event db/003 folds");
      if (/Object\.values\(\s*EVENT_TYPE\s*\)/.test(vocab))
        fail(ledgerRel, "SUPPRESSION_EVENT_TYPES is derived from EVENT_TYPE - it must be its own narrower list, or the website-only types come back in");
    }

    /* 3. THE UNSUPPRESSION CONTRACT. Each of these is a rule from §5.4 that
          keeps a correction from becoming a lane clearance in disguise. */
    if (!/function validateUnsuppression\(/.test(code))
      fail(ledgerRel, "validateUnsuppression is gone - an `unsuppressed` row could carry anything");
    if (!/type\s*===\s*EVENT_TYPE\.UNSUPPRESSED\s*[\s\S]{0,40}?validateUnsuppression\(/.test(code))
      fail(ledgerRel, "buildSuppressionEvent no longer runs validateUnsuppression for an unsuppressed event");
    /* MATCHED AS QUOTED LITERALS, not bare substrings. `invalidates:empty`
       is a substring of `invalidates:empty_key`, so a bare-substring check
       for it stayed satisfied by an unrelated refusal while the rule it
       guards was gone — found by mutation, and the reason every needle
       below carries its quotes. */
    for (const [needle, why] of [
      ["\"metadata.invalidates:not_empty\"",
       "a consumer_request carrying targets is no longer refused - a targeted correction could wear a lane clearance's reason code and db/003 would clear the whole lane"],
      ["\"metadata.invalidates:empty\"",
       "a recorded_in_error naming nothing is no longer refused - §5.4 rule 3, and it would degrade into a lane clearance"],
      ["\"metadata.invalidates:cross_channel\"",
       "a cross-lane target is no longer refused - §5.4 rule 2 requires it in the builder as well as the fold"],
      ["\"metadata.invalidates:duplicate\"",
       "a duplicate target is no longer refused"],
      ["\"metadata.invalidates:not_a_blocking_event\"",
       "a target naming a non-blocking event type is no longer refused - it would be inert in the fold while the operator believed it worked"],
      ["\"source:not_operator\"",
       "an unsuppressed event no longer requires source=operator - an inbound webhook could format a clearance, and the design's first decision is that no automatic path writes one"],
      ["\"metadata.error_origin:not_applicable\"",
       "a consumer_request carrying error_origin is no longer refused - it would assert a cause nothing established"],
    ])
      if (!code.includes(needle))
        fail(ledgerRel, why);
    /* The canonical targets must be what is STORED. Validating a trimmed
       key and writing the raw one makes every rule above decorative:
       db/003 joins metadata.invalidates to dedupe_key with `=`. */
    if (!/return\s*\{\s*\.\.\.metadata,\s*invalidates:\s*canonical\s*\}/.test(code))
      fail(ledgerRel, "validateUnsuppression no longer returns the canonicalised invalidates - a target stored untrimmed matches no row in db/003 and the correction is silently inert");
    if (!/validateUnsuppression\(ch,\s*src,\s*reasonCode,\s*metadata\)\s*\n?\s*:\s*metadata/.test(code))
      fail(ledgerRel, "buildSuppressionEvent no longer stores the metadata validateUnsuppression validated - the validated value and the written value can drift");
    /* And the written column must be that validated object. Writing the
       caller's `metadata` instead would restore the exact defect found in
       review: validated trimmed, stored raw, inert in the fold. */
    if (!/metadata:\s*JSON\.stringify\(meta\s*&&/.test(code))
      fail(ledgerRel, "the metadata column is not written from the validated object - a canonicalised value would be validated and then discarded");

    if (!/UNSUPPRESSION_REASON/.test(code) || !/UNSUPPRESSION_ERROR_ORIGIN/.test(code))
      fail(ledgerRel, "the unsuppression vocabularies are no longer imported - reason_code and error_origin are open text again");

    /* 4. REAL ROWS AFFECTED. The executor must ask for them, runStatement
          must return them, and the suppression append must report them. */
    if (!/fullResults:\s*true/.test(code))
      fail(ledgerRel, "the Neon executor no longer asks for fullResults - the driver returns rows only, so every append reports an unknown row count and §9.1's first defence disappears");
    if (!/export function rowsAffectedOf\(/.test(code))
      fail(ledgerRel, "rowsAffectedOf is gone");
    if (!/return await Promise\.race\(/.test(code))
      fail(ledgerRel, "runStatement discards the driver's result again - rows affected cannot be reported from a value that was thrown away");

    const appendAt = code.indexOf("export async function appendSuppressionEvents(");
    if (appendAt === -1) {
      fail(ledgerRel, "appendSuppressionEvents is gone");
    } else {
      const append = code.slice(appendAt);
      if (!/\browsAffected\s*(?:,|:\s*rowsAffected\b)/.test(append))
        fail(ledgerRel, "appendSuppressionEvents does not report rowsAffected");
      /* THE DEFECT IN ITS EXACT ORIGINAL SHAPE: the input count returned as
         though it were a measurement. */
      if (/\b(?:events|rowsAffected)\s*:\s*events\.length/.test(append))
        fail(ledgerRel, "appendSuppressionEvents reports events.length - the INPUT count, which is identical on a genuine append and on a replay that inserted nothing (§9.1)");
    }
  }
}

/* --- report ---------------------------------------------------------- */
const uniqWarn = [...new Set(warnings)];
if (uniqWarn.length) {
  console.log("\nWarnings:");
  for (const w of uniqWarn) console.log("  ! " + w);
}
if (errors.length) {
  console.log("\nErrors:");
  for (const e of errors) console.log("  ✗ " + e);
  console.log(`\n${errors.length} error(s), ${uniqWarn.length} warning(s).`);
  process.exit(1);
}
console.log(`\n✓ ${pages.length} pages checked — no errors. ${uniqWarn.length} warning(s).`);
