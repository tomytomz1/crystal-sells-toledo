# Three live UX fixes after production proof — 1 September 2026

Repo `tomytomz1/crystal-sells-toledo`, branch
`claude/crystal-perrysburg-realtor-site-so38qa`.

**The HubSpot lead pipeline is production-proven and was not touched in this
pass.** These are three bugs observed on the live site after that proof.

---

## 1. Context, for a reader with no repo access

`crystalsellstoledo.com` is a lead-generation site for **Crystal Saylor**, a
REALTOR® with **Key Realty LTD** in Toledo, Ohio. Static HTML built by a Node
script, deployed on Vercel, with one serverless function at `POST /api/lead`
that writes enquiries into HubSpot.

### The pipeline is proven — and unchanged

Live verification confirmed, end to end:

- a first website submission created **one** HubSpot Contact
- **Street Address** populated correctly
- **phone** populated correctly
- a native **`Form submitted`** activity appeared on the Contact timeline
- that activity carried the complete deterministic enquiry payload
- a **second submission with the same email** created a **second distinct**
  `Form submitted` activity
- there was still exactly **one** Contact
- the first submission remained intact; the second carried
  `LIVE FORMS API TEST 2`
- the persistent post-submit success panel worked

Delivery remains: validate → Contacts API write/update → authenticated Forms
Submission API write → success only if both succeed. **No file under `api/` was
modified in this pass.**

---

## 2. Bug 1 — the success heading was unreadable

### What was wrong

The confirmation panel worked, but its heading `Your request is in` rendered
near-black on the dark panel and was effectively invisible.

### Why

```css
h1, h2, h3, h4 { color: var(--ink); }        /* element specificity */
.hero .success-panel { color: #fff; }        /* only affects inheritance */
```

An element-level rule sets the heading's colour outright, so it never inherited
the panel's white. Every other line in the panel is a `<p>` and inherited
correctly — which is exactly why only the heading looked wrong.

### The fix

The heading now names its own colour in every context, rather than relying on
inheritance:

```css
.success-panel__title            { color: var(--ink); }   /* explicit base */
.hero .success-panel__title      { color: #fff; }
.form-card .success-panel__title { color: var(--ink); }
```

Layout, copy and the gold checkmark are untouched. Measured in a real browser
with alpha compositing, the heading now clears **4.5:1** on both the homepage
hero and `/home-value` — the WCAG AA bar for normal text, which is stricter than
the 3:1 that applies at this size.

---

## 3. Bug 2 — the address menu reopened after a selection

### What was wrong

Clicking a suggestion wrote the address correctly, then the dropdown immediately
reopened underneath it showing the same address and its neighbours.

### Why — two independent causes, both mine

**Cause A, the one that fired every time.** Selecting wrote the value and then
dispatched an `input` event so the rest of the form would notice:

```js
input.value = value.slice(0, ...);
close();
input.dispatchEvent(new Event("input", { bubbles: true }));   // re-enters our own listener
```

That event synchronously re-entered *our own* input listener, which scheduled a
debounce, which fetched suggestions for the address just chosen, which rendered
them. The menu reopened with the selected address at the top — precisely the
reported symptom.

**Cause B, latent.** `seq` — the request-sequence counter that discards stale
responses — was not bumped on selection, and the pending debounce timer was not
cancelled. A response already in flight could therefore resolve after the menu
had closed and render into it.

### The fix — selection is now terminal, on all four paths

```js
function choose(i) {
  clearTimeout(timer);        // cancel the pending debounce
  seq++;                      // invalidate anything in flight
  input.value = ...;
  chosenValue = input.value;  // remember exactly what we wrote
  close();
  token = new SessionToken(); // billing: rotate the session
  programmatic = true;        // our announcement is not the visitor typing
  try {
    input.dispatchEvent(new Event("input",  { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } finally { programmatic = false; }
  input.focus();              // focus STAYS in the field
}
```

and in the input listener:

```js
if (programmatic) return;                                        // our own write
if (chosenValue !== null && input.value === chosenValue) return; // unchanged since selection
chosenValue = null;                                              // a real edit: active again
```

The two reopen guards are **deliberately redundant** — either alone closes the
loop. That matters for negative testing, see section 6.

None of the forbidden shortcuts were used: autocomplete is not disabled after a
selection, no arbitrary timeout was added, the field is **not** blurred, the
chosen address is not altered, and no geographic restriction was introduced.
Editing the selected address brings suggestions straight back.

Preserved and still tested: the Perrysburg location bias, the independent
bias/type-filter fallback, `ADDRESS_TYPES`, free-text submission, the 250 ms
debounce, the 3-character minimum, session-token rotation, build-time key
injection, keyboard navigation and the combobox announcements.

---

## 4. Bug 3 — phone numbers were not formatted

### What was wrong

Typing `5863241248` left the field showing `5863241248`, which reads like a
number the site did not understand.

### The fix

A dependency-free formatter on every `input[name="phone"]` — the hero funnel,
`/home-value` and `/contact`, all from the same code.

```
5 · 58 · 586 · (586) 3 · (586) 32 · (586) 324 · (586) 324-1 · (586) 324-1248
```

- **Logical value is digits only.** Punctuation never counts toward the ten-digit
  maximum.
- **A leading `1` is stripped only at eleven digits**, when it can only be the
  country code. Stripping earlier would eat a real area-code digit.
- Normalises `5863241248`, `(586) 324-1248`, `586-324-1248`, `586 324 1248`,
  `+1 586 324 1248` and `15863241248` to the same result.
- **Caret is tracked by digit count, not string position**, so typing, paste,
  cut, range replacement and drag-drop all land the caret where the visitor
  expects.
- **Backspace and Delete skip generated punctuation.** Without this the caret
  sits after `") "`, the native delete removes the space, reformatting puts it
  straight back, and nothing is ever deleted — the visitor is trapped. Deleting
  at the *end* of the field never reproduces that, which is why the test does it
  mid-field.
- Autofilled values are caught by `change` and `blur`, and by a pass at init for
  a value already present.
- **Blank stays blank** — an empty field produces an empty string, never
  punctuation.

### The server is still authoritative

Nothing here relaxes validation. `api/_lib/validate.mjs` re-normalises whatever
arrives and rejects anything over 30 characters; the formatted `(586) 324-1248`
is 14. The HubSpot mapping is unchanged: a blank phone is still **omitted** from
both the contact write and the form submission, so it can never overwrite a
number HubSpot already holds.

---

## 5. The HubSpot cookie warning — accurate, and expected

HubSpot's submission UI shows a warning because the request carries no HubSpot
tracking cookie. **This does not indicate any lead-delivery failure.**

What is actually true:

- the site does **not** load HubSpot's tracking code
- so no real `hubspotutk` cookie exists to send
- the code therefore **deliberately does not send `context.hutk`**, and does not
  invent or synthesise one
- Contact deduplication by email is **proven working** in production
- form-submission association to the Contact is **proven working** in production

The warning affects HubSpot's own browser/session/page-view attribution only —
whether HubSpot can stitch the submission to an anonymous visitor session it was
already tracking. It has no bearing on whether the lead arrives, which Contact it
lands on, or what the activity contains.

Nothing was changed about this in this pass: no `hutk` fabricated, no tracking
code installed, no cookie-consent code added.

### If HubSpot visitor analytics are wanted later

1. install the real HubSpot tracking code
2. handle privacy and cookie consent appropriately for it
3. read the actual `hubspotutk` cookie and pass it as the Forms API
   `context.hutk`

That is a deliberate, separate decision — it introduces a third-party tracking
cookie to the site — and is not required for lead delivery.

---

## 6. Test results

```
npm test  →  build + check + 229 tests, 229 passing, 0 failing
```

Up from 199.

New coverage:

```
SUCCESS PANEL
  heading contrast >= 4.5:1, measured with alpha compositing   homepage + /home-value
  heading colour matches its panel (not the global heading ink) homepage + /home-value
  the gold confirmation mark survives the fix

ADDRESS AUTOCOMPLETE
  mouse click: populates, closes, STAYS closed
  Enter on a highlight: populates, closes, STAYS closed
  a stale response resolving AFTER selection cannot reopen the menu
  the programmatic write triggers no new Places request
  editing the selected address re-enables suggestions
  session token still rotates after selection
  a chosen address still reaches the lead payload

PHONE FORMATTER
  typing ten digits -> (586) 324-1248
  progressive display matches the specified sequence
  paste: raw / formatted / hyphenated / spaced / +1 / leading 1
  Backspace mid-field deletes a digit rather than trapping on punctuation
  held Backspace empties the field
  Delete forward works through punctuation
  select-all and replace
  clearing leaves empty, not punctuation
  more than ten digits ignored
  a formatted phone reaches /api/lead; a blank one stays blank
  /contact uses the same formatter
  autofill without an input event is still formatted
```

The reopen bug is reproduced in the harness with a **deliberately delayed Places
response**, so the stale-response path is exercised rather than assumed.

### Negative testing — 15 caught, 1 no-op

```
heading colour removed (falls back to global ink)              CAUGHT
heading light colour dropped on the dark hero                  CAUGHT
success heading explicit colour removed entirely               CAUGHT
THE LIVE BUG restored (both reopen guards removed)             CAUGHT
selection no longer invalidates in-flight requests             CAUGHT
selection no longer cancels the pending debounce               CAUGHT
session token no longer rotates on selection                   CAUGHT
selection changes the chosen address                           CAUGHT
location bias dropped                                          CAUGHT
formatter not wired up at all                                  CAUGHT
leading US country code no longer stripped                     CAUGHT
digit cap removed                                              CAUGHT
formatting groups wrong                                        CAUGHT
punctuation-skipping deletion removed (caret trapped)          CAUGHT
change/autofill path removed                                   CAUGHT
chosen value never cleared                                     NO-OP (see below)
```

**The one no-op is real and is reported as such.** Removing `chosenValue = null`
changes no behaviour: the guard beside it only blocks when the input still holds
*exactly* the chosen text, so any edit falls through regardless. The line is
state hygiene, not a guard, and is kept for that reason rather than counted as
one.

**Two earlier breaks first reported as no-ops were measurement errors, not weak
guards.** Removing the `programmatic` flag alone, or the chosen-value check
alone, changes nothing because the two are deliberately redundant — either one
closes the reopen loop. Broken *together*, they restore the live bug and the
tests fail, which is the entry above.

**One test expectation of mine was wrong and was corrected**, not the code: with
the caret just after `(586) `, the nearest preceding digit is the `6`, so
Backspace correctly yields `(583) 241-248`. I had written `(863) 241-248`.

---

## 7. What was NOT changed

The HubSpot pipeline, in full: the Contacts API sequence, the authenticated
secure Forms Submission endpoint, portal ID and form GUID handling, Service Key
auth, the six-field form contract, one-Contact-per-email behaviour, repeat
submission behaviour, the full 23-row enquiry payload in the submission
`message`, the standard `address` mapping, blank phone/address omission,
delivery failure semantics, the no-false-success rule, and the Vercel
environment contract. **No file under `api/` was modified.**

No Notes API work was reintroduced. No HubSpot tracking code was installed. No
cookie-consent code was added.

Also preserved and still covered by tests: same-origin protection, the honeypot,
the 16 KB body limit, rate limiting, first-touch attribution, submission ids, no
CRM secret in the browser, no PII in logs, the shared home-value form partial,
the Google Places Data API and its cost controls, GA4 production-only gating,
asset hashing, the manually maintained content date, and every compliance rule
in `CLAUDE.md`.

---

## 8. Human verification still required

These three fixes are **not production-proven**. They are tested in a real
browser against stubs; they have not been seen on the deployed site.

After deployment:

- **A.** Submit the form and confirm the success heading is readable.
- **B.** Select a Google address suggestion and confirm the address stays
  selected, the dropdown disappears, and it does **not** come back.
- **C.** Edit the selected address and confirm suggestions work again.
- **D.** Type or paste a phone number and confirm `(586) 324-1248`.
- **E.** Submit once more and confirm HubSpot delivery still succeeds — one
  Contact, a new `Form submitted` activity.

---

## 9. What is explicitly NOT done

- **These three fixes are not production-proven** until section 8 passes.
- **No HubSpot tracking code**, so the cookie warning will still appear. It is
  documented in section 5 and is not a delivery failure.
- **No cookie-consent banner** and no privacy-note change in this pass.
- No lead notification — a CRM record is still not an alert.
- No last-touch attribution; only first touch.
- Rate limiting is still per-instance memory.
- Zoho code remains in the repo, imported by nothing, as a rollback path.
- The Notes implementation remains unmerged at tag `hubspot-notes-fallback`.
