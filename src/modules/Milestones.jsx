// =============================================================================
// Milestones.jsx — Upcoming staff milestones + acknowledgment
// -----------------------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.2 (Premium §4.9 Module 09)
//
// Routing: BCCApp.jsx dispatches nav id "milestones" to this component for
// owner, manager, and staff roles. All three can view the upcoming
// milestones list (this is a public-recognition surface, not a PII one).
// Only owner and (with the enable_milestones_manager_access toggle) manager
// can acknowledge — the underlying rpc_acknowledge_milestone RPC enforces.
//
// Producer Isolation Principle B.11:
//   • Read: relaxed for THIS module — everyone sees team milestones
//     (birthdays/anniversaries are public-recognition events). Documented
//     as a considered relaxation of B.11 in migration 112.
//   • Write (acknowledgment): owner unconditionally, manager only when
//     is_milestones_manager() = true.
//
// Data sources:
//   • v_upcoming_milestones — computed view (next 60 days), joins to
//     acknowledgment log
//   • rpc_acknowledge_milestone(staff_id, milestone_type, milestone_date,
//     notes) — write path
//
// Ask Claude buttons: seeded per spec §4.9 in Base's PlaybookGuide.jsx —
// this file surfaces them via the shared AskClaudeButton component but
// does not duplicate the prompt text (single source of truth in Base).
// =============================================================================

import { useState, useMemo } from "react";
import { Gift, Calendar, Award, Check, X } from "lucide-react";

import { supabase } from "../lib/supabase.js";
import { useSupabaseQuery } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";

import SectionHeader from "../components/SectionHeader.jsx";
import StatCard from "../components/StatCard.jsx";
import EmptyState from "../components/EmptyState.jsx";
import LoadingState from "../components/LoadingState.jsx";
import AskClaudeButton from "../components/AskClaudeButton.jsx";

// -----------------------------------------------------------------------------
// File-local helpers
// -----------------------------------------------------------------------------
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
}

function fmtDaysUntil(n) {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  if (Number.isNaN(num)) return "—";
  if (num === 0) return "Today";
  if (num === 1) return "Tomorrow";
  if (num < 0) return `${Math.abs(num)} day${Math.abs(num) === 1 ? "" : "s"} ago`;
  return `In ${num} days`;
}

function milestoneIcon(type, isService) {
  if (type === "birthday") return Gift;
  if (isService) return Award;
  return Calendar;
}

function milestoneLabel(row) {
  if (row.milestone_type === "birthday") return "Birthday";
  if (row.is_service_milestone) return `${row.years_of_service}-year service milestone`;
  if (row.milestone_type === "work_anniversary") {
    return `${row.years_of_service}-year work anniversary`;
  }
  return "Milestone";
}

// =============================================================================
// Main component
// =============================================================================
export default function Milestones() {
  const upcomingQuery = useSupabaseQuery(
    () => supabase
      .from("v_upcoming_milestones")
      .select("*")
      .order("milestone_date", { ascending: true }),
    []
  );

  const rows = upcomingQuery.data || [];

  const summary = useMemo(() => {
    const now = new Date();
    const yearStart = new Date(now.getFullYear(), 0, 1);
    return {
      total: rows.length,
      thisMonth: rows.filter((r) => {
        const d = new Date(r.milestone_date + "T00:00:00");
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      }).length,
      unacknowledgedPast: rows.filter((r) => r.days_until < 0 && !r.acknowledged).length,
    };
  }, [rows]);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Milestones"
        description="Birthdays, work anniversaries, and service milestones for the next 60 days. Acknowledge each one to record recognition."
        actions={
          rows.length > 0 && (
            <AskClaudeButton
              moduleLabel="Milestones"
              subject="upcoming staff milestones"
              context={{ upcoming: rows }}
              suggestedPrompt="Review this month's upcoming milestones and help me plan recognition — who needs a card, who deserves a callout in the next team huddle, and anyone I might have missed."
            />
          )
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label="Upcoming (next 60 days)"
          value={summary.total}
          loading={upcomingQuery.loading}
          icon={Calendar}
        />
        <StatCard
          label="This month"
          value={summary.thisMonth}
          loading={upcomingQuery.loading}
        />
        <StatCard
          label="Recent — unacknowledged"
          value={summary.unacknowledgedPast}
          tone={summary.unacknowledgedPast > 0 ? "warning" : "neutral"}
          loading={upcomingQuery.loading}
        />
      </div>

      <MilestonesList
        rows={rows}
        loading={upcomingQuery.loading}
        error={upcomingQuery.error}
        onChanged={() => upcomingQuery.refresh && upcomingQuery.refresh()}
      />
    </div>
  );
}

// =============================================================================
// MilestonesList — the timeline of upcoming rows
// =============================================================================
function MilestonesList({ rows, loading, error, onChanged }) {
  if (loading) return <LoadingState message="Loading upcoming milestones…" rows={4} />;
  if (error) {
    return (
      <div className="if-card border-red-200 bg-red-50/40">
        <div className="text-red-700 text-sm font-medium">Couldn't load milestones.</div>
        <div className="text-red-700/80 text-xs mt-1">{String(error.message || error)}</div>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Gift}
        title="No upcoming milestones"
        description="Nothing in the next 60 days. Add hire dates and birthdays in HR & People to have milestones surface here."
      />
    );
  }

  return (
    <div className="if-card divide-y divide-if-line/60 p-0">
      {rows.map((r) => (
        <MilestoneRow key={`${r.staff_id}-${r.milestone_type}-${r.milestone_date}`}
          row={r} onChanged={onChanged} />
      ))}
    </div>
  );
}

// =============================================================================
// MilestoneRow — one milestone event with acknowledge action
// =============================================================================
function MilestoneRow({ row, onChanged }) {
  const [ackOpen, setAckOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const Icon = milestoneIcon(row.milestone_type, row.is_service_milestone);
  const label = milestoneLabel(row);
  const isPast = row.days_until < 0;
  const isSoon = row.days_until >= 0 && row.days_until <= 7;

  async function acknowledge() {
    setSaving(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc("rpc_acknowledge_milestone", {
        p_staff_id: row.staff_id,
        p_milestone_type: row.milestone_type,
        p_milestone_date: row.milestone_date,
        p_notes: notes.trim() || null,
      });
      if (rpcError) throw rpcError;
      setAckOpen(false);
      setNotes("");
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className={cn(
            "rounded-full p-2",
            row.milestone_type === "birthday" && "bg-pink-100 text-pink-700",
            row.is_service_milestone && "bg-amber-100 text-amber-700",
            !row.is_service_milestone && row.milestone_type === "work_anniversary" && "bg-blue-100 text-blue-700"
          )}>
            <Icon size={18} />
          </div>
          <div>
            <div className="text-if-navy font-medium">{row.full_name}</div>
            <div className="text-sm text-if-muted">
              {label} · {fmtDate(row.milestone_date)}
            </div>
            {row.acknowledged && (
              <div className="text-xs text-emerald-700 mt-1 inline-flex items-center gap-1">
                <Check size={12} /> Acknowledged{row.acknowledgment_notes
                  ? ` — ${row.acknowledgment_notes}` : ""}
              </div>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className={cn(
            "text-xs font-medium",
            isSoon && !row.acknowledged && "text-amber-700",
            isPast && !row.acknowledged && "text-red-700"
          )}>
            {fmtDaysUntil(row.days_until)}
          </div>
          {!row.acknowledged && (
            <button
              type="button"
              className="if-button-ghost text-xs mt-1"
              onClick={() => setAckOpen(true)}
            >
              Acknowledge
            </button>
          )}
        </div>
      </div>

      {ackOpen && (
        <div className="mt-3 border-t border-if-line pt-3 space-y-2">
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
              Note (optional — how you recognized them)
            </span>
            <input
              className="if-input"
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Called out in Monday standup"
              maxLength={200}
            />
          </label>
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
              {error}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              className="if-button-ghost text-xs"
              onClick={() => { setAckOpen(false); setNotes(""); setError(null); }}
              disabled={saving}
            >
              <X size={14} className="inline mr-1" /> Cancel
            </button>
            <button
              type="button"
              className="if-button text-xs"
              onClick={acknowledge}
              disabled={saving}
            >
              <Check size={14} className="inline mr-1" />
              {saving ? "Saving…" : "Record acknowledgment"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
