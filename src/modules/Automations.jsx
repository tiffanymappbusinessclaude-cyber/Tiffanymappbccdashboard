import { useState, useMemo, useEffect, useRef } from "react";
import { AGENCY_ID } from "../lib/supabase.js";
import { useSupabaseTable } from "../lib/hooks.js";
import EmptyState from "../components/EmptyState.jsx";

// ============================================================
// BCC AUTOMATIONS MODULE v1.0
// Business Command Center — State Farm Agent Edition
// Built by Imaginary Farms LLC · imaginary-farms.com
//
// SECTIONS:
//   1. Overview      — Status summary, health indicators
//   2. Run Log       — Every automation execution with status
//   3. Recipes       — All configured automations, enable/disable
//   4. Connections   — Composio connected account health
//   5. Daily Briefing — Briefing history and content preview
//   6. Doc Importer  — Document processing history and status
//
// ARCHITECTURE:
//   Recipes defined in: automation_recipes table (Supabase)
//   Cron triggers:      Supabase scheduled functions
//   Execution:          Composio (connected accounts)
//   Processing:         Composio-hosted LLM (free, no separate API key needed)
//   Run results:        automation_run_log table (Supabase)
//   This UI reads both tables to display status and history
//
// DATA: Replace MOCK_DATA with Supabase queries in production
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
  slate300:"#CBD5E1",
  slate400:"#94A3B8",
  slate500:"#64748B",
  slate600:"#475569",
  slate700:"#334155",
  slate800:"#1E293B",
  slate900:"#0F172A",
  white:   "#FFFFFF",
};

// ─── Mock Data ────────────────────────────────────────────────
// ─── Shared Components ────────────────────────────────────────
const Card = ({ children, style={} }) => (
  <div style={{ background:T.white, border:`1px solid ${T.slate200}`, borderRadius:12, padding:"16px 18px", ...style }}>
    {children}
  </div>
);

const StatusPill = ({ status }) => {
  const map = {
    success: { bg:T.greenLt,  color:"#065F46", label:"Success" },
    failed:  { bg:T.redLt,    color:"#991B1B", label:"Failed"  },
    partial: { bg:T.amberLt,  color:"#92400E", label:"Partial" },
    healthy: { bg:T.greenLt,  color:"#065F46", label:"Healthy" },
    error:   { bg:T.redLt,    color:"#991B1B", label:"Error"   },
    manual:  { bg:T.purpleLt, color:"#5B21B6", label:"Manual"  },
    complete:{ bg:T.greenLt,  color:"#065F46", label:"Complete"},
    pending: { bg:T.blueLt,   color:"#1E40AF", label:"Pending" },
  };
  const s = map[status] || { bg:T.slate100, color:T.slate500, label:status };
  return <span style={{ fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:20, background:s.bg, color:s.color, whiteSpace:"nowrap" }}>{s.label}</span>;
};

const CategoryBadge = ({ category }) => {
  const map = {
    communication:{ color:T.blue,   bg:T.blueLt,   label:"Communication" },
    email:        { color:T.teal,   bg:T.tealLt,   label:"Email"         },
    documents:    { color:T.amber,  bg:T.amberLt,  label:"Documents"     },
    social:       { color:T.purple, bg:T.purpleLt, label:"Social Media"  },
    hr:           { color:T.green,  bg:T.greenLt,  label:"HR"            },
    compliance:   { color:T.red,    bg:T.redLt,    label:"Compliance"    },
  };
  const s = map[category] || { color:T.slate500, bg:T.slate100, label:category };
  return <span style={{ fontSize:10, fontWeight:600, padding:"2px 8px", borderRadius:20, background:s.bg, color:s.color }}>{s.label}</span>;
};


// ─── Live-data Synthesis Helpers ──────────────────────────────────────────
// Convert raw DB rows into the display-friendly shape the UI was originally
// designed around. Replaces fields that used to come from MOCK_RECIPES
// (cron_label, category) and joins run_log rows to recipes by recipe_id.

// Cron expression → human-readable cadence. Degrades to raw expression.
const formatCron = (expr) => {
  if (!expr || typeof expr !== "string") return "—";
  const m = expr.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/);
  if (!m) return expr;
  const [, min, hr, dom, mon, dow] = m;
  const stepMin = (min.match(/^\*\/(\d+)$/) || [])[1];
  if (stepMin && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${stepMin} min`;
  }
  if (/^\d+,\d+$/.test(min) && hr === "*") return "Twice an hour";
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === "*" && mon === "*" && dow === "*") {
    return `Daily ${hr.padStart(2,"0")}:${min.padStart(2,"0")} UTC`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === "*" && mon === "*" && /^\d+$/.test(dow)) {
    const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    return `Weekly ${days[parseInt(dow,10)] || `day ${dow}`} ${hr.padStart(2,"0")}:${min.padStart(2,"0")} UTC`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && /^\d+$/.test(dom) && mon === "*" && dow === "*") {
    return `Monthly day ${dom} ${hr.padStart(2,"0")}:${min.padStart(2,"0")} UTC`;
  }
  return expr;
};

const recipeCategory = (r) => {
  const h = (r?.internal_handler || "").toLowerCase();
  const a = (r?.composio_action  || "").toLowerCase();
  if (/(gl|payroll|bank|cc|credit|comp_recap)/.test(h)) return "Financial";
  if (/(document|doc_|drive|archive)/.test(h))           return "Documents";
  if (/(briefing|email|mail|notif)/.test(h) || /gmail/.test(a)) return "Communication";
  if (/(compliance|close|monitor|frontrunner|underperformance|silent_failure|goals)/.test(h)) return "Operations";
  if (/(facebook|linkedin|instagram|social)/.test(h) || /(facebook|linkedin)/.test(a)) return "Social";
  return "System";
};

const recipeStats = (recipeId, runLog) => {
  if (!Array.isArray(runLog)) return { runs: 0, success_rate: 0 };
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const rows = runLog.filter(r => r.recipe_id === recipeId && new Date(r.run_at).getTime() >= cutoff);
  const runs = rows.length;
  const ok = rows.filter(r => r.status === "success").length;
  return { runs, success_rate: runs > 0 ? Math.round((ok / runs) * 100) : 0 };
};

const recipeNameFor = (recipeId, recipes) => {
  if (!Array.isArray(recipes)) return "(unknown)";
  const r = recipes.find(r => r.id === recipeId);
  return r?.recipe_name || "(unknown)";
};

const formatTimestamp = (iso) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", "");
    return `${dateStr}, ${timeStr}`;
  } catch { return "—"; }
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

// ─── Section: Overview ────────────────────────────────────────
const AutomationOverview = ({ recipes, runLog, connections }) => {
  const active    = recipes.filter(r => r.is_active).length;
  const failed    = runLog.filter(r => r.status === "failed").length;
  const partial   = runLog.filter(r => r.status === "partial").length;
  const connError = connections.filter(c => c.status === "error").length;

  const recentRuns = runLog.slice(0, 8);

  return (
    <div>
      {/* KPI Row */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))", gap:10, marginBottom:16 }}>
        {[
          { label:"Active Automations", value:active,   color:T.green,  border:T.green },
          { label:"Failed (Recent)",    value:failed,   color:failed>0?T.red:T.green,  border:failed>0?T.red:T.green },
          { label:"Partial Runs",       value:partial,  color:partial>0?T.amber:T.green, border:partial>0?T.amber:T.green },
          { label:"Connection Issues",  value:connError,color:connError>0?T.red:T.green, border:connError>0?T.red:T.green },
        ].map((k,i) => (
          <div key={i} style={{ background:T.white, border:`1px solid ${T.slate200}`, borderTop:`3px solid ${k.border}`, borderRadius:12, padding:"14px 16px" }}>
            <div style={{ fontSize:11, color:T.slate500, fontWeight:500, marginBottom:6 }}>{k.label}</div>
            <div style={{ fontSize:24, fontWeight:700, color:k.color, letterSpacing:"-0.02em" }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Failed/Partial Alert */}
      {(failed > 0 || connError > 0) && (
        <div style={{ background:T.redLt, border:`1px solid #FECACA`, borderLeft:`4px solid ${T.red}`, borderRadius:10, padding:"12px 16px", marginBottom:16 }}>
          <div style={{ fontSize:12, fontWeight:700, color:"#991B1B", marginBottom:4 }}>⚠️ Action Required</div>
          {connError > 0 && <div style={{ fontSize:12, color:"#991B1B", marginBottom:2 }}>• Gmail connection error — OAuth token expired. Go to Connections tab to reconnect.</div>}
          {failed > 0 && <div style={{ fontSize:12, color:"#991B1B" }}>• Daily Briefing failed today — check Run Log for details.</div>}
          <div style={{ marginTop:8 }}>
            <AskBtn size="small" context="My BCC has automation failures: Gmail OAuth token expired causing Daily Briefing to fail. Help me understand what steps I need to take to reconnect Gmail in Composio and get my Daily Briefing running again." />
          </div>
        </div>
      )}

      {/* Architecture Note */}
      <div style={{ background:T.blueLt, border:`1px solid ${T.blue}20`, borderLeft:`4px solid ${T.blue}`, borderRadius:10, padding:"12px 16px", marginBottom:16 }}>
        <div style={{ fontSize:12, fontWeight:600, color:T.navy, marginBottom:4 }}>How your automations work</div>
        <div style={{ fontSize:11, color:T.slate600, lineHeight:1.7 }}>
          Recipe definitions live in your Supabase database. Cron triggers fire on schedule. Composio executes the recipe using your connected accounts (Gmail, Drive, Facebook, LinkedIn). Document parsing uses the Composio-hosted LLM — free, no separate API key needed. Every run is logged here automatically.
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"minmax(0,1.4fr) minmax(0,1fr)", gap:12 }}>
        {/* Recent Run Log */}
        <Card>
          <div style={{ fontSize:13, fontWeight:600, color:T.slate800, marginBottom:12 }}>Recent runs — last 24 hours</div>
          {recentRuns.map((run,i) => (
            <div key={run.id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, padding:"7px 0", borderBottom:i<recentRuns.length-1?`1px solid ${T.slate100}`:"none" }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, fontWeight:500, color:T.slate800, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{recipeNameFor(run.recipe_id, recipes)}</div>
                <div style={{ fontSize:10, color:T.slate400 }}>{formatTimestamp(run.run_at)} · {run.duration_seconds}s</div>
              </div>
              <StatusPill status={run.status} />
            </div>
          ))}
        </Card>

        {/* Connection Health */}
        <Card>
          <div style={{ fontSize:13, fontWeight:600, color:T.slate800, marginBottom:12 }}>Connection health</div>
          {connections.map((conn,i) => (
            <div key={conn.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderBottom:i<connections.length-1?`1px solid ${T.slate100}`:"none" }}>
              <span style={{ fontSize:18, flexShrink:0 }}>{conn.icon}</span>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:12, fontWeight:500, color:T.slate800 }}>{conn.platform}</div>
                <div style={{ fontSize:10, color:T.slate400, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{conn.connected_account}</div>
              </div>
              <StatusPill status={conn.status} />
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
};

// ─── Section: Run Log ─────────────────────────────────────────
const RunLog = ({ runLog }) => {
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState(null);

  const filtered = useMemo(() =>
    runLog.filter(r => filter === "all" || r.status === filter),
    [runLog, filter]
  );

  return (
    <Card>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>Automation Run Log</div>
          <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>Every execution — what ran, what succeeded, what failed</div>
        </div>
        <AskBtn context="I'm reviewing my automation run log. Help me understand any failures or partial runs and what I should do to fix them." />
      </div>

      {/* Filters */}
      <div style={{ display:"flex", gap:6, marginBottom:14, flexWrap:"wrap" }}>
        {[{id:"all",label:"All"},{id:"success",label:"Success"},{id:"failed",label:"Failed"},{id:"partial",label:"Partial"}].map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{ padding:"5px 12px", fontSize:11, fontWeight:filter===f.id?600:400, color:filter===f.id?T.white:T.slate600, background:filter===f.id?T.navy:T.white, border:`1px solid ${filter===f.id?T.navy:T.slate200}`, borderRadius:6, cursor:"pointer" }}>
            {f.label} {f.id !== "all" && `(${runLog.filter(r => r.status === f.id).length})`}
          </button>
        ))}
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
        {filtered.map(run => {
          const isExpanded = expanded === run.id;
          const borderColor = run.status === "success" ? T.green : run.status === "failed" ? T.red : T.amber;

          return (
            <div key={run.id} style={{ border:`1px solid ${isExpanded?borderColor:T.slate200}`, borderLeft:`4px solid ${borderColor}`, borderRadius:8, overflow:"hidden" }}>
              <div
                style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px", cursor:"pointer" }}
                onClick={() => setExpanded(isExpanded ? null : run.id)}
              >
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:2 }}>
                    <span style={{ fontSize:12, fontWeight:600, color:T.slate800 }}>{recipeNameFor(run.recipe_id, recipes)}</span>
                    <StatusPill status={run.status} />
                  </div>
                  <div style={{ fontSize:10, color:T.slate400 }}>
                    {run.run_at} · {run.duration_seconds}s · {run.records_processed} records processed
                  </div>
                </div>
                <span style={{ color:T.slate400, fontSize:12 }}>{isExpanded?"▲":"▼"}</span>
              </div>

              {isExpanded && (
                <div style={{ padding:"0 12px 12px", borderTop:`1px solid ${T.slate100}` }}>
                  <div style={{ fontSize:11, color:T.slate700, lineHeight:1.6, marginTop:8, marginBottom:run.error_message?8:0 }}>
                    {run.output_summary}
                  </div>
                  {run.error_message && (
                    <div style={{ fontSize:11, color:"#991B1B", background:T.redLt, padding:"8px 10px", borderRadius:6, marginTop:8, marginBottom:8 }}>
                      🔴 {run.error_message}
                    </div>
                  )}
                  <div style={{ marginTop:8 }}>
                    <AskBtn size="small" context={`Automation run details:\nRecipe: ${recipeNameFor(run.recipe_id, recipes)}\nStatus: ${run.status}\nTime: ${run.run_at}\nDuration: ${run.duration_seconds}s\nRecords processed: ${run.records_processed}\nSummary: ${run.output_summary}${run.error_message?"\nError: "+run.error_message:""}\n\nHelp me understand this result and what action I should take.`} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
};

// ─── Section: Recipes ─────────────────────────────────────────
const Recipes = ({ recipes, onToggle }) => {
  const [expanded, setExpanded] = useState(null);

  return (
    <div>
      <div style={{ fontSize:13, color:T.slate500, marginBottom:14, lineHeight:1.6 }}>
        Recipe definitions live in your Supabase database. Each recipe defines what triggers it, which Composio connection executes it, whether the Composio-hosted LLM parses the output, and which table receives the results. Enable or disable any recipe at any time.
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {recipes.map(recipe => {
          const isExpanded = expanded === recipe.id;
          return (
            <div key={recipe.id} style={{ background:T.white, border:`1px solid ${isExpanded?T.blue:T.slate200}`, borderRadius:12, overflow:"hidden" }}>
              {/* Recipe Header */}
              <div style={{ display:"flex", alignItems:"center", gap:12, padding:"14px 16px" }}>
                <div style={{ flex:1, cursor:"pointer" }} onClick={() => setExpanded(isExpanded?null:recipe.id)}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4, flexWrap:"wrap" }}>
                    <span style={{ fontSize:13, fontWeight:600, color:recipe.is_active?T.slate900:T.slate400 }}>{recipe.recipe_name}</span>
                    <CategoryBadge category={recipeCategory(recipe)} />
              </div>
                  <div style={{ fontSize:11, color:T.slate400 }}>
                    {formatCron(recipe.cron_expression)} · Last run: {formatTimestamp(recipe.last_run_at)} · {recipeStats(recipe.id, runLog).runs} runs/30d · {recipeStats(recipe.id, runLog).success_rate}% success
                  </div>
                </div>

                <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
                  <StatusPill status={recipe.last_run_status} />
                  {/* Toggle */}
                  <div
                    onClick={() => onToggle(recipe.id)}
                    style={{
                      width:40, height:22, borderRadius:11, cursor:"pointer",
                      background:recipe.is_active?T.green:T.slate300,
                      position:"relative", transition:"background 0.2s",
                      flexShrink:0,
                    }}
                  >
                    <div style={{
                      width:18, height:18, borderRadius:"50%", background:T.white,
                      position:"absolute", top:2,
                      left:recipe.is_active?20:2,
                      transition:"left 0.2s",
                      boxShadow:"0 1px 3px rgba(0,0,0,0.2)",
                    }} />
                  </div>
                </div>
              </div>

              {/* Expanded Details */}
              {isExpanded && (
                <div style={{ padding:"0 16px 16px", borderTop:`1px solid ${T.slate100}` }}>
                  <div style={{ fontSize:12, color:T.slate600, lineHeight:1.6, marginTop:10, marginBottom:12 }}>
                    {recipe.recipe_description}
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:8, marginBottom:12 }}>
                    {[
                      { label:"Trigger",    value:formatCron(recipe.cron_expression) },
                      { label:"Action",     value:recipe.composio_action || "Internal only" },
                      { label:"Connection", value:recipe.composio_connection ? recipe.composio_connection.charAt(0).toUpperCase()+recipe.composio_connection.slice(1) : "None needed" },
                        ].map((detail,i) => (
                      <div key={i} style={{ background:T.slate50, borderRadius:8, padding:"8px 10px" }}>
                        <div style={{ fontSize:10, color:T.slate400, marginBottom:2 }}>{detail.label}</div>
                        <div style={{ fontSize:11, fontWeight:500, color:T.slate700 }}>{detail.value}</div>
                      </div>
                    ))}
                  </div>
                  <AskBtn size="small" context={`Automation recipe details:\nName: ${recipe.recipe_name}\nDescription: ${recipe.recipe_description}\nTrigger: ${formatCron(recipe.cron_expression)}\nComposio Action: ${recipe.composio_action || "None"}\nConnection: ${recipe.composio_connection || "None"}\nRuns (30d): ${recipeStats(recipe.id, runLog).runs} at ${recipeStats(recipe.id, runLog).success_rate}% success\n\nHelp me understand what this automation does and whether it's configured optimally for my agency.`} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── Section: Connections ─────────────────────────────────────
const Connections = ({ connections }) => (
  <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
    <div style={{ fontSize:13, color:T.slate500, marginBottom:4, lineHeight:1.6 }}>
      These are your Composio connected accounts. Every automation that interacts with Gmail, Drive, Facebook, LinkedIn, or other services uses one of these connections. If a connection shows an error, automations that depend on it will fail until it is reconnected.
    </div>

    {(!connections || connections.length === 0) && (
      <div style={{ textAlign:"center", padding:32, color:T.slate400, fontSize:13 }}>Loading connections…</div>
    )}

    {(connections || []).map(conn => (
      <Card key={conn.id}>
        <div style={{ display:"flex", alignItems:"flex-start", gap:14 }}>
          <div style={{ width:44, height:44, borderRadius:12, background:T.slate50, border:`1px solid ${T.slate200}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0 }}>
            {conn.icon}
          </div>
          <div style={{ flex:1 }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4, flexWrap:"wrap" }}>
              <span style={{ fontSize:13, fontWeight:700, color:T.slate900 }}>{conn.platform}</span>
              <StatusPill status={conn.status} />
            </div>
            <div style={{ fontSize:11, color:T.slate600, marginBottom:4 }}>{conn.connected_account}</div>
            <div style={{ fontSize:11, color:conn.status==="error"?T.red:T.slate400 }}>{conn.note}</div>
            {conn.status !== "manual" && (
              <div style={{ fontSize:10, color:T.slate400, marginTop:4 }}>Last sync: {conn.last_sync}</div>
            )}
          </div>
          {conn.status === "error" && (
            <button style={{ padding:"6px 14px", fontSize:11, fontWeight:600, color:T.white, background:T.red, border:"none", borderRadius:7, cursor:"pointer", flexShrink:0 }}>
              Reconnect
            </button>
          )}
          {conn.status === "healthy" && (
            <div style={{ fontSize:10, color:T.green, fontWeight:600, flexShrink:0, paddingTop:4 }}>✓ Connected</div>
          )}
        </div>
      </Card>
    ))}
  </div>
);

// ─── Section: Daily Briefing ──────────────────────────────────
const DailyBriefingSection = ({ briefings }) => {
  const [selected, setSelected] = useState(briefings[0]?.id);
  const current = briefings.find(b => b.id === selected);

  return (
    <div style={{ display:"grid", gridTemplateColumns:"minmax(0,1fr) minmax(0,2fr)", gap:12 }}>
      {/* Briefing List */}
      <Card>
        <div style={{ fontSize:13, fontWeight:600, color:T.slate800, marginBottom:12 }}>Briefing history</div>
        {briefings.map(b => (
          <div
            key={b.id}
            onClick={() => setSelected(b.id)}
            style={{ padding:"10px 12px", borderRadius:8, cursor:"pointer", background:selected===b.id?T.blueLt:"transparent", border:`1px solid ${selected===b.id?T.blue:T.slate200}`, marginBottom:6 }}
          >
            <div style={{ fontSize:12, fontWeight:600, color:T.slate800 }}>{b.date}</div>
            <div style={{ fontSize:10, color:T.slate400, marginTop:2 }}>
              Sent {b.sent_at} · {b.delivered?"Delivered":"Not delivered"} · {b.opened?"Opened":"Not opened"}
            </div>
            <div style={{ display:"flex", gap:4, marginTop:4 }}>
              {b.delivered && <span style={{ fontSize:9, padding:"2px 6px", borderRadius:10, background:T.greenLt, color:"#065F46", fontWeight:600 }}>Delivered</span>}
              {b.opened    && <span style={{ fontSize:9, padding:"2px 6px", borderRadius:10, background:T.blueLt,  color:"#1E40AF", fontWeight:600 }}>Opened</span>}
            </div>
          </div>
        ))}
      </Card>

      {/* Briefing Content */}
      {current && (
        <Card>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
            <div style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>{current.date} — Briefing Content</div>
            <AskBtn size="small" context={`My daily briefing from ${current.date}:\n\n${current.content}\n\nBased on this briefing, what should be my top 3 priorities today?`} />
          </div>
          <div style={{ background:T.slate50, borderRadius:10, padding:"14px 16px", fontSize:12, color:T.slate700, lineHeight:1.8, whiteSpace:"pre-line", fontFamily:"inherit" }}>
            {current.content}
          </div>
        </Card>
      )}
    </div>
  );
};

// ─── Section: Document Importer ───────────────────────────────
const DocImporter = ({ imports }) => {
  const [expanded, setExpanded] = useState(null);

  const typeLabel = (t) => ({
    comp_recap:    "COMP_RECAP",
    payroll_export:"Payroll Export",
    bank_statement:"Bank Statement",
    resume:        "Resume",
    tax_document:  "Tax Document",
  }[t] || t);

  const typeColor = (t) => ({
    comp_recap:     { bg:T.greenLt,  color:"#065F46" },
    payroll_export: { bg:T.blueLt,   color:"#1E40AF" },
    bank_statement: { bg:T.amberLt,  color:"#92400E" },
    resume:         { bg:T.purpleLt, color:"#5B21B6" },
    tax_document:   { bg:T.tealLt,   color:T.teal    },
  }[t] || { bg:T.slate100, color:T.slate500 });

  return (
    <Card>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:600, color:T.slate800 }}>Document Importer — Processing History</div>
          <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>Documents received via Gmail, parsed by Composio LLM, loaded to Supabase</div>
        </div>
        <AskBtn context="I'm reviewing my document importer history. Are there any documents that failed or need manual review? What should I follow up on?" />
      </div>

      {/* How It Works */}
      <div style={{ display:"flex", gap:0, marginBottom:16, overflow:"hidden", borderRadius:10, border:`1px solid ${T.slate200}` }}>
        {[
          { step:"1", label:"Email arrives", sub:"to your Gmail" },
          { step:"2", label:"Composio detects", sub:"attachment scanned" },
          { step:"3", label:"LLM classifies", sub:"Composio-hosted, free" },
          { step:"4", label:"Data loaded", sub:"to Supabase tables" },
          { step:"5", label:"Drive filed", sub:"correct folder" },
        ].map((s,i) => (
          <div key={i} style={{ flex:1, padding:"8px 4px", textAlign:"center", background:i%2===0?T.slate50:T.white, borderRight:i<4?`1px solid ${T.slate200}`:"none" }}>
            <div style={{ fontSize:14, fontWeight:700, color:T.blue }}>{s.step}</div>
            <div style={{ fontSize:9, fontWeight:600, color:T.slate700 }}>{s.label}</div>
            <div style={{ fontSize:9, color:T.slate400 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
        {imports.map(doc => {
          const isExpanded = expanded === doc.id;
          const tc = typeColor(doc.document_type);
          return (
            <div key={doc.id} style={{ border:`1px solid ${isExpanded?T.blue:T.slate200}`, borderRadius:8, overflow:"hidden" }}>
              <div
                style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px", cursor:"pointer" }}
                onClick={() => setExpanded(isExpanded?null:doc.id)}
              >
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:2, flexWrap:"wrap" }}>
                    <span style={{ fontSize:12, fontWeight:500, color:T.slate800, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{doc.file_name}</span>
                    <span style={{ fontSize:10, fontWeight:600, padding:"2px 7px", borderRadius:20, background:tc.bg, color:tc.color, flexShrink:0 }}>{typeLabel(doc.document_type)}</span>
                  </div>
                  <div style={{ fontSize:10, color:T.slate400 }}>{doc.date} · {doc.source} · {doc.records} records loaded</div>
                </div>
                <StatusPill status={doc.status} />
              </div>

              {isExpanded && (
                <div style={{ padding:"0 12px 12px", borderTop:`1px solid ${T.slate100}` }}>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:8, marginBottom:10 }}>
                    <div style={{ background:T.slate50, borderRadius:8, padding:"8px 10px" }}>
                      <div style={{ fontSize:10, color:T.slate400, marginBottom:2 }}>Source</div>
                      <div style={{ fontSize:11, fontWeight:500, color:T.slate700 }}>{doc.source}</div>
                    </div>
                    <div style={{ background:T.slate50, borderRadius:8, padding:"8px 10px" }}>
                      <div style={{ fontSize:10, color:T.slate400, marginBottom:2 }}>Tables Updated</div>
                      <div style={{ fontSize:11, fontWeight:500, color:T.slate700 }}>{doc.tables.join(", ")}</div>
                    </div>
                  </div>
                  {doc.status === "partial" && (
                    <div style={{ fontSize:11, color:"#92400E", background:T.amberLt, padding:"8px 10px", borderRadius:6, marginBottom:8 }}>
                      ⚠ Partial import — one or more pages could not be parsed. File saved to Google Drive for manual review.
                    </div>
                  )}
                  <AskBtn size="small" context={`Document import record:\nFile: ${doc.file_name}\nDate: ${doc.date}\nSource: ${doc.source}\nClassification: ${doc.document_type}\nStatus: ${doc.status}\nRecords loaded: ${doc.records}\nTables updated: ${doc.tables.join(", ")}\n\nHelp me verify this import looks correct and identify any follow-up needed.`} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
};

// ─── Main Automations Module ──────────────────────────────────
export default function Automations() {
  const [section, setSection] = useState("overview");
  const { data: liveRecipes, loading: recipesLoading } = useSupabaseTable("automation_recipes", AGENCY_ID, { orderBy: "created_at", ascending: false });
  const { data: liveRunLog }   = useSupabaseTable("automation_run_log", AGENCY_ID, { orderBy: "run_at", ascending: false });
  const { data: liveDocs }     = useSupabaseTable("documents", AGENCY_ID, { orderBy: "uploaded_at", ascending: false });

  // Normalize documents rows to the shape DocImporter renders.
  // Kept to the 25 most-recent for a lightweight recent-history view;
  // the full archive lives in the Documents module.
  const docImports = (Array.isArray(liveDocs) ? liveDocs : []).slice(0, 25).map(d => ({
    id:            d.id,
    file_name:     d.file_name || d.source_filename || "(unnamed)",
    document_type: d.document_type || d.groq_classification || "other",
    date:          d.uploaded_at ? new Date(d.uploaded_at).toLocaleString("en-US", { month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit" }) : "—",
    source:        d.upload_source || "—",
    records:       d.records_created ?? 0,
    status:        d.processing_status || "pending",
    tables:        Array.isArray(d.tables_updated) ? d.tables_updated : [],
  }));

  const [recipes, setRecipes] = useState([]);
  useEffect(() => {
    if (Array.isArray(liveRecipes)) setRecipes(liveRecipes);
  }, [liveRecipes]);

  const runLog = Array.isArray(liveRunLog) ? liveRunLog : [];

  // ── Live connections from settings table ─────────────────────
  const [connections, setConnections] = useState([]);

  useEffect(() => {
    async function loadConnections() {
      const { data } = await supabase
        .from("settings")
        .select("setting_key, setting_value")
        .eq("agency_id", AGENCY_ID)
        .in("setting_key", [
          "google_account_email",
          "composio_gmail_account_id",
          "composio_googledrive_account_id",
          "composio_googlecalendar_account_id",
          "composio_googledocs_account_id",
          "instagram_manual_reminder",
          "instagram_handle",
          "facebook_page_name",
          "linkedin_url",
        ]);

      if (!data) return;
      const s = Object.fromEntries(data.map(r => [r.setting_key, r.setting_value]));
      const email = s.google_account_email || "tiffanymapp.businessclaude@gmail.com";

      setConnections([
        {
          id: "c1",
          platform: "Gmail",
          icon: "📧",
          status: s.composio_gmail_account_id ? "healthy" : "error",
          connected_account: email,
          last_sync: "Daily at 8:00 AM ET",
          note: s.composio_gmail_account_id
            ? `Account ID: ${s.composio_gmail_account_id} — Daily Briefing + Document Processor use this connection`
            : "Not connected — reconnect in Composio",
        },
        {
          id: "c2",
          platform: "Google Drive",
          icon: "📁",
          status: s.composio_googledrive_account_id ? "healthy" : "error",
          connected_account: email,
          last_sync: "On document upload",
          note: s.composio_googledrive_account_id
            ? `Account ID: ${s.composio_googledrive_account_id} — Email Archiver files documents here`
            : "Not connected — reconnect in Composio",
        },
        {
          id: "c3",
          platform: "Google Calendar",
          icon: "📅",
          status: s.composio_googlecalendar_account_id ? "healthy" : "error",
          connected_account: email,
          last_sync: "On compliance events",
          note: s.composio_googlecalendar_account_id
            ? `Account ID: ${s.composio_googlecalendar_account_id} — Compliance calendar sync`
            : "Not connected — reconnect in Composio",
        },
        {
          id: "c4",
          platform: "Facebook",
          icon: "📘",
          status: "pending",
          connected_account: s.facebook_page_name || "Page not yet connected",
          last_sync: "N/A",
          note: "Facebook page connection pending — connect in Composio to enable auto-posting",
        },
        {
          id: "c5",
          platform: "LinkedIn",
          icon: "💼",
          status: "pending",
          connected_account: s.linkedin_url || "Profile not yet connected",
          last_sync: "N/A",
          note: "LinkedIn connection pending — connect in Composio to enable auto-posting",
        },
        {
          id: "c6",
          platform: "Instagram",
          icon: "📸",
          status: "manual",
          connected_account: s.instagram_handle || "@tiffanymappstatefarm",
          last_sync: "N/A",
          note: "Instagram requires manual daily posting — no API scheduling available. You post manually each day.",
        },
        {
          id: "c7",
          platform: "GitHub",
          icon: "⚙️",
          status: "healthy",
          connected_account: "tiffanymappbusinessclaude-cyber",
          last_sync: "On every app update",
          note: "BCC web app repo — Claude pushes code changes here, Vercel auto-deploys",
        },
        {
          id: "c8",
          platform: "Supabase",
          icon: "🗄️",
          status: "healthy",
          connected_account: "aerutjqyjlbzrklgpwzv",
          last_sync: "Live — every automation",
          note: "Agency database — all automations read and write here",
        },
      ]);
    }
    loadConnections();
  }, []);

  // Toggle is_active with optimistic local update + DB persist. Errors
  // log to console; next refresh reflects authoritative DB state either way.
  const toggleRecipe = async (id) => {
    const current = recipes.find(r => r.id === id);
    if (!current) return;
    const next = !current.is_active;
    setRecipes(prev => prev.map(r => r.id === id ? { ...r, is_active: next } : r));
    try {
      await supabase.from("automation_recipes").update({ is_active: next }).eq("id", id);
    } catch (e) {
      console.error("Failed to toggle recipe:", e);
    }
  };

  if (recipesLoading) return <div style={{padding:40,textAlign:"center",fontSize:13,color:"#64748B"}}>Loading automations…</div>;
  if (recipes.length === 0) return <EmptyState module="automations" />;

  const sections = [
    { id:"overview",  label:"Overview"          },
    { id:"runlog",    label:"Run Log"            },
    { id:"recipes",   label:`Recipes (${recipes.length})` },
    { id:"connections",label:"Connections"       },
    { id:"briefing",  label:"Daily Briefing"     },
    { id:"importer",  label:"Doc Importer"       },
  ];

  return (
    <div>
      {/* Module Header */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:16 }}>
        <div>
          <div style={{ fontSize:20, fontWeight:700, color:T.slate900, letterSpacing:"-0.02em" }}>Automations</div>
          <div style={{ fontSize:12, color:T.slate500, marginTop:3 }}>
            {recipes.filter(r => r.is_active).length} active recipes · Composio + Supabase execute · All results logged here
          </div>
        </div>
        <AskBtn context="I'm reviewing my BCC automations. Give me a health check — what's running well, what needs attention, and are there any automation improvements I should consider for my agency?" />
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
      {section === "overview"    && <AutomationOverview recipes={recipes} runLog={runLog} connections={connections} />}
      {section === "runlog"      && <RunLog runLog={runLog} />}
      {section === "recipes"     && <Recipes recipes={recipes} onToggle={toggleRecipe} />}
      {section === "connections" && <Connections connections={connections} />}
      {section === "briefing"    && <DailyBriefingSection briefings={[]} />}
      {section === "importer"    && <DocImporter imports={docImports} />}
    </div>
  );
}
