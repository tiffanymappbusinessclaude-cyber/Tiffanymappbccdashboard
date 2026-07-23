import { useState, useEffect } from "react";
import { supabase, AGENCY_ID } from "../lib/supabase.js";

// ── Design Tokens ──────────────────────────────────────────────
const T = {
  navy:"#1E3A5F", blue:"#2563EB", green:"#16A34A", amber:"#D97706",
  red:"#DC2626", slate900:"#0F172A", slate800:"#1E293B", slate700:"#334155",
  slate600:"#475569", slate500:"#64748B", slate400:"#94A3B8", slate300:"#CBD5E1",
  slate200:"#E2E8F0", slate100:"#F1F5F9", slate50:"#F8FAFC", white:"#FFFFFF",
  greenLt:"#DCFCE7", amberLt:"#FEF3C7", redLt:"#FEE2E2", blueLt:"#DBEAFE",
  navyLt:"#EFF6FF",
};

const fmt = v => { const n=parseFloat(v); return isNaN(n)?"$0.00":"$"+Math.abs(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); };
const pct = (v,m) => (((parseFloat(v)||0)/(parseFloat(m)||1))*100).toFixed(1);

// ── Mini Components ────────────────────────────────────────────
const Card = ({children, style={}}) => (
  <div style={{background:T.white, borderRadius:12, border:`1px solid ${T.slate200}`, padding:"16px 18px", ...style}}>
    {children}
  </div>
);

const SectionTitle = ({icon, title, action}) => (
  <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14}}>
    <div style={{display:"flex", alignItems:"center", gap:8}}>
      <span style={{fontSize:16}}>{icon}</span>
      <span style={{fontSize:13, fontWeight:700, color:T.slate800}}>{title}</span>
    </div>
    {action}
  </div>
);

const Badge = ({type="info", children}) => {
  const styles = {
    info:    {bg:T.blueLt,  color:T.blue},
    success: {bg:T.greenLt, color:T.green},
    warning: {bg:T.amberLt, color:T.amber},
    danger:  {bg:T.redLt,   color:T.red},
  };
  const s = styles[type] || styles.info;
  return (
    <span style={{display:"inline-flex", alignItems:"center", padding:"2px 8px", borderRadius:20, fontSize:10, fontWeight:700, background:s.bg, color:s.color}}>
      {children}
    </span>
  );
};

const EmptyRow = ({message}) => (
  <div style={{padding:"20px 0", textAlign:"center", color:T.slate400, fontSize:12}}>{message}</div>
);

const ProgressBar = ({value, max, color=T.blue, height=6}) => {
  const pctVal = Math.min(100, Math.max(0, ((parseFloat(value)||0)/(parseFloat(max)||1))*100));
  return (
    <div style={{background:T.slate100, borderRadius:99, height, overflow:"hidden"}}>
      <div style={{width:`${pctVal}%`, background:color, height:"100%", borderRadius:99, transition:"width 0.5s ease"}} />
    </div>
  );
};

// ── Widget: Financial KPIs ─────────────────────────────────────
const FinancialWidget = ({ data, onNavigate }) => {
  const s = data.summary || {};
  const trend = (p) => (p == null) ? "" : `${p >= 0 ? "↑" : "↓"} ${Math.abs(p).toFixed(1)}%`;
  const netColor = (s.netYTD >= 0) ? T.green : T.red;
  const ratioColor = (v, warn, crit) => (v == null) ? T.slate900 : (v > crit ? T.red : v > warn ? T.amber : T.slate900);
  const kpis = [
    { label:"Revenue YTD",   value:fmt(s.revenueYTD),  sub: s.yoyRevenuePct != null ? `${trend(s.yoyRevenuePct)} YoY` : "", color:T.navy,  border:T.navy },
    { label:"Expenses YTD",  value:fmt(s.expensesYTD), sub:"Accrual (CPA)",                                                color:T.red,   border:T.red  },
    { label:"Net Income YTD",value:fmt(s.netYTD),      sub: s.yoyNetPct != null ? `${trend(s.yoyNetPct)} YoY` : "",        color:netColor,border:netColor },
    { label:"Payroll Ratio", value:s.payrollRatioYTD != null ? `${Math.round(s.payrollRatioYTD)}%` : "—", sub: s.payrollRatioYTD != null && s.payrollRatioYTD > 55 ? "CRITICAL >55%" : "Target 40-50%", color: ratioColor(s.payrollRatioYTD, 50, 55), border: ratioColor(s.payrollRatioYTD, 50, 55) },
  ];
  return (
    <Card>
      <SectionTitle icon="💰" title="Financial Overview"
        action={<button onClick={()=>onNavigate("financials")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>View Full P&L →</button>}
      />
      <div style={{fontSize:10, color:T.slate500, marginBottom:8}}>As of {s.asOfLabel || "—"}</div>
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
        {kpis.map((k,i) => (
          <div key={i} style={{padding:"10px 12px", borderRadius:8, border:`1px solid ${k.border}20`, background:`${k.border}08`}}>
            <div style={{fontSize:10, color:T.slate500, marginBottom:4, fontWeight:600}}>{k.label}</div>
            <div style={{fontSize:16, fontWeight:800, color:k.color}}>{k.value}</div>
            {k.sub ? <div style={{fontSize:10, color:T.slate500, marginTop:3}}>{k.sub}</div> : null}
          </div>
        ))}
      </div>
    </Card>
  );
};



// ── Widget: Retention Touches This Week (compact tile for Row 1) ──
const RetentionWeekTile = ({ data, onNavigate }) => {
  const w = data?.retentionWeek || null;
  // Q3 weekly team target = 25 (325 / 13 weeks)
  const WEEKLY_TARGET = 25;
  const touches = w?.touches ?? 0;
  const retained = w?.retained ?? 0;
  const lost = w?.lost ?? 0;
  const startLabel = w?.startLabel || "";
  const isPreQ3 = w?.isPreQ3 || false;
  const pctOfTarget = WEEKLY_TARGET > 0 ? Math.round((touches / WEEKLY_TARGET) * 100) : 0;
  const targetColor = touches >= WEEKLY_TARGET ? T.green
                    : touches >= WEEKLY_TARGET * 0.6 ? T.amber
                    : touches > 0 ? T.red
                    : T.slate400;

  return (
    <Card>
      <SectionTitle icon="🔄" title="Renewals This Week"
        action={<button onClick={()=>onNavigate("financials")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>Protocol →</button>}
      />
      <div style={{fontSize:10, color:T.slate500, marginBottom:8}}>
        {isPreQ3 ? <>Week of {startLabel} · <span style={{color:T.amber, fontWeight:600}}>Pre-Q3 build</span></> : <>Week of {startLabel}</>}
      </div>

      {/* Big stat */}
      <div style={{padding:"14px 12px", borderRadius:8, border:`1px solid ${targetColor}30`, background:`${targetColor}08`, marginBottom:10}}>
        <div style={{display:"flex", alignItems:"baseline", justifyContent:"space-between", marginBottom:4}}>
          <div style={{fontSize:32, fontWeight:800, color:targetColor, letterSpacing:"-0.03em"}}>{touches}</div>
          <div style={{fontSize:11, color:T.slate500}}>of {WEEKLY_TARGET} target</div>
        </div>
        <ProgressBar value={touches} max={WEEKLY_TARGET} color={targetColor} height={6} />
        <div style={{fontSize:10, color:T.slate500, marginTop:6}}>{pctOfTarget}% of weekly goal</div>
      </div>

      {/* Outcomes row */}
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8}}>
        <div style={{padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate200}`, background:T.white}}>
          <div style={{fontSize:10, color:T.slate500, fontWeight:600}}>Retained</div>
          <div style={{fontSize:18, fontWeight:800, color: retained > 0 ? T.green : T.slate400, marginTop:2}}>{retained}</div>
        </div>
        <div style={{padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate200}`, background:T.white}}>
          <div style={{fontSize:10, color:T.slate500, fontWeight:600}}>Lost</div>
          <div style={{fontSize:18, fontWeight:800, color: lost > 0 ? T.red : T.slate400, marginTop:2}}>{lost}</div>
        </div>
      </div>

      {isPreQ3 && touches === 0 && (
        <div style={{marginTop:10, padding:"8px 10px", background:`${T.amber}10`, borderRadius:6, borderLeft:`3px solid ${T.amber}`, fontSize:10, color:T.slate700, lineHeight:1.4}}>
          Program kickoff: Monday team walkthrough. Patti owns the workflow.
        </div>
      )}
    </Card>
  );
};

// ── Widget: Renewal Retention (renewal commission MoM + YoY) ──
// The renewal book is ~6.5x larger than new business; renewal commission
// is the agency's foundation. This widget surfaces MoM trend, last-month
// headline with YoY, and per-LoB YTD breakdown so erosion is visible early.
const RetentionWidget = ({ data, onNavigate }) => {
  const r = data.retention || null;
  if (!r || !r.monthly || r.monthly.length === 0) {
    return (
      <Card>
        <SectionTitle icon="🔄" title="Renewal Retention" />
        <EmptyRow message="Loading renewal data…" />
      </Card>
    );
  }
  const lm = r.lastMonth;
  const yoyTotal = r.yoyPct;
  const arrow = (p) => (p == null) ? "" : (p >= 0 ? "↑" : "↓");
  const fmtPct = (p) => (p == null) ? "—" : `${arrow(p)} ${Math.abs(p).toFixed(1)}%`;
  const colorForPct = (p) => (p == null) ? T.slate500 : (p < -10 ? T.red : p < 0 ? T.amber : T.green);

  // Bar chart: monthly renewal total (last 12 months)
  const maxBar = Math.max(...r.monthly.map(m => m.total), 1);

  // LoB breakdown YTD vs prior YTD same period
  const lobView = [
    { key:"amutl",   label:"Auto/Mutual",   cur:r.ytd.amutl,   pri:r.ytd.prior_amutl   },
    { key:"fl_auto", label:"FL Auto",       cur:r.ytd.fl_auto, pri:r.ytd.prior_fl_auto },
    { key:"fire",    label:"Fire",          cur:r.ytd.fire,    pri:r.ytd.prior_fire    },
    { key:"life",    label:"Life",          cur:r.ytd.life,    pri:r.ytd.prior_life    },
  ].map(o => ({
    ...o,
    yoyPct: o.pri > 0 ? ((o.cur - o.pri) / o.pri) * 100 : null,
  }));

  return (
    <Card>
      <SectionTitle icon="🔄" title="Renewal Retention"
        action={<button onClick={()=>onNavigate("financials")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>View Comp Detail →</button>}
      />

      {/* Top row: YTD + Last Month headline */}
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12}}>
        <div style={{padding:"10px 12px", borderRadius:8, border:`1px solid ${T.navy}20`, background:`${T.navy}08`}}>
          <div style={{fontSize:10, color:T.slate500, marginBottom:4, fontWeight:600}}>Renewal Commission YTD</div>
          <div style={{fontSize:18, fontWeight:800, color:T.navy}}>${(r.ytd.total || 0).toLocaleString()}</div>
          <div style={{fontSize:11, color:colorForPct(yoyTotal), marginTop:3, fontWeight:600}}>
            {fmtPct(yoyTotal)} vs ${(r.ytd.priorTotal || 0).toLocaleString()} prior YTD
          </div>
          <div style={{fontSize:10, color:T.slate400, marginTop:2}}>{r.priorYtdLabel}</div>
        </div>
        <div style={{padding:"10px 12px", borderRadius:8, border:`1px solid ${colorForPct(lm?.yoy_pct)}30`, background:`${colorForPct(lm?.yoy_pct)}10`}}>
          <div style={{fontSize:10, color:T.slate500, marginBottom:4, fontWeight:600}}>Last Closed Month — {lm?.label}</div>
          <div style={{fontSize:18, fontWeight:800, color:T.slate900}}>${(lm?.total || 0).toLocaleString()}</div>
          <div style={{fontSize:11, color:colorForPct(lm?.yoy_pct), marginTop:3, fontWeight:600}}>
            {fmtPct(lm?.yoy_pct)} vs same month prior year
          </div>
          <div style={{fontSize:10, color:T.slate400, marginTop:2}}>Prior year: ${(lm?.prior_total || 0).toLocaleString()}</div>
        </div>
      </div>

      {/* Monthly bar chart — last 12 months */}
      <div style={{marginBottom:14}}>
        <div style={{fontSize:11, color:T.slate600, fontWeight:600, marginBottom:6}}>Monthly Renewal Commission — 12-month trend</div>
        <div style={{display:"flex", alignItems:"flex-end", gap:4, height:80}}>
          {r.monthly.map((m, i) => {
            const h = (m.total / maxBar) * 100;
            const isLast = i === r.monthly.length - 1;
            const yoyColor = colorForPct(m.yoy_pct);
            return (
              <div key={i} style={{flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3}}>
                <div title={`${m.label}: $${m.total.toLocaleString()} (${fmtPct(m.yoy_pct)} YoY)`}
                  style={{
                    width:"100%", height:`${Math.max(h, 4)}%`, minHeight:4,
                    background: isLast ? yoyColor : T.blue,
                    borderRadius:"3px 3px 0 0",
                    opacity: isLast ? 1 : 0.7,
                  }} />
                <div style={{fontSize:8, color:T.slate500}}>{m.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-LoB YTD breakdown */}
      <div>
        <div style={{fontSize:11, color:T.slate600, fontWeight:600, marginBottom:6}}>YTD by Line of Business</div>
        <div style={{display:"grid", gridTemplateColumns:"repeat(4, 1fr)", gap:6}}>
          {lobView.map(lob => (
            <div key={lob.key} style={{padding:"8px 10px", borderRadius:6, border:`1px solid ${T.slate200}`, background:T.white}}>
              <div style={{fontSize:10, color:T.slate500, fontWeight:600}}>{lob.label}</div>
              <div style={{fontSize:13, fontWeight:700, color:T.slate900, marginTop:2}}>${(lob.cur || 0).toLocaleString()}</div>
              <div style={{fontSize:10, color:colorForPct(lob.yoyPct), marginTop:2, fontWeight:600}}>{fmtPct(lob.yoyPct)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Insight callout */}
      {lm && lm.yoy_pct != null && lm.yoy_pct < -10 && (
        <div style={{marginTop:12, padding:"10px 12px", background:`${T.red}08`, borderRadius:8, borderLeft:`3px solid ${T.red}`, fontSize:11, color:T.slate700, lineHeight:1.5}}>
          <strong>{lm.label} renewal commission declined {Math.abs(lm.yoy_pct).toFixed(1)}% YoY.</strong> The renewal book is the agency's foundation — when monthly trend turns sustained-negative, root-cause is usually either lapse-rate increasing, rate-shopping (especially FL Auto), or a producer not making renewal touches. Open Comp Detail to see which LoB is bleeding.
        </div>
      )}
    </Card>
  );
};

// ── Widget: AIPP Progress ──────────────────────────────────────
// Shows YTD earned AIPP (5% × qualifying NEW P&C production), projected full
// year (using prior-year shape ratio), YoY pace vs same period last year, and
// per-line-of-business breakdown so the agent can see WHERE the gap is.
const AIPPWidget = ({ data, onNavigate }) => {
  const a = data.aipp || {};
  const earned = parseFloat(a.earned) || 0;
  const projected = parseFloat(a.projected) || 0;
  const priorYearActual = parseFloat(a.priorYearActual) || 0;
  const target = parseFloat(a.target) || 0;
  const targetIsPlaceholder = !!a.targetIsPlaceholder;

  // Pace vs prior year: projected vs prior year actual
  const pacePct = priorYearActual > 0
    ? ((projected - priorYearActual) / priorYearActual) * 100
    : null;
  const paceColor = pacePct == null ? T.slate500 : pacePct >= 0 ? T.green : T.red;
  const paceArrow = pacePct == null ? "—" : pacePct >= 0 ? "▲" : "▼";

  // Achievement vs target — only show if target is real
  const showAchievement = !targetIsPlaceholder && target > 0;
  const achievement = showAchievement ? (earned / target) * 100 : null;

  const lobRows = Array.isArray(a.lobBreakdown) ? a.lobBreakdown : [];

  const lobLabel = c => {
    if (c === "auto_mutual") return "Auto (AMUTL)";
    if (c === "fire") return "Fire";
    if (c === "florida_auto") return "Florida Auto";
    return c || "—";
  };

  return (
    <Card>
      <SectionTitle
        icon="🏆"
        title={`AIPP ${a.year || new Date().getFullYear()} Progress`}
        action={<button onClick={() => onNavigate("financials")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>Details →</button>}
      />

      {/* Top row: earned YTD + projected vs prior-year */}
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-end", marginBottom:10}}>
        <div>
          <div style={{fontSize:28, fontWeight:800, color:T.navy}}>{fmt(earned)}</div>
          <div style={{fontSize:11, color:T.slate500}}>earned YTD (Jan–{a.ytdThroughMonth || "current"})</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:11, color:T.slate500}}>Projected full year</div>
          <div style={{fontSize:18, fontWeight:700, color:T.navy}}>{fmt(projected)}</div>
          {pacePct != null && (
            <div style={{fontSize:11, color:paceColor, fontWeight:600, marginTop:2}}>
              {paceArrow} {Math.abs(pacePct).toFixed(1)}% vs {a.priorYear || "PY"} actual {fmt(priorYearActual)}
            </div>
          )}
        </div>
      </div>

      {/* Achievement bar (only if real target exists) */}
      {showAchievement && (
        <>
          <div style={{display:"flex", justifyContent:"space-between", fontSize:11, color:T.slate500, marginBottom:4}}>
            <span>{achievement.toFixed(1)}% of {fmt(target)} target</span>
            <span style={{color: achievement >= 80 ? T.green : T.amber}}>
              {achievement >= 100 ? "🎯 At goal" : achievement >= 80 ? "On pace" : "Behind"}
            </span>
          </div>
          <ProgressBar
            value={earned}
            max={target}
            color={achievement >= 80 ? T.green : T.amber}
            height={8}
          />
        </>
      )}

      {/* Line-of-business breakdown */}
      {lobRows.length > 0 && (
        <div style={{marginTop:12, paddingTop:10, borderTop:`1px solid ${T.slate200}`}}>
          <div style={{fontSize:10, fontWeight:700, color:T.slate500, textTransform:"uppercase", letterSpacing:0.4, marginBottom:6}}>
            AIPP-eligible by line · YTD vs {a.priorYear || "PY"} same period
          </div>
          {lobRows.map((r, i) => {
            const yoy = r.yoy_pct;
            const yoyColor = yoy == null ? T.slate500 : yoy >= 0 ? T.green : T.red;
            const yoyArrow = yoy == null ? "—" : yoy >= 0 ? "▲" : "▼";
            return (
              <div key={i} style={{display:"grid", gridTemplateColumns:"1.4fr 0.9fr 0.9fr", gap:6, fontSize:11, padding:"3px 0", color:T.slate700}}>
                <div style={{fontWeight:600}}>{lobLabel(r.category)}</div>
                <div style={{textAlign:"right"}}>{fmt(r.ytd_current)}</div>
                <div style={{textAlign:"right", color: yoyColor, fontWeight:600}}>
                  {yoyArrow} {yoy == null ? "—" : Math.abs(yoy).toFixed(1) + "%"}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Footnote */}
      {targetIsPlaceholder && (
        <div style={{marginTop:10, padding:"6px 8px", background:`${T.amber}15`, borderRadius:4, fontSize:10, color:T.slate700, lineHeight:1.4}}>
          ⚠️ <strong>Target needs update.</strong> ${target.toLocaleString()} is a placeholder. Provide the actual State Farm AIPP target for achievement % to populate.
        </div>
      )}
    </Card>
  );
};

// ── Widget: Monthly Close Progress ────────────────────────────
// Visual checklist: closed months shown as compact pills, current month shows
// item-by-item received/outstanding with the actual document labels.
const MonthlyCloseWidget = ({ data, onNavigate }) => {
  const checklist = data.closeChecklist || [];
  const monthName = (y, m) => new Date(y, m-1, 1).toLocaleDateString("en-US",{month:"short", year:"numeric"});
  const monthLong = (y, m) => new Date(y, m-1, 1).toLocaleDateString("en-US",{month:"long", year:"numeric"});

  // Group rows by year-month
  const groups = {};
  for (const row of checklist) {
    const key = `${row.period_year}-${String(row.period_month).padStart(2,"0")}`;
    if (!groups[key]) groups[key] = { year: row.period_year, month: row.period_month, items: [], is_closed: row.is_closed };
    groups[key].items.push(row);
    if (row.is_closed) groups[key].is_closed = true;
  }
  const sortedKeys = Object.keys(groups).sort().reverse();
  const periods = sortedKeys.map(k => groups[k]);

  // Empty state
  if (periods.length === 0) {
    return (
      <Card>
        <SectionTitle icon="📅" title="Monthly Close" />
        <div style={{padding:"16px 0", fontSize:12, color:T.slate400, textAlign:"center"}}>
          Ask your Claude to set up your monthly close checklist
        </div>
      </Card>
    );
  }

  const current = periods.find(p => !p.is_closed) || periods[0];
  const closedMonths = periods.filter(p => p.is_closed).slice(0, 4);

  const received = current.items.filter(i => i.received_at).length;
  const total = current.items.length;
  const allReceived = received === total && total > 0;
  const outstandingItems = current.items.filter(i => !i.received_at);
  const receivedItems = current.items.filter(i => i.received_at);
  const formatDate = (d) => d ? new Date(d).toLocaleDateString("en-US",{month:"short",day:"numeric"}) : "";

  return (
    <Card>
      <SectionTitle icon="📅" title={`Monthly Close — ${monthLong(current.year, current.month)}`}
        action={<button onClick={()=>onNavigate("documents")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>View All →</button>}
      />

      {/* Summary header */}
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10}}>
        <div style={{fontSize:13, color:T.slate700}}>
          <span style={{fontWeight:700, color:allReceived?T.green:T.amber}}>{received}</span>
          <span style={{color:T.slate400}}> / {total} documents received</span>
        </div>
        <Badge type={allReceived?"success":"warning"}>{allReceived?"Ready to Close":"In Progress"}</Badge>
      </div>
      <ProgressBar value={received} max={total} color={allReceived?T.green:T.amber} height={6} />

      {/* Item-by-item checklist for current month */}
      <div style={{marginTop:12, display:"flex", flexDirection:"column", gap:5}}>
        {receivedItems.map((item, i) => (
          <div key={`r${i}`} style={{display:"flex", alignItems:"center", justifyContent:"space-between", fontSize:11, padding:"5px 8px", borderRadius:6, background:T.greenLt}}>
            <div style={{display:"flex", alignItems:"center", gap:7, minWidth:0, flex:1}}>
              <span style={{color:T.green, fontSize:13, lineHeight:1}}>✓</span>
              <span style={{color:T.slate800, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{item.doc_label}</span>
            </div>
            <span style={{color:T.slate500, fontSize:10, flexShrink:0, marginLeft:8}}>{formatDate(item.received_at)}</span>
          </div>
        ))}
        {outstandingItems.map((item, i) => (
          <div key={`o${i}`} style={{display:"flex", alignItems:"center", justifyContent:"space-between", fontSize:11, padding:"5px 8px", borderRadius:6, background:T.amberLt}}>
            <div style={{display:"flex", alignItems:"center", gap:7, minWidth:0, flex:1}}>
              <span style={{color:T.amber, fontSize:13, lineHeight:1}}>○</span>
              <span style={{color:T.slate800, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{item.doc_label}</span>
            </div>
            <span style={{color:T.amber, fontSize:10, fontWeight:600, flexShrink:0, marginLeft:8}}>
              Expected {formatDate(item.expected_by)}
            </span>
          </div>
        ))}
      </div>

      {/* Closed prior months — compact strip */}
      {closedMonths.length > 0 && (
        <div style={{marginTop:14, paddingTop:10, borderTop:`1px dashed ${T.slate200}`}}>
          <div style={{fontSize:10, color:T.slate500, fontWeight:600, marginBottom:6, letterSpacing:"0.04em", textTransform:"uppercase"}}>
            Recently Closed
          </div>
          <div style={{display:"flex", gap:6, flexWrap:"wrap"}}>
            {closedMonths.map((p, i) => (
              <div key={i} style={{display:"flex", alignItems:"center", gap:5, padding:"3px 8px", borderRadius:12, background:T.green, color:"#fff", fontSize:10, fontWeight:600}}>
                <span>✓</span>
                <span>{monthName(p.year, p.month)}</span>
                <span style={{opacity:0.75, fontSize:9, fontWeight:500}}>{p.items.length}/{p.items.length}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
};

// ── Widget: High Priority Tasks ───────────────────────────────
const TasksWidget = ({ data, onNavigate }) => {
  const tasks = (data.tasks || [])
    .filter(t => t.priority === "high" && t.status !== "completed")
    .slice(0, 5);
  return (
    <Card>
      <SectionTitle icon="✅" title="High Priority Tasks"
        action={<button onClick={()=>onNavigate("tasks")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>All Tasks →</button>}
      />
      {tasks.length === 0 ? (
        <EmptyRow message="No high priority tasks — you're clear! ✨" />
      ) : (
        <div style={{display:"flex", flexDirection:"column", gap:8}}>
          {tasks.map((t,i) => (
            <div key={i} style={{display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 10px", borderRadius:8, background:T.slate50, border:`1px solid ${T.slate200}`}}>
              <div>
                <div style={{fontSize:12, fontWeight:600, color:T.slate800}}>{t.title||t.task_title}</div>
                {t.due_date && <div style={{fontSize:10, color:T.slate500, marginTop:2}}>Due: {t.due_date}</div>}
              </div>
              <Badge type="danger">High</Badge>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

// ── Widget: Open Items (Claude waiting on answers) ────────────
const OpenItemsWidget = ({ data, onNavigate }) => {
  const openItems = (data.openItems || data.persistentMemory || [])
    .filter(m => m.memory_type === "open_item" || m.needs_followup === true || m.is_active === true || m.status === "pending_agent_input")
    .slice(0, 5);
  return (
    <Card>
      <SectionTitle icon="🔍" title="Open Items — Claude Needs Your Input"
        action={<button onClick={()=>onNavigate("memory")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>View All →</button>}
      />
      {openItems.length === 0 ? (
        <EmptyRow message="No open items — Claude has everything it needs ✨" />
      ) : (
        <div style={{display:"flex", flexDirection:"column", gap:8}}>
          {openItems.map((item,i) => (
            <div key={i} style={{padding:"8px 10px", borderRadius:8, background:T.amberLt, border:`1px solid #FDE68A`}}>
              <div style={{fontSize:12, fontWeight:600, color:"#92400E"}}>{item.title||item.content?.slice(0,60)||"Pending item"}</div>
              {item.context && <div style={{fontSize:10, color:"#B45309", marginTop:2}}>{item.context.slice(0,80)}</div>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

// ── Widget: Active Alerts ─────────────────────────────────────
const AlertsWidget = ({ data, onNavigate }) => {
  const alerts = (data.alerts || [])
    .filter(a => !a.is_resolved)
    .sort((a,b) => {
      const sev = {critical:0, warning:1, info:2};
      return (sev[a.severity]||2) - (sev[b.severity]||2);
    })
    .slice(0, 4);
  return (
    <Card>
      <SectionTitle icon="🔔" title="Active Alerts"
        action={<button onClick={()=>onNavigate("alerts")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>All Alerts →</button>}
      />
      {alerts.length === 0 ? (
        <div style={{display:"flex", alignItems:"center", gap:10, padding:"12px 0"}}>
          <span style={{fontSize:24}}>✅</span>
          <div>
            <div style={{fontSize:13, fontWeight:600, color:T.green}}>All Clear</div>
            <div style={{fontSize:11, color:T.slate500}}>No active alerts requiring attention</div>
          </div>
        </div>
      ) : (
        <div style={{display:"flex", flexDirection:"column", gap:8}}>
          {alerts.map((a,i) => (
            <div key={i} style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", padding:"8px 10px", borderRadius:8, background:a.severity==="critical"?T.redLt:a.severity==="warning"?T.amberLt:T.blueLt, border:`1px solid ${a.severity==="critical"?"#FCA5A5":a.severity==="warning"?"#FDE68A":"#BFDBFE"}`}}>
              <div style={{flex:1}}>
                <div style={{fontSize:12, fontWeight:600, color:a.severity==="critical"?T.red:a.severity==="warning"?T.amber:T.blue}}>{a.title}</div>
                {a.due_date && <div style={{fontSize:10, color:T.slate600, marginTop:2}}>Due: {a.due_date}</div>}
              </div>
              <Badge type={a.severity==="critical"?"danger":a.severity==="warning"?"warning":"info"}>
                {a.severity}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

// ── Widget: Emails Needing Attention (Gmail via Edge Function) ──
const EmailsNeedingAttentionWidget = ({ inbox, onRefresh, onNavigate }) => {
  const messages = Array.isArray(inbox?.messages) ? inbox.messages.slice(0, 5) : [];
  const loading = !!inbox?.loading;
  const error = inbox?.error || null;
  const ageLabel = (h) => {
    const n = Number(h) || 0;
    if (n < 1) return "just now";
    if (n < 24) return `${n}h ago`;
    const d = Math.floor(n / 24);
    return `${d}d ago`;
  };
  return (
    <Card>
      <SectionTitle icon="📧" title="Emails Needing Attention"
        action={
          <div style={{display:"flex", gap:8}}>
            <button onClick={onRefresh} title="Refresh" style={{fontSize:11,color:T.slate500,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>↻ Refresh</button>
            <a href="https://mail.google.com/mail/u/0/#inbox" target="_blank" rel="noreferrer" style={{fontSize:11,color:T.blue,fontWeight:600,textDecoration:"none"}}>Open Inbox →</a>
          </div>
        }
      />
      {loading ? (
        <div style={{padding:"14px 0", color:T.slate400, fontSize:12, textAlign:"center"}}>Loading inbox…</div>
      ) : error ? (
        <div style={{padding:"10px 12px", background:T.amberLt, border:`1px solid #FDE68A`, borderRadius:8, fontSize:11, color:T.amber}}>
          Couldn't reach Gmail — {String(error).slice(0,120)}
        </div>
      ) : messages.length === 0 ? (
        <div style={{display:"flex", alignItems:"center", gap:10, padding:"12px 0"}}>
          <span style={{fontSize:24}}>✅</span>
          <div>
            <div style={{fontSize:13, fontWeight:600, color:T.green}}>Inbox Zero</div>
            <div style={{fontSize:11, color:T.slate500}}>No unread emails needing attention</div>
          </div>
        </div>
      ) : (
        <div style={{display:"flex", flexDirection:"column", gap:6}}>
          {messages.map((m,i) => (
            <div key={m?.id || i} style={{padding:"8px 10px", borderRadius:8, background:T.slate50, border:`1px solid ${T.slate200}`}}>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:8}}>
                <div style={{fontSize:11, fontWeight:700, color:T.slate800, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
                  {m?.sender || "Unknown"}
                </div>
                <div style={{fontSize:10, color:T.slate500, whiteSpace:"nowrap"}}>{ageLabel(m?.age_hours)}</div>
              </div>
              <div style={{fontSize:11.5, color:T.slate700, marginTop:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
                {m?.has_attachment ? "📎 " : ""}{m?.subject || "(no subject)"}
              </div>
              {m?.snippet && (
                <div style={{fontSize:10.5, color:T.slate500, marginTop:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
                  {m.snippet}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

// ── Widget: Upcoming Calendar Events (Google Calendar via Edge Function) ──
const CalendarEventsWidget = ({ events, onRefresh, onNavigate }) => {
  const list = Array.isArray(events?.items) ? events.items : [];
  const loading = !!events?.loading;
  const error = events?.error || null;
  const now = new Date();
  const todayStr = now.toISOString().slice(0,10);
  const tomorrow = new Date(now.getTime() + 24*60*60*1000);
  const tomorrowStr = tomorrow.toISOString().slice(0,10);
  const fmtTime = (iso, allDay) => {
    if (!iso) return "—";
    if (allDay) return "All day";
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" });
    } catch { return "—"; }
  };
  const dayLabel = (iso) => {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      const dayStr = d.toISOString().slice(0,10);
      if (dayStr === todayStr) return "Today";
      if (dayStr === tomorrowStr) return "Tomorrow";
      return d.toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric" });
    } catch { return "—"; }
  };
  const grouped = {};
  for (const e of list.slice(0, 8)) {
    const key = dayLabel(e?.start);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(e);
  }
  const sectionKeys = Object.keys(grouped);
  return (
    <Card>
      <SectionTitle icon="📅" title="Upcoming Events"
        action={
          <div style={{display:"flex", gap:8}}>
            <button onClick={onRefresh} title="Refresh" style={{fontSize:11,color:T.slate500,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>↻ Refresh</button>
            <a href="https://calendar.google.com/calendar/u/0/r" target="_blank" rel="noreferrer" style={{fontSize:11,color:T.blue,fontWeight:600,textDecoration:"none"}}>Open Calendar →</a>
          </div>
        }
      />
      {loading ? (
        <div style={{padding:"14px 0", color:T.slate400, fontSize:12, textAlign:"center"}}>Loading calendar…</div>
      ) : error ? (
        <div style={{padding:"10px 12px", background:T.amberLt, border:`1px solid #FDE68A`, borderRadius:8, fontSize:11, color:T.amber}}>
          Couldn't reach Calendar — {String(error).slice(0,120)}
        </div>
      ) : sectionKeys.length === 0 ? (
        <div style={{display:"flex", alignItems:"center", gap:10, padding:"12px 0"}}>
          <span style={{fontSize:24}}>🗓️</span>
          <div>
            <div style={{fontSize:13, fontWeight:600, color:T.slate700}}>Nothing on the books</div>
            <div style={{fontSize:11, color:T.slate500}}>No upcoming events in the next 7 days</div>
          </div>
        </div>
      ) : (
        <div style={{display:"flex", flexDirection:"column", gap:10}}>
          {sectionKeys.map((sect) => (
            <div key={sect}>
              <div style={{fontSize:10, fontWeight:700, color:T.slate500, textTransform:"uppercase", letterSpacing:0.5, marginBottom:4}}>{sect}</div>
              <div style={{display:"flex", flexDirection:"column", gap:4}}>
                {(grouped[sect] || []).map((e,i) => (
                  <div key={e?.id || i} style={{display:"grid", gridTemplateColumns:"70px 1fr", gap:8, padding:"6px 10px", borderRadius:6, background:T.slate50, border:`1px solid ${T.slate200}`}}>
                    <div style={{fontSize:11, fontWeight:600, color:T.navy, whiteSpace:"nowrap"}}>
                      {fmtTime(e?.start, e?.is_all_day)}
                    </div>
                    <div style={{minWidth:0}}>
                      <div style={{fontSize:11.5, fontWeight:600, color:T.slate800, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
                        {e?.title || "(no title)"}
                      </div>
                      {(e?.location || (e?.attendee_count > 0)) && (
                        <div style={{fontSize:10, color:T.slate500, marginTop:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
                          {e?.location || ""}{e?.location && e?.attendee_count > 0 ? " · " : ""}{e?.attendee_count > 0 ? `${e.attendee_count} ${e.attendee_count===1?"attendee":"attendees"}` : ""}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

// ── Widget: Compliance Summary ────────────────────────────────
const ComplianceWidget = ({ data, onNavigate }) => {
  const rules = data.complianceRules || [];
  const violations = rules.filter(r => r.status === "violation" || r.is_active).length;
  const pending = rules.filter(r => r.status === "pending_review").length;
  const compliant = rules.filter(r => r.status === "compliant").length;
  const total = rules.length;

  return (
    <Card>
      <SectionTitle icon="⚖️" title="Compliance Status"
        action={<button onClick={()=>onNavigate("compliance")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>Review →</button>}
      />
      {total === 0 ? (
        <div style={{fontSize:11, color:T.amber, textAlign:"center", padding:"12px 0"}}>
          ⚠️ Compliance rules not seeded yet<br/>
          <span style={{color:T.slate500}}>Ask Claude: "Seed my SF compliance rules"</span>
        </div>
      ) : (
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8}}>
          {[
            {label:"Compliant", value:compliant, color:T.green, bg:T.greenLt},
            {label:"Pending",   value:pending,   color:T.amber, bg:T.amberLt},
            {label:"Violations",value:violations,color:T.red,   bg:T.redLt},
          ].map((s,i) => (
            <div key={i} style={{textAlign:"center", padding:"10px 8px", borderRadius:8, background:s.bg}}>
              <div style={{fontSize:22, fontWeight:800, color:s.color}}>{s.value}</div>
              <div style={{fontSize:10, color:T.slate600, fontWeight:600}}>{s.label}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

// ── Widget: Producer Scoreboard (FrontRunner) ────────────────
const ProducerScoreboardWidget = ({ data, onNavigate }) => {
  const rows = Array.isArray(data?.producerScoreboard) ? data.producerScoreboard : [];
  const totals = data?.producerScoreboardTotals || {};
  const days = data?.producerScoreboardDays || 0;
  const start = data?.producerScoreboardStart || "";
  const end = data?.producerScoreboardEnd || "";
  const fmtDate = d => { if (!d) return ""; const [y,m,da] = d.split("-"); return `${parseInt(m)}/${parseInt(da)}`; };
  const conv = (Number.isFinite(totals.outbound) && totals.outbound > 0)
    ? ((totals.issued / totals.outbound) * 100).toFixed(2)
    : "0.00";

  return (
    <Card>
      <SectionTitle
        icon="🏆"
        title={`Producer Scoreboard${days ? ` — ${days} Day${days===1?"":"s"}` : ""}`}
        action={
          <span style={{fontSize:11, color:T.slate500, fontWeight:600}}>
            {(start && end) ? `${fmtDate(start)} → ${fmtDate(end)}` : ""}
          </span>
        }
      />
      {rows.length === 0 ? (
        <EmptyRow message="No producer activity yet — FrontRunner daily summaries auto-ingest at 10:30 AM ET." />
      ) : (
        <>
          <div style={{display:"grid", gridTemplateColumns:"1.5fr 0.55fr 0.7fr 0.7fr 0.9fr 0.7fr 0.7fr 0.9fr", gap:6, fontSize:10, fontWeight:700, color:T.slate500, padding:"6px 8px", borderBottom:`1px solid ${T.slate200}`, textTransform:"uppercase", letterSpacing:0.4}}>
            <div>Producer</div>
            <div style={{textAlign:"right"}}>Hrs</div>
            <div style={{textAlign:"right"}}>Written</div>
            <div style={{textAlign:"right"}}>Issued</div>
            <div style={{textAlign:"right"}}>Outbound</div>
            <div style={{textAlign:"right"}}>Quotes</div>
            <div style={{textAlign:"right"}}>FS Piv</div>
            <div style={{textAlign:"right"}} title="Renewal touches / retained / lost">Renewals</div>
          </div>
          {rows.map((r, i) => {
            const hrs = (parseFloat(r?.hours) || 0).toFixed(1);
            const written = parseInt(r?.written) || 0;
            const issued = parseInt(r?.issued) || 0;
            const outbound = parseInt(r?.outbound) || 0;
            const quotes = parseInt(r?.auto_quotes) || 0;
            const piv = parseInt(r?.fs_pivots) || 0;
            const renTouch = parseInt(r?.renewal_touches) || 0;
            const renRet = parseInt(r?.renewals_retained) || 0;
            const renLost = parseInt(r?.renewals_lost) || 0;
            const expectedHrs = (days || 0) * 8;
            const isLow = days >= 3 && (parseFloat(r?.hours) || 0) < expectedHrs * 0.5;
            const isStar = issued >= 2 || written >= 5;
            return (
              <div key={i} style={{display:"grid", gridTemplateColumns:"1.5fr 0.55fr 0.7fr 0.7fr 0.9fr 0.7fr 0.7fr 0.9fr", gap:6, fontSize:11, padding:"8px", borderBottom:`1px solid ${T.slate100}`, alignItems:"center", background: isStar ? `${T.green}10` : isLow ? `${T.red}10` : "transparent"}}>
                <div style={{fontWeight:600, color:T.slate800}}>
                  {r?.producer_name || "—"} {isStar ? "⭐" : ""}{isLow ? " ⚠️" : ""}
                </div>
                <div style={{textAlign:"right", color:T.slate700}}>{hrs}</div>
                <div style={{textAlign:"right", fontWeight:600, color: written>0 ? T.green : T.slate400}}>{written}</div>
                <div style={{textAlign:"right", fontWeight:700, color: issued>0 ? T.green : T.slate400}}>{issued}</div>
                <div style={{textAlign:"right", color:T.slate700}}>{outbound}</div>
                <div style={{textAlign:"right", color:T.slate700}}>{quotes}</div>
                <div style={{textAlign:"right", color:T.slate700}}>{piv}</div>
                <div style={{textAlign:"right", fontSize:10, color: renTouch>0 ? T.slate700 : T.slate400}}>
                  {renTouch>0 ? (
                    <span title={`${renTouch} touches · ${renRet} retained · ${renLost} lost`}>
                      <strong style={{color: T.navy}}>{renTouch}</strong>
                      {(renRet>0 || renLost>0) ? (
                        <span style={{marginLeft:2, color: T.slate500}}>
                          <span style={{color:T.green}}>+{renRet}</span>
                          {renLost>0 ? <span style={{color:T.red, marginLeft:1}}>/-{renLost}</span> : null}
                        </span>
                      ) : null}
                    </span>
                  ) : "—"}
                </div>
              </div>
            );
          })}
          <div style={{display:"grid", gridTemplateColumns:"1.5fr 0.55fr 0.7fr 0.7fr 0.9fr 0.7fr 0.7fr 0.9fr", gap:6, fontSize:11, padding:"10px 8px", borderTop:`2px solid ${T.slate300}`, fontWeight:800, color:T.navy, background:T.slate50}}>
            <div>TEAM TOTAL</div>
            <div style={{textAlign:"right"}}>{(parseFloat(totals?.hours)||0).toFixed(1)}</div>
            <div style={{textAlign:"right"}}>{parseInt(totals?.written)||0}</div>
            <div style={{textAlign:"right"}}>{parseInt(totals?.issued)||0}</div>
            <div style={{textAlign:"right"}}>{parseInt(totals?.outbound)||0}</div>
            <div style={{textAlign:"right"}}>{parseInt(totals?.auto_quotes)||0}</div>
            <div style={{textAlign:"right"}}>{parseInt(totals?.fs_pivots)||0}</div>
            <div style={{textAlign:"right"}} title="Touches / retained / lost">
              <strong>{parseInt(totals?.renewal_touches)||0}</strong>
              {((parseInt(totals?.renewals_retained)||0) > 0 || (parseInt(totals?.renewals_lost)||0) > 0) ? (
                <span style={{fontSize:9, marginLeft:3, fontWeight:600}}>
                  <span style={{color:T.green}}>+{parseInt(totals?.renewals_retained)||0}</span>
                  {(parseInt(totals?.renewals_lost)||0) > 0 ? <span style={{color:T.red}}>/-{parseInt(totals?.renewals_lost)||0}</span> : null}
                </span>
              ) : null}
            </div>
          </div>
          <div style={{padding:"10px 8px 0", fontSize:10, color:T.slate500, display:"flex", justifyContent:"space-between"}}>
            <span>Outbound → Issued conversion: <strong style={{color:T.slate700}}>{conv}%</strong></span>
            <span style={{fontStyle:"italic"}}>⭐ standout · ⚠️ low engagement (&lt;50% of expected hrs)</span>
          </div>
        </>
      )}
    </Card>
  );
};

// ── Widget: Q3 2026 Progress vs FS Pivot Targets ───────────────
// Pre-Q3 (before Jul 1): countdown + targets-only display
// During Q3: per-producer actual vs target with pace flag
// Post-Q3 (after Sep 30): archive view
const Q3ProgressWidget = ({ data, onNavigate, unifiedMode = false }) => {
  const rows = Array.isArray(data?.q3Rows) ? data.q3Rows : [];
  const teamGoal = data?.q3TeamGoal || null;
  const phase = data?.q3Phase || "pre"; // 'pre' | 'live' | 'post'
  const daysUntilQ3 = data?.q3DaysUntil || 0;
  const daysIntoQ3 = data?.q3DaysInto || 0;
  const q3TotalWorkingDays = 65; // 13 working weeks
  const daysRemaining = Math.max(0, q3TotalWorkingDays - daysIntoQ3);

  const fmtPct = v => Number.isFinite(v) ? v.toFixed(0) + "%" : "—";

  // Per-row helpers
  const computeRow = r => {
    const target = parseFloat(r.target) || 0;
    const actual = parseFloat(r.actual) || 0;
    const expectedToDate = phase === "live"
      ? target * (daysIntoQ3 / q3TotalWorkingDays)
      : (phase === "post" ? target : 0);
    const pctOfTarget = target > 0 ? (actual / target) * 100 : 0;
    const paceDelta = expectedToDate > 0 ? actual - expectedToDate : 0;
    const onPace = expectedToDate === 0 ? null : actual >= expectedToDate * 0.9;
    return { target, actual, expectedToDate, pctOfTarget, paceDelta, onPace };
  };

  // Banner styling per phase
  const bannerBg = phase === "pre" ? `${T.blue}10` : phase === "live" ? `${T.green}10` : `${T.slate200}`;
  const bannerColor = phase === "pre" ? T.blue : phase === "live" ? T.green : T.slate500;
  const bannerText = phase === "pre"
    ? `Q3 2026 starts in ${daysUntilQ3} day${daysUntilQ3 === 1 ? "" : "s"} — targets are set, scoreboard goes live July 1`
    : phase === "live"
      ? `Day ${daysIntoQ3} of ${q3TotalWorkingDays} working days — ${daysRemaining} remaining`
      : `Q3 2026 closed — archive view`;

  const innerContent = (
    <>
      {rows.length === 0 ? (
        <EmptyRow message="No Q3 2026 goals found in the database." />
      ) : (
        <>
          {/* Column headers */}
          <div style={{display:"grid", gridTemplateColumns:"1.6fr 0.7fr 0.8fr 0.9fr 1fr 1fr", gap:6, fontSize:10, fontWeight:700, color:T.slate500, padding:"6px 8px", borderBottom:`1px solid ${T.slate200}`, textTransform:"uppercase", letterSpacing:0.4}}>
            <div>Producer</div>
            <div style={{textAlign:"right"}}>Target</div>
            <div style={{textAlign:"right"}}>Actual</div>
            <div style={{textAlign:"right"}}>Expected{phase==="live" ? " to date" : ""}</div>
            <div>Progress</div>
            <div style={{textAlign:"right"}}>Pace</div>
          </div>

          {/* Producer rows */}
          {rows.map((r, i) => {
            const m = computeRow(r);
            const barPct = Math.min(100, Math.max(0, m.pctOfTarget));
            const barColor = phase === "pre"
              ? T.slate300
              : m.onPace === true ? T.green : m.onPace === false ? T.red : T.slate400;
            const paceArrow = m.paceDelta > 0 ? "▲" : m.paceDelta < 0 ? "▼" : "—";
            const paceText = phase === "pre"
              ? "—"
              : phase === "live"
                ? `${paceArrow} ${Math.abs(m.paceDelta).toFixed(0)}`
                : (m.actual >= m.target ? "✅ Hit" : "Missed");
            const paceColor = phase === "pre" ? T.slate400 : m.onPace === true ? T.green : m.onPace === false ? T.red : T.slate500;

            return (
              <div key={i} style={{display:"grid", gridTemplateColumns:"1.6fr 0.7fr 0.8fr 0.9fr 1fr 1fr", gap:6, fontSize:11, padding:"7px 8px", borderBottom:`1px solid ${T.slate100}`, alignItems:"center"}}>
                <div style={{fontWeight:600, color:T.slate800}}>{r.producer_name || "—"}</div>
                <div style={{textAlign:"right", color:T.slate700}}>{m.target.toFixed(0)}</div>
                <div style={{textAlign:"right", fontWeight:600, color:T.slate800}}>{m.actual.toFixed(0)}</div>
                <div style={{textAlign:"right", color:T.slate500}}>{phase==="pre" ? "—" : m.expectedToDate.toFixed(0)}</div>
                <div>
                  <div style={{display:"flex", alignItems:"center", gap:6}}>
                    <div style={{flex:1, height:6, background:T.slate100, borderRadius:3, overflow:"hidden"}}>
                      <div style={{width:`${barPct}%`, height:"100%", background:barColor, transition:"width 300ms"}}/>
                    </div>
                    <span style={{fontSize:10, color:T.slate500, minWidth:32, textAlign:"right"}}>{fmtPct(m.pctOfTarget)}</span>
                  </div>
                </div>
                <div style={{textAlign:"right", color:paceColor, fontWeight:600, fontSize:11}}>{paceText}</div>
              </div>
            );
          })}

          {/* Team total row */}
          {teamGoal && (() => {
            const m = computeRow(teamGoal);
            const barPct = Math.min(100, Math.max(0, m.pctOfTarget));
            const barColor = phase === "pre" ? T.slate400
              : m.onPace === true ? T.green : m.onPace === false ? T.red : T.slate400;
            const paceArrow = m.paceDelta > 0 ? "▲" : m.paceDelta < 0 ? "▼" : "—";
            const paceText = phase === "pre" ? "—"
              : phase === "live" ? `${paceArrow} ${Math.abs(m.paceDelta).toFixed(0)}`
              : (m.actual >= m.target ? "✅ Hit" : "Missed");
            const paceColor = phase === "pre" ? T.slate400 : m.onPace === true ? T.green : m.onPace === false ? T.red : T.slate500;

            return (
              <div style={{display:"grid", gridTemplateColumns:"1.6fr 0.7fr 0.8fr 0.9fr 1fr 1fr", gap:6, fontSize:11.5, padding:"10px 8px", borderTop:`2px solid ${T.slate300}`, alignItems:"center", fontWeight:800, color:T.navy, background:T.slate50}}>
                <div>TEAM TOTAL</div>
                <div style={{textAlign:"right"}}>{m.target.toFixed(0)}</div>
                <div style={{textAlign:"right"}}>{m.actual.toFixed(0)}</div>
                <div style={{textAlign:"right", color:T.slate500}}>{phase==="pre" ? "—" : m.expectedToDate.toFixed(0)}</div>
                <div>
                  <div style={{display:"flex", alignItems:"center", gap:6}}>
                    <div style={{flex:1, height:8, background:T.slate100, borderRadius:4, overflow:"hidden"}}>
                      <div style={{width:`${barPct}%`, height:"100%", background:barColor, transition:"width 300ms"}}/>
                    </div>
                    <span style={{fontSize:11, color:T.navy, minWidth:36, textAlign:"right", fontWeight:800}}>{fmtPct(m.pctOfTarget)}</span>
                  </div>
                </div>
                <div style={{textAlign:"right", color:paceColor}}>{paceText}</div>
              </div>
            );
          })()}

          {/* Footer legend */}
          <div style={{padding:"10px 8px 0", fontSize:10, color:T.slate500, display:"flex", justifyContent:"space-between"}}>
            <span>
              {phase === "pre"
                ? `Q3 daily team target: ~19.5 pivots/day`
                : phase === "live"
                  ? `Expected = target × (days elapsed / ${q3TotalWorkingDays})`
                  : "Q3 closed — final results"}
            </span>
            <span style={{fontStyle:"italic"}}>
              {phase === "live" && "▲ ahead of pace · ▼ behind"}
              {phase === "pre" && "Targets from goals table · live tracking July 1"}
            </span>
          </div>
        </>
      )}
    </>
  );

  if (unifiedMode) return innerContent;

  return (
    <Card>
      <SectionTitle
        icon="🎯"
        title="Q3 2026 Progress — FS Pivot Targets"
        action={<button onClick={() => onNavigate("tasksgoals")} style={{fontSize:11,color:T.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600}}>Goals →</button>}
      />
      {/* Phase banner */}
      <div style={{padding:"8px 10px", background:bannerBg, borderLeft:`3px solid ${bannerColor}`, borderRadius:3, marginBottom:10, fontSize:11, fontWeight:600, color:bannerColor}}>
        {bannerText}
      </div>
      {innerContent}
    </Card>
  );
};

// ── Main Dashboard Component ───────────────────────────────────
// ── Widget: Q3 2026 Retention Progress ────────────────────────
// Mirror of Q3ProgressWidget pattern but for the retention goals
// added 2026-06-17. Shows team touches vs target, AMUTL commission
// outcome, and per-producer touch progress.
const Q3RetentionWidget = ({ data, onNavigate, unifiedMode = false }) => {
  const r = data?.q3Retention || null;
  if (!r) return null;
  const teamTarget = r.teamTarget || 325;
  const teamPct = teamTarget > 0 ? Math.round((r.teamTouches / teamTarget) * 100) : 0;
  const commPct = r.amutlCommissionTarget > 0 ? Math.round((r.amutlCommissionQ3 / r.amutlCommissionTarget) * 100) : 0;
  const fmtMoney = v => `$${Math.round(v).toLocaleString()}`;
  const color = (p) => p >= 80 ? T.green : p >= 40 ? T.amber : T.red;

  const producerRows = Object.entries(r.byProducer || {})
    .map(([name, p]) => ({
      name, ...p,
      target: r.perProducerTargets?.[name] || null,
    }))
    .sort((a,b) => b.touches - a.touches);

  const innerContent = (
    <>
      {!unifiedMode && (
        <div style={{fontSize:10, color:T.slate500, marginBottom:14}}>
          AMUTL retention touches + commission outcome · Jul 1 – Sep 30, 2026
          {r.isPreQ3 ? <span style={{color:T.amber, fontWeight:600, marginLeft:6}}>· Pre-Q3 build window</span> : null}
        </div>
      )}

      {/* Team touches headline */}
      <div style={{padding:"10px 12px", borderRadius:8, border:`1px solid ${T.slate200}`, background:T.slate50, marginBottom:10}}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:4}}>
          <div style={{fontSize:11, fontWeight:600, color:T.slate600}}>Team Renewal Touches</div>
          <div style={{fontSize:12, fontWeight:700, color:T.slate900}}>{r.teamTouches} / {teamTarget}</div>
        </div>
        <ProgressBar value={r.teamTouches} max={teamTarget} color={color(teamPct)} height={6} />
        <div style={{fontSize:10, color:T.slate500, marginTop:4, display:"flex", justifyContent:"space-between"}}>
          <span>{teamPct}% of Q3 target</span>
          <span>
            <span style={{color:T.green}}>+{r.teamRetained} retained</span>
            {r.teamLost > 0 ? <span style={{color:T.red, marginLeft:6}}>-{r.teamLost} lost</span> : null}
          </span>
        </div>
      </div>

      {/* AMUTL commission outcome */}
      <div style={{padding:"10px 12px", borderRadius:8, border:`1px solid ${color(commPct)}30`, background:`${color(commPct)}08`, marginBottom:14}}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:4}}>
          <div style={{fontSize:11, fontWeight:600, color:T.slate600}}>AMUTL Renewal Commission Q3 (outcome)</div>
          <div style={{fontSize:12, fontWeight:700, color:T.slate900}}>{fmtMoney(r.amutlCommissionQ3)} / {fmtMoney(r.amutlCommissionTarget)}</div>
        </div>
        <ProgressBar value={r.amutlCommissionQ3} max={r.amutlCommissionTarget} color={color(commPct)} height={6} />
        <div style={{fontSize:10, color:T.slate500, marginTop:4}}>
          {commPct}% of $90K stabilization target · 2025 Q3 actual: $89,742
        </div>
      </div>

      {/* Per-producer touch progress */}
      {producerRows.length > 0 ? (
        <div>
          <div style={{fontSize:10, fontWeight:700, color:T.slate500, marginBottom:6, textTransform:"uppercase", letterSpacing:0.4}}>Per-producer Q3 touches</div>
          <div style={{display:"flex", flexDirection:"column", gap:6}}>
            {producerRows.map(p => {
              const tgt = p.target;
              const pct = tgt ? Math.round((p.touches / tgt) * 100) : null;
              return (
                <div key={p.name} style={{display:"grid", gridTemplateColumns:"1.5fr 0.7fr 1.5fr 0.8fr", gap:8, fontSize:11, alignItems:"center"}}>
                  <div style={{color:T.slate700, fontWeight:500}}>{p.name}</div>
                  <div style={{textAlign:"right", color:T.slate900, fontWeight:600}}>
                    {p.touches}{tgt ? <span style={{color:T.slate400, fontWeight:400}}> / {tgt}</span> : null}
                  </div>
                  <div>
                    {tgt ? <ProgressBar value={p.touches} max={tgt} color={color(pct)} height={4} /> : <span style={{fontSize:9, color:T.slate400, fontStyle:"italic"}}>no individual target</span>}
                  </div>
                  <div style={{textAlign:"right", fontSize:10, color:T.slate500}}>
                    {p.retained > 0 && <span style={{color:T.green}}>+{p.retained}</span>}
                    {p.lost > 0 && <span style={{color:T.red, marginLeft:4}}>-{p.lost}</span>}
                    {p.retained === 0 && p.lost === 0 && <span style={{color:T.slate400}}>—</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div style={{padding:"12px 14px", background:T.slate50, borderRadius:8, fontSize:11, color:T.slate600, borderLeft:`3px solid ${T.amber}`}}>
          No retention touches logged yet for Q3. Program kicks off Monday — Patti owns the workflow. Once daily activity logging includes renewal_touches, this view populates.
        </div>
      )}
    </>
  );

  if (unifiedMode) return innerContent;

  return (
    <Card>
      <SectionTitle
        icon="🔄"
        title="Q3 2026 Retention Progress"
        action={<button onClick={()=>onNavigate("financials")} style={{fontSize:11, color:T.blue, background:"none", border:"none", cursor:"pointer", fontWeight:600}}>View Comp →</button>}
      />
      {innerContent}
    </Card>
  );
};


// ── Widget: Q3 2026 Unified Strategic Progress ──────────────────────
// Single-Card unified view combining FS Pivot offense and Retention defense.
// One phase banner, two clearly labeled sub-sections (Offense / Defense).
// Built 2026-06-24 to consolidate the dashboard's two Q3 widgets per the
// Q3 ScoreBoard L&H Multiplier strategic memo cadence.
const Q3UnifiedWidget = ({ data, onNavigate }) => {
  const phase = data?.q3Phase || "pre";
  const daysUntilQ3 = data?.q3DaysUntil || 0;
  const daysIntoQ3 = data?.q3DaysInto || 0;
  const q3TotalWorkingDays = 65;
  const daysRemaining = Math.max(0, q3TotalWorkingDays - daysIntoQ3);
  const hasRetention = !!data?.q3Retention;
  const hasProgress = Array.isArray(data?.q3Rows) && data.q3Rows.length > 0;

  const bannerBg = phase === "pre" ? `${T.blue}10` : phase === "live" ? `${T.green}10` : `${T.slate200}`;
  const bannerColor = phase === "pre" ? T.blue : phase === "live" ? T.green : T.slate500;
  const bannerText = phase === "pre"
    ? `Q3 2026 starts in ${daysUntilQ3} day${daysUntilQ3 === 1 ? "" : "s"} — both pillars go live July 1`
    : phase === "live"
      ? `Day ${daysIntoQ3} of ${q3TotalWorkingDays} working days — ${daysRemaining} remaining`
      : `Q3 2026 closed — archive view`;

  const sectionHeader = (label, sub, color) => (
    <div style={{margin:"14px 0 8px", display:"flex", alignItems:"baseline", justifyContent:"space-between"}}>
      <div style={{display:"flex", alignItems:"baseline", gap:8}}>
        <span style={{fontSize:11, fontWeight:800, color:color, textTransform:"uppercase", letterSpacing:0.6}}>{label}</span>
        <span style={{fontSize:10, color:T.slate500}}>{sub}</span>
      </div>
    </div>
  );

  return (
    <Card>
      <SectionTitle
        icon="🎯"
        title="Q3 2026 Strategic Progress"
        action={
          <div style={{display:"flex", gap:10}}>
            <button onClick={() => onNavigate("tasksgoals")} style={{fontSize:11, color:T.blue, background:"none", border:"none", cursor:"pointer", fontWeight:600}}>Goals →</button>
            <button onClick={() => onNavigate("financials")} style={{fontSize:11, color:T.blue, background:"none", border:"none", cursor:"pointer", fontWeight:600}}>Comp →</button>
          </div>
        }
      />

      {/* Single unified phase banner */}
      <div style={{padding:"8px 10px", background:bannerBg, borderLeft:`3px solid ${bannerColor}`, borderRadius:3, marginBottom:6, fontSize:11, fontWeight:600, color:bannerColor}}>
        {bannerText}
      </div>

      {/* Sub-section: Pivots (Offense) */}
      {sectionHeader("Pivots — Offense", "FS Pivot targets · L&H multiplier driver", T.blue)}
      {hasProgress
        ? <Q3ProgressWidget data={data} onNavigate={onNavigate} unifiedMode={true} />
        : <EmptyRow message="No Q3 FS Pivot goals found." />
      }

      {/* Visual divider */}
      <div style={{height:1, background:T.slate200, margin:"16px 0 4px"}} />

      {/* Sub-section: Retention (Defense) */}
      {sectionHeader("Retention — Defense", "AMUTL touches + commission outcome · Jul 1 – Sep 30, 2026", T.amber)}
      {hasRetention
        ? <Q3RetentionWidget data={data} onNavigate={onNavigate} unifiedMode={true} />
        : <div style={{padding:"12px 14px", background:T.slate50, borderRadius:8, fontSize:11, color:T.slate600, borderLeft:`3px solid ${T.amber}`}}>
            Retention data not loaded yet for Q3.
          </div>
      }
    </Card>
  );
};

// ─── Setup Wizard + Modules Filling (added 2026-07-23 per Kim Parks reference dashboard) ───

const SetupWizardWidget = ({ data, onNavigate }) => {
  const steps = [
    {
      id: "benefits",
      title: "Add your benefit plans",
      hint: "Medical, dental, 401k — anything you offer. Powers the Benefits module.",
      done: (data.benefitPlansCount || 0) > 0,
      cta: "Open Benefits",
      target: "benefits",
    },
    {
      id: "licenses",
      title: "Enter producer license details",
      hint: "State license number + expiration per staff. Unblocks License Expirations report.",
      done: (data.producerLicensesCount || 0) > 0,
      cta: "Open Licenses",
      target: "licenses",
    },
    {
      id: "emergency",
      title: "Collect emergency contacts",
      hint: "One contact per staff member. HR requirement.",
      done: (data.emergencyContactsCount || 0) > 0,
      cta: "Open Emergency Contacts",
      target: "emergency_contacts",
    },
    {
      id: "producer_report",
      title: "Forward SF Producer Production report",
      hint: `Forward the monthly SF producer production email to ${data.serviceMailbox || "your BCC service mailbox"}. Unblocks Performance tab + Producer Production report.`,
      done: (data.producerProductionDocsCount || 0) > 0,
      cta: "Open Documents",
      target: "documents",
    },
    {
      id: "comp_rates",
      title: "Confirm 2026 comp plan rates",
      hint: "Some rows have NULL rate. Set them from HR & People → Comp Plans.",
      done: (data.commissionStructuresCount || 0) > 0,
      cta: "Open HR & People",
      target: "hr",
    },
  ];
  const doneCount = steps.filter(s => s.done).length;
  const pct = Math.round((doneCount / steps.length) * 100);

  if (doneCount === steps.length) return null;

  return (
    <Card>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12}}>
        <div>
          <SectionTitle icon="🎯" title="First-Week Setup" />
          <div style={{fontSize:13, color:T.slate500, marginTop:2}}>
            Complete these 5 items to unlock full BCC. Everything else fills in automatically.
          </div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:24, fontWeight:800, color:T.navy}}>{doneCount} / {steps.length}</div>
          <div style={{fontSize:11, color:T.slate500}}>{pct}% done</div>
        </div>
      </div>
      <ProgressBar value={pct} />
      <div style={{display:"flex", flexDirection:"column", gap:10, marginTop:16}}>
        {steps.map(s => (
          <div key={s.id} style={{
            display:"flex", justifyContent:"space-between", alignItems:"center",
            padding:"12px 14px", borderRadius:8,
            border:`1px solid ${s.done ? T.green : T.slate200}`,
            background: s.done ? T.greenLt : "#fff",
          }}>
            <div style={{display:"flex", alignItems:"center", gap:12, flex:1}}>
              <div style={{
                width:22, height:22, borderRadius:"50%",
                border:`2px solid ${s.done ? T.green : T.slate300}`,
                background: s.done ? T.green : "transparent",
                display:"flex", alignItems:"center", justifyContent:"center",
                flexShrink:0,
              }}>
                {s.done && <span style={{color:"#fff", fontSize:14, fontWeight:700}}>✓</span>}
              </div>
              <div>
                <div style={{fontSize:14, fontWeight:600, color: s.done ? T.slate500 : T.navy, textDecoration: s.done ? "line-through" : "none"}}>
                  {s.title}
                </div>
                <div style={{fontSize:12, color:T.slate500, marginTop:2}}>{s.hint}</div>
              </div>
            </div>
            {!s.done && (
              <button
                onClick={() => onNavigate(s.target)}
                style={{
                  padding:"8px 14px", borderRadius:6,
                  background:T.blue, color:"#fff", border:"none",
                  fontSize:13, fontWeight:600, cursor:"pointer",
                  whiteSpace:"nowrap", marginLeft:12,
                }}
              >
                {s.cta} →
              </button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
};

const ModulesFillingWidget = ({ data, onNavigate }) => {
  const modules = [
    { key:"time_tracking",  label:"Time Tracking",       target:"time_tracking",   count: data.timeTrackingCount    || 0, hint:"Fills as your team clocks in from Time Tracking." },
    { key:"sales_activity", label:"Sales Activity",      target:"sales_activity",  count: data.salesActivityCount   || 0, hint:"Fills as staff log quotes, calls, and follow-ups." },
    { key:"coaching",       label:"Coaching Notes",      target:"hr",              count: data.staffPerformanceCount|| 0, hint:"Fills as you log 1:1s in HR & People → Performance." },
    { key:"compliance_log", label:"Compliance Log",      target:"compliance",      count: data.complianceLogCount   || 0, hint:"Fills on your first compliance review." },
    { key:"personnel_docs", label:"Personnel Documents", target:"personnel_files", count: data.personnelDocsCount   || 0, hint:"Fills as you upload employee forms from Personnel Files." },
  ];
  return (
    <Card>
      <SectionTitle icon="🌱" title="Modules Filling Up Naturally" />
      <div style={{fontSize:13, color:T.slate500, marginBottom:14}}>
        These modules are empty for a reason — they populate on their own as you and your team use the system. No action needed unless you want to jump in.
      </div>
      <div style={{display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:12}}>
        {modules.map(m => (
          <div key={m.key} style={{
            padding:14, borderRadius:8, border:`1px solid ${T.slate200}`, background:"#fff",
            display:"flex", flexDirection:"column", justifyContent:"space-between", minHeight:120,
          }}>
            <div>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6}}>
                <div style={{fontSize:14, fontWeight:700, color:T.navy}}>{m.label}</div>
                <div style={{fontSize:11, color:T.slate500}}>{m.count} rows</div>
              </div>
              <div style={{fontSize:12, color:T.slate500, lineHeight:1.4}}>{m.hint}</div>
            </div>
            <button
              onClick={() => onNavigate(m.target)}
              style={{
                marginTop:10, padding:"6px 0", borderRadius:6,
                background:"transparent", color:T.blue, border:"none",
                fontSize:12, fontWeight:600, cursor:"pointer", textAlign:"left",
              }}
            >
              Open module →
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
};

export default function Dashboard({ onNavigate = () => {} }) {
  const [dashData, setDashData] = useState({});
  const [loading, setLoading] = useState(true);
  const [agencyName, setAgencyName] = useState("Your Agency");
  const [greeting, setGreeting] = useState("Good morning");
  const [inboxEmails, setInboxEmails] = useState({ loading: true, messages: [], error: null });

  const fetchInboxEmails = async () => {
    setInboxEmails(s => ({ ...s, loading: true, error: null }));
    try {
      const { data, error } = await supabase.functions.invoke(
        "dashboard-emails-needing-attention",
        { body: { agency_id: AGENCY_ID, limit: 8 } }
      );
      if (error) throw error;
      if (data && data.ok === false) throw new Error(data.error || "fetch failed");
      setInboxEmails({
        loading: false,
        messages: Array.isArray(data?.messages) ? data.messages : [],
        fetched_at: data?.fetched_at || null,
        error: null,
      });
    } catch (err) {
      setInboxEmails({ loading: false, messages: [], error: err?.message || String(err) });
    }
  };

  useEffect(() => { fetchInboxEmails(); }, []);

  const [calendarEvents, setCalendarEvents] = useState({ loading: true, items: [], error: null });
  const fetchCalendarEvents = async () => {
    setCalendarEvents(s => ({ ...s, loading: true, error: null }));
    try {
      const { data, error } = await supabase.functions.invoke(
        "dashboard-calendar-events",
        { body: { agency_id: AGENCY_ID, limit: 10, days_ahead: 7 } }
      );
      if (error) throw error;
      if (data && data.ok === false) throw new Error(data.error || "fetch failed");
      setCalendarEvents({
        loading: false,
        items: Array.isArray(data?.events) ? data.events : [],
        fetched_at: data?.fetched_at || null,
        error: null,
      });
    } catch (err) {
      setCalendarEvents({ loading: false, items: [], error: err?.message || String(err) });
    }
  };
  useEffect(() => { fetchCalendarEvents(); }, []);

  useEffect(() => {
    const hr = new Date().getHours();
    setGreeting(hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening");
  }, []);

  useEffect(() => {
    async function loadDashboard() {
      setLoading(true);
      try {
        // Parallel fetch all dashboard data
        const [
          agencyRes, summaryRes, aippRes, tasksRes,
          alertsRes, memoryRes, complianceRes, closeRes, closeChecklistRes,
          producerActivityRes, aippEligRes, q3GoalsRes, q3ActivityRes
        ] = await Promise.allSettled([
          supabase.from("agency").select("*").limit(1).single(),
          Promise.resolve({ data: null }), // removed — no comp_recap_data  table
          //Promise.resolve({ data: null }), // comp_recap_data  removed — no such table in schema
          supabase.from("aipp_tracking").select("*").order("program_year",{ascending:false}).limit(1).single(),
          supabase.from("tasks").select("*").eq("status","open").order("priority").limit(20),
          supabase.from("alerts").select("*").eq("is_resolved",false).order("created_at",{ascending:false}).limit(10),
          supabase.from("persistent_memory").select("*").eq("is_active",true).order("updated_at",{ascending:false}).limit(10),
          supabase.from("compliance_rules").select("id,title,severity,is_active").limit(100),
          supabase.from("documents").select("*").order("created_at",{ascending:false}).limit(20),
          supabase.from("monthly_close_checklist").select("*").order("period_year",{ascending:false}).order("period_month",{ascending:false}).limit(60),
          supabase.from("producer_activity_daily")
            .select("producer_name,activity_date,hours,written_sales,issued_sales,outbound_calls,auto_quotes,fs_pivots,inbound_calls,renewal_touches,renewals_retained,renewals_lost")
            .gte("activity_date", new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10))
            .order("activity_date",{ascending:false}),
          supabase.from("comp_recap")
            .select("period_year,period_month,comp_category,amount")
            .eq("is_aipp_eligible", true)
            .gte("period_year", new Date().getFullYear() - 1)
            .order("period_year",{ascending:false}),
          supabase.from("goals")
            .select("id,title,target_value,current_value,unit,target_date,status")
            .eq("status","active")
            .like("title","Q3 2026 %"),
          // Q3 producer_activity_daily — for live progress tracking once Q3 starts
          supabase.from("producer_activity_daily")
            .select("producer_name,activity_date,fs_pivots,renewal_touches,renewals_retained,renewals_lost")
            .gte("activity_date","2026-07-01")
            .lte("activity_date","2026-09-30"),
        ]);

        // ── Setup Wizard + Modules Filling counts (added 2026-07-23) ──
        const [
          benefitsRes, licensesRes, emergencyRes, commissionsRes, producerDocsRes,
          timeTrackingRes, salesActivityRes, staffPerfRes, complianceLogRes, personnelDocsRes,
          serviceMailboxRes,
        ] = await Promise.allSettled([
          supabase.from("benefit_plans").select("id", { count: "exact", head: true }),
          supabase.from("producer_licenses").select("id", { count: "exact", head: true }),
          supabase.from("emergency_contacts").select("id", { count: "exact", head: true }),
          supabase.from("commission_structures").select("id", { count: "exact", head: true }),
          supabase.from("documents").select("id", { count: "exact", head: true }).ilike("file_name", "%producer%"),
          supabase.from("time_tracking").select("id", { count: "exact", head: true }),
          supabase.from("sales_activity").select("id", { count: "exact", head: true }),
          supabase.from("staff_performance").select("id", { count: "exact", head: true }),
          supabase.from("compliance_log").select("id", { count: "exact", head: true }),
          supabase.from("personnel_documents").select("id", { count: "exact", head: true }),
          supabase.from("settings").select("setting_value").eq("setting_key","service_mailbox").maybeSingle(),
        ]);

        const agency = agencyRes.status==="fulfilled" ? agencyRes.value.data : null;
        if (agency?.name) setAgencyName(agency.name);

        // Build comp_recap summary from view
        const { data: compData } = await supabase.from("comp_recap").select("*").order("period_year",{ascending:false}).order("period_month",{ascending:false}).limit(20);
        const latestComp = (compData||[])[0] || {};

        // Build YTD P&L summary from cpa_pnl_monthly (authoritative) + comp_recap.
        // v_income_statement intentionally NOT used — its journal_entries source
        // only contains post-cutover (May 2026 onward) live system data.
        const now = new Date();
        const curYear  = now.getFullYear();
        const curMonth = now.getMonth() + 1;
        const priorYr  = curYear - 1;
        const priorEndMonth = Math.max(1, curMonth - 1);
        const sum = rows => rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);

        const [pnlCurRes2, pnlPriorRes2, renewalRes] = await Promise.all([
          supabase.from("cpa_pnl_monthly")
            .select("section,account_name,period_year,period_month,amount,is_subtotal,notes")
            .eq("agency_id", AGENCY_ID)
            .eq("period_year", curYear)
            .eq("is_subtotal", false),
          supabase.from("cpa_pnl_monthly")
            .select("section,account_name,period_year,period_month,amount,is_subtotal")
            .eq("agency_id", AGENCY_ID)
            .eq("period_year", priorYr)
            .eq("is_subtotal", false),
          supabase.from("comp_recap")
            .select("period_year,period_month,comp_category,amount,comp_type")
            .eq("agency_id", AGENCY_ID)
            .eq("comp_type", "smvc_renewal")
            .gte("period_year", priorYr),
        ]);

        const pnlCur   = pnlCurRes2.data   || [];
        const pnlPrior = pnlPriorRes2.data || [];

        // Current year cpa_pnl_monthly is at period_month=13 (YTD); prior year is monthly 1..12
        const curIsYTD = pnlCur.some(r => r.period_month === 13);
        const curIncomeRows  = curIsYTD ? pnlCur.filter(r => r.period_month === 13 && r.section === "Income")
                                        : pnlCur.filter(r => r.section === "Income" && r.period_month <= curMonth);
        const curExpenseRows = curIsYTD ? pnlCur.filter(r => r.period_month === 13 && r.section === "Expenses")
                                        : pnlCur.filter(r => r.section === "Expenses" && r.period_month <= curMonth);
        const revenueYTD  = sum(curIncomeRows);
        const expensesYTD = sum(curExpenseRows);
        const netYTD      = revenueYTD - expensesYTD;

        const priorRevSame = sum(pnlPrior.filter(r => r.section === "Income"   && r.period_month >= 1 && r.period_month <= priorEndMonth));
        const priorExpSame = sum(pnlPrior.filter(r => r.section === "Expenses" && r.period_month >= 1 && r.period_month <= priorEndMonth));
        const priorNetSame = priorRevSame - priorExpSame;
        const yoyRevPct = priorRevSame > 0 ? ((revenueYTD - priorRevSame) / priorRevSame) * 100 : null;
        const yoyNetPct = priorNetSame !== 0 ? ((netYTD - priorNetSame) / Math.abs(priorNetSame)) * 100 : null;

        const payrollAccts = ["Payroll - Employee Wages","Payroll Taxes","Payroll Expenses","Officer Salary"];
        const payrollYTD = sum(curExpenseRows.filter(r => payrollAccts.includes(r.account_name)));
        const payrollRatioYTD = revenueYTD > 0 ? (payrollYTD / revenueYTD) * 100 : null;
        const expenseRatioYTD = revenueYTD > 0 ? (expensesYTD / revenueYTD) * 100 : null;
        const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        const asOfLabel = pnlCur.find(r => r.notes)?.notes || `Jan 1 – ${monthNames[curMonth-1]} ${now.getDate()}, ${curYear}`;

        // ── Build retention picture from comp_recap renewal rows ──
        const renewalRows = renewalRes.data || [];
        const lobs = ["auto_mutual","fire","florida_auto","life"];
        const renewalByYM = {};
        for (const r of renewalRows) {
          const k = `${r.period_year}-${r.period_month}-${r.comp_category}`;
          renewalByYM[k] = (renewalByYM[k] || 0) + parseFloat(r.amount || 0);
        }
        const rGet = (y, m, lob) => renewalByYM[`${y}-${m}-${lob}`] || 0;
        const rMonthTotal = (y, m) => lobs.reduce((s, lob) => s + rGet(y, m, lob), 0);

        // Detect most-recent month with renewal data; end the 12-month series there
        // so we don't show a $0 bar for the in-progress current month.
        let lastClosedY = curYear, lastClosedM = curMonth - 1;
        if (lastClosedM < 1) { lastClosedM = 12; lastClosedY = curYear - 1; }
        // If even the (curMonth-1) row is empty (e.g. comp recap not yet processed),
        // walk back until we find a month with data.
        for (let k = 0; k < 6; k++) {
          if (rMonthTotal(lastClosedY, lastClosedM) > 0) break;
          lastClosedM -= 1;
          if (lastClosedM < 1) { lastClosedM = 12; lastClosedY -= 1; }
        }

        const monthlyRenewal = [];
        const baseRef = new Date(lastClosedY, lastClosedM - 1, 1);
        for (let i = 11; i >= 0; i--) {
          const d = new Date(baseRef.getFullYear(), baseRef.getMonth() - i, 1);
          const y = d.getFullYear(), m = d.getMonth() + 1;
          const total = rMonthTotal(y, m);
          const priorTotal = rMonthTotal(y - 1, m);
          monthlyRenewal.push({
            year: y, month: m, label: `${monthNames[m-1]} ${String(y).slice(2)}`,
            total: Math.round(total),
            amutl:   Math.round(rGet(y, m, "auto_mutual")),
            fire:    Math.round(rGet(y, m, "fire")),
            fl_auto: Math.round(rGet(y, m, "florida_auto")),
            life:    Math.round(rGet(y, m, "life")),
            prior_total: Math.round(priorTotal),
            yoy_pct: priorTotal > 0 ? ((total - priorTotal) / priorTotal) * 100 : null,
          });
        }

        // Use lastClosedM as the YTD cutoff for renewal — gives an honest like-for-like comparison.
        const renewalCutoffM = (lastClosedY === curYear) ? lastClosedM : priorEndMonth;
        const renewalYTD = { total:0, amutl:0, fire:0, fl_auto:0, life:0,
                             priorTotal:0, prior_amutl:0, prior_fire:0, prior_fl_auto:0, prior_life:0 };
        for (let m = 1; m <= renewalCutoffM; m++) {
          renewalYTD.amutl       += rGet(curYear, m, "auto_mutual");
          renewalYTD.fire        += rGet(curYear, m, "fire");
          renewalYTD.fl_auto     += rGet(curYear, m, "florida_auto");
          renewalYTD.life        += rGet(curYear, m, "life");
          renewalYTD.prior_amutl += rGet(priorYr, m, "auto_mutual");
          renewalYTD.prior_fire  += rGet(priorYr, m, "fire");
          renewalYTD.prior_fl_auto += rGet(priorYr, m, "florida_auto");
          renewalYTD.prior_life    += rGet(priorYr, m, "life");
        }
        renewalYTD.total      = renewalYTD.amutl + renewalYTD.fire + renewalYTD.fl_auto + renewalYTD.life;
        renewalYTD.priorTotal = renewalYTD.prior_amutl + renewalYTD.prior_fire + renewalYTD.prior_fl_auto + renewalYTD.prior_life;
        Object.keys(renewalYTD).forEach(k => { renewalYTD[k] = Math.round(renewalYTD[k]); });
        const renewalYoYPct = renewalYTD.priorTotal > 0
          ? ((renewalYTD.total - renewalYTD.priorTotal) / renewalYTD.priorTotal) * 100
          : null;

        const lastMonth = monthlyRenewal[monthlyRenewal.length - 1] || null;

        // Aggregate producer_activity_daily into per-producer scoreboard (last 7 days)
        const paDaily = producerActivityRes?.status === "fulfilled" ? (producerActivityRes.value?.data || []) : [];
        const byProducer = {};
        let earliestDate = null, latestDate = null;
        for (const r of paDaily) {
          if (!earliestDate || r.activity_date < earliestDate) earliestDate = r.activity_date;
          if (!latestDate   || r.activity_date > latestDate)   latestDate   = r.activity_date;
          const k = r.producer_name || "Unknown";
          if (!byProducer[k]) byProducer[k] = { producer_name:k, hours:0, written:0, issued:0, outbound:0, auto_quotes:0, fs_pivots:0, inbound:0, renewal_touches:0, renewals_retained:0, renewals_lost:0 };
          const acc = byProducer[k];
          acc.hours              += parseFloat(r.hours) || 0;
          acc.written            += parseInt(r.written_sales) || 0;
          acc.issued             += parseInt(r.issued_sales) || 0;
          acc.outbound           += parseInt(r.outbound_calls) || 0;
          acc.auto_quotes        += parseInt(r.auto_quotes) || 0;
          acc.fs_pivots          += parseInt(r.fs_pivots) || 0;
          acc.inbound            += parseInt(r.inbound_calls) || 0;
          acc.renewal_touches    += parseInt(r.renewal_touches) || 0;
          acc.renewals_retained  += parseInt(r.renewals_retained) || 0;
          acc.renewals_lost      += parseInt(r.renewals_lost) || 0;
        }
        const scoreboardRows = Object.values(byProducer).sort((a,b) =>
          (b.issued - a.issued) || (b.written - a.written) || (b.outbound - a.outbound) || a.producer_name.localeCompare(b.producer_name)
        );
        const scoreboardTotals = scoreboardRows.reduce((t,r) => ({
          hours: t.hours + r.hours, written: t.written + r.written, issued: t.issued + r.issued,
          outbound: t.outbound + r.outbound, auto_quotes: t.auto_quotes + r.auto_quotes, fs_pivots: t.fs_pivots + r.fs_pivots, inbound: t.inbound + r.inbound,
          renewal_touches: t.renewal_touches + r.renewal_touches, renewals_retained: t.renewals_retained + r.renewals_retained, renewals_lost: t.renewals_lost + r.renewals_lost,
        }), {hours:0, written:0, issued:0, outbound:0, auto_quotes:0, fs_pivots:0, inbound:0, renewal_touches:0, renewals_retained:0, renewals_lost:0});
        const uniqueDays = new Set(paDaily.map(r => r.activity_date)).size;

        // ── Q3 2026 progress: join goals + producer_activity_daily (Q3 dates only) ──
        const q3Goals = q3GoalsRes?.status==="fulfilled" ? (q3GoalsRes.value?.data || []) : [];
        const q3Activity = q3ActivityRes?.status==="fulfilled" ? (q3ActivityRes.value?.data || []) : [];

        // Sum fs_pivots per producer for Q3 to date
        const q3PivotsByProducer = {};
        let q3TeamPivots = 0;
        for (const r of q3Activity) {
          const k = r.producer_name || "Unknown";
          const v = parseInt(r.fs_pivots) || 0;
          q3PivotsByProducer[k] = (q3PivotsByProducer[k] || 0) + v;
          q3TeamPivots += v;
        }

        // Phase detection
        const Q3_START = new Date("2026-07-01T00:00:00Z");
        const Q3_END   = new Date("2026-09-30T23:59:59Z");
        const nowTs = new Date();
        const msPerDay = 24*60*60*1000;

        // ── Current week retention (Mon-Sun) ──
        const weekStart = new Date(nowTs);
        const dow = (weekStart.getDay() + 6) % 7;  // make Mon=0
        weekStart.setDate(weekStart.getDate() - dow);
        weekStart.setHours(0,0,0,0);
        const weekStartIso = weekStart.toISOString().slice(0,10);
        const weekStartLabel = weekStart.toLocaleDateString("en-US",{month:"short",day:"numeric"});

        const { data: weekPa } = await supabase
          .from("producer_activity_daily")
          .select("renewal_touches,renewals_retained,renewals_lost")
          .eq("agency_id", AGENCY_ID)
          .gte("activity_date", weekStartIso);
        const weekTouches  = (weekPa || []).reduce((s,r) => s + (parseInt(r?.renewal_touches) || 0), 0);
        const weekRetained = (weekPa || []).reduce((s,r) => s + (parseInt(r?.renewals_retained) || 0), 0);
        const weekLost     = (weekPa || []).reduce((s,r) => s + (parseInt(r?.renewals_lost) || 0), 0);

        // ── Q3 retention sums for the Q3 progress widget ──
        const q3PA = q3Activity || [];  // already fetched above with renewal_touches now
        const q3RenewalByProducer = {};
        let q3RenewalTeamTouches = 0, q3RenewalTeamRetained = 0, q3RenewalTeamLost = 0;
        for (const r of q3PA) {
          const k = r.producer_name || "Unknown";
          const t = parseInt(r.renewal_touches) || 0;
          const ret = parseInt(r.renewals_retained) || 0;
          const lst = parseInt(r.renewals_lost) || 0;
          if (!q3RenewalByProducer[k]) q3RenewalByProducer[k] = { touches:0, retained:0, lost:0 };
          q3RenewalByProducer[k].touches += t;
          q3RenewalByProducer[k].retained += ret;
          q3RenewalByProducer[k].lost += lst;
          q3RenewalTeamTouches += t;
          q3RenewalTeamRetained += ret;
          q3RenewalTeamLost += lst;
        }

        // ── Q3 AMUTL renewal commission (Jul-Sep 2026) for the outcome goal ──
        const { data: q3CommData } = await supabase
          .from("comp_recap")
          .select("amount")
          .eq("agency_id", AGENCY_ID)
          .eq("comp_category", "auto_mutual")
          .eq("comp_type", "smvc_renewal")
          .eq("period_year", 2026)
          .gte("period_month", 7)
          .lte("period_month", 9);
        const q3AmutlRenewalCommission = (q3CommData || []).reduce((s,r) => s + parseFloat(r?.amount || 0), 0);
        // Working days helper — count weekdays between two dates inclusive
        const workingDaysBetween = (start, end) => {
          let count = 0;
          const cur = new Date(start);
          while (cur <= end) {
            const d = cur.getUTCDay();
            if (d !== 0 && d !== 6) count++;
            cur.setUTCDate(cur.getUTCDate() + 1);
          }
          return count;
        };

        let q3Phase, q3DaysUntil = 0, q3DaysInto = 0;
        if (nowTs < Q3_START) {
          q3Phase = "pre";
          q3DaysUntil = Math.ceil((Q3_START - nowTs) / msPerDay);
        } else if (nowTs > Q3_END) {
          q3Phase = "post";
          q3DaysInto = workingDaysBetween(Q3_START, Q3_END);
        } else {
          q3Phase = "live";
          q3DaysInto = workingDaysBetween(Q3_START, nowTs);
        }

        // Parse goal title to extract producer name. Pattern:
        //   "Q3 2026 — {NAME} FS Pivot Target"  or  "Q3 2026 — Team FS Pivot Target"
        const parseGoalName = title => {
          const m = (title || "").match(/^Q3 2026 [—-] (.+) FS Pivot Target$/);
          return m ? m[1].trim() : null;
        };

        let q3TeamGoal = null;
        const q3Rows = [];
        for (const g of q3Goals) {
          const name = parseGoalName(g.title);
          if (!name) continue;
          const target = parseFloat(g.target_value) || 0;
          if (name.toLowerCase() === "team") {
            q3TeamGoal = { producer_name: "TEAM", target, actual: q3TeamPivots };
          } else {
            q3Rows.push({
              producer_name: name,
              target,
              actual: q3PivotsByProducer[name] || 0,
            });
          }
        }
        // Sort by target desc (puts top-targeted producers first)
        q3Rows.sort((a, b) => b.target - a.target);

        setDashData({
          agency,
          summary: {
            revenueYTD:       Math.round(revenueYTD),
            expensesYTD:      Math.round(expensesYTD),
            netYTD:           Math.round(netYTD),
            yoyRevenuePct:    yoyRevPct,
            yoyNetPct:        yoyNetPct,
            payrollRatioYTD,
            expenseRatioYTD,
            payrollYTD:       Math.round(payrollYTD),
            priorRevSame:     Math.round(priorRevSame),
            priorNetSame:     Math.round(priorNetSame),
            asOfLabel,
            priorEndMonth,
          },
          retention: {
            ytdLabel:      asOfLabel,
            priorYtdLabel: `Jan – ${monthNames[priorEndMonth-1]} ${priorYr}`,
            ytd:           renewalYTD,
            yoyPct:        renewalYoYPct,
            monthly:       monthlyRenewal,
            lastMonth,
          },
          retentionWeek: {
            startLabel: weekStartLabel,
            touches:    weekTouches,
            retained:   weekRetained,
            lost:       weekLost,
            isPreQ3:    nowTs < Q3_START,
          },
          q3Retention: (() => {
            // Build per-producer targets from goals that match "Q3 2026 — [Name] Renewal Touches"
            const retentionGoals = (q3Goals || []).filter(g => /Renewal Touches/i.test(g.title));
            const perProducerTargets = {};
            let teamTarget = 325;  // fallback
            retentionGoals.forEach(g => {
              if (/Team Renewal Touches/i.test(g.title)) {
                teamTarget = parseFloat(g.target_value) || teamTarget;
              } else {
                // Extract producer name: "Q3 2026 — {Name} Renewal Touches"
                const m = g.title.match(/Q3 2026\s+[—-]\s+(.+?)\s+Renewal Touches/i);
                if (m && m[1]) perProducerTargets[m[1].trim()] = parseFloat(g.target_value) || 0;
              }
            });
            return {
              byProducer:           q3RenewalByProducer,
              teamTouches:          q3RenewalTeamTouches,
              teamRetained:         q3RenewalTeamRetained,
              teamLost:             q3RenewalTeamLost,
              teamTarget,
              perProducerTargets,
              amutlCommissionQ3:    Math.round(q3AmutlRenewalCommission),
              amutlCommissionTarget: 90000,
              isPreQ3:              nowTs < Q3_START,
            };
          })(),
          aipp: (() => {
            const a = aippRes.status==="fulfilled" ? aippRes.value.data : null;
            const elig = aippEligRes?.status==="fulfilled" ? (aippEligRes.value?.data || []) : [];
            const year = a?.program_year || new Date().getFullYear();
            const priorYear = year - 1;
            const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

            // Determine YTD-through month: max period_month in current year for which we have data
            const currentYearMonths = elig.filter(r => r.period_year === year).map(r => r.period_month);
            const ytdMaxMonth = currentYearMonths.length ? Math.max(...currentYearMonths) : (new Date().getMonth() + 1);

            // LoB breakdown — YTD current year vs same-period prior year
            const lobMap = {};
            for (const r of elig) {
              const cat = r.category_normalized = r.comp_category || "unknown";
              if (!lobMap[cat]) lobMap[cat] = { category: cat, ytd_current: 0, ytd_prior: 0 };
              const amt = parseFloat(r.amount) || 0;
              if (r.period_year === year && r.period_month <= ytdMaxMonth) {
                lobMap[cat].ytd_current += amt;
              } else if (r.period_year === priorYear && r.period_month <= ytdMaxMonth) {
                lobMap[cat].ytd_prior += amt;
              }
            }
            const lobBreakdown = Object.values(lobMap)
              .map(o => ({
                ...o,
                yoy_pct: o.ytd_prior > 0 ? ((o.ytd_current - o.ytd_prior) / o.ytd_prior) * 100 : null,
              }))
              .sort((x,y) => y.ytd_current - x.ytd_current);

            // Prior year actual AIPP (for pace comparison) — 5% × ALL prior-year AIPP-eligible
            const priorYearEligTotal = elig
              .filter(r => r.period_year === priorYear)
              .reduce((s,r) => s + (parseFloat(r.amount) || 0), 0);
            const priorYearActual = priorYearEligTotal * 0.05;

            // Placeholder detection: target $50k with notes mentioning "placeholder"
            const targetIsPlaceholder = a?.notes?.toLowerCase?.().includes("placeholder") || false;

            if (!a) {
              return {
                year, priorYear,
                target: 0, earned: 0, projected: 0,
                priorYearActual, lobBreakdown,
                ytdThroughMonth: monthNames[ytdMaxMonth - 1],
                targetIsPlaceholder: true,
              };
            }
            return {
              year,
              priorYear,
              target:           parseFloat(a.target_amount)        || 0,
              earned:           parseFloat(a.earned_ytd)           || 0,
              projected:        parseFloat(a.projected_full_year)  || 0,
              achievement:      parseFloat(a.achievement_percentage) || 0,
              priorYearActual,
              lobBreakdown,
              ytdThroughMonth:  monthNames[ytdMaxMonth - 1],
              targetIsPlaceholder,
              notes:            a.notes || null,
            };
          })(),
          tasks: tasksRes.status==="fulfilled" ? (tasksRes.value.data||[]) : [],
          alerts: alertsRes.status==="fulfilled" ? (alertsRes.value.data||[]) : [],
          openItems: memoryRes.status==="fulfilled" ? (memoryRes.value.data||[]) : [],
          complianceRules: complianceRes.status==="fulfilled" ? (complianceRes.value.data||[]) : [],
          closeDocuments: closeRes.status==="fulfilled" ? (closeRes.value.data||[]) : [],
          closeChecklist: closeChecklistRes.status==="fulfilled" ? (closeChecklistRes.value.data||[]) : [],
          producerScoreboard: scoreboardRows,
          producerScoreboardTotals: scoreboardTotals,
          producerScoreboardDays: uniqueDays,
          producerScoreboardStart: earliestDate,
          producerScoreboardEnd: latestDate,
          q3Rows,
          q3TeamGoal,
          q3Phase,
          q3DaysUntil,
          q3DaysInto,
          // ── Setup Wizard + Modules Filling counts (added 2026-07-23) ──
          benefitPlansCount:          benefitsRes.status       === "fulfilled" ? (benefitsRes.value.count       || 0) : 0,
          producerLicensesCount:      licensesRes.status       === "fulfilled" ? (licensesRes.value.count       || 0) : 0,
          emergencyContactsCount:     emergencyRes.status      === "fulfilled" ? (emergencyRes.value.count      || 0) : 0,
          commissionStructuresCount:  commissionsRes.status    === "fulfilled" ? (commissionsRes.value.count    || 0) : 0,
          producerProductionDocsCount:producerDocsRes.status   === "fulfilled" ? (producerDocsRes.value.count   || 0) : 0,
          timeTrackingCount:          timeTrackingRes.status   === "fulfilled" ? (timeTrackingRes.value.count   || 0) : 0,
          salesActivityCount:         salesActivityRes.status  === "fulfilled" ? (salesActivityRes.value.count  || 0) : 0,
          staffPerformanceCount:      staffPerfRes.status      === "fulfilled" ? (staffPerfRes.value.count      || 0) : 0,
          complianceLogCount:         complianceLogRes.status  === "fulfilled" ? (complianceLogRes.value.count  || 0) : 0,
          personnelDocsCount:         personnelDocsRes.status  === "fulfilled" ? (personnelDocsRes.value.count  || 0) : 0,
          serviceMailbox:             serviceMailboxRes.status === "fulfilled" ? (serviceMailboxRes.value.data?.setting_value || null) : null,
        });
      } catch (err) {
        console.error("Dashboard load error:", err);
      } finally {
        setLoading(false);
      }
    }
    loadDashboard();
  }, []);

  const today = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});

  if (loading) {
    return (
      <div style={{padding:32, display:"flex", flexDirection:"column", alignItems:"center", gap:16}}>
        <div style={{fontSize:32}}>⚡</div>
        <div style={{fontSize:14, color:T.slate500}}>Loading your command center...</div>
      </div>
    );
  }

  return (
    <div style={{padding:"0 0 40px 0"}}>
      {/* Header */}
      <div style={{padding:"20px 0 16px 0", borderBottom:`1px solid ${T.slate200}`, marginBottom:20}}>
        <div style={{fontSize:20, fontWeight:800, color:T.navy}}>{greeting}, {agencyName} 👋</div>
        <div style={{fontSize:12, color:T.slate500, marginTop:4}}>{today}</div>
      </div>

      {/* ═══ Reorganized 2026-07-23 per Kim Parks reference dashboard ═══ */}

      {/* Row 1 — First-Week Setup wizard (auto-hides when all 5 steps done) */}
      <div style={{marginBottom:14}}>
        <SetupWizardWidget data={dashData} onNavigate={onNavigate} />
      </div>

      {/* Row 2 — Financial Overview + AIPP */}
      <div style={{display:"grid", gridTemplateColumns:"1.4fr 1fr", gap:14, marginBottom:14}}>
        <FinancialWidget data={dashData} onNavigate={onNavigate} />
        <AIPPWidget data={dashData} onNavigate={onNavigate} />
      </div>

      {/* Row 3 — Monthly Close + Active Alerts */}
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14}}>
        <MonthlyCloseWidget data={dashData} onNavigate={onNavigate} />
        <AlertsWidget data={dashData} onNavigate={onNavigate} />
      </div>

      {/* Row 4 — High Priority Tasks + Compliance Status */}
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14}}>
        <TasksWidget data={dashData} onNavigate={onNavigate} />
        <ComplianceWidget data={dashData} onNavigate={onNavigate} />
      </div>

      {/* Row 5 — Open Items (full width) */}
      <div style={{marginBottom:14}}>
        <OpenItemsWidget data={dashData} onNavigate={onNavigate} />
      </div>

      {/* Row 6 — Modules Filling Up Naturally (empty-state placeholders) */}
      <div style={{marginBottom:14}}>
        <ModulesFillingWidget data={dashData} onNavigate={onNavigate} />
      </div>
    </div>
  );
}
