-- BCC v10.051 -- security hardening batch (A2 + A3 + A4)
-- Applied 2026-07-09 by BCC audit follow-up. Reverses no functional behavior.
-- A5 (extensions in public: pg_trgm, pg_net) deliberately deferred: pg_net is called
-- by pg_cron jobs via net.http_post() and requires additional test coverage before moving.

-- =========================================================================
-- A2. classification_rules RLS -- anon SELECT-only, service_role for writes
-- =========================================================================
DROP POLICY IF EXISTS classification_rules_anon_all ON public.classification_rules;

CREATE POLICY classification_rules_anon_select
  ON public.classification_rules
  FOR SELECT
  TO anon
  USING (true);

CREATE POLICY classification_rules_service_write
  ON public.classification_rules
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- =========================================================================
-- A3. Fix SECURITY DEFINER view (Supabase advisor ERROR-level)
-- Change to SECURITY INVOKER so the view enforces the querying user's RLS,
-- not the view creator's. Safe because underlying tables have anon SELECT policies.
-- =========================================================================
ALTER VIEW public.vw_bcc_vs_cpa_commission_variance SET (security_invoker = true);

-- =========================================================================
-- A4. Pin search_path on 11 SECURITY DEFINER / trigger functions.
-- Prevents search_path hijacking (Supabase advisor WARN-level, standard hardening).
-- =========================================================================
ALTER FUNCTION public.bank_gl_writer(p_agency_id uuid, p_recipe_id uuid)                                   SET search_path = public;
ALTER FUNCTION public.cc_gl_writer(p_agency_id uuid, p_recipe_id uuid)                                     SET search_path = public;
ALTER FUNCTION public.payroll_gl_writer(p_agency_id uuid, p_recipe_id uuid)                                SET search_path = public;
ALTER FUNCTION public.monthly_close_generator(p_agency_id uuid, p_recipe_id uuid)                          SET search_path = public;
ALTER FUNCTION public.prepare_email_archive_batch(p_agency_id uuid, p_older_than_days integer, p_max_batch integer)
                                                                                                            SET search_path = public;
ALTER FUNCTION public.log_email_archive_result(p_agency_id uuid, p_recipe_id uuid, p_result jsonb)         SET search_path = public;
ALTER FUNCTION public.normalize_lob(p_input text)                                                          SET search_path = public;
ALTER FUNCTION public.resolve_staff_id(p_agency_id uuid, p_name text)                                      SET search_path = public;
ALTER FUNCTION public.has_aa05_prohibited_terms(p_text text)                                               SET search_path = public;
ALTER FUNCTION public.tg_system_map_touch()                                                                SET search_path = public;
ALTER FUNCTION public.tg_system_map_revise()                                                               SET search_path = public;

-- =========================================================================
-- Marker row so persistent_memory / phase tracker can join later
-- =========================================================================
COMMENT ON POLICY classification_rules_anon_select ON public.classification_rules IS
  'BCC v10.051 (2026-07-09): anon read of classification rules for webapp display. Writes go through service_role only.';
COMMENT ON POLICY classification_rules_service_write ON public.classification_rules IS
  'BCC v10.051 (2026-07-09): service_role writes only. If webapp needs write, wrap in Edge Function with service key.';
COMMENT ON VIEW public.vw_bcc_vs_cpa_commission_variance IS
  'BCC v10.051 (2026-07-09): security_invoker=true -- enforces caller RLS. Was SECURITY DEFINER prior.';
