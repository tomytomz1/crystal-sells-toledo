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

## Final report — maximum 250 words

- **branch / SHA / PR**
- **files changed**
- **material result** — what is now true that was not before
- **targeted tests** — what was run, and the result
- **CI status**
- **blockers or human action required**
- **production changed? yes / no**

Do not restate unchanged constraints. **Do not repeat the full list of negative
safety confirmations** ("no SMS sent", "no Vercel change", "no HubSpot
modification", and so on) unless the task actually touched those systems, or
something unexpected happened that the user needs to know about. A single
"production changed: no" covers the ordinary case.

State what is unproven as unproven. Never let "tests pass" imply "this works in
production" when no live call has been made.
