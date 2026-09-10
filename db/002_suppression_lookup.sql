-- 002 — suppression lookup for send-time enforcement
--
-- Gate 7. Design and rationale:
--   docs/updates/2026-09-10-stop-dnc-suppression-decision.md §2.1
--
-- WHAT THIS ADDS
--   * get_suppression_state(text) — a SECURITY DEFINER function answering
--     "is THIS number suppressed?" and nothing else
--   * a sender role holding EXECUTE on that function and NO table
--     privileges whatsoever
--
-- WHAT THIS DOES NOT DO
--   It does not alter communication_consent_events in any way. db/001 is
--   applied and must stay byte-identical to what was run; the three columns
--   this phase uses (reason_code, evidence_text, metadata) were created
--   unused precisely so no migration would ever have to touch that table.
--
-- ---------------------------------------------------------------------
-- WHY A FUNCTION AND NOT A VIEW
-- ---------------------------------------------------------------------
-- A view the sender can SELECT is a view the sender can DUMP: one query
-- returns every suppressed number in the system. A function that takes a
-- number can only answer about a number the caller already holds.
--
-- Measured before this file was written, on PostgreSQL 16 with db/001
-- applied verbatim and a sender role holding no table privileges:
--
--   sender's privileges on communication_consent_events   NONE
--   get_suppression_state('<suppressed number>')          returns the row
--   get_suppression_state('<clean number>')               0 rows
--   SELECT count(*) FROM communication_consent_events     permission denied
--   get_suppression_state(NULL)                           0 rows
--   INSERT / UPDATE / DELETE on the table                 permission denied
--   the WEBSITE role calling the function                 permission denied
--
-- What it does NOT prevent: a holder of the sender credential can still
-- test numbers one at a time. What it removes is the bulk dump, which is
-- the realistic leak.
--
-- ---------------------------------------------------------------------
-- APPLY THIS AS THE TABLE OWNER
-- ---------------------------------------------------------------------
-- The function must be created by the role that owns
-- communication_consent_events (neondb_owner — the same credential that
-- applied db/001), because SECURITY DEFINER executes with the OWNER's
-- rights and that is the whole mechanism.
--
-- Replace <sender_role> and <sender_password> before running. The sender
-- credential goes to the SENDER, never to the website: the website holds
-- INSERT and no read, and those two must not converge.

-- ---------------------------------------------------------------------
-- 1. THE SENDER ROLE
-- ---------------------------------------------------------------------
-- LOGIN and nothing else. No table grant appears anywhere in this file for
-- this role, and none should ever be added: if send-time enforcement needs
-- another question answered, add another function.

CREATE ROLE <sender_role> LOGIN PASSWORD '<sender_password>';


-- ---------------------------------------------------------------------
-- 2. THE FUNCTION
-- ---------------------------------------------------------------------
-- Returns one row per channel currently suppressed for this number, with
-- the EARLIEST refusal — the first one is the one that matters, and a later
-- duplicate STOP does not restart the clock.
--
-- `revoked` counts alongside `suppressed`: one is the consumer withdrawing
-- in words, the other a keyword or carrier action, and both deny sending.
-- Reading only one of them would let a withdrawal through.
--
-- STABLE, not IMMUTABLE: the answer changes as rows are appended.

CREATE FUNCTION get_suppression_state(p_phone text)
RETURNS TABLE (channel text, suppressed_at timestamptz, reason_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- MANDATORY, NOT DECORATIVE. Without a fixed search_path a caller can
-- create an object named communication_consent_events in a schema they
-- control, put it earlier in their own search_path, and this function will
-- read THAT with the owner's rights. It is the classic SECURITY DEFINER
-- vulnerability and it is silent.
SET search_path = pg_catalog, public
AS $$
  SELECT e.channel,
         min(e.occurred_at)  AS suppressed_at,
         min(e.reason_code)  AS reason_code
  FROM public.communication_consent_events e
  WHERE e.phone_e164 = p_phone
    AND e.event_type IN ('suppressed', 'revoked')
  GROUP BY e.channel;
$$;


-- ---------------------------------------------------------------------
-- 3. THE GRANTS
-- ---------------------------------------------------------------------
-- MANDATORY. PostgreSQL grants EXECUTE on a new function to PUBLIC by
-- default, so creating the function without this REVOKE hands it to every
-- role in the database — including the website's INSERT-only role, whose
-- entire purpose is that it cannot read this table.

REVOKE EXECUTE ON FUNCTION get_suppression_state(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_suppression_state(text) TO <sender_role>;


-- ---------------------------------------------------------------------
-- 4. VERIFY BEFORE CALLING GATE 7 CLOSED
-- ---------------------------------------------------------------------
-- Two credentials again, and which one you are matters. Neon's SQL Editor
-- runs everything as the branch owner and offers no role selector, so the
-- refusals must be proven either with a real login as each role or under
-- SET ROLE — and if you use SET ROLE, remember RESET ROLE afterwards or
-- every later statement in that session silently runs as the wrong role.
--
--   As the SENDER role — expect SUCCESS:
--     SELECT * FROM get_suppression_state('+15555550100');
--
--   As the SENDER role — expect PERMISSION DENIED, all four:
--     SELECT count(*) FROM communication_consent_events;
--     INSERT INTO communication_consent_events (occurred_at, channel,
--       event_type, phone_e164, source, dedupe_key)
--       VALUES (now(), 'sms', 'suppressed', '+15555550100', 'manual', 'k');
--     UPDATE communication_consent_events SET channel = 'x';
--     DELETE FROM communication_consent_events;
--
--   As the WEBSITE role (consent_ledger_app) — expect PERMISSION DENIED:
--     SELECT * FROM get_suppression_state('+15555550100');
--
--   As the OWNER — confirm the hardening actually landed:
--     SELECT prosecdef, proconfig FROM pg_proc
--      WHERE proname = 'get_suppression_state';
--     -- prosecdef must be `t`
--     -- proconfig must contain search_path=pg_catalog, public
--
-- If prosecdef is false the function runs as the CALLER and returns nothing
-- useful. If proconfig is null the search_path hardening is missing and the
-- function must be dropped and recreated — not patched in place.
