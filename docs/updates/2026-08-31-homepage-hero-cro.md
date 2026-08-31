# Homepage hero — conversion redesign — 31 August 2026

Scope was the homepage hero only. Repo `tomytomz1/crystal-sells-toledo`, branch
`claude/crystal-perrysburg-realtor-site-so38qa`.

**Status: the hero is rebuilt and tested. Conversion improvement is unproven.**
Nothing here has been measured against real traffic, and the production lead
pipeline still has never made a live call to Zoho.

---

## 1. Context, for a reader with no repo access

`crystalsellstoledo.com` is a lead-generation site for **Crystal Saylor**, a
REALTOR® with **Key Realty LTD** in Toledo, Ohio. Static HTML built by a Node
script (`tools/build.mjs`), deployed on Vercel, with one serverless function at
`POST /api/lead` that validates enquiries and writes them into Zoho CRM.

The homepage previously opened with a brand statement and two buttons — one of
which sent the visitor to `/home-value` to start a form. The seller who came to
find out what their house is worth had to click, wait for a page load, and only
then meet the first field.

---

## 2. What changed, and why

### 2.1 The valuation form is now in the hero itself

The single largest change. The first thing above the fold is the question the
visitor arrived with — *What could your Perrysburg home sell for?* — and directly
beneath it the field that begins answering it.

Removing the page load between intent and first field removes the step where
intent is most likely to evaporate. This is the whole thesis of the pass. It is a
reasoned bet, not a measured result — see section 8.

### 2.2 One form, two pages, no second pipeline

The form was extracted to `src/partials/home-value-form.html` and is included by
both `/` and `/home-value`. The partial holds **only** the `<form>`; headings,
cards and hero copy stay with each page, and context styling is by ancestor
selector (`.hero .hv-form` vs `.form-card .hv-form`).

That shape was chosen so drift is structurally impossible rather than merely
discouraged. The lead contract — `form_type`, field names, limits, step
behaviour — exists in exactly one file. There is no way to change the homepage
funnel and forget the standalone page, because there is only one funnel.

No new endpoint, no second pipeline, no address in a query string, no Zoho call
from browser code. `POST /api/lead` is untouched.

### 2.3 Step 1 asks for one thing

Step 1 is the property address and nothing else. Step 2 collects contact details.
Steps toggle with the `hidden` attribute rather than CSS, so an inactive step
leaves both the tab order and the accessibility tree instead of sitting invisible
but focusable. With JavaScript off, both steps render and submit in one pass.

### 2.4 The hero image degrades to a branded background

The real hero photograph does not exist yet. Rather than ship the site-wide dev
placeholder into the most prominent position on the site, `tools/build.mjs` now
resolves the image at build time:

```js
const HERO_IMAGE = "assets/img/hero-perrysburg.jpg";
const heroImageTag = existsSync(join(ROOT, HERO_IMAGE))
  ? `<img src="/${HERO_IMAGE}?v=${assetHash(HERO_IMAGE)}" alt=""` +
    ` width="1800" height="1200" fetchpriority="high" decoding="async">`
  : "";
```

No file, no `<img>` — the hero falls back to the ink/gradient background, which
looks deliberate. Drop the real photo at that path and it appears, content-hashed,
with no markup change. The global image-fallback system is untouched for every
other image on the site; this opt-out is scoped to the hero alone.

### 2.5 No invented proof

No ratings, review counts, awards, sold counts, "#1", "top agent", scarcity or
urgency. The trust signals in the hero are the three things that are true and
verifiable: no obligation, a human valuation, and explicitly not an automated
estimate. `tools/check.mjs` scans the hero's **visible text** for the banned
claim vocabulary and fails the build on a hit.

---

## 3. Four defects found by measurement, not by reading

These are recorded because each was invisible in source and only appeared under
a real browser.

### 3.1 An include token inside an HTML comment hoisted the form out of the hero

I wrote `{{> home-value-form}}` inside an explanatory HTML comment above the
hero. The build expands includes **anywhere** in the file, including inside
comments. The partial carries its own comment block, whose `-->` terminated the
enclosing comment early — so the parser hoisted the entire form out of the hero
and made it a direct child of `<main>`, *before* the hero section.

Found by bisection after a false lead (the header appeared to be the overflowing
element). The fix is one deleted token; the guard that now catches it is worth
more than the fix.

### 3.2 `.btn--ghost` had no background — 1.15 contrast on the dark hero

`.btn--ghost` set a border and a color but never `background`, so the button
inherited the UA default `buttonface` (`#efefef`). On the dark hero the "Back to
address" label was white on near-white: **1.15** — invisible, and not caught by
any static rule.

Fixed by making the base rule explicitly transparent and giving the hero's submit
button the gold fill:

```css
.btn--ghost { background: transparent; border-color: currentColor; color: var(--ink); }
.hero .hv-form .btn--primary { background: var(--gold); color: var(--ink); }
```

### 3.3 Step 2 was cramped

The form's grid `gap` does not reach inside the step containers, so the revealed
step 2 had no vertical rhythm. Fixed with:

```css
[data-step]:not([hidden]) { display: grid; gap: 1.15rem; }
```

The `:not([hidden])` is load-bearing. Without it, the explicit `display: grid`
overrides `[hidden]`'s `display: none` and **both steps render at once** — the
one-field ask silently becomes a seven-field wall.

### 3.4 The eyebrow wrapped onto a dangling separator

`Perrysburg · 43551 · Greater Toledo` wrapped so that line two began with a
`·`. Fixed by binding each separator to the word before it with `&nbsp;`.

---

## 4. Files changed

```
NEW   src/partials/home-value-form.html   the single source of the valuation funnel
EDIT  src/pages/index.html                hero rewritten, form included
EDIT  src/pages/home-value.html           inline form replaced by the shared partial
EDIT  assets/css/styles.css               hero capture layout + 3 fixes above
EDIT  tools/build.mjs                     build-time hero image resolution
EDIT  tools/check.mjs                     static hero guards
EDIT  tests/browser.test.mjs              layout, a11y and funnel guards
```

`api/`, `assets/js/main.js` and every other page are untouched.

---

## 5. Test result

```
npm test

  Built 9 pages into public/
  9 pages checked — no errors, 2 warnings

  # tests      75
  # suites      9
  # pass       75
  # fail        0
```

Up from 62. The two warnings are long-standing: one meta description runs 7
characters over the 160 target, and 14 site images are still placeholders (down
from 15 — the hero no longer emits one).

### Negative testing — 21 of 21 caught, zero no-ops

Every new guard was broken deliberately once, the suite confirmed to fail, then
restored. A guard that cannot fail is not a guard.

```
h1 changed away from the control copy                CAUGHT
salesperson name put back into the h1                CAUGHT
hero form replaced by a link to /home-value          CAUGHT
address field loses required                         CAUGHT
address maxlength dropped from 200                   CAUGHT
secondary action promoted to a button                CAUGHT
secondary link retargeted away from /sell            CAUGHT
hero microcopy removed                               CAUGHT
unsupported proof claim added to hero                CAUGHT
hero falls back to the visible dev placeholder       CAUGHT
form inlined into index instead of the partial       CAUGHT
/home-value stops using the shared partial           CAUGHT
field contract drifts between the two pages          CAUGHT
include token written inside a comment               CAUGHT
CTA loses white-space:nowrap                         CAUGHT
hero content allowed to overflow horizontally        CAUGHT
step 2 revealed at first paint                       CAUGHT
address label removed (placeholder-only UI)          CAUGHT
leadEndpoint nulled                                  CAUGHT
legal lockup name styled separately                  CAUGHT
CONTENT_UPDATED turned into a build timestamp        CAUGHT
```

Two of these started as no-ops and had to be repaired before they counted:

- **Overflow detection.** `body { overflow-x: hidden }` clips the document scroll
  width, so `scrollWidth - clientWidth` reads zero even when content genuinely
  overflows. Rewritten to sweep element rectangles.
- **The address label.** Nothing guarded it, so deleting the `<label>` and
  shipping a placeholder-only field passed cleanly. Now guarded.

---

## 6. Visual verification — completed

Measured in a real Chromium via Playwright at all seven required viewports.
`overflow` and `heroEsc` exclude the honeypot input, which sits at `left:-9999px`
by design.

| Viewport | overflow | hero escapes | CTA wraps | CTA height | address in fold | CTA in fold |
|---|---|---|---|---|---|---|
| 320×568 | 0 | 0/19 | no | 63px | yes | **no — 40px below** |
| 375×667 | 0 | 0/19 | no | 63px | yes | yes |
| 390×844 | 0 | 0/19 | no | 63px | yes | yes |
| 430×932 | 0 | 0/19 | no | 63px | yes | yes |
| 1024×768 | 0 | 0/19 | no | 63px | yes | yes |
| 1440×900 | 0 | 0/19 | no | 63px | yes | yes |
| 1920×1080 | 0 | 0/19 | no | 63px | yes | yes |

**Accepted trade-off at 320×568:** the CTA sits about 40px below the fold. The
address field — the actual entry point — is visible everywhere. Closing that 40px
would mean shrinking type or touch targets below their accessible sizes, which
the brief explicitly rules out. At 375×667 and above everything is in the fold.

### Contrast, measured in the revealed step 2 on the dark hero

Translucent foregrounds are composited over their backdrop before the ratio is
taken; measuring `rgba()` as opaque overstates contrast badly.

```
step 2 submit button   ink on gold          5.80
back button            white on ink        18.70
step 2 labels          82% white on ink    12.66
notes / microcopy      62% white on ink     7.59
h1                     white on ink        18.70
eyebrow                gold on ink         10.19
```

Lowest is 5.80 — all above the 4.5 AA threshold for normal text.

---

## 7. Contract status

**Unchanged.** `docs/PHASE-1-HANDOFF.md` was deliberately **not** modified: the
endpoint, request and response shapes, CRM payload, field limits, picklist
handling and environment variables are all exactly as at `dc2d618`. The hero
submits through the same `POST /api/lead` with the same `form_type: home_value`
and the same field names as before.

The only contract-adjacent detail is that `property_address` is now collected on
the homepage as well as `/home-value` — the same field, same 200-character limit,
same endpoint. That is a new *entry point*, not a new contract.

---

## 8. What is explicitly NOT proven

- **Conversion is not proven improved.** 75 passing tests say the hero is built
  as specified and does not break. They say nothing about whether more people
  fill it in. That requires real traffic over real time. "Tests pass" and
  "conversion improved" are different claims and this pass only supports the first.
- **Production lead delivery remains unproven.** No live call has ever been made
  to a real Zoho account. A visitor completing this new hero form today would hit
  a pipeline that has only ever been exercised against mocks. This is unchanged
  by this pass and remains the single highest-risk open item on the project.
- **The hero photograph does not exist.** The gradient fallback is deliberate and
  looks intentional, but a real Perrysburg image would almost certainly do better.
- No A/B test, no analytics goal configured, no heatmapping.

---

## 9. What a human must still do

Unchanged from `docs/updates/2026-08-31-zoho-schema-corrections.md` section 6 —
the Zoho Self Client, `npm run zoho:verify`, the picklist confirmation, the
Vercel environment variables, and the two live test submissions.

New from this pass, and optional:

- Supply a real hero photograph at `assets/img/hero-perrysburg.jpg`. Landscape,
  ideally 1800×1200 or larger. It must be a real image Crystal has rights to —
  not a stock photo and not a property she does not represent.
