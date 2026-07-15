# HANDOFF_PROMPTS_premium.md

**Appended to the client's `HANDOFF_PROMPTS.md` during overlay apply (Step 7 of `OVERLAY_APPLY.md`).**

Post-handoff, the client's Claude sessions consult these prompts when operating Premium modules. Each section is a concrete workflow the client Claude can follow.

Overlay version: **v0.5.8** — ships the full Premium tier (all ten modules).

---

## What the Premium overlay adds

Ten modules layered on top of Base BCC. Each has its own section below with concrete workflows.

| § | Module | Storage | Manager gate default | Notes |
|---|---|---|---|---|
| §4 | PTO | DB-native | TRUE | Deliberate — SF office manager workflow |
| §4.1 | Time Tracking | DB-native | TRUE | Deliberate — managers routinely coach on hours |
| §4.2 | Sales Activity | DB-native | TRUE | Deliberate — managers coach production; compliance-safe schema (no customer PII possible) |
| §4.3 | Scoreboard | DB-native | FALSE | Canonical — cross-producer visibility opt-in |
| §4.5 | Handbook | DB-native | TRUE | Deliberate — managers routinely enforce policy |
| §4.6 | Benefits | DB-native | FALSE | Deliberate — comp-adjacent PII |
| §4.7 | Personnel Files | Google Drive via Composio | FALSE | Canonical — layered gate + per-employee grants |
| §4.8 | Licenses | DB-native | TRUE | Deliberate — managers routinely track CE compliance |
| §4.9 | Milestones | DB-native | FALSE | Canonical |
| §4.10 | Emergency Contacts | DB-native | FALSE | Canonical — reveal-audit only, no direct SELECT |

Also included: the **Premium Auth Provisioner** recipe (drains `_pending_auth_actions` every minute), which powers the Auto-Provisioning Invariant §B.12 described below.

---

## Governance invariants (apply to every module)

Two invariants are enforced at the database layer independent of the UI. If a user asks Claude to change PTO or Personnel Files or Emergency Contacts behavior in a way that would weaken either invariant, push back and consult these principles before altering RLS, RPC gates, or settings.

### Producer Isolation Principle (§B.11)

Every active producer sees only their own module data unless explicitly given cross-staff access. Cross-staff visibility is owner-only by default. Manager access is opt-in per module via `settings.enable_<module>_manager_access`.

The default for that setting is stored in migration `10x`. Five modules ship with the manager gate at TRUE by default (PTO, Time Tracking, Sales Activity, Handbook, Licenses) because SF office managers routinely need those views to run the office. Five modules ship FALSE (Scoreboard, Benefits, Personnel Files, Milestones, Emergency Contacts) because the data is either comp-adjacent PII, employee HR records, or family PII. The client's owner can always flip the toggle either direction — never edit the migration; always UPDATE the settings row.

### Auto-Provisioning Invariant (§B.12)

`staff.status = 'active'` implies an enabled Supabase Auth account. `staff.status = 'terminated'` implies zero access.

Migration `100a` adds a trigger on `staff` that enqueues actions to `_pending_auth_actions`. The **Premium Auth Provisioner** recipe (in `automation_recipes`) drains that queue every minute via the runner-patched `dispatch_premium_auth_provisioner` orchestrator. Handles provision on new active staff, revoke on termination, restore on rehire. Idempotent — a duplicate action is a no-op.

Never manually create an auth user without a corresponding staff row. Never bypass this trigger — if a user needs immediate access, INSERT the staff row and let the queue drain within 60 seconds.

---

## Cross-module design conventions

### Compliance-safe schemas (Time Tracking, Sales Activity, Scoreboard)

These modules never store customer PII. That's not a policy — it's a schema constraint. There are no columns for customer names, policy numbers, VINs, addresses, or SSNs. If a user tries to squeeze customer detail into a free-text field like `notes` or `internal_reference`, those fields are hard-capped (50 or 200 characters, enforced in the migration) and the UI shows a warning at 80% of the limit.

When explaining this to a user, don't call it a legal disclaimer. Call it an engineering constraint — the table shape physically prevents it. The outcome is the same as a policy would deliver, but the enforcement is architectural.

### Reveal-audit modules (Personnel Files, Emergency Contacts)

These two modules hold real employee/family PII. Owners and gated managers can access the data, but only through a SECURITY DEFINER RPC that requires a written reason and writes to an append-only audit log. Direct `SELECT` on these tables from a non-owner session is blocked by RLS.

When helping a user reveal a document or a set of emergency contacts, always ask for a real reason. **State a real reason.** The audit log is a compliance defense. A blank reason, a one-word reason, or "just checking" is worse than no reveal at all — it looks like snooping under audit. If the user resists, don't do the reveal. The right answer is often "the file cabinet is fine here — you don't need this."

### The `enable_<module>_manager_access` toggle

Every Premium module has one row in `public.settings`:

```sql
SELECT key, value
  FROM public.settings
 WHERE key LIKE 'enable_%_manager_access'
 ORDER BY key;
```

Flipping any toggle is a single UPDATE:

```sql
UPDATE public.settings
   SET value = 'true'          -- or 'false'
 WHERE key = 'enable_licenses_manager_access';
```

The gate helpers (`is_pto_manager()`, `is_time_tracking_manager()`, `is_sales_activity_manager()`, etc.) all read this setting live. No cache, no restart — the next RPC call sees the new value.

---

## Install-time prerequisites

### Standard Premium install (§4 through §4.10 except §4.7)

Nine of the ten modules require nothing beyond what Base BCC and the overlay migrations provide:

- Base master at v3.0 or later (provides `public.agency`, `public.staff`, `public.settings`, `public.alerts`, `public._install_provenance`, `public.update_updated_at()`, `public.automation_recipes`, and pg_cron heartbeat).
- Overlay migrations 100 through 112 applied via `OVERLAY_APPLY.md`.
- `automation-runner` Edge Function deployed (Base's runner is used — no Premium-specific runner).

If Base is at an earlier version, the shim migration `100_base_compat_shim.sql` fills the gaps automatically.

### Additional prerequisites for §4.7 Personnel Files

Personnel Files stores document bytes in the owner's Google Drive rather than in Supabase Storage. Five install steps must be completed before the module is usable. If a user opens Personnel Files before these are done, the UI shows a blocking "Google Drive not connected" gate.

1. **Connect Composio Google Drive on the client agent.** In Composio's dashboard for the client's agent, connect the owner's Google account under the Google Drive tool. Test with a `GOOGLEDRIVE_FIND_FILE` call.
2. **Set two secrets on the client Supabase project.** Both are required by the `personnel-upload` Edge Function:
   ```
   COMPOSIO_API_KEY              = <the client agent's Composio API key>
   COMPOSIO_CONNECTED_ACCOUNT_ID = <the connected account ID from step 1>
   ```
3. **Create the private staging bucket** on the client Supabase Storage:
   - Name: `personnel-uploads-temp`
   - Access: private
   - Lifecycle: delete objects after 24 hours (the Edge Function cleans up on success, but the lifecycle rule catches orphans from failed uploads).
4. **Flip the connected setting:**
   ```sql
   UPDATE public.settings
      SET value = 'true'
    WHERE key = 'drive_composio_connected';
   ```
5. **Deploy the Edge Function:**
   ```bash
   supabase functions deploy personnel-upload
   ```

The full storage flow is documented under §4.7 below.

---

## §4 PTO — display convention: hours in UI, days in DB

All PTO amounts are stored in **days** in the database (`pto_balances.balance_days`, `pto_requests.total_days`, `pto_policies.accrual_rate_days`) but should be **displayed in hours** to the user. Insurance agents and their producers think in hours — never days. When Claude reads a balance or request duration from the database, multiply by 8 (the standard convention: 1 day = 8 working hours) before showing it. If Claude is asked "how many days do I have," reply in hours: "you have 72 hours" (not "9 days").

The webapp uses `src/lib/pto/format.js` helpers for this (`formatDaysAsHours`, `formatRequestDuration`, `formatAfterBalance`). Claude sessions writing manual reports should follow the same convention.

---

## §4 PTO — how to help a producer submit a request

**Trigger:** the user says something like "I want to take PTO," "I need to request a day off," "put in a vacation request."

**Steps:**

1. Confirm the dates. Ask for start date and end date (or a single date for half-day). Ask if this is a full day or half day.
2. Confirm the request type. Options are `pto` (default), `sick`, `personal`, `bereavement`, `other`.
3. Ask for an optional reason. Not required, but useful for the approver.
4. Call the RPC:

```sql
SELECT public.rpc_create_pto_request(
  p_start_date   := DATE '2026-08-05',
  p_end_date     := DATE '2026-08-06',
  p_is_half_day  := false,
  p_reason       := 'Family trip',
  p_request_type := 'pto'
);
```

5. The RPC returns the new `request_id` (uuid). Report it back to the user with a confirmation: "Your request has been submitted. It's pending approval from [owner name]. The request ID is …"

**Half-day requests:** Single-date only, `p_is_half_day = true`, `p_half_day_period` = 'am' or 'pm', `total_days` will be 0.5 automatically. If the agency has `settings.pto_request_granularity = 'full_day_only'`, the RPC will reject half-day requests — inform the user.

**Error path:** If the RPC raises `validation_error: end_date must be on or after start_date`, correct with the user and re-call. If it raises `auth_required: no staff row for current user`, the user isn't linked to a staff record — escalate to the owner.

---

## §4 PTO — how to help someone check their balance

**Trigger:** "How much PTO do I have," "what's my balance," "how many hours do I have left."

**Query:**

```sql
SELECT * FROM public.v_pto_my_balance;
```

This view is scoped by RLS to the current user's own balance. Report the balance in **hours** — multiply `balance_days` by 8 before showing it. Example: if `balance_days = 9.5`, report "76 hours remaining." Mention the period (`period_start` to `period_end`), and give the breakdown by converting `accrued_this_period` and `used_this_period` to hours the same way ("accrued 6.2 hours this period, used 8 hours").

If the view returns zero rows, the user either has no assigned PTO policy or the accrual hasn't run yet. Check `public.staff.pto_policy_id` for the user; if NULL, tell the user their policy hasn't been set up yet and to talk to the owner.

---

## §4 PTO — how to help an owner or authorized manager approve or decline

**Trigger:** "Show me pending PTO requests," "approve [name]'s request," "decline the vacation request."

**Show pending queue:**

```sql
SELECT * FROM public.v_pto_admin_roster
 WHERE status = 'pending'
 ORDER BY start_date;
```

**Approve:**

```sql
SELECT public.rpc_approve_pto_request(p_request_id := '…');
```

This RPC checks `is_pto_manager()` internally and raises `permission_denied` if the caller isn't authorized. On success, the request status flips to `approved` and `pto_balances.used_this_period` and `balance_days` update in the same transaction.

**Decline (requires a reason):**

```sql
SELECT public.rpc_decline_pto_request(
  p_request_id := '…',
  p_reason     := 'Insufficient coverage that week — see me to reschedule.'
);
```

The reason is stored in `pto_requests.decline_reason` and shown to the producer. Never call this with an empty reason — the RPC rejects it.

---

## §4 PTO — how to help someone cancel their own pending request

**Trigger:** "I want to cancel my PTO request," "never mind on that vacation request."

**Rule:** producers can only cancel their OWN requests, and only while status is still `pending`. If the request is already approved, the producer has to ask the owner to unwind it (which is a manual conversation, not an RPC).

```sql
SELECT public.rpc_cancel_pto_request(p_request_id := '…');
```

---

## §4 PTO — how to explain the accrual model

**Trigger:** the user asks "how does PTO accrual work here" or "when does my balance go up."

The client's PTO policy (in `public.pto_policies`) is defined in **days per year** (the natural unit for policy definitions — nobody says "120 hours per year," they say "15 days per year"). When Claude describes accrual to a user, quote the policy in days (matches how HR conversations work) but always render current balances and accrual amounts in hours.

Four accrual patterns:

- **`anniversary`** — days per year defined by tenure brackets in `tenure_brackets` jsonb. Accrual is prorated daily from the anniversary date. Example: 15 days/year (120 hrs/year) means ~0.041 days (~0.33 hrs) accrued per day.
- **`monthly`** — flat monthly rate in `accrual_rate_days`, applied daily as (rate × 12 / 365) × days_since_last_accrual.
- **`biweekly`** — flat biweekly rate in `accrual_rate_days`, applied daily as (rate / 14) × days_since_last_accrual.
- **`unlimited`** — no accrual, no tracking, balance always shows as "unlimited" in the UI.

The nightly recipe **Premium PTO Nightly Accrual** (in `public.automation_recipes`) runs at 06:00 UTC daily. It's idempotent — running it twice on the same day is a no-op for staff already accrued that day.

To run accrual manually (owner-only via RPC exception; usually not needed):

```sql
SELECT public.rpc_run_nightly_pto_accrual();
```

Returns `{processed, skipped, errors, run_at}`.

---

## §4 PTO — how to help with team availability

**Trigger:** "Who's out this week," "who's on PTO for the retreat," "check team availability."

Producers see aggregate counts only (never names — Producer Isolation §B.11). Owner and authorized managers see the roster view.

For counts across any date range (safe for producers):

```sql
SELECT * FROM public.fn_pto_team_availability_counts(
  DATE '2026-08-01',
  DATE '2026-08-31'
);
```

Returns date + count columns only. If a producer asks who specifically is out, the honest answer is "I can tell you how many people are scheduled to be out on each day, but I can't share the names — that's a Producer Isolation policy."

For owners, use the roster view:

```sql
SELECT staff_name, start_date, end_date, request_type, status
  FROM public.v_pto_admin_roster
 WHERE start_date <= DATE '2026-08-31'
   AND end_date   >= DATE '2026-08-01'
   AND status IN ('approved', 'pending')
 ORDER BY start_date, staff_name;
```

---

## §4 PTO — troubleshooting

**"function public.current_staff_id() does not exist"** — the migration 100e shim didn't apply. Re-run the migration and retry the RPC.

**"permission_denied: not an authorized PTO approver"** — the caller is a manager but `settings.enable_pto_manager_access` is `false`, or the caller is a producer. Explain the toggle and escalate to owner if the manager should have access.

**Balance shows the wrong number after approval** — the balance decrement happens inside `rpc_approve_pto_request` in the same transaction as the status flip. If it looks wrong, verify `pto_balances.used_this_period` and `pto_balances.balance_days` for the affected staff. If numbers are off, check `automation_run_log` for accrual errors and inspect `pto_requests.total_days` (constraint checks total_days > 0).

**Auto-provisioning didn't fire for a new hire** — check `_pending_auth_actions` for the staff row. If the queue has a pending or failed row, look at `automation_run_log` for the `Premium Auth Provisioner` recipe.

---

## §4.1 Time Tracking — how to help a producer log daily hours

**Trigger:** "log my hours," "put in my time," "I worked 4 hours on quoting today."

Time Tracking is an **hours-summary** shape — producers log total hours per day per activity category. There are no clock-in/clock-out timestamps and no per-customer breakdowns. Categories are configurable via `settings.time_tracking_categories` (JSONB array of strings) — the shipped default is `['servicing', 'quoting', 'prospecting', 'admin', 'training']`.

**Steps:**

1. Confirm the date (default is today unless the producer says otherwise).
2. Ask for hours per category. Multiple categories can share one date — one row per (staff, date, category).
3. Insert directly (RLS enforces `staff_id = current_staff_id()`):

```sql
INSERT INTO public.time_tracking (agency_id, producer_id, entry_date, activity_category, hours)
SELECT s.agency_id, s.id, DATE '2026-08-05', 'quoting', 4.5
  FROM public.staff s
 WHERE s.id = public.current_staff_id();
```

Or as a single multi-row insert for a full day:

```sql
INSERT INTO public.time_tracking (agency_id, producer_id, entry_date, activity_category, hours)
SELECT s.agency_id, s.id, DATE '2026-08-05', cat, hrs
  FROM public.staff s
  CROSS JOIN (VALUES ('quoting', 4.5), ('servicing', 2.0), ('admin', 1.5)) AS v(cat, hrs)
 WHERE s.id = public.current_staff_id();
```

Confirm to the user with the total: "Logged 8.0 hours for August 5 — 4.5 quoting, 2.0 servicing, 1.5 admin."

**Edit window:** producers can UPDATE their own rows within the current calendar week and DELETE their own rows within 24 hours of insertion. These windows are enforced client-side, not by RLS — an owner or manager can edit or delete any row at any time.

---

## §4.1 Time Tracking — how to help a producer check their own hours

**Trigger:** "how many hours did I log this week," "show me my time this month," "what did I work on last week."

**Rolling 12-week view (per-category totals):**

```sql
SELECT week_start, activity_category, total_hours
  FROM public.v_time_tracking_weekly_by_producer
 WHERE producer_id = public.current_staff_id()
 ORDER BY week_start DESC, activity_category;
```

**Rolling 12-month view:**

```sql
SELECT month_start, activity_category, total_hours
  FROM public.v_time_tracking_monthly_by_producer
 WHERE producer_id = public.current_staff_id()
 ORDER BY month_start DESC, activity_category;
```

Both views are RLS-scoped — a producer sees only their own rows. Owner and authorized manager see everyone.

---

## §4.1 Time Tracking — office-wide view (owner + authorized manager)

**Trigger:** "show me the office's hours this week," "what did the team work on this month," "who's spending too much time on admin."

**Weekly agency-wide totals:**

```sql
SELECT * FROM public.get_office_time_weekly(
  p_agency_id := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id())
);
```

**Monthly agency-wide totals (month-to-date):**

```sql
SELECT * FROM public.get_office_time_monthly(
  p_agency_id := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id())
);
```

**Per-producer breakdown (owner or gated manager):**

```sql
SELECT staff_name, week_start, activity_category, total_hours
  FROM public.v_time_tracking_weekly_by_producer w
  JOIN public.staff s ON s.id = w.producer_id
 WHERE w.week_start >= DATE '2026-07-01'
 ORDER BY staff_name, week_start DESC, activity_category;
```

For managers to see other producers, `settings.enable_time_tracking_manager_access` must be `true` (shipped default). If it's been flipped to `false`, the manager sees only their own rows.

---

## §4.1 Time Tracking — catching missing days

**Trigger:** "who hasn't logged their hours," "am I behind on my time," "which days am I missing."

```sql
SELECT * FROM public.v_time_tracking_missing_days_by_producer
 WHERE producer_id = public.current_staff_id()
 ORDER BY missing_date;
```

Returns workdays in the last 14 days where the producer logged zero hours. Owner and gated manager can query without the `WHERE producer_id = …` filter to see missing days for the whole team.

---

## §4.1 Time Tracking — how to explain the compliance-safe design

**Trigger:** the user asks "why can't I put the customer's name here" or "can I track this policy specifically."

The table `public.time_tracking` has no columns for customer names, policy numbers, or account details. That's an engineering constraint, not a policy — the schema physically prevents customer PII from being logged in this module. When a producer says "I spent 2 hours on the Smith account," that gets logged as 2 hours of `servicing` (or whichever category fits). The activity summary rolls up to the category level.

Explain this as: "The office manager and owner can see what categories of work everyone is doing, but never which specific customers. That protects customer privacy and keeps this module out of any SF PII audit."

---

## §4.1 Time Tracking — troubleshooting

**"new row violates row-level security policy for table time_tracking"** — a producer tried to INSERT a row with `producer_id` different from their own `current_staff_id()`. Correct the row and retry.

**"trigger trg_time_tracking_producer_agency violated"** — the `producer_id` and `agency_id` in the row don't match. Pull `agency_id` from the staff row instead of hard-coding it (see the INSERT template above).

**Manager can't see other producers' hours** — check `settings.enable_time_tracking_manager_access`. If false, that's the intended isolation; flip it if the owner wants manager-level visibility.

**Producer can't edit a row from last week** — that's the client-side edit window. Owners and managers can edit any row at any time. If a producer needs a correction outside the window, they escalate to owner.

---

## §4.2 Sales Activity — how to help a producer log activity

**Trigger:** "log a quote," "I bound a policy today," "record a cross-sell," "put in my activity for today."

Sales Activity is another compliance-safe module. The producer logs the shape of the activity (type, LOB, outcome, premium band) but never the customer identity. Activity types are `quote`, `application`, `policy_bound`, `cross_sell`, `renewal`, `other`.

**Steps:**

1. Confirm activity type, LOB (line of business — `auto`, `home`, `life`, `health`, `commercial`, `other`), outcome (`pending`, `bound`, `lost`, `abandoned`), and premium band (`under_500`, `500_1500`, `1500_5000`, `5000_plus`, `none`).
2. Optionally capture `internal_reference` (50 chars, no PII) and `notes` (200 chars, no PII).
3. Insert:

```sql
INSERT INTO public.sales_activity
  (agency_id, producer_id, activity_date, activity_type, lob, outcome, premium_band, internal_reference, notes)
SELECT s.agency_id, s.id, DATE '2026-08-05', 'policy_bound', 'auto', 'bound', '500_1500', 'QT-1834', '6-mo policy'
  FROM public.staff s
 WHERE s.id = public.current_staff_id();
```

**Character caps enforced by the migration:** `internal_reference` VARCHAR(50), `notes` VARCHAR(200). If a producer tries to paste a customer name into `notes`, warn them: "This field is capped at 200 characters and is designed to never hold customer PII — put internal cues here like 'follow-up on rate quote' or 'family bundle interest,' not names or policy numbers."

---

## §4.2 Sales Activity — how to help a producer view their own trends

**Trigger:** "what did I quote this week," "show my bound policies this month," "what's my activity mix."

**Rolling 90-day daily activity:**

```sql
SELECT activity_date, activity_type, activity_count
  FROM public.v_sales_activity_daily_by_producer
 WHERE producer_id = public.current_staff_id()
 ORDER BY activity_date DESC, activity_type;
```

**Rolling 12-week per-LOB:**

```sql
SELECT week_start, lob, bound_count, pending_count
  FROM public.v_sales_activity_weekly_by_producer
 WHERE producer_id = public.current_staff_id()
 ORDER BY week_start DESC, lob;
```

**Rolling 12-month:**

```sql
SELECT month_start, activity_type, lob, outcome, activity_count
  FROM public.v_sales_activity_monthly_by_producer
 WHERE producer_id = public.current_staff_id()
 ORDER BY month_start DESC;
```

**Current-month outcome distribution:**

```sql
SELECT activity_type, outcome, activity_count, pct_of_type
  FROM public.v_sales_activity_outcome_distribution
 WHERE producer_id = public.current_staff_id()
 ORDER BY activity_type, outcome;
```

Producers see only their own rows; owner and gated manager see everyone.

---

## §4.2 Sales Activity — office-wide view (owner + authorized manager)

**Trigger:** "show the team's activity this week," "who's bound the most auto this month," "where's our pipeline sitting."

**Agency-wide weekly totals:**

```sql
SELECT * FROM public.get_office_activity_weekly(
  p_agency_id := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id())
);
```

**Agency-wide month-to-date:**

```sql
SELECT * FROM public.get_office_activity_monthly(
  p_agency_id := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id())
);
```

**Per-producer leaderboard (owner or gated manager):**

```sql
SELECT s.full_name, month_start, activity_type, lob, outcome, activity_count
  FROM public.v_sales_activity_monthly_by_producer m
  JOIN public.staff s ON s.id = m.producer_id
 WHERE m.month_start = DATE_TRUNC('month', CURRENT_DATE)::date
 ORDER BY activity_count DESC;
```

Manager access requires `settings.enable_sales_activity_manager_access = true` (shipped default).

---

## §4.2 Sales Activity — how to explain the compliance-safe design

**Trigger:** the user asks "can I record the customer's name" or "why is notes so short."

The `sales_activity` table has no customer identity columns. Not customer name, not policy number, not VIN, not address. When a producer records `activity_type = policy_bound, lob = auto, outcome = bound, premium_band = 500_1500`, that's the full record — no customer identity is captured or capturable.

The free-text fields `internal_reference` and `notes` are hard-capped (50 and 200 chars respectively) with UI warnings at 80% of the limit. They exist for internal cues ("follow-up on rate quote," "family bundle interest," "referred by Bryson McCarley"), not for customer identifiers.

Frame it to the user this way: "Customer PII stays out of this module by design — the schema doesn't have columns for it. This is why the team can look at each other's activity without any privacy concern. If you need customer detail, that lives in your CRM, not here."

---

## §4.2 Sales Activity — troubleshooting

**"new row violates check constraint 'sales_activity_internal_reference_check'"** — `internal_reference` exceeded 50 characters. Ask the producer to shorten or drop it.

**"new row violates check constraint 'sales_activity_notes_check'"** — `notes` exceeded 200 characters. Same fix.

**"trigger trg_sales_activity_producer_agency violated"** — mismatched producer_id and agency_id. Pull `agency_id` from the staff row.

**Manager can't see team activity** — check `settings.enable_sales_activity_manager_access`. Flip to `true` if manager visibility is desired.

**Producer wants to log a customer name** — hold the line. Explain the compliance-safe design. Route the request to the CRM.

---

## §4.3 Scoreboard — reading own goals and progress

**Trigger:** "how am I tracking on my goals," "what's my scoreboard," "am I on pace this month."

The Scoreboard reads from `scoreboard_goals` (period-bound targets with `goal_type`, `target_value`, `period_start`, `period_end`) and lets each producer see their own row. Producer-scoped rows have `producer_id = <their staff id>`. Team-wide rows have `producer_id IS NULL`.

**Producer's own goals for the current period:**

```sql
SELECT goal_type, target_value, period_start, period_end
  FROM public.scoreboard_goals
 WHERE producer_id = public.current_staff_id()
   AND period_start <= CURRENT_DATE
   AND period_end   >= CURRENT_DATE
 ORDER BY goal_type;
```

**Team-wide goals visible to all producers:**

```sql
SELECT goal_type, target_value, period_start, period_end
  FROM public.scoreboard_goals
 WHERE producer_id IS NULL
   AND period_start <= CURRENT_DATE
   AND period_end   >= CURRENT_DATE
   AND agency_id = (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id())
 ORDER BY goal_type;
```

Progress is calculated client-side by joining against the Sales Activity views (`v_sales_activity_monthly_by_producer` for month-scoped goals, `v_sales_activity_weekly_by_producer` for weekly goals). The Scoreboard JSX handles the math — Claude shouldn't reinvent it.

---

## §4.3 Scoreboard — celebrations and nudges

**Trigger:** "what did I achieve today," "any wins to celebrate," "show my scoreboard tiles."

The `rpc_get_celebrations` RPC returns a JSONB array of celebration tiles for a producer, sorted by priority:

```sql
SELECT public.rpc_get_celebrations(p_producer_id := public.current_staff_id());
```

Celebration types the RPC computes:

- `goal_hit` — a scoreboard_goals row where the producer's activity has met or exceeded target.
- `bound_yesterday` — one or more `sales_activity` rows with `outcome = 'bound'` on the previous business day.
- `cross_sell_yesterday` — one or more `activity_type = 'cross_sell'` rows on the previous business day.
- `new_household_yesterday` — inferred from bound activity patterns.
- `activity_streak_3` — three or more consecutive business days with any logged sales_activity.

The **nudge tile** (a warning if activity is dropping) is computed **client-side** in the Scoreboard JSX — the RPC does not return it. If the producer asks "why does my nudge tile look angry," the answer is that the last 7 days of sales_activity hours are below the trailing-4-week average. Point them at their `v_sales_activity_weekly_by_producer` numbers.

---

## §4.3 Scoreboard — reading announcements

**Trigger:** "what's new," "any announcements," "show the board."

```sql
SELECT title, body, priority, created_at, published_at
  FROM public.agency_announcements
 WHERE agency_id = (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id())
   AND is_active = true
   AND (expires_at IS NULL OR expires_at > NOW())
 ORDER BY priority DESC, created_at DESC;
```

All active staff can read. Owner and gated manager can write.

---

## §4.3 Scoreboard — how to create or update a goal (owner + authorized manager)

**Trigger:** "set a team goal for August," "give Jenn a personal goal of 40 bound policies this quarter."

Goals are inserted or updated directly (there's no dedicated RPC for CRUD — RLS enforces owner-or-gated-manager writes).

**Team-wide goal (producer_id NULL):**

```sql
INSERT INTO public.scoreboard_goals
  (agency_id, producer_id, goal_type, target_value, period_start, period_end)
SELECT
  (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id()),
  NULL,
  'policies_bound',
  200,
  DATE '2026-08-01',
  DATE '2026-08-31';
```

**Per-producer goal:**

```sql
INSERT INTO public.scoreboard_goals
  (agency_id, producer_id, goal_type, target_value, period_start, period_end)
SELECT
  s.agency_id,
  s.id,
  'policies_bound',
  40,
  DATE '2026-08-01',
  DATE '2026-08-31'
  FROM public.staff s
 WHERE s.full_name = 'Jenn Rodriguez';
```

The unique constraint on `(agency_id, producer_id, goal_type, period_start, period_end)` treats NULL `producer_id` as distinct — so a team-wide `policies_bound` for August can coexist with a Jenn-specific `policies_bound` for August without conflict.

**Update the target on an existing goal:**

```sql
UPDATE public.scoreboard_goals
   SET target_value = 250
 WHERE id = '…';
```

Manager writes require `settings.enable_scoreboard_manager_access = true`. Shipped default is `false` for this module — cross-producer goal setting is owner territory by default.

---

## §4.3 Scoreboard — how to create or update an announcement (owner + authorized manager)

**Trigger:** "post an announcement," "let the team know about the schedule change."

```sql
INSERT INTO public.agency_announcements
  (agency_id, author_id, title, body, priority, is_active, expires_at)
SELECT
  s.agency_id,
  s.id,
  'Office closed Friday for training',
  'The office will be closed Friday August 15 for team training. Please plan customer meetings accordingly.',
  10,
  true,
  DATE '2026-08-16'
  FROM public.staff s
 WHERE s.id = public.current_staff_id();
```

`priority` is an integer — higher shows first in the announcements list. `expires_at` NULL means the announcement stays active until manually deactivated.

**Deactivate:**

```sql
UPDATE public.agency_announcements
   SET is_active = false
 WHERE id = '…';
```

---

## §4.3 Scoreboard — troubleshooting

**Celebrations tile shows nothing but the producer clearly had a good day** — check the sales_activity rows for the previous business day; `rpc_get_celebrations` requires `activity_date = current_date - 1` (accounting for weekends via calendar function).

**Manager can't set goals** — check `settings.enable_scoreboard_manager_access`. Owner can flip it if manager-set goals are desired.

**Nudge tile is red but activity looks fine** — the nudge is a client-side calculation against `v_sales_activity_weekly_by_producer`. If the trailing 7-day hours are below the trailing 4-week average, the tile flags it. Not a bug — that's the design.

**Duplicate goal error on INSERT** — the unique constraint fired. Look for an existing row matching the same (agency_id, producer_id, goal_type, period_start, period_end). Update it instead of inserting.

---

## §4.5 Handbook — reading the current handbook

**Trigger:** "show me the handbook," "what's the vacation policy," "read section 4."

**Full current handbook:**

```sql
SELECT * FROM public.handbook_get_current(
  p_agency_id := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id())
);
```

Returns all currently-active sections plus version metadata (current version number, effective date, section count). All roles can call.

**Just the current sections:**

```sql
SELECT section_number, title, content, version
  FROM public.v_handbook_current
 ORDER BY section_number;
```

---

## §4.5 Handbook — acknowledging the current version

**Trigger:** "I've read the handbook," "acknowledge my handbook review," "sign off on the policy update."

```sql
SELECT public.handbook_acknowledge(
  p_agency_id  := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id()),
  p_ip_address := NULL
);
```

The `p_ip_address` argument is optional — it's stored on the acknowledgment row for audit. Pass NULL if the calling context doesn't have an IP. The RPC is idempotent: acknowledging the same version twice doesn't create a duplicate row.

**Check own acknowledgment status:**

```sql
SELECT * FROM public.handbook_get_my_ack_status(
  p_agency_id := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id())
);
```

Returns `current_version`, `acknowledged_version` (nullable), `is_current` boolean, and `acknowledged_at`.

---

## §4.5 Handbook — creating or updating a section (owner + authorized manager)

**Trigger:** "add section 5 for social media policy," "update the vacation policy," "amend section 4.2."

The `handbook_upsert_section` RPC handles both create and update. If a row with the same `section_number` already exists, the RPC bumps the version (marking the old row `is_active = false` for history and inserting a new row with `version = old.version + 1`).

```sql
SELECT public.handbook_upsert_section(
  p_agency_id      := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id()),
  p_section_number := 5.0,
  p_title          := 'Social Media Policy',
  p_content        := 'Employees representing the agency on social media…'
);
```

Section numbers use NUMERIC(6,2), so `1.0`, `1.5`, `4.2` are all valid. When adding a new section between existing ones, use a decimal (e.g., `2.5` between `2` and `3`).

**Any edit to any section bumps the acknowledgment version.** After an upsert, everyone's `handbook_get_my_ack_status` will show `is_current = false` until they re-acknowledge. If the change is a typo fix, warn the owner that the team will need to re-acknowledge; if it's material, that's the point.

---

## §4.5 Handbook — deactivating a section (owner + authorized manager)

**Trigger:** "remove the old dress code section," "deactivate section 6.3."

```sql
SELECT public.handbook_deactivate_section(
  p_agency_id  := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id()),
  p_section_id := '…'
);
```

Soft-delete (sets `is_active = false`, preserves history). The RPC returns TRUE if a row was updated, FALSE if no matching active section existed.

---

## §4.5 Handbook — checking team acknowledgment (owner + authorized manager)

**Trigger:** "who hasn't acknowledged the handbook," "show me acknowledgment status."

```sql
SELECT * FROM public.handbook_get_ack_status(
  p_agency_id := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id())
);
```

Returns one row per active staff with `full_name`, `current_version`, `acknowledged_version`, `is_current`, `acknowledged_at`. Filter for stragglers:

```sql
SELECT full_name, current_version, acknowledged_version, acknowledged_at
  FROM public.handbook_get_ack_status(
    p_agency_id := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id())
  )
 WHERE NOT is_current
 ORDER BY full_name;
```

Manager access requires `settings.enable_handbook_manager_access = true` (shipped default).

---

## §4.5 Handbook — how versioning works

**Trigger:** the user asks "why does everyone need to re-acknowledge after I fixed a typo."

The handbook is versioned at the agency level, not per-section. Any edit to any section increments the current handbook version. Acknowledgments record `acknowledged_version` — when the current version bumps, every prior acknowledgment becomes stale (`is_current = false`).

This is a deliberate design choice: it forces a fresh acknowledgment after any change, which is what compliance auditors expect. If the owner wants to avoid version churn on minor edits, batch several small changes into a single session so the version only bumps once.

Section history is preserved via `is_active = false` rows — never deleted. Query `handbook_sections WHERE is_active = false` to see any prior version.

---

## §4.5 Handbook — troubleshooting

**Section upsert with an existing section_number didn't bump the version** — verify the passed `p_agency_id` matches an existing row's `agency_id`. Mismatched agency IDs cause the RPC to insert a new row instead of updating.

**Team acknowledgment status shows the wrong current version** — the version is computed by `v_handbook_current_version` which reads MAX(version) over active rows. If a stale non-active row has a higher version, the MAX is wrong — check for `is_active = false` rows with version numbers exceeding the active set.

**Producer can't acknowledge** — the RPC returns silently on the idempotent path; check `handbook_get_my_ack_status` to confirm the acknowledgment landed.

---

## §4.6 Benefits — viewing active plans

**Trigger:** "what plans do we offer," "show open enrollment options."

**All producers:**

```sql
SELECT * FROM public.benefits_get_active_plans(
  p_agency_id := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id())
);
```

Or via the view:

```sql
SELECT plan_type, plan_name, carrier, effective_date
  FROM public.v_benefit_plans_active
 WHERE agency_id = (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id())
 ORDER BY plan_type, plan_name;
```

Plan types are the standard categories: `medical`, `dental`, `vision`, `life`, `std`, `ltd`, `401k`, `hsa`, `fsa`, `other`.

---

## §4.6 Benefits — viewing own enrollments

**Trigger:** "what am I enrolled in," "show my benefits."

```sql
SELECT * FROM public.benefits_get_my_enrollments(
  p_agency_id := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id())
);
```

Or via the view:

```sql
SELECT plan_type, plan_name, enrollment_tier, election_amount, effective_date, end_date
  FROM public.v_benefits_my_enrollments
 ORDER BY plan_type, effective_date DESC;
```

Enrollment tiers: `employee_only`, `employee_spouse`, `employee_children`, `family`, `waived`.

Producers see only their own enrollments. This module ships with the manager gate at FALSE by default because benefit elections are comp-adjacent PII.

---

## §4.6 Benefits — creating or updating a plan (owner + authorized manager)

**Trigger:** "add the dental plan for 2027," "update the medical carrier."

`benefits_upsert_plan` creates a new plan or replaces an existing active plan with the same `(agency_id, plan_type, plan_name)`. The old plan is deactivated; the new plan starts fresh with a new `effective_date`.

```sql
SELECT public.benefits_upsert_plan(
  p_agency_id      := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id()),
  p_plan_name      := 'Delta Dental PPO',
  p_plan_type      := 'dental',
  p_carrier        := 'Delta Dental',
  p_effective_date := DATE '2027-01-01',
  p_end_date       := NULL
);
```

**Deactivate an existing plan:**

```sql
SELECT public.benefits_deactivate_plan(
  p_agency_id := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id()),
  p_plan_id   := '…'
);
```

---

## §4.6 Benefits — enrolling a staff member (owner + authorized manager)

**Trigger:** "enroll Marcus in the medical plan at employee-only," "update Jenn's dental election to family."

`benefits_upsert_enrollment` ends any active enrollment for the `(staff_id, plan_id)` pair and creates a fresh row. Only the tier and election amount are captured — dependent identities are not (that's HRIS territory).

```sql
SELECT public.benefits_upsert_enrollment(
  p_agency_id       := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id()),
  p_staff_id        := '…',
  p_plan_id         := '…',
  p_enrollment_tier := 'employee_only',
  p_election_amount := 145.00,
  p_effective_date  := DATE '2027-01-01',
  p_end_date        := NULL
);
```

**End an enrollment:**

```sql
SELECT public.benefits_end_enrollment(
  p_agency_id     := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id()),
  p_enrollment_id := '…',
  p_end_date      := DATE '2027-06-30'
);
```

---

## §4.6 Benefits — team enrollment summary (owner + authorized manager)

**Trigger:** "how many are enrolled in medical," "show our participation numbers."

```sql
SELECT * FROM public.benefits_get_enrollment_summary(
  p_agency_id := (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id())
);
```

Or via the view:

```sql
SELECT plan_type, plan_name, enrolled_count, waived_count, employee_only_count, family_count
  FROM public.v_benefits_enrollment_summary
 WHERE agency_id = (SELECT agency_id FROM public.staff WHERE id = public.current_staff_id())
 ORDER BY plan_type, plan_name;
```

Manager access requires `settings.enable_benefits_manager_access = true` (shipped default is FALSE — flip only if the owner wants managers involved in benefits administration).

---

## §4.6 Benefits — why the manager gate defaults FALSE

**Trigger:** the user asks "why can't my office manager see benefits like she can PTO."

Benefits data is comp-adjacent PII — election tier and election amount together are enough to infer a lot about a person's household situation and cost of employment. That's a different sensitivity level than PTO or Sales Activity, which is why this module ships with the manager gate FALSE by default (unlike PTO/Time Tracking/Sales Activity/Handbook/Licenses, which ship TRUE).

If the owner wants manager access, they can flip it:

```sql
UPDATE public.settings
   SET value = 'true'
 WHERE key = 'enable_benefits_manager_access';
```

But the default is intentionally restrictive.

---

## §4.6 Benefits — troubleshooting

**Enrollment insert fails with permission_denied** — check that the caller is owner or manager AND (for managers) that `settings.enable_benefits_manager_access = true`.

**Two active enrollments for the same staff/plan** — `benefits_upsert_enrollment` end-dates any existing active row before inserting the new one. If two active rows exist, someone bypassed the RPC — investigate and manually end-date the older row.

**Election amount looks wrong** — the field stores the employee-paid amount, not the employer contribution. If the owner wants to track employer cost separately, that's a v0.6.x consideration; today's schema is employee-side only.

---

## §4.7 Personnel Files — install prerequisites (READ FIRST)

Personnel Files is the only Premium module that stores document bytes off-database — files live in the **owner's Google Drive**, accessed via **Composio**, with the DB holding only metadata. Before this module is usable, the five install steps in the top-level "Install-time prerequisites" section must be complete:

1. Composio Google Drive connected on the client agent
2. `COMPOSIO_API_KEY` and `COMPOSIO_CONNECTED_ACCOUNT_ID` secrets set on the client Supabase project
3. Private staging bucket `personnel-uploads-temp` created with 24-hour lifecycle
4. `settings.drive_composio_connected = 'true'`
5. `supabase functions deploy personnel-upload`

Verify by opening the Personnel Files module in the webapp. If the install prereqs are not met, the module renders a blocking DriveConnectGate: **"Personnel Files requires Google Drive to be connected via Composio. Ask your Claude to help set this up before using this module."** If you see that gate, walk through the five steps above with the owner before proceeding with any other Personnel Files workflow.

**Folder structure created on demand:**

The Edge Function creates folders lazily as the first document per employee lands:

```
Drive root of connected Google account/
  BCC/
    HR/
      Personnel Records/
        [staff_id]/
          <document files>
```

The `[staff_id]` folder is the UUID of the employee, not their name — this keeps folder names stable across name changes and marriage.

**Employees NEVER get Google Drive access.** All employee interaction with their own file (uploads, reads) goes through the Edge Function and the RPC surface. The Drive folders are visible only to the owner in the Drive UI.

---

## §4.7 Personnel Files — how to help a producer upload a document

**Trigger:** "I need to upload my W-4," "submit my direct deposit form," "put my I-9 on file."

Producer uploads are only allowed for form templates flagged `producer_uploadable = TRUE`. The upload flow does **not** go through a database INSERT — it calls the `personnel-upload` Edge Function, which handles auth, Composio staging, and the Drive upload atomically.

**Client-side flow (which the JSX module implements):**

1. Producer picks a file from the local machine.
2. The webapp POSTs to `POST /functions/v1/personnel-upload` with:
   ```json
   {
     "personnel_file_id": null,
     "target_staff_id": "<current_staff_id>",
     "doc_type": "w4",
     "filename": "w4_2027.pdf",
     "mime_type": "application/pdf",
     "file_bytes_base64": "<base64 payload>"
   }
   ```
3. The Edge Function verifies the caller matches `target_staff_id` (producer can only upload for themselves; owner and gated-manager can upload for any staff).
4. Bytes go to the private staging bucket `personnel-uploads-temp` first, then a 10-minute signed URL is passed to `GOOGLEDRIVE_UPLOAD_FROM_URL` (the FROM_URL variant, not `GOOGLEDRIVE_UPLOAD_FILE`, because the latter has a 5MB cap).
5. On successful Drive upload, the Edge Function INSERTs a `personnel_documents` row with `drive_file_id`, `drive_file_url`, and returns them to the client.
6. The staging bucket object is deleted on success; the 24-hour lifecycle catches orphans from failures.

**What Claude does when a producer asks:** confirm the doc_type (must match a form template with `producer_uploadable = TRUE`), then point them at the Personnel Files module in the webapp. Do NOT try to shortcut this by INSERTing directly into `personnel_documents` — the row will not have a valid Drive file behind it and the reveal RPC will fail.

**Producer uploads are immutable.** Once uploaded, a producer cannot UPDATE or DELETE their own document. Corrections require the owner or a gated manager to soft-delete via `personnel_documents.is_active = false` and the producer re-uploads.

---

## §4.7 Personnel Files — how to help a producer read their own documents

**Trigger:** "show me what's in my personnel file," "did HR receive my I-9."

**Get a metadata summary (no Drive URLs):**

```sql
SELECT * FROM public.rpc_get_personnel_summary(
  p_target_staff_id := public.current_staff_id()
);
```

Returns `staff_full_name`, `document_count`, `latest_upload_at`, and a JSON array of document metadata (`doc_type`, `filename`, `uploaded_at`, `is_verified`) — but not the Drive URLs.

**Reveal a specific document (returns the Drive URL, logs access):**

```sql
SELECT public.rpc_reveal_personnel_document(
  p_document_id := '…',
  p_reason      := 'Checking that my I-9 is on file for the audit'
);
```

Producers can only reveal documents on their own file that have `employee_visible = TRUE`. The RPC logs to `personnel_document_access_log` even on producer self-reveals — that's intentional, for the compliance audit trail.

---

## §4.7 Personnel Files — how to reveal a document (owner + authorized manager)

**Trigger:** "pull up Marcus's W-4," "show me Jenn's I-9."

Owner can reveal any document unconditionally. Manager can reveal only if:

1. `settings.enable_personnel_files_manager_access = true` (global gate — ships FALSE), AND
2. A per-employee grant exists in `personnel_file_manager_grants` for this `manager_staff_id` × `target_staff_id`.

Both conditions must hold. This is the **layered manager gate** — global toggle plus per-employee grant.

**Reveal RPC:**

```sql
SELECT public.rpc_reveal_personnel_document(
  p_document_id := '…',
  p_reason      := 'Payroll audit — verifying withholding elections for Q3 close.'
);
```

**The reason is required, minimum 10 characters, and is logged to `personnel_document_access_log` forever.** The reason field is your legal defense — a substantive reason ("payroll audit," "workers' comp claim documentation," "HR investigation of policy X") reads as legitimate. "Checking" or a blank string reads as snooping and hurts you under audit.

When helping a user reveal, ask for a concrete reason. If they resist ("just curious," "I don't need to say"), don't do the reveal — that's how you get sued.

---

## §4.7 Personnel Files — how to verify a document (owner + authorized manager)

**Trigger:** "mark Marcus's I-9 as verified," "verify the W-4."

Verification is the owner's or gated-manager's flag that they've reviewed the document and it's acceptable (form completed, signature present, etc.).

```sql
SELECT public.rpc_verify_personnel_document(
  p_document_id := '…'
);
```

Sets `is_verified = true`, `verified_by = current_staff_id()`, `verified_at = NOW()`. Only owner or gated manager can call. Once verified, a document cannot be un-verified via RPC — that's intentional (removing the verified flag would be a compliance rewrite; if you truly need to reverse, deactivate the document and re-upload).

---

## §4.7 Personnel Files — reading the file summary

**Trigger:** "how many docs does Marcus have on file," "when did Jenn last upload something."

```sql
SELECT * FROM public.rpc_get_personnel_summary(
  p_target_staff_id := '…'
);
```

Returns non-sensitive metadata: staff name, document count, latest upload timestamp, and a JSON array of `{doc_type, filename, uploaded_at, is_verified, is_active}` — no Drive URLs. Owner and gated manager can call for any employee; producer can call for their own file only.

---

## §4.7 Personnel Files — granting or revoking per-employee manager access (owner-only)

**Trigger:** "let Denise see Marcus's file," "give the manager access to Jenn's records for the workers' comp claim."

**Grant:**

```sql
SELECT public.rpc_grant_manager_personnel_access(
  p_manager_staff_id := '…',   -- the manager receiving access
  p_target_staff_id  := '…',   -- the employee whose file is being opened up
  p_reason           := 'Workers'' comp claim documentation — Denise handling.'
);
```

**Revoke:**

```sql
SELECT public.rpc_revoke_manager_personnel_access(
  p_grant_id := '…'
);
```

Only the owner can grant or revoke. Manager access is meaningless unless `settings.enable_personnel_files_manager_access = true` — the layered gate requires both. This lets the owner grant one manager access to one employee's file for a specific reason (comp claim, HR investigation) without opening all manager access to all files.

Review active grants:

```sql
SELECT g.id, gm.full_name AS manager, t.full_name AS target_employee, g.reason, g.granted_at
  FROM public.personnel_file_manager_grants g
  JOIN public.staff gm ON gm.id = g.manager_staff_id
  JOIN public.staff t  ON t.id  = g.target_staff_id
 WHERE g.is_active = true
 ORDER BY g.granted_at DESC;
```

---

## §4.7 Personnel Files — how the storage model works (Google Drive via Composio)

**Trigger:** the user asks "where is my W-4 actually stored" or "can employees see the Drive folder."

Document bytes live in the owner's Google Drive. The DB stores only:
- `personnel_documents.drive_file_id` — the Google Drive file ID
- `personnel_documents.drive_file_url` — the direct Drive URL (revealed only by the RPC)
- `personnel_documents.filename`, `mime_type`, `uploaded_at`, etc. — metadata

The `personnel-upload` Edge Function bridges Supabase and Composio:
- Authenticated POST → JWT-bound Supabase client verifies the caller
- Bytes → Supabase Storage staging bucket → 10-minute signed URL
- Signed URL → Composio `GOOGLEDRIVE_UPLOAD_FROM_URL` → owner's Drive
- Drive file ID/URL captured → `personnel_documents` INSERT → staging bucket cleanup

**Employees never see the Drive folder.** They interact with their file only through the module (upload) and the reveal RPC (read). This is by design — a shared Drive folder would break the audit model and expose files to accidental deletion. The owner sees the folder tree in Drive if they log into the connected Google account, but employees never do.

---

## §4.7 Personnel Files — troubleshooting

**"Google Drive not connected" gate is blocking the module** — the install prereqs (see top of this doc and above) aren't met. Walk the owner through the five steps.

**"COMPOSIO_API_KEY not set" from the Edge Function log** — the secret didn't get written to the client Supabase project. Set it via the Supabase dashboard's Edge Functions → Secrets, or via CLI: `supabase secrets set COMPOSIO_API_KEY=<key>`. Same for `COMPOSIO_CONNECTED_ACCOUNT_ID`.

**Upload fails with "5MB cap exceeded"** — the Edge Function is calling `GOOGLEDRIVE_UPLOAD_FILE` instead of `GOOGLEDRIVE_UPLOAD_FROM_URL`. This shouldn't happen with the shipped v0.5.8 Edge Function — verify the deployed function code matches `supabase/functions/personnel-upload/index.ts` in the overlay repo.

**Reveal RPC raises permission_denied for a manager** — check both conditions: `settings.enable_personnel_files_manager_access = 'true'` AND a matching row in `personnel_file_manager_grants` with `is_active = true` for this `(manager_staff_id, target_staff_id)` pair. Both are required.

**Reason on reveal rejected as "validation_error"** — the RPC enforces a minimum length (10 characters). Give a substantive reason.

**Producer tries to upload a doc_type that's not `producer_uploadable = TRUE`** — the Edge Function will reject with a 403. Owner needs to update the form template to allow producer uploads, or the doc has to be uploaded by owner/gated-manager.

**Staging bucket has orphaned objects** — that's fine, the 24-hour lifecycle rule cleans them up. If you see thousands of orphans, the Edge Function isn't running its cleanup path — check `supabase logs` for the function.

---

## §4.8 Licenses — a producer records a new license

**Trigger:** "add my new L&H license," "put in my Series 6," "I just got my Ohio P&C."

The `producer_licenses` table stores producer professional credentials (P&C, L&H, Series 6/7/63/65, adjuster, notary, etc.) — never customer PII. One row per `(staff_id, license_type, state)`. Renewals UPDATE the same row rather than INSERT a new one.

```sql
SELECT public.rpc_upsert_producer_license(
  p_staff_id           := public.current_staff_id(),
  p_license_type       := 'life_health',
  p_license_number     := 'LH-1029384',
  p_state              := 'OH',
  p_expiration_date    := DATE '2028-08-05',
  p_issue_date         := DATE '2026-08-05',
  p_ce_hours_required  := 24,
  p_ce_hours_completed := 0,
  p_status             := 'active',
  p_notes              := NULL
);
```

**License types** are one of: `property_casualty`, `life_health`, `series_6`, `series_7`, `series_63`, `series_65`, `series_66`, `series_24`, `adjuster`, `notary`, `other`. `p_state` is the 2-letter state code (or `'US'` for federal/national credentials).

**Producers can upsert their own licenses.** Owner can upsert for any producer unconditionally. Manager can upsert for any producer if `settings.enable_licenses_manager_access = true` (shipped default).

---

## §4.8 Licenses — a producer renews an existing license

**Trigger:** "I renewed my P&C, extend the expiration to 2028," "update my CE hours to 30."

Renewals hit the same RPC — the upsert lands on the existing `(staff_id, license_type, state)` row:

```sql
SELECT public.rpc_upsert_producer_license(
  p_staff_id           := public.current_staff_id(),
  p_license_type       := 'property_casualty',
  p_license_number     := 'PC-1029384',   -- same number
  p_state              := 'OH',
  p_expiration_date    := DATE '2028-06-30',   -- extended
  p_ce_hours_required  := 24,
  p_ce_hours_completed := 24                    -- CE completed
);
```

The record's `updated_at` and `renewed_at` timestamps update automatically. History of renewals is not preserved in this table — if the owner needs a renewal audit trail, that lives in an external system (state DOI portal, etc.).

---

## §4.8 Licenses — a producer removes a license

**Trigger:** "I let my Series 6 lapse, remove it," "delete my Ohio license, I moved to Texas."

```sql
SELECT public.rpc_delete_producer_license(
  p_license_id := '…'
);
```

Producer can delete their own. Owner or gated manager can delete any producer's. The delete is hard — no soft-delete flag on this table — but it's just a professional credential record, not an audit-critical row.

---

## §4.8 Licenses — checking expiring licenses (all roles)

**Trigger:** "which of my licenses are expiring soon," "who's behind on CE," "show upcoming renewals."

The view `v_expiring_licenses` returns any active license expiring in the next 60 days OR with CE hours below the required amount:

```sql
SELECT * FROM public.v_expiring_licenses
 ORDER BY expiration_date;
```

RLS scopes: producers see only their own rows; owner sees all; manager sees all when the toggle is TRUE.

For the owner or manager who wants a per-producer summary:

```sql
SELECT s.full_name, l.license_type, l.state, l.expiration_date,
       l.ce_hours_required, l.ce_hours_completed,
       (l.expiration_date - CURRENT_DATE) AS days_until_expiration
  FROM public.v_expiring_licenses l
  JOIN public.staff s ON s.id = l.staff_id
 ORDER BY l.expiration_date;
```

---

## §4.8 Licenses — how the expiration monitor recipe works

**Trigger:** the user asks "how do I get notified about expiring licenses" or "why did I get this alert."

The recipe **Premium Licenses Expiration Monitor** runs monthly (cron `0 8 1 * *`, first of the month at 08:00 UTC). It scans `v_expiring_licenses` and inserts one row into `public.alerts` per finding:

- License expiring within 60 days → alert of type `license_expiring`
- CE hours below required → alert of type `license_ce_shortfall`

The recipe is idempotent — `ON CONFLICT DO NOTHING` on `(alert_type, staff_id, license_id, alert_month)` means running the recipe twice in the same month is a no-op.

Alerts land in the standard Base `alerts` module, so they surface in the dashboard, email digest, and Telegram (if configured). Producers see their own alerts; owner and gated manager see all.

To run the monitor manually (usually not needed):

```sql
SELECT public.run_due_automation_recipes();  -- Base heartbeat
```

Or trigger the specific recipe via its handler function (name varies — check `automation_recipes` for the `handler_function` column value for this recipe).

---

## §4.8 Licenses — troubleshooting

**"duplicate key value violates unique constraint 'producer_licenses_staff_type_state_uk'"** — the producer already has a row for this `(staff_id, license_type, state)`. Renewals should UPDATE via the RPC, not INSERT — the RPC's UPSERT logic handles that; if you got this error, someone bypassed the RPC.

**Manager can't upsert a producer's license** — check `settings.enable_licenses_manager_access`. Owner can flip it.

**Alerts not firing on expiring licenses** — check `automation_run_log` for the `Premium Licenses Expiration Monitor` recipe. If it's failing, look at the exception message. If it's running successfully but no alerts appeared, verify `v_expiring_licenses` returns rows — the view filters by `status = 'active'`, so a license set to `'lapsed'` won't trigger alerts.

**CE hours look wrong** — the RPC stores whatever the caller passes. There's no CE tracking automation on this module — CE completion is manually tracked. If the CE hours field needs to sync from an external CE provider, that's a v0.6.x consideration.

---

## §4.9 Milestones — viewing upcoming milestones (all roles)

**Trigger:** "who has a birthday coming up," "any anniversaries this month," "show upcoming milestones."

```sql
SELECT * FROM public.v_upcoming_milestones
 ORDER BY milestone_date;
```

Returns the next 60 days of staff milestones — birthdays and service anniversaries — along with acknowledgment status. Birthdays require `staff.birth_date IS NOT NULL`. Service anniversaries require `staff.hire_date IS NOT NULL` and are flagged `is_service_milestone = true` when the anniversary year is a 5-year multiple (5, 10, 15, …).

All active staff can read this view. Note: producers see the whole roster's upcoming milestones by default — this is one of the few Premium modules where non-owner visibility isn't gated, because birthdays and anniversaries aren't sensitive HR data in this context.

---

## §4.9 Milestones — acknowledging a milestone (owner + authorized manager)

**Trigger:** "acknowledge Marcus's 5-year anniversary," "record that we celebrated Jenn's birthday."

```sql
SELECT public.rpc_acknowledge_milestone(
  p_staff_id        := '…',
  p_milestone_type  := 'service_anniversary',   -- or 'birthday'
  p_milestone_date  := DATE '2026-08-05',
  p_notes           := 'Team lunch at Piatti — Marcus loved it.'
);
```

Inserts a row into `milestone_recognitions`. Owner can acknowledge unconditionally. Manager can acknowledge only when `settings.enable_milestones_manager_access = true` (shipped default is FALSE).

---

## §4.9 Milestones — how the monthly reminder recipe works

**Trigger:** the user asks "why did I get a milestone alert" or "how do I get notified."

The recipe **Premium Milestones Monthly Reminder** runs monthly (cron `0 7 1 * *`, first of the month at 07:00 UTC). It scans `v_upcoming_milestones` for the current month and stages alerts in `public.alerts` with type `staff_milestone_upcoming`.

Alerts surface in the Base alerts module. Owner and gated manager see all; individual staff see alerts about their own milestone or team-wide alerts (implementation-dependent — check `alerts.audience` if the behavior looks off).

---

## §4.9 Milestones — troubleshooting

**No milestones showing for a staff member** — check `staff.birth_date` (for birthday milestones) and `staff.hire_date` (for anniversaries). If either is NULL, that milestone type won't appear.

**Manager can't acknowledge** — check `settings.enable_milestones_manager_access`. Flip if desired.

**Duplicate acknowledgment** — the unique constraint on `(staff_id, milestone_type, milestone_date)` prevents duplicates. If the second call raises a unique-violation, the milestone was already acknowledged; treat it as idempotent success.

---

## §4.10 Emergency Contacts — a producer adds their own contact

**Trigger:** "add my mom as an emergency contact," "put in my spouse's info," "update my emergency contacts."

Producers manage their own emergency contacts via standard DML — RLS enforces `staff_id = current_staff_id()` on INSERT, UPDATE, DELETE. There's no dedicated RPC for producer-side operations.

```sql
INSERT INTO public.emergency_contacts
  (staff_id, contact_name, relationship, phone_primary, phone_secondary, email, address, priority)
SELECT public.current_staff_id(),
       'Maria Rodriguez',
       'mother',
       '555-123-4567',
       NULL,
       'maria.rodriguez@email.com',
       '123 Oak St, Columbus, OH 43201',
       1;
```

**Priority** is an ordering hint (1 = call first). Multiple contacts can share the same priority — it's not enforced as unique.

**Soft cap of 10 contacts per producer** — enforced at the application layer, not by DB constraint. If a producer tries to add an 11th contact, the module UI will warn; INSERTs beyond 10 will succeed at the DB level, but the UX guides toward 10 as the practical maximum.

---

## §4.10 Emergency Contacts — a producer edits or removes their own contact

**Trigger:** "my mom's phone changed," "remove my ex from emergency contacts."

```sql
UPDATE public.emergency_contacts
   SET phone_primary = '555-999-1111'
 WHERE id = '…'
   AND staff_id = public.current_staff_id();  -- RLS enforces this too, belt+suspenders

DELETE FROM public.emergency_contacts
 WHERE id = '…'
   AND staff_id = public.current_staff_id();
```

Producers see only their own contacts. They cannot see anyone else's contact list.

---

## §4.10 Emergency Contacts — revealing a staff member's contacts (owner + authorized manager)

**Trigger:** "pull up Marcus's emergency contacts — we have an incident," "who do we call for Jenn."

**Direct SELECT is blocked by RLS.** Owner and gated manager cannot query `emergency_contacts` directly. Access is only via the reveal RPC, which requires a written reason and logs to `emergency_contact_access_log`.

```sql
SELECT public.rpc_reveal_emergency_contacts(
  p_staff_id := '…',
  p_reason   := 'On-shift medical incident — need to contact family before we transport.'
);
```

Returns the full list of active emergency contacts for that staff member, in priority order.

**Manager access:** owner is unconditional; manager only when `settings.enable_emergency_contacts_manager_access = true` (shipped default FALSE). If a manager needs standing access to reveal contacts (e.g., they're the after-hours point person), the owner can flip the setting. Otherwise, revelations are an owner call.

**The reason is required, must be non-empty, and is logged permanently.** Give a real reason. "Just checking" or a blank reason will surface as suspicious under audit. If a manager wants access but can't articulate a real reason, don't do the reveal — that's the whole point of the audit model.

---

## §4.10 Emergency Contacts — reading the reveal audit log (owner-only)

**Trigger:** "who has been looking at emergency contacts," "audit the emergency contact reveals," "show me the access log."

```sql
SELECT
  al.revealed_at,
  rev.full_name AS revealed_by,
  tgt.full_name AS target_staff,
  al.reason
FROM public.emergency_contact_access_log al
JOIN public.staff rev ON rev.id = al.revealed_by_staff_id
JOIN public.staff tgt ON tgt.id = al.target_staff_id
ORDER BY al.revealed_at DESC;
```

Owner sees the full log. Managers don't see the log at all — even if the manager gate for reveals is on, they can perform reveals but not audit them. That asymmetry is intentional (the owner is the auditor, always).

---

## §4.10 Emergency Contacts — why direct SELECT is blocked and no Claude prompts ship

**Trigger:** the user asks "why can't I just query the table" or "why doesn't Claude have any shortcuts for this."

Two reasons:

1. **Direct SELECT would bypass the audit log.** The whole compliance model rests on the fact that every access to family PII creates an audit row. If direct SELECT worked, an owner (or a gated manager) could pull the whole table without leaving a trail.
2. **No Claude prompts ship for this module.** The overlay's `PlaybookGuide.jsx` (Base master, populated during install) intentionally omits Ask Claude seed prompts for Emergency Contacts. That prevents a producer from casually asking "hey Claude, show me my coworker's mom's phone number" and getting an answer through prompt suggestion. Emergency Contacts is the one module where Claude does not proactively volunteer help — reveals only happen through explicit RPC calls initiated by an authenticated owner/manager with a written reason.

Explain this to the user this way: "Family PII is one of the highest-sensitivity data classes in your business. This module treats it that way. If you truly need a contact and can articulate why, the reveal RPC is fast and works. If you can't articulate why, that's a sign not to look."

---

## §4.10 Emergency Contacts — troubleshooting

**Reveal RPC returns permission_denied** — either the caller isn't owner or an authorized manager, or `settings.enable_emergency_contacts_manager_access = false` and the caller is a manager. Owner can flip if needed.

**Reveal RPC returns "reason_required"** — the reason was empty or below the minimum length. Ask the user for a substantive reason and retry.

**Producer tries to SELECT * FROM emergency_contacts and sees only their own rows** — that's correct. Producers can only see their own contacts, and RLS scopes automatically to `staff_id = current_staff_id()`.

**Owner wants to know who's been snooping** — pull the audit log query above. Every reveal is there, with the reason. If a manager has a high count of reveals with vague reasons, that's a conversation to have.

**"insert or update on table 'emergency_contacts' violates row-level security policy"** — a producer tried to INSERT a row with `staff_id` different from their own `current_staff_id()`. The correct pattern is to always set `staff_id := public.current_staff_id()` on producer-side operations.

---

## Where to find more

- **`docs/CLAUDE_MD_briefings_premium.md`** — reference briefings on each module. Read this first when the client's Claude is being briefed on Premium behavior.
- **`docs/PREMIUM_SMOKE_TEST.md`** — executable verification walkthrough. Run after any Premium migration change or when behavior looks wrong.
- **`docs/BASE_VS_PREMIUM_INVENTORY.md`** — inventory of Base features vs Premium additions.
- **`docs/BUILD_PLAN.md`** — architecture and rationale for the overlay.
- **`docs/DRIVE_FOLDER_SETUP.md`** (in Base master) — canonical Google Drive folder structure. Personnel Files uses the `/BCC/HR/Personnel Records/[staff_id]/` subtree.

---

## Design principles that constrain any change

If a client asks Claude to change Premium behavior — "let anyone reveal emergency contacts," "let managers see benefits without a toggle," "let producers edit last month's time entries" — push back and consult these principles before altering RLS, RPC gates, or settings:

- **Producer Isolation Principle (§B.11)** — cross-staff visibility must default closed. Any per-module opt-in should be a `settings` toggle, not a code change.
- **Auto-Provisioning Invariant (§B.12)** — the `staff.status` → auth account state mapping must not be bypassed. Never manually create an auth user without a corresponding staff row.
- **Reveal audit modules** — Personnel Files and Emergency Contacts require a real reason and log every access. Never suppress the audit. Never accept a blank or nominal reason.
- **Compliance-safe schemas** — Time Tracking, Sales Activity, and Scoreboard have no columns for customer PII by design. Do not propose adding customer-identifying columns to these tables. If the client needs customer-linked data, that lives in the CRM, not the compliance-safe modules.
- **Per-client customization is forbidden.** The overlay is the wheel; the client's fork is the vehicle. Local edits to Premium migrations, JSX, RLS policies, or the automation runner drift the client away from the shipped overlay and make future upgrades painful. If the client wants a custom behavior, either propose a new settings toggle for the next overlay version or live with the current shape.

