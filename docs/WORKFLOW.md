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

## Pre-handoff adversarial review

**When it is required.** Tier 3 and Tier 4 work, and any change involving
security, authentication, secrets, PII, consent, suppression, CRM writes,
external side effects, or money or lead-loss risk. Below that it is not
required, and it should not be performed for its own sake.

**When it happens.** After implementation, and after the targeted tests for the
tier have passed — and *before* the pull request is described to the operator as
ready. Not during implementation: the pass is worth something only because it is
separate, and because its posture is different.

**How many passes.** **One.** If that pass finds and fixes a material defect,
re-review **the correction delta only**, once. That is the end of it. Do not
re-read the whole diff again, do not loop, and do not keep going until nothing
can be found. A pass that finds nothing material ends with **no commit**.

### The pass

1. **Stop implementing.** Re-read the complete diff cold, top to bottom.
2. **Assume at least one defect is still there.** "This is probably fine" is not
   the starting prior.
3. **Do not defend the implementation merely because Claude wrote it.** Authorship
   is not evidence.
4. **Check the changed behaviour against the written contracts, not against
   memory** — `CLAUDE.md`, `docs/CURRENT-STATE.md`, `docs/WORKFLOW.md`, the task
   or design document, and the contracts of the modules the diff directly
   affects.
5. **Attack it**, using the list below.
6. **Ask both questions in words**, and answer them in writing.
7. **Where a critical regression genuinely warrants a mutation proof**, prove it
   against the pre-fix code or a throwaway worktree. **Never against the
   deployment candidate**, and never by breaking the working tree and restoring
   it — `CLAUDE.md`, Testing.
8. **Fix material findings before presenting the pull request.**
9. **A new material defect gets the smallest strong regression test that
   reproduces its actual failure mode**, and its correction delta gets the one
   delta review from above.
10. **Nothing material found → no commit.** Record that the review ran and found
    nothing. An empty finding is a legitimate outcome.

### What to attack

- **Fail-open behaviour.** What does this do when its dependency is absent,
  slow, or refusing? Does a failure cost the thing it should cost, and nothing
  more?
- **Timeout boundaries** — setup and transport creation, the **response
  headers**, *and* the **response body**. `fetch()` resolves when the headers
  arrive; a server that answers and then stalls the body runs on with the abort
  already disarmed.
- **Late async work** — anything still running after the response was sent.
- **Race conditions**, **retries**, **idempotency** — and whether the
  idempotency *key* is exactly as narrow or as broad as the prose says it is.
- **Partial-success truthfulness.** Is something partly done reported as done?
- **Accounting and tally invariants.** Do the buckets sum to the population?
  Can a case fall into none of them, or into two?
- **Silent truncation or coercion.** Rule 11 is reject, never truncate.
- **Malformed, empty and oversized inputs.**
- **Weak configuration checks** — a present-but-useless value read as
  configured.
- **Secret and PII exposure** — logs, error text, mail headers, subjects, URLs.
- **GET and scanner side effects.** Safe Links, mail-gateway antivirus and
  preview fetchers issue unattended GETs.
- **Accidental unsuppression.** Anything that could clear a suppression.
- **Stale documentation** — a sentence elsewhere in the repository that this
  diff has just made false.
- **Tests that pass vacuously** — a mutation whose `replace()` no longer
  matches, an assertion satisfied by a page that omits the claim, a bound
  satisfied by a run twice as slow as the budget.
- **Static guards that are syntactically satisfied without protecting the
  invariant they are named for.**

### The two questions

> **"If an independent security or compliance reviewer wanted to block this pull
> request, what would they point to?"**

> **"What guarantee does the prose claim that the code itself does not actually
> guarantee?"**

The second is the one this repository keeps failing. Answer both in the pull
request, not only in the session.

### Why this exists

PR [#24](https://github.com/tomytomz1/crystal-sells-toledo/pull/24) passed its
targeted tests at every head it had, and four review rounds each still found a
real defect in its own work: a deadline that did not cover transport creation, a
projection bound checked only between requests, a bound that stopped at the
response headers, a static guard that passed while its invariant was broken, and
a tally that lost an already-marked contact. There were passing tests over all of
them.

**Passing tests are evidence, not proof that the tested invariant is the right
invariant.** They prove the code does what the test asserts. They do not prove
the assertion is the thing that had to be true.

### What this does not change

The risk-based tiers in `CLAUDE.md` stand exactly as written. This is a reading
pass, not a test tier: it authorises **no** local full-suite run, **no** routine
mutation run, and **no** test the tier table did not already call for. The only
test it may add is the single regression for a material defect it actually
found.

## Lesson promotion

**When.** After a material defect is understood and corrected, and **before** the
handoff — the last step of the pre-handoff review above, not a separate ceremony.
It runs on **material** findings only: the ones that cost, or could have cost,
correctness, compliance, a lead, a consumer's request, or the operator's trust in
a record.

**It does not run on ordinary corrections.** A typo, a rename, a formatting fix,
a test that needed a better name — those end in a commit message.

### The seven questions, answered in writing

1. **What class of failure was this?** Name the class, not the line.
2. **Why did the existing tests, review or evidence miss it?** "Nobody looked" is
   an answer; so is "the assertion was true but was not about the invariant".
3. **What proof would have caught it earlier?** If none can be named, this is an
   observation rather than a lesson, and it stops here.
4. **Does the same behavioural pattern exist elsewhere in the repository?**
   Search the **shape**, not the identifier, and record the query and its result.
5. **Is the lesson material, reusable and likely to recur?** All three, or it
   stops here.
6. **If promoted, where does it belong?**
   - `CLAUDE.md` — the compact, non-negotiable, permanent rule;
   - `docs/WORKFLOW.md` — a reasoning or process rule;
   - `docs/ENGINEERING-LESSONS.md` — the reusable lesson and its rationale;
   - `docs/CURRENT-STATE.md` — **current truth only**, never history.
   A lesson usually earns **one** home. Repeating it in three is how a rule set
   becomes unreadable and how the copies drift apart.
7. **Did the new evidence make any current-design prose false?** Comments, test
   names, documentation, UI wording, open pull-request descriptions. Correct
   those; leave historical handoffs alone and supersede them instead.

### Two rules with teeth

**A material finding is not finished until question 4 has actually been
performed** and any relevant out-of-scope matches are recorded and sequenced.
Recording them is the whole obligation — **do not widen the current change to
absorb them**, because a reviewed change that quietly grows is how an unrelated
regression arrives with a green tick.

**The outcome is recorded where someone can see it.** When a material defect was
involved, the handoff carries a **Lesson promotion** line stating what was
promoted, or that nothing was — **with the reason**, and with the repo-wide
search and its result. Judging alone and in silence is the one way this section
can be satisfied while changing nothing; a stated judgement can be disagreed
with. The heading is omitted entirely when no material defect was involved, so
this costs ordinary work nothing.

**Do not manufacture a rule for every correction.** Promotion is meant to be
uncommon. `docs/ENGINEERING-LESSONS.md` is only useful while it is short enough
to read end to end; if it stops being worth reading, the correct fix is to
**remove weak entries**, not to add more. A session that promotes nothing has
done this step correctly whenever nothing cleared the bar — and saying so in the
handoff is the expected outcome, not a gap.

### The technical-compliance trap

The question to ask before claiming this step is done:

> **"If I wanted to satisfy this section while learning nothing, what would I
> write?"**

The answers are recognisable: a lesson that restates the diff; an invariant
phrased so broadly that no future change could violate it; a "repo-wide search"
that grepped the identifier rather than the behaviour; a new rule that duplicates
one already in `CLAUDE.md`. **Each of those is a failed promotion**, and the
correct response is to promote nothing and say so.

## Delivery

Where the section above applies, the adversarial review comes first — before
step 3's description of the pull request, and before the operator is told it is
ready.

1. **Commit** with a message explaining *why* — the failure or the risk the change
   addresses, not a restatement of the diff.
2. **Push** with `git push -u origin <branch>`. Retry network failures with
   backoff; never switch branches to get a push through.
3. **Open a pull request** describing what changed, what was verified, and what is
   explicitly still unproven.
4. **Let CI run.** Fix only genuine failures. Read it, never wait on it — see
   § CI below.
5. **Do not merge unless explicitly instructed.**
6. **No follow-up SHA-only documentation commit.** Nothing in `docs/` pins a
   commit SHA, so nothing needs pinning after the fact. Give the SHA in the
   report; git history is the record.

Write a `docs/updates/` file only when `CLAUDE.md` says one is warranted. Update
`docs/CURRENT-STATE.md` only when material current state changed.

## CI — read it, never wait on it

**Never create a background Bash task whose purpose is waiting or polling for
GitHub CI.** Specifically prohibited:

- a background `sleep` loop, of any length or nesting;
- a task conceived as "wait for CI", "keep waiting for CI" or a "final wait";
- more than one polling shell at a time;
- **any sleep or waiter process still alive when the session ends.**

CI runs whether or not anything is watching it. A waiter buys no information; it
only consumes the session and can outlive it.

### The procedure

1. **Push** normally.
2. **Let GitHub CI run.**
3. **Read CI directly when a result is actually needed** — the workflow run
   *and* its job. That is `status` and `conclusion`, not the logs: the existing
   rule stands, **complete logs are inspected only on failure.**
4. **Create no background waiter process.** None.
5. **If the run is complete, record the actual `status` and `conclusion`** — the
   reading taken, not the result expected.
6. **If it is still pending at the last check before the final response, report
   it honestly as pending, and stop.** Pending is a publishable result. Saying so costs
   nothing; implying green costs the record its credibility.
7. **A later pulse verifies completion independently.** That is exactly what the
   Pulse protocol is for, and a correction comment on the pull request is the
   normal way it lands — see rule 5 of the Pulse rules and the correction
   comments on [#24](https://github.com/tomytomz1/crystal-sells-toledo/pull/24).
8. **Never infer elapsed CI time from how long the session feels.** A session's
   sense of duration is not a clock. Use the run's own `run_started_at`,
   `completed_at` and step timestamps, or claim nothing.
9. **Before the final chat response, confirm that no CI-wait, polling or sleep
   process under Claude's control is left running in the current environment.**
   That covers **leftovers discovered from earlier work**, not only tasks this
   session created — waiters have been found alive from a previous round. It is
   scoped to CI-wait tasks Claude created: **never kill an unrelated user or
   system process.**

**Do not replace the waiters with polling.** No invented re-check cadence, no
"check every N minutes" rule. Read CI when a result is needed, and otherwise
leave it alone.

### Reading a run whose status is stale

**A reported status can be stale.** This environment has repeatedly returned
`in_progress` for tens of minutes after a job had actually finished, and has
repeatedly returned the same stale-looking CI state across the run, job, check
and usage surfaces. **Their agreement therefore must not be treated as
independent corroboration.**

That is the whole of what has been observed. **Do not record a mechanism for
it** — nothing here has established where the staleness comes from, and this
project has already been hurt by a plausible diagnosis written down as a fact.

So: read `completed_at` and `conclusion` when they are available, prefer the
**job** as well as the run, and give the observed timestamps rather than a
duration you inferred. When they are not available, **report pending honestly**
and let a later pulse verify.

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

### Lesson promotion
<ONLY when a material defect was involved; omit the heading entirely otherwise.
State the outcome and the reason — including "nothing promoted", which is the
common and correct answer. Name the repo-wide search that was run and what it
returned. See § Lesson promotion.>

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
