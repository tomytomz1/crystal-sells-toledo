# Gate 4 Stage B and gate 5 — the full path, verified live

**10 September 2026.** No code changed. This records what was observed.

Assume no repository access and no memory of previous conversations.

## What this closes

Two gates, and the last open question from §6a.

- **Gate 4 Stage B** — a real submission travelling the whole path: Vercel
  Preview form → Neon consent ledger → HubSpot contact → HubSpot timeline
  activity, with the `cst_*` permission written and the `CONSENT LEDGER:
  RECORDED` row rendered.
- **Gate 5** — whether the HubSpot UI shows an operator the whole enquiry block
  or truncates it. It shows all of it.

Stage A — the ledger append itself — closed earlier the same day; see
`docs/updates/2026-09-09-consent-ledger-provisioning-verification.md` §10 and
`docs/updates/2026-09-10-consent-ledger-conflict-target-privilege.md`.

## What was set up, and what deliberately was not

Three variables were re-scoped in Vercel from **Production** to **Production and
Preview**, one at a time:

| Variable | Why it is required |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | authenticates both the Contacts API write and the Forms Submission API |
| `HUBSPOT_PORTAL_ID` | part of the Forms Submission URL — without it the timeline activity has nowhere to go |
| `HUBSPOT_FORM_GUID` | names which form the timeline activity attaches to |

Those three are exactly what `isConfigured()` in `api/_lib/hubspot.mjs` tests.
Below that bar the endpoint returns 503 at `lead.not_configured`, which is what
every earlier preview submission did.

Four things were deliberately **not** given to Preview:

- **`ZOHO_SMTP_HOST` / `PORT` / `USER` / `PASSWORD`.** With them absent,
  `sendAcknowledgement()` returns `{ sent: false, reason: "not_configured" }`,
  logs `lead.ack.skipped`, and the submission still returns 200. Their absence
  is what stopped an acknowledgement email reaching the test address — a side
  effect avoided for free.
- **`GA4_MEASUREMENT_ID` / `GA4_FORCE`.** Preview traffic would pollute real
  analytics.
- **`ALLOWED_ORIGINS`.** Unnecessary: `allowedHosts()` already admits
  `VERCEL_URL` and `VERCEL_BRANCH_URL`, which Stage A had already proven works.
- **`HUBSPOT_API_BASE` / `HUBSPOT_FORMS_BASE`.** Set in no environment; the code
  defaults to `api.hubapi.com` and `api.hsforms.com`.

Development scope was left unticked on every variable.

## The submission

One contact-form submission on the Preview deployment. Synthetic name
("Ledger Verification"), an operator-controlled email never previously used with
this site, an operator-controlled phone, **SMS box ticked, AI voice box left
unticked**.

The asymmetry was the point: it produces one `consent_selected` row and one
`consent_not_selected` row, exercising both event types and testing the rule
that an unticked box is a recorded decision and never a revocation.

A fresh email mattered too — `createLead()` searches HubSpot by email first, so
a reused address would have produced `action: update` against a real contact
instead of a clean `create`, and cleanup would have been destructive.

### What the function logged

```
02:26:44.229  lead.consent.captured
02:26:45.019  lead.consent.ledger_appended        ← 790 ms
02:26:45.019  lead.accepted
02:26:45.744  hubspot.contact.saved   action=create  has_id=true
02:26:46.024  hubspot.form.submitted  contact_action=create
02:26:46.025  lead.delivered          action=create  ms=1800
02:26:46.025  lead.ack.skipped        reason=not_configured
```

HTTP **200**, function duration 2.01 s, four external POSTs — Neon `/sql`, the
HubSpot contact search, the contact create, the form submission.

**The ledger append preceded the CRM write by 725 ms.** That ordering is the
architecture: the durable evidence lands first, and only a confirmed append sets
`payload.consent.durable`, which is what lets `api/_lib/hubspot.mjs` write a
permission at all. `tools/check.mjs` enforces the ordering statically and a test
pins it; this is the first time it has been observed happening for real.

## What the three records held

### 1. The ledger — the system of record

Two rows for submission `csv_5845df0fd70f7f9991e179a5`, read back with the
**owner** credential (the application role cannot read):

| | `sms` row | `ai_voice` row |
|---|---|---|
| `event_type` | `consent_selected` | `consent_not_selected` |
| `source` | `website` | `website` |
| `schema_version` | 1 | 1 |
| `consent_copy_version` | `CST_SMS_CONSENT_2026_09_V1` | `CST_AI_VOICE_CONSENT_2026_09_V1` |
| `event_id` database-generated | true | true |
| `recorded_at` database-generated | true | true |
| `phone_e164` matches `^\+1[0-9]{10}$` | true | true |
| `length(consent_copy_text)` | 335 | 330 |
| `hubspot_contact_id` | **NULL** | **NULL** |

`hubspot_contact_id` being NULL is correct and deliberate. The contact id does
not exist until after the CRM write, which is after the append, and the
application role holds no `UPDATE` with which to backfill it. Correlation for a
website event is by `submission_id`, which appears in the ledger, in the HubSpot
enquiry block, and in every log line for the request.

### 2. The HubSpot contact — current permission state

`Communications consent: 6 of 23 properties`, with blank properties hidden.

The six present:

| Property | Value |
|---|---|
| SMS permission status | **Granted** |
| SMS consent captured at | 09/09/2026 10:26 PM EDT |
| SMS consent copy version | `CST_SMS_CONSENT_2026_09_V1` |
| SMS consent page | `/contact` |
| SMS consent phone | the number submitted |
| SMS consent source form | `contact` |

**The other seventeen were blank** — every `cst_ai_voice_*`, `cst_sms_suppressed`
and its timestamp and reason, `cst_do_not_call`, `cst_do_not_contact`,
`cst_reoptin_requested_*`.

This is the invariant that matters most in the whole consent model, and it holds:
**an unticked box writes nothing.** It is recorded in the ledger as
`consent_not_selected`, a decision that was made, and nowhere in HubSpot as a
permission state — above all not as a suppression. Reading a blank box as a
withdrawal would silently destroy lawful permissions.

### 3. The timeline activity — the operator-visible evidence copy

All **34 rows**, verified label by label against `api/_lib/description.mjs`: the
23 base rows `FORM` through `SUBMISSION ID`, then the eleven consent rows.

```
SUBMISSION ID: csv_5845df0fd70f7f9991e179a5
CONSENT LEDGER: RECORDED
SMS CONSENT: GRANTED
SMS CONSENT VERSION: CST_SMS_CONSENT_2026_09_V1
SMS CONSENT TEXT: I agree to receive text messages from Crystal Sells Toledo
  about my real estate inquiry, appointments, requested information, and related
  services. Message frequency varies. Message and data rates may apply. Reply
  STOP to opt out or HELP for help. Consent is not a condition of service. See
  the Privacy Policy and Communications Terms.
SMS CONSENT AT: 2026-09-10T02:26:44.227Z
SMS CONSENT PHONE: (…)
AI VOICE CONSENT: NOT GRANTED
AI VOICE CONSENT VERSION: CST_AI_VOICE_CONSENT_2026_09_V1
AI VOICE CONSENT TEXT: I agree to receive calls from Crystal Sells Toledo at the
  number I provided, including calls using automated technology and an
  artificial, prerecorded, or AI-generated voice, about my real estate inquiry,
  appointments, and requested services. Consent is not a condition of service.
  See the Privacy Policy and Communications Terms.
AI VOICE CONSENT AT: -
AI VOICE CONSENT PHONE: -
```

**No ellipsis, no "show more", no truncation, no scroll clipping.** That is
gate 5 answered.

Both disclosure texts render in full. This is the point of storing the text and
not only the version string: the version identifies the disclosure, but the text
*is* the disclosure, and it must be readable years later by someone who does not
have the revision of the source that was deployed that day.

`AI VOICE CONSENT: NOT GRANTED` still carries its full disclosure text, so a
reader can see exactly what was declined. "Not granted" — never "revoked".

### A note on the contact's `Message` property

The contact sidebar's enquiry field shows only three lines — `FORM`, `TOPIC`,
`MESSAGE`. That is correct and not truncation. `toContactProperties()` writes
`buildSummary()`, a concise latest-enquiry summary that does not accumulate;
`toFormSubmission()` writes `buildDescription()`, the full block, to the
timeline. The sidebar is meant to be short. The timeline is where the evidence
lives.

## The deletion-survival test

The HubSpot contact was then **deleted**, deliberately, as a verification rather
than only as cleanup.

| | Before | After |
|---|---|---|
| HubSpot contact | present | deleted (recycle bin) |
| HubSpot timeline activity | present | **gone with the contact** |
| Ledger rows for that submission | 2, texts 335 / 330 | **2, texts 335 / 330** |
| `count(*) where source = 'website'` | 4 | **4** |
| `count(*)` | 6 | **6** |

The evidence that survives is the evidence that was never HubSpot's to delete.

This is precisely the §6a finding acted on: a HubSpot form submission can be
permanently and irreversibly deleted, individually or in bulk, which removes it
from the contact's timeline. If the timeline were the only record, the consent
would vanish with it — and automated messaging would then be running on
permissions with no evidence behind them. The ledger exists so that deletion
costs the operator's convenient copy and not the proof.

**It was a standard delete, not a permanent purge**, so the contact is
restorable from HubSpot's recycle bin for 90 days.

## What this created that is still there

- **Six rows in the Neon ledger**, all synthetic: two provisioning rows from
  9 September (`form_type = setup_verification`) and four website rows from the
  two Preview submissions on 10 September. Retained deliberately as evidence. No
  real visitor's consent is in this table.
- **One HubSpot contact in the recycle bin**, restorable for 90 days.
- **One HubSpot notification email** reached the form owner's inbox about a test
  lead. HubSpot sends this itself, from `noreply@notifications.hubspot.com`; it
  is not the site's acknowledgement email, which did not fire. This was not
  predicted before the test.

## The exposure this leaves behind

**The three HubSpot variables were left scoped to Preview.**

There is no HubSpot sandbox in this setup, so **any Preview deployment of any
branch can now create real contacts and real timeline activities in the
production CRM**, and HubSpot will email the form owner each time. That is a
standing exposure which did not exist before 10 September 2026.

It is convenient — further verification needs no re-scoping — and it is a real
widening of what a preview build can touch. Removing the three variables from
Preview returns it to a 503 at delivery, with the ledger append still working.
**This is a live decision, not a settled one.**

## Production

**Unchanged.** `COMMUNICATIONS_CONSENT_ENABLED` remains absent from Vercel
Production, so the live site renders no consent tick boxes, never loads the Neon
driver and never calls the ledger. `CONSENT_LEDGER_URL` remains absent from
Production. No Production deployment was created, promoted or rolled back.

The live **HubSpot portal**, however, was written to and then cleaned up. Preview
and Production are separate deployments; they are not separate CRMs.

## What is explicitly still unproven

- **Replay against Neon.** The per-row no-op and the partial heal are measured
  against a local Postgres 16 with `db/001` applied verbatim. **No submission
  has ever been replayed onto an existing dedupe key in the live ledger.** This
  is now the oldest outstanding gap in the phase.
- **The failure path under live conditions.** `CONSENT LEDGER: NOT CONFIRMED`
  and a withheld `cst_*` grant have never been seen together in a real
  submission — both earlier preview failures happened while HubSpot was absent,
  so the block was never rendered at all. What an operator actually sees when
  the ledger is unreachable and the CRM is not remains unverified.
- **Production behaviour with the feature on.** Never enabled there.
- **Permanent deletion.** Only the standard delete has been observed.
- **Everything in gates 6–10** — suppression writing, STOP and DNC processing,
  re-opt-in, webhooks, send-time enforcement. None of it is built.

## No SMS, no calls

No Twilio SMS was sent and no Retell call was placed. Nothing in this repository
sends or calls; the permission resolver exists and is tested, and nothing in
production invokes it.
