-- =========================================================================
-- Migration: 018_email_archiver
-- Supabase version: 20260617023139
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- Migration 018: dispatch_email_archiver + email_archiver_jobs
-- Pattern mirrors dispatch_document_processor (async via pg_net,
-- two-tick fetch->process cycle).

-- ----- 1. Jobs table -----
CREATE TABLE IF NOT EXISTS public.email_archiver_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL,
  recipe_id uuid NOT NULL,
  pg_net_request_id bigint,
  archive_pg_net_request_id bigint,
  gmail_query text,
  max_results int,
  status text NOT NULL DEFAULT 'fetching',
  submitted_at timestamptz NOT NULL DEFAULT NOW(),
  processed_at timestamptz,
  records_processed int DEFAULT 0,
  records_archived int DEFAULT 0,
  error_msg text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_archiver_jobs_pending
  ON public.email_archiver_jobs(agency_id, status, submitted_at)
  WHERE status = 'fetching';

-- ----- 2. Handler function -----
CREATE OR REPLACE FUNCTION public.dispatch_email_archiver(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_input_config     jsonb;
  v_archive_days     int;
  v_preserve_starred boolean;
  v_max_results      int;
  v_abandon_minutes  int;
  v_gmail_query      text;
  v_composio_api_key text;
  v_composio_user_id text;
  v_gmail_account_id text;
  v_job              RECORD;
  v_resp_status      int;
  v_resp_content     jsonb;
  v_resp_timed_out   boolean;
  v_resp_error       text;
  v_msg              jsonb;
  v_sender           text;
  v_subject          text;
  v_message_id       text;
  v_body             text;
  v_received         timestamptz;
  v_seen             int := 0;
  v_logged           int := 0;
  v_archive_ids      text[] := ARRAY[]::text[];
  v_archive_request_id bigint;
  v_new_request_id   bigint;
  v_new_job_id       uuid;
  v_summary_parts    text[] := ARRAY[]::text[];
  v_total_archived   int := 0;
BEGIN
  SELECT input_config INTO v_input_config
  FROM public.automation_recipes WHERE id = p_recipe_id;

  v_archive_days     := COALESCE((v_input_config->>'archive_older_than_days')::int, 30);
  v_preserve_starred := COALESCE((v_input_config->>'preserve_starred')::boolean, true);
  v_max_results      := COALESCE((v_input_config->>'max_results')::int, 25);
  v_abandon_minutes  := COALESCE((v_input_config->>'abandon_minutes')::int, 30);

  v_gmail_query := 'in:inbox older_than:' || v_archive_days || 'd';
  IF v_preserve_starred THEN
    v_gmail_query := v_gmail_query || ' -is:starred';
  END IF;

  FOR v_job IN
    SELECT * FROM public.email_archiver_jobs
    WHERE agency_id = p_agency_id AND status = 'fetching'
    ORDER BY submitted_at ASC
  LOOP
    IF v_job.submitted_at < NOW() - (v_abandon_minutes || ' minutes')::interval THEN
      SELECT status_code INTO v_resp_status
      FROM net._http_response WHERE id = v_job.pg_net_request_id;

      IF v_resp_status IS NULL THEN
        UPDATE public.email_archiver_jobs
        SET status = 'abandoned', processed_at = NOW(),
            error_msg = 'No response within ' || v_abandon_minutes || ' minutes'
        WHERE id = v_job.id;
        v_summary_parts := v_summary_parts ||
          ('abandoned job ' || v_job.id::text || ' (pg_net=' || v_job.pg_net_request_id || ')');
        CONTINUE;
      END IF;
    END IF;

    SELECT status_code, content::jsonb, timed_out, error_msg
    INTO v_resp_status, v_resp_content, v_resp_timed_out, v_resp_error
    FROM net._http_response WHERE id = v_job.pg_net_request_id;

    IF v_resp_status IS NULL THEN
      v_summary_parts := v_summary_parts ||
        ('job ' || v_job.id::text || ' still in flight');
      CONTINUE;
    END IF;

    IF v_resp_status <> 200 OR v_resp_timed_out THEN
      UPDATE public.email_archiver_jobs
      SET status = 'failed', processed_at = NOW(),
          error_msg = 'status=' || v_resp_status
            || COALESCE(' timed_out=' || v_resp_timed_out::text, '')
            || COALESCE(' err=' || v_resp_error, '')
      WHERE id = v_job.id;
      v_summary_parts := v_summary_parts ||
        ('failed job ' || v_job.id::text || ' (status=' || v_resp_status || ')');
      CONTINUE;
    END IF;

    IF COALESCE((v_resp_content->>'successful')::boolean, false) IS NOT TRUE THEN
      UPDATE public.email_archiver_jobs
      SET status = 'failed', processed_at = NOW(),
          error_msg = 'Composio unsuccessful: '
            || COALESCE(v_resp_content->>'error', LEFT(v_resp_content::text, 200))
      WHERE id = v_job.id;
      v_summary_parts := v_summary_parts ||
        ('failed job ' || v_job.id::text || ' (Composio unsuccessful)');
      CONTINUE;
    END IF;

    v_seen := 0; v_logged := 0;
    v_archive_ids := ARRAY[]::text[];

    FOR v_msg IN
      SELECT * FROM jsonb_array_elements(COALESCE(v_resp_content->'data'->'messages', '[]'::jsonb))
    LOOP
      v_seen := v_seen + 1;
      v_message_id := v_msg->>'messageId';
      v_sender     := v_msg->>'sender';
      v_subject    := v_msg->>'subject';
      v_body       := COALESCE(v_msg->>'messageText', v_msg->>'preview', '');

      BEGIN v_received := (v_msg->>'messageTimestamp')::timestamptz;
      EXCEPTION WHEN OTHERS THEN v_received := NOW();
      END;

      IF v_message_id IS NULL OR length(v_message_id) = 0 THEN
        CONTINUE;
      END IF;

      INSERT INTO public.documents (
        agency_id, file_name, file_type, upload_source,
        processing_status, processing_type,
        external_message_id, raw_content,
        uploaded_by, uploaded_at, processed_at, notes, created_at
      ) VALUES (
        p_agency_id,
        LEFT(COALESCE(v_subject, '(no subject)'), 500),
        'email', 'gmail_archive',
        'archived', 'email_archive',
        v_message_id, v_body,
        'dispatch_email_archiver', v_received, NOW(),
        'Archived from inbox; From: ' || COALESCE(v_sender, '(unknown)'),
        NOW()
      )
      ON CONFLICT (agency_id, external_message_id) WHERE external_message_id IS NOT NULL
      DO UPDATE SET
        processing_status = 'archived',
        processed_at      = NOW(),
        notes = COALESCE(documents.notes, '')
                || E'\n[archived ' || to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS UTC') || ']';

      v_logged := v_logged + 1;
      v_archive_ids := v_archive_ids || v_message_id;
    END LOOP;

    IF COALESCE(array_length(v_archive_ids, 1), 0) > 0 THEN
      v_composio_api_key := public.get_setting(p_agency_id, 'composio_api_key');
      v_composio_user_id := public.get_setting(p_agency_id, 'composio_user_id');
      v_gmail_account_id := public.get_setting(p_agency_id, 'composio_gmail_account_id');

      IF v_composio_api_key IS NOT NULL
         AND v_composio_user_id IS NOT NULL
         AND v_gmail_account_id IS NOT NULL THEN
        SELECT net.http_post(
          url := 'https://backend.composio.dev/api/v3/tools/execute/GMAIL_MODIFY_LABELS',
          headers := jsonb_build_object(
            'x-api-key', v_composio_api_key,
            'Content-Type', 'application/json'),
          body := jsonb_build_object(
            'user_id', v_composio_user_id,
            'connected_account_id', v_gmail_account_id,
            'arguments', jsonb_build_object(
              'message_ids', to_jsonb(v_archive_ids),
              'remove_label_ids', jsonb_build_array('INBOX')
            )
          ),
          timeout_milliseconds := 60000
        ) INTO v_archive_request_id;

        UPDATE public.email_archiver_jobs
        SET status = 'processed', processed_at = NOW(),
            records_processed = v_logged,
            records_archived = array_length(v_archive_ids, 1),
            archive_pg_net_request_id = v_archive_request_id,
            notes = 'Fetched ' || v_seen || ', logged ' || v_logged
                   || ', archive submitted for ' || array_length(v_archive_ids, 1)
                   || ' messages (pg_net=' || v_archive_request_id || ')'
        WHERE id = v_job.id;

        v_total_archived := v_total_archived + array_length(v_archive_ids, 1);
        v_summary_parts := v_summary_parts ||
          ('processed job ' || v_job.id::text || ': fetched ' || v_seen
           || ', archived ' || array_length(v_archive_ids, 1));
      ELSE
        UPDATE public.email_archiver_jobs
        SET status = 'processed', processed_at = NOW(),
            records_processed = v_logged, records_archived = 0,
            notes = 'Logged ' || v_logged
                  || ' to documents but missing Composio credentials for archive'
        WHERE id = v_job.id;
        v_summary_parts := v_summary_parts ||
          ('partial: logged ' || v_logged || ' but no archive (missing creds)');
      END IF;
    ELSE
      UPDATE public.email_archiver_jobs
      SET status = 'processed', processed_at = NOW(),
          records_processed = 0, records_archived = 0,
          notes = 'Fetched 0 archivable messages'
      WHERE id = v_job.id;
      v_summary_parts := v_summary_parts ||
        ('processed job ' || v_job.id::text || ': nothing to archive');
    END IF;
  END LOOP;

  v_composio_api_key := public.get_setting(p_agency_id, 'composio_api_key');
  v_composio_user_id := public.get_setting(p_agency_id, 'composio_user_id');
  v_gmail_account_id := public.get_setting(p_agency_id, 'composio_gmail_account_id');

  IF v_composio_api_key IS NULL
     OR v_composio_user_id IS NULL
     OR v_gmail_account_id IS NULL THEN
    v_summary_parts := v_summary_parts ||
      'Skipped new fetch: missing Composio credentials';
  ELSE
    SELECT net.http_post(
      url := 'https://backend.composio.dev/api/v3/tools/execute/GMAIL_FETCH_EMAILS',
      headers := jsonb_build_object(
        'x-api-key', v_composio_api_key,
        'Content-Type', 'application/json'),
      body := jsonb_build_object(
        'user_id', v_composio_user_id,
        'connected_account_id', v_gmail_account_id,
        'arguments', jsonb_build_object(
          'query', v_gmail_query,
          'max_results', v_max_results,
          'include_payload', true
        )
      ),
      timeout_milliseconds := 60000
    ) INTO v_new_request_id;

    INSERT INTO public.email_archiver_jobs (
      agency_id, recipe_id, pg_net_request_id,
      gmail_query, max_results, status, submitted_at
    ) VALUES (
      p_agency_id, p_recipe_id, v_new_request_id,
      v_gmail_query, v_max_results, 'fetching', NOW()
    ) RETURNING id INTO v_new_job_id;

    v_summary_parts := v_summary_parts ||
      ('submitted new fetch (job=' || v_new_job_id::text
       || ', pg_net=' || v_new_request_id || ')');
  END IF;

  RETURN jsonb_build_object(
    'records_processed', v_total_archived,
    'output_summary',    array_to_string(v_summary_parts, '; ')
  );
END;
$function$;

-- ----- 3. Update recipe -----
UPDATE public.automation_recipes
SET cron_expression = '0,30 13 * * *',
    input_config = input_config || '{"max_results": 25, "abandon_minutes": 30}'::jsonb,
    updated_at = NOW()
WHERE agency_id = (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1)
  AND recipe_name = 'Email Archiver';