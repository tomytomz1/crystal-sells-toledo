# Operator unsuppression workflow — implementation record

**Date:** 18 September 2026  
**Status:** code implemented and tested; **not activated in Production**

This implements the first application-layer phase of the design in
`docs/updates/2026-09-15-unsuppression-reoptin-decision.md` on top of the already
applied `db/003_unsuppression_lookup.sql` database foundation.

## What is now implemented

- New `POST/GET /api/operator-unsuppress` endpoint.
- New sealed unsuppression capability in
  `api/_lib/operator-unsuppress-token.mjs`.
  - AES-256-GCM.
  - separate `OPERATOR_UNSUPPRESS_SECRET` from the suppression-action secret.
  - one phone number, one sealed lane (`sms`, `ai_voice`, or `all`).
  - 24-hour lifetime.
  - phone number is ciphertext in the URL, not plaintext.
- New `api/_lib/operator-ledger.mjs` database client using only
  `CONSENT_LEDGER_OPERATOR_URL`.
  - reads `get_active_blocks(text)` for the operator review.
  - reads `get_suppression_state(text)` after the append.
  - does not use the website's `CONSENT_LEDGER_URL` or the sender credential.
- `appendSuppressionEvents()` can now be pointed at a server-owned alternate
  credential name while keeping the canonical insert statement and row-count
  semantics in one module.
- Durable suppression rows are folded into effective SMS / automated-voice
  blocking state through `suppressionFromLedgerRows()`.
- HubSpot has a dedicated unsuppression projection which can only clear a
  durable block that actually transitioned from blocked to unblocked.
  - it never writes `granted`.
  - a genuinely unblocked channel is reset to `never_granted`.
  - the five current-state grant artefacts for that channel are cleared.
  - surviving global or channel-specific blocks prevent a false clearance.
- `tools/mint-unsuppress-token.mjs` mints the capability **off-platform**. No web
  endpoint can manufacture an unsuppression capability.

## Human confirmation contract

A GET may inspect current durable state but writes nothing. The POST requires all
of the following before it can append an `unsuppressed` row:

1. the sealed capability in the form body;
2. the exact page confirmation literal;
3. the last four digits of the sealed number re-entered by the operator;
4. a bounded non-trivial operator attestation;
5. an explicit reason with no default:
   - `consumer_request`, or
   - `recorded_in_error`;
6. for `recorded_in_error`, an explicit error origin and at least one currently
   active blocking event selected from the fresh database read.

The scope cannot be widened by POST parameters because the lane is inside the
sealed token.

## Ordering and replay safety

The write path is:

> fresh active-block read -> validate operator decision -> append one
> `unsuppressed` event -> read resulting durable suppression state -> project
> only observed blocked-to-unblocked transitions to HubSpot.

The append result must report **exactly one new row** before any CRM clearance is
considered. A replay that inserts zero rows does not project anything. This
closes the replay-after-later-STOP failure mode documented in the design.

The implementation also pins a lane-wide consumer-request clearance to the
pre-read boundary. A blocking event that arrives after that boundary survives the
clearance rather than being swept by it. This was found during implementation
review and added before merge.

## What this does NOT do

- **It does not grant consent.** Clearing a block and granting permission remain
  different transitions.
- **It does not send SMS or place calls.** There is still no outbound sender in
  the repository.
- **It does not reconcile Twilio's own Messaging Service / sender-level opt-out
  records.** A successful local SMS unsuppression therefore does **not** mean an
  SMS is known deliverable. Twilio reconciliation remains a separate,
  separately-approved phase.
- It does not activate Gate 7 or Gate 8.
- It does not change `TWILIO_AUTH_TOKEN`, `OPERATOR_ACTION_SECRET`, Twilio,
  Retell, or any external provider configuration.

## Tests and guards

Dedicated tests cover:

- token configuration, separation, tamper/expiry behavior and plaintext
  containment;
- operator-ledger configuration and malformed database results;
- `all`-lane dominance;
- HubSpot clearance semantics, including reset to `never_granted` and surviving
  blocks;
- GET read-only behavior;
- confirmation, last-four, attestation, reason, target and scope refusals;
- replay after a later STOP;
- targeted invalidation while another legitimate block survives;
- the late-block race described above.

The final targeted run against branch head
`2baa93f532002642ae7160e3034f3d3808d9eccf` passed **29/29** tests, with the
project build and `tools/check.mjs` also passing. The full repository CI remains
the merge gate and is run by the pull request workflow.

Static guards additionally enforce the separate unsuppression boundary, secret
containment, read -> append -> read ordering, `rowsAffected === 1` gating, and
that the first implementation contains no Twilio reconciliation.

## Production activation state

**INERT after merge unless explicitly configured.** The endpoint requires both:

- `OPERATOR_UNSUPPRESS_SECRET` — a separate randomly-generated secret with at
  least 32 bytes of entropy; and
- `CONSENT_LEDGER_OPERATOR_URL` — the connection string for the already-created
  `consent_ledger_operator` role from `db/003`.

Neither value should be committed. The database role already exists in
Production Neon, but this implementation does not claim that its connection
string is currently stored in Vercel.

Do not activate the endpoint merely because the code is merged. Activation is a
separate operator action followed by a controlled test against synthetic state.
