# recipe_seeds — Reference recipe SQL

This folder contains the **per-recipe SQL** for the 14 canonical BCC automation recipes. **These files are for reference only — the canonical install invokes them all in one call via `SELECT public.seed_bcc_automations(...)` (see `supabase/migrations/seed_bcc_automations.sql`).** Do NOT run these files by hand during install; the seed function handles ordering, config placeholder resolution, and payroll-variant switching.

## Why 16 files → 14 recipes?

Files `01_document_processor.sql` through `13_cc_gl_writer.sql` are the 13 always-active recipes (with two exceptions — see below). File `14_gl_account_mapping_TEMPLATE.sql` (if present) is a per-client template, not a seeded recipe. The two payroll-variant files (`05a_payroll_gl_writer_single_entity.sql`, `05b_payroll_gl_writer_two_entity.sql`) are **conditional** — the seed function picks one based on `p_payroll_variant`:

| p_payroll_variant | 05a active | 05b active |
|---|---|---|
| `single_entity` (default) | ✅ yes | ❌ no |
| `two_entity` | ❌ no | ✅ yes |

So 16 files in the folder assemble into 14 recipe rows: 12 always-active + 1 payroll variant + 1 conditional recipe (Instagram Manual Reminder is inactive at seed).

## Per-file inventory

| File | Recipe name | Handler | Active at seed |
|---|---|---|---|
| 01_document_processor.sql | Document Processor | `dispatch_document_processor` (undefined at master — B8b) | ⚠ active but errors until B8b lands |
| 02_daily_briefing_email.sql | Daily Briefing Email | (Composio-driven, no INTERNAL handler) | ✅ |
| 03_producer_underperformance_watcher.sql | Producer Underperformance Watcher | `producer_underperformance_watcher` (migration 012) | ✅ |
| 04_email_archiver.sql | Email Archiver | `dispatch_email_archiver` (undefined at master — B8b) | ⚠ active but errors until B8b lands |
| 05a_payroll_gl_writer_single_entity.sql | Payroll GL Writer (single-entity) | `payroll_gl_writer` (migration 014, backported) | ✅ if `p_payroll_variant='single_entity'` |
| 05b_payroll_gl_writer_two_entity.sql | Payroll GL Writer (two-entity) | `payroll_gl_writer` (migration 014, backported) | ✅ if `p_payroll_variant='two_entity'` |
| 06_social_instagram.sql | Social — Instagram Manual Reminder | `instagram_manual_reminder` (undefined — B8b) | ❌ inactive at seed |
| 07_monthly_close_monitor.sql | Monthly Close Monitor | `monthly_close_monitor` (migration 012) | ✅ |
| 08_social_facebook.sql | Social — Facebook | (Composio-driven) | ❌ inactive at seed (needs FB OAuth) |
| 09_social_linkedin.sql | Social — LinkedIn | (Composio-driven) | ❌ inactive at seed (needs LinkedIn OAuth) |
| 10_monthly_close_generator.sql | Monthly Close Generator | `monthly_close_generator` (migration 014, backported) | ✅ |
| 11_gl_entry_writer.sql | GL Entry Writer | `gl_entry_writer` (migration 012) | ✅ |
| 12_bank_gl_writer.sql | Bank GL Writer | `bank_gl_writer` (migration 014, backported) | ✅ |
| 13_cc_gl_writer.sql | Credit Card GL Writer | `cc_gl_writer` (migration 014, backported) | ✅ |
| 14_gl_account_mapping_TEMPLATE.sql | *(not a recipe; per-client mapping template)* | — | — |

## After seeding — recommended action

The seed function sets `is_active=true` for 4 recipes whose handlers are not yet defined at master. Until B8b lands (merges the 3 remaining handlers plus the runner extensions needed to orchestrate them), the safe post-seed cleanup is:

```sql
-- Disable the 4 recipes whose handlers are undefined at master
UPDATE public.automation_recipes
   SET is_active = false
 WHERE agency_id = '<client-agency-uuid>'
   AND internal_handler IN (
     'dispatch_email_archiver',
     'dispatch_document_processor',
     'instagram_manual_reminder'
   );
```

Or, use `system_status` (migration 013) to mark them `customization_pending` so the client's Claude presents them as install runway rather than as broken. See `docs/AUTOMATIONS_INSTALL.md` for the full B8 discussion and recommended action.

## Related files

- **`../migrations/seed_bcc_automations.sql`** — the canonical seeder function; call this, not the individual files.
- **`../migrations/012_internal_recipe_handlers.sql`** — original 3 INTERNAL handlers.
- **`../migrations/014_missing_internal_handlers.sql`** — 4 additional INTERNAL handlers backported from Kwame Tyler's fork (2026-07-02).
- **`../../docs/AUTOMATIONS_INSTALL.md`** — full install playbook including the recipe reference table and the seed function invocation template.
- **`../../tools/recipe_validation.sql`** — post-seed sanity check (recipe count, active/inactive split, GL chain timing, required settings, last 24h run_log).
