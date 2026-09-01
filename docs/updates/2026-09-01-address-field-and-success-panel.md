# Visible address field, and a real confirmation after submitting — 1 September 2026

Repo `tomytomz1/crystal-sells-toledo`, branch
`claude/crystal-perrysburg-realtor-site-so38qa`, merged to `main`.

Two fixes that need **no new HubSpot permission**, split out and shipped on
their own. A third fix — putting each submission on the contact's timeline — is
blocked on a HubSpot scope and is described in
`docs/updates/2026-09-01-hubspot-timeline-activity.md`. It is **not** in this
deploy.

---

## 1. Context, for a reader with no repo access

`crystalsellstoledo.com` is a lead-generation site for **Crystal Saylor**, a
REALTOR® with **Key Realty LTD** in Toledo, Ohio. Static HTML built by a Node
script, deployed on Vercel, with one serverless function at `POST /api/lead`
that validates website enquiries and writes them into **HubSpot Contacts**.

A real production submission confirmed the pipeline works: an existing contact
was found rather than duplicated, and the submitted phone updated it. That test
also exposed the two defects fixed here.

---

## 2. What was wrong

### 2.1 The property address never reached HubSpot's visible address field

The seller's property address was written only inside the contact's `message`
text. HubSpot's standard **Street Address** field stayed empty.

On a listing enquiry the address is the single most important fact. Crystal
would open a contact, see a blank address, and have to read a wall of text to
find it — or miss it.

### 2.2 A successful submission left the visitor stranded, with no confirmation

After a successful submit the form called `reset()`, which collapsed a tall
step 2 back to a short step 1. The document shrank, the browser clamped the
scroll position, and the visitor ended up roughly halfway down the homepage.

Worse: the confirmation lived in `.form-status`, which sits **inside step 2** —
so resetting to step 1 hid it entirely. A seller who had just submitted saw an
empty address field and no acknowledgement that anything had happened.

---

## 3. What changed, file by file

```
EDIT  api/_lib/hubspot.mjs               property_address -> standard `address`
EDIT  src/partials/home-value-form.html  success panel markup (shared by both pages)
EDIT  assets/js/main.js                  swap the form for the panel; focus; scroll
EDIT  assets/css/styles.css              panel styling; global [hidden] enforcement
EDIT  tools/check.mjs                    address + success-panel guards
EDIT  tests/hubspot.test.mjs             address regression tests
EDIT  tests/browser.test.mjs             success-UX tests in a real browser
```

### 3.1 The address reaches the standard field

```js
if (lead.property_address) props.address = lead.property_address;
```

Omitted when blank, never sent as `""`. An empty string on a PATCH **blanks what
HubSpot already holds**, so a seller who gave an address on the home-value form
and later used the contact form would have had it erased. The same rule already
applied to `phone` and still does.

No custom property was created — `address` is a standard HubSpot contact field.

### 3.2 The success panel

A successful submission now **replaces the form with a persistent panel** in the
same region:

> **Your request is in**
> Crystal will personally review your property and follow up with you shortly.
> If you need to reach her sooner, call (419) 245-4655.

No redirect. No reset to step 1. Focus moves to the heading. The panel is
scrolled into view when the swap leaves it above the fold — which is the normal
case, because a visitor submits from the bottom of a tall step 2.

It ships in the **shared partial**, so the homepage and `/home-value` cannot
diverge; a check fails the build if either page inlines its own copy.

The submission id is recorded on the form element for support, never rendered.

`/contact` keeps the old inline confirmation. It is a single-step form, so
nothing collapses and the confirmation is not hidden — this bug does not occur
there, and the JS falls back cleanly.

### 3.3 `[hidden]` is now enforced globally

```css
[hidden] { display: none !important; }
```

The UA rule is normal specificity, so any class setting an explicit `display`
silently defeats it. That is exactly what `.success-panel { display: grid }` did
during development — the panel rendered before it was earned. The same bug class
had already caused a form step to render while hidden. Fixing it once, globally,
is safer than remembering `:not([hidden])` on every future component.

---

## 4. The resulting contract

**The endpoint contract is UNCHANGED**: same URL, status codes, error codes and
response shapes; same validation, limits, honeypot, rate limit, origin check,
attribution and submission ids.

### HubSpot contact properties

| Property | Source | Notes |
|---|---|---|
| `email` | form, lowercased | max 100, the dedupe key |
| `firstname` | form | max 40 |
| `lastname` | form | max 80 |
| `phone` | form, normalised | max 30, **omitted when blank** |
| `address` | property address | max 200, **omitted when blank** — NEW |
| `message` | the full enquiry block | unchanged: still accumulates |

**`message` behaviour is deliberately unchanged in this deploy.** It still
appends every enquiry, newest first. Replacing it with a short summary is only
safe once the timeline holds the full history — doing it now would destroy
enquiry history with nothing else holding it.

### Environment variables and scopes — UNCHANGED

```
HUBSPOT_ACCESS_TOKEN         (required)
HUBSPOT_API_BASE             (optional, default https://api.hubapi.com)
ALLOWED_ORIGINS              (optional)
GOOGLE_MAPS_API_KEY          (optional, build time — autocomplete)
```

Scopes still `crm.objects.contacts.read` and `crm.objects.contacts.write`. **No
new permission is needed for anything in this deploy.**

---

## 5. Test results

```
npm test  →  build + check + 175 tests, 175 passing, 0 failing
```

Up from 158. The two long-standing warnings are unrelated: one meta description
runs 7 characters over 160, and 14 site images are still placeholders.

New coverage: the address maps to `address`; a blank address is omitted; a later
address-less submission cannot erase a stored address; phone omission semantics
unchanged; a confirmation appears on both the homepage and `/home-value`; the
form is replaced rather than reset to step 1; the confirmation is fully in view
and occupies the middle of the screen; focus lands on its heading; the submission
id is never rendered; a failure still retains the form and every typed value.

The success-UX tests run in a **real Chromium**, not DOM assumptions.

### Negative testing — 9 of 9 caught, zero no-ops

```
property_address no longer maps to the standard address field   CAUGHT
address sent unconditionally (blank would erase it)             CAUGHT
phone sent unconditionally (blank would erase it)               CAUGHT
success panel removed from the shared partial                   CAUGHT
form reset to step 1 instead of being replaced                  CAUGHT
focus never moved to the confirmation                           CAUGHT
confirmation left off-screen                                    CAUGHT
[hidden] defeated again by an explicit display                  CAUGHT
submission id rendered to the visitor                           CAUGHT
```

### One debugging note worth recording

A test initially measured the panel's position *mid scroll animation*:
`html { scroll-behavior: smooth }` means `scrollIntoView` animates, so reading a
rect the instant the panel appears samples a position the visitor never sees.
The implementation was correct; the test now waits for the scroll to settle.

---

## 6. What a human must do

1. **Deploy** — merging to `main` triggers Vercel.
2. **Submit a real lead** through the homepage hero with a real address.
3. Confirm the **success panel** replaces the form, and that you are left
   looking at it rather than mid-page.
4. In HubSpot, open the contact and confirm the **visible Street Address field
   is now populated**.

No HubSpot configuration change is needed for any of this.

---

## 7. What is explicitly NOT in this deploy

- **No timeline activity.** Website submissions still do not appear as their own
  event on the contact timeline. That work is written, tested and committed, but
  is blocked on a HubSpot permission — see
  `docs/updates/2026-09-01-hubspot-timeline-activity.md`.
- **`message` still accumulates.** Unchanged on purpose, per section 4.
- `/contact` keeps its old inline confirmation.
- No lead notification — a CRM record is not an alert.
- No last-touch attribution; only first touch.
- Rate limiting is still per-instance memory.
