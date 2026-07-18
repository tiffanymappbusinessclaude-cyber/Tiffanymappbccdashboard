# Premium BCC Install Audit

**Version:** v1.0
**Corresponds to master state:**
- Base `bcc-master-template` @ commit `041b4321` or later
- Premium overlay `bcc-premium-overlay` @ commit `697074c5` (v1.1.1) or later

**Purpose:** This document is uploaded to a newly-installed client's Claude project by the Setup Technician immediately after seeding. The client's Claude runs each check against the client's Supabase project, verifies against the expected outcome, and produces a gap report at the end. Any FAIL result is a hand-remediation item for the Setup Technician before client handoff.

---

## How the client Claude should run this audit

1. Read this document top to bottom.
2. For each check, execute the SQL against the client's Supabase project via the Supabase MCP. Record PASS / FAIL / PARTIAL.
3. Do NOT skip checks even if a previous check failed — completeness of the gap report matters more than sequencing.
4. Do NOT attempt remediation SQL automatically. Report the gap. The Setup Technician decides remediation.
5. At the end, produce the **Audit Summary** in the format specified in Section 12.

Before starting, confirm the client's Supabase project_id is loaded. If it isn't, ask the Setup Technician for it.

---

## SECTION 1 · Repo & bootstrap state

### 1.1 Repo is private

**Why it matters:** LICENSE.md declares proprietary, non-transferable — public repo violates the MSA.

Ask the Setup Technician (or check via GitHub API if available):
- Is the client's forked repo set to **Private**?
- Does `cindarellabots-droid` appear as a **Write collaborator**?
- Does `LICENSE.md` exist at the repo root with the "PROPRIETARY, NON-TRANSFERABLE" header referencing the MSA and Florida law?

**Expected:** All three YES.
**If any NO:** Setup Technician re-runs `tools/bootstrap_client_repo.sh` against the fork. The script is defense-in-depth and aborts if any of the three conditions fail — so if the fork is missing them, bootstrap never ran or aborted silently.

### 1.2 Upstream sync

**Ask the Setup Technician:**
- What Base commit is the client fork synced to? (Expected: `041b4321` or later)
- Was Premium overlay applied? (Expected: overlay from `697074c5` / v1.1.1 or later merged into the client fork)
- Any client-specific patches on top? (Should be minimal — typically only branding + env vars)

---

## SECTION 2 · Migrations ledger

### 2.1 Migration count

```sql
SELECT count(*) AS migrations_applied
FROM supabase_migrations.schema_migrations;
```

**Expected:** ≥ 84 migrations applied (Base ≤099 caps + Premium 100–199 range partial coverage as of overlay v1.1.1).
**If less:** the client's fork didn't get the full migration set. Confirm which migrations are missing by comparing against the master fork's `supabase/migrations/` folder listing, then run the missing ones with `supabase db push`.

### 2.2 Latest migration timestamp is recent

```sql
SELECT version FROM supabase_migrations.schema_migrations
ORDER BY version DESC LIMIT 1;
```

**Expected:** version is `20260714…` or newer (i.e. from July 14, 2026 onward — the Phase 2 backport + EmptyState hotfix baseline).
**If older:** Base overlay is stale. Rebase against `041b4321`.

### 2.3 Critical Premium hotfix migrations present

The v1.1.0.1 hotfix set MUST be in the ledger, because these fix production runtime crashes. Check for a migration whose SQL creates/replaces `rpc_create_pto_request` with `setting_key` and `setting_value` column names (NOT `settings.key/value`):

```sql
SELECT proname, prosrc FROM pg_proc
WHERE proname = 'rpc_create_pto_request';
```

**Expected:** Function body references `setting_key` and `setting_value`. If it references `settings.key` / `settings.value` — that's the broken v1.1.0 version. First producer PTO submission will crash. Migration `107c` (or equivalent) must be re-run.

Also verify `rpc_edit_pto_request` uses the same column names:

```sql
SELECT proname, prosrc FROM pg_proc
WHERE proname = 'rpc_edit_pto_request';
```

**Expected:** Same as above — `setting_key` / `setting_value`.

---

## SECTION 3 · Schema surface — tables

### 3.1 Table count

```sql
SELECT count(*) AS tables
FROM information_schema.tables
WHERE table_schema='public' AND table_type='BASE TABLE';
```

**Expected:** ≥ 87 tables. Values much below this indicate incomplete migration application.

### 3.2 Critical Base tables present

```sql
SELECT string_agg(table_name, ', ' ORDER BY table_name) AS present
FROM information_schema.tables
WHERE table_schema='public' AND table_type='BASE TABLE'
AND table_name IN (
  'agency', 'staff', 'chart_of_accounts', 'journal_entries', 'journal_lines',
  'bank_accounts', 'credit_accounts', 'credit_transactions', 'payroll_runs',
  'payroll_detail', 'comp_recap', 'compliance_rules', 'compliance_log',
  'compliance_calendar', 'documents', 'automation_recipes', 'automation_run_log',
  'persistent_memory', 'module_help', 'system_map', 'settings',
  'content_calendar', 'social_accounts', 'social_analytics', 'alerts', 'goals',
  'tasks', 'monthly_close_checklist', 'notification_preferences'
);
```

**Expected:** All 29 tables named. If any missing, that domain's Base migrations didn't run.

### 3.3 Critical Premium tables present

```sql
SELECT string_agg(table_name, ', ' ORDER BY table_name) AS present
FROM information_schema.tables
WHERE table_schema='public' AND table_type='BASE TABLE'
AND table_name IN (
  'pto_requests', 'pto_balances', 'pto_policies', 'pto_wage_snapshots',
  'time_clock_shifts', 'time_clock_breaks', 'time_tracking',
  'sales_activity', 'scoreboard_goals', 'scoreboard_tracking',
  'handbook_sections', 'handbook_acknowledgments',
  'benefit_plans', 'benefit_enrollments',
  'personnel_files', 'personnel_documents', 'personnel_document_access_log',
  'personnel_file_manager_grants', 'personnel_form_templates',
  'producer_licenses', 'milestone_recognitions',
  'emergency_contacts', 'emergency_contact_access_log',
  'staff_performance', 'onboarding_checklists', 'positions', 'offers',
  'applicants', 'interviews', 'commission_structures', 'bonus_plans',
  'comp_plans', 'comp_plan_versions', 'comp_plan_assignments',
  'qualification_thresholds', 'policies', 'policy_lifecycle_events',
  'policy_state_history', 'product_types', 'offices',
  'shift_audit_log', 'pay_periods', 'pay_period_status_log',
  'agency_announcements', 'payout_line_items', 'payouts',
  'chargeback_disclaimer_acks', 'recoup_dismissals', 'pay_plans',
  'payroll_settings'
);
```

**Expected:** All 50 tables present. Missing tables indicate incomplete Premium overlay application.

---

## SECTION 4 · Schema surface — views

### 4.1 View count

```sql
SELECT count(*) AS views
FROM information_schema.views
WHERE table_schema='public';
```

**Expected:** ≥ 26 views.

### 4.2 Critical Premium views present

```sql
SELECT string_agg(table_name, ', ' ORDER BY table_name) AS present
FROM information_schema.views
WHERE table_schema='public'
AND table_name IN (
  'v_income_statement', 'v_balance_sheet',
  'v_pto_my_balance', 'v_pto_my_requests', 'v_pto_admin_roster',
  'v_upcoming_milestones', 'v_expiring_licenses',
  'v_sales_activity_daily_by_producer', 'v_sales_activity_weekly_by_producer',
  'v_sales_activity_monthly_by_producer', 'v_sales_activity_outcome_distribution',
  'v_time_tracking_weekly_by_producer', 'v_time_tracking_monthly_by_producer',
  'v_time_tracking_missing_days_by_producer', 'v_time_tracking_category_mtd',
  'v_shift_reconciliation',
  'v_handbook_current', 'v_handbook_current_version', 'v_handbook_ack_status',
  'v_benefits_enrollment_summary', 'v_benefits_my_enrollments',
  'v_benefit_plans_active',
  'v_active_comp_plan_assignments', 'v_bonus_qualifications',
  'v_pipeline_by_stage', 'v_chargeback_recoup_queue'
);
```

**Expected:** All 26 present.

### 4.3 `v_upcoming_milestones` hotfix version

The v1.1.0.1 hotfix requires `years_of_service` be computed AT `milestone_date`, NOT `current_date`. If computed at current_date, service anniversaries miss firing on time.

```sql
SELECT pg_get_viewdef('public.v_upcoming_milestones', true) AS view_sql;
```

**Expected:** The view definition contains `AGE(milestone_date, staff.hire_date)` or `EXTRACT(YEAR FROM AGE(milestone_date, ...))` — NOT `AGE(current_date, ...)` or `AGE(CURRENT_DATE, ...)`.
**If wrong:** Migration 112 (or equivalent) must be re-run.

---

## SECTION 5 · Schema surface — RPCs / functions

### 5.1 Function count

```sql
SELECT count(*) AS functions
FROM information_schema.routines
WHERE routine_schema='public' AND routine_type='FUNCTION';
```

**Expected:** ≥ 300 functions.

### 5.2 Critical Premium RPCs present

```sql
SELECT string_agg(routine_name, ', ' ORDER BY routine_name) AS present
FROM information_schema.routines
WHERE routine_schema='public' AND routine_type='FUNCTION'
AND routine_name IN (
  'rpc_create_pto_request', 'rpc_edit_pto_request',
  'get_operating_context',
  'get_my_profile',
  'rpc_clock_in', 'rpc_clock_out',
  'rpc_start_break', 'rpc_end_break',
  'rpc_log_sales_activity',
  'rpc_acknowledge_handbook_version',
  'rpc_enroll_benefit', 'rpc_unenroll_benefit',
  'rpc_upload_personnel_document', 'rpc_grant_personnel_file_access'
);
```

**Expected:** All present. Missing RPCs indicate incomplete function migrations.

---

## SECTION 6 · Seeded reference data

The following counts are what the client Claude expects to see AT INSTALL TIME (i.e. immediately after Setup Tech seed run, before the agent has added any of their own data).

### 6.1 State Farm AA05 compliance rules

```sql
SELECT count(*) AS compliance_rules FROM public.compliance_rules;
```

**Expected:** ≥ 76
**If less:** the AA05 seed migration didn't fire. Setup Tech runs the compliance_rules seed script manually.

### 6.2 Chart of accounts

```sql
SELECT count(*) AS chart_of_accounts FROM public.chart_of_accounts;
```

**Expected:** ≥ 140 (State Farm captive-agent standard COA).
**If less:** seed migration for COA didn't fire.

### 6.3 Automation recipes

```sql
SELECT
  count(*) AS total_recipes,
  count(*) FILTER (WHERE is_active) AS active_recipes,
  count(*) FILTER (WHERE cron_expression IS NOT NULL) AS scheduled_recipes,
  count(*) FILTER (WHERE groq_prompt IS NOT NULL) AS uses_groq
FROM public.automation_recipes;
```

**Expected:**
- `total_recipes` = 12
- `active_recipes` = 12
- `scheduled_recipes` = 12
- `uses_groq` ≥ 6 (the parser recipes: SF Daily Comp, Deduction Statement, Bank Statement, Credit Card, Payroll, Producer Production)

### 6.4 Automation recipes — specific names present

```sql
SELECT string_agg(recipe_name, ', ' ORDER BY recipe_name) AS recipes
FROM public.automation_recipes
WHERE recipe_name IN (
  'SF Daily Comp Processor',
  'Deduction Statement Processor',
  'Bank Statement Processor',
  'Credit Card Processor',
  'Payroll Processor',
  'Producer Production Report',
  'Email Archiver',
  'GL Entry Writer',
  'Daily Briefing Email',
  'Social Media Scheduler',
  'Monthly Close Monitor',
  'Producer Underperformance Watcher'
);
```

**Expected:** All 12 named. **This is the most common failure point** due to the install-script skip-if-migration-recorded bug — the migration ledger may show applied but ON CONFLICT clauses ate the INSERTs. Any missing name = Setup Tech hand-seeds that specific recipe from the master repo seed file.

### 6.5 Module help drawer content

```sql
SELECT count(*) AS module_help_entries FROM public.module_help;
```

**Expected:** ≥ 26 (one entry per module: Dashboard, Financials, Financial Reports, Scoreboard, HR & People, PTO, Time Tracking, Sales Activity, Handbook, Benefits, Personnel Files, Milestones, Licenses, Emergency Contacts, Social Media, Claude Chat, Automations, Compliance, Operations Reports, Tasks & Goals, Alerts, Documents, Memory, Wiki & System Map, Playbook & Guide, Settings).
**If less:** module_help seed migration incomplete. Hand-seed missing modules from master.

### 6.6 Compliance calendar

```sql
SELECT count(*) AS compliance_calendar FROM public.compliance_calendar;
```

**Expected:** ≥ 11 (monthly compliance rhythm entries).

### 6.7 Product types (SF line-of-business codes)

```sql
SELECT count(*) AS product_types FROM public.product_types;
```

**Expected:** ≥ 5 (Auto, Fire, Life, Health, Bank — at minimum).

### 6.8 Positions (default agency roles)

```sql
SELECT count(*) AS positions FROM public.positions;
```

**Expected:** ≥ 2 (typically LSP and FSS Producer as defaults).

### 6.9 PTO policies

```sql
SELECT count(*) AS pto_policies FROM public.pto_policies;
```

**Expected:** ≥ 4 (default tiers: 0-1yr, 1-3yr, 3-5yr, 5+yr accrual rates).

### 6.10 Handbook sections

```sql
SELECT count(*) AS handbook_sections FROM public.handbook_sections;
```

**Expected:** ≥ 10 (standard handbook framework sections).

---

## SECTION 7 · Automation runner infrastructure

### 7.1 GROQ_API_KEY environment variable

**Ask the Setup Technician (or check via Supabase Dashboard → Project Settings → Edge Functions → Secrets):**
- Is `GROQ_API_KEY` set as an edge function secret?
- Is it a valid Groq free-tier key (not blank, not a placeholder)?

**Expected:** Set and valid.
**If not:** All Groq-powered parser recipes will fail. Setup Tech provisions a Groq API key at https://console.groq.com and sets it: `supabase secrets set GROQ_API_KEY=<key>` — then stores the key value in the operations DB (`persistent_memory` under category `infrastructure_status`) so future audits can verify.

### 7.2 pg_cron scheduling active

```sql
SELECT count(*) AS active_cron_jobs FROM cron.job WHERE active = true;
```

**Expected:** ≥ 12 (one per recipe). If pg_cron isn't installed at all, extension is missing.

### 7.3 pg_cron extension enabled

```sql
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_cron';
```

**Expected:** Row returned. If empty, run: `CREATE EXTENSION IF NOT EXISTS pg_cron;`

### 7.4 Recent automation runs

```sql
SELECT count(*) AS runs_last_24h
FROM public.automation_run_log
WHERE created_at > now() - interval '24 hours';
```

**Expected at fresh install:** 0 is fine (no recipes have fired yet).
**Expected 48h post-install:** ≥ 20 (recipes should be actively running).
**Note this in the report** so the Setup Tech knows to check back on this at day-2 QA.

---

## SECTION 8 · Integrations (Composio)

### 8.1 Composio project provisioned

**Ask the Setup Technician:**
- Is a Composio project ID stored in `public.settings` (key `composio_project_id`)?
- Is that project ID reachable from the client's Claude project (Settings → Connectors → Composio)?

```sql
SELECT setting_value AS composio_project_id
FROM public.settings
WHERE setting_key = 'composio_project_id';
```

**Expected:** One row with a non-null `pr_...` project ID.

### 8.2 Required OAuth connections

**Ask the Setup Technician to confirm the following OAuth connections are LIVE (green) in the client's Composio project:**

| Integration | Required for |
|---|---|
| Gmail | Recipe fetch/label, Daily Briefing send, Email Archiver |
| Google Drive | Document filing from parsed emails |
| Google Calendar | Team calendar sync, license expiration reminders |
| Facebook | Social Media Scheduler |
| LinkedIn | Social Media Scheduler |
| QuickBooks Online | (Optional Tier 3) Financial mirror |

**Expected at Base + Premium install:** Gmail, Drive, Calendar minimum. Social platforms may be deferred to first-week onboarding.

### 8.3 Service mailbox configured

```sql
SELECT setting_value AS service_mailbox
FROM public.settings
WHERE setting_key = 'service_mailbox';
```

**Expected:** One row with a non-null `<clientbrand>.claude@gmail.com` address. This is the address every automation recipe reads from.

---

## SECTION 9 · Webapp deployment

### 9.1 Vercel URL recorded

```sql
SELECT setting_value AS vercel_app_url
FROM public.settings
WHERE setting_key = 'vercel_app_url';
```

**Expected:** One row with the client's Vercel URL (e.g. `<clientfork>.vercel.app`).

### 9.2 Supabase env vars in Vercel

**Ask the Setup Technician to confirm the Vercel project has these environment variables:**

| Variable | Source |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Dashboard → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Dashboard → Project Settings → API → anon/public |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Project Settings → API → service_role (server-only) |

**Expected:** All three set. Webapp will fail to load without them.

### 9.3 Auth flow works end-to-end

**Ask the Setup Technician to confirm they can:**
- Load the Vercel URL in a browser
- Sign in with the agent's Google account
- Reach the Dashboard without errors
- See the Setup Wizard tile (5 steps)

---

## SECTION 10 · Agency-scoped starter data

### 10.1 Agency row exists

```sql
SELECT id, agency_name FROM public.agency LIMIT 5;
```

**Expected:** Exactly one row for the client's agency. If zero, the agency_id foreign key everything else depends on doesn't exist.

### 10.2 Owner staff row exists

```sql
SELECT id, first_name, last_name, position_title, is_owner
FROM public.staff
WHERE is_owner = true;
```

**Expected:** Exactly one row with `is_owner = true` — the Agent/Owner.

### 10.3 Persistent memory seeded with agent context

**Important context:** Setup Technicians teach the client's Claude throughout the install and data-import process. By the time this audit runs (end of install, pre-handoff), the client's `persistent_memory` should already contain meaningful entries. An empty or near-empty result here means the teach-during-install step was skipped — that's a red flag, NOT a "will fill in later" acceptable state.

```sql
SELECT memory_type, count(*) AS entries
FROM public.persistent_memory
GROUP BY memory_type
ORDER BY memory_type;
```

**Expected:**
- `agency_profile` ≥ 1 (agent name, agency legal name, SMVC rate, blended rate, agent code, city, state, agency structure)
- `sf_compensation` ≥ 1 (bonus tier structure, AIPP goal)
- `accounting_rules` ≥ 1 (cash basis, PFA compliance-only, S-Corp Medical handling)
- `communication_prefs` ≥ 1 (tone, response style captured during install calls)
- `key_contacts` ≥ 1 (CPA, SF field consultant if identified)
- `financial_context` ≥ 1 (targets, benchmark thresholds)
- `goals` ≥ 1 (annual/quarterly goals discussed during install)

**Minimum bar for handoff:** `agency_profile`, `sf_compensation`, `accounting_rules`, and `communication_prefs` all ≥ 1. Absence of any of these four = install incomplete regardless of what other checks pass.

**If mostly empty:** Setup Technician runs a review conversation with the client's Claude before handoff, capturing everything covered during install into memory. This is a 15-minute fix, not a bootstrap-script re-run.

---

## SECTION 11 · Sanity checks (post-audit smoke test)

Before ending the audit, run these low-risk smoke tests to confirm the system is reachable end-to-end:

### 11.1 Operating context RPC returns

```sql
SELECT get_operating_context('main') IS NOT NULL AS returns_result;
```

**Expected:** `true`. If false or errors, the `get_operating_context` function isn't installed correctly — Base Section 2 migration incomplete.

### 11.2 Income statement view queryable

```sql
SELECT count(*) AS je_line_count FROM public.v_income_statement;
```

**Expected:** Returns without error (result is 0 at fresh install — no journal entries yet, expected).

### 11.3 PTO balance view queryable

```sql
SELECT count(*) AS pto_balance_rows FROM public.v_pto_my_balance;
```

**Expected:** Returns without error. Zero rows is fine (no staff have logged PTO yet).

### 11.4 Upcoming milestones view queryable

```sql
SELECT count(*) AS upcoming FROM public.v_upcoming_milestones;
```

**Expected:** Returns without error. Zero rows is fine at fresh install.

---

## SECTION 12 · Audit summary — REQUIRED output format

At the end of the audit, produce a report in this exact format so the Setup Technician can scan it in 60 seconds:

```
========================================================
PREMIUM BCC INSTALL AUDIT — SUMMARY
========================================================
Client:                    <agency name>
Supabase project:          <project_id>
Audit date:                <YYYY-MM-DD>
Audit doc version:         v1.0
Auditor Claude session:    <first 8 chars of session id if available>

========================================================
OVERALL VERDICT
========================================================
[  ] READY FOR CLIENT HANDOFF (zero critical fails)
[  ] READY WITH CAVEATS      (only non-critical fails)
[  ] NOT READY               (one or more critical fails)

========================================================
CRITICAL CHECKS  (must pass before handoff)
========================================================
Sec 1.1  Repo private + LICENSE.md + collaborator ...... PASS / FAIL
Sec 2.3  rpc_create_pto_request hotfix version ......... PASS / FAIL
Sec 2.3  rpc_edit_pto_request hotfix version ........... PASS / FAIL
Sec 4.3  v_upcoming_milestones computes at milestone .... PASS / FAIL
Sec 6.1  compliance_rules seeded (≥76) ................. PASS / FAIL / count=<n>
Sec 6.4  All 12 automation recipes named ............... PASS / PARTIAL (list missing) / FAIL
Sec 7.1  GROQ_API_KEY set .............................. PASS / FAIL
Sec 8.1  Composio project provisioned .................. PASS / FAIL
Sec 8.3  Service mailbox configured ..................... PASS / FAIL
Sec 9.1  Vercel URL recorded ........................... PASS / FAIL
Sec 10.1 Agency row exists ............................. PASS / FAIL
Sec 10.2 Owner staff row exists ........................ PASS / FAIL
Sec 10.3 Persistent memory taught during install ....... PASS / PARTIAL (list missing categories) / FAIL

========================================================
NON-CRITICAL CHECKS  (nice to have; can be finished during first-week onboarding)
=========================================================
Sec 6.5  Module help drawer content (≥26 modules) ...... PASS / PARTIAL (n of 26)
Sec 8.2  Facebook OAuth ................................ PASS / DEFERRED
Sec 8.2  LinkedIn OAuth ................................ PASS / DEFERRED
Sec 8.2  QuickBooks OAuth .............................. PASS / DEFERRED / N/A
Sec 7.4  Recent automation runs ........................ NOTE: fresh install, revisit at 48h

========================================================
FULL GAP LIST (specific items to hand-fix)
=========================================================
- Sec X.Y: <what failed> — <remediation SQL or action>
- Sec X.Y: <what failed> — <remediation SQL or action>
...

========================================================
SIGN-OFF
========================================================
Setup Technician:          <name>
Client handoff cleared:    YES / NO
Follow-up items assigned:  <ticket/note references>
========================================================
```

---

## Notes for the Setup Technician

- **The most common failure is Section 6.4.** The install-script skip-if-migration-recorded logic has a known bug where seed migrations for `automation_recipes` are recorded as applied but the INSERTs get eaten by `ON CONFLICT DO NOTHING` clauses on subsequent runs. If you see PARTIAL there, hand-seed the missing recipes from the master repo's `supabase/seeds/automation_recipes.sql` file with an explicit `agency_id` for the client.
- **Sec 2.3 hotfixes are non-negotiable.** If either RPC still references `settings.key/value` instead of `setting_key/setting_value`, the first PTO submission by a producer will crash. Do not hand off with these red.
- **If you're unsure whether a "PARTIAL" is acceptable, escalate to Rebecca.** The audit is your best-effort — not a substitute for judgment.
- **Once the client's audit produces a clean PASS**, save the audit report to the client's Google Drive under `BCC/Handoff/AUDIT_<date>.md` for the record. This becomes the baseline for any future support conversation.

---

_Delivered by Imaginary Farms LLC · imaginary-farms.com_
