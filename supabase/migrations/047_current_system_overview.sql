-- 047_current_system_overview.sql (IA master variant)
-- Session-start "where do things stand" snapshot RPC, used by mandatory
-- query #2 of the operator handbook. Returns a single jsonb blob:
--   install_progress phases, open-alert severity counts, active pg_cron jobs
--   (guarded), last-10 automation_runs, coarse row counts on the heavy
--   tables, POS pipeline health (POS-vendor-agnostic + guarded), and
--   client + system_status context singletons.
--
-- IA-MASTER ADAPTATION FROM JAYS SOURCE:
--   * Surfaces IA-canonical tables: entities, monthly_pl, documents,
--     gl_entries_archive, tax_filings, agent_memory, system_map.
--   * Adds context block from client_context + system_status singletons.
--   * Replaces the Heartland-specific POS block with a POS-vendor-agnostic
--     guarded block. Empty until a POS adapter sprint commit creates
--     daily_location_sales / inventory_snapshots.
--   * cron.job query is guarded with to_regclass since pg_cron is enabled
--     in a follow-up commit, not in this one.
--
-- Note: automation_runs uses completed_at, NOT finished_at. Earlier drafts
-- of this RPC in Jays repo had finished_at and silently returned NULL.

CREATE OR REPLACE FUNCTION public.current_system_overview()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phases   jsonb;
  v_alerts   jsonb;
  v_crons    jsonb;
  v_runs     jsonb;
  v_counts   jsonb;
  v_pos      jsonb;
  v_context  jsonb;
BEGIN
  -- 1) Install progress ---------------------------------------------------
  SELECT jsonb_agg(jsonb_build_object(
           'phase_number',     phase_number,
           'phase_name',       phase_name,
           'status',           status,
           'blocking_reason',  blocking_reason,
           'completed_at',     completed_at
         ) ORDER BY phase_number)
    INTO v_phases
    FROM public.install_progress;

  -- 2) Open-alert counts grouped by severity ------------------------------
  SELECT jsonb_object_agg(severity::text, c)
    INTO v_alerts
    FROM (
      SELECT severity, COUNT(*)::int AS c
        FROM public.system_alerts
       WHERE resolved_at IS NULL
       GROUP BY severity
    ) sev;

  -- 3) Active pg_cron jobs (guarded -- pg_cron lands in a follow-up commit)
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE 'SELECT jsonb_agg(jsonb_build_object('
         || ' ''jobid'',    jobid,'
         || ' ''jobname'',  jobname,'
         || ' ''schedule'', schedule,'
         || ' ''active'',   active'
         || ' ) ORDER BY jobid) FROM cron.job WHERE active = true'
    INTO v_crons;
  END IF;

  -- 4) Last 10 automation_runs (completed_at, NOT finished_at) ------------
  SELECT jsonb_agg(jsonb_build_object(
           'recipe_id',    recipe_id,
           'recipe_key',   recipe_key,
           'status',       status,
           'started_at',   started_at,
           'completed_at', completed_at,
           'duration_ms',  duration_ms
         ) ORDER BY started_at DESC)
    INTO v_runs
    FROM (
      SELECT recipe_id, recipe_key, status, started_at, completed_at, duration_ms
        FROM public.automation_runs
       ORDER BY started_at DESC
       LIMIT 10
    ) recent;

  -- 5) Coarse row counts on the heavy tables ------------------------------
  SELECT jsonb_build_object(
           'entities',       (SELECT COUNT(*) FROM public.entities),
           'monthly_pl',     (SELECT COUNT(*) FROM public.monthly_pl),
           'documents',      (SELECT COUNT(*) FROM public.documents),
           'gl_entries',     (SELECT COUNT(*) FROM public.gl_entries_archive),
           'tax_filings',    (SELECT COUNT(*) FROM public.tax_filings),
           'agent_memory',   (SELECT COUNT(*) FROM public.agent_memory),
           'system_map',     (SELECT COUNT(*) FROM public.system_map)
         )
    INTO v_counts;

  -- 6) POS pipeline health (POS-vendor-agnostic, guarded) -----------------
  -- Empty until a POS adapter sprint commit creates the sales/inventory
  -- tables. The adapter pattern is vendor-agnostic at the schema layer.
  IF to_regclass('public.daily_location_sales') IS NOT NULL
     AND to_regclass('public.inventory_snapshots') IS NOT NULL THEN
    EXECUTE 'SELECT jsonb_build_object('
         || ' ''latest_inventory_snapshot'','
         || '   (SELECT MAX(snapshot_date) FROM public.inventory_snapshots),'
         || ' ''latest_sales_date'','
         || '   (SELECT MAX(sales_date) FROM public.daily_location_sales)'
         || ' )'
    INTO v_pos;
  END IF;

  -- 7) Client + system status singletons ----------------------------------
  SELECT jsonb_build_object(
           'client_context', (
             SELECT jsonb_build_object(
                      'display_name',  display_name,
                      'tier',          tier,
                      'variant',       variant,
                      'founder_client', founder_client
                    )
               FROM public.client_context LIMIT 1
           ),
           'system_status', (
             SELECT jsonb_build_object(
                      'bcc_version',           bcc_version,
                      'overall_health',        overall_health,
                      'install_started_at',    install_started_at,
                      'install_completed_at',  install_completed_at,
                      'last_email_ingest_at',  last_email_ingest_at,
                      'last_parser_run_at',    last_parser_run_at,
                      'last_automation_run_at', last_automation_run_at,
                      'automation_failed_24h', automation_failed_24h
                    )
               FROM public.system_status WHERE id = 1
           )
         )
    INTO v_context;

  RETURN jsonb_build_object(
    'generated_at',           now(),
    'phases',                 COALESCE(v_phases,   '[]'::jsonb),
    'open_alerts',            COALESCE(v_alerts,   '{}'::jsonb),
    'active_crons',           COALESCE(v_crons,    '[]'::jsonb),
    'recent_automation_runs', COALESCE(v_runs,     '[]'::jsonb),
    'table_counts',           COALESCE(v_counts,   '{}'::jsonb),
    'pos',                    COALESCE(v_pos,      '{}'::jsonb),
    'context',                COALESCE(v_context,  '{}'::jsonb)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.current_system_overview() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.current_system_overview() TO authenticated, service_role;
