# Twilio A2P 10DLC Campaign — prepared answers

**Date:** 2026-09-09
**Status:** **PREPARED ONLY. Nothing has been submitted to Twilio or TCR.**

This is a worksheet for whoever registers the Campaign. Do not submit it until
the website consent flow is actually live (`COMMUNICATIONS_CONSENT_ENABLED=true`
in production), because the reviewer will visit the opt-in URL and expects to
see the checkbox and disclosure described below.

Twilio number in hand: **+1 419-724-2789** (SMS, MMS, Voice).

> **UPDATE — 15 September 2026.** Two Twilio registrations are now approved,
> and they are different objects:
>
> - **Primary / Individual Customer Profile — APPROVED** (Twilio email,
>   *"Twilio Primary Customer Profile Approved"*).
> - **A2P 10DLC Brand — APPROVED**, type **Sole proprietor**, identity
>   **Verified** (Trust Hub screenshot).
>
> Operator-supplied evidence; no agent queried Twilio. **The A2P Campaign is
> still NOT created, submitted or approved** — the Brand Details view showed a
> *"Create campaign"* button and no linked Campaign. **This changes nothing
> about the sequencing below.** The Campaign must still not be submitted until
> the reviewer can see the live opt-in surface.

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

> **CORRECTED 15 September 2026 — the use case is `Sole Proprietor`, not
> "Customer Care / Conversational".** This worksheet said the latter from
> 9 September until the Brand was approved as a **Sole proprietor** brand.
>
> Per Twilio's own documentation, **a Sole Proprietor Brand has exactly one
> campaign use case available in the Console dropdown: `Sole Proprietor`.**
> The multi-use-case menu (Customer Care, Marketing, Account Notification and
> so on) belongs to Standard and Low-Volume Standard brands. There is no
> "Customer Care" option to pick here, so the old answer described a choice
> the Console will not offer.
>
> **Two different fields, and keeping them apart is the point:**
>
> | | |
> |---|---|
> | **Campaign use case** | the Twilio *registration category*. For this brand it is fixed: **`Sole Proprietor`**. |
> | **Campaign description** | free text explaining what the traffic actually is — here, **conversational customer-care** messages answering consumer-initiated inquiries. |
>
> Twilio is explicit that the Sole Proprietor use case *"doesn't give any
> substantive indication of the Campaign's purpose, which is why the Campaign
> description field is an important field in determining whether your Campaign
> is approved."* **The description now carries the whole burden of explaining
> the traffic**, which is why it is written out in full below.
>
> Also per Twilio: a **Sole Proprietor campaign may have only ONE 10DLC phone
> number attached**. That matches the single number in hand and needs no change
> here, but it rules out adding a second number later without rethinking the
> registration.
>
> **This records what to select. No Campaign has been created or submitted.**

| Field | Answer |
|---|---|
| **Campaign use case** (the Twilio registration category) | **Sole Proprietor** |
| **Traffic description** (what the messages actually are) | Conversational customer-care messages. See the campaign description below. |
| Campaign description | Replies and follow-up to people who submitted a real estate inquiry on crystalsellstoledo.com and ticked a separate, optional, unchecked box agreeing to text messages. Messages relate to that consumer-initiated inquiry: replies and follow-up about it, requested home-valuation follow-up, appointment scheduling and reminders, requested information, and closely related property or service updates. **Not a marketing list. No affiliate marketing.** Consent is not a condition of service. |
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

- [x] **Twilio Brand / Trust Hub resolved and approved** — 15 September 2026,
      operator-supplied evidence: Primary/Individual Customer Profile
      **Approved**, Brand **Approved**, type **Sole proprietor**, identity
      **Verified**. *(This box covers the Customer Profile and the BRAND only.
      No Campaign item below is affected by it.)*
- [x] **`COMMUNICATIONS_CONSENT_ENABLED=true` in Vercel Production** —
      set by the operator 15 September 2026, Production redeployed.
      `CONSENT_LEDGER_URL` set alongside it, using the `consent_ledger_app`
      `INSERT`-only role.
- [x] **Both checkboxes visible, unchecked, optional at the opt-in URL** —
      operator-verified on live `/home-value` after the contrast fix deployed.
      Separate SMS and AI-voice boxes, both unchecked, section marked
      Optional, disclosure plainly readable.
- [x] **https://crystalsellstoledo.com/communications-terms loads** —
      **reachability operator-verified** by screenshot on the live domain,
      16 September 2026. **Content verified from deployed source:** message
      frequency varies, message and data rates may apply, *Reply STOP to opt
      out*, *Reply HELP for help*, separate AI/automated-voice consent,
      consent not a condition of service, and the mobile / opt-in
      non-sharing language. *(No agent loaded the page.)*
- [x] **Privacy policy carries the mobile-information language** —
      **reachability operator-verified** by screenshot on the live domain,
      16 September 2026. **Content verified from deployed source:** mobile
      information not shared with third parties or affiliates for marketing
      or promotional purposes, text-messaging opt-in/consent data not shared
      for third-party marketing, *message frequency varies*, *message and
      data rates may apply* (error 30908), STOP/HELP language, the Twilio
      messaging disclosure and a separate AI/automated-voice disclosure.
      *(No agent loaded the page.)*
- [ ] HubSpot properties created (see the HubSpot setup document) —
      **not re-verified in this pass.** HubSpot is **not** a blocker for the
      inbound endpoint: with it absent the projection is skipped and logged
      and the ledger row still stands. Confirm separately.
- [ ] **STOP/HELP inbound webhook actually implemented and LIVE** — the
      endpoint exists and is audited, but **it is not activated**:
      `TWILIO_AUTH_TOKEN` and `OPERATOR_ACTION_SECRET` (≥ 32 bytes) are in no
      environment; **`ZOHO_SMTP_*` needs CONFIRMING in Production, not
      adding** — see `docs/CURRENT-STATE.md` § STOP / HELP inbound activation;
      no Messaging Service is known to exist and no webhook is configured.
      **"In code" is not "live."**
      Without those, every ordinary inbound message answers `503`.
      **This remains the box that matters most**, and it is the only
      website-side item still open. See `docs/CURRENT-STATE.md`
      § STOP / HELP inbound activation for the audited requirement list.

The last box is the one that matters most. Every sample message above promises
"Reply STOP to opt out". Sending any of them before inbound handling is live
would be making a promise the system cannot keep.

**UPDATE — 15 September 2026, later the same day: the second box is now
CLOSED.** `COMMUNICATIONS_CONSENT_ENABLED=true` and `CONSENT_LEDGER_URL` are
set in Production, Production is redeployed, and the live opt-in surface has
been operator-verified. **The blocking item is now the LAST box — STOP/HELP
inbound activation.** The paragraph below is kept because it records why the
sequencing existed; it is no longer the open item.

**The blocking item as of earlier on 15 September 2026 was the second box, and
it was ours, not Twilio's.** `COMMUNICATIONS_CONSENT_ENABLED` is set in Vercel **Preview
only** and deliberately absent from **Production**, so the production opt-in URL
does not yet show the SMS consent checkbox and disclosure the reviewer will look
for. Submitting the Campaign before that is visible invites a rejection for an
opt-in flow the reviewer cannot see — which is the reason this worksheet has
said "do not submit until the consent flow is live" since 9 September 2026.

**No Campaign item on this list is complete.** The Campaign has not been
created, submitted or approved, no number is assigned to a Campaign, and no
Messaging Service is configured. Brand approval advanced exactly one box.
