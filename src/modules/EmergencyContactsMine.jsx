// =============================================================================
// EmergencyContactsMine.jsx — Producer's own emergency contacts (CRUD)
// -----------------------------------------------------------------------------
// Overlay: bcc-premium-overlay v0.5.3 (Premium §4.10 Module 10)
//
// Routing: BCCApp.jsx dispatches nav id "emergency_contacts" to this
// component when currentUserRole === "staff". Owner and manager get
// EmergencyContacts (the reveal flow) instead.
//
// Producers manage their own emergency contacts here via direct DML
// against public.emergency_contacts. RLS scopes SELECT/INSERT/UPDATE/
// DELETE to their own row exclusively (WHERE staff_id = current_staff_id()).
//
// No AskClaudeButton on this module — by design (spec §4.10). Emergency
// contact data must not flow through Claude conversations.
// =============================================================================

import { useState, useEffect } from "react";
import { UserPlus, Pencil, Trash2, X, Check, PhoneCall, Mail, ShieldAlert } from "lucide-react";

import { supabase } from "../lib/supabase.js";
import { useSupabaseQuery } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";

import SectionHeader from "../components/SectionHeader.jsx";
import EmptyState from "../components/EmptyState.jsx";
import LoadingState from "../components/LoadingState.jsx";

const RELATIONSHIPS = [
  { value: "spouse",  label: "Spouse" },
  { value: "parent",  label: "Parent" },
  { value: "sibling", label: "Sibling" },
  { value: "child",   label: "Child" },
  { value: "friend",  label: "Friend" },
  { value: "other",   label: "Other" },
];

// =============================================================================
// Main
// =============================================================================
export default function EmergencyContactsMine() {
  const contactsQuery = useSupabaseQuery(
    () => supabase
      .from("emergency_contacts")
      .select("*")
      .order("priority", { ascending: true })
      .order("contact_name", { ascending: true }),
    []
  );

  // Fetch own staff_id — RLS on staff lets every producer see their own row
  const [myStaffId, setMyStaffId] = useState(null);
  useEffect(() => {
    async function loadMe() {
      const { data: sess } = await supabase.auth.getUser();
      if (!sess?.user?.id) return;
      const { data } = await supabase
        .from("staff")
        .select("id")
        .eq("auth_user_id", sess.user.id)
        .maybeSingle();
      if (data?.id) setMyStaffId(data.id);
    }
    loadMe();
  }, []);

  const [editing, setEditing]     = useState(null);
  const [showModal, setShowModal] = useState(false);

  const rows = contactsQuery.data || [];

  function openNew() {
    setEditing({
      staff_id: myStaffId,
      contact_name: "",
      relationship: "spouse",
      phone_primary: "",
      phone_secondary: "",
      email: "",
      priority: rows.length + 1,
      notes: "",
    });
    setShowModal(true);
  }

  function openEdit(row) {
    setEditing({ ...row });
    setShowModal(true);
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="My Emergency Contacts"
        description="People to reach if there's an emergency at work. You choose who to list; owner and manager can only see them by going through an audited emergency-access flow."
        actions={
          myStaffId && (
            <button type="button" className="if-button" onClick={openNew}>
              <UserPlus size={14} className="inline mr-1" /> Add contact
            </button>
          )
        }
      />

      {/* Reassurance strip — this data is not exposed casually */}
      <div className="if-card bg-emerald-50/60 border-emerald-200">
        <div className="flex items-start gap-3">
          <ShieldAlert className="text-emerald-700 shrink-0 mt-0.5" size={20} />
          <div>
            <div className="text-sm font-medium text-emerald-900">
              Private by default.
            </div>
            <div className="text-xs text-emerald-800/90 mt-1">
              Only you see this list. If your owner or manager needs to reach a contact during an emergency, they write a reason first, and the access is logged. Nothing here is visible in Claude conversations.
            </div>
          </div>
        </div>
      </div>

      <ContactsList
        rows={rows}
        loading={contactsQuery.loading}
        error={contactsQuery.error}
        onEdit={openEdit}
        onChanged={() => contactsQuery.refresh && contactsQuery.refresh()}
      />

      {showModal && editing && myStaffId && (
        <ContactModal
          initial={editing}
          myStaffId={myStaffId}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={() => { setShowModal(false); setEditing(null); contactsQuery.refresh && contactsQuery.refresh(); }}
        />
      )}
    </div>
  );
}

// =============================================================================
// ContactsList
// =============================================================================
function ContactsList({ rows, loading, error, onEdit, onChanged }) {
  if (loading) return <LoadingState message="Loading your contacts…" rows={3} />;
  if (error) {
    return (
      <div className="if-card border-red-200 bg-red-50/40">
        <div className="text-red-700 text-sm font-medium">Couldn't load your contacts.</div>
        <div className="text-red-700/80 text-xs mt-1">{String(error.message || error)}</div>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={UserPlus}
        title="No emergency contacts yet"
        description="Add at least one contact so someone can be reached if needed. Most people list a spouse, parent, or trusted friend."
      />
    );
  }
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <ContactCard key={r.id} row={r} onEdit={() => onEdit(r)} onDeleted={onChanged} />
      ))}
    </div>
  );
}

function ContactCard({ row, onEdit, onDeleted }) {
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy]             = useState(false);
  const [err, setErr]               = useState(null);

  async function doDelete() {
    setBusy(true); setErr(null);
    try {
      const { error: e } = await supabase.from("emergency_contacts").delete().eq("id", row.id);
      if (e) throw e;
      onDeleted && onDeleted();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false); setConfirmDel(false);
    }
  }

  return (
    <div className="if-card">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-if-navy font-medium">{row.contact_name}</span>
            <span className="text-[10px] uppercase tracking-wide text-if-muted bg-if-cream px-1.5 py-0.5 rounded">
              {RELATIONSHIPS.find((r) => r.value === row.relationship)?.label || row.relationship}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-if-muted">Priority {row.priority}</span>
          </div>
          <div className="mt-2 space-y-1 text-sm">
            {row.phone_primary && (
              <div className="flex items-center gap-2">
                <PhoneCall size={12} className="text-if-navy" />
                <span className="text-if-navy">{row.phone_primary}</span>
                <span className="text-xs text-if-muted">primary</span>
              </div>
            )}
            {row.phone_secondary && (
              <div className="flex items-center gap-2">
                <PhoneCall size={12} className="text-if-muted" />
                <span className="text-if-navy">{row.phone_secondary}</span>
                <span className="text-xs text-if-muted">secondary</span>
              </div>
            )}
            {row.email && (
              <div className="flex items-center gap-2">
                <Mail size={12} className="text-if-muted" />
                <span className="text-if-navy">{row.email}</span>
              </div>
            )}
            {row.notes && (
              <div className="text-xs text-if-muted italic mt-1">{row.notes}</div>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <button type="button" className="if-button-ghost text-xs" onClick={onEdit}>
            <Pencil size={12} className="inline mr-1" /> Edit
          </button>
          {!confirmDel ? (
            <button type="button" className="if-button-ghost text-xs text-red-700" onClick={() => setConfirmDel(true)}>
              <Trash2 size={12} className="inline mr-1" /> Delete
            </button>
          ) : (
            <div className="text-xs flex items-center gap-1">
              <span>Delete?</span>
              <button type="button" className="if-button-ghost text-red-700" onClick={doDelete} disabled={busy}>
                {busy ? "…" : "Yes"}
              </button>
              <button type="button" className="if-button-ghost" onClick={() => setConfirmDel(false)} disabled={busy}>
                No
              </button>
            </div>
          )}
        </div>
      </div>
      {err && <div className="text-xs text-red-700 mt-2">{err}</div>}
    </div>
  );
}

// =============================================================================
// ContactModal — add / edit
// =============================================================================
function ContactModal({ initial, myStaffId, onClose, onSaved }) {
  const [form, setForm]     = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  function field(name, value) {
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      if (!form.contact_name?.trim()) throw new Error("Contact name is required");
      if (!form.phone_primary?.trim()) throw new Error("A primary phone number is required");

      const payload = {
        staff_id:        myStaffId,
        contact_name:    form.contact_name.trim(),
        relationship:    form.relationship,
        phone_primary:   form.phone_primary.trim(),
        phone_secondary: form.phone_secondary?.trim() || null,
        email:           form.email?.trim() || null,
        priority:        Number(form.priority) || 1,
        notes:           form.notes?.trim() || null,
        updated_at:      new Date().toISOString(),
      };

      let err;
      if (form.id) {
        const { error: e } = await supabase.from("emergency_contacts").update(payload).eq("id", form.id);
        err = e;
      } else {
        const { error: e } = await supabase.from("emergency_contacts").insert(payload);
        err = e;
      }
      if (err) throw err;
      onSaved && onSaved();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-if-navy/30 p-4">
      <div className="if-card max-w-lg w-full bg-white">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-if-navy">
            {form.id ? "Edit contact" : "Add emergency contact"}
          </h2>
          <button type="button" className="if-button-ghost" onClick={onClose} disabled={saving}>
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Contact name</span>
            <input className="if-input" type="text" value={form.contact_name}
                   onChange={(e) => field("contact_name", e.target.value)} disabled={saving} maxLength={100} />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Relationship</span>
              <select className="if-input" value={form.relationship}
                      onChange={(e) => field("relationship", e.target.value)} disabled={saving}>
                {RELATIONSHIPS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Priority</span>
              <select className="if-input" value={form.priority}
                      onChange={(e) => field("priority", Number(e.target.value))} disabled={saving}>
                {[1,2,3,4,5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Primary phone</span>
            <input className="if-input" type="tel" value={form.phone_primary}
                   onChange={(e) => field("phone_primary", e.target.value)} disabled={saving}
                   placeholder="(555) 123-4567" />
          </label>

          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Secondary phone (optional)</span>
            <input className="if-input" type="tel" value={form.phone_secondary || ""}
                   onChange={(e) => field("phone_secondary", e.target.value)} disabled={saving} />
          </label>

          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Email (optional)</span>
            <input className="if-input" type="email" value={form.email || ""}
                   onChange={(e) => field("email", e.target.value)} disabled={saving} />
          </label>

          <label className="block">
            <span className="text-xs uppercase tracking-wide text-if-muted block mb-1">Notes (optional)</span>
            <textarea className="if-input" rows={2} value={form.notes || ""}
                      onChange={(e) => field("notes", e.target.value)} disabled={saving}
                      placeholder="e.g. Best reached after 6pm; speaks Spanish first" />
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
            {saving ? "Saving…" : "Save contact"}
          </button>
        </div>
      </div>
    </div>
  );
}
