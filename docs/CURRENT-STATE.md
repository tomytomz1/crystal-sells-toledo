# Current state — crystalsellstoledo.com

This file is the standing truth for a fresh session. It is intentionally an index, not a history. Historical implementation detail belongs in `docs/updates/`, pull requests, and issue #16 (the permanent Pulse Log).

Resolve `origin/main` dynamically. Do not pin this file to a commit SHA merely because `main` moves.

## System shape

- Production branch: **`main`**. Vercel deploys `main`.
- Static pages are built from `src/` into generated `public/`. **Edit `src/`, never `public/`.**
- Live server endpoints:
  - `api/lead.js` — lead intake.
  - `api/twilio-inbound.js` — signed inbound SMS STOP/HELP/START classification path, and the website re-opt-in reconciliation (off; see below).
  - `api/operator-action.js` — human suppression action for surfaced unclassified SMS.
  - `api/operator-unsuppress.js` — deliberate human unsuppression.
- HubSpot is the live CRM.
- Neon Postgres is the append-only consent/suppression evidence system of record.
- Zoho Mail SMTP is live for acknowledgement/operator email. Zoho CRM is dormant rollback.
- Cloudflare Turnstile is live on the lead path.
- Gate 9's narrow internal outbound path is `api/lead.js` -> `api/_lib/lead-sms-ack.mjs` -> `api/_lib/sms-sender.mjs`, and it is the only outbound SMS path in the repository. There is no generic/public send-SMS endpoint. The operator reports `OUTBOUND_SMS_ENABLED=true` in Production; see the Gate 9 section below for what that report does and does not evidence here.
- No automated AI-voice caller exists.

## Production controls already live

### Lead intake / anti-spam

- `TURNSTILE_ENABLED=true` in Production.
- Production has the Turnstile site key and server secret configured.
- Managed mode; pre-clearance off.
- A controlled `/home-value` submission passed the enabled Production path and reached HubSpot with communications consent ungranted.

### Communications consent

- `COMMUNICATIONS_CONSENT_ENABLED=true` in Production.
- `/home-value` presents separate optional SMS and AI-voice permission choices, unchecked by default and not required.
- `/sms-privacy`, `/sms-terms`, and `/sms-consent-evidence` are live.
- HubSpot has the `cst_*` communications-consent properties.
- `CONSENT_LEDGER_URL` is configured in Production on the insert-only `consent_ledger_app` role.
- Durable Neon evidence is authoritative; HubSpot is mutable current-state projection.
- Consent collection does **not** activate outbound SMS or voice.

## Gate status

| Gate | Current status |
|---|---|
| **3 — append-only ledger provisioned** | **CLOSED.** Database, role grants, and append-only behavior verified. |
| **4 — controlled ledger round trip** | **CLOSED.** Application path to Neon and HubSpot verified. |
| **5 — HubSpot timeline display** | **CLOSED.** Full consent/enquiry block rendered untruncated. |
| **6 — A2P Campaign approved** | **CLOSED.** Twilio approved the corrected A2P 10DLC campaign on 18 Sep 2026 and reports it registered with carriers. |
| **7 — inbound STOP / provider opt-out confirmations** | **CLOSED.** Real STOP -> Twilio `OptOutType=STOP` -> signed Production webhook -> Neon suppression -> HubSpot projection is proven, and post-approval STOP/START/HELP confirmation messages all reached the handset. |
| **8 — send-time authorization** | **CLOSED FOR THE DARK AUTHORIZATION BOUNDARY; SENDER STILL DARK.** Dedicated sender-role DB lookup has been executed successfully by the deployed Production app. The internal Gate 9 call path exists, but the outbound feature flag remains off. |
| **9 — controlled consent -> send -> STOP/DNC** | **REPORTED CLOSED BY THE OPERATOR, NOT VERIFIED BY THIS REPOSITORY.** See the Gate 9 section below for exactly what was reported and what remains unevidenced here. |

## Gate 6 — Twilio A2P 10DLC

**CLOSED — approved 18 September 2026.**

- Primary / Individual Customer Profile: **approved**.
- A2P Brand: **approved**, Sole Proprietor.
- Messaging Service exists with one 10DLC number.
- Campaign `CM3425248ff3928f6f9c78894afe908ae6`: **approved** after corrected resubmission.
- Twilio's approval notice states that the campaign is registered with carriers.
- The approval notice was received on 18 Sep 2026 after the second submission.

The earlier 30882 rejection and `PENDING_REVIEW` state are historical. Do not resubmit or edit the approved campaign merely to reproduce the old remediation sequence.

Gate 6 approval does **not** itself activate application sending. The dark sender, API-key credentials, feature flag, consent checks, durable suppression checks, and controlled Gate 9 exercise remain separate application controls.

## Gate 7 — inbound SMS / suppression / Advanced Opt-Out

Production configuration includes:

- `TWILIO_AUTH_TOKEN`;
- `OPERATOR_ACTION_SECRET`;
- `CONSENT_LEDGER_URL`;
- the Zoho Mail values required for operator surfacing;
- Messaging Service webhook:
  `https://crystalsellstoledo.com/api/twilio-inbound#rc=3&rp=5xx,ct,rt`;
- Advanced Opt-Out enabled.

### Real STOP proof

A controlled real STOP reached Twilio and the deployed Production webhook. Production logs classified it with `rule=opt_out_type_stop`, which requires Twilio to have supplied `OptOutType=STOP`. The application then:

1. accepted the signed inbound request;
2. appended the durable SMS suppression in Neon; and
3. projected the suppression to HubSpot.

This closes the application suppression boundary.

### Provider confirmation delivery — closed

Before A2P approval, the handset did not receive Twilio-generated HELP, STOP, or START confirmations even though Advanced Opt-Out was enabled and inbound handling worked.

After Twilio approved the corrected A2P campaign, the operator retested all three keywords and confirmed that the Twilio-generated confirmations for **STOP, START, and HELP all reached the handset**.

The prior delivery incident is therefore closed. The timing strongly suggests the earlier non-delivery was associated with the not-yet-approved campaign/carrier registration state, but that causal attribution is not proven without Twilio/carrier internal traces.

START remains a provider-level opt-in action and an application re-opt-in request signal; it does **not** by itself manufacture fresh local consent in HubSpot/Neon.

## Operator unsuppression

The human-only unsuppression workflow is **ACTIVE AND WRITE-VERIFIED IN PRODUCTION**.

Production has:

- `OPERATOR_UNSUPPRESS_SECRET`;
- `CONSENT_LEDGER_OPERATOR_URL` on the dedicated `consent_ledger_operator` role.

A controlled operator action against the real QA STOP suppression proved:

> fresh active-block read -> validated human decision -> append `unsuppressed` -> durable post-read -> HubSpot clearance projection

Observed result:

- durable block before: SMS;
- durable block after: none;
- HubSpot projection: one matching contact updated.

Independent HubSpot readback confirmed:

- `cst_sms_suppressed=false`;
- `cst_sms_permission_status=never_granted`;
- current SMS suppression timestamp/reason cleared; and
- the earlier re-opt-in request remained recorded.

**Unsuppression never grants consent.** It also does not reconcile Twilio provider-level opt-out state.

This workflow is **unchanged** by the website re-opt-in path below, and remains
the documented fallback and the only path that can clear an `ai_voice` or `all`
lane or record a `recorded_in_error` correction.

Detail: `docs/updates/2026-09-18-unsuppression-operator-workflow.md`.

## Gate 8 — send-time authorization and dark SMS transport

PR #51 hardened the authorization and transport boundary:

- `api/_lib/send-permission.mjs` is bound to the real HubSpot lookup and real Neon suppression executor;
- durable phone-keyed suppression is the final provider read before a permitted send;
- authorization and provider send use the same normalized target;
- there is no suspension point between ALLOW and `messages.create()`;
- the transport performs at most one provider attempt and does not blindly retry ambiguous failures;
- outbound transport uses a Twilio API-key pair, never `TWILIO_AUTH_TOKEN`.

### Dedicated Production sender role

`CONSENT_LEDGER_SENDER_URL` is configured in Production on the dedicated `consent_ledger_sender` role. The role itself had already been verified to execute `get_suppression_state(text)` while being refused direct ledger reads/writes.

A temporary one-shot Production probe then exercised `lookupDurableSuppression()` from the deployed Vercel application using a fixed fictional NANP number and returned **HTTP 204**. The probe accepted no user phone input, returned no suppression state, imported no outbound sender, and had no SMS capability. It was removed immediately after verification.

This closes the remaining Production application-binding evidence gap for the sender-role lookup.

### Sender remains dark

Gate 9 now provides exactly one internal application path to the sender, but that does **not** activate outbound SMS:

- `api/lead.js` may invoke only `api/_lib/lead-sms-ack.mjs`, which is the sole production importer of `api/_lib/sms-sender.mjs`;
- the acknowledgement requires fresh current-submission SMS consent plus acknowledged durable evidence before it can ask the sender to act;
- the sender still performs Gate 8 immediately before its one Twilio attempt;
- `OUTBOUND_SMS_ENABLED` remains off/unset;
- outbound Twilio API-key variables have not been configured for activation;
- no SMS has been sent by the application sender during Gate 8 or staged Gate 9 verification;
- there is no generic/public endpoint for arbitrary outbound SMS.

The final Gate 8 suppression read and the external Twilio acceptance are not one atomic transaction. A suppression already visible at the final read blocks the send; a STOP racing after that read cannot be serialized atomically across Neon and Twilio. The sender minimizes that interval by allowing no await or other side effect between ALLOW and `messages.create()`.

Now that Gate 6 is approved, outbound credentials may be configured only as part of a deliberate Gate 9 activation plan. Do not set `OUTBOUND_SMS_ENABLED=true` until the controlled send target, fresh consent evidence, rollback/disable path, and evidence-capture steps are ready.

## Gate 9 — outbound activation

**Reported closed by the operator on or before 21 September 2026. Recorded here
with its provenance rather than as a repository-verified fact.**

The operator's session brief states that in Production, with
`OUTBOUND_SMS_ENABLED=true` and Twilio Advanced Opt-Out active:

- an opted-in `/home-value` submission sent the acknowledgement SMS;
- the consumer replied `STOP`;
- the durable suppression path ran;
- HubSpot projected `cst_sms_suppressed=true`;
- the suppression reason was `stop_keyword`.

**What this file does not assert.** No session recorded in this repository has
itself read those Twilio, Neon or HubSpot records. The next session to touch
Gate 9 should confirm the readings directly — and post them to the Pulse Log —
before any further claim rests on them. Sections written before 21 September
2026 that describe the sender as dark describe the state at their own date.

## Website SMS re-opt-in — BUILT AND OFF

An automatic two-factor clearance exists in the repository and is **not
activated anywhere**.

- `SMS_REOPTIN_ENABLED` is unset in every environment. Only exact `"true"`
  enables it.
- `CONSENT_LEDGER_REOPTIN_URL` is configured in no environment.
- **`db/004_website_reoptin.sql` has not been applied to any database**, so
  `get_reoptin_readiness()` does not exist in Neon and the
  `consent_ledger_reoptin` role does not exist.

With either switch absent, `api/twilio-inbound.js` behaves exactly as it did
before: a `START` is recorded as a re-opt-in request and the suppression stands.

**What it does when activated.** A previous `STOP` is lifted only when BOTH a
fresh, phone-matched, durably evidenced website SMS consent AND a
**Twilio-classified** `OptOutType=START` from that handset are on record. The
clearance is a new append-only `unsuppressed`/`consumer_request` event that
db/003 folds exactly as it folds the operator's; the original `STOP` row is
never touched. A ticked box alone clears nothing, a `START` alone clears
nothing, and a locally classified opt-in word clears nothing — only Twilio's own
`OptOutType` says the provider lifted its own block.

It never clears an `ai_voice` or `all` lane, and it never writes a
`recorded_in_error` correction. Both remain the human operator's alone.

Full design, the Twilio research it rests on, the residual abuse risk, the
failure semantics and the production verification sequence:
`docs/updates/2026-09-21-website-sms-reoptin.md`.

**Twilio provider-level opt-out.** Twilio publishes no REST API for removing a
number from a Messaging Service's Advanced Opt-Out block list, so none is
called. Reconciliation happens because Twilio lifts its own block when it
processes the `START` that triggers ours. Twilio's Consent Management API is a
recorded follow-up, not a dependency — §2.2 of that document says why.

## Remaining application gaps

- Gate 9's closure is an operator report this repository has not independently verified.
- No automated AI-voice caller exists and no spoken-DNC Retell ingress exists.
- Operator unsuppression still does not reconcile Twilio provider-level opt-out
  state. The website re-opt-in path does, by triggering on the provider's own
  `START` — but it is not activated, and `db/004` is not applied.
- There is no supported Twilio API for clearing an Advanced Opt-Out block list
  entry, so no code path attempts one.

## Safe next sequence

1. Preserve the approved A2P campaign and working Messaging Service / Advanced Opt-Out configuration.
2. **Verify the Gate 9 report directly** — read the Twilio, Neon and HubSpot records for the exercise the operator described, record the actual readings in the Pulse Log, and reconcile the Gate 9 section above with what was observed rather than with what was reported.
3. Only then, activate the website SMS re-opt-in, in this order and no other: apply `db/004_website_reoptin.sql` as the table owner and run its §4 verification in full; configure `CONSENT_LEDGER_REOPTIN_URL` while leaving `SMS_REOPTIN_ENABLED` unset and confirm the endpoint is unchanged; prove the credential from the deployed application; then set the flag for one controlled exercise.
4. Execute that exercise end to end — consent, send, `STOP`, fresh consent, `START` — and capture Twilio, Neon, HubSpot and handset evidence at every step. The exact sequence is `docs/updates/2026-09-21-website-sms-reoptin.md` §11.
5. Disable or leave enabled only according to the explicit post-test operating decision.

## Repository / release controls

`main` is Production and is protected by active repository ruleset **Protect Main**. The ruleset targets the default branch with no bypass actors and enforces:

- pull request before merge;
- GitHub Actions `test` status check before merge;
- branch deletion blocked; and
- non-fast-forward / force pushes blocked.

Required approving reviews remain 0 for the single-maintainer workflow. The required status check does not require branches to be up to date before merge.

The `test` workflow also runs on pushes to `main`. `npm run verify:live` remains a separate post-deploy public-site check.

## Reading order for a fresh session

1. `CLAUDE.md`
2. this file
3. `docs/WORKFLOW.md`
4. current `origin/main`
5. latest relevant PR + Pulse handoff
6. issue #16 if it contains newer external/configuration truth
7. a specific `docs/updates/` document only when the task needs its history/detail

When repository prose conflicts with newer external evidence, record the correction and reconcile this file. Never ask the operator to repeat configuration already evidenced in the Pulse Log.
