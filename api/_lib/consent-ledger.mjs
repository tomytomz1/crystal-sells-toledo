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
   The deterministic key behind `ON CONFLICT (dedupe_key) DO NOTHING`. A
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

   * ON CONFLICT (dedupe_key) DO NOTHING is evaluated PER ROW, not for the
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
export function buildInsert(rows) {
  if (!Array.isArray(rows) || !rows.length)
    throw new ConsentLedgerError(LEDGER_EVIDENCE_INCOMPLETE, "rows");

  const params = [];
  const tuples = rows.map((r) => {
    const placeholders = LEDGER_COLUMNS.map((col) => {
      params.push(r[col]);
      return "$" + params.length;
    });
    return "(" + placeholders.join(", ") + ")";
  });

  const text =
    "INSERT INTO " + LEDGER_TABLE + " (" + LEDGER_COLUMNS.join(", ") + ")\n" +
    "VALUES " + tuples.join(", ") + "\n" +
    /* A conflict is SUCCESS, per row. It means that exact event is already
       in the ledger, which is the answer a retry wants; any sibling row
       that is NOT already there is still inserted. */
    "ON CONFLICT (dedupe_key) DO NOTHING";

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
  const sql = neon(url, { fetchOptions: { signal } });
  return sql.query(text, params);
}

let executor = neonExecutor;

/** Test seam. Never called by production code. */
export function _setExecutor(fn) { executor = fn; }
export function _resetExecutor() { executor = neonExecutor; }

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
       abort must still not be able to hold a lead open. */
    await Promise.race([
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

  /* Deliberately silent on success. api/lead.js logs the append against
     the submission it belongs to; a second line here would say the same
     thing about the same event from a module that knows less about it. */
  return { appended: true, events: rows.length };
}
