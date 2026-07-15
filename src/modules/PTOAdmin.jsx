// =============================================================================
// PTOAdmin.jsx — Owner / authorized manager view
// -----------------------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.2 (Premium §4 PTO — Phase 4 mockup fidelity)
//
// Routing: BCCApp.jsx dispatches nav id "pto" to this component when
// currentUserRole is "owner" or "manager". Producer role gets PTOMine.jsx.
//
// Note on manager access: appearing here does not grant approval authority.
// The server-side RPCs (rpc_approve_pto_request, rpc_decline_pto_request)
// enforce is_pto_manager() which requires both a manager role AND the
// enable_pto_manager_access setting (ships default TRUE per considered B.11
// override for the SF office-manager workflow — see 107a for the rule).
// When a manager without the toggle tries to approve, the RPC raises a
// permission_denied exception which surfaces here as an error state.
//
// Tabs:
//   • Pending Queue — outstanding requests awaiting decision
//   • Roster       — all staff PTO balances at a glance
//   • Policies     — create / edit / archive PTO policies (owner-only per RPC)
//
// Display convention (Phase 2, established 2026-07-09; wired v0.5.2 2026-07-10):
//   DB stores days; UI shows hours. Every balance/request display flows
//   through helpers in ../lib/pto/format.js. Policy carryover caps stay in
//   days since owners configure policies thinking "5 days cap".
//
// Phase 4 mockup fidelity (landed v0.5.2 2026-07-10, ref Premium_PTO_Admin_Mockup.html):
//   • Page header with Print + Manage Policies action buttons
//   • Pending queue rows show after-balance preview ("72 hrs → 48 hrs")
//     using formatAfterBalance from format.js
//   • Team calendar week view with PTO chip overlays (approved + pending),
//     coverage-conflict flags when 2+ producers off same day, prev/next
//     week navigation
//   • Recent activity feed — merged pending submissions + recent decisions
//     with color-coded event dots (green approve, red decline, blue submit)
//   • Team balances at-a-glance panel with "View all →" jump to Roster tab
//
// Print behavior: window.print() with print CSS handled by index.css's
// @media print rules (hide sidebar/tabs, keep content). Setup Claude should
// verify Base's index.css exposes .if-no-print utility.
// =============================================================================

import { useState, useMemo, Fragment } from "react";
import { CheckCircle, XCircle, ClipboardList, Users, Settings2, Calendar, Printer, ChevronLeft, ChevronRight, PenSquare } from "lucide-react";

import { supabase } from "../lib/supabase.js";
import { useSupabaseQuery } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";
import { formatDaysAsHours, formatAfterBalance } from "../lib/pto/format.js";

import SectionHeader from "../components/SectionHeader.jsx";
import StatCard from "../components/StatCard.jsx";
import EmptyState from "../components/EmptyState.jsx";
import LoadingState from "../components/LoadingState.jsx";
import AskClaudeButton from "../components/AskClaudeButton.jsx";

import PTOPolicies from "./PTOPolicies.jsx";
import PTOMonthCalendar from "../components/PTOMonthCalendar.jsx";

// -----------------------------------------------------------------------------
// Utility helpers (file-local)
// -----------------------------------------------------------------------------
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function StatusPill({ status }) {
  const cfg = {
    pending:   { cls: "bg-amber-100 text-amber-800",     label: "Pending" },
    approved:  { cls: "bg-emerald-100 text-emerald-800", label: "Approved" },
    denied:    { cls: "bg-red-100 text-red-800",         label: "Denied" },
    cancelled: { cls: "bg-slate-100 text-slate-700",     label: "Cancelled" },
  }[status] || { cls: "bg-slate-100 text-slate-700", label: status };

  return (
    <span className={cn("inline-block rounded px-2 py-0.5 text-xs font-medium", cfg.cls)}>
      {cfg.label}
    </span>
  );
}

// =============================================================================
// Top-level component
// =============================================================================
export default function PTOAdmin() {
  if (!supabase) {
    return (
      <div className="if-card">
        <p className="text-if-muted">
          Supabase client not initialized. Check your VITE_SUPABASE_URL and
          VITE_SUPABASE_ANON_KEY environment variables.
        </p>
      </div>
    );
  }
  return <PTOAdminImpl />;
}

function PTOAdminImpl() {
  const [tab, setTab] = useState("queue"); // 'queue' | 'roster' | 'policies'

  // Phase 4: header actions
  const handlePrint = () => {
    if (typeof window !== "undefined") window.print();
  };
  const goToPolicies = () => setTab("policies");

  return (
    <div className="space-y-6">
      <SectionHeader
        title="PTO Administration"
        description="Review pending requests, view team balances, and manage policies."
      />

      <PageHeader
        onPrint={handlePrint}
        onManagePolicies={goToPolicies}
        activeTabId={tab}
      />
      <TabBar tab={tab} onChange={setTab} />

      {tab === "queue"    && <QueueTab />}
      {tab === "roster"   && <RosterTab />}
      {tab === "policies" && <PTOPolicies />}
    </div>
  );
}

// =============================================================================
// Page header — title, subtitle, Print + Manage Policies actions
// -----------------------------------------------------------------------------
// Matches Premium_PTO_Admin_Mockup.html top block. The .if-no-print class on
// the action buttons hides them in print output; the h1/subtitle print for
// document context. Setup Claude should confirm Base's index.css exposes
// .if-no-print — it is used elsewhere in Base too (search: "if-no-print").
// =============================================================================
function PageHeader({ onPrint, onManagePolicies, activeTabId }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-2 text-xs text-if-muted uppercase tracking-wide">
          <span>Premium overlay</span>
          <span>·</span>
          <span>PTO tracking</span>
        </div>
        <h1 className="text-if-navy text-2xl font-bold mt-1">PTO Admin</h1>
        <p className="text-sm text-if-muted mt-1">
          Approve requests, review balances, and see who&apos;s out when.
        </p>
      </div>
      <div className="flex items-center gap-2 if-no-print">
        <button
          type="button"
          className="if-button-ghost"
          onClick={onPrint}
        >
          <Printer size={14} className="inline mr-1" /> Print
        </button>
        <button
          type="button"
          className={cn(
            "if-button",
            activeTabId === "policies" && "opacity-60 pointer-events-none"
          )}
          onClick={onManagePolicies}
          disabled={activeTabId === "policies"}
          title={activeTabId === "policies" ? "Already on Policies" : "Jump to policy editor"}
        >
          <PenSquare size={14} className="inline mr-1" /> Manage Policies
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Tab bar
// =============================================================================
function TabBar({ tab, onChange }) {
  const tabs = [
    { id: "queue",    label: "Pending Queue", icon: ClipboardList },
    { id: "roster",   label: "Roster",        icon: Users },
    { id: "policies", label: "Policies",      icon: Settings2 },
  ];
  return (
    <div className="flex items-center gap-1 border-b border-if-line">
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={cn(
            "flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
            tab === id
              ? "border-if-navy text-if-navy"
              : "border-transparent text-if-muted hover:text-if-navy"
          )}
        >
          <Icon size={14} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

// =============================================================================
// QUEUE TAB — pending requests, week calendar, activity feed, team balances
// -----------------------------------------------------------------------------
// v0.5.2 Phase 4: restructured to match Premium_PTO_Admin_Mockup.html.
//
// Layout:
//   1. Stat strip (4 cards)
//        Pending Requests | Approved This Month | Team Out Today | Coverage Flags
//   2. Ask Claude preloads (3 chip prompts matching Base PlaybookGuide seeds)
//   3. Pending requests (rows show after-balance preview via formatAfterBalance)
//   4. Team calendar week view with PTO chip overlays + prev/next navigation
//   5. Two-column split: Recent activity feed  |  Team balances at-a-glance
//   6. Recent decisions table (existing pattern, kept for detailed review)
//
// Data fetches (5 queries):
//   • pendingQuery   — status='pending'
//   • recentQuery    — status IN ('approved','denied'), last 20 for decision detail
//   • rosterQuery    — v_pto_admin_roster (balance lookup for after-preview + panel)
//   • approvedWindow — approved requests intersecting a 60-day window centered on
//                       today (fuels Approved-This-Month, Team-Out-Today, Coverage
//                       Flags, and the calendar overlay)
// =============================================================================
function QueueTab() {
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);

  const [weekOffset, setWeekOffset] = useState(0);
  const [calendarView, setCalendarView] = useState("week"); // "week" | "month"

  // Window helpers — 30 days back through 60 days forward for stats + calendar
  const winStart = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return isoDate(d);
  }, []);
  const winEnd = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 60);
    return isoDate(d);
  }, []);

  const pendingQuery = useSupabaseQuery(
    () => supabase
      .from("v_pto_my_requests")
      .select("*")
      .eq("status", "pending")
      .order("start_date", { ascending: true }),
    [refreshKey]
  );

  const recentQuery = useSupabaseQuery(
    () => supabase
      .from("v_pto_my_requests")
      .select("*")
      .in("status", ["approved", "denied"])
      .order("approved_at", { ascending: false, nullsFirst: false })
      .limit(20),
    [refreshKey]
  );

  const rosterQuery = useSupabaseQuery(
    () => supabase
      .from("v_pto_admin_roster")
      .select("staff_id, staff_name, balance_days, used_this_period, policy_id, staff_status")
      .eq("staff_status", "active"),
    [refreshKey]
  );

  // Approved requests intersecting the 90-day window (30 back + 60 fwd).
  // "Intersects" = end_date >= winStart AND start_date <= winEnd.
  const approvedWindowQuery = useSupabaseQuery(
    () => supabase
      .from("v_pto_my_requests")
      .select("*")
      .eq("status", "approved")
      .gte("end_date", winStart)
      .lte("start_date", winEnd)
      .order("start_date", { ascending: true }),
    [refreshKey]
  );

  const pending  = pendingQuery.data       || [];
  const recent   = recentQuery.data        || [];
  const roster   = rosterQuery.data        || [];
  const approved = approvedWindowQuery.data|| [];

  // Build balance lookup map used both by PendingList after-preview and by
  // Team balances panel.
  const balancesByStaff = useMemo(() => {
    const m = new Map();
    for (const r of roster) {
      m.set(r.staff_id, {
        balance_days:    Number(r.balance_days || 0),
        used_this_period:Number(r.used_this_period || 0),
        staff_name:      r.staff_name,
      });
    }
    return m;
  }, [roster]);

  // Stat computations ---------------------------------------------------------
  const now = new Date();
  const stalePending = pending.filter((r) => {
    if (!r.created_at) return false;
    const hrs = (Date.now() - new Date(r.created_at).getTime()) / 3600000;
    return hrs >= 24;
  }).length;

  const approvedThisMonth = approved.filter((r) => {
    const d = new Date((r.approved_at || r.updated_at || r.created_at) + "");
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  const approvedMonthHours = approvedThisMonth.reduce(
    (s, r) => s + Number(r.total_days || 0), 0
  ) * 8;

  const todayIso = isoDate(now);
  const outToday = approved.filter((r) =>
    r.start_date <= todayIso && r.end_date >= todayIso
  );
  const outTodayLabel = outToday.length === 1
    ? `${firstName(outToday[0].staff_name)} · returns ${
        dayLabelShort(addDays(new Date(outToday[0].end_date + "T00:00:00"), 1))
      }`
    : outToday.length > 1
      ? `${outToday.length} team members off`
      : "Everyone in";

  // Coverage flags: dates within next 30 days where >=2 approved requests overlap
  const coverageFlags = useMemo(() => computeCoverageFlags(approved, 30), [approved]);

  const firstFlag = coverageFlags[0];
  const coverageSub = firstFlag
    ? `${dayLabelShort(new Date(firstFlag.date + "T00:00:00"))} · ${firstFlag.count} producers off`
    : "None in next 30 days";

  return (
    <div className="space-y-6">
      {/* --- Stat strip (4 cards) --------------------------------------- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Pending Requests"
          value={pending.length}
          sublabel={pending.length > 0
            ? `${stalePending} waiting >24h`
            : "queue is clear"}
          tone={pending.length > 0 ? "warning" : "positive"}
          loading={pendingQuery.loading}
        />
        <StatCard
          label="Approved This Month"
          value={approvedThisMonth.length}
          sublabel={`${Math.round(approvedMonthHours)} hours total`}
          loading={approvedWindowQuery.loading}
        />
        <StatCard
          label="Team Out Today"
          value={outToday.length}
          sublabel={outTodayLabel}
          loading={approvedWindowQuery.loading}
        />
        <StatCard
          label="Coverage Flags"
          value={coverageFlags.length}
          sublabel={coverageSub}
          tone={coverageFlags.length > 0 ? "warning" : "positive"}
          loading={approvedWindowQuery.loading}
        />
      </div>

      {/* --- Ask Claude preloads (3 chip prompts) ----------------------- */}
      <div className="if-no-print">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-if-muted uppercase font-medium tracking-wide">
            Ask Claude:
          </span>
          <AskClaudeChip
            suggestedPrompt="Look at my team's current PTO balances. Who's got the most banked hours, and how does that compare to what they'd typically use in a year? Flag anyone approaching a carryover cap."
            label="Who has the highest pending balance?"
          />
          <AskClaudeChip
            suggestedPrompt="Look at pending and approved PTO requests for the next 30 days. Are there any days where too many people are off, or gaps where a specific role isn't covered? Give me a heads-up before I approve anything else."
            label="Any coverage conflicts in next 30 days?"
          />
          <AskClaudeChip
            suggestedPrompt="Put together a PTO summary for last quarter. Hours used per person, most common types (vacation, sick, personal), balance changes, and anything unusual. Format it so I could hand it to my CPA or use it in a team review."
            label="Generate a PTO summary for last quarter"
          />
        </div>
      </div>

      {/* --- Pending requests section ---------------------------------- */}
      <section>
        <SectionHeader
          title="Pending requests"
          description={pending.length === 1
            ? "1 request waiting on your call. Approve, decline, or ask a follow-up."
            : `${pending.length} requests waiting on your call. Approve, decline, or ask a follow-up.`}
          actions={
            pending.length > 0 && (
              <AskClaudeButton
                moduleLabel="PTO Admin — Pending Queue"
                subject="pending PTO requests"
                context={{ pending, balances: [...balancesByStaff.values()] }}
                suggestedPrompt="Review this pending PTO queue and flag anything that looks unusual (patterns, back-to-back with holidays, staffing coverage risks)."
              />
            )
          }
        />
        <PendingList
          requests={pending}
          loading={pendingQuery.loading}
          error={pendingQuery.error}
          balancesByStaff={balancesByStaff}
          onDecided={bump}
        />
      </section>

      {/* --- Team calendar (week or month view) ------------------------ */}
      <section>
        <SectionHeader
          title="Team calendar"
          description={calendarView === "week"
            ? "Approved PTO overlaid on the week view. Watch for coverage gaps."
            : "Approved + pending PTO on a monthly grid. Coverage conflicts highlighted."}
          actions={
            <div className="inline-flex rounded border border-if-line overflow-hidden text-xs">
              <button
                type="button"
                onClick={() => setCalendarView("week")}
                className={cn(
                  "px-3 py-1 font-medium",
                  calendarView === "week"
                    ? "bg-if-navy text-white"
                    : "bg-white text-if-navy hover:bg-if-cream"
                )}
              >
                Week
              </button>
              <button
                type="button"
                onClick={() => setCalendarView("month")}
                className={cn(
                  "px-3 py-1 font-medium border-l border-if-line",
                  calendarView === "month"
                    ? "bg-if-navy text-white"
                    : "bg-white text-if-navy hover:bg-if-cream"
                )}
              >
                Month
              </button>
            </div>
          }
        />
        {calendarView === "week" ? (
          <TeamCalendarWeek
            weekOffset={weekOffset}
            onPrev={() => setWeekOffset((w) => w - 1)}
            onNext={() => setWeekOffset((w) => w + 1)}
            onToday={() => setWeekOffset(0)}
            approved={approved}
            pending={pending}
            loading={approvedWindowQuery.loading}
          />
        ) : (
          <PTOMonthCalendar
            requests={[...approved, ...pending]}
            showCoverageFlags={true}
          />
        )}
      </section>

      {/* --- Recent activity + Team balances split --------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RecentActivityPanel
          pending={pending}
          recent={recent}
          loading={pendingQuery.loading || recentQuery.loading}
        />
        <TeamBalancesPanel
          roster={roster}
          loading={rosterQuery.loading}
          error={rosterQuery.error}
        />
      </div>

      {/* --- Recent decisions (kept for detailed review) --------------- */}
      <section>
        <SectionHeader
          title="Recent decisions"
          description="Last 20 approved or denied requests — full detail."
        />
        <RecentDecisions
          requests={recent}
          loading={recentQuery.loading}
          error={recentQuery.error}
        />
      </section>
    </div>
  );
}

// =============================================================================
// Small file-local helpers (dates, coverage math, chip variant)
// =============================================================================
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d, n) {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}
function firstName(fullName) {
  if (!fullName) return "";
  return String(fullName).split(/\s+/)[0];
}
function initials(fullName) {
  if (!fullName) return "??";
  const parts = String(fullName).trim().split(/\s+/);
  const a = (parts[0] || "?")[0] || "?";
  const b = (parts[parts.length - 1] || "")[0] || "";
  return (a + b).toUpperCase();
}
function dayLabelShort(d) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
// Week start (Monday) offset by n weeks
function weekStartMonday(offset = 0) {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow + offset * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}
// Iterate dates within a request's [start, end] range (inclusive)
function iterRequestDates(r, fn) {
  const s = new Date(r.start_date + "T00:00:00");
  const e = new Date(r.end_date + "T00:00:00");
  for (let d = new Date(s); d.getTime() <= e.getTime(); d = addDays(d, 1)) {
    fn(isoDate(d));
  }
}
// Coverage flags = dates in the next `days` days where >=2 approved requests
// intersect the same calendar day. Returns [{date, count, names[]}, ...].
function computeCoverageFlags(approvedRequests, days) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const horizon = addDays(today, days);
  const byDate = new Map();
  for (const r of approvedRequests) {
    iterRequestDates(r, (iso) => {
      const d = new Date(iso + "T00:00:00");
      if (d < today || d > horizon) return;
      if (!byDate.has(iso)) byDate.set(iso, []);
      byDate.get(iso).push(r.staff_name);
    });
  }
  const flags = [];
  for (const [date, names] of byDate.entries()) {
    if (names.length >= 2) flags.push({ date, count: names.length, names });
  }
  flags.sort((a, b) => a.date.localeCompare(b.date));
  return flags;
}
// Requests active on a given ISO date
function requestsOnDate(iso, requests) {
  return requests.filter((r) => r.start_date <= iso && r.end_date >= iso);
}

// AskClaudeChip — pill-styled preload prompt for the QueueTab top strip.
// Copies the exact PlaybookGuide-authored prompt text to the clipboard so
// the owner can paste directly into their claude.ai tab. Does NOT wrap
// AskClaudeButton because that component's `label` / `variant` props are
// not part of its documented API in Base — this stays independent to
// avoid coupling to a Base-side rendering detail. Copy behavior mirrors
// the shared component's clipboard write pattern.
function AskClaudeChip({ suggestedPrompt, label }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(suggestedPrompt);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      /* clipboard blocked — soft-fail, user can still read/copy manually */
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="text-xs px-3 py-1.5 rounded-full border transition-colors"
      style={{
        borderColor: "var(--if-line)",
        backgroundColor: copied ? "var(--if-success-lt)" : "var(--if-blue-lt)",
        color: copied ? "var(--if-success)" : "var(--if-blue)",
      }}
      title="Copies the prompt to your clipboard — paste into your claude.ai session"
    >
      {copied ? "✓ Copied — paste in Claude" : label}
    </button>
  );
}

function PendingList({ requests, loading, error, onDecided, balancesByStaff }) {
  const [processingId, setProcessingId] = useState(null);
  const [errorId, setErrorId] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [declineFor, setDeclineFor] = useState(null); // request id being declined
  const [declineReason, setDeclineReason] = useState("");

  async function handleApprove(id) {
    setProcessingId(id);
    setErrorId(null);
    setErrorMsg(null);
    try {
      const { error: rpcErr } = await supabase.rpc("rpc_approve_pto_request", {
        p_request_id: id,
      });
      if (rpcErr) throw rpcErr;
      onDecided?.();
    } catch (err) {
      setErrorId(id);
      setErrorMsg(err?.message || "Failed to approve.");
    } finally {
      setProcessingId(null);
    }
  }

  async function handleDeclineSubmit() {
    const id = declineFor;
    if (!id || !declineReason.trim()) return;
    setProcessingId(id);
    setErrorId(null);
    setErrorMsg(null);
    try {
      const { error: rpcErr } = await supabase.rpc("rpc_decline_pto_request", {
        p_request_id: id,
        p_reason:     declineReason.trim(),
      });
      if (rpcErr) throw rpcErr;
      setDeclineFor(null);
      setDeclineReason("");
      onDecided?.();
    } catch (err) {
      setErrorId(id);
      setErrorMsg(err?.message || "Failed to decline.");
    } finally {
      setProcessingId(null);
    }
  }

  if (loading) return <LoadingState message="Loading pending requests…" rows={4} />;
  if (error) {
    return (
      <div className="if-card border-red-200 bg-red-50/40">
        <p className="text-sm text-red-800">Could not load: {error}</p>
      </div>
    );
  }
  if (requests.length === 0) {
    return (
      <EmptyState
        icon="✅"
        title="No pending requests"
        description="You're all caught up. New requests will appear here automatically."
      />
    );
  }

  return (
    <div className="if-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-if-muted">
          <tr className="border-b border-if-line">
            <th className="text-left py-2 pr-3">Staff</th>
            <th className="text-left py-2 pr-3">Type</th>
            <th className="text-left py-2 pr-3">Dates</th>
            <th className="text-left py-2 pr-3">Hours</th>
            <th className="text-left py-2 pr-3">Balance / After</th>
            <th className="text-left py-2 pr-3">Reason</th>
            <th className="text-right py-2 pl-3">Decision</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <Fragment key={r.id}>
              <tr className="border-b border-if-line/60 last:border-b-0 align-top">
                <td className="py-2 pr-3 font-medium text-if-navy">{r.staff_name || "—"}</td>
                <td className="py-2 pr-3 capitalize">{r.request_type}</td>
                <td className="py-2 pr-3">
                  {r.is_half_day
                    ? `${fmtDate(r.start_date)} (${(r.half_day_period || "").toUpperCase()})`
                    : r.start_date === r.end_date
                      ? fmtDate(r.start_date)
                      : `${fmtDate(r.start_date)} → ${fmtDate(r.end_date)}`}
                </td>
                <td className="py-2 pr-3">{formatDaysAsHours(r.total_days)}</td>
                <td className="py-2 pr-3 text-xs">
                  <BalanceAfterCell
                    staffId={r.staff_id}
                    totalDays={r.total_days}
                    balancesByStaff={balancesByStaff}
                  />
                </td>
                <td className="py-2 pr-3 max-w-[240px]">
                  <div className="truncate text-if-muted" title={r.reason || ""}>
                    {r.reason || "—"}
                  </div>
                </td>
                <td className="py-2 pl-3 text-right whitespace-nowrap">
                  <button
                    type="button"
                    className="if-button text-xs mr-1"
                    disabled={processingId === r.id}
                    onClick={() => handleApprove(r.id)}
                  >
                    <CheckCircle size={12} />
                    {processingId === r.id ? "…" : "Approve"}
                  </button>
                  <button
                    type="button"
                    className="if-button-ghost text-xs"
                    disabled={processingId === r.id}
                    onClick={() => { setDeclineFor(r.id); setDeclineReason(""); }}
                  >
                    <XCircle size={12} /> Decline
                  </button>
                </td>
              </tr>

              {errorId === r.id && errorMsg && (
                <tr>
                  <td colSpan={7} className="pb-2">
                    <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
                      {errorMsg}
                    </div>
                  </td>
                </tr>
              )}

              {declineFor === r.id && (
                <tr>
                  <td colSpan={7} className="pb-3">
                    <div className="bg-amber-50 border border-amber-200 rounded p-3 space-y-2">
                      <label className="block">
                        <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
                          Decline reason (required)
                        </span>
                        <textarea
                          className="if-input"
                          rows={2}
                          value={declineReason}
                          onChange={(e) => setDeclineReason(e.target.value)}
                          placeholder="Coverage conflict, insufficient balance, blackout period, etc."
                          autoFocus
                        />
                      </label>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          className="if-button-ghost text-xs"
                          onClick={() => { setDeclineFor(null); setDeclineReason(""); }}
                          disabled={processingId === r.id}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="if-button text-xs"
                          onClick={handleDeclineSubmit}
                          disabled={processingId === r.id || !declineReason.trim()}
                        >
                          <XCircle size={12} />
                          {processingId === r.id ? "Declining…" : "Confirm decline"}
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecentDecisions({ requests, loading, error }) {
  if (loading) return <LoadingState message="Loading recent decisions…" rows={3} />;
  if (error) {
    return (
      <div className="if-card border-red-200 bg-red-50/40">
        <p className="text-sm text-red-800">Could not load: {error}</p>
      </div>
    );
  }
  if (requests.length === 0) {
    return (
      <EmptyState
        icon="📋"
        title="No recent decisions"
        description="Approved and declined requests will show up here."
      />
    );
  }

  return (
    <div className="if-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-if-muted">
          <tr className="border-b border-if-line">
            <th className="text-left py-2 pr-3">Staff</th>
            <th className="text-left py-2 pr-3">Type</th>
            <th className="text-left py-2 pr-3">Dates</th>
            <th className="text-left py-2 pr-3">Hours</th>
            <th className="text-left py-2 pr-3">Status</th>
            <th className="text-left py-2 pr-3">Decided</th>
            <th className="text-left py-2 pr-3">Note</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id} className="border-b border-if-line/60 last:border-b-0">
              <td className="py-2 pr-3 font-medium text-if-navy">{r.staff_name || "—"}</td>
              <td className="py-2 pr-3 capitalize">{r.request_type}</td>
              <td className="py-2 pr-3">
                {r.start_date === r.end_date
                  ? fmtDate(r.start_date)
                  : `${fmtDate(r.start_date)} → ${fmtDate(r.end_date)}`}
              </td>
              <td className="py-2 pr-3">{formatDaysAsHours(r.total_days)}</td>
              <td className="py-2 pr-3"><StatusPill status={r.status} /></td>
              <td className="py-2 pr-3 text-if-muted text-xs">
                {r.approved_at ? new Date(r.approved_at).toLocaleDateString() : "—"}
              </td>
              <td className="py-2 pr-3 max-w-[240px]">
                <div className="truncate text-if-muted text-xs" title={r.decline_reason || r.reason || ""}>
                  {r.status === "denied" && r.decline_reason
                    ? <span className="text-red-700">{r.decline_reason}</span>
                    : (r.reason || "—")}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// =============================================================================
// ROSTER TAB — all staff current balance snapshot
// =============================================================================
function RosterTab() {
  const rosterQuery = useSupabaseQuery(
    () => supabase
      .from("v_pto_admin_roster")
      .select("*")
      .order("staff_name", { ascending: true }),
    []
  );

  const roster = rosterQuery.data || [];
  const activeRoster = roster.filter((r) => r.staff_status === "active");

  const totalBalance = activeRoster.reduce((s, r) => s + Number(r.balance_days || 0), 0);
  const totalPending = activeRoster.reduce((s, r) => s + Number(r.pending_request_count || 0), 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label="Active staff on PTO plans"
          value={activeRoster.filter((r) => r.policy_id).length}
          loading={rosterQuery.loading}
        />
        <StatCard
          label="Total available balance"
          value={formatDaysAsHours(totalBalance, { showUnit: false })}
          sublabel="hours across team"
          loading={rosterQuery.loading}
        />
        <StatCard
          label="Total pending requests"
          value={totalPending}
          tone={totalPending > 0 ? "warning" : "neutral"}
          loading={rosterQuery.loading}
        />
      </div>

      <section>
        <SectionHeader
          title="Team roster"
          description="Current-period balances for every active staff member."
          actions={
            <AskClaudeButton
              moduleLabel="PTO Admin — Roster"
              subject="team PTO balances"
              context={{ roster: activeRoster }}
              suggestedPrompt="Review this team PTO snapshot and flag anyone who looks over-accumulated, under-utilizing, or approaching a carryover cap."
            />
          }
        />
        <RosterTable roster={activeRoster} loading={rosterQuery.loading} error={rosterQuery.error} />
      </section>
    </div>
  );
}

function RosterTable({ roster, loading, error }) {
  if (loading) return <LoadingState message="Loading team roster…" rows={5} />;
  if (error) {
    return (
      <div className="if-card border-red-200 bg-red-50/40">
        <p className="text-sm text-red-800">Could not load roster: {error}</p>
      </div>
    );
  }
  if (roster.length === 0) {
    return (
      <EmptyState
        icon="👥"
        title="No active staff"
        description="Once your staff records are set to active and assigned PTO policies, they'll appear here."
      />
    );
  }

  return (
    <div className="if-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-if-muted">
          <tr className="border-b border-if-line">
            <th className="text-left py-2 pr-3">Staff</th>
            <th className="text-left py-2 pr-3">Policy</th>
            <th className="text-left py-2 pr-3">Balance</th>
            <th className="text-left py-2 pr-3">Accrued</th>
            <th className="text-left py-2 pr-3">Used</th>
            <th className="text-left py-2 pr-3">Period</th>
            <th className="text-left py-2 pr-3">Pending</th>
          </tr>
        </thead>
        <tbody>
          {roster.map((r) => (
            <tr key={r.staff_id} className="border-b border-if-line/60 last:border-b-0">
              <td className="py-2 pr-3 font-medium text-if-navy">{r.staff_name}</td>
              <td className="py-2 pr-3">
                {r.policy_name || <span className="text-if-muted italic">unassigned</span>}
              </td>
              <td className="py-2 pr-3 font-medium">{formatDaysAsHours(r.balance_days)}</td>
              <td className="py-2 pr-3">{formatDaysAsHours(r.accrued_this_period)}</td>
              <td className="py-2 pr-3">{formatDaysAsHours(r.used_this_period)}</td>
              <td className="py-2 pr-3 text-if-muted text-xs">
                {r.period_start && r.period_end
                  ? `${fmtDate(r.period_start)} → ${fmtDate(r.period_end)}`
                  : "—"}
              </td>
              <td className="py-2 pr-3">
                {r.pending_request_count > 0 ? (
                  <span className="inline-block rounded bg-amber-100 text-amber-800 px-2 py-0.5 text-xs font-medium">
                    {r.pending_request_count}
                  </span>
                ) : (
                  <span className="text-if-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// =============================================================================
// BalanceAfterCell — pending queue row cell showing "Balance: 72 hrs / After: 48"
// -----------------------------------------------------------------------------
// Uses formatDaysAsHours + formatAfterBalance from ../lib/pto/format.js.
// If the staff's roster row isn't loaded yet (rosterQuery still loading, or
// requester isn't in active roster), we render an em-dash.
// =============================================================================
function BalanceAfterCell({ staffId, totalDays, balancesByStaff }) {
  if (!balancesByStaff || !staffId) return <span className="text-if-muted">—</span>;
  const entry = balancesByStaff.get(staffId);
  if (!entry) return <span className="text-if-muted">—</span>;
  return (
    <div className="text-xs whitespace-nowrap">
      <div>
        <span className="text-if-muted">Balance: </span>
        <span className="text-if-ink font-medium">{formatDaysAsHours(entry.balance_days)}</span>
      </div>
      <div className="mt-0.5">
        <span className="text-if-muted">After: </span>
        <span className="text-if-ink">{formatAfterBalance(entry.balance_days, totalDays)}</span>
      </div>
    </div>
  );
}

// =============================================================================
// TeamCalendarWeek — 7-day grid with PTO chip overlays + prev/next navigation
// -----------------------------------------------------------------------------
// Renders Mon..Sun for the current week (weekOffset = 0) or offset weeks.
// Each day cell shows the day number and overlays chips:
//   • Approved singles:    <name> (out)          in blue
//   • Approved multiples:  ⚠ N producers          in red (coverage flag)
//   • Pending overlays:    <name> (pending)      in blue (dashed)
// Today's cell gets a subtle accent border.
// =============================================================================
function TeamCalendarWeek({ weekOffset, onPrev, onNext, onToday, approved, pending, loading }) {
  const weekStart = useMemo(() => weekStartMonday(weekOffset), [weekOffset]);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );
  const todayStr = isoDate(new Date());
  const monthLabel = weekStart.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const dayName = (d, i) =>
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm text-if-muted">
          Week of {weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {monthLabel}
        </div>
        <div className="flex items-center gap-2 if-no-print">
          <button type="button" className="if-button-ghost text-xs" onClick={onPrev}>
            <ChevronLeft size={14} className="inline mr-0.5" /> Prev week
          </button>
          {weekOffset !== 0 && (
            <button type="button" className="if-button-ghost text-xs" onClick={onToday}>
              Today
            </button>
          )}
          <button type="button" className="if-button-ghost text-xs" onClick={onNext}>
            Next week <ChevronRight size={14} className="inline ml-0.5" />
          </button>
        </div>
      </div>

      <div className="if-card p-0 overflow-hidden">
        {/* Weekday header row */}
        <div className="grid grid-cols-7 border-b border-if-line">
          {days.map((d, i) => (
            <div
              key={`hdr-${i}`}
              className={cn(
                "text-center text-xs font-medium text-if-muted uppercase p-2",
                i >= 5 && "bg-if-cream/40"
              )}
            >
              {dayName(d, i)}
            </div>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7 min-h-[120px]">
          {days.map((d, i) => {
            const iso = isoDate(d);
            const isToday = iso === todayStr;
            const isWeekend = i >= 5;
            const approvedHere = requestsOnDate(iso, approved);
            const pendingHere = requestsOnDate(iso, pending);

            return (
              <div
                key={`cell-${iso}`}
                className={cn(
                  "border-r border-if-line/60 last:border-r-0 p-2 space-y-1",
                  isWeekend && "bg-if-cream/40",
                  isToday && "bg-if-blue-lt/40 border-t-2 border-t-if-blue"
                )}
              >
                <div className={cn(
                  "text-sm font-semibold",
                  isToday ? "text-if-blue" : (isWeekend ? "text-if-muted" : "text-if-ink")
                )}>
                  {d.getDate()}
                </div>

                {/* Approved chips — combine to "⚠ N producers" when >=2 */}
                {approvedHere.length >= 2 && (
                  <div
                    className="text-[10px] leading-tight px-1.5 py-0.5 rounded font-medium"
                    style={{ backgroundColor: "var(--if-danger-lt)", color: "#991B1B" }}
                    title={approvedHere.map((r) => r.staff_name).join(", ")}
                  >
                    ⚠ {approvedHere.length} producers
                  </div>
                )}
                {approvedHere.length === 1 && (
                  <div
                    className="text-[10px] leading-tight px-1.5 py-0.5 rounded font-medium truncate"
                    style={{ backgroundColor: "var(--if-blue-lt)", color: "var(--if-blue)" }}
                    title={`${approvedHere[0].staff_name} — approved PTO`}
                  >
                    {firstName(approvedHere[0].staff_name)} (out)
                  </div>
                )}

                {/* Pending chips (dashed style to differentiate) */}
                {pendingHere.map((r) => (
                  <div
                    key={`p-${r.id}`}
                    className="text-[10px] leading-tight px-1.5 py-0.5 rounded font-medium border border-dashed truncate"
                    style={{
                      backgroundColor: "transparent",
                      color: "var(--if-blue)",
                      borderColor: "var(--if-blue)",
                    }}
                    title={`${r.staff_name} — pending`}
                  >
                    {firstName(r.staff_name)} (pending)
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {loading && (
        <div className="text-xs text-if-muted">Loading approved PTO for this window…</div>
      )}
    </div>
  );
}

// =============================================================================
// RecentActivityPanel — merged timeline of submissions + decisions
// -----------------------------------------------------------------------------
// Merges recent pending submissions (from pendingQuery, sorted by created_at)
// and recent decisions (from recentQuery, sorted by approved_at) into a single
// chronological feed with color-coded dots:
//   • green — approved
//   • red   — denied
//   • blue  — submitted (still pending)
//
// Accrual events (mockup shows "Accrual ran +6.15 hrs to Marcus C") are NOT
// surfaced here in v0.5.2 — that would require per-person accrual event rows
// (current accrual RPC only writes aggregate to automation_run_log). Adding
// per-staff accrual logging is queued for v0.5.3+.
// =============================================================================
function RecentActivityPanel({ pending, recent, loading }) {
  const events = useMemo(() => {
    const rows = [];
    for (const r of pending) {
      if (r.created_at) {
        rows.push({
          key: `sub-${r.id}`,
          when: new Date(r.created_at),
          kind: "submit",
          text: `${firstName(r.staff_name)} submitted`,
          detail: `${describeDates(r)} · ${formatDaysAsHours(r.total_days)} · ${r.request_type}`,
        });
      }
    }
    for (const r of recent) {
      const when = new Date(r.approved_at || r.updated_at || r.created_at);
      if (r.status === "approved") {
        rows.push({
          key: `app-${r.id}`,
          when,
          kind: "approve",
          text: `You approved`,
          detail: `${firstName(r.staff_name)} · ${describeDates(r)} · ${formatDaysAsHours(r.total_days)} ${r.request_type}`,
        });
      } else if (r.status === "denied") {
        rows.push({
          key: `dec-${r.id}`,
          when,
          kind: "decline",
          text: `You declined`,
          detail: `${firstName(r.staff_name)} · ${describeDates(r)}${r.decline_reason ? ` — ${r.decline_reason}` : ""}`,
        });
      }
    }
    rows.sort((a, b) => b.when.getTime() - a.when.getTime());
    return rows.slice(0, 6);
  }, [pending, recent]);

  return (
    <div className="if-card">
      <div className="mb-3">
        <h3 className="text-if-navy text-base font-semibold">Recent activity</h3>
        <p className="text-xs text-if-muted mt-0.5">
          The last few PTO events across your team.
        </p>
      </div>
      {loading ? (
        <LoadingState message="Loading activity…" rows={3} />
      ) : events.length === 0 ? (
        <div className="text-sm text-if-muted py-4">
          No PTO activity yet. Once your team starts submitting requests, it'll show here.
        </div>
      ) : (
        <div className="space-y-3">
          {events.map((e) => (
            <div key={e.key} className="flex items-start gap-3 text-sm">
              <span
                className="rounded-full mt-1.5 flex-shrink-0"
                style={{
                  width: 6, height: 6,
                  backgroundColor:
                    e.kind === "approve" ? "var(--if-success)"
                    : e.kind === "decline" ? "var(--if-danger)"
                    : "var(--if-blue)",
                }}
              />
              <div className="flex-1 min-w-0">
                <div className="text-if-ink">
                  <span className="font-medium">{e.text}</span>{" "}
                  <span className="text-if-muted">{e.detail}</span>
                </div>
                <div className="text-xs text-if-muted mt-0.5">{relativeTime(e.when)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// TeamBalancesPanel — at-a-glance top-5 balances with "View all →" to Roster
// -----------------------------------------------------------------------------
// Complements the full RosterTab (which lives on the Roster tab). This panel
// gives the owner an at-a-glance signal from the Queue tab without needing to
// switch tabs. Warning color when balance is below 8 hrs (1 day).
// =============================================================================
function TeamBalancesPanel({ roster, loading, error }) {
  const rows = useMemo(() => {
    const sorted = [...roster].sort(
      (a, b) => Number(b.balance_days || 0) - Number(a.balance_days || 0)
    );
    return sorted.slice(0, 5);
  }, [roster]);
  const lowBalance = rows.find((r) => Number(r.balance_days || 0) < 1); // <1 day = <8 hrs

  return (
    <div className="if-card">
      <div className="flex items-end justify-between mb-3">
        <div>
          <h3 className="text-if-navy text-base font-semibold">Team balances</h3>
          <p className="text-xs text-if-muted mt-0.5">Top 5 by current balance.</p>
        </div>
        {/* Link-only: the Roster tab is one click away in the tab bar */}
        <span className="text-xs text-if-muted">See Roster tab for all →</span>
      </div>
      {loading ? (
        <LoadingState message="Loading balances…" rows={3} />
      ) : error ? (
        <div className="text-sm text-red-700">Couldn't load balances.</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-if-muted py-2">
          No active staff on a PTO plan yet.
        </div>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-if-line text-xs uppercase tracking-wide text-if-muted">
                <th className="text-left pb-2">Producer</th>
                <th className="text-right pb-2">Balance</th>
                <th className="text-right pb-2">Used YTD</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isLow = Number(r.balance_days || 0) < 1;
                return (
                  <tr key={r.staff_id} className="border-b border-if-line/60 last:border-b-0">
                    <td className="py-2 text-if-ink">{r.staff_name}</td>
                    <td className={cn(
                      "py-2 text-right font-semibold",
                      isLow ? "text-amber-700" : "text-if-ink"
                    )}>
                      {formatDaysAsHours(r.balance_days, { showUnit: false })}
                    </td>
                    <td className="py-2 text-right text-if-muted">
                      {formatDaysAsHours(r.used_this_period, { showUnit: false })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {lowBalance && (
            <div className="mt-3 pt-3 text-xs text-if-muted border-t border-if-line">
              {firstName(lowBalance.staff_name)}&apos;s balance is low — the next accrual cycle refills it per policy.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Local helpers for RecentActivityPanel
// -----------------------------------------------------------------------------
function describeDates(r) {
  if (!r) return "";
  if (r.is_half_day) return `${fmtDate(r.start_date)} (${(r.half_day_period || "").toUpperCase()})`;
  if (r.start_date === r.end_date) return fmtDate(r.start_date);
  return `${fmtDate(r.start_date)} → ${fmtDate(r.end_date)}`;
}
function relativeTime(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
