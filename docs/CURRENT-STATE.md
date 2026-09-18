# Current state — crystalsellstoledo.com

This file is the standing truth for a fresh session. It is intentionally an index,
not a history. Historical implementation detail belongs in `docs/updates/`, pull
requests, and issue #16 (the permanent Pulse Log).

Resolve `origin/main` dynamically. Do not pin this file to a commit SHA merely because
`main` moves.

## System shape

- Production branch: **`main`**. Vercel deploys `main`.
- Static pages are built from `src/` by `tools/build.mjs` into generated `public/`.
  **Edit `src/`, never `public/`.**
- Live server endpoints:
  - `api/lead.js` — lead intake. **Live.**
  - `api/twilio-inbound.js` — inbound SMS STOP/HELP/classification path. **Configured in
    Production; partially live-verified.**
  - `api/operator-action.js` — human suppression action for surfaced unclassified SMS.
    **Configured in Production.**
  - `api/operator-unsuppress.js` — deliberate human unsuppression. **Configured and
    read-verified in Production; write path not live-verified.**
- `api/_lib/sms-sender.mjs` exists, but is deliberately **dark/unreachable**. No live
  endpoint imports it and `OUTBOUND_SMS_ENABLED` remains off/unset.
- No automated AI-voice caller exists. No Retell webhook exists for spoken do-not-call.
- **HubSpot is the live CRM.** Zoho CRM code is dormant rollback code. Zoho **Mail** SMTP
  is live for the acknowledgement/operator-email transport.

## Production controls already live

### Lead intake / anti-spam

Cloudflare Turnstile is live on the lead path:

- `TURNSTILE_ENABLED=true` in Production.
- Production has the Turnstile site key and server secret configured.
- The widget is Managed mode; pre-clearance is off.
- A controlled `/home-value` submission passed the enabled Production path and reached
  HubSpot with SMS and AI-voice consent ungranted.
- Deliberate invalid/replayed/wrong-host Production challenge failures have **not** been
  generated; fail-closed behavior for those cases is established by code/tests, not by a
  destructive Production test.

Detail: `docs/updates/2026-09-18-turnstile-explicit-activation.md`.

### Communications consent

Communications consent is **ON in Production**.

- `COMMUNICATIONS_CONSENT_ENABLED=true` is configured in Production.
- `/home-value` renders separate optional SMS and AI-voice consent choices, unchecked by
  default and not required.
- `/sms-privacy`, `/sms-terms`, and `/sms-consent-evidence` are live.
- HubSpot has the 23 `cst_*` Contact properties; the six timestamp properties are genuine
  `datetime` fields.
- `CONSENT_LEDGER_URL` is configured in Production on the insert-only
  `consent_ledger_app` role.
- The append-only Neon ledger is the durable evidence system of record; HubSpot `cst_*`
  properties are mutable current-state projection only.
- A controlled Preview round trip proved ledger -> HubSpot contact -> HubSpot timeline,
  and the ledger evidence survived deletion of the HubSpot contact.

No consumer outbound SMS or AI-voice traffic is active merely because consent is being
collected.

## Gate status

| Gate | Current status |
|---|---|
| **3 — append-only ledger provisioned** | **CLOSED.** Database, role grants, and append-only behavior verified. |
| **4 — controlled ledger round trip** | **CLOSED.** Preview application path to Neon and HubSpot verified. |
| **5 — HubSpot timeline display** | **CLOSED.** Full consent/enquiry block rendered untruncated. |
| **6 — A2P Campaign approved** | **OPEN.** Campaign rejected with Twilio 30882, remediated, **not resubmitted**; ticket `#29582556` remains the decision point. |
| **7 — inbound STOP/HELP suppression** | **CONFIGURED / PARTIALLY VERIFIED, NOT CLOSED.** Twilio webhook + Advanced Opt-Out are configured and HELP ingress reached the deployed endpoint, but no real STOP -> durable Neon -> HubSpot round trip has been executed. |
| **8 — send-time authorization** | **HARDENED AND MERGED; SENDER STILL DARK.** Dedicated sender DB credential is configured in Production, but application execution of that credential is unproven and no live sender imports the module. |
| **9 — controlled consent -> send -> STOP/DNC** | **OPEN.** Cannot be executed until the outbound path is deliberately activated after Gate 6 readiness. |

## Gate 6 — Twilio A2P 10DLC

Current externally reported state:

- Primary / Individual Customer Profile: **approved**.
- A2P Brand: **approved**, Sole Proprietor.
- Messaging Service: exists with one 10DLC number.
- Campaign `CM3425248ff3928f6f9c78894afe908ae6`: **rejected 30882** (Terms &
  Conditions vetting), corrected in Console, **not resubmitted**.
- Twilio support ticket `#29582556`: open with 10DLC Onboarding.

The operator has already asked Twilio to identify the specific condition causing 30882,
clarify whether it is a remediable Terms/consent issue or prohibited-use-case issue, and
state whether the corrected existing Campaign should be resubmitted.

**Do not reduce 30882 to a single cause and do not resubmit merely because the website was
corrected.** Wait for the specific support answer or an explicit operator decision.

Relevant records:

- `docs/updates/2026-09-16-a2p-campaign-live-preflight.md`
- `docs/updates/2026-09-16-a2p-30882-remediation.md`
- `docs/updates/2026-09-16-a2p-consent-evidence.md`

## Gate 7 — inbound SMS / suppression

### External configuration already completed

Per operator action and Pulse evidence on 16–18 September 2026:

- `TWILIO_AUTH_TOKEN` is configured in Vercel Production.
- `OPERATOR_ACTION_SECRET` is configured in Vercel Production.
- `CONSENT_LEDGER_URL` is configured in Production.
- Zoho Mail SMTP variables required for operator surfacing are present in Production.
- Twilio Messaging Service inbound webhook is configured to:
  `https://crystalsellstoledo.com/api/twilio-inbound#rc=3&rp=5xx,ct,rt`
- Advanced Opt-Out is enabled.
- A real inbound HELP test produced **TwiML Fetched** in Twilio, establishing signed webhook
  reachability/acceptance by the deployed endpoint.
- The consumer did **not** receive the HELP reply in that test. Outbound HELP confirmation
  delivery therefore remains unproven.

A fresh read-only Production `GET /api/operator-action` without a capability returned
**400**, not configuration-failure **503**, proving the deployed operator-action secret gate
is configured.

### What is still unproven

No real STOP has yet been run through the whole durable path:

`Twilio inbound -> signature validation -> classification -> Neon suppression event -> HubSpot projection`

Until that controlled test succeeds, Gate 7 is not closed.

Do not infer from HELP ingress that STOP persistence or HubSpot projection is proven.

## Operator unsuppression

The unsuppression workflow from PR #54 is **ACTIVE AND READ-VERIFIED IN PRODUCTION**.

- `OPERATOR_UNSUPPRESS_SECRET` is configured in Production.
- `CONSENT_LEDGER_OPERATOR_URL` is configured in Production on the dedicated
  `consent_ledger_operator` role.
- A no-capability Production GET returned **400**, not configuration-failure **503**.
- A 24-hour off-platform capability sealed to a controlled QA number and the `sms` lane
  decrypted successfully in Production and completed the one-number Neon read.
- The page rendered **Nothing to clear**, proving the Production secret matched and the
  operator DB credential could execute the read boundary.

This was **read-only**. No Production POST unsuppression has been executed; therefore no
live blocked -> unblocked append, post-read, or HubSpot clearance projection is proven.
Unsuppression never grants consent; a cleared channel resets to no current grant.

Detail: `docs/updates/2026-09-18-unsuppression-operator-workflow.md`.

## Gate 8 — send-time authorization and dark SMS transport

Gate 8 and the first outbound SMS transport are merged to `main` through PR #51.
Post-merge workflow run **#184** on merge commit
`c36f0d000bc61940910211cd98dd50f10ed6991e` completed successfully.

### Authorization boundary

`api/_lib/send-permission.mjs` is bound at module load to the real HubSpot contact lookup
and the real Neon suppression executor. The old production-callable mutable test seams
(`_setSuppressionExecutor` / `_setContactLookup`) are gone.

For an otherwise-sendable SMS, durable phone-keyed suppression is the last provider read
before the sender's side effect.

### Sender containment

`api/_lib/sms-sender.mjs` exists but is intentionally unreachable from live application
code:

- no endpoint/orchestrator imports it;
- `OUTBOUND_SMS_ENABLED` remains off/unset;
- outbound Twilio API-key credentials are not configured;
- no SMS has been sent by this module.

The sender performs one authorization per attempted send, uses the same normalized target
for authorization and send, places no suspension point between ALLOW and
`messages.create()`, and performs at most one provider attempt. Ambiguous provider failures
remain `unknown`; the module does not blindly retry them.

### Production sender-role credential

`CONSENT_LEDGER_SENDER_URL` **is configured in Vercel Production** on the dedicated
`consent_ledger_sender` role and Production was redeployed.

That proves the external configuration step, **not application execution**. Because the
sender is dark, no live application path has yet executed Gate 8's suppression lookup with
that Production binding.

Do not add outbound Twilio credentials or set `OUTBOUND_SMS_ENABLED=true` merely to prove
the database credential. Use a deliberately designed read-only verification if/when that
boundary is tested.

Detail: `docs/updates/2026-09-17-outbound-sms-sender.md` and PR #51.

## Remaining application gaps

- **Gate 6** A2P Campaign approval/resubmission decision remains external and unresolved.
- **Gate 7** needs one controlled real STOP durable round trip.
- **Gate 8** needs safe Production execution evidence for the dedicated sender-role lookup;
  no public diagnostic/send endpoint should be added casually for that purpose.
- **Gate 9** remains open until compliant outbound sending is deliberately activated.
- No automated AI-voice caller exists and no spoken-DNC Retell ingress exists.
- Twilio-side opt-out state and local unsuppression remain separate systems; the first
  unsuppression implementation does not reconcile Twilio's provider-level opt-out state.

## Safe next sequence

1. Keep the outbound SMS sender dark while Twilio ticket `#29582556` is unresolved.
2. Reconcile/close the current documentation drift (this work).
3. Perform the controlled Gate 7 STOP round trip when the operator chooses; this is inbound
   verification and does not require enabling outbound SMS.
4. Design and execute a read-only Gate 8 Production sender-role lookup proof without exposing
   a send surface.
5. Resolve Gate 6 with Twilio and only then configure the outbound Twilio API-key variables
   and deliberately decide whether to set `OUTBOUND_SMS_ENABLED=true`.
6. Execute Gate 9 as a controlled consent -> send -> STOP/DNC exercise, with durable and CRM
   evidence captured.

## Repository / release controls

- `main` is Production and Vercel deploys every push to it.
- The GitHub `test` workflow runs the full suite on PRs and pushes to `main`, including a
  real PostgreSQL service for the suppression/unsuppression fold.
- The `main` branch is currently **not protected** by GitHub branch protection. Process
  discipline therefore matters: material changes go through PR + CI + explicit operator
  merge approval.
- `npm run verify:live` is a post-deploy public-site verification and is intentionally not
  part of the offline release gate.

## Reading order for a fresh session

1. `CLAUDE.md`
2. this file
3. `docs/WORKFLOW.md`
4. current `origin/main`
5. latest relevant PR + Pulse handoff
6. issue #16 if it contains newer external/configuration truth
7. a specific `docs/updates/` document only when the task needs its history/detail

When repository prose conflicts with newer external evidence, record a new correction and
reconcile this file. Never ask the operator to repeat configuration already evidenced in the
Pulse Log.