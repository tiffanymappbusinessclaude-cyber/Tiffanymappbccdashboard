-- bcc-deepdive/P3 (partial) — 2026-07-24T04:38Z
-- Finding F4 (subset): the 3 financial views restored 2026-07-23 were created
-- without explicit security_invoker=on, defaulting to DEFINER behavior. This
-- enforces the creator's RLS, not the caller's — a data-isolation risk once
-- staff auth is in production use. Flip to invoker while only Tiffany is
-- authenticated so no user-facing regression can happen.
-- Underlying tables (journal_entries, journal_lines, cpa_balance_sheet,
-- chart_of_accounts, comp_recap) all have authenticated SELECT policies
-- per 2026-07-23T00:55Z RLS mirror pass.
--
-- 16 Premium overlay views (v_time_tracking_*, v_sales_activity_*, v_handbook_*,
-- v_benefit_*, v_expiring_licenses, v_upcoming_milestones) are DEFERRED —
-- each needs per-view authenticated RLS verification against its underlying
-- Premium tables. Filed for a dedicated follow-up.
--
-- Rollback: `ALTER VIEW <name> SET (security_invoker = off);` per view.

ALTER VIEW public.v_income_statement       SET (security_invoker = on);
ALTER VIEW public.v_balance_sheet          SET (security_invoker = on);
ALTER VIEW public.v_unified_general_ledger SET (security_invoker = on);
