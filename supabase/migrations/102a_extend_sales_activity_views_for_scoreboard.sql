-- =============================================================================
-- 102a_extend_sales_activity_views_for_scoreboard.sql
-- -----------------------------------------------------------------------------
-- Overlay: bcc-premium-overlay v1.1.2 (added 2026-07-17 Session 4d)
--
-- Purpose: Extend v_sales_activity_weekly_by_producer and
-- v_sales_activity_monthly_by_producer with the aggregation columns that
-- Scoreboard.jsx expects. Prior to this migration, Scoreboard read columns
-- (activity_total, quote_issued_count, app_submitted_count, cross_sell_count,
-- life_app_count) that did not exist in the views — all lookups silently
-- coerced to 0, so team totals showed 0 and the leaderboard rendered empty.
--
-- Non-breaking: SalesActivity.jsx and TimeTracking.jsx both consume these
-- views via select("*") and read only the fields they care about. Adding
-- columns is a pure extension.
--
-- Applied to demo Supabase 2026-07-17 with successful population of:
--   Weekly leaderboard rows for this-week producers
--   Monthly team totals (Quotes / Applications / Bound / Cross-sells tiles)
--
-- If you are installing a fresh client, this runs right after 102 which
-- creates the base views and augments them with the Scoreboard-facing columns.
-- =============================================================================

-- Weekly view: agency/producer/week/LOB granularity + Scoreboard aggregations
CREATE OR REPLACE VIEW public.v_sales_activity_weekly_by_producer AS
SELECT
  agency_id,
  producer_id,
  (date_trunc('week', activity_date::timestamp with time zone))::date AS week_starting,
  line_of_business,
  count(*)::integer AS activity_count,
  count(*) FILTER (WHERE outcome = 'bound')::integer AS bound_count,
  count(*) FILTER (WHERE outcome = 'pending')::integer AS pending_count,
  -- Scoreboard-facing aggregation columns (added 2026-07-17)
  count(*)::integer AS activity_total,
  count(*) FILTER (WHERE activity_type = 'quote')::integer AS quote_issued_count,
  count(*) FILTER (WHERE activity_type = 'application')::integer AS app_submitted_count,
  count(*) FILTER (WHERE activity_type = 'cross_sell')::integer AS cross_sell_count,
  count(*) FILTER (WHERE activity_type = 'application' AND line_of_business = 'life')::integer AS life_app_count,
  count(*) FILTER (WHERE activity_type = 'fs_referral')::integer AS fs_referral_count
FROM public.sales_activity sa
WHERE activity_date >= CURRENT_DATE - INTERVAL '84 days'
GROUP BY agency_id, producer_id, (date_trunc('week', activity_date::timestamp with time zone)), line_of_business;

-- Monthly view: agency/producer/month/type/LOB/outcome granularity
CREATE OR REPLACE VIEW public.v_sales_activity_monthly_by_producer AS
SELECT
  agency_id,
  producer_id,
  (date_trunc('month', activity_date::timestamp with time zone))::date AS month_starting,
  activity_type,
  line_of_business,
  outcome,
  count(*)::integer AS activity_count,
  -- Scoreboard-facing aggregation columns (added 2026-07-17)
  count(*)::integer AS activity_total,
  count(*) FILTER (WHERE activity_type = 'quote')::integer AS quote_issued_count,
  count(*) FILTER (WHERE activity_type = 'application')::integer AS app_submitted_count,
  count(*) FILTER (WHERE outcome = 'bound')::integer AS bound_count,
  count(*) FILTER (WHERE activity_type = 'cross_sell')::integer AS cross_sell_count,
  count(*) FILTER (WHERE activity_type = 'application' AND line_of_business = 'life')::integer AS life_app_count,
  count(*) FILTER (WHERE activity_type = 'fs_referral')::integer AS fs_referral_count
FROM public.sales_activity sa
WHERE activity_date >= CURRENT_DATE - INTERVAL '1 year'
GROUP BY agency_id, producer_id, (date_trunc('month', activity_date::timestamp with time zone)), activity_type, line_of_business, outcome;

-- Migration ledger (if your install uses one)
INSERT INTO public.schema_migrations (migration_name, applied_at)
VALUES ('102a_extend_sales_activity_views_for_scoreboard', now())
ON CONFLICT DO NOTHING;
