-- =============================================================================
-- migrations/103_premium_scoreboard.sql
-- -----------------------------------------------------------------------------
-- Overlay: bcc-premium-overlay v0.5.7
-- Ships: Module 03 — Scoreboard (spec §4.3)
--
-- ==========================================================================
-- §1. COMPLIANCE-SAFE MODULE — INHERITED FROM UPSTREAM DATA SOURCES
-- ==========================================================================
-- Scoreboard is a REPORTING module. It reads from sales_activity (§4.2) and
-- time_tracking (§4.1), both of which are schema-level compliance-safe
-- (customer PII columns literally do not exist). Any Scoreboard view, RPC, or
-- UI element requiring a JOIN to customer data must be rejected — the data
-- doesn't exist to join to.
--
-- NAMING DISCIPLINE (locked 2026-07-10 with Rebecca): this module is
-- Scoreboard, NEVER "ScoreCard". State Farm's ScoreCard is a bonus program
-- unrelated to this internal team-performance surface. Any code, docstring,
-- UI copy, or Ask Claude prompt conflating the two is drift.
--
-- ==========================================================================
-- §2. B.11 = FALSE (CANONICAL — DELIBERATE NON-DEVIATION)
-- ==========================================================================
-- Scoreboard is the FIRST Premium module in four consecutive ships to hold
-- the CANONICAL Producer Isolation default (FALSE). The prior four modules
-- (Licenses §4.8, Handbook §4.5, Sales Activity §4.2, Time Tracking §4.1)
-- all shipped with TRUE-default manager gates for documented coaching-signal
-- rationales. Scoreboard does NOT get that deviation:
--   * Producer surface (default): own progress on personal goals + agency
--     team goals (producer_id IS NULL) + read-only unexpired announcements
--     + own celebrations from rpc_get_celebrations(own_staff_id).
--   * Owner surface: unconditional. Sees everything.
--   * Office Manager surface: SAME AS PRODUCER unless owner explicitly
--     toggles enable_scoreboard_manager_access = 'true'. When toggled on,
--     manager sees producer leaderboard, team goals, nudge tile,
--     Manage Goals modal, Manage Announcements modal.
--
-- Rationale for holding canonical FALSE here: unlike the four prior modules
-- where team visibility is the module's core coaching purpose, Scoreboard
-- can function meaningfully as a producer-only surface (personal progress,
-- own celebrations, team totals-without-names). Team leaderboard visibility
-- is a manager escalation the owner opts into deliberately.
--
-- ==========================================================================
-- §3. SPEC REVIEW BLOCK RATIFICATIONS (2026-07-12 session with Rebecca)
-- ==========================================================================
-- Q1 SCOPE: FULL — ships scoreboard_goals + agency_announcements +
--            rpc_get_celebrations SECURITY DEFINER + fn_compute_goal_actual
--            SECURITY DEFINER helper.
-- Q2 GOALS SCHEMA: Approach A (enum-based goal_type, 10 CHECK-constrained
--            presets, not composable filters). Full column set inline below.
-- Q3 MILESTONES INTEGRATION: NONE. Scoreboard uses scoreboard_goals only.
-- Q4 YoY COMPARISON: read from sales_activity aggregated by period, NOT
--            from Base general_ledger. Client-side aggregation in
--            Scoreboard.jsx; no new views needed.
-- Q5 CELEBRATION RPC: SECURITY DEFINER, JSONB return, per-producer scope
--            with cross-tenant 42501 guard.
-- Q6 CELEBRATIONS: 5-item launch set (goal_hit, bound_yesterday,
--            cross_sell_yesterday, new_household_yesterday,
--            activity_streak_3). Deduplication per (producer, day) for
--            activity celebrations.
-- Q7 ANNOUNCEMENTS: VARCHAR(500) plain text, auto-hide via starts_at/ends_at
--            window (no auto-delete). Owner + gated-manager write, all
--            agency staff read.
-- Q8 GOAL-SETTING UI: inside Scoreboard.jsx via Manage Goals modal.
--            No Base master Settings > Goals section for v0.5.7.
-- Q9 NUDGE TILE: fires when sales-activity HOURS dropped 25%+ vs last
--            month. Distinct signal from SA nudge (which fires on activity
--            drop). Computed client-side in Scoreboard.jsx from
--            v_time_tracking_monthly_by_producer.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- §4. TABLE: public.scoreboard_goals
-- ---------------------------------------------------------------------------
-- Period-bound performance targets. Nullable producer_id -> team-wide goal.
-- Enum-based goal_type (10 presets) drives the actual computation in
-- fn_compute_goal_actual. is_active soft-archive keeps history for
-- "goal_hit" celebration lookback window without hard-delete surprises.
CREATE TABLE IF NOT EXISTS public.scoreboard_goals (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             UUID          NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  producer_id           UUID          REFERENCES public.staff(id) ON DELETE CASCADE,
  goal_period           TEXT          NOT NULL,
  goal_type             TEXT          NOT NULL,
  target_value          INTEGER       NOT NULL,
  period_start          DATE          NOT NULL,
  period_end            DATE          NOT NULL,
  is_active             BOOLEAN       NOT NULL DEFAULT TRUE,
  created_by_staff_id   UUID          REFERENCES public.staff(id) ON DELETE SET NULL,
  notes                 VARCHAR(200),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT scoreboard_goals_goal_period_chk CHECK (goal_period IN ('monthly','quarterly','annual')),
  CONSTRAINT scoreboard_goals_goal_type_chk CHECK (goal_type IN (
    'auto_quotes','fire_quotes','life_apps','total_binds',
    'auto_binds','fire_binds','life_binds',
    'cross_sells','fs_referrals','total_activities'
  )),
  CONSTRAINT scoreboard_goals_target_positive_chk CHECK (target_value > 0),
  CONSTRAINT scoreboard_goals_period_order_chk CHECK (period_end > period_start),
  CONSTRAINT scoreboard_goals_one_per_target_uq UNIQUE
    (agency_id, producer_id, goal_type, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_scoreboard_goals_agency_active
  ON public.scoreboard_goals (agency_id, is_active);
CREATE INDEX IF NOT EXISTS idx_scoreboard_goals_producer
  ON public.scoreboard_goals (producer_id) WHERE producer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scoreboard_goals_period_end
  ON public.scoreboard_goals (period_end, is_active);

COMMENT ON TABLE public.scoreboard_goals IS
  'Period-bound performance targets. Nullable producer_id = team-wide goal (agency aggregate). goal_type enum drives fn_compute_goal_actual dispatch. is_active=false soft-archives without losing history for celebration lookbacks.';

COMMENT ON COLUMN public.scoreboard_goals.producer_id IS
  'NULL = agency team-wide goal (aggregate across all producers). Non-NULL = producer-specific goal.';

COMMENT ON COLUMN public.scoreboard_goals.goal_type IS
  'CHECK-constrained enum matching fn_compute_goal_actual dispatch branches. Adding new values requires migration + fn update in same commit.';

-- Note: the UNIQUE constraint uses (producer_id) directly, which treats NULL
-- values as DISTINCT under standard SQL semantics. That means two team-wide
-- goals with the same goal_type + period_start + period_end could coexist
-- (both have producer_id = NULL). We accept this as intentional: an owner
-- might legitimately want two overlapping team goals (e.g. a stretch goal
-- alongside a base goal), and enforcing NULL-uniqueness via COALESCE would
-- add index complexity for a rare edge case. If duplicate-team-goal noise
-- becomes a problem, add a partial UNIQUE index in a follow-on.

-- ---------------------------------------------------------------------------
-- §5. TABLE: public.agency_announcements
-- ---------------------------------------------------------------------------
-- Owner/manager-authored strip for the Scoreboard welcome surface. Plain
-- text (no markdown — XSS-safe render, matches celebratory aesthetic).
-- starts_at/ends_at window auto-hides expired announcements without
-- hard-delete; history remains queryable by owner.
CREATE TABLE IF NOT EXISTS public.agency_announcements (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id         UUID          NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,
  author_staff_id   UUID          NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  body              VARCHAR(500)  NOT NULL,
  starts_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  ends_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT agency_announcements_body_nonempty_chk CHECK (length(trim(body)) > 0),
  CONSTRAINT agency_announcements_window_order_chk CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_agency_announcements_agency_window
  ON public.agency_announcements (agency_id, starts_at, ends_at);

COMMENT ON TABLE public.agency_announcements IS
  'Owner/manager-authored announcements shown on Scoreboard welcome surface. Client filters WHERE now() BETWEEN starts_at AND COALESCE(ends_at, now() + INTERVAL ''999 years'') to auto-hide expired without hard-delete. Plain text only.';

-- ---------------------------------------------------------------------------
-- §6. TOUCH TRIGGERS — auto-maintain updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_scoreboard_goals_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.touch_agency_announcements_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- §7. CROSS-TENANT GUARD TRIGGERS
-- ---------------------------------------------------------------------------
-- Prevent a rogue write from stapling one agency's producer onto another
-- agency's goal / announcement row. RLS scopes reads/writes, but a
-- SECURITY DEFINER RPC on the Base side could bypass RLS — these triggers
-- are the last line of defense.
CREATE OR REPLACE FUNCTION public.enforce_scoreboard_goals_producer_agency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  producer_agency UUID;
BEGIN
  IF NEW.producer_id IS NULL THEN
    -- Team-wide goal, no producer/agency alignment to check.
    RETURN NEW;
  END IF;

  SELECT agency_id INTO producer_agency
    FROM public.staff
   WHERE id = NEW.producer_id;

  IF producer_agency IS NULL THEN
    RAISE EXCEPTION 'scoreboard_goals: producer_id % does not exist in public.staff', NEW.producer_id
      USING ERRCODE = '23503';
  END IF;

  IF producer_agency <> NEW.agency_id THEN
    RAISE EXCEPTION 'scoreboard_goals: producer_id % belongs to agency %, cannot set goal for agency %',
      NEW.producer_id, producer_agency, NEW.agency_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_agency_announcements_author_agency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  author_agency UUID;
BEGIN
  SELECT agency_id INTO author_agency
    FROM public.staff
   WHERE id = NEW.author_staff_id;

  IF author_agency IS NULL THEN
    RAISE EXCEPTION 'agency_announcements: author_staff_id % does not exist in public.staff', NEW.author_staff_id
      USING ERRCODE = '23503';
  END IF;

  IF author_agency <> NEW.agency_id THEN
    RAISE EXCEPTION 'agency_announcements: author % belongs to agency %, cannot post to agency %',
      NEW.author_staff_id, author_agency, NEW.agency_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_scoreboard_goals_producer_agency
  BEFORE INSERT OR UPDATE OF producer_id, agency_id ON public.scoreboard_goals
  FOR EACH ROW EXECUTE FUNCTION public.enforce_scoreboard_goals_producer_agency();

CREATE TRIGGER trg_scoreboard_goals_touch_updated_at
  BEFORE UPDATE ON public.scoreboard_goals
  FOR EACH ROW EXECUTE FUNCTION public.touch_scoreboard_goals_updated_at();

CREATE TRIGGER trg_agency_announcements_author_agency
  BEFORE INSERT OR UPDATE OF author_staff_id, agency_id ON public.agency_announcements
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agency_announcements_author_agency();

CREATE TRIGGER trg_agency_announcements_touch_updated_at
  BEFORE UPDATE ON public.agency_announcements
  FOR EACH ROW EXECUTE FUNCTION public.touch_agency_announcements_updated_at();

-- ---------------------------------------------------------------------------
-- §8. MANAGER-GATE FUNCTION (B.11 CANONICAL FALSE)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_scoreboard_manager()
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
        WHERE setting_key = 'enable_scoreboard_manager_access'
        LIMIT 1),
      false  -- CANONICAL B.11 default. First Premium module in 4 ships to hold canonical. See migration 103 header §2.
    );
$fn$;

REVOKE ALL ON FUNCTION public.is_scoreboard_manager() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_scoreboard_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_scoreboard_manager() TO service_role;

COMMENT ON FUNCTION public.is_scoreboard_manager() IS
  'B.11 manager gate for Scoreboard. Returns TRUE when caller has role=Office Manager AND status=active AND the enable_scoreboard_manager_access setting is true (defaults FALSE — canonical B.11, see migration 103 header §2 for rationale). Owner explicitly opts manager into team visibility.';

-- ---------------------------------------------------------------------------
-- §9. RLS ENABLE + POLICIES
-- ---------------------------------------------------------------------------
ALTER TABLE public.scoreboard_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agency_announcements ENABLE ROW LEVEL SECURITY;

-- scoreboard_goals: owner has full CRUD on own agency
CREATE POLICY scoreboard_goals_owner_all
  ON public.scoreboard_goals
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
         AND s.role         = 'Owner / Agent'
         AND s.status       = 'active'
         AND s.agency_id    = scoreboard_goals.agency_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
         AND s.role         = 'Owner / Agent'
         AND s.status       = 'active'
         AND s.agency_id    = scoreboard_goals.agency_id
    )
  )
;

-- scoreboard_goals: manager (gated) has full CRUD on own agency
CREATE POLICY scoreboard_goals_manager_all
  ON public.scoreboard_goals
  FOR ALL
  TO authenticated
  USING (
    public.is_scoreboard_manager()
    AND agency_id = (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
       LIMIT 1
    )
  )
  WITH CHECK (
    public.is_scoreboard_manager()
    AND agency_id = (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
       LIMIT 1
    )
  )
;

-- scoreboard_goals: producer can SELECT own goals + team-wide goals
CREATE POLICY scoreboard_goals_producer_read
  ON public.scoreboard_goals
  FOR SELECT
  TO authenticated
  USING (
    agency_id = (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
       LIMIT 1
    )
    AND (producer_id IS NULL OR producer_id = public.current_staff_id())
  )
;

-- agency_announcements: owner full CRUD on own agency
CREATE POLICY agency_announcements_owner_all
  ON public.agency_announcements
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
         AND s.role         = 'Owner / Agent'
         AND s.status       = 'active'
         AND s.agency_id    = agency_announcements.agency_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
         AND s.role         = 'Owner / Agent'
         AND s.status       = 'active'
         AND s.agency_id    = agency_announcements.agency_id
    )
  )
;

-- agency_announcements: manager (gated) full CRUD on own agency
CREATE POLICY agency_announcements_manager_all
  ON public.agency_announcements
  FOR ALL
  TO authenticated
  USING (
    public.is_scoreboard_manager()
    AND agency_id = (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
       LIMIT 1
    )
  )
  WITH CHECK (
    public.is_scoreboard_manager()
    AND agency_id = (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
       LIMIT 1
    )
  )
;

-- agency_announcements: all agency staff can READ (regardless of manager gate)
CREATE POLICY agency_announcements_all_read
  ON public.agency_announcements
  FOR SELECT
  TO authenticated
  USING (
    agency_id = (
      SELECT s.agency_id FROM public.staff s
       WHERE s.auth_user_id = auth.uid()
       LIMIT 1
    )
  )
;

-- ---------------------------------------------------------------------------
-- §10. HELPER FUNCTION — fn_compute_goal_actual(p_goal_id)
-- ---------------------------------------------------------------------------
-- Given a scoreboard_goals row id, compute the actual value against
-- sales_activity for the goal's period + producer scope + goal_type filter.
-- 10-branch CASE dispatch matching the goal_type enum. SECURITY DEFINER so
-- the Manage Goals modal can call it for goal progress display without
-- needing RLS access to sales_activity from the caller's role — but with
-- an inline cross-tenant guard (agency_id check).
CREATE OR REPLACE FUNCTION public.fn_compute_goal_actual(p_goal_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_goal    public.scoreboard_goals%ROWTYPE;
  v_caller_agency UUID;
  v_actual  INTEGER := 0;
BEGIN
  SELECT * INTO v_goal FROM public.scoreboard_goals WHERE id = p_goal_id;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Cross-tenant guard: caller must be a member of the goal's agency.
  SELECT agency_id INTO v_caller_agency
    FROM public.staff
   WHERE auth_user_id = auth.uid()
     AND status = 'active'
   LIMIT 1;

  IF v_caller_agency IS NULL OR v_caller_agency <> v_goal.agency_id THEN
    RAISE EXCEPTION 'fn_compute_goal_actual: caller not authorized for goal %', p_goal_id
      USING ERRCODE = '42501';
  END IF;

  CASE v_goal.goal_type
    WHEN 'auto_quotes' THEN
      SELECT COUNT(*)::INTEGER INTO v_actual
        FROM public.sales_activity sa
       WHERE sa.agency_id = v_goal.agency_id
         AND (v_goal.producer_id IS NULL OR sa.producer_id = v_goal.producer_id)
         AND sa.activity_date BETWEEN v_goal.period_start AND v_goal.period_end
         AND sa.activity_type = 'quote_issued'
         AND sa.line_of_business = 'auto';

    WHEN 'fire_quotes' THEN
      SELECT COUNT(*)::INTEGER INTO v_actual
        FROM public.sales_activity sa
       WHERE sa.agency_id = v_goal.agency_id
         AND (v_goal.producer_id IS NULL OR sa.producer_id = v_goal.producer_id)
         AND sa.activity_date BETWEEN v_goal.period_start AND v_goal.period_end
         AND sa.activity_type = 'quote_issued'
         AND sa.line_of_business = 'fire';

    WHEN 'life_apps' THEN
      SELECT COUNT(*)::INTEGER INTO v_actual
        FROM public.sales_activity sa
       WHERE sa.agency_id = v_goal.agency_id
         AND (v_goal.producer_id IS NULL OR sa.producer_id = v_goal.producer_id)
         AND sa.activity_date BETWEEN v_goal.period_start AND v_goal.period_end
         AND (sa.activity_type = 'life_app'
              OR (sa.activity_type = 'app_submitted' AND sa.line_of_business = 'life'));

    WHEN 'total_binds' THEN
      SELECT COUNT(*)::INTEGER INTO v_actual
        FROM public.sales_activity sa
       WHERE sa.agency_id = v_goal.agency_id
         AND (v_goal.producer_id IS NULL OR sa.producer_id = v_goal.producer_id)
         AND sa.activity_date BETWEEN v_goal.period_start AND v_goal.period_end
         AND sa.outcome = 'bound';

    WHEN 'auto_binds' THEN
      SELECT COUNT(*)::INTEGER INTO v_actual
        FROM public.sales_activity sa
       WHERE sa.agency_id = v_goal.agency_id
         AND (v_goal.producer_id IS NULL OR sa.producer_id = v_goal.producer_id)
         AND sa.activity_date BETWEEN v_goal.period_start AND v_goal.period_end
         AND sa.outcome = 'bound'
         AND sa.line_of_business = 'auto';

    WHEN 'fire_binds' THEN
      SELECT COUNT(*)::INTEGER INTO v_actual
        FROM public.sales_activity sa
       WHERE sa.agency_id = v_goal.agency_id
         AND (v_goal.producer_id IS NULL OR sa.producer_id = v_goal.producer_id)
         AND sa.activity_date BETWEEN v_goal.period_start AND v_goal.period_end
         AND sa.outcome = 'bound'
         AND sa.line_of_business = 'fire';

    WHEN 'life_binds' THEN
      SELECT COUNT(*)::INTEGER INTO v_actual
        FROM public.sales_activity sa
       WHERE sa.agency_id = v_goal.agency_id
         AND (v_goal.producer_id IS NULL OR sa.producer_id = v_goal.producer_id)
         AND sa.activity_date BETWEEN v_goal.period_start AND v_goal.period_end
         AND sa.outcome = 'bound'
         AND sa.line_of_business = 'life';

    WHEN 'cross_sells' THEN
      SELECT COUNT(*)::INTEGER INTO v_actual
        FROM public.sales_activity sa
       WHERE sa.agency_id = v_goal.agency_id
         AND (v_goal.producer_id IS NULL OR sa.producer_id = v_goal.producer_id)
         AND sa.activity_date BETWEEN v_goal.period_start AND v_goal.period_end
         AND sa.activity_type = 'cross_sell';

    WHEN 'fs_referrals' THEN
      SELECT COUNT(*)::INTEGER INTO v_actual
        FROM public.sales_activity sa
       WHERE sa.agency_id = v_goal.agency_id
         AND (v_goal.producer_id IS NULL OR sa.producer_id = v_goal.producer_id)
         AND sa.activity_date BETWEEN v_goal.period_start AND v_goal.period_end
         AND (sa.activity_type = 'fs_referral'
              OR sa.line_of_business = 'financial_services');

    WHEN 'total_activities' THEN
      SELECT COUNT(*)::INTEGER INTO v_actual
        FROM public.sales_activity sa
       WHERE sa.agency_id = v_goal.agency_id
         AND (v_goal.producer_id IS NULL OR sa.producer_id = v_goal.producer_id)
         AND sa.activity_date BETWEEN v_goal.period_start AND v_goal.period_end;

    ELSE
      -- Should be unreachable given the CHECK constraint, but defensive.
      RAISE EXCEPTION 'fn_compute_goal_actual: unknown goal_type %', v_goal.goal_type;
  END CASE;

  RETURN COALESCE(v_actual, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_compute_goal_actual(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_compute_goal_actual(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_compute_goal_actual(UUID) TO service_role;

COMMENT ON FUNCTION public.fn_compute_goal_actual(UUID) IS
  'Given a scoreboard_goals row id, returns the actual value from sales_activity for the goal''s period + producer scope + goal_type filter. Reused by Manage Goals modal (live progress) and rpc_get_celebrations (goal_hit detection). SECURITY DEFINER with inline cross-tenant guard: caller must be a member of the goal''s agency (raises 42501 otherwise).';

-- ---------------------------------------------------------------------------
-- §11. MAIN RPC — rpc_get_celebrations(p_producer_id)
-- ---------------------------------------------------------------------------
-- Returns a JSONB array of celebration objects for the producer, sorted by
-- priority DESC. Producer can call for own producer_id; owner unconditional;
-- manager only when is_scoreboard_manager() = TRUE. Cross-tenant call
-- raises 42501.
--
-- Celebration set (v0.5.7 launch — ratified in 2026-07-12 spec review):
--   priority 3: goal_hit — active goal whose period_end within last 7 days
--               and actual >= target (calls fn_compute_goal_actual)
--   priority 2: bound_yesterday, cross_sell_yesterday, new_household_yesterday
--               — deduplicated per producer per day (one row emitted with
--               data aggregating LOBs / activity count)
--   priority 1: activity_streak_3 — 3 consecutive workdays (Mon-Fri) ending
--               yesterday with >=1 sales_activity entry each
CREATE OR REPLACE FUNCTION public.rpc_get_celebrations(p_producer_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_staff_id UUID;
  v_caller_role     TEXT;
  v_caller_agency   UUID;
  v_target_agency   UUID;
  v_result          JSONB := '[]'::jsonb;
  v_goal            RECORD;
  v_actual          INTEGER;
  v_bound           RECORD;
  v_cross           RECORD;
  v_newhh           RECORD;
  v_streak_count    INTEGER;
BEGIN
  -- ---- authorization ----
  SELECT s.id, s.role, s.agency_id
    INTO v_caller_staff_id, v_caller_role, v_caller_agency
    FROM public.staff s
   WHERE s.auth_user_id = auth.uid()
     AND s.status = 'active'
   LIMIT 1;

  IF v_caller_staff_id IS NULL THEN
    RAISE EXCEPTION 'rpc_get_celebrations: no active caller staff'
      USING ERRCODE = '42501';
  END IF;

  SELECT agency_id INTO v_target_agency
    FROM public.staff
   WHERE id = p_producer_id;

  IF v_target_agency IS NULL THEN
    RAISE EXCEPTION 'rpc_get_celebrations: producer_id % not found', p_producer_id
      USING ERRCODE = '23503';
  END IF;

  IF v_target_agency <> v_caller_agency THEN
    RAISE EXCEPTION 'rpc_get_celebrations: cross-tenant call blocked'
      USING ERRCODE = '42501';
  END IF;

  -- Producer can only call for own producer_id.
  -- Owner + gated manager can call for any producer in own agency.
  IF p_producer_id <> v_caller_staff_id THEN
    IF v_caller_role NOT IN ('Owner / Agent') AND NOT public.is_scoreboard_manager() THEN
      RAISE EXCEPTION 'rpc_get_celebrations: caller not authorized for other producers'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- ---- goal_hit (priority 3) ----
  FOR v_goal IN
    SELECT id, goal_type, goal_period, target_value, period_end, producer_id
      FROM public.scoreboard_goals
     WHERE agency_id = v_target_agency
       AND is_active = TRUE
       AND period_end BETWEEN (CURRENT_DATE - INTERVAL '7 days')::DATE AND CURRENT_DATE
       AND (producer_id = p_producer_id OR producer_id IS NULL)
  LOOP
    v_actual := public.fn_compute_goal_actual(v_goal.id);
    IF v_actual >= v_goal.target_value THEN
      v_result := v_result || jsonb_build_object(
        'type',     'goal_hit',
        'priority', 3,
        'message',  format('🎯 You hit your %s %s goal!', v_goal.goal_period, replace(v_goal.goal_type, '_', ' ')),
        'data',     jsonb_build_object(
          'goal_id',     v_goal.id,
          'goal_type',   v_goal.goal_type,
          'goal_period', v_goal.goal_period,
          'target',      v_goal.target_value,
          'actual',      v_actual,
          'team_wide',   (v_goal.producer_id IS NULL),
          'period_end',  v_goal.period_end
        )
      );
    END IF;
  END LOOP;

  -- ---- bound_yesterday (priority 2, deduplicated per producer per day) ----
  SELECT
    COUNT(*)::INTEGER AS bind_count,
    jsonb_agg(DISTINCT sa.line_of_business) AS lobs
  INTO v_bound
    FROM public.sales_activity sa
   WHERE sa.producer_id = p_producer_id
     AND sa.activity_date = CURRENT_DATE - INTERVAL '1 day'
     AND sa.outcome = 'bound';

  IF v_bound.bind_count > 0 THEN
    v_result := v_result || jsonb_build_object(
      'type',     'bound_yesterday',
      'priority', 2,
      'message',  CASE
                    WHEN v_bound.bind_count = 1 THEN 'You bound a policy yesterday!'
                    ELSE format('You bound %s policies yesterday!', v_bound.bind_count)
                  END,
      'data',     jsonb_build_object(
        'count', v_bound.bind_count,
        'lobs',  v_bound.lobs
      )
    );
  END IF;

  -- ---- cross_sell_yesterday (priority 2, dedup) ----
  SELECT
    COUNT(*)::INTEGER AS cs_count,
    jsonb_agg(DISTINCT sa.line_of_business) AS lobs
  INTO v_cross
    FROM public.sales_activity sa
   WHERE sa.producer_id = p_producer_id
     AND sa.activity_date = CURRENT_DATE - INTERVAL '1 day'
     AND sa.activity_type = 'cross_sell';

  IF v_cross.cs_count > 0 THEN
    v_result := v_result || jsonb_build_object(
      'type',     'cross_sell_yesterday',
      'priority', 2,
      'message',  CASE
                    WHEN v_cross.cs_count = 1 THEN 'Cross-sell yesterday — nice.'
                    ELSE format('%s cross-sells yesterday — nice.', v_cross.cs_count)
                  END,
      'data',     jsonb_build_object(
        'count', v_cross.cs_count,
        'lobs',  v_cross.lobs
      )
    );
  END IF;

  -- ---- new_household_yesterday (priority 2, dedup) ----
  SELECT COUNT(*)::INTEGER AS nhh_count
    INTO v_newhh
    FROM public.sales_activity sa
   WHERE sa.producer_id = p_producer_id
     AND sa.activity_date = CURRENT_DATE - INTERVAL '1 day'
     AND sa.new_household = TRUE;

  IF v_newhh.nhh_count > 0 THEN
    v_result := v_result || jsonb_build_object(
      'type',     'new_household_yesterday',
      'priority', 2,
      'message',  CASE
                    WHEN v_newhh.nhh_count = 1 THEN 'New household added yesterday!'
                    ELSE format('%s new households added yesterday!', v_newhh.nhh_count)
                  END,
      'data',     jsonb_build_object('count', v_newhh.nhh_count)
    );
  END IF;

  -- ---- activity_streak_3 (priority 1) ----
  -- Get the 3 most recent workdays (Mon-Fri) ending yesterday, then check
  -- that each has >=1 sales_activity entry for this producer.
  WITH last_3_workdays AS (
    SELECT d::DATE AS workday
      FROM generate_series(
             (CURRENT_DATE - INTERVAL '10 days')::DATE,  -- overshoot to cover weekends
             (CURRENT_DATE - INTERVAL '1 day')::DATE,
             '1 day'::INTERVAL
           ) AS d
     WHERE EXTRACT(DOW FROM d) BETWEEN 1 AND 5
     ORDER BY d DESC
     LIMIT 3
  ),
  activity_days AS (
    SELECT DISTINCT sa.activity_date
      FROM public.sales_activity sa
     WHERE sa.producer_id = p_producer_id
       AND sa.activity_date IN (SELECT workday FROM last_3_workdays)
  )
  SELECT COUNT(*)::INTEGER INTO v_streak_count FROM activity_days;

  IF v_streak_count = 3 THEN
    v_result := v_result || jsonb_build_object(
      'type',     'activity_streak_3',
      'priority', 1,
      'message',  '3-day activity streak going strong.',
      'data',     jsonb_build_object('streak_days', 3)
    );
  END IF;

  -- ---- sort by priority DESC ----
  SELECT COALESCE(jsonb_agg(c ORDER BY (c->>'priority')::INTEGER DESC), '[]'::jsonb)
    INTO v_result
    FROM jsonb_array_elements(v_result) c;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_celebrations(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_get_celebrations(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_celebrations(UUID) TO service_role;

COMMENT ON FUNCTION public.rpc_get_celebrations(UUID) IS
  'Returns JSONB array of celebration objects {type, priority, message, data} for a producer, sorted priority DESC. Producer can call for own producer_id; owner unconditionally; manager only when is_scoreboard_manager() = TRUE. Cross-tenant call raises 42501. Empty array when no celebrations. Rebecca ratification 2026-07-12: 5-celebration launch set (goal_hit pri 3, bound_yesterday/cross_sell_yesterday/new_household_yesterday pri 2, activity_streak_3 pri 1).';

-- ---------------------------------------------------------------------------
-- §12. SETTINGS ROW SEEDING — enable_scoreboard_manager_access
-- ---------------------------------------------------------------------------
INSERT INTO public.settings (agency_id, setting_key, setting_value, description)
SELECT
  a.id,
  'enable_scoreboard_manager_access',
  'false',
  'Producer Isolation Principle B.11 manager gate for Scoreboard module. When true, staff with role=Office Manager can see team leaderboard, Manage Goals modal, Manage Announcements modal, and nudge tile. DEFAULTS FALSE (canonical B.11 — first Premium module in 4 ships to hold the canonical default; owner deliberately opts manager into team visibility). Flip to ''true'' on this agency to grant manager team-level access.'
FROM public.agency a
ON CONFLICT (agency_id, setting_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- §13. PROVENANCE
-- ---------------------------------------------------------------------------
INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration',              '103_premium_scoreboard',
    'overlay_version',        '0.5.7',
    'ships_module',           'Module 03 — Scoreboard',
    'spec_ref',               '§4.3 + Part I §1',
    'shape_choice',           'activity-based, goal-tracking + celebrations + announcements (Q1 FULL scope ratified 2026-07-12)',
    'b11_default',            'false (CANONICAL — first Premium module in 4 ships to hold canonical, deliberate NON-deviation)',
    'goal_type_presets',      jsonb_build_array(
                                'auto_quotes','fire_quotes','life_apps','total_binds',
                                'auto_binds','fire_binds','life_binds',
                                'cross_sells','fs_referrals','total_activities'
                              ),
    'new_tables',             jsonb_build_array('scoreboard_goals','agency_announcements'),
    'new_functions',          jsonb_build_array(
                                'is_scoreboard_manager()',
                                'fn_compute_goal_actual(UUID)',
                                'rpc_get_celebrations(UUID)',
                                'touch_scoreboard_goals_updated_at()',
                                'touch_agency_announcements_updated_at()',
                                'enforce_scoreboard_goals_producer_agency()',
                                'enforce_agency_announcements_author_agency()'
                              ),
    'celebrations_shipped',   jsonb_build_array(
                                'goal_hit (priority 3)',
                                'bound_yesterday (priority 2, deduplicated)',
                                'cross_sell_yesterday (priority 2, deduplicated)',
                                'new_household_yesterday (priority 2, deduplicated)',
                                'activity_streak_3 (priority 1)'
                              ),
    'yoy_source',             'sales_activity (not Base general_ledger — Q4 ratified 2026-07-12)',
    'depends_on',             jsonb_build_array(
                                'migration 102 (sales_activity table + rollup views)',
                                'migration 101 (time_tracking table + rollup views — Scoreboard.jsx client-side consumes for nudge tile)'
                              ),
    'ships_paired_with',      'Base master PlaybookGuide.jsx +4 seed prompts (§4.3 Scoreboard section)'
  )
);

-- =============================================================================
-- End of migration 103_premium_scoreboard.sql
-- Assertions block runs in the transactional dry-run wrapper, not here.
-- =============================================================================
