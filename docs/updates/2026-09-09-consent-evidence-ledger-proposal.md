# Consent evidence durability research and append-only ledger proposal

> **Preserved in the repository as the authoritative implementation-design source
> for the consent evidence ledger.** The body below is the research and proposal
> as received on 9 September 2026, kept as written so a future implementation
> session needs no conversation history.
>
> **Nothing here is implemented.** The architectural *decision* taken from it —
> and its scope, which is narrower than this document — is
> `docs/updates/2026-09-09-consent-evidence-ledger-decision.md`. Where the two
> differ, the decision document governs what was agreed; this one governs how it
> should be built when someone builds it.
>
> Two notes for a future reader, added on preservation and not part of the
> original text:
>
> * Activation gate 1 below ("token-efficiency repo refactor merged") is **done**.
> * The finding "Guaranteed full rendering of arbitrary long `message` values —
>   not documented" means exactly that. **Whether the actual consent evidence
>   renders in full anywhere — UI or API — remains unverified** until the manual
>   operator check is performed. Nothing here establishes it.

---

## Consent Evidence Durability Research and Append-Only Ledger Proposal

**Date:** September 9, 2026  
**Status:** Architecture proposal only. No production change.  
**Feature status:** `COMMUNICATIONS_CONSENT_ENABLED` remains OFF / absent.

## Executive conclusion

HubSpot native form-submission timeline activities should remain an operational copy of per-submission consent evidence, but they should not be the sole durable historical consent ledger.

HubSpot explicitly allows authorized users to permanently delete individual form submissions and to delete submissions in bulk. HubSpot documents that deletion is irreversible and removes the submission from the associated CRM record's activity timeline.

Recommended architecture:

- HubSpot Contact `cst_*` properties remain the mutable current permission state.
- HubSpot native Form submission activities remain the convenient operator-visible evidence copy.
- A new external append-only database becomes the durable historical evidence ledger.
- Automated messaging must never depend on the HubSpot timeline being immutable.

## Section 6a findings

| Question | Finding |
|---|---|
| Individual submission deletion | Confirmed. Permanent and irreversible. |
| Bulk submission deletion | Confirmed. |
| Deletion removes Contact timeline activity | Confirmed. |
| Ordinary submissions survive form unpublishing | Confirmed. |
| Permanent Contact deletion can remove form submissions | Confirmed. |
| Spam submission automatic deletion | 90 days unless released. |
| General auto-expiration for normal submissions | No general expiration found in reviewed official docs. |
| Direct editing of recorded form submission | No supported direct edit path identified. |
| Guaranteed full rendering of arbitrary long `message` values | Not documented. Manual UI check still useful. |
| HubSpot timeline suitable as sole immutable consent ledger | **No.** |

The direct deletion capability is enough to reject the timeline as an immutable ledger, even if direct editing is not supported.

## Recommended storage

Use **Neon Postgres through the Vercel Marketplace**.

Reasons:

- native Vercel integration;
- server-side credentials;
- relational constraints;
- ACID writes;
- unique constraints for idempotency;
- easy auditing/querying;
- low operational complexity;
- suitable for Crystal's very low event volume.

Do not use Redis/KV as the primary consent ledger.

## Record roles

| Record | Purpose | Mutability |
|---|---|---|
| HubSpot `cst_*` Contact properties | Current permission state | Mutable |
| HubSpot form timeline activity | Operator-visible evidence copy | Platform-deletable |
| External consent ledger | Durable chronological evidence | Append-only to application |

## Proposed table

`communication_consent_events`

```sql
event_id uuid primary key
recorded_at timestamptz not null default now()
occurred_at timestamptz not null
channel text not null
event_type text not null
phone_e164 text not null
source text not null
source_event_id text
dedupe_key text not null unique
submission_id text
hubspot_contact_id text
form_type text
page_path text
consent_copy_version text
consent_copy_text text
reason_code text
evidence_text text
schema_version integer not null default 1
metadata jsonb not null default '{}'::jsonb
```

Channels:

```text
sms
ai_voice
all
```

Event types:

```text
consent_selected
consent_not_selected
reoptin_requested
revoked
suppressed
unsuppressed
```

`consent_not_selected` must never mean revocation.

## Website event behavior

When the feature is active, append one event per channel for every form submission.

For SMS:

- checked -> `consent_selected`
- unchecked -> `consent_not_selected`

For AI voice:

- checked -> `consent_selected`
- unchecked -> `consent_not_selected`

Store the exact server-owned disclosure text, disclosure version, normalized phone, page path, form type, submission ID, and server timestamp.

If a checked submission occurs while the channel is revoked or suppressed, preserve the fact that consent was selected and separately append `reoptin_requested`. Do not silently clear suppression.

## STOP / DNC behavior

For Twilio STOP, append an SMS suppression/revocation event keyed to the provider message SID.

For a Retell spoken do-not-call request, append an AI voice suppression event keyed to the call ID.

For a global do-not-contact request, append an `all`-channel suppression event.

A ledger outage must never prevent a revocation or suppression from taking effect.

## Idempotency

Every event needs a deterministic unique `dedupe_key`.

Examples:

```text
website:<submission_id>:sms:consent_selected
website:<submission_id>:ai_voice:consent_not_selected
twilio:<message_sid>:sms:suppressed
retell:<call_id>:ai_voice:suppressed
```

Provider/webhook retries should become already-recorded success, not duplicate history.

## Append-only enforcement

The production Vercel database role should have only:

- `INSERT`
- narrowly scoped `SELECT`
- required sequence usage

It should have no normal:

- `UPDATE`
- `DELETE`
- `TRUNCATE`
- DDL ownership

The database owner/admin credential must not be injected into the Vercel application.

A separate privileged path should exist for schema migrations and legally required privacy deletion.

Append-only means the normal production application cannot mutate historical events. It does not mean privacy deletion obligations can be ignored.

## PII minimization

Store only what is needed to prove communication permission.

Keep:

- normalized phone at the time of the event;
- consent disclosure text/version;
- event/source identifiers;
- timestamps;
- page/form source;
- minimal revocation evidence.

Do not copy:

- property address;
- full lead message;
- name unless a future documented need exists;
- email unless a future documented need exists;
- IP address.

## Failure semantics

### New permission grant

A failed ledger write must never create a new automated communication permission.

Recommended ordering:

1. validate the lead;
2. attempt the durable ledger append;
3. preserve the core lead in HubSpot regardless of ledger availability;
4. if the ledger write succeeded, apply the normal consent transition to HubSpot current state;
5. if the ledger write failed, preserve the previous communication permission state;
6. log/alert the evidence-write failure;
7. keep any permission dependent on the failed ledger write inactive.

This protects both core invariants:

- do not lose legitimate leads;
- do not manufacture permission without durable evidence.

### Revocation / STOP / DNC

Use the opposite priority.

1. suppress/revoke immediately in operational state;
2. stop further automated communication;
3. attempt ledger append;
4. retry/alert if historical persistence fails.

Infrastructure ambiguity must fail in the direction of less communication.

## Relationship to existing code

Keep the existing consent model:

- canonical SMS disclosure/version;
- canonical AI voice disclosure/version;
- server-owned timestamps;
- `applySubmissionConsent()`;
- permission resolver;
- 23 HubSpot Contact properties;
- HubSpot timeline evidence rows;
- feature gate.

The new ledger is an additional durable evidence sink.

## Updated activation gates

Before considering `COMMUNICATIONS_CONSENT_ENABLED=true`:

1. token-efficiency repo refactor merged;
2. §6a documented with the finding that HubSpot timeline is not sufficient as the sole immutable evidence store;
3. append-only consent ledger implemented and tested;
4. controlled ledger round-trip verified;
5. HubSpot timeline display checked for operator usability;
6. Twilio/TCR readiness resolved;
7. STOP/DNC suppression handling implemented;
8. send-time permission enforcement active for every automated SMS/call;
9. controlled consent -> send -> STOP/DNC test passes;
10. final activation review.

## Sources reviewed

Official/current sources reviewed on September 9, 2026:

- HubSpot, **Delete form submissions**, updated August 5, 2026.
- HubSpot, **Manage spam form submissions**, updated July 27, 2026.
- HubSpot, **Unpublish a HubSpot form**, updated July 23, 2026.
- HubSpot, **Organize and manage forms**, updated July 23, 2026.
- HubSpot, **Understand restorable and permanent contact deletions**, updated July 17, 2026.
- HubSpot, **Perform a permanent delete in HubSpot**, updated July 31, 2026.
- HubSpot, **View and analyze form submissions**, updated July 28, 2026.
- HubSpot, **Edit, delete, or comment on an activity**, updated June 29, 2026.
- HubSpot, **Export form submissions**, updated June 16, 2026.
- HubSpot Developer documentation, **Get submissions for a form**, last modified March 30, 2026.
- Vercel, **Storage overview**, updated January 24, 2026.
- Vercel Marketplace, **Neon serverless Postgres**.

## Production safety

This research made no production changes.

`COMMUNICATIONS_CONSENT_ENABLED` remains OFF. No HubSpot record, form, workflow, property, Vercel setting, Twilio configuration, Retell configuration, lead, SMS, or call was modified or created by this work.
