// =============================================================================
// Scoreboard.jsx — Premium §4.3 Module 03 — the game board.
// -----------------------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.7 UI (Premium §4.3 Module 03)
//
// LANGUAGE DISCIPLINE (locked with Rebecca 2026-07-10): this module is
// Scoreboard. NEVER "ScoreCard". State Farm's ScoreCard is an unrelated
// bonus program.
//
// This module is the differentiator of the Premium tier. Where Sales Activity
// and Time Tracking give the raw signal, Scoreboard is where the team gets
// to see themselves winning — goals, celebrations, and the team totals that
// make a monthly meeting feel like a game the whole office is playing.
//
// COMPLIANCE-SAFE MODULE (inherited from data sources):
// Scoreboard reads sales_activity and time_tracking rollup views only, both
// of which are schema-level PII-safe. Owner/manager can post free-text
// announcements (VARCHAR 500) and goal notes (VARCHAR 200) — we soft-warn
// on PII in those fields as belt-and-suspenders. No customer identifiers
// ever land in Scoreboard.
//
// Routing: BCCApp.jsx dispatches nav id "scoreboard" to this component for
// owner, manager, and staff roles. Rendering forks on role:
//   • Producer (any non-owner/non-manager): welcome hero with own
//     celebrations (rpc_get_celebrations), personal progress cards for own
//     goals + team-wide goals, office totals tile row (agency aggregate, no
//     per-producer names), announcements strip (read-only).
//   • Owner (unconditional access): everything above, PLUS producer
//     leaderboard, YoY tile, LOB mix, nudge tile (sales-activity HOURS
//     dropped 25%), Manage Goals modal, Manage Announcements modal.
//   • Office Manager: producer view by default. When owner toggles
//     enable_scoreboard_manager_access to 'true' (defaults 'false' —
//     CANONICAL B.11, first Premium module in 4 ships to hold canonical),
//     manager gets full owner view.
//
// Producer Isolation Principle B.11 (from migration 103 §2):
//   • Read (own goals + team-wide): every producer via RLS policy
//     scoreboard_goals_producer_read (producer_id = own OR producer_id IS
//     NULL).
//   • Read (all agency goals, all announcements, leaderboard): owner
//     unconditionally; manager only when is_scoreboard_manager() = TRUE.
//   • Write (goals, announcements): owner + gated manager only.
//   • Celebrations RPC: producer can call for own producer_id; owner/gated
//     manager can call for anyone in agency; cross-tenant raises 42501.
//
// Dependency notes:
//   • sales_activity (migration 102) must be installed for goal actuals,
//     YoY tile, LOB mix, and celebration RPC data.
//   • time_tracking (migration 101) must be installed for the nudge tile
//     (sales-activity HOURS dropped 25% vs last month — the busy-vs-
//     productive coaching angle).
//   • If either upstream is missing, this module degrades gracefully —
//     the affected tiles show empty states, not errors.
//
// Aesthetic direction (locked in handoff): game-board, not admin panel.
// Celebrations rotate. Progress bars fill in on mount. Numbers count up.
// This is where the Premium tier's price is justified visually. Do not
// import Framer Motion (not in Base bundle); use CSS transitions +
// requestAnimationFrame for all motion.
// =============================================================================

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";

import { supabase } from "../lib/supabase.js";
import { useSupabaseQuery } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";

import SectionHeader from "../components/SectionHeader.jsx";
import StatCard from "../components/StatCard.jsx";
import EmptyState from "../components/EmptyState.jsx";
import LoadingState from "../components/LoadingState.jsx";
import AskClaudeButton from "../components/AskClaudeButton.jsx";

import { useMyProfile } from "../lib/useMyProfile.js";

// =============================================================================
// Enum tables — mirrored EXACTLY from migration 103 CHECK constraint.
// If Rebecca ever adds a new goal_type, update the migration AND
// fn_compute_goal_actual FIRST, then this file.
// =============================================================================

const GOAL_TYPE_PRESETS = [
  { value: "auto_quotes",      label: "Auto quotes",       hint: "activity_type=quote_issued + LOB=auto"                          },
  { value: "fire_quotes",      label: "Fire quotes",       hint: "activity_type=quote_issued + LOB=fire"                          },
  { value: "life_apps",        label: "Life applications", hint: "activity_type=life_app OR (app_submitted + LOB=life)"           },
  { value: "total_binds",      label: "Total binds",       hint: "outcome=bound (any LOB)"                                        },
  { value: "auto_binds",       label: "Auto binds",        hint: "outcome=bound + LOB=auto"                                       },
  { value: "fire_binds",       label: "Fire binds",        hint: "outcome=bound + LOB=fire"                                       },
  { value: "life_binds",       label: "Life binds",        hint: "outcome=bound + LOB=life"                                       },
  { value: "cross_sells",      label: "Cross-sells",       hint: "activity_type=cross_sell"                                       },
  { value: "fs_referrals",     label: "FS referrals",      hint: "activity_type=fs_referral OR LOB=financial_services"            },
  { value: "total_activities", label: "Total activities",  hint: "Any activity row — coaching catch-all"                          },
];

const GOAL_PERIODS = [
  { value: "monthly",   label: "Monthly"   },
  { value: "quarterly", label: "Quarterly" },
  { value: "annual",    label: "Annual"    },
];

const CELEBRATION_STYLES = {
  goal_hit:                { emoji: "🎯", tone: "gold",    priority: 3 },
  bound_yesterday:         { emoji: "✍️", tone: "teal",    priority: 2 },
  cross_sell_yesterday:    { emoji: "🔗", tone: "emerald", priority: 2 },
  new_household_yesterday: { emoji: "🏡", tone: "blue",    priority: 2 },
  activity_streak_3:       { emoji: "🔥", tone: "coral",   priority: 1 },
};

// PII soft-warning patterns (reused from TimeTracking / SalesActivity).
const PII_PATTERNS = [
  { name: "phone number", regex: /\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b/g },
  { name: "VIN",          regex: /\b[A-HJ-NPR-Z0-9]{17}\b/g },
  { name: "email",        regex: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { name: "SF policy #",  regex: /\b\d{2}[- ]?\d{4}[- ]?[A-Z]\d{2}[- ]?[A-Z]\d{2}\b/g },
];

const LOB_LIST = ["auto", "fire", "life", "health", "bank", "financial_services"];
const LOB_LABEL = {
  auto: "Auto", fire: "Fire", life: "Life", health: "Health",
  bank: "Bank", financial_services: "Financial services",
};
const LOB_TONE = {
  auto: "teal", fire: "coral", life: "emerald", health: "blue",
  bank: "amber", financial_services: "gray",
};

// =============================================================================
// File-local helpers
// =============================================================================

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}

function fmtDateShort(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    month: "short", day: "numeric",
  });
}

function isoToday() { return new Date().toISOString().slice(0, 10); }

function isoMonthsAgoStart(monthsAgo) {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsAgo, 1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function firstOfMonth(dateIso) {
  const d = new Date(dateIso + "T00:00:00");
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

function lastOfMonth(dateIso) {
  const d = new Date(dateIso + "T00:00:00");
  d.setMonth(d.getMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}

function firstOfQuarter(dateIso) {
  const d = new Date(dateIso + "T00:00:00");
  const q = Math.floor(d.getMonth() / 3);
  d.setMonth(q * 3, 1);
  return d.toISOString().slice(0, 10);
}

function lastOfQuarter(dateIso) {
  const d = new Date(dateIso + "T00:00:00");
  const q = Math.floor(d.getMonth() / 3);
  d.setMonth(q * 3 + 3, 0);
  return d.toISOString().slice(0, 10);
}

function firstOfYear(dateIso) {
  const d = new Date(dateIso + "T00:00:00");
  d.setMonth(0, 1);
  return d.toISOString().slice(0, 10);
}

function lastOfYear(dateIso) {
  const d = new Date(dateIso + "T00:00:00");
  d.setMonth(11, 31);
  return d.toISOString().slice(0, 10);
}

function periodBoundsForType(periodType, anchorIso) {
  const anchor = anchorIso || isoToday();
  switch (periodType) {
    case "monthly":   return { period_start: firstOfMonth(anchor),   period_end: lastOfMonth(anchor)   };
    case "quarterly": return { period_start: firstOfQuarter(anchor), period_end: lastOfQuarter(anchor) };
    case "annual":    return { period_start: firstOfYear(anchor),    period_end: lastOfYear(anchor)    };
    default:          return { period_start: anchor,                 period_end: anchor                };
  }
}

function daysBetween(startIso, endIso) {
  const a = new Date(startIso + "T00:00:00");
  const b = new Date(endIso   + "T00:00:00");
  return Math.max(0, Math.round((b - a) / (1000 * 60 * 60 * 24)));
}

function daysLeftInPeriod(periodEndIso) {
  const today = new Date(isoToday() + "T00:00:00");
  const end   = new Date(periodEndIso + "T00:00:00");
  return Math.max(0, Math.round((end - today) / (1000 * 60 * 60 * 24)));
}

function scanPII(text) {
  if (!text || typeof text !== "string") return [];
  const hits = [];
  for (const pat of PII_PATTERNS) {
    const m = text.match(pat.regex);
    if (m && m.length) hits.push({ name: pat.name, count: m.length });
  }
  return hits;
}

function nameOf(staff) {
  if (!staff) return "—";
  const fn = (staff.first_name || "").trim();
  const ln = (staff.last_name  || "").trim();
  return (fn + " " + ln).trim() || staff.email || "—";
}

function humanGoalTypeLabel(gt) {
  const p = GOAL_TYPE_PRESETS.find(x => x.value === gt);
  return p ? p.label : gt.replace(/_/g, " ");
}

function pct(actual, target) {
  if (!target || target <= 0) return 0;
  return Math.min(100, Math.round((actual / target) * 100));
}

// =============================================================================
// Custom animation hook: useCountUp — animate a number from 0 to `target`
// over `duration` ms using requestAnimationFrame. On unmount, cancels safely.
// =============================================================================

function useCountUp(target, duration = 600) {
  const [value, setValue] = useState(0);
  const rafRef = useRef(null);
  const startRef = useRef(null);
  const lastTargetRef = useRef(target);

  useEffect(() => {
    if (target === lastTargetRef.current && startRef.current) return;
    lastTargetRef.current = target;
    startRef.current = null;

    function step(ts) {
      if (!startRef.current) startRef.current = ts;
      const elapsed = ts - startRef.current;
      const t = Math.min(1, elapsed / duration);
      // easeOutQuad
      const eased = 1 - (1 - t) * (1 - t);
      setValue(Math.round(target * eased));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      }
    }
    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target, duration]);

  return value;
}

// =============================================================================
// Data hooks — Supabase queries scoped by RLS.
// =============================================================================

function useScoreboardGoals(agencyId) {
  return useSupabaseQuery(
    ["scoreboard_goals", "all", agencyId || "none"],
    async () => {
      if (!agencyId) return [];
      const { data, error } = await supabase
        .from("scoreboard_goals")
        .select("id, agency_id, producer_id, goal_period, goal_type, target_value, period_start, period_end, is_active, notes, created_at, created_by_staff_id")
        .eq("agency_id", agencyId)
        .eq("is_active", true)
        .order("period_end", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    { enabled: !!agencyId }
  );
}

function useAnnouncements(agencyId) {
  return useSupabaseQuery(
    ["agency_announcements", "unexpired", agencyId || "none"],
    async () => {
      if (!agencyId) return [];
      const nowIso = new Date().toISOString();
      const { data, error } = await supabase
        .from("agency_announcements")
        .select("id, body, starts_at, ends_at, author_staff_id, created_at")
        .eq("agency_id", agencyId)
        .lte("starts_at", nowIso)
        .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
        .order("starts_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    { enabled: !!agencyId }
  );
}

function useCelebrations(producerStaffId) {
  return useSupabaseQuery(
    ["rpc_get_celebrations", producerStaffId || "none"],
    async () => {
      if (!producerStaffId) return [];
      const { data, error } = await supabase.rpc("rpc_get_celebrations", {
        p_producer_id: producerStaffId,
      });
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    },
    { enabled: !!producerStaffId, refetchOnWindowFocus: false }
  );
}

function useSalesActivityMonthly(agencyId, producerId) {
  return useSupabaseQuery(
    ["v_sales_activity_monthly", agencyId || "none", producerId || "all"],
    async () => {
      if (!agencyId) return [];
      let q = supabase
        .from("v_sales_activity_monthly_by_producer")
        .select("*")
        .eq("agency_id", agencyId);
      if (producerId) q = q.eq("producer_id", producerId);
      const { data, error } = await q;
      if (error) {
        // View may not exist if migration 102 isn't installed. Graceful degrade.
        if (String(error?.message || "").match(/relation .* does not exist/i)) return [];
        throw error;
      }
      return data || [];
    },
    { enabled: !!agencyId }
  );
}

function useTimeTrackingMonthly(agencyId) {
  return useSupabaseQuery(
    ["v_time_tracking_monthly", agencyId || "none"],
    async () => {
      if (!agencyId) return [];
      const { data, error } = await supabase
        .from("v_time_tracking_monthly_by_producer")
        .select("*")
        .eq("agency_id", agencyId);
      if (error) {
        if (String(error?.message || "").match(/relation .* does not exist/i)) return [];
        throw error;
      }
      return data || [];
    },
    { enabled: !!agencyId }
  );
}

function useSalesActivityWeekly(agencyId) {
  return useSupabaseQuery(
    ["v_sales_activity_weekly", agencyId || "none"],
    async () => {
      if (!agencyId) return [];
      const { data, error } = await supabase
        .from("v_sales_activity_weekly_by_producer")
        .select("*")
        .eq("agency_id", agencyId);
      if (error) {
        if (String(error?.message || "").match(/relation .* does not exist/i)) return [];
        throw error;
      }
      return data || [];
    },
    { enabled: !!agencyId }
  );
}

function useTimeTrackingWeekly(agencyId) {
  return useSupabaseQuery(
    ["v_time_tracking_weekly", agencyId || "none"],
    async () => {
      if (!agencyId) return [];
      const { data, error } = await supabase
        .from("v_time_tracking_weekly_by_producer")
        .select("*")
        .eq("agency_id", agencyId);
      if (error) {
        if (String(error?.message || "").match(/relation .* does not exist/i)) return [];
        throw error;
      }
      return data || [];
    },
    { enabled: !!agencyId }
  );
}

function useStaffRoster(agencyId) {
  return useSupabaseQuery(
    ["staff_roster", agencyId || "none"],
    async () => {
      if (!agencyId) return [];
      const { data, error } = await supabase
        .from("staff")
        .select("id, first_name, last_name, email, role, status")
        .eq("agency_id", agencyId)
        .eq("status", "active")
        .order("last_name", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    { enabled: !!agencyId }
  );
}

// =============================================================================
// Compute helpers — derive display state from view rows.
// =============================================================================

function computeCurrentMonthTotals(monthlyRows) {
  // v_sales_activity_monthly_by_producer is expected to have columns:
  // month_starting (DATE), producer_id, quote_issued_count, app_submitted_count,
  // bound_count, cross_sell_count, life_app_count, activity_total.
  // Sum across producers for current month.
  const cm = firstOfMonth(isoToday());
  const rows = (monthlyRows || []).filter(r => r.month_starting === cm);
  const acc = { quote: 0, app: 0, bound: 0, cross: 0, life: 0, total: 0 };
  for (const r of rows) {
    acc.quote += Number(r.quote_issued_count || 0);
    acc.app   += Number(r.app_submitted_count || 0);
    acc.bound += Number(r.bound_count || 0);
    acc.cross += Number(r.cross_sell_count || 0);
    acc.life  += Number(r.life_app_count || 0);
    acc.total += Number(r.activity_total || 0);
  }
  return acc;
}

function computeYoYForCurrentMonth(monthlyRows) {
  // Same month last year vs this year, sum across producers.
  const thisMonthStart = firstOfMonth(isoToday());
  const d = new Date(thisMonthStart + "T00:00:00");
  d.setFullYear(d.getFullYear() - 1);
  const lastYearMonthStart = d.toISOString().slice(0, 10);

  const filterMonth = (rows, iso) => rows.filter(r => r.month_starting === iso);
  const sumRow = (rows) => {
    const acc = { quote: 0, app: 0, bound: 0, cross: 0 };
    for (const r of rows) {
      acc.quote += Number(r.quote_issued_count || 0);
      acc.app   += Number(r.app_submitted_count || 0);
      acc.bound += Number(r.bound_count || 0);
      acc.cross += Number(r.cross_sell_count || 0);
    }
    return acc;
  };
  const thisYear = sumRow(filterMonth(monthlyRows || [], thisMonthStart));
  const lastYear = sumRow(filterMonth(monthlyRows || [], lastYearMonthStart));

  const hasLastYearData =
    lastYear.quote + lastYear.app + lastYear.bound + lastYear.cross > 0;

  return {
    thisYear, lastYear, hasLastYearData,
    thisMonthLabel:
      new Date(thisMonthStart + "T00:00:00").toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    lastYearLabel:
      new Date(lastYearMonthStart + "T00:00:00").toLocaleDateString(undefined, { month: "long", year: "numeric" }),
  };
}

function computeNudgeSalesHoursDropped(ttMonthlyRows) {
  // v_time_tracking_monthly_by_producer expected columns:
  // month_starting, producer_id, activity_category, total_hours.
  // We want: sum of total_hours WHERE activity_category='sales_activity', for
  // current month vs prior month (agency-wide, across all producers).
  const cm = firstOfMonth(isoToday());
  const pmDate = new Date(cm + "T00:00:00");
  pmDate.setMonth(pmDate.getMonth() - 1, 1);
  const pm = pmDate.toISOString().slice(0, 10);

  const sum = (iso) => (ttMonthlyRows || [])
    .filter(r => r.month_starting === iso && r.activity_category === "sales_activity")
    .reduce((acc, r) => acc + Number(r.total_hours || 0), 0);

  const thisMonth  = sum(cm);
  const priorMonth = sum(pm);

  const hasPriorData = priorMonth > 0.1;
  const drop = hasPriorData ? (priorMonth - thisMonth) / priorMonth : 0;

  return {
    thisMonth, priorMonth, hasPriorData,
    dropPct: Math.round(drop * 100),
    triggered: hasPriorData && drop >= 0.25,
    thisMonthLabel:
      new Date(cm + "T00:00:00").toLocaleDateString(undefined, { month: "long" }),
    priorMonthLabel:
      new Date(pm + "T00:00:00").toLocaleDateString(undefined, { month: "long" }),
  };
}

function computeLeaderboardRows(saWeeklyRows, ttWeeklyRows, roster, weekStartIso) {
  const iso = weekStartIso || firstOfMonth(isoToday());  // fallback
  const sa = (saWeeklyRows || []).filter(r => r.week_starting === iso);
  const tt = (ttWeeklyRows || []).filter(r => r.week_starting === iso);

  const byProducer = new Map();
  for (const staff of (roster || [])) {
    byProducer.set(staff.id, {
      producer_id: staff.id,
      name: nameOf(staff),
      role: staff.role,
      hours: 0,
      activity_total: 0,
      bound: 0,
      quote: 0,
    });
  }
  for (const r of sa) {
    const row = byProducer.get(r.producer_id);
    if (!row) continue;
    row.activity_total += Number(r.activity_total || 0);
    row.bound          += Number(r.bound_count    || 0);
    row.quote          += Number(r.quote_issued_count || 0);
  }
  for (const r of tt) {
    const row = byProducer.get(r.producer_id);
    if (!row) continue;
    row.hours += Number(r.total_hours || 0);
  }
  const rows = Array.from(byProducer.values());
  // Compute bind rate defensively
  for (const r of rows) {
    r.bind_rate = r.quote > 0 ? r.bound / r.quote : 0;
  }
  // Sort by activity_total DESC
  rows.sort((a, b) => (b.activity_total - a.activity_total) || (b.bound - a.bound));
  return rows;
}

function computeLOBMix(monthlyRows) {
  // Sum current-month LOB rows. v_sales_activity_monthly_by_producer is
  // aggregated by producer x month. Expected columns include per-LOB counts.
  // For portability, we do the LOB split from the *raw* activity table via
  // a follow-on query if needed; for now, if the view has by_lob columns,
  // use them, else return null (empty state).
  const cm = firstOfMonth(isoToday());
  const rows = (monthlyRows || []).filter(r => r.month_starting === cm);
  const acc = {};
  for (const lob of LOB_LIST) acc[lob] = 0;
  let anyLobCol = false;
  for (const r of rows) {
    for (const lob of LOB_LIST) {
      const colName = `activity_lob_${lob}_count`;
      if (Object.prototype.hasOwnProperty.call(r, colName)) {
        anyLobCol = true;
        acc[lob] += Number(r[colName] || 0);
      }
    }
  }
  if (!anyLobCol) return null;
  const total = Object.values(acc).reduce((a, b) => a + b, 0);
  return { total, byLob: acc };
}

function computePersonalGoalProgress(goal, monthlyRows, weeklyRows) {
  // Best-effort client-side actual computation for producer's own view.
  // Owner/manager Manage Goals modal calls fn_compute_goal_actual RPC for
  // authoritative numbers; here we approximate from cached view rows for
  // the personal card's progress bar.
  if (!goal) return 0;
  const rows = goal.producer_id
    ? (monthlyRows || []).filter(r => r.producer_id === goal.producer_id)
    : (monthlyRows || []);
  const inWindow = rows.filter(r =>
    r.month_starting >= goal.period_start && r.month_starting <= goal.period_end
  );
  let actual = 0;
  for (const r of inWindow) {
    switch (goal.goal_type) {
      case "total_binds":      actual += Number(r.bound_count || 0);          break;
      case "auto_binds":       actual += Number(r.bound_auto_count  || 0);    break;
      case "fire_binds":       actual += Number(r.bound_fire_count  || 0);    break;
      case "life_binds":       actual += Number(r.bound_life_count  || 0);    break;
      case "cross_sells":      actual += Number(r.cross_sell_count  || 0);    break;
      case "auto_quotes":      actual += Number(r.quote_auto_count  || 0);    break;
      case "fire_quotes":      actual += Number(r.quote_fire_count  || 0);    break;
      case "life_apps":        actual += Number(r.life_app_count    || 0);    break;
      case "fs_referrals":     actual += Number(r.fs_referral_count || 0);    break;
      case "total_activities": actual += Number(r.activity_total    || 0);    break;
      default: break;
    }
  }
  return actual;
}

// =============================================================================
// Small UI primitives
// =============================================================================

function AnimatedProgressBar({ pct: pctVal, tone = "teal", height = 10, showLabel = true }) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setWidth(Math.max(0, Math.min(100, pctVal || 0))));
    return () => cancelAnimationFrame(id);
  }, [pctVal]);
  const toneClass = {
    teal:    "bg-teal-500",
    coral:   "bg-orange-500",
    gold:    "bg-yellow-500",
    emerald: "bg-emerald-500",
    blue:    "bg-blue-500",
    amber:   "bg-amber-500",
    gray:    "bg-gray-500",
  }[tone] || "bg-teal-500";
  return (
    <div className="w-full">
      <div className="w-full bg-gray-200 rounded-full overflow-hidden" style={{ height: `${height}px` }}>
        <div
          className={cn("h-full rounded-full transition-all duration-700 ease-out", toneClass)}
          style={{ width: `${width}%` }}
        />
      </div>
      {showLabel && (
        <div className="mt-1 text-xs text-gray-500 tabular-nums">{Math.round(width)}%</div>
      )}
    </div>
  );
}

function ScoreboardStatTile({ label, value, subtitle, tone = "teal", animate = true }) {
  const numeric = typeof value === "number" ? value : null;
  const animatedValue = useCountUp(numeric || 0, 600);
  const display = numeric !== null && animate ? animatedValue : value;
  const toneRing = {
    teal:    "ring-teal-100 bg-teal-50",
    coral:   "ring-orange-100 bg-orange-50",
    gold:    "ring-yellow-100 bg-yellow-50",
    emerald: "ring-emerald-100 bg-emerald-50",
    blue:    "ring-blue-100 bg-blue-50",
    amber:   "ring-amber-100 bg-amber-50",
    gray:    "ring-gray-100 bg-gray-50",
  }[tone] || "ring-teal-100 bg-teal-50";
  return (
    <div className={cn("rounded-xl p-4 ring-1", toneRing)}>
      <div className="text-xs font-medium text-gray-600 uppercase tracking-wide">{label}</div>
      <div className="mt-1 text-3xl font-bold text-gray-900 tabular-nums">{display}</div>
      {subtitle && <div className="mt-1 text-xs text-gray-500">{subtitle}</div>}
    </div>
  );
}

function Pill({ children, tone = "gray" }) {
  const cls = {
    teal:    "bg-teal-100 text-teal-800",
    coral:   "bg-orange-100 text-orange-800",
    gold:    "bg-yellow-100 text-yellow-800",
    emerald: "bg-emerald-100 text-emerald-800",
    blue:    "bg-blue-100 text-blue-800",
    amber:   "bg-amber-100 text-amber-800",
    gray:    "bg-gray-100 text-gray-800",
  }[tone] || "bg-gray-100 text-gray-800";
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", cls)}>
      {children}
    </span>
  );
}

// =============================================================================
// WelcomeHeroTile — rotates through celebrations, else default welcome.
// =============================================================================

function WelcomeHeroTile({ profile, celebrations }) {
  const [idx, setIdx] = useState(0);
  const [fade, setFade] = useState(true);
  const list = celebrations || [];

  useEffect(() => {
    if (list.length <= 1) return;
    const interval = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setIdx(i => (i + 1) % list.length);
        setFade(true);
      }, 300);
    }, 5000);
    return () => clearInterval(interval);
  }, [list.length]);

  const firstName = profile?.data?.first_name || "there";

  if (!list.length) {
    return (
      <div className="rounded-2xl bg-gradient-to-br from-teal-500 via-teal-600 to-emerald-600 p-6 md:p-8 text-white shadow-lg">
        <div className="text-sm font-medium opacity-90 uppercase tracking-wide">Scoreboard</div>
        <div className="mt-2 text-2xl md:text-3xl font-bold">
          Welcome back, {firstName}.
        </div>
        <div className="mt-2 text-white/90 max-w-2xl">
          Log some activity and hours — as the numbers come in, this is where the wins will show up.
        </div>
      </div>
    );
  }

  const current = list[idx] || list[0];
  const style = CELEBRATION_STYLES[current?.type] || { emoji: "🎉", tone: "teal" };
  const toneGrad = {
    gold:    "from-yellow-500 via-amber-500 to-orange-500",
    teal:    "from-teal-500 via-teal-600 to-cyan-600",
    emerald: "from-emerald-500 via-green-500 to-teal-500",
    blue:    "from-blue-500 via-indigo-500 to-purple-500",
    coral:   "from-orange-500 via-red-500 to-pink-500",
  }[style.tone] || "from-teal-500 via-teal-600 to-cyan-600";

  return (
    <div className={cn("rounded-2xl bg-gradient-to-br p-6 md:p-8 text-white shadow-lg transition-opacity duration-300", toneGrad, fade ? "opacity-100" : "opacity-0")}>
      <div className="flex items-start gap-4">
        <div className="text-4xl md:text-5xl">{style.emoji}</div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium opacity-90 uppercase tracking-wide">
            {list.length > 1 ? `Celebration ${idx + 1} of ${list.length}` : "Today"}
          </div>
          <div className="mt-1 text-2xl md:text-3xl font-bold">{current.message}</div>
          {current.data?.actual !== undefined && (
            <div className="mt-2 text-white/90 text-sm">
              {current.data.actual} of {current.data.target} — {humanGoalTypeLabel(current.data.goal_type)}, {current.data.goal_period}
            </div>
          )}
          {current.data?.lobs && Array.isArray(current.data.lobs) && current.data.lobs.length > 0 && (
            <div className="mt-2 flex gap-1 flex-wrap">
              {current.data.lobs.map((lob, i) => (
                <span key={i} className="inline-flex items-center rounded-full bg-white/20 px-2 py-0.5 text-xs font-medium">
                  {LOB_LABEL[lob] || lob}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {list.length > 1 && (
        <div className="mt-4 flex gap-1.5">
          {list.map((_, i) => (
            <div key={i} className={cn("h-1.5 rounded-full transition-all", i === idx ? "w-8 bg-white" : "w-1.5 bg-white/40")} />
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// PersonalGoalCard — animated progress bar + days remaining
// =============================================================================

function PersonalGoalCard({ goal, actual }) {
  const p = pct(actual, goal.target_value);
  const daysLeft = daysLeftInPeriod(goal.period_end);
  const isHit = actual >= goal.target_value;
  const nearHit = !isHit && p >= 90;
  const tone = isHit ? "gold" : nearHit ? "emerald" : "teal";
  return (
    <div className={cn("rounded-xl bg-white p-4 border shadow-sm", isHit && "ring-2 ring-yellow-400")}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-gray-900">
            {humanGoalTypeLabel(goal.goal_type)}
            {goal.producer_id ? null : <span className="ml-2 text-xs text-gray-500 font-normal">team goal</span>}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {goal.goal_period} · {fmtDateShort(goal.period_start)} — {fmtDateShort(goal.period_end)}
          </div>
        </div>
        {isHit && <Pill tone="gold">🎯 hit!</Pill>}
        {nearHit && <Pill tone="emerald">🔥 close</Pill>}
      </div>
      <div className="mt-3 flex items-baseline gap-1 tabular-nums">
        <span className="text-2xl font-bold text-gray-900">{actual}</span>
        <span className="text-sm text-gray-500">/ {goal.target_value}</span>
      </div>
      <div className="mt-2">
        <AnimatedProgressBar pct={p} tone={tone} />
      </div>
      <div className="mt-1 text-xs text-gray-500">
        {daysLeft > 0 ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} left in period` : "period ends today"}
      </div>
      {goal.notes && (
        <div className="mt-2 text-xs italic text-gray-600 border-l-2 border-gray-200 pl-2">
          {goal.notes}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// OfficeTotalsTiles — agency-wide aggregate for current month (shared board,
// no per-producer names — this is the team's shared "game board").
// =============================================================================

function OfficeTotalsTiles({ monthlyRows }) {
  const totals = useMemo(() => computeCurrentMonthTotals(monthlyRows), [monthlyRows]);
  return (
    <div>
      <SectionHeader title="This month — team totals" subtitle="Everyone contributes." />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
        <ScoreboardStatTile label="Quotes"      value={totals.quote} tone="teal"    />
        <ScoreboardStatTile label="Applications" value={totals.app}  tone="blue"    />
        <ScoreboardStatTile label="Bound"       value={totals.bound} tone="gold"    />
        <ScoreboardStatTile label="Cross-sells" value={totals.cross} tone="emerald" />
      </div>
    </div>
  );
}

// =============================================================================
// AnnouncementsStrip — read-only for all agency staff (auto-hide by window).
// =============================================================================

function AnnouncementsStrip({ announcements }) {
  const list = announcements || [];
  if (list.length === 0) return null;
  return (
    <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
      <div className="text-xs font-medium text-amber-900 uppercase tracking-wide mb-2">
        📣 From leadership
      </div>
      <div className="space-y-2">
        {list.slice(0, 3).map(a => (
          <div key={a.id} className="text-sm text-amber-900">
            {a.body}
            {a.ends_at && (
              <span className="ml-2 text-xs text-amber-700">
                (until {fmtDateShort(a.ends_at.slice(0, 10))})
              </span>
            )}
          </div>
        ))}
        {list.length > 3 && (
          <div className="text-xs text-amber-700">+ {list.length - 3} more</div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// ProducerLeaderboard (owner + gated-manager surface) — real names, real
// numbers, sortable columns. Weekly view.
// =============================================================================

function ProducerLeaderboard({ saWeeklyRows, ttWeeklyRows, roster }) {
  const [sortKey, setSortKey] = useState("activity_total");
  const rows = useMemo(() => {
    // Use the most recent week represented in the SA weekly rows.
    const iso = (() => {
      const weeks = new Set((saWeeklyRows || []).map(r => r.week_starting));
      const sorted = Array.from(weeks).sort();
      return sorted[sorted.length - 1] || null;
    })();
    return computeLeaderboardRows(saWeeklyRows, ttWeeklyRows, roster, iso);
  }, [saWeeklyRows, ttWeeklyRows, roster]);

  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      if (sortKey === "bind_rate") return (b.bind_rate - a.bind_rate) || (b.bound - a.bound);
      return (b[sortKey] || 0) - (a[sortKey] || 0);
    });
    return arr;
  }, [rows, sortKey]);

  if (!sorted.length) {
    return (
      <div>
        <SectionHeader title="Producer leaderboard — this week" />
        <EmptyState message="No producer activity for this week yet." />
      </div>
    );
  }

  const Header = ({ col, label, align = "right" }) => (
    <th
      className={cn(
        "text-xs font-medium text-gray-600 uppercase tracking-wide px-3 py-2 cursor-pointer hover:text-teal-700 select-none",
        align === "right" ? "text-right" : "text-left",
        sortKey === col && "text-teal-700 underline decoration-dotted"
      )}
      onClick={() => setSortKey(col)}
    >
      {label}
    </th>
  );

  return (
    <div>
      <SectionHeader title="Producer leaderboard — this week" subtitle="Click a column to sort." />
      <div className="mt-3 rounded-xl border overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <Header col="name" label="Producer" align="left" />
              <Header col="hours" label="Hours" />
              <Header col="activity_total" label="Activity" />
              <Header col="quote" label="Quotes" />
              <Header col="bound" label="Bound" />
              <Header col="bind_rate" label="Bind rate" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map((r, i) => (
              <tr key={r.producer_id} className={i === 0 ? "bg-yellow-50/60" : ""}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    {i === 0 && <span title="Top of the board">🥇</span>}
                    {i === 1 && <span title="Second">🥈</span>}
                    {i === 2 && <span title="Third">🥉</span>}
                    <span className={i < 3 ? "font-semibold text-gray-900" : "text-gray-800"}>{r.name}</span>
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">{r.hours.toFixed(1)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-900 font-medium">{r.activity_total}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">{r.quote}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-900 font-medium">{r.bound}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                  {r.quote > 0 ? `${Math.round(r.bind_rate * 100)}%` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// =============================================================================
// NudgeTile (owner + gated-manager surface) — sales-activity HOURS dropped
// 25%+ vs last month. Distinct signal from SA nudge (activity drop).
// =============================================================================

function NudgeTile({ ttMonthlyRows }) {
  const nudge = useMemo(() => computeNudgeSalesHoursDropped(ttMonthlyRows), [ttMonthlyRows]);
  if (!nudge.triggered) return null;
  return (
    <div className="rounded-xl bg-orange-50 border border-orange-200 p-4">
      <div className="flex items-start gap-3">
        <div className="text-2xl">🧭</div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-orange-900">
            Team sales hours are down {nudge.dropPct}% vs {nudge.priorMonthLabel}
          </div>
          <div className="mt-1 text-sm text-orange-800">
            {nudge.thisMonth.toFixed(0)} hours logged to <em>sales_activity</em> this {nudge.thisMonthLabel} vs {nudge.priorMonth.toFixed(0)} last month.
            Activity output may be steady, but the input hours are dropping — worth a look at where the team's coaching-time has gone.
          </div>
          <div className="mt-2">
            <AskClaudeButton
              label="Ask Claude why sales hours are down"
              prompt={`Team sales-activity hours are down ${nudge.dropPct}% vs last month (${nudge.thisMonth.toFixed(0)} vs ${nudge.priorMonth.toFixed(0)}). Break it down by producer, compare each producer's hours-per-activity ratio, and tell me who's shifted their time to non-sales categories and by how much.`}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// YoYTile (owner + gated-manager surface) — same period last year.
// =============================================================================

function YoYTile({ monthlyRows }) {
  const yoy = useMemo(() => computeYoYForCurrentMonth(monthlyRows), [monthlyRows]);
  if (!yoy.hasLastYearData) {
    return (
      <div className="rounded-xl bg-white p-4 border">
        <div className="text-xs font-medium text-gray-600 uppercase tracking-wide">Year-over-year</div>
        <div className="mt-2 text-sm text-gray-500">
          Not enough history yet — this tile activates once you have 12 months of Sales Activity data.
        </div>
      </div>
    );
  }
  const row = ({ label, ty, ly, tone }) => {
    const delta = ly > 0 ? Math.round(((ty - ly) / ly) * 100) : null;
    const dir = delta === null ? "" : delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
    return (
      <div className="flex items-center justify-between text-sm py-1">
        <span className="text-gray-700">{label}</span>
        <span className="tabular-nums text-gray-900">
          <span className="font-semibold">{ty}</span>
          <span className="text-gray-400 mx-1">vs</span>
          <span className="text-gray-600">{ly}</span>
          {delta !== null && (
            <Pill tone={delta > 0 ? "emerald" : delta < 0 ? "coral" : "gray"}>
              {dir} {Math.abs(delta)}%
            </Pill>
          )}
        </span>
      </div>
    );
  };
  return (
    <div className="rounded-xl bg-white p-4 border">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium text-gray-600 uppercase tracking-wide">Year-over-year</div>
        <div className="text-xs text-gray-500">{yoy.thisMonthLabel} vs {yoy.lastYearLabel}</div>
      </div>
      <div className="space-y-1">
        {row({ label: "Quotes",       ty: yoy.thisYear.quote, ly: yoy.lastYear.quote })}
        {row({ label: "Applications", ty: yoy.thisYear.app,   ly: yoy.lastYear.app   })}
        {row({ label: "Bound",        ty: yoy.thisYear.bound, ly: yoy.lastYear.bound })}
        {row({ label: "Cross-sells",  ty: yoy.thisYear.cross, ly: yoy.lastYear.cross })}
      </div>
    </div>
  );
}

// =============================================================================
// TeamLOBMix — only shown if the SA monthly view exposes per-LOB counts.
// =============================================================================

function TeamLOBMix({ monthlyRows }) {
  const mix = useMemo(() => computeLOBMix(monthlyRows), [monthlyRows]);
  if (!mix || mix.total === 0) return null;
  return (
    <div className="rounded-xl bg-white p-4 border">
      <div className="text-xs font-medium text-gray-600 uppercase tracking-wide">Team activity mix (this month)</div>
      <div className="mt-3 space-y-2">
        {LOB_LIST.map(lob => {
          const c = mix.byLob[lob] || 0;
          const p = mix.total > 0 ? Math.round((c / mix.total) * 100) : 0;
          return (
            <div key={lob}>
              <div className="flex justify-between text-xs text-gray-700">
                <span>{LOB_LABEL[lob]}</span>
                <span className="tabular-nums">{c} · {p}%</span>
              </div>
              <AnimatedProgressBar pct={p} tone={LOB_TONE[lob]} height={6} showLabel={false} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// Modal — shared shell
// =============================================================================

function ModalShell({ open, onClose, title, children, wide = false }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 pb-8 px-4 overflow-y-auto bg-black/40 backdrop-blur-sm">
      <div
        className={cn(
          "bg-white rounded-2xl shadow-2xl w-full",
          wide ? "max-w-4xl" : "max-w-2xl"
        )}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

function PIILintWarning({ text }) {
  const hits = scanPII(text);
  if (!hits.length) return null;
  return (
    <div className="mt-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
      ⚠ Detected possible PII: {hits.map(h => `${h.name} × ${h.count}`).join(", ")}. Please remove anything customer-identifiable before saving.
    </div>
  );
}

// =============================================================================
// ManageGoalsModal — owner + gated-manager surface. Full CRUD on
// scoreboard_goals for this agency. Live progress via fn_compute_goal_actual.
// =============================================================================

function ManageGoalsModal({ open, onClose, agencyId, goals, roster, onChange }) {
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const active = (goals || []).filter(g => g.is_active !== false);

  async function toggleGoalActive(goal, next) {
    setBusy(true); setError(null);
    try {
      const { error } = await supabase
        .from("scoreboard_goals")
        .update({ is_active: next })
        .eq("id", goal.id);
      if (error) throw error;
      onChange && onChange();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteGoal(goal) {
    if (!window.confirm(`Delete "${humanGoalTypeLabel(goal.goal_type)}" goal? History will be lost.`)) return;
    setBusy(true); setError(null);
    try {
      const { error } = await supabase
        .from("scoreboard_goals")
        .delete()
        .eq("id", goal.id);
      if (error) throw error;
      onChange && onChange();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell open={open} onClose={onClose} title="Manage goals" wide>
      {error && (
        <div className="mb-3 rounded bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm text-gray-600">
          {active.length} active goal{active.length === 1 ? "" : "s"}
        </div>
        {!creating && (
          <button
            className="rounded-lg bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 text-sm font-medium"
            onClick={() => setCreating(true)}
          >
            + New goal
          </button>
        )}
      </div>

      {creating && (
        <GoalCreateForm
          agencyId={agencyId}
          roster={roster}
          onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); onChange && onChange(); }}
        />
      )}

      <div className="mt-3 divide-y divide-gray-100 rounded-xl border">
        {active.length === 0 && !creating && (
          <div className="p-6 text-center text-sm text-gray-500">
            No active goals yet. Add one to start tracking progress.
          </div>
        )}
        {active.map(g => (
          <GoalRow
            key={g.id}
            goal={g}
            roster={roster}
            busy={busy}
            onArchive={() => toggleGoalActive(g, false)}
            onDelete={() => deleteGoal(g)}
          />
        ))}
      </div>
    </ModalShell>
  );
}

function GoalRow({ goal, roster, busy, onArchive, onDelete }) {
  const [actual, setActual] = useState(null);
  const [loadingActual, setLoadingActual] = useState(false);
  const staff = (roster || []).find(s => s.id === goal.producer_id);

  useEffect(() => {
    let cancelled = false;
    setLoadingActual(true);
    supabase
      .rpc("fn_compute_goal_actual", { p_goal_id: goal.id })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setActual(null);
        } else {
          setActual(Number(data || 0));
        }
        setLoadingActual(false);
      });
    return () => { cancelled = true; };
  }, [goal.id]);

  const p = actual !== null ? pct(actual, goal.target_value) : 0;
  const hit = actual !== null && actual >= goal.target_value;

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-900">{humanGoalTypeLabel(goal.goal_type)}</span>
            <Pill tone={goal.producer_id ? "blue" : "amber"}>
              {goal.producer_id ? nameOf(staff) : "team-wide"}
            </Pill>
            <Pill tone="gray">{goal.goal_period}</Pill>
            {hit && <Pill tone="gold">🎯 hit</Pill>}
          </div>
          <div className="mt-1 text-xs text-gray-500">
            {fmtDate(goal.period_start)} — {fmtDate(goal.period_end)}
          </div>
          {goal.notes && (
            <div className="mt-1 text-xs italic text-gray-600">{goal.notes}</div>
          )}
          <div className="mt-2 flex items-baseline gap-1 tabular-nums">
            {loadingActual ? (
              <span className="text-sm text-gray-500">Loading…</span>
            ) : (
              <>
                <span className="text-xl font-bold text-gray-900">{actual === null ? "?" : actual}</span>
                <span className="text-sm text-gray-500">/ {goal.target_value}</span>
              </>
            )}
          </div>
          <div className="mt-1 max-w-xs">
            <AnimatedProgressBar pct={p} tone={hit ? "gold" : "teal"} showLabel={false} />
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            className="text-xs rounded border border-gray-300 hover:bg-gray-50 px-2 py-1"
            disabled={busy}
            onClick={onArchive}
          >
            Archive
          </button>
          <button
            className="text-xs rounded border border-red-300 text-red-700 hover:bg-red-50 px-2 py-1"
            disabled={busy}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function GoalCreateForm({ agencyId, roster, onCancel, onCreated }) {
  const [goalType, setGoalType] = useState("total_binds");
  const [goalPeriod, setGoalPeriod] = useState("monthly");
  const [producerId, setProducerId] = useState("");   // "" = team-wide
  const [targetValue, setTargetValue] = useState(10);
  const [notes, setNotes] = useState("");
  const [customDates, setCustomDates] = useState(false);
  const defaults = useMemo(() => periodBoundsForType(goalPeriod), [goalPeriod]);
  const [periodStart, setPeriodStart] = useState(defaults.period_start);
  const [periodEnd,   setPeriodEnd]   = useState(defaults.period_end);
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState(null);

  useEffect(() => {
    if (customDates) return;
    const b = periodBoundsForType(goalPeriod);
    setPeriodStart(b.period_start);
    setPeriodEnd(b.period_end);
  }, [goalPeriod, customDates]);

  async function save() {
    setSaving(true); setError(null);
    try {
      const payload = {
        agency_id: agencyId,
        producer_id: producerId || null,
        goal_period: goalPeriod,
        goal_type: goalType,
        target_value: Number(targetValue),
        period_start: periodStart,
        period_end: periodEnd,
        notes: notes.trim() || null,
        is_active: true,
      };
      if (payload.target_value <= 0) throw new Error("Target must be greater than zero.");
      if (payload.period_end <= payload.period_start) throw new Error("Period end must be after period start.");
      const { error } = await supabase.from("scoreboard_goals").insert([payload]);
      if (error) throw error;
      onCreated && onCreated();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border-2 border-teal-200 bg-teal-50/40 p-4 mb-3">
      <div className="font-semibold text-gray-900 mb-3">New goal</div>
      {error && (
        <div className="mb-3 rounded bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs font-medium text-gray-700 mb-1">Goal type</span>
          <select
            className="block w-full rounded-lg border-gray-300"
            value={goalType}
            onChange={e => setGoalType(e.target.value)}
          >
            {GOAL_TYPE_PRESETS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <span className="block mt-1 text-xs text-gray-500">
            {GOAL_TYPE_PRESETS.find(p => p.value === goalType)?.hint}
          </span>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-gray-700 mb-1">Period</span>
          <select
            className="block w-full rounded-lg border-gray-300"
            value={goalPeriod}
            onChange={e => setGoalPeriod(e.target.value)}
          >
            {GOAL_PERIODS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-gray-700 mb-1">Producer</span>
          <select
            className="block w-full rounded-lg border-gray-300"
            value={producerId}
            onChange={e => setProducerId(e.target.value)}
          >
            <option value="">Team-wide (agency aggregate)</option>
            {(roster || []).map(s => (
              <option key={s.id} value={s.id}>{nameOf(s)} — {s.role}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-gray-700 mb-1">Target</span>
          <input
            type="number"
            min="1"
            className="block w-full rounded-lg border-gray-300"
            value={targetValue}
            onChange={e => setTargetValue(e.target.value)}
          />
        </label>
      </div>
      <div className="mt-3">
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={customDates}
            onChange={e => setCustomDates(e.target.checked)}
          />
          Override period dates (default: current {goalPeriod} window)
        </label>
      </div>
      {customDates && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 mb-1">Start</span>
            <input type="date" className="block w-full rounded-lg border-gray-300" value={periodStart} onChange={e => setPeriodStart(e.target.value)} />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 mb-1">End</span>
            <input type="date" className="block w-full rounded-lg border-gray-300" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} />
          </label>
        </div>
      )}
      {!customDates && (
        <div className="mt-2 text-xs text-gray-500">
          Period: {fmtDate(periodStart)} — {fmtDate(periodEnd)}
        </div>
      )}
      <div className="mt-3">
        <label className="block">
          <span className="block text-xs font-medium text-gray-700 mb-1">Notes (optional, 200 char max)</span>
          <textarea
            className="block w-full rounded-lg border-gray-300"
            rows={2}
            maxLength={200}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. stretch goal for Q3 push"
          />
        </label>
        <PIILintWarning text={notes} />
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded-lg border border-gray-300 px-4 py-2 text-sm" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          className="rounded-lg bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 text-sm font-medium disabled:opacity-60"
          onClick={save}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save goal"}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// ManageAnnouncementsModal — owner + gated-manager surface.
// =============================================================================

function ManageAnnouncementsModal({ open, onClose, agencyId, staffId, announcements, onChange }) {
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function deleteAnnouncement(a) {
    if (!window.confirm("Delete this announcement? It will disappear for everyone.")) return;
    setBusy(true); setError(null);
    try {
      const { error } = await supabase.from("agency_announcements").delete().eq("id", a.id);
      if (error) throw error;
      onChange && onChange();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function endNow(a) {
    setBusy(true); setError(null);
    try {
      const { error } = await supabase
        .from("agency_announcements")
        .update({ ends_at: new Date().toISOString() })
        .eq("id", a.id);
      if (error) throw error;
      onChange && onChange();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell open={open} onClose={onClose} title="Manage announcements" wide>
      {error && (
        <div className="mb-3 rounded bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm text-gray-600">
          {(announcements || []).length} showing now
        </div>
        {!creating && (
          <button
            className="rounded-lg bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 text-sm font-medium"
            onClick={() => setCreating(true)}
          >
            + New announcement
          </button>
        )}
      </div>

      {creating && (
        <AnnouncementCreateForm
          agencyId={agencyId}
          staffId={staffId}
          onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); onChange && onChange(); }}
        />
      )}

      <div className="mt-3 divide-y divide-gray-100 rounded-xl border">
        {(announcements || []).length === 0 && !creating && (
          <div className="p-6 text-center text-sm text-gray-500">
            No current announcements. Add one to give the team a heads-up.
          </div>
        )}
        {(announcements || []).map(a => (
          <div key={a.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-900">{a.body}</div>
                <div className="mt-1 text-xs text-gray-500">
                  Showing {fmtDate((a.starts_at || "").slice(0, 10))}
                  {a.ends_at ? ` — ${fmtDate(a.ends_at.slice(0, 10))}` : " (no end date)"}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  className="text-xs rounded border border-gray-300 hover:bg-gray-50 px-2 py-1"
                  disabled={busy}
                  onClick={() => endNow(a)}
                >
                  End now
                </button>
                <button
                  className="text-xs rounded border border-red-300 text-red-700 hover:bg-red-50 px-2 py-1"
                  disabled={busy}
                  onClick={() => deleteAnnouncement(a)}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}

function AnnouncementCreateForm({ agencyId, staffId, onCancel, onCreated }) {
  const [body, setBody] = useState("");
  const [hasEnd, setHasEnd] = useState(true);
  const [endsAtDate, setEndsAtDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function save() {
    setSaving(true); setError(null);
    try {
      if (!body.trim()) throw new Error("Announcement body cannot be empty.");
      if (body.length > 500) throw new Error("Announcement too long (500 chars max).");
      const payload = {
        agency_id: agencyId,
        author_staff_id: staffId,
        body: body.trim(),
        starts_at: new Date().toISOString(),
        ends_at: hasEnd ? new Date(endsAtDate + "T23:59:59").toISOString() : null,
      };
      const { error } = await supabase.from("agency_announcements").insert([payload]);
      if (error) throw error;
      onCreated && onCreated();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  const charsLeft = 500 - body.length;

  return (
    <div className="rounded-xl border-2 border-teal-200 bg-teal-50/40 p-4 mb-3">
      <div className="font-semibold text-gray-900 mb-3">New announcement</div>
      {error && (
        <div className="mb-3 rounded bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}
      <label className="block">
        <span className="block text-xs font-medium text-gray-700 mb-1">Message ({charsLeft} chars left)</span>
        <textarea
          className="block w-full rounded-lg border-gray-300"
          rows={3}
          maxLength={500}
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="e.g. Reminder: office closed Monday for the holiday. Great work on hitting our monthly goal!"
        />
        <PIILintWarning text={body} />
      </label>
      <div className="mt-3">
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={hasEnd} onChange={e => setHasEnd(e.target.checked)} />
          Set an end date
        </label>
      </div>
      {hasEnd && (
        <div className="mt-2">
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 mb-1">Ends after</span>
            <input
              type="date"
              className="rounded-lg border-gray-300"
              value={endsAtDate}
              onChange={e => setEndsAtDate(e.target.value)}
            />
          </label>
          <div className="mt-1 text-xs text-gray-500">Announcement disappears at end of that day.</div>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded-lg border border-gray-300 px-4 py-2 text-sm" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          className="rounded-lg bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 text-sm font-medium disabled:opacity-60"
          onClick={save}
          disabled={saving || !body.trim()}
        >
          {saving ? "Posting…" : "Post announcement"}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// ProducerScoreboardView — the default surface for producers.
// =============================================================================

function ProducerScoreboardView({ profile, goals, announcements, celebrations, monthlyRows, weeklyRows }) {
  const myStaffId = profile?.data?.id;
  const myGoals = (goals || []).filter(g => g.producer_id === myStaffId);
  const teamGoals = (goals || []).filter(g => g.producer_id === null || g.producer_id === undefined);

  return (
    <div className="space-y-6">
      <WelcomeHeroTile profile={profile} celebrations={celebrations} />

      <AnnouncementsStrip announcements={announcements} />

      {myGoals.length > 0 && (
        <div>
          <SectionHeader title="Your goals" subtitle="Personal targets, live progress." />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
            {myGoals.map(g => (
              <PersonalGoalCard
                key={g.id}
                goal={g}
                actual={computePersonalGoalProgress(g, monthlyRows, weeklyRows)}
              />
            ))}
          </div>
        </div>
      )}

      {teamGoals.length > 0 && (
        <div>
          <SectionHeader title="Team goals" subtitle="Everyone plays." />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
            {teamGoals.map(g => (
              <PersonalGoalCard
                key={g.id}
                goal={g}
                actual={computePersonalGoalProgress(g, monthlyRows, weeklyRows)}
              />
            ))}
          </div>
        </div>
      )}

      {myGoals.length === 0 && teamGoals.length === 0 && (
        <EmptyState
          message="No active goals yet."
          hint="Once your owner sets goals in the Manage Goals modal, they'll show up here with live progress."
        />
      )}

      <OfficeTotalsTiles monthlyRows={monthlyRows} />
    </div>
  );
}

// =============================================================================
// OwnerScoreboardView — full team-visibility surface.
// =============================================================================

function OwnerScoreboardView({
  profile, agencyId, roster, goals, announcements, celebrations,
  saMonthly, ttMonthly, saWeekly, ttWeekly, onGoalsChange, onAnnouncementsChange,
}) {
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [annOpen, setAnnOpen]     = useState(false);
  const myStaffId = profile?.data?.id;

  return (
    <div className="space-y-6">
      <WelcomeHeroTile profile={profile} celebrations={celebrations} />

      <AnnouncementsStrip announcements={announcements} />

      <NudgeTile ttMonthlyRows={ttMonthly} />

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="rounded-lg bg-white border border-gray-300 hover:bg-gray-50 px-4 py-2 text-sm font-medium text-gray-800"
          onClick={() => setGoalsOpen(true)}
        >
          🎯 Manage goals
        </button>
        <button
          className="rounded-lg bg-white border border-gray-300 hover:bg-gray-50 px-4 py-2 text-sm font-medium text-gray-800"
          onClick={() => setAnnOpen(true)}
        >
          📣 Manage announcements
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <YoYTile monthlyRows={saMonthly} />
        <TeamLOBMix monthlyRows={saMonthly} />
      </div>

      <ProducerLeaderboard
        saWeeklyRows={saWeekly}
        ttWeeklyRows={ttWeekly}
        roster={roster}
      />

      <OfficeTotalsTiles monthlyRows={saMonthly} />

      {(goals || []).length > 0 && (
        <div>
          <SectionHeader title="All active goals" subtitle="Live progress from fn_compute_goal_actual." />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
            {goals.map(g => (
              <PersonalGoalCard
                key={g.id}
                goal={g}
                actual={computePersonalGoalProgress(g, saMonthly, saWeekly)}
              />
            ))}
          </div>
        </div>
      )}

      <ManageGoalsModal
        open={goalsOpen}
        onClose={() => setGoalsOpen(false)}
        agencyId={agencyId}
        goals={goals}
        roster={roster}
        onChange={onGoalsChange}
      />
      <ManageAnnouncementsModal
        open={annOpen}
        onClose={() => setAnnOpen(false)}
        agencyId={agencyId}
        staffId={myStaffId}
        announcements={announcements}
        onChange={onAnnouncementsChange}
      />
    </div>
  );
}

// =============================================================================
// Scoreboard — main component, role split.
// =============================================================================

export default function Scoreboard() {
  const profile = useMyProfile();
  const agencyId = profile?.data?.agency_id;
  const myStaffId = profile?.data?.id;
  const role = profile?.data?.role;

  const isOwner = role === "Owner / Agent";
  const isManagerRole = role === "Office Manager";
  const [managerGateOn, setManagerGateOn] = useState(false);

  // Check the manager gate setting client-side too (belt-and-suspenders — RLS
  // is the authoritative filter). Owner is always full-access regardless.
  useEffect(() => {
    if (!agencyId || !isManagerRole) return;
    supabase
      .from("settings")
      .select("setting_value")
      .eq("agency_id", agencyId)
      .eq("setting_key", "enable_scoreboard_manager_access")
      .maybeSingle()
      .then(({ data }) => {
        setManagerGateOn(String(data?.setting_value || "").toLowerCase() === "true");
      });
  }, [agencyId, isManagerRole]);

  const seeTeam = isOwner || (isManagerRole && managerGateOn);

  const goalsQ         = useScoreboardGoals(agencyId);
  const annQ           = useAnnouncements(agencyId);
  const celebQ         = useCelebrations(myStaffId);
  const rosterQ        = useStaffRoster(agencyId);
  const saMonthlyQ     = useSalesActivityMonthly(agencyId, seeTeam ? null : myStaffId);
  const ttMonthlyQ     = useTimeTrackingMonthly(agencyId);
  const saWeeklyQ      = useSalesActivityWeekly(agencyId);
  const ttWeeklyQ      = useTimeTrackingWeekly(agencyId);

  const anyLoading =
    profile?.isLoading || goalsQ?.isLoading || annQ?.isLoading || saMonthlyQ?.isLoading;

  if (profile?.isLoading) return <LoadingState label="Loading your Scoreboard…" />;
  if (!profile?.data)     return <EmptyState message="Sign in required." />;

  const refetchGoals = () => goalsQ?.refetch && goalsQ.refetch();
  const refetchAnn   = () => annQ?.refetch   && annQ.refetch();

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      {seeTeam ? (
        <OwnerScoreboardView
          profile={profile}
          agencyId={agencyId}
          roster={rosterQ?.data || []}
          goals={goalsQ?.data || []}
          announcements={annQ?.data || []}
          celebrations={celebQ?.data || []}
          saMonthly={saMonthlyQ?.data || []}
          ttMonthly={ttMonthlyQ?.data || []}
          saWeekly={saWeeklyQ?.data || []}
          ttWeekly={ttWeeklyQ?.data || []}
          onGoalsChange={refetchGoals}
          onAnnouncementsChange={refetchAnn}
        />
      ) : (
        <ProducerScoreboardView
          profile={profile}
          goals={goalsQ?.data || []}
          announcements={annQ?.data || []}
          celebrations={celebQ?.data || []}
          monthlyRows={saMonthlyQ?.data || []}
          weeklyRows={saWeeklyQ?.data || []}
        />
      )}
    </div>
  );
}
