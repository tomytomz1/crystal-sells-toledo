# The lead endpoint's body read — bounded in size and in time

**Date** 11 September 2026
**Pull request** [#30](https://github.com/tomytomz1/crystal-sells-toledo/pull/30)
**Files** `api/_lib/security.mjs`, `api/lead.js`, `tests/api.test.mjs`,
`tests/helpers.mjs`, `CLAUDE.md`, `docs/CURRENT-STATE.md`,
`docs/ENGINEERING-LESSONS.md`, `docs/updates/2026-09-11-readformbody-time-bound.md`

**Revised after independent review.** The first revision (`2416c375`) fixed two
defects and introduced a third classification error; see *"Correction — the
connection lifecycle"* below. Three defects are fixed in total.

This document assumes no repository access and no memory of earlier sessions.

---

## What was wrong, and why it mattered

`api/lead.js` is the only server-side entry point for website leads. It reads the
request body through `readBody()` in `api/_lib/security.mjs`. That function had
three ways to refuse an oversize body and one streaming fallback. **Two defects
were present in the streaming branch of that code path**, and a third — the
connection lifecycle, covered further below — affected every early response the
endpoint makes, streaming or not.

Whether Vercel Production reaches the streaming fallback at all is **unproven**
throughout this document, so the first two are described as present in the live
endpoint's code path rather than as observed in Production.

### Defect 1 — the refusal was destroyed along with the request

When streamed bytes crossed `MAX_BODY_BYTES` (16 KB), `readBody()` rejected and
then called `req.destroy()`.

In Node's HTTP server, `req` (`IncomingMessage`) and `res` (`ServerResponse`)
**share one socket**. Destroying the request destroys the response with it — and
the handler is never told:

```
req.destroy()  ->  req.destroyed = true AND socket.destroyed = true
                   res.end() does NOT throw
                   res.writableEnded becomes true
                   the client receives ECONNRESET, never the status
```

So a visitor whose submission was too long received a **connection reset**, while
the server logged a `413` it had never delivered. An endpoint that reports
refusals it did not make is worse than one that fails loudly.

This is the same defect [#28](https://github.com/tomytomz1/crystal-sells-toledo/pull/28)
measured and fixed in `api/_lib/twilio.mjs`. It was found on the live lead path
by the repo-wide behavioural search that #28's defect triggered, recorded in
`docs/CURRENT-STATE.md`, and deliberately left for this pull request.

### Defect 2 — the streaming read had no deadline

The streaming fallback registered `data`, `end` and `error` and then waited
indefinitely. A client that opened a request, sent part of a body and stalled
held the invocation until the platform ended it. `readBody()` had **no
code-level bound of its own**, only a size bound.

### Why the existing test suite was green over both

`tests/helpers.mjs` `mockReq()` sets `req.body`. **Every pre-existing test in
`tests/api.test.mjs` therefore took the already-parsed fast path**, and the
streaming branch — the only branch either defect lived in — was never executed
by any test. The suite's existing `413` test sets a `Content-Length` over the
cap, which takes the *header* fast path. Both defects were invisible, and the
suite was green for as long as they existed.

---

## What changed

### `api/_lib/security.mjs`

`readBody(req, { timeoutMs })` now has a single guarded exit. The two fast paths
are **unchanged and arm no timer**:

| Path | Refuses | Behaviour |
|---|---|---|
| declared `Content-Length` over the cap | yes | unchanged — refused before a byte is read |
| an already-parsed `req.body` over the cap | yes | unchanged — measured in hand and refused |
| **streaming accumulation crossing the cap** | yes | `req.pause()`, **never `req.destroy()`** |
| **streaming read exceeding the deadline** | yes | **new** |

Everything settles through one `finish(err, value)` guarded by a `settled` flag,
which clears the timer, removes the `data` and `end` listeners, releases the
accumulated chunks, and — on a failure — calls `req.pause()`.

Three choices are deliberate and are documented in the source:

- **`pause()`, never `destroy()`.** A helper may stop its own work; it must not
  destroy a resource the caller still needs. `readBody()` reads a body and does
  not own the response socket.
- **The `error` listener is deliberately left attached.** An `error` event with
  no listener is *thrown* by `EventEmitter`, which on a serverless runtime takes
  the invocation down after the response was sent. `onError` is a no-op once
  settled, so leaving it attached absorbs a late error harmlessly. No test or
  comment claims this function "leaves no listeners behind", because it does not.
- **The timer is not `unref()`'d.** An unref'd timer does not hold the event loop
  open, so the loop could empty before the bound fired — the exact case the bound
  exists for.

New exports: `BODY_READ_TIMEOUT_MS`, `BODY_READ_TIMED_OUT`, `PAYLOAD_TOO_LARGE`
and `bodyErrorReason(err)`. The error objects carry **both** `.token` and
`.message`, so callers that matched on `err.message` keep working.
`bodyErrorReason()` reads only the token and returns one of three fixed strings,
so no caller can accidentally log parser text containing a fragment of what a
visitor typed.

### Where the 5-second bound comes from

`api/lead.js` has a **30 s `maxDuration`** (`vercel.json`) and **no third-party
clock on either side**: the browser posts with a plain `fetch()` and no
`AbortController` (`assets/js/main.js`), and a human is waiting.

What the 30 s must still cover once the body is in hand, at the ceiling each
module declares for itself:

| Step | Ceiling |
|---|---|
| consent ledger append | 3 s (`LEDGER_TIMEOUT_MS`), feature-gated |
| `createLead()` | 8 s (`HUBSPOT_TIMEOUT_MS`) **per request** — 3 requests on the ordinary path, 5 on the create-conflict race |
| acknowledgement mail | nodemailer connection 5 s / greeting 5 s / socket 8 s, per phase, **no single overall deadline** |

**Those ceilings are not additive-realistic, and this document does not pretend
they are.** Three HubSpot requests at 8 s each is already 24 s of a 30 s budget,
and the endpoint has always depended on them not all being hit at once. That is
a pre-existing property, recorded here and **not** changed by this work.

So the bound is not a subtraction. Two things set it:

- **What a legitimate body costs.** The cap is 16 KB. A visitor on a poor mobile
  uplink — call it 50 kbit/s sustained — delivers 16 KB in about **2.6 s**. 5 s
  is roughly double that. **This is the side that matters**: refusing a
  slow-but-genuine upload on the lead path *loses the lead*, which this project
  treats as the worst outcome. Too tight is not the safe direction.
- **What a stalled body may cost.** 5 s is a sixth of the budget and less than
  one HubSpot request's ceiling, so a client that never finishes can never become
  the dominant consumer of the invocation.

5 s is also what `api/operator-action.js` already takes — the other 30 s function
with no third-party clock. The webhook's 3 s is deliberately **not** copied: that
one is bound by a 15 s `maxDuration` *and* Twilio's own ~15 s clock.

**The deadline is total, not an inactivity gap.** It is armed once, in the same
tick `readBody()` is called, and never reset by an arriving chunk. A client
dribbling one byte per second forever is exactly as bounded as one sending
nothing.

### `api/lead.js` — the resulting response contract

| Condition | Before | After |
|---|---|---|
| oversize body | `413 PAYLOAD_TOO_LARGE` | unchanged |
| **body read timed out** | `400 BAD_REQUEST` | **`408 BODY_READ_TIMED_OUT`** |
| stream error / unreadable | `400 BAD_REQUEST` | unchanged |

**Why 408.** The request was not malformed; it never finished arriving. Labelling
an incomplete upload `BAD_REQUEST` tells the visitor — and anyone later reading
the logs — that they sent something wrong, which is a claim this endpoint cannot
support. `code` is machine-readable and is held to the same standard as prose.

Returning here is safe: **no complete body was accepted**, so no lead was
created, and a repeated submission duplicates nothing. (Bytes usually *have* been
read on the timeout path — that is exactly what the tests exercise. What holds is
that nothing is handed to the parser, the partial bytes are discarded, and no
lead-processing step runs.) `assets/js/main.js` treats every non-2xx alike —
it reads `code` for analytics and shows `message` — so **the visitor-facing
behaviour is unchanged** and the form keeps their input either way. **This
document makes no claim about how any particular browser or intermediary reacts
to a 408 on a POST; that has not been measured, and the safety argument does not
depend on it.**

A body-read failure also now logs `lead.body_failed` with a PII-free reason
(`too_large`, `timed_out`, `unreadable`) and nothing else.

**Lead-flow ordering after a successful body read is unchanged**: parse →
validate → consent evidence → ledger → HubSpot → acknowledgement.

---

## Test results

`npm run test:unit` — **119 tests, 119 passing, 0 failing.**

The new section drives a **real `node:http` server and client** and asserts from
the client's side, because the invariant is what the client receives and a stub
`req` has no socket to lose (`CLAUDE.md` rules 14 and 15).

| Proof | From |
|---|---|
| streamed oversize → the client receives **413**, not `ECONNRESET` | client |
| stalled stream → the client receives **408** | client |
| a body still dripping past the deadline is refused | client |
| an ordinary streamed body still succeeds, byte-for-byte | client |
| a slow body **inside** the bound still succeeds | client |
| declared-length fast path still refuses, without waiting | client |
| already-parsed `req.body` still works, without waiting | client |
| oversize already-parsed `req.body` still refused | client |
| **the real `api/lead.js` handler** stops at the body read and never reaches delivery | client |
| **control:** a complete body over the same socket *does* reach delivery (503) | client |

Connection-lifecycle proofs, added after independent review. These use a **raw
socket** and observe for a fixed window with **nothing torn down**, because the
earlier harness destroyed the connection as soon as the response was seen —
which is precisely what must not be measured through:

| Proof | Observed |
|---|---|
| partial body + 408 → complete refusal, `Connection: close`, server closes, nothing further dispatched | client |
| chunked oversize + 413 → same | client |
| declared-length oversize + 413 → same, whether the client sent the body or not | client |
| pre-parsed refusal → closes, because this server did not consume the body | client |
| **a bodyless refused request keeps keep-alive** — nothing is outstanding | client |
| **an ordinary complete request keeps keep-alive and the connection is reused** (two requests, two responses) | client |
| a pre-body refusal (405 with a declared body) also closes | client |
| a stream error whose message spells a token answers **400**, not 413 | client |

**How the streaming branch is actually reached**, measured against a real client
on a throwaway copy of the tree with the two branches temporarily given distinct
tokens:

```
declared Content-Length over the cap  ->  the HEADER fast path
chunked, no Content-Length, over cap  ->  the STREAMING size check
```

Every streaming test therefore omits `Content-Length`. **A test that declares an
oversize length is testing the header check, whatever its name says.**

### Mutation proofs

Run against **throwaway copies** of the tree, never the deployment candidate
(`CLAUDE.md`, Testing). Three targeted mutations, each reproducing one defect:

| Mutation | Result |
|---|---|
| `req.pause()` → `req.destroy()` | 3 tests fail; **the client receives `ECONNRESET`** instead of 413/408 |
| the streaming timer removed | 2 tests fail — "the bound did not fire" |
| the total bound rewritten as an **inactivity** bound | the drip test fails at **1502 ms** against a 300 ms bound |

The third mutation caught a defect in this change's own first draft: the drip
test originally asserted `ms < 2000`, which an inactivity timer settling at
~1500 ms would have **passed**. The threshold is now 900 ms, which sits clear of
both. That is the "a bound satisfied by a run twice as slow as the budget" item
from the attack list, found in this work's own test.

---

## The adversarial review

One pass plus one correction-delta review, per `CLAUDE.md`. The pass found three
material findings, all fixed before this pull request was presented:

1. **The "nothing downstream runs" test re-implemented `api/lead.js` inside the
   test** instead of driving it. It proved how `try` works, not what the endpoint
   does. Replaced with a test that calls the **real exported handler** over a real
   socket — plus a **control** test proving a complete body *does* reach delivery
   (503, `HUBSPOT_ACCESS_TOKEN` being absent in the test environment), without
   which "not 503" would be an assertion that could never fail.
2. **The claim that the bound is total rather than an inactivity gap had no
   test.** True by inspection, untested — prose outrunning evidence. Added the
   dripping-client test, then verified it discriminates by mutation.
3. **`api/lead.js` asserted that browsers do not auto-retry a POST on 408.** Not
   measured here. Reworded so the safety argument does not rest on it.

### The two questions

> *If an independent security or compliance reviewer wanted to block this, what
> would they point to?*

The `408` is a response-contract change on the live lead path. It is deliberate,
argued above, invisible to the existing client, and does not alter any success
path. They would also ask for evidence that a body failure cannot reach the CRM —
which is exactly what the real-handler test and its control now provide.

> *What guarantee does the prose claim that the code does not actually
> guarantee?*

After the fixes above, one gap is stated rather than closed: the source says the
fast paths **arm no timer**, and the tests prove only that those paths **do not
wait** (`ms < 1000`). The stronger claim is verifiable by reading — both paths
`return` before the `setTimeout` — and is not asserted as tested anywhere.

---

## Correction — the connection lifecycle (independent review of `2416c375`)

### The finding

The first revision fixed *delivery* and proved it from the client's side. It did
not fix the **exchange**. Measured on `2416c375` with a raw socket:

```
partial body      + 408  ->  Connection: keep-alive, socket left open
chunked oversize  + 413  ->  Connection: keep-alive, socket left open
declared oversize + 413  ->  Connection: keep-alive, socket left open
complete body     + 200  ->  Connection: keep-alive, and a second request
                             on that connection IS served
```

The endpoint answered while part of the request body was still unread and still
advertised a persistent connection. A further measurement shows the connection
becomes usable again **only if the client subsequently sends the rest of the body
it declared** — which, on the timeout path, is by definition what it did not do.

So the response's own framing metadata was false for exactly the case it was sent
in. A client that pools connections — all of them do — can reuse one the server
will not serve and stall. **That is protocol correctness, not a resource leak**,
and the previous revision classified it wrongly in the source, in
`CURRENT-STATE`, in this document and in the pull-request description.

**What was NOT reproduced.** Against Node's own parser, in both the `pause()` and
the no-`pause()` variants, outstanding body bytes were **not** dispatched as a
second request — Node counts them as body. **No smuggled request was observed
here**, and none is claimed. The behaviour of any intermediary in front of this
function has not been measured.

**On the specification.** The current HTTP standard could not be retrieved from
this environment — egress to `rfc-editor.org`, `datatracker.ietf.org` and
`httpwg.org` is blocked by the network policy. **Nothing in this document is
argued from quoted normative text**, and no such text is paraphrased as though it
had been read. Everything above and below is measurement.

### The fix, and where it belongs

`readBody()` is **not** given `res`. Handing a body reader the caller's response
is the precise resource-ownership error #28 paid for, and fixing one lifecycle
defect by reintroducing the other would be no fix at all. The decision lives at
the response boundary in `api/lead.js`, where `res` is already owned — in
`send()`, which every response in the file goes through.

| Situation | `Connection` |
|---|---|
| a body was declared and this server did not consume it | **`close`** |
| the request was fully received, or had no body at all | keep-alive, unchanged |

**The signal is the request's own state, not which branch refused.**
`req.complete` answers "has this whole request been received?". Measured across
every branch: false for the timeout, false for **both** oversize paths — including
when the client had in fact sent every declared byte, because the header check
refuses before the stream is consumed — and true for an ordinary complete request.

**`req.complete === false` alone proved too blunt**, and the first draft of the
rule used it. A bodyless request — the `GET` a scanner or link-preview fetcher
sends, answered `405` — also reports `complete === false` at handler entry,
because Node has not yet emitted the end of a body that does not exist. That
draft disabled keep-alive for all of that traffic. The rule now also requires
that a body was actually declared (`Transfer-Encoding` present, or a non-zero
`Content-Length`).

**The mechanism is `Connection: close` and nothing else.** Measured:

| Mechanism | Header sent | Body delivered | Socket closed |
|---|---|---|---|
| nothing (the defect) | `keep-alive` | complete | **no** |
| **`res.setHeader("Connection","close")`** | **`close`** | **complete, 354/354** | **yes, 3 ms after flush** |
| `req.socket.end()` in `res.on("finish")` | `keep-alive` | complete | yes — but the header still lies |

The third was rejected: it closes while still advertising reuse, which leaves the
metadata false. Node flushes the whole response before closing, so nothing is
truncated.

### This covers six paths, not two

`api/lead.js` answers before the body is consumed on **six** paths: `405`, `403`
and `429` run before the read at all; `413`, `408` and `400` stop part-way
through it. All six had the defect and all six are fixed by the one rule in
`send()`. The change is contained to `api/lead.js`.

### The conservative edge, measured and chosen

On the already-parsed `req.body` path the platform may have consumed the stream
before the handler ran, in which case keep-alive would be fine and the teardown
is avoidable. **This code cannot truthfully know that.** Locally `req.complete`
is false there because nothing read the stream, and **whether Vercel Production
leaves it true has not been measured**. Rather than guess, the connection closes.
The cost of being wrong this way is one extra connection setup on a refused
oversize submission; the cost the other way is advertising reuse over bytes
nobody read. The tradeoff is pinned by a test so that changing it is a decision
rather than a drift.

### 408, re-examined — and no `Retry-After`

408 remains the truthful status: the request was not malformed, it never finished
arriving. It is now paired with the connection lifecycle it requires, which is
the part the first revision was missing — the status was never the whole answer.

**No `Retry-After`.** This is not a rate limit and not backpressure: there is no
interval the visitor should wait, and the right next action is to submit again.
`429` does carry one, because there a real window exists to communicate.
Inventing a number here would assert a delay this endpoint does not impose.
(Argued from the endpoint's own behaviour; the specification text was
unreachable, as noted above.)

`400` was reconsidered and not restored: it would label an incomplete upload as a
malformed one, which is the untruthful option.

### Two prose defects corrected in the same pass

**1. `bodyErrorReason()` said what the code did not do.** The comment read *"IT
READS ONLY THE TOKEN, never the message"* while the implementation was
`err?.token || err?.message`, and `api/lead.js` repeated the claim. Not merely
untidy: every failure the reader raises deliberately carries `.token`, and the
only error arriving without one is a genuine stream error whose `.message` is
arbitrary text. With the fallback, such an error reading `PAYLOAD_TOO_LARGE`
would have been answered as an oversize body — promoting an unknown transport
failure into a specific claim about the visitor's submission. Every caller was
searched first (`api/lead.js` and one test; the identically-named function in
`api/_lib/twilio.mjs` is separate and untouched). It is now token-only, and
tested: a stream error whose message spells a token answers **400**, not 413.
`bodyError()` still sets `.message` too, because an `Error` needs one and older
`.message` matching keeps working — the classifier simply does not read it.

**2. "No body was read" was false.** The timeout path is tested with a **partial
body that is read** before the stall, so "no body was read" and "a submission
that never arrived" both overstated it. The true invariant is narrower: no
*complete* body was accepted; nothing is handed to the parser; the partial bytes
are discarded; no lead-processing step runs; no lead is created.

Similarly, "both defects were live" is now "present in the live lead endpoint's
code path" wherever the streaming fallback is meant, since **Production
reachability of that fallback remains unproven** — the same caveat that governs
the rest of this document.

## Repo-wide behavioural search

Four shapes, named in words before any query was chosen (`CLAUDE.md` rule 17 —
search the shape, not the identifier). **Every shape now returns zero live
matches across `api/`:**

| Shape | Result |
|---|---|
| a helper tears down a resource its caller still needs | none — the only `req.destroy()` occurrences left are comment text describing the removed defect |
| an external stream read to completion with no total deadline | none — both body readers (`readBody`, `readFormBody`) now have one |
| a promise executor able to settle twice | none — both readers use a `settled` guard |
| an `unref()`'d bound | none |
| **a server answers while the request body has not been consumed, leaving the connection persistent** | **six live paths in `api/lead.js`, all corrected here; the same shape is present in both inert gate 7 endpoints — recorded below, not widened into** |

### Out of scope, recorded and not fixed here

0. **Both gate 7 endpoints carry the connection-lifecycle shape.**
   `api/twilio-inbound.js` and `api/operator-action.js` answer after a
   `readFormBody()` refusal without consuming the body and without deciding the
   connection, exactly as `api/lead.js` did. **Both are inert** —
   `TWILIO_AUTH_TOKEN` and `OPERATOR_ACTION_SECRET` are set in no environment.
   Deliberately **not** fixed here: #28's document has been annotated with a dated
   correction beside its original claim, and the repair is sequenced work.
1. **`tests/suppression.test.mjs`** — #28's test *"an oversize body is refused AND
   the caller's 400 still reaches the client"* declares an oversize
   `Content-Length`, which takes the **header fast path**, not the streaming check
   it is named for. `readFormBody()`'s streaming oversize branch therefore has no
   real-socket proof. **The code is correct; the evidence is weaker than the test
   name claims.**
2. **Harness duplication** — `tests/helpers.mjs` now exports a generic
   `withHttpServer`; `suppression.test.mjs` still has its own local copy.
3. **`sendAcknowledgement()` has no single overall deadline**, unlike
   `sendInboundNotification()`. It runs *after* the lead is safely in HubSpot, so
   it cannot lose a lead, but it can consume `maxDuration`.
4. **`createLead()`'s per-request ceilings can sum past `maxDuration`** on the
   create-conflict path. Pre-existing.
5. **`api/lead.js` imports `MAX_BODY_BYTES` and never uses it.**

None was folded into this change. Widening a reviewed diff is how an unrelated
regression arrives with a green tick.

---

## Lesson promotion

**One lesson promoted, by sharpening an existing rule rather than adding one.**

The connection-lifecycle finding clears the admission bar. It is material (the
live endpoint advertised reusable connections it would not serve), reusable (it
applies to every endpoint that can answer early, and this repository has three),
likely to recur (the same shape is in both gate 7 endpoints today), and
decision-changing — which is the load-bearing test here.

It is decision-changing because **`CLAUDE.md` rule 15 was already being followed**
and still missed it. The outcome *was* asserted from the observer's side; what
was too narrow was the meaning of "the outcome" — the status line and the body,
with nothing about the state the exchange left behind. So rule 15 is **widened**,
not duplicated: the observable outcome now explicitly includes connection state,
framing, and what the peer may do next, and a harness may not tear that down
before it has been observed. A twenty-first rule beside rule 15 was considered
and rejected as duplication.

The rationale, and the harness defect that made the state structurally
unobservable, are in `docs/ENGINEERING-LESSONS.md`.

**Nothing was promoted for the two earlier findings**, and both candidates are
already represented:

- *"An assertion threshold loose enough to pass under the behaviour it rules
  out"* — this bit this very change (`ms < 2000`). It is already the attack-list
  item **"a bound satisfied by a run twice as slow as the budget"** in
  `docs/WORKFLOW.md`, and that item is what caught it.
- *"A negative assertion needs a control proving the thing it denies is
  reachable"* — already the attack-list item **"an assertion satisfied by a page
  that omits the claim"**.

Adding either would have lengthened the rule set without changing a future
decision. `CLAUDE.md` rule 20: most corrections produce no rule at all, and
manufacturing one is itself a failure.

---

## What a human must still do

1. **Review and merge.** Not merged.
2. **Nothing operational.** No environment variable, no `vercel.json` change, no
   Vercel, HubSpot, Neon, Twilio, Retell or DNS configuration is involved.
3. **Sequence the five follow-ups above**, particularly (1): a merged test claims
   coverage it does not have.

## What is explicitly not done, and what is unproven

- **Whether Vercel Production reaches the streaming fallback for `api/lead.js` at
  all is UNPROVEN.** It has not been measured. The platform may populate
  `req.body` before the handler runs, in which case the streaming path — and both
  defects — would be unreachable in Production. **Nothing here asserts either
  way**; the path is now correct if reached, and this was fixed as correctness
  work rather than as an incident.
- **The connection lifecycle is fixed, not residual.** The first revision of this
  work called the surviving keep-alive connection "a resource question, not a
  correctness failure". **That was wrong** — see the section below. It is fixed
  at the response boundary in `api/lead.js`, and `readBody()` is still never
  given `res`.
- **No gate 8 work, no Twilio activation, no unsuppression design, no consent or
  lead-workflow redesign, no CRM schema change.**
- **The full suite is CI's job.** `npm run test:unit` was run locally; the
  authoritative gate is `.github/workflows/test.yml`.
