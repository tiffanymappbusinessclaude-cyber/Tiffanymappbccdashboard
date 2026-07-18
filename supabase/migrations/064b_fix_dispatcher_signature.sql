-- =============================================================================
-- Migration 024b: HOTFIX run_internal_recipe dispatcher signatures
-- =============================================================================
-- Migration 024 incorrectly called handlers with a single uuid arg. All 
-- production handlers in this project take (p_agency_id uuid, p_recipe_id uuid).
-- Only calendar_sync_pending takes no args. This fix restores correct calling
-- convention while preserving the calendar_sync_pending route.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.run_internal_recipe(p_recipe_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_recipe RECORD;
  v_result jsonb;
BEGIN
  SELECT * INTO v_recipe FROM public.automation_recipes WHERE id = p_recipe_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recipe % not found', p_recipe_id;
  END IF;

  -- Dispatch — all handlers take (p_agency_id, p_recipe_id) EXCEPT calendar_sync_pending which takes ()
  CASE v_recipe.internal_handler
    WHEN 'gl_entry_writer' THEN
      v_result := public.gl_entry_writer(v_recipe.agency_id, v_recipe.id);
    WHEN 'monthly_close_monitor' THEN
      v_result := public.monthly_close_monitor(v_recipe.agency_id, v_recipe.id);
    WHEN 'producer_underperformance_watcher' THEN
      v_result := public.producer_underperformance_watcher(v_recipe.agency_id, v_recipe.id);
    WHEN 'bank_gl_writer' THEN
      v_result := public.bank_gl_writer(v_recipe.agency_id, v_recipe.id);
    WHEN 'cc_gl_writer' THEN
      v_result := public.cc_gl_writer(v_recipe.agency_id, v_recipe.id);
    WHEN 'payroll_gl_writer' THEN
      v_result := public.payroll_gl_writer(v_recipe.agency_id, v_recipe.id);
    WHEN 'dispatch_email_archiver' THEN
      v_result := public.dispatch_email_archiver(v_recipe.agency_id, v_recipe.id);
    WHEN 'dispatch_document_processor' THEN
      v_result := public.dispatch_document_processor(v_recipe.agency_id, v_recipe.id);
    WHEN 'monthly_close_generator' THEN
      v_result := public.monthly_close_generator(v_recipe.agency_id, v_recipe.id);
    WHEN 'daily_briefing_composer' THEN
      v_result := public.daily_briefing_composer(v_recipe.agency_id, v_recipe.id);
    WHEN 'parse_documents' THEN
      v_result := public.parse_documents(v_recipe.agency_id, v_recipe.id);
    WHEN 'instagram_manual_reminder' THEN
      v_result := public.instagram_manual_reminder(v_recipe.agency_id, v_recipe.id);
    WHEN 'calendar_sync_pending' THEN
      v_result := public.calendar_sync_pending();  -- no-arg handler
    ELSE
      RAISE EXCEPTION 'Unknown internal_handler: %', v_recipe.internal_handler;
  END CASE;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.run_internal_recipe(uuid) TO service_role;
