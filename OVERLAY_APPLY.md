# OVERLAY_APPLY.md

**How setup Claude applies the Premium overlay to a Base client repo.**

This document is prescriptive. Setup Claude reads this once, then executes the sequence deterministically. It is not a general guide; it is a checklist.

---

## Prerequisites

Before starting any overlay apply operation, verify all of the following:

1. Client's Base BCC repo (a fork of `cindarellabots-droid/bcc-master-template`) exists at the client's namespace (e.g., `smith-agency/bcc-app`) and is at the latest Base version.
2. Client's Base BCC is installed and smoke-tested — Base modules render, Base migrations are applied, client's staff are seeded, client's `AGENCY_ID` and Supabase config are set in `.env`.
3. Client's Supabase project is accessible via the Composio Supabase connection (or direct service_role key).
4. Client has an executed Premium tier Master Services Agreement (MSA) covering the modules being installed.
5. This overlay repo (`cindarellabots-droid/bcc-premium-overlay`) is at the target version (currently `v0.5-scaffold`).

If any prerequisite is missing, stop. Do not proceed with a partial overlay apply.

---

## The apply sequence

### Step 1 — Working directory setup

Setup Claude works from a local machine or sandbox with both repos cloned side by side:

```
work/
├── bcc-premium-overlay/    (this repo)
└── clients/
    └── <client-slug>/      (fork of bcc-master-template with Base applied)
```

`<client-slug>` matches the client's fork name (e.g., `smith-agency-bcc`).

### Step 2a — Apply the Base compatibility shim (100_base_compat_shim) FIRST

**Do not skip this step.** Every other overlay migration references schema this shim adds. Apply order matters: filesystem alphabetical is `100_ < 100a < 100b < 100c < 100e`, which is the correct dependency order.

Run migration `100_base_compat_shim.sql` against the client's Supabase project. This migration:

- Creates `public._install_provenance` if the Base predates 2026-07-06 (`tools/bootstrap_client_repo.sh` era) and the table is absent. Fresh 041b4321+ Bases: no-op.
- Adds `staff.full_name` as a GENERATED column.
- Widens `_install_provenance` with `event_type` / `event_data` columns for the overlay event log.
- Creates `get_current_role_is_owner()` as a dispatcher that delegates to a pre-existing `is_current_user_owner()` if the Base ships one, otherwise falls back to a widened `staff.role` match (accepts `Owner / Agent`, `owner_producer`, `producer_licensed`, and historical variants). This means hand-installed Bases from June 2026 with divergent role labels are supported without per-client patches.
- Adds idempotency UNIQUE indexes on `public.alerts` and `public.automation_recipes` required by ON CONFLICT clauses in later overlay migrations.

If this step returns an unexpected result (schema mismatches, missing Base tables, etc.), STOP and email `cindarellabots@gmail.com` with the full error before continuing. See the v1.1.3 CHANGELOG entry for the Ramon Glenn install feedback that motivated this shim.

### Step 2b — Apply the auto-provisioning prerequisite (100a)

Run migration `100a_premium_auto_provisioning.sql` against the client's Supabase project via the Composio Supabase connection or the SQL editor. Verify:

- `_pending_auth_actions` table exists.
- `trg_staff_auth_lifecycle` trigger is bound to `public.staff`.
- `_install_provenance.overlay_version` is set to `'1.1.3'` (or whatever version is being installed).

Run the verification block at the bottom of the migration file — insert a test staff row with status changes and confirm the trigger enqueues correctly. Delete the test staff row when done.

### Step 3 — Apply module migrations in order

Currently (v0.5-scaffold) no module migrations are shipped. When v0.5.1 ships §4 PTO, the sequence becomes:

- Migration `107_premium_pto.sql`
- Then `108`, `109`, `110`, `111`, `112`, `113`, `100`, `101`, `102` as they ship.

For v0.5.1-rc1 also apply the auth provisioner support migrations in order:

- `100b_auth_provisioner_helpers.sql` — atomic SECURITY DEFINER helpers for the auth queue drain
- `100c_premium_auth_provisioner_recipe.sql` — seeds the `automation_recipes` row (this migration contains `{{agency_id}}` placeholder; substitute before applying)

And the §4 PTO reference implementation migrations, in order:

- `107a_pto_schema.sql` — pto_policies, pto_balances, pto_requests tables + RLS + `is_pto_manager()` gate
- `107b_pto_views_and_helpers.sql` — /pto/mine + /pto/admin views, team availability counts, accrual helper functions
- `107c_pto_rpcs.sql` — RPC surface (policy upsert, request create / approve / decline / cancel, nightly accrual driver)
- `107d_pto_accrual_recipe.sql` — recipe-contract adapter (handler_pto_accrual) + `automation_recipes` seed for the nightly accrual (contains `{{agency_id}}` placeholder; substitute before applying)

Each migration is idempotent — safe to re-run — but the numeric order is preferred for clean apply.

### Step 3.5 — Apply the runner patch (v0.5.1+)

Some Premium automations need external HTTP calls that Postgres cannot make on its own (Supabase Auth admin API, external services beyond the Composio catalog). Those ship as **runner patches** — TypeScript orchestrators that get spliced into Base's `automation-runner/index.ts` at the B8b two-stage-orchestrator section.

For v0.5.1-rc1, the auth provisioner ships as one runner patch:

- Read `runner-patch/RUNNER_PATCH.md` for the prescriptive two-edit patch instructions.
- Verify prerequisite migrations 100a and 100b are applied to the client's Supabase (the patch file lists the verification SQL).
- Splice `runner-patch/auth_provisioner.ts` into the client's `supabase/functions/automation-runner/index.ts`:
  1. Append the entire file content to the B8b two-stage-orchestrator section (around line ~2900).
  2. Add one `else if (handler === "dispatch_premium_auth_provisioner")` branch to the dispatch chain around line ~3016.
- Type-check locally: `cd <client-repo>/supabase/functions && deno check automation-runner/index.ts`.
- Redeploy the Edge Function: `supabase functions deploy automation-runner`.
- Smoke-test with the empty-queue and real-action scenarios documented in `RUNNER_PATCH.md`.

The runner-patch pattern mirrors the nav-patch pattern (Step 5): a reference file that Setup Claude uses as a guide when hand-editing a Base file. Both live in the overlay repo; neither is copied into the client repo verbatim.

### Step 4 — Copy webapp module files

From `bcc-premium-overlay/webapp-modules/src/modules/*.jsx` to `<client-slug>/src/modules/`. Do the same for `webapp-modules/src/components/*.jsx` → `<client-slug>/src/components/`.

If a client-side JSX file already exists with the same name, that means either a previous overlay apply ran (in which case: overwrite, since the overlay is the source of truth), or someone hand-edited a client-side file (in which case: stop and investigate — see the "Per-client customization is forbidden" note in the design doc supplement 2026-07-09).

### Step 5 — Apply the nav patch to BCCApp.jsx

Open the client's `BCCApp.jsx`. Locate the `NAV_ITEMS` array. Use `nav-patch/NAV_ITEMS.premium.js` as the reference:

- Import block goes at the top of BCCApp.jsx (after existing imports).
- Nav entries go in the `NAV_ITEMS` array, after Base entries but before `settings`.
- Router branches go in the main content switch/case.
- Icon paths go in BCCApp.jsx's `Icon` component (the ten new icon names).

This is a manual edit. Setup Claude reads the client's current `BCCApp.jsx`, plans the diff, applies it carefully, and re-reads to verify. A broken NAV_ITEMS breaks every module — this step deserves care.

### Step 5.5 — Apply the dashboard patch (v0.5.1+)

Some Premium modules ship a dashboard tile — a small summary widget that surfaces module status (pending PTO requests, expiring licenses, unsigned handbook acknowledgments) directly on the main dashboard. These ship as **dashboard patches** — reference JSX files that get spliced into Base's `src/modules/Dashboard.jsx`.

For v0.5.1-rc1, the §4 PTO module ships one tile:

- Read `dashboard-patch/DASHBOARD_PATCH.md` for the prescriptive two-edit patch instructions.
- Verify prerequisites: migration `107a_pto_schema.sql` applied, `webapp-modules/src/components/PTOPendingTile.jsx` has been copied to the client repo at `src/components/PTOPendingTile.jsx` (this happens as part of Step 4).
- Splice the two edits from `dashboard-patch/PREMIUM_TILES.premium.jsx` into the client's `src/modules/Dashboard.jsx`:
  1. Add the `PTOPendingTile` import at the top of the file.
  2. Insert the tile JSX (`<PTOPendingTile onNavigate={() => onNavigate && onNavigate("pto")} />`) in the main render — placement is forgiving since the tile self-hides at count=0.
- Rebuild and smoke-test per the verification section in `DASHBOARD_PATCH.md`.

The dashboard-patch pattern is the third member of the manual-patch family alongside nav-patch (Step 5) and runner-patch (Step 3.5). All three follow the same discipline: overlay ships reference material, Setup Claude does the actual editing of Base files during install.

### Step 6 — Copy Composio recipes (if any)

From `bcc-premium-overlay/composio-recipes/*.json` — deploy each recipe to the client's Composio project.

**Note (2026-07-09):** This directory is currently empty. The premium_auth_provisioner recipe that was originally planned to ship here instead ships as three pieces per Base's `automation_recipes` convention: migration 100b (helpers) + runner-patch (orchestrator) + migration 100c (recipe seed). See `composio-recipes/README.md` for the pattern-change rationale. Skip this step in v0.5.1-rc1.

### Step 7 — Copy docs into the client repo

From `bcc-premium-overlay/docs/*` → append to `<client-slug>/docs/`:

- `HANDOFF_PROMPTS_premium.md` → append to client's `HANDOFF_PROMPTS.md`.
- `CLAUDE_MD_briefings_premium.md` → append to client's `CLAUDE.md`.
- `PREMIUM_SMOKE_TEST.md` → copy into client's `docs/` as a new file.
- `BASE_VS_PREMIUM_INVENTORY.md` → copy into client's `docs/` as a new file.

### Step 8 — Update `settings` toggles

The overlay ships a set of settings toggles (all default FALSE per Producer Isolation Principle B.11 unless noted otherwise). Migrations handle the initial inserts. If the client-side `settings` table already has any of these keys from a previous apply, do not overwrite — that would clobber the agent's intentional configuration.

### Step 9 — Commit the changes to the client's fork

Single commit with a clear message:

```
Apply bcc-premium-overlay v0.5-scaffold

Modules added: (none yet — this is scaffold + auto-provisioning only)
Migration prerequisite: 100a_premium_auto_provisioning.sql
Overlay version tracked in _install_provenance.
```

Push to the client's fork. Do not push to `bcc-master-template` (that's the Base source of truth; overlays never touch it).

### Step 10 — Run the Premium smoke test

Follow every step in `docs/PREMIUM_SMOKE_TEST.md`. Every check must pass. Producer Isolation failures are the highest-severity install blockers — a leaky RLS policy is worse than a broken feature that fails loudly.

If any smoke test fails, do not hand off. Investigate, fix, re-verify.

### Step 11 — Handoff

Standard IF handoff: closing email to the client, 30-day post-handoff support window activated. The client now owns the Premium overlay applied to their Base install; IF is out of the data path.

---

## When applying a version upgrade (e.g., v0.5 → v0.6 later)

Same sequence with two differences:

1. **Only apply new migrations.** Migrations that already ran are already reflected in the client's `_install_provenance` history. Setup Claude checks `SELECT MAX(overlay_version) FROM _install_provenance` and applies only migrations from later versions.
2. **Diff-patch the nav.** If new modules ship, their nav entries are added to `NAV_ITEMS` without removing existing Premium entries. If existing Premium nav entries have been renamed in the new version, apply the rename carefully.

Idempotency guarantees make version upgrades safe even if setup Claude accidentally re-applies a migration — but numeric order + version-check is the clean pattern.

---

## When something goes wrong

**A migration fails partway through.** Every migration is wrapped in `BEGIN/COMMIT`. A failure rolls back the whole migration; no partial state. Read the error, fix the client-side prerequisite (usually a missing Base column or missing helper function), re-run.

**A nav patch breaks BCCApp.jsx.** Git reset the client's `BCCApp.jsx` file, re-plan the diff, re-apply.

**A runner patch breaks automation-runner.** Git reset the client's `supabase/functions/automation-runner/index.ts` file to the pre-patch state and redeploy. The recipe row in `automation_recipes` can stay — with the orchestrator missing, the recipe will fail at runtime with errors surfacing in `automation_run_log`. No data corruption. See rollback section in `runner-patch/RUNNER_PATCH.md`.

**RLS policy is leaking data.** This is the emergency case. Immediately: (a) drop the offending policy in the Supabase SQL editor, (b) apply the corrected policy from an emergency migration, (c) audit access logs for any exposure that occurred, (d) notify the client if any exposure did occur. Do not proceed with any other overlay work until the leak is closed. See the Producer Isolation Principle (B.11) for the pattern all RLS policies must follow.

**Client asks for a custom variant.** The overlay does not accept per-client customizations. Two paths: (a) if the customization has broader appeal, propose a new settings toggle for the next overlay version, (b) if it's genuinely one-off, the modification lives in the client's own repo fork — not in this overlay. See the "no per-client customization" clause in the design doc supplement 2026-07-09.

---

## Post-handoff behavior

After handoff, IF is out of the data path. The client Claude sessions consult:

- `HANDOFF_PROMPTS.md` (client's copy) — how to operate each module.
- `CLAUDE.md` (client's copy) — what each module does and where the data lives.
- `PREMIUM_SMOKE_TEST.md` (client's copy) — if the client wants to re-verify after their own configuration changes.

The client Claude does not need to reference this repo. The overlay is the shipped artifact; documentation lives in the client's own repo after apply. The overlay is the wheel, the client's repo is the vehicle, and neither depends on the other post-handoff.

---

*This document is maintained in `bcc-premium-overlay`. It ships to the client's repo as part of the apply operation but is not modified by the client. Overlay version changes may update this file; setup Claude replaces the client-side copy on version upgrades.*


## Version history

### v1.2.0 (2026-07-17) — Kim install backport

**44 files backported from `insuredbykimclaude-ship-it/kparksbccdashboard` (Kim Parks Agency install, HEAD `22e73bf3`).**

Categorized delta from Kim's install repo shipped in three commits:

- **p1_frontend** (17 files) — `4f8f2506` — PTO calendar + pending tile components, PTO format util, 13 Premium isolation modules (`TimeTracking`, `Scoreboard`, `SalesActivity`, `OperationsReports`, `PTOAdmin`, `PTOMine`, `PTOPolicies`, `Handbook`, `Benefits`, `Licenses`, `Milestones`, `PersonnelFiles`, `EmergencyContacts` + `EmergencyContactsMine`)
- **p2_migrations** (19 files) — `66893b19` — migrations `100-112`: `base_compat_shim`, `premium_auto_provisioning` + `auth_provisioner` recipe, PTO schema/views/rpcs/accrual/edit_request, `time_tracking`, `sales_activity`, `scoreboard`, `handbook`, `benefits`, `licenses`, `personnel_files`, `emergency_contacts`, `milestones`
- **p3_patches** (8 files) — `3649f4d9` — install patches: `dashboard-patch/` (`PREMIUM_TILES.premium.jsx` + docs), `nav-patch/` (`NAV_ITEMS.premium.js` overrides), `runner-patch/` (`auth_provisioner.ts`), and `PREMIUM_INSTALL_NEXT_STEPS.md`

**Notable additions in this backport:**
- **`src/modules/OperationsReports.jsx`** — new Operations Reports Package covering sales pipeline + team activity summaries. Routed to Premium tier since it reports on Premium-only modules (SalesActivity, Scoreboard).
- **`src/modules/PersonnelFiles.jsx` + migration 109** — Google Drive personnel-files wiring: upload, list, and download for HR-controlled personnel documents.
- **`src/components/PTOMonthCalendar.jsx` + `PTOPendingTile.jsx`** — richer PTO admin UI on top of migrations 107a-e.
- **Dark theme** — all Premium modules retrofitted to CSS-variable color tokens so they respect the Base ThemeToggle. Slash-opacity Tailwind utilities (`bg-if-navy/40` etc.) rebound to `--if-navy-rgb` tokens.

**Sanitization applied before commit:** every occurrence of Kim's agency UUID (`3bab2b3f-...`), her `insuredbykim.claude@gmail.com` handle, `kparksagency.com` domain, `kparks` handle, `Kim Parks` brand references, and employee names replaced with `<AGENCY_UUID>` / `<AGENCY_CLAUDE_EMAIL>` / `<AGENCY_NAME>` placeholders. In migrations, hardcoded agency UUIDs replaced with the same runtime lookup `fn_bootstrap_new_install()` uses: `(SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1)`. Verification confirmed zero residual Kim strings across all 44 files.

**No new features from other clients rolled into this backport** — Kim's install-specific QBO data snapshots (5 files with 2026-06-19 timestamps in filenames) and her `.env.production` were explicitly excluded.

**Prior Premium HEAD:** `6ea524c9` (v1.1.3 schema-compat hotfix for pre-`041b4321` hand-installed Bases).  
**New Premium HEAD:** `3649f4d9` (p3_patches).

