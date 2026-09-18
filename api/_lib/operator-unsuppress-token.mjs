/* Operator unsuppression capability token.
   =====================================================================
   Opposite risk direction from api/_lib/operator-token.mjs, therefore a
   separate secret, key derivation namespace, payload and endpoint.

   The token is a short-lived bearer capability for ONE known phone number
   and ONE sealed lane. It grants no communication permission. It only lets
   a human operator ask the separate unsuppression endpoint to record a
   clearing event after the endpoint has independently re-read the durable
   blocking state and collected the required attestation.

   No browser endpoint mints these tokens. tools/mint-unsuppress-token.mjs
   is the only intended minting surface.
   ===================================================================== */

import {
  createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { toE164 } from "./consent-ledger.mjs";

export const UNSUPPRESS_SECRET_VAR = "OPERATOR_UNSUPPRESS_SECRET";
export const UNSUPPRESS_ACTION_ORIGIN = "https://crystalsellstoledo.com";
export const UNSUPPRESS_ACTION_PATH = "/api/operator-unsuppress";
export const UNSUPPRESS_TOKEN_VERSION = 1;
export const UNSUPPRESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const UNSUPPRESS_MIN_SECRET_BYTES = 32;
export const UNSUPPRESS_MAX_TOKEN_CHARS = 3000;
export const UNSUPPRESS_MAX_URL_BYTES = 4096;
export const UNSUPPRESS_SCOPES = Object.freeze(["sms", "ai_voice", "all"]);

export const UNSUPPRESS_TOKEN_ERROR = Object.freeze({
  NOT_CONFIGURED: "OPERATOR_UNSUPPRESS_NOT_CONFIGURED",
  MISSING: "OPERATOR_UNSUPPRESS_TOKEN_MISSING",
  TOO_LARGE: "OPERATOR_UNSUPPRESS_TOKEN_TOO_LARGE",
  MALFORMED: "OPERATOR_UNSUPPRESS_TOKEN_MALFORMED",
  INVALID: "OPERATOR_UNSUPPRESS_TOKEN_INVALID",
  EXPIRED: "OPERATOR_UNSUPPRESS_TOKEN_EXPIRED",
});

const SAFE_APPROVAL_ID = /^[A-Za-z0-9_-]{8,80}$/;
const SALT = Buffer.from("crystalsellstoledo.operator-unsuppress.v1", "utf8");
const INFO = Buffer.from("operator-unsuppress-token", "utf8");
const AAD_PREFIX = Buffer.from("csto-ou", "utf8");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class UnsuppressTokenError extends Error {
  constructor(token, detail = "") {
    super(detail ? `${token}: ${detail}` : token);
    this.name = "UnsuppressTokenError";
    this.token = token;
    this.detail = detail;
  }
}

function usableSecret(env) {
  const secret = String(env?.[UNSUPPRESS_SECRET_VAR] || "").trim();
  if (Buffer.byteLength(secret, "utf8") < UNSUPPRESS_MIN_SECRET_BYTES) return null;
  return secret;
}

export function operatorUnsuppressConfigured(env = process.env) {
  return usableSecret(env) !== null;
}

function keyFrom(env) {
  const secret = usableSecret(env);
  if (!secret)
    throw new UnsuppressTokenError(
      UNSUPPRESS_TOKEN_ERROR.NOT_CONFIGURED, UNSUPPRESS_SECRET_VAR);
  return Buffer.from(hkdfSync(
    "sha256", Buffer.from(secret, "utf8"), SALT, INFO, 32));
}

function aadFor(version) {
  return Buffer.concat([AAD_PREFIX, Buffer.from([version])]);
}

function b64url(buf) {
  return buf.toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value) {
  const raw = String(value || "");
  if (!/^[A-Za-z0-9_-]+$/.test(raw))
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.MALFORMED, "alphabet");
  const buf = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!buf.length)
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.MALFORMED, "empty");
  return buf;
}

function requireScope(scope) {
  const value = String(scope == null ? "" : scope).trim();
  if (!UNSUPPRESS_SCOPES.includes(value))
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.MALFORMED, "scope");
  return value;
}

function requireApprovalId(value) {
  const id = String(value == null ? "" : value).trim();
  if (!SAFE_APPROVAL_ID.test(id))
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.MALFORMED, "aid");
  return id;
}

function requirePhone(value) {
  try { return toE164(value); }
  catch { throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.MALFORMED, "phone"); }
}

/** Mint a colon-free identifier suitable for dedupeKey(). */
export function mintUnsuppressApprovalId() {
  return randomUUID();
}

export function unsuppressActionUrl(token) {
  return `${UNSUPPRESS_ACTION_ORIGIN}${UNSUPPRESS_ACTION_PATH}?t=${encodeURIComponent(String(token || ""))}`;
}

/** Seal one approval id, one E.164 number and one lane. */
export function sealUnsuppressToken({ approvalId, phone, scope } = {}, {
  env = process.env,
  now = Date.now(),
  ttlMs = UNSUPPRESS_TOKEN_TTL_MS,
} = {}) {
  const aid = requireApprovalId(approvalId);
  const number = requirePhone(phone);
  const lane = requireScope(scope);
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl <= 0)
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.MALFORMED, "ttl");

  const payload = {
    v: UNSUPPRESS_TOKEN_VERSION,
    aid,
    p: number,
    scope: lane,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttl) / 1000),
  };

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(env), nonce);
  cipher.setAAD(aadFor(UNSUPPRESS_TOKEN_VERSION));
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  const token = b64url(Buffer.concat([
    Buffer.from([UNSUPPRESS_TOKEN_VERSION]), nonce, cipher.getAuthTag(), encrypted,
  ]));

  if (token.length > UNSUPPRESS_MAX_TOKEN_CHARS)
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.TOO_LARGE, "token");
  if (Buffer.byteLength(unsuppressActionUrl(token), "utf8") > UNSUPPRESS_MAX_URL_BYTES)
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.TOO_LARGE, "url");
  return token;
}

/** Open a token or fail closed. */
export function unsealUnsuppressToken(token, {
  env = process.env,
  now = Date.now(),
} = {}) {
  const raw = String(token == null ? "" : token).trim();
  if (!raw)
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.MISSING, "t");
  if (raw.length > UNSUPPRESS_MAX_TOKEN_CHARS)
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.TOO_LARGE, "token");

  const buf = fromB64url(raw);
  if (buf.length < 1 + NONCE_BYTES + TAG_BYTES + 2)
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.MALFORMED, "length");
  const version = buf[0];
  if (version !== UNSUPPRESS_TOKEN_VERSION)
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.MALFORMED, "version");

  const nonce = buf.subarray(1, 1 + NONCE_BYTES);
  const tag = buf.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
  const encrypted = buf.subarray(1 + NONCE_BYTES + TAG_BYTES);

  let plain;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFrom(env), nonce);
    decipher.setAAD(aadFor(version));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.INVALID, "tag");
  }

  let payload;
  try { payload = JSON.parse(plain.toString("utf8")); }
  catch { throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.MALFORMED, "payload"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.MALFORMED, "payload");
  if (payload.v !== UNSUPPRESS_TOKEN_VERSION)
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.MALFORMED, "v");

  const aid = requireApprovalId(payload.aid);
  const phone = requirePhone(payload.p);
  const scope = requireScope(payload.scope);
  const exp = Number(payload.exp);
  const issuedAt = Number(payload.iat);
  if (!Number.isFinite(exp) || !Number.isFinite(issuedAt))
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.MALFORMED, "time");
  if (now >= exp * 1000)
    throw new UnsuppressTokenError(UNSUPPRESS_TOKEN_ERROR.EXPIRED, "exp");

  return {
    v: UNSUPPRESS_TOKEN_VERSION,
    approvalId: aid,
    phone,
    scope,
    issuedAt,
    expiresAt: exp,
  };
}

export function matchesUnsuppressLiteral(provided, expected) {
  const a = Buffer.from(String(provided == null ? "" : provided), "utf8");
  const b = Buffer.from(String(expected == null ? "" : expected), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function unsuppressTokenLogShape(err) {
  if (!(err instanceof UnsuppressTokenError))
    return { unsuppress_token_error: "unknown" };
  return {
    unsuppress_token_error: err.token,
    ...(err.detail ? { unsuppress_token_field: err.detail } : {}),
  };
}
