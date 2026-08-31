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

### Branch note

The site currently lives on the **`claude/crystal-perrysburg-realtor-site-so38qa`** branch.
Vercel deploys the production branch (usually `main`). Either merge this branch into `main`,
or point Vercel at this branch under **Settings → Git → Production Branch**.

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
valuation page and the mailto fallback in `assets/js/main.js`. **Create that mailbox in Zoho
before launch**, or the fallback sends mail into a void.

Worth adding as a *free alias* on the same Zoho mailbox, not as separate accounts:

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

### Still placeholder

- **Photography** (below) and the **form endpoint** (below)

`npm run check` names each one that is still outstanding, so it tells you when you are done.

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
| `crystal-headshot.jpg` | Crystal's portrait (the one in the green blouse) | 800 × 1000, portrait |
| `hero-perrysburg.jpg` | Homepage hero — a Perrysburg street or home | 1800 × 1200, landscape |
| `logo-lockup.png` | The Key Realty ∣ Crystal Sells Toledo lockup, **transparent PNG** | ~600px wide |
| `realtor-mls.png` | The REALTOR® ∣ MLS badge, transparent PNG | ~300px wide |
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
| `listing-marketing.jpg` | A well-photographed listing (for `/sell`) | 1400 × 900 |
| `buying.jpg` | A front porch / welcoming exterior (for `/buy`) | 1400 × 900 |
| `og-default.jpg` | Social share card | **1200 × 630** |

Compress everything at [squoosh.app](https://squoosh.app) before committing — aim under
300 KB each. Slow photos are the number one reason agent sites lose mobile visitors.

### Make the forms deliver

Leads POST to `/api/lead`, a same-origin Vercel function. The browser never
sees a credential. Until the Zoho variables below are set the endpoint returns
`503 NOT_CONFIGURED` and the form shows a recovery panel with Crystal's phone,
email and a pre-filled mailto - it never claims a lead was received when it
was not.

**Environment variables** (Vercel -> Settings -> Environment Variables). Never
prefix any of these so they reach the browser. See `.env.example`.

| Variable | Required | Notes |
|---|---|---|
| `ZOHO_CLIENT_ID` | yes | Self-client from the Zoho API console |
| `ZOHO_CLIENT_SECRET` | yes | |
| `ZOHO_REFRESH_TOKEN` | yes | Generated once, does not expire |
| `ZOHO_ACCOUNTS_DOMAIN` | no | Default `https://accounts.zoho.com`; change for .eu / .in / .com.au / .jp / .ca |
| `ZOHO_API_DOMAIN` | no | Default `https://www.zohoapis.com` |
| `ALLOWED_ORIGINS` | no | Extra hostnames permitted to POST |

**Zoho scope required:** `ZohoCRM.modules.leads.CREATE`,
`ZohoCRM.modules.leads.UPDATE`, `ZohoCRM.modules.notes.CREATE`. The simplest
grant that covers all three is `ZohoCRM.modules.ALL`.

**Getting the refresh token**

1. <https://api-console.zoho.com> -> Self Client -> Create.
2. Generate a code with the scopes above, a 10-minute expiry, and your own
   domain as the scope description.
3. Exchange the code once, from a terminal:

```bash
curl -X POST https://accounts.zoho.com/oauth/v2/token \
  -d grant_type=authorization_code \
  -d client_id=YOUR_ID -d client_secret=YOUR_SECRET \
  -d code=THE_CODE
```

4. Copy `refresh_token` from the response into Vercel. The `access_token` is
   short-lived and is not stored - the endpoint refreshes it and caches it in
   memory.

**What lands in the CRM.** A Lead upserted on `Email` (so repeat enquiries do
not create duplicates), plus a **Note on every submission** carrying the full
detail - so a second enquiry updates the record without overwriting what the
person said the first time.

| Zoho field | Source |
|---|---|
| `First_Name` / `Last_Name` | form |
| `Email` | form, lowercased |
| `Phone` | form, normalised to `(419) 555-1234` where it is a US number |
| `Street` | property address, when supplied |
| `Lead_Source` | `Website` |
| `Lead_Status` | `New Lead` |
| `Description` | fixed-order block: form, timeline, condition, topic, message, notes, landing page, current page, referrer, all UTM/click IDs, first touch, submitted, submission ID |

Everything beyond the standard fields goes in `Description` because Zoho Free
has no custom fields.

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

Also swap the three placeholder testimonials on the homepage for real reviews as soon as she
has them, and delete the `quote--placeholder` class from those cards.

### Legal review

`src/pages/privacy.html` is a plain-language starting point, not legal advice. Have Key
Realty's compliance contact review it, plus the footer disclosures, against the brokerage's
own policies and Ohio Division of Real Estate advertising rules before launch.

---

## 3. Working on it

```bash
npm run build     # rebuild the HTML from src/
npm run check     # validate links, alt text, meta, JSON-LD, lead pipeline
npm test          # build + check + 40 automated tests
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
- [ ] `formEndpoint` set and a test submission received
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
