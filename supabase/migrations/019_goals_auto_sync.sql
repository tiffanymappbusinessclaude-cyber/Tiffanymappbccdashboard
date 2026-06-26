-- =====================================================================
-- Migration 019: Goals Auto-Sync
-- =====================================================================
-- Adds public.goals_auto_sync(uuid, uuid) — weekly handler that updates
-- goals.current_value from producer_activity_daily and comp_recap for
-- quarterly goals. Pattern matches existing INTERNAL recipes (signature
-- p_agency_id, p_recipe_id → jsonb { records_processed, output_summary }).
--
-- Period derivation: assumes target_date = quarter-end. Period spans
-- date_trunc('quarter', target_date) → target_date inclusive.
--
-- Title parsing (deterministic, no LLM):
--   "<Period> — Team <Metric>"           → all 8 producers
--   "<Period> — Producer Team <Metric>"  → 6 producers (excl. Patti, Tim)
--   "<Period> — <Producer> <Metric>"     → that producer only
--
-- Unit → source column:
--   fs_pivots         → producer_activity_daily.fs_pivots
--   renewal_touches   → producer_activity_daily.renewal_touches
--   usd + "AMUTL...Renewal..."  → comp_recap auto/renewal commissions
--
-- Goals where no rule matches are skipped (current_value untouched).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.goals_auto_sync(p_agency_id uuid, p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_goal RECORD;
  v_value NUMERIC;
  v_count INT := 0;
  v_skipped INT := 0;
  v_period_start DATE;
  v_period_end DATE;
  v_producer TEXT;
  v_matched_producer TEXT;
  v_producers TEXT[] := ARRAY[
    'Michelle Jackson', 'Devin Walker', 'Tim Mapp', 'Patti Nottingham',
    'Catherine Harrison', 'Jenna Silva', 'Eva Serrano Tellado', 'Carson Rich'
  ];
  v_producer_team TEXT[] := ARRAY[
    'Michelle Jackson', 'Devin Walker', 'Catherine Harrison',
    'Jenna Silva', 'Eva Serrano Tellado', 'Carson Rich'
  ];
BEGIN
  FOR v_goal IN
    SELECT id, title, unit, target_date, current_value
    FROM public.goals
    WHERE agency_id = p_agency_id
      AND status = 'active'
      AND target_date IS NOT NULL
      AND target_date >= CURRENT_DATE - INTERVAL '90 days'
  LOOP
    v_value := NULL;
    v_matched_producer := NULL;

    -- Period = quarter containing target_date
    v_period_start := date_trunc('quarter', v_goal.target_date)::date;
    v_period_end := v_goal.target_date;

    IF v_goal.unit IN ('fs_pivots', 'renewal_touches') THEN

      IF v_goal.title ILIKE '%Producer Team%' THEN
        IF v_goal.unit = 'fs_pivots' THEN
          SELECT COALESCE(SUM(fs_pivots), 0) INTO v_value
          FROM public.producer_activity_daily
          WHERE agency_id = p_agency_id
            AND activity_date BETWEEN v_period_start AND v_period_end
            AND producer_name = ANY(v_producer_team);
        ELSE
          SELECT COALESCE(SUM(renewal_touches), 0) INTO v_value
          FROM public.producer_activity_daily
          WHERE agency_id = p_agency_id
            AND activity_date BETWEEN v_period_start AND v_period_end
            AND producer_name = ANY(v_producer_team);
        END IF;

      ELSIF v_goal.title ILIKE '%Team%' THEN
        -- "Team" alone (not "Producer Team") = all 8 producers
        IF v_goal.unit = 'fs_pivots' THEN
          SELECT COALESCE(SUM(fs_pivots), 0) INTO v_value
          FROM public.producer_activity_daily
          WHERE agency_id = p_agency_id
            AND activity_date BETWEEN v_period_start AND v_period_end
            AND producer_name = ANY(v_producers);
        ELSE
          SELECT COALESCE(SUM(renewal_touches), 0) INTO v_value
          FROM public.producer_activity_daily
          WHERE agency_id = p_agency_id
            AND activity_date BETWEEN v_period_start AND v_period_end
            AND producer_name = ANY(v_producers);
        END IF;

      ELSE
        -- Per-producer: find matching name in title
        FOREACH v_producer IN ARRAY v_producers LOOP
          IF v_goal.title ILIKE '%' || v_producer || '%' THEN
            v_matched_producer := v_producer;
            EXIT;
          END IF;
        END LOOP;

        IF v_matched_producer IS NOT NULL THEN
          IF v_goal.unit = 'fs_pivots' THEN
            SELECT COALESCE(SUM(fs_pivots), 0) INTO v_value
            FROM public.producer_activity_daily
            WHERE agency_id = p_agency_id
              AND activity_date BETWEEN v_period_start AND v_period_end
              AND producer_name = v_matched_producer;
          ELSE
            SELECT COALESCE(SUM(renewal_touches), 0) INTO v_value
            FROM public.producer_activity_daily
            WHERE agency_id = p_agency_id
              AND activity_date BETWEEN v_period_start AND v_period_end
              AND producer_name = v_matched_producer;
          END IF;
        END IF;
      END IF;

    ELSIF v_goal.unit = 'usd'
      AND v_goal.title ILIKE '%AMUTL%'
      AND v_goal.title ILIKE '%Renewal%' THEN
      -- AMUTL renewal commission stabilization: sum auto/renewal comp earnings
      SELECT COALESCE(SUM(amount), 0) INTO v_value
      FROM public.comp_recap
      WHERE agency_id = p_agency_id
        AND comp_category = 'auto'
        AND comp_type = 'renewal'
        AND make_date(period_year, period_month,
                      CASE period_half WHEN 'first' THEN 15 ELSE 28 END)
            BETWEEN v_period_start AND v_period_end;
    END IF;

    IF v_value IS NOT NULL THEN
      UPDATE public.goals
      SET current_value = v_value, updated_at = NOW()
      WHERE id = v_goal.id;
      v_count := v_count + 1;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_count,
    'output_summary', format(
      'Synced %s goal(s) from producer_activity_daily + comp_recap; %s skipped (no matching rule)',
      v_count, v_skipped
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.goals_auto_sync(uuid, uuid) IS
  'Internal handler for "Goals Auto-Sync" automation_recipes row. Updates goals.current_value for active quarterly goals from producer_activity_daily (fs_pivots, renewal_touches) and comp_recap (AMUTL USD goals). Title-driven matching: per-producer, Producer Team (6 LSPs), or Team (all 8).';

-- Insert the recipe row that drives this handler
INSERT INTO public.automation_recipes (
  agency_id, recipe_name, recipe_description,
  trigger_type, cron_expression,
  composio_action, internal_handler, is_active
)
VALUES (
  'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065',
  'Goals Auto-Sync',
  'Weekly: refreshes goals.current_value from producer_activity_daily (fs_pivots, renewal_touches) and comp_recap (AMUTL USD). Title-driven matching for per-producer, Producer Team, and Team aggregates.',
  'scheduled',
  '30 12 * * 1',  -- Mondays 12:30 UTC (8:30 ET, 30 min after Daily Briefing fires)
  'INTERNAL',
  'goals_auto_sync',
  true
)
ON CONFLICT DO NOTHING;
