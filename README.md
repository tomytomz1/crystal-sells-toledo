# Crystal Sells Toledo

Marketing site for Crystal — REALTOR® with **Key Realty**, working Perrysburg, Ohio and the
**43551** ZIP code.

Static HTML, no framework, no database. It loads fast, costs nothing to host, and anyone
can edit it.

---

## 1. Deploy it (5 minutes)

`npm run build` produces a `public/` directory of plain HTML — any static host works. On
Vercel:

1. **Import the repo** at [vercel.com/new](https://vercel.com/new).
2. **Framework preset:** `Other`. **Root directory:** `./`.
3. Leave the build and output fields alone — `vercel.json` already declares
   `buildCommand: npm run build` and `outputDirectory: public`.
4. **Deploy.**

`vercel.json` also sets clean URLs (`/sell`, not `/sell.html`), security headers and asset
caching.

Publishing `public/` rather than the repo root is deliberate: only the site ships.
`STRATEGY.md`, the market research in `docs/` and the page sources stay off the live
domain.

### "Project *crystal-sells-toledo* already exists, please use a new name"

That error means a Vercel project of that name is already in the account — the repo was
imported once before. You do not need a new name. Either:

- **Open the existing project** (vercel.com → the `crystal-sells-toledo` project → Settings →
  Git) and confirm it is connected to this repo. Pushes then deploy automatically; or
- **Delete the old project** (Settings → bottom of the page) and re-import; or
- **Import under a different project name** — the name only affects the temporary
  `*.vercel.app` URL, never the custom domain.

### Production branch

**`main` is the production branch.** Vercel deploys it on every push; nothing else
deploys to the live domain. Feature branches get a preview deployment and are merged
into `main` when they are approved.

### Custom domain

Buy `crystalsellstoledo.com`, add it under **Settings → Domains**, and point the nameservers
where Vercel tells you. Then search-and-replace the domain if you chose a different one:

```bash
grep -rl "crystalsellstoledo.com" . --exclude-dir=node_modules --exclude-dir=.git \
  | xargs sed -i 's/crystalsellstoledo\.com/YOURDOMAIN.com/g'
npm run build
```

---

## 2. Make it Crystal's (the only required step)

### Already in place

| Detail | Value |
|---|---|
| Name | **Crystal Saylor**, REALTOR® |
| Phone | **(419) 245-4655** — display text, `tel:` links, JSON-LD and the mailto fallback |
| Ohio license | **2025003655** — footer, /about and /privacy |
| Brokerage | **Key Realty LTD** in the legal disclosures, "Key Realty" in the casual copy |
| Office | **6800 W. Central Ave, Unit B, Toledo, OH 43617** — footer, /contact and the JSON-LD |
| Email | **crystal@crystalsellstoledo.com** |

> **Verify the license number** against the [Ohio eLicense system](https://elicense.ohio.gov/)
> before launch. It is published on every page as a legal disclosure, and a wrong digit is a
> compliance problem, not a typo.

### The email

`crystal@crystalsellstoledo.com` is wired through the site — the footer, the contact page, the
valuation page and the mailto fallback in `assets/js/main.js`. **Create that mailbox before
launch**, or the fallback sends mail into a void. (Zoho Mail is the mailbox host — nothing to
do with Zoho CRM, which is rollback-only code the site does not use.)

Worth adding as *free aliases* on the same mailbox, not as separate accounts:

- `hello@crystalsellstoledo.com` — the friendly one to put on signs, cards and social bios
- `crystal.saylor@crystalsellstoledo.com` — catches anyone who guesses the full-name form

Aliases deliver into the one inbox, so there is still only ever one place to check. Set
`crystal@` as the default *send-from* address so replies stay consistent.

If the primary address ever changes, it appears in `src/pages/`, `src/partials/` and
`assets/js/main.js`:

```bash
sed -i 's/crystal@crystalsellstoledo\.com/new@address.com/g' \
  src/pages/*.html src/partials/*.html assets/js/main.js
npm run build && npm run check
```

### Still outstanding

- **Photography.** 14 images are still branded placeholders: the homepage hero
  (`hero-perrysburg.jpg`, which falls back to a branded gradient) and the 13 listed
  below that render a placeholder card — the 12 neighborhood photographs and the
  `/buy` porch image. The portrait, logo lockup, REALTOR®/MLS badge and social card
  are real and in place.

`npm run check` names every image still outstanding, so it tells you when you are done.

> **A note on the address.** The JSON-LD `address` is the Key Realty office in Toledo 43617,
> because that is the real business address and search engines will cross-check it against the
> Google Business Profile. The 43551 focus lives in `areaServed` and in the page content, which
> is where it belongs — the two do not compete.

### The mark

The crystal mark is four SVG files, all drawn from the same geometry. Nothing else needs
touching to change it site-wide — the header, favicon and manifest all point at these.

| File | Use |
|---|---|
| `assets/img/mark.svg` | **Primary.** Four tones of gold, lit from the upper left. Header, and anywhere it can print in colour. |
| `assets/img/favicon.svg` | The mark on brand ink, tones lifted so all four facets separate at 16px. Browser tab and home-screen icon. |
| `assets/img/mark-mono.svg` | **Single-colour master**, drawn in brand ink. Give this one to a sign shop, embroiderer or stamp maker — recolour the stroke as needed. |
| `assets/img/mark-mono-light.svg` | The same reversal in cream, for placing on ink or over photography. |

Send a sign printer `mark-mono.svg` plus the hex values `#e0c78f · #c9a259 · #b8863b · #7a5620`
(light to dark, left to right) and they have everything they need.

### Photography

Drop real files into `assets/img/` using **exactly these names**. Each one automatically
replaces its branded placeholder — no code change needed.

| Filename | What it is | Suggested size |
|---|---|---|
| `hero-perrysburg.jpg` | Homepage hero — a Perrysburg street or home | 1800 × 1200, landscape |
| `hood-old-west-end.jpg` | The Old West End, Toledo | 800 × 600 |
| `hood-ottawa-hills.jpg` | Ottawa Hills | 800 × 600 |
| `hood-sylvania.jpg` | Sylvania | 800 × 600 |
| `hood-maumee.jpg` | Maumee | 800 × 600 |
| `hood-west-toledo.jpg` | West Toledo / Point Place | 800 × 600 |
| `hood-oregon.jpg` | Oregon & Northwood | 800 × 600 |
| `hood-downtown.jpg` | Historic Downtown Perrysburg | 800 × 600 |
| `hood-riverbend.jpg` | Village at Riverbend | 800 × 600 |
| `hood-three-meadows.jpg` | Three Meadows | 800 × 600 |
| `hood-fort-meigs.jpg` | Fort Meigs / riverfront | 800 × 600 |
| `hood-levis-commons.jpg` | Levis Commons | 800 × 600 |
| `hood-established.jpg` | An established subdivision | 800 × 600 |
| `buying.jpg` | A front porch / welcoming exterior (for `/buy`) | 1400 × 900 |

Already supplied and in use: `crystal-headshot.jpg`, `realtor-mls.png`,
`og-default.jpg`.

`logo-lockup.png` is no longer used. The footer now **sets** the Crystal Sells
Toledo lockup — the real `mark.svg` beside live web type — the same way the
header does, so it is sharp at every size and needs no white plate. The PNG is
kept in the repository because it is the only co-branded Key Realty artwork on
hand; nothing renders it. Its `logo-lockup.svg` sibling is a hand-drawn
approximation and must never ship as the mark.

`/sell` is deliberately text-led rather than carrying a listing photograph: presenting
generic artwork beside "included on every listing" would read as evidence of work that
has not been shown. Add one there only when Crystal has an approved photograph of her
own listing.

Compress everything at [squoosh.app](https://squoosh.app) before committing — aim under
300 KB each. Slow photos are the number one reason agent sites lose mobile visitors.

### Make the forms deliver

Leads POST to `/api/lead`, a same-origin Vercel function that talks to
**HubSpot**. The browser never sees a credential and no key is ever prefixed so
it reaches the client. Until the three required variables below are set the
endpoint returns `503 NOT_CONFIGURED` and the form shows a recovery panel with
Crystal's phone, email and a pre-filled mailto - it never claims a lead was
received when it was not.

**Environment variables** (Vercel -> Settings -> Environment Variables). See
`.env.example` for the annotated list.

| Variable | Required | Notes |
|---|---|---|
| `HUBSPOT_ACCESS_TOKEN` | yes | Private app / service key |
| `HUBSPOT_PORTAL_ID` | yes | Numeric hub id, for the Forms Submission API |
| `HUBSPOT_FORM_GUID` | yes | The form the submission is posted to |
| `HUBSPOT_API_BASE` | no | Default `https://api.hubapi.com` |
| `HUBSPOT_FORMS_BASE` | no | Default `https://api.hsforms.com` |
| `GOOGLE_MAPS_API_KEY` | no | Address autocomplete; unset, the field is a plain text input |
| `GA4_MEASUREMENT_ID` | no | Overrides the compiled-in id; the tag only ships when `VERCEL_ENV=production` |
| `ALLOWED_ORIGINS` | no | Extra hostnames permitted to POST — see the note below |

**HubSpot scopes required:** `crm.objects.contacts.read`,
`crm.objects.contacts.write`, `forms`. There is no engagement or notes scope on
a service key, which is why the per-submission activity is written through the
Forms Submission API rather than as a Note.

**What lands in HubSpot.** A Contact, matched on `email` so a repeat enquiry
updates the same record rather than creating a second one, plus a dated
**Form submitted** activity carrying the full enquiry - so a later message never
overwrites what the person said the first time.

| HubSpot property | Source |
|---|---|
| `email` | form, lowercased |
| `firstname` / `lastname` | form |
| `phone` | form, normalised to `(419) 555-1234` where it is a US number; omitted when blank so a PATCH cannot blank an existing value |
| `address` | property address, when supplied; omitted when blank for the same reason |
| `message` | the fixed-order enquiry block: form, timeline, condition, topic, message, notes, landing page, current page, referrer, every UTM and click id, first touch, submitted, submission id |

`message` is a HubSpot **default** contact property, not an invented one. If a
portal admin archives it or makes it read-only the endpoint fails the lead
rather than saving a contact with the enquiry silently missing.

**Which origins may POST.** `crystalsellstoledo.com`, `www.`, `localhost`,
`127.0.0.1`, both hostnames Vercel sets for the current deployment —
`VERCEL_URL` (the immutable deployment hostname) and `VERCEL_BRANCH_URL` (the
generated branch hostname that follows the latest successful deployment from
that branch) — and anything named in `ALLOWED_ORIGINS`.

Preview testing needs no configuration: the deployment URL Vercel prints and
the branch URL both submit as they are. Arbitrary `*.vercel.app` hostnames are
**not** accepted — that domain is shared, so a suffix match would let any
Vercel project on earth drive a browser into posting here. A sibling
deployment, a different branch of this project and another account's project
are all different strings and all refused.

None of this is authentication — an `Origin` header is trivially forged by
anything that is not a browser. It is CSRF hygiene, and nothing downstream
treats a passing origin as proof of anything.

### Zoho: rollback only, not the live path

`api/_lib/zoho.mjs` and `tools/zoho-verify.mjs` are retained as a rollback path
and are **imported by nothing**. Setting the `ZOHO_*` variables does not switch
delivery to Zoho - `api/lead.js` talks to HubSpot. The code and its tests are
kept so a rollback is a small change rather than a rewrite; leave the variables
blank in production, and treat any instruction to configure Zoho as historical.

### Rate limiting

`api/_lib/security.mjs` holds a 5-per-10-minutes-per-IP window in module
memory. Vercel may run several warm instances, so this is a floor, not a hard
global ceiling - it stops naive floods cheaply and with no dependencies. For a
strict limit, move the store to Vercel KV or Upstash; the interface is one
function.



### Words to review

Two files contain drafted copy that Crystal should read and rewrite in her own voice:

- `src/pages/about.html` — her story. Marked with `REPLACE` comments. The more specific and
  personal, the better it works.
- `src/pages/neighborhoods.html` — the 43551 neighborhood guides. These are a reasonable
  starting draft, **but Crystal knows these streets and the site should say what she knows.**
  Local specificity is exactly what makes these pages rank and convert.

There are **no testimonials on the site**, and that is deliberate: mocked-up quotes read as
fabricated endorsements (NAR Article 12, FTC Endorsement Guides). `src/pages/index.html`
carries a commented-out placeholder marking where a real testimonials section would go —
restore it only with verbatim quotes and the client's permission to use their name.

### Legal review

`src/pages/privacy.html` is a plain-language description of what the site actually does —
which services it loads, what each one sees, how long things are kept — **not legal advice,
and not yet reviewed**. Have Key Realty's compliance contact review it, plus the footer
disclosures, against the brokerage's own policies and Ohio Division of Real Estate
advertising rules.

Two things in it need a decision rather than a proofread: the retention and deletion wording,
and the fact that Google Analytics sets cookies while the site shows no consent banner. The
page states both plainly; whether that is the brokerage's chosen position is not a call this
repository can make.

---

## 3. Working on it

```bash
npm run build     # rebuild the HTML from src/
npm run check     # validate links, alt text, meta, JSON-LD, lead pipeline
npm test          # build + check + the whole test suite (CI's job, not the loop)
npm run dev       # build, then serve public/ on http://localhost:3000
```

**Edit the files in `src/`, never the HTML in `public/`.** The build wipes and regenerates
`public/` every time, so anything edited there is lost. It is not committed — Vercel rebuilds
it on every push.

```
src/partials/     header, footer, CTA band, page shell   ← shared chrome, edit once
src/pages/        one file per page (content + SEO metadata)
assets/css/       the whole design system, one file
assets/js/        nav, scroll reveals, forms, FAQ
tools/build.mjs   assembles src/ + assets/ into public/
tools/check.mjs   pre-flight validation, runs against public/
public/           generated — the only thing that gets deployed
```

### Adding a page

Create `src/pages/whatever.html`, starting with a metadata block:

```html
<!-- meta {
  "title": "Page Title | Crystal Sells Toledo",
  "description": "Under 160 characters, written for a human.",
  "slug": "whatever",
  "priority": 0.7
} -->

<section class="pagehead">
  <div class="wrap"><h1>Heading</h1></div>
</section>
```

Run `npm run build`. It appears at `/whatever` and is added to `sitemap.xml` automatically.

---

## 4. Before launch

- [ ] Real phone, email, license number and office address (`npm run check` confirms)
- [ ] Real photography in `assets/img/`
- [ ] `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_PORTAL_ID` and `HUBSPOT_FORM_GUID` set in Vercel,
      and a test submission confirmed in the HubSpot portal
- [ ] About page and neighborhood guides rewritten in Crystal's voice
- [ ] Privacy page and footer disclosures reviewed by Key Realty compliance
- [ ] Custom domain connected
- [ ] `npm run check` passes with no errors
- [ ] [Google Business Profile](https://business.google.com) claimed — see `STRATEGY.md`
- [ ] Site submitted to [Google Search Console](https://search.google.com/search-console)
- [ ] **Web Analytics** toggled on in the Vercel project (Analytics tab) — the script ships
      with every page already, but Vercel only records data once the product is enabled

---

## 5. The bigger plan

The website is one piece. **`STRATEGY.md`** is the rest: what the 43551 market data says, who
the real competition is, and the specific plan for becoming the top listing agent in that ZIP
code without working seven days a week.
