# Gate 7 — the connection lifecycle, repaired at both response boundaries

**11 September 2026.** Runtime change to the HTTP transport contract of two
server endpoints: `api/twilio-inbound.js` and `api/operator-action.js`. **Both
are inert in every environment**, so this is correctness work before activation,
not a production incident. **Production behaviour did not change, and no
external system was touched.**

This is the follow-up [#30](https://github.com/tomytomz1/crystal-sells-toledo/pull/30)
recorded as sequenced work and deliberately did not fold in.

---

## The defect

Both endpoints could **answer while a declared request body had not been
completely consumed**, and still send `Connection: keep-alive`.

The socket survives, so the response's own framing metadata advertised a
connection that becomes usable again **only once the client sends the rest of
the body it declared** — which, on a stalled or refused read, is by definition
what it did not do. A client that pools connections, which is all of them, can
reuse one the server will not serve. The header was false for exactly the case
it was sent in.

This is the fifth behavioural shape #30 named, and the same one it fixed across
six paths in `api/lead.js`. It was measured there, from the client's side,
against a real `node:http` boundary. It is measured here, on a raw socket,
against both gate 7 endpoints.

**It was never only the `readFormBody()` refusal path.** Each endpoint can
answer *before* it reads the body at all, and those requests carry declared
bodies just as readily:

| Endpoint | Answers before reading the body when |
|---|---|
| `api/twilio-inbound.js` | the method is not `POST`; Twilio is not configured |
| `api/operator-action.js` | the method is neither `GET` nor `POST`; the endpoint is not configured; a `POST` carries its token in the query string |

A fix applied only at the `readFormBody()` `catch` would have left every one of
those advertising a connection it could not honour.

---

## Why `Connection: close` is the right mechanism, and why it belongs at the response boundary

**The header is the thing that was wrong.** The endpoint was making a false
statement about the connection, so the correction is to make a true one. Node
then flushes the **complete** response and closes the socket itself.

The alternatives were considered and rejected, on #30's measurements:

| Mechanism | Header sent | Body delivered | Socket closed |
|---|---|---|---|
| nothing (the defect) | `keep-alive` | complete | **no** |
| **`res.setHeader("Connection", "close")`** | **`close`** | **complete** | **yes** |
| `req.socket.end()` in `res.on("finish")` | `keep-alive` | complete | yes — **but the header still lies** |
| `req.destroy()` / `socket.destroy()` | — | **lost** | yes — the bug [#28](https://github.com/tomytomz1/crystal-sells-toledo/pull/28) paid for |

**`readFormBody()` is still not given `res`, and still does not own the
socket.** `req` and `res` share one socket; a body reader that tears it down
takes the caller's ability to answer, and the caller is told nothing because
`res.end()` succeeds on a destroyed socket. That is `CLAUDE.md` rule 16, and
fixing one lifecycle defect by reintroducing the other is not a fix.

So the decision lives where `res` is owned: the **response boundary**. Each
endpoint has exactly one, and every response in each file goes through it.

| Endpoint | Boundary | Coverage |
|---|---|---|
| `api/twilio-inbound.js` | `reply()` | every path, `surfaceToOperator()`'s four 503s and its 200 included |
| `api/operator-action.js` | `page()` | every path; `notice()` and `refuseToken()` route through it |

`api/lead.js` has made the same decision in its own `send()` since #30 and is
**deliberately not refactored** here — the live lead path is fixed and proven,
and disturbing it to remove a duplicated four-line rule would be risk with no
correctness gain.

---

## The exact rule

One **pure** predicate, `bodyStillOutstanding(req)`, exported from
`api/_lib/twilio.mjs` and imported by both gate 7 endpoints. It reads `req` and
**mutates nothing** — not the request, not the response, not the socket. That
purity is what lets it live beside `readFormBody()` without repeating the
ownership error.

A connection is closed when **both** hold:

1. `req.complete === false`; **and**
2. the request actually has a body that may remain outstanding —
   `Transfer-Encoding` is present, **or** `Content-Length` is finite and greater
   than zero.

```js
export function bodyStillOutstanding(req) {
  if (req?.complete !== false) return false;
  if (String(req.headers?.["transfer-encoding"] || "")) return true;
  const declared = Number(req.headers?.["content-length"] || 0);
  return Number.isFinite(declared) && declared > 0;
}
```

**`=== false`, not `!req.complete`.** `undefined` means **unknown** — a mock, a
platform request object, a runtime that does not set it — and an unknown keeps
today's behaviour rather than closing on a guess.

**And `complete === false` alone is too blunt**, which #30 measured and its
first draft got wrong. A **bodyless** request reports `complete === false` at
handler entry too, because Node has not emitted the end of a body that does not
exist. Closing on that alone drops keep-alive for every scanner probe, every
link-preview fetch, and — here — the operator action's read-only `GET`. Both
controls are pinned by tests, not by this document.

**The signal is the request's own state, never which branch refused and never
the response status.** The same branch answering the same status closes or does
not close depending only on whether bytes are outstanding; a controlled pair of
tests asserts exactly that.

**Deliberately conservative at one edge**, inherited from #30 with its reasoning
intact: on the already-parsed `req.body` path the platform may have consumed the
stream before the handler ran, in which case nothing is outstanding. **This code
cannot truthfully know that, and Vercel's behaviour there is unmeasured**, so it
closes. One avoidable teardown on a refused submission is cheap; advertising
reuse over bytes nobody read is a lie.

---

## The static guard — updated, not loosened

`tools/check.mjs` protects the gate 7 invariant *"an unclassified message is
never a silent 200"* by extracting `surfaceToOperator()`'s body and **counting
four literal `reply(res, 503)` failure paths**.

Changing the signature to `reply(req, res, 503)` would have made that count
**zero**, and the guard would have fired on correct code. **Loosening or
deleting it to make `npm run check` pass is how a guard becomes decoration** —
and a guard that is syntactically satisfied while its invariant is broken is the
exact failure class this repository has already paid for twice.

What changed instead:

- the guard now matches **any `reply()` whose arguments carry `503`**, so it
  asks the question the invariant is actually about rather than encoding the
  call's argument shape. A further signature change cannot silently empty it; a
  **status** change still fails it.
- the "answers 200 before its last failure check" test no longer depends on a
  literal `lastIndexOf` of a fixed string that could be absent.
- **a new guard, 5b**, protects the repair itself on both endpoints: each file
  must contain **exactly one** `res.end(`, and the slice from
  `function <helper>(req, res` to that single `res.end(` must contain
  `bodyStillOutstanding(req)` and `Connection`. A response written directly with
  `res.end()` would reopen the defect on exactly one path while every
  behavioural test still passed, because no test is guaranteed to be pointed at
  a path that does not exist yet.

  **That slice is the guard, not a character window.** A first draft of 5b used
  `[\s\S]{0,900}` between the declaration and the predicate, which is
  satisfiable by code that merely sits *near* the helper and goes stale the
  moment a header is added — the two ways a guard stops guarding, and the reason
  this section exists. The slice is exact, and it also proves **ordering**: the
  decision must come before the response is written.

  It also no longer reads `api/operator-action.js` before that file's own
  existence check, which would have replaced a clean "missing" failure with an
  `ENOENT` stack trace.

### And the mutation tests that go stale with it

Both surfacing mutation tests targeted the literal `reply(res, 503)` and went
vacuous in the same commit. They were caught only because `mutate()` refuses a
no-op replacement — a guard the suite already had, doing its job.

They are rewritten to be **self-checking**, which the previous version was not:
the target is named, its presence is asserted, **the expected count of four is
asserted**, the slice boundaries are asserted to have resolved, and the changed
body is asserted to differ. Any one of those failing silently would previously
have left the test green and proving nothing — including the `indexOf() === -1`
case, where `slice(0, -1)` produces a *different* string and satisfies a bare
`assert.notEqual` while mutating nothing of interest.

Two further mutation tests are added, one per new guard: a response written
outside `reply()`, and `page()` with its connection decision removed.

---

## Evidence — raw socket, observed before any teardown

`tests/helpers.mjs`'s existing `withRawRequest()` is used for all of it. **No
second socket harness was created**: that helper exists for precisely this class
of claim, and it observes for a fixed window with **nothing torn down**, then
cleans up. *A teardown that runs before the observation is not a teardown; it is
the experiment.*

Every case drives the **real exported handler**, not a re-implementation.

### `api/twilio-inbound.js`

| Case | Framing | Status | `Connection` | Server closed | Dispatched |
|---|---|---|---|---|---|
| **A** bodyless unsupported method | no body | `405` | keep-alive | no | **2** — the socket carried a second request |
| **B** unsupported method, declared body incomplete | `Content-Length: 400`, 17 bytes sent | `405` | **`close`** | yes | 1 |
| **C** chunked oversize, body never terminated | `Transfer-Encoding: chunked`, **no** `Content-Length`, 20 480 bytes | `400` | **`close`** | yes | 1 |
| **D** complete body, refused on signature | `Content-Length` exact | `403` | keep-alive | no | **2** |

**A and B are a controlled pair** — the same branch, the same status, one
bodyless and one with bytes outstanding. They are the evidence that the signal
is the request's own state and not which branch refused, and **A is the guard
against the over-blunt `!req.complete` rule**.

**C reaches the STREAMING size check**, which is the point of its framing:
chunked with no `Content-Length` is the only shape that gets past the header
fast path to `readFormBody()`'s running-byte total.

### `api/operator-action.js`

| Case | Framing | Status | `Connection` | Server closed | Dispatched |
|---|---|---|---|---|---|
| **A** bodyless unsupported method | no body | `405` | keep-alive | no | **2** |
| **B** token in the query string, declared body incomplete | `Content-Length: 400`, 14 bytes sent | `400` | **`close`** | yes | 1 |
| **C** oversize declared length, refused by `readFormBody()` | `Content-Length` over the cap, no body sent | `400` | **`close`** | yes | 1 |
| **D** complete body, missing confirmation literal | `Content-Length` exact | `400` | keep-alive | no | **2** |

Every one of these also asserts the page arrived **complete** (`</html>`
present) and that `X-Frame-Options: DENY`, the CSP and `nosniff` **survived** —
a connection decision that truncated the response or dropped a security header
would be a worse defect than the one being fixed.

**`api/operator-action.js` has no chunked case**, and that is stated rather than
glossed: the predicate's chunked branch is measured **once**, on the webhook,
because chunked-with-no-`Content-Length` is the only framing that reaches the
streaming check at all. The predicate is one shared pure function, so the
operator action takes the same branch — **that is inference from shared code,
not a second measurement**, and it is not claimed as one.

**Completeness is asserted against the response's own `Content-Length`** on the
webhook, not against "a non-empty body": that endpoint's refusals carry an
**empty** body, so a non-emptiness check would have proved nothing. The operator
action's pages are checked for their closing `</html>`.

### Mutation proof, on a throwaway copy

Removing the connection decision from both endpoints on a **copy outside the
working tree** — never the deployment candidate:

```
twilio-inbound    A keep-alive control  PASS
                  B declared body       FAIL   expected 'close', actual 'keep-alive'
                  C chunked oversize    FAIL   expected 'close', actual 'keep-alive'
                  D complete body       PASS
operator-action   A keep-alive control  PASS
                  B token in query      FAIL   expected 'close', actual 'keep-alive'
                  C body-read refusal   FAIL   expected 'close', actual 'keep-alive'
                  D complete body       PASS
```

**That is the correct signature**: the closing assertions fail and **both**
keep-alive controls still pass, on both endpoints. It also records the pre-fix
behaviour directly — `keep-alive` on all four closing paths.

### Targeted tests

| Command | Result |
|---|---|
| `node --test tests/suppression.test.mjs` | **90 pass, 0 fail** |
| `node --test tests/operator-action.test.mjs` | **143 pass, 0 fail** |
| `npm run check` | **10 pages checked, no errors, 0 warnings** |
| `node --check` on each changed `.js`/`.mjs` | clean |

The full suite is CI's job and was not run locally.

---

## One inherited test claim, corrected

`tests/suppression.test.mjs`'s *"an oversize body is refused AND the caller's
400 still reaches the client"* declares an oversize `Content-Length`, so it is
refused at the **header fast path**. Its nearby comment claimed the opposite —
*"the refusal comes from the running byte total rather than from the header
check"* — and #30 recorded that as false.

The comment is corrected in place and now says which path the test actually
exercises. **The test name was left alone; the prose was the thing that lied**,
and the test is still worth exactly what it asserts. The **streaming** check now
has its own raw-socket proof in case C above.

**This was not turned into a general test-suite cleanup.**
`tests/suppression.test.mjs` still carries a local HTTP harness alongside the
shared ones in `helpers.mjs`; that duplication did not block the lifecycle proof
— the new tests use the shared `withRawRequest` — so the change was not widened
to absorb it. It remains recorded in `docs/CURRENT-STATE.md`.

---

## Repo-wide behavioural search

> **The shape, in words:** *a server responds while a declared request body
> remains incomplete, and leaves the HTTP/1.1 connection persistent — so the
> response's own framing advertises a connection the server may never serve.*

Searched by **enumerating every place in the repository that can write an HTTP
response** — `res.end(`, `writeHead(`, `.statusCode =`, every `createServer(`
and every exported `handler` — rather than by grepping `Connection` or
`reply(`, which would only have found code that already has the fix.

| Match | State |
|---|---|
| `api/lead.js` → `send()` | corrected in #30 |
| `api/twilio-inbound.js` → `reply()` | **corrected here** |
| `api/operator-action.js` → `page()` | **corrected here** |

**Those are the only three response boundaries in the repository**, and each
file's only `res.end(` is inside its own boundary — now statically enforced for
the two gate 7 endpoints. The servers in `tests/` are observers, not production
surfaces. `npm run dev` serves `public/` through a third-party static server
that reads no request bodies.

**No fourth match. Nothing new is sequenced.**

---

## What is explicitly NOT changed

- **No status semantics.** The webhook's body-read rejection stays `400`; the
  operator action's stays `400`. Whether `408` would be preferable for either
  is recorded as unresolved and was **not** decided here.
- **No consent, suppression, ledger, HubSpot-projection or notification
  behaviour.** No event shape, no scope, no dedupe key, no CRM property.
- **No `api/lead.js` refactor** to share the predicate.
- **No gate 8**, no `get_suppression_state()` wiring, no unsuppression, no
  Retell ingress, no Twilio activation, no webhook retry configuration, no
  A2P/TCR change.
- **No environment variable, no `vercel.json` change, no migration.**
- **No external system touched** — Vercel, HubSpot, Neon, Twilio, Retell and DNS
  are all untouched, and no live call of any kind was made.
- **The other #30 follow-ups** — `sendAcknowledgement()`'s overall deadline,
  `createLead()`'s budget, the unused `MAX_BODY_BYTES` import — remain open and
  were not folded in.

## What is UNPROVEN

- **No live traffic has reached either endpoint**, because both are inert. Every
  measurement here is against a real **local** `node:http` boundary. Tests
  passing is not production working.
- **The behaviour of any intermediary in front of these functions on Vercel has
  not been measured**, and neither has whether Vercel's runtime populates
  `req.body` — which is why the conservative edge above closes rather than
  guesses.
- **The predicate's chunked branch is measured on the webhook only.** Its
  behaviour in `api/operator-action.js` is inferred from the fact that both
  import the same pure function, not separately measured.
- **No smuggled second request was reproduced**, here or in #30. Against Node's
  own parser the outstanding bytes were never dispatched as a second request.
  That is recorded as *not reproduced*, not as *cannot happen*.
- **The current HTTP specification could not be retrieved from this
  environment** — egress to `rfc-editor.org`, `datatracker.ietf.org` and
  `httpwg.org` is blocked by the network policy. **Nothing above is argued from
  quoted normative text, and none is paraphrased as though it had been read.**
  Everything above is measurement.

## What a human must still do

1. Review and decide on merge. **Not merged.**
2. Nothing operational. No configuration, no credential, no console work.
