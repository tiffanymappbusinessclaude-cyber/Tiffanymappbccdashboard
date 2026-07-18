// =============================================================================
// SalesActivity.jsx — Producer activity logging + team coaching surface
// -----------------------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.5 UI (Premium §4.2 Module 02)
//
// HIGH-STAKES COMPLIANCE MODULE — READ MIGRATION 102 HEADER §1-§2 BEFORE
// EDITING THIS FILE. Customer PII must never land in this module. The
// database schema itself prohibits customer identifiers; this UI adds
// layered client-side defenses (persistent banner, in-form callout,
// regex lint on the two free-text fields) as belt-and-suspenders.
//
// Routing: BCCApp.jsx dispatches nav id "activity" to this component for
// owner, manager, and staff roles. Rendering forks on role:
//   • Producer (any non-owner/non-manager): sees only their own entries,
//     personal 30d tiles, 8-week trend, own monthly LOB mix.
//   • Owner / Office Manager (with enable_sales_activity_manager_access,
//     which DEFAULTS TRUE per migration 102 — documented B.11 deviation):
//     sees producer leaderboard, office totals, team-wide LOB mix, and
//     the "who needs a nudge" tile (25%+ activity drop vs last month).
//
// Producer Isolation Principle B.11 (from migration 102 §2):
//   • Read (own rows): every producer sees their own entries via RLS
//     policy sales_activity_producer_own.
//   • Read (team): owner unconditionally; manager only when
//     is_sales_activity_manager() returns true (DEFAULT TRUE — deliberate
//     deviation with rationale that production visibility is the module's
//     core coaching purpose).
//   • Write: RLS allows producer to INSERT their own rows; owner/manager
//     inserts on behalf of others land in the "producer_id" field on the
//     entry form, with the trigger ensuring cross-tenant safety.
//   • Delete: producer within 1 hour of insert (typo escape hatch),
//     owner/manager anytime. Enforced client-side via canDelete(row) age
//     check; RLS + a delete policy would be the more defensible pattern
//     but for v0.5.5 UI ship we use client-side age gate + owner override
//     (backend can tighten in a follow-on if audit review flags it).
//
// Data sources:
//   • public.sales_activity — INSERT/UPDATE/DELETE via direct table access
//     (RLS scoped)
//   • v_sales_activity_weekly_by_producer — 12w rolling per LOB, self and
//     team-wide
//   • v_sales_activity_monthly_by_producer — 12m rolling 4-dim (also feeds
//     Scoreboard in v0.5.7)
//   • v_sales_activity_outcome_distribution — bound / pending / follow_up /
//     lost mix
//   • get_office_activity_weekly(p_agency_id) — SECURITY DEFINER aggregate,
//     owner/manager only (raises 42501 otherwise)
//
// Ask Claude buttons: seeded per spec §4.2 in Base's PlaybookGuide.jsx —
// this file surfaces them via AskClaudeButton but does not duplicate
// prompt text (single source of truth in Base).
// =============================================================================

import { useState, useMemo, useEffect, useCallback } from "react";
import {
  TrendingUp, Plus, Edit3, Trash2, Check, X, AlertTriangle,
  AlertCircle, Users, BarChart3, Calendar, Zap, Target
} from "lucide-react";

import { supabase } from "../lib/supabase.js";
import { useSupabaseQuery } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";

import SectionHeader from "../components/SectionHeader.jsx";
import StatCard from "../components/StatCard.jsx";
import EmptyState from "../components/EmptyState.jsx";
import LoadingState from "../components/LoadingState.jsx";
import AskClaudeButton from "../components/AskClaudeButton.jsx";
import SearchInput from "../components/SearchInput.jsx";

import { useMyProfile } from "../lib/useMyProfile.js";

// =============================================================================
// Enum tables — mirrored EXACTLY from migration 102 CHECK constraints.
// If Rebecca ever adds a new activity_type or LOB, update the migration
// FIRST, then this file. Do not add values here that the database rejects.
// =============================================================================

const ACTIVITY_TYPES = [
  { value: "quote_issued",     label: "Quote issued" },
  { value: "app_submitted",    label: "App submitted" },
  { value: "policy_bound",     label: "Policy bound" },
  { value: "cross_sell",       label: "Cross-sell" },
  { value: "life_app",         label: "Life app" },
  { value: "fs_referral",      label: "FS referral" },
  { value: "account_round",    label: "Account round" },
  { value: "retention_call",   label: "Retention call" },
  { value: "service_touch",    label: "Service touch" },
  { value: "prospecting_call", label: "Prospecting call" },
  { value: "follow_up",        label: "Follow-up" },
  { value: "claims_handling",  label: "Claims handling" },
  { value: "other",            label: "Other" },
];

// Top-4 get the equal-weight big-button treatment on the entry form.
// Rebecca's call — the four most common daily entries.
const TOP_ACTIVITY_TYPES = ["quote_issued", "app_submitted", "policy_bound", "cross_sell"];

const LOB_TYPES = [
  { value: "auto",               label: "Auto" },
  { value: "fire",               label: "Fire" },
  { value: "life",               label: "Life" },
  { value: "health",             label: "Health" },
  { value: "bank",               label: "Bank" },
  { value: "financial_services", label: "Financial Services" },
  { value: "other",              label: "Other" },
];

const OUTCOMES = [
  { value: "bound",     label: "Bound",     tone: "emerald" },
  { value: "pending",   label: "Pending",   tone: "amber"   },
  { value: "follow_up", label: "Follow-up", tone: "blue"    },
  { value: "lost",      label: "Lost",      tone: "gray"    },
  { value: "n_a",       label: "N/A",       tone: "gray"    },
];

const PREMIUM_BANDS = [
  { value: "under_500",    label: "< $500" },
  { value: "500_to_1000",  label: "$500 – $1,000" },
  { value: "1000_plus",    label: "$1,000+" },
  { value: "n_a",          label: "N/A" },
];

// PII patterns for the soft-warning lint on internal_reference and notes.
// Per spec §4.2: "soft warning, not block" — we highlight the match, require
// a second confirm click, but ultimately allow submission if the producer
// insists (they may have a false positive, e.g. an internal batch ID that
// coincidentally matches the SF policy regex).
const PII_PATTERNS = [
  { name: "phone number", regex: /\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b/g },
  { name: "VIN",          regex: /\b[A-HJ-NPR-Z0-9]{17}\b/g },
  { name: "email",        regex: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { name: "SF policy #",  regex: /\b\d{2}[- ]?\d{4}[- ]?[A-Z]\d{2}[- ]?[A-Z]\d{2}\b/g },
];

// -----------------------------------------------------------------------------
// File-local helpers
// -----------------------------------------------------------------------------
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function fmtRelative(iso) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const mins = Math.floor((now - then) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDate(iso.slice(0, 10));
}

function labelFor(list, value) {
  const found = list.find((v) => v.value === value);
  return found ? found.label : value;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Age-based permission gates for own-row edit/delete (Rebecca's spec):
//   • Edit own row: within 24 hours of creation
//   • Delete own row: within 1 hour of creation (typo escape hatch)
// Owner/manager overrides both (checked at call site).
function canProducerEdit(row) {
  if (!row?.created_at) return false;
  const age = Date.now() - new Date(row.created_at).getTime();
  return age < 24 * 60 * 60 * 1000;
}
function canProducerDelete(row) {
  if (!row?.created_at) return false;
  const age = Date.now() - new Date(row.created_at).getTime();
  return age < 60 * 60 * 1000;
}

// Scan a string for PII pattern matches. Returns [{ name, sample }] or [].
function scanPII(text) {
  if (!text) return [];
  const hits = [];
  for (const p of PII_PATTERNS) {
    const matches = text.match(p.regex);
    if (matches && matches.length > 0) {
      hits.push({ name: p.name, sample: matches[0] });
    }
  }
  return hits;
}

// =============================================================================
// PIIWarningBanner — persistent slim banner at top of module.
// Inlined here rather than extracted to /components because no other module
// currently needs it (Time Tracking may want it later; extract then).
// =============================================================================
function PIIWarningBanner() {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 flex items-start gap-2 text-sm">
      <AlertTriangle size={16} className="text-amber-700 flex-shrink-0 mt-0.5" />
      <div className="text-amber-900">
        <span className="font-semibold">No customer PII.</span>{" "}
        Internal reference and notes are for your private shorthand only —
        never customer names, phone numbers, VINs, policy numbers, or emails.
        The database blocks the columns; this banner reminds you before you type.
      </div>
    </div>
  );
}

// =============================================================================
// Main component
// =============================================================================
export default function SalesActivity() {
  const profile = useMyProfile();
  const isOwner = profile.data?.role === "Owner / Agent";
  const isManagerLike = profile.data?.role === "Office Manager"
                        && profile.data?.status === "active";
  const showTeamSurface = isOwner || isManagerLike;

  const [modalOpen, setModalOpen] = useState(false);

  // Weekly rollup (for tiles + trend). RLS returns only what the caller
  // can see: producer sees own weekly rows; owner/manager see all agency
  // producers' weekly rows.
  const weeklyQuery = useSupabaseQuery(
    () => supabase
      .from("v_sales_activity_weekly_by_producer")
      .select("*")
      .order("week_starting", { ascending: false }),
    []
  );

  // Monthly rollup (for LOB mix + nudge computation). Same RLS story.
  const monthlyQuery = useSupabaseQuery(
    () => supabase
      .from("v_sales_activity_monthly_by_producer")
      .select("*")
      .order("month_starting", { ascending: false }),
    []
  );

  // Recent entries (own rows for producer, all agency rows for owner/manager
  // via RLS). Last 30 days.
  const recentQuery = useSupabaseQuery(
    () => supabase
      .from("sales_activity")
      .select("*")
      .gte("activity_date", daysAgoISO(30))
      .order("activity_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(200),
    []
  );

  // Staff lookup — the rollup views expose producer_id (UUID) only, no
  // producer_name column. RLS on public.staff scopes: producer sees only
  // their own row (per overlay 100a policies); owner/manager see all
  // agency staff. We build a Map<staff_id, full_name> and pass it down
  // to child components so they can render human-readable names.
  const staffQuery = useSupabaseQuery(
    () => supabase
      .from("staff")
      .select("id, agency_id, full_name, role, status")
      .order("full_name", { ascending: true }),
    []
  );

  const producerNameById = useMemo(() => {
    const m = new Map();
    for (const s of staffQuery.data || []) {
      m.set(s.id, s.full_name || "—");
    }
    return m;
  }, [staffQuery.data]);

  const refreshAll = useCallback(() => {
    if (weeklyQuery.refresh) weeklyQuery.refresh();
    if (monthlyQuery.refresh) monthlyQuery.refresh();
    if (recentQuery.refresh) recentQuery.refresh();
    if (staffQuery.refresh) staffQuery.refresh();
  }, [weeklyQuery, monthlyQuery, recentQuery, staffQuery]);

  const loading = weeklyQuery.loading || monthlyQuery.loading
                  || recentQuery.loading || profile.loading || staffQuery.loading;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Sales Activity"
        description={
          showTeamSurface
            ? "Team production log — quotes, apps, bound policies, cross-sells, and more. Coach from the numbers."
            : "Log your daily production — quotes, apps, bound policies, cross-sells. Your notes stay private to you and the office."
        }
        actions={
          <div className="flex gap-2">
            {showTeamSurface && (
              <AskClaudeButton
                moduleLabel="Sales Activity"
                subject="team sales activity this week"
                context={{
                  weekly: (weeklyQuery.data || []).slice(0, 40),
                  monthly: (monthlyQuery.data || []).slice(0, 20),
                }}
                suggestedPrompt="Coach me through the team's activity this week. Who's on pace, who's slipping, and what should I do about it before Monday?"
              />
            )}
            <button
              type="button"
              className="if-button text-sm"
              onClick={() => setModalOpen(true)}
              disabled={!profile.data}
            >
              <Plus size={14} className="inline mr-1" />
              Log activity
            </button>
          </div>
        }
      />

      {loading && !profile.data ? (
        <LoadingState message="Loading sales activity…" rows={4} />
      ) : profile.data ? (
        showTeamSurface ? (
          <OwnerManagerSurface
            profile={profile.data}
            weekly={weeklyQuery.data || []}
            monthly={monthlyQuery.data || []}
            recent={recentQuery.data || []}
            producerNameById={producerNameById}
            loading={loading}
            error={weeklyQuery.error || monthlyQuery.error || recentQuery.error}
            onChanged={refreshAll}
            isOwner={isOwner}
          />
        ) : (
          <ProducerSurface
            profile={profile.data}
            weekly={weeklyQuery.data || []}
            monthly={monthlyQuery.data || []}
            recent={recentQuery.data || []}
            producerNameById={producerNameById}
            loading={loading}
            error={weeklyQuery.error || monthlyQuery.error || recentQuery.error}
            onChanged={refreshAll}
          />
        )
      ) : (
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load your profile"
          description="Sign out and back in, or contact your agency owner if this persists."
        />
      )}

      {modalOpen && (
        <LogActivityModal
          profile={profile.data}
          staffList={staffQuery.data || []}
          onClose={() => setModalOpen(false)}
          onSaved={() => refreshAll()}
          canPickProducer={showTeamSurface}
        />
      )}
    </div>
  );
}

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// =============================================================================
// ProducerSurface — producer's own view (RLS returns own rows only)
// =============================================================================
function ProducerSurface({ profile, weekly, monthly, recent, producerNameById, loading, error, onChanged }) {
  // Filter to self (defensive — RLS already scopes)
  const mine = useMemo(() => recent.filter((r) => r.producer_id === profile.id), [recent, profile.id]);
  const myWeekly = useMemo(() => weekly.filter((r) => r.producer_id === profile.id), [weekly, profile.id]);
  const myMonthly = useMemo(() => monthly.filter((r) => r.producer_id === profile.id), [monthly, profile.id]);

  // 30-day tiles
  const tiles = useMemo(() => {
    const thirty = mine;
    const quotes = thirty.filter((r) => r.activity_type === "quote_issued").length;
    const apps = thirty.filter((r) => r.activity_type === "app_submitted").length;
    const bound = thirty.filter((r) => r.outcome === "bound").length;
    const total = thirty.length;
    const boundRate = total > 0 ? Math.round((bound / total) * 100) : 0;
    return { total, quotes, apps, bound, boundRate };
  }, [mine]);

  // 8-week trend from myWeekly. The view rows are keyed by week_starting +
  // line_of_business (multiple rows per week), so we sum activity_count
  // across LOBs to get one bar per week.
  const trend = useMemo(() => {
    const byWeek = new Map();
    for (const row of myWeekly) {
      const key = row.week_starting;
      byWeek.set(key, (byWeek.get(key) || 0) + (row.activity_count || 0));
    }
    return Array.from(byWeek.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(-8)
      .map(([week_starting, count]) => ({ week_starting, count }));
  }, [myWeekly]);

  // Own monthly LOB mix (Rebecca's decision: producers see this as a
  // self-coaching signal).
  const lobMix = useMemo(() => aggregateLOB(myMonthly, 3), [myMonthly]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Activities (30d)"  value={tiles.total}         loading={loading} icon={TrendingUp} />
        <StatCard label="Quotes issued"     value={tiles.quotes}        loading={loading} icon={Zap} />
        <StatCard label="Policies bound"    value={tiles.bound}         loading={loading} icon={Target} />
        <StatCard label="Bound rate"        value={`${tiles.boundRate}%`} loading={loading} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TrendCard title="Your last 8 weeks" trend={trend} />
        <LOBMixCard title="Your LOB mix (last 3 months)" mix={lobMix} />
      </div>

      <RecentEntriesList
        rows={mine}
        producerNameById={producerNameById}
        loading={loading}
        error={error}
        onChanged={onChanged}
        currentUserId={profile.id}
        isPrivileged={false}
      />
    </div>
  );
}

// =============================================================================
// OwnerManagerSurface — team roll-ups + leaderboard + nudge tile
// =============================================================================
function OwnerManagerSurface({ profile, weekly, monthly, recent, producerNameById, loading, error, onChanged, isOwner }) {
  // Office MTD headline — SECURITY DEFINER RPC. Returns ONE row for the
  // MTD summary (activity_type breakdown + by_lob JSONB). Used for the
  // "Bound rate" tile only; we compute the current/prior-week deltas
  // from the weekly view aggregated agency-wide because the RPC does
  // not return a comparable prior period.
  const [officeMTD, setOfficeMTD] = useState({ row: null, loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!profile?.agency_id) return;
      try {
        const { data, error: rpcErr } = await supabase.rpc(
          "get_office_activity_monthly",
          { p_agency_id: profile.agency_id }
        );
        if (rpcErr) throw rpcErr;
        const row = Array.isArray(data) ? data[0] : data;
        if (!cancelled) setOfficeMTD({ row: row || null, loading: false, error: null });
      } catch (err) {
        if (!cancelled) setOfficeMTD({ row: null, loading: false, error: err });
      }
    })();
    return () => { cancelled = true; };
  }, [profile?.agency_id, weekly.length]);

  // Aggregate weekly rows agency-wide (across all producers, summing LOB
  // rows). Gives us a Map<week_starting, {activity, bound, pending}> that
  // supports current-week + prior-week delta comparison.
  const agencyWeekly = useMemo(() => {
    const byWeek = new Map();
    for (const r of weekly) {
      const key = r.week_starting;
      if (!byWeek.has(key)) {
        byWeek.set(key, { week_starting: key, activity: 0, bound: 0, pending: 0 });
      }
      const agg = byWeek.get(key);
      agg.activity += r.activity_count || 0;
      agg.bound += r.bound_count || 0;
      agg.pending += r.pending_count || 0;
    }
    return Array.from(byWeek.values()).sort(
      (a, b) => (a.week_starting < b.week_starting ? 1 : -1)
    );
  }, [weekly]);

  const currentWeek = agencyWeekly[0] || null;
  const priorWeek = agencyWeekly[1] || null;
  const boundRateMTD = useMemo(() => {
    if (!officeMTD.row || !officeMTD.row.total_activities) return 0;
    return Math.round(
      (officeMTD.row.policies_bound / officeMTD.row.total_activities) * 100
    );
  }, [officeMTD.row]);

  // Producer leaderboard: use the most-recent week_starting value in the
  // weekly view, group by producer_id, sum activity/bound/pending across
  // LOB rows. Producer names come from the staff lookup Map.
  const leaderboard = useMemo(() => {
    if (!weekly.length) return [];
    const currentWeekStart = weekly[0]?.week_starting;
    if (!currentWeekStart) return [];
    const rows = weekly.filter((r) => r.week_starting === currentWeekStart);
    const byProducer = new Map();
    for (const r of rows) {
      const key = r.producer_id;
      if (!byProducer.has(key)) {
        byProducer.set(key, {
          producer_id: key,
          producer_name: producerNameById.get(key) || "—",
          activity_count: 0,
          bound_count: 0,
          pending_count: 0,
        });
      }
      const agg = byProducer.get(key);
      agg.activity_count += r.activity_count || 0;
      agg.bound_count += r.bound_count || 0;
      agg.pending_count += r.pending_count || 0;
    }
    return Array.from(byProducer.values()).sort(
      (a, b) => b.activity_count - a.activity_count
    );
  }, [weekly, producerNameById]);

  // "Who needs a nudge" — producers whose CURRENT-MONTH activity dropped
  // 25%+ vs PRIOR-MONTH. Computed from monthly view + staff lookup for
  // names. Rebecca's decision: ship this tile HERE in Sales Activity,
  // not defer to Scoreboard.
  const nudges = useMemo(
    () => computeNudges(monthly, producerNameById),
    [monthly, producerNameById]
  );

  // Team-wide LOB mix (Rebecca's decision: BOTH producer and team see LOB).
  const teamLOB = useMemo(() => aggregateLOB(monthly, 3), [monthly]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="This week — total"
          value={currentWeek?.activity ?? 0}
          delta={weekDelta(currentWeek?.activity, priorWeek?.activity)}
          loading={loading}
          icon={TrendingUp}
        />
        <StatCard
          label="Bound this week"
          value={currentWeek?.bound ?? 0}
          delta={weekDelta(currentWeek?.bound, priorWeek?.bound)}
          loading={loading}
          icon={Target}
        />
        <StatCard
          label="Bound rate (MTD)"
          value={`${boundRateMTD}%`}
          loading={officeMTD.loading}
        />
        <StatCard
          label="Needs a nudge"
          value={nudges.length}
          tone={nudges.length > 0 ? "warning" : "neutral"}
          loading={loading}
          icon={AlertCircle}
        />
      </div>

      {nudges.length > 0 && <NudgeCard nudges={nudges} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <LeaderboardCard rows={leaderboard} loading={loading} />
        <LOBMixCard title="Team LOB mix (last 3 months)" mix={teamLOB} />
      </div>

      <RecentEntriesList
        rows={recent.slice(0, 100)}
        producerNameById={producerNameById}
        loading={loading}
        error={error}
        onChanged={onChanged}
        currentUserId={profile.id}
        isPrivileged={true}
        showProducer={true}
      />
    </div>
  );
}

function weekDelta(curr, prior) {
  if (curr == null || prior == null || prior === 0) return null;
  const diff = curr - prior;
  const pct = Math.round((diff / prior) * 100);
  const sign = diff > 0 ? "+" : "";
  return `${sign}${diff} (${sign}${pct}%)`;
}

// Producers whose CURRENT-MONTH activity dropped 25%+ vs PRIOR-MONTH.
// Producer names come from producerNameById (staff lookup) since the
// monthly view exposes producer_id only.
function computeNudges(monthly, producerNameById) {
  if (!monthly?.length) return [];
  const byMonth = new Map();
  for (const r of monthly) {
    const key = r.month_starting;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(r);
  }
  const months = Array.from(byMonth.keys()).sort().reverse();
  if (months.length < 2) return [];
  const [thisMonth, lastMonth] = months;
  const thisByProducer = new Map();
  const lastByProducer = new Map();
  for (const r of byMonth.get(thisMonth)) {
    thisByProducer.set(
      r.producer_id,
      (thisByProducer.get(r.producer_id) || 0) + (r.activity_count || 0)
    );
  }
  for (const r of byMonth.get(lastMonth)) {
    lastByProducer.set(
      r.producer_id,
      (lastByProducer.get(r.producer_id) || 0) + (r.activity_count || 0)
    );
  }
  const nudges = [];
  for (const [pid, lastCount] of lastByProducer) {
    if (lastCount < 4) continue; // ignore tiny prior baselines — noise
    const thisCount = thisByProducer.get(pid) || 0;
    const dropPct = Math.round(((lastCount - thisCount) / lastCount) * 100);
    if (dropPct >= 25) {
      nudges.push({
        producer_id: pid,
        producer_name: producerNameById?.get(pid) || "—",
        this_month: thisCount,
        last_month: lastCount,
        drop_pct: dropPct,
      });
    }
  }
  return nudges.sort((a, b) => b.drop_pct - a.drop_pct);
}

// Aggregate LOB counts across last N months of monthly rows.
// Returns [{ lob, count }, ...] sorted by count desc.
function aggregateLOB(monthly, months) {
  if (!monthly?.length) return [];
  const monthsSet = new Set(
    Array.from(new Set(monthly.map((r) => r.month_starting))).sort().reverse().slice(0, months)
  );
  const counts = new Map();
  for (const r of monthly) {
    if (!monthsSet.has(r.month_starting)) continue;
    const lob = r.line_of_business || "other";
    counts.set(lob, (counts.get(lob) || 0) + (r.activity_count || 0));
  }
  return Array.from(counts.entries())
    .map(([lob, count]) => ({ lob, count }))
    .sort((a, b) => b.count - a.count);
}

// =============================================================================
// TrendCard — 8-week bar chart (producer surface)
// =============================================================================
function TrendCard({ title, trend }) {
  const max = Math.max(1, ...trend.map((t) => t.count));
  return (
    <div className="if-card">
      <div className="text-if-navy font-medium mb-3">{title}</div>
      {trend.length === 0 ? (
        <div className="text-if-muted text-sm">No activity in the last 8 weeks yet.</div>
      ) : (
        <div className="flex items-end gap-2 h-32">
          {trend.map((t) => (
            <div key={t.week_starting} className="flex-1 flex flex-col items-center gap-1">
              <div className="text-xs text-if-muted">{t.count}</div>
              <div
                className="w-full bg-if-teal/70 rounded-t"
                style={{ height: `${(t.count / max) * 100}%`, minHeight: 2 }}
                title={`Week of ${fmtDate(t.week_starting)}: ${t.count}`}
              />
              <div className="text-[10px] text-if-muted">
                {new Date(t.week_starting + "T00:00:00").toLocaleDateString(undefined, {
                  month: "numeric", day: "numeric",
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// LOBMixCard — horizontal bar chart of LOB counts
// =============================================================================
function LOBMixCard({ title, mix }) {
  const total = mix.reduce((a, b) => a + b.count, 0);
  return (
    <div className="if-card">
      <div className="text-if-navy font-medium mb-3">{title}</div>
      {mix.length === 0 ? (
        <div className="text-if-muted text-sm">Not enough data yet.</div>
      ) : (
        <div className="space-y-2">
          {mix.map((row) => {
            const pct = total > 0 ? Math.round((row.count / total) * 100) : 0;
            return (
              <div key={row.lob}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-if-navy">{labelFor(LOB_TYPES, row.lob)}</span>
                  <span className="text-if-muted">{row.count} · {pct}%</span>
                </div>
                <div className="h-2 bg-if-line/60 rounded overflow-hidden">
                  <div
                    className="h-full bg-if-teal"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// LeaderboardCard — this-week producer ranking (owner/manager surface)
// =============================================================================
function LeaderboardCard({ rows, loading }) {
  return (
    <div className="if-card">
      <div className="flex items-center gap-2 mb-3">
        <Users size={16} className="text-if-navy" />
        <span className="text-if-navy font-medium">This week — producers</span>
      </div>
      {loading ? (
        <div className="text-if-muted text-sm">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-if-muted text-sm">No activity logged this week yet.</div>
      ) : (
        <div className="divide-y divide-if-line/60 -mx-4">
          {rows.map((r, idx) => (
            <div key={r.producer_id} className="flex items-center justify-between px-4 py-2">
              <div className="flex items-center gap-3">
                <div className={cn(
                  "text-xs font-semibold w-6 text-center rounded",
                  idx === 0 && "text-amber-700",
                  idx === 1 && "text-if-muted",
                  idx === 2 && "text-amber-800/60"
                )}>
                  #{idx + 1}
                </div>
                <div className="text-if-navy text-sm">{r.producer_name}</div>
              </div>
              <div className="text-xs text-if-muted flex gap-3">
                <span>{r.activity_count} total</span>
                <span className="text-emerald-700">{r.bound_count} bound</span>
                {r.pending_count > 0 && (
                  <span className="text-amber-700">{r.pending_count} pending</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// NudgeCard — producers whose activity dropped 25%+ vs last month
// =============================================================================
function NudgeCard({ nudges }) {
  return (
    <div className="if-card border-amber-200 bg-amber-50/30">
      <div className="flex items-center gap-2 mb-3">
        <AlertCircle size={16} className="text-amber-700" />
        <span className="text-if-navy font-medium">Who needs a nudge</span>
        <span className="text-xs text-if-muted">
          Activity down 25%+ vs last month
        </span>
      </div>
      <div className="divide-y divide-if-line/60 -mx-4">
        {nudges.map((n) => (
          <div key={n.producer_id} className="flex items-center justify-between px-4 py-2">
            <div className="text-if-navy text-sm">{n.producer_name}</div>
            <div className="text-xs text-if-muted flex gap-3">
              <span>This mo: <strong className="text-if-navy">{n.this_month}</strong></span>
              <span>Last mo: {n.last_month}</span>
              <span className="text-red-700 font-medium">−{n.drop_pct}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// RecentEntriesList — 30-day feed with inline edit (24h) + delete (1h)
// =============================================================================
function RecentEntriesList({ rows, producerNameById, loading, error, onChanged, currentUserId, isPrivileged, showProducer }) {
  // v1.1 — search filter across producer name, activity type, LOB, outcome, date, notes, reference
  const [query, setQuery] = useState("");
  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => {
      const producerName = producerNameById?.get(row.producer_id) || "";
      return (
        producerName.toLowerCase().includes(q) ||
        String(row.activity_type ?? "").toLowerCase().includes(q) ||
        String(row.line_of_business ?? "").toLowerCase().includes(q) ||
        String(row.outcome ?? "").toLowerCase().includes(q) ||
        String(row.activity_date ?? "").toLowerCase().includes(q) ||
        String(row.notes ?? "").toLowerCase().includes(q) ||
        String(row.internal_reference ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, producerNameById]);

  if (loading && rows.length === 0) {
    return <LoadingState message="Loading recent activity…" rows={4} />;
  }
  if (error) {
    return (
      <div className="if-card border-red-200 bg-red-50/40">
        <div className="text-red-700 text-sm font-medium">Couldn't load activity.</div>
        <div className="text-red-700/80 text-xs mt-1">{String(error.message || error)}</div>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No activity in the last 30 days"
        description={isPrivileged
          ? "Once producers start logging, you'll see the shape of the week here."
          : "Log your first activity — this is how we celebrate wins together."}
      />
    );
  }
  return (
    <div className="space-y-3">
      <div className="if-no-print">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={showProducer ? "Search by producer, type, LOB, outcome, notes…" : "Search by type, LOB, outcome, notes…"}
        />
        {query && (
          <div className="text-xs text-if-muted mt-2 pl-1">
            {filteredRows.length === 0
              ? `No activity matches "${query}".`
              : `${filteredRows.length} of ${rows.length} entries`}
          </div>
        )}
      </div>
      <div className="if-card p-0">
        <div className="px-4 py-2 border-b border-if-line/60 text-if-navy font-medium text-sm">
          Recent activity (last 30 days)
        </div>
        {filteredRows.length === 0 ? (
          <div className="text-sm text-if-muted text-center py-8">
            No activity matches "{query}". <button type="button" onClick={() => setQuery("")} className="text-if-blue underline">Clear search</button>
          </div>
        ) : (
          <div className="divide-y divide-if-line/60">
            {filteredRows.map((row) => (
              <ActivityRow
                key={row.id}
                row={row}
                producerName={producerNameById?.get(row.producer_id)}
                onChanged={onChanged}
                currentUserId={currentUserId}
                isPrivileged={isPrivileged}
                showProducer={showProducer}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// ActivityRow — one entry with inline edit + delete
// =============================================================================
function ActivityRow({ row, producerName, onChanged, currentUserId, isPrivileged, showProducer }) {
  const [editing, setEditing] = useState(false);
  const isOwn = row.producer_id === currentUserId;
  const editAllowed = isPrivileged || (isOwn && canProducerEdit(row));
  const deleteAllowed = isPrivileged || (isOwn && canProducerDelete(row));

  if (editing) {
    return (
      <EditRow
        row={row}
        onCancel={() => setEditing(false)}
        onSaved={() => { setEditing(false); onChanged && onChanged(); }}
      />
    );
  }

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-if-navy font-medium">
              {labelFor(ACTIVITY_TYPES, row.activity_type)}
            </span>
            <span className="text-if-muted text-xs">·</span>
            <span className="text-if-muted text-sm">
              {labelFor(LOB_TYPES, row.line_of_business)}
            </span>
            <span className="text-if-muted text-xs">·</span>
            <OutcomeBadge outcome={row.outcome} />
            {row.premium_band && (
              <>
                <span className="text-if-muted text-xs">·</span>
                <span className="text-if-muted text-xs">
                  {labelFor(PREMIUM_BANDS, row.premium_band)}
                </span>
              </>
            )}
            {row.new_household && (
              <span className="text-xs text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                New household
              </span>
            )}
          </div>
          <div className="text-xs text-if-muted mt-1">
            {fmtDate(row.activity_date)}
            {showProducer && producerName && (
              <> · <span className="text-if-navy/80">{producerName}</span></>
            )}
            {" · "}logged {fmtRelative(row.created_at)}
          </div>
          {(row.internal_reference || row.notes) && (
            <div className="mt-2 text-sm text-if-navy/80">
              {row.internal_reference && (
                <span className="text-if-muted mr-2">Ref: {row.internal_reference}</span>
              )}
              {row.notes && <span>{row.notes}</span>}
            </div>
          )}
        </div>
        <div className="flex gap-1 flex-shrink-0">
          {editAllowed && (
            <button
              type="button"
              className="if-button-ghost text-xs"
              onClick={() => setEditing(true)}
              title="Edit entry"
            >
              <Edit3 size={12} />
            </button>
          )}
          {deleteAllowed && (
            <DeleteButton row={row} onDeleted={() => onChanged && onChanged()} />
          )}
        </div>
      </div>
    </div>
  );
}

function OutcomeBadge({ outcome }) {
  const meta = OUTCOMES.find((o) => o.value === outcome) || OUTCOMES[4];
  const toneClasses = {
    emerald: "bg-emerald-50 text-emerald-700",
    amber:   "bg-amber-50 text-amber-700",
    blue:    "bg-blue-50 text-blue-700",
    gray:    "bg-if-line/40 text-if-muted",
  };
  return (
    <span className={cn("text-xs px-1.5 py-0.5 rounded", toneClasses[meta.tone] || toneClasses.gray)}>
      {meta.label}
    </span>
  );
}

function DeleteButton({ row, onDeleted }) {
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function doDelete() {
    setSaving(true);
    setError(null);
    try {
      const { error: delErr } = await supabase
        .from("sales_activity")
        .delete()
        .eq("id", row.id);
      if (delErr) throw delErr;
      if (onDeleted) onDeleted();
    } catch (err) {
      setError(err.message || String(err));
      setSaving(false);
    }
  }

  if (confirm) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex gap-1">
          <button
            type="button"
            className="if-button-ghost text-xs"
            onClick={() => setConfirm(false)}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="if-button text-xs bg-red-600 hover:bg-red-700"
            onClick={doDelete}
            disabled={saving}
          >
            {saving ? "…" : "Delete"}
          </button>
        </div>
        {error && <div className="text-xs text-red-700">{error}</div>}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="if-button-ghost text-xs text-red-700"
      onClick={() => setConfirm(true)}
      title="Delete entry"
    >
      <Trash2 size={12} />
    </button>
  );
}

// =============================================================================
// EditRow — inline edit for outcome / premium_band / notes (safe fields)
// -----------------------------------------------------------------------------
// activity_type, line_of_business, activity_date, producer_id are FROZEN
// after insert. Only the outcome, premium_band, and free-text fields are
// editable — everything else is an audit-critical identity. If a producer
// mis-typed activity_type, they delete-and-re-log (within the 1h window).
// =============================================================================
function EditRow({ row, onCancel, onSaved }) {
  const [outcome, setOutcome] = useState(row.outcome);
  const [premiumBand, setPremiumBand] = useState(row.premium_band || "");
  const [newHousehold, setNewHousehold] = useState(!!row.new_household);
  const [internalRef, setInternalRef] = useState(row.internal_reference || "");
  const [notes, setNotes] = useState(row.notes || "");
  const [piiConfirmed, setPiiConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const piiHits = useMemo(
    () => [...scanPII(internalRef), ...scanPII(notes)],
    [internalRef, notes]
  );
  const needsPIIConfirm = piiHits.length > 0 && !piiConfirmed;

  async function save() {
    if (needsPIIConfirm) return;
    setSaving(true);
    setError(null);
    try {
      const { error: updErr } = await supabase
        .from("sales_activity")
        .update({
          outcome,
          premium_band: premiumBand || null,
          new_household: newHousehold,
          internal_reference: internalRef || null,
          notes: notes || null,
        })
        .eq("id", row.id);
      if (updErr) throw updErr;
      if (onSaved) onSaved();
    } catch (err) {
      setError(err.message || String(err));
      setSaving(false);
    }
  }

  return (
    <div className="p-4 bg-if-line/10 space-y-3">
      <div className="text-xs text-if-muted">
        Editing entry from {fmtDate(row.activity_date)} — {labelFor(ACTIVITY_TYPES, row.activity_type)} · {labelFor(LOB_TYPES, row.line_of_business)}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Outcome</span>
          <select
            className="if-input"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
          >
            {OUTCOMES.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Premium band</span>
          <select
            className="if-input"
            value={premiumBand}
            onChange={(e) => setPremiumBand(e.target.value)}
          >
            <option value="">—</option>
            {PREMIUM_BANDS.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-if-navy">
        <input
          type="checkbox"
          checked={newHousehold}
          onChange={(e) => setNewHousehold(e.target.checked)}
        />
        New household
      </label>
      <PIILintField
        label="Internal reference"
        placeholder="Your private shorthand (no customer info)"
        value={internalRef}
        onChange={setInternalRef}
        maxLength={50}
      />
      <PIILintField
        label="Notes"
        placeholder="Coaching context, follow-up plan (no customer info)"
        value={notes}
        onChange={setNotes}
        maxLength={200}
        multiline
      />
      {piiHits.length > 0 && (
        <PIIConfirmBlock
          hits={piiHits}
          confirmed={piiConfirmed}
          onConfirm={() => setPiiConfirmed(true)}
        />
      )}
      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
          {error}
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          className="if-button-ghost text-xs"
          onClick={onCancel}
          disabled={saving}
        >
          <X size={14} className="inline mr-1" /> Cancel
        </button>
        <button
          type="button"
          className="if-button text-xs"
          onClick={save}
          disabled={saving || needsPIIConfirm}
        >
          <Check size={14} className="inline mr-1" />
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// PIILintField — text input with live PII scan under the field
// =============================================================================
function PIILintField({ label, placeholder, value, onChange, maxLength, multiline }) {
  const hits = useMemo(() => scanPII(value), [value]);
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
        {label}
      </span>
      {multiline ? (
        <textarea
          className="if-input"
          rows={2}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
        />
      ) : (
        <input
          type="text"
          className="if-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
        />
      )}
      <div className="flex justify-between text-[10px] mt-1">
        <span className={cn(
          "text-if-muted",
          hits.length > 0 && "text-amber-700 font-medium"
        )}>
          {hits.length > 0 ? `Possible ${hits.map((h) => h.name).join(", ")}` : ""}
        </span>
        <span className="text-if-muted">{value.length}/{maxLength}</span>
      </div>
    </label>
  );
}

function PIIConfirmBlock({ hits, confirmed, onConfirm }) {
  return (
    <div className="rounded border border-amber-300 bg-amber-50 p-3 space-y-2">
      <div className="flex items-start gap-2 text-sm">
        <AlertTriangle size={16} className="text-amber-700 flex-shrink-0 mt-0.5" />
        <div className="text-amber-900">
          <div className="font-semibold">Possible customer PII detected.</div>
          <div className="mt-1">
            One of your fields looks like it might contain a{" "}
            {hits.map((h) => h.name).join(" or ")}. Customer PII is not
            allowed in this module. If this is a false positive (e.g. an
            internal batch ID), you can confirm and submit anyway.
          </div>
        </div>
      </div>
      {!confirmed && (
        <div className="flex justify-end">
          <button
            type="button"
            className="if-button-ghost text-xs"
            onClick={onConfirm}
          >
            This isn't customer PII — allow submit
          </button>
        </div>
      )}
      {confirmed && (
        <div className="text-xs text-amber-800 text-right">
          Confirmed as non-PII. Submit enabled.
        </div>
      )}
    </div>
  );
}

// =============================================================================
// LogActivityModal — new-entry form. Top-4 activity types get big buttons.
// =============================================================================
function LogActivityModal({ profile, staffList, onClose, onSaved, canPickProducer }) {
  const [activityType, setActivityType] = useState("");
  const [lob, setLOB] = useState("");
  const [outcome, setOutcome] = useState("");
  const [premiumBand, setPremiumBand] = useState("");
  const [newHousehold, setNewHousehold] = useState(false);
  const [activityDate, setActivityDate] = useState(todayISO());
  const [producerId, setProducerId] = useState(profile?.id || "");
  const [internalRef, setInternalRef] = useState("");
  const [notes, setNotes] = useState("");
  const [piiConfirmed, setPiiConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successFlash, setSuccessFlash] = useState(false);

  // Producer picker options — owner/manager only. Filter the shared staff
  // list (already fetched by the parent) to active staff in this agency.
  const activeStaff = useMemo(
    () => (staffList || []).filter(
      (s) => s.status === "active" && (!profile?.agency_id || s.agency_id === profile.agency_id || s.agency_id == null)
    ),
    [staffList, profile?.agency_id]
  );

  const piiHits = useMemo(
    () => [...scanPII(internalRef), ...scanPII(notes)],
    [internalRef, notes]
  );
  const needsPIIConfirm = piiHits.length > 0 && !piiConfirmed;
  const isValid = activityType && lob && outcome && activityDate && producerId;

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save({ keepOpen }) {
    if (!isValid || needsPIIConfirm) return;
    setSaving(true);
    setError(null);
    try {
      const { error: insErr } = await supabase
        .from("sales_activity")
        .insert({
          agency_id: profile.agency_id,
          producer_id: producerId,
          activity_date: activityDate,
          activity_type: activityType,
          line_of_business: lob,
          outcome,
          premium_band: premiumBand || null,
          new_household: newHousehold || null,
          internal_reference: internalRef || null,
          notes: notes || null,
        });
      if (insErr) throw insErr;
      if (onSaved) onSaved();
      if (keepOpen) {
        // Reset form for rapid re-entry — keep producer + date
        setActivityType("");
        setOutcome("");
        setPremiumBand("");
        setNewHousehold(false);
        setInternalRef("");
        setNotes("");
        setPiiConfirmed(false);
        setSuccessFlash(true);
        setTimeout(() => setSuccessFlash(false), 1500);
      } else {
        onClose();
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl mt-8 mb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-if-line flex items-center justify-between">
          <div className="text-if-navy font-semibold">Log activity</div>
          <button
            type="button"
            className="if-button-ghost text-if-muted"
            onClick={onClose}
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
              {/* Top-4 activity types — big buttons, equal weight */}
          <div>
            <div className="text-xs uppercase tracking-wide text-if-muted mb-2">
              Activity type
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {TOP_ACTIVITY_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={cn(
                    "px-3 py-3 rounded border-2 text-sm font-medium transition-all",
                    activityType === t
                      ? "border-if-teal bg-if-teal text-white shadow-sm ring-2 ring-if-teal/30"
                      : "border-if-line bg-white hover:border-if-teal/60 text-if-navy"
                  )}
                  onClick={() => setActivityType(t)}
                >
                  {labelFor(ACTIVITY_TYPES, t)}
                </button>
              ))}
            </div>
            <div className="mt-2">
              <select
                className="if-input text-sm"
                value={TOP_ACTIVITY_TYPES.includes(activityType) ? "" : activityType}
                onChange={(e) => setActivityType(e.target.value)}
              >
                <option value="">Or pick another type…</option>
                {ACTIVITY_TYPES.filter((t) => !TOP_ACTIVITY_TYPES.includes(t.value)).map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* LOB — chips */}
          <div>
            <div className="text-xs uppercase tracking-wide text-if-muted mb-2">
              Line of business
            </div>
            <div className="flex flex-wrap gap-2">
              {LOB_TYPES.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  className={cn(
                    "px-3 py-1.5 rounded-full text-xs border-2 font-medium transition-all",
                    lob === l.value
                      ? "border-if-teal bg-if-teal text-white shadow-sm"
                      : "border-if-line bg-white text-if-navy hover:border-if-teal/60"
                  )}
                  onClick={() => setLOB(l.value)}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
                Outcome
              </span>
              <select
                className="if-input"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              >
                <option value="">Select…</option>
                {OUTCOMES.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
                Premium band
              </span>
              <select
                className="if-input"
                value={premiumBand}
                onChange={(e) => setPremiumBand(e.target.value)}
              >
                <option value="">— (optional)</option>
                {PREMIUM_BANDS.map((b) => (
                  <option key={b.value} value={b.value}>{b.label}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
                Activity date
              </span>
              <input
                type="date"
                className="if-input"
                value={activityDate}
                onChange={(e) => setActivityDate(e.target.value)}
                max={todayISO()}
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm text-if-navy">
            <input
              type="checkbox"
              checked={newHousehold}
              onChange={(e) => setNewHousehold(e.target.checked)}
            />
            New household
          </label>

          {canPickProducer && (
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
                Logging on behalf of
              </span>
              <select
                className="if-input"
                value={producerId}
                onChange={(e) => setProducerId(e.target.value)}
              >
                {activeStaff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.full_name} ({s.role})
                  </option>
                ))}
              </select>
            </label>
          )}

          <PIILintField
            label="Internal reference"
            placeholder="Your private shorthand (no customer info)"
            value={internalRef}
            onChange={setInternalRef}
            maxLength={50}
          />
          <PIILintField
            label="Notes"
            placeholder="Coaching context, follow-up plan (no customer info)"
            value={notes}
            onChange={setNotes}
            maxLength={200}
            multiline
          />

          {piiHits.length > 0 && (
            <PIIConfirmBlock
              hits={piiHits}
              confirmed={piiConfirmed}
              onConfirm={() => setPiiConfirmed(true)}
            />
          )}

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
              {error}
            </div>
          )}

          {successFlash && (
            <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2 flex items-center gap-2">
              <Check size={14} /> Logged. Ready for the next one.
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-if-line flex items-center justify-between gap-2">
          <div className="text-xs text-if-muted">
            Fields marked required: activity type, LOB, outcome, date.
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="if-button-ghost text-sm"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="if-button-ghost text-sm"
              onClick={() => save({ keepOpen: true })}
              disabled={saving || !isValid || needsPIIConfirm}
              title="Save this entry and clear the form for the next one"
            >
              Save &amp; log another
            </button>
            <button
              type="button"
              className="if-button text-sm"
              onClick={() => save({ keepOpen: false })}
              disabled={saving || !isValid || needsPIIConfirm}
            >
              <Check size={14} className="inline mr-1" />
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
