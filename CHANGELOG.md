# Changelog

All notable changes to the `bcc-premium-overlay` repository.

Versions `v0.5-scaffold` through `v0.5.8` were internal milestone markers tracked in commit messages and `_install_provenance` rows during the initial development sprint (2026-07-09 through 2026-07-12). **v1.0.0 is the first Git-tagged release** and serves as the immutable reference commit for all client installs going forward.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates in ISO 8601 (YYYY-MM-DD).

---

## [v1.1.3] — 2026-07-15

**Fifth tagged release. Emergency hotfix.** Schema-compatibility pass for hand-installed pre-`041b4321` Base clients. Triggered by Ramon Glenn install feedback 2026-07-15 22:15 UTC: v1.1.2 install stopped at Step 1 with `ERROR 42P01: relation "public._install_provenance" does not exist`.

### Root cause

Ramon's Base was hand-installed early July 2026, before `tools/bootstrap_client_repo.sh` (Week 1 security patch, 2026-07-06) landed the `_install_provenance` watermark row on fork. Every overlay migration presumes the table exists. Additionally, Ramon's `public.staff.role` uses hand-install labels (`owner_producer`, `producer_licensed`) instead of the canonical `'Owner / Agent'` the shim's owner-check hard-coded. Ramon's Base also ships its own `public.is_current_user_owner()` helper, which the shim's `get_current_role_is_owner()` would silently drift from.

### Fixed

- **Migration `100_base_compat_shim.sql` — Section 0 (new)** — `CREATE TABLE IF NOT EXISTS public._install_provenance (...)` runs before any widening. Fresh 041b4321+ Bases: no-op. Pre-bootstrap-era hand-installs: creates the table with a Base-compatible watermark shape that Section 2's ADD COLUMN + ALTER COLUMN calls then extend with `event_type` / `event_data` / `overlay_version`.
- **Migration `100_base_compat_shim.sql` — Section 3 (rewrite)** — `get_current_role_is_owner()` is now a dispatcher: if `public.is_current_user_owner()` exists (hand-installed Bases from June 2026 that shipped their own owner helper), the dispatcher delegates to it — Premium RLS stays consistent with Base RLS on the same DB, and future edits to the Base helper automatically propagate. Otherwise the dispatcher falls back to a widened `staff.role` match accepting `'Owner / Agent'`, `'Owner'`, `'Agent'`, `'owner_producer'`, and `'producer_licensed'`. Single fallback path serves every known Base shape.
- **`OVERLAY_APPLY.md`** — Step 2 rewritten as Step 2a (apply the shim FIRST) + Step 2b (then 100a). Prior wording named only 100a and left Setup Claude to discover the shim dependency from the file listing. Filesystem alphabetical order (`100_` < `100a`) matches the correct dependency order.

### Notes

- No changes to Base master required.
- No changes to migrations 100a, 100b, 100c, 100e, or the module migrations (107a-d, 108-112). The v1.1.3 shim absorbs the compat surface entirely.
- Migration provenance stamp bumped to `1.1.3` in `100_base_compat_shim`. Idempotency indexes (Section 4) retain their `v0.5.3.1` stamps — unchanged in this release.
- v1.1.2 client installs that stopped at Step 1 with `42P01` should: (a) `git pull` the overlay files, (b) apply the v1.1.3 shim, (c) resume at `100a`. No manual DB surgery required.

### Delivered to

- `bcc-premium-overlay` master (this repo)
- Client repos with v1.1.2 pushed but install stopped (Ramon Glenn), OR v1.1.2 push in progress (Kim Parks, Michelle Josias, Tiffany Mapp, Wanda Carlson) — synced simultaneously so no client sees a broken half-state.

---

## [v1.1.2] — 2026-07-14

**Fourth tagged release.** Cosmetic polish backport from `bcc-master-template-demo-full` after Rebecca's testing pass tonight caught two demo bugs.

### Fixed

- **SalesActivity segmented button + LOB chip selected-state affordance** (`webapp-modules/src/modules/SalesActivity.jsx`) — the activity type buttons (Quote issued / App submitted / Policy bound / Cross-sell) and LOB chips (Auto / Fire / Life / Health / Bank / FS / Other) were tracking state on click but the selected style `bg-if-teal/10` (10% opacity teal on a cream background) was visually indistinguishable from the unselected state. Testers were clicking and seeing nothing change.
  - Selected buttons now: `border-2` teal + solid teal background + white text + teal ring shadow (`ring-2 ring-if-teal/30`)
  - Selected chips now: `border-2` teal + solid teal background + white text + shadow
  - Unselected buttons/chips also gained an explicit `bg-white` so the contrast against the selected state reads unambiguously

### Notes

This release is code-only — no migration, no new RPC, no schema change. Backport-only from demo-hardening. Any client repo installed at v1.1.1 can bump to v1.1.2 with a single-file diff and no other action.

Companion fix in Base master `bcc-master-template` @ `src/lib/hooks.js` (dual-signature `useSupabaseQuery` accepting both `(queryFn, deps)` and `(queryKey, queryFn, options)` — required for any Premium module that uses the react-query-style call pattern, including Scoreboard). That change ships to Base master alongside this overlay release.

---

## [v1.1.1] — 2026-07-14

**Third tagged release.** Ships Phase 3b + Phase 4 of the PTO module (backported from `bcc-master-template-demo-full` 2026-07-14 demo-hardening pass) plus the v1.1.0.1 hotfix backlog that was queued but not landed in v1.1.0.

### Added

**PTO — Phase 3b (month calendar)**
- **PTOMonthCalendar.jsx** — new shared component. Full month grid (Sun–Sat) with prev/next month + Today, per-day PTO chips (approved solid teal, pending dashed amber), currentUserId highlighting, coverage-conflict warning outline when 2+ approved requests overlap on the same day
- **PTOMine "Calendar view" section** — renders own approved + pending PTO on a monthly grid (RLS on `v_pto_my_requests` keeps producers scoped to own rows)
- **PTOAdmin Week | Month toggle** — segmented control in the Team calendar section header. Month view shows the full team grid with coverage-conflict flags enabled

**PTO — Phase 4 (edit pending requests)**
- **Migration 107e_pto_edit_request.sql** — new RPC `rpc_edit_pto_request(request_id, start_date, end_date, is_half_day, half_day_period, reason)`. Owner-of-request or agent-owner only. Pending status only. Mirrors validation from `rpc_create_pto_request`. `request_type` intentionally not editable — reclassification (e.g. personal → sick) requires cancel + resubmit so the manager sees the intent shift in the queue
- **PTOMine `RequestForm`** — replaces `NewRequestForm`. `mode` prop toggles between create and edit; edit mode hydrates from the existing row, hides the type field with a hint, and calls the new edit RPC
- **PTOMine RequestsList Edit button** — appears next to Cancel on pending rows

### Fixed (v1.1.0.1 hotfix backlog, finally landed)

- **Migration 107c `rpc_create_pto_request`** — referenced `public.settings.value`/`.key` which do not exist; canonical column names are `setting_value`/`setting_key` (as used correctly in 107b and 112). The RPC would crash with `column "value" does not exist` the instant any producer submitted a PTO request. Now uses correct column names. Applies to new installs; existing v1.1.0 installs with a producer role will need this migration re-run (idempotent via `CREATE OR REPLACE FUNCTION`)
- **Migration 112 `v_upcoming_milestones`** — `years_of_service` was computed as `EXTRACT(YEAR FROM age(current_date, s.hire_date))` (years elapsed today) rather than years elapsed AT the milestone_date. Upcoming 5/10/15/20/25-year service milestones silently rendered as N−1 years until the day-of, and the `is_service_milestone` check (`years_of_service % 5 = 0`) missed them entirely. Rewritten to compute from the resolved `milestone_date`
- **webapp-modules/src/lib/useMyProfile.js** — anon-session fallback: when there is no signed-in user, resolve the agent-owner staff row as the caller identity. Fixes the demo-mode "who am I?" path for TimeTracking, SalesActivity, etc. Also switches from `supabase.auth.getUser()` (which throws `AuthSessionMissingError` on no session) to `supabase.auth.getSession()` (which returns `{ session: null }` cleanly)
- **Base pair `src/components/EmptyState.jsx`** (shipped separately to `bcc-master-template` @ 041b4321) — `icon` prop now accepts both emoji strings AND lucide-react component refs. Premium modules passing lucide component refs were crashing Base with React error #31

### Notes

- Overlay version stamp in migration provenance bumped to `1.1.0.1` for 112, `0.5.3` for 107e provenance (per the demo-hardening sprint's overlay version series).
- No changes to Base master required beyond the EmptyState hotfix already landed in `bcc-master-template` @ 041b4321.

---

## [v1.1.0] — 2026-07-12

**Second tagged release.** Search + edit discoverability improvements across both repos, plus a full client/vendor-name scrub of the Base master pair. Ships all v1.0.0 → v1.1.0 improvements from the two 2026-07-12 sprint sessions (v1.1 partial + v1.1.1 completion).

### Added

**Search + edit surfaces**
- **HRPeople.jsx Team Snapshot** — live search filter (name, role, employment type, email) + click-to-edit modal that writes to `public.staff` (first_name, last_name, role, employment_type, email, phone, start_date, is_active, notes; payroll and license fields excluded by design)
- **Handbook.jsx** — `SearchInput` on SectionsList (searches section_number, title, policy content)
- **TimeTracking.jsx** — `SearchInput` on RecentEntriesList (producer name, activity category, date, notes)
- **SalesActivity.jsx** — `SearchInput` on RecentEntriesList (producer name, activity type, LOB, outcome, date, notes, internal reference)

**Shell + global surfaces (Base master pair)**
- **Global PrintButton** at shell level — single header-level Print control (matches Bell styling: 18px slate400 icon, 4px padding, inline Icon component, cursor pointer) rather than 27 per-module implementations

### Fixed

- **HRPeople Team Snapshot dead pills** — removed `member.licensed`, `member.compliance_flag`, and `member.license_states` renderings that always evaluated to Unlicensed / no flag (columns never existed in canonical `public.staff` schema)
- **HRPeople Staff Directory latent runtime crashes** — null-safe pay_rate / pay_type / employment_type display + safe avatar initials + sanitized AskBtn context (previously would throw `Cannot read properties of undefined` on records with null pay_rate or expanded cards for staff without license_states)
- **Compliance Flags KPI tile** — removed (always-zero display reading nonexistent column)
- **Ask Claude hieroglyphs** on 9 Base modules — replaced literal `\u26a1` escape sequences in JSX raw text with actual ⚡ character
- **Wiki & System Map "Failed to load"** — applied migrations `045_system_map` + `049_system_map_starter_pages` to the demo Supabase project
- **Global Print button empty pill** — restyled to use inline Icon + bellWrap pattern (was rendering blank because shared Tailwind PrintButton didn't harmonize with header's inline-styled navy)
- **Playbook search discoverability** — search bar moved above intro callouts (was buried below ~500 words of intro copy)

### Changed

- **HRPeople data fetch** — `SELECT` on `staff` expanded to include `email`, `phone`, `notes` so the new edit modal opens with populated values
- **Client/vendor-name scrub across Base master pair** (16 files, 26 replacements) — user-visible leaks (AA05 banner, sample accountant, demo intake rows, PersistentMemory demo content, demo reset function) and dev/attribution comments (migration headers, edge-function LLM prompt block, doc references) all genericized. Retained by design: `docs/DOCUMENT_IMPORTER_GUIDE.md` note documenting the retirement of `COMPOSIO_SEARCH_GROQ_CHAT`.
- **Automations empty-state copy** — `Rube.app` → `Composio` (Rube decommissioned May 2026)

### Snapshot at tag time

- **Overlay HEAD at tag**: `6a93cc87b55a4b833ebd7c17c47b382e55c39f6e`
  - Two commits since v1.0.0: `f0f23bbf` (Handbook search) + `6a93cc87` (TT + SA search)
- **Base master pair HEAD at tag**: `c55b4a9ac8204ec6e0e391135b5b46d85787a3bc`
  - Seven commits since v1.0.0 pair:
    - `5088e6ee` — fix(ui): 9 files, ⚡ character in Ask Claude buttons
    - `7017f176` — feat(shell): global PrintButton (initial)
    - `20bbec6f` — fix(shell): restyle Print button to header design
    - `57ba37f2` — fix(playbook): move search above intro callouts
    - `4e9b84ff` — feat(hr): search + inline edit + dead-code purge (v1.1.1)
    - `191c8558` — chore: client/vendor-name scrub (14 files)
    - `c55b4a9a` — chore: two more Kwame-attribution residuals scrubbed
- **Full-repo audit clean** — zero client/vendor/deprecated-pattern leaks across both repos at tag SHAs
- **Ten Premium modules unchanged** — v1.1.0 adds no new modules; discoverability + edit surfaces only
- **All commits first-try clean** (`retry_count = 0`) with post-commit content-marker verification

### Commitment

Every future client install pins to `v1.1.0` unless the client's requirements specifically pin to `v1.0.0`. Regressions discovered post-tag become `v1.1.1` fast-follow releases. The `v1.1.0` tag itself does not get retagged.

---

## [v1.0.0] — 2026-07-12

**First tagged release. Immutable reference for all future client installs.**

### Added
- `CHANGELOG.md` (this file)
- `docs/RELEASE_NOTES_v1.0.md`

### Snapshot at tag time
- **Ten Premium modules shipped**: PTO, Time Tracking, Sales Activity, Scoreboard, Handbook, Benefits, Personnel Files, Licenses, Milestones, Emergency Contacts
- **§B.11 manager-access gate model — 5 / 5 / 1 split**:
  - 5 gates default TRUE: PTO, Time Tracking, Sales Activity, Handbook, Licenses
  - 4 gates default FALSE (canonical): Scoreboard, Personnel Files, Milestones, Emergency Contacts
  - 1 gate default FALSE (deliberate): Benefits (comp-adjacent PII)
  - Personnel Files uses a **layered gate**: global setting + per-employee grant override
- **§B.12 auto-provisioning invariant**: staff INSERT queues Auth account creation; termination revokes access immediately
- **18 migrations** documented in `migrations/README.md` with intentional numbering gaps at 100d, 104, 111 (reserved buffers)
- **70-case smoke test** in `docs/PREMIUM_SMOKE_TEST.md` covering all 10 modules across 7 test categories
- **Personnel Files Composio Google Drive bridge**: edge function `supabase/functions/personnel-upload/index.ts` + install prerequisites
- **Compliance-safe schema** on Sales Activity: physically prohibits customer PII entry via column-level design
- Overlay HEAD at tag: `f93ebb36feacba7f5aa67ac684233f4c738ed069` + this changelog + release notes commits

### Commitment
Every future client install pins to `v1.0.0`. Regressions discovered post-tag become `v1.0.1` fast-follow releases. The `v1.0.0` tag itself does not get retagged.

---

## [v0.5.8] — 2026-07-12

Personnel Files (Module 07) + full documentation sprint. Closes the Premium tier surface at 10/10 modules.

### Added
- **Module 07 Personnel Files backend** (`migrations/109_premium_personnel_files.sql`, 44,918 bytes)
  - 5 tables: `personnel_files`, `personnel_documents`, `personnel_form_templates`, `personnel_file_manager_grants`, `personnel_document_access_log`
  - 5 SECURITY DEFINER RPCs: reveal (with reason + PII lint + audit log), verify, get_summary, grant_manager_access, revoke_manager_access
  - Layered §B.11 manager gate: `is_personnel_files_manager(p_target_staff_id UUID)` — checks global setting AND per-employee grant table
  - 15 RLS policies; access log is INSERT-only (0 UPDATE/DELETE policies) for compliance
  - Seeded federal W-4 and I-9 form templates (both `producer_uploadable=TRUE`, `is_required=TRUE`)
- **Personnel Files UI** (`webapp-modules/src/modules/PersonnelFiles.jsx`, 105,632 bytes / 2,678 lines)
  - Three role surfaces: Owner, Manager (gated), Producer
  - Five modals: ManageFormTemplates, ManageManagerAccess, UploadDocument, RevealDocument, VerifyDocument
  - Four drawer tabs: Documents, Forms Checklist, Verification Queue, Access Log
  - `DriveConnectGate` install-time prereq check
  - `REASON_PII_PATTERNS` lint on reveal-reason field
- **Supabase Edge Function** (`supabase/functions/personnel-upload/index.ts`, 16,123 bytes) — bridges Supabase Storage → Composio → Google Drive
- **NAV_ITEMS.premium.js** updated from nine to ten modules (Personnel Files inserted between Benefits and Milestones)
- **Base master pair**: 4 Personnel Files seed prompts added to `src/modules/PlaybookGuide.jsx`

### Changed (documentation sprint — Phase B pre-v1.0 audit)
- `docs/HANDOFF_PROMPTS_premium.md` rewritten (172 → 1,535 lines) — covers all 10 modules with client-Claude operational workflows
- `docs/CLAUDE_MD_briefings_premium.md` rewritten (99 → 621 lines) — covers all 10 modules with correct architecture; removed client-visible falsehood that "9 modules are not active in the current install"
- `docs/PREMIUM_SMOKE_TEST.md` rewritten (439 → 1,971 lines) — 70 test cases across 7 categories covering all 10 modules
- `migrations/README.md` rewritten (5,479 → 9,672 bytes) — documents actual 18-migration application order with intentional numbering gaps
- `docs/BUILD_PLAN.md` updated with CURRENT STATE banner and Personnel Files architecture correction (Google Drive via Composio, not Supabase Storage)

### Fixed
- Back-filled provenance INSERT statements on `100b_auth_provisioner_helpers.sql` and `100c_premium_auth_provisioner_recipe.sql` — all 18 migrations now write to `_install_provenance` on apply

### Notes
- Sandbox restart resilience validated mid-session; source content held in main-Claude context recovered cleanly
- All commits first-try clean (`retry_count = 0`) with post-commit content-marker verification

---

## [v0.5.7] — 2026-07-12

### Added
- **Module 03 Scoreboard backend** (`migrations/103_premium_scoreboard.sql`) — activity visualization surface with §B.11 canonical FALSE default
- **Scoreboard UI** — game-board surface with per-producer / per-team roll-ups; `useCountUp` rAF animation pattern established (no Framer Motion)

---

## [v0.5.6] — 2026-07-12

### Added
- **Module 01 Time Tracking backend** (`migrations/101_premium_time_tracking.sql`) — clock-in / clock-out with manager approval flow
- **Time Tracking UI** with `useMyProfile` hook consumption

### Design decision locked
- Time Tracking manager gate default TRUE (managers routinely approve/adjust time entries)

---

## [v0.5.5] — 2026-07-11

### Added
- **Module 02 Sales Activity backend** (`migrations/102_premium_sales_activity.sql`) — compliance-safe activity logging
- Sales Activity UI

### Design decision locked
- Sales Activity manager gate default TRUE (managers coach on activity metrics)
- **Compliance-safe schema architecture**: producers log activity type / outcome / LOB / premium band only. Customer name, policy number, VIN, address columns physically do not exist in the schema — an engineering constraint that makes customer PII entry impossible, not a legal disclaimer

---

## [v0.5.4] — 2026-07-11

### Added
- **Module 05 Handbook backend** (`migrations/105_premium_handbook.sql`) — policy document versioning + acknowledgment tracking
- **Module 06 Benefits backend** (`migrations/106_premium_benefits.sql`) — enrollment / coverage management
- `Handbook.jsx` + `Benefits.jsx` UI + nav wiring
- `useMyProfile` hook extracted for cross-module reuse

### Design decisions locked
- Handbook manager gate default TRUE (managers enforce policy)
- Benefits manager gate default FALSE (comp-adjacent PII — the one deliberate FALSE outside the four canonical FALSE modules)

---

## [v0.5.3.1] — 2026-07-11 — Hotfix

### Fixed
Four Base schema-drift bugs discovered via runtime verification against the demo project:
1. Wrong column names on `public.alerts`
2. Missing UNIQUE indexes on lookup keys
3. `staff.role` case mismatch — overlay was writing lowercase snake_case; Base master uses Title Case
4. Phantom `is_current_user_owner()` function reference — Base master exposes `get_current_role_is_owner()`; overlay wrapper added

---

## [v0.5.3] — 2026-07-11

### Added
- **Module 10 Emergency Contacts backend** (`migrations/110_premium_emergency_contacts.sql`) with owner/manager reveal RPCs and reveal-audit logging
- **Module 08 Licenses backend** (`migrations/108_premium_licenses.sql`) with role-aware Licenses.jsx dashboard
- Monthly Licenses expiration recipe seed (background runner)
- `nav-patch` updated to 4-module active set

### Design decisions locked
- Licenses manager gate default TRUE (managers routinely track CE compliance)
- Emergency Contacts manager gate default FALSE (canonical — private-life PII)

---

## [v0.5.2.1] — 2026-07-11 — Hotfix

### Added
- `100_base_compat_shim.sql` — reconciles overlay expectations with Base master schema:
  - GENERATED `staff.full_name` column
  - Widened `_install_provenance.event_data` field
  - Wrapper function `get_current_role_is_owner()`

### Fixed
- Schema-drift corrections between overlay and Base master

---

## [v0.5.2] — 2026-07-10

### Added
- **Module 09 Milestones backend** (`migrations/112_premium_milestones.sql`) — recognition and anniversary tracking
- PTOAdmin mockup fidelity applied (`Premium_PTO_Admin_Mockup.html` design ratified)

### Changed
- PTO polish: request-cancel path, coverage view refinements (Phases 2r + 3)
- Documentation corrections in BUILD_PLAN.md

### Design decision locked
- Milestones manager gate default FALSE (canonical)

---

## [v0.5-scaffold] — 2026-07-09 → 2026-07-10

Repository bootstrap and PTO (§4) as the founding module.

### Added
- Initial overlay directory structure: `migrations/`, `webapp-modules/`, `nav-patch/`, `dashboard-patch/`, `composio-recipes/`, `runner-patch/`, `docs/`, `tools/`
- **Auto-provisioning migration** (`migrations/100e_...sql`) implementing §B.12 invariant: staff INSERT queues Auth account creation via `_pending_auth_actions`; termination revokes access immediately
- **PTO (§4) backend** — the founding module:
  - `107a` — schema, RLS, `is_pto_manager` helper, settings toggles
  - `107b` — views and helpers
  - `107c` — SECURITY DEFINER RPCs
  - `107d` — Premium PTO nightly accrual recipe adapter and seed
- `pto/accrual.js` — pure JS math module for accrual computation
- **PTO UI**:
  - `PTOMine.jsx` — producer view (balance, requests, team availability)
  - `PTOAdmin.jsx` — owner/manager tabbed queue / roster / policies
  - `PTOPolicies.jsx` — owner policy CRUD with tenure bracket editor
  - `PTOPendingTile.jsx` — dashboard tile for pending PTO count
- `dashboard-patch/` for Premium §4 PTO tile wiring
- `docs/PREMIUM_SMOKE_TEST.md` — initial PTO verification walkthrough (superseded by v0.5.8 rewrite)

### Design decision locked
- PTO manager gate default TRUE (managers approve time-off requests)

---

## Version marker legend

- `v0.5.x` — internal milestone marker (in commit message + `_install_provenance` metadata); **never Git-tagged**
- `v0.5.x.y` — hotfix milestone marker; **never Git-tagged**
- `v0.5-scaffold` — pre-versioned bootstrap era
- `v1.0.0` — first Git tag; immutable release reference

## Regression policy

Bugs discovered after `v1.0.0` become `v1.0.1` fast-follow releases. The `v1.0.0` Git tag is never force-pushed or retagged. Every client install references a specific tag.
