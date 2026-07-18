-- =========================================================================
-- Migration: 015c_document_processor_two_phase
-- Supabase version: 20260616212850
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- =====================================================================
-- 015c: Rebuild dispatch_document_processor on two-phase architecture.
-- Each cron tick either (a) finalizes the prior tick's pending fetch by
-- reading net._http_response (now visible in a fresh transaction), or
-- (b) submits a new fetch. Avoids the PL/pgSQL snapshot visibility
-- limitation that made single-tick busy-wait unreliable for pg_net.
-- =====================================================================

-- Drop probe leftovers
DROP FUNCTION IF EXISTS public._probe_busy_wait();
DROP FUNCTION IF EXISTS public._probe_read(bigint);

-- ---------------------------------------------------------------------
-- State table: one row per submitted Gmail fetch
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_processor_jobs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             uuid NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  recipe_id             uuid,
  pg_net_request_id     bigint,
  gmail_query           text,
  max_results           integer,
  status                text NOT NULL DEFAULT 'fetching'
    CHECK (status IN ('fetching','processed','failed','abandoned')),
  submitted_at          timestamptz NOT NULL DEFAULT NOW(),
  processed_at          timestamptz,
  records_processed     integer,
  classification_counts jsonb,
  error_msg             text,
  notes                 text
);

CREATE INDEX IF NOT EXISTS idx_doc_proc_jobs_pending
  ON public.document_processor_jobs (agency_id) WHERE status = 'fetching';

CREATE INDEX IF NOT EXISTS idx_doc_proc_jobs_recent
  ON public.document_processor_jobs (agency_id, submitted_at DESC);


-- ---------------------------------------------------------------------
-- Rebuilt dispatch_document_processor
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_document_processor(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  -- config
  v_input_config     jsonb;
  v_gmail_query      text;
  v_max_results      int;
  v_abandon_minutes  int;

  -- credentials
  v_composio_api_key text;
  v_composio_user_id text;
  v_gmail_account_id text;

  -- prior-job processing
  v_job              RECORD;
  v_resp_status      int;
  v_resp_content     jsonb;
  v_resp_timed_out   boolean;
  v_resp_error       text;

  v_msg              jsonb;
  v_sender           text;
  v_subject          text;
  v_message_id       text;
  v_classification   text;
  v_body             text;
  v_received         timestamptz;
  v_class_counts     jsonb := '{}'::jsonb;
  v_seen             int := 0;
  v_inserted         int := 0;
  v_skipped          int := 0;
  v_doc_id           uuid;

  -- new-job submission
  v_new_request_id   bigint;
  v_new_job_id       uuid;

  -- summary
  v_summary_parts    text[] := ARRAY[]::text[];
  v_total_processed  int := 0;
BEGIN
  -- ----- 1. Load config -----
  SELECT input_config INTO v_input_config
  FROM public.automation_recipes WHERE id = p_recipe_id;

  v_gmail_query     := COALESCE(v_input_config->>'gmail_query',     'in:inbox newer_than:1d');
  v_max_results     := COALESCE((v_input_config->>'max_results')::int, 20);
  v_abandon_minutes := COALESCE((v_input_config->>'abandon_minutes')::int, 10);

  -- ----- 2. Process any pending jobs from prior ticks -----
  FOR v_job IN
    SELECT * FROM public.document_processor_jobs
    WHERE agency_id = p_agency_id AND status = 'fetching'
    ORDER BY submitted_at ASC
  LOOP
    -- Abandon stale jobs (older than abandon_minutes with no response)
    IF v_job.submitted_at < NOW() - (v_abandon_minutes || ' minutes')::interval THEN
      SELECT status_code INTO v_resp_status
      FROM net._http_response WHERE id = v_job.pg_net_request_id;

      IF v_resp_status IS NULL THEN
        UPDATE public.document_processor_jobs
        SET status = 'abandoned',
            processed_at = NOW(),
            error_msg = 'No response within ' || v_abandon_minutes || ' minutes'
        WHERE id = v_job.id;
        v_summary_parts := v_summary_parts ||
          ('abandoned job ' || v_job.id::text || ' (pg_net=' || v_job.pg_net_request_id || ')');
        CONTINUE;
      END IF;
    END IF;

    -- Look up response
    SELECT status_code, content::jsonb, timed_out, error_msg
    INTO v_resp_status, v_resp_content, v_resp_timed_out, v_resp_error
    FROM net._http_response WHERE id = v_job.pg_net_request_id;

    IF v_resp_status IS NULL THEN
      -- Still in flight; leave job alone, will check next tick
      v_summary_parts := v_summary_parts ||
        ('job ' || v_job.id::text || ' still in flight');
      CONTINUE;
    END IF;

    IF v_resp_status <> 200 OR v_resp_timed_out THEN
      UPDATE public.document_processor_jobs
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
      UPDATE public.document_processor_jobs
      SET status = 'failed', processed_at = NOW(),
          error_msg = 'Composio unsuccessful: ' || COALESCE(v_resp_content->>'error', LEFT(v_resp_content::text, 200))
      WHERE id = v_job.id;
      v_summary_parts := v_summary_parts ||
        ('failed job ' || v_job.id::text || ' (Composio unsuccessful)');
      CONTINUE;
    END IF;

    -- Process messages
    v_class_counts := '{}'::jsonb;
    v_seen := 0; v_inserted := 0; v_skipped := 0;

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
        v_skipped := v_skipped + 1; CONTINUE;
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

      IF v_doc_id IS NOT NULL THEN v_inserted := v_inserted + 1; END IF;
    END LOOP;

    -- Mark job processed
    UPDATE public.document_processor_jobs
    SET status = 'processed',
        processed_at = NOW(),
        records_processed = v_inserted,
        classification_counts = v_class_counts,
        notes = 'Fetched ' || v_seen || ', inserted ' || v_inserted
    WHERE id = v_job.id;

    v_total_processed := v_total_processed + v_inserted;
    v_summary_parts := v_summary_parts ||
      ('processed job ' || v_job.id::text || ': fetched ' || v_seen || ', inserted ' || v_inserted);
  END LOOP;

  -- ----- 3. Submit a new fetch request -----
  v_composio_api_key := public.get_setting(p_agency_id, 'composio_api_key');
  v_composio_user_id := public.get_setting(p_agency_id, 'composio_user_id');
  v_gmail_account_id := public.get_setting(p_agency_id, 'composio_gmail_account_id');

  IF v_composio_api_key IS NULL OR v_composio_user_id IS NULL OR v_gmail_account_id IS NULL THEN
    v_summary_parts := v_summary_parts ||
      'Skipped new fetch: missing Composio credentials';
  ELSE
    SELECT net.http_post(
      url := 'https://backend.composio.dev/api/v3/tools/execute/GMAIL_FETCH_EMAILS',
      headers := jsonb_build_object(
        'x-api-key', v_composio_api_key, 'Content-Type', 'application/json'),
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

    INSERT INTO public.document_processor_jobs (
      agency_id, recipe_id, pg_net_request_id,
      gmail_query, max_results, status, submitted_at
    ) VALUES (
      p_agency_id, p_recipe_id, v_new_request_id,
      v_gmail_query, v_max_results, 'fetching', NOW()
    ) RETURNING id INTO v_new_job_id;

    v_summary_parts := v_summary_parts ||
      ('submitted new fetch (job=' || v_new_job_id::text || ', pg_net=' || v_new_request_id || ')');
  END IF;

  RETURN jsonb_build_object(
    'records_processed', v_total_processed,
    'output_summary',    array_to_string(v_summary_parts, '; ')
  );
END;
$function$;

REVOKE ALL    ON FUNCTION public.dispatch_document_processor(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_document_processor(uuid, uuid) TO service_role;