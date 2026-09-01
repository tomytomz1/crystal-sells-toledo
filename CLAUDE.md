# Working agreement — crystalsellstoledo.com

## Always produce a Markdown write-up

**Every time work is done on this repo, write a Markdown file explaining it**, so
the owner can paste it into another assistant without re-explaining the project.

- Save it as `docs/updates/YYYY-MM-DD-<slug>.md`
- Send the file to the owner, do not only summarise in chat
- Update `docs/PHASE-1-HANDOFF.md` too whenever a contract changes (the endpoint,
  the CRM payload, environment variables, or anything in its section 6)

Each update file must stand on its own. Assume the reader has **no access to this
repository** and no memory of previous conversations. Include:

1. What was wrong or missing, and why it mattered
2. What changed, file by file
3. The resulting contract (payloads, env vars, limits) in full, not by reference
4. Test results, including negative-test results
5. What a human still has to do manually
6. What is explicitly NOT done, so nobody assumes it is

Write plainly. State what is unproven as unproven.

## Completion checklist — run this every time, before replying

Work is not finished until all six are done, in order. Do not report completion
with any of them skipped.

1. **Run the full test suite** — `npm test`. Not a subset, and not "no code
   changed so it cannot have broken": run it and report the real number.
2. **Write `docs/updates/YYYY-MM-DD-<slug>.md`** per the agreement above, even
   for documentation-only work.
3. **Update `docs/PHASE-1-HANDOFF.md`** if any contract changed — the endpoint,
   the CRM payload, field limits, environment variables, or section 6.
4. **Commit** everything, with a message explaining *why*, not just what.
5. **Push** the branch, and merge to `main` if the work is meant to deploy.
6. **Report** in the final reply, explicitly:
   - commit SHA
   - update-document path
   - test result
   - whether anything remains blocked
   - whether human action is required

If something is blocked or unproven, say so plainly in that report. Never let
"tests pass" imply "this works in production" when no live call has been made.

## Project facts

| | |
|---|---|
| Site | crystalsellstoledo.com — lead generation for a Toledo REALTOR® |
| Agent | Crystal Saylor, Key Realty LTD, Ohio licence 2025003655 |
| Contact | (419) 245-4655 · crystal@crystalsellstoledo.com |
| Stack | Static HTML built by `tools/build.mjs`, one Vercel function at `api/lead.js` |
| Deploy | Vercel, production branch `main` |
| CRM | **HubSpot** — Contacts + Notes API. Service key scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.notes.write`.
Zoho code is retained but imported by nothing; it is a rollback path, not the live path. |

## Commands

```bash
npm run build        # src/ + assets/ -> public/
npm run check        # static validation
npm test             # build + check + full test suite
npm run zoho:verify  # Zoho picklists — only if rolling back to Zoho
npm run dev          # build, then serve public/ on :3000
```

## Rules that must not be broken

`public/` is generated — edit `src/`, never `public/`.

Full detail in `docs/PHASE-1-HANDOFF.md` section 6. In short:

1. `Crystal Saylor` and `Key Realty LTD` share one CSS rule (`.legalid__name`) with
   no media query — never style one without the other. Ohio equal-prominence rule.
2. The licensed name must never appear in an `h1` or `h2`.
3. `CONTENT_UPDATED` in `tools/build.mjs` is maintained by hand. Never a build
   timestamp.
4. No fair-housing risk language — describe housing, never who lives there.
5. No fabricated testimonials, no invented biography.
6. Never add "Degnan Group" — the site does not advertise as a team.
7. No automated home valuation. The site promises a human CMA.
8. Assets are content-hashed at build. Removing that pins old code in browsers.
9. Never expose a CRM credential to the browser — `HUBSPOT_ACCESS_TOKEN` above all.
10. Reject overlength input; never silently truncate user data.
11. The enquiry block is the whole lead. If the CRM rejects the property it is
    written to, fail loudly — never retry without it. A contact saved without
    its address, timeline and message looks fine and is worthless.
12. Every submission must land as its own timeline Note on the contact. A
    contact with no activity behind it hides the enquiry. Note failure fails
    the lead — never best-effort.
13. `[hidden]` is enforced globally with `!important`. Any class setting an
    explicit `display` silently defeats the UA rule; that has caused two real
    bugs already.

## Testing practice

Every guard is negative-tested: break it deliberately once, prove the suite fails,
restore it. A guard that cannot fail is not a guard. Keep this up.
