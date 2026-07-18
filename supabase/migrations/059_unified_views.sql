-- =========================================================================
-- Migration: 019_unified_views
-- Supabase version: 20260617023801
-- Captured from production DB: 2026-06-17
-- =========================================================================

DROP VIEW IF EXISTS public.v_income_statement;

CREATE VIEW public.v_income_statement AS
SELECT
  je.agency_id,
  EXTRACT(year  FROM je.entry_date)::integer AS period_year,
  EXTRACT(month FROM je.entry_date)::integer AS period_month,
  EXTRACT(year  FROM je.entry_date)::integer AS year,
  EXTRACT(month FROM je.entry_date)::integer AS month,
  to_char(je.entry_date::timestamptz, 'YYYY-MM')           AS period,
  date_trunc('month', je.entry_date::timestamptz)::date    AS period_date,
  coa.id                AS account_id,
  coa.account_code,
  coa.account_name,
  coa.account_type,
  coa.account_subtype,
  SUM(jl.debit)         AS total_debit,
  SUM(jl.credit)        AS total_credit,
  CASE
    WHEN coa.account_type = 'income'  THEN SUM(jl.credit) - SUM(jl.debit)
    WHEN coa.account_type = 'expense' THEN SUM(jl.debit)  - SUM(jl.credit)
    ELSE 0::numeric
  END                   AS amount
FROM public.journal_lines    jl
JOIN public.journal_entries  je  ON je.id = jl.journal_entry_id
JOIN public.chart_of_accounts coa ON coa.id = jl.account_id
WHERE coa.account_type IN ('income','expense')
GROUP BY
  je.agency_id, je.entry_date,
  coa.id, coa.account_code, coa.account_name,
  coa.account_type, coa.account_subtype

UNION ALL

SELECT
  qjl.agency_id,
  EXTRACT(year  FROM qjl.txn_date)::integer AS period_year,
  EXTRACT(month FROM qjl.txn_date)::integer AS period_month,
  EXTRACT(year  FROM qjl.txn_date)::integer AS year,
  EXTRACT(month FROM qjl.txn_date)::integer AS month,
  to_char(qjl.txn_date::timestamptz, 'YYYY-MM')          AS period,
  date_trunc('month', qjl.txn_date::timestamptz)::date   AS period_date,
  qa.id                 AS account_id,
  qa.acct_num           AS account_code,
  qjl.qbo_account_name  AS account_name,
  CASE qa.classification
    WHEN 'Revenue' THEN 'income'
    WHEN 'Expense' THEN 'expense'
  END                   AS account_type,
  qa.account_type       AS account_subtype,
  SUM(qjl.debit)        AS total_debit,
  SUM(qjl.credit)       AS total_credit,
  CASE qa.classification
    WHEN 'Revenue' THEN SUM(qjl.credit) - SUM(qjl.debit)
    WHEN 'Expense' THEN SUM(qjl.debit)  - SUM(qjl.credit)
  END                   AS amount
FROM public.qbo_journal_lines qjl
JOIN public.qbo_accounts      qa
  ON qa.qbo_id     = qjl.qbo_account_id
 AND qa.agency_id  = qjl.agency_id
WHERE qa.classification IN ('Revenue','Expense')
GROUP BY
  qjl.agency_id, qjl.txn_date,
  qa.id, qa.acct_num, qjl.qbo_account_name,
  qa.classification, qa.account_type;


DROP VIEW IF EXISTS public.v_balance_sheet;

CREATE VIEW public.v_balance_sheet AS
SELECT
  jl.agency_id,
  coa.id                AS account_id,
  coa.account_code,
  coa.account_name,
  coa.account_type,
  coa.account_subtype,
  SUM(jl.debit)         AS total_debit,
  SUM(jl.credit)        AS total_credit,
  CASE
    WHEN coa.account_type = 'asset'                 THEN SUM(jl.debit)  - SUM(jl.credit)
    WHEN coa.account_type IN ('liability','equity') THEN SUM(jl.credit) - SUM(jl.debit)
    ELSE 0::numeric
  END                   AS balance,
  MAX(je.entry_date)    AS last_activity_date
FROM public.journal_lines     jl
JOIN public.journal_entries   je  ON je.id = jl.journal_entry_id
JOIN public.chart_of_accounts coa ON coa.id = jl.account_id
WHERE coa.account_type IN ('asset','liability','equity')
GROUP BY jl.agency_id, coa.id, coa.account_code, coa.account_name,
         coa.account_type, coa.account_subtype

UNION ALL

SELECT
  qjl.agency_id,
  qa.id                 AS account_id,
  qa.acct_num           AS account_code,
  qjl.qbo_account_name  AS account_name,
  LOWER(qa.classification) AS account_type,
  qa.account_type       AS account_subtype,
  SUM(qjl.debit)        AS total_debit,
  SUM(qjl.credit)       AS total_credit,
  CASE qa.classification
    WHEN 'Asset'     THEN SUM(qjl.debit)  - SUM(qjl.credit)
    WHEN 'Liability' THEN SUM(qjl.credit) - SUM(qjl.debit)
    WHEN 'Equity'    THEN SUM(qjl.credit) - SUM(qjl.debit)
  END                   AS balance,
  MAX(qjl.txn_date)     AS last_activity_date
FROM public.qbo_journal_lines qjl
JOIN public.qbo_accounts      qa
  ON qa.qbo_id     = qjl.qbo_account_id
 AND qa.agency_id  = qjl.agency_id
WHERE qa.classification IN ('Asset','Liability','Equity')
GROUP BY qjl.agency_id, qa.id, qa.acct_num, qjl.qbo_account_name,
         qa.classification, qa.account_type;