# Workflow — how a task is executed here

The reusable procedure. `CLAUDE.md` holds the invariants; this holds the steps.

## Startup

```bash
git fetch origin main
git status --short          # confirm a clean tree before starting
git checkout -B <branch> origin/main
```

Resolve current `origin/main` **dynamically** — never assume a SHA from a prompt
or from an earlier session. Branch from current `main`, not from a stale local
copy.

Then read **only**: `CLAUDE.md`, `docs/CURRENT-STATE.md`, and the specific files
the task touches. Do not survey `docs/updates`. Do not read
`docs/PHASE-1-HANDOFF.md` wholesale.

If the branch's pull request has already been merged, that pull request is
finished. Restart the branch from the latest `main` and open a new one; never
stack new commits on merged history.

## Testing

Pick the tier from `CLAUDE.md`.

- **Tier 0** (docs, comments, prose): **no local runtime tests.**
- **Tier 1/2**: one targeted test file, `--test-name-pattern`, or `npm run check`.
- **Tier 3/4**: the strongest relevant *targeted* tests — integration tests for
  the affected path, plus assertions on the specific invariant at risk.

Rules that hold at every tier:

- **Never run a successful full suite locally just for reassurance.** `npm test`
  is CI's release gate, not the development loop.
- **Inspect complete CI logs only on failure.** On success, take the summary line.
- **Never mutate the deployment candidate.** No breaking source to prove a test
  catches something; use an older commit or a throwaway worktree if a mutation
  proof is genuinely warranted.
- Do not re-run a passing targeted test unless the relevant code changed.
- Feature-gated work: verify **both** states — flag off must stay
  production-equivalent, flag on must behave as designed.

## Delivery

1. **Commit** with a message explaining *why* — the failure or the risk the change
   addresses, not a restatement of the diff.
2. **Push** with `git push -u origin <branch>`. Retry network failures with
   backoff; never switch branches to get a push through.
3. **Open a pull request** describing what changed, what was verified, and what is
   explicitly still unproven.
4. **Let CI run.** Fix only genuine failures.
5. **Do not merge unless explicitly instructed.**
6. **No follow-up SHA-only documentation commit.** Nothing in `docs/` pins a
   commit SHA, so nothing needs pinning after the fact. Give the SHA in the
   report; git history is the record.

Write a `docs/updates/` file only when `CLAUDE.md` says one is warranted. Update
`docs/CURRENT-STATE.md` only when material current state changed.

## The Pulse Handoff Protocol

**GitHub must contain the complete substantive handoff before a session is
finished.** The chat window is not a record: it is not readable by the next
agent, not searchable, and not attached to the commit it describes. Anything
material that exists only in a final chat response is lost the moment the
session ends.

So at the end of **every** implementation session, and every meaningful
operator or configuration session, post a **PULSE HANDOFF** to GitHub *before*
writing the final chat response.

### Where it goes

| The session | Where the handoff goes |
|---|---|
| produced a pull request | a **top-level comment on that pull request** |
| was manual work only — Vercel, HubSpot, Neon, Twilio, Retell, DNS, a console | a new comment appended to the permanent issue **"Crystal Sells Toledo - Pulse Log"** |

A pull-request handoff **may be posted after the merge**, so that it carries the
real merge SHA and the final CI result rather than a prediction. That is the
preferred timing whenever the session ends in a merge.

**Never open a new issue per session.** The Pulse Log is one permanent,
append-only thread. If it does not exist yet, create it once, with that exact
title, and say so.

### What it must contain

Everything material. The test is rule 5 below: if a fact, warning, blocker,
next step, decision or verification result appears in the final chat response
and not in the handoff, the handoff is incomplete.

Omit a heading only when it genuinely does not apply — never to save space, and
never because "nothing happened" is inconvenient. "Production changed: no" is
an answer; silence is not.

```markdown
## PULSE HANDOFF — <task or phase>

**When** <date and time, with timezone>
**Branch** <branch>
**PR** <#number and URL, or "none — manual session">
**Head SHA** <sha>
**Merge SHA** <sha, or "not merged">
**CI** <result, or "n/a">

### What is now true
<the material result — what changed about the world, not a restatement of the diff>

### Files changed
<paths, or "none — no repository change">

### External systems touched
<Vercel / HubSpot / Neon / Twilio / Retell / DNS — exactly what, or "none">

### Manual operator actions
<what a human did outside GitHub, in order>

### Environment variables
<NAMES and SCOPES added, changed or removed. NEVER a value.>

### Verification actually performed
<targeted tests run and their results; live calls actually made and what came
back. Distinguish the two.>

### Evidence observed
<log lines, query results, status codes, counts — the actual readings>

### Production changed
<yes, with the specific change / no>

### Side effects and persistent test artifacts
<test contacts, synthetic rows, anything left behind that a human would not expect>

### Cleanup still required
<or "none">

### Decisions made
<and by whom — the operator or the agent>

### Alternatives rejected
<and why. A rejected alternative with its reason is worth more than the choice.>

### Defects found and fixed
<including the root cause, not just the symptom>

### Blockers
<or "none">

### Still UNPROVEN
<state it as unproven. Tests passing is not production working.>

### Remaining activation gates
<which gates are open>

### Next recommended action
<one concrete action>

### Decision needed from the operator
<or "none">
```

### The rules

1. Post the handoff **before** the final chat response, every time.
2. **Never** put a password, access token, connection string, secret value,
   personal test data or any other credential in a handoff. Variable **names**
   and **scopes** only. This is a public-shaped artifact; treat it as one.
3. The handoff **does not replace `docs/CURRENT-STATE.md`.** When material
   current project state changed, update that file too, in the same pull
   request. The handoff is the session record; `CURRENT-STATE.md` is the
   standing truth.
4. **No commit exists solely to record a merge SHA or a CI result.** Those live
   in the pull-request handoff comment. This restates Delivery rule 6 — the
   handoff is the reason that rule is affordable.
5. **The final chat response must be a subset of the handoff.** Not a summary
   of different things — a subset. If writing the chat response surfaces
   something the handoff omits, edit the handoff first.

## Final report — maximum 250 words

- **branch / SHA / PR**
- **files changed**
- **material result** — what is now true that was not before
- **targeted tests** — what was run, and the result
- **CI status**
- **blockers or human action required**
- **production changed? yes / no**
- **a link to the PULSE HANDOFF** — and nothing material that the handoff omits

Do not restate unchanged constraints. **Do not repeat the full list of negative
safety confirmations** ("no SMS sent", "no Vercel change", "no HubSpot
modification", and so on) unless the task actually touched those systems, or
something unexpected happened that the user needs to know about. A single
"production changed: no" covers the ordinary case.

State what is unproven as unproven. Never let "tests pass" imply "this works in
production" when no live call has been made.
