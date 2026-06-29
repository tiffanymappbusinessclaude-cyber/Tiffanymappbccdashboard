-- Migration 020 — GL Entry Writer accrual conversion: DEFERRED
-- Date: 2026-06-29
-- Sprint item 9 — reframed after diagnostic.
--
-- DIAGNOSTIC FINDING (2026-06-29):
-- The intended scope (refactor write_comp_recap_gl_entries to accrual basis
-- so BCC GL matches CPA P&L by construction) cannot be completed today
-- because the source data does not reconcile under any time-shift model:
--   • CPA SF Commission Income 2025: $682,207 (per refined extraction
--     that avoids double-counting flat "Commission Income" + subtotal
--     "Total for Commission Income" rows)
--   • BCC comp_recap net_payable 2025: $583,181
--   • BCC comp_recap line items only 2025: $629,035
--   • Tested shifts 0/+1/+2 months: variance pattern is stable on the
--     net_payable comparison (~$5-10k/month) but the residual is not
--     a time shift; it tracks deductions and likely missing categories.
--
-- ROOT CAUSE: comp_recap PDFs do not capture all SF compensation.
-- AIPP (annual incentive), ScoreBoard, Life production bonuses, and
-- possibly other 1099-MISC items flow into CPA Commission Income via
-- source paths outside the bi-monthly comp_recap.
--
-- DECISION: keep cash-basis writer. Add reconciliation visibility now.
-- Open question added to CPA bundle email (task d5509d37):
--   "What sources besides comp_recap PDFs feed Commission Income —
--    AIPP, ScoreBoard, Life bonuses, other SF payments not on the
--    bi-monthly recap?"
-- Accrual refactor (the true Item 9) resumes once CPA answers.
--
-- This migration is intentionally non-destructive:
--   1) Documents the deferral via COMMENT on the function
--   2) Creates vw_bcc_vs_cpa_commission_variance for ongoing monitoring

-- 1) Document the deferral on the function itself
COMMENT ON FUNCTION public.write_comp_recap_gl_entries(uuid) IS
'CASH-BASIS GL ENTRY WRITER. Posts comp_recap rows as DR Cash / CR Revenue
dated on the last day of the comp_recap period month (SF payment period).

ACCRUAL CONVERSION DEFERRED 2026-06-29 pending CPA clarification.
See migration 020 header for diagnostic. Tracked as sprint Item 9.';

-- 2) Reconciliation view: BCC comp_recap vs CPA P&L Commission Income (SF-only)
DROP VIEW IF EXISTS public.vw_bcc_vs_cpa_commission_variance;

CREATE VIEW public.vw_bcc_vs_cpa_commission_variance AS
WITH cpa_sf AS (
  SELECT
    agency_id,
    period_year,
    period_month,
    -- Prefer "Total for Commission Income" subtotal (newer P&L format);
    -- fall back to flat "Commission Income" line (older format). Picking
    -- one or the other avoids double-counting the same money.
    COALESCE(
      MAX(amount) FILTER (
        WHERE account_name = 'Total for Commission Income'
          AND parent_account = 'Commission Income'),
      MAX(amount) FILTER (
        WHERE account_name = 'Commission Income'
          AND parent_account IS NULL)
    ) AS cpa_commission_total,
    COALESCE(
      MAX(amount) FILTER (
        WHERE account_name = 'Non State Farm'
          AND parent_account = 'Commission Income'),
      MAX(amount) FILTER (
        WHERE account_name = 'Non State Farm'
          AND parent_account IS NULL),
      0
    ) AS cpa_non_sf
  FROM cpa_pnl_monthly
  WHERE period_month BETWEEN 1 AND 12
  GROUP BY agency_id, period_year, period_month
),
cr_monthly AS (
  SELECT
    agency_id,
    period_year,
    period_month,
    SUM(amount) FILTER (WHERE comp_type = 'net_payable')     AS bcc_net_payable,
    SUM(amount) FILTER (WHERE comp_type <> 'net_payable')    AS bcc_line_items_only
  FROM comp_recap
  GROUP BY agency_id, period_year, period_month
)
SELECT
  COALESCE(cpa.agency_id, cr.agency_id)                  AS agency_id,
  COALESCE(cpa.period_year, cr.period_year)              AS period_year,
  COALESCE(cpa.period_month, cr.period_month)            AS period_month,
  cpa.cpa_commission_total                               AS cpa_commission_total,
  cpa.cpa_non_sf                                         AS cpa_non_sf,
  (cpa.cpa_commission_total - cpa.cpa_non_sf)            AS cpa_sf_earned,
  cr.bcc_net_payable                                     AS bcc_net_payable,
  cr.bcc_line_items_only                                 AS bcc_line_items_only,
  -- Primary variance: BCC net_payable vs CPA SF earned. Net_payable is
  -- the actual deposited amount; the residual is typically deductions
  -- that CPA records as expense rather than netting from revenue.
  (cr.bcc_net_payable - (cpa.cpa_commission_total - cpa.cpa_non_sf)) AS variance_netpay_minus_cpa,
  CASE
    WHEN (cpa.cpa_commission_total - cpa.cpa_non_sf) IS NULL
      OR (cpa.cpa_commission_total - cpa.cpa_non_sf) = 0 THEN NULL
    ELSE ROUND(
      100.0 * (cr.bcc_net_payable - (cpa.cpa_commission_total - cpa.cpa_non_sf))
            / (cpa.cpa_commission_total - cpa.cpa_non_sf),
      2)
  END AS variance_netpay_pct
FROM cpa_sf cpa
FULL OUTER JOIN cr_monthly cr
  ON cpa.agency_id   = cr.agency_id
 AND cpa.period_year = cr.period_year
 AND cpa.period_month = cr.period_month
WHERE COALESCE(cpa.period_year, cr.period_year) IS NOT NULL;

COMMENT ON VIEW public.vw_bcc_vs_cpa_commission_variance IS
'Monthly reconciliation: BCC comp_recap vs CPA P&L Commission Income (SF-only).
Created 2026-06-29 in migration 020 to flag BCC vs CPA variance pending
the accrual-conversion refactor (sprint Item 9).

Comparison: BCC net_payable (what SF deposited) vs CPA SF-earned
(Commission Income subtotal minus Non State Farm). Residual is typically
(a) deductions CPA expenses rather than netting from revenue, (b) basis
shift (CPA accrues earned; SF pays 30-60 days later), or (c) AIPP/
ScoreBoard/bonuses missing from comp_recap PDFs. Open CPA question covers (c).';

GRANT SELECT ON public.vw_bcc_vs_cpa_commission_variance TO anon, authenticated;
