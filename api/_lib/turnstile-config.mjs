/* Explicit configuration model for the Turnstile lead gate.
 *
 * The feature flag is authoritative. Keys may remain stored in Vercel while
 * the feature is disabled; they must not switch protection on by themselves.
 * Conversely, once TURNSTILE_ENABLED=true, incomplete or malformed
 * configuration is a fail-closed state rather than an implicit disable.
 */

export const TURNSTILE_STATES = Object.freeze({
  DISABLED: "disabled",
  ENABLED: "enabled",
  MISCONFIGURED: "misconfigured",
});

export const TURNSTILE_CONFIG_REASONS = Object.freeze({
  INVALID_FLAG: "invalid_flag",
  MISSING_SITE_KEY: "missing_site_key",
  MISSING_SECRET_KEY: "missing_secret_key",
  MISSING_KEYS: "missing_site_and_secret_key",
  INVALID_SECRET_KEY: "invalid_secret_key",
});

const text = (value) => String(value ?? "").trim();

/**
 * Read Turnstile configuration without logging or exposing the secret.
 *
 * Supported flag values are intentionally narrow:
 *   absent / empty / "false" -> disabled
 *   "true"                   -> requested; keys must both exist
 *   anything else            -> misconfigured (fail closed at runtime)
 */
export function readTurnstileConfig(env = process.env) {
  const rawFlag = text(env.TURNSTILE_ENABLED);

  if (rawFlag === "" || rawFlag === "false") {
    return { state: TURNSTILE_STATES.DISABLED, reason: null, siteKey: "", secretKey: "" };
  }

  if (rawFlag !== "true") {
    return {
      state: TURNSTILE_STATES.MISCONFIGURED,
      reason: TURNSTILE_CONFIG_REASONS.INVALID_FLAG,
      siteKey: "",
      secretKey: "",
    };
  }

  const siteKey = text(env.TURNSTILE_SITE_KEY);
  const secretKey = text(env.TURNSTILE_SECRET_KEY);

  if (!siteKey && !secretKey) {
    return {
      state: TURNSTILE_STATES.MISCONFIGURED,
      reason: TURNSTILE_CONFIG_REASONS.MISSING_KEYS,
      siteKey: "",
      secretKey: "",
    };
  }
  if (!siteKey) {
    return {
      state: TURNSTILE_STATES.MISCONFIGURED,
      reason: TURNSTILE_CONFIG_REASONS.MISSING_SITE_KEY,
      siteKey: "",
      secretKey: "",
    };
  }
  if (!secretKey) {
    return {
      state: TURNSTILE_STATES.MISCONFIGURED,
      reason: TURNSTILE_CONFIG_REASONS.MISSING_SECRET_KEY,
      siteKey: "",
      secretKey: "",
    };
  }

  return { state: TURNSTILE_STATES.ENABLED, reason: null, siteKey, secretKey };
}

/** True when the request path must run the gate, including fail-closed config errors. */
export function turnstileGateRequested(env = process.env) {
  return readTurnstileConfig(env).state !== TURNSTILE_STATES.DISABLED;
}
