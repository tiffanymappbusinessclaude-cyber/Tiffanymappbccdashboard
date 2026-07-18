-- =========================================================================
-- Migration: enable_pg_cron_and_schedule_runner_tick
-- Supabase version: 20260613171005
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- Enable pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Unschedule any existing tick job (idempotent)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'automation-runner-tick') THEN
    PERFORM cron.unschedule('automation-runner-tick');
  END IF;
END $$;

-- Schedule the runner to fire every minute
SELECT cron.schedule(
  'automation-runner-tick',
  '* * * * *',
  $cron$ SELECT public.run_due_automation_recipes(); $cron$
);
