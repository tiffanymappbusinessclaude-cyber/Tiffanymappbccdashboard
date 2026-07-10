-- v10_053_current_system_overview_pnl_fix
-- Applied to DB 2026-07-10 via Supabase MCP apply_migration.
-- Fix two bugs in current_system_overview() that produced misleading financial numbers:
--   BUG 1: cpa_pnl_ytd_2026 summed monthly (1-12) AND period_month=13 FY-summary row,
--          returning exactly 2x actual YTD income. Confirmed live: reported
--          $589,058.70 vs correct $294,529.35 for 2026 accrual Income.
--   BUG 2: cpa_pnl_last_period ordered by period_month DESC without excluding month=13,
--          so it always returned "YYYY-13" (a non-existent calendar month).
-- Both fixes route through the new vw_cpa_pnl_leaf view (row_kind='monthly' filter),
-- which normalizes the leaf/subtotal/month-13 distinction in one place.
-- Also adds cpa_pnl_ytd_2026_expenses so operators can see income vs expenses at a glance.

CREATE OR REPLACE FUNCTION public.current_system_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agency record;
  v_out jsonb;
  v_auto_health jsonb;
  v_financials jsonb;
  v_activity jsonb;
  v_knowledge jsonb;
BEGIN
  SELECT id, name, owner_name, entity_type, state_farm_agent_code,
         primary_email, status, setup_date,
         smvc_rate_pc, blended_rate_other, lapse_rate_annual
  INTO v_agency
  FROM public.agency
  LIMIT 1;

  SELECT jsonb_build_object(
    'runs_7d', COUNT(*),
    'success_7d', COUNT(*) FILTER (WHERE status = 'success'),
    'failed_7d', COUNT(*) FILTER (WHERE status = 'failed'),
    'success_rate_pct',
      CASE WHEN COUNT(*) = 0 THEN NULL
           ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'success') / COUNT(*), 1)
      END,
    'last_run_at', MAX(run_at),
    'open_critical_alerts', (
      SELECT COUNT(*) FROM public.alerts
      WHERE is_resolved = false AND severity IN ('critical','high')
    ),
    'open_alerts_total', (
      SELECT COUNT(*) FROM public.alerts WHERE is_resolved = false
    )
  )
  INTO v_auto_health
  FROM public.automation_run_log
  WHERE run_at >= NOW() - INTERVAL '7 days';

  -- BUG-FIX 1: use vw_cpa_pnl_leaf and restrict to row_kind='monthly'
  -- BUG-FIX 2: same restriction excludes the phantom "month 13" from last_period
  SELECT jsonb_build_object(
    'cpa_pnl_ytd_2026', (
      SELECT COALESCE(SUM(amount), 0)
      FROM public.vw_cpa_pnl_leaf
      WHERE period_year = 2026 AND section = 'Income' AND row_kind = 'monthly'
    ),
    'cpa_pnl_ytd_2026_expenses', (
      SELECT COALESCE(SUM(amount), 0)
      FROM public.vw_cpa_pnl_leaf
      WHERE period_year = 2026 AND section = 'Expenses' AND row_kind = 'monthly'
    ),
    'cpa_pnl_last_period', (
      SELECT (period_year || '-' || LPAD(period_month::text, 2, '0'))
      FROM public.vw_cpa_pnl_leaf
      WHERE row_kind = 'monthly'
      ORDER BY period_year DESC, period_month DESC
      LIMIT 1
    ),
    'cpa_gl_rows', (SELECT COUNT(*) FROM public.cpa_general_ledger),
    'cpa_gl_latest_entry', (SELECT MAX(entry_date) FROM public.cpa_general_ledger),
    'bcc_journal_entries', (SELECT COUNT(*) FROM public.journal_entries),
    'bcc_last_journal_entry', (SELECT MAX(created_at) FROM public.journal_entries),
    'tax_filings', jsonb_build_object('status','not_tracked','note','No tax_filings table in BCC schema; CPA handles filings externally.')
  )
  INTO v_financials;

  SELECT jsonb_build_object(
    'last_document_processed_at', (SELECT MAX(processed_at) FROM public.documents WHERE processing_status = 'processed'),
    'documents_total', (SELECT COUNT(*) FROM public.documents),
    'documents_pending', (SELECT COUNT(*) FROM public.documents WHERE processing_status IN ('pending','processing')),
    'last_briefing_sent', (
      SELECT MAX(l.run_at)
      FROM public.automation_run_log l
      JOIN public.automation_recipes r ON r.id = l.recipe_id
      WHERE r.recipe_name = 'Daily Briefing Email' AND l.status = 'success'
    )
  )
  INTO v_activity;

  SELECT jsonb_build_object(
    'persistent_memory_rows', (SELECT COUNT(*) FROM public.persistent_memory),
    'system_map_pages', (SELECT COUNT(*) FROM public.system_map),
    'system_map_last_verified_at', (SELECT MAX(last_verified_at) FROM public.system_map),
    'stale_map_pages_45d', (
      SELECT COUNT(*) FROM public.system_map
      WHERE COALESCE(last_verified_at, created_at) < NOW() - INTERVAL '45 days'
    )
  )
  INTO v_knowledge;

  v_out := jsonb_build_object(
    'generated_at', NOW(),
    'schema_version', 'bcc_v10_053_pnl_leaf_fix_2026_07_10',
    'agency', to_jsonb(v_agency),
    'automation_health', v_auto_health,
    'financials', v_financials,
    'recent_activity', v_activity,
    'knowledge_layer', v_knowledge
  );

  RETURN v_out;
END;
$function$;
