# Gate 8 — send-time permission enforcement foundation

**16 September 2026. IMPLEMENTATION FOUNDATION. No SMS sender and no AI-voice sender is added by this change.**

## Why this exists

The project already had a pure policy resolver in `api/_lib/permission.mjs` and a durable number-keyed suppression fold in PostgreSQL (`get_suppression_state(text)`, updated by `db/003`). What did not exist was the operational bridge between them.

A future sender must not decide from HubSpot alone. HubSpot is a mutable projection and can be stale or incomplete. The durable ledger is independently authoritative for suppression. The approved rule is therefore:

> **Deny if either current HubSpot state or the durable ledger says blocked.**

And a send may not be allowed if the durable read itself cannot be completed and interpreted.

## What this change adds

`api/_lib/send-permission.mjs` is the Gate 8 operational boundary.

For an otherwise-sendable SMS or automated/AI-voice call it:

1. asks the existing pure resolver first;
2. if current state already denies, returns that denial without a database read;
3. converts the actual destination number to E.164;
4. queries only `get_suppression_state($1)` using a separate sender credential;
5. validates the complete returned shape strictly;
6. unions the returned blocking lanes with the caller-supplied current state without mutating it;
7. asks the pure resolver again;
8. allows only when that second decision allows.

The durable read has a 3-second hard deadline. Missing configuration, timeout, driver failure, a non-array response, an unknown lane, a missing/invalid timestamp, or a duplicate lane all return a stable **deny** decision.

There is deliberately no cache inside Gate 8. Each otherwise-sendable attempt performs a fresh durable read.

## The new credential

Gate 8 names one new server-side secret:

`CONSENT_LEDGER_SENDER_URL`

It is the connection string for the existing `consent_ledger_sender` role created by `db/002` and preserved by `db/003`.

That role has:

- `EXECUTE` on `get_suppression_state(text)`;
- no table `SELECT`;
- no `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE`;
- no `get_active_blocks` access.

It must **not** be the existing `CONSENT_LEDGER_URL` (`consent_ledger_app`, INSERT-only), the operator credential, or the database owner credential.

**This PR does not add the variable to Vercel.** Provisioning it is an operator action after the code is reviewed and merged, and before any sender is allowed to go live.

## What the tests establish

`tests/send-permission.test.mjs` asserts:

- feature-off and no-consent states short-circuit before the ledger;
- HubSpot/current-state suppression short-circuits before the ledger;
- clean durable state preserves a valid grant;
- `sms`, `ai_voice` and `all` durable lanes block exactly what they should;
- lane isolation remains intact;
- the actual E.164 destination is the query key;
- there is no internal clean-result cache;
- missing configuration, timeouts, driver failures and malformed results fail closed;
- a durable overlay does not mutate caller-owned current state;
- API modules cannot directly import the pure `canSendSms` / `canPlaceAutomatedVoiceCall` decision in place of this boundary;
- the new secret name is absent from client source and built output.

The PostgreSQL side is not mocked by this project generally: `tests/unsuppression-fold.test.mjs` already applies `db/001` → `db/002` → `db/003` to a real PostgreSQL service in CI and exercises `get_suppression_state()` as the real `consent_ledger_sender` role. This PR reuses that contract rather than inventing a second one.

## What remains deliberately unproven

This foundation **does not close all of Gate 8 by itself**, because there is no provider sender in the repository yet.

In particular this PR does not prove:

- a Twilio SMS provider call is temporally adjacent to a Gate 8 decision;
- a Retell/voice provider call is temporally adjacent to a Gate 8 decision;
- a future caller cannot cache a previously returned `{ allowed: true }` outside this module;
- the new sender connection string has been provisioned in Vercel Production;
- the real Neon HTTP endpoint has been exercised through this new SELECT path;
- any real SMS was sent or any call was placed.

Those claims become provable only when the provider integration exists. The provider module must call Gate 8 immediately before the side effect and must not accept a pre-computed permission decision from an earlier stage.

## Current external state while this work begins

Operator evidence on 16 September 2026 records the A2P Campaign as submitted and `PENDING_REVIEW`. That is **not approval** and this implementation does not change its status.

Automated outbound SMS remains disabled until the Campaign is approved and the controlled send path is proven. No change in this PR contacts Twilio, Retell, HubSpot, Neon Production, Vercel configuration or a consumer.

## Sequence after this foundation

1. Review and merge this foundation.
2. Provision `CONSENT_LEDGER_SENDER_URL` with the existing EXECUTE-only sender role and verify the SELECT path at the lowest practical real boundary.
3. Couple the first outbound SMS sender to `canSendSmsNow()` immediately before Twilio's send call; keep it non-sending until A2P approval.
4. Couple the AI-voice initiation path to `canPlaceAutomatedVoiceCallNow()` immediately before the provider call.
5. Build appointment/calendar orchestration and CRM projection behind those enforced communication paths.
6. Keep uploaded cold-prospect data in a separate eligibility/compliance lane; it does not inherit website consent.
