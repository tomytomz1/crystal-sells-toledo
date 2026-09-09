-- ===========================================================================
-- The append-only consent ledger.
--
--   crystalsellstoledo.com — communication consent evidence
--   Design:  docs/updates/2026-09-09-consent-evidence-ledger-proposal.md
--   Plan:    docs/updates/2026-09-09-consent-evidence-ledger-implementation-plan.md
--   Write-up: docs/updates/2026-09-09-consent-evidence-ledger.md
--
-- OWNER CREDENTIAL ONLY. The application role never runs any of this, and
-- the Vercel application never holds a credential that could. `CONSENT_LEDGER_URL`
-- is the APPLICATION role's connection string; the owner's must never be
-- put there.
--
-- APPEND-ONLY IS A DATABASE GRANT, NOT A CODE CONVENTION. If the grants at
-- the bottom of this file are skipped, this is an ordinary mutable table and
-- activation gate 3 is not met however careful the application code is.
--
-- gen_random_uuid() is core PostgreSQL from version 13 onward and needs no
-- extension. Neon provisions 14 or later, so on this deployment nothing extra
-- is required. Confirm before applying:  SHOW server_version;
-- On anything older, the OWNER runs, once, before this file:
--   CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- That is owner-time setup. It is never the application's to do, and the
-- application role is not granted CREATE on the schema.
-- ===========================================================================

CREATE TABLE communication_consent_events (
  -- The database mints the identity. The application supplies no event_id
  -- and contains no UUID generation of its own: the uniqueness guarantee of
  -- a primary key belongs to the store that enforces it, not to a process
  -- holding no UPDATE privilege to repair a collision with.
  event_id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- When the ledger recorded it. Server default, never supplied.
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  -- When the consent decision actually happened — the server-owned
  -- submission timestamp, not the ingest time.
  occurred_at          timestamptz NOT NULL,
  -- sms | ai_voice | all   ('all' is written only by a global
  -- do-not-contact, which is a later phase)
  channel              text        NOT NULL,
  -- consent_selected | consent_not_selected | reoptin_requested |
  -- revoked | suppressed | unsuppressed
  --
  -- consent_not_selected IS NOT A REVOCATION. It records that a box was not
  -- ticked on one submission. Reading it as a withdrawal would silently
  -- destroy lawful permissions.
  event_type           text        NOT NULL,
  -- The line the consent decision concerns. Required on every row,
  -- including consent_not_selected: an event that does not say which number
  -- it is about proves nothing about that number.
  phone_e164           text        NOT NULL,
  -- website | twilio | retell | manual
  source               text        NOT NULL,
  source_event_id      text,
  -- Idempotency. `source:source_event_id:channel:event_type`. A provider or
  -- browser retry finding its own earlier row is a success, not a duplicate
  -- history.
  dedupe_key           text        NOT NULL UNIQUE,
  submission_id        text,
  -- NULL on every website event, and deliberately so: the HubSpot contact id
  -- is not known until after the CRM write, which is after the append, and
  -- the application role has no UPDATE with which to backfill it. Correlation
  -- for a website event is by submission_id, which appears here, in the
  -- HubSpot enquiry block, in the acknowledgement email and in every log line
  -- for the request. The STOP/DNC phases run after a contact is known and
  -- will populate it.
  hubspot_contact_id   text,
  form_type            text,
  page_path            text,
  -- The disclosure identifier AND the disclosure itself. A version string
  -- only answers "what did they agree to" for someone still holding the
  -- revision of the source deployed that day; the text answers it from the
  -- ledger alone, years later.
  consent_copy_version text,
  consent_copy_text    text,
  -- Unused by this phase. Created now so the STOP/DNC phase needs no second
  -- migration against an append-only table.
  reason_code          text,
  evidence_text        text,
  schema_version       integer     NOT NULL DEFAULT 1,
  metadata             jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- "What is this number allowed to receive, and since when" — the question a
-- send-time check and an audit both ask.
CREATE INDEX communication_consent_events_phone_time_idx
  ON communication_consent_events (phone_e164, occurred_at DESC);
-- Correlation back to the HubSpot enquiry block and the function logs.
CREATE INDEX communication_consent_events_submission_idx
  ON communication_consent_events (submission_id);

-- ---------------------------------------------------------------------------
-- THE APPEND-ONLY GRANT
-- ---------------------------------------------------------------------------
-- INSERT and SELECT, nothing else, and no ownership. Replace
-- <application_role> with the role whose connection string becomes
-- CONSENT_LEDGER_URL.
--
-- Deliberately NOT granted, and not to be added later without a reason
-- written down beside it:
--   UPDATE, DELETE, TRUNCATE  — the whole point;
--   table ownership, CREATE on the schema, any DDL privilege — the uuid
--     default is baked in by this migration and evaluated server-side on
--     every INSERT, so the role depends on a default it cannot alter or drop;
--   USAGE ON SEQUENCE — a uuid default uses no sequence. The proposal's role
--     sketch listed one, which assumed a serial/identity key. An unnecessary
--     grant on an append-only ledger is a grant to justify later.
--
-- SELECT is granted narrowly so the controlled round-trip verification
-- (activation gate 4) can be done as the application role. Nothing in the
-- application reads the ledger yet.
GRANT INSERT, SELECT ON communication_consent_events TO <application_role>;

-- ---------------------------------------------------------------------------
-- VERIFY THE GRANT, as the application role, before calling gate 3 closed:
--
--   INSERT one row and confirm the database assigned its event_id;
--   UPDATE communication_consent_events SET form_type = 'x';   -- must be refused
--   DELETE FROM communication_consent_events;                  -- must be refused
--
-- A separate privileged path, off Vercel, stays for migrations and for
-- legally required privacy deletion. Append-only does not override a
-- deletion obligation.
-- ---------------------------------------------------------------------------
