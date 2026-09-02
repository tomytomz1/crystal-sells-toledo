# Working agreement — crystalsellstoledo.com

## Testing policy — risk-based

Tests exist to reduce production risk. Optimise for **information gained per
test run**, not number of tests executed.

Pick the tier by what the change can actually break.

| Tier | Change | During development | Mutation | Release |
|---|---|---|---|---|
| **0** | docs, comments, handoff prose | **no runtime tests** | none | — |
| **1** | CSS, colour, spacing, type, static copy | one targeted browser/static check | none | full suite in CI |
| **2** | local behaviour — formatting, autocomplete, form interaction, keyboard, client validation | targeted test file or `--test-name-pattern` | normally none | full suite in CI |
| **3** | critical integration — HubSpot delivery, form submission, dedupe, attribution, external failure semantics | targeted integration tests | only for the critical invariant | full CI suite + live verification where mocks cannot prove it |
| **4** | security, data loss, compliance — secrets, PII, lead loss, duplicate CRM records, auth, legal invariants | strongest relevant targeted tests | representative only, never mechanical | full CI suite |

Tier 0 exception: documentation consumed by the build or at runtime is not Tier 0.

For a real production bug at Tier 2, add **one strong regression test that
reproduces the actual failure mode**. A second mutation proof is justified only
where the regression could plausibly be falsely green — an async race, say.

### Never mutate the working tree

Do **not** deliberately break source and rely on a later restore. A timeout once
struck between break and restore and left production source damaged, and every
backup taken afterwards captured the broken file.

Where mutation proof is genuinely warranted, either run the new test against a
known older commit, or use a throwaway git worktree. Never mutate the deployment
candidate in place.

Mutation testing is exceptional. Do not report tallies like "20 of 20 caught,
zero no-ops" unless mutation work was actually justified for a critical
invariant.

### Local commands — smallest useful thing

```bash
npm run test:unit      # api/ endpoint and validation
npm run test:browser   # browser behaviour
npm run test:hubspot   # HubSpot delivery
node --test --test-name-pattern "<name>" tests/browser.test.mjs
```

Do not re-run a passing targeted test unless the relevant code changed. Do not
add one-off scripts for individual test names.

### The full suite belongs to CI

`.github/workflows/test.yml` runs `npm test` on every pull request and on pushes
to `main`. That is the authoritative release gate.

Implement → run targeted tests → push. CI runs the whole suite outside the
interactive loop. Read CI logs **only on failure**; summarise success as
`229 passed, 0 failed` and move on. Do not run the complete suite locally *and*
again in CI.

Budget for ordinary Tier 1/2 work: targeted runs as needed after real code
changes, **zero** successful local full-suite runs, **zero** mutation runs, one
CI run. A failure buys another run after the fix; reassurance does not.

## Write-ups — proportionate

A substantial `docs/updates/YYYY-MM-DD-<slug>.md` is required only when work
changes architecture, an API or CRM contract, environment variables, an external
integration, the security or compliance model, or production behaviour a future
reader would need handed to them.

For small UI fixes, CSS, formatting, typos and tiny regressions a clear commit
message explaining *why* is sufficient.

Update `docs/PHASE-1-HANDOFF.md` only when its contract or status actually
changed. It describes the current production state; it carries no commit SHA, so
no follow-up pin commit is ever needed. Give the exact production SHA in the
final report instead — git history already records it.

When a write-up is warranted it must stand alone: assume no repo access and no
memory of previous conversations. Cover what was wrong and why it mattered, what
changed, the resulting contract in full, test results, what a human must still
do, and what is explicitly not done. State what is unproven as unproven.

## Finishing a task

1. Run the tests the tier calls for — nothing more.
2. Write a `docs/updates` file only if the change warrants one.
3. Update `docs/PHASE-1-HANDOFF.md` only if a contract or status changed.
4. Commit with a message explaining *why*.
5. Push; merge to `main` when the work is meant to deploy.
6. Report concisely: production SHA, what changed, test result, blockers, and
   any human action required.

Never let "tests pass" imply "this works in production" when no live call has
been made. Human live testing is for what automation cannot prove — real HubSpot
portal behaviour, real Google Places ranking, deployment configuration — not for
a colour change or already-covered deterministic logic.

## Project facts

| | |
|---|---|
| Site | crystalsellstoledo.com — lead generation for a Toledo REALTOR® |
| Agent | Crystal Saylor, Key Realty LTD, Ohio licence 2025003655 |
| Contact | (419) 245-4655 · crystal@crystalsellstoledo.com |
| Stack | Static HTML built by `tools/build.mjs`, one Vercel function at `api/lead.js` |
| Deploy | Vercel, production branch `main` |
| CRM | **HubSpot** — Contacts API + authenticated Forms Submission API. Service Key scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `forms`.
Zoho code is retained but imported by nothing; it is a rollback path, not the live path. |

## Commands

```bash
npm run build        # src/ + assets/ -> public/
npm run check        # static validation
npm run verify:live  # post-deploy: does the live site match what was built?
npm run test:unit    # api/ endpoint and validation
npm run test:browser # browser behaviour
npm run test:hubspot # HubSpot delivery
npm test             # build + check + the whole suite — CI's job, not the loop
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
