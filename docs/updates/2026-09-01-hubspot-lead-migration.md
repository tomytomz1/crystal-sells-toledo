# Lead backend migrated from Zoho CRM to HubSpot — 1 September 2026

Repo `tomytomz1/crystal-sells-toledo`, branch
`claude/crystal-perrysburg-realtor-site-so38qa`.

**Status: implemented and tested. NOT proven in production.** No call has ever
been made to a real HubSpot portal. Everything below is verified against
HubSpot's documented API behaviour and 141 automated tests, not against the
account itself.

---

## 1. Context, for a reader with no repo access

`crystalsellstoledo.com` is a lead-generation site for **Crystal Saylor**, a
REALTOR® with **Key Realty LTD** in Toledo, Ohio. Static HTML built by a Node
script, deployed on Vercel, with one serverless function at `POST /api/lead` that
validates website enquiries and writes them into a CRM.

That CRM was Zoho. It is now **HubSpot**. The governing rule is unchanged:

> No legitimate lead may be lost, and the site must never claim success unless
> the server actually accepted the lead.

Two forms feed the endpoint: `home_value` (`/home-value` and the homepage hero,
a two-step address-then-contact funnel) and `contact` (`/contact`).

### The constraint that shaped the whole design

The HubSpot token already provisioned in Vercel as `HUBSPOT_ACCESS_TOKEN` has
exactly two scopes:

```
crm.objects.contacts.read
crm.objects.contacts.write
```

That is deliberate least privilege, and this phase was required to work inside
it. In particular there is **no notes scope**, which removes the mechanism the
Zoho integration relied on. Section 3 is about what replaced it.

---

## 2. The research question, answered before any code was written

The brief was explicit: do not invent a property name, do not silently discard
the enquiry details, and if `contacts.read + contacts.write` cannot preserve the
full payload, stop and report the exact extra capability needed.

**Finding: no additional scope or custom property is required.**

HubSpot ships a **default contact property with the internal name `message`**.
HubSpot's own documentation describes it as being for "any message or comments
the contact may want to leave on a form". It is:

- **default** — present in every HubSpot portal, so it needs no schema scope to
  create and no `crm.schemas.*` scope to write
- **multi-line text** — it holds line breaks, so a structured block survives
- **writable** — it is an ordinary editable property, not a HubSpot-calculated
  or read-only one
- **large** — HubSpot's text property limit is 65,536 characters / 64 KB

The complete enquiry is written there. Nothing is dropped.

### What I could NOT verify, and why it matters

The above is from HubSpot's published documentation. **It has not been checked
against Crystal's actual portal**, because the token lives in Vercel and was
never available in the build environment. A portal admin *can* archive a default
property.

Rather than assume, the code detects that case explicitly and **fails the lead
loudly** rather than saving a contact with the enquiry silently missing. See
section 4.4. Confirming the property in the portal is one of the manual steps in
section 8.

---

## 3. What was wrong with a naive port, and what it would have cost

Three defects were found and fixed during this pass. Two of them would have
silently destroyed lead data — the failure mode that is hardest to notice,
because everything looks like it worked.

### 3.1 The property address would have been LOST

**Caught by a test, not by reading the code.**

The shared enquiry block (`api/_lib/description.mjs`) had 22 rows and did not
include the property address. It never needed to: under Zoho the address went
into the standard Lead field `Street`.

The HubSpot mapping is deliberately restricted to `email`, `firstname`,
`lastname` and `phone`. So on the day of the migration, a seller filling in the
home-value form would have had their **property address dropped entirely** — the
single most important field on a listing enquiry — and nothing would have looked
broken.

**Fix:** a `PROPERTY ADDRESS` row was added to the block, which is now 23 rows.
The block now stands alone regardless of which CRM is on the other end, which is
the property it should have had from the start.

### 3.2 A repeat submission would have ERASED the previous enquiry

With no notes scope, the obvious implementation — find the contact, PATCH the
`message` property — **overwrites** it. A seller who enquired in March and again
in June would have had their March message destroyed by the June one.

The Zoho design prevented exactly this with one Note per submission. That tool is
gone, so the equivalent had to be built inside the one writable property:

```
<newest enquiry, all 23 rows>

----- earlier submission -----

<previous enquiry, all 23 rows>
```

The search that finds the contact also reads its current `message`, and the new
block is prepended. Nothing a person said is ever overwritten.

Trimming engages only if the accumulated value would exceed 60,000 bytes
(HubSpot's ceiling is 65,536 characters / 64 KB). Then the **oldest** entries are
dropped — never the submission in hand — and the value ends with an explicit
`----- older submissions trimmed to fit the HubSpot property limit -----`.
Trimming is never silent. One maximal lead is about 13 KB, so this only engages
after several large repeat submissions from the same address.

### 3.3 A blank phone would have wiped a stored number

Sending `phone: ""` on an update blanks a number HubSpot already holds. A visitor
who gave a phone number the first time and skipped it the second would have lost
it. `phone` is now omitted rather than sent empty.

---

## 4. What changed, file by file

```
NEW   api/_lib/hubspot.mjs        the HubSpot client
NEW   tests/hubspot.test.mjs      66 tests for the delivery path
EDIT  api/lead.js                 imports the HubSpot client; 503 text updated
EDIT  api/_lib/description.mjs    + PROPERTY ADDRESS row (22 -> 23), CRM-neutral
EDIT  api/_lib/validate.mjs       comment only — limits deliberately unchanged
EDIT  tools/check.mjs             HubSpot conformance + least-privilege guards
EDIT  tests/api.test.mjs          secret scan extended to HubSpot names
EDIT  docs/PHASE-1-HANDOFF.md     sections 3, 4, 5, 6, 7, 9 rewritten
KEPT  api/_lib/zoho.mjs           untouched, imported by nothing
KEPT  tools/zoho-verify.mjs       untouched
```

### 4.1 `api/lead.js` — one line of substance

```js
import { createLead, isConfigured } from "./_lib/hubspot.mjs";
```

Everything else in the endpoint is unchanged: method allowlist, origin check,
16 KB body cap, rate limit, honeypot, validation, submission IDs, logging,
response shapes, and the refusal to report success on a delivery failure.

### 4.2 `isConfigured()` requires only the token

```js
export function isConfigured() {
  return Boolean(process.env.HUBSPOT_ACCESS_TOKEN);
}
```

A static check fails the build if any other `process.env.*` appears in that
function, so the least-privilege posture cannot drift.

### 4.3 Deduplication by email

1. `POST /crm/v3/objects/contacts/search`, filtering `email EQ <address>`, also
   requesting the current `message` so an update can append to it.
2. Found → `PATCH /crm/v3/objects/contacts/{id}`.
3. Not found → `POST /crm/v3/objects/contacts`.
4. If that create returns **409**, the existing id is parsed out of HubSpot's
   `Contact already exists. Existing ID: 123` message and the call becomes an
   update. If the id cannot be parsed, it falls back to the fully documented
   `PATCH /crm/v3/objects/contacts/{email}?idProperty=email`.

Step 4 exists because HubSpot's search index can lag a very recent write, while
HubSpot itself enforces email uniqueness on contacts. Without it, two submissions
in quick succession would surface as a failure to the second visitor. With it, a
repeat submission can never become a second contact.

### 4.4 The enquiry detail is never silently discarded

If HubSpot rejects a write with a 400 that names `message` as non-existent or
read-only, the code raises `HUBSPOT_DETAIL_PROPERTY_UNAVAILABLE`, the visitor
gets the recovery panel, and the log carries the exact remediation.

It deliberately does **not** retry without the property. That would save a
contact carrying a name and an email, with the address, timeline, condition,
message and every attribution field silently gone — and nothing to indicate
anything was missing. A visible failure that sends the visitor to the phone is
strictly better than a lead that looks captured and is hollow.

A test asserts the create is called exactly once in that scenario.

---

## 5. The resulting contract

### Endpoint — UNCHANGED

```
POST /api/lead     JSON only · 16 KB cap · same-origin

200  { "ok": true,  "submission_id": "csv_<24 hex chars>" }
4xx  { "ok": false, "code": "...", "message": "..." }
```

| Status | Code | Cause |
|---|---|---|
| 405 | `METHOD_NOT_ALLOWED` | anything but POST |
| 403 | `FORBIDDEN_ORIGIN` | Origin/Referer not allowlisted |
| 413 | `PAYLOAD_TOO_LARGE` | body over 16 KB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | non-JSON content type |
| 400 | `INVALID_JSON` | unparseable body |
| 400 | `REJECTED` | honeypot filled (server-side) |
| 422 | `MISSING_*` `INVALID_EMAIL` `FIELD_TOO_LONG` | validation |
| 429 | `RATE_LIMITED` | >5 per 10 min per IP |
| 503 | `NOT_CONFIGURED` | **`HUBSPOT_ACCESS_TOKEN` absent** (was: Zoho vars) |
| 502 | `DELIVERY_FAILED` | **HubSpot call failed** (was: Zoho) |

Only the two *causes* changed. No status code, no error code and no response
shape changed, so no client change was needed.

### Field limits — UNCHANGED

```
first_name 40 · last_name 80 · email 100 · phone 30
property_address 200 · topic 120 · timeline 120 · condition 120
message 4000 · notes 4000 · page 300 · form_type 32
landing_page 500 · referrer 500 · first_touch_at 40
utm_* 200 · gclid/gbraid/wbraid/fbclid/msclkid 300
```

These were set to Zoho's Lead maximums. HubSpot allows far more (65,536
characters), so they sit safely inside both and were left alone — relaxing them
would be a contract change for no gain. Overlength values are still **rejected
with 422, never truncated**.

### HubSpot contact properties

| Property | Source | Notes |
|---|---|---|
| `email` | form, lowercased | max 100, the dedupe key |
| `firstname` | form | max 40 |
| `lastname` | form | max 80 |
| `phone` | form, normalised | max 30, **omitted when blank** |
| `message` | the 23-row block | everything else |

### The 23-row enquiry block, blanks rendered as `-`

```
FORM · PROPERTY ADDRESS · SELLING TIMELINE · CONDITION · TOPIC · MESSAGE · NOTES ·
LANDING PAGE · CURRENT PAGE · REFERRER ·
UTM SOURCE · UTM MEDIUM · UTM CAMPAIGN · UTM TERM · UTM CONTENT ·
GCLID · GBRAID · WBRAID · FBCLID · MSCLKID ·
FIRST TOUCH · SUBMITTED · SUBMISSION ID
```

Every label is always emitted. "No UTM source" and "we stopped recording UTM
source" must not look identical six months from now.

### Environment variables

| Variable | Required | Default |
|---|---|---|
| `HUBSPOT_ACCESS_TOKEN` | **yes** | — |
| `HUBSPOT_API_BASE` | no | `https://api.hubapi.com` |
| `ALLOWED_ORIGINS` | no | — |

Scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`. **Nothing
more is required.**

Every `ZOHO_*` variable is **no longer read at runtime**. Leaving them set is
harmless; nothing consults them.

---

## 6. Test results

```
npm test

  Built 9 pages into public/
  9 pages checked — no errors, 2 warnings

  # tests      141
  # suites      19
  # pass       141
  # fail         0
```

Up from 75. `tests/hubspot.test.mjs` contributes 66, covering every case the
brief listed:

```
create new contact                              covered
update existing contact                         covered
duplicate email remains one contact             covered
409 conflict folded into an update              covered
HubSpot 401 / 403                               covered (both, x2 - throw + 502)
HubSpot 429                                     covered
HubSpot 5xx (500 / 502 / 503)                   covered
malformed HubSpot response                      covered (7 shapes)
missing token                                   covered (503, zero CRM calls)
lookup failure                                  covered
update failure                                  covered
create failure                                  covered
overlength fields                               covered (rejected pre-CRM)
honeypot                                        covered (zero CRM calls)
attribution preservation                        covered (end to end)
no secret leakage                               covered (6 tests)
```

The two build warnings are long-standing and unrelated: one meta description runs
7 characters over the 160 target, and 14 site images are still placeholders.

### Negative testing — 23 of 23 caught, zero no-ops

Every new guard was broken deliberately once, the suite confirmed to fail, then
restored. A guard that cannot fail is not a guard.

```
lead.js still imports the Zoho client                          CAUGHT
isConfigured demands a second credential                       CAUGHT
detail moved to an invented custom property                    CAUGHT
Notes API used despite having no notes scope                   CAUGHT
properties/schema API used despite having no schema scope      CAUGHT
email lookup removed - every submission would create a contact CAUGHT
409 conflict handling removed                                  CAUGHT
existing contact overwritten with a create instead of update   CAUGHT
PROPERTY ADDRESS row dropped from the block                    CAUGHT
detail property overwritten instead of appended                CAUGHT
trimming discards the newest submission instead of the oldest  CAUGHT
trimming happens silently, with no notice                      CAUGHT
a rejected detail property is retried without the enquiry body CAUGHT
malformed create response accepted as success                  CAUGHT
malformed search response accepted as no-match                 CAUGHT
429 no longer classified distinctly                            CAUGHT
401/403 no longer classified distinctly                        CAUGHT
5xx treated as an ordinary HTTP code                           CAUGHT
HubSpot response body pasted into the thrown error             CAUGHT
token name shipped in the browser bundle                       CAUGHT
browser bundle calls the HubSpot API directly                  CAUGHT
an extra unvetted property added to the contact map            CAUGHT
blank phone sent as an empty string, blanking a stored number  CAUGHT
```

### What the tests do NOT prove

Every HubSpot test runs against a **stubbed global fetch**. No network, no
portal, no token. They prove the client behaves correctly against HubSpot's
documented contract. They say nothing about whether Crystal's actual portal
accepts the payload. "Tested" and "working" remain different claims.

---

## 7. Security

- The token is read from `process.env` inside the client and sent only as an
  `Authorization: Bearer` header. It is never in a URL, a request body, a
  response, a log line, or an error message.
- **No HubSpot response body is ever attached to a thrown error.** HubSpot echoes
  submitted values back in validation errors, so a body pasted into an `Error`
  would put lead PII straight into the Vercel logs. Errors carry a stable token
  like `HUBSPOT_CREATE_HTTP_400` and nothing else. A test proves an error raised
  from a body containing an email and a name carries neither.
- Existing PII log redaction is unchanged: names, emails, phones, addresses and
  message bodies are logged as `present:<length>` or `absent`, never as values.
- Static checks fail the build if `HUBSPOT_ACCESS_TOKEN`, a bearer header,
  `api.hubapi.com` or a `pat-na*`-shaped string appears in anything delivered to
  the browser.

---

## 8. What a human must still do

**The migration is not finished until step 3 passes.**

1. **Confirm the `message` property exists.** HubSpot → Settings → Properties →
   Contact properties → search `message`. It should be **multi-line text** and
   not read-only. It is a HubSpot default, so it should already be there; this is
   confirming, not creating. If it has been archived, restore it — do not point
   the code at a different property name.

2. **Confirm `HUBSPOT_ACCESS_TOKEN` is set in Vercel** for the Production
   environment, then redeploy so the function picks it up.

3. **Submit a real lead and verify it.** This is the step that has never happened.
   - Submit through the homepage hero or `/home-value`.
   - Confirm the **success** panel appears, not the recovery panel.
   - In HubSpot, confirm one contact with `email`, `firstname`, `lastname`,
     `phone`, and a `message` carrying all 23 rows — **check the property address
     is there**, and the timeline, and the UTM rows.
   - Submit again with the **same email** and a different message. Confirm there
     is still **one** contact, and its `message` now holds **both** enquiries,
     newest first, separated by `----- earlier submission -----`.
   - Check the Vercel logs for `hubspot.contact.saved` with `action: "create"`
     then `action: "update"`.

4. **If anything fails**, check the Vercel function logs for
   `hubspot.detail_property_unavailable` (the `message` property is missing or
   read-only) or a `HUBSPOT_*_AUTH_401` / `_403` (token or scope problem).

---

## 9. What is explicitly NOT done

- **No live HubSpot call has been made.** The integration is unproven. 141
  passing tests describe behaviour against mocks and documented API semantics.
- **The `message` property has not been confirmed in Crystal's portal.** It is a
  HubSpot default and should be present; that is a documented expectation, not a
  verified fact about this account.
- **Zoho has not been removed.** `api/_lib/zoho.mjs` and `tools/zoho-verify.mjs`
  are intact and still tested, imported by nothing, kept as a rollback path.
  Deleting them is a later decision, after HubSpot has run in production.
- **No lead notification.** A CRM record is not an alert. Response time is still
  bounded by how often Crystal checks HubSpot.
- **No HubSpot-native features used** — no forms, no workflows, no lifecycle
  stage, no owner assignment, no associations to companies or deals. All of that
  needs scopes this token does not have.
- No last-touch attribution; only first touch is captured.
- Rate limiting is still per-instance memory, not a hard global ceiling.
