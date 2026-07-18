-- =========================================================================
-- Migration: 017c_bulk_insert_qbo_journal_lines_rpc
-- Supabase version: 20260616232541
-- Captured from production DB: 2026-06-17
-- =========================================================================

CREATE OR REPLACE FUNCTION public.insert_qbo_journal_lines_bulk(p_lines jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.qbo_journal_lines (
    agency_id, qbo_account_id, qbo_account_name, txn_date, qbo_txn_type, doc_num,
    counterparty_name, line_memo, split_qbo_account_id, split_qbo_account_name,
    amount_natural, debit, credit, running_balance, is_adj
  )
  SELECT
    (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1),
    el->>'qbo_account_id',
    el->>'qbo_account_name',
    (el->>'txn_date')::date,
    el->>'qbo_txn_type',
    NULLIF(el->>'doc_num', ''),
    NULLIF(el->>'counterparty_name', ''),
    NULLIF(el->>'line_memo', ''),
    NULLIF(el->>'split_qbo_account_id', ''),
    NULLIF(el->>'split_qbo_account_name', ''),
    (el->>'amount_natural')::numeric,
    (el->>'debit')::numeric,
    (el->>'credit')::numeric,
    NULLIF(el->>'running_balance', '')::numeric,
    COALESCE((el->>'is_adj')::boolean, false)
  FROM jsonb_array_elements(p_lines) AS el;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.insert_qbo_journal_lines_bulk(jsonb) TO authenticated, anon;