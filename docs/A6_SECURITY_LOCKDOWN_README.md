# A6 Security Lockdown — Pending Migration (v10_056)

**Status:** DRAFT — not applied. Filed for later implementation.
**Drafted:** 2026-07-14 by Claude (session batch `bcc-stabilize-2026-07-14T20:50Z`)
**Tracking task:** `16a0785a-3d74-4afa-a349-b8891f8aeaae` in `tasks` table
**Owner:** Rebecca (review + branch test + apply)
**Related advisor:** Supabase security lints `0028_anon_security_definer_function_executable` and `0029_authenticated_security_definer_function_executable`

---

## Why

Supabase security advisors flag **30+ SECURITY DEFINER functions** in the `public` schema as callable by `anon` and `authenticated` roles via PostgREST (`/rest/v1/rpc/<function_name>`). Because these functions run with the definer's (postgres) privileges, invoking them bypasses RLS and can mutate financial data — GL writers, seed functions, document processors, automation dispatchers.

Additionally:

- `comp_recap_account_map` has an RLS policy `auth_all_comp_map` with `USING(true) WITH CHECK(true) FOR ALL` on `authenticated` — permissive-true.
- `anon` holds `INSERT/UPDATE/DELETE` table grants on 14 sensitive tables. RLS deny-by-default blocks these writes in practice (no matching write policies exist), but the grants are misleading in audits.

## What This Closes

| Risk | Severity | Fix |
|---|---|---|
| Anon can invoke `gl_entry_writer`, `bank_gl_writer`, `cc_gl_writer`, `payroll_gl_writer`, `seed_bcc_automations`, `mark_document_parsed`, `run_automation_recipe`, etc. via `/rest/v1/rpc/` | **HIGH** — bypasses RLS entirely | REVOKE EXECUTE from anon + authenticated on 34 RPCs |
| `comp_recap_account_map` ALL policy `USING(true)` | MEDIUM — any authenticated user can write | Replace with agency-scoped `USING (agency_id = ...)` |
| Anon INSERT/UPDATE/DELETE grants on 14 sensitive tables | LOW (unusable in practice, but misleading) | REVOKE the grants for defense-in-depth clarity |

## Pre-Checks Before Applying

1. **Confirm pg_cron identity.** These functions are called by pg_cron every minute (`run_due_automation_recipes`) and on schedule. Verify pg_cron runs as `postgres` or `service_role`, not authenticated.
   ```sql
   SELECT jobname, username FROM cron.job WHERE active;
   ```
2. **Confirm the automation-runner Edge Function uses `SUPABASE_SERVICE_ROLE_KEY`** — not the anon key — when calling these RPCs.
3. **Verify `current_system_overview()` only reads tables anon has SELECT on** (documents, comp_recap, journal_entries, alerts, tasks, etc.). If it touches admin-only tables, revert the SECURITY INVOKER change for that function and restrict via internal auth check instead.
4. **Apply on a development branch first.** Run at least one full 12:00 UTC cycle (daily briefing + monthly close monitor + producer underperformance watcher) and one 5-minute Connection Health Poller cycle before merging to production.
5. **Snapshot before applying:**
   ```sql
   -- Save current grants to a temp table for verification
   CREATE TABLE _a6_pre_snapshot AS
   SELECT p.proname, r.rolname, a.privilege_type
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   LEFT JOIN aclexplode(p.proacl) a ON true
   LEFT JOIN pg_roles r ON r.oid = a.grantee
   WHERE n.nspname = 'public' AND p.prosecdef = true;
   ```

## The Migration

```sql
-- ============================================================================
-- Migration: v10_056_A6_lockdown_definer_functions
-- ============================================================================

BEGIN;

-- Group 1: GL Writers
REVOKE EXECUTE ON FUNCTION public.bank_gl_writer(uuid, uuid)              FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bank_intercompany_writer(uuid, uuid)   FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_gl_writer(uuid, uuid)               FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gl_entry_writer(uuid, uuid)            FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.payroll_gl_writer(uuid, uuid)          FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.write_comp_recap_gl_entries(uuid)      FROM anon, authenticated;

-- Group 2: Automation runners and dispatchers
REVOKE EXECUTE ON FUNCTION public.run_automation_recipe(uuid, text)       FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.run_due_automation_recipes()            FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.run_internal_recipe(uuid)               FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dispatch_document_processor(uuid, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dispatch_email_archiver(uuid, uuid)     FROM anon, authenticated;

-- Group 3: Batch preparation
REVOKE EXECUTE ON FUNCTION public.prepare_document_processor_batch(uuid, integer, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prepare_email_archive_batch(uuid, integer, integer)      FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prepare_facebook_post_batch(uuid, text)                  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prepare_instagram_reminder_batch(uuid, text)             FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prepare_linkedin_post_batch(uuid, text)                  FROM anon, authenticated;

-- Group 4: Result loggers
REVOKE EXECUTE ON FUNCTION public.log_document_processor_result(uuid, uuid, jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_email_archive_result(uuid, uuid, jsonb)      FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_social_post_result(uuid, uuid, jsonb)        FROM anon, authenticated;

-- Group 5: Seed and ingest
REVOKE EXECUTE ON FUNCTION public.seed_bcc_automations(uuid, jsonb, text)  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.seed_comp_recap_documents(uuid)         FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ingest_producer_production(uuid, text, integer, integer, text, numeric, integer, uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.run_document_processor_backfill(uuid, uuid[]) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_document_parsed(uuid, text, integer, text, text[], jsonb) FROM anon, authenticated;

-- Group 6: Monitoring, alerting, business logic
REVOKE EXECUTE ON FUNCTION public.monthly_close_generator(uuid, uuid)           FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.monthly_close_monitor(uuid, uuid)             FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.daily_briefing_composer(uuid, uuid)           FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.producer_underperformance_watcher(uuid, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recipe_silent_failure_detector(uuid, uuid)    FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.goals_auto_sync(uuid, uuid)                   FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.instagram_manual_reminder(uuid, uuid)         FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chp_raise_alert_on_expiry()                   FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_renewal_touches_recompute()               FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recompute_renewal_touch_goals(uuid)           FROM anon, authenticated;

-- Group 7: System-map helpers
REVOKE EXECUTE ON FUNCTION public.bump_system_map_verified(text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_system_map_staleness(integer)  FROM anon, authenticated;

-- Group 8: Read-only status function → SECURITY INVOKER
-- REBECCA: verify current_system_overview only reads anon-SELECTable tables.
ALTER FUNCTION public.current_system_overview() SECURITY INVOKER;

-- Group 9: Tighten comp_recap_account_map RLS
DROP POLICY IF EXISTS auth_all_comp_map ON public.comp_recap_account_map;
CREATE POLICY auth_all_comp_map ON public.comp_recap_account_map
  FOR ALL TO authenticated
  USING       (agency_id = 'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'::uuid)
  WITH CHECK  (agency_id = 'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'::uuid);

-- Group 10: Defense-in-depth — revoke anon table write grants
REVOKE INSERT, UPDATE, DELETE ON
  public.comp_recap,
  public.journal_entries,
  public.bank_accounts,
  public.credit_accounts,
  public.payroll_runs,
  public.payroll_detail,
  public.cpa_general_ledger,
  public.cpa_pnl_monthly,
  public.cpa_balance_sheet,
  public.staff,
  public.settings,
  public.persistent_memory,
  public.producer_production,
  public.documents
FROM anon;

-- Verification block — expect 0 rows
DO $$
DECLARE
  v_leftover integer;
BEGIN
  SELECT COUNT(*) INTO v_leftover
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN aclexplode(p.proacl) a ON true
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public'
    AND p.prosecdef = true
    AND r.rolname IN ('anon','authenticated')
    AND a.privilege_type = 'EXECUTE'
    AND p.proname NOT IN ('current_system_overview');
  IF v_leftover > 0 THEN
    RAISE EXCEPTION 'v10_056: % SECURITY DEFINER grants remain', v_leftover;
  END IF;
END $$;

COMMIT;
```

## Rollback

```sql
BEGIN;

-- Restore comp_recap_account_map permissive policy
DROP POLICY IF EXISTS auth_all_comp_map ON public.comp_recap_account_map;
CREATE POLICY auth_all_comp_map ON public.comp_recap_account_map
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Restore current_system_overview definer
ALTER FUNCTION public.current_system_overview() SECURITY DEFINER;

-- Restore anon table grants
GRANT INSERT, UPDATE, DELETE ON
  public.comp_recap, public.journal_entries, public.bank_accounts,
  public.credit_accounts, public.payroll_runs, public.payroll_detail,
  public.cpa_general_ledger, public.cpa_pnl_monthly, public.cpa_balance_sheet,
  public.staff, public.settings, public.persistent_memory,
  public.producer_production, public.documents
TO anon;

-- Restore function EXECUTE grants (all 34)
GRANT EXECUTE ON FUNCTION public.bank_gl_writer(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_intercompany_writer(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cc_gl_writer(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gl_entry_writer(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_gl_writer(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_comp_recap_gl_entries(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_automation_recipe(uuid,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_due_automation_recipes() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_internal_recipe(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_document_processor(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_email_archiver(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_document_processor_batch(uuid,integer,integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_email_archive_batch(uuid,integer,integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_facebook_post_batch(uuid,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_instagram_reminder_batch(uuid,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_linkedin_post_batch(uuid,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_document_processor_result(uuid,uuid,jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_email_archive_result(uuid,uuid,jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_social_post_result(uuid,uuid,jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_bcc_automations(uuid,jsonb,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_comp_recap_documents(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_producer_production(uuid,text,integer,integer,text,numeric,integer,uuid,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_document_processor_backfill(uuid,uuid[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_document_parsed(uuid,text,integer,text,text[],jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.monthly_close_generator(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.monthly_close_monitor(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.daily_briefing_composer(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.producer_underperformance_watcher(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recipe_silent_failure_detector(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.goals_auto_sync(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.instagram_manual_reminder(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chp_raise_alert_on_expiry() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_renewal_touches_recompute() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_renewal_touch_goals(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_system_map_verified(text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_system_map_staleness(integer) TO anon, authenticated;

COMMIT;
```

---

## Why This Is Safer Than It Looks (context notes)

During the 2026-07-14 stabilization pass, we found that anon `INSERT/UPDATE/DELETE` grants on 14 sensitive tables are **effectively no-ops** in practice — all policies on these tables are SELECT-only with `USING(true)`, and RLS deny-by-default blocks writes because no matching write policies exist. The GRANTS exist but are unusable via PostgREST.

The real exposure is the SECURITY DEFINER RPCs, which bypass RLS entirely. Anyone with the anon URL + the frontend's supabase key (bundled in the Vercel deploy) can POST to `/rest/v1/rpc/gl_entry_writer` and forge journal entries, or call `seed_comp_recap_documents` to reseed. This is what Group 1-7 above closes.
