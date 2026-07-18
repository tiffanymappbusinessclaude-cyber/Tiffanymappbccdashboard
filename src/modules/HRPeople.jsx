import { useState, useMemo, useEffect, useRef } from "react";
import { supabase, AGENCY_ID } from "../lib/supabase.js";

// ============================================================
// BCC HR & PEOPLE MODULE v1.0
// Business Command Center — State Farm Agent Edition
// Built by Imaginary Farms LLC · imaginary-farms.com
//
// SECTIONS:
//   1. Overview      — Pipeline summary, team snapshot, alerts
//   2. Recruiting    — Kanban pipeline: New→Screen→Interview→Offer→Hired
//   3. Applicants    — Full applicant list with Groq scores
//   4. Onboarding    — Active onboarding checklists per new hire
//   5. Staff         — Current team directory with licensing status
//   6. Performance   — Monthly KPI tracking per staff member
//   7. Commissions   — Commission structures and monthly calculations
//
// KEY AUTOMATION:
//   Resume Scanner (Composio + Groq) auto-creates applicant
//   records from Gmail, scores candidates 1-10, generates
//   One Page Interview Focus — no manual data entry needed.
//
// COMPLIANCE FLAGS:
//   • Staff must be licensed before performing licensed activities
//   • Family employees require year-end W-2 review with CPA
//   • New hires must be notified to SF within required timeframe
//
// DATA: Reads applicants, staff, onboarding_checklists,
//       staff_performance, commission_structures tables
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

// ─── Workflow Banner — top-of-tab context strip ───────────────
// Small blue-tinted banner explaining what a tab is for and where its
// records flow next in the employee lifecycle. Renders as the first child
// inside every tab surface so the agent always sees the "why" alongside the "what".
const WorkflowBanner = ({ title, body, next }) => (
  <div style={{
    background: T.blueLt,
    borderLeft: `4px solid ${T.blue}`,
    borderRadius: 10,
    padding: "12px 16px",
    marginBottom: 14
  }}>
    <div style={{ fontSize: 12, fontWeight: 700, color: T.blue, marginBottom: 4 }}>{title}</div>
    <div style={{ fontSize: 11, color: T.slate700, lineHeight: 1.55 }}>{body}</div>
    {next && (
      <div style={{ fontSize: 11, color: T.slate500, marginTop: 6, fontStyle: "italic" }}>
        → {next}
      </div>
    )}
  </div>
);


// ─── Pipeline Stage Config ────────────────────────────────────
const STAGES = {
  new:       { label:"New",        color:T.slate500, bg:T.slate100, order:0 },
  screening: { label:"Screening",  color:T.blue,     bg:T.blueLt,  order:1 },
  interview: { label:"Interview",  color:T.amber,    bg:T.amberLt, order:2 },
  offer:     { label:"Offer",      color:T.purple,   bg:T.purpleLt,order:3 },
  hired:     { label:"Hired",      color:T.green,    bg:T.greenLt, order:4 },
  rejected:  { label:"Rejected",   color:T.red,      bg:T.redLt,   order:5 },
};

// ─── Mock Data ────────────────────────────────────────────────
const MOCK_APPLICANTS = [
  {
    id:"ap1", first_name:"Jamie",  last_name:"Chen",
    email:"jamie.chen@email.com", phone:"(312) 555-0142",
    position:"Licensed Sales Agent",
    status:"interview", source:"email_auto",
    claude_score:8,
    claude_summary:"Strong candidate with 3 years P&C experience at Allstate. Currently licensed in IL. Demonstrated production record of 85 new policies/month. Clean background. Minor concern: reason for leaving current role unclear.",
    interview_focus:`ONE PAGE INTERVIEW FOCUS — Jamie Chen

STRENGTHS TO EXPLORE:
1. P&C production record at Allstate — ask for specific monthly new business numbers and what drove them
2. IL license status — verify current, in good standing, ask about plans to add WI/IN
3. Customer retention approach — 3 years at same agency suggests loyalty; understand philosophy

CONCERNS TO PROBE:
1. Reason for leaving Allstate — current role ended abruptly per resume gap; ask directly and assess answer
2. Experience with life insurance — P&C heavy background; assess openness to cross-selling
3. Salary expectations vs. commission structure — candidate may expect base salary

SUGGESTED QUESTIONS:
1. Walk me through your average month at Allstate — how many new policies, what product mix?
2. What made you decide to leave your last agency, and what are you looking for in your next role?
3. How do you approach customers who have coverage gaps they haven't asked about?
4. Have you sold life insurance before? What's your comfort level with that conversation?
5. Where do you see yourself in 2 years — still in sales, or are you interested in eventually running your own agency?

RED FLAGS: Resume gap Apr-Aug 2025 unexplained. Probe during interview.
LICENSING: IL P&C license verified active. Life license — confirm status.`,
    intake_received_at:"Apr 26, 2026",
    interview_date:"Apr 29, 2026",
    interview_notes:"Phone screen completed Apr 27. Strong communication skills. Scheduled in-person for Apr 29.",
    rating:null,
  },
  {
    id:"ap2", first_name:"Derek",  last_name:"Washington",
    email:"derek.w@email.com", phone:"(630) 555-0188",
    position:"Office Manager",
    status:"screening", source:"email_auto",
    claude_score:7,
    claude_summary:"Experienced office manager, 5 years in financial services operations. Not licensed — applying for unlicensed role. Strong organizational and systems background. Good cultural fit indicators.",
    interview_focus:`ONE PAGE INTERVIEW FOCUS — Derek Washington

STRENGTHS TO EXPLORE:
1. Financial services operations background — directly relevant to agency management
2. Systems experience — ask about CRM, scheduling, and workflow tools used
3. 5 years tenure at prior employer — signals loyalty and stability

CONCERNS TO PROBE:
1. No insurance industry experience specifically — assess learning curve appetite
2. Salary expectations — office manager roles have a wide range; align early
3. Comfort with high-volume customer interaction — financial services may be less client-facing

SUGGESTED QUESTIONS:
1. Describe a typical day managing operations at your last firm — what were your top 3 responsibilities?
2. What systems and tools do you use to stay organized across multiple priorities?
3. Have you ever supported a licensed professional team? How did you handle questions you couldn't answer?
4. What's your ideal work environment — autonomous or highly collaborative?
5. What attracted you specifically to an insurance agency vs. other financial services roles?`,
    intake_received_at:"Apr 24, 2026",
    interview_date:null,
    interview_notes:null,
    rating:null,
  },
  {
    id:"ap3", first_name:"Maria",  last_name:"Santos",
    email:"m.santos@email.com", phone:"(773) 555-0211",
    position:"Licensed Sales Agent",
    status:"new", source:"email_auto",
    claude_score:6,
    claude_summary:"Recent licensing school graduate, no prior sales experience. IL P&C license new. Enthusiastic cover letter. Will require significant training investment. Score reflects potential over experience.",
    interview_focus:null,
    intake_received_at:"Today, Apr 27",
    interview_date:null,
    interview_notes:null,
    rating:null,
  },
  {
    id:"ap4", first_name:"Kevin",  last_name:"Park",
    email:"k.park@email.com", phone:"(847) 555-0094",
    position:"Licensed Sales Agent",
    status:"offer", source:"referral",
    claude_score:9,
    claude_summary:"Exceptional candidate. 7 years State Farm experience at another agency, relocated to Chicago area. All lines licensed IL, WI, IN. Strong AIPP production history. Reference from prior agent provided.",
    interview_focus:null,
    intake_received_at:"Apr 18, 2026",
    interview_date:"Apr 22, 2026",
    interview_notes:"Excellent interview. Knows SF systems cold. Start date flexible. Salary ask is $58K base + commission. Offer being prepared.",
    rating:5,
  },
  {
    id:"ap5", first_name:"Tanya",  last_name:"Brooks",
    email:"t.brooks@email.com", phone:"(312) 555-0317",
    position:"Licensed Sales Agent",
    status:"rejected", source:"email_auto",
    claude_score:4,
    claude_summary:"Limited insurance experience. License lapsed 2 years ago — would require retesting. Cover letter indicated interest in office admin, not sales. Mismatch with role requirements.",
    interview_focus:null,
    intake_received_at:"Apr 19, 2026",
    interview_date:null,
    interview_notes:"Reviewed profile — not a fit for current opening. License lapsed.",
    rating:null,
  },
];

const MOCK_STAFF = [
  {
    id:"s1", first_name:"Marcus", last_name:"Thompson",
    role:"Licensed Sales Agent", employment_type:"w2",
    start_date:"Jan 15, 2022", is_active:true,
    email:"marcus@smithagency.com", phone:"(312) 555-0182",
    pay_type:"salary_plus_commission", pay_rate:52000,
    licensed:true, license_states:["IL","WI"],
    notes:"Top producer. Life license pending — scheduled exam May 2026.",
    ytd_production:{ new_policies:68, retention_rate:91 },
  },
  {
    id:"s2", first_name:"Priya", last_name:"Patel",
    role:"Office Manager", employment_type:"w2",
    start_date:"Mar 1, 2020", is_active:true,
    email:"priya@smithagency.com", phone:"(312) 555-0183",
    pay_type:"salary", pay_rate:42000,
    licensed:false, license_states:[],
    notes:"Handles all operations, billing, client service. Cannot perform licensed activities.",
    ytd_production:null,
  },
  {
    id:"s3", first_name:"Tyler", last_name:"Smith",
    role:"Administrative Support", employment_type:"family",
    start_date:"Jun 1, 2024", is_active:true,
    email:"tyler@smithagency.com", phone:null,
    pay_type:"hourly", pay_rate:18,
    licensed:false, license_states:[],
    notes:"Jane's son. Part-time 20hrs/wk. Below standard deduction — no FIT withheld. Flag for CPA at year-end W-2. Cannot perform licensed activities.",
    ytd_production:null,
    compliance_flag:"Family employee — review W-2 treatment with CPA annually",
  },
];

const MOCK_ONBOARDING = [
  {
    staff_id:"s1", staff_name:"Marcus Thompson", start_date:"Jan 15, 2022",
    template:"licensed", days_employed:834,
    items:[
      { category:"licensing",   item:"IL Producer License verified active",           completed:true,  due:"Day 1"   },
      { category:"licensing",   item:"WI non-resident license verified active",        completed:true,  due:"Day 7"   },
      { category:"documents",   item:"W-4 completed and filed",                        completed:true,  due:"Day 1"   },
      { category:"documents",   item:"Direct deposit authorization on file",           completed:true,  due:"Day 1"   },
      { category:"documents",   item:"I-9 employment eligibility verified",            completed:true,  due:"Day 3"   },
      { category:"compliance",  item:"SF compliance and ethics training completed",    completed:true,  due:"Day 30"  },
      { category:"compliance",  item:"Social media compliance training acknowledged",  completed:true,  due:"Day 14"  },
      { category:"systems",     item:"Agency management system access granted",        completed:true,  due:"Day 1"   },
      { category:"systems",     item:"SF systems training completed",                  completed:true,  due:"Day 30"  },
      { category:"training",    item:"Product training — P&C lines",                  completed:true,  due:"Day 30"  },
      { category:"training",    item:"Product training — Life insurance",              completed:false, due:"Day 60"  },
      { category:"licensing",   item:"Life insurance license — exam scheduled",        completed:false, due:"May 2026"},
    ],
  },
];

const MOCK_PERFORMANCE = [
  {
    staff_id:"s1", staff_name:"Marcus Thompson", period:"April 2026",
    metrics:[
      { metric:"New Policies Written",    target:20, actual:18, unit:"count"      },
      { metric:"Life Apps Submitted",     target:3,  actual:1,  unit:"count"      },
      { metric:"Retention Rate",          target:88, actual:91, unit:"percentage" },
      { metric:"Customer Satisfaction",   target:95, actual:94, unit:"percentage" },
      { metric:"Revenue Contribution",    target:12000, actual:10800, unit:"dollars" },
    ],
  },
];

const MOCK_COMMISSIONS = [
  {
    id:"c1", staff_name:"Marcus Thompson", staff_id:"s1",
    structure_name:"Standard Licensed Agent Commission",
    effective_date:"Jan 2022",
    commission_type:"tiered",
    tiers:[
      { min:0,    max:10000, rate:8   },
      { min:10001,max:20000, rate:10  },
      { min:20001,max:null,  rate:12  },
    ],
    qualifying_products:["auto","home","life","health"],
    notes:"Commission paid monthly on new business production attributed to Marcus. Paid with regular payroll.",
    ytd_earned:4200,
    this_month:1080,
  },
];


// ─── Producer ROI Hook ───────────────────────────────────────
function useProducerROI() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const currentYear  = new Date().getFullYear();
        const currentMonth = new Date().getMonth() + 1;

        const [agencyRes, staffRes, prodRes, payrollDetailRes, payrollRunsRes, compRes, perfRes] = await Promise.all([
          supabase.from("agency").select("id, name, smvc_rate_pc, blended_rate_other, lapse_rate_annual").eq("id", AGENCY_ID).single(),
          supabase.from("staff").select("id, first_name, last_name, role, start_date, pay_rate, employment_type, is_active").eq("agency_id", AGENCY_ID),
          supabase.from("producer_production").select("staff_id, period_year, period_month, line_of_business, policies_issued, premium_issued").eq("agency_id", AGENCY_ID).order("period_year",{ascending:false}).order("period_month",{ascending:false}),
          supabase.from("payroll_detail").select("staff_id, gross_pay, payroll_run_id"),
          supabase.from("payroll_runs").select("id, pay_date, pay_period_start, pay_period_end").eq("agency_id", AGENCY_ID).order("pay_date",{ascending:false}).limit(24),
          supabase.from("comp_recap").select("period_year, period_month, comp_type, comp_category, amount").eq("agency_id", AGENCY_ID),
          supabase.from("staff_performance").select("staff_id, period_year, period_month, metric_name, actual").eq("agency_id", AGENCY_ID).in("metric_name", ["gross_pay_monthly", "fully_loaded_cost_monthly"]),
        ]);

        const agency = agencyRes.data || {};
        const staff  = (staffRes.data || []).filter(s => s.is_active !== false);
        const production = prodRes.data || [];
        const payrollDetail = payrollDetailRes.data || [];
        const payrollRuns = payrollRunsRes.data || [];
        const compRecaps = compRes.data || [];
        const perfRows = perfRes.data || [];

        // staff_performance snapshots (migration 027): precomputed monthly cost per staff-month.
        // Keyed by `${staff_id}|${year}|${month}` → { monthlyGross, monthlyLoaded }
        const perfByKey = {};
        for (const r of perfRows) {
          const k = `${r.staff_id}|${r.period_year}|${r.period_month}`;
          if (!perfByKey[k]) perfByKey[k] = {};
          if (r.metric_name === "gross_pay_monthly") perfByKey[k].monthlyGross = parseFloat(r.actual || 0);
          if (r.metric_name === "fully_loaded_cost_monthly") perfByKey[k].monthlyLoaded = parseFloat(r.actual || 0);
        }
        // Latest snapshot per staff (most recent year+month with a non-null monthlyLoaded)
        const latestPerfByStaff = {};
        for (const r of perfRows) {
          if (r.metric_name !== "fully_loaded_cost_monthly") continue;
          const cur = latestPerfByStaff[r.staff_id];
          const rank = r.period_year * 12 + r.period_month;
          if (!cur || rank > cur.rank) {
            latestPerfByStaff[r.staff_id] = { rank, monthlyLoaded: parseFloat(r.actual || 0) };
          }
        }
        const latestGrossByStaff = {};
        for (const r of perfRows) {
          if (r.metric_name !== "gross_pay_monthly") continue;
          const cur = latestGrossByStaff[r.staff_id];
          const rank = r.period_year * 12 + r.period_month;
          if (!cur || rank > cur.rank) {
            latestGrossByStaff[r.staff_id] = { rank, monthlyGross: parseFloat(r.actual || 0) };
          }
        }

        // Lapse rate from comp_recap: prior-year vs current-year auto+fire YTD renewals
        const isPC = (cat) => {
          const c = (cat || "").toLowerCase();
          return c.includes("auto") || c.includes("home") || c.includes("fire") || c.includes("umbrella");
        };
        const renewalsYtd = (year) => compRecaps
          .filter(r => r.period_year === year && r.comp_type === "renewal" && isPC(r.comp_category) && r.period_month <= currentMonth)
          .reduce((s,r) => s + parseFloat(r.amount || 0), 0);

        const priorRenewals = renewalsYtd(currentYear - 1);
        const currentRenewals = renewalsYtd(currentYear);
        let computedLapse = null;
        if (priorRenewals > 0) {
          computedLapse = Math.max(0, Math.min(50, (1 - currentRenewals / priorRenewals) * 100));
        }
        const lapseRate = agency.lapse_rate_annual != null ? parseFloat(agency.lapse_rate_annual) : (computedLapse != null ? computedLapse : 10);

        // Per-producer monthly gross pay from last 3 payroll runs (×2 for semi-monthly)
        const last3RunIds = new Set(payrollRuns.slice(0, 3).map(r => r.id));
        const grossByStaff = {};
        const runsCountByStaff = {};
        for (const d of payrollDetail) {
          if (!last3RunIds.has(d.payroll_run_id)) continue;
          grossByStaff[d.staff_id] = (grossByStaff[d.staff_id] || 0) + parseFloat(d.gross_pay || 0);
          runsCountByStaff[d.staff_id] = (runsCountByStaff[d.staff_id] || 0) + 1;
        }
        const monthlyGrossByStaff = {};
        for (const sid of Object.keys(grossByStaff)) {
          const total = grossByStaff[sid];
          const runs = runsCountByStaff[sid] || 1;
          monthlyGrossByStaff[sid] = (total / runs) * 2;
        }

        const smvc = parseFloat(agency.smvc_rate_pc) || 10;
        const blended = parseFloat(agency.blended_rate_other) || 9;

        // Group production by staff/year/month
        const prodByKey = {};
        for (const p of production) {
          const k = `${p.staff_id}|${p.period_year}|${p.period_month}`;
          if (!prodByKey[k]) prodByKey[k] = { pc_premium: 0, other_premium: 0, policies: 0 };
          if (p.line_of_business === "auto" || p.line_of_business === "fire") {
            prodByKey[k].pc_premium += parseFloat(p.premium_issued || 0);
          } else {
            prodByKey[k].other_premium += parseFloat(p.premium_issued || 0);
          }
          prodByKey[k].policies += parseInt(p.policies_issued || 0, 10);
        }

        // Producers — anyone whose role suggests they write new business.
        // Includes the SF nomenclature (LSP, Producer, FSS = Financial Services
        // Specialist) plus the looser titles this agency actually uses
        // (Sales/Account Rep, Sales Rep). Excludes pure service titles
        // (Customer Care Rep, Service Admin, Executive Assistant) and roles
        // explicitly marked TBC awaiting the agent's confirmation.
        const producers = staff.filter(s => {
          const r = (s.role || "").toLowerCase();
          if (r.includes("tbc")) return false;
          return r.includes("lsp")
              || r.includes("producer")
              || r.includes("financial services")
              || r.includes("sales")
              || r.includes("account rep");
        });

        const producerRows = producers.map(s => {
          const history = [];
          for (let back = 0; back < 24; back++) {
            const date = new Date(currentYear, currentMonth - 1 - back, 1);
            const y = date.getFullYear();
            const m = date.getMonth() + 1;
            const k = `${s.id}|${y}|${m}`;
            const row = prodByKey[k] || { pc_premium: 0, other_premium: 0, policies: 0 };
            const newCommission = (row.pc_premium * smvc / 100) + (row.other_premium * blended / 100);
            history.push({
              year: y, month: m,
              monthLabel: date.toLocaleDateString("en-US",{month:"short", year:"2-digit"}),
              pcPremium: row.pc_premium,
              otherPremium: row.other_premium,
              policies: row.policies,
              newCommission,
            });
          }
          history.reverse();

          // Cost history aligned with the 24-month timeline above (oldest → current).
          // For each history slot, look up the precomputed staff_performance snapshot.
          // Carry-forward only AFTER we've seen the first real snapshot for this staff —
          // months before the producer existed stay null so the polyline starts at hire,
          // not retroactively backfilled. Mid-window gaps (e.g. the agent's May 2026 NULL row)
          // still carry the prior month's value so the line stays continuous.
          const costHistory = [];
          let firstSeen = false;
          let lastKnownGross = null;
          let lastKnownLoaded = null;
          for (const h of history) {
            const k = `${s.id}|${h.year}|${h.month}`;
            const snap = perfByKey[k] || {};
            if (Number.isFinite(snap.monthlyGross))  { lastKnownGross  = snap.monthlyGross;  firstSeen = true; }
            if (Number.isFinite(snap.monthlyLoaded)) { lastKnownLoaded = snap.monthlyLoaded; firstSeen = true; }
            costHistory.push({
              year: h.year,
              month: h.month,
              monthlyGross:  firstSeen ? lastKnownGross  : null,
              monthlyLoaded: firstSeen ? lastKnownLoaded : null,
            });
          }

          const current = history[history.length - 1] || { pcPremium: 0, otherPremium: 0, policies: 0, newCommission: 0 };
          const recent6 = history.slice(-6);
          const avgPC = recent6.reduce((s,h) => s + h.pcPremium, 0) / Math.max(1, recent6.length);
          const avgOther = recent6.reduce((s,h) => s + h.otherPremium, 0) / Math.max(1, recent6.length);
          const avgNewCommission = (avgPC * smvc / 100) + (avgOther * blended / 100);

          // Prefer the most recent staff_performance snapshot (precomputed, accurate).
          // Falls back to the noisy "last 3 payroll runs × 2" approximation, then to annual pay_rate / 12.
          const monthlyGross = (latestGrossByStaff[s.id]?.monthlyGross)
                            ?? monthlyGrossByStaff[s.id]
                            ?? (parseFloat(s.pay_rate || 0) / 12)
                            ?? 0;
          const monthlyLoaded = (latestPerfByStaff[s.id]?.monthlyLoaded)
                             ?? (monthlyGross * 1.15);

          const startDate = s.start_date ? new Date(s.start_date) : new Date();
          const tenureMonths = Math.max(0, Math.round((Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 30.42)));

          return {
            staff_id: s.id,
            name: `${s.first_name} ${s.last_name}`,
            role: s.role,
            start_date: s.start_date,
            tenureMonths,
            payRate: parseFloat(s.pay_rate || 0),
            monthlyGross,
            monthlyLoaded,
            currentMonth: current,
            history,
            costHistory,
            avgPC,
            avgOther,
            avgNewCommission,
          };
        });

        setData({
          agency,
          smvcRate: smvc,
          blendedRate: blended,
          lapseRate,
          lapseRateComputed: computedLapse,
          lapseRateOverride: agency.lapse_rate_annual != null,
          priorRenewals,
          currentRenewals,
          producerRows,
        });
      } catch (e) {
        console.error("Producer ROI load error:", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  return { data, loading };
}

// ─── Helpers ──────────────────────────────────────────────────
const scoreColor = (s) => s >= 8 ? T.green : s >= 6 ? T.amber : T.red;
const scoreBg    = (s) => s >= 8 ? T.greenLt : s >= 6 ? T.amberLt : T.redLt;
const pct = (a, t) => t ? Math.min(100, Math.round((a/t)*100)) : 0;
const fmt = (n, unit) => unit === "dollars" ? "$"+n.toLocaleString() : unit === "percentage" ? n+"%" : n.toString();

// ─── Shared Components ────────────────────────────────────────
const Card = ({ children, style={} }) => (
  <div style={{ background:T.white, border:`1px solid ${T.slate200}`, borderRadius:12, padding:"16px 18px", ...style }}>
    {children}
  </div>
);

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

const ProgressBar = ({ value, max, color=T.blue, height=6 }) => (
  <div style={{ height, background:T.slate100, borderRadius:height/2, overflow:"hidden" }}>
    <div style={{ height:"100%", width:`${pct(value,max)}%`, background:color, borderRadius:height/2, transition:"width 0.6s ease" }} />
  </div>
);

const StageBadge = ({ status }) => {
  const s = STAGES[status] || STAGES.new;
  return <span style={{ fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:20, background:s.bg, color:s.color }}>{s.label}</span>;
};

// ─── Section: Overview ────────────────────────────────────────
const HROverview = ({ applicants, staff, onboarding }) => {
  const [showAddEmployee, setShowAddEmployee] = useState(false);
  const [newEmployee, setNewEmployee] = useState({first_name:"", last_name:"", role:"", email:"", phone:"", start_date:"", employment_type:"w2"});
  const [editingStaff, setEditingStaff] = useState(null);
  const [showFormerTeam, setShowFormerTeam] = useState(false);

  const saveEmployee = async () => {
    if (!newEmployee.first_name || !newEmployee.last_name) return;
    if (supabase) {
      await supabase.from("staff").insert({ ...newEmployee, agency_id: AGENCY_ID, is_active: true });
    }
    setShowAddEmployee(false);
    setNewEmployee({first_name:"", last_name:"", role:"", email:"", phone:"", start_date:"", employment_type:"w2"});
  };

  const saveEditedStaff = async () => {
    if (!editingStaff?.first_name || !editingStaff?.last_name) return;
    if (supabase) {
      // Strip read-only/server-side fields before update
      const { id, agency_id, created_at, updated_at, ...editable } = editingStaff;
      await supabase.from("staff").update({ ...editable, updated_at: new Date().toISOString() }).eq("id", id);
    }
    setEditingStaff(null);
  };

  const active      = applicants.filter(a => !["hired","rejected"].includes(a.status));
  const newApps     = applicants.filter(a => a.status === "new").length;
  const inInterview = applicants.filter(a => a.status === "interview").length;
  const inOffer     = applicants.filter(a => a.status === "offer").length;
  const activeStaff = staff.filter(s => s.is_active).length;
  const flagged     = staff.filter(s => s.compliance_flag).length;

  return (
    <div>
      <WorkflowBanner
        title="Team snapshot — start here every morning"
        body={<>Your active pipeline, current team, and where new hires are in onboarding, all at a glance. Use this as the daily check-in before drilling into a specific tab.</>}
      />

      {/* KPI Row */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))", gap:10, marginBottom:16 }}>
        {[
          { label:"Active Pipeline",   value:active.length,   color:T.blue,  border:T.blue  },
          { label:"New Applicants",    value:newApps,         color:newApps>0?T.amber:T.slate400, border:newApps>0?T.amber:T.slate200 },
          { label:"In Interviews",     value:inInterview,     color:T.purple,border:T.purple },
          { label:"Offers Pending",    value:inOffer,         color:T.green, border:T.green },
          { label:"Active Staff",      value:activeStaff,     color:T.navy,  border:T.navy  },
          { label:"Compliance Flags",  value:flagged,         color:flagged>0?T.red:T.green, border:flagged>0?T.red:T.green },
        ].map((k,i) => (
          <div key={i} style={{ background:T.white, border:`1px solid ${T.slate200}`, borderTop:`3px solid ${k.border}`, borderRadius:12, padding:"14px 16px" }}>
            <div style={{ fontSize:11, color:T.slate500, fontWeight:500, marginBottom:6 }}>{k.label}</div>
            <div style={{ fontSize:24, fontWeight:700, color:k.color, letterSpacing:"-0.02em" }}>{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)", gap:12 }}>
        {/* Active Pipeline */}
        
      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
        <button onClick={()=>setShowAddEmployee(s=>!s)} style={{padding:"8px 16px",fontSize:12,fontWeight:600,background:"#1E3A5F",color:"#fff",border:"none",borderRadius:8,cursor:"pointer"}}>➕ Add Employee</button>
      </div>

      {showAddEmployee && (
        <div style={{background:"#EFF6FF",border:"1px solid #BFDBFE",borderRadius:10,padding:16,marginBottom:16}}>
          <div style={{fontSize:13,fontWeight:700,color:"#1E3A5F",marginBottom:12}}>Add New Employee</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
            <input placeholder="First name *" value={newEmployee.first_name} onChange={e=>setNewEmployee({...newEmployee,first_name:e.target.value})} style={{padding:"8px 10px",borderRadius:6,border:"1px solid #CBD5E1",fontSize:12}} />
            <input placeholder="Last name *" value={newEmployee.last_name} onChange={e=>setNewEmployee({...newEmployee,last_name:e.target.value})} style={{padding:"8px 10px",borderRadius:6,border:"1px solid #CBD5E1",fontSize:12}} />
            <input placeholder="Role / Title" value={newEmployee.role} onChange={e=>setNewEmployee({...newEmployee,role:e.target.value})} style={{padding:"8px 10px",borderRadius:6,border:"1px solid #CBD5E1",fontSize:12}} />
            <input placeholder="Email" value={newEmployee.email} onChange={e=>setNewEmployee({...newEmployee,email:e.target.value})} style={{padding:"8px 10px",borderRadius:6,border:"1px solid #CBD5E1",fontSize:12}} />
            <input placeholder="Phone" value={newEmployee.phone} onChange={e=>setNewEmployee({...newEmployee,phone:e.target.value})} style={{padding:"8px 10px",borderRadius:6,border:"1px solid #CBD5E1",fontSize:12}} />
            <input type="date" placeholder="Start date" value={newEmployee.start_date} onChange={e=>setNewEmployee({...newEmployee,start_date:e.target.value})} style={{padding:"8px 10px",borderRadius:6,border:"1px solid #CBD5E1",fontSize:12}} />
            <select value={newEmployee.employment_type} onChange={e=>setNewEmployee({...newEmployee,employment_type:e.target.value})} style={{padding:"8px 10px",borderRadius:6,border:"1px solid #CBD5E1",fontSize:12}}>
              <option value="w2">W-2 Employee</option>
              <option value="1099">1099 Contractor</option>
              <option value="family">Family Employee (W-2)</option>
            </select>
          </div>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
            <button onClick={()=>setShowAddEmployee(false)} style={{padding:"6px 14px",fontSize:12,background:"#F1F5F9",color:"#334155",border:"none",borderRadius:6,cursor:"pointer"}}>Cancel</button>
            <button onClick={saveEmployee} style={{padding:"6px 14px",fontSize:12,background:"#1E3A5F",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontWeight:600}}>Save Employee</button>
          </div>
        </div>
      )}
<Card>
          <div style={{ fontSize:13, fontWeight:600, color:T.slate800, marginBottom:12 }}>Active recruiting pipeline</div>
          {active.length === 0 ? (
            <div style={{ fontSize:12, color:T.slate400, textAlign:"center", padding:"16px 0" }}>No active applicants</div>
          ) : active.map((app,i) => (
            <div key={app.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 0", borderBottom:i<active.length-1?`1px solid ${T.slate100}`:"none" }}>
              <div style={{ width:32, height:32, borderRadius:8, background:scoreBg(app.claude_score), display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                <span style={{ fontSize:13, fontWeight:700, color:scoreColor(app.claude_score) }}>{app.claude_score}</span>
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, fontWeight:600, color:T.slate800 }}>{app.first_name} {app.last_name}</div>
                <div style={{ fontSize:10, color:T.slate500 }}>{app.position || "Open Position"}{app.intake_received_at ? ` · ${app.intake_received_at}` : ""}</div>
              </div>
              <StageBadge status={app.status} />
            </div>
          ))}
        </Card>

        {/* Team Snapshot */}
        <Card>
          <div style={{ fontSize:13, fontWeight:600, color:T.slate800, marginBottom:12 }}>Active team ({(staff||[]).filter(s => s.is_active).length})</div>
          {(staff||[]).filter(s => s.is_active).map((member,i,arr) => (
            <div key={member.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 0", borderBottom:i<arr.length-1?`1px solid ${T.slate100}`:"none" }}>
              <div style={{ width:32, height:32, borderRadius:8, background:member.licensed?T.greenLt:T.slate100, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:11, fontWeight:700, color:member.licensed?T.green:T.slate500 }}>
                {(member.first_name||"?")[0]}{(member.last_name||"?")[0]}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, fontWeight:600, color:T.slate800 }}>{member.first_name} {member.last_name}</div>
                <div style={{ fontSize:10, color:T.slate500 }}>{member.role || "(no role set)"}{member.employment_type ? ` · ${member.employment_type.toUpperCase()}` : ""}</div>
              </div>
              <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:3 }}>
                {member.licensed
                  ? <span style={{ fontSize:9, fontWeight:600, padding:"2px 6px", borderRadius:20, background:T.greenLt, color:"#065F46" }}>Licensed</span>
                  : null
                }
                {member.compliance_flag && (
                  <span style={{ fontSize:9, fontWeight:600, padding:"2px 6px", borderRadius:20, background:T.amberLt, color:"#92400E" }}>⚠ CPA Flag</span>
                )}
              </div>
              <button onClick={()=>setEditingStaff({...member})} title="Edit team member" style={{ padding:"4px 8px", fontSize:10, fontWeight:600, background:T.slate100, color:T.slate800, border:`1px solid ${T.slate200}`, borderRadius:6, cursor:"pointer", marginLeft:4 }}>Edit</button>
            </div>
          ))}

          {/* Former team toggle */}
          {(staff||[]).filter(s => !s.is_active).length > 0 && (
            <>
              <div style={{ marginTop:14, paddingTop:10, borderTop:`1px solid ${T.slate100}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ fontSize:12, fontWeight:600, color:T.slate500 }}>
                  Former team ({(staff||[]).filter(s => !s.is_active).length})
                </div>
                <button onClick={()=>setShowFormerTeam(v=>!v)} style={{ padding:"3px 10px", fontSize:10, fontWeight:600, background:T.white, color:T.slate500, border:`1px solid ${T.slate200}`, borderRadius:6, cursor:"pointer" }}>
                  {showFormerTeam ? "Hide" : "Show"}
                </button>
              </div>
              {showFormerTeam && (staff||[]).filter(s => !s.is_active).map((member,i,arr) => (
                <div key={member.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderBottom:i<arr.length-1?`1px solid ${T.slate100}`:"none", opacity:0.7 }}>
                  <div style={{ width:32, height:32, borderRadius:8, background:T.slate100, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:11, fontWeight:700, color:T.slate400 }}>
                    {(member.first_name||"?")[0]}{(member.last_name||"?")[0]}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12, fontWeight:600, color:T.slate500 }}>{member.first_name} {member.last_name}</div>
                    <div style={{ fontSize:10, color:T.slate400 }}>
                      {member.role || "(no role)"}{member.employment_type ? ` · ${member.employment_type.toUpperCase()}` : ""}
                      {member.end_date && ` · ended ${member.end_date}`}
                    </div>
                  </div>
                  <button onClick={()=>setEditingStaff({...member})} title="Edit former team member" style={{ padding:"4px 8px", fontSize:10, fontWeight:600, background:T.slate100, color:T.slate500, border:`1px solid ${T.slate200}`, borderRadius:6, cursor:"pointer" }}>Edit</button>
                </div>
              ))}
            </>
          )}

          {/* Edit Staff inline modal */}
          {editingStaff && (
            <div style={{ marginTop:14, background:"#FFFBEB", border:"1px solid #FCD34D", borderRadius:10, padding:14 }}>
              <div style={{ fontSize:13, fontWeight:700, color:"#92400E", marginBottom:10 }}>
                Edit {editingStaff.first_name} {editingStaff.last_name}
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:8 }}>
                <input placeholder="First name *" value={editingStaff.first_name || ""} onChange={e=>setEditingStaff({...editingStaff, first_name:e.target.value})} style={{ padding:"7px 10px", borderRadius:6, border:"1px solid #CBD5E1", fontSize:12 }} />
                <input placeholder="Last name *" value={editingStaff.last_name || ""} onChange={e=>setEditingStaff({...editingStaff, last_name:e.target.value})} style={{ padding:"7px 10px", borderRadius:6, border:"1px solid #CBD5E1", fontSize:12 }} />
                <input placeholder="Role / Title (e.g. Licensed Sales Producer)" value={editingStaff.role || ""} onChange={e=>setEditingStaff({...editingStaff, role:e.target.value})} style={{ padding:"7px 10px", borderRadius:6, border:"1px solid #CBD5E1", fontSize:12, gridColumn:"1 / span 2" }} />
                <input placeholder="Email" value={editingStaff.email || ""} onChange={e=>setEditingStaff({...editingStaff, email:e.target.value})} style={{ padding:"7px 10px", borderRadius:6, border:"1px solid #CBD5E1", fontSize:12 }} />
                <input placeholder="Phone" value={editingStaff.phone || ""} onChange={e=>setEditingStaff({...editingStaff, phone:e.target.value})} style={{ padding:"7px 10px", borderRadius:6, border:"1px solid #CBD5E1", fontSize:12 }} />
                <div>
                  <div style={{ fontSize:10, color:T.slate500, marginBottom:2 }}>Start date</div>
                  <input type="date" value={editingStaff.start_date || ""} onChange={e=>setEditingStaff({...editingStaff, start_date:e.target.value||null})} style={{ padding:"7px 10px", borderRadius:6, border:"1px solid #CBD5E1", fontSize:12, width:"100%" }} />
                </div>
                <div>
                  <div style={{ fontSize:10, color:T.slate500, marginBottom:2 }}>End date (if departed)</div>
                  <input type="date" value={editingStaff.end_date || ""} onChange={e=>setEditingStaff({...editingStaff, end_date:e.target.value||null})} style={{ padding:"7px 10px", borderRadius:6, border:"1px solid #CBD5E1", fontSize:12, width:"100%" }} />
                </div>
                <select value={editingStaff.employment_type || ""} onChange={e=>setEditingStaff({...editingStaff, employment_type:e.target.value})} style={{ padding:"7px 10px", borderRadius:6, border:"1px solid #CBD5E1", fontSize:12 }}>
                  <option value="">— Employment type —</option>
                  <option value="full_time">Full-time W-2</option>
                  <option value="part_time">Part-time W-2</option>
                  <option value="contractor">1099 Contractor</option>
                  <option value="family">Family Employee (W-2)</option>
                  <option value="owner">Owner</option>
                </select>
                <select value={editingStaff.pay_type || ""} onChange={e=>setEditingStaff({...editingStaff, pay_type:e.target.value})} style={{ padding:"7px 10px", borderRadius:6, border:"1px solid #CBD5E1", fontSize:12 }}>
                  <option value="">— Pay type —</option>
                  <option value="hourly">Hourly</option>
                  <option value="salary">Salary</option>
                  <option value="commission">Commission</option>
                </select>
                <input type="number" step="0.01" placeholder="Pay rate ($/hr or $/yr)" value={editingStaff.pay_rate ?? ""} onChange={e=>setEditingStaff({...editingStaff, pay_rate:e.target.value===""?null:parseFloat(e.target.value)})} style={{ padding:"7px 10px", borderRadius:6, border:"1px solid #CBD5E1", fontSize:12 }} />
                <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:12, color:T.slate800 }}>
                  <input type="checkbox" checked={!!editingStaff.is_active} onChange={e=>setEditingStaff({...editingStaff, is_active:e.target.checked})} />
                  Active team member
                </label>
              </div>
              <textarea placeholder="Notes (CPA flags, licensing notes, etc.)" value={editingStaff.notes || ""} onChange={e=>setEditingStaff({...editingStaff, notes:e.target.value})} style={{ width:"100%", minHeight:50, padding:"7px 10px", borderRadius:6, border:"1px solid #CBD5E1", fontSize:12, marginBottom:8, fontFamily:"inherit", resize:"vertical" }} />
              <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
                <button onClick={()=>setEditingStaff(null)} style={{ padding:"6px 14px", fontSize:12, background:T.slate100, color:T.slate800, border:"none", borderRadius:6, cursor:"pointer" }}>Cancel</button>
                <button onClick={saveEditedStaff} style={{ padding:"6px 14px", fontSize:12, fontWeight:600, background:"#1E3A5F", color:"#fff", border:"none", borderRadius:6, cursor:"pointer" }}>Save changes</button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};

// ─── Section: Recruiting Pipeline ────────────────────────────
const RecruitingPipeline = ({ applicants, onUpdate }) => {
  const [selected, setSelected] = useState(null);
  const stages = ["new","screening","interview","offer","hired","rejected"];


  const selectedApp = applicants.find(a => a.id === selected);

  return (
    <div>
      <WorkflowBanner
        title="Applicant pipeline"
        body={<>Resumes flow in from your Groq-scored auto-import (Gmail recipe) or manual add. Move candidates through <strong>Screening</strong> → <strong>Interview</strong> → <strong>Offer</strong>. When you upload an offer letter to a candidate's personnel file, the system flips their staff status to <em>active</em> and auto-creates their 15-item onboarding checklist.</>}
        next="Next stop: Onboarding"
      />

      {/* Pipeline Kanban */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(6,minmax(0,1fr))", gap:8, marginBottom:16 }}>
        {stages.map(stage => {
          const s = STAGES[stage];
          const stageApps = applicants.filter(a => a.status === stage);
          return (
            <div key={stage} style={{ background:T.slate50, borderRadius:10, padding:"10px 8px", minHeight:120 }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                <span style={{ fontSize:10, fontWeight:700, color:s.color }}>{s.label}</span>
                <span style={{ fontSize:10, fontWeight:700, padding:"1px 6px", borderRadius:10, background:s.bg, color:s.color }}>{stageApps.length}</span>
              </div>
              {stageApps.map(app => (
                <div
                  key={app.id}
                  onClick={() => setSelected(selected===app.id?null:app.id)}
                  style={{ background:T.white, border:`1px solid ${selected===app.id?T.blue:T.slate200}`, borderRadius:8, padding:"8px 10px", marginBottom:6, cursor:"pointer" }}
                >
                  <div style={{ fontSize:11, fontWeight:600, color:T.slate800 }}>{app.first_name} {app.last_name}</div>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:4 }}>
                    <span style={{ fontSize:9, color:T.slate400 }}>{app.position.split(" ").slice(-1)[0]}</span>
                    <span style={{ fontSize:11, fontWeight:700, color:scoreColor(app.claude_score) }}>{app.claude_score}/10</span>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* Applicant Detail Panel */}
      {selectedApp && (
        <Card>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:16 }}>
            <div>
              <div style={{ fontSize:16, fontWeight:700, color:T.slate900 }}>{selectedApp.first_name} {selectedApp.last_name}</div>
              <div style={{ fontSize:12, color:T.slate500, marginTop:2 }}>{selectedApp.position} · Received {selectedApp.intake_received_at}</div>
            </div>
            <div style={{ display:"flex", gap:8, alignItems:"center" }}>
              <div style={{ width:44, height:44, borderRadius:12, background:scoreBg(selectedApp.claude_score), display:"flex", alignItems:"center", justifyContent:"center" }}>
                <span style={{ fontSize:18, fontWeight:700, color:scoreColor(selectedApp.claude_score) }}>{selectedApp.claude_score}</span>
              </div>
              <StageBadge status={selectedApp.status} />
              <AskBtn size="small" context={`Applicant profile:\nName: ${selectedApp.first_name} ${selectedApp.last_name}\nPosition: ${selectedApp.position}\nClaude Score: ${selectedApp.claude_score}/10\nSummary: ${selectedApp.claude_summary}\n${selectedApp.interview_focus?"Interview Focus:\n"+selectedApp.interview_focus:""}\n${selectedApp.interview_notes?"Interview Notes: "+selectedApp.interview_notes:""}\n\nHelp me think through this candidate. Should I move forward? What should I focus on in the interview?`} />
            </div>
          </div>

          {/* Claude Summary */}
          <div style={{ background:T.slate50, borderRadius:10, padding:"12px 14px", marginBottom:12 }}>
            <div style={{ fontSize:11, fontWeight:600, color:T.slate600, marginBottom:4 }}>CLAUDE SUMMARY (Groq Analysis)</div>
            <div style={{ fontSize:12, color:T.slate700, lineHeight:1.7 }}>{selectedApp.claude_summary}</div>
          </div>

          {/* Interview Focus */}
          {selectedApp.interview_focus && (
            <div style={{ background:T.amberLt, border:`1px solid #FCD34D`, borderRadius:10, padding:"12px 14px", marginBottom:12 }}>
              <div style={{ fontSize:11, fontWeight:700, color:"#92400E", marginBottom:8 }}>ONE PAGE INTERVIEW FOCUS</div>
              <pre style={{ fontSize:11, color:"#78350F", lineHeight:1.7, margin:0, whiteSpace:"pre-wrap", fontFamily:"inherit" }}>
                {selectedApp.interview_focus}
              </pre>
            </div>
          )}

          {/* Interview notes */}
          {selectedApp.interview_notes && (
            <div style={{ background:T.blueLt, borderRadius:10, padding:"12px 14px", marginBottom:12 }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#1E40AF", marginBottom:4 }}>INTERVIEW NOTES</div>
              <div style={{ fontSize:12, color:"#1E40AF", lineHeight:1.7 }}>{selectedApp.interview_notes}</div>
            </div>
          )}

          {/* Stage Actions */}
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            {selectedApp.status === "new" && (
              <button onClick={() => onUpdate(selectedApp.id,"screening")} style={{ padding:"7px 14px", fontSize:11, fontWeight:600, color:T.white, background:T.blue, border:"none", borderRadius:7, cursor:"pointer" }}>→ Move to Screening</button>
            )}
            {selectedApp.status === "screening" && (
              <button onClick={() => onUpdate(selectedApp.id,"interview")} style={{ padding:"7px 14px", fontSize:11, fontWeight:600, color:T.white, background:T.amber, border:"none", borderRadius:7, cursor:"pointer" }}>→ Schedule Interview</button>
            )}
            {selectedApp.status === "interview" && (
              <>
                <button onClick={() => onUpdate(selectedApp.id,"offer")} style={{ padding:"7px 14px", fontSize:11, fontWeight:600, color:T.white, background:T.green, border:"none", borderRadius:7, cursor:"pointer" }}>→ Extend Offer</button>
                <button onClick={() => onUpdate(selectedApp.id,"rejected")} style={{ padding:"7px 14px", fontSize:11, fontWeight:600, color:T.red, background:T.redLt, border:"none", borderRadius:7, cursor:"pointer" }}>✗ Reject</button>
              </>
            )}
            {selectedApp.status === "offer" && (
              <>
                <button onClick={() => onUpdate(selectedApp.id,"hired")} style={{ padding:"7px 14px", fontSize:11, fontWeight:600, color:T.white, background:T.green, border:"none", borderRadius:7, cursor:"pointer" }}>✓ Mark Hired</button>
                <button onClick={() => onUpdate(selectedApp.id,"rejected")} style={{ padding:"7px 14px", fontSize:11, fontWeight:600, color:T.red, background:T.redLt, border:"none", borderRadius:7, cursor:"pointer" }}>✗ Offer Declined</button>
              </>
            )}
          </div>
        </Card>
      )}
    </div>
  );
};

// ─── Section: Staff Directory ─────────────────────────────────
const StaffDirectory = ({ staff }) => {
  const [expanded, setExpanded] = useState(null);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <WorkflowBanner
        title="Active roster"
        body={<>Everyone currently on the team. From here you can jump to <strong>Performance</strong> for coaching notes and KPIs on any producer, or to <strong>Commissions</strong> to see how their pay plan is structured.</>}
        next="Manage → Performance · Pay → Commissions"
      />

      {staff.filter(s => s.is_active).map(member => {
        const isExpanded = expanded === member.id;
        return (
          <Card key={member.id} style={{ border:`1px solid ${isExpanded?T.blue:T.slate200}` }}>
            <div style={{ display:"flex", alignItems:"center", gap:14, cursor:"pointer" }} onClick={() => setExpanded(isExpanded?null:member.id)}>
              {/* Avatar */}
              <div style={{ width:48, height:48, borderRadius:12, background:member.licensed?T.navy:T.slate200, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, fontWeight:700, color:member.licensed?T.white:T.slate500, flexShrink:0 }}>
                {member.first_name[0]}{member.last_name[0]}
              </div>

              <div style={{ flex:1 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                  <span style={{ fontSize:14, fontWeight:700, color:T.slate900 }}>{member.first_name} {member.last_name}</span>
                  {member.licensed
                    ? <span style={{ fontSize:10, fontWeight:600, padding:"2px 8px", borderRadius:20, background:T.greenLt, color:"#065F46" }}>Licensed</span>
                    : <span style={{ fontSize:10, fontWeight:600, padding:"2px 8px", borderRadius:20, background:T.slate100, color:T.slate500 }}>Unlicensed — cannot perform licensed activities</span>
                  }
                  {member.compliance_flag && (
                    <span style={{ fontSize:10, fontWeight:600, padding:"2px 8px", borderRadius:20, background:T.amberLt, color:"#92400E" }}>⚠ CPA Flag</span>
                  )}
                </div>
                <div style={{ fontSize:12, color:T.slate500 }}>
                  {member.role} · {member.employment_type === "w2" ? "W-2 Employee" : member.employment_type === "family" ? "Family Employee (W-2)" : "1099 Contractor"} · Since {member.start_date}
                </div>
              </div>

              <div style={{ textAlign:"right", flexShrink:0 }}>
                <div style={{ fontSize:13, fontWeight:700, color:T.slate900 }}>
                  {member.pay_type === "hourly" ? `$${member.pay_rate}/hr` : `$${member.pay_rate.toLocaleString()}/yr`}
                </div>
                <div style={{ fontSize:10, color:T.slate400 }}>{member.pay_type.replace(/_/g," ")}</div>
              </div>

              <span style={{ color:T.slate400, fontSize:12 }}>{isExpanded?"▲":"▼"}</span>
            </div>

            {isExpanded && (
              <div style={{ marginTop:14, paddingTop:14, borderTop:`1px solid ${T.slate100}` }}>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:8, marginBottom:12 }}>
                  {[
                    { label:"Email",      value:member.email },
                    { label:"Phone",      value:member.phone||"—" },
                    { label:"Licensed States", value:member.license_states.length>0?member.license_states.join(", "):"None" },
                    { label:"Start Date", value:member.start_date },
                  ].map((d,i) => (
                    <div key={i} style={{ background:T.slate50, borderRadius:8, padding:"7px 10px" }}>
                      <div style={{ fontSize:9, color:T.slate400, marginBottom:2 }}>{d.label}</div>
                      <div style={{ fontSize:11, fontWeight:500, color:T.slate700 }}>{d.value}</div>
                    </div>
                  ))}
                </div>
                {member.notes && (
                  <div style={{ fontSize:11, color:T.slate600, lineHeight:1.6, padding:"8px 10px", background:T.slate50, borderRadius:8, marginBottom:10 }}>
                    {member.notes}
                  </div>
                )}
                {member.compliance_flag && (
                  <div style={{ fontSize:11, color:"#92400E", background:T.amberLt, padding:"8px 10px", borderRadius:8, marginBottom:10 }}>
                    ⚠ {member.compliance_flag}
                  </div>
                )}
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <button onClick={()=>setEditingStaff({...member})} title="Edit team member"
                    style={{ padding:"6px 14px", fontSize:11, fontWeight:600, background:T.navy, color:T.white, border:"none", borderRadius:6, cursor:"pointer" }}>
                    ✏️ Edit
                  </button>
                  <AskBtn size="small" context={`Staff member profile:\nName: ${member.first_name} ${member.last_name}\nRole: ${member.role}\nEmployment: ${member.employment_type}\nPay: ${member.pay_type} — ${member.pay_type==="hourly"?"$"+member.pay_rate+"/hr":"$"+member.pay_rate.toLocaleString()+"/yr"}\nLicensed: ${member.licensed?"Yes — "+member.license_states.join(", "):"No"}\nStart: ${member.start_date}\nNotes: ${member.notes}\n${member.compliance_flag?"Compliance flag: "+member.compliance_flag:""}\n\nHelp me review this team member's profile. Are there any compliance concerns or HR items I should address?`} />
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
};

// ─── Section: Onboarding ─────────────────────────────────────
const OnboardingSection = ({ onboarding }) => {
  const categoryColors = {
    licensing:  { color:T.green,  bg:T.greenLt  },
    documents:  { color:T.blue,   bg:T.blueLt   },
    compliance: { color:T.red,    bg:T.redLt    },
    systems:    { color:T.teal,   bg:T.tealLt   },
    training:   { color:T.purple, bg:T.purpleLt },
  };

  return (
    <div>
      <WorkflowBanner
        title="New hire onboarding"
        body={<>Every new hire gets a 15-item checklist (I-9, W-4, direct deposit, handbook ack, compliance acks, etc.). Uploading a matching document to their personnel file auto-checks off that item. When every required item is done, an <em>onboarding complete</em> alert fires and they roll into Staff.</>}
        next="Next stop: Staff"
      />

      {onboarding.map(record => {
        const completed = record.items.filter(i => i.completed).length;
        const total = record.items.length;
        const pctDone = Math.round((completed/total)*100);
        const grouped = record.items.reduce((acc, item) => {
          if (!acc[item.category]) acc[item.category] = [];
          acc[item.category].push(item);
          return acc;
        }, {});

        return (
          <Card key={record.staff_id}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14 }}>
              <div>
                <div style={{ fontSize:14, fontWeight:700, color:T.slate900 }}>{record.staff_name}</div>
                <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>Started {record.start_date} · {record.days_employed} days employed · {record.template} template</div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontSize:22, fontWeight:700, color:pctDone===100?T.green:T.amber, letterSpacing:"-0.02em" }}>{pctDone}%</div>
                <div style={{ fontSize:10, color:T.slate400 }}>{completed}/{total} complete</div>
              </div>
            </div>

            <div style={{ height:8, background:T.slate100, borderRadius:4, overflow:"hidden", marginBottom:16 }}>
              <div style={{ height:"100%", width:`${pctDone}%`, background:pctDone===100?T.green:T.amber, borderRadius:4, transition:"width 0.6s ease" }} />
            </div>

            {Object.entries(grouped).map(([cat, items]) => {
              const cc = categoryColors[cat] || { color:T.slate500, bg:T.slate100 };
              return (
                <div key={cat} style={{ marginBottom:14 }}>
                  <div style={{ fontSize:11, fontWeight:700, color:cc.color, marginBottom:6, textTransform:"capitalize" }}>{cat}</div>
                  {items.map((item,i) => (
                    <div key={i} style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 0", borderBottom:i<items.length-1?`1px solid ${T.slate100}`:"none" }}>
                      <div style={{ width:18, height:18, borderRadius:4, background:item.completed?T.green:T.slate200, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                        {item.completed && <span style={{ color:T.white, fontSize:10 }}>✓</span>}
                      </div>
                      <span style={{ flex:1, fontSize:12, color:item.completed?T.slate400:T.slate800, textDecoration:item.completed?"line-through":"none" }}>{item.item}</span>
                      <span style={{ fontSize:10, color:T.slate400, flexShrink:0 }}>{item.due}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </Card>
        );
      })}
    </div>
  );
};

// ─── Section: Producer P&L (moved from Performance tab 2026-07-16) ─────────
// The ROI math: SMVC × premium projections vs fully-loaded payroll cost per
// producer. Now embedded inside the Commissions tab where it belongs.
const ProducerPnLSection = ({ roi }) => {
  if (!roi) {
    return (
      <Card>
        <div style={{ padding: "20px 0", textAlign: "center", fontSize: 13, color: T.slate500 }}>
          Loading producer performance data…
        </div>
      </Card>
    );
  }

  const { smvcRate, blendedRate, lapseRate, lapseRateComputed, lapseRateOverride,
          priorRenewals, currentRenewals, producerRows } = roi;

  // Data-freshness gate: if NO producer has any issued production, we can't
  // meaningfully compute ROI. Show a helpful banner instead of alarming red
  // "behind pace" cards on every producer.
  const totalPremiumAcrossProducers = producerRows.reduce(
    (sum, p) => sum + Number(p.totalPremiumIssuedYTD || p.premium_ytd || 0), 0
  );
  if (producerRows.length > 0 && totalPremiumAcrossProducers === 0) {
    return (
      <Card style={{ borderLeft: `4px solid ${T.amber}` }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.slate900, marginBottom: 6 }}>
          Producer P&L — no production data yet
        </div>
        <div style={{ fontSize: 12, color: T.slate600, lineHeight: 1.6, marginBottom: 10 }}>
          Producer P&L projections need monthly premium data per producer. The
          <code style={{ fontFamily: "monospace", fontSize: 11, padding: "1px 5px", background: T.slate100, borderRadius: 4, margin: "0 4px" }}>
            producer_production
          </code>
          table is empty right now.
        </div>
        <div style={{ fontSize: 12, color: T.slate600, lineHeight: 1.6, marginBottom: 10 }}>
          <strong>Next step:</strong> forward your monthly SF producer production
          report to
          <code style={{ fontFamily: "monospace", fontSize: 11, padding: "1px 5px", background: T.slate100, borderRadius: 4, margin: "0 4px" }}>
            [AGENCY_CLAUDE_EMAIL]
          </code>
          — the Producer Production Report Processor recipe will parse it and
          populate this section within the hour.
        </div>
        <div style={{ fontSize: 11, color: T.slate500, marginTop: 8, paddingTop: 8, borderTop: `1px solid ${T.slate200}` }}>
          Once loaded, this section will show per-producer profitability using
          your SMVC rate ({smvcRate ? (smvcRate * 100).toFixed(1) : "10.0"}%),
          blended rate ({blendedRate ? (blendedRate * 100).toFixed(1) : "9.0"}%),
          and lapse rate ({lapseRate.toFixed(1)}%).
        </div>
      </Card>
    );
  }

  if (producerRows.length === 0) {
    return (
      <Card>
        <div style={{ padding: "20px 0", textAlign: "center", fontSize: 13, color: T.slate500 }}>
          No producers (LSPs / Financial Services Specialists) found in your staff list.
        </div>
      </Card>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* ─── BOOK LAPSE RATE CARD ─────────────────────────────────── */}
      <Card style={{ borderLeft: `4px solid ${T.blue}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.slate900 }}>Book Lapse Rate (P&C, YTD)</div>
            <div style={{ fontSize: 11, color: T.slate500, marginTop: 2 }}>
              Same-period auto + fire renewal commission: prior year vs current year
            </div>
          </div>
          <AskBtn size="small" context={`My agency book lapse rate analysis:\nPrior year YTD P&C renewal commission: $${Math.round(priorRenewals).toLocaleString()}\nCurrent year YTD P&C renewal commission: $${Math.round(currentRenewals).toLocaleString()}\nComputed lapse rate: ${(lapseRateComputed || 0).toFixed(1)}%\nApplied lapse rate (used in projections): ${lapseRate.toFixed(1)}%\n\nIs this lapse rate normal for our book? What should I focus on to reduce it?`} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
          <div style={{ background: T.slate50, padding: "10px 12px", borderRadius: 8 }}>
            <div style={{ fontSize: 10, color: T.slate500, marginBottom: 4 }}>Prior Year YTD Renewals</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.slate900 }}>
              {Number.isFinite(priorRenewals) ? "$" + Math.round(priorRenewals).toLocaleString() : "—"}
            </div>
          </div>
          <div style={{ background: T.slate50, padding: "10px 12px", borderRadius: 8 }}>
            <div style={{ fontSize: 10, color: T.slate500, marginBottom: 4 }}>Current Year YTD Renewals</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.slate900 }}>
              {Number.isFinite(currentRenewals) ? "$" + Math.round(currentRenewals).toLocaleString() : "—"}
            </div>
          </div>
          <div style={{ background: lapseRate > 15 ? T.redLt : lapseRate > 10 ? T.amberLt : T.greenLt, padding: "10px 12px", borderRadius: 8 }}>
            <div style={{ fontSize: 10, color: T.slate500, marginBottom: 4 }}>
              Lapse Rate {lapseRateOverride ? "(manual)" : "(computed)"}
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: lapseRate > 15 ? "#991B1B" : lapseRate > 10 ? "#92400E" : "#065F46" }}>
              {lapseRate.toFixed(1)}%
            </div>
          </div>
          <div style={{ background: T.slate50, padding: "10px 12px", borderRadius: 8 }}>
            <div style={{ fontSize: 10, color: T.slate500, marginBottom: 4 }}>Applied to Projections</div>
            <div style={{ fontSize: 12, color: T.slate700, lineHeight: 1.4 }}>
              {(100 - lapseRate).toFixed(0)}% of policies renew next year (assumption)
            </div>
          </div>
        </div>

        <div style={{ marginTop: 12, padding: "10px 12px", background: T.blueLt, borderRadius: 8, fontSize: 11, color: T.slate700, lineHeight: 1.5 }}>
          <strong>Why this matters:</strong> Each producer&apos;s new business takes 12-18 months to start producing renewal commission.
          A lapse rate of {lapseRate.toFixed(1)}% means roughly {(100 - lapseRate).toFixed(0)}% of what they write today will still be on the books next year, generating renewal commission.
          The projections below use this rate to estimate when each producer becomes profitable against their fully-loaded payroll cost.
        </div>
      </Card>

      {/* ─── PER-PRODUCER ROI ANALYSIS ───────────────────────────── */}
      {producerRows.map(p => <ProducerROICard key={p.staff_id} producer={p} smvcRate={smvcRate} blendedRate={blendedRate} lapseRate={lapseRate} />)}

      {/* ─── ASSUMPTIONS FOOTER ──────────────────────────────────── */}
      <Card style={{ background: T.slate50, border: `1px dashed ${T.slate200}` }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.slate700, marginBottom: 8 }}>Assumptions used in projections</div>
        <div style={{ fontSize: 11, color: T.slate600, lineHeight: 1.7 }}>
          <div>• <strong>SMVC rate (P&C):</strong> {smvcRate.toFixed(2)}% — agent earns this percent of issued auto + fire premium per A005 agreement</div>
          <div>• <strong>Blended rate (other):</strong> {blendedRate.toFixed(2)}% — blended commission for Life, Health, Financial Services</div>
          <div>• <strong>Lapse rate:</strong> {lapseRate.toFixed(1)}% per year — applied as compounding annual decay to renewing cohorts</div>
          <div>• <strong>Fully-loaded payroll:</strong> gross pay × 1.15 — covers FICA, FUTA, SUTA, WC</div>
          <div>• <strong>Renewal start:</strong> month 13 — new business policies issued today start generating renewal commission 12 months from now</div>
          <div>• <strong>Steady-state pace:</strong> 6-month rolling average of issued premium per producer</div>
        </div>
      </Card>
    </div>
  );
};

// ─── Producer ROI Card — per-producer analysis with stacked cohort projection ───
const ProducerROICard = ({ producer, smvcRate, blendedRate, lapseRate }) => {
  const persistency = 1 - lapseRate / 100;

  // Build the 24 future months of projection
  // Each historical month is a "cohort" that survives going forward
  // For future months, we assume steady-state at producer.avg{PC,Other}
  const futureMonths = 24;
  const totalMonths = producer.history.length + futureMonths;

  // Build cohort series: one per month index in the timeline (0 = oldest history, history.length = current+1)
  const cohorts = [];
  for (let i = 0; i < producer.history.length; i++) {
    const h = producer.history[i];
    cohorts.push({ pcPremium: h.pcPremium, otherPremium: h.otherPremium, isHistory: true });
  }
  for (let i = 0; i < futureMonths; i++) {
    cohorts.push({ pcPremium: producer.avgPC, otherPremium: producer.avgOther, isHistory: false });
  }

  // For each forward month index from producer.history.length onward (i.e., projection months),
  // compute total commission to agency = sum of (cohort_k's renewal commission at age = (month - k))
  // Rules: at age 0 (same month as written), commission = full new-business commission (SMVC × pc + blended × other)
  //        at age 1-11 months, no additional commission yet (it's the same policies, paid once at issue under SF)
  //        at age 12+, the renewal commission kicks in, reduced by persistency^floor((age-12)/12 + 1)
  //
  // Simpler model that matches Rebecca's description:
  //   For month N going forward, projected commission = NEW commission this month +
  //     for each cohort k written ≥12 months ago: cohort_k_commission × persistency^(years_since)
  //   where years_since = floor((N - k) / 12)

  const forwardStartIdx = producer.history.length;
  const projectionMonths = []; // {label, newCommission, renewalCommission, totalCommission, isHistory}

  for (let i = 0; i < totalMonths; i++) {
    const date = new Date(producer.history[0].year, producer.history[0].month - 1 + i, 1);
    const label = date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    const isHistory = i < forwardStartIdx;

    const cohortAtI = cohorts[i] || { pcPremium: 0, otherPremium: 0 };
    const newCommission = (cohortAtI.pcPremium * smvcRate / 100) + (cohortAtI.otherPremium * blendedRate / 100);

    // Renewal commission: only project this for FORWARD months. Historical bars show
    // only what the producer actually earned (new business commission) — we don't
    // retroactively simulate renewals that the producer didn't actually generate.
    let renewalCommission = 0;
    if (!isHistory) {
      for (let k = 0; k < i; k++) {
        const age = i - k;
        if (age < 12) continue;
        const yearsRenewed = Math.floor((age - 12) / 12) + 1;
        const survivalFactor = Math.pow(persistency, yearsRenewed);
        const cohortCommission = (cohorts[k].pcPremium * smvcRate / 100) + (cohorts[k].otherPremium * blendedRate / 100);
        renewalCommission += cohortCommission * survivalFactor;
      }
    }

    projectionMonths.push({ label, newCommission, renewalCommission,
                            totalCommission: newCommission + renewalCommission, isHistory });
  }

  // Find breakeven month — first FORWARD month where totalCommission >= monthlyLoaded
  const monthlyLoaded = producer.monthlyLoaded;
  let breakevenIdx = -1;
  for (let i = forwardStartIdx; i < projectionMonths.length; i++) {
    if (projectionMonths[i].totalCommission >= monthlyLoaded) {
      breakevenIdx = i;
      break;
    }
  }
  const breakevenLabel = breakevenIdx >= 0 ? projectionMonths[breakevenIdx].label : null;
  const monthsToBreakeven = breakevenIdx >= 0 ? breakevenIdx - forwardStartIdx + 1 : null;

  // Status pill — logic accounts for the difference between covering cost from
  // new business alone (rare for producers) vs needing renewal stack-up over time
  // (typical, expected, and what the projection chart visualizes).
  let status, statusColor, statusBg, statusText;
  // Check this at the END of the calc so we use newly-computed currentNewCommission
  // (defined later); we'll set status after all calcs are done. Placeholder here.
  status = "On track"; statusColor = "#065F46"; statusBg = T.greenLt;
  statusText = "";

  // Current month metrics — actual new-business commission this producer earned the agency THIS MONTH.
  // We deliberately do NOT add simulated renewal income here. Renewal commission in comp_recap is at
  // the AGENCY level, not tagged to a producer; attributing it back is misleading.
  // The renewal projection in the chart below shows what the cohort math says SHOULD build over time.
  const cur = producer.currentMonth;
  const currentNewCommission = (cur.pcPremium * smvcRate / 100) + (cur.otherPremium * blendedRate / 100);
  const currentNetToAgency = currentNewCommission - monthlyLoaded;

  // Now set the real status based on actual + projected economics
  if (currentNewCommission >= monthlyLoaded) {
    status = "Profitable now"; statusColor = "#065F46"; statusBg = T.greenLt;
    statusText = `New-business commission alone covers fully-loaded cost (${producer.name.split(" ")[0]} is a star producer)`;
  } else if (breakevenIdx < 0) {
    status = "Behind pace"; statusColor = "#991B1B"; statusBg = T.redLt;
    statusText = `Not projected to break even within 24 months at current pace — production needs to increase or cost structure needs review`;
  } else if (monthsToBreakeven <= 18) {
    status = "On track"; statusColor = "#065F46"; statusBg = T.greenLt;
    statusText = `Cohort math projects renewals will cover fully-loaded cost in ${monthsToBreakeven} months (${breakevenLabel}) — within the 12-18 month target window`;
  } else {
    status = "Slow ramp"; statusColor = "#92400E"; statusBg = T.amberLt;
    statusText = `Cohort math projects breakeven in ${monthsToBreakeven} months (${breakevenLabel}) — outside the 18-month target. Consider production target adjustment.`;
  }

  // Chart dimensions
  const chartH = 180;

  // Build per-month cost series aligned to the projection timeline.
  // History months: use the staff_performance snapshot for that month — null if
  // the producer didn't exist yet (pre-hire), the cost line simply doesn't extend back.
  // Forward months: carry the latest known cost as a flat baseline.
  const costHistory = producer.costHistory || [];
  // Latest non-null cost in history; falls back to producer.monthlyLoaded headline.
  let lastKnownLoaded = monthlyLoaded;
  for (let i = costHistory.length - 1; i >= 0; i--) {
    if (Number.isFinite(costHistory[i].monthlyLoaded)) { lastKnownLoaded = costHistory[i].monthlyLoaded; break; }
  }
  const costSeries = [];
  for (let i = 0; i < projectionMonths.length; i++) {
    if (i < forwardStartIdx) {
      const cell = costHistory[i];
      costSeries.push(Number.isFinite(cell?.monthlyLoaded) ? cell.monthlyLoaded : null);
    } else {
      costSeries.push(lastKnownLoaded);
    }
  }

  const maxValue = Math.max(
    lastKnownLoaded * 1.3,
    ...projectionMonths.map(p => p.totalCommission),
    ...costSeries.filter(Number.isFinite)
  ) || 1;

  return (
    <Card>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.slate900 }}>{producer.name}</div>
          <div style={{ fontSize: 11, color: T.slate500, marginTop: 2 }}>
            {producer.role} · Started {producer.start_date} · Tenure {producer.tenureMonths} months
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, padding: "4px 10px", borderRadius: 20, background: statusBg, color: statusColor }}>{status}</span>
          <AskBtn size="small" context={`Producer ROI analysis — ${producer.name}\nRole: ${producer.role}\nTenure: ${producer.tenureMonths} months\nMonthly issued premium (P&C avg): $${Math.round(producer.avgPC).toLocaleString()}\nMonthly issued premium (other avg): $${Math.round(producer.avgOther).toLocaleString()}\nMonthly fully-loaded cost: $${Math.round(monthlyLoaded).toLocaleString()}\nNew-business commission this month: $${Math.round(currentNewCommission).toLocaleString()} (issued premium × SMVC rate)\nMonthly fully-loaded cost: $${Math.round(monthlyLoaded).toLocaleString()}\nNet to agency this month (new-biz only): $${Math.round(currentNetToAgency).toLocaleString()}\nProjected breakeven (when renewal stack-up + new biz covers cost): ${breakevenLabel || "outside 24 months"}\nLapse rate applied: ${lapseRate.toFixed(1)}%\nSMVC rate: ${smvcRate.toFixed(2)}% on P&C, ${blendedRate.toFixed(2)}% blended on other lines\n\nIs this producer on track? Should I increase their production target? What should I be doing differently?`} />
        </div>
      </div>

      {/* Status text */}
      <div style={{ fontSize: 11, color: T.slate600, marginBottom: 14, fontStyle: "italic" }}>{statusText}</div>

      {/* Current Month Economics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 16 }}>
        <div style={{ background: T.slate50, padding: "9px 11px", borderRadius: 8 }}>
          <div style={{ fontSize: 9, color: T.slate500, marginBottom: 3 }}>P&C Premium Issued</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.slate900 }}>${Math.round(cur.pcPremium).toLocaleString()}</div>
          <div style={{ fontSize: 10, color: T.slate400, marginTop: 2 }}>{cur.policies} policies</div>
        </div>
        <div style={{ background: T.slate50, padding: "9px 11px", borderRadius: 8 }}>
          <div style={{ fontSize: 9, color: T.slate500, marginBottom: 3 }}>Other Lines Premium</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.slate900 }}>${Math.round(cur.otherPremium).toLocaleString()}</div>
          <div style={{ fontSize: 10, color: T.slate400, marginTop: 2 }}>Life · FS</div>
        </div>
        <div style={{ background: T.blueLt, padding: "9px 11px", borderRadius: 8 }}>
          <div style={{ fontSize: 9, color: T.slate500, marginBottom: 3 }}>New-Biz Commission</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.blue }}>${Math.round(currentNewCommission).toLocaleString()}</div>
          <div style={{ fontSize: 10, color: T.slate400, marginTop: 2 }}>Premium × SMVC</div>
        </div>
        <div style={{ background: T.amberLt, padding: "9px 11px", borderRadius: 8 }}>
          <div style={{ fontSize: 9, color: T.slate500, marginBottom: 3 }}>Fully-Loaded Cost</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#92400E" }}>${Math.round(monthlyLoaded).toLocaleString()}</div>
          <div style={{ fontSize: 10, color: T.slate400, marginTop: 2 }}>Gross × 1.15</div>
        </div>
        <div style={{ background: currentNetToAgency >= 0 ? T.greenLt : T.redLt, padding: "9px 11px", borderRadius: 8 }}>
          <div style={{ fontSize: 9, color: T.slate500, marginBottom: 3 }}>Net to Agency</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: currentNetToAgency >= 0 ? "#065F46" : "#991B1B" }}>
            {currentNetToAgency >= 0 ? "+" : "-"}${Math.round(Math.abs(currentNetToAgency)).toLocaleString()}
          </div>
          <div style={{ fontSize: 10, color: T.slate400, marginTop: 2 }}>This month</div>
        </div>
      </div>

      {/* 24-Month Projection Chart */}
      <div style={{ marginTop: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.slate800 }}>Commission Trajectory — 24 months back, 24 months forward</div>
          <div style={{ display: "flex", gap: 12, fontSize: 10, color: T.slate500 }}>
            <span><span style={{ display: "inline-block", width: 10, height: 10, background: T.green, borderRadius: 2, marginRight: 4, verticalAlign: "middle" }} />New business</span>
            <span><span style={{ display: "inline-block", width: 10, height: 10, background: T.blue, borderRadius: 2, marginRight: 4, verticalAlign: "middle" }} />Renewals</span>
            <span><span style={{ display: "inline-block", width: 18, height: 2, background: T.red, marginRight: 4, verticalAlign: "middle" }} />Cost line</span>
          </div>
        </div>

        <div style={{ position: "relative", height: chartH + 30, background: T.slate50, borderRadius: 8, padding: "10px 8px 4px 8px" }}>
          {/* Cost trend — polyline of actual per-month fully-loaded cost (from staff_performance, migration 027).
              Historical months show the real cost the agency carried that month; forward months carry the
              latest known cost as a flat baseline. Replaces the prior flat horizontal red line. */}
          <svg
            style={{ position: "absolute", left: 8, top: 10, width: "calc(100% - 16px)", height: chartH, zIndex: 2, pointerEvents: "none" }}
            viewBox={`0 0 ${projectionMonths.length} ${chartH}`}
            preserveAspectRatio="none"
          >
            <polyline
              points={costSeries
                .map((c, i) => Number.isFinite(c) ? `${i + 0.5},${chartH - (c / maxValue) * chartH}` : null)
                .filter(Boolean)
                .join(" ")}
              fill="none"
              stroke={T.red}
              strokeWidth="2"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {/* Latest cost label positioned at the right edge using the last-known cost */}
          <div style={{
            position: "absolute",
            right: 12,
            top: 10 + chartH - (lastKnownLoaded / maxValue * chartH) - 16,
            fontSize: 9, fontWeight: 700, color: T.red,
            background: T.white, padding: "1px 5px", borderRadius: 4,
            zIndex: 3,
          }}>${Math.round(lastKnownLoaded).toLocaleString()}/mo cost</div>

          {/* Bars */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: chartH, position: "relative" }}>
            {projectionMonths.map((m, i) => {
              const newH = (m.newCommission / maxValue) * chartH;
              const renH = (m.renewalCommission / maxValue) * chartH;
              const isBreakeven = i === breakevenIdx;
              return (
                <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: chartH, position: "relative" }}>
                  {isBreakeven && (
                    <div style={{ position: "absolute", top: -4, fontSize: 14 }}>⭐</div>
                  )}
                  <div style={{ width: "85%", display: "flex", flexDirection: "column", justifyContent: "flex-end", height: chartH, opacity: m.isHistory ? 1 : 0.7 }}>
                    {renH > 0 && (
                      <div style={{ height: renH, background: T.blue, borderRadius: "0", borderTop: newH > 0 ? "none" : "2px 2px 0 0" }} />
                    )}
                    {newH > 0 && (
                      <div style={{ height: newH, background: T.green, borderRadius: renH > 0 ? "0" : "2px 2px 0 0" }} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* X-axis labels — every 6th month */}
          <div style={{ display: "flex", gap: 1, marginTop: 4 }}>
            {projectionMonths.map((m, i) => (
              <div key={i} style={{ flex: 1, fontSize: 8, color: m.isHistory ? T.slate500 : T.slate400, textAlign: "center" }}>
                {i % 6 === 0 ? m.label : ""}
              </div>
            ))}
          </div>

          {/* Vertical "now" divider */}
          <div style={{
            position: "absolute",
            left: `${8 + (forwardStartIdx / projectionMonths.length) * (100 - 1.6)}%`,
            top: 6, height: chartH + 8,
            borderLeft: `1px dashed ${T.slate400}`,
            zIndex: 1,
          }} />
        </div>

        {breakevenLabel && (
          <div style={{ marginTop: 10, padding: "10px 12px", background: T.greenLt, borderRadius: 8, fontSize: 11, color: "#065F46" }}>
            <strong>⭐ Projected breakeven: {breakevenLabel}</strong> — at {producer.name.split(" ")[0]}&apos;s current 6-month avg of ${Math.round(producer.avgPC + producer.avgOther).toLocaleString()}/mo issued premium, the agency earns ${Math.round(producer.avgNewCommission).toLocaleString()}/mo in new-business commission. As renewals stack up over time (at {(100-lapseRate).toFixed(0)}% persistency), total monthly commission generated by {producer.name.split(" ")[0]}&apos;s book is projected to first cover their ${Math.round(monthlyLoaded).toLocaleString()}/mo fully-loaded cost in {monthsToBreakeven} months.
          </div>
        )}
        {!breakevenLabel && (
          <div style={{ marginTop: 10, padding: "10px 12px", background: T.amberLt, borderRadius: 8, fontSize: 11, color: "#92400E" }}>
            <strong>Projected breakeven not within 24 months.</strong> At current pace of ${Math.round(producer.avgPC + producer.avgOther).toLocaleString()}/mo issued premium (${Math.round(producer.avgNewCommission).toLocaleString()}/mo new-business commission to the agency), this producer&apos;s renewal-tail trajectory does not catch up to ${Math.round(monthlyLoaded).toLocaleString()}/mo fully-loaded cost within the projection window. Either issued premium needs to increase, or pay rate needs review.
          </div>
        )}
      </div>
    </Card>
  );
};



// ─── Section: Performance — HR workspace (NEW 2026-07-16) ─────
// Team management surface: KPI grid, coaching notes, goal progress per producer.
// the agent's private coaching log lives here (coaching_notes table, RLS-gated).
const PerformanceSection = ({ staff, coachingNotes, staffPerformance,
                              timeMonthly, activityMonthly, scoreboardGoals,
                              currentUserStaffId, onNoteAdded }) => {

  // Coaching roster: every active team member. Coaching applies to everyone,
  // not just producer-roles — Service Admins, Customer Care Reps, Executive
  // Assistants all belong here too. (Producer P&L still filters by producer
  // role separately, since renewal-adjusted profitability math only makes sense
  // for producers who write new business.)
  const producers = (staff || []).filter(s => s.is_active);

  const [selectedId, setSelectedId] = useState(() => producers[0]?.id || null);
  const [noteText, setNoteText] = useState("");
  const [noteCategory, setNoteCategory] = useState("coaching");
  const [noteFollowUp, setNoteFollowUp] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  useEffect(() => {
    if (!selectedId && producers.length > 0) setSelectedId(producers[0].id);
  }, [producers, selectedId]);

  if (producers.length === 0) {
    return (
      <Card>
        <div style={{ padding: "20px 0", textAlign: "center", fontSize: 13, color: T.slate500 }}>
          No active team members found. Add staff via the Staff tab to populate this workspace.
        </div>
      </Card>
    );
  }

  const selected = producers.find(p => p.id === selectedId) || producers[0];
  const selectedName = `${selected.first_name || ""} ${selected.last_name || ""}`.trim() || "Producer";

  // Notes for this producer
  const producerNotes = (coachingNotes || [])
    .filter(n => n.staff_id === selected.id)
    .sort((a, b) => (b.note_date || "").localeCompare(a.note_date || ""));

  // Most recent 1:1 across all categories, and next open follow-up
  const lastOneOnOne = producerNotes.find(n => n.category === "1_1");
  const openFollowUp = producerNotes.find(n => n.follow_up_date && !n.resolved_at);

  // Time + activity this month vs last month
  const now = new Date();
  const thisYm = { y: now.getFullYear(), m: now.getMonth() + 1 };
  const lastYm = thisYm.m === 1 ? { y: thisYm.y - 1, m: 12 } : { y: thisYm.y, m: thisYm.m - 1 };
  const monthKey = (r) => `${r.period_year}-${String(r.period_month).padStart(2,"0")}`;
  const thisKey = `${thisYm.y}-${String(thisYm.m).padStart(2,"0")}`;
  const lastKey = `${lastYm.y}-${String(lastYm.m).padStart(2,"0")}`;

  const timeThis = (timeMonthly || []).find(r => r.staff_id === selected.id && monthKey(r) === thisKey);
  const timeLast = (timeMonthly || []).find(r => r.staff_id === selected.id && monthKey(r) === lastKey);
  const activityThis = (activityMonthly || []).find(r => r.staff_id === selected.id && monthKey(r) === thisKey);
  const activityLast = (activityMonthly || []).find(r => r.staff_id === selected.id && monthKey(r) === lastKey);

  const hoursThis = timeThis?.total_hours || 0;
  const hoursLast = timeLast?.total_hours || 0;
  const activitiesThis = activityThis?.total_activities || 0;
  const activitiesLast = activityLast?.total_activities || 0;
  const boundThis = activityThis?.bound_count || 0;
  const boundLast = activityLast?.bound_count || 0;

  // Fully-loaded cost from staff_performance snapshots (writer recipe populates monthly)
  const perfThis = (staffPerformance || []).find(r => r.staff_id === selected.id &&
    r.period_year === thisYm.y && r.period_month === thisYm.m && r.metric_name === "fully_loaded_cost_monthly");
  const monthlyCost = perfThis?.actual || (selected.pay_rate ? Number(selected.pay_rate) * 1.15 : 0);

  // Tenure in months
  const hireDate = selected.hire_date || selected.start_date;
  let tenureMonths = null;
  if (hireDate) {
    const hd = new Date(hireDate);
    tenureMonths = Math.floor((now - hd) / (1000*60*60*24*30.44));
  }

  async function saveNote() {
    if (!noteText.trim() || savingNote) return;
    setSavingNote(true);
    try {
      const { error } = await supabase.from("coaching_notes").insert({
        agency_id: AGENCY_ID,
        staff_id: selected.id,
        note_date: new Date().toISOString().slice(0, 10),
        note_text: noteText.trim(),
        category: noteCategory,
        follow_up_date: noteFollowUp || null,
        created_by_staff_id: currentUserStaffId,
      });
      if (error) { console.error("Coaching note save error:", error); return; }
      setNoteText("");
      setNoteFollowUp("");
      if (onNoteAdded) await onNoteAdded();
    } finally {
      setSavingNote(false);
    }
  }

  const kpiCards = [
    { label: "Hours this month",   value: hoursThis.toFixed(1),    prev: hoursLast.toFixed(1)      },
    { label: "Activities logged",  value: activitiesThis,          prev: activitiesLast            },
    { label: "Bound this month",   value: boundThis,               prev: boundLast                 },
    { label: "Loaded cost / mo",   value: `$${Math.round(monthlyCost).toLocaleString()}`, prev: null },
  ];

  const categoryLabels = {
    coaching:  { label: "Coaching",  color: T.blue    },
    "1_1":     { label: "1:1",       color: T.blueLt  },
    win:       { label: "Win",       color: T.green   },
    concern:   { label: "Concern",   color: T.red     },
    follow_up: { label: "Follow-up", color: T.amber   },
    review:    { label: "Review",    color: T.purple || T.slate600 },
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      <WorkflowBanner
        title="Coaching workspace — private to you"
        body={<>Pick a producer to see their KPIs (hours, activities, bound this month), team goal progress, and coaching history. Log observations, wins, concerns, and follow-ups. Notes are visible only to owner &amp; managers — the producer never sees them.</>}
        next="Data feeds: staff_performance · time tracking · sales activity · scoreboard_goals"
      />

      {/* Producer selector pill row */}
      <Card>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.slate500, marginBottom: 8 }}>
          Select team member
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {producers.map(p => {
            const name = `${p.first_name || ""} ${p.last_name || ""}`.trim();
            const isSelected = p.id === selected.id;
            return (
              <button key={p.id} onClick={() => setSelectedId(p.id)}
                style={{ padding: "6px 12px", fontSize: 12, fontWeight: isSelected ? 600 : 400,
                  color: isSelected ? T.white : T.slate700,
                  background: isSelected ? T.blue : T.slate50,
                  border: `1px solid ${isSelected ? T.blue : T.slate200}`,
                  borderRadius: 20, cursor: "pointer", transition: "all 0.12s" }}>
                {name}
              </button>
            );
          })}
        </div>
      </Card>

      {/* Selected producer header + KPI grid */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.slate900 }}>
              {selectedName}
            </div>
            <div style={{ fontSize: 11, color: T.slate500, marginTop: 3 }}>
              {selected.role || "Producer"}
              {hireDate ? ` · Started ${hireDate}` : ""}
              {tenureMonths != null ? ` · Tenure ${tenureMonths} mo` : ""}
            </div>
            {lastOneOnOne && (
              <div style={{ fontSize: 11, color: T.slate600, marginTop: 6 }}>
                Last 1:1: <strong>{lastOneOnOne.note_date}</strong>
                {openFollowUp && ` · Open follow-up due ${openFollowUp.follow_up_date}`}
              </div>
            )}
          </div>
          <AskBtn size="small" context={`Give me a coaching brief for ${selectedName}. Hours this month: ${hoursThis}, last month: ${hoursLast}. Activities: ${activitiesThis} (${boundThis} bound). Loaded cost: $${Math.round(monthlyCost)}/mo. Recent notes: ${producerNotes.slice(0,3).map(n=>`[${n.note_date}] ${n.note_text}`).join(" | ")}. What should I focus on in our next 1:1?`} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 8 }}>
          {kpiCards.map((k, i) => (
            <div key={i} style={{ padding: "10px 12px", background: T.slate50, borderRadius: 8 }}>
              <div style={{ fontSize: 10, color: T.slate500, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.03em" }}>
                {k.label}
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: T.slate900 }}>
                {k.value}
              </div>
              {k.prev != null && (
                <div style={{ fontSize: 10, color: T.slate400, marginTop: 2 }}>
                  Last month: {k.prev}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* Team goal progress (agency-wide from scoreboard_goals) */}
      {(scoreboardGoals || []).length > 0 && (
        <Card>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.slate900, marginBottom: 4 }}>
            Team goals — {selectedName}'s contribution
          </div>
          <div style={{ fontSize: 11, color: T.slate500, marginBottom: 10 }}>
            Agency-wide 2026 targets (all producers contribute).
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(scoreboardGoals || []).map(g => (
              <div key={g.id} style={{ padding: "8px 12px", background: T.slate50, borderRadius: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: T.slate700 }}>
                    {(g.goal_type || "").replace(/_/g, " ")}
                  </span>
                  <span style={{ fontSize: 11, color: T.slate500 }}>
                    Target: {g.target_value?.toLocaleString?.() || g.target_value}
                  </span>
                </div>
                <div style={{ height: 5, background: T.slate200, borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: "0%", background: T.blue, transition: "width 0.3s" }} />
                </div>
                <div style={{ fontSize: 10, color: T.slate400, marginTop: 3 }}>
                  Progress will populate when producer_production data loads.
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Add coaching note form */}
      <Card>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.slate900, marginBottom: 4 }}>
          Add a coaching note
        </div>
        <div style={{ fontSize: 11, color: T.slate500, marginBottom: 10 }}>
          Private to owner/managers · Not visible to {selectedName}.
        </div>
        <textarea value={noteText} onChange={e => setNoteText(e.target.value)}
          placeholder={`Observation about ${selectedName} — coaching moment, 1:1 recap, win, or concern...`}
          rows={3}
          style={{ width: "100%", padding: 10, fontSize: 12, border: `1px solid ${T.slate200}`,
            borderRadius: 8, resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select value={noteCategory} onChange={e => setNoteCategory(e.target.value)}
            style={{ padding: "6px 10px", fontSize: 12, border: `1px solid ${T.slate200}`, borderRadius: 6 }}>
            <option value="coaching">Coaching</option>
            <option value="1_1">1:1 recap</option>
            <option value="win">Win</option>
            <option value="concern">Concern</option>
            <option value="follow_up">Follow-up item</option>
            <option value="review">Formal review</option>
          </select>
          <label style={{ fontSize: 11, color: T.slate600, display: "flex", alignItems: "center", gap: 4 }}>
            Follow up:
            <input type="date" value={noteFollowUp} onChange={e => setNoteFollowUp(e.target.value)}
              style={{ padding: "5px 8px", fontSize: 11, border: `1px solid ${T.slate200}`, borderRadius: 6 }} />
          </label>
          <button onClick={saveNote} disabled={!noteText.trim() || savingNote}
            style={{ marginLeft: "auto", padding: "7px 14px", fontSize: 12, fontWeight: 600,
              color: T.textOnColor, background: noteText.trim() && !savingNote ? T.blue : T.slate300,
              border: "none", borderRadius: 6, cursor: noteText.trim() && !savingNote ? "pointer" : "not-allowed" }}>
            {savingNote ? "Saving…" : "Save note"}
          </button>
        </div>
      </Card>

      {/* Recent coaching notes */}
      <Card>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.slate900, marginBottom: 10 }}>
          Recent notes — {selectedName}
        </div>
        {producerNotes.length === 0 ? (
          <div style={{ fontSize: 12, color: T.slate500, textAlign: "center", padding: "20px 0" }}>
            No coaching notes yet for {selectedName}. Add your first observation above.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {producerNotes.slice(0, 10).map(n => {
              const cat = categoryLabels[n.category] || categoryLabels.coaching;
              return (
                <div key={n.id} style={{ padding: "10px 12px", background: T.slate50, borderRadius: 8 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 20,
                      background: cat.color + "20", color: cat.color }}>
                      {cat.label}
                    </span>
                    <span style={{ fontSize: 11, color: T.slate500 }}>{n.note_date}</span>
                    {n.follow_up_date && (
                      <span style={{ fontSize: 10, color: n.resolved_at ? T.slate400 : T.amber, marginLeft: "auto" }}>
                        {n.resolved_at ? `Resolved ${n.resolved_at.slice(0,10)}` : `Follow up ${n.follow_up_date}`}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: T.slate700, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                    {n.note_text}
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

// ─── Section: Commissions ─────────────────────────────────────
// Producer commission tier structures AND Producer P&L projections
// (relocated from the old Performance tab 2026-07-16 — the ROI math lives
// where the "am I making money on this producer" question already lives).
const CommissionsSection = ({ commissions, roi }) => {
  const list = Array.isArray(commissions) ? commissions : [];
  // Agency-wide bonus structures: staff_id is null (apply to ALL producers)
  const agencyWide = list.filter(c => !c.staff_id);
  // Per-producer plans: staff_id present, enrollment markers pointing at agency plan
  const perProducer = list.filter(c => !!c.staff_id);

  // Format the "rate" display for agency-wide cards — depends on commission_type
  const displayRate = (c) => {
    const t = c.commission_type || "";
    const rate = c.tiers?.[0]?.rate;
    if (rate == null) return { primary: "—", suffix: "" };
    if (t === "tier_bonus_pc" || t === "extra_bonus_pc") {
      return { primary: `${rate}%`, suffix: "of qualifying premium" };
    }
    if (t === "health_flat") {
      return { primary: `$${rate}`, suffix: "flat per app" };
    }
    if (t === "life_commission") {
      return { primary: "Pass-through", suffix: "100% of monthly premium" };
    }
    return { primary: `${rate}%`, suffix: "" };
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>

      <WorkflowBanner
        title="Pay & profitability"
        body={<>Top: your 2026 agency-wide bonus structures (sourced from your Comp Plan 2026 doc). All producers earn against these tiers. Middle: per-producer enrollment records. Bottom: Producer P&L — renewal-adjusted profitability per producer against fully-loaded payroll cost.</>}
      />

      {/* ─── Agency-wide bonus structures ─────────────────────── */}
      {agencyWide.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.slate900, marginTop: 4, marginBottom: -4 }}>
            Agency-wide Bonus Structures — 2026 Comp Plan
          </div>
          <div style={{ fontSize: 11, color: T.slate500, marginBottom: 4 }}>
            {agencyWide.length} structure{agencyWide.length === 1 ? "" : "s"} · All active producers earn against these
          </div>
          {agencyWide.map(c => {
            const rateInfo = displayRate(c);
            return (
              <Card key={c.id}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14, gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize:14, fontWeight:700, color:T.slate900 }}>{c.structure_name}</div>
                    <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>
                      <span style={{ fontWeight: 600, color: T.blue }}>Agency-wide</span> · All active producers eligible · Effective {c.effective_date}
                    </div>
                  </div>
                  <div style={{ textAlign:"right", flexShrink: 0 }}>
                    <div style={{ fontSize:11, color:T.slate400, marginBottom:2 }}>Rate</div>
                    <div style={{ fontSize:20, fontWeight:700, color:T.blue }}>{rateInfo.primary}</div>
                    {rateInfo.suffix && (
                      <div style={{ fontSize:10, color:T.slate500 }}>{rateInfo.suffix}</div>
                    )}
                  </div>
                </div>

                {/* Qualifying Products */}
                {c.qualifying_products?.length > 0 && (
                  <div style={{ marginBottom:12 }}>
                    <div style={{ fontSize:11, fontWeight:600, color:T.slate600, marginBottom:6 }}>Qualifying products</div>
                    <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                      {c.qualifying_products.map(p => (
                        <span key={p} style={{ fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:20, background:T.blueLt, color:T.blue }}>{p}</span>
                      ))}
                    </div>
                  </div>
                )}

                {c.notes && (
                  <div style={{ fontSize:11, color:T.slate600, lineHeight:1.6, padding:"8px 10px", background:T.slate50, borderRadius:8, marginBottom:10 }}>
                    {c.notes}
                  </div>
                )}

                <AskBtn size="small" context={`Agency-wide bonus structure review:\nStructure: ${c.structure_name}\nType: ${c.commission_type}\nRate: ${rateInfo.primary} ${rateInfo.suffix}\nQualifying products: ${(c.qualifying_products || []).join(", ")}\nNotes: ${c.notes || "(none)"}\n\nHelp me think through whether this bonus structure is still competitive given current production levels and the wider agency comp plan.`} />
              </Card>
            );
          })}
        </>
      )}

      {/* ─── Per-producer enrollment records ──────────────────── */}
      {perProducer.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.slate900, marginTop: 10, marginBottom: -4 }}>
            Per-Producer Enrollment
          </div>
          <div style={{ fontSize: 11, color: T.slate500, marginBottom: 4 }}>
            {perProducer.length} enrollment{perProducer.length === 1 ? "" : "s"} on the standard 2026 plan
          </div>
          {perProducer.map(c => {
            const rate = c.tiers?.[0]?.rate;
            const rateSet = rate != null;
            return (
              <Card key={c.id}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14, gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize:14, fontWeight:700, color:T.slate900 }}>{c.staff_name}</div>
                    <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>{c.structure_name} · Effective {c.effective_date}</div>
                  </div>
                  <div style={{ textAlign:"right", flexShrink: 0 }}>
                    {rateSet ? (
                      <>
                        <div style={{ fontSize:11, color:T.slate400, marginBottom:2 }}>Rate</div>
                        <div style={{ fontSize:20, fontWeight:700, color:T.blue }}>{rate}%</div>
                      </>
                    ) : (
                      <span style={{ fontSize: 10, fontWeight: 600, padding: "4px 10px", borderRadius: 20, background: T.amberLt, color: "#92400E" }}>
                        Pending confirmation
                      </span>
                    )}
                  </div>
                </div>

                {c.qualifying_products?.length > 0 && (
                  <div style={{ marginBottom:12 }}>
                    <div style={{ fontSize:11, fontWeight:600, color:T.slate600, marginBottom:6 }}>Qualifying products</div>
                    <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                      {c.qualifying_products.map(p => (
                        <span key={p} style={{ fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:20, background:T.slate100, color:T.slate600 }}>{p}</span>
                      ))}
                    </div>
                  </div>
                )}

                {c.notes && (
                  <div style={{ fontSize:11, color:T.slate600, lineHeight:1.6, padding:"8px 10px", background:T.slate50, borderRadius:8, marginBottom:10 }}>
                    {c.notes}
                  </div>
                )}
              </Card>
            );
          })}
        </>
      )}

      {/* ─── Producer P&L (from earlier move-off Performance tab) ─ */}
      <div style={{ fontSize: 13, fontWeight: 700, color: T.slate900, marginTop: 10, marginBottom: -4 }}>
        Producer P&L (renewal-adjusted profitability model)
      </div>
      <ProducerPnLSection roi={roi} />
    </div>
  );
};

export default function HRPeople() {
  const { data: roi } = useProducerROI();
  const useMockData = import.meta.env.VITE_USE_MOCK_DATA !== "false";
  const [section,     setSection]     = useState("overview");
  const [applicants,  setApplicants]  = useState(useMockData ? MOCK_APPLICANTS : []);
  const [staff,       setStaff]       = useState(useMockData ? MOCK_STAFF : []);
  const [onboarding,  setOnboarding]  = useState(useMockData ? MOCK_ONBOARDING : []);
  const [commissions, setCommissions] = useState(useMockData ? MOCK_COMMISSIONS : []);
  const [coachingNotes, setCoachingNotes] = useState([]);
  const [staffPerformance, setStaffPerformance] = useState([]);
  const [timeMonthly, setTimeMonthly] = useState([]);
  const [activityMonthly, setActivityMonthly] = useState([]);
  const [scoreboardGoals, setScoreboardGoals] = useState([]);
  const [currentUserStaffId, setCurrentUserStaffId] = useState(null);

  const updateApplicantStage = (id, newStatus) => {
    setApplicants(prev => prev.map(a => a.id === id ? {...a, status:newStatus} : a));
  };

  // Load HR data live from Supabase. Shape transformations handle DB schema differences
  // (license_states, tiers, etc. don't exist in DB) so sub-components don't crash.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!supabase || !AGENCY_ID) return;
      try {
        const [staffRes, applicantsRes, onboardingRes, commissionsRes,
                coachingRes, perfRes, timeRes, activityRes, goalsRes] = await Promise.all([
          supabase.from("staff")
            .select("id, first_name, last_name, role, employment_type, start_date, end_date, hire_date, is_active, email, phone, pay_type, pay_rate, auth_user_id, notes")
            .eq("agency_id", AGENCY_ID),
          supabase.from("applicants")
            .select("id, first_name, last_name, email, phone, claude_score, claude_summary, interview_focus_doc, source, status, created_at")
            .eq("agency_id", AGENCY_ID)
            .order("created_at", { ascending: false }),
          supabase.from("onboarding_checklists")
            .select("id, staff_id, template_type, item_name, category, due_date, completed_at, is_required")
            .eq("agency_id", AGENCY_ID),
          supabase.from("commission_structures")
            .select("id, staff_id, structure_name, effective_date, commission_type, rate, cap, qualifying_products, notes, is_active")
            .eq("agency_id", AGENCY_ID).eq("is_active", true),
          supabase.from("coaching_notes")
            .select("id, staff_id, note_date, note_text, category, follow_up_date, resolved_at, created_by_staff_id")
            .eq("agency_id", AGENCY_ID)
            .order("note_date", { ascending: false }),
          supabase.from("staff_performance")
            .select("staff_id, period_year, period_month, metric_name, actual")
            .eq("agency_id", AGENCY_ID),
          supabase.from("v_time_tracking_monthly_by_producer")
            .select("*")
            .eq("agency_id", AGENCY_ID),
          supabase.from("v_sales_activity_monthly_by_producer")
            .select("*")
            .eq("agency_id", AGENCY_ID),
          supabase.from("scoreboard_goals")
            .select("id, goal_type, goal_period, period_start, period_end, target_value, producer_id")
            .eq("agency_id", AGENCY_ID)
            .is("producer_id", null),
        ]);
        if (cancelled) return;

        // Staff: enrich with display-only fields the sub-component expects
        if (Array.isArray(staffRes.data) && staffRes.data.length > 0) {
          const enriched = staffRes.data.map(s => {
            const roleStr = (s.role || "").toLowerCase();
            const isLicensed = roleStr.includes("producer") || roleStr.includes("agent") || roleStr.includes("licensed");
            return {
              ...s,
              licensed: isLicensed,
              license_states: isLicensed ? ["GA"] : [],
              compliance_flag: null,
              pay_rate: s.pay_rate != null ? Number(s.pay_rate) : 0,
              pay_type: s.pay_type || "salary",
            };
          });
          setStaff(enriched);
        }

        // Applicants: map interview_focus_doc -> interview_focus, position fallback
        if (Array.isArray(applicantsRes.data) && applicantsRes.data.length > 0) {
          const mapped = applicantsRes.data.map(a => ({
            ...a,
            position: a.position || "Open Position",
            interview_focus: a.interview_focus_doc || "",
          }));
          setApplicants(mapped);
        }

        // Onboarding: group flat rows by staff_id to match nested mock shape
        if (Array.isArray(onboardingRes.data) && onboardingRes.data.length > 0 && Array.isArray(staffRes.data)) {
          const staffById = Object.fromEntries((staffRes.data || []).map(s => [s.id, s]));
          const grouped = {};
          for (const row of onboardingRes.data) {
            const sid = row.staff_id;
            if (!grouped[sid]) {
              const s = staffById[sid] || {};
              grouped[sid] = {
                staff_id: sid,
                staff_name: s.first_name ? `${s.first_name} ${s.last_name}` : "Unknown",
                start_date: s.start_date || "",
                template: row.template_type || "standard",
                days_employed: s.start_date
                  ? Math.floor((Date.now() - new Date(s.start_date)) / (1000*60*60*24))
                  : 0,
                items: [],
              };
            }
            grouped[sid].items.push({
              category: row.category || "general",
              item: row.item_name || "",
              completed: row.completed_at != null,
              due: row.due_date || "",
            });
          }
          setOnboarding(Object.values(grouped));
        }

        // Commissions: transform DB row -> mock-compatible shape (single-tier wrapper, staff_name lookup)
        if (Array.isArray(commissionsRes.data) && commissionsRes.data.length > 0) {
          const staffById = Object.fromEntries((staffRes.data || []).map(s => [s.id, s]));
          const mapped = commissionsRes.data.map(c => {
            const s = staffById[c.staff_id] || {};
            const rate = c.rate != null ? Number(c.rate) : null;
            // Wrap single rate as single-element tiers array. Empty when rate is unset.
            const tiers = rate != null
              ? [{ min: 0, max: c.cap != null ? Number(c.cap) : null, rate }]
              : [];
            return {
              id: c.id,
              staff_id: c.staff_id,
              staff_name: s.first_name ? `${s.first_name} ${s.last_name}` : "Unassigned",
              structure_name: c.structure_name || "Commission Structure",
              effective_date: c.effective_date || "",
              commission_type: c.commission_type || "flat",
              tiers,
              qualifying_products: Array.isArray(c.qualifying_products) ? c.qualifying_products : [],
              notes: c.notes || (rate == null ? "Rate pending — the agent to set in next CPA review." : ""),
              ytd_earned: 0,
              this_month: 0,
            };
          });
          setCommissions(mapped);
        }

        // Performance-tab data sources
        if (Array.isArray(coachingRes?.data)) setCoachingNotes(coachingRes.data);
        if (Array.isArray(perfRes?.data))     setStaffPerformance(perfRes.data);
        if (Array.isArray(timeRes?.data))     setTimeMonthly(timeRes.data);
        if (Array.isArray(activityRes?.data)) setActivityMonthly(activityRes.data);
        if (Array.isArray(goalsRes?.data))    setScoreboardGoals(goalsRes.data);

        // Resolve current user's staff.id (for coaching_notes.created_by_staff_id)
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (session?.user && Array.isArray(staffRes.data)) {
            const me = staffRes.data.find(s => s.auth_user_id === session.user.id);
            if (me) setCurrentUserStaffId(me.id);
          }
        } catch { /* ignore auth resolution failures */ }
      } catch (e) {
        console.error("HRPeople load error:", e);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const sections = [
    { id:"overview",    label:"Overview"    },
    { id:"recruiting",  label:"Recruiting"  },
    { id:"onboarding",  label:"Onboarding"  },
    { id:"staff",       label:"Staff"       },
    { id:"performance", label:"Performance" },
    { id:"commissions", label:"Commissions" },
  ];

  return (
    <div>
      {/* Module Header */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:16 }}>
        <div>
          <div style={{ fontSize:20, fontWeight:700, color:T.slate900, letterSpacing:"-0.02em" }}>HR & People</div>
          <div style={{ fontSize:12, color:T.slate500, marginTop:3 }}>
            {staff.filter(s=>s.is_active).length} active staff · {applicants.filter(a=>!["hired","rejected"].includes(a.status)).length} applicants in pipeline · Resume scanner active
          </div>
        </div>
        <AskBtn context="Give me a complete HR review. How is my recruiting pipeline looking? Any compliance concerns with my current team? What HR actions should I take this week?" />
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
      {section === "overview"    && <HROverview        applicants={applicants} staff={staff} onboarding={onboarding} />}
      {section === "recruiting"  && <RecruitingPipeline applicants={applicants} onUpdate={updateApplicantStage} />}
      {section === "staff"       && <StaffDirectory     staff={staff} />}
      {section === "onboarding"  && <OnboardingSection  onboarding={onboarding} />}
      {section === "performance" && <PerformanceSection
        staff={staff}
        coachingNotes={coachingNotes}
        staffPerformance={staffPerformance}
        timeMonthly={timeMonthly}
        activityMonthly={activityMonthly}
        scoreboardGoals={scoreboardGoals}
        currentUserStaffId={currentUserStaffId}
        onNoteAdded={async () => {
          const { data } = await supabase.from("coaching_notes")
            .select("id, staff_id, note_date, note_text, category, follow_up_date, resolved_at, created_by_staff_id")
            .eq("agency_id", AGENCY_ID)
            .order("note_date", { ascending: false });
          if (Array.isArray(data)) setCoachingNotes(data);
        }}
      />}
      {section === "commissions" && <CommissionsSection  commissions={commissions} roi={roi} />}
    </div>
  );
}
