-- =========================================================================
-- Migration: 021_monthly_close_generator
-- Supabase version: 20260617030035
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- ============================================================
-- Migration 021: monthly_close_generator handler
-- ============================================================
-- Recipe "Monthly Close Checklist Generator" cron is 0 14 1 * *
-- (9am CDT on the 1st of each month). It generates the prior
-- month's close checklist from input_config.items. Idempotent
-- via skip_if_exists -> ON CONFLICT DO NOTHING on
-- (agency_id, period_year, period_month, doc_label).
--
-- Also supports balance_review_items: persistent CPA-review
-- items that re-appear every month until removed from config.
-- ============================================================

-- 1. Unique index required for ON CONFLICT to work
CREATE UNIQUE INDEX IF NOT EXISTS uniq_monthly_close_period_label
  ON public.monthly_close_checklist (agency_id, period_year, period_month, doc_label);

-- 2. Handler
CREATE OR REPLACE FUNCTION public.monthly_close_generator(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_input_config         jsonb;
  v_items                jsonb;
  v_balance_review_items jsonb;
  v_balance_review_note  text;
  v_generate_for         text;

  v_today        date := CURRENT_DATE;
  v_close_start  date;   -- 1st of execution month (deadline base)
  v_close_year   int;    -- year being closed
  v_close_month  int;    -- month being closed

  v_item            jsonb;
  v_doc_label       text;
  v_doc_category    text;
  v_expected_offset int;
  v_account_code    text;
  v_expected_by     date;
  v_note            text;
  v_inserted        int := 0;
  v_skipped         int := 0;

  v_summary_period text;
BEGIN
  -- Load config
  SELECT input_config INTO v_input_config
  FROM public.automation_recipes WHERE id = p_recipe_id;

  v_items                := COALESCE(v_input_config->'items', '[]'::jsonb);
  v_balance_review_items := COALESCE(v_input_config->'balance_review_items', '[]'::jsonb);
  v_balance_review_note  := v_input_config->>'balance_review_note';
  v_generate_for         := COALESCE(v_input_config->>'generate_for', 'previous_month');

  -- Determine which period to close
  IF v_generate_for = 'previous_month' THEN
    IF EXTRACT(MONTH FROM v_today)::int = 1 THEN
      v_close_year  := EXTRACT(YEAR  FROM v_today)::int - 1;
      v_close_month := 12;
    ELSE
      v_close_year  := EXTRACT(YEAR  FROM v_today)::int;
      v_close_month := EXTRACT(MONTH FROM v_today)::int - 1;
    END IF;
  ELSE
    v_close_year  := EXTRACT(YEAR  FROM v_today)::int;
    v_close_month := EXTRACT(MONTH FROM v_today)::int;
  END IF;

  -- Deadline base: 1st of the month the cron fires in
  v_close_start := date_trunc('month', v_today)::date;

  -- Insert standard items
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)
  LOOP
    v_doc_label       := v_item->>'doc_label';
    v_doc_category    := COALESCE(v_item->>'doc_category', 'other');
    v_expected_offset := COALESCE((v_item->>'expected_offset_days')::int, 7);
    v_account_code    := v_item->>'account_code';
    v_expected_by     := v_close_start + (v_expected_offset || ' days')::interval;
    v_note            := CASE WHEN v_account_code IS NOT NULL
                              THEN 'account_code=' || v_account_code
                              ELSE NULL END;

    IF v_doc_label IS NULL OR length(v_doc_label) = 0 THEN
      CONTINUE;
    END IF;

    INSERT INTO public.monthly_close_checklist (
      agency_id, period_year, period_month, doc_category, doc_label,
      expected_by, status, is_closed, notes, created_at
    ) VALUES (
      p_agency_id, v_close_year, v_close_month, v_doc_category, v_doc_label,
      v_expected_by, 'expected', false, v_note, NOW()
    )
    ON CONFLICT (agency_id, period_year, period_month, doc_label)
    DO NOTHING;

    IF FOUND THEN
      v_inserted := v_inserted + 1;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  -- Insert persistent balance-review items (currently empty in config,
  -- but supported for when the CPA flags accounts requiring monthly review)
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_balance_review_items)
  LOOP
    v_account_code := v_item->>'account_code';
    v_doc_label    := 'Balance review: '
                      || COALESCE(v_item->>'account_name', v_account_code, 'unspecified');

    INSERT INTO public.monthly_close_checklist (
      agency_id, period_year, period_month, doc_category, doc_label,
      expected_by, status, is_closed, notes, created_at
    ) VALUES (
      p_agency_id, v_close_year, v_close_month, 'balance_review', v_doc_label,
      (v_close_start + INTERVAL '15 days')::date, 'expected', false,
      v_balance_review_note, NOW()
    )
    ON CONFLICT (agency_id, period_year, period_month, doc_label)
    DO NOTHING;

    IF FOUND THEN
      v_inserted := v_inserted + 1;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  v_summary_period := v_close_year || '-' || LPAD(v_close_month::text, 2, '0');

  RETURN jsonb_build_object(
    'records_processed', v_inserted,
    'output_summary',    'Generated checklist for ' || v_summary_period
                        || ': ' || v_inserted || ' items created, '
                        || v_skipped || ' skipped (already existed)'
  );
END;
$function$;