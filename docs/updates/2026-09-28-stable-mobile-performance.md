# Stable mobile performance pass

## Objective
Raise the worst-case mobile PageSpeed floor without changing the lead funnel, consent, CRM, SEO content, analytics event names, or server-side verification.

## Why
Production PageSpeed could score near 90 on one run and fall into the 70s on another. The bad runs showed a text-based LCP in the homepage hero while third-party analytics, Turnstile, web fonts, and the full stylesheet were still competing with first paint.

## Changes
- Added a small inline first-paint CSS bootstrap for the shared header, dark opening surface, homepage hero, and Step 1 valuation form.
- Changed the full immutable stylesheet to preload/apply asynchronously instead of blocking first paint.
- Removed Google Fonts from the critical network race and load them after the initial page has settled. Existing `display=optional` remains.
- Kept the GA4 queue/config available immediately, but delayed the external Google tag until first interaction, page hide, or an 8-second post-load fallback.
- Kept Google Maps/Places lazy on address-field interaction.
- Kept Turnstile fully enforced server-side, but delayed the Cloudflare runtime until a visitor actually interacts with a lead form.
- Delayed Vercel Web Analytics until interaction or the same post-load fallback.

## Explicitly unchanged
- Form fields, validation, steps, payloads, submission endpoint, or success behavior
- HubSpot delivery
- SMS/AI consent wording or evidence
- GA4 event names or attribution payloads
- Turnstile server-side enforcement
- SEO titles, descriptions, canonicals, content, sitemap, or structured data

## Acceptance gates
- Full CI green
- Exact-head Vercel preview READY
- Homepage form Step 1 -> Step 2 -> Back works without submission
- Address autocomplete still works after interaction
- Turnstile script absent before form interaction and available afterward
- No runtime errors
- Repeated mobile PageSpeed runs materially raise the floor, with target median 90+ and no 7-9 second LCP outliers
