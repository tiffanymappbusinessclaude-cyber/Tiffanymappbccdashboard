-- =========================================================================
-- bcc-debug/audit-2026-07-24T03Z — Producer Underperformance Watcher fix
-- Task 0b6883eb
-- Supersedes v10_055 rewire for the dedup guard.
-- Rollback: re-apply prior body from pg_get_functiondef captured in
--           persistent_memory session_wrap 1052b2d4.
-- (File name mentions monthly_close_monitor for legacy reasons — actual
--  monthly_close_monitor fix is in the sibling migration 20260724025634.)
-- =========================================================================

CREATE OR REPLACE FUNCTION public.producer_underperformance_watcher(p_agency_id uuid, p_recipe_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_today          DATE := CURRENT_DATE;
  v_day_of_month   INT  := EXTRACT(DAY FROM CURRENT_DATE)::INT;
  v_curr_year      INT  := EXTRACT(YEAR FROM CURRENT_DATE)::INT;
  v_year_start     DATE := MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::INT, 1, 1);
  v_year_end       DATE := MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::INT, 12, 31);
  v_alert_count    INT  := 0;
  v_updated_count  INT  := 0;
  v_producer       RECORD;
  v_goal           RECORD;
  v_tenure_start   DATE;
  v_tenure_days    INT;
  v_tenure_total   INT;
  v_pace_factor    NUMERIC;
  v_expected       NUMERIC;
  v_pace_ratio     NUMERIC;
  v_mod_ref        TEXT;
  v_flagged_goals  JSONB;
  v_new_title      TEXT;
  v_new_message    TEXT;
  v_existing_id    UUID;
BEGIN
  IF v_day_of_month < 5 THEN
    RETURN jsonb_build_object('records_processed', 0, 'output_summary', 'Skipped: too early in month');
  END IF;

  FOR v_producer IN
    SELECT
      id           AS staff_id,
      first_name   || ' ' || last_name AS name,
      first_name,
      last_name,
      start_date
    FROM public.staff
    WHERE agency_id = p_agency_id
      AND COALESCE(is_active, true) = true
      AND (role ILIKE '%LSP%' OR role ILIKE '%Producer%' OR role ILIKE '%Financial Services%')
  LOOP
    v_tenure_start := GREATEST(COALESCE(v_producer.start_date, v_year_start), v_year_start);
    IF v_tenure_start > v_today THEN CONTINUE; END IF;

    v_tenure_days  := (v_today - v_tenure_start + 1);
    v_tenure_total := (v_year_end - v_tenure_start + 1);
    v_pace_factor  := v_tenure_days::numeric / NULLIF(v_tenure_total, 0)::numeric;

    v_flagged_goals := '[]'::jsonb;

    FOR v_goal IN
      SELECT title, current_value, target_value, unit
      FROM public.goals
      WHERE agency_id = p_agency_id
        AND category = 'production'
        AND target_value > 0
        AND title ILIKE '%' || v_producer.first_name || '%' || v_producer.last_name || '%'
    LOOP
      v_expected := v_goal.target_value * v_pace_factor;
      IF v_expected > 0 THEN
        v_pace_ratio := v_goal.current_value / v_expected;
        IF v_pace_ratio < 0.70 THEN
          v_flagged_goals := v_flagged_goals || jsonb_build_object(
            'goal',     v_goal.title,
            'target',   v_goal.target_value,
            'current',  v_goal.current_value,
            'expected', ROUND(v_expected, 0),
            'pace_pct', ROUND(v_pace_ratio * 100, 0),
            'unit',     v_goal.unit
          );
        END IF;
      END IF;
    END LOOP;

    IF jsonb_array_length(v_flagged_goals) > 0 THEN
      v_mod_ref := 'producer_underperformance_watcher:' || v_producer.staff_id::text;
      v_new_title := v_producer.name || ': ' || jsonb_array_length(v_flagged_goals) || ' production goal(s) below 70% pace';
      v_new_message := 'Through day ' || v_day_of_month || ' at ' || ROUND(v_pace_factor*100, 0) ||
        '% tenure-pace: ' || v_flagged_goals::text ||
        '. Tenure since ' || v_tenure_start || '. Investigate in HR & People → Performance.' ||
        E'\n[Last refreshed by watcher: ' || v_today || ']';

      -- FIX bcc-debug/audit-2026-07-24T03Z: dedup on module_reference only (any unresolved).
      -- Prior guard filtered on created_at::date = v_today which produced daily duplicates.
      SELECT id INTO v_existing_id
      FROM public.alerts
      WHERE agency_id = p_agency_id
        AND module_reference = v_mod_ref
        AND is_resolved = false
      ORDER BY created_at DESC
      LIMIT 1;

      IF v_existing_id IS NULL THEN
        INSERT INTO public.alerts (
          agency_id, alert_type, severity, title, message, module_reference, is_read, is_resolved, created_at
        )
        VALUES (
          p_agency_id, 'producer_underperformance', 'warning',
          v_new_title, v_new_message, v_mod_ref, false, false, NOW()
        );
        v_alert_count := v_alert_count + 1;
      ELSE
        UPDATE public.alerts
        SET title = v_new_title,
            message = v_new_message
        WHERE id = v_existing_id;
        v_updated_count := v_updated_count + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_alert_count + v_updated_count,
    'output_summary', v_alert_count || ' new producer underperformance alerts, ' ||
                       v_updated_count || ' existing refreshed'
  );
END;
$function$;
