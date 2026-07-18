-- =========================================================================
-- Migration: 017b_qbo_journal_lines_expanded_v2
-- Supabase version: 20260616231732
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- Expand qbo_journal_lines to hold all GL-row fields without requiring parent header
ALTER TABLE public.qbo_journal_lines
  ADD COLUMN IF NOT EXISTS qbo_txn_type            text,
  ADD COLUMN IF NOT EXISTS doc_num                 text,
  ADD COLUMN IF NOT EXISTS counterparty_name       text,
  ADD COLUMN IF NOT EXISTS split_qbo_account_id    text,
  ADD COLUMN IF NOT EXISTS split_qbo_account_name  text,
  ADD COLUMN IF NOT EXISTS amount_natural          numeric(14,2),
  ADD COLUMN IF NOT EXISTS is_adj                  boolean DEFAULT false;

ALTER TABLE public.qbo_journal_lines
  ALTER COLUMN qbo_journal_entry_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_qbo_jl_txn_type
  ON public.qbo_journal_lines (agency_id, qbo_txn_type, txn_date);
CREATE INDEX IF NOT EXISTS idx_qbo_jl_split
  ON public.qbo_journal_lines (agency_id, split_qbo_account_id) WHERE split_qbo_account_id IS NOT NULL;

-- DROP and rebuild the view to allow column restructuring
DROP VIEW IF EXISTS public.v_unified_general_ledger;

CREATE VIEW public.v_unified_general_ledger AS
SELECT
  'bcc'                       AS source_layer,
  je.id::text                 AS source_id,
  je.entry_date               AS txn_date,
  je.entry_type               AS txn_type,
  je.reference_number         AS doc_number,
  je.description              AS memo,
  coa.account_code            AS account_code,
  coa.account_name            AS account_name,
  jl.debit                    AS debit,
  jl.credit                   AS credit,
  NULL::text                  AS split_account_name,
  je.agency_id                AS agency_id
FROM public.journal_entries je
JOIN public.journal_lines jl ON jl.journal_entry_id = je.id
LEFT JOIN public.chart_of_accounts coa ON coa.id = jl.account_id
UNION ALL
SELECT
  'qbo'                       AS source_layer,
  qjl.id::text                AS source_id,
  qjl.txn_date                AS txn_date,
  qjl.qbo_txn_type            AS txn_type,
  qjl.doc_num                 AS doc_number,
  qjl.line_memo               AS memo,
  qa.acct_num                 AS account_code,
  qjl.qbo_account_name        AS account_name,
  qjl.debit                   AS debit,
  qjl.credit                  AS credit,
  qjl.split_qbo_account_name  AS split_account_name,
  qjl.agency_id               AS agency_id
FROM public.qbo_journal_lines qjl
LEFT JOIN public.qbo_accounts qa ON qa.qbo_id = qjl.qbo_account_id AND qa.agency_id = qjl.agency_id;

GRANT SELECT ON public.v_unified_general_ledger TO authenticated, anon;