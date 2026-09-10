# Operator surfacing for unclassified inbound SMS — decision

**10 September 2026. Documentation only. Nothing in this document is built.**

This settles the last open **design** decision in gate 7 that is not frozen by the
Twilio/TCR hold on error 30753: **what happens to an inbound SMS that the opt-out
classifier does not recognise.**

It decides the shape. It does not implement it, does not touch Twilio, Retell,
HubSpot, Neon or Vercel configuration, and does not add `TWILIO_AUTH_TOKEN`.
Gate 8 is not begun.

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

---

## 2. Constraints the answer has to satisfy

Six, taken from the operator's brief and from what the repository already commits
to:

1. **Crystal must actually see it and be able to act on it.** Not "it is
   retrievable"; seen, in a place she already looks.
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

And two the repository imposes:

7. **The consumer's message must never reach a log line.** `tools/check.mjs`
   fails the build if `params.Body` is passed to `log()`. Any surfacing path has
   to carry the body outside the log stream.
8. **Nothing may depend on `COMMUNICATIONS_CONSENT_ENABLED`.** That flag governs
   `cst_*` reads and writes. Operator visibility is not a consent write and must
   not inherit a flag that is off in Production.

---

## 3. Options evaluated

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
  message. And an SMS is a poor carrier of a 1 KB message plus its metadata.

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

## 4. The decision

> **An unclassified inbound message is emailed to the operator, immediately, one
> message per email, over the SMTP transport this project already uses for the
> lead acknowledgement — and the endpoint answers 503 if that email cannot be
> handed to the mail server.**

No ledger row. No HubSpot call. No new store. No new secret.

### 4.1 Where it attaches

The `if (!decision)` branch of `handler()` in `api/twilio-inbound.js` — after
signature verification, after the `MessageSid` / `From` completeness check, and
before the response is written.

**Only that branch.** Not `help` (Twilio answers HELP itself, and a HELP request
is not an opt-out). Not classified suppressions — those are already durable in
the ledger and already projected into HubSpot.

### 4.2 What the email carries

| Field | Why it is there |
|---|---|
| The sending number, in E.164 **and** as a `tel:` / `sms:` link | The only way to act on the message is to contact the person from her own phone |
| The message body, **verbatim**, capped at 1 KB on a byte boundary | The words are the thing a human is being asked to judge; the same cap and truncation rule as `evidence_text` |
| `MessageSid` | The correlation key back to Twilio's own record, which holds the authoritative timestamp |
| Server receipt time, UTC | The endpoint has no message timestamp — the incoming-SMS webhook carries none — so this is an **upper bound**, exactly as `occurred_at` is on a suppression row |
| A fixed instruction block | What to do if this *is* an opt-out; and that **replying to the email reaches nobody** |

Plain text and HTML, the HTML escaped with the existing `escapeHtml()`.

**Recipient: the operator's own mailbox, as a constant, not an environment
variable.** `api/_lib/mail.mjs` already pins `FROM_ADDRESS` for exactly this kind
of reason. One realtor, one inbox; adding a variable later is a two-line change
if she ever wants notifications elsewhere.

**Subject: stable prefix plus the number**, so it is filterable, sortable and
readable from a phone's lock screen without opening anything.

### 4.3 Response policy — the failure behaviour

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
- **A redelivery would produce a duplicate email**, because there is no dedupe
  store for notifications and there deliberately will not be one — a dedupe store
  is a message store. A duplicate email is a benign failure; a missed opt-out is
  not.
- **Twilio's Debugger records a failed webhook** (error 11200) and can be
  configured to email the account owner. That is a second, no-build alert on the
  same failure. **Confirm that alerting is switched on at activation** — it is
  claimed here from Twilio's documented behaviour, not observed.

### 4.4 What it does *not* depend on

Worth listing, because it is most of the argument:

- **Not on Neon.** An unclassified message writes no ledger row, so a ledger
  outage cannot suppress operator visibility. The two failure domains are
  disjoint.
- **Not on HubSpot.** No contact search, no property write, no form submission,
  no new scope.
- **Not on `COMMUNICATIONS_CONSENT_ENABLED`.** Operator visibility is not a
  consent write; the flag stays off in Production and this is unaffected.
- **Not on any Twilio configuration beyond the one that already gates the whole
  endpoint.** Which is why this is buildable *now*, under the TCR hold.

### 4.5 Latency, and the one engineering risk

Twilio's webhook request times out at roughly **15 seconds**. The existing SMTP
transport is bounded at 5 s connection, 5 s greeting, 8 s socket — bounded, but
not comfortably inside 15 s if every bound is hit while the ledger path has
already spent time elsewhere.

**The implementation must impose one overall deadline on the notification** and
treat exceeding it as the failure case in §4.3, rather than relying on the three
independent timeouts to add up to something acceptable. Measure the real timing
at gate 9, against a real Twilio request. **This is unmeasured today** — no
Twilio request has ever reached this endpoint.

---

## 5. Why this beats the alternatives

Against **A (timeline activity)** and **B (task)**: those two require, between
them, an email address the message does not have, a CRM scope the Service Key
does not hold, and a contact record that frequently does not exist. Email
requires nothing that is not already deployed and proven — `ZOHO_SMTP_*` has been
live since 8 September and delivers the lead acknowledgement today.

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

And on constraint 1: notification volume for one agent's number is low enough
that per-message email is legible. **No digest, no batching** — a digest delays an
opt-out by design, which is the wrong direction on the one message type that
matters most.

---

## 6. The gap this surfacing exposes, which it does not close

**Crystal reads *"quit hassling me"*. What can she actually do?**

Today: nothing systematic. **There is no operator-initiated path to record a
suppression.** `api/twilio-inbound.js` writes suppressions only from a message it
classified itself; `unsuppressed` exists as an event type and nothing writes it;
no console, script or workflow lets a human enter either one.

That is tolerable **only** while nothing sends: with gate 8 unbuilt, no code path
resolves suppression at send time and no SMS or AI voice call is ever placed, so
an unrecorded opt-out has nothing to enforce against. **It stops being tolerable
the moment gate 8 or gate 9 begins.**

So, recorded as a dependency rather than decided here:

> **Before live sending, an operator-initiated suppression entry must exist.**
> The ledger already accommodates it — `SUPPRESSION_REASON.MANUAL` (`"manual"`)
> is defined in `api/_lib/consent.mjs`, `source` is free text in `db/001` with
> only `website` forbidden for suppressions by `buildSuppressionEvent()`, and the
> owner credential can insert. What does not exist is the workflow, and the
> smallest honest version of it is a documented owner-credential procedure, not a
> UI.

The notification email should therefore say what the operator can do *at the time
it is built*, and should be revised when that path exists.

**A second, adjacent gap, found while writing this and deliberately not closed:**
a `reoptin_requested` event (`START`, `UNSTOP`, `YES`, `OPT IN`) is projected into
HubSpot **only when `consentStateEnabled()` is true** — and that flag is absent
from Production. With it off, a re-opt-in request reaches the ledger and reaches
no human. It is a smaller hole than this one (nothing is being sent, so nothing
is being wrongly withheld), but it is the same shape and should be settled before
gate 9.

---

## 7. What this decision explicitly does not do

- **It does not implement anything.** No code, no test, no configuration.
- **It does not surface classified messages.** Suppressions are durable and
  projected; adding a notification for them is a separate, easy question and is
  not answered here.
- **It does not surface `HELP`.**
- **It does not add rate limiting or a notification cap.** At one realtor's volume
  it is not justified. If inbound volume ever makes it justified, that is a
  measurement, not a guess.
- **It does not create a reply path.** Crystal responds from her own phone, using
  the number in the email. Replying to the email reaches nobody, and the email
  has to say so.
- **It does not change what reaches the ledger, or the ledger's role.**

---

## 8. What a human must do — when this is implemented, not now

1. **Confirm the notification actually lands.** A message from the operator's own
   mailbox to that same mailbox can be filed, threaded or filtered by the mail
   provider. Send one and confirm it arrives, unfiltered, on the phone she
   actually carries.
2. **Confirm Twilio Debugger alerting is on**, so a 503 from this endpoint
   reaches somebody.
3. **Measure the real webhook latency at gate 9** against Twilio's ~15 s timeout.
4. **Decide the operator-initiated suppression path** (§6) before gate 8 or gate 9.

---

## 9. Status after this decision

| Gate 7 item | State |
|---|---|
| SMS suppression ingress | built, merged, inert |
| **Operator surfacing of unclassified messages** | **design settled — this document. Not built.** |
| Voice / Retell ingress | not built |
| `TWILIO_AUTH_TOKEN` in Vercel | not set, in any environment |
| Point a Twilio number at the endpoint | frozen — TCR hold, error 30753 |
| Configure webhook retry | frozen — TCR hold, error 30753 |
| Send a real STOP | frozen — depends on the two above |

**Nothing in this document has been executed, tested or observed.** It settles
what should be built. The endpoint behaves today exactly as it did before it was
written: an unclassified message produces a log line and a 200, and reaches
nobody.
