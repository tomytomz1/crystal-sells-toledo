# Replay and idempotency, verified on the live consent ledger

**10 September 2026.** No code changed. This records what was measured.

Assume no repository access and no memory of previous conversations.

## What was unproven, and why it mattered

`appendConsentEvents()` sends one multi-row
`INSERT … ON CONFLICT DO NOTHING`, and the repository has claimed three
properties for it since the ledger was designed:

1. a fully duplicated replay inserts nothing and succeeds;
2. `DO NOTHING` is evaluated **per row**, so a replay against a ledger already
   holding one of the two rows no-ops that one and inserts the missing one;
3. a statement failure cannot half-write the two new rows.

All three were measured against a **throwaway local Postgres 16** with
`db/001_communication_consent_events.sql` applied verbatim. Against the live
Neon database, every append had inserted two fresh rows — **the clause had
never once met an actual conflict there.**

That mattered because property 2 is what stops a partial write becoming
permanent. If `DO NOTHING` were evaluated per statement rather than per row, a
retry against a half-written pair would insert nothing and the missing channel
event would be absent from the consent history forever. The difference between
a self-healing gap and a permanent one is invisible until it happens.

## Method, and why it was shaped this way

### What was rejected first

- **Resubmitting the Preview form.** Every submission mints a fresh
  `submission_id` server-side, so the dedupe keys differ and it would insert two
  *new* rows — testing nothing about replay while creating another real contact
  in the production CRM.
- **Deleting one of the real rows to manufacture a partial state.** Rejected
  outright. Mutating genuine evidence in order to test a property is the exact
  opposite of what an append-only ledger is for.

### Test 1 — full replay, against the real evidence

Run in the Neon SQL Editor as the **owner**:

```sql
INSERT INTO communication_consent_events
  (occurred_at, channel, event_type, phone_e164, source, source_event_id,
   dedupe_key, submission_id, form_type, page_path,
   consent_copy_version, consent_copy_text, schema_version)
SELECT
   occurred_at, channel, event_type, phone_e164, source, source_event_id,
   dedupe_key, submission_id, form_type, page_path,
   consent_copy_version, consent_copy_text, schema_version
FROM communication_consent_events
WHERE submission_id = 'csv_5845df0fd70f7f9991e179a5'
ON CONFLICT DO NOTHING;
```

Those are exactly the thirteen columns of `LEDGER_COLUMNS`, in order, letting
`event_id` and `recorded_at` default as they do in production.

**Selecting the rows from the table itself was the point.** It reproduces the
dedupe keys by construction, so a mistyped key cannot produce a false pass by
quietly inserting two new rows. It is also incapable of damage: `INSERT … DO
NOTHING` either adds rows or does not; there is no `UPDATE`, `DELETE` or
`RETURNING` anywhere in it.

It runs as the owner because the application role has no `SELECT` and therefore
cannot read the source rows — the grant working exactly as intended.

### Test 2 — partial heal, on synthetic data, as the application role

Run from an ordinary Postgres client logged in as **`consent_ledger_app`**, over
TLS to PostgreSQL 18.6.

A synthetic pair was used, under `source = 'manual'`, so it could not collide
with or inflate the real website evidence:

| Field | Value |
|---|---|
| `submission_id` / `source_event_id` | `csv_replayheal0000000001` |
| `source` | `manual` |
| `form_type` | `replay_verification` |
| `phone_e164` | `+15555550100` — fictional range, unroutable |
| `consent_copy_version` | `REPLAY_TEST_V1` |
| `consent_copy_text` | "Synthetic row for replay/idempotency verification. Not a consent record." |

Three statements, in order:

1. insert **only the `sms` half** — manufacturing a partial state without
   touching a single real row;
2. replay **both rows** in one multi-row statement, the shape the application
   actually sends;
3. replay the same statement again.

## What was measured

| Test | Exercised | Credential | Result |
|---|---|---|---|
| 1 | full replay of the real submission | owner | before 2 → **after 2** |
| 2.1 | fresh insert of one half | `consent_ledger_app` | `INSERT 0 1` |
| 2.2 | replay of the pair onto the partial state | `consent_ledger_app` | **`INSERT 0 1`** |
| 2.3 | replay onto the complete state | `consent_ledger_app` | `INSERT 0 0` |

**Test 2.2 is the one that mattered.** Two row-values offered, one already
present: the existing row no-opped, the missing one landed. Per row, not per
statement. The pair converged.

Final state, read back with the owner credential:

- `csv_replayheal0000000001` → two rows, `sms / consent_selected` and
  `ai_voice / consent_not_selected`, both `manual` / `replay_verification`
- **`website_rows` 4** — unchanged; **no real evidence was modified**
- **`all_rows` 6 → 8** — exactly the two synthetic rows, out of five row-values
  offered across the three Test 2 statements

## What is now true

All three documented properties hold on the live database, under the real
`INSERT`-only grant, against the real unique index. A browser or provider retry
that finds its own earlier rows is a success, not a duplicate history; and a
partial state heals rather than persisting.

## What is still unproven — the residue

**The transport, not the semantics.**

Both tests reached Neon over **TCP** — the Neon SQL Editor and a Postgres
client. `appendConsentEvents()` sends the same statement through
`@neondatabase/serverless`, whose **HTTP query path is a different transport
entirely**. That path is proven to insert — gate 4 Stage A and Stage B both went
through it — but it has never hit a conflict.

Test 1 covers the same clause against the same index. Test 2 covers the same
clause under the same role, in the same multi-row shape. What neither covers is
the driver's own HTTP round trip returning a conflict result.

Closing it would require running the application code against live Neon with a
duplicated `submission_id`, which needs `CONSENT_LEDGER_URL` present in an
execution environment. That was not attempted and the credential was not
requested. **This is recorded as residue rather than folded into "done".**

## What this left behind

**Two synthetic rows, intentionally retained.** They are clearly labelled
(`source = 'manual'`, `form_type = 'replay_verification'`), carry an unroutable
number, and say in their own `consent_copy_text` that they are not consent
records. They cost nothing, cannot be mistaken for consent, and document how the
property was proven. Removing them would be an owner-credential `DELETE`.

The ledger now holds **eight rows, all synthetic**: two provisioning rows from
9 September, four website rows from the two Preview submissions on 10 September,
and these two. **No real visitor's consent is in this table.**

## Vercel, in the same session

Preview scope was **removed** from `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_PORTAL_ID`
and `HUBSPOT_FORM_GUID` once gate 4 Stage B was complete. **Production scope is
unchanged.** Preview therefore has no standing write access to the live CRM on
future deployments, and returns a 503 at delivery exactly as it did before
Stage B — with the ledger append still running.

Environment variables bind at deploy time, so the Preview deployment built while
those variables were scoped still holds them until it is redeployed or
superseded. Nothing submits to it.

## What was not touched

No application code. No migration, grant or schema change. No Vercel deployment.
No HubSpot record, property, form or workflow. No SMS sent, no call placed.
Production is unchanged.
