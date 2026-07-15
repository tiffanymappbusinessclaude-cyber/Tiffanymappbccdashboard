# Base vs Premium module inventory

**Reference for what ships in Base, what ships in Premium overlay, and where the boundaries are.**

Version: v0.5-scaffold (2026-07-09)

---

## Base BCC modules (already in `bcc-master-template`)

14 modules at Base tier. Setup Claude does not touch these when applying the overlay.

| # | Module | JSX | Nav id | Purpose |
|---|---|---|---|---|
| 1 | Dashboard | `Dashboard.jsx` | `dashboard` | Landing page, KPI summary, alert tile |
| 2 | Financials | `Financials.jsx` | `financials` | General ledger, bank accounts, P&L |
| 3 | Persistent Memory | `PersistentMemory.jsx` | `memory` | Agent memory, session context |
| 4 | Wiki & System Map | `SystemMap.jsx` | `systemmap` | Agency wiki, system architecture |
| 5 | Playbook & Guide | `PlaybookGuide.jsx` | `playbook` | Agency playbook, SOPs |
| 6 | Compliance Center | `ComplianceCenter.jsx` | `compliance` | Compliance rules library (E&O, licensing, social media, giveaways) |
| 7 | Automations | `Automations.jsx` | `automations` | Composio recipe management |
| 8 | Social Media | `SocialMedia.jsx` | `social` | Social media posting, review |
| 9 | Tasks & Goals | `TasksGoals.jsx` | `tasks` | Task list, goal tracking |
| 10 | Alerts & Notifications | `AlertsNotifications.jsx` | `alerts` | Alert queue, notification prefs |
| 11 | Documents | `Documents.jsx` | `documents` | Operational SF paperwork (COMP_RECAPs, payroll exports, bank statements) with Groq auto-classification |
| 12 | HR & People | `HRPeople.jsx` | `hr` | Recruiting, applicants, onboarding, staff directory, performance, commissions |
| 13 | Claude Chat | (built into shell) | `chat` | Claude conversation interface |
| 14 | Settings | `Settings.jsx` | `settings` | Agency-level settings, user role management |

## Premium overlay modules (added by this overlay)

10 modules. Each ships as a top-level nav entry with cross-links to Base modules where useful.

| # | Module | JSX pattern | Nav id | Nav label | Cross-links to |
|---|---|---|---|---|---|
| 1 | Time In/Out Tracking | `TimeTracking*.jsx` | `time` | Time Tracking | HRPeople (staff sub-section shows time totals) |
| 2 | Sales Activity Ledger | `SalesActivity*.jsx` | `activity` | Sales Activity | Financials (revenue attribution), HRPeople (per-producer view) |
| 3 | Live LOB Scoreboard | `Scoreboard*.jsx` | `scoreboard` | Scoreboard | Sales Activity (source data) |
| 4 | PTO Tracking | `PTO*.jsx` | `pto` | PTO | HRPeople (staff sub-section quick-link) |
| 5 | Handbook + Q&A | `Handbook*.jsx` | `handbook` | Handbook | Compliance Center (handbook rules), HRPeople (onboarding step) |
| 6 | Benefits Ledger | `Benefits*.jsx` | `benefits` | Benefits | HRPeople (staff sub-section), Financials (payroll deductions) |
| 7 | Employment Document Vault | `EmploymentDocs*.jsx` | `employment_docs` | Personnel Files | HRPeople (staff sub-section quick-link); NOT the Base Documents module |
| 8 | State License Expiration Tracking | `Licenses*.jsx` | `licenses` | Licenses | Compliance Center (licensing rules) |
| 9 | Anniversaries + Birthdays | `Milestones*.jsx` | `milestones` | Milestones | HRPeople (staff sub-section quick-link) |
| 10 | First-Class Emergency Contacts | `EmergencyContacts*.jsx` | `emergency_contacts` | Emergency Contacts | HRPeople (staff sub-section quick-link, owner view) |

**Important distinction:** the Premium "Personnel Files" module (§7) is DIFFERENT from the Base "Documents" module. Base Documents handles SF operational paperwork with auto-classification; Personnel Files handles per-staff HR documents (I-9, W-4, offer letters, performance reviews) with strict RLS per Producer Isolation Principle B.11.

---

## Tables added by the Premium overlay

By module:

### Prerequisite (migration 100a)
- `_pending_auth_actions` — queue for auth account lifecycle actions

### §1 Time Tracking (migration 100)
- `timesheets`
- `timesheet_amendments`

### §2 Sales Activity (migration 101)
- `activity_log`
- `policies`
- `google_reviews`
- Plus enums: `lob_enum`, `activity_type_enum`

### §3 Scoreboard (migration 102)
- Views only: `v_scoreboard_by_lob_period`, `v_scoreboard_producer_period`, `v_scoreboard_personal`

### §4 PTO (migration 107)
- `pto_policies`
- `pto_balances`
- `pto_requests`

### §5 Handbook (migration 108)
- `handbook_versions`
- `handbook_acknowledgments`
- `handbook_questions`
- Plus Supabase Storage bucket: `handbook`

### §6 Benefits (migration 109)
- `benefit_plans`
- `benefit_plan_tiers`
- `benefit_enrollments`

### §7 Personnel Files (migration 110)
- `employment_document_types`
- `employment_documents`
- `document_access_log`
- Plus Supabase Storage bucket: `employment-docs`

### §8 Licenses (migration 111)
- `staff_license_expirations`
- `license_alert_log`

### §9 Milestones (migration 112)
- Views only: `v_upcoming_milestones`, `v_upcoming_tenure_transitions`
- Plus schema touch: `staff.birthday` column-add if not present

### §10 Emergency Contacts (migration 113)
- `emergency_contacts`

**Total: 20 new tables + 3 view families + 2 new enums + 2 storage buckets + 1 queue table.**

Post-Premium schema total: Base's ~37 tables + Premium's 20 = **~57 tables** across the whole client install.

---

## Settings toggles added by the Premium overlay

The overlay ships 20 settings keys total (11 module-behavior + 10 office_manager access toggles + 1 leftover). Every office_manager access toggle defaults FALSE per Producer Isolation Principle B.11 — office manager gains cross-staff visibility for a module only when the owner explicitly flips the toggle.

Full inventory lives in the design doc, Appendix B.7. When the client repo needs to know which settings are Premium-provided vs. Base-provided, this document is the source of truth on the Premium side.

---

## What's NOT changed by the overlay

**Base module JSX files are never edited.** The overlay adds new files, adds nav entries via the nav-patch, but does not modify Base module implementations. If a change to (say) `HRPeople.jsx` is needed to add a cross-link to a Premium module, that change belongs in Base master, not in the overlay — coordinate with Base repo owner before making it.

**Base migrations are never modified.** The overlay's migration namespace (100-199) is completely separate from Base's (001-049). No migration in the overlay touches a Base table without adding a column (via idempotent `ALTER TABLE ADD COLUMN IF NOT EXISTS` pattern) or an index. Renames, drops, and destructive changes are not overlay operations.

**Client's `.env` and `AGENCY_ID` are set by the client, respected by the overlay.** The overlay is client-agnostic in code and client-specific at run-time via the client's own configuration.

---

## Producer Isolation Principle summary (from B.11)

This inventory does not restate B.11 in full — see the design doc Appendix B.11 for the authoritative rule. In one sentence: every active staff member sees only their own data plus agency-aggregate context; owner sees all; office_manager gains access per-module via settings toggle; terminated staff have zero access.

Every table listed above has RLS policies enforcing this rule. Every view listed above scopes its output accordingly. Every JSX admin route enforces role at the UI layer as belt-and-suspenders.
