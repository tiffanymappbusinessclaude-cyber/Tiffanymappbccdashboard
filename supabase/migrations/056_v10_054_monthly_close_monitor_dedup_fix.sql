-- v10_054_monthly_close_monitor_dedup_fix
-- Applied to DB 2026-07-10 via Supabase MCP apply_migration.
-- Fix the duplicate-alerts bug in monthly_close_monitor.
-- Prior behavior: NOT EXISTS clause included created_at::date = v_today, so the same
-- module_reference could stack a new alert every day the item stayed open. Confirmed
-- live: 5 close items generated 20 total open warnings between 2026-07-05 and 2026-07-10.
--
-- Fix: dedup on module_reference + is_resolved=false, drop the date filter. If an
-- unresolved alert already exists for that close item, do nothing today.
-- One-time cleanup of the 15 duplicate rows was also executed in the same session
-- (kept first-seen row per item, resolved newer duplicates with an audit note).

CREATE OR REPLACE FUNCTION public.monthly_close_monitor(p_agency_id uuid, p_recipe_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_today DATE := CURRENT_DATE;
  v_last_day DATE := (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::date;
  v_overdue_count INTEGER := 0;
  v_created_count INTEGER := 0;
  v_overdue RECORD;
  v_target_year INTEGER;
  v_target_month INTEGER;
BEGIN
  IF EXTRACT(DAY FROM v_today)::INT >= 5 THEN
    FOR v_overdue IN
      SELECT id, doc_label FROM public.monthly_close_checklist
      WHERE agency_id = p_agency_id AND period_year = EXTRACT(YEAR FROM v_today)::INT
        AND period_month = EXTRACT(MONTH FROM v_today)::INT
        AND received_at IS NULL AND expected_by IS NOT NULL AND expected_by < v_today
    LOOP
      INSERT INTO public.alerts (agency_id, alert_type, severity, title, message, module_reference, is_read, is_resolved, created_at)
      SELECT p_agency_id, 'overdue_close_item', 'warning',
        'Monthly close item overdue: ' || v_overdue.doc_label,
        'Item is past expected_by date. Review in Financials → Monthly Close.',
        'monthly_close_monitor:' || v_overdue.id::text, false, false, NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM public.alerts
        WHERE agency_id = p_agency_id
          AND module_reference = 'monthly_close_monitor:' || v_overdue.id::text
          AND is_resolved = false
      );
      GET DIAGNOSTICS v_overdue_count = ROW_COUNT;
    END LOOP;
  END IF;

  IF v_today >= v_last_day - INTERVAL '2 days' THEN
    IF EXTRACT(MONTH FROM v_today)::INT = 12 THEN
      v_target_year := EXTRACT(YEAR FROM v_today)::INT + 1;
      v_target_month := 1;
    ELSE
      v_target_year := EXTRACT(YEAR FROM v_today)::INT;
      v_target_month := EXTRACT(MONTH FROM v_today)::INT + 1;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.monthly_close_checklist WHERE agency_id = p_agency_id
        AND period_year = v_target_year AND period_month = v_target_month) THEN
      INSERT INTO public.monthly_close_checklist (agency_id, period_year, period_month, doc_category, doc_label, expected_by, status, is_closed, created_at)
      SELECT p_agency_id, v_target_year, v_target_month, doc_category, doc_label,
        MAKE_DATE(v_target_year, v_target_month, LEAST(EXTRACT(DAY FROM expected_by)::INT,
          EXTRACT(DAY FROM (MAKE_DATE(v_target_year, v_target_month, 1) + INTERVAL '1 month - 1 day'))::INT)),
        'pending', false, NOW()
      FROM (SELECT DISTINCT ON (doc_category, doc_label) doc_category, doc_label, expected_by
        FROM public.monthly_close_checklist WHERE agency_id = p_agency_id
          AND period_year = EXTRACT(YEAR FROM v_today)::INT AND period_month = EXTRACT(MONTH FROM v_today)::INT
          AND expected_by IS NOT NULL ORDER BY doc_category, doc_label, created_at DESC) src;
      GET DIAGNOSTICS v_created_count = ROW_COUNT;
    END IF;
  END IF;
  RETURN jsonb_build_object('records_processed', v_overdue_count + v_created_count,
    'output_summary', v_overdue_count || ' overdue alerts, ' || v_created_count || ' next-month checklist items created');
END; $function$;
