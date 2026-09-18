/* Authoritative build entry point for the Turnstile feature flag.
 *
 * tools/build.mjs already knows how to render a configured widget. This
 * wrapper owns activation: TURNSTILE_ENABLED=false must remain inert even if
 * keys are still stored in Vercel, while TURNSTILE_ENABLED=true with missing
 * configuration must refuse the deployment rather than ship a broken form.
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readTurnstileConfig,
  TURNSTILE_STATES,
} from "../api/_lib/turnstile-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");

export function prepareTurnstileBuildEnv(env = process.env) {
  const config = readTurnstileConfig(env);

  if (config.state === TURNSTILE_STATES.DISABLED) {
    /* Keys may intentionally remain stored for rollback/reenablement. Remove
       them only from THIS build process so the legacy renderer cannot mistake
       stored credentials for activation. */
    delete env.TURNSTILE_SITE_KEY;
    delete env.TURNSTILE_SECRET_KEY;
    return config;
  }

  if (config.state === TURNSTILE_STATES.MISCONFIGURED) {
    throw new Error(
      `TURNSTILE_ENABLED requests protection but configuration is invalid (${config.reason}). ` +
      "Refusing to build."
    );
  }

  return config;
}

const PRECONNECT_RE = /\n?<link rel="preconnect" href="https:\/\/challenges\.cloudflare\.com">/g;
const LOADER_RE = /\n?<!-- Cloudflare Turnstile\. Public sitekey,[\s\S]*?<script src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit&onload=csvTurnstileReady"[\s\S]*?<\/script>/g;

/** Remove Turnstile network/bootstrap markup from a page that has no lead form. */
export function stripTurnstileFromNonFormPage(html) {
  if (String(html).includes("data-turnstile")) return String(html);
  return String(html).replace(PRECONNECT_RE, "").replace(LOADER_RE, "");
}

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...htmlFiles(path));
    else if (name.endsWith(".html")) out.push(path);
  }
  return out;
}

export function limitTurnstileToLeadPages(publicDir = PUBLIC) {
  let stripped = 0;
  for (const file of htmlFiles(publicDir)) {
    const before = readFileSync(file, "utf8");
    const after = stripTurnstileFromNonFormPage(before);
    if (after !== before) {
      writeFileSync(file, after);
      stripped++;
    }
  }
  return stripped;
}

export async function main(env = process.env) {
  const config = prepareTurnstileBuildEnv(env);
  await import("./build.mjs");

  if (config.state === TURNSTILE_STATES.ENABLED) {
    const stripped = limitTurnstileToLeadPages();
    console.log(`  i Turnstile loader limited to lead-form pages (${stripped} non-form page(s) stripped)`);
  }
}

const invokedDirectly = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
