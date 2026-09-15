-- 003 — unsuppression: the two-clearance-kind fold, and the operator's lookup
--
-- Approved design:
--   docs/updates/2026-09-15-unsuppression-reoptin-decision.md §5.4, §6.2, §6.2a
--
-- WHAT THIS ADDS
--   * _active_consent_blocks(text) — INTERNAL. The ONE definition of "an
--     active blocking event". Granted to nobody.
--   * get_suppression_state(text)  — REPLACED body. Same name, same input
--     signature, same return shape, so gate 8 needs no new caller contract.
--   * get_active_blocks(text)      — NEW. Names the blocking events so the
--     future operator workflow can say which one it is correcting.
--   * consent_ledger_operator      — the operator role: INSERT + EXECUTE on
--     the two public functions, and nothing else.
--
-- WHAT THIS DOES NOT DO
--   It does not alter communication_consent_events in any way, and it does
--   not edit db/001 or db/002. Both are applied historical artifacts and must
--   stay byte-identical to what was run. Every column this migration reads —
--   reason_code, metadata, dedupe_key, recorded_at — already exists in db/001.
--
--   It builds NO application behaviour. api/operator-unsuppress.js does not
--   exist, nothing calls either function, and no endpoint, projection or
--   send-time enforcement is created here. This migration creates the database
--   capability a later phase will consume.
--
-- ---------------------------------------------------------------------
-- WHY db/002's FOLD WAS WRONG, IN ONE PARAGRAPH
-- ---------------------------------------------------------------------
-- db/002 folds `event_type IN ('suppressed','revoked')` and is blind to
-- `unsuppressed`, so a suppression is permanent by construction: even once
-- something writes the clearing event, send-time enforcement would never see
-- it. Unsuppression is therefore a READ-SEMANTICS problem before it is a write
-- problem, which is why this file exists before any endpoint does.
--
-- ---------------------------------------------------------------------
-- TWO KINDS OF CLEARANCE, AND THE DISTINCTION IS LOAD-BEARING
-- ---------------------------------------------------------------------
-- An earlier revision of the design made EVERY `unsuppressed` row a lane-wide
-- clearance while letting `recorded_in_error` name one particular erroneous
-- event in its metadata. The fold never read that metadata, so the naming was
-- decorative:
--
--   t1  consumer legitimately sends SMS STOP
--   t2  classifier or system erroneously records another SMS suppression
--   t3  operator records unsuppressed/recorded_in_error, intending to fix t2
--       -> the lane clearance at t3 superseded EVERYTHING before it,
--          including the legitimate refusal at t1
--
-- Correcting one bad row erased an unrelated consumer refusal, and the audit
-- trail described it as something else. So:
--
--   reason_code = 'consumer_request'    LANE CLEARANCE. The consumer asked for
--                                       that channel back; it is a statement
--                                       about the channel, so it supersedes
--                                       the lane's earlier blocking events.
--
--   reason_code = 'recorded_in_error'   TARGETED INVALIDATION. It kills ONLY
--                                       the blocking events whose dedupe_key
--                                       it names in metadata.invalidates.
--                                       Everything it does not name survives.
--
--   anything else (including NULL)      CLEARS NOTHING. An unknown reason code
--                                       matches neither branch below and is
--                                       inert, which is the fail-closed
--                                       default rather than an oversight.
--
-- `dedupe_key` is the identifier because db/001 declares it NOT NULL UNIQUE —
-- so a key names at most one row — and because it is derivable by a caller
-- holding no SELECT (`source:source_event_id:channel:event_type`). `event_id`
-- was rejected for exactly that reason: learning it needs the table read the
-- privilege model forbids.
--
-- ---------------------------------------------------------------------
-- TWO CORRECTIONS TO THE DESIGN'S ILLUSTRATIVE SQL, BOTH MEASURED HERE
-- ---------------------------------------------------------------------
-- The design said plainly that its SQL had been executed against nothing.
-- Running it found two defects, both in the fail-OPEN direction, and both are
-- corrected below with a regression test naming them.
--
-- (A) THE LANE-CLEARANCE TIE WAS FAIL-OPEN. The design's prose (§5.3) says
--     "if a blocking event and a clearing event carry the identical
--     occurred_at, the BLOCK WINS". Its SQL tested survival with strict `>`,
--     so on an exact tie the block was EXCLUDED — cleared, not kept. Prose and
--     SQL disagreed and the SQL was the permissive one. Survival is now `>=`
--     on both clocks: an ambiguous simultaneity keeps the block.
--
--     Note the asymmetry with (B) below, which is deliberate and not an
--     inconsistency: these are two different comparisons. For a lane clearance
--     the test is "does the block SURVIVE", so a tie must answer YES (`>=`).
--     For a targeted invalidation the test is "is the block KILLED", so a tie
--     must answer NO (`<`). Both resolve toward more blocking.
--
-- (B) MALFORMED `invalidates` RAISED INSTEAD OF INVALIDATING NOTHING.
--     jsonb_array_elements_text() ERRORS on a JSON scalar or object
--     ("cannot extract elements from a scalar"). A string, a number or an
--     object under metadata.invalidates therefore aborted the whole query
--     rather than being ignored. A raised exception is not "fails toward more
--     blocking": it returns no rows at all and hands the caller an error where
--     it expected an answer. The jsonb_typeof() guard below makes a non-array
--     inert, which is what the design requires.
--
-- ---------------------------------------------------------------------
-- APPLY THIS AS THE TABLE OWNER
-- ---------------------------------------------------------------------
-- The functions must be created by the role that owns
-- communication_consent_events (neondb_owner — the credential that applied
-- db/001 and db/002), because SECURITY DEFINER executes with the OWNER's
-- rights and that is the whole mechanism.
--
-- Replace <operator_role> and <operator_password> before running, and use the
-- SAME <sender_role> and <application_role> names db/002 and db/001 used.
-- The operator credential goes to the operator surface only. It is not the
-- sender's, it is not the website's, and it is never the owner's.


-- ---------------------------------------------------------------------
-- 1. THE OPERATOR ROLE
-- ---------------------------------------------------------------------
-- LOGIN, INSERT, and EXECUTE on exactly two functions. No table SELECT, no
-- UPDATE, no DELETE, no TRUNCATE, no DDL, no ownership.
--
-- HONEST ABOUT THE BLAST RADIUS. {INSERT, EXECUTE} is EXACTLY the union of the
-- website role's and the sender role's capabilities, not a subset of it — and
-- this is the first credential to hold both at once, so one leaked string
-- yields both. That is accepted deliberately (design §6.4) and bounded: it can
-- append rows and ask about one number at a time, and it can do nothing else.
-- It cannot cause a message, because sending needs a live evidenced consent
-- that no ledger row creates.

CREATE ROLE <operator_role> LOGIN PASSWORD '<operator_password>';

GRANT INSERT ON communication_consent_events TO <operator_role>;


-- ---------------------------------------------------------------------
-- 2. THE ONE DEFINITION OF "ACTIVE"
-- ---------------------------------------------------------------------
-- PostgreSQL cannot share a CTE across two SQL functions, and the design
-- requires that the summary and the detailed list can never disagree. So the
-- definition lives in ONE function that both wrappers call. Duplicating the
-- CTE into both would be two definitions free to drift, and the operator would
-- eventually be shown a set the enforcement path does not accept.
--
-- SECURITY INVOKER, DELIBERATELY. Called from inside either SECURITY DEFINER
-- wrapper it runs as the OWNER and reads the table normally. Called directly
-- by any application role it runs as THAT role, which holds no SELECT, so it
-- fails. Defence in depth: the internal function is not a back door even if a
-- future grant is added to it by mistake.
--
-- It is granted to NOBODY. EXECUTE is revoked from PUBLIC below.

CREATE FUNCTION _active_consent_blocks(p_phone text)
RETURNS TABLE (channel text, dedupe_key text, event_type text,
               reason_code text, source text, source_event_id text,
               occurred_at timestamptz, recorded_at timestamptz)
LANGUAGE sql
STABLE
-- MANDATORY, NOT DECORATIVE — the same reasoning db/002 records. Without a
-- fixed search_path a caller can create their own object named
-- communication_consent_events earlier in their search_path and have it read
-- with the wrapper's rights. Silent, and the classic SECURITY DEFINER hole.
SET search_path = pg_catalog, public
AS $$
  WITH last_clear AS (
    -- LANE CLEARANCE ONLY. A recorded_in_error row is NOT a lane clearance
    -- and must never be read as one — that conflation is the defect this
    -- migration exists to correct. An unknown or NULL reason_code matches
    -- neither this branch nor `invalidated`, and so clears nothing.
    --
    -- BOTH timestamps come from ONE row via DISTINCT ON. max(occurred_at)
    -- beside max(recorded_at) would be two INDEPENDENT aggregates pairing a
    -- timestamp from one row with a timestamp from another — the exact
    -- mis-pairing db/002's own comment records and corrects.
    SELECT DISTINCT ON (u.channel)
           u.channel,
           u.occurred_at AS cleared_at,
           u.recorded_at AS cleared_recorded_at
    FROM public.communication_consent_events u
    WHERE u.phone_e164 = p_phone
      AND u.event_type = 'unsuppressed'
      AND u.reason_code = 'consumer_request'
    ORDER BY u.channel, u.occurred_at DESC, u.recorded_at DESC, u.event_id
  ),
  invalidated AS (
    -- TARGETED INVALIDATION: one row per (lane, killed dedupe_key), carrying
    -- the invalidation's OWN recorded_at so the pre-existence rule below can
    -- be applied per target.
    --
    -- THE jsonb_typeof GUARD IS CORRECTION (B). Without it a malformed
    -- `invalidates` — a string, a number, an object — raises
    -- "cannot extract elements from a scalar" and aborts the whole fold.
    -- With it, anything that is not a JSON array yields zero killed keys and
    -- is inert. Missing, malformed, non-array and empty all invalidate
    -- NOTHING, and none of them can become a lane clearance.
    SELECT i.channel,
           k.dedupe_key   AS killed_key,
           i.recorded_at  AS killed_at
    FROM public.communication_consent_events i
    CROSS JOIN LATERAL jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(i.metadata -> 'invalidates') = 'array'
                THEN i.metadata -> 'invalidates'
                ELSE '[]'::jsonb
           END) AS k(dedupe_key)
    WHERE i.phone_e164 = p_phone
      AND i.event_type = 'unsuppressed'
      AND i.reason_code = 'recorded_in_error'
  )
  SELECT e.channel, e.dedupe_key, e.event_type, e.reason_code,
         e.source, e.source_event_id, e.occurred_at, e.recorded_at
  FROM public.communication_consent_events e
  LEFT JOIN last_clear c ON c.channel = e.channel
  WHERE e.phone_e164 = p_phone
    AND e.event_type IN ('suppressed', 'revoked')
    -- NOT SUPERSEDED BY A LANE CLEARANCE IN ITS OWN LANE.
    --
    -- `>=` on BOTH clocks is CORRECTION (A). The question here is "does this
    -- block SURVIVE", so an exact tie must answer YES and keep the block. The
    -- design's illustrative SQL used `>`, which cleared on a tie while its
    -- own prose said the block wins.
    --
    -- TWO CLOCKS, EITHER SUFFICES, and that is the delayed-STOP protection:
    -- occurred_at is event time and recorded_at is ingest time, so a STOP
    -- webhook delayed or redelivered can land AFTER a clearance while
    -- carrying an EARLIER occurred_at. Folding on event time alone would
    -- silently discard a real, later-arriving opt-out.
    AND (c.channel IS NULL                          -- lane never cleared
         OR e.occurred_at >= c.cleared_at           -- at or after by event time
         OR e.recorded_at >= c.cleared_recorded_at) -- or by ingest time
    -- AND NOT KILLED BY A TARGETED INVALIDATION.
    --
    -- Same lane only: an invalidation in `sms` cannot reach a block in `all`.
    --
    -- PRE-EXISTENCE, strict `<`: an invalidation may only kill a row that
    -- ALREADY EXISTED when the invalidation was recorded. Without this,
    -- naming a dedupe_key that does not exist yet would pre-kill the row when
    -- it finally lands. The question here is "is this block KILLED", so an
    -- exact tie must answer NO and keep the block.
    --
    -- A key that matches no row kills nothing: the join simply finds nothing.
    -- Fail-closed by construction rather than by a check.
    AND NOT EXISTS (
      SELECT 1 FROM invalidated v
      WHERE v.channel    = e.channel
        AND v.killed_key = e.dedupe_key
        AND e.recorded_at < v.killed_at
    );
$$;


-- ---------------------------------------------------------------------
-- 3. THE SEND-TIME SUMMARY — REPLACED BODY, IDENTICAL CONTRACT
-- ---------------------------------------------------------------------
-- Same name, same input signature, same return shape. Gate 8 needs no new
-- caller contract, and PostgreSQL enforces the return shape for us: CREATE OR
-- REPLACE cannot change a function's return type, so if this file ever drifts
-- from db/002's contract it fails to apply rather than changing it silently.
--
-- Returns one row per channel currently suppressed, with the EARLIEST ACTIVE
-- blocking event. The earliest refusal is still the one that matters and a
-- duplicate STOP still does not restart the clock — but an event superseded by
-- a lane clearance, or killed by a targeted invalidation, is not active and
-- does not set the clock.
--
-- NO reason_code IN THE RESULT, and that is db/002's correction preserved
-- rather than an omission. min(occurred_at) is the only aggregate and no
-- second column sits beside it, so the mis-pairing db/002 fixed cannot
-- reappear. If a future caller genuinely needs the reason it must come from
-- get_active_blocks(), which returns whole rows and cannot mis-pair.
--
-- IT RETURNS LANES, NOT CHANNELS. `all` dominating `sms` and `ai_voice` is
-- applied by the permission resolver in api/_lib/permission.mjs, which the
-- design makes the only place that decides whether anything may be sent.
-- Putting dominance here would create a second decider in a different
-- language with a different test story.
--
-- STABLE, not IMMUTABLE: the answer changes as rows are appended.

CREATE OR REPLACE FUNCTION get_suppression_state(p_phone text)
RETURNS TABLE (channel text, suppressed_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT a.channel, min(a.occurred_at) AS suppressed_at
  FROM public._active_consent_blocks(p_phone) a
  GROUP BY a.channel;
$$;


-- ---------------------------------------------------------------------
-- 4. THE OPERATOR'S LOOKUP — NEW
-- ---------------------------------------------------------------------
-- get_suppression_state() says a lane is blocked and since when. It does not
-- say WHICH events block it, how many there are, or what to name in an
-- invalidation. An operator cannot correct an event the system will not name,
-- and this is the function that names it.
--
-- WHAT IT DELIBERATELY DOES NOT RETURN: evidence_text (the consumer's verbatim
-- words) and metadata (which carries the operator's own attestation prose).
-- Neither is needed to identify an event, and this function is not a message
-- archive. `reason_code` IS returned — the operator has to see whether a block
-- came from a keyword, natural language or a manual entry to judge whether it
-- was recorded in error.
--
-- THE DISCLOSURE IT ADDS, stated rather than glossed: for a number the caller
-- already holds, it reveals how many blocking events exist, their types and
-- their dedupe_keys — which embed the provider's source_event_id, a Twilio
-- MessageSid. That is a real widening over (channel, suppressed_at). It is
-- confined to one already-known number and it is unavoidable: the alternative
-- is a workflow that cannot name what it corrects.
--
-- NO ENUMERATION. One number in, only that number's rows out. It cannot list
-- the ledger and it cannot discover a number the caller does not already have.

CREATE FUNCTION get_active_blocks(p_phone text)
RETURNS TABLE (channel text, dedupe_key text, event_type text,
               reason_code text, source text, source_event_id text,
               occurred_at timestamptz, recorded_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT a.channel, a.dedupe_key, a.event_type, a.reason_code,
         a.source, a.source_event_id, a.occurred_at, a.recorded_at
  FROM public._active_consent_blocks(p_phone) a
  ORDER BY a.channel, a.occurred_at, a.recorded_at, a.dedupe_key;
$$;


-- ---------------------------------------------------------------------
-- 5. THE GRANTS — RE-STATED, NEVER INHERITED
-- ---------------------------------------------------------------------
-- MANDATORY. PostgreSQL grants EXECUTE on a NEW function to PUBLIC by default,
-- so creating one without the REVOKE hands it to every role in the database —
-- including the website's INSERT-only role, whose entire purpose is that it
-- cannot read this table.
--
-- CREATE OR REPLACE is documented to PRESERVE an existing function's ACL, so
-- get_suppression_state's db/002 grants should survive section 3 above. THAT
-- IS NOT TAKEN ON TRUST. The REVOKE and GRANT are re-issued unconditionally
-- here so the outcome does not depend on whether the ACL survived, and
-- section 6 reads the ACL back from PostgreSQL itself.
--
-- THE MATRIX THIS MUST PRODUCE:
--
--   role                    table         get_suppression_state  get_active_blocks
--   ----------------------  ------------  ---------------------  -----------------
--   <application_role>      INSERT only   no                     no
--   <sender_role>           none          EXECUTE                NO
--   <operator_role>         INSERT only   EXECUTE                EXECUTE
--   PUBLIC                  none          revoked                revoked
--
-- THE SENDER DOES NOT GET get_active_blocks. Gate 8 asks "may I send?" and
-- needs allow/deny plus a timestamp. It has no use for event identity, and
-- handing it to the live send path would widen that path for nothing.

REVOKE EXECUTE ON FUNCTION _active_consent_blocks(text) FROM PUBLIC;
-- Granted to NO role. Reachable only from inside the two wrappers.

REVOKE EXECUTE ON FUNCTION get_suppression_state(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_suppression_state(text) TO <sender_role>;
GRANT  EXECUTE ON FUNCTION get_suppression_state(text) TO <operator_role>;

REVOKE EXECUTE ON FUNCTION get_active_blocks(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_active_blocks(text) TO <operator_role>;


-- ---------------------------------------------------------------------
-- 6. VERIFY BEFORE CALLING THE DATABASE FOUNDATION DONE
-- ---------------------------------------------------------------------
-- FOUR credentials now, and which one runs which statement is the whole point
-- of the exercise. Neon's SQL Editor runs everything as the branch owner and
-- offers no role selector, so the refusals must be proven either with a real
-- login as each role or under SET ROLE — and if you use SET ROLE, remember
-- RESET ROLE afterwards or every later statement in that session silently
-- runs as the wrong role.
--
-- 6.1 THE HARDENING ACTUALLY LANDED. As the OWNER:
--
--   SELECT proname, prosecdef, proconfig
--     FROM pg_proc
--    WHERE proname IN ('get_suppression_state','get_active_blocks',
--                      '_active_consent_blocks');
--
--   get_suppression_state    prosecdef t   proconfig {search_path=pg_catalog, public}
--   get_active_blocks        prosecdef t   proconfig {search_path=pg_catalog, public}
--   _active_consent_blocks   prosecdef f   proconfig {search_path=pg_catalog, public}
--
--   If a wrapper's prosecdef is false it runs as the CALLER and returns
--   nothing useful. If any proconfig is null the search_path hardening is
--   missing and that function must be DROPPED AND RECREATED, not patched.
--
-- 6.2 THE ACL IS WHAT SECTION 5 INTENDED. As the OWNER:
--
--   SELECT proname, proacl FROM pg_proc
--    WHERE proname IN ('get_suppression_state','get_active_blocks',
--                      '_active_consent_blocks');
--
--   Confirm PUBLIC (the empty grantee "=X/") appears on NONE of them, that
--   the sender appears on get_suppression_state ONLY, and that
--   _active_consent_blocks names no application role at all.
--
-- 6.3 THE REFUSALS. As each role in turn — expect PERMISSION DENIED:
--
--   as <sender_role>:       SELECT * FROM get_active_blocks('+15555550100');
--   as <sender_role>:       SELECT count(*) FROM communication_consent_events;
--   as <sender_role>:       INSERT INTO communication_consent_events ...;
--   as <application_role>:  SELECT * FROM get_suppression_state('+15555550100');
--   as <application_role>:  SELECT * FROM get_active_blocks('+15555550100');
--   as <application_role>:  SELECT count(*) FROM communication_consent_events;
--   as <operator_role>:     SELECT count(*) FROM communication_consent_events;
--   as <operator_role>:     UPDATE communication_consent_events SET channel='x';
--   as <operator_role>:     DELETE FROM communication_consent_events;
--   as <operator_role>:     TRUNCATE communication_consent_events;
--   as any role:            SELECT * FROM _active_consent_blocks('+15555550100');
--
-- 6.4 THE SUCCESSES:
--
--   as <sender_role>:    SELECT * FROM get_suppression_state('+1555...');  -- 2 cols
--   as <operator_role>:  SELECT * FROM get_suppression_state('+1555...');
--   as <operator_role>:  SELECT * FROM get_active_blocks('+1555...');      -- 8 cols
--   as <operator_role>:  INSERT INTO communication_consent_events (...) ...;
--
-- 6.5 THE SEMANTIC CASES. Insert the rows for each case below against a test
--   number, then read get_suppression_state() and get_active_blocks(). The
--   full matrix and its expected results are in
--   tests/unsuppression-fold.test.mjs, which runs every one of them against a
--   real PostgreSQL 16 cluster. Re-running them here against the real Neon
--   branch is the step that closes this migration.
--
--   The two that matter most, because they are the defect this file corrects:
--
--   CASE 1  legitimate STOP K1, erroneous suppression K2, recorded_in_error
--           naming [K2]  ->  STILL BLOCKED, suppressed_at = K1's occurred_at.
--   CASE 3  two legitimate STOPs, operator invalidates the wrong one
--           ->  STILL BLOCKED by the other. The mistake costs nothing.
--
--   Under the superseded lane-wide semantics BOTH of these unblock the lane.
--   If either returns no row, this file has been reverted to those semantics
--   and a legitimate consumer refusal is being erased.
--
-- 6.6 CLEAN UP TEST ROWS AS THE OWNER, and only as the owner. The append-only
--   grant is the point: do not grant DELETE to any application role to tidy
--   up. Identify the rows by their test phone number and remove them with the
--   owner credential, then confirm zero remain.
