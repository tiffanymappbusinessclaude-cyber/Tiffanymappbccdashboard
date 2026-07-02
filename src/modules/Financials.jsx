import { useState, useEffect, useRef } from "react";
import { supabase, AGENCY_ID } from "../lib/supabase.js";

// ============================================================
// BCC FINANCIALS MODULE v1.0
// Business Command Center — State Farm Agent Edition
// Built by Imaginary Farms LLC · imaginary-farms.com
//
// SECTIONS:
//   1. Overview        — Summary cards + revenue trend chart
//   2. P&L             — Monthly/quarterly/annual P&L
//   3. COMP_RECAP      — SF compensation detail by period
//   4. AIPP & ScoreBoard — Progress tracking
//   5. Payroll         — Staff payroll history
//   6. Bank Accounts   — Account balances and reconciliation
//   7. Credit & Debt   — Cards, loans, lines of credit
//   8. General Ledger  — Full transaction ledger
//
// DATA: Reads directly from Supabase via useFinancialsData() below.
//       Sources: cpa_pnl_monthly, comp_recap, bank_accounts,
//       credit_accounts, journal_lines (+ journal_entries +
//       chart_of_accounts), payroll_runs, payroll_detail,
//       aipp_tracking, scoreboard_tracking, and the
//       vw_bcc_vs_cpa_commission_variance view (migration 020).
// ============================================================


// ─── Design Tokens (matches BCCApp shell) ────────────────────

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

// ─── Live Supabase Data Hook ─────────────────────────────────
// Reads cpa_pnl_monthly as the authoritative P&L source (accrual, CPA aligned),
// comp_recap for monthly revenue chart, plus bank/credit/payroll/aipp/GL tables.
//
// PRINCIPLE: Phase 1 (Jan 2025 - latest CPA close) lives in cpa_pnl_monthly
// and is read-only. Phase 2 (post May 2026) lives in journal_entries via
// the live system, but most months still come from CPA until the cutover
// year-end reconciliation closes the gap.

function useFinancialsData() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const today        = new Date();
        const currentYear  = today.getFullYear();
        const priorYear    = currentYear - 1;
        const currentMonth = today.getMonth() + 1;
        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

        const [
          pnlCurRes, pnlPriorRes,
          compRes, bankRes, ccRes, glRes,
          payrollRunsRes, payrollDetailRes,
          aippRes, scoreboardRes,
          reconRes,
        ] = await Promise.all([
          // Current year P&L — CPA monthly + YTD (period_month=13)
          supabase.from("cpa_pnl_monthly")
            .select("period_year,period_month,section,parent_account,account_name,amount,is_subtotal,notes")
            .eq("agency_id", AGENCY_ID)
            .eq("period_year", currentYear)
            .eq("is_subtotal", false),

          // Prior year monthly P&L for YoY + chart
          supabase.from("cpa_pnl_monthly")
            .select("period_year,period_month,section,parent_account,account_name,amount,is_subtotal")
            .eq("agency_id", AGENCY_ID)
            .eq("period_year", priorYear)
            .eq("is_subtotal", false),

          // SF comp recap — cash basis revenue stream, broken out by half-month
          supabase.from("comp_recap")
            .select("period_year,period_month,period_half,comp_type,comp_category,description,amount,is_aipp_eligible,is_scoreboard_eligible,entry_date")
            .eq("agency_id", AGENCY_ID)
            .order("period_year", { ascending: false })
            .order("period_month", { ascending: false })
            .limit(2000),

          // Bank
          supabase.from("bank_accounts")
            .select("account_name,current_balance,as_of_date,account_type,account_number_last4,institution")
            .eq("agency_id", AGENCY_ID),

          // Credit
          supabase.from("credit_accounts")
            .select("account_name,current_balance,as_of_date,updated_at,account_type,account_number_last4,credit_limit,available_credit,interest_rate,minimum_payment,payment_due_day,institution")
            .eq("agency_id", AGENCY_ID),

          // GL — recent journal lines + entries
          supabase.from("journal_lines")
            .select(`debit,credit,created_at,
              journal_entries!inner ( entry_date, reference_number, description, source, agency_id ),
              chart_of_accounts!inner ( account_name )`)
            .eq("journal_entries.agency_id", AGENCY_ID)
            .order("created_at", { ascending: false })
            .limit(80),

          // Payroll (still empty as of session log)
          supabase.from("payroll_runs")
            .select("id,pay_period_start,pay_period_end,pay_date,payroll_provider,gross_payroll,employer_taxes,net_payroll,status")
            .eq("agency_id", AGENCY_ID)
            .order("pay_date", { ascending: false }).limit(24),

          supabase.from("payroll_detail")
            .select("payroll_run_id,gross_pay,federal_tax,state_tax,social_security,medicare,other_deductions,net_pay,employment_type"),

          // AIPP
          supabase.from("aipp_tracking")
            .select("program_year,target_amount,earned_ytd,projected_full_year,achievement_percentage,notes")
            .eq("agency_id", AGENCY_ID)
            .eq("program_year", currentYear)
            .maybeSingle(),

          // ScoreBoard (still empty as of session log)
          supabase.from("scoreboard_tracking")
            .select("program_year,period,metric_name,target,actual,achievement_percentage,notes")
            .eq("agency_id", AGENCY_ID)
            .order("program_year", { ascending: false }).limit(20),

          // BCC vs CPA Commission reconciliation (view from migration 020).
          // Monthly net_payable vs CPA SF-earned. Surfaces Phase 2 data gaps.
          supabase.from("vw_bcc_vs_cpa_commission_variance")
            .select("period_year,period_month,cpa_sf_earned,cpa_non_sf,bcc_net_payable,bcc_line_items_only,variance_netpay_minus_cpa,variance_netpay_pct")
            .eq("agency_id", AGENCY_ID)
            .order("period_year", { ascending: false })
            .order("period_month", { ascending: false })
            .limit(36),
        ]);

        const pnlCur   = pnlCurRes.data   || [];
        const pnlPrior = pnlPriorRes.data || [];
        const compRecapsRaw = compRes.data || [];

        // ─── Build P&L lines for current year ───
        // cpa_pnl_monthly stores 2026 at period_month=13 (YTD) and prior years at 1..12.
        // For current year, prefer period_month=13; if absent, sum months 1..currentMonth.
        const curIsYTDRow = pnlCur.some(r => r.period_month === 13);
        const incomeRows = (curIsYTDRow
          ? pnlCur.filter(r => r.period_month === 13 && r.section === "Income")
          : pnlCur.filter(r => r.section === "Income" && r.period_month <= currentMonth)
        );
        const expenseRows = (curIsYTDRow
          ? pnlCur.filter(r => r.period_month === 13 && r.section === "Expenses")
          : pnlCur.filter(r => r.section === "Expenses" && r.period_month <= currentMonth)
        );

        const collapse = (rows) => {
          const byName = {};
          for (const r of rows) {
            const k = r.account_name;
            byName[k] = byName[k] || { name: k, parent: r.parent_account, ytd: 0 };
            byName[k].ytd += parseFloat(r.amount || 0);
          }
          return Object.values(byName).sort((a,b) => b.ytd - a.ytd);
        };

        const incomeLines  = collapse(incomeRows);
        const expenseLines = collapse(expenseRows);

        // Pull notes / period label from current year row if present
        const ytdLabel = pnlCur.find(r => r.notes)?.notes || `Jan 1 – ${months[currentMonth-1]} ${today.getDate()}, ${currentYear}`;

        const revenueYTD  = incomeLines.reduce((s,r) => s + r.ytd, 0);
        const expensesYTD = expenseLines.reduce((s,r) => s + r.ytd, 0);
        const netYTD      = revenueYTD - expensesYTD;

        // ─── Prior-year same-period for YoY ───
        // Sum prior-year months 1..currentMonth-1 (full closed months) since 2026 YTD
        // through Jun 9 is roughly 5 closed months + partial June.
        const priorEndMonth = Math.max(1, currentMonth - 1);
        const priorIncomeRows  = pnlPrior.filter(r => r.section === "Income"   && r.period_month >= 1 && r.period_month <= priorEndMonth);
        const priorExpenseRows = pnlPrior.filter(r => r.section === "Expenses" && r.period_month >= 1 && r.period_month <= priorEndMonth);
        const priorRevenueSamePeriod  = priorIncomeRows.reduce((s,r) => s + parseFloat(r.amount || 0), 0);
        const priorExpensesSamePeriod = priorExpenseRows.reduce((s,r) => s + parseFloat(r.amount || 0), 0);
        const priorNetSamePeriod      = priorRevenueSamePeriod - priorExpensesSamePeriod;

        const priorIncomeFull  = pnlPrior.filter(r => r.section === "Income"   && r.period_month >= 1 && r.period_month <= 12);
        const priorExpenseFull = pnlPrior.filter(r => r.section === "Expenses" && r.period_month >= 1 && r.period_month <= 12);
        const priorRevenueFull  = priorIncomeFull.reduce((s,r) => s + parseFloat(r.amount || 0), 0);
        const priorExpensesFull = priorExpenseFull.reduce((s,r) => s + parseFloat(r.amount || 0), 0);

        const yoy = (curr, prior) => (prior && Number.isFinite(prior) && prior !== 0)
          ? ((curr - prior) / prior) * 100
          : null;

        // ─── Ratios ───
        const payrollAccounts = ["Payroll - Employee Wages","Payroll Taxes","Payroll Expenses","Officer Salary"];
        const payrollYTD = expenseLines
          .filter(r => payrollAccounts.includes(r.name))
          .reduce((s,r) => s + r.ytd, 0);
        const payrollRatioYTD = revenueYTD > 0 ? (payrollYTD / revenueYTD) * 100 : null;
        const expenseRatioYTD = revenueYTD > 0 ? (expensesYTD / revenueYTD) * 100 : null;

        // ─── Monthly revenue chart ───
        // For current year: revenue from comp_recap (broken out monthly), expenses from
        // prior year's pattern (until 2026 monthly CPA P&L arrives).
        const monthlyRevenue = months.map((m, i) => {
          const mo = i + 1;
          const rev = compRecapsRaw
            .filter(r => r.period_year === currentYear && r.period_month === mo)
            .filter(r => r.comp_type !== "net_payable")  // net_payable is a summary row, would double-count
            .reduce((s,r) => s + parseFloat(r.amount || 0), 0);
          const priorExp = pnlPrior
            .filter(r => r.section === "Expenses" && r.period_month === mo)
            .reduce((s,r) => s + parseFloat(r.amount || 0), 0);
          return {
            month: m, monthNum: mo,
            revenue: Math.round(rev),
            expenses: 0,           // CPA monthly expenses not available for current year; chart shows revenue only
            priorYearExpenses: Math.round(priorExp),
            isCurrent: mo === currentMonth,
            isFuture: mo > currentMonth,
          };
        });

        // ─── Comp recap detail (excluding net_payable summary rows for the table) ───
        const compRecaps = compRecapsRaw
          .filter(r => r.comp_type !== "net_payable")
          .map(r => ({
            period_year:  r.period_year,
            period_month: r.period_month,
            period_half:  r.period_half,
            period_label: `${months[r.period_month-1]} ${r.period_year}`,
            comp_type:    r.comp_type,
            comp_category: r.comp_category,
            description:  r.description || `${r.comp_type} — ${r.comp_category}`,
            amount:       parseFloat(r.amount || 0),
            is_aipp_eligible: r.is_aipp_eligible,
            is_scoreboard_eligible: r.is_scoreboard_eligible,
          }));

        // ─── AIPP — keep shape AIPPSection expects ───
        const aippRaw = aippRes.data || null;
        const aippMonthlyEarned = months.map((m, i) => {
          const mo = i + 1;
          const earned = compRecapsRaw
            .filter(r => r.period_year === currentYear && r.period_month === mo && r.is_aipp_eligible)
            .filter(r => r.comp_type !== "net_payable")
            .reduce((s,r) => s + parseFloat(r.amount || 0), 0) * 0.05;  // 5% AIPP
          return { month: m, amount: Math.round(earned) };
        });
        const priorYearAIPP = pnlPrior
          .filter(r => r.section === "Income" && /AIPP/i.test(r.account_name || ""))
          .reduce((s,r) => s + parseFloat(r.amount || 0), 0);

        const aipp = {
          year:          aippRaw?.program_year || currentYear,
          target:        parseFloat(aippRaw?.target_amount || 0) || 0,
          earned:        parseFloat(aippRaw?.earned_ytd || 0) || 0,
          projected:     parseFloat(aippRaw?.projected_full_year || 0) || 0,
          priorYear:     priorYearAIPP || 0,
          monthlyEarned: aippMonthlyEarned,
          targetIsPlaceholder: !aippRaw?.target_amount || parseFloat(aippRaw.target_amount) === 50000,
        };

        // ─── ScoreBoard ───
        const scoreboardRows = scoreboardRes.data || [];
        const scoreboard = scoreboardRows.map(s => ({
          metric: s.metric_name,
          actual: parseFloat(s.actual || 0),
          target: parseFloat(s.target || 0),
          pct:    Math.round(parseFloat(s.achievement_percentage || 0)),
        }));

        // ─── Payroll ───
        const detailByRun = {};
        for (const d of (payrollDetailRes.data || [])) {
          (detailByRun[d.payroll_run_id] ||= []).push(d);
        }
        const payroll = (payrollRunsRes.data || []).map(run => {
          const startStr = run.pay_period_start ? new Date(run.pay_period_start).toLocaleDateString("en-US",{month:"short",day:"numeric"}) : "";
          const endStr   = run.pay_period_end   ? new Date(run.pay_period_end).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "";
          const dateStr  = run.pay_date         ? new Date(run.pay_date).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "";
          return {
            pay_period: `${startStr} – ${endStr}`,
            pay_date:   dateStr,
            gross:      parseFloat(run.gross_payroll || 0),
            taxes:      parseFloat(run.employer_taxes || 0),
            net:        parseFloat(run.net_payroll || 0),
            status:     run.status || "paid",
            provider:   run.payroll_provider,
          };
        });

        // ─── Bank ───
        const bankAccounts = (bankRes.data || []).map(b => ({
          name:        b.account_name,
          balance:     parseFloat(b.current_balance || 0),
          asOf:        b.as_of_date,
          type:        b.account_type,
          last4:       b.account_number_last4,
          institution: b.institution,
        }));

        // ─── Credit ───
        const creditAccounts = (ccRes.data || []).map(c => ({
          name:        c.account_name,
          balance:     parseFloat(c.current_balance || 0),
          asOf:        c.as_of_date || c.updated_at,
          type:        c.account_type,
          last4:       c.account_number_last4,
          institution: c.institution,
          limit:       (c.credit_limit != null) ? parseFloat(c.credit_limit) : null,
          rate:        (c.interest_rate != null) ? parseFloat(c.interest_rate) : null,
          payment:     (c.minimum_payment != null) ? parseFloat(c.minimum_payment) : null,
          dueDay:      c.payment_due_day,
        }));

        // ─── GL recent entries ───
        const glEntries = (glRes.data || []).slice(0, 50).map(g => ({
          date:        g.journal_entries?.entry_date,
          ref:         g.journal_entries?.reference_number,
          description: g.journal_entries?.description,
          source:      g.journal_entries?.source,
          account:     g.chart_of_accounts?.account_name,
          debit:       parseFloat(g.debit  || 0),
          credit:      parseFloat(g.credit || 0),
        }));

        // ─── BCC vs CPA Commission Reconciliation ───
        // Maps view rows to a UI-friendly shape. Most-recent month first.
        const reconciliation = (reconRes.data || []).map(r => ({
          year:           r.period_year,
          month:          r.period_month,
          monthLabel:     `${months[(r.period_month - 1) % 12] || "?"} ${r.period_year}`,
          cpaSfEarned:    (r.cpa_sf_earned    != null) ? parseFloat(r.cpa_sf_earned)    : null,
          bccNetPayable:  (r.bcc_net_payable  != null) ? parseFloat(r.bcc_net_payable)  : null,
          bccLineItems:   (r.bcc_line_items_only != null) ? parseFloat(r.bcc_line_items_only) : null,
          variance:       (r.variance_netpay_minus_cpa != null) ? parseFloat(r.variance_netpay_minus_cpa) : null,
          variancePct:    (r.variance_netpay_pct != null) ? parseFloat(r.variance_netpay_pct) : null,
        }));

        setData({
          asOfLabel: ytdLabel,
          currentYear,
          priorYear,
          summary: {
            revenueYTD:               Math.round(revenueYTD),
            expensesYTD:              Math.round(expensesYTD),
            netYTD:                   Math.round(netYTD),
            priorRevenueSamePeriod:   Math.round(priorRevenueSamePeriod),
            priorExpensesSamePeriod:  Math.round(priorExpensesSamePeriod),
            priorNetSamePeriod:       Math.round(priorNetSamePeriod),
            priorRevenueFull:         Math.round(priorRevenueFull),
            priorExpensesFull:        Math.round(priorExpensesFull),
            yoyRevenuePct:            yoy(revenueYTD, priorRevenueSamePeriod),
            yoyNetPct:                yoy(netYTD, priorNetSamePeriod),
            expenseRatioYTD,
            payrollRatioYTD,
            payrollYTD:               Math.round(payrollYTD),
            priorEndMonth,
          },
          monthlyRevenue,
          pl: {
            asOfLabel:   ytdLabel,
            income:      incomeLines,
            expenses:    expenseLines,
            priorIncomeFull,
            priorExpenseFull,
          },
          compRecaps,
          aipp,
          scoreboard,
          bankAccounts,
          creditAccounts,
          glEntries,
          payroll,
          reconciliation,
        });
      } catch (e) {
        console.error("Financials load error:", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  return { data, loading };
}



// Empty shape used while the live data hook is still loading.
const EMPTY_DATA = {
  asOfLabel: "Loading…",
  currentYear: new Date().getFullYear(),
  priorYear:   new Date().getFullYear() - 1,
  summary: { revenueYTD:0, expensesYTD:0, netYTD:0, priorRevenueSamePeriod:0, priorExpensesSamePeriod:0, priorNetSamePeriod:0, priorRevenueFull:0, priorExpensesFull:0, yoyRevenuePct:null, yoyNetPct:null, expenseRatioYTD:null, payrollRatioYTD:null, payrollYTD:0, priorEndMonth:0 },
  monthlyRevenue: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map((m,i)=>({month:m,monthNum:i+1,revenue:0,expenses:0,priorYearExpenses:0,isCurrent:false,isFuture:false})),
  pl: { asOfLabel: "Loading…", income:[], expenses:[], priorIncomeFull:[], priorExpenseFull:[] },
  compRecaps: [],
  aipp: { year: new Date().getFullYear(), target:0, earned:0, projected:0, priorYear:0, monthlyEarned:["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map(m=>({month:m,amount:0})), targetIsPlaceholder:true },
  scoreboard: [],
  bankAccounts: [],
  creditAccounts: [],
  glEntries: [],
  payroll: [],
  reconciliation: [],
};

// ─── Helpers ─────────────────────────────────────────────────
const fmt = (n) => { const v = Number(n); if (!Number.isFinite(v)) return "—"; if (v === 0) return "—"; return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 0 }); };
const pct  = (n, t) => t ? Math.round((n / t) * 100) : 0;
const yoy  = (curr, prior) => prior ? (((curr - prior) / prior) * 100).toFixed(1) : null;

// ─── Shared Components ───────────────────────────────────────
const Card = ({ children, style = {} }) => (
  <div style={{
    background: T.white,
    border: `1px solid ${T.slate200}`,
    borderRadius: 12,
    padding: "16px 18px",
    ...style,
  }}>
    {children}
  </div>
);

const CardHeader = ({ title, sub, action }) => (
  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: T.slate800 }}>{title}</div>
      {sub && <div style={{ fontSize: 11, color: T.slate500, marginTop: 2 }}>{sub}</div>}
    </div>
    {action}
  </div>
);

const KPICard = ({ label, value, sub, color = T.slate900, border }) => (
  <div style={{
    background: T.white,
    border: `1px solid ${border || T.slate200}`,
    borderRadius: 12,
    padding: "14px 16px",
    borderTop: border ? `3px solid ${border}` : undefined,
  }}>
    <div style={{ fontSize: 11, color: T.slate500, fontWeight: 500, marginBottom: 6 }}>{label}</div>
    <div style={{ fontSize: 20, fontWeight: 700, color, letterSpacing: "-0.02em", marginBottom: 4 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: T.slate400 }}>{sub}</div>}
  </div>
);

const Pill = ({ children, type = "info" }) => {
  const map = {
    success: { bg: T.greenLt,  color: "#065F46" },
    warning: { bg: T.amberLt,  color: "#92400E" },
    danger:  { bg: T.redLt,    color: "#991B1B" },
    info:    { bg: T.blueLt,   color: "#1E40AF" },
    purple:  { bg: T.purpleLt, color: "#5B21B6" },
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
  <div style={{
    display: "flex", gap: 2,
    background: T.slate100,
    borderRadius: 8, padding: 3,
    marginBottom: 16,
    flexWrap: "wrap",
  }}>
    {tabs.map(t => (
      <button key={t.id} onClick={() => onChange(t.id)} style={{
        padding: "6px 14px", fontSize: 12, fontWeight: active === t.id ? 600 : 400,
        color: active === t.id ? T.slate900 : T.slate500,
        background: active === t.id ? T.white : "transparent",
        border: "none", borderRadius: 6, cursor: "pointer",
        transition: "all 0.12s",
        boxShadow: active === t.id ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
      }}>{t.label}</button>
    ))}
  </div>
);

// ─── Mini Bar Chart ──────────────────────────────────────────
const MiniBarChart = ({ data }) => {
  const maxVal = Math.max(...data.map(d => Math.max(d.revenue, d.expenses)));
  const barH = 80;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: barH + 24 }}>
      {data.map((d, i) => (
        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 1, height: barH, justifyContent: "flex-end" }}>
            {d.revenue > 0 && (
              <div style={{
                width: "60%", background: T.blue, borderRadius: "2px 2px 0 0",
                height: `${(d.revenue / maxVal) * barH}px`,
                transition: "height 0.6s ease",
              }} />
            )}
            {d.revenue === 0 && (
              <div style={{ width: "60%", background: T.slate200, borderRadius: "2px 2px 0 0", height: 3 }} />
            )}
          </div>
          <div style={{ fontSize: 9, color: T.slate400 }}>{d.month}</div>
        </div>
      ))}
    </div>
  );
};

// ─── Progress Bar ────────────────────────────────────────────
const ProgressBar = ({ value, max, color = T.blue, height = 8 }) => {
  const p = Math.min(pct(value, max), 100);
  return (
    <div style={{ height, background: T.slate100, borderRadius: height / 2, overflow: "hidden" }}>
      <div style={{
        height: "100%", width: `${p}%`,
        background: color, borderRadius: height / 2,
        transition: "width 0.7s ease",
      }} />
    </div>
  );
};

// ─── Section: Overview ───────────────────────────────────────
const OverviewSection = ({ data }) => {
  const d = data?.summary || {};
  const yoyR = (d.yoyRevenuePct != null) ? d.yoyRevenuePct : null;
  const yoyN = (d.yoyNetPct != null) ? d.yoyNetPct : null;
  const expenseRatio = (d.expenseRatioYTD != null) ? Math.round(d.expenseRatioYTD) : null;
  const payrollRatio = (d.payrollRatioYTD != null) ? Math.round(d.payrollRatioYTD) : null;
  const asOf = data?.asOfLabel || "Year to date";
  const trend = (p) => (p == null) ? "" : `${p >= 0 ? "↑" : "↓"} ${Math.abs(p).toFixed(1)}%`;

  // Overview is YTD-only. cpa_pnl_monthly for the current year currently
  // reports YTD figures rather than true monthly breakouts, so period toggles
  // wouldn't be accurate for expenses. When monthly breakouts land, add a
  // period tab bar here (state can live in the parent) and wire the ratios.
  const incomeBreakdown = Array.isArray(data?.pl?.income) ? data.pl.income : [];

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
        <div style={{ fontSize:11, color:T.slate500, padding:"4px 10px", background:T.slate50, borderRadius:7, border:`1px solid ${T.slate200}` }}>
          As of {asOf}
        </div>
        <AskBtn context={`My agency YTD financials: Revenue $${d.revenueYTD}, Expenses $${d.expensesYTD}, Net Income $${d.netYTD}. YoY revenue ${yoyR?.toFixed(1) ?? "—"}%, YoY net ${yoyN?.toFixed(1) ?? "—"}%. Expense ratio ${expenseRatio ?? "—"}%. Payroll ratio ${payrollRatio ?? "—"}%. Help me analyze my financial performance.`} />
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(160px,1fr))", gap:10, marginBottom:16 }}>
        <KPICard label="Revenue YTD"   value={fmt(d.revenueYTD)} sub={yoyR != null ? `${trend(yoyR)} vs prior YTD` : "—"} color={T.blue}  border={T.blue} />
        <KPICard label="Expenses YTD"  value={fmt(d.expensesYTD)} sub="Accrual (CPA)" border={T.amber} />
        <KPICard label="Net Income YTD" value={fmt(d.netYTD)} sub={yoyN != null ? `${trend(yoyN)} vs prior YTD` : "—"} color={d.netYTD >= 0 ? T.green : T.red} border={d.netYTD >= 0 ? T.green : T.red} />
        <KPICard label="Expense Ratio" value={expenseRatio != null ? `${expenseRatio}%` : "—"} sub="Target <75%" border={expenseRatio != null && expenseRatio > 75 ? T.red : T.slate200} />
        <KPICard label="Payroll Ratio" value={payrollRatio != null ? `${payrollRatio}%` : "—"} sub={payrollRatio != null && payrollRatio > 55 ? "CRITICAL >55%" : "Target 40-50%"} color={payrollRatio != null && payrollRatio > 55 ? T.red : T.slate900} border={payrollRatio != null && payrollRatio > 55 ? T.red : T.slate200} />
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"minmax(0,1.4fr) minmax(0,1fr)", gap:12 }}>
        <Card>
          <CardHeader title={`Monthly revenue — ${data?.currentYear ?? new Date().getFullYear()}`} sub="From SF comp_recap · Live system data" />
          <MiniBarChart data={(data?.monthlyRevenue || []).map(m => ({ month:m.month, revenue:m.revenue, expenses:m.expenses }))} />
        </Card>

        <Card>
          <CardHeader title={`Income breakdown — ${asOf}`} sub={incomeBreakdown.length === 0 ? "Loading…" : null} />
          {(incomeBreakdown.length === 0) ? (
            <div style={{ fontSize:12, color:T.slate500, padding:"8px 0" }}>No income lines available yet.</div>
          ) : incomeBreakdown.map((item, i) => (
            <div key={i} style={{ marginBottom:10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, marginBottom:3 }}>
                <span style={{ color:T.slate600 }}>{item.name}{item.parent ? <span style={{ color:T.slate400 }}> — {item.parent}</span> : null}</span>
                <span style={{ fontWeight:600, color:T.slate900 }}>{fmt(item.ytd)}</span>
              </div>
              <ProgressBar value={item.ytd || 0} max={d.revenueYTD || 1} color={T.blue} />
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
};

// ─── Section: P&L ────────────────────────────────────────────
const PLSection = ({ data }) => {
  const pl = data?.pl || { income: [], expenses: [] };
  const summary = data?.summary || {};
  const incomeRows  = Array.isArray(pl.income)   ? pl.income   : [];
  const expenseRows = Array.isArray(pl.expenses) ? pl.expenses : [];
  const totalIncomeYTD = incomeRows.reduce((s,r) => s + (r?.ytd || 0), 0);
  const totalExpYTD    = expenseRows.reduce((s,r) => s + (r?.ytd || 0), 0);
  const asOf = pl?.asOfLabel || data?.asOfLabel || "Year to date";

  // Map prior-year full-year amounts by account name for the comparison column.
  const priorByName = {};
  (pl.priorIncomeFull || []).forEach(r => { priorByName[r.account_name] = (priorByName[r.account_name] || 0) + parseFloat(r.amount || 0); });
  (pl.priorExpenseFull || []).forEach(r => { priorByName[r.account_name] = (priorByName[r.account_name] || 0) + parseFloat(r.amount || 0); });
  const priorIncomeFullYear  = (pl.priorIncomeFull  || []).reduce((s,r) => s + parseFloat(r.amount || 0), 0);
  const priorExpenseFullYear = (pl.priorExpenseFull || []).reduce((s,r) => s + parseFloat(r.amount || 0), 0);

  const TRow = ({ label, current, prior, bold, indent, isTotal, isNeg, parent }) => (
    <tr style={{ background: isTotal ? T.slate50 : "transparent" }}>
      <td style={{ padding: "7px 8px", fontSize: 12, color: indent ? T.slate600 : T.slate800, paddingLeft: indent ? 24 : 8, fontWeight: bold ? 600 : 400 }}>
        {label}{parent ? <span style={{ color:T.slate400 }}> — {parent}</span> : null}
      </td>
      <td style={{ padding: "7px 8px", fontSize: 12, textAlign: "right", fontWeight: bold ? 600 : 400, color: isNeg ? T.red : bold ? T.slate900 : T.slate700 }}>{fmt(current)}</td>
      <td style={{ padding: "7px 8px", fontSize: 12, textAlign: "right", color: T.slate500 }}>{fmt(prior)}</td>
    </tr>
  );

  return (
    <Card>
      <CardHeader
        title="Profit & Loss Statement"
        sub={`Accrual basis · ${asOf}`}
        action={<AskBtn context={`My YTD P&L (${asOf}): Revenue $${totalIncomeYTD}, Expenses $${totalExpYTD}, Net Income $${totalIncomeYTD - totalExpYTD}. Expense ratio ${Math.round((totalExpYTD/totalIncomeYTD)*100)}%. Prior year full: Revenue $${Math.round(priorIncomeFullYear)}, Expenses $${Math.round(priorExpenseFullYear)}, Net $${Math.round(priorIncomeFullYear - priorExpenseFullYear)}. Help me analyze profitability and identify areas to improve.`} />}
      />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `2px solid ${T.slate200}` }}>
              <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "left" }}>Account</th>
              <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "right" }}>{(data?.currentYear ?? new Date().getFullYear())} YTD</th>
              <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "right" }}>{(data?.priorYear ?? new Date().getFullYear()-1)} full year</th>
            </tr>
          </thead>
          <tbody>
            <TRow label="INCOME" bold />
            {incomeRows.map((r,i) => (
              <TRow key={`inc-${i}`} label={r.name} parent={r.parent} current={r.ytd} prior={priorByName[r.name] || 0} indent />
            ))}
            <TRow label="Total Income" current={totalIncomeYTD} prior={priorIncomeFullYear} bold isTotal />

            <tr><td colSpan={3} style={{ padding: "6px 0" }} /></tr>

            <TRow label="EXPENSES" bold />
            {expenseRows.map((r,i) => (
              <TRow key={`exp-${i}`} label={r.name} parent={r.parent} current={r.ytd} prior={priorByName[r.name] || 0} indent />
            ))}
            <TRow label="Total Expenses" current={totalExpYTD} prior={priorExpenseFullYear} bold isTotal />

            <tr><td colSpan={3} style={{ padding: "2px 0", borderTop: `2px solid ${T.slate800}` }} /></tr>
            <TRow label="NET INCOME" current={totalIncomeYTD - totalExpYTD} prior={priorIncomeFullYear - priorExpenseFullYear} bold isTotal isNeg={(totalIncomeYTD - totalExpYTD) < 0} />
          </tbody>
        </table>
      </div>
      {summary.priorEndMonth ? (
        <div style={{ marginTop:12, padding:"8px 12px", background:T.slate50, borderRadius:8, fontSize:11, color:T.slate600 }}>
          YoY YTD comparison: this year ({asOf}) vs same-period prior year (Jan–{["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][summary.priorEndMonth-1]} {data?.priorYear}) → Revenue {summary.yoyRevenuePct != null ? `${summary.yoyRevenuePct >= 0 ? "↑" : "↓"} ${Math.abs(summary.yoyRevenuePct).toFixed(1)}%` : "—"}, Net {summary.yoyNetPct != null ? `${summary.yoyNetPct >= 0 ? "↑" : "↓"} ${Math.abs(summary.yoyNetPct).toFixed(1)}%` : "—"}.
        </div>
      ) : null}
    </Card>
  );
};

// ─── Section: COMP_RECAP ─────────────────────────────────────
const CompRecapSection = ({ data }) => {
  const compRecaps = Array.isArray(data?.compRecaps) ? data.compRecaps : [];
  const allPeriods = [...new Set(compRecaps.map(r => r?.period_label).filter(Boolean))];
  const [period, setPeriod] = useState("");
  // Initialize period to most recent once data arrives
  useEffect(() => {
    if (allPeriods.length > 0 && !allPeriods.includes(period)) {
      setPeriod(allPeriods[0]);
    }
  }, [allPeriods.join("|")]);
  const periods  = allPeriods;
  const filtered = compRecaps.filter(r => r.period_label === period);
  const total    = filtered.reduce((s,r) => s + parseFloat(r.amount || 0), 0);
  const aippTotal = filtered.filter(r => r.is_aipp_eligible).reduce((s,r) => s + parseFloat(r.amount || 0), 0);

  return (
    <Card>
      <CardHeader
        title="SF COMP_RECAP Detail"
        sub="State Farm compensation breakdown by period"
        action={<AskBtn context={`My SF COMP_RECAP for ${period}: Total ${fmt(total)}. AIPP eligible: ${fmt(aippTotal)}. Help me reconcile this to my GL and confirm my AIPP calculation.`} />}
      />
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {periods.map(p => (
          <button key={p} onClick={() => setPeriod(p)} style={{
            padding: "5px 12px", fontSize: 11, fontWeight: period===p ? 600 : 400,
            color: period===p ? T.white : T.slate600,
            background: period===p ? T.navy : T.white,
            border: `1px solid ${period===p ? T.navy : T.slate200}`,
            borderRadius: 6, cursor: "pointer",
          }}>{p}</button>
        ))}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${T.slate200}` }}>
            <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "left" }}>Compensation Type</th>
            <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "center" }}>AIPP Eligible</th>
            <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "right" }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((r,i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${T.slate100}` }}>
              <td style={{ padding: "8px 8px", fontSize: 12, color: T.slate800 }}>{r.description}</td>
              <td style={{ padding: "8px 8px", textAlign: "center" }}>
                {r.is_aipp_eligible
                  ? <Pill type="success">AIPP</Pill>
                  : <span style={{ fontSize: 11, color: T.slate400 }}>—</span>}
              </td>
              <td style={{ padding: "8px 8px", fontSize: 12, fontWeight: 600, color: T.slate900, textAlign: "right" }}>{fmt(Math.round(r.amount))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: `2px solid ${T.slate800}` }}>
            <td style={{ padding: "8px 8px", fontSize: 12, fontWeight: 700, color: T.slate900 }}>Total</td>
            <td style={{ padding: "8px 8px", fontSize: 11, textAlign: "center", color: T.slate500 }}>AIPP: {fmt(aippTotal)}</td>
            <td style={{ padding: "8px 8px", fontSize: 13, fontWeight: 700, color: T.blue, textAlign: "right" }}>{fmt(total)}</td>
          </tr>
        </tfoot>
      </table>
    </Card>
  );
};

// ─── Section: AIPP & ScoreBoard ──────────────────────────────
const AIPPSection = ({ data }) => {
  const aippData = data?.aipp || {};
  const year       = aippData.year       || new Date().getFullYear();
  const target     = aippData.target     || 0;
  const earned     = aippData.earned     || 0;
  const projected  = aippData.projected  || 0;
  const priorYear  = aippData.priorYear  || 0;
  const monthlyEarned = Array.isArray(aippData.monthlyEarned) ? aippData.monthlyEarned : [];
  const scoreboard    = Array.isArray(data?.scoreboard) ? data.scoreboard : [];
  const achievement = pct(earned, target);
  const projPct = pct(projected, target);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12 }}>

        {/* AIPP Progress */}
        <Card>
          <CardHeader
            title={`AIPP ${year} — Annual Incentive Progress`}
            action={<AskBtn context={`AIPP ${year}: Target ${fmt(target)}, Earned YTD ${fmt(earned)}, Achievement ${achievement}%, Projected ${fmt(projected)}, Prior Year ${fmt(priorYear)}. Am I on track? What do I need to focus on?`} />}
          />
          <div style={{ fontSize: 32, fontWeight: 700, color: T.green, letterSpacing: "-0.03em", marginBottom: 4 }}>
            {achievement}%
          </div>
          <div style={{ fontSize: 12, color: T.slate500, marginBottom: 12 }}>
            {fmt(earned)} earned of {fmt(target)} target
          </div>
          <ProgressBar value={earned} max={target} color={T.green} height={10} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: T.slate400, marginTop: 6, marginBottom: 16 }}>
            <span>Jan {year}</span><span>Dec {year}</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[
              { label: "Earned YTD",    value: fmt(earned),    color: T.green },
              { label: "Projected",     value: fmt(projected), color: projPct >= 95 ? T.green : T.amber },
              { label: "Prior Year",    value: fmt(priorYear), color: T.slate500 },
            ].map((s,i) => (
              <div key={i} style={{ background: T.slate50, borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
                <div style={{ fontSize: 10, color: T.slate500, marginBottom: 4 }}>{s.label}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: T.slate600, marginBottom: 8 }}>Monthly earned — {year}</div>
            <div style={{ display: "flex", gap: 6 }}>
              {monthlyEarned.map((m,i) => (
                <div key={i} style={{ flex: 1, background: T.blueLt, borderRadius: 6, padding: "6px 4px", textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: T.slate500 }}>{m.month}</div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: T.blue, marginTop: 2 }}>{fmt(m.amount)}</div>
                </div>
              ))}
            </div>
          </div>
        </Card>

        {/* ScoreBoard */}
        <Card>
          <CardHeader
            title={`ScoreBoard Metrics — ${year}`}
            sub="Progress toward performance recognition"
            action={<AskBtn context={`My ScoreBoard metrics for ${year}: reviewing progress toward SF performance recognition. Help me identify which metrics need the most attention.`} />}
          />
          {scoreboard.map((m, i) => (
            <div key={i} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: T.slate700 }}>{m.metric}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: T.slate500 }}>{m.actual}/{m.target}</span>
                  <Pill type={m.pct >= 100 ? "success" : m.pct >= 75 ? "warning" : "danger"}>
                    {m.pct}%
                  </Pill>
                </div>
              </div>
              <ProgressBar
                value={m.actual}
                max={m.target}
                color={m.pct >= 100 ? T.green : m.pct >= 75 ? T.amber : T.red}
                height={6}
              />
            </div>
          ))}
          {scoreboard.length === 0 ? (
            <div style={{
              marginTop: 16, padding: "12px 14px",
              background: T.slate50, borderRadius: 8,
              fontSize: 12, color: T.slate600,
              borderLeft: `3px solid ${T.amber}`,
            }}>
              ScoreBoard data not yet tracked in the system. Once SF Score+ monthly reports are forwarded to the BCC inbox, this view will populate with target/actual per metric and recognition progress.
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
};

// ─── Section: Payroll ─────────────────────────────────────────
const PayrollSection = ({ data }) => {
  const ytdGross = (data.payroll || []).reduce((s,r) => s + parseFloat(r.gross || 0), 0);
  const ytdTax   = (data.payroll || []).reduce((s,r) => s + parseFloat(r.taxes || 0), 0);

  return (
    <Card>
      <CardHeader
        title="Payroll History"
        sub={(data?.payroll?.length || 0) === 0 ? "No payroll runs imported yet" : `YTD Gross: ${fmt(ytdGross)} · YTD Taxes: ${fmt(ytdTax)}`}
        action={<AskBtn context={`My agency payroll YTD: Gross ${fmt(ytdGross)}, Employer taxes ${fmt(ytdTax)}. Help me review payroll expenses and identify any concerns.`} />}
      />
      {(data?.payroll?.length || 0) === 0 && (
        <div style={{ padding:"14px 12px", background:T.slate50, borderRadius:8, fontSize:12, color:T.slate600, borderLeft:`3px solid ${T.amber}`, marginBottom:8 }}>
          No payroll runs in the live system yet. Forward ADP payroll reports to the BCC inbox; the Payroll GL Writer will populate this view automatically. Until then, payroll expense totals are visible on the P&L tab from the CPA accrual books.
        </div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${T.slate200}` }}>
            {["Pay Period","Pay Date","Gross","Employer Taxes","Net Payroll","Status"].map((h,i) => (
              <th key={i} style={{ padding: "8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: i > 1 ? "right" : "left" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(data.payroll || []).map((r,i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${T.slate100}` }}>
              <td style={{ padding: "9px 8px", fontSize: 12, color: T.slate800 }}>{r.pay_period||r.period}</td>
              <td style={{ padding: "9px 8px", fontSize: 12, color: T.slate600 }}>{r.pay_date||r.payDate||"-"}</td>
              <td style={{ padding: "9px 8px", fontSize: 12, fontWeight: 600, color: T.slate900, textAlign: "right" }}>{fmt(r.gross)}</td>
              <td style={{ padding: "9px 8px", fontSize: 12, color: T.slate700, textAlign: "right" }}>{fmt(parseFloat(r.taxes||0))}</td>
              <td style={{ padding: "9px 8px", fontSize: 12, color: T.slate700, textAlign: "right" }}>{fmt(parseFloat(r.net||0))}</td>
              <td style={{ padding: "9px 8px", textAlign: "right" }}>
                <Pill type="success">{r.status}</Pill>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
};

// ─── Section: Bank Accounts ───────────────────────────────────
const BankSection = ({ data }) => {
  const bankAccounts = Array.isArray(data?.bankAccounts) ? data.bankAccounts : [];
  const totalCash = bankAccounts.reduce((s,r) => s + (r?.balance || 0), 0);
  const fmtDate = (d) => {
    if (!d) return "—";
    try { return new Date(d).toLocaleDateString("en-US",{month:"short", day:"numeric", year:"numeric"}); }
    catch { return String(d); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px,1fr))", gap: 10 }}>
        {bankAccounts.length === 0 && (
          <Card><div style={{ fontSize:12, color:T.slate500 }}>No bank accounts on file. Add accounts from bank statement ingestion.</div></Card>
        )}
        {bankAccounts.map((a, i) => {
          const isPlaceholderInst = !a.institution || /tbd/i.test(a.institution);
          return (
            <Card key={i}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: T.slate700 }}>{a.name}</div>
                  <div style={{ fontSize: 10, color: isPlaceholderInst ? T.amber : T.slate400, marginTop:2 }}>
                    {isPlaceholderInst ? "Institution: needs confirmation" : a.institution}
                  </div>
                </div>
                <Pill type="info">{(a.type || "").replace(/_/g," ")}</Pill>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: T.slate900, letterSpacing: "-0.02em" }}>
                {fmt(a.balance)}
              </div>
              <div style={{ fontSize: 10, color: T.slate400, marginTop: 4 }}>
                As of {fmtDate(a.asOf)}{a.last4 ? ` · ••••${a.last4}` : ""}
              </div>
            </Card>
          );
        })}
        <Card style={{ background: T.navy, border: "none" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.7)", marginBottom: 8 }}>Total Cash Position</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: T.white, letterSpacing: "-0.02em" }}>{fmt(totalCash)}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 4 }}>All accounts combined</div>
        </Card>
      </div>
      <div style={{ padding:"10px 12px", background:T.slate50, borderRadius:8, fontSize:11, color:T.slate600, borderLeft:`3px solid ${T.amber}` }}>
        Balances reflect last loaded statement. Last-3-months bank statements are still pending — forward to BCC inbox to enable monthly reconciliation.
      </div>
    </div>
  );
};

// ─── Section: Credit & Debt ───────────────────────────────────
const CreditSection = ({ data }) => {
  const accts = Array.isArray(data?.creditAccounts) ? data.creditAccounts : [];
  const totalDebt = accts.reduce((s,r) => s + (r?.balance || 0), 0);
  const totalLimit = accts.filter(a => a.limit != null).reduce((s,r) => s + (r.limit || 0), 0);
  const totalAvailable = accts.filter(a => a.limit != null).reduce((s,r) => s + ((r.limit || 0) - (r.balance || 0)), 0);
  const totalUtilization = totalLimit > 0 ? (totalDebt / totalLimit) * 100 : null;
  const limitsPending = accts.some(a => a.limit == null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 10, marginBottom: 4 }}>
        <KPICard label="Total Debt Exposure" value={fmt(totalDebt)} color={T.red} border={T.red} />
        <KPICard label="Total Credit Limit" value={limitsPending ? "Pending" : fmt(totalLimit)} sub={limitsPending ? "Limits not yet loaded" : null} border={T.slate200} />
        <KPICard label="Available Credit" value={limitsPending ? "—" : fmt(totalAvailable)} color={limitsPending ? T.slate500 : T.green} border={limitsPending ? T.slate200 : T.green} />
        <KPICard label="Overall Utilization" value={totalUtilization != null ? `${Math.round(totalUtilization)}%` : "—"} sub="Target <30%" color={totalUtilization != null && totalUtilization > 30 ? T.amber : T.slate900} border={totalUtilization != null && totalUtilization > 30 ? T.amber : T.slate200} />
      </div>

      {accts.length === 0 && (
        <Card><div style={{ fontSize:12, color:T.slate500 }}>No credit accounts on file.</div></Card>
      )}

      {accts.map((a, i) => {
        const hasLimit = a.limit != null && a.limit > 0;
        const utilPct = hasLimit ? Math.round((a.balance / a.limit) * 100) : null;
        const typeLabel = (a.type || "").replace(/_/g, " ");
        return (
          <Card key={i}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.slate800 }}>{a.name}</div>
                <div style={{ fontSize: 11, color: T.slate500, marginTop: 2 }}>
                  {typeLabel}
                  {a.last4 ? ` · ••••${a.last4}` : ""}
                  {a.rate != null ? ` · ${a.rate}% APR` : ""}
                  {a.institution ? ` · ${a.institution}` : ""}
                </div>
              </div>
              <AskBtn context={`${a.name}: Balance ${fmt(a.balance)}${a.rate != null ? `, Rate ${a.rate}%` : ""}${a.dueDay ? `, Payment due on the ${a.dueDay}` : ""}${a.payment != null ? `, Min payment ${fmt(a.payment)}` : ""}. Help me think about this debt.`} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px,1fr))", gap: 10 }}>
              <div>
                <div style={{ fontSize: 10, color: T.slate500, marginBottom: 2 }}>Current Balance</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: T.red }}>{fmt(a.balance)}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: T.slate500, marginBottom: 2 }}>Available Credit</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: hasLimit ? T.green : T.slate400 }}>
                  {hasLimit ? fmt(a.limit - a.balance) : "—"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: T.slate500, marginBottom: 2 }}>Min Payment</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: a.payment != null ? T.amber : T.slate400 }}>
                  {a.payment != null ? fmt(a.payment) : "—"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: T.slate500, marginBottom: 2 }}>Due Day</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: a.dueDay ? T.slate800 : T.slate400 }}>
                  {a.dueDay ? `Day ${a.dueDay} of month` : "—"}
                </div>
              </div>
            </div>

            {hasLimit ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 10, color: T.slate400, marginBottom: 4 }}>Utilization: {utilPct}%</div>
                <ProgressBar value={a.balance} max={a.limit} color={utilPct > 30 ? T.amber : T.green} height={6} />
              </div>
            ) : (
              <div style={{ marginTop: 10, fontSize: 10, color: T.slate400 }}>
                Credit limit not yet loaded — utilization unavailable.
              </div>
            )}
          </Card>
        );
      })}

      {limitsPending && (
        <div style={{ padding:"10px 12px", background:T.slate50, borderRadius:8, fontSize:11, color:T.slate600, borderLeft:`3px solid ${T.amber}` }}>
          Credit limits, APR, and minimum payment data are still pending. Forward recent CC statements to BCC inbox to populate them.
        </div>
      )}
    </div>
  );
};

// ─── Section: General Ledger ──────────────────────────────────
const GLSection = ({ data }) => (
  <Card>
    <CardHeader
      title="General Ledger — Recent Entries"
      sub="Last 30 days · All accounts"
      action={<AskBtn context="I am reviewing my General Ledger recent entries. Help me verify these entries look correct and identify anything that needs attention." />}
    />
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${T.slate200}` }}>
          {["Date","Ref","Description","Account","Debit","Credit"].map((h,i) => (
            <th key={i} style={{ padding: "8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: i >= 4 ? "right" : "left" }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(Array.isArray(data?.glEntries) ? data.glEntries : []).map((r,i) => (
          <tr key={i} style={{ borderBottom: `1px solid ${T.slate100}` }}>
            <td style={{ padding: "8px", fontSize: 11, color: T.slate500 }}>{r.date}</td>
            <td style={{ padding: "8px", fontSize: 11, color: T.blue, fontFamily: "monospace" }}>{r.ref}</td>
            <td style={{ padding: "8px", fontSize: 12, color: T.slate800 }}>{r.description}</td>
            <td style={{ padding: "8px", fontSize: 11, color: T.slate500, fontFamily: "monospace" }}>{r.account}</td>
            <td style={{ padding: "8px", fontSize: 12, textAlign: "right", color: T.slate900, fontWeight: r.debit ? 500 : 400 }}>{r.debit ? fmt(r.debit) : "—"}</td>
            <td style={{ padding: "8px", fontSize: 12, textAlign: "right", color: T.green, fontWeight: r.credit ? 500 : 400 }}>{r.credit ? fmt(r.credit) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </Card>
);

const ReconciliationSection = ({ data }) => {
  const rows = Array.isArray(data?.reconciliation) ? data.reconciliation : [];

  // Aggregate diagnostics (most-recent 12 months with CPA data present).
  const cpaCoveredRows = rows.filter(r => Number.isFinite(r.cpaSfEarned) && r.cpaSfEarned !== 0);
  const totalCpa  = cpaCoveredRows.reduce((s, r) => s + (r.cpaSfEarned   || 0), 0);
  const totalBcc  = cpaCoveredRows.reduce((s, r) => s + (r.bccNetPayable || 0), 0);
  const totalVar  = totalBcc - totalCpa;
  const totalPct  = totalCpa ? Math.round((totalVar / totalCpa) * 1000) / 10 : null;

  return (
    <>
      <Card style={{ marginBottom: 14 }}>
        <CardHeader
          title="BCC vs CPA — Commission Income Reconciliation"
          sub={`Monthly variance, BCC net_payable vs CPA SF-earned. View vw_bcc_vs_cpa_commission_variance (migration 020).`}
          action={<AskBtn context={`I'm reviewing the BCC vs CPA commission reconciliation. Across the most recent ${cpaCoveredRows.length} months with CPA data, BCC net_payable totals $${Math.round(totalBcc).toLocaleString()} vs CPA SF-earned $${Math.round(totalCpa).toLocaleString()}, for a cumulative variance of $${Math.round(totalVar).toLocaleString()} (${totalPct ?? "—"}%). Help me think about what this means.`} />}
        />
        <div style={{ fontSize: 12, color: T.slate600, marginTop: 4, marginBottom: 12 }}>
          BCC net_payable is what State Farm actually deposited per the bi-monthly comp recap PDFs.
          CPA SF-earned is your CPA's accrual-basis Commission Income (Total Commission Income minus Non State Farm subline).
          A negative variance generally reflects deductions your CPA expenses rather than netting from revenue (PFA reductions, life premium loans, etc.) plus the basis shift between earned and paid.
        </div>

        {cpaCoveredRows.length > 0 && (
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(3, 1fr)",
            gap: 12, marginBottom: 14,
          }}>
            <div style={{ background: T.slate50, border: `1px solid ${T.slate200}`, borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 11, color: T.slate500, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>CPA SF-earned</div>
              <div style={{ fontSize: 18, color: T.slate900, fontWeight: 700, marginTop: 4 }}>{fmt(totalCpa)}</div>
              <div style={{ fontSize: 11, color: T.slate500, marginTop: 2 }}>across {cpaCoveredRows.length} mo</div>
            </div>
            <div style={{ background: T.slate50, border: `1px solid ${T.slate200}`, borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 11, color: T.slate500, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>BCC net_payable</div>
              <div style={{ fontSize: 18, color: T.slate900, fontWeight: 700, marginTop: 4 }}>{fmt(totalBcc)}</div>
              <div style={{ fontSize: 11, color: T.slate500, marginTop: 2 }}>same {cpaCoveredRows.length} mo</div>
            </div>
            <div style={{
              background: totalVar < 0 ? "#fff7ed" : "#f0fdf4",
              border: `1px solid ${totalVar < 0 ? "#fed7aa" : "#bbf7d0"}`,
              borderRadius: 8, padding: "10px 12px",
            }}>
              <div style={{ fontSize: 11, color: T.slate500, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>Cumulative variance</div>
              <div style={{ fontSize: 18, color: totalVar < 0 ? "#9a3412" : "#166534", fontWeight: 700, marginTop: 4 }}>{fmt(totalVar)}</div>
              <div style={{ fontSize: 11, color: T.slate500, marginTop: 2 }}>{totalPct != null ? `${totalPct}%` : "—"}</div>
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <div style={{ fontSize: 13, color: T.slate500, padding: "20px 0" }}>
            No reconciliation rows yet. View is empty — likely no overlap between comp_recap and cpa_pnl_monthly periods.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.slate200}`, color: T.slate500, textAlign: "left" }}>
                <th style={{ padding: "8px 10px", fontWeight: 600 }}>Month</th>
                <th style={{ padding: "8px 10px", fontWeight: 600, textAlign: "right" }}>CPA SF-earned</th>
                <th style={{ padding: "8px 10px", fontWeight: 600, textAlign: "right" }}>BCC net_payable</th>
                <th style={{ padding: "8px 10px", fontWeight: 600, textAlign: "right" }}>Variance</th>
                <th style={{ padding: "8px 10px", fontWeight: 600, textAlign: "right" }}>%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const v = r.variance;
                const isMissing = !Number.isFinite(r.cpaSfEarned) || r.cpaSfEarned === 0;
                return (
                  <tr key={`${r.year}-${r.month}-${i}`} style={{ borderBottom: `1px solid ${T.slate100}` }}>
                    <td style={{ padding: "8px 10px", color: T.slate800, fontWeight: 500 }}>{r.monthLabel}</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", color: isMissing ? T.slate400 : T.slate800 }}>{isMissing ? "—" : fmt(r.cpaSfEarned)}</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", color: Number.isFinite(r.bccNetPayable) ? T.slate800 : T.slate400 }}>{Number.isFinite(r.bccNetPayable) ? fmt(r.bccNetPayable) : "—"}</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 500, color: !Number.isFinite(v) ? T.slate400 : (v < 0 ? "#c2410c" : v > 0 ? "#15803d" : T.slate800) }}>{Number.isFinite(v) ? fmt(v) : "—"}</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", color: T.slate500 }}>{Number.isFinite(r.variancePct) ? `${r.variancePct}%` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <CardHeader title="Open question for CPA" sub="Tracked in bundle email task d5509d37" />
        <div style={{ fontSize: 13, color: T.slate700, lineHeight: 1.55, marginTop: 6 }}>
          What sources besides the bi-monthly comp recap PDFs feed your Commission Income account?
          Specifically — are AIPP annual payments, ScoreBoard, Life production bonuses, or other
          State Farm payment streams included there? Once we have that answer the GL Entry Writer
          accrual refactor (sprint Item 9) can resume.
        </div>
      </Card>
    </>
  );
};


// ─── Main Financials Module ───────────────────────────────────
export default function Financials() {
  const [section, setSection] = useState("overview");
  const { data: liveData, loading } = useFinancialsData();

  const sections = [
    { id: "overview",  label: "Overview"        },
    { id: "pl",        label: "P&L"             },
    { id: "comp",      label: "COMP_RECAP"      },
    { id: "aipp",      label: "AIPP & ScoreBoard"},
    { id: "payroll",   label: "Payroll"         },
    { id: "bank",      label: "Bank Accounts"   },
    { id: "credit",    label: "Credit & Debt"   },
    { id: "gl",        label: "General Ledger"  },
    { id: "recon",     label: "BCC vs CPA"      },
  ];

  return (
    <div>
      {/* Module Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: T.slate900, letterSpacing: "-0.02em" }}>Financials</div>
          <div style={{ fontSize: 12, color: T.slate500, marginTop: 3 }}>
            Accrual basis (CPA aligned) · Calendar year · All figures in USD
          </div>
        </div>
        <AskBtn context="I am reviewing my agency financials. Help me get a complete picture of my financial health, identify any concerns, and suggest what I should focus on." />
      </div>

      {/* Section Navigation */}
      <div style={{
        display: "flex", gap: 2, flexWrap: "wrap",
        background: T.slate100, borderRadius: 10,
        padding: 4, marginBottom: 18,
      }}>
        {sections.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)} style={{
            padding: "7px 14px", fontSize: 12,
            fontWeight: section === s.id ? 600 : 400,
            color: section === s.id ? T.slate900 : T.slate500,
            background: section === s.id ? T.white : "transparent",
            border: "none", borderRadius: 7, cursor: "pointer",
            transition: "all 0.12s",
            boxShadow: section === s.id ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
          }}>{s.label}</button>
        ))}
      </div>

      {/* Section Content */}
      {section === "overview" && <OverviewSection data={liveData || EMPTY_DATA} />}
      {section === "pl"       && <PLSection data={liveData || EMPTY_DATA} />}
      {section === "comp"     && <CompRecapSection data={liveData || EMPTY_DATA} />}
      {section === "aipp"     && <AIPPSection data={liveData || EMPTY_DATA} />}
      {section === "payroll"  && <PayrollSection data={liveData || EMPTY_DATA} />}
      {section === "bank"     && <BankSection data={liveData || EMPTY_DATA} />}
      {section === "credit"   && <CreditSection data={liveData || EMPTY_DATA} />}
      {section === "gl"       && <GLSection data={liveData || EMPTY_DATA} />}
      {section === "recon"    && <ReconciliationSection data={liveData || EMPTY_DATA} />}
    </div>
  );
}

