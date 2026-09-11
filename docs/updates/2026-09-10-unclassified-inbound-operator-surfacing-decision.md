# Operator surfacing for unclassified inbound SMS — decision

**10 September 2026. Documentation only. Nothing in this document is built.**

This settles the last open **design** decisions in gate 7 that are not frozen by
the Twilio/TCR hold on error 30753:

1. **what happens to an inbound SMS the opt-out classifier does not recognise**,
   and
2. **how the operator records a suppression when the message turns out to be an
   opt-out** — because visibility without a lever is not "able to act".

It decides the shape. It does not implement it, does not touch Twilio, Retell,
HubSpot, Neon or Vercel configuration, and adds no environment variable or
credential. Gate 8 is not begun.

> ## Revision 2 — 10 September 2026
>
> Revision 1 of this document was published in the PULSE HANDOFF on
> [#23](https://github.com/tomytomz1/crystal-sells-toledo/pull/23) and reviewed
> by the operator against `main`. Three defects were found, and this revision
> fixes them. The superseded positions are stated here rather than deleted:
>
> 1. **It did not satisfy its own requirement.** It surfaced the message and then
>    admitted, in its §6, that the operator had no safe way to act on it —
>    proposing "a documented owner-credential procedure" as the answer.
>    **Rejected: a realtor must never need a privileged database credential.**
>    §6 now specifies the operator action instead of deferring it.
> 2. **Its prerequisite model was wrong.** It implied `TWILIO_AUTH_TOKEN` was the
>    only thing gating the endpoint. **It is not:** `api/twilio-inbound.js`
>    answers 503 at `consentLedgerConfigured()` too, and `CONSENT_LEDGER_URL` is
>    **absent from Production**. §7 is new and states both.
> 3. **It leaked more PII than it needed to.** It put the full E.164 number in
>    the email subject — and therefore on a lock screen. §4.2 now uses the last
>    four digits.
>
> ## Revision 3 — 10 September 2026
>
> Revision 2 was reviewed against `main` and two **architectural
> inconsistencies** were found. Both are fixed, and the superseded positions are
> again stated rather than deleted:
>
> 4. **It recorded the wrong act, and destroyed the evidence of it.** Revision 2
>    wrote an operator-classified opt-out as `event_type = suppressed` with
>    `evidence_text = NULL`. Both halves contradict `main`. `api/_lib/optout.mjs`
>    deliberately emits **`revoked`** for a natural-language withdrawal precisely
>    because *"recording the two identically would lose the reason a future
>    reader needs"*, and `api/_lib/consent-ledger.mjs` stores the consumer's
>    words for an opt-out because **"the message IS the evidence of the
>    opt-out."** *"Quit hassling me"* does not become a different kind of
>    consumer act because a human, rather than a regular expression, recognised
>    it. §6.4 now writes **`revoked` with the consumer's exact words**, and §6.2
>    carries those words **inside the sealed token** so the URL still holds
>    ciphertext only.
> 5. **It left HubSpot inconsistent.** Revision 2 wrote the ledger and stopped,
>    so a manual suppression would never reach the `cst_*` current-state
>    properties that the automatic path already projects into. **§6.9 is new**:
>    the same ledger-first, best-effort-projection model as the webhook, with
>    `SUPPRESSION_TRIGGER.MANUAL`.
>
> A third finding was **process, not design**: the pull-request description still
> described revision 1. It has been rewritten to describe the current design; the
> correction comments in the thread are left intact.

---

## 1. The problem, stated exactly

`POST /api/twilio-inbound` classifies every inbound message. Three outcomes exist
today:

| Classification | What happens |
|---|---|
| keyword or phrase opt-out / revocation / DNC | a `suppressed` or `revoked` ledger event, then a best-effort HubSpot projection, then **200** |
| `HELP` / `INFO` | **200**, nothing recorded — Twilio answers HELP itself |
| **anything else** | **200**, no ledger event, **one log line and nothing more** |

That third row is the gap. `api/twilio-inbound.js` names it out loud —
`log("twilio.inbound.unclassified_not_surfaced", shape)` — and the comment above
it says a log line is not an operator workflow. Nobody reads Vercel function logs
hunting for a missed opt-out.

Two distinct things are lost there, and they are worth separating:

1. **A real opt-out the rules did not recognise.** The classifier is deliberately
   deterministic: Twilio's keyword list, plus ten intent patterns, plus nothing.
   *"quit hassling me"*, *"who is this? never contact me again"* and *"lose my
   number"* are opt-outs that this list does not match. **Twilio does not block
   them either** — Twilio only enforces its own keyword list — so an unrecognised
   natural-language opt-out is enforced by nobody and recorded by nobody.
2. **An ordinary consumer reply to a real estate agent.** *"what time is the
   showing?"* is a lead talking. Dropping it on the floor is a business failure
   rather than a compliance one, but it is still a failure.

One mechanism has to answer both, because at the moment the message arrives the
system cannot tell which it is. **That is the whole point of surfacing: a human
is the classifier of last resort.**

And it is only half the job. **A human who can see but cannot record has not been
given a workflow** — §6.

---

## 2. Constraints the answer has to satisfy

Six, taken from the operator's brief and from what the repository already commits
to:

1. **Crystal must actually see it and be able to act on it.** Not "it is
   retrievable"; seen, in a place she already looks — **and actionable without a
   privileged credential.**
2. **The append-only consent ledger must not become a message archive.** Writing
   every inbound message into `communication_consent_events` puts arbitrary
   consumer free text into a table the application **cannot delete from** — the
   `consent_ledger_app` role holds `INSERT` and nothing else, deliberately. That
   is the one thing `api/twilio-inbound.js` was explicitly built not to do.
3. **Minimise unnecessary PII duplication.** Every new copy of a consumer's
   number and words is a new place it has to be protected and, one day, deleted.
4. **Preserve enough context to respond.** The number, the words, and when.
5. **No path where an unrecognised opt-out silently disappears.** A failure to
   surface must be loud.
6. **Right-sized for one realtor.** Not an enterprise inbox product.

And three the repository imposes:

7. **The consumer's message must never reach a log line.** `tools/check.mjs`
   fails the build if `params.Body` is passed to `log()`. Any surfacing path has
   to carry the body outside the log stream.
8. **Consumer phone numbers must not reach a log line either.**
   `api/_lib/log.mjs` redacts `phone` to `present:<length>`. **A URL is a log
   line**: Vercel records request paths, and a browser records history. This
   decides the token format in §6.
9. **Nothing may depend on `COMMUNICATIONS_CONSENT_ENABLED`.** That flag governs
   `cst_*` reads and writes. Operator visibility is not a consent write and must
   not inherit a flag that is off in Production.

---

## 3. Options evaluated — surfacing

### A. HubSpot timeline activity

**Rejected — it cannot be built with the mechanism this project has.**

The "timeline activity" this site produces is not a generic timeline event. It is
an authenticated **Forms Submission API** call, and that API identifies the
contact by **email address**: `toFormSubmission()` in `api/_lib/hubspot.mjs`
starts its field list with `field("email", lead.email)` and every other field is
optional.

**An inbound SMS has no email address.** It has `From`, `Body` and `MessageSid`.
Producing a form submission for it would mean inventing an email address for a
person who may have just asked to be left alone — fabricating a CRM identity.
That is not a trade-off; it is disqualifying.

HubSpot's genuine timeline-events API is a different product surface (a
developer-account application with its own event templates), not something the
current Service Key reaches.

### B. HubSpot task

**Rejected — new CRM scope, an association that often does not exist, and the
wrong surface for this operator.**

Three independent problems:

- **Scope.** The Service Key holds `crm.objects.contacts.read`,
  `crm.objects.contacts.write` and `forms`. A task needs
  `crm.objects.tasks.write`. Widening a live CRM credential to close a
  notification gap is a poor trade, and it is a change to a production
  integration that this session is forbidden to make and a future session should
  not want to make.
- **Association.** A task is worth having because it hangs off a contact.
  `findContactsByPhone()` returns **zero** contacts for a number that has never
  filled in the form — which is precisely the case where an unrecognised opt-out
  is most dangerous, because there is no `cst_*` state to protect the person
  either. Closing that would mean **creating a HubSpot contact from an inbound
  SMS**: manufacturing a CRM record, complete with phone number, for someone
  whose message might have been *"never contact me again"*. Rejected on its own.
- **Where Crystal is.** A task is visible to someone who works inside the HubSpot
  UI daily. This CRM is a record store for one agent's leads, not her working
  surface. A task queue nobody opens is the log-line problem with a nicer font.

Worth stating plainly, because it is the strongest thing the alternative has
going for it: **if Crystal did live in HubSpot all day, a task would be the right
answer.** She does not.

### C. Email notification to the operator — **CHOSEN**

Specified in §4.

### D. Internal SMS notification to Crystal's own mobile

**Rejected, and separately blocked.**

- **Blocked.** It requires sending an outbound message, which requires the
  Messaging Service and the A2P registration that are frozen under the TCR hold
  for error 30753. The one item of gate 7 that is *not* frozen would be built on
  the one thing that is. This was already recorded as "explicitly not built" in
  `docs/updates/2026-09-10-stop-dnc-suppression.md`, and nothing has changed.
- **Rejected on the merits anyway.** It turns one inbound message into an
  outbound one — an amplification path on a webhook an unknown party can trigger
  by texting. It relays a consumer's words across a second carrier. It costs per
  message. And an SMS is a poor carrier of a 1 KB message plus its metadata, and
  a worse carrier of the operator action in §6.

### E. A lightweight operator queue of our own

*(a table plus a small authenticated page, or any equivalent inbox we build)*

**Rejected — it is the archive we refused to build, wearing a different hat.**

Any queue worth reading is durable, which means a **new store of consumer message
text**, with its own retention policy, its own deletion path, its own access
control, its own authentication, and its own way of going stale. It re-creates
exactly the message-archive problem `api/twilio-inbound.js` exists to avoid, and
it does so in the same Neon project as the compliance ledger, where the whole
value of the schema is that it holds consent decisions and nothing else.

For one realtor, at the volume one realtor's number receives, building an inbox
when she already has an inbox fails constraint 6 outright.

---

## 4. The decision — surfacing

> **An unclassified inbound message is emailed to the operator, immediately, one
> message per email, over the SMTP transport this project already uses for the
> lead acknowledgement — and the endpoint answers 503 if that email cannot be
> handed to the mail server.**

No ledger row. No HubSpot call. No new store.

### 4.1 Where it attaches

The `if (!decision)` branch of `handler()` in `api/twilio-inbound.js` — after
signature verification, after the `MessageSid` / `From` completeness check, and
before the response is written.

**Only that branch.** Not `help` (Twilio answers HELP itself, and a HELP request
is not an opt-out). Not classified suppressions — those are already durable in
the ledger and already projected into HubSpot.

### 4.2 What the email carries

**Subject: a stable prefix and the last four digits only.**

```
Crystal Sells Toledo: inbound message ending 2789
```

**The full number does not belong in a subject line.** A subject is rendered on a
lock screen, in a notification banner, in a shared-screen inbox list and in every
mail server's logs along the way; the last four digits are enough to tell two
conversations apart at a glance, and everything more is PII spent for nothing.
The stable prefix is what makes the mail filterable and sortable.

**The first line of the body is fixed text, not the message.** Mail clients show
the opening of the body as the preview line, so a message that began with the
consumer's words would put them on the lock screen too. The body opens with a
fixed sentence saying what this is; the consumer's words come after it.

Inside the body, where it is needed to act:

| Field | Why it is there |
|---|---|
| The sending number in **E.164**, plus `tel:` / `sms:` links | The only way to act on the message is to contact the person from her own phone |
| The message body, **verbatim**, capped at 1 KB on a byte boundary | The words are the thing a human is being asked to judge; the same cap and truncation rule as `evidence_text` (`capEvidence()`, 16-byte headroom, `…[truncated]`) |
| `MessageSid` | The correlation key back to Twilio's own record, which holds the authoritative timestamp and the message itself |
| Server receipt time, UTC | The endpoint has no message timestamp — the incoming-SMS webhook carries none — so this is an **upper bound**, exactly as `occurred_at` is on a suppression row |
| **The operator action link** (§6) | What turns "she saw it" into "she can act on it" |
| A fixed instruction block | What to do if this *is* an opt-out; and that **replying to the email reaches nobody** |

Plain text and HTML, the HTML escaped with the existing `escapeHtml()`.

**Recipient: the operator's own mailbox, as a constant, not an environment
variable.** `api/_lib/mail.mjs` already pins `FROM_ADDRESS` for exactly this kind
of reason. One realtor, one inbox; adding a variable later is a two-line change
if she ever wants notifications elsewhere.

### 4.3 A deterministic `Message-ID` — best-effort duplicate control

The notification carries a `Message-ID` derived from Twilio's own identifier:

```
<inbound-{MessageSid}@crystalsellstoledo.com>
```

So a webhook redelivery produces a second email bearing **the same**
`Message-ID`, and many mail servers and clients — Zoho's included, in the general
case — collapse or drop a duplicate they have already accepted.

**Three things must be said plainly about that:**

1. **It is best-effort and nothing more.** No standard requires a receiver to
   deduplicate; RFC 5322 in fact requires `Message-ID` to be *unique*, so this is
   a deliberate, benign misuse of the field. Some servers will deliver both.
2. **It does not replace webhook idempotency**, and it is not the mechanism that
   makes anything safe. The suppression path's idempotency is the ledger's
   `dedupe_key` and its `ON CONFLICT DO NOTHING`, measured against live Neon on
   10 September 2026. The notification path has **no datastore and deliberately
   will not get one** — a notification dedupe store is a message store.
3. **The failure it mitigates is benign in the first place.** A duplicate
   notification is the same message twice. A *missing* one is an opt-out nobody
   saw. Nothing here may be traded for the second to avoid the first.

### 4.4 Response policy — the failure behaviour

This is the part that satisfies constraint 5, and it is the reason the option is
worth more than "send an email".

| Situation | Response | Log event |
|---|---|---|
| Email accepted by the SMTP server | **200** + empty TwiML | `twilio.inbound.unclassified_notified` (`message_sid`, `ms`) |
| SMTP send failed or timed out | **503** | `twilio.inbound.unclassified_notify_failed` (`message_sid`, classified mail error) |
| Mail is not configured (`isMailConfigured()` false) | **503** | `twilio.inbound.unclassified_not_surfaced` — the existing event, now meaning *surfacing was impossible*, not *surfacing was not attempted* |

**Never a silent 200.** Today's 200-with-a-log-line is the defect; it must not
survive as a fallback.

Three honest notes on what that 503 does and does not buy:

- **A 503 does not by itself make Twilio redeliver.** Retry has to be configured
  on the Messaging Service, and it is already a live-activation prerequisite for
  the ledger path (item 4 of "what a human must still do"). **This decision adds
  no new prerequisite** — it rides on the one that already exists, which is a
  point in its favour over any design that would need its own retry mechanism.
- **A redelivery may produce a duplicate email**, mitigated only as far as §4.3
  says and no further.
- **Twilio's Debugger records a failed webhook** (error 11200) and can be
  configured to email the account owner. That is a second, no-build alert on the
  same failure. **Confirm that alerting is switched on at activation** — it is
  claimed here from Twilio's documented behaviour, not observed.

### 4.5 What it does *not* depend on

Worth listing, because it is most of the argument:

- **Not on Neon.** An unclassified message writes no ledger row, so a ledger
  outage cannot suppress operator visibility. The two failure domains are
  disjoint. (The **operator action** in §6 does depend on Neon — it is a ledger
  write — but by then a human is already reading the message.)
- **Not on HubSpot.** No contact search, no property write, no form submission,
  no new scope.
- **Not on `COMMUNICATIONS_CONSENT_ENABLED`.** Operator visibility is not a
  consent write; the flag stays off in Production and this is unaffected.
- **Not on any Twilio configuration beyond what already gates the endpoint.**
  Which is why this is buildable *now*, under the TCR hold.

### 4.6 Latency, and the one engineering risk

Twilio's webhook request times out at roughly **15 seconds**. The existing SMTP
transport is bounded at 5 s connection, 5 s greeting, 8 s socket — bounded, but
not comfortably inside 15 s if every bound is hit.

**The implementation must impose one overall deadline on the notification** and
treat exceeding it as the failure case in §4.4, rather than relying on the three
independent timeouts to add up to something acceptable. Measure the real timing
at gate 9, against a real Twilio request. **This is unmeasured today** — no
Twilio request has ever reached this endpoint.

---

## 5. Why this beats the alternatives

Against **A (timeline activity)** and **B (task)**: those two require, between
them, an email address the message does not have, a CRM scope the Service Key
does not hold, and a contact record that frequently does not exist. Email
requires nothing that is not already deployed and proven — `ZOHO_SMTP_*` has been
live in Production since 8 September and delivers the lead acknowledgement today.

Against **D (internal SMS)**: it is frozen by the exact hold that makes this the
only unblocked gate 7 item.

Against **E (an operator queue)**: it adds a durable store of consumer text; email
adds none. **The email is a copy in a mailbox the operator controls and can
delete.** Compare what each option leaves behind:

| Where the message text would live | Deletable by the operator? |
|---|---|
| Twilio's Message log (**already, regardless of this decision**) | Yes, in Twilio, subject to Twilio's retention |
| **Email — chosen** | Yes, it is her own mailbox |
| Consent ledger | **No.** The application holds `INSERT` and nothing else, by design |
| HubSpot note or task | Yes, but it is a third copy, in the CRM, searchable and exportable |
| A queue we build | Only if we build deletion, and then keep it working |

That table is also the answer to constraint 3. **The message already exists in
Twilio's own log before any of this runs** — the email is a second copy, and every
rejected option would have been a third, in a system with worse deletion
properties.

**The operator action in §6 does write the consumer's words into the ledger — but
only when a human has classified the message as an opt-out.** That is not a
widening of constraint 2; it is the rule `api/_lib/consent-ledger.mjs` already
states: *"the message IS the evidence of the opt-out, which is why it is
stored"*, and *"ordinary inbound conversation produces no row at all."* The
classifier being a human rather than a regular expression does not change which
of those two a message is. **An ordinary message that Crystal reads and closes
writes nothing, ever** — no row, no words, no record that it was reviewed.

Revision 2 got this backwards. It set `evidence_text = NULL` and pointed at
Twilio's log and the operator's mailbox instead — which makes the durable
compliance record **depend on two retention policies this project does not
control**: Twilio's message retention and whether Crystal keeps an email. The
ledger exists precisely because evidence must not depend on a platform that can
delete it, so an opt-out whose only evidence lives in Twilio and a mailbox is the
failure this system was built to prevent.

And on constraint 1: notification volume for one agent's number is low enough
that per-message email is legible. **No digest, no batching** — a digest delays an
opt-out by design, which is the wrong direction on the one message type that
matters most.

---

## 6. The operator action — recording a suppression without a database credential

Crystal reads *"quit hassling me"*. **What can she actually do?**

Today: nothing systematic. `api/twilio-inbound.js` writes suppressions only from
a message it classified itself; `unsuppressed` exists as an event type and
nothing writes it; no console, script or workflow lets a human enter either one.

**Revision 1 of this document proposed a documented owner-credential procedure.
That is rejected.** The Neon owner credential can read every consent decision in
the ledger, alter the schema and drop the table. Handing it to a realtor as part
of a routine workflow inverts the entire access model — the reason
`consent_ledger_app` holds `INSERT` and nothing else is that **no routine action
should ever need more.** A workflow that needs the owner credential is a workflow
designed wrongly.

### 6.1 Shape

**One new endpoint, `api/operator-action.js`, two methods, one URL.**

| Method | What it does |
|---|---|
| **GET** `/api/operator-action?t=<sealed token>` | Renders a **confirmation page**. **Reads no database state and writes nothing** — it decrypts its own input, the sealed token, and that is all it reads; no request state changes. Safe for a link scanner, a prefetch, a forwarded email or a curious click. |
| **POST** `/api/operator-action` | **The only writer.** Requires the token in the form body, an explicitly chosen scope, and a confirmation field. Appends one `revoked` ledger event and renders the result. |

**GET can never write, and that is not a stylistic preference.** Outlook Safe
Links, mail-gateway antivirus, Gmail's prefetch and iOS link previews all issue
unattended GETs against links in email, sometimes within seconds of delivery. A
design where the link *is* the action would suppress numbers by itself, from a
scanner, with no human involved — and a suppression cannot be undone.

### 6.2 The token is sealed, not signed plaintext

The link carries **one opaque parameter**: AES-256-GCM ciphertext, base64url,
keyed by a single new secret, using Node's built-in `crypto` — no new dependency.

**Why sealed rather than a signed plaintext payload:** a signed-plaintext token
would put the consumer's phone number in a URL, and **a URL is a log line** —
Vercel records request paths, the browser records history, and an outbound
request can carry a referrer. `api/_lib/log.mjs` redacts `phone` for exactly this
reason and `tools/check.mjs` fails the build if the message body reaches `log()`.
Sealing means the path carries ciphertext and the plaintext exists only inside
the function.

Payload:

| Field | Value |
|---|---|
| `v` | payload version |
| `sid` | Twilio `MessageSid` — correlation key **and** idempotency key |
| `p` | the consumer's number in E.164 |
| `b` | **the consumer's message, already capped** by the existing evidence rule |
| `iat` / `exp` | issued at; **expires after 30 days** |

**The message travels inside the seal, and that is the whole point of sealing
it.** The endpoint has no datastore and must not acquire one, so when the
operator classifies the message as an opt-out the exact words have to reach
`buildSuppressionEvent()` from somewhere. Carrying them in the sealed payload
keeps the promise that made the token sealed in the first place: **the URL
contains ciphertext and nothing else.** The plaintext exists in the function's
memory for the duration of one request.

`b` is capped **before** it is sealed, by the same `capEvidence()` rule that
governs `evidence_text` — 1 KB, byte-safe truncation, `…[truncated]` — so the
token cannot carry more than the ledger would accept, and the words written are
byte-identical to the words the operator read.

**Size, checked rather than assumed at implementation.** 1 KB of plaintext plus a
12-byte nonce, a 16-byte tag and a small JSON envelope encodes to roughly 1.5 KB
of base64url, so the whole URL lands near 1.6 KB. Node's default request-header
budget is 16 KB and the request line counts against it, so the margin is about
tenfold. **Budget the whole URL at 4 KB**, measure the worst case with a
full-length message during implementation, and deflate before sealing if it ever
approaches that. A message longer than the cap cannot enlarge the token, because
the cap is applied first.

**Rejected: fetching the message back from Twilio at POST time.** It would add a
network dependency, a second credential, and a hard dependence on Twilio's
retention window to a write whose entire purpose is to be independent of exactly
that. Rejected: a datastore to hold the message between the notification and the
click — that is the message archive this endpoint exists to avoid.

**The `MessageSid` cannot contain a colon**, so it is a safe dedupe-key component
(`dedupeKey()` refuses one).

### 6.3 Three things a link scanner cannot supply

All three are required on the POST, and any missing one is a 400 that writes
nothing:

1. **The token**, moved out of the query string and into the form body by the
   confirmation page.
2. **An explicitly chosen scope** — `sms`, `ai_voice` or `all` — presented as an
   unselected choice **with no default**. This is not merely anti-automation: it
   is the judgement only the human reading the message can make. *"stop texting
   me"* and *"stop contacting me"* are different suppressions, and the classifier
   already treats them differently.
3. **A confirmation field** the page emits, checked as an exact literal.

The page also sets `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
`X-Robots-Tag: noindex`, and loads **no third-party resource**, so the token
cannot escape by referrer or sit in a shared cache. (The site-wide
`Referrer-Policy` in `vercel.json` is `strict-origin-when-cross-origin`; this page
needs the stricter one.)

### 6.4 What it writes

One row, through the **existing** `buildSuppressionEvent()` and
`appendSuppressionEvents()`, on the **`INSERT`-only** `CONSENT_LEDGER_URL`
credential. No new module may name the table, its columns or that variable —
`tools/check.mjs` enforces that containment, and this endpoint must respect it.

| Column | Value |
|---|---|
| `event_type` | **`revoked`** — the only value this endpoint can emit |
| `channel` | from the chosen scope |
| `phone_e164` | from the sealed payload |
| `source` | **`operator`** — a new constant beside `SOURCE_TWILIO`. `buildSuppressionEvent()` already accepts any source except `website`, so this needs a constant, not a rule change |
| `source_event_id` | the `MessageSid` |
| `reason_code` | **`SUPPRESSION_REASON.MANUAL`** — already defined in `api/_lib/consent.mjs` |
| `evidence_text` | **the consumer's exact words**, from the sealed payload, capped by `capEvidence()` |
| `metadata` | `{ MessageSid, classified_by: "operator", entered_via: "email_action", token_v }`, plus an optional short operator note |

**`revoked`, not `suppressed` — because that is what actually happened.**
`api/_lib/optout.mjs` already draws this line for the automatic path: a whole-word
keyword or a carrier action produces `suppressed`; a consumer withdrawing **in
words** produces `revoked`, with the comment *"recording the two identically would
lose the reason a future reader needs."* A message the deterministic classifier
missed and a human recognised is a consumer withdrawing in words. It reached this
endpoint **because** it was not a keyword. Writing it as `suppressed` would file a
natural-language withdrawal under the one label that means "keyword or carrier",
and it would do so for exactly the messages whose wording is most worth
preserving.

**`reason_code` still says who classified it.** `MANUAL` is what distinguishes an
operator entry from the classifier's `natural_language` — so the pair
(`revoked`, `manual`) reads correctly: *withdrawn in words, recognised by a
human.* The act and the recogniser are recorded in separate columns, which is why
neither has to be distorted to carry the other.

**Send-time enforcement is unaffected — verified, not assumed.**
`get_suppression_state()` in `db/002_suppression_lookup.sql` filters
`e.event_type IN ('suppressed', 'revoked')`, and its own comment says *"`revoked`
counts alongside `suppressed`"*. So an operator entry suppresses at send time
exactly as a keyword STOP does. **`db/002` needs no change**, and neither does
`db/001`.

**`evidence_text` carries the consumer's words, and nothing else.** The operator's
own note, if she types one, goes in `metadata` — never in `evidence_text`. That
column means *what the consumer said*, and mixing an operator's prose into it
would corrupt the one field whose value depends on being verbatim.

### 6.5 Idempotency comes free

The dedupe key is `operator:<MessageSid>:<channel>:revoked`, and
`appendSuppressionEvents()` inserts with `ON CONFLICT DO NOTHING` — measured
against live Neon on 10 September 2026, including a partial-pair heal.

A double click, a double submit, a second click from a forwarded copy of the
email, or a browser retry all converge: `INSERT 0 0`, no second row, and the page
says **"already recorded"** rather than "done". Same reading either way. **No new
datastore is needed to make this safe**, which is the point.

### 6.6 It cannot clear a suppression — enforced twice

- **The endpoint emits only `revoked`.** Neither `unsuppressed` nor any other
  event type is reachable from it at all.
- **The credential holds `INSERT` and nothing else** — no `UPDATE`, no `DELETE`,
  not even `SELECT`. Even a fully compromised endpoint cannot unsuppress, cannot
  read the ledger, and cannot enumerate the numbers in it.

### 6.7 Threat model, stated plainly

Authentication is the sealed token and nothing else: no account, no session, no
password, for one operator who receives the link in her own mailbox.

- **Worst case of a stolen or replayed token: one number gets suppressed** — the
  fail-safe direction. It cannot send a message, reach the CRM, read a lead, or
  read the ledger.
- **But a suppression cannot be undone**, so a malicious or mistaken suppression
  is permanent under today's design. That is a real cost, not a hypothetical, and
  it is why the token is scoped to **one `MessageSid`**, expires, and is never a
  general "suppress any number" endpoint.
- **A stolen token also discloses the message it seals**, because the
  confirmation page shows the consumer's words — which it must, so the operator
  can see what she is acting on. That is **the same disclosure as the email the
  token arrived in**: the seal exists to keep plaintext out of URLs and logs, not
  to be a second confidentiality boundary against someone already holding the
  link.
- **The unsuppression counterpart remains unbuilt and out of scope**, and it
  should be settled before gate 9 — otherwise the only correction for a mistake
  is a database owner, which is the thing this design exists to avoid.
- **A 30-day expiry is a trade-off**, not a safety property: long enough that a
  message read late is still actionable, short enough that an old forwarded email
  is not a live capability. An expired token renders a page that says so and
  writes nothing.

### 6.8 Configuration

Gated exactly like the webhook. **One new secret name — `OPERATOR_ACTION_SECRET`,
Production — and it is NOT added by this document.** With it absent the endpoint
answers 503 and renders no page, so the endpoint is inert until it is set.

It must be added to `SECRET_NAMES` in `tools/check.mjs`, so the build fails if it
ever appears in anything delivered to a browser.

### 6.9 The HubSpot projection — the same model as the webhook

**The ledger write is authoritative. HubSpot is the operational projection, and
nothing more.** That is the architecture this project already committed to —
`cst_*` properties are *mutable current permission state*, the ledger is *durable
historical evidence and the enforcement source* — and the manual path must follow
it rather than invent a second model.

Revision 2 wrote the ledger and stopped, which would have left a manually
recorded opt-out invisible in the CRM while an automatic one was visible. Same
consumer act, two different outcomes depending on which classifier caught it.

**After — and only after — the ledger append succeeds**, the POST does exactly
what `projectToHubSpot()` in `api/twilio-inbound.js` already does:

1. **If `consentStateEnabled()` is false, skip it**, and log the skip with
   `reason: "consent_state_disabled"` — the same early return the webhook makes.
   With the flag off in Production, no `cst_*` property is read or written, which
   is what makes "off" mean production-equivalent.
2. **If HubSpot is not configured, skip it** and log that instead.
3. Otherwise **`findContactsByPhone()`**, then for each contact
   **`toHubSpotSuppressionProperties({ scope, trigger: SUPPRESSION_TRIGGER.MANUAL, at, current: contact.consent })`**
   and `writeSuppressionProperties()`.
4. **One contact failing does not stop the rest**, and the whole projection is
   wrapped so that no HubSpot error escapes.

**`SUPPRESSION_TRIGGER.MANUAL` already exists** in
`api/_lib/hubspot-consent-state.mjs`, and all three reason maps —
`SMS_REASON_BY_TRIGGER`, `VOICE_REASON_BY_TRIGGER`, `GLOBAL_REASON_BY_TRIGGER` —
already carry a `manual` value. So this needs **no new HubSpot property, no new
dropdown option and no new scope**: `crm.objects.contacts.read` and
`crm.objects.contacts.write`, both already held, are enough.

**A HubSpot failure must never weaken the ledger suppression**, and cannot:

- The append has already committed before the projection runs. There is nothing
  to roll back, and nothing that would want to.
- Enforcement resolves suppression **by phone number against the ledger**
  (`get_suppression_state()`), never against HubSpot. So a failed projection costs
  **visibility, not compliance** — the same sentence the webhook's header comment
  already uses, and the same reason it may answer 200 when HubSpot fails.

> **CORRECTED 11 September 2026.** The sentence above is left as written, because a stale claim that survived a merge is worth seeing. It is **false in the current system** and must not be carried forward. A successful ledger append means the suppression or revocation is **durably recorded** — that, and not more. It is not "already effective" or "already enforced": **gate 8 has not begun**, nothing in `api/` calls `get_suppression_state()`, and the `EXECUTE`-only sender credential is in no environment. The HubSpot `cst_*` flags are **best-effort operational state**, not the evidence — and, until gate 8, they are the only suppression signal any code here reads at all. **No automated outbound sender is active today**, so this is not a live messaging exposure; it is why **gate 8 must be in place before outbound automated communications are activated**. See [#26](https://github.com/tomytomz1/crystal-sells-toledo/pull/26) and `docs/updates/2026-09-11-twilio-inbound-projection-bounds.md`.
>
> Note what this bullet records about itself: it adopted the claim *because the webhook's header comment already used it*. That is the propagation path, written down at the moment it happened — the claim was inherited, never verified, and copying a sentence forward is not verification.

- The POST therefore reports **success once the ledger append is confirmed**, and
  says on the result page whether the CRM projection also succeeded. A partial
  outcome is shown, not hidden — but it is not a failure.

**What is deliberately not projected:** nothing at all when the operator decides
the message is *not* an opt-out. There is no "reviewed, no action" state in either
system. She closes the tab, and the ledger and the CRM stay untouched — which is
the same outcome the classifier already produces for an ordinary message.

### 6.10 Alternatives rejected for this workflow

- **A Neon owner-credential SQL procedure** *(revision 1's answer)* — hands a
  realtor a credential that can read every consent decision and drop the table,
  for a routine action. Rejected by the operator, and rightly.
- **A one-click link that writes on GET** — scanners, §6.1.
- **A password-protected admin page** — an account system, a session store and a
  password to rotate, for one person who already receives the link.
- **A reply-by-email command** (*"reply STOP to this email to record it"*) —
  needs inbound email parsing, a mailbox to poll, and a `From` header anyone can
  forge. More moving parts and weaker authentication than the sealed token.
- **Letting the operator send a STOP on the consumer's behalf by SMS** — frozen
  by the TCR hold, and it fakes a consumer action, which is worse than recording
  an operator one honestly.

---

## 7. Activation prerequisites — corrected

**`TWILIO_AUTH_TOKEN` alone is not sufficient to activate the inbound webhook.**
Revision 1 implied it was. Verified against `main`:

- `api/twilio-inbound.js` answers **503** at `twilioConfigured()` when
  `TWILIO_AUTH_TOKEN` is absent, before the body is read.
- It answers **503 again**, for a *classified* message, at
  `consentLedgerConfigured()` — and that function is exactly
  `Boolean(String(env["CONSENT_LEDGER_URL"] || "").trim())`.
- `docs/CURRENT-STATE.md` records `CONSENT_LEDGER_URL` as set in Vercel
  **Preview** and **absent from Production**.

So with only the token added, a real STOP in Production would be **authenticated,
classified, and then refused with a 503 having written nothing** — the evidence
loss the fail-closed design exists to make loud, occurring on *every* message
rather than during an outage. And because webhook retry is unconfigured, that 503
would not be redelivered. Twilio would still block the number for a keyword STOP;
our record of why would not exist.

| Variable | Scope needed | Role | Gate |
|---|---|---|---|
| `TWILIO_AUTH_TOKEN` | **Production** | verifies the inbound signature | 7 |
| `CONSENT_LEDGER_URL` — the **`INSERT`-only** `consent_ledger_app` credential | **Production**; currently **Preview only** | the suppression writer's append | 7 |
| `ZOHO_SMTP_*` | Production — documented as already set there for the acknowledgement; **confirm in the dashboard** | the notification transport | 7, once §4 is built |
| `OPERATOR_ACTION_SECRET` | **Production** | seals the operator action token | 7, once §6 is built |
| the `consent_ledger_sender` connection string — `EXECUTE`-only, **not** `CONSENT_LEDGER_URL` | **no environment, deliberately** | send-time `get_suppression_state()` | **8** |

**Keep the two database credentials apart.** `CONSENT_LEDGER_URL` is
`consent_ledger_app`: `LOGIN` + `INSERT`, and **no `SELECT`**. The sender is
`consent_ledger_sender`: `EXECUTE` on `get_suppression_state()` and **no table
privilege of any kind**. Both separations were proven by attempt on 10 September
2026 — `consent_ledger_app` was refused `EXECUTE`, and the sender was refused
`SELECT`, `INSERT`, `UPDATE` and `DELETE`. **Giving Production the first does not
give it the second, and gate 7 needs only the first.** Gate 8's credential stays
in no environment until gate 8 begins.

**One more thing follows from `COMMUNICATIONS_CONSENT_ENABLED` being absent from
Production:** `projectToHubSpot()` returns early with
`reason: "consent_state_disabled"`. So a gate 7 activation with the consent flag
off records suppressions **durably in the ledger** and projects **nothing** into
HubSpot. That is the documented order of priorities — the ledger is compliance,
the projection is visibility — but it should be a decision rather than a surprise.

**No environment variable is added, changed or removed by this document.**

---

## 8. What this decision explicitly does not do

- **It does not implement anything.** No code, no test, no configuration.
- **It does not surface classified messages.** Suppressions are durable and
  projected; adding a notification for them is a separate, easy question and is
  not answered here.
- **It does not surface `HELP`.**
- **It does not build unsuppression**, and §6.7 says why that matters.
- **It does not add rate limiting or a notification cap.** At one realtor's volume
  it is not justified. If inbound volume ever makes it justified, that is a
  measurement, not a guess.
- **It does not create a reply path.** Crystal responds from her own phone, using
  the number in the email. Replying to the email reaches nobody, and the email
  has to say so.
- **It does not change what reaches the ledger from the webhook**, or the
  ledger's role. §6 adds one new *writer*, with a new `source`, and no schema
  change: `db/001` is untouched, and `db/002` needs no change because
  `get_suppression_state()` already counts `revoked` alongside `suppressed`.
- **It records nothing when the operator decides a message is not an opt-out.**
  There is no "reviewed, no action" state in the ledger or in HubSpot, and adding
  one would be the message archive by another name.
- **It does not change the automatic classifier.** `api/_lib/optout.mjs` keeps its
  keyword list, its ten patterns and its `suppressed` / `revoked` split exactly as
  merged; the operator action is a second writer, not a second opinion.

---

## 9. What a human must do — when this is implemented, not now

1. **Add `CONSENT_LEDGER_URL` (the `INSERT`-only credential) to Production**
   before the webhook is activated — §7. Not now.
2. **Add `OPERATOR_ACTION_SECRET` to Production** before the operator action is
   live. Not now.
3. **Confirm `ZOHO_SMTP_*` is actually scoped to Production** in the Vercel
   dashboard. It is documented as Production-only; documented is not observed.
4. **Confirm the notification actually lands.** A message from the operator's own
   mailbox to that same mailbox can be filed, threaded or filtered by the mail
   provider. Send one and confirm it arrives, unfiltered, on the phone she
   actually carries — and that the subject shows only the last four digits.
5. **Confirm Twilio Debugger alerting is on**, so a 503 from this endpoint reaches
   somebody.
6. **Measure the real webhook latency at gate 9** against Twilio's ~15 s timeout.
7. **Walk the operator action once, end to end, on a test number**: GET renders
   and writes nothing; POST writes exactly one `revoked` row carrying the
   consumer's exact words; a second POST writes none; and — with the consent
   feature on — the `cst_*` properties are projected onto every matching contact.
8. **Confirm on that walkthrough that `get_suppression_state()` returns the
   operator's row.** It should, because the function counts `revoked`; confirm it
   rather than trust this document.
9. **Decide the unsuppression path** (§6.7) before gate 9.

---

## 10. Status after this decision

| Gate 7 item | State |
|---|---|
| SMS suppression ingress | built, merged, inert |
| **Operator surfacing of unclassified messages** | **design settled — §4. Not built.** |
| **Operator-initiated suppression entry** | **design settled — §6. Not built.** |
| Its HubSpot projection | **design settled — §6.9, same model as the webhook. Not built.** |
| Unsuppression | not designed, out of scope, required before gate 9 |
| Voice / Retell ingress | not built |
| `TWILIO_AUTH_TOKEN` in Production | not set, in any environment |
| `CONSENT_LEDGER_URL` in Production | **absent — and required for gate 7**, §7 |
| Point a Twilio number at the endpoint | frozen — TCR hold, error 30753 |
| Configure webhook retry | frozen — TCR hold, error 30753 |
| Send a real STOP | frozen — depends on the two above |

**Nothing in this document has been executed, tested or observed.** It settles
what should be built. The endpoint behaves today exactly as it did before this was
written: an unclassified message produces a log line and a 200, and reaches
nobody.

---

## 11. One stale code comment, recorded and deliberately not fixed here

Found while verifying this revision against `main`:

**`api/_lib/consent-ledger.mjs`, in the `appendSuppressionEvents()` doc comment:**

> *"The webhook that calls this returns 5xx when it throws, **so Twilio
> retries** — and the retry is safe because the dedupe key is derived from the
> provider's own message id."*

**"So Twilio retries" is false, and it is the same misconception this project has
already corrected twice elsewhere.** Twilio does **not** redeliver a failed
incoming-message webhook by default; retry must be configured explicitly on the
Messaging Service, and that configuration is frozen under the TCR hold and listed
as a live-activation prerequisite. `api/twilio-inbound.js` states the true
position correctly in its own comments — *"5xx is the fail-closed answer, NOT a
retry mechanism"* — so the module and its caller currently disagree with each
other.

The sentence's second half is accurate: the dedupe key **is** derived from
`MessageSid`, and the no-op **was** measured against live Neon. The defect is the
causal claim, and the risk is that a reader treats redelivery as a property they
already have.

**Not fixed in this pull request**, which is documentation-only and touches no
file under `api/`. **It must be fixed in the next implementation pull request
that touches this module** — which, if this decision is accepted, is the one that
adds `SOURCE_OPERATOR` to it.

> **CLOSED, 10 September 2026.** The implementation pull request added
> `SOURCE_OPERATOR` to `api/_lib/consent-ledger.mjs` and corrected that comment in
> the same change. It now states that a 5xx is the fail-closed answer and **not** a
> retry mechanism, that incoming-webhook retry must be configured explicitly on the
> Messaging Service, and that the dedupe key makes a redelivery safe **if** one
> arrives — idempotency, not a guarantee that a retry happens. §6.1's GET wording
> was clarified in the same pull request, from *"Reads nothing"* to *"reads no
> database state and writes nothing"*: the GET must decrypt the sealed token to
> render the page, so it does read something — its own input — and the guarantee
> that carries the weight is that **no request state changes on a GET.** What was
> built, and what is still unproven: `docs/updates/2026-09-10-unclassified-inbound-operator-surfacing.md`.
