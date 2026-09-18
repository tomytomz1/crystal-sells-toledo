/* Cloudflare Turnstile server-side verification for POST /api/lead.
 *
 * The browser widget is not the security boundary. This module redeems the
 * token with Cloudflare and binds a successful token to this site's hostname
 * and to the form_type that minted it. It never returns or logs the token.
 */

import { allowedHosts } from "./security.mjs";
import {
  readTurnstileConfig,
  TURNSTILE_STATES,
  TURNSTILE_CONFIG_REASONS,
  turnstileGateRequested,
} from "./turnstile-config.mjs";

export const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const MAX_TOKEN_CHARS = 2048;
export const TURNSTILE_TIMEOUT_MS = 5000;

export const REASONS = Object.freeze({
  MISSING: "missing_token",
  MALFORMED: "malformed_token",
  REJECTED: "verification_failed",
  HOSTNAME: "hostname_mismatch",
  ACTION: "action_mismatch",
  TIMEOUT: "verification_timeout",
  UNVERIFIED: "verification_unavailable",
  CONFIGURATION: "configuration_error",
});

/* Kept as the handler-facing predicate for compatibility. Importantly this is
 * true for BOTH an enabled gate and an explicitly requested-but-misconfigured
 * gate. That makes misconfiguration fail closed instead of silently skipping
 * verification. TURNSTILE_ENABLED=false is the only normal bypass. */
export function turnstileEnabled() {
  return turnstileGateRequested();
}

export function turnstileState() {
  return readTurnstileConfig().state;
}

const TOKEN_FAULT_CODES = new Set([
  "missing-input-response",
  "invalid-input-response",
  "timeout-or-duplicate",
]);
const CONFIG_FAULT_CODES = new Set([
  "missing-input-secret",
  "invalid-input-secret",
]);
const SERVICE_FAULT_CODES = new Set([
  "bad-request",
  "internal-error",
]);
const KNOWN_CODES = new Set([
  ...TOKEN_FAULT_CODES,
  ...CONFIG_FAULT_CODES,
  ...SERVICE_FAULT_CODES,
]);
const KNOWN_CONFIG_REASONS = new Set([
  ...Object.values(TURNSTILE_CONFIG_REASONS),
  "disabled",
]);

function safeCodes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).map((value) => {
    const code = typeof value === "string" ? value : "";
    return KNOWN_CODES.has(code) ? code : "unknown";
  });
}

const MAX_ECHO_CHARS = 128;
function safeEcho(value) {
  const cleaned = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "");
  return cleaned.length > MAX_ECHO_CHARS
    ? cleaned.slice(0, MAX_ECHO_CHARS) + "…"
    : cleaned;
}

export function turnstileLogShape(result) {
  const out = { ok: result?.ok === true };
  if (out.ok) return out;

  if (Object.values(REASONS).includes(result?.reason)) out.reason = result.reason;
  if (result?.codes?.length) out.codes = safeCodes(result.codes);
  if (result?.reason === REASONS.HOSTNAME && result?.hostname)
    out.hostname = safeEcho(result.hostname);
  if (result?.reason === REASONS.ACTION)
    out.action = result?.action == null ? "absent" : safeEcho(result.action);
  if (result?.reason === REASONS.CONFIGURATION && KNOWN_CONFIG_REASONS.has(result?.config_reason))
    out.config_reason = result.config_reason;
  return out;
}

export function isTokenFault(reason) {
  return reason === REASONS.MISSING
    || reason === REASONS.MALFORMED
    || reason === REASONS.REJECTED
    || reason === REASONS.HOSTNAME
    || reason === REASONS.ACTION;
}

function tokenUsable(token) {
  if (typeof token !== "string") return false;
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return false;
  return !/[\u0000-\u001f\u007f]/.test(token);
}

/**
 * Verify one token. The function returns a closed-vocabulary result and never
 * throws. `fetchImpl` is a test seam; production uses globalThis.fetch.
 */
export async function verifyTurnstile({
  token,
  expectedAction,
  allowed = allowedHosts(),
  timeoutMs = TURNSTILE_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = readTurnstileConfig();

  if (config.state !== TURNSTILE_STATES.ENABLED) {
    return {
      ok: false,
      reason: REASONS.CONFIGURATION,
      config_reason: config.state === TURNSTILE_STATES.DISABLED
        ? "disabled"
        : config.reason,
    };
  }

  if (token === undefined || token === null || token === "")
    return { ok: false, reason: REASONS.MISSING };
  if (!tokenUsable(token))
    return { ok: false, reason: REASONS.MALFORMED };
  if (typeof fetchImpl !== "function")
    return { ok: false, reason: REASONS.UNVERIFIED };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
  let data;

  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        secret: config.secretKey,
        response: token,
      }),
      signal: ctrl.signal,
    });
    const text = await response.text();
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, reason: REASONS.UNVERIFIED };
    }
  } catch {
    return {
      ok: false,
      reason: ctrl.signal.aborted ? REASONS.TIMEOUT : REASONS.UNVERIFIED,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!data || typeof data !== "object" || Array.isArray(data))
    return { ok: false, reason: REASONS.UNVERIFIED };

  const codes = safeCodes(data["error-codes"]);

  if (data.success !== true) {
    if (codes.some((code) => CONFIG_FAULT_CODES.has(code))) {
      return {
        ok: false,
        reason: REASONS.CONFIGURATION,
        config_reason: "invalid_secret_key",
        codes,
      };
    }

    const tokenFault = codes.length > 0
      && codes.every((code) => TOKEN_FAULT_CODES.has(code));
    return {
      ok: false,
      reason: tokenFault ? REASONS.REJECTED : REASONS.UNVERIFIED,
      codes,
    };
  }

  const hostname = typeof data.hostname === "string"
    ? data.hostname.toLowerCase()
    : "";
  if (!hostname || !allowed.has(hostname)) {
    return {
      ok: false,
      reason: REASONS.HOSTNAME,
      hostname: hostname || "absent",
      codes,
    };
  }

  const action = typeof data.action === "string" ? data.action : "";
  if (!expectedAction || action !== expectedAction) {
    return {
      ok: false,
      reason: REASONS.ACTION,
      action: action || "absent",
      codes,
    };
  }

  return { ok: true, hostname, action };
}
