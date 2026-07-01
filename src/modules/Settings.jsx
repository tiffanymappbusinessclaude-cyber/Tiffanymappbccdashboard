import { useState, useEffect } from "react";
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
  navy:    "#1B2B4B",
  blue:    "#2D7DD2",
  blueLt:  "#EFF6FF",
  green:   "#10B981",
  greenLt: "#D1FAE5",
  amber:   "#F59E0B",
  amberLt: "#FEF3C7",
  red:     "#EF4444",
  redLt:   "#FEE2E2",
  purple:  "#7C3AED",
  purpleLt:"#EDE9FE",
  teal:    "#0D9488",
  tealLt:  "#CCFBF1",
  slate50: "#F8FAFC",
  slate100:"#F1F5F9",
  slate200:"#E2E8F0",
  slate400:"#94A3B8",
  slate500:"#64748B",
  slate600:"#475569",
  slate700:"#334155",
  slate800:"#1E293B",
  slate900:"#0F172A",
  white:   "#FFFFFF",
};

// ─── Role Config ──────────────────────────────────────────────
const ROLES = {
  owner:     { label:"Owner",      color:T.navy,   bg:T.slate100, description:"Full access including settings and all financial data" },
  manager:   { label:"Manager",    color:T.blue,   bg:T.blueLt,  description:"All modules except Settings. Can manage team." },
  staff:     { label:"Staff",      color:T.green,  bg:T.greenLt, description:"Tasks, Social Media, Calendar, Documents only" },
  readonly:  { label:"Read Only",  color:T.slate500,bg:T.slate100,description:"View-only access to assigned modules" },
  accountant:{ label:"Accountant", color:T.purple, bg:T.purpleLt,description:"Financials and Documents read-only access" },
};

// ─── Mock Data ────────────────────────────────────────────────
const MOCK_USERS = [
  { id:"u1", name:"Jane Smith",    email:"jane@smithagency.com",    role:"owner",     last_login:"Today 8:14 AM",    is_active:true,  is_current:true  },
  { id:"u2", name:"Marcus Thompson",email:"marcus@smithagency.com", role:"staff",     last_login:"Today 9:02 AM",    is_active:true,  is_current:false },
  { id:"u3", name:"Priya Patel",   email:"priya@smithagency.com",   role:"manager",   last_login:"Yesterday 5:30 PM",is_active:true,  is_current:false },
  { id:"u4", name:"Steven Bonventre",email:"steven@clubcapitaltax.com",role:"accountant",last_login:"Apr 14, 2026",  is_active:true,  is_current:false },
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
  const [val, setVal] = useState(value);

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
            <button onClick={() => { setVal(value); setEditing(false); }}
              style={{ padding:"6px 10px", fontSize:11, color:T.slate500, background:T.slate100, border:"none", borderRadius:7, cursor:"pointer" }}>Cancel</button>
          </div>
        ) : (
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <span style={{ fontSize:12, color:T.slate600 }}>{val || "—"}</span>
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

// ─── Invite Modal ─────────────────────────────────────────────
const InviteModal = ({ onSave, onCancel }) => {
  const [form, setForm] = useState({ email:"", name:"", role:"staff" });
  const set = (k,v) => setForm(f => ({...f,[k]:v}));

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,0.5)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:20 }}>
      <div style={{ background:T.white, borderRadius:16, width:"100%", maxWidth:460, boxShadow:"0 20px 60px rgba(0,0,0,0.2)", overflow:"hidden" }}>
        <div style={{ padding:"16px 20px", borderBottom:`1px solid ${T.slate200}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={{ fontSize:14, fontWeight:700, color:T.slate900 }}>Invite Team Member</span>
          <button onClick={onCancel} style={{ background:"none", border:"none", fontSize:18, color:T.slate400, cursor:"pointer" }}>×</button>
        </div>
        <div style={{ padding:20 }}>
          {[
            { label:"Full Name", key:"name",  placeholder:"Jane Doe"              },
            { label:"Email",     key:"email", placeholder:"jane@smithagency.com"  },
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
                <div
                  key={key}
                  onClick={() => set("role", key)}
                  style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"10px 12px", borderRadius:9, cursor:"pointer", border:`2px solid ${form.role===key?role.color:T.slate200}`, background:form.role===key?role.bg:T.white }}
                >
                  <div style={{ width:16, height:16, borderRadius:"50%", border:`2px solid ${form.role===key?role.color:T.slate300}`, background:form.role===key?role.color:"transparent", flexShrink:0, marginTop:1 }} />
                  <div>
                    <div style={{ fontSize:12, fontWeight:600, color:form.role===key?role.color:T.slate800 }}>{role.label}</div>
                    <div style={{ fontSize:10, color:T.slate500, marginTop:1 }}>{role.description}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div style={{ padding:"12px 20px", borderTop:`1px solid ${T.slate200}`, display:"flex", justifyContent:"flex-end", gap:8 }}>
          <button onClick={onCancel} style={{ padding:"7px 14px", fontSize:11, fontWeight:600, color:T.slate600, background:T.slate100, border:"none", borderRadius:7, cursor:"pointer" }}>Cancel</button>
          <button
            onClick={() => form.email.trim() && form.name.trim() && onSave(form)}
            disabled={!form.email.trim() || !form.name.trim()}
            style={{ padding:"7px 16px", fontSize:11, fontWeight:600, color:T.white, background:form.email.trim()&&form.name.trim()?T.navy:"#94A3B8", border:"none", borderRadius:7, cursor:"pointer" }}
          >Send Invite</button>
        </div>
      </div>
    </div>
  );
};

// ─── Section: Agency Profile ──────────────────────────────────
// onUpdate receives (column, value) where column is the REAL agency-table
// column name. Licensed States is a text[] array in the DB; the FieldRow
// edits a comma-separated string, so we round-trip on the boundary.
const AgencyProfile = ({ agency, onUpdate }) => {
  const save = (col) => (val) => onUpdate && onUpdate(col, val);
  const saveStates = (val) => {
    const arr = String(val || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    return onUpdate && onUpdate("licensing_states", arr);
  };
  return (
    <Card>
      <SectionHeader title="Agency Profile" sub="Core agency information stored in your Supabase database" />
      <FieldRow label="Agency Name"       value={agency.name}                                           editable onChange={save("name")} />
      <FieldRow label="Owner Name"        value={agency.owner_name}                                     editable onChange={save("owner_name")} />
      <FieldRow label="Entity Type"       value={agency.entity_type}                                    />
      <FieldRow label="EIN / Tax ID"      value={agency.tax_id}       hint="Stored encrypted"          />
      <FieldRow label="SF Agent Code"     value={agency.sf_agent_code}                                  />
      <FieldRow label="Licensed States"   value={(agency.licensing_states || []).join(", ")}            editable onChange={saveStates} hint="Comma-separated (e.g. FL, GA, AL)" />
      <FieldRow label="Primary Email"     value={agency.primary_email} hint="Personal — not @statefarm.com" editable onChange={save("primary_email")} />
      <FieldRow label="Phone"             value={agency.phone}                                          editable onChange={save("phone")} />
      <FieldRow label="Address"           value={agency.address}                                        editable onChange={save("address")} />
      <FieldRow label="Google Account"    value={agency.google_account_email} hint="Ties Vercel, Supabase, Composio" />
      <FieldRow label="BCC URL"           value={agency.vercel_url}    hint="Your permanent BCC address" />
      <FieldRow label="Setup Date"        value={agency.setup_date}    />
    </Card>
  );
};

// ─── Section: Team Access ─────────────────────────────────────
const TeamAccess = ({ users }) => {
  const [allUsers,    setAllUsers]    = useState(users);
  const [showInvite,  setShowInvite]  = useState(false);
  const [editingRole, setEditingRole] = useState(null);

  const handleInvite = async (form) => {
    try {
      const { data: newUser, error } = await supabase
        .from("users")
        .insert({
          agency_id: AGENCY_ID,
          email: form.email,
          full_name: form.name,
          role: form.role,
          is_active: true,
          invited_at: new Date().toISOString(),
        })
        .select()
        .single();
      if (error) {
        console.error("Invite failed:", error);
        alert("Invite failed: " + error.message);
        return;
      }
      setAllUsers(prev => [...prev, {
        ...newUser,
        name: newUser.full_name || form.name,
        last_login: "Never",
        is_current: false,
        pending: true,
      }]);
      setShowInvite(false);
    } catch (e) {
      console.error("Invite error:", e);
      alert("Invite failed: " + (e?.message || String(e)));
    }
  };

  const handleRevoke = async (id) => {
    try {
      const { error } = await supabase
        .from("users")
        .update({ is_active: false })
        .eq("id", id);
      if (error) {
        console.error("Revoke failed:", error);
        alert("Revoke failed: " + error.message);
        return;
      }
      setAllUsers(prev => prev.map(u => u.id===id ? {...u, is_active:false} : u));
    } catch (e) {
      console.error("Revoke error:", e);
      alert("Revoke failed: " + (e?.message || String(e)));
    }
  };

  const handleRoleChange = async (id, role) => {
    try {
      const { error } = await supabase
        .from("users")
        .update({ role })
        .eq("id", id);
      if (error) {
        console.error("Role change failed:", error);
        alert("Role change failed: " + error.message);
        return;
      }
      setAllUsers(prev => prev.map(u => u.id===id ? {...u, role} : u));
      setEditingRole(null);
    } catch (e) {
      console.error("Role change error:", e);
      alert("Role change failed: " + (e?.message || String(e)));
    }
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:16 }}>
        <div>
          <div style={{ fontSize:14, fontWeight:700, color:T.slate900 }}>Team Access</div>
          <div style={{ fontSize:12, color:T.slate500, marginTop:3 }}>Manage who has access to your BCC and what they can see</div>
        </div>
        <button onClick={() => setShowInvite(true)}
          style={{ display:"flex", alignItems:"center", gap:6, padding:"8px 16px", fontSize:11, fontWeight:600, color:T.white, background:T.navy, border:"none", borderRadius:8, cursor:"pointer" }}>
          + Invite User
        </button>
      </div>

      {/* Role Reference */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:8, marginBottom:16 }}>
        {Object.entries(ROLES).map(([key, role]) => (
          <div key={key} style={{ background:role.bg, borderRadius:9, padding:"8px 10px" }}>
            <div style={{ fontSize:11, fontWeight:700, color:role.color, marginBottom:3 }}>{role.label}</div>
            <div style={{ fontSize:9, color:T.slate600, lineHeight:1.4 }}>{role.description}</div>
          </div>
        ))}
      </div>

      {/* User List */}
      <Card>
        {allUsers.filter(u => u.is_active).map((user, i) => {
          const role = ROLES[user.role] || ROLES.readonly;
          const isLast = i === allUsers.filter(u=>u.is_active).length - 1;
          return (
            <div key={user.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 0", borderBottom:isLast?"none":`1px solid ${T.slate100}` }}>
              {/* Avatar */}
              <div style={{ width:36, height:36, borderRadius:10, background:user.is_current?T.navy:T.slate200, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:user.is_current?T.white:T.slate500, flexShrink:0 }}>
                {user.name.split(" ").map(n=>n[0]).join("").slice(0,2)}
              </div>

              <div style={{ flex:1 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontSize:13, fontWeight:600, color:T.slate900 }}>{user.name}</span>
                  {user.is_current && <span style={{ fontSize:9, fontWeight:600, padding:"2px 6px", borderRadius:20, background:T.navy, color:T.white }}>You</span>}
                  {user.pending   && <span style={{ fontSize:9, fontWeight:600, padding:"2px 6px", borderRadius:20, background:T.amberLt, color:"#92400E" }}>Invite Pending</span>}
                </div>
                <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>{user.email} · Last login: {user.last_login}</div>
              </div>

              {/* Role */}
              {editingRole === user.id ? (
                <select
                  defaultValue={user.role}
                  onChange={e => handleRoleChange(user.id, e.target.value)}
                  autoFocus
                  onBlur={() => setEditingRole(null)}
                  style={{ padding:"5px 8px", fontSize:11, color:T.slate700, border:`1px solid ${T.blue}`, borderRadius:7, background:T.white, outline:"none" }}
                >
                  {Object.keys(ROLES).filter(r => r !== "owner" || user.role === "owner").map(r => (
                    <option key={r} value={r}>{ROLES[r].label}</option>
                  ))}
                </select>
              ) : (
                <span
                  onClick={() => !user.is_current && setEditingRole(user.id)}
                  style={{ fontSize:10, fontWeight:600, padding:"4px 10px", borderRadius:20, background:role.bg, color:role.color, cursor:user.is_current?"default":"pointer", whiteSpace:"nowrap" }}
                  title={user.is_current?"":"Click to change role"}
                >
                  {role.label}
                </span>
              )}

              {/* Revoke */}
              {!user.is_current && !user.pending && (
                <button onClick={() => handleRevoke(user.id)}
                  style={{ fontSize:10, color:T.red, background:T.redLt, border:"none", borderRadius:6, padding:"5px 10px", cursor:"pointer", whiteSpace:"nowrap" }}>
                  Revoke
                </button>
              )}
            </div>
          );
        })}
      </Card>

      {showInvite && <InviteModal onSave={handleInvite} onCancel={() => setShowInvite(false)} />}
    </div>
  );
};

// ─── Section: Connected Accounts ─────────────────────────────
// Live data from connection_health table. Polled every 5 min by the
// connection-health-poller Edge Function. Grouped by category.

const CONNECTION_CATEGORIES = {
  gmail:           { category: "Google Workspace", icon: "📧", display: "Gmail" },
  googledrive:     { category: "Google Workspace", icon: "📁", display: "Google Drive" },
  googledocs:      { category: "Google Workspace", icon: "📝", display: "Google Docs" },
  googlesheets:    { category: "Google Workspace", icon: "📊", display: "Google Sheets" },
  googlecalendar:  { category: "Google Workspace", icon: "📅", display: "Google Calendar" },
  supabase:        { category: "Infrastructure",   icon: "🗄️", display: "Supabase" },
  github:          { category: "Infrastructure",   icon: "🐙", display: "GitHub" },
  composio:        { category: "Infrastructure",   icon: "🔌", display: "Composio" },
  facebook:        { category: "Social Media",     icon: "👥", display: "Facebook" },
  linkedin:        { category: "Social Media",     icon: "💼", display: "LinkedIn" },
  instagram:       { category: "Social Media",     icon: "📸", display: "Instagram" },
  slack:           { category: "Communication",    icon: "💬", display: "Slack" },
};

const STATUS_LABEL = {
  ACTIVE:       { label: "Connected",   pill: { bg: T.greenLt, color: "#065F46" } },
  EXPIRED:      { label: "Expired",     pill: { bg: T.redLt,   color: "#991B1B" } },
  FAILED:       { label: "Failed",      pill: { bg: T.redLt,   color: "#991B1B" } },
  INACTIVE:     { label: "Inactive",    pill: { bg: T.redLt,   color: "#991B1B" } },
  INITIALIZING: { label: "Connecting",  pill: { bg: T.amberLt, color: "#92400E" } },
  GONE:         { label: "Gone",        pill: { bg: T.slate100,color: T.slate500 } },
};

const ConnectedAccounts = () => {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from("connection_health")
          .select("toolkit_slug,display_name,status,status_color,connected_account_id,status_reason,last_checked_at,account_updated_at,word_id")
          .eq("agency_id", AGENCY_ID);
        if (cancelled) return;
        if (error) { setErr(error.message); setLoading(false); return; }
        setRows(Array.isArray(data) ? data : []);
        setLoading(false);
      } catch (e) {
        if (!cancelled) { setErr(e?.message || "Failed to load connections"); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Group by category, sort within each
  const groups = {};
  (rows || []).forEach(r => {
    const meta = CONNECTION_CATEGORIES[r?.toolkit_slug] || { category: "Other", icon: "🔗", display: r?.display_name || r?.toolkit_slug || "Unknown" };
    const cat = meta.category;
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({ ...r, _meta: meta });
  });
  const order = ["Google Workspace", "Infrastructure", "Social Media", "Communication", "Other"];
  Object.keys(groups).forEach(k => {
    groups[k].sort((a,b) => (a._meta?.display || "").localeCompare(b._meta?.display || ""));
  });

  const fmt = (ts) => {
    if (!ts) return "—";
    try {
      const d = new Date(ts);
      const now = new Date();
      const diffMs = now - d;
      const mins = Math.floor(diffMs / 60000);
      if (mins < 1)  return "just now";
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24)  return `${hrs}h ago`;
      const days = Math.floor(hrs / 24);
      return `${days}d ago`;
    } catch { return String(ts); }
  };

  const summary = (() => {
    const counts = { ACTIVE: 0, expired_or_failed: 0, total: rows?.length || 0 };
    (rows || []).forEach(r => {
      if (r?.status === "ACTIVE") counts.ACTIVE++;
      else if (["EXPIRED","FAILED","INACTIVE","GONE"].includes(r?.status)) counts.expired_or_failed++;
    });
    return counts;
  })();

  return (
    <div>
      <SectionHeader title="Connected Accounts" sub="Composio manages all external connections. Reconnect any account that shows an error." />

      <div style={{ background:T.blueLt, border:`1px solid ${T.blue}20`, borderLeft:`4px solid ${T.blue}`, borderRadius:10, padding:"12px 16px", marginBottom:16 }}>
        <div style={{ fontSize:12, fontWeight:600, color:T.navy, marginBottom:3 }}>How connections work</div>
        <div style={{ fontSize:11, color:T.slate600, lineHeight:1.6 }}>
          BCC automations use Composio to interact with Gmail, Drive, Calendar, GitHub, Supabase, and social platforms on your behalf. Each connection is authenticated via OAuth; if a token expires, the dependent automation will fail until you reconnect. Status below is refreshed every 5 minutes by the Connection Health Poller.
        </div>
      </div>

      {/* Summary strip */}
      {!loading && summary.total > 0 && (
        <div style={{ display:"flex", gap:10, marginBottom:14, fontSize:11, color:T.slate600 }}>
          <span><b style={{ color:T.green }}>{summary.ACTIVE}</b> active</span>
          <span style={{ color:T.slate300 }}>·</span>
          <span><b style={{ color:summary.expired_or_failed > 0 ? T.red : T.slate500 }}>{summary.expired_or_failed}</b> needing attention</span>
          <span style={{ color:T.slate300 }}>·</span>
          <span>{summary.total} total</span>
        </div>
      )}

      {loading && (
        <div style={{ fontSize:12, color:T.slate500, padding:"24px 8px" }}>Loading connection status…</div>
      )}

      {!loading && err && (
        <div style={{ fontSize:12, color:T.red, padding:"24px 8px" }}>
          Could not load connections: {String(err)}
        </div>
      )}

      {!loading && !err && (rows?.length || 0) === 0 && (
        <div style={{ fontSize:12, color:T.slate500, padding:"24px 8px" }}>No connections found. The Connection Health Poller may not have run yet.</div>
      )}

      {!loading && !err && (rows?.length || 0) > 0 && (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {order.filter(c => Array.isArray(groups[c]) && groups[c].length > 0).map(cat => (
            <div key={cat}>
              <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", color:T.slate500, letterSpacing:0.5, marginBottom:8 }}>{cat}</div>
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                {(groups[cat] || []).map(conn => {
                  const isError = ["EXPIRED","FAILED","INACTIVE","GONE"].includes(conn?.status);
                  const statusMeta = STATUS_LABEL[conn?.status] || { label: conn?.status || "Unknown", pill: { bg: T.slate100, color: T.slate500 } };
                  return (
                    <Card key={conn?.connected_account_id || conn?.toolkit_slug} style={{ border:`1px solid ${isError ? T.red : T.slate200}` }}>
                      <div style={{ display:"flex", alignItems:"center", gap:14 }}>
                        <div style={{ width:44, height:44, borderRadius:12, background:isError ? T.redLt : T.slate50, border:`1px solid ${isError ? T.red : T.slate200}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0 }}>
                          {conn?._meta?.icon || "🔗"}
                        </div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:3, flexWrap:"wrap" }}>
                            <span style={{ fontSize:13, fontWeight:700, color:T.slate900 }}>{conn?._meta?.display || conn?.display_name}</span>
                            <span style={{ fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:20, background: statusMeta.pill.bg, color: statusMeta.pill.color }}>{statusMeta.label}</span>
                          </div>
                          <div style={{ fontSize:11, color:T.slate600, wordBreak:"break-all" }}>{conn?.connected_account_id || "—"}</div>
                          <div style={{ fontSize:10, color: isError ? T.red : T.slate400, marginTop:2 }}>
                            {conn?.status_reason || (isError ? "Reconnect required" : "Active")} · Last checked: {fmt(conn?.last_checked_at)}
                          </div>
                        </div>
                        {isError && (
                          <a href="https://platform.composio.dev/connections" target="_blank" rel="noopener noreferrer"
                            style={{ padding:"7px 14px", fontSize:11, fontWeight:600, color:T.white, background:T.red, border:"none", borderRadius:8, cursor:"pointer", flexShrink:0, textDecoration:"none" }}>
                            Reconnect
                          </a>
                        )}
                        {conn?.status === "ACTIVE" && (
                          <div style={{ fontSize:11, color:T.green, fontWeight:600, flexShrink:0 }}>✓ Active</div>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Section: BCC Configuration ──────────────────────────────
// Live data: reads from agency, settings, aipp_tracking tables.

const BCCConfiguration = () => {
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const yearNow = new Date().getFullYear();
        const [agencyResp, settingsResp, aippResp] = await Promise.all([
          supabase.from("agency").select("*").eq("id", AGENCY_ID).maybeSingle(),
          supabase.from("settings").select("setting_key,setting_value").eq("agency_id", AGENCY_ID),
          // aipp_tracking column is program_year (not year). Prior code silently
          // returned no data.
          supabase.from("aipp_tracking")
            .select("program_year,target_amount,earned_ytd")
            .eq("agency_id", AGENCY_ID)
            .eq("program_year", yearNow)
            .maybeSingle(),
        ]);
        if (cancelled) return;

        if (agencyResp.error)  { setErr(agencyResp.error.message);  setLoading(false); return; }

        const settingsMap = {};
        (settingsResp.data || []).forEach(s => { settingsMap[s.setting_key] = s.setting_value; });

        const agency = agencyResp.data || {};
        const aipp = aippResp?.data || null;

        setCfg({
          // Agency facts
          accounting_method: "Accrual (CPA aligned)",  // per persistent_memory 2026-06-10
          fiscal_year_start: "January 1",
          currency:          "USD",
          timezone:          settingsMap.timezone || "America/New_York",
          // Briefing — settings keys are `briefing_*`, not `daily_briefing_*`.
          briefing_time:     settingsMap.briefing_time   || "12:00 UTC",
          briefing_email:    settingsMap.briefing_email  || "tmapp09@gmail.com",
          briefing_enabled:  (settingsMap.briefing_enabled ?? "true") === "true",
          // AIPP — column is program_year.
          aipp_year:         aipp?.program_year || yearNow,
          aipp_target:       aipp?.target_amount ?? null,
          aipp_target_is_placeholder: !aipp?.target_amount || Number(aipp?.target_amount) === 50000,
          // Compensation — agency has smvc_rate_pc and blended_rate_other;
          // there is no smvc_rate_life_health_fs column. Dropped that fallback.
          smvc_rate_pc:      agency.smvc_rate_pc       ?? null,
          blended_rate:      agency.blended_rate_other ?? null,
          a005_loaded:       Boolean(agency.smvc_rate_pc && Number(agency.smvc_rate_pc) !== 0.10),
          // Entity
          entity_type:       agency.entity_type || "S-Corp",
          lapse_rate:        agency.lapse_rate_annual,
          // Dashboard — settings key is `dashboard_revenue_period`.
          dashboard_period:  settingsMap.dashboard_revenue_period || "mtd",
        });
        setLoading(false);
      } catch (e) {
        if (!cancelled) { setErr(e?.message || "Failed to load configuration"); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const [savingKey, setSavingKey] = useState(null);
  const pct = (x) => (x == null || x === "" ? "—" : `${(Number(x) * 100).toFixed(1)}%`);
  const money = (x) => (x == null || x === "" ? "—" : `$${Number(x).toLocaleString()}`);

  // Persist a config change to the right table based on the key.
  //   briefing_*, dashboard_period, timezone → settings (KV upsert, real DB keys below)
  //   smvc_rate_pc, blended_rate, lapse_rate → agency (single UPDATE, DB column below)
  //   aipp_target                            → aipp_tracking (upsert by agency_id + program_year)
  // Local state updates optimistically after success; rolls back on error via re-set.
  const save = async (k, v) => {
    const prevCfg = cfg;
    setCfg(c => c ? ({...c, [k]: v}) : c);   // optimistic
    setSavingKey(k);
    try {
      if (k === "briefing_enabled" || k === "briefing_time" || k === "briefing_email" || k === "timezone" || k === "dashboard_period") {
        const dbKeyMap = { dashboard_period: "dashboard_revenue_period" };
        const dbKey = dbKeyMap[k] || k;
        const dbVal = typeof v === "boolean" ? String(v) : String(v ?? "");
        const setting_type = typeof v === "boolean" ? "boolean" : "string";
        const { error } = await supabase
          .from("settings")
          .upsert(
            { agency_id: AGENCY_ID, setting_key: dbKey, setting_value: dbVal, setting_type, updated_by: "webapp" },
            { onConflict: "agency_id,setting_key" }
          );
        if (error) throw error;
      } else if (k === "smvc_rate_pc" || k === "blended_rate" || k === "lapse_rate") {
        const columnMap = { smvc_rate_pc: "smvc_rate_pc", blended_rate: "blended_rate_other", lapse_rate: "lapse_rate_annual" };
        const num = v === "" || v == null ? null : Number(v);
        if (num != null && !Number.isFinite(num)) throw new Error("Must be a number");
        const { error } = await supabase
          .from("agency")
          .update({ [columnMap[k]]: num })
          .eq("id", AGENCY_ID);
        if (error) throw error;
      } else if (k === "aipp_target") {
        const num = v === "" || v == null ? null : Number(v);
        if (num != null && !Number.isFinite(num)) throw new Error("Must be a number");
        const { error } = await supabase
          .from("aipp_tracking")
          .upsert(
            { agency_id: AGENCY_ID, program_year: cfg.aipp_year, target_amount: num },
            { onConflict: "agency_id,program_year" }
          );
        if (error) throw error;
      }
    } catch (e) {
      console.error("BCC config save error [" + k + "]:", e);
      alert("Could not save " + k + ": " + (e?.message || "unknown error"));
      setCfg(prevCfg);   // rollback
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) {
    return <div style={{ fontSize:12, color:T.slate500, padding:"24px 8px" }}>Loading configuration…</div>;
  }
  if (err || !cfg) {
    return <div style={{ fontSize:12, color:T.red, padding:"24px 8px" }}>Could not load configuration: {String(err || "no data")}</div>;
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      {/* Daily Briefing */}
      <Card>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
          <div>
            <div style={{ fontSize:13, fontWeight:700, color:T.slate900 }}>Daily Briefing Email</div>
            <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>Morning snapshot sent to your inbox every day</div>
          </div>
          <Toggle value={cfg.briefing_enabled} onChange={() => save("briefing_enabled", !cfg.briefing_enabled)} />
        </div>
        {cfg.briefing_enabled && (
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            {[
              { label:"Send Time",      key:"briefing_time",  value:cfg.briefing_time,  hint:"24hr UTC; runs daily" },
              { label:"Delivery Email", key:"briefing_email", value:cfg.briefing_email, hint:"Where briefings are sent" },
            ].map(f => (
              <div key={f.key}>
                <label style={{ fontSize:11, fontWeight:600, color:T.slate600, display:"block", marginBottom:5 }}>
                  {f.label.toUpperCase()}
                  {savingKey === f.key && <span style={{ marginLeft:6, color:T.slate400, fontWeight:400 }}>saving…</span>}
                </label>
                <input
                  defaultValue={f.value || ""}
                  onBlur={e => { if (e.target.value !== (f.value || "")) save(f.key, e.target.value); }}
                  onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
                  style={{ width:"100%", padding:"8px 10px", fontSize:12, color:T.slate800, border:`1px solid ${T.slate200}`, borderRadius:8, outline:"none", boxSizing:"border-box" }} />
                <div style={{ fontSize:10, color:T.slate400, marginTop:3 }}>{f.hint} · saves on blur / Enter</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Financial Settings */}
      <Card>
        <div style={{ fontSize:13, fontWeight:700, color:T.slate900, marginBottom:14 }}>Financial Settings</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          {[
            { label:"Accounting Method", value:cfg.accounting_method, hint:"Aligned with CPA — do not change" },
            { label:"Fiscal Year Start", value:cfg.fiscal_year_start, hint:"Calendar year Jan-Dec" },
            { label:"Currency",          value:cfg.currency,          hint:"USD" },
            { label:"Timezone",          value:cfg.timezone,          hint:"Used for scheduling" },
            { label:"Entity Type",       value:cfg.entity_type,       hint:"Tax structure" },
            { label:"Lapse Rate (annual)", value:(cfg.lapse_rate == null ? "Not set — pull from AgentWeb" : pct(cfg.lapse_rate)), hint:"SF-reported retention metric" },
          ].map(f => (
            <div key={f.label}>
              <label style={{ fontSize:11, fontWeight:600, color:T.slate600, display:"block", marginBottom:5 }}>{f.label.toUpperCase()}</label>
              <div style={{ padding:"8px 10px", fontSize:12, color:T.slate600, background:T.slate50, borderRadius:8, border:`1px solid ${T.slate200}` }}>{f.value || "—"}</div>
              <div style={{ fontSize:10, color:T.slate400, marginTop:3 }}>{f.hint}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Compensation Rates */}
      <Card>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
          <div style={{ fontSize:13, fontWeight:700, color:T.slate900 }}>Compensation Rates</div>
          {!cfg.a005_loaded && (
            <span style={{ fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:20, background:T.amberLt, color:"#92400E" }}>A005 pending</span>
          )}
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:T.slate600, display:"block", marginBottom:5 }}>SMVC RATE (P&C)</label>
            <div style={{ padding:"8px 10px", fontSize:12, color:T.slate600, background:T.slate50, borderRadius:8, border:`1px solid ${T.slate200}` }}>{pct(cfg.smvc_rate_pc)}</div>
            <div style={{ fontSize:10, color:T.slate400, marginTop:3 }}>{cfg.a005_loaded ? "From A005 agreement" : "Default placeholder — needs A005"}</div>
          </div>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:T.slate600, display:"block", marginBottom:5 }}>BLENDED RATE (Life/Health/FS)</label>
            <div style={{ padding:"8px 10px", fontSize:12, color:T.slate600, background:T.slate50, borderRadius:8, border:`1px solid ${T.slate200}` }}>{pct(cfg.blended_rate)}</div>
            <div style={{ fontSize:10, color:T.slate400, marginTop:3 }}>{cfg.a005_loaded ? "From A005 agreement" : "Default placeholder — needs A005"}</div>
          </div>
        </div>
      </Card>

      {/* AIPP Settings */}
      <Card>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
          <div style={{ fontSize:13, fontWeight:700, color:T.slate900 }}>AIPP Configuration</div>
          {cfg.aipp_target_is_placeholder && (
            <span style={{ fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:20, background:T.amberLt, color:"#92400E" }}>Target placeholder</span>
          )}
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:T.slate600, display:"block", marginBottom:5 }}>PROGRAM YEAR</label>
            <div style={{ padding:"8px 10px", fontSize:12, color:T.slate600, background:T.slate50, borderRadius:8, border:`1px solid ${T.slate200}` }}>{cfg.aipp_year || "—"}</div>
          </div>
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:T.slate600, display:"block", marginBottom:5 }}>AIPP TARGET</label>
            <div style={{ padding:"8px 10px", fontSize:12, color:T.slate600, background:T.slate50, borderRadius:8, border:`1px solid ${T.slate200}` }}>{money(cfg.aipp_target)}</div>
            <div style={{ fontSize:10, color:T.slate400, marginTop:3 }}>{cfg.aipp_target_is_placeholder ? "Update when SF publishes target" : "Used for progress calculations"}</div>
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
              <button key={opt.id} disabled={savingKey === "dashboard_period"} onClick={() => save("dashboard_period", opt.id)}
                style={{ padding:"7px 14px", fontSize:11, fontWeight:cfg.dashboard_period===opt.id?600:400, color:cfg.dashboard_period===opt.id?T.white:T.slate600, background:cfg.dashboard_period===opt.id?T.navy:T.white, border:`1px solid ${cfg.dashboard_period===opt.id?T.navy:T.slate200}`, borderRadius:7, cursor: savingKey === "dashboard_period" ? "wait" : "pointer", opacity: savingKey === "dashboard_period" ? 0.6 : 1 }}>
                {opt.label}
              </button>
            ))}
          </div>
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
      url: agency.vercel_url || "https://vercel.com/dashboard",
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

// ─── Main Settings Module ─────────────────────────────────────
export default function Settings() {

  const [agencyData, setAgencyData] = useState(null);
  const [settingsData, setSettingsData] = useState([]);
  const [usersData, setUsersData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadSettings() {
      if (!supabase || !AGENCY_ID) { setLoading(false); return; }
      try {
        const [agencyRes, settingsRes, usersRes] = await Promise.all([
          supabase.from("agency").select("*").eq("id", AGENCY_ID).single(),
          supabase.from("settings").select("*").eq("agency_id", AGENCY_ID),
          supabase.from("users").select("*").eq("agency_id", AGENCY_ID),
        ]);
        if (agencyRes.data) setAgencyData(agencyRes.data);
        if (settingsRes.data) setSettingsData(settingsRes.data);
        if (usersRes.data) setUsersData(usersRes.data);
      } catch(e) { console.error("Settings load error:", e); }
      finally { setLoading(false); }
    }
    loadSettings();
  }, []);

  const [section, setSection] = useState("profile");

  // Persist a single agency-table column back to Supabase.
  // Called by AgencyProfile FieldRow Save buttons.
  const handleAgencyUpdate = async (column, value) => {
    try {
      // Coerce empty string to null so DB nulls are honored consistently.
      const payload = { [column]: value === "" ? null : value };
      const { data, error } = await supabase
        .from("agency")
        .update(payload)
        .eq("id", AGENCY_ID)
        .select()
        .single();
      if (error) throw error;
      setAgencyData(data);
    } catch (e) {
      console.error("agency update error:", e);
      alert("Could not save " + column + ": " + (e?.message || "unknown error"));
    }
  };

  // Map real Supabase agency row to the shape AgencyProfile/About expect
  const realAgency = agencyData ? {
    name:              agencyData.name             || MOCK_AGENCY.name,
    owner_name:        agencyData.owner_name        || MOCK_AGENCY.owner_name,
    entity_type:       agencyData.entity_type       || MOCK_AGENCY.entity_type,
    tax_id:            agencyData.tax_id            || MOCK_AGENCY.tax_id,
    sf_agent_code:     agencyData.state_farm_agent_code || MOCK_AGENCY.sf_agent_code,
    licensing_states:  agencyData.licensing_states  || MOCK_AGENCY.licensing_states,
    primary_email:     agencyData.primary_email     || MOCK_AGENCY.primary_email,
    phone:             agencyData.phone             || MOCK_AGENCY.phone,
    address:           agencyData.address           || MOCK_AGENCY.address,
    google_account_email: agencyData.google_account_email || MOCK_AGENCY.google_account_email,
    vercel_url:        agencyData.vercel_url        || MOCK_AGENCY.vercel_url,
    setup_date:        agencyData.setup_date        || MOCK_AGENCY.setup_date,
  } : MOCK_AGENCY;

  const sections = [
    { id:"profile",     label:"Agency Profile"    },
    { id:"team",        label:"Team Access"        },
    { id:"connections", label:"Connections"        },
    { id:"config",      label:"Configuration"      },
    { id:"about",       label:"About"              },
  ];

  return (
    <div>
      {/* Module Header */}
      <div style={{ marginBottom:16 }}>
        <div style={{ fontSize:20, fontWeight:700, color:T.slate900, letterSpacing:"-0.02em" }}>Settings</div>
        <div style={{ fontSize:12, color:T.slate500, marginTop:3 }}>
          Agency profile · Team access · Connected accounts · BCC configuration
        </div>
      </div>

      {/* Section Navigation */}
      <div style={{ display:"flex", gap:2, flexWrap:"wrap", background:T.slate100, borderRadius:10, padding:4, marginBottom:18 }}>
        {sections.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)} style={{ padding:"7px 14px", fontSize:12, fontWeight:section===s.id?600:400, color:section===s.id?T.slate900:T.slate500, background:section===s.id?T.white:"transparent", border:"none", borderRadius:7, cursor:"pointer", transition:"all 0.12s", boxShadow:section===s.id?"0 1px 3px rgba(0,0,0,0.08)":"none" }}>
            {s.label}
          </button>
        ))}
      </div>

      {/* Section Content */}
      {section === "profile"     && <AgencyProfile      agency={realAgency} onUpdate={handleAgencyUpdate} />}
      {section === "team"        && <TeamAccess         users={usersData.length > 0
        ? usersData.map(u => ({
            ...u,
            name: u.full_name || u.email || "Unknown",
            pending: !u.auth_user_id,
            is_current: false,  // TODO: compare to auth.uid() when auth wiring lands
          }))
        : MOCK_USERS} />}
      {section === "connections" && <ConnectedAccounts />}
      {section === "config"      && <BCCConfiguration />}
      {section === "about"       && <About              agency={realAgency} />}
    </div>
  );
}
