# Gate 9 — automatic seller SMS acknowledgement, staged dark

**Date:** 18 September 2026  
**Status:** implemented on a feature branch; **not activated in Production**

## Purpose

Gate 9 connects the existing website-lead pipeline to the already-built outbound
SMS sender so a seller who **freshly opts in to SMS on the current `/home-value`
submission** can receive the first A2P-approved acknowledgement after the lead is
safely stored.

This change does **not** create a generic text-message endpoint, a campaign
scheduler, a retry queue, or a marketing system.

## Eligibility contract

`api/_lib/lead-sms-ack.mjs` is the one internal acknowledgement orchestrator. It
invokes the outbound sender only when all of these facts are true for the current
submission:

1. the form is `home_value`;
2. `lead.sms_consent === true` — the visitor ticked SMS on this submission;
3. the server-built SMS consent evidence also records `granted === true`;
4. the append-only consent ledger acknowledged that evidence, so
   `consent.durable === true`;
5. the evidence submission id, form type and consent phone still match the
   validated payload being acted on.

An older HubSpot grant cannot make an unticked current submission generate an
automatic text. A current tick also cannot clear a prior STOP: if the contact is
suppressed or otherwise no longer sendable, Gate 8 denies the provider call.

## Message copy

The acknowledgement uses the first message sample submitted with the approved A2P
campaign, substituting the validated seller address for the placeholder:

> Crystal Sells Toledo: Thanks for your real estate inquiry about [Property Address]. I'll follow up with the information you requested and help with the next step. Reply STOP to opt out.

No free-form visitor text is inserted into the message.

## Send-time authorization remains the authority

Eligibility above decides only whether this current lead may *ask* for the
acknowledgement. The actual transport remains `api/_lib/sms-sender.mjs`.
Immediately before its single Twilio `messages.create()` attempt it calls Gate 8,
which re-reads the current HubSpot consent state and then the durable phone-keyed
Neon suppression state. A STOP that arrived after form submission therefore still
blocks the send.

The static outbound checker enforces one closed production path:

`api/lead.js` → `api/_lib/lead-sms-ack.mjs` → `api/_lib/sms-sender.mjs` → Gate 8 → Twilio

No other production module may import the SMS transport, and no direct Twilio
REST/message-create path is introduced.

## Position in the lead transaction

The SMS acknowledgement is a **courtesy**, like the existing acknowledgement
email. It starts only after `createLead(payload)` has confirmed the mandatory
HubSpot contact write and form-submission timeline activity.

Email and SMS courtesies run concurrently and are awaited through
`Promise.allSettled`. Refusal, suppression, missing outbound configuration,
provider ambiguity, timeout, or an unexpected acknowledgement exception cannot
turn an already-captured lead into a failed website submission. The visitor still
receives the normal 200 response and is not encouraged to create a duplicate
lead.

Logs carry only submission/form identifiers and stable status/reason tokens. They
do not log the phone, email, property address, SMS body, provider exception text,
or credentials.

## Provider attempt and time bound

The sender still makes **at most one** `messages.create()` attempt and keeps
Twilio SDK `autoRetry: false`. An ambiguous timeout or socket failure is not
blindly retried because Twilio may already have accepted the message.

The Twilio 6.1.0 client is now constructed with a **5,000 ms request timeout**.
In that SDK version the constructor timeout becomes both the HTTPS socket timeout
and the default request timeout. This bounds the new courtesy provider call
inside the lead function's 30-second execution budget without weakening Gate 8's
ordering.

## Dark activation state

This implementation does **not** activate outbound SMS.

- `OUTBOUND_SMS_ENABLED` remains off/unset in the staged state.
- No outbound API-key value, Messaging Service credential, or Vercel Production
  setting is added or changed by this repository work.
- No live SMS, HubSpot write, Neon write, or Production form submission is part of
  this implementation verification.

With the outbound flag off, the sender returns `OUTBOUND_SMS_DISABLED` before it
constructs a Twilio client or reaches Gate 8/provider I/O.

## What remains unproven until the controlled Production test

Automated tests can prove eligibility, ordering, failure containment and the
closed call graph. They cannot prove carrier delivery or the full Production
feedback loop.

The final Gate 9 proof still requires a controlled operator-owned handset and
Production configuration:

1. submit a fresh `/home-value` lead with SMS consent checked;
2. observe the automatic Crystal acknowledgement on the handset;
3. reply `STOP`;
4. verify the signed inbound webhook records durable Neon suppression;
5. verify HubSpot projects that suppression;
6. verify the handset receives the provider STOP confirmation.

Until that controlled run succeeds, Production SMS acknowledgement remains
**unproven and intentionally dark**.
