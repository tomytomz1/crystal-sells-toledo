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
An intermediate revision of
[#28](https://github.com/tomytomz1/crystal-sells-toledo/pull/28) — head
`15443b3`, **never merged to `main`** — added a time bound to `readFormBody()`
and called `req.destroy()` on every failure path. CI was **green** on that
revision. Against a real socket the client received `ECONNRESET` and never the
400 the handler believed it had sent. It was caught by independent review before
merge; what reached `main` (`6bdb507`) is the corrected version.

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
One match, live at the time: `api/_lib/security.mjs`. See the entry below;
corrected in [#30](https://github.com/tomytomz1/crystal-sells-toledo/pull/30).

**Promoted rule**
`CLAUDE.md` § Resource-ownership rule.

---

## 2026-09-11 — A material defect triggers a repo-wide pattern search

**Failure**
After the `req.destroy()` defect was understood, a search for it found
`api/_lib/security.mjs`, used by **`api/lead.js`, the live lead endpoint**.

Then the rule failed on its own first outing. The search actually run was
`grep -rn "\.destroy()" api/` — **an identifier grep**, which is precisely what
the rule it was documenting forbids. It found the identifier and stopped. A
second, behavioural pass — prompted by independent review, not by the rule —
found a second live match in the same function that the identifier grep could
never have surfaced, because the defect has no identifier in common with the
first.

**Why it mattered**
Two distinct defects sat on the **live** path while attention was on the inert
one. And a rule written to prevent exactly this was satisfied *textually* by a
search that did not do what the rule describes — a green tick over an unmet
invariant, in the process layer this time instead of the test layer.

**Why existing evidence missed it**
Nothing looked for it. The first defect was treated as belonging to the file it
was found in; the search that corrected that scoped itself to the token the
first defect happened to use.

**Permanent invariant**
A material defect is not isolated until the repository has been searched for the
same **behavioural** pattern — the shape, not the identifier. Name the shape in
words first, then choose queries that could find it written differently. One
defect can carry more than one shape; enumerate them.

**Required proof**
A recorded search: the shape stated in words, the queries, and the result.
Matches outside the current scope are **named and sequenced**, never silently
folded in — widening a reviewed change is how an unrelated regression arrives
with a green tick.

**Repo-wide search result**
Two shapes, stated in words before querying:

1. *A helper tears down a resource its caller still needs.*
   `grep -rn "\.destroy()" api/` → `api/_lib/twilio.mjs` (corrected in #28) and
   **`api/_lib/security.mjs:143`** — corrected in
   [#30](https://github.com/tomytomz1/crystal-sells-toledo/pull/30).
2. *An external stream is read to completion with no deadline.* Found by reading
   every request-body reader in `api/` rather than by token: `readBody()`'s
   streaming fallback in `api/_lib/security.mjs` registers `data`/`end`/`error`
   and waits indefinitely. Size-bounded, time-unbounded — the same shape #28
   fixed in `readFormBody()`. **Missed by search 1**; corrected in
   [#30](https://github.com/tomytomz1/crystal-sells-toledo/pull/30).

The claim is narrowed to what was measured. `readBody()` has **three** oversize
refusal paths — declared `Content-Length`, an already-parsed `req.body`, and
streaming accumulation — and **only the streaming one** calls `req.destroy()`.
The two fast paths reject before any teardown and are **not** claimed to be
defective. Whether Vercel Production reaches the streaming fallback for
`api/lead.js` at all is **unproven**; it has not been measured, and this file
does not assert it.

**Promoted rule**
`CLAUDE.md` rule 17 — sharpened to "search the shape, not the identifier",
because the identifier grep is the failure mode actually observed. **No new
permanent rule was promoted for the unbounded-read shape.** It is already
covered: `docs/WORKFLOW.md`'s adversarial-review attack list carries *Timeout
boundaries* and *Late async work*, and `CLAUDE.md` rule 14 already requires
real-boundary evidence for it. Adding a rule here would have made the ruleset longer
without changing a single future decision — which the promotion bar in
`docs/WORKFLOW.md` § Lesson promotion exists to refuse.

**Both `security.mjs` defects were recorded in `docs/CURRENT-STATE.md` as the
immediate next runtime task, deliberately not fixed by the process change that
created this file, and fixed in
[#30](https://github.com/tomytomz1/crystal-sells-toledo/pull/30) — where the
behavioural search, run as two named shapes rather than one token, returned zero
live matches for either.**

---

## 2026-09-11 — A delivered response is not the whole HTTP exchange

**Failure**
[#30](https://github.com/tomytomz1/crystal-sells-toledo/pull/30) fixed
`readBody()` so a refusal actually reached the client, and proved it **from the
client's side** with a real `node:http` server and client. Every assertion was
about what the client received, and every one of them was true.

The revision under review still carried a protocol defect. Measured on it:

```
partial body  + 408  ->  Connection: keep-alive, socket left open
chunked oversize+413 ->  Connection: keep-alive, socket left open
declared oversize+413->  Connection: keep-alive, socket left open
```

The endpoint answered before the request body had been consumed and still
advertised a persistent connection. It becomes usable again only if the client
sends the rest of the body it declared — which, on the timeout path, is by
definition what it did not do. A client that pools connections, which is all of
them, can reuse one the server will not serve.

**Why it mattered**
The response's own framing metadata was false. Earlier prose called this "a
resource question, not a correctness failure" and repeated that in the source,
`CURRENT-STATE`, the update document and the pull-request description. The
classification, not just the sentence, was wrong.

**Why existing evidence missed it**
`CLAUDE.md` rule 15 was **followed**: the outcome was asserted from the
observer's side. The gap was in what "the outcome" was taken to mean — the
status line and the body, and nothing about the state the exchange left behind.

The harness made it structurally unobservable as well. Its `finally` destroyed
the client socket and called `closeAllConnections()` as soon as the response had
been seen, so the connection was always torn down by the test before any
assertion about it could be made. **A teardown that runs before the observation
is not a teardown; it is the experiment.**

**Permanent invariant**
For a protocol exchange, the observable outcome includes **what the exchange
leaves behind** — connection state, framing, and what the peer is now entitled
to do next — not only the message that arrived.

**Required proof**
Observe the connection **after** the response and **before** any teardown: what
`Connection` was advertised, whether the server closed, and whether a subsequent
request on that connection is actually served. Where a harness tears down to
avoid hanging, that teardown must come after the observation window, not before.

**Repo-wide search result**
Shape: *a server answers while the request body has not been completely consumed
and leaves the connection persistent.* Six live paths in `api/lead.js`
(405/403/429 before the read; 413/408/400 on refusal) — all corrected in #30 by
one rule at the response boundary. The same shape is present in both **inert**
gate 7 endpoints around `readFormBody()`; recorded as sequenced follow-ups and
deliberately not widened into.

No smuggled second request was reproduced against Node's own parser, in either
the `pause()` or the no-`pause()` variant. That is recorded as not reproduced
rather than asserted.

**Promoted rule**
**Sharpens `CLAUDE.md` rule 15**, which previously read as being about the
*message*. A new rule was considered and rejected: rule 15 was already the right
rule and was already being followed — it was its **scope** that was too narrow,
and widening the existing rule is what changes the next decision. Adding a
twenty-first rule beside it would have duplicated it.

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
