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

   FOR THE DARK SMS SENDER, THAT REQUIREMENT IS NOW ENFORCED. The
   outbound/Gate 8 build guard proves that the exported sender is bound to
   authorizeSms(), that the durable lookup remains the last provider read,
   and that no suspension point sits between an allowed decision and the
   Twilio side effect. The sender itself is still unreachable from live code:
   nothing imports it, outbound credentials are absent, and the outbound flag
   is not enabled. A future AI-voice sender does not inherit those guarantees
   automatically and must get equivalent enforcement before activation.

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

/* NO MODULE-SCOPE MUTABLE BOUNDARY LIVES HERE. An earlier version held
   `let suppressionExecutor` and `let contactLookup` with exported
   setters, and that was a bypass of exactly the kind PR #51's own
   correction removed from the sender: measured on this file,
   `_setSuppressionExecutor(async () => [])` turned a number carrying a
   durable SMS block from `{ allowed: false, reason: "DURABLE_SMS_BLOCK" }`
   into `{ allowed: true, reason: "ALLOWED" }`. A fabricated empty result
   set is indistinguishable from "this consumer never opted out".

   The two implementations below therefore take their boundary as an
   argument, makeGate() binds them ONCE, and the exported functions close
   over that binding. Nothing at module scope can be rewritten, so no
   importer can convert gate 8 into an always-allow. CLAUDE.md rule 21. */

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
 *
 * The executor is the FIRST ARGUMENT and never a module-level binding -
 * see the note above. Callers get the bound form from makeGate().
 */
async function lookupWith(suppressionExecutor, phone, {
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
async function authorizeWith({ suppressionExecutor, contactLookup }, channel, { email, phone } = {}, {
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
    durableSuppression = await lookupWith(suppressionExecutor, phone, { env, timeoutMs });
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

/**
 * Bind gate 8 to a pair of boundaries, once.
 *
 * Called exactly twice in this repository: immediately below, to build
 * THE gate over the real Neon executor and the real HubSpot lookup, and
 * from `_gateForTest()`. The boundaries are closed over, so nothing can
 * substitute them afterwards.
 */
function makeGate({ suppressionExecutor, contactLookup }) {
  const deps = { suppressionExecutor, contactLookup };
  return {
    lookupDurableSuppression: (phone, opts) => lookupWith(suppressionExecutor, phone, opts),
    authorizeSms: ({ email, phone } = {}, opts) => authorizeWith(deps, "sms", { email, phone }, opts),
    authorizeAutomatedVoice: ({ email, phone } = {}, opts) =>
      authorizeWith(deps, "ai_voice", { email, phone }, opts),
  };
}

/* THE gate. Built at module load over the real boundaries, and `const`,
   so the exported functions below can never be pointed anywhere else. */
const GATE = makeGate({ suppressionExecutor: neonExecutor, contactLookup: findContactByEmail });

export const lookupDurableSuppression = GATE.lookupDurableSuppression;
export const authorizeSms = GATE.authorizeSms;
export const authorizeAutomatedVoice = GATE.authorizeAutomatedVoice;

/**
 * TEST ONLY. Builds an INDEPENDENT gate over injected boundaries.
 *
 * It cannot affect the exported functions above, which never look their
 * boundaries up. `tools/check.mjs` fails the build if any module under
 * `api/` other than this one names it.
 */
export function _gateForTest({
  suppressionExecutor = neonExecutor,
  contactLookup = findContactByEmail,
} = {}) {
  return makeGate({ suppressionExecutor, contactLookup });
}