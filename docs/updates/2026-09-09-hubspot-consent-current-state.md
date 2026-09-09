# HubSpot consent current-state wiring (Phase 2)

**Date:** 9 September 2026
**Branch:** `claude/hubspot-consent-current-state`
**Status:** implemented, tested, **not merged**, and **not enabled**.
`COMMUNICATIONS_CONSENT_ENABLED` remains absent from Vercel Production, so
none of this executes in production today.

This document stands alone. It assumes no repository access and no memory of
earlier conversations.

---

## 1. What this phase is, and what it is not

Phase 1 (`docs/updates/2026-09-09-communications-consent-foundation.md`) built
the consent *model*: the two disclosures, their version constants, the
server-side evidence object, the pure transition function
`applySubmissionConsent()`, the permission resolver, and the build-time and
runtime feature gate. It shipped with nowhere to store the result.

Phase 1a (`docs/updates/2026-09-09-hubspot-consent-setup.md`) specified 23
HubSpot Contact properties. Those properties were created in the production
portal on 9 September 2026 and independently verified.

**Phase 2 — this change — connects the two.** When the feature is enabled, a
website form submission now:

1. reads the contact's existing consent state out of HubSpot **before**
   deciding anything,
2. folds this submission into that state using the *existing* pure transition
   function, and
3. writes back only the properties whose values actually moved.

**This phase does not:** enable the public consent UI, send an SMS, place a
call, add Twilio, add Retell, add a webhook, implement STOP processing,
implement DNC processing, implement reactivation or un-suppression, modify
Vercel, modify HubSpot property definitions, modify HubSpot forms, or create
workflows.

### Current state versus evidence

Two records exist and they are not interchangeable.

| | Current state | Evidence |
|---|---|---|
| Where | The 23 mutable Contact properties | The ten consent rows inside each HubSpot form-submission timeline activity |
| Answers | "What is true right now?" | "What happened on this submission?" |
| Cardinality | One per contact, overwritten | One per submission, additive by construction |
| Written by | This phase | The existing form submission, unchanged by this phase |

If the two ever disagree, the timeline activities are the record of what
happened and the properties are a cache of the current conclusion. The
activities are per-submission and additive **by construction** — that is not
the same as proven immutable, and this document does not claim it is.

---

## 2. Files

| File | Change |
|---|---|
| `api/_lib/hubspot-consent-state.mjs` | **New.** The only module that knows the 23 `cst_*` names. Pure: no fetch, no side effects, no env reading beyond the feature gate. |
| `api/_lib/hubspot.mjs` | Reads consent state on contact lookup; folds and writes it on create, update and the 409 conflict path. |
| `tools/check.mjs` | Static guards (§8). |
| `tests/consent-state.test.mjs` | **New**, 38 tests. |
| `tests/hubspot.test.mjs` | Updated for the changed `findContactByEmail` return shape; one new feature-off assertion. |
| `package.json` | `npm run test:consent-state`. |

`api/_lib/consent.mjs` was **not** changed. The transition rules are where
Phase 1 left them; this phase decides *when* to fold, never *how*.

---

## 3. The mapping

All 23 names live in `api/_lib/hubspot-consent-state.mjs` and nowhere else.

### SMS current state — `SMS_STATE_PROPERTIES`

| Application field | HubSpot internal name | Type |
|---|---|---|
| `sms.status` | `cst_sms_permission_status` | enumeration |
| `sms.consent_at` | `cst_sms_consent_at` | datetime |
| `sms.consent_phone` | `cst_sms_consent_phone` | string |
| `sms.consent_source` | `cst_sms_consent_source` | string |
| `sms.consent_page` | `cst_sms_consent_page` | string |
| `sms.consent_version` | `cst_sms_consent_copy_version` | string |

### AI voice current state — `AI_VOICE_STATE_PROPERTIES`

The same six fields against `cst_ai_voice_permission_status`,
`cst_ai_voice_consent_at`, `cst_ai_voice_consent_phone`,
`cst_ai_voice_consent_source`, `cst_ai_voice_consent_page`,
`cst_ai_voice_consent_copy_version`.

### Suppression — `SUPPRESSION_PROPERTIES` — **read only, in this phase and by design**

`cst_sms_suppressed`, `cst_sms_suppressed_at`, `cst_sms_suppression_reason`,
`cst_do_not_call`, `cst_do_not_call_at`, `cst_do_not_call_reason`,
`cst_do_not_contact`, `cst_do_not_contact_at`, `cst_do_not_contact_reason`.

### Re-opt-in request — `REOPTIN_PROPERTIES`

`cst_reoptin_requested_at`, `cst_reoptin_requested_channel`.

Six plus six plus nine plus two is 23.

`PERMISSION_STATUS_VALUES` is `never_granted`, `granted`, `revoked`,
`suppressed`. `REOPTIN_CHANNEL_VALUES` is `sms`, `ai_voice`, `both`.

The module also records `HUBSPOT_SUPPRESSION_VOCABULARY` — the three
suppression-reason dropdowns' accepted values — explicitly **unused**. It is
written down because `api/_lib/consent.mjs` has its own internal
`SUPPRESSION_REASON` constants that classify *events* (`voice_dnc`,
`global_dnc`, `stop_keyword`, …), several of which are not valid values for
these HubSpot dropdowns. A future suppression-writing phase must map internal
classifications onto these lists explicitly and must never pass an internal
constant straight through.

---

## 4. Read semantics

`findContactByEmail()` now requests `["email", ...consentPropertiesToRead()]`
and returns `{ id, consent }`.

- **Feature off:** `consentPropertiesToRead()` returns `[]`, the request body
  is byte-identical to the one this endpoint has always sent, and `consent`
  is `null`.
- **Feature on:** the 23 properties come back and are parsed by
  `fromHubSpotConsentProperties()`.

Parsing rules that matter:

- **Booleans are strings.** HubSpot returns `"true"` / `"false"`, sometimes
  real booleans. `Boolean("false")` is `true`, which would read a cleared
  suppression as an active one, so string truthiness is never used.
- **Blank is `false` / `never_granted`.** An unset HubSpot boolean genuinely
  means "not suppressed", and an unset status genuinely means "no permission
  recorded". That is the ordinary case for almost every contact.
- **Anything else nonblank fails** — see §4a.
- **Suppression is read from both directions** — an explicit flag *and* a
  channel status of `suppressed`.
- **`cst_do_not_contact` suppresses both channels.**

### 4a. Failing closed on state that cannot be understood

Three separate ways an unreadable answer used to become a confident one, all
now closed. The rule behind all three: **when the code cannot truthfully say
what a contact's consent state is, it fails the HubSpot operation rather than
answering.** A manufactured conclusion about consent is indistinguishable from
a real one once it has been written to a contact.

| Case | Old behaviour | New behaviour |
|---|---|---|
| A found contact's response has no usable `properties` object | `hit.properties \|\| {}` → an invented empty state | `HUBSPOT_CONSENT_STATE_MALFORMED_RESPONSE` |
| A suppression flag holds something other than `true`/`false`/blank | read as `false` — *not suppressed* | `HUBSPOT_CONSENT_STATE_MALFORMED_VALUE` |
| A permission status holds a nonblank value outside the four | normalised to `never_granted` | `HUBSPOT_CONSENT_STATE_MALFORMED_VALUE` |

**Malformed response.** `requireConsentProperties(properties, stage)` requires
a non-null, non-array object. `findContactByEmail()` applies it to the search
hit (stage `SEARCH`) and `readConsentState()` to the 409 refetch (stage
`READ`). "HubSpot said nothing" and "HubSpot said this contact has never
granted anything" are different facts and no longer share a representation.

A **genuinely new** contact — one the search did not find — still uses
`emptyConsentState()`. That is not a guess: no record exists.

**Malformed value.** `"banana"`, `"yes"`, `"1"`, `"0"`, `{}` and `[]` are not
ways of saying "not suppressed". Note `[]` specifically: `String([])` is `""`,
so an empty array would have slipped through a blank check — non-string,
non-boolean values are now rejected before any stringification. For the
permission enum, normalising an unknown value to `never_granted` was the
dangerous direction: a fresh grant would then overwrite whatever it actually
meant. Surrounding whitespace is still tolerated — `" granted "` is `granted`.

**The errors carry the property name, never the value.** A mis-mapped CRM
field can hold anything, up to and including another person's details, so no
malformed value reaches an error message or a log line. `api/_lib/hubspot.mjs`
logs `hubspot.consent_state_invalid` with the token, the property name and the
operator action required; the submission fails and the visitor is told so.

### Suppression precedence

A flag beats a status **in one direction only**: it can make a channel
suppressed, it can never un-suppress one. So if `cst_sms_suppressed` is true
while `cst_sms_permission_status` still reads `granted` — entirely possible,
because a webhook could set the flag and a stale process leave the status
behind — the conservative reading wins and the channel is treated as
suppressed.

**The disagreement is interpreted, never repaired.** Nothing in this phase
writes a correction back. "Self-healing" a suppression conflict during an
ordinary form submission is precisely how a STOP would get quietly cleared.

`emptyConsentState()` is the state of a contact HubSpot has never seen. It is
reached only when there is genuinely no contact — never as a stand-in for "we
did not look".

---

## 5. Write semantics

`toHubSpotConsentProperties(nextState, evidence)` translates the output of
`applySubmissionConsent()` into the minimal property set.

1. **Only a channel that actually became `granted` on this submission is
   written.** `applySubmissionConsent()` marks that with `changed: true`. An
   unticked box yields `outcome: "no_new_consent"` and `changed: false`, so
   nothing is emitted and a previous consent cannot be blanked by a later
   silent submission.
2. **The two channels are independent.** SMS becoming granted never emits an
   AI-voice property, and the reverse.
3. **A pending re-opt-in writes only the two re-opt-in properties.** It does
   not grant, and it does not touch a suppression. When both channels are
   pending, the channel value is `both`.
4. **No suppression property is ever emitted, on any path.**
5. Enum values are checked against the accepted vocabularies before the
   request is built. HubSpot rejects an unknown enum with a 400, which would
   fail the lead; `assertConsentEnum()` throws
   `HUBSPOT_CONSENT_ENUM_REJECTED` first, loudly, rather than letting a
   malformed write reach the API.
6. **A grant is never written without a valid timestamp.** See §7a.

Each granted channel writes status, timestamp, phone, source (the form type),
page, and copy version — the same six values the timeline evidence carries.

`toHubSpotConsentProperties(nextState, evidence)` takes exactly two arguments.
`granted` is a literal in the one branch that writes a status; there is no
parameter and no branch that can make it anything else.

An earlier revision of this phase gave the function a third `opts` argument
with a `forceStatus` seam, present only so a test could push an invalid status
through the enum guard. **It has been removed.** Production code should not
carry an override of the transition result for a test's benefit — a parameter
that lets a caller name the permission status is not something consent-writing
code should own, whatever the comment above it says, and any production caller
could have reached for it. The guard is now tested directly through the
exported pure validator `assertConsentEnum(property, value, allowed)`, and a
test asserts both that the function's arity is 2 and that a third argument
cannot influence what is written.

### Where the write happens

The consent properties are merged into the *same* PATCH or POST that carries
the ordinary lead properties. A second write would be a second chance to
half-succeed for no benefit.

- **Existing contact:** one PATCH with `toContactProperties(payload)` plus the
  folded consent changes.
- **New contact:** one POST, folding into `emptyConsentState()`.
- **409 conflict:** see §6.

### Phone binding

Consent is bound to the number given at the time. `consent_phone` records the
normalised phone from that submission. A later submission from the same email
with a different number re-grants against the new number and overwrites the
binding; it does not retroactively extend an old permission to a new number.

---

## 6. The 409 create-race

HubSpot returns 409 when a create collides with a contact that already exists
— one that appeared between our search and our create.

The previous code simply re-issued the write as an update. That is not safe
once consent is involved: **the racing contact's consent state has never been
read.** It may already carry a STOP, a DNC or a global do-not-contact, set by
a webhook, an import or a human seconds earlier.

So on the 409 path the code now performs a dedicated read
(`readConsentState(ref, { byEmail })` — a GET for the 23 properties, by id
when HubSpot supplied one, otherwise by email) and **recomputes the transition
against the actual state of the contact that now exists**, not against the
empty state assumed a moment earlier.

Reusing that empty state would let a ticked box grant straight through a
suppression the process had simply not seen yet — the one outcome the whole
suppression model exists to prevent.

The existing `hubspot.create_conflict_resolved` log line gains
`consent_state_refetched`. With the feature off no extra request is made and
the flag is `false`.

---

## 7. Datetime format

The six `*_at` properties are genuine HubSpot `datetime` properties, verified
in the portal — not date-only pickers.

**Chosen format: ISO-8601 via `Date#toISOString()`**, e.g.
`2026-09-09T14:32:07.145Z`.

HubSpot `datetime` properties accept either an ISO-8601 string of the form
`yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` or UNIX epoch milliseconds. The midnight-UTC
constraint that is widely cited applies to `date` properties, which these are
not.

ISO-8601 was chosen over epoch milliseconds deliberately: `meta.submitted_at`
is already exactly that string, so the property value and the `SMS CONSENT AT`
row in the timeline evidence are byte-identical and can be compared without
converting anything. It is also readable in a log.

`toHubSpotDateTime()` returns `""` for anything that is not a valid instant,
so a malformed value can never be sent as a date.

`toHubSpotDateTime()` **throws** `HUBSPOT_CONSENT_DATETIME_INVALID` for
anything that is not a valid instant, blank included. See §7a.

**Verification status — two different questions, answered differently.**

*Is ISO-8601 the right format?* **Verified against HubSpot's primary CRM
Properties documentation.** It states that a `datetime` property stores date
**and** time, that API values are UTC, that a value may be supplied either as
an ISO-8601 string or as UNIX epoch milliseconds, and that its ISO-8601
example carries the complete timestamp with the trailing `Z`. It also places
the midnight constraint on *date-only* values supplied as epoch timestamps —
not on `datetime` properties. An earlier draft of this document recorded the
format as confirmed only from secondary sources because
`developers.hubspot.com` was unreachable from the build environment; that
limitation no longer stands and is not the project's conclusion.

*Does the Crystal Sells Toledo portal retain a non-midnight time on these six
properties?* **Not tested.** Nobody has written a value with a real time to
one of the six `*_at` properties, reloaded the record, and confirmed the time
survived. That is a portal-behaviour question, not a format question, and it
remains open — see §10 and §11.

### 7a. An invalid timestamp throws

`toHubSpotDateTime()` previously returned `""` for anything it could not
parse. That made this contact state reachable:

```
cst_sms_permission_status = granted
cst_sms_consent_at        = ""
```

A grant with no record of when it was given — worse than no grant at all,
because it looks complete. These timestamps are server-owned invariants, not
decoration.

It now throws `HUBSPOT_CONSENT_DATETIME_INVALID` for anything that is not a
valid instant, **blank included**, naming the property and never the value.
The throw happens while the property object is still being built, so nothing
is sent: the request under construction is discarded along with it. The same
rule covers `cst_reoptin_requested_at`.

---

## 8. Static guards (`tools/check.mjs`)

Three new checks, run by `npm run check` and therefore by CI:

1. `api/_lib/hubspot.mjs` must contain **no** `cst_` name. Scattering the
   schema back into the HTTP layer is how a contract drifts from the portal it
   describes.
2. `api/_lib/hubspot-consent-state.mjs` must declare **exactly 23** distinct
   `cst_` names. A 24th means somebody invented a property; a 22nd means one
   was dropped.
3. The body of `toHubSpotConsentProperties()` must not reference
   `SUPPRESSION_PROPERTIES.smsSuppressed`, `.doNotCall` or `.doNotContact` —
   the mechanical proof that an ordinary form submission cannot write a
   suppression.

---

## 9. Test results

Run locally on this branch:

| Suite | Result |
|---|---|
| `npm run test:consent-state` (new) | **54 passed, 0 failed** |
| `npm run test:consent` | **59 passed, 0 failed** |
| `npm run test:hubspot` | **91 passed, 0 failed** |
| `npm run test:unit` | **97 passed, 0 failed** |
| `npm run test:mail` | **36 passed, 0 failed** |
| `npm run test:browser` | **103 passed, 0 failed** |
| `npm run check`, flag off | 10 pages, 0 errors |
| `npm run check`, flag on | 11 pages, 0 errors |

The 54 new tests cover: feature-off equivalence (no consent properties
requested, none written); the read adapter (blank → `never_granted`, `"false"`
must not parse as true, suppression flags overriding a stale `granted`, global
DNC suppressing both channels); grants (channel isolation, ISO timestamp,
phone/version/source/page carried); unticked-box semantics (nothing written,
prior consent preserved); suppression survival across a submission; re-opt-in
for `sms`, `ai_voice` and `both`; phone binding; the 409 race (a suppression
discovered only after the conflict is preserved); failure semantics; and the
23-name schema contract.

The hardening pass added tests for: a search hit with no `properties`, with
`properties: null` and with `properties: []`; a 409 refetch with no
`properties` and with a malformed one; that **no contact is written and no
form submitted** when a response is malformed; that a nonblank uninterpretable
boolean or permission status throws rather than reading as false /
`never_granted`; that an error carries the property name and not the value;
that an invalid or blank timestamp throws; that a granted status cannot be
written without a valid timestamp; that `assertConsentEnum` rejects
out-of-vocabulary values; and that no caller can override the status a grant
writes.

All HubSpot requests in the tests are stubbed. **No production contact was
read or modified, and no production form was submitted.**

Per the repository testing policy the full suite belongs to CI; it runs on the
pull request.

---

## 10. Known limitations — stated as unproven

- **No live HubSpot call has been made by this phase.** Every test uses a
  stubbed fetch. "Tests pass" does not mean "this works against the real
  portal".
- **Non-midnight datetime retention is untested against this portal.** The
  ISO-8601 format is verified against HubSpot's primary documentation (§7),
  but nobody has written a value with a real time to one of the six `*_at`
  properties on the Crystal Sells Toledo portal, reloaded the record and
  confirmed the time survived. Until that is done, "these are datetime
  properties" is a portal setting that has been read, not a behaviour that has
  been observed.
- **There is no transaction** across the HubSpot Contacts API and the Forms
  API. The current-state write and the timeline evidence are separate
  requests, so a partial write is possible. It is never hidden: a failure
  fails loudly, per the repository rule that a contact saved without its
  enquiry block is worthless.
- **Nothing recovers a contact whose stored consent state is malformed.** The
  code now refuses to interpret it, which fails that contact's submissions
  until a human corrects the property in the portal. That is deliberate — the
  alternative is a silent wrong answer — but it does mean a single bad CRM
  field blocks a lead, and the log line is the only signal.
- **Suppression conflicts are interpreted, not repaired.** A contact whose
  flag and status disagree stays that way until a human or a future phase
  fixes it. That is deliberate.
- **Nothing enforces the permission decision at send time yet,** because
  nothing sends. `canSendSms()` and `canPlaceAutomatedVoiceCall()` exist and
  are tested, but no Twilio or Retell integration calls them.
- Ohio and federal messaging obligations are not asserted here. This document
  describes what the code does; it makes no claim of TCPA compliance or legal
  sufficiency.

---

## 11. What a human must still do before this can be enabled

In order:

1. **Merge this pull request.** It is deliberately left unmerged.
2. **Deploy with the feature still off** and confirm the live site is
   unchanged — no checkbox, no privacy messaging section, no consent
   properties in any HubSpot request.
3. **Write a non-midnight timestamp** to one of the six `*_at` properties on a
   scratch contact, reload it, and confirm the time survived. Record the
   result in `docs/updates/2026-09-09-hubspot-consent-setup.md` §6a.
4. **Only then** set `COMMUNICATIONS_CONSENT_ENABLED=true` in
   Vercel → Project → Settings → Environment Variables → **Production**, and
   redeploy.
5. Re-run the §6 verification in the setup document against a real submission.

Nothing in steps 3–5 has been done. The feature is off and this phase did not
turn anything on.
