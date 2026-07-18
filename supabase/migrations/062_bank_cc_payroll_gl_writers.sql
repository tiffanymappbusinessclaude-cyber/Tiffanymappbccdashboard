-- =========================================================================
-- Migration: 022_bank_cc_payroll_gl_writers
-- Supabase version: 20260617031423
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- Migration 022: Bank / Credit Card / Payroll GL writer handlers
-- Completes the 3 remaining missing handlers identified in 2026-06-16 milestone.
-- Pattern follows gl_entry_writer (migration 012): SECURITY DEFINER, idempotent,
-- returns jsonb with records_processed + output_summary.
--
-- All three handlers are guarded by settings.gl_cutover_date. If not set, they
-- no-op with an informative message. This prevents accidental double-posting
-- against the QBO mirror until the agent explicitly declares the cutover.
--
-- Idempotency: each source row carries a journal_entry_id column. We only
-- process rows where journal_entry_id IS NULL, and stamp it after posting.

-- =====================================================================
-- 1) bank_gl_writer
-- =====================================================================
CREATE OR REPLACE FUNCTION public.bank_gl_writer(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_count            INTEGER := 0;
  v_cutover_date     DATE;
  v_cash_acct_id     UUID;
  v_suspense_acct_id UUID;
  v_target_acct_id   UUID;
  v_entry_id         UUID;
  v_now              TIMESTAMPTZ := NOW();
  v_unposted         RECORD;
BEGIN
  -- Cutover guard
  SELECT setting_value::date INTO v_cutover_date
  FROM public.settings
  WHERE agency_id = p_agency_id AND setting_key = 'gl_cutover_date'
  LIMIT 1;

  IF v_cutover_date IS NULL THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary', 'Skipped: settings.gl_cutover_date not set. No bank transactions posted.'
    );
  END IF;

  -- Required chart accounts
  SELECT id INTO v_cash_acct_id
  FROM public.chart_of_accounts
  WHERE agency_id = p_agency_id AND account_code = '1010' LIMIT 1;

  SELECT id INTO v_suspense_acct_id
  FROM public.chart_of_accounts
  WHERE agency_id = p_agency_id AND account_code = '6999' LIMIT 1;

  IF v_cash_acct_id IS NULL OR v_suspense_acct_id IS NULL THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary', 'Skipped: chart_of_accounts missing 1010 (Operating Checking) or 6999 (Uncategorized Expense)'
    );
  END IF;

  -- Process unposted rows
  FOR v_unposted IN
    SELECT id, transaction_date, description, amount, transaction_type,
           counterparty, category, split_label, memo
    FROM public.bank_transactions
    WHERE agency_id = p_agency_id
      AND journal_entry_id IS NULL
      AND transaction_date >= v_cutover_date
      AND amount IS NOT NULL
      AND amount != 0
    ORDER BY transaction_date, id
    LIMIT 500
  LOOP
    -- Waterfall: category → split_label → suspense
    v_target_acct_id := NULL;

    IF v_unposted.category IS NOT NULL THEN
      SELECT id INTO v_target_acct_id
      FROM public.chart_of_accounts
      WHERE agency_id = p_agency_id
        AND (account_code = v_unposted.category
             OR LOWER(account_name) = LOWER(v_unposted.category))
      LIMIT 1;
    END IF;

    IF v_target_acct_id IS NULL AND v_unposted.split_label IS NOT NULL THEN
      SELECT id INTO v_target_acct_id
      FROM public.chart_of_accounts
      WHERE agency_id = p_agency_id
        AND (account_code = v_unposted.split_label
             OR LOWER(account_name) = LOWER(v_unposted.split_label))
      LIMIT 1;
    END IF;

    IF v_target_acct_id IS NULL THEN
      v_target_acct_id := v_suspense_acct_id;
    END IF;

    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, source, description, memo,
      reference_number, created_by, created_at
    ) VALUES (
      p_agency_id,
      v_unposted.transaction_date,
      'bank_transaction',
      'bank_gl_writer',
      COALESCE(v_unposted.description, 'Bank transaction'),
      v_unposted.memo,
      'bank_transactions:' || v_unposted.id::text,
      'bank_gl_writer',
      v_now
    ) RETURNING id INTO v_entry_id;

    IF v_unposted.amount < 0 THEN
      -- Withdrawal: DR target_expense, CR cash
      INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
      VALUES
        (v_entry_id, p_agency_id, v_target_acct_id, ABS(v_unposted.amount), 0,
         COALESCE(v_unposted.counterparty, v_unposted.description), v_now),
        (v_entry_id, p_agency_id, v_cash_acct_id, 0, ABS(v_unposted.amount),
         'Withdrawal: ' || COALESCE(v_unposted.counterparty, v_unposted.description), v_now);
    ELSE
      -- Deposit: DR cash, CR target (revenue/other)
      INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
      VALUES
        (v_entry_id, p_agency_id, v_cash_acct_id, v_unposted.amount, 0,
         'Deposit: ' || COALESCE(v_unposted.counterparty, v_unposted.description), v_now),
        (v_entry_id, p_agency_id, v_target_acct_id, 0, v_unposted.amount,
         COALESCE(v_unposted.counterparty, v_unposted.description), v_now);
    END IF;

    UPDATE public.bank_transactions SET journal_entry_id = v_entry_id WHERE id = v_unposted.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'output_summary', v_count || ' bank transactions posted to journal_entries (cutover ' || v_cutover_date::text || ')'
  );
END;
$function$;


-- =====================================================================
-- 2) cc_gl_writer
-- =====================================================================
CREATE OR REPLACE FUNCTION public.cc_gl_writer(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_count            INTEGER := 0;
  v_cutover_date     DATE;
  v_cash_acct_id     UUID;
  v_suspense_acct_id UUID;
  v_cc_default_id    UUID;
  v_cc_acct_id       UUID;
  v_target_acct_id   UUID;
  v_entry_id         UUID;
  v_now              TIMESTAMPTZ := NOW();
  v_unposted         RECORD;
  v_is_payment       BOOLEAN;
BEGIN
  SELECT setting_value::date INTO v_cutover_date
  FROM public.settings
  WHERE agency_id = p_agency_id AND setting_key = 'gl_cutover_date' LIMIT 1;

  IF v_cutover_date IS NULL THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary', 'Skipped: settings.gl_cutover_date not set. No credit card transactions posted.'
    );
  END IF;

  SELECT id INTO v_cash_acct_id     FROM public.chart_of_accounts
  WHERE agency_id = p_agency_id AND account_code = '1010' LIMIT 1;

  SELECT id INTO v_suspense_acct_id FROM public.chart_of_accounts
  WHERE agency_id = p_agency_id AND account_code = '6999' LIMIT 1;

  SELECT id INTO v_cc_default_id    FROM public.chart_of_accounts
  WHERE agency_id = p_agency_id AND account_code = '2100' LIMIT 1;

  IF v_cash_acct_id IS NULL OR v_suspense_acct_id IS NULL OR v_cc_default_id IS NULL THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary', 'Skipped: chart_of_accounts missing 1010 / 2100 / 6999'
    );
  END IF;

  FOR v_unposted IN
    SELECT ct.id, ct.credit_account_id, ct.transaction_date, ct.description,
           ct.amount, ct.transaction_type, ct.category,
           coa_cc.id AS linked_cc_acct_id
    FROM public.credit_transactions ct
    LEFT JOIN public.chart_of_accounts coa_cc
      ON coa_cc.id = ct.credit_account_id
     AND coa_cc.agency_id = ct.agency_id
    WHERE ct.agency_id = p_agency_id
      AND ct.journal_entry_id IS NULL
      AND ct.transaction_date >= v_cutover_date
      AND ct.amount IS NOT NULL
      AND ct.amount != 0
    ORDER BY ct.transaction_date, ct.id
    LIMIT 500
  LOOP
    v_cc_acct_id := COALESCE(v_unposted.linked_cc_acct_id, v_cc_default_id);

    -- Payment? (paying down the card from cash)
    v_is_payment := (LOWER(COALESCE(v_unposted.transaction_type, '')) IN ('payment','credit')
                     OR v_unposted.amount < 0);

    -- Resolve expense target (only used for charges)
    v_target_acct_id := NULL;
    IF NOT v_is_payment AND v_unposted.category IS NOT NULL THEN
      SELECT id INTO v_target_acct_id
      FROM public.chart_of_accounts
      WHERE agency_id = p_agency_id
        AND (account_code = v_unposted.category
             OR LOWER(account_name) = LOWER(v_unposted.category))
      LIMIT 1;
    END IF;

    IF v_target_acct_id IS NULL THEN
      v_target_acct_id := v_suspense_acct_id;
    END IF;

    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, source, description,
      reference_number, created_by, created_at
    ) VALUES (
      p_agency_id,
      v_unposted.transaction_date,
      CASE WHEN v_is_payment THEN 'cc_payment' ELSE 'cc_charge' END,
      'cc_gl_writer',
      COALESCE(v_unposted.description, 'Credit card transaction'),
      'credit_transactions:' || v_unposted.id::text,
      'cc_gl_writer',
      v_now
    ) RETURNING id INTO v_entry_id;

    IF v_is_payment THEN
      -- Payment: DR card liability (reduce), CR cash
      INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
      VALUES
        (v_entry_id, p_agency_id, v_cc_acct_id, ABS(v_unposted.amount), 0,
         'CC payment', v_now),
        (v_entry_id, p_agency_id, v_cash_acct_id, 0, ABS(v_unposted.amount),
         COALESCE(v_unposted.description, 'CC payment'), v_now);
    ELSE
      -- Charge: DR expense (target), CR card liability
      INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
      VALUES
        (v_entry_id, p_agency_id, v_target_acct_id, ABS(v_unposted.amount), 0,
         COALESCE(v_unposted.description, 'CC charge'), v_now),
        (v_entry_id, p_agency_id, v_cc_acct_id, 0, ABS(v_unposted.amount),
         'CC charge: ' || COALESCE(v_unposted.description, ''), v_now);
    END IF;

    UPDATE public.credit_transactions SET journal_entry_id = v_entry_id WHERE id = v_unposted.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'output_summary', v_count || ' credit card transactions posted to journal_entries (cutover ' || v_cutover_date::text || ')'
  );
END;
$function$;


-- =====================================================================
-- 3) payroll_gl_writer (single-entity convention)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.payroll_gl_writer(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_count                  INTEGER := 0;
  v_cutover_date           DATE;
  v_cash_acct_id           UUID;
  v_payroll_exp_acct_id    UUID;
  v_payroll_tax_acct_id    UUID;
  v_entry_id               UUID;
  v_now                    TIMESTAMPTZ := NOW();
  v_unposted               RECORD;
  v_total_outflow          NUMERIC;
BEGIN
  SELECT setting_value::date INTO v_cutover_date
  FROM public.settings
  WHERE agency_id = p_agency_id AND setting_key = 'gl_cutover_date' LIMIT 1;

  IF v_cutover_date IS NULL THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary', 'Skipped: settings.gl_cutover_date not set. No payroll runs posted.'
    );
  END IF;

  SELECT id INTO v_cash_acct_id        FROM public.chart_of_accounts
  WHERE agency_id = p_agency_id AND account_code = '1010' LIMIT 1;

  SELECT id INTO v_payroll_exp_acct_id FROM public.chart_of_accounts
  WHERE agency_id = p_agency_id AND account_code = '6000' LIMIT 1;

  SELECT id INTO v_payroll_tax_acct_id FROM public.chart_of_accounts
  WHERE agency_id = p_agency_id AND account_code = '6030' LIMIT 1;

  IF v_cash_acct_id IS NULL OR v_payroll_exp_acct_id IS NULL OR v_payroll_tax_acct_id IS NULL THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary', 'Skipped: chart_of_accounts missing 1010 / 6000 / 6030'
    );
  END IF;

  FOR v_unposted IN
    SELECT id, pay_date, pay_period_start, pay_period_end, payroll_provider,
           gross_payroll, employer_taxes, net_payroll, status
    FROM public.payroll_runs
    WHERE agency_id = p_agency_id
      AND journal_entry_id IS NULL
      AND pay_date >= v_cutover_date
      AND COALESCE(LOWER(status), 'completed') IN ('completed','paid','posted')
      AND gross_payroll IS NOT NULL
    ORDER BY pay_date, id
    LIMIT 500
  LOOP
    v_total_outflow := COALESCE(v_unposted.gross_payroll, 0)
                     + COALESCE(v_unposted.employer_taxes, 0);

    IF v_total_outflow <= 0 THEN
      CONTINUE;
    END IF;

    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, source, description,
      reference_number, created_by, created_at
    ) VALUES (
      p_agency_id,
      v_unposted.pay_date,
      'payroll',
      'payroll_gl_writer',
      'Payroll ' || v_unposted.pay_period_start::text || ' to ' || v_unposted.pay_period_end::text
        || COALESCE(' (' || v_unposted.payroll_provider || ')', ''),
      'payroll_runs:' || v_unposted.id::text,
      'payroll_gl_writer',
      v_now
    ) RETURNING id INTO v_entry_id;

    -- Single-entity: agency pays gross + employer_taxes out of its own bank
    INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
    VALUES
      (v_entry_id, p_agency_id, v_payroll_exp_acct_id,
       COALESCE(v_unposted.gross_payroll, 0), 0, 'Gross payroll', v_now),
      (v_entry_id, p_agency_id, v_payroll_tax_acct_id,
       COALESCE(v_unposted.employer_taxes, 0), 0, 'Employer payroll taxes', v_now),
      (v_entry_id, p_agency_id, v_cash_acct_id,
       0, v_total_outflow, 'Payroll cash outflow', v_now);

    UPDATE public.payroll_runs SET journal_entry_id = v_entry_id WHERE id = v_unposted.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'output_summary', v_count || ' payroll runs posted to journal_entries (cutover ' || v_cutover_date::text || ')'
  );
END;
$function$;
