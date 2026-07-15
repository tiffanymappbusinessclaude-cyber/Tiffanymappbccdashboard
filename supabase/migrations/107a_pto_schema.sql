-- ============================================================================
-- Migration 107a — Premium PTO: schema + RLS + is_pto_manager helper
-- ============================================================================
-- Overlay: bcc-premium-overlay
-- Version: v0.5
-- Runs BEFORE 107b (views + helpers) and 107c (RPCs). This migration
-- establishes every table, column, index, RLS policy, helper function,
-- and settings toggle that 107b and 107c assume already exist.
--
-- Depends on Base + overlay prerequisites:
--   • public.staff — Base ships (id, first_name, last_name, email, role,
--     start_date, end_date, is_active, ...); 100a adds status, auth_user_id,
--     hire_date; 100_base_compat_shim adds full_name as GENERATED column
--   • public.settings — Base ships (setting_key, setting_value, agency_id,
--     description, ...) with UNIQUE(agency_id, setting_key). This file
--     writes with agency_id sourced from public.agency.
--   • public._install_provenance — Base ships (install_id, entity,
--     master_head, ...); 100_base_compat_shim adds (event_type, event_data)
--     for overlay event-log rows and relaxes the NOT NULLs
--   • public.get_current_role_is_owner() — shipped by 100_base_compat_shim
--     as a wrapper over Base's is_current_user_owner() (022_team_access)
--   • public.current_staff_id() — shipped by 100e as an overlay shim
--   • auth.users, auth.uid() available (Supabase auth)
--
-- Producer Isolation Principle (B.11):
--   • pto_balances / pto_requests: producer sees own row only; owner sees
--     all; manager sees all only when is_pto_manager() returns true.
--   • pto_policies: readable to all authenticated (policies are not PII).
--   • Writes to all three tables go exclusively through SECURITY DEFINER
--     RPCs in 107c — no INSERT/UPDATE/DELETE policies on any of these
--     tables means implicit deny for direct writes.
--
-- Considered override of B.11 for THIS module only:
--   • enable_pto_manager_access defaults TRUE (not the canonical FALSE).
--     Rationale: in State Farm agencies, the office manager typically
--     runs PTO approvals in practice; forcing every owner to flip a
--     toggle post-install creates friction with no privacy upside for
--     the intended workflow. Owner may still set to false in Settings.
--
-- Idempotency:
--   • CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS (via DO block),
--     CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
--     DROP POLICY IF EXISTS + CREATE POLICY, ON CONFLICT DO NOTHING.
--   • Safe to re-apply after Base or Premium upgrades.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. pto_policies — agency PTO plans (flat, tiered, monthly, biweekly)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.pto_policies (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text          NOT NULL,
  accrual_pattern          text          NOT NULL
                                         CHECK (accrual_pattern IN ('anniversary','monthly','biweekly','unlimited')),
  -- Flat rate used by monthly/biweekly patterns. anniversary uses tenure_brackets
  -- if non-empty, else this scalar. unlimited ignores rate.
  accrual_rate_days        numeric(6,2),
  -- JSONB array of {years_min:int, days_per_year:numeric}, strictly ascending years_min.
  -- Validated at insert/update by public._pto_validate_tenure_brackets() (107b).
  tenure_brackets          jsonb         NOT NULL DEFAULT '[]'::jsonb,
  accrual_start_basis      text          NOT NULL DEFAULT 'hire_date'
                                         CHECK (accrual_start_basis IN ('hire_date','waiting_period_end')),
  waiting_period_days      integer       NOT NULL DEFAULT 0
                                         CHECK (waiting_period_days >= 0),
  carryover_type           text          NOT NULL DEFAULT 'use_it_or_lose_it'
                                         CHECK (carryover_type IN ('use_it_or_lose_it','unlimited','capped')),
  carryover_cap_days       numeric(6,2)  CHECK (carryover_cap_days IS NULL OR carryover_cap_days >= 0),
  reset_anchor             text          NOT NULL DEFAULT 'anniversary'
                                         CHECK (reset_anchor IN ('anniversary','calendar_year','fiscal_year_start')),
  fiscal_year_start_month  integer       CHECK (fiscal_year_start_month IS NULL
                                                OR fiscal_year_start_month BETWEEN 1 AND 12),
  is_active                boolean       NOT NULL DEFAULT true,
  created_by               uuid          REFERENCES auth.users(id),
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),

  -- Consistency: monthly/biweekly patterns require an explicit rate
  CONSTRAINT pto_policies_rate_required_for_periodic
    CHECK (accrual_pattern NOT IN ('monthly','biweekly') OR accrual_rate_days IS NOT NULL),

  -- Consistency: capped carryover requires a cap
  CONSTRAINT pto_policies_capped_requires_cap
    CHECK (carryover_type <> 'capped' OR carryover_cap_days IS NOT NULL),

  -- Consistency: fiscal_year_start reset requires a starting month
  CONSTRAINT pto_policies_fiscal_requires_month
    CHECK (reset_anchor <> 'fiscal_year_start' OR fiscal_year_start_month IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_pto_policies_active
  ON public.pto_policies(is_active) WHERE is_active = true;

COMMENT ON TABLE public.pto_policies IS
  'Agency PTO policy definitions. Referenced by staff.pto_policy_id. Multiple policies supported (e.g., producer vs office manager plans, or tenure-based tiers on one plan via tenure_brackets jsonb). Writes exclusively through rpc_upsert_pto_policy in 107c.';

-- ============================================================================
-- 2. staff.pto_policy_id — link column added to Base staff table
-- ============================================================================
-- Idempotent column-add. FK constraint added inline since pto_policies now
-- exists. On policy delete, staff row is preserved but unlinked.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'staff'
      AND column_name  = 'pto_policy_id'
  ) THEN
    ALTER TABLE public.staff
      ADD COLUMN pto_policy_id uuid REFERENCES public.pto_policies(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_staff_pto_policy_id
  ON public.staff(pto_policy_id) WHERE pto_policy_id IS NOT NULL;

-- ============================================================================
-- 3. pto_balances — current period balance per staff member
-- ============================================================================
-- One row per (staff_id, period_start). Cron creates a new row when period
-- rolls over, seeded with carried_over_from_prior. Approve trigger decrements
-- balance_days and increments used_this_period atomically (in RPC 107c).

CREATE TABLE IF NOT EXISTS public.pto_balances (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id                 uuid          NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  policy_id                uuid          REFERENCES public.pto_policies(id) ON DELETE SET NULL,
  period_start             date          NOT NULL,
  period_end               date          NOT NULL,
  balance_days             numeric(7,2)  NOT NULL DEFAULT 0,
  accrued_this_period      numeric(7,2)  NOT NULL DEFAULT 0,
  used_this_period         numeric(7,2)  NOT NULL DEFAULT 0,
  carried_over_from_prior  numeric(7,2)  NOT NULL DEFAULT 0,
  last_accrual_date        date,
  notes                    text,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT pto_balances_period_ordered   CHECK (period_end >= period_start),
  CONSTRAINT pto_balances_one_row_per_period UNIQUE (staff_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_pto_balances_staff_current
  ON public.pto_balances(staff_id, period_start DESC);

COMMENT ON TABLE public.pto_balances IS
  'Current-period PTO balance per staff. Updated by rpc_approve_pto_request (decrement) and rpc_run_nightly_pto_accrual (accrual). Historical periods preserved as separate rows for audit.';

-- ============================================================================
-- 4. pto_requests — request lifecycle + full audit trail
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.pto_requests (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id                 uuid          NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  request_type             text          NOT NULL DEFAULT 'pto'
                                         CHECK (request_type IN ('pto','sick','personal','bereavement','other')),
  start_date               date          NOT NULL,
  end_date                 date          NOT NULL,
  is_half_day              boolean       NOT NULL DEFAULT false,
  half_day_period          text          CHECK (half_day_period IS NULL OR half_day_period IN ('am','pm')),
  total_days               numeric(5,2)  NOT NULL CHECK (total_days > 0),
  reason                   text,
  status                   text          NOT NULL DEFAULT 'pending'
                                         CHECK (status IN ('pending','approved','denied','cancelled')),
  approved_by              uuid          REFERENCES auth.users(id),
  approved_at              timestamptz,
  decline_reason           text,
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT pto_requests_dates_ordered
    CHECK (end_date >= start_date),

  -- Half-day requests must be single-day with an am/pm period and total 0.5
  CONSTRAINT pto_requests_half_day_shape
    CHECK (
      NOT is_half_day OR (
        half_day_period IS NOT NULL
        AND start_date  = end_date
        AND total_days  = 0.5
      )
    ),

  -- Approved / denied requires approver + approved_at
  CONSTRAINT pto_requests_decided_needs_approver
    CHECK (
      status NOT IN ('approved','denied')
      OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
    ),

  -- Denied requires a decline_reason (rpc_decline_pto_request enforces non-empty)
  CONSTRAINT pto_requests_denied_needs_reason
    CHECK (status <> 'denied' OR decline_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_pto_requests_staff_date
  ON public.pto_requests(staff_id, start_date DESC);

CREATE INDEX IF NOT EXISTS idx_pto_requests_pending
  ON public.pto_requests(status, start_date) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_pto_requests_approved_calendar
  ON public.pto_requests(start_date, end_date) WHERE status = 'approved';

COMMENT ON TABLE public.pto_requests IS
  'PTO request lifecycle: pending -> approved/denied/cancelled. Writes via rpc_create/approve/decline/cancel in 107c. Producer Isolation: producer sees own via RLS; owner sees all; manager sees all only when is_pto_manager() returns true (role AND enable_pto_manager_access toggle).';

-- ============================================================================
-- 5. updated_at trigger (shared by all three tables)
-- ============================================================================

CREATE OR REPLACE FUNCTION public._pto_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pto_policies_updated_at ON public.pto_policies;
CREATE TRIGGER trg_pto_policies_updated_at
  BEFORE UPDATE ON public.pto_policies
  FOR EACH ROW EXECUTE FUNCTION public._pto_set_updated_at();

DROP TRIGGER IF EXISTS trg_pto_balances_updated_at ON public.pto_balances;
CREATE TRIGGER trg_pto_balances_updated_at
  BEFORE UPDATE ON public.pto_balances
  FOR EACH ROW EXECUTE FUNCTION public._pto_set_updated_at();

DROP TRIGGER IF EXISTS trg_pto_requests_updated_at ON public.pto_requests;
CREATE TRIGGER trg_pto_requests_updated_at
  BEFORE UPDATE ON public.pto_requests
  FOR EACH ROW EXECUTE FUNCTION public._pto_set_updated_at();

-- ============================================================================
-- 6. is_pto_manager() — Producer Isolation Principle B.11 manager gate
-- ============================================================================
-- Returns TRUE only when both conditions hold:
--   (a) current auth user maps to an ACTIVE staff row with role in
--       ('Office Manager'), AND
--   (b) the enable_pto_manager_access setting is 'true'.
-- Either alone is not enough. Used by 107b (v_pto_admin_roster,
-- fn_pto_team_availability_counts) and 107c (all approve/decline RPCs).
-- SECURITY DEFINER so the settings lookup works regardless of caller's
-- own visibility on settings.

CREATE OR REPLACE FUNCTION public.is_pto_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
        WHERE setting_key = 'enable_pto_manager_access'
        LIMIT 1),
      false
    );
$$;

REVOKE ALL ON FUNCTION public.is_pto_manager() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_pto_manager() TO authenticated;

COMMENT ON FUNCTION public.is_pto_manager() IS
  'Producer Isolation Principle B.11 manager gate for PTO. Returns true only when current user has an active manager/office_manager staff row AND enable_pto_manager_access setting is true. Both required. Owner never uses this — owner has unconditional access via get_current_role_is_owner().';

-- ============================================================================
-- 7. Settings toggles
-- ============================================================================

INSERT INTO public.settings (agency_id, setting_key, setting_value, description)
SELECT
  a.id,
  s.setting_key,
  s.setting_value,
  s.description
FROM public.agency a
CROSS JOIN (VALUES
  ('enable_pto_manager_access', 'true',
   'When true, staff with role=Office Manager have cross-staff PTO visibility and approval authority (Producer Isolation Principle B.11 manager gate). CONSIDERED OVERRIDE of B.11 canonical FALSE default — practical SF office manager workflow includes handling PTO approvals. Owner may set to false in Settings if they want to reclaim PTO approval authority personally.'),
  ('pto_request_granularity', 'half_day_allowed',
   'Governs whether producers may submit half-day PTO requests. Values: half_day_allowed (default — supports AM/PM half days) or full_day_only (whole-day-only, half-day requests rejected by rpc_create_pto_request). Agent-owner configures per agency preference.')
) AS s(setting_key, setting_value, description)
ON CONFLICT (agency_id, setting_key) DO NOTHING;

-- ============================================================================
-- 8. RLS enable + policies (Producer Isolation Principle B.11)
-- ============================================================================

-- pto_policies: all authenticated may read (policies are not PII).
ALTER TABLE public.pto_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pto_policies_read_all_auth ON public.pto_policies;
CREATE POLICY pto_policies_read_all_auth
  ON public.pto_policies
  FOR SELECT
  TO authenticated
  USING (true);

-- pto_balances: producer sees own; owner sees all; manager sees all via
-- is_pto_manager() (role AND toggle).
ALTER TABLE public.pto_balances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pto_balances_read_scoped ON public.pto_balances;
CREATE POLICY pto_balances_read_scoped
  ON public.pto_balances
  FOR SELECT
  TO authenticated
  USING (
    staff_id IN (SELECT id FROM public.staff WHERE auth_user_id = auth.uid())
    OR public.get_current_role_is_owner()
    OR public.is_pto_manager()
  );

-- pto_requests: same scoping as pto_balances.
ALTER TABLE public.pto_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pto_requests_read_scoped ON public.pto_requests;
CREATE POLICY pto_requests_read_scoped
  ON public.pto_requests
  FOR SELECT
  TO authenticated
  USING (
    staff_id IN (SELECT id FROM public.staff WHERE auth_user_id = auth.uid())
    OR public.get_current_role_is_owner()
    OR public.is_pto_manager()
  );

-- ============================================================================
-- 9. GRANTs (SELECT only — writes via RPC only)
-- ============================================================================

GRANT SELECT ON public.pto_policies TO authenticated;
GRANT SELECT ON public.pto_balances TO authenticated;
GRANT SELECT ON public.pto_requests TO authenticated;

-- ============================================================================
-- 10. Provenance
-- ============================================================================

INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration',       '107a_pto_schema',
    'overlay_version', '0.5.2.1',
    'applied_at',      now()
  )
);

COMMIT;
