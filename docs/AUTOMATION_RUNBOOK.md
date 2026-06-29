# AUTOMATION_RUNBOOK.md

Operational runbook for every automation in the Tiffany Mapp BCC. One section per recipe. When something behaves badly at 3 AM, find the recipe below, run the verify query, and follow the failure-mode table.

**Repo:** https://github.com/tiffanymappbusinessclaude-cyber/Tiffanymappbccdashboard
**Supabase project:** `aerutjqyjlbzrklgpwzv`
**Webapp:** https://tiffanymappbccdashboard.vercel.app
**Agency ID:** `ed4b4f81-4ec1-4676-9dea-2a9c98e4a065`

---

## How the automation system is wired

Three architectural patterns, all driven by a single pg_cron tick.

**1. pg_cron tick** — One Postgres job, `automation-runner-tick`, schedule `* * * * *` (every minute). It calls `public.run_due_automation_recipes()`, which scans `automation_recipes` for active rows whose `cron_expression` matches the current UTC minute and dispatches each match.

**2. Dispatch by `composio_action`** — Three flavors:

| `composio_action` value | What it does | Code lives in |
|---|---|---|
| `INTERNAL` | Calls `public.run_internal_recipe(recipe_id)` which `EXECUTE`s `public.<internal_handler>(agency_id, recipe_id)` returning jsonb | Postgres plpgsql functions |
| `EDGE_FUNCTION:<slug>` | POSTs to `https://aerutjqyjlbzrklgpwzv.supabase.co/functions/v1/<slug>` with `Authorization: Bearer <service_role>` + `shared_secret` in body | `supabase/functions/<slug>/index.ts` |
| `<COMPOSIO_TOOL_SLUG>` (e.g. `GMAIL_SEND_EMAIL`) | Calls Composio Tools API; runner resolves Composio creds from `settings` by `composio_connection` value | The `automation-runner` Edge Function |

**Hybrid pattern:** If a recipe has BOTH `internal_handler` AND a Composio `composio_action`, the runner calls `run_internal_recipe` FIRST (to compose data, write side-effect rows) THEN calls the Composio tool with the result. Daily Briefing Email is the canonical example.

**3. Logging** — Every dispatch writes one row to `automation_run_log` with `status`, `records_processed`, `error_message`, `duration_seconds`, `output_summary`. The recipe row's `last_run_at` and `last_run_status` are also stamped.

**Edge functions self-log** — When the runner dispatches via `EDGE_FUNCTION:<slug>`, the edge function itself writes the `automation_run_log` row. The runner does NOT double-log; it just dispatches and updates `automation_recipes.last_run_status`.

**Failure routing** — On any failure path, `automation_run_log.status='failed'` is written with the error in `error_message`. If `telegram_bot_token` + `telegram_chat_id` exist in settings, a Telegram alert fires (currently not configured for this agency — failures land in run_log only).

---

## Common diagnostic queries

Copy-paste these straight into Supabase SQL editor. Replace the recipe name in the WHERE clause.

**Recent runs for one recipe**

```sql
SELECT created_at AT TIME ZONE 'America/New_York' AS happened_et,
       status, records_processed, duration_seconds,
       LEFT(output_summary, 100) AS summary,
       LEFT(error_message, 200) AS error
FROM automation_run_log arl
JOIN automation_recipes r ON r.id = arl.recipe_id
WHERE r.recipe_name = 'GL Entry Writer'
  AND arl.agency_id = 'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
ORDER BY arl.created_at DESC LIMIT 20;
```

**Health snapshot — all recipes, last 24h**

```sql
SELECT r.recipe_name,
       r.is_active,
       r.last_run_status,
       r.last_run_at AT TIME ZONE 'America/New_York' AS last_run_et,
       COUNT(*) FILTER (WHERE arl.status='success') AS ok_24h,
       COUNT(*) FILTER (WHERE arl.status='failed') AS fail_24h
FROM automation_recipes r
LEFT JOIN automation_run_log arl
  ON arl.recipe_id = r.id AND arl.created_at > NOW() - INTERVAL '24 hours'
WHERE r.agency_id = 'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
GROUP BY r.recipe_name, r.is_active, r.last_run_status, r.last_run_at
ORDER BY r.is_active DESC, fail_24h DESC, r.recipe_name;
```

**Find a recipe id by name** (for manual rerun via INTERNAL handler)

```sql
SELECT id, recipe_name, composio_action, internal_handler, is_active
FROM automation_recipes
WHERE agency_id = 'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
  AND recipe_name = 'Goals Auto-Sync';
```

**Confirm pg_cron is still ticking**

```sql
SELECT jobname, schedule, active FROM cron.job
WHERE jobname IN ('automation-runner-tick', 'frontrunner-daily-ingest-tick');
-- Both should be active=true. If active=false, run:
-- SELECT cron.alter_job(jobid := <id>, active := true);
```

**Find missed cron ticks** (cron didn't fire when it should have)

```sql
-- pg_cron writes successful tick runs here:
SELECT runid, jobname, status, start_time, end_time
FROM cron.job_run_details
WHERE jobname = 'automation-runner-tick'
ORDER BY start_time DESC LIMIT 30;
```

---

## Common failure patterns and remedies

| Symptom | Likely cause | Fix |
|---|---|---|
| `Composio EXTERNAL failed: Tool EXTERNAL not found` | Recipe `composio_action` set to literal `EXTERNAL` instead of a real tool slug. Misconfiguration. | `UPDATE automation_recipes SET composio_action='EDGE_FUNCTION:<slug>' WHERE recipe_name='<name>';` (see Mail Labeler entry for actual 2026-06-16 incident) |
| `Missing settings credential: composio_<X>_account_id` | Composio connection for that toolkit was never authorized OR `settings` row missing | Connect at https://platform.composio.dev/connections, then `INSERT INTO settings (agency_id, setting_key, setting_value) VALUES ('ed4b4f81-...', 'composio_<X>_account_id', '<account_id>');` |
| Composio error mentions `OAuth` / `expired` / `unauthorized` | Token expired (Gmail tokens typically die after 7-14 days of inactivity, but should auto-refresh) | Re-authorize the connection at https://platform.composio.dev/connections. Recipe will recover on next tick. |
| Recipe has `is_active=true` but no recent runs in run_log | `cron_expression` malformed OR pg_cron paused | Check `cron.job_run_details` for tick history; verify `cron_expression` matches `^[*0-9,/-]+ [*0-9,/-]+ [*0-9,/-]+ [*0-9,/-]+ [*0-9,/-]+$` |
| Edge function returns 500, run log shows generic error | Check the function's own logs in Supabase Dashboard → Edge Functions → `<slug>` → Logs | Usually reveals stack trace; common is Composio API rate limit or downstream API change |
| Internal handler raises `function "<name>" not found in public schema` | Migration that creates the handler wasn't applied, or `internal_handler` value doesn't match function name | `SELECT proname FROM pg_proc WHERE proname ILIKE '%<handler>%';` to find the real name; update the recipe row |
| GL Writers run but `journal_entries` count flat | `gl_cutover_date` in settings might be in the future, blocking writes; or `skip_pre_cutover=true` and source rows are pre-cutover | `SELECT setting_value FROM settings WHERE setting_key='gl_cutover_date';` — currently `2026-05-01` |

---

## Manual reruns

**INTERNAL recipe** (any with `composio_action='INTERNAL'`):

```sql
-- Replace recipe_name. Returns the handler's jsonb output directly.
SELECT public.run_internal_recipe(
  (SELECT id FROM automation_recipes
   WHERE agency_id = 'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
     AND recipe_name = 'Goals Auto-Sync')
);
```

This does NOT write to `automation_run_log` (only the runner does). Manual reruns are for verification — use the runner for "production" reruns.

**EDGE_FUNCTION recipe** — call the edge function directly:

```bash
# Replace <slug> and <secret>. <secret> is settings.automation_runner_cron_secret.
curl -X POST \
  https://aerutjqyjlbzrklgpwzv.supabase.co/functions/v1/<slug> \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"shared_secret":"<secret>","triggered_by":"manual_rerun"}'
```

**Force a recipe to fire via the normal runner path** — set its `cron_expression` to the current minute briefly, OR call directly:

```sql
SELECT public.run_automation_recipe(
  (SELECT id FROM automation_recipes
   WHERE agency_id = 'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
     AND recipe_name = '<name>')
);
```

This goes through the runner; it WILL write to `automation_run_log`.

---

# Recipe catalog

Grouped by function. **Active** count: 15. **Inactive** count: 3 (social — pending platform connections).

## 📥 Document intake & archive

Front door for every PDF, statement, and report arriving via Gmail. Order of execution matters: Document Processor catches the inbound, Email Archiver and Drive Archiver file the artifact, Mail Labeler closes the loop.

---

### Document Processor

Polls Gmail for new attachments twice per hour. Classifies, archives to Drive, routes financial documents through Groq parse and a balanced JE pipeline. Front door for all document intake.

| Field | Value |
|---|---|
| Schedule | `7,37 * * * *` — every 30 min, at :07 and :37 of each hour |
| Architecture | INTERNAL |
| Handler | `public.dispatch_document_processor` |
| Output table | `documents` |
| Reads | Gmail (via Composio), `settings` |
| Writes | `documents`, `comp_recap` (via downstream parse), `journal_entries` (via GL Entry Writer chain) |
| Composio connections | `gmail`, `googledrive` |
| Required settings | `composio_api_key`, `composio_user_id`, `composio_gmail_account_id`, `composio_googledrive_account_id`, drive folder ids per document type |

**Verify healthy**

```sql
SELECT COUNT(*) AS docs_24h
FROM documents
WHERE agency_id = 'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
  AND created_at > NOW() - INTERVAL '24 hours';
```

**Common failures**

- **No new docs for >48h despite inbox activity** → Gmail OAuth expired. Reauth at platform.composio.dev/connections.
- **Doc lands in `processing_status='failed'`** → Check `documents.notes` for the error. Usually OCR or Groq parse failed; remediation depends on doc type.
- **Same doc keeps reappearing** → `gmail_label_applied_at` not being set; Mail Labeler downstream is broken. Fix Mail Labeler first.

---

### Email Archiver

Archives older email and files attachments to Drive by subject/sender rules. Logs each archived doc with a source link.

| Field | Value |
|---|---|
| Schedule | `0 13 * * *` — daily 13:00 UTC (9:00 ET) |
| Architecture | INTERNAL |
| Handler | `public.dispatch_email_archiver` |
| Output table | `documents` |
| Gmail query | `newer_than:730d has:attachment (subject:"comp" OR subject:"deduction" OR subject:"statement" OR subject:"payroll" OR subject:"production")` |
| Preserves starred | Yes |

**Verify healthy**

Same query as Document Processor — both write to `documents`. Check the run_log entry directly for what was archived in the daily 13:00 UTC run.

**Common failures**

- **Same as Document Processor** — both share Gmail/Drive auth paths.

---

### Drive Archiver

Files Gmail-sourced documents to their proper Drive folder based on `document_type` + `period_year`. Picks up documents with `source_message_id` + `source_attachment_id` populated and `drive_file_id IS NULL`, fetches the attachment via Composio, uploads to the right folder, marks the document as archived.

| Field | Value |
|---|---|
| Schedule | `30 13 * * *` — daily 13:30 UTC (9:30 ET, 30 min after Email Archiver) |
| Architecture | EDGE_FUNCTION:drive-archiver |
| Source | `supabase/functions/drive-archiver/index.ts` |
| Reads | `documents` (where `drive_file_id IS NULL`), Gmail attachments via Composio |
| Writes | Updates `documents` with `drive_file_id`, `drive_url`, `processing_status='archived'` |

**Folder routing** (settings keys, year-partitioned):

| document_type | Drive folder setting |
|---|---|
| `comp_recap` | `drive_sf_comp_<YYYY>_folder_id` |
| `deduction_statement`, `control_d` | `drive_deductions_<YYYY>_folder_id` |
| `payroll_run`, `adp_payroll` | `drive_payroll_<YYYY>_folder_id` |
| `bank_statement` | `drive_bank_<YYYY>_folder_id` |
| `credit_card_statement`, `cc_statement` | `drive_cc_<YYYY>_folder_id` |
| `cpa_pnl`, `cpa_balance_sheet`, `cpa_general_ledger`, `cpa_financials` | `drive_gl_<YYYY>_folder_id` |
| `loan_statement` | `drive_bank_<YYYY>_folder_id` |
| `compliance`, `hr`, `social`, `report` | respective root folders |
| fallback | `drive_misc_folder_id` |

**Verify healthy**

```sql
SELECT COUNT(*) AS unarchived_with_source
FROM documents
WHERE agency_id = 'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
  AND drive_file_id IS NULL
  AND source_message_id IS NOT NULL
  AND source_attachment_id IS NOT NULL;
-- Should trend to zero after each 13:30 UTC run.
```

**Common failures**

- **`No folder for document_type=<X>`** → Either a new document_type without a routing rule, or the settings key for that year not populated. Add the row to `settings` or extend the function's `resolveDestFolder`.
- **`No s3url in attachment response`** → Gmail's attachment ID has expired (Gmail rotates these after ~7 days). The document_processor should be re-fetching attachment IDs on each pass; this usually means the source email was deleted.

---

### Mail Labeler

Applies `BCC/Processed` Gmail label to source emails after documents are ingested. Idempotent; only acts on docs where `gmail_label_applied_at IS NULL`.

| Field | Value |
|---|---|
| Schedule | `*/15 * * * *` — every 15 minutes |
| Architecture | EDGE_FUNCTION:mail-labeler |
| Source | `supabase/functions/mail-labeler/index.ts` |
| Reads | `documents` (processed + unlabeled) |
| Writes | Updates `documents.gmail_label_applied_at`; calls `GMAIL_ADD_LABEL_TO_EMAIL` on each source message |
| Required settings | `gmail_processed_label_id`, `composio_api_key`, `composio_user_id`, `composio_gmail_account_id` |

**Verify healthy**

```sql
SELECT COUNT(*) AS processed_unlabeled
FROM documents
WHERE agency_id = 'ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
  AND processing_status = 'processed'
  AND gmail_label_applied_at IS NULL
  AND source_message_id IS NOT NULL;
-- Should be near zero. If growing, labeler is failing silently.
```

**Real incident — 2026-06-16**: Mail Labeler failed 30+ times in a 7-hour window with `Composio EXTERNAL failed: Tool EXTERNAL not found`. Root cause: recipe `composio_action` was literally `EXTERNAL` instead of `EDGE_FUNCTION:mail-labeler`. Fixed by updating the recipe row. Since then: 670 consecutive successes over 7 days.

**Common failures**

- **`Tool EXTERNAL not found`** — see above. `UPDATE automation_recipes SET composio_action='EDGE_FUNCTION:mail-labeler' WHERE recipe_name='Mail Labeler';`
- **`gmail_processed_label_id` setting missing** → Create the `BCC/Processed` label in Gmail, find its ID via `GMAIL_LIST_LABELS` Composio call, insert to settings.

---

## 💰 GL Writers

The general-ledger pipeline. Four writers, each handling a different source. All idempotent, all post-cutover only (`skip_pre_cutover=true`, `gl_cutover_date='2026-05-01'`). Sequence: 16:00 UTC GL Entry Writer (comp_recap), 16:15 Payroll, 16:30 Bank, 16:45 Credit Card.

---

### GL Entry Writer

Daily cash-basis GL writer. Calls `write_comp_recap_gl_entries()` Postgres function. Routes each `comp_recap` row to correct revenue account via `comp_recap_account_map`. Idempotent. Reversals handled. 498 rows loaded as of May 2026.

| Field | Value |
|---|---|
| Schedule | `0 16 * * *` — daily 16:00 UTC (12:00 ET) |
| Architecture | INTERNAL |
| Handler | `public.gl_entry_writer` → calls `public.write_comp_recap_gl_entries(agency_id)` |
| Source table | `comp_recap` |
| Output table | `journal_entries` |
| Lookup | `comp_recap_account_map` (mapping rules), `chart_of_accounts` (account ids) |

**Note on basis:** Currently writes **cash-basis** entries. **Sprint item 9** is a refactor to write accrual entries post-cutover so this matches the CPA's accrual basis. Until that ships, expect a small basis-shift in the P&L between BCC and CPA views.

**Verify healthy**

```sql
SELECT
  (SELECT COUNT(*) FROM comp_recap
   WHERE agency_id='ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
     AND period_year*100+period_month >= 202605) AS source_rows_post_cutover,
  (SELECT COUNT(*) FROM journal_entries
   WHERE agency_id='ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
     AND source_table='comp_recap'
     AND entry_date >= '2026-05-01') AS gl_rows_post_cutover;
-- Roughly proportional; comp_recap rows fan out to 2+ JE rows each.
```

**Common failures**

- **`Account not found in comp_recap_account_map`** → A new comp_type/comp_category combo arrived. Add the mapping row, then rerun.
- **Unbalanced JE entries** → Should never happen (function enforces balanced pairs); if it does, check `write_comp_recap_gl_entries` for the specific comp_recap row that failed.

---

### Payroll GL Writer

SINGLE-ENTITY variant. Posts post-cutover `payroll_runs` to `journal_entries`: DR Payroll Costs, CR Operating Cash. Idempotent.

| Field | Value |
|---|---|
| Schedule | `15 16 * * *` — daily 16:15 UTC |
| Architecture | INTERNAL |
| Handler | `public.payroll_gl_writer` |
| Source | `payroll_runs` + `payroll_detail` |
| Posting convention | Single-entity — credits `Operating Checking Account` |

**Currently no-op**: `payroll_runs` is empty pending Tiffany's payroll backfill from ADP. Will activate the moment the first post-2026-05-01 payroll row lands.

**Common failures**

- **`credit_account_name 'Operating Checking Account' not in chart_of_accounts`** → Account naming drift. Confirm the COA still has that exact name (case-sensitive) or update `input_config.credit_account_name`.

---

### Bank GL Writer

Posts post-cutover `bank_transactions` to `journal_entries`. Third in GL chain at 16:30. Never fails to post — anything unclassified lands in suspense. Idempotent.

| Field | Value |
|---|---|
| Schedule | `30 16 * * *` — daily 16:30 UTC |
| Architecture | INTERNAL |
| Handler | `public.bank_gl_writer` |
| Source | `bank_transactions` |
| Classification waterfall | `category_match` → `split_label_match` → `classification_rules` → `suspense_account` |

**Currently no-op**: `bank_transactions` is empty pending bank statement backfill.

**Common failures**

- **Lots of rows landing in suspense** → Either classification rules aren't covering the transaction descriptions, OR descriptions are noisy. Drill into `journal_entries WHERE account_name LIKE '%Suspense%'` to find patterns, then add rules to `classification_rules` table.

---

### Credit Card GL Writer

Posts post-cutover `credit_transactions` to `journal_entries`. Last in GL chain at 16:45. Charges DR expense / CR card; payments DR card / CR paying side. Never fails to post.

| Field | Value |
|---|---|
| Schedule | `45 16 * * *` — daily 16:45 UTC |
| Architecture | INTERNAL |
| Handler | `public.cc_gl_writer` |
| Source | `credit_transactions` |
| Charge waterfall | `category_match` → `classification_rules` → `suspense_account` |

**Currently no-op**: `credit_transactions` empty pending CC statement backfill (all 4 cards: AmEx 92005, BOA 3076, Spark Capital One, US Bank 2535).

**Common failures**

- Same suspense pattern as Bank GL Writer. Tighten `classification_rules`.

---

## 📊 Performance & goals

Producer activity, performance monitoring, and Q3 goal tracking.

---

### FrontRunner Daily Ingest

Pulls FrontRunner Daily Agency Summary emails from Gmail, parses producer activity (hours, sales, calls, quotes, pivots), upserts to `producer_activity_daily`. Triggered by dedicated pg_cron job at 14:30 UTC (10:30 ET) — 30 min after FrontRunner sends.

| Field | Value |
|---|---|
| Schedule | `30 14 * * *` — daily 14:30 UTC (10:30 ET) |
| Architecture | EDGE_FUNCTION:frontrunner-daily-ingest |
| Source | `supabase/functions/frontrunner-daily-ingest/index.ts` |
| Gmail filter | `from:support@imafrontrunner.com newer_than:7d` |
| Lookback | 7 days; idempotent via source_message_id dedupe |
| Output | `producer_activity_daily` |

**Verify healthy**

```sql
SELECT activity_date, COUNT(*) AS producer_rows
FROM producer_activity_daily
WHERE agency_id='ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
  AND activity_date >= CURRENT_DATE - 14
GROUP BY activity_date
ORDER BY activity_date DESC;
-- Should see 8 rows per day (8 producers) starting roughly 2026-06-23 onward.
```

**Common failures**

- **No new rows for >2 days** → FrontRunner email not arriving (check Gmail), or sender filter doesn't match. Verify `support@imafrontrunner.com` is still the sender.
- **HTML parsing returns zero stats** → FrontRunner changed their email template. The deterministic parser in `frontrunner-daily-ingest/index.ts` will need updating; check `stripHtml` and `parseReport` against a recent email.
- **One producer missing** → Producer name spelling drift between the email and the hardcoded `PRODUCERS` array in the edge function. Update the array.

---

### Producer Underperformance Watcher

Daily check of each producer MTD pace vs 3-month rolling average. Fires alert when producer falls below 70% of expected pace through current point in month.

| Field | Value |
|---|---|
| Schedule | `0 12 * * *` — daily 12:00 UTC (8:00 ET) |
| Architecture | INTERNAL |
| Handler | `public.producer_underperformance_watcher` |
| Source | `producer_production` (per-staff monthly premium) |
| Output | `alerts` (one per underperforming producer, idempotent per day) |
| Threshold | 70% of expected MTD pace (configurable in `input_config.threshold_pct`) |
| Skip rule | Days 1-4 of month — too early to measure |

**Currently no-op for alerting**: `producer_production` is empty pending Score+/PYC sample (task `81ce0138`). When loaded, this fires daily.

**Verify healthy**

After Score+/PYC parsing ships, alerts table should show recent rows with `alert_type='producer_underperformance'`. None today → either everyone's on pace OR data isn't loaded.

---

### Goals Auto-Sync

Weekly: refreshes `goals.current_value` from `producer_activity_daily` (fs_pivots, renewal_touches) and `comp_recap` (AMUTL USD goals). Title-driven matching for per-producer, Producer Team, and Team aggregates.

| Field | Value |
|---|---|
| Schedule | `30 12 * * 1` — Mondays 12:30 UTC (8:30 ET, 30 min after Daily Briefing) |
| Architecture | INTERNAL |
| Handler | `public.goals_auto_sync` (migration 019) |
| First fires | Monday 2026-06-29 12:30 UTC |
| Source | `producer_activity_daily`, `comp_recap` |
| Output | Updates `goals.current_value` for active quarterly goals |

**Title parsing rules:**

| Title pattern | Aggregation |
|---|---|
| `<Period> — Team <Metric>` | All 8 producers |
| `<Period> — Producer Team <Metric>` | 6 LSPs (excludes Patti, Tim) |
| `<Period> — <Producer Name> <Metric>` | That producer only |

**Unit → source column:**

| Unit | Source |
|---|---|
| `fs_pivots` | `producer_activity_daily.fs_pivots` |
| `renewal_touches` | `producer_activity_daily.renewal_touches` |
| `usd` (with `AMUTL` + `Renewal` in title) | `comp_recap` where `comp_category='auto'` AND `comp_type='renewal'` |

**Verify healthy**

```sql
SELECT title, current_value, target_value, updated_at AT TIME ZONE 'America/New_York'
FROM goals
WHERE agency_id='ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
  AND status='active'
ORDER BY updated_at DESC LIMIT 5;
-- After each Monday tick, all active goals should have updated_at matching the tick time.
```

**Common failures**

- **Goal current_value stuck at 0.00** → Either no producer_activity_daily rows in the period (expected pre-Q3) OR title doesn't match any parsing rule (the function increments a `v_skipped` counter; check `output_summary` for the skipped count).
- **New goal added but never syncs** → Title doesn't match the patterns above. Add a new branch to `goals_auto_sync` plpgsql, or rename the goal to fit existing patterns.

---

## 🗓 Monthly close

Generates the close checklist on the 1st; monitors progress daily.

---

### Monthly Close Checklist Generator

On the 1st of each month, generates the prior month close checklist from SF-agent template. Idempotent via `skip_if_exists`.

| Field | Value |
|---|---|
| Schedule | `0 14 1 * *` — 14:00 UTC on the 1st of each month |
| Architecture | INTERNAL |
| Handler | `public.monthly_close_generator` |
| Output | `monthly_close_checklist` |
| Generates for | Previous month |

**Template** (8 items per month, with expected-offset days from period-end):

- SF Daily Comp Recaps — full month (3d)
- Payroll Reports — all runs (3d)
- SF Deduction Statement (5d)
- Producer Production Report (5d)
- Bank Operating Checking statement (8d)
- Business Credit Card statement (10d)
- Reconcile COMP_RECAP to GL before closing (10d)
- Review imported transactions — flag uncategorized / suspense items (10d)

**Verify healthy**

```sql
SELECT period_year, period_month, COUNT(*) AS items, SUM((status='complete')::int) AS done
FROM monthly_close_checklist
WHERE agency_id='ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
GROUP BY period_year, period_month ORDER BY period_year DESC, period_month DESC;
-- Each month should have 8 items.
```

---

### Monthly Close Monitor

Daily check of `monthly_close_checklist` progress. Mid-month warns on overdue items; end-of-month escalates.

| Field | Value |
|---|---|
| Schedule | `0 14 * * *` — daily 14:00 UTC |
| Architecture | INTERNAL |
| Handler | `public.monthly_close_monitor` |
| Output | `alerts` |
| Mid-month threshold | 2 days overdue → severity `warning` |
| End-of-month | severity `critical` |

**Verify healthy**

```sql
SELECT severity, COUNT(*)
FROM alerts
WHERE agency_id='ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
  AND alert_type='monthly_close'
  AND is_resolved=false
GROUP BY severity;
-- The 3 currently open May 2026 alerts are this watcher's output.
```

---

## ⚙️ Operations

Daily briefing and connection monitoring.

---

### Daily Briefing Email

Composes a morning HTML briefing from live data each morning. Pulls MTD comp, tasks, alerts, compliance, staff, AIPP, producer production. Inserts a `briefings` row then sends via Composio Gmail. **Hybrid recipe**: internal_handler composes, then Composio sends.

| Field | Value |
|---|---|
| Schedule | `0 12 * * *` — daily 12:00 UTC (8:00 ET) |
| Architecture | HYBRID: INTERNAL composer + GMAIL_SEND_EMAIL |
| Handler | `public.daily_briefing_composer` |
| Composio action | `GMAIL_SEND_EMAIL` via `gmail` connection |
| Recipient | `tmapp09@gmail.com` (Tiffany's personal inbox) |
| Output | `daily_briefing_log` row + sent email |

**Verify healthy**

```sql
SELECT created_at AT TIME ZONE 'America/New_York' AS sent_et, subject
FROM daily_briefing_log
WHERE agency_id='ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
ORDER BY created_at DESC LIMIT 7;
-- Should show one entry per day, daily, around 8:00 ET.
```

**Common failures**

- **Composer succeeded but email didn't send** → Gmail Composio call failed. Check `automation_run_log.error_message` for the most recent failed run. Re-auth Gmail if it's an OAuth error.
- **Briefing body empty** → `daily_briefing_composer` plpgsql ran but pulled empty data. Verify the underlying snapshot queries against the dashboard.

---

### Connection Health Poller

Polls Composio `/api/v3/connected_accounts` every 5 min and upserts connection status to `connection_health`. Powers Settings → Connections page.

| Field | Value |
|---|---|
| Schedule | `*/5 * * * *` — every 5 minutes |
| Architecture | EDGE_FUNCTION:connection-health-poller |
| Source | `supabase/functions/connection-health-poller/index.ts` |
| Output | `connection_health` |
| Required settings | `composio_api_key` |

**Verify healthy**

```sql
SELECT display_name, status, status_color, last_checked_at
FROM connection_health
WHERE agency_id='ed4b4f81-4ec1-4676-9dea-2a9c98e4a065'
ORDER BY display_name;
-- last_checked_at should be within last 10 minutes for every row.
```

**Common failures**

- **All rows show as `GONE` or stale** → Composio API key invalid. Verify `composio_api_key` in settings.
- **Specific connection shows `EXPIRED`** → Token expired. Re-auth that specific toolkit at platform.composio.dev/connections.

---

## 📱 Social media (inactive)

All three social recipes are inactive pending platform connections. Content is staged in `content_calendar` and ready to fire the moment connections come online.

---

### Social Media Scheduler — Facebook

Posts approved `content_calendar` items to FB Page on scheduled date.

| Field | Value |
|---|---|
| Schedule | `0 14 * * *` — daily 14:00 UTC |
| Architecture | Composio direct: `FACEBOOK_POST_TO_PAGE` |
| Connection | `facebook` |
| Status | **INACTIVE** — pending Facebook page connection |
| Required settings (once active) | `composio_facebook_account_id`, `facebook_page_id` |

**Activation steps**: (1) Connect Facebook Page at platform.composio.dev/connections (NOT personal profile), (2) insert `composio_facebook_account_id` and `facebook_page_id` to settings, (3) `UPDATE automation_recipes SET is_active=true WHERE recipe_name='Social Media Scheduler — Facebook'`.

---

### Social Media Scheduler — LinkedIn

Posts approved `content_calendar` items to LinkedIn on scheduled date.

| Field | Value |
|---|---|
| Schedule | `0 14 * * *` — daily 14:00 UTC |
| Architecture | Composio direct: `LINKEDIN_CREATE_POST` |
| Connection | `linkedin` |
| Status | **INACTIVE** — pending LinkedIn connection |
| Required settings (once active) | `composio_linkedin_account_id` |

**Activation steps**: Same pattern as Facebook — connect LinkedIn via Composio, populate the settings key, flip `is_active=true`.

---

### Social Media Scheduler — Instagram

Creates a high-priority task reminding operator to post manually to Instagram. Caption/hashtags already in `content_calendar` row. Inactive until IG Business account connected.

| Field | Value |
|---|---|
| Schedule | `30 13 * * *` — daily 13:30 UTC |
| Architecture | INTERNAL |
| Handler | `public.instagram_manual_reminder` |
| Output | `tasks` (high-priority reminder per scheduled IG post) |
| Status | **INACTIVE** |

**Why manual?** Instagram does not allow programmatic posting via Composio's current toolset. Activation creates a task ("Post to Instagram today: <title>") that Tiffany acts on with the IG mobile app.

---

# Appendix

## Schedule heatmap (UTC)

| Hour (UTC) | Hour (ET) | Recipes that fire | Notes |
|---|---|---|---|
| `*/5` | every 5 min | Connection Health Poller | |
| `7,37 *` | every 30 min | Document Processor | |
| `*/15` | every 15 min | Mail Labeler | |
| 12:00 | 8:00 ET | Daily Briefing Email, Producer Underperformance Watcher | Tightest morning band |
| 12:30 | 8:30 ET | Goals Auto-Sync (Mondays only) | |
| 13:00 | 9:00 ET | Email Archiver | |
| 13:30 | 9:30 ET | Drive Archiver, Instagram reminder (when active) | |
| 14:00 | 10:00 ET | Monthly Close Monitor, Monthly Close Generator (1st only), Social (when active) | |
| 14:30 | 10:30 ET | FrontRunner Daily Ingest | 30 min after FrontRunner sends |
| 16:00 | 12:00 ET | GL Entry Writer (comp_recap → JE) | |
| 16:15 | 12:15 ET | Payroll GL Writer | |
| 16:30 | 12:30 ET | Bank GL Writer | |
| 16:45 | 12:45 ET | Credit Card GL Writer | Closes the GL chain |

## Architecture cheat-sheet

```
pg_cron (* * * * *)
   └─ run_due_automation_recipes()
        ├─ For each due recipe:
        │   ├─ composio_action = 'INTERNAL'
        │   │     → run_internal_recipe(id)
        │   │         → public.<internal_handler>(agency_id, recipe_id) → jsonb
        │   │
        │   ├─ composio_action = 'EDGE_FUNCTION:slug'
        │   │     → POST functions/v1/slug
        │   │         → Edge function logs to automation_run_log itself
        │   │
        │   ├─ composio_action = <COMPOSIO_TOOL>
        │   │     → automation-runner Edge Function
        │   │         → callComposio() → Composio Tools API
        │   │
        │   └─ HYBRID (internal_handler + composio_action set)
        │         → run_internal_recipe FIRST (builds data, writes log row)
        │         → THEN composio_action (sends email, posts, etc.)
        │
        └─ Write to automation_run_log, update last_run_status
```

## Source code locations

| Layer | Path |
|---|---|
| Plpgsql handlers | Postgres `public.<handler>` functions (see migrations dir) |
| Edge functions | `supabase/functions/<slug>/index.ts` |
| pg_cron jobs | `cron.job` table |
| Recipe definitions | `automation_recipes` table |
| Run history | `automation_run_log` table |
| Settings (credentials) | `settings` table, scoped by `agency_id` + `setting_key` |
| Repo runbook (this file) | `docs/AUTOMATION_RUNBOOK.md` |

---

*Last regenerated: 2026-06-25. When a new recipe is added or a recipe's behavior changes meaningfully, update the relevant section here in the same commit as the code/migration change.*
