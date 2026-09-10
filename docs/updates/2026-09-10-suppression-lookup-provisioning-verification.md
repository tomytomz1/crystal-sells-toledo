# Migration 002 as applied — the suppression lookup on live Neon

**10 September 2026.** `db/002_suppression_lookup.sql` was applied to the real
Neon `production` branch and verified there. This is the operator record: what
was run, as which credential, what came back, and what is still unproven.

Assume no repository access and no memory of previous conversations.

**This is a database change and a documentation change. Nothing else.** No
application code was modified, no environment variable was added anywhere, and
the website's behaviour is byte-identical to before. Twilio, Retell, HubSpot and
Vercel were not touched. The Twilio/TCR hold on **error 30753** was respected
throughout — no Brand, profile, campaign or Messaging Service change.

---

## 1. Why this had to happen, and why it is separate from gate 8

Send-time enforcement must be able to ask *"is this number suppressed?"*. The
website's ledger credential (`consent_ledger_app`) holds `INSERT` and **nothing
else, not even `SELECT`** — deliberately, so that a leaked `CONSENT_LEDGER_URL`
cannot enumerate every phone number and consent decision the ledger holds. That
grant is not being widened, and this migration does not widen it.

Instead, `002` adds a second, narrower path:

- **a `SECURITY DEFINER` function** that answers about **one number the caller
  already holds**, and
- **a sender role** holding `EXECUTE` on that function and **no table privilege
  at all**.

The distinction that motivates the whole design: *a view the sender can `SELECT`
is a view the sender can dump.* One query would return every suppressed number
in the system. A function taking a number can only answer about that number. It
does not stop a credential holder testing numbers one at a time; it removes the
bulk dump, which is the realistic leak.

**Applying `002` does not begin gate 8.** Nothing in `api/` calls the function,
and the sender credential is in no environment. The database is simply ready.

---

## 2. Which credential ran it, and why that is load-bearing

Applied as **`neondb_owner`** — the Neon branch owner, and the same credential
that applied `db/001`.

Not a convention. `SECURITY DEFINER` executes with the **function owner's**
rights, so the mechanism only works if the function is owned by the role that
owns `communication_consent_events`. Created as anything else, the function
either cannot read the table or reads it with the wrong rights, and the failure
is quiet.

`consent_ledger_app` ran none of this and its credential was never in the
session. The owner credential is not in Vercel and never becomes
`CONSENT_LEDGER_URL`.

| | |
|---|---|
| Neon project | `crystal-sells-toledo-consent-ledger` (standalone organisation, AWS US East 2) |
| Branch / database | `production` / `neondb` |
| Applying role | `neondb_owner` |
| Server | PostgreSQL 18.x |

---

## 3. What was applied

`db/002_suppression_lookup.sql` **§§1–3, byte-faithfully**, with only the file's
own two placeholders substituted:

| Placeholder | Value used |
|---|---|
| `<sender_role>` | **`consent_ledger_sender`** |
| `<sender_password>` | a freshly generated 32-character alphanumeric password — see the note below on where it actually lives |

Nothing else in those statements was altered. Section 4 of the file is a comment
block — guidance for the operator, not applied SQL — so it carries no
byte-fidelity requirement, and two of its statements were made safer before
running (§5).

Four statements, all successful:

```
CREATE ROLE consent_ledger_sender LOGIN PASSWORD '<redacted>';
CREATE FUNCTION get_suppression_state(p_phone text) ... ;
REVOKE EXECUTE ON FUNCTION get_suppression_state(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_suppression_state(text) TO consent_ledger_sender;
```

**Where the sender password actually lives.** The password was not recorded in
chat, GitHub, repository files, or handoffs. The operator stored it in a
password manager. **Neon also retains the credential in its platform vault and
can display it through the Connect panel.** So the password manager is not the
only copy, and **Neon console access to this project is equivalent to holding
the sender credential** — exactly as it already is for `consent_ledger_app`.
That belongs in the threat model rather than in a footnote. An earlier revision
of this document said the password was *"never recorded outside the operator's
password manager"*; that was false, and it is the same error an earlier revision
of `db/001`'s provisioning record made about the application credential.

**The role was created with SQL, not through Neon's "Roles" UI.** A role created
in the Neon console is made a member of `neon_superuser`, which would grant it
read, update and delete across the database — the exact opposite of what this
role is for, and it would look entirely normal on screen. This is the same trap
`db/001`'s provisioning avoided, and it was avoided again here for the same
reason.

`db/001_communication_consent_events.sql` was **not read, not re-run and not
altered.** No `ALTER TABLE`, no new index, no change to
`communication_consent_events`, and no change to `consent_ledger_app`'s grant.

---

## 4. The resulting contract

```
get_suppression_state(p_phone text)
  RETURNS TABLE (channel text, suppressed_at timestamptz)
  LANGUAGE sql  STABLE  SECURITY DEFINER
  SET search_path = pg_catalog, public
  owner: neondb_owner
```

One row per channel currently suppressed for that number, carrying the
**earliest** refusal — `min(occurred_at)` grouped by `channel`, over
`event_type IN ('suppressed','revoked')`. A later duplicate STOP does not
restart the clock. `revoked` counts alongside `suppressed`: one is a consumer
withdrawing in words, the other a keyword or carrier action, and reading only
one of them would let a withdrawal through.

**It returns no `reason_code`, and that is a correction rather than an
omission.** The design draft returned `min(occurred_at), min(reason_code)` —
two *independent* aggregates, which pair a timestamp from one row with a reason
from a different row. The sender does not need the reason: enforcement decides
allow/deny from the **presence** of a suppression, and the permission resolver
derives its own denial reason. A column that is not returned cannot be
mis-paired. If a future caller genuinely needs the reason it must come from the
earliest row itself — `DISTINCT ON (channel) … ORDER BY channel, occurred_at` —
never from a second `min()`.

Privileges, as they now stand:

| Role | On the function | On `communication_consent_events` |
|---|---|---|
| `neondb_owner` | owner | owner |
| `consent_ledger_sender` | `EXECUTE` | **nothing** |
| `consent_ledger_app` (the website) | **nothing** | `INSERT` only |
| `PUBLIC` | **revoked** | nothing |

The `REVOKE` from `PUBLIC` is mandatory and silent when missing: PostgreSQL
grants `EXECUTE` on a new function to `PUBLIC` by default, so omitting it hands
the function to every role in the database — the website's included.

The fixed `search_path` is mandatory for the same reason. Without it a caller
can create an object named `communication_consent_events` in a schema they
control, put it earlier in their own `search_path`, and have the function read
**that** with the owner's rights. It is the classic `SECURITY DEFINER`
vulnerability.

---

## 5. Two changes made to section 4 before running it

Section 4 is right about *what* to prove. Two of its statements were riskier
than the proof requires.

**The destructive refusals had no predicate.** `UPDATE … SET channel = 'x';` and
`DELETE FROM communication_consent_events;` would destroy the entire ledger in
exactly the scenario they exist to detect — a wrong grant. PostgreSQL checks
table privileges at executor start, **independent of the predicate**, so adding
a never-matching predicate preserves the proof completely: a role lacking the
privilege still raises `42501`, and a role wrongly holding it reports `UPDATE 0`
/ `DELETE 0`, which reveals the bad grant just as clearly. The `INSERT` was run
in the `INSERT … SELECT … WHERE false` form for the same reason, so an
unexpected success would leave no junk row.

**The mis-pairing regression writes two rows into an append-only ledger.** As
written it would have left two permanent synthetic rows asserting that a number
had opted out — a more misleading residue than the ledger's existing synthetic
*consent* rows, which say in their own text that they are not consent records.
**The operator ran it inside a transaction and rolled back**, which is better
than either option considered beforehand: the function was exercised against the
real table and the real data, and nothing was left behind.

The migration file was **not edited**. It should stay as the record of what was
applied; this section is the correction, exactly as `db/001`'s provisioning
record handled the same situation.

---

## 6. Verification actually performed — live, against the production branch

Every line below is a reading taken against the real database, not a test
result. Nothing here comes from the test suite.

**The objects and their hardening**, read as the owner from the catalogue:

| Check | Reading |
|---|---|
| function exists | `get_suppression_state(text)` |
| owner | `neondb_owner` |
| `prosecdef` (`SECURITY DEFINER`) | **true** |
| volatility | `STABLE` |
| `proconfig` (`search_path`) | **`pg_catalog, public`** — fixed, not null |
| `EXECUTE` for `PUBLIC` | **revoked** |
| `EXECUTE` for `consent_ledger_sender` | granted |
| `EXECUTE` for `consent_ledger_app` | **absent** |

**The sender role's powers:**

| Check | Reading |
|---|---|
| superuser | **no** |
| member of `neon_superuser` | **no** |
| `SELECT` / `INSERT` / `UPDATE` / `DELETE` / `TRUNCATE` on the ledger | **none of them** |

**Proven by attempt, under a real login — not under `SET ROLE`.** The sender
credential authenticated over TLS as itself and then:

| Attempt as `consent_ledger_sender` | Result |
|---|---|
| `get_suppression_state('<clean number>')` | **success, 0 rows** — the answer, not an error |
| `SELECT` on `communication_consent_events` | **refused** |
| `INSERT` on `communication_consent_events` | **refused** |
| `UPDATE` on `communication_consent_events` | **refused** |
| `DELETE` on `communication_consent_events` | **refused** |

A real login matters here. `SET ROLE` under the owner proves less, because the
owner already holds everything; and `db/001`'s provisioning found two Neon
traps in that path — `SET ROLE` is refused until the owner is granted membership
in the role, and the Neon SQL Editor keeps one session alive across Runs, so a
`SET ROLE` from an earlier Run is still in force. Anyone repeating these checks
in the editor should begin with `RESET ROLE;`.

**The website role was refused the function:**

| Attempt as `consent_ledger_app` | Result |
|---|---|
| `get_suppression_state('<any number>')` | **refused** |

That refusal is the point of the `REVOKE`. The website's credential can append
to the ledger and can learn nothing from it, before or after this migration.

**The mis-pairing regression, against the live function:**

| | |
|---|---|
| rows before | **8** |
| inserted | two `sms` rows on one number — `suppressed` at 2026-09-01 with reason `stop_keyword`, `revoked` at 2026-09-05 with reason `natural_language`, timestamp order deliberately the opposite of lexical reason order |
| rows inside the transaction | **10** |
| `get_suppression_state(<that number>)` | **one row: `sms` / `2026-09-01 00:00:00+00`** — the earliest, and **no reason column at all** |
| `ROLLBACK` | succeeded |
| rows after | **8** |

The buggy `min(occurred_at), min(reason_code)` form would have returned
`2026-09-01` paired with `natural_language` — the 2026-09-05 row's reason. The
applied function cannot: it does not return the column.

**`db/001` remains untouched.** The ledger holds the same **8** rows it held
before this session, all synthetic and all previously documented, and its grants
are unchanged.

### How this record was made

The SQL was run by the operator in the Neon console and with a database client;
the agent writing this document has no Neon access and executed none of it. The
readings above are the operator's, reported back and recorded here. The
repository-side facts — that `db/001` and `db/002` are byte-identical to
`origin/main`, and that `002`'s static guards still pass — were verified
directly.

---

## 7. What a human must still do

Unchanged from the Gate 7 as-built record except that its first item is now
done.

1. ~~Apply `db/002`.~~ **Done — this document.**
2. **Add `TWILIO_AUTH_TOKEN` to Vercel.** Until then `/api/twilio-inbound`
   answers 503 to everything and reads no request body. Not blocked by the TCR
   hold.
3. **Point a Twilio number's inbound webhook** at `POST /api/twilio-inbound` —
   **only once the TCR hold on error 30753 clears.** Frozen.
4. **Configure webhook retry** — same freeze, and a live-activation
   prerequisite rather than an optimisation. A 5xx does **not** by itself make
   Twilio redeliver an incoming-message webhook. Until retry is configured, a
   ledger outage during a real STOP loses the evidence permanently: Twilio still
   blocks the number, so the consumer is protected, but our record of why will
   not exist.
5. **Decide the operator-surfacing path** for unclassified inbound messages.
   Open by explicit decision, not oversight.
6. **Send a real STOP** from a number under your control and confirm the ledger
   row, the `cst_sms_*` flags on every matching contact, and a 200.

---

## 8. What is explicitly not done

- **Gate 8 has not begun.** Nothing in `api/` calls `get_suppression_state()`,
  and no send-time enforcement exists. The function and the role are inert.
- **The sender credential is in no environment.** Not Vercel Production, not
  Preview. It is **not** `CONSENT_LEDGER_URL`, which remains the website's
  `INSERT`-only credential, and the two must never converge. When gate 8 needs
  it, it gets its own variable name and its own scope decision.
- **No suppression row has ever been committed or persisted.** Two synthetic
  suppression rows were inserted inside the verification transaction and rolled
  back — `rows_before = 8`, `rows_after = 8`. Saying *"never written"* would be
  imprecise: the rows existed inside an uncommitted transaction and the function
  read them there, which is what made the regression a real measurement rather
  than a simulation. Nothing survived the `ROLLBACK`, and no Twilio request has
  ever reached the endpoint.
- **`db/001` was not changed**, and `communication_consent_events` gained no
  privilege for anybody.
- **No Twilio, Retell, HubSpot or Vercel change**, and no code change.
- **`COMMUNICATIONS_CONSENT_ENABLED` is still absent from Production.**
- **Gate 7 is not closed by this.** Its three open requirements — no voice
  ingress, no operator surfacing, no webhook retry — are untouched. This closed
  the database prerequisite, which was never one of them.

---

## 9. Still unproven — stated as unproven

- **The function has never been called by application code.** Every successful
  call was made by hand, by a database client. The driver
  `@neondatabase/serverless` has never invoked it, and its HTTP transport has
  never carried a `SELECT … FROM get_suppression_state(…)`.
- **The function has never returned a row for a real suppression.** The only row
  it has ever returned came from synthetic data inside a transaction that was
  rolled back. No real suppression exists to look up.
- **Gate 7 has never run.** No Twilio request has ever reached
  `/api/twilio-inbound`, and the URL reconstruction from forwarded headers has
  never met a real one — the single most likely first-contact failure.
- **Concurrency and scale are untested.** A single-row lookup on an index that
  holds eight rows says nothing about behaviour at volume.
- **Nothing about this proves the site works differently**, because nothing
  about the site changed.

**Applying and verifying a migration is not the same as a working feature.**
Every reading in §6 is real; none of them is a production send being correctly
refused, because no send-time enforcement exists to do the refusing.
