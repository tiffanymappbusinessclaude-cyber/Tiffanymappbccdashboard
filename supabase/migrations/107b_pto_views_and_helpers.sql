-- ============================================================================
-- Migration 107b — Premium PTO: views + accrual helper functions
-- ============================================================================
-- Runs after 107a. Provides:
--   • Views for /pto/mine (producer) and /pto/admin (owner)
--   • SECURITY DEFINER Team Availability function (counts only, no names)
--   • Pure accrual helper functions used by RPCs (107c) and cron
-- Accrual math MIRRORS src/lib/pto/accrual.js. Any change here requires
-- updating accrual.js AND smoke test C.4.
-- ----------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- 1. Views (SECURITY INVOKER — rely on RLS from 107a for row filtering)
-- ============================================================================

CREATE OR REPLACE VIEW public.v_pto_my_balance
WITH (security_invoker = true) AS
SELECT
  s.id                          AS staff_id,
  s.full_name                   AS staff_name,
  s.hire_date,
  p.id                          AS policy_id,
  p.name                        AS policy_name,
  p.accrual_pattern,
  p.carryover_type,
  p.carryover_cap_days,
  p.reset_anchor,
  p.fiscal_year_start_month,
  p.tenure_brackets,
  p.waiting_period_days,
  b.id                          AS balance_id,
  b.period_start,
  b.period_end,
  b.balance_days,
  b.accrued_this_period,
  b.used_this_period,
  b.carried_over_from_prior,
  b.last_accrual_date
FROM public.staff s
LEFT JOIN public.pto_policies p ON p.id = s.pto_policy_id
LEFT JOIN LATERAL (
  SELECT * FROM public.pto_balances
  WHERE staff_id = s.id
  ORDER BY period_start DESC
  LIMIT 1
) b ON true
WHERE s.status = 'active';

COMMENT ON VIEW public.v_pto_my_balance IS
  'Producer /pto/mine data source. RLS on pto_balances restricts producer to own row.';

CREATE OR REPLACE VIEW public.v_pto_my_requests
WITH (security_invoker = true) AS
SELECT
  r.id,
  r.staff_id,
  s.full_name AS staff_name,
  r.request_type,
  r.start_date,
  r.end_date,
  r.is_half_day,
  r.half_day_period,
  r.total_days,
  r.reason,
  r.status,
  r.approved_by,
  r.approved_at,
  r.decline_reason,
  r.created_at
FROM public.pto_requests r
JOIN public.staff s ON s.id = r.staff_id;

COMMENT ON VIEW public.v_pto_my_requests IS
  'Feed for /pto/mine request list AND owner /pto/admin approval queue. RLS-filtered.';

CREATE OR REPLACE VIEW public.v_pto_admin_roster
WITH (security_invoker = true) AS
SELECT
  s.id                       AS staff_id,
  s.full_name                AS staff_name,
  s.email,
  s.hire_date,
  s.status                   AS staff_status,
  p.id                       AS policy_id,
  p.name                     AS policy_name,
  b.balance_days,
  b.accrued_this_period,
  b.used_this_period,
  b.period_start,
  b.period_end,
  b.last_accrual_date,
  (SELECT COUNT(*) FROM public.pto_requests r
    WHERE r.staff_id = s.id AND r.status = 'pending') AS pending_request_count
FROM public.staff s
LEFT JOIN public.pto_policies p ON p.id = s.pto_policy_id
LEFT JOIN LATERAL (
  SELECT * FROM public.pto_balances
  WHERE staff_id = s.id
  ORDER BY period_start DESC
  LIMIT 1
) b ON true
WHERE public.get_current_role_is_owner() OR public.is_pto_manager();

COMMENT ON VIEW public.v_pto_admin_roster IS
  'Owner /pto/admin roster. Zero rows for producers even on direct query (Producer Isolation).';

GRANT SELECT ON public.v_pto_my_balance    TO authenticated;
GRANT SELECT ON public.v_pto_my_requests   TO authenticated;
GRANT SELECT ON public.v_pto_admin_roster  TO authenticated;

-- ============================================================================
-- 2. Team Availability — SECURITY DEFINER, counts only, no names
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_pto_team_availability_counts(
  p_from_date date DEFAULT CURRENT_DATE,
  p_to_date   date DEFAULT (CURRENT_DATE + INTERVAL '60 days')::date
)
RETURNS TABLE (
  on_date        date,
  count_out      integer,
  count_half_day integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    d.on_date,
    COUNT(*) FILTER (WHERE r.is_half_day = false)::integer AS count_out,
    COUNT(*) FILTER (WHERE r.is_half_day = true)::integer  AS count_half_day
  FROM generate_series(p_from_date, p_to_date, '1 day'::interval) d(on_date)
  LEFT JOIN public.pto_requests r
    ON d.on_date BETWEEN r.start_date AND r.end_date
    AND r.status = 'approved'
  GROUP BY d.on_date
  ORDER BY d.on_date;
$$;

REVOKE ALL ON FUNCTION public.fn_pto_team_availability_counts(date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_pto_team_availability_counts(date,date) TO authenticated;

COMMENT ON FUNCTION public.fn_pto_team_availability_counts IS
  'Producer-safe Team Availability. Counts only, no staff names or IDs. SECURITY DEFINER by design.';

-- ============================================================================
-- 3. Accrual helper functions
-- ============================================================================
-- Mirror src/lib/pto/accrual.js — both implementations MUST agree.
-- Smoke test C.4 runs each with fixture inputs and compares outputs.

CREATE OR REPLACE FUNCTION public._pto_years_of_service(p_hire_date date, p_as_of date)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT GREATEST(0, EXTRACT(YEAR FROM age(p_as_of, p_hire_date))::integer);
$$;

CREATE OR REPLACE FUNCTION public._pto_validate_tenure_brackets(p_brackets jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_prev_years integer := -1;
  v_bracket    jsonb;
  v_years      integer;
  v_days       numeric;
BEGIN
  IF jsonb_typeof(p_brackets) <> 'array' THEN
    RAISE EXCEPTION 'validation_error: tenure_brackets must be a JSON array';
  END IF;
  FOR v_bracket IN SELECT * FROM jsonb_array_elements(p_brackets) LOOP
    IF NOT (v_bracket ? 'years_min' AND v_bracket ? 'days_per_year') THEN
      RAISE EXCEPTION 'validation_error: each tenure bracket needs years_min and days_per_year';
    END IF;
    v_years := (v_bracket->>'years_min')::integer;
    v_days  := (v_bracket->>'days_per_year')::numeric;
    IF v_years < 0 THEN
      RAISE EXCEPTION 'validation_error: years_min must be non-negative (got %)', v_years;
    END IF;
    IF v_days < 0 THEN
      RAISE EXCEPTION 'validation_error: days_per_year must be non-negative (got %)', v_days;
    END IF;
    IF v_years <= v_prev_years THEN
      RAISE EXCEPTION 'validation_error: tenure brackets must have strictly increasing years_min';
    END IF;
    v_prev_years := v_years;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public._pto_days_per_year_at_tenure(
  p_policy_id uuid,
  p_years_of_service integer
)
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_brackets      jsonb;
  v_flat_rate     numeric;
  v_days_per_year numeric := 0;
  v_bracket       jsonb;
BEGIN
  SELECT tenure_brackets, accrual_rate_days
    INTO v_brackets, v_flat_rate
    FROM public.pto_policies WHERE id = p_policy_id;

  IF v_brackets IS NULL OR jsonb_array_length(v_brackets) = 0 THEN
    RETURN COALESCE(v_flat_rate, 0);
  END IF;

  FOR v_bracket IN SELECT * FROM jsonb_array_elements(v_brackets) LOOP
    IF (v_bracket->>'years_min')::integer <= p_years_of_service THEN
      v_days_per_year := (v_bracket->>'days_per_year')::numeric;
    END IF;
  END LOOP;

  RETURN v_days_per_year;
END $$;

CREATE OR REPLACE FUNCTION public._pto_current_period_start(
  p_policy_id uuid,
  p_hire_date date,
  p_as_of date DEFAULT CURRENT_DATE
)
RETURNS date LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_reset_anchor text;
  v_fiscal_month integer;
  v_candidate    date;
BEGIN
  SELECT reset_anchor, fiscal_year_start_month
    INTO v_reset_anchor, v_fiscal_month
    FROM public.pto_policies WHERE id = p_policy_id;

  IF v_reset_anchor = 'anniversary' THEN
    v_candidate := make_date(EXTRACT(YEAR FROM p_as_of)::integer,
                             EXTRACT(MONTH FROM p_hire_date)::integer,
                             EXTRACT(DAY FROM p_hire_date)::integer);
    IF v_candidate > p_as_of THEN
      v_candidate := v_candidate - INTERVAL '1 year';
    END IF;
    RETURN v_candidate;
  ELSIF v_reset_anchor = 'calendar_year' THEN
    RETURN make_date(EXTRACT(YEAR FROM p_as_of)::integer, 1, 1);
  ELSIF v_reset_anchor = 'fiscal_year_start' THEN
    v_candidate := make_date(EXTRACT(YEAR FROM p_as_of)::integer, v_fiscal_month, 1);
    IF v_candidate > p_as_of THEN
      v_candidate := v_candidate - INTERVAL '1 year';
    END IF;
    RETURN v_candidate;
  END IF;
  RETURN p_as_of;
END $$;

CREATE OR REPLACE FUNCTION public._pto_carryover_from_prior_period(
  p_staff_id uuid,
  p_new_period_start date,
  p_policy public.pto_policies
)
RETURNS numeric
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_prior_balance numeric;
BEGIN
  SELECT balance_days INTO v_prior_balance
    FROM public.pto_balances
   WHERE staff_id = p_staff_id
     AND period_start < p_new_period_start
   ORDER BY period_start DESC
   LIMIT 1;

  IF v_prior_balance IS NULL THEN RETURN 0; END IF;

  IF p_policy.carryover_type = 'use_it_or_lose_it' THEN
    RETURN 0;
  ELSIF p_policy.carryover_type = 'unlimited' THEN
    RETURN GREATEST(0, v_prior_balance);
  ELSIF p_policy.carryover_type = 'capped' THEN
    RETURN LEAST(GREATEST(0, v_prior_balance), COALESCE(p_policy.carryover_cap_days, 0));
  END IF;
  RETURN 0;
END $$;

-- ============================================================================
-- 4. Provenance
-- ============================================================================

INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration', '107b_pto_views_and_helpers',
    'overlay_version', '0.5',
    'applied_at', now()
  )
)
ON CONFLICT DO NOTHING;

COMMIT;
