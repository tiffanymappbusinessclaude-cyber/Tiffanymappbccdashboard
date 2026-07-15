-- =============================================================================
-- Migration 108 — Premium Licenses: schema + RLS + expiration view + RPCs +
-- monthly expiration monitor recipe (Module 08, spec §4.8)
-- =============================================================================
-- Overlay:      bcc-premium-overlay v0.5.3
-- Ships:        Module 08 (Licenses) end-to-end in one migration.
--
-- Depends on Base + overlay prerequisites (identical to 112):
--   • public.staff — Base 001 + 100a extensions + 100_shim full_name
--   • public.settings — Base shape (agency_id, setting_key, setting_value)
--   • public._install_provenance — 100_shim widened event_type/event_data
--   • public.get_current_role_is_owner() — 100_shim wrapper
--   • public.current_staff_id() — 100e shim
--   • public.automation_recipes + public.alerts — Base 011/012/015
--
-- Spec §4.8 promise:
--   "Producer license tracking with automatic renewal alerts. Never miss a
--    CE deadline or a license expiration again."
--
-- Design decisions:
--
--   1. Storage — producer_licenses table stores the actual credential
--      records (license_type, license_number, state, dates, CE hours).
--      Unlike Milestones, licenses are NOT derivable — they're the source
--      of truth. UNIQUE constraint (staff_id, license_type, state)
--      prevents duplicate concurrent records; when a producer renews, the
--      SAME row is updated (issue/expiration/CE reset) rather than a new
--      row added — history lives in an audit trail on the parent record,
--      not through row multiplication.
--
--   2. Manager gate default — DELIBERATE DEVIATION from canonical B.11
--      FALSE. Licenses defaults enable_licenses_manager_access = TRUE.
--
--      Rationale (locked 2026-07-10 by Rebecca): managers routinely track
--      team CE compliance and license expirations across their team;
--      forcing owner-only creates an operational bottleneck the spec's
--      "never miss a CE deadline" promise cannot deliver on. This gate
--      remains a per-agency toggle — an owner who wants tighter control
--      can flip it FALSE in settings.
--
--      This is the second considered B.11 relaxation in the overlay (the
--      first was Milestones' RLS read-scope; this is the first manager-
--      gate default flip). Documented here and in migration header.
--
--   3. Producer visibility — every producer sees their OWN licenses (self-
--      RLS). This is unconditional and not gated on any toggle. Owner
--      sees all licenses unconditionally. Manager sees all licenses when
--      the toggle is TRUE.
--
--   4. Automation — monthly recipe (`Premium Licenses Expiration Monitor`)
--      runs on the 1st of each month at 8am UTC (1 hour after Milestones,
--      staggered so recipe-driven alert bursts don't collide). For each
--      license expiring within 60 days OR with a CE gap, stages one alert
--      row into public.alerts. Priority escalates: high (≤14 days or CE
--      shortfall), normal (≤30 days), low (≤60 days). Idempotent via
--      ON CONFLICT DO NOTHING on the (agency_id, alert_type,
--      module_reference, related_id, due_date) idempotency index added
--      by 100_base_compat_shim (v0.5.3.1 hotfix).
--
--   5. Idempotency — every DDL uses IF NOT EXISTS / OR REPLACE / DROP-
--      then-CREATE. Recipe seed uses ON CONFLICT DO NOTHING.
-- =============================================================================

BEGIN;

-- ============================================================================
-- 1. producer_licenses table
-- ============================================================================
-- One row per (staff, license_type, state) combination. When a producer
-- renews, UPDATE the existing row (issue_date + expiration_date + CE
-- counters advance forward) rather than inserting a new row. This keeps
-- the "how many licenses does Bob have" answer stable across renewals
-- while the current_status field tracks lifecycle.

CREATE TABLE IF NOT EXISTS public.producer_licenses (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id             uuid          NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,

  -- What credential this is
  license_type         text          NOT NULL
                                     CHECK (license_type IN (
                                       'p_c',              -- Property & Casualty
                                       'life',             -- Life insurance
                                       'health',           -- Health insurance
                                       'life_health',      -- Combined L&H
                                       'series_6',         -- FINRA Series 6
                                       'series_7',         -- FINRA Series 7
                                       'series_63',        -- FINRA Series 63
                                       'series_65',        -- FINRA Series 65
                                       'crop',             -- Crop insurance
                                       'ce_certificate',   -- Standalone CE certification
                                       'other'             -- Escape hatch (surety, title, etc.)
                                     )),
  license_number       varchar(50)   NOT NULL,   -- Producer's professional credential — NOT customer-identifying PII
  state                varchar(2)    NOT NULL,   -- 2-letter US state / territory code

  -- Dates and CE
  issue_date           date,
  expiration_date      date          NOT NULL,   -- Required — this is the whole point of the module
  ce_hours_required    integer       NOT NULL DEFAULT 0 CHECK (ce_hours_required >= 0),
  ce_hours_completed   integer       NOT NULL DEFAULT 0 CHECK (ce_hours_completed >= 0),

  -- Lifecycle
  status               text          NOT NULL DEFAULT 'active'
                                     CHECK (status IN ('active','expired','suspended','inactive')),
  notes                text,

  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),

  -- One live record per producer per license type per state.
  CONSTRAINT producer_licenses_unique_credential
    UNIQUE (staff_id, license_type, state)
);

CREATE INDEX IF NOT EXISTS idx_producer_licenses_staff
  ON public.producer_licenses(staff_id);

CREATE INDEX IF NOT EXISTS idx_producer_licenses_expiration
  ON public.producer_licenses(expiration_date, status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_producer_licenses_state
  ON public.producer_licenses(state);

COMMENT ON TABLE public.producer_licenses IS
  'Producer professional credentials — P&C, L&H, Series 6/7/63/65, etc. Not customer PII (this is the producer''s own credential number). One row per (staff_id, license_type, state); renewals update the same row. Writes go through rpc_upsert_producer_license / rpc_delete_producer_license.';

COMMENT ON COLUMN public.producer_licenses.license_number IS
  'The state-issued or FINRA-issued credential number for THIS producer. Not customer-identifying PII. Compliance-safe module per spec Part I §1.';

-- ============================================================================
-- 2. is_licenses_manager() — manager gate (DELIBERATE B.11 DEVIATION — TRUE)
-- ============================================================================
-- Follows the exact pattern from 107a's is_pto_manager() and 112's
-- is_milestones_manager(), BUT defaults to TRUE (see design decisions §2).
-- Manager sees license data only when BOTH they hold manager role AND the
-- settings toggle is true. The toggle defaults to true (deliberate).

CREATE OR REPLACE FUNCTION public.is_licenses_manager()
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
        WHERE setting_key = 'enable_licenses_manager_access'
        LIMIT 1),
      true  -- DELIBERATE deviation from canonical B.11 FALSE default. See migration header §2.
    );
$fn$;

REVOKE ALL ON FUNCTION public.is_licenses_manager() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_licenses_manager() TO authenticated;

COMMENT ON FUNCTION public.is_licenses_manager() IS
  'B.11 manager gate for Licenses. Returns true only when (a) caller holds active manager/office_manager role AND (b) enable_licenses_manager_access setting is true (defaults TRUE). Deliberate deviation from canonical B.11 FALSE — see migration 108 header §2.';

-- ============================================================================
-- 3. Settings toggle — default TRUE (deliberate deviation from B.11)
-- ============================================================================

INSERT INTO public.settings (agency_id, setting_key, setting_value, description)
SELECT
  a.id,
  'enable_licenses_manager_access',
  'true',
  'Producer Isolation Principle B.11 manager gate for Licenses module. When true, staff with role=Office Manager can see and manage license records for all team members. DEFAULTS TRUE (deliberate deviation from canonical B.11 FALSE) — managers routinely need to track team CE compliance and renewal deadlines; forcing owner-only creates a bottleneck the "never miss a CE deadline" spec promise cannot honor. Owners who want tighter control can flip this to false.'
FROM public.agency a
ON CONFLICT (agency_id, setting_key) DO NOTHING;

-- ============================================================================
-- 4. v_expiring_licenses — computed view of what needs attention
-- ============================================================================
-- Shows every active license whose expiration is within 60 days OR whose
-- CE requirements are not yet met. Left-joined to staff so callers get
-- the display name inline. Ordered by urgency (soonest expiration first).

DROP VIEW IF EXISTS public.v_expiring_licenses;
CREATE VIEW public.v_expiring_licenses AS
SELECT
  pl.id                         AS license_id,
  pl.staff_id,
  s.full_name,
  s.role,
  s.email,
  pl.license_type,
  pl.license_number,
  pl.state,
  pl.issue_date,
  pl.expiration_date,
  pl.ce_hours_required,
  pl.ce_hours_completed,
  GREATEST(pl.ce_hours_required - pl.ce_hours_completed, 0) AS ce_hours_shortfall,
  (pl.expiration_date - current_date)                        AS days_until_expiration,
  CASE
    WHEN pl.expiration_date < current_date THEN 'expired'
    WHEN pl.expiration_date <= current_date + 14 THEN 'critical'
    WHEN pl.expiration_date <= current_date + 30 THEN 'warning'
    WHEN pl.expiration_date <= current_date + 60 THEN 'watch'
    ELSE 'ok'
  END AS urgency,
  (pl.ce_hours_completed < pl.ce_hours_required)             AS ce_behind,
  pl.status,
  pl.updated_at
FROM public.producer_licenses pl
JOIN public.staff s ON s.id = pl.staff_id
WHERE pl.status = 'active'
  AND s.status = 'active'
  AND (
    pl.expiration_date <= current_date + 60
    OR pl.ce_hours_completed < pl.ce_hours_required
  )
ORDER BY pl.expiration_date, s.full_name;

COMMENT ON VIEW public.v_expiring_licenses IS
  'Active licenses expiring in the next 60 days OR behind on CE hours. Feeds the Licenses dashboard and the monthly expiration monitor recipe. urgency bucket: expired < critical(<=14d) < warning(<=30d) < watch(<=60d) < ok. ce_behind flag independent of expiration urgency.';

GRANT SELECT ON public.v_expiring_licenses TO authenticated;

-- ============================================================================
-- 5. RLS on producer_licenses
-- ============================================================================

ALTER TABLE public.producer_licenses ENABLE ROW LEVEL SECURITY;

-- SELECT: producers see their own; owner sees all; manager sees all when gate TRUE
DROP POLICY IF EXISTS producer_licenses_read_scoped ON public.producer_licenses;
CREATE POLICY producer_licenses_read_scoped
  ON public.producer_licenses
  FOR SELECT
  TO authenticated
  USING (
    staff_id = public.current_staff_id()
    OR public.get_current_role_is_owner()
    OR public.is_licenses_manager()
  );

-- INSERT / UPDATE / DELETE go through RPCs (SECURITY DEFINER). No table-level
-- write policies. Implicit deny for direct writes from client SDK.

-- ============================================================================
-- 6. rpc_upsert_producer_license — write path (insert or update)
-- ============================================================================
-- Producer can upsert own licenses. Owner unconditionally. Manager only
-- when is_licenses_manager() = true. UPDATE re-uses the (staff_id,
-- license_type, state) UNIQUE key so a producer renewing a license
-- updates the same row rather than creating a new one.

CREATE OR REPLACE FUNCTION public.rpc_upsert_producer_license(
  p_staff_id            uuid,
  p_license_type        text,
  p_license_number      varchar(50),
  p_state               varchar(2),
  p_expiration_date     date,
  p_issue_date          date          DEFAULT NULL,
  p_ce_hours_required   integer       DEFAULT 0,
  p_ce_hours_completed  integer       DEFAULT 0,
  p_status              text          DEFAULT 'active',
  p_notes               text          DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row_id       uuid;
  v_caller_id    uuid := public.current_staff_id();
  v_is_owner     boolean := public.get_current_role_is_owner();
  v_is_mgr       boolean := public.is_licenses_manager();
BEGIN
  -- Authorization: caller must be the subject staff, an owner, or (with gate) a manager
  IF NOT (p_staff_id = v_caller_id OR v_is_owner OR v_is_mgr) THEN
    RAISE EXCEPTION 'permission_denied: cannot upsert license for staff you do not own or manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Validate license_type
  IF p_license_type NOT IN
     ('p_c','life','health','life_health','series_6','series_7','series_63','series_65','crop','ce_certificate','other') THEN
    RAISE EXCEPTION 'invalid license_type %', p_license_type USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Validate status
  IF p_status NOT IN ('active','expired','suspended','inactive') THEN
    RAISE EXCEPTION 'invalid status %', p_status USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Validate state code
  IF length(coalesce(p_state,'')) <> 2 THEN
    RAISE EXCEPTION 'state must be a 2-letter code (got %)', p_state USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Validate CE hours
  IF coalesce(p_ce_hours_required,0) < 0 OR coalesce(p_ce_hours_completed,0) < 0 THEN
    RAISE EXCEPTION 'CE hours cannot be negative' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.producer_licenses
    (staff_id, license_type, license_number, state,
     issue_date, expiration_date, ce_hours_required, ce_hours_completed,
     status, notes)
  VALUES
    (p_staff_id, p_license_type, p_license_number, upper(p_state),
     p_issue_date, p_expiration_date, p_ce_hours_required, p_ce_hours_completed,
     p_status, p_notes)
  ON CONFLICT (staff_id, license_type, state) DO UPDATE SET
      license_number     = EXCLUDED.license_number,
      issue_date         = COALESCE(EXCLUDED.issue_date, producer_licenses.issue_date),
      expiration_date    = EXCLUDED.expiration_date,
      ce_hours_required  = EXCLUDED.ce_hours_required,
      ce_hours_completed = EXCLUDED.ce_hours_completed,
      status             = EXCLUDED.status,
      notes              = COALESCE(EXCLUDED.notes, producer_licenses.notes),
      updated_at         = now()
  RETURNING id INTO v_row_id;

  RETURN v_row_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rpc_upsert_producer_license(
  uuid, text, varchar, varchar, date, date, integer, integer, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_producer_license(
  uuid, text, varchar, varchar, date, date, integer, integer, text, text
) TO authenticated;

COMMENT ON FUNCTION public.rpc_upsert_producer_license(
  uuid, text, varchar, varchar, date, date, integer, integer, text, text
) IS
  'Create or renew a producer license. Producer can upsert own; owner unconditionally; manager when is_licenses_manager()=true. UNIQUE(staff_id, license_type, state) means a renewal updates the same row rather than creating a duplicate.';

-- ============================================================================
-- 7. rpc_delete_producer_license — delete path
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rpc_delete_producer_license(
  p_license_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller_id  uuid := public.current_staff_id();
  v_subject_id uuid;
BEGIN
  SELECT staff_id INTO v_subject_id
    FROM public.producer_licenses
   WHERE id = p_license_id;

  IF v_subject_id IS NULL THEN
    RAISE EXCEPTION 'license % not found', p_license_id USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT (v_subject_id = v_caller_id
          OR public.get_current_role_is_owner()
          OR public.is_licenses_manager()) THEN
    RAISE EXCEPTION 'permission_denied: cannot delete license for staff you do not own or manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM public.producer_licenses WHERE id = p_license_id;
  RETURN true;
END
$fn$;

REVOKE ALL ON FUNCTION public.rpc_delete_producer_license(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_delete_producer_license(uuid) TO authenticated;

COMMENT ON FUNCTION public.rpc_delete_producer_license(uuid) IS
  'Delete a producer license. Producer can delete own; owner unconditionally; manager when is_licenses_manager()=true. Prefer marking status=inactive when the license is retired rather than deleting; delete is for correction of erroneous records.';

-- ============================================================================
-- 8. handler_licenses_expiration_monitor — automation-runner adapter
-- ============================================================================
-- Contract-compliant adapter for the monthly recipe. Reads
-- v_expiring_licenses and stages one alert per license needing attention.
-- Alerts are idempotent via ON CONFLICT DO NOTHING on Base's alerts UNIQUE.
--
-- Alert dating strategy: alert_date = expiration_date (or today, whichever
-- is later, for already-expired licenses). Priority derived from urgency
-- bucket. Base's Alerts module handles surfacing near the alert_date.

CREATE OR REPLACE FUNCTION public.handler_licenses_expiration_monitor(
  p_agency_id uuid,
  p_recipe_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_inserted     integer := 0;
  v_skipped      integer := 0;
  v_ce_inserted  integer := 0;
  v_row          record;
BEGIN
  FOR v_row IN
    SELECT license_id, staff_id, full_name, license_type, license_number,
           state, expiration_date, days_until_expiration, urgency,
           ce_behind, ce_hours_required, ce_hours_completed, ce_hours_shortfall
      FROM public.v_expiring_licenses
     ORDER BY expiration_date, full_name
  LOOP
    -- Alert 1 — expiration warning
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
        'license_expiration',
        CASE v_row.urgency
          WHEN 'expired'  THEN 'high'
          WHEN 'critical' THEN 'high'
          WHEN 'warning'  THEN 'normal'
          WHEN 'watch'    THEN 'low'
          ELSE 'low'
        END,
        v_row.full_name || ' — ' ||
          initcap(replace(v_row.license_type, '_', ' ')) ||
          ' (' || v_row.state || ') ' ||
          CASE
            WHEN v_row.days_until_expiration < 0 THEN 'EXPIRED'
            WHEN v_row.days_until_expiration = 0 THEN 'expires today'
            WHEN v_row.days_until_expiration = 1 THEN 'expires tomorrow'
            ELSE 'expires in ' || v_row.days_until_expiration || ' days'
          END,
        format('License #%s (%s) held by %s expires %s. Renew before the deadline to avoid a compliance lapse.',
               v_row.license_number,
               v_row.state,
               v_row.full_name,
               to_char(v_row.expiration_date, 'FMMonth FMDDth, YYYY')),
        'licenses',
        v_row.license_id,
        GREATEST(v_row.expiration_date, current_date)
      )
      ON CONFLICT (agency_id, alert_type, module_reference, related_id, due_date) DO NOTHING;

      IF FOUND THEN v_inserted := v_inserted + 1;
      ELSE          v_skipped  := v_skipped  + 1;
      END IF;
    EXCEPTION
      WHEN undefined_table THEN
        RETURN jsonb_build_object(
          'records_processed', 0,
          'output_summary', 'Licenses monitor skipped — public.alerts table not found. Base Alerts module required for license notifications.',
          'detail', jsonb_build_object('reason', 'alerts_table_missing')
        );
      WHEN undefined_column THEN
        RETURN jsonb_build_object(
          'records_processed', 0,
          'output_summary', 'Licenses monitor skipped — public.alerts schema mismatch. Update to Base migration >= 015 required.',
          'detail', jsonb_build_object('reason', 'alerts_schema_mismatch')
        );
    END;

    -- Alert 2 — CE shortfall, only if the producer is behind
    IF v_row.ce_behind THEN
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
          'license_ce_shortfall',
          CASE
            WHEN v_row.days_until_expiration <= 30 THEN 'high'
            WHEN v_row.days_until_expiration <= 60 THEN 'normal'
            ELSE 'low'
          END,
          v_row.full_name || ' — CE hours behind on ' ||
            initcap(replace(v_row.license_type, '_', ' ')) ||
            ' (' || v_row.state || ')',
          format('%s needs %s more CE hours (%s of %s completed) before %s expiration.',
                 v_row.full_name,
                 v_row.ce_hours_shortfall,
                 v_row.ce_hours_completed,
                 v_row.ce_hours_required,
                 to_char(v_row.expiration_date, 'FMMonth FMDDth, YYYY')),
          'licenses',
          v_row.license_id,
          GREATEST(v_row.expiration_date - 30, current_date)
        )
        ON CONFLICT (agency_id, alert_type, module_reference, related_id, due_date) DO NOTHING;

        IF FOUND THEN v_ce_inserted := v_ce_inserted + 1;
        END IF;
      EXCEPTION
        WHEN OTHERS THEN NULL;  -- Non-fatal; expiration alert already accounted for
      END;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_inserted + v_ce_inserted,
    'output_summary', format(
      'Licenses monitor: %s expiration alerts, %s CE-shortfall alerts, %s already-alerted skipped.',
      v_inserted, v_ce_inserted, v_skipped
    ),
    'detail', jsonb_build_object(
      'expiration_alerts', v_inserted,
      'ce_alerts',         v_ce_inserted,
      'skipped',           v_skipped,
      'horizon_days',      60
    )
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.handler_licenses_expiration_monitor(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handler_licenses_expiration_monitor(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.handler_licenses_expiration_monitor(uuid, uuid) IS
  'Recipe-contract adapter matching run_internal_recipe signature. Iterates v_expiring_licenses and inserts idempotent alerts into public.alerts for both expiration and CE shortfall events. Fails soft if Base alerts table/schema absent.';

-- ============================================================================
-- 9. Recipe seed — monthly cron
-- ============================================================================
-- Runs 08:00 UTC on the 1st of each month. Staggered 1 hour after
-- Milestones (which runs at 07:00) to spread recipe load across the
-- BCC's automation-runner cycle.

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
    'Premium Licenses Expiration Monitor',
    'Monthly job that stages alerts for producer licenses expiring in the next 60 days AND CE-hour shortfalls. Idempotent — re-runs will not create duplicate alerts. Ships with bcc-premium-overlay v0.5.3 via handler_licenses_expiration_monitor. Alerts flow through Base Alerts & Notifications module.',
    'cron',
    '0 8 1 * *',
    'INTERNAL',
    NULL,
    'handler_licenses_expiration_monitor',
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
    'migration',        '108_premium_licenses',
    'overlay_version',  '0.5.3',
    'ships_module',     'Module 08 — Licenses',
    'spec_ref',         '§4.8',
    'manager_gate_default', 'true (deliberate B.11 deviation, locked 2026-07-10)',
    'applied_at',       now()
  )
);

COMMIT;

-- =============================================================================
-- Verification (run manually after apply)
-- =============================================================================
--
-- 1. producer_licenses table + UNIQUE constraint:
--    SELECT conname FROM pg_constraint
--     WHERE conrelid = 'public.producer_licenses'::regclass
--       AND contype = 'u';
--    Expected: producer_licenses_unique_credential.
--
-- 2. Manager gate function present and returns boolean:
--    SELECT public.is_licenses_manager();
--    Expected: false (from unauthenticated context) or true/false based on caller.
--
-- 3. Settings toggle seeded as TRUE:
--    SELECT setting_key, setting_value FROM public.settings
--     WHERE setting_key = 'enable_licenses_manager_access';
--    Expected: setting_value = 'true'.
--
-- 4. View computes expiring licenses:
--    SELECT staff_id, license_type, urgency, days_until_expiration, ce_behind
--      FROM public.v_expiring_licenses LIMIT 10;
--    Expected: 0+ rows depending on producer_licenses population.
--
-- 5. Recipe row present and scheduled:
--    SELECT recipe_name, cron_expression, internal_handler, is_active
--      FROM public.automation_recipes
--     WHERE recipe_name = 'Premium Licenses Expiration Monitor';
--    Expected: is_active=true, cron_expression='0 8 1 * *'.
--
-- 6. Dry-run handler:
--    SELECT public.handler_licenses_expiration_monitor(
--      '<agency_id>'::uuid,
--      (SELECT id FROM public.automation_recipes
--        WHERE recipe_name='Premium Licenses Expiration Monitor' LIMIT 1)
--    );
--    Expected: {records_processed: N, output_summary: "..."} — or soft-fail
--    diagnostic if Base's alerts table not yet present.
