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

**The deadline is 8 seconds, it is a constant rather than a sum, and it covers
the whole attempt.** Twilio's webhook request times out at roughly 15 s; the SMTP
transport is bounded at 5 s connection, 5 s greeting and 8 s socket, which are
three *independent* bounds that do not add up to a promise.
`sendInboundNotification()` starts one timer, then races **both** transport
creation and the send against it.

**That scope is a correction, and it is the point.** The first implementation
awaited `transportFactory()` and only then began the race, so transport creation
sat *outside* the deadline — and the real factory does a dynamic
`import("nodemailer")`, which is slow on a cold container and can in principle
hang. A stuck import would have consumed the entire webhook budget before the
8-second clock started. A deadline that does not cover the whole attempt is not a
deadline; it is a deadline on the part that was easiest to wrap.

Two consequences, and they are different from each other:

- **A send that has not started when the deadline passes is never started.** If
  the factory resolves late, the resolved transport is discarded: the caller has
  already answered 503 and nobody is waiting on it.
- **A send that has already started is not cancelled** — nodemailer has no
  cancellation — so the socket may still deliver. That risks a duplicate email
  and never a hang, and it is accepted rather than papered over.

`vercel.json` gives `api/twilio-inbound.js` a 15 s `maxDuration`, so the function
cannot be killed before it can answer 503.

**`HELP` is untouched.** So is every classified suppression: those are already
durable and already projected, and a notification for them was out of scope.

### 2.2 The sealed token — `api/_lib/operator-token.mjs` (new)

AES-256-GCM from `node:crypto`. **No new dependency.**

- **Key**: HKDF-SHA256 over `OPERATOR_ACTION_SECRET` with a fixed salt and a
  use-specific `info` string, so the secret may be any alphabet an operator can
  paste into Vercel, and a future second use of the same secret cannot silently
  become the same key. **Any length at or above the floor below** — not any
  length.
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

**The secret has an enforced entropy floor: 32 UTF-8 bytes, and the endpoint is
inert below it.** This key mints bearer capabilities — anyone who can derive it
can seal a token for any number and record a permanent, un-undoable opt-out
against it, with no account, session or second factor behind it. **HKDF does not
add entropy**; it stretches and separates. `OPERATOR_ACTION_SECRET=hunter2`
derives a perfectly well-formed 256-bit key that an attacker recovers by trying
`hunter2`, so the floor has to be on the *input*. The first implementation
treated any non-empty value as configured.

**One rule, three callers.** `operatorActionConfigured()`, sealing and unsealing
all resolve the secret through a single `usableSecret()` helper, so "configured"
cannot mean one thing at the gate and another at the cipher — which is exactly
how a weak secret slips past a check performed in only one of the three places. A
short secret reads **identically to an absent one**: 503, no page, nothing
recorded. A refusal names the variable and never the value **or its length** — a
length is a search space.

**The Production value must be randomly generated**, at least 32 bytes, from a
CSPRNG — for example `openssl rand -base64 48`. A 32-character passphrase a human
invented is 32 bytes of *length* and nowhere near 32 bytes of *entropy*, and this
floor cannot tell the two apart. **This pull request does not generate or set
it.**

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
corrupt the one field whose value depends on being verbatim.

**A note over 280 characters is REFUSED with a 400, not truncated.** `CLAUDE.md`
rule 11 — *"Reject overlength input; never silently truncate user data."* The
first implementation sliced it, which would have written a note stopping
mid-sentence into an append-only table this application cannot correct, and told
the operator it had recorded what she typed. The refusal happens before the
ledger is touched: **nothing is written, nothing is projected**, and the log
carries the limit rather than one character of the note. The textarea keeps its
`maxlength` as a browser convenience; the server rule is authoritative, and both
count UTF-16 code units so they cannot disagree over an emoji.

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
is the one that counts, and it was written."*

**A partial outcome is shown, not hidden — and that too is a correction.** The
first implementation's result sentence read only `written` and ignored `failed`,
so "both contacts marked" and "one marked, one refused" produced the same page.
A page that claims two contacts were marked when one was not is simply false.
Seven distinct outcomes now read distinctly:

| Outcome | What the page says |
|---|---|
| feature off / CRM unconfigured | not updated, and why; the record above is unaffected |
| no matching contact | nothing to mark there; the record stands on its own |
| the search itself failed | no contact was marked; a display problem only |
| some written, some failed | *"1 of 2 CRM contacts … was marked; 1 could not be updated"* |
| all writes failed | *"could not be updated for any of the 2 contacts"* |
| all already marked | *"were already marked, so nothing needed changing there"* |
| all written | *"were marked as well"* |

**None of them changes the HTTP 200.** The suppression was durable before any of
this ran.

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

Nine, on top of the four gate 7 guards already there. Each is an invariant a
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
| 13 | The sealing secret has a **minimum length** — HKDF does not turn a weak secret into a strong key |

Guard 5 was **rebuilt** on 10 September 2026 after an adversarial review proved
it did not protect its own invariant — §12.

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
| `tools/check.mjs` | `OPERATOR_ACTION_SECRET` in `SECRET_NAMES`; nine new guards; containment extended |
| `vercel.json` | `maxDuration` for `api/twilio-inbound.js` (15 s) and `api/operator-action.js` (30 s) |
| `tests/operator-action.test.mjs` | **new** — 119 tests |
| `tests/suppression.test.mjs` | the vacuous mutation retargeted |
| `docs/updates/…-decision.md` | §6.1 GET wording; §11 marked closed |
| `docs/CURRENT-STATE.md` | these two items move from *designed* to *built and inert*; the endpoint list corrected from one server endpoint to three |
| `CLAUDE.md` | the Project-facts Stack row corrected from "one Vercel function" to three |

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
  and the confirmation literal; 400 if the token is in the query string; 400 if
  the operator note exceeds 280 characters — **refused, never truncated**; 410
  expired; 503 without the ledger or on an append failure; 200 with exactly one
  `revoked` row otherwise. Idempotent on `operator:<MessageSid>:<channel>:revoked`.
  **The HubSpot projection is hard-bounded** at 25 contacts and 12 seconds —
  covering the search and every write, with the remaining budget passed into each
  request and the socket aborted when it runs out — and the page says how many
  were not reached.
- **The ledger is authoritative; HubSpot is the projection.** A CRM failure costs
  visibility, not compliance, and never changes the response — and the result page
  states the **actual** outcome, including a partial one.
- **The endpoint is inert unless `OPERATOR_ACTION_SECRET` is at least 32 bytes.**
  A short secret is indistinguishable from an absent one.

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

`tests/operator-action.test.mjs` — **119 tests, all passing**. Nothing reaches a
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
appear; static containment of the secret's name and value; and nine guard
mutations run against a **throwaway copy of the tree**, never the working tree.

**Added after independent review found four defects** (§11), and again after the adversarial self-review in §12: the deadline
covering transport creation, proved by a factory that never resolves and by one
that resolves *after* the deadline without a send ever starting; an overlength
note refused with zero ledger statements and no projection; all seven projection
outcomes asserted as **exact sentences** rather than loose patterns; and the
secret floor, including that the gate and the cipher agree on every value tested.

**The deadline tests were proved against the pre-fix code in a throwaway copy**,
where the factory-never-resolves case does not merely fail — it hangs the run,
which is precisely the production failure it describes.

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
   live. Absent — **or shorter than 32 bytes** — the endpoint is inert. It must be
   **randomly generated** from a CSPRNG (`openssl rand -base64 48` or equivalent),
   not a chosen passphrase: the length floor cannot tell length from entropy.
   **This pull request does not generate or set it.**
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

## 11. Four defects found by independent review, and fixed

All four were in this pull request's own first implementation, all four were
found by review against the merged design, and all four are corrected on the same
branch. None reached `main`.

1. **The "overall" deadline was not overall.** `sendInboundNotification()` awaited
   `transportFactory()` and only then started the race, so transport creation —
   a dynamic `import("nodemailer")` — sat outside the deadline it was supposed to
   be bounded by. **Root cause:** wrapping the operation that was obviously slow
   rather than the whole attempt; the word "overall" was in the comment and not in
   the code. Proved in a throwaway copy: against the old code a never-resolving
   factory does not fail the test, it **hangs the run**.
2. **The operator note was silently truncated.** `slice(0, MAX_NOTE_CHARS)`
   violates `CLAUDE.md` rule 11 outright, and would have written a note stopping
   mid-sentence into an append-only table, reported as recorded. **Root cause:** a
   cap treated as formatting rather than as validation. Now a 400 that writes
   nothing and projects nothing.
3. **A partial HubSpot projection was reported as a complete one.**
   `projectToHubSpot()` returned `failed`, and `projectionSentence()` ignored it,
   so "both contacts marked" and "one marked, one refused" produced the same page
   — contradicting this document's own claim that a partial outcome is shown
   rather than hidden. **Root cause:** a value produced and never consumed, which
   no test noticed because the tests asserted the response code, not the sentence.
4. **`OPERATOR_ACTION_SECRET` had no entropy floor.** Any non-empty value counted
   as configured, so `hunter2` would have minted real bearer capabilities. **Root
   cause:** treating HKDF as if it added entropy rather than stretching what it is
   given.

**A fifth, documentary:** `CLAUDE.md` and `docs/CURRENT-STATE.md` both still said
this project had **one** server function. That was already stale when
`api/twilio-inbound.js` merged, and this pull request made it stale twice over.
Both corrected to name all three.

**One test-quality defect was found while fixing #3**, by the same discipline that
caught the vacuous mutation in §4: an assertion written as
`/1 .*was marked/is` passed against a page that did not contain the claim at all,
because a dotall `.*` across a whole HTML document matches almost anything. The
projection assertions are now exact sentence matches. Writing the sentences out
also exposed that the first attempt at them was ungrammatical — *"and One other
could not be updated. Those is a display problem"* — which a loose regex would
have shipped.

## 12. Four more defects, found by adversarial self-review of `dfb5e43`

The head was reviewed again before merge, on the explicit assumption that it
still contained a defect. It contained four. All are fixed on the same branch;
none reached `main`.

1. **A fail-open return value.** `sendInboundNotification()` resolves
   `{ sent: false, reason }` for anything it declines to attempt, and
   `surfaceToOperator()` **never looked at the answer** — it inferred success
   from the absence of a throw and answered **200**. Unreachable today, because
   the caller pre-checks `isMailConfigured()` and that is the only decline reason
   the sender currently has. It is fixed anyway, because *a silent 200 on an
   unsent notification is the exact defect this entire path was built to delete*,
   and the acknowledgement sender next door already has a second decline reason
   (`no_recipient`) that would re-open it the day someone copies it across.
   **Root cause:** trusting a function's exceptions and ignoring its return
   contract.

2. **The HubSpot projection was unbounded, and could destroy the operator's
   answer.** `findContactsByPhone()` returns **up to 100** contacts; each write
   is a separate request bounded at 8 s; the loop was sequential and unbounded —
   up to ~800 s inside a 30 s `maxDuration`. A slow CRM with a handful of
   duplicate contacts on one number would blow the function budget **after the
   ledger append had already committed**, and the operator would get a platform
   timeout instead of the page that tells her the record stands. It costs no
   compliance and all of the reassurance. Now bounded at **25 contacts and 12
   seconds**, with the unreached ones **counted and stated** rather than dropped.
   **The first version of this bound was not hard** — see §13, which is the
   defect that fix left behind.
   **Root cause:** copying the webhook's projection shape without asking what the
   response was for. The webhook answers TwiML to a machine; this answers a page
   to the person who needs to know whether her opt-out was recorded.

3. **A static guard that did not guard.** Guard 5's second clause was an OR whose
   first alternative matched the **call site** in the `!decision` branch, which
   happens to sit within 400 characters of the unrelated `ledger_absent` 503. So
   **every** `reply(res, 503)` inside `surfaceToOperator()` could be replaced with
   a 200 and `check.mjs` still passed — the guard was syntactically satisfied
   while the invariant it names was destroyed. **Proved by mutation in a throwaway
   copy, not by reading.** Rebuilt to extract the function body and **count** its
   failure paths: fewer than four fails the build, and so does a 200 emitted
   before the last of them. **Root cause:** a regex anchored to a name that
   appears in two places, and a mutation test that only ever exercised the guard's
   *other* clause — so the broken half had never been run against a break.

4. **No shape validation on `sid` and `phone` before they reach an email.**
   `sid` is interpolated into the notification's **`Message-ID` header** and
   `phone` into its body and its `tel:`/`sms:` links, and neither was checked
   beyond "non-empty" and "no colon". A CRLF payload contains no colon, so the
   older rule would not have stopped `\r\n\r\n…` reaching a mail header. **Not
   reachable today** — the values come from a signature-verified Twilio body, so
   exploiting it needs `TWILIO_AUTH_TOKEN`, at which point an attacker can forge
   opt-outs outright. Fixed regardless, at the existing choke point, because an
   unvalidated request-derived value in a mail header is a finding whether or not
   today's authentication happens to cover it. Whitelisted on the way **in and
   out**, and deliberately permissive enough to accept everything `toE164()`
   accepts, so it can never refuse a number the ledger would have written.
   **Root cause:** validating for the *ledger's* needs (`dedupeKey()` refuses a
   colon) and assuming that covered the *email's* needs. Different consumer,
   different grammar.

**What these four have in common** is the assumption that a check written for one
purpose covers another: the ledger's colon rule standing in for header safety,
the webhook's projection shape standing in for a human-facing one, one clause of
a guard standing in for the guard, and a thrown error standing in for every way a
function can fail. None was caught by 105 passing tests.

## 13. The projection bound was not actually hard — found by review of `4397f00`

`4397f00`'s projection deadline was checked **between** writes. That bounds when
a write may **start** and says nothing about when it **ends**:

- the contact search could take up to 8 s and sat **outside** the budget;
- the deadline was then set to `now + 12 s`;
- a write passing the check at 11.9 s still ran under HubSpot's own **8 s**
  request timeout and finished near **19.9 s**.

So the advertised "12-second bound" was really a *12-plus-8-second* bound on top
of an 8-second search — and with 3 s of ledger and ordinary overhead, the 30 s
`maxDuration` was still reachable **after the durable write had committed**. That
is the exact failure §12's fix was written to prevent, surviving the fix.

**Measured, not argued.** Against the pre-fix code in a throwaway copy, the new
regression reports the projection taking **18,814 ms** against a 12,000 ms budget,
with the write given HubSpot's **8,009 ms** default rather than the time that
remained.

### What changed

1. **An optional per-request timeout** threads through `fetchWithTimeout()` →
   `hubspotFetch()` → `updateContact()` → `writeSuppressionProperties()` and
   `findContactsByPhone()`. **Omitting it changes nothing**: every existing caller
   keeps the 8 s default, asserted by test. An override that is present but
   non-positive floors at 1 ms rather than falling back to the default — quietly
   restoring 8 s is precisely how a hard bound turns soft again.
2. **The budget covers the search.** Leaving it outside would reintroduce the same
   arithmetic: an 8 s search plus a 12 s write phase is a 20 s projection however
   hard each half is. Inside, a slow search simply leaves less time for writes,
   and that is reported.
3. **The remaining budget goes into the request and the socket is aborted** when
   it expires. Racing a promise would leave the request in flight and the work
   running; only the `AbortController` actually stops it.
4. **A write is not started below `MIN_WRITE_MS` (500 ms)** — starting one there
   only guarantees an abort.
5. **The counting rule, documented in the code:** a write stopped because the
   budget was gone is reported as **unreached**, the same as one never started —
   true in the way that matters to the operator, which is that trying again may
   work. Anything else is HubSpot declining, and is **failed**.

### The headroom, which is the point

| | |
|---|---|
| Ledger append | ≤ **3 s** (`LEDGER_TIMEOUT_MS`) |
| Projection — search **and** every write | ≤ **12 s** (`PROJECTION_BUDGET_MS`, hard) |
| Body read, unseal, event build, render | **< 1 s** (no I/O) |
| **Worst case** | **≤ 16 s** |
| `maxDuration` | **30 s** |
| **Headroom** | **~14 s — nearly half the budget** |

These are not numbers chosen to sum to 30.

### One more defect found while fixing this

The first draft of the fix wrote `skipped = contacts.length - i` at the loop
break. A write already counted as unreached in the `catch` was then **overwritten**
by that tally, so `written + failed + skipped` no longer summed to `contacts` and
the page silently lost a contact — arithmetic that lies, on the page whose entire
job is to state the outcome truthfully. Now `+=`, with a test asserting the sum.

### Recorded, deliberately not fixed here

**`api/twilio-inbound.js`'s own `projectToHubSpot()` has the same unbounded
shape** — up to 100 contacts, each write at the 8 s default, no overall budget.
It is pre-existing merged code from [#20](https://github.com/tomytomz1/crystal-sells-toledo/pull/20)
answering TwiML to a machine rather than a page to a person, so the consequence
differs; it is **not** fixed here and this pull request is not widened to reach
it. **To be settled separately**, and it is the natural companion to configuring
webhook retry, since both concern what the webhook does when HubSpot is slow.

## 14. Explicitly not done

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
