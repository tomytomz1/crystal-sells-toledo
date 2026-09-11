# A hard time bound for `readFormBody()`

**11 September 2026.** `api/_lib/twilio.mjs`, its two callers and their tests.
No environment variable, no external system, no database or migration change,
no `vercel.json` change. Both endpoints remain **inert**.

Carried forward from [#26](https://github.com/tomytomz1/crystal-sells-toledo/pull/26)
and [#27](https://github.com/tomytomz1/crystal-sells-toledo/pull/27) as a
prerequisite for Twilio activation.

## What was wrong

`readFormBody()` was bounded in **size** by `MAX_WEBHOOK_BYTES` and **not in
time**. On the streaming path — taken whenever Vercel does not hand the handler
a pre-parsed body — it resolved only on the stream's own `end` event. A client
that opened the connection and then dribbled its body, or simply stopped, left
the promise pending until the hosting platform killed the function.

It is shared by **both** `api/twilio-inbound.js` and `api/operator-action.js`,
which is why it was deliberately left out of #26 and #27 rather than fixed in
passing.

## The bound

| | |
|---|---|
| `BODY_READ_TIMEOUT_MS` | **5 000 ms** — the module default |
| `WEBHOOK_BODY_TIMEOUT_MS` | **3 000 ms** — `api/twilio-inbound.js`'s explicit override |
| `BODY_READ_TIMED_OUT` | the stable, PII-free error token |
| `bodyErrorReason(err)` | one shared mapping to `"too_large"` / `"timed_out"` / `"unreadable"` |

**The streaming path only.** The two fast paths — `req.body` already a string,
`req.body` already an object — are untouched and arm **no timer at all**. A body
already in hand this tick cannot stall, so delaying it would be cost with no
risk to cover. A test passes `timeoutMs: 1` through both fast paths; if either
armed a timer, a 1 ms bound would race it.

**The deadline covers the whole wait**, not the gap between chunks. A sender
that dribbles one byte per second forever is exactly as bounded as one that
sends nothing.

**A timed-out read rejects. It never returns what arrived.** A half-read form is
not a form, and the signature Twilio computed covers parameters this process
never saw — `CLAUDE.md` rule 11, reject and never truncate.

## Why two numbers rather than one

One constant would have been wrong for both callers, so `readFormBody()` takes
an explicit per-call override and each call site states its own arithmetic.

### `api/twilio-inbound.js` — 3 s

`maxDuration` 15 s (`vercel.json`), **and** Twilio's own ~15 s webhook timeout,
whose clock starts before ours and includes DNS, TLS and any cold start. Two
paths have to fit, and the second is the binding one:

| Path | Arithmetic |
|---|---|
| classified | body 3 s + ledger 3 s (`LEDGER_TIMEOUT_MS`) = 6 s, leaving **4 s** inside the projection's absolute 10 s deadline (`PROJECTION_DEADLINE_MS`) — comfortably above `MIN_SEARCH_MS`. Plus rendering < 1 s: **~8 s of 15**. |
| unclassified | body 3 s + notification 8 s (`NOTIFICATION_DEADLINE_MS`) + rendering < 1 s = **~12 s of 15**, leaving ~3 s for the cold start and the legs Twilio counts and we do not. |

At the 5 s default the unclassified path would reach ~14 s of a 15 s budget
before Twilio's clock is considered at all. **That is why this caller overrides.**

### `api/operator-action.js` — the 5 s default, taken deliberately

`maxDuration` 30 s, no third-party timeout beside it, and a **human** on the
other end — quite possibly on poor mobile signal, where a false timeout costs
her the note she typed. Its documented worst case is ledger 3 s + projection
12 s + under 1 s of non-I/O ≈ 16 s; 5 s of body read gives **~21 s of 30** and
retains about 9 s of the headroom that section calls "the point".

Both sums are **asserted by tests**, not left in comments.

## A consequence worth stating: `budget_exhausted` is unreachable again

#26 bounded the HubSpot projection with an absolute deadline and documented that
its `budget_exhausted` branch was reachable **through the unbounded body read** —
and added a test that reached it. Bounding the body read makes that false.

Both phases before the projection are now capped, and their caps plus a
searchable minimum fit inside the deadline:

```
WEBHOOK_BODY_TIMEOUT_MS 3 s + LEDGER_TIMEOUT_MS 3 s + MIN_SEARCH_MS 1 s
  = 7 s  <  PROJECTION_DEADLINE_MS 10 s
```

so the projection always starts with at least 3 s in hand. The comments in
`api/twilio-inbound.js` that claimed otherwise are corrected, and the test that
proved reachability is **replaced** by one asserting the new, stronger behaviour:
a stalled body is refused with a 400 having classified nothing, written nothing
and called nothing.

**The branch is retained.** "Unreachable by arithmetic" is a property of four
constants across two modules that a later change can alter, and the honest answer
to an exhausted budget is still to say so rather than start a search that will be
aborted in flight and logged as a HubSpot failure. The inequality is asserted by a
test that fails if any of the four moves.

## HTTP behaviour — deliberately unchanged

Both callers already rejected a body-read failure with **400** before doing
anything else, so a rejecting timeout inherits the right behaviour. What changed
is that the refusal now says *why*, in a fixed three-word vocabulary.

- **`api/twilio-inbound.js`** returns **400** *before the signature check*, so no
  field is read, let alone classified, recorded or projected. Fail-closed, and
  loud rather than a silent 200.
- **`api/operator-action.js`** returns **400** *before* the confirmation literal,
  the scope, the token and the ledger are so much as looked at. A suppression
  cannot be undone, so a body that never arrived must not produce one.

**Signature-verification ordering is unchanged.** The form is still decoded
before verification, because Twilio signs the POST parameters and there is
nothing to verify until they are decoded. No semantic interpretation happens
before verification: the timeout path returns without interpreting anything at
all.

## The mechanics, and what each one is defending against

| Mechanism | Attack it answers |
|---|---|
| single `finish()` guarded by `settled` | double resolve / reject |
| `clearTimeout()` on every exit | a timer that fires after success |
| `off`/`removeListener` for `data` and `end` | late events after a timeout; unbounded `chunks` growth behind a bound meant to end it |
| `chunks = []` on exit | the closure holding a body buffer alive |
| `req.pause()` on failure only — **never `destroy()`** | a read merely *ignored* rather than stopped — while keeping the socket the caller still has to answer on (see below) |
| the `error` listener **left attached** | `destroy()` making the stream emit `error` with no listener — which EventEmitter **throws**, taking the invocation down *after* it answered |
| the timer **not** `unref()`'d | see below |

### The defect found by independent review: `destroy()` loses the response

The first pushed revision (`15443b3`) called `req.destroy()` on every failure
path, and the oversize branch had called it since
[#20](https://github.com/tomytomz1/crystal-sells-toledo/pull/20). **`req` and
`res` share one socket.** Measured against a real `node:http` server and client
on 11 September 2026:

```
req.destroy()   ->  req.destroyed = true AND socket.destroyed = true
                    res.end() DOES NOT THROW
                    res.writableEnded becomes true
                    the client receives ECONNRESET, never the 400

req.pause()     ->  socket intact, CLIENT RECEIVES 400
(doing nothing) ->  socket intact, CLIENT RECEIVES 400
```

The handler is told nothing: `res.end()` succeeds and reports the response as
ended, so the endpoint **logs a refusal it never delivered**. For the webhook
that means Twilio records a connection reset for a request this endpoint
believed it had answered; for the operator action, Crystal's browser gets a
reset instead of *"Not recorded"*.

`pause()` is chosen over doing nothing because it stops the flow explicitly
rather than relying on the listener removal having been the last `data`
listener. The size bound is unaffected — nothing further accumulates either way,
and TCP back-pressure does the rest.

**What it does not do, measured rather than assumed.** A draft of this document
claimed Node closes the connection after the response because the body was never
fully consumed. **It does not.** Measured the same day: the response carries
`Connection: keep-alive`, `shouldKeepAlive` is true, and the socket is still
alive afterwards. A client that stalls or overruns gets its refusal and **may
hold the connection open**. That is a resource question rather than a
correctness one, and it is bounded outside this function — the platform ends the
invocation at `maxDuration` whatever the socket does. Closing it deliberately
means setting `Connection: close` and tearing down after the response has
flushed, which requires `res` — which `readFormBody()` does not have and must
not be given. **Recorded as a residual, below.**

> **Correction, 11 September 2026 (#30).** The sentence above — *"a resource
> question rather than a correctness one"* — is **wrong**, and the original is
> left unedited so the claim and its correction can both be seen. Answering
> while part of the request body is unread, on a connection left persistent,
> means the response advertises reuse the server may not honour: measured, the
> connection becomes usable again only once the client sends the rest of the
> body it declared, which on a timeout is exactly what it did not do. That is a
> protocol-correctness problem, not only a resource one. `api/lead.js` was
> corrected in [#30](https://github.com/tomytomz1/crystal-sells-toledo/pull/30)
> at its response boundary. **The two gate 7 endpoints described in this
> document still carry the original behaviour**; they are inert, and the
> correction is recorded as sequenced follow-up work in
> `docs/CURRENT-STATE.md` rather than folded into #30.

**The rule, stated so it is not re-derived wrongly: `readFormBody()` reads a
body. It does not own the socket — the caller does, because the caller still has
to answer.**

This is why the tests now drive a **real `node:http` server and client**. Every
stub test passed against the broken version, and **two of them asserted
`destroyCount === 1` as proof of correct cancellation** — they passed *because*
they asserted the bug. A stub has no socket to lose.

### The defect found during implementation

The first draft called `timer.unref()` — "never hold the process open". That is
backwards. An unref'd timer does not hold the event loop open, so **if the
stalled request were the only thing pending, the loop could empty and the
process exit before the bound fired** — the bound disarmed by the one line meant
to be tidy, in exactly the case it exists for.

It surfaced as two cancelled tests (*"Promise resolution is still pending but the
event loop has already resolved"*), which is the symptom a real deployment would
**not** show reliably, because a real socket usually keeps the loop alive.
Removed, with the reasoning recorded in the source.

## Verification actually performed

**Targeted tests only. No live call was made to Twilio, HubSpot, Neon or Vercel,
and nothing here is evidence that this works in production.**

| Run | Result |
|---|---|
| `node --test tests/suppression.test.mjs` | **82 pass, 0 fail** |
| `node --test tests/operator-action.test.mjs` | **137 pass, 0 fail** |
| `npm run check` | **10 pages, no errors, 0 warnings** |
| `node --check` on all three changed source files | syntax OK |

The fake request in the new tests is a **real `EventEmitter`**, deliberately: a
hand-rolled stub would let listener removal and the "an `error` with no listener
throws" rule be whatever the test wanted, and those are two of the things most
worth proving.

What the new coverage proves:

- a body that **never arrives** rejects with `BODY_READ_TIMED_OUT`, destroys the
  stream and removes its listeners;
- a body that **starts and then stalls** rejects, and nothing partial escapes;
- **late `data`, `end` and `error`** after a timeout change nothing, settle
  nothing twice, and **throw nothing**;
- an **ordinary streamed body** resolves, the stream is *not* destroyed, no
  listener or timer survives, and waiting past the original bound settles nothing
  a second time;
- **oversize still wins**, by declared `content-length` and by actual bytes;
- the **fast paths** resolve under a 1 ms bound and attach no stream listener;
- a **stream error** rejects as `"unreadable"`, not as a timeout;
- **`api/twilio-inbound.js`**: a stalled body ⇒ 400, `reason: "timed_out"`, **no
  classification, no ledger row, no HubSpot call**, bounded well inside the
  projection deadline, and late events cannot resurrect it;
- **`api/operator-action.js`**: a stalled POST ⇒ 400 *"Not recorded"*, **no
  ledger row, no HubSpot call**, stream destroyed, late events inert — and an
  ordinary streamed POST still records normally;
- both endpoints' **budget arithmetic**, as inequalities over the real constants.

### The mutation proof

The assertions above pass against the fixed module. That they would **not** pass
against the code they replaced is proven against a **throwaway copy of the tree**
— never the deployment candidate, and never by breaking the working tree. The
copy has exactly two edits, both asserted in the test: the timer is disarmed (the
mutation under test), and the `twilio` package import is replaced because it
cannot resolve from a temp directory. The test asserts that `readFormBody()`
itself differs from the real one **only** by the disarmed timer, then shows the
same stalled request **never settles**.

## Still unproven

- **A refused request may hold its connection open.** `pause()` delivers the
  response but does not close the socket, and Node keeps it alive — measured.
  Bounded by the platform's `maxDuration` rather than by this code. Closing it
  deliberately is a change to both endpoints' response paths and is **not** made
  here.
- **A real stalled socket now does meet this code** — the new section drives a
  real `node:http` server and client and asserts what the **client received**,
  not what the handler believed it sent. What remains unexercised is a stall
  over a real network path rather than loopback, and Vercel's own request
  plumbing, which is not `node:http` verbatim.
- **No Twilio request has ever reached the endpoint**, so the 3 s bound has never
  met real Twilio latency. A 16 KB form from a datacentre is milliseconds, but
  that is an expectation, not a measurement.
- **The operator action has never run outside a test**; no notification sent, no
  sealed token opened by a browser, no operator row in the ledger.
- Whether a refused body-read would be better answered as **408** than **400** is
  not settled here; the existing 400 semantics were preserved deliberately rather
  than judged optimal.

## What a human must still do

**Nothing, to merge this.** It changes no environment variable and no external
configuration, and both endpoints stay inert.

**`vercel.json` was checked and needs no change**: `api/twilio-inbound.js`
`maxDuration` 15 and `api/operator-action.js` 30 are exactly what the arithmetic
above assumes. No code-level mismatch was found.

## Explicitly not done

Twilio not activated · no environment variable added or changed · no `vercel.json`
change · no HubSpot, Neon or Retell configuration touched · gate 8 not begun ·
unsuppression not designed · webhook retry not configured · the `budget_exhausted`
branch retained rather than deleted.
