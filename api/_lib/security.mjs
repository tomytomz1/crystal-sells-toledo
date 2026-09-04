/* Transport-level guards. Everything here runs before validation and
   before any outbound call, so a hostile request costs as little as
   possible. */

export const MAX_BODY_BYTES = 16 * 1024;

/* Sliding-window limiter held in module scope. Vercel may run several
   warm instances, so this is a floor rather than a ceiling — it stops
   naive floods from one instance cheaply and with no dependencies. For a
   hard global limit, move the store to Vercel KV / Upstash; see README. */
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const hits = new Map();

/* Drop every key whose last hit has aged out.

   This is LAZY cleanup: it runs from a request, never from a timer. There is
   deliberately no setInterval here - on a serverless instance a live timer
   keeps the process referenced and fires on instances that are handling no
   traffic. The consequence is the honest one, and the privacy notice says it:
   an expired address is cleared by a later request or when the instance ends,
   NOT at a guaranteed moment. Do not restore any wording promising deletion on
   a fixed schedule. */
function sweep(now) {
  for (const [k, times] of hits) {
    const live = times.filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length) hits.set(k, live);
    else hits.delete(k);
  }
}

export function rateLimit(key, now = Date.now()) {
  /* Every call, not on an interval. The earlier version only swept when a
     window had elapsed since the last sweep, which left expired keys behind
     for any staggered arrival pattern: A at t, B at t+599,999, C at t+600,000,
     D at t+1,199,999 retained three keys when only two were live. The map is
     capped at 5000 entries, so an unconditional pass is cheap. */
  sweep(now);

  const win = (hits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (win.length >= RATE_MAX) {
    hits.set(key, win);
    return { allowed: false, retryAfter: Math.ceil((RATE_WINDOW_MS - (now - win[0])) / 1000) };
  }
  win.push(now);
  hits.set(key, win);
  if (hits.size > 5000) hits.clear(); // every entry here is already live
  return { allowed: true };
}

export function _resetRateLimit() { hits.clear(); }

/* Test seam: how many addresses the limiter is currently holding. */
export function _rateLimitSize() { return hits.size; }

export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

/**
 * Hosts permitted to submit.
 *
 * `*.vercel.app` used to be accepted as a suffix so preview deploys worked.
 * That let ANY vercel.app hostname - including someone else's project, which
 * anyone can create in seconds - past this check.
 *
 * Vercel names this deployment for us instead, so preview deploys keep
 * working without opening the whole shared domain:
 *
 *   VERCEL_URL         the immutable deployment hostname
 *   VERCEL_BRANCH_URL  the generated branch hostname pointing at the latest
 *                      successful deployment from this branch
 *
 * Both are admitted, and only whichever values Vercel actually set for THIS
 * deployment - a sibling branch or another project gets different strings and
 * is still refused. Anything else goes in ALLOWED_ORIGINS by name.
 */
export function allowedHosts() {
  const extra = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set([
    "crystalsellstoledo.com",
    "www.crystalsellstoledo.com",
    "localhost",
    "127.0.0.1",
    ...["VERCEL_URL", "VERCEL_BRANCH_URL"].map((v) => envHost(v)).filter(Boolean),
    ...extra,
  ]);
}

/**
 * Read a Vercel-supplied hostname from the environment.
 *
 * These arrive as bare hostnames, not URLs, so the value is lowercased and
 * used as given; one that somehow carries a scheme or a path is normalised
 * through the same parser as the request header rather than trusted as-is.
 */
function envHost(name) {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (!raw) return null;
  return raw.includes("://") ? hostOf(raw) : raw.split("/")[0] || null;
}

function hostOf(value) {
  if (!value) return null;
  try { return new URL(value).hostname.toLowerCase(); } catch { return null; }
}

/**
 * Same-origin check. A missing Origin is tolerated (some privacy tools
 * strip it) but a *present and foreign* Origin is refused.
 *
 * This is CSRF hygiene, not authentication: a header is trivially forged by
 * anything that is not a browser, so nothing downstream may treat a passing
 * Origin as proof of anything. It exists to stop a page on another site from
 * driving a visitor's browser into posting here.
 */
export function originAllowed(req) {
  const allow = allowedHosts();
  const origin = hostOf(req.headers.origin);
  if (origin) return allow.has(origin);
  const ref = hostOf(req.headers.referer);
  if (ref) return allow.has(ref);
  return true;
}

/** Read the body with a hard byte cap, rejecting oversize before parsing. */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > MAX_BODY_BYTES) return reject(new Error("PAYLOAD_TOO_LARGE"));
    if (req.body !== undefined && req.body !== null) {
      const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return reject(new Error("PAYLOAD_TOO_LARGE"));
      return resolve(raw);
    }
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("PAYLOAD_TOO_LARGE")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
