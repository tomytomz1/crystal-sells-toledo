# Operator unsuppression workflow — implementation and activation record

**Date:** 18 September 2026  
**Status:** **ACTIVE AND WRITE-VERIFIED IN PRODUCTION**

This document records the application-layer unsuppression workflow from PR #54 and its controlled Production verification. The database foundation is `db/003_unsuppression_lookup.sql`.

## What is implemented

- `GET/POST /api/operator-unsuppress`.
- A separate sealed capability in `api/_lib/operator-unsuppress-token.mjs`:
  - AES-256-GCM;
  - separate `OPERATOR_UNSUPPRESS_SECRET`;
  - one phone number and one sealed lane (`sms`, `ai_voice`, or `all`);
  - 24-hour lifetime;
  - phone number encrypted in the capability.
- `api/_lib/operator-ledger.mjs`, using only `CONSENT_LEDGER_OPERATOR_URL`:
  - reads `get_active_blocks(text)` for operator review;
  - appends the operator unsuppression event;
  - reads `get_suppression_state(text)` after the append.
- HubSpot projection that clears mutable suppression state only when the durable fold actually transitions from blocked to unblocked.
- `tools/mint-unsuppress-token.mjs`, which mints the capability off-platform. No web endpoint can manufacture one.

## Human confirmation contract

A GET is read-only. A POST requires all of the following before it can append an `unsuppressed` row:

1. the sealed capability in the form body;
2. the exact confirmation literal;
3. the last four digits of the sealed number re-entered by the operator;
4. a bounded, non-trivial operator attestation;
5. an explicit reason with no default: `consumer_request` or `recorded_in_error`;
6. for `recorded_in_error`, an explicit error origin and at least one currently active blocking event selected from the fresh database read.

The lane is inside the sealed capability, so POST parameters cannot widen its scope.

## Ordering and replay safety

The write path is:

> fresh active-block read -> validate operator decision -> append exactly one `unsuppressed` event -> read resulting durable suppression state -> project only observed blocked-to-unblocked transitions to HubSpot

The append must report exactly one inserted row before any CRM clearance is considered. A replay that inserts zero rows projects nothing.

## What unsuppression means

Unsuppression removes a durable block. It **never grants, restores, or implies consent**.

When a channel is genuinely cleared, its mutable HubSpot permission is reset to `never_granted` and current grant artefacts are cleared. A future automated send still requires fresh, independently evidenced consent.

The workflow does not reconcile Twilio's provider-level Messaging Service / sender opt-out state. Clearing the local durable block therefore does **not** by itself prove an SMS is provider-deliverable.

## Production configuration

Production has the two dedicated server-side values required by this workflow:

- `OPERATOR_UNSUPPRESS_SECRET`;
- `CONSENT_LEDGER_OPERATOR_URL`, using the dedicated `consent_ledger_operator` role.

No secret value is recorded in source control or handoff prose.

## Production verification — 18 September 2026

### Read boundary

Earlier controlled checks established that:

- a no-capability Production GET returned HTTP 400 rather than configuration-failure 503;
- an off-platform 24-hour capability decrypted successfully in Production; and
- the deployed endpoint could execute the one-number Neon active-block lookup through the operator role.

### Write boundary

A later real QA STOP created an active durable SMS suppression. After the same consumer sent START during controlled QA, the operator deliberately exercised the human-only unsuppression path with reason `consumer_request`.

The Production result page established:

- a new unsuppression event was appended to the durable ledger;
- effective durable blocks before the operation: **SMS**;
- effective durable blocks after the operation: **none**;
- HubSpot projection: **1 contact, 1 updated**;
- no consent was granted; and
- Twilio provider opt-out state was not changed by this workflow.

An independent HubSpot readback after the POST confirmed:

- `cst_sms_suppressed=false`;
- `cst_sms_permission_status=never_granted`;
- the current SMS suppression timestamp and reason were cleared; and
- the earlier re-opt-in request timestamp remained recorded.

This closes the Production write-path evidence gap for:

> fresh pre-read -> durable append -> durable post-read -> HubSpot clearance projection

It does **not** establish fresh SMS consent and does **not** establish Twilio carrier/Messaging Service opt-out reconciliation.

## Relationship to the messaging gates

- Gate 6: the A2P Campaign has been corrected and resubmitted; Twilio reports `PENDING_REVIEW` (submission count 2).
- Gate 7: a real STOP round trip has now proven Twilio `OptOutType=STOP` -> signed Production webhook -> durable Neon suppression -> HubSpot suppression projection. Missing Twilio-generated STOP/HELP/START handset confirmations remain a separate provider-delivery incident.
- Gate 8: the hardened authorization and dark SMS transport remain merged. `CONSENT_LEDGER_SENDER_URL` is configured separately on the dedicated sender role. A one-shot read-only Production application-binding verification is tracked separately.
- Gate 9 remains open until A2P readiness and deliberate outbound activation.

No SMS or AI call was sent by this operator unsuppression workflow.
