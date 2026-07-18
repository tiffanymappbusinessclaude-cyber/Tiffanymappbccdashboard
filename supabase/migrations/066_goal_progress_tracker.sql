-- Migration 026 — goal_progress_tracker function + recipe wiring
-- Applied to production via Supabase MCP on 2026-06-22.
-- Idempotent: CREATE OR REPLACE on the function; INSERT on the recipe (no PK conflict expected
-- since no row with recipe_name='Goal Progress Tracker' existed prior).

-- ════════════════════════════════════════════════════════════════════
-- goal_progress_tracker — internal handler for the Goals Progress recipe
-- ════════════════════════════════════════════════════════════════════
-- Maps each active goal to its source-of-truth and updates current_value.
-- Dispatch is by (category, unit). Retention goals are skipped so the agent's
-- manual SF-retention-report entries survive each daily run.
--
-- Mapping (each branch documented inline):
--   aipp                      -> aipp_tracking.earned_ytd (current program year)
--   payroll_ratio             -> v_income_statement YTD: team_pay / gross * 100
--   profitability             -> v_income_statement YTD: net_income / gross * 100
--   production + unit=USD     -> producer_production Q3 P&C premium
--   production + unit=apps    -> producer_production Q3 Health apps
--   scoreboard                -> producer_production Q3 Life apps
--   recruiting                -> applicants active pipeline
--   retention                 -> SKIPPED (manual input from SF report)
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.goal_progress_tracker(
  p_agency_id uuid,
  p_recipe_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_goal RECORD;
  v_current numeric;
  v_updates jsonb := '[]'::jsonb;
  v_skip_count int := 0;
  v_update_count int := 0;
  v_unchanged_count int := 0;
  v_current_year int := EXTRACT(year FROM CURRENT_DATE)::int;
  v_q3_months int[] := ARRAY[7,8,9];
BEGIN
  FOR v_goal IN
    SELECT id, title, category, target_value, current_value, unit
    FROM goals
    WHERE agency_id = p_agency_id AND status = 'active'
    ORDER BY category
  LOOP
    v_current := NULL;

    IF v_goal.category = 'aipp' THEN
      SELECT COALESCE(earned_ytd, 0) INTO v_current
      FROM aipp_tracking
      WHERE agency_id = p_agency_id AND program_year = v_current_year
      ORDER BY last_updated DESC NULLS LAST LIMIT 1;

    ELSIF v_goal.category = 'payroll_ratio' THEN
      WITH ytd AS (
        SELECT
          SUM(CASE WHEN account_type='income' THEN amount ELSE 0 END) AS gross,
          SUM(CASE WHEN (account_name ILIKE '%salaries%' OR account_name ILIKE '%wages%')
                    AND account_name NOT ILIKE '%officer%' THEN amount ELSE 0 END) AS team_pay
        FROM v_income_statement
        WHERE agency_id = p_agency_id AND period_year = v_current_year
      )
      SELECT CASE WHEN gross > 0 THEN ROUND((team_pay / gross * 100)::numeric, 1) ELSE 0 END
      INTO v_current FROM ytd;

    ELSIF v_goal.category = 'profitability' THEN
      WITH ytd AS (
        SELECT
          SUM(CASE WHEN account_type='income' THEN amount ELSE 0 END) AS gross,
          SUM(CASE WHEN account_type='income' THEN amount ELSE -amount END) AS net_income
        FROM v_income_statement
        WHERE agency_id = p_agency_id AND period_year = v_current_year
      )
      SELECT CASE WHEN gross > 0 THEN ROUND((net_income / gross * 100)::numeric, 1) ELSE 0 END
      INTO v_current FROM ytd;

    ELSIF v_goal.category = 'production' AND v_goal.unit = 'USD' THEN
      SELECT COALESCE(SUM(premium_issued), 0) INTO v_current
      FROM producer_production
      WHERE agency_id = p_agency_id AND period_year = v_current_year
        AND period_month = ANY(v_q3_months)
        AND (line_of_business ILIKE '%auto%' OR line_of_business ILIKE '%fire%'
             OR line_of_business ILIKE '%p&c%' OR line_of_business ILIKE '%p_c%'
             OR line_of_business ILIKE '%property%');

    ELSIF v_goal.category = 'production' AND v_goal.unit = 'apps' THEN
      SELECT COALESCE(SUM(policies_issued), 0) INTO v_current
      FROM producer_production
      WHERE agency_id = p_agency_id AND period_year = v_current_year
        AND period_month = ANY(v_q3_months)
        AND line_of_business ILIKE '%health%';

    ELSIF v_goal.category = 'scoreboard' THEN
      SELECT COALESCE(SUM(policies_issued), 0) INTO v_current
      FROM producer_production
      WHERE agency_id = p_agency_id AND period_year = v_current_year
        AND period_month = ANY(v_q3_months)
        AND line_of_business ILIKE '%life%';

    ELSIF v_goal.category = 'recruiting' THEN
      SELECT COUNT(*)::numeric INTO v_current
      FROM applicants
      WHERE agency_id = p_agency_id
        AND (status IS NULL OR status NOT IN ('hired','rejected','withdrawn'));

    ELSIF v_goal.category = 'retention' THEN
      v_skip_count := v_skip_count + 1;
      v_updates := v_updates || jsonb_build_object(
        'goal_id', v_goal.id, 'title', v_goal.title, 'category', v_goal.category,
        'action', 'skipped_manual_input', 'current_value', v_goal.current_value);
      CONTINUE;

    ELSE
      v_skip_count := v_skip_count + 1;
      v_updates := v_updates || jsonb_build_object(
        'goal_id', v_goal.id, 'title', v_goal.title,
        'action', 'skipped_unknown_category_unit',
        'category', v_goal.category, 'unit', v_goal.unit);
      CONTINUE;
    END IF;

    IF v_current IS NOT NULL AND v_current IS DISTINCT FROM v_goal.current_value THEN
      UPDATE goals SET current_value = v_current, updated_at = NOW() WHERE id = v_goal.id;
      v_update_count := v_update_count + 1;
    ELSE
      v_unchanged_count := v_unchanged_count + 1;
    END IF;

    v_updates := v_updates || jsonb_build_object(
      'goal_id', v_goal.id, 'title', v_goal.title, 'category', v_goal.category,
      'old_value', v_goal.current_value, 'new_value', v_current,
      'target', v_goal.target_value,
      'pct_to_target', CASE WHEN v_goal.target_value > 0
                            THEN ROUND((v_current / v_goal.target_value * 100)::numeric, 1)
                            ELSE NULL END);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'agency_id', p_agency_id,
    'recipe_id', p_recipe_id,
    'updates_applied', v_update_count,
    'unchanged', v_unchanged_count,
    'skipped', v_skip_count,
    'total_goals', v_update_count + v_unchanged_count + v_skip_count,
    'goals', v_updates,
    'run_at', NOW()
  );
END;
$func$;

-- ════════════════════════════════════════════════════════════════════
-- Recipe row — daily 7 AM Eastern (before the Daily Briefing at 8 AM Eastern)
-- ════════════════════════════════════════════════════════════════════
INSERT INTO automation_recipes
  (agency_id, recipe_name, recipe_description, trigger_type, cron_expression,
   composio_action, internal_handler, input_config, output_table, output_config, is_active)
SELECT (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1),
       'Goal Progress Tracker',
       'Daily — refreshes current_value on every active goal from its mapped source-of-truth table. Skips retention goals (manual input from SF report). Logs per-goal before/after values + pct_to_target to automation_run_log.',
       'schedule', '0 11 * * *', 'INTERNAL', 'goal_progress_tracker',
       '{"skip_categories":["retention"],"source_map":{"aipp":"aipp_tracking.earned_ytd","payroll_ratio":"v_income_statement (team_pay/gross)","profitability":"v_income_statement (net_income/gross)","production_USD":"producer_production Q3 P&C premium","production_apps":"producer_production Q3 Health apps","scoreboard":"producer_production Q3 Life apps","recruiting":"applicants active pipeline"}}'::jsonb,
       'goals',
       '{"update_fields":["current_value","updated_at"],"conflict_keys":["id"]}'::jsonb,
       true
WHERE NOT EXISTS (
  SELECT 1 FROM automation_recipes
  WHERE agency_id=(SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1)
    AND recipe_name='Goal Progress Tracker'
);
