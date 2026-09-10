# Working agreement — crystalsellstoledo.com

## Context economy

- Start with **CLAUDE.md** and **docs/CURRENT-STATE.md**.
- For repo-changing tasks also read **docs/WORKFLOW.md**.
- Read only files directly relevant to the requested task.
- Do not read `docs/PHASE-1-HANDOFF.md` wholesale unless explicitly required.
- Do not survey `docs/updates`; open a specific update only when relevant.
- Prefer `git status` / `diff` / `log` and targeted search over broad exploration.
- Do not use subagents for sequential work, documentation, a single bug, a single
  failing test, or ordinary implementation.
- Use subagents only for genuinely independent parallel workstreams.
- Minimize narration. Do not announce routine reads, searches, edits or test runs.
- On successful CI, do not read full logs unless needed.
- Final report **maximum 250 words** unless explicitly asked for more.
- Do not restate unchanged constraints in the final report.
- A fresh Claude session should be usable for each new phase.

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

**Never mutate the working tree to prove a test.** Do not break source and rely on
a later restore — a timeout once struck between break and restore and left
production source damaged. Where mutation proof is genuinely warranted (Tier 3/4
critical invariants only), run the new test against an older commit or a throwaway
worktree. Never mutate the deployment candidate. Mutation testing is exceptional;
do not report tallies unless it was actually justified.

**The full suite belongs to CI.** `.github/workflows/test.yml` runs `npm test` on
every pull request and on pushes to `main`. That is the authoritative release
gate. Do not run a successful full suite locally *and* again in CI. Read CI logs
only on failure. Budget for ordinary Tier 1/2 work: targeted runs after real code
changes, **zero** local full-suite runs, **zero** mutation runs, one CI run.

## Write-ups — proportionate

A `docs/updates/YYYY-MM-DD-<slug>.md` is required only when work changes
architecture, an API or CRM contract, environment variables, an external
integration, the security or compliance model, or production behaviour a future
reader would need handed to them. For small UI fixes, CSS, formatting, typos and
tiny regressions, a commit message explaining *why* is sufficient.

When a write-up is warranted it must stand alone: assume no repo access and no
memory of previous conversations. Cover what was wrong and why it mattered, what
changed, the resulting contract, test results, what a human must still do, and
what is explicitly not done. **State what is unproven as unproven.**

Update `docs/PHASE-1-HANDOFF.md` only when its contract or status actually
changed. Update `docs/CURRENT-STATE.md` only when material current project state
changes — never merely because a commit SHA changed. Neither file carries a SHA,
so no follow-up pin commit is ever needed.

## The Pulse Handoff Protocol — GitHub is the handoff, not the chat

**Every implementation session, and every meaningful operator or configuration
session, ends with a PULSE HANDOFF posted to GitHub — before the final chat
response is written.** A chat window is unreadable by the next agent,
unsearchable, and detached from the commit it describes. Anything material that
lives only there is lost when the session ends.

- **Session with a pull request** → a top-level comment on that pull request.
  Posting it *after* the merge is preferred, so it carries the real merge SHA
  and the final CI result instead of a prediction.
- **Manual session with no pull request** — Vercel, HubSpot, Neon, Twilio,
  Retell, DNS — → a new comment appended to the one permanent issue
  **"Crystal Sells Toledo - Pulse Log"**. Never a new issue per session.

**The final chat response must be a subset of the handoff.** If writing the
response surfaces a fact, warning, blocker, next step, decision or verification
result the handoff omits, edit the handoff first.

**Never put a credential in a handoff** — no password, access token, connection
string, secret value or personal test data. Environment variable **names and
scopes** only. Treat it as a public artifact.

A handoff does not replace `docs/CURRENT-STATE.md`; when material current state
changed, update that file too. The handoff is the session record,
`CURRENT-STATE.md` is the standing truth.

The full required contents and the template: `docs/WORKFLOW.md`.

### "pulse Claude"

An instruction to another agent to recover this project's state from GitHub
alone. It means: read

1. `CLAUDE.md`
2. `docs/CURRENT-STATE.md`
3. `docs/WORKFLOW.md`
4. current `origin/main`, resolved dynamically
5. the latest relevant pull request and its PULSE HANDOFF
6. the latest **"Crystal Sells Toledo - Pulse Log"** comment, if it is newer
   than that pull-request handoff
7. a specific implementation document **only** when the task actually needs it

Then **independently verify GitHub state rather than trusting the handoff.** A
handoff is a claim about the world made by an agent that has since stopped
running. Check the merge actually landed, the CI actually passed, the file
actually says what the handoff says it says. This project has already had two
merged documents assert things that were false; the protocol exists to make
those findable, not to make them authoritative.

## Commands

```bash
npm run build            # src/ + assets/ -> public/
npm run check            # static validation
npm run verify:live      # post-deploy: does the live site match what was built?
npm run test:unit        # api/ endpoint and validation
npm run test:browser     # browser behaviour
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

| | |
|---|---|
| Site | crystalsellstoledo.com — lead generation for a Toledo REALTOR® |
| Agent | Crystal Saylor, Key Realty LTD, Ohio licence 2025003655 |
| Contact | (419) 245-4655 · crystal@crystalsellstoledo.com |
| Stack | Static HTML built by `tools/build.mjs`, and three Vercel functions: `api/lead.js` (the lead), `api/twilio-inbound.js` (inbound SMS — inert), `api/operator-action.js` (the operator's suppression entry — inert) |
| Deploy | Vercel, production branch `main` |
| CRM | **HubSpot** — Contacts API + authenticated Forms Submission API. Service Key scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `forms`. Zoho code is a dormant rollback path, imported by nothing. |

Current status, feature flags and what is still gated: `docs/CURRENT-STATE.md`.
Execution procedure, the PULSE HANDOFF template and the final-report template:
`docs/WORKFLOW.md`.
