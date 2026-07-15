-- =============================================================================
-- Migration 100c — Premium Auth Provisioner Recipe Seed
-- =============================================================================
-- Overlay:      bcc-premium-overlay v0.5.1-rc1
-- Prerequisite: 100a (queue table + trigger), 100b (helper functions),
--               runner-patch/auth_provisioner.ts applied to Base's
--               supabase/functions/automation-runner/index.ts
--
-- What this migration does
-- ------------------------
-- Inserts one row into public.automation_recipes for the Premium auth
-- provisioner. The recipe fires every minute via Base's pg_cron heartbeat
-- (migration 020) and dispatches through Base's automation-runner Edge
-- Function to the runAuthProvisioner TypeScript orchestrator introduced
-- by the runner-patch.
--
-- Recipe shape
-- ------------
--   composio_action     = 'INTERNAL'
--   composio_connection = NULL       -- no Composio credentials needed
--   internal_handler    = 'dispatch_premium_auth_provisioner'
--   groq_prompt         = NULL       -- no LLM parse
--   cron_expression     = '* * * * *' -- every minute (see UX rationale below)
--   is_active           = true
--
-- Why every-minute cron
-- ---------------------
-- Base recipes cluster at specific times of day because their work is
-- batch-natured (daily briefing, GL close chain, etc.). The auth queue
-- drain is different: it fires only when a staff row transitions
-- (rare event), and the UX expectation is "when I create a new employee,
-- they get an invite within a minute or two." Every-minute cron gives
-- that latency floor. On empty ticks (~99% of the time), the orchestrator
-- returns immediately after fn_claim_next_auth_action reports 0 rows —
-- the cost is one RPC round-trip per minute.
--
-- If a client prefers to trade latency for cost, change cron to
-- '*/5 * * * *' or similar via a follow-up UPDATE.
--
-- Placeholders to replace
-- -----------------------
--   {{agency_id}}  The client's agency UUID (same value as in every
--                  other recipe seed applied to this project).
--
-- Idempotency
-- -----------
-- INSERT ... ON CONFLICT DO NOTHING keyed on (agency_id, recipe_name)
-- makes this safe to re-apply. If the recipe already exists (e.g., from a
-- prior overlay apply), the existing row wins and configuration changes
-- must be applied via explicit UPDATE.
-- =============================================================================

BEGIN;

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
    'Premium Auth Provisioner',
    'Drains _pending_auth_actions queue. Provisions Supabase Auth accounts when staff transition to active, revokes on terminated, restores on rehire. Uses migration 100b atomic helpers (fn_claim_next_auth_action, fn_mark_auth_action_success, fn_mark_auth_action_failure) as two-stage bookends around HTTP calls to the Supabase Auth admin API. Idempotent — 422 already-registered fallback fetches the existing user id so a crash between invite and mark-success does not corrupt state. Prerequisite for the Auto-Provisioning Invariant (design doc §B.12) to function.',
    'cron',
    '* * * * *',
    'INTERNAL',
    NULL,
    'dispatch_premium_auth_provisioner',
    '{
        "max_retries": 5,
        "backoff_seconds": 300,
        "ban_duration_on_revoke": "876000h",
        "required_settings": []
    }'::jsonb,
    '_pending_auth_actions',
    '{
        "log_to_run_log": true
    }'::jsonb,
    true
)
ON CONFLICT (agency_id, recipe_name) DO NOTHING;

-- ============================================================================
-- 3. Provenance (back-filled 2026-07-12 during pre-v1.0 audit)
-- ============================================================================
-- The original shipped version of this migration (v0.5.1-rc1) omitted the
-- INSERT into _install_provenance. Kept for forensic honesty — the
-- 'provenance_backfilled_in' key distinguishes this row from migrations
-- that had provenance from the start.
-- ============================================================================

INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration',                '100c_premium_auth_provisioner_recipe',
    'overlay_version',          '0.5.1-rc1',
    'provenance_backfilled_in', '0.5.8 (pre-v1.0 audit hygiene, 2026-07-12)',
    'applied_at',               now()
  )
)
ON CONFLICT DO NOTHING;

COMMIT;

-- =============================================================================
-- Verification (run manually after apply and after runner-patch)
-- =============================================================================
-- 1. Recipe row exists:
--    SELECT recipe_name, cron_expression, composio_action, internal_handler,
--           is_active, last_run_at, last_run_status
--    FROM automation_recipes
--    WHERE recipe_name = 'Premium Auth Provisioner'
--      AND agency_id = '<agency_id>';
--    Expected: one row, is_active=true, last_run_at initially NULL.
--
-- 2. Wait 1-2 minutes for the pg_cron heartbeat to pick it up.
--    Then confirm the run log:
--    SELECT status, output_summary, records_processed, duration_seconds
--    FROM automation_run_log
--    WHERE recipe_id = (SELECT id FROM automation_recipes
--                       WHERE recipe_name = 'Premium Auth Provisioner')
--    ORDER BY run_at DESC LIMIT 5;
--    Expected: status='success', output_summary='no pending actions',
--    records_processed=0, sub-second duration.
--
-- 3. Trigger a real action:
--    INSERT INTO staff (first_name, last_name, email, status)
--    VALUES ('Test', 'Provisioner', 'test-provisioner@example.com', 'active');
--    Wait 60-90 seconds, then:
--    SELECT auth_user_id FROM staff WHERE email='test-provisioner@example.com';
--    Expected: non-null uuid (an invite email has been sent).
--
--    SELECT processed_by, process_result FROM _pending_auth_actions
--    WHERE staff_email='test-provisioner@example.com';
--    Expected: processed_by='premium_auth_provisioner',
--              process_result->>'success' = 'true'.
--
-- 4. Cleanup:
--    DELETE FROM _pending_auth_actions
--    WHERE staff_id = (SELECT id FROM staff WHERE email='test-provisioner@example.com');
--    DELETE FROM staff WHERE email='test-provisioner@example.com';
--    (Delete the auth user via Supabase Dashboard if desired.)
-- =============================================================================
