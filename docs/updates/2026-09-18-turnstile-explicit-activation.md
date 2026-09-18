# Turnstile lead protection — explicit activation completion

**Date:** 18 September 2026  
**Status:** LIVE in Vercel Production; positive lead path verified. Live negative-path rejection has not been deliberately exercised.

This document supersedes the **configuration/activation** portions of
`2026-09-18-turnstile-lead-verification.md`. The original document remains the
record of the first implementation pass; the items below are the final contract
and the Production activation record for PR #52.

## Final activation contract

Turnstile has three configuration values:

| Variable | Secret? | Meaning |
|---|---|---|
| `TURNSTILE_ENABLED` | No | authoritative feature switch; only exact `true` enables |
| `TURNSTILE_SITE_KEY` | No | public widget key |
| `TURNSTILE_SECRET_KEY` | **Yes** | server-side redemption key |

States are explicit:

- **Disabled** — flag absent, empty, or exact `false`. Stored keys do not
  activate anything. `/api/lead` makes no Siteverify request and the standard
  build emits no Turnstile loader.
- **Enabled** — exact `true` and both keys present. All protected lead
  submissions must pass server-side verification.
- **Misconfigured** — exact `true` with a missing key, or an invalid nonempty
  flag value. Runtime fails closed. The standard build also refuses an enabled
  deployment missing a key, so a deployment cannot knowingly ship a form that
  has no way to satisfy the gate.

`tools/build-entry.mjs` is the standard build entry point used by
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

`home_value` rejects obvious post-office-box values because that field asks for
the property's physical address. The deterministic rule recognizes common
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

## Production activation — completed 18 September 2026

**Evidence boundary:** repository source proves the code path; the Cloudflare and
Vercel account state below is recorded from the operator's direct actions in the
external dashboards. No secret value is recorded here.

Completed sequence:

1. A Cloudflare Turnstile widget named **Crystal Sells Toledo** was created in
   **Managed** mode for `crystalsellstoledo.com`. Cloudflare's hostname rule
   covers its subdomains, including `www`. **Pre-clearance is OFF.**
2. `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` were added to Vercel
   Production while `TURNSTILE_ENABLED=false`.
3. Production was redeployed with the flag still false. The live lead pages
   continued to render normally; stored keys alone did not activate the gate.
4. `TURNSTILE_ENABLED` was changed to exact `true` and Production was redeployed.
5. The protected lead pages continued to render normally. The browser widget is
   intentionally `appearance: "interaction-only"`, so a low-risk visitor is
   expected to see no visible challenge.
6. The operator submitted one controlled `/home-value` lead with both SMS and
   AI-voice consent boxes left unchecked. The submission succeeded and reached
   HubSpot as **Turnstile QA**.
7. HubSpot was then read through the connected HubSpot tool. The controlled
   contact showed `cst_sms_permission_status = never_granted`. The AI-voice
   permission field was blank/unset; the repository's consent adapter defines a
   blank permission status as `never_granted`. No communications permission was
   manufactured by Turnstile.

**What this establishes:** Turnstile is configured and enabled in Production,
and the legitimate positive lead path works through the enabled deployment to
HubSpot while communications consent remains ungranted when the visitor leaves
both boxes unchecked.

**What remains unobserved live:** no deliberate Production submission with a
missing, invalid, expired, replayed, wrong-host, or wrong-action Turnstile token
has been executed after activation. The fail-closed behavior and the invariant
that a refused verification produces no submission id, consent-ledger append,
HubSpot activity, acknowledgement email, SMS, or AI call are established by the
merged automated tests and code review, not by intentionally generating a
Production failure. This limitation is recorded rather than hidden.

## Operational rollback

If Turnstile must be disabled, set `TURNSTILE_ENABLED=false` in Vercel
Production and redeploy. The stored site and secret keys may remain. Keys alone
do not activate protection.
