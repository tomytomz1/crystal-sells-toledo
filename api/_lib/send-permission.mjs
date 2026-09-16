/* Gate 8 — operational send-time permission enforcement.
   =====================================================================
   api/_lib/permission.mjs remains the PURE policy resolver: given current
   permission state and suppression evidence, it answers whether a channel is
   allowed. This module owns the I/O boundary a future sender must cross:
   obtain the durable suppression fold for the destination number, union it
   with the caller-supplied current HubSpot state, then ask the pure resolver
   again.

   IMPORTANT DISTINCTION
   ---------------------
   A caller may be denied without reaching the ledger when HubSpot/current
   state already says no. A caller may NEVER be allowed without a successful
   durable lookup. Missing configuration, timeout, driver failure or malformed
   rows all fail CLOSED.

   This module sends no SMS and places no call. Therefore this PR cannot prove
   temporal adjacency to a provider side effect. A future Twilio/Retell sender
   must call canSendSmsNow()/canPlaceAutomatedVoiceCallNow() immediately before
   its provider call and obey the returned { allowed, reason }; that coupling is
   part of the sender integration, not something a pure decision module can
   manufacture today.

   Design contracts:
   - docs/updates/2026-09-10-stop-dnc-suppression-decision.md §2.1
   - docs/updates/2026-09-15-unsuppression-reoptin-decision.md §10.1
   - db/003_unsuppression_lookup.sql (get_suppression_state contract)
   ===================================================================== */

import {
  canSendSms, canPlaceAutomatedVoiceCall,
} from "./permission.mjs";
import { toE164 } from "./consent-ledger.mjs";

/** Server-side ONLY. This is the EXECUTE-only consent_ledger_sender role. */
export const SENDER_LEDGER_URL_VAR = "CONSENT_LEDGER_SENDER_URL";

/** The read has the same hard ceiling as a ledger append. */
export const SUPPRESSION_LOOKUP_TIMEOUT_MS = 3000;

/** Stable machine reasons owned by the operational Gate 8 boundary. */
export const SEND_TIME_REASON = Object.freeze({
  LOOKUP_NOT_CONFIGURED: "SUPPRESSION_LOOKUP_NOT_CONFIGURED",
  LOOKUP_TIMEOUT: "SUPPRESSION_LOOKUP_TIMEOUT",
  LOOKUP_FAILED: "SUPPRESSION_LOOKUP_FAILED",
  LOOKUP_MALFORMED: "SUPPRESSION_LOOKUP_MALFORMED",
});

const ALLOWED_LANES = Object.freeze(["sms", "ai_voice", "all"]);

/* Same public function, same return shape, as db/003. Never read the table
   directly; the sender role has no table privileges and must keep none. */
export const SUPPRESSION_QUERY =
  "SELECT channel, suppressed_at FROM get_suppression_state($1)";

class SendPermissionBoundaryError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SendPermissionBoundaryError";
    this.reason = reason;
  }
}

const deny = (reason) => ({ allowed: false, reason });

/** Production boundary. Imported lazily so merely importing this module does
 *  not open a connection or require configuration. */
async function neonSuppressionLookup(text, params, { url, signal }) {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url, { fetchOptions: { signal } });
  return sql.query(text, params);
}

let lookupExecutor = neonSuppressionLookup;

/** Test seam. Never called by production code. */
export function _setSuppressionLookupExecutor(fn) { lookupExecutor = fn; }
export function _resetSuppressionLookupExecutor() { lookupExecutor = neonSuppressionLookup; }

function senderUrl(env) {
  return String(env?.[SENDER_LEDGER_URL_VAR] || "").trim();
}

/** The exact number the pure resolver will use for the channel. */
function effectiveTarget(state, channel, target) {
  if (target != null && target !== "") return target;
  return state?.[channel]?.consent_phone || "";
}

function parseRows(value) {
  if (!Array.isArray(value))
    throw new SendPermissionBoundaryError(SEND_TIME_REASON.LOOKUP_MALFORMED);

  const seen = new Set();
  return value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new SendPermissionBoundaryError(SEND_TIME_REASON.LOOKUP_MALFORMED);

    const channel = row.channel;
    if (!ALLOWED_LANES.includes(channel) || seen.has(channel))
      throw new SendPermissionBoundaryError(SEND_TIME_REASON.LOOKUP_MALFORMED);
    seen.add(channel);

    const rawAt = row.suppressed_at;
    const instant = rawAt instanceof Date ? rawAt : new Date(String(rawAt ?? ""));
    if (Number.isNaN(instant.getTime()))
      throw new SendPermissionBoundaryError(SEND_TIME_REASON.LOOKUP_MALFORMED);

    return { channel, suppressed_at: instant.toISOString() };
  });
}

async function runLookup(phoneE164, { env, timeoutMs }) {
  const url = senderUrl(env);
  if (!url)
    throw new SendPermissionBoundaryError(SEND_TIME_REASON.LOOKUP_NOT_CONFIGURED);

  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(1, Math.floor(timeoutMs))
    : SUPPRESSION_LOOKUP_TIMEOUT_MS;
  const ctrl = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new SendPermissionBoundaryError(SEND_TIME_REASON.LOOKUP_TIMEOUT));
    }, ms);
  });

  try {
    const result = await Promise.race([
      lookupExecutor(SUPPRESSION_QUERY, [phoneE164], { url, signal: ctrl.signal }),
      deadline,
    ]);
    return parseRows(result);
  } catch (err) {
    if (err instanceof SendPermissionBoundaryError) throw err;
    /* Driver error text can contain connection details. It never becomes a
       reason, log field or return value. */
    throw new SendPermissionBoundaryError(SEND_TIME_REASON.LOOKUP_FAILED);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Union already-validated durable blocking lanes into current state WITHOUT
 * mutating the caller-owned object. Kept private deliberately: every durable
 * row must pass parseRows() first, so no other module can accidentally turn an
 * unvalidated provider/database shape into permission state.
 */
function withDurableSuppression(currentState, rows) {
  const state = currentState || {};
  const suppression = { ...(state.suppression || {}) };

  for (const row of rows) {
    const record = {
      reason: "durable_ledger",
      at: row.suppressed_at,
      source: "consent_ledger",
    };
    if (row.channel === "all") suppression.global = suppression.global || record;
    if (row.channel === "sms") suppression.sms = suppression.sms || record;
    if (row.channel === "ai_voice") suppression.voice = suppression.voice || record;
  }

  return { ...state, suppression };
}

async function resolveNow(state, channel, target, {
  env = process.env,
  timeoutMs = SUPPRESSION_LOOKUP_TIMEOUT_MS,
} = {}) {
  const pure = channel === "sms" ? canSendSms : canPlaceAutomatedVoiceCall;

  /* Cheap and conservative first pass. If current HubSpot state already says
     no, there is no reason to spend a database read proving a second no. */
  const before = pure(state, target, { env });
  if (!before.allowed) return before;

  let phoneE164;
  try {
    phoneE164 = toE164(effectiveTarget(state, channel, target));
  } catch {
    /* The pure resolver already accepted the number. If the stricter durable
       key cannot be produced, there is no safe lookup key, therefore no send. */
    return deny(SEND_TIME_REASON.LOOKUP_MALFORMED);
  }

  let rows;
  try {
    rows = await runLookup(phoneE164, { env, timeoutMs });
  } catch (err) {
    return deny(err instanceof SendPermissionBoundaryError
      ? err.reason
      : SEND_TIME_REASON.LOOKUP_FAILED);
  }

  /* Second pass is the actual policy decision over the UNION of current
     HubSpot state and durable ledger state. */
  return pure(withDurableSuppression(state, rows), target, { env });
}

/** May a future Twilio sender text this number RIGHT NOW? */
export function canSendSmsNow(state, target, opts) {
  return resolveNow(state, "sms", target, opts);
}

/** May a future Retell sender place an automated/AI call RIGHT NOW? */
export function canPlaceAutomatedVoiceCallNow(state, target, opts) {
  return resolveNow(state, "ai_voice", target, opts);
}
