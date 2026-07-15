-- ============================================================================
-- Migration 107c — Premium PTO: RPCs (policy, request lifecycle, cron)
-- ============================================================================
-- Runs after 107b. Depends on helpers defined in 107b. All RPCs are
-- SECURITY DEFINER with explicit permission gates inside; nothing relies
-- on RLS for authorization.
-- ----------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- 1. Policy upsert
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rpc_upsert_pto_policy(
  p_id                       uuid,
  p_name                     text,
  p_accrual_pattern          text,
  p_accrual_rate_days        numeric DEFAULT NULL,
  p_tenure_brackets          jsonb   DEFAULT '[]'::jsonb,
  p_accrual_start_basis      text    DEFAULT 'hire_date',
  p_waiting_period_days      integer DEFAULT 0,
  p_carryover_type           text    DEFAULT 'use_it_or_lose_it',
  p_carryover_cap_days       numeric DEFAULT NULL,
  p_reset_anchor             text    DEFAULT 'anniversary',
  p_fiscal_year_start_month  integer DEFAULT NULL,
  p_is_active                boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.get_current_role_is_owner() THEN
    RAISE EXCEPTION 'permission_denied: only agent-owner may create or edit PTO policies';
  END IF;

  IF trim(COALESCE(p_name,'')) = '' THEN
    RAISE EXCEPTION 'validation_error: policy name is required';
  END IF;

  IF p_accrual_pattern = 'anniversary' AND jsonb_array_length(p_tenure_brackets) > 0 THEN
    PERFORM public._pto_validate_tenure_brackets(p_tenure_brackets);
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.pto_policies (
      name, accrual_pattern, accrual_rate_days, tenure_brackets,
      accrual_start_basis, waiting_period_days,
      carryover_type, carryover_cap_days,
      reset_anchor, fiscal_year_start_month,
      is_active, created_by
    ) VALUES (
      trim(p_name), p_accrual_pattern, p_accrual_rate_days, p_tenure_brackets,
      p_accrual_start_basis, p_waiting_period_days,
      p_carryover_type, p_carryover_cap_days,
      p_reset_anchor, p_fiscal_year_start_month,
      p_is_active, auth.uid()
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.pto_policies SET
      name = trim(p_name),
      accrual_pattern = p_accrual_pattern,
      accrual_rate_days = p_accrual_rate_days,
      tenure_brackets = p_tenure_brackets,
      accrual_start_basis = p_accrual_start_basis,
      waiting_period_days = p_waiting_period_days,
      carryover_type = p_carryover_type,
      carryover_cap_days = p_carryover_cap_days,
      reset_anchor = p_reset_anchor,
      fiscal_year_start_month = p_fiscal_year_start_month,
      is_active = p_is_active
    WHERE id = p_id
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      RAISE EXCEPTION 'not_found: policy % does not exist', p_id;
    END IF;
  END IF;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.rpc_upsert_pto_policy(uuid,text,text,numeric,jsonb,text,integer,text,numeric,text,integer,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_pto_policy(uuid,text,text,numeric,jsonb,text,integer,text,numeric,text,integer,boolean) TO authenticated;

-- ============================================================================
-- 2. Request lifecycle
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rpc_create_pto_request(
  p_start_date       date,
  p_end_date         date,
  p_is_half_day      boolean DEFAULT false,
  p_half_day_period  text    DEFAULT NULL,
  p_reason           text    DEFAULT NULL,
  p_request_type     text    DEFAULT 'pto'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_staff_id     uuid;
  v_total_days   numeric;
  v_request_id   uuid;
  v_granularity  text;
BEGIN
  v_staff_id := public.current_staff_id();
  IF v_staff_id IS NULL THEN
    RAISE EXCEPTION 'auth_required: no staff row for current user';
  END IF;

  IF p_end_date < p_start_date THEN
    RAISE EXCEPTION 'validation_error: end_date must be on or after start_date';
  END IF;

  SELECT setting_value INTO v_granularity FROM public.settings
   WHERE setting_key = 'pto_request_granularity' LIMIT 1;

  IF v_granularity = 'full_day_only' AND p_is_half_day = true THEN
    RAISE EXCEPTION 'validation_error: agency PTO policy does not permit half-day requests';
  END IF;

  IF p_is_half_day AND p_half_day_period IS NULL THEN
    RAISE EXCEPTION 'validation_error: half-day requests require am or pm designation';
  END IF;

  IF p_is_half_day AND p_start_date <> p_end_date THEN
    RAISE EXCEPTION 'validation_error: half-day requests must be for a single date';
  END IF;

  IF p_is_half_day THEN
    v_total_days := 0.5;
  ELSE
    v_total_days := (p_end_date - p_start_date + 1)::numeric;
  END IF;

  INSERT INTO public.pto_requests (
    staff_id, request_type, start_date, end_date,
    is_half_day, half_day_period, total_days, reason, status
  ) VALUES (
    v_staff_id, p_request_type, p_start_date, p_end_date,
    p_is_half_day, p_half_day_period, v_total_days, p_reason, 'pending'
  )
  RETURNING id INTO v_request_id;

  RETURN v_request_id;
END $$;

REVOKE ALL ON FUNCTION public.rpc_create_pto_request(date,date,boolean,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_create_pto_request(date,date,boolean,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.rpc_approve_pto_request(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req     public.pto_requests%ROWTYPE;
  v_balance public.pto_balances%ROWTYPE;
BEGIN
  IF NOT (public.get_current_role_is_owner() OR public.is_pto_manager()) THEN
    RAISE EXCEPTION 'permission_denied: only agent-owner or authorized manager may approve PTO';
  END IF;

  SELECT * INTO v_req FROM public.pto_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'not_found: request % does not exist', p_request_id;
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'invalid_state: request is % (only pending requests can be approved)', v_req.status;
  END IF;

  SELECT * INTO v_balance FROM public.pto_balances
   WHERE staff_id = v_req.staff_id
   ORDER BY period_start DESC LIMIT 1 FOR UPDATE;

  IF v_balance.id IS NOT NULL THEN
    UPDATE public.pto_balances SET
      balance_days     = balance_days - v_req.total_days,
      used_this_period = used_this_period + v_req.total_days
    WHERE id = v_balance.id;
  END IF;

  UPDATE public.pto_requests SET
    status      = 'approved',
    approved_by = auth.uid(),
    approved_at = now()
  WHERE id = p_request_id;
END $$;

REVOKE ALL ON FUNCTION public.rpc_approve_pto_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_approve_pto_request(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.rpc_decline_pto_request(p_request_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT (public.get_current_role_is_owner() OR public.is_pto_manager()) THEN
    RAISE EXCEPTION 'permission_denied: only agent-owner or authorized manager may decline PTO';
  END IF;
  IF trim(COALESCE(p_reason,'')) = '' THEN
    RAISE EXCEPTION 'validation_error: decline reason is required';
  END IF;
  SELECT status INTO v_status FROM public.pto_requests WHERE id = p_request_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found: request % does not exist', p_request_id;
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'invalid_state: request is % (only pending requests can be declined)', v_status;
  END IF;

  UPDATE public.pto_requests SET
    status = 'denied', decline_reason = p_reason,
    approved_by = auth.uid(), approved_at = now()
  WHERE id = p_request_id;
END $$;

REVOKE ALL ON FUNCTION public.rpc_decline_pto_request(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_decline_pto_request(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.rpc_cancel_pto_request(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.pto_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM public.pto_requests WHERE id = p_request_id;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'not_found: request % does not exist', p_request_id;
  END IF;
  IF v_req.staff_id <> public.current_staff_id()
     AND NOT public.get_current_role_is_owner() THEN
    RAISE EXCEPTION 'permission_denied: you may only cancel your own requests';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'invalid_state: only pending requests can be cancelled (current: %)', v_req.status;
  END IF;
  UPDATE public.pto_requests SET status = 'cancelled' WHERE id = p_request_id;
END $$;

REVOKE ALL ON FUNCTION public.rpc_cancel_pto_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_pto_request(uuid) TO authenticated;

-- ============================================================================
-- 3. Nightly accrual (Composio cron -> service_role)
-- ============================================================================
-- Idempotent: uses last_accrual_date -> CURRENT_DATE window, so running twice
-- in the same day yields zero incremental accrual. Errors per-staff are
-- collected and returned; the loop continues so one bad staff row doesn't
-- block the rest of the roster.

CREATE OR REPLACE FUNCTION public.rpc_run_nightly_pto_accrual()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_staff           record;
  v_policy          public.pto_policies%ROWTYPE;
  v_balance         public.pto_balances%ROWTYPE;
  v_period_start    date;
  v_period_end      date;
  v_years_service   integer;
  v_days_per_year   numeric;
  v_accrual_days    numeric;
  v_days_since_last integer;
  v_processed       integer := 0;
  v_skipped         integer := 0;
  v_errors          jsonb := '[]'::jsonb;
BEGIN
  FOR v_staff IN
    SELECT s.id, s.hire_date, s.pto_policy_id
      FROM public.staff s
     WHERE s.status = 'active'
       AND s.pto_policy_id IS NOT NULL
  LOOP
    BEGIN
      SELECT * INTO v_policy FROM public.pto_policies
       WHERE id = v_staff.pto_policy_id AND is_active = true;
      IF v_policy.id IS NULL THEN
        v_skipped := v_skipped + 1; CONTINUE;
      END IF;

      IF v_policy.accrual_pattern = 'unlimited' THEN
        v_skipped := v_skipped + 1; CONTINUE;
      END IF;

      IF v_staff.hire_date + v_policy.waiting_period_days > CURRENT_DATE THEN
        v_skipped := v_skipped + 1; CONTINUE;
      END IF;

      v_period_start := public._pto_current_period_start(
        v_policy.id, v_staff.hire_date, CURRENT_DATE
      );

      IF v_policy.reset_anchor = 'anniversary' THEN
        v_period_end := (v_period_start + INTERVAL '1 year' - INTERVAL '1 day')::date;
      ELSIF v_policy.reset_anchor = 'calendar_year' THEN
        v_period_end := make_date(EXTRACT(YEAR FROM v_period_start)::integer, 12, 31);
      ELSE
        v_period_end := (v_period_start + INTERVAL '1 year' - INTERVAL '1 day')::date;
      END IF;

      SELECT * INTO v_balance FROM public.pto_balances
       WHERE staff_id = v_staff.id AND period_start = v_period_start
       FOR UPDATE;

      IF v_balance.id IS NULL THEN
        INSERT INTO public.pto_balances (
          staff_id, policy_id, period_start, period_end,
          balance_days, accrued_this_period, used_this_period,
          carried_over_from_prior, last_accrual_date
        ) VALUES (
          v_staff.id, v_policy.id, v_period_start, v_period_end,
          0, 0, 0,
          public._pto_carryover_from_prior_period(v_staff.id, v_period_start, v_policy),
          v_period_start
        )
        RETURNING * INTO v_balance;
        UPDATE public.pto_balances SET
          balance_days = carried_over_from_prior
         WHERE id = v_balance.id
         RETURNING * INTO v_balance;
      END IF;

      v_years_service := public._pto_years_of_service(v_staff.hire_date, CURRENT_DATE);
      v_days_per_year := public._pto_days_per_year_at_tenure(v_policy.id, v_years_service);

      v_days_since_last := (CURRENT_DATE - COALESCE(v_balance.last_accrual_date, v_period_start))::integer;
      IF v_days_since_last <= 0 THEN
        v_skipped := v_skipped + 1; CONTINUE;
      END IF;

      IF v_policy.accrual_pattern = 'anniversary' THEN
        v_accrual_days := (v_days_per_year / 365.0) * v_days_since_last;
      ELSIF v_policy.accrual_pattern = 'monthly' THEN
        v_accrual_days := (v_policy.accrual_rate_days * 12.0 / 365.0) * v_days_since_last;
      ELSIF v_policy.accrual_pattern = 'biweekly' THEN
        v_accrual_days := (v_policy.accrual_rate_days / 14.0) * v_days_since_last;
      ELSE
        v_accrual_days := 0;
      END IF;

      v_accrual_days := ROUND(v_accrual_days::numeric, 2);

      UPDATE public.pto_balances SET
        balance_days        = balance_days + v_accrual_days,
        accrued_this_period = accrued_this_period + v_accrual_days,
        last_accrual_date   = CURRENT_DATE
      WHERE id = v_balance.id;

      v_processed := v_processed + 1;

    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || jsonb_build_object(
        'staff_id', v_staff.id, 'error', SQLERRM
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'skipped',   v_skipped,
    'errors',    v_errors,
    'run_at',    now()
  );
END $$;

REVOKE ALL ON FUNCTION public.rpc_run_nightly_pto_accrual() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_run_nightly_pto_accrual() TO service_role;

-- ============================================================================
-- 4. Provenance
-- ============================================================================

INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration', '107c_pto_rpcs',
    'overlay_version', '0.5',
    'applied_at', now()
  )
)
ON CONFLICT DO NOTHING;

COMMIT;
