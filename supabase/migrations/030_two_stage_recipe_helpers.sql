-- ============================================================================
-- 030_two_stage_recipe_helpers.sql
-- ============================================================================
-- B8b resolution — two-stage helper RPCs for the 3 runner-side internal_handler
-- recipes that could NOT be handled by pure Postgres (unlike B8a's GL writers).
--
-- WHY THIS EXISTS
-- ---------------
-- Migration 014 (B8a) shipped 4 pure-SQL internal_handlers (bank_gl_writer,
-- cc_gl_writer, payroll_gl_writer, monthly_close_generator). Those handlers run
-- entirely inside run_internal_recipe() and never touch Composio.
--
-- The remaining 3 internal_handlers (dispatch_email_archiver, dispatch_document_
-- processor, instagram_manual_reminder) can't do that — they need external API
-- calls (Gmail, Drive, Composio Gmail-send) that Postgres can't make. So master's
-- automation-runner (Edge Function) short-circuits those internal_handler values
-- BEFORE calling run_internal_recipe(), routing them to TypeScript orchestrators
-- that call these SQL helpers as bookends.
--
-- THE TWO-STAGE PATTERN (per recipe)
-- ----------------------------------
--   1. Runner reads recipe row (composio_action='INTERNAL', internal_handler='X')
--   2. Runner sees X is a "runner-side" handler; skips run_internal_recipe()
--   3. Runner calls prepare_X_batch(agency_id, ...) → returns a jsonb "plan"
--      (Gmail query, dedup list, config, max_batch)
--   4. Runner executes the plan (Composio Gmail/Drive/email-send calls)
--   5. Runner calls log_X_result(agency_id, recipe_id, result_jsonb) → records
--      per-item outcome (documents inserted, alerts created, retries scheduled)
--      and returns a summary the runner writes to automation_run_log.
--
-- HELPERS DEFINED HERE
-- --------------------
--   Email Archiver     — prepare_email_archive_batch, log_email_archive_result
--   Document Processor — prepare_document_processor_batch, log_document_processor_result,
--                        mark_document_parsed, run_document_processor_backfill
--   Social Scheduler   — has_aa05_prohibited_terms (AA05 word-block check),
--                        prepare_instagram_reminder_batch, log_social_post_result,
--                        prepare_facebook_post_batch, prepare_linkedin_post_batch
--                        (fb/li helpers dormant — activated when runner adds
--                         facebook_auto_poster / linkedin_auto_poster handlers)
--
-- SCHEMA ADDITIONS
-- ----------------
--   content_calendar gains failure_reason, retry_count, last_attempted_at
--   (needed by log_social_post_result for retry semantics)
--
-- NOTE ON PROVENANCE
-- ------------------
-- Extracted and sanitized from Kwame Tyler's fork migrations 024/025/025b/028/029
-- (the two-stage design was proven in his install). Kwame's handler names
-- (email_archiver_orchestrator, etc.) have been renamed to master's canonical
-- names (dispatch_email_archiver, etc.) so that these helpers match the seed
-- function's internal_handler values. Agency-specific smoke tests, UPDATE
-- statements, and email addresses have been stripped.
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1 — Schema alterations (content_calendar retry columns)
-- ============================================================================

ALTER TABLE public.content_calendar
  ADD COLUMN IF NOT EXISTS failure_reason    text,
  ADD COLUMN IF NOT EXISTS retry_count       int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempted_at timestamptz;

CREATE INDEX IF NOT EXISTS content_calendar_v2_due_idx
  ON content_calendar (agency_id, platform, status, scheduled_date, scheduled_time);

-- ============================================================================
-- SECTION 2 — Email Archiver helpers (source: Kwame migration 024)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.prepare_email_archive_batch(
  p_agency_id uuid,
  p_older_than_days int DEFAULT 30,
  p_max_batch int DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_cutoff_date    date := CURRENT_DATE - p_older_than_days;
  v_dedup_ids      jsonb;
  v_drive_template text := 'BCC/{{year}}/{{month}}/{{category}}';
  v_archive_label  text := 'BCC/Archived';
  v_gmail_query    text;
BEGIN
  -- Pull dedup list: gmail message_ids already represented in documents.
  -- The runner skips these to avoid re-archiving and double-filing.
  -- We look at the upload_source column (e.g. 'gmail' or 'gmail_historical_import')
  -- and parse out the gmail message_id stored in notes (pattern: "gmail_msg=<id>").
  SELECT COALESCE(jsonb_agg(DISTINCT msg_id), '[]'::jsonb) INTO v_dedup_ids
  FROM (
    SELECT substring(notes FROM 'gmail_msg=([a-f0-9]+)') AS msg_id
    FROM public.documents
    WHERE agency_id = p_agency_id
      AND notes ILIKE '%gmail_msg=%'
  ) ids
  WHERE msg_id IS NOT NULL;

  -- Build Gmail query: messages older than cutoff, not in archive, not starred (runner double-checks starred)
  v_gmail_query := format(
    'before:%s -is:starred -in:archive -in:trash -in:spam',
    to_char(v_cutoff_date, 'YYYY/MM/DD')
  );

  RETURN jsonb_build_object(
    'gmail_query',      v_gmail_query,
    'cutoff_date',      v_cutoff_date,
    'archive_label',    v_archive_label,
    'max_batch',        p_max_batch,
    'dedup_message_ids', v_dedup_ids,
    'dedup_count',      jsonb_array_length(v_dedup_ids),
    'settings', jsonb_build_object(
      'preserve_starred',          true,
      'route_attachments_to_drive', true,
      'drive_folder_template',      v_drive_template
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.prepare_email_archive_batch IS
'Email Archiver payload_rpc. Returns the search criteria, dedup list, and settings the runner uses to drive a bulk GMAIL_MODIFY_LABELS pass. Idempotent and side-effect-free — safe to call any time.';

-- ============================================================================
-- log_email_archive_result — accepts the runner callback and persists
-- ============================================================================
CREATE OR REPLACE FUNCTION public.log_email_archive_result(
  p_agency_id uuid,
  p_recipe_id uuid,
  p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_archived_count    int := 0;
  v_attachments_count int := 0;
  v_documents_inserted int := 0;
  v_attachment         jsonb;
  v_existing_doc_id    uuid;
BEGIN
  -- Top-line counts from the runner's report
  v_archived_count    := COALESCE(jsonb_array_length(p_result->'archived_message_ids'), 0);
  v_attachments_count := COALESCE(jsonb_array_length(p_result->'attachments_filed'),    0);

  -- Insert documents rows for each attachment filed to Drive
  -- Skip silently if an identical (agency, file_name, gmail_msg) tuple already exists
  IF v_attachments_count > 0 THEN
    FOR v_attachment IN SELECT * FROM jsonb_array_elements(p_result->'attachments_filed')
    LOOP
      -- Dedup: check if a documents row with this drive_file_id already exists
      SELECT id INTO v_existing_doc_id
      FROM public.documents
      WHERE agency_id = p_agency_id
        AND drive_file_id = v_attachment->>'drive_file_id'
      LIMIT 1;

      IF v_existing_doc_id IS NULL THEN
        INSERT INTO public.documents (
          agency_id, file_name, file_type,
          upload_source, drive_file_id, drive_url,
          processing_status, uploaded_by, uploaded_at, notes
        ) VALUES (
          p_agency_id,
          v_attachment->>'file_name',
          COALESCE(v_attachment->>'file_type', 'application/octet-stream'),
          'email_archiver',
          v_attachment->>'drive_file_id',
          v_attachment->>'drive_url',
          'inventoried',  -- not yet classified; Document Processor will pick up later
          'email_archiver_runner',
          NOW(),
          format('Auto-filed by Email Archiver run. gmail_msg=%s | original_subject=%s',
                 v_attachment->>'message_id',
                 COALESCE(v_attachment->>'subject',''))
        );
        v_documents_inserted := v_documents_inserted + 1;
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'status',              'ok',
    'archived_messages',    v_archived_count,
    'attachments_reported', v_attachments_count,
    'documents_inserted',   v_documents_inserted,
    'output_summary',       format(
      '%s emails archived; %s attachments filed (%s new documents rows; %s deduped)',
      v_archived_count,
      v_attachments_count,
      v_documents_inserted,
      v_attachments_count - v_documents_inserted
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.log_email_archive_result IS
'Email Archiver result_rpc. Accepts the runner''s post-batch summary (archived_message_ids, attachments_filed) and persists per-attachment documents rows with dedup. Returns a structured summary the runner writes to automation_run_log.';

-- ============================================================================
-- Recipe metadata update — point to the new design
-- ============================================================================

-- ============================================================================
-- SECTION 3 — Document Processor v1 helpers (source: Kwame migrations 025 + 025b)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.prepare_document_processor_batch(
  p_agency_id        uuid,
  p_lookback_minutes int DEFAULT 60,
  p_max_batch        int DEFAULT 10
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff_epoch  bigint;
  v_dedup_ids     text[];
  v_dedup_count   int;
  v_gmail_query   text;
BEGIN
  -- Gmail's `after:` operator takes a unix epoch (seconds).
  v_cutoff_epoch := EXTRACT(EPOCH FROM (NOW() - (p_lookback_minutes || ' minutes')::interval))::bigint;

  -- Build dedup set from documents.notes (regex extract gmail_msg=<hex_id>)
  SELECT COALESCE(array_agg(DISTINCT msg_id), ARRAY[]::text[])
  INTO   v_dedup_ids
  FROM (
    SELECT (regexp_match(notes, 'gmail_msg=([a-f0-9]+)'))[1] AS msg_id
    FROM documents
    WHERE agency_id = p_agency_id
      AND notes IS NOT NULL
      AND notes ~ 'gmail_msg=[a-f0-9]+'
  ) sub
  WHERE msg_id IS NOT NULL;

  v_dedup_count := COALESCE(array_length(v_dedup_ids, 1), 0);

  -- Compose query. Targets SF + Paychex. has:attachment + after:<epoch> + not-archived.
  -- 'BCC-Processed' label is the post-archive marker — exclude messages already there.
  v_gmail_query := format(
    'has:attachment after:%s -in:trash -in:spam -label:BCC-Processed (from:statefarm.com OR from:paychex.com)',
    v_cutoff_epoch
  );

  RETURN jsonb_build_object(
    'gmail_query',        v_gmail_query,
    'cutoff_epoch',       v_cutoff_epoch,
    'lookback_minutes',   p_lookback_minutes,
    'max_batch',          LEAST(p_max_batch, 25),  -- safety ceiling
    'dedup_message_ids',  to_jsonb(v_dedup_ids),
    'dedup_count',        v_dedup_count,
    'settings', jsonb_build_object(
      'route_to_drive',            true,
      'drive_folder_template',     'BCC Financial Records/Live Documents (May 2026 forward)/{{category}}/{{year}}',
      'alert_on_ingest_pending',   true,
      'classify_by_filename_regex', true
    )
  );
END;
$$;

COMMENT ON FUNCTION public.prepare_document_processor_batch(uuid, int, int)
IS 'Layer 1 of Document Processor (Layer 3 orchestrator). Returns Gmail query + dedup set. Mirrors prepare_email_archive_batch.';


-- -------------------------------------------------------------------------
-- log_document_processor_result
-- -------------------------------------------------------------------------
-- Accepts the orchestrator's callback payload and:
--   1. Inserts a documents row for each successfully-filed PDF
--      (dedup'd against existing rows by drive_file_id).
--   2. Inserts an alert per pending-ingest item (Comp Recap especially).
--   3. Returns a summary that the Edge Function writes to automation_run_log.
--
-- Callback payload shape (from the orchestrator):
-- {
--   "processed": [
--     {
--       "message_id":       "19e559bc1ffaeacf",
--       "subject":           "Your 2026 Mid-Month Compensation Recap",
--       "from":              "noreply@statefarm.com",
--       "file_name":         "Compensation_Recap_2026_05_15.pdf",
--       "file_type":         "application/pdf",
--       "drive_file_id":     "1abc...",
--       "drive_url":         "https://drive.google.com/file/d/1abc.../view",
--       "doc_type":          "sf_comp_recap" | "paychex_payroll" | "sf_deduction_stmt" | "other",
--       "needs_ingest":      true,
--       "ingest_handler":    "sf_comp_recap_ingest" | null,
--       "period_hint":       "2026-05-second"  -- optional, from filename
--     },
--     ...
--   ],
--   "skipped":  [{message_id, reason}],
--   "errors":   [{message_id, error}]
-- }
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_document_processor_result(
  p_agency_id  uuid,
  p_recipe_id  uuid,
  p_result     jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_processed       jsonb := COALESCE(p_result->'processed', '[]'::jsonb);
  v_skipped         jsonb := COALESCE(p_result->'skipped',   '[]'::jsonb);
  v_errors          jsonb := COALESCE(p_result->'errors',    '[]'::jsonb);
  v_item            jsonb;
  v_documents_inserted int := 0;
  v_documents_skipped  int := 0;
  v_alerts_created     int := 0;
  v_doc_id          uuid;
  v_doc_type        text;
  v_summary         text;
  v_existing_id     uuid;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_processed)
  LOOP
    v_doc_type := COALESCE(v_item->>'doc_type', 'other');

    SELECT id INTO v_existing_id
    FROM documents
    WHERE agency_id = p_agency_id
      AND drive_file_id = v_item->>'drive_file_id'
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      v_documents_skipped := v_documents_skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO documents (
      agency_id, file_name, file_type, drive_file_id, drive_url,
      processing_type, processing_status, processed_at,
      upload_source, uploaded_by, uploaded_at, notes
    ) VALUES (
      p_agency_id,
      v_item->>'file_name',
      v_item->>'file_type',
      v_item->>'drive_file_id',
      v_item->>'drive_url',
      v_doc_type,
      CASE WHEN COALESCE((v_item->>'needs_ingest')::boolean, false)
           THEN 'awaiting_ingest'
           ELSE 'processed' END,
      NOW(),
      'gmail_auto',
      'dispatch_document_processor',
      NOW(),
      format(
        'Auto-filed by Document Processor (recipe_id=%s; gmail_msg=%s; subject=%s; from=%s)',
        p_recipe_id::text,
        v_item->>'message_id',
        COALESCE(v_item->>'subject', '?'),
        COALESCE(v_item->>'from', '?')
      )
    )
    RETURNING id INTO v_doc_id;

    v_documents_inserted := v_documents_inserted + 1;

    IF v_doc_type = 'sf_comp_recap' AND COALESCE((v_item->>'needs_ingest')::boolean, false) THEN
      INSERT INTO alerts (
        agency_id, alert_type, severity, title, message,
        module_reference, related_id, is_resolved
      ) VALUES (
        p_agency_id, 'document_pending_ingest', 'info',
        'SF Compensation Recap PDF arrived — needs ingest',
        format(
          'Document Processor auto-filed "%s" to Drive (period: %s). Run scripts/parsers/sf_comp_recap.py from a Composio sandbox to ingest into comp_recap. See scripts/parsers/README.md for the runbook.',
          v_item->>'file_name',
          COALESCE(v_item->>'period_hint', 'read from PDF')
        ),
        'documents:sf_comp_recap', v_doc_id, false
      );
      v_alerts_created := v_alerts_created + 1;
    END IF;

    IF v_doc_type = 'paychex_payroll' AND COALESCE((v_item->>'needs_ingest')::boolean, false) THEN
      INSERT INTO alerts (
        agency_id, alert_type, severity, title, message,
        module_reference, related_id, is_resolved
      ) VALUES (
        p_agency_id, 'document_pending_ingest', 'info',
        'Paychex payroll report arrived — needs ingest',
        format(
          'Document Processor auto-filed "%s" to Drive. Payroll CSV ingestion to payroll_runs/payroll_detail is not yet wired — manual handling required.',
          v_item->>'file_name'
        ),
        'documents:paychex_payroll', v_doc_id, false
      );
      v_alerts_created := v_alerts_created + 1;
    END IF;

    IF v_doc_type = 'sf_deduction_stmt' AND COALESCE((v_item->>'needs_ingest')::boolean, false) THEN
      INSERT INTO alerts (
        agency_id, alert_type, severity, title, message,
        module_reference, related_id, is_resolved
      ) VALUES (
        p_agency_id, 'document_pending_ingest', 'info',
        'SF Deduction Statement arrived — review',
        format(
          'Document Processor auto-filed "%s" to Drive. Cross-reference against comp_recap deductions; mark monthly_close_checklist item received if reconciled.',
          v_item->>'file_name'
        ),
        'documents:sf_deduction_stmt', v_doc_id, false
      );
      v_alerts_created := v_alerts_created + 1;
    END IF;
  END LOOP;

  v_summary := format(
    '%s docs filed (%s dedup-skipped); %s alerts created; %s skipped; %s errors',
    v_documents_inserted, v_documents_skipped, v_alerts_created,
    jsonb_array_length(v_skipped), jsonb_array_length(v_errors)
  );

  RETURN jsonb_build_object(
    'status', 'ok',
    'documents_inserted', v_documents_inserted,
    'documents_dedup_skipped', v_documents_skipped,
    'alerts_created', v_alerts_created,
    'skipped_count', jsonb_array_length(v_skipped),
    'error_count', jsonb_array_length(v_errors),
    'output_summary', v_summary
  );
END;
$$;

COMMENT ON FUNCTION public.log_document_processor_result(uuid, uuid, jsonb)
IS 'Layer 1 result_rpc for Document Processor (Layer 3 orchestrator). Inserts documents rows + alerts. Mirrors log_email_archive_result.';

-- Smoke test: dry-run the prepare function so we see the resulting query shape

-- ============================================================================
-- SECTION 4 — Document Processor v2 helpers (source: Kwame migration 028)
-- ============================================================================

-- ---------------------------------------------------------------------
-- 1. mark_document_parsed
-- ---------------------------------------------------------------------
-- Called once per document at end of stage C.  Idempotent — re-calling
-- with the same status is a no-op other than processed_at refresh.
--
-- p_status one of:
--   'success'        — parse + ingest both succeeded
--   'parse_failed'   — LLM returned malformed JSON / schema-validation failed
--   'ingest_failed'  — parsed JSON OK but sf_comp_recap_ingest raised
--   'skipped'        — parser ineligible doc_type (shouldn't normally fire)
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mark_document_parsed(
  p_doc_id    uuid,
  p_status    text,
  p_records   integer DEFAULT 0,
  p_error     text DEFAULT NULL,
  p_tables    text[] DEFAULT NULL,
  p_response  jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row    documents%ROWTYPE;
  v_notes  text;
BEGIN
  -- Lock the row to prevent concurrent stage C reruns from racing
  SELECT * INTO v_row
  FROM   documents
  WHERE  id = p_doc_id
  FOR    UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'mark_document_parsed: document % not found', p_doc_id;
  END IF;

  -- Append a structured audit-trail note; keep prior notes intact
  v_notes := COALESCE(v_row.notes || E'\n', '') ||
             '[parse_v2 ' || to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS') || ' ' || p_status ||
             ' records=' || COALESCE(p_records, 0) ||
             CASE WHEN p_error IS NOT NULL THEN ' err=' || left(p_error, 200) ELSE '' END ||
             ']';

  UPDATE documents
  SET    processing_status = CASE p_status
                               WHEN 'success'       THEN 'parse_success'
                               WHEN 'parse_failed'  THEN 'parse_failed'
                               WHEN 'ingest_failed' THEN 'ingest_failed'
                               WHEN 'skipped'       THEN COALESCE(v_row.processing_status, 'processed')
                               ELSE p_status
                             END,
         records_created  = COALESCE(p_records, v_row.records_created, 0),
         tables_updated   = COALESCE(p_tables,  v_row.tables_updated),
         processed_at     = NOW(),
         notes            = v_notes
  WHERE  id = p_doc_id;

  -- If the parse failed, fire an alert (uses the canonical v1 schema:
  -- alert_type / severity / title / message / module_reference / related_id / is_resolved).
  IF p_status IN ('parse_failed','ingest_failed') THEN
    INSERT INTO alerts (
      agency_id, alert_type, severity, title, message,
      module_reference, related_id, is_resolved, created_at
    )
    VALUES (
      v_row.agency_id,
      'doc_parse_failed',
      'warning',
      'Document parse failed: ' || COALESCE(v_row.file_name, p_doc_id::text),
      'Stage C (' || p_status || ') for document ' || p_doc_id ||
        ' (doc_type=' || COALESCE(v_row.processing_type, '?') || ')' ||
        CASE WHEN p_error IS NOT NULL THEN E'\nError: ' || left(p_error, 500) ELSE '' END ||
        CASE WHEN p_response IS NOT NULL THEN E'\nResponse: ' || left(p_response::text, 500) ELSE '' END,
      'documents:parse_v2',
      p_doc_id,
      false,
      NOW()
    );
  END IF;

  RETURN jsonb_build_object(
    'document_id', p_doc_id,
    'status',      p_status,
    'records',     COALESCE(p_records, 0)
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.mark_document_parsed(uuid,text,integer,text,text[],jsonb)
  TO service_role, authenticated, anon;


-- ---------------------------------------------------------------------
-- 2. run_document_processor_backfill
-- ---------------------------------------------------------------------
-- Returns a jsonb plan for the Edge Function backfill endpoint.
--
-- Capped at 10 documents per call to stay inside the ~60-second Edge
-- Function execution window (each parse leg is ~10-20s of LLM latency).
--
-- IMPORTANT: documents use `processing_type` (NOT `groq_classification`)
-- as the canonical doc-type column.  v1 sets processing_type='sf_comp_recap'
-- for SF Compensation Recap PDFs.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.run_document_processor_backfill(
  p_agency   uuid,
  p_doc_ids  uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan       jsonb := '[]'::jsonb;
  v_docs_count integer;
  v_doc        record;
BEGIN
  IF p_doc_ids IS NULL OR cardinality(p_doc_ids) = 0 THEN
    RAISE EXCEPTION 'run_document_processor_backfill: p_doc_ids must contain at least 1 uuid';
  END IF;

  v_docs_count := cardinality(p_doc_ids);
  IF v_docs_count > 10 THEN
    RAISE EXCEPTION 'run_document_processor_backfill: max 10 docs per call (got %); split into batches', v_docs_count;
  END IF;

  -- Mark all selected docs as pending_parse so the orchestrator's
  -- regular Gmail-driven path leaves them alone.  Skip rows already
  -- in flight.
  UPDATE documents
  SET    processing_status = 'pending_parse'
  WHERE  agency_id = p_agency
    AND  id = ANY(p_doc_ids)
    AND  processing_status NOT IN ('parse_in_progress');

  -- Build the plan: include every requested doc with its parse-eligibility
  -- flag.  v2.0 ships sf_comp_recap.  paychex_payroll and sf_deduction_stmt
  -- arrive in v2.4 (separate task).
  FOR v_doc IN
    SELECT id, file_name, drive_file_id, drive_url, processing_type, processing_status
    FROM   documents
    WHERE  agency_id = p_agency
      AND  id = ANY(p_doc_ids)
    ORDER BY uploaded_at NULLS LAST
  LOOP
    v_plan := v_plan || jsonb_build_object(
      'document_id',     v_doc.id,
      'file_name',       v_doc.file_name,
      'drive_file_id',   v_doc.drive_file_id,
      'drive_url',       v_doc.drive_url,
      'doc_type',        v_doc.processing_type,
      'current_status',  v_doc.processing_status,
      'parser_eligible', v_doc.processing_type IN ('sf_comp_recap')
    );
  END LOOP;

  RETURN jsonb_build_object(
    'agency_id',       p_agency,
    'requested_count', v_docs_count,
    'documents',       v_plan,
    'generated_at',    to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.run_document_processor_backfill(uuid, uuid[])
  TO service_role, authenticated;


-- ---------------------------------------------------------------------
-- 3. Index for backfill / parse-status filtering
-- ---------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS documents_processing_status_type_idx
  ON documents (agency_id, processing_status, processing_type);


-- ---------------------------------------------------------------------
-- 4. Smoke tests (executed at apply-time)
-- ---------------------------------------------------------------------

-- ============================================================================
-- SECTION 5 — Social Scheduler helpers (source: Kwame migration 029)
-- ============================================================================

-- ---------------------------------------------------------------------
-- 1. content_calendar v2 columns
-- ---------------------------------------------------------------------




-- ---------------------------------------------------------------------
-- 2. has_aa05_prohibited_terms — SQL word-rule belt (narrow list).
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.has_aa05_prohibited_terms(p_text text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_text IS NULL OR length(p_text) = 0 THEN FALSE
    ELSE EXISTS (
      SELECT 1
      FROM unnest(ARRAY[
        'client', 'clients',
        'solutions',
        'expert ', 'experts ', ' expert', ' experts',
        'specialist',
        'advisor', 'consultant',
        'transfers welcome',
        'financial freedom',
        'wealth accumulation',
        'world-class', 'world class',
        'first-class', 'first class',
        'cheap', 'affordable', 'low cost',
        'guarantee', 'guaranteed',
        '#1', 'greatest'
      ]) AS prohibited
      WHERE lower(p_text) LIKE '%' || prohibited || '%'
    )
  END
$$;

GRANT EXECUTE ON FUNCTION public.has_aa05_prohibited_terms(text)
  TO service_role, authenticated, anon;


-- ---------------------------------------------------------------------
-- 3. prepare_*_post_batch RPCs — Facebook / LinkedIn / Instagram planners.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prepare_facebook_post_batch(
  p_agency_id uuid,
  p_tz        text DEFAULT 'America/New_York'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_items   jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_row     content_calendar%ROWTYPE;
  v_now     timestamptz := NOW();
  v_today   date := (v_now AT TIME ZONE p_tz)::date;
  v_now_t   time := (v_now AT TIME ZONE p_tz)::time;
BEGIN
  FOR v_row IN
    SELECT *
    FROM   content_calendar
    WHERE  agency_id = p_agency_id
      AND  platform  = 'facebook'
      AND  status    = 'scheduled'
      AND  scheduled_date <= v_today
      AND  (scheduled_time IS NULL OR scheduled_time <= v_now_t OR scheduled_date < v_today)
      AND  (last_attempted_at IS NULL OR last_attempted_at < v_now - interval '30 minutes')
    ORDER BY scheduled_date, scheduled_time NULLS FIRST, created_at
    LIMIT 25
  LOOP
    IF v_row.retry_count >= 3 THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_row.id, 'reason', 'max_retries_exceeded');
      CONTINUE;
    END IF;
    IF has_aa05_prohibited_terms(v_row.caption) THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_row.id, 'reason', 'aa05_prohibited_terms');
      CONTINUE;
    END IF;
    v_items := v_items || jsonb_build_object(
      'id', v_row.id,
      'caption',         v_row.caption,
      'hashtags',        COALESCE(v_row.hashtags, ARRAY[]::text[]),
      'media_url',       v_row.media_url,
      'scheduled_date',  v_row.scheduled_date,
      'scheduled_time',  v_row.scheduled_time,
      'retry_count',     v_row.retry_count
    );
  END LOOP;
  RETURN jsonb_build_object(
    'agency_id', p_agency_id, 'platform', 'facebook', 'tz', p_tz,
    'as_of', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'items', v_items, 'skipped', v_skipped
  );
END
$$;

CREATE OR REPLACE FUNCTION public.prepare_linkedin_post_batch(
  p_agency_id uuid,
  p_tz        text DEFAULT 'America/New_York'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_items   jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_row     content_calendar%ROWTYPE;
  v_now     timestamptz := NOW();
  v_today   date := (v_now AT TIME ZONE p_tz)::date;
  v_now_t   time := (v_now AT TIME ZONE p_tz)::time;
BEGIN
  FOR v_row IN
    SELECT *
    FROM   content_calendar
    WHERE  agency_id = p_agency_id
      AND  platform  = 'linkedin'
      AND  status    = 'scheduled'
      AND  scheduled_date <= v_today
      AND  (scheduled_time IS NULL OR scheduled_time <= v_now_t OR scheduled_date < v_today)
      AND  (last_attempted_at IS NULL OR last_attempted_at < v_now - interval '30 minutes')
    ORDER BY scheduled_date, scheduled_time NULLS FIRST, created_at
    LIMIT 25
  LOOP
    IF v_row.retry_count >= 3 THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_row.id, 'reason', 'max_retries_exceeded');
      CONTINUE;
    END IF;
    IF has_aa05_prohibited_terms(v_row.caption) THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_row.id, 'reason', 'aa05_prohibited_terms');
      CONTINUE;
    END IF;
    v_items := v_items || jsonb_build_object(
      'id', v_row.id,
      'caption',         v_row.caption,
      'hashtags',        COALESCE(v_row.hashtags, ARRAY[]::text[]),
      'media_url',       v_row.media_url,
      'scheduled_date',  v_row.scheduled_date,
      'scheduled_time',  v_row.scheduled_time,
      'retry_count',     v_row.retry_count
    );
  END LOOP;
  RETURN jsonb_build_object(
    'agency_id', p_agency_id, 'platform', 'linkedin', 'tz', p_tz,
    'as_of', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'items', v_items, 'skipped', v_skipped
  );
END
$$;

CREATE OR REPLACE FUNCTION public.prepare_instagram_reminder_batch(
  p_agency_id uuid,
  p_tz        text DEFAULT 'America/New_York'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_items   jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_row     content_calendar%ROWTYPE;
  v_now     timestamptz := NOW();
  v_today   date := (v_now AT TIME ZONE p_tz)::date;
BEGIN
  FOR v_row IN
    SELECT *
    FROM   content_calendar
    WHERE  agency_id = p_agency_id
      AND  platform  = 'instagram'
      AND  status    = 'scheduled'
      AND  scheduled_date <= v_today
      AND  (last_attempted_at IS NULL OR last_attempted_at < v_now - interval '6 hours')
    ORDER BY scheduled_date, scheduled_time NULLS FIRST, created_at
    LIMIT 10
  LOOP
    IF has_aa05_prohibited_terms(v_row.caption) THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_row.id, 'reason', 'aa05_prohibited_terms');
      CONTINUE;
    END IF;
    v_items := v_items || jsonb_build_object(
      'id', v_row.id,
      'caption',         v_row.caption,
      'hashtags',        COALESCE(v_row.hashtags, ARRAY[]::text[]),
      'media_url',       v_row.media_url,
      'scheduled_date',  v_row.scheduled_date,
      'scheduled_time',  v_row.scheduled_time,
      'retry_count',     v_row.retry_count
    );
  END LOOP;
  RETURN jsonb_build_object(
    'agency_id', p_agency_id, 'platform', 'instagram', 'tz', p_tz,
    'as_of', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'items', v_items, 'skipped', v_skipped
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.prepare_facebook_post_batch(uuid, text)      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_linkedin_post_batch(uuid, text)      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_instagram_reminder_batch(uuid, text) TO service_role, authenticated;


-- ---------------------------------------------------------------------
-- 4. log_social_post_result — success + retry/failure handling.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_social_post_result(
  p_agency_id uuid,
  p_recipe_id uuid,
  p_result    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_results        jsonb := COALESCE(p_result->'results', '[]'::jsonb);
  v_skipped        jsonb := COALESCE(p_result->'skipped', '[]'::jsonb);
  v_item           jsonb;
  v_posted         int := 0;
  v_failed         int := 0;
  v_reminded       int := 0;
  v_alerts_created int := 0;
  v_row            content_calendar%ROWTYPE;
  v_new_retry      int;
  v_summary        text;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_results)
  LOOP
    SELECT * INTO v_row
    FROM   content_calendar
    WHERE  agency_id = p_agency_id AND id = (v_item->>'id')::uuid
    FOR    UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    IF v_item->>'status' = 'posted' THEN
      UPDATE content_calendar
      SET    status            = 'posted',
             post_url          = v_item->>'post_url',
             posted_at         = NOW(),
             failure_reason    = NULL,
             last_attempted_at = NOW()
      WHERE  id = v_row.id;
      v_posted := v_posted + 1;

    ELSIF v_item->>'status' = 'reminded' THEN
      UPDATE content_calendar
      SET    last_attempted_at = NOW(),
             requires_manual   = true
      WHERE  id = v_row.id;
      v_reminded := v_reminded + 1;

    ELSIF v_item->>'status' = 'failed' THEN
      v_new_retry := COALESCE(v_row.retry_count, 0) + 1;
      IF v_new_retry >= 3 THEN
        UPDATE content_calendar
        SET    status            = 'failed',
               failure_reason    = v_item->>'error',
               retry_count       = v_new_retry,
               last_attempted_at = NOW()
        WHERE  id = v_row.id;
        INSERT INTO alerts (
          agency_id, alert_type, severity, title, message,
          module_reference, related_id, is_resolved, created_at
        ) VALUES (
          p_agency_id,
          'social_post_failed',
          'warning',
          format('Social post failed permanently: %s', COALESCE(v_row.platform, '?')),
          format('content_calendar id=%s exhausted %s retries. Last error: %s. Caption preview: %s',
                 v_row.id, v_new_retry, v_item->>'error', left(COALESCE(v_row.caption, ''), 120)),
          format('social_media:%s', v_row.platform),
          v_row.id,
          false,
          NOW()
        );
        v_alerts_created := v_alerts_created + 1;
      ELSE
        UPDATE content_calendar
        SET    failure_reason    = v_item->>'error',
               retry_count       = v_new_retry,
               last_attempted_at = NOW()
        WHERE  id = v_row.id;
      END IF;
      v_failed := v_failed + 1;
    END IF;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_skipped)
  LOOP
    INSERT INTO alerts (
      agency_id, alert_type, severity, title, message,
      module_reference, related_id, is_resolved, created_at
    ) VALUES (
      p_agency_id,
      'social_post_skipped',
      'info',
      format('Social post skipped: %s', v_item->>'reason'),
      format('content_calendar id=%s skipped: %s', v_item->>'id', v_item->>'reason'),
      'social_media:skipped',
      (v_item->>'id')::uuid,
      false,
      NOW()
    );
    v_alerts_created := v_alerts_created + 1;
  END LOOP;

  v_summary := format(
    '%s posted, %s reminded, %s failed, %s skipped, %s alerts',
    v_posted, v_reminded, v_failed, jsonb_array_length(v_skipped), v_alerts_created
  );
  RETURN jsonb_build_object(
    'status',          'ok',
    'posted',          v_posted,
    'reminded',        v_reminded,
    'failed',          v_failed,
    'skipped_count',   jsonb_array_length(v_skipped),
    'alerts_created',  v_alerts_created,
    'output_summary',  v_summary
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.log_social_post_result(uuid, uuid, jsonb)
  TO service_role, authenticated;


-- ---------------------------------------------------------------------

COMMIT;
