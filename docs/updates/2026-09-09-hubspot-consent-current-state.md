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
  suppression as an active one. `parseHubSpotBoolean()` compares the
  lower-cased trimmed string to `"true"`; anything unrecognised is `false`.
- **Blank status is `never_granted`,** and so is any value outside the four
  accepted ones.
- **Suppression is read from both directions** — an explicit flag *and* a
  channel status of `suppressed`.
- **`cst_do_not_contact` suppresses both channels.**

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
   fail the lead; `assertEnum()` throws `HUBSPOT_CONSENT_ENUM_REJECTED`
   first, loudly, rather than letting a malformed write reach the API.

Each granted channel writes status, timestamp, phone, source (the form type),
page, and copy version — the same six values the timeline evidence carries.

`toHubSpotConsentProperties()` accepts a third `opts` argument with a single
documented **test seam**, `forceStatus`, so a test can drive a value through
the enum guard that the transition layer would never produce. Production
callers pass two arguments and always write `granted`.

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

**How this was verified, and the limit of that verification.**
`developers.hubspot.com` is unreachable from the build environment (egress
policy), so the primary documentation page could not be fetched. The format
was confirmed from two independent secondary sources describing the current
CRM API behaviour, which agreed on both accepted forms and on the
`date`-versus-`datetime` distinction. **It was not confirmed against the live
API.** A live non-midnight write remains untested — see §10.

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
| `npm run test:consent-state` (new) | **38 passed, 0 failed** |
| `npm run test:consent` | **59 passed, 0 failed** |
| `npm run test:hubspot` | **91 passed, 0 failed** |
| `npm run test:unit` | **97 passed, 0 failed** |
| `npm run test:mail` | **36 passed, 0 failed** |
| `npm run test:browser` | **103 passed, 0 failed** |
| `npm run check`, flag off | 10 pages, 0 errors |
| `npm run check`, flag on | 11 pages, 0 errors |

The 38 new tests cover: feature-off equivalence (no consent properties
requested, none written); the read adapter (blank → `never_granted`, `"false"`
must not parse as true, suppression flags overriding a stale `granted`, global
DNC suppressing both channels); grants (channel isolation, ISO timestamp,
phone/version/source/page carried); unticked-box semantics (nothing written,
prior consent preserved); suppression survival across a submission; re-opt-in
for `sms`, `ai_voice` and `both`; phone binding; the 409 race (a suppression
discovered only after the conflict is preserved); failure semantics; and the
23-name schema contract.

All HubSpot requests in the tests are stubbed. **No production contact was
read or modified, and no production form was submitted.**

Per the repository testing policy the full suite belongs to CI; it runs on the
pull request.

---

## 10. Known limitations — stated as unproven

- **No live HubSpot call has been made by this phase.** Every test uses a
  stubbed fetch. "Tests pass" does not mean "this works against the real
  portal".
- **Non-midnight datetime retention is untested.** Nobody has written a value
  with a real time to one of the six `*_at` properties, reloaded the record
  and confirmed the time survived. Until that is done, "these are datetime
  properties" is a portal setting that has been read, not a behaviour that has
  been observed.
- **There is no transaction** across the HubSpot Contacts API and the Forms
  API. The current-state write and the timeline evidence are separate
  requests, so a partial write is possible. It is never hidden: a failure
  fails loudly, per the repository rule that a contact saved without its
  enquiry block is worthless.
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
