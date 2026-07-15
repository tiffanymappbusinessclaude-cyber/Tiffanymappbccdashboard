-- ============================================================================
-- Migration 107e — Premium PTO: rpc_edit_pto_request
-- ============================================================================
-- Runs after 107c. Allows the owner of a PENDING PTO request (or an
-- agent-owner) to edit dates / half-day / reason before it's decided.
-- Approved / declined / cancelled requests are immutable via this RPC —
-- to change those, cancel and resubmit.
--
-- request_type intentionally omitted from the editable fields. If a producer
-- picked the wrong type (e.g. "personal" instead of "sick"), the intent
-- differs meaningfully from a date/reason tweak and warrants a fresh
-- submission so the manager sees the reclassification in the queue.
-- ----------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_edit_pto_request(
  p_request_id      uuid,
  p_start_date      date,
  p_end_date        date,
  p_is_half_day     boolean DEFAULT false,
  p_half_day_period text    DEFAULT NULL,
  p_reason          text    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req         public.pto_requests%ROWTYPE;
  v_total_days  numeric;
  v_granularity text;
BEGIN
  SELECT * INTO v_req FROM public.pto_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'not_found: request % does not exist', p_request_id;
  END IF;

  -- Authorization: owner of the request, or agent-owner
  IF v_req.staff_id <> public.current_staff_id()
     AND NOT public.get_current_role_is_owner() THEN
    RAISE EXCEPTION 'permission_denied: you may only edit your own requests';
  END IF;

  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'invalid_state: only pending requests can be edited (current: %)', v_req.status;
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

  UPDATE public.pto_requests SET
    start_date      = p_start_date,
    end_date        = p_end_date,
    is_half_day     = p_is_half_day,
    half_day_period = CASE WHEN p_is_half_day THEN p_half_day_period ELSE NULL END,
    total_days      = v_total_days,
    reason          = p_reason
  WHERE id = p_request_id;
END $$;

REVOKE ALL ON FUNCTION public.rpc_edit_pto_request(uuid,date,date,boolean,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_edit_pto_request(uuid,date,date,boolean,text,text) TO authenticated;

COMMENT ON FUNCTION public.rpc_edit_pto_request IS
  'Edit a pending PTO request. Owner-of-request or agent-owner only. Immutable once approved/declined/cancelled. request_type NOT editable — cancel + resubmit for type changes.';

-- ============================================================================
-- Provenance
-- ============================================================================

INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration', '107e_pto_edit_request',
    'overlay_version', '0.5.3',
    'applied_at', now()
  )
)
ON CONFLICT DO NOTHING;

COMMIT;
