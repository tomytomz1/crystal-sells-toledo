-- 005 — automatic website SMS re-opt-in completion
--
-- A previous STOP is never cleared merely because a website checkbox was
-- ticked. The application must first prove two things outside this function:
--   1. a fresh website SMS consent exists after the active refusal; and
--   2. Twilio's Consent Management API successfully processed BOTH required
--      opt-in records for the number: the Messaging Service and the actual
--      sender phone number.
--
-- This function then re-validates the durable consent/block state inside the
-- database and appends the SMS lane clearance. It never edits or deletes the
-- historical STOP row. Gate 8 still performs the final durable suppression
-- read immediately before any outbound message.
--
-- APPLY AS neondb_owner. Replace <reoptin_role> with the dedicated role
-- created by db/004 (production: consent_ledger_reoptin).

CREATE FUNCTION complete_website_sms_reoptin(
  p_phone               text,
  p_consent_dedupe_key  text,
  p_provider_event_id   text,
  p_provider_metadata   jsonb,
  p_max_age_seconds     integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  r record;
  inserted_count integer := 0;
BEGIN
  -- Fail closed on malformed caller input. The application already normalises
  -- the phone, but the durable boundary must not trust that fact implicitly.
  IF p_phone IS NULL OR p_phone !~ '^\+[1-9][0-9]{10,14}$' THEN
    RETURN 0;
  END IF;

  IF p_consent_dedupe_key IS NULL OR btrim(p_consent_dedupe_key) = '' THEN
    RETURN 0;
  END IF;

  -- source_event_id becomes part of an append-only dedupe key. A colon would
  -- make the key ambiguous because this project's key format uses colons as
  -- separators.
  IF p_provider_event_id IS NULL
     OR p_provider_event_id !~ '^[A-Za-z0-9_-]{1,180}$' THEN
    RETURN 0;
  END IF;

  IF p_max_age_seconds IS NULL OR p_max_age_seconds <= 0 THEN
    RETURN 0;
  END IF;

  IF p_provider_metadata IS NOT NULL
     AND jsonb_typeof(p_provider_metadata) <> 'object' THEN
    RETURN 0;
  END IF;

  -- db/004 is the one definition of website re-opt-in readiness. Re-read it
  -- NOW, after the provider confirmation, instead of trusting a result the
  -- application obtained before its Twilio request.
  SELECT * INTO r
    FROM public.get_reoptin_readiness(
      p_phone,
      'sms',
      p_max_age_seconds
    );

  -- SMS only. A global do-not-contact dominates and is never automatically
  -- cleared. The exact consent row named by the caller must still be the
  -- newest qualifying website consent after the active refusal.
  IF r.blocked_sms_at IS NULL
     OR r.blocked_all_at IS NOT NULL
     OR r.consent_dedupe_key IS NULL
     OR r.consent_dedupe_key IS DISTINCT FROM btrim(p_consent_dedupe_key) THEN
    RETURN 0;
  END IF;

  INSERT INTO public.communication_consent_events (
    occurred_at,
    channel,
    event_type,
    phone_e164,
    source,
    source_event_id,
    dedupe_key,
    submission_id,
    form_type,
    page_path,
    consent_copy_version,
    consent_copy_text,
    schema_version,
    reason_code,
    evidence_text,
    metadata
  ) VALUES (
    now(),
    'sms',
    'unsuppressed',
    p_phone,
    'twilio',
    p_provider_event_id,
    'twilio:' || p_provider_event_id || ':sms:unsuppressed',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    1,
    'consumer_request',
    NULL,
    -- Caller-supplied provider diagnostics are descriptive only. Critical
    -- audit fields are appended AFTER them so they cannot be overridden.
    COALESCE(p_provider_metadata, '{}'::jsonb) || jsonb_build_object(
      'reoptin_confirmation', 'twilio_consent_api',
      'consent_dedupe_key', r.consent_dedupe_key,
      'consent_occurred_at', r.consent_occurred_at,
      'consent_copy_version', r.consent_version,
      'consent_submission_id', r.consent_submission_id,
      'consent_form_type', r.consent_form_type,
      'consent_page_path', r.consent_page_path
    )
  )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Revoke it
-- before admitting the one dedicated credential.
REVOKE EXECUTE ON FUNCTION complete_website_sms_reoptin(text, text, text, jsonb, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_website_sms_reoptin(text, text, text, jsonb, integer)
  TO <reoptin_role>;

-- Verification, as owner:
--
-- SELECT proname, prosecdef, proconfig, proacl
--   FROM pg_proc
--  WHERE oid = 'public.complete_website_sms_reoptin(text,text,text,jsonb,integer)'::regprocedure;
--
-- Expected:
--   prosecdef = true
--   proconfig contains search_path=pg_catalog, public
--   PUBLIC has no EXECUTE
--   <reoptin_role> has EXECUTE
--
-- The role still must NOT receive SELECT/UPDATE/DELETE/TRUNCATE on
-- communication_consent_events and must not receive any broader role
-- membership. db/004's privilege matrix remains in force.