# Crystal Sells Toledo

Production lead-generation site for **Crystal Saylor, REALTOR® · Key Realty LTD**, focused on Perrysburg / 43551 and Greater Toledo.

The site is live at `crystalsellstoledo.com`.

> **Current runtime and activation truth lives in [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md).**
> Do not use this README to infer whether a Twilio, Vercel, Neon, HubSpot, Turnstile, consent, or outbound-messaging capability is currently enabled.

## Architecture

The public site is a **static frontend with serverless back-end functions**, not a static-only site.

- `tools/build-entry.mjs` builds the HTML in `src/` plus assets into generated `public/`.
- Vercel deploys production from `main`.
- `api/lead.js` is the live lead intake path.
- `api/twilio-inbound.js` handles signed inbound Twilio messaging events.
- `api/operator-action.js` supports deliberate operator suppression actions.
- `api/operator-unsuppress.js` supports deliberate operator unsuppression review/action.
- HubSpot is the live CRM.
- Neon Postgres stores the append-only communications-consent / suppression evidence ledger.
- Cloudflare Turnstile protects the lead path.
- `api/_lib/send-permission.mjs` is Gate 8 send-time authorization.
- `api/_lib/sms-sender.mjs` is the outbound SMS transport module; its activation state is intentionally documented only in `docs/CURRENT-STATE.md`.
- Zoho **Mail** SMTP is used for acknowledgement/operator email transport. Zoho **CRM** code is dormant rollback code and is not the live CRM path.

The browser never receives HubSpot, Neon, SMTP, Twilio server credentials, or other server-side secrets.

## Production identity

| Detail | Value |
|---|---|
| Name | **Crystal Saylor**, REALTOR® |
| Brokerage | **Key Realty LTD** |
| Ohio license | **2025003655** |
| Phone | **(419) 245-4655** |
| Email | **crystal@crystalsellstoledo.com** |
| Office | **6800 W. Central Ave, Unit B, Toledo, OH 43617** |
| Production domain | **crystalsellstoledo.com** |

The site deliberately does **not** advertise a team/group name. See `CLAUDE.md` and `docs/compliance-audit.md` for the standing identity rules and audit history.

## Repository layout

```text
src/partials/             shared header/footer/CTA/page shell
src/pages/                page source + SEO metadata
assets/css/               design system
assets/js/                navigation, forms, client behavior
api/                      Vercel serverless endpoints
api/_lib/                 CRM, consent, ledger, Twilio, mail, security helpers
db/                       applied consent/suppression database migrations
tools/build-entry.mjs     standard build entry
tools/check.mjs           release/static validation
tests/                    Node/browser/integration/security regression tests
public/                    generated output; never edit directly
docs/CURRENT-STATE.md     current operational truth
docs/WORKFLOW.md          execution / PR / CI / Pulse procedure
docs/updates/             dated implementation and activation records
```

**Edit `src/`, never `public/`.** The build regenerates `public/`.

## Development

```bash
npm run build            # src/ + assets -> public/
npm run check            # static/release guards
npm run verify:live      # post-deploy live verification
npm run seo:report       # Search Console + GA4 snapshot; credentials required
npm run seo:diff         # compare newest SEO snapshots
npm run test:unit        # lead/API unit tests
npm run test:browser     # browser behavior
npm run test:turnstile   # Turnstile gate
npm run test:hubspot     # HubSpot delivery
npm run test:mail        # Zoho Mail acknowledgement
npm run test:consent     # consent model
npm run test:consent-state  # HubSpot consent-state adapter
npm test                 # full release suite; CI is the authoritative gate
npm run mint:unsuppress  # mint an off-platform operator unsuppression capability
npm run dev              # build + local server on :3000
```

See `CLAUDE.md` and `docs/WORKFLOW.md` before making repository changes. In particular, `main` is production and PRs are not merged without explicit operator approval.

## Lead path

Browser lead forms POST to `/api/lead`.

The live path includes, in broad order:

1. request/method/origin/body/schema/honeypot/rate-limit checks;
2. Cloudflare Turnstile verification when enabled;
3. communications-consent evidence processing when enabled;
4. durable append-only ledger evidence where required;
5. HubSpot contact + authenticated form-submission activity;
6. best-effort Zoho Mail acknowledgement after the lead is stored.

The lead must never be reported as received when the authoritative CRM delivery failed. Communications permission is separately gated and must not be inferred merely because a lead exists.

### HubSpot

Required live lead-delivery variables are documented in `.env.example`:

- `HUBSPOT_ACCESS_TOKEN`
- `HUBSPOT_PORTAL_ID`
- `HUBSPOT_FORM_GUID`

HubSpot private-app scopes used by the live path are:

- `crm.objects.contacts.read`
- `crm.objects.contacts.write`
- `forms`

A repeat enquiry is matched by email and updates the Contact while a dated authenticated Forms Submission activity preserves the individual enquiry event.

## Environment configuration

`.env.example` is the **configuration contract**, not a statement about what is currently present in Vercel.

For actual Production state, use `docs/CURRENT-STATE.md` and the latest relevant Pulse handoff. Never commit real credential values.

Important configuration families include:

- HubSpot live lead delivery;
- Turnstile lead verification;
- communications-consent feature gating and append-only ledger;
- Gate 7 Twilio inbound + operator suppression;
- operator unsuppression;
- Gate 8 sender-role suppression lookup;
- dark outbound SMS transport;
- Zoho Mail acknowledgement/operator email;
- dormant Zoho CRM rollback.

## Content and compliance

The site has already launched. Older documents and checklists that say “before launch” are historical snapshots unless explicitly promoted into `docs/CURRENT-STATE.md`.

Open content questions that were deliberately removed from public copy rather than guessed are tracked in `docs/content-decisions.md`.

Known editorial/admin work can include:

- replacing remaining generic/placeholder imagery with approved real photography;
- reviewing drafted biography/neighborhood copy in Crystal’s own voice;
- brokerage review of privacy/disclosure language and open policy questions;
- completing any still-unconfirmed external marketing/SEO administration tracked outside the runtime code.

Do not fabricate testimonials, biography facts, listing claims, market claims, or service promises to make the site look more complete.

## Key references

- [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md) — what is true now
- [`CLAUDE.md`](CLAUDE.md) — repository invariants
- [`docs/WORKFLOW.md`](docs/WORKFLOW.md) — how work is executed and handed off
- [`docs/ENGINEERING-LESSONS.md`](docs/ENGINEERING-LESSONS.md) — reusable lessons from material defects
- [`docs/compliance-audit.md`](docs/compliance-audit.md) — advertising-compliance audit history
- [`docs/content-decisions.md`](docs/content-decisions.md) — unresolved owner/broker/admin content questions
- [`STRATEGY.md`](STRATEGY.md) — market/marketing strategy

## Product direction

The website is one piece of a larger listing-acquisition system. `STRATEGY.md` holds the market strategy; operational activation and compliance state belong in `docs/CURRENT-STATE.md`, not in strategy or historical audit files.
