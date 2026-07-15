-- ==========================================================================
-- Migration 102 — Premium Sales Activity (HIGH-STAKES COMPLIANCE MODULE)
-- ============================================================================
-- Overlay:      bcc-premium-overlay v0.5.5
-- Spec:         PROMO_TO_BUILD_SPEC.md §4.2 (Module 02) + Part I §1
-- Ships module: Module 02 — Sales Activity (7 of 10 for v1.0)
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
-- Producers need a lightweight way to log daily activity (quotes issued, apps
-- submitted, policies bound, cross-sells, life apps, FS referrals, account
-- rounds, etc.) so the agency owner and office manager can see production
-- volume and coach the team. The Scoreboard module (§4.3) will surface this
-- data back to producers in an engaging, game-board format that celebrates
-- wins and shows progress toward Milestones targets.
--
-- The database is structured so that customer PII cannot land in this table
-- even accidentally. That is an engineering concern, not a legal disclaimer:
-- the table shape itself makes it impossible to log a customer's name, phone,
-- address, DOB, policy number, VIN, or any other identifying information.
-- Producers log activity type, outcome, and premium band — never customer
-- identifiers.
--
-- ============================================================================
-- §2. B.11 PRODUCER ISOLATION — DELIBERATE TRUE DEFAULT (documented deviation)
-- ============================================================================
-- Canonical B.11 says manager gates default FALSE. Sales Activity flips to
-- TRUE because leadership visibility over production is the entire reason
-- the module exists. The office manager coaches producers, spots activity
-- drops, and rebalances the team's book. Without cross-producer visibility
-- there is no coaching signal. Individual agencies that want stricter
-- isolation can flip the setting to 'false' in their public.settings row.
--
-- This is the third documented TRUE-default exception (after Licenses §4.8
-- and Handbook §4.5). Setting key: enable_sales_activity_manager_access.
--
-- ============================================================================
-- §3. COMPLIANCE-SAFE COLUMN DISCIPLINE (Part I §1)
-- =============================================================================
-- ALLOWED columns: id, agency_id, producer_id, activity_date, activity_type,
-- line_of_business, outcome, premium_band, new_household, internal_reference,
-- notes, created_at, updated_at.
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
-- Free-text fields (internal_reference, notes) are hard-capped at 50 / 200
-- chars respectively and carry UI-level PII warnings on every form. The
-- webapp additionally runs a client-side regex lint on these fields as a
-- soft warning (phone / VIN / policy-number patterns).
--
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- §4. Table: public.sales_activity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sales_activity (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id          UUID          NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  producer_id        UUID          NOT NULL REFERENCES public.staff(id)  ON DELETE RESTRICT,
  activity_date      DATE          NOT NULL DEFAULT CURRENT_DATE,
  activity_type      TEXT          NOT NULL,
  line_of_business   TEXT          NOT NULL,
  outcome            TEXT          NOT NULL,
  premium_band       TEXT,
  new_household      BOOLEAN,
  internal_reference VARCHAR(50),
  notes              VARCHAR(200),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT sales_activity_activity_type_chk CHECK (activity_type IN (
    'quote_issued','app_submitted','policy_bound','cross_sell','life_app',
    'fs_referral','account_round','retention_call','service_touch',
    'prospecting_call','follow_up','claims_handling','other'
  )),
  CONSTRAINT sales_activity_lob_chk CHECK (line_of_business IN (
    'auto','fire','life','health','bank','financial_services','other'
  )),
  CONSTRAINT sales_activity_outcome_chk CHECK (outcome IN (
    'bound','pending','follow_up','lost','n_a'
  )),
  CONSTRAINT sales_activity_premium_band_chk CHECK (
    premium_band IS NULL OR premium_band IN (
      'under_500','500_to_1000','1000_plus','n_a'
    )
  )
  -- Note: producer_id / agency_id alignment is enforced by
  -- enforce_sales_activity_producer_agency() trigger below.
);

COMMENT ON TABLE public.sales_activity IS
  'Producer activity log (quotes, apps, bound policies, cross-sells, life apps, FS referrals, account rounds, etc.). Compliance-safe by design: schema physically prohibits customer PII. Free-text fields are capped and UI-warned. See migration 102 header §3 for full column discipline. Read by Scoreboard (§4.3) via office aggregate functions.';

COMMENT ON COLUMN public.sales_activity.internal_reference IS
  'Producer''s private shorthand for the activity ("fleet policy call", "back Thu"). VARCHAR(50). UI must display Part I §1 PII warning on every form containing this field. NEVER a customer name, address, phone, policy number, or any identifier.';

COMMENT ON COLUMN public.sales_activity.notes IS
  'Producer''s private notes on the activity ("quoted at renewal", "waiting on carrier UW"). VARCHAR(200). UI must display Part I §1 PII warning on every form containing this field. NEVER a customer name, address, phone, policy number, or any identifier.';

CREATE INDEX IF NOT EXISTS idx_sales_activity_agency_date
  ON public.sales_activity(agency_id, activity_date DESC);
CREATE INDEX IF NOT EXISTS idx_sales_activity_producer_date
  ON public.sales_activity(producer_id, activity_date DESC);
CREATE INDEX IF NOT EXISTS idx_sales_activity_agency_type_date
  ON public.sales_activity(agency_id, activity_type, activity_date DESC);

-- Producer/agency alignment enforced by trigger (staff.agency_id must match
-- sales_activity.agency_id — prevents cross-tenant row insertion via API abuse).
CREATE OR REPLACE FUNCTION public.enforce_sales_activity_producer_agency()
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
    RAISE EXCEPTION 'sales_activity: producer_id % does not exist in public.staff', NEW.producer_id
      USING ERRCODE = '23503';
  END IF;

  IF producer_agency <> NEW.agency_id THEN
    RAISE EXCEPTION 'sales_activity: producer_id % belongs to agency %, cannot log activity to agency %',
      NEW.producer_id, producer_agency, NEW.agency_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_activity_producer_agency ON public.sales_activity;
CREATE TRIGGER trg_sales_activity_producer_agency
  BEFORE INSERT OR UPDATE OF producer_id, agency_id ON public.sales_activity
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sales_activity_producer_agency();

-- ---------------------------------------------------------------------------
-- §5. updated_at auto-touch trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_sales_activity_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_activity_touch_updated_at ON public.sales_activity;
CREATE TRIGGER trg_sales_activity_touch_updated_at
  BEFORE UPDATE ON public.sales_activity
  FOR EACH ROW EXECUTE FUNCTION public.touch_sales_activity_updated_at();

-- ---------------------------------------------------------------------------
-- §6. Manager-gate function (B.11 TRUE-default deviation — see header §2)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_sales_activity_manager()
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
        WHERE setting_key = 'enable_sales_activity_manager_access'
        LIMIT 1),
      true  -- DELIBERATE deviation from canonical B.11 FALSE default. See migration header §2.
    );
$fn$;

REVOKE ALL ON FUNCTION public.is_sales_activity_manager() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_sales_activity_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_sales_activity_manager() TO service_role;

COMMENT ON FUNCTION public.is_sales_activity_manager() IS
  'B.11 manager gate for Sales Activity. Returns TRUE when caller has role=Office Manager AND status=active AND the enable_sales_activity_manager_access setting is true (defaults TRUE — see migration 102 header §2 for rationale). Individual agencies can flip the setting to false for stricter isolation.';

-- ---------------------------------------------------------------------------
-- §7. Settings INSERT — one row per agency
-- ---------------------------------------------------------------------------
INSERT INTO public.settings (agency_id, setting_key, setting_value, description)
SELECT
  a.id,
  'enable_sales_activity_manager_access',
  'true',
  'Producer Isolation Principle B.11 manager gate for Sales Activity module. When true, staff with role=Office Manager can see all producers'' activity for coaching and team management. DEFAULTS TRUE (deliberate deviation from canonical B.11 FALSE) — leadership visibility over production is the module''s core purpose. Flip to ''false'' to enforce strict per-producer isolation on this agency.'
FROM public.agency a
ON CONFLICT (agency_id, setting_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- §8. RLS: owner-all, manager-gated-all, producer-own-only
-- ---------------------------------------------------------------------------
ALTER TABLE public.sales_activity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sales_activity_owner_all      ON public.sales_activity;
DROP POLICY IF EXISTS sales_activity_manager_all    ON public.sales_activity;
DROP POLICY IF EXISTS sales_activity_producer_own   ON public.sales_activity;

-- Owner: full access within their own agency
CREATE POLICY sales_activity_owner_all
  ON public.sales_activity
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
         AND s.role         = 'Owner / Agent'
         AND s.status       = 'active'
         AND s.agency_id    = sales_activity.agency_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
         AND s.role         = 'Owner / Agent'
         AND s.status       = 'active'
         AND s.agency_id    = sales_activity.agency_id
    )
  );

-- Manager (gated): full access within their own agency when gate is on
CREATE POLICY sales_activity_manager_all
  ON public.sales_activity
  FOR ALL
  TO authenticated
  USING (
    public.is_sales_activity_manager()
    AND agency_id = (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
       LIMIT 1
    )
  )
  WITH CHECK (
    public.is_sales_activity_manager()
    AND agency_id = (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
       LIMIT 1
    )
  );

-- Producer (and any other role): own rows only
CREATE POLICY sales_activity_producer_own
  ON public.sales_activity
  FOR ALL
  TO authenticated
  USING (producer_id = public.current_staff_id())
  WITH CHECK (producer_id = public.current_staff_id());

-- ---------------------------------------------------------------------------
-- §9. Individual rollup views (inherit RLS from sales_activity)
--
--   These four views back the producer-personal and manager/owner detail
--   dashboards. RLS on sales_activity carries through: producers see rows
--   for their own producer_id only; managers (when gated) and owners see
--   all rows in their agency.
-- ---------------------------------------------------------------------------

-- 9a. Daily per-producer counts by activity_type (last 90 days rolling)
CREATE OR REPLACE VIEW public.v_sales_activity_daily_by_producer AS
SELECT
  sa.agency_id,
  sa.producer_id,
  sa.activity_date,
  sa.activity_type,
  COUNT(*)::INT AS activity_count
FROM public.sales_activity sa
WHERE sa.activity_date >= (CURRENT_DATE - INTERVAL '90 days')
GROUP BY sa.agency_id, sa.producer_id, sa.activity_date, sa.activity_type;

COMMENT ON VIEW public.v_sales_activity_daily_by_producer IS
  'Rolling 90-day daily activity counts per producer, split by activity_type. RLS inherits from sales_activity. Backs producer personal dashboard sparklines and manager/owner detail views.';

-- 9b. Weekly per-producer per-LOB (rolling 12 weeks)
CREATE OR REPLACE VIEW public.v_sales_activity_weekly_by_producer AS
SELECT
  sa.agency_id,
  sa.producer_id,
  date_trunc('week', sa.activity_date)::DATE AS week_starting,
  sa.line_of_business,
  COUNT(*)::INT                                       AS activity_count,
  COUNT(*) FILTER (WHERE sa.outcome = 'bound')::INT   AS bound_count,
  COUNT(*) FILTER (WHERE sa.outcome = 'pending')::INT AS pending_count
FROM public.sales_activity sa
WHERE sa.activity_date >= (CURRENT_DATE - INTERVAL '84 days')
GROUP BY sa.agency_id, sa.producer_id, date_trunc('week', sa.activity_date), sa.line_of_business;

COMMENT ON VIEW public.v_sales_activity_weekly_by_producer IS
  'Rolling 12-week per-producer per-LOB activity + bound/pending counts. RLS inherits from sales_activity. Backs producer weekly progress tiles and manager/owner LOB coaching views.';

-- 9c. Monthly per-producer × activity_type × LOB × outcome (Scoreboard-ready shape)
CREATE OR REPLACE VIEW public.v_sales_activity_monthly_by_producer AS
SELECT
  sa.agency_id,
  sa.producer_id,
  date_trunc('month', sa.activity_date)::DATE AS month_starting,
  sa.activity_type,
  sa.line_of_business,
  sa.outcome,
  COUNT(*)::INT AS activity_count
FROM public.sales_activity sa
WHERE sa.activity_date >= (CURRENT_DATE - INTERVAL '12 months')
GROUP BY sa.agency_id, sa.producer_id, date_trunc('month', sa.activity_date),
         sa.activity_type, sa.line_of_business, sa.outcome;

COMMENT ON VIEW public.v_sales_activity_monthly_by_producer IS
  'Rolling 12-month per-producer activity aggregated across all four dimensions (activity_type × LOB × outcome). Wide shape deliberately chosen so Scoreboard (§4.3) can GROUP BY any dimension combination without a new view. RLS inherits from sales_activity.';

-- 9d. Outcome distribution per producer, current month
CREATE OR REPLACE VIEW public.v_sales_activity_outcome_distribution AS
WITH cur AS (
  SELECT
    sa.agency_id,
    sa.producer_id,
    sa.outcome,
    COUNT(*)::INT AS n
  FROM public.sales_activity sa
  WHERE sa.activity_date >= date_trunc('month', CURRENT_DATE)::DATE
  GROUP BY sa.agency_id, sa.producer_id, sa.outcome
),
totals AS (
  SELECT agency_id, producer_id, SUM(n)::INT AS total_n
  FROM cur
  GROUP BY agency_id, producer_id
)
SELECT
  cur.agency_id,
  cur.producer_id,
  cur.outcome,
  cur.n                                                    AS activity_count,
  totals.total_n                                           AS producer_total,
  ROUND(100.0 * cur.n / NULLIF(totals.total_n, 0), 1)::NUMERIC(5,1) AS pct_of_total
FROM cur
JOIN totals USING (agency_id, producer_id);

COMMENT ON VIEW public.v_sales_activity_outcome_distribution IS
  'Current-month bound/pending/follow_up/lost/n_a distribution per producer with percentage. RLS inherits from sales_activity. Backs the manager/owner "who is closing vs who is quoting" view and the producer''s own outcome tile.';

-- ---------------------------------------------------------------------------
-- §10. Office aggregate SECURITY DEFINER functions
--
--   These functions bypass RLS to compute agency-wide totals that every
--   authenticated caller (including producers/employees) can see without
--   exposing per-producer names or breakdowns. Cross-tenant safety is
--   enforced by verifying the caller's staff row belongs to the requested
--   agency_id before returning any data.
-- ---------------------------------------------------------------------------

-- 10a. Weekly office totals (last 7 days)
CREATE OR REPLACE FUNCTION public.get_office_activity_weekly(p_agency_id UUID)
RETURNS TABLE (
  window_label      TEXT,
  window_start      DATE,
  window_end        DATE,
  total_activities  INT,
  quotes_issued     INT,
  apps_submitted    INT,
  policies_bound    INT,
  cross_sells       INT,
  life_apps         INT,
  fs_referrals      INT,
  account_rounds    INT,
  by_lob            JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  caller_agency UUID;
BEGIN
  -- Cross-tenant guard: caller must belong to the requested agency
  SELECT s.agency_id INTO caller_agency
    FROM public.staff s
   WHERE s.auth_user_id = auth.uid()
     AND s.status       = 'active'
   LIMIT 1;

  IF caller_agency IS NULL OR caller_agency <> p_agency_id THEN
    RAISE EXCEPTION 'get_office_activity_weekly: caller does not belong to agency %', p_agency_id
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH win AS (
    SELECT (CURRENT_DATE - INTERVAL '6 days')::DATE AS w_start,
           CURRENT_DATE                              AS w_end
  ),
  base AS (
    SELECT sa.*
      FROM public.sales_activity sa, win
     WHERE sa.agency_id     = p_agency_id
       AND sa.activity_date >= win.w_start
       AND sa.activity_date <= win.w_end
  ),
  by_lob_agg AS (
    SELECT COALESCE(
             jsonb_object_agg(line_of_business, cnt),
             '{}'::jsonb
           ) AS by_lob_json
      FROM (
        SELECT line_of_business, COUNT(*)::INT AS cnt
          FROM base
         GROUP BY line_of_business
      ) x
  )
  SELECT
    'This Week (last 7 days)'::TEXT                                                                AS window_label,
    (SELECT w_start FROM win)                                                                       AS window_start,
    (SELECT w_end   FROM win)                                                                       AS window_end,
    COALESCE((SELECT COUNT(*)::INT                                                    FROM base), 0) AS total_activities,
    COALESCE((SELECT COUNT(*)::INT FROM base WHERE activity_type = 'quote_issued'),   0)              AS quotes_issued,
    COALESCE((SELECT COUNT(*)::INT FROM base WHERE activity_type = 'app_submitted'),  0)              AS apps_submitted,
    COALESCE((SELECT COUNT(*)::INT FROM base WHERE activity_type = 'policy_bound'),   0)              AS policies_bound,
    COALESCE((SELECT COUNT(*)::INT FROM base WHERE activity_type = 'cross_sell'),     0)              AS cross_sells,
    COALESCE((SELECT COUNT(*)::INT FROM base WHERE activity_type = 'life_app'),       0)              AS life_apps,
    COALESCE((SELECT COUNT(*)::INT FROM base WHERE activity_type = 'fs_referral'),    0)              AS fs_referrals,
    COALESCE((SELECT COUNT(*)::INT FROM base WHERE activity_type = 'account_round'),  0)              AS account_rounds,
    (SELECT by_lob_json FROM by_lob_agg)                                                             AS by_lob;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_office_activity_weekly(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_office_activity_weekly(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_office_activity_weekly(UUID) TO service_role;

COMMENT ON FUNCTION public.get_office_activity_weekly(UUID) IS
  'Agency-wide activity totals for the last 7 days. Safe to expose to every authenticated caller including producers/employees — returns no per-producer names or breakdowns, only aggregate counts. Cross-tenant guard: raises 42501 if caller''s staff.agency_id does not match p_agency_id.';

-- 10b. Monthly office totals (MTD)
CREATE OR REPLACE FUNCTION public.get_office_activity_monthly(p_agency_id UUID)
RETURNS TABLE (
  window_label      TEXT,
  window_start      DATE,
  window_end        DATE,
  total_activities  INT,
  quotes_issued     INT,
  apps_submitted    INT,
  policies_bound    INT,
  cross_sells       INT,
  life_apps         INT,
  fs_referrals      INT,
  account_rounds    INT,
  by_lob            JSONB
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
    RAISE EXCEPTION 'get_office_activity_monthly: caller does not belong to agency %', p_agency_id
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH win AS (
    SELECT date_trunc('month', CURRENT_DATE)::DATE AS w_start,
           CURRENT_DATE                             AS w_end
  ),
  base AS (
    SELECT sa.*
      FROM public.sales_activity sa, win
     WHERE sa.agency_id     = p_agency_id
       AND sa.activity_date >= win.w_start
       AND sa.activity_date <= win.w_end
  ),
  by_lob_agg AS (
    SELECT COALESCE(
             jsonb_object_agg(line_of_business, cnt),
             '{}'::jsonb
           ) AS by_lob_json
      FROM (
        SELECT line_of_business, COUNT(*)::INT AS cnt
          FROM base
         GROUP BY line_of_business
      ) x
  )
  SELECT
    'This Month (MTD)'::TEXT                                                                       AS window_label,
    (SELECT w_start FROM win)                                                                       AS window_start,
    (SELECT w_end   FROM win)                                                                       AS window_end,
    COALESCE((SELECT COUNT(*)::INT                                                    FROM base), 0) AS total_activities,
    COALESCE((SELECT COUNT(*)::INT FROM base WHERE activity_type = 'quote_issued'),   0)              AS quotes_issued,
    COALESCE((SELECT COUNT(*)::INT FROM base WHERE activity_type = 'app_submitted'),  0)              AS apps_submitted,
    COALESCE((SELECT COUNT(*)::INT FROM base WHERE activity_type = 'policy_bound'),   0)              AS policies_bound,
    COALESCE((SELECT COUNT(*)::INT FROM base WHERE activity_type = 'cross_sell'),     0)              AS cross_sells,
    COALESCE((SELECT COUNT(*)::INT FROM base WHERE activity_type = 'life_app'),       0)              AS life_apps,
    COALESCE((SELECT COUNT(*)::INT FROM base WHERE activity_type = 'fs_referral'),    0)              AS fs_referrals,
    COALESCE((SELECT COUNT(*)::INT FROM base WHERE activity_type = 'account_round'),  0)              AS account_rounds,
    (SELECT by_lob_json FROM by_lob_agg)                                                             AS by_lob;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_office_activity_monthly(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_office_activity_monthly(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_office_activity_monthly(UUID) TO service_role;

COMMENT ON FUNCTION public.get_office_activity_monthly(UUID) IS
  'Agency-wide activity totals month-to-date. Safe to expose to every authenticated caller including producers/employees — returns no per-producer names or breakdowns, only aggregate counts. Cross-tenant guard: raises 42501 if caller''s staff.agency_id does not match p_agency_id.';

-- ---------------------------------------------------------------------------
-- §11. Provenance
-- ---------------------------------------------------------------------------
INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration',              '102_premium_sales_activity',
    'overlay_version',        '0.5.5',
    'ships_module',           'Module 02 — Sales Activity',
    'spec_ref',               '§4.2 + Part I §1',
    'manager_gate_default',   'true (deliberate B.11 deviation, locked 2026-07-11)',
    'compliance_notes',       'schema-level customer PII prohibition; VARCHAR(50)/VARCHAR(200) hard caps; CHECK constraints on 4 enums; SECURITY DEFINER office aggregates with cross-tenant guards',
    'views_shipped',          jsonb_build_array(
                                'v_sales_activity_daily_by_producer',
                                'v_sales_activity_weekly_by_producer',
                                'v_sales_activity_monthly_by_producer',
                                'v_sales_activity_outcome_distribution'
                              ),
    'functions_shipped',      jsonb_build_array(
                                'is_sales_activity_manager()',
                                'get_office_activity_weekly(UUID)',
                                'get_office_activity_monthly(UUID)',
                                'enforce_sales_activity_producer_agency()',
                                'touch_sales_activity_updated_at()'
                              ),
    'applied_at',             now()
  )
);

COMMIT;

-- =============================================================================
-- §12. Verification (run manually after apply)
-- =============================================================================
--
-- 1. Table shape matches spec (12 columns + agency_id):
--    SELECT column_name, data_type, character_maximum_length, is_nullable
--      FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='sales_activity'
--     ORDER BY ordinal_position;
--    Expected: 13 rows exactly. internal_reference max_length=50. notes max_length=200.
--
-- 2. No forbidden columns present:
--    SELECT column_name FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='sales_activity'
--       AND column_name ~* '(customer|policy_number|vin|dob|ssn|insured|policyholder|contact|claim)';
--    Expected: 0 rows.
--
-- 3. CHECK constraints present (4 enum constraints + producer_agency doc constraint):
--    SELECT conname FROM pg_constraint
--     WHERE conrelid = 'public.sales_activity'::regclass AND contype = 'c'
--     ORDER BY conname;
--    Expected: 5 rows.
--
-- 4. Manager gate function returns TRUE by default for an Office Manager,
--    and cross-tenant guard raises 42501 for foreign agency:
--    SELECT public.is_sales_activity_manager();  -- from a Manager auth session
--    SELECT public.get_office_activity_weekly('<foreign agency id>'::UUID);
--    Expected: manager -> true; foreign agency call -> 42501 exception.
--
-- 5. Settings row exists per agency:
--    SELECT COUNT(*) FROM public.settings WHERE setting_key='enable_sales_activity_manager_access';
--    Expected: equal to (SELECT COUNT(*) FROM public.agency).
--
-- 6. Provenance row landed:
--    SELECT event_data->>'migration' FROM public._install_provenance
--     WHERE event_data->>'migration' = '102_premium_sales_activity';
--    Expected: one row.
-- =============================================================================
