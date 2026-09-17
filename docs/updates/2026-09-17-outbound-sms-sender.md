# The first outbound SMS sender — built DARK behind Gate 8

**17 September 2026.** Assume no repository access and no memory of any previous
conversation.

---

## What this is

`crystalsellstoledo.com` collects SMS and AI-voice consent and records
suppressions, but until now **no code in the repository could send anything.**
Gate 8 — `api/_lib/send-permission.mjs`, merged in
[#41](https://github.com/tomytomz1/crystal-sells-toledo/pull/41) — is the
send-time authorization boundary that answers *may this channel reach this phone
number right now?* from current consent and current durable suppression, and
fails closed. It had nothing standing behind it.

This change adds the first thing that stands behind it: `api/_lib/sms-sender.mjs`,
an outbound SMS transport.

**It is dark, and merging it does not make production capable of sending.**

| | |
|---|---|
| Anything imports the sender | **No.** Nothing under `api/`, and the build fails if anything does. |
| `OUTBOUND_SMS_ENABLED` | **Set in no environment.** |
| `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_MESSAGING_SERVICE_SID` | **Set in no environment.** |
| `CONSENT_LEDGER_SENDER_URL` (Gate 8's suppression lookup) | **Set in no environment**, so even a called Gate 8 would fail closed. |
| Any live Twilio call from this module | **Never made.** The client is injected in every test. |
| A2P Campaign | **Rejected (30882), remediated, not resubmitted.** Untouched by this work. |

Four independent conditions each stop a send on their own. No external system
was contacted, configured or changed.

---

## Why it mattered that this be built before it is needed

An orchestrator that decides *what* to say and a transport that decides *whether
it may be said* are different jobs with different failure modes. Building the
transport first, with nothing calling it, means its refusal semantics can be
designed and tested without the pressure of a feature waiting on them — and it
means the repository can grow the static guards that keep a future orchestrator
honest before that orchestrator exists to be constrained.

---

## What changed

### `api/_lib/sms-sender.mjs` — new

A **transport**, not a composer. It is handed a message decided elsewhere and it
either sends that exact text to that exact number or refuses. It templates
nothing and decides no content.

The order:

1. outbound feature gate — local, no I/O
2. configuration — local, no I/O
3. target and body validation — local, no I/O
4. construct the Twilio client — local, synchronous, no I/O
5. `await authorizeSms()` — Gate 8, whose own last provider read is durable
   suppression
6. refuse on anything that is not exactly `allowed === true`
7. `messages.create()` — immediately

**Step 4 sits before step 5 on purpose.** Building the client is local and
synchronous, so doing it first keeps the authorization result and the side effect
adjacent in the same stack frame. If client construction sat between them it
would be an invitation to make it asynchronous later and reopen the window Gate 8
exists to narrow.

**The allowance never leaves the stack frame.** It is not returned, stored,
cached, queued or persisted. Every call authorizes afresh; two sends make two
authorization calls.

**The credential is deliberately not `TWILIO_AUTH_TOKEN`.** That variable is the
account master secret used by `api/_lib/twilio.mjs` to verify *inbound* webhook
signatures. Outbound uses a scoped API Key pair, so a leak of one does not hand
over the other and either can be rotated alone. `TWILIO_API_KEY_SECRET` and
`TWILIO_API_KEY_SID` were also added to `check.mjs`'s `SECRET_NAMES`, so neither
can ever appear in anything delivered to a browser.

**Overlength input is refused, never truncated** — CLAUDE.md rule 11. A silently
shortened message is a message the operator did not approve. The 1,600-character
limit is the installed SDK's own documented maximum, read from
`node_modules/twilio`, not from memory. The same applies to the client
construction shape and to `autoRetry`, which defaults to `false` in twilio 6.1.0
and retries only 429 — set explicitly anyway, so the one-attempt promise does not
rest on a library default a future upgrade could change.

### What the sender deliberately does NOT provide

No idempotency, no deduplication, no outbox, no durable retry, no exactly-once
delivery. **One invocation makes at most one `messages.create()` attempt and
never retries it.**

That is a refusal, not an omission. Once the provider call has been attempted, a
timeout or socket error is **ambiguous**: Twilio may have accepted and queued the
message while our answer was lost. Retrying blind is how a consumer receives the
same text twice; reporting "not sent" is a claim we cannot support.

**It never rejects.** Every path returns a result object, including the ones
where a dependency threw. If the Twilio client constructor throws, that is
`not_sent` / `TWILIO_CLIENT_UNAVAILABLE` — nothing was sent, so nothing is
ambiguous. If Gate 8 itself throws, that is `not_sent` / `NOT_AUTHORIZED`: a
defect in the boundary is not permission. Neither exception is inspected, because
a thrown error can carry request metadata including the destination number. A
caller that has to remember a `try`/`catch` to avoid a 500 is a caller that will
one day forget.

The result therefore distinguishes three states and never collapses them:

| `status` | meaning |
|---|---|
| `not_sent` | definitely nothing left this process |
| `accepted` | Twilio returned a well-formed message SID |
| `unknown` | the attempt was made and its outcome is not known |

Durable orchestration belongs to a layer that does not exist yet.

**Nothing in the result or the log shape carries a phone number, an email
address, a message body, a credential or provider exception text.** The Twilio
message SID is the one identifier that crosses the boundary, because it is the
only way a later reconciliation could find the message a call created.

### `tools/check.mjs` — new static guards

The build now fails if any of these stops being true:

- exactly **one** Twilio message-create call site exists under `api/`, and it is
  in the sender;
- no other module under `api/` constructs a Twilio client, names an outbound
  Messaging Service parameter, or reads an outbound Twilio credential;
- **no module under `api/`, the sender included, writes `api.twilio.com` or the
  `Messages.json` REST resource as a literal** — which closes the hand-rolled
  REST call as it would actually be written. It does **not** close a host
  assembled from fragments at runtime, and is not claimed to;
- **nothing under `api/` imports the sender** — this is what keeps it dark, and
  wiring it up is a deliberate act that has to delete this guard;
- the sender imports `authorizeSms` from Gate 8, defaults its test seam to it,
  and restores it on reset;
- the sender checks its feature flag **before** it reaches Gate 8, and compares
  that flag strictly to `"true"`;
- the sender's Gate 8 call site textually **precedes** its provider call site,
  and between them it refuses on `allowed !== true` and returns;
- **between those two call sites there is no suspension point** — no `await`,
  `.then()`, `yield`, `new Promise`, timer, `queueMicrotask` or
  `process.nextTick`;
- **and none inside the send's own argument list either.** An `await` there
  resolves *before* the request is made, so it sits in the same window — and it
  falls outside the region above, which ends where the call begins. This gap was
  found by the adversarial review and closed, with its own mutation case.

The pre-existing guard that no module outside Gate 8 may name `canSendSms` or
`canPlaceAutomatedVoiceCall` already applied to the sender and still does.

**One guard was narrowed during implementation rather than exempted.** A first
draft forbade any case-insensitive `messagingServiceSid` outside the sender,
which fired on `api/twilio-inbound.js` — where `params.MessagingServiceSid` is a
legitimate *inbound* webhook parameter recorded as opt-out evidence. A
containment rule that fires on the module it is meant to protect gets deleted, so
the pattern was made case-sensitive to the SDK's outbound spelling. The raw-REST
route it was doubling up on is closed by the `api.twilio.com` guard instead:
nothing can POST a message to Twilio without naming its host.

### What the adjacency guard does and does not prove

**Stated plainly, because the temptation to overstate it is the whole reason this
paragraph exists.** The region guard reads the sender's own source between two
call sites and proves there is no suspension point there. It **cannot** prove
adjacency in general: move the authorization into a helper two frames away, store
the decision on an object, or wrap the provider call, and no regex would notice.

What covers the *current* implementation is the executable ordering test, which
observes the real call order — client, authorize, create — through an injected
provider double. That is evidence about this code, not a property of whatever
replaces it.

Likewise, that the sender does not cache an earlier `ALLOWED` is **tested, not
statically enforced**.

### `api/twilio-inbound.js` — comments only, no runtime change

Three architectural comments had gone stale and one was false:

- "send-time enforcement is GATE 8 and has **NOT BEGUN**" — Gate 8 has been
  merged since #41;
- "**no automated outbound sender exists**" — one does now, dark;
- "the consent feature is **OFF in Production**" — it is **ON**, and has been
  since activation.

All three are corrected in place. No executable line changed;
`tests/suppression.test.mjs`, which mutates this file by literal string, still
passes untouched.

### `.env.example`

It said, in terms: *"Twilio and Retell credentials are deliberately NOT
documented here yet. No code reads them."* **This diff made the first half of
that false**, and the `TWILIO_AUTH_TOKEN` half had been false since gate 7
merged. The paragraph is replaced by a documented **OUTBOUND SMS — DARK** block
covering `OUTBOUND_SMS_ENABLED`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`,
`TWILIO_API_KEY_SECRET` and `TWILIO_MESSAGING_SERVICE_SID`, each with what it is,
why the key pair is deliberately not the auth token, and an instruction to leave
all of them blank.

**Named follow-up, deliberately not absorbed into this change** (CLAUDE.md rule
17): `TWILIO_AUTH_TOKEN`, `OPERATOR_ACTION_SECRET` and
`CONSENT_LEDGER_SENDER_URL` are read by merged code and are still undocumented in
`.env.example`. That is a pre-existing gap belonging to gates 7 and 8, and it is
recorded in the file itself rather than widened into here.

### `docs/CURRENT-STATE.md`

The outbound-automation table row now reads **BUILT, NOT WIRED, NOT ACTIVATED**
instead of **NOT BUILT**, with the list of what is unconfigured and unproven kept
intact. The Gate 8 section's "what the build guard actually proves" split was
rewritten: several items moved from *unenforceable* to *proved on every build*,
and the ones that did not move say so and say why.

---

## Tests

`tests/sms-sender.test.mjs` — **49 passing**, Tier 4. Nothing contacts Twilio,
HubSpot or Neon: both boundaries are injected, and the sender's own control flow,
validation, ordering and result handling are the real ones.

The cases that carry the most weight:

- the flag OFF reaches **nothing** — no Gate 8 call, no client, no provider, so a
  dark system spends no HubSpot or Neon round trip;
- every missing or structurally impossible configuration value fails closed
  before any I/O;
- an unusable target and an empty or overlength body never reach Gate 8;
- an overlength body is **refused**, and a body at exactly the limit passes
  through byte for byte;
- the observable order is `client`, `authorize`, `create` — exactly once each;
- three sends perform **three** authorizations;
- a denial later in a sequence stops that send;
- the number Gate 8 authorized is the number that is texted, for four input
  spellings of the same number;
- a caller cannot smuggle `from` or `messagingServiceSid` into the provider call;
- a throw from the provider is `unknown`, never a false "not sent", and is
  attempted **once**;
- **Gate 8 throwing is a refusal**, never a rejection and never permission;
- **a client that cannot be built is a refusal** reached *before* Gate 8, and the
  constructor's error text does not escape;
- a well-formed-looking response that is not a message resource is `unknown`, not
  `accepted`;
- across **twelve** outcomes, no result and no log shape carries a phone, email,
  body, credential or provider text.

**Permanent mutation cases.** Twenty of those tests run the real
`tools/check.mjs` against a **throwaway copy** of the tree with one invariant
broken — an inserted `await`, a `.then()`, a timer, a `queueMicrotask`, a
`new Promise`, an `await` hidden in the send's argument list, a weakened denial,
a deleted denial, a send moved above the authorization, a flag checked too late,
a non-strict flag, a second send site, a send from another module, a client built
elsewhere, an outbound credential read elsewhere, a raw REST call from inside and
outside the sender, a Gate 8 bypass, a test seam whose default is not Gate 8, and
an endpoint importing the sender.
Each asserts the real script refuses it with the message that invariant owns, and
each asserts its target is present *before* mutating and that the text actually
changed — a mutation test that does not mutate reports green while proving
nothing, which this project has shipped once before.

**The working tree is never mutated.** The copy is made under the OS temp
directory and removed afterwards.

`tests/suppression.test.mjs` — 90 passing, unchanged, re-run because the comment
corrections touch a file it mutates by literal string.

`npm run check` passes.

---

## What a human must still do before a single SMS can be sent

None of this is done, and none of it was attempted:

1. **Get the A2P Campaign approved.** It is currently rejected under 30882 and
   has not been resubmitted.
2. **Provision the outbound Twilio credentials** — an API Key pair scoped to the
   account, and the Messaging Service SID — in Vercel.
3. **Provision `CONSENT_LEDGER_SENDER_URL`**, the EXECUTE-only Neon sender role,
   without which Gate 8 fails closed on every call.
4. **Write the orchestrator** that decides what a message says and when. It does
   not exist. When it is written it must delete the "nothing imports the sender"
   guard deliberately, not incidentally.
5. **Set `OUTBOUND_SMS_ENABLED=true`** — last, and only after a controlled
   real-boundary verification.

---

## What is explicitly NOT done and NOT claimed

- **No live Twilio behaviour is proven.** No call has ever been made from this
  module. Error shapes, timeouts, rate limiting, and what a partial failure
  leaves behind are entirely unobserved. Passing tests here are evidence about
  the sender's logic and say nothing about the provider.
- **No live verification of anything.** `crystalsellstoledo.com` and `twilio.com`
  are egress-blocked from the agent environment; every claim about a live system
  in this document is repository-source or operator-reported and is labelled as
  such.
- **Adjacency is not proved in general**, only textually within this module — see
  above.
- **No Retell caller, no voice path, no orchestrator, no calendar booking, no
  nurture engine.** None of them was started.
- **No external system was touched.** Twilio, HubSpot, Neon, Retell, Vercel
  configuration and DNS are all unchanged.

---

## Lesson promotion

**Nothing promoted.** The one correction during implementation — a containment
pattern that fired on the module it was meant to protect — is already covered by
the existing body of practice: CLAUDE.md rule 17 on searching the shape rather
than the identifier, and `tools/check.mjs`'s own existing note that a rule which
fires on legitimate usage just gets deleted. Manufacturing a new rule for it
would be the failure CLAUDE.md rule 20 names.
