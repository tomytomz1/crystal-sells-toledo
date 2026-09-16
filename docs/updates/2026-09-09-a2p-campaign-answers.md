# Twilio A2P 10DLC Campaign — current registration answers

**Originally prepared:** 2026-09-09  
**Current status:** **REJECTED — error 30882 (Terms & Conditions), remediation in progress.**

This is the operator worksheet for the existing Crystal Sells Toledo A2P 10DLC
Campaign. Do not create a duplicate Campaign. Edit and resubmit the rejected one
after the dedicated SMS legal pages are merged, deployed and verified live.

Twilio number: **+1 419-724-2789** (SMS, MMS, Voice).

## Current Twilio object state — 16 September 2026

| Object | State |
|---|---|
| Primary / Individual Customer Profile | **APPROVED** |
| A2P 10DLC Brand | **APPROVED** — Sole proprietor, identity verified |
| Messaging Service | Existing service with the one Crystal Sells Toledo 10DLC number |
| A2P Campaign | **REJECTED** — error **30882**, Terms & Conditions |

Campaign SID: `CM3425248ff3928f6f9c78894afe908ae6`.

The first submission was received at `2026-09-16T04:43:54.522Z`, entered manual
review, and was later rejected with 30882. Twilio Console presents **Edit &
resubmit** for this same Campaign. Campaign rejection does not alter the approved
Customer Profile or Brand.

## 1. Business and program

| Field | Answer |
|---|---|
| Legal business | Crystal Saylor, licensed Ohio real estate salesperson (License #2025003655), affiliated with Key Realty LTD |
| Brand / program name | Crystal Sells Toledo |
| Website | https://crystalsellstoledo.com |
| Support email | crystal@crystalsellstoledo.com |
| Support phone | (419) 245-4655 |
| Service area | Perrysburg, Toledo and Northwest Ohio |

## 2. Campaign

| Field | Answer |
|---|---|
| Campaign use case | **Sole Proprietor** (Twilio records the submitted starter/Sole Proprietor campaign internally as `STARTER`) |
| Traffic description | Conversational customer-care messages answering consumer-initiated real estate inquiries |
| Campaign description | Crystal Sells Toledo, operated by Crystal Saylor, a licensed Ohio real estate salesperson affiliated with Key Realty LTD, sends conversational customer-care text messages to people who submit a real estate inquiry at crystalsellstoledo.com and explicitly opt in to SMS using a separate, optional, unchecked consent box. Messages may include replies to the consumer's inquiry, requested home-valuation follow-up, appointment scheduling and reminders, requested property information, and closely related service updates. Messages are sent only in response to or as follow-up on the consumer's own inquiry. This is not a marketing list and no affiliate marketing is conducted. |
| Message frequency | Varies. Conversational and triggered by the consumer's inquiry; no scheduled marketing blasts. |
| Marketing | **No.** Inquiry-related first-party customer care only. |
| Embedded links | **No** in the submitted samples. |
| Embedded phone numbers | **Yes** — Crystal's own published support number appears in the HELP-style sample. |
| Age-gated content | **No.** |
| Direct lending / loan arrangement | **No.** |
| Affiliate marketing / third-party lead generation | **No.** |

## 3. Opt-in and legal URLs — use these on resubmission

| Field | Answer |
|---|---|
| Opt-in type | **Web Form only** |
| Primary opt-in URL | https://crystalsellstoledo.com/home-value |
| Privacy Policy URL | **https://crystalsellstoledo.com/sms-privacy** |
| Terms & Conditions URL | **https://crystalsellstoledo.com/sms-terms** |

The same shared consent block also appears on `/`, `/contact` and
`/43551-seller-review`.

### Message flow

Users opt in through a web form on `https://crystalsellstoledo.com/home-value`.
The user enters contact information and a phone number, then sees a separate
section titled **"How may Crystal follow up? Optional."** The SMS checkbox is
unchecked by default and is not required to submit the form.

To opt in to SMS, the user must affirmatively check the SMS box. The disclosure
states:

> I agree to receive text messages from Crystal Sells Toledo about my real
> estate inquiry, appointments, requested information, and related services.
> Message frequency varies. Message and data rates may apply. Reply STOP to opt
> out or HELP for help. Consent is not a condition of service. See the Privacy
> Policy and Communications Terms.

The canonical disclosure text and version remain
`CST_SMS_CONSENT_2026_09_V1`. The 30882 remediation does **not** rewrite that
historical consent text. The shared consent block adds direct adjacent links to
the SMS-specific Privacy Policy and Terms & Conditions so the reviewer can move
from the opt-in surface to the exact legal pages submitted with the Campaign.

A separate checkbox is used for automated / AI voice calls; SMS consent does not
imply voice consent. The form can be submitted normally with both permission
boxes left unchecked.

### Opt-in proof field (under 500 characters)

> Live opt-in form: https://crystalsellstoledo.com/home-value
>
> On Step 2, under “How may Crystal follow up? Optional,” the SMS checkbox is
> visible, unchecked by default, optional, and next to the full SMS disclosure.
> The form can be submitted without selecting SMS consent. The same disclosure
> is also used on the homepage, /contact, and /43551-seller-review.

## 4. Sample messages submitted

1. `Crystal Sells Toledo: Thanks for your real estate inquiry about [Property Address]. I'll follow up with the information you requested and help with the next step. Reply STOP to opt out.`
2. `Crystal Sells Toledo: I have an update for your requested home valuation at [Property Address]. Reply here when convenient if you have any questions. Reply STOP to opt out.`
3. `Crystal Sells Toledo: Your requested appointment is scheduled for [Date] at [Time]. Reply here if you need to reschedule or have any questions. Reply STOP to opt out.`
4. `Crystal Sells Toledo: I have the property information you requested for [Property Address]. Let me know what questions you have or if you'd like to discuss next steps. Reply STOP to opt out.`
5. `Crystal Sells Toledo: For help with your real estate inquiry, call (419) 245-4655 or email crystal@crystalsellstoledo.com. Reply STOP to opt out.`

## 5. Initial keyword opt-in

Leave the Campaign's initial **Opt-in Keywords** and **Opt-in Message** fields
blank. Initial enrollment is through the web form, not a text-to-join campaign.
Twilio Advanced Opt-Out re-subscription keywords such as START / UNSTOP are a
separate provider configuration and do not change the registered initial consent
method.

## 6. Message contents

- Embedded links: **No**
- Phone numbers: **Yes**
- Direct lending: **No**
- Age-gated content: **No**

## 7. STOP / HELP provider configuration

The Messaging Service already carries the Crystal Sells Toledo number. Advanced
Opt-Out has been configured with first-party Crystal Sells Toledo copy for
opt-out, re-subscription and HELP. The application-side inbound webhook and
suppression work remain a separate activation gate; provider configuration is not
permission to send automated traffic.

## 8. Error 30882 remediation

The first Campaign used the broad legal URLs:

- `https://crystalsellstoledo.com/privacy`
- `https://crystalsellstoledo.com/communications-terms`

Those pages are legitimate general website / communications policies but include
policy scope unrelated to the SMS Campaign. Twilio's current onboarding guidance
recommends messaging-specific policies because they are easier to review and
maintain. The remediation therefore creates:

- `/sms-privacy` — SMS-only Privacy Policy with explicit mobile / opt-in
  non-sharing language and no unrelated transaction-sharing or AI-voice scope;
- `/sms-terms` — SMS-only Terms & Conditions with program description, frequency,
  rates, STOP, HELP, support contacts, carrier disclaimer, optional consent and
  explicit no affiliate / third-party lead marketing.

See `docs/updates/2026-09-16-a2p-30882-remediation.md` for the implementation and
verification contract.

## 9. Resubmission checklist

- [ ] Dedicated `/sms-privacy` merged to `main`
- [ ] Dedicated `/sms-terms` merged to `main`
- [ ] Production deployed
- [ ] Live `/sms-privacy` verified with H1 `Privacy Policy`, Crystal Sells Toledo,
      the exact SMS non-sharing sentence, and no unrelated transaction-sharing
      ambiguity
- [ ] Live `/sms-terms` verified with H1 `Terms & Conditions`, visible `SMS Terms`,
      frequency, rates, STOP, HELP, support, Privacy link and exact carrier
      disclaimer
- [ ] Live `/home-value` verified to show direct adjacent links to both SMS pages
- [ ] Open the existing rejected Campaign and choose **Edit & resubmit**
- [ ] Preserve Sole Proprietor use case, campaign description, web-form-only
      consent method, five sample messages and message-content declarations unless
      Twilio presents a new field-level issue
- [ ] Set Privacy Policy URL to `https://crystalsellstoledo.com/sms-privacy`
- [ ] Set Terms & Conditions URL to `https://crystalsellstoledo.com/sms-terms`
- [ ] Run **Check Campaign**
- [ ] Review the final summary and confirm both exact SMS URLs before resubmitting
- [ ] Resubmit the existing Campaign; do not create a duplicate

**Campaign resubmission is not approval.** Automated outbound SMS remains disabled
until Twilio approves the Campaign and application Gate 8 is activated and
verified.
