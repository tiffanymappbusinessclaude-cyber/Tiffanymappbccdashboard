-- =========================================================================
-- Migration: 015c_dispatch_document_processor_sync_collect
-- Supabase version: 20260616211533
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- Replace the snapshot-bound polling loop with net.http_collect_response(async := false),
-- which is implemented to bypass the calling transaction's snapshot.
CREATE OR REPLACE FUNCTION public.dispatch_document_processor(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_composio_api_key TEXT;
  v_composio_user_id TEXT;
  v_gmail_account_id TEXT;

  v_request_id    BIGINT;
  v_collect       net.http_response_result;
  v_status_code   INT;
  v_content_text  TEXT;
  v_response_data JSONB;
  v_messages      JSONB;
  v_msg           JSONB;

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

  v_collect := net.http_collect_response(v_request_id, async := false);

  IF v_collect.status::text <> 'SUCCESS' THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary',    'Composio call status=' || v_collect.status::text
                            || ' | message=' || COALESCE(v_collect.message, '<none>')
    );
  END IF;

  v_status_code  := (v_collect.response).status_code;
  v_content_text := (v_collect.response).body;

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
        || ' | sample: ' || LEFT(v_content_text, 400)
    );
  END IF;

  FOR v_msg IN SELECT * FROM jsonb_array_elements(v_messages)
  LOOP
    v_total_seen := v_total_seen + 1;

    v_message_id := COALESCE(v_msg->>'messageId', v_msg->>'message_id', v_msg->>'id');
    v_subject    := COALESCE(v_msg->>'subject', '');
    v_sender     := COALESCE(v_msg->>'sender', v_msg->>'from', v_msg->>'fromAddress', '');
    v_thread_id  := COALESCE(v_msg->>'threadId', v_msg->>'thread_id', '');
    v_body       := COALESCE(
                       v_msg->>'messageText',
                       v_msg->>'preview',
                       v_msg->>'snippet',
                       v_msg #>> '{preview,body}',
                       ''
                     );

    IF v_message_id IS NULL OR v_message_id = '' THEN CONTINUE; END IF;

    SELECT id INTO v_existing_id
    FROM public.documents
    WHERE agency_id = p_agency_id AND drive_file_id = v_message_id
    LIMIT 1;
    IF v_existing_id IS NOT NULL THEN CONTINUE; END IF;

    v_classified_type := CASE
      WHEN LOWER(v_sender)  LIKE '%statefarm.com%' AND LOWER(v_subject) LIKE '%deduction%'   THEN 'deduction_statement'
      WHEN LOWER(v_sender)  LIKE '%statefarm.com%' AND (LOWER(v_subject) LIKE '%production%'
                                                       OR LOWER(v_subject) LIKE '%producer%')  THEN 'producer_production'
      WHEN LOWER(v_sender)  LIKE '%statefarm.com%' AND (LOWER(v_subject) LIKE '%daily comp%'
                                                       OR LOWER(v_subject) LIKE '%comp recap%'
                                                       OR LOWER(v_subject) LIKE '%commission%') THEN 'sf_daily_comp'
      WHEN LOWER(v_sender)  LIKE '%adp.com%'
        OR LOWER(v_sender)  LIKE '%gusto.com%'
        OR LOWER(v_sender)  LIKE '%paychex.com%'
        OR LOWER(v_subject) LIKE '%payroll%'                                                  THEN 'payroll'
      WHEN LOWER(v_subject) LIKE '%credit card%' OR LOWER(v_subject) LIKE '%card statement%'  THEN 'cc_statement'
      WHEN LOWER(v_subject) LIKE '%statement%' AND (LOWER(v_sender) LIKE '%chase.com%'
                                                    OR LOWER(v_sender) LIKE '%wells%'
                                                    OR LOWER(v_sender) LIKE '%truist%'
                                                    OR LOWER(v_sender) LIKE '%bankofamerica%') THEN 'bank_statement'
      ELSE 'unknown'
    END;

    CASE v_classified_type
      WHEN 'sf_daily_comp'       THEN v_count_sf_daily_comp := v_count_sf_daily_comp + 1;
      WHEN 'payroll'             THEN v_count_payroll       := v_count_payroll       + 1;
      WHEN 'bank_statement'      THEN v_count_bank          := v_count_bank          + 1;
      WHEN 'cc_statement'        THEN v_count_cc            := v_count_cc            + 1;
      WHEN 'deduction_statement' THEN v_count_deduction     := v_count_deduction     + 1;
      WHEN 'producer_production' THEN v_count_producer      := v_count_producer      + 1;
      ELSE                            v_count_unknown       := v_count_unknown       + 1;
    END CASE;

    INSERT INTO public.documents (
      agency_id, file_name, file_type, upload_source, drive_file_id,
      processing_status, processing_type, groq_classification,
      uploaded_by, uploaded_at, notes, created_at
    ) VALUES (
      p_agency_id,
      CASE WHEN v_subject = '' THEN 'gmail:' || v_message_id ELSE v_subject END,
      'email',
      'gmail',
      v_message_id,
      CASE WHEN v_classified_type = 'unknown' THEN 'deferred' ELSE 'classified' END,
      v_classified_type,
      'from: ' || v_sender,
      'dispatch_document_processor',
      v_now,
      LEFT(COALESCE(v_body, ''), 2000),
      v_now
    );

    v_total_new := v_total_new + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_total_new,
    'output_summary', format(
      'Fetched %s, queued %s new (sf_daily_comp=%s, payroll=%s, bank=%s, cc=%s, deduction=%s, producer=%s, unknown=%s)',
      v_total_seen, v_total_new,
      v_count_sf_daily_comp, v_count_payroll, v_count_bank, v_count_cc,
      v_count_deduction, v_count_producer, v_count_unknown
    ),
    'classifications', jsonb_build_object(
      'sf_daily_comp',       v_count_sf_daily_comp,
      'payroll',             v_count_payroll,
      'bank_statement',      v_count_bank,
      'cc_statement',        v_count_cc,
      'deduction_statement', v_count_deduction,
      'producer_production', v_count_producer,
      'unknown',             v_count_unknown
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.dispatch_document_processor(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_document_processor(uuid, uuid) TO service_role;
