-- =====================================================================
-- Migration 100a — Premium: Auto-Provisioning Prerequisite
-- =====================================================================
-- Overlay version: v0.5.1-rc1
--
-- This migration is the foundation of the Premium overlay. It must apply
-- before any other Premium migration (100b, 100c, 100d, 107a-d, etc.).
--
-- WHAT THIS MIGRATION DOES:
--   1. Extends the Base staff table with three columns Premium depends on:
--        - status (TEXT: draft | active | terminated) — backfilled from
--          Base's is_active BOOLEAN
--        - auth_user_id (UUID → auth.users) — nullable, populated by the
--          auth provisioner (100b/100c) when a staff row goes active
--        - hire_date (DATE) — backfilled from Base's start_date
--      This section was added in v0.5.1-rc1 after audit revealed Base's
--      staff table does not natively include these fields.
--
--   2. Creates a queue table `_pending_auth_actions` that the auto-
--      provisioning trigger writes to when staff.status changes.
--
--   3. Creates the trigger function `trg_staff_auth_lifecycle()` and
--      binds it to public.staff.
--
--   4. Adds overlay_version tracking to _install_provenance (which is
--      shipped by Base).
--
--   5. Registers this overlay's version so any client repo can be
--      audited for which overlay versions have been applied.
--
--   6. Enables owner-only RLS on the queue table.
--
-- WHAT THIS MIGRATION DOES NOT DO:
--   - Provision or revoke actual Supabase Auth accounts. That work is
--     done by the auth provisioner recipe (100c) and the runner patch
--     (runner-patch/auth_provisioner.ts). This migration only enqueues
--     work; the runner drains the queue.
--
-- IDEMPOTENCY:
--   Safe to re-run. All column adds are guarded with IF NOT EXISTS.
--   Constraints and NOT NULL settings are guarded by information_schema
--   lookups. The trigger uses DROP TRIGGER IF EXISTS before re-creating.
--   Backfill UPDATEs only run once (during initial column add) because
--   they live inside the same DO block as the ADD COLUMN.
--
-- SCHEMA-EVOLUTION SAFETY NOTE:
--   The staff column backfill runs BEFORE the trigger is bound (Section
--   4 below). This is deliberate: if the trigger were bound first, the
--   UPDATE ... SET status = 'active' backfill would fire the trigger on
--   every existing employee row, flooding the queue with provisioning
--   requests. Running backfill before bind avoids that.
--
--   If you ever need to reset the schema (e.g., drop and re-add the
--   status column), drop the trigger first, then the columns, then
--   re-run this migration.
-- =====================================================================

BEGIN;

-- =====================================================================
-- 1. Extend Base's staff table with Premium-required columns
-- =====================================================================
-- Base's staff table (bcc-master-template migration 001_bcc_master_schema)
-- ships with: id, agency_id, first_name, last_name, role, employment_type,
-- start_date, end_date, is_active, email, phone, pay_type, pay_rate, notes,
-- created_at, updated_at.
--
-- Premium needs three additional columns. All three are added idempotently:
--   * status TEXT NOT NULL DEFAULT 'draft'
--       Values: 'draft' | 'active' | 'terminated'
--       Semantics: draft = staff row created but no auth account yet (pre-hire);
--                  active = employed with auth account provisioned;
--                  terminated = separated, auth account banned.
--       Existing Base rows are backfilled: is_active=true → 'active',
--                                          is_active=false → 'terminated'.
--   * auth_user_id UUID → auth.users(id) ON DELETE SET NULL
--       Populated by the auth provisioner (100b/100c) after invite succeeds.
--       Cleared automatically if the auth user is deleted (rare edge case).
--   * hire_date DATE
--       Backfilled from Base's start_date. Used by PTO accrual (107c) to
--       compute tenure via _pto_years_of_service(hire_date, CURRENT_DATE).

-- --- status column + backfill --------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'staff'
       AND column_name  = 'status'
  ) THEN
    -- Add with DEFAULT 'draft' so new-row semantics are correct going forward.
    -- Existing rows all take 'draft' initially, then get overwritten by the
    -- backfill UPDATEs below.
    ALTER TABLE public.staff ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';

    -- Backfill: map Base's is_active BOOLEAN into the new status enum.
    UPDATE public.staff SET status = 'active'
     WHERE is_active = true AND status = 'draft';

    UPDATE public.staff SET status = 'terminated'
     WHERE is_active = false AND status = 'draft';

    RAISE NOTICE 'Migration 100a: added staff.status with backfill from is_active';
  END IF;
END $$;

-- Add the CHECK constraint separately so re-runs against a project that
-- already has the column (but not the constraint) can still add it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'staff_status_check'
       AND table_schema    = 'public'
       AND table_name      = 'staff'
  ) THEN
    ALTER TABLE public.staff
      ADD CONSTRAINT staff_status_check
      CHECK (status IN ('draft', 'active', 'terminated'));
  END IF;
END $$;

-- --- auth_user_id column + FK --------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'staff'
       AND column_name  = 'auth_user_id'
  ) THEN
    ALTER TABLE public.staff ADD COLUMN auth_user_id UUID;
    RAISE NOTICE 'Migration 100a: added staff.auth_user_id';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'staff_auth_user_id_fkey'
       AND table_schema    = 'public'
       AND table_name      = 'staff'
  ) THEN
    ALTER TABLE public.staff
      ADD CONSTRAINT staff_auth_user_id_fkey
      FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Index the auth mapping (used by current_staff_id() shim in 100d)
CREATE INDEX IF NOT EXISTS idx_staff_auth_user_id
  ON public.staff(auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- --- hire_date column + backfill -----------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'staff'
       AND column_name  = 'hire_date'
  ) THEN
    ALTER TABLE public.staff ADD COLUMN hire_date DATE;

    -- Backfill from Base's start_date where present. Rows with NULL
    -- start_date get NULL hire_date; PTO accrual handles that gracefully
    -- via the waiting_period check.
    UPDATE public.staff SET hire_date = start_date
     WHERE hire_date IS NULL AND start_date IS NOT NULL;

    RAISE NOTICE 'Migration 100a: added staff.hire_date with backfill from start_date';
  END IF;
END $$;

COMMENT ON COLUMN public.staff.status IS
  'Premium overlay column (100a). Lifecycle state that drives auto-provisioning. draft = row exists but no auth account (pre-hire); active = employed with auth account; terminated = separated, auth banned. Backfilled from is_active on migration apply.';

COMMENT ON COLUMN public.staff.auth_user_id IS
  'Premium overlay column (100a). Link to the Supabase Auth user record. Populated by the auth provisioner when staff transitions to active. Nullable — draft/terminated rows may not have a link.';

COMMENT ON COLUMN public.staff.hire_date IS
  'Premium overlay column (100a). Used by PTO accrual (107c) to compute tenure via _pto_years_of_service. Backfilled from Base start_date on migration apply.';

-- =====================================================================
-- 2. Queue table for pending auth actions
-- =====================================================================

CREATE TABLE IF NOT EXISTS public._pending_auth_actions (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type     text          NOT NULL
                                CHECK (action_type IN ('provision', 'revoke', 'restore')),
  staff_id        uuid          NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  staff_email     text          NOT NULL,
  staff_name      text          NOT NULL,
  requested_at    timestamptz   NOT NULL DEFAULT now(),
  processed_at    timestamptz,                          -- NULL = pending
  processed_by    text,                                 -- name of recipe/worker that processed
  process_result  jsonb,                                -- {"success": true, "auth_user_id": "..."} or {"success": false, "error": "..."}
  retry_count     integer       NOT NULL DEFAULT 0,
  last_retry_at   timestamptz,
  notes           text
);

CREATE INDEX IF NOT EXISTS idx_pending_auth_actions_pending
  ON public._pending_auth_actions(requested_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pending_auth_actions_staff
  ON public._pending_auth_actions(staff_id, requested_at DESC);

COMMENT ON TABLE public._pending_auth_actions IS
  'Queue for auth account lifecycle actions. Written by trg_staff_auth_lifecycle trigger, consumed by the Composio recipe premium_auth_provisioner.';

-- ---------------------------------------------------------------------
-- 3. Trigger function that dispatches auth actions
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_staff_auth_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_action_type text;
BEGIN
  -- Determine the action based on OLD/NEW status transitions
  -- INSERT case: TG_OP = 'INSERT', OLD is NULL
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'active' THEN
      v_action_type := 'provision';
    ELSE
      RETURN NEW;  -- draft or terminated on insert: no action needed
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only care about status transitions
    IF NEW.status = OLD.status THEN
      RETURN NEW;
    END IF;

    IF OLD.status IN ('draft', 'terminated') AND NEW.status = 'active' THEN
      -- draft→active: fresh provision
      -- terminated→active: restore (rehire)
      IF OLD.status = 'draft' THEN
        v_action_type := 'provision';
      ELSE
        v_action_type := 'restore';
      END IF;
    ELSIF NEW.status = 'terminated' THEN
      v_action_type := 'revoke';
    ELSE
      RETURN NEW;  -- other transitions (e.g., active→draft) not currently handled
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  -- Validate the staff row has the fields needed for auth provisioning
  IF v_action_type IN ('provision', 'restore') THEN
    IF NEW.email IS NULL OR length(trim(NEW.email)) = 0 THEN
      RAISE EXCEPTION 'Cannot provision auth for staff row without email (staff_id=%)', NEW.id;
    END IF;
    IF NEW.first_name IS NULL OR NEW.last_name IS NULL THEN
      RAISE EXCEPTION 'Cannot provision auth for staff row without first_name and last_name (staff_id=%)', NEW.id;
    END IF;
  END IF;

  -- Enqueue the action
  INSERT INTO public._pending_auth_actions (
    action_type,
    staff_id,
    staff_email,
    staff_name,
    notes
  ) VALUES (
    v_action_type,
    NEW.id,
    COALESCE(NEW.email, ''),
    COALESCE(NEW.first_name || ' ' || NEW.last_name, 'unknown'),
    'Enqueued by trg_staff_auth_lifecycle on ' || TG_OP || ' status=' || NEW.status
  );

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.trg_staff_auth_lifecycle() IS
  'Enqueues auth account lifecycle actions when staff.status changes. See migration 100a for the full state transition table.';

-- ---------------------------------------------------------------------
-- 4. Bind the trigger to public.staff
-- ---------------------------------------------------------------------
-- IMPORTANT: This section MUST come after Section 1's backfill UPDATEs,
-- otherwise those UPDATEs would fire the trigger on every existing
-- employee row and flood the queue with provisioning requests.
DROP TRIGGER IF EXISTS staff_auth_lifecycle_trigger ON public.staff;

CREATE TRIGGER staff_auth_lifecycle_trigger
  AFTER INSERT OR UPDATE ON public.staff
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_staff_auth_lifecycle();

-- =====================================================================
-- 5. Overlay version tracking in _install_provenance
-- =====================================================================
-- Base ships _install_provenance already; extend it with overlay_version
-- so audit queries can filter/aggregate by scalar version. The event-log
-- INSERT at the bottom of this file (event_type/event_data shape, added
-- in v0.5.2.1) is the canonical version record; overlay_version stays
-- available for legacy scalar queries.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = '_install_provenance'
       AND column_name  = 'overlay_version'
  ) THEN
    ALTER TABLE public._install_provenance ADD COLUMN overlay_version text;
  END IF;
END $$;

-- Register this migration in the overlay event log. Uses the
-- event_type/event_data shape that 100_base_compat_shim widens
-- _install_provenance with. Multiple apply operations may run against the
-- same project (initial install, then upgrades) — each write captures the
-- version and timestamp so audit queries can walk the full history.
INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration',       '100a_premium_auto_provisioning',
    'overlay_version', '0.5.2.1',
    'applied_at',      now()
  )
);

-- Note: the earlier "overlay_version scalar column + backfill UPDATE" pattern
-- (v0.5.1-rc1 → v0.5-scaffold) was removed in v0.5.2.1 alongside the
-- pre-flight audit that surfaced Base schema drift. Version tracking now
-- flows exclusively through the event log — one row per migration apply.

-- =====================================================================
-- 6. RLS on _pending_auth_actions — owner-only visibility
-- =====================================================================
-- The queue contains PII (staff emails, names, error messages). Only
-- owner-role users can read it. Service role (used by the runner) always
-- bypasses RLS.

ALTER TABLE public._pending_auth_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pending_auth_actions_owner_read ON public._pending_auth_actions;

CREATE POLICY pending_auth_actions_owner_read
  ON public._pending_auth_actions
  FOR SELECT
  TO authenticated
  USING (public.get_current_role_is_owner());

-- No insert / update / delete policy: only service role (via SECURITY
-- DEFINER helpers in 100b) modifies this table. Regular authenticated
-- users cannot write, even owners.

COMMIT;

-- =====================================================================
-- Verification block (run manually after apply)
-- =====================================================================
-- 1. Confirm the staff schema evolution:
--    SELECT column_name, data_type, is_nullable, column_default
--      FROM information_schema.columns
--     WHERE table_schema = 'public' AND table_name = 'staff'
--       AND column_name IN ('status', 'auth_user_id', 'hire_date')
--     ORDER BY column_name;
--    Expected: three rows.
--
-- 2. Confirm the backfill worked:
--    SELECT status, COUNT(*) FROM public.staff GROUP BY status ORDER BY status;
--    Expected: rows for 'active' and 'terminated' matching your existing
--    is_active distribution. No 'draft' rows unless you've been adding
--    new-hire prep entries.
--
-- 3. Insert a test staff row: status='draft' (no invite fires)
--    INSERT INTO public.staff (first_name, last_name, email, status)
--    VALUES ('Test', 'Draft', 'test-draft@example.com', 'draft');
--    -- Expect zero rows in _pending_auth_actions for this staff:
--    SELECT * FROM public._pending_auth_actions
--     WHERE staff_email = 'test-draft@example.com';
--
-- 4. Update to 'active' (provision fires):
--    UPDATE public.staff SET status = 'active'
--     WHERE email = 'test-draft@example.com';
--    -- Expect one 'provision' action pending:
--    SELECT action_type, status FROM public._pending_auth_actions
--     WHERE staff_email = 'test-draft@example.com';
--
-- 5. Update to 'terminated' (revoke fires):
--    UPDATE public.staff SET status = 'terminated'
--     WHERE email = 'test-draft@example.com';
--
-- 6. Update again to 'active' (restore fires):
--    UPDATE public.staff SET status = 'active'
--     WHERE email = 'test-draft@example.com';
--
-- 7. Verify overlay_version is set:
--    SELECT overlay_version, MAX(installed_at) FROM public._install_provenance
--     GROUP BY overlay_version;
--    Expected: v0.5.1-rc1 present.
--
-- 8. Clean up:
--    DELETE FROM public._pending_auth_actions
--     WHERE staff_email = 'test-draft@example.com';
--    DELETE FROM public.staff WHERE email = 'test-draft@example.com';
-- =====================================================================
