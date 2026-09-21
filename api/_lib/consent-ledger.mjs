/* The append-only consent ledger — durable historical evidence.
   =====================================================================
   THE ONLY module that knows the ledger table, its column names and its
   connection string. Nothing else may name either; tools/check.mjs
   enforces that containment, exactly as it does for the `cst_*` HubSpot
   names in api/_lib/hubspot-consent-state.mjs.

   THREE RECORDS, THREE JOBS
   -------------------------
   * HubSpot `cst_*` contact properties — CURRENT PERMISSION STATE.
     Mutable, overwritten as it changes. Not history.
   * The HubSpot form-submission timeline activity — the OPERATOR-VISIBLE
     EVIDENCE COPY. Useful, and permanently deletable by a human or a bulk
     operation in the portal.
   * This ledger — the DURABLE HISTORICAL EVIDENCE, and the system of
     record. Append-only as a database grant, not as a code convention:
     the application role holds INSERT and NOTHING ELSE — not even SELECT —
     so this module could not mutate history if it tried, and a leaked
     CONSENT_LEDGER_URL cannot enumerate the numbers and consent decisions
     already in the table. Nothing here reads, and adding a read means a
     new migration, a new role and a narrow view, not a grant on this one.

   Conflating any two of those is how a consent programme fails an audit.
   The reasoning, the sources and the decision are in
   docs/updates/2026-09-09-consent-evidence-ledger-decision.md.

   WHAT THIS MODULE IS NOT
   -----------------------
   It does not decide whether a message may be sent — that is
   api/_lib/permission.mjs. It does not grant anything: a successful
   append is what ALLOWS api/_lib/hubspot.mjs to write a `cst_*` grant,
   and a failed one withholds it. Evidence first, permission second, never
   the other way round.

   It also runs no DDL and holds no credential that could. The table is
   created by a human with the owner credential from
   db/001_communication_consent_events.sql.
   ===================================================================== */

import {
  UNSUPPRESSION_REASON, UNSUPPRESSION_ERROR_ORIGIN,
} from "./consent.mjs";

/* ---------------------------------------------------------------------
   CONFIGURATION
   ---------------------------------------------------------------------
   The application role's connection string. SERVER-SIDE ONLY. It is a
   credential, it is listed in tools/check.mjs's SECRET_NAMES so it can
   never appear in anything delivered to the browser, and it must never be
   the database OWNER's string — an owner credential inside the Vercel
   application would make the ledger mutable and this whole module a
   comment.
   --------------------------------------------------------------------- */
export const LEDGER_URL_VAR = "CONSENT_LEDGER_URL";

/** The table. Named here and nowhere else in the repository's source. */
export const LEDGER_TABLE = "communication_consent_events";

/* Hard. The lead endpoint already awaits an SMTP send inside a 30 s
   maxDuration; three more seconds in the worst case is affordable, and a
   hanging evidence write must never become a hanging lead. */
export const LEDGER_TIMEOUT_MS = 3000;

/** The ledger's own schema version, independent of any disclosure version. */
export const SCHEMA_VERSION = 1;

export const CHANNEL = Object.freeze({
  SMS: "sms",
  AI_VOICE: "ai_voice",
  /* Written only by a global do-not-contact, which is a later phase. */
  ALL: "all",
});

export const EVENT_TYPE = Object.freeze({
  CONSENT_SELECTED: "consent_selected",
  /* NOT A REVOCATION. `consent_not_selected` records that a box was not
     ticked on THIS submission — which is what "they were asked and did not
     opt in" looks like. Someone who granted consent last month and simply
     did not re-tick this month has withdrawn nothing, and reading this
     event type as a withdrawal would silently destroy a lawful permission.
     Withdrawal is `revoked`; a STOP or DNC is `suppressed`. Neither is
     written by the website path, in any circumstance. */
  CONSENT_NOT_SELECTED: "consent_not_selected",
  REOPTIN_REQUESTED: "reoptin_requested",
  REVOKED: "revoked",
  SUPPRESSED: "suppressed",
  UNSUPPRESSED: "unsuppressed",
});

/** Every event this phase writes comes from a website form submission. */
export const SOURCE_WEBSITE = "website";
/* Inbound sources. A suppression NEVER carries SOURCE_WEBSITE: the website
   path has no way to learn that someone opted out, and a suppression that
   claimed to come from a form submission would misdescribe its own
   provenance in the record that exists to prove provenance. */
export const SOURCE_TWILIO = "twilio";
export const SOURCE_RETELL = "retell";
/* A HUMAN entered it — the operator recognising an opt-out the
   deterministic classifier did not, through api/operator-action.js. It is
   a separate SOURCE and not a separate event type: `revoked` still says
   what the consumer did, and `reason_code = manual` says who recognised
   it, so the act and its recogniser sit in separate columns and neither
   is distorted to carry the other. See
   docs/updates/2026-09-10-unclassified-inbound-operator-surfacing-decision.md §6.4. */
export const SOURCE_OPERATOR = "operator";

/* Consumer free text, capped. The only free text this table holds, and it
   is stored ONLY for a message classified as an opt-out — the message IS
   the evidence of the opt-out, which is not an argument that extends to
   "what time is the showing?". See the Gate 7 decision document §2.10. */
export const EVIDENCE_TEXT_MAX_BYTES = 1024;

/* The columns this module writes, in order, and the ONLY ones it writes.

   `event_id` and `recorded_at` are deliberately absent. Both are database
   defaults (db/001_communication_consent_events.sql) and this module
   contains no UUID generation of its own — node:crypto's randomUUID() is
   not imported and must not be. An event's identity is minted by the store
   that guarantees its uniqueness, which keeps the one thing a primary key
   must be true about out of the reach of application code holding no
   UPDATE privilege to repair a collision with.

   Never written, per the proposal's PII minimisation: property address,
   lead message, name, email, IP address. Identity in the ledger is the
   phone the consent binds to plus the submission id — the minimum that
   proves a communication permission. */
export const LEDGER_COLUMNS = Object.freeze([
  "occurred_at",
  "channel",
  "event_type",
  "phone_e164",
  "source",
  "source_event_id",
  "dedupe_key",
  "submission_id",
  "form_type",
  "page_path",
  "consent_copy_version",
  "consent_copy_text",
  "schema_version",
]);

/* The columns a SUPPRESSION event writes. A superset of LEDGER_COLUMNS by
   exactly three: the three db/001 created unused so this phase would need
   no migration against an append-only table.

   `event_id` and `recorded_at` stay absent for the same reason as above. */
export const SUPPRESSION_COLUMNS = Object.freeze([
  ...LEDGER_COLUMNS,
  "reason_code",
  "evidence_text",
  "metadata",
]);

/* ---------------------------------------------------------------------
   THE CLOSED SUPPRESSION-PATH VOCABULARIES
   ---------------------------------------------------------------------
   WHAT THIS BUILDER MAY WRITE, exhaustively. Until 15 September 2026
   buildSuppressionEvent() validated `event_type` and `channel` with
   requireText(), which accepts ANY non-empty string. A typo'd event type
   -- `supressed`, `revoke`, `unsupressed` -- was therefore inserted
   successfully into an append-only table and then matched no fold in
   db/002 or db/003 for the rest of its life. It could not be updated
   (no UPDATE grant), could not be deleted (no DELETE grant) and could not
   be seen (no SELECT grant). A silent, permanent, unfixable row that
   every downstream reader treats as though it were not there.

   That is the worst failure this module can have, and it needed no
   unsuppression feature to happen: it has been reachable since gate 7.
   Design: docs/updates/2026-09-15-unsuppression-reoptin-decision.md §12.1.

   DELIBERATELY NARROWER THAN EVENT_TYPE. `consent_selected` and
   `consent_not_selected` are real members of EVENT_TYPE and are REFUSED
   here: they are written only by buildLedgerEvents() from a website form
   submission, they carry a disclosure version and text, and a suppression
   row asserting one would claim a consent decision that no visitor made.
   A closed vocabulary that merely echoed the enum would not have caught
   that, which is why this is its own list rather than Object.values(). */
export const SUPPRESSION_EVENT_TYPES = Object.freeze([
  EVENT_TYPE.SUPPRESSED,
  EVENT_TYPE.REVOKED,
  EVENT_TYPE.REOPTIN_REQUESTED,
  /* Formally admitted 15 September 2026. The enum member has existed since
     gate 7, but the builder's contract did not name it and nothing
     validated what an `unsuppressed` row had to carry. An enum member
     existing is not the same as the contract admitting it. */
  EVENT_TYPE.UNSUPPRESSED,
]);

/** The lanes. `all` dominates, but dominance is applied in permission.mjs. */
export const SUPPRESSION_CHANNELS = Object.freeze([
  CHANNEL.SMS, CHANNEL.AI_VOICE, CHANNEL.ALL,
]);

/* The event types a `recorded_in_error` correction may name as a target.
   db/003's fold only ever treats `suppressed` and `revoked` as blocking,
   so a key naming anything else invalidates NOTHING -- fail-closed for the
   consumer, but it would let an operator believe she had fixed something
   when she had not. Refused here instead, where it can still be reported. */
const INVALIDATABLE_EVENT_TYPES = Object.freeze([
  EVENT_TYPE.SUPPRESSED, EVENT_TYPE.REVOKED,
]);

/* ---------------------------------------------------------------------
   THE ONE AUTOMATIC CLEARANCE, AND ITS FENCE
   ---------------------------------------------------------------------
   Until 21 September 2026 this module refused EVERY `unsuppressed` row
   whose source was not `operator`, and the comment in validateUnsuppression()
   said so in one line: "only a human may lift a block". That rule bought
   something real — an inbound webhook could otherwise lift the suppression a
   STOP had just created — and it is not being deleted. It is being narrowed
   to the one case where the provider itself has already lifted its own block
   and the handset proved it.

   A `twilio_start` clearance is admitted ONLY when every one of these holds,
   and each is checked below before any database call:

     * the source is `twilio`, so the row came from a signature-verified
       inbound webhook and not from a form, an operator form or a script;
     * the lane is `sms`. NEVER `all` — a global do-not-contact is a human's
       to clear — and NEVER `ai_voice`: START is a messaging keyword, the
       voice permission is a separate permission everywhere else in this
       system, and there is no voice ingress for it to have come from;
     * the reason is `consumer_request`, so db/003 folds it as a lane
       clearance. `recorded_in_error` stays operator-only: correcting a
       record is a judgement about a record, which no webhook can make;
     * the row NAMES THE CONSENT THAT JUSTIFIES IT — the dedupe_key of a
       website `consent_selected` row in the same lane, plus that row's
       occurred_at. An append-only clearance that cannot be traced back to
       the agreement it rests on is a clearance an auditor cannot check, and
       this table has no UPDATE with which to add the reference later.

   WHAT THIS MODULE STILL DOES NOT CHECK, and does not pretend to: that the
   named consent row exists, is fresh, or post-dates the refusal. That needs
   a read this module holds no privilege for. It is `get_reoptin_readiness`
   in db/004, evaluated by api/_lib/reoptin.mjs, and a caller that skipped it
   would produce a row naming a consent that proves nothing — inert for the
   consumer, because the fold would still clear the lane, so the check is the
   caller's duty and is stated as such rather than implied away here. */
export const AUTOMATIC_UNSUPPRESSION_SOURCES = Object.freeze([SOURCE_TWILIO]);
export const AUTOMATIC_UNSUPPRESSION_CHANNELS = Object.freeze([CHANNEL.SMS]);

/** How an automatic clearance learned the phone's owner asked for it.
 *  Closed, for the same reason every other vocabulary here is closed: an
 *  unknown value would sit forever in a table with no UPDATE grant. */
export const REOPTIN_CONFIRMATION = Object.freeze({
  /* A provider-classified START/UNSTOP from the handset itself, delivered on
     the signed inbound webhook. Twilio has lifted its own block by the time
     this arrives, which is the other half of the reconciliation. */
  TWILIO_START: "twilio_start",
});

/* ---------------------------------------------------------------------
   FAILING CLOSED
   ---------------------------------------------------------------------
   Every refusal below is an append failure, and an append failure
   withholds the `cst_*` grant. Nothing here degrades into a partial
   append, a guessed value or a silent success.

   The tokens are stable and PII-free. A ledger error can carry a
   connection string (the driver puts the host in the message) or the value
   that failed conversion (a phone number), so neither the message nor the
   cause object is ever logged — only the classification, plus the
   whitelisted structural fields described at driverShape(), through
   ledgerLogShape().
   --------------------------------------------------------------------- */
export const LEDGER_NOT_CONFIGURED = "CONSENT_LEDGER_NOT_CONFIGURED";
export const LEDGER_PHONE_NOT_E164 = "CONSENT_LEDGER_PHONE_NOT_E164";
export const LEDGER_EVIDENCE_INCOMPLETE = "CONSENT_LEDGER_EVIDENCE_INCOMPLETE";
export const LEDGER_TIMEOUT = "CONSENT_LEDGER_TIMEOUT";
export const LEDGER_APPEND_FAILED = "CONSENT_LEDGER_APPEND_FAILED";

export class ConsentLedgerError extends Error {
  constructor(token, detail = "", driver = null) {
    /* `detail` names a FIELD or a reason class, never a value. */
    super(detail ? `${token}: ${detail}` : token);
    this.name = "ConsentLedgerError";
    this.token = token;
    this.detail = detail;
    /* Structural facts about the underlying driver error, already
       sanitised by driverShape(). Never the message, cause or stack. */
    this.driver = driver;
    this.ledgerFailed = true;
  }
}

/* ---------------------------------------------------------------------
   DRIVER STRUCTURE, WITHOUT DRIVER TEXT
   ---------------------------------------------------------------------
   CONSENT_LEDGER_APPEND_FAILED on its own cannot tell an operator whether
   the driver was missing from the bundle, the host did not resolve, or the
   database refused the credential. Those need different fixes, and on
   9 September 2026 a preview deployment failed this way in 62ms with no way
   to choose between them.

   So two structural fields are allowed out, and only if they survive a
   whitelist: an error CLASS name (`NeonDbError`, `TypeError`) and a
   symbolic CODE (`ERR_MODULE_NOT_FOUND`, `ENOTFOUND`, or a five-character
   Postgres SQLSTATE such as `28P01`). Both are whitelisted rather than
   filtered: a class name must be a letter-initial identifier, and a code
   must be that or exactly five SQLSTATE characters. Neither pattern admits
   a space, a dot, an `@`, a `:` or a `/`, so a connection string, a
   hostname, a role name in a sentence and a parameter value all fail. Ten
   digits — a phone number — fails the five-character branch by length. A
   driver that puts free text in `code` therefore logs nothing at all,
   which is the intended direction to fail.
   --------------------------------------------------------------------- */
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CODE = /^(?:[A-Za-z][A-Za-z0-9_]{0,63}|[0-9A-Z]{5})$/;

function matching(pattern, value) {
  return typeof value === "string" && pattern.test(value) ? value : "";
}

/** Structural-only shape of an arbitrary thrown value. Never its text. */
export function driverShape(err) {
  if (!err || typeof err !== "object") return null;
  const name = matching(SAFE_NAME, err.name);
  /* Node wraps some failures, and the useful code is on the cause. One
     level only — a cause chain is not walked. */
  const code = matching(SAFE_CODE, err.code) || matching(SAFE_CODE, err.cause?.code);
  if (!name && !code) return null;
  return { ...(name ? { name } : {}), ...(code ? { code } : {}) };
}

/**
 * A PII-free classification of an append failure, for the operator log.
 *
 * Deliberately narrow. An unclassified driver error becomes
 * CONSENT_LEDGER_APPEND_FAILED and nothing of its message survives: a
 * Postgres driver error message routinely carries the host, the role and
 * sometimes the offending parameter values, and this is a table whose whole
 * purpose is that its contents are trustworthy.
 *
 * It may additionally carry `ledger_driver_error` (the error class name)
 * and `ledger_driver_code` (a symbolic code or SQLSTATE), both whitelisted
 * by driverShape() to identifier characters. Those name a failure CLASS —
 * which of "not bundled", "host unreachable" and "credential refused" this
 * was — and cannot express a message, a host or a value.
 */
export function ledgerLogShape(err) {
  const token = err?.ledgerFailed ? err.token : LEDGER_APPEND_FAILED;
  /* A ConsentLedgerError carries the shape captured where the driver error
     was caught; anything else is shaped here. */
  const driver = err?.ledgerFailed ? err.driver : driverShape(err);
  return {
    ledger_error: token,
    ...(err?.ledgerFailed && err.detail ? { ledger_detail: err.detail } : {}),
    ...(driver?.name ? { ledger_driver_error: driver.name } : {}),
    ...(driver?.code ? { ledger_driver_code: driver.code } : {}),
  };
}

/** True when the ledger has somewhere to write to. */
export function consentLedgerConfigured(env = process.env) {
  return Boolean(String(env[LEDGER_URL_VAR] || "").trim());
}

/* ---------------------------------------------------------------------
   E.164
   ---------------------------------------------------------------------
   Nothing else in this repository produces E.164. api/_lib/validate.mjs's
   normalizePhone() produces the US display form `(419) 555-0000`, which is
   what HubSpot, the `cst_*` consent phone and the timeline evidence rows
   carry, and what api/_lib/permission.mjs compares by digits. NONE of that
   changes: this conversion exists for the ledger column alone.

   ANYTHING IT CANNOT CONVERT THROWS, which becomes an append failure,
   which withholds the grant. A non-North-American number is therefore
   refused a GRANT while its lead is stored and worked normally — the
   correct fail-closed direction for a Toledo listing practice, and a known
   consequence rather than a bug report later.
   --------------------------------------------------------------------- */
export function toE164(phone) {
  const raw = String(phone == null ? "" : phone).trim();
  if (!raw) throw new ConsentLedgerError(LEDGER_PHONE_NOT_E164, "empty");

  /* Already E.164: a leading + and 11-15 digits. Accepted as given rather
     than reformatted — reformatting a number this code does not understand
     is how a consent gets bound to somebody else's line. */
  if (raw.startsWith("+")) {
    const digits = raw.slice(1).replace(/[\s()\-.]/g, "");
    if (/^[1-9]\d{10,14}$/.test(digits)) return "+" + digits;
    throw new ConsentLedgerError(LEDGER_PHONE_NOT_E164, "malformed_plus");
  }

  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  throw new ConsentLedgerError(LEDGER_PHONE_NOT_E164, "not_north_american");
}

/* ---------------------------------------------------------------------
   IDEMPOTENCY
   ---------------------------------------------------------------------
   The deterministic key behind `ON CONFLICT DO NOTHING` — the unique index
   on dedupe_key is what that clause lands on, even though the statement
   does not name it (see buildInsert). A
   retry that finds its own earlier row is a success, which is exactly what
   deterministic keys are for.

   Every component must be non-empty. A blank submission id would collapse
   every submission onto `website::sms:consent_selected`, and the SECOND
   submission would then be silently discarded by the conflict clause and
   reported as appended — a missing consent record that looks like a
   present one. That is the single worst failure this module could have, so
   it is refused rather than defaulted.
   --------------------------------------------------------------------- */
export function dedupeKey({ source, sourceEventId, channel, eventType } = {}) {
  const parts = { source, sourceEventId, channel, eventType };
  for (const [field, value] of Object.entries(parts)) {
    const v = String(value == null ? "" : value).trim();
    if (!v) throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, field);
    /* A colon inside a component would let two different events produce
       one key. Nothing legitimate carries one. */
    if (v.includes(":")) throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, field);
    parts[field] = v;
  }
  return [parts.source, parts.sourceEventId, parts.channel, parts.eventType].join(":");
}

/* ---------------------------------------------------------------------
   BUILDING THE EVENTS
   --------------------------------------------------------------------- */
function requireInstant(value, field) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, field);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime()))
    throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, field);
  return d.toISOString();
}

function requireText(value, field) {
  const v = String(value == null ? "" : value).trim();
  if (!v) throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, field);
  return v;
}

/**
 * One row per channel per submission, from server-owned evidence only.
 *
 * Pure, and it throws rather than emitting a weaker row: an evidence
 * object missing a disclosure version, a timestamp, a submission id or a
 * convertible phone produces no ledger row at all, and therefore no grant.
 *
 * `evidence` is what api/_lib/consent.mjs's buildConsentEvidence() returns.
 * The disclosure text and version come from that object — the browser sent
 * two booleans and nothing that reaches this function came from it.
 */
export function buildLedgerEvents(evidence, { source = SOURCE_WEBSITE } = {}) {
  if (!evidence || typeof evidence !== "object")
    throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "evidence");

  const submissionId = requireText(evidence.submission_id, "submission_id");
  const occurredAt = requireInstant(evidence.captured_at, "captured_at");
  /* The number the consent decision was made about, converted for this
     column only. It is required on EVERY row, including a
     `consent_not_selected` one: an event that does not say which line it
     concerns proves nothing about that line. */
  const phoneE164 = toE164(evidence.phone);
  const formType = String(evidence.form_type || "");
  const pagePath = String(evidence.source_page || "");

  const row = (channelEvidence, channel) => {
    if (!channelEvidence || typeof channelEvidence !== "object")
      throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, channel);
    const eventType = channelEvidence.granted === true
      ? EVENT_TYPE.CONSENT_SELECTED
      : EVENT_TYPE.CONSENT_NOT_SELECTED;
    return {
      occurred_at: occurredAt,
      channel,
      event_type: eventType,
      phone_e164: phoneE164,
      source,
      source_event_id: submissionId,
      dedupe_key: dedupeKey({ source, sourceEventId: submissionId, channel, eventType }),
      submission_id: submissionId,
      form_type: formType,
      page_path: pagePath,
      consent_copy_version: requireText(channelEvidence.version, channel + ".version"),
      /* The exact words, stored whether or not the box was ticked:
         "declined THIS disclosure" is only meaningful if you know which
         one it was, and a version identifier alone stops answering that
         question the moment the source tree moves on. */
      consent_copy_text: requireText(channelEvidence.exact_text, channel + ".exact_text"),
      schema_version: SCHEMA_VERSION,
    };
  };

  return [row(evidence.sms, CHANNEL.SMS), row(evidence.ai_voice, CHANNEL.AI_VOICE)];
}

/* ---------------------------------------------------------------------
   THE STATEMENT
   ---------------------------------------------------------------------
   ONE parameterised multi-row INSERT, in a single statement.

   WHAT THAT DOES AND DOES NOT GUARANTEE. Be precise here, because the
   sloppy version of this sentence — "both rows land together or neither
   does" — is wrong in a way that matters.

   * A statement runs in its own transaction, so a FAILURE cannot leave one
     of the two NEW rows behind. Either both are committed or neither is.
     That is the guarantee, and it is the one that stops an SMS grant being
     recorded with no trace of the voice decision beside it.

   * ON CONFLICT DO NOTHING is evaluated PER ROW, not for the
     statement. So on a retry where one dedupe key already exists and the
     other does not, the existing row no-ops and the MISSING ONE IS
     INSERTED. That is not a hole — it is the behaviour that HEALS a
     partial state (one left by some earlier phase, a manual insert, or a
     future non-website writer) instead of refusing to touch it. All-or-
     nothing on retry would be strictly worse: it would leave the gap.

   * A fully duplicated retry inserts nothing and SUCCEEDS. Nothing was
     written and nothing needed to be — the events are already in the
     ledger, which is the answer the caller wanted.

   So: no half-write on failure; convergence, not refusal, on retry. Both
   follow from deterministic dedupe keys, and neither weakens the other.
   --------------------------------------------------------------------- */
export function buildInsert(rows, { columns = LEDGER_COLUMNS } = {}) {
  if (!Array.isArray(rows) || !rows.length)
    throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "rows");

  const params = [];
  const tuples = rows.map((r) => {
    const placeholders = columns.map((col) => {
      params.push(r[col]);
      return "$" + params.length;
    });
    return "(" + placeholders.join(", ") + ")";
  });

  const text =
    "INSERT INTO " + LEDGER_TABLE + " (" + columns.join(", ") + ")\n" +
    "VALUES " + tuples.join(", ") + "\n" +
    /* A conflict is SUCCESS, per row. It means that exact event is already
       in the ledger, which is the answer a retry wants; any sibling row
       that is NOT already there is still inserted.

       NO CONFLICT TARGET, DELIBERATELY. `ON CONFLICT (dedupe_key)` reads
       better and was what this module sent until 10 September 2026, when
       every preview submission failed with SQLSTATE 42501. Naming a
       conflict target — a column list OR `ON CONSTRAINT <name>` — makes
       Postgres require SELECT on the table, because inferring the arbiter
       index is a read. The application role holds INSERT and nothing else,
       on purpose: a leaked CONSENT_LEDGER_URL must not be able to
       enumerate the numbers and consent decisions this table holds.

       The bare clause needs no SELECT and is per-row all the same, so
       every property documented below survives: a replay no-ops, and a
       replay against a ledger holding one of the two rows inserts the
       other. Verified against Postgres 16 with this migration and a role
       granted INSERT only.

       What it costs: the clause now also absorbs a PRIMARY KEY collision
       instead of raising. `event_id` is a server-generated v4 UUID, so
       that is not a practical concern, but it is a real difference — such
       a row would be dropped and reported as already recorded rather than
       failing closed. There is no INSERT-only form that keeps the target,
       so this is the trade that buys the grant. */
    "ON CONFLICT DO NOTHING";

  return { text, params };
}

/* ---------------------------------------------------------------------
   I/O
   ---------------------------------------------------------------------
   The one narrow function that talks to the database, and the test seam
   that replaces it — the same shape api/_lib/security.mjs and
   api/_lib/zoho.mjs use for their own module-scoped state. No test in this
   repository ever reaches a real database.
   --------------------------------------------------------------------- */
async function neonExecutor(text, params, { url, signal }) {
  /* Imported lazily so that with the feature off — the production state
     today — the driver is never even loaded, and a deployment that never
     enables consent never pays for it. */
  const { neon } = await import("@neondatabase/serverless");
  /* The HTTP query path: no connection pool, which is what makes this
     usable inside a Vercel function, and parameterised, which is what
     makes it usable for a table that exists to be trustworthy. */
  /* `fullResults: true` is REQUIRED, not a preference. The driver's
     default returns the ROWS ONLY — a bare array — and this statement has
     no RETURNING clause, so every append would come back as `[]` whether
     it inserted two rows or none. `rowCount` is the only signal that
     distinguishes a genuine append from an ON CONFLICT DO NOTHING replay,
     and without it §9.1's first defence cannot exist.

     RETURNING WAS CONSIDERED AND IS IMPOSSIBLE HERE. `INSERT ... RETURNING`
     requires SELECT on the returned columns, and the application role
     holds INSERT and nothing else — deliberately, so a leaked
     CONSENT_LEDGER_URL cannot enumerate this table. It would fail with
     SQLSTATE 42501, exactly as naming a conflict target did on
     10 September 2026. `fullResults` reads the command tag Postgres
     already sends, and needs no privilege at all. */
  const sql = neon(url, { fetchOptions: { signal }, fullResults: true });
  return sql.query(text, params);
}

let executor = neonExecutor;

/** Test seam. Never called by production code. */
export function _setExecutor(fn) { executor = fn; }
export function _resetExecutor() { executor = neonExecutor; }

/* ---------------------------------------------------------------------
   HOW MANY ROWS ACTUALLY LANDED
   ---------------------------------------------------------------------
   `null` means UNKNOWN, and unknown is NOT zero and NOT one.

   That distinction is the whole point. A caller deciding whether to run
   the unsuppression projection must treat unknown as "do not project",
   the same as a replay — because projecting on a lane that is currently
   and correctly suppressed silently reopens the door this workflow exists
   to open only deliberately (§9.1). `null` compares false against every
   `> 0` test, so the fail-closed answer is also the default one.

   Deliberately strict about what counts as a real number: a driver, proxy
   or stub that omits `rowCount`, sends it as a string, or sends something
   negative or fractional yields `null` rather than a guess. A guess here
   would be indistinguishable from a measurement to every caller. */
export function rowsAffectedOf(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const n = result.rowCount;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * Send one statement, bounded. Shared by every append in this module so
 * that the timeout, the abort and the error containment cannot drift apart
 * between the consent path and the suppression path.
 *
 * RETURNS THE DRIVER'S RESULT. Until 15 September 2026 it discarded it,
 * which is why appendSuppressionEvents() could only report the count it
 * was given rather than the count Postgres applied.
 */
async function runStatement(text, params, { url, timeoutMs }) {
  const ctrl = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new ConsentLedgerError(LEDGER_TIMEOUT, String(timeoutMs) + "ms"));
    }, timeoutMs);
  });

  try {
    /* The race is the guarantee, not the signal: a driver that ignores an
       abort must still not be able to hold a request open.

       The winner's VALUE is now returned. `deadline` only ever rejects, so
       a resolved race is always the executor's own result. */
    return await Promise.race([
      executor(text, params, { url, signal: ctrl.signal }),
      deadline,
    ]);
  } catch (err) {
    if (err?.ledgerFailed) throw err;
    /* Nothing of the driver's error TEXT survives — only the class name
       and symbolic code, whitelisted by driverShape(). */
    throw new ConsentLedgerError(LEDGER_APPEND_FAILED, "", driverShape(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Append this submission's consent events. Resolves `{ appended: true }`
 * or THROWS — there is no third answer, and no partial one.
 *
 * The caller (api/lead.js) marks `payload.consent.durable = true` only
 * after this resolves. Everything downstream that could grant a permission
 * reads that marker, so a failure here withholds the grant while leaving
 * the lead and the operator-visible evidence copy fully intact.
 */
export async function appendConsentEvents(evidence, {
  env = process.env, timeoutMs = LEDGER_TIMEOUT_MS, source = SOURCE_WEBSITE,
} = {}) {
  const url = String(env[LEDGER_URL_VAR] || "").trim();
  /* Deliberately NOT a 503 to the visitor. The lead is not the casualty of
     an evidence outage; the permission is. */
  if (!url) throw new ConsentLedgerError(LEDGER_NOT_CONFIGURED, LEDGER_URL_VAR);

  const rows = buildLedgerEvents(evidence, { source });
  const { text, params } = buildInsert(rows);
  const result = await runStatement(text, params, { url, timeoutMs });

  /* Deliberately silent on success. api/lead.js logs the append against
     the submission it belongs to; a second line here would say the same
     thing about the same event from a module that knows less about it.

     `events` KEEPS ITS MEANING HERE — the number of rows BUILT — and that
     is not the trap it was on the suppression path, because the question
     this path asks is different. api/lead.js sets `consent.durable = true`
     when this resolves, and on a replay 0 rows are inserted precisely
     BECAUSE the events are already in the ledger. Durable is the correct
     answer to "are they recorded?" at 0 rows and at 2. The unsuppression
     path asks "did I just record a NEW clearance?", where 0 must mean no.
     Same number, opposite meaning; hence `rowsAffected` is reported
     separately rather than folded into one field that must serve both. */
  return { appended: true, events: rows.length, rowsAffected: rowsAffectedOf(result) };
}

/* =====================================================================
   SUPPRESSION EVENTS — Gate 7
   =====================================================================
   A STOP, a spoken do-not-call, or a natural-language opt-out. These
   arrive from a provider webhook, never from the website, and they are the
   only events in this table that carry consumer free text.

   Design: docs/updates/2026-09-10-stop-dnc-suppression-decision.md.

   Two things differ from a consent event and both are deliberate:

   * `submission_id` is NULL. A suppression is not about a form submission;
     it is about a NUMBER. Correlation is by phone_e164 and by
     source_event_id (the provider's message or call id).

   * `evidence_text` carries the consumer's exact words — but ONLY for a
     message classified as an opt-out. Ordinary inbound conversation
     produces no row at all. The message IS the evidence of the opt-out,
     which is why it is stored; that argument does not extend to a question
     about a showing, and this table cannot delete what it is given.
   ===================================================================== */

/* Exported because the operator action must cap the consumer's words
   BEFORE sealing them into its token — the words written to the ledger
   have to be byte-identical to the words the operator read in the
   notification email, so exactly one function may decide where they are
   cut. A second implementation of this rule is a second answer. */
/** Cap the consumer's words without silently losing that they were cut. */
export function capEvidence(text) {
  const value = String(text == null ? "" : text);
  if (Buffer.byteLength(value, "utf8") <= EVIDENCE_TEXT_MAX_BYTES) return value;
  /* Byte-safe truncation: slice on bytes, then drop any partial trailing
     character rather than writing a broken one into the evidence. */
  const cut = Buffer.from(value, "utf8")
    .subarray(0, EVIDENCE_TEXT_MAX_BYTES - 16)
    .toString("utf8")
    .replace(/�+$/, "");
  return cut + "…[truncated]";
}

/** One value from a closed list, or a refusal naming the FIELD, never the value. */
function requireOneOf(value, allowed, field) {
  const v = requireText(value, field);
  if (!allowed.includes(v))
    throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, field + ":unknown");
  return v;
}

/* ---------------------------------------------------------------------
   THE `unsuppressed` CONTRACT
   ---------------------------------------------------------------------
   Enforced here, BEFORE any database call, because this table has no
   UPDATE and no DELETE grant: a row that is wrong is wrong forever.

   WHAT IS AND IS NOT CHECKED AT THIS LAYER, stated plainly so a reader
   does not assume more:

   PROVABLE FROM BUILDER INPUT ALONE, and therefore enforced —
   * the reason code is one of exactly two;
   * `recorded_in_error` carries a known `error_origin`;
   * `recorded_in_error` names at least one target, and every target is a
     well-formed `dedupe_key`;
   * every target's CHANNEL matches this event's own lane. A dedupe_key is
     `source:source_event_id:channel:event_type` by construction, so the
     lane is readable from the key itself with no table access
     (§5.4 rule 2 requires this in the builder AND in the fold);
   * every target names an event type the fold can actually treat as
     blocking;
   * `consumer_request` names nothing, so it can never act as a targeted
     correction, and carries no `error_origin` to assert.

   NOT PROVABLE HERE, and deliberately NOT pretended —
   * THAT A NAMED TARGET EXISTS, or is currently active. That needs a read
     (`get_active_blocks`), which this module holds no privilege for and
     must not acquire — the whole point of the INSERT-only grant. The
     endpoint does it as its pre-append read (§4.2, §7.4) and a target that
     is not active is a 400 that writes nothing. A key matching no row is
     inert in the fold, so this gap fails CLOSED for the consumer; what it
     cannot do is stop an operator believing she fixed something.
   * CONSUMER ATTESTATION AND TOKEN SEMANTICS. They belong to the endpoint
     that authenticates the human, not to the module that formats a row.
   --------------------------------------------------------------------- */
/**
 * The evidence an AUTOMATIC lane clearance must carry, checked before any
 * database call because this table has no UPDATE and no DELETE grant.
 *
 * RETURNS THE METADATA THAT WILL BE STORED, canonicalised — for exactly the
 * reason the `invalidates` list is canonicalised above. Validating a trimmed
 * value and storing the untrimmed one would make every rule here decorative
 * the moment anyone tried to join on it.
 */
function validateProviderConfirmation(ch, metadata) {
  const confirmation = requireOneOf(
    metadata.reoptin_confirmation, Object.values(REOPTIN_CONFIRMATION),
    "metadata.reoptin_confirmation");

  /* THE CONSENT THIS CLEARANCE RESTS ON, named by the only identifier a
     caller holding no SELECT can derive: `source:source_event_id:channel:
     event_type`, which db/001 declares NOT NULL UNIQUE so it names at most
     one row. `event_id` was rejected for the same reason db/003 rejected it:
     learning it needs the table read the privilege model forbids. */
  const rawKey = metadata.consent_dedupe_key;
  if (typeof rawKey !== "string")
    throw new ConsentLedgerError(
      LEDGER_EVIDENCE_INCOMPLETE, "metadata.consent_dedupe_key:not_a_key");
  const key = rawKey.trim();
  const parts = key.split(":");
  if (parts.length !== 4 || parts.some((x) => !x))
    throw new ConsentLedgerError(
      LEDGER_EVIDENCE_INCOMPLETE, "metadata.consent_dedupe_key:malformed_key");
  /* Only a submission that DISPLAYED a disclosure can evidence agreement to
     one, and only a ticked box is an agreement. A provider or operator row
     carries no disclosure text; `consent_not_selected` is the record of NOT
     ticking and must never be cited as a grant. */
  if (parts[0] !== SOURCE_WEBSITE)
    throw new ConsentLedgerError(
      LEDGER_EVIDENCE_INCOMPLETE, "metadata.consent_dedupe_key:not_website");
  if (parts[2] !== ch)
    throw new ConsentLedgerError(
      LEDGER_EVIDENCE_INCOMPLETE, "metadata.consent_dedupe_key:cross_channel");
  if (parts[3] !== EVENT_TYPE.CONSENT_SELECTED)
    throw new ConsentLedgerError(
      LEDGER_EVIDENCE_INCOMPLETE, "metadata.consent_dedupe_key:not_a_consent");

  /* When that agreement was given. Stored so the clearance can be audited
     without a second lookup, and required so a caller cannot cite a key it
     never actually read. */
  const consentAt = requireInstant(
    metadata.consent_occurred_at, "metadata.consent_occurred_at");

  return {
    ...metadata,
    reoptin_confirmation: confirmation,
    consent_dedupe_key: key,
    consent_occurred_at: consentAt,
  };
}

function validateUnsuppression(ch, src, reasonCode, metadata) {
  /* RETURNS THE METADATA THAT WILL BE STORED, canonicalised. Validating one
     value and storing a different one is how a rule becomes decorative:
     see the `invalidates` trim below. */

  /* WHO MAY LIFT A BLOCK — narrowed 21 September 2026, not widened open.
     The approved design's first decision was that NO AUTOMATIC PATH WRITES
     `unsuppressed` (§4.1, §11: source is `operator`, "a human did this, and
     no other source may"), and the reason it was worth having is unchanged:
     refusing only SOURCE_WEBSITE — which is all the general check in
     buildSuppressionEvent() does — leaves every other source able to format
     a perfectly valid clearance, so an inbound webhook could lift the
     suppression a STOP had just created.

     `twilio` is now the ONE admitted automatic source, and it buys none of
     that back: it is admitted only for the `sms` lane, only with reason
     `consumer_request`, and only carrying a confirmation block that names
     the website consent it rests on. `retell`, `system`, a script and
     anything else are refused here exactly as before, and
     `recorded_in_error` stays a human's judgement in every case. The full
     fence, and why each part of it is load-bearing, is at
     AUTOMATIC_UNSUPPRESSION_SOURCES above. */
  const automatic = src !== SOURCE_OPERATOR;
  if (automatic && !AUTOMATIC_UNSUPPRESSION_SOURCES.includes(src))
    throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "source:not_operator");
  /* The lane fence, applied before anything else an automatic clearance
     could be judged on. `all` and `ai_voice` are a human's to clear. */
  if (automatic && !AUTOMATIC_UNSUPPRESSION_CHANNELS.includes(ch))
    throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "channel:not_automatic");

  const reason = requireOneOf(reasonCode, Object.values(UNSUPPRESSION_REASON), "reason_code");

  /* A JSON scalar, an array or null where an object belongs is refused
     rather than coerced to `{}` — the coercion would turn a malformed
     `recorded_in_error` into one naming nothing, which §5.4 rule 3 says
     must never become a lane clearance in disguise. */
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
    throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "metadata");

  const targets = metadata.invalidates;
  const origin = metadata.error_origin;

  if (reason === UNSUPPRESSION_REASON.CONSUMER_REQUEST) {
    /* A LANE CLEARANCE names nothing. Absent or `[]` only: anything else
       would be a targeted correction wearing a lane clearance's reason
       code, and db/003 would apply the LANE rule to it — clearing far more
       than the operator named. Refused, not silently ignored. */
    if (targets !== undefined && targets !== null) {
      if (!Array.isArray(targets))
        throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "metadata.invalidates");
      if (targets.length)
        throw new ConsentLedgerError(
          LEDGER_EVIDENCE_INCOMPLETE, "metadata.invalidates:not_empty");
    }
    /* No cause is being asserted, so none may be recorded. */
    if (origin !== undefined && origin !== null)
      throw new ConsentLedgerError(
        LEDGER_EVIDENCE_INCOMPLETE, "metadata.error_origin:not_applicable");
    return automatic ? validateProviderConfirmation(ch, metadata) : metadata;
  }

  /* recorded_in_error — a TARGETED INVALIDATION, AND A HUMAN'S JUDGEMENT.
     Deciding that a record was wrong is a statement about the record, which
     no webhook is in a position to make. The automatic path may only say
     "the consumer asked for this lane back", never "that row should not
     have been written". */
  if (automatic)
    throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "reason_code:not_automatic");

  requireOneOf(origin, Object.values(UNSUPPRESSION_ERROR_ORIGIN), "metadata.error_origin");

  if (!Array.isArray(targets))
    throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "metadata.invalidates");
  /* §5.4 rule 3: naming nothing invalidates nothing, and must never
     degrade into a lane clearance. Refused at the builder AND inert in the
     fold — the original defect in its mirror image. */
  if (!targets.length)
    throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "metadata.invalidates:empty");

  const seen = new Set();
  /* THE CANONICAL KEYS, and they are what gets stored. db/003's fold joins
     `metadata.invalidates` to `dedupe_key` with `=`, so a key stored with
     surrounding whitespace matches NOTHING — the correction would be
     silently inert while the operator was told it worked, which is the
     precise failure §5.4 is written to prevent. Trimming for the check and
     storing the raw value would have made every rule below decorative. */
  const canonical = [];
  for (const raw of targets) {
    if (typeof raw !== "string")
      throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "metadata.invalidates:not_a_key");
    const key = raw.trim();
    if (!key)
      throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "metadata.invalidates:empty_key");

    /* dedupeKey() joins exactly four colon-free components, so a target
       must split into exactly four non-empty parts. Anything else was not
       produced by this system and cannot identify one of its rows. */
    const parts = key.split(":");
    if (parts.length !== 4 || parts.some((x) => !x))
      throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "metadata.invalidates:malformed_key");

    /* CROSS-LANE REFUSAL. db/003's fold joins invalidations to blocking
       events within one lane, so a cross-lane key would be silently inert
       there. Refused here, where the operator can still be told. */
    if (parts[2] !== ch)
      throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "metadata.invalidates:cross_channel");

    if (!INVALIDATABLE_EVENT_TYPES.includes(parts[3]))
      throw new ConsentLedgerError(
        LEDGER_EVIDENCE_INCOMPLETE, "metadata.invalidates:not_a_blocking_event");

    /* Rejected, not de-duplicated. Repeating a key cannot widen the fold
       (it is a NOT EXISTS), so this changes no semantics — but a duplicate
       means the operator's view of what she selected and the record of it
       disagree, and this repository refuses malformed input rather than
       quietly repairing it. */
    if (seen.has(key))
      throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "metadata.invalidates:duplicate");
    seen.add(key);
    canonical.push(key);
  }

  /* Only `invalidates` is rewritten. Everything else the caller recorded —
     the attestation, the intent block, the approval id — is stored as
     given, because this function validates a contract and is not licensed
     to edit an operator's account of what she did. */
  return { ...metadata, invalidates: canonical };
}

/**
 * One suppression-class row.
 *
 * `channel` is `sms`, `ai_voice` or `all`; `eventType` is `suppressed`,
 * `revoked`, `reoptin_requested` or `unsuppressed`. Both are validated
 * against CLOSED vocabularies and an unknown value is refused BEFORE any
 * database call — see SUPPRESSION_EVENT_TYPES above for why that matters
 * more here than almost anywhere else in the repository.
 *
 * The caller has already classified — this function records, it does not
 * decide. What it does do is refuse to record something the folds could
 * never read.
 */
export function buildSuppressionEvent({
  occurredAt, channel, eventType, phone, source, sourceEventId,
  reasonCode = null, evidenceText = null, metadata = null,
} = {}) {
  const at = requireInstant(occurredAt, "occurred_at");
  const ch = requireOneOf(channel, SUPPRESSION_CHANNELS, "channel");
  const type = requireOneOf(eventType, SUPPRESSION_EVENT_TYPES, "event_type");
  const src = requireText(source, "source");
  const eventId = requireText(sourceEventId, "source_event_id");
  /* Fails closed exactly as the consent path does: a suppression whose
     number cannot be normalised is not written at all, because a row that
     does not say which line it concerns proves nothing about that line. */
  const phoneE164 = toE164(phone);

  if (src === SOURCE_WEBSITE)
    throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "source:website");

  /* An `unsuppressed` row LIFTS A BLOCK, so it is the only event this
     builder writes that can make a number contactable again. It gets the
     strictest validation in the module. */
  const meta = type === EVENT_TYPE.UNSUPPRESSED
    ? validateUnsuppression(ch, src, reasonCode, metadata)
    : metadata;

  return {
    occurred_at: at,
    channel: ch,
    event_type: type,
    phone_e164: phoneE164,
    source: src,
    source_event_id: eventId,
    dedupe_key: dedupeKey({ source: src, sourceEventId: eventId, channel: ch, eventType: type }),
    /* NULL, deliberately — see the block comment above. */
    submission_id: null,
    form_type: null,
    page_path: null,
    consent_copy_version: null,
    consent_copy_text: null,
    schema_version: SCHEMA_VERSION,
    reason_code: reasonCode === null ? null : String(reasonCode),
    evidence_text: evidenceText === null ? null : capEvidence(evidenceText),
    /* `meta` is the VALIDATED, canonical object for an unsuppression and
       the caller's own for every other event type. */
    metadata: JSON.stringify(meta && typeof meta === "object" ? meta : {}),
  };
}

/**
 * Append suppression-class events. Resolves `{ appended: true, events }`
 * or THROWS, exactly like the consent path.
 *
 * The webhook that calls this returns 5xx when it throws. THAT IS THE
 * FAIL-CLOSED ANSWER AND NOT A RETRY MECHANISM: Twilio does not redeliver
 * a failed incoming-message webhook by default, and retry must be
 * configured explicitly on the Messaging Service — a change frozen under
 * the TCR hold on error 30753 and listed as a live-activation
 * prerequisite. api/twilio-inbound.js states this correctly; this comment
 * previously said "so Twilio retries", which contradicted its own caller
 * and invited a reader to treat redelivery as a property they already
 * have. Corrected 10 September 2026.
 *
 * IF a redelivery does arrive it is safe, because the dedupe key is
 * derived from the provider's own message id. That no-op behaviour was
 * measured against the live database on 10 September 2026, not assumed.
 * It is idempotency, not a guarantee that a retry happens.
 */
export async function appendSuppressionEvents(events, {
  env = process.env, timeoutMs = LEDGER_TIMEOUT_MS, urlVar = LEDGER_URL_VAR,
} = {}) {
  if (!Array.isArray(events) || !events.length)
    throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "events");

  /* The SQL and column contract stay here, in ONE module. A privileged
     operator workflow may choose its own dedicated INSERT-capable role by
     naming that role's environment variable; the website and webhook callers
     omit this option and therefore remain on CONSENT_LEDGER_URL exactly as
     before. The variable NAME is server-owned code, never request input. */
  const credentialVar = String(urlVar || "").trim();
  if (!credentialVar)
    throw new ConsentLedgerError(LEDGER_NOT_CONFIGURED, "ledger_url_var");
  const url = String(env[credentialVar] || "").trim();
  if (!url) throw new ConsentLedgerError(LEDGER_NOT_CONFIGURED, credentialVar);

  const { text, params } = buildInsert(events, { columns: SUPPRESSION_COLUMNS });
  const result = await runStatement(text, params, { url, timeoutMs });
  const rowsAffected = rowsAffectedOf(result);

  /* THREE ANSWERS, AND THEY MUST STAY DISTINGUISHABLE.

       rowsAffected > 0    this append wrote something NEW
       rowsAffected === 0  every row was already there — a replay, a no-op
       rowsAffected null   the driver did not say; treat as NOT new
       (throws)            the database failed, and nothing is recorded

     Until 15 September 2026 this returned `events: events.length` — the
     count it was HANDED, which is the same number on a genuine append and
     on a replay that inserted nothing. §9.1 names the failure that
     enables: unsuppress a lane, the consumer sends STOP again, the old
     approval URL is replayed. The ledger stays correct — the dedupe key is
     unchanged, 0 rows are inserted, the fold still reads the lane as
     blocked by the new STOP — but a caller trusting the old field sees
     "1 event appended", runs the HubSpot projection, and clears
     `cst_sms_suppressed` for a number that is currently and correctly
     suppressed. The ledger never lied; the return value did.

     `requested` is reported beside it, named for what it is. A caller that
     wants "did all of them land?" compares the two rather than assuming
     one from the other. */
  return {
    appended: true,
    requested: events.length,
    rowsAffected,
    /* Retained so an existing reader cannot silently get `undefined`, and
       now ACCURATE rather than assumed. Null when the driver was silent —
       never the input count standing in for a measurement. */
    events: rowsAffected,
  };
}
