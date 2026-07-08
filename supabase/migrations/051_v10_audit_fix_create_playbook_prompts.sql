-- ============================================================================
-- Repo file: 051_v10_audit_fix_create_playbook_prompts.sql
-- Applied to DB: 2026-07-07 19:48:38 UTC  (migration version 20260707194838)
-- DB migration name: v10_audit_fix_create_playbook_prompts
-- Provenance: applied via Supabase MCP as part of v10 audit-fix arc; back-filled
--             into repo 2026-07-08 to close repo↔DB migration drift.
-- ============================================================================

-- v10-audit-fix/playbook-prompts-table
-- Creates the missing v10 Playbook & Guide backing table (§17).
-- Table is empty on create; content seeding is a separate ask (requires v10 source).

CREATE TABLE IF NOT EXISTS public.playbook_prompts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug text UNIQUE NOT NULL,
  section text NOT NULL,
  title text NOT NULL,
  prompt_body text NOT NULL,
  sort_order int NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS playbook_prompts_section_sort_idx
  ON public.playbook_prompts (section, sort_order);

ALTER TABLE public.playbook_prompts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='playbook_prompts' AND policyname='playbook_prompts_anon_read') THEN
    CREATE POLICY playbook_prompts_anon_read ON public.playbook_prompts FOR SELECT TO anon USING (true);
  END IF;
END $$;

COMMENT ON TABLE public.playbook_prompts IS 'v10 Playbook & Guide backing store. Sections per guide §17: getting_started, financials, compliance, hr_people, automations, documents, tasks_goals, social_media, wiki_system_map, playbook_guide, growth_strategy, troubleshooting, reference.';
