-- =========================================================================
-- Migration: 016b_sf_daily_comp_parser_v2
-- Supabase version: 20260616214125
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- Patch parse_sf_daily_comp:
--  (a) regex now captures optional leading minus inside the dollar amount: $-145.00
--  (b) classification cascade puts L&H before generic "new business" so 
--      "New Business Life Premium" doesn't get AIPP=true (only P&C is AIPP-eligible)

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
  -- v2: allow optional minus inside the amount group ($-145.00)
  v_pattern          text := '([A-Z][A-Za-z& ''/-]{2,60}?[A-Za-z])[\s:\.\t]{2,}\$\s*(-?[\d,]+\.\d{2})';
BEGIN
  SELECT id, agency_id, file_name, raw_content, uploaded_at, processing_status, groq_classification
  INTO v_doc FROM public.documents WHERE id = p_document_id;

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

    -- v2: L&H check FIRST so "New Business Life" doesn't get AIPP=true.
    --     AIPP eligibility is P&C-only per agency rules.
    IF v_label ~* '(life|health|l&h|disability|annuity)' THEN
      IF v_label ~* '(new business|new biz|nb premium|new policy)' THEN
        v_comp_type     := 'new_business_lh';
        v_is_aipp       := false;     -- L&H does NOT qualify for AIPP
        v_is_scoreboard := true;      -- L&H fuels the ScoreBoard multiplier
      ELSIF v_label ~* '(renewal|retention)' THEN
        v_comp_type := 'renewal_lh';
      ELSE
        v_comp_type     := 'life_health';
        v_is_scoreboard := true;
      END IF;
    ELSIF v_label ~* '(new business|new biz|nb premium|new policy|premium issued)' THEN
      v_comp_type := 'new_business';
      v_is_aipp   := true;            -- P&C new business is AIPP-eligible
    ELSIF v_label ~* '(renewal|retention)' THEN
      v_comp_type := 'renewal';
    ELSIF v_label ~* '(scoreboard|score board|s/b)' THEN
      v_comp_type     := 'scoreboard';
      v_is_scoreboard := true;
    ELSIF v_label ~* 'aipp' THEN
      v_comp_type := 'aipp';
      v_is_aipp   := true;
    ELSIF v_label ~* '(bonus|incentive|award)' THEN
      v_comp_type := 'bonus';
    ELSIF v_label ~* '(fee|charge|deduction|chargeback|adjustment)' AND v_amount < 0 THEN
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
        tables_updated = ARRAY['comp_recap'], records_created = v_inserted,
        notes = COALESCE(notes,'') || E'\n[parser v2] ' || v_inserted
                || ' line items extracted (period '
                || v_period_year || '-' || LPAD(v_period_month::text, 2, '0') || ')'
    WHERE id = p_document_id;
  ELSE
    UPDATE public.documents
    SET processing_status = 'parse_failed', processed_at = NOW(), records_created = 0,
        notes = COALESCE(notes,'') || E'\n[parser v2] No labeled dollar amounts found in '
                || v_examined || ' candidate matches'
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