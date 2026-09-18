# Operator unsuppression workflow — implementation and activation record

**Date:** 18 September 2026  
**Status:** code implemented and tested; **ACTIVE AND READ-VERIFIED IN PRODUCTION**

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
project build and `tools/check.mjs` also passing. The full repository CI was the
merge gate for PR #54 and passed before merge.

Static guards additionally enforce the separate unsuppression boundary, secret
containment, read -> append -> read ordering, `rowsAffected === 1` gating, and
that the first implementation contains no Twilio reconciliation.

## Production activation — 18 September 2026

The operator explicitly activated the workflow after PR #54 merged.

Production Vercel was configured with both required server-side values:

- `OPERATOR_UNSUPPRESS_SECRET` — a separately generated random secret; and
- `CONSENT_LEDGER_OPERATOR_URL` — the pooled Neon connection string for the
  existing `consent_ledger_operator` role on the Production branch/database.

The values themselves were never placed in chat, source control, logs, or this
document. The Neon screenshot used for setup showed the password masked.

### Controlled live verification

Two live Production checks were performed without clearing any suppression:

1. `GET /api/operator-unsuppress` with no capability returned **HTTP 400**, not
   the endpoint's configuration-failure **503**. Because configuration is checked
   before token parsing, this established that the deployed function recognized
   both required Production values and then failed closed on the missing token.
2. The operator used `tools/mint-unsuppress-token.mjs` off-platform with the same
   `OPERATOR_UNSUPPRESS_SECRET`, sealed to the controlled QA number and the
   `sms` lane. Opening that Production approval URL successfully decrypted the
   capability and read the durable Neon state through `consent_ledger_operator`.
   The page rendered **"Nothing to clear"** and stated that there was no active
   SMS blocking event for that number.

The second check is the real provider-boundary proof for the read path: the
Production token key matched the off-platform minting key, the operator database
credential connected, and the one-number active-block lookup completed.

### What remains deliberately unproven

- No `POST` unsuppression was executed in Production because the controlled QA
  number had no active suppression and there was no legitimate block to clear.
- Therefore no live Production evidence yet exists for an actual
  blocked -> unblocked append, post-read, or HubSpot clearance projection.
- This is intentional. A real clearance should only be exercised when there is
  a legitimate suppression case with an operator justification that satisfies
  the confirmation contract.

**Operational state:** the workflow is available in Production and the read path
is live-verified. It remains human-gated, cannot grant consent, and has not been
used to clear a Production suppression.
