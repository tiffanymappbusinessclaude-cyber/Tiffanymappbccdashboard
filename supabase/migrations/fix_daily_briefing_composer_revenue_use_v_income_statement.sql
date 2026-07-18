-- Fix: daily_briefing_composer was double-counting revenue.
--
-- The comp_recap table carries two coexisting layers:
--   1. qbo_derived_composite (cash basis, from QBO deposits, source_document_id IS NULL)
--   2. Phase 3 line items (parsed from SF AGTCOMP RECAP PDFs, source_document_id IS NOT NULL)
-- Both layers represent the same revenue from different views.
-- The previous briefing query summed both: SUM(amount) WHERE period_year = 2026 AND amount > 0
-- That doubled the number. 6/19/2026 briefing reported Revenue YTD $415,504 instead of $208,576.
--
-- This migration replaces the comp_recap revenue queries with v_income_statement, which is the
-- canonical P&L view the Financials module reads. Single source of truth across the BCC.
--
-- All other behavior unchanged. Function signature unchanged.

CREATE OR REPLACE FUNCTION public.daily_briefing_composer(p_agency_id uuid, p_recipe_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_input_config     jsonb;
  v_recipient        TEXT;
  v_tz               TEXT;
  v_today            DATE;
  v_briefing_id      UUID;
  v_subject          TEXT;
  v_body             TEXT;

  v_agency_name      TEXT;
  v_owner_name       TEXT;

  v_composio_api_key TEXT;
  v_composio_user_id TEXT;
  v_gmail_account_id TEXT;
  v_request_id       BIGINT;

  v_revenue_ytd      NUMERIC;
  v_revenue_mtd      NUMERIC;
  v_aipp_target      NUMERIC;
  v_aipp_earned      NUMERIC;
  v_aipp_pct         NUMERIC;
  v_open_tasks       INT;
  v_open_alerts      INT;
  v_compliance_count INT;
  v_active_staff     INT;
BEGIN
  -- Load recipe input_config
  SELECT input_config INTO v_input_config
  FROM public.automation_recipes
  WHERE id = p_recipe_id;

  IF v_input_config IS NULL THEN
    RAISE EXCEPTION 'daily_briefing_composer: recipe % has no input_config', p_recipe_id;
  END IF;

  v_recipient := v_input_config->>'recipient_email';
  v_tz        := COALESCE(v_input_config->>'tz', 'America/New_York');

  IF v_recipient IS NULL OR length(trim(v_recipient)) = 0 THEN
    RAISE EXCEPTION 'daily_briefing_composer: input_config.recipient_email is missing for recipe %', p_recipe_id;
  END IF;

  v_today := (NOW() AT TIME ZONE v_tz)::date;

  -- Load agency identity
  SELECT name, COALESCE(owner_name, 'Sunshine State')
  INTO v_agency_name, v_owner_name
  FROM public.agency
  WHERE id = p_agency_id;

  -- Resolve Composio credentials (fail fast if missing)
  v_composio_api_key := public.get_setting(p_agency_id, 'composio_api_key');
  v_composio_user_id := public.get_setting(p_agency_id, 'composio_user_id');
  v_gmail_account_id := public.get_setting(p_agency_id, 'composio_gmail_account_id');

  IF v_composio_api_key IS NULL THEN
    RAISE EXCEPTION 'daily_briefing_composer: settings.composio_api_key not set for agency %', p_agency_id;
  END IF;
  IF v_composio_user_id IS NULL THEN
    RAISE EXCEPTION 'daily_briefing_composer: settings.composio_user_id not set for agency %', p_agency_id;
  END IF;
  IF v_gmail_account_id IS NULL THEN
    RAISE EXCEPTION 'daily_briefing_composer: settings.composio_gmail_account_id not set for agency %', p_agency_id;
  END IF;

  -- Revenue YTD/MTD — read from v_income_statement (canonical P&L view that
  -- the Financials module reads). Single source of truth across the BCC.
  SELECT COALESCE(SUM(amount), 0)
  INTO v_revenue_ytd
  FROM public.v_income_statement
  WHERE agency_id = p_agency_id
    AND year         = EXTRACT(YEAR FROM v_today)::int
    AND account_type = 'income';

  SELECT COALESCE(SUM(amount), 0)
  INTO v_revenue_mtd
  FROM public.v_income_statement
  WHERE agency_id = p_agency_id
    AND year         = EXTRACT(YEAR  FROM v_today)::int
    AND month        = EXTRACT(MONTH FROM v_today)::int
    AND account_type = 'income';

  SELECT target_amount, earned_ytd, achievement_percentage
  INTO v_aipp_target, v_aipp_earned, v_aipp_pct
  FROM public.aipp_tracking
  WHERE agency_id = p_agency_id
    AND program_year = EXTRACT(YEAR FROM v_today)::int
  ORDER BY last_updated DESC NULLS LAST
  LIMIT 1;

  SELECT COUNT(*) INTO v_open_tasks
  FROM public.tasks
  WHERE agency_id = p_agency_id
    AND COALESCE(status, 'open') IN ('open', 'in_progress', 'pending');

  SELECT COUNT(*) INTO v_open_alerts
  FROM public.alerts
  WHERE agency_id = p_agency_id
    AND COALESCE(is_resolved, false) = false;

  SELECT COUNT(*) INTO v_compliance_count
  FROM public.compliance_calendar
  WHERE agency_id = p_agency_id
    AND due_date BETWEEN v_today AND v_today + INTERVAL '14 days'
    AND COALESCE(status, 'pending') <> 'completed';

  SELECT COUNT(*) INTO v_active_staff
  FROM public.staff
  WHERE agency_id = p_agency_id
    AND COALESCE(is_active, true) = true;

  -- Compose subject + HTML body
  v_subject := 'Daily Briefing — ' || COALESCE(v_agency_name, 'Agency') || ' — ' || to_char(v_today, 'Mon DD, YYYY');

  v_body := format(
$html$<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1a1a1a; max-width: 640px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1a1a1a; border-bottom: 3px solid #d52b1e; padding-bottom: 10px; margin-top: 0;">Good morning, %s</h2>
  <p style="font-size: 15px; color: #444;">Here's where %s stands as of %s.</p>

  <h3 style="margin-top: 28px; color: #d52b1e;">Where we are</h3>
  <table style="width: 100%%; border-collapse: collapse; font-size: 14px;">
    <tr><td style="padding: 8px 0; color: #555; border-bottom: 1px solid #f0f0f0;">Revenue YTD</td><td style="text-align: right; font-weight: 600; padding: 8px 0; border-bottom: 1px solid #f0f0f0;">$%s</td></tr>
    <tr><td style="padding: 8px 0; color: #555; border-bottom: 1px solid #f0f0f0;">Revenue MTD</td><td style="text-align: right; font-weight: 600; padding: 8px 0; border-bottom: 1px solid #f0f0f0;">$%s</td></tr>
    <tr><td style="padding: 8px 0; color: #555; border-bottom: 1px solid #f0f0f0;">AIPP earned YTD</td><td style="text-align: right; font-weight: 600; padding: 8px 0; border-bottom: 1px solid #f0f0f0;">$%s of $%s (%s%%)</td></tr>
    <tr><td style="padding: 8px 0; color: #555;">Active team members</td><td style="text-align: right; font-weight: 600; padding: 8px 0;">%s</td></tr>
  </table>

  <h3 style="margin-top: 28px; color: #d52b1e;">Today's priorities</h3>
  <ul style="font-size: 14px; line-height: 1.8; color: #333;">
    <li><strong>%s</strong> open tasks</li>
    <li><strong>%s</strong> active alerts to review</li>
    <li><strong>%s</strong> compliance items due in the next 14 days</li>
  </ul>

  <h3 style="margin-top: 28px; color: #d52b1e;">What I'm watching</h3>
  <p style="font-size: 14px; color: #444;">Standing watch on financial ratios, AIPP pace, ScoreBoard L&amp;H multiplier, producer ROI windows, recipe health, and your compliance calendar. Ask me anything in the BCC chat — I have today's data live.</p>

  <p style="margin-top: 36px; color: #999; font-size: 12px; border-top: 1px solid #e5e5e5; padding-top: 14px;">
    Sunshine State's Claude · Business Command Center · briefing for %s
  </p>
</body></html>$html$,
    v_owner_name,
    COALESCE(v_agency_name, 'the agency'),
    to_char(v_today, 'FMDay, FMMonth FMDD, YYYY'),
    to_char(v_revenue_ytd, 'FM999,999,990.00'),
    to_char(v_revenue_mtd, 'FM999,999,990.00'),
    to_char(COALESCE(v_aipp_earned, 0), 'FM999,999,990.00'),
    to_char(COALESCE(v_aipp_target, 0), 'FM999,999,990.00'),
    to_char(COALESCE(v_aipp_pct, 0), 'FM990.0'),
    v_active_staff,
    v_open_tasks,
    v_open_alerts,
    v_compliance_count,
    to_char(v_today, 'YYYY-MM-DD')
  );

  -- Upsert briefings row (idempotent for same-day re-runs)
  INSERT INTO public.briefings (agency_id, briefing_date, subject, body, recipient_email)
  VALUES (p_agency_id, v_today, v_subject, v_body, v_recipient)
  ON CONFLICT (agency_id, briefing_date)
  DO UPDATE SET subject         = EXCLUDED.subject,
                body            = EXCLUDED.body,
                recipient_email = EXCLUDED.recipient_email,
                updated_at      = NOW()
  RETURNING id INTO v_briefing_id;

  -- Send via Composio Gmail (fire-and-forget pg_net, returns request_id)
  SELECT net.http_post(
    url     := 'https://backend.composio.dev/api/v3/tools/execute/GMAIL_SEND_EMAIL',
    headers := jsonb_build_object(
                 'x-api-key',    v_composio_api_key,
                 'Content-Type', 'application/json'
               ),
    body    := jsonb_build_object(
                 'user_id',              v_composio_user_id,
                 'connected_account_id', v_gmail_account_id,
                 'arguments', jsonb_build_object(
                                'recipient_email', v_recipient,
                                'subject',         v_subject,
                                'body',            v_body,
                                'is_html',         true
                              )
               ),
    timeout_milliseconds := 30000
  ) INTO v_request_id;

  -- Record sent_at + pg_net request_id (response correlation possible via net._http_response)
  UPDATE public.briefings
  SET sent_at           = NOW(),
      pg_net_request_id = v_request_id,
      updated_at        = NOW()
  WHERE id = v_briefing_id;

  RETURN jsonb_build_object(
    'records_processed', 1,
    'output_summary',    'Sent: "' || v_subject || '" to ' || v_recipient || ' (briefing_id=' || v_briefing_id::text || ', pg_net_request_id=' || v_request_id::text || ')'
  );
END;
$function$;
