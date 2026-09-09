# Append-only consent ledger — implementation plan

**Date:** 9 September 2026
**Status:** plan only. **Nothing is implemented.** No production change.
**Feature status:** `COMMUNICATIONS_CONSENT_ENABLED` remains OFF / absent from
Vercel Production, and this plan does not propose changing it.

This prepares activation gate 3 — *"append-only consent ledger implemented and
tested"* — in `docs/updates/2026-09-09-consent-evidence-ledger-decision.md` §3.

Read this with the design source,
`docs/updates/2026-09-09-consent-evidence-ledger-proposal.md`. That document says
*what* to build. This one says *where it goes in this codebase*, resolves four
questions the proposal leaves open, and bounds the change to the smallest thing
that is actually safe.

---

## 1. What already exists, and where the ledger attaches

Inspected on 9 September 2026. Everything below is present on `main` today.

| Concern | Owner |
|---|---|
| Feature gate, canonical disclosures, evidence construction, the pure transition | `api/_lib/consent.mjs` |
| The 23 `cst_*` HubSpot names, read/write translation | `api/_lib/hubspot-consent-state.mjs` |
| HTTP to HubSpot, contact write, form submission, 409 race | `api/_lib/hubspot.mjs` |
| Send-time permission decisions | `api/_lib/permission.mjs` |
| Request lifecycle | `api/lead.js` |
| The enquiry block, including the ten consent rows | `api/_lib/description.mjs` |

The request lifecycle relevant to consent, in `api/lead.js`:

1. origin → rate limit → body → `validateLead()`;
2. `payload.meta.submission_id` is minted (`csv_` + 96 bits, CSPRNG);
3. **if `consentFeatureEnabled()`**, `buildConsentEvidence(payload)` attaches
   `payload.consent` — server-owned timestamp, disclosure version, exact
   disclosure text, normalised phone, form type, page, submission id;
4. `createLead(payload)` writes the contact (folding consent into `cst_*` only
   when `consentStateEnabled() && payload.consent`) and then submits the HubSpot
   form, which carries the enquiry block including the ten consent rows. Both
   writes are mandatory; either failing fails the lead loudly;
5. the acknowledgement email, best-effort and fully swallowed.

**The ledger append belongs between steps 3 and 4.** That position is what makes
the proposal's failure semantics implementable: the durable evidence is written
before anything grants a permission, and `createLead()` can then be told whether
a grant is allowed to happen.

Two facts that make the insertion cheap:

- The ten timeline consent rows are appended by `description.mjs` from
  `payload.consent` alone, with no reference to the feature gate. The `cst_*`
  grant is gated separately, inside `createLead()`, by a single local
  `consentOn` expression. **The operator-visible evidence copy and the mutable
  permission state can therefore be decoupled with a one-line change.**
- The consent property *read* (`consentPropertiesToRead()`, used by
  `findContactByEmail()`) is gated on the environment only, not on the payload,
  so suppressing a write never suppresses the read that respects a STOP.

---

## 2. Four questions the proposal leaves open, and the answers

### 2.1 A failed ledger append must deny the permission without discarding the lead or the operator's evidence

The proposal says: keep the lead, keep the previous permission state, leave the
permission inactive. It does not say what happens to the timeline evidence copy.

**Decision: on a failed append, still write the timeline evidence rows, and do
not write any `cst_*` property.**

The timeline copy is not a permission — nothing reads it at send time. The
`cst_*` properties are the permission. Dropping `payload.consent` entirely would
be simpler by one line and would destroy the record that the visitor ticked the
box at all, which is the opposite of what an evidence system should do when its
evidence sink is unavailable. Keeping the row while withholding the grant fails
in the safe direction on both axes: no permission without durable evidence, no
loss of what the person actually did.

Mechanically: `buildConsentEvidence()` gains `durable: false` in its returned
object — **deny by default**, so a future refactor of `api/lead.js` that forgets
to set the marker withholds the grant rather than granting one. `api/lead.js`
sets it `true` only after a confirmed append. `createLead()`'s gate becomes:

```js
const consentOn = consentStateEnabled() && payload.consent?.durable === true;
```

### 2.2 The ledger is appended before the CRM write, and an event may outlive a failed lead

If the append succeeds and HubSpot then fails, the ledger holds consent events
for a submission that is not in the CRM. That is correct and is the reason the
append goes first: the ledger records *what the person agreed to*, which is true
whether or not HubSpot accepted the lead, and no permission exists because no
`cst_*` property was written. Evidence without permission is the safe residue;
permission without evidence is the failure this whole gate exists to prevent.

A visitor who resubmits after a HubSpot failure mints a **new** submission id, so
a second pair of events is appended. Two attempts is the honest record, and it
matches the at-least-once posture `createLead()` already documents for form
submissions.

Honeypot hits, rate-limited requests and validation failures never reach step 3,
so none of them can reach the ledger.

### 2.3 `phone_e164` — nothing in this repository produces E.164

`api/_lib/validate.mjs`'s `normalizePhone()` produces the US display form
`(419) 555-0000` for 10 digits and for 11 digits beginning `1`, and otherwise
returns what was typed. `MIN_PHONE_DIGITS` is 10 and **a phone number is
required on every submission**, so the value is never empty — but it is never
E.164 either. The proposal's `phone_e164 text not null` column has no producer.

**Decision: a pure `toE164()` in the new ledger module, used only for the ledger
column.** It accepts 10 digits and 11 digits beginning `1` (→ `+1XXXXXXXXXX`),
and a string already in `+` followed by 11–15 digits. **Anything else throws**,
which becomes a ledger append failure, which withholds the grant.

Two consequences, both deliberate:

- The HubSpot phone, the `cst_*` consent phone and the timeline evidence rows are
  **unchanged**. Only the ledger column is converted. `permission.mjs` compares
  numbers by digits after `normalizePhone()` and is untouched.
- A non-North-American number would be refused a *grant* while its lead is stored
  normally. For a Toledo listing practice that is the correct fail-closed
  direction; it is recorded here so it is a known consequence and not a bug
  report later.

### 2.4 `hubspot_contact_id` cannot be backfilled under an INSERT-only role

The contact id is not known until `createLead()` returns, which is after the
append. The production role has no `UPDATE`, by design, so the column can never
be filled in later.

**Decision: keep the column (the STOP/DNC phases, which run after a contact is
known, will populate it) and accept that website events leave it null.
Correlation for website events is by `submission_id`, which appears in the
ledger, in the HubSpot enquiry block, in the acknowledgement email and in every
log line for the request.** This is written down rather than discovered.

---

## 3. The change set

Six files. Nothing else is touched.

### 3.1 New — `api/_lib/consent-ledger.mjs`

The only module that knows the table, the column names and the connection. It
follows the shape of `hubspot-consent-state.mjs`: the pure parts are exported
and directly testable, the I/O is one narrow function.

```
LEDGER_URL_VAR              = "CONSENT_LEDGER_URL"
CHANNEL                     frozen: sms, ai_voice, all
EVENT_TYPE                  frozen: consent_selected, consent_not_selected,
                                    reoptin_requested, revoked,
                                    suppressed, unsuppressed
SCHEMA_VERSION              = 1

consentLedgerConfigured(env)          → boolean
toE164(phone)                         → "+1…"        pure; throws on refusal
dedupeKey({ source, sourceEventId, channel, eventType })  → string, pure
buildLedgerEvents(evidence)           → [smsRow, aiVoiceRow], pure
appendConsentEvents(evidence, opts)   → { appended: true }; throws otherwise
ledgerLogShape(err)                   → PII-free classification
_setExecutor(fn) / _resetExecutor()   test seam, as security.mjs does
```

`buildLedgerEvents()` emits **one row per channel per submission**, per the
proposal: ticked → `consent_selected`, unticked → `consent_not_selected`.
`consent_not_selected` is never a revocation — a comment in the module says so,
because that is the misreading that would do the damage.

`appendConsentEvents()` issues **one parameterised multi-row `INSERT … ON
CONFLICT (dedupe_key) DO NOTHING`**, in a single statement. Both channel rows
land together or neither does; a half-recorded submission is not a state this
system can be in. A conflict is success — a retry finding its own earlier row is
exactly what deterministic keys are for.

Dedupe keys for this phase:

```
website:<submission_id>:sms:consent_selected
website:<submission_id>:sms:consent_not_selected
website:<submission_id>:ai_voice:consent_selected
website:<submission_id>:ai_voice:consent_not_selected
```

Columns written by the website path: `occurred_at` (`meta.submitted_at`,
server-owned), `channel`, `event_type`, `phone_e164`, `source` (`"website"`),
`source_event_id` (the submission id), `dedupe_key`, `submission_id`,
`form_type`, `page_path`, `consent_copy_version`, `consent_copy_text`,
`schema_version`. `recorded_at` is the database default.

Never written, per the proposal's PII minimisation: property address, lead
message, name, email, IP address. Identity in the ledger is the phone the
consent binds to plus the submission id — the minimum that proves a
communication permission.

Timeout 3 s, hard. The function already awaits an SMTP send inside a 30 s
`maxDuration`; three more seconds in the worst case is affordable, and a hanging
evidence write must not become a hanging lead.

### 3.2 `api/_lib/consent.mjs`

Add `durable: false` to the object returned by `buildConsentEvidence()`, with a
comment saying it is deny-by-default. No other change. The disclosures, the
version constants, `applySubmissionConsent()` and `consentRows()` are untouched —
`durable` deliberately does **not** appear in the timeline rows (see §5).

### 3.3 `api/lead.js`

Inside the existing `if (consentFeatureEnabled())` block, after
`buildConsentEvidence()`:

```js
try {
  await appendConsentEvents(payload.consent);
  payload.consent.durable = true;
  log("lead.consent.ledger_appended", { submission_id: sid });
} catch (ledgerErr) {
  /* The lead still goes to HubSpot with its timeline evidence. What does
     NOT happen is a cst_* grant: a permission with no durable evidence
     behind it is the one outcome the ledger exists to prevent. */
  log("lead.consent.ledger_failed", { submission_id: sid, ...ledgerLogShape(ledgerErr) });
}
```

`log()`, not `logError()` — `logError()` emits `err.message`, and a driver error
can carry a connection string. Only the classification is safe. This mirrors the
existing treatment of Nodemailer errors a few lines below.

### 3.4 `api/_lib/hubspot.mjs`

One line — `consentOn` additionally requires `payload.consent.durable === true`,
with a comment naming why. The consent *read*, the 409 re-fetch and the
suppression precedence are unchanged.

### 3.5 `tools/check.mjs`

Static guards, all cheap, in the existing consent section:

- add `CONSENT_LEDGER_URL` to `SECRET_NAMES` (line ~174) so it can never appear
  in anything delivered to the browser;
- `api/_lib/consent-ledger.mjs` must not read an IP address — the same regex
  already applied to `consent.mjs`;
- no file outside `consent-ledger.mjs` may name the table or its columns, the
  same containment rule already enforced for `cst_*` names;
- `api/_lib/hubspot.mjs` must still require the durability marker in `consentOn`
  — a regex guard, in the style of the existing "validate.mjs no longer parses
  consent through consent.mjs" guard. This is the invariant a well-meaning
  refactor is most likely to delete.

### 3.6 New — `db/001_communication_consent_events.sql`

The proposal's table verbatim, plus the role grants, plus indexes on
`(phone_e164, occurred_at)` and `(submission_id)`. Checked into the repository;
**applied by a human with the owner credential.** The application never runs
DDL and never holds a credential that could.

`.env.example` gains a documented, empty `CONSENT_LEDGER_URL` in a new section
that states plainly: server-side only, never `NEXT_PUBLIC_`, and that the value
must be the **application** role's connection string, not the owner's.

---

## 4. Failure semantics

| Situation | Lead | Timeline evidence | `cst_*` grant | Ledger |
|---|---|---|---|---|
| Feature OFF (today) | written | none | none | **not called at all** |
| Feature ON, append succeeds | written | written | written | 2 rows |
| Feature ON, append fails or times out | **written** | written | **none** | nothing |
| Feature ON, `CONSENT_LEDGER_URL` absent | written | written | **none** | nothing |
| Feature ON, phone not convertible to E.164 | written | written | **none** | nothing |
| Append succeeds, HubSpot then fails | 502 to visitor | none | none | 2 rows (see §2.2) |

A missing `CONSENT_LEDGER_URL` while the feature is on is deliberately **not** a
503. The lead is not the casualty of an evidence outage; the permission is.

Revocations, STOP and DNC invert this priority — suppress first, append after,
retry and alert. **Not in this phase**; §6.

---

## 5. Deliberately not done, and why

- **No operator-visible signal in the enquiry block that the ledger append
  failed.** An operator could see `SMS CONSENT: GRANTED` in the timeline while
  the contact's `cst_sms_permission_status` reads `never_granted`, with only a
  log line to explain it. The clean fix is an eleventh consent row
  (`CONSENT LEDGER: RECORDED` / `NOT RECORDED`), which is genuinely cheap —
  `description.mjs` already drops blank rows, so the block has no fixed length —
  but it changes `CONSENT_LABELS` and the enquiry-block assertions, and it is not
  needed for a phase where the feature is off and no lead is affected. Recorded
  here so the next phase can take it deliberately.
- **`hubspot_contact_id` stays null on website events** (§2.4).
- **`reason_code`, `evidence_text`, `metadata` and the `all` channel are created
  but unused.** The full table ships now so the STOP/DNC phase needs no second
  migration against an append-only table.
- **No read path, no admin query tool, no export.** Nothing yet needs to read the
  ledger; `SELECT` is granted narrowly so the round-trip verification (gate 4)
  can be done with the application role.

---

## 6. Explicitly out of scope

STOP processing, DNC processing, suppression *writing*, re-opt-in and
unsuppression, `reoptin_requested` events, webhooks, send-time enforcement, any
Twilio or Retell integration, and **enabling `COMMUNICATIONS_CONSENT_ENABLED`**.
Gates 4–10 remain outstanding after this phase; this phase closes gate 3 only.

---

## 7. Testing

**Tier 4** — compliance, evidence and permission. Targeted, never the full suite
locally. No live database in CI: the executor seam is injected, exactly as the
HubSpot tests stub `globalThis.fetch`.

New `tests/consent-ledger.test.mjs`:

- `toE164()` — 10 digits, `1`-prefixed 11 digits, an already-`+` number, and the
  refusals; refusal must surface as an append failure, not a thrown lead;
- `dedupeKey()` — deterministic, distinct per channel and per event type;
- `buildLedgerEvents()` — one row per channel; unticked yields
  `consent_not_selected` and **never** a revocation event type; the exact
  disclosure text and version are the server's, not the request's;
- **PII containment** — assert the built rows contain no name, email, property
  address, lead message or IP, by asserting against the actual values in
  `validHomeValue`, not against a column allow-list;
- **atomicity** — a failing executor appends neither row;
- **idempotency** — replaying the same submission id produces the same keys and
  the conflict path reports success.

Added to `tests/consent-state.test.mjs` (where the grant invariants already
live), because these are the assertions that matter most:

- append fails ⇒ **no `cst_*` property is present in the HubSpot request body**,
  and the contact write and form submission still happen;
- append fails ⇒ a prior `granted` state is **not** blanked, and a prior
  suppression is **not** cleared;
- append succeeds ⇒ the existing fold behaviour is byte-identical to today's;
- **feature OFF ⇒ the ledger module's executor is never invoked**, and the
  HubSpot request bodies are unchanged from the pre-ledger baseline.

`npm test` in CI is the release gate. One CI run.

---

## 8. Human actions required before this phase can be marked done

Code alone does not close gate 3.

1. Provision **Neon Postgres via the Vercel Marketplace** (proposal §"Recommended
   storage"). Region: same as the function.
2. Apply `db/001_communication_consent_events.sql` **with the owner credential**.
3. Create the application role with **`INSERT` and narrow `SELECT` only** — no
   `UPDATE`, no `DELETE`, no `TRUNCATE`, no DDL ownership, no table ownership.
   Verify by attempting an `UPDATE` and a `DELETE` as that role and confirming
   both are refused. **Append-only is a database grant, not a code convention**;
   if this step is skipped the ledger is an ordinary mutable table and gate 3 is
   not met however good the code is.
4. Set `CONSENT_LEDGER_URL` in Vercel to the **application** role's string. The
   owner credential must never reach the Vercel application.
5. Keep a separate privileged path, off Vercel, for migrations and legally
   required privacy deletion. Append-only does not override a deletion
   obligation.
6. Gate 4 (controlled ledger round-trip) is a **live** exercise against a preview
   deployment and cannot be satisfied by any test in this repository.

---

## 9. Dependency

`@neondatabase/serverless`, pinned. It is the first runtime dependency added
since `nodemailer` and the only one this phase needs; its HTTP query path works
inside a Vercel function without a connection pool, and it parameterises queries.
The alternative — hand-rolled HTTP against Neon's SQL endpoint, no new dependency
— was considered and rejected: writing our own parameterisation for the one table
that exists to be trustworthy is a poor trade for one fewer dependency.

---

## 10. What is unproven

Everything here. **No code has been written and nothing has been run.** No Neon
database exists, no migration has been applied, no role has been created, no
append has ever been attempted, and the E.164 refusal behaviour has never been
observed. The failure-semantics table in §4 describes intended behaviour, not
measured behaviour.

`COMMUNICATIONS_CONSENT_ENABLED` remains OFF. This document changed no HubSpot
record, form, workflow or property; no Vercel setting; no Twilio or Retell
configuration; no lead, no SMS, no call.
