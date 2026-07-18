-- =============================================================================
-- Migration 023: calendar_events
-- =============================================================================
-- Purpose: General-purpose agency calendar table that mirrors Google Calendar
-- events bidirectionally. The BCC web app renders the agent's calendar from THIS table
-- (one Supabase query) rather than polling Composio Calendar on every render.
--
-- Bidirectional sync model:
--   - INSERT into calendar_events (source='seeder' or 'manual') → trigger or
--     handler creates the Google Calendar event, populates google_event_id
--   - Google Calendar event changed externally → optional periodic recipe
--     reconciles via GOOGLECALENDAR_LIST_EVENTS (future enhancement)
--
-- The 13-category vocabulary is snake_case, mirrors compliance/document
-- category conventions. Recurrence stored as RRULE strings per RFC 5545
-- (Google Calendar's native format).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.agency(id) ON DELETE CASCADE,

  -- Google Calendar linkage (populated after CALENDAR_CREATE_EVENT succeeds)
  google_event_id text,
  google_calendar_id text DEFAULT 'primary',

  -- Event content
  title text NOT NULL,
  description text,
  location text,

  -- Timing
  event_date date NOT NULL,
  event_time time,
  duration_minutes integer DEFAULT 60,
  is_all_day boolean DEFAULT false,
  timezone text DEFAULT 'America/New_York',

  -- Recurrence (RRULE format per RFC 5545; null = one-time event)
  -- Examples: 'FREQ=YEARLY' for anniversaries, 'FREQ=MONTHLY;BYMONTHDAY=15' for monthly,
  -- 'FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=15' for tax deadlines
  recurrence_rule text,

  -- Categorization (snake_case, fixed vocabulary)
  category text NOT NULL CHECK (category IN (
    'tax_deadline',
    'sf_operational',
    'compliance_review',
    'license_renewal',
    'staff_anniversary',
    'agency_anniversary',
    'holiday_federal',
    'holiday_industry',
    'payroll_run',
    'statement_close',
    'monthly_close',
    'monthly_recap',
    'quarterly_review',
    'reminder',
    'meeting',
    'other'
  )),

  -- Reminder windows (Google Calendar supports popup + email)
  reminder_minutes_before integer[] DEFAULT ARRAY[60, 1440],  -- 1hr + 24hr defaults

  -- Relational links (for events tied to specific entities)
  staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  compliance_rule_id uuid REFERENCES public.compliance_rules(id) ON DELETE SET NULL,

  -- Provenance
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('seeder', 'manual', 'recipe_generated', 'imported')),
  is_active boolean NOT NULL DEFAULT true,

  -- Audit
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  last_synced_at timestamptz,
  sync_status text DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'sync_failed', 'sync_skipped')),
  sync_error text
);

-- Indexes for common BCC dashboard queries
CREATE INDEX IF NOT EXISTS idx_calendar_events_agency_date 
  ON public.calendar_events (agency_id, event_date) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_calendar_events_category 
  ON public.calendar_events (agency_id, category, event_date) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_calendar_events_staff 
  ON public.calendar_events (staff_id) WHERE staff_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calendar_events_sync_pending 
  ON public.calendar_events (sync_status, created_at) 
  WHERE sync_status = 'pending' AND is_active = true;

-- Deduplication: don't double-seed the same recurring event for the same agency
-- (e.g. running the seeder twice should not create duplicate "April 15 - Form 1040" rows)
CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_events_dedupe 
  ON public.calendar_events (agency_id, title, event_date, category) 
  WHERE source = 'seeder' AND is_active = true;

-- Updated_at trigger (uses the existing public.set_updated_at() if present, else inline)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at' AND pronamespace = 'public'::regnamespace) THEN
    EXECUTE 'CREATE TRIGGER tg_calendar_events_updated_at 
             BEFORE UPDATE ON public.calendar_events 
             FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()';
  ELSE
    CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger AS $f$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $f$ LANGUAGE plpgsql;

    EXECUTE 'CREATE TRIGGER tg_calendar_events_updated_at 
             BEFORE UPDATE ON public.calendar_events 
             FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()';
  END IF;
EXCEPTION WHEN duplicate_object THEN
  -- trigger already exists, skip
  NULL;
END $$;

-- Anon read for the BCC web app (matches migration 005 pattern)
GRANT SELECT ON public.calendar_events TO anon;
GRANT SELECT, INSERT, UPDATE ON public.calendar_events TO authenticated;
GRANT ALL ON public.calendar_events TO service_role;

-- RLS
ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon read calendar_events" ON public.calendar_events;
CREATE POLICY "anon read calendar_events" ON public.calendar_events
  FOR SELECT TO anon
  USING (true);

DROP POLICY IF EXISTS "service_role all calendar_events" ON public.calendar_events;
CREATE POLICY "service_role all calendar_events" ON public.calendar_events
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.calendar_events IS 
  'Agency calendar mirror — events here sync to Google Calendar bidirectionally. Source of truth for the BCC web app calendar widget. See docs/CALENDAR_SEEDER.md for category conventions and seed taxonomy.';
