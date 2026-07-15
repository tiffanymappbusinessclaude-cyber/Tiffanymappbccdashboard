# PREMIUM_SMOKE_TEST.md

**Executable verification walk-through for the full Premium overlay — all ten Producer Isolation modules.**

Setup Claude follows this document at the end of an overlay apply (Step 10 of `OVERLAY_APPLY.md`). Every check must pass before handoff. Rebecca and future maintainers can also re-run this doc as a regression harness after any Premium migration change, design doc revision, or Base master compatibility update.

Overlay version this doc targets: **v0.5.8** (all ten modules shipped; pre-v1.0 audit finding #4 closed).

---

## Preamble — what this doc verifies

Three governance invariants and one per-module happy path, in that order of priority:

1. **Producer Isolation Principle (design doc §B.11)** — every active staff member sees only their own data across all ten modules. Cross-staff visibility is owner-only by default, with per-module opt-in via each module's `is_<module>_manager()` helper. Terminated staff have zero access to any module. **A Producer Isolation failure is worse than a broken feature that fails loudly — data leakage between staff is an immediate install blocker on any module.**
2. **Auto-Provisioning Invariant (design doc §B.12)** — `staff.status='active'` implies an enabled Supabase Auth account; `staff.status='terminated'` implies a disabled one; rehire restores. Migration 100a's trigger enqueues; the recipe from migration 100c + the runner patch drains within 60–90 seconds.
3. **Reveal-audit integrity (Personnel Files + Emergency Contacts)** — every read of a sensitive document or contact record writes an immutable audit row. A silent reveal is a compliance blocker.
4. **Per-module happy path** — each of the ten modules can perform its representative RPC or view call and return the expected shape when the caller has the right role.

If any check fails, stop the smoke test and investigate. Do not hand off with unresolved failures.

**Total test count in this doc: 70.**

| Section | Count | What it verifies |
| --- | --- | --- |
| §A — Auto-Provisioning Invariant (§B.12) | 3 | Enqueue → drain → auth link; termination → auth ban; rehire → auth restore |
| §B — Producer Isolation Principle (§B.11) | 50 | Five gate tests × ten modules |
| §C — Per-module happy paths | 10 | One representative RPC/view per module |
| §D — Reveal-audit integrity | 2 | Personnel Files reveal + Emergency Contacts reveal both write audit log |
| §E — Personnel Files layered gate | 1 | Global gate TRUE alone does not grant per-employee access |
| §F — Compliance-safe schema | 1 | `sales_activity.customer_name` column does not exist |
| §G — Automation recipe smokes | 3 | Auth Provisioner heartbeat + PTO Nightly Accrual + Licenses Expiration Watch |

---

## Role-label convention (read this before running any test)

The overlay's per-module gate helpers (`is_pto_manager()`, `is_time_tracking_manager()`, etc.) do not inspect `staff.role` strings directly — they read the `enable_<module>_manager_access` toggle in `public.settings` plus the caller's staff row. Client role labels are Title Case descriptive strings ("Owner / Agent", "Office Manager", "Licensed Sales Producer", "Customer Service Rep", "Financial Services Specialist"). If your client customized the seeded labels, substitute their labels wherever this doc uses:

- **Owner Test** → the staff row whose role classifies as agency owner (typically "Owner / Agent").
- **Manager Test** → the staff row whose role classifies as manager (typically "Office Manager").
- **Producer A / Producer B** → staff rows whose role classifies as producer (typically "Licensed Sales Producer" or "Customer Service Rep" or "Financial Services Specialist").

The RLS policies use `current_staff_id()` for own-row identification and the module-specific `is_<module>_manager()` helpers for cross-staff opt-in. Role-string edge cases are the client's concern only if they renamed labels — the smoke test's SQL is written to be label-agnostic wherever possible.

---

## Prerequisites

Before running any test in this doc, verify:

```sql
-- 1. All Premium overlay tables present
SELECT to_regclass('public._pending_auth_actions')            AS auth_queue,
       to_regclass('public.time_tracking')                    AS m01_time_tracking,
       to_regclass('public.sales_activity')                   AS m02_sales_activity,
       to_regclass('public.scoreboard_goals')                 AS m03_scoreboard,
       to_regclass('public.pto_policies')                     AS m04_pto_policies,
       to_regclass('public.pto_balances')                     AS m04_pto_balances,
       to_regclass('public.pto_requests')                     AS m04_pto_requests,
       to_regclass('public.handbook_sections')                AS m05_handbook,
       to_regclass('public.handbook_acknowledgments')         AS m05_handbook_acks,
       to_regclass('public.benefit_plans')                    AS m06_benefit_plans,
       to_regclass('public.benefit_enrollments')              AS m06_benefit_enrollments,
       to_regclass('public.personnel_files')                  AS m07_personnel_files,
       to_regclass('public.personnel_documents')              AS m07_personnel_documents,
       to_regclass('public.personnel_document_access_log')    AS m07_access_log,
       to_regclass('public.personnel_file_manager_grants')    AS m07_grants,
       to_regclass('public.producer_licenses')                AS m08_licenses,
       to_regclass('public.milestone_recognitions')           AS m09_milestones,
       to_regclass('public.emergency_contacts')               AS m10_emergency_contacts,
       to_regclass('public.emergency_contact_access_log')     AS m10_ec_access_log;
-- Expect: nineteen non-null values. Any NULL means a migration did not apply cleanly.

-- 2. All ten §B.11 gate helpers present
SELECT proname
  FROM pg_proc
 WHERE proname IN (
   'is_time_tracking_manager',
   'is_sales_activity_manager',
   'is_scoreboard_manager',
   'is_pto_manager',
   'is_handbook_manager',
   'is_benefits_manager',
   'is_personnel_files_manager',
   'is_licenses_manager',
   'is_milestones_manager',
   'is_emergency_contacts_manager'
 )
 ORDER BY proname;
-- Expect: ten rows.

-- 3. All ten §B.11 gate setting toggles seeded
SELECT key, value
  FROM public.settings
 WHERE key IN (
   'enable_time_tracking_manager_access',
   'enable_sales_activity_manager_access',
   'enable_scoreboard_manager_access',
   'enable_pto_manager_access',
   'enable_handbook_manager_access',
   'enable_benefits_manager_access',
   'enable_personnel_files_manager_access',
   'enable_licenses_manager_access',
   'enable_milestones_manager_access',
   'enable_emergency_contacts_manager_access'
 )
 ORDER BY key;
-- Expect: ten rows. Ratified defaults per Appendix B.11:
--   TRUE  → time_tracking, sales_activity, pto, handbook, licenses
--   FALSE → scoreboard, benefits, personnel_files, milestones, emergency_contacts

-- 4. Automation recipes seeded
SELECT recipe_name, cron_expression, is_active
  FROM automation_recipes
 WHERE recipe_name IN (
   'Premium Auth Provisioner',
   'PTO Nightly Accrual',
   'Licenses Expiration Watch'
 )
 ORDER BY recipe_name;
-- Expect: three rows, all is_active=true.
-- Cron cadence:
--   Premium Auth Provisioner   → '* * * * *'  (every minute)
--   PTO Nightly Accrual        → nightly (client-configurable, typically '0 6 * * *')
--   Licenses Expiration Watch  → daily  (client-configurable, typically '0 7 * * *')

-- 5. Runner patch deployed (client's supabase/functions/automation-runner/index.ts)
-- No SQL check — grep the runner file for these three dispatchers:
--   dispatch_premium_auth_provisioner   -> runAuthProvisioner
--   dispatch_pto_nightly_accrual        -> runPTOAccrual
--   dispatch_licenses_expiration_watch  -> runLicensesExpirationWatch
-- If any absent, return to Step 3.5 of OVERLAY_APPLY.md.

-- 6. Personnel Files edge function deployed (Composio Drive bridge)
-- No SQL check — verify client's supabase/functions/personnel-files-upload/ exists
-- and the COMPOSIO_API_KEY secret is set. If absent, return to Step 4.5.

-- 7. NAV_ITEMS in Layout.jsx exposes all ten Premium modules
-- No SQL check — grep client's src/components/Layout.jsx for the ten module labels.
-- If any missing, return to Step 6 of OVERLAY_APPLY.md.
```

Also required for the tests below: **four test users provisioned as auth accounts and linked to staff rows** — one owner, one manager (with role classifying as manager but NOT owner), and two producers (A and B). If your client's staff seed already includes these roles under distinct emails, use those; otherwise, provision test rows now (§A verifies auto-provisioning while creating them).

Reserve these emails for smoke-test staff so cleanup (§Cleanup) can find them:

- `smoke-owner@example.com`
- `smoke-manager@example.com`
- `smoke-producer-a@example.com`
- `smoke-producer-b@example.com`

---

## Section A — Auto-Provisioning Invariant (§B.12)

**Runs from Setup Claude's SQL access to the client's Supabase (service_role).**
**Do not skip these checks — they verify the runner-patch is actually wired.**

### A.1 — Provision on active status (INSERT triggers enqueue + recipe drains within 90s)

```sql
-- Setup: insert a test staff row with status='active'
INSERT INTO public.staff (first_name, last_name, email, role, status, hire_date)
VALUES ('Smoke', 'Producer A', 'smoke-producer-a@example.com',
        'Licensed Sales Producer', 'active', CURRENT_DATE - INTERVAL '90 days');

-- Immediate check: queue row was enqueued by the trigger
SELECT action_type, staff_email, status, retry_count
  FROM public._pending_auth_actions
 WHERE staff_email = 'smoke-producer-a@example.com';
-- Expect: one row, action_type='provision', status='pending', retry_count=0.

-- Wait 60–90 seconds for the pg_cron heartbeat + runner tick to drain the queue.
-- Then verify:
SELECT s.email,
       s.auth_user_id IS NOT NULL                  AS auth_linked,
       a.processed_by,
       a.process_result->>'success'                AS success,
       a.process_result->>'summary'                AS summary
  FROM public.staff s
  LEFT JOIN public._pending_auth_actions a
    ON a.staff_id = s.id AND a.action_type = 'provision'
 WHERE s.email = 'smoke-producer-a@example.com';
-- Expect: auth_linked=true, processed_by='premium_auth_provisioner', success='true'.
-- summary should be one of: 'provisioned' (new user) or 'provisioned-via-lookup' (422 fallback,
-- confirming the recipe fetched an existing auth user id rather than erroring).
-- The staff row's email should have received an invite from Supabase Auth.
```

- **Fail signals:** queue row never enqueued (trigger broken) · queue row still `pending` after 90s (recipe not dispatching, runner patch missing) · `success='false'` with a non-422 error in `process_result` (Auth admin API issue).

Repeat this pattern for `smoke-producer-b@example.com`, `smoke-manager@example.com` ('Office Manager'), and `smoke-owner@example.com` ('Owner / Agent'). Confirm all four staff rows finish with `auth_linked=true` before proceeding to §A.2.

### A.2 — Revoke on termination (Auth account disabled within 90s)

```sql
UPDATE public.staff
   SET status = 'terminated'
 WHERE email = 'smoke-producer-a@example.com';

-- Immediate check: queue row enqueued
SELECT action_type, status FROM public._pending_auth_actions
 WHERE staff_email = 'smoke-producer-a@example.com'
   AND action_type = 'revoke'
 ORDER BY created_at DESC
 LIMIT 1;
-- Expect: one row, action_type='revoke', status='pending'.

-- Wait 60–90s.
SELECT status, process_result->>'success' AS success
  FROM public._pending_auth_actions
 WHERE staff_email = 'smoke-producer-a@example.com'
   AND action_type = 'revoke'
 ORDER BY created_at DESC LIMIT 1;
-- Expect: status='processed', success='true'.
```

Now attempt to log in as `smoke-producer-a@example.com` in a fresh browser session.

- **Expected:** login fails with "Invalid login credentials" or "User is banned" — Supabase Auth ban is active.
- **Fail signal:** login succeeds → auth revoke did not fire, the client is exposed to terminated-staff access. Immediate install blocker.

### A.3 — Restore on rehire (Auth account re-enabled within 90s)

```sql
UPDATE public.staff
   SET status = 'active'
 WHERE email = 'smoke-producer-a@example.com';

-- Immediate check
SELECT action_type, status FROM public._pending_auth_actions
 WHERE staff_email = 'smoke-producer-a@example.com'
   AND action_type = 'restore'
 ORDER BY created_at DESC LIMIT 1;
-- Expect: one row, action_type='restore', status='pending'.

-- Wait 60–90s.
SELECT status, process_result->>'success' AS success
  FROM public._pending_auth_actions
 WHERE staff_email = 'smoke-producer-a@example.com'
   AND action_type = 'restore'
 ORDER BY created_at DESC LIMIT 1;
-- Expect: status='processed', success='true'.
```

Now attempt to log in as `smoke-producer-a@example.com` again.

- **Expected:** login succeeds; user lands on the appropriate role-aware dashboard.
- **Fail signal:** login still fails → restore action did not clear the ban.

---

## Section B — Producer Isolation Principle (§B.11)

**These are the highest-severity checks in this document. RLS enforces at the row level; the tests here PROVE it works from an authenticated-user standpoint across every Premium module.**

**Cannot be verified from Setup Claude's service_role connection alone.** These checks require running queries as different users through the app's `supabase-js` client (browser DevTools console is easiest) or via a SQL client configured with the anon key plus that user's JWT. Provision the four test users first (Owner Test, Manager Test, Producer A, Producer B) per §A before entering this section.

Each of the ten modules gets the same five-test governance check:

1. **Producer sees own row** — Producer A can read their own row from the module's primary table.
2. **Producer cannot see other producer's row** — Producer A cannot leak Producer B's row via direct SQL.
3. **Manager visibility with gate in default state** — Manager Test sees the correct scope given the ratified default value of `enable_<module>_manager_access`.
4. **Manager visibility with gate flipped** — Flipping the toggle inverts the manager's visibility.
5. **Owner sees all** — Owner Test always sees every row regardless of gate.

**Ratified §B.11 defaults (per Appendix B.11):**

- TRUE  → M01 Time Tracking · M02 Sales Activity · M04 PTO · M05 Handbook · M08 Licenses
- FALSE → M03 Scoreboard · M06 Benefits · M07 Personnel Files · M09 Milestones · M10 Emergency Contacts

Failure signals across all fifty checks:

- Test 1 returns zero rows → own-row RLS is broken (module surface will be empty for the producer).
- Test 2 returns any rows → **data leak between producers — immediate install blocker**.
- Test 3 or 4 reads the wrong scope → gate helper logic is inverted or the setting toggle is not wired.
- Test 5 returns fewer than two rows (with two producer rows seeded) → owner cannot see the fleet — reporting will be broken.

**Before running any §B.M** test, run the corresponding Seed block for that module. Seed blocks are module-specific because the ten primary tables have different NOT NULL columns, unique constraints, and upstream dependencies (e.g., M06 requires a `benefit_plans` row to reference). Substitute `<producer_a_staff_id>` and `<producer_b_staff_id>` with the actual UUIDs of the test staff rows created in §A.1.

---

### B.M01 — Time Tracking (§B.11 default: TRUE)

Gate helper: `is_time_tracking_manager()` · Setting key: `enable_time_tracking_manager_access` (default `true`)

Primary isolation table for this module: `public.time_tracking` (isolation column: `producer_id`).

#### Seed

```sql
-- Run as service_role. Seed one representative row per test producer.
-- Trigger enforces producer_id / agency_id alignment, so agency_id derives from the staff row.
INSERT INTO public.time_tracking
  (producer_id, agency_id, entry_date, hours, activity_category, notes)
VALUES
  ('<producer_a_staff_id>',
   (SELECT agency_id FROM public.staff WHERE id = '<producer_a_staff_id>'),
   CURRENT_DATE, 1.0, 'training', 'M01 smoke test row for Producer A'),
  ('<producer_b_staff_id>',
   (SELECT agency_id FROM public.staff WHERE id = '<producer_b_staff_id>'),
   CURRENT_DATE, 1.0, 'training', 'M01 smoke test row for Producer B');
```

#### B.M01.1 — Producer sees own row

Run as **Producer A** (browser DevTools console or JWT-authenticated SQL client):

```sql
SELECT count(*) FROM public.time_tracking WHERE producer_id = current_staff_id();
-- Expect: >= 1 (Producer A's seeded row).
```

- **Fail signal:** zero rows → own-row RLS broken. The Producer A UI for Time Tracking will render empty even though data exists.

#### B.M01.2 — Producer cannot see other producer's row

Run as **Producer A**:

```sql
SELECT count(*) FROM public.time_tracking WHERE producer_id = '<producer_b_staff_id>';
-- Expect: 0.

-- Also verify the general leak-check pattern:
SELECT count(*) FROM public.time_tracking WHERE producer_id <> current_staff_id();
-- Expect: 0.
```

- **Fail signal:** any non-zero count → **cross-producer data leak on M01 Time Tracking. Immediate install blocker.**

#### B.M01.3 — Manager visibility with gate in default state (TRUE)

The ratified default for `enable_time_tracking_manager_access` is `true`. Confirm the setting is at its default:

```sql
-- As service_role:
SELECT value FROM public.settings WHERE key = 'enable_time_tracking_manager_access';
-- Expect: 'true'. If not, restore before running the check.
```

Run as **Manager Test**:

```sql
SELECT count(*) FROM public.time_tracking;
-- Manager sees ALL rows: the default toggle value is `true`, so `is_time_tracking_manager()` returns true for the manager and RLS lets them read every row.
-- Expect: count >= 2 (both producer rows visible).
```

- **Fail signal:** manager visibility does not match the description above.

#### B.M01.4 — Manager visibility with gate flipped

```sql
-- As service_role: flip the toggle.
UPDATE public.settings SET value = 'false' WHERE key = 'enable_time_tracking_manager_access';
```

Run as **Manager Test** (may require re-fetching the setting client-side or re-authenticating, depending on the app's caching):

```sql
SELECT count(*) FROM public.time_tracking;
-- Manager sees only OWN row: flipping to `false` should collapse manager visibility to the manager's own row(s) — no other staff data.
-- Expect: count = manager's own rows only (0 unless the manager was seeded a row too).
```

- **Fail signal:** flipping the toggle did not change manager visibility → `is_time_tracking_manager()` is not reading `enable_time_tracking_manager_access` correctly.

Restore the default:

```sql
UPDATE public.settings SET value = 'true' WHERE key = 'enable_time_tracking_manager_access';
```

#### B.M01.5 — Owner sees all

Run as **Owner Test**:

```sql
SELECT count(*) FROM public.time_tracking;
-- Expect: >= 2 (every seeded row across all staff, regardless of gate toggle).
```

- **Fail signal:** owner sees fewer rows than exist → owner-visibility RLS is broken. Owner reports and dashboards will underrepresent fleet activity.

#### Cleanup for M01

```sql
DELETE FROM public.time_tracking
 WHERE notes IN ('M01 smoke test row for Producer A',
                 'M01 smoke test row for Producer B');
```

---

### B.M02 — Sales Activity (§B.11 default: TRUE)

Gate helper: `is_sales_activity_manager()` · Setting key: `enable_sales_activity_manager_access` (default `true`)

Primary isolation table for this module: `public.sales_activity` (isolation column: `producer_id`).

#### Seed

```sql
-- Run as service_role. Trigger enforces producer_id / agency_id alignment.
INSERT INTO public.sales_activity
  (producer_id, agency_id, activity_date, activity_type, line_of_business, outcome, notes)
VALUES
  ('<producer_a_staff_id>',
   (SELECT agency_id FROM public.staff WHERE id = '<producer_a_staff_id>'),
   CURRENT_DATE, 'quote_issued', 'auto', 'pending',
   'M02 smoke test row for Producer A'),
  ('<producer_b_staff_id>',
   (SELECT agency_id FROM public.staff WHERE id = '<producer_b_staff_id>'),
   CURRENT_DATE, 'quote_issued', 'auto', 'pending',
   'M02 smoke test row for Producer B');
```

#### B.M02.1 — Producer sees own row

Run as **Producer A** (browser DevTools console or JWT-authenticated SQL client):

```sql
SELECT count(*) FROM public.sales_activity WHERE producer_id = current_staff_id();
-- Expect: >= 1 (Producer A's seeded row).
```

- **Fail signal:** zero rows → own-row RLS broken. The Producer A UI for Sales Activity will render empty even though data exists.

#### B.M02.2 — Producer cannot see other producer's row

Run as **Producer A**:

```sql
SELECT count(*) FROM public.sales_activity WHERE producer_id = '<producer_b_staff_id>';
-- Expect: 0.

-- Also verify the general leak-check pattern:
SELECT count(*) FROM public.sales_activity WHERE producer_id <> current_staff_id();
-- Expect: 0.
```

- **Fail signal:** any non-zero count → **cross-producer data leak on M02 Sales Activity. Immediate install blocker.**

#### B.M02.3 — Manager visibility with gate in default state (TRUE)

The ratified default for `enable_sales_activity_manager_access` is `true`. Confirm the setting is at its default:

```sql
-- As service_role:
SELECT value FROM public.settings WHERE key = 'enable_sales_activity_manager_access';
-- Expect: 'true'. If not, restore before running the check.
```

Run as **Manager Test**:

```sql
SELECT count(*) FROM public.sales_activity;
-- Manager sees ALL rows: the default toggle value is `true`, so `is_sales_activity_manager()` returns true for the manager and RLS lets them read every row.
-- Expect: count >= 2 (both producer rows visible).
```

- **Fail signal:** manager visibility does not match the description above.

#### B.M02.4 — Manager visibility with gate flipped

```sql
-- As service_role: flip the toggle.
UPDATE public.settings SET value = 'false' WHERE key = 'enable_sales_activity_manager_access';
```

Run as **Manager Test** (may require re-fetching the setting client-side or re-authenticating, depending on the app's caching):

```sql
SELECT count(*) FROM public.sales_activity;
-- Manager sees only OWN row: flipping to `false` should collapse manager visibility to the manager's own row(s) — no other staff data.
-- Expect: count = manager's own rows only (0 unless the manager was seeded a row too).
```

- **Fail signal:** flipping the toggle did not change manager visibility → `is_sales_activity_manager()` is not reading `enable_sales_activity_manager_access` correctly.

Restore the default:

```sql
UPDATE public.settings SET value = 'true' WHERE key = 'enable_sales_activity_manager_access';
```

#### B.M02.5 — Owner sees all

Run as **Owner Test**:

```sql
SELECT count(*) FROM public.sales_activity;
-- Expect: >= 2 (every seeded row across all staff, regardless of gate toggle).
```

- **Fail signal:** owner sees fewer rows than exist → owner-visibility RLS is broken. Owner reports and dashboards will underrepresent fleet activity.

#### Cleanup for M02

```sql
DELETE FROM public.sales_activity
 WHERE notes IN ('M02 smoke test row for Producer A',
                 'M02 smoke test row for Producer B');
```

---

### B.M03 — Scoreboard (§B.11 default: FALSE)

> **Module-specific note.** Individual goal rows are producer-scoped; agency-wide totals are aggregated by view without names.

Gate helper: `is_scoreboard_manager()` · Setting key: `enable_scoreboard_manager_access` (default `false`)

Primary isolation table for this module: `public.scoreboard_goals` (isolation column: `producer_id`).

#### Seed

```sql
-- Run as service_role. producer_id is nullable in this table (agency-wide goals use NULL);
-- for the isolation test we set it to each producer's staff.id.
INSERT INTO public.scoreboard_goals
  (agency_id, producer_id, goal_period, goal_type, target_value,
   period_start, period_end, notes)
VALUES
  ((SELECT agency_id FROM public.staff WHERE id = '<producer_a_staff_id>'),
   '<producer_a_staff_id>',
   'monthly', 'total_binds', 10,
   date_trunc('month', CURRENT_DATE)::date,
   (date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day')::date,
   'M03 smoke test row for Producer A'),
  ((SELECT agency_id FROM public.staff WHERE id = '<producer_b_staff_id>'),
   '<producer_b_staff_id>',
   'monthly', 'total_binds', 10,
   date_trunc('month', CURRENT_DATE)::date,
   (date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day')::date,
   'M03 smoke test row for Producer B');
```

#### B.M03.1 — Producer sees own row

Run as **Producer A** (browser DevTools console or JWT-authenticated SQL client):

```sql
SELECT count(*) FROM public.scoreboard_goals WHERE producer_id = current_staff_id();
-- Expect: >= 1 (Producer A's seeded row).
```

- **Fail signal:** zero rows → own-row RLS broken. The Producer A UI for Scoreboard will render empty even though data exists.

#### B.M03.2 — Producer cannot see other producer's row

Run as **Producer A**:

```sql
SELECT count(*) FROM public.scoreboard_goals WHERE producer_id = '<producer_b_staff_id>';
-- Expect: 0.

-- Also verify the general leak-check pattern:
SELECT count(*) FROM public.scoreboard_goals WHERE producer_id <> current_staff_id();
-- Expect: 0.
```

- **Fail signal:** any non-zero count → **cross-producer data leak on M03 Scoreboard. Immediate install blocker.**

#### B.M03.3 — Manager visibility with gate in default state (FALSE)

The ratified default for `enable_scoreboard_manager_access` is `false`. Confirm the setting is at its default:

```sql
-- As service_role:
SELECT value FROM public.settings WHERE key = 'enable_scoreboard_manager_access';
-- Expect: 'false'. If not, restore before running the check.
```

Run as **Manager Test**:

```sql
SELECT count(*) FROM public.scoreboard_goals;
-- Manager sees only OWN row: the default toggle value is `false`, so `is_scoreboard_manager()` returns false for the manager and RLS treats them like a producer.
-- Expect: count = manager's own rows only (0 unless the manager was seeded a row too).
```

- **Fail signal:** manager visibility does not match the description above.

#### B.M03.4 — Manager visibility with gate flipped

```sql
-- As service_role: flip the toggle.
UPDATE public.settings SET value = 'true' WHERE key = 'enable_scoreboard_manager_access';
```

Run as **Manager Test** (may require re-fetching the setting client-side or re-authenticating, depending on the app's caching):

```sql
SELECT count(*) FROM public.scoreboard_goals;
-- Manager sees ALL rows: flipping to `true` should expand manager visibility to every row across all staff.
-- Expect: count >= 2 (all producer rows visible).
```

- **Fail signal:** flipping the toggle did not change manager visibility → `is_scoreboard_manager()` is not reading `enable_scoreboard_manager_access` correctly.

Restore the default:

```sql
UPDATE public.settings SET value = 'false' WHERE key = 'enable_scoreboard_manager_access';
```

#### B.M03.5 — Owner sees all

Run as **Owner Test**:

```sql
SELECT count(*) FROM public.scoreboard_goals;
-- Expect: >= 2 (every seeded row across all staff, regardless of gate toggle).
```

- **Fail signal:** owner sees fewer rows than exist → owner-visibility RLS is broken. Owner reports and dashboards will underrepresent fleet activity.

#### Cleanup for M03

```sql
DELETE FROM public.scoreboard_goals
 WHERE notes IN ('M03 smoke test row for Producer A',
                 'M03 smoke test row for Producer B');
```

---

### B.M04 — Premium PTO (§B.11 default: TRUE)

Gate helper: `is_pto_manager()` · Setting key: `enable_pto_manager_access` (default `true`)

Primary isolation table for this module: `public.pto_balances` (isolation column: `staff_id`).

#### Seed

```sql
-- Run as service_role. policy_id is nullable in pto_balances so we omit it;
-- balance_days / accrued_this_period / used_this_period all default to 0.
INSERT INTO public.pto_balances
  (staff_id, period_start, period_end, notes)
VALUES
  ('<producer_a_staff_id>',
   date_trunc('year', CURRENT_DATE)::date,
   (date_trunc('year', CURRENT_DATE) + interval '1 year - 1 day')::date,
   'M04 smoke test row for Producer A'),
  ('<producer_b_staff_id>',
   date_trunc('year', CURRENT_DATE)::date,
   (date_trunc('year', CURRENT_DATE) + interval '1 year - 1 day')::date,
   'M04 smoke test row for Producer B');
```

#### B.M04.1 — Producer sees own row

Run as **Producer A** (browser DevTools console or JWT-authenticated SQL client):

```sql
SELECT count(*) FROM public.pto_balances WHERE staff_id = current_staff_id();
-- Expect: >= 1 (Producer A's seeded row).
```

- **Fail signal:** zero rows → own-row RLS broken. The Producer A UI for Premium PTO will render empty even though data exists.

#### B.M04.2 — Producer cannot see other producer's row

Run as **Producer A**:

```sql
SELECT count(*) FROM public.pto_balances WHERE staff_id = '<producer_b_staff_id>';
-- Expect: 0.

-- Also verify the general leak-check pattern:
SELECT count(*) FROM public.pto_balances WHERE staff_id <> current_staff_id();
-- Expect: 0.
```

- **Fail signal:** any non-zero count → **cross-producer data leak on M04 Premium PTO. Immediate install blocker.**

#### B.M04.3 — Manager visibility with gate in default state (TRUE)

The ratified default for `enable_pto_manager_access` is `true`. Confirm the setting is at its default:

```sql
-- As service_role:
SELECT value FROM public.settings WHERE key = 'enable_pto_manager_access';
-- Expect: 'true'. If not, restore before running the check.
```

Run as **Manager Test**:

```sql
SELECT count(*) FROM public.pto_balances;
-- Manager sees ALL rows: the default toggle value is `true`, so `is_pto_manager()` returns true for the manager and RLS lets them read every row.
-- Expect: count >= 2 (both producer rows visible).
```

- **Fail signal:** manager visibility does not match the description above.

#### B.M04.4 — Manager visibility with gate flipped

```sql
-- As service_role: flip the toggle.
UPDATE public.settings SET value = 'false' WHERE key = 'enable_pto_manager_access';
```

Run as **Manager Test** (may require re-fetching the setting client-side or re-authenticating, depending on the app's caching):

```sql
SELECT count(*) FROM public.pto_balances;
-- Manager sees only OWN row: flipping to `false` should collapse manager visibility to the manager's own row(s) — no other staff data.
-- Expect: count = manager's own rows only (0 unless the manager was seeded a row too).
```

- **Fail signal:** flipping the toggle did not change manager visibility → `is_pto_manager()` is not reading `enable_pto_manager_access` correctly.

Restore the default:

```sql
UPDATE public.settings SET value = 'true' WHERE key = 'enable_pto_manager_access';
```

#### B.M04.5 — Owner sees all

Run as **Owner Test**:

```sql
SELECT count(*) FROM public.pto_balances;
-- Expect: >= 2 (every seeded row across all staff, regardless of gate toggle).
```

- **Fail signal:** owner sees fewer rows than exist → owner-visibility RLS is broken. Owner reports and dashboards will underrepresent fleet activity.

#### Cleanup for M04

```sql
DELETE FROM public.pto_balances
 WHERE notes IN ('M04 smoke test row for Producer A',
                 'M04 smoke test row for Producer B');
```

---

### B.M05 — Handbook (§B.11 default: TRUE)

> **Module-specific note.** `handbook_sections` itself is agency-wide (all active staff read current version).

Gate helper: `is_handbook_manager()` · Setting key: `enable_handbook_manager_access` (default `true`)

Primary isolation table for this module: `public.handbook_acknowledgments` (isolation column: `staff_id`).

#### Seed

```sql
-- Run as service_role. This table has no `notes` column — cleanup uses a
-- distinctive handbook_version sentinel (99999) to identify smoke rows.
INSERT INTO public.handbook_acknowledgments
  (agency_id, staff_id, handbook_version, acknowledged_at)
VALUES
  ((SELECT agency_id FROM public.staff WHERE id = '<producer_a_staff_id>'),
   '<producer_a_staff_id>', 99999, now()),
  ((SELECT agency_id FROM public.staff WHERE id = '<producer_b_staff_id>'),
   '<producer_b_staff_id>', 99999, now());
```

#### B.M05.1 — Producer sees own row

Run as **Producer A** (browser DevTools console or JWT-authenticated SQL client):

```sql
SELECT count(*) FROM public.handbook_acknowledgments WHERE staff_id = current_staff_id();
-- Expect: >= 1 (Producer A's seeded row).
```

- **Fail signal:** zero rows → own-row RLS broken. The Producer A UI for Handbook will render empty even though data exists.

#### B.M05.2 — Producer cannot see other producer's row

Run as **Producer A**:

```sql
SELECT count(*) FROM public.handbook_acknowledgments WHERE staff_id = '<producer_b_staff_id>';
-- Expect: 0.

-- Also verify the general leak-check pattern:
SELECT count(*) FROM public.handbook_acknowledgments WHERE staff_id <> current_staff_id();
-- Expect: 0.
```

- **Fail signal:** any non-zero count → **cross-producer data leak on M05 Handbook. Immediate install blocker.**

#### B.M05.3 — Manager visibility with gate in default state (TRUE)

The ratified default for `enable_handbook_manager_access` is `true`. Confirm the setting is at its default:

```sql
-- As service_role:
SELECT value FROM public.settings WHERE key = 'enable_handbook_manager_access';
-- Expect: 'true'. If not, restore before running the check.
```

Run as **Manager Test**:

```sql
SELECT count(*) FROM public.handbook_acknowledgments;
-- Manager sees ALL rows: the default toggle value is `true`, so `is_handbook_manager()` returns true for the manager and RLS lets them read every row.
-- Expect: count >= 2 (both producer rows visible).
```

- **Fail signal:** manager visibility does not match the description above.

#### B.M05.4 — Manager visibility with gate flipped

```sql
-- As service_role: flip the toggle.
UPDATE public.settings SET value = 'false' WHERE key = 'enable_handbook_manager_access';
```

Run as **Manager Test** (may require re-fetching the setting client-side or re-authenticating, depending on the app's caching):

```sql
SELECT count(*) FROM public.handbook_acknowledgments;
-- Manager sees only OWN row: flipping to `false` should collapse manager visibility to the manager's own row(s) — no other staff data.
-- Expect: count = manager's own rows only (0 unless the manager was seeded a row too).
```

- **Fail signal:** flipping the toggle did not change manager visibility → `is_handbook_manager()` is not reading `enable_handbook_manager_access` correctly.

Restore the default:

```sql
UPDATE public.settings SET value = 'true' WHERE key = 'enable_handbook_manager_access';
```

#### B.M05.5 — Owner sees all

Run as **Owner Test**:

```sql
SELECT count(*) FROM public.handbook_acknowledgments;
-- Expect: >= 2 (every seeded row across all staff, regardless of gate toggle).
```

- **Fail signal:** owner sees fewer rows than exist → owner-visibility RLS is broken. Owner reports and dashboards will underrepresent fleet activity.

#### Cleanup for M05

```sql
DELETE FROM public.handbook_acknowledgments
 WHERE handbook_version = 99999;
```

---

### B.M06 — Benefits (§B.11 default: FALSE)

> **Module-specific note.** `benefit_plans` is agency-wide (all active staff can list active plans).

Gate helper: `is_benefits_manager()` · Setting key: `enable_benefits_manager_access` (default `false`)

Primary isolation table for this module: `public.benefit_enrollments` (isolation column: `staff_id`).

#### Seed

```sql
-- Run as service_role. benefit_enrollments requires a plan_id NOT NULL
-- referencing benefit_plans. Ensure a smoke-test plan exists first.
INSERT INTO public.benefit_plans
  (agency_id, plan_name, plan_type, carrier, effective_date, is_active)
VALUES
  ((SELECT agency_id FROM public.staff WHERE id = '<producer_a_staff_id>'),
   'M06 Smoke Test Plan', 'medical', 'Smoke Carrier',
   CURRENT_DATE - INTERVAL '30 days', true)
ON CONFLICT DO NOTHING;

WITH smoke_plan AS (
  SELECT id FROM public.benefit_plans
   WHERE plan_name = 'M06 Smoke Test Plan'
   ORDER BY created_at DESC LIMIT 1
)
INSERT INTO public.benefit_enrollments
  (agency_id, staff_id, plan_id, enrollment_tier, election_amount,
   effective_date, notes)
VALUES
  ((SELECT agency_id FROM public.staff WHERE id = '<producer_a_staff_id>'),
   '<producer_a_staff_id>',
   (SELECT id FROM smoke_plan),
   'employee_only', 0, CURRENT_DATE,
   'M06 smoke test row for Producer A'),
  ((SELECT agency_id FROM public.staff WHERE id = '<producer_b_staff_id>'),
   '<producer_b_staff_id>',
   (SELECT id FROM smoke_plan),
   'employee_only', 0, CURRENT_DATE,
   'M06 smoke test row for Producer B');
```

#### B.M06.1 — Producer sees own row

Run as **Producer A** (browser DevTools console or JWT-authenticated SQL client):

```sql
SELECT count(*) FROM public.benefit_enrollments WHERE staff_id = current_staff_id();
-- Expect: >= 1 (Producer A's seeded row).
```

- **Fail signal:** zero rows → own-row RLS broken. The Producer A UI for Benefits will render empty even though data exists.

#### B.M06.2 — Producer cannot see other producer's row

Run as **Producer A**:

```sql
SELECT count(*) FROM public.benefit_enrollments WHERE staff_id = '<producer_b_staff_id>';
-- Expect: 0.

-- Also verify the general leak-check pattern:
SELECT count(*) FROM public.benefit_enrollments WHERE staff_id <> current_staff_id();
-- Expect: 0.
```

- **Fail signal:** any non-zero count → **cross-producer data leak on M06 Benefits. Immediate install blocker.**

#### B.M06.3 — Manager visibility with gate in default state (FALSE)

The ratified default for `enable_benefits_manager_access` is `false`. Confirm the setting is at its default:

```sql
-- As service_role:
SELECT value FROM public.settings WHERE key = 'enable_benefits_manager_access';
-- Expect: 'false'. If not, restore before running the check.
```

Run as **Manager Test**:

```sql
SELECT count(*) FROM public.benefit_enrollments;
-- Manager sees only OWN row: the default toggle value is `false`, so `is_benefits_manager()` returns false for the manager and RLS treats them like a producer.
-- Expect: count = manager's own rows only (0 unless the manager was seeded a row too).
```

- **Fail signal:** manager visibility does not match the description above.

#### B.M06.4 — Manager visibility with gate flipped

```sql
-- As service_role: flip the toggle.
UPDATE public.settings SET value = 'true' WHERE key = 'enable_benefits_manager_access';
```

Run as **Manager Test** (may require re-fetching the setting client-side or re-authenticating, depending on the app's caching):

```sql
SELECT count(*) FROM public.benefit_enrollments;
-- Manager sees ALL rows: flipping to `true` should expand manager visibility to every row across all staff.
-- Expect: count >= 2 (all producer rows visible).
```

- **Fail signal:** flipping the toggle did not change manager visibility → `is_benefits_manager()` is not reading `enable_benefits_manager_access` correctly.

Restore the default:

```sql
UPDATE public.settings SET value = 'false' WHERE key = 'enable_benefits_manager_access';
```

#### B.M06.5 — Owner sees all

Run as **Owner Test**:

```sql
SELECT count(*) FROM public.benefit_enrollments;
-- Expect: >= 2 (every seeded row across all staff, regardless of gate toggle).
```

- **Fail signal:** owner sees fewer rows than exist → owner-visibility RLS is broken. Owner reports and dashboards will underrepresent fleet activity.

#### Cleanup for M06

```sql
DELETE FROM public.benefit_enrollments
 WHERE notes IN ('M06 smoke test row for Producer A',
                 'M06 smoke test row for Producer B');
DELETE FROM public.benefit_plans WHERE plan_name = 'M06 Smoke Test Plan';
```

---

### B.M07 — Personnel Files (§B.11 default: FALSE)

> **Module-specific note.** Layered gate applies — see §E for the per-employee grant test.

Gate helper: `is_personnel_files_manager()` · Setting key: `enable_personnel_files_manager_access` (default `false`)

Primary isolation table for this module: `public.personnel_files` (isolation column: `staff_id`).

#### Seed

```sql
-- Run as service_role. UNIQUE (agency_id, staff_id) means one file per staff per agency.
INSERT INTO public.personnel_files
  (agency_id, staff_id, notes)
VALUES
  ((SELECT agency_id FROM public.staff WHERE id = '<producer_a_staff_id>'),
   '<producer_a_staff_id>',
   'M07 smoke test row for Producer A'),
  ((SELECT agency_id FROM public.staff WHERE id = '<producer_b_staff_id>'),
   '<producer_b_staff_id>',
   'M07 smoke test row for Producer B')
ON CONFLICT (agency_id, staff_id) DO UPDATE
   SET notes = EXCLUDED.notes;
```

#### B.M07.1 — Producer sees own row

Run as **Producer A** (browser DevTools console or JWT-authenticated SQL client):

```sql
SELECT count(*) FROM public.personnel_files WHERE staff_id = current_staff_id();
-- Expect: >= 1 (Producer A's seeded row).
```

- **Fail signal:** zero rows → own-row RLS broken. The Producer A UI for Personnel Files will render empty even though data exists.

#### B.M07.2 — Producer cannot see other producer's row

Run as **Producer A**:

```sql
SELECT count(*) FROM public.personnel_files WHERE staff_id = '<producer_b_staff_id>';
-- Expect: 0.

-- Also verify the general leak-check pattern:
SELECT count(*) FROM public.personnel_files WHERE staff_id <> current_staff_id();
-- Expect: 0.
```

- **Fail signal:** any non-zero count → **cross-producer data leak on M07 Personnel Files. Immediate install blocker.**

#### B.M07.3 — Manager visibility with gate in default state (FALSE)

The ratified default for `enable_personnel_files_manager_access` is `false`. Confirm the setting is at its default:

```sql
-- As service_role:
SELECT value FROM public.settings WHERE key = 'enable_personnel_files_manager_access';
-- Expect: 'false'. If not, restore before running the check.
```

Run as **Manager Test**:

```sql
SELECT count(*) FROM public.personnel_files;
-- Manager sees only OWN row: the default toggle value is `false`, so `is_personnel_files_manager()` returns false for the manager and RLS treats them like a producer.
-- Expect: count = manager's own rows only (0 unless the manager was seeded a row too).
```

- **Fail signal:** manager visibility does not match the description above.

#### B.M07.4 — Manager visibility with gate flipped

```sql
-- As service_role: flip the toggle.
UPDATE public.settings SET value = 'true' WHERE key = 'enable_personnel_files_manager_access';
```

Run as **Manager Test** (may require re-fetching the setting client-side or re-authenticating, depending on the app's caching):

```sql
SELECT count(*) FROM public.personnel_files;
-- Manager sees ALL rows: flipping to `true` should expand manager visibility to every row across all staff.
-- Expect: count >= 2 (all producer rows visible).
```

- **Fail signal:** flipping the toggle did not change manager visibility → `is_personnel_files_manager()` is not reading `enable_personnel_files_manager_access` correctly.

Restore the default:

```sql
UPDATE public.settings SET value = 'false' WHERE key = 'enable_personnel_files_manager_access';
```

#### B.M07.5 — Owner sees all

Run as **Owner Test**:

```sql
SELECT count(*) FROM public.personnel_files;
-- Expect: >= 2 (every seeded row across all staff, regardless of gate toggle).
```

- **Fail signal:** owner sees fewer rows than exist → owner-visibility RLS is broken. Owner reports and dashboards will underrepresent fleet activity.

#### Cleanup for M07

```sql
DELETE FROM public.personnel_files
 WHERE notes IN ('M07 smoke test row for Producer A',
                 'M07 smoke test row for Producer B');
```

---

### B.M08 — Premium Licenses (§B.11 default: TRUE)

Gate helper: `is_licenses_manager()` · Setting key: `enable_licenses_manager_access` (default `true`)

Primary isolation table for this module: `public.producer_licenses` (isolation column: `staff_id`).

#### Seed

```sql
-- Run as service_role. UNIQUE (staff_id, license_type, state) — using distinct
-- license_type per producer avoids the constraint. license_number can be any string.
INSERT INTO public.producer_licenses
  (staff_id, license_type, license_number, state, expiration_date, status, notes)
VALUES
  ('<producer_a_staff_id>', 'p_c', 'SMK-A', 'FL',
   CURRENT_DATE + INTERVAL '365 days', 'active',
   'M08 smoke test row for Producer A'),
  ('<producer_b_staff_id>', 'p_c', 'SMK-B', 'FL',
   CURRENT_DATE + INTERVAL '365 days', 'active',
   'M08 smoke test row for Producer B');
```

#### B.M08.1 — Producer sees own row

Run as **Producer A** (browser DevTools console or JWT-authenticated SQL client):

```sql
SELECT count(*) FROM public.producer_licenses WHERE staff_id = current_staff_id();
-- Expect: >= 1 (Producer A's seeded row).
```

- **Fail signal:** zero rows → own-row RLS broken. The Producer A UI for Premium Licenses will render empty even though data exists.

#### B.M08.2 — Producer cannot see other producer's row

Run as **Producer A**:

```sql
SELECT count(*) FROM public.producer_licenses WHERE staff_id = '<producer_b_staff_id>';
-- Expect: 0.

-- Also verify the general leak-check pattern:
SELECT count(*) FROM public.producer_licenses WHERE staff_id <> current_staff_id();
-- Expect: 0.
```

- **Fail signal:** any non-zero count → **cross-producer data leak on M08 Premium Licenses. Immediate install blocker.**

#### B.M08.3 — Manager visibility with gate in default state (TRUE)

The ratified default for `enable_licenses_manager_access` is `true`. Confirm the setting is at its default:

```sql
-- As service_role:
SELECT value FROM public.settings WHERE key = 'enable_licenses_manager_access';
-- Expect: 'true'. If not, restore before running the check.
```

Run as **Manager Test**:

```sql
SELECT count(*) FROM public.producer_licenses;
-- Manager sees ALL rows: the default toggle value is `true`, so `is_licenses_manager()` returns true for the manager and RLS lets them read every row.
-- Expect: count >= 2 (both producer rows visible).
```

- **Fail signal:** manager visibility does not match the description above.

#### B.M08.4 — Manager visibility with gate flipped

```sql
-- As service_role: flip the toggle.
UPDATE public.settings SET value = 'false' WHERE key = 'enable_licenses_manager_access';
```

Run as **Manager Test** (may require re-fetching the setting client-side or re-authenticating, depending on the app's caching):

```sql
SELECT count(*) FROM public.producer_licenses;
-- Manager sees only OWN row: flipping to `false` should collapse manager visibility to the manager's own row(s) — no other staff data.
-- Expect: count = manager's own rows only (0 unless the manager was seeded a row too).
```

- **Fail signal:** flipping the toggle did not change manager visibility → `is_licenses_manager()` is not reading `enable_licenses_manager_access` correctly.

Restore the default:

```sql
UPDATE public.settings SET value = 'true' WHERE key = 'enable_licenses_manager_access';
```

#### B.M08.5 — Owner sees all

Run as **Owner Test**:

```sql
SELECT count(*) FROM public.producer_licenses;
-- Expect: >= 2 (every seeded row across all staff, regardless of gate toggle).
```

- **Fail signal:** owner sees fewer rows than exist → owner-visibility RLS is broken. Owner reports and dashboards will underrepresent fleet activity.

#### Cleanup for M08

```sql
DELETE FROM public.producer_licenses
 WHERE notes IN ('M08 smoke test row for Producer A',
                 'M08 smoke test row for Producer B');
```

---

### B.M09 — Milestones (§B.11 default: FALSE)

Gate helper: `is_milestones_manager()` · Setting key: `enable_milestones_manager_access` (default `false`)

Primary isolation table for this module: `public.milestone_recognitions` (isolation column: `staff_id`).

#### Seed

```sql
-- Run as service_role. UNIQUE (staff_id, milestone_type, milestone_date) —
-- using a distinctive future date (Dec 31 next year) avoids collision with
-- real seeded milestones. milestone_type must be 'birthday' | 'work_anniversary' | 'service_milestone'.
INSERT INTO public.milestone_recognitions
  (staff_id, milestone_type, milestone_date, notes)
VALUES
  ('<producer_a_staff_id>', 'birthday',
   (date_trunc('year', CURRENT_DATE) + interval '1 year 11 months 30 days')::date,
   'M09 smoke test row for Producer A'),
  ('<producer_b_staff_id>', 'birthday',
   (date_trunc('year', CURRENT_DATE) + interval '1 year 11 months 30 days')::date,
   'M09 smoke test row for Producer B');
```

#### B.M09.1 — Producer sees own row

Run as **Producer A** (browser DevTools console or JWT-authenticated SQL client):

```sql
SELECT count(*) FROM public.milestone_recognitions WHERE staff_id = current_staff_id();
-- Expect: >= 1 (Producer A's seeded row).
```

- **Fail signal:** zero rows → own-row RLS broken. The Producer A UI for Milestones will render empty even though data exists.

#### B.M09.2 — Producer cannot see other producer's row

Run as **Producer A**:

```sql
SELECT count(*) FROM public.milestone_recognitions WHERE staff_id = '<producer_b_staff_id>';
-- Expect: 0.

-- Also verify the general leak-check pattern:
SELECT count(*) FROM public.milestone_recognitions WHERE staff_id <> current_staff_id();
-- Expect: 0.
```

- **Fail signal:** any non-zero count → **cross-producer data leak on M09 Milestones. Immediate install blocker.**

#### B.M09.3 — Manager visibility with gate in default state (FALSE)

The ratified default for `enable_milestones_manager_access` is `false`. Confirm the setting is at its default:

```sql
-- As service_role:
SELECT value FROM public.settings WHERE key = 'enable_milestones_manager_access';
-- Expect: 'false'. If not, restore before running the check.
```

Run as **Manager Test**:

```sql
SELECT count(*) FROM public.milestone_recognitions;
-- Manager sees only OWN row: the default toggle value is `false`, so `is_milestones_manager()` returns false for the manager and RLS treats them like a producer.
-- Expect: count = manager's own rows only (0 unless the manager was seeded a row too).
```

- **Fail signal:** manager visibility does not match the description above.

#### B.M09.4 — Manager visibility with gate flipped

```sql
-- As service_role: flip the toggle.
UPDATE public.settings SET value = 'true' WHERE key = 'enable_milestones_manager_access';
```

Run as **Manager Test** (may require re-fetching the setting client-side or re-authenticating, depending on the app's caching):

```sql
SELECT count(*) FROM public.milestone_recognitions;
-- Manager sees ALL rows: flipping to `true` should expand manager visibility to every row across all staff.
-- Expect: count >= 2 (all producer rows visible).
```

- **Fail signal:** flipping the toggle did not change manager visibility → `is_milestones_manager()` is not reading `enable_milestones_manager_access` correctly.

Restore the default:

```sql
UPDATE public.settings SET value = 'false' WHERE key = 'enable_milestones_manager_access';
```

#### B.M09.5 — Owner sees all

Run as **Owner Test**:

```sql
SELECT count(*) FROM public.milestone_recognitions;
-- Expect: >= 2 (every seeded row across all staff, regardless of gate toggle).
```

- **Fail signal:** owner sees fewer rows than exist → owner-visibility RLS is broken. Owner reports and dashboards will underrepresent fleet activity.

#### Cleanup for M09

```sql
DELETE FROM public.milestone_recognitions
 WHERE notes IN ('M09 smoke test row for Producer A',
                 'M09 smoke test row for Producer B');
```

---

### B.M10 — Emergency Contacts (§B.11 default: FALSE)

Gate helper: `is_emergency_contacts_manager()` · Setting key: `enable_emergency_contacts_manager_access` (default `false`)

Primary isolation table for this module: `public.emergency_contacts` (isolation column: `staff_id`).

#### Seed

```sql
-- Run as service_role. contact_name, relationship, phone_primary are NOT NULL.
-- relationship must be one of: spouse | parent | sibling | friend | child | other.
INSERT INTO public.emergency_contacts
  (staff_id, contact_name, relationship, phone_primary, priority, notes)
VALUES
  ('<producer_a_staff_id>', 'Smoke Contact A', 'friend', '555-0100', 1,
   'M10 smoke test row for Producer A'),
  ('<producer_b_staff_id>', 'Smoke Contact B', 'friend', '555-0101', 1,
   'M10 smoke test row for Producer B');
```

#### B.M10.1 — Producer sees own row

Run as **Producer A** (browser DevTools console or JWT-authenticated SQL client):

```sql
SELECT count(*) FROM public.emergency_contacts WHERE staff_id = current_staff_id();
-- Expect: >= 1 (Producer A's seeded row).
```

- **Fail signal:** zero rows → own-row RLS broken. The Producer A UI for Emergency Contacts will render empty even though data exists.

#### B.M10.2 — Producer cannot see other producer's row

Run as **Producer A**:

```sql
SELECT count(*) FROM public.emergency_contacts WHERE staff_id = '<producer_b_staff_id>';
-- Expect: 0.

-- Also verify the general leak-check pattern:
SELECT count(*) FROM public.emergency_contacts WHERE staff_id <> current_staff_id();
-- Expect: 0.
```

- **Fail signal:** any non-zero count → **cross-producer data leak on M10 Emergency Contacts. Immediate install blocker.**

#### B.M10.3 — Manager visibility with gate in default state (FALSE)

The ratified default for `enable_emergency_contacts_manager_access` is `false`. Confirm the setting is at its default:

```sql
-- As service_role:
SELECT value FROM public.settings WHERE key = 'enable_emergency_contacts_manager_access';
-- Expect: 'false'. If not, restore before running the check.
```

Run as **Manager Test**:

```sql
SELECT count(*) FROM public.emergency_contacts;
-- Manager sees only OWN row: the default toggle value is `false`, so `is_emergency_contacts_manager()` returns false for the manager and RLS treats them like a producer.
-- Expect: count = manager's own rows only (0 unless the manager was seeded a row too).
```

- **Fail signal:** manager visibility does not match the description above.

#### B.M10.4 — Manager visibility with gate flipped

```sql
-- As service_role: flip the toggle.
UPDATE public.settings SET value = 'true' WHERE key = 'enable_emergency_contacts_manager_access';
```

Run as **Manager Test** (may require re-fetching the setting client-side or re-authenticating, depending on the app's caching):

```sql
SELECT count(*) FROM public.emergency_contacts;
-- Manager sees ALL rows: flipping to `true` should expand manager visibility to every row across all staff.
-- Expect: count >= 2 (all producer rows visible).
```

- **Fail signal:** flipping the toggle did not change manager visibility → `is_emergency_contacts_manager()` is not reading `enable_emergency_contacts_manager_access` correctly.

Restore the default:

```sql
UPDATE public.settings SET value = 'false' WHERE key = 'enable_emergency_contacts_manager_access';
```

#### B.M10.5 — Owner sees all

Run as **Owner Test**:

```sql
SELECT count(*) FROM public.emergency_contacts;
-- Expect: >= 2 (every seeded row across all staff, regardless of gate toggle).
```

- **Fail signal:** owner sees fewer rows than exist → owner-visibility RLS is broken. Owner reports and dashboards will underrepresent fleet activity.

#### Cleanup for M10

```sql
DELETE FROM public.emergency_contacts
 WHERE notes IN ('M10 smoke test row for Producer A',
                 'M10 smoke test row for Producer B');
```

---

## Section C — Per-module happy paths

**One representative call per module, run as the appropriate role. Verifies the module's core surface works end-to-end after overlay-apply.**

Each test below assumes:

- `<agency_id>` is the client's agency UUID: `SELECT id FROM public.agency LIMIT 1`
- `<producer_a_staff_id>` is the UUID of the Producer A staff row seeded in §A.1
- Producer A / Manager Test / Owner Test are all authenticated via the app when the SQL is described as "as <role>"

### C.M01 — Time Tracking: agency weekly totals

Run as **any authenticated user** (Producer A recommended for the coverage):

```sql
SELECT get_office_time_weekly('<agency_id>');
-- Expect: a JSONB or table result summarizing last-7-days hours by category.
-- Empty result is acceptable in a fresh install (no data yet) but the call must not error.
```

- **Fail signal:** function does not exist (migration failed) · exception raised at parse or execute time · `permission_denied` returned (RLS/grant misconfig).

### C.M02 — Sales Activity: agency weekly totals

Run as **any authenticated user**:

```sql
SELECT get_office_activity_weekly('<agency_id>');
-- Expect: a JSONB or table result summarizing last-7-days activity by type / LOB / outcome.
-- Empty result is acceptable in a fresh install; the call must not error.
```

- **Fail signal:** function absent · exception · `permission_denied`.

### C.M03 — Scoreboard: celebration list

Run as **Producer A**:

```sql
SELECT rpc_get_celebrations('<producer_a_staff_id>');
-- Expect: a JSONB array (possibly empty) sorted by priority.
-- Empty array is acceptable on day one.
```

- **Fail signal:** function absent · exception · Producer A cannot call the function against their own producer_id.

### C.M04 — PTO: producer own balance

Run as **Producer A**:

```sql
SELECT * FROM public.v_pto_my_balance;
-- Expect: at most one row — Producer A's balance and policy details.
-- Zero rows is acceptable if the producer has not been assigned a policy yet;
-- the query must not error.
```

- **Fail signal:** view absent · exception · view returns another staff member's row (RLS leak — treat as §B failure).

### C.M05 — Handbook: current active sections

Run as **Producer A**:

```sql
SELECT handbook_get_current('<agency_id>');
-- Expect: JSONB or table with the current version's active sections plus version metadata.
-- On a fresh install with no seeded handbook the result may be empty; the call must not error.
```

- **Fail signal:** function absent · exception · non-owner cannot call it (function should be callable by all authenticated staff).

### C.M06 — Benefits: currently active plans

Run as **Producer A**:

```sql
SELECT benefits_get_active_plans('<agency_id>');
-- Expect: rows for currently active benefit plans. Empty on a fresh install; must not error.
```

- **Fail signal:** function absent · exception · producer cannot call it (should be producer-callable).

### C.M07 — Personnel Files: non-sensitive summary of own file

Run as **Producer A**:

```sql
SELECT rpc_get_personnel_summary('<producer_a_staff_id>');
-- Expect: JSONB with the producer's own file metadata (document count, verification counts).
-- Zero-document result acceptable on a fresh install.
```

- **Fail signal:** function absent · exception · `permission_denied` when the producer queries against their own staff_id. (Producer A calling with a DIFFERENT staff_id should be denied — that is a §B.M07 case, not a §C case.)

### C.M08 — Licenses: expiring licenses view

Run as **Producer A**:

```sql
SELECT * FROM public.v_expiring_licenses;
-- Expect: rows only for Producer A's own licenses (RLS-scoped) that are expiring within 60 days
-- or behind on CE hours. Empty on a fresh install; must not error.
```

- **Fail signal:** view absent · exception · view returns another staff member's licenses (RLS leak — §B.M08 failure).

### C.M09 — Milestones: upcoming 60-day view

Run as **any authenticated user**:

```sql
SELECT * FROM public.v_upcoming_milestones;
-- Expect: rows for staff milestones landing in the next 60 days with acknowledgment status.
-- Empty on fresh install; must not error.
```

- **Fail signal:** view absent · exception.

### C.M10 — Emergency Contacts: producer's own contacts

Run as **Producer A**:

```sql
SELECT count(*) FROM public.emergency_contacts WHERE staff_id = current_staff_id();
-- Expect: >= 0 (may be zero if the producer has not seeded contacts yet).
-- Must not error.

-- Also verify Producer A cannot see other staff contacts (§B.M10 double-check):
SELECT count(*) FROM public.emergency_contacts WHERE staff_id <> current_staff_id();
-- Expect: 0.
```

- **Fail signal:** table absent · exception · leak into other staff's contacts.

---

## Section D — Reveal-audit integrity

**Personnel Files and Emergency Contacts both write an audit row every time a sensitive record is revealed. A silent reveal is a compliance blocker — these two checks are non-negotiable for v1.0.**

### D.1 — Personnel Files: `rpc_reveal_personnel_document` writes to `personnel_document_access_log`

Setup: Seed one personnel document belonging to Producer A. Substitute `<doc_id>` with the UUID of that document.

Run as **Owner Test**:

```sql
-- Baseline count
SELECT count(*) AS baseline
  FROM public.personnel_document_access_log
 WHERE document_id = '<doc_id>';

-- Perform the reveal (returns the Drive URL for the document)
SELECT rpc_reveal_personnel_document('<doc_id>', 'smoke test D.1 reveal');

-- Verify the access log grew by exactly one row for this document,
-- and captured the correct reason + caller
SELECT accessed_by_staff_id,
       accessed_at,
       access_reason,
       action
  FROM public.personnel_document_access_log
 WHERE document_id = '<doc_id>'
 ORDER BY accessed_at DESC
 LIMIT 1;
-- Expect:
--   accessed_by_staff_id = <owner_staff_id>
--   accessed_at ~ now
--   access_reason = 'smoke test D.1 reveal'
--   action = 'reveal' (or the module's canonical reveal action string)
```

- **Fail signals:** reveal returned the Drive URL but wrote no audit row → **compliance blocker, immediate v1.0 hold** · audit row present but `access_reason` NULL or wrong → RPC parameter not being persisted · reveal function returned no URL at all → happy path broken (also a §C.M07 concern).

### D.2 — Emergency Contacts: `rpc_reveal_emergency_contacts` writes to `emergency_contact_access_log`

Run as **Owner Test**:

```sql
-- Baseline count
SELECT count(*) AS baseline
  FROM public.emergency_contact_access_log
 WHERE staff_id = '<producer_a_staff_id>';

-- Perform the reveal
SELECT rpc_reveal_emergency_contacts('<producer_a_staff_id>', 'smoke test D.2 reveal');

-- Verify audit row
SELECT accessed_by_staff_id,
       accessed_at,
       access_reason
  FROM public.emergency_contact_access_log
 WHERE staff_id = '<producer_a_staff_id>'
 ORDER BY accessed_at DESC
 LIMIT 1;
-- Expect:
--   accessed_by_staff_id = <owner_staff_id>
--   accessed_at ~ now
--   access_reason = 'smoke test D.2 reveal'
```

- **Fail signals:** reveal returned contacts but wrote no audit row → **compliance blocker** · audit row missing the caller identity or the reason string.

---

## Section E — Personnel Files layered gate

**Personnel Files is the only module with a layered gate: the global `enable_personnel_files_manager_access` toggle AND a per-employee grant in `personnel_file_manager_grants` are BOTH required for a manager to read a specific employee's file. This test proves the global toggle alone is not enough.**

### E.1 — Manager with global gate TRUE but no per-employee grant is denied

Setup: ensure Manager Test has NO row in `personnel_file_manager_grants` for Producer A. Verify:

```sql
-- As service_role
SELECT count(*) FROM public.personnel_file_manager_grants
 WHERE manager_staff_id = '<manager_staff_id>'
   AND target_staff_id  = '<producer_a_staff_id>'
   AND revoked_at IS NULL;
-- Expect: 0. If non-zero, revoke first via rpc_revoke_manager_personnel_access.
```

Flip the global toggle to TRUE (opposite of the ratified FALSE default):

```sql
UPDATE public.settings
   SET value = 'true'
 WHERE key = 'enable_personnel_files_manager_access';
```

Run as **Manager Test**:

```sql
SELECT rpc_get_personnel_summary('<producer_a_staff_id>');
-- Expect: exception raised — 'permission_denied' or an equivalent access-denied signal.
-- Even with the global gate TRUE, the manager has no grant on Producer A specifically,
-- so the layered gate MUST deny.
```

- **Fail signal:** the manager receives the summary without a grant present → **layered gate is broken — immediate v1.0 hold**. The manager can bypass owner-controlled per-employee access. This defeats the entire Personnel Files privacy design.

Now grant access via the owner-only RPC:

```sql
-- As Owner Test
SELECT rpc_grant_manager_personnel_access(
  '<manager_staff_id>',
  '<producer_a_staff_id>',
  'smoke test E.1 grant');
```

Re-run as **Manager Test**:

```sql
SELECT rpc_get_personnel_summary('<producer_a_staff_id>');
-- Expect: summary returned successfully now that the grant exists.
```

Revoke and restore the default toggle:

```sql
-- As Owner Test — revoke the grant
SELECT rpc_revoke_manager_personnel_access(
  (SELECT id FROM public.personnel_file_manager_grants
    WHERE manager_staff_id = '<manager_staff_id>'
      AND target_staff_id  = '<producer_a_staff_id>'
      AND revoked_at IS NULL));

-- As service_role — restore default
UPDATE public.settings
   SET value = 'false'
 WHERE key = 'enable_personnel_files_manager_access';
```

- **Fail signal on the recovery step:** manager still has visibility after revoke → grant revocation is not being honored. Also a compliance blocker.

---

## Section F — Compliance-safe schema

**The `sales_activity` table is compliance-safe by design: customer PII columns physically do not exist. Producers can only log activity type / outcome / LOB / premium band. This test proves the schema still enforces that.**

### F.1 — `sales_activity` does not accept a `customer_name` column

Run as **service_role** (the strictest write path, and the case that would be most damaging if it succeeded):

```sql
-- Attempt to insert a row using a customer PII column
INSERT INTO public.sales_activity
  (producer_id, agency_id, activity_date, activity_type, line_of_business, outcome, customer_name)
VALUES
  ('<producer_a_staff_id>',
   (SELECT id FROM public.agency LIMIT 1),
   CURRENT_DATE,
   'quote',
   'auto',
   'quoted',
   'John Doe');
-- Expect: exception raised —
--   'column "customer_name" of relation "sales_activity" does not exist'
```

- **Fail signal:** insert succeeds → the schema drifted and PII columns were added. **Compliance blocker; escalate immediately.** If the client customized the schema to add customer fields, they voided the compliance-safe design and this template no longer applies to them.

Also confirm the shape of the table matches the ratified spec:

```sql
SELECT column_name
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'sales_activity'
 ORDER BY ordinal_position;
-- Expect columns:
--   id, agency_id, producer_id, activity_date, activity_type,
--   line_of_business, outcome, premium_band, new_household,
--   internal_reference, notes, created_at, updated_at
-- No customer_name / customer_email / customer_phone / dob / policy_number columns.
```

- **Fail signal:** any customer-identifying column present.

---

## Section G — Automation recipe smokes

**Three recipes must be actively running post-install: Premium Auth Provisioner (§B.12 backbone), PTO Nightly Accrual (§4 correctness), Licenses Expiration Watch (§8 correctness).**

### G.1 — Premium Auth Provisioner heartbeat

The Auth Provisioner recipe runs every minute. Even in an idle system with no queue rows to drain, the runner should log a heartbeat in the `automation_runs_log` (or the client's equivalent runner log table — check runner patch for the exact table name).

```sql
-- Verify a recent run exists in the last 5 minutes
SELECT recipe_name, started_at, ended_at, status, rows_processed
  FROM public.automation_runs_log
 WHERE recipe_name = 'Premium Auth Provisioner'
   AND started_at > (now() - interval '5 minutes')
 ORDER BY started_at DESC
 LIMIT 5;
-- Expect: at least one row.
--   status='ok' (or the client runner's success value)
--   rows_processed can be 0 if the queue was empty; that is still a successful heartbeat.
```

- **Fail signal:** zero rows in the last 5 minutes → the pg_cron schedule is not firing or the runner is not dispatching to `runAuthProvisioner`. §A.1 would have caught this — but re-check here for cron-side issues that only surface after several minutes.

### G.2 — PTO Nightly Accrual credits balances

Force a manual run (do not wait for the nightly cron):

```sql
-- Baseline: capture Producer A's current balance
SELECT accrued_days_ytd, used_days_ytd, current_balance
  FROM public.pto_balances
 WHERE staff_id = '<producer_a_staff_id>';

-- Run the accrual RPC as service_role
SELECT rpc_run_nightly_pto_accrual();

-- Verify the balance moved
SELECT accrued_days_ytd, used_days_ytd, current_balance, last_accrual_at
  FROM public.pto_balances
 WHERE staff_id = '<producer_a_staff_id>';
-- Expect: last_accrual_at ~ now; accrued_days_ytd increased by the correct
-- per-day accrual for Producer A's policy (or unchanged if the producer is
-- still in a waiting period — check the policy).
```

- **Fail signal:** RPC errors · `last_accrual_at` did not advance · balance untouched despite the producer being past waiting period.

### G.3 — Licenses Expiration Watch inserts alerts

Setup: seed a producer license expiring in 30 days for Producer A (if none exists):

```sql
-- As Producer A (or service_role for setup)
SELECT rpc_upsert_producer_license(
  NULL,                              -- new row
  'P&C',
  'SMK-TEST-001',
  'FL',
  CURRENT_DATE + INTERVAL '30 days'  -- expires in 30 days
);
```

Force a manual run of the expiration watch. The recipe name/handler pattern in the runner is `runLicensesExpirationWatch` — the recipe row in `automation_recipes` has the SQL handler this dispatches to. Consult the recipe row and invoke that handler as service_role:

```sql
SELECT sql_handler
  FROM public.automation_recipes
 WHERE recipe_name = 'Licenses Expiration Watch';
-- Then execute the handler (varies by install — typically a SELECT wrapping
-- the fn_scan_expiring_licenses function).

-- Verify an alerts row was inserted
SELECT count(*)
  FROM public.alerts
 WHERE staff_id      = '<producer_a_staff_id>'
   AND alert_type    = 'license_expiration'
   AND created_at    > (now() - interval '2 minutes');
-- Expect: >= 1.
```

- **Fail signal:** no alerts row appeared → the recipe handler is not scanning expiring licenses correctly or the runner dispatch is broken.

Cleanup the seeded license after G.3 completes (or leave in place if the client wants realistic test data — flag to Rebecca either way).

---

## Cleanup

Run these after all §A–§G checks pass. Order matters — reverse of the setup.

```sql
-- 1. Delete seeded module rows for each M01–M10 (§B seed blocks)
-- Each module subsection has its own `Cleanup for MNN` block. Run them all
-- before running the following global cleanup.

-- 2. Delete the smoke-test staff rows (this triggers auth revoke for each)
UPDATE public.staff
   SET status = 'terminated'
 WHERE email IN (
   'smoke-owner@example.com',
   'smoke-manager@example.com',
   'smoke-producer-a@example.com',
   'smoke-producer-b@example.com'
 );

-- Wait 60–90s for revoke to drain (§A.2 pattern).

-- 3. Hard-delete the staff rows now that their Auth accounts are disabled
DELETE FROM public.staff
 WHERE email IN (
   'smoke-owner@example.com',
   'smoke-manager@example.com',
   'smoke-producer-a@example.com',
   'smoke-producer-b@example.com'
 );

-- 4. Purge queue history for the smoke emails
DELETE FROM public._pending_auth_actions
 WHERE staff_email IN (
   'smoke-owner@example.com',
   'smoke-manager@example.com',
   'smoke-producer-a@example.com',
   'smoke-producer-b@example.com'
 );

-- 5. Verify all §B.11 toggles are back at their ratified defaults
SELECT key, value
  FROM public.settings
 WHERE key IN (
   'enable_time_tracking_manager_access',       -- expect 'true'
   'enable_sales_activity_manager_access',      -- expect 'true'
   'enable_scoreboard_manager_access',          -- expect 'false'
   'enable_pto_manager_access',                 -- expect 'true'
   'enable_handbook_manager_access',            -- expect 'true'
   'enable_benefits_manager_access',            -- expect 'false'
   'enable_personnel_files_manager_access',     -- expect 'false'
   'enable_licenses_manager_access',            -- expect 'true'
   'enable_milestones_manager_access',          -- expect 'false'
   'enable_emergency_contacts_manager_access'   -- expect 'false'
 )
 ORDER BY key;
```

If any toggle drifted from its default during a test and was not restored, do so now. Handoff with defaults intact.

Finally: purge the smoke-user rows from Supabase Auth via the dashboard (Authentication → Users → filter `smoke-`). The trigger-driven auth revoke disabled the accounts but did not delete them. Manual delete is the last step before handoff.

---

## When a check fails

**Do not hand off with any failing check.** The severity ladder for triage:

**Blocker — do not hand off; return to overlay-apply:**

- Any §B.11 test 2 failure (Producer A sees Producer B's row) — cross-producer data leak.
- Any §A.2 failure where a terminated staff member can still log in — auth revoke broken.
- §D.1 or §D.2 audit-log failure — reveal without audit is a compliance leak.
- §E.1 layered gate bypass — manager reads a personnel file without a grant.
- §F.1 acceptance of `customer_name` — compliance-safe design voided.

**Blocker — do not hand off; return to migration authoring:**

- Any prerequisite table (§Prerequisites step 1) missing.
- Any §B.11 gate helper (§Prerequisites step 2) missing.
- Any §B.11 setting toggle absent from `public.settings` (§Prerequisites step 3).
- Any automation recipe row missing (§Prerequisites step 4).

**Runtime — investigate the runner or cron:**

- §A.1 queue row enqueues but does not drain within 90s → runner patch not deployed, or cron job disabled.
- §G.1 heartbeat missing → runner not scheduled or cron paused.
- §G.2 or §G.3 handler exceptions → recipe SQL handler drifted from what the runner dispatches to.

**Design — escalate to Rebecca:**

- Any §C happy path returns `permission_denied` for the role the brief says can call it.
- Any §B.11 test 3 or 4 reads the wrong scope given the ratified default → the gate helper logic is inverted; requires an overlay hotfix commit before v1.0.
- Any Base master compatibility failure (function name mismatch, column case mismatch) → return to `100_base_compat_shim.sql` and re-verify against the client's Base HEAD.

**Documentation-only — flag but do not block:**

- A module returns empty results on a fresh install with no seeded data.
- A view returns fewer rows than expected because the tester's clock is skewed relative to the seeded `created_at` timestamps.

For any failure, capture:

1. The exact test ID (e.g. `B.M07.4`).
2. The command run.
3. The observed result vs the expected result.
4. The overlay HEAD SHA at time of run.
5. The Base master HEAD SHA at time of run.

Then either fix in place (for shim-level issues) or open an issue against `bcc-premium-overlay` referencing the audit finding for the failing surface.

---

## Test-count summary

| Section | Tests | Cumulative |
| --- | --- | --- |
| §A — Auto-Provisioning Invariant (§B.12) | 3 | 3 |
| §B — Producer Isolation Principle (§B.11) | 50 | 53 |
| §C — Per-module happy paths | 10 | 63 |
| §D — Reveal-audit integrity | 2 | 65 |
| §E — Personnel Files layered gate | 1 | 66 |
| §F — Compliance-safe schema | 1 | 67 |
| §G — Automation recipe smokes | 3 | 70 |
| **Total** | **70** | **70** |

All seventy checks must pass before overlay handoff.
