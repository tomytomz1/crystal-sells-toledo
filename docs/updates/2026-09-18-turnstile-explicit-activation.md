# Turnstile lead protection — explicit activation completion

**Date:** 18 September 2026  
**Status in this branch:** code complete; external Production activation not performed.

This document supersedes the **configuration/activation** portions of
`2026-09-18-turnstile-lead-verification.md`. The original document remains the
record of the first implementation pass; the items below are the final contract
for PR #52.

## Final activation contract

Turnstile has three configuration values:

| Variable | Secret? | Meaning |
|---|---|---|
| `TURNSTILE_ENABLED` | No | authoritative feature switch; only exact `true` enables |
| `TURNSTILE_SITE_KEY` | No | public widget key |
| `TURNSTILE_SECRET_KEY` | **Yes** | server-side redemption key |

States are explicit:

- **Disabled** — flag absent, empty, or exact `false`. Stored keys do not
  activate anything. `/api/lead` makes no siteverify request and the standard
  build emits no Turnstile loader.
- **Enabled** — exact `true` and both keys present. All protected lead
  submissions must pass server-side verification.
- **Misconfigured** — exact `true` with a missing key, or an invalid nonempty
  flag value. Runtime fails closed. The standard build also refuses an enabled
  deployment missing a key, so a deployment cannot knowingly ship a form that
  has no way to satisfy the gate.

`tools/build-entry.mjs` is now the standard build entry point used by
`npm run build`, `npm run dev`, `npm test`, and therefore Vercel's existing
`npm run build` build command. It also removes Cloudflare's loader/preconnect
from generated pages that contain no `data-turnstile` form mount point.

## Server-side side-effect boundary

The order remains:

```text
method -> origin -> rate limit -> bounded body read -> JSON parse
       -> schema + honeypot
       -> Turnstile verification
       -> submission id -> consent evidence -> durable ledger
       -> HubSpot -> acknowledgement email
```

A Turnstile failure returns before the submission id is minted. The token is
never attached to the normalized lead payload, never persisted, never sent to
HubSpot or the consent ledger, never included in mail, and is redacted if a
future caller accidentally hands a token-bearing object to the log shaper.

Turnstile remains completely independent of communications consent. A verified
human may submit with both SMS and AI-voice consent false. No consent wording,
version identifier, transition rule, suppression rule, STOP/HELP behavior, or
Gate 8 authorization rule changes in this work.

## Property-address hardening

`home_value` now rejects obvious post-office-box values because that field asks
for the property's physical address. The deterministic rule recognizes common
forms including:

- `PO Box`
- `P.O. Box`
- `P O Box`
- `Post Office Box`

It is limited to `home_value`. It does not inspect phone area code, IP location,
email geography, short/unusual names, or subjective "gibberish". A contact-form
message may legitimately mention a mailing P.O. Box and is unaffected.

## Failure vocabulary

Server verification uses fixed, PII-free reasons including:

- `missing_token`
- `malformed_token`
- `verification_failed`
- `hostname_mismatch`
- `action_mismatch`
- `verification_timeout`
- `verification_unavailable`
- `configuration_error`

External hostname/action diagnostics are bounded before logging. Tokens and
secrets are never logged.

## What this branch does **not** establish

This code does not create a Cloudflare widget, set any Vercel variable, submit a
Production lead, change HubSpot, change Twilio, change Neon, or prove live
Cloudflare behavior. Those are external operator actions and remain unperformed
until explicitly authorized.

## Operator activation runbook after merge

1. In Cloudflare Turnstile, create a **Managed** widget for
   `crystalsellstoledo.com` and `www.crystalsellstoledo.com`.
2. Copy the **site key** and **secret key**. Do not paste the secret into chat.
3. In Vercel Production, set `TURNSTILE_SITE_KEY` and
   `TURNSTILE_SECRET_KEY`, while leaving `TURNSTILE_ENABLED=false`.
4. Redeploy and confirm the site still accepts leads normally. Keys alone must
   not activate the gate.
5. Set `TURNSTILE_ENABLED=true` in Vercel Production and redeploy.
6. Confirm a lead-form page loads normally and a non-form page does not load the
   Turnstile script.
7. Perform one controlled legitimate submission. Confirm HubSpot receives it
   and the acknowledgement behavior is unchanged.
8. Confirm a failed/absent verification is refused and creates no HubSpot lead
   or form-submission activity.
9. Confirm SMS and AI-voice consent remain **NOT GRANTED** unless the respective
   boxes were actually selected.
10. If protection must be disabled, set `TURNSTILE_ENABLED=false` and redeploy;
    the stored keys may remain in place.

No Production activation should be described as complete until those live
checks have actually been observed.
