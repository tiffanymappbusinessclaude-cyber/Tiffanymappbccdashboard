-- =========================================================================
-- bcc-debug/audit-2026-07-24T03Z — Monthly Close Monitor reconciliation
-- Task 2fc1fdf7
-- Complements v10_054_monthly_close_monitor_dedup_fix (unchanged).
-- Adds a reconciliation pass at the top of the handler that scans pending
-- checklist rows and links the most recent matching processed document.
-- Also auto-resolves overdue_close_item alerts for newly-reconciled rows.
-- Rollback: re-apply prior body from pg_get_functiondef captured in
--           persistent_memory session_wrap 1052b2d4.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.monthly_close_monitor(p_agency_id uuid, p_recipe_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_today DATE := CURRENT_DATE;
  v_last_day DATE := (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::date;
  v_overdue_count INTEGER := 0;
  v_created_count INTEGER := 0;
  v_reconciled_count INTEGER := 0;
  v_alerts_resolved_count INTEGER := 0;
  v_overdue RECORD;
  v_target_year INTEGER;
  v_target_month INTEGER;
BEGIN
  -- =====================================================================
  -- FIX bcc-debug/audit-2026-07-24T03Z (Task 2fc1fdf7):
  -- Reconciliation pass — link processed docs to pending checklist rows
  -- before the overdue check runs. Match window: doc uploaded_at from
  -- 15 days before the checklist's period start to 45 days after.
  -- =====================================================================
  WITH matches AS (
    SELECT DISTINCT ON (c.id) c.id AS checklist_id, d.id AS doc_id, d.uploaded_at
    FROM public.monthly_close_checklist c
    JOIN public.documents d
      ON d.agency_id = c.agency_id
     AND d.document_type = c.doc_category
     AND d.processing_status = 'processed'
     AND d.uploaded_at::date BETWEEN 
           (MAKE_DATE(c.period_year, c.period_month, 1) - INTERVAL '15 days')::date
       AND (MAKE_DATE(c.period_year, c.period_month, 1) + INTERVAL '45 days')::date
    WHERE c.agency_id = p_agency_id
      AND c.status = 'pending'
      AND c.received_at IS NULL
    ORDER BY c.id, d.uploaded_at DESC
  ),
  reconciled AS (
    UPDATE public.monthly_close_checklist c
    SET status = 'received',
        received_at = NOW(),
        document_id = m.doc_id,
        notes = COALESCE(c.notes || E'\n', '') || 
                'monthly_close_monitor auto-reconciled ' || CURRENT_DATE::text ||
                ' — matched doc ' || m.doc_id::text
    FROM matches m
    WHERE c.id = m.checklist_id
    RETURNING c.id
  )
  SELECT COUNT(*) INTO v_reconciled_count FROM reconciled;

  -- Auto-resolve overdue-close-item alerts for any checklist row just reconciled.
  UPDATE public.alerts a
  SET is_resolved = true,
      resolved_at = NOW(),
      message = COALESCE(a.message, '') || 
                E'\n[monthly_close_monitor auto-resolved on reconciliation ' || CURRENT_DATE::text || ']'
  WHERE a.agency_id = p_agency_id
    AND a.alert_type = 'overdue_close_item'
    AND a.is_resolved = false
    AND EXISTS (
      SELECT 1 FROM public.monthly_close_checklist c
      WHERE 'monthly_close_monitor:' || c.id::text = a.module_reference
        AND c.status = 'received'
        AND c.received_at::date = CURRENT_DATE
    );
  GET DIAGNOSTICS v_alerts_resolved_count = ROW_COUNT;

  -- =====================================================================
  -- Original overdue-check logic (unchanged) — only fires against rows
  -- that remain pending after the reconciliation pass.
  -- =====================================================================
  IF EXTRACT(DAY FROM v_today)::INT >= 5 THEN
    FOR v_overdue IN
      SELECT id, doc_label FROM public.monthly_close_checklist
      WHERE agency_id = p_agency_id AND period_year = EXTRACT(YEAR FROM v_today)::INT
        AND period_month = EXTRACT(MONTH FROM v_today)::INT
        AND received_at IS NULL AND expected_by IS NOT NULL AND expected_by < v_today
    LOOP
      INSERT INTO public.alerts (agency_id, alert_type, severity, title, message, module_reference, is_read, is_resolved, created_at)
      SELECT p_agency_id, 'overdue_close_item', 'warning',
        'Monthly close item overdue: ' || v_overdue.doc_label,
        'Item is past expected_by date. Review in Financials → Monthly Close.',
        'monthly_close_monitor:' || v_overdue.id::text, false, false, NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM public.alerts
        WHERE agency_id = p_agency_id
          AND module_reference = 'monthly_close_monitor:' || v_overdue.id::text
          AND is_resolved = false
      );
      GET DIAGNOSTICS v_overdue_count = ROW_COUNT;
    END LOOP;
  END IF;

  -- Original next-month rollover generator (unchanged)
  IF v_today >= v_last_day - INTERVAL '2 days' THEN
    IF EXTRACT(MONTH FROM v_today)::INT = 12 THEN
      v_target_year := EXTRACT(YEAR FROM v_today)::INT + 1;
      v_target_month := 1;
    ELSE
      v_target_year := EXTRACT(YEAR FROM v_today)::INT;
      v_target_month := EXTRACT(MONTH FROM v_today)::INT + 1;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.monthly_close_checklist WHERE agency_id = p_agency_id
        AND period_year = v_target_year AND period_month = v_target_month) THEN
      INSERT INTO public.monthly_close_checklist (agency_id, period_year, period_month, doc_category, doc_label, expected_by, status, is_closed, created_at)
      SELECT p_agency_id, v_target_year, v_target_month, doc_category, doc_label,
        MAKE_DATE(v_target_year, v_target_month, LEAST(EXTRACT(DAY FROM expected_by)::INT,
          EXTRACT(DAY FROM (MAKE_DATE(v_target_year, v_target_month, 1) + INTERVAL '1 month - 1 day'))::INT)),
        'pending', false, NOW()
      FROM (SELECT DISTINCT ON (doc_category, doc_label) doc_category, doc_label, expected_by
        FROM public.monthly_close_checklist WHERE agency_id = p_agency_id
          AND period_year = EXTRACT(YEAR FROM v_today)::INT AND period_month = EXTRACT(MONTH FROM v_today)::INT
          AND expected_by IS NOT NULL ORDER BY doc_category, doc_label, created_at DESC) src;
      GET DIAGNOSTICS v_created_count = ROW_COUNT;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'records_processed', v_overdue_count + v_created_count + v_reconciled_count + v_alerts_resolved_count,
    'output_summary', 
      v_reconciled_count || ' docs auto-reconciled, ' ||
      v_alerts_resolved_count || ' overdue alerts auto-resolved, ' ||
      v_overdue_count || ' new overdue alerts, ' ||
      v_created_count || ' next-month checklist items created'
  );
END;
$function$;
