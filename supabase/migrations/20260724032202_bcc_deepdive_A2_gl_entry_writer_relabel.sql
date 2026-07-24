-- bcc-deepdive/A2 — 2026-07-24T04:22Z
-- Finding F2: gl_entry_writer emits "(cash-basis, post-cutover)" in every
-- daily output_summary. Contradicts documented 2026-06-10 CPA accrual
-- alignment. Surgical replace of the label string only. Logic untouched.
-- Rollback: restore prior CREATE OR REPLACE body captured in 2026-07-24T04:00Z
-- audit context (session id 09e3c11d).

CREATE OR REPLACE FUNCTION public.gl_entry_writer(p_agency_id uuid, p_recipe_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_cutover_date date;
  v_cash_acct_id uuid;
  v_cash_acct_name text;
  v_rec record;
  v_revenue_acct_id uuid;
  v_revenue_acct_name text;
  v_entry_id uuid;
  v_entry_date date;
  v_desc text;
  v_ref text;
  v_written int := 0;
  v_skipped_summary int := 0;
  v_skipped_zero int := 0;
  v_skipped_no_account int := 0;
  v_skipped_pre_cutover int := 0;
  v_skipped_already_posted int := 0;
BEGIN
  SELECT setting_value::date INTO v_cutover_date FROM public.settings
    WHERE agency_id = p_agency_id AND setting_key = 'gl_cutover_date' LIMIT 1;
  IF v_cutover_date IS NULL THEN v_cutover_date := DATE '2026-05-01'; END IF;

  SELECT setting_value INTO v_cash_acct_name FROM public.settings
    WHERE agency_id = p_agency_id AND setting_key = 'gl_default_cash_account_name' LIMIT 1;
  IF v_cash_acct_name IS NULL THEN v_cash_acct_name := 'Operating Checking Account'; END IF;

  SELECT id INTO v_cash_acct_id FROM public.chart_of_accounts
    WHERE agency_id = p_agency_id AND account_name = v_cash_acct_name LIMIT 1;
  IF v_cash_acct_id IS NULL THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary', 'FAILED: cash account "' || v_cash_acct_name || '" not in chart_of_accounts'
    );
  END IF;

  FOR v_rec IN
    SELECT cr.* FROM public.comp_recap cr
    WHERE cr.agency_id = p_agency_id
    ORDER BY cr.period_year, cr.period_month, cr.id
  LOOP
    IF v_rec.comp_type = 'net_payable' THEN
      v_skipped_summary := v_skipped_summary + 1; CONTINUE;
    END IF;
    IF v_rec.amount IS NULL OR v_rec.amount = 0 THEN
      v_skipped_zero := v_skipped_zero + 1; CONTINUE;
    END IF;
    IF (v_rec.period_year < EXTRACT(YEAR FROM v_cutover_date)::int)
       OR (v_rec.period_year = EXTRACT(YEAR FROM v_cutover_date)::int
           AND v_rec.period_month < EXTRACT(MONTH FROM v_cutover_date)::int) THEN
      v_skipped_pre_cutover := v_skipped_pre_cutover + 1; CONTINUE;
    END IF;

    SELECT cmap.account_name INTO v_revenue_acct_name FROM public.comp_recap_account_map cmap
      WHERE cmap.agency_id = p_agency_id
        AND cmap.comp_type = v_rec.comp_type
        AND cmap.comp_category = v_rec.comp_category
      LIMIT 1;
    IF v_revenue_acct_name IS NULL THEN
      v_skipped_no_account := v_skipped_no_account + 1; CONTINUE;
    END IF;

    SELECT id INTO v_revenue_acct_id FROM public.chart_of_accounts
      WHERE agency_id = p_agency_id AND account_name = v_revenue_acct_name LIMIT 1;
    IF v_revenue_acct_id IS NULL THEN
      v_skipped_no_account := v_skipped_no_account + 1; CONTINUE;
    END IF;

    v_entry_date := (make_date(v_rec.period_year, v_rec.period_month, 1) + INTERVAL '1 month - 1 day')::date;
    v_desc := COALESCE(v_rec.description, v_rec.comp_type || ' / ' || v_rec.comp_category);
    v_ref := 'CR-' || v_rec.period_year || '-' || LPAD(v_rec.period_month::text, 2, '0')
             || COALESCE('-' || v_rec.period_half, '');

    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, reference_number,
      description, source, created_by, source_table, source_id, created_at
    ) VALUES (
      p_agency_id, v_entry_date, 'comp_recap', v_ref, v_desc,
      'gl_entry_writer', 'automation', 'comp_recap', v_rec.id, NOW()
    )
    ON CONFLICT (agency_id, source_table, source_id) DO NOTHING
    RETURNING id INTO v_entry_id;

    IF v_entry_id IS NULL THEN
      v_skipped_already_posted := v_skipped_already_posted + 1; CONTINUE;
    END IF;

    IF v_rec.amount > 0 THEN
      INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
        VALUES (v_entry_id, p_agency_id, v_cash_acct_id, v_rec.amount, 0, v_desc, NOW());
      INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
        VALUES (v_entry_id, p_agency_id, v_revenue_acct_id, 0, v_rec.amount, v_desc, NOW());
    ELSE
      INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
        VALUES (v_entry_id, p_agency_id, v_revenue_acct_id, ABS(v_rec.amount), 0, v_desc || ' [REVERSAL]', NOW());
      INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
        VALUES (v_entry_id, p_agency_id, v_cash_acct_id, 0, ABS(v_rec.amount), v_desc || ' [REVERSAL]', NOW());
    END IF;

    v_written := v_written + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_written,
    'output_summary', v_written || ' journal entries written (accrual books, post-cutover comp only) | '
                      || 'skipped: ' || v_skipped_pre_cutover || ' pre-cutover, '
                      || v_skipped_summary || ' net_payable summary, '
                      || v_skipped_zero || ' zero-amount, '
                      || v_skipped_no_account || ' no-account, '
                      || v_skipped_already_posted || ' already posted'
  );
END;
$function$;
