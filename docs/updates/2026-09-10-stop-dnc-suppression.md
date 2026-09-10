# Gate 7 — STOP / DNC suppression, as built

**10 September 2026.** Implementation of the design settled in
`docs/updates/2026-09-10-stop-dnc-suppression-decision.md`.

Assume no repository access and no memory of previous conversations.

**Nothing here is active.** The endpoint exists, is tested and is deployed with
the rest of the site, but no Twilio number points at it, `TWILIO_AUTH_TOKEN` is
set nowhere, and migration `002` has not been applied. With the token absent the
endpoint answers 503 to everything and reads no request body at all.

## What was built

| Piece | Where |
|---|---|
| Inbound webhook | `api/twilio-inbound.js` |
| Signature verification, URL reconstruction, form decoding | `api/_lib/twilio.mjs` |
| Deterministic opt-out classification | `api/_lib/optout.mjs` |
| Suppression ledger events | `api/_lib/consent-ledger.mjs` (extended) |
| HubSpot projection — schema mapping | `api/_lib/hubspot-consent-state.mjs` (extended) |
| HubSpot projection — I/O | `api/_lib/hubspot.mjs` (extended) |
| Lookup function and sender role | `db/002_suppression_lookup.sql` |
| Static guards | `tools/check.mjs` |
| Tests | `tests/suppression.test.mjs` — 50 |

`db/001_communication_consent_events.sql` is **untouched**. The three columns
this phase writes — `reason_code`, `evidence_text`, `metadata` — were created
unused so that no migration would ever have to alter an append-only table.

## The order is the design

```
1. verify the signature      before ANY interpretation of the body
2. classify                  Twilio's OptOutType if present, else ours
3. append to the ledger      the durable record, and what enforcement reads
4. project into HubSpot      best-effort, for the operator's eyes
```

**Step 3 before step 4 is load-bearing.** Suppression is keyed to the phone
number and enforcement resolves against the ledger, so once step 3 succeeds the
suppression is already effective and a step 4 failure costs visibility, not
compliance. That is the only reason the endpoint may answer 200 when HubSpot
fails — and exactly why it must never answer 200 when the ledger fails.

Both orderings are pinned by static guards that were run against a deliberately
broken copy of the tree, not merely written.

## Response policy

| Situation | Response |
|---|---|
| No `TWILIO_AUTH_TOKEN` | **503** — nothing can be verified, so nothing is processed |
| Body oversize or unreadable | **400** |
| Signature missing, wrong, or URL unresolvable | **403**, nothing written |
| No `MessageSid` or no `From` | **400** — no idempotency key, or no number to suppress |
| Classified as nothing | **200**, no ledger event, logged for a human |
| `HELP` | **200**, no ledger event |
| Ledger not configured | **503** |
| Number will not normalise | **400** — no retry fixes it |
| Ledger append failed | **503**, so Twilio retries |
| Ledger appended, HubSpot failed | **200**, logged loudly |
| Everything succeeded | **200** |

A retry is safe by construction: the dedupe key is
`twilio:<MessageSid>:<channel>:<event_type>`, and the replay no-op was measured
against the live database earlier the same day rather than assumed.

## Classification

**Twilio's `OptOutType` wins where it is present.** `STOP` → `suppressed`;
`START` → `reoptin_requested`, never a grant; `HELP` → no ledger event at all.
Twilio's classification is a statement about what Twilio *actually did* to the
number, and re-deriving it from the body risks our record disagreeing with the
system doing the blocking.

**It will usually be absent.** `OptOutType` requires Advanced Opt-Out on the
Messaging Service, which is a configuration change, and Twilio configuration is
frozen while the TCR hold on error 30753 is open. So our own layer runs
whenever the parameter is missing, and the endpoint is correct either way.

### The local layer

Normalise (lowercase, NFKC, strip apostrophes, punctuation to spaces), then:

1. **whole-message keyword equality** — `stop`, `stopall`, `unsubscribe`,
   `cancel`, `end`, `quit`, `optout`, `opt out`; separately `start`/`unstop`/
   `yes` and `help`/`info`;
2. **ten intent-bearing patterns**, each binding a verb of stopping to an
   object of contacting, anchored at word boundaries;
3. **anything else is not an opt-out** and is logged for a human to read.

**No AI classifier**, so the behaviour can be read, tested and cited. **No
substring matching**, because `includes("stop")` classifies *"stop by the open
house on Sunday"* as an opt-out — which is not a conservative failure. It
silently destroys a live lead *and* writes a legal state the consumer never
asked for into a ledger that cannot delete it.

Twelve near-miss phrases are asserted **not** to classify, including *"stop by
the open house on Sunday"*, *"cancel my appointment please"*, *"can you call me
back?"*, *"quit my job last week"* and *"not interested"* on its own.

**A keyword produces `suppressed`; a phrase produces `revoked`.** Both deny
sending. One is a keyword or carrier action, the other a consumer withdrawing in
words, and recording them identically would lose the reason a future reader
needs.

**Channel-specific stays channel-specific.** *"stop calling me"* suppresses
voice and leaves SMS alone; *"stop texting me"* the reverse. Only an unambiguous
all-channel request (*"remove me from your list"*, *"stop contacting me"*)
escalates to global.

## What reaches the ledger

A suppression row differs from a consent row in two deliberate ways.

**`submission_id` is NULL**, along with `form_type`, `page_path` and both
consent-copy columns. A suppression is not about a form submission; it is about
a **number**. Correlation is by `phone_e164` and by the provider's own event id.

**`evidence_text` carries the consumer's exact words — for a suppression only.**
The message *is* the evidence of the opt-out, which is why it is stored. That
argument does not extend to a re-opt-in request or to *"what time is the
showing?"*, so neither writes a body, and an unclassified message writes no row
at all. Capped at 1 KB, truncated on byte boundaries without producing a broken
character, and it never reaches a log line — a static guard fails the build if
`params.Body` is passed to `log()`.

`source` is `twilio`, never `website`; `buildSuppressionEvent()` throws if asked
to write a suppression claiming to come from the website path.

## The HubSpot projection

Every contact holding the number is flagged. If three contacts share a handset
and one replies STOP, there is no defensible version in which two of them are
still contactable on it.

Matching is **best-effort by design**: contacts hold numbers in several formats,
so six variants of a US number are searched across `phone`, `mobilephone` and
`cst_sms_consent_phone`. A contact this misses is **still refused a send**,
because enforcement resolves by number. Under-matching costs operator
visibility, never compliance.

**The write only ever sets a flag true.** It never writes false, never clears a
timestamp, never clears a reason, and never touches a consent property. A test
sweeps every scope × trigger × prior-state combination and asserts that no input
produces a `false`, a blank or a cleared value.

**The earliest refusal stands.** A duplicate STOP against an already-suppressed
contact writes nothing at all.

**Internal reasons are mapped onto HubSpot's dropdowns explicitly**, as the
original schema comment demanded — `stop_keyword` / `natural_language` /
`manual` for SMS, `voice_request` / `natural_language` / `manual` for calls,
`consumer_request` / `manual` for global. A test asserts every produced value is
in the vocabulary HubSpot would accept.

**With the consent feature off, the projection is skipped entirely** and the
ledger row still stands. That keeps "feature off" meaning no `cst_*` property is
read or written anywhere, which is what makes off equivalent to today's
production.

## The lookup function — migration 002, not applied

Send-time enforcement (gate 8) must resolve suppression by number. The website
role holds `INSERT` and nothing else and cannot read the ledger back, and that
does not change.

`db/002_suppression_lookup.sql` adds a **`SECURITY DEFINER` function** and a
sender role holding `EXECUTE` on it and **no table privileges at all**. A view
the credential can `SELECT` is a view it can dump; a function that takes a
number can only answer about a number the caller already holds.

Two hardening steps are mandatory and are enforced by static guards, because
both are silent when missing:

- **`SET search_path = pg_catalog, public`** — without it a caller can shadow
  the table with an object in a schema they control and have it read with the
  owner's rights. The classic `SECURITY DEFINER` vulnerability.
- **`REVOKE EXECUTE … FROM PUBLIC`** — PostgreSQL grants `EXECUTE` on a new
  function to `PUBLIC` by default, so omitting it hands the function to every
  role, including the website's.

A third guard refuses any `GRANT` of a table privilege in that file.

The privilege behaviour was measured on a throwaway PostgreSQL 16 with `db/001`
applied verbatim, before the file was written: sender has no table privileges;
the function returns the row for a suppressed number and 0 rows for a clean one;
`SELECT`, `INSERT`, `UPDATE`, `DELETE` on the table all refused; `NULL` argument
returns nothing; and the **website's role is refused `EXECUTE`**.

## Static guards

Five new invariants in `tools/check.mjs`, each one a refactor could delete
without breaking any visible behaviour:

1. the signature is verified **before** the message is classified;
2. the ledger append happens **before** the HubSpot write;
3. `params.Body` never reaches `log()`;
4. `api/lead.js` never calls a suppression writer — the website path and the
   suppression path stay separate;
5. migration `002` keeps `SECURITY DEFINER`, the fixed `search_path`, the
   `REVOKE`, and grants the sender no table privilege.

`TWILIO_AUTH_TOKEN` joins the secret-name list checked against
client-delivered output.

**Each guard was run against a deliberately broken copy of the tree** and
confirmed to refuse it. The working tree is never mutated: the tests copy it to
a temporary directory and break the copy.

One of these guards caught a real bug in itself on first run. Matching
`classify(params)` as a bare string also matches the **function declaration**,
which sits above the handler — making the ordering comparison vacuous. It is the
same mistake the ledger append guard shipped with in September 2026. The guard
now matches `= classify(params)`, and a test asserts the bare form is not used.

## Tests

`tests/suppression.test.mjs` — **50 tests**, all passing. Nothing reaches a
database, Twilio or HubSpot: the ledger executor is injected and the signature
scheme is checked against a locally computed HMAC, which is the same arithmetic
Twilio performs.

Also passing, unchanged: `consent-ledger` (34), `consent`, `consent-state`,
`api`, `hubspot`, `mail` — **445 across the affected suites**, plus
`npm run check`.

`tests/consent-ledger.test.mjs` gained `db` to the list of directories its
throwaway tree copies, since `check.mjs` now reads `db/002`.

**Tests passing does not mean this works in production.** No Twilio request has
ever reached this endpoint. See below.

## What a human must still do

1. **Apply `db/002_suppression_lookup.sql`** as the table owner, replacing
   `<sender_role>` and `<sender_password>`, and run the verification block in
   its section 4 — including the two refusals that prove the separation
   (`consent_ledger_app` refused `EXECUTE`, the sender refused `SELECT`).
2. **Add `TWILIO_AUTH_TOKEN`** to Vercel. Until then the endpoint answers 503.
3. **Point a Twilio number's inbound webhook** at `POST /api/twilio-inbound` —
   **only once the TCR hold on error 30753 is resolved.** This is a Twilio
   configuration change and is frozen until then.
4. **Send a real STOP** from a number under your control and confirm: a
   `suppressed` row in the ledger with the right `phone_e164` and
   `evidence_text`, the `cst_sms_*` flags set on every matching contact, and a
   200 response.

## What is explicitly not done

- **Nothing is live.** No Twilio number points here; no token is set; migration
  `002` is not applied.
- **The sender does not exist.** Migration `002` creates the function and the
  role, and nothing calls either. Send-time enforcement is gate 8.
- **No unsuppression flow.** Clearing a suppression is a deliberate,
  human-initiated, auditable transition and is out of scope. A `START` records
  `reoptin_requested` and clears nothing.
- **No voice/Retell endpoint.** The classifier and the ledger handle
  `ai_voice` and `reason_code = voice_dnc`, but nothing receives a Retell
  webhook. The semantics are settled; the transport is not built.
- **No National DNC registry handling.** A separate obligation with its own
  exemptions; this repository makes no claim about it.
- **No rate limiting on the inbound endpoint.** Signature verification is the
  gate; an unsigned flood is refused at 403 but is not throttled.
- **`COMMUNICATIONS_CONSENT_ENABLED` remains absent from Production**, no SMS
  was sent, no call was placed, and no Twilio or Retell configuration was
  touched.
