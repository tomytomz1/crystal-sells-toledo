/* Website re-opt-in reconciliation — the two-factor clearance.
   =====================================================================
   A previous STOP stays authoritative until TWO independent facts are both
   durably on record for the SAME number:

     1. FRESH WEBSITE CONSENT. A brand-new submission in which the SMS box
        was explicitly ticked, whose disclosure the server attached, whose
        evidence reached the append-only ledger, and which post-dates every
        refusal it would have to supersede.

     2. PROVIDER-CONFIRMED HANDSET OPT-IN. A signature-verified Twilio
        inbound message classified START/UNSTOP from that same line.

   NEITHER IS SUFFICIENT, AND THE REASONS ARE DIFFERENT.

   A web form proves that somebody who knew an email, an address and a phone
   number ticked a box. It does not prove they hold the handset — anybody
   can type anybody's number — so on its own it is exactly the "mass-mailed
   update-your-details link" api/_lib/consent.mjs refuses.

   A START proves the handset, and nothing else: it carries no disclosure
   for anyone to have agreed to. api/twilio-inbound.js has always recorded
   it as a request rather than a grant, and that is unchanged.

   Together they are a person who was shown the current disclosure, agreed
   to it, and then proved possession of the line from the line itself.

   WHY THE START IS THE TRIGGER AND THE FORM IS NOT
   -----------------------------------------------
   Under Twilio Advanced Opt-Out, a START is also the moment TWILIO lifts
   its own block. Reconciling at the form instead would leave our ledger
   saying "allowed" while the provider still refused the number — the exact
   split this module exists to prevent. So the form records evidence and
   waits; the START reconciles. A visitor who happens to text START first
   simply texts it again after submitting, which the form's own note says.

   WHAT THIS MODULE IS NOT
   -----------------------
   It sends nothing and grants nothing by itself. It reads two durable facts,
   answers one yes/no question, and — only on yes — hands
   api/_lib/consent-ledger.mjs an APPEND. The old STOP row is never touched:
   clearance is a NEW `unsuppressed`/`consumer_request` event that db/003
   folds as a lane clearance, exactly as the human operator workflow's is.
   Gate 8 (api/_lib/send-permission.mjs) still performs the final durable
   suppression read immediately before any send, and is not consulted,
   short-circuited or cached here.

   It also does not replace api/operator-unsuppress.js. That workflow stays
   available and unchanged, and remains the only path that can clear an
   `ai_voice` or `all` lane or record a `recorded_in_error` correction.

   Design and the Twilio research behind it:
   docs/updates/2026-09-21-website-sms-reoptin.md
   ===================================================================== */

import {
  toE164, driverShape, buildSuppressionEvent, appendSuppressionEvents,
  CHANNEL, EVENT_TYPE, SOURCE_TWILIO, REOPTIN_CONFIRMATION,
  AUTOMATIC_UNSUPPRESSION_CHANNELS,
} from "./consent-ledger.mjs";
import { UNSUPPRESSION_REASON, consentFeatureEnabled } from "./consent.mjs";

/* ---------------------------------------------------------------------
   CONFIGURATION — TWO SEPARATE SWITCHES, BOTH REQUIRED
   ---------------------------------------------------------------------
   The credential and the flag are deliberately not the same control. The
   credential can be configured, verified against the database and left in
   place while the behaviour stays off, exactly as OUTBOUND_SMS_ENABLED
   separates the sender's credentials from the sender's activation. With
   either absent, this path does nothing at all and api/twilio-inbound.js
   behaves byte-for-byte as it did before: a START is recorded as a
   re-opt-in request and the suppression stands.
   --------------------------------------------------------------------- */
export const REOPTIN_FLAG = "SMS_REOPTIN_ENABLED";
export const REOPTIN_LEDGER_URL_VAR = "CONSENT_LEDGER_REOPTIN_URL";

/** Exactly the string "true". A feature that turns itself on through a typo
 *  is worse than one that needs the word spelled out — consent.mjs's rule,
 *  and this one clears suppressions, so it is not the place to relax it. */
export function reoptinEnabled(env = process.env) {
  return env?.[REOPTIN_FLAG] === "true";
}

export function reoptinConfigured(env = process.env) {
  return Boolean(String(env?.[REOPTIN_LEDGER_URL_VAR] || "").trim());
}

/**
 * All three, and in one place, so "on" cannot mean on for the read and off
 * for the write.
 *
 * THE CONSENT FEATURE IS THE THIRD, and it is not redundant belt-and-braces.
 * With COMMUNICATIONS_CONSENT_ENABLED off, api/twilio-inbound.js skips the
 * HubSpot projection entirely — so a clearance written in that state would
 * open the durable lane and leave the CRM asserting a suppression, a
 * half-applied transition that is logged and otherwise invisible. Refusing
 * the whole thing is the fail-closed half of "flag off must stay
 * production-equivalent".
 */
export function reoptinActive(env = process.env) {
  /* `env || {}` because consentFeatureEnabled() indexes without optional
     chaining, and this call sits OUTSIDE any try in api/twilio-inbound.js: a
     throw here would escape the handler and leave the webhook unanswered
     rather than failing closed. The two below already tolerate it. */
  return consentFeatureEnabled(env || {})
    && reoptinEnabled(env) && reoptinConfigured(env);
}

/* HOW LONG A FRESH CONSENT STAYS ARMED.
   ---------------------------------------------------------------------
   This window is the whole cost of the residual abuse case. Somebody who
   knows another person's details can submit the form and tick the box; that
   alone clears nothing, but it sits in the ledger waiting for the phone's
   owner to send START for their own reasons. Fourteen days bounds that wait
   without making the ordinary path — fill the form, read the note, text
   START — fail for anyone who does it the next day or the next week.

   It is enforced IN SQL, against the database's clock, not against this
   process's. A serverless function's clock is not evidence. */
export const REOPTIN_CONSENT_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

/* THE TIME BUDGET, and it is small on purpose.
   ---------------------------------------------------------------------
   This runs inside api/twilio-inbound.js's ABSOLUTE 10 s projection
   deadline, measured from handler entry, under a 15 s platform maxDuration
   and Twilio's own ~15 s webhook clock which starts before ours. Two more
   3 s database calls at the ledger's default would eat the projection's
   budget whole and push the worst case past the platform limit.

   So: 2 s each, and the reconciliation is not STARTED at all unless
   REOPTIN_MIN_BUDGET_MS remains. That constant is not a guess — it is
   exactly LOOKUP + APPEND + the projection's own MIN_SEARCH_MS, so whenever
   this path runs, a searchable projection budget provably survives it.
   tests/reoptin.test.mjs asserts that inequality rather than trusting this
   sentence to stay true. */
export const REOPTIN_LOOKUP_TIMEOUT_MS = 2000;
export const REOPTIN_APPEND_TIMEOUT_MS = 2000;
export const REOPTIN_MIN_BUDGET_MS = 5000;

export const REOPTIN_ERROR = Object.freeze({
  NOT_CONFIGURED: "REOPTIN_LOOKUP_NOT_CONFIGURED",
  MALFORMED_RESPONSE: "REOPTIN_LOOKUP_MALFORMED_RESPONSE",
  TIMEOUT: "REOPTIN_LOOKUP_TIMEOUT",
  FAILED: "REOPTIN_LOOKUP_FAILED",
});

/** Why a re-opt-in was or was not completed. Stable tokens, logged, never
 *  shown to a consumer and never carrying a number. */
export const REOPTIN_DECISION = Object.freeze({
  ELIGIBLE: "ELIGIBLE",
  UNSUPPORTED_CHANNEL: "UNSUPPORTED_CHANNEL",
  GLOBAL_BLOCK: "GLOBAL_BLOCK",
  NOT_BLOCKED: "NOT_BLOCKED",
  NO_FRESH_CONSENT: "NO_FRESH_CONSENT",
  READINESS_UNAVAILABLE: "READINESS_UNAVAILABLE",
});

export class ReoptinError extends Error {
  constructor(token, driver = null) {
    super(token);
    this.name = "ReoptinError";
    this.token = token;
    this.driver = driver;
    this.reoptinLookupFailed = true;
  }
}

/** Structural-only, PII-free diagnostics. A driver error can carry the
 *  connection string; only the classification ever reaches a log. */
export function reoptinLogShape(err) {
  const driver = err?.driver || driverShape(err);
  return {
    reoptin_error: err?.reoptinLookupFailed ? err.token : REOPTIN_ERROR.FAILED,
    ...(driver?.name ? { reoptin_driver_error: driver.name } : {}),
    ...(driver?.code ? { reoptin_driver_code: driver.code } : {}),
  };
}

async function neonExecutor(text, params, { url, signal }) {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url, { fetchOptions: { signal } });
  return sql.query(text, params);
}

/* ---------------------------------------------------------------------
   PARSING, AND WHY EVERY BRANCH REFUSES RATHER THAN DEFAULTS
   ---------------------------------------------------------------------
   The dangerous fabrication here is the OPPOSITE of gate 8's. There, an
   empty result set forged "this consumer never opted out". Here, a row that
   forged "the lane is blocked AND a fresh consent exists" would manufacture
   a clearance for a number that never asked for one. So nothing below
   coerces: a shape this code cannot read truthfully is an error, and an
   error leaves the suppression standing.
   --------------------------------------------------------------------- */
function rowsOf(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray(result.rows)) return result.rows;
  throw new ReoptinError(REOPTIN_ERROR.MALFORMED_RESPONSE);
}

/** An optional instant. NULL/absent is a real answer — "this lane is not
 *  blocked", "no consent qualified" — and anything unparseable is not.
 *
 *  MEASURED AT THE DRIVER, not assumed: @neondatabase/serverless parses a
 *  `timestamptz` itself and collapses a value it cannot read to `null`,
 *  which is indistinguishable here from a SQL NULL. Nothing in this function
 *  can recover that distinction. It does not have to: every null this
 *  lookup can produce resolves toward REFUSING — a null block time reads as
 *  "this lane is not blocked" and evaluateReoptin() answers NOT_BLOCKED, and
 *  a null consent timestamp beside a present key is a half-answer that
 *  parseReadiness() refuses outright. A non-Date, non-null value that is not
 *  a timestamp at all (the driver renders `infinity` as a JS number) still
 *  reaches the refusal below. tests/reoptin.test.mjs pins both directions. */
function optionalInstant(value) {
  if (value == null) return null;
  /* A timestamptz comes back from @neondatabase/serverless as a real Date.
     Stringifying it first and re-parsing loses milliseconds, and this value
     is written into an append-only row and into a HubSpot consent timestamp,
     so it is taken as given rather than round-tripped through a locale
     string. An INVALID Date is refused, never silently rendered. */
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new ReoptinError(REOPTIN_ERROR.MALFORMED_RESPONSE);
    return value.toISOString();
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new ReoptinError(REOPTIN_ERROR.MALFORMED_RESPONSE);
  return d.toISOString();
}

/** An optional short text column. Bounded, because it is copied into an
 *  append-only row and into a HubSpot property. */
function optionalText(value, max = 500) {
  if (value == null) return "";
  const raw = String(value).trim();
  if (raw.length > max) throw new ReoptinError(REOPTIN_ERROR.MALFORMED_RESPONSE);
  return raw;
}

/** The consent's dedupe_key, checked against the shape
 *  api/_lib/consent-ledger.mjs would have minted for a website consent in
 *  this lane. A key that cannot have come from this system is malformed,
 *  not "a consent we do not recognise". */
function consentKey(value, channel) {
  const raw = optionalText(value);
  if (!raw) return "";
  const parts = raw.split(":");
  if (parts.length !== 4 || parts.some((x) => !x) ||
      parts[2] !== channel || parts[3] !== EVENT_TYPE.CONSENT_SELECTED)
    throw new ReoptinError(REOPTIN_ERROR.MALFORMED_RESPONSE);
  return raw;
}

function parseReadiness(result, channel, phoneE164) {
  const rows = rowsOf(result);
  /* EXACTLY ONE ROW. db/004 is an aggregate with no GROUP BY joined to an
     optional consent, so one row is what it always produces — for an
     unknown number too. Zero rows or two means the caller is not talking to
     the function this code was written against. */
  if (rows.length !== 1) throw new ReoptinError(REOPTIN_ERROR.MALFORMED_RESPONSE);
  const row = rows[0];
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw new ReoptinError(REOPTIN_ERROR.MALFORMED_RESPONSE);

  const blocked = Object.freeze({
    [CHANNEL.SMS]: optionalInstant(row.blocked_sms_at),
    [CHANNEL.AI_VOICE]: optionalInstant(row.blocked_ai_voice_at),
    [CHANNEL.ALL]: optionalInstant(row.blocked_all_at),
  });

  const dedupeKey = consentKey(row.consent_dedupe_key, channel);
  const occurredAt = optionalInstant(row.consent_occurred_at);
  /* A key with no timestamp, or a timestamp with no key, is half an answer.
     Both are written into the clearance, so neither may be guessed. */
  if (Boolean(dedupeKey) !== Boolean(occurredAt))
    throw new ReoptinError(REOPTIN_ERROR.MALFORMED_RESPONSE);

  return Object.freeze({
    /* The normalised number the answer is ABOUT, carried back so a caller
       never has to re-derive it — or, worse, project a raw provider string
       into a CRM property beside a permission. */
    phone: phoneE164,
    blocked,
    consent: dedupeKey
      ? Object.freeze({
        dedupeKey,
        occurredAt,
        version: optionalText(row.consent_version, 200),
        formType: optionalText(row.consent_form_type, 200),
        pagePath: optionalText(row.consent_page_path, 400),
        submissionId: optionalText(row.consent_submission_id, 200),
      })
      : null,
  });
}

/* ---------------------------------------------------------------------
   THE DECISION — PURE, AND THE ONLY PLACE IT IS MADE
   --------------------------------------------------------------------- */
/**
 * Given a readiness answer, may this lane be cleared?
 *
 * Pure: no I/O, no clock, no environment. Nothing here can turn a refusal
 * into a clearance, and every refusal names itself.
 */
export function evaluateReoptin({ channel, readiness } = {}) {
  /* The lane fence, restated at the decision as well as at the builder.
     Two cheap checks in different layers, because this one is the one a
     future caller would pass a different channel to. */
  if (!AUTOMATIC_UNSUPPRESSION_CHANNELS.includes(channel))
    return { eligible: false, reason: REOPTIN_DECISION.UNSUPPORTED_CHANNEL };

  if (!readiness || typeof readiness !== "object" || !readiness.blocked)
    return { eligible: false, reason: REOPTIN_DECISION.READINESS_UNAVAILABLE };

  /* A GLOBAL DO-NOT-CONTACT IS NOT AN SMS SUPPRESSION AND IS NOT CLEARED
     HERE. "Remove me from your list" spoke about every channel; a ticked SMS
     box and a START speak about one. Only api/operator-unsuppress.js, with a
     human's attestation, may lift it. */
  if (readiness.blocked[CHANNEL.ALL])
    return { eligible: false, reason: REOPTIN_DECISION.GLOBAL_BLOCK };

  /* Nothing to clear. Not an error, and not a licence to write a clearance
     for a lane that is already open: an `unsuppressed` row with no block
     behind it is a compliance record asserting an event that did not
     happen. */
  if (!readiness.blocked[channel])
    return { eligible: false, reason: REOPTIN_DECISION.NOT_BLOCKED };

  if (!readiness.consent)
    return { eligible: false, reason: REOPTIN_DECISION.NO_FRESH_CONSENT };

  return { eligible: true, reason: REOPTIN_DECISION.ELIGIBLE };
}

/* ---------------------------------------------------------------------
   THE CLEARANCE ROW
   --------------------------------------------------------------------- */
/**
 * Build the append-only clearance. Pure, and it throws rather than emitting
 * a weaker row — api/_lib/consent-ledger.mjs re-checks every rule from its
 * own side, because that module owns the contract and this one is a caller
 * like any other.
 *
 * `sourceEventId` is the provider's own message id for the START, so a
 * redelivered webhook produces the SAME dedupe_key and inserts nothing.
 */
export function buildReoptinUnsuppression({
  occurredAt, channel, phone, sourceEventId, consent, providerMetadata = {},
} = {}) {
  return buildSuppressionEvent({
    occurredAt,
    channel,
    eventType: EVENT_TYPE.UNSUPPRESSED,
    phone,
    source: SOURCE_TWILIO,
    sourceEventId,
    reasonCode: UNSUPPRESSION_REASON.CONSUMER_REQUEST,
    /* NO evidence_text. The consumer's verbatim words are stored only for a
       message classified as an opt-out — the message IS the evidence there.
       A START is a keyword, and this table is not a message archive. */
    evidenceText: null,
    metadata: {
      ...providerMetadata,
      reoptin_confirmation: REOPTIN_CONFIRMATION.TWILIO_START,
      /* THE CLEARANCE NAMES ITS OWN JUSTIFICATION. An auditor reading this
         row can find the exact submission, disclosure version and moment the
         permission rests on without holding this source tree. */
      consent_dedupe_key: consent?.dedupeKey,
      consent_occurred_at: consent?.occurredAt,
      consent_copy_version: consent?.version || null,
      consent_submission_id: consent?.submissionId || null,
    },
  });
}

/* ---------------------------------------------------------------------
   THE BOUNDARY, BOUND ONCE
   ---------------------------------------------------------------------
   NO MODULE-SCOPE MUTABLE EXECUTOR, for the reason api/_lib/send-permission.mjs
   records and in the sharper direction. There, a fabricated empty result set
   turned a suppressed number into an allowed one. Here, a fabricated row
   saying "blocked, and a fresh consent exists" would manufacture a clearance
   outright. So the executor is a closed-over argument, makeGate() binds it
   ONCE, and nothing an importer can reach points anywhere else.
   --------------------------------------------------------------------- */
async function lookupWith(executor, phone, {
  channel = CHANNEL.SMS,
  env = process.env,
  timeoutMs = REOPTIN_LOOKUP_TIMEOUT_MS,
  maxAgeSeconds = REOPTIN_CONSENT_MAX_AGE_SECONDS,
} = {}) {
  const url = String(env?.[REOPTIN_LEDGER_URL_VAR] || "").trim();
  if (!url) throw new ReoptinError(REOPTIN_ERROR.NOT_CONFIGURED);

  let e164;
  try { e164 = toE164(phone); }
  catch (err) { throw new ReoptinError(REOPTIN_ERROR.MALFORMED_RESPONSE, driverShape(err)); }

  const ctrl = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      /* ABORT, never merely race. Racing a promise leaves the socket open
         and the query running past the moment the caller stopped waiting. */
      ctrl.abort();
      reject(new ReoptinError(REOPTIN_ERROR.TIMEOUT));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      executor(
        "SELECT blocked_sms_at, blocked_ai_voice_at, blocked_all_at, " +
        "consent_dedupe_key, consent_occurred_at, consent_version, " +
        "consent_form_type, consent_page_path, consent_submission_id " +
        "FROM public.get_reoptin_readiness($1, $2, $3)",
        [e164, channel, maxAgeSeconds],
        { url, signal: ctrl.signal },
      ),
      deadline,
    ]);
    return parseReadiness(result, channel, e164);
  } catch (err) {
    if (err?.reoptinLookupFailed) throw err;
    throw new ReoptinError(REOPTIN_ERROR.FAILED, driverShape(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Append the clearance through the dedicated re-opt-in credential, while the
 * INSERT statement and the column contract stay in the one module that owns
 * them.
 *
 * `rowsAffected` is load-bearing and the caller must read it: only a value
 * greater than zero means THIS request created a new clearance. A replayed
 * START no-ops on its dedupe key, and a caller that projected anyway would
 * clear `cst_sms_suppressed` for a number a later STOP has since and
 * correctly re-suppressed. That is the defect §9.1 of the unsuppression
 * decision names, and it is the same shape here.
 */
export function appendReoptinUnsuppression(event, { env = process.env, timeoutMs } = {}) {
  return appendSuppressionEvents([event], {
    env,
    timeoutMs: timeoutMs == null ? REOPTIN_APPEND_TIMEOUT_MS : timeoutMs,
    urlVar: REOPTIN_LEDGER_URL_VAR,
  });
}

function makeGate({ executor }) {
  return {
    lookupReoptinReadiness: (phone, opts) => lookupWith(executor, phone, opts),
  };
}

/* THE gate. Built at module load over the real boundary, and `const`, so the
   exported function below can never be pointed anywhere else. */
const GATE = makeGate({ executor: neonExecutor });

export const lookupReoptinReadiness = GATE.lookupReoptinReadiness;

/**
 * TEST ONLY. Builds an INDEPENDENT gate over an injected boundary. It cannot
 * affect the exported function above, which never looks its boundary up.
 * tools/check.mjs fails the build if any module under `api/` other than this
 * one names it.
 */
export function _reoptinGateForTest({ executor = neonExecutor } = {}) {
  return makeGate({ executor });
}
