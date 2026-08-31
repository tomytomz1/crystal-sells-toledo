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
