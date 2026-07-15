-- =====================================================================
-- Migration 100b — Auth Provisioner Helpers
-- =====================================================================
-- Overlay: bcc-premium-overlay
-- Version: v0.5.1-rc1
-- Prerequisite: 100a_premium_auto_provisioning.sql
-- Consumed by:  composio-recipes/premium_auth_provisioner.json
--
-- What this migration does
-- ------------------------
-- Ships three SECURITY DEFINER helpers so the Composio recipe can drain
-- the _pending_auth_actions queue atomically without holding a Postgres
-- transaction across the HTTP calls to the Supabase Auth admin API.
--
--   1. fn_claim_next_auth_action(...)
--      Atomic claim via FOR UPDATE SKIP LOCKED. Soft-locks the row by
--      bumping last_retry_at = now() so no other worker will pick it up
--      for the backoff window (default 5 min). Returns the row joined
--      with staff.auth_user_id so the recipe can implement revoke and
--      restore correctly without an extra lookup round-trip.
--
--   2. fn_mark_auth_action_success(...)
--      Success path. Updates staff.auth_user_id (for provision/restore
--      only, never revoke) AND marks the queue row processed, in one
--      transaction. Idempotent from the recipe's perspective.
--
--   3. fn_mark_auth_action_failure(...)
--      Failure path. Increments retry_count, sets last_retry_at, and
--      marks the row permanently failed when retries are exhausted.
--      Returns a jsonb summary so the recipe can log/alert on final
--      failure.
--
-- Why this exists
-- ---------------
-- A Composio recipe cannot hold a Postgres transaction while it is off
-- calling the Supabase Auth admin API — that's a synchronous HTTP call
-- that can take seconds. By moving the atomic parts (claim, staff-side
-- update + queue mark, retry accounting) into SQL, the recipe becomes
-- a thin wrapper that can safely crash between steps without
-- corrupting state. If it crashes after the auth API call succeeds
-- but before fn_mark_auth_action_success, the backoff window lets the
-- next run pick it up and the recipe handles the "already registered"
-- case idempotently by looking up the existing user.
--
-- Idempotency
-- -----------
-- CREATE OR REPLACE FUNCTION throughout. Safe to re-apply. Safe to
-- re-apply after Base or Premium upgrades.
--
-- Producer Isolation Principle (B.11)
-- ------------------------------------
-- These functions are SECURITY DEFINER so they bypass RLS. EXECUTE is
-- granted to service_role only. Producers, office_managers, and even
-- owners cannot invoke them directly from the app. This is deliberate:
-- the auth queue is worker-only infrastructure. If an owner ever needs
-- to manually re-drive a queue row, that should go through a separate
-- owner-gated admin RPC in a future migration, not through these.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Defensive column-add: staff.auth_user_id
-- ---------------------------------------------------------------------
-- Migration 100a's RLS policy on _pending_auth_actions references
-- staff.auth_user_id, so it must already exist in Base. Belt-and-
-- suspenders: add it if somehow missing on an older Base install. This
-- is a no-op on any current Base.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'staff'
      AND column_name  = 'auth_user_id'
  ) THEN
    ALTER TABLE public.staff ADD COLUMN auth_user_id uuid;
    -- FK to auth.users intentionally omitted: cross-schema FKs to auth
    -- are fragile across Supabase upgrades. The staff.auth_user_id
    -- value is written by the provisioner recipe and read by RLS.
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 1. fn_claim_next_auth_action
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_claim_next_auth_action(
  p_max_retries      integer DEFAULT 5,
  p_backoff_seconds  integer DEFAULT 300
)
RETURNS TABLE (
  action_id             uuid,
  action_type           text,
  staff_id              uuid,
  staff_email           text,
  staff_name            text,
  existing_auth_user_id uuid,
  retry_count           integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Atomic claim: SELECT FOR UPDATE SKIP LOCKED under a data-modifying
  -- CTE. Any concurrent worker calling this function will skip this
  -- row until the soft-lock (last_retry_at) ages out beyond
  -- p_backoff_seconds. If the recipe crashes after the claim but
  -- before mark_success/mark_failure, the same backoff protects
  -- against thrash.
  RETURN QUERY
  WITH claimed AS (
    SELECT paa.id
    FROM public._pending_auth_actions paa
    WHERE paa.processed_at IS NULL
      AND paa.retry_count  < p_max_retries
      AND (paa.last_retry_at IS NULL
           OR paa.last_retry_at < now() - make_interval(secs => p_backoff_seconds))
    ORDER BY paa.requested_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  ),
  soft_claimed AS (
    UPDATE public._pending_auth_actions paa
    SET last_retry_at = now()
    WHERE paa.id IN (SELECT id FROM claimed)
    RETURNING paa.id, paa.action_type, paa.staff_id,
              paa.staff_email, paa.staff_name, paa.retry_count
  )
  SELECT
    sc.id,
    sc.action_type,
    sc.staff_id,
    sc.staff_email,
    sc.staff_name,
    s.auth_user_id,
    sc.retry_count
  FROM soft_claimed sc
  LEFT JOIN public.staff s ON s.id = sc.staff_id;
END;
$$;

COMMENT ON FUNCTION public.fn_claim_next_auth_action(integer, integer) IS
  'Atomically claim the next eligible auth action from _pending_auth_actions. '
  'Soft-locks the row via last_retry_at bump. Returns 0 rows if queue is empty '
  'or all pending rows are within the backoff window. Called by the Composio '
  'premium_auth_provisioner recipe on its cron tick.';

-- ---------------------------------------------------------------------
-- 2. fn_mark_auth_action_success
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_mark_auth_action_success(
  p_action_id      uuid,
  p_auth_user_id   uuid,
  p_summary        text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_staff_id     uuid;
  v_action_type  text;
BEGIN
  -- Lock the queue row while we work
  SELECT staff_id, action_type
    INTO v_staff_id, v_action_type
  FROM public._pending_auth_actions
  WHERE id = p_action_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'fn_mark_auth_action_success: no queue row found for id=%',
      p_action_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Write auth_user_id back to staff for provision/restore only. Revoke
  -- deliberately keeps the existing staff.auth_user_id so the audit
  -- trail survives and future restore can find the banned account.
  IF v_action_type IN ('provision', 'restore') AND p_auth_user_id IS NOT NULL THEN
    UPDATE public.staff
    SET auth_user_id = p_auth_user_id
    WHERE id = v_staff_id;
  END IF;

  -- Mark queue row processed
  UPDATE public._pending_auth_actions
  SET processed_at    = now(),
      processed_by    = 'premium_auth_provisioner',
      process_result  = jsonb_build_object(
        'success',       true,
        'auth_user_id',  p_auth_user_id,
        'summary',       COALESCE(p_summary, v_action_type || 'ed')
      )
  WHERE id = p_action_id;
END;
$$;

COMMENT ON FUNCTION public.fn_mark_auth_action_success(uuid, uuid, text) IS
  'Mark a queue row as processed successfully. For provision and restore, also '
  'writes p_auth_user_id back to staff.auth_user_id in the same transaction. '
  'Raises no_data_found if the queue row does not exist.';

-- ---------------------------------------------------------------------
-- 3. fn_mark_auth_action_failure
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_mark_auth_action_failure(
  p_action_id    uuid,
  p_error        text,
  p_max_retries  integer DEFAULT 5
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_retry_count  integer;
  v_exhausted        boolean;
BEGIN
  UPDATE public._pending_auth_actions
  SET retry_count    = retry_count + 1,
      last_retry_at  = now(),
      process_result = jsonb_build_object(
        'success', false,
        'error',   p_error,
        'attempt', retry_count + 1
      ),
      processed_at   = CASE
        WHEN retry_count + 1 >= p_max_retries THEN now()
        ELSE NULL
      END,
      processed_by   = CASE
        WHEN retry_count + 1 >= p_max_retries THEN 'premium_auth_provisioner@max_retries_exceeded'
        ELSE NULL
      END
  WHERE id = p_action_id
  RETURNING retry_count, (retry_count >= p_max_retries)
    INTO v_new_retry_count, v_exhausted;

  IF v_new_retry_count IS NULL THEN
    RAISE EXCEPTION 'fn_mark_auth_action_failure: no queue row found for id=%',
      p_action_id
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN jsonb_build_object(
    'retry_count', v_new_retry_count,
    'exhausted',   v_exhausted
  );
END;
$$;

COMMENT ON FUNCTION public.fn_mark_auth_action_failure(uuid, text, integer) IS
  'Record a failed processing attempt. Increments retry_count and updates '
  'last_retry_at. When retry_count reaches p_max_retries, also sets '
  'processed_at = now() so the row is not retried further. Returns '
  '{retry_count, exhausted} for the caller to log or alert on final failure.';

-- ---------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------
-- These functions manipulate the auth queue directly and must only be
-- callable by the service_role that the Composio recipe uses.
-- SECURITY DEFINER bypasses RLS, so restricting EXECUTE is the only
-- guardrail against misuse. Explicit REVOKE FROM PUBLIC in case a
-- future DB restore ships permissive defaults.

REVOKE ALL ON FUNCTION public.fn_claim_next_auth_action(integer, integer)     FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_mark_auth_action_success(uuid, uuid, text)    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_mark_auth_action_failure(uuid, text, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_claim_next_auth_action(integer, integer)     TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_mark_auth_action_success(uuid, uuid, text)    TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_mark_auth_action_failure(uuid, text, integer) TO service_role;

-- ============================================================================
-- 12. Provenance (back-filled 2026-07-12 during pre-v1.0 audit)
-- ============================================================================
-- The original shipped version of this migration (v0.5.1-rc1) omitted the
-- INSERT into _install_provenance. Kept for forensic honesty — the
-- 'provenance_backfilled_in' key distinguishes this row from migrations
-- that had provenance from the start.
-- ============================================================================

INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration',                '100b_auth_provisioner_helpers',
    'overlay_version',          '0.5.1-rc1',
    'provenance_backfilled_in', '0.5.8 (pre-v1.0 audit hygiene, 2026-07-12)',
    'applied_at',               now()
  )
)
ON CONFLICT DO NOTHING;

COMMIT;

-- =====================================================================
-- Verification (run manually after apply)
-- =====================================================================
-- Prep: create a test staff row + a queue row to represent it.
--
--   INSERT INTO staff (first_name, last_name, email, status)
--   VALUES ('Test', 'Provisioner', 'test-provisioner@example.com', 'active');
--   -- The trigger from 100a enqueues a 'provision' row automatically.
--
--   SELECT id, action_type FROM _pending_auth_actions
--   WHERE staff_email = 'test-provisioner@example.com';
--   -- Note the action_id.
--
-- 1. Claim it. Should return one row with the details.
--    SELECT * FROM fn_claim_next_auth_action(5, 300);
--
-- 2. Try to claim again within the backoff window. Should return 0 rows.
--    SELECT * FROM fn_claim_next_auth_action(5, 300);
--
-- 3. Simulate success. Note that we make up an auth_user_id here since
--    we are testing SQL, not the real invite flow.
--    SELECT fn_mark_auth_action_success(
--      '<action_id from step 1>'::uuid,
--      gen_random_uuid(),
--      'test-provision'
--    );
--
-- 4. Verify staff row picked up the auth_user_id:
--    SELECT auth_user_id FROM staff WHERE email = 'test-provisioner@example.com';
--    -- Should be non-null and match the uuid you passed above.
--
-- 5. Verify queue row is done:
--    SELECT processed_at, processed_by, process_result
--    FROM _pending_auth_actions WHERE staff_email = 'test-provisioner@example.com';
--    -- processed_at set, processed_by = 'premium_auth_provisioner',
--    -- process_result.success = true.
--
-- 6. Simulate failure path. Terminate the test staff (enqueues revoke),
--    then run failure marking repeatedly.
--    UPDATE staff SET status='terminated' WHERE email='test-provisioner@example.com';
--    SELECT * FROM fn_claim_next_auth_action(5, 0);   -- 0 backoff for testing
--    SELECT fn_mark_auth_action_failure('<revoke_action_id>'::uuid, 'test error', 3);
--    -- Repeat 3 times and observe retry_count climb, then exhausted=true.
--
-- 7. Clean up:
--    DELETE FROM _pending_auth_actions
--    WHERE staff_id = (SELECT id FROM staff WHERE email='test-provisioner@example.com');
--    DELETE FROM staff WHERE email = 'test-provisioner@example.com';
-- =====================================================================
