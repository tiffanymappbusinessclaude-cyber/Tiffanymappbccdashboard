import { useState, useEffect, useRef } from "react";
import { supabase, AGENCY_ID } from "../lib/supabase.js";
// eslint-disable-next-line no-unused-vars
// import { useState } from "react";

// ============================================================
// BCC SETTINGS MODULE v1.0
// Business Command Center — State Farm Agent Edition
// Built by Imaginary Farms LLC · imaginary-farms.com
//
// SECTIONS:
//   1. Agency Profile   — Entity details, contact info, agent code
//   2. Team Access      — User management, roles, invite flow
//   3. Connected Accounts — Composio connections status
//   4. BCC Configuration — Timezone, fiscal year, display prefs
//   5. About            — Version info, built by, support
//
// ROLE LEVELS:
//   Owner      — Full access to everything including settings
//   Manager    — All modules except settings and financials
//   Staff      — Tasks, social, calendar, documents
//   Read Only  — View only on assigned modules
//   Accountant — Financials and documents, read only by default
//
// DATA: Reads agency, users, settings, notification_preferences,
//       social_accounts tables in Supabase
// ============================================================


// ─── Design Tokens ────────────────────────────────────────────
const T = {
  navy:    "var(--accent-navy)",
  blue:    "var(--accent-blue)",
  blueLt:  "var(--accent-navy-bg)",
  green:   "var(--success)",
  greenLt: "var(--success-bg)",
  amber:   "var(--warning)",
  amberLt: "var(--warning-bg)",
  red:     "var(--danger)",
  redLt:   "var(--danger-bg)",
  purple:  "var(--accent-purple)",
  purpleLt:"var(--accent-purple-bg)",
  teal:    "#0D9488",
  tealLt:  "#CCFBF1",
  slate50: "var(--bg-panel-subtle)",
  slate100:"var(--bg-panel)",
  slate200:"var(--border-subtle)",
  slate400:"var(--text-quaternary)",
  slate500:"var(--text-tertiary)",
  slate600:"var(--text-secondary)",
  slate700:"var(--text-secondary)",
  slate800:"var(--text-primary)",
  slate900:"var(--text-primary)",
  white:   "var(--bg-card)",
  textOnColor: "#FFFFFF",
};

// ─── Role Config ──────────────────────────────────────────────
const ROLES = {
  owner:     { label:"Owner",      color:T.navy,    bg:T.slate100, description:"Full access. Only role that can manage team & settings." },
  manager:   { label:"Manager",    color:T.blue,    bg:T.blueLt,   description:"All modules. Read-only on settings + memory." },
  producer:  { label:"Producer",   color:T.green,   bg:T.greenLt,  description:"Tasks, Social, Compliance, Docs read. No financials." },
  service:   { label:"Service",    color:T.teal,    bg:T.tealLt,   description:"Service rep — Tasks, Compliance, Alerts. No financials." },
  bookkeeper:{ label:"Bookkeeper", color:T.purple,  bg:T.purpleLt, description:"Financials + Documents admin. CPA / bookkeeper access." },
  view_only: { label:"View Only",  color:T.slate500,bg:T.slate100, description:"Read-only across all modules. No HR or settings." },
};

// ─── Mock Data ────────────────────────────────────────────────
const MOCK_USERS = [
  { id:"u1", name:"Jane Smith",    email:"jane@smithagency.com",    role:"owner",     last_login:"Today 8:14 AM",    is_active:true,  is_current:true  },
  { id:"u2", name:"Marcus Thompson",email:"marcus@smithagency.com", role:"staff",     last_login:"Today 9:02 AM",    is_active:true,  is_current:false },
  { id:"u3", name:"Priya Patel",   email:"priya@smithagency.com",   role:"manager",   last_login:"Yesterday 5:30 PM",is_active:true,  is_current:false },
  { id:"u4", name:"Steven Bonventre",email:"steven@clubcapitaltax.com",role:"accountant",last_login:"Apr 14, 2026",  is_active:true,  is_current:false },
];

const MOCK_CONNECTIONS = [
  { id:"c1", platform:"Gmail",          icon:"📧", status:"error",   account:"jane@smithagency.com",        last_sync:"Today 6:00 AM",    note:"OAuth token expired — reconnect required" },
  { id:"c2", platform:"Google Drive",   icon:"📁", status:"healthy", account:"jane@smithagency.com",        last_sync:"Yesterday 11:00 PM",note:"Active" },
  { id:"c3", platform:"Google Calendar",icon:"📅", status:"healthy", account:"jane@smithagency.com",        last_sync:"Today 7:00 AM",    note:"Active" },
  { id:"c4", platform:"Facebook",       icon:"👥", status:"healthy", account:"Smith Insurance Agency Page", last_sync:"Yesterday 9:00 AM", note:"Active" },
  { id:"c5", platform:"LinkedIn",       icon:"💼", status:"healthy", account:"Jane Smith",                  last_sync:"Yesterday 12:00 PM",note:"Active" },
  { id:"c6", platform:"Instagram",      icon:"📸", status:"manual",  account:"@smithinsurance",             last_sync:"N/A",              note:"Manual posting required — no API scheduling" },
];

const MOCK_AGENCY = {
  name:          "Smith Insurance Agency",
  owner_name:    "Jane Smith",
  entity_type:   "S-Corporation",
  tax_id:        "••-•••1847",
  sf_agent_code: "IL 22-441A",
  licensing_states:["IL","WI","IN"],
  primary_email: "jane@smithagency.com",
  phone:         "(312) 555-0182",
  address:       "1420 N. Michigan Ave, Suite 301, Chicago, IL 60610",
  google_account:"jane@smithagency.com",
  vercel_url:    "smith-insurance-bcc.vercel.app",
  setup_date:    "April 15, 2026",
};

const MOCK_CONFIG = {
  timezone:          "America/Chicago",
  fiscal_year_start: "January 1",
  accounting_method: "Cash Basis",
  currency:          "USD",
  briefing_time:     "6:00 AM",
  briefing_email:    "jane@smithagency.com",
  briefing_enabled:  true,
  aipp_target:       142000,
  aipp_year:         2026,
  dashboard_period:  "mtd",
};

// ─── Shared Components ────────────────────────────────────────
const Card = ({ children, style={} }) => (
  <div style={{ background:T.white, border:`1px solid ${T.slate200}`, borderRadius:12, padding:"16px 18px", ...style }}>
    {children}
  </div>
);

const Pill = ({ children, type = "info" }) => {
  const map = {
    success: { bg: T.greenLt,  color: "#065F46" },
    warning: { bg: T.amberLt,  color: "#92400E" },
    danger:  { bg: T.redLt,    color: "#991B1B" },
    info:    { bg: T.blueLt,   color: "#1E40AF" },
    purple:  { bg: T.purple ? "#EDE9FE" : T.blueLt, color: "#5B21B6" },
  };
  const s = map[type] || map.info;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      fontSize: 10, fontWeight: 600,
      padding: "3px 8px", borderRadius: 20,
      background: s.bg, color: s.color,
      whiteSpace: "nowrap",
    }}>{children}</span>
  );
};


const SectionHeader = ({ title, sub }) => (
  <div style={{ marginBottom:16 }}>
    <div style={{ fontSize:14, fontWeight:700, color:T.slate900 }}>{title}</div>
    {sub && <div style={{ fontSize:12, color:T.slate500, marginTop:3 }}>{sub}</div>}
  </div>
);

const Toggle = ({ value, onChange }) => (
  <div onClick={onChange} style={{ width:40, height:22, borderRadius:11, cursor:"pointer", background:value?T.green:T.slate300, position:"relative", transition:"background 0.2s", flexShrink:0 }}>
    <div style={{ width:18, height:18, borderRadius:"50%", background:T.white, position:"absolute", top:2, left:value?20:2, transition:"left 0.2s", boxShadow:"0 1px 3px rgba(0,0,0,0.2)" }} />
  </div>
);

const FieldRow = ({ label, value, editable=false, onChange, type="text", hint }) => {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value ?? "");

  // Sync local edit buffer when prop value updates (async load from Supabase).
  // Without this useEffect, val stays stuck at the initial undefined and
  // FieldRow renders "—" forever even after agency data loads.
  useEffect(() => { setVal(value ?? ""); }, [value]);

  return (
    <div style={{ display:"flex", alignItems:"flex-start", gap:12, padding:"11px 0", borderBottom:`1px solid ${T.slate100}` }}>
      <div style={{ width:180, flexShrink:0 }}>
        <div style={{ fontSize:12, fontWeight:500, color:T.slate700 }}>{label}</div>
        {hint && <div style={{ fontSize:10, color:T.slate400, marginTop:1 }}>{hint}</div>}
      </div>
      <div style={{ flex:1 }}>
        {editing ? (
          <div style={{ display:"flex", gap:8 }}>
            <input value={val} onChange={e => setVal(e.target.value)} type={type}
              style={{ flex:1, padding:"6px 10px", fontSize:12, color:T.slate800, border:`1px solid ${T.blue}`, borderRadius:7, outline:"none" }} />
            <button onClick={() => { onChange?.(val); setEditing(false); }}
              style={{ padding:"6px 12px", fontSize:11, fontWeight:600, color:T.white, background:T.navy, border:"none", borderRadius:7, cursor:"pointer" }}>Save</button>
            <button onClick={() => { setVal(value ?? ""); setEditing(false); }}
              style={{ padding:"6px 10px", fontSize:11, color:T.slate500, background:T.slate100, border:"none", borderRadius:7, cursor:"pointer" }}>Cancel</button>
          </div>
        ) : (
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <span style={{ fontSize:12, color:T.slate600 }}>{(value ?? "") !== "" ? value : "—"}</span>
            {editable && (
              <button onClick={() => setEditing(true)}
                style={{ fontSize:10, color:T.blue, background:"none", border:`1px solid ${T.slate200}`, borderRadius:6, padding:"3px 8px", cursor:"pointer" }}>Edit</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};


// ─── Ask Claude button ────────────────────────────────────────
// Inline AskBtn pattern matches every other module: copies the page's
// context to clipboard, then opens claude.ai in a new tab. The global
// system prompt + Supabase MCP load full agency context on first turn
// — no project selection required (Supabase is the shared brain).
const AskBtn = ({ context, size = "normal", demoMode = false }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [opened, setOpened] = useState(false);
  const ref = useRef(null);
  const small = size === "small";
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setTimeout(() => { setCopied(false); setOpened(false); }, 200); } };
    const k = (e) => { if (e.key === "Escape") { setOpen(false); setTimeout(() => { setCopied(false); setOpened(false); }, 200); } };
    document.addEventListener("mousedown", h); document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [open]);
  const ask = async () => {
    setOpen(true); setOpened(false);
    try { await navigator.clipboard.writeText(context); setCopied(true); } catch { setCopied(true); }
  };
  const go = () => { setOpened(true); if (!demoMode) window.open("https://claude.ai/new", "_blank", "noopener,noreferrer"); };
  const preview = context && context.length > 220 ? context.slice(0, 220).trimEnd() + "\u2026" : context;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={open ? () => { setOpen(false); setTimeout(() => { setCopied(false); setOpened(false); }, 200); } : ask}
        style={{ display: "flex", alignItems: "center", gap: 5, background: open ? T.slate100 : T.blue, color: open ? T.blue : T.white, border: open ? `1px solid ${T.blue}` : "1px solid transparent", borderRadius: 7, padding: small ? "5px 10px" : "7px 13px", fontSize: small ? 10 : 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
      >⚡ Ask Claude</button>
      {open && (
        <div role="dialog" aria-label="Ask Claude" style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 60, width: 300, background: T.white, border: `1px solid ${T.slate100}`, borderRadius: 12, boxShadow: "0 12px 32px rgba(15,23,42,0.16)", padding: 14, textAlign: "left" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#16A34A", marginBottom: 4 }}>
            {copied ? "\u2713 Context copied to your clipboard" : "Copying\u2026"}
          </div>
          <div style={{ fontSize: 11, color: T.slate500, marginBottom: 8, lineHeight: 1.5 }}>
            This is what Claude will see \u2014 your data from this screen.
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.55, color: T.slate500, background: T.slate100, borderRadius: 8, padding: 9, maxHeight: 92, overflow: "hidden", whiteSpace: "pre-wrap" }}>{preview}</div>
          <div style={{ marginTop: 10 }}>
            {!opened ? (
              <button onClick={go} style={{ width: "100%", background: T.blue, color: T.textOnColor, border: "none", borderRadius: 8, padding: "8px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                Open Claude.ai &amp; paste
              </button>
            ) : (
              <div style={{ fontSize: 11, color: T.slate500, textAlign: "center", padding: "8px 0" }}>
                Claude opened in a new tab. Paste with \u2318V (Mac) or Ctrl+V (Win).
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Section: Agency Profile ──────────────────────────────────
const AgencyProfile = ({ agency: agencyProp, onAgencyChange }) => {
  const agency = agencyProp || {};
  // Persist edit to public.agency. licensing_states is a TEXT[] column so we
  // split on comma; everything else is a plain text update. updated_at is set
  // on the server side by the row trigger if present, otherwise we set it here.
  const saveField = async (column, raw) => {
    if (!supabase || !agency.id) return;
    let value = raw;
    if (column === "licensing_states") {
      value = String(raw || "").split(",").map(s => s.trim()).filter(Boolean);
    }
    const { error } = await supabase
      .from("agency")
      .update({ [column]: value, updated_at: new Date().toISOString() })
      .eq("id", agency.id);
    if (error) { console.error("agency update failed", column, error); return; }
    onAgencyChange?.({ ...agency, [column]: value });
  };
  return (
  <Card>
    <SectionHeader title="Agency Profile" sub="Core agency information stored in your Supabase database" />
    <FieldRow label="Agency Name"       value={agency.name}                                                          editable onChange={v => saveField("name", v)} />
    <FieldRow label="Owner Name"        value={agency.owner_name}                                                    editable onChange={v => saveField("owner_name", v)} />
    <FieldRow label="Entity Type"       value={agency.entity_type}                                                   editable onChange={v => saveField("entity_type", v)} />
    <FieldRow label="EIN / Tax ID"      value={agency.tax_id}       hint="Stored encrypted"                          editable onChange={v => saveField("tax_id", v)} />
    <FieldRow label="SF Agent Code"     value={agency.state_farm_agent_code}                                         editable onChange={v => saveField("state_farm_agent_code", v)} />
    <FieldRow label="Licensed States"   value={(agency.licensing_states || []).join(", ")}                  editable onChange={v => saveField("licensing_states", v)} />
    <FieldRow label="Primary Email"     value={agency.primary_email} hint="Personal — not @statefarm.com" editable onChange={v => saveField("primary_email", v)} />
    <FieldRow label="Phone"             value={agency.phone}                                                         editable onChange={v => saveField("phone", v)} />
    <FieldRow label="Address"           value={agency.address}                                                       editable onChange={v => saveField("address", v)} />
    <FieldRow label="Google Account"    value={agency.google_account_email} hint="Ties Vercel, Supabase, Composio" editable onChange={v => saveField("google_account_email", v)} />
    <FieldRow label="BCC URL"           value={agency.vercel_url}    hint="Your permanent BCC address"               editable onChange={v => saveField("vercel_url", v)} />
    <FieldRow label="Setup Date"        value={agency.setup_date}                                                    />
  </Card>
  );
};

// ─── Section: Team Access ─────────────────────────────────────
// Reads from team_membership + team_invites tables (migrations 022 + 023).
// Send-invite flow opens a mailto: link pre-filled with the accept URL; no
// Composio API call from the client (which would require exposing the key).

const InviteModal = ({ agencyName, onSave, onCancel }) => {
  const [form, setForm] = useState({ email:"", name:"", role:"view_only" });
  const [submitting, setSubmitting] = useState(false);
  const set = (k,v) => setForm(f => ({...f,[k]:v}));

  const submit = async () => {
    if (!form.email || !form.name) { alert("Name and email required."); return; }
    setSubmitting(true);
    try { await onSave(form); }
    finally { setSubmitting(false); }
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,0.5)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:20 }}>
      <div style={{ background:T.white, borderRadius:16, width:"100%", maxWidth:460, boxShadow:"0 20px 60px rgba(0,0,0,0.2)", overflow:"hidden" }}>
        <div style={{ padding:"16px 20px", borderBottom:`1px solid ${T.slate200}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={{ fontSize:14, fontWeight:700, color:T.slate900 }}>Invite Team Member</span>
          <button onClick={onCancel} style={{ background:"none", border:"none", fontSize:18, color:T.slate400, cursor:"pointer" }}>×</button>
        </div>
        <div style={{ padding:20 }}>
          <div style={{ fontSize:11, color:T.slate500, marginBottom:14 }}>
            They'll receive an invite link valid for 7 days. They set their own password on first login.
          </div>
          {[
            { label:"Full Name", key:"name",  placeholder:"Jane Doe" },
            { label:"Email",     key:"email", placeholder:"employee@youragency.com" },
          ].map(f => (
            <div key={f.key} style={{ marginBottom:14 }}>
              <label style={{ fontSize:11, fontWeight:600, color:T.slate600, display:"block", marginBottom:5 }}>{f.label.toUpperCase()}</label>
              <input value={form[f.key]} onChange={e => set(f.key, e.target.value)} placeholder={f.placeholder}
                style={{ width:"100%", padding:"8px 10px", fontSize:12, color:T.slate800, border:`1px solid ${T.slate200}`, borderRadius:8, outline:"none", boxSizing:"border-box" }} />
            </div>
          ))}
          <div style={{ marginBottom:14 }}>
            <label style={{ fontSize:11, fontWeight:600, color:T.slate600, display:"block", marginBottom:5 }}>ACCESS ROLE</label>
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              {Object.entries(ROLES).filter(([k]) => k !== "owner").map(([key, role]) => (
                <div key={key} onClick={() => set("role", key)}
                  style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"10px 12px", borderRadius:9, cursor:"pointer", border:`2px solid ${form.role===key?role.color:T.slate200}`, background:form.role===key?role.bg:T.white }}>
                  <div style={{ width:16, height:16, borderRadius:"50%", border:`2px solid ${form.role===key?role.color:T.slate400}`, marginTop:1, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                    {form.role===key && <div style={{ width:8, height:8, borderRadius:"50%", background:role.color }} />}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:12, fontWeight:600, color:role.color }}>{role.label}</div>
                    <div style={{ fontSize:10, color:T.slate600, marginTop:2 }}>{role.description}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div style={{ padding:"12px 20px", borderTop:`1px solid ${T.slate200}`, display:"flex", justifyContent:"flex-end", gap:8 }}>
          <button onClick={onCancel} disabled={submitting} style={{ padding:"7px 14px", fontSize:11, fontWeight:600, color:T.slate700, background:T.white, border:`1px solid ${T.slate200}`, borderRadius:7, cursor:"pointer" }}>Cancel</button>
          <button onClick={submit} disabled={submitting} style={{ padding:"7px 14px", fontSize:11, fontWeight:600, color:T.white, background:submitting?T.slate400:T.navy, border:"none", borderRadius:7, cursor:submitting?"wait":"pointer" }}>
            {submitting ? "Sending…" : "Send Invite"}
          </button>
        </div>
      </div>
    </div>
  );
};

const TeamAccess = ({ agencyName }) => {
  const [members,     setMembers]     = useState([]);
  const [invites,     setInvites]     = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [showInvite,  setShowInvite]  = useState(false);
  const [editingRole, setEditingRole] = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [actionStatus,setActionStatus]= useState({});

  const flash = (k, status) => {
    setActionStatus(s => ({...s, [k]: status}));
    if (status === "saved") setTimeout(() => setActionStatus(s => ({...s, [k]: "idle"})), 2200);
  };

  const refresh = async () => {
    if (!supabase) { setLoading(false); return; }
    const [m, i, u] = await Promise.all([
      supabase.from("team_membership").select("*").eq("agency_id", AGENCY_ID).eq("is_active", true).order("role"),
      supabase.from("team_invites").select("*").eq("agency_id", AGENCY_ID).is("accepted_at", null).is("cancelled_at", null).order("created_at", { ascending: false }),
      supabase.auth.getUser(),
    ]);
    setMembers(m.data || []);
    setInvites(i.data || []);
    setCurrentUser(u.data?.user || null);
    setLoading(false);
  };
  useEffect(() => { refresh(); }, []);

  const handleInvite = async (form) => {
    if (!supabase || !currentUser) { alert("Not signed in."); return; }
    const { data: invite, error } = await supabase.from("team_invites").insert({
      agency_id: AGENCY_ID,
      invited_by: currentUser.id,
      email: form.email.toLowerCase().trim(),
      full_name: form.name,
      role: form.role,
    }).select().single();
    if (error) { alert("Invite failed: " + error.message); return; }
    // Open the user's default mail client with a pre-composed invite
    const url = `${window.location.origin}/?invite=${invite.invite_token}`;
    const subject = `You're invited to ${agencyName || "Sunshine State Insurance"} Business Command Center`;
    const body = [
      `Hi ${form.name},`, ``,
      `I've invited you to join the ${agencyName || "Sunshine State Insurance"} Business Command Center as ${ROLES[form.role]?.label || form.role}.`,
      ``,
      `Click this link to set your password and accept:`,
      url,
      ``,
      `This link expires in 7 days.`,
      ``,
      `—`,
      `Sent via the Business Command Center`,
    ].join("\n");
    window.open(`mailto:${form.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
    setShowInvite(false);
    refresh();
  };

  const handleRoleChange = async (membershipId, newRole) => {
    flash(`role-${membershipId}`, "saving");
    const { error } = await supabase.from("team_membership")
      .update({ role: newRole, updated_at: new Date().toISOString() })
      .eq("id", membershipId);
    flash(`role-${membershipId}`, error ? "error" : "saved");
    setEditingRole(null);
    refresh();
  };

  const handleRevoke = async (membershipId) => {
    if (!confirm("Revoke this team member's access?")) return;
    flash(`revoke-${membershipId}`, "saving");
    const { error } = await supabase.from("team_membership")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", membershipId);
    flash(`revoke-${membershipId}`, error ? "error" : "saved");
    refresh();
  };

  const handleCancelInvite = async (inviteId) => {
    if (!confirm("Cancel this pending invite?")) return;
    flash(`invite-${inviteId}`, "saving");
    const { error } = await supabase.rpc("cancel_team_invite", { p_invite_id: inviteId });
    flash(`invite-${inviteId}`, error ? "error" : "saved");
    refresh();
  };

  const handleResendInvite = (invite) => {
    const url = `${window.location.origin}/?invite=${invite.invite_token}`;
    const subject = `Reminder: invitation to Business Command Center`;
    const body = `Hi ${invite.full_name || ""},\n\nFollowing up on your invite to the Business Command Center as ${ROLES[invite.role]?.label || invite.role}.\n\nAccept here:\n${url}\n\n(Expires: ${new Date(invite.expires_at).toLocaleDateString()})`;
    window.open(`mailto:${invite.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
  };

  if (loading) {
    return <div style={{ padding:40, textAlign:"center", fontSize:12, color:T.slate500 }}>Loading team…</div>;
  }

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:16 }}>
        <div>
          <div style={{ fontSize:14, fontWeight:700, color:T.slate900 }}>Team Access</div>
          <div style={{ fontSize:12, color:T.slate500, marginTop:3 }}>
            {members.length} active member{members.length === 1 ? "" : "s"}
            {invites.length > 0 && ` · ${invites.length} pending invite${invites.length === 1 ? "" : "s"}`}
          </div>
        </div>
        <button onClick={() => setShowInvite(true)}
          style={{ display:"flex", alignItems:"center", gap:6, padding:"8px 16px", fontSize:11, fontWeight:600, color:T.white, background:T.navy, border:"none", borderRadius:8, cursor:"pointer" }}>
          + Invite Team Member
        </button>
      </div>

      {/* Role Reference */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:8, marginBottom:16 }}>
        {Object.entries(ROLES).map(([key, role]) => (
          <div key={key} style={{ background:role.bg, borderRadius:9, padding:"8px 10px" }}>
            <div style={{ fontSize:11, fontWeight:700, color:role.color, marginBottom:3 }}>{role.label}</div>
            <div style={{ fontSize:9, color:T.slate600, lineHeight:1.4 }}>{role.description}</div>
          </div>
        ))}
      </div>

      {/* Active members */}
      <Card>
        {members.length === 0 ? (
          <div style={{ padding:20, fontSize:12, color:T.slate500, textAlign:"center" }}>No team members yet. Click "+ Invite Team Member" to add your first.</div>
        ) : members.map((m, i) => {
          const role = ROLES[m.role] || ROLES.view_only;
          const isLast = i === members.length - 1;
          const isCurrent = currentUser && m.user_id === currentUser.id;
          const initials = (m.full_name || m.email || "?").split(" ").map(s=>s[0]).join("").slice(0,2).toUpperCase();
          return (
            <div key={m.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 0", borderBottom:isLast?"none":`1px solid ${T.slate100}` }}>
              <div style={{ width:36, height:36, borderRadius:10, background:isCurrent?T.navy:T.slate200, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:isCurrent?T.white:T.slate500, flexShrink:0 }}>
                {initials}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontSize:13, fontWeight:600, color:T.slate900 }}>{m.full_name || m.email}</span>
                  {isCurrent && <span style={{ fontSize:9, fontWeight:600, padding:"2px 6px", borderRadius:20, background:T.navy, color:T.white }}>You</span>}
                </div>
                <div style={{ fontSize:11, color:T.slate500, marginTop:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {m.email} · Last login: {m.last_login_at ? new Date(m.last_login_at).toLocaleDateString() : (m.joined_at ? "Joined " + new Date(m.joined_at).toLocaleDateString() : "Never")}
                </div>
              </div>
              {editingRole === m.id ? (
                <select autoFocus defaultValue={m.role} onBlur={() => setEditingRole(null)}
                  onChange={e => handleRoleChange(m.id, e.target.value)}
                  style={{ padding:"5px 8px", fontSize:11, color:T.slate700, border:`1px solid ${T.blue}`, borderRadius:7, background:T.white, outline:"none" }}>
                  {Object.keys(ROLES).filter(r => r !== "owner" || m.role === "owner").map(r => (
                    <option key={r} value={r}>{ROLES[r].label}</option>
                  ))}
                </select>
              ) : (
                <span onClick={() => (!isCurrent && m.role !== "owner") && setEditingRole(m.id)}
                  style={{ fontSize:10, fontWeight:600, padding:"4px 10px", borderRadius:20, background:role.bg, color:role.color, cursor:isCurrent||m.role==="owner"?"default":"pointer", whiteSpace:"nowrap" }}
                  title={isCurrent ? "" : m.role === "owner" ? "Owner role is fixed" : "Click to change role"}>
                  {role.label}
                </span>
              )}
              {actionStatus[`role-${m.id}`] === "saved" && <span style={{ fontSize:10, color:T.green, fontWeight:600 }}>✓</span>}
              {!isCurrent && m.role !== "owner" && (
                <button onClick={() => handleRevoke(m.id)}
                  style={{ fontSize:10, color:T.red, background:T.redLt, border:"none", borderRadius:6, padding:"5px 10px", cursor:"pointer", whiteSpace:"nowrap" }}>
                  Revoke
                </button>
              )}
            </div>
          );
        })}
      </Card>

      {/* Pending invites */}
      {invites.length > 0 && (
        <div style={{ marginTop:16 }}>
          <div style={{ fontSize:12, fontWeight:600, color:T.slate700, marginBottom:8 }}>Pending Invites</div>
          <Card>
            {invites.map((inv, i) => {
              const role = ROLES[inv.role] || ROLES.view_only;
              const isLast = i === invites.length - 1;
              const expired = new Date(inv.expires_at) < new Date();
              return (
                <div key={inv.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 0", borderBottom:isLast?"none":`1px solid ${T.slate100}` }}>
                  <div style={{ width:30, height:30, borderRadius:8, background:T.amberLt, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, flexShrink:0 }}>✉️</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12, fontWeight:600, color:T.slate800 }}>{inv.full_name || inv.email}</div>
                    <div style={{ fontSize:10, color:T.slate500 }}>{inv.email} · {expired ? "Expired" : `Expires ${new Date(inv.expires_at).toLocaleDateString()}`}</div>
                  </div>
                  <span style={{ fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:20, background:role.bg, color:role.color }}>{role.label}</span>
                  <button onClick={() => handleResendInvite(inv)} style={{ fontSize:10, color:T.blue, background:T.blueLt, border:"none", borderRadius:6, padding:"4px 10px", cursor:"pointer" }}>Resend</button>
                  <button onClick={() => handleCancelInvite(inv.id)} style={{ fontSize:10, color:T.red, background:T.redLt, border:"none", borderRadius:6, padding:"4px 10px", cursor:"pointer" }}>Cancel</button>
                </div>
              );
            })}
          </Card>
        </div>
      )}

      {showInvite && <InviteModal agencyName={agencyName} onSave={handleInvite} onCancel={() => setShowInvite(false)} />}
    </div>
  );
};

// ─── Section: Connected Accounts ─────────────────────────────
const ConnectedAccounts = ({ connections }) => (
  <div>
    <SectionHeader title="Connected Accounts" sub="Composio manages all external connections. Reconnect any account that shows an error." />

    <div style={{ background:T.blueLt, border:`1px solid ${T.blue}20`, borderLeft:`4px solid ${T.blue}`, borderRadius:10, padding:"12px 16px", marginBottom:16 }}>
      <div style={{ fontSize:12, fontWeight:600, color:T.navy, marginBottom:3 }}>How connections work</div>
      <div style={{ fontSize:11, color:T.slate600, lineHeight:1.6 }}>
        Your BCC automations use Composio to interact with Gmail, Google Drive, Facebook, LinkedIn, and Instagram on your behalf. Connections are authenticated via your Google account and each platform's OAuth. If a connection expires, automations that depend on it will fail until reconnected. All connections are managed in your Composio dashboard.
      </div>
    </div>

    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      {connections.map(conn => (
        <Card key={conn.id} style={{ border:`1px solid ${conn.status==="error"?T.red:T.slate200}` }}>
          <div style={{ display:"flex", alignItems:"center", gap:14 }}>
            <div style={{ width:44, height:44, borderRadius:12, background:conn.status==="error"?T.redLt:T.slate50, border:`1px solid ${conn.status==="error"?T.red:T.slate200}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0 }}>
              {conn.icon}
            </div>
            <div style={{ flex:1 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:3 }}>
                <span style={{ fontSize:13, fontWeight:700, color:T.slate900 }}>{conn.platform}</span>
                <span style={{ fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:20, ...{
                  healthy:{ background:T.greenLt, color:"#065F46" },
                  error:  { background:T.redLt,   color:"#991B1B" },
                  manual: { background:T.purpleLt,color:"#5B21B6" },
                }[conn.status] }}>{conn.status === "healthy" ? "Connected" : conn.status === "error" ? "Error" : "Manual"}</span>
              </div>
              <div style={{ fontSize:11, color:T.slate600 }}>{conn.account}</div>
              <div style={{ fontSize:10, color:conn.status==="error"?T.red:T.slate400, marginTop:2 }}>{conn.note} · Last sync: {conn.last_sync}</div>
            </div>
            {conn.status === "error" && (
              <button style={{ padding:"7px 14px", fontSize:11, fontWeight:600, color:T.white, background:T.red, border:"none", borderRadius:8, cursor:"pointer", flexShrink:0 }}>
                Reconnect
              </button>
            )}
            {conn.status === "healthy" && (
              <div style={{ fontSize:11, color:T.green, fontWeight:600, flexShrink:0 }}>✓ Active</div>
            )}
            {conn.status === "manual" && (
              <div style={{ fontSize:10, color:T.purple, fontWeight:600, flexShrink:0, maxWidth:120, textAlign:"right", lineHeight:1.4 }}>Manual posting required daily</div>
            )}
          </div>
        </Card>
      ))}
    </div>
  </div>
);

// ─── Section: BCC Configuration ──────────────────────────────
const BCCConfiguration = ({ config }) => {
  // Defensive zero-shape default so cfg.briefing_enabled etc. never throw on first paint.
  const DEFAULT_CFG = {
    timezone: "America/New_York", fiscal_year_start: "January 1",
    accounting_method: "Cash", currency: "USD",
    briefing_time: "—", briefing_time_utc: "—", briefing_email: "", briefing_enabled: true,
    briefing_recipe_id: null,
    aipp_target: null, aipp_year: new Date().getFullYear(), aipp_earned_ytd: null, aipp_row_id: null,
    dashboard_period: "mtd",
  };
  const [cfg, setCfg] = useState(config || DEFAULT_CFG);
  const [saveStatus, setSaveStatus] = useState({});  // per-field {idle|saving|saved|error}
  useEffect(() => { if (config) setCfg(config); }, [config]);
  const set = (k,v) => setCfg(c => ({...c,[k]:v}));
  const flashStatus = (k, status) => {
    setSaveStatus(s => ({...s, [k]: status}));
    if (status === "saved") setTimeout(() => setSaveStatus(s => ({...s, [k]: "idle"})), 2200);
  };

  // Persist Daily Briefing on/off to automation_recipes.is_active
  const toggleBriefing = async () => {
    const next = !cfg.briefing_enabled;
    set("briefing_enabled", next);
    if (!supabase || !cfg.briefing_recipe_id) return;
    flashStatus("briefing", "saving");
    const { error } = await supabase
      .from("automation_recipes")
      .update({ is_active: next, updated_at: new Date().toISOString() })
      .eq("id", cfg.briefing_recipe_id);
    flashStatus("briefing", error ? "error" : "saved");
    if (error) console.error("briefing toggle failed", error);
  };

  // Persist AIPP target/year to aipp_tracking. UPSERT by program_year so a missing
  // row gets created the first time the agent sets a target.
  const saveAippTarget = async (newTarget) => {
    if (!supabase) return;
    flashStatus("aipp_target", "saving");
    if (cfg.aipp_row_id) {
      const { error } = await supabase.from("aipp_tracking")
        .update({ target_amount: newTarget, last_updated: new Date().toISOString() })
        .eq("id", cfg.aipp_row_id);
      flashStatus("aipp_target", error ? "error" : "saved");
      if (error) console.error("aipp target save failed", error);
    } else {
      const { error } = await supabase.from("aipp_tracking")
        .insert({ agency_id: AGENCY_ID, program_year: cfg.aipp_year, target_amount: newTarget });
      flashStatus("aipp_target", error ? "error" : "saved");
      if (error) console.error("aipp target insert failed", error);
    }
  };

  // Persist Timezone to settings (key/value upsert).
  const saveTimezone = async (newTz) => {
    if (!supabase) return;
    flashStatus("timezone", "saving");
    // Query-then-upsert per persistent_memory rule (no unique constraint on setting_key).
    const { data: existing } = await supabase.from("settings")
      .select("id").eq("agency_id", AGENCY_ID).eq("setting_key", "agency_timezone").maybeSingle();
    const op = existing
      ? supabase.from("settings").update({ setting_value: newTz }).eq("id", existing.id)
      : supabase.from("settings").insert({ agency_id: AGENCY_ID, setting_key: "agency_timezone", setting_value: newTz, setting_type: "string" });
    const { error } = await op;
    flashStatus("timezone", error ? "error" : "saved");
    if (error) console.error("timezone save failed", error);
  };

  const StatusPill = ({ status }) => {
    if (!status || status === "idle") return null;
    const colors = {
      saving: { bg: T.slate100, fg: T.slate600, text: "Saving…" },
      saved:  { bg: T.greenLt,  fg: "#065F46",   text: "✓ Saved"  },
      error:  { bg: T.redLt,    fg: "#991B1B",   text: "Save failed" },
    }[status];
    return <span style={{ fontSize:10, fontWeight:600, padding:"2px 8px", borderRadius:20, background:colors.bg, color:colors.fg, marginLeft:8 }}>{colors.text}</span>;
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      {/* Daily Briefing */}
      <Card>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
          <div>
            <div style={{ fontSize:13, fontWeight:700, color:T.slate900 }}>
              Daily Briefing Email
              <StatusPill status={saveStatus.briefing} />
            </div>
            <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>Morning snapshot sent to your inbox every day</div>
          </div>
          <Toggle value={cfg.briefing_enabled} onChange={toggleBriefing} />
        </div>
        {cfg.briefing_enabled && (
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:T.slate600, display:"block", marginBottom:5 }}>SEND TIME</label>
              <div style={{ padding:"8px 10px", fontSize:12, color:T.slate700, background:T.slate50, borderRadius:8, border:`1px solid ${T.slate200}` }}>{cfg.briefing_time}</div>
              <div style={{ fontSize:10, color:T.slate400, marginTop:3 }}>{cfg.briefing_time_utc} · edit in Automations → Daily Briefing recipe</div>
            </div>
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:T.slate600, display:"block", marginBottom:5 }}>DELIVERY EMAIL</label>
              <div style={{ padding:"8px 10px", fontSize:12, color:T.slate700, background:T.slate50, borderRadius:8, border:`1px solid ${T.slate200}` }}>{cfg.briefing_email || "—"}</div>
              <div style={{ fontSize:10, color:T.slate400, marginTop:3 }}>From agency.google_account_email — change in Agency Profile</div>
            </div>
          </div>
        )}
      </Card>

      {/* Financial Settings */}
      <Card>
        <div style={{ fontSize:13, fontWeight:700, color:T.slate900, marginBottom:14 }}>
          Financial Settings
          <StatusPill status={saveStatus.timezone} />
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          {[
            { label:"Accounting Method",   key:"accounting_method", value:cfg.accounting_method, hint:"Cash basis — locked by SF compliance",  editable:false },
            { label:"Fiscal Year Start",   key:"fiscal_year_start", value:cfg.fiscal_year_start, hint:"Calendar year Jan-Dec",                  editable:false },
            { label:"Currency",            key:"currency",          value:cfg.currency,          hint:"USD",                                    editable:false },
            { label:"Timezone",            key:"timezone",          value:cfg.timezone,          hint:"Used for cron schedules + briefing time", editable:true  },
          ].map(f => (
            <div key={f.label}>
              <label style={{ fontSize:11, fontWeight:600, color:T.slate600, display:"block", marginBottom:5 }}>{f.label.toUpperCase()}</label>
              {f.editable ? (
                <input value={cfg.timezone} onChange={e => set("timezone", e.target.value)} onBlur={e => saveTimezone(e.target.value)}
                  style={{ width:"100%", padding:"8px 10px", fontSize:12, color:T.slate800, border:`1px solid ${T.slate200}`, borderRadius:8, outline:"none", boxSizing:"border-box" }} />
              ) : (
                <div style={{ padding:"8px 10px", fontSize:12, color:T.slate600, background:T.slate50, borderRadius:8, border:`1px solid ${T.slate200}` }}>{f.value}</div>
              )}
              <div style={{ fontSize:10, color:T.slate400, marginTop:3 }}>{f.hint}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* AIPP Settings — reads aipp_tracking table */}
      <Card>
        <div style={{ fontSize:13, fontWeight:700, color:T.slate900, marginBottom:14 }}>
          AIPP Configuration
          <StatusPill status={saveStatus.aipp_target} />
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:T.slate600, display:"block", marginBottom:5 }}>PROGRAM YEAR</label>
            <div style={{ padding:"8px 10px", fontSize:12, color:T.slate600, background:T.slate50, borderRadius:8, border:`1px solid ${T.slate200}` }}>{cfg.aipp_year}</div>
            <div style={{ fontSize:10, color:T.slate400, marginTop:3 }}>From aipp_tracking — auto-rolls each January</div>
          </div>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:T.slate600, display:"block", marginBottom:5 }}>AIPP TARGET ($)</label>
            <input
              value={cfg.aipp_target ?? ""}
              placeholder="Not set — enter your goal"
              type="number"
              onChange={e => set("aipp_target", e.target.value === "" ? null : Number(e.target.value))}
              onBlur={e => {
                const v = e.target.value === "" ? null : Number(e.target.value);
                if (v != null && Number.isFinite(v)) saveAippTarget(v);
              }}
              style={{ width:"100%", padding:"8px 10px", fontSize:12, color:T.slate800, border:`1px solid ${T.slate200}`, borderRadius:8, outline:"none", boxSizing:"border-box" }} />
            <div style={{ fontSize:10, color:T.slate400, marginTop:3 }}>
              {cfg.aipp_target == null ? "⚠ No target set in aipp_tracking — Tasks & Goals fallback is $30K" : `Persisted to aipp_tracking. Earned YTD: $${(cfg.aipp_earned_ytd ?? 0).toLocaleString()}`}
            </div>
          </div>
        </div>
      </Card>

      {/* Dashboard Display */}
      <Card>
        <div style={{ fontSize:13, fontWeight:700, color:T.slate900, marginBottom:14 }}>Dashboard Display</div>
        <div>
          <label style={{ fontSize:11, fontWeight:600, color:T.slate600, display:"block", marginBottom:8 }}>DEFAULT REVENUE PERIOD</label>
          <div style={{ display:"flex", gap:6 }}>
            {[{id:"mtd",label:"Month to Date"},{id:"qtd",label:"Quarter to Date"},{id:"ytd",label:"Year to Date"}].map(opt => (
              <button key={opt.id} onClick={() => set("dashboard_period", opt.id)}
                style={{ padding:"7px 14px", fontSize:11, fontWeight:cfg.dashboard_period===opt.id?600:400, color:cfg.dashboard_period===opt.id?T.white:T.slate600, background:cfg.dashboard_period===opt.id?T.navy:T.white, border:`1px solid ${cfg.dashboard_period===opt.id?T.navy:T.slate200}`, borderRadius:7, cursor:"pointer" }}>
                {opt.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize:10, color:T.slate400, marginTop:6 }}>Display preference only — not yet persisted to the database</div>
        </div>
      </Card>
    </div>
  );
};

// ─── Section: About ───────────────────────────────────────────
const About = ({ agency: agencyProp }) => {
  const agency = agencyProp || {};
  const [tab, setTab] = useState("stack");

  const components = [
    {
      key: "claude", name: "Claude.ai", role: "Intelligence Layer",
      accent: "#F59E0B", letter: "C",
      description: "Your AI business partner. Reads your data, advises on strategy, fixes the system, writes content, answers questions. Claude Chat in the BCC connects directly here.",
      login: agency.google_account_email || agency.primary_email || "your Google account",
      url: "https://claude.ai",
    },
    {
      key: "supabase", name: "Supabase", role: "Database & Memory",
      accent: "#3ECF8E", letter: "S",
      description: "Every number, document, staff record, automation log, and memory lives here. This is the brain of the BCC — all modules read and write from Supabase.",
      login: agency.google_account_email || agency.primary_email || "your Google account",
      url: "https://supabase.com/dashboard",
    },
    {
      key: "composio", name: "Composio", role: "Automation Engine",
      accent: "#8B5CF6", letter: "C",
      description: "Runs all your automation recipes on schedule — comp recap intake, bank statements, payroll filing, daily briefing email, inbox cleanup, monthly close. Also gives Claude access to Gmail, Drive, Calendar, and GitHub.",
      login: agency.google_account_email || agency.primary_email || "your Google account",
      url: "https://app.composio.dev/",
    },
    {
      key: "drive", name: "Google Drive", role: "Document Archive",
      accent: "#FBBC04", letter: "D",
      description: "Final resting place for every source document — comp recaps, deduction statements, bank statements, payroll reports, credit card statements. Automations file here automatically after processing.",
      login: agency.google_account_email || agency.primary_email || "your Google account",
      url: "https://drive.google.com",
    },
    {
      key: "gmail", name: "Gmail", role: "Document Intake",
      accent: "#EA4335", letter: "G",
      description: "Front door for incoming documents. Composio watches this inbox, reads what arrives, sends it to Supabase, and files the original to Drive. Claude also sends your daily briefing from here.",
      login: agency.google_account_email || agency.primary_email || "your Google account",
      url: "https://mail.google.com",
    },
    {
      key: "github", name: "GitHub", role: "Code Repository",
      accent: "#181717", letter: "G",
      description: "Your BCC's source code lives here. Every change Claude makes to the app is committed here first, then auto-deployed to Vercel.",
      login: agency.google_account_email || agency.primary_email || "your Google account",
      url: "https://github.com",
    },
    {
      key: "vercel", name: "Vercel", role: "Hosting",
      accent: "#000000", letter: "V",
      description: "Hosts the web app you are looking at right now. Watches GitHub for changes, builds the site, and serves it at your custom URL.",
      login: agency.google_account_email || agency.primary_email || "your Google account",
      url: "https://vercel.com/dashboard",  // always Vercel dashboard, not the BCC URL itself
    },
  ];

  const tabs = [
    { id:"stack",     label:"⚡  Tech Stack" },
    { id:"how",       label:"❓  How It Works" },
    { id:"connected", label:"❗  Keep It Connected" },
  ];

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>

      {/* Header card */}
      <Card style={{ background:T.navy, border:"none", color:T.white }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:14 }}>
          <div style={{ display:"flex", alignItems:"center", gap:14 }}>
            <div style={{ width:60, height:60, borderRadius:14, background:"rgba(255,255,255,0.08)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, fontWeight:800, color:T.white, letterSpacing:"-0.02em" }}>
              BCC
            </div>
            <div>
              <div style={{ fontSize:17, fontWeight:700, color:T.white }}>Business Command Center</div>
              <div style={{ fontSize:12, color:"rgba(255,255,255,0.7)", marginTop:3 }}>State Farm Agent Edition · v1.0 · Built by Imaginary Farms LLC</div>
              <div style={{ fontSize:11, color:"rgba(255,255,255,0.5)", marginTop:2 }}>imaginary-farms.com  ·  The Claude Whisperer</div>
            </div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:10, color:"rgba(255,255,255,0.5)", marginBottom:4, textTransform:"uppercase", letterSpacing:"0.05em" }}>Single Google login for everything</div>
            <div style={{ fontSize:12, fontWeight:600, color:T.white, background:"rgba(255,255,255,0.1)", padding:"7px 12px", borderRadius:8 }}>
              {agency.google_account_email || agency.primary_email || "set in Agency Profile"}
            </div>
          </div>
        </div>
      </Card>

      {/* Sub-tabs */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding:"12px 14px",
            fontSize:13, fontWeight:600,
            color: tab===t.id ? T.slate900 : T.slate500,
            background: tab===t.id ? T.white : T.slate50,
            border:`1px solid ${tab===t.id ? T.slate300 : T.slate200}`,
            borderRadius:10, cursor:"pointer",
            transition:"all 0.12s",
            boxShadow: tab===t.id ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
          }}>{t.label}</button>
        ))}
      </div>

      {tab === "stack" && (
        <>
          <div style={{ fontSize:12, color:T.slate600, padding:"4px 4px 0" }}>
            All {components.length} components run under one Google account — <strong style={{ color:T.slate900 }}>{agency.google_account_email || agency.primary_email || "set in Agency Profile"}</strong>
          </div>

          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {components.map(c => (
              <Card key={c.key} style={{ borderLeft:`4px solid ${c.accent}`, padding:"14px 16px" }}>
                <div style={{ display:"flex", alignItems:"flex-start", gap:14 }}>
                  <div style={{
                    width:38, height:38, borderRadius:10,
                    background:`${c.accent}15`,
                    color:c.accent,
                    display:"flex", alignItems:"center", justifyContent:"center",
                    fontSize:18, fontWeight:800, flexShrink:0,
                  }}>{c.letter}</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4, flexWrap:"wrap" }}>
                      <span style={{ fontSize:14, fontWeight:700, color:T.slate900 }}>{c.name}</span>
                      <Pill type="info">{c.role}</Pill>
                    </div>
                    <div style={{ fontSize:12, color:T.slate600, lineHeight:1.55, marginBottom:8 }}>{c.description}</div>
                    <div style={{ fontSize:11, color:T.slate500 }}>
                      <span style={{ fontWeight:600, color:T.slate700 }}>Login:</span> {c.login} <span style={{ color:T.slate400 }}>(Google)</span>
                    </div>
                  </div>
                  <a href={c.url} target="_blank" rel="noopener noreferrer" style={{
                    fontSize:12, fontWeight:600, color:T.blue, textDecoration:"none",
                    padding:"6px 12px", borderRadius:7, border:`1px solid ${T.slate200}`,
                    flexShrink:0, whiteSpace:"nowrap",
                  }}>Open ↗</a>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      {tab === "how" && (
        <Card>
          <div style={{ fontSize:14, fontWeight:700, color:T.slate900, marginBottom:14 }}>How the BCC works</div>
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            {[
              { step:"1", title:"Documents arrive in Gmail",
                detail:"Your bank, Gusto, State Farm, and credit card emails land in your Gmail inbox automatically." },
              { step:"2", title:"Composio reads the inbox on schedule",
                detail:"Hourly automation recipes scan for new statements, payroll runs, and SF comp recaps." },
              { step:"3", title:"Groq processes documents (free, no API key)",
                detail:"Composio passes each document to Groq for structured extraction — line items, dates, amounts." },
              { step:"4", title:"Data lands in Supabase",
                detail:"Extracted rows write to the right tables — journal_entries, comp_recap, payroll_detail, etc." },
              { step:"5", title:"Original document files to Drive",
                detail:"After processing, the original PDF/CSV moves to your Google Drive in the right folder." },
              { step:"6", title:"This BCC web app reads from Supabase",
                detail:"Every module you see — Financials, Compliance, HR, Tasks — pulls live from Supabase." },
              { step:"7", title:"Claude reads everything and advises",
                detail:"Open Claude Chat from any module. Claude has read-access to your Supabase data and can answer questions, run analysis, draft reports, and write code changes." },
            ].map(s => (
              <div key={s.step} style={{ display:"flex", gap:14, alignItems:"flex-start" }}>
                <div style={{ width:30, height:30, borderRadius:8, background:T.blueLt, color:T.blue, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:700, flexShrink:0 }}>{s.step}</div>
                <div>
                  <div style={{ fontSize:13, fontWeight:600, color:T.slate900, marginBottom:2 }}>{s.title}</div>
                  <div style={{ fontSize:12, color:T.slate600, lineHeight:1.55 }}>{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === "connected" && (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

          {/* HERO: The self-heal model */}
          <Card style={{ borderLeft:`4px solid ${T.green}`, background:"linear-gradient(180deg, #F0FDF4 0%, #FFFFFF 60%)" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
              <span style={{ fontSize:24 }}>💚</span>
              <div>
                <div style={{ fontSize:14, fontWeight:700, color:T.slate900 }}>When something breaks, ask your Claude first</div>
                <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>
                  Your Claude knows your stack and can fix or guide you through almost anything
                </div>
              </div>
            </div>
            <div style={{ fontSize:12, color:T.slate700, lineHeight:1.6, marginBottom:12 }}>
              The BCC is designed to <strong>self-heal with your Claude as the operator</strong>. You should never have to remember which dashboard to log into, what to click, or what to do next when an alert pops up. Your Claude is your business partner — that includes maintenance.
            </div>
            <div style={{ background:T.white, padding:"12px 14px", borderRadius:10, border:`1px solid ${T.slate200}` }}>
              <div style={{ fontSize:11, fontWeight:700, color:T.slate800, marginBottom:8 }}>The pattern, every time:</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(160px, 1fr))", gap:10, fontSize:11, color:T.slate600 }}>
                <div style={{ background:T.slate50, padding:"10px 12px", borderRadius:8 }}>
                  <div style={{ fontSize:18, marginBottom:4 }}>📸</div>
                  <strong style={{ color:T.slate900 }}>1. Screenshot the error</strong>
                  <div style={{ marginTop:3, lineHeight:1.5 }}>Whatever you&apos;re seeing — alert banner, broken module, failed automation</div>
                </div>
                <div style={{ background:T.slate50, padding:"10px 12px", borderRadius:8 }}>
                  <div style={{ fontSize:18, marginBottom:4 }}>💬</div>
                  <strong style={{ color:T.slate900 }}>2. Paste it to your Claude</strong>
                  <div style={{ marginTop:3, lineHeight:1.5 }}>&quot;Help me fix this&quot; is enough — your Claude has full context on your stack</div>
                </div>
                <div style={{ background:T.slate50, padding:"10px 12px", borderRadius:8 }}>
                  <div style={{ fontSize:18, marginBottom:4 }}>✅</div>
                  <strong style={{ color:T.slate900 }}>3. Follow the steps</strong>
                  <div style={{ marginTop:3, lineHeight:1.5 }}>Your Claude either fixes it directly or walks you through it click-by-click</div>
                </div>
              </div>
            </div>
          </Card>

          {/* TWO-TIER MODEL: What can break */}
          <Card>
            <div style={{ fontSize:13, fontWeight:700, color:T.slate900, marginBottom:4 }}>What your Claude can reconnect</div>
            <div style={{ fontSize:11, color:T.slate500, marginBottom:14 }}>
              Two layers — your Claude knows the difference and will tell you which one needs attention
            </div>

            {/* Layer 1: Claude.ai connectors */}
            <div style={{ marginBottom:18 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                <span style={{ fontSize:11, fontWeight:700, color:T.white, background:T.blue, padding:"2px 8px", borderRadius:10 }}>Layer 1</span>
                <span style={{ fontSize:13, fontWeight:700, color:T.slate900 }}>Claude.ai connectors</span>
                <span style={{ fontSize:11, color:T.slate500 }}>— the BCC&apos;s core systems</span>
              </div>
              <div style={{ fontSize:11, color:T.slate600, lineHeight:1.6, marginBottom:10 }}>
                These four connectors live in <strong>Claude.ai → Settings → Connectors</strong>. They power your BCC&apos;s memory, gateway, code, and hosting:
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(200px, 1fr))", gap:8 }}>
                {[
                  { name:"Supabase",  icon:"💾", role:"Persistent memory + database" },
                  { name:"Composio",  icon:"🔌", role:"Gateway to all your other tools" },
                  { name:"GitHub",    icon:"📦", role:"BCC web app source code" },
                  { name:"Vercel",    icon:"🚀", role:"BCC web app hosting & deploys" },
                ].map(c => (
                  <div key={c.name} style={{ background:T.slate50, padding:"10px 12px", borderRadius:8, border:`1px solid ${T.slate200}` }}>
                    <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
                      <span style={{ fontSize:14 }}>{c.icon}</span>
                      <strong style={{ fontSize:12, color:T.slate900 }}>{c.name}</strong>
                    </div>
                    <div style={{ fontSize:10, color:T.slate600, lineHeight:1.4 }}>{c.role}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop:10, fontSize:11, color:T.slate600, lineHeight:1.6, fontStyle:"italic" }}>
                If one of these disconnects, your Claude will tell you exactly what to click in Claude.ai settings to reconnect it.
              </div>
            </div>

            {/* Layer 2: Composio integrations */}
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                <span style={{ fontSize:11, fontWeight:700, color:T.white, background:T.purple || "#7C3AED", padding:"2px 8px", borderRadius:10 }}>Layer 2</span>
                <span style={{ fontSize:13, fontWeight:700, color:T.slate900 }}>Composio integrations</span>
                <span style={{ fontSize:11, color:T.slate500 }}>— the apps your BCC reaches out to</span>
              </div>
              <div style={{ fontSize:11, color:T.slate600, lineHeight:1.6, marginBottom:10 }}>
                These integrations live inside <strong>Composio</strong> (Layer 1 reaches them on your behalf). When one disconnects — usually because an OAuth token expired — your Claude can generate a fresh authorization link for you:
              </div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:12 }}>
                {["Gmail", "Google Drive", "Google Calendar", "LinkedIn", "Facebook", "Instagram", "YouTube", "+ more"].map(app => (
                  <span key={app} style={{ fontSize:11, padding:"4px 10px", background:T.slate100, color:T.slate700, borderRadius:14, border:`1px solid ${T.slate200}` }}>{app}</span>
                ))}
              </div>
              <div style={{ background:T.blueLt, padding:"10px 12px", borderRadius:8, fontSize:11, color:T.slate700, lineHeight:1.6 }}>
                <strong>Just ask your Claude:</strong> &quot;Gmail looks disconnected — give me the Composio reauthorization link.&quot; Your Claude will produce the exact link to click. One screen, one OAuth prompt, done.
              </div>
            </div>
          </Card>

          {/* HOW YOU&apos;LL KNOW */}
          <Card>
            <div style={{ fontSize:13, fontWeight:700, color:T.slate900, marginBottom:10 }}>How you&apos;ll know something needs attention</div>
            <ul style={{ fontSize:12, color:T.slate600, lineHeight:1.7, paddingLeft:20, margin:0 }}>
              <li>An <strong>alert</strong> appears in the Alerts module flagging the disconnection</li>
              <li>The <strong>Automations Run Log</strong> shows recent runs as &quot;failed&quot; with an auth error</li>
              <li>You stop receiving the morning briefing</li>
              <li>New documents stop appearing in Drive after they hit Gmail</li>
              <li>A module in your BCC suddenly shows &quot;Something went wrong&quot; — that&apos;s the ErrorBoundary catching something</li>
            </ul>
            <div style={{ marginTop:12, padding:"10px 12px", background:T.amberLt, borderRadius:8, fontSize:11, color:"#92400E", lineHeight:1.6 }}>
              <strong>In every case:</strong> screenshot what you see, paste it to your Claude, and ask for help. Your Claude can read the screenshot, identify the issue, and either fix it directly or walk you through the fix in plain English.
            </div>
          </Card>

          {/* QUICK LINKS */}
          <Card style={{ background:T.slate50, border:"none" }}>
            <div style={{ fontSize:11, fontWeight:700, color:T.slate800, marginBottom:8 }}>Quick links (only when your Claude tells you to use them)</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
              <a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener noreferrer" style={{
                fontSize:11, fontWeight:600, color:T.white, textDecoration:"none",
                padding:"7px 12px", borderRadius:7, background:T.blue, display:"inline-block",
              }}>Claude.ai Connectors ↗</a>
              <a href="https://app.composio.dev/" target="_blank" rel="noopener noreferrer" style={{
                fontSize:11, fontWeight:600, color:T.white, textDecoration:"none",
                padding:"7px 12px", borderRadius:7, background:T.purple || "#7C3AED", display:"inline-block",
              }}>Composio Dashboard ↗</a>
            </div>
            <div style={{ marginTop:10, fontSize:10, color:T.slate500, lineHeight:1.5 }}>
              💡 You shouldn&apos;t need these on your own. Your Claude will give you the exact link, the exact step, and the exact thing to click whenever something needs attention. The BCC is built so you spend your time selling and serving — not managing infrastructure.
            </div>
          </Card>
        </div>
      )}

      {/* Footer */}
      <Card style={{ textAlign:"center", padding:"18px 20px", background:T.slate50, border:"none" }}>
        <div style={{ fontSize:13, fontWeight:700, color:T.slate900, marginBottom:4 }}>Built by Imaginary Farms LLC · The Claude Whisperer</div>
        <a href="https://imaginary-farms.com" target="_blank" rel="noopener noreferrer"
          style={{ fontSize:12, color:T.blue, textDecoration:"none", fontWeight:500 }}>
          imaginary-farms.com
        </a>
        <div style={{ marginTop:10, fontSize:11, color:T.slate500, lineHeight:1.5 }}>
          You own everything. Your BCC is not a subscription. Your Vercel hosts the app · your GitHub holds the code · your Supabase stores your data · your Composio connects your accounts · your Claude.ai provides the intelligence.
        </div>
      </Card>
    </div>
  );
};



// ─── Section: My Account ──────────────────────────────────────
// Lets the signed-in user view their auth identity + change their password
// directly from the app. Pattern:
//   1) Read current email from supabase.auth.getUser()
//   2) Verify current password by attempting signInWithPassword (re-auths
//      the same session — won't kick the user out, but proves they know
//      the existing password)
//   3) Call supabase.auth.updateUser({ password: newPassword })
//   4) Show success/error inline
// Email-based reset is also offered as a fallback (uses
// supabase.auth.resetPasswordForEmail; AuthGuard handles the recovery flow).
const MyAccount = () => {
  const [email,      setEmail]      = useState("");
  const [userMeta,   setUserMeta]   = useState({});
  const [currentPwd, setCurrentPwd] = useState("");
  const [newPwd,     setNewPwd]     = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [show,       setShow]       = useState(false);  // single show/hide for all 3 fields
  const [busy,       setBusy]       = useState(false);
  const [resetBusy,  setResetBusy]  = useState(false);
  const [msg,        setMsg]        = useState(null);    // {type:"success"|"error", text}

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { data } = await supabase.auth.getUser();
        if (!mounted) return;
        if (data?.user) {
          setEmail(data.user.email || "");
          setUserMeta(data.user.user_metadata || {});
        }
      } catch (e) {
        console.error("getUser failed", e);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const flash = (type, text, holdMs = 6000) => {
    setMsg({ type, text });
    if (holdMs) setTimeout(() => setMsg(null), holdMs);
  };

  const submitChangePassword = async () => {
    setMsg(null);
    if (!email)                    { flash("error", "No signed-in user — please sign out and back in.", 0); return; }
    if (!currentPwd)               { flash("error", "Enter your current password."); return; }
    if (!newPwd)                   { flash("error", "Enter a new password."); return; }
    if (newPwd.length < 8)         { flash("error", "New password must be at least 8 characters."); return; }
    if (newPwd === currentPwd)     { flash("error", "New password must differ from your current one."); return; }
    if (newPwd !== confirmPwd)     { flash("error", "New password and confirmation don't match."); return; }

    setBusy(true);
    try {
      // Step 1: verify the current password by attempting a sign-in. On
      // success Supabase refreshes the SAME session — user stays signed in.
      const { error: verifyErr } = await supabase.auth.signInWithPassword({
        email,
        password: currentPwd,
      });
      if (verifyErr) {
        flash("error", "Current password is incorrect.");
        setBusy(false);
        return;
      }

      // Step 2: update the password.
      const { error: updErr } = await supabase.auth.updateUser({ password: newPwd });
      if (updErr) {
        flash("error", updErr.message || "Couldn't update password. Try again.");
        setBusy(false);
        return;
      }

      setCurrentPwd("");
      setNewPwd("");
      setConfirmPwd("");
      flash("success", "Password updated. You're still signed in on this device.");
    } catch (e) {
      console.error("change password failed", e);
      flash("error", "Something went wrong updating your password. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const sendResetEmail = async () => {
    if (!email) return;
    setResetBusy(true);
    setMsg(null);
    try {
      const redirectTo = typeof window !== "undefined"
        ? `${window.location.origin}/?reset=true`
        : undefined;
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) {
        flash("error", error.message || "Couldn't send reset email. Try again.");
      } else {
        flash("success", `Reset link sent to ${email}. Open it in this browser to set a new password.`);
      }
    } catch (e) {
      console.error("reset email failed", e);
      flash("error", "Couldn't send reset email. Try again.");
    } finally {
      setResetBusy(false);
    }
  };

  const inputStyle = {
    width: "100%", padding: "8px 12px", fontSize: 13, color: T.slate800,
    border: `1px solid ${T.slate200}`, borderRadius: 8, outline: "none",
    background: T.white, boxSizing: "border-box",
  };
  const labelStyle = { fontSize: 11, fontWeight: 600, color: T.slate700, marginBottom: 6, display: "block" };

  return (
    <div style={{ display:"grid", gap:14 }}>
      {/* Account identity */}
      <Card>
        <SectionHeader title="My Account" sub="Your sign-in identity and password" />
        <FieldRow label="Signed in as"  value={email}                       hint="Auth email — used for sign-in and password reset" />
        <FieldRow label="Display name"  value={userMeta.full_name || userMeta.name} />
        <FieldRow label="User ID"       value={userMeta.sub || ""}          hint="Internal Supabase auth ID" />
      </Card>

      {/* Change password */}
      <Card>
        <SectionHeader title="Change Password" sub="Verify your current password, then choose a new one. You'll stay signed in on this device." />

        {msg && (
          <div style={{
            marginBottom: 14, padding: "10px 12px", borderRadius: 8, fontSize: 12, lineHeight: 1.5,
            background: msg.type === "success" ? T.greenLt : T.redLt,
            color:      msg.type === "success" ? "#065F46" : "#991B1B",
            border: `1px solid ${msg.type === "success" ? "#A7F3D0" : "#FECACA"}`,
          }}>
            {msg.text}
          </div>
        )}

        <div style={{ display:"grid", gap:14, maxWidth:480 }}>
          <div>
            <label style={labelStyle}>Current password</label>
            <input
              type={show ? "text" : "password"}
              value={currentPwd}
              onChange={e => setCurrentPwd(e.target.value)}
              autoComplete="current-password"
              placeholder="Your current password"
              style={inputStyle}
              disabled={busy}
            />
          </div>
          <div>
            <label style={labelStyle}>New password</label>
            <input
              type={show ? "text" : "password"}
              value={newPwd}
              onChange={e => setNewPwd(e.target.value)}
              autoComplete="new-password"
              placeholder="Minimum 8 characters"
              style={inputStyle}
              disabled={busy}
            />
          </div>
          <div>
            <label style={labelStyle}>Confirm new password</label>
            <input
              type={show ? "text" : "password"}
              value={confirmPwd}
              onChange={e => setConfirmPwd(e.target.value)}
              autoComplete="new-password"
              placeholder="Re-enter your new password"
              style={inputStyle}
              disabled={busy}
            />
          </div>

          <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:12, color:T.slate600, cursor:"pointer", userSelect:"none" }}>
            <input
              type="checkbox"
              checked={show}
              onChange={() => setShow(s => !s)}
              style={{ width:14, height:14, cursor:"pointer" }}
            />
            Show passwords
          </label>

          <div style={{ display:"flex", gap:10, alignItems:"center", marginTop:4 }}>
            <button
              onClick={submitChangePassword}
              disabled={busy}
              style={{
                padding:"9px 18px", fontSize:12, fontWeight:600, color:T.white,
                background: busy ? T.slate400 : T.navy, border:"none", borderRadius:8,
                cursor: busy ? "wait" : "pointer", transition:"background 0.15s",
              }}>
              {busy ? "Updating…" : "Update password"}
            </button>
            <button
              onClick={() => { setCurrentPwd(""); setNewPwd(""); setConfirmPwd(""); setMsg(null); }}
              disabled={busy}
              style={{
                padding:"9px 14px", fontSize:12, color:T.slate600,
                background:T.slate100, border:`1px solid ${T.slate200}`, borderRadius:8,
                cursor: busy ? "wait" : "pointer",
              }}>
              Clear
            </button>
          </div>
        </div>
      </Card>

      {/* Reset by email fallback */}
      <Card>
        <SectionHeader title="Forgot your current password?" sub="Send yourself a password reset link by email" />
        <div style={{ fontSize:12, color:T.slate600, lineHeight:1.6, marginBottom:14 }}>
          We'll email <strong style={{ color:T.slate800 }}>{email || "your sign-in address"}</strong> a one-time
          reset link. Open it in this browser; you'll be prompted to set a new password before the dashboard reloads.
        </div>
        <button
          onClick={sendResetEmail}
          disabled={resetBusy || !email}
          style={{
            padding:"9px 16px", fontSize:12, fontWeight:600, color:T.blue,
            background:T.blueLt, border:`1px solid ${T.blue}`, borderRadius:8,
            cursor: resetBusy ? "wait" : "pointer",
          }}>
          {resetBusy ? "Sending…" : "Email me a reset link"}
        </button>
      </Card>
    </div>
  );
};

// ─── Main Settings Module ─────────────────────────────────────
export default function Settings() {

  const [agencyData, setAgencyData] = useState(null);
  const [settingsData, setSettingsData] = useState([]);
  const [usersData, setUsersData] = useState([]);
  const [aippData, setAippData] = useState(null);           // aipp_tracking row (latest program year)
  const [briefingRecipe, setBriefingRecipe] = useState(null); // automation_recipes row for Daily Briefing
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadSettings() {
      if (!supabase || !AGENCY_ID) { setLoading(false); return; }
      try {
        const [agencyRes, settingsRes, usersRes, aippRes, briefingRes] = await Promise.all([
          supabase.from("agency").select("*").eq("id", AGENCY_ID).single(),
          supabase.from("settings").select("*").eq("agency_id", AGENCY_ID),
          supabase.from("users").select("*").eq("agency_id", AGENCY_ID),
          // AIPP target + program year live in aipp_tracking, NOT settings.
          // Pull the latest program year row so Configuration shows real data.
          supabase.from("aipp_tracking").select("*").eq("agency_id", AGENCY_ID).order("program_year", { ascending: false }).limit(1).maybeSingle(),
          // Daily Briefing recipe — for cron-derived send time + actual toggle state.
          supabase.from("automation_recipes").select("*").eq("agency_id", AGENCY_ID).eq("recipe_name", "Daily Briefing Email").maybeSingle(),
        ]);
        if (agencyRes.data) setAgencyData(agencyRes.data);
        if (settingsRes.data) setSettingsData(settingsRes.data);
        if (usersRes.data) setUsersData(usersRes.data);
        if (aippRes.data) setAippData(aippRes.data);
        if (briefingRes.data) setBriefingRecipe(briefingRes.data);
      } catch(e) { console.error("Settings load error:", e); }
      finally { setLoading(false); }
    }
    loadSettings();
  }, []);

  const useMockData = import.meta.env.VITE_USE_MOCK_DATA !== "false";
  const [section, setSection] = useState("profile");

  // Build a key→value index from settings rows so the Connections + Configuration
  // tabs can read composio account IDs and other config without re-querying.
  const settingsByKey = (() => {
    const m = new Map();
    (settingsData || []).forEach(s => {
      if (s && s.setting_key != null) m.set(s.setting_key, s.setting_value);
    });
    return m;
  })();

  // Derive Connections list from settings.composio_*_account_id rows. Each connection
  // present in settings is rendered as "Connected" (healthy); known platforms missing
  // from settings render as "Reconnect needed" (error). Instagram is "manual" by design.
  const acctEmail = (agencyData && (agencyData.google_account_email || agencyData.primary_email)) || "[AGENCY_CLAUDE_EMAIL]";
  const connFrom = (key, platform, icon, manualNote) => {
    const id = settingsByKey.get(key);
    if (id) {
      return { id: key, platform, icon, status: "healthy", account: acctEmail,
               last_sync: "Live via Composio", note: `Connected · ${id}` };
    }
    return { id: key, platform, icon, status: "error", account: acctEmail,
             last_sync: "Pending", note: manualNote || "Composio account not configured — reauth needed" };
  };
  const qboHasId = settingsByKey.has("composio_qbo_account_id");
  const liveConnections = [
    connFrom("composio_gmail_account_id",          "Gmail",            "📧"),
    connFrom("composio_googledrive_account_id",    "Google Drive",     "📁"),
    connFrom("composio_googlecalendar_account_id", "Google Calendar",  "📅"),
    connFrom("composio_github_account_id",         "GitHub",           "💻"),
    qboHasId
      ? { id:"qbo", platform:"QuickBooks", icon:"💰", status:"error",
          account: acctEmail, last_sync:"Blocked",
          note:`Connection ID set (${settingsByKey.get("composio_qbo_account_id")}) — allowlist + realm reauth needed before 7/1` }
      : connFrom("composio_qbo_account_id", "QuickBooks", "💰"),
    { id:"facebook",  platform:"Facebook",  icon:"👥", status:"error",
      account: acctEmail, last_sync:"Pending",
      note:"Composio reauth required — open ticket on next-session handoff" },
    { id:"linkedin",  platform:"LinkedIn",  icon:"💼", status:"error",
      account: acctEmail, last_sync:"Pending",
      note:"Composio reauth required — open ticket on next-session handoff" },
    { id:"instagram", platform:"Instagram", icon:"📸", status:"manual",
      account: "@sunshine_state_insurance", last_sync:"N/A",
      note:"No API scheduling allowed — daily manual post via reminder alerts" },
  ];

  // Compute Daily Briefing send time from the actual cron expression and the
  // agency's timezone. cron "0 12 * * *" = 12:00 UTC = 8:00 AM EDT (June) /
  // 7:00 AM EST (Dec). We render the local-time string AND show the raw UTC
  // schedule alongside so the field is unambiguous.
  const cronToLocalTime = (cronExpr, tz) => {
    if (!cronExpr) return { display: "—", utc: "—" };
    const parts = String(cronExpr).trim().split(/\s+/);
    if (parts.length < 5) return { display: "—", utc: cronExpr };
    const utcHour   = parseInt(parts[1], 10);
    const utcMinute = parseInt(parts[0], 10);
    if (!Number.isFinite(utcHour) || !Number.isFinite(utcMinute)) {
      return { display: "—", utc: cronExpr };
    }
    const utcTime = `${String(utcHour).padStart(2,"0")}:${String(utcMinute).padStart(2,"0")} UTC daily`;
    try {
      // Build a Date for today's cron firing, then format in target timezone.
      const d = new Date();
      d.setUTCHours(utcHour, utcMinute, 0, 0);
      const local = d.toLocaleTimeString("en-US", {
        timeZone: tz || "America/New_York",
        hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
      });
      return { display: local, utc: utcTime };
    } catch (e) {
      return { display: utcTime, utc: utcTime };
    }
  };
  const briefingTimeInfo = cronToLocalTime(
    briefingRecipe?.cron_expression,
    settingsByKey.get("agency_timezone") || "America/New_York"
  );

  // Derive Configuration from settings rows + agency + aipp_tracking + recipes.
  // No hardcoded fallbacks for fields that have a real database home — those
  // render "Not set" so the agent can see what's actually missing.
  const liveConfig = {
    timezone:          settingsByKey.get("agency_timezone")   || "America/New_York",
    fiscal_year_start: settingsByKey.get("fiscal_year_type") === "calendar" ? "January 1" : "January 1",
    accounting_method: (settingsByKey.get("accounting_method") || "cash") === "cash" ? "Cash" : "Accrual",
    currency:          "USD",
    briefing_time:     briefingTimeInfo.display,
    briefing_time_utc: briefingTimeInfo.utc,
    briefing_email:    acctEmail,
    briefing_enabled:  briefingRecipe ? briefingRecipe.is_active !== false : true,
    briefing_recipe_id: briefingRecipe?.id || null,
    aipp_target:       aippData?.target_amount != null ? Number(aippData.target_amount) : null,
    aipp_year:         aippData?.program_year || new Date().getFullYear(),
    aipp_earned_ytd:   aippData?.earned_ytd != null ? Number(aippData.earned_ytd) : null,
    aipp_row_id:       aippData?.id || null,
    dashboard_period:  settingsByKey.get("dashboard_period")    || "mtd",
  };

  const sections = [
    { id:"profile",     label:"Agency Profile"    },
    { id:"team",        label:"Team Access"        },
    { id:"connections", label:"Connections"        },
    { id:"config",      label:"Configuration"      },
    { id:"about",       label:"About"              },
  { id:"account",     label:"My Account"         },
  ];

  return (
    <div>
      {/* Module Header */}
      <div style={{ marginBottom:16, display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:14 }}>
        <div>
          <div style={{ fontSize:20, fontWeight:700, color:T.slate900, letterSpacing:"-0.02em" }}>Settings</div>
          <div style={{ fontSize:12, color:T.slate500, marginTop:3 }}>
            Agency profile · Team access · Connected accounts · BCC configuration
          </div>
        </div>
        <AskBtn context="I am in my BCC Settings module. Help me review my BCC configuration end to end — confirm my agency profile, team access, connected accounts and integrations are healthy, identify anything missing or misconfigured, and explain anything I don't understand. Walk me through what each section is for." />
      </div>

      {/* Section Navigation */}
      <div style={{ display:"flex", gap:2, flexWrap:"wrap", background:T.slate100, borderRadius:10, padding:4, marginBottom:18 }}>
        {sections.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)} style={{ padding:"7px 14px", fontSize:12, fontWeight:section===s.id?600:400, color:section===s.id?T.slate900:T.slate500, background:section===s.id?T.white:"transparent", border:"none", borderRadius:7, cursor:"pointer", transition:"all 0.12s", boxShadow:section===s.id?"0 1px 3px rgba(0,0,0,0.08)":"none" }}>
            {s.label}
          </button>
        ))}
      </div>

      {/* Section Content — live data wins; mock fallback only when VITE_USE_MOCK_DATA !== "false" */}
      {section === "profile"     && <AgencyProfile      agency={agencyData || (useMockData ? MOCK_AGENCY : null)} onAgencyChange={setAgencyData} />}
      {section === "team"        && <TeamAccess agencyName={agencyData?.name} />}
      {section === "connections" && <ConnectedAccounts  connections={useMockData ? MOCK_CONNECTIONS : liveConnections} />}
      {section === "config"      && <BCCConfiguration   config={useMockData ? MOCK_CONFIG : liveConfig} />}
      {section === "about"       && <About              agency={agencyData || (useMockData ? MOCK_AGENCY : null)} />}
          {section === "account"     && <MyAccount />}
    </div>
  );
}
