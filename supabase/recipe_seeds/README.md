# recipe_seeds — Reference recipe SQL

This folder contains the **per-recipe SQL** for the 14 canonical BCC automation recipes. **These files are for reference only — the canonical install invokes them all in one call via `SELECT public.seed_bcc_automations(...)` (see `supabase/migrations/seed_bcc_automations.sql`).** Do NOT run these files by hand during install; the seed function handles ordering, config placeholder resolution, and payroll-variant switching.

## Why 16 files → 14 recipes?

Files `01_document_processor.sql` through `13_cc_gl_writer.sql` are the 13 always-active recipes (with two exceptions — see below). File `14_gl_account_mapping_TEMPLATE.sql` (if present) is a per-client template, not a seeded recipe. The two payroll-variant files (`05a_payroll_gl_writer_single_entity.sql`, `05b_payroll_gl_writer_two_entity.sql`) are **conditional** — the seed function picks one based on `p_payroll_variant`:

| p_payroll_variant | 05a active | 05b active |
|---|---|---|
| `single_entity` (default) | ✅ yes | ❌ no |
| `two_entity` | ❌ no | ✅ yes |

So 16 files in the folder assemble into 14 recipe rows: 12 always-active + 1 payroll variant + 1 conditional recipe (Instagram Manual Reminder is inactive at seed by design).

## Per-file inventory

| File | Recipe name | Handler | Active at seed |
|---|---|---|---|
| 01_document_processor.sql | Document Processor | `dispatch_document_processor` (migration 030 + runner v3, backported) | ✅ |
| 02_daily_briefing_email.sql | Daily Briefing Email | (Composio-driven, no INTERNAL handler) | ✅ |
| 03_producer_underperformance_watcher.sql | Producer Underperformance Watcher | `producer_underperformance_watcher` (migration 012) | ✅ |
| 04_email_archiver.sql | Email Archiver | `dispatch_email_archiver` (migration 030 + runner v3, backported) | ✅ |
| 05a_payroll_gl_writer_single_entity.sql | Payroll GL Writer (single-entity) | `payroll_gl_writer` (migration 014, backported) | ✅ if `p_payroll_variant='single_entity'` |
| 05b_payroll_gl_writer_two_entity.sql | Payroll GL Writer (two-entity) | `payroll_gl_writer` (migration 014, backported) | ✅ if `p_payroll_variant='two_entity'` |
| 06_social_instagram.sql | Social — Instagram Manual Reminder | `instagram_manual_reminder` (migration 030 + runner v3, backported) | ❌ inactive at seed by design |
| 07_monthly_close_monitor.sql | Monthly Close Monitor | `monthly_close_monitor` (migration 012) | ✅ |
| 08_social_facebook.sql | Social — Facebook | (Composio-driven) | ❌ inactive at seed (needs FB OAuth) |
| 09_social_linkedin.sql | Social — LinkedIn | (Composio-driven) | ❌ inactive at seed (needs LinkedIn OAuth) |
| 10_monthly_close_generator.sql | Monthly Close Generator | `monthly_close_generator` (migration 014, backported) | ✅ |
| 11_gl_entry_writer.sql | GL Entry Writer | `gl_entry_writer` (migration 012) | ✅ |
| 12_bank_gl_writer.sql | Bank GL Writer | `bank_gl_writer` (migration 014, backported) | ✅ |
| 13_cc_gl_writer.sql | Credit Card GL Writer | `cc_gl_writer` (migration 014, backported) | ✅ |
| 14_gl_account_mapping_TEMPLATE.sql | *(not a recipe; per-client mapping template)* | — | — |

## After seeding — recommended action

After running the seed function, all 14 handlers are defined and 12 of 14 recipes are `is_active=true`. **No cleanup UPDATE is required.**

Two recipes remain intentionally `is_active=false` at seed:

1. **Social — Instagram (recipe #6)** — activate after `content_calendar` has scheduled Instagram posts AND `settings.owner_email` (or `settings.bookkeeper_email`) is populated. The `instagram_manual_reminder` handler needs a valid destination email to send the manual-post reminder to.
2. **Social — Facebook (recipe #8) / Social — LinkedIn (recipe #9)** — activate after the client connects Facebook Pages / LinkedIn Company Pages via Composio OAuth and sets the corresponding `facebook_page_id` / `linkedin_org_urn` in `settings`.

## Related files

- **`../migrations/seed_bcc_automations.sql`** — the canonical seeder function; call this, not the individual files.
- **`../migrations/012_internal_recipe_handlers.sql`** — original 3 INTERNAL handlers (`gl_entry_writer`, `monthly_close_monitor`, `producer_underperformance_watcher`).
- **`../migrations/014_missing_internal_handlers.sql`** — 4 additional pure-SQL INTERNAL handlers backported from Kwame Tyler's fork 2026-07-02 (B8a: `bank_gl_writer`, `cc_gl_writer`, `payroll_gl_writer`, `monthly_close_generator`).
- **`../migrations/030_two_stage_recipe_helpers.sql`** — 12 helper functions + `content_calendar` schema additions supporting the 3 two-stage handlers (B8b, 2026-07-03: `dispatch_email_archiver`, `dispatch_document_processor`, `instagram_manual_reminder`). Paired with runner v3 (`supabase/functions/automation-runner/index.ts`).
- **`../../docs/AUTOMATIONS_INSTALL.md`** — full install playbook including the recipe reference table.
- **`../../tools/recipe_validation.sql`** — post-seed sanity check (recipe count, active/inactive split, GL chain timing, required settings, last 24h run_log).
