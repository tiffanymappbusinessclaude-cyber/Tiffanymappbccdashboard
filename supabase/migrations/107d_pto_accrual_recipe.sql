-- =============================================================================
-- Migration 107d — Premium PTO: Nightly Accrual Recipe (handler + seed)
-- =============================================================================
-- Overlay:      bcc-premium-overlay v0.5.1-rc1
-- Prerequisites:
--   * 107a (pto_policies, pto_balances, pto_requests)
--   * 107b (accrual helper functions: _pto_years_of_service,
--           _pto_days_per_year_at_tenure, _pto_current_period_start,
--           _pto_carryover_from_prior_period)
--   * 107c (rpc_run_nightly_pto_accrual — the actual accrual driver)
--   * Base migration 011 (automation_recipes table + automation-runner)
--   * Base migration 012 (run_internal_recipe dispatch + internal_handler column)
--   * Base migration 020 (pg_cron heartbeat on run_due_automation_recipes)
--
-- Why this migration exists
-- -------------------------
-- 107c ships rpc_run_nightly_pto_accrual() as a pure Postgres function that
-- iterates all active staff with an assigned PTO policy and applies accrual
-- based on the policy's pattern (anniversary / monthly / biweekly). It's
-- idempotent — the v_days_since_last check (line 345-348 of 107c) means a
-- second run on the same day is a no-op for staff already accrued today.
--
-- However, its signature does not match the run_internal_recipe dispatch
-- contract (migration 012 comment on automation_recipes.internal_handler):
--
--   "the name of the SQL function to call (must be in public schema,
--    must accept p_agency_id UUID and p_recipe_id UUID, must return jsonb)"
--
-- The underlying RPC:
--   * Signature: rpc_run_nightly_pto_accrual() — zero args
--   * Return:    {processed, skipped, errors, run_at}
--
-- The dispatch contract requires:
--   * Signature: (p_agency_id UUID, p_recipe_id UUID)
--   * Return:    {records_processed, output_summary}
--
-- This migration ships a thin adapter (handler_pto_accrual) that matches
-- the contract, calls the underlying RPC, translates the return shape, and
-- preserves the original detail under a "detail" key for automation_run_log
-- auditing.
--
-- No runner-patch is needed for this recipe. The automation-runner's INTERNAL
-- branch (line ~2999 of index.ts) tries the runtime-orchestrator list first
-- (dispatch_email_archiver, dispatch_document_processor, dispatch_document_
-- processor_backfill, instagram_manual_reminder, dispatch_premium_auth_
-- provisioner). None matches "handler_pto_accrual", so it falls through to
-- the pure-SQL path: run_internal_recipe(recipe_id) reads the recipe's
-- internal_handler string and calls the named Postgres function with
-- (p_agency_id, p_recipe_id) and expects the jsonb return.
--
-- Cron timing (0 6 * * *)
-- -----------------------
-- 6 AM UTC = ~1-2 AM Eastern Time (accounts for both EST and EDT). The
-- accrual is idempotent so exact timing is not correctness-critical, only
-- UX-critical: by the time a producer logs in at 8 AM ET, their newly
-- accrued balance is already visible. The client can adjust via a follow-up
-- UPDATE against automation_recipes.cron_expression if a different local
-- time is preferred.
--
-- Placeholders to replace
-- -----------------------
--   {{agency_id}}   The client's agency UUID (same value as in every other
--                   recipe seed applied to this project).
--
-- Idempotency
-- -----------
-- INSERT ... ON CONFLICT DO NOTHING keyed on (agency_id, recipe_name) makes
-- this safe to re-apply. If the recipe already exists (e.g., from a prior
-- overlay apply), the existing row wins; configuration changes require an
-- explicit UPDATE.
-- =============================================================================

BEGIN;

-- ============================================================================
-- 1. The adapter function
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handler_pto_accrual(
  p_agency_id uuid,
  p_recipe_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_underlying    jsonb;
  v_processed     integer;
  v_skipped       integer;
  v_errors_count  integer;
BEGIN
  -- Delegate to the shipped RPC. p_agency_id is accepted for contract
  -- compliance and future-proofing; the underlying RPC iterates all active
  -- staff globally because each BCC install runs against a single-agency
  -- Supabase project by convention.
  v_underlying := public.rpc_run_nightly_pto_accrual();

  v_processed    := COALESCE((v_underlying->>'processed')::integer, 0);
  v_skipped      := COALESCE((v_underlying->>'skipped')::integer, 0);
  v_errors_count := COALESCE(jsonb_array_length(v_underlying->'errors'), 0);

  RETURN jsonb_build_object(
    'records_processed', v_processed,
    'output_summary', format(
      'PTO accrual: %s staff accrued, %s skipped, %s error%s',
      v_processed,
      v_skipped,
      v_errors_count,
      CASE WHEN v_errors_count = 1 THEN '' ELSE 's' END
    ),
    -- Preserve the underlying detail for automation_run_log auditing. The
    -- runner's outer wrapper reads records_processed + output_summary and
    -- writes them to automation_run_log, but does not inspect other keys —
    -- the detail block persists in the run log's output_summary column via
    -- the summary text and is also queryable via the run log's raw response.
    'detail', v_underlying
  );
END $$;

REVOKE ALL ON FUNCTION public.handler_pto_accrual(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handler_pto_accrual(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.handler_pto_accrual(uuid, uuid) IS
  'Recipe-contract adapter for rpc_run_nightly_pto_accrual. Matches the (p_agency_id, p_recipe_id) -> jsonb signature required by run_internal_recipe (migration 012). Translates the underlying {processed, skipped, errors, run_at} into {records_processed, output_summary, detail} for the automation-runner. Idempotency inherited from the underlying RPC.';

-- ============================================================================
-- 2. The recipe seed
-- ============================================================================

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
    'Premium PTO Nightly Accrual',
    'Nightly per-staff PTO accrual driver. Iterates active staff with an assigned PTO policy and applies the appropriate accrual amount based on the policy pattern (anniversary / monthly / biweekly). Idempotent — a second run on the same day is a no-op for staff already accrued today (via last_accrual_date check). Skips staff whose policy is unlimited or whose hire_date + waiting_period is in the future. Ships in bcc-premium-overlay v0.5.1-rc1 via the handler_pto_accrual adapter and this recipe seed. See migration 107c for the underlying rpc_run_nightly_pto_accrual driver.',
    'cron',
    '0 6 * * *',
    'INTERNAL',
    NULL,
    'handler_pto_accrual',
    '{}'::jsonb,
    'pto_balances',
    '{
        "log_to_run_log": true
    }'::jsonb,
    true
)
ON CONFLICT (agency_id, recipe_name) DO NOTHING;

-- ============================================================================
-- 3. Provenance
-- ============================================================================

INSERT INTO public._install_provenance (event_type, event_data)
VALUES (
  'overlay_migration_applied',
  jsonb_build_object(
    'migration', '107d_pto_accrual_recipe',
    'overlay_version', '0.5.1-rc1',
    'applied_at', now()
  )
)
ON CONFLICT DO NOTHING;

COMMIT;

-- =============================================================================
-- Verification (run manually after apply)
-- =============================================================================
--
-- 1. Adapter function exists and has correct signature:
--    SELECT proname, pg_get_function_identity_arguments(oid) AS args
--      FROM pg_proc
--     WHERE proname = 'handler_pto_accrual';
--    Expected: one row, args = 'p_agency_id uuid, p_recipe_id uuid'.
--
-- 2. Recipe row exists:
--    SELECT recipe_name, cron_expression, composio_action, internal_handler,
--           is_active, last_run_at, last_run_status
--      FROM automation_recipes
--     WHERE recipe_name = 'Premium PTO Nightly Accrual'
--       AND agency_id = '<agency_id>';
--    Expected: one row, cron_expression='0 6 * * *', composio_action='INTERNAL',
--    internal_handler='handler_pto_accrual', is_active=true, last_run_at
--    initially NULL.
--
-- 3. Manual dry-run of the adapter (safe — the underlying RPC is idempotent):
--    SELECT public.handler_pto_accrual(
--      '<agency_id>'::uuid,
--      (SELECT id FROM automation_recipes
--        WHERE recipe_name = 'Premium PTO Nightly Accrual'
--          AND agency_id = '<agency_id>')
--    );
--    Expected: jsonb with keys records_processed, output_summary, detail.
--    output_summary text should read like "PTO accrual: N staff accrued,
--    M skipped, K errors". detail should contain the underlying processed/
--    skipped/errors/run_at from the RPC.
--
-- 4. End-to-end: wait until the next 06:00 UTC (or manually trigger the
--    recipe via SELECT run_automation_recipe(recipe_id) if urgent). Then
--    check automation_run_log:
--    SELECT status, output_summary, records_processed, duration_seconds
--      FROM automation_run_log
--     WHERE recipe_id = (SELECT id FROM automation_recipes
--                        WHERE recipe_name = 'Premium PTO Nightly Accrual')
--     ORDER BY run_at DESC LIMIT 3;
--    Expected: status='success', output_summary containing the accrual
--    counts, sub-second-to-few-seconds duration depending on staff count.
--
-- 5. Verify balance movement: check pto_balances for last_accrual_date =
--    CURRENT_DATE on any active staff with a policy:
--    SELECT s.email, b.balance_days, b.accrued_this_period, b.last_accrual_date
--      FROM pto_balances b
--      JOIN staff s ON s.id = b.staff_id
--     WHERE s.status = 'active'
--       AND b.last_accrual_date = CURRENT_DATE
--     ORDER BY s.email;
-- =============================================================================
