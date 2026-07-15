-- =============================================================================
-- 106_premium_benefits.sql — Module 06 (Benefits) — bcc-premium-overlay v0.5.4
-- =============================================================================
-- Ships:
--   • public.benefit_plans               — available benefit offerings
--   • public.benefit_enrollments         — per-staff elections (comp-adjacent PII)
--   • public.is_benefits_manager()       — B.11 gate function
--   • public.settings row                — enable_benefits_manager_access
--   • public.v_benefit_plans_active      — currently active plans
--   • public.v_benefits_enrollment_summary — participation stats per plan
--   • public.v_benefits_my_enrollments   — self-scoped view
--   • RPCs:
--       benefits_get_active_plans(p_agency_id)
--       benefits_upsert_plan(p_agency_id, p_plan_name, p_plan_type, p_carrier,
--                            p_effective_date, p_end_date)
--       benefits_deactivate_plan(p_agency_id, p_plan_id)
--       benefits_upsert_enrollment(p_agency_id, p_staff_id, p_plan_id,
--                                  p_enrollment_tier, p_election_amount,
--                                  p_effective_date, p_end_date)
--       benefits_end_enrollment(p_agency_id, p_enrollment_id, p_end_date)
--       benefits_get_enrollment_summary(p_agency_id)
--       benefits_get_my_enrollments(p_agency_id)
--
-- Spec: §4.6 (docs/PROMO_TO_BUILD_SPEC.md in this repo)
-- Promo language: "Employee benefits enrollment and tracking. Health, dental,
--                  retirement, and voluntary elections in one place."
--
-- MANAGER GATE DEFAULT: FALSE (canonical B.11 — comp-adjacent PII)
-- Reasoning: Benefits enrollment carries deduction amounts, plan-tier signals
-- family status, and (via dependents follow-on) life-insurance beneficiary
-- data. Office Managers routinely need PTO/licensing data operationally, but
-- benefits PII is a different compliance domain — closer to payroll than to
-- daily operations. Manager help routes through the owner. Owners who want
-- delegated benefits admin can flip enable_benefits_manager_access to true.
--
-- Dependents note (spec §4.6): Spouse/child records are deliberately DEFERRED
-- to a follow-on migration (106a_premium_benefit_dependents.sql if/when
-- needed). The v1 tables here support enrollment_tier only — enough to model
-- coverage level without storing dependent PII.
--
-- Pre-requisites (Base and overlay dependencies):
--   • Base 001 provides public.agency, public.staff (with role, is_active,
--     first_name, last_name)
--   • Base 011/012/015 provides public.settings, public.update_updated_at()
--   • Base 000 provides public._install_provenance (extended by overlay 100)
--   • Overlay 100 provides get_current_role_is_owner() + staff.full_name
--     GENERATED column
--   • Overlay 100a adds staff.auth_user_id and staff.status
--
-- Base master reference: 0fb2be204e6df18bfe5a40ec3d227f3caa31cac1
-- Prior overlay HEAD (before this migration): 0768ba5ec7bcd7b7feb8a1b9ae6c039e27e77a49
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. benefit_plans — available benefit offerings
-- =============================================================================
-- One row per plan the agency offers. is_active flags currently-open enrollment
-- eligibility. effective_date / end_date bound the plan year(s) it covers.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.benefit_plans (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id      UUID        NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  plan_name      TEXT        NOT NULL
                              CHECK (length(trim(plan_name)) BETWEEN 1 AND 200),
  plan_type      TEXT        NOT NULL
                              CHECK (plan_type IN
                                ('health','dental','vision','retirement','life',
                                 'disability','voluntary','other')),
  carrier        TEXT        CHECK (carrier IS NULL OR length(trim(carrier)) BETWEEN 1 AND 200),
  effective_date DATE        NOT NULL,
  end_date       DATE        CHECK (end_date IS NULL OR end_date >= effective_date),
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID        REFERENCES public.staff(id) ON DELETE SET NULL,
  updated_by     UUID        REFERENCES public.staff(id) ON DELETE SET NULL
);

-- Uniqueness: within an agency + plan_type, one active plan per plan_name.
-- (A plan can be re-created with the same name in a later year — that's a NEW
-- row with is_active=TRUE and the previous row set to is_active=FALSE.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_benefit_plans_active_name_type
  ON public.benefit_plans (agency_id, plan_type, plan_name)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_benefit_plans_type
  ON public.benefit_plans (agency_id, plan_type, is_active);

CREATE TRIGGER trg_benefit_plans_updated_at
  BEFORE UPDATE ON public.benefit_plans
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

COMMENT ON TABLE public.benefit_plans IS
  'Employee benefit plan offerings (health/dental/vision/retirement/life/disability/voluntary). One active row per (agency, plan_type, plan_name). Ships with bcc-premium-overlay v0.5.4 §4.6.';

-- =============================================================================
-- 2. benefit_enrollments — per-staff elections
-- =============================================================================
-- One row per (staff, plan) enrollment. Historical enrollments have end_date
-- set; currently-active enrollments have end_date IS NULL. election_amount
-- captures the per-pay-period deduction (or contribution) tied to this
-- election.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.benefit_enrollments (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id         UUID          NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  staff_id          UUID          NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  plan_id           UUID          NOT NULL REFERENCES public.benefit_plans(id) ON DELETE RESTRICT,
  enrollment_tier   TEXT          NOT NULL
                                  CHECK (enrollment_tier IN
                                    ('employee_only','employee_plus_spouse',
                                     'employee_plus_children','family',
                                     'waived')),
  election_amount   NUMERIC(10,2) NOT NULL DEFAULT 0
                                  CHECK (election_amount >= 0),
  effective_date    DATE          NOT NULL,
  end_date          DATE          CHECK (end_date IS NULL OR end_date >= effective_date),
  notes             TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by        UUID          REFERENCES public.staff(id) ON DELETE SET NULL,
  updated_by        UUID          REFERENCES public.staff(id) ON DELETE SET NULL
);

-- One active enrollment per (staff, plan). Historical enrollments (end_date
-- set) don't participate in the UNIQUE — staff can re-enroll across years.
CREATE UNIQUE INDEX IF NOT EXISTS uq_benefit_enrollments_active_per_staff_plan
  ON public.benefit_enrollments (agency_id, staff_id, plan_id)
  WHERE end_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_benefit_enrollments_staff
  ON public.benefit_enrollments (staff_id, effective_date DESC);

CREATE INDEX IF NOT EXISTS idx_benefit_enrollments_plan
  ON public.benefit_enrollments (plan_id, effective_date DESC);

CREATE TRIGGER trg_benefit_enrollments_updated_at
  BEFORE UPDATE ON public.benefit_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

COMMENT ON TABLE public.benefit_enrollments IS
  'Per-staff benefit enrollments. Active enrollment has end_date IS NULL. election_amount is per-pay-period deduction/contribution. Comp-adjacent PII — B.11 canonical FALSE default on manager gate. Ships with bcc-premium-overlay v0.5.4 §4.6.';

-- =============================================================================
-- 3. is_benefits_manager() — B.11 gate, DEFAULTS FALSE (canonical)
-- =============================================================================
-- Returns TRUE only when caller holds Office Manager role AND the manager-access
-- toggle is enabled. Setting defaults FALSE (canonical B.11 for comp-adjacent
-- PII). Follows the pattern from 108_premium_licenses.sql §3 but with the
-- COALESCE default flipped.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.is_benefits_manager()
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
        WHERE setting_key = 'enable_benefits_manager_access'
        LIMIT 1),
      false  -- CANONICAL B.11 default. Comp-adjacent PII stays owner-only unless flipped.
    );
$fn$;

REVOKE ALL ON FUNCTION public.is_benefits_manager() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_benefits_manager() TO authenticated;

COMMENT ON FUNCTION public.is_benefits_manager() IS
  'B.11 manager gate for Benefits. Returns true only when (a) caller holds active Office Manager role AND (b) enable_benefits_manager_access setting is true (defaults FALSE — canonical B.11 for comp-adjacent PII).';

-- =============================================================================
-- 4. Settings toggle — enable_benefits_manager_access, DEFAULT FALSE
-- =============================================================================

INSERT INTO public.settings (agency_id, setting_key, setting_value, description)
SELECT
  a.id,
  'enable_benefits_manager_access',
  'false',
  'Producer Isolation Principle B.11 manager gate for Benefits module. When true, staff with role=Office Manager can view team enrollments and manage plans. DEFAULTS FALSE (canonical B.11) — benefits enrollment holds comp-adjacent PII (deduction amounts, coverage tier signals family status, dependents follow-on carries life-insurance beneficiaries). Manager assistance routes through the owner. Owners with a dedicated benefits admin on the manager team can flip this to true.'
FROM public.agency a
ON CONFLICT (agency_id, setting_key) DO NOTHING;

-- =============================================================================
-- 5. v_benefit_plans_active — currently offered plans
-- =============================================================================

CREATE OR REPLACE VIEW public.v_benefit_plans_active AS
SELECT
  bp.id,
  bp.agency_id,
  bp.plan_name,
  bp.plan_type,
  bp.carrier,
  bp.effective_date,
  bp.end_date,
  bp.notes,
  bp.created_at,
  bp.updated_at,
  cby.full_name  AS created_by_name,
  uby.full_name  AS updated_by_name
FROM public.benefit_plans bp
LEFT JOIN public.staff cby ON cby.id = bp.created_by
LEFT JOIN public.staff uby ON uby.id = bp.updated_by
WHERE bp.is_active = TRUE
  AND (bp.end_date IS NULL OR bp.end_date >= CURRENT_DATE)
ORDER BY bp.plan_type, bp.plan_name;

COMMENT ON VIEW public.v_benefit_plans_active IS
  'Currently active benefit plans (is_active=TRUE AND end_date >= today). Ordered by plan_type, plan_name for stable listing.';

-- =============================================================================
-- 6. v_benefits_enrollment_summary — participation stats per plan
-- =============================================================================
-- Owner-facing / manager-facing (when gate is on) roll-up: for each active
-- plan, how many enrollees, total election_amount, average, and unenrolled
-- eligible-staff count.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_benefits_enrollment_summary AS
WITH active_plans AS (
  SELECT id, agency_id, plan_name, plan_type, carrier
    FROM public.benefit_plans
   WHERE is_active = TRUE
     AND (end_date IS NULL OR end_date >= CURRENT_DATE)
),
active_enrollments AS (
  SELECT plan_id,
         staff_id,
         enrollment_tier,
         election_amount
    FROM public.benefit_enrollments
   WHERE end_date IS NULL
),
eligible_staff AS (
  SELECT agency_id, COUNT(*)::int AS eligible_count
    FROM public.staff
   WHERE status = 'active'
   GROUP BY agency_id
)
SELECT
  p.id                                                   AS plan_id,
  p.agency_id,
  p.plan_name,
  p.plan_type,
  p.carrier,
  COUNT(e.staff_id)::int                                        AS enrolled_count,
  COUNT(e.staff_id) FILTER (WHERE e.enrollment_tier = 'waived')::int   AS waived_count,
  COUNT(e.staff_id) FILTER (WHERE e.enrollment_tier <> 'waived')::int  AS active_enrolled_count,
  COALESCE(SUM(e.election_amount), 0)::numeric(12,2)     AS total_elections,
  COALESCE(AVG(e.election_amount), 0)::numeric(10,2)     AS avg_election,
  es.eligible_count,
  (es.eligible_count - COUNT(e.staff_id))::int           AS unenrolled_count
FROM active_plans p
LEFT JOIN active_enrollments e ON e.plan_id = p.id
LEFT JOIN eligible_staff es    ON es.agency_id = p.agency_id
GROUP BY p.id, p.agency_id, p.plan_name, p.plan_type, p.carrier, es.eligible_count
ORDER BY p.plan_type, p.plan_name;

COMMENT ON VIEW public.v_benefits_enrollment_summary IS
  'Per-plan participation stats: enrolled/waived counts, total and average elections, unenrolled eligible-staff count. Gated for team-wide read via RPC.';

-- =============================================================================
-- 7. v_benefits_my_enrollments — self-scoped enrollments view
-- =============================================================================

CREATE OR REPLACE VIEW public.v_benefits_my_enrollments AS
SELECT
  be.id                    AS enrollment_id,
  be.agency_id,
  be.staff_id,
  s.full_name              AS staff_name,
  be.plan_id,
  bp.plan_name,
  bp.plan_type,
  bp.carrier,
  be.enrollment_tier,
  be.election_amount,
  be.effective_date,
  be.end_date,
  (be.end_date IS NULL)    AS is_active,
  be.notes,
  be.created_at,
  be.updated_at
FROM public.benefit_enrollments be
JOIN public.benefit_plans bp ON bp.id = be.plan_id
JOIN public.staff        s  ON s.id  = be.staff_id
ORDER BY be.effective_date DESC, bp.plan_type, bp.plan_name;

COMMENT ON VIEW public.v_benefits_my_enrollments IS
  'Enrollment detail joined to plan + staff. Filter by staff_id downstream — the "my" naming reflects the intended RPC usage (handbook_get_my_enrollments returns only WHERE staff_id = auth caller). Callable views cannot themselves auth-filter, so RLS on benefit_enrollments enforces access.';

-- =============================================================================
-- 8. RPCs
-- =============================================================================

-- 8a. benefits_get_active_plans — any authenticated staff can see what's offered
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.benefits_get_active_plans(p_agency_id UUID)
RETURNS SETOF public.v_benefit_plans_active
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT *
    FROM public.v_benefit_plans_active
   WHERE agency_id = p_agency_id;
$fn$;

REVOKE ALL ON FUNCTION public.benefits_get_active_plans(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.benefits_get_active_plans(UUID) TO authenticated;

COMMENT ON FUNCTION public.benefits_get_active_plans(UUID) IS
  'Returns currently-active benefit plans for the agency. Callable by any authenticated staff (they need to know what''s available even before enrolling).';

-- 8b. benefits_upsert_plan — owner OR manager (gated); creates or replaces
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.benefits_upsert_plan(
  p_agency_id      UUID,
  p_plan_name      TEXT,
  p_plan_type      TEXT,
  p_carrier        TEXT,
  p_effective_date DATE,
  p_end_date       DATE DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_is_owner   BOOLEAN := public.get_current_role_is_owner();
  v_is_manager BOOLEAN := public.is_benefits_manager();
  v_caller_id  UUID    := (SELECT id FROM public.staff WHERE auth_user_id = auth.uid() LIMIT 1);
  v_prev_id    UUID;
  v_new_id     UUID;
BEGIN
  IF NOT (v_is_owner OR v_is_manager) THEN
    RAISE EXCEPTION 'benefits_upsert_plan: caller is not owner and not benefits manager (agency=%)', p_agency_id
      USING ERRCODE = '42501';
  END IF;

  IF p_plan_name IS NULL OR length(trim(p_plan_name)) = 0 THEN
    RAISE EXCEPTION 'benefits_upsert_plan: p_plan_name cannot be empty';
  END IF;
  IF p_plan_type NOT IN ('health','dental','vision','retirement','life','disability','voluntary','other') THEN
    RAISE EXCEPTION 'benefits_upsert_plan: unknown plan_type %', p_plan_type;
  END IF;

  -- If an active plan with same (agency, plan_type, plan_name) exists, deactivate it
  SELECT id INTO v_prev_id
    FROM public.benefit_plans
   WHERE agency_id = p_agency_id
     AND plan_type = p_plan_type
     AND plan_name = p_plan_name
     AND is_active = TRUE
   FOR UPDATE;

  IF FOUND THEN
    UPDATE public.benefit_plans
       SET is_active  = FALSE,
           updated_at = now(),
           updated_by = v_caller_id
     WHERE id = v_prev_id;
  END IF;

  INSERT INTO public.benefit_plans
    (agency_id, plan_name, plan_type, carrier, effective_date, end_date, is_active, created_by, updated_by)
  VALUES
    (p_agency_id, p_plan_name, p_plan_type, p_carrier, p_effective_date, p_end_date, TRUE, v_caller_id, v_caller_id)
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.benefits_upsert_plan(UUID, TEXT, TEXT, TEXT, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.benefits_upsert_plan(UUID, TEXT, TEXT, TEXT, DATE, DATE) TO authenticated;

COMMENT ON FUNCTION public.benefits_upsert_plan(UUID, TEXT, TEXT, TEXT, DATE, DATE) IS
  'Creates a new plan OR replaces the currently-active plan with same (plan_type, plan_name). Requires owner OR is_benefits_manager()=true.';

-- 8c. benefits_deactivate_plan — owner OR manager-gated
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.benefits_deactivate_plan(
  p_agency_id UUID,
  p_plan_id   UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_is_owner   BOOLEAN := public.get_current_role_is_owner();
  v_is_manager BOOLEAN := public.is_benefits_manager();
  v_caller_id  UUID    := (SELECT id FROM public.staff WHERE auth_user_id = auth.uid() LIMIT 1);
  v_updated    INTEGER;
BEGIN
  IF NOT (v_is_owner OR v_is_manager) THEN
    RAISE EXCEPTION 'benefits_deactivate_plan: not authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE public.benefit_plans
     SET is_active  = FALSE,
         updated_at = now(),
         updated_by = v_caller_id
   WHERE id = p_plan_id
     AND agency_id = p_agency_id
     AND is_active = TRUE;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$fn$;

REVOKE ALL ON FUNCTION public.benefits_deactivate_plan(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.benefits_deactivate_plan(UUID, UUID) TO authenticated;

-- 8d. benefits_upsert_enrollment — owner OR manager (gated); enrolls staff
-- ----------------------------------------------------------------------------
-- Ends any currently-active enrollment for (staff, plan) and starts a new one.
-- This is the "election change" workflow — old election gets end_date=today,
-- new election gets effective_date=p_effective_date.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.benefits_upsert_enrollment(
  p_agency_id       UUID,
  p_staff_id        UUID,
  p_plan_id         UUID,
  p_enrollment_tier TEXT,
  p_election_amount NUMERIC(10,2),
  p_effective_date  DATE,
  p_end_date        DATE DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_is_owner   BOOLEAN := public.get_current_role_is_owner();
  v_is_manager BOOLEAN := public.is_benefits_manager();
  v_caller_id  UUID    := (SELECT id FROM public.staff WHERE auth_user_id = auth.uid() LIMIT 1);
  v_prev_id    UUID;
  v_new_id     UUID;
BEGIN
  IF NOT (v_is_owner OR v_is_manager) THEN
    RAISE EXCEPTION 'benefits_upsert_enrollment: caller is not owner and not benefits manager (agency=%)', p_agency_id
      USING ERRCODE = '42501';
  END IF;

  IF p_enrollment_tier NOT IN ('employee_only','employee_plus_spouse','employee_plus_children','family','waived') THEN
    RAISE EXCEPTION 'benefits_upsert_enrollment: unknown enrollment_tier %', p_enrollment_tier;
  END IF;

  -- End any currently-active enrollment for this (staff, plan)
  SELECT id INTO v_prev_id
    FROM public.benefit_enrollments
   WHERE agency_id = p_agency_id
     AND staff_id  = p_staff_id
     AND plan_id   = p_plan_id
     AND end_date IS NULL
   FOR UPDATE;

  IF FOUND THEN
    UPDATE public.benefit_enrollments
       SET end_date   = COALESCE(p_effective_date - INTERVAL '1 day', now())::date,
           updated_at = now(),
           updated_by = v_caller_id
     WHERE id = v_prev_id;
  END IF;

  INSERT INTO public.benefit_enrollments
    (agency_id, staff_id, plan_id, enrollment_tier, election_amount,
     effective_date, end_date, created_by, updated_by)
  VALUES
    (p_agency_id, p_staff_id, p_plan_id, p_enrollment_tier, p_election_amount,
     p_effective_date, p_end_date, v_caller_id, v_caller_id)
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.benefits_upsert_enrollment(UUID, UUID, UUID, TEXT, NUMERIC, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.benefits_upsert_enrollment(UUID, UUID, UUID, TEXT, NUMERIC, DATE, DATE) TO authenticated;

-- 8e. benefits_end_enrollment — owner OR manager (gated); sets end_date
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.benefits_end_enrollment(
  p_agency_id    UUID,
  p_enrollment_id UUID,
  p_end_date     DATE DEFAULT CURRENT_DATE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_is_owner   BOOLEAN := public.get_current_role_is_owner();
  v_is_manager BOOLEAN := public.is_benefits_manager();
  v_caller_id  UUID    := (SELECT id FROM public.staff WHERE auth_user_id = auth.uid() LIMIT 1);
  v_updated    INTEGER;
BEGIN
  IF NOT (v_is_owner OR v_is_manager) THEN
    RAISE EXCEPTION 'benefits_end_enrollment: not authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE public.benefit_enrollments
     SET end_date   = p_end_date,
         updated_at = now(),
         updated_by = v_caller_id
   WHERE id = p_enrollment_id
     AND agency_id = p_agency_id
     AND end_date IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$fn$;

REVOKE ALL ON FUNCTION public.benefits_end_enrollment(UUID, UUID, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.benefits_end_enrollment(UUID, UUID, DATE) TO authenticated;

-- 8f. benefits_get_enrollment_summary — owner OR manager gated
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.benefits_get_enrollment_summary(p_agency_id UUID)
RETURNS SETOF public.v_benefits_enrollment_summary
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_is_owner   BOOLEAN := public.get_current_role_is_owner();
  v_is_manager BOOLEAN := public.is_benefits_manager();
BEGIN
  IF NOT (v_is_owner OR v_is_manager) THEN
    RAISE EXCEPTION 'benefits_get_enrollment_summary: not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT *
      FROM public.v_benefits_enrollment_summary
     WHERE agency_id = p_agency_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.benefits_get_enrollment_summary(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.benefits_get_enrollment_summary(UUID) TO authenticated;

-- 8g. benefits_get_my_enrollments — self-scoped, any staff
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.benefits_get_my_enrollments(p_agency_id UUID)
RETURNS SETOF public.v_benefits_my_enrollments
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT *
    FROM public.v_benefits_my_enrollments
   WHERE agency_id = p_agency_id
     AND staff_id  = (SELECT id FROM public.staff WHERE auth_user_id = auth.uid() LIMIT 1);
$fn$;

REVOKE ALL ON FUNCTION public.benefits_get_my_enrollments(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.benefits_get_my_enrollments(UUID) TO authenticated;

COMMENT ON FUNCTION public.benefits_get_my_enrollments(UUID) IS
  'Returns the calling staff member''s benefit enrollments (self-scoped). No B.11 gate — everyone can read their own record.';

-- =============================================================================
-- 9. RLS — belt-and-suspenders alongside SECURITY DEFINER RPCs
-- =============================================================================

ALTER TABLE public.benefit_plans       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.benefit_enrollments ENABLE ROW LEVEL SECURITY;

-- benefit_plans: any authenticated agency staff can SEE offerings; only
--   owner/manager can WRITE.

DROP POLICY IF EXISTS benefit_plans_read ON public.benefit_plans;
CREATE POLICY benefit_plans_read ON public.benefit_plans
  FOR SELECT TO authenticated
  USING (
    agency_id IN (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid() AND s.status = 'active'
    )
  );

DROP POLICY IF EXISTS benefit_plans_write ON public.benefit_plans;
CREATE POLICY benefit_plans_write ON public.benefit_plans
  FOR ALL TO authenticated
  USING (
    agency_id IN (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid() AND s.status = 'active'
    )
    AND (public.get_current_role_is_owner() OR public.is_benefits_manager())
  )
  WITH CHECK (
    agency_id IN (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid() AND s.status = 'active'
    )
    AND (public.get_current_role_is_owner() OR public.is_benefits_manager())
  );

-- benefit_enrollments: read own always; read team = owner OR manager-gated.
--   Write = owner OR manager-gated (no self-writes — canonical B.11).

DROP POLICY IF EXISTS benefit_enrollments_read_own ON public.benefit_enrollments;
CREATE POLICY benefit_enrollments_read_own ON public.benefit_enrollments
  FOR SELECT TO authenticated
  USING (
    staff_id = (SELECT id FROM public.staff WHERE auth_user_id = auth.uid() LIMIT 1)
  );

DROP POLICY IF EXISTS benefit_enrollments_read_team ON public.benefit_enrollments;
CREATE POLICY benefit_enrollments_read_team ON public.benefit_enrollments
  FOR SELECT TO authenticated
  USING (
    agency_id IN (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid() AND s.status = 'active'
    )
    AND (public.get_current_role_is_owner() OR public.is_benefits_manager())
  );

DROP POLICY IF EXISTS benefit_enrollments_write ON public.benefit_enrollments;
CREATE POLICY benefit_enrollments_write ON public.benefit_enrollments
  FOR ALL TO authenticated
  USING (
    agency_id IN (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid() AND s.status = 'active'
    )
    AND (public.get_current_role_is_owner() OR public.is_benefits_manager())
  )
  WITH CHECK (
    agency_id IN (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid() AND s.status = 'active'
    )
    AND (public.get_current_role_is_owner() OR public.is_benefits_manager())
  );

-- =============================================================================
-- 10. Provenance
-- =============================================================================

INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration',             '106_premium_benefits',
    'overlay_version',       '0.5.4',
    'ships_module',          'Module 06 — Benefits',
    'spec_ref',              '§4.6',
    'manager_gate_default',  'false (canonical B.11 — comp-adjacent PII)',
    'dependents_deferred',   'true (spouse/child records deferred to 106a follow-on if needed)',
    'applied_at',            now()
  )
);

COMMIT;

-- =============================================================================
-- Verification (run manually after apply)
-- =============================================================================
--
-- 1. Tables exist:
--    \d public.benefit_plans
--    \d public.benefit_enrollments
--
-- 2. Manager gate defaults FALSE:
--    SELECT public.is_benefits_manager();
--    Expected: false (from unauthenticated context).
--
-- 3. Settings toggle seeded as FALSE:
--    SELECT setting_key, setting_value FROM public.settings
--     WHERE setting_key = 'enable_benefits_manager_access';
--    Expected: setting_value = 'false'.
--
-- 4. Upsert plan (as owner staff):
--    SELECT public.benefits_upsert_plan(
--      '<agency>'::uuid, 'BCBS PPO', 'health', 'BlueCross', '2026-01-01', '2026-12-31'
--    );
--    Expected: returns UUID; row exists in benefit_plans with is_active=TRUE.
--
-- 5. Enrollment flow (as owner staff, on behalf of a staff member):
--    SELECT public.benefits_upsert_enrollment(
--      '<agency>'::uuid, '<staff_id>'::uuid, '<plan_id>'::uuid,
--      'family', 425.00, '2026-01-01', NULL
--    );
--    Expected: returns UUID; row exists in benefit_enrollments with end_date IS NULL.
--
-- 6. Summary view returns row per plan:
--    SELECT plan_name, enrolled_count, total_elections, unenrolled_count
--      FROM public.v_benefits_enrollment_summary
--     WHERE agency_id = '<agency>'::uuid;
