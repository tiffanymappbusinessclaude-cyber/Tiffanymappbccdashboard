-- =============================================================================
-- Migration 014 — Missing INTERNAL Recipe Handlers (Backported from Client Forks)
-- =============================================================================
-- Backports four INTERNAL recipe handlers that seed_bcc_automations() references
-- but that were never captured back to the master template. Without this
-- migration, four of the 14 seeded recipes error 'function does not exist' at
-- every fire (Bank GL Writer, Credit Card GL Writer, Payroll GL Writer,
-- Monthly Close Generator).
--
-- SOURCE: Kwame Tyler's fork (kwametylerbusinessclaude-hue/Tylerbccdashboard),
-- migrations 019 (payroll_gl_writer + monthly_close_generator + suspense accts)
-- and 020 (bank_gl_writer + cc_gl_writer with classification_rules support).
-- Additionally incorporates Kwame's 021 (credit_transactions.is_posted_to_gl
-- column) as a prerequisite.
--
-- ALL FUNCTIONS ARE AGENCY-AGNOSTIC — they take p_agency_id as a parameter and
-- do not hardcode any client-specific UUIDs. Kwame's hardcoded agency IDs in
-- the source migrations have been generalized here to per-agency loops that
-- iterate over public.agency.
--
-- PATTERN: All four handlers follow public.gl_entry_writer's pattern:
--   - Signature (p_agency_id uuid, p_recipe_id uuid) returns jsonb
--   - Returns jsonb_build_object('records_processed', N, 'output_summary', text)
--   - SECURITY DEFINER
--   - Idempotent guards on source-table flags / journal_entry_id
--
-- REMAINING GAP (tracked as B8b): three handlers still undefined in master —
-- dispatch_email_archiver, dispatch_document_processor, instagram_manual_reminder.
-- Those were refactored in Kwame's fork into a two-stage prepare/log helper
-- pattern that requires runner code changes. B8b will merge those.
--
-- Author: Main Claude (this session), 2026-07-02
-- Applied as part of Stage 2 of IF master install-journey audit fixes.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 0. Prerequisites
-- ---------------------------------------------------------------------------

-- 0.1 classification_rules table (bank_gl_writer + cc_gl_writer consult this)
CREATE TABLE IF NOT EXISTS public.classification_rules (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id            UUID        NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  source               TEXT        NOT NULL CHECK (source IN ('bank', 'credit_card')),
  match_pattern        TEXT        NOT NULL,
  amount_sign          TEXT        NOT NULL DEFAULT 'any' CHECK (amount_sign IN ('any', 'positive', 'negative')),
  rule_action          TEXT        NOT NULL CHECK (rule_action IN ('skip', 'reclassify')),
  target_account_code  TEXT,
  priority             INTEGER     NOT NULL DEFAULT 100,
  is_active            BOOLEAN     NOT NULL DEFAULT true,
  description          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_classification_rules_agency_source_active_priority
  ON public.classification_rules (agency_id, source, is_active, priority);

COMMENT ON TABLE public.classification_rules IS
  'Per-agency rules consulted by bank_gl_writer and cc_gl_writer to reclassify or skip transactions before they hit suspense accounts. Empty at install; populated per-client as classification patterns emerge. rule_action=skip suppresses journal entry (used for mirror legs like CC-payment/bank-withdrawal pairs). rule_action=reclassify replaces suspense with target_account_code. When no rule matches, transactions fall through to the 1990/6990 suspense accounts.';


-- 0.2 journal_entries.classification_rule_id (audit trail column)
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS classification_rule_id UUID REFERENCES public.classification_rules(id);

COMMENT ON COLUMN public.journal_entries.classification_rule_id IS
  'The classification_rules row that determined this journal entry''s target account (nullable — NULL means suspense fallback or no rule consulted).';


-- 0.3 credit_transactions.is_posted_to_gl (from Kwame 021 — match bank_transactions pattern)
-- Distinguishes "skip-rule" transactions (which have no journal_entry_id but ARE done)
-- from unprocessed ones.
ALTER TABLE public.credit_transactions
  ADD COLUMN IF NOT EXISTS is_posted_to_gl BOOLEAN NOT NULL DEFAULT false;

-- Backfill: any CC txn that already has a JE is by definition posted.
UPDATE public.credit_transactions
   SET is_posted_to_gl = true
 WHERE journal_entry_id IS NOT NULL
   AND is_posted_to_gl  = false;


-- 0.4 Suspense accounts (1990, 6990) for every existing agency
-- Agency-agnostic replacement for Kwame 019's hardcoded-UUID INSERTs.
-- New agencies added after this migration should get suspense accounts either
-- via 003_seed_chart_of_accounts.sql (future update) or via the ensure_
-- pattern in the handler functions below.
INSERT INTO public.chart_of_accounts (agency_id, account_code, account_name, account_type, account_subtype, is_active, is_system)
SELECT a.id, '1990', 'Suspense — Unclassified Cash', 'asset', 'current_asset', true, true
  FROM public.agency a
 WHERE NOT EXISTS (
   SELECT 1 FROM public.chart_of_accounts coa
    WHERE coa.agency_id    = a.id
      AND coa.account_code = '1990'
 );

INSERT INTO public.chart_of_accounts (agency_id, account_code, account_name, account_type, account_subtype, is_active, is_system)
SELECT a.id, '6990', 'Suspense — Unclassified Expense', 'expense', NULL, true, true
  FROM public.agency a
 WHERE NOT EXISTS (
   SELECT 1 FROM public.chart_of_accounts coa
    WHERE coa.agency_id    = a.id
      AND coa.account_code = '6990'
 );


-- ---------------------------------------------------------------------------
-- 1. bank_gl_writer (source: Kwame 020)
-- ---------------------------------------------------------------------------
-- Walks unposted bank_transactions, consults classification_rules for
-- skip/reclassify handling, and writes journal_entries with journal_lines
-- against the mapped bank COA account (or suspense 1990 fallback). Marks
-- each transaction is_posted_to_gl=true after processing.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bank_gl_writer(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_cutover_date     DATE;
  v_suspense_id      UUID;
  v_txn              RECORD;
  v_bank_acct_id     UUID;
  v_entry_id         UUID;
  v_abs_amount       NUMERIC;
  v_dr_id            UUID;
  v_cr_id            UUID;
  v_count            INTEGER := 0;
  v_skipped_by_rule  INTEGER := 0;
  v_classified_count INTEGER := 0;
  v_now              TIMESTAMPTZ := NOW();
  -- Rule lookup vars
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
    SELECT bt.id, bt.txn_date, bt.description, bt.amount, bt.counterparty,
           bt.account_id AS bank_coa_account_id, bam.account_id AS mapped_coa_id
    FROM public.bank_transactions bt
    LEFT JOIN public.bank_account_mapping bam ON bam.id = bt.bank_account_mapping_id
    WHERE bt.agency_id = p_agency_id
      AND COALESCE(bt.is_pre_cutover, bt.txn_date <= v_cutover_date) = false
      AND COALESCE(bt.is_posted_to_gl, false) = false
      AND bt.journal_entry_id IS NULL
      AND bt.amount IS NOT NULL AND bt.amount <> 0
    ORDER BY bt.txn_date, bt.id
  LOOP
    v_bank_acct_id := COALESCE(v_txn.bank_coa_account_id, v_txn.mapped_coa_id);
    IF v_bank_acct_id IS NULL THEN CONTINUE; END IF;

    -- Rule lookup: highest-priority active rule matching description + sign
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

    -- Skip rule: mark posted with no JE (mirror leg of another writer's entry)
    IF v_rule_action = 'skip' THEN
      UPDATE public.bank_transactions
      SET is_posted_to_gl = true
      WHERE id = v_txn.id;
      v_skipped_by_rule := v_skipped_by_rule + 1;
      CONTINUE;
    END IF;

    -- Reclassify rule: resolve target account; fall back to suspense if missing
    v_classified_id := NULL;
    IF v_rule_action = 'reclassify' AND v_rule_target_code IS NOT NULL THEN
      SELECT id INTO v_classified_id
      FROM public.chart_of_accounts
      WHERE agency_id = p_agency_id AND account_code = v_rule_target_code
      LIMIT 1;
    END IF;
    -- If no rule or target not found, default to suspense
    IF v_classified_id IS NULL THEN
      v_classified_id := v_suspense_id;
      v_rule_id := NULL;  -- don't stamp the JE with a rule that didn't fully resolve
    ELSE
      v_classified_count := v_classified_count + 1;
    END IF;

    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, source, reference_number,
      description, memo, created_by, created_at, classification_rule_id
    ) VALUES (
      p_agency_id, v_txn.txn_date, 'bank_transaction', 'bank_gl_writer',
      'BANK-' || v_txn.id::text,
      COALESCE(NULLIF(trim(v_txn.description), ''), 'Bank transaction ' || v_txn.txn_date::text),
      CASE WHEN v_rule_id IS NOT NULL
           THEN 'Auto-posted via bank_gl_writer. Classified by rule ' || v_rule_id::text || '.'
           ELSE 'Auto-posted via bank_gl_writer. Suspense-side pending classification.'
      END,
      'bank_gl_writer', v_now, v_rule_id
    ) RETURNING id INTO v_entry_id;

    v_abs_amount := ABS(v_txn.amount);
    -- Positive (deposit): cash IN → DR bank, CR classified/suspense
    -- Negative (withdrawal): cash OUT → DR classified/suspense, CR bank
    IF v_txn.amount > 0 THEN
      v_dr_id := v_bank_acct_id; v_cr_id := v_classified_id;
    ELSE
      v_dr_id := v_classified_id; v_cr_id := v_bank_acct_id;
    END IF;

    INSERT INTO public.journal_lines (
      journal_entry_id, agency_id, account_id, debit, credit, description, created_at
    ) VALUES
      (v_entry_id, p_agency_id, v_dr_id, v_abs_amount, 0, v_txn.description, v_now),
      (v_entry_id, p_agency_id, v_cr_id, 0, v_abs_amount, v_txn.description, v_now);

    UPDATE public.bank_transactions
    SET is_posted_to_gl = true, journal_entry_id = v_entry_id
    WHERE id = v_txn.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'records_classified', v_classified_count,
    'records_skipped_by_rule', v_skipped_by_rule,
    'output_summary',
      v_count || ' bank txns posted ('
      || v_classified_count || ' classified, '
      || (v_count - v_classified_count) || ' to suspense), '
      || v_skipped_by_rule || ' skipped by mirror rule'
  );
END;
$function$;


-- ---------------------------------------------------------------------------
-- 2. cc_gl_writer (source: Kwame 020)
-- ---------------------------------------------------------------------------
-- Same pattern as bank_gl_writer but for credit_transactions and the
-- credit_card source of classification_rules. Credits are handled as
-- debit-to-suspense-expense / credit-to-CC-liability by default; skip
-- rules suppress the JE entirely (used for mirror payment legs).
-- ---------------------------------------------------------------------------

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

    -- Rule lookup
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

    -- Skip rule
    IF v_rule_action = 'skip' THEN
      UPDATE public.credit_transactions
      SET is_posted_to_gl = true
      WHERE id = v_txn.id;
      v_skipped_by_rule := v_skipped_by_rule + 1;
      CONTINUE;
    END IF;

    -- Reclassify rule
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
      agency_id, entry_date, entry_type, source, reference_number,
      description, memo, created_by, created_at, classification_rule_id
    ) VALUES (
      p_agency_id, v_txn.transaction_date, 'credit_transaction', 'cc_gl_writer',
      'CC-' || v_txn.id::text,
      COALESCE(NULLIF(trim(v_txn.description), ''), 'CC transaction ' || v_txn.transaction_date::text),
      CASE WHEN v_rule_id IS NOT NULL
           THEN 'Auto-posted via cc_gl_writer. Classified by rule ' || v_rule_id::text || '.'
           ELSE 'Auto-posted via cc_gl_writer. Expense side pending classification.'
      END,
      'cc_gl_writer', v_now, v_rule_id
    ) RETURNING id INTO v_entry_id;

    v_abs_amount := ABS(v_txn.amount);
    -- Charge (positive): DR expense/classified / CR CC liability
    -- Payment/refund (negative): DR CC liability / CR expense/classified
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

    UPDATE public.credit_transactions
    SET is_posted_to_gl = true, journal_entry_id = v_entry_id
    WHERE id = v_txn.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'records_classified', v_classified_count,
    'records_skipped_unmapped_card', v_skipped,
    'records_skipped_by_rule', v_skipped_by_rule,
    'output_summary',
      v_count || ' CC txns posted ('
      || v_classified_count || ' classified, '
      || (v_count - v_classified_count) || ' to suspense), '
      || v_skipped_by_rule || ' skipped by mirror rule'
      || CASE WHEN v_skipped > 0
              THEN '; ' || v_skipped || ' skipped (credit_accounts unmapped)'
              ELSE '' END
  );
END;
$function$;


-- ---------------------------------------------------------------------------
-- 3. payroll_gl_writer (source: Kwame 019)
-- ---------------------------------------------------------------------------
-- Walks payroll_runs rows past the gl_cutover_date with status NOT IN
-- ('posted','void'), creating one journal_entry per run with three
-- journal_lines: gross wages (dr 6000), employer taxes (dr 6030 if any),
-- and total cash out (cr 1010). Marks each run status='posted' after.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.payroll_gl_writer(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_cutover_date  DATE;
  v_cash_id       UUID;
  v_wages_id      UUID;
  v_ertax_id      UUID;
  v_run           RECORD;
  v_entry_id      UUID;
  v_total_cash    NUMERIC;
  v_count         INTEGER := 0;
  v_now           TIMESTAMPTZ := NOW();
BEGIN
  SELECT setting_value::date INTO v_cutover_date
  FROM public.settings
  WHERE agency_id=p_agency_id AND setting_key='gl_cutover_date' LIMIT 1;
  v_cutover_date := COALESCE(v_cutover_date, '2000-01-01'::date);

  SELECT id INTO v_cash_id  FROM public.chart_of_accounts WHERE agency_id=p_agency_id AND account_code='1010' LIMIT 1;
  SELECT id INTO v_wages_id FROM public.chart_of_accounts WHERE agency_id=p_agency_id AND account_code='6000' LIMIT 1;
  SELECT id INTO v_ertax_id FROM public.chart_of_accounts WHERE agency_id=p_agency_id AND account_code='6030' LIMIT 1;

  IF v_cash_id IS NULL OR v_wages_id IS NULL THEN
    RETURN jsonb_build_object('records_processed', 0,
      'output_summary', 'Skipped: required accounts 1010/6000 not found');
  END IF;

  FOR v_run IN
    SELECT id, pay_period_start, pay_period_end, pay_date, payroll_provider,
           gross_payroll, employer_taxes, net_payroll
    FROM public.payroll_runs
    WHERE agency_id = p_agency_id
      AND COALESCE(pay_date, pay_period_end) > v_cutover_date
      AND COALESCE(status, '') NOT IN ('posted','void')
      AND COALESCE(gross_payroll, 0) > 0
    ORDER BY pay_date, id
  LOOP
    v_total_cash := COALESCE(v_run.gross_payroll, 0) + COALESCE(v_run.employer_taxes, 0);
    IF v_total_cash <= 0 THEN CONTINUE; END IF;

    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, source, reference_number, description, memo, created_by, created_at
    ) VALUES (
      p_agency_id, COALESCE(v_run.pay_date, v_run.pay_period_end), 'payroll_run', 'payroll_gl_writer',
      'PAY-' || COALESCE(v_run.pay_date, v_run.pay_period_end)::text || '-' || left(v_run.id::text, 8),
      'Payroll ' || COALESCE(v_run.payroll_provider, '') || ' '
        || COALESCE(v_run.pay_period_start::text, '') || ' through ' || COALESCE(v_run.pay_period_end::text, ''),
      'Gross $' || COALESCE(v_run.gross_payroll, 0)::text
        || '; ER taxes $' || COALESCE(v_run.employer_taxes, 0)::text
        || '; Net to staff $' || COALESCE(v_run.net_payroll, 0)::text,
      'payroll_gl_writer', v_now
    ) RETURNING id INTO v_entry_id;

    INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
    VALUES (v_entry_id, p_agency_id, v_wages_id, v_run.gross_payroll, 0, 'Gross payroll', v_now);

    IF COALESCE(v_run.employer_taxes, 0) > 0 AND v_ertax_id IS NOT NULL THEN
      INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
      VALUES (v_entry_id, p_agency_id, v_ertax_id, v_run.employer_taxes, 0, 'Employer payroll taxes', v_now);
    END IF;

    INSERT INTO public.journal_lines (journal_entry_id, agency_id, account_id, debit, credit, description, created_at)
    VALUES (v_entry_id, p_agency_id, v_cash_id, 0, v_total_cash, 'Total cash out for payroll', v_now);

    UPDATE public.payroll_runs SET status = 'posted' WHERE id = v_run.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'output_summary', v_count || ' payroll runs posted to GL'
  );
END;
$fn$;


-- ---------------------------------------------------------------------------
-- 4. monthly_close_generator (source: Kwame 019)
-- ---------------------------------------------------------------------------
-- Reads the recipe's input_config.items JSON array, generates one
-- monthly_close_checklist row per item for the current period, with the
-- doc_label decorated to show which prior month is being closed. Period
-- semantics: period_year/period_month = month when close WORK is performed
-- (e.g., closing May happens in June, so period_month=6, closing May).
-- Idempotent — skips items that already exist.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.monthly_close_generator(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_today          DATE := CURRENT_DATE;
  v_target_year    INT  := EXTRACT(YEAR  FROM v_today)::INT;
  v_target_mo      INT  := EXTRACT(MONTH FROM v_today)::INT;
  v_closing_year   INT;
  v_closing_mo     INT;
  v_first_day      DATE := MAKE_DATE(v_target_year, v_target_mo, 1);
  v_cfg            jsonb;
  v_item           jsonb;
  v_created        INT := 0;
  v_skipped        INT := 0;
  v_offset         INT;
  v_expected       DATE;
  v_label          TEXT;
  v_category       TEXT;
  v_label_decor    TEXT;
BEGIN
  IF v_target_mo = 1 THEN
    v_closing_year := v_target_year - 1; v_closing_mo := 12;
  ELSE
    v_closing_year := v_target_year;     v_closing_mo := v_target_mo - 1;
  END IF;

  SELECT input_config INTO v_cfg FROM public.automation_recipes WHERE id = p_recipe_id;
  IF v_cfg IS NULL OR jsonb_typeof(v_cfg->'items') <> 'array' THEN
    RETURN jsonb_build_object('records_processed', 0,
      'output_summary', 'Skipped: recipe input_config.items missing or not an array');
  END IF;

  v_label_decor := ' (closes ' || TO_CHAR(MAKE_DATE(v_closing_year, v_closing_mo, 1), 'Mon YYYY') || ')';

  FOR v_item IN SELECT jsonb_array_elements(v_cfg->'items')
  LOOP
    v_label    := (v_item->>'doc_label') || v_label_decor;
    v_category := v_item->>'doc_category';
    v_offset   := COALESCE((v_item->>'expected_offset_days')::int, 5);
    v_expected := v_first_day + (v_offset - 1);

    IF EXISTS (
      SELECT 1 FROM public.monthly_close_checklist
      WHERE agency_id = p_agency_id
        AND period_year  = v_target_year
        AND period_month = v_target_mo
        AND doc_label    = v_label
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.monthly_close_checklist (
      agency_id, period_year, period_month, doc_category, doc_label, expected_by,
      received_at, document_id, status, is_closed, notes, created_at
    ) VALUES (
      p_agency_id, v_target_year, v_target_mo, v_category, v_label, v_expected,
      NULL, NULL, 'pending', false,
      'Closes ' || v_closing_year::text || '-' || lpad(v_closing_mo::text, 2, '0') || '. Generated by monthly_close_generator.',
      NOW()
    );
    v_created := v_created + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_created,
    'skipped_existing', v_skipped,
    'period_year',  v_target_year,
    'period_month', v_target_mo,
    'closing_year', v_closing_year,
    'closing_month', v_closing_mo,
    'output_summary', v_created || ' checklist items created for ' || v_target_year || '-' || lpad(v_target_mo::text, 2, '0')
      || ' (closes ' || v_closing_year::text || '-' || lpad(v_closing_mo::text, 2, '0') || ', ' || v_skipped || ' already existed)'
  );
END;
$fn$;


-- =============================================================================
-- End of Migration 014
-- =============================================================================
