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

export function rateLimit(key, now = Date.now()) {
  const win = (hits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (win.length >= RATE_MAX) {
    hits.set(key, win);
    return { allowed: false, retryAfter: Math.ceil((RATE_WINDOW_MS - (now - win[0])) / 1000) };
  }
  win.push(now);
  hits.set(key, win);
  if (hits.size > 5000) hits.clear(); // crude ceiling on memory growth
  return { allowed: true };
}

export function _resetRateLimit() { hits.clear(); }

export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

/** Hosts permitted to submit. Configurable so preview deploys work. */
export function allowedHosts() {
  const extra = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set([
    "crystalsellstoledo.com",
    "www.crystalsellstoledo.com",
    "localhost",
    "127.0.0.1",
    ...extra,
  ]);
}

function hostOf(value) {
  if (!value) return null;
  try { return new URL(value).hostname.toLowerCase(); } catch { return null; }
}

/**
 * Same-origin check. A missing Origin is tolerated (some privacy tools
 * strip it) but a *present and foreign* Origin is refused.
 */
export function originAllowed(req) {
  const allow = allowedHosts();
  const origin = hostOf(req.headers.origin);
  if (origin) return allow.has(origin) || origin.endsWith(".vercel.app");
  const ref = hostOf(req.headers.referer);
  if (ref) return allow.has(ref) || ref.endsWith(".vercel.app");
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
