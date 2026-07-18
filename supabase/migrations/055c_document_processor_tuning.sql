-- =========================================================================
-- Migration: 015b_document_processor_tuning
-- Supabase version: 20260616212443
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- 015b: tune default fetch window, batch size, and wait budget on dispatch_document_processor.
-- Replaces the previous body. Only the three defaults change; logic identical.

DROP FUNCTION IF EXISTS public._test_net_read_from_secdef();

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
  SELECT input_config INTO v_input_config
  FROM public.automation_recipes WHERE id = p_recipe_id;

  -- Defaults tuned for steady-state operation:
  --   newer_than:1d  — only catch the last day's mail per tick (cron runs every 30 min)
  --   max_results=20 — bounded work per tick
  --   wait_seconds=45 — generous budget for Composio with full payloads
  v_gmail_query  := COALESCE(v_input_config->>'gmail_query',  'in:inbox newer_than:1d');
  v_max_results  := COALESCE((v_input_config->>'max_results')::int,  20);
  v_wait_seconds := COALESCE((v_input_config->>'wait_seconds')::int, 45);
  v_max_iter     := v_wait_seconds * 2;

  v_composio_api_key := public.get_setting(p_agency_id, 'composio_api_key');
  v_composio_user_id := public.get_setting(p_agency_id, 'composio_user_id');
  v_gmail_account_id := public.get_setting(p_agency_id, 'composio_gmail_account_id');

  IF v_composio_api_key IS NULL OR v_composio_user_id IS NULL OR v_gmail_account_id IS NULL THEN
    RETURN jsonb_build_object('records_processed', 0,
      'output_summary', 'Skipped: missing Composio credentials in settings');
  END IF;

  SELECT net.http_post(
    url     := 'https://backend.composio.dev/api/v3/tools/execute/GMAIL_FETCH_EMAILS',
    headers := jsonb_build_object('x-api-key', v_composio_api_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object(
      'user_id', v_composio_user_id,
      'connected_account_id', v_gmail_account_id,
      'arguments', jsonb_build_object(
        'query', v_gmail_query,
        'max_results', v_max_results,
        'include_payload', true
      )
    ),
    timeout_milliseconds := (v_wait_seconds * 1000) + 5000
  ) INTO v_request_id;

  FOR v_iter IN 1..v_max_iter LOOP
    PERFORM pg_sleep(0.5);
    SELECT status_code, content::jsonb, timed_out, error_msg
      INTO v_status, v_content, v_timed_out, v_error_msg
      FROM net._http_response WHERE id = v_request_id;
    EXIT WHEN v_status IS NOT NULL OR v_timed_out IS TRUE;
  END LOOP;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object('records_processed', 0,
      'output_summary', 'Timed out after ' || v_wait_seconds || 's (pg_net request_id=' || v_request_id || ')');
  END IF;
  IF v_status <> 200 OR v_timed_out THEN
    RETURN jsonb_build_object('records_processed', 0,
      'output_summary', 'Composio status=' || v_status
        || COALESCE(' err=' || v_error_msg, '') || ' body=' || LEFT(v_content::text, 200));
  END IF;
  IF COALESCE((v_content->>'successful')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('records_processed', 0,
      'output_summary', 'Composio unsuccessful: ' || COALESCE(v_content->>'error', LEFT(v_content::text, 200)));
  END IF;

  FOR v_msg IN
    SELECT * FROM jsonb_array_elements(COALESCE(v_content->'data'->'messages', '[]'::jsonb))
  LOOP
    v_seen := v_seen + 1;
    v_message_id := v_msg->>'messageId';
    v_sender     := v_msg->>'sender';
    v_subject    := v_msg->>'subject';
    v_body       := COALESCE(v_msg->>'messageText', v_msg->>'preview', '');

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
    v_class_counts := jsonb_set(
      v_class_counts, ARRAY[v_classification],
      to_jsonb(COALESCE((v_class_counts->>v_classification)::int, 0) + 1)
    );

    INSERT INTO public.documents (
      agency_id, file_name, file_type, upload_source,
      processing_status, processing_type, groq_classification,
      external_message_id, raw_content,
      uploaded_by, uploaded_at, notes, created_at
    ) VALUES (
      p_agency_id,
      LEFT(COALESCE(v_subject, '(no subject)'), 500),
      'email', 'gmail',
      'classified', 'email_classify', v_classification,
      v_message_id, v_body,
      'dispatch_document_processor', v_received,
      'From: ' || COALESCE(v_sender, '(unknown)'), NOW()
    )
    ON CONFLICT (agency_id, external_message_id) WHERE external_message_id IS NOT NULL
    DO NOTHING
    RETURNING id INTO v_doc_id;

    IF v_doc_id IS NOT NULL THEN
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_inserted,
    'output_summary',
      'Fetched ' || v_seen || ' messages, inserted ' || v_inserted
        || ' new (' || (v_seen - v_inserted - v_skipped) || ' duplicates'
        || CASE WHEN v_skipped > 0 THEN ', ' || v_skipped || ' skipped' ELSE '' END
        || ')',
    'classification_counts', v_class_counts,
    'pg_net_request_id', v_request_id
  );
END;
$function$;

REVOKE ALL    ON FUNCTION public.dispatch_document_processor(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_document_processor(uuid, uuid) TO service_role;