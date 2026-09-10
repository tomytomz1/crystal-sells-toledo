/* The operator action's sealed token.
   =====================================================================
   ONE job: turn (MessageSid, consumer number, consumer message) into an
   opaque string that can travel in a link inside an email, and turn it
   back — or refuse.

   WHY SEALED AND NOT SIGNED
   -------------------------
   A signed plaintext token would put a consumer's phone number and words
   in a URL, and A URL IS A LOG LINE: Vercel records request paths, the
   browser records history, and a referrer can carry one to a third party.
   api/_lib/log.mjs redacts `phone` for exactly this reason, and
   tools/check.mjs fails the build if the message body reaches log(). So
   the URL carries ciphertext and the plaintext exists only inside this
   function's memory, for the duration of one request.

   AES-256-GCM, from node:crypto. No new dependency, and the tag makes
   authentication and confidentiality the same operation — there is no way
   to accept a tampered token and no separate "verify" step to forget.

   WHAT THIS MODULE IS NOT
   -----------------------
   It is not an authorisation system. Holding the token is the whole
   authority, and that authority is exactly one thing: record a `revoked`
   event for ONE MessageSid. It cannot clear a suppression, read the
   ledger, reach the CRM or send anything — see the threat model in
   docs/updates/2026-09-10-unclassified-inbound-operator-surfacing-decision.md §6.7.

   It also names no ledger table, column or connection string. The write
   belongs to api/_lib/consent-ledger.mjs and stays there.
   ===================================================================== */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/** The only secret this endpoint has. Absent => the endpoint is inert. */
export const OPERATOR_SECRET_VAR = "OPERATOR_ACTION_SECRET";

/* The public origin the link points at. A CONSTANT, not a variable, for
   the same reason api/_lib/mail.mjs pins FROM_ADDRESS: one site, one
   domain, and a variable would be one more thing to get wrong in an
   environment where getting it wrong means a link that does not work. */
export const ACTION_ORIGIN = "https://crystalsellstoledo.com";
export const ACTION_PATH = "/api/operator-action";

/** Payload shape version. Written into the sealed bytes AND the AAD. */
export const TOKEN_VERSION = 1;

/* Thirty days. A TRADE-OFF, not a safety property: long enough that a
   message read late is still actionable, short enough that a forwarded
   year-old email is not a live capability. */
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* ---------------------------------------------------------------------
   SIZE — A HARD BOUND, NOT AN ARITHMETIC ARGUMENT
   ---------------------------------------------------------------------
   The decision document estimated the worst-case URL at ~1.6 KB from the
   1 KB evidence cap plus base64 expansion, and said to budget 4 KB and
   MEASURE rather than trust the sum. Estimates of this kind are how a
   header-limit failure reaches production: they are correct until a field
   is added.

   So both bounds are enforced in code. sealOperatorToken() refuses to
   emit a URL over MAX_ACTION_URL_BYTES, and unsealOperatorToken() refuses
   an oversized token BEFORE any decryption, so a large hostile input
   costs a length comparison and not a cipher pass.
   --------------------------------------------------------------------- */
export const MAX_ACTION_URL_BYTES = 4096;
export const MAX_TOKEN_CHARS = 3000;

/* Stable, PII-free refusal reasons. Safe to log and safe to show. */
export const OPERATOR_NOT_CONFIGURED = "OPERATOR_ACTION_NOT_CONFIGURED";
export const TOKEN_MISSING = "OPERATOR_TOKEN_MISSING";
export const TOKEN_TOO_LARGE = "OPERATOR_TOKEN_TOO_LARGE";
export const TOKEN_MALFORMED = "OPERATOR_TOKEN_MALFORMED";
export const TOKEN_INVALID = "OPERATOR_TOKEN_INVALID";
export const TOKEN_EXPIRED = "OPERATOR_TOKEN_EXPIRED";

export class OperatorTokenError extends Error {
  constructor(token, detail = "") {
    /* `detail` names a FIELD or a reason class, never a value. Nothing
       derived from the ciphertext, the key or the payload appears here. */
    super(detail ? `${token}: ${detail}` : token);
    this.name = "OperatorTokenError";
    this.token = token;
    this.detail = detail;
  }
}

/** True when the endpoint has a key to seal and unseal with. */
export function operatorActionConfigured(env = process.env) {
  return Boolean(String(env[OPERATOR_SECRET_VAR] || "").trim());
}

/* ---------------------------------------------------------------------
   THE KEY
   ---------------------------------------------------------------------
   HKDF-SHA256 over the configured secret, with a fixed salt and info, so
   the secret may be any length and any character set an operator can
   paste into Vercel without the cipher caring. Deterministic: the same
   secret always yields the same key, which is what lets a link sealed by
   one deployment be opened by the next.

   The info string binds the key to THIS use. A future second use of the
   same secret must derive with a different info string or it is the same
   key twice, which is how one capability quietly becomes another.
   --------------------------------------------------------------------- */
const KEY_SALT = Buffer.from("crystalsellstoledo.operator-action.v1", "utf8");
const KEY_INFO = Buffer.from("operator-action-token", "utf8");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function keyFrom(env) {
  const secret = String(env[OPERATOR_SECRET_VAR] || "").trim();
  if (!secret) throw new OperatorTokenError(OPERATOR_NOT_CONFIGURED, OPERATOR_SECRET_VAR);
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), KEY_SALT, KEY_INFO, 32));
}

/* Additional authenticated data. The version byte travels in the clear at
   the front of the token, so it is bound here too — otherwise an attacker
   could relabel a v1 token as v2 and have the tag still verify. */
function aadFor(version) {
  return Buffer.concat([Buffer.from("csto-oa", "utf8"), Buffer.from([version])]);
}

function toBase64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  const s = String(value);
  /* Whitelisted rather than filtered: anything outside the base64url
     alphabet is a refusal, not a character to strip. Stripping is how a
     mangled token becomes a different valid token. */
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new OperatorTokenError(TOKEN_MALFORMED, "alphabet");
  const buf = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!buf.length) throw new OperatorTokenError(TOKEN_MALFORMED, "empty");
  return buf;
}

/* ---------------------------------------------------------------------
   SEALING
   ---------------------------------------------------------------------
   `body` MUST already be capped by the ledger's own capEvidence() rule
   before it arrives here. That is not this module's job to do and is
   deliberately not done here: the words written to the ledger must be
   byte-identical to the words the operator read in the email, so exactly
   one function may decide where they are cut.
   --------------------------------------------------------------------- */

/**
 * Seal one message into an opaque base64url string.
 *
 * Throws OperatorTokenError — never returns a partial or unsealed value.
 */
export function sealOperatorToken({ sid, phone, body } = {}, {
  env = process.env, now = Date.now(), ttlMs = TOKEN_TTL_MS,
} = {}) {
  const messageSid = String(sid == null ? "" : sid).trim();
  const number = String(phone == null ? "" : phone).trim();
  if (!messageSid) throw new OperatorTokenError(TOKEN_MALFORMED, "sid");
  if (!number) throw new OperatorTokenError(TOKEN_MALFORMED, "phone");
  /* A colon in the MessageSid would let two different events produce one
     dedupe key downstream. dedupeKey() refuses one; refusing it here means
     the failure happens while the email is being built rather than after
     the operator has clicked. */
  if (messageSid.includes(":")) throw new OperatorTokenError(TOKEN_MALFORMED, "sid");

  const payload = {
    v: TOKEN_VERSION,
    sid: messageSid,
    p: number,
    b: String(body == null ? "" : body),
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000),
  };

  const key = keyFrom(env);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aadFor(TOKEN_VERSION));
  const sealed = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const token = toBase64Url(
    Buffer.concat([Buffer.from([TOKEN_VERSION]), nonce, tag, sealed]));

  if (token.length > MAX_TOKEN_CHARS)
    throw new OperatorTokenError(TOKEN_TOO_LARGE, "token");
  const url = operatorActionUrl(token);
  if (Buffer.byteLength(url, "utf8") > MAX_ACTION_URL_BYTES)
    throw new OperatorTokenError(TOKEN_TOO_LARGE, "url");

  return token;
}

/** The link that goes in the email. */
export function operatorActionUrl(token) {
  return `${ACTION_ORIGIN}${ACTION_PATH}?t=${encodeURIComponent(String(token || ""))}`;
}

/**
 * Open a sealed token, or throw.
 *
 * Order matters: presence, then size, then alphabet, then structure, then
 * the tag, then expiry. Everything cheap and everything that cannot leak
 * happens before the cipher runs.
 */
export function unsealOperatorToken(token, { env = process.env, now = Date.now() } = {}) {
  const raw = String(token == null ? "" : token).trim();
  if (!raw) throw new OperatorTokenError(TOKEN_MISSING, "t");
  if (raw.length > MAX_TOKEN_CHARS) throw new OperatorTokenError(TOKEN_TOO_LARGE, "token");

  const key = keyFrom(env);
  const buf = fromBase64Url(raw);
  if (buf.length < 1 + NONCE_BYTES + TAG_BYTES + 2)
    throw new OperatorTokenError(TOKEN_MALFORMED, "length");

  const version = buf[0];
  if (version !== TOKEN_VERSION) throw new OperatorTokenError(TOKEN_MALFORMED, "version");

  const nonce = buf.subarray(1, 1 + NONCE_BYTES);
  const tag = buf.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
  const sealed = buf.subarray(1 + NONCE_BYTES + TAG_BYTES);

  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aadFor(version));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(sealed), decipher.final()]);
  } catch {
    /* A wrong key and a flipped bit are the same answer, deliberately.
       Nothing about WHY it failed is knowable to the caller, because
       nothing about why is safe to tell. */
    throw new OperatorTokenError(TOKEN_INVALID, "tag");
  }

  let payload;
  try {
    payload = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new OperatorTokenError(TOKEN_MALFORMED, "payload");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new OperatorTokenError(TOKEN_MALFORMED, "payload");
  if (payload.v !== TOKEN_VERSION) throw new OperatorTokenError(TOKEN_MALFORMED, "v");

  const sid = String(payload.sid == null ? "" : payload.sid).trim();
  const phone = String(payload.p == null ? "" : payload.p).trim();
  if (!sid || sid.includes(":")) throw new OperatorTokenError(TOKEN_MALFORMED, "sid");
  if (!phone) throw new OperatorTokenError(TOKEN_MALFORMED, "p");

  const exp = Number(payload.exp);
  if (!Number.isFinite(exp)) throw new OperatorTokenError(TOKEN_MALFORMED, "exp");
  /* Expiry is checked AFTER the tag, so an expired token and a forged one
     are not distinguishable by anyone who cannot already open it. */
  if (now >= exp * 1000) throw new OperatorTokenError(TOKEN_EXPIRED, "exp");

  return {
    v: TOKEN_VERSION,
    sid,
    phone,
    body: typeof payload.b === "string" ? payload.b : "",
    issuedAt: Number(payload.iat) || 0,
    expiresAt: exp,
  };
}

/** Constant-time compare for the confirmation literal. */
export function matchesLiteral(provided, expected) {
  const a = Buffer.from(String(provided == null ? "" : provided), "utf8");
  const b = Buffer.from(String(expected == null ? "" : expected), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A PII-free line for logs: the reason, never the token or the payload. */
export function tokenLogShape(err) {
  if (!(err instanceof OperatorTokenError)) return { token_error: "unknown" };
  return { token_error: err.token, ...(err.detail ? { token_field: err.detail } : {}) };
}
