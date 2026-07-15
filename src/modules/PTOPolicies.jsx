// =============================================================================
// PTOPolicies.jsx — Owner-only PTO policy management
// -----------------------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.2 (Premium §4 PTO)
//
// Rendered inside PTOAdmin.jsx as a tab. Managers who reach this tab can view
// policies (RLS allows read to all authenticated) but cannot save changes —
// rpc_upsert_pto_policy raises permission_denied when the caller is not the
// owner. A friendly error message surfaces the server-side rejection.
//
// This module is a form editor. No archiving-as-delete UX: policies are
// deactivated via the is_active flag rather than removed. Historical
// pto_balances rows continue to reference them via ON DELETE SET NULL.
//
// Data:
//   • public.pto_policies via useSupabaseQuery
//   • rpc_upsert_pto_policy(p_id NULL for new, or existing UUID)
//
// Display convention (Phase 2, established 2026-07-09; wired v0.5.2 2026-07-10):
//   Policy configuration is the ONE surface where days remains the natural
//   unit (owners write "15 days/year", "5 days cap", "30 days waiting").
//   PTOMine/PTOAdmin show balances/requests in hours; this editor keeps days
//   for input UX. Uses formatDays() from ../lib/pto/format.js so the
//   formatter source is uniform across every PTO surface.
// =============================================================================

import { useState, useMemo } from "react";
import { Plus, Save, X, Edit2, Archive, ArchiveRestore, ChevronRight } from "lucide-react";

import { supabase } from "../lib/supabase.js";
import { useSupabaseQuery } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";
import { formatDays } from "../lib/pto/format.js";

import SectionHeader from "../components/SectionHeader.jsx";
import EmptyState from "../components/EmptyState.jsx";
import LoadingState from "../components/LoadingState.jsx";

const ACCRUAL_PATTERNS = [
  { value: "anniversary", label: "Anniversary — annual grant at hire-date rollover" },
  { value: "monthly",     label: "Monthly — accrues at a per-month rate" },
  { value: "biweekly",    label: "Biweekly — accrues per pay period" },
  { value: "unlimited",   label: "Unlimited — no balance tracking" },
];

const CARRYOVER_TYPES = [
  { value: "use_it_or_lose_it", label: "Use it or lose it — resets each period" },
  { value: "unlimited",         label: "Unlimited — full balance rolls over" },
  { value: "capped",            label: "Capped — up to a maximum" },
];

const RESET_ANCHORS = [
  { value: "anniversary",       label: "Anniversary (each staff's hire date)" },
  { value: "calendar_year",     label: "Calendar year (Jan 1)" },
  { value: "fiscal_year_start", label: "Fiscal year start" },
];

const ACCRUAL_START_BASIS = [
  { value: "hire_date",           label: "Hire date" },
  { value: "waiting_period_end",  label: "End of waiting period" },
];

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function emptyPolicyDraft() {
  return {
    id:                       null,
    name:                     "",
    accrual_pattern:          "anniversary",
    accrual_rate_days:        "",
    tenure_brackets:          [{ years_min: 0, days_per_year: 10 }],
    accrual_start_basis:      "hire_date",
    waiting_period_days:      0,
    carryover_type:           "use_it_or_lose_it",
    carryover_cap_days:       "",
    reset_anchor:             "anniversary",
    fiscal_year_start_month:  "",
    is_active:                true,
  };
}

function toDraft(row) {
  return {
    id:                       row.id,
    name:                     row.name || "",
    accrual_pattern:          row.accrual_pattern || "anniversary",
    accrual_rate_days:        row.accrual_rate_days ?? "",
    tenure_brackets:          Array.isArray(row.tenure_brackets)
                                ? row.tenure_brackets
                                : (row.tenure_brackets || []),
    accrual_start_basis:      row.accrual_start_basis || "hire_date",
    waiting_period_days:      row.waiting_period_days ?? 0,
    carryover_type:           row.carryover_type || "use_it_or_lose_it",
    carryover_cap_days:       row.carryover_cap_days ?? "",
    reset_anchor:             row.reset_anchor || "anniversary",
    fiscal_year_start_month:  row.fiscal_year_start_month ?? "",
    is_active:                row.is_active !== false,
  };
}

// =============================================================================
// Top-level component
// =============================================================================
export default function PTOPolicies() {
  if (!supabase) {
    return (
      <div className="if-card">
        <p className="text-if-muted">Supabase client not initialized.</p>
      </div>
    );
  }
  return <PTOPoliciesImpl />;
}

function PTOPoliciesImpl() {
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);

  const policiesQuery = useSupabaseQuery(
    () => supabase
      .from("pto_policies")
      .select("*")
      .order("is_active", { ascending: false })
      .order("name", { ascending: true }),
    [refreshKey]
  );

  const [editing, setEditing] = useState(null); // policy draft or null

  const policies = policiesQuery.data || [];
  const activePolicies   = policies.filter((p) => p.is_active);
  const archivedPolicies = policies.filter((p) => !p.is_active);

  function startNew() {
    setEditing(emptyPolicyDraft());
  }

  function startEdit(policy) {
    setEditing(toDraft(policy));
  }

  function closeEditor() {
    setEditing(null);
  }

  function afterSave() {
    closeEditor();
    bump();
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="PTO Policies"
        description="Define one or more plans and assign staff to them from the HR module. Only the owner can save changes."
        actions={
          !editing && (
            <button type="button" className="if-button text-xs" onClick={startNew}>
              <Plus size={14} /> New policy
            </button>
          )
        }
      />

      {editing && (
        <PolicyEditor
          draft={editing}
          onChange={setEditing}
          onSaved={afterSave}
          onCancel={closeEditor}
        />
      )}

      <section>
        <SectionHeader title="Active policies" />
        <PoliciesList
          policies={activePolicies}
          loading={policiesQuery.loading}
          error={policiesQuery.error}
          onEdit={startEdit}
          onToggleActive={bump}
          emptyMessage="No active policies yet. Create your first one to enable PTO for staff."
        />
      </section>

      {archivedPolicies.length > 0 && (
        <section>
          <SectionHeader
            title="Archived policies"
            description="Inactive plans. Historical balances continue to reference them for audit."
          />
          <PoliciesList
            policies={archivedPolicies}
            loading={false}
            error={null}
            onEdit={startEdit}
            onToggleActive={bump}
            emptyMessage=""
          />
        </section>
      )}
    </div>
  );
}

// =============================================================================
// Policies list
// =============================================================================
function PoliciesList({ policies, loading, error, onEdit, onToggleActive, emptyMessage }) {
  const [processingId, setProcessingId] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  async function toggleActive(policy) {
    setProcessingId(policy.id);
    setErrorMsg(null);
    try {
      const { error: rpcErr } = await supabase.rpc("rpc_upsert_pto_policy", {
        p_id:                       policy.id,
        p_name:                     policy.name,
        p_accrual_pattern:          policy.accrual_pattern,
        p_accrual_rate_days:        policy.accrual_rate_days,
        p_tenure_brackets:          policy.tenure_brackets || [],
        p_accrual_start_basis:      policy.accrual_start_basis,
        p_waiting_period_days:      policy.waiting_period_days,
        p_carryover_type:           policy.carryover_type,
        p_carryover_cap_days:       policy.carryover_cap_days,
        p_reset_anchor:             policy.reset_anchor,
        p_fiscal_year_start_month:  policy.fiscal_year_start_month,
        p_is_active:                !policy.is_active,
      });
      if (rpcErr) throw rpcErr;
      onToggleActive?.();
    } catch (err) {
      setErrorMsg(err?.message || "Failed to update policy.");
    } finally {
      setProcessingId(null);
    }
  }

  if (loading) return <LoadingState message="Loading policies…" rows={3} />;
  if (error) {
    return (
      <div className="if-card border-red-200 bg-red-50/40">
        <p className="text-sm text-red-800">Could not load: {error}</p>
      </div>
    );
  }
  if (policies.length === 0 && emptyMessage) {
    return (
      <EmptyState icon="📋" title="No policies" description={emptyMessage} />
    );
  }
  if (policies.length === 0) return null;

  return (
    <div className="if-card overflow-x-auto">
      {errorMsg && (
        <div className="mb-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
          {errorMsg}
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-if-muted">
          <tr className="border-b border-if-line">
            <th className="text-left py-2 pr-3">Name</th>
            <th className="text-left py-2 pr-3">Accrual</th>
            <th className="text-left py-2 pr-3">Waiting</th>
            <th className="text-left py-2 pr-3">Carryover</th>
            <th className="text-left py-2 pr-3">Reset</th>
            <th className="text-right py-2 pl-3"></th>
          </tr>
        </thead>
        <tbody>
          {policies.map((p) => (
            <tr key={p.id} className={cn(
              "border-b border-if-line/60 last:border-b-0",
              !p.is_active && "opacity-60"
            )}>
              <td className="py-2 pr-3 font-medium text-if-navy">{p.name}</td>
              <td className="py-2 pr-3 capitalize">
                {p.accrual_pattern}
                {p.accrual_pattern === "anniversary" && p.tenure_brackets?.length > 0 && (
                  <span className="text-if-muted text-xs ml-1">
                    ({p.tenure_brackets.length} tier{p.tenure_brackets.length === 1 ? "" : "s"})
                  </span>
                )}
                {(p.accrual_pattern === "monthly" || p.accrual_pattern === "biweekly") && p.accrual_rate_days && (
                  <span className="text-if-muted text-xs ml-1">
                    ({formatDays(p.accrual_rate_days, { showUnit: false })} d/period)
                  </span>
                )}
              </td>
              <td className="py-2 pr-3">{p.waiting_period_days || 0} days</td>
              <td className="py-2 pr-3">
                {p.carryover_type === "capped"
                  ? `Capped at ${formatDays(p.carryover_cap_days)}`
                  : p.carryover_type.replace(/_/g, " ")}
              </td>
              <td className="py-2 pr-3">
                {p.reset_anchor === "fiscal_year_start"
                  ? `Fiscal (${MONTHS[(p.fiscal_year_start_month || 1) - 1]})`
                  : p.reset_anchor.replace(/_/g, " ")}
              </td>
              <td className="py-2 pl-3 text-right whitespace-nowrap">
                <button
                  type="button"
                  className="if-button-ghost text-xs mr-1"
                  onClick={() => onEdit(p)}
                >
                  <Edit2 size={12} /> Edit
                </button>
                <button
                  type="button"
                  className="if-button-ghost text-xs"
                  disabled={processingId === p.id}
                  onClick={() => toggleActive(p)}
                >
                  {p.is_active
                    ? <><Archive size={12} /> Archive</>
                    : <><ArchiveRestore size={12} /> Restore</>}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// =============================================================================
// Policy editor
// =============================================================================
function PolicyEditor({ draft, onChange, onSaved, onCancel }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const isNew = draft.id === null;

  function set(field, value) {
    onChange({ ...draft, [field]: value });
  }

  // Tenure bracket ops
  function addBracket() {
    const brackets = [...(draft.tenure_brackets || [])];
    const nextYears = brackets.length > 0
      ? Math.max(...brackets.map((b) => Number(b.years_min) || 0)) + 1
      : 0;
    brackets.push({ years_min: nextYears, days_per_year: 10 });
    set("tenure_brackets", brackets);
  }
  function removeBracket(idx) {
    const brackets = [...(draft.tenure_brackets || [])];
    brackets.splice(idx, 1);
    set("tenure_brackets", brackets);
  }
  function updateBracket(idx, field, value) {
    const brackets = [...(draft.tenure_brackets || [])];
    brackets[idx] = { ...brackets[idx], [field]: value };
    set("tenure_brackets", brackets);
  }

  // Validation
  const validation = useMemo(() => {
    const problems = [];
    if (!draft.name?.trim()) problems.push("Policy name is required.");

    if (draft.accrual_pattern === "monthly" || draft.accrual_pattern === "biweekly") {
      const rate = Number(draft.accrual_rate_days);
      if (!Number.isFinite(rate) || rate <= 0) {
        problems.push("Monthly and biweekly patterns require a positive accrual rate (days per period).");
      }
    }

    if (draft.carryover_type === "capped") {
      const cap = Number(draft.carryover_cap_days);
      if (!Number.isFinite(cap) || cap < 0) {
        problems.push("Capped carryover requires a non-negative cap value.");
      }
    }

    if (draft.reset_anchor === "fiscal_year_start") {
      const m = Number(draft.fiscal_year_start_month);
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        problems.push("Fiscal-year reset requires a starting month (1–12).");
      }
    }

    if (draft.accrual_pattern === "anniversary") {
      const b = draft.tenure_brackets || [];
      if (b.length > 0) {
        let prev = -1;
        for (const bracket of b) {
          const y = Number(bracket.years_min);
          const d = Number(bracket.days_per_year);
          if (!Number.isInteger(y) || y < 0) {
            problems.push("Tenure brackets: years_min must be a non-negative integer.");
            break;
          }
          if (!Number.isFinite(d) || d < 0) {
            problems.push("Tenure brackets: days_per_year must be non-negative.");
            break;
          }
          if (y <= prev) {
            problems.push("Tenure brackets: years_min must be strictly increasing across tiers.");
            break;
          }
          prev = y;
        }
      }
    }
    return problems;
  }, [draft]);

  const canSave = !saving && validation.length === 0;

  async function handleSave(e) {
    e?.preventDefault?.();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      // Normalize numeric fields; the RPC expects nulls, not empty strings
      const rate = draft.accrual_rate_days === "" ? null : Number(draft.accrual_rate_days);
      const cap  = draft.carryover_cap_days === "" ? null : Number(draft.carryover_cap_days);
      const fym  = draft.fiscal_year_start_month === "" ? null : Number(draft.fiscal_year_start_month);
      const brackets = (draft.tenure_brackets || []).map((b) => ({
        years_min:     Number(b.years_min),
        days_per_year: Number(b.days_per_year),
      }));

      const { error: rpcErr } = await supabase.rpc("rpc_upsert_pto_policy", {
        p_id:                       draft.id,
        p_name:                     draft.name.trim(),
        p_accrual_pattern:          draft.accrual_pattern,
        p_accrual_rate_days:        rate,
        p_tenure_brackets:          brackets,
        p_accrual_start_basis:      draft.accrual_start_basis,
        p_waiting_period_days:      Number(draft.waiting_period_days) || 0,
        p_carryover_type:           draft.carryover_type,
        p_carryover_cap_days:       cap,
        p_reset_anchor:             draft.reset_anchor,
        p_fiscal_year_start_month:  fym,
        p_is_active:                Boolean(draft.is_active),
      });
      if (rpcErr) throw rpcErr;
      onSaved?.();
    } catch (err) {
      setError(err?.message || "Failed to save policy.");
    } finally {
      setSaving(false);
    }
  }

  const showAccrualRate = draft.accrual_pattern === "monthly" || draft.accrual_pattern === "biweekly";
  const showTenureBrackets = draft.accrual_pattern === "anniversary";
  const showCarryoverCap = draft.carryover_type === "capped";
  const showFiscalMonth = draft.reset_anchor === "fiscal_year_start";

  return (
    <form onSubmit={handleSave} className="if-card space-y-4 border-if-navy/40">
      <div className="flex items-center justify-between">
        <h3 className="text-if-navy font-semibold">
          {isNew ? "New PTO policy" : `Edit policy — ${draft.name || "(unnamed)"}`}
        </h3>
        <button type="button" className="if-button-ghost text-xs" onClick={onCancel} disabled={saving}>
          <X size={14} /> Close
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Name</span>
          <input
            className="if-input"
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Producer Standard PTO"
          />
        </label>

        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Status</span>
          <div className="flex items-center gap-2 h-[38px]">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.is_active}
                onChange={(e) => set("is_active", e.target.checked)}
              />
              <span>{draft.is_active ? "Active" : "Archived"}</span>
            </label>
          </div>
        </label>
      </div>

      <fieldset className="space-y-3 border border-if-line rounded p-3">
        <legend className="text-xs uppercase tracking-wide text-if-muted px-1">
          Accrual
        </legend>

        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Pattern</span>
          <select
            className="if-input"
            value={draft.accrual_pattern}
            onChange={(e) => set("accrual_pattern", e.target.value)}
          >
            {ACCRUAL_PATTERNS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        {showAccrualRate && (
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
              Accrual rate (days per period)
            </span>
            <input
              className="if-input"
              type="number"
              step="0.01"
              min="0"
              value={draft.accrual_rate_days}
              onChange={(e) => set("accrual_rate_days", e.target.value)}
              placeholder={draft.accrual_pattern === "monthly" ? "e.g. 0.83" : "e.g. 0.38"}
            />
          </label>
        )}

        {showTenureBrackets && (
          <TenureBracketsEditor
            brackets={draft.tenure_brackets || []}
            onAdd={addBracket}
            onRemove={removeBracket}
            onUpdate={updateBracket}
          />
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
              Accrual starts on
            </span>
            <select
              className="if-input"
              value={draft.accrual_start_basis}
              onChange={(e) => set("accrual_start_basis", e.target.value)}
            >
              {ACCRUAL_START_BASIS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
              Waiting period (days)
            </span>
            <input
              className="if-input"
              type="number"
              min="0"
              step="1"
              value={draft.waiting_period_days}
              onChange={(e) => set("waiting_period_days", e.target.value)}
              placeholder="0"
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-3 border border-if-line rounded p-3">
        <legend className="text-xs uppercase tracking-wide text-if-muted px-1">
          Carryover
        </legend>

        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Type</span>
          <select
            className="if-input"
            value={draft.carryover_type}
            onChange={(e) => set("carryover_type", e.target.value)}
          >
            {CARRYOVER_TYPES.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        {showCarryoverCap && (
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
              Cap (days)
            </span>
            <input
              className="if-input"
              type="number"
              step="0.5"
              min="0"
              value={draft.carryover_cap_days}
              onChange={(e) => set("carryover_cap_days", e.target.value)}
              placeholder="e.g. 5"
            />
          </label>
        )}
      </fieldset>

      <fieldset className="space-y-3 border border-if-line rounded p-3">
        <legend className="text-xs uppercase tracking-wide text-if-muted px-1">
          Period reset
        </legend>

        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Anchor</span>
          <select
            className="if-input"
            value={draft.reset_anchor}
            onChange={(e) => set("reset_anchor", e.target.value)}
          >
            {RESET_ANCHORS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        {showFiscalMonth && (
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
              Fiscal year start month
            </span>
            <select
              className="if-input"
              value={draft.fiscal_year_start_month}
              onChange={(e) => set("fiscal_year_start_month", e.target.value)}
            >
              <option value="">Select…</option>
              {MONTHS.map((name, idx) => (
                <option key={idx} value={idx + 1}>{name}</option>
              ))}
            </select>
          </label>
        )}
      </fieldset>

      {validation.length > 0 && (
        <ul className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2 space-y-1">
          {validation.map((v, i) => (
            <li key={i} className="flex items-start gap-2">
              <ChevronRight size={12} className="mt-0.5 shrink-0" />
              <span>{v}</span>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button type="button" className="if-button-ghost text-xs" onClick={onCancel} disabled={saving}>
          <X size={14} /> Cancel
        </button>
        <button type="submit" className="if-button text-xs" disabled={!canSave}>
          <Save size={14} /> {saving ? "Saving…" : (isNew ? "Create policy" : "Save changes")}
        </button>
      </div>
    </form>
  );
}

// =============================================================================
// Tenure brackets sub-editor
// =============================================================================
function TenureBracketsEditor({ brackets, onAdd, onRemove, onUpdate }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-if-muted">
          Tenure tiers (annual grant)
        </span>
        <button type="button" className="if-button-ghost text-xs" onClick={onAdd}>
          <Plus size={12} /> Add tier
        </button>
      </div>
      <p className="text-xs text-if-muted">
        Producer starts at tier with years_min ≤ their years of service. Highest matching tier wins.
      </p>

      {brackets.length === 0 && (
        <p className="text-xs text-if-muted italic">
          No tiers defined. Anniversary accrual will be 0 days/year until a tier is added.
        </p>
      )}

      {brackets.map((b, idx) => (
        <div key={idx} className="grid grid-cols-12 gap-2 items-end">
          <label className="col-span-5 block">
            <span className="text-xs text-if-muted block mb-1">
              After (years of service)
            </span>
            <input
              className="if-input"
              type="number"
              min="0"
              step="1"
              value={b.years_min}
              onChange={(e) => onUpdate(idx, "years_min", e.target.value)}
            />
          </label>
          <label className="col-span-5 block">
            <span className="text-xs text-if-muted block mb-1">
              Days per year granted
            </span>
            <input
              className="if-input"
              type="number"
              min="0"
              step="0.5"
              value={b.days_per_year}
              onChange={(e) => onUpdate(idx, "days_per_year", e.target.value)}
            />
          </label>
          <div className="col-span-2">
            <button
              type="button"
              className="if-button-ghost text-xs w-full"
              onClick={() => onRemove(idx)}
            >
              <X size={12} /> Remove
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
