# PRODUCT_VISION.md — Imaginary Farms BCC

**Repo:** `cindarellabots-droid/bcc-master-template`
**Audience:** Setup Claudes, install contractors, and future engineering contributors working on IF client BCCs.
**Not for:** Prospects, agents, or partner-facing surfaces. The client-facing narrative lives in the IF training guide (currently distributed as `bcc-training-guide-v9`, hosted at `imaginary-farms.com/tips` for the usage-tips subset).
**Last updated:** 2026-07-02 (v1 — initial)

---

## Why this document exists

Setup work on an IF BCC involves a lot of technically-correct-but-narratively-blind decisions. A setup Claude can wire modules, run migrations, and pass smoke tests without ever seeing what the finished product *feels like* to the State Farm agent who ends up using it. That gap produces the kind of mistakes that only surface at review — agent-specific example data baked into UI copy, builder vocabulary leaking into customer surfaces, features shipped that violate the product's core mental model, or worse — content that violates AA05 language requirements.

This document is the bridge. It tells you what the finished IF BCC is supposed to look and feel like from the agent's side, so your setup decisions align with the product intent — not just the acceptance criteria of a single migration.

Read this **before** touching any agent-facing surface. Read `CLAUDE.md` for behavior rules. Read the relevant migration for schema. This doc lives in between.

---

## The product in one paragraph

An IF Business Command Center is a complete operating system for a State Farm agency — one that connects Claude (the AI) directly to that agency's private database (Supabase), its Google apps (Gmail, Drive, Calendar), its accounting system (QuickBooks Online), its payroll system (Gusto), and a suite of pre-built automations tuned to the SF data flow (AIPP reports, ScoreCard, COMP_RECAP). The agent interacts with the BCC through two surfaces: **claude.ai** (conversation, reasoning, action) and **the web app** (visual dashboard, 12 modules). Both surfaces read and write the same Supabase, so they always agree. The infrastructure is owned by the agent (their Google account, their Supabase, their GitHub, their Vercel deployment). Imaginary Farms assembles and configures the system; the agent owns the running result. What makes IF specifically valuable is that the entire product is **State Farm-aware** — the Compliance Center cites AA05 clauses, the Financials module speaks AIPP/COMP_RECAP natively, and the Claude instructions file understands the language rules and PFA separation requirements that govern SF agencies.

---

## Core mental model — six principles the agent experiences

These are the principles that govern the agent's expectations. Every setup decision should reinforce them; nothing should violate them.

### 1. Two interfaces, one shared brain
The agent has two ways to interact with the BCC: **Claude.ai** for talking (asking, planning, drafting, deciding) and **the web app** for looking (checking numbers, verifying, sharing screens with the team). They are not redundant — they're for different jobs. But because both read and write the same Supabase, they always agree. *"Talking = Claude. Looking = web app."*

### 2. Data lives in the agent's database, not a vendor's SaaS
The agent's operational data lives in **their** Supabase, under **their** Google login. Not in QuickBooks Online's cloud alone. Not in a vendor's proprietary store. The agent can fire Imaginary Farms tomorrow and still own the running system. Setup decisions must preserve this — never introduce a dependency that would make the system unrecoverable without IF in the loop.

### 3. AI knows the agency — no cold starts
Every Claude conversation loads the agent's full agency context at the start: staff, financials, AIPP progress, ScoreCard targets, comp structures, AA05-grounded compliance rules, goals, and recent decisions. This is what makes the BCC different from generic AI — and it's what makes it State Farm-aware. The mechanism is a Claude instructions file (tailored per agent) plus live memory pulled from Supabase.

### 4. The web app is a window, not a workbench
Agents don't edit data in the web app. Claude edits data. Automations edit data. The web app renders what's there. This is a hard constraint on UI design: no data-entry forms in modules that already have automated intake. If a module needs manual override, route it through Claude with a confirmation step — not a direct edit UI.

### 5. The system self-heals via Claude as operator
When something breaks (a connection expires, a module shows an alert, an automation fails), the pattern is: **screenshot → paste to Claude → follow the steps.** The BCC is designed so the agent never has to remember which dashboard to log into or what to click. Setup work should preserve this — surface errors in ways Claude can actually diagnose from a screenshot.

### 6. Compliance is a guardrail, not a checkbox
Because agents operate under an active AA05 Agreement with State Farm, every content-generating surface in the BCC (email drafts, social posts, marketing copy, client comms) runs through the Compliance Center's rule library. Claude pushes back on non-compliant content in the moment, citing the specific AA05 clause. Setup work must preserve this — never bypass the compliance layer on a "helper" module, never add a shortcut that lets content generation skip rule-checking.

---

## What ships in a completed IF BCC

This is the definition of done for a setup. If any of these are missing or broken at handoff, the install isn't finished.

### Infrastructure (owned by the agent)

| Layer | What | Owned by |
|---|---|---|
| AI | Claude.ai account with BCC Project | Agent Google login |
| Database | Supabase project with agent schema | Agent Google login |
| Automation engine | Composio account with connected integrations | Agent Google login |
| Web app source | GitHub repo (fork of `bcc-master-template`) | Agent Google login |
| Web app hosting | Vercel deployment from the GitHub repo | Agent Google login |
| File storage | Google Drive with entity/year/category folder structure | Agent Google account |
| Comms + intake | Gmail (both agent comms and document intake) | Agent Google account |
| Scheduling | Google Calendar | Agent Google account |
| Accounting sync | QuickBooks Online, connected to Supabase via Composio | Agent's QBO |
| Payroll data | Gusto, connected via Composio | Agent's Gusto |

### Web app — 14 modules

Every completed IF BCC ships all 14. Ground truth is the router in `BCCApp.jsx` — 14 nav entries. Modules can be reordered or restyled per agent, but none may be removed at setup without explicit sign-off from Rebecca.

1. **Dashboard** — daily snapshot: revenue, AIPP progress, monthly close, alerts
2. **Financials** — P&L, COMP_RECAP, AIPP & ScoreBoard, Payroll, Bank, Credit, GL
3. **Memory** — persistent context Claude carries across sessions
4. **Wiki & System Map** — in-app reference for how the agent's BCC is wired; sourced from IF master
5. **Playbook & Guide** — SF-adapted prompts organized by section; the differentiator, not decoration
6. **Compliance** — AA05-grounded rules, deadlines, audit log
7. **Automations** — every automation's last run, status, and connection health
8. **Social Media** — content calendar, scheduled posts, campaign tracking
9. **Tasks & Goals** — what's open, what's due, what Claude assigned
10. **Alerts** — anything Claude flagged that needs attention
11. **Documents** — every processed file with one-click Drive links
12. **HR & People** — producers, team performance, ROI, payroll context
13. **Claude Chat** — launch Claude conversations from inside the app
14. **Settings** — business profile, accounts, automation config, tech stack reference

**Compliance module deserves special attention.** This is the module that makes the IF BCC materially different from a generic SMB tool. It ships pre-loaded with a rule library (currently 57 rules) that cites specific AA05 clauses and regulatory requirements. Setup must verify the rule library loaded correctly at deploy — a BCC without a working Compliance module isn't a State Farm BCC, it's an SMB BCC with an insurance label.

### Claude instructions file
Tailored per agent. Contains agency structure, staff, comp structures, ScoreCard targets, AIPP details, AA05-relevant language rules, tone preferences, and any agent-specific behavior rules. This is what makes Claude "know" the agency.

### Automations (Composio-managed)
At minimum: document processing pipeline (Gmail → Groq extract → Supabase → Drive filing), daily briefing, persistent memory logging. IF-specific document types the pipeline handles: SF comp recaps, AIPP reports, Gusto payroll journals, bank statements, credit card statements, loan statements, E&O policy renewals.

### Master Financial Tracker (MFT)
IF ships an MFT integration (currently v4) that runs two parallel tracking systems: P&L following the agent's Chart of Accounts, and COMP_RECAP for SF-specific detail (AIPP, new business, renewal, life, commercial). PFA balances (Premium Fund Account — State Farm's money in transit through the agent's PFA) never appear on the balance sheet; only compliance reminders for premium-flow reporting. S-Corp Medical tracking on W-2. Setup must verify both tracking systems are configured before handoff.

---

## What must NOT ship — anti-patterns to catch at setup

These are the mistakes that setup Claudes drift into if they're not paying attention. Every one of these has cost real cleanup time.

### Never bake agent-specific data into UI copy
Example: if you're writing a lesson, tooltip, placeholder, or example query in a module, **do not** use the current agent's actual agency name, producer names, client names, dollar amounts, or ScoreCard targets. Use generic placeholders like "your agency," "your top producer," "your renewal book." This applies even in single-tenant deployments — the master repo gets backported to future agents and Rebecca reviews screens across installs.

### Never use engineer vocabulary in agent-facing surfaces
The following terms are **banned** from any customer-facing UI, tooltip, help text, module description, or lesson content. This rule applies cross-entity (established for IA per IA operational_rule `865b2b84`, mirrored here for IF because the vocabulary discipline is identical):

| Banned (out) | Use instead (in) |
|---|---|
| LLM, large language model | Claude *(or "the AI" if Claude is already mentioned nearby)* |
| CLAUDE.md | your Claude instructions file |
| MCP, MCP server | integration |
| cron, cron job, cron trigger, pg_cron | scheduled automation |
| recipe, recipes *(automation sense)* | automation, automations |
| repo, commit | your project files, update |
| Edge Function | automation |

Terms that ARE OK to use agent-facing (real product names the agent will see): **Claude, Business Command Center, BCC, Supabase, Composio, QuickBooks/QBO, Gusto.** For "Project" (capital P — meaning a Claude Project workspace), include a first-mention gloss on any new asset.

### Never violate AA05 language rules in generated content or UI copy
State Farm's AA05 Agent Agreement imposes specific language requirements that apply to any content the BCC generates or displays. These are not stylistic preferences — they are contractual obligations:

- **"customer" not "client"**
- **"agent" not "expert" or "specialist"**
- **All SF-referencing ads require prior approval**
- **All content in English** — FINRA archiving required
- **PFA (Premium Fund Account) is NOT an agent asset** — premium payments from customers land in the agent's PFA and State Farm sweeps them immediately. The money passes through the agent's operational surface but belongs to State Farm. Never record PFA balances on the agent's balance sheet.
- **PFA reporting stays separate from the agent's books** — never commingle premium-flow activity with the agent's revenue, commissions, or expenses. This is both an accounting hygiene rule and a compliance requirement.
- **No "enter to win"** — every participant must receive item (giveaway compliance)
- **GBP: insurance products only** — no financial services

Setup Claudes writing new UI copy, tooltip content, or example queries must run their draft against this list. Rebecca's Claude does this automatically at runtime for agent-generated content; the setup surface must not weaken that guardrail by shipping non-compliant example content that agents might copy.

### Never mix IF and IA infrastructure or reference IA from IF surfaces
IF and IA are separate LLCs with separate Supabase projects, Stripe accounts, banks, partners, ambassadors, GitHub orgs, and websites. Setup work must never write IF data to IA Supabase or vice versa. Do not reference IA, "small business AI," or Jay Trudeau in IF surfaces. IF stands on its own as the State Farm-specific product.

### Never send agent-facing outbound to @statefarm.com addresses
State Farm's spam filters block external email to @statefarm.com every time. Any onboarding, welcome, training, or transactional email flow the setup Claude ships must have a step that collects the agent's personal email address before any send. If the setup ships without that guard, the agent will silently miss critical comms.

### Never add data-editing UI to modules with automated intake
If a module receives data through an automation (Financials from QBO, Documents from Composio, Payroll from Gusto), it does **not** get a manual edit UI. Manual overrides route through Claude.

### Never hard-code a single-entity assumption
Even single-entity agents get a multi-entity-capable structure. IF supports agents with multi-state agency structures, PFA sub-entities, and side ventures. If you catch yourself writing `entity_id = 1` or "the entity" (singular) anywhere in module logic, stop and generalize.

---

## Setup principles for Claudes doing install work

1. **Read this doc, then `CLAUDE.md`, then the relevant migration before writing code.** Skipping this is where cost overruns start.
2. **Backport pattern is one-way: IF master → agent fork. Never the reverse.** If you improve something in an agent fork, propose the change against IF master and Rebecca decides whether to backport.
3. **When adding any agent-facing content (UI copy, lesson content, placeholder text, example queries), use generic placeholders and run the AA05 language check.** Then run a mental grep against the banned engineer-vocabulary list above.
4. **When in doubt about product intent, read the IF training guide (currently `bcc-training-guide-v9`) before guessing.** That's the canonical customer-facing narrative — it tells you what the agent thinks they're buying.
5. **When something breaks in an agent install, follow the same self-heal pattern you're shipping to the agent:** screenshot the state, describe the intent, work the problem. Don't route around Claude just because you can.
6. **All GitHub operations on `cindarellabots-droid` org repos route through Composio, not native GitHub MCP.** This is an operational constraint carried over from IA — the org is private and native GitHub MCP cannot reach it.

---

## Where the canonical narrative lives

| Surface | URL / location | Purpose |
|---|---|---|
| Full training guide | `bcc-training-guide-v9` (PDF/HTML, distributed with install) | 18-lesson customer-facing tour of the IF BCC. This is what the agent reads to learn the product. |
| Marketing / discovery | `imaginary-farms.com` | Prospect-facing site (Lovable-hosted). |
| Usage tips | `imaginary-farms.com/tips` | 10 Claude-usage tips referenced from the training guide's Lesson 18. |

This `PRODUCT_VISION.md` is the engineering-side companion to those pages. When those pages change, this doc may need to update too — check consistency at every material release.

---

## Cross-entity note

**Imaginary AI LLC (IA)** — the sister entity serving non-insurance small business owners — has an analogous product with the same architectural shape (two interfaces, shared Supabase brain, Claude as operator, self-healing pattern) adapted for the general SMB domain. Key structural differences:

- **Tax module** (IA) instead of **Compliance module** (IF) — grounded in entity-type tax profiles (Sole Prop, LLC, S-Corp, C-Corp, Partnership) rather than AA05 Agreement clauses.
- **QBO + multi-entity consolidation** as the primary financial data hook (IA) instead of AIPP/ScoreCard/COMP_RECAP flows (IF).
- **Different brand palette** — IA uses navy/teal (modern operational); IF uses coral/cream (agricultural feel).
- **Different partner structure** — IA has a single-payer Founding Ambassador model (Jay Trudeau, grandfathered 30%); IF has a dual-payment model where Alyssa's 20% ambassador override can stack on Kellie or Kim's channel partner spread.

The IA `PRODUCT_VISION.md` lives at `cindarellabots-droid/SMBBCC-Imaginary-AI` and follows this same structure. Setup Claudes on IA work read that doc — never this one. Never bleed IF terminology (State Farm, AIPP, AA05, ScoreCard, COMP_RECAP) into IA work, or vice versa. Separation is a legal-hygiene requirement, not a stylistic preference.

---

## Change log

| Date | Change | Author |
|---|---|---|
| 2026-07-02 | v1 — initial. Mirrored from IA `PRODUCT_VISION.md` v1 with IF domain adaptations (Compliance replaces Tax, AA05 language rules, ScoreCard/AIPP/COMP_RECAP data flows, dual-payment partner structure, coral/cream brand). | Rebecca + Main Claude |
| 2026-07-02 | v1.0.1 — PFA definition corrected. Original draft incorrectly expanded PFA as "Personal Financial Advisor." Correct meaning: **Premium Fund Account** — the account where customer premium payments land before State Farm sweeps them. PFA is State Farm's money in transit, never an agent asset. Rebecca caught the error same-day. | Rebecca + Main Claude |
| 2026-07-02 | v1.0.2 — Removed unverified AA05 §-number citations (§1.B, §1.O, §1.H) from the AA05 language rules section. The rules themselves are correct and remain in force; the specific clause numbers were inferred from the training guide rather than confirmed against source and could not be verified same-day. Section header still scopes everything below to AA05. | Rebecca + Main Claude |

---

*End of PRODUCT_VISION.md.*
