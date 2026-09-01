# Google Places address autocomplete — 1 September 2026

Repo `tomytomz1/crystal-sells-toledo`, branch
`claude/crystal-perrysburg-realtor-site-so38qa`.

**Status: implemented and tested. Inactive until a Google Maps API key is set.**
It has never run against Google's live API — there was no key in the build
environment. Section 7 is what a human has to do to switch it on.

---

## 1. Context, for a reader with no repo access

`crystalsellstoledo.com` is a lead-generation site for **Crystal Saylor**, a
REALTOR® with **Key Realty LTD** in Toledo, Ohio. Static HTML built by a Node
script, deployed on Vercel, with one serverless function at `POST /api/lead` that
writes enquiries into HubSpot.

The homepage hero opens with a two-step home-valuation funnel whose first field is
the property address. That field was a plain text input, so typing `4108` offered
nothing. This adds Google-backed address suggestions to it.

---

## 2. What was wrong

The address field had `autocomplete="street-address"`, which only triggers the
**browser's own** saved-address autofill. It is not a lookup, it knows nothing
about real addresses, and for most visitors it produces nothing at all.

Consequences: a seller types a partial or misspelled address, Crystal receives a
lead she has to interpret or chase, and the CMA is slower to produce.

---

## 3. The API decision

Google **deprecated** `google.maps.places.Autocomplete` — the classic widget that
attaches to an existing `<input>` — in March 2025. It is unavailable to any API
key created after that date, so Crystal's new key cannot use it. A static check
now fails the build if that widget is reintroduced.

The current options are the **`PlaceAutocompleteElement`** web component and the
**Place Autocomplete Data API**. This uses the **Data API**, with our own
suggestion list rendered on top.

That choice is deliberate. `PlaceAutocompleteElement` renders its own input inside
a shadow DOM, which would displace the real `property_address` field along with
its visible label, its `required` state, its `maxlength="200"`, the step-validation
logic and every existing guard — and its shadow DOM cannot be styled to match the
dark hero. The Data API returns predictions programmatically, so **our input stays
the source of truth** and nothing else in the funnel changes.

---

## 4. What changed, file by file

```
EDIT  tools/build.mjs             build-time, key-gated loader injection
EDIT  src/partials/_shell.html    {{mapsLoader}} slot after main.js
EDIT  assets/js/main.js           initAddressAutocomplete() (~150 lines)
EDIT  assets/css/styles.css       .addr-suggest dropdown, both contexts
EDIT  tools/check.mjs             key-leak, API-surface and fairness guards
EDIT  tests/browser.test.mjs      +14 tests against a stubbed Google
```

No change to `api/`, the lead contract, validation, limits, or the HubSpot path.

### 4.1 The key is injected at build time, never committed

The Maps JS key is a **browser** key. There is no way to do client-side
autocomplete without shipping it, and Google designs it to be public — it is
protected by *restrictions*, not secrecy. That makes it categorically different
from `HUBSPOT_ACCESS_TOKEN`, and the two must not be confused.

It still does not belong in the repo. `tools/build.mjs` reads
`GOOGLE_MAPS_API_KEY` at build time and injects the loader into the page:

```js
const MAPS_KEY_OK = /^[A-Za-z0-9_-]{20,80}$/.test(MAPS_KEY);
if (MAPS_KEY && !MAPS_KEY_OK)
  throw new Error("GOOGLE_MAPS_API_KEY is not a plausible Google API key - refusing to emit it");
```

So the key can be rotated by redeploying rather than by editing code, a fork gets
no autocomplete, and a malformed value — a paste error, or an injection attempt —
**fails the build instead of reaching a `<script>` tag**.

**With no key set, nothing is emitted at all** and the address field is exactly
the plain text input it is today. That is the committed default and the state of
the current deploy.

### 4.2 The visitor is never blocked

This is the rule the whole implementation is built around, and it follows the
project's governing rule that no legitimate lead may be lost:

- A visitor can ignore every suggestion and type freely.
- An address Google has never heard of — a new build, a rural route — submits
  normally.
- If the script is blocked, the key is revoked, quota is exhausted, or the API
  errors, the list closes and the field silently reverts to plain text. No error
  is ever shown; a message about a mapping service would only make someone think
  their enquiry had failed.
- A chosen suggestion is truncated to the field's `maxlength` before it lands, so
  a long formatted address can never trip the server's 200-character limit and
  turn into a 422 after the fact.

### 4.3 Suggestions are biased to Perrysburg, never restricted

```js
var ADDRESS_BIAS = { center: { lat: 41.557, lng: -83.627 }, radius: 50000 };
```

`locationBias`, not `locationRestriction`. Local addresses rank first, but nothing
outside the circle is excluded. A restriction would silently drop a legitimate
address just outside the box, and would make a site that already has to avoid
looking like it refuses other areas do exactly that. A check fails the build if
`locationRestriction` ever appears.

### 4.4 Keyboard and screen-reader support

The input becomes a proper combobox: `role="combobox"`, `aria-expanded`,
`aria-controls`, `aria-autocomplete="list"`, `aria-activedescendant`, and a
`role="listbox"` of `role="option"` items. Arrow keys move, Enter selects, Escape
closes, Tab closes. Keyboard highlight and mouse hover render identically.

Two details worth naming:

- **Enter is only swallowed when a suggestion is actually highlighted.** Otherwise
  the visitor keeps normal form behaviour, and pressing Enter after typing a full
  address does not get eaten.
- `autocomplete` is switched to `"off"` **at runtime**, only once our list is
  live, so the browser's own autofill dropdown does not draw a second competing
  menu over ours. The attribute stays `street-address` in the markup, so the
  no-JavaScript path keeps it.

### 4.5 Cost control

Autocomplete is billed. Three things keep the request count down:

- a **250 ms debounce**, so a burst of typing is one request, not one per letter
- a **3-character minimum** before anything is requested
- **session tokens**, rotated after each selection, which is what makes Google
  bill per session rather than per keystroke

On any API error the feature disables itself for the rest of the page rather than
retrying on every keystroke, so a quota problem cannot compound into a bill.

---

## 5. Test results

```
npm test  →  build + check + 155 tests, 155 passing, 0 failing
```

Up from 141. Fourteen new browser tests run against a **stubbed** `google.maps`,
covering: suggestions rendering, debounce, the 3-character minimum, session-token
rotation, click selection, arrow-key + Enter selection, Enter not advancing the
step, Escape, combobox ARIA wiring, a free-typed address still submitting, a
Google failure degrading to plain text with no page error, the no-key case, the
`maxlength` cap, and a chosen address reaching the lead payload.

### Negative testing — 19 of 19 caught, zero no-ops

Every new guard was broken deliberately once, the suite confirmed to fail, then
restored.

```
API key hardcoded into the shipped bundle                      CAUGHT
Maps API loaded directly from main.js                          CAUGHT
build-time key validation weakened to a truthiness check       CAUGHT
loader emitted with no key gate at all                         CAUGHT
autocomplete no longer gated on the loader promise             CAUGHT
ready-promise declared with no loader to resolve it            CAUGHT
deprecated Places Autocomplete widget used                     CAUGHT
suggestions RESTRICTED to a bounding box instead of biased     CAUGHT
location bias dropped entirely                                 CAUGHT
autocomplete unbound from the property_address input           CAUGHT
chosen suggestion no longer capped to maxlength                CAUGHT
suggestions fire on every keystroke (no debounce)              CAUGHT
session token never rotated after a selection                  CAUGHT
Enter swallowed even with nothing highlighted                  CAUGHT
Escape no longer closes the list                               CAUGHT
arrow-key navigation removed                                   CAUGHT
combobox ARIA wiring removed                                   CAUGHT
a Places failure left to throw at the visitor                  CAUGHT
free-typed address blocked when Google returns nothing         CAUGHT
```

**Four of these started as no-ops and had to be repaired before they counted:**

- Checking that `MAPS_KEY_OK` merely *existed* passed when the validation was
  swapped for `Boolean(MAPS_KEY)`. The guard now requires an actual pattern test
  against the key, and that the loader is emitted conditionally.
- Renaming `__csvMapsReady` to `__csvMapsReadyX` passed, because the guard was a
  substring match. It now uses a word boundary — in both the script and the page
  check.
- Nothing asserted the **session token rotates** after a selection. That is a pure
  billing bug: everything would look and work fine while being charged per
  keystroke. A test now asserts the token changes.

### Build-path verification

Not expressible in the suite (it depends on build-time environment), so it was
verified directly:

| Build | Result |
|---|---|
| no key (the committed default) | no loader emitted, zero `maps.googleapis.com` references, check passes |
| valid key | loader emitted with `loading=async&callback=csvMapsReady`, check passes |
| `bad"key><script>` | build **throws**, nothing emitted |
| `abc123` (too short) | build **throws**, nothing emitted |

### What the tests do NOT prove

Google is stubbed throughout. These tests prove **our** behaviour — the list, the
keyboard, what lands in the input, and that a lead is never blocked. They prove
nothing about whether Google's API returns what we expect, whether the request
parameters are accepted, or whether the key is correctly restricted. Only a live
key can show that.

---

## 6. Compliance and privacy

- **Not an automated valuation.** This resolves an address; it produces no
  estimate, no price, no range. The site still promises a human CMA. Untouched.
- **No area is excluded** — bias, not restriction (section 4.3).
- The address a visitor types is sent to Google to fetch suggestions. That is
  inherent to using Google's service. The privacy note already says details are
  shared with "the service providers that run this site"; **if you want this
  spelled out explicitly, say so and I will add Google Places by name** — I have
  not changed that copy on my own.

---

## 7. What a human must do to switch it on

Nothing is active until these are done. Skipping them leaves today's behaviour.

1. **Create a Google Cloud project** and enable **Places API (New)** and **Maps
   JavaScript API**. Both are required.

2. **Create an API key**, then **restrict it** — this is the step that matters,
   because the key is public:
   - *Application restrictions* → **HTTP referrers**, allowing only
     `https://crystalsellstoledo.com/*` and `https://www.crystalsellstoledo.com/*`
     (add the Vercel preview domain too if you want it working there).
   - *API restrictions* → **only** Places API (New) and Maps JavaScript API.

   An unrestricted key can be lifted off the page and run up a bill on someone
   else's site.

3. **Set a billing budget and alert** in Google Cloud. Google gives a monthly
   credit that a site this size will very likely stay inside, but a budget alert
   is what turns a surprise into a notification.

4. **Add `GOOGLE_MAPS_API_KEY` to Vercel** (Settings → Environment Variables,
   Production) and **redeploy**. It is read at *build* time, so a redeploy is
   required — setting the variable alone does nothing.

5. **Verify on the live site:** type `4108` in the hero address field and confirm
   suggestions appear. Then check the browser console for a Google error such as
   `RefererNotAllowedMapError` (referrer restriction is wrong) or
   `ApiNotActivatedMapError` (an API is not enabled).

---

## 8. What is explicitly NOT done

- **Never run against the live Google API.** No key existed in the build
  environment. Every test stubs Google.
- **Inactive in the current deploy.** No key is set, so the field is unchanged.
- **No address validation or normalisation.** A chosen suggestion is stored as
  Google's prediction text. Nothing verifies the address is real, deliverable, or
  inside Crystal's service area, and free text is still accepted by design.
- **No place ID, no lat/long, no address components stored.** Only the formatted
  string goes into `property_address`. Capturing structured components would need
  a billed Place Details call and a CRM field to hold them.
- **The privacy note does not name Google.** See section 6.
- The `/contact` form has no address field, so it is unaffected.
