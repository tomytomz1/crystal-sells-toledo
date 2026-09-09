# HubSpot setup for communications consent

**Date:** 2026-09-09
**Applies to:** `claude/communications-consent-foundation` and everything after it
**Audience:** whoever administers the Crystal Sells Toledo HubSpot portal
**Assumes no context from any prior conversation.**

Until every step here is done, leave `COMMUNICATIONS_CONSENT_ENABLED` set to
`false`. With it off the site behaves exactly as it does today.

---

> ## COMPLETION NOTICE — 9 September 2026
>
> **The property creation described below is DONE.** This document was written
> as instructions; the sections after this notice are kept in their original
> form as the specification that was followed, so read them as "what was
> built", not "what to build".
>
> - **HubSpot Starter is active** on the Crystal Sells Toledo portal.
> - The **Communications consent** property group exists.
> - **All 23 properties were created on 9 September 2026** and their
>   definitions were independently verified against §2.
> - **All six timestamp properties are genuine `datetime`** properties, not
>   date-only pickers — the outcome §2e required.
> - The six enumeration/dropdown properties — `cst_sms_permission_status`,
>   `cst_ai_voice_permission_status`, `cst_sms_suppression_reason`,
>   `cst_do_not_call_reason`, `cst_do_not_contact_reason` and
>   `cst_reoptin_requested_channel` — carry exactly the values listed in §2.
>
> **Still not done, and still gating activation:**
>
> - **Non-midnight timestamp retention is NOT tested.** Nobody has yet written
>   a value with a real time to one of the six `*_at` properties, reloaded the
>   record, and confirmed the time survived. The §6 verification step covering
>   this remains outstanding. Until it passes, "these are datetime properties"
>   is a portal setting that has been read, not a behaviour that has been
>   observed.
> - **§6a live durability findings are still unwritten.**
> - **`COMMUNICATIONS_CONSENT_ENABLED` remains ABSENT from Vercel Production.**
>   The feature is OFF. Creating the properties did not turn anything on, and
>   neither did wiring the code to them.
>
> **Application writes to these properties** are the subject of a separate
> phase, implemented in `docs/updates/2026-09-09-hubspot-consent-current-state.md`.
> Read that document for what the code actually does with this schema.

---

## 1. Why this is needed

The website will offer two optional tick boxes: one for text messages, one for
automated/AI voice calls. Two different things then have to be stored, and
only one of them can be built on what HubSpot already offers this integration.

Neither is running in production today: the feature is off, and nothing below is
active until it is turned on.

| | Where it lives | Status |
|---|---|---|
| **Evidence** — what this person agreed to, when, for which number, in which exact words | The native HubSpot **form-submission timeline activity**, inside the enquiry block already written to the `message` field | **Implemented using the existing HubSpot form-submission contract.** Requires no new HubSpot schema, no new scopes and no change to the form — but consent evidence is **not active until the feature is enabled**. Practical durability in this portal is **not yet live-verified** — see §1a. |
| **Current state** — are we allowed to text/call them *right now* | Custom contact properties | **Schema created 9 Sep 2026** (see the completion notice above). Application reads and writes implemented in the Phase 2 document. Like everything else here, **inactive until the feature is enabled**. |

Keep the two ideas apart when reading the rest of this document:
**technically supported by the existing integration** is not the same as
**actually active in production**. Everything here is currently the first and
none of it is the second.

The distinction matters. A timeline activity is created per submission and
carries its own dated snapshot, so records accumulate rather than replace one
another. A contact property is a single mutable value — useful for "what is true
now", useless as history.

### 1a. What is proven, and what is not

Be precise about this. The architecture is sound, but the word "immutable" is
not one this document is entitled to use.

**Proven by code and tests, in this repository:**

- Each website submission constructs its own consent snapshot, server-side, from
  canonical values a client cannot influence.
- The consent evidence is part of the same HubSpot Forms submission as the full
  enquiry activity, so the activity's evidence block is submitted as one unit.
  The Contact current-state write and the Forms activity are separate API
  requests, however, and there is no transaction across them. A Contact write
  can succeed before a Forms submission fails; the application reports that
  failure rather than hiding it.
- Constructing a later submission's payload does not read, modify or overwrite
  any earlier payload. Each is built fresh from that submission alone.
- The exact disclosure text, its version, the timestamp and the bound phone
  number are all present in the payload.

**NOT yet live-proven — nobody has watched this happen in the production
portal:**

- How HubSpot renders these consent rows on the contact timeline, and whether
  the block is displayed in full or truncated in the UI.
- Whether the activity is retained long enough, and remains readable enough, to
  serve as audit evidence years later.
- Whether a portal administrator, a data-management tool, or a HubSpot retention
  or clean-up setting can remove or alter past form-submission activities.
  **Assume they can until shown otherwise** — a timeline activity is not
  editable through the public API, which is not the same thing as immutable.

The honest summary: **this is the best evidence the integration can produce with
its current scopes, and it is per-submission and additive by construction.**
Whether it is durable enough for a given audit purpose is a question for §6a,
and a question for whoever owns that risk. Do not describe it as an immutable
audit trail in any other document, in any HubSpot note, or to any reviewer.

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
| `cst_sms_consent_at` | SMS consent captured at | **Date and time** — see §2e | — |
| `cst_sms_consent_phone` | SMS consent phone | Single-line text | — |
| `cst_sms_consent_source` | SMS consent source form | Single-line text | — |
| `cst_sms_consent_page` | SMS consent page | Single-line text | — |
| `cst_sms_consent_copy_version` | SMS consent copy version | Single-line text | — |

Set the dropdown's default to `never_granted`.

### 2b. Current voice state — mutable

| Internal name | Label | Field type | Allowed values |
|---|---|---|---|
| `cst_ai_voice_permission_status` | AI voice permission status | Dropdown select | `never_granted`, `granted`, `revoked`, `suppressed` |
| `cst_ai_voice_consent_at` | AI voice consent captured at | **Date and time** — see §2e | — |
| `cst_ai_voice_consent_phone` | AI voice consent phone | Single-line text | — |
| `cst_ai_voice_consent_source` | AI voice consent source form | Single-line text | — |
| `cst_ai_voice_consent_page` | AI voice consent page | Single-line text | — |
| `cst_ai_voice_consent_copy_version` | AI voice consent copy version | Single-line text | — |

### 2c. Suppression — mutable, and the most important values in the portal

| Internal name | Label | Field type | Allowed values |
|---|---|---|---|
| `cst_sms_suppressed` | SMS suppressed | Single checkbox (boolean) | — |
| `cst_sms_suppressed_at` | SMS suppressed at | **Date and time** — see §2e | — |
| `cst_sms_suppression_reason` | SMS suppression reason | Dropdown select | `stop_keyword`, `natural_language`, `manual`, `carrier` |
| `cst_do_not_call` | Do not call (automated) | Single checkbox (boolean) | — |
| `cst_do_not_call_at` | Do not call set at | **Date and time** — see §2e | — |
| `cst_do_not_call_reason` | Do not call reason | Dropdown select | `voice_request`, `natural_language`, `manual` |
| `cst_do_not_contact` | Do not contact (all channels) | Single checkbox (boolean) | — |
| `cst_do_not_contact_at` | Do not contact set at | **Date and time** — see §2e | — |
| `cst_do_not_contact_reason` | Do not contact reason | Dropdown select | `consumer_request`, `manual` |

**Never bulk-edit, import over, or clear a suppression field.** These are the
values that stop someone being contacted after they asked not to be. Turning one
off is a deliberate re-opt-in decision (§5), not data cleanup.

### 2d. Re-opt-in request — mutable

| Internal name | Label | Field type |
|---|---|---|
| `cst_reoptin_requested_at` | Re-opt-in requested at | **Date and time** — see §2e |
| `cst_reoptin_requested_channel` | Re-opt-in requested channel | Dropdown select (`sms`, `ai_voice`, `both`) |

Set when a suppressed contact ticks a box again. Recording the request does
**not** grant anything — see §5.

### 2e. The six timestamp properties — do NOT use a plain Date picker

`cst_sms_consent_at`, `cst_ai_voice_consent_at`, `cst_sms_suppressed_at`,
`cst_do_not_call_at`, `cst_do_not_contact_at` and `cst_reoptin_requested_at`
must preserve **the full instant, to the second**.

HubSpot's **"Date picker"** property type stores a date only and normalises the
value to midnight UTC. Using it would silently discard the time component — and
the time component is the whole point of these fields. "They consented on
2 September" and "they sent STOP on 2 September" cannot be ordered against each
other; "14:02:11Z" and "16:48:03Z" can. When a consent and a revocation land on
the same day, the order is the answer.

**Create these as a "Date and time" property** (HubSpot's `datetime` type). In
the property editor the field-type list shows "Date picker"; check whether this
portal offers a date **and time** option, either as a separate type or as a
toggle on the date type.

**If — and only if — this portal does not offer a date-and-time property,** fall
back to **Single-line text** holding an ISO-8601 UTC string exactly as the
server produces it:

```
2026-09-09T14:02:11.004Z
```

That format sorts correctly as a string, is unambiguous about timezone, and is
byte-identical to the value already written into the timeline evidence, so the
two records can be compared directly. The cost is that HubSpot cannot use it in
date-based filters or workflows — an acceptable trade against losing the time
outright, and better than a value that looks precise and is not.

**Record which of the two you used**, in the property description field, so the
follow-up code that writes these knows what to send. Do not mix the two across
properties.

**23 properties total** (6 SMS state + 6 voice state + 9 suppression + 2
re-opt-in). An earlier revision of this document said 24; that was an
arithmetic error, not a missing property. Nothing was added to make the total
round — the schema is what it always was.

---

## 3. Which values are state, which are evidence

| | |
|---|---|
| **Mutable current state** | Everything in §2. These say what is true *now* and are expected to change. |
| **Event evidence** | Ten consent rows inside each form-submission timeline activity — listed in full below. One set per submission, dated. |

The ten rows, in the order they appear in the enquiry block:

```
SMS CONSENT                 GRANTED | NOT GRANTED
SMS CONSENT VERSION         e.g. CST_SMS_CONSENT_2026_09_V1
SMS CONSENT TEXT            the exact disclosure the visitor was shown
SMS CONSENT AT              full ISO-8601 UTC timestamp, or "-" if not granted
SMS CONSENT PHONE           normalised number, or "-" if not granted

AI VOICE CONSENT            GRANTED | NOT GRANTED
AI VOICE CONSENT VERSION    e.g. CST_AI_VOICE_CONSENT_2026_09_V1
AI VOICE CONSENT TEXT       the exact disclosure the visitor was shown
AI VOICE CONSENT AT         full ISO-8601 UTC timestamp, or "-" if not granted
AI VOICE CONSENT PHONE      normalised number, or "-" if not granted
```

The **TEXT** rows are the ones that make this evidence rather than a lookup key.
A version identifier alone only answers "what did this person agree to" for
someone who still has the source tree and can find the revision deployed that
day; the text answers it from the CRM on its own. Both are kept — the version to
compare records against each other, the text to read.

A **declined** disclosure keeps its VERSION and TEXT (its AT and PHONE are `-`),
because "they said no" means nothing without what they were saying no to.

These ten rows are appended to the base 23-row enquiry block only when the
feature is enabled, giving a 33-row block. With the feature off the block is the
base 23 rows and carries no consent information at all.

If the two ever disagree, the timeline activities are the record of what
happened; the properties are a cache of the current conclusion. On the limits of
that claim, see §1a — the activities are per-submission and additive by
construction, which is not the same as proven immutable.

---

## 4. Order of setup

1. Create the property group **Communications consent**.
2. Create all 23 properties exactly as specified above.
3. Verify (§6).
4. Deploy the branch to production with `COMMUNICATIONS_CONSENT_ENABLED` still
   `false`. Confirm nothing about the live site changed.
5. Wire the current-state writes. This was deliberately a *later* code change
   than the property creation, because writing to properties that do not exist
   would break lead submission. Steps 1–3 are done, so this step is done too:
   see `docs/updates/2026-09-09-hubspot-consent-current-state.md`.
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

- Settings → Properties → filter by group "Communications consent" — 23
  properties, internal names exactly as listed.
- **Check the six `*_at` properties actually kept a time.** Set
  `cst_sms_consent_at` on a test contact to a value with a non-midnight time,
  save, reload the record, and read it back. If it comes back as midnight, the
  property is a plain Date picker and must be recreated per §2e. Do this before
  any consent is captured — discovering it afterwards means the timestamps
  already collected are unrecoverable.
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
  SMS CONSENT TEXT: I agree to receive text messages from Crystal Sells Toledo about my real estate inquiry, appointments, requested information, and related services. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of service. See the Privacy Policy and Communications Terms.
  SMS CONSENT AT: <a full ISO-8601 timestamp, e.g. 2026-09-09T14:02:11.004Z>
  SMS CONSENT PHONE: <your number, formatted (419) 555-1234>
  AI VOICE CONSENT: NOT GRANTED
  AI VOICE CONSENT VERSION: CST_AI_VOICE_CONSENT_2026_09_V1
  AI VOICE CONSENT TEXT: I agree to receive calls from Crystal Sells Toledo at the number I provided, including calls using automated technology and an artificial, prerecorded, or AI-generated voice, about my real estate inquiry, appointments, and requested services. Consent is not a condition of service. See the Privacy Policy and Communications Terms.
  AI VOICE CONSENT AT: -
  AI VOICE CONSENT PHONE: -
  ```

  **Ten consent rows, and the two TEXT rows must be present and complete.**
  They are what lets this record answer "what exact words did this person agree
  to" without anyone digging out the revision of the source code that was
  deployed that day. A declined disclosure keeps its text too — "they said no"
  means nothing without what they were saying no to.
- Submit a second enquiry with **neither** box ticked. Confirm the earlier
  timeline activity is unchanged and the new one records NOT GRANTED for both.
  A later submission must never rewrite an earlier record.

### 6a. Live durability check — do this, and write down the answer

§1a lists what the tests cannot establish. These questions can only be answered
inside the production portal, and they are the difference between "we have
evidence" and "we believe we have evidence".

1. **Is the block displayed in full?** Open the form-submission activity in the
   HubSpot UI. Is the whole enquiry block visible, including both CONSENT TEXT
   rows, or does the UI truncate it behind a "show more" or cut it off? If it is
   truncated, note how the full value is retrieved (the API still returns it).
2. **Does it survive?** Note the activity's date. Check the portal's data
   retention settings and the account tier's activity-retention policy. Record
   what they say.
3. **Can it be altered or deleted?** Try, on a throwaway test contact only:
   can an admin delete a form-submission activity from the UI? Can a
   data-management or bulk tool remove them? Record what you find, including
   "no obvious way" — that is a useful answer.
4. **Write the answers into this document** under a new "Live verification
   findings" heading, dated, with who checked. Until that section exists, the
   evidence architecture is unverified in practice and should be described that
   way.

If the answers are unsatisfactory, the fallback is an external append-only
store of consent events. That is a larger change and should not be undertaken
speculatively — check first.

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
