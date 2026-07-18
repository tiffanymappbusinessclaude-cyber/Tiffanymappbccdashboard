-- =========================================================================
-- Migration: 015_document_processor
-- Supabase version: 20260616212223
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- =====================================================================
-- Migration 015: dispatch_document_processor (inbox → documents classifier)
-- =====================================================================
-- Phase-1 Document Processor. Fetches recent inbox emails via Composio Gmail,
-- classifies each by sender + subject, and inserts a row into public.documents
-- with classification + raw body. Per-format parsers (sf_daily_comp,
-- bank_statement, etc.) will read from documents.raw_content in follow-up work.
-- Idempotent: unique index on (agency_id, external_message_id) prevents
-- double-processing the same Gmail message across cron ticks.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. documents table additions
-- ---------------------------------------------------------------------
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS external_message_id text,
  ADD COLUMN IF NOT EXISTS raw_content         text;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_documents_external_message
  ON public.documents (agency_id, external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_status_class
  ON public.documents (agency_id, processing_status, groq_classification);


-- ---------------------------------------------------------------------
-- 2. classify_email_inline(sender, subject) → classification text
--    Rules ordered most-specific-first. Returns 'unclassified' as default.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.classify_email_inline(p_sender text, p_subject text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  s text := LOWER(COALESCE(p_sender,  ''));
  j text := LOWER(COALESCE(p_subject, ''));
BEGIN
  -- ----- State Farm corporate -----
  IF s LIKE '%@statefarm.com%' OR s LIKE '%statefarm.com%' THEN
    IF j ~ '(daily comp|daily compensation|comp recap|daily recap)' THEN
      RETURN 'sf_daily_comp';
    ELSIF j LIKE '%deduction%' THEN
      RETURN 'sf_deduction_statement';
    ELSIF j ~ '(producer|production report|monthly production)' THEN
      RETURN 'sf_producer_production';
    ELSIF j LIKE '%aipp%' THEN
      RETURN 'sf_aipp_statement';
    ELSIF j LIKE '%scoreboard%' THEN
      RETURN 'sf_scoreboard';
    ELSE
      RETURN 'sf_other';
    END IF;
  END IF;

  -- ----- Banks (deposit-side) — must come before credit-card rule for Chase -----
  IF (s LIKE '%@chase.com%' OR s LIKE '%chase.com%') AND j ~ '(card|credit)' THEN
    RETURN 'cc_statement_chase';
  END IF;
  IF s LIKE '%@chase.com%' OR s LIKE '%chase.com%' THEN
    RETURN 'bank_statement_chase';
  END IF;
  IF s ~ '(bankofamerica|@bofa\.|@bankofamerica)' THEN
    RETURN 'bank_statement_bofa';
  END IF;
  IF s ~ '(wellsfargo|@wells\.|@wellsfargo)' THEN
    RETURN 'bank_statement_wells';
  END IF;
  IF s ~ '(@usbank\.|usbank\.com)' THEN
    RETURN 'bank_statement_usbank';
  END IF;

  -- ----- Payroll providers -----
  IF s ~ '(@gusto\.com|@adp\.com|@paychex\.com|gusto|paylocity|@quickbooks\.)' THEN
    RETURN 'payroll_run';
  END IF;

  -- ----- BCC internal / system -----
  IF s LIKE '%<AGENCY_CLAUDE_EMAIL>%' THEN
    IF j LIKE '%daily briefing%' THEN
      RETURN 'self_briefing';
    ELSE
      RETURN 'self_test';
    END IF;
  END IF;

  -- ----- Google / Composio system notifications -----
  IF s ~ '(@google\.com|@accounts\.google\.com|noreply.*google|composio)' THEN
    RETURN 'system_notification';
  END IF;

  -- ----- Default -----
  RETURN 'unclassified';
END;
$function$;


-- ---------------------------------------------------------------------
-- 3. dispatch_document_processor — the recipe handler
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_document_processor(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_input_config     jsonb;
  v_gmail_query      text;
  v_max_results      int;
  v_wait_seconds     int;

  v_composio_api_key text;
  v_composio_user_id text;
  v_gmail_account_id text;

  v_request_id       BIGINT;
  v_status           INTEGER;
  v_content          jsonb;
  v_timed_out        boolean;
  v_error_msg        text;
  v_iter             int := 0;
  v_max_iter         int;

  v_msg              jsonb;
  v_sender           text;
  v_subject          text;
  v_message_id       text;
  v_classification   text;
  v_body             text;
  v_received         timestamptz;

  v_seen             int := 0;
  v_inserted         int := 0;
  v_skipped          int := 0;
  v_class_counts     jsonb := '{}'::jsonb;
  v_doc_id           uuid;
BEGIN
  -- ----- 1. Load recipe config with defaults -----
  SELECT input_config INTO v_input_config
  FROM public.automation_recipes WHERE id = p_recipe_id;

  v_gmail_query  := COALESCE(v_input_config->>'gmail_query',  'in:inbox newer_than:7d');
  v_max_results  := COALESCE((v_input_config->>'max_results')::int,  50);
  v_wait_seconds := COALESCE((v_input_config->>'wait_seconds')::int, 20);
  v_max_iter     := v_wait_seconds * 2;  -- 0.5s per iter

  -- ----- 2. Resolve Composio credentials -----
  v_composio_api_key := public.get_setting(p_agency_id, 'composio_api_key');
  v_composio_user_id := public.get_setting(p_agency_id, 'composio_user_id');
  v_gmail_account_id := public.get_setting(p_agency_id, 'composio_gmail_account_id');

  IF v_composio_api_key IS NULL OR v_composio_user_id IS NULL OR v_gmail_account_id IS NULL THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary',
        'Skipped: missing Composio credentials in settings (composio_api_key / composio_user_id / composio_gmail_account_id)'
    );
  END IF;

  -- ----- 3. Submit Gmail fetch -----
  SELECT net.http_post(
    url     := 'https://backend.composio.dev/api/v3/tools/execute/GMAIL_FETCH_EMAILS',
    headers := jsonb_build_object(
      'x-api-key',    v_composio_api_key,
      'Content-Type', 'application/json'),
    body := jsonb_build_object(
      'user_id',              v_composio_user_id,
      'connected_account_id', v_gmail_account_id,
      'arguments', jsonb_build_object(
        'query',           v_gmail_query,
        'max_results',     v_max_results,
        'include_payload', true
      )
    ),
    timeout_milliseconds := (v_wait_seconds * 1000) + 5000
  ) INTO v_request_id;

  -- ----- 4. Busy-wait for response (max v_wait_seconds) -----
  FOR v_iter IN 1..v_max_iter LOOP
    PERFORM pg_sleep(0.5);
    SELECT status_code, content::jsonb, timed_out, error_msg
      INTO v_status, v_content, v_timed_out, v_error_msg
      FROM net._http_response WHERE id = v_request_id;
    EXIT WHEN v_status IS NOT NULL OR v_timed_out IS TRUE;
  END LOOP;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary',
        'Timed out waiting for Composio after ' || v_wait_seconds || 's (pg_net request_id=' || v_request_id || ')'
    );
  END IF;

  IF v_status <> 200 OR v_timed_out THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary',
        'Composio returned status=' || v_status
        || COALESCE(' timed_out=' || v_timed_out::text, '')
        || COALESCE(' error=' || v_error_msg, '')
        || ' body=' || LEFT(v_content::text, 200)
    );
  END IF;

  IF COALESCE((v_content->>'successful')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary',
        'Composio reported unsuccessful: ' || COALESCE(v_content->>'error', LEFT(v_content::text, 200))
    );
  END IF;

  -- ----- 5. Iterate messages -----
  FOR v_msg IN
    SELECT * FROM jsonb_array_elements(COALESCE(v_content->'data'->'messages', '[]'::jsonb))
  LOOP
    v_seen := v_seen + 1;

    v_message_id := v_msg->>'messageId';
    v_sender     := v_msg->>'sender';
    v_subject    := v_msg->>'subject';
    v_body       := COALESCE(v_msg->>'messageText', v_msg->>'preview', '');

    -- Parse timestamp (ISO-8601 or epoch ms)
    BEGIN
      v_received := (v_msg->>'messageTimestamp')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      v_received := NOW();
    END;

    IF v_message_id IS NULL OR length(v_message_id) = 0 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_classification := public.classify_email_inline(v_sender, v_subject);

    -- Tally classification counts
    v_class_counts := jsonb_set(
      v_class_counts,
      ARRAY[v_classification],
      to_jsonb(COALESCE((v_class_counts->>v_classification)::int, 0) + 1)
    );

    -- Insert (skip on duplicate via unique constraint)
    INSERT INTO public.documents (
      agency_id, file_name, file_type, upload_source,
      processing_status, processing_type, groq_classification,
      external_message_id, raw_content,
      uploaded_by, uploaded_at, notes, created_at
    ) VALUES (
      p_agency_id,
      LEFT(COALESCE(v_subject, '(no subject)'), 500),
      'email',
      'gmail',
      'classified',                                  -- ready for parser stage
      'email_classify',
      v_classification,
      v_message_id,
      v_body,
      'dispatch_document_processor',
      v_received,
      'From: ' || COALESCE(v_sender, '(unknown)'),
      NOW()
    )
    ON CONFLICT (agency_id, external_message_id) WHERE external_message_id IS NOT NULL
    DO NOTHING
    RETURNING id INTO v_doc_id;

    IF v_doc_id IS NOT NULL THEN
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed',   v_inserted,
    'output_summary',
      'Fetched ' || v_seen || ' messages, inserted ' || v_inserted
        || ' new documents (' || (v_seen - v_inserted - v_skipped) || ' duplicates'
        || CASE WHEN v_skipped > 0 THEN ', ' || v_skipped || ' skipped' ELSE '' END
        || ')',
    'classification_counts', v_class_counts,
    'pg_net_request_id',   v_request_id
  );
END;
$function$;

REVOKE ALL    ON FUNCTION public.dispatch_document_processor(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_document_processor(uuid, uuid) TO service_role;
REVOKE ALL    ON FUNCTION public.classify_email_inline(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.classify_email_inline(text, text) TO service_role, authenticated, anon;