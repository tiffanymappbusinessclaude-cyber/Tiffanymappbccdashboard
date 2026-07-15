# CLAUDE_MD_briefings_premium.md

**Appended to the client's `CLAUDE.md` during overlay apply (Step 7 of `OVERLAY_APPLY.md`).**

This block briefs the client's Claude on what the Premium overlay adds to the BCC. Reference material — not step-by-step operational prompts (those live in `HANDOFF_PROMPTS.md`).

Overlay version: **v0.5.8** — ships all ten Premium modules (§4 PTO through §4.10 Emergency Contacts).

---

## What the Premium overlay adds

The Premium overlay layers additional module capabilities on top of the Base BCC. This client is running v0.5.8, which ships the following ten modules:

| §    | Module              | Migration | B.11 default |
|------|---------------------|-----------|--------------|
| 4    | PTO                 | 107a–107d | TRUE         |
| 4.1  | Time Tracking       | 101       | TRUE         |
| 4.2  | Sales Activity      | 102       | TRUE         |
| 4.3  | Scoreboard          | 103       | FALSE        |
| 4.5  | Handbook            | 105       | TRUE         |
| 4.6  | Benefits            | 106       | FALSE        |
| 4.7  | Personnel Files     | 109       | FALSE        |
| 4.8  | Licenses            | 108       | TRUE         |
| 4.9  | Milestones          | 112       | FALSE        |
| 4.10 | Emergency Contacts  | 110       | FALSE        |

Plus the auto-provisioning infrastructure (`staff.status` → Supabase Auth account state) shipped in migration 100a and drained by the `Premium Auth Provisioner` recipe.

Section 4.4 is intentionally reserved — do not renumber existing modules to fill it.

---

## Governance invariants

Two invariants govern every Premium module. Every RLS policy, RPC gate, and settings toggle in the overlay derives from one of these. If a client asks Claude to change permission behavior, cross-check the request against both before altering anything.

**Producer Isolation Principle (§B.11).** Cross-staff visibility must default closed. Every module that could reveal one staff member's data to another gates it behind a per-module setting: `enable_<module>_manager_access` in the `settings` table. Office-manager and owner-manager roles are the *only* ones ever considered for cross-staff visibility — producers never see other producers' rows regardless of settings. Four modules ship canonical FALSE (Scoreboard, Personnel Files, Milestones, Emergency Contacts). One ships deliberate FALSE (Benefits — comp-adjacent PII). Five ship deliberate TRUE where the SF office-manager workflow requires cross-staff visibility to function (Time Tracking, Sales Activity, PTO, Handbook, Licenses). The client can flip any of the ten toggles at any time via the `settings` UI — no code change required.

**Auto-Provisioning Invariant (§B.12).** `staff.status = 'active'` implies an enabled Supabase Auth account. Migration 100a's trigger on `staff` enqueues actions to `_pending_auth_actions`; the `Premium Auth Provisioner` recipe drains the queue every minute via `dispatch_premium_auth_provisioner`. Terminated staff (`status = 'terminated'`) have their Auth account disabled but their historical rows retained. Never manually create or delete a Supabase Auth user — always go through a `staff` row transition and let the invariant fire.

---

## Cross-module conventions

Four patterns recur across modules. Recognize them so the client's Claude doesn't have to re-derive from each schema:

**Compliance-safe schemas.** Sales Activity (§4.2), Time Tracking (§4.1), and PTO (§4) all deliberately exclude customer PII by column design. Sales Activity in particular *cannot* store a customer name or policy number — the schema physically prohibits it. If the client asks Claude to "log that Jane Smith bought an auto policy," Claude should log the activity_type and LOB but *never* the customer name.

**Reveal-audit machinery.** Personnel Files (§4.7) and Emergency Contacts (§4.10) both wrap sensitive reads in an audit log. The RPC `rpc_reveal_*` requires a non-empty `p_reason` and writes to a `*_access_log` table before returning the payload. Coach the client that the audit log is a compliance defense — a blank or one-word reason is worse than no reveal.

**Toggle convention.** Every §B.11 setting key follows `enable_<module>_manager_access` in `public.settings`. Value is stored as text `'true'` or `'false'`. To flip a toggle in a query, use `UPDATE settings SET value = 'false' WHERE key = 'enable_benefits_manager_access'` — never modify the schema.

**Layered manager gate (Personnel Files only).** Personnel Files stacks a per-employee grant on top of the global setting: even when `enable_personnel_files_manager_access = 'true'`, a manager still needs an active row in `personnel_file_manager_grants` for each employee they want to view. This is intentional — HR files are the highest-sensitivity data in the overlay.

---

## Display convention for §4 PTO — hours in UI, days in DB

All PTO amounts are stored as **days** in the database (`pto_balances.balance_days`, `pto_requests.total_days`, `pto_policies.accrual_rate_days`) but the webapp displays everything to users in **hours** — the unit insurance agents and their producers naturally think in. The conversion is a flat 1 day = 8 hours. The utility module `src/lib/pto/format.js` centralizes this: `formatDaysAsHours(days)`, `formatRequestDuration(request)`, `formatAfterBalance(balanceDays, requestDays)`. Every PTO JSX file uses these helpers rather than hardcoding the conversion. Same convention should apply anywhere Claude talks about PTO amounts to a user — quote hours, never days.

Policies themselves are described in days ("15 days per year") because that's how HR conversations work. But balances, request durations, and accrual amounts are always hours.

---

## §4 PTO — where the data lives

Three tables (all in `public` schema, all with RLS enforcing §B.11):

- **`pto_policies`** — the accrual rulebook. One or more policies per agency. Columns include `name`, `accrual_pattern` (anniversary/monthly/biweekly/unlimited), `tenure_brackets` (jsonb array of `{years_min, days_per_year}`), `waiting_period_days`, `carryover_type`, `reset_anchor`. Owner-only writes via `rpc_upsert_pto_policy`.
- **`pto_balances`** — current-period balance per staff. One row per (staff, period_start). Updated by `rpc_approve_pto_request` (decrements `balance_days`, bumps `used_this_period`) and `rpc_run_nightly_pto_accrual` (bumps `balance_days` and `accrued_this_period`). Historical periods preserved as separate rows for audit.
- **`pto_requests`** — the request lifecycle. Status transitions: `pending -> approved | denied | cancelled`. Full audit trail via `created_at`, `updated_at`, `approved_by`, `approved_at`, `decline_reason`.

Three views (SECURITY INVOKER — rely on RLS for row filtering):

- **`v_pto_my_balance`** — the current user's own balance record. RLS scopes to `staff_id = current_staff_id()`.
- **`v_pto_my_requests`** — the current user's own request history.
- **`v_pto_admin_roster`** — full staff × balance × pending-request roster. RLS opens to owner and (conditionally) manager.

One aggregate SECURITY DEFINER function:

- **`fn_pto_team_availability_counts(start_date, end_date)`** — returns counts of who's out per day, **no names**. Producers get counts only; owner/manager can additionally query `v_pto_admin_roster` for names.

---

## §4 PTO — how permissions work

Two governance invariants enforced at the database layer, independent of the UI:

**§B.11 gate.** Every active staff sees only their own PTO data. Cross-staff visibility is owner-only by default. Manager access is opt-in via `settings.enable_pto_manager_access` — defaults to `true` per 107a for the SF office-manager workflow, but the client can flip it to `false` if tighter isolation is preferred.

**§B.12 gate.** `staff.status = 'active'` implies an enabled Supabase Auth account. Migration 100a's trigger enqueues actions to `_pending_auth_actions`; the recipe `Premium Auth Provisioner` (in `automation_recipes`) drains the queue every minute via the runner-patched `dispatch_premium_auth_provisioner` orchestrator.

The manager gate helper `public.is_pto_manager()` returns `true` only when the caller has an active manager or office_manager role AND `settings.enable_pto_manager_access = 'true'`. RPC calls that require approval authority (`rpc_approve_pto_request`, `rpc_decline_pto_request`) check this helper directly and raise `permission_denied` when it returns false.

---

## §4 PTO — the RPC surface

For operational how-to including sample calls, see `HANDOFF_PROMPTS.md`. Summary:

- **`rpc_upsert_pto_policy(...)`** — owner-only. Create or update a policy.
- **`rpc_create_pto_request(p_start_date, p_end_date, p_is_half_day, p_half_day_period, p_reason, p_request_type)`** — any authenticated staff. Submits a request for the caller.
- **`rpc_approve_pto_request(p_request_id)`** — owner or authorized manager. Flips status to approved and decrements the balance.
- **`rpc_decline_pto_request(p_request_id, p_reason)`** — owner or authorized manager. Requires a non-empty reason.
- **`rpc_cancel_pto_request(p_request_id)`** — request owner (producer) only, only while status is pending.
- **`rpc_run_nightly_pto_accrual()`** — service_role only. Also invoked by the nightly recipe (see below).

---

## §4 PTO — automation

Two recipes ship in `public.automation_recipes`:

- **Premium Auth Provisioner** — cron `* * * * *`. Drains `_pending_auth_actions` via the runner-patched `dispatch_premium_auth_provisioner` orchestrator. Handles provision on new-active-staff, revoke on termination, restore on rehire. Idempotent via 422 already-registered fallback.
- **Premium PTO Nightly Accrual** — cron `0 6 * * *` (6 AM UTC, roughly 1–2 AM ET). Runs `handler_pto_accrual` which delegates to `rpc_run_nightly_pto_accrual`. Idempotent — a second run same day is a no-op for staff already accrued.

Both recipes fire through Base's `run_due_automation_recipes()` pg_cron heartbeat + `automation-runner` Edge Function. Failures surface in `automation_run_log` — grep by `recipe_name` when troubleshooting.

---

## §4.1 Time Tracking — what it adds

Per-day time entries per producer with start/stop times, break minutes, notes, and derived total hours. The webapp gives producers a clock-in/clock-out surface and gives owners a payroll-adjacent daily and weekly view. This is not payroll — no wages, no rates, no gross-pay math. It's the source-of-truth for hours worked, which the client's Claude can hand to a payroll tool downstream.

Compliance-safe by design: no customer references, no policy references, no PII beyond producer identity.

---

## §4.1 Time Tracking — where the data lives

One table:

- **`time_tracking_entries`** — one row per (producer, work_date). Columns: `start_time`, `end_time`, `break_minutes`, `notes` (150-char cap), `entry_date`. `total_hours` is a generated column: `(end - start) / 3600 - break_minutes / 60`. Producers own their rows; RLS restricts UPDATE and DELETE to `producer_id = current_staff_id() AND entry_date >= now() - interval '7 days'` — older rows are effectively read-only.

Four views (SECURITY INVOKER):

- **`v_time_tracking_my_week`** — the current user's rolling 7-day entries.
- **`v_time_tracking_my_month`** — the current user's month-to-date summary with weekly totals.
- **`v_time_tracking_admin_daily`** — owner/manager view of all producers by day for the current week.
- **`v_time_tracking_admin_weekly`** — owner/manager view of all producers with weekly totals for the last 12 weeks.

---

## §4.1 Time Tracking — how permissions work

**§B.11 gate.** Manager access defaults to `true` per 101 — the SF office-manager workflow requires visibility into producer hours for scheduling and payroll handoff. The client can flip `settings.enable_time_tracking_manager_access` to `false` if the owner wants sole visibility.

Producers always see their own rows. Owner-manager always sees all rows in their agency. Office-manager sees all rows *only* when `is_time_tracking_manager()` returns true (role + settings).

The 7-day edit window is enforced in RLS, not just in the UI. A producer cannot amend a row from three weeks ago even via direct SQL — the RLS policy on UPDATE checks `entry_date >= current_date - 7`.

---

## §4.1 Time Tracking — the RPC surface

Time Tracking is unusually thin on RPCs — most operations are direct INSERT/UPDATE/DELETE on `time_tracking_entries` gated by RLS. For operational how-to see `HANDOFF_PROMPTS.md`. The two ship RPCs:

- **`rpc_upsert_time_entry(p_entry_date, p_start_time, p_end_time, p_break_minutes, p_notes)`** — producer-only, idempotent per (producer, entry_date). Handles the clock-in-clock-out flow and enforces the 7-day edit window at the RPC layer as a second defense.
- **`rpc_delete_time_entry(p_entry_id)`** — producer-only for own rows within the 7-day window, or owner-manager for any row.

Two triggers enforce integrity: `trg_time_tracking_agency` (producer must belong to the same agency as the row) and `trg_time_tracking_touch` (updated_at maintenance).

---

## §4.1 Time Tracking — automation

None. Time Tracking has no scheduled recipes. Everything is producer-driven and evaluated live via views.

---

## §4.2 Sales Activity — what it adds

Producer daily activity ledger — quotes, applications, policies, cross-sells, service calls — with activity type, LOB (line of business), outcome (bound / pending / lost / follow-up), and a premium band (rough dollar range, not exact amount). Feeds Scoreboard (§4.3) for the gamified office view.

This is the flagship compliance-safe module. The schema *physically prohibits* storing customer names, phone numbers, addresses, or policy numbers. The only free-text fields are `internal_reference` (50 chars, meant for the producer's own memory hook like "gym referral") and `notes` (200 chars). UI warnings fire when either approaches its cap.

---

## §4.2 Sales Activity — where the data lives

One table:

- **`sales_activity`** — one row per logged action. Columns: `producer_id`, `agency_id`, `activity_date`, `activity_type` (quote / app / policy / cross_sell / service / follow_up), `lob` (auto / fire / life / health / commercial / bank_life / other), `outcome` (bound / pending / lost / follow_up_scheduled / no_response), `premium_band` (band_0_500 / band_500_1500 / band_1500_5000 / band_5000_plus / na), `internal_reference` (50 chars), `notes` (200 chars). Zero customer PII columns — enforced by design.

Four views (SECURITY INVOKER, all with per-producer isolation via RLS):

- **`v_sales_activity_daily_by_producer`** — rolling 90-day daily counts per producer split by activity_type.
- **`v_sales_activity_weekly_by_producer`** — rolling 12-week per-producer per-LOB with bound/pending counts.
- **`v_sales_activity_monthly_by_producer`** — rolling 12-month per-producer per-activity-type / LOB / outcome. This is the view Scoreboard drives from.
- **`v_sales_activity_outcome_distribution`** — current-month outcome percentages per producer.

---

## §4.2 Sales Activity — how permissions work

**§B.11 gate.** Manager access defaults to `true` per 102 — this is a deliberate deviation because the SF office-manager workflow assumes visibility into producer activity for coaching and pipeline management. Client can flip `settings.enable_sales_activity_manager_access` to `false` for stricter isolation.

Producers see only their own rows via RLS. Owner-manager sees all rows in their agency. Office-manager sees all rows when `is_sales_activity_manager()` returns true.

Two aggregate helpers escape §B.11 by design — they return *agency-wide totals with no per-producer names*, safe for all authenticated callers:

- **`get_office_activity_weekly(p_agency_id)`** — last 7 days, totals only.
- **`get_office_activity_monthly(p_agency_id)`** — month-to-date, totals only.

Both power the Scoreboard "office-wide" tiles that every producer can see.

---

## §4.2 Sales Activity — the RPC surface

For operational how-to see `HANDOFF_PROMPTS.md`. Summary:

- **`is_sales_activity_manager()`** — helper. Returns true when caller is an active office-manager AND the setting is enabled.
- **`get_office_activity_weekly(p_agency_id)`** — aggregate helper. Any authenticated caller, no per-producer breakdown returned.
- **`get_office_activity_monthly(p_agency_id)`** — same shape, month-to-date.

Direct INSERT/UPDATE on `sales_activity` gated by RLS handles logging. UPDATE window is 7 days by convention (mirrors Time Tracking), enforced in RLS.

Two triggers: `trg_sales_activity_producer_agency` (agency scope) and `trg_sales_activity_touch_updated_at` (touch).

---

## §4.2 Sales Activity — automation

None. Everything is producer-driven. The views recompute live.

---

## §4.3 Scoreboard — what it adds

A live agency-wide "game board" surface: personal progress bars tied to Milestones (§4.9), office-wide aggregate tiles powered by Sales Activity (§4.2) helpers, congratulatory login mechanics when a producer's own trend line ticks up, and an owner-manager-writable announcements strip. Consumes Sales Activity data — ships no producer PII of its own.

The animated login-celebration UI is intentional: it's a small dopamine hit on activity-logged days, and it's designed to make producers *want* to keep the Sales Activity ledger current.

---

## §4.3 Scoreboard — where the data lives

Scoreboard has almost no data of its own — it's an aggregation surface. Two tables:

- **`scoreboard_announcements`** — owner/manager-authored strip messages with `starts_at`, `ends_at`, `body_text` (280-char cap), `priority`. Producers read active rows only.
- **`scoreboard_login_events`** — one row per producer login used to compute streak counters and drive celebration triggers. Trimmed to 90 days by trigger.

No views. Scoreboard reads from Sales Activity views (§4.2) and Milestones views (§4.9) directly.

---

## §4.3 Scoreboard — how permissions work

**§B.11 gate.** Manager access defaults to `false` per 103 — Scoreboard follows the canonical §B.11 default because there is no operational reason for office managers to see the announcements-authoring surface (owner-only by default). The setting `enable_scoreboard_manager_access` opens the announcements author UI to managers when flipped.

Producers can always read active announcements and their own login events. They can never read another producer's login stream. `is_scoreboard_manager()` gates the write path for announcements.

---

## §4.3 Scoreboard — the RPC surface

For operational how-to see `HANDOFF_PROMPTS.md`. One RPC:

- **`rpc_upsert_scoreboard_announcement(p_id, p_body_text, p_starts_at, p_ends_at, p_priority)`** — owner or authorized manager. Idempotent by `p_id` (nullable — omit for new).

Four triggers: agency-scope enforcement on both tables, touch triggers on updated_at, and one that trims `scoreboard_login_events` to the last 90 days on each INSERT.

---

## §4.3 Scoreboard — automation

None on the DB side. The UI polls Sales Activity and Milestones views on a short interval; there are no scheduled recipes.

---

## §4.5 Handbook — what it adds

Agency-owned employee handbook with versioned sections, an acknowledgment-tracking system (every staff signs off on the current version), and a Q&A layer that lets producers ask policy questions of the handbook itself. The handbook lives in the database as structured text — not as an uploaded PDF — so it's queryable, updatable in place, and always current.

The Q&A layer is what makes this distinctly Premium: producers can type "what's our bereavement policy" and get a scoped answer from the current handbook version.

---

## §4.5 Handbook — where the data lives

Two tables:

- **`handbook_sections`** — versioned handbook content. Columns: `agency_id`, `slug` (bereavement / dress_code / hours / etc.), `title`, `body_markdown`, `version_number`, `is_current`, `effective_date`. New versions insert a new row and flip `is_current`; historical versions retained.
- **`handbook_acknowledgments`** — one row per (staff, version_number) marking that a staff member acknowledged the handbook at that version. Old acknowledgments preserved when a new version ships — the UI can then surface "you last acknowledged v3; current is v4" to producers.

Three views:

- **`v_handbook_current`** — the current version of every section joined into a single readable payload. RLS opens to all authenticated staff in the agency.
- **`v_handbook_my_acknowledgment_status`** — the caller's own acknowledgment state.
- **`v_handbook_admin_ack_roster`** — full staff × current-version acknowledgment status. Owner/manager scope.

---

## §4.5 Handbook — how permissions work

**§B.11 gate.** Manager access defaults to `true` per 105 — office managers routinely enforce handbook policy and need visibility into who has and hasn't acknowledged the current version. `settings.enable_handbook_manager_access` toggles.

All authenticated staff can read `v_handbook_current` (the handbook is agency-public by design). Only owner or authorized manager can write sections. Only the caller can write their own acknowledgment. The gate helper is `is_handbook_manager()`.

---

## §4.5 Handbook — the RPC surface

For operational how-to see `HANDOFF_PROMPTS.md`. Summary:

- **`rpc_upsert_handbook_section(p_slug, p_title, p_body_markdown, p_effective_date)`** — owner or authorized manager. Creates a new version row, flips `is_current`.
- **`rpc_publish_handbook_version(p_effective_date)`** — owner-only. Bumps the agency's `handbook_version_number` and requires all staff to re-acknowledge.
- **`rpc_acknowledge_handbook(p_version_number)`** — caller-only. Writes an acknowledgment row for the caller.
- **`rpc_query_handbook(p_question TEXT)`** — any authenticated staff. Returns matching section slugs and body text; the UI/Claude client can synthesize an answer from the returned sections.
- **`rpc_get_handbook_ack_status(p_target_staff_id)`** — owner or manager. Returns acknowledgment history for a specific staff.
- **`rpc_get_handbook_ack_roster()`** — owner or manager. Returns the full roster.

One trigger: `trg_handbook_sections_touch` maintains updated_at.

---

## §4.5 Handbook — automation

None. Handbook doesn't ship scheduled recipes — reminders about unacknowledged versions are UI-driven on login.

---

## §4.6 Benefits — what it adds

Staff-facing benefits ledger — health, dental, vision, 401(k), commuter, other — with per-staff enrollment records, employer/employee contribution amounts, and effective/end dates. Not a benefits *administration* system (no enrollment forms, no carrier integration) — it's a source-of-truth ledger so the client and their Claude know who's enrolled in what at any point in time.

Benefits is comp-adjacent: contribution amounts count as compensation data. Handled with matching sensitivity.

---

## §4.6 Benefits — where the data lives

Two tables:

- **`benefit_types`** — the catalog. Columns: `agency_id`, `name`, `category` (health / dental / vision / retirement / commuter / other), `is_active`. Populated by owner.
- **`benefit_enrollments`** — one row per (staff, benefit_type) enrollment period. Columns: `staff_id`, `benefit_type_id`, `enrolled_at`, `ended_at`, `employer_contribution_monthly`, `employee_contribution_monthly`, `notes` (200 chars).

Three views:

- **`v_benefits_my_enrollments`** — the caller's own enrollment records.
- **`v_benefits_admin_current`** — all currently active enrollments across the agency. Owner/manager scope.
- **`v_benefits_admin_history`** — full enrollment history with computed enrollment-duration months.

---

## §4.6 Benefits — how permissions work

**§B.11 gate.** Manager access defaults to `false` per 106 — this is a deliberate deviation because contribution amounts are comp-adjacent PII and the default assumption is owner-only visibility. Client can flip `settings.enable_benefits_manager_access` to `true` when the office manager is also the HR-of-record.

Producers see only their own enrollments via RLS. Owner sees all. Manager sees all when the gate is enabled. Gate helper is `is_benefits_manager()`.

---

## §4.6 Benefits — the RPC surface

For operational how-to see `HANDOFF_PROMPTS.md`. Summary:

- **`rpc_upsert_benefit_type(p_id, p_name, p_category, p_is_active)`** — owner-only. Manage the agency's benefits catalog.
- **`rpc_enroll_benefit(p_staff_id, p_benefit_type_id, p_enrolled_at, p_employer_monthly, p_employee_monthly, p_notes)`** — owner or authorized manager. Opens a new enrollment.
- **`rpc_end_benefit_enrollment(p_enrollment_id, p_ended_at)`** — owner or authorized manager. Closes an enrollment (does not delete).
- **`rpc_update_benefit_contribution(p_enrollment_id, p_employer_monthly, p_employee_monthly, p_effective_date)`** — owner or authorized manager. Records a contribution change as a new row and closes the prior one.
- **`rpc_get_benefit_summary(p_target_staff_id)`** — caller for own record, owner-manager for any. Returns current active benefits.
- **`rpc_get_agency_benefit_roster()`** — owner or authorized manager. Full roster of who is enrolled in what.
- **`rpc_get_benefit_type_catalog()`** — any authenticated staff. Returns active benefit types.

Two triggers: agency-scope enforcement on `benefit_enrollments`, touch on both tables.

---

## §4.6 Benefits — automation

None. All changes are owner or manager-driven and evaluated live.

---

## §4.7 Personnel Files — what it adds

Employee document management: the wrapper for I-9, W-4, offer letters, licenses, certifications, disciplinary notes, and agency-defined form templates. File bytes live in the owner's Google Drive (never in Supabase Storage); the database holds only metadata plus a `drive_file_id` reference. Every read of an actual document goes through a reveal-audit path.

This is the highest-sensitivity module in the overlay. Every design decision — layered manager gate, immutable producer uploads, per-employee grants, reveal audit — exists because HR files are the artifact class where a leak is unrecoverable.

---

## §4.7 Personnel Files — the storage model

Files do **not** live in the Supabase project. When a producer uploads a document, the file bytes route through a Supabase Edge Function → Composio → the *owner's* Google Drive, into a folder hierarchy at `/BCC/HR/Personnel Records/[staff_id]/`. Only the `drive_file_id` and metadata (filename, doc_type, uploader, uploaded_at) come back to the database.

Employees never gain direct Google Drive access. When an employee needs to view their own document, the reveal flow fetches a short-lived signed link from Drive through the edge function and returns it. When a manager reveals a document, same flow — plus an entry in `personnel_document_access_log`.

The Composio connection to Google Drive is a **prerequisite for install**: `settings.drive_composio_connected = 'true'` must be set, secrets `COMPOSIO_API_KEY` and `PERSONNEL_DRIVE_ROOT_FOLDER_ID` must exist in Edge Function config, and `supabase functions deploy personnel-files-bridge` must have run. If any of those are missing, uploads fail with `edge_function_missing` and reads fall through to metadata-only.

---

## §4.7 Personnel Files — where the data lives

Five tables:

- **`personnel_files`** — one wrapper record per (agency, staff). Ties the employee to the file namespace.
- **`personnel_documents`** — one row per uploaded document. Columns: `file_id`, `doc_type` (i9 / w4 / offer_letter / license / certification / performance / disciplinary / other), `filename`, `drive_file_id`, `uploaded_by`, `uploaded_at`, `is_producer_uploadable`, `is_employee_visible`, `is_verified`, `verified_by`, `verified_at`, `is_active` (soft-delete flag).
- **`personnel_form_templates`** — agency-configurable blank fillable-form URLs. Columns: `agency_id`, `doc_type`, `template_url`, `is_active`, `created_by`.
- **`personnel_file_manager_grants`** — per-employee overrides. Columns: `manager_staff_id`, `target_staff_id`, `granted_by`, `granted_at`, `granted_reason`, `revoked_at`, `is_active`. This is the layered gate on top of the global setting.
- **`personnel_document_access_log`** — immutable reveal audit trail. Columns: `document_id`, `revealed_by`, `revealed_at`, `reason`. Insert-only — no UPDATE or DELETE policy.

No views. Data access always goes through RPCs so the reveal-audit path can't be bypassed.

---

## §4.7 Personnel Files — how permissions work

**§B.11 gate.** Manager access defaults to `false` per 109 — this is the canonical §B.11 default because HR files are the highest-sensitivity data in the overlay. Even when `settings.enable_personnel_files_manager_access` is flipped to `true`, the layered per-employee grant still applies.

**Layered manager gate.** For a manager to view an employee's personnel file, both must be true: (a) `enable_personnel_files_manager_access = 'true'` (global), and (b) an active row in `personnel_file_manager_grants` where `manager_staff_id = current_staff_id() AND target_staff_id = <employee>`. The global setting *permits* per-employee grants; the grants themselves *authorize* specific views. Owner always sees everything.

**Producer uploads are immutable.** RLS on `personnel_documents` blocks UPDATE and DELETE from producer-role callers. Producers upload once; corrections happen via new versions or owner intervention. Soft-delete via `is_active = false` for genuine mistakes — the row and Drive file are retained.

**Reveal audit.** Every call to `rpc_reveal_personnel_document` writes to `personnel_document_access_log` before returning the Drive URL. The `p_reason` parameter is required and validated non-empty at the RPC layer. Reveal history is queryable by owner only.

Gate helper is `is_personnel_files_manager()` — used as one input to the layered check, never as the sole authorization.

---

## §4.7 Personnel Files — the RPC surface

For operational how-to see `HANDOFF_PROMPTS.md`. Summary:

- **`rpc_reveal_personnel_document(p_document_id, p_reason)`** — caller for own visible docs, owner or gated manager for any. Writes to access log, returns short-lived Drive URL. `p_reason` required.
- **`rpc_verify_personnel_document(p_document_id)`** — owner or gated manager. Marks a document as verified (does not touch the file).
- **`rpc_get_personnel_summary(p_target_staff_id)`** — any layered-authorized caller. Returns metadata (doc_type / uploaded_at / is_verified), never Drive URLs.
- **`rpc_grant_manager_personnel_access(p_manager_staff_id, p_target_staff_id, p_reason)`** — owner-only. Opens a per-employee grant.
- **`rpc_revoke_manager_personnel_access(p_grant_id)`** — owner-only. Closes a grant (does not delete the row — sets `revoked_at`).

Uploads happen through the Edge Function, not through an RPC, because file bytes traverse Composio.

Eight triggers enforce integrity: agency-scope on all five tables, touch on the three mutable tables, visibility default on `personnel_documents` insert.

---

## §4.7 Personnel Files — automation

None on the DB side. Everything is manual and audit-first by design. There is no scheduled recipe that reads or reveals documents.

---

## §4.8 Licenses — what it adds

State insurance license tracking per staff — license number, state, LOB, issue date, expiration date, continuing-education requirement flags. Feeds a nightly expiration-scan recipe that flags licenses coming due in the next 30 / 60 / 90 days.

This is the module SF office managers use most often after PTO. State licensing is high-stakes compliance — a producer working with an expired license is a liability event — and this is the schema that catches it before it happens.

---

## §4.8 Licenses — where the data lives

One table:

- **`staff_licenses`** — one row per (staff, state, lob). Columns: `staff_id`, `license_number`, `state`, `lob` (auto / fire / life / health / commercial / p_and_c_combined / other), `issue_date`, `expiration_date`, `ce_credits_required`, `ce_credits_completed`, `notes`, `is_active`.

One view:

- **`v_licenses_expiration_watch`** — all active licenses in the caller's agency with computed `days_until_expiration` and `expiration_bucket` (past_due / lt_30 / lt_60 / lt_90 / more_than_90). Owner and authorized manager see all rows; producers see only their own.

---

## §4.8 Licenses — how permissions work

**§B.11 gate.** Manager access defaults to `true` per 108 — office managers routinely track CE compliance and expiration for the whole office. `settings.enable_licenses_manager_access` toggles.

Producers see only their own licenses. Owner sees all. Manager sees all when the gate is enabled. Gate helper is `is_licenses_manager()`.

---

## §4.8 Licenses — the RPC surface

For operational how-to see `HANDOFF_PROMPTS.md`. Summary:

- **`rpc_upsert_staff_license(p_id, p_staff_id, p_state, p_lob, p_license_number, p_issue_date, p_expiration_date, p_ce_credits_required, p_ce_credits_completed, p_notes)`** — owner or authorized manager. Idempotent by `p_id` (nullable — omit for new).
- **`rpc_deactivate_staff_license(p_license_id)`** — owner or authorized manager. Sets `is_active = false`. Does not delete.

No triggers ship for this module — data-integrity is enforced by CHECK constraints and RLS alone.

---

## §4.8 Licenses — automation

One recipe:

- **Premium Licenses Expiration Watch** — cron `0 7 * * *` (7 AM UTC, roughly 2–3 AM ET). Runs `handler_licenses_expiration_watch` which reads `v_licenses_expiration_watch` and inserts alerts to `public.alerts` for any row in the `lt_30 / lt_60 / lt_90 / past_due` buckets that doesn't already have a live alert. Idempotent by (license_id, expiration_bucket).

Failures surface in `automation_run_log` — grep by `recipe_name = 'Premium Licenses Expiration Watch'` when troubleshooting.

---

## §4.9 Milestones — what it adds

Personal goal tracking per producer: monthly targets across metrics like quotes-per-day, apps-per-week, MTD premium, cross-sell count. Milestones set the numbers; Sales Activity (§4.2) supplies the actuals; Scoreboard (§4.3) draws the progress bars.

Producers own their milestones — this is a self-improvement surface, not a management-imposed quota system. Owner can seed defaults; producers accept or adjust.

---

## §4.9 Milestones — where the data lives

One table:

- **`staff_milestones`** — one row per (staff, metric, month). Columns: `staff_id`, `metric` (quotes_per_day / apps_per_week / mtd_premium_dollars / cross_sells_per_month / follow_ups_per_week / custom), `target_value` (numeric), `month_start` (date), `is_active`, `notes`.

One view:

- **`v_milestones_my_current`** — the caller's own active milestones for the current month with computed `actual_value` pulled from Sales Activity views and `percent_complete`. RLS scopes to owner.

---

## §4.9 Milestones — how permissions work

**§B.11 gate.** Manager access defaults to `false` per 112 — canonical §B.11 default. Milestones are personal goals; the assumption is that other people don't need to see another producer's targets. Owner can always see all. Manager gets visibility when `settings.enable_milestones_manager_access` is flipped to `true`. Gate helper is `is_milestones_manager()`.

Producers write only their own milestone rows. Owner can seed defaults across producers.

---

## §4.9 Milestones — the RPC surface

For operational how-to see `HANDOFF_PROMPTS.md`. Summary:

- **`rpc_upsert_staff_milestone(p_id, p_staff_id, p_metric, p_target_value, p_month_start, p_is_active, p_notes)`** — caller for own rows, owner for any. Idempotent by `p_id` (nullable — omit for new).

Just the one. Milestones is deliberately the simplest module in the overlay — the value comes from Scoreboard visualizing the data, not from complex RPCs.

---

## §4.9 Milestones — automation

One recipe:

- **Premium Milestones Monthly Rollover** — cron `0 8 1 * *` (first day of month, 8 AM UTC). Runs `handler_milestones_monthly_rollover` which copies the prior month's active milestone rows into the new month (preserves targets, resets tracking). Idempotent per (staff, metric, month).

Producers can adjust or deactivate copied milestones at any time.

---

## §4.10 Emergency Contacts — what it adds

Staff emergency-contact records — name, relationship, phone, whether they're OK to contact for medical decisions. Read via a reveal-audit path parallel to Personnel Files (§4.7): every non-owner read logs to an access log with a required reason.

Compliance framing: this is the artifact class you need on the day someone gets in a car accident. It's also the artifact class where casual browsing by anyone other than the owner is a policy violation.

---

## §4.10 Emergency Contacts — where the data lives

Two tables:

- **`emergency_contacts`** — one row per (staff, contact_ordinal). Columns: `staff_id`, `contact_ordinal` (1 = primary / 2 = secondary), `contact_name`, `relationship`, `phone_primary`, `phone_secondary`, `email`, `is_ok_medical_decisions`, `notes`, `is_active`.
- **`emergency_contact_access_log`** — immutable reveal audit trail. Columns: `staff_id`, `revealed_by`, `revealed_at`, `reason`. Insert-only.

No views. All reads go through RPC so the reveal-audit path can't be bypassed.

---

## §4.10 Emergency Contacts — how permissions work

**§B.11 gate.** Manager access defaults to `false` per 110 — canonical §B.11 default. Emergency contact information is high-sensitivity even inside the agency. `settings.enable_emergency_contacts_manager_access` toggles.

Producers can always read and update *their own* contact rows without triggering the reveal log — that's editing your own record, not accessing someone else's. Owner can read anyone's without logging. Gated manager reads anyone's *with* a reveal-log entry. Gate helper is `is_emergency_contacts_manager()`.

The reveal-log entry is written by the RPC *before* the row is returned, so an interrupted call still leaves a trace of the attempt.

---

## §4.10 Emergency Contacts — the RPC surface

For operational how-to see `HANDOFF_PROMPTS.md`. Summary:

- **`rpc_reveal_emergency_contacts(p_target_staff_id, p_reason)`** — owner or authorized manager for any target. Writes to `emergency_contact_access_log`, returns full contact rows. `p_reason` required and validated non-empty.

Just the one RPC. Producers writing their own rows use direct INSERT/UPDATE gated by RLS — no RPC needed for self-service.

---

## §4.10 Emergency Contacts — automation

None. No scheduled recipes. Reveal is manual by design — an automated reveal would defeat the audit purpose.

---

## Reference docs in this repo

For deep operational how-to per module (client-Claude workflow prompts, producer/owner/manager flows, cancel-correct patterns, troubleshooting), always start with:

- **`docs/HANDOFF_PROMPTS.md`** (Base) and **`docs/HANDOFF_PROMPTS_premium.md`** (Overlay) — the client-Claude playbook. Every RPC has a walk-through with sample calls, expected errors, and the human-facing framing to use.

Reference material beyond this file:

- **`docs/PREMIUM_SMOKE_TEST.md`** — executable verification walk-through. Run after any Premium migration change or if any Premium behavior looks wrong. Covers §B.11 checks (producer isolation, manager gates), §B.12 checks (auto-provisioning end-to-end), and per-module happy-path smoke tests.
- **`docs/BASE_VS_PREMIUM_INVENTORY.md`** — inventory of what Base ships vs what Premium adds. Reference this when the client asks "is that a Base feature or a Premium feature."
- **`docs/BUILD_PLAN.md`** — architectural design decisions and the historical context for the ratified module shapes. Consult when a client asks *why* a module works the way it does (e.g., why Personnel Files uses Google Drive instead of Supabase Storage).
- **`docs/PROMO_TO_BUILD_SPEC.md`** — the alignment reference between marketing promises and shipped features. Use if the client cites a promo that doesn't seem to match what they see in the webapp.
- **`docs/DRIVE_FOLDER_SETUP.md`** (Base) — the canonical Google Drive folder structure. Personnel Files (§4.7) relies on the HR sub-tree; the general document workflow uses `BCC/Documents/YYYY-MM/<category>/<filename>`.
- **`migrations/README.md`** — migration application order and provenance-stamp requirements. Consult before shipping any overlay upgrade.

---

## Design principles that constrain any change to Premium

If the client asks Claude to change Premium behavior, cross-check the request against these principles before altering RLS, RPCs, gates, or schema. When a request would violate one, push back and propose an alternative that fits.

- **Producer Isolation Principle (§B.11)** — cross-staff visibility must default closed. Any per-module opt-in is a `settings` toggle, not a code change. If the client wants "let managers see everyone's PTO," the answer is *flip the toggle*, not modify RLS.

- **Auto-Provisioning Invariant (§B.12)** — the `staff.status` → Supabase Auth account state mapping must not be bypassed. Never manually create or delete an Auth user without a corresponding `staff` row transition.

- **Compliance-safe schemas are permanent** — Sales Activity (§4.2), Time Tracking (§4.1), and PTO (§4) exclude customer PII by column design. If the client wants to "just add a customer name field to Sales Activity," decline and explain: the schema is what makes the module compliance-safe. Log to a separate customer-scoped module if that's the need.

- **Reveal-audit machinery is not optional** — Personnel Files (§4.7) and Emergency Contacts (§4.10) log every non-owner read with a required reason. Never propose bypassing the reveal log "just for a quick check." The audit log is a compliance defense.

- **Personnel Files layered gate is not a bug** — the double gate (global setting + per-employee grant) is intentional and matches how HR files should be handled. Do not propose collapsing it to a single toggle.

- **Per-client customization is forbidden** — the overlay is the wheel; the client's fork is the vehicle. Local edits to Premium migrations, JSX, or the automation runner drift the client away from the shipped overlay and make future upgrades painful. If the client wants a custom behavior, propose a new settings toggle for the next overlay version or live with the current shape.

- **Immutability where it ships** — producer uploads in Personnel Files (§4.7) and reveal audit logs across all modules are insert-only by RLS. Do not propose UPDATE or DELETE policies on these tables even for "cleanup" reasons. The overlay's compliance posture depends on them staying insert-only.
