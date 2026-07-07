-- =========================================================================
-- 049_fix_bank_cc_gl_writers_schema_drift.sql
-- =========================================================================
-- Repair Bank GL Writer + CC GL Writer after schema-drift regression.
--
-- Root cause: bank_gl_writer and cc_gl_writer were coded against IA-master
-- schema (bank_account_mapping table, ca.chart_of_accounts_id column,
-- bt.txn_date / bt.account_id / bt.is_posted_to_gl / bt.is_pre_cutover
-- columns) that do NOT exist in Tiffany's BCC schema. Both recipes ran clean
-- from 2026-06-22 through 2026-07-02 (the daily 16:30/16:45 UTC runs simply
-- produced 0 records because bank_transactions and credit_transactions are
-- both empty), then began failing 2026-07-03 with 42P01 / 42703 errors.
--
-- Applied live to production via SUPABASE_APPLY_A_MIGRATION on 2026-07-06.
-- This file versions the same DDL in the repo for source-of-truth alignment.
--
-- 1. Add chart_of_accounts_id linkage columns to bank_accounts and
--    credit_accounts (nullable; Tiffany populates when each account is
--    mapped to its GL cash/liability account during statement onboarding).
-- 2. Rewrite bank_gl_writer to match actual bank_transactions schema
--    (bank_account_id, transaction_date, posted_at, journal_entry_id).
--    New skip-unmapped bucket added: bank txn without a mapped COA account
--    is now counted as skipped_unmapped rather than throwing.
-- 3. Patch cc_gl_writer to stamp source_table/source_id on journal_entries
--    (aligns with idx_je_source_dedup pattern used by gl_entry_writer).
--    ca.chart_of_accounts_id column now exists via ALTER above.
--
-- Verified 2026-07-06 by direct SELECT invocation of both handlers:
--   bank_gl_writer -> {records_processed: 0, output_summary: "0 bank txns posted..."}
--   cc_gl_writer   -> {records_processed: 0, output_summary: "0 CC txns posted..."}
-- =========================================================================

ALTER TABLE public.bank_accounts
  ADD COLUMN IF NOT EXISTS chart_of_accounts_id UUID REFERENCES public.chart_of_accounts(id);

ALTER TABLE public.credit_accounts
  ADD COLUMN IF NOT EXISTS chart_of_accounts_id UUID REFERENCES public.chart_of_accounts(id);

CREATE OR REPLACE FUNCTION public.bank_gl_writer(p_agency_id uuid, p_recipe_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_cutover_date     DATE;
  v_suspense_id      UUID;
  v_txn              RECORD;
  v_bank_coa_id      UUID;
  v_entry_id         UUID;
  v_abs_amount       NUMERIC;
  v_dr_id            UUID;
  v_cr_id            UUID;
  v_count            INTEGER := 0;
  v_skipped_unmapped INTEGER := 0;
  v_skipped_by_rule  INTEGER := 0;
  v_classified_count INTEGER := 0;
  v_now              TIMESTAMPTZ := NOW();
  v_rule_id          UUID;
  v_rule_action      TEXT;
  v_rule_target_code TEXT;
  v_classified_id    UUID;
BEGIN
  SELECT setting_value::date INTO v_cutover_date
  FROM public.settings
  WHERE agency_id=p_agency_id AND setting_key='gl_cutover_date' LIMIT 1;
  v_cutover_date := COALESCE(v_cutover_date, '2000-01-01'::date);

  SELECT id INTO v_suspense_id
  FROM public.chart_of_accounts
  WHERE agency_id=p_agency_id AND account_code='1990' LIMIT 1;
  IF v_suspense_id IS NULL THEN
    RETURN jsonb_build_object('records_processed', 0,
      'output_summary', 'Skipped: 1990 Suspense account not found');
  END IF;

  FOR v_txn IN
    SELECT bt.id, bt.transaction_date, bt.description, bt.amount,
           bt.bank_account_id, ba.chart_of_accounts_id AS bank_coa_id
    FROM public.bank_transactions bt
    LEFT JOIN public.bank_accounts ba ON ba.id = bt.bank_account_id
    WHERE bt.agency_id = p_agency_id
      AND bt.transaction_date > v_cutover_date
      AND bt.posted_at IS NULL
      AND bt.journal_entry_id IS NULL
      AND bt.amount IS NOT NULL AND bt.amount <> 0
    ORDER BY bt.transaction_date, bt.id
  LOOP
    v_bank_coa_id := v_txn.bank_coa_id;
    IF v_bank_coa_id IS NULL THEN
      v_skipped_unmapped := v_skipped_unmapped + 1;
      CONTINUE;
    END IF;

    v_rule_id := NULL; v_rule_action := NULL; v_rule_target_code := NULL;
    SELECT cr.id, cr.rule_action, cr.target_account_code
      INTO v_rule_id, v_rule_action, v_rule_target_code
    FROM public.classification_rules cr
    WHERE cr.agency_id = p_agency_id
      AND cr.source = 'bank'
      AND cr.is_active = true
      AND v_txn.description ILIKE '%' || cr.match_pattern || '%'
      AND (
        cr.amount_sign = 'any'
        OR (cr.amount_sign = 'positive' AND v_txn.amount > 0)
        OR (cr.amount_sign = 'negative' AND v_txn.amount < 0)
      )
    ORDER BY cr.priority ASC, cr.id ASC
    LIMIT 1;

    IF v_rule_action = 'skip' THEN
      UPDATE public.bank_transactions SET posted_at = v_now WHERE id = v_txn.id;
      v_skipped_by_rule := v_skipped_by_rule + 1;
      CONTINUE;
    END IF;

    v_classified_id := NULL;
    IF v_rule_action = 'reclassify' AND v_rule_target_code IS NOT NULL THEN
      SELECT id INTO v_classified_id
      FROM public.chart_of_accounts
      WHERE agency_id = p_agency_id AND account_code = v_rule_target_code
      LIMIT 1;
    END IF;
    IF v_classified_id IS NULL THEN
      v_classified_id := v_suspense_id;
      v_rule_id := NULL;
    ELSE
      v_classified_count := v_classified_count + 1;
    END IF;

    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, source, source_table, source_id,
      reference_number, description, memo, created_by, created_at, classification_rule_id
    ) VALUES (
      p_agency_id, v_txn.transaction_date, 'bank_transaction', 'bank_gl_writer',
      'bank_transactions', v_txn.id,
      'BANK-' || v_txn.id::text,
      COALESCE(NULLIF(trim(v_txn.description), ''), 'Bank transaction ' || v_txn.transaction_date::text),
      CASE WHEN v_rule_id IS NOT NULL
           THEN 'Auto-posted via bank_gl_writer. Classified by rule ' || v_rule_id::text || '.'
           ELSE 'Auto-posted via bank_gl_writer. Suspense-side pending classification.'
      END,
      'bank_gl_writer', v_now, v_rule_id
    )
    ON CONFLICT (agency_id, source_table, source_id) DO NOTHING
    RETURNING id INTO v_entry_id;

    IF v_entry_id IS NULL THEN
      UPDATE public.bank_transactions SET posted_at = v_now WHERE id = v_txn.id;
      CONTINUE;
    END IF;

    v_abs_amount := ABS(v_txn.amount);
    IF v_txn.amount > 0 THEN
      v_dr_id := v_bank_coa_id; v_cr_id := v_classified_id;
    ELSE
      v_dr_id := v_classified_id; v_cr_id := v_bank_coa_id;
    END IF;

    INSERT INTO public.journal_lines (
      journal_entry_id, agency_id, account_id, debit, credit, description, created_at
    ) VALUES
      (v_entry_id, p_agency_id, v_dr_id, v_abs_amount, 0, v_txn.description, v_now),
      (v_entry_id, p_agency_id, v_cr_id, 0, v_abs_amount, v_txn.description, v_now);

    UPDATE public.bank_transactions SET posted_at = v_now, journal_entry_id = v_entry_id WHERE id = v_txn.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'records_classified', v_classified_count,
    'records_skipped_unmapped', v_skipped_unmapped,
    'records_skipped_by_rule', v_skipped_by_rule,
    'output_summary',
      v_count || ' bank txns posted (' || v_classified_count || ' classified, ' || (v_count - v_classified_count) || ' to suspense), ' || v_skipped_by_rule || ' skipped by rule'
      || CASE WHEN v_skipped_unmapped > 0 THEN '; ' || v_skipped_unmapped || ' skipped (bank_account.chart_of_accounts_id unmapped)' ELSE '' END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.cc_gl_writer(p_agency_id uuid, p_recipe_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_cutover_date     DATE;
  v_suspense_exp_id  UUID;
  v_txn              RECORD;
  v_cc_acct_id       UUID;
  v_other_acct_id    UUID;
  v_entry_id         UUID;
  v_abs_amount       NUMERIC;
  v_dr_id            UUID;
  v_cr_id            UUID;
  v_count            INTEGER := 0;
  v_skipped          INTEGER := 0;
  v_skipped_by_rule  INTEGER := 0;
  v_classified_count INTEGER := 0;
  v_now              TIMESTAMPTZ := NOW();
  v_rule_id          UUID;
  v_rule_action      TEXT;
  v_rule_target_code TEXT;
  v_classified_id    UUID;
BEGIN
  SELECT setting_value::date INTO v_cutover_date
  FROM public.settings
  WHERE agency_id=p_agency_id AND setting_key='gl_cutover_date' LIMIT 1;
  v_cutover_date := COALESCE(v_cutover_date, '2000-01-01'::date);

  SELECT id INTO v_suspense_exp_id
  FROM public.chart_of_accounts
  WHERE agency_id=p_agency_id AND account_code='6990' LIMIT 1;
  IF v_suspense_exp_id IS NULL THEN
    RETURN jsonb_build_object('records_processed', 0,
      'output_summary', 'Skipped: 6990 Suspense Expense not found');
  END IF;

  FOR v_txn IN
    SELECT ct.id, ct.transaction_date, ct.description, ct.amount, ct.transaction_type,
           ct.category, ct.credit_account_id,
           ca.chart_of_accounts_id AS cc_coa_id
    FROM public.credit_transactions ct
    LEFT JOIN public.credit_accounts ca ON ca.id = ct.credit_account_id
    WHERE ct.agency_id = p_agency_id
      AND ct.transaction_date > v_cutover_date
      AND ct.journal_entry_id IS NULL
      AND COALESCE(ct.is_posted_to_gl, false) = false
      AND ct.amount IS NOT NULL AND ct.amount <> 0
    ORDER BY ct.transaction_date, ct.id
  LOOP
    v_cc_acct_id := v_txn.cc_coa_id;
    IF v_cc_acct_id IS NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_rule_id := NULL; v_rule_action := NULL; v_rule_target_code := NULL;
    SELECT cr.id, cr.rule_action, cr.target_account_code
      INTO v_rule_id, v_rule_action, v_rule_target_code
    FROM public.classification_rules cr
    WHERE cr.agency_id = p_agency_id
      AND cr.source = 'credit_card'
      AND cr.is_active = true
      AND v_txn.description ILIKE '%' || cr.match_pattern || '%'
      AND (
        cr.amount_sign = 'any'
        OR (cr.amount_sign = 'positive' AND v_txn.amount > 0)
        OR (cr.amount_sign = 'negative' AND v_txn.amount < 0)
      )
    ORDER BY cr.priority ASC, cr.id ASC
    LIMIT 1;

    IF v_rule_action = 'skip' THEN
      UPDATE public.credit_transactions SET is_posted_to_gl = true WHERE id = v_txn.id;
      v_skipped_by_rule := v_skipped_by_rule + 1;
      CONTINUE;
    END IF;

    v_classified_id := NULL;
    IF v_rule_action = 'reclassify' AND v_rule_target_code IS NOT NULL THEN
      SELECT id INTO v_classified_id
      FROM public.chart_of_accounts
      WHERE agency_id = p_agency_id AND account_code = v_rule_target_code
      LIMIT 1;
    END IF;
    IF v_classified_id IS NULL THEN
      v_classified_id := v_suspense_exp_id;
      v_rule_id := NULL;
    ELSE
      v_classified_count := v_classified_count + 1;
    END IF;

    v_other_acct_id := v_classified_id;

    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, source, source_table, source_id,
      reference_number, description, memo, created_by, created_at, classification_rule_id
    ) VALUES (
      p_agency_id, v_txn.transaction_date, 'credit_transaction', 'cc_gl_writer',
      'credit_transactions', v_txn.id,
      'CC-' || v_txn.id::text,
      COALESCE(NULLIF(trim(v_txn.description), ''), 'CC transaction ' || v_txn.transaction_date::text),
      CASE WHEN v_rule_id IS NOT NULL
           THEN 'Auto-posted via cc_gl_writer. Classified by rule ' || v_rule_id::text || '.'
           ELSE 'Auto-posted via cc_gl_writer. Expense side pending classification.'
      END,
      'cc_gl_writer', v_now, v_rule_id
    )
    ON CONFLICT (agency_id, source_table, source_id) DO NOTHING
    RETURNING id INTO v_entry_id;

    IF v_entry_id IS NULL THEN
      UPDATE public.credit_transactions SET is_posted_to_gl = true WHERE id = v_txn.id;
      CONTINUE;
    END IF;

    v_abs_amount := ABS(v_txn.amount);
    IF v_txn.amount > 0 THEN
      v_dr_id := v_other_acct_id; v_cr_id := v_cc_acct_id;
    ELSE
      v_dr_id := v_cc_acct_id;    v_cr_id := v_other_acct_id;
    END IF;

    INSERT INTO public.journal_lines (
      journal_entry_id, agency_id, account_id, debit, credit, description, created_at
    ) VALUES
      (v_entry_id, p_agency_id, v_dr_id, v_abs_amount, 0, v_txn.description, v_now),
      (v_entry_id, p_agency_id, v_cr_id, 0, v_abs_amount, v_txn.description, v_now);

    UPDATE public.credit_transactions SET is_posted_to_gl = true, journal_entry_id = v_entry_id WHERE id = v_txn.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'records_classified', v_classified_count,
    'records_skipped_unmapped_card', v_skipped,
    'records_skipped_by_rule', v_skipped_by_rule,
    'output_summary',
      v_count || ' CC txns posted (' || v_classified_count || ' classified, ' || (v_count - v_classified_count) || ' to suspense), ' || v_skipped_by_rule || ' skipped by mirror rule'
      || CASE WHEN v_skipped > 0 THEN '; ' || v_skipped || ' skipped (credit_account.chart_of_accounts_id unmapped)' ELSE '' END
  );
END;
$function$;
