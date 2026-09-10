/* Twilio inbound webhook: request authentication only.
 *
 * This module decides ONE thing — did Twilio send this request? It parses
 * no meaning out of the body, classifies nothing, and writes nowhere. That
 * separation is the point: everything downstream may assume the request is
 * authentic, and nothing downstream has to remember to check.
 *
 * Gate 7 design: docs/updates/2026-09-10-stop-dnc-suppression-decision.md §2.8.
 *
 * NOTHING HERE MAY LOG. Not the signature, not the token, not the body,
 * not a parameter. The body is a consumer's message and the token is a
 * credential; the caller logs a classification and never a value.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const TWILIO_TOKEN_VAR = "TWILIO_AUTH_TOKEN";

/** Stable, PII-free refusal reasons. Safe to log; safe to return as a code. */
export const TWILIO_NOT_CONFIGURED = "TWILIO_NOT_CONFIGURED";
export const TWILIO_SIGNATURE_MISSING = "TWILIO_SIGNATURE_MISSING";
export const TWILIO_SIGNATURE_INVALID = "TWILIO_SIGNATURE_INVALID";
export const TWILIO_URL_UNRESOLVABLE = "TWILIO_URL_UNRESOLVABLE";

/** True when an auth token is present to verify against. */
export function twilioConfigured(env = process.env) {
  return Boolean(String(env[TWILIO_TOKEN_VAR] || "").trim());
}

/* ---------------------------------------------------------------------
   THE URL
   ---------------------------------------------------------------------
   Twilio signs the URL IT REQUESTED. Inside a Vercel function the request
   object does not carry that URL: `req.url` is a path, and the host the
   process sees is not necessarily the host Twilio addressed. So it is
   rebuilt from the forwarded headers.

   The design document names this the single most likely thing to get
   subtly wrong, and it is: a scheme or host that differs by one character
   produces a different HMAC and every legitimate webhook is refused. That
   failure is loud and closed, which is the direction to fail in — but it
   is worth recognising on sight, hence TWILIO_URL_UNRESOLVABLE.

   A forwarded header is attacker-controlled in general. Here that does not
   help an attacker: they would have to make the signature verify, and the
   signature is over the URL they would be choosing. Getting it wrong
   yields a mismatch; getting it "right" requires the auth token, which is
   the thing being proved.
   --------------------------------------------------------------------- */
export function requestUrl(req) {
  const h = req?.headers || {};
  const first = (value) => String(Array.isArray(value) ? value[0] : value || "")
    .split(",")[0].trim();

  const proto = first(h["x-forwarded-proto"]) || "https";
  const host = first(h["x-forwarded-host"]) || first(h.host);
  if (!host) return "";

  const path = String(req?.url || "/");
  /* Twilio signs the URL including its query string, so `req.url` is used
     whole rather than being split. */
  return proto + "://" + host + (path.startsWith("/") ? path : "/" + path);
}

/* ---------------------------------------------------------------------
   THE SIGNATURE
   ---------------------------------------------------------------------
   Twilio's scheme: take the full URL, then for every POST parameter in
   ASCII order by key, append the key immediately followed by its value.
   HMAC-SHA1 that string with the account auth token, base64 the digest.

   Sorting is by KEY over the raw key strings. Values are appended with no
   separator at all — a detail that looks like a bug and is not.
   --------------------------------------------------------------------- */
export function signatureBase(url, params) {
  let data = String(url);
  for (const key of Object.keys(params || {}).sort())
    data += key + String(params[key] == null ? "" : params[key]);
  return data;
}

export function computeSignature(url, params, token) {
  return createHmac("sha1", String(token))
    .update(Buffer.from(signatureBase(url, params), "utf8"))
    .digest("base64");
}

/** Constant-time compare. A `===` on a signature is a timing oracle. */
function sameSignature(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  /* timingSafeEqual throws on a length mismatch, which would itself leak
     length through the exception path, so length is checked first and the
     comparison is still run against a same-length buffer to keep the work
     constant for any input that reaches here. */
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify an inbound Twilio request.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason }` — it never throws, so
 * a caller cannot accidentally treat an exception path as success.
 *
 * `params` must be the parsed form parameters. Twilio signs the
 * parameters, not the raw byte stream, which is why the caller may parse
 * the form encoding first: form-decoding is not interpretation, and the
 * classification that IS interpretation happens only after this returns.
 */
export function verifyTwilioSignature(req, params, { env = process.env } = {}) {
  const token = String(env[TWILIO_TOKEN_VAR] || "").trim();
  if (!token) return { ok: false, reason: TWILIO_NOT_CONFIGURED };

  const header = req?.headers?.["x-twilio-signature"];
  const provided = String(Array.isArray(header) ? header[0] : header || "").trim();
  if (!provided) return { ok: false, reason: TWILIO_SIGNATURE_MISSING };

  const url = requestUrl(req);
  if (!url) return { ok: false, reason: TWILIO_URL_UNRESOLVABLE };

  const expected = computeSignature(url, params, token);
  if (!sameSignature(provided, expected))
    return { ok: false, reason: TWILIO_SIGNATURE_INVALID };

  return { ok: true };
}

/* ---------------------------------------------------------------------
   THE BODY
   ---------------------------------------------------------------------
   Twilio posts `application/x-www-form-urlencoded`. Vercel may hand the
   handler a pre-parsed object, a string, or neither, so all three are
   handled — and the byte cap is applied in every case, before anything is
   decoded.
   --------------------------------------------------------------------- */
export const MAX_WEBHOOK_BYTES = 16 * 1024;

export function parseFormParams(raw) {
  const params = {};
  for (const [key, value] of new URLSearchParams(String(raw || "")))
    /* Last value wins for a repeated key, matching URLSearchParams->object
       conventions. Twilio does not repeat keys. */
    params[key] = value;
  return params;
}

/** Read and form-decode the request body, refusing anything oversize. */
export function readFormBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req?.headers?.["content-length"] || 0);
    if (declared > MAX_WEBHOOK_BYTES) return reject(new Error("PAYLOAD_TOO_LARGE"));

    if (req?.body !== undefined && req?.body !== null) {
      if (typeof req.body === "string") {
        if (Buffer.byteLength(req.body) > MAX_WEBHOOK_BYTES)
          return reject(new Error("PAYLOAD_TOO_LARGE"));
        return resolve(parseFormParams(req.body));
      }
      /* Already an object: use it as-is. Re-encoding it to a string and
         re-parsing would risk changing the very bytes the signature
         covers. */
      const flat = {};
      for (const [k, v] of Object.entries(req.body)) flat[k] = String(v == null ? "" : v);
      return resolve(flat);
    }

    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_WEBHOOK_BYTES) {
        reject(new Error("PAYLOAD_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(parseFormParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

/* ---------------------------------------------------------------------
   OptOutType
   ---------------------------------------------------------------------
   Present only when Advanced Opt-Out is enabled on the Messaging Service.
   Where it is present it is AUTHORITATIVE: it is a statement about what
   Twilio actually did to the number, and re-deriving that from the message
   body risks our record disagreeing with the system doing the blocking.

   Enabling Advanced Opt-Out is itself a Messaging Service configuration
   change, and Twilio configuration is frozen while the TCR hold on error
   30753 is open — so the parameter will usually be ABSENT and everything
   here must behave correctly when it is.
   --------------------------------------------------------------------- */
export const OPT_OUT_TYPE = Object.freeze({
  STOP: "STOP",
  START: "START",
  HELP: "HELP",
});

export function optOutType(params) {
  const raw = String(params?.OptOutType || "").trim().toUpperCase();
  return OPT_OUT_TYPE[raw] || null;
}
