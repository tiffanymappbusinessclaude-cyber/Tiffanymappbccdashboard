-- =========================================================================
-- Migration: 015b_dispatch_document_processor_extended_timeout
-- Supabase version: 20260616211223
-- Captured from production DB: 2026-06-17
-- Note: superseded by 015c (sync_collect). Doubles polling window to 60s,
-- allows recipe input_config.gmail_query to override default query.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.dispatch_document_processor(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_composio_api_key TEXT;
  v_composio_user_id TEXT;
  v_gmail_account_id TEXT;

  v_request_id   BIGINT;
  v_status_code  INT;
  v_content_text TEXT;
  v_response_data JSONB;
  v_messages     JSONB;
  v_msg          JSONB;
  v_attempts     INT;
  v_max_attempts CONSTANT INT := 120;

  v_message_id      TEXT;
  v_subject         TEXT;
  v_sender          TEXT;
  v_body            TEXT;
  v_thread_id       TEXT;
  v_classified_type TEXT;
  v_existing_id     UUID;

  v_total_seen          INT := 0;
  v_total_new           INT := 0;
  v_count_sf_daily_comp INT := 0;
  v_count_payroll       INT := 0;
  v_count_bank          INT := 0;
  v_count_cc            INT := 0;
  v_count_deduction     INT := 0;
  v_count_producer      INT := 0;
  v_count_unknown       INT := 0;

  v_now   TIMESTAMPTZ := NOW();
  v_query TEXT;
BEGIN
  v_composio_api_key := public.get_setting(p_agency_id, 'composio_api_key');
  v_composio_user_id := public.get_setting(p_agency_id, 'composio_user_id');
  v_gmail_account_id := public.get_setting(p_agency_id, 'composio_gmail_account_id');

  IF v_composio_api_key IS NULL OR v_composio_user_id IS NULL OR v_gmail_account_id IS NULL THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary',
      'Skipped: missing composio_api_key / composio_user_id / composio_gmail_account_id in settings'
    );
  END IF;

  SELECT input_config->>'gmail_query'
  INTO v_query
  FROM public.automation_recipes
  WHERE id = p_recipe_id;

  IF v_query IS NULL OR length(trim(v_query)) = 0 THEN
    v_query :=
      'newer_than:1d ('
      || 'from:statefarm.com OR from:adp.com OR from:gusto.com OR from:paychex.com '
      || 'OR from:chase.com OR from:wellsfargo.com OR from:truist.com OR from:bankofamerica.com '
      || 'OR subject:"Daily Comp" OR subject:"Production Report" OR subject:"Deduction"'
      || ')';
  END IF;

  SELECT net.http_post(
    url     := 'https://backend.composio.dev/api/v3/tools/execute/GMAIL_FETCH_EMAILS',
    headers := jsonb_build_object(
      'x-api-key',    v_composio_api_key,
      'Content-Type', 'application/json'
    ),
    body    := jsonb_build_object(
      'user_id',              v_composio_user_id,
      'connected_account_id', v_gmail_account_id,
      'arguments', jsonb_build_object(
        'query',              v_query,
        'max_results',        50,
        'include_payload',    true,
        'include_spam_trash', false
      )
    ),
    timeout_milliseconds := 60000
  ) INTO v_request_id;

  v_attempts := 0;
  LOOP
    EXIT WHEN v_attempts >= v_max_attempts;
    SELECT r.status_code, r.content::text
      INTO v_status_code, v_content_text
    FROM net._http_response r
    WHERE r.id = v_request_id;
    EXIT WHEN v_status_code IS NOT NULL;
    PERFORM pg_sleep(0.5);
    v_attempts := v_attempts + 1;
  END LOOP;

  IF v_status_code IS NULL THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary',    'Timed out after 60s waiting for Composio (request_id ' || v_request_id::text || ')'
    );
  END IF;

  IF v_status_code >= 400 THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary',
        'Composio returned HTTP ' || v_status_code || ': ' || LEFT(COALESCE(v_content_text, ''), 300)
    );
  END IF;

  BEGIN
    v_response_data := v_content_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary', 'Composio response was not valid JSON: ' || LEFT(COALESCE(v_content_text, ''), 200)
    );
  END;

  v_messages := COALESCE(
    v_response_data #> '{data,response_data,messages}',
    v_response_data #> '{data,data,messages}',
    v_response_data #> '{data,messages}',
    v_response_data #> '{response_data,messages}',
    v_response_data -> 'messages',
    '[]'::jsonb
  );

  IF v_messages IS NULL OR jsonb_typeof(v_messages) <> 'array' THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary',
        'No messages array found. Top-level keys: '
        || COALESCE((SELECT string_agg(k, ',') FROM jsonb_object_keys(v_response_data) k), '<none>')
        || ' | sample: ' || LEF[(v_content_text, 400)]
    );
  END IF;

  -- (Classification + insert loop body identical to 015 — omitted here for brevity in repo.
  -- See 015c_dispatch_document_processor_sync_collect.sql for the final running version.)
  RETURN jsonb_build_object('records_processed', 0, 'output_summary', 'Superseded by 015c');
END;
$function$;

REVOKE ALL ON FUNCTION public.dispatch_document_processor(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_document_processor(uuid, uuid) TO service_role;
