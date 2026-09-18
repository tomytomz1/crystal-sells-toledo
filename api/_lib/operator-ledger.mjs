/* Least-privilege database client for the operator unsuppression surface.
   =====================================================================
   The credential behind CONSENT_LEDGER_OPERATOR_URL is the db/003 operator
   role. It can EXECUTE the two one-number lookup functions and INSERT, but
   cannot SELECT the ledger table, UPDATE, DELETE, TRUNCATE or enumerate.

   This module names FUNCTIONS, never the ledger table. The write itself is
   still owned by api/_lib/consent-ledger.mjs so there is one insert statement
   and one column contract in the repository.
   ===================================================================== */

import {
  appendSuppressionEvents, driverShape, toE164,
  EVENT_TYPE, CHANNEL,
} from "./consent-ledger.mjs";

export const OPERATOR_LEDGER_URL_VAR = "CONSENT_LEDGER_OPERATOR_URL";
export const OPERATOR_LOOKUP_TIMEOUT_MS = 3000;

export const OPERATOR_LOOKUP_ERROR = Object.freeze({
  NOT_CONFIGURED: "OPERATOR_LEDGER_NOT_CONFIGURED",
  MALFORMED_RESPONSE: "OPERATOR_LEDGER_MALFORMED_RESPONSE",
  TIMEOUT: "OPERATOR_LEDGER_TIMEOUT",
  FAILED: "OPERATOR_LEDGER_FAILED",
});

const LANES = Object.freeze([CHANNEL.SMS, CHANNEL.AI_VOICE, CHANNEL.ALL]);
const BLOCK_TYPES = Object.freeze([EVENT_TYPE.SUPPRESSED, EVENT_TYPE.REVOKED]);
const SAFE_ID = /^[A-Za-z0-9_.-]{1,160}$/;

export class OperatorLedgerError extends Error {
  constructor(token, driver = null) {
    super(token);
    this.name = "OperatorLedgerError";
    this.token = token;
    this.driver = driver;
    this.operatorLedgerFailed = true;
  }
}

export function operatorLedgerConfigured(env = process.env) {
  return Boolean(String(env?.[OPERATOR_LEDGER_URL_VAR] || "").trim());
}

export function operatorLedgerLogShape(err) {
  const driver = err?.driver || driverShape(err);
  return {
    operator_ledger_error: err?.operatorLedgerFailed
      ? err.token : OPERATOR_LOOKUP_ERROR.FAILED,
    ...(driver?.name ? { operator_ledger_driver_error: driver.name } : {}),
    ...(driver?.code ? { operator_ledger_driver_code: driver.code } : {}),
  };
}

async function neonExecutor(text, params, { url, signal }) {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url, { fetchOptions: { signal } });
  return sql.query(text, params);
}

let executor = neonExecutor;
export function _setOperatorLedgerExecutor(fn) { executor = fn; }
export function _resetOperatorLedgerExecutor() { executor = neonExecutor; }

function rowsOf(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray(result.rows)) return result.rows;
  throw new OperatorLedgerError(OPERATOR_LOOKUP_ERROR.MALFORMED_RESPONSE);
}

function instant(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw || Number.isNaN(new Date(raw).getTime()))
    throw new OperatorLedgerError(OPERATOR_LOOKUP_ERROR.MALFORMED_RESPONSE);
  return new Date(raw).toISOString();
}

function lane(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!LANES.includes(raw))
    throw new OperatorLedgerError(OPERATOR_LOOKUP_ERROR.MALFORMED_RESPONSE);
  return raw;
}

function id(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!SAFE_ID.test(raw))
    throw new OperatorLedgerError(OPERATOR_LOOKUP_ERROR.MALFORMED_RESPONSE);
  return raw;
}

function dedupe(value, expectedLane, expectedType) {
  const raw = String(value == null ? "" : value).trim();
  const parts = raw.split(":");
  if (parts.length !== 4 || parts.some((x) => !x) ||
      parts[2] !== expectedLane || parts[3] !== expectedType || raw.length > 500)
    throw new OperatorLedgerError(OPERATOR_LOOKUP_ERROR.MALFORMED_RESPONSE);
  return raw;
}

async function query(sqlText, phone, {
  env = process.env,
  timeoutMs = OPERATOR_LOOKUP_TIMEOUT_MS,
} = {}) {
  const url = String(env?.[OPERATOR_LEDGER_URL_VAR] || "").trim();
  if (!url) throw new OperatorLedgerError(OPERATOR_LOOKUP_ERROR.NOT_CONFIGURED);

  let e164;
  try { e164 = toE164(phone); }
  catch { throw new OperatorLedgerError(OPERATOR_LOOKUP_ERROR.MALFORMED_RESPONSE); }

  const ctrl = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new OperatorLedgerError(OPERATOR_LOOKUP_ERROR.TIMEOUT));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      executor(sqlText, [e164], { url, signal: ctrl.signal }),
      deadline,
    ]);
  } catch (err) {
    if (err?.operatorLedgerFailed) throw err;
    throw new OperatorLedgerError(OPERATOR_LOOKUP_ERROR.FAILED, driverShape(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Whole active blocking rows for exactly one number. */
export async function getActiveBlocks(phone, opts = {}) {
  const result = await query(
    "SELECT channel, dedupe_key, event_type, reason_code, source, source_event_id, " +
    "occurred_at, recorded_at FROM public.get_active_blocks($1)",
    phone, opts);

  return rowsOf(result).map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new OperatorLedgerError(OPERATOR_LOOKUP_ERROR.MALFORMED_RESPONSE);
    const ch = lane(row.channel);
    const type = String(row.event_type == null ? "" : row.event_type).trim();
    if (!BLOCK_TYPES.includes(type))
      throw new OperatorLedgerError(OPERATOR_LOOKUP_ERROR.MALFORMED_RESPONSE);
    const source = id(row.source);
    const sourceEventId = id(row.source_event_id);
    const reason = row.reason_code == null ? "" : String(row.reason_code).trim();
    if (reason.length > 120)
      throw new OperatorLedgerError(OPERATOR_LOOKUP_ERROR.MALFORMED_RESPONSE);
    return Object.freeze({
      channel: ch,
      dedupe_key: dedupe(row.dedupe_key, ch, type),
      event_type: type,
      reason_code: reason,
      source,
      source_event_id: sourceEventId,
      occurred_at: instant(row.occurred_at),
      recorded_at: instant(row.recorded_at),
    });
  });
}

/** Active lanes after db/003 has folded all clearing events. */
export async function getSuppressionLanes(phone, opts = {}) {
  const result = await query(
    "SELECT channel, suppressed_at FROM public.get_suppression_state($1)",
    phone, opts);
  return rowsOf(result).map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new OperatorLedgerError(OPERATOR_LOOKUP_ERROR.MALFORMED_RESPONSE);
    return Object.freeze({ channel: lane(row.channel), suppressed_at: instant(row.suppressed_at) });
  });
}

/**
 * Append through the db/003 operator credential while keeping the canonical
 * insert statement in consent-ledger.mjs. rowsAffected is load-bearing: only
 * a value > 0 means this request created a NEW clearance.
 */
export function appendOperatorUnsuppression(event, {
  env = process.env,
  timeoutMs,
} = {}) {
  return appendSuppressionEvents([event], {
    env,
    ...(timeoutMs == null ? {} : { timeoutMs }),
    urlVar: OPERATOR_LEDGER_URL_VAR,
  });
}
