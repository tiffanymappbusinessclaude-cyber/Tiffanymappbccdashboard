-- =========================================================================
-- Migration: 015d_cc_gl_writer_card_heuristic_fix
-- Supabase version: 20260616215404
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- Update cc_gl_writer's card-account fallback to match the agent's actual cards (AmEx + US Bank)
CREATE OR REPLACE FUNCTION public.cc_gl_writer(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_count INTEGER := 0; v_skipped INTEGER := 0; v_txn RECORD;
  v_card_acct_id UUID; v_target_acct_id UUID; v_cash_acct_id UUID;
  v_uncategorized_expense_id UUID; v_entry_id UUID;
  v_now TIMESTAMPTZ := NOW(); v_cutover_date DATE; v_is_payment BOOLEAN;
  v_inst_key text;
BEGIN
  SELECT setting_value::date INTO v_cutover_date
  FROM public.settings WHERE agency_id = p_agency_id AND setting_key = 'cutover_date' LIMIT 1;

  SELECT id INTO v_cash_acct_id FROM public.chart_of_accounts
    WHERE agency_id = p_agency_id AND account_code = '1010' LIMIT 1;
  SELECT id INTO v_uncategorized_expense_id FROM public.chart_of_accounts
    WHERE agency_id = p_agency_id AND account_code = '6999' LIMIT 1;
  IF v_cash_acct_id IS NULL OR v_uncategorized_expense_id IS NULL THEN
    RETURN jsonb_build_object('records_processed', 0,
      'output_summary', 'Skipped: chart_of_accounts missing 1010 or 6999');
  END IF;

  FOR v_txn IN
    SELECT ct.id, ct.credit_account_id, ct.transaction_date, ct.description,
           ct.amount, ct.transaction_type, ct.category,
           ca.account_name AS card_acct_name, ca.institution
    FROM public.credit_transactions ct
    LEFT JOIN public.credit_accounts ca ON ca.id = ct.credit_account_id
    WHERE ct.agency_id = p_agency_id AND ct.journal_entry_id IS NULL
      AND ct.amount IS NOT NULL AND ct.amount != 0
      AND (v_cutover_date IS NULL OR ct.transaction_date >= v_cutover_date)
    ORDER BY ct.transaction_date, ct.id LIMIT 500
  LOOP
    v_inst_key := LOWER(COALESCE(v_txn.institution, v_txn.card_acct_name, ''));

    v_card_acct_id := NULL;
    IF v_txn.card_acct_name IS NOT NULL THEN
      SELECT id INTO v_card_acct_id FROM public.chart_of_accounts
        WHERE agency_id = p_agency_id AND LOWER(account_name) = LOWER(v_txn.card_acct_name) LIMIT 1;
    END IF;
    IF v_card_acct_id IS NULL THEN
      SELECT id INTO v_card_acct_id FROM public.chart_of_accounts
        WHERE agency_id = p_agency_id
          AND account_code = CASE
            WHEN v_inst_key LIKE '%amex%' OR v_inst_key LIKE '%american express%' THEN '2110'
            WHEN v_inst_key LIKE '%us bank%' OR v_inst_key LIKE '%usbank%'         THEN '2120'
            ELSE '2120'
          END LIMIT 1;
    END IF;
    IF v_card_acct_id IS NULL THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

    v_is_payment := (LOWER(COALESCE(v_txn.transaction_type, '')) = 'payment') OR (v_txn.amount < 0);

    IF v_is_payment THEN
      INSERT INTO public.journal_entries (
        agency_id, entry_date, entry_type, source, description, reference_number, created_by, created_at
      ) VALUES (p_agency_id, v_txn.transaction_date, 'cc_payment', 'cc_gl_writer',
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
      ) VALUES (p_agency_id, v_txn.transaction_date, 'cc_charge', 'cc_gl_writer',
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
    'records_processed', v_count, 'records_skipped', v_skipped,
    'output_summary', v_count || ' credit transactions posted to GL'
      || CASE WHEN v_skipped > 0 THEN ' (' || v_skipped || ' skipped — no card account)' ELSE '' END
  );
END;
$function$;