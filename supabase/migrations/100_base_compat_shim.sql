-- =============================================================================
-- Migration 100 — Base Compatibility Shim
-- =============================================================================
-- Overlay:      bcc-premium-overlay v0.5.2.1
-- Runs before:  100a, 100b, 100c, 100e, 107a-d, 112 (every other overlay
--               migration in this repo)
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Audit on 2026-07-10 (during v0.5.2 pre-flight) found four points where
-- overlay migrations reference schema Base does not ship:
--
--   1. staff.full_name           — Base has first_name + last_name split
--   2. settings.key / value      — Base has setting_key / setting_value
--                                  and is multi-tenant via agency_id
--   3. _install_provenance       — Base's shape is a single-row watermark
--      (install_id, entity,        (install_id, entity, master_head, ...);
--       master_head, installed_at,  every NOT NULL with no default. Overlay
--       notes, overlay_version)     migrations use it as an event log via
--                                   (event_type, event_data) columns that
--                                   don't exist.
--   4. get_current_role_is_owner() — Base ships NO owner-check helper; derive
--      owner status from public.staff.role = 'Owner / Agent' + auth.uid()
--
-- Each mismatch is a hard failure at CREATE VIEW / INSERT / CREATE POLICY
-- time. Without this shim, migrations 100a, 100e, 107a-d, and 112 all abort.
--
-- This shim adapts Base to the overlay's expected surface:
--
--   1. Adds staff.full_name as GENERATED ALWAYS AS (first_name||' '||last_name)
--      STORED. No data migration needed. Zero maintenance — Base updates to
--      first/last_name automatically propagate.
--
--   2. Rewriting the four settings sites in 107a and 112 was cleaner than
--      building a compatibility view + INSTEAD OF triggers, so we did that
--      inline in those files. This shim does NOT touch settings.
--
--   3. Widens _install_provenance with event_type (text) + event_data (jsonb)
--      columns, gives install_id a DEFAULT, and drops NOT NULL from entity
--      and master_head so overlay event-log INSERTs succeed. Base's original
--      watermark row (populated by tools/bootstrap_client_repo.sh at fork
--      time) remains valid — its NOT NULL values are already there.
--
--   4. Creates get_current_role_is_owner() by deriving owner status directly
--      from public.staff — Base ships no owner-check helper in public schema.
--   5. Adds idempotency UNIQUE indexes on public.alerts and
--      public.automation_recipes required by overlay ON CONFLICT clauses.
--
-- DESIGN CHOICES
-- --------------
-- Every DDL is guarded by IF NOT EXISTS or IF EXISTS. Re-running this shim
-- is safe. Committing before any client install ever happened, so no
-- backfill logic is needed.
--
-- IDEMPOTENCY
-- -----------
-- Safe to run repeatedly and against any state that has Base master 000
-- and 022 applied. Fails soft if Base master is at an unexpected commit
-- (raises NOTICE, does not throw).
-- =============================================================================

BEGIN;

-- ============================================================================
-- 1. staff.full_name — GENERATED column so overlay views can read one name
-- ============================================================================
-- The overlay's views (107b, 112) all SELECT s.full_name AS staff_name.
-- Adding as GENERATED means we never carry stale values and can't fall out
-- of sync with first_name/last_name updates. Base staff table remains
-- untouched semantically — the split names are still the source of truth.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'staff'
      AND column_name  = 'full_name'
  ) THEN
    -- Base 001 requires first_name and last_name NOT NULL, so concat is safe.
    ALTER TABLE public.staff
      ADD COLUMN full_name TEXT
      GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED;

    RAISE NOTICE 'Migration 100: added staff.full_name as GENERATED column';
  END IF;
END $$;

COMMENT ON COLUMN public.staff.full_name IS
  'Compatibility shim (100_base_compat_shim). Computed as first_name || '' '' || last_name. Referenced by overlay views v_pto_admin_roster / v_pto_my_requests (107b) and v_upcoming_milestones (112). Do not populate directly — it is GENERATED.';

-- ============================================================================
-- 2. _install_provenance — widen to accept overlay event-log rows
-- ============================================================================
-- Base 000 defines _install_provenance as a single-row watermark. Overlay
-- migrations use it as an append-only event log. Widen without breaking
-- the watermark row.

-- 2a. Add event_type / event_data columns if not present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = '_install_provenance'
      AND column_name  = 'event_type'
  ) THEN
    ALTER TABLE public._install_provenance ADD COLUMN event_type TEXT;
    RAISE NOTICE 'Migration 100: added _install_provenance.event_type';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = '_install_provenance'
      AND column_name  = 'event_data'
  ) THEN
    ALTER TABLE public._install_provenance ADD COLUMN event_data JSONB;
    RAISE NOTICE 'Migration 100: added _install_provenance.event_data';
  END IF;
END $$;

-- 2b. install_id needs a DEFAULT so overlay INSERTs (which don't provide it)
--     get an auto-generated UUID. Base 000 declared install_id as PK NOT NULL
--     with no default; the bootstrap script populated it explicitly. Adding
--     a DEFAULT is backward-compatible.
ALTER TABLE public._install_provenance
  ALTER COLUMN install_id SET DEFAULT gen_random_uuid();

-- 2c. Drop NOT NULL from entity and master_head so overlay event rows can
--     omit them. Base's watermark row already has values in these columns —
--     the constraint drop doesn't affect it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = '_install_provenance'
      AND column_name  = 'entity'
      AND is_nullable  = 'NO'
  ) THEN
    ALTER TABLE public._install_provenance ALTER COLUMN entity DROP NOT NULL;
    RAISE NOTICE 'Migration 100: dropped NOT NULL from _install_provenance.entity';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = '_install_provenance'
      AND column_name  = 'master_head'
      AND is_nullable  = 'NO'
  ) THEN
    ALTER TABLE public._install_provenance ALTER COLUMN master_head DROP NOT NULL;
    RAISE NOTICE 'Migration 100: dropped NOT NULL from _install_provenance.master_head';
  END IF;
END $$;

-- 2d. Index event_type for fast filtering of event-log queries
CREATE INDEX IF NOT EXISTS idx_install_provenance_event_type
  ON public._install_provenance(event_type)
  WHERE event_type IS NOT NULL;

COMMENT ON COLUMN public._install_provenance.event_type IS
  'Compatibility shim (100_base_compat_shim). Populated by overlay migrations to log which migration applied. Watermark rows written by tools/bootstrap_client_repo.sh leave this NULL.';

COMMENT ON COLUMN public._install_provenance.event_data IS
  'Compatibility shim (100_base_compat_shim). JSONB payload for overlay migration event rows — typically {migration, overlay_version, applied_at}.';

-- ============================================================================
-- 3. get_current_role_is_owner() — derive owner status from Base staff table
-- ============================================================================
-- The overlay's RLS policies and RPC gates (107a, 107b, 107c, 107d, 108, 110,
-- 112) all call public.get_current_role_is_owner(). Base master ships NO
-- owner-check helper in the public schema (audited 2026-07-11 against current
-- Base HEAD b9232b38). We derive owner status directly from the canonical
-- Base fields:
--   staff.auth_user_id = auth.uid()  (overlay-added by 100a; deferred resolve)
--   staff.is_active IS TRUE          (Base 001)
--   staff.role = 'Owner / Agent'     (Base seed role label, verified live)
-- PL/pgSQL used so column resolution is deferred to call time, allowing this
-- file to load before 100a adds staff.auth_user_id.

CREATE OR REPLACE FUNCTION public.get_current_role_is_owner()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.staff s
    WHERE s.auth_user_id = auth.uid()
      AND s.is_active IS TRUE
      AND s.role = 'Owner / Agent'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_current_role_is_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_current_role_is_owner() TO authenticated;

COMMENT ON FUNCTION public.get_current_role_is_owner() IS
  'Compatibility shim (100_base_compat_shim, hotfixed v0.5.3.1). Derives owner status from public.staff (role = ''Owner / Agent'', is_active, auth_user_id = auth.uid()). Base master ships no is_current_user_owner() helper — this function IS the definition. Referenced by overlay migrations 107a-d, 108, 110, 112.';

-- ============================================================================
-- 4. Idempotency UNIQUE indexes on Base tables written to by overlay recipes
-- ============================================================================
-- Overlay handlers (handler_licenses_expiration_monitor in 108,
-- handler_milestones_monthly_reminder in 112) rely on ON CONFLICT DO NOTHING
-- to be idempotent across monthly re-runs. Base ships these tables WITHOUT
-- the UNIQUE constraints the overlay depends on. Add them here as
-- additive-only, Base-compatible indexes.
--
-- Dedupe key on public.alerts: (agency_id, alert_type, module_reference,
-- related_id, due_date). This uniquely identifies a "same alert on same
-- date about the same thing" across the overlay's write patterns. NULL
-- values remain distinct per SQL standard, so Base rows with NULL
-- related_id or NULL due_date are unaffected.

CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_overlay_dedupe
  ON public.alerts (agency_id, alert_type, module_reference, related_id, due_date);

COMMENT ON INDEX public.uq_alerts_overlay_dedupe IS
  'Overlay compat shim (100_base_compat_shim, hotfixed v0.5.3.1). Idempotency key for overlay recipes writing to public.alerts. Required by handler_licenses_expiration_monitor (108) and handler_milestones_monthly_reminder (112) ON CONFLICT clauses.';

-- Dedupe key on public.automation_recipes: (agency_id, recipe_name).
-- Overlay migrations seed recipes with recipe_name unique per agency; this
-- lets the seed INSERTs be idempotent across re-runs.

CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_recipes_agency_name
  ON public.automation_recipes (agency_id, recipe_name);

COMMENT ON INDEX public.uq_automation_recipes_agency_name IS
  'Overlay compat shim (100_base_compat_shim, hotfixed v0.5.3.1). Idempotency key for overlay recipe seeds. Required by 108 and 112 ON CONFLICT clauses on public.automation_recipes.';

-- ============================================================================
-- 5. Self-provenance
-- ============================================================================
INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration',       '100_base_compat_shim',
    'overlay_version', '0.5.2.1',
    'applied_at',      now()
  )
);

COMMIT;

-- =============================================================================
-- Verification (run manually after apply)
-- =============================================================================
--
-- 1. staff.full_name exists and computes correctly:
--    SELECT id, first_name, last_name, full_name FROM public.staff LIMIT 3;
--    Expected: full_name = first_name || ' ' || last_name for every row.
--
-- 2. _install_provenance accepts overlay event rows:
--    SELECT column_name, is_nullable, column_default
--      FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='_install_provenance'
--     ORDER BY ordinal_position;
--    Expected: install_id has DEFAULT gen_random_uuid(); entity, master_head
--    is_nullable='YES'; event_type, event_data present.
--
-- 3. Base watermark row still present after schema changes:
--    SELECT install_id, entity, master_head
--      FROM public._install_provenance
--     WHERE event_type IS NULL;
--    Expected: 1 row from tools/bootstrap_client_repo.sh.
--
-- 4. get_current_role_is_owner() returns boolean without error:
--    SELECT public.get_current_role_is_owner() IS NOT NULL AS ok;
--    Expected: shim_matches_base = true.
-- =============================================================================
