/* =====================================================================
   Pre-flight checks for the built site. Run: npm run check
   Catches the things that quietly break a small marketing site:
   dead internal links, missing alt text, unreplaced template tokens,
   malformed JSON-LD, duplicate or missing meta.
   ===================================================================== */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
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
  "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_CLIENT_ID",
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

    const rollbackAt = env.search(/ROLLBACK ONLY/i);
    const firstZohoAt = env.search(/^ZOHO_/m);
    if (firstZohoAt !== -1) {
      if (rollbackAt === -1)
        fail(".env.example", "documents ZOHO_* variables with no ROLLBACK ONLY heading - reads as the live path");
      else if (firstZohoAt < rollbackAt)
        fail(".env.example", "a ZOHO_* variable appears above the ROLLBACK ONLY heading - reads as the live path");
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
  const EXPECTED_FIELDS =
    "_gotcha,condition,email,first_name,last_name,notes,phone,property_address,timeline";
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
