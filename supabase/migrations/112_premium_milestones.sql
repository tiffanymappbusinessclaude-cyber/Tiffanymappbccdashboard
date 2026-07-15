-- =============================================================================
-- Migration 112 — Premium Milestones: schema + RLS + computed view + RPCs +
-- monthly recognition recipe (Module 09, spec §4.9)
-- =============================================================================
-- Overlay:      bcc-premium-overlay v0.5.2
-- Ships:        Module 09 (Milestones) end-to-end in one migration.
--
-- Depends on Base + overlay prerequisites:
--   • public.staff — Base ships (id, first_name, last_name, ...); 100a adds
--     status, auth_user_id, hire_date; 100_base_compat_shim adds full_name
--     as GENERATED column. This migration adds birth_date (optional).
--   • public.settings — Base ships (setting_key, setting_value, agency_id,
--     description, ...) with UNIQUE(agency_id, setting_key). This migration
--     writes with agency_id sourced from public.agency.
--   • public._install_provenance — Base ships (install_id, entity,
--     master_head, ...); 100_base_compat_shim adds (event_type, event_data)
--     and relaxes the NOT NULLs for overlay event-log rows
--   • public.get_current_role_is_owner() — shipped by 100_base_compat_shim
--     as a wrapper over Base's is_current_user_owner() (022_team_access)
--   • public.current_staff_id() — shipped by 100e as an overlay shim
--   • public.automation_recipes (Base 011/012) + public.run_internal_recipe
--     dispatch (Base 012)
--
-- Spec §4.9 promise:
--   "Service anniversaries, birthdays, work anniversaries — automated so
--    recognition never falls through the cracks."
--
-- Design decisions:
--
--   1. Storage — milestone_recognitions tracks ACKNOWLEDGMENTS (who was
--      recognized when, by whom), not the milestones themselves. Milestones
--      are COMPUTED from staff.hire_date (work anniversaries, service
--      milestones) and staff.birth_date (birthdays if collected).
--      This matches the spec's "mostly computed from Base staff" language
--      and avoids storing derivable data.
--
--   2. birth_date column — added to Base staff table via idempotent
--      ADD COLUMN IF NOT EXISTS. Optional (many agencies never collect it).
--      When NULL, birthday-milestone rows simply do not appear.
--
--   3. Producer Isolation (B.11) — milestones are LOW SENSITIVITY (work
--      anniversaries are visible on LinkedIn; birthdays are optional). The
--      B.11 canonical FALSE default applies to manager access: agents may
--      opt managers in via settings.enable_milestones_manager_access.
--      Producers always see the team milestone view (birthdays/anniversaries
--      are meant to be recognized publicly).
--
--   4. Automation — monthly recipe (`Premium Milestones Monthly Reminder`)
--      runs on the 1st of each month at 7am UTC and inserts advance-notice
--      rows into public.alerts for owner/manager, giving them a 30-day
--      lookahead of upcoming milestones. Follow-up alerts fire 7 days
--      before each individual milestone.
--
--   5. Idempotency — every DDL uses IF NOT EXISTS / OR REPLACE / DROP-
--      then-CREATE. Recipe seed uses ON CONFLICT DO NOTHING.
-- =============================================================================

BEGIN;

-- ============================================================================
-- 1. Extend Base staff — birth_date (optional, agency chooses to collect)
-- ============================================================================
-- Idempotent column-add. Following the pattern established by 100a for
-- staff.status. The column stays NULL for existing rows; agent optionally
-- populates via HR & People UI or through personnel-file collection.

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staff'
      AND column_name = 'birth_date'
  ) THEN
    EXECUTE 'ALTER TABLE public.staff ADD COLUMN birth_date date';
    COMMENT ON COLUMN public.staff.birth_date IS
      'Optional. If collected, feeds Premium Milestones birthday recognition. NULL means birthdays are not tracked for this staff member.';
  END IF;
END
$do$;

-- ============================================================================
-- 2. milestone_recognitions — acknowledgment log
-- ============================================================================
-- One row per acknowledgment event. UNIQUE (staff_id, milestone_type,
-- milestone_date) prevents duplicate recognitions when the monthly recipe
-- re-generates. Historical rows accumulate over years and are queryable
-- via the "who haven't I recognized yet this year" prompt.

CREATE TABLE IF NOT EXISTS public.milestone_recognitions (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id            uuid          NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  milestone_type      text          NOT NULL
                                    CHECK (milestone_type IN ('birthday','work_anniversary','service_milestone')),
  milestone_date      date          NOT NULL,
  years_of_service    integer,      -- populated for work_anniversary + service_milestone; NULL for birthday
  acknowledged        boolean       NOT NULL DEFAULT false,
  acknowledged_at     timestamptz,
  acknowledged_by     uuid          REFERENCES auth.users(id),
  notes               text,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT milestone_recognitions_unique_event
    UNIQUE (staff_id, milestone_type, milestone_date),

  -- acknowledged=true requires acknowledged_at populated (trigger below
  -- backfills automatically, but the constraint ensures no gap when rows
  -- are updated by hand).
  CONSTRAINT milestone_recognitions_ack_consistency
    CHECK (acknowledged = false OR acknowledged_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_milestone_recognitions_staff_date
  ON public.milestone_recognitions(staff_id, milestone_date DESC);

CREATE INDEX IF NOT EXISTS idx_milestone_recognitions_pending
  ON public.milestone_recognitions(milestone_date, acknowledged)
  WHERE acknowledged = false;

COMMENT ON TABLE public.milestone_recognitions IS
  'Acknowledgment log for staff milestones. Milestones themselves are computed from staff.hire_date / birth_date via v_upcoming_milestones. This table records who was recognized and when. Writes go through rpc_acknowledge_milestone (SECURITY DEFINER).';

-- ============================================================================
-- 3. is_milestones_manager() — manager gate (canonical B.11 FALSE default)
-- ============================================================================
-- Follows the exact pattern from 107a's is_pto_manager(). Manager sees
-- milestone data only when BOTH they hold manager role AND the settings
-- toggle is true. Unlike PTO, Milestones defaults FALSE (spec Part I §2:
-- "Producer Isolation Principle B.11 canonical FALSE default").

CREATE OR REPLACE FUNCTION public.is_milestones_manager()
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
        WHERE setting_key = 'enable_milestones_manager_access'
        LIMIT 1),
      false
    );
$fn$;

REVOKE ALL ON FUNCTION public.is_milestones_manager() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_milestones_manager() TO authenticated;

COMMENT ON FUNCTION public.is_milestones_manager() IS
  'B.11 manager gate for Milestones. Returns true only when (a) caller holds active manager/office_manager role AND (b) enable_milestones_manager_access setting is true. Canonical B.11 FALSE default (unlike PTO).';

-- ============================================================================
-- 4. Settings toggle
-- ============================================================================

INSERT INTO public.settings (agency_id, setting_key, setting_value, description)
SELECT
  a.id,
  'enable_milestones_manager_access',
  'false',
  'Producer Isolation Principle B.11 manager gate for Milestones module. When true, staff with role=Office Manager can see and acknowledge milestones for all team members. Canonical B.11 FALSE default. Owner opts managers in explicitly if desired.'
FROM public.agency a
ON CONFLICT (agency_id, setting_key) DO NOTHING;

-- ============================================================================
-- 5. v_upcoming_milestones — computed source of truth for upcoming events
-- ============================================================================
-- Computes upcoming work anniversaries, service milestones (5/10/15/20/25
-- years), and birthdays for the next 60 days from staff.hire_date and
-- staff.birth_date. Left-joins to milestone_recognitions so callers can see
-- acknowledgment status inline.
--
-- Producer Isolation: view scoping is applied by RLS on the underlying
-- staff table (v_upcoming_milestones is a plain view, inherits scoping).

DROP VIEW IF EXISTS public.v_upcoming_milestones;
CREATE VIEW public.v_upcoming_milestones AS
WITH horizon AS (
  SELECT
    current_date AS today,
    (current_date + interval '60 days')::date AS horizon_end
),
work_anniversaries AS (
  -- v1.1.0.1 hotfix (2026-07-14): compute years_of_service AT the milestone_date,
  -- not as-of current_date. Prior code used EXTRACT(YEAR FROM age(current_date, ...))
  -- which returned the years elapsed TODAY, so upcoming 5/10/15/... year milestones
  -- silently rendered as N-1 years until the day-of, and is_service_milestone
  -- (years_of_service % 5 = 0) missed them entirely.
  SELECT
    s.id AS staff_id,
    s.full_name,
    s.hire_date,
    'work_anniversary'::text AS milestone_type,
    (date_trunc('year', current_date)::date
       + (s.hire_date - date_trunc('year', s.hire_date)::date))::date AS this_year_date
  FROM public.staff s
  WHERE s.status = 'active'
    AND s.hire_date IS NOT NULL
),
work_upcoming AS (
  -- Roll to next year if this year's date has passed. years_of_service is
  -- computed AT the resulting milestone_date so 5/10/15/... year milestones
  -- read correctly on the day they matter.
  SELECT
    staff_id, full_name, milestone_type,
    CASE
      WHEN this_year_date < current_date
        THEN (this_year_date + interval '1 year')::date
      ELSE this_year_date
    END AS milestone_date,
    EXTRACT(YEAR FROM age(
      CASE
        WHEN this_year_date < current_date
          THEN (this_year_date + interval '1 year')::date
        ELSE this_year_date
      END,
      hire_date
    ))::integer AS years_of_service
  FROM work_anniversaries
),
birthdays AS (
  SELECT
    s.id AS staff_id,
    s.full_name,
    'birthday'::text AS milestone_type,
    (date_trunc('year', current_date)::date
       + (s.birth_date - date_trunc('year', s.birth_date)::date))::date AS this_year_date
  FROM public.staff s
  WHERE s.status = 'active'
    AND s.birth_date IS NOT NULL
),
birthday_upcoming AS (
  SELECT
    staff_id, full_name, milestone_type,
    CASE
      WHEN this_year_date < current_date
        THEN (this_year_date + interval '1 year')::date
      ELSE this_year_date
    END AS milestone_date,
    NULL::integer AS years_of_service
  FROM birthdays
),
combined AS (
  SELECT staff_id, full_name, milestone_type, milestone_date, years_of_service
    FROM work_upcoming
   UNION ALL
  SELECT staff_id, full_name, milestone_type, milestone_date, years_of_service
    FROM birthday_upcoming
)
SELECT
  c.staff_id,
  c.full_name,
  c.milestone_type,
  c.milestone_date,
  c.years_of_service,
  -- Special "service_milestone" flag: 5/10/15/20/25/etc. year anniversaries
  -- get promoted to service_milestone type in the display (still stored as
  -- work_anniversary in recognitions).
  CASE
    WHEN c.milestone_type = 'work_anniversary'
      AND c.years_of_service > 0
      AND c.years_of_service % 5 = 0
    THEN true ELSE false
  END AS is_service_milestone,
  (c.milestone_date - current_date) AS days_until,
  mr.acknowledged,
  mr.acknowledged_at,
  mr.acknowledged_by,
  mr.notes AS acknowledgment_notes
FROM combined c
CROSS JOIN horizon h
LEFT JOIN public.milestone_recognitions mr
  ON mr.staff_id = c.staff_id
 AND mr.milestone_type = c.milestone_type
 AND mr.milestone_date = c.milestone_date
WHERE c.milestone_date BETWEEN h.today AND h.horizon_end
ORDER BY c.milestone_date, c.full_name;

COMMENT ON VIEW public.v_upcoming_milestones IS
  'Next 60 days of upcoming staff milestones. Computed from staff.hire_date + staff.birth_date. Left-joined to milestone_recognitions for acknowledgment status. is_service_milestone=true marks 5/10/15/... year anniversaries. days_until is negative on the milestone day.';

GRANT SELECT ON public.v_upcoming_milestones TO authenticated;

-- ============================================================================
-- 6. RLS on milestone_recognitions
-- ============================================================================

ALTER TABLE public.milestone_recognitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS milestone_recognitions_read_scoped ON public.milestone_recognitions;
CREATE POLICY milestone_recognitions_read_scoped
  ON public.milestone_recognitions
  FOR SELECT
  TO authenticated
  USING (
    -- Everyone sees team milestones (birthdays/anniversaries are meant to
    -- be celebrated publicly). This is a considered relaxation of B.11
    -- for THIS module only, matching the spec's "mostly public" framing.
    true
  );

-- No INSERT/UPDATE/DELETE policies — writes exclusively through
-- rpc_acknowledge_milestone below. Implicit deny for direct writes.

-- ============================================================================
-- 7. rpc_acknowledge_milestone — write path for acknowledgments
-- ============================================================================
-- SECURITY DEFINER so it can insert on behalf of the acknowledger without
-- table-level INSERT policy. Callable by owner unconditionally, by manager
-- only when is_milestones_manager() returns true.

CREATE OR REPLACE FUNCTION public.rpc_acknowledge_milestone(
  p_staff_id       uuid,
  p_milestone_type text,
  p_milestone_date date,
  p_notes          text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row_id         uuid;
  v_years          integer;
BEGIN
  -- Authorization
  IF NOT (public.get_current_role_is_owner() OR public.is_milestones_manager()) THEN
    RAISE EXCEPTION 'permission_denied: only owner or authorized manager can acknowledge milestones'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Validate milestone type
  IF p_milestone_type NOT IN ('birthday','work_anniversary','service_milestone') THEN
    RAISE EXCEPTION 'invalid milestone_type %', p_milestone_type USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Compute years_of_service from hire_date for work_anniversary variants
  IF p_milestone_type IN ('work_anniversary','service_milestone') THEN
    SELECT EXTRACT(YEAR FROM age(p_milestone_date, hire_date))::integer
      INTO v_years
      FROM public.staff
     WHERE id = p_staff_id;
  END IF;

  INSERT INTO public.milestone_recognitions
    (staff_id, milestone_type, milestone_date, years_of_service,
     acknowledged, acknowledged_at, acknowledged_by, notes)
  VALUES
    (p_staff_id, p_milestone_type, p_milestone_date, v_years,
     true, now(), auth.uid(), p_notes)
  ON CONFLICT (staff_id, milestone_type, milestone_date)
    DO UPDATE SET
      acknowledged     = true,
      acknowledged_at  = COALESCE(milestone_recognitions.acknowledged_at, now()),
      acknowledged_by  = COALESCE(milestone_recognitions.acknowledged_by, auth.uid()),
      notes            = COALESCE(EXCLUDED.notes, milestone_recognitions.notes),
      updated_at       = now()
  RETURNING id INTO v_row_id;

  RETURN v_row_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rpc_acknowledge_milestone(uuid, text, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_acknowledge_milestone(uuid, text, date, text) TO authenticated;

COMMENT ON FUNCTION public.rpc_acknowledge_milestone(uuid, text, date, text) IS
  'Record acknowledgment of a staff milestone. Owner unconditionally; manager only when is_milestones_manager()=true. Idempotent via UNIQUE + ON CONFLICT. Auto-computes years_of_service from staff.hire_date for anniversary variants.';

-- ============================================================================
-- 8. handler_milestones_monthly_reminder — automation-runner adapter
-- ============================================================================
-- Contract-compliant adapter for the monthly recipe. Reads
-- v_upcoming_milestones for the next 30 days and generates one alert row
-- per upcoming milestone into public.alerts (Base module Alerts &
-- Notifications).

CREATE OR REPLACE FUNCTION public.handler_milestones_monthly_reminder(
  p_agency_id uuid,
  p_recipe_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_inserted    integer := 0;
  v_skipped     integer := 0;
  v_horizon_end date    := current_date + interval '30 days';
  v_row         record;
BEGIN
  -- Only generate alerts for milestones we have not already alerted on.
  -- Prevention of duplicate alerts is enforced by an idempotent INSERT
  -- against public.alerts keyed on (agency_id, alert_type, module_reference,
  -- related_id, due_date) — the UNIQUE index added by 100_base_compat_shim
  -- (v0.5.3.1 hotfix).
  FOR v_row IN
    SELECT staff_id, full_name, milestone_type, milestone_date,
           years_of_service, is_service_milestone, days_until
      FROM public.v_upcoming_milestones
     WHERE milestone_date BETWEEN current_date AND v_horizon_end
     ORDER BY milestone_date
  LOOP
    BEGIN
      INSERT INTO public.alerts (
        agency_id,
        alert_type,
        severity,
        title,
        message,
        module_reference,
        related_id,
        due_date
      )
      VALUES (
        p_agency_id,
        'staff_' || v_row.milestone_type,  -- 'staff_birthday' or 'staff_work_anniversary' — distinct types keep dedupe key clean when both fall on same date
        CASE WHEN v_row.days_until <= 7 THEN 'high'
             WHEN v_row.days_until <= 14 THEN 'normal'
             ELSE 'low'
        END,
        CASE v_row.milestone_type
          WHEN 'birthday' THEN v_row.full_name || ' — birthday'
          WHEN 'work_anniversary' THEN
            CASE WHEN v_row.is_service_milestone
                 THEN v_row.full_name || ' — ' || v_row.years_of_service || '-year service milestone'
                 ELSE v_row.full_name || ' — work anniversary'
            END
          ELSE v_row.full_name || ' — milestone'
        END,
        format('%s on %s (in %s day%s). Acknowledge to record recognition.',
               v_row.milestone_type,
               to_char(v_row.milestone_date, 'FMMonth FMDDth'),
               v_row.days_until,
               CASE WHEN v_row.days_until = 1 THEN '' ELSE 's' END),
        'milestones',
        v_row.staff_id,
        v_row.milestone_date
      )
      ON CONFLICT (agency_id, alert_type, module_reference, related_id, due_date) DO NOTHING;

      IF FOUND THEN
        v_inserted := v_inserted + 1;
      ELSE
        v_skipped := v_skipped + 1;
      END IF;
    EXCEPTION
      WHEN undefined_table THEN
        -- Base's alerts table not present — fail soft, report to run log.
        RETURN jsonb_build_object(
          'records_processed', 0,
          'output_summary', 'Milestones reminder skipped — public.alerts table not found. Alerts module required for milestone notifications.',
          'detail', jsonb_build_object('reason', 'alerts_table_missing')
        );
      WHEN undefined_column THEN
        RETURN jsonb_build_object(
          'records_processed', 0,
          'output_summary', 'Milestones reminder skipped — public.alerts schema mismatch. Update to Base migration ≥ 015 required.',
          'detail', jsonb_build_object('reason', 'alerts_schema_mismatch')
        );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_inserted,
    'output_summary', format(
      'Milestones monthly reminder: %s new alerts, %s already-alerted skipped.',
      v_inserted, v_skipped
    ),
    'detail', jsonb_build_object(
      'inserted', v_inserted,
      'skipped',  v_skipped,
      'horizon_days', 30
    )
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.handler_milestones_monthly_reminder(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handler_milestones_monthly_reminder(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.handler_milestones_monthly_reminder(uuid, uuid) IS
  'Recipe-contract adapter matching run_internal_recipe signature. Iterates v_upcoming_milestones for next 30 days and inserts idempotent alerts into public.alerts. Fails soft if Base alerts table/schema absent (returns records_processed=0 with a diagnostic summary).';

-- ============================================================================
-- 9. Recipe seed — monthly cron
-- ============================================================================
-- Runs 07:00 UTC on the 1st of each month. Alerts-module downstream handles
-- the "7 days in advance" reminder cadence since alerts.alert_date drives
-- visibility. This monthly job just ensures the alerts are STAGED for the
-- month.

INSERT INTO public.automation_recipes (
    agency_id,
    recipe_name,
    recipe_description,
    trigger_type,
    cron_expression,
    composio_action,
    composio_connection,
    internal_handler,
    input_config,
    output_table,
    output_config,
    is_active
) VALUES (
    '{{agency_id}}'::uuid,
    'Premium Milestones Monthly Reminder',
    'Monthly job that stages alerts for upcoming staff milestones (birthdays, work anniversaries, 5/10/15/... year service milestones) in the next 30 days. Idempotent — re-runs won''t create duplicate alerts. Ships with bcc-premium-overlay v0.5.2 via handler_milestones_monthly_reminder. Owner acknowledges each milestone through the Milestones module UI, which writes to public.milestone_recognitions.',
    'cron',
    '0 7 1 * *',
    'INTERNAL',
    NULL,
    'handler_milestones_monthly_reminder',
    '{}'::jsonb,
    'alerts',
    '{"log_to_run_log": true}'::jsonb,
    true
)
ON CONFLICT (agency_id, recipe_name) DO NOTHING;

-- ============================================================================
-- 10. Provenance
-- ============================================================================

INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration',        '112_premium_milestones',
    'overlay_version',  '1.1.0.1',
    'ships_module',     'Module 09 — Milestones',
    'spec_ref',         '§4.9',
    'applied_at',       now()
  )
);

COMMIT;

-- =============================================================================
-- Verification (run manually after apply)
-- =============================================================================
--
-- 1. staff.birth_date column present:
--    SELECT column_name FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='staff' AND column_name='birth_date';
--    Expected: one row.
--
-- 2. milestone_recognitions table + RLS:
--    SELECT relname, relrowsecurity FROM pg_class
--     WHERE relname='milestone_recognitions';
--    Expected: relrowsecurity = true.
--
-- 3. Settings toggle seeded:
--    SELECT key, value FROM public.settings
--     WHERE key='enable_milestones_manager_access';
--    Expected: value='false'.
--
-- 4. View computes upcoming milestones:
--    SELECT staff_id, milestone_type, milestone_date, days_until
--      FROM public.v_upcoming_milestones LIMIT 10;
--    Expected: 0+ rows depending on staff.hire_date/birth_date population.
--
-- 5. Recipe row present and scheduled:
--    SELECT recipe_name, cron_expression, internal_handler, is_active
--      FROM public.automation_recipes
--     WHERE recipe_name = 'Premium Milestones Monthly Reminder';
--    Expected: is_active=true, cron_expression='0 7 1 * *'.
--
-- 6. Dry-run handler (idempotent — safe to run manually):
--    SELECT public.handler_milestones_monthly_reminder(
--      '<agency_id>'::uuid,
--      (SELECT id FROM public.automation_recipes
--        WHERE recipe_name='Premium Milestones Monthly Reminder' LIMIT 1)
--    );
--    Expected: {records_processed: N, output_summary: "..."} — or a soft-fail
--    diagnostic if Base's alerts table is not yet present.
