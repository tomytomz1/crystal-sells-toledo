# §6a findings and the consent evidence architecture decision

**Date:** 9 September 2026
**Status:** research complete, architectural direction approved. **No
implementation.** No production change.
**Feature status:** `COMMUNICATIONS_CONSENT_ENABLED` remains OFF / absent from
Vercel Production.

This closes the §6a research question in
`docs/updates/2026-09-09-hubspot-consent-setup.md`. It does **not** build
anything. The ledger described below is explicitly not part of this task.

---

## 1. The question, and the answer

§6a asked whether the HubSpot form-submission timeline activity — which carries
the ten-row consent evidence block for each submission — is durable enough to
serve as the historical record of what a person agreed to.

**It is not.**

HubSpot explicitly allows authorized users to permanently delete individual form
submissions, and to delete submissions in bulk. HubSpot documents that this
deletion is irreversible and that it removes the submission from the associated
CRM record's activity timeline.

That single capability is enough to disqualify the timeline as the sole immutable
consent ledger. It does not matter that no supported *edit* path was found: a
record that can be permanently destroyed by an ordinary authorized user cannot be
the thing a compliance question is answered from years later.

Note what this does **not** say. The timeline evidence keeps its value, and the
existing design and code will **continue writing the operator-visible timeline
copy when the feature is eventually enabled** — nothing is written today, because
the feature is off. What changes is its *role*: it is an operational copy, not
the system of record. It remains the copy an operator will be able to see next to
the enquiry it belongs to, without querying anything.

### Findings table

| Question | Finding |
|---|---|
| Individual submission deletion | Confirmed. Permanent and irreversible. |
| Bulk submission deletion | Confirmed. |
| Deletion removes the Contact timeline activity | Confirmed. |
| Ordinary submissions survive form unpublishing | Confirmed. |
| Permanent Contact deletion can remove form submissions | Confirmed. |
| Spam submission automatic deletion | 90 days unless released. |
| General auto-expiration for normal submissions | None found in the reviewed official documentation. |
| Direct editing of a recorded form submission | No supported direct edit path identified. |
| Guaranteed full rendering of arbitrarily long `message` values | Not documented. |
| **HubSpot timeline suitable as the sole immutable consent ledger** | **No.** |

### What remains a manual check

§6a's first question — whether the HubSpot UI renders the whole enquiry block or
truncates it behind a "show more" — is **not answered by documentation**, and no
guarantee exists to cite. It is now an *operator usability* question rather than
an evidence-durability one, because durability no longer depends on the timeline.
It stays on the gate list below.

**Full rendering of the actual consent evidence remains UNVERIFIED** until that
manual operator check is done. Nothing in the reviewed documentation guarantees
it, and no one has yet opened a real submission carrying a full ten-row block —
including both long CONSENT TEXT rows — and confirmed what is displayed. An
earlier draft of this document said the API returns the full value regardless;
that was an assumption, not a finding, and it is withdrawn. Whether the UI, the
API, or both return the complete evidence is exactly what the check is for.

### Sources reviewed, 9 September 2026

HubSpot: *Delete form submissions* (5 Aug 2026) · *Manage spam form submissions*
(27 Jul 2026) · *Unpublish a HubSpot form* (23 Jul 2026) · *Organize and manage
forms* (23 Jul 2026) · *Understand restorable and permanent contact deletions*
(17 Jul 2026) · *Perform a permanent delete in HubSpot* (31 Jul 2026) · *View and
analyze form submissions* (28 Jul 2026) · *Edit, delete, or comment on an
activity* (29 Jun 2026) · *Export form submissions* (16 Jun 2026) · Developer
docs, *Get submissions for a form* (30 Mar 2026). Vercel: *Storage overview*
(24 Jan 2026) · Marketplace, *Neon serverless Postgres*.

---

## 2. The approved architecture

Three records, three different jobs. Conflating any two of them is how this goes
wrong.

| Record | Purpose | Mutability |
|---|---|---|
| **HubSpot `cst_*` Contact properties** | Current permission state — what is true now | **Mutable.** Overwritten as it changes. Not history. |
| **HubSpot form timeline activity** | Operator-visible evidence copy — what an operator can see beside the enquiry | **Platform-deletable.** Additive by construction, but destroyable. |
| **External append-only ledger** | Durable chronological evidence — the system of record | **Append-only to the application.** |

**Automated messaging must never depend on the HubSpot timeline being
immutable.** The existing code already avoids claiming it is; that language stays
correct.

Nothing about the existing consent model changes. The canonical SMS and AI voice
disclosures and their version constants, the server-owned timestamps,
`applySubmissionConsent()`, the permission resolver, the 23 HubSpot Contact
properties, the timeline evidence rows and the feature gate all stay exactly as
they are. **The ledger is an additional evidence sink, not a replacement for any
of them.**

### Direction recorded, not built

The research proposes Neon Postgres via the Vercel Marketplace (server-side
credentials, relational constraints, ACID writes, unique constraints for
idempotency, low operational complexity, and a volume this site will not
strain), a `communication_consent_events` table, deterministic `dedupe_key`
idempotency so provider retries become already-recorded successes rather than
duplicate history, a production role holding only `INSERT` and narrow `SELECT`,
and PII minimisation — no property address, no lead message, no IP address.

Two failure semantics matter enough to record now, because they are opposites and
getting them backwards is the dangerous outcome:

- **A new permission grant** must never be created by a failed ledger write. Keep
  the lead, keep the previous permission state, log the evidence failure, and
  leave the permission inactive. Do not lose legitimate leads; do not manufacture
  permission without durable evidence.
- **A revocation, STOP or DNC** goes the other way: suppress immediately in
  operational state, stop communicating, *then* append and retry. Infrastructure
  ambiguity fails in the direction of less communication.

Also recorded: `consent_not_selected` must never be read as revocation, and
append-only means the production application cannot rewrite history — it does not
mean privacy-deletion obligations can be ignored. A separate privileged path
covers migrations and legally required deletion.

**None of this is implemented.** The full proposal — schema, event types, website
and STOP/DNC behaviour, idempotency keys, role grants, PII minimisation — is
preserved in this repository as
`docs/updates/2026-09-09-consent-evidence-ledger-proposal.md`, and is the
authoritative implementation-design source. Read it when the ledger is actually
built; a future session needs no conversation history to find it.

---

## 3. Activation gates, updated

`COMMUNICATIONS_CONSENT_ENABLED=true` is still a long way off. In order:

1. ~~Token-efficiency repo refactor merged.~~ **Done** — `CLAUDE.md`,
   `docs/CURRENT-STATE.md`, `docs/WORKFLOW.md`.
2. ~~§6a documented, with the finding that the HubSpot timeline is not sufficient
   as the sole immutable evidence store.~~ **This document.**
3. Append-only consent ledger implemented and tested.
4. Controlled ledger round-trip verified.
5. HubSpot timeline display checked for operator usability (§6a question 1).
6. Twilio / TCR readiness resolved.
7. STOP / DNC suppression handling implemented.
8. Send-time permission enforcement active for every automated SMS and call.
9. Controlled consent → send → STOP/DNC test passes.
10. Final activation review.

Items 3–10 are outstanding. **Activation remains gated.**

---

## 4. Production safety

This research and this document made no production change. No HubSpot record,
form, workflow or property; no Vercel setting; no Twilio or Retell configuration;
no lead, no SMS, no call. `COMMUNICATIONS_CONSENT_ENABLED` remains OFF.
