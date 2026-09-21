-- 004 — website re-opt-in readiness: the two-factor question, asked in one place
--
-- WHAT THIS ADDS
--   * get_reoptin_readiness(text, text, integer) — NEW. One row, always.
--     Answers, for one number and one lane: which lanes are actively
--     blocked, and is there a fresh website consent that POST-DATES every
--     refusal it would have to supersede.
--   * consent_ledger_reoptin — the re-opt-in role: INSERT + EXECUTE on that
--     one function, and nothing else.
--
-- WHAT THIS DOES NOT DO
--   It does not alter communication_consent_events, and it does not edit
--   db/001, db/002 or db/003. All three are applied historical artifacts and
--   must stay byte-identical to what was run. Every column this migration
--   reads already exists in db/001.
--
--   It decides nothing. The function REPORTS two facts; api/_lib/reoptin.mjs
--   decides, and api/twilio-inbound.js acts only on a signed provider START.
--   A row returned here has cleared no block: clearance is still an
--   `unsuppressed`/`consumer_request` APPEND, folded by db/003 exactly as the
--   operator workflow's is.
--
-- ---------------------------------------------------------------------
-- WHY A READ EXISTS AT ALL, AND WHY IT IS NOT THE WEBSITE'S
-- ---------------------------------------------------------------------
-- db/002 states the rule this migration must not break: the website role
-- (consent_ledger_app) holds INSERT and NO read, so a leaked
-- CONSENT_LEDGER_URL cannot enumerate the numbers and consent decisions in
-- the table, and it is REFUSED get_suppression_state. That refusal stands —
-- this file grants the website role nothing.
--
-- The re-opt-in reconciliation needs to read, so it gets its OWN credential.
-- Its blast radius is the operator role's MINUS get_active_blocks: it can
-- append rows and ask this one question about one number at a time. It
-- cannot enumerate, cannot read whole blocking rows, and cannot learn a
-- number the caller does not already hold.
--
-- ---------------------------------------------------------------------
-- WHAT "FRESH CONSENT" MEANS HERE, AND WHY EACH CLAUSE IS LOAD-BEARING
-- ---------------------------------------------------------------------
-- A consent row qualifies only when ALL of these hold. Each one is a
-- separate way a forged or stale web form could otherwise resurrect a
-- stopped number.
--
--   channel = p_channel        An SMS re-opt-in never reads a voice consent.
--                              The two permissions are separate everywhere
--                              else in this system and are separate here.
--
--   source = 'website'         Only a submission that DISPLAYED a disclosure
--                              can evidence agreement to one. A provider or
--                              operator row carries no disclosure text.
--
--   event_type = 'consent_selected'
--                              A ticked box. `consent_not_selected` is the
--                              record of NOT ticking and must never read as
--                              a grant.
--
--   occurred_at > occurred_bar AND recorded_at > recorded_bar
--                              THE CONSENT MUST POST-DATE THE REFUSAL, on
--                              BOTH clocks, STRICTLY.
--
--                              Two clocks for the same reason db/003 folds on
--                              two: a STOP webhook can be delayed or
--                              redelivered and land AFTER a consent while
--                              carrying an EARLIER occurred_at. Requiring the
--                              consent to beat the refusal on event time
--                              alone would let a late-arriving opt-out be
--                              silently overtaken by a form filled before it.
--
--                              STRICT `>`, so an exact tie answers NO and the
--                              block stands. db/003 resolves its own ties
--                              toward more blocking; so does this.
--
--                              The bar spans p_channel AND 'all', because a
--                              global do-not-contact dominates the lane. A
--                              channel-specific consent must not step over a
--                              refusal that was not channel-specific.
--
--   occurred_at >= now() - p_max_age_seconds
--                              FRESHNESS. This is the window in which a
--                              forged submission stays "armed" waiting for
--                              the phone's owner to send START for their own
--                              reasons. Shorter is safer; the caller owns the
--                              number and states its reasoning.
--
--                              A NULL or negative p_max_age_seconds yields a
--                              window that matches nothing, which is the
--                              fail-closed direction and not an oversight.
--
--   occurred_at <= now()       A future-dated row cannot evidence a decision
--                              that has not happened.
--
-- NOT CHECKED HERE, and deliberately not pretended: that the person who
-- submitted the form is the person holding the handset. Nothing in a web
-- form can establish that. It is established by the signed Twilio START the
-- caller requires alongside this answer, and by nothing else.
--
-- ---------------------------------------------------------------------
-- APPLY THIS AS THE TABLE OWNER
-- ---------------------------------------------------------------------
-- The function must be created by the role that owns
-- communication_consent_events (neondb_owner — the credential that applied
-- db/001, db/002 and db/003), because SECURITY DEFINER executes with the
-- OWNER's rights and that is the whole mechanism.
--
-- Replace <reoptin_role> and <reoptin_password> before running. The re-opt-in
-- credential goes to CONSENT_LEDGER_REOPTIN_URL only. It is not the
-- website's, not the sender's, not the operator's, and never the owner's.


-- ---------------------------------------------------------------------
-- 1. THE RE-OPT-IN ROLE
-- ---------------------------------------------------------------------
-- LOGIN, INSERT, and EXECUTE on exactly one function. No table SELECT, no
-- UPDATE, no DELETE, no TRUNCATE, no DDL, no ownership, and no
-- get_active_blocks: this path corrects nothing and has no use for whole
-- blocking rows.

CREATE ROLE <reoptin_role> LOGIN PASSWORD '<reoptin_password>';

GRANT INSERT ON communication_consent_events TO <reoptin_role>;


-- ---------------------------------------------------------------------
-- 2. THE FUNCTION
-- ---------------------------------------------------------------------
-- EXACTLY ONE ROW, ALWAYS. `lanes` is an aggregate with no GROUP BY, so it
-- produces one row even for a number this table has never seen, and the
-- LEFT JOIN keeps it when no consent qualifies. A caller therefore never has
-- to distinguish "no rows" from "no answer" — an empty result set would be
-- indistinguishable from a lookup that silently matched nothing.
--
-- IT REPORTS EVERY LANE, not only p_channel's. The caller must be able to
-- see an `all` lane and refuse: an SMS re-opt-in does not clear a global
-- do-not-contact, and a function that returned only the lane it was asked
-- about would hide that.
--
-- NO reason_code, NO evidence_text, NO metadata, NO dedupe_key OF A BLOCK.
-- This is not the operator's lookup and must not become it. The only
-- dedupe_key returned names the CONSENT row, which the caller writes into
-- the clearance so the clearance names its own justification.
--
-- STABLE, not IMMUTABLE: it reads the table and calls now().

CREATE FUNCTION get_reoptin_readiness(
  p_phone           text,
  p_channel         text,
  p_max_age_seconds integer
)
RETURNS TABLE (
  -- ONE COLUMN PER LANE, and a TIMESTAMP rather than a boolean: NULL means
  -- the lane is not blocked, a value means it has been blocked since then.
  --
  -- Three named columns rather than one text[] because `text` and
  -- `timestamptz` are the two types this project has already carried over
  -- the Neon HTTP driver in get_suppression_state() and get_active_blocks().
  -- An array would add a wire representation nothing here has exercised, and
  -- a caller that mis-parsed `{sms}` as "no lanes blocked" would fail OPEN.
  -- The lanes are a closed set of three; naming them costs a migration only
  -- if that ever stops being true.
  blocked_sms_at        timestamptz,
  blocked_ai_voice_at   timestamptz,
  blocked_all_at        timestamptz,
  consent_dedupe_key    text,
  consent_occurred_at   timestamptz,
  consent_version       text,
  consent_form_type     text,
  consent_page_path     text,
  consent_submission_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- MANDATORY, NOT DECORATIVE — the same reasoning db/002 and db/003 record.
-- Without a fixed search_path a caller can create their own object named
-- communication_consent_events earlier in their search_path and have it read
-- with the owner's rights. Silent, and the classic SECURITY DEFINER hole.
SET search_path = pg_catalog, public
AS $$
  WITH blocks AS (
    -- db/003's ONE definition of an active blocking event, reused rather
    -- than restated. A second copy of that fold here would be a second
    -- definition free to drift from the one send-time enforcement obeys.
    SELECT a.channel, a.occurred_at, a.recorded_at
    FROM public._active_consent_blocks(p_phone) a
  ),
  lanes AS (
    -- The EARLIEST active refusal per lane, matching get_suppression_state's
    -- rule that the first refusal is the one that matters and a later
    -- duplicate STOP does not restart the clock. One aggregate per lane, each
    -- over a single column, so db/002's independent-aggregate mis-pairing
    -- cannot reappear here.
    SELECT min(b.occurred_at) FILTER (WHERE b.channel = 'sms')      AS sms_at,
           min(b.occurred_at) FILTER (WHERE b.channel = 'ai_voice') AS ai_voice_at,
           min(b.occurred_at) FILTER (WHERE b.channel = 'all')      AS all_at
    FROM blocks b
  ),
  bar AS (
    -- The high-water mark the consent must beat, on both clocks. '-infinity'
    -- rather than NULL: a NULL bar would make every comparison below NULL
    -- and return no consent at all for an unblocked number, which is a
    -- different and wrong answer from "nothing blocks this number".
    SELECT COALESCE(max(b.occurred_at), '-infinity'::timestamptz) AS occurred_bar,
           COALESCE(max(b.recorded_at), '-infinity'::timestamptz) AS recorded_bar
    FROM blocks b
    WHERE b.channel = p_channel OR b.channel = 'all'
  ),
  consent AS (
    SELECT e.dedupe_key, e.occurred_at, e.consent_copy_version,
           e.form_type, e.page_path, e.submission_id
    FROM public.communication_consent_events e, bar
    WHERE e.phone_e164  = p_phone
      AND e.channel     = p_channel
      AND e.event_type  = 'consent_selected'
      AND e.source      = 'website'
      AND e.occurred_at > bar.occurred_bar
      AND e.recorded_at > bar.recorded_bar
      AND e.occurred_at >= now() - make_interval(secs => p_max_age_seconds)
      AND e.occurred_at <= now()
    -- The NEWEST qualifying consent. A person may submit twice; the clearance
    -- should name the decision closest to the START that confirmed it.
    ORDER BY e.occurred_at DESC, e.recorded_at DESC, e.event_id
    LIMIT 1
  )
  SELECT lanes.sms_at, lanes.ai_voice_at, lanes.all_at,
         c.dedupe_key, c.occurred_at, c.consent_copy_version,
         c.form_type, c.page_path, c.submission_id
  FROM lanes LEFT JOIN consent c ON true;
$$;


-- ---------------------------------------------------------------------
-- 3. THE GRANTS — RE-STATED, NEVER INHERITED
-- ---------------------------------------------------------------------
-- MANDATORY. PostgreSQL grants EXECUTE on a NEW function to PUBLIC by
-- default, so creating one without the REVOKE hands it to every role in the
-- database — including the website's INSERT-only role, whose entire purpose
-- is that it cannot read this table.
--
-- THE MATRIX THIS MUST PRODUCE, added to db/003's:
--
--   role                    table        get_reoptin_readiness
--   ----------------------  -----------  ---------------------
--   <application_role>      INSERT only  no
--   <sender_role>           none         no
--   <operator_role>         INSERT only  no
--   <reoptin_role>          INSERT only  EXECUTE
--   PUBLIC                  none         revoked
--
-- THE SENDER DOES NOT GET IT. Gate 8 asks "may I send?" and is answered by
-- get_suppression_state. Handing the live send path a consent-evidence read
-- would widen it for nothing.
--
-- THE OPERATOR DOES NOT GET IT EITHER. The human workflow decides from
-- get_active_blocks and a typed attestation, not from a web form's freshness.

REVOKE EXECUTE ON FUNCTION get_reoptin_readiness(text, text, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_reoptin_readiness(text, text, integer) TO <reoptin_role>;


-- ---------------------------------------------------------------------
-- 4. VERIFY BEFORE CONFIGURING CONSENT_LEDGER_REOPTIN_URL
-- ---------------------------------------------------------------------
-- FIVE credentials now. Neon's SQL Editor runs everything as the branch owner
-- and offers no role selector, so the refusals must be proven either with a
-- real login as each role or under SET ROLE — and if you use SET ROLE,
-- remember RESET ROLE afterwards or every later statement in that session
-- silently runs as the wrong role.
--
-- 4.1 THE HARDENING ACTUALLY LANDED. As the OWNER:
--
--   SELECT proname, prosecdef, proconfig FROM pg_proc
--    WHERE proname = 'get_reoptin_readiness';
--
--   prosecdef must be `t`; proconfig must contain
--   search_path=pg_catalog, public. If proconfig is null the function must be
--   DROPPED AND RECREATED, not patched in place.
--
-- 4.2 THE ACL IS WHAT SECTION 3 INTENDED. As the OWNER:
--
--   SELECT proname, proacl FROM pg_proc WHERE proname = 'get_reoptin_readiness';
--
--   Confirm PUBLIC (the empty grantee "=X/") does not appear, and that the
--   ONLY application role named is <reoptin_role>.
--
-- 4.3 THE REFUSALS. As each role in turn — expect PERMISSION DENIED:
--
--   as <application_role>: SELECT * FROM get_reoptin_readiness('+15555550100','sms',1209600);
--   as <sender_role>:      SELECT * FROM get_reoptin_readiness('+15555550100','sms',1209600);
--   as <operator_role>:    SELECT * FROM get_reoptin_readiness('+15555550100','sms',1209600);
--   as <reoptin_role>:     SELECT count(*) FROM communication_consent_events;
--   as <reoptin_role>:     SELECT * FROM get_active_blocks('+15555550100');
--   as <reoptin_role>:     SELECT * FROM get_suppression_state('+15555550100');
--   as <reoptin_role>:     UPDATE communication_consent_events SET channel='x';
--   as <reoptin_role>:     DELETE FROM communication_consent_events;
--   as <reoptin_role>:     TRUNCATE communication_consent_events;
--
-- 4.4 THE SUCCESSES:
--
--   as <reoptin_role>: SELECT * FROM get_reoptin_readiness('+1555...','sms',1209600);
--                      -- EXACTLY ONE ROW, nine columns, even for an unknown
--                      -- number — every column NULL in that case
--   as <reoptin_role>: INSERT INTO communication_consent_events (...) ...;
--
-- 4.5 THE SEMANTIC CASES. tests/reoptin-fold.test.mjs runs the full matrix
--   against a real PostgreSQL 16 cluster on every CI run. The two that matter
--   most, because they are what this function exists to refuse:
--
--   CASE  consent BEFORE the STOP, START after  -> consent_dedupe_key NULL.
--         A submission made before the refusal is not a re-opt-in.
--   CASE  STOP redelivered late (earlier occurred_at, later recorded_at) than
--         a consent  -> consent_dedupe_key NULL. The two-clock rule.
--
-- 4.6 CLEAN UP TEST ROWS AS THE OWNER, and only as the owner. Do not grant
--   DELETE to any application role to tidy up.
