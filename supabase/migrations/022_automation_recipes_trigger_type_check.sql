-- Migration 022: seal the trigger_type contract documented in migration 021.
-- Goals Auto-Sync went silently invisible on 2026-06-25 because migration 019
-- inserted it with trigger_type='scheduled' — a value the dispatcher
-- run_due_automation_recipes() does not recognize. The dispatcher filters
-- WHERE trigger_type='cron' and silently skips anything else, with no error.
--
-- This constraint makes the bug class impossible at the DB layer:
-- any future INSERT/UPDATE with an unrecognized trigger_type fails loudly.
--
-- Legal values:
--   'cron'     — fired by pg_cron via run_due_automation_recipes()
--   'external' — fired by an external scheduler (Edge Function, webhook)
--   'event'    — fired by a DB event/trigger (reserved; not yet in use)

ALTER TABLE public.automation_recipes
  ADD CONSTRAINT chk_automation_recipes_trigger_type
  CHECK (trigger_type IN ('cron', 'external', 'event'));

COMMENT ON CONSTRAINT chk_automation_recipes_trigger_type ON public.automation_recipes
  IS 'Sealed 2026-06-29 after the Goals Auto-Sync silent-invisible bug. '
     'Only cron / external / event are recognized by the dispatcher; any other '
     'value would let a recipe pass row-level checks but never fire.';
