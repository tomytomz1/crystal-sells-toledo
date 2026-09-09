# Communications consent foundation — SMS and AI voice

**Date:** 2026-09-09
**Base production `main`:** `d69695f0a5f487d199dfc465b0270b542de352ad`
**Branch:** `claude/communications-consent-foundation`
**Status:** implemented, tested, **feature-gated OFF, not merged, not deployed.**

**No SMS was sent. No call was placed. No HubSpot configuration was changed.
No A2P Campaign was submitted. Production behaviour is unchanged.**

This document assumes no repo access and no memory of previous conversations.

---

## 1. What this is, and what it is not

The site is being prepared for a future system where Twilio may text people and
Retell AI may call them about a real-estate enquiry they submitted. Before any
of that can exist, one thing has to exist first and be right: **a record of who
agreed to what, and a way to stop.**

This change builds that and nothing else. It does not send a message, place a
call, add a Twilio or Retell dependency, or turn anything on.

**A note on wording.** This is designed to preserve channel-specific
affirmative consent and revocation evidence. Whether that satisfies any
particular legal standard is a determination for a qualified attorney, not a
claim this document makes.

### Scope of the permission being asked for

Inquiry-related communications: replying to a submitted enquiry, valuation
follow-up, appointment scheduling and reminders, requested information,
conversational responses about the enquiry, and closely related property or
service updates the consumer asked for.

**Not** a marketing programme. A future marketing effort needs its own consent
design and probably its own A2P campaign; the disclosures here are deliberately
narrow and a test fails if the words "marketing", "promotional", "offers",
"newsletter" or "partners" ever appear in them.

---

## 2. The consent model

**Two separate optional checkboxes.** Never one. Never bundled into Submit.
Never pre-ticked. Never required.

| | SMS | Automated / AI voice |
|---|---|---|
| Field | `sms_consent` | `ai_voice_consent` |
| Version | `CST_SMS_CONSENT_2026_09_V1` | `CST_AI_VOICE_CONSENT_2026_09_V1` |

The exact wording lives in `api/_lib/consent.mjs` and is reproduced below.

> **SMS —** I agree to receive text messages from Crystal Sells Toledo about my
> real estate inquiry, appointments, requested information, and related
> services. Message frequency varies. Message and data rates may apply. Reply
> STOP to opt out or HELP for help. Consent is not a condition of service. See
> the Privacy Policy and Communications Terms.

> **AI voice —** I agree to receive calls from Crystal Sells Toledo at the
> number I provided, including calls using automated technology and an
> artificial, prerecorded, or AI-generated voice, about my real estate inquiry,
> appointments, and requested services. Consent is not a condition of service.
> See the Privacy Policy and Communications Terms.

Granting one never grants the other. A test asserts both directions.

### Where the boxes appear

One shared partial, `src/partials/consent-block.html`, included by **both** form
implementations — the shared `home-value-form` partial (which serves `/`,
`/home-value` and `/43551-seller-review`) and `/contact`. Those are the only two
forms on the site that collect a phone number. There is exactly one source for
each disclosure and a check fails the build if any page renders more or fewer
than one of each control.

Placement is the final contact-details portion of the form, after the last field
and before Submit — not in step 1 of the valuation funnel, where it would sit on
top of the one question that gets someone to start.

---

## 3. The trust boundary

The browser sends **two booleans and nothing else**:

```json
{ "sms_consent": true, "ai_voice_consent": false }
```

Everything that gives them meaning is attached server-side: the timestamp, the
version, the exact disclosure text, the normalised phone, the form type, the
page, and the submission id.

`parseConsentFlag()` accepts **only a JSON boolean `true`**. `"yes"`, `"on"`,
`"1"`, `"true"`, `1`, `[true]`, `{granted:true}` and an object with a `valueOf`
returning true are all false. The client reads `input.checked`, which is already
a real boolean, so nothing honest arrives in any other shape — and every other
shape is what a hand-rolled request trying to manufacture consent looks like.

A test posts a payload carrying `sms_consent_version: "ATTACKER_V9"`, a forged
disclosure text and a backdated timestamp, and asserts none of it reaches the
evidence.

### No IP address is stored

Deliberate. The privacy notice says submission IPs are held briefly in memory
for rate limiting and are not added to contact records, and adding consent is
not a reason to start collecting more PII than the notice describes. The
submission id, server timestamp, page and normalised phone identify the event
without it. `tools/check.mjs` fails the build if `api/_lib/consent.mjs` ever
reads an IP.

---

## 4. What is actually persisted today, and where

This is the part that matters most, and the part where it would be easy to
claim more than is true.

### Evidence — works now, no HubSpot setup, no new scopes

Consent evidence rides inside the enquiry block that already goes to HubSpot's
**native form-submission timeline activity**. That activity is created per
submission, dated from the server's submission time, and is not editable through
the API. Eight rows are appended:

```
SMS CONSENT: GRANTED
SMS CONSENT VERSION: CST_SMS_CONSENT_2026_09_V1
SMS CONSENT AT: 2026-09-09T14:02:11.004Z
SMS CONSENT PHONE: (419) 555-1234
AI VOICE CONSENT: NOT GRANTED
AI VOICE CONSENT VERSION: CST_AI_VOICE_CONSENT_2026_09_V1
AI VOICE CONSENT AT: -
AI VOICE CONSENT PHONE: -
```

A declined disclosure is recorded too, with its version and text — "declined" is
meaningless unless you know which words were on the screen.

**This is CRITICAL, not a courtesy.** It travels in the same HubSpot write that
stores the lead, through the existing `submitForm` call that already fails the
submission loudly if HubSpot rejects it. There is no path where the contact is
saved and the consent is silently lost. A test asserts a HubSpot failure still
returns 502 with consent enabled.

**What this is not:** the contact's `message` *property* carries a short summary
that is overwritten on every submission. That is not evidence and this document
does not call it evidence. Only the timeline activity accumulates.

### Current permission state — NOT persisted yet, and this is the blocker

A contact's *current* permission (granted / revoked / suppressed, plus the
suppression records) needs custom HubSpot contact properties that **do not
exist**. Writing to nonexistent properties would break lead submission, so this
code does not write them at all.

The state model, the transition function (`applySubmissionConsent`) and the
resolver are implemented, pure and tested — they are simply not yet wired to a
store. `docs/updates/2026-09-09-hubspot-consent-setup.md` is the exact property
specification and setup order.

**Until those properties exist, the feature stays off.** That is what the gate
is for.

---

## 5. The permission resolver

`api/_lib/permission.mjs` is the only place allowed to answer "may we contact
this person". A future Twilio module does not get a lead and work it out; a
future Retell module does not read a flag and dial. They ask, get
`{ allowed, reason }`, and obey.

```
canSendSms(state, targetPhone, { env })
canPlaceAutomatedVoiceCall(state, targetPhone, { env })
```

Precedence, and the order **is** the argument:

1. `FEATURE_DISABLED` — nothing goes out while the feature is off
2. `GLOBAL_DNC` — "do not contact me" outranks everything
3. channel suppression — `SMS_SUPPRESSED_STOP` / `VOICE_DNC`
4. consent status — `NO_CONSENT` or `CONSENT_REVOKED`
5. `INVALID_PHONE`
6. `CONSENT_PHONE_MISMATCH`

**Suppression is checked before consent, deliberately.** A contact whose status
still reads `granted` because a form arrived after a STOP must still be refused.
Putting consent first would make the resolver agree with the most recent form
rather than with the consumer.

### Four states, not a boolean

`never_granted`, `granted`, `revoked`, `suppressed`. A single `false` was being
asked to mean "never asked", "declined", "withdrew" and "sent STOP" — and only
one of those may ever be cleared by someone ticking a box again.

### Consent binds to a phone number

Permission is recorded against the number that was on screen beside the
disclosure. If the contact's number later changes, the old permission does not
follow: `CONSENT_PHONE_MISMATCH`. Numbers change hands, and the person now
holding the line never agreed to anything. Formatting differences are not a
mismatch — comparison is on digits after the same normalisation the lead
pipeline applies.

---

## 6. Suppression precedence and re-opt-in

The scenario from the brief, and the single most important behaviour here:

> Day 1: opts in to SMS. Day 2: replies STOP. Day 30: submits another valuation
> form with the box ticked.

**Result: still suppressed.** `applySubmissionConsent()` never touches the
suppression record. A ticked box against a revoked or suppressed channel records
a `pending_reoptin` marker *beside* the suppression, never on top of it, and the
resolver still returns `SMS_SUPPRESSED_STOP`.

Anything else would let a mass-mailed "update your details" link quietly
resurrect every number that ever sent STOP.

Three rules:

| Box on a later submission | Effect |
|---|---|
| Unticked | **Nothing.** Not a revocation. Someone who opted in last month and did not re-tick has withdrawn nothing. |
| Ticked, no prior suppression | Grants; records phone, time, version. |
| Ticked, prior STOP/DNC/revocation | Suppression stands. Request recorded as pending re-opt-in. |

**There is no implemented un-suppress.** Clearing a suppression is deliberately
not built: it is a separate, explicit, auditable transition. And where Twilio
holds its own carrier-level opt-out for a number, clearing our record alone
would not make the message deliverable anyway — Twilio's own opt-out list has to
be cleared through Twilio, which is a documented human step, not something this
code can fake.

### Channel separation

- SMS STOP → SMS suppressed, **voice unaffected**
- Voice DNC → voice suppressed, **SMS unaffected**
- Global "do not contact me" → both

All three are tested in both directions.

---

## 7. The feature gate

**`COMMUNICATIONS_CONSENT_ENABLED`** — one environment variable, read in two
places within a single deployment:

- **Build time** (`tools/build.mjs`): does the checkbox render, is
  `/communications-terms` built, does the privacy page carry its messaging
  section?
- **Runtime** (`api/lead.js` via `api/_lib/consent.mjs`): is a consent payload
  turned into evidence and written?

Vercel exposes the same variable to the build and to the function, so the two
halves cannot disagree. Enabled only by the exact string `"true"` — not `"1"`,
`"yes"` or `"TRUE"`. A compliance feature should not switch itself on through a
typo. Not a secret; it is a boolean carrying no credential.

### OFF (the default, and what production runs today)

- no consent checkbox on any page
- `/communications-terms` is **not built at all** — sitemap stays at 9 URLs, so
  the site never publishes legal terms for a programme that is not running
- privacy page carries no messaging section and names neither Twilio nor Retell
- no consent rows in the CRM enquiry block
- the resolver returns `FEATURE_DISABLED` for everything

`tools/check.mjs` fails the build if a consent control renders while the gate is
off, and fails it if the privacy page names Twilio or Retell while the gate is
off. A visitor is never shown a consent promise the backend is not configured
to keep.

### ON

Consent UI renders, payload is accepted, evidence is persisted,
`/communications-terms` is built and linked from the footer, and the privacy
page describes the messaging runtime.

---

## 8. Consent versioning and anti-drift

The canonical text lives once, in `api/_lib/consent.mjs`. `tools/build.mjs`
**imports that module** and renders the page from it, so the words a visitor
reads and the words recorded as their consent are one string with one
derivation. There is no second copy in a template.

`html` is the same sentence with two link phrases wrapped in anchors.
`assertConsentCopyIntact()` asserts that stripping the tags reproduces `text`
character for character, plus that both links are present and the required
phrases survive. It **throws** — a build that displays different words from the
ones it records is not shippable — and it runs in the build, in `check.mjs`, and
in a test.

**Changing a word means minting a new version constant.** Never edit the text of
an existing version: contacts already carry it as the thing they agreed to, and
rewriting it retroactively falsifies their record.

---

## 9. What changed

| File | Change |
|---|---|
| `api/_lib/consent.mjs` | **new** — canonical copy, versions, strict parser, evidence builder, state model, submission-to-state transition |
| `api/_lib/permission.mjs` | **new** — the resolver, suppression scopes, reasons |
| `api/_lib/validate.mjs` | parses the two flags strictly; never requires them |
| `api/_lib/description.mjs` | appends 8 consent rows when evidence is present |
| `api/lead.js` | builds evidence after the submission id, logs a PII-free shape |
| `assets/js/main.js` | serialises the two booleans from `input.checked` |
| `src/partials/consent-block.html` | **new** — the shared control |
| `src/partials/privacy-messaging.html` | **new** — gated privacy section |
| `src/pages/communications-terms.html` | **new** — gated route |
| `src/pages/privacy.html` | one gated slot |
| `src/partials/footer.html` | gated second legal link (the existing "Privacy & terms" link is untouched) |
| `tools/build.mjs` | the gate, page-level `featureGate`, consent render vars |
| `tools/check.mjs` | the compliance guards |
| `assets/css/styles.css` | `.consent` block |
| `.env.example` | the flag, documented as build-time *and* runtime |
| `tests/consent.test.mjs` | **new** — 55 tests |
| `package.json` | `test:consent` script |

**No new dependency.** Nothing here needs one.

### One bug worth recording

The consent partial's own header comment contained its template token. The
renderer runs six substitution passes, so the partial re-inserted itself on
every pass and shipped **five copies of the consent fieldset** onto every form
page. A `check.mjs` guard now asserts exactly one of each control per page, and
the comment carries a warning.

---

## 10. Tests

| Suite | Result |
|---|---|
| `npm run build` (off) | 10 pages, 9 sitemap URLs |
| `npm run build` (on) | 11 pages, 10 sitemap URLs |
| `npm run check` (off and on) | 0 errors, 0 warnings |
| `npm run test:consent` | **55 passed, 0 failed** |
| `npm run test:unit` | 97 passed |
| `npm run test:hubspot` | 90 passed |
| `npm run test:mail` | 36 passed |
| `npm run test:browser` | 103 passed |

The gate tests **build the site twice for real** into a throwaway copy of the
tree and assert on the rendered output — asserting the source templates would
prove nothing about what ships, and mutating the working `public/` mid-run would
break the browser suite.

Six guards were proved to fail, in a throwaway copy, with the working tree never
modified: a pre-ticked box, a required box, consent UI leaking into the OFF
build, consent copy drift, consent made a condition of service in
`validate.mjs`, and an IP address added to the evidence.

---

## 11. What is deliberately NOT enabled

- **No SMS is sent.** No Twilio SDK, no `api/_lib/twilio.mjs`, no credentials.
  Adding an unused module and unused env vars would read as configuration
  somebody forgot to set.
- **No calls are placed.** No Retell agent, no module, no credentials.
- **No call recording or transcription.** Both pages state calls are not
  recorded; a test asserts the privacy page does not imply otherwise. Enabling
  it is a separate decision that expands the privacy and interstate-consent
  surface.
- **No inbound webhooks.** Not required for this phase. Requirements are
  documented in §13.
- **No current-state HubSpot writes** — see §4 and the setup document.
- **No change to the acknowledgement email path**, HubSpot mapping, dedupe,
  attribution, GA4, rate limiting, or the public response contract.

---

## 12. Human activation steps, in order

1. **Create the HubSpot properties** per
   `docs/updates/2026-09-09-hubspot-consent-setup.md`. Nothing else here works
   without them.
2. **Wire current-state writes.** A follow-up change; the setup document
   specifies exactly what it writes.
3. **Resolve the Twilio A2P Brand / Campaign.** Answers are prepared in
   `docs/updates/2026-09-09-a2p-campaign-answers.md`. Nothing has been submitted.
4. **Set `COMMUNICATIONS_CONSENT_ENABLED=true`** in Vercel Production. This
   turns on the UI and persistence together; it does not send anything.
5. **Verify** on production: both boxes present, both unticked, neither
   required, `/communications-terms` reachable, privacy page updated, a test
   submission's HubSpot timeline activity carrying the consent rows.
6. Only then consider the sending phases.

### Rollback

Set `COMMUNICATIONS_CONSENT_ENABLED=false` and redeploy. The UI disappears,
`/communications-terms` stops being built, the privacy section is removed, and
evidence stops being written. Already-captured evidence stays on the HubSpot
timeline where it is. No code revert needed. If a full revert is wanted, the
branch is a single merge commit.

---

## 13. Future webhooks — documented, not built

**Twilio:** inbound SMS, STOP/HELP handling, delivery status.
**Retell:** call lifecycle, disposition, opt-out intent, transcripts only if
ever enabled.

Every one of them will need: provider request verification (Twilio signature /
Retell signing secret), replay and idempotency defence, dedupe on provider
message id, PII-safe logging, and **an immediate suppression write before any
acknowledgement is returned**.

### STOP / HELP behaviour when built

Carrier and Twilio keywords at minimum: `STOP`, `STOPALL`, `UNSUBSCRIBE`,
`CANCEL`, `END`, `QUIT`. Twilio handles its own set at the platform level and
maintains its own opt-out state for a number — our record and Twilio's are two
separate things and both must be cleared for a genuine re-opt-in.

Natural language must also count. "Please stop texting me" is a revocation even
though it is not a keyword. HELP returns Crystal's name and contact details.

### Voice revocation when built

"Stop calling me", "don't call me again", "take me off your list", "do not
contact me" are high-priority suppression intents. The agent must not argue,
keep selling, or require particular words, and the revocation must be persisted
**before** any further outbound attempt.

### AI disclosure when built

An automated call identifies itself at the start — conceptually: *"Hi, this is
the AI assistant for Crystal Saylor with Crystal Sells Toledo. You asked us to
contact you about your real estate inquiry."* No human impersonation.

---

## 14. Unresolved

1. **HubSpot current-state properties do not exist.** The blocker. Feature stays
   off until they do.
2. **Twilio A2P Brand/Campaign is unresolved with Twilio/TCR.** Nothing here
   depends on it, and nothing was submitted.
3. **Crystal's internal operational lead alert** ("New website lead received.
   Open HubSpot for details.") is prepared as an interface concept only. It is
   **not** categorically exempt from 10DLC requirements just because it is
   internal, and it is not enabled.
4. **Nothing is proven against a live HubSpot portal.** All CRM tests run
   against a stubbed `fetch`.
