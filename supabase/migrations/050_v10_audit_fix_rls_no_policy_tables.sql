-- ============================================================================
-- Repo file: 050_v10_audit_fix_rls_no_policy_tables.sql
-- Applied to DB: 2026-07-07 19:48:27 UTC  (migration version 20260707194827)
-- DB migration name: v10_audit_fix_rls_no_policy_tables
-- Provenance: applied via Supabase MCP as part of v10 audit-fix arc; back-filled
--             into repo 2026-07-08 to close repo↔DB migration drift.
-- ============================================================================

-- v10-audit-fix/rls-no-policy-tables
-- Enable RLS + add policies for the 3 no-policy tables surfaced in the audit.
-- Matches pattern used by other 48 anon-policied tables.
-- Wiki tables are read-only for anon; classification_rules follows FOR ALL pattern
-- because the classifier writes back scores.

ALTER TABLE public.classification_rules ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='classification_rules' AND policyname='classification_rules_anon_all') THEN
    CREATE POLICY classification_rules_anon_all ON public.classification_rules FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

ALTER TABLE public.system_map ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='system_map' AND policyname='system_map_anon_read') THEN
    CREATE POLICY system_map_anon_read ON public.system_map FOR SELECT TO anon USING (true);
  END IF;
END $$;

ALTER TABLE public.system_map_revisions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='system_map_revisions' AND policyname='system_map_revisions_anon_read') THEN
    CREATE POLICY system_map_revisions_anon_read ON public.system_map_revisions FOR SELECT TO anon USING (true);
  END IF;
END $$;
