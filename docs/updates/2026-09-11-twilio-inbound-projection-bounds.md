# Bounding the inbound webhook's HubSpot suppression projection

**11 September 2026.** `api/twilio-inbound.js`, its static guards and its tests.
No environment variable, no external system, no database or migration change. The
endpoint remains **inert**: no Twilio number points at it and `TWILIO_AUTH_TOKEN`
is set in no environment.

## What was wrong

After a STOP is written to the consent ledger, the webhook projects the
suppression onto every HubSpot contact holding that number, so the operator can
see it in the CRM. That loop was **unbounded**.

`findContactsByPhone()` returns up to **100** contacts and each write is a
separate HubSpot request, each with its own 8-second timeout. A number held by
many contacts — a household, a number reused across records, a lead who filled
in the form more than once — is therefore up to 100 sequential requests inside a
function whose `maxDuration` is **15 seconds** (`vercel.json`), sitting behind
Twilio's own **~15 second** webhook timeout.

**What an overrun costs, stated as narrowly as the facts allow.** The projection
runs *after* the ledger append has committed, so when the loop starts the
suppression is **durably recorded** — appended to `communication_consent_events`,
keyed by phone number, and beyond this application's power to amend or delete. An
overrun cannot unwrite that row, so the **evidence** is not what is at risk.

What *is* at risk is **the answer to Twilio**: the platform kills the function,
Twilio records a webhook failure for a message that was in fact handled
correctly, and — once webhook retry is configured, which is a live-activation
prerequisite — redelivers it. And the **CRM projection itself**: an unbounded
loop that is killed leaves an arbitrary, **uncounted** subset of contacts
unmarked.

**What is deliberately not claimed here.** Not that an incomplete projection
cannot matter. The contract as it actually stands today is:

- a successful ledger append means the suppression or revocation is **durably
  recorded** — that, and not more;
- the HubSpot `cst_*` flags are **best-effort operational state**, not the
  evidence;
- **gate 8 will make the ledger authoritative at send time**, by resolving
  suppression through `get_suppression_state()` before anything is sent;
- **until gate 8 exists, nothing in the application reads that ledger state
  before sending.** Nothing in `api/` calls `get_suppression_state()`, and the
  `EXECUTE`-only sender credential is in no environment. The CRM flags are
  therefore the only suppression signal any code here reads at all —
  `api/lead.js` folds a submission onto a contact's existing flags so a ticked
  box cannot grant through a suppression, and that read is of the **flags**,
  never of the ledger;
- **because no automated outbound sender is active today** — nothing sends an
  SMS, nothing places an AI voice call — this is **not a live messaging
  exposure**. There is no send for an unread suppression to leak past. The
  consent feature is also **off in Production**, so the flag read above does
  not happen there either. Both are conditions of the current deployment, not
  properties of this code;
- **gate 8 must be in place before outbound automated communications are
  activated.**

The bound does not change any of that. What it changes is that the shortfall in
the CRM copy is now **counted and stated** rather than silent.

A second, quieter defect sat in the same loop. An already-suppressed contact
produces an **empty** property patch; `writeSuppressionProperties()` answers
`{ written: false }` without making a request; and the loop counted it in **no
bucket at all**. `written + failed` did not sum to the contacts found, so a
contact simply disappeared from the only record of what the projection did. This
is the same defect [#24](https://github.com/tomytomz1/crystal-sells-toledo/pull/24)
found in `api/operator-action.js`; it was fixed there and left standing here.

## What changed

### The bound

| | |
|---|---|
| `MAX_PROJECTION_CONTACTS` | **25** writes |
| `PROJECTION_DEADLINE_MS` | **10 000 ms**, measured from **handler entry** |
| `MIN_WRITE_MS` | 500 ms — below this a write is not started |
| `MIN_SEARCH_MS` | 1 000 ms — below this the search is not started |

The deadline **covers the contact search as well as every write**. Putting the
search outside it would reintroduce the same arithmetic in a different place: an
8-second search plus a 10-second write phase is an 18-second projection however
each half is measured.

**The bound is hard.** The remaining budget is passed *into* each HubSpot
request and the socket is **aborted** when it runs out. Checking the clock only
*between* requests bounds when a write may **start** and says nothing about when
it **ends** — a write beginning at 9.9 s would run on under HubSpot's own 8 s
timeout and finish near 17.9 s. That exact defect was found in `4397f00` in the
operator action; the per-request override in `api/_lib/hubspot.mjs` already
exists for it, and also covers the response **body** rather than stopping at the
response headers.

### Two deliberate differences from `api/operator-action.js`

This is not a copy of the projection proven there, and the divergences are the
point.

**1. Ten seconds, not twelve.** The operator action has a 30 s `maxDuration` and
a human waiting for a page. This endpoint has a 15 s `maxDuration` *and* Twilio's
~15 s timeout, whose clock starts before ours — it includes DNS, TLS and any cold
start, none of which appear in our `maxDuration`. Copying 12 s would put the
worst case at 3 + 12 + 1 = **16 s**, past the platform limit on its own.

**2. The deadline is absolute, from handler entry — not from the projection's
own start.** In the operator action a projection-local budget is correct, because
nothing before it is a hard cost. Here it would **stack**: a 3-second ledger
append plus a fresh 10-second projection window is 13 seconds of I/O, and a slow
body read would add to it again. Measured from handler entry, whatever the
earlier phases spent, the projection stops at the same wall-clock instant.

### The tally

Every contact found now lands in **exactly one** of four buckets, and they always
sum to the population:

| Bucket | Meaning |
|---|---|
| `written` | the patch was applied |
| `unchanged` | already marked — an empty patch, and **no request made** |
| `failed` | HubSpot declined, or the patch could not be built |
| `skipped` | not reached: past the cap, or no budget left |

No bucket is a synonym for another. An already-marked contact is never described
as newly written, as failed, or as unreached. The budget gates **requests, not
the scan**: deciding what a contact needs is pure and free, so an already-marked
contact is accounted for correctly however little budget remains, and only
contacts that actually need a request are subject to the cap.

### Response semantics — unchanged

Nothing about what Twilio is told has changed. The ledger is still the fail-closed
step (503 when the append fails); the projection is still best-effort and still
answers **200 with the empty `<Response/>`** whatever it manages, because by then
the suppression is durable.

## What the reviews found

**Two material truthfulness defects, both in this pull request's own prose, and
neither of them in the projection's behaviour.** The implementation shipped at
`ec5b04f` was not redesigned by either finding.

### 1. Found by the pre-handoff adversarial review, before `ec5b04f`

The source asserted, in prose, that the `budget_exhausted` branch was
**unreachable** — reasoning that the only phase before the projection which
spends real time is the ledger append, and that it is capped at
`LEDGER_TIMEOUT_MS`. That reasoning never checked whether anything *else* before
the projection is bounded in time. **`readFormBody()` is bounded in SIZE
(`MAX_WEBHOOK_BYTES`) and not in time**: it resolves when the stream ends, and a
request that dribbles its body holds it open indefinitely. The branch is
therefore reachable, and the prose claimed a guarantee the code did not make.

Fixed by correcting the prose and by adding the regression that **reaches the
branch** — a request whose body arrives only after the deadline has passed. That
test also independently proves the deadline is absolute: with a projection-local
budget the search would have run.

The review found nothing further material; the correction delta was re-reviewed
once, which produced one robustness change in the new test's stream stub and no
source change.

### 2. Found by independent review of `ec5b04f`, after it was pushed

**The pull request repeatedly claimed that a successful ledger append made the
suppression "already effective" or "already enforced", and that a projection
failure could therefore "cost visibility, not compliance". That is false in the
CURRENT system.**

A successful append makes the suppression **durably recorded**. It does not make
it *enforced*, because nothing enforces anything yet: gate 8 has not begun,
nothing in `api/` calls `get_suppression_state()`, the `EXECUTE`-only sender
credential is in no environment, and no automated outbound sender exists. The
ledger row is durable, authoritative **evidence**; it is not yet an enforcement
lookup. Nor can a projection failure be said to cost *only* visibility, since the
`cst_*` flags are in fact the only suppression signal any code here reads today.

**Root cause:** the claim was inherited. It has been in `api/twilio-inbound.js`'s
header since the gate 7 SMS implementation merged in
[#20](https://github.com/tomytomz1/crystal-sells-toledo/pull/20), was repeated
into the new comments and into every document describing this change, and was
never checked against what `api/` actually contains — even though this same pull
request states the true position correctly, in its own answer to the first of
`docs/WORKFLOW.md`'s two questions. A document contradicting itself is the
strongest evidence available that the comfortable half was never verified.

Corrected throughout: four statements in `api/twilio-inbound.js` (including the
pre-existing header claim, since it is a current-design statement in the file
under review), the `docs/CURRENT-STATE.md` addition, this document, the pull
request description and the PULSE HANDOFF. **Wording only — no behavioural change
and no change to the projection implementation**, which the independent review
explicitly found sound.

**`api/operator-action.js` carries the same inherited claim** — *"once step 2
succeeds the suppression is already effective and a step 3 failure costs
visibility, not compliance"* — and is **deliberately NOT changed here.** It is a
separate merged file outside this change's scope. It is recorded as a follow-up,
alongside the `readFormBody()` time bound.

### The two questions, answered

**"If an independent security or compliance reviewer wanted to block this, what
would they point to?"**

At the fact that a bounded projection deliberately leaves some HubSpot contacts
unmarked, and that **nothing in `api/` calls `get_suppression_state()` today** —
send-time enforcement is gate 8 and has not begun. So the only suppression signal
an ordinary lead submission consults is the HubSpot `cst_*` flags, and a contact
the projection did not reach does not carry them. On a number held by more than
25 contacts, a later form submission folding consent onto such a contact would
not see the suppression — with the consent feature on. It is off in Production,
and no automated outbound sender exists, so neither today nor in either version
is there a live messaging exposure.

The answer is that this is **strictly better than what it replaces**, not a new
exposure: unbounded, the function was killed mid-loop, so *more* contacts went
unwritten and none of them was counted anywhere. The ledger row — the durable
record, and the one gate 8's enforcement path is **designed** to read, though
nothing reads it today — is complete and unaffected either way, and the shortfall
is now **counted and logged**. No automated outbound sender is active, so there
is no live messaging exposure in either version. The real fix is gate 8, which is
deliberately out of scope here and **must precede activation of any automated
outbound communications**. Which 25 contacts are written is HubSpot's search
order and is not prioritised.

**"What guarantee does the prose claim that the code does not actually
guarantee?"**

The first draft's claim that `budget_exhausted` was unreachable — see above; it
was false and is corrected.

What remains, stated rather than smoothed over: the worst-case arithmetic
(≈ 11 s against a 15 s `maxDuration`) bounds **everything after the request body
has been read**. It does not bound the body read, and **no deadline in this file
can** — a stalled body still outlives the function. The absolute deadline
contains that request's *consequence for the projection* (it arrives with nothing
left to spend, and says so) rather than removing its cause. The "< 1 s" allowed
for non-I/O work is an estimate and is not measured. Twilio's "~15 s" webhook
timeout is Twilio's documented behaviour, not something observed against this
endpoint.

## Static guards

Six new invariants in `tools/check.mjs`, each of which a refactor could delete
without breaking a single visible behaviour — the endpoint still answers 200
against a CRM holding one contact, which is every other test:

1. the search carries `timeoutMs: requestMs()`
2. the write carries `timeoutMs: requestMs()`
3. the deadline is derived from handler entry, not from `Date.now()` locally
4. `projectToHubSpot` receives and uses `startedAt`
5. the write count is capped at `MAX_PROJECTION_CONTACTS`
6. all four buckets are actually incremented, and `projection_done` reports the
   population alongside the skipped count

**The guard is anchored to `projectToHubSpot()`'s own body**, not to the file. A
guard searching the whole source would be satisfied by the constants merely being
*declared* while the loop no longer honoured them — the shape proved worthless by
mutation in guard 5 on 10 September 2026. `tests/suppression.test.mjs` breaks each
of the six in a **throwaway copy of the tree** and asserts the real script refuses
it, including one mutation that guts the function body while leaving every
identifier present.

## Verification actually performed

**Targeted tests only. No live call was made to HubSpot, Twilio, Neon or Vercel,
and nothing here is evidence that this works in production.**

| Run | Result |
|---|---|
| `node --test tests/suppression.test.mjs` | **73 pass, 0 fail** (~26 s) |
| `node --test tests/operator-action.test.mjs` | **128 pass, 0 fail** — the webhook is exercised there too |
| `npm run check` | **10 pages, no errors, 0 warnings** |

Seven new behavioural tests and six new guard-mutation tests. What they prove:

- **the cap**: 32 contacts produce exactly 25 HubSpot writes, and the log reports
  7 skipped
- **the deadline is absolute and the abort is real**: a 2 800 ms ledger append and
  a 5 000 ms search, then a write that resolves only when aborted — the handler
  finished in **10 002 ms**, against 12 800 ms for a projection-local budget and
  15 800 ms for a bound checked only between requests
- **the tally**: a mix of already-marked, HubSpot-refused, writable and
  over-cap contacts, asserted to sum to the population bucket by bucket
- **the budget arithmetic**: `LEDGER_TIMEOUT_MS + MIN_SEARCH_MS <
  PROJECTION_DEADLINE_MS`, so a slow ledger can never be what starves the search
- **a hanging ledger** is cut at its own timeout, answers **503**, and no
  projection runs
- **a stalled request body** reaches `budget_exhausted`: no HubSpot call is made
  at all, and it is not reported as a HubSpot failure
- **the re-opt-in path** is capped the same way and still grants nothing
- **a total HubSpot outage** still leaves the ledger row and the empty TwiML 200

## Still unproven

- **Everything above is a passing test, not a production observation.** No Twilio
  request has ever reached this endpoint and no suppression row has ever been
  committed outside a rolled-back transaction.
- **The bound has never run against real HubSpot latency.** Every timing here is
  against a stubbed `fetch`.
- **No number with more than 25 matching contacts has ever existed in the
  production CRM** as far as this work established; the cap has never bound
  anything real.
- **`readFormBody()` is still unbounded in time.** Deliberately left alone — it
  is shared with the signature-verification path and is outside this change's
  scope. Recorded as a **separate follow-up decision for the operator**, not as
  an oversight, and deliberately not folded into this pull request.
- **`api/operator-action.js` still carries the inherited "already effective /
  costs visibility, not compliance" claim**, corrected here only in
  `api/twilio-inbound.js` and the documents describing this change. A separate
  follow-up; that file is outside this change's scope.
- **Gate 8 remains the thing that makes the ledger authoritative at send time,
  and it has not begun.** Nothing in `api/` reads suppression state before
  sending. No automated outbound sender exists today, so this is not a live
  exposure — and **gate 8 must be in place before any automated outbound SMS or
  AI voice is activated.**

## What a human must still do

**Nothing, to merge this.** It changes no environment variable and no external
configuration, and the endpoint stays inert.

Unchanged activation prerequisites for gate 7: `TWILIO_AUTH_TOKEN`, a Production
`CONSENT_LEDGER_URL` (the `INSERT`-only `consent_ledger_app` string, **not** the
`EXECUTE`-only sender string), and `OPERATOR_ACTION_SECRET` with `ZOHO_SMTP_*`
confirmed. All absent today.

## Explicitly not done

Twilio not activated · no environment variable added or changed · no HubSpot,
Neon, Retell or Vercel configuration touched · gate 8 not begun · unsuppression
not designed · `readFormBody()` not bounded in time · `api/operator-action.js`
not corrected and not refactored, and its projection not shared with this one — the budgets
genuinely differ, and rewriting a heavily reviewed inert path for symmetry alone
is risk without a return.
