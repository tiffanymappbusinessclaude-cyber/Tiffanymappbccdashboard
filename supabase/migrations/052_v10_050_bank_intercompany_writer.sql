-- ============================================================================
-- Repo file: 052_v10_050_bank_intercompany_writer.sql
-- Applied to DB: 2026-07-08 00:42:53 UTC  (migration version 20260708004253)
-- DB migration name: v10_050_bank_intercompany_writer
-- Provenance: applied via Supabase MCP as part of Fork A arc; back-filled into
--             repo 2026-07-08 to close repo↔DB migration drift.
-- Note: The "v10_050" prefix in the DB name is v10-arc internal numbering and is
--       distinct from the repo's sequential file numbering (this file = 052 in repo).
-- ============================================================================

-- Bank Intercompany Writer — handler for the recipe registered via Fork A #8.
-- Purpose: post paired journal entries for bank transactions that represent
-- INTERCOMPANY movements (S-Corp distributions, owner draws, owner
-- contributions, bank-to-bank transfers) — i.e. movements between two
-- Balance Sheet accounts, NOT income/expense.
--
-- Runs BEFORE bank_gl_writer (30 18 UTC vs bank_gl_writer's 30 16 UTC — note:
-- the recipe registered 2026-07-07 sits at 30 18 UTC; if that ordering needs
-- to change so intercompany fires first, update cron_expression on the
-- recipe row).
--
-- Detection model: relies on public.classification_rules with
--   source='bank', rule_action='reclassify', target_account_code IN
--   (equity accounts 3010, 3020, 3030, 3040, 3050). When the operator wants
--   a transaction posted purely as intercompany, they add a rule pointing at
--   an equity account. This handler picks up ONLY those rows; everything
--   else is left for bank_gl_writer.
--
-- Dedup: journal_entries.source_table='bank_transactions' + source_id=txn.id
-- UNIQUE index already prevents double-post shared with bank_gl_writer.
--
-- Signature: (agency_id, recipe_id) — matches run_internal_recipe()
-- dynamic dispatch pattern. Returns jsonb per BCC handler convention.

CREATE OR REPLACE FUNCTION public.bank_intercompany_writer(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_cutover_date DATE;
  v_txn RECORD;
  v_bank_coa_id UUID;
  v_target_coa_id UUID;
  v_target_type TEXT;
  v_entry_id UUID;
  v_abs_amount NUMERIC;
  v_dr_id UUID;
  v_cr_id UUID;
  v_count INTEGER := 0;
  v_skipped_unmapped INTEGER := 0;
  v_skipped_no_rule INTEGER := 0;
  v_rule_id UUID;
  v_rule_target_code TEXT;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  -- Cutover: only touch live-system transactions (post-May 2026)
  SELECT setting_value::date INTO v_cutover_date
  FROM public.settings
  WHERE agency_id = p_agency_id AND setting_key = 'gl_cutover_date' LIMIT 1;
  v_cutover_date := COALESCE(v_cutover_date, '2000-01-01'::date);

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

    -- Find a matching reclassify rule
    v_rule_id := NULL; v_rule_target_code := NULL;
    SELECT cr.id, cr.target_account_code
      INTO v_rule_id, v_rule_target_code
    FROM public.classification_rules cr
    WHERE cr.agency_id = p_agency_id
      AND cr.source = 'bank'
      AND cr.is_active = true
      AND cr.rule_action = 'reclassify'
      AND cr.target_account_code IS NOT NULL
      AND v_txn.description ILIKE '%' || cr.match_pattern || '%'
      AND (
        cr.amount_sign = 'any'
        OR (cr.amount_sign = 'positive' AND v_txn.amount > 0)
        OR (cr.amount_sign = 'negative' AND v_txn.amount < 0)
      )
    ORDER BY cr.priority ASC, cr.id ASC
    LIMIT 1;

    -- No rule → this handler doesn't touch it (bank_gl_writer will route to suspense)
    IF v_rule_id IS NULL THEN
      v_skipped_no_rule := v_skipped_no_rule + 1;
      CONTINUE;
    END IF;

    -- Resolve the target COA and check it's a Balance Sheet account (equity, asset, or liability).
    -- If the target is a P&L account (income or expense), skip — that's bank_gl_writer's territory.
    SELECT id, account_type INTO v_target_coa_id, v_target_type
    FROM public.chart_of_accounts
    WHERE agency_id = p_agency_id AND account_code = v_rule_target_code
    LIMIT 1;

    IF v_target_coa_id IS NULL THEN
      v_skipped_no_rule := v_skipped_no_rule + 1;
      CONTINUE;
    END IF;

    IF v_target_type NOT IN ('equity','asset','other_asset','liability','other_liability','current_asset','current_liability','fixed_asset','long_term_liability') THEN
      -- Not an intercompany-shaped movement → bank_gl_writer handles it
      v_skipped_no_rule := v_skipped_no_rule + 1;
      CONTINUE;
    END IF;

    -- Post the paired journal entry with intercompany reference prefix
    INSERT INTO public.journal_entries (
      agency_id, entry_date, entry_type, source, source_table, source_id,
      reference_number, description, memo, created_by, created_at, classification_rule_id
    ) VALUES (
      p_agency_id, v_txn.transaction_date, 'intercompany_transfer', 'bank_intercompany_writer',
      'bank_transactions', v_txn.id,
      'INTERCO-' || v_txn.id::text,
      COALESCE(NULLIF(trim(v_txn.description), ''), 'Intercompany transfer ' || v_txn.transaction_date::text),
      'Auto-posted via bank_intercompany_writer. Balance-sheet-only reclassification via rule ' || v_rule_id::text || '.',
      'bank_intercompany_writer', v_now, v_rule_id
    )
    ON CONFLICT (agency_id, source_table, source_id) DO NOTHING
    RETURNING id INTO v_entry_id;

    IF v_entry_id IS NULL THEN
      -- bank_gl_writer already posted this; mark bank_transaction as posted to be safe
      UPDATE public.bank_transactions SET posted_at = v_now WHERE id = v_txn.id;
      CONTINUE;
    END IF;

    v_abs_amount := ABS(v_txn.amount);
    IF v_txn.amount > 0 THEN
      -- Money IN to this bank account: DR bank / CR target (target is source of funds, e.g. owner contribution)
      v_dr_id := v_bank_coa_id; v_cr_id := v_target_coa_id;
    ELSE
      -- Money OUT of this bank account: DR target / CR bank (target is destination, e.g. owner draw)
      v_dr_id := v_target_coa_id; v_cr_id := v_bank_coa_id;
    END IF;

    INSERT INTO public.journal_lines (
      journal_entry_id, agency_id, account_id, debit, credit, description, created_at
    ) VALUES
      (v_entry_id, p_agency_id, v_dr_id, v_abs_amount, 0, v_txn.description, v_now),
      (v_entry_id, p_agency_id, v_cr_id, 0, v_abs_amount, v_txn.description, v_now);

    UPDATE public.bank_transactions
    SET posted_at = v_now, journal_entry_id = v_entry_id
    WHERE id = v_txn.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'records_skipped_unmapped', v_skipped_unmapped,
    'records_skipped_no_rule', v_skipped_no_rule,
    'output_summary',
      v_count || ' intercompany txns posted; '
      || v_skipped_no_rule || ' passed through (no matching reclassify-to-BS rule); '
      || v_skipped_unmapped || ' unmapped (bank_account chart_of_accounts_id null)'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.bank_intercompany_writer(uuid, uuid) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.bank_intercompany_writer(uuid, uuid) IS
  'Handler for Bank Intercompany Writer recipe (Fork A #8, registered 2026-07-07). Runs before bank_gl_writer to post reclassifications where target_account is an equity/asset/liability account (intercompany transfers, owner draws/contributions, S-Corp distributions). Leaves income/expense reclassifications to bank_gl_writer. Adapted from bank_gl_writer 2026-07-07.';
