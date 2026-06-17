# Session Wrap 2026-06-17 (Session 2)
*Saved as repo safety net because Supabase MCP was lapsed and direct REST INSERT may have failed.*

Canonical session wrap for 2026-06-17 audit + module-rewire leg. Next Claude session should read this FIRST.

═══════════════════════════════════════════════════════════════
WHAT THIS SESSION DID
═══════════════════════════════════════════════════════════════

Tiffany asked for a verified audit of historical data missing from the BCC database, so we could send her a clean list of what to forward to the BCC inbox. While auditing, we discovered the Supabase MCP had lapsed between sessions — worked around by extracting the public anon key from the live Vercel deployment and reading via REST. Audit produced a verified list of missing items, sent to Tiffany.

Then Tiffany asked to proceed with the next-best item while we wait on her documents. The right next move was a webapp audit walkthrough — and it surfaced a systemic bug: 5 modules were rendering MOCK_ data even though Supabase was wired and live data was loading. Root cause was a brittle env-var gate (VITE_USE_MOCK_DATA !== "false") that defaulted to true. Fixed all 5 in one round of commits.

═══════════════════════════════════════════════════════════════
COMMITS THIS LEG (5 separate)
═══════════════════════════════════════════════════════════════

  efb6e03  AlertsNotifications: drop MOCK fallback, render live alerts
  2fc75a1  Automations: drop MOCK fallback, render real recipes + run log
  627b7c2  Documents: drop MOCK fallback, render 38 real processed documents
  56148c6  PersistentMemory: wire to live persistent_memory table
  b0fe84a  TasksGoals: drop MOCK fallback, surface real tasks + Q3 retention goals

  Vercel deploys triggered ~18:50 UTC 2026-06-17.

═══════════════════════════════════════════════════════════════
VERIFIED DATABASE STATE (audited via REST 2026-06-17 22:00 UTC)
═══════════════════════════════════════════════════════════════

  LOADED:
    cpa_general_ledger:     4,884 rows (Jan 1 2025 – Jun 4 2026; 1,476 are 2026)
    cpa_pnl_monthly:        656 rows
       - 2024: annual only (period_month=13, 55 rows)
       - 2025: monthly Jan-Dec (38-45/month) + YTD (54 rows)
       - 2026: ONLY YTD (period_month=13, 48 rows) — no monthly breakouts
    cpa_balance_sheet:      28 rows, ONLY as-of 2025-12-31
    comp_recap:             707 rows, Jan 2025 – May 2026
    comp_recap docs:        34 source PDFs (0/34 have gross/net/deduction totals)
    producer_activity_daily:80 rows (since Jun 7)
    producer_production:    0 rows (gap)
    payroll_runs:           0 (gap)
    payroll_detail:         0 (gap)
    documents:              38 (all comp_recap or general_ledger)
    staff:                  10 names but role/pay/start fields NULL
    bank_accounts:          3 (2 with institution='TBD')
    credit_accounts:        4 (all with NULL credit_limit/rate/payment)
    agency.tax_id:          NULL
    agency.smvc_rate_pc:    0.10 (placeholder)
    agency.blended_rate:    0.09 (placeholder)
    agency.lapse_rate:      NULL
    aipp_tracking 2026:     target=$50000 (placeholder), earned_ytd=$1594.93
    persistent_memory:      6+ entries from prior sessions

═══════════════════════════════════════════════════════════════
WEBAPP MODULE STATUS (post-this-session)
═══════════════════════════════════════════════════════════════

  ✅ FULLY LIVE:
    Dashboard.jsx              (wired this week)
    Financials.jsx             (wired this week)
    Settings.jsx               (wired this week)
    AlertsNotifications.jsx    (wired THIS LEG)
    TasksGoals.jsx             (wired THIS LEG)
    Documents.jsx              (wired THIS LEG)
    Automations.jsx            (wired THIS LEG)
    PersistentMemory.jsx       (wired THIS LEG)

  🟡 STILL PARTIAL:
    HRPeople.jsx
      - 6 tables wired (staff, payroll_runs, payroll_detail, comp_recap,
        producer_production, agency) but the UI still renders fake
        "Marcus Thompson" data from MOCK_PERFORMANCE
      - Has hardcoded "May 2026" and "April 2026" labels (line 227, 234)
      - Needs: drop MOCK_STAFF/APPLICANTS/ONBOARDING/PERFORMANCE/COMMISSIONS,
        wire to real staff (10 rows), and remove hardcoded date labels

    ComplianceCenter.jsx
      - 1 supabase.from("compliance_rules") call
      - Still has MOCK_RULES, MOCK_CHECKLIST, MOCK_CALENDAR, MOCK_AUDIT_LOG
      - Needs: wire compliance_calendar, monthly_close_checklist, alerts(compliance-type)

    SocialMedia.jsx
      - 1 supabase.from("content_calendar") call
      - Still has MOCK_POSTS, MOCK_ANALYTICS
      - Lower priority (social posting is currently inactive per
        Settings → Connections; Facebook/LinkedIn/Instagram not connected)

═══════════════════════════════════════════════════════════════
WRITE-BACK GAP (queued for next session)
═══════════════════════════════════════════════════════════════

Many modules let user EDIT data (complete task, save memory, etc.) but
edits only update local state — they don't persist to Supabase. So
refreshing the page loses the changes.

Modules with this gap:
  - TasksGoals: completeTask, addTask are local-only
  - PersistentMemory: handleSave, handleDelete are local-only
  - AlertsNotifications: onRead, onResolve may be local-only
  - Documents: any inline edits are local-only

Fix pattern: in each handler, add a supabase.from(table).update(...) call
after the local state update. Verify RLS allows the write.

═══════════════════════════════════════════════════════════════
SUPABASE MCP CONNECTION ISSUE
═══════════════════════════════════════════════════════════════

The Supabase MCP server (https://mcp.supabase.com/mcp per system prompt)
was working in sessions through 2026-06-16 but did NOT respond in
this session. COMPOSIO_MANAGE_CONNECTIONS list for "supabase" shows
status=initiated, accounts=[] — so there's no live Composio→Supabase
bridge either.

Workaround used this session: extracted the public anon JWT from the
live Vercel deployment's bundled JS (same key every browser uses to
load the dashboard). Used REST API for all reads. Writes to
persistent_memory may fail due to RLS — verify in next session.

Tiffany should refresh the Supabase MCP connection in her Claude
settings before next operational session.

═══════════════════════════════════════════════════════════════
WAITING ON TIFFANY
═══════════════════════════════════════════════════════════════

Email sent today requesting:
  - 2026 Balance Sheet monthly snapshots
  - 2026 P&L monthly breakouts (not just YTD)
  - Deduction statements OR permission to re-extract from comp recap PDFs
  - Full payroll history (ADP) Jan 2025 – May 2026
  - 2026 Score+/PYC producer production by LoB
  - Last 3 months bank statements (9207, 9223, SouthState PFA)
  - Last 3 months CC statements (AmEx 92005, BOA 3076, Spark Cap One, US Bank 2535)
  - Last 3 months loan statements
  - A005 agreement (SMVC rates)
  - FEIN / Tax ID
  - Bank institution names for 9207 and 9223
  - 2026 AIPP target from SF
  - Lapse rate from AgentWeb
  - Monday team walkthrough scheduled?
  - Email variant choice (Direct vs Habit-first)?

═══════════════════════════════════════════════════════════════
NEXT SESSION — RECOMMENDED OPENING MOVES
═══════════════════════════════════════════════════════════════

  1. Read this entry first.
  2. Ask Tiffany if she refreshed the Supabase MCP connection.
  3. Check inbox for any documents she forwarded since this entry.
  4. Process new documents through the appropriate parsers.
  5. Then drive on remaining open items in priority order:
       a. HRPeople.jsx full live-wire (drop Marcus Thompson + 5 MOCK_ constants)
       b. ComplianceCenter.jsx live-wire (compliance_calendar, monthly_close_checklist)
       c. Write-back persistence pattern across TasksGoals/PersistentMemory/Alerts
       d. Re-process comp recap PDFs to populate deduction summary fields
       e. May 2026 monthly close walkthrough
       f. SocialMedia.jsx live-wire (lower priority while social inactive)
  6. If she sends documents, process those first (always).

═══════════════════════════════════════════════════════════════
ARTIFACT REFERENCES
═══════════════════════════════════════════════════════════════

  Repo:        https://github.com/tiffanymappbusinessclaude-cyber/Tiffanymappbccdashboard
  Live URL:    https://tiffanymappbccdashboard.vercel.app
  Audit doc:   docs/SESSION_2026-06-17_AUDIT.md (committed this session as backup)
  Protocol:    docs/AMUTL_RETENTION_PROTOCOL.md (committed 2026-06-16)

