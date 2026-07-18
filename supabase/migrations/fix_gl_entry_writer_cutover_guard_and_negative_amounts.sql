-- Fix two production bugs in gl_entry_writer:
--
-- 1. No cutover guard. The handler was supposed to no-op pre-cutover (per
--    settings.gl_cutover_date) while QBO mirror is source of truth, but had
--    no check for it. As soon as comp_recap had unposted rows the writer
--    tried to insert journal entries.
--
-- 2. Negative amounts violated debit_credit_check. journal_lines requires
--    (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0). Writer
--    hardcoded debit = amount, credit = 0. Failed every time on the 50
--    negative comp_recap rows (aipp_deferral, deduction) from Phase 3.
--
-- This migration:
--   - Adds gl_cutover_date guard. Returns "no-op pre-cutover" until the
--     declared cutover date is reached.
--   - Handles positive AND negative amounts with proper double-entry.
--     Positive: debit cash, credit revenue (normal sale).
--     Negative: debit revenue, credit cash (revenue reversal / claw-back).
--   - Function signature unchanged.

CREATE OR REPLACE FUNCTION public.gl_entry_writer(p_agency_id uuid, p_recipe_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_count           INTEGER := 0;
  v_unposted        RECORD;
  v_revenue_acct_id UUID;
  v_cash_acct_id    UUID;
  v_revenue_code    TEXT;
  v_cash_code       TEXT;
  v_entry_id        UUID;
  v_now             TIMESTAMPTZ := NOW();
  v_cutover_date    DATE;
  v_amt_abs         NUMERIC;
BEGIN
  -- Pre-cutover guard: no-op until BCC takes over the GL from QBO mirror.
  SELECT (setting_value #>> '{}')::date INTO v_cutover_date
  FROM public.settings
  WHERE agency_id = p_agency_id AND setting_key = 'gl_cutover_date'
  LIMIT 1;

  IF v_cutover_date IS NULL OR CURRENT_DATE < v_cutover_date THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary', 'no-op: pre-cutover (gl_cutover_date=' || COALESCE(v_cutover_date::text, 'unset') || ')'
    );
  END IF;

  -- Resolve cash account
  SELECT setting_value #>> '{}' INTO v_cash_code
  FROM public.settings
  WHERE agency_id = p_agency_id AND setting_key = 'default_cash_account_code'
  LIMIT 1;
  IF v_cash_code IS NULL OR length(v_cash_code) = 0 THEN v_cash_code := '1010'; END IF;

  SELECT id INTO v_cash_acct_id
  FROM public.chart_of_accounts
  WHERE agency_id = p_agency_id AND account_code = v_cash_code
  LIMIT 1;

  IF v_cash_acct_id IS NULL THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary', 'Skipped: chart_of_accounts has no row with account_code=' || v_cash_code
    );
  END IF;

  FOR v_unposted IN
    SELECT id, period_year, period_month, comp_type, comp_category, amount,
           description, is_aipp_eligible, is_scoreboard_eligible
    FROM public.comp_recap
    WHERE agency_id = p_agency_id
      AND posted_at IS NULL
      AND amount IS NOT NULL
      AND amount != 0
      AND period_year IS NOT NULL
      AND period_month IS NOT NULL
    ORDER BY period_year, period_month, id
    LIMIT 500
  LOOP
    v_revenue_code := CASE LOWER(COALESCE(v_unposted.comp_type, ''))
      WHEN 'new_business'  THEN '4010'
      WHEN 'renewal'       THEN '4020'
      WHEN 'service'       THEN '4020'   -- service comp folded into renewal account
      WHEN 'scoreboard'    THEN '4030'
      WHEN 'aipp'          THEN '4040'
      WHEN 'aipp_payment'  THEN '4040'
      WHEN 'aipp_deferral' THEN '4040'   -- deferrals are negative; reduce AIPP revenue
      WHEN 'adjustment'    THEN '4050'
      WHEN 'deduction'     THEN '4050'   -- deductions are negative; reduce other revenue
      WHEN 'other'         THEN '4050'
      WHEN 'deferred_comp' THEN '4050'
      ELSE                      '4050'
    END;

    SELECT id INTO v_revenue_acct_id
    FROM public.chart_of_accounts
    WHERE agency_id = p_agency_id AND account_code = v_revenue_code
    LIMIT 1;

    IF v_revenue_acct_id IS NULL THEN
      CONTINUE;
    END IF;

    v_amt_abs := ABS(v_unposted.amount);

    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, source, document_id, description, created_by, created_at
    ) VALUES (
      p_agency_id,
      MAKE_DATE(v_unposted.period_year, v_unposted.period_month, 1),
      CASE WHEN v_unposted.amount > 0 THEN 'comp_revenue' ELSE 'comp_revenue_reversal' END,
      'gl_entry_writer',
      NULL,
      COALESCE(v_unposted.description,
               COALESCE(v_unposted.comp_type, '') || ' ' || COALESCE(v_unposted.comp_category, '')),
      'gl_entry_writer',
      v_now
    )
    RETURNING id INTO v_entry_id;

    UPDATE public.journal_entries
    SET reference_number = 'comp_recap:' || v_unposted.id::text
    WHERE id = v_entry_id;

    -- Double-entry: handle positive and negative amounts.
    -- Positive: debit cash, credit revenue (normal sale).
    -- Negative: debit revenue, credit cash (reduces both, reversal/clawback).
    IF v_unposted.amount > 0 THEN
      INSERT INTO public.journal_lines (
        journal_entry_id, agency_id, account_id, debit, credit, description, created_at
      ) VALUES
        (v_entry_id, p_agency_id, v_cash_acct_id,    v_amt_abs, 0,
         'Cash receipt: ' || COALESCE(v_unposted.comp_category, v_unposted.comp_type, ''), v_now),
        (v_entry_id, p_agency_id, v_revenue_acct_id, 0, v_amt_abs,
         COALESCE(v_unposted.comp_category, v_unposted.comp_type, ''), v_now);
    ELSE
      INSERT INTO public.journal_lines (
        journal_entry_id, agency_id, account_id, debit, credit, description, created_at
      ) VALUES
        (v_entry_id, p_agency_id, v_revenue_acct_id, v_amt_abs, 0,
         'Revenue reversal: ' || COALESCE(v_unposted.comp_category, v_unposted.comp_type, ''), v_now),
        (v_entry_id, p_agency_id, v_cash_acct_id,    0, v_amt_abs,
         'Cash adjustment: ' || COALESCE(v_unposted.comp_category, v_unposted.comp_type, ''), v_now);
    END IF;

    UPDATE public.comp_recap SET posted_at = v_now WHERE id = v_unposted.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'output_summary', v_count || ' journal entries written from comp_recap'
  );
END;
$function$;
