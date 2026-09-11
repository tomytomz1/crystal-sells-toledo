# The lead endpoint's body read — bounded in size and in time

**Date** 11 September 2026
**Pull request** [#30](https://github.com/tomytomz1/crystal-sells-toledo/pull/30)
**Files** `api/_lib/security.mjs`, `api/lead.js`, `tests/api.test.mjs`,
`tests/helpers.mjs`, `docs/CURRENT-STATE.md`, `docs/ENGINEERING-LESSONS.md`

This document assumes no repository access and no memory of earlier sessions.

---

## What was wrong, and why it mattered

`api/lead.js` is the only server-side entry point for website leads. It reads the
request body through `readBody()` in `api/_lib/security.mjs`. That function had
three ways to refuse an oversize body and one streaming fallback, and **two
defects lived on the streaming path only**.

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

Returning here is safe: no body was read, so no lead was created, and a repeated
submission duplicates nothing. `assets/js/main.js` treats every non-2xx alike —
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

`npm run test:unit` — **108 tests, 108 passing, 0 failing.**

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

### Out of scope, recorded and not fixed here

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

**Nothing was promoted, and that is the finding.**

Two candidates were considered and both are already represented:

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
- **A measured residual.** `pause()` delivers the response but does not close the
  socket: Node sends `Connection: keep-alive` and the connection survives, so a
  refused client may hold it open. That is a resource question bounded by
  `maxDuration`, not a correctness failure. Closing it deliberately would mean
  `Connection: close` and tearing down after the response flushed, which requires
  `res` — a resource `readBody()` does not have and must not be given. **No
  `Connection: close` behaviour was added.**
- **No gate 8 work, no Twilio activation, no unsuppression design, no consent or
  lead-workflow redesign, no CRM schema change.**
- **The full suite is CI's job.** `npm run test:unit` was run locally; the
  authoritative gate is `.github/workflows/test.yml`.
