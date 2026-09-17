# Search performance snapshots

`npm run seo:report` asks Google for this site's search performance and writes a
dated snapshot into this directory. `.github/workflows/seo-report.yml` runs it
every Monday and commits the result.

Each `YYYY-MM-DD.json` is named for the **last day of the window it covers**, not
the day it ran. The window is stated inside the file.

## Why the snapshots are committed

Search Console discards performance data after **16 months**. A month that was
never snapshotted is gone, permanently, and no tool can recover it. These files
are the only durable record this project has, and they are small — a few KB each.

They are also the only honest way to answer "is this working?" later. A ranking
claim made from memory is not evidence; a dated artefact produced by a stated
query is.

## What a snapshot does not contain

**Every query anyone searched.** Search Console withholds queries issued by too
few distinct people, so the `queries` array routinely sums to fewer impressions
than `totals.impressions`. The difference is recorded as `anonymisedImpressions`.

This is a privacy filter on Google's side. No API parameter, paid SEO tool or
alternative export widens it. A low-traffic site will see most of its demand
anonymised, and that is not a defect in this script.

## One-time setup

Someone with access to the Google Cloud console, Search Console and GA4 does this
once. It takes about fifteen minutes and costs nothing — both APIs are free at
any volume this site will produce.

### 1. A service account

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project (or reuse one).
2. Enable both APIs — **Google Search Console API** and **Google Analytics Data
   API**.
3. **IAM & Admin → Service Accounts → Create service account.** Give it a name
   like `seo-report`. It needs **no** project role: all the access it will use is
   granted in the two products below, not in IAM.
4. On the new account, **Keys → Add key → Create new key → JSON.** Download it.

The JSON file contains a private key. It is a credential — treat it like one. Do
not commit it, and do not paste it into a chat, an issue or a pull request.

### 2. Grant it read access in each product

The service account has an email address, ending `iam.gserviceaccount.com`. It is
in the JSON as `client_email`.

- **Search Console** → Settings → Users and permissions → Add user. Paste that
  address. Permission: **Full** — the API rejects Restricted users.
- **GA4** → Admin → Property access management → `+` → Add users. Paste the same
  address. Role: **Viewer**.

### 3. Set four variables

| Variable | Where it comes from |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` in the JSON key |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | `private_key` in the JSON key, including the `BEGIN`/`END` lines |
| `GSC_SITE_URL` | `sc-domain:crystalsellstoledo.com` for a Domain property, or `https://crystalsellstoledo.com/` for a URL-prefix one |
| `GA4_PROPERTY_ID` | GA4 → Admin → Property details. Numeric, no `properties/` prefix |

**None of these may ever be prefixed `NEXT_PUBLIC_`** (CLAUDE.md rule 10). They
are read by a workstation and by CI, never by a browser.

Locally, put them in `.env` — already gitignored — and export them before
running. For the scheduled workflow, add all four under **Settings → Secrets and
variables → Actions → New repository secret**, under these exact names.

## Running it

```bash
npm run seo:report                 # trailing 28 days
SEO_WINDOW_DAYS=90 npm run seo:report
```

The window always ends **three days ago**. Search Console does not finalise a
day's figures for two to three days, and including an unsettled tail makes every
snapshot look like a decline.

## Failure

The script exits non-zero and names the cause. It never writes a partial
snapshot, and it never falls back to stale data — a missing section in an
existing file means that source was not configured when it ran, which the file
records in `sources`.

`403` from either API almost always means step 2 was skipped for that product.
