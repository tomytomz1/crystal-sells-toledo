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

## Reading the snapshots — `npm run seo:diff`

`tools/seo-diff.mjs` reports what moved between the two most recent
snapshots. `.github/workflows/seo-diff.yml` runs it automatically when the
Monday snapshot workflow finishes, writes the report to the run summary, and
opens an issue **only** when something crosses a threshold.

It needs no credentials — it reads committed files.

**Two things it will tell you that are easy to forget:**

**The windows overlap.** Each snapshot covers a trailing 28 days and they are
taken weekly, so consecutive snapshots share **21 of their 28 days**. A delta
between them is *not* week-over-week change — it is the difference between two
heavily overlapping windows, which damps real movement by roughly a factor of
four and lags it by up to three weeks. The report says so every time, and says
the opposite when a run was missed and the windows genuinely do not overlap.

**A query vanishing is not necessarily lost traffic.** Search Console withholds
low-volume queries, so a query can drop out of the table while the demand
continues. The report flags that rather than letting it read as a decline.

### It reports arithmetic. It does not advise.

Whether anything in it should change the site is a judgement constrained by
fair-housing language (rule 5), the licensed name staying out of `h1`/`h2`
(rule 3), equal prominence under OAC 1301:5-1-02 (rule 2) and no fabricated
biography (rule 6). `tools/check.mjs` can enforce the structural ones; **nothing
can machine-check fair-housing risk in newly written prose.** No automation in
this repository proposes or applies copy changes, and that is deliberate.

### Thresholds

In `MATERIAL` at the top of `tools/seo-diff.mjs`: a new query at 3+ impressions,
an average-position move of 5+, a page impression move of 10+, or anything
crossing into the top 20. Set where a change cannot be a rounding artefact at
this site's volume. **Raise them as traffic grows; do not lower them to make the
report look busier.**

## The shape changed once, on purpose

`2026-09-14.json` — the first live snapshot — carries a `landingPages` array in
the **raw** shape Google returned: one page split across several rows by query
string (`/`, `/?gtm_latency=1`, `/?fbclid=…`), each with a `users` count.

Every snapshot after it folds those rows by path and **omits `users` per page**.
The reasoning is in `tools/seo-report.mjs`: sessions and key events add across
folded rows, distinct users do not, and an inflated per-page `users` would be
worse than none.

**The first file was deliberately not rewritten.** It is a record of what Google
actually returned on 17 September 2026, and editing a data record to match a
later code change destroys the only thing it is good for. Read it as raw; read
everything after it as folded.

Two things the fold does *not* do: it leaves `(not set)` — GA4's placeholder for
an unattributed session — intact rather than folding it into a path, and it
treats `/sell` and `/sell/` as different pages. Neither has come up in real data
yet.

## Failure

The script exits non-zero and names the cause. It never writes a partial
snapshot, and it never falls back to stale data — a missing section in an
existing file means that source was not configured when it ran, which the file
records in `sources`.

`403` from either API almost always means step 2 was skipped for that product.
