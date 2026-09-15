# Unsuppression and re-opt-in — decision

**15 September 2026. DESIGN ONLY. Nothing in this document is implemented.**

No code changed, no database changed, no production change, and no external
system was touched — Twilio, Retell, Vercel, HubSpot, Neon and DNS are all
untouched. No environment variable was added, removed or read.

This settles the deliberate, human-initiated unsuppression / re-opt-in workflow
that gate 7 deliberately left out and that
[the operator-surfacing decision §6.7](2026-09-10-unclassified-inbound-operator-surfacing-decision.md)
records as **required before gate 9**.

---

## 1. The problem, stated exactly

Today a suppression is a one-way door.

`api/twilio-inbound.js` and `api/operator-action.js` can write `suppressed` and
`revoked`. Nothing anywhere writes `unsuppressed`. `api/operator-action.js`
*deliberately cannot* — `tools/check.mjs` guard 7 refuses the source if it so
much as names `EVENT_TYPE.UNSUPPRESSED`, and a test asserts the string is absent
from the file. The ledger credential holds `INSERT` and nothing else.

That was the right trade for gate 7: suppressing too much is far safer than
communicating after an opt-out. It leaves four problems.

1. **A mistaken suppression is permanent.** The operator action is easy to use
   on purpose. A misread message, a mis-click, a forwarded email — and the only
   correction available is a database owner running SQL by hand, which is the
   exact workflow the operator action exists to remove.
2. **A genuine returning consumer cannot be served.** Someone who texts `START`,
   or rings Crystal and asks to be put back on, produces `reoptin_requested` and
   nothing else. There is no path from that request to a state where anything
   may be sent, even with a fresh, fully evidenced consent.
3. **The read is permanent by construction.** `db/002`'s
   `get_suppression_state()` folds `event_type IN ('suppressed','revoked')` and
   is blind to `unsuppressed`. Even if something wrote the event, send-time
   enforcement would never see it. **Unsuppression is therefore a read-semantics
   problem before it is a write problem.**
4. **Twilio holds its own lock**, and the repository's existing prose about that
   lock is now out of date (§8).

**This document decides the semantics. It does not build them.**

---

## 2. Existing invariants this design must not break

These are load-bearing and every decision below is checked against them.

| # | Invariant | Where it lives |
|---|---|---|
| 1 | Suppression is keyed to **`phone_e164`**, never to a HubSpot contact | `db/001`, `buildSuppressionEvent()` |
| 2 | The **append-only ledger is the system of record**; nothing may amend or delete a row | `db/001` grants — `INSERT` only |
| 3 | HubSpot `cst_*` properties are a **mutable current-state projection**, not history | `docs/CURRENT-STATE.md`, "Consent evidence architecture" |
| 4 | A website consent tick against a suppressed state **never clears the suppression** — it yields `pending_reoptin` | `applyChannel()` in `api/_lib/consent.mjs` |
| 5 | `START` / `UNSTOP` / `YES` / `OPT IN` produce **`reoptin_requested`** and grant nothing | `classifyInbound()` in `api/_lib/optout.mjs` |
| 6 | The HubSpot suppression writer **only ever sets a flag true**; it never writes `false`, never clears a timestamp or reason | `toHubSpotSuppressionProperties()` |
| 7 | `toHubSpotReoptinProperties()` records a **request** and grants nothing | `api/_lib/hubspot-consent-state.mjs` |
| 8 | The permission resolver is the **only** place that decides whether anything may be sent, and it checks suppression **before** consent | `api/_lib/permission.mjs` |
| 9 | The sender may ask about **one number** and can neither enumerate the ledger nor `SELECT` the table; `SECURITY DEFINER` + fixed `search_path` + `REVOKE … FROM PUBLIC` are mandatory | `db/002` |
| 10 | The website `INSERT`-only credential **must never gain read access** | `db/001` |
| 11 | A GET must never change state — link scanners and prefetchers issue unattended GETs | `api/operator-action.js`, `tools/check.mjs` guard 6 |
| 12 | No phone number, message body or operator note may reach a log line or a URL | `api/_lib/log.mjs`, `tools/check.mjs` |
| 13 | Gate 8 send-time enforcement **has not begun**; nothing calls `get_suppression_state()` | `docs/CURRENT-STATE.md` |

**Constraint 7 of the task brief is confirmed by reading the code, not
assumed.** `buildSuppressionEvent()`'s doc comment says *"`eventType` is
`suppressed`, `revoked` or `reoptin_requested`"*, and its implementation calls
`requireText(eventType)` — which accepts **any** non-empty string. So
`unsuppressed` is *reachable* today but *undocumented and unvalidated*. That is
not "already safely wired"; it is a gap (§12.1).

---

## 3. Options considered

### 3.1 What an unsuppression means

| Option | Description | Verdict |
|---|---|---|
| **A** | `unsuppressed` **restores the grant that existed before the suppression** | **Rejected.** It makes `START` a grant by two hops: STOP → START → operator clicks "restore" → the old grant is live again, with no fresh disclosure. It also resurrects a grant given by a possibly different holder of a reassigned number. This is precisely the indirect route the brief forbids. |
| **B** | `unsuppressed` **removes the block and nothing else** | **CHOSEN.** |
| **C** | `unsuppressed` removes the block **and** a separate, fresh, evidenced consent is required before anything sends | **CHOSEN — this is B plus an existing property, not a third option.** B already produces C, because the resolver checks consent independently. Naming it separately matters because it is the safety argument. |

### 3.2 Where the workflow lives

| Option | Verdict |
|---|---|
| Add an unsuppression scope to `api/operator-action.js` | **Rejected** — §7.1 |
| A new, separate endpoint with its own secret | **CHOSEN** |
| A HubSpot workflow or a CRM checkbox | **Rejected.** A CRM field edit is not evidence, has no attestation, and would make the ledger a follower of a mutable store. It also gives anyone with CRM access an unsuppression capability. |
| Database owner running SQL by hand | **Rejected as the standing answer** — it is what this design exists to remove. It remains the break-glass path. |

### 3.3 Read semantics

| Option | Verdict |
|---|---|
| Leave `db/002` and have the application filter out cleared suppressions after reading | **Rejected.** The application would need table reads the sender must never have, and it puts a second decider beside the resolver. |
| A new `unsuppressions` table | **Rejected.** A second table is a second truth and a second migration against a compliance store. The event vocabulary already has `unsuppressed`; the read is what is wrong. |
| **A future `db/003` that replaces the function body, same name, same signature, same return shape** | **CHOSEN** — §6 |

### 3.4 Twilio reconciliation

| Option | Verdict |
|---|---|
| Clear our lock and treat SMS as deliverable | **Rejected** — false, and §8 shows why. |
| Automatically call Twilio's Consent Management API as part of unsuppression | **Rejected for the first implementation** — §8.4. It asserts consent to our provider on our own initiative. |
| Clear our lock only; Twilio reconciliation is a **separate, explicit, later** operator step | **CHOSEN** |

---

## 4. The decisions

### 4.1 A — What "unsuppression" is

> **An `unsuppressed` event lifts a block. It never creates, restores or implies
> a consent grant.**

After an approved unsuppression the channel holds **no permission**. The
resolver's step 2/3 denial disappears; its step 4 denial (`NO_CONSENT`) remains.
Nothing can be sent until a **fresh, evidenced grant** is captured through the
ordinary consent path, with its own disclosure version and copy text.

**The two-key rule, which is the whole safety argument:**

> **Sending requires two independent keys: no active block, AND a live grant.
> Unsuppression turns exactly one of them.**

`START` therefore cannot become a grant by any route, direct or indirect. It
produces `reoptin_requested`; a human may act on that to turn the first key;
the second key can only be turned by an evidenced consent that records what the
person agreed to. Neither key alone sends anything.

**The permission status written on unsuppression is `never_granted`, never
`granted` and never `revoked`.** Three things follow, and the third is the one
that decided it:

- `never_granted` denies at the resolver with `NO_CONSENT`. Safe.
- It is a **current permission status**, not a historical claim. The history — a
  grant, a STOP, a withdrawal, a clearance — is in the ledger, which is the
  record that claims to be history. This document states that plainly because
  the enum's *name* invites the stronger reading, and the stronger reading would
  be false for someone who did once grant.

  **Corrected 15 September 2026, and the correction largely dissolves the
  tension.** The first draft wrote `never_granted` and said nothing about the
  five `cst_*_consent_*` artefacts beside it, which would have left a status of
  *"no permission"* sitting next to a consent timestamp, a consent phone and a
  disclosure version — an incoherent pair, and history parked in a
  current-state store. **Those five fields are now cleared with the status**
  (§10.3). `never_granted` alongside five empty fields is an unambiguous
  statement about **current permission**, which is what the property is for.
- `revoked` was considered and **rejected as a deadlock**. `applyChannel()`
  returns `pending_reoptin` — not a grant — whenever the prior status is
  `REVOKED` or `SUPPRESSED`. Writing `revoked` on unsuppression would mean a
  later, fully evidenced consent submission could never grant, and the number
  could never be served again by any path. That is not conservatism; it is a
  workflow that cannot complete.

### 4.2 B — What evidence is enough

| Signal | May produce | May produce `unsuppressed`? |
|---|---|---|
| `START` / `UNSTOP` / `YES` / `OPT IN` by SMS | `reoptin_requested` | **No.** Unchanged from gate 7 §2.4. |
| A new web form with the consent box ticked, against a suppressed state | `reoptin_requested` (today: `pending_reoptin`) | **No.** Invariant 4. |
| A spoken request during a call | `reoptin_requested`, recorded by the operator | **No, not on its own.** |
| **Crystal receives an explicit request from the consumer and acts on it** | `reoptin_requested` **and** `unsuppressed` | **Yes** — `reason_code = consumer_request`, with an attestation naming what she saw and when, and the consumer's verbatim words where she holds them. |
| **A suppression was recorded that should not have been** — whatever caused it | `unsuppressed` | **Yes** — `reason_code = recorded_in_error`, with a **mandatory** `error_origin`. No consumer request exists and none is claimed. |
| A number may have been reassigned | nothing | **No.** A suspicion is not a request. Only an affirmative request from the **current** holder reaches the row above. Reassignment-detection services remain explicitly out of scope, as in gate 7 §2.3. |

**The governing rule:**

> **No automatic path writes `unsuppressed`. Every `unsuppressed` event has a
> named human actor, one of exactly two reason codes, and a written
> attestation.**

A prior `reoptin_requested` is **not required** — the error case has none, and
requiring one would push the operator toward manufacturing a request that did
not happen. But the workflow records **which** of the two justifications
applies, and they are not interchangeable.

#### `recorded_in_error`, not `operator_error` — corrected 15 September 2026

The first draft named the second reason **`operator_error`**. That is wrong in
an append-only compliance record, and wrong twice over.

**It asserts a cause that may be false.** A suppression that should not exist
can arise from at least three origins, and the operator is only one of them:

| Origin | Example |
|---|---|
| **operator** | a misread message, a mis-click, the wrong scope chosen on the confirmation page |
| **classifier** | `api/_lib/optout.mjs`'s deterministic phrase matching firing on a message that was not an opt-out. Gate 7 §2.5 **chose** a bias toward suppressing and named the false positive an accepted cost — *"recoverable by an explicit human unsuppression"*. This is that recovery, and filing it under operator error would misattribute a designed trade-off to a person. |
| **system** | a mis-parsed webhook, a wrong number normalisation, a bad backfill, a replayed event — anything where neither a human nor the classifier judged wrongly but a row landed anyway |

**And it names the wrong person.** `operator_error` labels the one human in the
loop — the person *correcting* the problem — as the one who caused it, on a row
that can never be amended. **An append-only compliance record must not record
false provenance**, and a field that is right one time in three is a field that
records false provenance two times in three.

**Decision — a two-level model, and the second level is mandatory:**

- **`reason_code` stays a closed set of exactly two**, and both are
  **origin-neutral** about cause:

  | `reason_code` | Means |
  |---|---|
  | `consumer_request` | the consumer asked to come back, and a human acted on it |
  | `recorded_in_error` | **the suppression should not have been recorded.** It asserts nothing whatever about who or what caused it |

  Keeping `reason_code` two-valued keeps the compliance-level answer — *did they
  ask, or was it a mistake?* — readable by every future consumer without
  knowing a taxonomy of causes.

- **When `reason_code = recorded_in_error`, `metadata.error_origin` is
  MANDATORY**, from a closed set:

  `operator` · `classifier` · `system` · `undetermined`

  Mandatory, because an optional provenance field is where truth goes to die:
  the whole point is that the origin must be *stated*, and a blank is
  indistinguishable from an unasked question.

**`undetermined` is deliberate and is not an escape hatch.** The alternative is
forcing the operator to pick a cause she cannot actually establish — and a
plausible guess written into an unamendable compliance row is strictly worse
than a recorded *"this was not determined"*. It fails honest rather than fails
plausible, and it leaves the question visibly open for whoever reads the row.
Where she **can** establish the origin she must record it; `undetermined` is for
where she genuinely cannot, and the attestation says why.

**Both levels are required and neither substitutes for the other.**
`reason_code` answers the compliance question; `error_origin` answers the
diagnostic one; the attestation says what actually happened in words. A
classifier false positive recorded as `recorded_in_error` / `classifier` is
also the only way this system will ever surface that its phrase matching is
mis-firing.

#### Which suppression is being corrected

*"What exact suppression was this correcting?"* must be answerable years later,
and the first draft did not answer it at all.

An `unsuppressed` row carries a **`metadata.corrects` object**, built in three
layers by how well each is known. **No layer is ever guessed.**

| Field | Source | When present |
|---|---|---|
| `corrects.suppressed_at` | the **pre-append fold** — `get_suppression_state()` read **before** the append, for the lane being cleared | **always.** Machine-derived; never operator-supplied |
| `corrects.source`, `corrects.source_event_id`, `corrects.event_type` | **operator-supplied** — she holds the `MessageSid` from the notification email and the confirmation page she used | when known |
| `corrects.dedupe_key` | derived from the three fields above, matching the earlier row's own key (e.g. `twilio:<MessageSid>:sms:suppressed`) | **only when all three are present** |

**Absent, never fabricated.** Where the operator cannot identify the originating
event, the second and third layers are simply absent. A reconstructed
`dedupe_key` that points at no row is false provenance in a new costume, and a
partial reconstruction is worse than a gap because it looks authoritative.

**`corrects.provenance` records which of these are machine-derived and which
are asserted by the operator**, so a future reader never has to guess whether a
field came from a database read or from a human's recollection.

**This forces a read BEFORE the append, and that is an implementation
constraint, not a nicety.** After the append the lane is cleared and
`get_suppression_state()` no longer returns it, so `suppressed_at` is
unrecoverable from the fold. The endpoint therefore performs **two** reads:

> **read (pre-append) → append → read (post-append) → project**

The pre-read supplies `corrects.suppressed_at`; the post-read supplies the
resulting blocked set the page must show (§7.6). Doing the pre-read at GET time
instead would be wrong — the state can change between rendering and submitting.

**This is also the strongest justification for the `EXECUTE` grant in §6.4**:
without a read the event could not say what it corrected, and an unsuppression
that cannot name what it undid is not an audit record.

### 4.3 C — Who may perform it, and how

The decisions are in §7. In summary: **a separate endpoint, a separate secret, a
capability that is not minted online, a 24-hour scoped token, an explicit scope
with no default, a mandatory attestation, a last-four-digits confirmation, an
unselected reason code — plus a mandatory `error_origin` when that reason is
`recorded_in_error` — and a GET that still writes nothing.**

### 4.4 D — Channel scope

The decision is in §5. In summary: **an `unsuppressed` event clears exactly the
lane it names and nothing else.**

---

## 5. Event-folding semantics

### 5.1 Lanes

The ledger's `channel` column holds three values: `sms`, `ai_voice`, `all`.
Treat each as an **independent lane** with its own history. `all` is not a
shorthand for the other two; it is a third lane that **dominates** both.

Fold each lane separately:

| Event type in that lane | Effect on the lane |
|---|---|
| `suppressed` | lane becomes blocked |
| `revoked` | lane becomes blocked |
| `unsuppressed` | lane becomes unblocked |
| `reoptin_requested`, `consent_selected`, `consent_not_selected` | **no effect on blocking** |

Then project lanes onto channels:

```
SMS is blocked       ⟺  lane(sms) is blocked      OR  lane(all) is blocked
Voice is blocked     ⟺  lane(ai_voice) is blocked OR  lane(all) is blocked
```

`suppressed_at` for a blocked lane is the **earliest** blocking event of the
**current** blocked run — i.e. the earliest blocking event that is later than
the lane's most recent clearance. The earliest refusal is still the one that
matters; a duplicate STOP still does not restart the clock; but a clearance
starts a new run.

### 5.2 The three scenarios, resolved

**Scenario 1 — SMS STOP at t1, global DNC at t2, global unsuppression at t3.**

| Lane | Rows | State |
|---|---|---|
| `sms` | blocked t1 | **blocked** — never cleared |
| `all` | blocked t2, cleared t3 | unblocked |

SMS = blocked(sms) OR blocked(all) = **still blocked**, since t1.
Voice = blocked(ai_voice) OR blocked(all) = **unblocked**.

**Yes, the older SMS STOP is still active, and that is the point.** Clearing the
`all` lane clears the global do-not-contact and nothing else. A narrower,
independently-given SMS refusal is not collateral damage of a broader clearance.
To restore SMS the operator must also, deliberately and separately, clear the
`sms` lane.

**Scenario 2 — global DNC, later SMS-only unsuppression.**

| Lane | Rows | State |
|---|---|---|
| `all` | blocked | **blocked** |
| `sms` | cleared (no blocking rows) | unblocked |

SMS = false OR true = **still blocked by the global DNC.**

This is correct and it is an operator-experience trap: she will believe she has
fixed it. **The workflow must therefore show the resulting blocked set read back
from the ledger, and name what is still blocking** (§7.6). A design that gets
the algebra right and the page wrong is a design that misleads the only human in
the loop.

**Scenario 3 — independent SMS STOP and voice DNC, then one channel restored.**

Independent lanes, independent outcomes. Clearing `sms` leaves `ai_voice`
blocked; clearing `ai_voice` leaves `sms` blocked. No interaction.

### 5.3 Two fail-closed tie-breaks, both discovered while writing this

**Equal timestamps.** If a blocking event and a clearing event carry the
**identical** `occurred_at`, the **block wins**. The comparison is strictly
`>`, never `>=`. Ambiguity resolves toward less communication.

**Disagreeing clocks — the delayed-webhook hazard.** `occurred_at` is event
time; `recorded_at` is ingest time. A STOP webhook delayed or retried can land
*after* a clearance while carrying an *earlier* `occurred_at`. Folding on
`occurred_at` alone would silently discard a real, later-arriving opt-out.

> **A blocking event counts if it is later than the clearance by EITHER clock —
> `occurred_at` or `recorded_at`.**

This is not a hypothetical: `occurred_at` on a suppression row is server
**receipt** time and Twilio redelivery is a live-activation prerequisite, so
out-of-order arrival is a state the system is being built to expect.

**And the two clocks must be taken from the same row.** `max(occurred_at)`
alongside `max(recorded_at)` is exactly the independent-aggregate mis-pairing
`db/002`'s own comment records and corrects. The clearance row is selected with
`DISTINCT ON (channel)` and a deterministic `ORDER BY`, so both timestamps come
from one row.

---

## 6. E — `get_suppression_state()`, and the future `db/003`

**`db/002` is applied and is a historical migration artifact. It is not edited.**
A future `db/003` supersedes the function body and records why.

### 6.1 Contract

**Same name, same signature, same return shape.** `get_suppression_state(text)`
returning `(channel text, suppressed_at timestamptz)`.

Keeping the name means there is exactly one function and no chance of a caller
reaching the stale semantics. Keeping the shape means gate 8's contract does not
change. Nothing calls it today, so there is no compatibility burden — this is
the cheapest moment it will ever be corrected.

**It returns lanes, not channels.** The lane→channel dominance rule of §5.1 is
**not** put in SQL. `api/_lib/permission.mjs` is the only place that decides
whether anything may be sent, and pushing dominance into the database would
create a second decider in a different language with a different test story.
The SQL answers a fact; the resolver makes the decision.

### 6.2 Intended body

Illustrative, not final — it is SQL in a document and has been executed against
nothing (§13).

```sql
CREATE OR REPLACE FUNCTION get_suppression_state(p_phone text)
RETURNS TABLE (channel text, suppressed_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH last_clear AS (
    -- BOTH timestamps from ONE row. min()/max() as independent
    -- aggregates is the mis-pairing db/002 already paid for.
    SELECT DISTINCT ON (u.channel)
           u.channel,
           u.occurred_at AS cleared_at,
           u.recorded_at AS cleared_recorded_at
    FROM public.communication_consent_events u
    WHERE u.phone_e164 = p_phone
      AND u.event_type = 'unsuppressed'
    ORDER BY u.channel, u.occurred_at DESC, u.recorded_at DESC, u.event_id
  )
  SELECT e.channel,
         min(e.occurred_at) AS suppressed_at
  FROM public.communication_consent_events e
  LEFT JOIN last_clear c ON c.channel = e.channel
  WHERE e.phone_e164 = p_phone
    AND e.event_type IN ('suppressed', 'revoked')
    AND (c.channel IS NULL                        -- never cleared
         OR e.occurred_at > c.cleared_at          -- later by event time
         OR e.recorded_at > c.cleared_recorded_at)-- or later by ingest time
  GROUP BY e.channel;
$$;
```

`min(e.occurred_at)` is the only aggregate and no second column is returned
beside it, so the mis-pairing `db/002` corrected cannot reappear. **A
`reason_code` must still not be added to this result.**

### 6.3 Privileges — unchanged, and re-stated rather than assumed

`CREATE OR REPLACE FUNCTION` is documented to preserve the existing ACL, and
**that is exactly the kind of thing this repository does not take on trust.**
`db/003` must therefore:

- restate `SECURITY DEFINER` and `SET search_path = pg_catalog, public`
  explicitly in the new body — a replacement does **not** inherit them;
- **re-issue** `REVOKE EXECUTE … FROM PUBLIC` and `GRANT EXECUTE … TO
  <sender_role>` unconditionally, so the outcome does not depend on whether the
  ACL survived;
- add **no** table privilege to any role, ever;
- leave the website `INSERT`-only role with no read of any kind, including no
  `EXECUTE` on this function;
- re-verify afterwards, as `db/002` requires: `prosecdef = t`, `proconfig`
  containing the fixed `search_path`, the sender succeeding, the sender refused
  on `SELECT`/`INSERT`/`UPDATE`/`DELETE` against the table, and the website role
  refused on the function.

### 6.4 One new role, with its reason written beside it

`db/003` also creates **`consent_ledger_operator`**: `INSERT` on
`communication_consent_events` **plus** `EXECUTE` on `get_suppression_state`.
Connection string `CONSENT_LEDGER_OPERATOR_URL`, Production only, added by a
human and by no document.

**Why it must exist.** The unsuppression workflow has to read the fold **twice**
— once before the append, so the event can name the suppression it corrects
(§4.2), and once after, so the HubSpot projection is computed from the folded
ledger rather than from the operator's intent (§7.6, §9.2) — and append between
them. Neither existing role can do both: the website role has no read, and the
sender role has no `INSERT` and is reserved for gate 8.

#### The blast-radius claim, corrected 15 September 2026

The first draft said this role's powers were *"strictly smaller than the union of
the two existing roles' intended powers and adds no new kind of access."*
**That was inaccurate, and in the flattering direction.**

`{INSERT, EXECUTE}` is **exactly** that union, not a subset of it. And while it
adds no new *kind* of privilege — both already exist, separately — it creates
**the first credential that holds both at once**, so a single leaked string now
yields both. That is a real increase in **per-secret** blast radius, and it is
accepted deliberately rather than argued away.

**What a leaked `consent_ledger_operator` string could actually do:**

| | |
|---|---|
| Append arbitrary ledger rows — **including `unsuppressed`** | **Yes.** The grant model constrains no `event_type`; only application code does. **This is not new**: the existing website `INSERT` credential has exactly the same power today, for the same reason. What is new is a *second* string that has it. |
| Bypass the token, the 24-hour TTL, the attestation and the confirmation | **Yes**, by writing directly. Those controls guard the endpoint, not the grant. |
| Probe whether a number it already holds is suppressed | **Yes**, one number at a time. |
| Enumerate the ledger, or learn a number it does not already have | **No.** |
| `SELECT`, `UPDATE`, `DELETE`, `TRUNCATE`, any DDL | **No.** |
| Cause a message to be sent | **No.** The two-key rule holds: a forged `unsuppressed` row turns one key, and sending still requires a live evidenced grant this credential cannot create. |

That last row is the reason the accepted risk is bounded rather than open-ended.

#### A vs B — one credential or two

| | **A — one credential** (`INSERT` + `EXECUTE`) | **B — two credentials** held by the same endpoint |
|---|---|---|
| Secrets to provision and rotate | 1 | 2 |
| A **single** leaked string yields | both capabilities | one capability |
| A **compromised endpoint** yields | both | **both** — it holds both strings |
| Failure modes | one connection, one auth path | two of each; partial-configuration states (one present, one absent) become reachable and must be handled fail-closed |
| Reuses an existing credential? | no | only if it reuses `CONSENT_LEDGER_URL` (the **live lead path's** string) or the sender string reserved for gate 8 — **both rejected** |

**Decision: A, one credential.**

B's only real advantage is against a **partial** leak — one environment variable
exposed without the other. It does nothing against the case that actually
matters, a compromised endpoint, because the endpoint holds both strings either
way. Against that narrow benefit it sets two costs: a second secret to
provision, rotate and audit, and a new class of partial-configuration state.

And B's clean form requires **two new** credentials. Reusing
`CONSENT_LEDGER_URL` would couple the unsuppression surface to the **live lead
path** — one leak becoming a leak for both, and one rotation forcing the other —
and reusing the sender string would put a credential `docs/CURRENT-STATE.md`
records as *"in no environment until gate 8"* into a gate 7 endpoint. Both are
worse than the thing B is trying to fix.

**Preserved under either option, and non-negotiable:** no table `SELECT`, no
enumeration, no `UPDATE`, no `DELETE`, no `TRUNCATE`, the website role keeps no
read of any kind, the sender role keeps no write, `SECURITY DEFINER`, the fixed
`search_path`, and `REVOKE EXECUTE … FROM PUBLIC`.

#### Option C, recorded and deferred — and it is arguably stronger

**No `INSERT` at all.** Give the operator role `EXECUTE` on *two* functions — the
existing lookup, and a new `SECURITY DEFINER` append function that can insert
**only** `unsuppressed` rows — and **no table privilege whatsoever**. That is
strictly smaller than A or B, it removes the forged-row row from the table
above, and it would make *"this credential can only unsuppress"* a **database**
property rather than a code convention. `db/001`'s own heading — *"APPEND-ONLY
IS A DATABASE GRANT, NOT A CODE CONVENTION"* — is the argument for it, and it
would deliver rows-affected reporting (§12.2) for free.

**Not chosen now**, for one reason worth stating plainly: it moves the insert
statement and its column discipline out of `appendSuppressionEvents()` and into
SQL, creating a **second implementation** of a rule this repository keeps in one
place — and `SUPPRESSION_COLUMNS` and the function signature would then be free
to drift apart silently.

**It can be adopted later without revisiting a single decision in this
document**, because it only narrows a grant. Recorded as a sequenced option, not
as a gap.

### 6.5 Indexes

`communication_consent_events_phone_time_idx` on `(phone_e164, occurred_at
DESC)` already serves both the clearance lookup and the blocking scan. **No new
index is proposed.** Whether the planner actually uses it for this shape is
unverified and is on the implementation checklist (§12).

---

## 7. F/C — Operator workflow and security model

### 7.1 A separate endpoint, and why reuse would be a mistake

**Decision: a new `api/operator-unsuppress.js`. `api/operator-action.js` is not
touched.**

1. **Reuse would require deleting a guard that encodes a real invariant.**
   `tools/check.mjs` guard 7 refuses `api/operator-action.js` if it names
   `EVENT_TYPE.UNSUPPRESSED`, a mutation test proves the guard fires, and a
   second test asserts the string is absent from the source. Adding unsuppression
   there means removing all three. This repository has already paid three times
   for a guard loosened to let a change through, and the review section of
   `docs/WORKFLOW.md` names it as an attack. The guard is not in the way of this
   design — it is *describing* this design's most important boundary.
2. **The two surfaces have opposite risk direction.** §6.7 of the surfacing
   decision states the suppression endpoint's whole threat model as *"worst case
   of a stolen or replayed token: one number gets suppressed — the fail-safe
   direction."* That sentence stops being true the moment the same endpoint, the
   same secret and the same token format can also unsuppress.
3. **Separate secrets mean a stolen suppression token cannot unsuppress.** The
   new endpoint uses `OPERATOR_UNSUPPRESS_SECRET` with a **different HKDF info
   string**, so the two token families cannot be interchanged even if both
   secrets leaked.
4. **Separate credentials.** The suppression endpoint keeps
   `CONSENT_LEDGER_URL` (`INSERT`-only). The unsuppression endpoint uses
   `CONSENT_LEDGER_OPERATOR_URL` (§6.4).

The existing guard 7 stays exactly as it is, and a **new** guard asserts the
mirror invariant on the new file (§12.5).

### 7.2 The capability is not minted online

The suppression link arrives in a notification email because a message has just
arrived and the operator must act on it. **There is no equivalent trigger for an
unsuppression, and no automatic path may produce one.**

**Decision: no web surface mints an unsuppression token.** The token is minted by
an operator-run local tool (`tools/mint-unsuppress-token.mjs`, run off-platform,
holding `OPERATOR_UNSUPPRESS_SECRET` from the operator's own environment), which
prints one URL for one number and one scope. There is no
"give-me-an-unsuppression-capability" endpoint to attack, phish, or reach with a
stolen session.

The awkwardness is the feature. Suppression must be one click; unsuppression
must be a decision the operator went and made.

### 7.3 The token

| Field | Value |
|---|---|
| `v` | payload version — **a distinct namespace from the suppression token** |
| `aid` | **approval id**, minted here; the idempotency key (§10). Colon-free, because `dedupeKey()` refuses a colon |
| `p` | the consumer's number, E.164 |
| `scope` | `sms` \| `ai_voice` \| `all` — **bound into the seal**, so the POST cannot widen it |
| `iat` / `exp` | issued at; **expires after 24 hours** |

AES-256-GCM, base64url, exactly as the suppression token — **the URL carries
ciphertext and nothing else**, so no phone number reaches a request path, a
browser history, a referrer or a Vercel log. Invariant 12.

**24 hours, not 30 days.** The suppression token's 30-day life exists because a
message read late is still worth acting on. An unsuppression capability has no
such argument and every reason to be short-lived.

**Scope is sealed, not chosen at POST time.** The suppression flow deliberately
makes the operator *choose* the scope on the page, because only she can judge
what the consumer meant. Here the judgement happened when she minted the token;
sealing it means a replayed or altered POST cannot broaden a clearance from
`sms` to `all`.

### 7.4 What the POST must carry

GET renders and writes nothing — invariant 11, non-negotiable. POST requires
**all** of:

1. **the sealed token**, moved into the form body by the page, never the query
   string (the existing endpoint already refuses a token in the query string and
   the new one must too);
2. **an exact confirmation literal** the page emits;
3. **a mandatory attestation**, free text, **minimum length enforced**, naming
   what the operator saw and when. An empty or trivially short attestation is a
   400 that writes nothing;
4. **the last four digits of the number being cleared**, re-typed. The page
   displays the number — it must, so she can see what she is acting on, the same
   disclosure the sealed token already carries — and re-typing four digits is a
   cheap, scanner-proof guard against clearing the wrong line;
5. **the reason code**, `consumer_request` or `recorded_in_error`, presented as
   an unselected choice **with no default**. They are not interchangeable and the
   system must not guess;
6. **when the reason is `recorded_in_error`, an `error_origin`** — `operator`,
   `classifier`, `system` or `undetermined` — also unselected, also no default.
   A missing origin on an error correction is a 400 that writes nothing;
7. **optionally, the originating event's identifiers** (`source`,
   `source_event_id`) so the row can name the suppression it corrects (§4.2).
   Left blank they are **absent** from the event, never reconstructed.

### 7.5 What is deliberately *not* added

- **No two-person rule.** There is one operator. A control that cannot be
  satisfied is theatre, and theatre in a compliance workflow teaches people to
  route around controls.
- **No password or account.** The same reasoning as the suppression endpoint:
  one operator, a sealed capability, no session store to compromise.
- **No "unsuppress any number" endpoint.** Every token is one number, one scope,
  24 hours.
- **No automatic Twilio call** (§8.4).

### 7.6 The page must report the resulting state, not the intent

After the append, the endpoint calls `get_suppression_state()` on the
`consent_ledger_operator` credential and renders **the blocked set that is
actually left**, naming what is still blocking and why.

This is `CLAUDE.md` rule 15 applied to a workflow rather than a socket: the
outcome is what the exchange leaves behind, observed, not the action that was
believed to cause it. Scenario 2 of §5.2 is the case that makes it mandatory —
without it an operator clears `sms`, sees a success page, and reasonably
concludes the number is reachable while a global DNC still blocks it.

---

## 8. G — Twilio reconciliation

### 8.1 Research provenance — updated 15 September 2026

**The provider capabilities in §8.2 are VERIFIED.** An **independent review
against current official Twilio documentation** confirmed them. The first draft
of this section described them as unverified search-result summaries requiring
re-verification before anything relied on them; **for the four capability
statements below, that caveat no longer applies and has been withdrawn.**

**Two things remain true and are kept, because the distinction matters:**

1. **This session still could not fetch the pages.** `www.twilio.com` and
   `help.twilio.com` are blocked by this environment's network egress proxy, so
   nothing here is quoted from a page an agent in this session read. The
   verification is the independent review's, and is attributed to it rather than
   claimed as this document's own.
2. **The verification covers the four capability statements, not the API's
   surface detail.** The request shapes, field names, rate limits and timeouts
   in §8.3 came from search summaries and were **not** individually confirmed by
   that review. They are still to be checked against the live documentation and
   Console at implementation time.

That split is the whole of the correction: **capabilities — settled; wire-level
specifics — not yet.**

### 8.2 Verified provider behaviour

Confirmed by independent review against current official Twilio documentation:

1. **The Consent Management API supports re-opt-in.**
2. **A Messaging Service STOP can create opt-out records at BOTH levels** — a
   Messaging Service-level record **and** an individual sender-level record.
3. **API re-opt-in requires clearing or updating both relevant records.**
   Clearing one leaves the other blocking.
4. **A consumer `START`, or a configured opt-in keyword, can remove Twilio's
   block.**

Point 2 is the one that changed most: the first draft recorded *that* two
records must be cleared, and now records *why* — a single STOP can create both.

### 8.3 Surrounding detail, NOT covered by that verification

Still from search summaries, still to be confirmed at implementation time:

- a STOP-class keyword puts the number on a blocked list, and subsequent
  outbound messages fail asynchronously with **error 21610**;
- a consumer `START` must be sent **to the same sender ID** the `STOP` went to;
- the API's reported rate limit (≈100 requests/minute), its ≈3 s timeout, and
  fields including `contact_id`, `correlation_id`, `sender_id`, `status`,
  `source` and `date_of_consent`;
- that toll-free network-level opt-out overrides are handled separately.

**None of these changes a decision below.** They are recorded so the
implementation knows which statements it inherited as verified and which it must
still establish for itself.

### 8.4 What this changes, and what it must not

**A statement in the repository is stale, and this is now settled rather than
suspected.** The gate 7 decision document §2.4 says *"We cannot override Twilio.
Nothing we write makes a Twilio-blocked number deliverable again."* Independent
review against current official Twilio documentation confirms that is **no
longer accurate** (§8.2). A dated correction is added beside it; the original is
not edited.

**The capability existing does not make it ours to use casually. It sharpens the
governance question rather than answering it.** Writing an opt-in record to
Twilio is *asserting to our provider that we hold consent*. Doing that on our
own initiative, to clear a block the consumer created, would be a false
compliance statement to the carrier ecosystem — a worse failure than the one
this workflow exists to fix.

**Decisions:**

1. **Two separate locks.** Our ledger block and Twilio's opt-out record are
   independent. Clearing ours changes nothing about theirs.
2. **A consumer-originated `START` to the same sender clears Twilio's lock by
   itself.** Ours stays until a human unsuppresses. The asymmetry is deliberate
   and is unchanged from gate 7 §2.4.
3. **The first implementation calls no Twilio API.** Our lock only. Twilio
   reconciliation is a separate, later, separately-approved step with its own
   decision document.
4. **When it is built, it clears both records** — Messaging Service SID **and**
   `From` number. **Verified:** a Messaging Service STOP can create an opt-out
   record at *both* levels, and an API re-opt-in must clear or update **both**;
   clearing one leaves the other blocking. A reconciliation that handled only
   one would look successful and deliver nothing.
5. **Nothing in this system may state that SMS is deliverable until Twilio's own
   state has been read back and observed compatible.** Not inferred from a 200
   on our own write. The same observer-side rule as everywhere else here.
6. **Voice is unaffected.** Twilio's SMS opt-out list has no bearing on a voice
   DNC, and the two must not be conflated in the UI or in the record.

---

## 9. H — Failure semantics

Order of operations, unchanged in shape from the suppression path and for the
same reason — **evidence first, projection second** — with a **second read added
on 15 September 2026** because the event must be able to name what it corrected:

> **read the fold (pre-append)** → append `unsuppressed` → **read the fold
> (post-append)** → project to HubSpot → (later, separately, manually) Twilio.

The **pre**-read supplies `corrects.suppressed_at` (§4.2) and is unrecoverable
afterwards — once the lane is cleared the fold no longer returns it. The
**post**-read drives the projection and the resulting-state page (§7.6). A
failure of the **pre**-read is a 400 that appends nothing: an unsuppression that
cannot say what it undid is not an audit record, and proceeding without one
would trade the evidence for the convenience.

**The property that makes every failure below survivable:** *unsuppression never
grants*. A partially applied unsuppression cannot cause a message, because the
second key — a live, evidenced consent — is untouched by any of it.

| Failure | Behaviour |
|---|---|
| **Durable `unsuppressed` append fails** | Nothing else runs. HubSpot is **not** touched. **503**, page says *not cleared*. The block stands everywhere. |
| **Append succeeds, HubSpot projection fails** | The ledger records the clearance; the CRM still reads suppressed. **Send-time enforcement denies if EITHER source says blocked** (§10.1), so the number stays blocked until the projection is retried. The page says exactly that — a loud partial success, **never "done"**. |
| **Twilio remains blocked** | SMS still fails with 21610. Our page must say Twilio state is **unverified** and that SMS is not known to be deliverable. Voice is unaffected. |
| **Operator action times out** | Report which side of the append it died on. Before the append: nothing changed. After: the projection case above. Never report an outcome that was not observed. |
| **The event is retried** | `dedupe_key` is `UNIQUE` and the insert is `ON CONFLICT DO NOTHING`. The second attempt affects **0 rows**. |
| **The same approval submitted twice** | Same as above — and **the projection must not run on a 0-row insert.** See the hazard below. |
| **Two operators act concurrently** | One insert wins, the other no-ops on the same `dedupe_key`. Different approval ids produce two rows clearing the same lane: harmless, and both are recorded with their own attestations. |
| **One lane succeeds, another does not** | Each lane is its own row and its own outcome. Report **per lane**. Never report a global success when a lane failed, and always render the resulting blocked set. |

### 9.1 The replay-after-re-suppression hazard

Found while writing this, and it is the sharpest failure in the design.

> Unsuppress `sms` → the consumer later sends STOP again → the **old** approval
> URL is replayed.

The ledger is safe: the `dedupe_key` is unchanged, the insert affects 0 rows, no
second clearance is recorded, and the fold correctly leaves the lane blocked by
the new STOP. **But a naive implementation would still run the HubSpot
projection**, clearing `cst_sms_suppressed` for a number that is currently and
correctly suppressed — silently reopening exactly the door this workflow is
supposed to open only deliberately.

**Two independent defences, both required:**

1. **Project only on a genuine insert.** `appendSuppressionEvents()` currently
   returns `{ appended: true, events: rows.length }` — the **input** count, not
   rows affected; `runStatement()`'s result is discarded. It must report real
   rows-affected, and the unsuppression path must treat 0 as "already recorded,
   change nothing" (§12.2).
2. **Project from the folded state, never from the intent.** Because the
   projection is computed from `get_suppression_state()` *after* the append, a
   lane that is blocked again reads as blocked and the projection writes nothing
   that would clear it. This defence holds even if the first one is
   mis-implemented, which is why both are specified.

### 9.2 Why the projection is computed, not patched

HubSpot's suppression fields are **lossy relative to the ledger**. A global DNC
cascades in `toHubSpotSuppressionProperties()` and sets `cst_sms_suppressed =
true` even when no independent SMS STOP exists, so the CRM cannot distinguish
"blocked by its own STOP" from "blocked by the global cascade". The ledger can —
they are separate rows in separate lanes.

Therefore the unsuppression projection **recomputes the whole per-channel truth
from the folded ledger** and writes that, rather than blindly clearing the
fields named by the scope. Scenario 1 and scenario 2 of §5.2 both produce the
right CRM state only under this rule.

---

## 10. F — HubSpot current state

### 10.1 The send-time rule this feeds

> **Deny if EITHER the ledger or HubSpot says blocked.** A union, not a
> replacement.

Rationale, and it cuts both ways deliberately:

- a **stale or failed projection** leaves the number blocked rather than
  reachable — failure toward less communication, which is the stated default;
- a **hand-edited CRM flag** cannot unsuppress anything, because the ledger
  still blocks. Unsuppression stays a deliberate, evidenced, ledger-recorded act
  and does not become "untick a box in HubSpot";
- a hand-*set* CRM flag still blocks, which is what an operator would expect of
  a field named `cst_do_not_call`.

### 10.2 The projection, per lane

Computed from the post-append folded state (§9.2). `✔` = written, `—` = left
alone.

| Property | `sms` cleared and SMS now unblocked | `ai_voice` cleared and voice now unblocked | `all` cleared |
|---|---|---|---|
| `cst_sms_suppressed` | ✔ `"false"` | — | ✔ `"false"` **only if** the `sms` lane is also unblocked |
| `cst_sms_suppressed_at` | ✔ cleared to `""` | — | as above |
| `cst_sms_suppression_reason` | ✔ cleared to `""` | — | as above |
| `cst_sms_permission_status` | ✔ `never_granted` | — | as above |
| `cst_sms_consent_at` | ✔ cleared to `""` | — | as above |
| `cst_sms_consent_phone` | ✔ cleared to `""` | — | as above |
| `cst_sms_consent_source` | ✔ cleared to `""` | — | as above |
| `cst_sms_consent_page` | ✔ cleared to `""` | — | as above |
| `cst_sms_consent_copy_version` | ✔ cleared to `""` | — | as above |
| `cst_do_not_call` | — | ✔ `"false"` | ✔ **only if** the `ai_voice` lane is also unblocked |
| `cst_do_not_call_at` | — | ✔ cleared to `""` | as above |
| `cst_do_not_call_reason` | — | ✔ cleared to `""` | as above |
| `cst_ai_voice_permission_status` | — | ✔ `never_granted` | as above |
| `cst_ai_voice_consent_at` | — | ✔ cleared to `""` | as above |
| `cst_ai_voice_consent_phone` | — | ✔ cleared to `""` | as above |
| `cst_ai_voice_consent_source` | — | ✔ cleared to `""` | as above |
| `cst_ai_voice_consent_page` | — | ✔ cleared to `""` | as above |
| `cst_ai_voice_consent_copy_version` | — | ✔ cleared to `""` | as above |
| `cst_do_not_contact` | — | — | ✔ `"false"` |
| `cst_do_not_contact_at` | — | — | ✔ cleared to `""` |
| `cst_do_not_contact_reason` | — | — | ✔ cleared to `""` |
| `cst_reoptin_requested_at` | — | — | — |
| `cst_reoptin_requested_channel` | — | — | — |

**`cst_*_permission_status` must be written, or the unsuppression does not
work.** `fromHubSpotConsentProperties()` reads the channel status *and* the flag,
and takes the conservative reading. With the flag cleared it falls through to the
raw status — and if that still reads `suppressed`, the resolver denies at step 4
with `SMS_SUPPRESSED_STOP`. **Clearing the flags alone leaves a field combination
the existing parser still interprets as suppressed.** This is the single most
easily missed requirement in this document.

**`granted` is never written.** The unsuppression writer is the mirror of
`toHubSpotSuppressionProperties()`'s discipline: that one only ever sets a flag
*true* and never clears; this one only ever clears a block and sets
`never_granted`, and **has no code path to `granted` at all**. A static guard
enforces it (§12.5).

**The two `cst_reoptin_requested_*` properties are left untouched.** They neither
block nor grant; they record that someone asked. Clearing them would destroy the
operator's context and risk a mis-mapped enum write for no benefit. That they may
read as a stale request after a clearance is accepted and stated.

**Global partial clearance is the interesting column.** Clearing the `all` lane
writes `cst_do_not_contact = false` but leaves `cst_sms_suppressed = true` when
an independent SMS STOP is still in force — matching scenario 1 exactly, and the
reason the projection must be computed rather than patched.

### 10.3 The five consent artefacts are cleared with the status

**Decided 15 September 2026, correcting a gap in the first draft**, which wrote
`cst_*_permission_status = never_granted` and said nothing about the five
`cst_*_consent_*` fields beside it.

That silence would have produced this state, and it is not defensible:

```
cst_sms_permission_status  = never_granted      "we hold no permission"
cst_sms_consent_at         = 2026-03-01T…       "…granted on 1 March"
cst_sms_consent_phone      = +1419555…          "…for this number"
cst_sms_consent_copy_version = v2               "…under disclosure v2"
```

**Decision: when a channel actually becomes unblocked, all five of that
channel's consent artefacts are cleared to `""` alongside the status** —
`consent_at`, `consent_phone`, `consent_source`, `consent_page` and
`consent_copy_version`.

**Why, in the architecture's own terms.** `docs/CURRENT-STATE.md` is explicit:
the HubSpot `cst_*` properties are **current state**, the ledger is **history**.
A `consent_at` describing a grant that is no longer in force is a historical
fact stored in the current-state record — precisely the conflation the three-
record architecture exists to prevent, and the same class of error as leaving a
`suppressed` status behind a cleared flag.

**Nothing evidential is lost, and this is checkable rather than asserted.** The
original grant is in the ledger as a `consent_selected` row carrying
`consent_copy_version` **and** `consent_copy_text` — the full disclosure, which
HubSpot never held at all. The ledger is append-only and the application holds no
`UPDATE` or `DELETE`, so clearing a CRM projection cannot touch it. **The
evidence store keeps strictly more than the field being cleared.**

**Nothing downstream needs them.** Checked against the code rather than assumed:

- **The resolver never reads them after this.** `resolve()` returns
  `NO_CONSENT` at step 4 on a `never_granted` status and never reaches the
  `consent_phone` comparison at steps 5/6.
- **A later grant overwrites them wholesale.** `applyChannel()` on a fresh
  ticked submission returns a completely new channel object — `status`,
  `consent_at`, `consent_phone`, `consent_version`, `consent_source`,
  `consent_page` — so cleared fields are repopulated by the consent that
  actually applies.
- **On a submission with no new consent** `applyChannel()` spreads the prior
  channel unchanged, so cleared fields stay cleared. No path resurrects them.

**And leaving them is the actively dangerous option.** `fromHubSpotConsentProperties()`
returns `consent_phone`, `consent_at` and `consent_version` from those fields
regardless of status. Any future reader — gate 8, a HubSpot workflow, a report,
a list-building query — that looks at `cst_sms_consent_at` without also reading
the status would treat a dead grant as a live one. That is the exact mirror of
the suppression bug this document is fixing: **a field combination a reader
interprets as permission that is not there.** The two-key rule protects the
resolver; it does not protect a CRM view or a workflow someone builds later.

**Only when the channel actually becomes unblocked.** If the `sms` lane is
cleared but SMS remains blocked by the `all` lane, **nothing is written for
SMS** — not the status, not the artefacts. The whole projection follows the
folded state (§9.2), and the artefacts follow the status they sit beside.

**Cleared, not deleted, and only what changed is written.** The projection sets
these to the empty string, consistent with `toHubSpotDateTime()`'s existing
empty-string convention, and omits any field already empty — the same
"write only what changed" discipline the consent path already uses.

**Not relied upon:** whether HubSpot's own per-property history would retain the
previous values. It may; it has not been verified here, and no part of this
decision rests on it. The argument stands on the ledger alone.

#### The cost this makes concrete, stated rather than discovered later

Clearing the artefacts exposes a consequence the first draft never had to face,
and it is a real cost:

> A contact can hold a **live SMS grant** and *then* be blocked by a **global
> DNC**, because `toHubSpotSuppressionProperties()`'s global cascade sets
> `cst_sms_suppressed = true` and **does not touch
> `cst_sms_permission_status`** — which can still read `granted`, with the
> parser's conservative reading doing the blocking.
>
> Clear that `all` lane and SMS becomes unblocked. This projection then writes
> `never_granted` and empties the five artefacts — **destroying a grant the
> consumer never withdrew.**

**That is intended, and it is not softened even for `recorded_in_error`.**

Restoring the grant in the error case is option A from §3.1 arriving through the
back door, and it would arrive on the **weakest evidence in the whole design** —
an operator self-certifying that a suppression was a mistake. The two-key rule
does not admit exceptions for the cases where the person turning the key is also
the person attesting that it should be turned.

**So the cost is: a suppression recorded in error, once cleared, also costs the
consumer's prior grant, and re-consent is required before anything can be sent.**
That is one lost lead and one conversation, against the alternative of a route by
which a self-attested mistake resurrects a permission. Priced deliberately, and
the operator runbook (§16, step 8) must say so in plain words, because an
operator who does not know this will be surprised by it.

**The grant itself is not lost as evidence** — the `consent_selected` row, with
its disclosure version and full copy text, is in the ledger and cannot be
altered. What is lost is its *force*, which is exactly what an unsuppression is
not allowed to hand back.

---

## 11. I — Idempotency and evidence

### The `unsuppressed` event

| Column | Value |
|---|---|
| `occurred_at` | server receipt time of the approval |
| `channel` | the lane: `sms` \| `ai_voice` \| `all` |
| `event_type` | `unsuppressed` |
| `phone_e164` | from the sealed payload, normalised by the existing `toE164()` — fails closed |
| `source` | **`operator`** (`SOURCE_OPERATOR`) — a human did this, and no other source may |
| `source_event_id` | the **approval id** minted with the token. **Not** a `MessageSid`: there may be no message. Colon-free |
| `dedupe_key` | `operator:<approval_id>:<channel>:unsuppressed`, via the existing `dedupeKey()` |
| `reason_code` | `consumer_request` \| `recorded_in_error` — a **new closed vocabulary**, `UNSUPPRESSION_REASON`. Both are **origin-neutral**; neither asserts a cause (§4.2) |
| `evidence_text` | the consumer's **verbatim words**, only when the operator holds them; otherwise `NULL`. **Never the operator's prose** |
| `metadata` | `{ approval_id, approved_by: "operator", entered_via: "operator_unsuppress", token_v, attestation, request_channel, request_observed_at, prior_blocked_lanes, twilio_reconciled: false }`, plus **`error_origin`** (mandatory when `reason_code = recorded_in_error`: `operator` \| `classifier` \| `system` \| `undetermined`) and **`corrects`** (`{ suppressed_at, source?, source_event_id?, event_type?, dedupe_key?, provenance }` — §4.2; absent layers are absent, never fabricated) |
| `submission_id`, `form_type`, `page_path`, `consent_copy_*` | `NULL` — an unsuppression is about a number, not a submission, and it agrees to no disclosure |

**The years-later question — *"why did this number become eligible to
communicate with again?"* — is answered by five fields together:**
`reason_code` (which of exactly two justifications), `metadata.attestation` (the
operator's account of what she saw), `metadata.request_observed_at` (when),
`evidence_text` (the consumer's own words where they exist), and
`metadata.prior_blocked_lanes` (what was actually cleared). `occurred_at` and
`recorded_at` bound it in time, and the append-only grant means none of it can
be edited afterwards.

**`twilio_reconciled: false` is written deliberately.** It records, at the moment
of the decision, that our lock and Twilio's are separate and that only ours was
touched — so a later reader cannot mistake this event for a claim about
deliverability.

**PII discipline.** The attestation is operator free text: it is capped by the
existing `capEvidence()` rule, stored only in `metadata`, and **never logged**.
Log lines carry `{ approval_id, channel, reason_code, lanes_cleared, ms }` and no
phone number, no attestation, no consumer words. The number never appears in a
URL — it is inside the seal.

**The operator's note and the consumer's words stay in separate columns**, for
the reason the suppression path already records: `evidence_text` means *what the
consumer said*, and mixing operator prose into it corrupts the one field whose
value depends on being verbatim.

---

## 12. Required future code and database changes

None of this is done. It is the implementation contract.

### 12.1 `api/_lib/consent-ledger.mjs`

- **Validate `event_type` and `channel` against closed vocabularies** in
  `buildSuppressionEvent()`, failing closed. Today `requireText()` accepts any
  non-empty string, so a typo'd event type would be inserted and then be
  invisible to every fold — a silent, permanent, unfixable row in an append-only
  table. **This is a real gap that exists today**, independent of unsuppression.
- **Widen the documented contract** to name `unsuppressed`, and say what it
  means. Constraint 7 of the brief is correct: the enum existing is not the
  same as the contract admitting it.
- Add **`UNSUPPRESSION_REASON`** (`consumer_request`, `recorded_in_error`) and
  **`UNSUPPRESSION_ERROR_ORIGIN`** (`operator`, `classifier`, `system`,
  `undetermined`) — in `api/_lib/consent.mjs` beside `SUPPRESSION_REASON`, which
  they parallel. Both closed and frozen; `error_origin` is **required** whenever
  the reason is `recorded_in_error` and the builder must fail closed without it.

### 12.2 Rows-affected reporting

`appendSuppressionEvents()` must return **real rows affected**, not the input
count. `runStatement()` currently discards its result. Without this the
unsuppression path cannot tell a genuine clearance from a replay, and §9.1's
first defence does not exist.

### 12.3 `api/_lib/hubspot-consent-state.mjs`

- A new **unsuppression projection writer**, the mirror of
  `toHubSpotSuppressionProperties()`. It clears blocks, writes
  `never_granted`, and **clears all five `cst_*_consent_*` artefacts for any
  channel that actually becomes unblocked** (§10.3). It has **no code path to
  `granted`**, and writes nothing for a channel that stays blocked.
- It takes the **folded state**, not a scope, so it cannot be driven from intent.

### 12.4 `api/_lib/permission.mjs`

- A new **pure** function `suppressionFromLedgerRows(rows)` turning lane rows
  into the `state.suppression` shape the resolver already consumes, applying the
  `all`-dominates rule of §5.1. Pure, no I/O, no mutation.
- The resolver itself is **unchanged**. Its precedence order already produces
  the two-key rule.
- `applySuppression()` gains **no** inverse. Nothing in this module clears
  anything; the comment saying so stays true.

### 12.5 New endpoint and new guards

- `api/operator-unsuppress.js` — GET renders, POST writes, the response boundary
  decides the connection exactly as the other two endpoints now do.
- `api/_lib/operator-token.mjs` gains a **separate token family** with its own
  secret and HKDF info string, or a sibling module does.
- `tools/check.mjs`:
  - **existing guard 7 stays exactly as it is** — `api/operator-action.js` must
    still be unable to name `EVENT_TYPE.UNSUPPRESSED`;
  - a **new guard**: the unsuppress endpoint may emit **only**
    `EVENT_TYPE.UNSUPPRESSED`, and `EVENT_TYPE.SUPPRESSED` / `REVOKED` /
    `CONSENT_SELECTED` must be unreachable from it;
  - a **new guard**: the unsuppress endpoint must contain no path writing
    `granted` to any `cst_*_permission_status`;
  - a **new guard**: the projection writer must never emit
    `permission_status = never_granted` without also clearing that channel's
    five `cst_*_consent_*` artefacts — the incoherent pair of §10.3 must be
    statically unreachable, not merely untested;
  - a **new guard**: its GET must not reach any write call — the mirror of guard
    6;
  - `OPERATOR_UNSUPPRESS_SECRET` and `CONSENT_LEDGER_OPERATOR_URL` added to
    `SECRET_NAMES`, so the build fails if either reaches a browser.

### 12.6 `db/003`

Per §6. New function body, new role, restated hardening, restated grants, and
its own verification block written in the same style as `db/001` and `db/002` —
**stating which credential runs which statement**, because that is the point of
the exercise.

### 12.7 Not code — the operator's minting tool

`tools/mint-unsuppress-token.mjs`, run off-platform. It must refuse to run
against a secret shorter than the existing minimum, print exactly one URL, and
never write a log file.

---

## 13. Tests and evidence the implementation will need

Tier 4. These are the claims that must be *proved*, not asserted.

**Folding — against a real PostgreSQL, not a mock** (`CLAUDE.md` rule 14: the
lowest practical real boundary, and for SQL semantics that is a real database):

1. suppressed, never cleared → blocked.
2. suppressed → unsuppressed → **not** blocked.
3. suppressed → unsuppressed → suppressed again → blocked, with
   `suppressed_at` = the **second** suppression.
4. `revoked` → unsuppressed → not blocked (`revoked` folds identically).
5. **Equal `occurred_at` on the block and the clearance → blocked.**
6. **A blocking row with an earlier `occurred_at` but a later `recorded_at` than
   the clearance → blocked.** The delayed-webhook case; it fails under any
   single-clock fold.
7. Two clearances in one lane → the most recent governs, and **both its
   timestamps come from the same row** (the `db/002` mis-pairing regression, in
   its new form).
8. Lane independence: clearing `sms` does not clear `ai_voice` or `all`.
9. Scenario 1, 2 and 3 of §5.2, each as an explicit test.
10. Privileges re-verified after `CREATE OR REPLACE`: `prosecdef`, `proconfig`,
    sender succeeds, sender refused on the table, website role refused on the
    function, `consent_ledger_operator` succeeds on both and is refused
    `SELECT`.

**Endpoint:**

11. GET writes nothing — the mirror of the existing scanner-safety test.
12. A POST missing the attestation, the last-four, the literal, or the reason is
    a 400 that writes nothing. One test per omission.
13. A suppression token presented to the unsuppress endpoint is refused, and the
    reverse. Proves the secrets and token families are genuinely separate.
14. An expired token renders a page and writes nothing.
15. **Replay after re-suppression writes nothing AND projects nothing** — §9.1,
    the sharpest case, and it needs both halves asserted.
16. The scope cannot be widened by the POST — a tampered body cannot turn a
    sealed `sms` into `all`.
17. The page renders the **resulting** blocked set, and names the still-blocking
    lane in scenario 2.

**Projection:**

18. Round-trip: the written properties, fed back through
    `fromHubSpotConsentProperties()`, yield a state the resolver does **not**
    deny for suppression. This is the only way to prove §10.2's central claim
    rather than assert it.
19. **The resolver still denies `NO_CONSENT`** after a successful unsuppression
    with no fresh grant. The two-key rule, asserted directly.
20. No path writes `granted`; a mutation that introduces one fails
    `npm run check`.
21. `cst_reoptin_requested_*` are untouched.
22. **All five `cst_*_consent_*` artefacts are cleared** for a channel that
    becomes unblocked — `consent_at`, `consent_phone`, `consent_source`,
    `consent_page`, `consent_copy_version` (§10.3).
23. **They are NOT cleared** for a channel that stays blocked by another lane —
    the scenario-2 shape. Clearing them there would be the mirror defect.
24. **The incoherent pair is unreachable**: no projection output contains
    `permission_status = never_granted` together with a non-empty `consent_at`,
    `consent_phone` or `consent_copy_version`. A mutation removing the artefact
    clearing must fail this.
25. **Nothing else reads the cleared fields.** A sweep over every reader of
    `consent_at` / `consent_phone` / `consent_version` confirming each one also
    reads the status, so a cleared field cannot strand a caller. This is the
    test that turns §10.3's argument into evidence.
26. **A fresh, evidenced consent after an unsuppression grants normally** and
    repopulates all five — the end-to-end proof that the correction did not
    deadlock the workflow the way `revoked` would have.

**Reason provenance and the correction reference:**

27. `reason_code` accepts **only** `consumer_request` and `recorded_in_error`;
    any other value fails closed.
28. **`recorded_in_error` without an `error_origin` is refused** and writes
    nothing. `error_origin` accepts only the four closed values.
29. `consumer_request` with an `error_origin` is refused — the field belongs to
    the error path only, and accepting it there would invite a meaningless
    origin on a consumer request.
30. **`corrects.suppressed_at` is captured from the PRE-append read**, and is
    present on every `unsuppressed` row. A test that appends first and reads
    after must fail to produce it — that ordering is the point.
31. **Absent layers are absent, not fabricated**: with no `source_event_id`
    supplied, the row carries no `corrects.dedupe_key` and no
    `corrects.source_event_id`, and `corrects.provenance` says so.

**Evidence:**

32. No phone number, attestation or consumer words in any log line.
33. No phone number in any URL.
34. `dedupe_key` shape, and idempotency under a genuine double submit.

---

## 14. What remains explicitly unproven

- **Every line of SQL in §6.2 has been executed against nothing.** It is a
  contract in a document. The folding, the tie-breaks, the `DISTINCT ON`
  pairing and the planner's index use are all unmeasured.
- **That `CREATE OR REPLACE FUNCTION` preserves the ACL** is a documented
  expectation, not a measurement taken here. `db/003` re-issues the grants so
  the outcome does not depend on it, and the verification block must confirm it.
- **Twilio, split as of 15 September 2026.** The four **capability** statements
  in §8.2 are **verified** by independent review against current official Twilio
  documentation and are no longer listed as unproven. What remains unproven is
  the **wire-level detail** in §8.3 — request shapes, field names, rate limits,
  timeouts, the 21610 behaviour and the same-sender `START` requirement — which
  came from search summaries and was not individually confirmed. Direct access
  to `www.twilio.com` and `help.twilio.com` is blocked by this environment's
  egress proxy, so no agent in this session read those pages; the verification
  is the reviewer's and is attributed to them.
- **That Twilio's two-record clear behaves end-to-end as described** is still
  unproven **in this system**: no call has been made, and the policy is that the
  first implementation makes none.
- **The externally supplied Twilio/TCR facts in §15 were supplied by the
  operator and are not independently verified from this environment.**
- **Nothing here has run.** Both gate 7 endpoints are inert, no operator row has
  ever been written to the ledger, and no unsuppression has ever occurred.
- **The operator-experience claims are untested** — that the page's rendering of
  a still-blocked lane actually prevents the scenario-2 misunderstanding is a
  claim about a human, and this document cannot prove it.

---

## 15. Activation-gate impact

**Gate 9** — *"controlled consent → send → STOP/DNC test passes"* — required this
decision before it could be attempted. **The decision now exists; the
implementation does not.** Gate 9 remains open, and now has a named dependency
rather than an undesigned hole.

**Gate 8** — send-time enforcement — is **unchanged in scope but changed in
contract**. It must consume `get_suppression_state()` with `db/003` semantics
and the union rule of §10.1. Building gate 8 against `db/002`'s semantics would
bake in permanent suppression. That is now written down before gate 8 starts,
which is the cheapest place it could have been caught.

**Gate 6 — the external correction, recorded as supplied and not verified here.**

The operator reports that on **12 September 2026** Twilio Support stated TCR had
allowlisted `crystal@crystalsellstoledo.com`, and instructed her to **delete the
failed Brand, create a new one, and submit it for review**. The previous
error-30753 / TCR allowlist hold is therefore **no longer the blocker**.

**Gate 6 is NOT closed.** The replacement registration is still pending, and as
of **15 September 2026** the Twilio Primary Compliance Profile requires Crystal
Saylor to complete **Persona identity verification with her ID** — an operator
action that is outstanding.

**Consequently, statements in the repository that Twilio configuration is
"frozen under the TCR hold" are stale.** They are corrected narrowly in
`docs/CURRENT-STATE.md`. **This document performed and simulated none of those
Twilio actions**, and none of the above was verified from this environment.

**No gate is closed by this document.** It is design.

---

## 16. Implementation plan for a future session

Strictly ordered; each step is independently reviewable and none of it begins
here.

1. **`db/003`** — the function body, the `consent_ledger_operator` role, the
   restated hardening and grants, and the verification block. Applied by the
   owner, off Vercel. Tests 1–10.
2. **Ledger hardening** — closed vocabularies in `buildSuppressionEvent()`,
   real rows-affected from `appendSuppressionEvents()`, and both new closed
   sets: `UNSUPPRESSION_REASON` and `UNSUPPRESSION_ERROR_ORIGIN`, with
   `error_origin` **required** on `recorded_in_error`. Tests 27–29.
   Independently valuable and a prerequisite for §9.1. *(Steps 1 and 2 are the
   only two that could be reordered; everything after depends on both.)*
3. **`suppressionFromLedgerRows()`** — the pure lane→channel fold, with
   scenarios 1–3 as tests. No endpoint yet.
4. **The unsuppression projection** — the HubSpot writer, computed from the
   folded state: clears the blocks, writes `never_granted`, **clears the five
   consent artefacts** (§10.3), writes nothing for a channel that stays blocked.
   Tests 18, 20–26 — which include the two guards forbidding `granted` and the
   incoherent pair.
5. **The token family** — separate secret, separate HKDF info, 24-hour TTL,
   sealed scope. Tests 13, 14, 16.
6. **`api/operator-unsuppress.js`** — GET/POST split, the **seven** POST
   requirements (§7.4), the **two** ledger reads in the order
   read → append → read → project, and the resulting-state page. Tests 11, 12,
   15, 17, 19, 27–34. New `tools/check.mjs` guards.
7. **`tools/mint-unsuppress-token.mjs`** — the off-platform minting tool.
8. **Operator runbook**, in `docs/`: when to unsuppress, what an attestation
   must contain, and the explicit statement that clearing our lock does not make
   SMS deliverable.
9. **Twilio reconciliation** — its own decision document, its own approval, not
   folded into any step above.

**Everything from step 1 to step 8 leaves both endpoints inert and production
unchanged.** Nothing sends until gate 8 exists, and gate 8 needs a live grant
that none of this creates.

---

## 17. Adversarial review

Performed as the repository requires — the subject is compliance, suppression
and security even though the deliverable is prose. The full diff was re-read
cold against `CLAUDE.md`, `docs/CURRENT-STATE.md`, `docs/WORKFLOW.md` and the
modules the design touches.

### The second pass — a correction round on the merged-but-unmerged draft

**Four further corrections were made on 15 September 2026, after independent
review of the first version of this document** (PR #32 at `ce6d2e2`). They are
listed first because three of them corrected statements that were *wrong*, not
merely incomplete:

1. **The projection left history in a current-state store.** It wrote
   `permission_status = never_granted` and said nothing about the five
   `cst_*_consent_*` artefacts beside it. Now they are cleared with the status
   (§10.3) — and writing that section exposed a real cost the draft had never
   had to face: clearing an `all` lane can destroy a live SMS grant the consumer
   never withdrew. **Recorded and priced rather than softened.**
2. **`operator_error` recorded false provenance.** A suppression that should not
   exist can originate from the operator, the classifier or the system, and the
   draft's single reason code asserted a cause that is wrong about two-thirds of
   the time — while naming the person *correcting* the problem as its cause, on
   a row that can never be amended. Now `recorded_in_error` (origin-neutral)
   plus a **mandatory** closed `error_origin` (§4.2).
3. **The event could not say what it corrected.** *"What exact suppression was
   this correcting?"* had no answer at all. Now a three-layer `corrects` object,
   never guessed — which forced a **second ledger read, before the append**,
   because after it the fold no longer returns the cleared lane (§9).
4. **The `consent_ledger_operator` blast-radius claim was inaccurate in the
   flattering direction** — *"strictly smaller than the union"* when it is
   **exactly** the union, and is the first credential to hold both capabilities
   at once. Corrected, with an explicit A/B comparison, a chosen option, and a
   stronger option C recorded rather than quietly omitted (§6.4).

**Separately, the Twilio provenance was updated, not corrected**: independent
review verified the four capability statements against current official Twilio
documentation, so §8.2 no longer carries the unverified-search-summary caveat.
The **policy is unchanged** — the first implementation still calls no Twilio
API, and the two locks stay separate. The wire-level detail in §8.3 remains
unverified and says so.

**Correction-delta review of that round** found one further material item — the
grant-destruction consequence in §10.3, now stated — and two numbering slips in
test cross-references. No third pass.

### What the first review changed

Four things, all of them corrections to this document's own first draft:

1. **`revoked` as the post-unsuppression status was a deadlock.** The first
   draft chose it as the more truthful value, then checking it against
   `applyChannel()` showed that a `REVOKED` prior status yields `pending_reoptin`
   forever — so no subsequent consent could ever grant, and the workflow could
   never complete. Changed to `never_granted`, with the truthfulness caveat
   stated in §4.1 rather than hidden.
2. **The replay-after-re-suppression hazard was missing entirely** (§9.1), along
   with the fact that `appendSuppressionEvents()` cannot currently distinguish an
   insert from a no-op.
3. **The single-clock fold was wrong.** The first draft compared `occurred_at`
   only, which silently discards a delayed STOP webhook — a state this system is
   explicitly built to expect.
4. **"Proved for both endpoints"-style over-claiming about Twilio.** The first
   draft presented the Consent Management API findings as established. They come
   from search summaries of pages this environment cannot fetch, and §8.1 now
   says so before the findings rather than after.

### The two required questions

> **"If an independent compliance reviewer wanted to block this design, what
> would they point to?"**

**The attestation.** One person, acting alone, can lift a block on her own
written say-so, with no counter-signature and no artifact the consumer produced —
because `evidence_text` is optional and `recorded_in_error` has no consumer request
behind it at all. A reviewer would say: *your suppression path requires a
consumer action and your unsuppression path requires a sentence.*

That is the correct thing to point at, and the answer is not that it is safe —
it is that **it cannot by itself cause a message**. Unsuppression turns one of
two keys. TCPA exposure requires a send; a send requires a live evidenced grant
this workflow cannot create, and for SMS it additionally requires Twilio's own
state, which this workflow deliberately does not touch. The residual risk is a
block lifted without adequate justification, recorded permanently, with a named
actor and a dated attestation — which is discoverable in audit rather than
invisible. A two-person rule was considered and rejected in §7.5 for a
one-operator business; that rejection is the reviewable decision, and a reviewer
may reasonably disagree with it.

Second, a reviewer would point at **`never_granted` written for someone who did
once grant** (§4.1) — literally false read as history. The defence is that the
property is current state by architecture, the ledger is history, and the
alternative deadlocks; but the document must not pretend the tension is absent,
so §4.1 states it. **The 15 September correction narrows this considerably**:
with the five consent artefacts cleared alongside the status (§10.3), the CRM no
longer holds a dead grant's timestamp, number and disclosure version beside a
status that says there is no permission.

Third, and this is the sharpest thing left: **`error_origin` is asserted by the
same person whose own mistake is one of its four possible values.** Nothing
stops an operator recording `classifier` for what was in fact her own misreading.
The design's answer is not that this is prevented — it is that
`recorded_in_error` **does not depend on the origin being right**: the compliance
classification is origin-neutral, `error_origin` is a diagnostic beside it, and
the attestation says what happened in words. A reviewer may fairly say a
self-reported diagnostic is weak evidence, and they would be correct; it is
recorded as a diagnostic, not offered as proof.

Fourth: **the Twilio provenance**, now materially narrower (§8.1). The four
capability statements are verified by independent review; the wire-level detail
in §8.3 is not, and no agent in this session read the pages.

> **"What guarantee does the prose claim that the proposed implementation would
> still need to prove?"**

Seven, and §14 exists so none of them is smuggled:

- **that the folding SQL is correct** — it has run against nothing. The
  equal-timestamp tie-break and the delayed-webhook case are both reasoning, and
  tests 5 and 6 exist because reasoning is not evidence;
- **that `CREATE OR REPLACE` preserves the ACL** and that `SECURITY DEFINER` +
  `search_path` survive — documented expectation, unmeasured here;
- **that the projection leaves no field combination the parser reads as
  suppressed** — §10.2 argues it from the parser's source; only test 18's
  round-trip proves it;
- **that the projection cannot run on a replay** — it depends on a rows-affected
  report that does not exist yet;
- **that Twilio's two-record clear behaves end-to-end in this system** — the
  *capability* is verified (§8.2), but nothing here has exercised it, and the
  wire-level detail in §8.3 is still unconfirmed;
- **that the five cleared consent artefacts are genuinely not read anywhere
  else** — §10.3 argues it from `resolve()` and `applyChannel()`; only test 25's
  sweep proves no other reader exists;
- **that the resulting-state page actually prevents the scenario-2
  misunderstanding** — a claim about a human being, which no test settles.

### Lesson promotion — nothing promoted, with the reason

One candidate was considered seriously and **rejected**:

> *"A read over an append-only log must fold the whole event vocabulary,
> including event types nothing writes yet."*

It is reusable and it would have changed `db/002`. It is not promoted because
**`db/002` is not a defect.** It was correct for the vocabulary in use, its own
comments state that gate 8 had not begun, and it was applied as a deliberately
narrow contract. Promotion runs on **material findings that were corrected**, and
nothing here was corrected — this session wrote a design document and changed no
behaviour. Promoting a rule from a hypothetical would be exactly the
manufactured-lesson failure `docs/WORKFLOW.md` § Lesson promotion describes.

The insight is not lost: it is recorded in §1 and §6 of this document, where the
person who implements `db/003` will actually be reading.

`CLAUDE.md`, `docs/WORKFLOW.md` and `docs/ENGINEERING-LESSONS.md` are
**unchanged**.

### Repo-wide behavioural search

> **The shape:** *a place that could clear, weaken or bypass a suppression
> without a deliberate, evidenced, human-initiated act.*

Searched by reading every module that writes consent or suppression state and
every path that reaches one, rather than grepping `unsuppress`:

| Path | Finding |
|---|---|
| `applyChannel()` in `consent.mjs` | A tick against `REVOKED`/`SUPPRESSED` yields `pending_reoptin`. **Correct** — and §4.1's `never_granted` choice deliberately re-opens the grant path *after* a human clearance, which is the intended door. |
| `toHubSpotSuppressionProperties()` | Only ever sets flags true. **Correct.** |
| `fromHubSpotConsentProperties()` | Conservative reading; a flag can suppress but never un-suppress. **Correct.** |
| `applySuppression()` | Additive only; no inverse. **Correct.** |
| `api/operator-action.js` | Cannot emit `unsuppressed`; guard 7 + tests. **Correct, and preserved.** |
| `api/twilio-inbound.js` | `START` → `reoptin_requested` only. **Correct.** |
| `buildSuppressionEvent()` | **Gap** — accepts any `event_type` string. Not a bypass today (no caller passes one), but it is the one place where a wrong event type could enter an unamendable table. Recorded as §12.1, not fixed here. |
| `db/002` | Cannot under-report a suppression; only over-report. **Safe direction**, and the reason unsuppression needs `db/003`. |

**No path clears a suppression today.** The one gap found is a validation gap,
recorded and sequenced rather than fixed, because this change is design-only and
widening it would be exactly the reviewed-change-that-grew failure rule 17 names.

---

## 18. What this document does not do

No code, no migration, no test, no configuration. Both gate 7 endpoints remain
inert. `COMMUNICATIONS_CONSENT_ENABLED` remains off. No gate 8 work, no Twilio
activation, no Retell ingress, no HubSpot, Neon, Vercel or DNS change, no
environment variable, no live call of any kind, and nothing merged.
