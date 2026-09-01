# Google Analytics 4 installed — 1 September 2026

Repo `tomytomz1/crystal-sells-toledo`, branch
`claude/crystal-perrysburg-realtor-site-so38qa`, merged to `main`.

---

## 1. Context, for a reader with no repo access

`crystalsellstoledo.com` is a lead-generation site for **Crystal Saylor**, a
REALTOR® with **Key Realty LTD** in Toledo, Ohio. Static HTML built by a Node
script (`tools/build.mjs`), deployed on Vercel.

The site had **no analytics vendor installed**. It did already have a
vendor-neutral event layer in `assets/js/main.js` that dispatches browser
`CustomEvent`s and forwards them to `dataLayer` / `gtag` **if those exist** —
built that way deliberately so a vendor could be added later without touching
event code.

This pass adds the vendor. GA4 property `G-GFW8ER1Q85`.

---

## 2. What changed

```
EDIT  tools/build.mjs             GA4 tag, emitted for production builds only
EDIT  src/partials/_shell.html    {{analytics}} slot at the top of <head>
EDIT  tools/check.mjs             analytics guards
EDIT  tests/browser.test.mjs      GA4 wiring tests
```

### 2.1 The tag

Google's snippet, unmodified, emitted at the top of `<head>` on every page as
Google specifies:

```html
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-GFW8ER1Q85"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-GFW8ER1Q85');
</script>
```

Exactly one Google tag per page — Google's docs are explicit that a page must
never carry more than one, and a check fails the build if a second appears.

### 2.2 It only runs in production

The measurement ID is hardcoded rather than kept in an environment variable: a
GA4 measurement ID is **not a credential**. It is public by design, visible in
the page source of every site that uses it, and identifies the property rather
than granting access to it. Treating it like a secret would add a configuration
step for no security benefit.

What **is** gated is where it runs:

```js
const GA4_ON = process.env.VERCEL_ENV === "production" || process.env.GA4_FORCE === "1";
```

- **Vercel production** → the tag is emitted
- **Vercel preview deploys** → nothing emitted
- **Local `npm run dev` / `npm run build`** → nothing emitted

Vercel sets `VERCEL_ENV` itself, so this needs no configuration. It matters
because every test submission, every layout check and every preview build would
otherwise land in the numbers Crystal will use to judge whether her marketing is
working. `GA4_FORCE=1` emits it anyway, for verifying the tag itself.

The ID is validated against `/^G-[A-Z0-9]{6,12}$/` before being written into a
script tag; a malformed value fails the build rather than shipping.

### 2.3 What starts reporting immediately

Because the event layer already forwards to `gtag`, these begin arriving in GA4
as custom events with **no further work**:

```
cta_home_value_click   cta_sell_click      phone_click        email_click
lead_form_start        lead_form_step_complete
lead_submit_success    lead_submit_error   address_suggestion_selected
```

Each carries `page`, plus `form_type`, `utm_source`, `utm_medium` and
`utm_campaign` where applicable. `lead_submit_success` carries the
`submission_id`, so a GA4 conversion can be traced to the exact HubSpot contact.

**Analytics is never load-bearing.** `main.js` hardcodes no vendor and a check
fails the build if it ever does; the site and the whole lead funnel work
identically with no analytics present. A test proves the funnel completes and
throws nothing when `gtag` is absent.

---

## 3. Test results

```
npm test  →  build + check + 185 tests, 185 passing, 0 failing
```

Up from 178 (four new tests). New coverage: site events reach `gtag` when a tag is present; a
lead submission reports `lead_submit_success` with its submission id; the site
works with no analytics vendor at all and throws nothing; a local build ships no
Google tag.

Verified directly in both build modes: a local build emits **zero** references to
`googletagmanager.com`; a `VERCEL_ENV=production` build emits **exactly one**
tag on each of the 9 pages, at the top of `<head>`.

### Negative testing — 7 of 7 caught, zero no-ops

```
tag emitted on preview and local builds too      CAUGHT
measurement ID no longer validated               CAUGHT
tag made render-blocking (async dropped)         CAUGHT
two Google tags on a page                        CAUGHT
tag loads but never configures a property        CAUGHT
main.js hardcodes the analytics vendor           CAUGHT
gtag forwarding removed from the event layer     CAUGHT
```

One of these first reported as a no-op; the break itself had failed to apply
because of quoting in the test harness, not because the guard was weak. Re-run
with the edit applied correctly, the guard fires.

---

## 4. What a human must do

**Nothing.** The tag ships with the next production deploy.

To confirm it is live: open `crystalsellstoledo.com`, then in GA4 check
**Reports → Realtime**. You should appear within about 30 seconds. GA4's own
"Test installation" button in the setup screen also works once deployed.

Worth doing at some point, though not required:

- **Mark `lead_submit_success` as a conversion** in GA4 (Admin → Events). That is
  the event that means a seller actually submitted an enquiry, and it is what
  makes GA4 able to tell you which traffic produces leads.

---

## 5. Privacy — flagged, not changed

GA4 sets cookies and collects usage data. That makes Google a data processor for
this site.

The privacy note currently says details are shared with "the service providers
that run this site" — broad enough to cover it, but it does **not name Google
Analytics**. I have not changed that copy on my own initiative, the same as when
Google Places autocomplete was added.

Two things to decide when convenient, neither urgent for a US-only local business:

- whether to name Google Analytics explicitly in the privacy note
- whether to add a cookie banner / Google Consent Mode. GA4's setup screen
  prompts about this for EEA visitors; the audience here is Toledo-area sellers,
  so it is a judgement call rather than an obligation. **This is not legal
  advice** — if it matters, Key Realty's broker is the right person to ask.

Say the word and I will add either.

---

## 6. What is explicitly NOT done

- **No conversion is configured in GA4.** Events will arrive; marking which one
  counts as a conversion is a click in the GA4 UI (section 4).
- **No Google Tag Manager.** The direct gtag.js snippet is installed. GTM would
  add a management layer this site does not need.
- **No ad pixels**, no Meta Pixel, no Google Ads linking — all still explicitly
  out of scope per the project's standing list.
- **The privacy note is unchanged** (section 5).
- **Not verified live.** The tag has never loaded in a browser against the real
  GA4 property — that happens on the next production deploy.
