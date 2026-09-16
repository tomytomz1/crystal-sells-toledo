# Gate 8 — send-time permission enforcement

**16 September 2026. IMPLEMENTATION IN REVIEW. No outbound automation is activated by this change.**

This slice puts the compliance decision immediately in front of every future automated SMS or AI-voice sender. It does not send a message, place a call, configure Twilio/Retell, or add a production environment variable.

## The contract

A send is allowed only when all of these are true at the moment of the attempted communication:

1. communications consent is enabled;
2. the durable phone-keyed suppression lookup succeeded;
3. the durable ledger reports no active block for the requested channel (and no `all` block);
4. current consent state was successfully read from HubSpot;
5. HubSpot's conservative suppression projection does not independently block the channel;
6. the channel's current permission is `granted`;
7. the actual target number is dialable and matches the number the consent was granted for.

Any dependency failure refuses the send. `api/_lib/permission.mjs` remains the only policy engine that returns the final `{ allowed, reason }` decision.

## Two credentials stay separate

Gate 8 introduces the **name** `CONSENT_LEDGER_SENDER_URL` for the future server-side sender-role connection string. It is not `CONSENT_LEDGER_URL`.

- `CONSENT_LEDGER_URL` — website/application role: append evidence; no read.
- `CONSENT_LEDGER_SENDER_URL` — sender role: execute `get_suppression_state(text)` for one number; no table `SELECT`, no insert.

The production sender credential already exists in Neon, but this implementation does **not** add its connection string to Vercel. Until an operator explicitly does that, Gate 8 fails closed with `SUPPRESSION_LOOKUP_UNAVAILABLE` and no future sender can be authorized through this path.

## Durable suppression lookup

`api/_lib/send-permission.mjs` calls only:

```sql
SELECT channel, suppressed_at
FROM public.get_suppression_state($1)
```

with the target normalized to E.164. It never names the ledger table and cannot enumerate the ledger through the sender role's database privileges.

Returned rows are treated as untrusted provider data. Only `sms`, `ai_voice`, and `all` are accepted, and `suppressed_at` must be a valid instant. A malformed row, timeout, missing credential, or driver failure is not "no suppression" — it is a refusal.

## CRM current state

When the durable lookup does not already block the requested channel, Gate 8 reads the contact through the existing HubSpot email search and uses its already-established consent-state parser. A missing contact means `NO_CONSENT`; a failed or malformed CRM read means `CONSENT_STATE_UNAVAILABLE`.

The durable ledger is authoritative for suppression by phone. HubSpot suppression flags remain a conservative projection: Gate 8 takes the union, so a stale true may block but can never authorize.

## What is deliberately not in this slice

- no Twilio send function;
- no Retell call function;
- no SMS conversation engine;
- no calendar booking;
- no cold-list workflow;
- no environment-variable change;
- no live provider call;
- no unsuppression endpoint or HubSpot unsuppression projection;
- no claim that A2P is approved — the Campaign submitted 16 September 2026 is still `PENDING_REVIEW` on operator evidence.

The next sender must call Gate 8 immediately before its external side effect. It must not cache an earlier allow decision.

## Evidence and remaining boundary

The implementation tests inject both provider boundaries and exercise the real permission resolver. They prove fail-closed composition, lane separation, phone binding, E.164 lookup input, and PII-free error shaping. They do **not** prove Neon HTTP's production response shape or a live HubSpot read in the sender path.

Before outbound automation is activated, an operator must add the sender-role connection string to the appropriate production environment and a controlled real-boundary verification must confirm `get_suppression_state(text)` is reachable under that credential. A2P approval remains a separate prerequisite for production SMS traffic.
