-- Migration 027 — staff_performance_snapshot_writer function + monthly recipe + 17-month backfill
-- Applied to production via Supabase MCP on 2026-06-22.
--
-- Function is idempotent (CREATE OR REPLACE). Recipe row is gated by NOT EXISTS
-- so re-running this migration won't duplicate the recipe. Backfill block at
-- the bottom is also idempotent thanks to the ON CONFLICT in the writer.

-- ════════════════════════════════════════════════════════════════════
-- staff_performance_snapshot_writer
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.staff_performance_snapshot_writer(
  p_agency_id uuid,
  p_recipe_id uuid DEFAULT NULL,
  p_target_year int DEFAULT NULL,
  p_target_month int DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_year int;
  v_month int;
  v_staff_record RECORD;
  v_rows_written int := 0;
  v_staff_processed int := 0;
  v_prev_month_first date;
BEGIN
  IF p_target_year IS NULL OR p_target_month IS NULL THEN
    v_prev_month_first := date_trunc('month', CURRENT_DATE) - INTERVAL '1 month';
    v_year := EXTRACT(YEAR FROM v_prev_month_first)::int;
    v_month := EXTRACT(MONTH FROM v_prev_month_first)::int;
  ELSE
    v_year := p_target_year;
    v_month := p_target_month;
  END IF;

  FOR v_staff_record IN
    SELECT
      pd.staff_id,
      SUM(pd.gross_pay) AS gross_pay,
      SUM(pd.net_pay) AS net_pay,
      SUM(COALESCE(pd.federal_tax,0) + COALESCE(pd.state_tax,0)
          + COALESCE(pd.social_security,0) + COALESCE(pd.medicare,0)) AS total_tax,
      COUNT(*) AS paycheck_count
    FROM payroll_detail pd
    JOIN payroll_runs pr ON pd.payroll_run_id = pr.id
    WHERE pr.agency_id = p_agency_id
      AND EXTRACT(YEAR FROM pr.pay_date) = v_year
      AND EXTRACT(MONTH FROM pr.pay_date) = v_month
      AND pd.staff_id IS NOT NULL
    GROUP BY pd.staff_id
  LOOP
    INSERT INTO staff_performance
      (agency_id, staff_id, period_year, period_month, metric_name, target, actual, achievement_pct, notes)
    VALUES
      (p_agency_id, v_staff_record.staff_id, v_year, v_month, 'gross_pay_monthly',
       NULL, ROUND(v_staff_record.gross_pay::numeric, 2), NULL,
       'Source: payroll_detail.gross_pay (sum). Computed by staff_performance_snapshot_writer.')
    ON CONFLICT (agency_id, staff_id, period_year, period_month, metric_name)
    DO UPDATE SET actual = EXCLUDED.actual, notes = EXCLUDED.notes;

    INSERT INTO staff_performance
      (agency_id, staff_id, period_year, period_month, metric_name, target, actual, achievement_pct, notes)
    VALUES
      (p_agency_id, v_staff_record.staff_id, v_year, v_month, 'fully_loaded_cost_monthly',
       NULL, ROUND((v_staff_record.gross_pay * 1.15)::numeric, 2), NULL,
       'Gross pay × 1.15 (FICA/FUTA/SUTA/WC envelope per SF Agency Reference Guide). Used in Producer ROI math.')
    ON CONFLICT (agency_id, staff_id, period_year, period_month, metric_name)
    DO UPDATE SET actual = EXCLUDED.actual, notes = EXCLUDED.notes;

    INSERT INTO staff_performance
      (agency_id, staff_id, period_year, period_month, metric_name, target, actual, achievement_pct, notes)
    VALUES
      (p_agency_id, v_staff_record.staff_id, v_year, v_month, 'net_pay_monthly',
       NULL, ROUND(v_staff_record.net_pay::numeric, 2), NULL,
       'Source: payroll_detail.net_pay (sum).')
    ON CONFLICT (agency_id, staff_id, period_year, period_month, metric_name)
    DO UPDATE SET actual = EXCLUDED.actual, notes = EXCLUDED.notes;

    INSERT INTO staff_performance
      (agency_id, staff_id, period_year, period_month, metric_name, target, actual, achievement_pct, notes)
    VALUES
      (p_agency_id, v_staff_record.staff_id, v_year, v_month, 'paychecks_count',
       NULL, v_staff_record.paycheck_count, NULL,
       'Number of payroll_detail rows for this staff in this month.')
    ON CONFLICT (agency_id, staff_id, period_year, period_month, metric_name)
    DO UPDATE SET actual = EXCLUDED.actual, notes = EXCLUDED.notes;

    INSERT INTO staff_performance
      (agency_id, staff_id, period_year, period_month, metric_name, target, actual, achievement_pct, notes)
    VALUES
      (p_agency_id, v_staff_record.staff_id, v_year, v_month, 'effective_tax_rate',
       NULL,
       CASE WHEN v_staff_record.gross_pay > 0
            THEN ROUND((v_staff_record.total_tax / v_staff_record.gross_pay * 100)::numeric, 2)
            ELSE NULL END,
       NULL,
       '(Federal+State+SS+Medicare) withheld ÷ gross × 100. Employee-side only, not employer burden.')
    ON CONFLICT (agency_id, staff_id, period_year, period_month, metric_name)
    DO UPDATE SET actual = EXCLUDED.actual, notes = EXCLUDED.notes;

    v_rows_written := v_rows_written + 5;
    v_staff_processed := v_staff_processed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'agency_id', p_agency_id,
    'recipe_id', p_recipe_id,
    'period_year', v_year,
    'period_month', v_month,
    'staff_processed', v_staff_processed,
    'rows_written', v_rows_written,
    'metrics_per_staff', 5,
    'run_at', NOW()
  );
END;
$func$;

-- ════════════════════════════════════════════════════════════════════
-- Recipe row — monthly on the 5th @ 12:00 UTC (8 AM Eastern)
-- ════════════════════════════════════════════════════════════════════
INSERT INTO automation_recipes
  (agency_id, recipe_name, recipe_description, trigger_type, cron_expression,
   composio_action, internal_handler, input_config, output_table, output_config, is_active)
SELECT (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1),
       'Staff Performance Snapshot Writer',
       'Monthly — on the 5th, writes the previous month''s per-staff KPI snapshots from payroll_detail + payroll_runs. Idempotent. Feeds the HR & People → Performance tab with trend data.',
       'schedule', '0 12 5 * *', 'INTERNAL', 'staff_performance_snapshot_writer',
       '{"metrics_written":["gross_pay_monthly","fully_loaded_cost_monthly","net_pay_monthly","paychecks_count","effective_tax_rate"],"default_period":"previous_calendar_month","production_metrics_deferred":"premium_issued + policies_issued metrics will be added when producer_production has data"}'::jsonb,
       'staff_performance',
       '{"upsert_keys":["agency_id","staff_id","period_year","period_month","metric_name"],"update_fields":["actual","notes"]}'::jsonb,
       true
WHERE NOT EXISTS (
  SELECT 1 FROM automation_recipes
  WHERE agency_id=(SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1)
    AND recipe_name='Staff Performance Snapshot Writer'
);

-- ════════════════════════════════════════════════════════════════════
-- Backfill — Jan 2025 through May 2026 (June skipped: partial-month source data)
-- ════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_year int;
  v_month int;
BEGIN
  FOR v_year IN 2025..2026 LOOP
    FOR v_month IN 1..12 LOOP
      EXIT WHEN v_year = 2026 AND v_month > 5;
      PERFORM staff_performance_snapshot_writer(
        (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1),
        NULL,
        v_year,
        v_month
      );
    END LOOP;
  END LOOP;
END $$;
