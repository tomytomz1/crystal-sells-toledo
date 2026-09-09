# Twilio A2P 10DLC Campaign — prepared answers

**Date:** 2026-09-09
**Status:** **PREPARED ONLY. Nothing has been submitted to Twilio or TCR.**

This is a worksheet for whoever registers the Campaign. Do not submit it until
the website consent flow is actually live (`COMMUNICATIONS_CONSENT_ENABLED=true`
in production), because the reviewer will visit the opt-in URL and expects to
see the checkbox and disclosure described below.

Twilio number in hand: **+1 419-724-2789** (SMS, MMS, Voice).
Brand / Trust Hub is being resolved separately with Twilio/TCR.

---

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
| Use case | Customer Care / Conversational (low volume) |
| Campaign description | Replies and follow-up to people who submitted a real estate inquiry on crystalsellstoledo.com and ticked a checkbox agreeing to text messages. Messages relate to that inquiry: responses, requested home-valuation follow-up, appointment scheduling and reminders, requested information, and closely related property or service updates. Not a marketing or promotional list. |
| Message frequency | Varies. Conversational and triggered by the consumer's own inquiry; no scheduled or recurring campaign sends. |
| Does the campaign include marketing? | **No.** Inquiry-related customer care only. Any future marketing program would be registered separately with its own consent. |
| Are links used in messages? | **No** in the current samples. If added later they will be to crystalsellstoledo.com only, never a public URL shortener. |
| Are phone numbers embedded in messages? | Only Crystal's own published business number, and only in the HELP reply. |
| Age-gated content? | **No.** |
| Lending / loan content? | **No.** Crystal is a real estate salesperson, not a lender. No loan offers, rates, terms or applications. |
| Direct lending or loan arrangement? | **No.** |
| Affiliate marketing? | **No.** |

## 3. Opt-in

| Field | Answer |
|---|---|
| Opt-in type | Web form, single opt-in via an explicit unchecked checkbox |
| Opt-in URL | https://crystalsellstoledo.com/home-value (also on `/`, `/43551-seller-review` and `/contact` — the same disclosure, from one shared source) |
| Privacy policy URL | https://crystalsellstoledo.com/privacy |
| Terms / messaging terms URL | https://crystalsellstoledo.com/communications-terms |

### Opt-in flow, as the reviewer will see it

1. A visitor fills in a real estate inquiry form (name, email, phone, property
   address, timeline, condition).
2. Above the Submit button, in a bordered block headed **"How may Crystal follow
   up? Optional"**, are two separate checkboxes. **Both start unchecked. Neither
   is required. The form submits normally with both left unchecked.**
3. The SMS checkbox's own label carries the full disclosure:

> I agree to receive text messages from Crystal Sells Toledo about my real
> estate inquiry, appointments, requested information, and related services.
> Message frequency varies. Message and data rates may apply. Reply STOP to opt
> out or HELP for help. Consent is not a condition of service. See the
> **Privacy Policy** and **Communications Terms**.

Privacy Policy and Communications Terms are links.

4. The second checkbox is a **separate** permission for automated/AI voice calls.
   It is not part of the SMS consent and neither implies the other.
5. On submission the server records the choice, the exact wording above, its
   version identifier (`CST_SMS_CONSENT_2026_09_V1`), the normalised phone
   number, the page, the timestamp and a submission reference, and stores that
   with the contact in HubSpot.

## 4. Sample consumer messages

**Sample 1 — first reply to an inquiry**

> Crystal Sells Toledo: Thanks for reaching out about your real estate inquiry.
> I can help coordinate the next step. Reply STOP to opt out.

**Sample 2 — appointment reminder**

> Crystal Sells Toledo: Reminder about your requested appointment. Reply here if
> you need to reschedule. Reply STOP to opt out.

**Sample 3 — requested information**

> Crystal Sells Toledo: I have an update related to the information you
> requested. Reply here when convenient. Reply STOP to opt out.

## 5. HELP and STOP

**HELP reply**

> Crystal Sells Toledo: Crystal Saylor, Key Realty LTD. Call (419) 245-4655 or
> email crystal@crystalsellstoledo.com. Reply STOP to opt out. Msg&data rates
> may apply.

**STOP behaviour**

- Keywords honoured at minimum: `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`,
  `END`, `QUIT`, plus whatever set Twilio handles at platform level.
- One confirmation message, then nothing further.
- Natural language ("please stop texting me") is also treated as an opt-out even
  though it is not a keyword.
- The opt-out is written to the contact's suppression record. **Submitting
  another web form does not clear it** — restoring a stopped number requires a
  deliberate re-opt-in, including clearing Twilio's own opt-out list.
- An SMS opt-out does not by itself stop voice calls, and vice versa. A request
  to stop all contact stops both.

**Opt-out confirmation**

> Crystal Sells Toledo: You will not receive further text messages. Reply HELP
> for contact information.

## 6. Crystal's internal operational alert — keep this separate

Distinct from everything above. Concept only, **not enabled**:

> Crystal Sells Toledo: New website lead received. Open HubSpot for details.

- Recipient: Crystal's own mobile. One recipient, her own business.
- Deliberately carries **no** seller name, phone, email, property address,
  message or notes — a lead notification does not need PII and a phone lock
  screen is not a private place.

**Do not describe this as categorically exempt from 10DLC.** Traffic sent from
an A2P long code over a Messaging Service is subject to the same registration
regime regardless of who the recipient is; internal use is a description of
purpose, not a recognised exemption. If it is ever sent from this number it
should be covered by a registered campaign, and it should be raised with Twilio
rather than assumed.

## 7. Before submitting — checklist

- [ ] Twilio Brand / Trust Hub resolved and approved
- [ ] `COMMUNICATIONS_CONSENT_ENABLED=true` in Vercel Production
- [ ] Both checkboxes visible, unchecked, optional at the opt-in URL
- [ ] https://crystalsellstoledo.com/communications-terms loads
- [ ] Privacy policy carries the mobile-information language
- [ ] HubSpot properties created (see the HubSpot setup document)
- [ ] STOP/HELP inbound webhook actually implemented — **do not advertise STOP
      handling before the webhook exists**

The last box is the one that matters most. Every sample message above promises
"Reply STOP to opt out". Sending any of them before inbound handling is live
would be making a promise the system cannot keep.
