-- bcc-deepdive/P6 — 2026-07-24T04:35Z
-- Finding F9: 14 user-created public functions have mutable search_path
-- (6 _pto_* helpers, 7 touch_* trigger functions, 1 personnel_documents
-- visibility setter). All SECURITY INVOKER, so blast radius is limited,
-- but advisor flags for defense-in-depth. Adds pinned search_path to each.
-- Additive per-function; no logic change.
-- Rollback: `ALTER FUNCTION <name> RESET search_path;` per function.

DO $$
DECLARE
  v_fn RECORD;
  v_sql TEXT;
BEGIN
  FOR v_fn IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    LEFT JOIN pg_depend d ON d.objid=p.oid AND d.deptype='e'
    WHERE n.nspname='public'
      AND p.prokind='f'
      AND d.objid IS NULL
      AND (p.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'))
      AND p.proname IN (
        '_pto_carryover_from_prior_period','_pto_current_period_start',
        '_pto_days_per_year_at_tenure','_pto_set_updated_at',
        '_pto_validate_tenure_brackets','_pto_years_of_service',
        'set_personnel_documents_visibility_default',
        'touch_agency_announcements_updated_at','touch_personnel_documents_updated_at',
        'touch_personnel_files_updated_at','touch_personnel_form_templates_updated_at',
        'touch_sales_activity_updated_at','touch_scoreboard_goals_updated_at',
        'touch_time_tracking_updated_at'
      )
  LOOP
    v_sql := format('ALTER FUNCTION public.%I(%s) SET search_path = %L, %L',
                    v_fn.proname, v_fn.args, 'public', 'pg_catalog');
    EXECUTE v_sql;
  END LOOP;
END $$;
