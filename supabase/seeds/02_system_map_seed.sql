-- supabase/seeds/02_system_map_seed.sql
-- Initial system_map seed pages for a fresh IF BCC install.
--
-- These are the canonical starter pages that document the IF BCC pattern
-- for a State Farm insurance agent. They are idempotent (ON CONFLICT
-- DO NOTHING) so re-running the seed after an agent has customized their
-- own pages will not clobber edits. Agents (and their Claude) are expected
-- to evolve these pages over time via the SystemMap editor.
--
-- source_of_truth='manual' = human-authored, hand-curated, changes only
--   when someone edits the page in the SystemMap UI.
-- source_of_truth='auto' = a future automation recipe will overwrite
--   body_md from live state.

INSERT INTO public.system_map (slug, title, category, body_md, related_slugs, sort_order, source_of_truth, last_verified_by)
VALUES

-- =========================================================================
-- 1) OVERVIEW
-- =========================================================================
('bcc-overview', 'What This BCC Is', 'overview',
$page$# What This BCC Is

A Business Command Center (BCC) is your operational dashboard, source-of-truth database, and Claude-powered partner — combined into one self-owned system, built specifically for a State Farm agency.

## What you actually have

- **Your own Supabase database** holding every meaningful operational record: producer roster, AIPP results, ScoreCard data, COMP_RECAP entries, compliance rules, monthly P&L, documents, automations.
- **Your own GitHub repo** containing the code that makes this all work (Edge Functions, migrations, the webapp UI you're looking at right now).
- **Your own Claude** — the same Claude you're reading this with — who has MCP access to your data and helps you operate the agency across every domain.
- **Composio** as the integration layer: Gmail, Drive, and other services connect through Composio so you never have to manage individual API keys.

## What this BCC is **not**

- It is not a SaaS subscription. There is no monthly Imaginary Farms fee.
- It is not vendor-locked. You own every component — if Anthropic, Supabase, GitHub, or Composio vanished tomorrow, your data still belongs to you.
- It is not "just dashboards." The dashboards are the surface; the methodology is teaching your Claude to be a true business partner across your operations.

## The point

Your Claude is the product. The schema, the modules, the automations — those are the chassis. The fluency you build with your Claude over weeks and months is the actual value.

When in doubt: ask your Claude. It has access to everything in this database.
$page$,
ARRAY['schema-state-farm-data-model','integration-composio','runbook-monthly-close'],
10, 'manual', 'install_seed'),

-- =========================================================================
-- 2) SCHEMA
-- =========================================================================
('schema-state-farm-data-model', 'State Farm Data Model', 'schema',
$page$# State Farm Data Model

The schema is built around the operational reality of a State Farm agency: one agency entity, a roster of producers, monthly AIPP/ScoreCard/COMP_RECAP data flows, and the compliance ruleset State Farm publishes for agents.

## Core tables

- **`producers`** — one row per licensed producer attached to the agency. Has name, license number, hire date, role, status, and historical compensation snapshots.
- **`aipp_results`** — Agency Incentive Performance Program monthly rollups per agency (and per producer where applicable).
- **`scorecard_data`** — State Farm ScoreCard monthly snapshots; book-of-business KPIs.
- **`comp_recap`** — monthly commission and bonus recap entries reconciled against State Farm payments.
- **`compliance_rules`** — published State Farm compliance ruleset (seeded in migration 002). The Compliance Center module checks operational state against these rules.
- **`monthly_pl`** + **`monthly_balance_sheet`** — financial reports per month, cash-basis.

## What we do NOT do

- **No multi-entity consolidation.** The IF BCC is built around the single State Farm agency entity. Any side businesses an agent runs are intentionally OUT OF SCOPE (use a separate Imaginary AI BCC for those).
- **No accrual basis.** Cash basis only.
- **No PDF parsing.** Source data comes from State Farm exports (CSV) and agent-uploaded financial reports.

## Tier mapping

- First entity: $2,995 setup
- Additional setup work (e.g., custom dashboards, extra automation recipes): see Imaginary Farms pricing schedule.
$page$,
ARRAY['bcc-overview','runbook-monthly-close','decision-no-monthly-fees'],
20, 'manual', 'install_seed'),

-- =========================================================================
-- 3) INTEGRATION
-- =========================================================================
('integration-composio', 'How Composio Powers Integrations', 'integration',
$page$# How Composio Powers Integrations

Composio is the integration layer between your BCC and external services (Gmail, Drive, Claude as a tool inside automations, etc.). You authorize Composio once per service; your BCC's Edge Functions call Composio's API instead of managing per-service credentials.

## Why this matters

- **One auth ceremony per service.** Connect Gmail once. Connect Drive once. Done.
- **No API keys to rotate inside your repo.** Composio holds them; your code holds only `COMPOSIO_API_KEY`.
- **LLM calls go through Composio too.** `COMPOSIO_SEARCH_GROQ_CHAT` is the tool your automations use for any AI step. No separate Groq/OpenAI/Anthropic key.

## What's connected

The Settings module shows your current connections. The minimum useful set is: Gmail (for inbound document ingest), Drive (for document archival), and Claude (for any LLM-driven automation step).

## How automations use Composio

Every automation recipe `automations` row has `input_config` that may reference Composio tools by name. The `automation-runner` Edge Function (migration 011) resolves those tool refs to Composio API calls at execution time.
$page$,
ARRAY['bcc-overview','runbook-monthly-close'],
30, 'manual', 'install_seed'),

-- =========================================================================
-- 4) RUNBOOK
-- =========================================================================
('runbook-monthly-close', 'Monthly Close Runbook', 'runbook',
$page$# Monthly Close Runbook

Each month, between the 25th and the 5th of the following month, the BCC walks through a structured close. The Monthly Close Checklist module surfaces remaining items.

## Inputs to capture

1. **State Farm exports** — AIPP, ScoreCard, COMP_RECAP for the close month.
2. **Bookkeeping reports** — Profit & Loss, Balance Sheet, GL detail. Send to the BCC intake email; the email-ingest Edge Function parses and stores them.
3. **Bank/credit card statements** — sales receipts, vendor bills, recurring expenses.

## What the BCC does automatically

- Document processor parses each ingest as it lands and writes `documents` + `monthly_pl` rows.
- Monthly close monitor recipe (recipe seed `07_monthly_close_monitor`) emails a status recap every Monday during the close window.
- The Compliance Center cross-checks the State Farm rules against operational state.

## What you do manually

- Reconcile the parsed totals against State Farm's source documents.
- Review the producer ROI dashboard for the month.
- Close the period via `SELECT open_close_period_all(:period_month, FALSE);` once everything ties.

## What "closed" means

Once a period is closed, the `period_open_close` row flips to FALSE and write paths to that month's data are blocked (RLS/check constraints). Reopen via the same RPC with `TRUE`.
$page$,
ARRAY['schema-state-farm-data-model','automation-monthly-close-monitor'],
40, 'manual', 'install_seed'),

-- =========================================================================
-- 5) DECISION
-- =========================================================================
('decision-no-monthly-fees', 'Why No Monthly Subscription', 'decision',
$page$# Why No Monthly Subscription

Imaginary Farms charges a one-time setup fee for the BCC. There is no monthly recurring fee from Imaginary Farms.

## What you pay monthly

- **Supabase** — your database hosting. Free tier handles most agencies; paid plans for larger volumes.
- **Vercel** — your webapp hosting. Free tier handles most agencies.
- **Composio** — integration layer pricing tier (often free for low volumes).
- **Anthropic** — your own Claude subscription (Pro or Team).
- **GitHub** — free for private repos.

## Why this matters

You own every component. If Imaginary Farms shuts down tomorrow, your BCC keeps running because you have the database, the code, the integrations, and the Claude relationship — none of which depend on a running Imaginary Farms server.

The brittleness of typical SaaS — vendor goes away, you lose your data, you lose your tooling, you start over — does not exist here.

## Ongoing support

Setup includes 30 days of post-handoff technical support from Imaginary Farms. Beyond 30 days, your own Claude is your primary support channel (with help from the Imaginary Farms community group when needed).
$page$,
ARRAY['bcc-overview'],
50, 'manual', 'install_seed')

ON CONFLICT (slug) DO NOTHING;
