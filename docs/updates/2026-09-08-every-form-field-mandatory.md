# Every form field is mandatory

**Date:** 2026-09-08
**Scope:** `/api/lead` validation contract, both website forms, one CSS fix
**Status:** shipped to production as `14f1b9e`.
**Amended the same day — see below before relying on the contract here.**

This document assumes no repo access and no memory of previous conversations.

> **AMENDMENT (2026-09-08, later the same day).** The title of this document is
> no longer true. `notes` was made **optional again** a few hours after this
> release, and the `MISSING_NOTES` rejection was removed. Everything else here
> still stands: `phone`, `timeline` and `condition` on `home_value`, and `topic`
> on `contact`, remain required, and the ten-digit phone rule is unchanged. The
> phone help text was also reworded from "Ten digits, for calls or texts." to
> "Ten-digit phone number." so it makes no implicit claim about SMS consent.
> See `docs/updates/2026-09-08-notes-optional-again.md`. This document is left
> otherwise intact as the record of what the mandatory-fields release did and
> why.

---

## 1. What was wrong

A HubSpot contact was created from a real website submission with **no phone
number**. The row carried a name, an email and a property address, so in the CRM
it looked like a working lead. It was not: there was no way to call the person
back, and a valuation conversation for a Toledo-area seller effectively starts
with a phone call.

Nothing was broken. The behaviour was the contract:

| Field | Form | Old state |
|---|---|---|
| `phone` | both | optional — label read "Phone (optional)", no `required`, server accepted a blank |
| `timeline` | `home_value` | optional |
| `condition` | `home_value` | optional |
| `notes` | `home_value` | optional |
| `topic` | `contact` | optional |

The five optional fields covered most of what makes a valuation lead workable:
when the person might sell, what condition the house is in, anything they wanted
to flag, and how to reach them by voice. A submission could legitimately arrive
with all five empty.

This mattered beyond one lead. The site's own working agreement already states
that *the enquiry block is the whole lead* and that a contact saved without its
address, timeline and message "looks fine and is worthless". Optionality
contradicted that in the one place it was actually enforceable.

---

## 2. What changed

**Every visitor-facing field on both forms is now required**, in the markup and
independently on the server.

### The contract now

| Form | Required fields |
|---|---|
| `home_value` (homepage hero, `/home-value`, `/43551-seller-review`) | `property_address` `first_name` `last_name` `email` `phone` `timeline` `condition` `notes` |
| `contact` (`/contact`) | `first_name` `last_name` `email` `phone` `topic` `message` |

There are no optional inputs left on either form. The honeypot (`_gotcha`) is
the one field that must **never** be required — a bot filling it is the point.

### Phone gets a format rule as well as a presence rule

"Required" alone would have been satisfied by `x`. Two checks now apply:

- `MISSING_PHONE` — the field is empty after normalisation.
- `INVALID_PHONE` — fewer than **10 digits** after normalisation.

Ten is a US number without its country code, and no international number is
shorter, so this rejects `1234` and `call me` without rejecting a real lead. The
existing 30-character cap still applies first, so an overlength value is still
`FIELD_TOO_LONG` rather than a phone-format error.

In the browser the phone input additionally carries
`pattern="\(\d{3}\) \d{3}-\d{4}"` with a `title`. That is safe because the site's
own phone formatter (`assets/js/main.js`, section 8) already normalises what the
visitor types to exactly that shape and caps it at ten digits — it has done so
since before this change. A browser test asserts the formatter's output
satisfies the pattern, because if the two ever disagreed the form would become
silently unsubmittable and **no lead would arrive at all**.

### New 422 codes

Added to the endpoint contract: `MISSING_PHONE`, `INVALID_PHONE`,
`MISSING_TIMELINE`, `MISSING_CONDITION`, `MISSING_NOTES`, `MISSING_TOPIC`.

Every message names the field in the words the form uses and says what to do —
"Please choose when you might sell.", "Please tell Crystal a little about the
house. One line is plenty." — never a field key. A test asserts no rejection
message contains an underscore.

### Copy that had become untrue

- `src/partials/home-value-form.html` — three labels lost "(optional)" and
  gained the gold `*`; the notes help line changed from "Optional. Up to 4,000
  characters." to "One line is plenty. Up to 4,000 characters."
- `src/pages/contact.html` — same for phone and topic.
- `src/pages/43551-seller-review.html` — the "What happens after I send my
  request?" FAQ said step two took "your name and email, with any optional
  details about the house". It now lists what is actually asked and says every
  field is needed.
- `src/pages/privacy.html` — "your phone number **if you give one**" was a
  statement about data collection that had stopped being true. It now says every
  field on those forms is required, and lists `topic` (what you are getting in
  touch about), which the old list omitted. The page's "Effective and last
  updated" date moved to September 8, 2026.
- `CONTENT_UPDATED` in `tools/build.mjs` moved to "September 8, 2026" (hand-
  maintained, per the Ohio last-updated constraint), and the per-page `updated`
  meta moved to `2026-09-08` on the five pages whose visible content changed —
  `/`, `/home-value`, `/contact`, `/43551-seller-review`, `/privacy`. The other
  four pages keep `2026-09-04` because nothing on them changed; the sitemap's
  `lastmod` comes from that field and a date that is not true is worse than none.
- A source comment in the form partial described step 2 as "a far smaller ask
  than a seven-field form"; it now explains that the split exists to get an easy
  commitment first, not because the rest is optional.

### One CSS fix this forced

`.form__row` is a two-column grid, so both cells get the same height. `.field`
was `display: grid` with the default `align-content: stretch`, which meant the
**shorter** cell's input grew to fill the difference. Adding a help line under
`phone` therefore rendered the email box beside it **85px tall against phone's
60px**, with the two inputs no longer on the same baseline.

`.field` is now `align-content: start`. Both inputs keep their own height and
help text hangs below its own field. Measured after the fix on `/`,
`/home-value`, `/43551-seller-review` and `/contact` at 1280, 900 and 390px
wide: phone and email are both 59.6px tall and share a top edge everywhere the
row is two-column, and the phone help text is one line at every width (narrowest
cell measured: 204px).

---

## 3. Where it is enforced

Three independent layers, deliberately:

1. **Markup** — `required` on every input, select and textarea. The visitor is
   stopped at the field, in place, with no round trip.
2. **`api/_lib/validate.mjs`** — the guarantee. Markup can be bypassed; this
   cannot. This is what actually protects the CRM.
3. **`tools/check.mjs`** — two build-time guards so neither of the first two can
   be dropped silently:
   - every field in the required list carries `required` on every page that
     renders a form, and the honeypot does not;
   - every new rejection code still exists in `validate.mjs`.

Both guards were proved to fail: in a throwaway copy of the tree, removing
`required` from phone, timeline, notes and topic produced ten errors naming the
exact fields and pages, and renaming `MISSING_NOTES` produced the server-side
error. The working tree was never mutated.

---

## 4. Tests

| Suite | Result |
|---|---|
| `npm run test:unit` (`tests/api.test.mjs`) | **95 passed, 0 failed** |
| `npm run test:browser` (`tests/browser.test.mjs`) | **102 passed, 0 failed** |
| `npm run test:hubspot` (`tests/hubspot.test.mjs`) | **90 passed, 0 failed** |
| `npm run check` | 10 pages, 0 errors, 0 warnings |

### New tests

`tests/api.test.mjs` — a `every visitor-facing field is mandatory` block:

- each of the eight `home_value` fields, absent / blank / whitespace-only,
  asserted individually against its own 422 code (24 cases). Asserting them one
  at a time rather than as "the full payload is accepted" means dropping any
  single check turns a test red.
- `contact` with a blank phone, topic or message.
- the reported failure in its exact shape — a complete lead with `phone: ""` —
  asserted to be a 422 and specifically **not** the 503 the endpoint returns once
  a payload has been accepted and the CRM is unconfigured. A 503 there would mean
  validation had let it past.
- partial phone numbers (`419`, `41955`, `(419) 555-12`, `call me`) rejected.
- full numbers in five shapes a visitor might type, including `+44 20 7946 0000`,
  still accepted.
- every rejection message names the field and leaks no field key.

`tests/browser.test.mjs`:

- no step-2 field can be left blank — for each of seven fields, blank it, click
  submit, assert **zero requests to `/api/lead`** and no success panel.
- a partial phone number is refused before any request is made.
- a complete step 2 **does** submit, and `sent.phone === "(419) 555-1234"`. This
  is the control for the seven tests above (it proves the button works and the
  blank is what stops it) and the only proof that the `pattern` attribute and the
  JS formatter agree.
- the contact form will not submit without a phone or a topic.
- every required field reports `el.required === true` on all four pages that
  carry a form, and the honeypot reports `false`.

### Negative-tested against the pre-fix code

The new API tests were run in a **throwaway copy** of the tree with
`api/_lib/validate.mjs` restored from `HEAD`. **17 of the new tests failed**,
including "the reported failure — a complete lead with no phone — never reaches
the CRM". The tests reproduce the actual production defect rather than merely
describing the new behaviour. The working tree was never modified; per the
project's working agreement, source is never deliberately broken in place.

The browser tests need no separate mutation run: the "a complete step 2 submits"
test is the control that rules out the false-green case (a blocked click looking
like a working guard).

### Tests that had to change, and why

- `tests/helpers.mjs` — `validContact` gained `topic: "Selling my home"`. The
  baseline "valid" payload has to actually be valid; without it 14 unrelated
  tests failed on `MISSING_TOPIC`.
- `tests/hubspot.test.mjs` — three tests fed `validateLead` a blank phone to
  prove the HubSpot mapper omits it. `validateLead` now refuses that input, but
  **the mapper's defence still matters**: HubSpot reads an empty string as "set
  this property to empty", so an update carrying `phone: ""` would *erase* a
  number already on the record. Anything reaching the mapper with a blank — a
  payload from an older deploy still in flight, a future form type, a
  hand-built call — must still be dropped. A `payloadWithBlank()` helper now
  blanks a *validated* payload, which is deliberately not the same thing as
  asking `validateLead` for something it would reject.
- `tests/browser.test.mjs` — a test named "a formatted phone reaches /api/lead
  and a blank one stays blank" is now "a typed phone reaches /api/lead
  formatted, not as typed". Its blank-phone half tested behaviour that no longer
  exists; what remains is the formatter contract, with a second punctuation case
  (`586.324.1248`) added.
- Shared `fillContact` / `fillStep2` helpers were introduced because ten tests
  filled only name and email. Those would now be stopped by the browser's own
  constraint validation and fail for a reason unrelated to what they test.

---

## 5. What a human still has to do

1. **Deploy.** This is on the feature branch and has not been merged or
   deployed at time of writing. Production still accepts blank phone numbers
   until it is.
2. **Watch conversion on step 2.** This is the honest cost of the change: step 2
   went from three effectively-required fields to seven — six after `notes` was
   made optional again the same day. Some visitors who would
   have submitted a partial form will now abandon. That trade was made
   deliberately — a lead you cannot call is not a lead — but it is a real effect
   and only live data will size it.
3. ~~**Decide about `notes` specifically.**~~ **DONE — see the amendment at the
   top.** "Anything I should know?" is a free-text field with no obvious answer
   for a homeowner who has nothing to add, and the likeliest outcome was that
   some share of visitors would type "n/a". That call was made the same day:
   `notes` is **optional again** and `MISSING_NOTES` no longer exists. Nothing
   in this item is left to do. Every other field was a much clearer keep and
   all of them stayed required. Full detail in
   `docs/updates/2026-09-08-notes-optional-again.md`.
4. **Send one real test submission after deploying** and confirm the HubSpot
   contact carries the phone number. Nothing here proves live HubSpot behaviour.

---

## 6. What is explicitly NOT done

- **No live verification.** All HubSpot tests run against a stubbed `fetch`.
  They prove this code behaves correctly against HubSpot's documented contract.
  They do not prove a real portal accepts the payload, and no real lead was
  submitted.
- **No change to the HubSpot mapping**, the delivery path, dedupe, the enquiry
  block, rate limiting, attribution, GA4 events, or any environment variable.
- **No change to `buyer_inquiry`.** It is a valid form type in the schema with no
  form behind it. It requires the common fields (names, email, phone) and nothing
  form-specific, exactly as before.
- **International phone numbers are still accepted server-side but mangled by
  the client formatter.** `phoneDigits()` strips to ten digits and drops a
  leading `1`, so `+44 20 7946 0000` typed into the form becomes
  `(442) 079-4600`. That is pre-existing behaviour on a site serving one Ohio
  market; this change did not introduce it and did not fix it.
- **No new analytics.** A validation rejection is not tracked as an event, so
  there is no data on which field is causing abandonment. If item 2 above turns
  out to matter, that instrumentation is the next thing to add.
