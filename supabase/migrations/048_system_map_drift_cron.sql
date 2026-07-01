-- 048_system_map_drift_cron.sql
-- Schedules the weekly drift scan that calls
-- public.check_system_map_staleness() from migration 046. The RPC is the
-- workhorse; this file is just the cron wiring.
--
-- Mon 09:00 America/Chicago == 14:00 UTC == '0 14 * * 1'. Re-deploy safe:
-- unschedule if it already exists, then schedule fresh.


DO $$
BEGIN
  PERFORM cron.unschedule('system-map-staleness-weekly')
   WHERE EXISTS (
     SELECT 1 FROM cron.job WHERE jobname = 'system-map-staleness-weekly'
   );
EXCEPTION WHEN OTHERS THEN
  -- pg_cron raises if the name doesn't exist; ignore.
  NULL;
END
$$;

SELECT cron.schedule(
  'system-map-staleness-weekly',
  '0 14 * * 1',
  $$ SELECT public.check_system_map_staleness(45); $$
);
