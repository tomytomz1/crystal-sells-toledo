# HubSpot datetime round-trip verification — production portal

**Date of test:** 9 September 2026
**Portal:** Crystal Sells Toledo (production HubSpot)
**Performed by:** the site operator, manually, in the HubSpot UI
**Result: PASS**

This closes the last outstanding verification step from
`docs/updates/2026-09-09-hubspot-consent-setup.md` §6 — the one that gated
turning the communications-consent feature on.

**`COMMUNICATIONS_CONSENT_ENABLED` remains OFF and absent from Vercel
Production.** This test changed nothing about that. See §6 below.

---

## 1. What question this answers, and what it does not

Two separate questions have been confused before, so they are kept apart here.

| Question | Answer | Evidence |
|---|---|---|
| Does the HubSpot CRM API support writing a date **and time** to a `datetime` property? | Yes | HubSpot's official CRM Properties documentation: a `datetime` property stores date and time, API values are UTC, and a value may be supplied as an ISO-8601 string or as UNIX epoch milliseconds. The midnight constraint applies to *date-only* values supplied as epoch timestamps. |
| Does **this** production portal actually retain a non-midnight time on **this** property across save and reload? | Yes | The controlled UI round-trip recorded below. |

The first is a statement about HubSpot. The second is a statement about the
Crystal Sells Toledo portal. Neither substitutes for the other, and both are
now independently supported.

---

## 2. Method

A **controlled UI round-trip test of the production HubSpot portal**. A value
was typed into the property on a contact record through the HubSpot user
interface, the page was fully reloaded, the value was read back, and the
property was then returned to its original state.

It was **not** an API write, and it was **not** a website form submission. No
lead was created, no form was submitted, and no application code ran.

| | |
|---|---|
| Designated test contact | Tomas Beltran — a contact belonging to the operator, used deliberately as the test subject |
| Property (internal name) | `cst_sms_consent_at` |
| Property (visible label) | SMS consent captured at |
| Property type as configured | Date and time picker |
| Original value | blank |

---

## 3. Result

| Step | Observed |
|---|---|
| Value entered in the HubSpot UI | `09/09/2026 2:30 PM CDT` |
| Contact page fully reloaded | — |
| Value after reload | `09/09/2026 2:30 PM CDT` |
| **Round trip** | **PASS** |
| Property then cleared back to its original state | — |
| Contact page reloaded again | — |
| Final value | blank / `--` |
| **Restoration** | **PASS** |

The non-midnight time component survived save and reload. Specifically, it did
**not**:

- collapse to midnight,
- become date-only, or
- lose the time component.

`2:30 PM CDT` is `19:30 UTC` — non-midnight in both the operator's display
timezone and the UTC instant the property stores, so neither reading of the
result is ambiguous.

No other property was intentionally modified. The contact was left in its
original state.

---

## 4. What this proves, precisely

This test proves that **this production portal's custom Date-and-time-picker
property preserves a non-midnight datetime for `cst_sms_consent_at`.**

It does **not** claim that every datetime property was individually live-tested.
The other five timestamp properties —

- `cst_ai_voice_consent_at`
- `cst_sms_suppressed_at`
- `cst_do_not_call_at`
- `cst_do_not_contact_at`
- `cst_reoptin_requested_at`

— use the **same** HubSpot datetime property type, whose behaviour is what this
test exercised, and their type was independently verified against the
specification when they were created on 9 September 2026. But they were **not
individually written during this test**. Nobody typed a value into them,
reloaded, and read it back.

That is a deliberate limitation of scope, not an oversight: the property type
is the thing that could have been wrong (a date-only picker silently
truncating the time), and the type is shared. If a future change recreates one
of those five properties, its type has to be checked again — this document does
not cover it.

---

## 5. Why this mattered enough to test

`api/_lib/hubspot-consent-state.mjs` serialises consent timestamps as full
ISO-8601 instants, and `api/_lib/hubspot.mjs` writes them to these properties.
If a property had turned out to be a plain Date picker, every consent timestamp
would have silently collapsed to midnight on save — and the damage would only
have been visible after real consent had been captured, by which point the
collected timestamps would be unrecoverable.

`docs/updates/2026-09-09-hubspot-consent-setup.md` §6 required this check to
happen **before any consent is captured**. It has now happened, before the
feature is enabled and before any visitor has been shown a tick box.

---

## 6. Feature status — unchanged by this test

- **`COMMUNICATIONS_CONSENT_ENABLED` remains OFF / absent from Vercel
  Production.**
- **The communications consent UI is still not active.** No visitor sees a tick
  box on any form; the published privacy policy carries no messaging section.
- **No consumer SMS or AI voice functionality is active.** No Twilio number
  sends, no Retell agent calls, no A2P campaign is registered, and nothing in
  the deployed code sends or calls.

Merging the Phase 2 wiring (`3c98607`) did not turn anything on, and neither did
this test.

---

## 7. Still outstanding

This test does **not** close §6a of the setup document. That section asks a
different set of questions — about the **timeline activities** that hold the
per-submission consent evidence, not about these contact properties:

1. whether the HubSpot UI displays the full enquiry block or truncates it,
2. what the portal's activity-retention policy actually is, and
3. whether a form-submission activity can be altered or deleted by an admin or
   a bulk tool.

Those remain unanswered, and until they are written down the evidence
architecture is verified in code and unverified in practice.

---

## 8. Source of record

The observations in §2 and §3 were reported by the operator who performed the
test in the HubSpot UI, and are recorded here as reported. Nothing in this
document was measured by the repository's automated tests, which cannot reach
the production portal, and no automated verification of this round trip exists
or is possible from CI.
