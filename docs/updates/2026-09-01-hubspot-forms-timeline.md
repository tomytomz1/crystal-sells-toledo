# Website enquiries now land on the HubSpot Contact timeline — 1 September 2026

Repo `tomytomz1/crystal-sells-toledo`, branch
`claude/crystal-perrysburg-realtor-site-so38qa`.

**Implemented and tested. NOT production-proven.** No call has been made to the
real HubSpot portal. Section 8 is the verification a human still has to perform.

---

## 1. Context, for a reader with no repo access

`crystalsellstoledo.com` is a lead-generation site for **Crystal Saylor**, a
REALTOR® with **Key Realty LTD** in Toledo, Ohio. Static HTML built by a Node
script, deployed on Vercel, with one serverless function at `POST /api/lead`
that validates website enquiries and writes them into **HubSpot**.

Authentication is a **2026 HubSpot Service Key**, now carrying:

```
crm.objects.contacts.read
crm.objects.contacts.write
forms
```

### The problem this closes

Crystal could not see each seller enquiry as its own dated entry on a contact's
activity timeline. Enquiries were appended into the contact's `message`
property — durable, but not an activity, not timestamped, and unreadable at
length in a sidebar field.

The obvious fix — a HubSpot **Note** per submission — is impossible here. The
Service Key scope picker exposes **no engagement object at all**: no notes,
tasks, calls, emails or meetings. That was confirmed in the live account.

The decision recorded in `docs/updates/2026-09-01-timeline-architecture-decision.md`
was to use the **HubSpot Forms Submission API**, which produces HubSpot's own
native `Form submitted` activity. This pass implements it.

---

## 2. What changed, file by file

```
EDIT  api/_lib/hubspot.mjs       form submission; summary; three-var config
EDIT  api/_lib/description.mjs   restored the summary view (one row list, two views)
EDIT  tools/check.mjs            Forms conformance guards
EDIT  tests/hubspot.test.mjs     rewritten for the new contract (90 tests)
```

Untouched: `api/lead.js`, validation, limits, honeypot, rate limiting, origin
checking, attribution, submission ids, the address mapping, the success panel,
Google Places autocomplete and Google Analytics.

### 2.1 Delivery is two writes, both mandatory

```
1. validate                       (unchanged)
2. Contacts API: search by email, then update or create   (the proven path)
3. Forms API:    submit the same enquiry                  (the timeline activity)
4. 200 { ok:true } only when BOTH succeeded
```

Contact first, because that is the path already proven in production and because
a 409 conflict is folded into an update there, which is what keeps a repeat
submission from ever becoming a second contact. HubSpot matches the form
submission to that contact by email.

### 2.2 The form submission

```
POST https://api.hsforms.com/submissions/v3/integration/secure/submit/{portalId}/{formGuid}
Authorization: Bearer <HUBSPOT_ACCESS_TOKEN>
```

The **authenticated** endpoint, using the Service Key. The unauthenticated
variant would also work, but authenticating means the portal id and form guid
are not the only thing between a stranger and Crystal's CRM, and it carries
higher rate limits.

Body:

```json
{
  "submittedAt": "<epoch ms from the server-side submission time>",
  "fields": [
    { "objectTypeId": "0-1", "name": "email",     "value": "..." },
    { "objectTypeId": "0-1", "name": "firstname", "value": "..." },
    { "objectTypeId": "0-1", "name": "lastname",  "value": "..." },
    { "objectTypeId": "0-1", "name": "phone",     "value": "..." },
    { "objectTypeId": "0-1", "name": "address",   "value": "..." },
    { "objectTypeId": "0-1", "name": "message",   "value": "<all 23 rows>" }
  ],
  "context": { "pageUri": "https://www.crystalsellstoledo.com/...", "pageName": "..." }
}
```

- `email` is **always** sent — it is the dedupe key and the form requires it.
- `firstname` and `lastname` are sent when present.
- `phone` and `address` are **omitted when blank**, never sent as `""`. A form
  submission *sets* the properties it carries, so an empty string would blank a
  value HubSpot already holds. Same rule the CRM write follows.
- `message` carries the complete deterministic 23-row block, including the
  submission id and every attribution field.
- **Exactly those six field names, and no others.** HubSpot validates a
  submission against the form definition and rejects anything carrying a field
  the form does not define, so `FORM_FIELDS` is a contract with the portal, not
  a preference. A check fails the build if it drifts.
- `pageUri` / `pageName` go in **`context`**, which is metadata rather than form
  fields, so page information is captured without touching the form definition.
- `hutk` is deliberately absent. It is a browser cookie set by HubSpot's
  tracking script, which this site does not load; inventing one would corrupt
  attribution rather than improve it.

### 2.3 `message` on the contact is now a concise summary

The contact's `message` property carries a **short summary of the latest
enquiry** — form type, property address, selling timeline, condition, topic and
the visitor's own words — and is **replaced** on each submission rather than
appended to.

That is only safe because the timeline now holds every submission in full and
dated. Both were shipped in the same commit, deliberately: replacing the
accumulation before the Forms write was mandatory and tested would have
destroyed enquiry history with nothing holding it.

Both views come from **one row list** in `api/_lib/description.mjs`, so the
summary and the full block cannot drift apart.

**One consequence to watch in the live test.** A HubSpot form submission sets
the contact properties it carries, and the submission carries the full 23-row
block in `message`. Since the form write happens *after* the CRM write, HubSpot
will most likely leave `message` holding the **full latest block** rather than
the short summary. That is harmless — the unbounded accumulation is gone either
way, and the timeline holds the history — but it is not what the summary was
designed to show. If the live test confirms it and you want the concise version
to win, it is one small property write after the form submission. I did not add
that pre-emptively: it is another call and another failure mode, and I cannot
confirm the behaviour without a live submission.

### 2.4 Configuration now requires three variables

```js
export function isConfigured() {
  return Boolean(process.env.HUBSPOT_ACCESS_TOKEN && portalId() && formGuid());
}
```

The form submission is a mandatory half of delivery, so a missing portal id or
form guid means the enquiry cannot be recorded on the timeline. Refusing up
front with `503 NOT_CONFIGURED` is honest; accepting the lead and silently
skipping the activity is not.

### 2.5 Failure semantics

| HubSpot says | Error | Visitor sees |
|---|---|---|
| form 400 | `HUBSPOT_FORM_REJECTED` | 502 + recovery panel |
| form 401 / 403 | `HUBSPOT_FORMS_SCOPE_OR_AUTH_<status>` | 502 + recovery panel |
| form 429 | `HUBSPOT_FORM_RATE_LIMITED` | 502 + recovery panel |
| form 5xx | `HUBSPOT_FORM_SERVER_<status>` | 502 + recovery panel |
| form 200, unusable body | `HUBSPOT_FORM_MALFORMED_RESPONSE` | 502 + recovery panel |
| contact 4xx/5xx | `HUBSPOT_<SEARCH\|CREATE\|UPDATE>_*` | 502 + recovery panel |

A 400 is almost always the form definition disagreeing with what was submitted,
so it is logged with the exact expected field list. A 401/403 is logged with the
scope remediation. **No HubSpot response body is ever attached to an error** —
HubSpot echoes submitted values in validation errors, which would put lead PII
into the logs.

The malformed-response rule is deliberately strict: a 200 whose body is not a
JSON object is treated as a failure. A false failure shows the recovery panel
and the visitor phones instead; a false success loses a lead silently. If the
live test shows the submission arriving in HubSpot while the endpoint reports
`HUBSPOT_FORM_MALFORMED_RESPONSE`, that is the knob to loosen.

### 2.6 Partial writes — stated, not pretended away

There is **no transaction** across the CRM API and the Forms API. If the contact
write succeeds and the form submission fails, HubSpot is left holding the
contact — name, email, phone, address, `message` — with **no timeline activity**,
and `/api/lead` returns 502, so nobody is told the enquiry landed.

A resubmit finds the same contact by email and updates it — **never a duplicate**
— and submits the form again. Every submission carries its own `submission_id`,
so a resubmit is a genuinely distinct submission and two activities is the honest
record of two attempts. HubSpot offers no idempotency key on form submission, so
**at-least-once** is the real guarantee.

---

## 3. The resulting contract

### Endpoint — UNCHANGED

```
POST /api/lead     JSON only · 16 KB cap · same-origin
200  { "ok": true,  "submission_id": "csv_<24 hex>" }
4xx  { "ok": false, "code": "...", "message": "..." }
```

Same status codes, same error codes, same response shapes.

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
| `message` | concise latest-enquiry summary | replaced each time (see 2.3) |

### Environment variables

| Variable | Required | Value |
|---|---|---|
| `HUBSPOT_ACCESS_TOKEN` | **yes** | the Service Key |
| `HUBSPOT_PORTAL_ID` | **yes** | `247240486` |
| `HUBSPOT_FORM_GUID` | **yes** | `536a356d-d854-49ec-b204-b76e591cecaa` |
| `HUBSPOT_API_BASE` | no | `https://api.hubapi.com` |
| `HUBSPOT_FORMS_BASE` | no | `https://api.hsforms.com` |
| `ALLOWED_ORIGINS` | no | — |
| `GOOGLE_MAPS_API_KEY` | no | address autocomplete |

Scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `forms`.

### The HubSpot form

`Crystal Sells Toledo — Website Seller Inquiry`, published, defining exactly
`email` (required), `firstname`, `lastname`, `phone`, `address`, `message`.

---

## 4. Test results

```
npm test  →  build + check + 199 tests, 199 passing, 0 failing
```

Up from 179. `tests/hubspot.test.mjs` contributes 90.

Every case the brief required is covered:

```
authenticated /secure/submit/ endpoint on api.hsforms.com     covered
Bearer auth uses HUBSPOT_ACCESS_TOKEN                          covered
portal id and form guid come from the environment              covered
exactly the six allowed form property names                    covered
email always included                                          covered
blank phone and address omitted                                covered
complete 23-row block in message                               covered
submittedAt is the server-side time in epoch ms                covered
page context never becomes a form field                        covered
contact written BEFORE the form is submitted                   covered
Contacts API success + Forms failure = endpoint failure        covered
form 400 / 401 / 403 / 429 / 5xx = endpoint failure            covered
malformed form response (non-JSON, empty, array)               covered
repeat email = one contact, two distinct submissions           covered
409 conflict path still submits its activity                   covered
retry after a form failure does not duplicate the contact      covered
no token or PII leakage (logs, errors, responses, bundle)      covered
Street Address mapping intact                                  covered
success-panel UX intact                                        covered
```

### Negative testing — 20 of 20 caught, zero no-ops

```
unauthenticated form endpoint used                       CAUGHT
form submission unauthenticated (bearer dropped)         CAUGHT
portal id hardcoded instead of read from env             CAUGHT
form guid hardcoded instead of read from env             CAUGHT
a seventh field the form does not define                 CAUGHT
FORM_FIELDS drifts from the form definition              CAUGHT
email submitted conditionally                            CAUGHT
blank phone submitted (would erase the stored phone)     CAUGHT
blank address submitted (would erase the stored address) CAUGHT
summary submitted instead of the full 23-row block       CAUGHT
submittedAt dropped (activity dated on ingest)           CAUGHT
page context leaked into the form fields                 CAUGHT
form submission skipped entirely                         CAUGHT
form failure swallowed as best-effort                    CAUGHT
form submitted before the contact exists                 CAUGHT
malformed form response accepted as success              CAUGHT
isConfigured no longer requires the form guid            CAUGHT
contact message accumulates again                        CAUGHT
summary carries tracking rows it should not              CAUGHT
Notes API reintroduced (no scope for it)                 CAUGHT
```

### What the tests do NOT prove

Every test runs against a **stubbed fetch**. They prove the client behaves
correctly against HubSpot's documented contract. They do not prove that the real
portal accepts the submission, that the form definition matches, or that the
activity renders on the timeline as expected. Only a live submission proves that.

---

## 5. The held Notes implementation

Commit `6286ab3` — one HubSpot **Note** per submission — is **not merged** and
**not deleted**. It is tagged **`hubspot-notes-fallback`** and retained as
historical and fallback work. If the Forms API disappoints, a private app
created before HubSpot disables legacy private app creation (26 October 2026 for
existing accounts) would make that commit shippable as a token swap.

---

## 6. What is NOT regressed

Explicitly preserved and still covered by tests: the standard `address` mapping,
the persistent success panel and its focus/scroll behaviour, Google Places
autocomplete via the Data API with the Perrysburg bias and independent
type-filter fallback, free-text address submission, Google Analytics 4
production-only gating, same-origin protection, the honeypot, the 16 KB body
limit, rate limiting, first-touch attribution, submission ids, no CRM credential
in the browser, no lead PII in logs, the shared form partial, and every
compliance guardrail in `CLAUDE.md`.

---

## 7. What a human must do before this deploys

**Nothing.** All three environment variables are already set in Vercel and the
form is published. Merging to `main` deploys it.

---

## 8. Production verification — NOT YET DONE

This is **not production-proven** until these pass.

**First submission**, through the homepage hero with a real address:

1. **Street Address** populated on the contact
2. phone / contact update correct
3. the persistent website success confirmation appears
4. a native **`Form submitted`** activity visible on the contact timeline
5. that activity contains the submitted enquiry

**Second submission, same email**, different message:

6. **one contact**, not two
7. **two separate `Form submitted` activities**, the first intact

If a submission fails, the Vercel function logs name the cause:

- `hubspot.forms_scope_or_auth` — the `forms` scope or the token
- `hubspot.form_rejected` — the form definition disagrees with the submitted
  fields; the log names the six expected
- `HUBSPOT_FORM_MALFORMED_RESPONSE` — see section 2.5; if the submission
  actually arrived in HubSpot, that check is too strict and I will loosen it

Also worth a glance: whether `message` on the contact ends up as the short
summary or the full block (section 2.3).

---

## 9. What is explicitly NOT done

- **Never run against the real portal.** Every test stubs HubSpot.
- **Not production-proven** until section 8 passes.
- **No Notes.** Not available to a Service Key; the implementation is retained
  as a tagged fallback only.
- **No lead notification.** A CRM record is not an alert; response time is still
  bounded by how often Crystal checks HubSpot.
- **`/contact` keeps its inline confirmation** — a single-step form, so the bug
  the success panel fixes does not occur there.
- No last-touch attribution; only first touch.
- Rate limiting is still per-instance memory.
- Zoho code remains in the repo, imported by nothing, as a rollback path.
