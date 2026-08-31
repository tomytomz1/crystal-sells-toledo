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
const SECRET_NAMES = ["ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_CLIENT_ID"];
for (const file of [...pages.map((p) => p), "assets/js/main.js", "assets/css/styles.css"]) {
  const text = readFileSync(join(ROOT, file), "utf8");
  for (const name of SECRET_NAMES)
    if (text.includes(name)) fail(file, `references server secret ${name} in client-delivered output`);
  if (/Zoho-oauthtoken/i.test(text)) fail(file, "contains a Zoho OAuth token header in client output");
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
    fail("api/_lib/validate.mjs", `${field} limit ${m[1]} exceeds Zoho's ${max} — Zoho would reject`);
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
