# Operator unsuppression workflow — implementation and activation record

**Date:** 18 September 2026  
**Status:** **ACTIVE AND READ-VERIFIED IN PRODUCTION**; Production write path not yet exercised

This document records the first application-layer implementation of the design in
`docs/updates/2026-09-15-unsuppression-reoptin-decision.md`, plus its controlled
Production activation after PR #54 merged.

The database foundation is `db/003_unsuppression_lookup.sql`, already applied and
verified on Production Neon.

## What is implemented

- `GET/POST /api/operator-unsuppress`.
- A separate sealed unsuppression capability in
  `api/_lib/operator-unsuppress-token.mjs`:
  - AES-256-GCM;
  - separate `OPERATOR_UNSUPPRESS_SECRET`;
  - one phone number and one sealed lane (`sms`, `ai_voice`, or `all`);
  - 24-hour lifetime;
  - phone number encrypted in the capability rather than exposed as plaintext.
- `api/_lib/operator-ledger.mjs`, using only `CONSENT_LEDGER_OPERATOR_URL`:
  - reads `get_active_blocks(text)` for operator review;
  - reads `get_suppression_state(text)` after an append;
  - does not reuse the website append credential or the Gate 8 sender credential.
- Durable suppression rows folded into effective blocking state through
  `suppressionFromLedgerRows()`.
- HubSpot unsuppression projection that can clear only a durable block that actually
  transitioned from blocked to unblocked.
- `tools/mint-unsuppress-token.mjs`, which mints the capability **off-platform**.
  No web endpoint can manufacture an unsuppression capability.

## Human confirmation contract

A GET is read-only. A POST requires all of the following before it can append an
`unsuppressed` row:

1. the sealed capability in the form body;
2. the exact confirmation literal;
3. the last four digits of the sealed number re-entered by the operator;
4. a bounded, non-trivial operator attestation;
5. an explicit reason with no default:
   - `consumer_request`, or
   - `recorded_in_error`;
6. for `recorded_in_error`, an explicit error origin and at least one currently active
   blocking event selected from the fresh database read.

The lane is inside the sealed capability, so POST parameters cannot widen its scope.

## Ordering and replay safety

The write path is:

> fresh active-block read -> validate operator decision -> append exactly one
> `unsuppressed` event -> read resulting durable suppression state -> project only
> observed blocked-to-unblocked transitions to HubSpot

The append must report **exactly one inserted row** before any CRM clearance is
considered. A replay that inserts zero rows projects nothing.

A consumer-request lane clearance is pinned to the fresh pre-read boundary so a later
blocking event is not swept away by an older approval.

## What unsuppression means

Unsuppression removes a durable block. It **never grants, restores, or implies consent**.

When a channel is genuinely cleared, its mutable HubSpot current-state permission is reset
to `never_granted` and current grant artefacts are cleared. A future send still requires a
fresh, independently evidenced consent grant.

The workflow does not reconcile Twilio's provider-level Messaging Service / sender opt-out
state. Clearing the local durable block therefore does **not** by itself prove an SMS is
provider-deliverable.

## Tests and guards

Before PR #54 merged, the dedicated implementation tests covered:

- token configuration, separation, tamper/expiry behavior, and plaintext containment;
- operator-ledger configuration and malformed database results;
- `all`-lane dominance;
- HubSpot clearance semantics, including reset to `never_granted` and surviving blocks;
- GET read-only behavior;
- confirmation, last-four, attestation, reason, target, and scope refusals;
- replay after a later STOP;
- targeted invalidation while another legitimate block survives;
- the late-block race described above.

The final targeted implementation run against
`2baa93f532002642ae7160e3034f3d3808d9eccf` passed **29/29**. PR #54 then passed the
repository CI gate before merge.

Static guards enforce secret separation, read -> append -> read ordering,
`rowsAffected === 1` gating, and the absence of Twilio reconciliation from this first
implementation.

## Production activation — 18 September 2026

The operator explicitly configured both required server-side values in Vercel Production:

- `OPERATOR_UNSUPPRESS_SECRET`; and
- `CONSENT_LEDGER_OPERATOR_URL`, using the dedicated `consent_ledger_operator` role.

No value is recorded in source control, chat handoffs, or this document.

### Controlled live verification

Two read-only Production checks were performed.

1. `GET /api/operator-unsuppress` with no capability returned **HTTP 400**, not the
   configuration-failure **503**. Configuration is checked before capability parsing, so
   this establishes that the deployed function recognized both required Production
   settings and then failed closed on the missing capability.
2. The operator minted a 24-hour capability off-platform using the same unsuppression
   secret, sealed to a controlled QA number and the `sms` lane. Opening it in Production:
   - decrypted the capability successfully;
   - connected through the `consent_ledger_operator` credential;
   - completed the one-number durable active-block lookup; and
   - rendered **Nothing to clear** / no active SMS blocking event.

The second check is the real-boundary proof for the Production **read path**: the deployed
secret matched the off-platform minting secret, and the operator-role Neon lookup executed
successfully.

## What remains deliberately unproven

No Production `POST` unsuppression was executed because the controlled QA number had no
legitimate active suppression to clear.

Therefore there is still no live Production evidence for:

- blocked -> unblocked append;
- post-write durable read;
- HubSpot clearance projection after a real durable transition.

This is intentional. A real clearance should be exercised only when there is a legitimate
suppression case and an operator justification satisfying the confirmation contract.

## Relationship to the other gates

This activation does **not** activate outbound messaging.

- Gate 6 remains open: the A2P Campaign is rejected 30882, remediated, not resubmitted,
  with Twilio ticket `#29582556` still the decision point.
- Gate 7 inbound configuration is now present and HELP ingress has reached the deployed
  webhook, but the real STOP -> Neon -> HubSpot round trip is still unproven.
- Gate 8 hardening and the dark SMS sender are merged through PR #51. The sender remains
  unreachable; `OUTBOUND_SMS_ENABLED` is off/unset and outbound Twilio API-key credentials
  are not configured.
- `CONSENT_LEDGER_SENDER_URL` is separately configured in Production, but no live
  application execution of that sender-role lookup has yet been observed.
- Gate 9 remains open.

No SMS or AI call was sent by activating or verifying this operator workflow.