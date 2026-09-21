# Working agreement — crystalsellstoledo.com

## Context economy

- Start with **CLAUDE.md** and **docs/CURRENT-STATE.md**.
- For repo-changing tasks also read **docs/WORKFLOW.md**.
- Read the **relevant entry** of **docs/ENGINEERING-LESSONS.md** when the work
  involves a material defect, security, consent or suppression, a runtime or
  provider boundary, or a failure class that has bitten before. **Not for a typo,
  a CSS tweak or an unrelated Tier 0 change**, and never the whole archive out of
  habit — the point is grounding, not ritual.
- **Never read a large file whole.** `grep -n` for the symbol, then
  `sed -n 'A,Bp'` around it. `tests/operator-action.test.mjs`,
  `tests/suppression.test.mjs` and `tools/check-base.mjs` are 100–124 KB each;
  reading one whole costs ~30k tokens and it is re-sent on every later turn.
- Read only files directly relevant to the requested task.
- Do not read `docs/PHASE-1-HANDOFF.md` wholesale unless explicitly required.
- Do not survey `docs/updates`; open a specific update only when relevant.
- Prefer `git status` / `diff` / `log` and targeted search over broad exploration.
- Do not use subagents for sequential work, documentation, a single bug, a single
  failing test, or ordinary implementation. Only for genuinely independent
  parallel workstreams.
- Minimize narration. Do not announce routine reads, searches, edits or test runs.
- On successful CI, do not read full logs unless needed.
- Final report **maximum 250 words** unless explicitly asked for more. Do not
  restate unchanged constraints.

### One session per phase

A fresh Claude session should be usable for each new phase — and **should be
started for each**: implementation, then adversarial review, then CI and handoff.
Conversation context is re-sent on every turn, so a session that carries all
three phases pays for its entire history on every subsequent call. Splitting at
phase boundaries costs one re-read and removes the rest.

### Routing — the repository carries the context, not the prompt

A normal future task prompt should be able to be this small:

```
Read CLAUDE.md, docs/CURRENT-STATE.md and docs/WORKFLOW.md.
Task: <specific task>.
Relevant detail: <specific doc/file if needed>.
Do not merge.
```

Anything stable belongs in the repository. If a session needed context the prompt
had to supply, that context probably belongs in CURRENT-STATE.md or WORKFLOW.md —
add it there rather than expecting the next prompt to repeat it.

## Rules that must not be broken

1. **`public/` is generated. Edit `src/`, never `public/`.**
2. **`Crystal Saylor` and `Key Realty LTD` share one CSS rule (`.legalid__name`)
   with no media query.** Never style one without the other — Ohio
   equal-prominence rule.
3. **The licensed name must never appear in an `h1` or `h2`.**
4. **`CONTENT_UPDATED` in `tools/build.mjs` is maintained by hand.** Never a build
   timestamp.
5. **No fair-housing risk language.** Describe housing, never who lives there.
6. **No fabricated testimonials, no invented biography.**
7. **Never add "Degnan Group".** The site does not advertise as a team.
8. **No automated home valuation.** The site promises a human CMA.
9. **Assets are content-hashed at build.** Removing that pins old code in browsers.
10. **Never expose a CRM credential to the browser** — `HUBSPOT_ACCESS_TOKEN`
    above all. No CRM or SMTP variable may be prefixed `NEXT_PUBLIC_`.
11. **Reject overlength input; never silently truncate user data.**
12. **The enquiry block is the whole lead.** If the CRM rejects the property it is
    written to, fail loudly — never retry without it. A contact saved without its
    address, timeline and message looks fine and is worthless.
13. **Never let "tests pass" imply "this works in production"** when no live call
    has been made.

Full rationale for 1–12: `docs/PHASE-1-HANDOFF.md` §6 — read it only if a rule's
*reason* is actually in question.

## Engineering rules earned the hard way

These govern *how* a claim is proved. Each was paid for by a real defect here.
**The rationale, and the incident that bought each one, is in
`docs/ENGINEERING-LESSONS.md` — read the relevant entry when working in the area
it describes, not otherwise.** Rule numbers are cited throughout the source; they
are stable identifiers and must never be renumbered.

14. **Boundary-evidence.** Mocks prove logic *inside* the mocked boundary. A
    material claim that depends on Node HTTP, Vercel, Twilio, HubSpot,
    Postgres/Neon, SMTP or a browser needs a test at the **lowest practical real
    boundary**. **Do not claim real-boundary behaviour from mocks alone.** This
    authorises no live external call — a local real boundary is usually stronger
    and cheaper.
15. **Externally-observable outcomes are asserted from the observer's side.**
    `res.statusCode = 400` is not "the client received 400". The outcome includes
    what the exchange leaves behind — connection state, framing, what the peer may
    do next — and a harness may not tear that down before it is observed.
16. **Resource ownership is explicit.** A helper may stop its own work; it must not
    destroy, close, release or mutate a resource the **caller** still needs.
17. **A material defect is not isolated until the repository has been searched for
    the same behavioural pattern.** Search the shape, not the identifier. Record
    out-of-scope matches as named follow-ups; **never widen the current change.**
18. **Prose may not outrun the evidence.** Comments, test names, documentation, PR
    descriptions, UI wording and handoffs may not state a stronger guarantee than
    the implementation supports. An inherited sentence is not evidence.
19. **Inactivity is not enforcement.** Keep **durable evidence**, **operational
    projection** and **active enforcement** distinct. Unconfigured or inactive
    functionality is not implemented enforcement, and **must never be described as
    though it were**.
20. **Promote a lesson only when it is worth obeying forever.** After a material
    finding, decide *explicitly* whether it produced reusable intelligence. If it
    did: rationale into `docs/ENGINEERING-LESSONS.md`, only the compact invariant
    here or in `docs/WORKFLOW.md`. Most corrections produce no rule, and
    **manufacturing one is itself a failure**. State the outcome in the handoff —
    *including* "nothing promoted, because …". See `docs/WORKFLOW.md`
    § Lesson promotion.
21. **A safety gate may not be replaceable at runtime.** Gate 8
    (`api/_lib/send-permission.mjs`) binds its boundaries by construction: no
    module-scope mutable seam, no exported setter, nothing an importer can
    overwrite. A fabricated empty suppression result is indistinguishable from
    "this consumer never opted out", so a replaceable gate is a production-reachable
    always-allow. Tests inject by construction, never by mutating the shipped gate.

## Testing — risk-based

Pick the tier by what the change can actually break. Optimise for information
gained per test run, not tests executed.

| Tier | Change | During development |
|---|---|---|
| **0** | docs, comments, handoff prose | **no runtime tests** |
| **1** | CSS, colour, spacing, type, static copy | one targeted browser/static check |
| **2** | local behaviour — formatting, autocomplete, form interaction, keyboard, client validation | targeted test file or `--test-name-pattern` |
| **3** | critical integration — HubSpot delivery, form submission, dedupe, attribution, external failure semantics | targeted integration tests |
| **4** | security, data loss, compliance — secrets, PII, lead loss, duplicate CRM records, auth, legal invariants | strongest relevant targeted tests |

Tier 0 exception: documentation consumed by the build or at runtime is not Tier 0.

For a real production bug at Tier 2, add **one** strong regression test that
reproduces the actual failure mode.

**Never mutate the working tree to prove a test.** Do not break source and rely
on a later restore — a timeout once struck between break and restore and left
production source damaged. Where mutation proof is genuinely warranted (Tier 3/4 critical invariants only), run the new test against
an older commit or a throwaway worktree — never the deployment candidate.

**The full suite belongs to CI.** `.github/workflows/test.yml` runs `npm test` on
every pull request and on pushes to `main`. That is the authoritative release
gate. Budget for ordinary Tier 1/2 work: targeted runs after real code changes,
**zero** local full-suite runs, **zero** mutation runs, one CI run.

## Pre-handoff adversarial review

**Required for Tier 3 and Tier 4 work, and any change involving security,
authentication, secrets, PII, consent, suppression, CRM writes, external side
effects, or money or lead-loss risk.** After implementation, after the targeted
tests pass, before the pull request is presented as ready.

Stop implementing. Re-read the complete diff cold — `git diff`, not the whole of
every file it touches. Assume at least one defect is still there. Check the
changed behaviour against the written contracts. Fix material findings before
presenting.

**Pass budget — hard cap.** One pass. A second is permitted **only** if the first
found and fixed a material defect, and it covers **the correction delta only**.
**There is no third pass.** A pass that finds nothing material ends with **no
commit** — do not manufacture one to show for it.

A review round that only rewords a claim, narrows a phrase or re-asserts
something already true is **not** a pass that earns another one. If a pull request
is accumulating commits of that shape, the budget is already spent: stop, and
carry anything genuinely unresolved into the handoff as a named follow-up.

The lesson from [#24](https://github.com/tomytomz1/crystal-sells-toledo/pull/24):
**passing tests are evidence, not proof that the tested invariant is the right
invariant.**

This is a **reading** pass, not a testing tier. It adds no local full-suite run
and no mutation run. The attack list, the two questions that must be asked in
words, and the proof rules: `docs/WORKFLOW.md` § Pre-handoff adversarial review.

## CI is read, never waited on

**Never create a background task whose purpose is waiting or polling for GitHub
CI** — no background sleep loop, no "wait for CI" shell, no concurrent pollers,
and **no CI-wait or sleep process under Claude's control left running at the end
of the session**, including leftovers from earlier work. **Scoped to CI-wait tasks Claude created;
never an unrelated user or system process.** Replacing a waiter with
an invented manual re-check cadence is the same mistake in a different shape.

Push, let CI run, and read `status` and `conclusion` directly when a result is
actually needed — **logs are still read only on failure.** If a run is still
pending at the last check before the final response, **report it as pending and
stop.** Never infer elapsed CI time from how long the session feels. A reported
status can be stale, and this environment has returned the same stale-looking
state across the run, job, check and usage surfaces — **their agreement is not
independent corroboration.**

Procedure: `docs/WORKFLOW.md` § CI.

## Write-ups — proportionate

A `docs/updates/YYYY-MM-DD-<slug>.md` is required only when work changes
architecture, an API or CRM contract, environment variables, an external
integration, the security or compliance model, or production behaviour a future
reader would need handed to them. For small UI fixes, CSS, formatting, typos and
tiny regressions, a commit message explaining *why* is sufficient.

When warranted it must stand alone: assume no repo access and no memory of
previous conversations. **State what is unproven as unproven.**

Update `docs/PHASE-1-HANDOFF.md` only when its contract or status actually
changed. Update `docs/CURRENT-STATE.md` only when material current project state
changes — never merely because a commit SHA changed. Neither file carries a SHA,
so no follow-up pin commit is ever needed.

## The Pulse Handoff Protocol — GitHub is the handoff, not the chat

**Every implementation session, and every meaningful operator or configuration
session, ends with a PULSE HANDOFF posted to GitHub — before the final chat
response is written.** A chat window is unreadable by the next agent and detached
from the commit it describes.

- **Session with a pull request** → a top-level comment on that pull request,
  preferably *after* the merge so it carries the real merge SHA and CI result.
- **Manual session with no pull request** → a comment appended to the one
  permanent issue **"Crystal Sells Toledo - Pulse Log"**. Never a new issue.

**The final chat response must be a subset of the handoff.** If writing the
response surfaces anything the handoff omits, edit the handoff first.

**Never put a credential in a handoff.** Environment variable **names and scopes**
only. Treat it as a public artifact.

Required contents and the template: `docs/WORKFLOW.md` § The Pulse Handoff
Protocol.

### "pulse Claude"

An instruction to recover this project's state from GitHub alone: read
`CLAUDE.md`, `docs/CURRENT-STATE.md`, `docs/WORKFLOW.md`, current `origin/main`
resolved dynamically, the latest relevant pull request and its PULSE HANDOFF, and
the latest **"Crystal Sells Toledo - Pulse Log"** comment if newer. A specific
implementation document **only** when the task actually needs it.

Then **independently verify GitHub state rather than trusting the handoff.** A
handoff is a claim made by an agent that has since stopped running. Check the
merge landed, CI passed, the file says what the handoff says it says. This project
has already had two merged documents assert things that were false.

## Commands

```bash
npm run build            # src/ + assets/ -> public/
npm run check            # static validation
npm run verify:live      # post-deploy: does the live site match what was built?
npm run seo:report       # Search Console + GA4 snapshot -> docs/seo/; needs credentials
npm run seo:diff         # what moved between the two newest snapshots; no credentials
npm run test:unit        # api/ endpoint and validation
npm run test:browser     # browser behaviour
npm run test:turnstile   # the Turnstile verification gate on /api/lead
npm run test:hubspot     # HubSpot delivery
npm run test:mail        # Zoho Mail acknowledgement
npm run test:consent     # consent model
npm run test:consent-state  # HubSpot consent current-state adapter
npm test                 # build + check + whole suite — CI's job, not the loop
npm run zoho:verify      # Zoho picklists — only if rolling back to Zoho
npm run dev              # build, then serve public/ on :3000
```

Do not add one-off scripts for individual test names.

## Project facts

Stable architecture only. **Activation state does not belong here**; it is
authoritative only in `docs/CURRENT-STATE.md`.

| | |
|---|---|
| Site | crystalsellstoledo.com — lead generation for a Toledo REALTOR® |
| Agent | Crystal Saylor, Key Realty LTD, Ohio licence 2025003655 |
| Contact | (419) 245-4655 · crystal@crystalsellstoledo.com |
| Frontend | Static HTML generated from `src/` by `tools/build-entry.mjs`; `public/` is generated output |
| Server endpoints | Four Vercel functions: `api/lead.js`, `api/twilio-inbound.js`, `api/operator-action.js`, `api/operator-unsuppress.js` |
| Messaging boundary | `api/_lib/send-permission.mjs` is Gate 8; `api/_lib/sms-sender.mjs` is the designated outbound SMS transport module |
| Evidence store | Neon Postgres append-only consent/suppression ledger with separate website, sender and operator roles |
| Deploy | Vercel, production branch `main` |
| CRM | **HubSpot** — Contacts API + authenticated Forms Submission API. Service Key scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `forms`. Zoho CRM code is a dormant rollback path, imported by nothing. |
| Mail | Zoho Mail SMTP is the acknowledgement/operator-email transport; separate from dormant Zoho CRM code |

Current status, feature flags and what is still gated: `docs/CURRENT-STATE.md`.
Execution procedure, the PULSE HANDOFF template and the final-report template:
`docs/WORKFLOW.md`.
