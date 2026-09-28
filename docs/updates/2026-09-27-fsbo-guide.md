# 2026-09-27 — Toledo FSBO guide, and the `/sell` click-classification fix

## What was wrong

Search Console showed the site appearing for "sell my house without a realtor
toledo" and "sell my house without realtor in toledo ohio", mapped to `/sell`.
`/sell` is the listing-agent page; it does not answer that question, and it
should not be rewritten to.

Separately, `assets/js/main.js` classified any link whose `href` **began** with
`/sell` as `cta_sell_click`. Any new `/sell-…` route would have been counted as
a click to `/sell`.

## What changed

- **New page** `src/pages/sell-house-without-agent-toledo.html` →
  `https://crystalsellstoledo.com/sell-house-without-agent-toledo`. An
  informational for-sale-by-owner guide: the steps, pricing, marketing,
  showings, offers, inspection/appraisal/closing, what selling on your own does
  and does not save (net proceeds, no figures), when FSBO makes sense, when
  representation is worth comparing, a side-by-side table, an FAQ, and a closing
  invitation to `/home-value`. No lead form on the page; `/home-value` is the
  only conversion path, so attribution, consent, Turnstile and CRM delivery are
  the existing funnel's, unchanged.
  The route, title and headings say "agent", not "Realtor". REALTOR® is a
  membership mark, not the generic word for a real estate agent, so the page
  never uses it generically. The quoted queries above are what people typed,
  and the guide answers them in plain language ("sell without an agent",
  "for sale by owner"). The route was renamed from an unreleased
  `/sell-house-without-realtor-toledo` before merge. That URL never reached
  Production, so there is no redirect for it.
- **`/sell`** gains one "Selling across the Toledo area" item linking to the
  guide (replacing the placeholder comment PR #78 left for it).
- **Analytics** (`assets/js/main.js`, frontend only). `/sell` is now matched as a
  route: `/sell` exactly, or followed by `?` or `#`. A new branch reports
  `/sell-house-without-agent-toledo` (same rule) as **`cta_fsbo_click`**,
  carrying the same `link_text` detail every CTA event carries.
- **CSS**: a responsive `.compare` table and a hover state for the guide's
  in-page links. No existing component changed.
- **Checks/tests**: `tools/check-base.mjs` now requires `cta_fsbo_click` in the
  bundle alongside the other analytics hooks; `tests/browser.test.mjs` adds a
  classification test and a render/links/overflow test for the new page;
  `tests/consent.test.mjs` expects 10 sitemap URLs with the feature off (was 9),
  because this adds one indexable page.

## Resulting contract

| Link `href` | Event |
|---|---|
| `/sell`, `/sell?…`, `/sell#…` | `cta_sell_click` (unchanged) |
| `/sell-house-without-agent-toledo` (± `?`/`#`) | `cta_fsbo_click` (new) |
| any other path beginning `/sell` (e.g. `/seller-x`) | none |

The only narrowing is that a hypothetical `/sell/…` or `/sell-…` path no longer
reports `cta_sell_click`. No such link existed.

`generate_lead`, `lead_submit_success`, `lead_form_start`, `phone_click`,
`cta_home_value_click` and every other event are unchanged. `cta_fsbo_click` is
**not** a key event and carries no value. No GA4 property setting was changed.

## Tests

- `npm run build` and `npm run check` pass with consent off (CI's build) and
  with `COMMUNICATIONS_CONSENT_ENABLED=true` (Production's).
- The new classification test **fails against the pre-fix `main.js`** (run in
  a throwaway worktree) and passes with the fix.
- The browser suite result is recorded on the pull request.

## Not done / unproven

- Nothing here has been observed in GA4. That `cta_fsbo_click` arrives in the
  property is unproven until a Production click is seen in Realtime/DebugView.
- Indexing and ranking are unproven. No Search Console request was made.
- The page names that Ohio has a state residential property disclosure form and
  that pre-1978 homes can involve a federal lead-based paint disclosure. It
  deliberately says nothing about when either applies. The primary sources
  (codes.ohio.gov, epa.gov) could not be fetched from the build environment;
  the operator may want that sentence confirmed.
- The county sentence says only that the Lucas and Wood County auditors publish
  property records online. It deliberately names no fields.
- `/home-value` is still matched by prefix (`href.indexOf("/home-value") === 0`),
  the same shape as the `/sell` defect. No `/home-value-…` route exists, so it
  misclassifies nothing today. Left as is; fix it with the first such route.
- No FAQPage schema (see the page's header comment for why).
