// =============================================================================
// PTOPendingTile.jsx — Dashboard tile for pending PTO requests
// -----------------------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.1+ (Premium §4 PTO)
//
// Behavior:
//   * Producer role  -> shows count of OWN pending requests (RLS scopes)
//   * Owner / authorized manager -> shows count of ALL pending requests
//     (RLS grants when get_current_role_is_owner() OR is_pto_manager())
//
// The tile is intentionally count-only. Names/details never appear on the
// dashboard tile — that's what Producer Isolation Principle B.11 is about.
//
// Display convention (Phase 2, 2026-07-09):
//   Even though this tile only shows a count of requests (not hour amounts),
//   it stays visually consistent with the rest of the PTO surface which
//   displays in hours per the days-in-DB / hours-in-UI convention. See
//   src/lib/pto/format.js for the formatters used throughout PTO views.
//
// Props:
//   onNavigate — optional callback to navigate to the PTO module. If provided,
//                clicking the tile calls onNavigate(). If not, the tile still
//                renders but is non-clickable.
// =============================================================================

import { Calendar } from "lucide-react";
import { supabase } from "../lib/supabase.js";
import { useSupabaseQuery } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";

export default function PTOPendingTile({ onNavigate }) {
  if (!supabase) return null;

  const { data, loading, error } = useSupabaseQuery(
    () => supabase
      .from("pto_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    []
  );

  const count = data?.count ?? 0;

  // Render nothing when we have no data to show and nothing to warn about.
  // Keeps the dashboard uncluttered for producers with no pending items.
  if (!loading && !error && count === 0) {
    return null;
  }

  const clickable = typeof onNavigate === "function";

  return (
    <button
      type="button"
      onClick={clickable ? onNavigate : undefined}
      disabled={!clickable}
      className={cn(
        "if-card w-full text-left transition-shadow",
        clickable && "hover:shadow-md focus:outline-none focus:ring-2 focus:ring-if-navy/30"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-if-muted">
            <Calendar size={14} />
            <span>PTO — Pending</span>
          </div>
          <div className="mt-2 text-2xl font-semibold text-if-navy">
            {loading ? <span className="text-if-muted text-base">…</span> : (error ? "—" : count)}
          </div>
          <div className="mt-1 text-xs text-if-muted">
            {error
              ? "Couldn't load pending count"
              : count === 1
                ? "1 request awaiting decision"
                : `${count} requests awaiting decision`}
          </div>
        </div>
      </div>
    </button>
  );
}
