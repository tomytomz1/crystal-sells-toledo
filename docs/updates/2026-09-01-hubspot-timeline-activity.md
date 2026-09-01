# Website enquiries become real CRM activities — 1 September 2026

Repo `tomytomz1/crystal-sells-toledo`, branch
`claude/crystal-perrysburg-realtor-site-so38qa`.

**NOT MERGED TO `main`, AND NOT DEPLOYABLE YET.** One HubSpot permission has to
be added first. Deploying before that would make every website submission fail.
Section 8 is the exact human action.

---

## 1. Context, for a reader with no repo access

`crystalsellstoledo.com` is a lead-generation site for **Crystal Saylor**, a
REALTOR® with **Key Realty LTD** in Toledo, Ohio. Static HTML built by a Node
script, deployed on Vercel, with one serverless function at `POST /api/lead`
that validates website enquiries and writes them into **HubSpot**.

A real production submission was performed before this pass, using an email that
already existed in HubSpot. It proved the pipeline works end to end: the existing
contact was **found, not duplicated**, and the submitted phone number updated it.
Website → `/api/lead` → Vercel → HubSpot service key → contact update is live.

That same test exposed three defects, which this pass fixes.

---

## 2. What was wrong

### 2.1 The property address never reached HubSpot's visible address field

The seller's property address was written only inside the contact's `message`
text blob. HubSpot's standard **Street Address** field stayed empty.

For a listing enquiry the address is the single most important fact. Crystal
would open a contact, see a blank address, and have to read a wall of text to
find it — or miss it.

### 2.2 There was no activity on the timeline

Nothing represented the submission as an event. The contact's timeline showed
prior email activity and nothing for the website enquiry.

Every submission was appended into one `message` property. That was a defensible
bootstrap when the service key had only contacts read/write — but it is not a CRM
workflow. It has no timestamp, does not appear where Crystal looks for "what
happened with this person", grows without bound, and is rendered in a property
field that is unreadable at length.

### 2.3 A successful submission left the visitor stranded

After a successful submit the form called `reset()`, which collapsed a tall
step 2 back to a short step 1. The document shrank, the browser clamped the
scroll position, and the visitor ended up roughly halfway down the homepage.

Worse: the confirmation message lived in `.form-status`, which sits **inside
step 2** — so resetting to step 1 hid the confirmation entirely. A seller who
had just submitted saw an empty address field and no acknowledgement.

---

## 3. The research gate — what a 2026 Service Key can do

The brief required checking current HubSpot documentation rather than assuming an
older Private App scope. Findings, from HubSpot's own developer docs:

- Service keys are configured with **object-specific scopes**, named in the
  familiar `crm.objects.<object>.<read|write>` form, chosen through an
  **"Add new scope"** picker at Settings → Integrations → Service keys.
- The objects offered include Contacts, Companies, Deals, Tickets, Tasks, CRM
  emails, Meetings, Calls and **Notes**.
- **Service keys can create Notes directly.** No separate app, no OAuth.
- The endpoint is `POST /crm/v3/objects/notes`.
- `hs_timestamp` is **required** and decides where the note sits on the timeline.
  `hs_note_body` holds the text, capped at 65,536 characters.
- A note is attached to a contact with **`associationTypeId` 202**, category
  `HUBSPOT_DEFINED`, and the create call can carry the association, so one
  request creates and attaches in a single step.

**Conclusion: Notes is the correct supported mechanism, and the scope is
`crm.objects.notes.write`.** No other activity object is needed.

**What I could not verify:** I have no access to the HubSpot portal, so I have
not seen the scope picker myself. The scope name above is what HubSpot's
documentation specifies; in the UI it is selected by adding the **Notes** object
with write access. If the label differs from what you see, tell me rather than
guessing — but no invented permission is being relied on.

---

## 4. What changed, file by file

```
EDIT  api/_lib/hubspot.mjs             address mapping, note creation, failure semantics
EDIT  api/_lib/description.mjs         one row list, two views (full note + short summary)
EDIT  assets/js/main.js                success panel swap, focus, scroll anchoring
EDIT  assets/css/styles.css            success panel; global [hidden] enforcement
EDIT  src/partials/home-value-form.html  success panel markup (shared by both pages)
EDIT  tools/check.mjs                  notes/address/success-panel guards
EDIT  tests/hubspot.test.mjs           rewritten for the new contract (73 tests)
EDIT  tests/browser.test.mjs           success-UX tests in a real browser
EDIT  docs/PHASE-1-HANDOFF.md          sections 3, 4, 4c, 5, 7
EDIT  CLAUDE.md                        scopes, rules 12 and 13
```

### 4.1 The address reaches the standard field

```js
if (lead.property_address) props.address = lead.property_address;
```

Omitted when blank, never sent as `""`. An empty string on a PATCH **blanks what
HubSpot already holds**, so a seller who gave an address on a home-value form and
later used the contact form would have had it erased. The same rule already
applied to `phone` and still does.

No custom property was created. `address` is a standard HubSpot contact field.

### 4.2 Every submission is its own timeline note

```js
POST /crm/v3/objects/notes
{
  "properties": {
    "hs_timestamp": "<the submission time>",
    "hs_note_body": "<all 23 rows>"
  },
  "associations": [{
    "to": { "id": "<contactId>" },
    "types": [{ "associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 202 }]
  }]
}
```

The note carries the complete context: form type, property address, selling
timeline, condition, topic, message, notes, landing page, current page, referrer,
all five UTM fields, gclid, gbraid, wbraid, fbclid, msclkid, first touch,
submitted time, and submission id.

It is built by the **same deterministic builder** already used for the enquiry
block, so there is exactly one serialization format, not two that drift.

**HubSpot echoes the associations it made.** A note that comes back unassociated
is invisible on the timeline, which is the entire point of writing it — so that
is treated as a failure, not a success.

### 4.3 `message` decision — option D, a concise latest-enquiry summary

The brief asked for an explicit decision on the append-only blob. **It is
replaced by a short summary of the latest enquiry only.**

`message` now carries form type, property address, selling timeline, condition,
topic, and the visitor's own words — and is overwritten on each submission.
Blank rows are dropped.

Reasoning: the timeline now holds every submission in full and timestamped. An
append-only blob is a second, worse copy of the same history — unbounded, and
unreadable in the sidebar field HubSpot renders it in. But an empty sidebar is
also worse for Crystal: she should see what someone wants without opening a note.
A short latest-enquiry summary is the useful middle.

The tracking rows (UTMs, click IDs, referrer, submission id) are deliberately
**not** in the summary. They are analytics, not something to read beside a phone
number, and they are all preserved on the note.

Both views come from one row list, so they cannot drift.

### 4.4 Failure semantics — the note is not best-effort

Contact write succeeds and note creation fails → `/api/lead` returns **502** and
the visitor sees the recovery panel with Crystal's phone and email.

This is deliberate and is the opposite of the old Zoho note handling, which was
best-effort. Under the old design losing the note lost an annexe. Under this one
the note *is* the enquiry, so losing it silently would hand Crystal a name with
no enquiry attached and nothing to indicate anything was missing.

Distinct, named failures: `HUBSPOT_NOTES_SCOPE_MISSING` (403, with the exact
remediation logged), `HUBSPOT_NOTE_NOT_ASSOCIATED`, `HUBSPOT_NOTE_AUTH_*`,
`HUBSPOT_NOTE_RATE_LIMITED`, `HUBSPOT_NOTE_SERVER_*`,
`HUBSPOT_NOTE_MALFORMED_RESPONSE`.

**No HubSpot response body is ever attached to an error** — HubSpot echoes
submitted values in validation errors, which would put lead PII in the logs.

### 4.5 Partial writes — stated, not pretended away

There is **no transaction across two HubSpot objects.** If the contact write
succeeds and the note fails, HubSpot is left holding:

- the contact, updated — name, email, phone, address, `message` summary
- **no activity** for that submission

and `/api/lead` returns 502, so the visitor is never told it landed.

A resubmit finds the same contact by email and updates it — **never a duplicate
contact** — then writes a fresh note. Every submission carries its own
`submission_id`, so a resubmit is a genuinely distinct submission and two notes
is the honest record of two attempts.

HubSpot offers no idempotency key on note creation, so **at-least-once** is the
real guarantee. Saying otherwise would be inventing atomicity that does not exist.

### 4.6 The success panel

A successful submission now **replaces the form with a persistent panel** in the
same region:

> **Your request is in**
> Crystal will personally review your property and follow up with you shortly.
> If you need to reach her sooner, call (419) 245-4655.

No redirect. No reset to step 1. Focus moves to the heading. The panel is
scrolled into view when the swap leaves it above the fold — which is the normal
case, because a visitor submits from the bottom of a tall step 2.

It lives in the **shared partial**, so the homepage and `/home-value` cannot
diverge. A static check fails the build if either page inlines its own.

The submission id is recorded on the form for support but never rendered.

**`[hidden]` is now enforced globally** with `!important`. The UA rule is normal
specificity, so any class that sets an explicit `display` silently defeats it —
which is exactly what `.success-panel { display: grid }` did, showing the panel
before it was earned. That bug class has now bitten twice; fixing it once
globally is safer than remembering `:not([hidden])` on every future component.

---

## 5. The resulting contract

### Endpoint — UNCHANGED

```
POST /api/lead     JSON only · 16 KB cap · same-origin
200  { "ok": true,  "submission_id": "csv_<24 hex>" }
4xx  { "ok": false, "code": "...", "message": "..." }
```

Same status codes, same error codes, same shapes. Validation, limits, honeypot,
rate limit, origin check, attribution and submission ids are untouched.

### Field limits — UNCHANGED

```
first_name 40 · last_name 80 · email 100 · phone 30
property_address 200 · topic 120 · timeline 120 · condition 120
message 4000 · notes 4000 · page 300 · form_type 32
landing_page 500 · referrer 500 · first_touch_at 40
utm_* 200 · gclid/gbraid/wbraid/fbclid/msclkid 300
```

Overlength values are rejected with 422, never truncated.

### HubSpot contact properties

| Property | Source | Notes |
|---|---|---|
| `email` | form, lowercased | max 100, the dedupe key |
| `firstname` | form | max 40 |
| `lastname` | form | max 80 |
| `phone` | form, normalised | **omitted when blank** |
| `address` | property address | **omitted when blank** |
| `message` | short summary of the latest enquiry | replaced each time |

### Environment variables — UNCHANGED

| Variable | Required | Default |
|---|---|---|
| `HUBSPOT_ACCESS_TOKEN` | **yes** | — |
| `HUBSPOT_API_BASE` | no | `https://api.hubapi.com` |
| `ALLOWED_ORIGINS` | no | — |
| `GOOGLE_MAPS_API_KEY` | no | unset — autocomplete off |

### HubSpot scopes — CHANGED

```
crm.objects.contacts.read
crm.objects.contacts.write
crm.objects.notes.write      <- NEW, required
```

---

## 6. Test results

```
npm test  →  build + check + 178 tests, 178 passing, 0 failing
```

Up from 158. The two long-standing warnings are unrelated: one meta description
runs 7 characters over 160, and 14 site images are still placeholders.

Coverage added:

```
property address maps to the standard `address` field       covered
blank address is omitted, never sent empty                  covered
a later address-less submission cannot erase the address    covered
phone omission semantics unchanged                          covered
first submission = one contact + one activity               covered
repeat email  = one contact + two activities, first intact  covered
every activity associated to the correct contact            covered
the 409 conflict path still writes its activity             covered
complete 23-row serialization on the activity               covered
submission id present on the activity                       covered
association failure fails the lead                          covered
activity creation failure fails the lead                    covered
malformed activity response fails the lead                  covered
missing notes scope is named, not a generic 403             covered
no silent retry that drops the enquiry                      covered
retry after activity failure does not duplicate the contact covered
summary replaces rather than accumulates                    covered
summary excludes tracking rows                              covered
success confirmation on homepage AND /home-value            covered
form replaced, not reset to step 1                          covered
confirmation fully in view; focus on its heading            covered
submission id never rendered                                covered
failure retains the form and every typed value              covered
```

The success-UX tests run in a **real Chromium**, not DOM assumptions.

### Negative testing — 20 of 20 caught, zero no-ops

Every new guard was broken deliberately once, the suite confirmed to fail, then
restored.

```
property_address no longer maps to the standard address field   CAUGHT
address sent unconditionally (blank would erase it)             CAUGHT
phone sent unconditionally (blank would erase it)               CAUGHT
no note created at all                                          CAUGHT
note not associated to the contact                              CAUGHT
wrong association type id                                       CAUGHT
hs_timestamp dropped (HubSpot requires it)                      CAUGHT
note body emptied of the enquiry                                CAUGHT
note failure swallowed as best-effort                           CAUGHT
unassociated note accepted as success                           CAUGHT
malformed note response accepted                                CAUGHT
missing notes scope left as a generic 403                       CAUGHT
summary accumulates again instead of replacing                  CAUGHT
summary carries the tracking rows it should not                 CAUGHT
success panel removed from the shared partial                   CAUGHT
form reset back to step 1 instead of being replaced             CAUGHT
focus never moved to the confirmation                           CAUGHT
confirmation left off-screen                                    CAUGHT
[hidden] defeated again by an explicit display                  CAUGHT
submission id rendered to the visitor                           CAUGHT
```

**One started as a no-op and had to be repaired.** The test asserting that the
summary excludes tracking rows used a payload with *empty* attribution — so the
tracking rows were dropped as blank anyway and the assertion could never fail.
It now uses a fully populated payload and checks both the labels and their
values. Re-broken afterwards to confirm it fires.

### Two debugging notes worth recording

- **A test measured a scroll mid-animation.** `html { scroll-behavior: smooth }`
  means `scrollIntoView` animates, so reading a rect the instant the panel
  appears samples a position the visitor never sees. The implementation was
  correct; the test now waits for the scroll to settle.
- **An early "the page must not move" assertion was wrong-headed.** Playwright
  scrolls to an element before clicking it, so the baseline captured before the
  submit click was never comparable. More importantly the requirement is not
  "nothing scrolls" — a visitor submitting from the bottom of a tall form
  *should* be brought to the confirmation. The test now asserts the confirmation
  is fully visible and is what occupies the middle of the screen.

### What the tests do NOT prove

Every HubSpot test runs against a **stubbed fetch**. They prove the client
behaves correctly against HubSpot's documented contract. They do not prove the
portal accepts the note, that the scope name is what the UI shows, or that the
association renders as expected on the timeline. Only a live submission does.

---

## 7. What is NOT regressed

Explicitly preserved and still covered by tests: Google Places autocomplete via
the Data API, the Perrysburg location bias, the independent type-filter/bias
fallback, the supported `ADDRESS_TYPES` only, free-text address submission, the
250 ms debounce, the 3-character minimum, session-token rotation, build-time
Maps key injection, no geographic restriction, all validation and `maxlength`
behaviour, same-origin protection, the honeypot, the 16 KB body limit, rate
limiting, first-touch attribution, submission ids, no CRM credential in the
browser, no lead PII in logs, the shared form partial, and every compliance
guardrail in `CLAUDE.md`.

---

## 8. HUMAN ACTION REQUIRED

**This branch is not merged and must not be deployed until step 1 is done.**
Note creation is mandatory by design, so deploying first would make every
submission return 502 and every visitor see the recovery panel.

**1. Exact permission to add:** `crm.objects.notes.write`

**2. Exact operation needing it:** `POST /crm/v3/objects/notes` — creating the
timeline activity and associating it to the contact.

**3. Where to add it:** HubSpot → **Settings → Integrations → Service keys** →
open the existing key → **Add new scope** → add the **Notes** object with
**write** access. Contacts read and write stay as they are.

**4. Can the existing key be edited, or must it be rotated?** Try editing it
first — service keys are managed in that screen and scopes are expected to be
editable. If your portal will not let you change the scopes of an existing key,
create a new key with all three scopes and delete the old one.

**5. Does the Vercel token have to change?** Only if you had to create a new key.
If you edited the existing key in place, `HUBSPOT_ACCESS_TOKEN` is unchanged. If
you created a new one, update `HUBSPOT_ACCESS_TOKEN` in Vercel → Settings →
Environment Variables → Production.

**6. Then tell me, and I will merge to `main`.** Or merge it yourself — the
branch is pushed and green.

**7. The production test to run after deploying:**

- Submit through the homepage hero with a real address.
- Confirm the **success panel** appears in place of the form, and that you are
  left looking at it rather than mid-page.
- In HubSpot open the contact and confirm **A. the visible Street Address field
  is populated** and **B. a distinct website-submission activity exists on the
  timeline**, carrying all 23 rows.
- Submit again with the **same email** and a different message. Confirm **one
  contact and two distinct activities**, the first still intact, and that the
  `message` summary now shows the second enquiry.
- If a submission fails, check the Vercel logs for `hubspot.notes_scope_missing`
  (the scope did not take effect) or `hubspot.note_not_associated`.

---

## 9. What is explicitly NOT done

- **Not deployed, not merged.** Blocked on the scope above, deliberately.
- **The timeline activity has never been created against a real portal.** The
  contact write is proven live; the note is not.
- **The scope picker has not been seen.** The scope name comes from HubSpot's
  documentation, not from the UI.
- **The `/contact` form keeps the old inline confirmation.** It is a single-step
  form, so nothing collapses and the confirmation is not hidden — the bug this
  pass fixes does not occur there. The JS falls back cleanly. Giving it the same
  panel is markup-only work if you want it.
- **No lead notification.** A CRM record is not an alert; response time is still
  bounded by how often Crystal checks HubSpot.
- No last-touch attribution; only first touch.
- Rate limiting is still per-instance memory.
- Zoho code remains in the repo, imported by nothing, as a rollback path.
