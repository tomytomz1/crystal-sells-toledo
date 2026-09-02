/* =====================================================================
   Post-deploy check. Run: npm run verify:live

   Everything else in this repo is verified offline against public/, which
   is exactly how the site shipped for months declaring a canonical origin
   that did not exist. www.crystalsellstoledo.com was never registered on
   the Vercel project: it resolved to Vercel, was handed a fallback
   certificate that did not carry the name, and every browser refused it.
   Nine pages of canonical tags, og:url, the JSON-LD graph, sitemap.xml and
   robots.txt all pointed there. No static check could have caught it -
   nothing in the build knows which hostnames the deployment serves.

   This one asks the deployment. It reads the origin the BUILD calls
   canonical, then fetches it and demands that it actually serve the site:
   a valid certificate, 200 rather than a redirect, and a sitemap and
   robots that agree with it. It also checks the sibling hostname, since a
   dead or non-redirecting www is the specific failure that got through.

   Not part of `npm test`. The release gate must not depend on a live third
   party, and CI has nothing deployed to point at. Run it after a
   production deploy goes Ready.
   ===================================================================== */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const TIMEOUT_MS = 15000;
const UA = "crystal-sells-toledo-verify-live";

const errors = [];
const warnings = [];
const notes = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const ok = (m) => notes.push(m);

/* --- what does the build call canonical? ------------------------------ */
let index;
try {
  index = readFileSync(join(ROOT, "index.html"), "utf8");
} catch {
  fail("public/index.html is missing — run `npm run build` first");
  report();
}

const canonical = index.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
if (!canonical) {
  fail("public/index.html carries no <link rel=\"canonical\"> to check against");
  report();
}

const override = process.argv[2];
const origin = new URL(override || canonical).origin;
if (override) {
  ok(`checking ${origin} instead of the origin the build calls canonical`);
}
ok(`build declares canonical origin ${new URL(canonical).origin}`);

/* --- fetch, without following redirects or masking TLS failures ------- */
async function get(url) {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { res, body: res.status < 400 ? await res.text() : "" };
  } catch (err) {
    /* A certificate that does not carry the hostname lands here, and so
       does a name that does not resolve. Both are the failure this check
       exists for, so neither may be swallowed. */
    return { error: err.cause?.code || err.code || err.name || String(err) };
  }
}

/* --- 1. the canonical origin must serve the site --------------------- */
const home = await get(origin + "/");
if (home.error) {
  fail(`${origin}/ could not be fetched (${home.error}) — the canonical origin does not serve this site`);
} else if (home.res.status >= 300 && home.res.status < 400) {
  fail(`${origin}/ returned ${home.res.status} to ${home.res.headers.get("location")} — a canonical origin must be the final URL, never a redirect`);
} else if (home.res.status !== 200) {
  fail(`${origin}/ returned ${home.res.status}`);
} else {
  ok(`${origin}/ serves 200${origin.startsWith("https:") ? " over a valid certificate" : ""}`);

  const live = home.body.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
  if (!live) fail(`${origin}/ serves no canonical link`);
  else if (new URL(live).origin !== origin)
    fail(`${origin}/ declares its canonical as ${live} — the deployed page disagrees with the origin serving it`);
  else ok(`the served page's canonical agrees: ${live}`);
}

/* --- 2. sitemap.xml must exist and list only this origin -------------- */
const sitemap = await get(origin + "/sitemap.xml");
if (sitemap.error) fail(`${origin}/sitemap.xml could not be fetched (${sitemap.error})`);
else if (sitemap.res.status !== 200) fail(`${origin}/sitemap.xml returned ${sitemap.res.status}`);
else {
  const locs = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (!locs.length) fail(`${origin}/sitemap.xml lists no URLs`);
  else {
    const foreign = [...new Set(locs.map((l) => new URL(l).origin))].filter((o) => o !== origin);
    if (foreign.length)
      fail(`${origin}/sitemap.xml lists URLs on ${foreign.join(", ")} — a sitemap may only list URLs on its own origin`);
    else ok(`sitemap.xml lists ${locs.length} URLs, all on ${origin}`);
  }
}

/* --- 3. robots.txt must point at that sitemap ------------------------- */
const robots = await get(origin + "/robots.txt");
if (robots.error) fail(`${origin}/robots.txt could not be fetched (${robots.error})`);
else if (robots.res.status !== 200) fail(`${origin}/robots.txt returned ${robots.res.status}`);
else {
  const declared = robots.body.match(/^\s*Sitemap:\s*(\S+)/im)?.[1];
  if (!declared) warn(`${origin}/robots.txt declares no Sitemap:`);
  else if (new URL(declared).origin !== origin)
    fail(`${origin}/robots.txt points at ${declared} — a different origin from the one serving it`);
  else ok(`robots.txt points at ${declared}`);
}

/* --- 4. the sibling hostname must redirect here, not break ------------ */
const { hostname: host, protocol, port } = new URL(origin);
const sibling = host.startsWith("www.") ? host.slice(4) : "www." + host;
const siblingOrigin = `${protocol}//${sibling}${port ? ":" + port : ""}`;
const sib = await get(siblingOrigin + "/");
if (sib.error) {
  fail(`${siblingOrigin}/ could not be fetched (${sib.error}) — visitors who type it get a browser security warning, not the site. Register it on the host and redirect it here.`);
} else if (sib.res.status >= 300 && sib.res.status < 400) {
  const to = sib.res.headers.get("location") || "";
  if (to && new URL(to, siblingOrigin).origin === origin)
    ok(`${siblingOrigin}/ redirects ${sib.res.status} to ${origin}`);
  else fail(`${siblingOrigin}/ redirects ${sib.res.status} to ${to}, not to ${origin}`);
} else if (sib.res.status === 200) {
  warn(`${siblingOrigin}/ serves the site directly instead of redirecting to ${origin} — two hostnames serving the same pages splits them for crawlers`);
} else {
  warn(`${siblingOrigin}/ returned ${sib.res.status}`);
}

report();

function report() {
  for (const n of notes) console.log("  ✓ " + n);
  if (warnings.length) {
    console.log("\nWarnings:");
    for (const w of warnings) console.log("  ! " + w);
  }
  if (errors.length) {
    console.log("\nErrors:");
    for (const e of errors) console.log("  ✗ " + e);
    console.log(`\n${errors.length} error(s), ${warnings.length} warning(s).`);
    process.exit(1);
  }
  console.log(`\n✓ live site agrees with the build. ${warnings.length} warning(s).`);
  process.exit(0);
}
