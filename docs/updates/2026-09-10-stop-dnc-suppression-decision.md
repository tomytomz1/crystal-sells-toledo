# Gate 7 — STOP / DNC suppression: design decision document

**10 September 2026. DESIGN ONLY. Nothing here is implemented.**

> **Implementation-review corrections, 10 September 2026.** Several statements
> in this document were found inaccurate when it was implemented and reviewed
> against current Twilio documentation. They are corrected **in place, marked as
> corrections** — the design decisions themselves are unchanged and were not
> reopened.
>
> | Where | What was wrong |
> |---|---|
> | §2.1 | the lookup function's draft returned `min(occurred_at), min(reason_code)` — independent aggregates that pair values from different rows |
> | §2.4 | the standard Twilio keyword list omitted `REVOKE` and `OPTOUT` |
> | §2.5 | the fallback keyword list did not match the implementation |
> | §2.8 | "before parsing anything" — form decoding is required *in order to* verify |
> | §2.9 | "Twilio retries on any non-2xx", twice |
> | §2.10 | claimed unclassified messages are surfaced, and that `occurred_at` holds Twilio's timestamp |
> | §2.12 | "reports failure so Twilio retries" |
>
> The as-built record is `docs/updates/2026-09-10-stop-dnc-suppression.md`.

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

**The ledger table needs no alteration.** It was built with these columns unused
precisely so this phase would not have to change an append-only table. A
migration `002` **is** needed, but only to *add* the suppression-lookup function
and the sender role of §2.1 — `db/001` stays byte-identical to what was
applied.

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

#### The tension this creates, and how it is resolved

**The application role holds `INSERT` and nothing else — it cannot read the
ledger.** That was a deliberate security decision (a leaked
`CONSENT_LEDGER_URL` must not be able to enumerate numbers and consent
decisions) and this design does not weaken it.

The website path needs no read: it never sends. But a *sender* does. Four
options were weighed:

| Option | Verdict |
|---|---|
| **A. Search HubSpot by phone at send time** | **Rejected.** HubSpot phone search is format-sensitive, contacts can be deleted — gate 4B demonstrated exactly that — and it makes the mutable copy authoritative, which is the thing this architecture exists to avoid. |
| **B. Give the existing role `SELECT`** | **Rejected.** Destroys the property that a leaked URL cannot enumerate the table. |
| **C. A second role with `SELECT` on a suppression view** | **Rejected.** Better than B, but a view the credential can `SELECT` is a view it can dump: one query returns every suppressed number in the system. |
| **D. A second role with `EXECUTE` on a `SECURITY DEFINER` function and no table privileges at all** | **DECIDED.** The credential can ask "is this number suppressed?" and cannot ask "which numbers are suppressed?" |

**Decision: option D.** A least-privilege function, approved by the operator on
10 September 2026:

> **Correction (implementation review).** The draft below returned
> `min(occurred_at), min(reason_code)` — two **independent** aggregates, which
> pair a timestamp from one row with a reason from a **different** row.
> Reproduced on PostgreSQL 16: with rows `2026-09-01 stop_keyword` and
> `2026-09-05 natural_language`, it returned `2026-09-01 natural_language`.
> **`db/002` as shipped returns `channel` and `suppressed_at` only** — the
> sender decides from the *presence* of a suppression, and a column that is not
> returned cannot be mis-paired. The snippet is left as drafted so the
> correction is legible; `db/002_suppression_lookup.sql` is authoritative.

```sql
CREATE FUNCTION get_suppression_state(p_phone text)
RETURNS TABLE (channel text, suppressed_at timestamptz, reason_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public      -- see hardening below
AS $$
  SELECT e.channel, min(e.occurred_at), min(e.reason_code)
  FROM public.communication_consent_events e
  WHERE e.phone_e164 = p_phone
    AND e.event_type IN ('suppressed','revoked')
  GROUP BY e.channel;
$$;

REVOKE EXECUTE ON FUNCTION get_suppression_state(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_suppression_state(text) TO <sender_role>;
```

##### Is it actually safer? Measured, not asserted.

Verified on a throwaway PostgreSQL 16 with `db/001` applied verbatim, a sender
role holding **no table privileges whatsoever**, and the function above:

| Check | Result |
|---|---|
| sender's privileges on `communication_consent_events` | **NONE** |
| `SELECT * FROM get_suppression_state('<suppressed number>')` | returns the row |
| same, for a number that is **not** suppressed | **0 rows** |
| `SELECT count(*) FROM communication_consent_events` | **permission denied** |
| `get_suppression_state(NULL)` — enumeration attempt | **0 rows** |
| `INSERT` / `UPDATE` / `DELETE` on the table | **permission denied**, all three |
| the **website's** `INSERT`-only role calling the function | **permission denied for function** |

The last row matters as much as the first: the two credentials are genuinely
separate. The website can write and not read; the sender can ask and not write.
Neither can do the other's job.

##### What it does *not* prevent, stated honestly

**It is not a confidentiality boundary against a determined holder of the
credential.** A caller who already has a list of phone numbers can test them one
at a time. What option D removes is the *bulk dump* — there is no query that
returns the set of suppressed numbers — and that is the realistic leak, not a
patient enumeration of the NANP.

The function's own source is readable from `pg_proc` by any role, as system
catalogues are. That is fine: the schema is not the secret, the data is.

##### Practical on Neon? Yes.

Neon runs standard PostgreSQL 18 and `SECURITY DEFINER` functions behave
normally. Three specifics for the implementation session:

- **The function must be created by the table owner** (`neondb_owner`, the same
  credential that applied `db/001`), so it executes with the owner's rights.
- **`SET search_path` is mandatory, not decorative.** Without it, a caller can
  shadow `communication_consent_events` with an object in a schema they control
  and the definer's rights will happily read it. This is the classic
  `SECURITY DEFINER` vulnerability.
- **`REVOKE EXECUTE … FROM PUBLIC` is mandatory.** PostgreSQL grants `EXECUTE`
  on new functions to `PUBLIC` by default, so creating the function without the
  revoke hands it to every role including the website's.
- Calling it needs no `SELECT` on anything: `SELECT get_suppression_state($1)`
  with no `FROM` clause requires only `EXECUTE`. It works over
  `@neondatabase/serverless`'s HTTP path like any other statement.

This needs **migration `002`** — the function, the grants, and the sender role.
`db/001` stays byte-identical to what was applied.

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

### 2.4 STOP keyword handling — Twilio classifies, we mirror

**Decision: Twilio is the enforcement point, and where Twilio tells us what it
classified, we use that rather than guessing at it ourselves.**

Twilio intercepts the standard opt-out keywords at its own layer. The default
English long-code list is, in full — **corrected in review, which found `REVOKE`
and `OPTOUT` missing here**:

> **STOP · UNSUBSCRIBE · END · QUIT · STOPALL · REVOKE · OPTOUT · CANCEL**

Twilio blocks the number on any of them. It blocks further messages to that number from that sender and sends the
confirmation itself. **This happens whether or not our webhook succeeds** — so a
keyword missing from *our* fallback list does not leave the consumer
unprotected; it leaves us with no evidence of an opt-out Twilio has already
enforced.

#### Prefer `OptOutType` when it is present

With **Advanced Opt-Out** enabled on a Messaging Service, Twilio includes an
`OptOutType` parameter on the inbound webhook with one of three values:

| `OptOutType` | Meaning | What we do |
|---|---|---|
| `STOP` | Twilio classified this as an opt-out and **has already blocked the number** | Append `suppressed`, `reason_code = stop_keyword`, set the HubSpot flags |
| `START` | Twilio classified this as an opt-in and **has already unblocked the number** | Append `reoptin_requested` — **not** a grant. See below. |
| `HELP` | Informational request; Twilio replied with the help text | **No ledger event.** Not a consent decision. Log only. |

**Where `OptOutType` is present it is authoritative and our own keyword matching
does not run.** Twilio's classification is a statement about what Twilio
actually did to the number; re-deriving it from the message body risks
disagreeing with the system that is doing the blocking, and disagreement here
means our record does not describe reality.

#### `OptOutType` will often be absent, and the design must not depend on it

Advanced Opt-Out is a **Messaging Service configuration setting**, and
**Twilio configuration must not be changed while the TCR/support hold on error
30753 is active** (§5). So the implementation must work correctly with the
parameter absent:

- **`OptOutType` present** → use it, as above.
- **`OptOutType` absent** → fall back to our own layer: exact keyword match
  first (case-insensitive, whitespace-trimmed, the keyword being the *entire*
  message body), then the deterministic phrase matching of §2.5.

Our layer is therefore a **supplement, not a competitor**. It exists for the
phrases Twilio does not classify, and for the period before Advanced Opt-Out is
enabled.

#### On `START`, and why it is still not a grant

`START` is the strongest opt-in signal a consumer can send — same number, same
channel, unprompted, and Twilio has already lifted its block. It is stronger
evidence than a ticked web form box. **It still does not restore a consent
grant**, for two reasons:

1. **It may not be the same person** (§2.3, reassignment). Twilio unblocking the
   handset does not tell us who is holding it.
2. **A `START` carries no disclosure.** A consent grant in this system records
   *what the person agreed to* — a version string and the full copy text. A
   bare `START` has neither, and fabricating one would put words in their mouth
   in the very record designed to prove we did not.

So `START` is recorded as `reoptin_requested` and surfaced to the operator, who
can obtain a fresh, evidenced consent. Twilio's block is lifted; ours is not
cleared. That asymmetry is deliberate and follows directly from §2.3.

#### Two consequences worth writing down

- **We cannot override Twilio.** Nothing we write makes a Twilio-blocked number
  deliverable again.
- **Our record can lag or fail without a message getting through.** That is a
  genuine safety margin, and not an excuse to treat the webhook as optional —
  the ledger is the evidence, and evidence that is missing is evidence we cannot
  produce later.

### 2.5 Natural-language opt-out

**Decision: yes — aggressive, deterministic phrase matching, biased toward
suppressing. No AI classifier. No naive substring matching.**

Twilio does **not** auto-handle "please stop texting me", "remove me from your
list", "no more messages". A system that ignores them is relying on the
consumer knowing the magic word, which is not a defensible position and is
increasingly not a lawful one.

The error costs are asymmetric again:

- **False positive** (suppressing someone who didn't mean it): one lost lead,
  visible to the operator, recoverable by an explicit human unsuppression.
- **False negative** (missing a real opt-out): continuing to message someone who
  asked us to stop.

So the bias is toward suppressing. Two things are ruled out explicitly:

**No AI classifier.** It adds a network dependency, a latency budget and a
failure mode to a path whose whole job is to be reliable, and its errors cannot
be explained after the fact. A phrase list can be read, reviewed, tested, and
cited in a compliance conversation. That matters more here than accuracy at the
margin.

**No naive substring matching.** `body.includes("stop")` classifies *"stop by
the open house on Sunday"* as an opt-out, and *"can you stop by Sunday?"* too.
That is not a conservative failure — it silently destroys a live lead and
records a legal state that the consumer never asked for.

#### The mechanism

Normalise, then match **intent-bearing patterns anchored to word boundaries** —
never a bare substring:

1. **Normalise**: lowercase, strip punctuation, collapse whitespace, trim.
2. **Exact keyword equality first** — the whole normalised body being `stop`,
   `unsubscribe`, `end`, `quit`, `stopall`, `revoke`, `optout`, `cancel`, and
   `opt out` as the spaced variant of OPTOUT that normalisation would otherwise
   split. **Corrected in review: `revoke` was missing.** This list matches
   `STOP_KEYWORDS` in `api/_lib/optout.mjs` exactly, and a test asserts every
   Twilio default keyword is present.
3. **Then phrase patterns**, each requiring the opt-out to be the *substance* of
   the message, not a word inside it. The distinguishing feature is that a verb
   of stopping is bound to an object of contacting:
   - `stop` / `quit` / `cease` **+** `texting` / `messaging` / `calling` /
     `contacting` / `emailing` — *"stop texting me"*, *"please stop messaging
     me"*
   - `remove` / `delete` / `take` **+** `me` **+** `from your list` / `off your
     list` — *"remove me from your list"*
   - `do not` / `don't` **+** `text` / `call` / `contact` / `message` **+** `me`
     — *"don't contact me again"*
   - `no more` **+** `texts` / `messages` / `calls`
   - `not interested` **+** an explicit stop clause, **not** on its own —
     *"not interested"* alone is a sales answer, not an opt-out
4. **Anything else is not an opt-out.** *"stop by Sunday"* fails every pattern:
   `stop` is followed by `by`, not by an object of contacting.

**Every inbound message that matches nothing should be surfaced to the
operator**, not silently discarded. A human reading *"who is this? never contact
me again"* catches what a phrase list misses, and that human review is the
safety net that lets the list stay deterministic instead of clever.

The list is **data, not logic** — a reviewable table with a test per entry,
including the near-miss cases (*"stop by Sunday"*, *"can you call me back?"*,
*"cancel my appointment"* — which is about an appointment, not about messaging).

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

**Decision: verify `X-Twilio-Signature` before the body is INTERPRETED. An
unverified request is rejected with 403 and never reaches the ledger.**

> **Correction (implementation review).** This originally read "before parsing
> anything", which is not achievable and not what the rule means. Twilio signs
> the **form parameters**, not the raw byte stream, so the body must be
> form-decoded *in order to* verify the signature at all. The real boundary is
> between **decoding** and **interpreting**: form-decoding is mechanical and
> assigns no meaning, and nothing that assigns meaning — classification,
> keyword matching, the ledger, HubSpot — may run before the signature
> verifies. The implementation reads the body, form-decodes it, verifies, and
> only then classifies; a static guard enforces that the classification call
> comes after the verification call.

Twilio signs with HMAC-SHA1 over the full request URL concatenated with the POST
parameters sorted by key, keyed by the account auth token.

Non-negotiables for the implementation session:

- **Verify before INTERPRET.** The body is attacker-controlled until the
  signature says otherwise. Form-decoding is required to verify at all and is
  not interpretation; classification is, and must come after.
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

> **Correction (implementation review).** This section originally asserted
> "Twilio retries on any non-2xx". **That is not true under default incoming-
> message webhook behaviour** — a 5xx does not by itself cause Twilio to
> redeliver. **Retry must be explicitly configured**, and doing so is a
> Messaging Service change: a **live-activation prerequisite**, frozen while the
> TCR hold on error 30753 is open.
>
> The response policy below is unchanged and still correct: a 5xx on a ledger
> failure is how the endpoint **refuses to claim a success it does not have**.
> What changes is the consequence. Until retry is configured, a ledger outage
> during a real STOP **loses the evidence permanently** — Twilio will still have
> blocked the number, so the consumer is protected, but our record of why will
> not exist. Idempotency below still holds; it makes a redelivery *safe*, it
> does not make one *happen*.

The dedupe key becomes:

```
twilio:<MessageSid>:<channel>:<event_type>
```

`MessageSid` is unique per inbound message, so a redelivery of the same message
produces the same key and the existing `ON CONFLICT DO NOTHING` makes it a
no-op — **the property measured on live Neon on 10 September 2026**, not an
assumption. That is idempotency *if* a redelivery arrives; it is not a claim
that one will.

Response policy, which is where the care is needed:

| Situation | Response | Why |
|---|---|---|
| Signature invalid | **403**, nothing written | Not from Twilio |
| Signature valid, ledger append **succeeds**, HubSpot write succeeds | **200** | Done |
| Signature valid, ledger append **fails** | **5xx** | The evidence is not durable, so the endpoint must not claim success. **Not a retry mechanism** — see the correction above. |
| Signature valid, ledger append succeeds, **HubSpot write fails** | **200**, log loudly, reconcile later | The suppression **is** durable. Enforcement resolves by number (§2.1), so it is already effective. A 5xx here would claim the whole request failed when the part that matters succeeded — and *where retry is configured*, it would drive repeated redelivery against a HubSpot outage, each one a ledger no-op. **Corrected in review: the original text said "retry forever", which assumed automatic retry.** |

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
| `evidence_text` | **the inbound message body, verbatim — only for opt-out-classified messages.** See below. |
| `metadata` | structural context — `MessageSid`, `AccountSid`, the matched rule |
| `hubspot_contact_id` | `NULL` at write time, as with website events |

**`revoked` and `suppressed` are different things** and the distinction is
already in the code: `revoked` is the consumer withdrawing in words;
`suppressed` is a STOP keyword or a carrier-level opt-out. Both deny sending.
Recording them identically would lose the reason a future reader needs.

#### `evidence_text` — opt-out messages only

**Decision: store the consumer's exact words only when the message is classified
as opt-out or DNC evidence. Ordinary inbound conversation is never written to
the consent ledger.**

The justification for storing it at all is narrow and specific: **the message
*is* the evidence of the opt-out.** Paraphrasing it, or storing only "matched
rule 4", would leave us unable to show what the person actually said if it is
ever questioned. That argument applies to an opt-out and to nothing else.

It does **not** extend to *"what time is the showing?"*. Writing every inbound
message into an append-only, effectively undeletable consent ledger would turn a
compliance record into a message archive — more PII, held longer, in a table
whose entire design premise is that the application cannot delete from it.

So:

- **Classified as opt-out / revocation / DNC** → a ledger event is written and
  `evidence_text` carries the verbatim body.
- **Anything else** → **no ledger event and no `evidence_text`.** The message is
  not consent evidence.
  > **Corrected in review.** The original text said such messages are "surfaced
  > to the operator through ordinary channels". **No such channel exists.** The
  > implementation logs `twilio.inbound.unclassified_not_surfaced` and nothing
  > more, and a log line is not an operator workflow. **Operator surfacing
  > remains UNBUILT and OPEN**, and is one of the reasons gate 7 is not
  > complete. Until it is built, a real opt-out our rules did not recognise
  > reaches nobody.

**Correlation evidence is preserved regardless of classification**:
`source_event_id` holds the `MessageSid`, `metadata` holds the structural
context (`MessageSid`, `AccountSid`, `OptOutType` when present, the matched
rule identifier). So a written event can always be tied back to the exact Twilio
message record, whether or not the body travelled with it.

> **Corrected in review.** The original text said `occurred_at` holds Twilio's
> timestamp. **It does not.** The ordinary incoming-SMS webhook carries no
> message timestamp — there is no `DateCreated` on that payload — so
> `occurred_at` is **server receipt time**, which is at or *after* the moment
> the consumer sent the message. Read it as an **upper bound**: the opt-out
> happened at or before that instant. **`MessageSid` is the correlation key** to
> Twilio's own record, which holds the authoritative timestamp.

Constraints for the implementation session: **length-cap it**, and **never let
it reach a log line**. It is the first consumer free text this system stores and
is a Tier 4 concern.

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
  webhook **reports failure rather than falsely claiming success**. That is the
  whole of what the 5xx achieves.
  > **Corrected in review.** The original text said "so Twilio retries".
  > **Redelivery is not automatic** — it happens only if retry is separately
  > configured, which is a live-activation prerequisite (§2.9). Without it, a
  > ledger outage during a real STOP loses the evidence permanently. Twilio
  > still blocks the number, so the consumer is protected; our record of why
  > does not exist.
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
- **Twilio Messaging Service configuration** — including *enabling* Advanced
  Opt-Out, custom keyword lists and per-Messaging-Service opt-out lists.
  **Frozen while the TCR/support hold is active** (§5). The design works with
  `OptOutType` absent, so this is not a dependency.
- **Retell's specific webhook shape** for a spoken opt-out — the semantics are
  settled here, the transport is not.
- **Rate limiting and abuse handling** on the inbound endpoint.
- **Where the sender runs.** This document assumes a sender exists that consults
  suppression; gate 8 builds it.

---

## 4. Operator decisions — settled 10 September 2026

All three open questions were decided by the operator and are now final. They
are recorded here as decisions, not proposals.

| # | Decision |
|---|---|
| 1 | **A separate suppression-lookup credential is approved — but not with `SELECT`.** Least privilege via `EXECUTE` on `get_suppression_state(phone_e164)`, a `SECURITY DEFINER` function, with **no table privileges at all** on the ledger. The credential can ask about a number it already knows and cannot enumerate the table. Verified by measurement (§2.1). |
| 2 | **Aggressive deterministic natural-language matching.** Bias toward suppression where the intent to stop is clear. **No AI classifier. No naive substring matching** — *"stop by Sunday"* must not be classified as an opt-out (§2.5). |
| 3 | **`evidence_text` holds the consumer's exact words only for opt-out-classified messages.** Ordinary inbound conversation is never written to the consent ledger. `MessageSid` and the other correlation evidence are preserved regardless (§2.10). |

Nothing in this document now awaits an operator decision. **What it awaits is
implementation**, which has not begun.

---

## 5. Status, and the Twilio freeze

**Gate 6 is externally blocked.** An existing Twilio A2P Brand is in a
support/TCR hold for **error 30753** while Twilio works the email whitelist.

**While that case is open:**

- **Do not create another Brand, profile or campaign.**
- **Do not change the registration.**
- **Do not change Messaging Service configuration** — including enabling
  Advanced Opt-Out. This is why §2.4 requires the design to work with
  `OptOutType` absent rather than assuming it.

Gate 7 can be designed and implemented independently of all of that, but **no
live SMS test is possible until gate 6 clears.**

**Nothing in this document is implemented.** No endpoint exists, nothing writes
a suppression, and nothing calls the permission resolver.
`COMMUNICATIONS_CONSENT_ENABLED` remains absent from Vercel Production.
