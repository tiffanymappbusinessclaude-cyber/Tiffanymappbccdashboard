-- 046_system_map_staleness_check.sql
-- Weekly drift-protection for the system_map wiki.
-- Scans for pages older than 45 days (or never verified) and files ONE
-- system_alerts row listing them. Idle when nothing is stale (no noise).
--
-- Scheduled via pg_cron job 6 (`system-map-staleness-weekly` @ `0 14 * * 1` UTC)
-- which calls this RPC directly. The cron schedule itself is live-state-only
-- per repo convention (see decision-repo-write-approval system_map page).

CREATE OR REPLACE FUNCTION public.check_system_map_staleness(
  p_threshold_days integer DEFAULT 45
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stale_pages jsonb;
  v_stale_count integer;
  v_threshold   interval := (p_threshold_days || ' days')::interval;
  v_alert_id    bigint;
BEGIN
  SELECT
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'slug',             slug,
        'title',            title,
        'category',         category,
        'last_verified_at', last_verified_at,
        'days_old',         CASE
                              WHEN last_verified_at IS NULL THEN NULL
                              ELSE EXTRACT(day FROM (now() - last_verified_at))::integer
                            END,
        'last_verified_by', last_verified_by
      )
      ORDER BY last_verified_at ASC NULLS FIRST
    ), '[]'::jsonb),
    COUNT(*)
  INTO v_stale_pages, v_stale_count
  FROM public.system_map
  WHERE last_verified_at IS NULL
     OR last_verified_at < now() - v_threshold;

  IF v_stale_count = 0 THEN
    RETURN jsonb_build_object(
      'ok',             true,
      'stale_count',    0,
      'alert_filed',    false,
      'threshold_days', p_threshold_days
    );
  END IF;

  -- Don't pile duplicates on the queue.
  IF EXISTS (
    SELECT 1 FROM public.system_alerts
    WHERE category = 'system_map_drift' AND resolved_at IS NULL
  ) THEN
    RETURN jsonb_build_object(
      'ok',             true,
      'stale_count',    v_stale_count,
      'alert_filed',    false,
      'reason',         'unresolved staleness alert already in queue',
      'threshold_days', p_threshold_days
    );
  END IF;

  INSERT INTO public.system_alerts (severity, category, message, context)
  VALUES (
    'info',
    'system_map_drift',
    format('%s system_map page%s have not been verified in >%s days. Review and re-verify (or update) each.',
           v_stale_count,
           CASE WHEN v_stale_count = 1 THEN '' ELSE 's' END,
           p_threshold_days),
    jsonb_build_object(
      'threshold_days', p_threshold_days,
      'stale_count',    v_stale_count,
      'stale_pages',    v_stale_pages,
      'scanned_at',     now()
    )
  )
  RETURNING id INTO v_alert_id;

  RETURN jsonb_build_object(
    'ok',             true,
    'stale_count',    v_stale_count,
    'alert_filed',    true,
    'alert_id',       v_alert_id,
    'threshold_days', p_threshold_days
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_system_map_staleness(integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.check_system_map_staleness(integer) TO authenticated, service_role;
