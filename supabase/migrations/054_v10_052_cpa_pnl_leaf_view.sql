-- v10_052_cpa_pnl_leaf_view
-- Applied to DB 2026-07-10 via Supabase MCP apply_migration.
-- Canonical leaf-only view over cpa_pnl_monthly.
-- Anomaly context: raw SUM(amount) WHERE section='Income' double-counts by ~2x because
-- QuickBooks-exported subtotal rows (is_subtotal=true, e.g. "Total for Income",
-- "Total for Commission Income") are stored alongside leaf accounts. Consumers must
-- either filter is_subtotal=false or use this view. Also normalizes period_month=13 as
-- the CPA-provided FY summary row (period 1-12 are the monthly breakdown).

CREATE OR REPLACE VIEW public.vw_cpa_pnl_leaf
WITH (security_invoker = true) AS
SELECT
  agency_id,
  period_year,
  period_month,
  section,
  parent_account,
  account_name,
  amount,
  basis,
  source_document_id,
  CASE WHEN period_month = 13 THEN 'fy_summary' ELSE 'monthly' END AS row_kind
FROM public.cpa_pnl_monthly
WHERE is_subtotal = false;

COMMENT ON VIEW public.vw_cpa_pnl_leaf IS
  'Leaf-only projection of cpa_pnl_monthly. Excludes QuickBooks subtotal rows (is_subtotal=true) '
  'to prevent double-counting when summing across accounts. period_month=13 rows are CPA-provided '
  'FY summary lines (row_kind=fy_summary); monthly detail lives in period_month 1-12 '
  '(row_kind=monthly). Use this view for any SUM(amount) across sections/accounts. '
  'Existing consumers current_system_overview() and daily_briefing_composer() already filter '
  'is_subtotal correctly; this view standardizes the pattern for all future consumers. '
  'Migrated 2026-07-10 as close-out for §5 audit anomaly (cpa_pnl_monthly Income double-count).';

GRANT SELECT ON public.vw_cpa_pnl_leaf TO anon, authenticated, service_role;
