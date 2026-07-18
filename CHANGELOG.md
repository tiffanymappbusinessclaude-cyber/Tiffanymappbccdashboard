# CHANGELOG.md — bcc-master-template

Tracks material changes to the Base BCC template repo. Entries are dated and reverse-chronological. Prior sequential migration additions live in the migration file headers themselves; this file surfaces client-visible or install-affecting changes.

---

## 2026-07-17 — Kim Parks install backport (103 files)

Backported the following improvements from `insuredbykimclaude-ship-it/kparksbccdashboard` (Kim Parks Agency install, HEAD `22e73bf3`) at the request of the install operator (Rebecca). Four commits total:

### b1_frontend (37 files) — commit `90a1aa30`
Dark theme rollout across the entire component + module set. New foundation components: `AuthGuard.jsx`, `LoginPage.jsx`, `HelpButton.jsx`, `ThemeToggle.jsx`. New Financials-tier module: `ReportPackage.jsx` (CPA-grade Financial Report Package with print-to-PDF). New Base helper hook: `src/lib/useMyProfile.js`. Full CSS variable rebind so `bg-if-navy`, `bg-if-cream`, etc. flip with the theme; slash-opacity Tailwind utilities now backed by `--if-*-rgb` tokens. Every core module (`Dashboard`, `Financials`, `HRPeople`, `Settings`, `Automations`, `Alerts`, `Compliance`, `Documents`, `PersistentMemory`, `PlaybookGuide`, `SocialMedia`, `SystemMap`, `TasksGoals`) retrofitted to CSS variables so dark mode renders readable. HRPeople reorg with clearer sections. `BCCApp.jsx` updated with theme context provider and auth-guard wrapping.

### b2_docs (12 files) — commit `565c94f6`
Doc refresh: `CLAUDE.md`, `HANDOFF_PROMPTS.md`, `PRODUCT_VISION.md`, `README.md` at repo root plus 8 files under `docs/` — `AUTOMATIONS_INSTALL.md`, `AUTOMATION_RECIPES_BLUEPRINT.md`, `DOCUMENT_IMPORTER_GUIDE.md`, `DRIVE_FOLDER_SETUP.md`, `MODULE_DATA_WIRING.md`, `PRODUCER_ROI_INSTALL.md`, `PROJECT_CLAUDE_SYSTEM_PROMPT_TEMPLATE.md`, `SELF_HEAL_GUIDE.md`. All sanitized to remove tenant identifiers (see sanitization note below).

### b3_migrations_numbered (25 files) — commit `99dbade5`
Migrations `053b`–`067` covering: daily briefing composer, GL writer handlers, document processor pipeline (dispatch + processor lineages), document parser framework v2, SF daily comp parser v2, QBO snapshots + mirror tables + journal-lines bulk-insert RPC, email archiver, unified views, balance sheet from snapshots, monthly close generator, bank/CC/payroll GL writers, calendar events + sync handler, goal progress tracker, staff performance snapshot writer. **Renumbered from Kim's `013b`–`027` range** — Kim's install predated Base master migrations `014`–`052` so her numbering collided. Renumber preserves apply order and all lineage subscripts (a/b/c/d/e/f).

### b4_migrations_helpers (29 files) — commit `4c3bc1b8`
Non-numbered migration helpers: bulk-insert RPCs for bank/CC/payroll/comp_recap, comp_recap line-item granularity, GL entry writer fixes (cutover guard, negative amounts, setting_value text cast), canonical Composio parser seeds, pg_cron scheduling for the runner tick, staggered six-hour parsers to avoid Groq TPM caps, Instagram manual reminder handler, source_document_id on credit_transactions, unique-per-attachment documents constraint, anon-read agency policy, daily briefing composer revenue fix (use `v_income_statement`), automations runner + recipe handler updates. Plus updates to existing `supabase/functions/automation-runner/index.ts`, new `supabase/functions/qbo-mirror-refresh/` (function + README), and demo/recipe/seed touch-ups.

### Sanitization applied before commit

Every occurrence of Kim's agency UUID (`3bab2b3f-da78-42d6-a793-3d2a31cbf18b`), her `insuredbykim.claude@gmail.com` business Claude handle, `kparksagency.com` domain, `kparks` handle, `Kim Parks` brand references, and employee names (`Hillary Brannon`, `hillary@`) were replaced with:

- In SQL: agency UUID → `(SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1)` (same runtime lookup `fn_bootstrap_new_install()` uses)
- In docs/code: `<AGENCY_UUID>` / `<AGENCY_CLAUDE_EMAIL>` / `<AGENCY_HANDLE>` / `<AGENCY_NAME>` / `Jane Doe` / `employee@` placeholders

Post-commit verification confirmed zero residual Kim-branded strings across all 103 files.

### Explicit exclusions

Not backported (client-specific data, not template material):

- `.env.production` (Kim's Supabase project variables — Base template already documents production env pattern via `.env.example`)
- `.vercel-triggers.md` (Kim's deploy trigger doc)
- `supabase/migrations/qbo_accounts_refresh_2026_06_19_chunk_{1,2,3,4}_of_4.sql` (Kim's one-time chart-of-accounts snapshot for HER Supabase)
- `supabase/migrations/qbo_mirror_refresh_2026_06_19_jan_jun_snapshots.sql` (Kim's actual H1 2026 bookkeeping data snapshot)

### Rollout note

Per **NO-BACKPORT POLICY** for existing installs (per prior session memory), these Base master updates DO NOT automatically flow to already-live client installs. Push-down decisions to existing clients are a per-client business call.

**Prior Base HEAD:** `b63ed191` (Dashboard: fix agency-name leak + Net Income sign strip).  
**New Base HEAD:** `4c3bc1b8` (b4_migrations_helpers).


### Post-backport correction: BCCApp.jsx reverted, Dashboard.jsx patched

During post-commit verification, Kim's `BCCApp.jsx` and `src/modules/Dashboard.jsx` were found to import Premium-overlay-only modules directly (`OperationsReports`, `TimeTracking`, `PTOAdmin`, `Scoreboard`, `Handbook`, `Benefits`, `Licenses`, `Milestones`, `PersonnelFiles`, `EmergencyContacts`, `EmergencyContactsMine`, `PTOPendingTile`). Fresh Base-only installs (Tier 1 / Tier 2 pre-Premium) would fail to build with those imports present.

- **`BCCApp.jsx` reverted** to pre-backport blob (`f087e395`) at commit `50fb78de`. Rebecca's theme integration changes to `BCCApp.jsx` are NOT yet backported — they need a manual port that leaves the Premium overlay's `nav-patch/NAV_ITEMS.premium.js` install-time patching intact. Kim's version is preserved in `insuredbykimclaude-ship-it/kparksbccdashboard` for reference during that port.
- **`Dashboard.jsx` patched** — Premium overlay dashboard tile imports (`PTOPendingTile` + its JSX block) stripped from Kim's version; theme improvements + core widget changes kept. Committed at `[next hash after this]`. The Premium overlay's `dashboard-patch/PREMIUM_TILES.premium.jsx` re-adds this at install time on Tier 3+ installs.

Both fixes preserve the tier-separation guarantee: Base master builds cleanly against a Base-only install; Premium overlay layers its own modules and patches on top.
