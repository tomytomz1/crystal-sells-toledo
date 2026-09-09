# The append-only consent ledger — implemented

**Date:** 9 September 2026
**Status:** code, migration, tests and documentation. **Not provisioned, not
migrated, not live.**
**Feature status:** `COMMUNICATIONS_CONSENT_ENABLED` remains OFF / absent from
Vercel Production. This phase did not change it and does not propose changing it.

This closes the *code* half of activation gate 3 — *"append-only consent ledger
implemented and tested"* — in
`docs/updates/2026-09-09-consent-evidence-ledger-decision.md` §3. The other half
is human work in a database that does not exist yet; §7 lists it. **Nothing in
this document has ever run against a real database.**

Design source: `docs/updates/2026-09-09-consent-evidence-ledger-proposal.md`
(what to build). Insertion points and the resolved gaps:
`docs/updates/2026-09-09-consent-evidence-ledger-implementation-plan.md` (where
it goes). This document is what shipped.

---

## 1. What was wrong, and why it mattered

§6a research established that a HubSpot form-submission timeline activity can be
**permanently and irreversibly deleted**, individually or in bulk, by an
authorised user. It is therefore useful operational evidence and cannot be the
system of record for a communication permission.

The consequence is specific and expensive. `cst_sms_permission_status = granted`
is what `api/_lib/permission.mjs` reads at send time — it *is* the permission.
Before this phase, that property could be written with its only supporting
evidence sitting in a store that someone could delete. That is a permission this
business could not later prove it was given, which is exactly what an A2P or TCPA
complaint asks for.

Three records, three jobs, and conflating any two is the failure mode:

| Record | Role | Mutability |
|---|---|---|
| HubSpot `cst_*` contact properties | Current permission state | Mutable — overwritten as it changes, not history |
| HubSpot form timeline activity | Operator-visible evidence copy | Platform-deletable |
| **`communication_consent_events`** | Durable historical evidence — the system of record | **Append-only, as a database grant** |

---

## 2. What changed

### The new module — `api/_lib/consent-ledger.mjs`

The only place in the repository's application source that names the ledger
table, its columns or its connection string. `tools/check.mjs` enforces that
containment, the same way it already stops `cst_*` names leaking out of
`api/_lib/hubspot-consent-state.mjs`.

The pure parts are exported and directly testable; the I/O is one narrow function
behind an injected executor seam, so no test in this repository reaches a
database.

- `buildLedgerEvents(evidence)` emits **one row per channel per submission**:
  ticked → `consent_selected`, unticked → `consent_not_selected`.
  `consent_not_selected` **is never a revocation** — someone who granted consent
  last month and did not re-tick this month has withdrawn nothing, and reading it
  as a withdrawal would silently destroy a lawful permission. The website path
  emits no `revoked`, `suppressed` or `unsuppressed` event in any circumstance.
- `appendConsentEvents()` issues **one parameterised multi-row
  `INSERT … ON CONFLICT (dedupe_key) DO NOTHING`**, in a single statement. Both
  channel rows land together or neither does. A conflict is success: a retry
  finding its own earlier row is what deterministic keys are for.
- Dedupe keys are `website:<submission_id>:<channel>:<event_type>`. **Every
  component must be non-empty and colon-free**, and a blank one is refused rather
  than defaulted — a blank submission id would collapse every submission onto one
  key, and the conflict clause would then discard the second submission's events
  while reporting success. A missing consent record that looks like a present one
  is the worst failure this module could have.
- Timeout **3 s, hard**, enforced by a race in `appendConsentEvents()` (so an
  injected executor is bounded too) with an `AbortSignal` passed to the driver. A
  hanging evidence write must not become a hanging lead.
- Failures are classified into stable PII-free tokens by `ledgerLogShape()`.
  **No driver error text ever survives**: a Postgres error message routinely
  carries the host, the role and sometimes the offending parameter values.

### `phone_e164` — a new conversion, used nowhere else

Nothing in this repository produced E.164. `normalizePhone()` produces the US
display form `(419) 555-0000`, which is what HubSpot, the `cst_*` consent phone
and the timeline evidence rows carry, and what `permission.mjs` compares by
digits. **None of that changed.** A pure `toE164()` in the ledger module converts
for the ledger column alone: 10 digits, 11 digits beginning `1`, or an already-`+`
number of 11–15 digits.

**Anything else throws**, which is an append failure, which withholds the grant.
Two deliberate consequences:

- A non-North-American number is refused a *grant* while its lead is stored and
  worked normally. For a Toledo listing practice that is the correct fail-closed
  direction. It is written down here so it is a known consequence and not a bug
  report later.
- The ledger's phone is on **every** row, including `consent_not_selected`. An
  event that does not say which line it concerns proves nothing about that line.
  This required `buildConsentEvidence()` to carry the submission's phone at the
  top level: the per-channel `phone` is blank when nothing was granted, because
  it records what a *grant* binds to.

### `durable` — deny by default

`buildConsentEvidence()` now returns `durable: false`. `api/lead.js` sets it
`true` only after a confirmed append, and `api/_lib/hubspot.mjs`'s write gate
became:

```js
const consentOn = consentStateEnabled() && payload.consent?.durable === true;
```

`=== true`, not a truthy test: a missing marker, an `undefined`, or an evidence
object built by some future path that never heard of the ledger all withhold the
grant. A refactor that forgets the marker fails closed.

### The eleventh consent row

`consentRows()` gained `["CONSENT LEDGER", "RECORDED" | "NOT CONFIRMED"]` as its
**first** row, and `CONSENT_LABELS` in `api/_lib/description.mjs` matches. The
enquiry block is now 23 base rows plus 11 consent rows.

**First, not last.** The row qualifies every claim below it, and an operator who
reads `SMS CONSENT: GRANTED` before reaching the caveat has already formed the
belief the caveat exists to prevent.

It exists because this phase *creates* a discrepancy an operator would otherwise
meet with no explanation: when the append fails, the activity says
`SMS CONSENT: GRANTED` while the contact correctly reads `never_granted`. Read
cold that looks like the integration dropped a consent. The row says outright
that it did not.

The row is **binary on purpose**. A missing `CONSENT_LEDGER_URL`, a timeout, a
refused E.164 conversion and a rejected INSERT all read `NOT CONFIRMED`; *which*
one is in the `lead.consent.ledger_failed` log line, where someone diagnosing an
outage is already looking. An operator reading a contact needs to know whether
the evidence is proven, not why it is not.

#### `NOT CONFIRMED`, not `NOT RECORDED` — the wording is epistemic on purpose

`durable` answers exactly one question: **did this process receive an
acknowledgement that the events were persisted?** A confirmed append is a fact. A
failed one is *not* the fact that nothing was written — it is the absence of a
fact.

Concretely: the append can time out, or the connection can drop, **after
PostgreSQL has already committed the INSERT** and before its acknowledgement
reaches the function. The row is then in the ledger and this process has no way
to know it. `NOT RECORDED` would be a positive claim about the database's
contents that this code is not entitled to make, and someone reconciling an audit
later would read it as "no event exists for this submission" and be wrong. `NOT
CONFIRMED` says only what is true: no acknowledgement arrived.

That asymmetry is also why the failure is safe to leave as it is. Deterministic
dedupe keys mean a retry of the same submission either finds its own earlier row
(`ON CONFLICT DO NOTHING`) or writes it, so an unacknowledged commit is a
duplicate that cannot happen rather than a record someone has to reconcile by
hand.

**None of this softens the semantics, and none of it changed with the wording:**

- only a **confirmed** append sets `durable === true`;
- `NOT CONFIRMED` still writes **no** new `cst_*` grant;
- the lead and the HubSpot timeline evidence rows still survive;
- timeouts and every other failure still fail closed.

The permission is withheld because the evidence is **unproven**, which is the
same answer as *unwritten* for every purpose except what an operator should
believe about the ledger's contents. A useful side effect: `NOT CONFIRMED` is not
a superstring of `RECORDED`, so the two states are no longer confusable by a
careless substring match — though the assertions still compare whole lines.

The implementation plan
(`docs/updates/2026-09-09-consent-evidence-ledger-implementation-plan.md`) still
says `NOT RECORDED` throughout. It is a dated planning record and is not being
rewritten; **this document is the wording that shipped.**

`buildSummary()` is unaffected — the contact's `message` sidebar property has
never carried consent and still does not.

### Where the append happens

Inside the existing `if (consentFeatureEnabled())` block in `api/lead.js`,
**between the evidence and `createLead()`**. That position is load-bearing twice:
it is what lets `createLead()` be told whether a grant may happen, and it is what
makes the `CONSENT LEDGER` row accurate — the block is built *inside*
`createLead()`, so an append moved after the CRM write would print `NOT CONFIRMED`
on every successful submission and grant nothing. `tools/check.mjs` and a test
both pin the ordering.

A failure is logged with `log()`, not `logError()`: `logError()` emits
`err.message`, and a driver error can carry the connection string. The same
treatment the Nodemailer failure a few lines below already gets.

### The migration — `db/001_communication_consent_events.sql`

The proposal's table, plus the two indexes and the role grants. **Checked in, not
applied.** The application never runs DDL and never holds a credential that
could.

One defect in the proposal was closed: `event_id uuid primary key` had **no
default** while the specified INSERT supplied none, so the first real append
would have violated `NOT NULL` — the table as written could not accept the write
it exists for. The column now has `DEFAULT gen_random_uuid()`, and neither the
application nor its role mints or maintains it. The module imports no
`node:crypto` and calls no `randomUUID`; `tools/check.mjs` and a test both
enforce that.

Consequences worth stating rather than rediscovering:

- **The application role needs no DDL privilege of any kind.** The default is
  baked in by the owner's migration and evaluated server-side on every INSERT.
- **No sequence grant is required.** The proposal's role sketch listed "required
  sequence usage", which assumed a `serial`/`identity` key. A `uuid` default uses
  no sequence, and an unnecessary grant on an append-only ledger is a grant to
  justify later.
- `hubspot_contact_id` stays **null on every website event**: the contact id is
  not known until `createLead()` returns, which is after the append, and the
  role has no `UPDATE` to backfill with. Correlation for a website event is by
  `submission_id`, which appears in the ledger, in the HubSpot enquiry block, in
  the acknowledgement email and in every log line for the request. The STOP/DNC
  phases run after a contact is known and will populate it.

### Files

Seventeen. Sixteen from the plan, plus `docs/updates/2026-09-09-hubspot-consent-setup.md`'s
sample block, which the plan counted as one file with the procedure.

| File | New / Modified |
|---|---|
| `api/_lib/consent-ledger.mjs` | **New** |
| `api/_lib/consent.mjs` | `durable: false`, top-level `phone`, the eleventh row |
| `api/lead.js` | The append, between evidence and `createLead()` |
| `api/_lib/hubspot.mjs` | The `consentOn` gate; stale 10/33 comment → 11/34 |
| `api/_lib/description.mjs` | `CONSENT_LABELS` gains `CONSENT LEDGER`, first |
| `tools/check.mjs` | Six static guards (§4) — guard 6 matches call sites, not the import |
| `db/001_communication_consent_events.sql` | **New** |
| `.env.example` | Documented, empty `CONSENT_LEDGER_URL` |
| `package.json`, `package-lock.json` | `@neondatabase/serverless`, pinned `1.1.0` |
| `tests/consent-ledger.test.mjs` | **New** — 25 tests |
| `tests/consent-state.test.mjs` | The grant-withholding invariants |
| `tests/consent.test.mjs` | The ledger row and the ordering pin |
| `docs/updates/2026-09-09-hubspot-consent-setup.md` | §6a procedure: eleven rows, both states |
| `docs/CURRENT-STATE.md` | The ledger stops being "not built" |
| this file | **New** |

`docs/updates/2026-09-09-communications-consent-foundation.md` is deliberately
**not** updated, though it also prints a ten-row sample block. It is a dated
record of what the foundation phase shipped, and it was accurate. The setup
document is different in kind: its §6a section is a procedure a human executes,
and an operator following it would look for ten rows and find eleven. A live
procedure gets corrected; a historical write-up does not get rewritten.

---

## 3. The resulting contract

| Situation | Lead | Timeline evidence | `CONSENT LEDGER` row | `cst_*` grant | Ledger |
|---|---|---|---|---|---|
| Feature OFF (production today) | written | none | **no consent rows at all** | none | **never called; the driver is not even loaded** |
| Feature ON, append succeeds | written | written | `RECORDED` | written | 2 rows |
| Feature ON, append fails or times out | **written** | written | `NOT CONFIRMED` | **none** | **unknown** — see below |
| Feature ON, `CONSENT_LEDGER_URL` absent | written | written | `NOT CONFIRMED` | **none** | nothing |
| Feature ON, phone not convertible to E.164 | written | written | `NOT CONFIRMED` | **none** | nothing |
| Append succeeds, HubSpot then fails | 502 to visitor | none | none | none | 2 rows |

Read the third and fourth columns together: **wherever the grant column says
`none` while consent was ticked, the block itself says `NOT CONFIRMED`.** That
pairing is asserted on a single captured request, so the block and the properties
can never disagree about the same submission.

The "unknown" in row three is the honest entry. A refused E.164 conversion and an
absent URL never reach the database, so `nothing` is a fact about them. A timeout
or a dropped connection is different: the INSERT may have committed before the
acknowledgement was lost. That is exactly why the row says `NOT CONFIRMED` — see
"the wording is epistemic on purpose" above. A rejected INSERT reports nothing
written and the classification records that, but the operator-visible row does
not distinguish it.

A missing `CONSENT_LEDGER_URL` while the feature is on is deliberately **not** a
503. The lead is not the casualty of an evidence outage; the permission is.

The last row is correct and is the reason the append goes first. The ledger
records *what the person agreed to*, which is true whether or not HubSpot
accepted the lead, and no permission exists because no `cst_*` property was
written. **Evidence without permission is the safe residue; permission without
evidence is the failure this gate exists to prevent.** A visitor who resubmits
after a HubSpot failure mints a new submission id, so a second pair of events is
appended — two attempts is the honest record, and it matches the at-least-once
posture `createLead()` already documents.

Honeypot hits, rate-limited requests and validation failures never reach the
evidence step, so none of them can reach the ledger.

New log events: `lead.consent.ledger_appended` (submission id only) and
`lead.consent.ledger_failed` (submission id and a classification token —
`CONSENT_LEDGER_NOT_CONFIGURED`, `CONSENT_LEDGER_PHONE_NOT_E164`,
`CONSENT_LEDGER_EVIDENCE_INCOMPLETE`, `CONSENT_LEDGER_TIMEOUT`,
`CONSENT_LEDGER_APPEND_FAILED`).

### PII

Written: `occurred_at`, `channel`, `event_type`, `phone_e164`, `source`,
`source_event_id`, `dedupe_key`, `submission_id`, `form_type`, `page_path`,
`consent_copy_version`, `consent_copy_text`, `schema_version`.

Never written: property address, lead message, name, email, **IP address**.
Identity in the ledger is the phone the consent binds to plus the submission id —
the minimum that proves a communication permission. This is asserted against the
actual values in a real submission, not against a column allow-list: a list can
be extended by the same commit that leaks something.

### Dependency

`@neondatabase/serverless`, pinned to `1.1.0` — the first runtime dependency
added since `nodemailer`. Its HTTP query path works inside a Vercel function with
no connection pool and it parameterises queries. Hand-rolling HTTP against Neon's
SQL endpoint was considered and rejected: writing our own parameterisation for
the one table that exists to be trustworthy is a poor trade for one fewer
dependency. The import is **lazy**, so a deployment that never enables consent
never loads it.

---

## 4. The static guards

`tools/check.mjs` gained six, all cheap, each protecting an invariant a
well-meaning refactor could delete without breaking anything that looks
important:

1. `CONSENT_LEDGER_URL` is in `SECRET_NAMES` — it can never appear in anything
   delivered to the browser.
2. `api/_lib/consent-ledger.mjs` must not read an IP address.
3. It must not call `randomUUID` — `event_id` is the database's.
4. No other file under `api/` may name the table or its distinctive columns.
   (`consent_copy_version` is deliberately excluded from that list: HubSpot's own
   `cst_sms_consent_copy_version` contains it, and a rule that fires on the
   adapter which legitimately owns those names would just get deleted.)
5. `api/_lib/hubspot.mjs` must still require `payload.consent?.durable === true`.
6. `api/lead.js` must still append, and must append **before** `createLead()`.

### Guard 6 was broken, and now it is tested

The first version of guard 6 compared `leadSrc.indexOf("appendConsentEvents")`
against the CRM write. That identifier matches the **import statement** at the
top of `api/lead.js`, and an import precedes everything, so:

- the ordering comparison could never be true and **the guard could never fail**;
- the companion presence check would have kept passing after the actual call was
  deleted, because the import still named it.

Both halves now match the awaited **call sites** — `await appendConsentEvents(`
and `await createLead(` — and each is required to exist before their positions
are compared. `indexOf` takes the *first* CRM write, which is the conservative
comparison: the append must precede the earliest one.

**A guard nobody has ever seen fail is a guard nobody knows works**, so
`tests/consent-ledger.test.mjs` now runs the real `tools/check.mjs` against a
**throwaway copy of the tree** and confirms it refuses three deliberate
regressions: the append moved below the CRM write with the import left in place
(the exact case the old guard missed), the append call deleted with the import
left in place, and the `durable === true` requirement removed from the write
gate. It also asserts the unmodified tree passes, pins the two call-site strings
so renaming one in `check.mjs` fails a test rather than silently disarming the
guard, and asserts `check.mjs` no longer compares on the bare identifier.

The working tree is never mutated — the same throwaway-copy technique
`tests/consent.test.mjs` already uses to build the site twice, and the one the
workflow permits for a Tier 4 invariant.

---

## 5. Test results

Tier 4. Targeted runs only; `npm test` in CI is the release gate. No live
database, no HubSpot portal, no message and no call: the ledger's executor is
injected and every HubSpot request is a stubbed `fetch`.

| Suite | Result |
|---|---|
| `tests/consent-ledger.test.mjs` (new, 30 tests) | **30 pass, 0 fail** |
| `tests/consent-state.test.mjs` (72 tests) | **72 pass, 0 fail** |
| `tests/consent.test.mjs` (65 tests) | **65 pass, 0 fail** |
| `tests/api.test.mjs`, `tests/hubspot.test.mjs`, `tests/mail.test.mjs` | **224 pass, 0 fail** |
| `npm run check`, flag **off** | 10 pages, 0 errors |
| `npm run check`, flag **on** | 11 pages, 0 errors |

`tests/browser.test.mjs` was not run locally (Playwright); it is CI's.

What the new assertions actually pin, beyond the obvious:

- an unticked box yields `consent_not_selected` and **never** a revocation or
  suppression event type;
- PII containment asserted against the real values in `validHomeValue`;
- **atomicity** — a failing executor appends neither row;
- **idempotency** — replaying a submission produces byte-identical keys and
  parameters, and the conflict path reports success;
- **`event_id` is the database's** — asserted on the statement the injected
  executor receives, and on the module source;
- the migration's declared columns cover every column the module writes, and its
  `GRANT` lines contain no `UPDATE`, `DELETE`, `TRUNCATE`, `SEQUENCE` or `ALL`;
- a failed append writes **no** `cst_*` property, does not blank a prior grant,
  does not clear a suppression, and still stores the lead with its evidence rows;
- feature **off** ⇒ the executor is never invoked even with a URL configured, and
  the HubSpot request bodies are the pre-consent ones;
- the pairing invariant, on one captured request;
- the **ordering** pin — with the append stubbed to succeed, the block built
  inside `createLead()` says `RECORDED`;
- **the static guards catch what they claim to** — the real `tools/check.mjs`,
  run in a throwaway copy of the tree, refuses an append moved below the CRM
  write, a deleted append call, and a write gate that no longer requires
  `durable === true` (§4).

---

## 6. Explicitly not done

STOP processing, DNC processing, suppression *writing*, re-opt-in and
unsuppression, `reoptin_requested` events, webhooks, send-time enforcement, any
Twilio or Retell integration, and **enabling
`COMMUNICATIONS_CONSENT_ENABLED`**.

`reason_code`, `evidence_text`, `metadata` and the `all` channel are created and
unused: the full table ships now so the STOP/DNC phase needs no second migration
against an append-only table. There is **no read path**, no admin query tool and
no export — nothing yet needs to read the ledger, and `SELECT` is granted narrowly
so the round-trip verification can be done with the application role.

Revocations, STOP and DNC invert this phase's priority — suppress first, append
after, retry and alert. That is a later phase and this code does not anticipate
it beyond leaving the columns in place.

---

## 7. What a human must still do

Code alone does not close gate 3.

1. Provision **Neon Postgres via the Vercel Marketplace**, same region as the
   function.
2. **Confirm `gen_random_uuid()` resolves** before applying the migration:
   `SHOW server_version;`. 13 or later needs nothing — the function is core. On
   anything older the owner runs `CREATE EXTENSION IF NOT EXISTS pgcrypto;` once
   first. Neon provisions 14 or later, so this is expected to be a confirmation
   rather than a step. It is written down because a table whose primary-key
   default does not resolve fails on the first real append and not before.
3. Apply `db/001_communication_consent_events.sql` **with the owner credential**,
   replacing `<application_role>`.
4. Create the application role with **`INSERT` and narrow `SELECT` only** — no
   `UPDATE`, `DELETE`, `TRUNCATE`, DDL ownership, table ownership or `CREATE` on
   the schema, and **no sequence grant**. Verify by attempting an `UPDATE` and a
   `DELETE` as that role and confirming both are refused, and by inserting one
   row and confirming the database assigned its `event_id`. **Append-only is a
   database grant, not a code convention**: skip this and the ledger is an
   ordinary mutable table and gate 3 is not met however good the code is.
5. Set `CONSENT_LEDGER_URL` in Vercel to the **application** role's string. The
   owner credential must never reach the Vercel application.
6. Keep a separate privileged path, off Vercel, for migrations and legally
   required privacy deletion. Append-only does not override a deletion
   obligation.
7. Gate 4 (controlled ledger round-trip) is a **live** exercise against a preview
   deployment and cannot be satisfied by any test in this repository.
8. Gate 5 (the HubSpot timeline display check) is now executed against an
   **eleven**-row block with `CONSENT LEDGER` first, using the corrected
   procedure in `docs/updates/2026-09-09-hubspot-consent-setup.md` §6a. Produce
   **both** states while there — the `NOT CONFIRMED` block is the one an operator
   will have to interpret under pressure, and nobody has ever looked at it.

Gates 4–10 remain outstanding. This phase closes gate 3's code half only.

---

## 8. What is unproven

**No append has ever reached a database.** No Neon project exists, no migration
has been applied, no role has been created, and the `gen_random_uuid()` default
has never been executed. The executor seam is injected in every test, so what is
proven is the statement this code *would* send, the parameters it would bind, and
what it does when an executor fails, hangs or is absent — not that a real
Postgres accepts it, that the `ON CONFLICT` clause matches a real unique index,
or that the connection succeeds from a Vercel function.

**No `CONSENT LEDGER` row has ever been rendered in HubSpot or seen by an
operator**, in either state. The E.164 refusal has never been observed against a
real submission. The failure-semantics table in §3 describes intended behaviour
proven by targeted tests against stubs; it is not measured production behaviour.

**Tests passing is not "this works in production."** No live call has been made
to anything.

`COMMUNICATIONS_CONSENT_ENABLED` remains OFF. This phase changed no HubSpot
record, form, workflow or property; no Vercel setting; no Twilio or Retell
configuration; no lead, no SMS, no call. No database resource was created and no
migration was applied.
