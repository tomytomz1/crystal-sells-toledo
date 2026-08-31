# Zoho Lead schema corrections — 31 August 2026

Production-readiness pass before the manual Zoho/Vercel setup.
Repo `tomytomz1/crystal-sells-toledo`, commit `dc2d618`, branch
`claude/crystal-perrysburg-realtor-site-so38qa` (merged to `main`).

**Status: the Zoho integration is NOT proven.** No live call has been made to a
real Zoho account. Everything below is verified against Zoho's documented schema
and 62 automated tests, not against the account itself.

---

## 1. Context, for a reader with no repo access

`crystalsellstoledo.com` is a lead-generation site for **Crystal Saylor**, a
REALTOR® with **Key Realty LTD** in Toledo, Ohio. Static HTML built by a Node
script, deployed on Vercel, with a single serverless function at `POST /api/lead`
that validates website enquiries and writes them into **Zoho CRM (free edition)**.

Two forms feed it:

- `home_value` — `/home-value`, a two-step funnel (address, then contact details)
- `contact` — `/contact`

The governing rule for the whole system: **no legitimate lead may be lost, and the
site must never claim success unless the server actually accepted the lead.**

---

## 2. What was wrong

Four defects were found by checking the outgoing payload against Zoho's actual
standard Lead schema. Three would have failed the very first live submission.

### 2.1 `Company` was missing — every create would have failed

`Company` is **system-mandatory** on a Zoho Lead. The payload did not include it,
so every upsert would have returned `MANDATORY_NOT_FOUND`. The website would have
shown its failure panel to every visitor, for every submission, until someone
looked at the function logs.

### 2.2 Field limits were above Zoho's maximums

| Field | Our limit was | Zoho maximum | Consequence |
|---|---|---|---|
| `first_name` | 80 | 40 | rejected downstream |
| `email` | 254 | 100 | rejected downstream |
| `phone` | 40 | 30 | rejected downstream |
| `last_name` | 80 | 80 | fine |

A long but entirely legitimate value would pass our validation, reach Zoho, and be
refused — turning a real lead into a `502` for someone who had already filled in
the whole form. The failure would look random and would be hard to reproduce.

### 2.3 `Lead_Status: "New Lead"` was an invented picklist value

`Lead_Source` and `Lead_Status` are Zoho **picklists**. A value the account does
not hold is rejected with `INVALID_DATA`, failing the entire lead.

Zoho's stock statuses are `Not Contacted`, `Contacted`, `Pre-Qualified`,
`Attempted to Contact`, `Contact in Future`, `Junk Lead`, `Lost Lead`,
`Not Qualified`. **`New Lead` is not among them** on a default account. It was a
guess presented as a fact.

### 2.4 `Lead_Source: "Website"` was also unconfirmed

Less likely to be wrong, but still assumed. Some accounts ship `Web Download` and
`Web Research` without a plain `Website`.

---

## 3. What changed

### Files

```
EDIT  api/_lib/zoho.mjs                 Company, configurable picklists, retry
EDIT  api/_lib/validate.mjs             limits aligned to Zoho maximums
EDIT  src/pages/home-value.html         maxlength on inputs
EDIT  src/pages/contact.html            maxlength on inputs
EDIT  tests/api.test.mjs                +22 tests
EDIT  tools/check.mjs                   static conformance guards
EDIT  docs/PHASE-1-HANDOFF.md           corrected CRM contract
EDIT  package.json                      npm run zoho:verify
NEW   tools/zoho-verify.mjs             reads the account's real schema
NEW   CLAUDE.md                         working agreement for this repo
```

### 3.1 `Company` added

Set from the form type. These are business classifications of the enquiry, not
claims about the person:

| `form_type` | `Company` |
|---|---|
| `home_value` | `Residential Seller` |
| `contact` | `Residential Real Estate Lead` |
| `buyer_inquiry` | `Residential Real Estate Lead` |

A fallback constant guarantees the field is never empty even for an unexpected
form type.

### 3.2 Limits aligned, with rejection rather than truncation

Server limits are now `first_name 40`, `last_name 80`, `email 100`, `phone 30`.
Stricter existing limits were kept where already below Zoho's ceiling
(`property_address 200` against Zoho's 250, for instance).

Overlength values are **rejected with `422 FIELD_TOO_LONG`, never truncated.**
Silently shortening a name corrupts the record, and silently shortening an email
produces an address that does not deliver — a lead that looks captured but cannot
be contacted, which is worse than a visible rejection.

The same maximums are mirrored as `maxlength` on the inputs, so a visitor is
stopped as they type instead of after submitting a completed form.

### 3.3 Picklists are no longer invented

Three independent safeguards:

1. **`Lead_Status` is omitted entirely** unless `ZOHO_LEAD_STATUS` is explicitly
   set. No status is better than a rejected lead.
2. **`Lead_Source` is configurable** via `ZOHO_LEAD_SOURCE`, defaulting to
   `Website`.
3. **Picklist-free retry.** If Zoho rejects with `INVALID_DATA` on a picklist
   field, the lead is retried once with `Lead_Source` and `Lead_Status` removed.
   A lead landing unclassified is a small annoyance; a lead lost to an assumed
   dropdown entry is not acceptable. The retry logs `zoho.picklist_rejected` with
   the remediation command so the misconfiguration gets noticed and fixed.

### 3.4 New tool: `npm run zoho:verify`

Reads the account's real Lead field metadata via
`GET /crm/v5/settings/fields?module=Leads` and reports:

- whether the credentials work at all
- the actual `Lead_Source` values the account holds
- the actual `Lead_Status` values the account holds
- whether the configured values exist, with a `PASS`/`FAIL` per value
- whether `Company` is mandatory, and its maximum length
- a suggested `Lead_Status` closest to "new / uncontacted"

Exits non-zero if anything is misconfigured. Requires the
`ZohoCRM.settings.fields.READ` scope.

---

## 4. The resulting CRM contract

### Endpoint

```
POST /api/lead        JSON only · 16 KB cap · same-origin
200  { "ok": true,  "submission_id": "csv_<24 hex>" }
4xx  { "ok": false, "code": "...", "message": "..." }
```

### Field limits (server-enforced)

```
first_name 40 · last_name 80 · email 100 · phone 30       <- Zoho maximums
property_address 200 · topic 120 · timeline 120 · condition 120
message 4000 · notes 4000 · page 300 · form_type 32
landing_page 500 · referrer 500 · first_touch_at 40
utm_* 200 · gclid/gbraid/wbraid/fbclid/msclkid 300
```

### Exact payload sent to Zoho

`POST /crm/v5/Leads/upsert` with `duplicate_check_fields: ["Email"]`:

```json
{
  "First_Name": "Sam",
  "Last_Name": "Rivera",
  "Company": "Residential Seller",
  "Email": "sam@example.com",
  "Phone": "(419) 555-0000",
  "Street": "123 Louisiana Ave, Perrysburg, OH 43551",
  "Lead_Source": "Website",
  "Description": "FORM: home_value\nSELLING TIMELINE: ...\n(22 rows)"
}
```

`Lead_Status` is **absent** unless configured. `Phone` and `Street` are omitted
when blank. The `contact` form sends the same shape with
`"Company": "Residential Real Estate Lead"` and no `Street`.

Then `POST /crm/v5/Notes` attaches the same 22-row block to the resulting Lead.

### Description block — always 22 rows, blanks rendered as `-`

```
FORM · SELLING TIMELINE · CONDITION · TOPIC · MESSAGE · NOTES ·
LANDING PAGE · CURRENT PAGE · REFERRER ·
UTM SOURCE · UTM MEDIUM · UTM CAMPAIGN · UTM TERM · UTM CONTENT ·
GCLID · GBRAID · WBRAID · FBCLID · MSCLKID ·
FIRST TOUCH · SUBMITTED · SUBMISSION ID
```

Zoho free has no custom fields, so everything beyond the standard set lives here.
Every label is always emitted — "no UTM source" and "we stopped recording UTM
source" must not look identical six months from now.

### Duplicate handling

Upsert on `Email` so repeat enquiries do not create duplicate Leads, **plus a Note
on every submission** so nothing a person said is ever overwritten. One Lead, many
Notes.

### Environment variables

| Variable | Required | Default |
|---|---|---|
| `ZOHO_CLIENT_ID` | yes | — |
| `ZOHO_CLIENT_SECRET` | yes | — |
| `ZOHO_REFRESH_TOKEN` | yes | — |
| `ZOHO_ACCOUNTS_DOMAIN` | no | `https://accounts.zoho.com` |
| `ZOHO_API_DOMAIN` | no | `https://www.zohoapis.com` |
| `ZOHO_LEAD_SOURCE` | no | `Website` |
| `ZOHO_LEAD_STATUS` | no | **unset — field omitted** |
| `ALLOWED_ORIGINS` | no | — |

Scopes: `ZohoCRM.modules.leads.CREATE`, `ZohoCRM.modules.leads.UPDATE`,
`ZohoCRM.modules.notes.CREATE`, `ZohoCRM.settings.fields.READ`.

---

## 5. Test results

`npm test` → build + static check + **62 tests, 62 passing, 0 failing**
(was 40 before this pass).

New coverage in this pass:

- `Company` present and correct for both form types
- `Company` never empty for any known form type
- all Zoho-mandatory fields populated
- no field exceeds its Zoho maximum
- each limit rejected at one character over
- each limit accepted at exactly the cap
- explicit proof of no silent truncation
- `Lead_Status` omitted when unconfigured
- `Lead_Status` sent when configured
- `Lead_Source` defaults to `Website` and is overridable
- picklist-free retry preserves every lead-bearing field
- client `maxlength` matches the server limit on every form

### Negative testing

Every guard was broken deliberately once and the suite confirmed to fail, then
restored. **16 of 16 caught, zero no-ops**, including:

```
Company removed from the Lead record            CAUGHT
Company mapping dropped for home_value          CAUGHT
Lead_Status hardcoded again                     CAUGHT
picklist-free retry removed                     CAUGHT
retry strips a lead-bearing field too           CAUGHT
first_name limit raised above Zoho's 40         CAUGHT
email limit raised above Zoho's 100             CAUGHT
phone limit raised above Zoho's 30              CAUGHT
overlength silently truncated instead of rejected  CAUGHT
client maxlength drifts from the server limit   CAUGHT
client maxlength removed entirely               CAUGHT
```

The original Phase 1 guards were re-run and still fire. All ten constraints in
`docs/PHASE-1-HANDOFF.md` section 6 were verified intact.

---

## 6. What a human must still do

**In Zoho, before the first live submission:**

1. Create a Self Client at <https://api-console.zoho.com> with the four scopes
   above, and exchange the code once for a refresh token.
2. Run `npm run zoho:verify` with the credentials in the shell. This is the whole
   point of the correction — it prints the account's real picklist values.
3. Confirm `Website` exists in the Lead Source picklist. If not, add it in Zoho
   (Setup → Modules → Leads → Lead Source) or set `ZOHO_LEAD_SOURCE` to a value
   that does exist.
4. Choose a Lead Status from what `zoho:verify` lists — most likely
   `Not Contacted` — and set `ZOHO_LEAD_STATUS`. Leave it unset and leads arrive
   with no status, which is safe but less useful.
5. Confirm `Company` maximum length is at least 27 characters (the stock 100 is
   fine; `zoho:verify` reports it).

**In Vercel:**

6. Set the environment variables and redeploy.

**Then the live test:**

7. Submit through `/home-value`. Confirm the success panel, not the recovery panel.
8. In Zoho confirm: Lead exists, `Company` set, `Lead_Source` as configured, and a
   Note attached with all 22 rows.
9. Submit again with the same email. Confirm **one** Lead and **two** Notes.
10. Check the Vercel function logs for `zoho.picklist_rejected`. If it appears, the
    retry saved the lead but a picklist value still needs fixing.

---

## 7. What is explicitly NOT done

- **No live Zoho call has been made.** The integration is unproven.
- No lead notification to Crystal — a CRM record is not an alert. Response time is
  still bounded by how often she checks Zoho.
- No last-touch attribution; only first touch is captured.
- No GA4, no ad pixels, no SEO landing pages, no chatbot.
- Rate limiting is per-instance memory, not a hard global ceiling.
- 15 site images are still placeholders.
- Neighbourhood copy is drafted, not written by Crystal.
