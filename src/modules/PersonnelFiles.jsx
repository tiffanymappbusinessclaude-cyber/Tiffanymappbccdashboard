// =============================================================================
// PersonnelFiles.jsx — Module 07 UI (Premium overlay v0.5.8 UI)
// -----------------------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.8 UI (Premium §4.7 Module 07)
//
// EXTREME-PII COMPLIANCE MODULE — READ MIGRATION 109 HEADER §1-§3 BEFORE
// EDITING THIS FILE. This module surfaces the most sensitive employee data
// of any Premium module: offer letters, contracts, performance reviews,
// warnings, disciplinary docs, termination records, tax forms (W-4/I-9),
// potentially medical accommodations.
//
// STORAGE MODEL (locked 2026-07-12 with Rebecca):
// File bytes DO NOT live in Supabase. Every document is stored in the agent's
// own Google Drive at /BCC/HR/Personnel Records/[staff_id]/, uploaded via
// the personnel-upload Supabase Edge Function which bridges to Composio's
// GOOGLEDRIVE_UPLOAD_FROM_URL. This UI stores ONLY the metadata locally;
// drive_file_url is revealed on demand via rpc_reveal_personnel_document
// (which logs every access to personnel_document_access_log).
//
// INSTALL PREREQ:
// Agent's Google Drive must be connected via Composio BEFORE this module
// works. The install script sets settings.drive_composio_connected = 'true'
// after verifying the connection. If that setting is missing or 'false',
// this module renders a blocking gate instead of the working UI. Agents
// working with their Claude should be routed to the install-prereq flow.
//
// ROLE ROUTING:
//   • Owner / Agent  → OwnerView    (full CRUD, all employees, manage
//                                    templates, manage manager access,
//                                    verify docs, view access log)
//   • Office Manager → ManagerView  (gated per employee via
//                                    is_personnel_files_manager RPC;
//                                    same UI as Owner minus template mgmt
//                                    and manager-access mgmt)
//   • Producer       → ProducerView (own file only: own visible docs +
//                                    forms checklist with upload buttons
//                                    on producer_uploadable form types)
//
// PRODUCER ISOLATION PRINCIPLE B.11 = FALSE (canonical) per migration 109 §2.
// This is the SECOND consecutive Premium module to hold canonical B.11 after
// Scoreboard (v0.5.7). Manager access requires either the global gate
// (settings.enable_personnel_files_manager_access = 'true') OR a per-employee
// grant in personnel_file_manager_grants — the layered Q5 model.
//
// PII LINT (defense in depth):
// The RevealDocumentModal reason field runs a client-side regex lint before
// submit, catching phone numbers, emails, SSN-shaped strings, and SF policy
// numbers. Server enforces min 3 chars for cross-employee reveals (see
// rpc_reveal_personnel_document); the lint is UX belt-and-suspenders.
//
// FIVE MODALS (all defined in this file, no cross-module imports beyond the
// standard components):
//   1. ManageFormTemplatesModal    (owner)  — CRUD on personnel_form_templates
//   2. ManageManagerAccessModal    (owner)  — global gate + per-emp grants
//   3. UploadDocumentModal         (all)    — file picker → Edge Function
//   4. RevealDocumentModal         (all)    — reason capture → RPC → open URL
//   5. VerifyDocumentModal         (own/mgr)— metadata preview → RPC
//
// FOUR DRAWER TABS (owner/mgr per-employee drawer):
//   • Documents         — full active-doc list with actions
//   • Forms Checklist   — per-employee view of required forms + status
//   • Verification Queue— unverified docs, inline verify
//   • Access Log        — audit trail (accessor, time, reason, role)
//
// NO FRAMER MOTION — established overlay convention. Motion via
// requestAnimationFrame + CSS transitions only. useCountUp hook mirrors
// the Scoreboard.jsx v0.5.7 pattern.
//
// SEED PROMPTS (paired commit to Base master PlaybookGuide.jsx v0.5.8):
//   • Onboarding completion status per employee
//   • Unverified queue triage
//   • Send W-4 / I-9 completion links
//   • Missing I-9/W-4 compliance catch
// =============================================================================

import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
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

// -----------------------------------------------------------------------------
// PII lint patterns — reveal reason field guard rail
// -----------------------------------------------------------------------------
// Defense in depth: the reveal-reason field should be a short justification
// ("Auditor requested I-9 evidence", "Employee separation review"), not a
// full-blown case note. If someone drops a policy number, SSN, phone, or
// email in here, we surface a warning inline and require confirmation before
// submit. Server-side minimum length (3 chars) is enforced in
// rpc_reveal_personnel_document; this is UX belt-and-suspenders.
const REASON_PII_PATTERNS = [
  { name: "phone number",  regex: /\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b/g },
  { name: "email address", regex: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { name: "SSN",           regex: /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g },
  { name: "SF policy #",   regex: /\b\d{2}[- ]?\d{4}[- ]?[A-Z]\d{2}[- ]?[A-Z]\d{2}\b/g },
];

// -----------------------------------------------------------------------------
// Constants — mirror the CHECK constraints in migration 109
// -----------------------------------------------------------------------------
const DOC_TYPES = [
  { value: "offer_letter",           label: "Offer Letter" },
  { value: "contract",               label: "Employment Contract" },
  { value: "review",                 label: "Performance Review" },
  { value: "warning",                label: "Written Warning" },
  { value: "disciplinary",           label: "Disciplinary Action" },
  { value: "termination",            label: "Termination Record" },
  { value: "medical_accommodation",  label: "Medical Accommodation" },
  { value: "w4",                     label: "W-4 (Federal Withholding)" },
  { value: "i9",                     label: "I-9 (Employment Authorization)" },
  { value: "other",                  label: "Other" },
];
const DOC_TYPE_MAP = Object.fromEntries(DOC_TYPES.map((d) => [d.value, d.label]));

const FORM_CATEGORIES = [
  { value: "federal_tax",              label: "Federal Tax Form" },
  { value: "state_tax",                label: "State Tax Form" },
  { value: "local_tax",                label: "Local Tax Form" },
  { value: "employment_authorization", label: "Employment Authorization" },
  { value: "benefits_election",        label: "Benefits Election" },
  { value: "agency_policy",            label: "Agency Policy Form" },
  { value: "other",                    label: "Other" },
];
const FORM_CATEGORY_MAP = Object.fromEntries(FORM_CATEGORIES.map((f) => [f.value, f.label]));

const ROLES = {
  OWNER:   "Owner / Agent",
  MANAGER: "Office Manager",
};

// Maximum client-side upload size (25 MB). Composio's server-side
// GOOGLEDRIVE_UPLOAD_FROM_URL has no hard cap, but the base64 payload
// grows the request body ~33% and Deno Edge Functions have a 6 MB
// request body cap on the free tier. Keeping this at 25 MB provides
// realistic headroom while blocking pathological cases early. Adjust
// alongside supabase/functions/personnel-upload/index.ts if the Edge
// tier is upgraded.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Employee-visible-by-default doc types (mirrors the DB trigger
// set_personnel_documents_visibility_default). Kept here for UI hinting
// only — the DB trigger is the source of truth.
const DEFAULT_EMPLOYEE_VISIBLE = new Set(["offer_letter", "contract", "w4", "i9"]);

// -----------------------------------------------------------------------------
// File-local helpers
// -----------------------------------------------------------------------------
function fmtDate(iso) {
  if (!iso) return "—";
  // Date-only fields are stored YYYY-MM-DD; append T00:00:00 so the browser
  // interprets in local time instead of UTC midnight (which would sometimes
  // display as the previous day).
  const d = iso.length === 10 ? new Date(iso + "T00:00:00") : new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}
function docTypeLabel(v) { return DOC_TYPE_MAP[v] || v || "—"; }
function formCategoryLabel(v) { return FORM_CATEGORY_MAP[v] || v || "—"; }
function formatBytes(n) {
  if (n == null || n === 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
function detectReasonPII(text) {
  if (!text) return [];
  const hits = [];
  for (const { name, regex } of REASON_PII_PATTERNS) {
    // reset lastIndex on the shared regex (they carry /g flag)
    regex.lastIndex = 0;
    const matches = text.match(regex);
    if (matches && matches.length > 0) hits.push({ name, count: matches.length });
  }
  return hits;
}
function isRequiredDocTypeMissing(templates, docCounts) {
  // Returns array of template rows whose doc_type has 0 uploads
  return (templates || [])
    .filter((t) => t.is_required && t.is_active)
    .filter((t) => !(docCounts && (docCounts[t.doc_type_produced] || 0) > 0));
}

// requestAnimationFrame count-up hook — no Framer Motion. Mirrors the
// pattern established in Scoreboard.jsx v0.5.7.
function useCountUp(target, durationMs = 750) {
  const [value, setValue] = useState(0);
  const startRef = useRef(null);
  const rafRef = useRef(null);
  const fromRef = useRef(0);
  useEffect(() => {
    fromRef.current = value;
    startRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const from = value;
    const to = Number(target) || 0;
    if (from === to) return;
    const tick = (ts) => {
      if (startRef.current == null) startRef.current = ts;
      const p = Math.min(1, (ts - startRef.current) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      setValue(from + (to - from) * eased);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs]);
  return Math.round(value);
}

// -----------------------------------------------------------------------------
// DriveConnectGate — install prereq check
// -----------------------------------------------------------------------------
// Queries settings.drive_composio_connected. Renders a blocking banner if the
// setting is missing or not 'true'. This is the guardrail against agents
// hitting Upload/Reveal before their Claude has completed the install-time
// Composio Google Drive connect step.
function DriveConnectGate({ agencyId, children }) {
  const [state, setState] = useState({ loading: true, connected: false });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("settings")
        .select("setting_value")
        .eq("agency_id", agencyId)
        .eq("setting_key", "drive_composio_connected")
        .maybeSingle();
      if (cancelled) return;
      if (error) { setState({ loading: false, connected: false }); return; }
      const raw = String(data?.setting_value || "").toLowerCase().trim();
      setState({ loading: false, connected: raw === "true" });
    })();
    return () => { cancelled = true; };
  }, [agencyId]);

  if (state.loading) return <LoadingState label="Checking install status…" />;
  if (state.connected) return children;

  return (
    <div className="p-6">
      <SectionHeader
        title="Personnel Files"
        subtitle="Install prereq not met"
      />
      <div className="mt-4 rounded-lg border-2 border-amber-400 bg-amber-50 p-6">
        <div className="flex items-start gap-3">
          <div className="mt-1 text-amber-600">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-amber-900">
              Google Drive connection required
            </h3>
            <p className="mt-2 text-sm text-amber-900">
              Personnel Files stores document bytes in your Google Drive (via
              Composio), not in this database — that keeps the most sensitive
              employee data under your own Drive's access controls and audit
              log. Before this module works, your Claude needs to complete
              the Composio Google Drive connect step for this agency.
            </p>
            <div className="mt-4 rounded-md bg-white p-4 border border-amber-300">
              <p className="text-sm font-semibold text-slate-800">
                Ask your Claude:
              </p>
              <p className="mt-2 text-sm text-slate-700 italic">
                "Help me connect my Google Drive to Composio for the Business
                Command Center so I can start using the Personnel Files
                module."
              </p>
            </div>
            <p className="mt-3 text-xs text-amber-800">
              Once connected, your Claude will flip
              <code className="mx-1 px-1.5 py-0.5 rounded bg-amber-100 font-mono text-xs">
                settings.drive_composio_connected
              </code>
              to <code className="mx-1 px-1.5 py-0.5 rounded bg-amber-100 font-mono text-xs">true</code>
              and this gate will lift automatically on your next visit.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}


// =============================================================================
// Main component export
// =============================================================================
export default function PersonnelFiles() {
  const { data: profile, loading, error } = useMyProfile();

  if (loading) {
    return <LoadingState label="Loading your profile…" />;
  }
  if (error) {
    return (
      <div className="p-6">
        <EmptyState
          title="Couldn't load your profile"
          description={String(error?.message || error)}
        />
      </div>
    );
  }
  if (!profile) {
    return (
      <div className="p-6">
        <EmptyState
          title="Not signed in"
          description="You must be signed in to view Personnel Files."
        />
      </div>
    );
  }

  const isOwner   = profile.role === ROLES.OWNER;
  const isManager = profile.role === ROLES.MANAGER;

  return (
    <DriveConnectGate agencyId={profile.agency_id}>
      {isOwner ? (
        <OwnerView profile={profile} />
      ) : isManager ? (
        <ManagerView profile={profile} />
      ) : (
        <ProducerView profile={profile} />
      )}
    </DriveConnectGate>
  );
}

// =============================================================================
// OwnerView — full CRUD + template mgmt + manager access mgmt
// =============================================================================
function OwnerView({ profile }) {
  const agencyId = profile.agency_id;

  // Data — employees, templates, summary-per-employee
  const {
    data: staffRows, refetch: refetchStaff, loading: staffLoading,
  } = useSupabaseQuery(
    () => supabase
      .from("staff")
      .select("id, full_name, role, status, hire_date")
      .eq("agency_id", agencyId)
      .in("status", ["active", "on_leave"])
      .order("full_name", { ascending: true }),
    [agencyId],
  );

  const {
    data: templateRows, refetch: refetchTemplates,
  } = useSupabaseQuery(
    () => supabase
      .from("personnel_form_templates")
      .select("*")
      .eq("agency_id", agencyId)
      .eq("is_active", true)
      .order("display_order", { ascending: true }),
    [agencyId],
  );

  // Per-employee summary (doc counts + missing required count) — batched
  const [summaryByStaff, setSummaryByStaff] = useState({});
  const [summaryLoading, setSummaryLoading] = useState(false);
  useEffect(() => {
    if (!staffRows || staffRows.length === 0) return;
    let cancelled = false;
    (async () => {
      setSummaryLoading(true);
      const results = await Promise.all(
        staffRows.map((s) =>
          supabase.rpc("rpc_get_personnel_summary", { p_target_staff_id: s.id })
            .then(({ data, error }) => ({ id: s.id, data, error }))
            .catch((err) => ({ id: s.id, data: null, error: err }))
        )
      );
      if (cancelled) return;
      const next = {};
      for (const r of results) {
        if (!r.error && r.data) next[r.id] = r.data;
      }
      setSummaryByStaff(next);
      setSummaryLoading(false);
    })();
    return () => { cancelled = true; };
  }, [staffRows]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refetchStaff(), refetchTemplates()]);
  }, [refetchStaff, refetchTemplates]);

  // Filter / search
  const [searchTerm, setSearchTerm] = useState("");
  const filteredStaff = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return staffRows || [];
    return (staffRows || []).filter((s) =>
      (s.full_name || "").toLowerCase().includes(q) ||
      (s.role || "").toLowerCase().includes(q)
    );
  }, [staffRows, searchTerm]);

  // Modals + drawer state
  const [openTemplateMgr, setOpenTemplateMgr] = useState(false);
  const [openManagerAccessMgr, setOpenManagerAccessMgr] = useState(false);
  const [drawerStaff, setDrawerStaff] = useState(null);

  // Compliance rollup — how many employees are missing any required doc
  const complianceRollup = useMemo(() => {
    if (!staffRows) return { total: 0, missing: 0, verifiedPct: 0 };
    let total = 0, missing = 0, verified = 0, docs = 0;
    for (const s of staffRows) {
      total += 1;
      const sm = summaryByStaff[s.id];
      if (!sm) continue;
      if ((sm.missing_required_count || 0) > 0) missing += 1;
      verified += sm.verified_count || 0;
      docs += (sm.verified_count || 0) + (sm.unverified_count || 0);
    }
    const verifiedPct = docs > 0 ? Math.round((verified / docs) * 100) : 0;
    return { total, missing, verifiedPct };
  }, [staffRows, summaryByStaff]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionHeader
          title="Personnel Files"
          subtitle="Onboarding, compliance, and employee records — stored in your Google Drive, tracked here."
        />
        <div className="flex gap-2">
          <AskClaudeButton context="personnel_files.owner" />
          <button
            type="button"
            onClick={() => setOpenTemplateMgr(true)}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            Manage Form Templates
          </button>
          <button
            type="button"
            onClick={() => setOpenManagerAccessMgr(true)}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            Manage Manager Access
          </button>
        </div>
      </div>

      {/* Rollup tiles */}
      <div className="grid gap-3 md:grid-cols-3">
        <ComplianceTile
          title="Employees on file"
          value={complianceRollup.total}
          hint="Active + on-leave staff"
        />
        <ComplianceTile
          title="Missing a required form"
          value={complianceRollup.missing}
          hint={complianceRollup.missing === 0 ? "All employees compliant" : "Click a card to see gaps"}
          tone={complianceRollup.missing > 0 ? "danger" : "ok"}
        />
        <ComplianceTile
          title="Verified documents"
          value={complianceRollup.verifiedPct}
          suffix="%"
          hint="Of all uploaded docs"
        />
      </div>

      {/* Search */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search by name or role…"
          className="w-full max-w-md rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <span className="text-xs text-slate-500">
          {filteredStaff.length} of {(staffRows || []).length}
        </span>
      </div>

      {/* Roster grid */}
      {staffLoading ? (
        <LoadingState label="Loading employees…" />
      ) : filteredStaff.length === 0 ? (
        <EmptyState
          title="No employees found"
          description={
            searchTerm
              ? "Try clearing the search or checking a different name."
              : "Add active staff members in the Staff module first."
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredStaff.map((s) => (
            <RosterCard
              key={s.id}
              employee={s}
              summary={summaryByStaff[s.id]}
              loading={summaryLoading && !summaryByStaff[s.id]}
              onClick={() => setDrawerStaff(s)}
            />
          ))}
        </div>
      )}

      {/* Drawer */}
      <EmployeeDrawer
        open={!!drawerStaff}
        onClose={() => setDrawerStaff(null)}
        employee={drawerStaff}
        agencyId={agencyId}
        profile={profile}
        templates={templateRows || []}
        canManage={true}
        onRefresh={refreshAll}
        onSummaryRefresh={async () => {
          if (!drawerStaff) return;
          const { data } = await supabase.rpc(
            "rpc_get_personnel_summary",
            { p_target_staff_id: drawerStaff.id },
          );
          if (data) setSummaryByStaff((prev) => ({ ...prev, [drawerStaff.id]: data }));
        }}
      />

      {/* Owner-only modals */}
      <ManageFormTemplatesModal
        open={openTemplateMgr}
        onClose={() => setOpenTemplateMgr(false)}
        agencyId={agencyId}
        profile={profile}
        onChange={refreshAll}
      />
      <ManageManagerAccessModal
        open={openManagerAccessMgr}
        onClose={() => setOpenManagerAccessMgr(false)}
        agencyId={agencyId}
        profile={profile}
        onChange={refreshAll}
      />
    </div>
  );
}

// =============================================================================
// ManagerView — gated per employee, subset of Owner UI
// =============================================================================
function ManagerView({ profile }) {
  const agencyId = profile.agency_id;

  // Discover which employees the manager can see — probe
  // is_personnel_files_manager per active staff row. Cheap: STABLE
  // SECURITY DEFINER function, negligible cost per call.
  const [visibleStaff, setVisibleStaff] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [summaryByStaff, setSummaryByStaff] = useState({});
  const [loadState, setLoadState] = useState({ loading: true, error: null });
  const [drawerStaff, setDrawerStaff] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");

  const loadAll = useCallback(async () => {
    setLoadState({ loading: true, error: null });
    try {
      const { data: staffRows, error: staffErr } = await supabase
        .from("staff")
        .select("id, full_name, role, status, hire_date")
        .eq("agency_id", agencyId)
        .in("status", ["active", "on_leave"])
        .order("full_name", { ascending: true });
      if (staffErr) throw staffErr;

      const gateResults = await Promise.all(
        (staffRows || []).map((s) =>
          supabase
            .rpc("is_personnel_files_manager", { p_target_staff_id: s.id })
            .then(({ data, error }) => ({ id: s.id, allowed: !!data, error }))
            .catch(() => ({ id: s.id, allowed: false }))
        )
      );
      const allowedIds = new Set(
        gateResults.filter((r) => r.allowed).map((r) => r.id)
      );
      const gated = (staffRows || []).filter((s) => allowedIds.has(s.id));

      const { data: tRows, error: tErr } = await supabase
        .from("personnel_form_templates")
        .select("*")
        .eq("agency_id", agencyId)
        .eq("is_active", true)
        .order("display_order", { ascending: true });
      if (tErr) throw tErr;

      const summaries = await Promise.all(
        gated.map((s) =>
          supabase
            .rpc("rpc_get_personnel_summary", { p_target_staff_id: s.id })
            .then(({ data }) => ({ id: s.id, data }))
            .catch(() => ({ id: s.id, data: null }))
        )
      );
      const summaryMap = {};
      for (const r of summaries) if (r.data) summaryMap[r.id] = r.data;

      setVisibleStaff(gated);
      setTemplates(tRows || []);
      setSummaryByStaff(summaryMap);
      setLoadState({ loading: false, error: null });
    } catch (err) {
      setLoadState({ loading: false, error: err });
    }
  }, [agencyId]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const filteredStaff = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return visibleStaff || [];
    return (visibleStaff || []).filter((s) =>
      (s.full_name || "").toLowerCase().includes(q) ||
      (s.role || "").toLowerCase().includes(q)
    );
  }, [visibleStaff, searchTerm]);

  if (loadState.loading) return <LoadingState label="Checking access…" />;
  if (loadState.error) {
    return (
      <div className="p-6">
        <EmptyState
          title="Couldn't load personnel data"
          description={String(loadState.error?.message || loadState.error)}
        />
      </div>
    );
  }

  if (!visibleStaff || visibleStaff.length === 0) {
    return (
      <div className="p-6 space-y-4">
        <SectionHeader
          title="Personnel Files"
          subtitle="Manager view"
        />
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center">
          <p className="text-sm text-slate-700">
            You don't have access to any personnel files right now.
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Access is controlled by the owner. If you should have visibility
            into a specific employee's file for a legitimate reason (audit,
            benefits enrollment, corrective action), ask the owner to grant
            access through Manage Manager Access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionHeader
          title="Personnel Files"
          subtitle={`Manager view — ${visibleStaff.length} employee${visibleStaff.length === 1 ? "" : "s"} accessible to you.`}
        />
        <AskClaudeButton context="personnel_files.manager" />
      </div>

      <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900">
        Your access is scoped by the owner. Every reveal and verify action you
        take is logged to the personnel document access log. Producers cannot
        see who accessed their file.
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search accessible employees…"
          className="w-full max-w-md rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <span className="text-xs text-slate-500">
          {filteredStaff.length} of {visibleStaff.length}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filteredStaff.map((s) => (
          <RosterCard
            key={s.id}
            employee={s}
            summary={summaryByStaff[s.id]}
            onClick={() => setDrawerStaff(s)}
          />
        ))}
      </div>

      <EmployeeDrawer
        open={!!drawerStaff}
        onClose={() => setDrawerStaff(null)}
        employee={drawerStaff}
        agencyId={agencyId}
        profile={profile}
        templates={templates}
        canManage={true}
        onRefresh={loadAll}
        onSummaryRefresh={async () => {
          if (!drawerStaff) return;
          const { data } = await supabase.rpc(
            "rpc_get_personnel_summary",
            { p_target_staff_id: drawerStaff.id },
          );
          if (data) setSummaryByStaff((prev) => ({ ...prev, [drawerStaff.id]: data }));
        }}
      />
    </div>
  );
}


// =============================================================================
// ProducerView — My personnel file
// =============================================================================
function ProducerView({ profile }) {
  const agencyId = profile.agency_id;
  const myStaffId = profile.id;

  const [file, setFile] = useState(null);           // personnel_files row (or null if none yet)
  const [documents, setDocuments] = useState([]);    // producer-visible personnel_documents
  const [templates, setTemplates] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: fileRow }, { data: docsRows }, { data: tRows }, { data: sumRow }] =
        await Promise.all([
          supabase
            .from("personnel_files")
            .select("*")
            .eq("agency_id", agencyId)
            .eq("staff_id", myStaffId)
            .maybeSingle(),
          // Producer RLS only returns own visible docs
          supabase
            .from("personnel_documents")
            .select("id, doc_type, title, uploaded_at, verified_at, is_employee_visible, is_active, effective_date, expiration_date, original_filename, file_size_bytes, mime_type")
            .eq("agency_id", agencyId)
            .eq("is_active", true)
            .order("uploaded_at", { ascending: false }),
          supabase
            .from("personnel_form_templates")
            .select("*")
            .eq("agency_id", agencyId)
            .eq("is_active", true)
            .order("display_order", { ascending: true }),
          supabase
            .rpc("rpc_get_personnel_summary", { p_target_staff_id: myStaffId }),
        ]);
      setFile(fileRow || null);
      setDocuments(docsRows || []);
      setTemplates(tRows || []);
      setSummary(sumRow || null);
      setLoading(false);
    } catch (err) {
      setError(err);
      setLoading(false);
    }
  }, [agencyId, myStaffId]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Modal state
  const [uploadTemplate, setUploadTemplate] = useState(null); // template row we're uploading against
  const [revealDoc, setRevealDoc] = useState(null);

  // Producer-uploadable templates only
  const uploadableTemplates = useMemo(
    () => (templates || []).filter((t) => t.producer_uploadable && t.is_active),
    [templates],
  );
  // Map doc_type -> matched doc rows (own uploads)
  const docsByType = useMemo(() => {
    const m = {};
    for (const d of documents) {
      const k = d.doc_type;
      if (!m[k]) m[k] = [];
      m[k].push(d);
    }
    return m;
  }, [documents]);

  if (loading) return <LoadingState label="Loading your personnel file…" />;
  if (error) {
    return (
      <div className="p-6">
        <EmptyState
          title="Couldn't load your file"
          description={String(error?.message || error)}
        />
      </div>
    );
  }

  const missingRequired = summary?.missing_required_count || 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionHeader
          title="My Personnel File"
          subtitle="Complete required forms, upload signed copies, and see what your employer has on file for you."
        />
        <AskClaudeButton context="personnel_files.producer" />
      </div>

      {/* Rollup */}
      <div className="grid gap-3 md:grid-cols-3">
        <StatCard
          title="Documents on file"
          value={documents.length}
          hint="Visible to you"
        />
        <StatCard
          title="Verified"
          value={summary?.verified_count || 0}
          hint="Reviewed by your employer"
        />
        <StatCard
          title="Required forms outstanding"
          value={missingRequired}
          hint={missingRequired === 0 ? "You're all caught up" : "Complete these next"}
          tone={missingRequired > 0 ? "danger" : "ok"}
        />
      </div>

      {/* Compliance banner if missing anything required */}
      {missingRequired > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          You have <strong>{missingRequired}</strong> required form
          {missingRequired === 1 ? "" : "s"} outstanding. Scroll down to the
          <em> Forms Checklist </em> to download blanks and upload your
          completed copies.
        </div>
      )}

      {/* My documents */}
      <div>
        <h3 className="text-base font-semibold text-slate-900 mb-3">
          My Documents
        </h3>
        {documents.length === 0 ? (
          <EmptyState
            title="No documents on file yet"
            description="Uploads and verified documents appear here. Start by completing the required forms below."
          />
        ) : (
          <div className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
            {documents.map((d) => (
              <ProducerDocumentRow
                key={d.id}
                doc={d}
                onReveal={() => setRevealDoc(d)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Forms Checklist */}
      <div>
        <h3 className="text-base font-semibold text-slate-900 mb-3">
          Forms Checklist
        </h3>
        <p className="text-xs text-slate-600 mb-3">
          Required forms are marked with a red asterisk. Click <em>Download blank</em> to
          get the fillable PDF, complete it, then click <em>Upload completed</em>.
        </p>
        {uploadableTemplates.length === 0 && templates.length === 0 ? (
          <EmptyState
            title="No forms configured yet"
            description="Your employer hasn't published any form templates. Ask them to set up the checklist."
          />
        ) : (
          <div className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
            {templates.map((t) => (
              <FormChecklistRow
                key={t.id}
                template={t}
                matchedDocs={docsByType[t.doc_type_produced] || []}
                onUpload={t.producer_uploadable ? () => setUploadTemplate(t) : null}
              />
            ))}
          </div>
        )}
      </div>

      {/* Modals */}
      {uploadTemplate && (
        <UploadDocumentModal
          open={!!uploadTemplate}
          onClose={() => setUploadTemplate(null)}
          agencyId={agencyId}
          profile={profile}
          targetStaffId={myStaffId}
          personnelFileId={file?.id || null}
          allowedDocTypes={[uploadTemplate.doc_type_produced]}
          defaultTitle={uploadTemplate.name}
          templateContext={uploadTemplate}
          onUploaded={loadAll}
        />
      )}
      {revealDoc && (
        <RevealDocumentModal
          open={!!revealDoc}
          onClose={() => setRevealDoc(null)}
          document={revealDoc}
          profile={profile}
        />
      )}
    </div>
  );
}

// =============================================================================
// ComplianceTile — owner rollup tiles with count-up animation
// =============================================================================
function ComplianceTile({ title, value, suffix = "", hint, tone = "neutral" }) {
  const animated = useCountUp(value || 0);
  const toneClasses =
    tone === "danger"
      ? "border-red-300 bg-red-50"
      : tone === "ok"
      ? "border-emerald-300 bg-emerald-50"
      : "border-slate-200 bg-white";
  return (
    <div className={cn("rounded-lg border p-4", toneClasses)}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-600">
        {title}
      </p>
      <p className="mt-2 text-3xl font-bold tabular-nums text-slate-900">
        {animated}
        {suffix}
      </p>
      {hint && <p className="mt-1 text-xs text-slate-600">{hint}</p>}
    </div>
  );
}

// =============================================================================
// RosterCard — owner / manager roster grid tile
// =============================================================================
function RosterCard({ employee, summary, loading, onClick }) {
  const missing = summary?.missing_required_count || 0;
  const verified = summary?.verified_count || 0;
  const unverified = summary?.unverified_count || 0;
  const total = verified + unverified;

  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-400 hover:shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">
            {employee.full_name || "—"}
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            {employee.role || "—"}
          </p>
          {employee.hire_date && (
            <p className="mt-0.5 text-xs text-slate-500">
              Hired {fmtDate(employee.hire_date)}
            </p>
          )}
        </div>
        {employee.status === "on_leave" && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            On leave
          </span>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="text-xs text-slate-600">
          {loading ? (
            <span className="text-slate-400">Loading…</span>
          ) : (
            <>
              <span className="font-semibold text-slate-900">{total}</span> docs
              {" · "}
              <span className={verified === total && total > 0 ? "text-emerald-700" : ""}>
                {verified} verified
              </span>
            </>
          )}
        </div>
        {missing > 0 && (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
            {missing} missing required
          </span>
        )}
        {!loading && missing === 0 && total > 0 && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
            ✓ complete
          </span>
        )}
      </div>
    </button>
  );
}

// =============================================================================
// ProducerDocumentRow — read-only row in producer's "My Documents" list
// =============================================================================
function ProducerDocumentRow({ doc, onReveal }) {
  return (
    <div className="flex items-center justify-between gap-3 p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold text-slate-900">
            {doc.title}
          </p>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 whitespace-nowrap">
            {docTypeLabel(doc.doc_type)}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          Uploaded {fmtDateTime(doc.uploaded_at)}
          {doc.file_size_bytes ? ` · ${formatBytes(doc.file_size_bytes)}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {doc.verified_at ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 whitespace-nowrap">
            ✓ Verified
          </span>
        ) : (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 whitespace-nowrap">
            Pending review
          </span>
        )}
        <button
          type="button"
          onClick={onReveal}
          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50"
        >
          View
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// FormChecklistRow — producer/owner view of a form template status
// =============================================================================
function FormChecklistRow({ template, matchedDocs, onUpload }) {
  const hasUpload = matchedDocs.length > 0;
  const verified = matchedDocs.some((d) => d.verified_at);
  const status = verified ? "verified" : hasUpload ? "pending" : "not_started";

  const statusChip = {
    verified: {
      cls: "bg-emerald-100 text-emerald-800",
      label: "✓ Verified",
    },
    pending: {
      cls: "bg-amber-100 text-amber-800",
      label: "Uploaded — awaiting review",
    },
    not_started: {
      cls: template.is_required
        ? "bg-red-100 text-red-800"
        : "bg-slate-100 text-slate-700",
      label: template.is_required ? "Required — not uploaded" : "Not uploaded",
    },
  }[status];

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900">
          {template.name}
          {template.is_required && (
            <span className="ml-1 text-red-600" aria-label="required">*</span>
          )}
        </p>
        {template.description && (
          <p className="mt-0.5 text-xs text-slate-600">
            {template.description}
          </p>
        )}
        <p className="mt-0.5 text-xs text-slate-500">
          {formCategoryLabel(template.form_category)} · Produces {docTypeLabel(template.doc_type_produced)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", statusChip.cls)}>
          {statusChip.label}
        </span>
        <a
          href={template.url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50"
        >
          Download blank
        </a>
        {onUpload && (
          <button
            type="button"
            onClick={onUpload}
            className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700"
          >
            {hasUpload ? "Upload again" : "Upload completed"}
          </button>
        )}
      </div>
    </div>
  );
}


// =============================================================================
// EmployeeDrawer — owner / gated-manager per-employee side panel
// -----------------------------------------------------------------------------
// Tabs: Documents | Forms Checklist | Verification Queue | Access Log
// =============================================================================
function EmployeeDrawer({
  open, onClose, employee, agencyId, profile, templates,
  canManage, onRefresh, onSummaryRefresh,
}) {
  const [tab, setTab] = useState("documents");
  const [personnelFile, setPersonnelFile] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [accessLog, setAccessLog] = useState([]);
  const [staffLookup, setStaffLookup] = useState({});
  const [loading, setLoading] = useState(false);

  const [uploadForOwner, setUploadForOwner] = useState(false);
  const [revealDoc, setRevealDoc] = useState(null);
  const [verifyDoc, setVerifyDoc] = useState(null);

  const loadDrawer = useCallback(async () => {
    if (!employee) return;
    setLoading(true);
    try {
      const { data: fileRow } = await supabase
        .from("personnel_files")
        .select("*")
        .eq("agency_id", agencyId)
        .eq("staff_id", employee.id)
        .maybeSingle();
      setPersonnelFile(fileRow || null);

      if (fileRow) {
        const { data: docs } = await supabase
          .from("personnel_documents")
          .select("*")
          .eq("agency_id", agencyId)
          .eq("personnel_file_id", fileRow.id)
          .eq("is_active", true)
          .order("uploaded_at", { ascending: false });
        setDocuments(docs || []);

        // Access log — RLS enforces owner + gated-manager only
        const docIds = (docs || []).map((d) => d.id);
        if (docIds.length > 0) {
          const { data: log } = await supabase
            .from("personnel_document_access_log")
            .select("*")
            .in("document_id", docIds)
            .order("accessed_at", { ascending: false })
            .limit(200);
          setAccessLog(log || []);

          // Resolve accessor staff names
          const staffIds = Array.from(new Set((log || []).map((r) => r.accessed_by_staff_id)));
          if (staffIds.length > 0) {
            const { data: names } = await supabase
              .from("staff")
              .select("id, full_name")
              .in("id", staffIds);
            const map = {};
            for (const s of names || []) map[s.id] = s.full_name;
            setStaffLookup(map);
          }
        } else {
          setAccessLog([]);
        }
      } else {
        setDocuments([]);
        setAccessLog([]);
      }
      setLoading(false);
    } catch (err) {
      setLoading(false);
    }
  }, [agencyId, employee]);

  useEffect(() => { if (open) loadDrawer(); }, [open, loadDrawer]);

  // Doc counts (mirrors DB rollup)
  const docCounts = useMemo(() => {
    const m = {};
    for (const d of documents) {
      m[d.doc_type] = (m[d.doc_type] || 0) + 1;
    }
    return m;
  }, [documents]);
  const missingRequired = useMemo(
    () => isRequiredDocTypeMissing(templates, docCounts),
    [templates, docCounts],
  );
  const unverified = useMemo(
    () => documents.filter((d) => !d.verified_at),
    [documents],
  );

  const refreshEverything = useCallback(async () => {
    await loadDrawer();
    if (onSummaryRefresh) await onSummaryRefresh();
    if (onRefresh) await onRefresh();
  }, [loadDrawer, onSummaryRefresh, onRefresh]);

  if (!open || !employee) return null;

  return (
    <div className="fixed inset-0 z-40 flex" role="dialog" aria-modal="true" aria-label="Employee personnel file">
      <div
        className="absolute inset-0 bg-slate-900/40"
        onClick={onClose}
      />
      <div className="relative ml-auto flex h-full w-full max-w-3xl flex-col bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-slate-900">
              {employee.full_name}
            </h2>
            <p className="text-xs text-slate-600">
              {employee.role}
              {employee.hire_date ? ` · Hired ${fmtDate(employee.hire_date)}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canManage && (
              <button
                type="button"
                onClick={() => setUploadForOwner(true)}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
              >
                Upload document
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
              aria-label="Close"
            >
              Close
            </button>
          </div>
        </div>

        {/* Tabs */}
        <nav className="flex gap-1 border-b border-slate-200 bg-slate-50 px-4">
          {[
            { id: "documents",    label: "Documents",         count: documents.length },
            { id: "checklist",    label: "Forms Checklist",   count: missingRequired.length },
            { id: "queue",        label: "Verification Queue",count: unverified.length },
            { id: "log",          label: "Access Log",        count: accessLog.length },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                tab === t.id
                  ? "border-blue-600 text-blue-700"
                  : "border-transparent text-slate-600 hover:text-slate-900",
              )}
            >
              {t.label}
              {typeof t.count === "number" && (
                <span
                  className={cn(
                    "ml-2 rounded-full px-2 py-0.5 text-xs font-medium",
                    tab === t.id
                      ? "bg-blue-100 text-blue-800"
                      : "bg-slate-200 text-slate-700"
                  )}
                >
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <LoadingState />
          ) : tab === "documents" ? (
            <DocumentsTab
              documents={documents}
              canManage={canManage}
              onReveal={setRevealDoc}
              onVerify={setVerifyDoc}
              agencyId={agencyId}
              onRefresh={refreshEverything}
            />
          ) : tab === "checklist" ? (
            <DrawerChecklistTab
              templates={templates}
              docCounts={docCounts}
              documents={documents}
            />
          ) : tab === "queue" ? (
            <VerificationQueueTab
              documents={unverified}
              onVerify={setVerifyDoc}
              onReveal={setRevealDoc}
            />
          ) : (
            <AccessLogTab log={accessLog} staffLookup={staffLookup} />
          )}
        </div>

        {/* Modals scoped to drawer */}
        {uploadForOwner && (
          <UploadDocumentModal
            open={uploadForOwner}
            onClose={() => setUploadForOwner(false)}
            agencyId={agencyId}
            profile={profile}
            targetStaffId={employee.id}
            personnelFileId={personnelFile?.id || null}
            allowedDocTypes={null} // owner: all types
            defaultTitle=""
            templateContext={null}
            onUploaded={refreshEverything}
          />
        )}
        {revealDoc && (
          <RevealDocumentModal
            open={!!revealDoc}
            onClose={() => setRevealDoc(null)}
            document={revealDoc}
            profile={profile}
            onRevealed={refreshEverything}
          />
        )}
        {verifyDoc && (
          <VerifyDocumentModal
            open={!!verifyDoc}
            onClose={() => setVerifyDoc(null)}
            document={verifyDoc}
            profile={profile}
            onVerified={refreshEverything}
          />
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// DocumentsTab — full active-doc list with actions
// -----------------------------------------------------------------------------
function DocumentsTab({ documents, canManage, onReveal, onVerify, agencyId, onRefresh }) {
  if (documents.length === 0) {
    return (
      <EmptyState
        title="No documents on file"
        description="Upload the first document using the button in the drawer header."
      />
    );
  }
  return (
    <div className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
      {documents.map((d) => (
        <DocumentRow
          key={d.id}
          doc={d}
          canManage={canManage}
          onReveal={() => onReveal(d)}
          onVerify={() => onVerify(d)}
          onToggleVisibility={async () => {
            if (!canManage) return;
            await supabase
              .from("personnel_documents")
              .update({ is_employee_visible: !d.is_employee_visible })
              .eq("id", d.id);
            await onRefresh();
          }}
          onArchive={async () => {
            if (!canManage) return;
            if (!confirm(`Archive "${d.title}"? This soft-deletes the row and preserves the audit trail. Remember to delete the Google Drive file separately via your Claude.`)) return;
            await supabase
              .from("personnel_documents")
              .update({ is_active: false })
              .eq("id", d.id);
            await onRefresh();
          }}
        />
      ))}
    </div>
  );
}

function DocumentRow({ doc, canManage, onReveal, onVerify, onToggleVisibility, onArchive }) {
  return (
    <div className="p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-slate-900">
              {doc.title}
            </p>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 whitespace-nowrap">
              {docTypeLabel(doc.doc_type)}
            </span>
            {doc.verified_at ? (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 whitespace-nowrap">
                ✓ Verified {fmtDate(doc.verified_at)}
              </span>
            ) : (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 whitespace-nowrap">
                Unverified
              </span>
            )}
            {doc.is_employee_visible ? (
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-800 whitespace-nowrap">
                Employee sees this
              </span>
            ) : (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 whitespace-nowrap">
                Owner-only
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-600">
            {doc.original_filename || "—"}
            {doc.file_size_bytes ? ` · ${formatBytes(doc.file_size_bytes)}` : ""}
            {" · "}Uploaded {fmtDateTime(doc.uploaded_at)}
          </p>
          {(doc.effective_date || doc.expiration_date) && (
            <p className="mt-0.5 text-xs text-slate-500">
              {doc.effective_date && <>Effective {fmtDate(doc.effective_date)} </>}
              {doc.expiration_date && <>· Expires {fmtDate(doc.expiration_date)}</>}
            </p>
          )}
          {doc.notes && (
            <p className="mt-1 text-xs italic text-slate-600">{doc.notes}</p>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onReveal}
          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50"
        >
          Reveal Drive link
        </button>
        {canManage && !doc.verified_at && (
          <button
            type="button"
            onClick={onVerify}
            className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
          >
            Verify
          </button>
        )}
        {canManage && (
          <>
            <button
              type="button"
              onClick={onToggleVisibility}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50"
            >
              {doc.is_employee_visible ? "Hide from employee" : "Show to employee"}
            </button>
            <button
              type="button"
              onClick={onArchive}
              className="rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
            >
              Archive
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// DrawerChecklistTab — templated per-employee checklist (owner/mgr view)
// -----------------------------------------------------------------------------
function DrawerChecklistTab({ templates, docCounts, documents }) {
  const templatesActive = (templates || []).filter((t) => t.is_active);
  const missingReq = isRequiredDocTypeMissing(templatesActive, docCounts);

  if (templatesActive.length === 0) {
    return (
      <EmptyState
        title="No form templates configured"
        description="Use the owner Manage Form Templates action from the roster header to add the fillable forms your employees need."
      />
    );
  }

  return (
    <div className="space-y-4">
      {missingReq.length > 0 && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900">
          <strong>{missingReq.length}</strong> required form
          {missingReq.length === 1 ? "" : "s"} missing:
          {" "}
          {missingReq.map((t) => t.name).join(", ")}
        </div>
      )}
      <div className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {templatesActive.map((t) => {
          const matched = documents.filter((d) => d.doc_type === t.doc_type_produced);
          const verified = matched.some((d) => d.verified_at);
          const status = verified ? "verified" : matched.length > 0 ? "pending" : "not_started";
          const chip = {
            verified:   { cls: "bg-emerald-100 text-emerald-800", label: "✓ Verified" },
            pending:    { cls: "bg-amber-100 text-amber-800",     label: "Pending verification" },
            not_started:{
              cls: t.is_required ? "bg-red-100 text-red-800" : "bg-slate-100 text-slate-700",
              label: t.is_required ? "Required — not on file" : "Not on file",
            },
          }[status];
          return (
            <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-900">
                  {t.name}
                  {t.is_required && (
                    <span className="ml-1 text-red-600" aria-label="required">*</span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Produces {docTypeLabel(t.doc_type_produced)}
                  {" · "}
                  {matched.length} on file
                </p>
              </div>
              <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", chip.cls)}>
                {chip.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// VerificationQueueTab — unverified docs, inline verify
// -----------------------------------------------------------------------------
function VerificationQueueTab({ documents, onVerify, onReveal }) {
  if (documents.length === 0) {
    return (
      <EmptyState
        title="Nothing to verify"
        description="All documents for this employee have been reviewed and verified."
      />
    );
  }
  return (
    <div className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
      {documents.map((d) => (
        <div key={d.id} className="p-3">
          <p className="text-sm font-semibold text-slate-900">
            {d.title}
            <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
              {docTypeLabel(d.doc_type)}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            Uploaded {fmtDateTime(d.uploaded_at)}
            {d.original_filename ? ` · ${d.original_filename}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onReveal(d)}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50"
            >
              Reveal to review
            </button>
            <button
              type="button"
              onClick={() => onVerify(d)}
              className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
            >
              Mark verified
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------------
// AccessLogTab — audit trail
// -----------------------------------------------------------------------------
function AccessLogTab({ log, staffLookup }) {
  if (log.length === 0) {
    return (
      <EmptyState
        title="No access recorded yet"
        description="Every reveal of a document is logged here — accessor, role, timestamp, and stated reason."
      />
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
          <tr>
            <th className="px-3 py-2 text-left">When</th>
            <th className="px-3 py-2 text-left">Accessor</th>
            <th className="px-3 py-2 text-left">Role</th>
            <th className="px-3 py-2 text-left">Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {log.map((row) => (
            <tr key={row.id}>
              <td className="px-3 py-2 whitespace-nowrap text-xs text-slate-700">
                {fmtDateTime(row.accessed_at)}
              </td>
              <td className="px-3 py-2 text-xs text-slate-900 font-medium">
                {staffLookup[row.accessed_by_staff_id] || "—"}
              </td>
              <td className="px-3 py-2 text-xs text-slate-700">
                {row.accessor_role}
              </td>
              <td className="px-3 py-2 text-xs text-slate-700">
                {row.reason || <span className="text-slate-400 italic">— (self reveal)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


// =============================================================================
// ModalShell — shared frame for all five modals
// =============================================================================
function ModalShell({ open, onClose, title, subtitle, children, wide = false }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-slate-900/50" onClick={onClose} />
      <div className={cn(
        "relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-lg bg-white shadow-xl",
        wide ? "max-w-3xl" : "max-w-lg"
      )}>
        <div className="flex items-start justify-between border-b border-slate-200 p-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-slate-600">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

// =============================================================================
// ManageFormTemplatesModal — owner: CRUD on personnel_form_templates
// =============================================================================
function ManageFormTemplatesModal({ open, onClose, agencyId, profile, onChange }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);   // row or "new"
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("personnel_form_templates")
      .select("*")
      .eq("agency_id", agencyId)
      .order("display_order", { ascending: true });
    setRows(data || []);
    setLoading(false);
  }, [agencyId]);
  useEffect(() => { if (open) load(); }, [open, load]);

  const startNew = () => setEditing({
    id: null, name: "", description: "", url: "",
    form_category: "federal_tax", doc_type_produced: "w4",
    is_required: false, producer_uploadable: true,
    display_order: (rows.length + 1) * 10, is_active: true,
  });

  const validateForm = (row) => {
    if (!row.name || row.name.trim().length === 0) return "Name is required.";
    if (row.name.length > 200) return "Name too long (max 200).";
    if (row.description && row.description.length > 500) return "Description too long (max 500).";
    if (!row.url || row.url.trim().length === 0) return "URL is required.";
    try { new URL(row.url); } catch { return "URL must be a valid https:// link."; }
    if (!row.form_category) return "Form category is required.";
    if (!row.doc_type_produced) return "Doc type produced is required.";
    return null;
  };

  const save = async () => {
    setErr(null);
    const problem = validateForm(editing);
    if (problem) { setErr(problem); return; }
    setSaving(true);
    try {
      if (editing.id) {
        const { error } = await supabase
          .from("personnel_form_templates")
          .update({
            name: editing.name.trim(),
            description: editing.description?.trim() || null,
            url: editing.url.trim(),
            form_category: editing.form_category,
            doc_type_produced: editing.doc_type_produced,
            is_required: !!editing.is_required,
            producer_uploadable: !!editing.producer_uploadable,
            display_order: Number(editing.display_order) || 100,
            is_active: !!editing.is_active,
          })
          .eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("personnel_form_templates")
          .insert({
            agency_id: agencyId,
            name: editing.name.trim(),
            description: editing.description?.trim() || null,
            url: editing.url.trim(),
            form_category: editing.form_category,
            doc_type_produced: editing.doc_type_produced,
            is_required: !!editing.is_required,
            producer_uploadable: !!editing.producer_uploadable,
            display_order: Number(editing.display_order) || 100,
            is_active: true,
            created_by_staff_id: profile.id,
          });
        if (error) throw error;
      }
      setEditing(null);
      await load();
      if (onChange) await onChange();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (row) => {
    if (!confirm(`Deactivate "${row.name}"? Existing uploaded documents against this doc type remain intact; producers just can't upload new ones. You can reactivate anytime.`)) return;
    await supabase.from("personnel_form_templates").update({ is_active: false }).eq("id", row.id);
    await load();
    if (onChange) await onChange();
  };
  const reactivate = async (row) => {
    await supabase.from("personnel_form_templates").update({ is_active: true }).eq("id", row.id);
    await load();
    if (onChange) await onChange();
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Manage Form Templates"
      subtitle="The blank fillable forms your employees complete. Federal W-4 and I-9 come pre-seeded — add state / local / benefits forms as needed."
      wide
    >
      {editing ? (
        <FormTemplateEditor
          row={editing}
          onChange={(patch) => setEditing({ ...editing, ...patch })}
          onCancel={() => { setEditing(null); setErr(null); }}
          onSave={save}
          saving={saving}
          err={err}
        />
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs text-slate-600">
              {rows.length} template{rows.length === 1 ? "" : "s"} configured
            </p>
            <button
              type="button"
              onClick={startNew}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              + Add form template
            </button>
          </div>
          {loading ? (
            <LoadingState />
          ) : rows.length === 0 ? (
            <EmptyState title="No templates yet" description="Add W-4, I-9, state tax forms, benefits election forms, etc." />
          ) : (
            <div className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
              {rows.map((r) => (
                <div key={r.id} className={cn("flex flex-wrap items-center justify-between gap-2 p-3", !r.is_active && "opacity-60")}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900">
                      {r.name}
                      {r.is_required && <span className="ml-1 text-red-600">*</span>}
                      {!r.is_active && (
                        <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700">
                          Deactivated
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-600">
                      {formCategoryLabel(r.form_category)} · Produces {docTypeLabel(r.doc_type_produced)}
                      {" · order "}{r.display_order}
                      {r.producer_uploadable ? " · Employee-uploadable" : " · Owner-uploadable only"}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(r)}
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50"
                    >
                      Edit
                    </button>
                    {r.is_active ? (
                      <button
                        type="button"
                        onClick={() => deactivate(r)}
                        className="rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => reactivate(r)}
                        className="rounded-md border border-emerald-300 bg-white px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                      >
                        Reactivate
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </ModalShell>
  );
}

function FormTemplateEditor({ row, onChange, onCancel, onSave, saving, err }) {
  return (
    <div className="space-y-3">
      {err && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
          {err}
        </div>
      )}
      <Field label="Name" required>
        <input type="text" value={row.name} onChange={(e) => onChange({ name: e.target.value })}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          maxLength={200} placeholder="e.g. Florida W-4 (2026)" />
      </Field>
      <Field label="Description">
        <textarea value={row.description || ""} onChange={(e) => onChange({ description: e.target.value })}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" rows={2} maxLength={500}
          placeholder="Optional context shown to employees under the form name." />
      </Field>
      <Field label="URL to blank fillable form" required>
        <input type="url" value={row.url} onChange={(e) => onChange({ url: e.target.value })}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono"
          placeholder="https://…" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Form category" required>
          <select value={row.form_category} onChange={(e) => onChange({ form_category: e.target.value })}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
            {FORM_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Doc type produced" required>
          <select value={row.doc_type_produced} onChange={(e) => onChange({ doc_type_produced: e.target.value })}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
            {DOC_TYPES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Display order">
          <input type="number" value={row.display_order} onChange={(e) => onChange({ display_order: e.target.value })}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" min={0} />
        </Field>
        <Field label="Flags">
          <div className="flex flex-col gap-1 py-1.5">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!row.is_required} onChange={(e) => onChange({ is_required: e.target.checked })} />
              Required (missing = compliance flag)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!row.producer_uploadable} onChange={(e) => onChange({ producer_uploadable: e.target.checked })} />
              Employees can upload their own completed copy
            </label>
          </div>
        </Field>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" onClick={onCancel}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">
          Cancel
        </button>
        <button type="button" disabled={saving} onClick={onSave}
          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
          {saving ? "Saving…" : "Save template"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-700">
        {label}{required && <span className="ml-0.5 text-red-600">*</span>}
      </label>
      {children}
    </div>
  );
}

// =============================================================================
// ManageManagerAccessModal — owner: global gate + per-employee grants
// =============================================================================
function ManageManagerAccessModal({ open, onClose, agencyId, profile, onChange }) {
  const [globalGate, setGlobalGate] = useState(false);
  const [gateLoading, setGateLoading] = useState(false);
  const [managers, setManagers] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [grants, setGrants] = useState([]);
  const [err, setErr] = useState(null);
  const [selectedManager, setSelectedManager] = useState("");
  const [selectedTarget, setSelectedTarget] = useState("");
  const [grantReason, setGrantReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const { data: settingRow } = await supabase
        .from("settings")
        .select("setting_value")
        .eq("agency_id", agencyId)
        .eq("setting_key", "enable_personnel_files_manager_access")
        .maybeSingle();
      setGlobalGate(String(settingRow?.setting_value || "").toLowerCase() === "true");

      const { data: staffRows } = await supabase
        .from("staff")
        .select("id, full_name, role, status")
        .eq("agency_id", agencyId)
        .eq("status", "active");
      setManagers((staffRows || []).filter((s) => s.role === ROLES.MANAGER));
      setEmployees((staffRows || []).filter((s) => s.role !== ROLES.MANAGER));

      const { data: grantRows } = await supabase
        .from("personnel_file_manager_grants")
        .select("*")
        .eq("agency_id", agencyId)
        .is("revoked_at", null)
        .order("granted_at", { ascending: false });
      setGrants(grantRows || []);
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }, [agencyId]);
  useEffect(() => { if (open) load(); }, [open, load]);

  const toggleGlobalGate = async () => {
    setGateLoading(true);
    setErr(null);
    try {
      const newVal = !globalGate;
      const { error } = await supabase
        .from("settings")
        .upsert({
          agency_id: agencyId,
          setting_key: "enable_personnel_files_manager_access",
          setting_value: newVal ? "true" : "false",
        }, { onConflict: "agency_id,setting_key" });
      if (error) throw error;
      setGlobalGate(newVal);
      if (onChange) await onChange();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setGateLoading(false);
    }
  };

  const grantOne = async () => {
    setErr(null);
    if (!selectedManager || !selectedTarget) { setErr("Pick both a manager and an employee."); return; }
    if (selectedManager === selectedTarget) { setErr("Manager and target cannot be the same person."); return; }
    setBusy(true);
    try {
      const { error } = await supabase.rpc("rpc_grant_manager_personnel_access", {
        p_manager_staff_id: selectedManager,
        p_target_staff_id: selectedTarget,
        p_reason: grantReason.trim() || null,
      });
      if (error) throw error;
      setSelectedManager(""); setSelectedTarget(""); setGrantReason("");
      await load();
      if (onChange) await onChange();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (grantId) => {
    if (!confirm("Revoke this grant?")) return;
    setBusy(true);
    setErr(null);
    try {
      const { error } = await supabase.rpc("rpc_revoke_manager_personnel_access", {
        p_grant_id: grantId,
      });
      if (error) throw error;
      await load();
      if (onChange) await onChange();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const staffLookup = useMemo(() => {
    const m = {};
    for (const s of managers) m[s.id] = s.full_name;
    for (const s of employees) m[s.id] = s.full_name;
    return m;
  }, [managers, employees]);

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Manage Manager Access"
      subtitle="Personnel Files defaults CLOSED to managers. Open access two ways: a global gate (everyone), or per-employee grants (specific manager ↔ specific employee)."
      wide
    >
      {err && (
        <div className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
          {err}
        </div>
      )}
      {/* Global gate */}
      <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">
              Global manager access
            </p>
            <p className="mt-1 text-xs text-slate-600">
              When ON, every active Office Manager sees every employee's personnel file. When OFF (canonical B.11 default), managers see only employees they've been individually granted access to.
            </p>
          </div>
          <button
            type="button"
            disabled={gateLoading}
            onClick={toggleGlobalGate}
            className={cn(
              "shrink-0 rounded-md px-3 py-2 text-sm font-medium text-white",
              globalGate ? "bg-emerald-600 hover:bg-emerald-700" : "bg-slate-500 hover:bg-slate-600"
            )}
          >
            {gateLoading ? "…" : globalGate ? "ON" : "OFF"}
          </button>
        </div>
      </div>

      {/* Per-employee grants */}
      <div className="space-y-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">
            Per-employee grants
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            Additive with the global gate. Useful for scoped scenarios: "Sarah manages Sam's onboarding; grant her access to Sam only."
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Manager">
            <select value={selectedManager} onChange={(e) => setSelectedManager(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
              <option value="">— pick a manager —</option>
              {managers.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
            </select>
          </Field>
          <Field label="Target employee">
            <select value={selectedTarget} onChange={(e) => setSelectedTarget(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
              <option value="">— pick an employee —</option>
              {employees.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Reason (optional, ≤ 200 chars)">
          <input type="text" value={grantReason} onChange={(e) => setGrantReason(e.target.value)}
            maxLength={200}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="e.g. Managing new-hire onboarding" />
        </Field>
        <div className="flex justify-end">
          <button type="button" disabled={busy} onClick={grantOne}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
            {busy ? "Working…" : "Grant access"}
          </button>
        </div>

        <div className="mt-4">
          <p className="mb-2 text-sm font-semibold text-slate-900">
            Active grants ({grants.length})
          </p>
          {grants.length === 0 ? (
            <EmptyState title="No per-employee grants" description="Managers currently see nothing unless the global gate is ON." />
          ) : (
            <div className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
              {grants.map((g) => (
                <div key={g.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-slate-900">
                      <strong>{staffLookup[g.manager_staff_id] || "—"}</strong>
                      {" → "}
                      <strong>{staffLookup[g.target_staff_id] || "—"}</strong>
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Granted {fmtDateTime(g.granted_at)}
                      {g.reason ? ` · ${g.reason}` : ""}
                    </p>
                  </div>
                  <button type="button" onClick={() => revoke(g.id)} disabled={busy}
                    className="rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60">
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}


// =============================================================================
// UploadDocumentModal — file picker → Edge Function → DB row
// -----------------------------------------------------------------------------
// Producer flow: allowedDocTypes is a single-element array locked to the
// template being uploaded against; defaultTitle is set from the template name.
// Owner flow: allowedDocTypes is null (all types); defaultTitle is blank.
// -----------------------------------------------------------------------------
// The Edge Function (supabase/functions/personnel-upload/index.ts) handles:
//   1. Auth verification via Bearer JWT
//   2. Authorization matching the RLS semantics of personnel_documents
//   3. Ensuring or creating the personnel_files wrapper row for the target
//   4. Resolving or creating the Drive folder tree
//      /BCC/HR/Personnel Records/[staff_id]/
//   5. Staging bytes to a private Supabase Storage temp bucket
//   6. Generating a signed URL and calling Composio
//      GOOGLEDRIVE_UPLOAD_FROM_URL server-side
//   7. INSERTing personnel_documents with the returned drive_file_id +
//      drive_file_url
//   8. Deleting the temp Storage object
// =============================================================================
function UploadDocumentModal({
  open, onClose, agencyId, profile, targetStaffId, personnelFileId,
  allowedDocTypes, defaultTitle, templateContext, onUploaded,
}) {
  const [file, setFile] = useState(null);
  const [docType, setDocType] = useState(allowedDocTypes ? allowedDocTypes[0] : "other");
  const [title, setTitle] = useState(defaultTitle || "");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [expirationDate, setExpirationDate] = useState("");
  const [notes, setNotes] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState(null);

  const allowedDocTypeOptions = useMemo(() => {
    if (!allowedDocTypes) return DOC_TYPES;
    const set = new Set(allowedDocTypes);
    return DOC_TYPES.filter((d) => set.has(d.value));
  }, [allowedDocTypes]);

  const onFilePicked = (e) => {
    setErr(null);
    const f = e.target.files?.[0] || null;
    if (!f) { setFile(null); return; }
    if (f.size > MAX_UPLOAD_BYTES) {
      setErr(`File too large (${formatBytes(f.size)}). Max is ${formatBytes(MAX_UPLOAD_BYTES)}. If you need to upload a larger file, ask your Claude to place it directly in Google Drive at /BCC/HR/Personnel Records/[staff_id]/ and record it with rpc_reveal instead.`);
      return;
    }
    setFile(f);
    if (!title && f.name) setTitle(f.name.replace(/\.[^.]+$/, ""));
  };

  const submit = async () => {
    setErr(null);
    if (!file) { setErr("Pick a file first."); return; }
    if (!title || title.trim().length === 0) { setErr("Title is required."); return; }
    if (!targetStaffId) { setErr("Missing target employee."); return; }

    setUploading(true);
    setProgress(5);
    try {
      // Base64-encode the file bytes
      const buf = await file.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      setProgress(30);

      const { data, error } = await supabase.functions.invoke("personnel-upload", {
        body: {
          agency_id: agencyId,
          target_staff_id: targetStaffId,
          personnel_file_id: personnelFileId,   // may be null; edge fn auto-creates
          doc_type: docType,
          title: title.trim(),
          effective_date: effectiveDate || null,
          expiration_date: expirationDate || null,
          notes: notes?.trim() || null,
          filename: file.name,
          mime_type: file.type || "application/octet-stream",
          file_size_bytes: file.size,
          file_base64: b64,
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setProgress(100);
      // Brief hold so user sees the 100% state
      setTimeout(async () => {
        setUploading(false);
        if (onUploaded) await onUploaded();
        onClose();
      }, 300);
    } catch (e) {
      setUploading(false);
      setProgress(0);
      setErr(String(e?.message || e));
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={uploading ? () => {} : onClose}
      title="Upload personnel document"
      subtitle={templateContext ? `Uploading against: ${templateContext.name}` : "The bytes go to your agency's Google Drive; only metadata and a Drive link are stored here."}
    >
      {err && (
        <div className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
          {err}
        </div>
      )}
      <div className="space-y-3">
        <Field label="File" required>
          <input
            type="file"
            onChange={onFilePicked}
            disabled={uploading}
            className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100"
          />
          {file && (
            <p className="mt-1 text-xs text-slate-600">
              {file.name} · {formatBytes(file.size)} · {file.type || "unknown type"}
            </p>
          )}
        </Field>
        <Field label="Title" required>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            disabled={uploading}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Document type" required>
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            disabled={uploading || (allowedDocTypes && allowedDocTypes.length === 1)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            {allowedDocTypeOptions.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
          {DEFAULT_EMPLOYEE_VISIBLE.has(docType) && (
            <p className="mt-1 text-xs text-slate-500">
              Default visibility: employee can see this document.
            </p>
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Effective date">
            <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)}
              disabled={uploading} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="Expiration date">
            <input type="date" value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)}
              disabled={uploading} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </Field>
        </div>
        <Field label="Notes (optional, ≤ 500 chars)">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={500}
            disabled={uploading} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="Any context that will help your future self review this doc." />
        </Field>

        {uploading && (
          <div className="rounded-md border border-blue-300 bg-blue-50 p-3">
            <p className="text-sm font-medium text-blue-900">
              Uploading to your Google Drive…
            </p>
            <div className="mt-2 h-2 w-full rounded-full bg-blue-200 overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-all duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-blue-800">
              {progress < 30 && "Preparing bytes…"}
              {progress >= 30 && progress < 90 && "Sending to Composio → Drive…"}
              {progress >= 90 && "Recording metadata…"}
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
          <button type="button" onClick={onClose} disabled={uploading}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60">
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={uploading || !file}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// -----------------------------------------------------------------------------
// arrayBufferToBase64 — chunked base64 encode (avoids call stack limits on
// very large files vs. String.fromCharCode.apply spread pattern)
// -----------------------------------------------------------------------------
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// =============================================================================
// RevealDocumentModal — reason capture (VARCHAR 200 + PII lint) → RPC → open
// =============================================================================
function RevealDocumentModal({ open, onClose, document, profile, onRevealed }) {
  const [reason, setReason] = useState("");
  const [revealing, setRevealing] = useState(false);
  const [err, setErr] = useState(null);
  const [piiHits, setPiiHits] = useState([]);
  const [piiAck, setPiiAck] = useState(false);

  // Reveal reason is only *required* for cross-employee reveals — the server
  // rpc_reveal_personnel_document skips the min-length check when caller is
  // revealing their own visible doc. To align UX we hide the reason field
  // when the doc belongs to the caller.
  const isOwnDoc = useMemo(() => {
    // Producer view fetches only own docs, so if profile.role isn't Owner or
    // Manager, this is always a self-reveal. Owner/Manager reveals are always
    // cross-employee (they don't have their own docs surfaced this way).
    return profile?.role !== ROLES.OWNER && profile?.role !== ROLES.MANAGER;
  }, [profile]);

  useEffect(() => {
    if (!open) return;
    setReason("");
    setPiiAck(false);
    setPiiHits([]);
    setErr(null);
  }, [open]);

  useEffect(() => {
    const hits = detectReasonPII(reason);
    setPiiHits(hits);
    if (hits.length === 0) setPiiAck(false);
  }, [reason]);

  const submit = async () => {
    setErr(null);
    if (!isOwnDoc) {
      const clean = reason.trim();
      if (clean.length < 3) {
        setErr("Reason must be at least 3 characters for cross-employee reveals.");
        return;
      }
      if (piiHits.length > 0 && !piiAck) {
        setErr("Your reason looks like it contains PII — acknowledge the warning below to proceed.");
        return;
      }
    }
    setRevealing(true);
    try {
      const { data, error } = await supabase.rpc("rpc_reveal_personnel_document", {
        p_document_id: document.id,
        p_reason: reason.trim() || null,
      });
      if (error) throw error;
      const url = data?.drive_file_url;
      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        setErr("Reveal succeeded but no Drive URL was returned.");
        setRevealing(false);
        return;
      }
      if (onRevealed) await onRevealed();
      setRevealing(false);
      onClose();
    } catch (e) {
      setRevealing(false);
      setErr(String(e?.message || e));
    }
  };

  return (
    <ModalShell open={open} onClose={revealing ? () => {} : onClose}
      title="Reveal document"
      subtitle="Every reveal is logged to the personnel document access log with your name, role, timestamp, and stated reason.">
      <div className="space-y-3">
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="font-semibold text-slate-900">{document?.title}</p>
          <p className="mt-0.5 text-xs text-slate-600">
            {docTypeLabel(document?.doc_type)}
            {document?.original_filename ? ` · ${document.original_filename}` : ""}
            {document?.file_size_bytes ? ` · ${formatBytes(document.file_size_bytes)}` : ""}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            Uploaded {fmtDateTime(document?.uploaded_at)}
            {document?.verified_at ? ` · Verified ${fmtDate(document.verified_at)}` : " · Unverified"}
          </p>
        </div>

        {!isOwnDoc && (
          <Field label={`Reason for reveal (required, 3-200 chars)`} required>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={200}
              disabled={revealing}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              placeholder="e.g. Auditor request, Q3 file — internal only"
            />
            <p className="mt-1 text-xs text-slate-500">
              {reason.length}/200 chars. Do not paste customer identifiers or SSNs.
            </p>
          </Field>
        )}

        {piiHits.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
            <p className="text-sm font-semibold text-amber-900">
              Possible PII detected in your reason:
            </p>
            <ul className="mt-1 text-xs text-amber-900 list-disc list-inside">
              {piiHits.map((h) => (
                <li key={h.name}>
                  {h.count} {h.name}{h.count === 1 ? "" : "s"}
                </li>
              ))}
            </ul>
            <label className="mt-2 flex items-center gap-2 text-xs text-amber-900">
              <input type="checkbox" checked={piiAck} onChange={(e) => setPiiAck(e.target.checked)} />
              I've reviewed and this reason is appropriate.
            </label>
          </div>
        )}

        {err && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
          <button type="button" onClick={onClose} disabled={revealing}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60">
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={revealing}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
            {revealing ? "Revealing…" : "Reveal & open"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// =============================================================================
// VerifyDocumentModal — read-only preview + Verify button
// =============================================================================
function VerifyDocumentModal({ open, onClose, document, profile, onVerified }) {
  const [verifying, setVerifying] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async () => {
    setErr(null);
    setVerifying(true);
    try {
      const { error } = await supabase.rpc("rpc_verify_personnel_document", {
        p_document_id: document.id,
      });
      if (error) throw error;
      if (onVerified) await onVerified();
      setVerifying(false);
      onClose();
    } catch (e) {
      setVerifying(false);
      setErr(String(e?.message || e));
    }
  };

  return (
    <ModalShell open={open} onClose={verifying ? () => {} : onClose}
      title="Verify document"
      subtitle="Marking a document verified stamps your name and timestamp. Verification is irreversible from this UI.">
      <div className="space-y-3">
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="font-semibold text-slate-900">{document?.title}</p>
          <p className="mt-0.5 text-xs text-slate-600">
            {docTypeLabel(document?.doc_type)}
            {document?.original_filename ? ` · ${document.original_filename}` : ""}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            Uploaded {fmtDateTime(document?.uploaded_at)}
          </p>
          {document?.notes && (
            <p className="mt-1 text-xs italic text-slate-600">{document.notes}</p>
          )}
        </div>

        <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
          <p className="font-semibold">Reviewer checklist:</p>
          <ul className="mt-1 list-disc list-inside space-y-0.5">
            <li>The file bytes were successfully opened via the Drive reveal link.</li>
            <li>Content matches the stated doc type and title.</li>
            <li>Signatures / dates are present where required.</li>
            <li>No missing pages or corrupted content.</li>
          </ul>
        </div>

        {err && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
          <button type="button" onClick={onClose} disabled={verifying}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60">
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={verifying}
            className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60">
            {verifying ? "Verifying…" : "Mark verified"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
