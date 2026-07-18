// =============================================================================
// TimeTracking.jsx — Producer hours logging + team coaching surface
// -----------------------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.6 UI (Premium §4.1 Module 01)
//
// HIGH-STAKES COMPLIANCE MODULE — READ MIGRATION 101 HEADER §1-§3 BEFORE
// EDITING THIS FILE. Customer PII must never land in this module. The
// database schema itself blocks customer identifier columns; this UI adds
// layered client-side defenses (persistent banner, in-form callout, and
// regex lint on the one free-text field — notes) as belt-and-suspenders.
//
// Routing: BCCApp.jsx dispatches nav id "time" to this component for
// owner, manager, and staff roles. Rendering forks on role:
//   • Producer (any non-owner/non-manager): sees only their own entries,
//     personal weekly/monthly tiles, own 8-week hours trend, own MTD
//     category mix, and a missing-day reminder card for the last 14
//     workdays.
//   • Owner / Office Manager (with enable_time_tracking_manager_access,
//     which DEFAULTS TRUE per migration 101 — documented B.11 deviation
//     with the same coaching-signal rationale as Sales Activity §4.2):
//     sees agency-wide tiles, past-due timesheets card, producer
//     leaderboard, team category mix, and — when Sales Activity data is
//     also present — the Sales-Hours-per-Activity ratio (the busy-vs-
//     productive coaching tile that is the entire reason Time Tracking
//     and Sales Activity ship together).
//
// Producer Isolation Principle B.11 (from migration 101 §3):
//   • Read (own rows): every producer sees their own entries via RLS
//     policy time_tracking_producer_own.
//   • Read (team): owner unconditionally; manager only when
//     is_time_tracking_manager() returns true (DEFAULT TRUE — deliberate
//     deviation with rationale that team hours visibility is the module's
//     core coaching purpose).
//   • Write: RLS allows producer to INSERT/UPDATE their own rows
//     (scoped by producer_id = auth-mapped staff id). Owner/manager
//     inserts on behalf of others go through the same table with the
//     enforce_time_tracking_producer_agency trigger ensuring cross-tenant
//     safety.
//   • Edit / delete windows (client-side, per Rebecca's spec Q8):
//       - Producer edit own row: only if entry_date is in the current
//         calendar week (Mon-Sun). Prior weeks are locked; producer must
//         ask owner/manager to make corrections.
//       - Producer delete own row: within 24 hours of creation (typo
//         escape hatch — wider than SA's 1h window because time entries
//         are more consequential to correct after the fact).
//       - Owner / Office Manager: no window. Any entry, any producer,
//         any time (server RLS + manager gate re-check).
//
// Upsert semantics: migration 101 enforces
//   UNIQUE (producer_id, entry_date, activity_category)
// which means logging "3.5h sales_activity on Tuesday" a second time
// UPDATES the existing row via ON CONFLICT rather than creating a
// duplicate. LogHoursModal uses supabase.from(...).upsert(..., {
// onConflict: 'producer_id,entry_date,activity_category' }) so the
// producer sees the summed hours when they add another slice for the
// same day/category. This is deliberate — the spec is HOURS-SUMMARY
// per day per category, NOT clock-in/clock-out (documented deviation
// from spec §4.1 clock model — Rebecca's Q3 ratification).
//
// Data sources (all shipped in migration 101):
//   • public.time_tracking — INSERT/UPDATE/DELETE via direct table
//     access (RLS-scoped).
//   • v_time_tracking_weekly_by_producer — 12w rolling per category,
//     self and team-wide.
//   • v_time_tracking_monthly_by_producer — 12m rolling per category
//     (also feeds Scoreboard v0.5.7 without additional views).
//   • v_time_tracking_category_mtd — team category mix for the current
//     month (used by owner/manager surface only).
//   • v_time_tracking_missing_days_by_producer — 14-day rolling
//     Mon-Fri absence view; today is NEVER flagged (owner's yesterday
//     is not producer's fault today). Producer surface reads WHERE
//     producer_id = own; owner/manager surface reads for whole agency.
//   • get_office_time_weekly(p_agency_id) — SECURITY DEFINER single-row
//     rollup for owner/manager MTD tiles. Owner/manager only (raises
//     42501 otherwise).
//
// Cross-module data (owner/manager surface only):
//   • v_sales_activity_weekly_by_producer — read for the current-week
//     sales-hours-per-activity coaching ratio. If SA data is absent
//     (module not populated yet, or producer hasn't logged any) the
//     tile shows "—" gracefully.
//
// Ask Claude buttons: seeded per spec §4.1 in Base's PlaybookGuide.jsx
// at Base master HEAD 6d8f8c2b — this file surfaces them via
// AskClaudeButton but does not duplicate prompt text (single source of
// truth in Base). The 4 Time Tracking seed prompts are: hours
// leaderboard, time-on-task breakdown, hours-vs-activity mismatch
// (busy-vs-productive), training investment.
// =============================================================================

import { useState, useMemo, useEffect, useCallback } from "react";
import {
  Clock, Plus, Edit3, Trash2, Check, X, AlertTriangle,
  AlertCircle, Users, Calendar, Zap, PieChart
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
// Enum tables — mirrored EXACTLY from migration 101 CHECK constraint.
// If Rebecca ever adds a new activity_category, update the migration
// FIRST, then this file. Do not add values here that the database rejects.
// =============================================================================

const ACTIVITY_CATEGORIES = [
  { value: "sales_activity",   label: "Sales activity",   tone: "teal"    },
  { value: "service_activity", label: "Service activity", tone: "blue"    },
  { value: "admin",            label: "Admin",            tone: "gray"    },
  { value: "training",         label: "Training",         tone: "emerald" },
  { value: "meeting",          label: "Meeting",          tone: "amber"   },
  { value: "break",            label: "Break",            tone: "gray"    },
  { value: "other",            label: "Other",            tone: "gray"    },
];

// PII patterns for the soft-warning lint on notes. Per spec §4.1 alignment
// with §4.2: soft warning, not block — a producer may have a false positive
// (e.g. an internal training-code that matches SF policy regex) and can
// confirm and submit anyway.
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

function fmtShortDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    month: "numeric", day: "numeric",
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

function fmtDayOfWeek(dow) {
  // Postgres EXTRACT(DOW) uses Sun=0..Sat=6 in the view materialization,
  // BUT the view already filters to Mon-Fri (1..5). Show the weekday name.
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return names[dow] || "—";
}

function labelFor(list, value) {
  const found = list.find((v) => v.value === value);
  return found ? found.label : value;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Monday-start-of-week, returned as YYYY-MM-DD (matches how the DB view
// keys week_starting via date_trunc('week', ...) which is ALSO Monday
// in PostgreSQL). Used both to compare against row.entry_date (client-
// side edit gate) and to join weekly view rows to a "current week" key.
function startOfWeekISO(dateOrIso) {
  const d = dateOrIso
    ? (typeof dateOrIso === "string" ? new Date(dateOrIso + "T00:00:00") : new Date(dateOrIso))
    : new Date();
  const day = d.getDay(); // Sun=0, Mon=1, ..., Sat=6
  // days back to Monday: Sun -> -6, Mon -> 0, Tue -> -1, ..., Sat -> -5
  const offset = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + offset);
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
}

// Start-of-current-month YYYY-MM-DD. Matches the DB view's month_starting
// via date_trunc('month', ...).
function startOfMonthISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// Age-based permission gates for own-row edit/delete (Rebecca's spec):
//   • Edit own row: entry_date must be in current calendar week (Mon-Sun).
//   • Delete own row: within 24h of creation (typo escape hatch).
// Owner/manager overrides both (checked at call site).
function canProducerEditByEntryDate(row) {
  if (!row?.entry_date) return false;
  return row.entry_date >= startOfWeekISO();
}
function canProducerDeleteByAge(row) {
  if (!row?.created_at) return false;
  const age = Date.now() - new Date(row.created_at).getTime();
  return age < 24 * 60 * 60 * 1000;
}

// Is the given ISO date in a prior calendar week from today's perspective?
// Used to gate INSERT (producer can only log for current-week dates;
// owner/manager can back-fill).
function isPriorWeekDate(iso) {
  if (!iso) return false;
  return iso < startOfWeekISO();
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

// One decimal for hours display (0.25 increments in, one-decimal out is
// almost always what's shown to a human; 3.25 stays 3.25 because toFixed(2)
// but we use toFixed(1) for tiles and toFixed(2) for row details).
function fmtHours(h, digits) {
  const n = Number(h);
  if (Number.isNaN(n)) return "—";
  const d = digits ?? 1;
  return n.toFixed(d);
}

// =============================================================================
// PIIWarningBanner — persistent slim banner at top of module.
// Same shape as SalesActivity — same reasoning (schema-level PII block
// backed by client-side reminder).
// =============================================================================
function PIIWarningBanner() {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 flex items-start gap-2 text-sm">
      <AlertTriangle size={16} className="text-amber-700 flex-shrink-0 mt-0.5" />
      <div className="text-amber-900">
        <span className="font-semibold">No customer PII.</span>{" "}
        Notes are for your private shorthand only — never customer names,
        phone numbers, VINs, policy numbers, or emails. The database blocks
        the columns; this banner reminds you before you type.
      </div>
    </div>
  );
}

// =============================================================================
// Main component
// =============================================================================
export default function TimeTracking() {
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
      .from("v_time_tracking_weekly_by_producer")
      .select("*")
      .order("week_starting", { ascending: false }),
    []
  );

  // Monthly rollup (for own category mix + team rollups). Same RLS story.
  const monthlyQuery = useSupabaseQuery(
    () => supabase
      .from("v_time_tracking_monthly_by_producer")
      .select("*")
      .order("month_starting", { ascending: false }),
    []
  );

  // Missing-day view — producer sees own rows (RLS); owner/manager sees
  // whole agency. Window is fixed at 14 workdays back to yesterday.
  const missingDaysQuery = useSupabaseQuery(
    () => supabase
      .from("v_time_tracking_missing_days_by_producer")
      .select("*")
      .order("missing_date", { ascending: false }),
    []
  );

  // Recent entries — RLS scopes to own for producer, all-agency for
  // owner/manager. Producer surface renders last 14 days; owner/manager
  // renders last 7 days but we fetch 14 for consistency and slice in the
  // child components.
  const recentQuery = useSupabaseQuery(
    () => supabase
      .from("time_tracking")
      .select("*")
      .gte("entry_date", daysAgoISO(14))
      .order("entry_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(300),
    []
  );

  // Staff lookup — the rollup views expose producer_id (UUID) only. RLS
  // on public.staff scopes: producer sees own row; owner/manager see all
  // agency staff. Build a Map<staff_id, full_name> for name resolution
  // in the leaderboard + past-due card + producer picker.
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

  // Sales Activity weekly rollup — owner/manager surface only, and only
  // for the sales-hours-per-activity coaching tile. If the module isn't
  // populated yet, the useSupabaseQuery hook returns [] and the tile
  // gracefully renders "—".
  const salesWeeklyQuery = useSupabaseQuery(
    () => supabase
      .from("v_sales_activity_weekly_by_producer")
      .select("week_starting,activity_count,producer_id")
      .order("week_starting", { ascending: false }),
    []
  );

  const refreshAll = useCallback(() => {
    if (weeklyQuery.refresh) weeklyQuery.refresh();
    if (monthlyQuery.refresh) monthlyQuery.refresh();
    if (missingDaysQuery.refresh) missingDaysQuery.refresh();
    if (recentQuery.refresh) recentQuery.refresh();
    if (staffQuery.refresh) staffQuery.refresh();
    if (salesWeeklyQuery.refresh) salesWeeklyQuery.refresh();
  }, [weeklyQuery, monthlyQuery, missingDaysQuery, recentQuery, staffQuery, salesWeeklyQuery]);

  const loading = weeklyQuery.loading || monthlyQuery.loading
                  || missingDaysQuery.loading || recentQuery.loading
                  || profile.loading || staffQuery.loading;

  return (
    <div className="space-y-6">
      <SectionHeader
        title={showTeamSurface ? "Team Time Tracking" : "Time Tracking"}
        description={
          showTeamSurface
            ? "Team hours by category — coach from where the day is spent, not just the outcome."
            : "Log where your day went. Categories are your framework; notes are your private shorthand."
        }
        actions={
          <div className="flex gap-2">
            {showTeamSurface && (
              <AskClaudeButton
                moduleLabel="Time Tracking"
                subject="team time this week"
                context={{
                  weekly: (weeklyQuery.data || []).slice(0, 60),
                  monthly: (monthlyQuery.data || []).slice(0, 30),
                }}
                suggestedPrompt="Look at how the team spent time this week and compare it to sales activity. Who's under-logging hours vs their sales activity, and who might be busy without being productive? Give me one thing to bring up in each 1:1."
              />
            )}
            <button
              type="button"
              className="if-button text-sm"
              onClick={() => setModalOpen(true)}
              disabled={!profile.data}
            >
              <Plus size={14} className="inline mr-1" />
              Log hours
            </button>
          </div>
        }
      />

      {loading && !profile.data ? (
        <LoadingState message="Loading time tracking…" rows={4} />
      ) : profile.data ? (
        showTeamSurface ? (
          <OwnerManagerSurface
            profile={profile.data}
            weekly={weeklyQuery.data || []}
            monthly={monthlyQuery.data || []}
            missingDays={missingDaysQuery.data || []}
            recent={recentQuery.data || []}
            salesWeekly={salesWeeklyQuery.data || []}
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
            missingDays={missingDaysQuery.data || []}
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
        <LogHoursModal
          profile={profile.data}
          staffList={staffQuery.data || []}
          onClose={() => setModalOpen(false)}
          onSaved={() => refreshAll()}
          canPickProducer={showTeamSurface}
          canBackfillPriorWeek={showTeamSurface}
        />
      )}
    </div>
  );
}

// =============================================================================
// ProducerSurface — producer's own view (RLS returns own rows only)
// =============================================================================
function ProducerSurface({ profile, weekly, monthly, missingDays, recent, producerNameById, loading, error, onChanged }) {
  // Filter to self (defensive — RLS already scopes)
  const mine = useMemo(() => recent.filter((r) => r.producer_id === profile.id), [recent, profile.id]);
  const myWeekly = useMemo(() => weekly.filter((r) => r.producer_id === profile.id), [weekly, profile.id]);
  const myMonthly = useMemo(() => monthly.filter((r) => r.producer_id === profile.id), [monthly, profile.id]);
  const myMissing = useMemo(
    () => missingDays.filter((r) => r.producer_id === profile.id),
    [missingDays, profile.id]
  );

  // Tiles
  const tiles = useMemo(() => {
    const weekStart = startOfWeekISO();
    const monthStart = startOfMonthISO();
    const thisWeek = mine.filter((r) => r.entry_date >= weekStart);
    const thisMonth = mine.filter((r) => r.entry_date >= monthStart);
    const weekHours = thisWeek.reduce((a, r) => a + Number(r.hours || 0), 0);
    const monthHours = thisMonth.reduce((a, r) => a + Number(r.hours || 0), 0);
    const daysLoggedThisWeek = new Set(thisWeek.map((r) => r.entry_date)).size;
    // Most-common category by hours in the last 30 days (fall back to
    // whatever this month has if 30d overlaps).
    const catHours = new Map();
    for (const r of mine) {
      catHours.set(r.activity_category, (catHours.get(r.activity_category) || 0) + Number(r.hours || 0));
    }
    let topCat = "—";
    let topH = 0;
    for (const [cat, h] of catHours) {
      if (h > topH) { topH = h; topCat = cat; }
    }
    return {
      weekHours, monthHours, daysLoggedThisWeek,
      topCat: topCat === "—" ? "—" : labelFor(ACTIVITY_CATEGORIES, topCat),
    };
  }, [mine]);

  // 8-week hours trend (own). The view rows are keyed by week_starting +
  // activity_category (multiple rows per week), so we sum total_hours
  // across categories to get one bar per week.
  const trend = useMemo(() => {
    const byWeek = new Map();
    for (const row of myWeekly) {
      const key = row.week_starting;
      byWeek.set(key, (byWeek.get(key) || 0) + Number(row.total_hours || 0));
    }
    return Array.from(byWeek.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(-8)
      .map(([week_starting, hours]) => ({ week_starting, hours }));
  }, [myWeekly]);

  // Own MTD category mix
  const catMix = useMemo(() => aggregateCategoryHours(myMonthly, [startOfMonthISO()]), [myMonthly]);

  return (
    <div className="space-y-6">
      {myMissing.length > 0 && (
        <MissingDayReminderCard days={myMissing} />
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Hours this week"   value={fmtHours(tiles.weekHours)}  loading={loading} icon={Clock} />
        <StatCard label="Hours this month"  value={fmtHours(tiles.monthHours)} loading={loading} icon={Calendar} />
        <StatCard label="Days logged (M–F)" value={`${tiles.daysLoggedThisWeek} / 5`} loading={loading} />
        <StatCard label="Top category"      value={tiles.topCat} loading={loading} icon={PieChart} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <HoursTrendCard title="Your last 8 weeks (hours)" trend={trend} />
        <CategoryMixCard title="Your category mix (MTD)" mix={catMix} />
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
// TimeClockCard — live in/out punch clock for the currently signed-in user.
// Compact card at the top of the owner surface. Shows current time in Eastern
// (the agent's TZ). Clock In snapshots the moment + selected category. Clock Out
// computes elapsed decimal hours and INSERTs/UPSERTs into time_tracking,
// same shape LogHoursModal uses so the summary/leaderboard/leaderboard math
// stays consistent. Session survives page refresh via localStorage keyed to
// the profile id — if the agent clocks in on desktop and comes back an hour later,
// the clock keeps counting.
// =============================================================================
function TimeClockCard({ profile, onSaved }) {
  const [now, setNow] = useState(new Date());
  const [category, setCategory] = useState("sales_activity");
  const [clockedIn, setClockedIn] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);

  // Storage key scoped to the signed-in profile so multi-account browsers don't collide
  const storageKey = profile?.id ? `bcc_time_clock_${profile.id}` : null;

  // Hydrate from localStorage on mount
  useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.startedAt === "number") {
          setClockedIn(parsed);
          if (parsed.category) setCategory(parsed.category);
        }
      }
    } catch { /* localStorage disabled or corrupt — ignore */ }
    setHydrated(true);
  }, [storageKey]);

  // Persist changes
  useEffect(() => {
    if (!hydrated || !storageKey) return;
    try {
      if (clockedIn) {
        window.localStorage.setItem(storageKey, JSON.stringify(clockedIn));
      } else {
        window.localStorage.removeItem(storageKey);
      }
    } catch { /* noop */ }
  }, [clockedIn, hydrated, storageKey]);

  // Tick every second
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Formatters — Eastern Time for the agent in Tucker, GA
  const ET_TIME = useMemo(
    () => new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
    }),
    []
  );
  const ET_DAY = useMemo(
    () => new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long", month: "long", day: "numeric",
    }),
    []
  );
  // en-CA yields YYYY-MM-DD which matches Postgres DATE
  const ET_ISO_DATE = useMemo(
    () => new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    }),
    []
  );

  const nowDisplay = ET_TIME.format(now);
  const dayDisplay = ET_DAY.format(now);
  const startedAtDisplay = clockedIn
    ? ET_TIME.format(new Date(clockedIn.startedAt))
    : null;

  const elapsedSec = clockedIn ? Math.max(0, (now.getTime() - clockedIn.startedAt) / 1000) : 0;
  const elapsedH = Math.floor(elapsedSec / 3600);
  const elapsedM = Math.floor((elapsedSec % 3600) / 60);
  const elapsedS = Math.floor(elapsedSec % 60);
  const elapsedLabel = elapsedH > 0
    ? `${elapsedH}h ${String(elapsedM).padStart(2, "0")}m ${String(elapsedS).padStart(2, "0")}s`
    : `${elapsedM}m ${String(elapsedS).padStart(2, "0")}s`;
  const decimalHours = Math.round((elapsedSec / 3600) * 100) / 100;

  const canClock = !!profile?.id && !!profile?.agency_id;

  function handleClockIn() {
    if (!canClock || clockedIn) return;
    setError(null);
    setFlash(null);
    setClockedIn({
      startedAt: Date.now(),
      category,
    });
  }

  async function handleClockOut() {
    if (!clockedIn) return;
    if (decimalHours < 0.02) {
      // Less than ~1 minute — nothing meaningful to log. Reset the clock silently.
      setClockedIn(null);
      setFlash("Cleared — less than a minute elapsed.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const entryDate = ET_ISO_DATE.format(now);
      const finishDisplay = ET_TIME.format(now);
      const startedDisplay = ET_TIME.format(new Date(clockedIn.startedAt));
      const noteSuffix = `Clock \u23F1 ${startedDisplay} \u2192 ${finishDisplay}`;

      // Read-then-upsert to match LogHoursModal semantics (sum on collision)
      const { data: existing, error: readErr } = await supabase
        .from("time_tracking")
        .select("id, hours, notes")
        .eq("agency_id", profile.agency_id)
        .eq("producer_id", profile.id)
        .eq("entry_date", entryDate)
        .eq("activity_category", clockedIn.category)
        .maybeSingle();
      if (readErr) throw readErr;

      if (existing) {
        const mergedHours = Number(existing.hours || 0) + decimalHours;
        const mergedNotes = [existing.notes, noteSuffix].filter(Boolean).join(" \u00B7 ");
        const { error: updErr } = await supabase
          .from("time_tracking")
          .update({ hours: mergedHours, notes: mergedNotes || null })
          .eq("id", existing.id);
        if (updErr) throw updErr;
      } else {
        const { error: insErr } = await supabase
          .from("time_tracking")
          .insert({
            agency_id: profile.agency_id,
            producer_id: profile.id,
            entry_date: entryDate,
            activity_category: clockedIn.category,
            hours: decimalHours,
            notes: noteSuffix,
          });
        if (insErr) throw insErr;
      }

      const savedHours = decimalHours;
      setClockedIn(null);
      setFlash(`Saved ${savedHours.toFixed(2)} h to ${entryDate}.`);
      if (onSaved) onSaved();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setClockedIn(null);
    setError(null);
    setFlash("Session cancelled — nothing saved.");
  }

  const activeCategoryLabel = ACTIVITY_CATEGORIES.find(
    (c) => c.value === (clockedIn?.category || category)
  )?.label || category;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 flex flex-wrap items-center justify-between gap-4">
      {/* Live clock (left) */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-blue-50 text-blue-700 flex-shrink-0">
          <Clock size={22} />
        </div>
        <div className="min-w-0">
          <div className="text-2xl font-semibold text-slate-900 tabular-nums leading-tight">
            {nowDisplay}
          </div>
          <div className="text-xs text-slate-500">{dayDisplay} · Eastern Time</div>
        </div>
      </div>

      {/* Controls (right) */}
      <div className="flex items-center gap-3 flex-wrap">
        {clockedIn ? (
          <>
            <div className="text-right">
              <div className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">
                On the clock
              </div>
              <div className="text-sm text-slate-800">
                Started {startedAtDisplay} · {activeCategoryLabel}
              </div>
              <div className="text-xs text-slate-500 tabular-nums">
                {elapsedLabel} · {decimalHours.toFixed(2)} h
              </div>
            </div>
            <button
              type="button"
              onClick={handleClockOut}
              disabled={saving}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Clock out & save"}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <label className="text-xs text-slate-600">
              Category
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="ml-2 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                {ACTIVITY_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={handleClockIn}
              disabled={!canClock}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              title={canClock ? "Start the clock" : "Waiting for your profile…"}
            >
              Clock in
            </button>
          </>
        )}
      </div>

      {/* Flash / error row (full width, only when present) */}
      {(flash || error) && (
        <div className="w-full">
          {flash && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
              {flash}
            </div>
          )}
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// OwnerManagerSurface — team roll-ups + leaderboard + past-due card
// =============================================================================
function OwnerManagerSurface({ profile, weekly, monthly, missingDays, recent, salesWeekly, producerNameById, loading, error, onChanged, isOwner }) {
  // Office weekly RPC — SECURITY DEFINER single-row aggregate. We call it
  // for the "This Week — team total" tile (uses window_start = Monday of
  // current week; the RPC returns THIS week's team totals). The RPC also
  // returns per-category hrs — handy if we ever want to drop the mix
  // card and just render RPC output, but for parity with SA we keep the
  // client-side aggregation for the mix card.
  const [officeWeek, setOfficeWeek] = useState({ row: null, loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!profile?.agency_id) return;
      try {
        const { data, error: rpcErr } = await supabase.rpc(
          "get_office_time_weekly",
          { p_agency_id: profile.agency_id }
        );
        if (rpcErr) throw rpcErr;
        const row = Array.isArray(data) ? data[0] : data;
        if (!cancelled) setOfficeWeek({ row: row || null, loading: false, error: null });
      } catch (err) {
        if (!cancelled) setOfficeWeek({ row: null, loading: false, error: err });
      }
    })();
    return () => { cancelled = true; };
  }, [profile?.agency_id, weekly.length]);

  // Aggregate weekly rows agency-wide (across all producers, summing
  // category rows). Gives us a Map<week_starting, {total_hours}> for
  // trend + prior-week comparison.
  const agencyWeekly = useMemo(() => {
    const byWeek = new Map();
    for (const r of weekly) {
      const key = r.week_starting;
      byWeek.set(key, (byWeek.get(key) || 0) + Number(r.total_hours || 0));
    }
    return Array.from(byWeek.entries())
      .map(([week_starting, total_hours]) => ({ week_starting, total_hours }))
      .sort((a, b) => (a.week_starting < b.week_starting ? 1 : -1));
  }, [weekly]);

  const currentWeek = agencyWeekly[0] || null;
  const priorWeek = agencyWeekly[1] || null;

  // Active producers this week — count of distinct producer_ids in the
  // weekly view for the current week_starting.
  const activeProducersThisWeek = useMemo(() => {
    const key = agencyWeekly[0]?.week_starting;
    if (!key) return 0;
    const set = new Set();
    for (const r of weekly) if (r.week_starting === key) set.add(r.producer_id);
    return set.size;
  }, [weekly, agencyWeekly]);

  // Sales-hours-per-activity coaching ratio for THIS week (team level).
  // Numerator: total hours in activity_category = 'sales_activity' this
  //   week across all producers.
  // Denominator: total SA activity_count this week across all producers.
  // A LOW ratio (e.g. 0.4 hr/activity) means the team is productive
  //   (many activities per hour). A HIGH ratio (e.g. 3.0 hr/activity)
  //   means the team is busy but not productive.
  const salesHrsPerActivity = useMemo(() => {
    const key = agencyWeekly[0]?.week_starting;
    if (!key) return null;
    let salesHours = 0;
    for (const r of weekly) {
      if (r.week_starting === key && r.activity_category === "sales_activity") {
        salesHours += Number(r.total_hours || 0);
      }
    }
    let saCount = 0;
    for (const r of salesWeekly) {
      if (r.week_starting === key) saCount += Number(r.activity_count || 0);
    }
    if (saCount === 0 || salesHours === 0) return null;
    return salesHours / saCount;
  }, [weekly, salesWeekly, agencyWeekly]);

  // Producer leaderboard — this week's hours, sortable by descending.
  const leaderboard = useMemo(() => {
    const key = agencyWeekly[0]?.week_starting;
    if (!key) return [];
    const byProducer = new Map();
    for (const r of weekly) {
      if (r.week_starting !== key) continue;
      const p = r.producer_id;
      if (!byProducer.has(p)) {
        byProducer.set(p, {
          producer_id: p,
          producer_name: producerNameById.get(p) || "—",
          total_hours: 0,
          categories: {},
        });
      }
      const agg = byProducer.get(p);
      const h = Number(r.total_hours || 0);
      agg.total_hours += h;
      agg.categories[r.activity_category] = (agg.categories[r.activity_category] || 0) + h;
    }
    return Array.from(byProducer.values()).sort(
      (a, b) => b.total_hours - a.total_hours
    );
  }, [weekly, agencyWeekly, producerNameById]);

  // Team category mix (last 3 months).
  const teamCatMix = useMemo(() => {
    const monthsSet = new Set(
      Array.from(new Set(monthly.map((r) => r.month_starting)))
        .sort().reverse().slice(0, 3)
    );
    return aggregateCategoryHours(monthly, monthsSet);
  }, [monthly]);

  // Past-due timesheets — group missing days by producer, count entries.
  const pastDueByProducer = useMemo(() => {
    const byP = new Map();
    for (const r of missingDays) {
      const p = r.producer_id;
      if (!byP.has(p)) {
        byP.set(p, {
          producer_id: p,
          producer_name: producerNameById.get(p) || "—",
          count: 0,
          most_recent: r.missing_date,
          oldest: r.missing_date,
        });
      }
      const agg = byP.get(p);
      agg.count += 1;
      if (r.missing_date > agg.most_recent) agg.most_recent = r.missing_date;
      if (r.missing_date < agg.oldest) agg.oldest = r.missing_date;
    }
    return Array.from(byP.values()).sort((a, b) => b.count - a.count);
  }, [missingDays, producerNameById]);

  return (
    <div className="space-y-6">
      <TimeClockCard profile={profile} onSaved={onChanged} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Team hours this week"
          value={fmtHours(currentWeek?.total_hours ?? 0)}
          delta={weekDelta(currentWeek?.total_hours, priorWeek?.total_hours)}
          loading={loading}
          icon={Clock}
        />
        <StatCard
          label="Team hours this month"
          value={fmtHours(Number(officeWeek.row?.total_hours) || monthTotalFromRows(monthly))}
          loading={officeWeek.loading && loading}
          icon={Calendar}
        />
        <StatCard
          label="Active producers"
          value={activeProducersThisWeek}
          loading={loading}
          icon={Users}
        />
        <StatCard
          label="Sales hrs / activity"
          value={salesHrsPerActivity == null ? "—" : fmtHours(salesHrsPerActivity, 2)}
          tone={salesHrsPerActivity == null ? "neutral" : (salesHrsPerActivity <= 1 ? "positive" : (salesHrsPerActivity >= 2 ? "warning" : "neutral"))}
          loading={loading}
          icon={Zap}
        />
      </div>

      {pastDueByProducer.length > 0 && (
        <PastDueTimesheetsCard rows={pastDueByProducer} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <HoursLeaderboardCard rows={leaderboard} loading={loading} />
        <CategoryMixCard title="Team category mix (last 3 months)" mix={teamCatMix} />
      </div>

      <RecentEntriesList
        rows={recent.filter((r) => r.entry_date >= daysAgoISO(7)).slice(0, 150)}
        producerNameById={producerNameById}
        loading={loading}
        error={error}
        onChanged={onChanged}
        currentUserId={profile.id}
        isPrivileged={true}
        showProducer={true}
        heading="Team entries (last 7 days)"
      />
    </div>
  );
}

function weekDelta(curr, prior) {
  if (curr == null || prior == null || prior === 0) return null;
  const diff = curr - prior;
  const pct = Math.round((diff / prior) * 100);
  return { diff, pct };
}

// Fallback: if the RPC failed but the monthly view has current-month
// rows, sum them agency-wide so the tile still lights up.
function monthTotalFromRows(monthly) {
  const key = startOfMonthISO();
  let total = 0;
  for (const r of monthly) {
    if (r.month_starting === key) total += Number(r.total_hours || 0);
  }
  return total;
}

// Aggregate category hours across a set of month_starting keys.
// Returns [{ category, hours }, ...] sorted by hours desc.
function aggregateCategoryHours(monthly, monthsSetOrArray) {
  const monthsSet = monthsSetOrArray instanceof Set
    ? monthsSetOrArray
    : new Set(monthsSetOrArray || []);
  const counts = new Map();
  for (const r of monthly || []) {
    if (monthsSet.size > 0 && !monthsSet.has(r.month_starting)) continue;
    const cat = r.activity_category || "other";
    counts.set(cat, (counts.get(cat) || 0) + Number(r.total_hours || 0));
  }
  return Array.from(counts.entries())
    .map(([category, hours]) => ({ category, hours }))
    .sort((a, b) => b.hours - a.hours);
}

// =============================================================================
// MissingDayReminderCard — producer surface (own missing days)
// =============================================================================
function MissingDayReminderCard({ days }) {
  const sorted = [...days].sort((a, b) => (a.missing_date < b.missing_date ? -1 : 1));
  return (
    <div className="if-card border-amber-200 bg-amber-50/30">
      <div className="flex items-center gap-2 mb-2">
        <AlertCircle size={16} className="text-amber-700" />
        <span className="text-if-navy font-medium">You're missing some days</span>
        <span className="text-xs text-if-muted">Log hours so your week reflects reality.</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {sorted.map((d) => (
          <span
            key={d.missing_date}
            className="text-xs px-2 py-1 rounded-full border border-amber-300 bg-white text-amber-900"
            title={`${d.days_ago} day${d.days_ago === 1 ? "" : "s"} ago`}
          >
            {fmtDayOfWeek(d.day_of_week)} {fmtShortDate(d.missing_date)}
          </span>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// PastDueTimesheetsCard — owner/manager surface (agency missing days)
// =============================================================================
function PastDueTimesheetsCard({ rows }) {
  return (
    <div className="if-card border-amber-200 bg-amber-50/30">
      <div className="flex items-center gap-2 mb-3">
        <AlertCircle size={16} className="text-amber-700" />
        <span className="text-if-navy font-medium">Past-due timesheets</span>
        <span className="text-xs text-if-muted">
          Weekday hours not yet logged (last 14 workdays, today never flagged)
        </span>
      </div>
      <div className="divide-y divide-if-line/60 -mx-4">
        {rows.map((r) => (
          <div key={r.producer_id} className="flex items-center justify-between px-4 py-2">
            <div className="text-if-navy text-sm">{r.producer_name}</div>
            <div className="text-xs text-if-muted flex gap-3">
              <span>
                <strong className="text-if-navy">{r.count}</strong> day{r.count === 1 ? "" : "s"} missing
              </span>
              <span>oldest: {fmtShortDate(r.oldest)}</span>
              <span>most recent: {fmtShortDate(r.most_recent)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// HoursTrendCard — 8-week hours bar chart (producer surface)
// =============================================================================
function HoursTrendCard({ title, trend }) {
  const max = Math.max(1, ...trend.map((t) => t.hours));
  return (
    <div className="if-card">
      <div className="text-if-navy font-medium mb-3">{title}</div>
      {trend.length === 0 ? (
        <div className="text-if-muted text-sm">No hours logged in the last 8 weeks yet.</div>
      ) : (
        <div className="flex items-end gap-2 h-32">
          {trend.map((t) => (
            <div key={t.week_starting} className="flex-1 flex flex-col items-center gap-1">
              <div className="text-xs text-if-muted">{fmtHours(t.hours)}</div>
              <div
                className="w-full bg-if-teal/70 rounded-t"
                style={{ height: `${(t.hours / max) * 100}%`, minHeight: 2 }}
                title={`Week of ${fmtDate(t.week_starting)}: ${fmtHours(t.hours)} hours`}
              />
              <div className="text-[10px] text-if-muted">
                {fmtShortDate(t.week_starting)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// CategoryMixCard — horizontal bar chart of category hours
// =============================================================================
function CategoryMixCard({ title, mix }) {
  const total = mix.reduce((a, b) => a + b.hours, 0);
  return (
    <div className="if-card">
      <div className="text-if-navy font-medium mb-3">{title}</div>
      {mix.length === 0 || total === 0 ? (
        <div className="text-if-muted text-sm">Not enough data yet.</div>
      ) : (
        <div className="space-y-2">
          {mix.map((row) => {
            const pct = total > 0 ? Math.round((row.hours / total) * 100) : 0;
            return (
              <div key={row.category}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-if-navy">{labelFor(ACTIVITY_CATEGORIES, row.category)}</span>
                  <span className="text-if-muted">{fmtHours(row.hours)}h · {pct}%</span>
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
// HoursLeaderboardCard — this-week producer ranking by hours
// =============================================================================
function HoursLeaderboardCard({ rows, loading }) {
  return (
    <div className="if-card">
      <div className="flex items-center gap-2 mb-3">
        <Users size={16} className="text-if-navy" />
        <span className="text-if-navy font-medium">This week — producers by hours</span>
      </div>
      {loading ? (
        <div className="text-if-muted text-sm">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-if-muted text-sm">No hours logged this week yet.</div>
      ) : (
        <div className="divide-y divide-if-line/60 -mx-4">
          {rows.map((r, idx) => {
            const salesH = Number(r.categories.sales_activity || 0);
            const serviceH = Number(r.categories.service_activity || 0);
            const adminH = Number(r.categories.admin || 0);
            return (
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
                  <span><strong className="text-if-navy">{fmtHours(r.total_hours)}</strong>h total</span>
                  {salesH > 0 && <span className="text-emerald-700">{fmtHours(salesH)}h sales</span>}
                  {serviceH > 0 && <span className="text-blue-700">{fmtHours(serviceH)}h service</span>}
                  {adminH > 0 && <span>{fmtHours(adminH)}h admin</span>}
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
// RecentEntriesList — feed with inline edit (current week) + delete (24h)
// =============================================================================
function RecentEntriesList({ rows, producerNameById, loading, error, onChanged, currentUserId, isPrivileged, showProducer, heading }) {
  // v1.1 — search filter across producer name, activity category, entry date, and notes
  const [query, setQuery] = useState("");
  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => {
      const producerName = producerNameById?.get(row.producer_id) || "";
      return (
        producerName.toLowerCase().includes(q) ||
        String(row.activity_category ?? "").toLowerCase().includes(q) ||
        String(row.entry_date ?? "").toLowerCase().includes(q) ||
        String(row.notes ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, producerNameById]);

  if (loading && rows.length === 0) {
    return <LoadingState message="Loading recent entries…" rows={4} />;
  }
  if (error) {
    return (
      <div className="if-card border-red-200 bg-red-50/40">
        <div className="text-red-700 text-sm font-medium">Couldn't load time entries.</div>
        <div className="text-red-700/80 text-xs mt-1">{String(error.message || error)}</div>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Clock}
        title={isPrivileged ? "No time logged in the last 7 days" : "No time logged yet"}
        description={isPrivileged
          ? "Once producers start logging, you'll see where the week goes."
          : "Log your first day — even a single row for today gets you started."}
      />
    );
  }
  return (
    <div className="space-y-3">
      <div className="if-no-print">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={showProducer ? "Search by producer, category, date, or notes…" : "Search by category, date, or notes…"}
        />
        {query && (
          <div className="text-xs text-if-muted mt-2 pl-1">
            {filteredRows.length === 0
              ? `No entries match "${query}".`
              : `${filteredRows.length} of ${rows.length} entries`}
          </div>
        )}
      </div>
      <div className="if-card p-0">
        <div className="px-4 py-2 border-b border-if-line/60 text-if-navy font-medium text-sm">
          {heading || `Recent entries (last ${isPrivileged ? 7 : 14} days)`}
        </div>
        {filteredRows.length === 0 ? (
          <div className="text-sm text-if-muted text-center py-8">
            No entries match "{query}". <button type="button" onClick={() => setQuery("")} className="text-if-blue underline">Clear search</button>
          </div>
        ) : (
          <div className="divide-y divide-if-line/60">
            {filteredRows.map((row) => (
              <TimeEntryRow
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
// TimeEntryRow — one entry with inline edit + delete
// =============================================================================
function TimeEntryRow({ row, producerName, onChanged, currentUserId, isPrivileged, showProducer }) {
  const [editing, setEditing] = useState(false);
  const isOwn = row.producer_id === currentUserId;
  const editAllowed = isPrivileged || (isOwn && canProducerEditByEntryDate(row));
  const deleteAllowed = isPrivileged || (isOwn && canProducerDeleteByAge(row));

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
            <CategoryBadge category={row.activity_category} />
            <span className="text-if-navy font-semibold">
              {fmtHours(row.hours, 2)}h
            </span>
            <span className="text-if-muted text-xs">·</span>
            <span className="text-if-muted text-sm">
              {fmtDate(row.entry_date)}
            </span>
          </div>
          <div className="text-xs text-if-muted mt-1">
            {showProducer && producerName && (
              <><span className="text-if-navy/80">{producerName}</span>{" · "}</>
            )}
            logged {fmtRelative(row.created_at)}
            {row.updated_at && row.updated_at !== row.created_at && (
              <> · edited {fmtRelative(row.updated_at)}</>
            )}
          </div>
          {row.notes && (
            <div className="mt-2 text-sm text-if-navy/80">{row.notes}</div>
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

function CategoryBadge({ category }) {
  const meta = ACTIVITY_CATEGORIES.find((c) => c.value === category) || ACTIVITY_CATEGORIES[6];
  const toneClasses = {
    teal:    "bg-if-teal/10 text-if-navy border border-if-teal/40",
    blue:    "bg-blue-50 text-blue-700 border border-blue-200",
    emerald: "bg-emerald-50 text-emerald-700 border border-emerald-200",
    amber:   "bg-amber-50 text-amber-700 border border-amber-200",
    gray:    "bg-if-line/40 text-if-muted border border-if-line/60",
  };
  return (
    <span className={cn("text-xs px-2 py-0.5 rounded", toneClasses[meta.tone] || toneClasses.gray)}>
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
        .from("time_tracking")
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
// EditRow — inline edit for hours + notes ONLY
// -----------------------------------------------------------------------------
// entry_date, activity_category, producer_id are FROZEN after insert
// because the UNIQUE (producer_id, entry_date, activity_category) constraint
// means changing any of those turns edit into delete-and-insert. If a
// producer mis-typed the category, they delete-and-re-log (within the
// 24h window).
// =============================================================================
function EditRow({ row, onCancel, onSaved }) {
  const [hours, setHours] = useState(String(row.hours || ""));
  const [notes, setNotes] = useState(row.notes || "");
  const [piiConfirmed, setPiiConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const piiHits = useMemo(() => scanPII(notes), [notes]);
  const needsPIIConfirm = piiHits.length > 0 && !piiConfirmed;

  const hoursNum = Number(hours);
  const hoursValid = !Number.isNaN(hoursNum) && hoursNum > 0 && hoursNum <= 24;

  async function save() {
    if (needsPIIConfirm || !hoursValid) return;
    setSaving(true);
    setError(null);
    try {
      const { error: updErr } = await supabase
        .from("time_tracking")
        .update({
          hours: hoursNum,
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
        Editing entry from {fmtDate(row.entry_date)} — {labelFor(ACTIVITY_CATEGORIES, row.activity_category)}.
        Date and category are locked (delete + re-log to change them).
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Hours</span>
          <input
            type="number"
            className="if-input"
            step="0.25"
            min="0.25"
            max="24"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
          {!hoursValid && (
            <div className="text-xs text-red-700 mt-1">Enter 0.25 – 24.0.</div>
          )}
        </label>
      </div>
      <PIILintField
        label="Notes"
        placeholder="Optional context — no customer info"
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
          disabled={saving || needsPIIConfirm || !hoursValid}
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
            Your notes look like they might contain a{" "}
            {hits.map((h) => h.name).join(" or ")}. Customer PII is not
            allowed in this module. If this is a false positive (e.g. an
            internal training code), you can confirm and submit anyway.
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
// LogHoursModal — new/upsert entry form. Per Rebecca's Q3 ratification:
// hours-summary model, one row per (producer, date, category). Second
// entry for same (producer, date, category) upserts via ON CONFLICT.
// =============================================================================
function LogHoursModal({ profile, staffList, onClose, onSaved, canPickProducer, canBackfillPriorWeek }) {
  const [entryDate, setEntryDate] = useState(todayISO());
  const [category, setCategory] = useState("");
  const [hours, setHours] = useState("");
  const [notes, setNotes] = useState("");
  const [producerId, setProducerId] = useState(profile?.id || "");
  const [piiConfirmed, setPiiConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successFlash, setSuccessFlash] = useState(false);

  // Active staff in same agency — for the producer picker (owner/manager)
  const activeStaff = useMemo(
    () => (staffList || []).filter(
      (s) => s.status === "active" && (!profile?.agency_id || s.agency_id === profile.agency_id || s.agency_id == null)
    ),
    [staffList, profile?.agency_id]
  );

  const piiHits = useMemo(() => scanPII(notes), [notes]);
  const needsPIIConfirm = piiHits.length > 0 && !piiConfirmed;

  const hoursNum = Number(hours);
  const hoursValid = !Number.isNaN(hoursNum) && hoursNum > 0 && hoursNum <= 24;
  const dateValid = entryDate && entryDate <= todayISO();
  // Prior-week lock (Q9): producer can't INSERT to prior-week dates;
  // owner/manager can back-fill.
  const priorWeekBlocked = !canBackfillPriorWeek && isPriorWeekDate(entryDate);
  const isValid = category && hoursValid && dateValid && producerId && !priorWeekBlocked;

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
      // Upsert via ON CONFLICT (producer_id, entry_date, activity_category).
      // Second entry for same day/category sums with the existing row's
      // hours per Rebecca's Q3 spec — but the DB does row-level UPSERT,
      // not additive SUM. To honor "sum" semantics we read-then-upsert:
      //   1) Try INSERT. If UNIQUE violation, SELECT existing, add hours,
      //      then UPDATE.
      // Supabase-js .upsert() with { onConflict } replaces on conflict —
      // NOT what we want. Doing the read-then-write dance manually.
      const { data: existing, error: selErr } = await supabase
        .from("time_tracking")
        .select("id, hours, notes")
        .eq("producer_id", producerId)
        .eq("entry_date", entryDate)
        .eq("activity_category", category)
        .maybeSingle();
      if (selErr) throw selErr;

      if (existing) {
        // Merge — sum hours, concat notes if new notes provided.
        const mergedHours = Number(existing.hours || 0) + hoursNum;
        if (mergedHours > 24) {
          throw new Error(
            `Adding ${hoursNum}h to the existing ${existing.hours}h would exceed the 24h daily cap for ${labelFor(ACTIVITY_CATEGORIES, category)} on ${fmtDate(entryDate)}.`
          );
        }
        const mergedNotes = [existing.notes, notes].filter(Boolean).join(" · ");
        const { error: updErr } = await supabase
          .from("time_tracking")
          .update({
            hours: mergedHours,
            notes: mergedNotes || null,
          })
          .eq("id", existing.id);
        if (updErr) throw updErr;
      } else {
        const { error: insErr } = await supabase
          .from("time_tracking")
          .insert({
            agency_id: profile.agency_id,
            producer_id: producerId,
            entry_date: entryDate,
            activity_category: category,
            hours: hoursNum,
            notes: notes || null,
          });
        if (insErr) throw insErr;
      }

      if (onSaved) onSaved();
      if (keepOpen) {
        // Reset category + hours + notes; keep date + producer.
        setCategory("");
        setHours("");
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
          <div className="text-if-navy font-semibold">Log hours</div>
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
                Date
              </span>
              <input
                type="date"
                className="if-input"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                max={todayISO()}
              />
              {priorWeekBlocked && (
                <div className="text-xs text-red-700 mt-1">
                  Prior weeks are locked. Ask your owner or office manager to log this for you.
                </div>
              )}
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
                Category
              </span>
              <select
                className="if-input"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">Select…</option>
                {ACTIVITY_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
                Hours (0.25 – 24)
              </span>
              <input
                type="number"
                className="if-input"
                step="0.25"
                min="0.25"
                max="24"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                placeholder="e.g. 3.5"
              />
              {hours && !hoursValid && (
                <div className="text-xs text-red-700 mt-1">Enter 0.25 – 24.0.</div>
              )}
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
          </div>

          <PIILintField
            label="Notes (optional)"
            placeholder="Optional context — no customer info"
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
            Second entry for same day + category sums into the existing row.
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
