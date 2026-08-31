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
const PLACEHOLDERS = [
  [/Toledo &amp; Perrysburg, Ohio<\/p>/, "the Key Realty office address on /contact"],
];

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

/* --- forms actually deliver ------------------------------------------- */
const js = readFileSync(join(ROOT, "assets/js/main.js"), "utf8");
if (/formEndpoint:\s*null/.test(js))
  warn("site", "formEndpoint is not set — forms fall back to opening the visitor's email client");

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
