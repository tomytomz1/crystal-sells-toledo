/* Gate 8 — send-time permission enforcement.
   =====================================================================
   This is the I/O layer in front of every future outbound SMS or automated
   voice caller. It does NOT send anything. Its only job is to assemble the
   facts the pure permission resolver needs at the moment a send would occur.

   The order is load-bearing:
     1. feature gate
     2. current consent state (HubSpot)
     3. durable phone-keyed suppression lookup (Neon sender role)
     4. api/_lib/permission.mjs makes the ONLY allow/deny decision

   The durable lookup is LAST because it is the fact most likely to change
   after an earlier read: the consumer can send STOP while a CRM request is
   still in flight. Reading suppression first and then spending up to several
   seconds in HubSpot creates a time-of-check/time-of-use window in which a new
   STOP could arrive after the lookup and before the send. A caller must invoke
   this function immediately before its external side effect and must not cache
   an earlier ALLOWED result.

   THAT LAST SENTENCE IS A REQUIREMENT ON THE CALLER, NOT AN ENFORCED
   PROPERTY. The build guard in tools/check.mjs stops any other module under
   api/ from naming the pure send predicates, so the resolver cannot be reached
   behind Gate 8's back from inside api/. It does NOT and cannot establish that
   a future sender calls this function at all, that the call sits adjacent to
   the Twilio or Retell side effect, or that no earlier ALLOWED was cached and
   replayed. No sender exists yet; a static check cannot constrain the call
   ordering of code that has not been written. Enforcing those three is part of
   building the first sender. Do not restate them as guarantees - see
   docs/CURRENT-STATE.md, "What the build guard actually proves".

   Missing configuration, database failure, malformed lookup results, or a
   CRM read failure all become DENY decisions. No dependency outage can be
   mistaken for "not suppressed" or "consent granted".

   This module holds the SECOND ledger credential: the sender role. It is
   deliberately distinct from CONSENT_LEDGER_URL, whose role can INSERT but
   cannot read. The sender role can EXECUTE get_suppression_state(text) and
   cannot SELECT the table or INSERT a row. See db/003 and the suppression
   decision document.
   ===================================================================== */

import { consentFeatureEnabled } from "./consent.mjs";
import { findContactByEmail } from "./hubspot.mjs";
import {
  canSendSms, canPlaceAutomatedVoiceCall, REASON,
} from "./permission.mjs";
import {
  toE164, driverShape,
} from "./consent-ledger.mjs";

export const SENDER_LEDGER_URL_VAR = "CONSENT_LEDGER_SENDER_URL";
export const SUPPRESSION_LOOKUP_TIMEOUT_MS = 3000;

export const LOOKUP_ERROR = Object.freeze({
  NOT_CONFIGURED: "SUPPRESSION_LOOKUP_NOT_CONFIGURED",
  MALFORMED_RESPONSE: "SUPPRESSION_LOOKUP_MALFORMED_RESPONSE",
  TIMEOUT: "SUPPRESSION_LOOKUP_TIMEOUT",
  FAILED: "SUPPRESSION_LOOKUP_FAILED",
});

const VALID_CHANNELS = Object.freeze(["sms", "ai_voice", "all"]);

export class SuppressionLookupError extends Error {
  constructor(token, driver = null) {
    super(token);
    this.name = "SuppressionLookupError";
    this.token = token;
    this.driver = driver;
    this.suppressionLookupFailed = true;
  }
}

/** Structural-only, PII-free diagnostics for a future sender log. */
export function suppressionLookupLogShape(err) {
  const driver = err?.driver || driverShape(err);
  return {
    suppression_lookup_error: err?.suppressionLookupFailed ? err.token : LOOKUP_ERROR.FAILED,
    ...(driver?.name ? { suppression_driver_error: driver.name } : {}),
    ...(driver?.code ? { suppression_driver_code: driver.code } : {}),
  };
}

export function suppressionLookupConfigured(env = process.env) {
  return Boolean(String(env[SENDER_LEDGER_URL_VAR] || "").trim());
}

async function neonExecutor(text, params, { url, signal }) {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url, { fetchOptions: { signal } });
  return sql.query(text, params);
}

let suppressionExecutor = neonExecutor;
let contactLookup = findContactByEmail;

/** Test seams. Never called by production code. */
export function _setSuppressionExecutor(fn) { suppressionExecutor = fn; }
export function _resetSuppressionExecutor() { suppressionExecutor = neonExecutor; }
export function _setContactLookup(fn) { contactLookup = fn; }
export function _resetContactLookup() { contactLookup = findContactByEmail; }

function resultRows(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray(result.rows)) return result.rows;
  throw new SuppressionLookupError(LOOKUP_ERROR.MALFORMED_RESPONSE);
}

function parseSuppressionRows(result) {
  const rows = resultRows(result);
  const channels = new Set();

  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new SuppressionLookupError(LOOKUP_ERROR.MALFORMED_RESPONSE);

    const channel = String(row.channel == null ? "" : row.channel).trim();
    if (!VALID_CHANNELS.includes(channel))
      throw new SuppressionLookupError(LOOKUP_ERROR.MALFORMED_RESPONSE);

    const at = String(row.suppressed_at == null ? "" : row.suppressed_at).trim();
    if (!at || Number.isNaN(new Date(at).getTime()))
      throw new SuppressionLookupError(LOOKUP_ERROR.MALFORMED_RESPONSE);

    channels.add(channel);
  }

  return { status: "ok", channels: [...channels] };
}

/**
 * Ask the durable ledger whether this exact phone currently has an active
 * block. This function never enumerates and never names the table.
 */
export async function lookupDurableSuppression(phone, {
  env = process.env,
  timeoutMs = SUPPRESSION_LOOKUP_TIMEOUT_MS,
} = {}) {
  const url = String(env[SENDER_LEDGER_URL_VAR] || "").trim();
  if (!url) throw new SuppressionLookupError(LOOKUP_ERROR.NOT_CONFIGURED);

  let e164;
  try {
    e164 = toE164(phone);
  } catch (err) {
    /* An unusable target cannot be safely queried. Treat it as an unavailable
       suppression answer; the caller still fails closed. */
    throw new SuppressionLookupError(LOOKUP_ERROR.MALFORMED_RESPONSE, driverShape(err));
  }

  const ctrl = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new SuppressionLookupError(LOOKUP_ERROR.TIMEOUT));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      suppressionExecutor(
        "SELECT channel, suppressed_at FROM public.get_suppression_state($1)",
        [e164],
        { url, signal: ctrl.signal },
      ),
      deadline,
    ]);
    return parseSuppressionRows(result);
  } catch (err) {
    if (err?.suppressionLookupFailed) throw err;
    throw new SuppressionLookupError(LOOKUP_ERROR.FAILED, driverShape(err));
  } finally {
    clearTimeout(timer);
  }
}

const SENDABLE_CHANNELS = Object.freeze(["sms", "ai_voice"]);

const decisionFor = (channel, state, phone, opts) =>
  channel === "sms"
    ? canSendSms(state, phone, opts)
    : canPlaceAutomatedVoiceCall(state, phone, opts);

/**
 * Is this an actual dialable target, by the project's canonical rules?
 *
 * GATE 8 MUST NOT INHERIT THE PURE RESOLVER'S FALLBACK. permission.mjs does
 * `target || ch.consent_phone`, which is right for the consent MODEL - it
 * answers "may this contact be reached on the line they consented to". It is
 * wrong for Gate 8, whose whole question is "may this channel reach THIS
 * number right now". Measured before this guard existed:
 * `authorizeSms({ email })` with no phone reached the CRM pre-decision as
 * ALLOWED, and was then refused only because toE164() happened to throw
 * inside the suppression lookup - reported as SUPPRESSION_LOOKUP_UNAVAILABLE,
 * which sends an operator to debug a database that is fine.
 *
 * So the target is validated HERE, before any provider read, and an absent
 * or unusable one is INVALID_PHONE rather than a dependency story.
 */
function usableTarget(phone) {
  try {
    return toE164(phone);
  } catch {
    return null;
  }
}

/**
 * Authorize one outbound action by reading BOTH authorities at send time.
 *
 * `email` selects the HubSpot contact carrying current consent. `phone` is
 * the actual target and separately keys the durable suppression lookup.
 * The returned object is always the permission resolver's decision shape.
 * Nothing in this module manufactures an "allowed: true" result.
 */
async function authorize(channel, { email, phone } = {}, {
  env = process.env,
  timeoutMs = SUPPRESSION_LOOKUP_TIMEOUT_MS,
} = {}) {
  /* Avoid external I/O while the feature is off, but let the resolver make
     the decision so there is still exactly one policy engine. */
  if (!consentFeatureEnabled(env))
    return decisionFor(channel, null, phone, { env });

  /* A channel nobody implemented is not a channel that may be sent on. The
     dispatch below is a two-way ternary, so without this an unknown channel
     would silently be treated as voice. */
  if (!SENDABLE_CHANNELS.includes(channel))
    return { allowed: false, reason: REASON.UNSUPPORTED_CHANNEL };

  /* The target, before anything external is contacted. See usableTarget(). */
  if (!usableTarget(phone))
    return { allowed: false, reason: REASON.INVALID_PHONE };

  /* Read mutable permission state first. If there is no usable consent there
     can be no send, so no durable lookup is necessary. More importantly, any
     path that COULD become allowed performs the suppression read afterwards,
     as the final provider boundary before the caller's side effect. */
  const mail = String(email == null ? "" : email).trim();
  if (!mail)
    return decisionFor(channel, null, phone, {
      env, consentStateAvailable: true,
    });

  let found;
  try {
    found = await contactLookup(mail);
  } catch {
    return decisionFor(channel, null, phone, {
      env, consentStateAvailable: false,
    });
  }

  if (!found)
    return decisionFor(channel, null, phone, {
      env, consentStateAvailable: true,
    });

  if (!found.consent || typeof found.consent !== "object" || Array.isArray(found.consent))
    return decisionFor(channel, null, phone, {
      env, consentStateAvailable: false,
    });

  /* A local pre-decision may prove the send impossible without a database
     query. It is not an authorization: only a denial is returned early. A
     potential ALLOW must continue to the durable suppression lookup below. */
  const beforeDurable = decisionFor(channel, found.consent, phone, {
    env, consentStateAvailable: true,
  });
  if (!beforeDurable.allowed) return beforeDurable;

  let durableSuppression;
  try {
    durableSuppression = await lookupDurableSuppression(phone, { env, timeoutMs });
  } catch {
    return decisionFor(channel, found.consent, phone, {
      env,
      durableSuppression: { status: "unavailable", channels: [] },
      consentStateAvailable: true,
    });
  }

  return decisionFor(channel, found.consent, phone, {
    env, durableSuppression, consentStateAvailable: true,
  });
}

export function authorizeSms({ email, phone } = {}, opts) {
  return authorize("sms", { email, phone }, opts);
}

export function authorizeAutomatedVoice({ email, phone } = {}, opts) {
  return authorize("ai_voice", { email, phone }, opts);
}
