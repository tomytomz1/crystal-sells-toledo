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
signatures. Outbound uses a **separate** API Key pair, so a leak of one does not
hand over the other and either can be rotated alone. `TWILIO_API_KEY_SECRET` and
`TWILIO_API_KEY_SID` were also added to `check.mjs`'s `SECRET_NAMES`, so neither
can ever appear in anything delivered to a browser.

**Separate is not least privilege**, and nothing here establishes that it is. The
code checks one thing about the key SID: that it has the `SK` shape. An `SK` SID
says the credential is an API Key; it says nothing about whether the key is Main,
Standard or Restricted, and nothing about which permissions it holds. Whether it
is restricted to the minimum a Messaging send requires is an **operator
verification in the Twilio Console** that no code here can perform, and the
required permission names are deliberately not written down anywhere in this
repository — `twilio.com` is egress-blocked from every agent session in this
project, so a list written from memory would be a guess presented as a
requirement. See `.env.example`.

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

**It never rejects — for any argument.** Every path returns a result object.
`sendSms(null)`, `sendSms(42)`, `sendSms(msg, null)`, `sendSms(msg, { env: null })`
and a message whose getter throws are all `not_sent` / `MALFORMED_CALL`: a bad
invocation is a refusal, and nothing reinterprets a dangerous value into a usable
one. If the Twilio client constructor throws, that is `not_sent` /
`TWILIO_CLIENT_UNAVAILABLE` — nothing was sent, so nothing is ambiguous. If Gate 8
itself throws, that is `not_sent` / `NOT_AUTHORIZED`: a defect in the boundary is
not permission. No exception is inspected, because a thrown error can carry
request metadata including the destination number. A caller that has to remember a
`try`/`catch` to avoid a 500 is a caller that will one day forget.

### What a provider failure actually proves

The result distinguishes three states and never collapses them:

| `status` | meaning |
|---|---|
| `not_sent` | definitely nothing left this process |
| `accepted` | Twilio returned a well-formed message SID |
| `unknown` | the attempt was made and its outcome is not known |

**Not every thrown error means the same thing**, and an earlier version of this
module put all of them in `unknown`. That is as much a misreport as putting all of
them in `not_sent`. What the installed SDK actually guarantees, read from
`node_modules/twilio/lib/base/Version.js` and `RequestClient.js`:

- `createWithResponseInfo()` calls `throwException(response)` **only after a
  complete HTTP response has been received**, and only when its status is outside
  2xx. That constructs a `TwilioServiceException` (RFC-9457 body) or a
  `RestException` (legacy body), both carrying a numeric `status`.
- A transport failure — DNS, TLS, timeout, socket reset, abort — rejects out of
  `RequestClient.request()` with the underlying transport error, and is **never**
  either of those classes.

So membership of those two classes is proof the provider answered. A **4xx**
answer is proof the request was refused before any message resource existed:

| thrown | status | reason |
|---|---|---|
| `RestException` / `TwilioServiceException`, 401 or 403 | `not_sent` | `TWILIO_REJECTED_UNAUTHORIZED` |
| same, 429 | `not_sent` | `TWILIO_REJECTED_RATE_LIMITED` |
| same, any other 4xx | `not_sent` | `TWILIO_REJECTED` |
| same, 5xx or any other status | `unknown` | `TWILIO_PROVIDER_ERROR_UNCONFIRMED` |
| anything else — transport error, `TypeError`, a thrown string, `null` | `unknown` | `TWILIO_SEND_UNCONFIRMED` |

**Identity, not duck typing.** The check is `instanceof` against the SDK's own
classes, so an arbitrary thrown object carrying `{ status: 400 }` cannot talk this
module into reporting "definitely not sent". The one thing worse than an ambiguous
answer is a confident wrong one. A tested case covers exactly that forgery.

**5xx stays `unknown` deliberately.** A server error does not establish whether
the message was accepted before it happened. **And the residual is stated:** a 4xx
is treated as proof of refusal, so a middlebox that forwarded the request and then
answered 4xx itself would defeat it. That is not defended against, and no evidence
available here could distinguish it.

Durable orchestration belongs to a layer that does not exist yet.

**Nothing in the result or the log shape carries a phone number, an email
address, a message body, a credential or provider exception text.** The Twilio
message SID is the one identifier that crosses the boundary, because it is the
only way a later reconciliation could find the message a call created.

### `tools/check.mjs` — new static guards

The build now fails if any of these stops being true:

- exactly **one** Twilio message-create call site exists under `api/`, and it is
  in the sender;
- no module under `api/` other than the sender reaches the message-create API **in
  any of the shapes the guard names** — `messages.create`, `messages["create"]`,
  `client["messages"]`, or a *bare reference* with no call parenthesis at all;
- no other module under `api/` constructs a Twilio client, names an outbound
  Messaging Service parameter, or reads an outbound Twilio credential;
- **no module under `api/`, the sender included, writes `api.twilio.com` or the
  `Messages.json` REST resource as a literal** — which closes the hand-rolled
  REST call as it would actually be written. It does **not** close a host
  assembled from fragments at runtime, and is not claimed to;
- **nothing under `api/` imports the sender** — this is what keeps it dark, and
  wiring it up is a deliberate act that has to delete this guard;
- **the sender declares no module-scope `let` or `var`, and exports no `_set*`
  mutator** — the two shapes a runtime Gate 8 override needs;
- **the sender never names `TWILIO_AUTH_TOKEN`** — the outbound path must not
  reach for the inbound master secret, which is the whole reason it has its own
  key pair;
- the exported `sendSms` is built over `authorizeSms` **and** `realClient`, at
  module load;
- no module under `api/` other than the sender names `_senderForTest`;
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

`tests/sms-sender.test.mjs` — **77 passing**, Tier 4, behaviour only.
`tests/sms-sender-guards.test.mjs` — **39 passing**, the mutation cases. They are
separate files so the runtime mutations below can run the behavioural suite
against a throwaway tree without recursing into themselves.

Nothing contacts Twilio, HubSpot or Neon: every sender under test is built over
injected boundaries by `_senderForTest()`, and the sender's own control flow,
validation, ordering, failure classification and result handling are the real
ones.

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
- **a provider-confirmed 4xx is `not_sent`**, across seven cases covering both
  exception classes, built by driving the SDK's **own** `throwException()` rather
  than by hand — so the class and the fields are chosen by `node_modules/twilio`;
- **a 5xx, a timeout, a socket reset, a DNS failure, a bare `Error`, a
  `TypeError`, a thrown `null` and a thrown string are all `unknown`**, across ten
  cases;
- **a forged error carrying `status: 400` is `unknown`**, not a definite answer;
- an SDK error whose `status` getter throws, or whose status is not an integer, is
  `unknown`;
- **exactly one** provider attempt in every outcome — nothing retries;
- **Gate 8 throwing is a refusal**, never a rejection and never permission;
- **a client that cannot be built is a refusal** reached *before* Gate 8, and the
  constructor's error text does not escape;
- a well-formed-looking response that is not a message resource is `unknown`, not
  `accepted`;
- **every malformed call shape refuses and reaches nothing** — no argument, `null`,
  a number, a string, an array, a boolean, a function, `null` options, numeric
  options, `env: null`, `env: "bad"`, a throwing getter on the message, a throwing
  getter on `options.env`, and a `Proxy` that throws on every read;
- **building a permissive test sender does not affect the exported `sendSms`**,
  which reaches the real Gate 8 and refuses;
- the module exports no `_set*` mutator at all;
- across **seventeen** outcomes, no result and no log shape carries a phone,
  email, body, credential or provider text.

**Permanent mutation cases — 37 of them, in two kinds.**

**Static (31).** Break one invariant in a throwaway copy and assert the real
`tools/check.mjs` refuses it with the message that invariant owns: a reintroduced
`_setAuthorizer`, a module-scope `let`, a module-scope `var`, an exported
`sendSms` bound to a fake authorizer, one bound to a fake provider, another module
using `_senderForTest`, a second send site, computed access inside the sender, a
send from another module, computed access on the call, computed access on the
resource, a **bare reference** with no call parenthesis, a client built elsewhere,
an outbound credential read elsewhere, the sender reaching for
`TWILIO_AUTH_TOKEN`, a raw REST call from inside and from outside the sender, a
plain import, a namespace import and a dynamic import of the dark sender, an inserted `await`, `.then()`, timer, `queueMicrotask` and
`new Promise`, an `await` hidden in the send's argument list, a weakened denial, a
deleted denial, a send moved above the authorization, a flag checked too late, and
a non-strict flag.

**Runtime (6).** Some invariants cannot be read off the source at all — whether a
4xx is classified as a refusal, whether a malformed call throws. For those the
**test suite** is the guard, so these mutate the sender in a throwaway copy and
assert the real behavioural suite **fails**: a rejection collapsed back into
`unknown`, a timeout reported as definitely not sent, duck typing instead of
`instanceof`, a malformed message left to throw, malformed options reinterpreted,
and a second provider attempt. Each asserts the *specific* failing test name, so a
mutation that fails the suite for some unrelated reason does not count.

Two controls run first: the pristine copy must pass `tools/check.mjs` **and** the
behavioural suite. Every mutation asserts its target is present *before* mutating
and that the text actually changed — a mutation test that does not mutate reports
green while proving nothing, which this project has shipped once before.

**The working tree is never mutated.** The copy is made under the OS temp
directory and removed afterwards; `node_modules` is symlinked, not copied, because
the classification tests must keep importing the real SDK.

`tests/suppression.test.mjs` — 90 passing, unchanged, re-run because the comment
corrections touch a file it mutates by literal string.
`tests/send-permission.test.mjs` and `tests/consent-build-gate.test.mjs` — included
in a combined targeted run of **251 pass, 0 fail**.

`npm run check` passes.

**Full local suite** — `npm test` (build + check + every test file):
**1126 tests, 1121 pass, 0 fail, 5 skipped**, 139 s.

**The 5 skips are precise, not incidental.** They are `db/003 — the unsuppression
fold, against a real PostgreSQL`, which skips because `CST_TEST_PG_URL` is unset:
**no real PostgreSQL was exercised in this run**, so db/003's fold and privilege
matrix were not executed here. That suite is unrelated to this change and skips
the same way in CI unless an operator supplies a scratch cluster. Nothing else was
skipped, and nothing in this change depends on it.

---

## What a human must still do before a single SMS can be sent

None of this is done, and none of it was attempted:

1. **Get the A2P Campaign approved.** It is currently rejected under 30882 and
   has not been resubmitted.
2. **Provision the outbound Twilio credentials in Vercel** — an API Key pair and
   the Messaging Service SID. Create a **Restricted** API Key holding only the
   permissions a Messaging send requires. The exact permission names must come
   from current Twilio documentation at that moment; they are deliberately not
   written in this repository because no agent session here can reach `twilio.com`
   to verify them. **Nothing in the code can check that the key is restricted**, or
   to what — that verification is yours, in the Console.
3. **Provision `CONSENT_LEDGER_SENDER_URL`**, the EXECUTE-only Neon sender role,
   without which Gate 8 fails closed on every call.
4. **Write the orchestrator** that decides what a message says and when. It does
   not exist. When it is written it must delete the "nothing imports the sender"
   guard deliberately, not incidentally.
5. **Set `OUTBOUND_SMS_ENABLED=true`** — last, and only after a controlled
   real-boundary verification.

---

## Correction round — independent review of head `8b2ec3b`

**The chronology matters and is not flattered here.** The four findings below
were raised by an **independent ChatGPT review** of PR #51 at head
`8b2ec3bba4d2ba529d88920411102f9882da0ba0`, *after* that head had been pushed,
after its CI had passed, and after a PULSE HANDOFF had been posted calling the
work complete. They were **not** found by the pre-handoff adversarial review in
this session, which found four different things and missed these. A review that
finds nothing is not the same as a change that has nothing left in it.

### 1. A production-callable Gate 8 override seam — **the most serious**

The module exported `_setAuthorizer()` over a module-level `let authorize`. Any
importer could have written `_setAuthorizer(async () => ({ allowed: true }))` and
replaced Gate 8 entirely. **This module shipped an authorization-bypass mechanism
inside the production path**, and the static guard that "proved" the seam's
default pointed at Gate 8 did not help, because the default was never the problem.

**Resolved by deleting the seam, not renaming it.** There is now no module-level
mutable binding and no exported mutator at all. A private `makeSender({ authorize,
clientFactory })` builds a sender that **closes over** its boundaries, and the
exported `sendSms` is built from it once, at module load, over the real
`authorizeSms` and the real client factory. A test builds its own independent
sender with `_senderForTest()`; doing so cannot alter the exported one, because
the exported one never looks anything up.

Mechanically guarded, five ways: no module-scope `let`/`var` in the sender; no
exported `_set*`; the exported `sendSms` must be built over `authorizeSms` **and**
`realClient`; no module under `api/` other than the sender may name
`_senderForTest`; and — still — nothing under `api/` may import the sender at all.
Each has its own mutation case. A behavioural test additionally builds a
permissive test sender and then shows the exported `sendSms` still reaching the
real Gate 8 and refusing.

### 2. Every provider exception was classified `unknown`

A timeout and a Twilio `400 Invalid 'To' Phone Number` are not the same event, and
reporting both as "we don't know" is a misreport in the other direction. Resolved
by reading the installed SDK's actual contract — see *What a provider failure
actually proves* above. A 4xx carried by one of the SDK's own exception classes is
now `not_sent`; 5xx and every non-response failure stay `unknown`. The check is
`instanceof`, never duck typing, so a forged `{ status: 400 }` cannot produce a
confident wrong answer.

### 3. `sendSms()` did not satisfy its own "never rejects" contract

Parameter destructuring defaults only cover `undefined`, so `sendSms(null)` threw
before a line of the body ran, and `{ env: null }` broke downstream. Resolved by
normalising both arguments inside the body, inside a `try` — so a throwing getter
or a hostile `Proxy` is a malformed call, not an escaping exception. Every such
case is `not_sent` / `MALFORMED_CALL`, reaches nothing, and echoes nothing back.
Seventeen explicit cases cover it.

### 4. "Scoped API Key" claimed a property the code cannot establish

An `SK` SID proves the credential is an API Key and nothing more — not that it is
Restricted, and not which permissions it holds. **The word "scoped" is withdrawn**
from the module, `.env.example`, `docs/CURRENT-STATE.md` and this document; the
credential is described as a *separate outbound API key pair*, which is what it
demonstrably is. A Restricted key is documented as an **operator action at
activation**, with its exact permission names deliberately left to current Twilio
documentation at that moment — `twilio.com` is egress-blocked from every agent
session in this project, so a list written from memory would be a guess presented
as a requirement.

### Found by the adversarial review of the correction itself

**The outbound sender could have read `TWILIO_AUTH_TOKEN` and nothing would have
objected.** Separating the outbound API key from the inbound master secret is the
stated reason the key pair exists — but no guard stopped the sender reaching for
the auth token anyway, which would have meant sending on a credential that cannot
be rotated without breaking gate 7's signature verification. Closed with a guard
and its own mutation case.

Two things the same pass checked and found sound, recorded because "we looked" is
worth more than silence: `autoRetry` is genuinely plumbed from the client options
through `BaseTwilio` into `RequestClient`, defaults to `false`, and applies only
to 429 (re-read in `node_modules/twilio`); and the guards harness symlinks
`node_modules` into its throwaway tree, where `rmSync(dir, { recursive: true })`
unlinks the symlink rather than following it — verified by experiment before
relying on it, because the failure mode would have been deleting the real
`node_modules`.

### Found while fixing them

**The runtime mutation harness reported green while proving nothing.** The six new
runtime cases spawn `node --test` inside a test process, which inherits
`NODE_TEST_CONTEXT`; a nested test runner that sees it behaves as a child reporter
and exits 0 whatever its tests did. All six "passed" in ~70 ms against deliberately
broken code. Fixed by stripping that variable from the child environment, and the
controls now assert the pristine copy passes **both** `tools/check.mjs` and the
behavioural suite before any mutation runs. This is the same failure class the
repository already names — *a mutation test that does not mutate reports green* —
arriving by a new route, and it is the reason the harness has controls at all.

---

## What is explicitly NOT done and NOT claimed

- **No live Twilio behaviour is proven.** No call has ever been made from this
  module. Error shapes, timeouts, rate limiting, and what a partial failure
  leaves behind are entirely unobserved. Passing tests here are evidence about
  the sender's logic and say nothing about the provider. **In particular the
  failure classification is read off the SDK's source, not off the wire:** that a
  real Twilio 4xx arrives as one of those two exception classes is inferred from
  `node_modules/twilio`, and has never been observed against the live API.
- **The credential's privilege is not established by anything here.** The code
  checks the `SK` shape. Whether the key is Restricted, and to what, is an
  operator verification in the Twilio Console.
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

**One promoted, and it is worth obeying forever:**

> **A test seam that production code can reach is not a test seam — it is the
> feature it was meant to stand in for.** Inject boundaries by construction and
> close over them. A guard proving a mutable seam's *default* is correct proves
> nothing about what the seam can be set to.

That earns its place because it is not a restatement of an existing rule, it
would have caught this defect before it was written, and it generalises beyond
this module — any future Retell caller, orchestrator or CRM writer with an
injected boundary is the same shape. The rationale goes in
`docs/ENGINEERING-LESSONS.md`; the compact invariant goes in `CLAUDE.md`.

**Nothing else promoted.**

- The `NODE_TEST_CONTEXT` harness defect is a new *instance* of a rule the
  repository already carries ("a mutation test that does not mutate reports
  green"); the fix belongs in the harness, not in a second rule.
- Findings 2, 3 and 4 are each already covered: rule 14 (evidence at the lowest
  real boundary — the classification is now read from the SDK's own thrower),
  rule 11 (reject, never silently reinterpret) and rule 18 (prose may not outrun
  the evidence). Manufacturing rules for them would be the failure rule 20 names.

**Repository-wide search for the promoted shape**, run before promoting: `grep`
over `api/` and `tools/` for `_set`, `export function _`, and module-scope `let`
declarations. It returns the ledger's `_setExecutor` / `_resetExecutor`
(`api/_lib/consent-ledger.mjs`), Gate 8's own executor and contact-lookup seams
(`api/_lib/send-permission.mjs`), and the HubSpot fetch seam. **Those are a named,
sequenced follow-up and are NOT changed here** (CLAUDE.md rule 17): none of them
sits in front of a provider side effect that this repository can currently cause,
and widening this correction into Gate 8's own internals during a correction round
is exactly how a delta stops being reviewable.

---

## Named follow-ups — sequenced, deliberately NOT done here

CLAUDE.md rule 17: a material defect is not isolated until the repository has been
searched for the same *shape*, and out-of-scope matches are recorded as named,
sequenced follow-ups rather than absorbed into the current change.

1. **Mutable test seams in front of other boundaries.** The search above found
   `_setExecutor` / `_resetExecutor` in `api/_lib/consent-ledger.mjs`;
   `_setSuppressionExecutor` and `_setContactLookup` in
   `api/_lib/send-permission.mjs` — **Gate 8's own internals**; and
   `_resetTokenCache` in the dormant `api/_lib/zoho.mjs`. Every one is the same
   shape as the seam removed from the sender, and each is reachable by any
   importer.
   **Why not now:** none of them sits in front of a provider side effect this
   repository can currently cause — the ledger seam gates an `INSERT`, the Gate 8
   seams gate *reads*, and Zoho is imported by nothing. Converting Gate 8 to
   construction-time injection is a change to the authorization boundary itself
   and belongs in its own reviewable PR, not in a correction round for the module
   that sits in front of it. **Gate 8's seams are the higher-priority of the
   three** and should be taken first.
   (`api/_lib/security.mjs`'s `_resetRateLimit` / `_rateLimitSize` are not in this
   class: they read and clear an internal counter and inject no behaviour.)
2. **`.env.example` still omits three variables merged code reads** —
   `TWILIO_AUTH_TOKEN`, `OPERATOR_ACTION_SECRET` and `CONSENT_LEDGER_SENDER_URL`.
   A pre-existing gate 7 / gate 8 gap, recorded in the file itself.
