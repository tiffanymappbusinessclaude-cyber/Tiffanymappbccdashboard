-- Migration 021 — fix Goals Auto-Sync trigger_type
-- Date: 2026-06-29
--
-- BUG: Migration 019 inserted the "Goals Auto-Sync" recipe with
-- trigger_type='scheduled'. The dispatcher run_due_automation_recipes()
-- (migration 011) filters with `trigger_type = 'cron'`, so the recipe
-- was silently ignored. Today (Mon 2026-06-29 12:30 UTC) was its first
-- scheduled fire and it never ran.
--
-- Detected: 2026-06-29 21:15 UTC by inspecting last_run_at NULL after
-- the scheduled slot had passed.
-- Caught up: manual run via run_automation_recipe(74008886...) at 21:20
-- UTC succeeded — 13 goals synced, 0 skipped.
--
-- This migration makes the corrective UPDATE idempotent so a fresh
-- replay (mig 019 → mig 021) lands in the correct state.

UPDATE public.automation_recipes
SET trigger_type = 'cron', updated_at = NOW()
WHERE agency_id     = 'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
  AND recipe_name   = 'Goals Auto-Sync'
  AND trigger_type <> 'cron';

-- Belt-and-suspenders: document the constraint the dispatcher actually
-- requires, so the next person inserting a recipe knows the rule.
COMMENT ON COLUMN public.automation_recipes.trigger_type IS
'Dispatcher selector. Values:
  • cron     — run_due_automation_recipes() in migration 011 picks these up
               from pg_cron ticks. Cron_expression is parsed by
               cron_expression_matches() each minute.
  • external — recipe is triggered by something OTHER than pg_cron
               (e.g., Mail Labeler via */15 schedule directly,
                Connection Health Poller, etc.). Bypass the dispatcher.
  • event    — reserved for future event-driven recipes.

Bug fixed 2026-06-29 (migration 021): "Goals Auto-Sync" was inserted with
trigger_type=''scheduled'' which is NOT a recognized dispatcher value.
Use ''cron'' for any new pg_cron-dispatched recipe.';
