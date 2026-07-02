import { useState, useMemo, useEffect, useRef } from "react";
import { supabase, AGENCY_ID } from "../lib/supabase.js";

// ============================================================
// BCC COMPLIANCE CENTER MODULE v1.0
// Business Command Center — State Farm Agent Edition
// Built by Imaginary Farms LLC · imaginary-farms.com
//
// SECTIONS:
//   1. Dashboard     — Critical alerts, upcoming deadlines, status
//   2. Rules Library — All 57 rules, searchable, filterable
//   3. Pre-Post Checklist — 26-item social media checklist
//   4. Calendar      — Compliance deadlines and recurring items
//   5. Audit Log     — Record of reviews, flags, completions
//
// DATA: Reads compliance_rules, compliance_calendar, compliance_log
//       tables in Supabase. Live queries wired in the main useEffect.
//       PrePostChecklist is intentionally derived from static reference
//       content (Social Chef Compliance KB), not from a table.
// ============================================================


// ─── Design Tokens ────────────────────────────────────────────
const T = {
  navy:    "#1B2B4B",
  navyLt:  "#E7EDFA",
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
  slate300:"#CBD5E1",
  slate400:"#94A3B8",
  slate500:"#64748B",
  slate600:"#475569",
  slate700:"#334155",
  slate800:"#1E293B",
  slate900:"#0F172A",
  white:   "#FFFFFF",
};

// ─── Category Config ──────────────────────────────────────────
const CATEGORY_CONFIG = {
  contract:              { label: "Contract Basics",        color: T.navy,     icon: "📜" },
  advertising:           { label: "Advertising",            color: T.blue,     icon: "📢" },
  language:              { label: "Language & Word Rules",  color: T.slate800, icon: "💬" },
  social_media:          { label: "Social Media",           color: T.purple,   icon: "📱" },
  social_media_checklist:{ label: "Pre-Post Checklist",     color: T.teal,     icon: "✅" },
  trademark:             { label: "Trademark & Brand",      color: T.amber,    icon: "®️" },
  giveaways:             { label: "Giveaways",              color: T.green,    icon: "🎁" },
  financial:             { label: "Financial",              color: T.blue,     icon: "💰" },
  licensing:             { label: "Licensing",              color: T.red,      icon: "🪪" },
  data_privacy:          { label: "Data Privacy",           color: T.slate700, icon: "🔒" },
  medicare:              { label: "Medicare",               color: T.red,      icon: "🏥" },
};

// ─── Mock Data ────────────────────────────────────────────────

const MOCK_CHECKLIST = Array.from({ length: 26 }, (_, i) => ({
  id: `cl-${i+1}`,
  rule_code: `CHECKLIST-${String(i+1).padStart(2,"0")}`,
  number: i + 1,
  title: [
    "No prohibited topics",
    "Authorized language only",
    "Customer — not client",
    "Options — not solutions",
    "No absolutes, guarantees, or superlatives",
    "No expert, specialist, or world-class",
    "No scare tactics or fear mongering",
    "No legal or financial advice",
    "All trademarks used correctly",
    "Personal Price Plan® correct usage",
    "AI disclaimer included if AI used in visuals",
    "Giveaway — every participant receives item",
    "All text in English",
    "No pricing specifics or premium amounts",
    "Content does not imply agent is the insurer",
    "Event photos — no SF product info visible",
    "No customer PII or SPI disclosed",
    "No PHI visible in photos or videos",
    "Written release for all identifiable people",
    "State license numbers included if required (AR, NM)",
    "GBP posts — insurance products only",
    "Multi-office GBP — distinct listings verified",
    "DMs only on Facebook and Instagram with privacy disclaimer",
    "Staff posts reviewed by agent before publishing",
    "Building Our Brand guidelines followed",
    "No referral rewards advertised on social",
  ][i],
  severity: [0,1,2,3,4,5,6,7,8,11,12,13,14,16,17,18,23,25].includes(i) ? "critical" : "warning",
  source: "Social Chef Claude Compliance KB v2.1 — Section 18",
}));



// ─── Helpers ──────────────────────────────────────────────────
const severityConfig = (s) => ({
  critical: { color: T.red,    bg: T.redLt,    label: "Critical" },
  warning:  { color: T.amber,  bg: T.amberLt,  label: "Warning"  },
  info:     { color: T.blue,   bg: T.blueLt,   label: "Info"     },
}[s] || { color: T.slate500, bg: T.slate100, label: s });

const statusConfig = (s) => ({
  upcoming:  { color: T.blue,  bg: T.blueLt,  label: "Upcoming"  },
  due:       { color: T.amber, bg: T.amberLt, label: "Due Soon"  },
  overdue:   { color: T.red,   bg: T.redLt,   label: "Overdue"   },
  completed: { color: T.green, bg: T.greenLt, label: "Complete"  },
}[s] || { color: T.slate500, bg: T.slate100, label: s });

const eventConfig = (e) => ({
  review:          { color: T.blue,    icon: "👁" },
  completed:       { color: T.green,   icon: "✅" },
  claude_pushback: { color: T.amber,   icon: "⚡" },
  violation_flagged:{ color: T.red,   icon: "🚨" },
  acknowledged:    { color: T.slate500,icon: "📋" },
}[e] || { color: T.slate500, icon: "📋" });

// ─── Shared Components ────────────────────────────────────────
const Card = ({ children, style = {} }) => (
  <div style={{ background: T.white, border: `1px solid ${T.slate200}`, borderRadius: 12, padding: "16px 18px", ...style }}>
    {children}
  </div>
);

const Pill = ({ type, children }) => {
  const s = severityConfig(type);
  return (
    <span style={{ display:"inline-flex", alignItems:"center", fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:20, background:s.bg, color:s.color, whiteSpace:"nowrap" }}>
      {children || s.label}
    </span>
  );
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

const TabBar = ({ tabs, active, onChange }) => (
  <div style={{ display:"flex", gap:2, background:T.slate100, borderRadius:8, padding:3, marginBottom:16, flexWrap:"wrap" }}>
    {tabs.map(t => (
      <button key={t.id} onClick={() => onChange(t.id)} style={{ padding:"7px 14px", fontSize:12, fontWeight:active===t.id?600:400, color:active===t.id?T.slate900:T.slate500, background:active===t.id?T.white:"transparent", border:"none", borderRadius:6, cursor:"pointer", transition:"all 0.12s", boxShadow:active===t.id?"0 1px 3px rgba(0,0,0,0.08)":"none" }}>
        {t.label}
      </button>
    ))}
  </div>
);

// ─── Section: Compliance Dashboard ───────────────────────────
const ComplianceDashboard = ({ rules = [], calendar = [], recentLogs = [] }) => {
  const critical = rules.filter(r => r.severity === "critical").length;
  const dueItems = calendar.filter(c => c.status === "due" || c.days_remaining <= 14).length;
  const overdueItems = calendar.filter(c => c.status === "overdue").length;

  return (
    <div>
      {/* Status KPIs */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:10, marginBottom:16 }}>
        {[
          { label:"Critical Rules",     value: critical,     color: T.red,   border: T.red   },
          { label:"Due Within 14 Days", value: dueItems,     color: T.amber, border: T.amber },
          { label:"Overdue Items",      value: overdueItems, color: overdueItems>0?T.red:T.green, border: overdueItems>0?T.red:T.green },
          { label:"Rules in Library",   value: rules.length, color: T.blue,  border: T.blue  },
        ].map((k,i) => (
          <div key={i} style={{ background:T.white, border:`1px solid ${T.slate200}`, borderTop:`3px solid ${k.border}`, borderRadius:12, padding:"14px 16px" }}>
            <div style={{ fontSize:11, color:T.slate500, fontWeight:500, marginBottom:6 }}>{k.label}</div>
            <div style={{ fontSize:24, fontWeight:700, color:k.color, letterSpacing:"-0.02em" }}>{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)", gap:12 }}>
        {/* Upcoming Deadlines */}
        <Card>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <span style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>Upcoming deadlines</span>
            <AskBtn size="small" context="Here are my upcoming compliance deadlines. Help me prioritize what needs my immediate attention and what I should plan for in the next 90 days." />
          </div>
          {calendar.slice(0,6).map((item,i) => {
            const sc = statusConfig(item.status);
            const urgent = item.days_remaining <= 14;
            return (
              <div key={i} style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8, padding:"8px 0", borderBottom:i<5?`1px solid ${T.slate100}`:"none" }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:12, fontWeight:500, color:urgent?T.red:T.slate800 }}>{item.title}</div>
                  <div style={{ fontSize:10, color:T.slate400, marginTop:2 }}>
                    {item.days_remaining <= 0 ? "Overdue" : item.days_remaining <= 14 ? `⚠ ${item.days_remaining} days remaining` : `${item.days_remaining} days`} · {item.recurrence}
                  </div>
                </div>
                <span style={{ fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:20, background:sc.bg, color:sc.color, whiteSpace:"nowrap" }}>{sc.label}</span>
              </div>
            );
          })}
        </Card>

        {/* Critical Rules Quick Reference */}
        <Card>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <span style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>Critical rules — quick reference</span>
          </div>
          {(() => {
            const criticalRules = rules.filter(r => r.severity === "critical").slice(0, 8);
            if (criticalRules.length === 0) {
              return (
                <div style={{ fontSize:12, color:T.slate500, padding:"12px 0", textAlign:"center" }}>
                  No critical rules loaded. Add rules in the Rules Library tab.
                </div>
              );
            }
            return criticalRules.map((r, i) => (
              <div key={r.id} style={{ display:"flex", gap:10, alignItems:"flex-start", padding:"6px 0", borderBottom:i<criticalRules.length-1?`1px solid ${T.slate100}`:"none" }}>
                <div style={{ width:6, height:6, borderRadius:"50%", background:T.red, flexShrink:0, marginTop:5 }} />
                <div>
                  <span style={{ fontSize:10, fontFamily:"monospace", color:T.slate400, marginRight:6 }}>{r.rule_code}</span>
                  <span style={{ fontSize:11, color:T.slate700, lineHeight:1.5 }}>{r.title}</span>
                </div>
              </div>
            ));
          })()}
        </Card>
      </div>

      {/* Recent Audit Log */}
      <Card style={{ marginTop:12 }}>
        <div style={{ fontSize:13, fontWeight:600, color:T.slate800, marginBottom:12 }}>Recent compliance activity</div>
        {recentLogs.length === 0 ? (
          <div style={{ fontSize:12, color:T.slate500, padding:"12px 0", textAlign:"center" }}>
            No activity logged yet. Use the Audit Log tab to record reviews and actions.
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
            {recentLogs.slice(0,5).map((log, i) => {
              const ec = eventConfig(log.event_type);
              const when = log.created_at ? new Date(log.created_at).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "";
              return (
                <div key={log.id} style={{ display:"flex", gap:10, padding:"8px 0", borderBottom:i<Math.min(recentLogs.length,5)-1?`1px solid ${T.slate100}`:"none" }}>
                  <div style={{ width:24, height:24, borderRadius:6, background:T.slate50, border:`1px solid ${T.slate200}`, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:12 }}>{ec.icon}</div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:12, color:T.slate800, lineHeight:1.5 }}>{log.description}</div>
                    <div style={{ fontSize:10, color:T.slate400, marginTop:2 }}>{when} · {(log.event_type||"review").replace(/_/g," ")}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
};

// ─── Section: Rules Library ───────────────────────────────────
const RulesLibrary = ({ rules = [] }) => {
  const [search,    setSearch]    = useState("");
  const [category,  setCategory]  = useState("all");
  const [severity,  setSeverity]  = useState("all");
  const [expanded,  setExpanded]  = useState(null);

  const categories = ["all", ...Object.keys(CATEGORY_CONFIG).filter(c => c !== "social_media_checklist")];

  const filtered = useMemo(() => rules.filter(r => {
    if (category !== "all" && r.category !== category) return false;
    if (severity !== "all" && r.severity !== severity) return false;
    if (search) {
      const q = search.toLowerCase();
      return r.title.toLowerCase().includes(q) || r.description.toLowerCase().includes(q) || r.rule_code.toLowerCase().includes(q) || r.source.toLowerCase().includes(q);
    }
    return true;
  }), [rules, search, category, severity]);

  return (
    <div>
      {/* Filters */}
      <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap" }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search rules, codes, or sources..."
          style={{ flex:1, minWidth:200, padding:"8px 12px", fontSize:12, color:T.slate800, border:`1px solid ${T.slate200}`, borderRadius:8, outline:"none", background:T.white }}
        />
        <select value={category} onChange={e => setCategory(e.target.value)} style={{ padding:"8px 10px", fontSize:12, color:T.slate700, border:`1px solid ${T.slate200}`, borderRadius:8, background:T.white, outline:"none" }}>
          <option value="all">All Categories</option>
          {categories.filter(c => c !== "all").map(c => (
            <option key={c} value={c}>{CATEGORY_CONFIG[c]?.label || c}</option>
          ))}
        </select>
        <select value={severity} onChange={e => setSeverity(e.target.value)} style={{ padding:"8px 10px", fontSize:12, color:T.slate700, border:`1px solid ${T.slate200}`, borderRadius:8, background:T.white, outline:"none" }}>
          <option value="all">All Severity</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
      </div>

      <div style={{ fontSize:11, color:T.slate400, marginBottom:12 }}>
        Showing {filtered.length} of {rules.length} rules
      </div>

      {/* Rules List */}
      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
        {filtered.map(rule => {
          const cat = CATEGORY_CONFIG[rule.category] || {};
          const sev = severityConfig(rule.severity);
          const isExpanded = expanded === rule.id;

          return (
            <div
              key={rule.id}
              style={{ background:T.white, border:`1px solid ${isExpanded?cat.color||T.slate200:T.slate200}`, borderLeft:`4px solid ${cat.color||T.slate300}`, borderRadius:10, overflow:"hidden", transition:"border-color 0.15s" }}
            >
              <div
                style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:10, padding:"12px 14px", cursor:"pointer" }}
                onClick={() => setExpanded(isExpanded ? null : rule.id)}
              >
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4, flexWrap:"wrap" }}>
                    <span style={{ fontSize:10, fontFamily:"monospace", color:T.slate400, background:T.slate100, padding:"2px 6px", borderRadius:4 }}>{rule.rule_code}</span>
                    <span style={{ fontSize:10, color:cat.color||T.slate500 }}>{cat.icon} {cat.label}</span>
                    <span style={{ fontSize:10, fontWeight:600, padding:"2px 8px", borderRadius:20, background:sev.bg, color:sev.color }}>{sev.label}</span>
                  </div>
                  <div style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>{rule.title}</div>
                </div>
                <span style={{ color:T.slate400, fontSize:14, flexShrink:0, marginTop:2 }}>{isExpanded ? "▲" : "▼"}</span>
              </div>

              {isExpanded && (
                <div style={{ padding:"0 14px 14px", borderTop:`1px solid ${T.slate100}` }}>
                  <div style={{ fontSize:12, color:T.slate700, lineHeight:1.7, marginTop:10, marginBottom:10 }}>
                    {rule.description}
                  </div>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
                    <div style={{ fontSize:10, color:T.slate400 }}>
                      📜 <em>{rule.source}</em>
                    </div>
                    <AskBtn size="small" context={`Compliance rule: ${rule.title} (${rule.rule_code})\n\nRule description: ${rule.description}\n\nSource: ${rule.source}\n\nHelp me understand this rule and how it applies to my agency. What are the most common ways agents accidentally violate this?`} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── Section: Pre-Post Checklist ──────────────────────────────
const PrePostChecklist = () => {
  const [checked, setChecked] = useState({});
  const [sessionDate] = useState(new Date().toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" }));

  const toggleCheck = (id) => setChecked(prev => ({ ...prev, [id]: !prev[id] }));
  const checkedCount = Object.values(checked).filter(Boolean).length;
  const allPassed = checkedCount === MOCK_CHECKLIST.length;
  const criticalItems = MOCK_CHECKLIST.filter(i => i.severity === "critical");
  const criticalPassed = criticalItems.every(i => checked[i.id]);

  const resetChecklist = () => setChecked({});

  return (
    <div>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:16 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>Social Media Pre-Post Compliance Checklist</div>
          <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>Run every piece of content through all {MOCK_CHECKLIST.length} items before publishing · {sessionDate}</div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <AskBtn context={`I just completed the social media pre-post compliance checklist. ${checkedCount} of ${MOCK_CHECKLIST.length} items passed. ${allPassed ? "All items cleared." : "Some items need attention."} Help me review any compliance concerns before I publish this content.`} />
          <button onClick={resetChecklist} style={{ padding:"7px 14px", fontSize:11, fontWeight:600, color:T.slate600, background:T.slate100, border:"none", borderRadius:7, cursor:"pointer" }}>Reset</button>
        </div>
      </div>

      {/* Progress */}
      <div style={{ background:T.white, border:`1px solid ${T.slate200}`, borderRadius:12, padding:"14px 18px", marginBottom:16 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
          <span style={{ fontSize:12, fontWeight:600, color:T.slate700 }}>{checkedCount} of {MOCK_CHECKLIST.length} items verified</span>
          {allPassed
            ? <span style={{ fontSize:11, fontWeight:600, padding:"3px 10px", borderRadius:20, background:T.greenLt, color:"#065F46" }}>✓ All Clear — Safe to Post</span>
            : criticalPassed
              ? <span style={{ fontSize:11, fontWeight:600, padding:"3px 10px", borderRadius:20, background:T.amberLt, color:"#92400E" }}>Critical Items Passed — Review Warnings</span>
              : <span style={{ fontSize:11, fontWeight:600, padding:"3px 10px", borderRadius:20, background:T.redLt, color:"#991B1B" }}>Do Not Post — Critical Items Pending</span>
          }
        </div>
        <div style={{ height:8, background:T.slate100, borderRadius:4, overflow:"hidden" }}>
          <div style={{ height:"100%", width:`${(checkedCount/MOCK_CHECKLIST.length)*100}%`, background:allPassed?T.green:criticalPassed?T.amber:T.blue, borderRadius:4, transition:"width 0.3s ease" }} />
        </div>
      </div>

      {/* Checklist Items */}
      <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
        {MOCK_CHECKLIST.map((item) => {
          const isChecked = !!checked[item.id];
          const isCritical = item.severity === "critical";
          return (
            <div
              key={item.id}
              onClick={() => toggleCheck(item.id)}
              style={{
                display:"flex", alignItems:"center", gap:12,
                padding:"10px 14px",
                background: isChecked ? (isCritical ? "#F0FDF4" : T.slate50) : T.white,
                border:`1px solid ${isChecked ? (isCritical ? "#BBF7D0" : T.slate200) : T.slate200}`,
                borderLeft:`4px solid ${isCritical ? T.red : T.amber}`,
                borderRadius:8, cursor:"pointer",
                transition:"all 0.12s",
                opacity: isChecked ? 0.75 : 1,
              }}
            >
              {/* Checkbox */}
              <div style={{
                width:20, height:20, borderRadius:5, flexShrink:0,
                border: isChecked ? "none" : `2px solid ${T.slate300}`,
                background: isChecked ? T.green : "transparent",
                display:"flex", alignItems:"center", justifyContent:"center",
                transition:"all 0.15s",
              }}>
                {isChecked && <span style={{ color:T.white, fontSize:12, lineHeight:1 }}>✓</span>}
              </div>

              {/* Item */}
              <div style={{ flex:1 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <span style={{ fontSize:10, color:T.slate400, fontWeight:500 }}>{String(item.number).padStart(2,"0")}</span>
                  <span style={{ fontSize:12, fontWeight:isChecked?400:500, color:isChecked?T.slate400:T.slate800, textDecoration:isChecked?"line-through":"none" }}>
                    {item.title}
                  </span>
                </div>
              </div>

              {/* Severity badge */}
              <Pill type={item.severity}>{isCritical ? "Critical" : "Warning"}</Pill>
            </div>
          );
        })}
      </div>

      {/* Post-checklist note */}
      {allPassed && (
        <div style={{ marginTop:14, padding:"12px 16px", background:T.greenLt, border:`1px solid #BBF7D0`, borderRadius:10, fontSize:12, color:"#065F46" }}>
          ✓ All {MOCK_CHECKLIST.length} compliance items verified. This content is cleared for publishing. Log this review in the audit log before posting.
        </div>
      )}
    </div>
  );
};

// ─── Section: Compliance Calendar ─────────────────────────────
const ComplianceCalendar = ({ calendar = [] }) => {
  const [filter, setFilter] = useState("all");

  const filtered = calendar.filter(item => {
    if (filter === "all") return true;
    if (filter === "due") return item.days_remaining <= 30;
    if (filter === "annual") return item.recurrence === "annual";
    if (filter === "monthly") return item.recurrence === "monthly";
    return true;
  });

  return (
    <Card>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>Compliance Calendar</div>
          <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>Annual and recurring compliance deadlines</div>
        </div>
        <AskBtn context="I am reviewing my compliance calendar. Help me prioritize the most urgent items and create an action plan for the next 90 days." />
      </div>

      <div style={{ display:"flex", gap:6, marginBottom:16, flexWrap:"wrap" }}>
        {[{id:"all",label:"All"},{id:"due",label:"Due Within 30 Days"},{id:"annual",label:"Annual"},{id:"monthly",label:"Monthly"}].map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            padding:"5px 12px", fontSize:11, fontWeight:filter===f.id?600:400,
            color:filter===f.id?T.white:T.slate600,
            background:filter===f.id?T.navy:T.white,
            border:`1px solid ${filter===f.id?T.navy:T.slate200}`,
            borderRadius:6, cursor:"pointer",
          }}>{f.label}</button>
        ))}
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
        {filtered.map((item,i) => {
          const sc = statusConfig(item.status);
          const sev = severityConfig(item.status === "overdue" ? "critical" : item.status === "due" ? "warning" : "info");
          const urgent = item.days_remaining <= 14;
          return (
            <div key={i} style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 14px", background:urgent?T.redLt:T.white, border:`1px solid ${urgent?"#FECACA":T.slate200}`, borderRadius:10 }}>
              <div style={{ width:48, height:48, borderRadius:10, background:urgent?T.red:sev.bg, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                <span style={{ fontSize:14, fontWeight:700, color:urgent?T.white:sev.color, lineHeight:1 }}>{Math.max(0,item.days_remaining)}</span>
                <span style={{ fontSize:8, color:urgent?T.white:sev.color, marginTop:1 }}>days</span>
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13, fontWeight:600, color:urgent?T.red:T.slate800 }}>{item.title}</div>
                <div style={{ fontSize:10, color:T.slate400, marginTop:2 }}>
                  Due: {item.due_date} · {item.recurrence.charAt(0).toUpperCase()+item.recurrence.slice(1)}
                </div>
              </div>
              <span style={{ fontSize:10, fontWeight:600, padding:"3px 10px", borderRadius:20, background:sc.bg, color:sc.color }}>{sc.label}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
};

// ─── Section: Audit Log ───────────────────────────────────────
const AuditLog = ({ logs = [], setLogs = () => {} }) => {
  const [newNote, setNewNote] = useState("");
  const [saving, setSaving] = useState(false);

  const addLog = async () => {
    if (!newNote.trim() || saving) return;
    setSaving(true);
    try {
      const { data, error } = await supabase.from("compliance_log").insert({
        agency_id: AGENCY_ID,
        event_type: "review",
        description: newNote.trim(),
        created_by: "Tiffany Mapp",
      }).select().single();
      if (error) throw error;
      setLogs(prev => [data, ...prev]);
      setNewNote("");
    } catch (e) {
      console.error("compliance_log insert error:", e);
      alert("Could not save compliance log entry: " + (e?.message || "unknown error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div style={{ fontSize:13, fontWeight:600, color:T.slate800, marginBottom:14 }}>Compliance Audit Log</div>

      {/* Add Entry */}
      <div style={{ marginBottom:16, padding:"12px 14px", background:T.slate50, borderRadius:10, border:`1px solid ${T.slate200}` }}>
        <div style={{ fontSize:11, fontWeight:600, color:T.slate600, marginBottom:8 }}>LOG A COMPLIANCE ACTIVITY</div>
        <textarea
          value={newNote}
          onChange={e => setNewNote(e.target.value)}
          placeholder="Describe the compliance activity, review, or action taken..."
          rows={2}
          style={{ width:"100%", padding:"8px 10px", fontSize:12, color:T.slate800, border:`1px solid ${T.slate200}`, borderRadius:8, outline:"none", resize:"none", fontFamily:"inherit", lineHeight:1.6, boxSizing:"border-box" }}
        />
        <div style={{ display:"flex", justifyContent:"flex-end", marginTop:8 }}>
          <button
            onClick={addLog}
            disabled={!newNote.trim() || saving}
            style={{ padding:"6px 14px", fontSize:11, fontWeight:600, color:T.white, background:T.navy, border:"none", borderRadius:7, cursor:(newNote.trim() && !saving)?"pointer":"not-allowed", opacity:(newNote.trim() && !saving)?1:0.5 }}
          >{saving ? "Saving…" : "Log Activity"}</button>
        </div>
      </div>

      {/* Log Entries */}
      <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
        {logs.map((log,i) => {
          const ec = eventConfig(log.event_type);
          return (
            <div key={log.id} style={{ display:"flex", gap:12, padding:"10px 0", borderBottom:i<logs.length-1?`1px solid ${T.slate100}`:"none" }}>
              <div style={{ width:32, height:32, borderRadius:8, background:T.slate50, border:`1px solid ${T.slate200}`, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:14 }}>
                {ec.icon}
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:12, color:T.slate800, lineHeight:1.5 }}>{log.description}</div>
                <div style={{ fontSize:10, color:T.slate400, marginTop:3 }}>
                  {log.created_at ? new Date(log.created_at).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : ""} · {log.created_by || "—"} · {(log.event_type || "review").replace(/_/g," ")}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
};

// ─── Main Compliance Center Module ───────────────────────────
export default function ComplianceCenter() {
  const [section, setSection] = useState("dashboard");

  // ── Live data from Supabase ─────────────────────────────────
  const [rules,    setRules]    = useState([]);
  const [calendar, setCalendar] = useState([]);
  const [logs,     setLogs]     = useState([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rulesRes, calRes, logsRes] = await Promise.all([
          supabase.from("compliance_rules")
            .select("*")
            .eq("agency_id", AGENCY_ID)
            .eq("is_active", true)
            .order("category", { ascending: true }),
          supabase.from("compliance_calendar")
            .select("*")
            .eq("agency_id", AGENCY_ID)
            .order("due_date", { ascending: true }),
          supabase.from("compliance_log")
            .select("*")
            .eq("agency_id", AGENCY_ID)
            .order("created_at", { ascending: false })
            .limit(50),
        ]);
        if (cancelled) return;
        const today = new Date(); today.setHours(0,0,0,0);
        const calEnriched = (calRes?.data || []).map(c => {
          const due = c.due_date ? new Date(c.due_date) : null;
          const days = due ? Math.round((due - today) / (1000*60*60*24)) : 999;
          let status = c.status;
          if (status !== "completed") {
            if (days < 0) status = "overdue";
            else if (days <= 30) status = "due";
            else status = "upcoming";
          }
          return { ...c, days_remaining: days, status };
        });
        setRules(rulesRes?.data || []);
        setCalendar(calEnriched);
        setLogs(logsRes?.data || []);
      } catch (e) {
        if (!cancelled) console.error("ComplianceCenter load error:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Add/Edit Modal State ────────────────────────────────────
  const [showAddRule, setShowAddRule] = useState(false);
  const [newRule, setNewRule] = useState({title:"", category:"", description:"", severity:"info", rule_code:"", requirement:"", source:"", effective_date:""});
  const [savingRule, setSavingRule] = useState(false);

  const saveRule = async () => {
    if (!newRule.title || !newRule.category || savingRule) return;
    setSavingRule(true);
    try {
      // Coerce empty strings to null so optional columns hold NULL cleanly.
      const payload = {
        title:          newRule.title,
        category:       newRule.category,
        description:    newRule.description || "",
        severity:       newRule.severity || "info",
        rule_code:      newRule.rule_code || null,
        requirement:    newRule.requirement || null,
        source:         newRule.source || null,
        effective_date: newRule.effective_date || null,
        agency_id:      AGENCY_ID,
        is_active:      true,
      };
      const { data, error } = await supabase.from("compliance_rules").insert(payload).select().single();
      if (error) throw error;
      setRules(prev => [data, ...prev]);
      setShowAddRule(false);
      setNewRule({title:"", category:"", description:"", severity:"info", rule_code:"", requirement:"", source:"", effective_date:""});
    } catch (e) {
      console.error("compliance_rules insert error:", e);
      alert("Could not save rule: " + (e?.message || "unknown error"));
    } finally {
      setSavingRule(false);
    }
  };


  const sections = [
    { id:"dashboard", label:"Dashboard"         },
    { id:"rules",     label:`Rules Library (${rules.length})`},
    { id:"checklist", label:"Pre-Post Checklist"},
    { id:"calendar",  label:"Calendar"          },
    { id:"log",       label:"Audit Log"         },
  ];

  return (
    <div>
      {/* Module Header */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:16 }}>
        <div>
          <div style={{ fontSize:20, fontWeight:700, color:T.slate900, letterSpacing:"-0.02em" }}>Compliance Center</div>
          <div style={{ fontSize:12, color:T.slate500, marginTop:3 }}>
            {rules.length || "…"} rules · AA05 contract-based · Claude enforces these in every conversation
          </div>
        </div>
        <AskBtn context="I am reviewing my compliance center. I need you to act as my compliance advisor. What are the most critical compliance items I should be focused on right now as a State Farm agent? What are the most common compliance mistakes agents make?" />
      </div>

      {/* AA05 Notice Banner */}
      <div style={{ background:T.blueLt, border:`1px solid ${T.blue}20`, borderLeft:`4px solid ${T.blue}`, borderRadius:10, padding:"12px 16px", marginBottom:16, display:"flex", alignItems:"flex-start", gap:12 }}>
        <span style={{ fontSize:18, flexShrink:0 }}>📜</span>
        <div>
          <div style={{ fontSize:12, fontWeight:600, color:T.navy, marginBottom:2 }}>
            These rules are grounded in your AA05 Agent Agreement
          </div>
          <div style={{ fontSize:11, color:T.slate600, lineHeight:1.6 }}>
            Every compliance rule in this library cites the AA05 clause or regulatory requirement that makes it binding. Your Claude uses this library as guardrails in every conversation — it will push back when you ask it to generate non-compliant content, and it will explain exactly which contract clause applies.
          </div>
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

      {/* Action Buttons */}
      <div style={{display:"flex", justifyContent:"flex-end", marginBottom:12}}>
        {section === "rules" && (
          <button
            onClick={() => setShowAddRule(!showAddRule)}
            style={{padding:"7px 16px", fontSize:12, fontWeight:600, background:T.navy, color:T.white, border:"none", borderRadius:8, cursor:"pointer", display:"flex", alignItems:"center", gap:6}}
          >
            ➕ Add Custom Rule
          </button>
        )}
      </div>

      {/* Add Rule Form */}
      {showAddRule && (
        <div style={{background:T.navyLt, border:`1px solid ${T.blue}30`, borderRadius:10, padding:16, marginBottom:16}}>
          <div style={{fontSize:13, fontWeight:700, color:T.navy, marginBottom:12}}>Add Custom Compliance Rule</div>
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10}}>
            {/* Title (full width) */}
            <input placeholder="Rule title *" value={newRule.title} onChange={e=>setNewRule({...newRule,title:e.target.value})}
              style={{padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate300}`, fontSize:12, gridColumn:"1/-1"}} />

            {/* Category (real DB values) + Severity */}
            <select value={newRule.category} onChange={e=>setNewRule({...newRule,category:e.target.value})}
              style={{padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate300}`, fontSize:12, background:T.white}}>
              <option value="">Category *</option>
              {Object.entries(CATEGORY_CONFIG)
                .filter(([k]) => k !== "social_media_checklist")
                .map(([k, cfg]) => (
                  <option key={k} value={k}>{cfg.icon} {cfg.label}</option>
                ))}
            </select>
            <select value={newRule.severity} onChange={e=>setNewRule({...newRule,severity:e.target.value})}
              style={{padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate300}`, fontSize:12, background:T.white}}>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>

            {/* Rule code + Source */}
            <input placeholder="Rule code (e.g. AA05-011)" value={newRule.rule_code} onChange={e=>setNewRule({...newRule,rule_code:e.target.value})}
              style={{padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate300}`, fontSize:12}} />
            <input placeholder="Source (contract clause / regulator)" value={newRule.source} onChange={e=>setNewRule({...newRule,source:e.target.value})}
              style={{padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate300}`, fontSize:12}} />

            {/* Effective date */}
            <div style={{gridColumn:"1/-1"}}>
              <label style={{fontSize:10, color:T.slate500, fontWeight:600, display:"block", marginBottom:3}}>EFFECTIVE DATE (optional)</label>
              <input type="date" value={newRule.effective_date} onChange={e=>setNewRule({...newRule,effective_date:e.target.value})}
                style={{padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate300}`, fontSize:12, maxWidth:200}} />
            </div>

            {/* Description */}
            <textarea placeholder="Description — plain-English explanation of what this rule requires" value={newRule.description} onChange={e=>setNewRule({...newRule,description:e.target.value})}
              rows={2} style={{padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate300}`, fontSize:12, gridColumn:"1/-1", resize:"vertical"}} />

            {/* Requirement */}
            <textarea placeholder="Requirement (specific action or behavior — optional)" value={newRule.requirement} onChange={e=>setNewRule({...newRule,requirement:e.target.value})}
              rows={2} style={{padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate300}`, fontSize:12, gridColumn:"1/-1", resize:"vertical"}} />
          </div>
          <div style={{display:"flex", gap:8, justifyContent:"flex-end", alignItems:"center"}}>
            <span style={{fontSize:10, color:T.slate400, marginRight:"auto"}}>Fields marked * are required</span>
            <button onClick={()=>setShowAddRule(false)} disabled={savingRule} style={{padding:"6px 14px", fontSize:12, background:T.slate100, color:T.slate700, border:"none", borderRadius:6, cursor:savingRule?"not-allowed":"pointer"}}>Cancel</button>
            <button onClick={saveRule} disabled={savingRule || !newRule.title || !newRule.category}
              style={{padding:"6px 14px", fontSize:12, background:T.navy, color:T.white, border:"none", borderRadius:6, cursor:(savingRule || !newRule.title || !newRule.category)?"not-allowed":"pointer", fontWeight:600, opacity:(savingRule || !newRule.title || !newRule.category)?0.6:1}}>
              {savingRule ? "Saving…" : "Save Rule"}
            </button>
          </div>
        </div>
      )}

      {/* Section Content */}
      {section === "dashboard" && <ComplianceDashboard rules={rules} calendar={calendar} recentLogs={logs} />}
      {section === "rules"     && <RulesLibrary rules={rules} />}
      {section === "checklist" && <PrePostChecklist />}
      {section === "calendar"  && <ComplianceCalendar calendar={calendar} />}
      {section === "log"       && <AuditLog logs={logs} setLogs={setLogs} />}
    </div>
  );
}
