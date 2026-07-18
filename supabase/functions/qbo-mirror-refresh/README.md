# qbo-mirror-refresh Edge Function — Deployment Notes

## Deployment Status

**Deployed:** 2026-06-19  
**Function ID:** `80d6ce9a-3e12-4e0c-abcb-206a21adb04c` (v1 ACTIVE)  
**URL:** `https://brozvvsawwpxitvvkfou.supabase.co/functions/v1/qbo-mirror-refresh`  
**Auth:** `verify_jwt=false`  
**Cron Schedule:** Not yet scheduled — pending unblock.

## What it does

Refreshes `qbo_accounts`, `qbo_snapshots(profit_loss)`, and `qbo_snapshots(balance_sheet)` from Composio QuickBooks tools. Replaces the manual `proxy_execute` workflow used during initial backfill. Designed to ship before the 2026-07-01 GL cutover so dual-write reconciliation works:

- **Pre-cutover:** BCC GL empty, QBO mirror = source of truth for P&L/BS.
- **Post-cutover:** BCC GL takes new transactions, mirror keeps refreshing in parallel. A reconciliation script (separate, not yet built) compares the two.

## Known blocker — Composio tool allowlist

First invocation on 2026-06-19 returned 500. Three distinct failures diagnosed:

| Call                                       | Error                                | Root cause                       |
|--------------------------------------------|--------------------------------------|----------------------------------|
| `QUICKBOOKS_QUERY_ACCOUNT`                 | 400 `ConnectedAccountNotFound`       | Stale `composio_qbo_account_id`  |
| `QUICKBOOKS_GET_PROFIT_AND_LOSS_REPORT`    | 404 `Tool_ToolNotFound`              | Not in project allowlist         |
| `QUICKBOOKS_GET_BALANCE_SHEET_REPORT`      | 404 `Tool_ToolNotFound`              | Not in project allowlist         |

Confirmed via direct probes that the agency's API key under project `pr_eisOqf59Gdua` has zero QBO tools registered in its catalog and only `QUICKBOOKS_QUERY_ACCOUNT` succeeds on execute. The same tool slugs called under other Composio entities work — confirming the tools exist on Composio but are gated per-project-API-key.

## Unblock steps (the agent / Rebecca action)

1. **Refresh `composio_qbo_account_id` in `settings`** — current value `ca_5l3T3vAj21Sh` was deleted/rotated. New `ca_xxx` should be the agency's active QBO connection under entity `pg-test-2620b3e3-0702-4ae2-9c72-5db89af91ba3`.
2. **Enable QBO report tools** in the project allowlist at the Composio dashboard:
   - `QUICKBOOKS_GET_PROFIT_AND_LOSS_REPORT` (required)
   - `QUICKBOOKS_GET_BALANCE_SHEET_REPORT` (required)
   - `QUICKBOOKS_GET_REPORT_CASH_FLOW` (recommended for future v2)
   - `QUICKBOOKS_GET_GENERAL_LEDGER_REPORT` (recommended for v2 GL refresh)

Once both unblocks are in place, re-fire via:

```sql
SELECT net.http_post(
  url := 'https://brozvvsawwpxitvvkfou.supabase.co/functions/v1/qbo-mirror-refresh',
  headers := jsonb_build_object('Content-Type','application/json'),
  body := '{}'::jsonb,
  timeout_milliseconds := 120000
);
```

Once verified green, schedule via `cron.schedule` for daily off-peak refresh.

## Interim manual refresh (2026-06-19)

Because the cutover is 12 days away, snapshots were manually refreshed using this MCP session's working QBO connection. State of mirror as of 2026-06-19:

- **qbo_accounts:** 140 rows refreshed
- **qbo_snapshots (profit_loss):** 6 monthly rows for Jan–Jun 2026
- **qbo_snapshots (balance_sheet):** 6 monthly rows for Jan–Jun 2026
- **June 2026 P&L** (partial through 6/19): Income $0 (no SF comp deposits hit yet), Expenses $9,219.82, NetIncome -$9,219.82
- **June 2026 BS** (as of 6/19): TotalAssets $109,555.50, TotalLiabilities $23,926.95, Equity $85,628.55

All values reconcile to the existing snapshots through May 2026.

## v2 backlog

- Add `QUICKBOOKS_GET_GENERAL_LEDGER_REPORT` integration for incremental qbo_journal_lines refresh
- Add multi-agency support (currently hardcoded `DEFAULT_AGENCY_ID`)
- Add `Accrual` basis option for tax-prep snapshots alongside the existing `Cash` basis
