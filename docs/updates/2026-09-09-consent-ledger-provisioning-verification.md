# Consent ledger — provisioning and grant verification

**Date:** 9 September 2026
**Status:** the ledger database **exists and is verified**. It is **not connected
to anything**.
**Feature status:** `COMMUNICATIONS_CONSENT_ENABLED` remains OFF / absent from
Vercel Production. This work did not change it.

This is the record of the human half of activation gate 3 — the part
`docs/updates/2026-09-09-consent-evidence-ledger.md` §7 said had to happen in a
database that did not exist yet. It now exists. Performed manually in the Neon
console by the operator; every statement below was run by a person, not by any
code in this repository.

**Read §5 before treating this as done.** The credential gap this document
originally described has since been closed (§4.6); a narrower one remains, and it
is the one that would be easiest to gloss.

---

## 1. What exists now

| | |
|---|---|
| Provider | **Neon Postgres**, standalone organisation "Crystal Sells Toledo", Free plan |
| Project | `crystal-sells-toledo-consent-ledger` |
| Region | AWS US East 2 (Ohio) |
| Postgres version | **18** |
| Branch / database | `production` / `neondb` |
| Table | `communication_consent_events`, from `db/001_communication_consent_events.sql`, applied unmodified |
| Application role | `consent_ledger_app` — `LOGIN`, and nothing else |
| Rows | 2, both synthetic verification rows (§4.5, §4.6) |

### Provisioned directly, NOT through the Vercel Marketplace

§7 of the ledger write-up recommended provisioning via the Vercel Marketplace
integration. **That recommendation was not followed, deliberately.** The
Marketplace flow automatically injects database environment variables into the
Vercel project using Neon's default privileged role — which would place an
admin-level credential into the application, the single thing the design forbids.

The Neon organisation reached through Vercel is also *Vercel-managed*: its "New
project" button is disabled with the tooltip *"To create a new project, use the
Neon Postgres integration in Vercel."* Provisioning therefore happened in a
standalone Neon organisation instead.

A second reason, which outlives the credential one: an evidence store's existence
should not be a side effect of a Marketplace integration. Uninstalling that
integration during some unrelated future cleanup could take the database with it.
Consent evidence must not be deletable by accident.

**Verified after provisioning:** Neon's Integrations page shows **Vercel as
"Add"**, not connected or installed. Nothing was injected anywhere.

### Postgres 18 settles the `gen_random_uuid()` question

The migration's header asks the operator to confirm `gen_random_uuid()` resolves
before applying, because the primary key default depends on it. It is core
PostgreSQL from version 13 onward. On 18 there is nothing to install, `pgcrypto`
is not required, and no `SHOW server_version;` check was needed beyond reading
the project dashboard.

---

## 2. How the application role was created, and the trap avoided

```sql
CREATE ROLE consent_ledger_app WITH
  LOGIN
  PASSWORD '<generated, 32 chars, alphanumeric>'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS;
```

**Created with SQL, deliberately not through Neon's "Roles" UI.** Roles created
through the Neon console are made members of Neon's `neon_superuser` group, which
would have granted this role read, update and delete across the database — the
exact opposite of an append-only ledger, and it would have looked perfectly
normal on screen. A role created with plain `CREATE ROLE` is an ordinary
PostgreSQL role holding only what is granted to it explicitly.

Every `NO...` clause above is a PostgreSQL default written out on purpose: this
role's powers should be readable at a glance by whoever audits this, not inferred
from what was left unsaid.

The password was generated in a password manager and is 32 alphanumeric
characters (no symbols, which have to be escaped inside a connection string). It
has never been placed in Vercel, in this repository, or in any conversation.

**Correction, recorded because an earlier revision of this document got it
wrong.** That revision claimed the password *"exists only in the operator's
password manager"*. **It does not.** Neon captures the password even when a role
is created with SQL, stores it in its own vault, and will display it: the Connect
panel shows a complete, working connection string for `consent_ledger_app` behind
a **Show password** button, with the note *"Your password is saved in a secure
storage vault."*

The practical consequence, which belongs in the threat model rather than in a
footnote: **anyone with console access to this Neon project can retrieve the
application credential.** Neon console access is therefore equivalent to holding
it. That is not a defect — it is how Neon works, and it made the verification in
§4.6 much easier — but a document that claimed an isolation the system does not
provide would have been worse than no document.

---

## 3. The migration

`db/001_communication_consent_events.sql` was applied **unmodified**, as the
owner role, in the Neon SQL Editor. The only substitution was the file's own
`<application_role>` placeholder → `consent_ledger_app`. Four statements, all
successful: the table, two indexes, and the grant.

```sql
GRANT INSERT ON communication_consent_events TO consent_ledger_app;
```

That single line is the whole grant, and it is what makes the ledger append-only.

**The migration file has not been edited since it was applied**, and should not
be. Its value as a record depends on it being byte-identical to what was run. One
correction that belongs against it is recorded in §6 below rather than by editing
the file.

---

## 4. What was verified, and what each check proves

### 4.1 The grants, asked of PostgreSQL directly

Run as the owner. This is PostgreSQL evaluating its own access-control tables for
that role — accounting for direct grants, role membership and `PUBLIC` grants
together, so a privilege arriving by a route nobody thought to test cannot hide.

```sql
SELECT
  has_table_privilege('consent_ledger_app','communication_consent_events','INSERT')   AS insert_allowed,
  has_table_privilege('consent_ledger_app','communication_consent_events','SELECT')   AS select_allowed,
  has_table_privilege('consent_ledger_app','communication_consent_events','UPDATE')   AS update_allowed,
  has_table_privilege('consent_ledger_app','communication_consent_events','DELETE')   AS delete_allowed,
  has_table_privilege('consent_ledger_app','communication_consent_events','TRUNCATE') AS truncate_allowed,
  has_schema_privilege('consent_ledger_app','public','USAGE')                         AS schema_usage;
```

| Column | Result |
|---|---|
| `insert_allowed` | **true** |
| `select_allowed` | **false** |
| `update_allowed` | **false** |
| `delete_allowed` | **false** |
| `truncate_allowed` | **false** |
| `schema_usage` | **true** |

`schema_usage` being true also settles a question the migration left open: **no
`GRANT USAGE ON SCHEMA public` line is missing.** The default suffices, and the
migration file needs no addition.

Role attributes and memberships were checked in the same run:

- `rolsuper`, `rolcreatedb`, `rolcreaterole`, `rolbypassrls`, `rolinherit` — all
  **false**; `rolcanlogin` **true**.
- `pg_auth_members` — **no rows**. The role belongs to no group, so it cannot
  inherit a privilege from one.

### 4.2 INSERT succeeds under the role's own identity

```sql
SET ROLE consent_ledger_app;
SELECT current_user, session_user;   -- consent_ledger_app | neondb_owner
INSERT INTO communication_consent_events (...) VALUES (...);   -- INSERT 1
```

The `current_user` check is not decoration. Without it, a failed role switch would
have run the insert as the owner and produced a passing result that proved
nothing.

### 4.3 All four refusals

Each run as `consent_ledger_app`, each expected to fail, each of which **did**:

| Statement | Result |
|---|---|
| `SELECT * FROM communication_consent_events;` | `ERROR: permission denied for table communication_consent_events (SQLSTATE 42501)` |
| `UPDATE communication_consent_events SET form_type = 'tampered';` | same error |
| `DELETE FROM communication_consent_events;` | same error |
| `TRUNCATE communication_consent_events;` | same error |

Three of those four carry no `WHERE` clause and are destructive by design. **They
were run while the table held exactly one synthetic row**, so the worst case was
losing something recreatable. Once real consent evidence is present this test can
never be run again, which is precisely why it belongs at provisioning time.

### 4.4 The refusals protected the data, not merely returned errors

Read back as the owner. An error message alone proves nothing about what happened
to the rows.

| Field | Value | What it shows |
|---|---|---|
| `count(*)` | **1** | The DELETE and TRUNCATE removed nothing |
| `form_type` | **`setup_verification`** | The UPDATE did not rewrite it to `tampered` |
| `event_id` | `d0741f9d-074f-4b98-a17e-9eba1acb5fe4` | **Database-generated.** No `event_id` was supplied by the INSERT; `gen_random_uuid()` produced it |
| `recorded_at` | `2026-09-09 19:10:17.350979+00` | Also database-supplied, never sent by the client |
| `schema_version` | `1` | Column default applied |
| `dedupe_key` | `manual:csv_setup_verification_20260909:sms:consent_not_selected` | Stored as written |

The owner performing this read while the application role was refused the same
query **is** the two-credential separation, demonstrated in both directions.

### 4.5 The test row

One row exists in the ledger and, because the table is append-only, the
application can never remove it. It was written to be unmistakable:

- `phone_e164` `+15555550100` — a reserved fictional number,
- `source` `manual`, `form_type` `setup_verification`,
- `event_type` `consent_not_selected` — asserts **no** permission for anyone,
- `consent_copy_version` `NOT_A_CONSENT`,
- `consent_copy_text` saying in words that it is not a real consent and no person
  is associated with it,
- `metadata` `{"purpose": "activation gate 3 grant verification"}`.

**It is being kept deliberately.** It is a dated record that this verification
actually happened, and it grants nothing to anyone. The owner credential could
remove it; there is no reason to.

### 4.6 The credential itself — a real login, later the same day

The gap §5 originally described has since been closed. A database client
(TablePlus) connected **as `consent_ledger_app`**, over the pooled endpoint,
using the connection string from Neon's Connect panel.

| | |
|---|---|
| Server reported | **PostgreSQL 18.6** |
| Transport | **TLSv1.3** (`sslmode=require`) |
| Host | `…-pooler.c-4.us-east-2.aws.neon.tech`, port 5432 |

| Statement | Result |
|---|---|
| `SELECT current_user;` | ran successfully |
| `INSERT INTO communication_consent_events (…);` | **`INSERT 0 1, 1 rows affected`** |
| `SELECT count(*) FROM communication_consent_events;` | **`ERROR: permission denied for table communication_consent_events`** |

**The refusal does double duty.** It shows the append-only grant holds over a
genuine login and not merely under `SET ROLE`, and it independently confirms the
session's identity: the owner *can* read this table, so being refused proves the
connection was not accidentally the admin one.

This added a **second** clearly-labelled synthetic row
(`submission_id = 'csv_credential_verification_20260909'`,
`form_type = 'credential_verification'`). The ledger now holds two rows, both
synthetic, both permanent as far as the application is concerned, neither
granting anything to anyone.

---

## 5. What is still unproven

The credential gap is **closed** (§4.6): the role can log in, append, and is
refused a read over a real connection. What remains is narrower, and worth
stating precisely rather than waving at.

**No application code has ever touched this database.** §4.6 used an ordinary
PostgreSQL client over TCP on port 5432. `api/_lib/consent-ledger.mjs` uses
`@neondatabase/serverless`, whose **HTTP query path is a different transport
entirely** — it does not open a Postgres TCP connection at all. So still unknown:

- whether that driver's HTTP endpoint accepts this connection string;
- whether the pooled host is the right one to put in `CONSENT_LEDGER_URL`, or
  whether the direct host should be used instead;
- whether the module's real multi-row
  `INSERT … ON CONFLICT (dedupe_key) DO NOTHING` succeeds against this table —
  §4.6 inserted a single row with hand-written SQL, so the `ON CONFLICT` clause
  has never been matched against the real unique index;
- whether any of it works from within a Vercel function, under that runtime's
  network and timeout constraints.

**Do not read §4 as evidence that the application can write to this ledger.** It
is evidence that a client can, and that whatever connects may only append.

Those close at gate 4 — the controlled round-trip — which is also the first
moment `CONSENT_LEDGER_URL` is exercised.

Also unproven, unchanged: no `CONSENT LEDGER` row has ever been rendered in
HubSpot or seen by an operator, in either state.

---

## 6. A correction to the migration file's verification procedure

`db/001_communication_consent_events.sql` tells the operator to run the four
refusals *"As the APPLICATION role (the `CONSENT_LEDGER_URL` credential)"*. **That
cannot be done directly in Neon's SQL Editor**, which offers no role selector and
runs everything as the branch owner.

Two things were learned doing it anyway, both worth knowing before someone
repeats this:

1. **`SET ROLE` fails by default.** The owner that *creates* a role in Neon is not
   made a member of it, so `SET ROLE consent_ledger_app` is refused with
   `permission denied to set role`. Granting membership first makes it work:
   `GRANT consent_ledger_app TO CURRENT_USER;`. That grants the owner nothing it
   did not already hold — it already has every privilege on the table — and it
   exists solely to allow identity switching for tests. **It was revoked after
   verification** (§7), so the live database matches the checked-in migration.
2. **The Neon SQL Editor keeps one session alive across Runs.** A `SET ROLE` in
   one Run is still in force in the next. This caused an owner query to be refused
   until `RESET ROLE;` was issued. Anyone running these checks should begin with
   `RESET ROLE;` unless they intend to be the application role.

The migration file was **not edited** to record this. It should stay byte-identical
to what was applied; this section is the correction.

---

## 7. Cleanup performed

```sql
REVOKE consent_ledger_app FROM neondb_owner;
```

The temporary membership from §6 was removed once verification finished, so no
role holds anything beyond what `db/001_communication_consent_events.sql` grants.
Re-granting it is one statement if the checks ever need repeating.

---

## 8. What deliberately has NOT happened

- **Nothing was added to Vercel.** `CONSENT_LEDGER_URL` is not set, in any
  environment. The site has no connection to this database.
- **`COMMUNICATIONS_CONSENT_ENABLED` remains OFF.** No consent evidence is built,
  so the ledger is never called and the Neon driver is never loaded.
- **The owner credential has never been placed in Vercel** and never will be. It
  lives in the operator's password manager, and is used for migrations, for the
  verification read above, and for any legally required privacy deletion.
- No production website lead was submitted. No SMS was sent. No call was placed.
- No HubSpot record, property, form or workflow was touched.

---

## 9. Remaining gates

| Gate | Status |
|---|---|
| **3** — append-only ledger implemented and tested | **Closed.** Code half merged; database half is this document |
| **4** — controlled ledger round-trip | Open. Needs `CONSENT_LEDGER_URL` set and the feature enabled somewhere. The credential itself is now proven (§4.6); what gate 4 still proves is the `@neondatabase/serverless` HTTP path, the `ON CONFLICT` clause against the real index, and the Vercel runtime |
| **5** — HubSpot timeline display check | Open. Now against an eleven-row consent block — `docs/updates/2026-09-09-hubspot-consent-setup.md` §6a |
| **6–10** | Open — `docs/updates/2026-09-09-consent-evidence-ledger-decision.md` §3 |

Gate 4 requires a decision this document does not make: the round-trip needs
`COMMUNICATIONS_CONSENT_ENABLED` on **somewhere**, since with it off nothing calls
the ledger. Whether that may be a preview deployment is the operator's call, and
Production is not a candidate.
