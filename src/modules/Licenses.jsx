// =============================================================================
// Licenses.jsx — Producer licenses dashboard (team + own)
// -----------------------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.3 (Premium §4.8 Module 08)
//
// Routing: BCCApp.jsx dispatches nav id "licenses" to this component for
// owner, manager, and staff roles. The same UI serves all three — RLS on
// producer_licenses scopes what each caller can see:
//   • Producer:  own rows only
//   • Owner:     all rows unconditionally
//   • Manager:   all rows when enable_licenses_manager_access = true
//                (DEFAULTS TRUE — deliberate B.11 deviation, see migration 108)
//
// Add/edit/delete flow through SECURITY DEFINER RPCs which re-check the
// same authorization server-side, so the UI can offer the same buttons to
// everyone and let the DB reject invalid attempts.
//
// Data sources:
//   • v_expiring_licenses    — attention-needed subset (expiring ≤60d or CE-behind)
//   • producer_licenses      — the full record set the caller can see (RLS-scoped)
//   • rpc_upsert_producer_license  — write path (insert or renew)
//   • rpc_delete_producer_license  — hard delete (prefer status=inactive)
//
// Ask Claude prompts: seeded per spec §4.8 in Base's PlaybookGuide.jsx —
// this file surfaces them via AskClaudeButton but does not duplicate the
// prompt text (single source of truth in Base).
// =============================================================================

import { useState, useMemo } from "react";
import { ShieldCheck, AlertTriangle, GraduationCap, Plus, Pencil, Trash2, X, Check } from "lucide-react";

import { supabase } from "../lib/supabase.js";
import { useSupabaseQuery } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";

import SectionHeader from "../components/SectionHeader.jsx";
import StatCard from "../components/StatCard.jsx";
import EmptyState from "../components/EmptyState.jsx";
import LoadingState from "../components/LoadingState.jsx";
import AskClaudeButton from "../components/AskClaudeButton.jsx";

// -----------------------------------------------------------------------------
// Constants + helpers
// -----------------------------------------------------------------------------
const LICENSE_TYPES = [
  { value: "p_c",            label: "Property & Casualty" },
  { value: "life",           label: "Life" },
  { value: "health",         label: "Health" },
  { value: "life_health",    label: "Life & Health" },
  { value: "series_6",       label: "Series 6" },
  { value: "series_7",       label: "Series 7" },
  { value: "series_63",      label: "Series 63" },
  { value: "series_65",      label: "Series 65" },
  { value: "crop",           label: "Crop" },
  { value: "ce_certificate", label: "CE Certificate" },
  { value: "other",          label: "Other" },
];

const STATUSES = ["active", "expired", "suspended", "inactive"];

const URGENCY_STYLE = {
  expired:  "bg-red-100 text-red-800 border-red-200",
  critical: "bg-red-50 text-red-700 border-red-200",
  warning:  "bg-amber-50 text-amber-700 border-amber-200",
  watch:    "bg-blue-50 text-blue-700 border-blue-200",
  ok:       "bg-emerald-50 text-emerald-700 border-emerald-200",
};

function typeLabel(value) {
  return LICENSE_TYPES.find((t) => t.value === value)?.label || value;
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}

function daysUntilLabel(n) {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  if (Number.isNaN(num)) return "—";
  if (num < 0)  return `Expired ${Math.abs(num)}d ago`;
  if (num === 0) return "Expires today";
  if (num === 1) return "Expires tomorrow";
  return `In ${num}d`;
}

// =============================================================================
// Main component
// =============================================================================
export default function Licenses() {
  // Full RLS-scoped record set
  const licensesQuery = useSupabaseQuery(
    () => supabase
      .from("producer_licenses")
      .select("*, staff:staff_id(id, full_name, role, status)")
      .order("expiration_date", { ascending: true }),
    []
  );

  // Attention-needed subset
  const expiringQuery = useSupabaseQuery(
    () => supabase
      .from("v_expiring_licenses")
      .select("*")
      .order("expiration_date", { ascending: true }),
    []
  );

  const [editing, setEditing]     = useState(null);      // license row being edited (or {} for new)
  const [showModal, setShowModal] = useState(false);

  const rows      = licensesQuery.data || [];
  const expiring  = expiringQuery.data || [];

  // Detect single-staff view (producer looking at own) to collapse the Staff column
  const distinctStaff = useMemo(
    () => new Set(rows.map((r) => r.staff_id)).size,
    [rows]
  );
  const isOwnOnly = distinctStaff <= 1;

  const summary = useMemo(() => ({
    total:       rows.filter((r) => r.status === "active").length,
    expiring60:  expiring.filter((r) => r.urgency !== "ok" && r.days_until_expiration >= 0).length,
    ceBehind:    expiring.filter((r) => r.ce_behind).length,
    expired:     expiring.filter((r) => r.days_until_expiration < 0).length,
  }), [rows, expiring]);

  function openNew() {
    setEditing({
      staff_id: null,
      license_type: "p_c",
      license_number: "",
      state: "",
      issue_date: "",
      expiration_date: "",
      ce_hours_required: 0,
      ce_hours_completed: 0,
      status: "active",
      notes: "",
    });
    setShowModal(true);
  }

  function openEdit(row) {
    setEditing({
      id: row.id,
      staff_id: row.staff_id,
      license_type: row.license_type,
      license_number: row.license_number,
      state: row.state,
      issue_date: row.issue_date || "",
      expiration_date: row.expiration_date || "",
      ce_hours_required: row.ce_hours_required || 0,
      ce_hours_completed: row.ce_hours_completed || 0,
      status: row.status || "active",
      notes: row.notes || "",
    });
    setShowModal(true);
  }

  function refresh() {
    licensesQuery.refresh && licensesQuery.refresh();
    expiringQuery.refresh && expiringQuery.refresh();
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Licenses"
        description={isOwnOnly
          ? "Your producer licenses, CE hours, and renewal deadlines."
          : "Team producer licenses, CE compliance, and upcoming renewals."}
        actions={
          <div className="flex gap-2">
            {rows.length > 0 && (
              <AskClaudeButton
                moduleLabel="Licenses"
                subject={isOwnOnly ? "my producer licenses" : "team producer licenses"}
                context={{ licenses: rows, expiring }}
                suggestedPrompt="Review my team's license status — flag anyone at risk of a compliance lapse in the next 60 days, anyone behind on CE hours, and rank them by priority so I know where to focus first."
              />
            )}
            <button type="button" className="if-button" onClick={openNew}>
              <Plus size={14} className="inline mr-1" /> Add license
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Active licenses" value={summary.total} loading={licensesQuery.loading} icon={ShieldCheck} />
        <StatCard label="Expiring ≤60 days" value={summary.expiring60} loading={expiringQuery.loading}
                  tone={summary.expiring60 > 0 ? "warning" : "neutral"} />
        <StatCard label="CE behind" value={summary.ceBehind} loading={expiringQuery.loading}
                  tone={summary.ceBehind > 0 ? "warning" : "neutral"} icon={GraduationCap} />
        <StatCard label="Already expired" value={summary.expired} loading={expiringQuery.loading}
                  tone={summary.expired > 0 ? "danger" : "neutral"} icon={AlertTriangle} />
      </div>

      <LicensesTable
        rows={rows}
        expiringByLicenseId={new Map(expiring.map((e) => [e.license_id, e]))}
        loading={licensesQuery.loading}
        error={licensesQuery.error}
        isOwnOnly={isOwnOnly}
        onEdit={openEdit}
        onChanged={refresh}
      />

      {showModal && editing && (
        <LicenseModal
          initial={editing}
          isOwnOnly={isOwnOnly}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={() => { setShowModal(false); setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}

// =============================================================================
// LicensesTable
// =============================================================================
function LicensesTable({ rows, expiringByLicenseId, loading, error, isOwnOnly, onEdit, onChanged }) {
  if (loading) return <LoadingState message="Loading licenses…" rows={4} />;
  if (error) {
    return (
      <div className="if-card border-red-200 bg-red-50/40">
        <div className="text-red-700 text-sm font-medium">Couldn't load licenses.</div>
        <div className="text-red-700/80 text-xs mt-1">{String(error.message || error)}</div>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No licenses yet"
        description={isOwnOnly
          ? "Add your first producer license to track expiration dates and CE hours."
          : "No producer licenses recorded for your team yet."}
      />
    );
  }

  return (
    <div className="if-card p-0 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-if-cream text-if-navy/70 text-xs uppercase tracking-wide">
          <tr>
            {!isOwnOnly && <th className="text-left px-4 py-3">Producer</th>}
            <th className="text-left px-4 py-3">Type / State</th>
            <th className="text-left px-4 py-3">License #</th>
            <th className="text-left px-4 py-3">Expires</th>
            <th className="text-left px-4 py-3">CE</th>
            <th className="text-left px-4 py-3">Status</th>
            <th className="text-right px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-if-line/60">
          {rows.map((row) => {
            const attn = expiringByLicenseId.get(row.id);
            const urgency = attn?.urgency || "ok";
            const ceBehind = attn?.ce_behind;
            const staffName = row.staff?.full_name || "—";
            const cePct = row.ce_hours_required > 0
              ? Math.min(100, Math.round((row.ce_hours_completed / row.ce_hours_required) * 100))
              : 100;

            return (
              <tr key={row.id} className="hover:bg-if-cream/30">
                {!isOwnOnly && (
                  <td className="px-4 py-3 text-if-navy font-medium">{staffName}</td>
                )}
                <td className="px-4 py-3">
                  <div className="text-if-navy">{typeLabel(row.license_type)}</div>
                  <div className="text-xs text-if-muted">{row.state}</div>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-if-navy">{row.license_number}</td>
                <td className="px-4 py-3">
                  <div className="text-if-navy">{fmtDate(row.expiration_date)}</div>
                  {attn && (
                    <span className={cn(
                      "inline-block mt-0.5 text-[10px] px-1.5 py-0.5 rounded border",
                      URGENCY_STYLE[urgency] || URGENCY_STYLE.ok
                    )}>
                      {daysUntilLabel(attn.days_until_expiration)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 min-w-[110px]">
                  <div className="text-xs text-if-navy">
                    {row.ce_hours_completed} / {row.ce_hours_required || 0} hrs
                  </div>
                  {row.ce_hours_required > 0 && (
                    <div className="w-full bg-if-line/60 rounded h-1.5 mt-1">
                      <div
                        className={cn("h-1.5 rounded", ceBehind ? "bg-amber-500" : "bg-emerald-500")}
                        style={{ width: `${cePct}%` }}
                      />
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={cn(
                    "text-[10px] uppercase font-semibold tracking-wide",
                    row.status === "active" && "text-emerald-700",
                    row.status === "expired" && "text-red-700",
                    row.status === "suspended" && "text-amber-700",
                    row.status === "inactive" && "text-if-muted"
                  )}>
                    {row.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    className="if-button-ghost text-xs"
                    onClick={() => onEdit(row)}
                    title="Edit / renew"
                  >
                    <Pencil size={12} className="inline mr-1" /> Edit
                  </button>
                  <DeleteButton row={row} onDeleted={onChanged} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// =============================================================================
// DeleteButton — inline confirm
// =============================================================================
function DeleteButton({ row, onDeleted }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);

  async function doDelete() {
    setBusy(true); setError(null);
    try {
      const { error: rpcErr } = await supabase.rpc("rpc_delete_producer_license", { p_license_id: row.id });
      if (rpcErr) throw rpcErr;
      onDeleted && onDeleted();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false); setConfirm(false);
    }
  }

  if (error) {
    return <span className="text-xs text-red-700 ml-2">{error}</span>;
  }
  if (!confirm) {
    return (
      <button type="button" className="if-button-ghost text-xs ml-1 text-red-700"
              onClick={() => setConfirm(true)} title="Delete (prefer status=inactive)">
        <Trash2 size={12} className="inline" />
      </button>
    );
  }
  return (
    <span className="ml-2 text-xs">
      Delete?
      <button type="button" className="if-button-ghost ml-1 text-red-700" onClick={doDelete} disabled={busy}>
        {busy ? "…" : "Yes"}
      </button>
      <button type="button" className="if-button-ghost ml-1" onClick={() => setConfirm(false)} disabled={busy}>
        No
      </button>
    </span>
  );
}

// =============================================================================
// LicenseModal — add / edit / renew
// =============================================================================
function LicenseModal({ initial, isOwnOnly, onClose, onSaved }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  // For owner/manager: need staff picker
  const staffQuery = useSupabaseQuery(
    () => supabase.from("staff").select("id, full_name, role, status").order("full_name"),
    []
  );

  // For producer with unset staff_id, resolve via staff table (RLS lets
  // every staff member see their own row).
  async function resolveOwnStaffId() {
    const { data: sess } = await supabase.auth.getUser();
    if (!sess?.user?.id) throw new Error("Not authenticated");
    const { data, error: qErr } = await supabase
      .from("staff")
      .select("id")
      .eq("auth_user_id", sess.user.id)
      .maybeSingle();
    if (qErr) throw qErr;
    return data?.id || null;
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      let staffId = form.staff_id;
      if (!staffId) {
        staffId = await resolveOwnStaffId();
        if (!staffId) throw new Error("Could not resolve your staff record. Ask the owner to add you to staff first.");
      }
      const { error: rpcErr } = await supabase.rpc("rpc_upsert_producer_license", {
        p_staff_id:           staffId,
        p_license_type:       form.license_type,
        p_license_number:     (form.license_number || "").trim(),
        p_state:              (form.state || "").trim().toUpperCase(),
        p_expiration_date:    form.expiration_date || null,
        p_issue_date:         form.issue_date || null,
        p_ce_hours_required:  Number(form.ce_hours_required) || 0,
        p_ce_hours_completed: Number(form.ce_hours_completed) || 0,
        p_status:             form.status || "active",
        p_notes:              form.notes || null,
      });
      if (rpcErr) throw rpcErr;
      onSaved && onSaved();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  function field(name, value) {
    setForm((f) => ({ ...f, [name]: value }));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-if-navy/30 p-4">
      <div className="if-card max-w-lg w-full bg-white">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-if-navy">
            {form.id ? "Edit / renew license" : "Add license"}
          </h2>
          <button type="button" className="if-button-ghost" onClick={onClose} disabled={saving}>
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          {!isOwnOnly && (
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Producer</span>
              <select
                className="if-input"
                value={form.staff_id || ""}
                onChange={(e) => field("staff_id", e.target.value || null)}
                disabled={saving}
              >
                <option value="">— Select producer —</option>
                {(staffQuery.data || []).filter((s) => s.status === "active").map((s) => (
                  <option key={s.id} value={s.id}>{s.full_name} ({s.role})</option>
                ))}
              </select>
            </label>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">License type</span>
              <select
                className="if-input"
                value={form.license_type}
                onChange={(e) => field("license_type", e.target.value)}
                disabled={saving}
              >
                {LICENSE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">State</span>
              <input
                className="if-input"
                type="text"
                maxLength={2}
                value={form.state}
                onChange={(e) => field("state", e.target.value.toUpperCase())}
                disabled={saving}
                placeholder="FL"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">License number</span>
            <input
              className="if-input"
              type="text"
              maxLength={50}
              value={form.license_number}
              onChange={(e) => field("license_number", e.target.value)}
              disabled={saving}
              placeholder="e.g. W123456"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Issue date</span>
              <input className="if-input" type="date" value={form.issue_date}
                     onChange={(e) => field("issue_date", e.target.value)} disabled={saving} />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Expiration date</span>
              <input className="if-input" type="date" value={form.expiration_date}
                     onChange={(e) => field("expiration_date", e.target.value)} disabled={saving} />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">CE hours required</span>
              <input className="if-input" type="number" min="0" value={form.ce_hours_required}
                     onChange={(e) => field("ce_hours_required", e.target.value)} disabled={saving} />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">CE hours completed</span>
              <input className="if-input" type="number" min="0" value={form.ce_hours_completed}
                     onChange={(e) => field("ce_hours_completed", e.target.value)} disabled={saving} />
            </label>
          </div>

          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Status</span>
            <select className="if-input" value={form.status}
                    onChange={(e) => field("status", e.target.value)} disabled={saving}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>

          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Notes</span>
            <textarea className="if-input" rows={2} value={form.notes || ""}
                      onChange={(e) => field("notes", e.target.value)} disabled={saving} />
          </label>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
              {error}
            </div>
          )}
        </div>

        <div className="flex gap-2 justify-end mt-4">
          <button type="button" className="if-button-ghost text-xs" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="if-button text-xs" onClick={save} disabled={saving}>
            <Check size={14} className="inline mr-1" />
            {saving ? "Saving…" : "Save license"}
          </button>
        </div>
      </div>
    </div>
  );
}
