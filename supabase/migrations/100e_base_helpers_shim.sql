-- =============================================================================
-- Migration 100e — Base Helpers Shim (current_staff_id)
-- =============================================================================
-- Overlay:      bcc-premium-overlay v0.5.1-rc1
-- Runs after:   100a (which adds staff.auth_user_id, the column this helper reads)
-- Runs before:  107a-d (PTO — 107c line 113 calls current_staff_id in rpc_create_pto_request)
--
-- Why this migration exists
-- -------------------------
-- Audit during v0.5.1-rc1 discovered that public.current_staff_id() — a helper
-- that maps the current authenticated user to their staff row — is referenced
-- by 107c's rpc_create_pto_request but is NOT defined anywhere in Base's 49
-- migrations (verified against bcc-master-template commits through 068).
--
-- Without this shim, every PTO request submission through the UI would fail
-- with "function public.current_staff_id() does not exist".
--
-- The staff.auth_user_id column that this helper reads is added by 100a in
-- v0.5.1-rc1. If both this migration and 100a are applied in order, everything
-- lines up: 100a adds the column, this shim defines the helper, 107c uses it.
--
-- Design choice: guarded creation
-- -------------------------------
-- If Base later ships current_staff_id() natively with a different signature
-- or body, an unguarded CREATE OR REPLACE could clobber it. The DO block
-- below only creates the function when no version exists, making this shim
-- safe to leave in place across future Base upgrades. If Base adds the
-- function later, our shim silently becomes a no-op.
--
-- Contract
-- --------
-- Returns the current authenticated user's staff row id, or NULL if the
-- caller has no matching staff row (unauthenticated, or authenticated but
-- not linked to a staff record — e.g., service_role calls or auth accounts
-- not yet provisioned into staff).
--
-- Uses staff.auth_user_id as the mapping column (added by 100a, populated
-- by the auth provisioner in 100b/100c). If Base later ships its own
-- current_staff_id() with a different mapping strategy, this shim's
-- guarded creation ensures no conflict.
-- =============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'current_staff_id'
       AND pronamespace = 'public'::regnamespace
  ) THEN
    EXECUTE $sql$
      CREATE OR REPLACE FUNCTION public.current_staff_id()
      RETURNS uuid
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $fn$
        SELECT id
          FROM public.staff
         WHERE auth_user_id = auth.uid()
         LIMIT 1;
      $fn$
    $sql$;

    EXECUTE 'REVOKE ALL ON FUNCTION public.current_staff_id() FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.current_staff_id() TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.current_staff_id() TO service_role';

    COMMENT ON FUNCTION public.current_staff_id() IS
      'Maps auth.uid() to the caller''s staff.id via staff.auth_user_id. Shipped as a Premium shim (migration 100e) after audit showed Base does not define this helper. Returns NULL when the caller has no matching staff row (unauthenticated, service_role, or auth account not yet provisioned).';

    RAISE NOTICE 'Migration 100e: shipped current_staff_id() shim';
  ELSE
    RAISE NOTICE 'Migration 100e: current_staff_id() already exists — shim is a no-op';
  END IF;
END $$;

INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration', '100e_base_helpers_shim',
    'overlay_version', '0.5.1-rc1',
    'applied_at', now()
  )
)
ON CONFLICT DO NOTHING;

COMMIT;

-- =============================================================================
-- Verification (run manually after apply)
-- =============================================================================
--
-- 1. Function exists with expected signature:
--    SELECT proname, pg_get_function_result(oid) AS returns,
--           pg_get_function_arguments(oid) AS args
--      FROM pg_proc
--     WHERE proname = 'current_staff_id'
--       AND pronamespace = 'public'::regnamespace;
--    Expected: one row, returns='uuid', args='' (zero args).
--
-- 2. Function correctly maps a known auth user to their staff row (test
--    from an authenticated session in the app):
--    SELECT public.current_staff_id();
--    Expected: the user's staff.id, or NULL if no staff row is linked.
--
-- 3. Called from service_role returns NULL (no auth.uid() context):
--    SELECT public.current_staff_id();
--    Expected: NULL.
-- =============================================================================
