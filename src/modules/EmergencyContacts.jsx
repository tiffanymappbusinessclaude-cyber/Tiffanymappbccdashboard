// =============================================================================
// EmergencyContacts.jsx — Owner / Manager reveal flow with mandatory audit
// -----------------------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.3 (Premium §4.10 Module 10)
//
// Routing: BCCApp.jsx dispatches nav id "emergency_contacts" to this
// component for owner and manager roles. Producers get EmergencyContactsMine
// instead. Router snippet:
//
//   case "emergency_contacts":
//     return currentUserRole === "owner" || currentUserRole === "manager"
//       ? <EmergencyContacts />
//       : <EmergencyContactsMine />;
//
// Data access is DIFFERENT here vs. Licenses/Milestones. Direct SELECT on
// public.emergency_contacts is blocked at the RLS layer for owner and
// manager — the only way to see a producer's contacts is through the
// SECURITY DEFINER RPC rpc_reveal_emergency_contacts, which:
//   1. requires a written reason (min 5 chars)
//   2. writes an audit row to emergency_contact_access_log BEFORE returning
//   3. returns the rows atomically
//
// No AskClaudeButton on this module — by design (spec §4.10). Emergency
// contact data must not flow through Claude conversations.
// =============================================================================

import { useState, useEffect } from "react";
import { PhoneCall, Users, ShieldAlert, History, X, Eye, Mail } from "lucide-react";

import { supabase } from "../lib/supabase.js";
import { useSupabaseQuery } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";

import SectionHeader from "../components/SectionHeader.jsx";
import StatCard from "../components/StatCard.jsx";
import EmptyState from "../components/EmptyState.jsx";
import LoadingState from "../components/LoadingState.jsx";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const RELATIONSHIP_LABEL = {
  spouse: "Spouse",
  parent: "Parent",
  sibling: "Sibling",
  child: "Child",
  friend: "Friend",
  other: "Other",
};

function fmtWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// =============================================================================
// Main component
// =============================================================================
export default function EmergencyContacts() {
  const [tab, setTab]           = useState("reveal");        // "reveal" | "log"
  const [revealFor, setRevealFor] = useState(null);          // staff row currently opened
  const [revealed, setRevealed] = useState(null);            // { rows, staffName, reason }

  const staffQuery = useSupabaseQuery(
    () => supabase
      .from("staff")
      .select("id, full_name, role, status, email, phone")
      .eq("status", "active")
      .order("full_name"),
    []
  );

  const logQuery = useSupabaseQuery(
    () => supabase
      .from("emergency_contact_access_log")
      .select("*")
      .order("accessed_at", { ascending: false })
      .limit(50),
    []
  );

  const staff = staffQuery.data || [];
  const log   = logQuery.data || [];

  // Recent-access counts by staff_id (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentCounts = log
    .filter((l) => new Date(l.accessed_at) >= thirtyDaysAgo)
    .reduce((acc, l) => {
      acc[l.accessed_staff_id] = (acc[l.accessed_staff_id] || 0) + 1;
      return acc;
    }, {});

  const summary = {
    teamSize: staff.length,
    recentAccesses: log.filter((l) => new Date(l.accessed_at) >= thirtyDaysAgo).length,
    totalReveals: log.length,
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Emergency Contacts"
        description="Reveal a team member's emergency contacts when there's a business or personal emergency. Every reveal is logged with your reason."
      />

      {/* Deliberate visible disclaimer — this is a PII surface */}
      <div className="if-card bg-amber-50/60 border-amber-200">
        <div className="flex items-start gap-3">
          <ShieldAlert className="text-amber-700 shrink-0 mt-0.5" size={20} />
          <div>
            <div className="text-sm font-medium text-amber-900">
              Contact data is not visible in Claude conversations.
            </div>
            <div className="text-xs text-amber-800/90 mt-1">
              Every reveal requires a written reason and is recorded in the access log for compliance review. Producers manage their own contacts in their personal view.
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Team members" value={summary.teamSize} icon={Users} loading={staffQuery.loading} />
        <StatCard label="Reveals in last 30 days" value={summary.recentAccesses} icon={History} loading={logQuery.loading} />
        <StatCard label="Total reveals recorded" value={summary.totalReveals} loading={logQuery.loading} />
      </div>

      <div className="flex gap-2 border-b border-if-line">
        <button type="button"
                className={cn("px-4 py-2 text-sm font-medium border-b-2",
                  tab === "reveal" ? "border-if-navy text-if-navy" : "border-transparent text-if-muted")}
                onClick={() => setTab("reveal")}>
          Reveal contacts
        </button>
        <button type="button"
                className={cn("px-4 py-2 text-sm font-medium border-b-2",
                  tab === "log" ? "border-if-navy text-if-navy" : "border-transparent text-if-muted")}
                onClick={() => setTab("log")}>
          Access log
        </button>
      </div>

      {tab === "reveal" && (
        <StaffPickerPanel
          staff={staff}
          loading={staffQuery.loading}
          recentCounts={recentCounts}
          onPick={(s) => setRevealFor(s)}
        />
      )}

      {tab === "log" && (
        <AccessLogPanel log={log} loading={logQuery.loading} />
      )}

      {revealFor && (
        <RevealModal
          staff={revealFor}
          onClose={() => { setRevealFor(null); setRevealed(null); }}
          onRevealed={(rows, reason) => {
            setRevealed({ rows, staffName: revealFor.full_name, reason });
            logQuery.refresh && logQuery.refresh();
          }}
          revealed={revealed}
        />
      )}
    </div>
  );
}

// =============================================================================
// StaffPickerPanel — team roster with per-row "Reveal" trigger
// =============================================================================
function StaffPickerPanel({ staff, loading, recentCounts, onPick }) {
  if (loading) return <LoadingState message="Loading team…" rows={5} />;
  if (staff.length === 0) {
    return <EmptyState icon={Users} title="No active team members" description="Nobody to reveal contacts for yet." />;
  }
  return (
    <div className="if-card p-0 divide-y divide-if-line/60">
      {staff.map((s) => (
        <div key={s.id} className="p-4 flex items-center justify-between hover:bg-if-cream/30">
          <div>
            <div className="text-if-navy font-medium">{s.full_name}</div>
            <div className="text-xs text-if-muted">
              {s.role}
              {s.email && <> · <Mail size={10} className="inline" /> {s.email}</>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {recentCounts[s.id] > 0 && (
              <span className="text-xs text-if-muted" title="Reveals in the last 30 days">
                <History size={12} className="inline" /> {recentCounts[s.id]}
              </span>
            )}
            <button
              type="button"
              className="if-button-ghost text-xs"
              onClick={() => onPick(s)}
              title="Reveal emergency contacts (requires reason)"
            >
              <Eye size={12} className="inline mr-1" /> Reveal
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// AccessLogPanel — recent reveals with reason and role
// =============================================================================
function AccessLogPanel({ log, loading }) {
  if (loading) return <LoadingState message="Loading access log…" rows={4} />;
  if (log.length === 0) {
    return <EmptyState icon={History} title="No reveals yet" description="When someone reveals a staff member's contacts, the record appears here." />;
  }
  return (
    <div className="if-card p-0 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-if-cream text-if-navy/70 text-xs uppercase tracking-wide">
          <tr>
            <th className="text-left px-4 py-3">When</th>
            <th className="text-left px-4 py-3">Accessed by</th>
            <th className="text-left px-4 py-3">For staff</th>
            <th className="text-left px-4 py-3">Role</th>
            <th className="text-left px-4 py-3">Reason</th>
            <th className="text-right px-4 py-3">Contacts</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-if-line/60">
          {log.map((l) => (
            <tr key={l.id}>
              <td className="px-4 py-3 text-if-navy text-xs">{fmtWhen(l.accessed_at)}</td>
              <td className="px-4 py-3 text-if-navy">{l.accessed_by_name || <span className="text-if-muted">—</span>}</td>
              <td className="px-4 py-3">
                <StaffNameCell staffId={l.accessed_staff_id} />
              </td>
              <td className="px-4 py-3 text-xs uppercase text-if-muted">{l.access_role}</td>
              <td className="px-4 py-3 max-w-xs truncate" title={l.reason}>{l.reason}</td>
              <td className="px-4 py-3 text-right text-if-muted text-xs">{l.contact_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StaffNameCell({ staffId }) {
  // Best-effort denormalized display. If the staff row is deleted, we
  // fall back to the id.
  const nameQuery = useSupabaseQuery(
    () => supabase.from("staff").select("full_name").eq("id", staffId).maybeSingle(),
    [staffId]
  );
  return <span className="text-if-navy">{nameQuery.data?.full_name || `staff:${staffId?.slice(0, 8)}…`}</span>;
}

// =============================================================================
// RevealModal — reason gate + reveal + display
// =============================================================================
function RevealModal({ staff, onClose, onRevealed, revealed }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);


  async function reveal() {
    setBusy(true); setError(null);
    try {
      const { data, error: rpcErr } = await supabase.rpc("rpc_reveal_emergency_contacts", {
        p_staff_id: staff.id,
        p_reason:   reason.trim(),
      });
      if (rpcErr) throw rpcErr;
      onRevealed(data || [], reason.trim());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const isRevealed = !!revealed && revealed.rows;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-if-navy/30 p-4">
      <div className="if-card max-w-lg w-full bg-white">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-if-navy">
            {isRevealed ? "Emergency contacts" : "Reveal emergency contacts"}
          </h2>
          <button type="button" className="if-button-ghost" onClick={onClose} disabled={busy}>
            <X size={16} />
          </button>
        </div>

        <div className="text-sm text-if-navy mb-3">
          For <span className="font-medium">{staff.full_name}</span>
        </div>

        {!isRevealed && (
          <>
            <label className="block mb-3">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
                Reason for reveal (required, will be logged)
              </span>
              <textarea
                className="if-input"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. On-call incident 2026-07-10, unable to reach staff member for scheduled shift."
                disabled={busy}
                autoFocus
              />
              <div className="text-xs text-if-muted mt-1">
                {reason.trim().length < 5
                  ? `${5 - reason.trim().length} more character${5 - reason.trim().length === 1 ? "" : "s"} required`
                  : "OK to reveal"}
              </div>
            </label>

            {error && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-3">
                {error}
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <button type="button" className="if-button-ghost text-xs" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="if-button text-xs" onClick={reveal}
                      disabled={busy || reason.trim().length < 5}>
                <Eye size={14} className="inline mr-1" />
                {busy ? "Revealing…" : "Reveal contacts"}
              </button>
            </div>
          </>
        )}

        {isRevealed && (
          <>
            <div className="text-xs text-if-muted mb-3">
              Reason logged: <span className="italic">"{revealed.reason}"</span>
            </div>
            {revealed.rows.length === 0 ? (
              <div className="if-card bg-if-cream/60 text-sm text-if-navy">
                No emergency contacts on file for {revealed.staffName}.
              </div>
            ) : (
              <div className="space-y-2">
                {revealed.rows.map((c) => (
                  <div key={c.id} className="if-card bg-if-cream/40">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="text-if-navy font-medium">{c.contact_name}</div>
                        <div className="text-xs text-if-muted">
                          {RELATIONSHIP_LABEL[c.relationship] || c.relationship} · Priority {c.priority}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 space-y-1 text-sm">
                      {c.phone_primary && (
                        <div className="flex items-center gap-2">
                          <PhoneCall size={12} className="text-if-navy" />
                          <a className="text-if-navy underline" href={`tel:${c.phone_primary}`}>{c.phone_primary}</a>
                          <span className="text-xs text-if-muted">primary</span>
                        </div>
                      )}
                      {c.phone_secondary && (
                        <div className="flex items-center gap-2">
                          <PhoneCall size={12} className="text-if-muted" />
                          <a className="text-if-navy underline" href={`tel:${c.phone_secondary}`}>{c.phone_secondary}</a>
                          <span className="text-xs text-if-muted">secondary</span>
                        </div>
                      )}
                      {c.email && (
                        <div className="flex items-center gap-2">
                          <Mail size={12} className="text-if-muted" />
                          <a className="text-if-navy underline" href={`mailto:${c.email}`}>{c.email}</a>
                        </div>
                      )}
                      {c.notes && (
                        <div className="text-xs text-if-muted italic mt-1">{c.notes}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end mt-4">
              <button type="button" className="if-button text-xs" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
