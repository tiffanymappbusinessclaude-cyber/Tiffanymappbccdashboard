-- =========================================================================
-- Migration: 017_qbo_mirror_tables
-- Supabase version: 20260616230719
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- =====================================================================
-- Migration 017: QBO mirror tables
-- A parallel namespace that mirrors QBO's chart of accounts, journal
-- entries, and journal lines. Kept separate from BCC's native
-- chart_of_accounts/journal_entries to avoid namespace collision with
-- the 145 SF-specific accounts already seeded.
-- The BCC Financials > General Ledger tab UNIONs both sources.
-- =====================================================================

-- 1. QBO chart of accounts mirror
CREATE TABLE IF NOT EXISTS public.qbo_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             uuid NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  qbo_id                text NOT NULL,
  account_name          text NOT NULL,
  fully_qualified_name  text,
  account_type          text,
  account_subtype       text,
  classification        text,
  current_balance       numeric(14,2),
  active                boolean DEFAULT true,
  acct_num              text,
  description           text,
  is_subaccount         boolean DEFAULT false,
  parent_qbo_id         text,
  raw                   jsonb,
  pulled_at             timestamptz DEFAULT NOW(),
  updated_at            timestamptz DEFAULT NOW(),
  UNIQUE (agency_id, qbo_id)
);
CREATE INDEX IF NOT EXISTS idx_qbo_accounts_type
  ON public.qbo_accounts (agency_id, account_type, classification);

-- 2. QBO journal entry headers (one row per QBO transaction)
CREATE TABLE IF NOT EXISTS public.qbo_journal_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             uuid NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  qbo_txn_id            text NOT NULL,
  qbo_txn_type          text NOT NULL,          -- Invoice / Bill / Payment / Journal Entry / Check / etc.
  txn_date              date NOT NULL,
  doc_number            text,                    -- check #, invoice #, etc.
  customer_name         text,
  vendor_name           text,
  memo                  text,
  total_amount          numeric(14,2),
  accounting_method     text DEFAULT 'cash',
  raw                   jsonb,
  pulled_at             timestamptz DEFAULT NOW(),
  UNIQUE (agency_id, qbo_txn_id, qbo_txn_type, accounting_method)
);
CREATE INDEX IF NOT EXISTS idx_qbo_je_date
  ON public.qbo_journal_entries (agency_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_qbo_je_type
  ON public.qbo_journal_entries (agency_id, qbo_txn_type);

-- 3. QBO journal entry lines (each posting to an account)
CREATE TABLE IF NOT EXISTS public.qbo_journal_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             uuid NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  qbo_journal_entry_id  uuid REFERENCES public.qbo_journal_entries(id) ON DELETE CASCADE,
  qbo_account_id        text NOT NULL,
  qbo_account_name      text,
  txn_date              date,                    -- denormalized for fast range queries
  debit                 numeric(14,2) DEFAULT 0,
  credit                numeric(14,2) DEFAULT 0,
  running_balance       numeric(14,2),
  line_memo             text,
  raw                   jsonb,
  created_at            timestamptz DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qbo_jl_account
  ON public.qbo_journal_lines (agency_id, qbo_account_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_qbo_jl_date
  ON public.qbo_journal_lines (agency_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_qbo_jl_je
  ON public.qbo_journal_lines (qbo_journal_entry_id);

-- 4. Convenience view: unified GL across BCC-native + QBO mirror
CREATE OR REPLACE VIEW public.v_unified_general_ledger AS
SELECT
  'bcc'                  AS source_layer,
  je.id::text            AS source_id,
  je.entry_date          AS txn_date,
  je.entry_type          AS txn_type,
  je.reference_number    AS doc_number,
  je.description         AS memo,
  coa.account_code       AS account_code,
  coa.account_name       AS account_name,
  jl.debit               AS debit,
  jl.credit              AS credit,
  je.agency_id           AS agency_id
FROM public.journal_entries je
JOIN public.journal_lines jl ON jl.journal_entry_id = je.id
LEFT JOIN public.chart_of_accounts coa ON coa.id = jl.account_id
UNION ALL
SELECT
  'qbo'                  AS source_layer,
  qje.id::text           AS source_id,
  qje.txn_date           AS txn_date,
  qje.qbo_txn_type       AS txn_type,
  qje.doc_number         AS doc_number,
  COALESCE(qje.memo, qjl.line_memo) AS memo,
  qa.acct_num            AS account_code,
  qjl.qbo_account_name   AS account_name,
  qjl.debit              AS debit,
  qjl.credit             AS credit,
  qje.agency_id          AS agency_id
FROM public.qbo_journal_entries qje
JOIN public.qbo_journal_lines qjl ON qjl.qbo_journal_entry_id = qje.id
LEFT JOIN public.qbo_accounts qa ON qa.qbo_id = qjl.qbo_account_id AND qa.agency_id = qje.agency_id;

-- 5. Idempotency note column on qbo_snapshots so we can mark monthly fills
ALTER TABLE public.qbo_snapshots
  ADD COLUMN IF NOT EXISTS summarize_by text;  -- 'Total', 'Month', etc., from QBO

GRANT SELECT ON public.qbo_accounts          TO authenticated, anon;
GRANT SELECT ON public.qbo_journal_entries   TO authenticated, anon;
GRANT SELECT ON public.qbo_journal_lines     TO authenticated, anon;
GRANT SELECT ON public.v_unified_general_ledger TO authenticated, anon;