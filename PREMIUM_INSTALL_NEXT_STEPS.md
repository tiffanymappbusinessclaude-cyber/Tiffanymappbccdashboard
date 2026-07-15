# PREMIUM_INSTALL_NEXT_STEPS.md

**Read this first.** This document is a prompt for the client's own Claude — the Project Claude assigned to this Business Command Center repo. It walks through the final steps required to complete the Premium overlay installation that Imaginary Farms has just pushed into this repo.

Do not skip steps. Do not reorder them. If any step returns an unexpected result, STOP and email `rebecca.coelho@imaginary-farms.com` before continuing.

---

## What just landed in this repo

Imaginary Farms just pushed the **BCC Premium overlay v1.1.2**, which extends the Base BCC with 10 new modules (Time Tracking, Sales Activity, Scoreboard, PTO, Handbook, Benefits, Personnel Files, Licenses, Milestones, Emergency Contacts) plus the shared auto-provisioning infrastructure they depend on.

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

### Step 1 — Apply migration 100a first, alone, and verify

Migration `supabase/migrations/100a_premium_auto_provisioning.sql` is the auto-provisioning prerequisite. Every other Premium migration depends on it.

Apply it against the client's Supabase project via the Supabase MCP or SQL editor. After it runs, verify:

- `_pending_auth_actions` table exists
- `trg_staff_auth_lifecycle` trigger is bound to `public.staff`
- `_install_provenance.overlay_version` is set to `'v1.1.2'`

If any of those are missing, do not proceed. Investigate.

### Step 2 — Apply the remaining 18 migrations in this order

Numeric order per the design doc: 100, 100b, 100c, 100e, 101, 102, 103, 105, 106, 107a, 107b, 107c, 107d, 107e, 108, 109, 110, 112.

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

> ✅ **Premium overlay v1.1.2 install complete.** All 19 migrations applied. All 3 splices applied. Smoke test passed. Ready for use.

If anything failed or was ambiguous, describe exactly what happened and what you did or did not do. Do not report success on a partial install.

---

## If you need help mid-install

Email `rebecca.coelho@imaginary-farms.com` — she is the operations lead at Imaginary Farms and the Claude Whisperer who orchestrated this build. She will loop in Setup Claude if the splice patterns look ambiguous in this repo's specific structure.

---

*Delivered by Main Claude at Imaginary Farms LLC on behalf of Matthew Cooper (Managing Member). Overlay repo: `cindarellabots-droid/bcc-premium-overlay` @ v1.1.2. Base master reference: `cindarellabots-droid/bcc-master-template` @ 041b4321.*
