// =============================================================================
// PTOMine.jsx — Producer view of own PTO
// -----------------------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.3 (Premium §4 PTO — Phase 3b + 4 landed
// 2026-07-14: month calendar wired in, pending-request edit shipped).
//
// Routing: BCCApp.jsx dispatches nav id "pto" to this component for producer
// role. Owner and manager roles get PTOAdmin.jsx instead.
//
// Producer Isolation Principle B.11:
//   • Own balance and own requests only (RLS enforces on server via
//     pto_balances / pto_requests policies; UI here does not duplicate the
//     access check).
//   • Team availability shown as COUNTS ONLY via fn_pto_team_availability_counts
//     — never staff names.
//   • Month calendar shows ONLY own approved/pending — v_pto_my_requests is
//     RLS-filtered to the current staff on the producer role, so the same
//     view name works for both PTOMine (my rows) and PTOAdmin (all rows).
//
// Data sources (all RLS-filtered on the server):
//   • v_pto_my_balance          — single row for current user
//   • v_pto_my_requests         — own request list
//   • settings.pto_request_granularity — controls half-day toggle availability
//   • fn_pto_team_availability_counts(from_date, to_date) — counts only
//
// Display convention (Phase 2, established 2026-07-09; wired v0.5.2 2026-07-10):
//   Database stores PTO amounts in DAYS. UI displays everything in HOURS.
//   Every balance/request/accrual/used display flows through helpers in
//   ../lib/pto/format.js. Do not add a local formatter — the whole point
//   of the convention is uniformity across every PTO surface.
// =============================================================================

import { useState, useMemo } from "react";
import { Calendar, Clock, Send, X, Pencil } from "lucide-react";

import { supabase } from "../lib/supabase.js";
import { useSupabaseQuery } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";
import {
  formatDaysAsHours,
  formatDays,
  formatRequestDuration,
} from "../lib/pto/format.js";

import SectionHeader from "../components/SectionHeader.jsx";
import StatCard from "../components/StatCard.jsx";
import EmptyState from "../components/EmptyState.jsx";
import LoadingState from "../components/LoadingState.jsx";
import AskClaudeButton from "../components/AskClaudeButton.jsx";
import PTOMonthCalendar from "../components/PTOMonthCalendar.jsx";

const REQUEST_TYPES = [
  { value: "pto",         label: "Vacation (PTO)" },
  { value: "sick",        label: "Sick" },
  { value: "personal",    label: "Personal" },
  { value: "bereavement", label: "Bereavement" },
  { value: "other",       label: "Other" },
];

const HALF_DAY_PERIODS = [
  { value: "am", label: "Morning (AM)" },
  { value: "pm", label: "Afternoon (PM)" },
];

// -----------------------------------------------------------------------------
// Small utility helpers (kept file-local; do not export unless reused elsewhere)
// -----------------------------------------------------------------------------
function fmtDate(iso) {
  if (!iso) return "\u2014";
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
export default function PTOMine() {
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
  return <PTOMineImpl />;
}

function PTOMineImpl() {
  // Refetch key — bumped after mutations to re-run all queries.
  const [refreshKey, setRefreshKey] = useState(0);
  const bumpRefresh = () => setRefreshKey((k) => k + 1);

  // Own balance (single row via view)
  const balanceQuery = useSupabaseQuery(
    () => supabase.from("v_pto_my_balance").select("*").maybeSingle(),
    [refreshKey]
  );

  // Own request history
  const requestsQuery = useSupabaseQuery(
    () => supabase
      .from("v_pto_my_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50),
    [refreshKey]
  );

  // Granularity setting — governs half-day toggle availability
  const granularityQuery = useSupabaseQuery(
    () => supabase
      .from("settings")
      .select("value")
      .eq("key", "pto_request_granularity")
      .maybeSingle(),
    []
  );
  const halfDaysAllowed = granularityQuery.data?.value !== "full_day_only";

  // Team availability — next 60 days via function
  const teamAvailQuery = useSupabaseQuery(
    () => supabase.rpc("fn_pto_team_availability_counts", {}),
    [refreshKey]
  );

  // Form state — null means closed. { mode: 'create' } | { mode: 'edit', request: row }
  const [formState, setFormState] = useState(null);
  const openCreate = () => setFormState({ mode: "create" });
  const openEdit   = (row) => setFormState({ mode: "edit", request: row });
  const closeForm  = () => setFormState(null);

  const balance = balanceQuery.data;
  const requests = requestsQuery.data || [];
  const myStaffId = balance?.staff_id;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="My PTO"
        description="Your balance, request history, and upcoming team availability."
        actions={
          <AskClaudeButton
            moduleLabel="My PTO"
            subject="my balance and pending requests"
            context={{
              balance: balance || null,
              recent_requests: requests.slice(0, 10),
            }}
            suggestedPrompt="Help me understand my current PTO position and whether I have enough balance to request time off next month."
          />
        }
      />

      <BalanceStrip balance={balance} loading={balanceQuery.loading} />

      {balance?.policy_name && <PolicyInfoCard balance={balance} />}

      <section>
        <SectionHeader
          title={formState?.mode === "edit" ? "Edit request" : "Request time off"}
          actions={
            !formState && (
              <button
                type="button"
                className="if-button text-xs"
                onClick={openCreate}
                disabled={!balance?.policy_id}
              >
                <Send size={14} /> New request
              </button>
            )
          }
        />
        {!balance?.policy_id && (
          <div className="if-card border-amber-200 bg-amber-50/40">
            <p className="text-sm text-amber-900">
              You aren't assigned to a PTO policy yet. Ask your agency owner to
              assign a policy to your staff record before submitting requests.
            </p>
          </div>
        )}
        {formState && (
          <RequestForm
            key={formState.mode === "edit" ? `edit:${formState.request.id}` : "create"}
            mode={formState.mode}
            existing={formState.request || null}
            halfDaysAllowed={halfDaysAllowed}
            onSubmitted={() => {
              closeForm();
              bumpRefresh();
            }}
            onCancel={closeForm}
          />
        )}
      </section>

      <section>
        <SectionHeader
          title="My requests"
          description="Your last 50 PTO requests. Pending requests can be edited or cancelled."
        />
        <RequestsList
          requests={requests}
          loading={requestsQuery.loading}
          error={requestsQuery.error}
          onCancelled={bumpRefresh}
          onEdit={openEdit}
        />
      </section>

      <section>
        <SectionHeader
          title="Team availability"
          description="Number of colleagues on approved PTO over the next 60 days. Names are not shown."
        />
        <TeamAvailability data={teamAvailQuery.data} loading={teamAvailQuery.loading} />
      </section>

      <section>
        <SectionHeader
          title="Calendar view"
          description="Your approved and pending PTO on a monthly grid. Use \u2039 / \u203a to browse months."
        />
        <PTOMonthCalendar
          requests={requests}
          currentUserId={myStaffId}
          showCoverageFlags={false}
        />
      </section>
    </div>
  );
}

// =============================================================================
// Balance strip — three StatCards side-by-side
// =============================================================================
function BalanceStrip({ balance, loading }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <StatCard
        label="Balance available"
        value={formatDaysAsHours(balance?.balance_days, { showUnit: false })}
        sublabel="hours"
        tone="positive"
        loading={loading}
        icon={Clock}
      />
      <StatCard
        label="Accrued this period"
        value={formatDaysAsHours(balance?.accrued_this_period, { showUnit: false })}
        sublabel="hours"
        loading={loading}
      />
      <StatCard
        label="Used this period"
        value={formatDaysAsHours(balance?.used_this_period, { showUnit: false })}
        sublabel="hours"
        loading={loading}
      />
    </div>
  );
}

// =============================================================================
// Policy info card — small info block about assigned plan
// =============================================================================
function PolicyInfoCard({ balance }) {
  const patternLabels = {
    anniversary: "Anniversary-based",
    monthly: "Monthly accrual",
    biweekly: "Biweekly accrual",
    unlimited: "Unlimited PTO",
  };
  const carryoverLabels = {
    use_it_or_lose_it: "Use it or lose it",
    unlimited: "Unlimited carryover",
    capped: `Carryover capped at ${formatDays(balance.carryover_cap_days)}`,
  };

  return (
    <div className="if-card">
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div>
          <span className="text-xs uppercase tracking-wide text-if-muted block">Policy</span>
          <span className="text-if-navy font-medium">{balance.policy_name}</span>
        </div>
        <div>
          <span className="text-xs uppercase tracking-wide text-if-muted block">Accrual</span>
          <span>{patternLabels[balance.accrual_pattern] || balance.accrual_pattern}</span>
        </div>
        <div>
          <span className="text-xs uppercase tracking-wide text-if-muted block">Carryover</span>
          <span>{carryoverLabels[balance.carryover_type] || balance.carryover_type}</span>
        </div>
        {balance.carried_over_from_prior > 0 && (
          <div>
            <span className="text-xs uppercase tracking-wide text-if-muted block">
              Carried into this period
            </span>
            <span>{formatDaysAsHours(balance.carried_over_from_prior)}</span>
          </div>
        )}
        {balance.period_start && balance.period_end && (
          <div>
            <span className="text-xs uppercase tracking-wide text-if-muted block">Period</span>
            <span>{fmtDate(balance.period_start)} \u2192 {fmtDate(balance.period_end)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// RequestForm — handles both create and edit modes
// -----------------------------------------------------------------------------
// Edit mode:
//   • Hydrated from `existing` row on mount (via `key` prop bump so state
//     resets cleanly when switching between requests)
//   • Type field is display-only — rpc_edit_pto_request does NOT accept a
//     type change. To reclassify (e.g. from "personal" to "sick"), cancel
//     the request and submit a new one so the manager sees the intent shift
//     in their queue.
//   • Calls rpc_edit_pto_request instead of rpc_create_pto_request.
// =============================================================================
function RequestForm({ mode, existing, halfDaysAllowed, onSubmitted, onCancel }) {
  const isEdit = mode === "edit";
  const today  = todayISO();

  const [requestType,   setRequestType]   = useState(existing?.request_type    || "pto");
  const [startDate,     setStartDate]     = useState(existing?.start_date      || today);
  const [endDate,       setEndDate]       = useState(existing?.end_date        || today);
  const [isHalfDay,     setIsHalfDay]     = useState(existing?.is_half_day     || false);
  const [halfDayPeriod, setHalfDayPeriod] = useState(existing?.half_day_period || "am");
  const [reason,        setReason]        = useState(existing?.reason          || "");
  const [submitting,    setSubmitting]    = useState(false);
  const [error,         setError]         = useState(null);

  // Keep end_date consistent with start_date when half day is on
  const effectiveEndDate = isHalfDay ? startDate : endDate;

  // In edit mode we allow the existing start_date even if it's now in the past
  const startMin = isEdit && existing?.start_date && existing.start_date < today
    ? existing.start_date
    : today;

  const totalDays = useMemo(() => {
    if (isHalfDay) return 0.5;
    const s = new Date(startDate + "T00:00:00");
    const e = new Date(effectiveEndDate + "T00:00:00");
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
    if (e < s) return 0;
    return Math.round((e - s) / (1000 * 60 * 60 * 24)) + 1;
  }, [startDate, effectiveEndDate, isHalfDay]);

  const canSubmit = !submitting && totalDays > 0 && startDate && effectiveEndDate;

  async function handleSubmit(e) {
    e?.preventDefault?.();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      if (isEdit) {
        const { error: rpcErr } = await supabase.rpc("rpc_edit_pto_request", {
          p_request_id:      existing.id,
          p_start_date:      startDate,
          p_end_date:        effectiveEndDate,
          p_is_half_day:     isHalfDay,
          p_half_day_period: isHalfDay ? halfDayPeriod : null,
          p_reason:          reason.trim() || null,
        });
        if (rpcErr) throw rpcErr;
      } else {
        const { error: rpcErr } = await supabase.rpc("rpc_create_pto_request", {
          p_start_date:      startDate,
          p_end_date:        effectiveEndDate,
          p_is_half_day:     isHalfDay,
          p_half_day_period: isHalfDay ? halfDayPeriod : null,
          p_reason:          reason.trim() || null,
          p_request_type:    requestType,
        });
        if (rpcErr) throw rpcErr;
      }
      onSubmitted?.();
    } catch (err) {
      setError(err?.message || "Failed to save request. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const typeLabel = REQUEST_TYPES.find((t) => t.value === requestType)?.label || requestType;

  return (
    <form onSubmit={handleSubmit} className="if-card space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
            Type
          </span>
          {isEdit ? (
            <div className="h-[38px] flex items-center">
              <span className="text-if-navy font-medium">{typeLabel}</span>
              <span className="ml-2 text-xs text-if-muted">
                (cancel & resubmit to change type)
              </span>
            </div>
          ) : (
            <select
              className="if-input"
              value={requestType}
              onChange={(e) => setRequestType(e.target.value)}
            >
              {REQUEST_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          )}
        </label>

        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
            Half day
          </span>
          <div className="flex items-center gap-3 h-[38px]">
            <label className={cn(
              "inline-flex items-center gap-2 text-sm",
              !halfDaysAllowed && "opacity-50"
            )}>
              <input
                type="checkbox"
                checked={isHalfDay}
                disabled={!halfDaysAllowed}
                onChange={(e) => setIsHalfDay(e.target.checked)}
              />
              <span>
                Half day only
                {!halfDaysAllowed && " (disabled by agency policy)"}
              </span>
            </label>
          </div>
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
            {isHalfDay ? "Date" : "Start date"}
          </span>
          <input
            type="date"
            className="if-input"
            value={startDate}
            min={startMin}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </label>

        {!isHalfDay && (
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
              End date
            </span>
            <input
              type="date"
              className="if-input"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </label>
        )}

        {isHalfDay && (
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
              AM or PM
            </span>
            <select
              className="if-input"
              value={halfDayPeriod}
              onChange={(e) => setHalfDayPeriod(e.target.value)}
            >
              {HALF_DAY_PERIODS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </label>
        )}

        <div>
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
            Total
          </span>
          <div className="text-if-navy font-medium h-[38px] flex items-center">
            {totalDays > 0 ? formatDaysAsHours(totalDays) : "\u2014"}
          </div>
        </div>
      </div>

      <label className="block">
        <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">
          Reason (optional)
        </span>
        <textarea
          className="if-input"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Optional context for your manager (family event, medical, etc.)"
        />
      </label>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          className="if-button-ghost text-xs"
          onClick={onCancel}
          disabled={submitting}
        >
          <X size={14} /> Cancel
        </button>
        <button
          type="submit"
          className="if-button text-xs"
          disabled={!canSubmit}
        >
          <Send size={14} />
          {submitting
            ? (isEdit ? "Saving\u2026" : "Submitting\u2026")
            : (isEdit ? "Save changes" : "Submit request")}
        </button>
      </div>
    </form>
  );
}

// =============================================================================
// Requests list — table with edit + cancel actions on pending rows
// =============================================================================
function RequestsList({ requests, loading, error, onCancelled, onEdit }) {
  const [cancellingId, setCancellingId] = useState(null);
  const [cancelError, setCancelError] = useState(null);

  async function handleCancel(id) {
    setCancellingId(id);
    setCancelError(null);
    try {
      const { error: rpcErr } = await supabase.rpc("rpc_cancel_pto_request", {
        p_request_id: id,
      });
      if (rpcErr) throw rpcErr;
      onCancelled?.();
    } catch (err) {
      setCancelError(err?.message || "Failed to cancel request.");
    } finally {
      setCancellingId(null);
    }
  }

  if (loading) return <LoadingState message="Loading your PTO history\u2026" rows={4} />;
  if (error) {
    return (
      <div className="if-card border-red-200 bg-red-50/40">
        <p className="text-sm text-red-800">Could not load requests: {error}</p>
      </div>
    );
  }
  if (!requests || requests.length === 0) {
    return (
      <EmptyState
        icon="\ud83c\udfd6\ufe0f"
        title="No PTO requests yet"
        description="Your submitted requests will appear here."
      />
    );
  }

  return (
    <div className="if-card overflow-x-auto">
      {cancelError && (
        <div className="mb-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
          {cancelError}
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-if-muted">
          <tr className="border-b border-if-line">
            <th className="text-left py-2 pr-3">Type</th>
            <th className="text-left py-2 pr-3">Dates</th>
            <th className="text-left py-2 pr-3">Hours</th>
            <th className="text-left py-2 pr-3">Status</th>
            <th className="text-left py-2 pr-3">Reason</th>
            <th className="text-right py-2"></th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id} className="border-b border-if-line/60 last:border-b-0">
              <td className="py-2 pr-3 capitalize">{r.request_type}</td>
              <td className="py-2 pr-3">
                {r.is_half_day
                  ? `${fmtDate(r.start_date)} (${(r.half_day_period || "").toUpperCase()})`
                  : r.start_date === r.end_date
                    ? fmtDate(r.start_date)
                    : `${fmtDate(r.start_date)} \u2192 ${fmtDate(r.end_date)}`}
              </td>
              <td className="py-2 pr-3">{formatRequestDuration(r)}</td>
              <td className="py-2 pr-3"><StatusPill status={r.status} /></td>
              <td className="py-2 pr-3 max-w-[280px]">
                <div className="truncate text-if-muted" title={r.reason || r.decline_reason || ""}>
                  {r.status === "denied" && r.decline_reason
                    ? <span className="text-red-700">Declined: {r.decline_reason}</span>
                    : (r.reason || "\u2014")}
                </div>
              </td>
              <td className="py-2 text-right whitespace-nowrap">
                {r.status === "pending" && (
                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      className="if-button-ghost text-xs"
                      onClick={() => onEdit?.(r)}
                      disabled={cancellingId === r.id}
                    >
                      <Pencil size={12} /> Edit
                    </button>
                    <button
                      type="button"
                      className="if-button-ghost text-xs"
                      onClick={() => handleCancel(r.id)}
                      disabled={cancellingId === r.id}
                    >
                      <X size={12} /> {cancellingId === r.id ? "Cancelling\u2026" : "Cancel"}
                    </button>
                  </div>
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
// Team availability — counts only (no names), horizontal date list
// =============================================================================
function TeamAvailability({ data, loading }) {
  if (loading) return <LoadingState message="Loading team availability\u2026" rows={2} />;

  // Only show days where at least one person is out
  const rows = (data || []).filter((d) => (d.count_out || 0) + (d.count_half_day || 0) > 0);

  if (rows.length === 0) {
    return (
      <div className="if-card">
        <p className="text-sm text-if-muted">
          No colleagues have approved PTO in the next 60 days.
        </p>
      </div>
    );
  }

  return (
    <div className="if-card">
      <ul className="space-y-1 text-sm">
        {rows.slice(0, 30).map((d) => (
          <li key={d.on_date} className="flex items-baseline gap-3">
            <span className="text-if-muted text-xs w-28 shrink-0">{fmtDate(d.on_date)}</span>
            <span className="text-if-navy">
              {d.count_out || 0} out
              {d.count_half_day > 0 && `, ${d.count_half_day} half-day`}
            </span>
          </li>
        ))}
      </ul>
      {rows.length > 30 && (
        <p className="mt-3 text-xs text-if-muted">
          Showing the next 30 days with coverage impact. {rows.length - 30} more upcoming.
        </p>
      )}
    </div>
  );
}
