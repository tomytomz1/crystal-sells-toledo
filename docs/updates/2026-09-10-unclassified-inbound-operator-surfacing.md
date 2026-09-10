# Operator surfacing and the operator suppression action — as built

**10 September 2026. Implementation.** Builds §4, §6 and §6.9 of
`docs/updates/2026-09-10-unclassified-inbound-operator-surfacing-decision.md`,
merged the same day in
[#23](https://github.com/tomytomz1/crystal-sells-toledo/pull/23).

**Nothing here has ever run outside a test.** No Twilio request has reached this
deployment, no notification email has been sent, no sealed token has been opened
by a browser, and no operator row exists in the ledger. **Production behaviour is
unchanged** because every credential the new code needs is absent from every
environment — and that is by design, not by accident. §9 states exactly what is
unproven.

---

## 1. What was wrong

`POST /api/twilio-inbound` answered **200 with one log line** for any message its
classifier did not recognise. The event was named
`twilio.inbound.unclassified_not_surfaced` to say out loud that a log line is not
an operator workflow.

Two things fell through it:

1. **A real opt-out the rules did not recognise.** The classifier is
   deterministic by design — Twilio's keyword list plus ten intent patterns.
   *"quit hassling me"*, *"lose my number"* and *"who is this? never contact me
   again"* match none of them, **and Twilio does not block them either**, because
   Twilio enforces only its own keywords. Enforced by nobody, recorded by nobody.
2. **An ordinary lead reply.** *"what time is the showing?"* — a business failure
   rather than a compliance one, and still a failure.

At arrival the system cannot tell them apart, so a human is the classifier of
last resort. And a human who can *see* but cannot *record* has not been given a
workflow: before this change there was no way for an operator to enter a
suppression at all, short of a Neon owner credential.

## 2. What changed

Two endpoints and one new module.

### 2.1 The notification — `api/twilio-inbound.js`

The `if (!decision)` branch now calls `surfaceToOperator()` instead of answering
200 with a log line. That function:

- caps the consumer's words with the ledger's own `capEvidence()` — **before**
  anything else, so the words in the email are byte-identical to the words that
  would later be written as evidence;
- seals `{ sid, phone, capped body }` into an AES-256-GCM token and builds the
  operator-action link from it;
- emails the operator over the SMTP transport already used for the lead
  acknowledgement, under **one overall deadline**;
- answers **200** on a successful SMTP handoff and **503** on anything else.

**No ledger row, no HubSpot call, no store.** Its failure domain stays disjoint
from Neon's and HubSpot's.

**The email.** Subject `Crystal Sells Toledo: inbound message ending 2789` — the
**last four digits only**, because a subject is a lock-screen preview. The body's
**first line is fixed text**, so the preview line cannot carry the consumer's
words either. Inside: the full E.164 with `tel:` and `sms:` links, the message
verbatim (capped at 1 KB), the `MessageSid`, server receipt time in UTC, the
operator-action link, and an explicit statement that **replying to the email
reaches nobody**. Plain text and HTML, HTML escaped with the existing
`escapeHtml()`, and **no third-party image, tracker or signature block**.

`Message-ID` is `<inbound-{MessageSid}@crystalsellstoledo.com>` — deterministic,
so a redelivery carries the same one and many receivers collapse it.
**Best-effort only.** No standard requires a receiver to deduplicate, and this
does **not** replace webhook idempotency, which is the ledger's dedupe key.

**The response policy:**

| Situation | Response | Log event |
|---|---|---|
| SMTP accepted the message | **200** + empty TwiML | `twilio.inbound.unclassified_notified` |
| Send failed, or the token could not be sealed | **503** | `twilio.inbound.unclassified_notify_failed` |
| Deadline passed | **503** | `twilio.inbound.unclassified_notify_failed`, `mail_error: connection` |
| Mail unconfigured, **or** `OPERATOR_ACTION_SECRET` absent | **503** | `twilio.inbound.unclassified_not_surfaced` — the existing event, now meaning *surfacing was impossible* |

**Never a silent 200.** That was the defect.

**The deadline is 8 seconds, and it is a constant rather than a sum.** Twilio's
webhook request times out at roughly 15 s; the SMTP transport is bounded at 5 s
connection, 5 s greeting and 8 s socket, which are three *independent* bounds
that do not add up to a promise. `sendInboundNotification()` races the send
against a single timer and treats losing as the failure case. The losing send is
**not cancelled** — nodemailer has no cancellation — so the socket may still
deliver, which risks a duplicate email and never a hang. `vercel.json` now gives
`api/twilio-inbound.js` a 15 s `maxDuration`, so the function cannot be killed
before it can answer 503.

**`HELP` is untouched.** So is every classified suppression: those are already
durable and already projected, and a notification for them was out of scope.

### 2.2 The sealed token — `api/_lib/operator-token.mjs` (new)

AES-256-GCM from `node:crypto`. **No new dependency.**

- **Key**: HKDF-SHA256 over `OPERATOR_ACTION_SECRET` with a fixed salt and a
  use-specific `info` string, so the secret may be any length or alphabet and a
  future second use of the same secret cannot silently become the same key.
- **Wire format**: base64url of `version byte ‖ 12-byte nonce ‖ 16-byte tag ‖
  ciphertext`. The version byte travels in the clear and is bound into the AAD,
  so it cannot be relabelled with the tag still verifying.
- **Payload**: `{ v, sid, p, b, iat, exp }` — the MessageSid, the E.164 number,
  the already-capped message, and a **30-day** expiry.
- **Refusal order**: presence, size, alphabet, structure, version, **tag**,
  then expiry. Everything cheap happens before the cipher runs, and expiry is
  checked *after* the tag so an expired token and a forged one are
  indistinguishable to anyone who cannot already open it.
- **A wrong key and a flipped bit produce the same answer**, deliberately.

**Why sealed rather than signed plaintext: a URL is a log line.** Vercel records
request paths, browsers record history, and `api/_lib/log.mjs` redacts `phone`
for exactly this reason. The URL therefore carries ciphertext and nothing else,
and the endpoint needs no datastore.

**The size bound is enforced, not estimated.** The decision document's ~1.6 KB
figure was arithmetic. `sealOperatorToken()` refuses to emit a token over
`MAX_TOKEN_CHARS` (3000) or a URL over `MAX_ACTION_URL_BYTES` (4096), and
`unsealOperatorToken()` refuses an oversized token on length alone, before any
decryption. A test measures the genuine worst case — a full 1 KB of four-byte
characters — and asserts it lands inside the bound.

**The module logs nothing at all**, and `tools/check.mjs` fails the build if it
ever does: it is the one place the plaintext number and message exist together.

### 2.3 The operator action — `api/operator-action.js` (new)

**GET confirms. POST writes. That split is the whole safety model**, because
Outlook Safe Links, mail-gateway antivirus, Gmail prefetch and iOS previews all
issue unattended GETs — and a suppression cannot be undone.

**GET** `/api/operator-action?t=<token>` — **reads no database state and writes
nothing.** It decrypts its own input to render the page; no request state
changes. It shows the number, the `MessageSid` and the consumer's words (the
operator cannot judge a message she cannot see — the same disclosure as the email
the token arrived in, and no wider), then a form offering the three scopes with
**nothing pre-selected**.

Headers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer` (stricter than
`vercel.json`'s site-wide `strict-origin-when-cross-origin`, because the token is
in the URL on a GET), `X-Robots-Tag: noindex, nofollow, noarchive`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a
`Content-Security-Policy` of `default-src 'none'; style-src 'unsafe-inline';
form-action 'self'; base-uri 'none'; frame-ancestors 'none'`. **The page loads no
third-party resource and carries no script.**

An expired token renders **410** and a page saying so; anything else invalid
renders **400**. With the secret absent the endpoint answers **503** and renders
no page — so it is inert until the secret is set.

**POST** requires three things a scanner cannot supply, each checked **before the
ledger is touched at all**:

1. **The token in the body.** A token in the POST *query string* is refused
   outright with 400 — silently reading the body instead would let a live
   capability keep leaking into request logs unnoticed.
2. **An explicitly chosen scope** — `sms`, `ai_voice` or `all`, **no default
   anywhere in the file**. A default would be the endpoint making the judgement
   the human is there to make: *"stop texting me"* and *"stop contacting me"* are
   different suppressions.
3. **The confirmation literal** `RECORD_OPT_OUT`, compared in constant time.

### 2.4 What the POST writes

One row, through the **existing** `buildSuppressionEvent()` and
`appendSuppressionEvents()`, on the **`INSERT`-only** `CONSENT_LEDGER_URL`
credential. The endpoint names no table, no column and no connection string —
`tools/check.mjs`'s containment rule now covers it.

| Column | Value |
|---|---|
| `event_type` | **`revoked`** — the only value reachable from this endpoint |
| `channel` | `sms` / `ai_voice` / `all`, from the chosen scope |
| `phone_e164` | from the sealed payload |
| `source` | **`operator`** — `SOURCE_OPERATOR`, new in `api/_lib/consent-ledger.mjs` |
| `source_event_id` | the `MessageSid` |
| `reason_code` | `SUPPRESSION_REASON.MANUAL` |
| `evidence_text` | **the consumer's exact words**, capped by `capEvidence()` |
| `metadata` | `{ MessageSid, classified_by: "operator", entered_via: "email_action", token_v }`, plus `operator_note` when one was typed |
| `submission_id` | `NULL` — a suppression is about a number, not a submission |

**`revoked`, not `suppressed`, because that is the act that happened.**
`api/_lib/optout.mjs` reserves `suppressed` for a keyword or carrier action and
emits `revoked` for a consumer withdrawing in words. This message reached a human
**because it was not a keyword**. `reason_code = manual` records who recognised
it, so the act and the recogniser sit in separate columns.

**The operator's note goes in `metadata` and never in `evidence_text`.** That
column means *what the consumer said*; mixing operator prose into it would
corrupt the one field whose value depends on being verbatim. It is capped at 280
characters.

**Dedupe key: `operator:<MessageSid>:<channel>:revoked`**, with the existing
`ON CONFLICT DO NOTHING` and **no conflict target** (naming one requires
`SELECT`, which this role deliberately lacks — the 42501 outage of 9 September).
A second click, a double submit, a forwarded copy of the email or a browser retry
all converge on the same key. **A second, independently sealed token for the same
message produces the identical key**, because idempotency derives from the
`MessageSid` and not from the token — that is asserted by test.

**It cannot clear a suppression, enforced three ways**: `revoked` is the only
event type in the file, `tools/check.mjs` fails the build if the endpoint so much
as names `EVENT_TYPE.UNSUPPRESSED`, and the credential holds `INSERT` and nothing
else — no `UPDATE`, no `DELETE`, not even `SELECT`.

**A ledger failure answers 503** and renders "Not recorded". It never reports
success.

### 2.5 The HubSpot projection

After — and only after — the append succeeds, the POST does exactly what
`projectToHubSpot()` in `api/twilio-inbound.js` does: skip when
`consentStateEnabled()` is false, skip when HubSpot is unconfigured, otherwise
`findContactsByPhone()` and, per contact,
`toHubSpotSuppressionProperties({ scope, trigger: SUPPRESSION_TRIGGER.MANUAL, at, current })`
then `writeSuppressionProperties()`. One contact failing does not stop the rest,
and the whole projection is wrapped so **no HubSpot error escapes**.

**No new HubSpot scope, property or dropdown value.** `SUPPRESSION_TRIGGER.MANUAL`
and a `manual` value in all three reason maps already existed.

**A HubSpot failure cannot weaken the ledger suppression.** The append has
already committed, enforcement resolves by phone against the ledger, and the
result page says so in words: *"That is a display problem only — the record above
is the one that counts, and it was written."* A partial outcome is shown, not
hidden, and it is not a failure.

**Nothing is written when the operator decides a message is not an opt-out.** She
closes the tab; the ledger and the CRM stay untouched.

### 2.6 The two carried-forward cleanup items

Both were approved at the merge of #23 and are closed here.

1. **`api/_lib/consent-ledger.mjs`'s stale comment.** It claimed a webhook 5xx
   means *"so Twilio retries"*. **False** — incoming-webhook retry is not
   automatic and must be configured explicitly on the Messaging Service, which is
   frozen under the TCR hold. The module and its own caller contradicted each
   other. The comment now says the 5xx is the fail-closed answer, that retry must
   be configured separately, and that the dedupe key makes a redelivery safe **if
   one arrives** — idempotency, not a guarantee.
2. **§6.1's GET wording** in the decision document, from *"Reads nothing"* to
   *"reads no database state and writes nothing"*. The GET must decrypt the
   sealed token, so it does read something: its own input.

## 3. New static guards — `tools/check.mjs`

Eight, on top of the four gate 7 guards already there. Each is an invariant a
refactor could delete without breaking a visible behaviour, on code that is inert
and therefore has no live traffic to notice.

| # | Guard |
|---|---|
| 5 | The webhook still sends the notification, and the surfacing path can still answer 503 |
| 6 | The **GET path** calls none of `appendSuppressionEvents`, `buildSuppressionEvent`, `writeSuppressionProperties`, `projectToHubSpot` |
| 7 | The endpoint emits `EVENT_TYPE.REVOKED` and **names no other event type** |
| 8 | Ledger append before HubSpot projection |
| 9 | Neither the number, the words, the note nor the token reaches `log()` |
| 10 | The no-scope refusal still exists |
| 11 | The confirmation page references **no off-site resource** |
| 12 | The token module seals with `aes-256-gcm`, keeps both hard size bounds, and **logs nothing** |

`OPERATOR_ACTION_SECRET` was added to `SECRET_NAMES`, so the build fails if it
ever appears in anything delivered to a browser. `api/operator-action.js` and
`api/_lib/operator-token.mjs` were added to the ledger-schema containment list.

## 4. A defect found in an existing test

`tests/suppression.test.mjs`'s *"logging the consumer's message body is refused"*
mutation targeted a line this implementation reshaped. The `String.replace()`
then matched nothing, the tree was never mutated, `check.mjs` passed, and **the
test reported green while proving nothing.**

Retargeted, and — more usefully — every mutation test in the new file goes
through a `mutate()` helper that **fails if the replace changed nothing**. A
mutation test that does not mutate is worse than no test, because it reports
success.

## 5. Files changed

| File | Change |
|---|---|
| `api/_lib/operator-token.mjs` | **new** — seal, unseal, size bounds, refusal taxonomy |
| `api/operator-action.js` | **new** — GET confirms, POST writes, then projects |
| `api/twilio-inbound.js` | the unclassified branch surfaces instead of answering a silent 200 |
| `api/_lib/mail.mjs` | the operator notification: builder, `lastFour()`, deadline-bounded sender |
| `api/_lib/consent-ledger.mjs` | `SOURCE_OPERATOR`; `capEvidence()` exported; the stale retry comment corrected |
| `tools/check.mjs` | `OPERATOR_ACTION_SECRET` in `SECRET_NAMES`; eight new guards; containment extended |
| `vercel.json` | `maxDuration` for `api/twilio-inbound.js` (15 s) and `api/operator-action.js` (30 s) |
| `tests/operator-action.test.mjs` | **new** — 83 tests |
| `tests/suppression.test.mjs` | the vacuous mutation retargeted |
| `docs/updates/…-decision.md` | §6.1 GET wording; §11 marked closed |
| `docs/CURRENT-STATE.md` | these two items move from *designed* to *built and inert* |

**`db/001` and `db/002` are untouched.** `get_suppression_state()` already
filters `event_type IN ('suppressed', 'revoked')`, so an operator entry suppresses
at send time exactly as a keyword STOP does and **no migration is needed.**

## 6. The contract

- **`POST /api/twilio-inbound`, unclassified message**: 200 only when SMTP
  accepted the notification. 503 on send failure, timeout, seal failure,
  unconfigured mail or absent `OPERATOR_ACTION_SECRET`. Never a silent 200.
  No ledger row, ever, for an unclassified message.
- **`GET /api/operator-action`**: 200 with a page, 410 expired, 400 invalid, 503
  unconfigured. **Writes nothing in every one of those cases.**
- **`POST /api/operator-action`**: 400 without a body token, an explicit scope
  and the confirmation literal; 400 if the token is in the query string; 410
  expired; 503 without the ledger or on an append failure; 200 with exactly one
  `revoked` row otherwise. Idempotent on `operator:<MessageSid>:<channel>:revoked`.
- **The ledger is authoritative; HubSpot is the projection.** A CRM failure costs
  visibility, not compliance, and never changes the response.

## 7. Environment

**No environment variable was added, changed or removed, in any environment.**

`OPERATOR_ACTION_SECRET` is a **name in code** and is set nowhere. `ZOHO_SMTP_*`
is documented as Production-only and is unchanged. `TWILIO_AUTH_TOKEN` remains set
in no environment. `CONSENT_LEDGER_URL` remains Preview-only. The
`consent_ledger_sender` string remains in no environment.

**With any of them absent the new code is inert**, which is why production
behaviour is unchanged: the webhook still answers 503 at `twilioConfigured()`
before reading a body, and the operator action answers 503 before rendering
anything.

## 8. Tests

`tests/operator-action.test.mjs` — **83 tests, all passing**. Nothing reaches a
database, an SMTP server, Twilio or HubSpot: the ledger executor is injected, the
mail transport factory is replaced, and `globalThis.fetch` throws if anything
tries to use it.

Covered: valid seal/unseal; a fresh nonce per seal; tampered ciphertext; a
different secret; truncated, non-alphabet, empty and oversized tokens; expiry on
both sides of the boundary; the measured worst-case URL size; a colon in the
MessageSid refused at seal time; **GET writes nothing**, including four
scanner-shaped GETs; the page's headers, its lack of third-party resources and
its lack of a pre-selected scope; POST refusals for missing scope, unknown scope,
missing confirmation, wrong confirmation, missing token, token-in-query, expired
token, tampered token and absent ledger — **each asserting zero statements
reached the ledger**; the exact row written; all three scopes and their dedupe
keys; the statement's shape (`ON CONFLICT DO NOTHING`, no conflict target, no
`UPDATE`/`DELETE`); byte-exact evidence and the 1 KB cap with `…[truncated]`; the
note in metadata and never in evidence; a ledger failure → 503; **a HubSpot
failure after a ledger success → 200 with the row still written**; feature-off and
unconfigured skips; the MANUAL trigger and the `manual` dropdown value on every
matching contact; the subject's four digits; the fixed first body line; the
deterministic `Message-ID`; HTML escaping of the consumer's words; email success →
200, failure → 503, timeout → 503 (measured against the deadline), mail
unconfigured → 503, secret absent → 503; **HELP and a classified STOP unchanged**;
five logging assertions that the number, the words, the note and the token never
appear; static containment of the secret's name and value; and eight guard
mutations run against a **throwaway copy of the tree**, never the working tree.

`tests/suppression.test.mjs`, `tests/mail.test.mjs` and
`tests/consent-ledger.test.mjs` were re-run and pass.

## 9. What is UNPROVEN

Stated plainly, because a merged implementation document reads like a working
system.

- **Nothing here has run outside a test.** No Twilio request has ever reached
  this deployment. No notification email has ever been sent. No browser has ever
  opened a sealed token. **No operator row exists in the ledger.**
- **The SMTP path for this message is unexercised.** The transport is proven by
  the lead acknowledgement, but this message, this subject, this
  `Message-ID` and this recipient have never been through it. Whether Zoho
  delivers a mail from the operator's mailbox to that same mailbox unfiltered —
  and whether it collapses a duplicate `Message-ID` — is **claimed from
  documented behaviour, not observed.**
- **The 8-second deadline has never met real SMTP.** It is proven against a
  promise that never resolves. Real webhook latency must be measured at gate 9.
- **The cryptography is unreviewed by anyone but its author.** Nonce handling,
  key derivation and the refusal order are as described and tested, and have had
  no independent review.
- **No link scanner has ever touched the GET.** The behaviour is proven by
  construction and by a static guard, not by an actual Safe Links fetch.
- **The `ON CONFLICT` no-op has never been driven through this endpoint against
  live Neon.** The clause and the key shape are proven; the second POST
  converging to `INSERT 0 0` is inherited from the webhook's measurement, not
  measured here.
- **The HubSpot projection has never run for real from this endpoint.** It is
  proven against a stubbed `fetch`.
- **`get_suppression_state()` has never been asked about an operator row**,
  because none exists. It filters `revoked`, which is read from the migration and
  not observed for this source.

## 10. What a human must still do

Unchanged from the decision document's §9, and none of it is done here:

1. Add `CONSENT_LEDGER_URL` (the `INSERT`-only credential) to **Production**
   before the webhook is activated.
2. Add `OPERATOR_ACTION_SECRET` to **Production** before the operator action is
   live. Absent, the endpoint is inert.
3. Confirm `ZOHO_SMTP_*` really is scoped to Production in the Vercel dashboard —
   documented is not observed.
4. Send one notification to the mailbox and confirm it arrives unfiltered on the
   phone she carries, with only four digits in the subject.
5. Confirm Twilio Debugger alerting is on, so a 503 reaches somebody.
6. Measure real webhook latency at gate 9 against Twilio's ~15 s timeout.
7. Walk the operator action end to end on a test number: GET writes nothing; POST
   writes exactly one `revoked` row with the exact words; a second POST writes
   none; and with the consent feature on, the `cst_*` properties are projected.
8. Confirm on that walkthrough that `get_suppression_state()` returns the
   operator's row.
9. **Decide the unsuppression path before gate 9.**

## 11. Explicitly not done

- **No unsuppression route.** The endpoint cannot clear what it writes, so a
  mistaken entry is permanent under today's design. This is the single most
  important thing still open, and it is required before gate 9.
- **No general-purpose admin endpoint**, no account system, no session store. The
  authority is one sealed token scoped to one `MessageSid`, and it expires.
- **No second datastore.** No notification dedupe store, no message queue, no
  archive.
- **No rate limiting and no notification cap.** At one realtor's volume it is not
  justified; if it becomes justified that will be a measurement.
- **No change to the automatic classifier**, to `HELP` handling, to classified
  suppressions, or to what the webhook writes for them.
- **No Twilio, Retell, Neon, HubSpot or Vercel environment change.** No Messaging
  Service, Brand, campaign, webhook-routing or retry change — all frozen under
  the TCR hold on error 30753.
- **Gate 8 not begun.**
