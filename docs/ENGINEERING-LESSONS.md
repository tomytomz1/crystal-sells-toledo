# Engineering lessons

Reusable institutional memory: the **reasons** behind this project's permanent
rules, so a later session inherits the judgement and not just the rule.

## What this file is not

**This is not a diary, and not a bug history.** Most defects belong in a commit
message and nowhere else. Most corrections teach nothing reusable.

A lesson is admitted here only when **all four** are true:

1. **Material** — it cost, or could have cost, correctness, compliance, a lead,
   a consumer's request, or the operator's trust in a record.
2. **Reusable** — it generalises past the file it was found in.
3. **Likely to recur** — the same shape can plausibly appear again in this
   repository.
4. **Decision-changing** — a future implementation or review decision would go
   differently for having read it.

Typos, formatting, one-off slips and "I misread the code" do not qualify. **If
the lessons file stops being worth reading end to end, it has failed**, and the
right correction is to remove entries rather than to add more.

**Cost of admission.** Each entry must name the proof that would have caught the
failure earlier. An entry that cannot name one is an observation, not a lesson,
and does not belong here.

## When to read it

Not always — see `CLAUDE.md` § Context economy. Read the entries relevant to the
area in hand when the work involves a material defect, security, consent or
suppression, a runtime or provider boundary, or an adversarial review of a
failure class that has bitten before. **Do not read the archive for a typo.**

## How an entry is added

`docs/WORKFLOW.md` § Lesson promotion. The short version: after a material
defect is understood and corrected, answer its seven questions in writing, and
promote only what survives them.

---

## 2026-09-11 — Green CI proves the assertions, not the invariant

**Failure**
[#28](https://github.com/tomytomz1/crystal-sells-toledo/pull/28) shipped a time
bound for `readFormBody()` with `req.destroy()` on every failure path. CI was
**green**. Against a real socket the client received `ECONNRESET` and never the
400 the handler believed it had sent.

**Why it mattered**
Every refusal the webhook and the operator action make — a stalled body, an
oversize body — was being discarded on the wire while the logs recorded a
delivered response. An endpoint that reports refusals it did not deliver is
worse than one that fails loudly.

**Why existing evidence missed it**
The suite asserted what the handler did (`res.statusCode`, `res.end()` not
throwing) and never what the client received. Every assertion it contained was
true. The assertions were simply not about the thing that had to be true.

**Permanent invariant**
A passing suite is evidence about the behaviour its assertions actually observe.
It is not evidence that the abstraction is right, that a mocked boundary matches
the real one, or that the externally observable outcome occurred.

**Required proof**
For a claim of the form "X happens", an assertion that observes X — not an
assertion that observes the call believed to cause X.

**Repo-wide search result**
See the `req.destroy()` entry below.

**Promoted rule**
Sharpens `CLAUDE.md` rule 13 ("never let tests pass imply this works in
production"), which previously read as being about *live* calls only. It is also
about mocked boundaries and unobserved outcomes.

---

## 2026-09-11 — Mocks prove local logic; real boundaries need real proof

**Failure**
`readFormBody()`'s tests drove a real `EventEmitter`, which was chosen
deliberately so that listener removal and the "an `error` with no listener
throws" rule would be genuine. It was still the wrong boundary: an
`EventEmitter` has **no socket**, so nothing it could do would show what
`req.destroy()` does to the `ServerResponse` sharing that socket.

**Why it mattered**
The strongest-looking evidence in the pull request was structurally incapable of
observing the defect.

**Why existing evidence missed it**
A better stub is still a stub. The gap was not fidelity; it was that the claim
under test belonged to a boundary the test did not include.

**Permanent invariant**
When a material correctness claim depends on behaviour owned by Node HTTP,
Vercel, Twilio, HubSpot, Postgres/Neon, SMTP, a browser or another provider,
the strongest evidence is a test at the **lowest practical real boundary** that
can carry the claim.

**Required proof**
Climb only as far as the claim needs, and no further:

| Claim about | Lowest practical real boundary |
|---|---|
| socket / response semantics | a real local `node:http` server and client |
| rendered browser behaviour | a browser/render test |
| database privileges | a controlled real role against a real database, where permitted |
| provider-specific production behaviour | provider evidence — only when genuinely required and safe |

**This does not license live external calls.** A local real boundary beats a
mock; a live provider call is not automatically better than a local one, and
carries real cost — a live CRM write, a real SMS, a real charge. Reach for the
provider only when the claim is genuinely about the provider.

**Repo-wide search result**
Not a code pattern; a testing-strategy lesson.

**Promoted rule**
`CLAUDE.md` § Boundary-evidence rule.

---

## 2026-09-11 — Assert externally observable outcomes from the observer's side

**Failure**
The requirement was *"the client receives 400"*. What was asserted was
`res.statusCode === 400`, that `res.end()` did not throw, and that
`res.writableEnded` was true. **All three were true. The client received
`ECONNRESET`.**

**Why it mattered**
`res.end()` on a destroyed socket succeeds and reports the response as ended.
The handler cannot tell from the inside, so an inside-only assertion is
structurally blind to the failure.

**Why existing evidence missed it**
The assertions were written from the sender's vantage point because that is the
vantage point the handler has.

**Permanent invariant**
When the requirement is externally observable, assert it from the observer's
side where practical.

**Required proof**
Examples, illustrative rather than a checklist:

- "the client receives 400" → read the status **at the client**;
- "HubSpot accepted the property" → the accepted response, not a built payload;
- "the role cannot `SELECT`" → an attempted `SELECT` that is refused, not grant
  text that appears to say so.

**Repo-wide search result**
The suppression ledger's privilege claims were already proven this way — by
attempted `SELECT`/`UPDATE`/`DELETE` refused with `42501` under the role's own
login. The practice existed; it had not been generalised into a rule.

**Promoted rule**
`CLAUDE.md` § Externally-observable-outcome rule.

---

## 2026-09-11 — A helper does not own the caller's resources

**Failure**
`readFormBody()` — a body reader — called `req.destroy()`, destroying the socket
that the caller still needed in order to answer.

**Why it mattered**
`req` and `res` share one socket. A helper that "cleaned up after itself"
silently took the caller's ability to respond, and the caller was never told.

**Why existing evidence missed it**
`destroy()` reads as diligence. Two tests asserted `destroyCount === 1` as proof
of correct cancellation — **they passed because they asserted the bug.**

**Permanent invariant**
A helper may stop **its own** work. It must not destroy, close, release or mutate
a resource the caller still needs unless ownership is explicit and the behaviour
is proven at the right boundary.

**Required proof**
Where a helper touches a shared resource, prove the caller can still complete
its operation afterwards — from the caller's or the observer's side.

**Repo-wide search result**
One match, live: see the entry below.

**Promoted rule**
`CLAUDE.md` § Resource-ownership rule.

---

## 2026-09-11 — A material defect triggers a repo-wide pattern search

**Failure**
After the `req.destroy()` defect was understood, a search for the same
behavioural pattern found `api/_lib/security.mjs`, which calls `req.destroy()`
on its oversize path — on **`api/lead.js`, the live lead endpoint**. By the same
measurement, an oversize lead body cannot deliver its refusal either; the
visitor gets a connection reset.

**Why it mattered**
The same defect had been sitting on the **live** path, unexamined, while
attention was on the inert one. Without the search it would have stayed there.

**Why existing evidence missed it**
Nothing looked for it. The defect was treated as belonging to the file it was
found in.

**Permanent invariant**
A material defect is not isolated until the repository has been searched for the
same **behavioural** pattern — the shape, not the identifier.

**Required proof**
A recorded search (the query and its result). Matches outside the current scope
are **named and sequenced**, never silently folded in: widening a reviewed change
is how an unrelated regression arrives with a green tick.

**Repo-wide search result**
`grep -rn "\.destroy()" api/` → two matches: `api/_lib/twilio.mjs` (fixed in
#28) and **`api/_lib/security.mjs:143`, live, outstanding**.

**Promoted rule**
`CLAUDE.md` § Repo-wide anti-pattern search rule. **`security.mjs` is recorded in
`docs/CURRENT-STATE.md` as the immediate next runtime task and is deliberately
not fixed by the process change that created this file.**

---

## 2026-09-11 — Prose may not claim more than the evidence

**Failure**
A recurring class, not one incident:

- `api/twilio-inbound.js` and `api/operator-action.js` said a durable ledger
  append made a suppression *"already effective"* / *"already enforced"* while
  gate 8 did not exist;
- a test asserted late events *"have already fired by now"* when they were
  scheduled seven seconds after the handler had answered, on a timer that might
  never fire;
- a test was named *"leaves no timer or listeners behind"* against a function
  that **deliberately retains** its `error` listener;
- a comment claimed Node closes the connection after the response. Measured: it
  sends `Connection: keep-alive` and the socket survives.

**Why it mattered**
Each was inherited or copied forward and read as established fact. The first
propagated from one header comment into two endpoints and four documents.

**Why existing evidence missed it**
Prose is not executed. Nothing fails when a comment is wrong — and a confident
sentence is read by the next session as a finding rather than a guess.

**Permanent invariant**
Current-design comments, test names, documentation, PR descriptions, handoffs
and UI wording may not state a stronger guarantee than the implementation and
evidence support.

**Required proof**
Each load-bearing claim is either measured, or marked as reasoning. **An
inherited sentence is not evidence, and copying it forward is not verification.**

**Repo-wide search result**
The "already effective" wording was found in two endpoints and four merged
documents; all were corrected in
[#26](https://github.com/tomytomz1/crystal-sells-toledo/pull/26) and
[#27](https://github.com/tomytomz1/crystal-sells-toledo/pull/27).

**Promoted rule**
`CLAUDE.md` § Evidence/prose rule.

---

## 2026-09-11 — Historical handoffs are evidence

**Failure**
Several handoffs were later proved wrong: one recorded a suppression as
enforced, one described `destroy()` as correct cancellation, several recorded CI
as pending when it had completed.

**Why it mattered**
The temptation is to edit them so the record looks clean. That destroys the most
useful artifact the project has: the difference between what was believed and
what was true, and how long the gap lasted.

**Why existing evidence missed it**
Not a missed defect — a standing temptation.

**Permanent invariant**
Do not rewrite a historical handoff because later evidence proved it wrong.
Preserve it and post a **superseding** correction that names what it supersedes.

**Required proof**
The superseding record states the SHA or comment it corrects, and the original
stays unedited.

**Repo-wide search result**
n/a.

**Promoted rule**
Already in `docs/WORKFLOW.md` § The Pulse Handoff Protocol; this entry records
**why** — and the specific value of a green CI run sitting in the record above a
defect it did not catch.

---

## 2026-09-11 — Inactivity is not enforcement

**Failure**
Both suppression endpoints described a durable ledger append as making an
opt-out *"already effective"*. Nothing enforces it: gate 8 has not begun, nothing
in `api/` calls `get_suppression_state()`, and no automated outbound sender
exists.

**Why it mattered**
"No sender is active today" is a property of the **current deployment**. Reading
it as "suppression is enforced" means the day a sender is switched on, the
protection everyone believes exists does not.

**Why existing evidence missed it**
The claim was true in effect (nothing was sent) and false in mechanism (nothing
enforced it). Effect and mechanism agreed by accident.

**Permanent invariant**
Keep three states distinct and never let one stand for another:

1. **durable evidence** — the record exists and cannot be altered;
2. **operational projection** — a best-effort copy for humans to see;
3. **active enforcement** — something reads the record *before acting*.

**Required proof**
A claim of enforcement names the code path that performs the check.

**Repo-wide search result**
Corrected in both endpoints and four documents (#26, #27).

**Promoted rule**
`CLAUDE.md` § Inactivity-is-not-enforcement rule. Gate 8 is what will make the
ledger authoritative at send time, and it must exist before any automated
outbound communication is activated.
