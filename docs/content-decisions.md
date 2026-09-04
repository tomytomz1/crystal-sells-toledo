# Open content decisions

Findings from the September 4, 2026 content QA that **cannot be closed by
editing copy**. Each needs a fact from a named owner.

Nothing here is a TODO on a public page: in every case the unsupported wording
has already been removed or replaced with wording that makes no new commitment.

**Some of these are still launch decisions.** An earlier version of this file
said none of them was needed to ship. That was wrong, and independent
verification of `8394893` said so. Removing a claim is not the same as settling
the question behind it. Two kinds of item are marked below:

- **BLOCKS LAUNCH** — the page asks a visitor to act without a fact they are
  entitled to before acting. Silence is not a resolution.
- Everything else — answering it lets the site say something *more* specific
  than it says now. Not required to publish what is there.

Audited commit: `fb6e70c`. Verified at `8394893`.
Branch: `claude/phase-4-43551-seller-review`.

---

## For Crystal

| # | Question | What the site says now | Findings |
|---|---|---|---|
| C1 | Is the Seller Strategy Review delivered in writing, in conversation, or both? | No format is claimed. "A person reads it before you do", "Listed out" and the note-on-the-range wording all implied readable material and were removed at the verification pass. | R02, R13 |
| C2 | **BLOCKS LAUNCH.** Does the review cost anything? | "No obligation" appears; no price is stated either way. Omitting a price does not settle whether a fee applies. A visitor is asked for contact details without knowing. If it is free, say "Free · No obligation to list"; if a fee applies, disclose it **before** the form. | R13 |
| C3 | What is the turnaround, if any? | No turnaround is stated anywhere. | R13, G03 |
| C4 | Does the review require an in-person visit? | Says an in-person visit may be needed. | R12 |
| C5 | What response time can you actually commit to? | "I reply personally", with no timeframe. Same-day and few-hour promises were removed. | G03 |
| C6 | Which marketing services are included on **every** listing, and which are per-plan? | "We agree on the services and costs before you sign." Nothing is listed as universal. | H03 |
| C7 | Which biography sentences does the existing owner attestation cover? | Residence and family facts retained. The appreciation-comparison and street-speed claims were removed. | A01, A02, H04 |
| C8 | Dated sources for any neighborhood market claim you want restored. | All unsourced market claims removed; orientation and questions remain. | N01, N03–N15 |
| C9 | Cleared photography for the 12 neighborhood images and the buy-page lifestyle image. | Placeholder frames removed entirely. Do not substitute stock imagery for a named location. | N02, B06 |
| C10 | Current real-estate licence lookup URL. | The department is named; no link. `elicense.ohio.gov` is being retired and could not be verified from the build environment. | A04 |
| C11 | ~~Social image reads "Perrysburg specialist".~~ **Done.** | `assets/img/og-default.jpg` now reads "Perrysburg & Greater Toledo · Key Realty LTD", set in the same face, size, color and baseline as the lines around it. Identity, logos and photo untouched. | G02 |

## For Key Realty (broker)

| # | Question | What the site says now | Findings |
|---|---|---|---|
| B1 | Actual listing-agreement term and cancellation conditions. | "Before you sign a listing agreement, I will explain its term and any cancellation conditions." The unqualified cancellation right was removed. | S06 |
| B2 | Is "Each office is independently owned and operated" true of Key Realty? | Sentence removed from the footer pending confirmation. | G07 |
| B3 | Review the identity display on the review page. | The full licensed name no longer appears in the oversized hero paragraph; name and brokerage appear together in the matched identity lines. Overall display remains the broker's call. | G01 |
| B4 | Buyer-agreement process and when it must be signed. | "Before we work together, we will discuss representation, the services included, how compensation works, and the terms of any required buyer agreement. Fees are negotiable." Confirm the exact sequence. | B03 |
| B5 | Approve the privacy notice. | Rewritten to match the code. Legal-basis assertion removed. | P01, P07 |

## For the site administrator

| # | Question | What the site says now | Findings |
|---|---|---|---|
| A1 | GA4 and HubSpot retention settings, and the actual deletion capability. | "kept according to the retention period configured in each provider's own console"; deletion answer no longer promises analytics are unlinkable. | P07, P08 |
| A2 | Review historical GA4 `email_click` events for form contents captured before this fix. | The leak is closed going forward (P02). Past events were not inspected. | P02 |
| A3 | Should the on-device attribution record expire? | Now disclosed as having no automatic expiration. If a period is set, state it. | P05 |
| A4 | Identity-verification step for data requests. | "Crystal may need to confirm your identity before acting on the request." Define what that is. | P07 |
| A5 | Verified privacy-policy URLs for Vercel, Google and HubSpot. | Not added — every external host is unreachable from the build environment, so none could be verified. | P09 |
| A5b | **Does the "Just curious about the value" choice actually suppress unrelated follow-up?** | The page no longer promises it does. It now says only that the choice is recorded with the request. Restore the stronger wording only once the procedure and any CRM sequences are confirmed. A human procedure is fine; automation is not required. | V04 |
| A6 | Hosting-layer request logs. | Named as separate and outside this notice's scope. Confirm Vercel's retention. | P03 |
