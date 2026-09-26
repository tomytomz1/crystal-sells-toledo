# Current state — crystalsellstoledo.com

This file is the standing truth for a fresh session. It is intentionally an index, not a history. Historical implementation detail belongs in `docs/updates/`, pull requests, and issue #16 (the permanent Pulse Log).

Resolve `origin/main` dynamically. Do not pin this file to a commit SHA merely because `main` moves.

## System shape

- Production branch: **`main`**. Vercel deploys `main`.
- Static pages are built from `src/` into generated `public/`. **Edit `src`, never `public`.**
- Live server endpoints:
  - `api/lead.js` — lead intake and the narrow acknowledgement-SMS trigger.
  - `api/twilio-inbound.js` — signed inbound SMS STOP/HELP/START classification and suppression handling.
  - `api/operator-action.js` — human suppression action for surfaced unclassified SMS.
  - `api/operator-unsuppress.js` — deliberate human unsuppression fallback.
- HubSpot is the live CRM.
- Neon Postgres is the append-only consent/suppression evidence system of record.
- Zoho Mail SMTP is live for acknowledgement/operator email. Zoho CRM is dormant rollback.
- Cloudflare Turnstile is live on the lead path.
- The only outbound SMS application path is `api/lead.js` -> `api/_lib/lead-sms-ack.mjs` -> `api/_lib/sms-sender.mjs`. There is no generic/public send-SMS endpoint.
- No automated AI-voice caller exists.

## Production controls live

### Lead intake / anti-spam

- `TURNSTILE_ENABLED=true` in Production.
- Production has the Turnstile site key and server secret configured.
- Managed mode; pre-clearance off.
- Controlled Production `/home-value` submissions have passed the enabled lead path.

### Communications consent

- `COMMUNICATIONS_CONSENT_ENABLED=true` in Production.
- `/home-value` presents separate optional SMS and AI-voice permission choices, unchecked by default and not required.
- `/sms-privacy`, `/sms-terms`, and `/sms-consent-evidence` are live.
- HubSpot has the `cst_*` communications-consent properties.
- `CONSENT_LEDGER_URL` is configured on the insert-only `consent_ledger_app` role.
- `CONSENT_LEDGER_SENDER_URL` is configured on the read-only sender role.
- `CONSENT_LEDGER_OPERATOR_URL` is configured on the operator role.
- `CONSENT_LEDGER_REOPTIN_URL` is configured on the dedicated re-opt-in role.
- Durable Neon evidence is authoritative; HubSpot is the mutable current-state projection.

### SMS transport / provider controls

- Twilio A2P 10DLC campaign is approved and carrier-registered.
- Advanced Opt-Out is enabled on the Messaging Service.
- `OUTBOUND_SMS_ENABLED=true` in Production.
- Outbound SMS uses its dedicated restricted API-key credentials.
- Inbound webhook signature validation and the Consent Management API use the existing Account SID + `TWILIO_AUTH_TOKEN` contract required by the current Twilio implementation.
- Twilio Compliance Toolkit is enabled. This was required before the Consent Management API endpoint became available to this account.

## Gate status

| Gate | Current status |
|---|---|
| **3 — append-only ledger provisioned** | **CLOSED.** Database, role grants, and append-only behavior verified. |
| **4 — controlled ledger round trip** | **CLOSED.** Application path to Neon and HubSpot verified. |
| **5 — HubSpot timeline display** | **CLOSED.** Full consent/enquiry block rendered untruncated. |
| **6 — A2P Campaign approved** | **CLOSED.** Twilio approved the corrected A2P 10DLC campaign on 18 Sep 2026 and reports it registered with carriers. |
| **7 — inbound STOP / provider confirmations** | **CLOSED.** Real STOP -> Twilio `OptOutType=STOP` -> signed Production webhook -> Neon suppression -> HubSpot projection is proven. Post-approval STOP/START/HELP confirmations reached the handset. |
| **8 — send-time authorization** | **CLOSED.** Production sender-role lookup, durable suppression check, narrow sender path, and real permitted send have all been exercised. |
| **9 — controlled consent -> send -> STOP/DNC** | **CLOSED.** Real consent -> acknowledgement SMS -> STOP -> durable suppression -> HubSpot projection was verified on the controlled handset. |
| **Website SMS re-opt-in** | **CLOSED / ACTIVE.** Prior STOP -> fresh website SMS consent -> Twilio Consent Management API -> durable SMS-only unsuppression -> HubSpot grant -> acknowledgement delivery -> subsequent STOP re-suppression was proven in Production on 26 Sep 2026. |

## Gate 6 — Twilio A2P 10DLC

**CLOSED — approved 18 September 2026.**

- Primary / Individual Customer Profile: approved.
- A2P Brand: approved, Sole Proprietor.
- Messaging Service exists with one 10DLC number.
- Campaign `CM3425248ff3928f6f9c78894afe908ae6`: approved after corrected resubmission.
- Twilio's approval notice states that the campaign is registered with carriers.

The earlier 30882 rejection and `PENDING_REVIEW` state are historical. Do not resubmit or edit the approved campaign merely to reproduce the old remediation sequence.

## Gate 7 — inbound SMS / suppression / Advanced Opt-Out

Production configuration includes the signed Messaging Service webhook:

`https://crystalsellstoledo.com/api/twilio-inbound#rc=3&rp=5xx,ct,rt`

A controlled real STOP proved the full inbound suppression boundary:

1. Twilio classified the message with `OptOutType=STOP`.
2. The signed Production webhook accepted it.
3. Neon appended the durable SMS suppression.
4. HubSpot projected `cst_sms_suppressed=true` with reason `stop_keyword`.

After A2P approval, Twilio-generated STOP, START and HELP confirmation messages all reached the controlled handset.

## Gate 8 — send-time authorization and transport

PR #51 hardened the authorization and transport boundary:

- `api/_lib/send-permission.mjs` is bound to the real HubSpot lookup and real Neon suppression executor;
- durable phone-keyed suppression is the final authorization read before a permitted send;
- authorization and provider send use the same normalized target;
- there is no suspension point between ALLOW and the one provider message attempt;
- ambiguous provider failures are not blindly retried;
- outbound transport uses a dedicated Twilio API-key pair, not `TWILIO_AUTH_TOKEN`.

The sender is no longer dark. The controlled Production acknowledgement send proved the narrow path works when fresh consent exists and durable suppression is clear.

The final durable suppression read and external Twilio acceptance are not one atomic transaction. A STOP already visible at the final read blocks the send; a STOP racing after that read cannot be serialized atomically across Neon and Twilio. The implementation minimizes that interval and later STOP processing restores the durable block.

## Gate 9 — outbound activation

**CLOSED and live.**

A controlled Production exercise proved:

1. a `/home-value` submission with fresh SMS consent recorded durable consent evidence;
2. the acknowledgement SMS was delivered to the controlled handset;
3. the consumer replied `STOP`;
4. Twilio's inbound path reached the signed Production webhook;
5. Neon recorded the durable SMS suppression; and
6. HubSpot projected `cst_sms_suppressed=true` with `cst_sms_suppression_reason=stop_keyword`.

`OUTBOUND_SMS_ENABLED` remains enabled for the narrow acknowledgement path. Do not broaden this into a generic messaging endpoint or bypass Gate 8.

## Website SMS re-opt-in — ACTIVE AND PRODUCTION-VERIFIED

The website re-opt-in path is active. PRs #65 through #68 are historical implementation steps; the current operating model is the automatic path added by #66 and authenticated according to #68.

### Database state

Both migrations are applied in Production Neon:

- `db/004_website_reoptin.sql`
- `db/005_automatic_website_sms_reoptin.sql`

The dedicated `consent_ledger_reoptin` role and its functions were verified after application. The role can execute only the intended re-opt-in functions and does not gain general ledger read/write access or `neon_superuser` membership.

### Production configuration

The active path requires and has:

- `COMMUNICATIONS_CONSENT_ENABLED=true`
- `SMS_REOPTIN_ENABLED=true`
- `CONSENT_LEDGER_REOPTIN_URL`
- `TWILIO_CONSENT_MESSAGING_SERVICE_SID`
- `TWILIO_CONSENT_SENDER_NUMBER`
- existing `TWILIO_ACCOUNT_SID`
- existing `TWILIO_AUTH_TOKEN`

PR #68 changed the Consent Management API authentication contract to Account SID + Auth Token. Dedicated Consent-API key variables are not part of the current runtime contract.

### Provider dependency

Twilio Consent Management API access initially returned HTTP 404 even with the correct endpoint and authentication. Twilio Support identified the account prerequisite: **Compliance Toolkit**. After the operator enabled Compliance Toolkit, the same Production flow succeeded without another code deployment.

This dependency matters for any future market/agent deployment of the platform: a correctly implemented Consent Management API call can still fail closed until the Twilio account has the required product access.

### Proven state transition

On 26 Sep 2026 the controlled handset completed this exact Production cycle:

```text
prior STOP
  -> durable SMS suppression
  -> fresh /home-value SMS consent, AI voice unchecked
  -> Twilio Consent Management API opt-in at Messaging Service + sender level
  -> db/005 re-validates readiness
  -> append-only SMS `unsuppressed / consumer_request`
  -> durable suppression re-read clear
  -> HubSpot projects SMS permission granted and clears current suppression
  -> existing Gate 8 sender authorizes
  -> acknowledgement SMS delivered without the consumer sending START
  -> consumer replies STOP
  -> durable SMS suppression restored
  -> HubSpot projects `cst_sms_suppressed=true`, reason `stop_keyword`
```

HubSpot readback after automatic re-opt-in showed:

- `cst_sms_suppressed=false`
- `cst_sms_permission_status=granted`
- fresh consent source `/home-value`
- fresh consent and re-opt-in timestamps aligned to the controlled submission

HubSpot readback after the final STOP showed:

- `cst_sms_suppressed=true`
- `cst_sms_suppression_reason=stop_keyword`
- the fresh website consent evidence remained preserved

The historical STOP event is never deleted. Re-opt-in is append-only and SMS-only.

### Failure semantics

The path remains fail closed:

- no fresh matching consent -> no clearance;
- global block -> no automatic clearance;
- provider failure or partial success -> suppression remains;
- malformed provider response -> suppression remains;
- Neon completion failure -> suppression remains;
- STOP racing after provider reconciliation is caught by the durable re-read / Gate 8 boundary when visible in time;
- AI voice and global do-not-contact lanes are never automatically cleared.

The inbound Twilio-classified START path remains available as a manual consumer fallback, but START is no longer required for the normal website re-opt-in flow.

## Operator unsuppression

The human-only operator unsuppression workflow remains active as a fallback and for cases the automatic website path must never clear.

Production has:

- `OPERATOR_UNSUPPRESS_SECRET`
- `CONSENT_LEDGER_OPERATOR_URL` on the dedicated `consent_ledger_operator` role

Operator unsuppression never grants consent. It remains the only supported path for `ai_voice`, `all`, and `recorded_in_error` corrections.

Detail: `docs/updates/2026-09-18-unsuppression-operator-workflow.md`.

## Remaining application gaps

- No automated AI-voice caller exists.
- No spoken-DNC Retell ingress exists.
- The provider send and durable suppression store cannot be made one cross-system atomic transaction; the implementation minimizes and guards the race rather than pretending it does not exist.
- Automatic website re-opt-in is intentionally SMS-only. AI voice and global DNC require separate human/operator handling.

## Safe next sequence

1. Preserve the approved A2P campaign, Messaging Service, Advanced Opt-Out, Compliance Toolkit, and current production credentials/configuration.
2. Do not rerun `db/004` or `db/005` merely to reproduce activation history.
3. Do not replace or broaden the narrow acknowledgement sender without a new review of consent, suppression, attribution and failure semantics.
4. Treat a future Twilio account/market rollout as requiring an explicit Compliance Toolkit / Consent Management API access check before automatic website re-opt-in can be considered ready.
5. Move next to the highest-leverage seller-acquisition work only after keeping this file and issue #16 synchronized with any material production change.

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
