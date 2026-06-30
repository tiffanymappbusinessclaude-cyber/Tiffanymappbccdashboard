-- Migration 023: silent-failure detector for automation recipes.
--
-- The Goals Auto-Sync bug (silently invisible for 4 days because of
-- trigger_type='scheduled') would have been caught within 24 hours by this
-- detector. The CHECK constraint in migration 022 prevents THAT specific
-- bug class from recurring; this detector catches the broader class of
-- "recipe is active but the dispatcher hasn't run it" — which includes
-- handler errors, dispatcher mismatches, cron parsing issues, or recipes
-- whose source data prerequisites are missing.
--
-- Heuristic: parse the cron_expression for an approximate fire cadence,
-- then compare the last successful run in automation_run_log to a
-- 2-3x staleness threshold. Alert on miss; auto-resolve on recovery.

CREATE OR REPLACE FUNCTION public.recipe_silent_failure_detector(
  p_agency_id uuid,
  p_recipe_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  r              RECORD;
  v_threshold    INTERVAL;
  v_minute_step  INT;
  v_last_success TIMESTAMPTZ;
  v_last_any     TIMESTAMPTZ;
  v_checked      INT := 0;
  v_alerts_new   INT := 0;
  v_alerts_clear INT := 0;
  v_skipped_new  INT := 0;
  v_stale        jsonb := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT id, recipe_name, cron_expression, trigger_type,
           last_run_at, last_run_status, created_at
    FROM automation_recipes
    WHERE agency_id = p_agency_id
      AND is_active = TRUE
      AND cron_expression IS NOT NULL
      AND length(trim(cron_expression)) > 0
  LOOP
    v_checked := v_checked + 1;

    -- Approximate fire cadence from cron_expression
    IF r.cron_expression ~ '^\*/(\d+)\s' THEN
      v_minute_step := substring(r.cron_expression FROM '^\*/(\d+)\s')::int;
      v_threshold := (GREATEST(v_minute_step * 3, 15) || ' minutes')::interval;
    ELSIF r.cron_expression ~ '^\d+,\d+' THEN
      v_threshold := INTERVAL '90 minutes';
    ELSIF r.cron_expression ~ '^\d+\s+\d+\s+\*\s+\*\s+\d+$' THEN
      v_threshold := INTERVAL '8 days';
    ELSIF r.cron_expression ~ '^\d+\s+\d+\s+\d+\s+\*\s+\*$' THEN
      v_threshold := INTERVAL '32 days';
    ELSIF r.cron_expression ~ '^\d+\s+\d+\s+\*\s+\*\s+\*$' THEN
      v_threshold := INTERVAL '25 hours';
    ELSE
      v_threshold := INTERVAL '25 hours';
    END IF;

    IF r.created_at > NOW() - v_threshold THEN
      v_skipped_new := v_skipped_new + 1;
      CONTINUE;
    END IF;

    SELECT MAX(run_at) INTO v_last_success
    FROM automation_run_log
    WHERE recipe_id = r.id AND status = 'success';

    SELECT MAX(run_at) INTO v_last_any
    FROM automation_run_log WHERE recipe_id = r.id;

    IF v_last_success IS NULL OR v_last_success < NOW() - v_threshold THEN
      v_alerts_new := v_alerts_new + 1;
      v_stale := v_stale || jsonb_build_object(
        'recipe_id',       r.id,
        'recipe_name',     r.recipe_name,
        'trigger_type',    r.trigger_type,
        'cron_expression', r.cron_expression,
        'last_success',    v_last_success,
        'last_any_run',    v_last_any,
        'threshold',       v_threshold::text
      );

      INSERT INTO alerts (
        agency_id, alert_type, severity, title, message,
        module_reference, related_id, is_resolved
      )
      SELECT
        p_agency_id,
        'recipe_silent_failure',
        'high',
        'Automation stale: ' || r.recipe_name,
        format(
          'Recipe %s (trigger_type=%s, cron=%s) has no successful run since %s. '
          'Last run of any status: %s. Expected within %s. '
          'Likely causes: dispatcher mismatch, handler error, or missing prerequisite. '
          'Check automation_run_log for recipe_id=%s.',
          r.recipe_name, r.trigger_type, r.cron_expression,
          COALESCE(v_last_success::text, 'EVER'),
          COALESCE(v_last_any::text, 'EVER'),
          v_threshold, r.id
        ),
        'Automations', r.id, FALSE
      WHERE NOT EXISTS (
        SELECT 1 FROM alerts a
        WHERE a.agency_id = p_agency_id
          AND a.alert_type = 'recipe_silent_failure'
          AND a.related_id = r.id
          AND a.is_resolved = FALSE
      );
    ELSE
      UPDATE alerts
      SET is_resolved = TRUE, resolved_at = NOW()
      WHERE agency_id = p_agency_id
        AND alert_type = 'recipe_silent_failure'
        AND related_id = r.id
        AND is_resolved = FALSE;
      IF FOUND THEN v_alerts_clear := v_alerts_clear + 1; END IF;
    END IF;
  END LOOP;

  INSERT INTO automation_run_log (
    agency_id, recipe_id, status, records_processed, output_summary, run_at
  ) VALUES (
    p_agency_id, p_recipe_id, 'success', v_checked,
    format('checked=%s stale=%s cleared=%s skipped_new=%s',
           v_checked, v_alerts_new, v_alerts_clear, v_skipped_new),
    NOW()
  );

  UPDATE automation_recipes
  SET last_run_at = NOW(), last_run_status = 'success'
  WHERE id = p_recipe_id;

  RETURN jsonb_build_object(
    'checked', v_checked,
    'alerts_created', v_alerts_new,
    'alerts_resolved', v_alerts_clear,
    'skipped_too_new', v_skipped_new,
    'stale_recipes', v_stale
  );
END;
$$;

COMMENT ON FUNCTION public.recipe_silent_failure_detector(uuid, uuid) IS
  'Catches the bug class that hid Goals Auto-Sync for 4 days. Inspects every '
  'active recipe, compares last successful run to a cron-derived threshold, '
  'and writes/resolves alerts in the alerts table. Companion to migration 022 '
  'CHECK constraint; both shipped 2026-06-29.';

INSERT INTO automation_recipes (
  agency_id, recipe_name, recipe_description, trigger_type, cron_expression,
  composio_action, internal_handler, is_active
) VALUES (
  'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065',
  'Recipe Silent Failure Detector',
  'Daily sweep of all active recipes. Compares last_success vs a cron-derived '
  'staleness threshold; writes an alert (alert_type=recipe_silent_failure, '
  'severity=high) for any recipe past 2-3x its expected interval, and auto-'
  'resolves on recovery. Shipped 2026-06-29 in response to the Goals '
  'Auto-Sync silent-invisible bug.',
  'cron', '10 13 * * *', 'INTERNAL', 'recipe_silent_failure_detector', TRUE
);
