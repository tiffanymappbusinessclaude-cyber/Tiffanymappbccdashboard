-- =========================================================================
-- Migration: 016_document_parser_framework_v2
-- Supabase version: 20260616213919
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- Same as 016 but with trigger_type='cron' on the recipe INSERT.

CREATE OR REPLACE FUNCTION public.parse_sf_daily_comp(p_document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_doc              RECORD;
  v_body             text;
  v_subject          text;
  v_period_year      int;
  v_period_month     int;
  v_match            text[];
  v_label            text;
  v_amount_text      text;
  v_amount           numeric;
  v_inserted         int := 0;
  v_examined         int := 0;
  v_comp_type        text;
  v_is_aipp          boolean;
  v_is_scoreboard    boolean;
  v_pattern          text := '([A-Z][A-Za-z& ''/-]{2,60}?[A-Za-z])[\s:\.\t]{2,}\$([\d,]+\.\d{2})';
BEGIN
  SELECT id, agency_id, file_name, raw_content, uploaded_at, processing_status, groq_classification
  INTO v_doc
  FROM public.documents WHERE id = p_document_id;

  IF v_doc IS NULL THEN
    RETURN jsonb_build_object('error', 'document not found', 'records_created', 0);
  END IF;
  IF COALESCE(v_doc.raw_content, '') = '' THEN
    RETURN jsonb_build_object('error', 'raw_content is empty', 'records_created', 0);
  END IF;

  v_body    := v_doc.raw_content;
  v_subject := COALESCE(v_doc.file_name, '');

  v_match := regexp_match(
    v_subject,
    '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}[,]?\s+(\d{4})',
    'i'
  );
  IF v_match IS NOT NULL THEN
    v_period_year  := v_match[2]::int;
    v_period_month := CASE LOWER(LEFT(v_match[1], 3))
      WHEN 'jan' THEN 1  WHEN 'feb' THEN 2  WHEN 'mar' THEN 3
      WHEN 'apr' THEN 4  WHEN 'may' THEN 5  WHEN 'jun' THEN 6
      WHEN 'jul' THEN 7  WHEN 'aug' THEN 8  WHEN 'sep' THEN 9
      WHEN 'oct' THEN 10 WHEN 'nov' THEN 11 WHEN 'dec' THEN 12 END;
  END IF;

  IF v_period_year IS NULL THEN
    v_match := regexp_match(v_subject, '(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})');
    IF v_match IS NOT NULL THEN
      v_period_month := v_match[1]::int;
      v_period_year  := CASE WHEN length(v_match[3]) = 2
        THEN 2000 + v_match[3]::int ELSE v_match[3]::int END;
    END IF;
  END IF;

  IF v_period_year IS NULL THEN
    v_period_year  := EXTRACT(YEAR  FROM v_doc.uploaded_at)::int;
    v_period_month := EXTRACT(MONTH FROM v_doc.uploaded_at)::int;
  END IF;

  UPDATE public.documents
  SET processing_status = 'parsing'
  WHERE id = p_document_id AND processing_status = 'classified';

  FOR v_match IN
    SELECT regexp_matches(v_body, v_pattern, 'g')
  LOOP
    v_examined  := v_examined + 1;
    v_label     := trim(v_match[1]);
    v_amount_text := v_match[2];
    BEGIN
      v_amount := REPLACE(v_amount_text, ',', '')::numeric;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;

    IF v_label ILIKE '%total%' OR v_label ILIKE '%subtotal%'
       OR v_label ILIKE '%grand total%' OR LENGTH(v_label) < 4 THEN
      CONTINUE;
    END IF;

    v_comp_type     := 'other';
    v_is_aipp       := false;
    v_is_scoreboard := false;

    IF v_label ~* '(new business|new biz|nb premium|new policy|premium issued)' THEN
      v_comp_type := 'new_business';
      v_is_aipp   := true;
    ELSIF v_label ~* '(renewal|retention)' THEN
      v_comp_type := 'renewal';
    ELSIF v_label ~* '(scoreboard|score board|s/b)' THEN
      v_comp_type     := 'scoreboard';
      v_is_scoreboard := true;
    ELSIF v_label ~* 'aipp' THEN
      v_comp_type := 'aipp';
      v_is_aipp   := true;
    ELSIF v_label ~* '(life|health|l&h)' THEN
      v_comp_type     := 'life_health';
      v_is_scoreboard := true;
    ELSIF v_label ~* '(bonus|incentive|award)' THEN
      v_comp_type := 'bonus';
    ELSIF v_label ~* '(fee|charge|deduction|chargeback)' AND v_amount < 0 THEN
      v_comp_type := 'deduction';
    END IF;

    INSERT INTO public.comp_recap (
      agency_id, period_year, period_month,
      comp_type, comp_category, description, amount,
      is_aipp_eligible, is_scoreboard_eligible,
      source_document_id, created_at
    ) VALUES (
      v_doc.agency_id, v_period_year, v_period_month,
      v_comp_type, v_label, v_label, v_amount,
      v_is_aipp, v_is_scoreboard,
      p_document_id, NOW()
    );

    v_inserted := v_inserted + 1;
  END LOOP;

  IF v_inserted > 0 THEN
    UPDATE public.documents
    SET processing_status = 'parsed', processed_at = NOW(),
        tables_updated  = ARRAY['comp_recap'], records_created = v_inserted,
        notes = COALESCE(notes,'') || E'\n[parser] ' || v_inserted
                || ' line items extracted (period '
                || v_period_year || '-' || LPAD(v_period_month::text, 2, '0') || ')'
    WHERE id = p_document_id;
  ELSE
    UPDATE public.documents
    SET processing_status = 'parse_failed', processed_at = NOW(), records_created = 0,
        notes = COALESCE(notes,'') || E'\n[parser] No labeled dollar amounts found in '
                || v_examined || ' candidate matches (period '
                || v_period_year || '-' || LPAD(v_period_month::text, 2, '0') || ')'
    WHERE id = p_document_id;
  END IF;

  RETURN jsonb_build_object(
    'records_created', v_inserted,
    'candidates_examined', v_examined,
    'period', v_period_year || '-' || LPAD(v_period_month::text, 2, '0'),
    'tables_updated', ARRAY['comp_recap']
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.parse_documents(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_input_config    jsonb;
  v_batch_size      int;
  v_doc             RECORD;
  v_result          jsonb;
  v_total_parsed    int := 0;
  v_total_failed    int := 0;
  v_total_skipped   int := 0;
  v_total_records   int := 0;
  v_per_class       jsonb := '{}'::jsonb;
BEGIN
  SELECT input_config INTO v_input_config
  FROM public.automation_recipes WHERE id = p_recipe_id;

  v_batch_size := COALESCE((v_input_config->>'batch_size')::int, 50);

  FOR v_doc IN
    SELECT id, groq_classification
    FROM public.documents
    WHERE agency_id = p_agency_id
      AND processing_status = 'classified'
      AND raw_content IS NOT NULL
      AND length(raw_content) > 0
    ORDER BY uploaded_at ASC
    LIMIT v_batch_size
  LOOP
    BEGIN
      CASE v_doc.groq_classification
        WHEN 'sf_daily_comp' THEN
          v_result := public.parse_sf_daily_comp(v_doc.id);
          v_total_parsed  := v_total_parsed + 1;
          v_total_records := v_total_records + COALESCE((v_result->>'records_created')::int, 0);

        WHEN 'sf_deduction_statement','sf_producer_production','sf_aipp_statement','sf_scoreboard','sf_other',
             'bank_statement_chase','bank_statement_bofa','bank_statement_wells','bank_statement_usbank',
             'cc_statement_chase','payroll_run' THEN
          UPDATE public.documents
          SET processing_status = 'parse_skipped', processed_at = NOW(),
              notes = COALESCE(notes,'') || E'\n[parser] No parser implemented yet for ' || v_doc.groq_classification
          WHERE id = v_doc.id;
          v_total_skipped := v_total_skipped + 1;

        WHEN 'self_briefing','self_test','system_notification','unclassified' THEN
          UPDATE public.documents
          SET processing_status = 'parse_skipped', processed_at = NOW(),
              notes = COALESCE(notes,'') || E'\n[parser] Non-financial classification: ' || v_doc.groq_classification
          WHERE id = v_doc.id;
          v_total_skipped := v_total_skipped + 1;

        ELSE
          UPDATE public.documents
          SET processing_status = 'parse_skipped', processed_at = NOW(),
              notes = COALESCE(notes,'') || E'\n[parser] Unknown classification: ' || v_doc.groq_classification
          WHERE id = v_doc.id;
          v_total_skipped := v_total_skipped + 1;
      END CASE;

      v_per_class := jsonb_set(
        v_per_class, ARRAY[v_doc.groq_classification],
        to_jsonb(COALESCE((v_per_class->>v_doc.groq_classification)::int, 0) + 1)
      );
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.documents
      SET processing_status = 'parse_failed', processed_at = NOW(),
          notes = COALESCE(notes,'') || E'\n[parser ERROR] ' || SQLERRM
      WHERE id = v_doc.id;
      v_total_failed := v_total_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_total_records,
    'output_summary',
      v_total_parsed || ' parsed (' || v_total_records || ' records inserted), '
      || v_total_skipped || ' skipped, ' || v_total_failed || ' failed',
    'per_classification', v_per_class
  );
END;
$function$;


INSERT INTO public.automation_recipes (
  agency_id, recipe_name, recipe_description, trigger_type,
  composio_action, internal_handler,
  cron_expression, is_active, input_config, created_at
)
SELECT
  (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1),
  'Document Parser',
  'Walks classified documents and routes each to a per-type parser. Cron offset 10 min after Document Processor. First active parser: sf_daily_comp. Others land as parse_skipped until built.',
  'cron',
  'INTERNAL',
  'parse_documents',
  '17,47 * * * *',
  true,
  '{"batch_size": 50}'::jsonb,
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM public.automation_recipes
  WHERE agency_id = (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1)
    AND recipe_name = 'Document Parser'
);


REVOKE ALL    ON FUNCTION public.parse_documents(uuid, uuid)   FROM PUBLIC;
REVOKE ALL    ON FUNCTION public.parse_sf_daily_comp(uuid)     FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.parse_documents(uuid, uuid)   TO service_role;
GRANT EXECUTE ON FUNCTION public.parse_sf_daily_comp(uuid)     TO service_role;