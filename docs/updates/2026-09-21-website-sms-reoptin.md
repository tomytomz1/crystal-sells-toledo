# Automatic SMS re-opt-in after a fresh website consent

**Date** 21 September 2026
**Status** Implemented, tested, **not activated**. `SMS_REOPTIN_ENABLED` is unset
and `CONSENT_LEDGER_REOPTIN_URL` is unconfigured in every environment, and
`db/004_website_reoptin.sql` has not been applied to any database.
**Scope** Code, tests and documentation only. No deployment, no environment
variable, no Twilio configuration, no HubSpot record, no live SMS.

This document stands alone. It assumes no repository access and no memory of
earlier conversations.

---

## 1. What was wrong, and why it mattered

A consumer who replied `STOP` was suppressed permanently unless a human ran the
operator unsuppression workflow.

That was deliberate. `api/_lib/consent.mjs`'s `applyChannel()` treats a ticked
SMS box against a `REVOKED` or `SUPPRESSED` state as a **request**
(`pending_reoptin`), never as a grant, because anything else would let a
mass-mailed "update your details" link quietly resurrect every number that ever
sent `STOP`. A web form proves that somebody who knew an email address, a
property address and a phone number ticked a box. It does not prove they hold
the handset.

The cost of that correctness was real: a consumer who genuinely changed their
mind, returned to `/home-value`, read the full SMS disclosure again and ticked
the box again stayed suppressed, with no path back that did not require Crystal
to run a manual operator action.

## 2. The Twilio research, and what it actually establishes

**This was researched, not assumed, and the limits of the research are stated
because they matter.**

### 2.1 Advanced Opt-Out block list — no API

Twilio's Advanced Opt-Out documentation states that it *"does not support
changing or reporting on blocked phone numbers via the Console or the REST
API"*, that there is *"no API access for managing Advanced Opt-Out
configurations"*, and that it is *"only configurable via Console"*.

There is therefore **no supported first-party endpoint for removing a number
from a Messaging Service's Advanced Opt-Out block list**, and none is attempted
anywhere in this change.

Sources:

- <https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out>
- <https://help.twilio.com/articles/360034798533-Getting-Started-with-Advanced-Opt-Out-for-Messaging-Services>

### 2.2 The Consent Management API — real, and NOT relied on here

Twilio does publish a **Consent Management API** (Public Beta 2025, later
announced Generally Available and HIPAA-eligible) that accepts consent records
of the shape `{ contact_id, correlation_id, sender_id, status }` where `status`
is `opt-in` or `opt-out`, bulk-created up to 25 at a time. Twilio's
documentation describes restoring a user by writing **two** `opt-in` records —
one with the Messaging Service SID as `sender_id`, clearing the Messaging
Service level block, and one with the `From` phone number as `sender_id`,
clearing the Sender level block — after which *"Twilio's opt-out blocks are
lifted"*.

A separate changelog entry (12 August 2026) adds **network-level** opt-out
override, and that entry is scoped to **US and Canada Toll-Free** numbers.

Sources:

- <https://www.twilio.com/docs/messaging/features/consent-api>
- <https://www.twilio.com/en-us/changelog/Consent-Management-API-Beta-Launch>
- <https://www.twilio.com/en-us/changelog/consent-management-api-ga-and-hipaa-eligible>
- <https://www.twilio.com/en-us/changelog/consent-management-api-supports-tollfree-network-opt-out-override>

**Three reasons it is not used in this change, and they are stated as reasons
rather than as a verdict on the API:**

1. **The first-party pages could not be read directly.** The environment this
   work was done in blocks outbound access to `twilio.com` and `help.twilio.com`
   at the network policy level. Everything above comes from search-engine
   summaries quoting those pages. That is enough to know the API exists and
   roughly what it does; it is **not** enough to pin an exact request shape,
   authentication mode, error taxonomy or beta/GA status, and this repository's
   rule 18 forbids prose that outruns its evidence.
2. **It is absent from Twilio's own machine-readable contract.** Twilio's
   published OpenAPI specifications (`twilio/twilio-oai`, `spec/json/
   twilio_messaging_v1.json` and `_v2.json`) contain no `/Consents` path, and
   the generated `twilio-node` SDK exposes no consent resource. Both were read
   directly during this work.
3. **The documented network-level override is toll-free.** This site's sender is
   a **10DLC long code** in an approved A2P campaign, not a toll-free number, so
   the one part of the API with a dated, specific announcement does not describe
   our sender.

**Conclusion.** The Consent Management API is a credible future mechanism and is
recorded here so the next agent does not have to re-derive it. It is a
**follow-up**, named in §9, and implementing it against summaries rather than
the specification would be exactly the kind of guess this project has already
been hurt by.

### 2.3 What is used instead: the provider's own START

Under Advanced Opt-Out — **enabled** on this Messaging Service — Twilio
processes a `START`/`UNSTOP` from the handset, lifts **its own** block, and
sends the webhook an `OptOutType=START` field.

That is a first-party, provider-confirmed reconciliation that needs no API call
at all, and it is the mechanism this change uses. At the moment our clearance is
written, Twilio has already cleared its side.

## 3. What qualifies as a re-opt-in, and what does not

A suppression is lifted automatically **only** when all of the following are
true. Each is checked by a different layer, and any one failing leaves the
suppression exactly where it was.

### Qualifies

0. **All three switches are on** — `COMMUNICATIONS_CONSENT_ENABLED`,
   `SMS_REOPTIN_ENABLED` and `CONSENT_LEDGER_REOPTIN_URL`. The consent feature
   is the third because the HubSpot projection is skipped while it is off, so a
   clearance written then would open the durable lane and leave the CRM
   asserting a suppression — a half-applied transition nobody would see.
1. **A brand-new website submission** in which the SMS checkbox was explicitly
   `true`. The browser sends one JSON boolean and nothing else.
2. **The full current SMS disclosure was displayed.** The disclosure text,
   version and timestamp are attached **server-side** in
   `api/_lib/consent.mjs`; nothing that describes the consent came from the
   request.
3. **The consent evidence was acknowledged by the append-only ledger.** An
   unacknowledged append grants nothing, exactly as it grants no `cst_*`
   property today.
4. **The consent phone matches the suppressed phone.** The ledger row is keyed
   by `phone_e164`; the lookup asks about one number and the fold compares
   nothing else.
5. **The consent post-dates every refusal it would supersede**, strictly, on
   **both** clocks — event time (`occurred_at`) and ingest time
   (`recorded_at`) — across this lane **and** the dominating `all` lane.
6. **The consent is fresh** — at most **14 days** old, measured against the
   **database's** clock.
7. **The lane is `sms`.**
8. **Twilio itself classified an inbound message `OptOutType=START`** from that
   number, on a signature-verified webhook.

### Does not qualify

- **An unticked box.** It is not a revocation and not a request. Unchanged.
- **A ticked box alone.** It records a request and clears nothing. Unchanged.
- **A START alone.** It has always been recorded as a request, and still is.
- **A locally classified opt-in word.** `api/_lib/optout.mjs` recognises `optin`
  and `opt in`, which are **not** Twilio opt-in keywords. See §5 — this is the
  single most important refusal in the change.
- **A global do-not-contact.** "Remove me from your list" spoke about every
  channel; a ticked SMS box does not answer it. Only the human operator
  workflow may clear an `all` lane.
- **The `ai_voice` lane, ever.** A `START` is a messaging keyword. SMS and
  automated voice remain completely separate permissions.
- **`consent_not_selected`.** The record of *not* ticking is never read as a
  grant.
- **A consent row from any source but `website`.** Only a submission that
  displayed a disclosure can evidence agreement to one.
- **A stale consent**, a **future-dated** consent, or one that ties exactly with
  the refusal it would supersede.

## 4. Phone ownership — the abuse case, stated plainly

> A malicious person knows somebody else's email, property address and phone
> number. They submit the form and tick SMS consent.

**Website checkbox consent alone cannot establish phone ownership, and this
design does not pretend otherwise.** The forged submission writes a
`consent_selected` row and a `pending_reoptin` request, and **changes nothing
else**. Gate 8 still denies. The suppression still stands.

Ownership is established by the **signed Twilio `START` from that handset**, and
by nothing else. The attacker cannot send it; they do not hold the line.

**The residual risk, stated rather than glossed** (see §8): a forged submission
stays "armed" for up to 14 days. If the phone's owner independently texts
`START` to Crystal's number inside that window, the clearance completes and the
disclosure version recorded against it is the attacker's submission rather than
one the owner read.

What that does **not** create is unwanted contact: the owner sent `START` to
*this* sender, Twilio lifted *its* block on that basis, and resuming messages to
a handset that just asked for them is the intended behaviour of the keyword. The
harm is confined to which submission the evidence row points at. The 14-day
window is what bounds it.

**No additional verification was built**, and the reasoning is explicit: the
smallest sufficient additional evidence of phone ownership is a message sent
from the handset, and Twilio's own `START` already is one. Building a second
confirmation code path would be new infrastructure duplicating a provider
mechanism we already receive on a signed webhook.

## 5. The state transition

```
GRANTED
  └─ consumer replies STOP
       └─ api/twilio-inbound.js appends  suppressed / stop_keyword   (durable)
          HubSpot projects cst_sms_suppressed = true
SUPPRESSED
  └─ consumer returns to /home-value, reads the disclosure, ticks SMS, submits
       └─ api/lead.js appends  consent_selected  (durable, phone-keyed)
          HubSpot projects cst_reoptin_requested_at / _channel
          NO grant, NO suppression change
PENDING_REOPTIN          <- the STOP is still in force; Gate 8 still denies
  └─ consumer replies START from that same handset
       └─ Twilio lifts ITS OWN block and sends OptOutType=START
       └─ api/twilio-inbound.js appends  reoptin_requested           (durable)
       └─ api/_lib/reoptin.mjs reads db/004 get_reoptin_readiness():
            lane blocked?  fresh phone-matched website consent?  no `all` lane?
            ── any "no"  -> nothing happens, suppression stands
            ── all "yes" -> append  unsuppressed / consumer_request  (durable)
                            metadata names the consent row it rests on
       └─ only if that append inserted a NEW row (rowsAffected > 0):
            HubSpot projects cst_sms_suppressed = false
                          + cst_sms_permission_status = granted
                          + consent at / phone / version / source / page
GRANTED
  └─ Gate 8 permits: db/003's fold now returns no sms row for this number
```

**Ordering is load-bearing three times.** The durable record is written before
any projection; the reconciliation runs between the durable append and the
projection, so the CRM is written once from the settled state; and the clearance
is a **new append**, never a mutation — db/003 folds it as a lane clearance
exactly as it folds the human operator's.

### The one line that keeps our ledger and Twilio in agreement

The clearance triggers **only** on `decision.source === "twilio" &&
decision.rule === "opt_out_type_start"` — Twilio's own `OptOutType`, not our
classifier's.

Our deterministic layer (`api/_lib/optout.mjs`) recognises `optin` and `opt in`,
which Twilio does **not** act on. Clearing on one of those would leave our ledger
saying "allowed" while Twilio still refused the number: a send Gate 8 permits and
the provider drops. That split is the exact outcome this workflow exists to
prevent. `tools/check.mjs` fails the build if the narrowing is removed, and
`tests/reoptin.test.mjs` proves the guard fires.

## 6. What changed

### New

| Path | What it is |
|---|---|
| `db/004_website_reoptin.sql` | `get_reoptin_readiness(text, text, integer)` — one row, always. Reports each lane's earliest active block and the newest qualifying website consent. Plus the `consent_ledger_reoptin` role. **Not applied to any database.** |
| `api/_lib/reoptin.mjs` | Configuration, the bound readiness lookup, the pure eligibility decision, the clearance builder, the append. Sends nothing, grants nothing on its own. |
| `tests/reoptin.test.mjs` | 82 tests: the decision, the ledger contract, the lookup through the real Neon driver, the HubSpot projection, Gate 8 before and after, the webhook end to end, the time budget, and eleven static-guard mutation proofs. |
| `tests/reoptin-fold.test.mjs` | 25 tests of db/004 against a **real PostgreSQL 16**, including the full privilege matrix. |

### Changed

| Path | What changed |
|---|---|
| `api/_lib/consent-ledger.mjs` | The `unsuppressed` contract admits ONE automatic source under a fenced contract (§7). |
| `api/_lib/hubspot-consent-state.mjs` | `toHubSpotReoptinGrantProperties()` — clears the SMS suppression **and** writes the grant, in one patch. |
| `api/twilio-inbound.js` | `reconcileReoptin()` between the durable append and the projection. |
| `tools/check-base.mjs`, `tools/check.mjs`, `tools/check-sms-sender.mjs` | Static guards for db/004, the module, the ledger fence and the webhook trigger; the new credential added to the browser-secret list. |
| `src/partials/consent-block.html`, `src/pages/sms-consent-evidence.html` | One note telling a returning visitor to reply `START` as well. |
| `.env.example` | The two new names, documented as off. |
| `tests/suppression.test.mjs` | One pinned call-site string updated (see §7). |

**Nothing about SMS or AI-voice consent wording changed.** The versioned
disclosures are untouched; the new sentence is ordinary page copy outside them,
so it can be corrected without minting a consent version that existing contacts
already carry.

## 7. The contract that was narrowed, and the fence that replaced it

Before this change, `api/_lib/consent-ledger.mjs` refused **every**
`unsuppressed` row whose source was not `operator`: *"only a human may lift a
block"*. That rule bought something real — an inbound webhook could otherwise
lift the suppression a `STOP` had just created.

It is **narrowed, not deleted**. A `twilio` source is now admitted for an
`unsuppressed` row only when **all** of these hold, all checked before any
database call:

- the lane is `sms` — never `all`, never `ai_voice`;
- the reason is `consumer_request` — `recorded_in_error` stays operator-only,
  because deciding a record was wrong is a judgement about a record;
- `metadata.reoptin_confirmation` is `twilio_start`, from a closed vocabulary;
- `metadata.consent_dedupe_key` names a **website** `consent_selected` row **in
  the same lane**, in the `source:source_event_id:channel:event_type` form the
  ledger itself mints;
- `metadata.consent_occurred_at` is a valid instant.

Both the key and the timestamp are **canonicalised before storage**, for the same
reason `metadata.invalidates` already is: a value validated in one form and
stored in another makes the rule decorative.

**What the ledger module still does not check**, and does not pretend to: that
the named consent row exists, is fresh, or post-dates the refusal. That needs a
read it holds no privilege for. It is `get_reoptin_readiness` in db/004, and the
caller's duty.

## 8. Failure semantics — everything fails closed

| Failure | Result |
|---|---|
| `SMS_REOPTIN_ENABLED` unset or not exactly `"true"` | Nothing attempted; endpoint byte-equivalent to before |
| `COMMUNICATIONS_CONSENT_ENABLED` off | Nothing attempted — the HubSpot projection is skipped in that state, so a clearance would half-apply silently |
| `CONSENT_LEDGER_REOPTIN_URL` absent | Nothing attempted |
| Consent ledger append failed (website) | No durable consent; no re-opt-in is ever possible from it |
| Request-row append failed (webhook) | **503**, and the reconciliation never runs |
| Readiness lookup unavailable, timed out, or malformed | Suppression stands; 200; logged |
| Phone will not normalise | Never queried; suppression stands |
| Consent absent, stale, future-dated, wrong lane, wrong source, or tied with the refusal | Suppression stands |
| Global do-not-contact present | Refused outright |
| Clearance append failed | Nothing projected; durable state unchanged |
| Clearance append inserted 0 rows (replay) | Nothing projected — a replay created no transition *now* |
| HubSpot projection failed after a durable clearance | **Durable state remains authoritative**; logged; the CRM is a projection |

A timeout **aborts the socket** rather than racing a promise, so the query stops
when the caller does.

**The race that is not serialized, and why it is safe.** The readiness read and
the clearance append are two statements, not one transaction, so a `STOP` can
land between them and no application-level lock would change that. db/003's
existing fold resolves it toward the block, on either clock: a `STOP` **received
after** the `START` carries a later `occurred_at` than the clearance — whose
`occurred_at` is the `START`'s own receipt time — and a `STOP` **delivered late**
carries a later `recorded_at`. Either clause alone keeps the lane blocked, and
Gate 8 re-reads the fold immediately before any send regardless.
`tests/reoptin-fold.test.mjs` measures both directions against a real
PostgreSQL 16.

**The time budget.** The reconciliation runs inside the webhook's absolute 10 s
projection deadline, measured from handler entry, under a 15 s platform
`maxDuration` and Twilio's own ~15 s clock which starts before ours. It is not
started at all unless `REOPTIN_MIN_BUDGET_MS` (5 s) remains, and that constant is
exactly lookup (2 s) + append (2 s) + the projection's own `MIN_SEARCH_MS` (1 s)
— so whenever this path runs, a searchable projection budget provably survives
it. `tests/reoptin.test.mjs` asserts the inequality rather than trusting the
comment.

## 9. What is explicitly NOT done

- **Nothing is activated.** The flag is off, the credential is unconfigured, and
  `db/004` has not been applied anywhere.
- **No Twilio Consent Management API integration.** §2.2 — a named follow-up,
  blocked on reading the first-party specification directly.
- **No AI-voice re-opt-in.** There is no voice ingress at all.
- **No change to the operator workflow.** `api/operator-unsuppress.js` is
  untouched and remains the only path that can clear an `ai_voice` or `all` lane
  or record a `recorded_in_error` correction. It is the documented fallback.
- **No change to `TWILIO_AUTH_TOKEN` signature verification.**
- **No second outbound SMS path.** This change adds a ledger append and a CRM
  patch and cannot send anything.
- **Order B is not supported.** A visitor who texts `START` *before* submitting
  the form is not reconciled by that earlier `START`; they text it again after
  submitting, which the form's new note tells them to do. Supporting it would
  need a second read on the lead path and a second credential there. Deliberate,
  and fail-closed.

## 10. What is UNPROVEN

**Stated as unproven, not softened.**

- **Nothing in this change has run in production.** Tests passing is not
  production working.
- **`db/004` has never been applied to Neon.** It has been applied to, and
  exercised against, a real PostgreSQL 16 cluster in CI and locally. Neon is not
  that cluster.
- **The Twilio documentation in §2 was read through search-engine summaries, not
  from the first-party pages**, because this environment blocks `twilio.com`.
  The OpenAPI and SDK observations in §2.2 *were* read directly.
- **`OptOutType=START` arriving on the live webhook is inferred from Gate 7's
  `OptOutType=STOP` evidence and from Advanced Opt-Out being enabled.** A real
  `START` has reached the handset as a Twilio confirmation; that it also arrives
  on *our* webhook carrying `OptOutType=START` has not been observed in a
  production log.
- **That Twilio's own block is lifted by a `START` is Twilio's documented
  behaviour**, not something this project has measured end to end against a
  10DLC sender.

## 11. Production verification steps, after merge

In order. Do not skip step 1, and do not enable the flag before step 4.

1. **Apply `db/004` to Neon as the table owner**, substituting
   `<reoptin_role>` / `<reoptin_password>`. Then run **every** check in the
   migration's §4: `prosecdef`/`proconfig`, the ACL, all nine refusals, and both
   successes. Clean up test rows as the owner only.
2. **Configure `CONSENT_LEDGER_REOPTIN_URL` in Production** on that role.
   **Leave `SMS_REOPTIN_ENABLED` unset.** Confirm the endpoint still behaves as
   before: a `START` logs `twilio.inbound.reoptin_skipped` with
   `reason: "disabled"`.
3. **Prove the credential from the deployed application**, not from a console —
   the Gate 8 precedent. Confirm the role can call
   `get_reoptin_readiness` and is refused the table, `get_active_blocks` and
   `get_suppression_state`.
4. **Set `SMS_REOPTIN_ENABLED=true`** with the disable path immediately
   available.
5. **Run the controlled exercise on a controlled number**, capturing evidence at
   every step:
   1. fresh `/home-value` submission with SMS consent ticked → SMS acknowledgement
      received;
   2. reply `STOP` from the handset → Twilio confirmation received, Neon
      suppression appended, `cst_sms_suppressed=true`;
   3. **confirm no further SMS can be sent** — Gate 8 denies;
   4. fresh `/home-value` submission with SMS consent ticked again → `cst_reoptin_requested_at`
      set, `cst_sms_suppressed` **still true**, Gate 8 **still denies**;
   5. reply `START` from the **same** handset → Twilio confirmation received;
   6. read the function logs for `twilio.inbound.reoptin_cleared`;
   7. read Neon **as the owner**: the original `suppressed` row is **still
      present**, and a new `unsuppressed`/`consumer_request` row sits beside it
      whose `metadata.consent_dedupe_key` names the step-4 submission;
   8. read HubSpot: `cst_sms_suppressed=false`, `cst_sms_permission_status=granted`,
      consent timestamp/phone/version matching step 4, `cst_reoptin_requested_at`
      **still recorded**, and **no** `cst_ai_voice_*` or `cst_do_not_*` change;
   9. confirm a subsequent acknowledgement SMS is delivered — the provider agrees.
6. **Replay check**: re-deliver the same `START` webhook (or confirm from logs if
   Twilio retries). Expect `twilio.inbound.reoptin_replay` with
   `rows_affected: 0` and **no** HubSpot write.
7. **Negative check on a different controlled number**: `START` with no fresh
   consent → `twilio.inbound.reoptin_declined` with `NO_FRESH_CONSENT`, and the
   suppression stands.
8. **Update `docs/CURRENT-STATE.md`** with what was actually observed, and post a
   PULSE HANDOFF. Until then, this document's §10 stands.
