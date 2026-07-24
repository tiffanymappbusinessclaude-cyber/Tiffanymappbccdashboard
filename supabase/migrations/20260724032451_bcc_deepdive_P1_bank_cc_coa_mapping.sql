-- bcc-deepdive/P1 — 2026-07-24T04:32Z
-- Finding F1: 281 bank+CC transactions (121 bank + 160 CC) stuck at unpostable
-- because chart_of_accounts_id is NULL on all 3 bank_accounts and 4 credit_accounts.
-- Fix: (a) add 4 per-CC CoA rows to match Julie Braley's CPA balance sheet layout,
-- (b) UPDATE all 7 accounts to point to their CoA row.
-- Rerun bank_gl_writer + cc_gl_writer done in follow-up execute_sql (not in migration).
-- Rollback: DELETE the 4 new CoA rows + UPDATE all 7 accounts SET chart_of_accounts_id=NULL.

-- Assumptions checked against cpa_balance_sheet 2026-06-30 (source_document_id 9a3721e7):
--   Julie's CoA books each of the 4 CCs as its own liability line.
--   Names below match her account_name literals verbatim.

-- ==========================================================
-- (a) Insert 4 per-CC CoA rows
-- ==========================================================
INSERT INTO public.chart_of_accounts (agency_id, account_code, account_name, account_type, account_subtype)
VALUES
  ('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065', '2042', 'AmEx Business Platinum Card 92005', 'liability', 'credit_card'),
  ('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065', '2043', 'BOA Biz Credit Card 3076',          'liability', 'credit_card'),
  ('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065', '2044', 'US BANK BIZ CC 2535',                'liability', 'credit_card'),
  ('ed4b4f81-4ec1-4676-9dea-2a9c98e4a065', '2045', 'Spark Capital One Card',             'liability', 'credit_card')
ON CONFLICT (agency_id, account_code) DO NOTHING;

-- ==========================================================
-- (b) Map bank_accounts (3) to CoA
-- ==========================================================
UPDATE public.bank_accounts ba
SET chart_of_accounts_id = coa.id
FROM public.chart_of_accounts coa
WHERE ba.agency_id = 'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
  AND coa.agency_id = 'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
  AND ba.chart_of_accounts_id IS NULL
  AND (
    (ba.account_number_last4 = '9207' AND coa.account_code = '1010') OR
    (ba.account_number_last4 = '9223' AND coa.account_code = '1012') OR
    (ba.account_name = 'SouthState PFA Checking' AND coa.account_code = '1011')
  );

-- ==========================================================
-- (c) Map credit_accounts (4) to new per-CC CoA rows
-- ==========================================================
UPDATE public.credit_accounts ca
SET chart_of_accounts_id = coa.id
FROM public.chart_of_accounts coa
WHERE ca.agency_id = 'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
  AND coa.agency_id = 'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
  AND ca.chart_of_accounts_id IS NULL
  AND (
    (ca.account_number_last4 = '92005' AND coa.account_code = '2042') OR
    (ca.account_number_last4 = '3076'  AND coa.account_code = '2043') OR
    (ca.account_number_last4 = '2535'  AND coa.account_code = '2044') OR
    (ca.account_number_last4 = '4055'  AND coa.account_code = '2045')
  );

COMMENT ON COLUMN public.bank_accounts.chart_of_accounts_id IS
  'CoA linkage set 2026-07-24T04:32Z per deep-dive audit P1. Bank 9207->1010, 9223->1012, PFA->1011.';
COMMENT ON COLUMN public.credit_accounts.chart_of_accounts_id IS
  'CoA linkage set 2026-07-24T04:32Z per deep-dive audit P1. AmEx->2042, BOA->2043, US Bank->2044, Spark->2045. Matches CPA 2026-06-30 balance sheet layout.';
