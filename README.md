# BCC Master Template — Imaginary Farms LLC

**Repo:** `cindarellabots-droid/bcc-master-template`
**Audience:** the client's Project Claude during the BCC install + the operator (Rebecca).
**Sister repo:** `cindarellabots-droid/SMBBCC-Imaginary-AI` (the Imaginary AI LLC analog for non-insurance SMBs).

This is the master template for every Business Command Center delivered to a State Farm agent. Each client gets a private copy of this repo wired into their Project Claude. The install playbook lives in `HANDOFF_PROMPTS.md`. Day-to-day operating instructions live in `CLAUDE.md`.

---

## ✅ LLM POLICY — GROQ FREE-TIER API KEY (Updated 2026-07-02)

**The LLM path uses Groq's free OpenAI-compatible REST API directly** — no Composio proxy, no OpenAI / Anthropic / Gemini keys. The automation-runner reads a single credential: `GROQ_API_KEY`.

### Set it once — as an Edge Function secret (NOT a `public.settings` row)

Both IF and IA converged on this pattern on 2026-07-02: the runner reads `GROQ_API_KEY` from Supabase Edge Function secrets, not from the database.

```bash
# 1. Get a free key at https://console.groq.com (no credit card required)
# 2. Set it as an Edge Function secret on the client's Supabase project:
supabase secrets set GROQ_API_KEY=<your-key>
# 3. Redeploy the runner so it picks up the new secret:
supabase functions deploy automation-runner
```

**If a prior install (or an older doc) had you INSERT the key into `public.settings`** — that row is now inert. The runner no longer reads it. Move the value to an Edge Function secret via the command above.

### What the runner calls

```
POST https://api.groq.com/openai/v1/chat/completions
Headers: Authorization: Bearer ${GROQ_API_KEY}
Model:   llama-3.3-70b-versatile (default; llama-3.1-8b-instant available for faster jobs)
```

If `GROQ_API_KEY` is missing when a recipe fires, the runner throws a clear error pointing to console.groq.com and logs `LLM parsing failed` to `automation_run_log`. Set the secret once and you're done.

**Composio still handles non-LLM actions** (Gmail, Drive, Facebook, LinkedIn, Stripe, etc.). Those still use `composio_api_key` and `composio_<conn>_account_id` rows in `public.settings` — that pattern is unchanged.

**Full details for the automation install:** see `docs/AUTOMATIONS_INSTALL.md` (the canonical source of truth for the LLM policy and runner setup as of 2026-07-02).

---

## Where to start

| You are... | Read first |
|---|---|
| **A fresh setup Claude driving a full install from cold-start** | `PRODUCT_VISION.md` (mental model + definition of done) → `CLAUDE.md` (behavior rules + hard-learned bugs) → `HANDOFF_PROMPTS.md` (Path A vs Path B step-by-step). Read in that order. |
| The client's Project Claude, just opened this repo | `CLAUDE.md` (full briefing). Then `HANDOFF_PROMPTS.md` for Path A vs Path B install. |
| The operator pushing this template to a new client's GitHub | `HANDOFF_PROMPTS.md` — copy the appropriate handoff prompt and paste into the client's Project Claude. |
| Reviewing the install architecture | `PRODUCT_VISION.md` + `CLAUDE.md` + `docs/AUTOMATIONS_INSTALL.md` + `docs/DOCUMENT_IMPORTER_GUIDE.md` |

## Key docs

- `PRODUCT_VISION.md` — engineering-side product spec (mental model, 6 core principles, definition-of-done, anti-patterns to catch). Read this before making any agent-facing decisions.
- `CLAUDE.md` — read-first briefing, env vars, smoke test, hard-learned bugs from prior installs
- `HANDOFF_PROMPTS.md` — Path A (existing-DB) vs Path B (clean install) prompts
- `docs/AUTOMATIONS_INSTALL.md` — 12 canonical automation recipes + runner setup + smoke test
- `docs/DOCUMENT_IMPORTER_GUIDE.md` — why the 12 recipes ARE the document importer; do not build a parallel one
- `docs/DRIVE_FOLDER_SETUP.md` — Google Drive folder structure for ingestion
- `docs/MODULE_DATA_WIRING.md` — per-module table dependencies for the React web app
- `docs/PRODUCER_ROI_INSTALL.md` — Performance tab onboarding (SMVC/blended/lapse rates)
- `docs/SELF_HEAL_GUIDE.md` — the "agent screenshots the error, their Claude fixes it" model
- `docs/PROJECT_CLAUDE_SYSTEM_PROMPT_TEMPLATE.md` — the system prompt installed into the agent's Project Claude after technical install
- `SCHEMA_NORMALIZATION_RUNBOOK.md` — Path A bridge-view playbook for existing-database installs

---

**Maintained by:** Rebecca Coelho, Operating Partner, Imaginary Farms LLC
**Owner of record:** Matthew Cooper, Managing Member
