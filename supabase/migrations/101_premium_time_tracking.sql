-- ==========================================================================
-- Migration 101 — Premium Time Tracking (compliance-safe hours-summary log)
-- ============================================================================
-- Overlay:      bcc-premium-overlay v0.5.6
-- Spec:         PROMO_TO_BUILD_SPEC.md §4.1 (Module 01) + Part I §1
-- Ships module: Module 01 — Time Tracking (8 of 10 for v1.0)
-- Runs after:   100_base_compat_shim, 100a_premium_auto_provisioning,
--               100b_auth_provisioner_helpers, 100e_base_helpers_shim
-- Depends on:   public.agency, public.staff (Base), public.settings (Base),
--               public.current_staff_id() (overlay 100e),
--               public.staff.auth_user_id (overlay 100a),
--               public.staff.status         (overlay 100a),
--               public._install_provenance  (Base 000)
--
-- ============================================================================
-- §1. WHY THIS MODULE EXISTS
-- ============================================================================
-- Producers log hours-per-day-per-category so the agency owner and office
-- manager can see where staff time actually goes. This is the coaching
-- companion to Sales Activity (§4.2): activity tells you WHAT they did,
-- Time Tracking tells you HOW MUCH TIME they spent doing it. Together they
-- answer "is this producer under-logging or over-servicing?" and feed
-- Scoreboard (§4.3) with the hour-based tiles.
--
-- The database is structured so that customer PII cannot land in this
-- table even accidentally. That is an engineering concern, not a legal
-- disclaimer: the table shape itself makes it impossible to log a
-- customer's name, phone, address, DOB, policy number, VIN, or any other
-- identifying information. Producers log entry_date, activity_category,
-- and hours — never customer identifiers.
--
-- ============================================================================
-- §2. HOURS-SUMMARY DESIGN CHOICE (locked with Rebecca 2026-07-11)
-- ============================================================================
-- Spec §4.1 was written with a clock-in/clock-out shape (start_time,
-- end_time, live clock). At session ratification Rebecca chose the
-- HOURS-SUMMARY variant instead: producer enters "Tuesday: 3.5h
-- sales_activity, 1h training" at end of day, one row per
-- (producer, date, category) with a UNIQUE constraint. Rationale:
--   * Producers spend the day on customer calls; babysitting a live clock
--     is friction that competes for attention.
--   * Hours-summary matches how agencies already track time in most
--     small-business timesheet tools (Gusto, ADP, spreadsheets).
--   * Scoreboard aggregation is simpler on aggregated rows.
--   * Missing-day alerts (see §11) do the work that "forgot to clock out"
--     would have done in the clock model.
--
-- The shape lost by this choice: exact within-day time windows (start of
-- lunch break, end of last call). If a future agency needs that, it lives
-- in a separate detail table, not this one.
--
-- ============================================================================
-- §3. B.11 PRODUCER ISOLATION — DELIBERATE TRUE DEFAULT (documented deviation)
-- ============================================================================
-- Canonical B.11 says manager gates default FALSE. Time Tracking flips to
-- TRUE because leadership visibility over hours-per-activity is the entire
-- reason the module exists. Owners and managers use this data to coach
-- ("you spent 15h on service last week, only 3h prospecting — let's
-- rebalance") and to catch problems before they compound (a producer
-- logging zero hours for a week is either PTO nobody logged or a warning
-- sign). Without cross-producer visibility there is no coaching signal.
-- Individual agencies that want stricter isolation can flip the setting
-- to 'false' in their public.settings row.
--
-- This is the third documented TRUE-default exception in the overlay
-- (after Licenses §4.8, Handbook §4.5, and Sales Activity §4.2). Setting
-- key: enable_time_tracking_manager_access.
--
-- ============================================================================
-- §4. COMPLIANCE-SAFE COLUMN DISCIPLINE (Part I §1)
-- =============================================================================
-- ALLOWED columns: id, agency_id, producer_id, entry_date, hours,
-- activity_category, notes, created_at, updated_at.
--
-- FORBIDDEN — any of these appearing here is a schema-level compliance
-- incident and MUST be caught before commit: customer_name, insured_name,
-- policyholder_name, contact_name, customer_email, customer_phone,
-- customer_address, customer_dob, customer_ssn, customer_drivers_license,
-- customer_vin, vin, license_plate, customer_policy_number, policy_number
-- (in customer context), customer_claim_number, claim_number. No JSONB
-- "metadata" column (would circumvent column-level enforcement). No FK to
-- a hypothetical customer table (no such table exists in Base or overlay,
-- by design).
--
-- The single free-text field (notes) is hard-capped at 200 chars and
-- carries a UI-level PII warning on every form. The webapp additionally
-- runs a client-side regex lint on notes as a soft warning
-- (phone / VIN / policy-number / email patterns).
--
-- ============================================================================
-- §5. EDIT/DELETE WINDOWS (client-side enforced per Rebecca's Q8 decision)
-- ============================================================================
-- Producer edit own row:    within current calendar week (Mon 00:00 through
--                            Sun 23:59:59 of the ongoing week)
-- Producer delete own row:  within 24 hours of creation (typo escape hatch)
-- Owner / Office Manager:   edit + delete anytime, cross-producer, in-agency
--
-- These rules are enforced CLIENT-SIDE (see TimeTracking.jsx). The database
-- accepts writes from any authorized RLS caller. Agency-specific policy can
-- override the client rules in webapp customization. Server-side hardening
-- (trigger-based) is a follow-on if any customer's audit review demands it.
--
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- §6. Table: public.time_tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.time_tracking (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id         UUID          NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  producer_id       UUID          NOT NULL REFERENCES public.staff(id)  ON DELETE RESTRICT,
  entry_date        DATE          NOT NULL DEFAULT CURRENT_DATE,
  hours             NUMERIC(4,2)  NOT NULL,
  activity_category TEXT          NOT NULL,
  notes             VARCHAR(200),
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT time_tracking_hours_positive_chk       CHECK (hours > 0),
  CONSTRAINT time_tracking_hours_daily_cap_chk      CHECK (hours <= 24),
  CONSTRAINT time_tracking_entry_date_not_future_chk CHECK (entry_date <= CURRENT_DATE),
  CONSTRAINT time_tracking_activity_category_chk    CHECK (activity_category IN (
    'sales_activity','service_activity','admin','training','meeting','break','other'
  )),
  CONSTRAINT time_tracking_one_row_per_day_category_uq
    UNIQUE (producer_id, entry_date, activity_category)
  -- Note: producer_id / agency_id alignment is enforced by
  -- enforce_time_tracking_producer_agency() trigger below.
);

COMMENT ON TABLE public.time_tracking IS
  'Producer hours-per-day-per-category log. Compliance-safe by design: schema physically prohibits customer PII. Hours-summary shape (aggregated per day per category, not live clock-in/out) — see migration 101 header §2 for rationale. UNIQUE (producer_id, entry_date, activity_category) means editing today''s Sales Activity hours updates the existing row rather than adding a duplicate. Read by Scoreboard (§4.3) via office aggregate functions.';

COMMENT ON COLUMN public.time_tracking.hours IS
  'Hours worked in this activity category on this date. NUMERIC(4,2) permits 0.25-hour granularity up to 99.99 (daily cap 24 enforced by CHECK). Producers typically enter in 0.25 or 0.5 increments.';

COMMENT ON COLUMN public.time_tracking.notes IS
  'Producer''s private notes on the day/category ("prep for offsite Thursday", "learned new SF quoting tool"). VARCHAR(200). UI must display Part I §1 PII warning on every form containing this field. NEVER a customer name, address, phone, policy number, or any identifier.';

CREATE INDEX IF NOT EXISTS idx_time_tracking_agency_date
  ON public.time_tracking(agency_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_time_tracking_producer_date
  ON public.time_tracking(producer_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_time_tracking_agency_category_date
  ON public.time_tracking(agency_id, activity_category, entry_date DESC);

-- ---------------------------------------------------------------------------
-- §7. Producer/agency alignment trigger (prevents cross-tenant abuse)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_time_tracking_producer_agency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  producer_agency UUID;
BEGIN
  SELECT agency_id INTO producer_agency
    FROM public.staff
   WHERE id = NEW.producer_id;

  IF producer_agency IS NULL THEN
    RAISE EXCEPTION 'time_tracking: producer_id % does not exist in public.staff', NEW.producer_id
      USING ERRCODE = '23503';
  END IF;

  IF producer_agency <> NEW.agency_id THEN
    RAISE EXCEPTION 'time_tracking: producer_id % belongs to agency %, cannot log hours to agency %',
      NEW.producer_id, producer_agency, NEW.agency_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_time_tracking_producer_agency ON public.time_tracking;
CREATE TRIGGER trg_time_tracking_producer_agency
  BEFORE INSERT OR UPDATE OF producer_id, agency_id ON public.time_tracking
  FOR EACH ROW EXECUTE FUNCTION public.enforce_time_tracking_producer_agency();

-- ---------------------------------------------------------------------------
-- §8. updated_at auto-touch trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_time_tracking_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_time_tracking_touch_updated_at ON public.time_tracking;
CREATE TRIGGER trg_time_tracking_touch_updated_at
  BEFORE UPDATE ON public.time_tracking
  FOR EACH ROW EXECUTE FUNCTION public.touch_time_tracking_updated_at();

-- ---------------------------------------------------------------------------
-- §9. Manager-gate function (B.11 TRUE-default deviation — see header §3)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_time_tracking_manager()
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
        WHERE setting_key = 'enable_time_tracking_manager_access'
        LIMIT 1),
      true  -- DELIBERATE deviation from canonical B.11 FALSE default. See migration header §3.
    );
$fn$;

REVOKE ALL ON FUNCTION public.is_time_tracking_manager() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_time_tracking_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_time_tracking_manager() TO service_role;

COMMENT ON FUNCTION public.is_time_tracking_manager() IS
  'B.11 manager gate for Time Tracking. Returns TRUE when caller has role=Office Manager AND status=active AND the enable_time_tracking_manager_access setting is true (defaults TRUE — see migration 101 header §3 for rationale). Individual agencies can flip the setting to false for stricter isolation.';

-- ---------------------------------------------------------------------------
-- §10. Settings INSERT — one row per agency
-- ---------------------------------------------------------------------------
INSERT INTO public.settings (agency_id, setting_key, setting_value, description)
SELECT
  a.id,
  'enable_time_tracking_manager_access',
  'true',
  'Producer Isolation Principle B.11 manager gate for Time Tracking module. When true, staff with role=Office Manager can see all producers'' hours-per-category for coaching and team management. DEFAULTS TRUE (deliberate deviation from canonical B.11 FALSE) — leadership visibility over hours-per-activity is the module''s core purpose. Flip to ''false'' to enforce strict per-producer isolation on this agency.'
FROM public.agency a
ON CONFLICT (agency_id, setting_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- §11. RLS: owner-all, manager-gated-all, producer-own-only
-- ---------------------------------------------------------------------------
ALTER TABLE public.time_tracking ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS time_tracking_owner_all      ON public.time_tracking;
DROP POLICY IF EXISTS time_tracking_manager_all    ON public.time_tracking;
DROP POLICY IF EXISTS time_tracking_producer_own   ON public.time_tracking;

-- Owner: full access within their own agency
CREATE POLICY time_tracking_owner_all
  ON public.time_tracking
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
         AND s.role         = 'Owner / Agent'
         AND s.status       = 'active'
         AND s.agency_id    = time_tracking.agency_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
         AND s.role         = 'Owner / Agent'
         AND s.status       = 'active'
         AND s.agency_id    = time_tracking.agency_id
    )
  );

-- Manager (gated): full access within their own agency when gate is on
CREATE POLICY time_tracking_manager_all
  ON public.time_tracking
  FOR ALL
  TO authenticated
  USING (
    public.is_time_tracking_manager()
    AND agency_id = (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
       LIMIT 1
    )
  )
  WITH CHECK (
    public.is_time_tracking_manager()
    AND agency_id = (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
       LIMIT 1
    )
  );

-- Producer (and any other role): own rows only
CREATE POLICY time_tracking_producer_own
  ON public.time_tracking
  FOR ALL
  TO authenticated
  USING (producer_id = public.current_staff_id())
  WITH CHECK (producer_id = public.current_staff_id());

-- ---------------------------------------------------------------------------
-- §12. Rollup views (inherit RLS from time_tracking + staff)
--
--   These views back producer-personal and manager/owner detail dashboards.
--   RLS on time_tracking carries through: producers see rows for their own
--   producer_id only; managers (when gated) and owners see all rows in
--   their agency. Missing-day view additionally reads staff — same RLS
--   story applies via staff's own policies.
-- ---------------------------------------------------------------------------

-- 12a. Weekly per-producer per-category (rolling 12 weeks)
CREATE OR REPLACE VIEW public.v_time_tracking_weekly_by_producer AS
SELECT
  tt.agency_id,
  tt.producer_id,
  date_trunc('week', tt.entry_date)::DATE AS week_starting,
  tt.activity_category,
  SUM(tt.hours)::NUMERIC(6,2)             AS total_hours,
  COUNT(*)::INT                            AS entry_count
FROM public.time_tracking tt
WHERE tt.entry_date >= (CURRENT_DATE - INTERVAL '84 days')
GROUP BY tt.agency_id, tt.producer_id, date_trunc('week', tt.entry_date), tt.activity_category;

COMMENT ON VIEW public.v_time_tracking_weekly_by_producer IS
  'Rolling 12-week per-producer per-category total hours. RLS inherits from time_tracking. Backs producer weekly hours tile, 8-week trend chart, and manager/owner cross-producer weekly comparison. Column names week_starting matches Sales Activity view convention.';

-- 12b. Monthly per-producer per-category (rolling 12 months, Scoreboard-ready)
CREATE OR REPLACE VIEW public.v_time_tracking_monthly_by_producer AS
SELECT
  tt.agency_id,
  tt.producer_id,
  date_trunc('month', tt.entry_date)::DATE AS month_starting,
  tt.activity_category,
  SUM(tt.hours)::NUMERIC(6,2)              AS total_hours,
  COUNT(*)::INT                             AS entry_count
FROM public.time_tracking tt
WHERE tt.entry_date >= (CURRENT_DATE - INTERVAL '12 months')
GROUP BY tt.agency_id, tt.producer_id, date_trunc('month', tt.entry_date), tt.activity_category;

COMMENT ON VIEW public.v_time_tracking_monthly_by_producer IS
  'Rolling 12-month per-producer per-category total hours. Wide shape deliberately chosen so Scoreboard (§4.3) can GROUP BY any dimension combination without a new view. RLS inherits from time_tracking. Column name month_starting matches Sales Activity view convention.';

-- 12c. Category MTD (agency-wide summary — supports category mix chart)
CREATE OR REPLACE VIEW public.v_time_tracking_category_mtd AS
SELECT
  tt.agency_id,
  tt.activity_category,
  SUM(tt.hours)::NUMERIC(8,2) AS total_hours,
  COUNT(*)::INT                AS entry_count,
  COUNT(DISTINCT tt.producer_id)::INT AS producer_count
FROM public.time_tracking tt
WHERE tt.entry_date >= date_trunc('month', CURRENT_DATE)::DATE
GROUP BY tt.agency_id, tt.activity_category;

COMMENT ON VIEW public.v_time_tracking_category_mtd IS
  'Month-to-date category breakdown per agency. RLS inherits from time_tracking. Backs the "where does the team spend its time" pie/bar chart on owner/manager surface.';

-- 12d. Missing-day tracker (Q9 hours-summary translation of "auto-close")
--
--   Lists workdays (Mon-Fri) in the last 14 days where a producer logged
--   zero hours. Frontend uses this to render:
--     * Producer's own surface: "you're missing Tuesday and Wednesday"
--     * Owner/manager surface: "past-due timesheets" card listing producers
--       with any missing days in current or prior week
--
--   Workday = Mon-Fri (EXTRACT(DOW) BETWEEN 1 AND 5). No holiday calendar
--   awareness — if an agency has a Monday holiday, producers may be flagged
--   for that day; owner sees and mentally dismisses. If a customer's audit
--   demands holiday awareness, adds a second view sourced from a holidays
--   table (deferred; keeps this shipping fast).
--
--   Window is the last 14 days ending YESTERDAY. Today is never flagged
--   as missing (producer still has time to log).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_time_tracking_missing_days_by_producer AS
WITH workday_series AS (
  SELECT d::DATE AS workday
    FROM generate_series(
           (CURRENT_DATE - INTERVAL '14 days')::DATE,
           (CURRENT_DATE - INTERVAL '1 day')::DATE,
           '1 day'::INTERVAL
         ) AS d
   WHERE EXTRACT(DOW FROM d) BETWEEN 1 AND 5   -- Mon=1, Fri=5
),
staff_workdays AS (
  SELECT s.id       AS producer_id,
         s.agency_id,
         w.workday
    FROM public.staff s
   CROSS JOIN workday_series w
   WHERE s.status = 'active'
),
logged AS (
  SELECT DISTINCT producer_id, entry_date
    FROM public.time_tracking
   WHERE entry_date >= (CURRENT_DATE - INTERVAL '14 days')
)
SELECT
  sw.agency_id,
  sw.producer_id,
  sw.workday        AS missing_date,
  EXTRACT(DOW FROM sw.workday)::INT AS day_of_week,
  (CURRENT_DATE - sw.workday)       AS days_ago
FROM staff_workdays sw
LEFT JOIN logged l
  ON l.producer_id = sw.producer_id
 AND l.entry_date  = sw.workday
WHERE l.entry_date IS NULL;

COMMENT ON VIEW public.v_time_tracking_missing_days_by_producer IS
  'Producer workdays (Mon-Fri) in the last 14 days with zero logged hours. Feeds the missing-day reminder on producer surface and the past-due-timesheets card on owner/manager surface. Yesterday is the most recent flagged day (today is never flagged). No holiday awareness — see migration 101 §12d for rationale. RLS inherits from time_tracking and staff via the underlying joins.';

-- ---------------------------------------------------------------------------
-- §13. Office aggregate SECURITY DEFINER functions
--
--   These functions bypass RLS to compute agency-wide totals that every
--   authenticated caller (including producers/employees) can see without
--   exposing per-producer breakdowns. Cross-tenant safety is enforced by
--   verifying the caller's staff row belongs to the requested agency_id
--   before returning any data.
-- ---------------------------------------------------------------------------

-- 13a. Weekly office totals (last 7 days)
CREATE OR REPLACE FUNCTION public.get_office_time_weekly(p_agency_id UUID)
RETURNS TABLE (
  window_label        TEXT,
  window_start        DATE,
  window_end          DATE,
  total_hours         NUMERIC,
  sales_activity_hrs  NUMERIC,
  service_hrs         NUMERIC,
  admin_hrs           NUMERIC,
  training_hrs        NUMERIC,
  meeting_hrs         NUMERIC,
  break_hrs           NUMERIC,
  other_hrs           NUMERIC,
  active_producers    INT,
  by_category         JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  caller_agency UUID;
BEGIN
  SELECT s.agency_id INTO caller_agency
    FROM public.staff s
   WHERE s.auth_user_id = auth.uid()
     AND s.status       = 'active'
   LIMIT 1;

  IF caller_agency IS NULL OR caller_agency <> p_agency_id THEN
    RAISE EXCEPTION 'get_office_time_weekly: caller does not belong to agency %', p_agency_id
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH win AS (
    SELECT (CURRENT_DATE - INTERVAL '6 days')::DATE AS w_start,
           CURRENT_DATE                              AS w_end
  ),
  base AS (
    SELECT tt.*
      FROM public.time_tracking tt, win
     WHERE tt.agency_id = p_agency_id
       AND tt.entry_date >= win.w_start
       AND tt.entry_date <= win.w_end
  ),
  by_cat_agg AS (
    SELECT COALESCE(
             jsonb_object_agg(activity_category, hrs),
             '{}'::jsonb
           ) AS by_cat_json
      FROM (
        SELECT activity_category, SUM(hours)::NUMERIC(8,2) AS hrs
          FROM base
         GROUP BY activity_category
      ) x
  )
  SELECT
    'This Week (last 7 days)'::TEXT                                                                                       AS window_label,
    (SELECT w_start FROM win)                                                                                              AS window_start,
    (SELECT w_end   FROM win)                                                                                              AS window_end,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2)                                          FROM base), 0)::NUMERIC              AS total_hours,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2) FROM base WHERE activity_category = 'sales_activity'),   0)::NUMERIC          AS sales_activity_hrs,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2) FROM base WHERE activity_category = 'service_activity'), 0)::NUMERIC          AS service_hrs,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2) FROM base WHERE activity_category = 'admin'),            0)::NUMERIC          AS admin_hrs,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2) FROM base WHERE activity_category = 'training'),         0)::NUMERIC          AS training_hrs,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2) FROM base WHERE activity_category = 'meeting'),          0)::NUMERIC          AS meeting_hrs,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2) FROM base WHERE activity_category = 'break'),            0)::NUMERIC          AS break_hrs,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2) FROM base WHERE activity_category = 'other'),            0)::NUMERIC          AS other_hrs,
    COALESCE((SELECT COUNT(DISTINCT producer_id)::INT                                  FROM base), 0)                       AS active_producers,
    (SELECT by_cat_json FROM by_cat_agg)                                                                                    AS by_category;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_office_time_weekly(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_office_time_weekly(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_office_time_weekly(UUID) TO service_role;

COMMENT ON FUNCTION public.get_office_time_weekly(UUID) IS
  'Agency-wide hours totals for the last 7 days. Safe to expose to every authenticated caller including producers/employees — returns no per-producer names or breakdowns, only aggregate hours and active-producer count. Cross-tenant guard: raises 42501 if caller''s staff.agency_id does not match p_agency_id.';

-- 13b. Monthly office totals (MTD)
CREATE OR REPLACE FUNCTION public.get_office_time_monthly(p_agency_id UUID)
RETURNS TABLE (
  window_label        TEXT,
  window_start        DATE,
  window_end          DATE,
  total_hours         NUMERIC,
  sales_activity_hrs  NUMERIC,
  service_hrs         NUMERIC,
  admin_hrs           NUMERIC,
  training_hrs        NUMERIC,
  meeting_hrs         NUMERIC,
  break_hrs           NUMERIC,
  other_hrs           NUMERIC,
  active_producers    INT,
  by_category         JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  caller_agency UUID;
BEGIN
  SELECT s.agency_id INTO caller_agency
    FROM public.staff s
   WHERE s.auth_user_id = auth.uid()
     AND s.status       = 'active'
   LIMIT 1;

  IF caller_agency IS NULL OR caller_agency <> p_agency_id THEN
    RAISE EXCEPTION 'get_office_time_monthly: caller does not belong to agency %', p_agency_id
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH win AS (
    SELECT date_trunc('month', CURRENT_DATE)::DATE AS w_start,
           CURRENT_DATE                             AS w_end
  ),
  base AS (
    SELECT tt.*
      FROM public.time_tracking tt, win
     WHERE tt.agency_id = p_agency_id
       AND tt.entry_date >= win.w_start
       AND tt.entry_date <= win.w_end
  ),
  by_cat_agg AS (
    SELECT COALESCE(
             jsonb_object_agg(activity_category, hrs),
             '{}'::jsonb
           ) AS by_cat_json
      FROM (
        SELECT activity_category, SUM(hours)::NUMERIC(8,2) AS hrs
          FROM base
         GROUP BY activity_category
      ) x
  )
  SELECT
    'This Month (MTD)'::TEXT                                                                                              AS window_label,
    (SELECT w_start FROM win)                                                                                              AS window_start,
    (SELECT w_end   FROM win)                                                                                              AS window_end,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2)                                          FROM base), 0)::NUMERIC              AS total_hours,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2) FROM base WHERE activity_category = 'sales_activity'),   0)::NUMERIC          AS sales_activity_hrs,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2) FROM base WHERE activity_category = 'service_activity'), 0)::NUMERIC          AS service_hrs,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2) FROM base WHERE activity_category = 'admin'),            0)::NUMERIC          AS admin_hrs,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2) FROM base WHERE activity_category = 'training'),         0)::NUMERIC          AS training_hrs,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2) FROM base WHERE activity_category = 'meeting'),          0)::NUMERIC          AS meeting_hrs,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2) FROM base WHERE activity_category = 'break'),            0)::NUMERIC          AS break_hrs,
    COALESCE((SELECT SUM(hours)::NUMERIC(8,2) FROM base WHERE activity_category = 'other'),            0)::NUMERIC          AS other_hrs,
    COALESCE((SELECT COUNT(DISTINCT producer_id)::INT                                  FROM base), 0)                       AS active_producers,
    (SELECT by_cat_json FROM by_cat_agg)                                                                                    AS by_category;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_office_time_monthly(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_office_time_monthly(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_office_time_monthly(UUID) TO service_role;

COMMENT ON FUNCTION public.get_office_time_monthly(UUID) IS
  'Agency-wide hours totals month-to-date. Safe to expose to every authenticated caller including producers/employees — returns no per-producer names or breakdowns, only aggregate hours and active-producer count. Cross-tenant guard: raises 42501 if caller''s staff.agency_id does not match p_agency_id.';

-- ---------------------------------------------------------------------------
-- §14. Provenance
-- ---------------------------------------------------------------------------
INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration',              '101_premium_time_tracking',
    'overlay_version',        '0.5.6',
    'ships_module',           'Module 01 — Time Tracking',
    'spec_ref',               '§4.1 + Part I §1',
    'shape_choice',           'hours-summary (not clock-in/out — locked 2026-07-11 with Rebecca; see migration 101 header §2)',
    'manager_gate_default',   'true (deliberate B.11 deviation, locked 2026-07-11; see migration 101 header §3)',
    'compliance_notes',       'schema-level customer PII prohibition; VARCHAR(200) hard cap on notes; CHECK constraints on activity_category + hours range + entry_date not-future; UNIQUE (producer_id, entry_date, activity_category); SECURITY DEFINER office aggregates with cross-tenant guards',
    'views_shipped',          jsonb_build_array(
                                'v_time_tracking_weekly_by_producer',
                                'v_time_tracking_monthly_by_producer',
                                'v_time_tracking_category_mtd',
                                'v_time_tracking_missing_days_by_producer'
                              ),
    'functions_shipped',      jsonb_build_array(
                                'is_time_tracking_manager()',
                                'get_office_time_weekly(UUID)',
                                'get_office_time_monthly(UUID)',
                                'enforce_time_tracking_producer_agency()',
                                'touch_time_tracking_updated_at()'
                              ),
    'applied_at',             now()
  )
);

COMMIT;

-- =============================================================================
-- §15. Verification (run manually after apply)
-- =============================================================================
--
-- 1. Table shape matches spec (9 columns including agency_id):
--    SELECT column_name, data_type, character_maximum_length, is_nullable
--      FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='time_tracking'
--     ORDER BY ordinal_position;
--    Expected: 9 rows exactly. notes max_length=200. hours numeric_precision=4, scale=2.
--
-- 2. No forbidden columns present:
--    SELECT column_name FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='time_tracking'
--       AND column_name ~* '(customer|policy_number|vin|dob|ssn|insured|policyholder|contact|claim)';
--    Expected: 0 rows.
--
-- 3. CHECK constraints present (4 CHECKs: hours_positive, hours_daily_cap,
--    entry_date_not_future, activity_category):
--    SELECT conname FROM pg_constraint
--     WHERE conrelid = 'public.time_tracking'::regclass AND contype = 'c'
--     ORDER BY conname;
--    Expected: 4 rows.
--
-- 4. UNIQUE constraint (producer_id, entry_date, activity_category):
--    SELECT conname FROM pg_constraint
--     WHERE conrelid = 'public.time_tracking'::regclass AND contype = 'u';
--    Expected: 1 row (time_tracking_one_row_per_day_category_uq).
--
-- 5. Manager gate function returns TRUE by default for an Office Manager,
--    and cross-tenant guard raises 42501 for foreign agency:
--    SELECT public.is_time_tracking_manager();  -- from a Manager auth session
--    SELECT public.get_office_time_weekly('<foreign agency id>'::UUID);
--    Expected: manager -> true; foreign agency call -> 42501 exception.
--
-- 6. Settings row exists per agency:
--    SELECT COUNT(*) FROM public.settings WHERE setting_key='enable_time_tracking_manager_access';
--    Expected: equal to (SELECT COUNT(*) FROM public.agency).
--
-- 7. Provenance row landed:
--    SELECT event_data->>'migration' FROM public._install_provenance
--     WHERE event_data->>'migration' = '101_premium_time_tracking';
--    Expected: one row.
--
-- 8. Missing-day view returns expected pattern for a producer with no
--    entries in the last 14 days:
--    SELECT * FROM public.v_time_tracking_missing_days_by_producer
--     WHERE producer_id = '<producer_id>';
--    Expected: ~10 rows (Mon-Fri workdays in last 14 days minus today).
-- =============================================================================
