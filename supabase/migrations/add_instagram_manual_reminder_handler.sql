-- Handler for Social Media Scheduler — Instagram recipe.
-- Scans content_calendar for today's Instagram items in 'scheduled' status,
-- creates a high-priority task per item reminding the operator to post manually
-- (Instagram has no public auto-post API for business pages).
-- Idempotent via module_reference 'instagram_manual_reminder:<calendar_id>:<date>'.

CREATE OR REPLACE FUNCTION public.instagram_manual_reminder(
  p_agency_id UUID,
  p_recipe_id UUID
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today        DATE := CURRENT_DATE;
  v_tasks_created INTEGER := 0;
  v_template      TEXT;
  v_recipe_cfg    jsonb;
  v_priority      TEXT;
  v_calendar      RECORD;
  v_task_title    TEXT;
  v_mod_ref       TEXT;
  v_post_title    TEXT;
BEGIN
  SELECT input_config INTO v_recipe_cfg
  FROM public.automation_recipes WHERE id = p_recipe_id;

  v_template := COALESCE(v_recipe_cfg->>'task_title_template', 
                         'Post to Instagram today: {{post_title}}');
  v_priority := COALESCE(v_recipe_cfg->>'task_priority', 'high');

  FOR v_calendar IN
    SELECT id, caption, scheduled_date, content_type, media_url, hashtags
    FROM public.content_calendar
    WHERE agency_id = p_agency_id
      AND LOWER(COALESCE(platform, '')) = 'instagram'
      AND LOWER(COALESCE(status,   '')) = 'scheduled'
      AND scheduled_date = v_today
  LOOP
    v_post_title := COALESCE(
      NULLIF(LEFT(REGEXP_REPLACE(COALESCE(v_calendar.caption, ''), E'[\\n\\r]+', ' ', 'g'), 60), ''),
      v_calendar.content_type,
      'Instagram post'
    );
    v_task_title := REPLACE(v_template, '{{post_title}}', v_post_title);
    v_mod_ref := 'instagram_manual_reminder:' || v_calendar.id::text || ':' || v_today::text;

    INSERT INTO public.tasks (
      agency_id, title, description, priority, status, module_reference, 
      related_id, due_date, created_by, created_at, updated_at
    )
    SELECT 
      p_agency_id,
      v_task_title,
      'Caption and hashtags are already on the content_calendar row. Copy them, open Instagram, post manually. Then come back and mark the calendar row status=posted with the post_url.',
      v_priority,
      'pending',
      v_mod_ref,
      v_calendar.id,
      v_today,
      'instagram_manual_reminder',
      NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM public.tasks 
      WHERE agency_id = p_agency_id
        AND module_reference = v_mod_ref
        AND status != 'completed'
    );

    IF FOUND THEN
      v_tasks_created := v_tasks_created + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'records_processed', v_tasks_created,
    'output_summary', v_tasks_created || ' Instagram manual-post reminder task(s) created for ' || v_today::text
  );
END;
$$;
