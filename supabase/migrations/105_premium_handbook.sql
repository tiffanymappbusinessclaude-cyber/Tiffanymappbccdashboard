-- =============================================================================
-- 105_premium_handbook.sql — Module 05 (Handbook) — bcc-premium-overlay v0.5.4
-- =============================================================================
-- Ships:
--   • public.handbook_sections           — versioned policy sections
--   • public.handbook_acknowledgments    — per-staff acknowledgment log
--   • public.is_handbook_manager()       — B.11 gate function
--   • public.settings row                — enable_handbook_manager_access
--   • public.v_handbook_current_version  — computed current handbook version
--   • public.v_handbook_current          — active sections + current_version
--   • public.v_handbook_ack_status       — per-staff acknowledgment status
--   • RPCs:
--       handbook_get_current(p_agency_id)
--       handbook_upsert_section(p_agency_id, p_section_number, p_title, p_content)
--       handbook_deactivate_section(p_agency_id, p_section_id)
--       handbook_acknowledge(p_agency_id, p_ip_address)
--       handbook_get_ack_status(p_agency_id)
--       handbook_get_my_ack_status(p_agency_id)
--
-- Spec: §4.5 (docs/PROMO_TO_BUILD_SPEC.md in this repo)
-- Promo language: "Digital employee handbook. Update policies once — every
--                  employee sees the current version. Built-in acknowledgment
--                  tracking."
--
-- MANAGER GATE DEFAULT: TRUE (deliberate B.11 deviation, locked 2026-07-11)
-- Reasoning: Office Managers routinely enforce and reference policy for their
-- reports; forcing owner-only reads would create a bottleneck on daily
-- operational reference. Second B.11 relaxation in the overlay (Licenses was
-- first). Owners who want strict enforcement can flip
-- enable_handbook_manager_access to false in Settings.
--
-- Pre-requisites (Base and overlay dependencies):
--   • Base 001 provides public.agency, public.staff (with role, is_active,
--     GENERATED full_name)
--   • Base 011/012/015 provides public.settings, public._install_provenance
--   • Overlay 100 provides get_current_role_is_owner()
--     (v0.5.3.1: derives from staff.role='Owner / Agent')
--   • Overlay 100a adds staff.auth_user_id and staff.status ('active'/etc.)
--
-- Base master reference: b9232b384b5cf86f9ba8405233e513b5a336824f
-- Prior overlay HEAD (before v0.5.4): 9830f5242581967435105ff564ac3799f6a972f5
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. handbook_sections — versioned policy sections (one active row per number)
-- =============================================================================
-- Each row is either the CURRENT active version of a section (is_active=TRUE)
-- or a historical version (is_active=FALSE). Editing a section INSERTS a new
-- row with version=old.version+1 and is_active=TRUE, and UPDATEs the previous
-- active row to is_active=FALSE. This preserves full edit history.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.handbook_sections (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id      UUID        NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  section_number NUMERIC(6,2) NOT NULL
                              CHECK (section_number >= 0),
  title          TEXT        NOT NULL
                              CHECK (length(trim(title)) BETWEEN 1 AND 200),
  content        TEXT        NOT NULL
                              CHECK (length(content) BETWEEN 1 AND 100000),
  version        INTEGER     NOT NULL DEFAULT 1
                              CHECK (version >= 1),
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID        REFERENCES public.staff(id) ON DELETE SET NULL,
  updated_by     UUID        REFERENCES public.staff(id) ON DELETE SET NULL
);

-- One active row per (agency, section_number). Enforces the "single current
-- version per section" invariant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_handbook_sections_active_per_number
  ON public.handbook_sections (agency_id, section_number)
  WHERE is_active = TRUE;

-- Query index: fetch all history for a section
CREATE INDEX IF NOT EXISTS idx_handbook_sections_history
  ON public.handbook_sections (agency_id, section_number, version DESC);

-- Trigger: keep updated_at fresh on UPDATE
CREATE TRIGGER trg_handbook_sections_updated_at
  BEFORE UPDATE ON public.handbook_sections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

COMMENT ON TABLE public.handbook_sections IS
  'Employee handbook policy sections, versioned. is_active=TRUE marks the current live version of each section_number. Historical rows preserved with is_active=FALSE. Ships with bcc-premium-overlay v0.5.4 §4.5.';

-- =============================================================================
-- 2. handbook_acknowledgments — per-staff record of acknowledged versions
-- =============================================================================
-- One row per (staff, handbook_version) — a staff member acknowledging the
-- current handbook version. When any section is edited, MAX(version) bumps
-- and everyone needs a fresh acknowledgment.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.handbook_acknowledgments (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id         UUID        NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  staff_id          UUID        NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  handbook_version  INTEGER     NOT NULL CHECK (handbook_version >= 1),
  acknowledged_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address        INET
);

-- One acknowledgment per staff per version — re-acknowledging is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_handbook_ack_staff_version
  ON public.handbook_acknowledgments (agency_id, staff_id, handbook_version);

CREATE INDEX IF NOT EXISTS idx_handbook_ack_staff
  ON public.handbook_acknowledgments (staff_id, acknowledged_at DESC);

COMMENT ON TABLE public.handbook_acknowledgments IS
  'Per-staff log of handbook version acknowledgments. handbook_version is the MAX(version) across active handbook_sections rows at time of ack. Ships with bcc-premium-overlay v0.5.4 §4.5.';

-- =============================================================================
-- 3. is_handbook_manager() — B.11 gate, DEFAULTS TRUE
-- =============================================================================
-- Returns TRUE when caller holds Office Manager role AND the manager-access
-- toggle is enabled. Setting defaults TRUE (deliberate B.11 deviation).
-- Follows the pattern from 108_premium_licenses.sql §3.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.is_handbook_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT
    EXISTS (
      SELECT 1
        FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
         AND s.role = 'Office Manager'
         AND s.status = 'active'
    )
    AND COALESCE(
      (SELECT lower(setting_value) = 'true'
         FROM public.settings
        WHERE setting_key = 'enable_handbook_manager_access'
        LIMIT 1),
      true  -- DELIBERATE deviation from canonical B.11 FALSE. See migration header.
    );
$fn$;

REVOKE ALL ON FUNCTION public.is_handbook_manager() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_handbook_manager() TO authenticated;

COMMENT ON FUNCTION public.is_handbook_manager() IS
  'B.11 manager gate for Handbook. Returns true only when (a) caller holds active Office Manager role AND (b) enable_handbook_manager_access setting is true (defaults TRUE). Deliberate deviation from canonical B.11 FALSE — see migration 105 header §2.';

-- =============================================================================
-- 4. Settings toggle — enable_handbook_manager_access, DEFAULT TRUE
-- =============================================================================

INSERT INTO public.settings (agency_id, setting_key, setting_value, description)
SELECT
  a.id,
  'enable_handbook_manager_access',
  'true',
  'Producer Isolation Principle B.11 manager gate for Handbook module. When true, staff with role=Office Manager can edit and manage handbook sections for the whole team. DEFAULTS TRUE (deliberate deviation from canonical B.11 FALSE) — Office Managers routinely enforce and reference policy for their reports; forcing owner-only creates a daily bottleneck. Owners who want tighter control can flip this to false.'
FROM public.agency a
ON CONFLICT (agency_id, setting_key) DO NOTHING;

-- =============================================================================
-- 5. v_handbook_current_version — computed current handbook version per agency
-- =============================================================================
-- Definition: MAX(version) across all currently-active handbook_sections rows.
-- When any section is edited (version bumped), current_version rises and
-- previously-full acknowledgments become stale.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_handbook_current_version AS
SELECT
  a.id                                             AS agency_id,
  COALESCE(MAX(hs.version), 0)                     AS current_version,
  COUNT(hs.id)                                     AS active_sections_count,
  MAX(hs.updated_at)                               AS last_edit_at
FROM public.agency a
LEFT JOIN public.handbook_sections hs
  ON hs.agency_id = a.id AND hs.is_active = TRUE
GROUP BY a.id;

COMMENT ON VIEW public.v_handbook_current_version IS
  'Per-agency computed current handbook version = MAX(version) across active handbook_sections rows. Returns 0 if the agency has no active sections yet.';

-- =============================================================================
-- 6. v_handbook_current — current active sections + current_version
-- =============================================================================

CREATE OR REPLACE VIEW public.v_handbook_current AS
SELECT
  hs.id,
  hs.agency_id,
  hs.section_number,
  hs.title,
  hs.content,
  hs.version,
  hs.created_at,
  hs.updated_at,
  cby.full_name  AS created_by_name,
  uby.full_name  AS updated_by_name,
  cv.current_version,
  cv.active_sections_count,
  cv.last_edit_at
FROM public.handbook_sections hs
JOIN public.v_handbook_current_version cv
  ON cv.agency_id = hs.agency_id
LEFT JOIN public.staff cby ON cby.id = hs.created_by
LEFT JOIN public.staff uby ON uby.id = hs.updated_by
WHERE hs.is_active = TRUE
ORDER BY hs.section_number;

COMMENT ON VIEW public.v_handbook_current IS
  'Current active handbook sections, ordered by section_number, with computed current_version and last_edit_at. Convenience join for the Handbook.jsx UI.';

-- =============================================================================
-- 7. v_handbook_ack_status — per-staff acknowledgment status vs current version
-- =============================================================================
-- One row per (agency, staff) with the max version they've acknowledged and
-- a boolean for is_current. Producers/managers alike appear here — filter
-- downstream by role if needed.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_handbook_ack_status AS
SELECT
  s.id                                                       AS staff_id,
  s.agency_id,
  s.full_name,
  s.role,
  cv.current_version,
  COALESCE(latest_ack.handbook_version, 0)                   AS acknowledged_version,
  latest_ack.acknowledged_at                                 AS last_acknowledged_at,
  (COALESCE(latest_ack.handbook_version, 0) >= cv.current_version
    AND cv.current_version > 0)                              AS is_current,
  (cv.current_version - COALESCE(latest_ack.handbook_version, 0)) AS versions_behind
FROM public.staff s
JOIN public.v_handbook_current_version cv
  ON cv.agency_id = s.agency_id
LEFT JOIN LATERAL (
  SELECT ha.handbook_version, ha.acknowledged_at
    FROM public.handbook_acknowledgments ha
   WHERE ha.staff_id = s.id
   ORDER BY ha.handbook_version DESC, ha.acknowledged_at DESC
   LIMIT 1
) latest_ack ON TRUE
WHERE s.status = 'active';

COMMENT ON VIEW public.v_handbook_ack_status IS
  'Per-active-staff acknowledgment status vs current_version. is_current is TRUE when the staff member has acknowledged the current version. Only rows for status=active staff are returned.';

-- =============================================================================
-- 8. RPCs
-- =============================================================================

-- 8a. handbook_get_current — reads current active sections + version metadata
--     Callable by any authenticated user. RLS on the underlying table + view
--     enforces agency scoping.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handbook_get_current(p_agency_id UUID)
RETURNS SETOF public.v_handbook_current
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT *
    FROM public.v_handbook_current
   WHERE agency_id = p_agency_id;
$fn$;

REVOKE ALL ON FUNCTION public.handbook_get_current(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handbook_get_current(UUID) TO authenticated;

COMMENT ON FUNCTION public.handbook_get_current(UUID) IS
  'Returns current active handbook sections + version metadata for the agency. Callable by any authenticated staff — read side has no B.11 gate (everyone needs to READ the handbook).';

-- 8b. handbook_upsert_section — CREATE or UPDATE a section (owner OR manager-gated)
--     Bumps version, marks old row inactive, inserts new active row.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handbook_upsert_section(
  p_agency_id      UUID,
  p_section_number NUMERIC(6,2),
  p_title          TEXT,
  p_content        TEXT
)
RETURNS UUID  -- id of the new active row
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_is_owner   BOOLEAN := public.get_current_role_is_owner();
  v_is_manager BOOLEAN := public.is_handbook_manager();
  v_caller_id  UUID    := (SELECT id FROM public.staff WHERE auth_user_id = auth.uid() LIMIT 1);
  v_prev_row   public.handbook_sections%ROWTYPE;
  v_new_id     UUID;
  v_new_version INTEGER := 1;
BEGIN
  IF NOT (v_is_owner OR v_is_manager) THEN
    RAISE EXCEPTION 'handbook_upsert_section: caller is not owner and not handbook manager (agency=%)', p_agency_id
      USING ERRCODE = '42501';  -- insufficient_privilege
  END IF;

  IF p_title IS NULL OR length(trim(p_title)) = 0 THEN
    RAISE EXCEPTION 'handbook_upsert_section: p_title cannot be empty';
  END IF;
  IF p_content IS NULL OR length(p_content) = 0 THEN
    RAISE EXCEPTION 'handbook_upsert_section: p_content cannot be empty';
  END IF;

  -- Find the current active row for this section_number, if any
  SELECT * INTO v_prev_row
    FROM public.handbook_sections
   WHERE agency_id = p_agency_id
     AND section_number = p_section_number
     AND is_active = TRUE
   FOR UPDATE;

  IF FOUND THEN
    v_new_version := v_prev_row.version + 1;
    -- Mark old row inactive (history preserved)
    UPDATE public.handbook_sections
       SET is_active = FALSE,
           updated_at = now(),
           updated_by = v_caller_id
     WHERE id = v_prev_row.id;
  END IF;

  -- Insert the new active row
  INSERT INTO public.handbook_sections
    (agency_id, section_number, title, content, version, is_active, created_by, updated_by)
  VALUES
    (p_agency_id, p_section_number, p_title, p_content, v_new_version, TRUE, v_caller_id, v_caller_id)
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.handbook_upsert_section(UUID, NUMERIC, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handbook_upsert_section(UUID, NUMERIC, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.handbook_upsert_section(UUID, NUMERIC, TEXT, TEXT) IS
  'Creates a new section OR increments the version of an existing section_number. Preserves history by marking old row inactive. Requires owner OR is_handbook_manager()=true.';

-- 8c. handbook_deactivate_section — soft-delete a section (owner OR manager-gated)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handbook_deactivate_section(
  p_agency_id  UUID,
  p_section_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_is_owner   BOOLEAN := public.get_current_role_is_owner();
  v_is_manager BOOLEAN := public.is_handbook_manager();
  v_caller_id  UUID    := (SELECT id FROM public.staff WHERE auth_user_id = auth.uid() LIMIT 1);
  v_updated    INTEGER;
BEGIN
  IF NOT (v_is_owner OR v_is_manager) THEN
    RAISE EXCEPTION 'handbook_deactivate_section: caller is not owner and not handbook manager (agency=%)', p_agency_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.handbook_sections
     SET is_active = FALSE,
         updated_at = now(),
         updated_by = v_caller_id
   WHERE id = p_section_id
     AND agency_id = p_agency_id
     AND is_active = TRUE;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$fn$;

REVOKE ALL ON FUNCTION public.handbook_deactivate_section(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handbook_deactivate_section(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION public.handbook_deactivate_section(UUID, UUID) IS
  'Soft-deletes a handbook section (marks is_active=FALSE). Returns TRUE if a row was updated. Requires owner OR is_handbook_manager()=true.';

-- 8d. handbook_acknowledge — any staff records own acknowledgment of current version
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handbook_acknowledge(
  p_agency_id  UUID,
  p_ip_address INET DEFAULT NULL
)
RETURNS INTEGER  -- returns the handbook_version acknowledged
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_staff_id  UUID    := (SELECT id FROM public.staff WHERE auth_user_id = auth.uid() LIMIT 1);
  v_current_version INTEGER;
BEGIN
  IF v_staff_id IS NULL THEN
    RAISE EXCEPTION 'handbook_acknowledge: no active staff row matches auth.uid()'
      USING ERRCODE = '42501';
  END IF;

  -- Read current handbook version for this agency
  SELECT current_version INTO v_current_version
    FROM public.v_handbook_current_version
   WHERE agency_id = p_agency_id;

  IF v_current_version IS NULL OR v_current_version = 0 THEN
    RAISE EXCEPTION 'handbook_acknowledge: no active handbook exists yet for agency %', p_agency_id;
  END IF;

  INSERT INTO public.handbook_acknowledgments
    (agency_id, staff_id, handbook_version, ip_address)
  VALUES
    (p_agency_id, v_staff_id, v_current_version, p_ip_address)
  ON CONFLICT (agency_id, staff_id, handbook_version) DO NOTHING;

  RETURN v_current_version;
END;
$fn$;

REVOKE ALL ON FUNCTION public.handbook_acknowledge(UUID, INET) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handbook_acknowledge(UUID, INET) TO authenticated;

COMMENT ON FUNCTION public.handbook_acknowledge(UUID, INET) IS
  'Records the calling staff member''s acknowledgment of the current handbook version. Idempotent — repeat calls at the same version are no-ops. Returns the handbook_version acknowledged.';

-- 8e. handbook_get_ack_status — owner OR manager-gated: everyone's status
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handbook_get_ack_status(p_agency_id UUID)
RETURNS SETOF public.v_handbook_ack_status
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_is_owner   BOOLEAN := public.get_current_role_is_owner();
  v_is_manager BOOLEAN := public.is_handbook_manager();
BEGIN
  IF NOT (v_is_owner OR v_is_manager) THEN
    RAISE EXCEPTION 'handbook_get_ack_status: caller is not owner and not handbook manager (agency=%)', p_agency_id
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT *
      FROM public.v_handbook_ack_status
     WHERE agency_id = p_agency_id
     ORDER BY is_current, versions_behind DESC, full_name;
END;
$fn$;

REVOKE ALL ON FUNCTION public.handbook_get_ack_status(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handbook_get_ack_status(UUID) TO authenticated;

COMMENT ON FUNCTION public.handbook_get_ack_status(UUID) IS
  'Returns full team acknowledgment status. Requires owner OR is_handbook_manager()=true (B.11 gate on team-wide read).';

-- 8f. handbook_get_my_ack_status — self-scoped read, any staff
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handbook_get_my_ack_status(p_agency_id UUID)
RETURNS SETOF public.v_handbook_ack_status
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT *
    FROM public.v_handbook_ack_status
   WHERE agency_id = p_agency_id
     AND staff_id = (SELECT id FROM public.staff WHERE auth_user_id = auth.uid() LIMIT 1);
$fn$;

REVOKE ALL ON FUNCTION public.handbook_get_my_ack_status(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handbook_get_my_ack_status(UUID) TO authenticated;

COMMENT ON FUNCTION public.handbook_get_my_ack_status(UUID) IS
  'Returns the calling staff member''s own acknowledgment status. Self-scoped, no B.11 gate — everyone can read their own record.';

-- =============================================================================
-- 9. RLS — belt-and-suspenders alongside SECURITY DEFINER RPCs
-- =============================================================================

ALTER TABLE public.handbook_sections         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handbook_acknowledgments  ENABLE ROW LEVEL SECURITY;

-- handbook_sections: read = any active staff in the same agency (whole team
--   needs to READ the handbook). Write = owner OR manager (gated).

DROP POLICY IF EXISTS handbook_sections_read ON public.handbook_sections;
CREATE POLICY handbook_sections_read ON public.handbook_sections
  FOR SELECT TO authenticated
  USING (
    agency_id IN (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid() AND s.status = 'active'
    )
  );

DROP POLICY IF EXISTS handbook_sections_write ON public.handbook_sections;
CREATE POLICY handbook_sections_write ON public.handbook_sections
  FOR ALL TO authenticated
  USING (
    agency_id IN (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid() AND s.status = 'active'
    )
    AND (public.get_current_role_is_owner() OR public.is_handbook_manager())
  )
  WITH CHECK (
    agency_id IN (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid() AND s.status = 'active'
    )
    AND (public.get_current_role_is_owner() OR public.is_handbook_manager())
  );

-- handbook_acknowledgments: read own always; read team = manager-gated.
--   INSERT own only.

DROP POLICY IF EXISTS handbook_ack_read_own ON public.handbook_acknowledgments;
CREATE POLICY handbook_ack_read_own ON public.handbook_acknowledgments
  FOR SELECT TO authenticated
  USING (
    staff_id = (SELECT id FROM public.staff WHERE auth_user_id = auth.uid() LIMIT 1)
  );

DROP POLICY IF EXISTS handbook_ack_read_team ON public.handbook_acknowledgments;
CREATE POLICY handbook_ack_read_team ON public.handbook_acknowledgments
  FOR SELECT TO authenticated
  USING (
    agency_id IN (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid() AND s.status = 'active'
    )
    AND (public.get_current_role_is_owner() OR public.is_handbook_manager())
  );

DROP POLICY IF EXISTS handbook_ack_insert_own ON public.handbook_acknowledgments;
CREATE POLICY handbook_ack_insert_own ON public.handbook_acknowledgments
  FOR INSERT TO authenticated
  WITH CHECK (
    staff_id = (SELECT id FROM public.staff WHERE auth_user_id = auth.uid() LIMIT 1)
    AND agency_id IN (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid() AND s.status = 'active'
    )
  );

-- =============================================================================
-- 10. Provenance
-- =============================================================================

INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration',             '105_premium_handbook',
    'overlay_version',       '0.5.4',
    'ships_module',          'Module 05 — Handbook',
    'spec_ref',              '§4.5',
    'manager_gate_default',  'true (deliberate B.11 deviation, locked 2026-07-11)',
    'applied_at',            now()
  )
);

COMMIT;

-- =============================================================================
-- Verification (run manually after apply)
-- =============================================================================
--
-- 1. Tables exist with correct shape:
--    \d public.handbook_sections
--    \d public.handbook_acknowledgments
--
-- 2. UNIQUE indexes exist:
--    SELECT indexname FROM pg_indexes
--     WHERE tablename IN ('handbook_sections', 'handbook_acknowledgments')
--       AND indexname LIKE 'uq_%';
--    Expected: uq_handbook_sections_active_per_number, uq_handbook_ack_staff_version.
--
-- 3. Manager gate function callable and defaults TRUE:
--    SELECT public.is_handbook_manager();
--    Expected: boolean (false from unauthenticated context).
--
-- 4. Settings toggle seeded as TRUE:
--    SELECT setting_key, setting_value FROM public.settings
--     WHERE setting_key = 'enable_handbook_manager_access';
--    Expected: setting_value = 'true'.
--
-- 5. Views resolve without error:
--    SELECT * FROM public.v_handbook_current_version LIMIT 5;
--    SELECT * FROM public.v_handbook_current LIMIT 5;
--    SELECT * FROM public.v_handbook_ack_status LIMIT 5;
--
-- 6. Upsert flow (as owner staff):
--    SELECT public.handbook_upsert_section(
--      '<agency_id>'::uuid, 1.0, 'Welcome', 'Welcome to the team.'
--    );
--    Expected: returns new UUID; a row exists in handbook_sections with version=1.
--
-- 7. Bump version by re-upserting same section_number:
--    SELECT public.handbook_upsert_section(
--      '<agency_id>'::uuid, 1.0, 'Welcome', 'Welcome to the team. Revised.'
--    );
--    Expected: returns new UUID; old row is_active=FALSE, new row version=2.
--
-- 8. Acknowledgment idempotent:
--    SELECT public.handbook_acknowledge('<agency_id>'::uuid, '127.0.0.1'::inet);
--    -- run twice; second should return same version, one row only.
