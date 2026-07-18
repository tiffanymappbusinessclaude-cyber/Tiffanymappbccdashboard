-- =========================================================================
-- Migration: 014_gl_writer_handlers
-- Supabase version: 20260616210259
-- Captured from production DB: 2026-06-17
-- Note: bank_gl_writer / cc_gl_writer / payroll_gl_writer were later
-- superseded by migration 022's SECURITY DEFINER variants. Schema (tables,
-- columns, suspense accounts) is what carried forward.
-- =========================================================================

-- Migration 014: Bank / CC / Payroll GL Writer handlers + supporting schema
-- Ships handlers required by the three "GL Writer" recipes that have been
-- active but failing with "no such function" since the canonical seed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. bank_transactions table (referenced by Bank GL Writer recipe)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id          uuid NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  bank_account_id    uuid REFERENCES public.bank_accounts(id) ON DELETE SET NULL,
  transaction_date   date NOT NULL,
  description        text NOT NULL,
  amount             numeric NOT NULL,                 -- positive=inflow, negative=outflow
  transaction_type   text,                             -- deposit|withdrawal|transfer|fee|interest|check
  counterparty       text,                             -- payee or payer when known
  category           text,                             -- first waterfall step
  split_label        text,                             -- bank-statement split label (Bank-only)
  memo               text,
  journal_entry_id   uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  source_document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  created_at         timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_txn_agency_date
  ON public.bank_transactions (agency_id, transaction_date DESC);

CREATE INDEX IF NOT EXISTS idx_bank_txn_unposted
  ON public.bank_transactions (agency_id)
  WHERE journal_entry_id IS NULL;


-- ---------------------------------------------------------------------
-- 2. classification_rules table (used by bank + cc waterfalls)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.classification_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id          uuid NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  rule_type          text NOT NULL CHECK (rule_type IN ('bank','credit','either')),
  match_field        text NOT NULL CHECK (match_field IN ('description','category','split_label','counterparty','memo')),
  pattern            text NOT NULL,                    -- case-insensitive substring (ILIKE '%pattern%')
  target_account_id  uuid NOT NULL REFERENCES public.chart_of_accounts(id) ON DELETE CASCADE,
  priority           integer DEFAULT 100,              -- lower number = checked first
  is_active          boolean DEFAULT true,
  notes              text,
  created_at         timestamptz DEFAULT NOW(),
  updated_at         timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_classification_rules_active
  ON public.classification_rules (agency_id, rule_type, priority)
  WHERE is_active = true;


-- ---------------------------------------------------------------------
-- 3. journal_entry_id column on payroll_runs (idempotency marker)
-- ---------------------------------------------------------------------
ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid
  REFERENCES public.journal_entries(id) ON DELETE SET NULL;


-- ---------------------------------------------------------------------
-- 4. Suspense accounts (Uncategorized Income / Expense)
-- ---------------------------------------------------------------------
INSERT INTO public.chart_of_accounts (agency_id, account_code, account_name, account_type, account_subtype, is_active)
SELECT (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1), '4999', 'Uncategorized Income', 'income', 'other', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.chart_of_accounts
  WHERE agency_id = (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1) AND account_code = '4999'
);

INSERT INTO public.chart_of_accounts (agency_id, account_code, account_name, account_type, account_subtype, is_active)
SELECT (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1), '6999', 'Uncategorized Expense', 'expense', 'other', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.chart_of_accounts
  WHERE agency_id = (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1) AND account_code = '6999'
);


-- ---------------------------------------------------------------------
-- 5. bank_gl_writer
--    Posts unposted bank_transactions to journal_entries + journal_lines.
--    Convention: amount > 0 = inflow (DR cash / CR target)
--                amount < 0 = outflow (DR target / CR cash)
--    Resolution waterfall: category → split_label → description rule → suspense
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bank_gl_writer(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_count                    INTEGER := 0;
  v_skipped                  INTEGER := 0;
  v_txn                      RECORD;
  v_cash_acct_id             UUID;
  v_target_acct_id           UUID;
  v_uncategorized_income_id  UUID;
  v_uncategorized_expense_id UUID;
  v_entry_id                 UUID;
  v_now                      TIMESTAMPTZ := NOW();
  v_cutover_date             DATE;
  v_default_cash_code        TEXT;
BEGIN
  SELECT setting_value::date INTO v_cutover_date
  FROM public.settings
  WHERE agency_id = p_agency_id AND setting_key = 'cutover_date' LIMIT 1;

  SELECT setting_value INTO v_default_cash_code
  FROM public.settings
  WHERE agency_id = p_agency_id AND setting_key = 'default_cash_account_code' LIMIT 1;
  IF v_default_cash_code IS NULL THEN v_default_cash_code := '1010'; END IF;

  SELECT id INTO v_uncategorized_income_id  FROM public.chart_of_accounts
    WHERE agency_id = p_agency_id AND account_code = '4999' LIMIT 1;
  SELECT id INTO v_uncategorized_expense_id FROM public.chart_of_accounts
    WHERE agency_id = p_agency_id AND account_code = '6999' LIMIT 1;

  IF v_uncategorized_income_id IS NULL OR v_uncategorized_expense_id IS NULL THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary', 'Skipped: chart_of_accounts missing 4999 (Uncategorized Income) or 6999 (Uncategorized Expense)'
    );
  END IF;

  FOR v_txn IN
    SELECT bt.id, bt.bank_account_id, bt.transaction_date, bt.description,
           bt.amount, bt.transaction_type, bt.counterparty, bt.category,
           bt.split_label, bt.memo,
           ba.account_type AS bank_acct_type,
           ba.account_name AS bank_acct_name
    FROM public.bank_transactions bt
    LEFT JOIN public.bank_accounts ba ON ba.id = bt.bank_account_id
    WHERE bt.agency_id = p_agency_id
      AND bt.journal_entry_id IS NULL
      AND bt.amount IS NOT NULL
      AND bt.amount != 0
      AND (v_cutover_date IS NULL OR bt.transaction_date >= v_cutover_date)
    ORDER BY bt.transaction_date, bt.id
    LIMIT 500
  LOOP
    v_cash_acct_id := NULL;
    IF v_txn.bank_acct_name IS NOT NULL THEN
      SELECT id INTO v_cash_acct_id FROM public.chart_of_accounts
        WHERE agency_id = p_agency_id AND LOWER(account_name) = LOWER(v_txn.bank_acct_name) LIMIT 1;
    END IF;
    IF v_cash_acct_id IS NULL AND v_txn.bank_acct_type IS NOT NULL THEN
      SELECT id INTO v_cash_acct_id FROM public.chart_of_accounts
        WHERE agency_id = p_agency_id
          AND account_code = CASE LOWER(v_txn.bank_acct_type)
            WHEN 'checking' THEN '1010'
            WHEN 'savings'  THEN '1020'
            WHEN 'trust'    THEN '1030'
            ELSE v_default_cash_code
          END LIMIT 1;
    END IF;
    IF v_cash_acct_id IS NULL THEN
      SELECT id INTO v_cash_acct_id FROM public.chart_of_accounts
        WHERE agency_id = p_agency_id AND account_code = v_default_cash_code LIMIT 1;
    END IF;

    IF v_cash_acct_id IS NULL THEN
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    v_target_acct_id := NULL;

    IF v_txn.category IS NOT NULL AND v_txn.category <> '' THEN
      SELECT id INTO v_target_acct_id FROM public.chart_of_accounts
        WHERE agency_id = p_agency_id AND is_active = true
          AND LOWER(account_name) = LOWER(v_txn.category) LIMIT 1;
    END IF;

    IF v_target_acct_id IS NULL AND v_txn.split_label IS NOT NULL THEN
      SELECT target_account_id INTO v_target_acct_id
      FROM public.classification_rules
      WHERE agency_id = p_agency_id AND is_active = true
        AND rule_type IN ('bank','either') AND match_field = 'split_label'
        AND v_txn.split_label ILIKE '%' || pattern || '%'
      ORDER BY priority ASC LIMIT 1;
    END IF;

    IF v_target_acct_id IS NULL THEN
      SELECT target_account_id INTO v_target_acct_id
      FROM public.classification_rules
      WHERE agency_id = p_agency_id AND is_active = true
        AND rule_type IN ('bank','either')
        AND (
             (match_field = 'description'  AND v_txn.description                    ILIKE '%' || pattern || '%')
          OR (match_field = 'counterparty' AND COALESCE(v_txn.counterparty,'') ILIKE '%' || pattern || '%')
          OR (match_field = 'memo'         AND COALESCE(v_txn.memo,'')         ILIKE '%' || pattern || '%')
          OR (match_field = 'category'     AND COALESCE(v_txn.category,'')     ILIKE '%' || pattern || '%')
        )
      ORDER BY priority ASC LIMIT 1;
    END IF;

    IF v_target_acct_id IS NULL THEN
      v_target_acct_id := CASE WHEN v_txn.amount > 0
        THEN v_uncategorized_income_id
        ELSE v_uncategorized_expense_id
      END;
    END IF;

    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, source, description, reference_number, created_by, created_at
    ) VALUES (
      p_agency_id,
      v_txn.transaction_date,
      CASE WHEN v_txn.amount > 0 THEN 'bank_deposit' ELSE 'bank_withdrawal' END,
      'bank_gl_writer',
      COALESCE(v_txn.description, 'Bank transaction'),
      'bank_transactions:' || v_txn.id::text,
      'bank_gl_writer',
      v_now
    ) RETURNING id INTO v_entry_id;

    IF v_txn.amount > 0 THEN
      INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
      VALUES
        (v_entry_id, p_agency_id, v_cash_acct_id,   v_txn.amount, 0,
         'Deposit: ' || COALESCE(v_txn.description, ''), v_now),
        (v_entry_id, p_agency_id, v_target_acct_id, 0, v_txn.amount,
         COALESCE(v_txn.category, v_txn.description, ''), v_now);
    ELSE
      INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
      VALUES
        (v_entry_id, p_agency_id, v_target_acct_id, ABS(v_txn.amount), 0,
         COALESCE(v_txn.category, v_txn.description, ''), v_now),
        (v_entry_id, p_agency_id, v_cash_acct_id,   0, ABS(v_txn.amount),
         'Withdrawal: ' || COALESCE(v_txn.description, ''), v_now);
    END IF;

    UPDATE public.bank_transactions SET journal_entry_id = v_entry_id WHERE id = v_txn.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'records_skipped',   v_skipped,
    'output_summary',    v_count || ' bank transactions posted to GL'
      || CASE WHEN v_skipped > 0 THEN ' (' || v_skipped || ' skipped — no cash account resolvable)' ELSE '' END
  );
END;
$function$;


-- ---------------------------------------------------------------------
-- 6. cc_gl_writer
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cc_gl_writer(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_count                    INTEGER := 0;
  v_skipped                  INTEGER := 0;
  v_txn                      RECORD;
  v_card_acct_id             UUID;
  v_target_acct_id           UUID;
  v_cash_acct_id             UUID;
  v_uncategorized_expense_id UUID;
  v_entry_id                 UUID;
  v_now                      TIMESTAMPTZ := NOW();
  v_cutover_date             DATE;
  v_is_payment               BOOLEAN;
BEGIN
  SELECT setting_value::date INTO v_cutover_date
  FROM public.settings WHERE agency_id = p_agency_id AND setting_key = 'cutover_date' LIMIT 1;

  SELECT id INTO v_cash_acct_id FROM public.chart_of_accounts
    WHERE agency_id = p_agency_id AND account_code = '1010' LIMIT 1;
  SELECT id INTO v_uncategorized_expense_id FROM public.chart_of_accounts
    WHERE agency_id = p_agency_id AND account_code = '6999' LIMIT 1;

  IF v_cash_acct_id IS NULL OR v_uncategorized_expense_id IS NULL THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary', 'Skipped: chart_of_accounts missing 1010 (Operating Checking) or 6999 (Uncategorized Expense)'
    );
  END IF;

  FOR v_txn IN
    SELECT ct.id, ct.credit_account_id, ct.transaction_date, ct.description,
           ct.amount, ct.transaction_type, ct.category,
           ca.account_name AS card_acct_name, ca.institution
    FROM public.credit_transactions ct
    LEFT JOIN public.credit_accounts ca ON ca.id = ct.credit_account_id
    WHERE ct.agency_id = p_agency_id
      AND ct.journal_entry_id IS NULL
      AND ct.amount IS NOT NULL
      AND ct.amount != 0
      AND (v_cutover_date IS NULL OR ct.transaction_date >= v_cutover_date)
    ORDER BY ct.transaction_date, ct.id
    LIMIT 500
  LOOP
    v_card_acct_id := NULL;
    IF v_txn.card_acct_name IS NOT NULL THEN
      SELECT id INTO v_card_acct_id FROM public.chart_of_accounts
        WHERE agency_id = p_agency_id AND LOWER(account_name) = LOWER(v_txn.card_acct_name) LIMIT 1;
    END IF;
    IF v_card_acct_id IS NULL THEN
      SELECT id INTO v_card_acct_id FROM public.chart_of_accounts
        WHERE agency_id = p_agency_id
          AND account_code = CASE
            WHEN LOWER(COALESCE(v_txn.institution, v_txn.card_acct_name, '')) LIKE '%chase%' THEN '2110'
            ELSE '2120'
          END LIMIT 1;
    END IF;

    IF v_card_acct_id IS NULL THEN
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    v_is_payment := (LOWER(COALESCE(v_txn.transaction_type, '')) = 'payment') OR (v_txn.amount < 0);

    IF v_is_payment THEN
      INSERT INTO public.journal_entries (
        agency_id, entry_date, entry_type, source, description, reference_number, created_by, created_at
      ) VALUES (
        p_agency_id, v_txn.transaction_date, 'cc_payment', 'cc_gl_writer',
        COALESCE(v_txn.description, 'Credit card payment'),
        'credit_transactions:' || v_txn.id::text, 'cc_gl_writer', v_now
      ) RETURNING id INTO v_entry_id;

      INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
      VALUES
        (v_entry_id, p_agency_id, v_card_acct_id, ABS(v_txn.amount), 0, 'Card payment', v_now),
        (v_entry_id, p_agency_id, v_cash_acct_id, 0, ABS(v_txn.amount), 'From operating cash', v_now);
    ELSE
      v_target_acct_id := NULL;
      IF v_txn.category IS NOT NULL AND v_txn.category <> '' THEN
        SELECT id INTO v_target_acct_id FROM public.chart_of_accounts
          WHERE agency_id = p_agency_id AND is_active = true
            AND LOWER(account_name) = LOWER(v_txn.category) LIMIT 1;
      END IF;
      IF v_target_acct_id IS NULL THEN
        SELECT target_account_id INTO v_target_acct_id
        FROM public.classification_rules
        WHERE agency_id = p_agency_id AND is_active = true
          AND rule_type IN ('credit','either')
          AND (
               (match_field = 'description' AND v_txn.description ILIKE '%' || pattern || '%')
            OR (match_field = 'category'    AND COALESCE(v_txn.category,'') ILIKE '%' || pattern || '%')
          )
        ORDER BY priority ASC LIMIT 1;
      END IF;
      IF v_target_acct_id IS NULL THEN v_target_acct_id := v_uncategorized_expense_id; END IF;

      INSERT INTO public.journal_entries (
        agency_id, entry_date, entry_type, source, description, reference_number, created_by, created_at
      ) VALUES (
        p_agency_id, v_txn.transaction_date, 'cc_charge', 'cc_gl_writer',
        COALESCE(v_txn.description, 'Credit card charge'),
        'credit_transactions:' || v_txn.id::text, 'cc_gl_writer', v_now
      ) RETURNING id INTO v_entry_id;

      INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
      VALUES
        (v_entry_id, p_agency_id, v_target_acct_id, ABS(v_txn.amount), 0,
         COALESCE(v_txn.category, v_txn.description, ''), v_now),
        (v_entry_id, p_agency_id, v_card_acct_id, 0, ABS(v_txn.amount), 'Charged to card', v_now);
    END IF;

    UPDATE public.credit_transactions SET journal_entry_id = v_entry_id WHERE id = v_txn.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'records_skipped',   v_skipped,
    'output_summary',    v_count || ' credit transactions posted to GL'
      || CASE WHEN v_skipped > 0 THEN ' (' || v_skipped || ' skipped — no card account resolvable)' ELSE '' END
  );
END;
$function$;


-- ---------------------------------------------------------------------
-- 7. payroll_gl_writer
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_gl_writer(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_count         INTEGER := 0;
  v_run           RECORD;
  v_cash_acct_id  UUID;
  v_wages_acct_id UUID;
  v_ertax_acct_id UUID;
  v_entry_id      UUID;
  v_now           TIMESTAMPTZ := NOW();
  v_cutover_date  DATE;
  v_total         NUMERIC;
BEGIN
  SELECT setting_value::date INTO v_cutover_date
  FROM public.settings WHERE agency_id = p_agency_id AND setting_key = 'cutover_date' LIMIT 1;

  SELECT id INTO v_cash_acct_id  FROM public.chart_of_accounts
    WHERE agency_id = p_agency_id AND account_code = '1010' LIMIT 1;
  SELECT id INTO v_wages_acct_id FROM public.chart_of_accounts
    WHERE agency_id = p_agency_id AND account_code = '6010' LIMIT 1;
  SELECT id INTO v_ertax_acct_id FROM public.chart_of_accounts
    WHERE agency_id = p_agency_id AND account_code = '6030' LIMIT 1;

  IF v_cash_acct_id IS NULL OR v_wages_acct_id IS NULL OR v_ertax_acct_id IS NULL THEN
    RETURN jsonb_build_object(
      'records_processed', 0,
      'output_summary', 'Skipped: chart_of_accounts missing 1010 / 6010 / 6030'
    );
  END IF;

  FOR v_run IN
    SELECT id, pay_period_start, pay_period_end, pay_date, payroll_provider,
           gross_payroll, employer_taxes
    FROM public.payroll_runs
    WHERE agency_id = p_agency_id
      AND journal_entry_id IS NULL
      AND COALESCE(gross_payroll, 0) > 0
      AND (v_cutover_date IS NULL OR pay_date >= v_cutover_date)
    ORDER BY pay_date, id
    LIMIT 500
  LOOP
    v_total := COALESCE(v_run.gross_payroll, 0) + COALESCE(v_run.employer_taxes, 0);

    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, source, description, reference_number, created_by, created_at
    ) VALUES (
      p_agency_id, v_run.pay_date, 'payroll', 'payroll_gl_writer',
      'Payroll ' || v_run.pay_period_start::text || ' to ' || v_run.pay_period_end::text
        || COALESCE(' (' || v_run.payroll_provider || ')', ''),
      'payroll_runs:' || v_run.id::text, 'payroll_gl_writer', v_now
    ) RETURNING id INTO v_entry_id;

    INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
    VALUES
      (v_entry_id, p_agency_id, v_wages_acct_id, COALESCE(v_run.gross_payroll, 0), 0, 'Gross wages', v_now),
      (v_entry_id, p_agency_id, v_ertax_acct_id, COALESCE(v_run.employer_taxes, 0), 0, 'Employer taxes', v_now),
      (v_entry_id, p_agency_id, v_cash_acct_id, 0, v_total, 'Net payroll cash out', v_now);

    UPDATE public.payroll_runs SET journal_entry_id = v_entry_id WHERE id = v_run.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'output_summary',    v_count || ' payroll runs posted to GL'
  );
END;
$function$;


-- ---------------------------------------------------------------------
-- 8. Grant execute privileges
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.bank_gl_writer(uuid, uuid)    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cc_gl_writer(uuid, uuid)      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_gl_writer(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.bank_gl_writer(uuid, uuid)    TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_gl_writer(uuid, uuid)      TO service_role;
GRANT EXECUTE ON FUNCTION public.payroll_gl_writer(uuid, uuid) TO service_role;
