import { useState, useMemo, useEffect, useRef } from "react";
import { supabase, AGENCY_ID } from "../lib/supabase.js";
import { useSupabaseTable } from "../lib/hooks.js";
import EmptyState from "../components/EmptyState.jsx";

// ============================================================
// BCC ALERTS & NOTIFICATIONS MODULE v1.0
// Business Command Center — State Farm Agent Edition
// Built by Imaginary Farms LLC · imaginary-farms.com
//
// SECTIONS:
//   1. Overview    — Alert summary, critical items front and center
//   2. All Alerts  — Complete alert list, filterable by type/severity
//   3. History     — Resolved alerts and notification log
//
// ALERT TYPES:
//   compliance    — Deadline approaching, rule violation flagged
//   automation    — Recipe failed, connection error, partial run
//   financial     — Payment due, ratio warning, reconciliation needed
//   hr            — New applicant, onboarding item, performance due
//   document      — Import complete, import failed, manual review needed
//   social_media  — Manual post needed, failed post, engagement milestone
//   system        — BCC updates, setup items, general notices
//
// DATA: Reads alerts table in Supabase
// Alerts are created by:
//   - Automations (Composio run failures, doc imports)
//   - Compliance Deadline Monitor (cron recipe)
//   - Resume Scanner (new applicants)
//   - Agent manually (from any module)
//   - Claude (during conversations)
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

// ─── Alert Type Config ────────────────────────────────────────
const ALERT_TYPES = {
  compliance:   { label:"Compliance",   color:T.red,    bg:T.redLt,    icon:"🛡️" },
  automation:   { label:"Automation",   color:T.teal,   bg:T.tealLt,   icon:"⚡" },
  recipe_silent_failure:
                { label:"Automation Stale", color:T.teal,   bg:T.tealLt,   icon:"⚡" },
  financial:    { label:"Financial",    color:T.blue,   bg:T.blueLt,   icon:"💰" },
  hr:           { label:"HR",           color:T.green,  bg:T.greenLt,  icon:"👥" },
  document:     { label:"Documents",    color:T.amber,  bg:T.amberLt,  icon:"📁" },
  social_media: { label:"Social Media", color:T.purple, bg:T.purpleLt, icon:"📱" },
  system:       { label:"System",       color:T.navy,   bg:T.slate100, icon:"⚙️" },
};

// ─── Severity Config ──────────────────────────────────────────
const SEVERITY = {
  critical: { color:T.red,    bg:T.redLt,    label:"Critical", order:0 },
  warning:  { color:T.amber,  bg:T.amberLt,  label:"Warning",  order:1 },
  info:     { color:T.blue,   bg:T.blueLt,   label:"Info",     order:2 },
};

// ─── Shared Components ────────────────────────────────────────
const Card = ({ children, style={} }) => (
  <div style={{ background:T.white, border:`1px solid ${T.slate200}`, borderRadius:12, padding:"16px 18px", ...style }}>
    {children}
  </div>
);


// Format an ISO timestamp like "Jun 29, 9:26pm" — degrades gracefully on
// missing/invalid input so the UI never crashes on a stray null.
const formatTimestamp = (iso) => {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", "");
    return `${dateStr}, ${timeStr}`;
  } catch { return ""; }
};

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
      >\u26a1 Ask Claude</button>
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
              <button onClick={go} style={{ width: "100%", background: T.blue, color: T.white, border: "none", borderRadius: 8, padding: "8px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                Open Claude.ai &amp; paste
              </button>
            ) : demoMode ? (
              <div style={{ background: "#FFFBEB", border: "1px solid #D9770633", borderRadius: 8, padding: "8px 11px", fontSize: 11, lineHeight: 1.55, color: "#D97706" }}>
                <strong>Demo mode.</strong> On a real BCC this opens the agent's own Claude.ai, ready to paste.
              </div>
            ) : (
              <div style={{ background: "#ECFDF3", border: "1px solid #16A34A33", borderRadius: 8, padding: "8px 11px", fontSize: 11, lineHeight: 1.55, color: "#16A34A" }}>
                \u2713 Claude.ai opened in a new tab \u2014 paste with Ctrl/\u2318+V.
              </div>
            )}
          </div>
          <div style={{ marginTop: 9, fontSize: 10, color: T.slate400, lineHeight: 1.5 }}>
            Opens <em>your</em> Claude account \u2014 your subscription, your Project.
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Alert Card Component ─────────────────────────────────────
const AlertCard = ({ alert, onRead, onResolve, onNavigate }) => {
  const [expanded, setExpanded] = useState(false);
  const type = ALERT_TYPES[alert.alert_type] || ALERT_TYPES.system;
  const sev  = SEVERITY[alert.severity] || SEVERITY.info;

  return (
    <div style={{
      background: alert.is_resolved ? T.slate50 : T.white,
      border:`1px solid ${expanded ? sev.color : alert.is_read ? T.slate200 : sev.color+"60"}`,
      borderLeft:`4px solid ${alert.is_resolved ? T.slate300 : sev.color}`,
      borderRadius:10, overflow:"hidden",
      opacity: alert.is_resolved ? 0.65 : 1,
      transition:"border-color 0.15s",
    }}>
      <div style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"12px 14px", cursor:"pointer" }} onClick={() => { setExpanded(e=>!e); !alert.is_read && onRead(alert.id); }}>

        {/* Unread dot */}
        <div style={{ width:8, height:8, borderRadius:"50%", background:alert.is_read||alert.is_resolved?T.slate200:sev.color, flexShrink:0, marginTop:5 }} />

        {/* Content */}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, flexWrap:"wrap" }}>
            <span style={{ fontSize:14 }}>{type.icon}</span>
            <span style={{ fontSize:12, fontWeight:alert.is_read?500:700, color:alert.is_resolved?T.slate400:T.slate900 }}>{alert.title}</span>
            {!alert.is_read && !alert.is_resolved && (
              <span style={{ fontSize:9, fontWeight:700, padding:"2px 6px", borderRadius:20, background:sev.color, color:T.white }}>NEW</span>
            )}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
            <span style={{ fontSize:9, fontWeight:600, padding:"2px 7px", borderRadius:20, background:type.bg, color:type.color }}>{type.label}</span>
            <span style={{ fontSize:9, fontWeight:600, padding:"2px 7px", borderRadius:20, background:sev.bg, color:sev.color }}>{sev.label}</span>
            {alert.due_date && <span style={{ fontSize:10, color:T.amber, fontWeight:500 }}>📅 {alert.due_date}</span>}
            <span style={{ fontSize:10, color:T.slate400 }}>{alert.created_at}</span>
            {alert.is_resolved && <span style={{ fontSize:9, padding:"2px 7px", borderRadius:20, background:T.greenLt, color:"#065F46", fontWeight:600 }}>✓ Resolved</span>}
          </div>
        </div>

        <span style={{ color:T.slate400, fontSize:11, flexShrink:0, marginTop:2 }}>{expanded?"▲":"▼"}</span>
      </div>

      {expanded && (
        <div style={{ padding:"0 14px 14px 36px", borderTop:`1px solid ${T.slate100}` }}>
          <div style={{ fontSize:12, color:T.slate700, lineHeight:1.7, marginTop:10, marginBottom:12 }}>
            {alert.message}
          </div>
          {alert.resolved_at && (
            <div style={{ fontSize:11, color:T.green, marginBottom:10 }}>✓ Resolved {formatTimestamp(alert.resolved_at)}</div>
          )}
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            {alert.module_reference && !alert.is_resolved && (
              <button
                onClick={() => onNavigate(alert.module_reference)}
                style={{ padding:"6px 14px", fontSize:11, fontWeight:600, color:T.white, background:T.navy, border:"none", borderRadius:7, cursor:"pointer" }}
              >
                Open Module
              </button>
            )}
            {!alert.is_resolved && (
              <button
                onClick={() => onResolve(alert.id)}
                style={{ padding:"6px 14px", fontSize:11, fontWeight:600, color:"#065F46", background:T.greenLt, border:"none", borderRadius:7, cursor:"pointer" }}
              >
                ✓ Mark Resolved
              </button>
            )}
            <AskBtn size="small" context={`Alert details:\nType: ${alert.alert_type}\nSeverity: ${alert.severity}\nTitle: ${alert.title}\nMessage: ${alert.message}\n${alert.due_date?"Due: "+alert.due_date:""}\n\nHelp me understand this alert and what specific action I should take to resolve it.`} />
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Section: Overview ────────────────────────────────────────
const AlertsOverview = ({ alerts, onRead, onResolve, onNavigate }) => {
  const active   = alerts.filter(a => !a.is_resolved);
  const unread   = active.filter(a => !a.is_read);
  const critical = active.filter(a => a.severity === "critical");
  const warning  = active.filter(a => a.severity === "warning");
  const info     = active.filter(a => a.severity === "info");

  const markAllRead = () => active.filter(a => !a.is_read).forEach(a => onRead(a.id));

  return (
    <div>
      {/* KPI Row */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))", gap:10, marginBottom:16 }}>
        {[
          { label:"Unread",   value:unread.length,   color:T.navy,  border:T.navy  },
          { label:"Critical", value:critical.length, color:critical.length>0?T.red:T.green,   border:critical.length>0?T.red:T.green   },
          { label:"Warning",  value:warning.length,  color:warning.length>0?T.amber:T.green,  border:warning.length>0?T.amber:T.green  },
          { label:"Info",     value:info.length,     color:T.blue,  border:T.blue  },
        ].map((k,i) => (
          <div key={i} style={{ background:T.white, border:`1px solid ${T.slate200}`, borderTop:`3px solid ${k.border}`, borderRadius:12, padding:"14px 16px" }}>
            <div style={{ fontSize:11, color:T.slate500, fontWeight:500, marginBottom:6 }}>{k.label}</div>
            <div style={{ fontSize:26, fontWeight:700, color:k.color, letterSpacing:"-0.02em" }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Critical Alerts */}
      {critical.length > 0 && (
        <div style={{ marginBottom:16 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
            <span style={{ fontSize:13, fontWeight:700, color:T.red }}>🔴 Critical — Action Required</span>
            <div style={{ flex:1, height:1, background:T.redLt }} />
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {critical.map(alert => (
              <AlertCard key={alert.id} alert={alert} onRead={onRead} onResolve={onResolve} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      )}

      {/* Warning Alerts */}
      {warning.length > 0 && (
        <div style={{ marginBottom:16 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
            <span style={{ fontSize:13, fontWeight:700, color:T.amber }}>🟡 Warnings — Review Soon</span>
            <div style={{ flex:1, height:1, background:T.amberLt }} />
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {warning.map(alert => (
              <AlertCard key={alert.id} alert={alert} onRead={onRead} onResolve={onResolve} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      )}

      {/* Info Alerts */}
      {info.length > 0 && (
        <div style={{ marginBottom:16 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
            <span style={{ fontSize:13, fontWeight:600, color:T.blue }}>ℹ️ Informational</span>
            <div style={{ flex:1, height:1, background:T.blueLt }} />
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {info.map(alert => (
              <AlertCard key={alert.id} alert={alert} onRead={onRead} onResolve={onResolve} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      )}

      {active.length === 0 && (
        <div style={{ textAlign:"center", padding:"60px 20px" }}>
          <div style={{ fontSize:40, marginBottom:12 }}>✅</div>
          <div style={{ fontSize:16, fontWeight:700, color:T.slate800, marginBottom:6 }}>All clear</div>
          <div style={{ fontSize:13, color:T.slate400 }}>No active alerts. Your BCC is running smoothly.</div>
        </div>
      )}
    </div>
  );
};

// ─── Section: All Alerts ──────────────────────────────────────
const AllAlerts = ({ alerts, onRead, onResolve, onNavigate }) => {
  const [typeFilter,     setTypeFilter]     = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [showResolved,   setShowResolved]   = useState(false);
  const [search,         setSearch]         = useState("");

  const filtered = useMemo(() => alerts.filter(a => {
    if (!showResolved && a.is_resolved) return false;
    if (typeFilter     !== "all" && a.alert_type !== typeFilter)     return false;
    if (severityFilter !== "all" && a.severity   !== severityFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return a.title.toLowerCase().includes(q) || a.message.toLowerCase().includes(q);
    }
    return true;
  }).sort((a,b) => {
    const so = SEVERITY[a.severity]?.order ?? 3;
    const sb = SEVERITY[b.severity]?.order ?? 3;
    if (so !== sb) return so - sb;
    return a.is_read ? 1 : -1;
  }), [alerts, typeFilter, severityFilter, showResolved, search]);

  const unreadCount = alerts.filter(a => !a.is_read && !a.is_resolved).length;

  return (
    <div>
      {/* Filters */}
      <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search alerts..."
          style={{ flex:1, minWidth:160, padding:"8px 12px", fontSize:12, color:T.slate800, border:`1px solid ${T.slate200}`, borderRadius:8, outline:"none", background:T.white }}
        />
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
          style={{ padding:"8px 10px", fontSize:12, color:T.slate700, border:`1px solid ${T.slate200}`, borderRadius:8, background:T.white, outline:"none" }}>
          <option value="all">All Types</option>
          {Object.keys(ALERT_TYPES).map(t => <option key={t} value={t}>{ALERT_TYPES[t].icon} {ALERT_TYPES[t].label}</option>)}
        </select>
        <select value={severityFilter} onChange={e => setSeverityFilter(e.target.value)}
          style={{ padding:"8px 10px", fontSize:12, color:T.slate700, border:`1px solid ${T.slate200}`, borderRadius:8, background:T.white, outline:"none" }}>
          <option value="all">All Severity</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
        <button
          onClick={() => setShowResolved(r => !r)}
          style={{ padding:"8px 12px", fontSize:11, fontWeight:500, color:showResolved?T.white:T.slate600, background:showResolved?T.slate700:T.white, border:`1px solid ${T.slate200}`, borderRadius:8, cursor:"pointer" }}
        >
          {showResolved?"Hide Resolved":"Show Resolved"}
        </button>
        {unreadCount > 0 && (
          <button
            onClick={() => alerts.filter(a=>!a.is_read).forEach(a => onRead(a.id))}
            style={{ padding:"8px 12px", fontSize:11, fontWeight:600, color:T.blue, background:T.blueLt, border:"none", borderRadius:8, cursor:"pointer" }}
          >
            Mark all read ({unreadCount})
          </button>
        )}
      </div>

      <div style={{ fontSize:11, color:T.slate400, marginBottom:10 }}>
        Showing {filtered.length} alert{filtered.length!==1?"s":""} · Sorted by severity then unread first
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign:"center", padding:"40px 20px", color:T.slate400, fontSize:13 }}>No alerts match your filters.</div>
        ) : filtered.map(alert => (
          <AlertCard key={alert.id} alert={alert} onRead={onRead} onResolve={onResolve} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
};

// ─── Section: Alert History ───────────────────────────────────
const AlertHistory = ({ alerts }) => {
  const resolved = alerts.filter(a => a.is_resolved);

  return (
    <Card>
      <div style={{ fontSize:13, fontWeight:600, color:T.slate800, marginBottom:4 }}>Resolved alert history</div>
      <div style={{ fontSize:11, color:T.slate500, marginBottom:14 }}>{resolved.length} alerts resolved</div>

      {resolved.length === 0 ? (
        <div style={{ textAlign:"center", padding:"30px 0", color:T.slate400, fontSize:12 }}>No resolved alerts yet.</div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
          {resolved.map((alert,i) => {
            const type = ALERT_TYPES[alert.alert_type] || ALERT_TYPES.system;
            const sev  = SEVERITY[alert.severity] || SEVERITY.info;
            return (
              <div key={alert.id} style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"10px 0", borderBottom:i<resolved.length-1?`1px solid ${T.slate100}`:"none", opacity:0.7 }}>
                <span style={{ fontSize:16, flexShrink:0 }}>{type.icon}</span>
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2 }}>
                    <span style={{ fontSize:12, fontWeight:500, color:T.slate700, textDecoration:"line-through" }}>{alert.title}</span>
                    <span style={{ fontSize:9, padding:"2px 6px", borderRadius:20, background:T.greenLt, color:"#065F46", fontWeight:600 }}>Resolved</span>
                  </div>
                  <div style={{ fontSize:10, color:T.slate400 }}>
                    {type.label} · {sev.label} · Created {alert.created_at}
                    {alert.resolved_at && ` · Resolved ${alert.resolved_at}`}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
};

// ─── Notification Preferences Panel ──────────────────────────
const NotificationPrefs = () => {
  const [prefs, setPrefs] = useState([
    { id:"p1", type:"compliance_critical",     label:"Critical compliance deadlines",  channel:"both",    enabled:true  },
    { id:"p2", type:"compliance_warning",      label:"Compliance warnings",             channel:"in_app",  enabled:true  },
    { id:"p3", type:"automation_failed",       label:"Automation failures",             channel:"both",    enabled:true  },
    { id:"p4", type:"automation_partial",      label:"Partial automation runs",         channel:"in_app",  enabled:true  },
    { id:"p5", type:"new_applicant",           label:"New HR applicant received",       channel:"both",    enabled:true  },
    { id:"p6", type:"document_processed",      label:"Document import complete",        channel:"in_app",  enabled:true  },
    { id:"p7", type:"document_failed",         label:"Document import failed",          channel:"both",    enabled:true  },
    { id:"p8", type:"daily_briefing",          label:"Daily briefing email",            channel:"email",   enabled:true  },
    { id:"p9", type:"instagram_manual",        label:"Instagram manual post reminder",  channel:"both",    enabled:true  },
    { id:"p10",type:"task_due",                label:"Task due reminders",              channel:"in_app",  enabled:true  },
    { id:"p11",type:"goal_milestone",          label:"Goal milestone reached",          channel:"both",    enabled:true  },
    { id:"p12",type:"license_renewal",         label:"License renewal approaching",     channel:"both",    enabled:true  },
  ]);

  const toggle = (id) => setPrefs(p => p.map(pref => pref.id === id ? {...pref, enabled:!pref.enabled} : pref));
  const setChannel = (id, channel) => setPrefs(p => p.map(pref => pref.id === id ? {...pref, channel} : pref));

  return (
    <Card>
      <div style={{ fontSize:13, fontWeight:600, color:T.slate800, marginBottom:4 }}>Notification preferences</div>
      <div style={{ fontSize:11, color:T.slate500, marginBottom:16 }}>Control how and where you receive alerts</div>

      <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
        {prefs.map((pref,i) => (
          <div key={pref.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 12px", background:i%2===0?T.slate50:T.white, borderRadius:8 }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:12, fontWeight:500, color:pref.enabled?T.slate800:T.slate400 }}>{pref.label}</div>
            </div>
            {/* Channel selector */}
            <select
              value={pref.channel}
              onChange={e => setChannel(pref.id, e.target.value)}
              disabled={!pref.enabled}
              style={{ padding:"4px 8px", fontSize:11, color:T.slate700, border:`1px solid ${T.slate200}`, borderRadius:6, background:T.white, outline:"none", opacity:pref.enabled?1:0.4 }}
            >
              <option value="both">Email + In-App</option>
              <option value="email">Email only</option>
              <option value="in_app">In-App only</option>
            </select>
            {/* Toggle */}
            <div
              onClick={() => toggle(pref.id)}
              style={{ width:36, height:20, borderRadius:10, cursor:"pointer", background:pref.enabled?T.green:T.slate300, position:"relative", transition:"background 0.2s", flexShrink:0 }}
            >
              <div style={{ width:16, height:16, borderRadius:"50%", background:T.white, position:"absolute", top:2, left:pref.enabled?18:2, transition:"left 0.2s", boxShadow:"0 1px 3px rgba(0,0,0,0.2)" }} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
};

// ─── Main Alerts Module ───────────────────────────────────────
export default function AlertsNotifications({ onNavigate }) {
  const [section, setSection] = useState("overview");
  const { data: liveAlerts, loading: alertsLoading } = useSupabaseTable("alerts", AGENCY_ID, { orderBy: "created_at", ascending: false });
  const [alerts, setAlerts] = useState([]);
  useEffect(() => {
    if (Array.isArray(liveAlerts)) setAlerts(liveAlerts);
  }, [liveAlerts]);

  // Persist mark-read and mark-resolved to the database. Local state is
  // updated optimistically so the UI feels instant; the Supabase write
  // happens in the background. Errors silently revert on next refresh.
  const markRead = async (id) => {
    setAlerts(p => p.map(a => a.id === id ? { ...a, is_read: true } : a));
    try { await supabase.from("alerts").update({ is_read: true }).eq("id", id); }
    catch (e) { console.error("Failed to mark alert read:", e); }
  };
  const markResolved = async (id) => {
    const nowIso = new Date().toISOString();
    setAlerts(p => p.map(a => a.id === id ? { ...a, is_resolved: true, resolved_at: nowIso } : a));
    try { await supabase.from("alerts").update({ is_resolved: true, resolved_at: nowIso }).eq("id", id); }
    catch (e) { console.error("Failed to resolve alert:", e); }
  };

  if (alertsLoading) return <div style={{padding:40,textAlign:"center",fontSize:13,color:"#64748B"}}>Loading alerts…</div>;
  if (alerts.length === 0) return <EmptyState module="alerts" />;

  const active  = alerts.filter(a => !a.is_resolved);
  const unread  = active.filter(a => !a.is_read).length;
  const critical= active.filter(a => a.severity==="critical").length;

  const sections = [
    { id:"overview",  label:`Overview${unread>0?` (${unread} new)`:""}` },
    { id:"all",       label:"All Alerts"         },
    { id:"history",   label:"History"            },
    { id:"prefs",     label:"Preferences"        },
  ];

  return (
    <div>
      {/* Module Header */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:16 }}>
        <div>
          <div style={{ fontSize:20, fontWeight:700, color:T.slate900, letterSpacing:"-0.02em" }}>
            Alerts & Notifications
          </div>
          <div style={{ fontSize:12, color:T.slate500, marginTop:3 }}>
            {active.length} active · {unread} unread · {critical > 0 ? `${critical} critical` : "No critical alerts"}
          </div>
        </div>
        <AskBtn context={`My active BCC alerts:\nCritical: ${critical}\nUnread: ${unread}\nTotal active: ${active.length}\n\nTop alerts:\n${active.slice(0,5).map(a=>`• [${a.severity.toUpperCase()}] ${a.title} — ${a.message.slice(0,100)}...`).join("\n")}\n\nHelp me prioritize these alerts and build an action plan to resolve the most critical items first.`} />
      </div>

      {/* Critical Banner */}
      {critical > 0 && (
        <div style={{ background:T.redLt, border:`1px solid #FECACA`, borderLeft:`4px solid ${T.red}`, borderRadius:10, padding:"12px 16px", marginBottom:16, display:"flex", alignItems:"center", justifyContent:"space-between", gap:12 }}>
          <div>
            <div style={{ fontSize:13, fontWeight:700, color:"#991B1B", marginBottom:2 }}>
              🔴 {critical} critical alert{critical>1?"s":""} require{critical===1?"s":""} immediate attention
            </div>
            <div style={{ fontSize:11, color:"#991B1B" }}>
              {alerts.filter(a=>a.severity==="critical"&&!a.is_resolved).map(a=>a.title).join(" · ")}
            </div>
          </div>
          <AskBtn size="small" context={`I have ${critical} critical alert(s) in my BCC:\n${alerts.filter(a=>a.severity==="critical"&&!a.is_resolved).map(a=>`• ${a.title}: ${a.message}`).join("\n\n")}\n\nWhat should I do RIGHT NOW to address these critical items? Give me a step-by-step action plan.`} />
        </div>
      )}

      {/* Section Navigation */}
      <div style={{ display:"flex", gap:2, flexWrap:"wrap", background:T.slate100, borderRadius:10, padding:4, marginBottom:18 }}>
        {sections.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)} style={{ padding:"7px 14px", fontSize:12, fontWeight:section===s.id?600:400, color:section===s.id?T.slate900:T.slate500, background:section===s.id?T.white:"transparent", border:"none", borderRadius:7, cursor:"pointer", transition:"all 0.12s", boxShadow:section===s.id?"0 1px 3px rgba(0,0,0,0.08)":"none" }}>
            {s.label}
          </button>
        ))}
      </div>

      {/* Section Content */}
      {section === "overview" && <AlertsOverview alerts={alerts} onRead={markRead} onResolve={markResolved} onNavigate={onNavigate||(()=>{})} />}
      {section === "all"      && <AllAlerts      alerts={alerts} onRead={markRead} onResolve={markResolved} onNavigate={onNavigate||(()=>{})} />}
      {section === "history"  && <AlertHistory   alerts={alerts} />}
      {section === "prefs"    && <NotificationPrefs />}
    </div>
  );
}
