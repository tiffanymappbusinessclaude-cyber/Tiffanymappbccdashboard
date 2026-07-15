// =============================================================================
// Benefits.jsx — Employee benefits: plans, enrollments, participation
// -----------------------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.4 (Premium §4.6 Module 06)
//
// Routing: BCCApp.jsx dispatches nav id "benefits" to this component for
// owner, manager, and staff roles. What each role sees differs materially:
//   • Staff → "My enrollments" view only (self-scoped via RLS on
//     v_benefits_my_enrollments).
//   • Owner / (manager when enable_benefits_manager_access is TRUE) →
//     enrollment summary per plan, active-plans list, and enrollment
//     admin actions (create plan, upsert enrollment on behalf of staff,
//     end enrollment).
//
// Producer Isolation Principle B.11:
//   • CANONICAL FALSE default on the manager gate (comp-adjacent PII —
//     deductions, tier signals family status, dependents follow-on carries
//     beneficiaries). Owner drives enrollment workflow by default.
//   • Read (own enrollments): every staff sees their own via RLS.
//   • Read (team summary): owner OR is_benefits_manager() = true.
//   • Write (plans + enrollments): owner OR is_benefits_manager() = true.
//     Staff never write — no self-enrollment path in v1.
//
// Data sources:
//   • v_benefit_plans_active            — currently offered plans
//   • v_benefits_enrollment_summary     — per-plan stats (gated)
//   • v_benefits_my_enrollments         — enrollment detail (RLS scoped)
//   • benefits_upsert_plan(...)         — write
//   • benefits_deactivate_plan(...)     — write
//   • benefits_upsert_enrollment(...)   — write (on-behalf-of workflow)
//   • benefits_end_enrollment(...)      — write
//
// Dependents (spouse/child) are deliberately deferred to a follow-on
// migration (106a) per spec §4.6 — v1 supports enrollment_tier only.
//
// Ask Claude buttons: seeded per spec §4.6 in Base's PlaybookGuide.jsx.
// =============================================================================

import { useState, useMemo } from "react";
import { Layers, Plus, Edit3, X, Save, Users, DollarSign, ShieldCheck } from "lucide-react";

import { supabase } from "../lib/supabase.js";
import { useSupabaseQuery } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";

import SectionHeader from "../components/SectionHeader.jsx";
import StatCard from "../components/StatCard.jsx";
import EmptyState from "../components/EmptyState.jsx";
import LoadingState from "../components/LoadingState.jsx";
import AskClaudeButton from "../components/AskClaudeButton.jsx";

import { useMyProfile } from "../lib/useMyProfile.js";

// -----------------------------------------------------------------------------
// Constants + helpers
// -----------------------------------------------------------------------------
const PLAN_TYPES = [
  { value: "health",     label: "Health" },
  { value: "dental",     label: "Dental" },
  { value: "vision",     label: "Vision" },
  { value: "retirement", label: "Retirement" },
  { value: "life",       label: "Life" },
  { value: "disability", label: "Disability" },
  { value: "voluntary",  label: "Voluntary" },
  { value: "other",      label: "Other" },
];

const ENROLLMENT_TIERS = [
  { value: "employee_only",           label: "Employee only" },
  { value: "employee_plus_spouse",    label: "Employee + spouse" },
  { value: "employee_plus_children",  label: "Employee + children" },
  { value: "family",                  label: "Family" },
  { value: "waived",                  label: "Waived" },
];

function labelForPlanType(type) {
  return PLAN_TYPES.find((p) => p.value === type)?.label || type;
}
function labelForTier(tier) {
  return ENROLLMENT_TIERS.find((t) => t.value === tier)?.label || tier;
}

function fmtCurrency(n) {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  if (Number.isNaN(num)) return "—";
  return num.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}

// =============================================================================
// Main component
// =============================================================================
export default function Benefits() {
  const profile = useMyProfile();
  const isOwner = profile.data?.role === "Owner / Agent";
  const isManagerLike = profile.data?.role === "Office Manager"
                        && profile.data?.status === "active";
  // NB: canManage is optimistic; server RPCs re-check enable_benefits_manager_access.
  // If the toggle is FALSE (canonical), manager writes will fail with 42501.
  const canManage = isOwner || isManagerLike;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Benefits"
        description={
          canManage
            ? "Manage benefit offerings and enrollments. Team-wide participation is summarized below."
            : "Your active benefit enrollments."
        }
        actions={
          <AskClaudeButton
            moduleLabel="Benefits"
            subject={canManage ? "team benefits enrollment" : "my benefit enrollments"}
            context={{ mode: canManage ? "admin" : "self" }}
            suggestedPrompt={
              canManage
                ? "Give me a plain-English snapshot of my current benefits enrollment — who's enrolled in what, which plans have low participation, and anyone I should follow up with."
                : "Summarize my active benefit enrollments — what I'm on, my tier for each plan, and my per-pay-period cost."
            }
          />
        }
      />

      {canManage
        ? <AdminSurface profile={profile.data} loading={profile.loading} />
        : <StaffSurface profile={profile.data} loading={profile.loading} />}
    </div>
  );
}

// =============================================================================
// StaffSurface — self-scoped enrollments listing
// =============================================================================
function StaffSurface({ profile, loading }) {
  const myEnrollmentsQuery = useSupabaseQuery(
    () => supabase.from("v_benefits_my_enrollments").select("*"),
    []
  );

  if (loading) return <LoadingState message="Loading your benefits…" rows={3} />;
  if (!profile) return null;

  const rows = myEnrollmentsQuery.data || [];
  const active = rows.filter((r) => r.is_active);
  const historic = rows.filter((r) => !r.is_active);

  const monthlyTotal = useMemo(() => {
    return active
      .filter((r) => r.enrollment_tier !== "waived")
      .reduce((sum, r) => sum + Number(r.election_amount || 0), 0);
  }, [active]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label="Active enrollments"
          value={active.filter((r) => r.enrollment_tier !== "waived").length}
          loading={myEnrollmentsQuery.loading}
          icon={ShieldCheck}
        />
        <StatCard
          label="Waived"
          value={active.filter((r) => r.enrollment_tier === "waived").length}
          loading={myEnrollmentsQuery.loading}
        />
        <StatCard
          label="Per-pay-period total"
          value={fmtCurrency(monthlyTotal)}
          loading={myEnrollmentsQuery.loading}
          icon={DollarSign}
        />
      </div>

      <EnrollmentList
        title="Current enrollments"
        rows={active}
        loading={myEnrollmentsQuery.loading}
        error={myEnrollmentsQuery.error}
        emptyDescription="You're not enrolled in any benefit plans yet. Ask your owner for current options."
      />

      {historic.length > 0 && (
        <details>
          <summary className="text-xs uppercase tracking-wide text-if-muted cursor-pointer">
            Past enrollments ({historic.length})
          </summary>
          <div className="mt-2">
            <EnrollmentList
              title=""
              rows={historic}
              loading={false}
              error={null}
              emptyDescription="No past enrollments on record."
              compact
            />
          </div>
        </details>
      )}
    </div>
  );
}

// =============================================================================
// AdminSurface — owner/manager view: summary + plans + enrollment admin
// =============================================================================
function AdminSurface({ profile, loading }) {
  const summaryQuery = useSupabaseQuery(
    () => supabase.from("v_benefits_enrollment_summary").select("*"),
    []
  );
  const plansQuery = useSupabaseQuery(
    () => supabase.from("v_benefit_plans_active").select("*").order("plan_type").order("plan_name"),
    []
  );
  const teamQuery = useSupabaseQuery(
    () => supabase.from("staff").select("id, full_name, role").eq("status", "active").order("full_name"),
    []
  );

  const summary = summaryQuery.data || [];
  const plans   = plansQuery.data   || [];
  const team    = teamQuery.data    || [];

  const [planEditorOpen, setPlanEditorOpen] = useState(null); // "new" or plan.id
  const [enrollmentEditorOpen, setEnrollmentEditorOpen] = useState(null); // { staff_id, plan_id? } or "new"

  const totals = useMemo(() => ({
    active_plans: plans.length,
    enrolled_slots: summary.reduce((s, r) => s + (Number(r.active_enrolled_count) || 0), 0),
    total_elections: summary.reduce((s, r) => s + (Number(r.total_elections) || 0), 0),
  }), [plans, summary]);

  function refreshAll() {
    if (summaryQuery.refresh) summaryQuery.refresh();
    if (plansQuery.refresh) plansQuery.refresh();
  }

  if (loading) return <LoadingState message="Loading benefits admin…" rows={4} />;
  if (!profile) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label="Active plans"
          value={totals.active_plans}
          loading={plansQuery.loading}
          icon={Layers}
        />
        <StatCard
          label="Team enrolled slots"
          value={totals.enrolled_slots}
          loading={summaryQuery.loading}
          icon={Users}
        />
        <StatCard
          label="Total per-pay-period elections"
          value={fmtCurrency(totals.total_elections)}
          loading={summaryQuery.loading}
          icon={DollarSign}
        />
      </div>

      {planEditorOpen && (
        <PlanEditor
          agencyId={profile.agency_id}
          seed={planEditorOpen === "new" ? null : plans.find((p) => p.id === planEditorOpen) || null}
          onClose={() => setPlanEditorOpen(null)}
          onSaved={() => { setPlanEditorOpen(null); refreshAll(); }}
        />
      )}

      {enrollmentEditorOpen && (
        <EnrollmentEditor
          agencyId={profile.agency_id}
          plans={plans}
          team={team}
          seed={enrollmentEditorOpen}
          onClose={() => setEnrollmentEditorOpen(null)}
          onSaved={() => { setEnrollmentEditorOpen(null); refreshAll(); }}
        />
      )}

      <div className="if-card space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers size={16} className="text-if-navy" />
            <div className="font-medium text-if-navy">Enrollment summary by plan</div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="if-button-ghost text-xs"
              onClick={() => setEnrollmentEditorOpen("new")}
            >
              <Plus size={14} className="inline mr-1" /> Enroll staff
            </button>
            <button
              type="button"
              className="if-button text-xs"
              onClick={() => setPlanEditorOpen("new")}
            >
              <Plus size={14} className="inline mr-1" /> New plan
            </button>
          </div>
        </div>

        {summaryQuery.loading && <LoadingState message="Loading summary…" rows={2} />}
        {summaryQuery.error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
            {String(summaryQuery.error.message || summaryQuery.error)}
          </div>
        )}
        {!summaryQuery.loading && summary.length === 0 && (
          <EmptyState
            icon={Layers}
            title="No active benefit plans"
            description="Click New plan above to add your first plan."
          />
        )}
        {summary.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-if-muted border-b border-if-line">
                  <th className="text-left py-2 pr-3">Plan</th>
                  <th className="text-left py-2 pr-3">Type</th>
                  <th className="text-left py-2 pr-3">Carrier</th>
                  <th className="text-right py-2 pr-3">Enrolled</th>
                  <th className="text-right py-2 pr-3">Waived</th>
                  <th className="text-right py-2 pr-3">Unenrolled</th>
                  <th className="text-right py-2 pr-3">Total election</th>
                  <th className="text-right py-2 pr-3">Avg</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((r) => (
                  <tr key={r.plan_id} className="border-b border-if-line/40">
                    <td className="py-2 pr-3 text-if-navy font-medium">{r.plan_name}</td>
                    <td className="py-2 pr-3 text-if-muted">{labelForPlanType(r.plan_type)}</td>
                    <td className="py-2 pr-3 text-if-muted">{r.carrier || "—"}</td>
                    <td className="py-2 pr-3 text-right">{r.active_enrolled_count}</td>
                    <td className="py-2 pr-3 text-right text-if-muted">{r.waived_count}</td>
                    <td className={cn(
                      "py-2 pr-3 text-right",
                      r.unenrolled_count > 0 ? "text-amber-700" : "text-if-muted"
                    )}>{r.unenrolled_count}</td>
                    <td className="py-2 pr-3 text-right">{fmtCurrency(r.total_elections)}</td>
                    <td className="py-2 pr-3 text-right text-if-muted">{fmtCurrency(r.avg_election)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ActivePlansList
        plans={plans}
        loading={plansQuery.loading}
        error={plansQuery.error}
        onEdit={(id) => setPlanEditorOpen(id)}
        onDeactivated={refreshAll}
        agencyId={profile.agency_id}
      />
    </div>
  );
}

// =============================================================================
// EnrollmentList — reusable list of enrollment rows (used by StaffSurface)
// =============================================================================
function EnrollmentList({ title, rows, loading, error, emptyDescription, compact }) {
  if (loading) return <LoadingState message="Loading…" rows={2} />;
  if (error) {
    return (
      <div className="if-card border-red-200 bg-red-50/40">
        <div className="text-red-700 text-sm">{String(error.message || error)}</div>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title={compact ? "" : "No enrollments"}
        description={emptyDescription}
      />
    );
  }
  return (
    <div className={cn("if-card p-0", compact && "border-if-line/40")}>
      {title && <div className="px-4 pt-4 pb-2 text-xs uppercase tracking-wide text-if-muted">{title}</div>}
      <div className="divide-y divide-if-line/60">
        {rows.map((r) => (
          <div key={r.enrollment_id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-if-navy font-medium">{r.plan_name}</div>
                <div className="text-xs text-if-muted">
                  {labelForPlanType(r.plan_type)}{r.carrier ? ` · ${r.carrier}` : ""}
                </div>
                <div className="text-sm mt-1">
                  {labelForTier(r.enrollment_tier)}
                  {r.enrollment_tier !== "waived" && ` · ${fmtCurrency(r.election_amount)} / pay period`}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-if-muted">
                  {r.effective_date ? `From ${fmtDate(r.effective_date)}` : ""}
                </div>
                {r.end_date && (
                  <div className="text-xs text-if-muted">Ended {fmtDate(r.end_date)}</div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// ActivePlansList — admin listing of currently offered plans
// =============================================================================
function ActivePlansList({ plans, loading, error, onEdit, onDeactivated, agencyId }) {
  if (loading) return null;
  if (error) return null;
  if (plans.length === 0) return null;

  async function deactivate(plan) {
    if (!window.confirm(`Deactivate ${plan.plan_name}?\n\nActive enrollments in this plan will remain in the system but the plan won't accept new enrollments.`)) return;
    try {
      const { error: rpcError } = await supabase.rpc("benefits_deactivate_plan", {
        p_agency_id: agencyId,
        p_plan_id: plan.id,
      });
      if (rpcError) throw rpcError;
      if (onDeactivated) onDeactivated();
    } catch (err) {
      alert(`Could not deactivate: ${err.message || String(err)}`);
    }
  }

  return (
    <div className="if-card space-y-2">
      <div className="flex items-center gap-2">
        <ShieldCheck size={16} className="text-if-navy" />
        <div className="font-medium text-if-navy">Active plans</div>
      </div>
      <div className="divide-y divide-if-line/60">
        {plans.map((p) => (
          <div key={p.id} className="py-3 flex items-center justify-between">
            <div>
              <div className="text-if-navy font-medium">{p.plan_name}</div>
              <div className="text-xs text-if-muted">
                {labelForPlanType(p.plan_type)}{p.carrier ? ` · ${p.carrier}` : ""} · from {fmtDate(p.effective_date)}
                {p.end_date ? ` through ${fmtDate(p.end_date)}` : ""}
              </div>
            </div>
            <div className="flex gap-1 shrink-0">
              <button type="button" className="if-button-ghost text-xs" onClick={() => onEdit(p.id)}>
                <Edit3 size={12} className="inline mr-1" /> Edit
              </button>
              <button type="button" className="if-button-ghost text-xs text-red-700" onClick={() => deactivate(p)}>
                Deactivate
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// PlanEditor — create or update a benefit plan
// =============================================================================
function PlanEditor({ agencyId, seed, onClose, onSaved }) {
  const isNew = !seed;
  const [planName, setPlanName] = useState(seed?.plan_name ?? "");
  const [planType, setPlanType] = useState(seed?.plan_type ?? "health");
  const [carrier, setCarrier] = useState(seed?.carrier ?? "");
  const [effectiveDate, setEffectiveDate] = useState(seed?.effective_date ?? "");
  const [endDate, setEndDate] = useState(seed?.end_date ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (!planName.trim()) throw new Error("Plan name is required.");
      if (!effectiveDate) throw new Error("Effective date is required.");
      const { error: rpcError } = await supabase.rpc("benefits_upsert_plan", {
        p_agency_id: agencyId,
        p_plan_name: planName.trim(),
        p_plan_type: planType,
        p_carrier: carrier.trim() || null,
        p_effective_date: effectiveDate,
        p_end_date: endDate || null,
      });
      if (rpcError) throw rpcError;
      if (onSaved) onSaved();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="if-card border-if-navy/20 bg-if-cream/40 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-medium text-if-navy">
          {isNew ? "New benefit plan" : `Edit plan — ${seed.plan_name}`}
        </div>
        <button type="button" className="if-button-ghost text-xs" onClick={onClose} disabled={saving}>
          <X size={14} className="inline mr-1" /> Cancel
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Plan name</span>
          <input className="if-input" type="text" value={planName}
            onChange={(e) => setPlanName(e.target.value)} disabled={saving}
            maxLength={200} placeholder="e.g. BCBS PPO Gold" />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Plan type</span>
          <select className="if-input" value={planType}
            onChange={(e) => setPlanType(e.target.value)} disabled={saving}>
            {PLAN_TYPES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Carrier (optional)</span>
          <input className="if-input" type="text" value={carrier}
            onChange={(e) => setCarrier(e.target.value)} disabled={saving}
            maxLength={200} placeholder="e.g. BlueCross Blue Shield" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Effective date</span>
            <input className="if-input" type="date" value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)} disabled={saving} />
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">End date (optional)</span>
            <input className="if-input" type="date" value={endDate}
              onChange={(e) => setEndDate(e.target.value)} disabled={saving} />
          </label>
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
          {error}
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <button type="button" className="if-button" onClick={save} disabled={saving}>
          <Save size={14} className="inline mr-1" />
          {saving ? "Saving…" : (isNew ? "Publish plan" : "Save changes")}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// EnrollmentEditor — enroll a staff member in a plan
// =============================================================================
function EnrollmentEditor({ agencyId, plans, team, seed, onClose, onSaved }) {
  const [staffId, setStaffId] = useState(seed?.staff_id ?? "");
  const [planId, setPlanId] = useState(seed?.plan_id ?? (plans[0]?.id || ""));
  const [tier, setTier] = useState("employee_only");
  const [electionAmount, setElectionAmount] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (!staffId) throw new Error("Pick a staff member.");
      if (!planId) throw new Error("Pick a plan.");
      if (!effectiveDate) throw new Error("Effective date is required.");
      const amount = tier === "waived" ? 0 : Number(electionAmount || 0);
      if (Number.isNaN(amount) || amount < 0) throw new Error("Election amount must be a non-negative number.");
      const { error: rpcError } = await supabase.rpc("benefits_upsert_enrollment", {
        p_agency_id: agencyId,
        p_staff_id: staffId,
        p_plan_id: planId,
        p_enrollment_tier: tier,
        p_election_amount: amount,
        p_effective_date: effectiveDate,
        p_end_date: endDate || null,
      });
      if (rpcError) throw rpcError;
      if (onSaved) onSaved();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="if-card border-if-navy/20 bg-if-cream/40 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-medium text-if-navy">Enroll a team member</div>
        <button type="button" className="if-button-ghost text-xs" onClick={onClose} disabled={saving}>
          <X size={14} className="inline mr-1" /> Cancel
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Staff member</span>
          <select className="if-input" value={staffId}
            onChange={(e) => setStaffId(e.target.value)} disabled={saving}>
            <option value="">Choose…</option>
            {team.map((s) => (
              <option key={s.id} value={s.id}>
                {s.full_name} ({s.role})
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Plan</span>
          <select className="if-input" value={planId}
            onChange={(e) => setPlanId(e.target.value)} disabled={saving}>
            <option value="">Choose…</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.plan_name} ({labelForPlanType(p.plan_type)})
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Tier</span>
          <select className="if-input" value={tier}
            onChange={(e) => setTier(e.target.value)} disabled={saving}>
            {ENROLLMENT_TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
            Per-pay-period election
          </span>
          <input className="if-input" type="number" step="0.01" min="0" value={electionAmount}
            onChange={(e) => setElectionAmount(e.target.value)}
            disabled={saving || tier === "waived"}
            placeholder={tier === "waived" ? "N/A" : "e.g. 135.00"} />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Effective date</span>
          <input className="if-input" type="date" value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)} disabled={saving} />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">End date (optional)</span>
          <input className="if-input" type="date" value={endDate}
            onChange={(e) => setEndDate(e.target.value)} disabled={saving} />
        </label>
      </div>

      <div className="text-xs text-if-muted">
        If this staff member already has an active enrollment in this plan, the existing enrollment will be ended (one day before the new effective date) and a new enrollment will start.
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
          {error}
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <button type="button" className="if-button" onClick={save} disabled={saving}>
          <Save size={14} className="inline mr-1" />
          {saving ? "Saving…" : "Record enrollment"}
        </button>
      </div>
    </div>
  );
}
