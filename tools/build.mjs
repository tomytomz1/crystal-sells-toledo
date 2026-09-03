/* =====================================================================
   Static site assembler for crystalsellstoledo.com
   ---------------------------------------------------------------------
   Reads  : src/pages/*.html   (content + a JSON metadata header)
            src/partials/*.html (shared chrome)
            assets/, robots.txt, site.webmanifest (copied verbatim)
   Writes : public/ — plain, dependency-free HTML ready for any static host.

   Run    : npm run build
   Why    : the header, footer and <head> are authored once. Publishing a
            single directory also means only the site ships — STRATEGY.md,
            the market research and the page sources stay out of it.
   ===================================================================== */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public");
/* The canonical origin. Every absolute URL the build emits - canonical
   links, og:url, the JSON-LD graph, sitemap.xml and the Sitemap: line in
   robots.txt - is derived from this one constant, so it must name the
   hostname that actually SERVES the site, not one that redirects to it.

   It said www. until 2 September 2026, and www. was never registered on
   the Vercel project at all: it resolved to Vercel, got a fallback
   certificate that did not carry the name, and every browser refused it
   outright - HSTS includeSubDomains left no way to click through. So the
   whole site spent its life declaring a canonical host no visitor and no
   crawler could reach. www. now exists as a 308 to the apex; the apex is
   what Production is aliased to, and is what belongs here. */
const SITE = "https://crystalsellstoledo.com";

/* ---------------------------------------------------------------------
   CONTENT REVIEW DATE — OAC 1301:5-1-02(E)
   ---------------------------------------------------------------------
   Ohio requires that a licensee's website "disclose the date upon which
   the information contained therein was most recently updated", and that
   information which becomes outdated be corrected within fourteen days.

   THIS IS MAINTAINED BY HAND. Update it whenever substantive site
   information changes — contact details, licence status, brokerage,
   service areas, market claims, neighbourhood copy.

   It is deliberately NOT `new Date()` or a build timestamp. The rule asks
   when the INFORMATION was last reviewed, not when the site was last
   deployed; an automatic date would silently assert a review that never
   happened every time an unrelated CSS tweak shipped.
   --------------------------------------------------------------------- */
const CONTENT_UPDATED = "September 3, 2026";

/* ---------------------------------------------------------------------
   FORM PRESENTATION COPY
   ---------------------------------------------------------------------
   src/partials/home-value-form.html is the single implementation of the
   lead funnel and must stay that way. A page that needs different BUTTON
   TEXT is not a reason to fork it.

   These six strings are the only parameterised parts of that partial:
   labels, microcopy, the success wording and the email subject. Field
   names, validation, step behaviour, the honeypot, data-form-type and the
   /api/lead contract are deliberately absent from this object.

   The defaults below reproduce the homepage and /home-value wording
   character for character. A page overrides one by declaring `formCopy`
   in its meta block; tools/check.mjs fails the build if index.html or
   home-value.html ever stop rendering these exact defaults.
   --------------------------------------------------------------------- */
const FORM_COPY_DEFAULTS = {
  formSubject: "Home valuation request",
  formStep1Cta: "Get My Home Value",
  formMicrocopy: "No obligation &middot; Human valuation &middot; Not an automated estimate",
  formSubmitCta: "Send My Valuation Request",
  formSuccessTitle: "Your request is in",
  formSuccessLede:
    "Crystal will personally review your property and follow up with you shortly.",
};

/** Merge a page's formCopy over the defaults, refusing anything unknown -
 *  a typo would otherwise substitute silently to an empty string and ship
 *  a button with no label. */
function formCopyFor(meta, file) {
  const over = meta.formCopy ?? {};
  for (const k of Object.keys(over)) {
    if (!(k in FORM_COPY_DEFAULTS))
      throw new Error(`${file}: unknown formCopy key "${k}" - allowed: ${Object.keys(FORM_COPY_DEFAULTS).join(", ")}`);
    if (typeof over[k] !== "string" || !over[k].trim())
      throw new Error(`${file}: formCopy.${k} must be a non-empty string`);
  }
  return { ...FORM_COPY_DEFAULTS, ...over };
}

const partial = (name) => readFileSync(join(ROOT, "src/partials", name + ".html"), "utf8");
const PARTIALS = Object.fromEntries(
  readdirSync(join(ROOT, "src/partials"))
    .filter((f) => f.endsWith(".html"))
    .map((f) => [basename(f, ".html"), readFileSync(join(ROOT, "src/partials", f), "utf8")])
);

/** Replace {{> name }} includes and {{ var }} tokens, repeatedly, so
 *  partials may themselves contain includes and variables. */
function render(tpl, vars) {
  let out = tpl;
  for (let pass = 0; pass < 6; pass++) {
    const before = out;
    out = out.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (m, n) => {
      if (!(n in PARTIALS)) throw new Error(`Unknown partial: ${n}`);
      return PARTIALS[n];
    });
    out = out.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) =>
      Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : ""
    );
    if (out === before) break;
  }
  return out;
}

/** Pages carry a JSON metadata block in a leading HTML comment. */
function parsePage(raw, file) {
  const m = raw.match(/^\s*<!--\s*meta\s*([\s\S]*?)-->\s*/);
  if (!m) throw new Error(`${file}: missing <!-- meta { ... } --> block`);
  let meta;
  try {
    meta = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`${file}: metadata is not valid JSON — ${e.message}`);
  }
  return { meta, body: raw.slice(m[0].length) };
}

/* ---------------------------------------------------------------------
   Asset fingerprints
   ---------------------------------------------------------------------
   vercel.json serves /assets/* with `max-age=31536000, immutable`, so a
   returning visitor would keep an old stylesheet or, far worse, old form
   JavaScript forever. Appending a content hash makes each deploy a new URL
   the moment the file actually changes, and unchanged files stay cached.
   --------------------------------------------------------------------- */
const assetHash = (rel) =>
  createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex").slice(0, 10);

const ASSET_VERSIONS = {
  css_v: assetHash("assets/css/styles.css"),
  js_v: assetHash("assets/js/main.js"),
};

/* ---------------------------------------------------------------------
   Homepage hero image
   ---------------------------------------------------------------------
   The hero is the primary conversion surface, so a development
   placeholder must never render there. Every other image on the site
   keeps the runtime data-fallback safety net; this one is resolved at
   BUILD time instead:

     photo present -> emit the <img>, fingerprinted, fetchpriority=high
     photo absent  -> emit nothing; the branded ink gradient stands in

   That means no broken image, no placeholder artwork, no layout shift,
   and no JavaScript deciding what the LCP element is. Drop a real
   assets/img/hero-perrysburg.jpg in and the next build picks it up with
   no markup change.
   --------------------------------------------------------------------- */
const HERO_IMAGE = "assets/img/hero-perrysburg.jpg";
const heroImageTag = existsSync(join(ROOT, HERO_IMAGE))
  ? `<img src="/${HERO_IMAGE}?v=${assetHash(HERO_IMAGE)}" alt=""` +
    ` width="1800" height="1200" fetchpriority="high" decoding="async">`
  : "";
if (!heroImageTag) console.log("  i hero photo absent - using the branded gradient");

/* ---------------------------------------------------------------------
   Google Places address autocomplete - OPTIONAL, build-time gated.
   ---------------------------------------------------------------------
   The Maps JS API key is a BROWSER key: it is designed to be public and
   there is no way to use Places autocomplete without shipping it. That is
   fine ONLY because it is restricted in the Google Cloud console (HTTP
   referrer + API restrictions). It is not a secret in the sense the
   HubSpot token is, and it must never be confused for one.

   It is injected here, at build time, rather than living in
   assets/js/main.js, so that:
     - the key is not committed to the repo
     - a fork or a local build simply has no autocomplete
     - rotating the key is a redeploy, not a code change

   With no GOOGLE_MAPS_API_KEY set, NOTHING is emitted and the address
   field stays an ordinary text input that still accepts any address.
   Autocomplete is an enhancement; it is never a requirement for a lead.
   --------------------------------------------------------------------- */
const MAPS_KEY = (process.env.GOOGLE_MAPS_API_KEY || "").trim();

/* Google keys are URL-safe alphanumerics. Anything else is a paste error or
   an injection attempt, and either way must not reach a script tag. */
const MAPS_KEY_OK = /^[A-Za-z0-9_-]{20,80}$/.test(MAPS_KEY);
if (MAPS_KEY && !MAPS_KEY_OK)
  throw new Error("GOOGLE_MAPS_API_KEY is not a plausible Google API key - refusing to emit it");

const mapsLoaderTag = MAPS_KEY_OK
  ? `
<!-- Google Places address autocomplete. Restricted browser key, injected at
     build time. The address field works without this script. -->
<script>
window.__csvMapsReady = new Promise(function (resolve, reject) {
  window.__csvMapsResolve = resolve;
  window.__csvMapsReject = reject;
  setTimeout(reject, 8000);
});
function csvMapsReady() { window.__csvMapsResolve(true); }
</script>
<script async src="https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}&loading=async&callback=csvMapsReady"
        onerror="window.__csvMapsReject()"></script>`
  : "";

if (mapsLoaderTag) console.log("  i Google Places autocomplete enabled");
else console.log("  i no GOOGLE_MAPS_API_KEY - address field stays a plain text input");

/* ---------------------------------------------------------------------
   Google Analytics 4
   ---------------------------------------------------------------------
   A GA4 measurement ID is not a credential - it is public by design and
   identifies the property. It is hardcoded here rather than kept in an
   env var so the site needs no extra configuration step to work.

   What IS gated is WHERE it runs. The tag is emitted only for a Vercel
   PRODUCTION build. Preview deploys and local `npm run dev` emit nothing,
   so test submissions and layout fiddling never land in the numbers
   Crystal will judge her marketing by. Vercel sets VERCEL_ENV itself;
   locally it is unset, which is why the default is off.

   Set GA4_FORCE=1 to emit it anyway when verifying the tag itself.

   assets/js/main.js already forwards every analytics event to gtag when
   gtag exists, so cta_home_value_click, phone_click, lead_form_start,
   lead_submit_success and the rest start reporting with no further work. */
const GA4_ID = (process.env.GA4_MEASUREMENT_ID || "G-GFW8ER1Q85").trim();
if (!/^G-[A-Z0-9]{6,12}$/.test(GA4_ID))
  throw new Error("GA4 measurement ID is not plausible - refusing to emit it: " + GA4_ID);

const GA4_ON = process.env.VERCEL_ENV === "production" || process.env.GA4_FORCE === "1";

const analyticsTag = GA4_ON
  ? `\n<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA4_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${GA4_ID}');
</script>`
  : "";

console.log(GA4_ON
  ? `  i Google Analytics enabled (${GA4_ID})`
  : "  i Google Analytics omitted - not a Vercel production build");

const shell = partial("_shell");
const pagesDir = join(ROOT, "src/pages");
const built = [];

/* Start clean so a renamed or deleted page cannot linger in the output. */
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const file of readdirSync(pagesDir).filter((f) => f.endsWith(".html")).sort()) {
  const { meta, body } = parsePage(readFileSync(join(pagesDir, file), "utf8"), file);
  const slug = meta.slug ?? basename(file, ".html");
  const url = slug === "index" ? `${SITE}/` : `${SITE}/${slug}`;

  const vars = {
    title: meta.title,
    description: meta.description,
    canonical: url,
    ogImage: meta.ogImage ?? `${SITE}/assets/img/og-default.jpg`,
    bodyClass: meta.bodyClass ?? "",
    updated: CONTENT_UPDATED,
    css_v: ASSET_VERSIONS.css_v,
    js_v: ASSET_VERSIONS.js_v,
    heroImage: heroImageTag,
    mapsLoader: mapsLoaderTag,
    analytics: analyticsTag,
    jsonld: meta.jsonld ? `\n<script type="application/ld+json">\n${JSON.stringify(meta.jsonld, null, 2)}\n</script>` : "",
    robots: meta.noindex ? '<meta name="robots" content="noindex, follow">' : "",
    ...formCopyFor(meta, file),
    nav_home: "", nav_sell: "", nav_buy: "", nav_hoods: "", nav_about: "", nav_contact: "",
    content: body.trim(),
  };
  if (meta.nav) vars["nav_" + meta.nav] = ' aria-current="page"';

  const banner = `<!-- Generated by tools/build.mjs from src/pages/${file} — edit the source, then run: npm run build -->\n`;
  const html = banner + render(shell, vars).replace(/\n{3,}/g, "\n\n");

  const outPath = join(OUT, slug + ".html");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  built.push({ slug, url, changefreq: meta.changefreq ?? "monthly", priority: meta.priority ?? 0.6, noindex: !!meta.noindex });
  console.log(`  ✓ ${slug}.html`);
}

/* ---- sitemap.xml ------------------------------------------------------ */
const today = new Date().toISOString().slice(0, 10);
const sitemap =
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  built
    .filter((p) => !p.noindex)
    .map((p) => `  <url>\n    <loc>${p.url}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`)
    .join("\n") +
  `\n</urlset>\n`;
writeFileSync(join(OUT, "sitemap.xml"), sitemap);
console.log(`  ✓ sitemap.xml (${built.filter((p) => !p.noindex).length} urls)`);
/* ---- static passthrough ----------------------------------------------- */
cpSync(join(ROOT, "assets"), join(OUT, "assets"), { recursive: true });
for (const f of ["robots.txt", "site.webmanifest"]) cpSync(join(ROOT, f), join(OUT, f));
console.log("  ✓ assets/, robots.txt, site.webmanifest");

console.log(`\nBuilt ${built.length} pages into public/.`);
