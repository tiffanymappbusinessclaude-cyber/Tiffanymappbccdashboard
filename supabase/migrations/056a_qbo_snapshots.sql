-- =========================================================================
-- Migration: 016_qbo_snapshots
-- Supabase version: 20260616224650
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- =====================================================================
-- Migration 016: qbo_snapshots table
-- Period-end financial snapshots pulled from QuickBooks via the Intuit MCP.
-- This is the historical-baseline layer — pre-cutover data from QBO.
-- The BCC's recipe-driven Supabase data is the forward layer (post-cutover).
-- BCC Financials tab can render both side-by-side.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.qbo_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             uuid NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  report_type           text NOT NULL CHECK (report_type IN ('balance_sheet','profit_loss','cash_flow')),
  period_start          date,                          -- NULL for BS, set for P&L / CF
  period_end            date NOT NULL,                 -- as-of date for BS, period close for P&L/CF
  accounting_method     text NOT NULL DEFAULT 'accrual',
  -- Balance Sheet fields
  total_assets          numeric(14,2),
  current_assets        numeric(14,2),
  total_liabilities     numeric(14,2),
  current_liabilities   numeric(14,2),
  total_equity          numeric(14,2),
  working_capital       numeric(14,2),
  -- P&L fields
  total_income          numeric(14,2),
  cost_of_goods_sold    numeric(14,2),
  gross_profit          numeric(14,2),
  total_expenses        numeric(14,2),
  net_operating_income  numeric(14,2),
  net_income            numeric(14,2),
  -- Cash Flow fields
  net_cash_operating    numeric(14,2),
  net_cash_investing    numeric(14,2),
  net_cash_financing    numeric(14,2),
  net_cash_change       numeric(14,2),
  cash_beginning        numeric(14,2),
  cash_ending           numeric(14,2),
  -- Provenance
  source                text DEFAULT 'qbo_mcp',
  raw_response          jsonb,                         -- audit trail
  notes                 text,
  created_at            timestamptz DEFAULT NOW(),
  updated_at            timestamptz DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_qbo_snapshot
  ON public.qbo_snapshots (
    agency_id, report_type, period_end,
    COALESCE(period_start, '1900-01-01'::date),
    accounting_method
  );

CREATE INDEX IF NOT EXISTS idx_qbo_snapshots_recent
  ON public.qbo_snapshots (agency_id, report_type, period_end DESC);

-- Seed: two Balance Sheet snapshots pulled tonight via QBO MCP
INSERT INTO public.qbo_snapshots (
  agency_id, report_type, period_end, accounting_method,
  total_assets, total_liabilities, total_equity, working_capital,
  source, notes
) VALUES (
  (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1), 'balance_sheet', '2025-12-31', 'accrual',
  132175.62, 32272.59, 99903.03, 28881.63,
  'qbo_mcp', 'Pulled via Intuit MCP qbo_accounting_get_balance_sheet on 2026-06-16'
), (
  (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1), 'balance_sheet', '2026-05-31', 'accrual',
  123677.95, 27829.58, 95848.37, 24566.05,
  'qbo_mcp', 'Pulled via Intuit MCP qbo_accounting_get_balance_sheet on 2026-06-16'
)
ON CONFLICT DO NOTHING;