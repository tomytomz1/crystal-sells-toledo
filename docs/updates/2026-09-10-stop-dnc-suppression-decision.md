# Gate 7 — STOP / DNC suppression: design decision document

**10 September 2026. DESIGN ONLY. Nothing here is implemented.**

Assume no repository access and no memory of previous conversations.

This settles *what* suppression means in this system and *why*, so that the
implementation session has nothing left to invent. It deliberately writes no
code, no migration and no test.

---

## 0. Why this needs a decision document at all

Consent capture, which is built, is one request that either succeeds or fails.
Suppression is not its mirror image. It is:

- **inbound** — an untrusted HTTP request from a third party, needing signature
  verification and replay handling;
- **irreversible** — a state that must never be un-set by anything automatic;
- **keyed differently** — a STOP arrives against a *phone number*, and this
  system's records are organised around *contacts*;
- **the highest-risk write in the phase** — getting it wrong in one direction is
  a TCPA violation, and in the other it silently destroys a lawful permission.

The consent ledger's only real defect so far was in a clause nobody had thought
to test, not in anything the design had reasoned through. That is the argument
for reasoning this through first.

---

## 1. What already exists

Substantial parts of the model are built and tested, and this design keeps all
of them. Nothing below is proposed as new.

| Already built | Where |
|---|---|
| `PERMISSION_STATE` — `never_granted` / `granted` / `revoked` / `suppressed` | `api/_lib/consent.mjs` |
| `SUPPRESSION_REASON` — `stop_keyword` / `voice_dnc` / `global_dnc` / `manual` / `carrier` | `api/_lib/consent.mjs` |
| `SUPPRESSION_SCOPE` — `sms` / `voice` / `global`, and `applySuppression()`, pure and additive | `api/_lib/permission.mjs` |
| `canSendSms()` / `canPlaceAutomatedVoiceCall()` with suppression outranking consent | `api/_lib/permission.mjs` |
| The nine `cst_*` suppression properties, plus the two `cst_reoptin_requested_*` | `api/_lib/hubspot-consent-state.mjs` |
| Fail-closed parsing — an incomprehensible suppression value is never read as "not suppressed" | `api/_lib/hubspot-consent-state.mjs` |
| Ledger event types `revoked`, `suppressed`, `unsuppressed`, `reoptin_requested`; channel `all`; columns `reason_code`, `evidence_text`, `metadata` | `api/_lib/consent-ledger.mjs`, `db/001` |
| `pending_reoptin` — a ticked box against a suppressed state does not clear it | `api/_lib/consent.mjs` |

**No second migration is needed.** The ledger was built with these columns
unused precisely so this phase would not have to alter an append-only table.

What does **not** exist: any inbound endpoint, any writer of suppression, any
caller of the permission resolver, and any read path for suppression state.

---

## 2. The decisions

### 2.1 Suppression is keyed to the PHONE NUMBER. The contact flag is a projection.

**Decision: the authoritative key is `phone_e164`. HubSpot contact flags are a
derived, operator-facing copy — never the source of truth.**

The obligation attaches to the handset, not to a CRM row. The person who
replied STOP was telling us not to message *that number*. A contact record is
our filing convenience and can be duplicated, merged, renamed or deleted
without their knowledge.

Concretely this means **send-time enforcement must resolve suppression by
number**. If it resolved by contact, then a second contact created later with
the same number — a new enquiry from the same household, a merge that went
wrong, a manual entry — would carry no suppression flag and the send would be
allowed. That is the exact failure this decision exists to prevent.

The ledger is already shaped for this: `phone_e164` is `NOT NULL` on every row,
including `consent_not_selected`, precisely because an event that does not say
which number it concerns proves nothing about that number.

#### The tension this creates, stated plainly

**The application role holds `INSERT` and nothing else — it cannot read the
ledger.** That was a deliberate security decision (a leaked
`CONSENT_LEDGER_URL` must not be able to enumerate numbers and consent
decisions) and this design does not weaken it.

The website path needs no read: it never sends. But a *sender* does. Three
options, with a recommendation:

| Option | Trade-off |
|---|---|
| **A. Search HubSpot by phone at send time** | No new credential. But HubSpot phone search is format-sensitive, contacts can be deleted (as gate 4B demonstrated), and it makes the mutable copy authoritative — the thing this architecture exists to avoid. **Rejected.** |
| **B. Give the existing role `SELECT`** | Simplest, and destroys the property that a leaked URL cannot enumerate the table. **Rejected.** |
| **C. A separate read-only role, restricted to a suppression view** — `SELECT` on a view exposing only `(phone_e164, channel, event_type, occurred_at)` for suppression-class events, held by the sender and never by the website | Needs migration `002` and a second credential. Keeps the website `INSERT`-only. Exposes numbers to the *sender*, which must know them anyway to send. **Recommended.** |

**Option C is the recommendation, and it is a real decision for the operator to
confirm** — it introduces a second database credential, and the whole ledger
design has so far turned on there being only one, with no read access.

### 2.2 Multiple HubSpot contacts sharing one phone number

**Decision: suppression applies to the number, therefore to every contact
holding it. Write the flag to all of them; enforcement does not depend on
having done so.**

If three contacts share a number and one replies STOP, all three are suppressed
for that channel. There is no version of "this contact opted out but that one
didn't" that is defensible when both resolve to the same handset.

Practically:

1. The ledger event is written once, against the number. **This is the
   durable record and it does not depend on HubSpot at all.**
2. HubSpot contacts matching that number are then flagged, best-effort.
3. **Send-time enforcement consults the number (§2.1), so a contact the flag
   write missed is still refused.** The flag is for the operator's eyes; the
   refusal does not rely on it.

That ordering matters: it means a partial or failed HubSpot update degrades
operator *visibility*, never *compliance*.

### 2.3 Number reassignment

**Decision: suppression never expires and is never cleared automatically. A new
holder of a reassigned number who ticks a consent box produces
`reoptin_requested`, not a grant.**

Both failure directions are real, and they are not symmetric:

- **Keeping a stale suppression**: a new holder who genuinely wants texts does
  not get them. Cost: a lost lead, and an annoyance we can resolve by hand.
- **Clearing a suppression on new consent**: the previous holder's STOP is
  erased by someone else's action. Cost: messaging a person who affirmatively
  opted out. That is a TCPA violation and an unrecoverable breach of trust.

The asymmetry decides it. **Never clear automatically.**

Two further facts reinforce it. Where Twilio holds its own carrier-level
opt-out for a number, clearing our record would not make the message
deliverable anyway — we would have destroyed our evidence and changed nothing.
And a reassignment is invisible to us: we cannot tell a new holder from the
same person changing their mind.

Unsuppression is therefore a **deliberate, auditable, human-initiated
transition** writing an `unsuppressed` ledger event with its own evidence, and
it is out of scope for gate 7. Reassignment-detection services exist and are
explicitly **not** proposed here.

### 2.4 STOP keyword handling

**Decision: Twilio is the enforcement point. We mirror its decision; we do not
implement it.**

Twilio intercepts the standard opt-out keywords — STOP, STOPALL, UNSUBSCRIBE,
CANCEL, END, QUIT — at its own layer. It blocks further messages to that number
from that sender and replies with the confirmation itself. **This happens
whether or not our webhook succeeds.**

So our job on receiving the inbound webhook is to record it: append a
`suppressed` ledger event with `reason_code = stop_keyword`, and set the HubSpot
flags. Our records are a *copy* of a decision Twilio has already enforced.

Two consequences worth writing down:

- **We cannot override it.** Nothing we write makes a Twilio-blocked number
  deliverable again.
- **Our record can lag or fail without a message getting through.** That is a
  genuine safety margin, and it is not an excuse to treat the webhook as
  optional — the ledger is the evidence, and evidence that is missing is
  evidence we cannot produce later.

Matching should be **case-insensitive and whitespace-trimmed**, and should
accept the keyword as the entire message body. A body that merely *contains*
"stop" ("stop by the open house on Sunday") is not a keyword opt-out and is
handled by §2.5, not here.

### 2.5 Natural-language opt-out

**Decision: yes, handle it — with a narrow, deterministic, conservative
allowlist, biased toward suppressing. Never toward un-suppressing.**

Twilio does **not** auto-handle "please stop texting me", "remove me from your
list", "no more messages". A system that ignores them is relying on the
consumer knowing the magic word, which is not a defensible position and is
increasingly not a lawful one.

The error costs are asymmetric again:

- **False positive** (suppressing someone who didn't mean it): one lost lead,
  visible to the operator, recoverable by an explicit human unsuppression.
- **False negative** (missing a real opt-out): continuing to message someone who
  asked us to stop.

So the bias is toward suppressing. But the mechanism should be **deterministic
phrase matching, not a language model** — at least initially. A classifier adds
a network dependency, a latency budget and a failure mode to a path whose whole
job is to be reliable, and its errors are unexplainable after the fact. A
phrase list can be read, reviewed, tested and cited in a compliance
conversation.

**Additionally: every inbound message that is neither a keyword nor a matched
phrase should be surfaced to the operator**, not silently discarded. A human
reading "who is this? don't contact me again" catches what a phrase list
misses.

**This is the decision most in need of the operator's input** — specifically
how aggressive the phrase list should be, since it trades leads against risk.
The recommendation is: aggressive.

### 2.6 Voice DNC

**Decision: a spoken opt-out during an automated call suppresses `ai_voice`
with `reason_code = voice_dnc`, by the same rules as SMS.**

`applySuppression({ scope: VOICE })` already exists and sets
`cst_do_not_call` + `cst_do_not_call_at` + `cst_do_not_call_reason` and marks
the channel `suppressed`.

**SMS and voice are separate records with separate effects.** Someone who says
"don't call me" has not opted out of texts, and suppressing both would destroy a
permission they did not withdraw. `canSendSms()` and
`canPlaceAutomatedVoiceCall()` already treat them independently.

The National DNC registry is a **separate obligation** with its own
established-business-relationship exemptions. It is **not** in scope for gate 7
and this document makes no claim about it.

### 2.7 Global do-not-contact

**Decision: an explicit all-channel request sets the global suppression, which
cascades to both channels and is written to the ledger with `channel = 'all'`.**

`applySuppression({ scope: GLOBAL })` already sets `suppression.global`, fills
`suppression.sms` and `suppression.voice` where not already set, and marks both
channel statuses `suppressed`. `canSendSms()` and
`canPlaceAutomatedVoiceCall()` both check `suppression.global` first, before
any channel logic.

Global is reserved for an **unambiguous** all-channel request ("stop contacting
me"), a legal demand, or a manual operator entry. **A channel-specific STOP does
not escalate to global** — it says what it says.

### 2.8 Twilio webhook signature verification

**Decision: verify `X-Twilio-Signature` before parsing anything. An unverified
request is rejected with 403 and never reaches the ledger.**

Twilio signs with HMAC-SHA1 over the full request URL concatenated with the POST
parameters sorted by key, keyed by the account auth token.

Non-negotiables for the implementation session:

- **Verify before parse.** The body is attacker-controlled until the signature
  says otherwise.
- **Constant-time comparison.** A byte-by-byte `===` on a signature is a timing
  oracle.
- **The URL must match exactly what Twilio signed**, including scheme and host.
  Behind Vercel this means reconstructing from `x-forwarded-proto` and
  `x-forwarded-host` rather than trusting a local notion of the request URL.
  **This is the single most likely thing to get subtly wrong**, and it fails
  closed and loudly, which is the good direction.
- **The auth token is a secret.** `TWILIO_AUTH_TOKEN`, never `NEXT_PUBLIC_`,
  named in `tools/check.mjs`'s secret list like `CONSENT_LEDGER_URL`.
- **Never log the signature, the token, or the raw body.** The body is a
  consumer's message.

### 2.9 Webhook retry and idempotency

**Decision: idempotency by `MessageSid` through the ledger's existing dedupe
key. Retries are safe by construction.**

Twilio retries on any non-2xx. The dedupe key becomes:

```
twilio:<MessageSid>:<channel>:<event_type>
```

`MessageSid` is unique per inbound message, so a retried delivery of the same
message produces the same key and the existing `ON CONFLICT DO NOTHING` makes it
a no-op — **the property measured on live Neon on 10 September 2026**, not an
assumption.

Response policy, which is where the care is needed:

| Situation | Response | Why |
|---|---|---|
| Signature invalid | **403**, nothing written | Not from Twilio |
| Signature valid, ledger append **succeeds**, HubSpot write succeeds | **200** | Done |
| Signature valid, ledger append **fails** | **5xx** | The evidence is not durable. Let Twilio retry — dedupe makes that safe. |
| Signature valid, ledger append succeeds, **HubSpot write fails** | **200**, log loudly, reconcile later | The suppression **is** durable. Enforcement resolves by number (§2.1), so it is already effective. Returning 5xx would make Twilio retry forever against a HubSpot outage, and each retry would no-op the ledger anyway. |

That last row only holds because of §2.1. **If enforcement read HubSpot as the
source of truth, a failed HubSpot write would be a compliance hole and 200 would
be wrong.** The two decisions stand or fall together.

### 2.10 Ledger event semantics

**Decision: one `suppressed` event per suppressed channel, carrying the
consumer's own words as evidence.**

| Column | Value |
|---|---|
| `channel` | `sms`, `ai_voice`, or `all` for global |
| `event_type` | `suppressed` — or `revoked` when the person withdrew in words without a keyword or carrier action |
| `source` | `twilio` or `retell`, never `website` |
| `source_event_id` | `MessageSid` (or the call/event id) |
| `dedupe_key` | `<source>:<source_event_id>:<channel>:<event_type>` |
| `phone_e164` | the number that opted out — the key that matters |
| `reason_code` | a `SUPPRESSION_REASON` value |
| `evidence_text` | **the inbound message body, verbatim** |
| `metadata` | structural context — `MessageSid`, `AccountSid`, the matched rule |
| `hubspot_contact_id` | `NULL` at write time, as with website events |

**`revoked` and `suppressed` are different things** and the distinction is
already in the code: `revoked` is the consumer withdrawing in words;
`suppressed` is a STOP keyword or a carrier-level opt-out. Both deny sending.
Recording them identically would lose the reason a future reader needs.

**On `evidence_text` carrying the consumer's words**: that is a deliberate
widening of what this table holds, and it is justified — the message *is* the
evidence of the opt-out, and paraphrasing it would leave us unable to show what
was actually said. It should be length-capped, and it must never reach a log
line. It is the first consumer free text this system stores, and the
implementation session should treat that as a Tier 4 concern.

### 2.11 HubSpot suppression state writes

**Decision: the suppression writer only ever sets flags true. It never sets one
false, and never clears a timestamp or reason.**

The nine properties exist. The write is additive, in the same spirit as
`applySuppression()`.

The website path's existing rule is unchanged and must stay enforced: **an
ordinary form submission never writes a suppression property, in any
circumstance.** That is a different code path with a different credential, and
the separation is the point.

Where a suppression already exists with an earlier timestamp, **keep the
earlier one.** The first refusal is the one that matters; a later duplicate STOP
does not restart the clock.

### 2.12 Failure semantics

**Decision: fail closed, and distinguish "not suppressed" from "could not
check".**

The existing parser already refuses to read an incomprehensible value as "not
suppressed", and that principle extends to the whole path:

- **A suppression lookup that errors is not a green light.** The send is
  refused, with a reason distinguishing it from a known-clean state.
- **An inbound webhook that cannot be verified is not processed** — it is not
  "probably fine".
- **A ledger append that fails means the evidence is not durable**, and the
  webhook reports failure so Twilio retries.
- **The one thing that may fail softly is the HubSpot projection** (§2.9),
  because enforcement does not depend on it.

The general rule, unchanged from the consent phase: **never let an absent
record look like a permissive one.**

### 2.13 Why a later ticked box must never silently clear a suppression

This is already implemented — `foldConsent()` returns `pending_reoptin` when a
ticked box meets a `revoked` or `suppressed` prior state — and it is the single
most important rule in the phase. The reasons, in order:

1. **It may not be the same person.** Numbers get reassigned. A tick from the
   new holder cannot lawfully erase the old holder's STOP.
2. **A form tick is not the same act as reversing an explicit refusal.**
   Someone who replied STOP made a deliberate, channel-specific decision. A
   later web form is a different context and may not even be about messaging.
3. **Twilio's carrier-level opt-out would block the send anyway.** Clearing our
   flag would produce a record saying we may send, and sends that fail — the
   worst combination: wrong on paper, broken in practice.
4. **It would destroy the evidence trail.** The suppression record *is* the
   proof we honoured the opt-out. Overwriting it on a form submission means the
   one document that shows compliance is deleted by an ordinary lead.
5. **The direction of harm is asymmetric.** Wrongly keeping a suppression costs
   a lead. Wrongly clearing one costs a violation and the trust of someone who
   already told us to stop.

**Nothing is lost by refusing.** The tick is recorded — as a
`reoptin_requested` ledger event and `cst_reoptin_requested_at` /
`cst_reoptin_requested_channel` — so the operator can see that this person asked
again and can act on it deliberately. The evidence is kept *beside* the
suppression rather than *instead of* it.

---

## 3. What this design does not settle

Stated so the implementation session does not assume they were considered and
resolved:

- **The National DNC registry** and its established-business-relationship
  exemptions. A separate obligation, out of scope.
- **Reassignment-detection services.** Not proposed.
- **Unsuppression / re-opt-in flow.** Deliberately out of scope for gate 7; it
  needs its own design.
- **Twilio Messaging Service configuration**, advanced opt-out keyword
  customisation, and per-Messaging-Service opt-out lists.
- **Retell's specific webhook shape** for a spoken opt-out — the semantics are
  settled here, the transport is not.
- **Rate limiting and abuse handling** on the inbound endpoint.
- **Where the sender runs.** This document assumes a sender exists that consults
  suppression; gate 8 builds it.

---

## 4. Decisions the operator must confirm before implementation

1. **§2.1 Option C — a second, read-only database credential** restricted to a
   suppression view, so that send-time enforcement can resolve by number without
   giving the website role `SELECT`. This is a genuine change to a design that
   has so far had exactly one credential with no read access.
2. **§2.5 how aggressive the natural-language phrase list should be.** The
   recommendation is aggressive, trading leads for risk.
3. **§2.10 storing the consumer's message verbatim** in `evidence_text` — the
   first consumer free text this system would hold.

---

## 5. Status

**Gate 6 is externally blocked**: an existing Twilio A2P Brand is in a
support/TCR hold for error 30753 while Twilio works the email whitelist. No new
Brand, profile or campaign is to be created and the registration is not to be
changed while that case is open. Gate 7 can be designed and implemented
independently, but **no live SMS test is possible until gate 6 clears.**

**Nothing in this document is implemented.** No endpoint exists, nothing writes
a suppression, and nothing calls the permission resolver.
`COMMUNICATIONS_CONSENT_ENABLED` remains absent from Vercel Production.
