# PREMIUM_INSTALL_NEXT_STEPS.md

**Read this first.** This document is a prompt for the client's own Claude — the Project Claude assigned to this Business Command Center repo. It walks through the final steps required to complete the Premium overlay installation that Imaginary Farms has just pushed into this repo.

Do not skip steps. Do not reorder them. If any step returns an unexpected result, STOP and email `rebecca.coelho@imaginary-farms.com` before continuing.

---

## Version: v1.1.3 (2026-07-15 hotfix)

**If you previously started a v1.1.2 install and it stopped with `ERROR: 42P01: relation "public._install_provenance" does not exist`, you are in the exact scenario this v1.1.3 hotfix addresses.** Pull the latest files from this repo (which you already have if you're reading this updated document), then follow the steps below from the top. The BEGIN/COMMIT in `100a` rolled back atomically, so there is no partial state to clean up — resume from Step 1 clean.

---

## What just landed in this repo

Imaginary Farms just pushed the **BCC Premium overlay v1.1.3**, which extends the Base BCC with 10 new modules (Time Tracking, Sales Activity, Scoreboard, PTO, Handbook, Benefits, Personnel Files, Licenses, Milestones, Emergency Contacts) plus the shared auto-provisioning infrastructure they depend on.

**Additive content — already in place, no action required from you:**

- `supabase/migrations/100_base_compat_shim.sql` and 18 more Premium migrations (all in the `100–199` namespace, all idempotent)
- 13 new module JSX files in `src/modules/` (Benefits, EmergencyContacts, EmergencyContactsMine, Handbook, Licenses, Milestones, PTOAdmin, PTOMine, PTOPolicies, PersonnelFiles, SalesActivity, Scoreboard, TimeTracking)
- 2 new shared components in `src/components/` (PTOPendingTile, PTOMonthCalendar)
- 2 new lib files in `src/lib/` (useMyProfile.js, pto/format.js)
- 4 reference docs in `docs/` (BASE_VS_PREMIUM_INVENTORY, PREMIUM_SMOKE_TEST, HANDOFF_PROMPTS_premium, CLAUDE_MD_briefings_premium)

**Reference material for the three splice edits — you complete these:**

- `premium-patches/OVERLAY_APPLY.md` — the master procedure written by Imaginary Farms' Setup Claude
- `premium-patches/nav-patch/` — reference for the BCCApp.jsx splice
- `premium-patches/runner-patch/` — reference for the automation-runner splice
- `premium-patches/dashboard-patch/` — reference for the Dashboard.jsx splice

---

## Your task, in order

### Step 1a — Apply the Base compatibility shim FIRST

**Do not skip this step.** It exists because your Base BCC may pre-date `bcc-master-template @ 041b4321` (fresh Bases installed after 2026-07-06 have all required prerequisites; Bases hand-installed earlier may be missing `public._install_provenance`, may use divergent `staff.role` labels, or may have a Base-shipped `is_current_user_owner()` helper the Premium RLS needs to delegate to).

Apply `supabase/migrations/100_base_compat_shim.sql` against this client's Supabase project via the Supabase MCP `apply_migration` tool or the SQL editor. The migration:

- Creates `public._install_provenance` if entirely absent (fresh Bases: no-op).
- Adds `public.staff.full_name` as a GENERATED column derived from `first_name` + `last_name`.
- Widens `_install_provenance` with `event_type` and `event_data` columns for the overlay event log.
- Creates `public.get_current_role_is_owner()` as a dispatcher: if this Base ships `public.is_current_user_owner()`, the new function delegates to it (keeping Premium RLS aligned with Base RLS); otherwise it uses a widened role match accepting `'Owner / Agent'`, `'owner_producer'`, `'producer_licensed'`, `'Owner'`, and `'Agent'`.
- Adds `UNIQUE` indexes on `public.alerts` and `public.automation_recipes` for overlay `ON CONFLICT` clauses.

After it runs, verify:

- `SELECT COUNT(*) FROM public._install_provenance;` returns `>= 1` (a row was inserted logging that this migration applied).
- `SELECT public.get_current_role_is_owner();` returns `false` or `NULL` without error when called from the service_role context (there is no `auth.uid()` in that context).
- `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='staff' AND column_name='full_name';` returns one row.

If any of those fail, STOP and email `rebecca.coelho@imaginary-farms.com` with the full error before continuing.

### Step 1b — Apply migration 100a (auto-provisioning prerequisite)

Migration `supabase/migrations/100a_premium_auto_provisioning.sql` is the auto-provisioning prerequisite. Every other Premium migration depends on it. Apply it now.

After it runs, verify:

- `_pending_auth_actions` table exists.
- `trg_staff_auth_lifecycle` trigger is bound to `public.staff`.
- `_install_provenance.overlay_version` is set to `'1.1.3'` (or the version you're installing).

If any of those are missing, do not proceed. Investigate.

### Step 2 — Apply the remaining 17 migrations in this order

Numeric order per the design doc: 100b, 100c, 100e, 101, 102, 103, 105, 106, 107a, 107b, 107c, 107d, 107e, 108, 109, 110, 112.

Every migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING`, guarded `ADD COLUMN`). Safe to re-run if anything fails partway.

**Migrations 100c and 107d contain `{{agency_id}}` placeholders.** Substitute this client's actual `AGENCY_ID` (read it from `.env` or the `agency_settings` table) before applying those two.

### Step 3 — Splice the auth provisioner into automation-runner (runner-patch)

Read `premium-patches/runner-patch/RUNNER_PATCH.md` in full. It gives you the anchor patterns and two-edit sequence for splicing `premium-patches/runner-patch/auth_provisioner.ts` into `supabase/functions/automation-runner/index.ts`.

You will:
1. Append the entire `auth_provisioner.ts` content into the B8b two-stage-orchestrator section of `index.ts`
2. Add one `else if (handler === "dispatch_premium_auth_provisioner")` branch to the dispatch chain

**Read the client's current index.ts first, plan the diff, apply carefully, re-read to verify.** If you cannot locate the B8b anchor pattern in the client's file, STOP — this repo may have a stale runner version and the splice needs Rebecca to review.

Then redeploy the Edge Function: `supabase functions deploy automation-runner`.

### Step 4 — Splice the nav entries into BCCApp.jsx (nav-patch)

Read `premium-patches/nav-patch/README.md` and `premium-patches/nav-patch/NAV_ITEMS.premium.js`.

You will edit `BCCApp.jsx` at the repo root to:
1. Add 13 new module imports at the top of the file (10 Premium modules + EmergencyContactsMine + shared components)
2. Add 10 new nav entries to the `NAV_ITEMS` array, after Base entries but before `settings`
3. Add router branches in the main content switch/case
4. Add 10 new icon paths in the Icon component

**A broken `NAV_ITEMS` breaks every module.** Read the current BCCApp.jsx, plan the diff, apply carefully, re-read to verify. If this repo already has a module named `ReportPackage` imported in BCCApp.jsx — that is intentional client-specific code, preserve it.

### Step 5 — Splice the dashboard tile into Dashboard.jsx (dashboard-patch)

Read `premium-patches/dashboard-patch/DASHBOARD_PATCH.md` and `premium-patches/dashboard-patch/PREMIUM_TILES.premium.jsx`.

You will edit `src/modules/Dashboard.jsx` to:
1. Add the `PTOPendingTile` import at the top
2. Insert the tile JSX (`<PTOPendingTile onNavigate={() => onNavigate && onNavigate("pto")} />`) in the main render — placement is forgiving since the tile self-hides at count=0

### Step 6 — Run the smoke test

Read and execute `docs/PREMIUM_SMOKE_TEST.md` in full. Every check must pass. Producer Isolation failures are the highest-severity blockers — a leaky RLS policy is worse than a broken feature that fails loudly.

If any smoke test fails, do NOT report the install as complete. Fix it, re-verify.

### Step 7 — Report back

When all 6 steps above pass, reply to the person operating this repo with:

> ✅ **Premium overlay v1.1.3 install complete.** All 19 migrations applied (Step 1a shim + 100a + 17 remaining). All 3 splices applied. Smoke test passed. Ready for use.

If anything failed or was ambiguous, describe exactly what happened and what you did or did not do. Do not report success on a partial install.

---

## If you need help mid-install

Email `rebecca.coelho@imaginary-farms.com` — she is the operations lead at Imaginary Farms and the Claude Whisperer who orchestrated this build. She will loop in Setup Claude if the splice patterns look ambiguous in this repo's specific structure.

---

## Changelog for this file

- **v1.1.3 (2026-07-15)** — Step 1 split into 1a (shim) + 1b (100a). Prior version told Claude to apply 100a first, which failed with `ERROR 42P01` on hand-installed pre-`041b4321` Bases whose `_install_provenance` table was created by a Base version that predates the current bootstrap. See the overlay repo CHANGELOG entry for v1.1.3 for full root-cause detail. Ramon Glenn install feedback drove this fix.
- **v1.1.2 (2026-07-14)** — SalesActivity/LOB chip cosmetic fix from demo-hardening backport. No install-flow changes.
- **v1.1.1 (2026-07-14)** — PTO Phase 3b + 4 + v1.1.0.1 hotfix backlog. No install-flow changes.

---

*Delivered by Main Claude at Imaginary Farms LLC on behalf of Matthew Cooper (Managing Member). Overlay repo: `cindarellabots-droid/bcc-premium-overlay` @ v1.1.3. Base master reference: `cindarellabots-droid/bcc-master-template` @ 041b4321.*
