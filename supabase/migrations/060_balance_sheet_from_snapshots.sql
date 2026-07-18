-- =========================================================================
-- Migration: 020_balance_sheet_from_snapshots
-- Supabase version: 20260617025027
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- ============================================================
-- Migration 020: v_balance_sheet from qbo_snapshots
-- ============================================================
-- The previous (migration 019) v_balance_sheet UNION'd BCC-native
-- journal_lines with a SUM of qbo_journal_lines. That math only
-- works when the ledger contains the full history including
-- opening balances and equity transfers. qbo_journal_lines does
-- NOT — it only contains cash-basis lines that hit the GL during
-- Jan 2025 onward. Summing it gave partial activity, not true
-- balances (e.g. Total Assets showed -$4,298.89 instead of the
-- correct $123,677.95 at 5/31/26).
--
-- qbo_snapshots holds period-level totals authored by QBO itself
-- (one row per accounting_method + period_end). 17 monthly BS
-- reports already loaded; numbers match the Quickbooks UI exactly.
--
-- Neither Dashboard.jsx nor Financials.jsx currently reads
-- v_balance_sheet, so changing its shape is safe.
--
-- The new shape exposes period_end + cash totals. To show
-- "current" BS:  ORDER BY period_end DESC LIMIT 1.
-- ============================================================

DROP VIEW IF EXISTS public.v_balance_sheet;

CREATE VIEW public.v_balance_sheet AS
SELECT
  agency_id,
  period_start,
  period_end,
  accounting_method,
  total_assets,
  current_assets,
  total_liabilities,
  current_liabilities,
  total_equity,
  working_capital,
  'qbo'::text AS source_layer,
  updated_at
FROM public.qbo_snapshots
WHERE report_type = 'balance_sheet';