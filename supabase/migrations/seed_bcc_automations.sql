-- =============================================================================
-- Migration: seed_bcc_automations()
-- =============================================================================
-- One-call function that seeds the entire canonical 14-recipe BCC automation
-- suite for a new client agency. Replaces the previous pattern of running
-- each seed file by hand (saves 1-2 hours per install).
--
-- USAGE:
--   SELECT seed_bcc_automations(
--       p_agency_id := '<client-agency-uuid>'::uuid,
--       p_config := '{
--           "recipient_email": "operator@example.com",
--           "timezone": "America/New_York",
--           "payroll_cash_account_name": "Operating Cash",
--           "bank_income_account_code": "QBO-001",
--           "bank_expenses_account_code": "QBO-002",
--           "primary_card_label": "SF Card — Owner",
--           "primary_card_code": "QBO-010",
--           "secondary_card_label": null,
--           "secondary_card_code": null,
--           "personal_distribution_accounts": [],
--           "legacy_personal_cards": []
--       }'::jsonb,
--       p_payroll_variant := 'single_entity'  -- or 'two_entity'
--   );
--
-- TWO-ENTITY EXTRA CONFIG (only if p_payroll_variant = 'two_entity'):
--   "parent_entity_name": "PaperNewt LLC",
--   "intercompany_account_name": "Due to PaperNewt LLC",
--   "payroll_costs_account_path": "0002 TEAM > Payroll Costs"
--
-- RETURNS:
--   A jsonb summary of what was seeded, including:
--     - inserted_count
--     - active_count
--     - inactive_count
--     - payroll_variant_used
--     - recipes (array of {recipe_name, is_active, required_settings})
--
-- IDEMPOTENT:
--   Pre-check on (agency_id, recipe_name) prevents duplicate seeding.
--   Calling twice with the same agency_id returns the existing set unchanged.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.seed_bcc_automations(
    p_agency_id uuid,
    p_config jsonb,
    p_payroll_variant text DEFAULT 'single_entity'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_existing_count integer;
    v_inserted_count integer := 0;
    v_result jsonb;
    v_recipient_email text;
    v_timezone text;
    v_payroll_cash text;
    v_bank_income_code text;
    v_bank_expenses_code text;
    v_primary_card_label text;
    v_primary_card_code text;
    v_secondary_card_label text;
    v_secondary_card_code text;
    v_personal_dists jsonb;
    v_legacy_cards jsonb;
    v_parent_entity text;
    v_intercompany text;
    v_payroll_costs_path text;
    v_close_items jsonb;
    v_balance_items jsonb;
BEGIN
    -- ---- Validate inputs ----------------------------------------------------
    IF p_agency_id IS NULL THEN
        RAISE EXCEPTION 'p_agency_id is required';
    END IF;

    IF p_payroll_variant NOT IN ('single_entity', 'two_entity') THEN
        RAISE EXCEPTION 'p_payroll_variant must be ''single_entity'' or ''two_entity'', got: %', p_payroll_variant;
    END IF;

    -- ---- Idempotency check --------------------------------------------------
    SELECT COUNT(*) INTO v_existing_count
    FROM automation_recipes
    WHERE agency_id = p_agency_id;

    IF v_existing_count > 0 THEN
        RETURN jsonb_build_object(
            'status', 'already_seeded',
            'message', format('Agency %s already has %s recipes — no action taken. Drop them manually if you intend to reseed.', p_agency_id, v_existing_count),
            'existing_count', v_existing_count
        );
    END IF;

    -- ---- Extract config -----------------------------------------------------
    v_recipient_email := p_config->>'recipient_email';
    v_timezone := COALESCE(p_config->>'timezone', 'America/New_York');
    v_payroll_cash := COALESCE(p_config->>'payroll_cash_account_name', 'Operating Cash');
    v_bank_income_code := COALESCE(p_config->>'bank_income_account_code', 'BANK-INCOME');
    v_bank_expenses_code := COALESCE(p_config->>'bank_expenses_account_code', 'BANK-EXPENSES');
    v_primary_card_label := COALESCE(p_config->>'primary_card_label', 'Primary Business Card');
    v_primary_card_code := COALESCE(p_config->>'primary_card_code', 'CARD-PRIMARY');
    v_secondary_card_label := p_config->>'secondary_card_label';
    v_secondary_card_code := p_config->>'secondary_card_code';
    v_personal_dists := COALESCE(p_config->'personal_distribution_accounts', '[]'::jsonb);
    v_legacy_cards := COALESCE(p_config->'legacy_personal_cards', '[]'::jsonb);

    IF p_payroll_variant = 'two_entity' THEN
        v_parent_entity := p_config->>'parent_entity_name';
        v_intercompany := p_config->>'intercompany_account_name';
        v_payroll_costs_path := p_config->>'payroll_costs_account_path';
        IF v_parent_entity IS NULL OR v_intercompany IS NULL OR v_payroll_costs_path IS NULL THEN
            RAISE EXCEPTION 'two_entity variant requires parent_entity_name, intercompany_account_name, and payroll_costs_account_path in config';
        END IF;
    END IF;

    -- ---- Build the monthly close items dynamically --------------------------
    -- Base items always present
    v_close_items := jsonb_build_array(
        jsonb_build_object('doc_label', 'SF Daily Comp Recaps — full month', 'doc_category', 'comp_recap_daily', 'expected_offset_days', 3),
        jsonb_build_object('doc_label', 'Payroll Reports — all runs', 'doc_category', 'payroll', 'expected_offset_days', 3),
        jsonb_build_object('doc_label', 'SF Deduction Statement', 'doc_category', 'deduction_statement', 'expected_offset_days', 5),
        jsonb_build_object('doc_label', 'Producer Production Report (new premium Auto/Fire/Health by producer)', 'doc_category', 'production_report', 'expected_offset_days', 5),
        jsonb_build_object('doc_label', 'Bank — Income/Deposit account statement', 'account_code', v_bank_income_code, 'doc_category', 'bank_statement', 'expected_offset_days', 8),
        jsonb_build_object('doc_label', 'Bank — Expenses account statement', 'account_code', v_bank_expenses_code, 'doc_category', 'bank_statement', 'expected_offset_days', 8),
        jsonb_build_object('doc_label', v_primary_card_label || ' — statement', 'account_code', v_primary_card_code, 'doc_category', 'cc_statement', 'expected_offset_days', 10)
    );

    -- Secondary card optional
    IF v_secondary_card_label IS NOT NULL AND v_secondary_card_code IS NOT NULL THEN
        v_close_items := v_close_items || jsonb_build_array(
            jsonb_build_object('doc_label', v_secondary_card_label || ' — statement', 'account_code', v_secondary_card_code, 'doc_category', 'cc_statement', 'expected_offset_days', 10)
        );
    END IF;

    -- Always-present trailing items
    v_close_items := v_close_items || jsonb_build_array(
        jsonb_build_object('doc_label', 'Reconcile COMP_RECAP to GL before closing', 'doc_category', 'reconciliation', 'expected_offset_days', 10),
        jsonb_build_object('doc_label', 'Review imported transactions — flag uncategorized / suspense items', 'doc_category', 'review', 'expected_offset_days', 10)
    );

    -- Balance-review items: built from the client's actual lists
    v_balance_items := '[]'::jsonb;
    -- Personal distribution accounts
    v_balance_items := v_balance_items || (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'doc_label', 'Confirm balance: ' || (item->>'label') || ' — carry until CPA adjusts',
                'account_code', item->>'code',
                'doc_category', 'balance_review',
                'expected_offset_days', 10
            )
        ), '[]'::jsonb)
        FROM jsonb_array_elements(v_personal_dists) AS item
    );
    -- Legacy personal cards
    v_balance_items := v_balance_items || (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'doc_label', 'Confirm balance: ' || (item->>'label') || ' — carry until CPA adjusts',
                'account_code', item->>'code',
                'doc_category', 'balance_review',
                'expected_offset_days', 10
            )
        ), '[]'::jsonb)
        FROM jsonb_array_elements(v_legacy_cards) AS item
    );

    -- ---- INSERT all recipes -------------------------------------------------

    -- 01: Document Processor (busiest, always active)
    INSERT INTO automation_recipes (agency_id, recipe_name, recipe_description, trigger_type, cron_expression, composio_action, internal_handler, input_config, output_table, output_config, is_active)
    VALUES (p_agency_id, 'Document Processor',
        'Polls Gmail for new attachments twice per hour. Classifies, archives to Drive, routes financial documents through Groq parse and balanced JE pipeline. Front door for all document intake.',
        'cron', '7,37 * * * *', 'INTERNAL', 'dispatch_document_processor',
        '{"poll_window_minutes":30,"route_to_drive":true,"groq_parse_enabled":true,"suspense_on_classify_fail":true}'::jsonb,
        'documents', '{"conflict_keys":["agency_id","source_message_id"],"log_to_run_log":true}'::jsonb, true);
    v_inserted_count := v_inserted_count + 1;

    -- 02: Daily Briefing Email
    INSERT INTO automation_recipes (agency_id, recipe_name, recipe_description, trigger_type, cron_expression, composio_action, composio_connection, internal_handler, input_config, output_table, output_config, is_active)
    VALUES (p_agency_id, 'Daily Briefing Email',
        'Composes a morning HTML briefing from live data each morning. Pulls MTD comp, tasks, alerts, compliance, staff, AIPP, producer production. Inserts a briefings row then sends via Composio Gmail.',
        'cron', '0 12 * * *', 'GMAIL_SEND_EMAIL', 'gmail', 'daily_briefing_composer',
        jsonb_build_object(
            'tz', v_timezone,
            'is_html', true,
            'recipient_email', v_recipient_email,
            'required_settings', jsonb_build_array('composio_gmail_account_id'),
            'sections', jsonb_build_object('greeting', true, 'where_we_are', true, 'todays_priorities', true, 'compliance_upcoming', true, 'what_im_watching', true, 'what_to_ask_me', true)
        ),
        'briefings', '{"conflict_keys":["agency_id","briefing_date"],"insert_before_send":true}'::jsonb, true);
    v_inserted_count := v_inserted_count + 1;

    -- 03: Producer Underperformance Watcher
    INSERT INTO automation_recipes (agency_id, recipe_name, recipe_description, trigger_type, cron_expression, composio_action, internal_handler, input_config, output_table, output_config, is_active)
    VALUES (p_agency_id, 'Producer Underperformance Watcher',
        'Daily check of each producer''s MTD pace vs 3-month rolling average. Fires an alert when a producer is below 70% of expected pace through the current point in the month.',
        'cron', '0 12 * * *', 'INTERNAL', 'producer_underperformance_watcher',
        '{"threshold_pct":70,"rolling_window_months":3,"alert_severity":"warning"}'::jsonb,
        'alerts', '{"conflict_keys":["agency_id","producer_id","alert_date"],"skip_if_alerted_within_days":7}'::jsonb, true);
    v_inserted_count := v_inserted_count + 1;

    -- 04: Email Archiver
    INSERT INTO automation_recipes (agency_id, recipe_name, recipe_description, trigger_type, cron_expression, composio_action, internal_handler, input_config, output_table, output_config, is_active)
    VALUES (p_agency_id, 'Email Archiver',
        'Archives older email and files attachments to Drive by subject/sender rules. Preserves starred. Logs each archived doc with a source link.',
        'cron', '0 13 * * *', 'INTERNAL', 'dispatch_email_archiver',
        '{"preserve_starred":true,"archive_older_than_days":30,"route_attachments_to_drive":true,"drive_folder_template":"BCC/{{year}}/{{month}}/{{category}}"}'::jsonb,
        'documents', '{"conflict_keys":["agency_id","source_message_id"],"log_to_run_log":true}'::jsonb, true);
    v_inserted_count := v_inserted_count + 1;

    -- 05: Payroll GL Writer (variant-dependent)
    IF p_payroll_variant = 'single_entity' THEN
        INSERT INTO automation_recipes (agency_id, recipe_name, recipe_description, trigger_type, cron_expression, composio_action, internal_handler, input_config, output_table, output_config, is_active)
        VALUES (p_agency_id, 'Payroll GL Writer',
            'SINGLE-ENTITY variant. Posts post-cutover payroll_runs to journal_entries: DR Payroll Costs, CR Operating Cash. The agency pays its own payroll out of its own bank account. Pre-cutover archive-only. Idempotent.',
            'cron', '15 16 * * *', 'INTERNAL', 'payroll_gl_writer',
            jsonb_build_object(
                'posting_convention', 'single_entity',
                'credit_account_name', v_payroll_cash,
                'skip_pre_cutover', true,
                'idempotent', true
            ),
            'journal_entries', '{"conflict_keys":["agency_id","source_table","source_id"],"namespace_from_settings":"gl_chart_namespace","cutover_from_settings":"gl_cutover_date"}'::jsonb, true);
    ELSE
        INSERT INTO automation_recipes (agency_id, recipe_name, recipe_description, trigger_type, cron_expression, composio_action, internal_handler, input_config, output_table, output_config, is_active)
        VALUES (p_agency_id, 'Payroll GL Writer',
            'TWO-ENTITY intercompany variant. Posts post-cutover payroll_runs: DR ' || v_payroll_costs_path || ', CR ' || v_intercompany || '. Parent entity ' || v_parent_entity || ' actually pays payroll. Verify with CPA at least annually. Pre-cutover archive-only. Idempotent.',
            'cron', '15 16 * * *', 'INTERNAL', 'payroll_gl_writer',
            jsonb_build_object(
                'posting_convention', 'two_entity_intercompany',
                'debit_account_path', v_payroll_costs_path,
                'credit_account_name', v_intercompany,
                'parent_entity_name', v_parent_entity,
                'skip_pre_cutover', true,
                'idempotent', true,
                'cpa_verification_note', 'Intercompany posting has tax/compliance implications. CPA should validate the convention at least annually.'
            ),
            'journal_entries', '{"conflict_keys":["agency_id","source_table","source_id"],"namespace_from_settings":"gl_chart_namespace","cutover_from_settings":"gl_cutover_date"}'::jsonb, true);
    END IF;
    v_inserted_count := v_inserted_count + 1;

    -- 06: Instagram (inactive)
    INSERT INTO automation_recipes (agency_id, recipe_name, recipe_description, trigger_type, cron_expression, composio_action, internal_handler, input_config, output_table, output_config, is_active)
    VALUES (p_agency_id, 'Social Media Scheduler — Instagram',
        'No IG auto-post API. Creates a high-priority morning task reminding operator to post manually; caption/hashtags already in content_calendar row. Inactive by default.',
        'cron', '30 13 * * *', 'INTERNAL', 'instagram_manual_reminder',
        '{"platform":"instagram","task_priority":"high","task_title_template":"Post to Instagram today: {{post_title}}"}'::jsonb,
        'tasks', '{"marker_field":"awaiting_manual_post","conflict_keys":["agency_id","content_calendar_id","task_date"]}'::jsonb, false);
    v_inserted_count := v_inserted_count + 1;

    -- 07: Monthly Close Monitor
    INSERT INTO automation_recipes (agency_id, recipe_name, recipe_description, trigger_type, cron_expression, composio_action, internal_handler, input_config, output_table, output_config, is_active)
    VALUES (p_agency_id, 'Monthly Close Monitor',
        'Daily check of monthly_close_checklist progress. Mid-month warns on overdue items; end-of-month escalates and rolls the next checklist via the Generator.',
        'cron', '0 14 * * *', 'INTERNAL', 'monthly_close_monitor',
        '{"mid_month_warn_offset_days":2,"end_of_month_escalate":true,"alert_severity_warn":"warning","alert_severity_critical":"critical"}'::jsonb,
        'alerts', '{"conflict_keys":["agency_id","checklist_item_id","alert_date"],"skip_if_alerted_within_days":1}'::jsonb, true);
    v_inserted_count := v_inserted_count + 1;

    -- 08: Facebook (inactive)
    INSERT INTO automation_recipes (agency_id, recipe_name, recipe_description, trigger_type, cron_expression, composio_action, composio_connection, input_config, output_table, output_config, is_active)
    VALUES (p_agency_id, 'Social Media Scheduler — Facebook',
        'Posts approved content_calendar items to FB Page on scheduled date. Updates calendar row with status=posted, posted_at, post_url. Inactive by default.',
        'cron', '0 14 * * *', 'FACEBOOK_POST_TO_PAGE', 'facebook',
        '{"platform_filter":"facebook","status_filter":"scheduled","date_filter":"today","required_settings":["composio_facebook_account_id","facebook_page_id"]}'::jsonb,
        'content_calendar', '{"conflict_keys":["id"],"update_fields":["status","posted_at","post_url"]}'::jsonb, false);
    v_inserted_count := v_inserted_count + 1;

    -- 09: LinkedIn (inactive)
    INSERT INTO automation_recipes (agency_id, recipe_name, recipe_description, trigger_type, cron_expression, composio_action, composio_connection, input_config, output_table, output_config, is_active)
    VALUES (p_agency_id, 'Social Media Scheduler — LinkedIn',
        'Posts approved content_calendar items to LinkedIn on scheduled date. Updates calendar row with status=posted, posted_at, post_url. Inactive by default.',
        'cron', '0 14 * * *', 'LINKEDIN_CREATE_POST', 'linkedin',
        '{"platform_filter":"linkedin","status_filter":"scheduled","date_filter":"today","required_settings":["composio_linkedin_account_id"]}'::jsonb,
        'content_calendar', '{"conflict_keys":["id"],"update_fields":["status","posted_at","post_url"]}'::jsonb, false);
    v_inserted_count := v_inserted_count + 1;

    -- 10: Monthly Close Checklist Generator (the most valuable one — built dynamically)
    INSERT INTO automation_recipes (agency_id, recipe_name, recipe_description, trigger_type, cron_expression, composio_action, internal_handler, input_config, output_table, output_config, is_active)
    VALUES (p_agency_id, 'Monthly Close Checklist Generator',
        'On the 1st of each month, generates the prior month''s close checklist from the standard SF-agent template (account codes substituted per client). Balance-review items carry accounts the CPA has not yet adjusted, with explicit "do not reclassify autonomously" note. Idempotent via skip_if_exists.',
        'cron', '0 14 1 * *', 'INTERNAL', 'monthly_close_generator',
        jsonb_build_object(
            'generate_for', 'previous_month',
            'skip_if_exists', true,
            'items', v_close_items,
            'balance_review_note', 'Carry these accounts on every monthly close until CPA formally adjusts them off the balance sheet (likely to distributions/equity). Do NOT reclassify autonomously. Remove from template once adjusted.',
            'balance_review_items', v_balance_items
        ),
        'monthly_close_checklist', '{"conflict_keys":["agency_id","period_year","period_month","doc_label"],"log_to_run_log":true}'::jsonb, true);
    v_inserted_count := v_inserted_count + 1;

    -- 11: GL Entry Writer (the base)
    INSERT INTO automation_recipes (agency_id, recipe_name, recipe_description, trigger_type, cron_expression, composio_action, internal_handler, input_config, output_table, output_config, is_active)
    VALUES (p_agency_id, 'GL Entry Writer',
        'Daily cash-basis reconciliation writer. Walks unposted comp_recap rows, creates journal_entries + journal_lines. FIRST in the daily GL chain at 16:00. Without this firing, P&L stays at $0. Pre-cutover archive-only. Idempotent.',
        'cron', '0 16 * * *', 'INTERNAL', 'gl_entry_writer',
        '{"source_table":"comp_recap","skip_pre_cutover":true,"idempotent":true,"config_source":"settings"}'::jsonb,
        'journal_entries', '{"conflict_keys":["agency_id","source_table","source_id"],"namespace_from_settings":"gl_chart_namespace","cutover_from_settings":"gl_cutover_date","default_cash_from_settings":"gl_default_cash_account_name","default_revenue_from_settings":"gl_default_sf_revenue_account_name"}'::jsonb, true);
    v_inserted_count := v_inserted_count + 1;

    -- 12: Bank GL Writer
    INSERT INTO automation_recipes (agency_id, recipe_name, recipe_description, trigger_type, cron_expression, composio_action, internal_handler, input_config, output_table, output_config, is_active)
    VALUES (p_agency_id, 'Bank GL Writer',
        'Posts post-cutover bank_transactions to journal_entries. Third in GL chain at 16:30. Resolution waterfall: category → split label → classification rules → suspense. Never fails to post. Idempotent.',
        'cron', '30 16 * * *', 'INTERNAL', 'bank_gl_writer',
        '{"source_table":"bank_transactions","resolution_waterfall":["category_match","split_label_match","classification_rules","suspense_account"],"skip_pre_cutover":true,"idempotent":true,"never_fail_to_post":true}'::jsonb,
        'journal_entries', '{"conflict_keys":["agency_id","source_table","source_id"],"namespace_from_settings":"gl_chart_namespace","cutover_from_settings":"gl_cutover_date"}'::jsonb, true);
    v_inserted_count := v_inserted_count + 1;

    -- 13: Credit Card GL Writer
    INSERT INTO automation_recipes (agency_id, recipe_name, recipe_description, trigger_type, cron_expression, composio_action, internal_handler, input_config, output_table, output_config, is_active)
    VALUES (p_agency_id, 'Credit Card GL Writer',
        'Posts post-cutover credit_transactions to journal_entries. Last in GL chain at 16:45. Charges DR expense / CR card; payments DR card / CR paying side. Charge resolution: category → rules → suspense. Never fails to post.',
        'cron', '45 16 * * *', 'INTERNAL', 'cc_gl_writer',
        '{"source_table":"credit_transactions","charge_resolution_waterfall":["category_match","classification_rules","suspense_account"],"skip_pre_cutover":true,"idempotent":true,"never_fail_to_post":true}'::jsonb,
        'journal_entries', '{"conflict_keys":["agency_id","source_table","source_id"],"namespace_from_settings":"gl_chart_namespace","cutover_from_settings":"gl_cutover_date"}'::jsonb, true);
    v_inserted_count := v_inserted_count + 1;

    -- ---- Build result summary -----------------------------------------------
    SELECT jsonb_build_object(
        'status', 'seeded',
        'agency_id', p_agency_id,
        'inserted_count', v_inserted_count,
        'active_count', (SELECT COUNT(*) FROM automation_recipes WHERE agency_id = p_agency_id AND is_active = true),
        'inactive_count', (SELECT COUNT(*) FROM automation_recipes WHERE agency_id = p_agency_id AND is_active = false),
        'payroll_variant_used', p_payroll_variant,
        'recipes', (
            SELECT jsonb_agg(jsonb_build_object(
                'recipe_name', recipe_name,
                'is_active', is_active,
                'required_settings', COALESCE(input_config->'required_settings', '[]'::jsonb)
            ) ORDER BY recipe_name)
            FROM automation_recipes
            WHERE agency_id = p_agency_id
        )
    ) INTO v_result;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.seed_bcc_automations(uuid, jsonb, text) IS
'Seeds the canonical 14-recipe BCC automation suite for a new client agency. Idempotent — calling twice for the same agency returns existing state unchanged. See docs/AUTOMATION_RECIPES_BLUEPRINT.md for the full recipe set and config keys.';
