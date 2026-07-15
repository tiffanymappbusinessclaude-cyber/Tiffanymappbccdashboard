// =============================================================================
// Handbook.jsx — Employee handbook viewer + editor + acknowledgment
// -----------------------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.4 (Premium §4.5 Module 05)
//
// Routing: BCCApp.jsx dispatches nav id "handbook" to this component for
// owner, manager, and staff roles. All three can VIEW the current handbook
// sections (whole team needs to read policy). Only owner and (with the
// enable_handbook_manager_access toggle, which defaults TRUE) manager can
// EDIT sections and VIEW team acknowledgment status. Any staff can
// acknowledge the current version for themselves.
//
// Producer Isolation Principle B.11:
//   • Read (sections): every active staff sees the current handbook.
//   • Read (team ack status): owner OR is_handbook_manager() (defaults TRUE —
//     deliberate deviation, migration 105 header §2).
//   • Write (section edit): owner OR is_handbook_manager().
//   • Write (ack): self only (any staff acknowledges their own read).
//
// Data sources:
//   • v_handbook_current           — active sections + current_version + editor names
//   • v_handbook_current_version   — computed current_version + last_edit_at
//   • v_handbook_ack_status        — per-staff status vs current_version
//   • handbook_upsert_section(p_agency_id, p_section_number, p_title, p_content)
//   • handbook_deactivate_section(p_agency_id, p_section_id)
//   • handbook_acknowledge(p_agency_id, p_ip_address)
//
// Ask Claude buttons: seeded per spec §4.5 in Base's PlaybookGuide.jsx —
// this file surfaces them via AskClaudeButton but does not duplicate prompt
// text (single source of truth in Base).
// =============================================================================

import { useState, useMemo } from "react";
import { BookOpen, Edit3, Plus, Check, X, AlertCircle, Save, Users } from "lucide-react";

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

// -----------------------------------------------------------------------------
// File-local helpers
// -----------------------------------------------------------------------------
function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function fmtSectionNumber(n) {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  if (Number.isNaN(num)) return "—";
  // Show as "1.0", "2.5", etc. — trim trailing zeros beyond one decimal
  return num % 1 === 0 ? `${num.toFixed(1)}` : `${num}`;
}

// =============================================================================
// Main component
// =============================================================================
export default function Handbook() {
  const profile = useMyProfile();
  const isOwner = profile.data?.role === "Owner / Agent";
  // We don't know is_handbook_manager() client-side without calling it — the
  // safe pattern is: SHOW edit affordances only when server confirms via RPC
  // errors. But UX-wise it's cleaner to hint. Assume Office Manager + active
  // status maps to manager-eligibility (setting defaults TRUE; server RPCs
  // re-check). The server is source of truth; UI is optimistic.
  const isManagerLike = profile.data?.role === "Office Manager"
                        && profile.data?.status === "active";
  const canEdit = isOwner || isManagerLike;
  const canSeeTeamAck = isOwner || isManagerLike;

  const sectionsQuery = useSupabaseQuery(
    () => supabase.from("v_handbook_current").select("*").order("section_number"),
    []
  );
  const versionQuery = useSupabaseQuery(
    () => supabase.from("v_handbook_current_version").select("*").maybeSingle(),
    []
  );
  const ackQuery = useSupabaseQuery(
    () => supabase.from("v_handbook_ack_status").select("*"),
    []
  );

  const sections = sectionsQuery.data || [];
  const version  = versionQuery.data || null;
  const ackRows  = ackQuery.data || [];

  const currentVersion = version?.current_version ?? 0;
  const activeCount    = version?.active_sections_count ?? sections.length;
  const lastEditAt     = version?.last_edit_at ?? null;

  const myAckRow = useMemo(() => {
    if (!profile.data) return null;
    return ackRows.find((r) => r.staff_id === profile.data.id) || null;
  }, [ackRows, profile.data]);

  const teamAckSummary = useMemo(() => {
    const total = ackRows.length;
    const current = ackRows.filter((r) => r.is_current).length;
    return { total, current, behind: total - current };
  }, [ackRows]);

  const [editorOpen, setEditorOpen] = useState(null); // section_id being edited, or "new" for a new section

  function handleChanged() {
    if (sectionsQuery.refresh) sectionsQuery.refresh();
    if (versionQuery.refresh)  versionQuery.refresh();
    if (ackQuery.refresh)      ackQuery.refresh();
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Employee Handbook"
        description="Team-wide policies. When you edit a section, the version bumps and everyone needs to re-acknowledge."
        actions={
          <div className="flex items-center gap-2">
            {canEdit && (
              <button
                type="button"
                className="if-button text-xs"
                onClick={() => setEditorOpen("new")}
              >
                <Plus size={14} className="inline mr-1" />
                New section
              </button>
            )}
            <AskClaudeButton
              moduleLabel="Handbook"
              subject="employee handbook acknowledgments"
              context={{ current_version: currentVersion, sections, team_ack: canSeeTeamAck ? ackRows : null }}
              suggestedPrompt="Walk me through my current employee handbook status — who has and hasn't acknowledged the latest version, when it was last updated, and anything I should flag."
            />
          </div>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label="Current version"
          value={currentVersion === 0 ? "—" : `v${currentVersion}`}
          loading={versionQuery.loading}
          icon={BookOpen}
        />
        <StatCard
          label="Active sections"
          value={activeCount}
          loading={versionQuery.loading}
        />
        {canSeeTeamAck ? (
          <StatCard
            label="Team acknowledged"
            value={`${teamAckSummary.current} / ${teamAckSummary.total}`}
            tone={teamAckSummary.behind > 0 ? "warning" : "neutral"}
            loading={ackQuery.loading}
            icon={Users}
          />
        ) : (
          <StatCard
            label="Last updated"
            value={lastEditAt ? fmtDateTime(lastEditAt).split(",")[0] : "—"}
            loading={versionQuery.loading}
          />
        )}
      </div>

      <MyAckBanner
        myAckRow={myAckRow}
        currentVersion={currentVersion}
        profile={profile.data}
        onAcknowledged={handleChanged}
        loading={profile.loading || ackQuery.loading || versionQuery.loading}
      />

      {editorOpen && (
        <SectionEditor
          agencyId={profile.data?.agency_id}
          seed={
            editorOpen === "new"
              ? null
              : sections.find((s) => s.id === editorOpen) || null
          }
          onClose={() => setEditorOpen(null)}
          onSaved={() => { setEditorOpen(null); handleChanged(); }}
        />
      )}

      <SectionsList
        sections={sections}
        loading={sectionsQuery.loading}
        error={sectionsQuery.error}
        canEdit={canEdit}
        onEdit={(sectionId) => setEditorOpen(sectionId)}
        onDeactivated={handleChanged}
        agencyId={profile.data?.agency_id}
      />

      {canSeeTeamAck && (
        <TeamAckTable
          rows={ackRows}
          currentVersion={currentVersion}
          loading={ackQuery.loading}
          error={ackQuery.error}
        />
      )}
    </div>
  );
}

// =============================================================================
// MyAckBanner — status + acknowledge button for the calling staff
// =============================================================================
function MyAckBanner({ myAckRow, currentVersion, profile, onAcknowledged, loading }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  if (loading) return null;
  if (!profile) return null;
  if (currentVersion === 0) {
    return (
      <div className="if-card border-amber-200 bg-amber-50/40">
        <div className="flex items-start gap-2">
          <AlertCircle size={16} className="text-amber-700 mt-0.5" />
          <div className="text-sm text-amber-800">
            No handbook has been published yet. Once the owner adds the first section, everyone will be prompted to acknowledge.
          </div>
        </div>
      </div>
    );
  }

  const isCurrent = myAckRow?.is_current === true;
  const versionsBehind = myAckRow?.versions_behind ?? currentVersion;

  async function acknowledge() {
    setSaving(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc("handbook_acknowledge", {
        p_agency_id: profile.agency_id,
        p_ip_address: null,
      });
      if (rpcError) throw rpcError;
      if (onAcknowledged) onAcknowledged();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  if (isCurrent) {
    return (
      <div className="if-card border-emerald-200 bg-emerald-50/40">
        <div className="flex items-start gap-2">
          <Check size={16} className="text-emerald-700 mt-0.5" />
          <div className="text-sm text-emerald-800">
            You're current on the handbook (v{currentVersion}
            {myAckRow?.last_acknowledged_at
              ? ` — acknowledged ${fmtDateTime(myAckRow.last_acknowledged_at)}`
              : ""}
            ).
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="if-card border-amber-200 bg-amber-50/40">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <AlertCircle size={16} className="text-amber-700 mt-0.5" />
          <div className="text-sm text-amber-800">
            <div className="font-medium">Please review and acknowledge the handbook.</div>
            <div className="text-xs mt-1 text-amber-800/80">
              {versionsBehind === currentVersion
                ? "You haven't acknowledged any version yet."
                : `You're ${versionsBehind} version${versionsBehind === 1 ? "" : "s"} behind — currently at v${currentVersion}.`}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="if-button text-xs shrink-0"
          onClick={acknowledge}
          disabled={saving}
        >
          <Check size={14} className="inline mr-1" />
          {saving ? "Recording…" : `Acknowledge v${currentVersion}`}
        </button>
      </div>
      {error && (
        <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          {error}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// SectionEditor — modal-ish form for creating or updating a section
// =============================================================================
function SectionEditor({ agencyId, seed, onClose, onSaved }) {
  const isNew = !seed;
  const [sectionNumber, setSectionNumber] = useState(seed?.section_number ?? "");
  const [title, setTitle] = useState(seed?.title ?? "");
  const [content, setContent] = useState(seed?.content ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const numeric = Number(sectionNumber);
      if (Number.isNaN(numeric) || numeric < 0) throw new Error("Section number must be a non-negative number (e.g. 1, 1.5, 2).");
      if (!title.trim()) throw new Error("Title is required.");
      if (!content.trim()) throw new Error("Content is required.");
      const { error: rpcError } = await supabase.rpc("handbook_upsert_section", {
        p_agency_id: agencyId,
        p_section_number: numeric,
        p_title: title.trim(),
        p_content: content,
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
          {isNew ? "New handbook section" : `Edit section ${fmtSectionNumber(seed.section_number)} — ${seed.title}`}
        </div>
        <button type="button" className="if-button-ghost text-xs" onClick={onClose} disabled={saving}>
          <X size={14} className="inline mr-1" /> Cancel
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
        <label className="block sm:col-span-1">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Section number</span>
          <input
            className="if-input"
            type="number"
            step="0.1"
            min="0"
            value={sectionNumber}
            onChange={(e) => setSectionNumber(e.target.value)}
            disabled={saving || !isNew}
            placeholder="e.g. 1.0"
          />
        </label>
        <label className="block sm:col-span-3">
          <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Title</span>
          <input
            className="if-input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={saving}
            maxLength={200}
            placeholder="e.g. Attendance and Punctuality"
          />
        </label>
      </div>
      <label className="block">
        <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Content</span>
        <textarea
          className="if-input h-64 font-mono text-sm"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          disabled={saving}
          placeholder="Write the policy content here. Plain text or lightweight markdown."
        />
        <div className="text-xs text-if-muted mt-1">
          Saving bumps this section's version and prompts everyone to re-acknowledge.
        </div>
      </label>
      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
          {error}
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <button type="button" className="if-button" onClick={save} disabled={saving}>
          <Save size={14} className="inline mr-1" />
          {saving ? "Saving…" : (isNew ? "Publish new section" : "Save + bump version")}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// SectionsList — the reader view of active sections
// =============================================================================
function SectionsList({ sections, loading, error, canEdit, onEdit, onDeactivated, agencyId }) {
  // v1.1 — search filter across section number, title, and policy content
  const [query, setQuery] = useState("");
  const filteredSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections.filter((s) =>
      String(s.section_number ?? "").toLowerCase().includes(q) ||
      String(s.title ?? "").toLowerCase().includes(q) ||
      String(s.content ?? "").toLowerCase().includes(q)
    );
  }, [sections, query]);

  if (loading) return <LoadingState message="Loading handbook…" rows={3} />;
  if (error) {
    return (
      <div className="if-card border-red-200 bg-red-50/40">
        <div className="text-red-700 text-sm font-medium">Couldn't load the handbook.</div>
        <div className="text-red-700/80 text-xs mt-1">{String(error.message || error)}</div>
      </div>
    );
  }
  if (sections.length === 0) {
    return (
      <EmptyState
        icon={BookOpen}
        title="No handbook published yet"
        description={canEdit
          ? "Click New section above to add your first policy section."
          : "The handbook hasn't been published yet. Check back once your owner adds sections."}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="if-no-print">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search handbook (titles, policy text, section numbers)…"
        />
        {query && (
          <div className="text-xs text-if-muted mt-2 pl-1">
            {filteredSections.length === 0
              ? `No sections match "${query}".`
              : `${filteredSections.length} of ${sections.length} sections`}
          </div>
        )}
      </div>
      {filteredSections.length === 0 ? (
        <div className="if-card">
          <div className="text-sm text-if-muted text-center py-8">
            No sections match "{query}". <button type="button" onClick={() => setQuery("")} className="text-if-blue underline">Clear search</button>
          </div>
        </div>
      ) : (
        <div className="if-card divide-y divide-if-line/60 p-0">
          {filteredSections.map((s) => (
            <SectionRow
              key={s.id}
              section={s}
              canEdit={canEdit}
              onEdit={() => onEdit(s.id)}
              onDeactivated={onDeactivated}
              agencyId={agencyId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// SectionRow — one policy section
// =============================================================================
function SectionRow({ section, canEdit, onEdit, onDeactivated, agencyId }) {
  const [deactivating, setDeactivating] = useState(false);
  const [error, setError] = useState(null);

  async function deactivate() {
    if (!window.confirm(`Deactivate section ${fmtSectionNumber(section.section_number)} — ${section.title}?\n\nHistorical version rows are preserved; the section just won't appear in the current handbook anymore.`)) return;
    setDeactivating(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc("handbook_deactivate_section", {
        p_agency_id: agencyId,
        p_section_id: section.id,
      });
      if (rpcError) throw rpcError;
      if (onDeactivated) onDeactivated();
    } catch (err) {
      setError(err.message || String(err));
      setDeactivating(false);
    }
  }

  return (
    <div className="p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-if-muted">
              §{fmtSectionNumber(section.section_number)} · v{section.version}
            </span>
          </div>
          <div className="text-if-navy font-medium text-base">{section.title}</div>
        </div>
        {canEdit && (
          <div className="flex gap-1 shrink-0">
            <button type="button" className="if-button-ghost text-xs" onClick={onEdit} disabled={deactivating}>
              <Edit3 size={12} className="inline mr-1" /> Edit
            </button>
            <button type="button" className="if-button-ghost text-xs text-red-700" onClick={deactivate} disabled={deactivating}>
              {deactivating ? "…" : "Deactivate"}
            </button>
          </div>
        )}
      </div>
      <div className="text-sm text-if-navy whitespace-pre-wrap">{section.content}</div>
      <div className="text-xs text-if-muted">
        Last updated {fmtDateTime(section.updated_at)}
        {section.updated_by_name ? ` by ${section.updated_by_name}` : ""}
      </div>
      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>
      )}
    </div>
  );
}

// =============================================================================
// TeamAckTable — who's current on the handbook (owner/manager only)
// =============================================================================
function TeamAckTable({ rows, currentVersion, loading, error }) {
  if (loading) return null;
  if (error) return null; // silent on this secondary view; primary reads report errors above
  if (!rows || rows.length === 0) return null;

  const behind = rows.filter((r) => !r.is_current);
  const current = rows.filter((r) => r.is_current);

  return (
    <div className="if-card space-y-3">
      <div className="flex items-center gap-2">
        <Users size={16} className="text-if-navy" />
        <div className="font-medium text-if-navy">Team acknowledgments</div>
        <span className="text-xs text-if-muted">
          {current.length} of {rows.length} current
        </span>
      </div>

      {behind.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wide text-if-muted mb-1">Need to acknowledge</div>
          <div className="divide-y divide-if-line/60">
            {behind.map((r) => (
              <div key={r.staff_id} className="py-2 flex items-center justify-between">
                <div>
                  <div className="text-sm text-if-navy">{r.full_name}</div>
                  <div className="text-xs text-if-muted">{r.role}</div>
                </div>
                <div className="text-xs text-amber-700">
                  {r.acknowledged_version === 0
                    ? "Never acknowledged"
                    : `On v${r.acknowledged_version} · ${r.versions_behind} behind`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {current.length > 0 && (
        <details>
          <summary className="text-xs uppercase tracking-wide text-if-muted cursor-pointer">
            Current on v{currentVersion} ({current.length})
          </summary>
          <div className="mt-1 divide-y divide-if-line/60">
            {current.map((r) => (
              <div key={r.staff_id} className="py-2 flex items-center justify-between">
                <div>
                  <div className="text-sm text-if-navy">{r.full_name}</div>
                  <div className="text-xs text-if-muted">{r.role}</div>
                </div>
                <div className="text-xs text-emerald-700">
                  {r.last_acknowledged_at ? fmtDateTime(r.last_acknowledged_at) : "Acknowledged"}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
