-- =========================================================================
-- Migration: seed_canonical_composio_parsers
-- Supabase version: 20260615224759
-- Captured from production DB: 2026-06-17
-- =========================================================================

-- Seed the 6 canonical Composio-driven parser recipes per docs/AUTOMATIONS_INSTALL.md
-- All cron expressions in UTC (Postgres timezone). CDT = UTC-5.

-- 1. SF Daily Comp Processor (10:00 AM CDT daily = 15:00 UTC)
INSERT INTO automation_recipes (
  agency_id, recipe_name, recipe_description,
  trigger_type, cron_expression,
  composio_action, composio_connection,
  groq_prompt, input_config, output_table, output_config,
  is_active
) VALUES (
  (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1),
  'SF Daily Comp Processor',
  'Pulls State Farm daily comp emails, parses individual line items via Groq (via Composio LLM), writes to comp_recap.',
  'cron', '0 15 * * *',
  'GMAIL_FETCH_EMAILS', 'gmail',
  'You are parsing a State Farm daily compensation notice for Sunshine State Insurance. Extract every line item with: period_year, period_month, comp_type (new_business, renewal, scoreboard, aipp, other), comp_category (auto, home, life, health, fs, umbrella), amount, is_aipp_eligible, is_scoreboard_eligible, description. Return one JSON object per line item.',
  jsonb_build_object(
    'gmail_query', 'from:no-reply@statefarm.com subject:"daily comp" newer_than:2d',
    'attachment_required', false
  ),
  'comp_recap',
  jsonb_build_object(
    'unique_on', ARRAY['agency_id','period_year','period_month','comp_type','comp_category','description'],
    'on_conflict', 'update'
  ),
  true
);

-- 2. Deduction Statement Processor (every 6 hours)
INSERT INTO automation_recipes (
  agency_id, recipe_name, recipe_description,
  trigger_type, cron_expression,
  composio_action, composio_connection,
  groq_prompt, input_config, output_table, output_config,
  is_active
) VALUES (
  (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1),
  'Deduction Statement Processor',
  'Parses State Farm deduction statements, writes deductions (negative amounts) to comp_recap; GL Entry Writer picks them up for journal_entries downstream.',
  'cron', '0 */6 * * *',
  'GMAIL_FETCH_EMAILS', 'gmail',
  'You are parsing a State Farm deduction statement for Sunshine State Insurance. Extract each deduction line item with: period_year, period_month, comp_type=''deduction'', comp_category (e&o, marketing_fund, technology_fee, scoreboard_clawback, other), amount (always NEGATIVE), description. Return one JSON object per line item.',
  jsonb_build_object(
    'gmail_query', 'from:no-reply@statefarm.com subject:deduction newer_than:7d',
    'attachment_required', false
  ),
  'comp_recap',
  jsonb_build_object(
    'unique_on', ARRAY['agency_id','period_year','period_month','comp_type','comp_category','description'],
    'on_conflict', 'update'
  ),
  true
);

-- 3. Bank Statement Processor (every 6 hours)
INSERT INTO automation_recipes (
  agency_id, recipe_name, recipe_description,
  trigger_type, cron_expression,
  composio_action, composio_connection,
  groq_prompt, input_config, output_table, output_config,
  is_active
) VALUES (
  (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1),
  'Bank Statement Processor',
  'Parses bank statement / transaction notification emails and posts to journal_entries. Dedups via reference_number.',
  'cron', '0 */6 * * *',
  'GMAIL_FETCH_EMAILS', 'gmail',
  'You are parsing a bank statement or transaction notification for Sunshine State Insurance. For each transaction extract: transaction_date, description, amount (positive=deposit, negative=withdrawal), reference_number (check #, ACH ID, or bank transaction ID), suggested_account (match against chart_of_accounts by description). Return one JSON object per transaction.',
  jsonb_build_object(
    'gmail_query', '(from:alerts@bank OR from:notifications@bank OR subject:"statement available" OR subject:"transaction alert") newer_than:7d',
    'attachment_required', false
  ),
  'journal_entries',
  jsonb_build_object(
    'unique_on', ARRAY['agency_id','reference_number'],
    'on_conflict', 'skip'
  ),
  true
);

-- 4. Credit Card Statement Processor (every 6 hours)
INSERT INTO automation_recipes (
  agency_id, recipe_name, recipe_description,
  trigger_type, cron_expression,
  composio_action, composio_connection,
  groq_prompt, input_config, output_table, output_config,
  is_active
) VALUES (
  (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1),
  'Credit Card Statement Processor',
  'Parses credit card statement and transaction notification emails, writes to credit_transactions. Pairs with Bank Statement Processor for full cash-basis reconciliation.',
  'cron', '0 */6 * * *',
  'GMAIL_FETCH_EMAILS', 'gmail',
  'You are parsing a credit card statement or transaction notification for Sunshine State Insurance. For each transaction extract: transaction_date, merchant, amount, category (advertising, office_supplies, technology, meals, travel, fuel, dues_subscriptions, other), card_last_four, reference_number. Return one JSON object per transaction.',
  jsonb_build_object(
    'gmail_query', '(subject:"credit card" OR subject:"card statement" OR subject:"transaction alert") newer_than:7d',
    'attachment_required', false
  ),
  'credit_transactions',
  jsonb_build_object(
    'unique_on', ARRAY['agency_id','reference_number'],
    'on_conflict', 'skip'
  ),
  true
);

-- 5. Payroll Processor (every 6 hours)
INSERT INTO automation_recipes (
  agency_id, recipe_name, recipe_description,
  trigger_type, cron_expression,
  composio_action, composio_connection,
  groq_prompt, input_config, output_table, output_config,
  is_active
) VALUES (
  (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1),
  'Payroll Processor',
  'Parses payroll provider notifications (Gusto, ADP, Paychex) and writes payroll_runs plus payroll_detail per-employee rows.',
  'cron', '0 */6 * * *',
  'GMAIL_FETCH_EMAILS', 'gmail',
  'You are parsing a payroll provider notification (Gusto, ADP, or Paychex) for Sunshine State Insurance. Extract the payroll run with: pay_period_start, pay_period_end, pay_date, gross_total, taxes_total, net_total. Then for each employee return: employee_name (match staff table case-insensitive), gross, federal_tax, state_tax, fica, medicare, other_deductions, net. Return ONE JSON object with run summary and an employees array.',
  jsonb_build_object(
    'gmail_query', '(from:noreply@gusto.com OR from:notifications@adp.com OR from:noreply@paychex.com OR subject:"payroll run") newer_than:7d',
    'attachment_required', false
  ),
  'payroll_runs',
  jsonb_build_object(
    'detail_table', 'payroll_detail',
    'unique_on', ARRAY['agency_id','pay_date','pay_period_start','pay_period_end'],
    'on_conflict', 'update'
  ),
  true
);

-- 6. Producer Production Report Processor (monthly, 1st @ 9 UTC = 4 AM CDT)
INSERT INTO automation_recipes (
  agency_id, recipe_name, recipe_description,
  trigger_type, cron_expression,
  composio_action, composio_connection,
  groq_prompt, input_config, output_table, output_config,
  is_active
) VALUES (
  (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1),
  'Producer Production Report Processor',
  'Monthly: parses producer monthly production reports forwarded by the agent, extracts issued premium per producer per line of business via Groq, writes to producer_production. Feeds the HR & People -> Performance tab ROI projection.',
  'cron', '0 9 1 * *',
  'GMAIL_FETCH_EMAILS', 'gmail',
  'You are parsing a State Farm producer production report for Sunshine State Insurance. The report lists each producer (LSP) by name with policies issued and premium issued in the prior month, broken out by line of business (auto, fire/home, life, health, financial services). Extract one row per producer per LOB with: producer_first_name, producer_last_name, period_year, period_month, line_of_business, policies_issued, premium_issued. Match producer names to the staff table by first_name+last_name (case-insensitive).',
  jsonb_build_object(
    'gmail_query', 'subject:"producer production" newer_than:7d',
    'attachment_required', true,
    'expected_format', 'pdf or xlsx'
  ),
  'producer_production',
  jsonb_build_object(
    'unique_on', ARRAY['agency_id','staff_id','period_year','period_month','line_of_business'],
    'on_conflict', 'update'
  ),
  true
);
