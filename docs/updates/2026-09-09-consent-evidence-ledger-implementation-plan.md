# Append-only consent ledger — implementation plan

**Date:** 9 September 2026
**Status:** plan only. **Nothing is implemented.** No production change.
**Feature status:** `COMMUNICATIONS_CONSENT_ENABLED` remains OFF / absent from
Vercel Production, and this plan does not propose changing it.

This prepares activation gate 3 — *"append-only consent ledger implemented and
tested"* — in `docs/updates/2026-09-09-consent-evidence-ledger-decision.md` §3.

Read this with the design source,
`docs/updates/2026-09-09-consent-evidence-ledger-proposal.md`. That document says
*what* to build. This one says *where it goes in this codebase*, resolves five
gaps in the proposal — four open questions and one schema defect that would fail
on the first real append — and bounds the change to the smallest thing that is
actually safe.

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

## 2. Five gaps in the proposal, and the answers

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

**And the operator is told.** Keeping the timeline row while withholding the
grant creates a discrepancy a human will meet without explanation: the activity
says `SMS CONSENT: GRANTED` while the contact's `cst_sms_permission_status`
correctly reads `never_granted`. Read cold, that looks like the integration
dropped a consent. An eleventh consent row now states the durability of the
evidence outright — `CONSENT LEDGER: RECORDED` or `CONSENT LEDGER: NOT
RECORDED` — so the block explains itself without anyone reading a log. §3.2
and §3.5 build it; an earlier draft deferred it, and that was wrong: the
discrepancy is created by this phase, so it is this phase's to explain.

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

### 2.5 `event_id` has no default, and the INSERT does not supply one

The proposal's table declares `event_id uuid primary key` with **no default**,
and its website INSERT supplies no `event_id`. A primary key is `NOT NULL`, so
the first real append would fail outright: the table as specified cannot accept
the write it exists for. This is not a judgement call, it is a defect.

**Decision: the migration gives the column
`DEFAULT gen_random_uuid()`, and neither the application nor its role is
involved in minting or maintaining it.** `gen_random_uuid()` is core PostgreSQL
from version 13 and needs no extension on Neon; where an older server made
`pgcrypto` necessary that is owner-time setup, never the application's. The DDL,
the grant consequences — including that **no sequence grant is needed**, which
corrects the proposal's role sketch — and the rejected alternative of minting
the UUID in Node are in §3.7.

---

## 3. The change set

**Sixteen files.** The count has been wrong twice. A first draft said "six
files, nothing else is touched", counting only the modules carrying the logic
and omitting the dependency, the environment documentation, the tests and the
migration; correcting that gave thirteen. Bringing the operator-visible ledger
row into scope adds three more — the label list it must appear in, the test that
pins that list, and the operator procedure that describes the block. The
complete set is below; anything not listed here is out of scope for this
phase.

| # | File | New / Modified | Why |
|---|---|---|---|
| 1 | `api/_lib/consent-ledger.mjs` | **New** | The only module that knows the table, the columns and the connection (§3.1) |
| 2 | `api/_lib/consent.mjs` | Modified | `durable: false` on the evidence — deny by default (§3.2) |
| 3 | `api/lead.js` | Modified | The append, between evidence and `createLead()` (§3.3) |
| 4 | `api/_lib/hubspot.mjs` | Modified | One line: `consentOn` requires the durability marker (§3.4) |
| 5 | `api/_lib/description.mjs` | Modified | `CONSENT_LABELS` gains `CONSENT LEDGER`, and the docstring says eleven rows (§3.5) |
| 6 | `tools/check.mjs` | Modified | Static guards: secret name, no IP, name containment, the `consentOn` regex (§3.6) |
| 7 | `db/001_communication_consent_events.sql` | **New** | The table, its `event_id` default, indexes and grants (§3.7) |
| 8 | `.env.example` | Modified | Documented, empty `CONSENT_LEDGER_URL` (§3.8) |
| 9 | `package.json` | Modified | `@neondatabase/serverless`, pinned (§9) |
| 10 | `package-lock.json` | Modified | Regenerated by `npm install`, never hand-edited |
| 11 | `tests/consent-ledger.test.mjs` | **New** | The module's own Tier 4 tests (§7) |
| 12 | `tests/consent-state.test.mjs` | Modified | The grant-withholding invariants, where the grant invariants already live (§7) |
| 13 | `tests/consent.test.mjs` | Modified | Pins `CONSENT_LABELS` and the enquiry block; gains the ledger-row assertions (§7) |
| 14 | `docs/updates/<date>-consent-evidence-ledger.md` | **New** | A write-up **is** warranted: this phase changes an external integration, an environment variable and the evidence/security model |
| 15 | `docs/updates/2026-09-09-hubspot-consent-setup.md` | Modified | Its §6a operator procedure prints the expected block and is what gate 5 is executed against (below) |
| 16 | `docs/CURRENT-STATE.md` | Modified | The ledger stops being "not built"; gate 3 closes |

**`docs/updates/2026-09-09-communications-consent-foundation.md` is deliberately
NOT updated**, though it also prints a ten-row sample block. It is a dated record
of what the foundation phase shipped, and it was accurate. The setup document is
different in kind: its §6a section is a **procedure a human executes** — it is
the gate 5 operator check — and an operator following it would look for ten rows
and find eleven. A live procedure gets corrected; a historical write-up does not
get rewritten. The new write-up (14) carries the current eleven-row block, and
`CURRENT-STATE.md` routes to it.

`package.json` gains no new script. `tools/build.mjs`, `src/`, `assets/` and
every other module under `api/_lib/` are untouched — the ledger changes no
rendered page and no visitor-facing behaviour. `api/_lib/zoho.mjs` also calls
`buildDescription()` and would render the new row, but it is dormant rollback
code imported by nothing and needs no change.

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
`schema_version`.

**`event_id` and `recorded_at` are deliberately NOT in the INSERT column list.**
Both are database defaults (§3.7), and the module contains no UUID generation of
its own — `node:crypto`'s `randomUUID()` is not imported. An event's identity is
minted by the store that guarantees its uniqueness, which keeps the one thing a
primary key must be true about out of the reach of application code that has no
`UPDATE` privilege to repair it with.

Never written, per the proposal's PII minimisation: property address, lead
message, name, email, IP address. Identity in the ledger is the phone the
consent binds to plus the submission id — the minimum that proves a
communication permission.

Timeout 3 s, hard. The function already awaits an SMTP send inside a 30 s
`maxDuration`; three more seconds in the worst case is affordable, and a hanging
evidence write must not become a hanging lead.

### 3.2 `api/_lib/consent.mjs`

Two changes.

**`buildConsentEvidence()` gains `durable: false`**, with a comment saying it is
deny-by-default. The disclosures, the version constants and
`applySubmissionConsent()` are untouched.

**`consentRows()` gains an eleventh row, first in the list:**

```js
["CONSENT LEDGER", evidence.durable === true ? "RECORDED" : "NOT RECORDED"],
```

**First, not last.** The row qualifies every claim below it, and an operator who
reads `SMS CONSENT: GRANTED` before reaching the caveat has already formed the
belief the caveat exists to prevent. The caveat goes above the claim.

Both values are non-empty strings, deliberately. `buildDescription()` renders
every row unconditionally and substitutes `-` for a blank value, so a design that
emitted nothing on success would print `CONSENT LEDGER: -` — worse than either
real value. `=== true` rather than a truthy test keeps it deny-by-default: a
missing marker, an `undefined`, an evidence object built by some future path that
never heard of the ledger, all render `NOT RECORDED`.

The row is binary on purpose. A missing `CONSENT_LEDGER_URL`, a timeout, a
refused E.164 conversion and a rejected INSERT all read `NOT RECORDED`; the
classification of *which* lives in the `lead.consent.ledger_failed` log line,
which is where someone diagnosing an outage is looking. An operator reading a
contact needs to know whether the evidence is durable, not why it is not.

**This makes the append's position load-bearing for rendering, not just for the
grant.** `payload.consent.durable` is final before `createLead()` builds the
block (§3.3), so the row is always accurate; moving the append after the CRM
write would silently print `NOT RECORDED` on every successful submission. §7
pins that ordering with a test.

`buildSummary()` is unaffected — it maps over the base rows only and has never
carried consent — so the contact's `message` property does not gain this row.

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

One line of logic — `consentOn` additionally requires
`payload.consent.durable === true`, with a comment naming why. The consent
*read*, the 409 re-fetch and the suppression precedence are unchanged.

One comment correction: `toFormSubmission()` currently describes the block as
"the base 23 rows, plus 10 consent rows … so 33 rows in that case and 23
otherwise". With the ledger row that becomes 11 and 34. The comment already says
the count is deliberately not asserted in that file, and that stays true — this
is a stale sentence, not a new constraint.

### 3.5 `api/_lib/description.mjs`

`CONSENT_LABELS` gains `"CONSENT LEDGER"` as its **first** entry, matching the
row order in `consentRows()`. The two lists are pinned to each other by an
existing assertion in `tests/consent.test.mjs`
(`assert.deepEqual(Object.keys(rows), CONSENT_LABELS)`), so they cannot drift
apart silently — which is exactly why the label list is a file this phase must
touch rather than one it may forget.

`buildDescription()` itself needs no change: it already appends whatever
`consentRows()` returns. Its docstring says "ten further rows" and becomes
eleven, and gains a sentence naming what the ledger row is for.

### 3.6 `tools/check.mjs`

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

### 3.7 New — `db/001_communication_consent_events.sql`

The proposal's table, plus indexes on `(phone_e164, occurred_at)` and
`(submission_id)`, plus the role grants. Checked into the repository; **applied
by a human with the owner credential.** The application never runs DDL and never
holds a credential that could.

**`event_id` gets a database default.** The proposal specifies
`event_id uuid primary key` with no default while its INSERT supplies no
`event_id`, which is a `NOT NULL` violation on the first row — the table as
written cannot accept the write it exists for. The migration closes it:

```sql
-- Owner credential only. The application role never runs any of this.
--
-- gen_random_uuid() is core PostgreSQL from version 13 onward and needs no
-- extension. Neon provisions 14 or later, so on this deployment nothing extra
-- is required. Confirm before applying:  SHOW server_version;
-- On anything older, the OWNER runs, once, before this file:
--   CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- That is owner-time setup. It is never the application's to do, and the
-- application role is not granted CREATE on the schema.

CREATE TABLE communication_consent_events (
  event_id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  occurred_at          timestamptz NOT NULL,
  channel              text        NOT NULL,
  event_type           text        NOT NULL,
  phone_e164           text        NOT NULL,
  source               text        NOT NULL,
  source_event_id      text,
  dedupe_key           text        NOT NULL UNIQUE,
  submission_id        text,
  hubspot_contact_id   text,
  form_type            text,
  page_path            text,
  consent_copy_version text,
  consent_copy_text    text,
  reason_code          text,
  evidence_text        text,
  schema_version       integer     NOT NULL DEFAULT 1,
  metadata             jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX communication_consent_events_phone_time_idx
  ON communication_consent_events (phone_e164, occurred_at DESC);
CREATE INDEX communication_consent_events_submission_idx
  ON communication_consent_events (submission_id);

-- The append-only grant. INSERT and SELECT, nothing else, and no ownership.
GRANT INSERT, SELECT ON communication_consent_events TO <application_role>;
```

Three consequences worth stating rather than rediscovering:

- **The application role needs no DDL privilege of any kind.** The default is
  baked into the column by the owner's migration and evaluated server-side on
  every INSERT. The role is not granted `CREATE` on the schema and does not own
  the table, so it cannot add, alter or drop the default it depends on.
- **No sequence grant is required.** The proposal's role sketch lists "required
  sequence usage", which assumed a `serial`/`identity` key. A `uuid` default
  uses no sequence, so `GRANT USAGE ON SEQUENCE` is not part of this migration
  and must not be added — an unnecessary grant on an append-only ledger is a
  grant to justify later.
- A row discarded by `ON CONFLICT (dedupe_key) DO NOTHING` has already had its
  default evaluated. Harmless: a UUID is not a scarce resource and there is no
  gap to explain, which is precisely why the surrogate key is a UUID and not a
  counter.

The alternative — minting the UUID in `consent-ledger.mjs` with
`randomUUID()` — was considered and rejected. It works, but it puts the
uniqueness guarantee of a primary key in a process that holds no privilege to
correct a collision, and it adds a column to an INSERT that is otherwise
entirely derived from server-owned consent evidence.

### 3.8 `.env.example`

A new section documenting `CONSENT_LEDGER_URL`, empty, stating plainly: it is
server-side only, it is never prefixed `NEXT_PUBLIC_`, and its value must be the
**application** role's connection string — never the owner's. It sits beside the
existing feature-gate section, and says in one line that with
`COMMUNICATIONS_CONSENT_ENABLED` off the variable is read by nothing.

---

## 4. Failure semantics

| Situation | Lead | Timeline evidence | `CONSENT LEDGER` row | `cst_*` grant | Ledger |
|---|---|---|---|---|---|
| Feature OFF (today) | written | none | **no consent rows at all** | none | **not called at all** |
| Feature ON, append succeeds | written | written | `RECORDED` | written | 2 rows |
| Feature ON, append fails or times out | **written** | written | `NOT RECORDED` | **none** | nothing |
| Feature ON, `CONSENT_LEDGER_URL` absent | written | written | `NOT RECORDED` | **none** | nothing |
| Feature ON, phone not convertible to E.164 | written | written | `NOT RECORDED` | **none** | nothing |
| Append succeeds, HubSpot then fails | 502 to visitor | none | none | none | 2 rows (see §2.2) |

Read the third and fourth columns together: **wherever the grant column says
`none` while consent was ticked, the block itself says `NOT RECORDED`.** That is
the invariant the row exists for, and §7 asserts it rather than trusting the
table.

A missing `CONSENT_LEDGER_URL` while the feature is on is deliberately **not** a
503. The lead is not the casualty of an evidence outage; the permission is.

Revocations, STOP and DNC invert this priority — suppress first, append after,
retry and alert. **Not in this phase**; §6.

---

## 5. Deliberately not done, and why

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
  the conflict path reports success;
- **`event_id` is the database's** — the captured INSERT names neither
  `event_id` nor `recorded_at` in its column list, and supplies a parameter for
  neither. Asserted on the statement the injected executor receives, so a later
  "helpful" addition of a client-side UUID fails a test rather than quietly
  taking a guarantee away from the store that enforces it. The module source is
  also asserted not to import or call `randomUUID`.

Added to `tests/consent-state.test.mjs` (where the grant invariants already
live), because these are the assertions that matter most:

- append fails ⇒ **no `cst_*` property is present in the HubSpot request body**,
  and the contact write and form submission still happen;
- append fails ⇒ a prior `granted` state is **not** blanked, and a prior
  suppression is **not** cleared;
- append succeeds ⇒ the existing fold behaviour is byte-identical to today's;
- **feature OFF ⇒ the ledger module's executor is never invoked**, and the
  HubSpot request bodies are unchanged from the pre-ledger baseline;
- **the pairing invariant** — for the same submission, the `message` field of the
  captured form submission says `CONSENT LEDGER: NOT RECORDED` in exactly the
  cases where no `cst_*` grant was written, and `RECORDED` in exactly the cases
  where one was. Asserted on one captured request, so the block and the
  properties can never disagree about the same submission.

Added to `tests/consent.test.mjs` (which already pins `CONSENT_LABELS` and the
enquiry block):

- `consentRows()` emits `CONSENT LEDGER` **first**, and
  `assert.deepEqual(Object.keys(rows), CONSENT_LABELS)` — the existing assertion
  — keeps the label list in step once both are updated;
- the rendered block contains the exact line `CONSENT LEDGER: RECORDED` when
  `durable === true` and `CONSENT LEDGER: NOT RECORDED` for `false`, `undefined`,
  and an evidence object with no `durable` key at all — the deny-by-default
  cases. Asserted on whole lines, not substrings, since `NOT RECORDED` contains
  `RECORDED`;
- the row never renders as `-`: neither value is blank, so
  `buildDescription()`'s blank substitution can never reach it;
- the block gains exactly one line versus the pre-ledger row set, and the
  existing byte-cap headroom assertion still passes;
- **ordering** — with the append stubbed to succeed, the block built by
  `createLead()` says `RECORDED`; this fails if a refactor ever moves the append
  after the CRM write, which would print `NOT RECORDED` on every good
  submission;
- `buildSummary()` is unchanged and carries no `CONSENT LEDGER` line.

`npm test` in CI is the release gate. One CI run.

---

## 8. Human actions required before this phase can be marked done

Code alone does not close gate 3.

1. Provision **Neon Postgres via the Vercel Marketplace** (proposal §"Recommended
   storage"). Region: same as the function.
2. **Confirm `gen_random_uuid()` resolves** before applying the migration:
   `SHOW server_version;` — 13 or later needs nothing, since the function is
   core. On anything older, run `CREATE EXTENSION IF NOT EXISTS pgcrypto;` as
   the owner first. Neon provisions 14 or later, so this is expected to be a
   confirmation rather than a step, and it is written down because a table whose
   primary-key default does not resolve fails on the first real append and not
   before.
3. Apply `db/001_communication_consent_events.sql` **with the owner credential**.
4. Create the application role with **`INSERT` and narrow `SELECT` only** — no
   `UPDATE`, no `DELETE`, no `TRUNCATE`, no DDL ownership, no table ownership,
   and no `CREATE` on the schema. **No sequence grant**: the `uuid` default uses
   none (§3.7). Verify by attempting an `UPDATE` and a `DELETE` as that role and
   confirming both are refused, and by inserting one row and confirming the
   database assigned its `event_id`. **Append-only is a database grant, not a
   code convention**; if this step is skipped the ledger is an ordinary mutable
   table and gate 3 is not met however good the code is.
5. Set `CONSENT_LEDGER_URL` in Vercel to the **application** role's string. The
   owner credential must never reach the Vercel application.
6. Keep a separate privileged path, off Vercel, for migrations and legally
   required privacy deletion. Append-only does not override a deletion
   obligation.
7. Gate 4 (controlled ledger round-trip) is a **live** exercise against a preview
   deployment and cannot be satisfied by any test in this repository.
8. Gate 5 (the HubSpot timeline display check) is now executed against an
   **eleven**-row consent block, with `CONSENT LEDGER` as its first row. Use the
   corrected procedure in `docs/updates/2026-09-09-hubspot-consent-setup.md`
   §6a, not a printout from an earlier document. Worth deliberately producing
   both states while there: a `NOT RECORDED` block is the one an operator will
   have to interpret under pressure, and it is the one nobody has ever looked
   at.

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
append has ever been attempted, the `gen_random_uuid()` default has never been
executed, the E.164 refusal behaviour has never been observed, and **no
`CONSENT LEDGER` row has ever been rendered or seen by an operator** — in either
state. The failure-semantics table in §4 describes intended behaviour, not
measured behaviour.

`COMMUNICATIONS_CONSENT_ENABLED` remains OFF. This document changed no HubSpot
record, form, workflow or property; no Vercel setting; no Twilio or Retell
configuration; no lead, no SMS, no call.
