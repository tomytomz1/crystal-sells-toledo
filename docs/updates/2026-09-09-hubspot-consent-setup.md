# HubSpot setup for communications consent

**Date:** 2026-09-09
**Applies to:** `claude/communications-consent-foundation` and everything after it
**Audience:** whoever administers the Crystal Sells Toledo HubSpot portal
**Assumes no context from any prior conversation.**

Until every step here is done, leave `COMMUNICATIONS_CONSENT_ENABLED` set to
`false`. With it off the site behaves exactly as it does today.

---

## 1. Why this is needed

The website will offer two optional tick boxes: one for text messages, one for
automated/AI voice calls. Two different things then have to be stored, and only
one of them works today.

| | Where it lives | Works today? |
|---|---|---|
| **Evidence** — what this person agreed to, when, for which number, in which exact words | The native HubSpot **form-submission timeline activity**, inside the enquiry block already written to the `message` field | **Yes.** No setup, no new scopes, no form change. |
| **Current state** — are we allowed to text/call them *right now* | Custom contact properties | **No.** They do not exist. This document creates them. |

The distinction matters. A timeline activity is per submission, dated, and not
editable through the API, so it accumulates. A contact property is a single
mutable value — useful for "what is true now", useless as history. Nothing in
this system should be described as an immutable audit trail unless it is the
timeline activity.

### Scopes

The integration uses a HubSpot Private App with exactly:

- `crm.objects.contacts.read`
- `crm.objects.contacts.write`
- `forms`

**No additional scope is required by anything in this document.** Custom contact
properties are covered by `crm.objects.contacts.write`. Do not widen the scopes.

### What is NOT required

- **No change to the HubSpot native form.** The consent evidence travels inside
  the existing `message` field, which the form already defines. Adding fields to
  the form definition would risk HubSpot rejecting submissions, which fails
  leads.
- No custom object. No custom event. No Notes/engagements (a Private App key has
  no notes scope at all — this was confirmed previously and is why the enquiry
  block lives in `message` in the first place).
- No workflow.

---

## 2. Properties to create

Create these on the **Contact** object, in a property group called
**Communications consent** (create the group first: Settings → Properties →
Contact properties → *Create property* lets you add a new group inline).

Every internal name is prefixed `cst_`. Type them exactly — the code will match
on the internal name, and HubSpot lowercases and substitutes as you type a
label, so always set the internal name explicitly.

### 2a. Current SMS state — mutable

| Internal name | Label | Field type | Allowed values |
|---|---|---|---|
| `cst_sms_permission_status` | SMS permission status | Dropdown select | `never_granted`, `granted`, `revoked`, `suppressed` |
| `cst_sms_consent_at` | SMS consent captured at | Date picker | — |
| `cst_sms_consent_phone` | SMS consent phone | Single-line text | — |
| `cst_sms_consent_source` | SMS consent source form | Single-line text | — |
| `cst_sms_consent_page` | SMS consent page | Single-line text | — |
| `cst_sms_consent_copy_version` | SMS consent copy version | Single-line text | — |

Set the dropdown's default to `never_granted`.

### 2b. Current voice state — mutable

| Internal name | Label | Field type | Allowed values |
|---|---|---|---|
| `cst_ai_voice_permission_status` | AI voice permission status | Dropdown select | `never_granted`, `granted`, `revoked`, `suppressed` |
| `cst_ai_voice_consent_at` | AI voice consent captured at | Date picker | — |
| `cst_ai_voice_consent_phone` | AI voice consent phone | Single-line text | — |
| `cst_ai_voice_consent_source` | AI voice consent source form | Single-line text | — |
| `cst_ai_voice_consent_page` | AI voice consent page | Single-line text | — |
| `cst_ai_voice_consent_copy_version` | AI voice consent copy version | Single-line text | — |

### 2c. Suppression — mutable, and the most important values in the portal

| Internal name | Label | Field type | Allowed values |
|---|---|---|---|
| `cst_sms_suppressed` | SMS suppressed | Single checkbox (boolean) | — |
| `cst_sms_suppressed_at` | SMS suppressed at | Date picker | — |
| `cst_sms_suppression_reason` | SMS suppression reason | Dropdown select | `stop_keyword`, `natural_language`, `manual`, `carrier` |
| `cst_do_not_call` | Do not call (automated) | Single checkbox (boolean) | — |
| `cst_do_not_call_at` | Do not call set at | Date picker | — |
| `cst_do_not_call_reason` | Do not call reason | Dropdown select | `voice_request`, `natural_language`, `manual` |
| `cst_do_not_contact` | Do not contact (all channels) | Single checkbox (boolean) | — |
| `cst_do_not_contact_at` | Do not contact set at | Date picker | — |
| `cst_do_not_contact_reason` | Do not contact reason | Dropdown select | `consumer_request`, `manual` |

**Never bulk-edit, import over, or clear a suppression field.** These are the
values that stop someone being contacted after they asked not to be. Turning one
off is a deliberate re-opt-in decision (§5), not data cleanup.

### 2d. Re-opt-in request — mutable

| Internal name | Label | Field type |
|---|---|---|
| `cst_reoptin_requested_at` | Re-opt-in requested at | Date picker |
| `cst_reoptin_requested_channel` | Re-opt-in requested channel | Dropdown select (`sms`, `ai_voice`, `both`) |

Set when a suppressed contact ticks a box again. Recording the request does
**not** grant anything — see §5.

**24 properties total.**

---

## 3. Which values are state, which are evidence

| | |
|---|---|
| **Mutable current state** | Everything in §2. These say what is true *now* and are expected to change. |
| **Event evidence** | The consent rows inside each form-submission timeline activity: `SMS CONSENT`, `SMS CONSENT VERSION`, `SMS CONSENT AT`, `SMS CONSENT PHONE`, and the four AI voice equivalents. One set per submission, dated, not editable through the API. |

If the two ever disagree, the timeline activities are the record of what
happened; the properties are a cache of the current conclusion.

---

## 4. Order of setup

1. Create the property group **Communications consent**.
2. Create all 24 properties exactly as specified above.
3. Verify (§6).
4. Deploy the branch to production with `COMMUNICATIONS_CONSENT_ENABLED` still
   `false`. Confirm nothing about the live site changed.
5. Wire the current-state writes (a follow-up code change — this branch does not
   write these properties, because writing to properties that do not exist would
   break lead submission).
6. Set `COMMUNICATIONS_CONSENT_ENABLED=true` in **Vercel → Project → Settings →
   Environment Variables → Production**, then redeploy.
7. Verify again (§6).

Do not do step 6 before step 2. That is the whole reason the gate exists: a
visitor must never be shown a consent promise the backend cannot preserve.

---

## 5. Re-opt-in: the human procedure

There is deliberately no automatic un-suppress. A form submission can never
clear a STOP or a DNC.

To genuinely restore a suppressed channel:

1. Confirm the consumer asked for it, in a way you could show someone.
2. **Clear Twilio's own opt-out first.** Twilio maintains its own opt-out list
   per number, independently of anything in HubSpot. Clearing the HubSpot field
   alone will not make a message deliverable — Twilio will still block it.
   Twilio Console → Messaging → Opt-out management (or the Messaging Service's
   opt-out list), remove the number.
3. Clear the HubSpot suppression checkbox and its reason.
4. Set the channel's `..._permission_status` to `granted` and update
   `..._consent_at`, `..._consent_phone` and `..._consent_copy_version` to the
   new consent.
5. Clear `cst_reoptin_requested_at`.

Steps 2 and 3 in that order. Doing 3 without 2 produces a contact who looks
permitted and messages that silently never arrive.

---

## 6. Verification

**After creating the properties (feature still off):**

- Settings → Properties → filter by group "Communications consent" — 24
  properties, internal names exactly as listed.
- Open any contact record. The properties exist and are empty.
- Submit nothing. Nothing should have changed on the website.

**After enabling the feature:**

- Load `https://crystalsellstoledo.com/home-value`. Step 2 shows two tick boxes,
  **both unticked**, neither marked required, each with a working link to the
  Privacy Policy and to Communications Terms.
- `https://crystalsellstoledo.com/communications-terms` loads.
- The privacy page has a "Text messages and automated calls" section naming
  Twilio and Retell AI.
- Submit one real test enquiry **from an address and phone you control**, with
  the SMS box ticked and the voice box unticked.
- In HubSpot, open that contact → Activity → the form submission. The enquiry
  block contains:
  ```
  SMS CONSENT: GRANTED
  SMS CONSENT VERSION: CST_SMS_CONSENT_2026_09_V1
  SMS CONSENT AT: <a timestamp>
  SMS CONSENT PHONE: <your number, formatted (419) 555-1234>
  AI VOICE CONSENT: NOT GRANTED
  ```
- Submit a second enquiry with **neither** box ticked. Confirm the earlier
  timeline activity is unchanged and the new one records NOT GRANTED for both.
  A later submission must never rewrite an earlier record.

---

## 7. Rollback

| Situation | Action |
|---|---|
| Consent UI is live and should not be | Set `COMMUNICATIONS_CONSENT_ENABLED=false` in Vercel Production and redeploy. UI, `/communications-terms` and the privacy section all disappear; evidence already on the timeline stays where it is. |
| A property was created wrong | Edit it. Do not delete a property that already holds values — HubSpot deletion is destructive and archived properties are awkward to restore. |
| The whole feature should go | Revert the merge commit. The properties can stay; unused properties are harmless. |

**Never roll back by deleting suppression data.**

---

## 8. The environment flag, stated once more

```
COMMUNICATIONS_CONSENT_ENABLED
```

- Read at **build time** (does the UI render, is the terms page built) and at
  **runtime** (is consent evidence written). One variable serves both.
- Enabled only by the exact string `true`.
- Not a secret.
- **Must remain `false` until every property in §2 exists.**
