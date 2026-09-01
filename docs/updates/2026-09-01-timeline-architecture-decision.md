# How website enquiries reach the Contact timeline — research and decision — 1 September 2026

Repo `tomytomz1/crystal-sells-toledo`, branch
`claude/crystal-perrysburg-realtor-site-so38qa`.

**Research and decision only. No code was changed in this pass.** The
implementation is blocked on one human step (section 7).

---

## 1. Context, for a reader with no repo access

`crystalsellstoledo.com` is a lead-generation site for **Crystal Saylor**, a
REALTOR® with **Key Realty LTD** in Toledo, Ohio. Static HTML built by a Node
script, deployed on Vercel, with one serverless function at `POST /api/lead`
that validates website enquiries and writes them into **HubSpot**.

Authentication is a **2026 HubSpot Service Key**. Its available scopes are
limited to:

```
crm.objects.contacts.read
crm.objects.contacts.write
```

**Confirmed in the live HubSpot UI:** the Service Key scope picker does **not**
expose `crm.objects.notes.write`. The CRM section lists no engagement object at
all — no notes, tasks, calls, emails or meetings — despite listing obscure
objects such as `partner-clients` and `courses`.

### What is already live

Deployed at commit `04b45d4`:

- the seller's property address reaches HubSpot's standard, visible `address`
  field
- a successful submission replaces the form with a persistent confirmation panel

### What is written but held back

Commit `6286ab3` on the branch implements every submission as a HubSpot **Note**
associated to the contact. It is correct, tested (178 tests) and **not merged**,
because it requires `crm.objects.notes.write`, which this Service Key cannot be
granted. Deploying it would return 502 on every submission.

### What is still missing in production

Crystal cannot see each individual seller enquiry as its own dated entry on the
contact's activity timeline. Every enquiry is appended into the contact's
`message` property — durable, but not an activity, not timestamped, and
unreadable at length in a sidebar field.

---

## 2. The six options, investigated

### Option 1 — Service Keys obtaining Notes scopes by another route

**Not established. Do not rely on it.**

HubSpot's changelog states Service Keys are "available via Developer Platform
Projects version 2026.09 or later". That implies a project-based provisioning
route may expose a different scope set than the account-UI picker.

I could not find documentation confirming that a project-provisioned Service Key
can hold `crm.objects.notes.write`, and I have no access to the account to test.
Treating "maybe a different route exposes it" as a plan would be a guess.

**Verdict: unverified. Not a basis for a decision.**

### Option 2 — The newer developer-platform app model

**Technically yes, but disproportionate.**

HubSpot states all REST APIs are available via a private app access token or a
public app OAuth token, so a developer-platform app can hold
`crm.objects.notes.write`.

The cost is the whole OAuth apparatus: a developer account, an app definition, an
install flow, and access/refresh token lifecycle management in the serverless
function. That is precisely the machinery this project deliberately removed when
it migrated off Zoho — an extra credential to rotate, an extra failure mode, and
a token refresh path that can silently expire.

**Verdict: works, but heavy and wrong-sized for one agent's website.**

### Option 3 — A legacy private app

**Works today, and is being actively sunset. This is the trap.**

Private apps do support `crm.objects.notes.write`; it is the documented
requirement for the Notes API. The held commit would work unchanged with a
private app token — the client sends `Authorization: Bearer <token>`, so it is a
value swap in Vercel and nothing else.

But HubSpot is **permanently disabling creation of new legacy private apps**:
from **28 September 2026** for new accounts and **26 October 2026** for existing
accounts. Existing private apps keep working; new ones cannot be created.

Today is 1 September 2026. That leaves roughly eight weeks in which this account
could still create one.

HubSpot's own stated migration path for this use case is **Service Keys** — the
credential that cannot do notes. That is the gap this whole investigation sits in.

**Verdict: a working option with a closing window, and a dead end afterwards.**
Building the CRM's only activity mechanism on something that cannot be recreated
if the token is ever lost is a bad trade for a solo agent's site.

### Option 4 / Option 6 — The HubSpot Forms Submission API

**This is the answer.** Options 4 and 6 converge: the Forms API *is* the
supported API specifically intended to record a form submission on a contact's
timeline.

```
POST https://api.hsforms.com/submissions/v3/integration/submit/{portalId}/{formGuid}
```

- **No authentication, and therefore no scope.** The unauthenticated endpoint
  needs neither the Service Key nor any permission this account lacks.
- A secure variant exists at
  `POST /submissions/v3/integration/secure/submit/{portalId}/{formGuid}`,
  which takes a Bearer token and has higher rate limits. It requires the
  **`forms`** scope. `forms` is not a `crm.*` scope, so it may appear in a
  different section of the Service Key picker — worth checking (section 7).
- HubSpot's documentation states a form submission activity on a contact
  timeline shows the contact, **the date they submitted**, and **any additional
  fields included in their submission**, and that full detail of new and old
  submitted forms is visible as "Form submitted" engagements.
- HubSpot **deduplicates contacts by email automatically**, with no documented
  exceptions via UI or API. A submission with an existing email updates that
  contact rather than creating a second one.

That satisfies the actual requirement — Crystal sees each individual seller
enquiry, dated, on the timeline — using a native HubSpot mechanism designed for
exactly this, with no permission this account cannot obtain.

### Option 5 — Custom behavioral events

**Unavailable on this account.**

Custom behavioral events (now "Custom Events") require an **Enterprise** tier.
They were originally Marketing Hub Enterprise only and have since been extended
across Enterprise-level Hubs. This account is not on an Enterprise tier.

**Verdict: ruled out by plan.**

---

## 3. Comparison

| | Forms API (4/6) | Private app (3) | Dev-platform app (2) | Service Key alt route (1) | Custom events (5) |
|---|---|---|---|---|---|
| **Available on this account** | Yes | Yes, until ~26 Oct 2026 | Yes | Unverified | **No — Enterprise only** |
| **Extra scope needed** | **None** | `crm.objects.notes.write` | `crm.objects.notes.write` | Unknown | n/a |
| **New credential** | None (or optional `forms` scope) | Yes, a second token | Yes, plus OAuth refresh | Unknown | n/a |
| **Browser-side secrets** | None — server-side only | None | None | — | — |
| **Crystal sees each enquiry on the timeline** | **Yes — "Form submitted", dated, with values** | Yes — a Note | Yes — a Note | — | Partially |
| **Dedupe: one contact per email** | Native, by email | Our search + 409 handling | Same | — | — |
| **Implementation complexity** | Low — one extra POST | Low — token swap | High — OAuth lifecycle | Unknown | High |
| **Long-term viability** | Stable, first-party | **Creation sunset in ~8 weeks** | Stable | Unknown | Stable |
| **Plan limitation** | Forms included on free | None | None | — | **Enterprise** |

---

## 4. Recommendation

**Use the HubSpot Forms Submission API to create the timeline activity, keeping
the existing authenticated Contacts API write exactly as it is.**

Concretely:

1. `POST /api/lead` keeps its current, proven behaviour: search the contact by
   email, then update or create through the Contacts API with the Service Key,
   writing `email`, `firstname`, `lastname`, `phone`, `address` and `message`.
   **Nothing about the live pipeline changes.**
2. It then submits the same enquiry to a HubSpot **form** created for this
   purpose, which produces the dated "Form submitted" activity on that contact's
   timeline carrying the submitted values.
3. Both must succeed for `/api/lead` to report success, on the same rule already
   in force: the visitor is never told the enquiry landed unless it did.

### Why this over the private app

The private-app route is a smaller diff — a token value swap and the held commit
merges as-is. It is tempting for that reason. It is still the wrong choice:
HubSpot disables creation of new legacy private apps for existing accounts on
**26 October 2026**. Adopting it means the site's only CRM activity mechanism
depends on a credential that cannot be re-created if it is ever revoked, lost, or
needs rotating. For a site one person maintains, that is a real operational risk
in exchange for saving an afternoon.

The Forms API needs no credential that can expire from under us, no scope this
account cannot hold, and is a first-party mechanism HubSpot builds specifically
to put form submissions on contact timelines.

### Why keep the Contacts API rather than let the form do everything

A form submission alone would create the contact, set the properties **and** make
the activity — one call instead of three. It is genuinely simpler.

It is rejected because it would replace a path already **proven in production**
with an unauthenticated one, give up the explicit dedupe control and the contact
id, and coarsen the error semantics that the "never report false success" rule
depends on. The brief says do not weaken the existing lead pipeline. Adding a
second write is additive; swapping out the proven one is not.

### How this resolves the `message` question

The held commit reduced `message` to a short latest-enquiry summary, which is
only safe once something else holds the history. Under this design the timeline
holds every submission with its values, so that change becomes safe **and**
should ship together with the form submission — never before it.

### Honest limitations

- The unauthenticated endpoint means portal ID and form GUID are the only things
  identifying the target. They are not secrets — they are visible in any HubSpot
  form embedded on any public site — but they stay in Vercel environment
  variables and are never sent to the browser. If the `forms` scope turns out to
  be available to the Service Key, the secure endpoint is strictly better and I
  would use it instead.
- HubSpot has an **upcoming validation change to the Forms API submission
  endpoints**. The form must define every field submitted to it, or submissions
  may be rejected. That shapes the setup step in section 7 and is a reason to
  test before trusting it.
- Every field submitted must correspond to a contact property. Only standard
  properties are used — `email`, `firstname`, `lastname`, `phone`, `address`,
  `message` — so **no custom property is invented**.
- On paid Marketing tiers, form submissions can affect marketing-contact counts.
  Not a concern on this account's tier, but worth knowing before any upgrade.

---

## 5. The non-negotiables, checked against the recommendation

| Requirement | How it holds |
|---|---|
| One Contact per email | Unchanged Contacts API search + 409 conflict handling; the Forms API also dedupes by email natively |
| Repeat submissions never overwrite or lose earlier enquiry details | Each submission is its own dated timeline activity retaining the values submitted at that time |
| Property address remains in standard `address` | Unchanged — already live at `04b45d4` |
| Blank phone/address never erase existing data | Unchanged — blank values are omitted, never sent as `""`; the form submission omits them too |
| Never report success unless durably captured | Both writes must succeed; any failure returns 502 and the recovery panel |
| No browser-side HubSpot secrets | Portal ID and form GUID are server-side environment variables; the browser never receives them |
| No invented custom properties | Only standard contact properties are submitted |
| Production endpoint contract unchanged | `POST /api/lead` keeps its URL, status codes, error codes and response shapes |

---

## 6. What was NOT decided, and why

- **The held Note commit (`6286ab3`) is not merged and not deleted.** If the
  `forms` scope turns out to be unavailable *and* the Forms API proves
  unsuitable in testing, a private app created before 26 October 2026 remains a
  working fallback, and that commit would ship unchanged. It stays on the branch
  as a live option, not as dead code.
- **Nothing was implemented in this pass.** The Forms API work cannot be built or
  tested without a real form GUID, and guessing one would produce untestable code.

---

## 7. HUMAN ACTION REQUIRED

Two things, the second only if the first is quick.

**1. Create a HubSpot form for website enquiries, and send me its IDs.**

- HubSpot → **Marketing → Forms → Create form** (an embedded/regular form).
- Name it something like `Website enquiry (crystalsellstoledo.com)`.
- Add fields mapped to these **existing standard contact properties**, and no
  others:
  - Email *(required)*
  - First name
  - Last name
  - Phone number
  - Street address  → the `address` property
  - Message → the `message` property
- Publish it. You do **not** need to embed it anywhere — the site never renders
  this form; the server submits to it.
- From the form's embed code or URL, send me:
  - the **Portal ID** (your HubSpot account ID, visible in the URL)
  - the **Form GUID** (the long `xxxxxxxx-xxxx-...` identifier)

Neither is a secret, but I will still put them in Vercel environment variables so
they never reach the browser.

**2. While you are in Settings, check one thing.**

In the Service Key scope picker, look outside the CRM section for a **`forms`**
scope. If it exists, tell me — I will use HubSpot's authenticated secure submit
endpoint instead of the unauthenticated one, which is strictly better. If it does
not exist, the unauthenticated endpoint works and needs nothing from you.

**What happens next:** with those IDs I implement the form submission, add the
regression tests and the negative tests, run the full suite, and ship it together
with the `message` summary change. Then you perform one production submission and
confirm:

- **A.** the visible Street Address is populated *(already live — you can verify
  this today)*
- **B.** a dated "Form submitted" activity appears on the contact's timeline
  carrying the enquiry
- **C.** a second submission with the **same email** leaves one contact and
  **two** distinct timeline activities

---

## 8. What is explicitly NOT done

- **Nothing was implemented.** This pass is research and a decision.
- **The timeline activity is still missing in production.** Enquiries are
  captured in full on the contact, but not as dated activities.
- **The Forms API has never been called against this account.** Every claim above
  comes from HubSpot's documentation, not from a live request.
- **Option 1 was not proven either way.** A project-provisioned Service Key may
  or may not expose engagement scopes; I found no documentation confirming it and
  did not guess.
- `main` remains at `04b45d4` and is unaffected by this pass.
