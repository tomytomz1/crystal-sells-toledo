# Crystal Sells Toledo

Marketing site for Crystal — REALTOR® with **Key Realty**, working Perrysburg, Ohio and the
**43551** ZIP code.

Static HTML, no framework, no database. It loads fast, costs nothing to host, and anyone
can edit it.

---

## 1. Deploy it (5 minutes)

The site is plain HTML at the repo root — any static host works. On Vercel:

1. **Import the repo** at [vercel.com/new](https://vercel.com/new).
2. **Framework preset:** `Other`. **Root directory:** `./`. Leave build & output empty.
3. **Deploy.**

`vercel.json` already sets clean URLs (`/sell`, not `/sell.html`), security headers and asset
caching.

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

Nine things are placeholders. Replace them and the site is live-ready.

### Contact details

Search and replace across `src/` and `assets/js/main.js`, then rebuild:

Crystal's phone number — **(419) 245-4655** — is already in place across the site, the
`tel:` links, the JSON-LD and the mailto fallback. These are still placeholders:

| Placeholder | Replace with |
|---|---|
| `crystal@crystalsellstoledo.com` | her real email |
| `— add license number —` (in `src/pages/about.html`) | her Ohio license number |
| `Perrysburg, Ohio 43551` (in `src/partials/footer.html`, `src/pages/contact.html`) | the Key Realty office address |

```bash
sed -i 's/crystal@crystalsellstoledo\.com/her.real@email.com/g' \
  src/pages/*.html src/partials/*.html assets/js/main.js
npm run build && npm run check
```

`npm run check` warns on every page that still contains a known placeholder, so it tells you
when you are done. If the phone number ever changes, it appears in `src/pages/`,
`src/partials/` and `assets/js/main.js` in three formats — display, `tel:` and the
hyphenated JSON-LD form.

### Photography

Drop real files into `assets/img/` using **exactly these names**. Each one automatically
replaces its branded placeholder — no code change needed.

| Filename | What it is | Suggested size |
|---|---|---|
| `crystal-headshot.jpg` | Crystal's portrait (the one in the green blouse) | 800 × 1000, portrait |
| `hero-perrysburg.jpg` | Homepage hero — a Perrysburg street or home | 1800 × 1200, landscape |
| `logo-lockup.png` | The Key Realty ∣ Crystal Sells Toledo lockup, **transparent PNG** | ~600px wide |
| `realtor-mls.png` | The REALTOR® ∣ MLS badge, transparent PNG | ~300px wide |
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

Right now, submitting a form opens the visitor's email client with the details pre-filled.
That works, but it loses some leads. To capture every one:

1. Create a free form at [formspree.io](https://formspree.io) with Crystal's email.
2. Open `assets/js/main.js` and set the endpoint:

```js
var CONFIG = {
  formEndpoint: "https://formspree.io/f/xxxxxxxx",   // ← paste it here
```

Every form on the site starts working immediately. Test one before you trust it.

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
npm run check     # validate links, alt text, meta, JSON-LD
npm run dev       # build, then serve on http://localhost:3000
```

**Edit the files in `src/`, not the HTML at the root.** Root `.html` files are generated and
get overwritten on every build.

```
src/partials/     header, footer, CTA band, page shell   ← shared chrome, edit once
src/pages/        one file per page (content + SEO metadata)
assets/css/       the whole design system, one file
assets/js/        nav, scroll reveals, forms, FAQ
tools/build.mjs   assembles src/ into root HTML + sitemap.xml
tools/check.mjs   pre-flight validation
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

---

## 5. The bigger plan

The website is one piece. **`STRATEGY.md`** is the rest: what the 43551 market data says, who
the real competition is, and the specific plan for becoming the top listing agent in that ZIP
code without working seven days a week.
