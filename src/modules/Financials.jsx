import { useState, useEffect, useRef } from "react";
import { supabase, AGENCY_ID } from "../lib/supabase.js";
import ReportPackage from "./ReportPackage.jsx";

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
// DATA: Reads from Supabase via props (passed from BCCApp)
// In production replace MOCK_DATA with Supabase queries:
//   const { data } = await supabase.from('comp_recap')...
// ============================================================


// ─── Design Tokens (matches BCCApp shell) ────────────────────

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

// ─── Live Supabase Data Hook ─────────────────────────────────
function useFinancialsData() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const currentYear  = new Date().getFullYear();
        const currentMonth = new Date().getMonth() + 1;     // 1-12
        const quarterStart = Math.floor((currentMonth - 1) / 3) * 3 + 1;

        const [
          isRows, compRows, bankRows, ccRows, glRows,
          payrollRunsRes, payrollDetailRows,
          aippRow, scoreboardRows, bsRows, benefitsRows,
        ] = await Promise.all([
          // Income statement view — pull current AND prior year for YoY benchmarking
          supabase.from("v_income_statement")
            .select("account_name, account_type, amount, month, year")
            .gte("year", currentYear - 1)
            .lte("year", currentYear)
            .order("month"),

          // SF comp recap — full 24-month rolling window (current + prior year)
          supabase.from("comp_recap")
            .select("period_year, period_month, comp_type, comp_category, description, amount, is_aipp_eligible, is_scoreboard_eligible")
            .gte("period_year", currentYear - 1)
            .order("period_year", { ascending: false })
            .order("period_month", { ascending: false })
            .limit(1500),

          // Bank
          supabase.from("bank_accounts")
            .select("account_name, current_balance, as_of_date, account_type, account_number_last4, institution"),

          // Credit
          supabase.from("credit_accounts")
            .select("account_name, current_balance, updated_at, account_type, account_number_last4, credit_limit, available_credit, interest_rate, minimum_payment, payment_due_day, institution"),

          // GL — unified BCC + QBO ledger; bump to 500 rows for client-side period filter
          supabase.from("v_unified_general_ledger")
            .select("source_layer, txn_date, txn_type, doc_number, memo, account_name, account_code, debit, credit")
            .order("txn_date", { ascending: false }).limit(500),

          // Payroll runs (header)
          supabase.from("payroll_runs")
            .select("id, pay_period_start, pay_period_end, pay_date, payroll_provider, gross_payroll, employer_taxes, net_payroll, status")
            .order("pay_date", { ascending: false }).limit(12),

          // Payroll detail (per-employee)
          supabase.from("payroll_detail")
            .select("payroll_run_id, gross_pay, federal_tax, state_tax, social_security, medicare, other_deductions, net_pay, employment_type"),

          // AIPP — pull current + 2 prior years for YoY trend
          supabase.from("aipp_tracking")
            .select("program_year, target_amount, earned_ytd, projected_full_year, achievement_percentage, notes")
            .order("program_year", { ascending: false }).limit(3),

          // ScoreBoard
          supabase.from("scoreboard_tracking")
            .select("program_year, period, metric_name, target, actual, achievement_percentage, notes")
            .order("program_year", { ascending: false }).limit(20),

          // Balance Sheet — last 24 monthly snapshots from QBO mirror
          supabase.from("v_balance_sheet")
            .select("period_start, period_end, accounting_method, total_assets, current_assets, total_liabilities, current_liabilities, total_equity, working_capital, source_layer, updated_at")
            .order("period_end", { ascending: false }).limit(24),

          // SF reportable benefits — S-Corp owner comp W-2 gross-up detail per period
          // (feeds the Owner Compensation section inside the COMP_RECAP tab)
          supabase.from("sf_reportable_benefits")
            .select("id, period_year, period_month, period_half, period_end_date, benefit_type, current_amount, ytd_amount, source_file_name")
            .order("period_end_date", { ascending: false }),
        ]);

        const isAll      = isRows.data || [];
        const isData     = isAll.filter(r => r.year === currentYear);
        const isPriorData = isAll.filter(r => r.year === currentYear - 1);
        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

        // Monthly chart
        const monthlyRevenue = months.map((m, i) => {
          const mo = i + 1;
          const rev = isData.filter(r => r.month === mo && r.account_type === "income").reduce((s,r) => s + parseFloat(r.amount||0), 0);
          const exp = isData.filter(r => r.month === mo && r.account_type === "expense").reduce((s,r) => s + parseFloat(r.amount||0), 0);
          return { month: m, revenue: Math.round(rev), expenses: Math.round(exp) };
        });

        // P&L line items
        const buildLines = (type) =>
          [...new Set(isData.filter(r=>r.account_type===type).map(r=>r.account_name))].map(name => {
            const rows = isData.filter(r=>r.account_name===name && r.account_type===type);
            const ytd = rows.reduce((s,r)=>s+parseFloat(r.amount||0),0);
            const mtd = rows.filter(r=>r.month===currentMonth).reduce((s,r)=>s+parseFloat(r.amount||0),0);
            const qtd = rows.filter(r=>r.month>=quarterStart && r.month<=currentMonth).reduce((s,r)=>s+parseFloat(r.amount||0),0);
            return { name, mtd: Math.round(mtd), qtd: Math.round(qtd), ytd: Math.round(ytd) };
          });

        const incomeLines  = buildLines("income");
        const expenseLines = buildLines("expense");

        const sumByPeriod = (type, predicate) =>
          isData.filter(r => r.account_type === type && predicate(r))
                .reduce((s,r) => s + parseFloat(r.amount||0), 0);

        const revYTD = sumByPeriod("income",  () => true);
        const expYTD = sumByPeriod("expense", () => true);
        const revMTD = sumByPeriod("income",  r => r.month === currentMonth);
        const expMTD = sumByPeriod("expense", r => r.month === currentMonth);
        const revQTD = sumByPeriod("income",  r => r.month >= quarterStart && r.month <= currentMonth);
        const expQTD = sumByPeriod("expense", r => r.month >= quarterStart && r.month <= currentMonth);

        // ─── Prior-year YTD (same months elapsed) — for YoY columns + benchmarks
        const priorYearYTDRev = isPriorData
          .filter(r => r.account_type === "income" && r.month <= currentMonth)
          .reduce((s,r) => s + parseFloat(r.amount || 0), 0);
        const priorYearYTDExp = isPriorData
          .filter(r => r.account_type === "expense" && r.month <= currentMonth)
          .reduce((s,r) => s + parseFloat(r.amount || 0), 0);

        // Prior-year P&L line items (YTD same period)
        const buildLinesPY = (type) =>
          [...new Set(isPriorData.filter(r=>r.account_type===type).map(r=>r.account_name))].map(name => {
            const rows = isPriorData.filter(r=>r.account_name===name && r.account_type===type && r.month<=currentMonth);
            const ytd = rows.reduce((s,r)=>s+parseFloat(r.amount||0),0);
            return { name, ytd: Math.round(ytd) };
          });
        const incomeLinesPY  = buildLinesPY("income");
        const expenseLinesPY = buildLinesPY("expense");

        // ─── SF Agency Reference Guide benchmark ratios (current year YTD)
        const sumExpCY = (names) => isData
          .filter(r => r.account_type === "expense" && names.includes(r.account_name))
          .reduce((s,r) => s + parseFloat(r.amount || 0), 0);
        const sumExpPY = (names) => isPriorData
          .filter(r => r.account_type === "expense" && names.includes(r.account_name) && r.month <= currentMonth)
          .reduce((s,r) => s + parseFloat(r.amount || 0), 0);

        // SF Agency Reference Guide standard account names + common modern aliases
        // Ratios work for both: (a) SF-standard bookkeeping (Salaries & Wages / Rent
        // Expense / Advertising and Promotion), and (b) more consolidated modern
        // chart-of-accounts (Payroll & Compensation / Rent / Lease / Marketing &
        // Advertising) that many agencies actually use in QBO.
        const salaries   = ["Salaries & Wages", "Payroll & Compensation", "Staff Wages"];
        const payTax     = ["Payroll Tax Expense", "Payroll Taxes"];
        const payFees    = ["Payroll Fees", "Payroll Processing Fees"];
        const benefits   = [
          "Medical Insurance Contribution", "Agents Group Medical", "Employee Benefits",
          "Health Insurance — Staff", "Health Insurance - Staff", "Employee Health Insurance",
        ];
        const rentNames  = ["Rent Expense", "Rent / Lease", "Rent"];
        const mktNames   = [
          "Advertising and Promotion", "Echo Co-Op Direct Mail",
          "Marketing & Advertising", "Marketing", "Advertising",
        ];
        const allPayroll = [...salaries, ...payTax, ...payFees, ...benefits];

        const pct = (n, d) => d ? (n / d) * 100 : 0;
        // statHi: higher = worse. healthy ≤ hh, warning ≤ wh, else critical.
        // statLo: higher = better. healthy ≥ hl, warning ≥ wl, else critical.
        // Bands vary per SF Agency Reference Guide — pass explicit thresholds, not generic ±5.
        const statHi = (v, hh, wh) => v <= hh ? "healthy" : v <= wh ? "warning" : "critical";
        const statLo = (v, hl, wl) => v >= hl ? "healthy" : v >= wl ? "warning" : "critical";

        // Officer/owner compensation lines commonly seen in QBO/S-Corp bookkeeping.
        // Note: many modern chart-of-accounts roll owner comp into Payroll &
        // Compensation without a dedicated line — in that case ownerComp ratio
        // will report 0% correctly (no separate owner comp exists to isolate).
        const ownerCompNames   = ["Salaries & Wages - Officer", "Officer Compensation", "Owner Comp", "Owner Compensation"];
        const teamPayrollPct   = pct(sumExpCY(salaries), revYTD);
        const payrollAllInPct  = pct(sumExpCY(allPayroll), revYTD);
        const ownerCompPct     = pct(sumExpCY(ownerCompNames), revYTD);
        const rentPct          = pct(sumExpCY(rentNames), revYTD);
        const marketingPct     = pct(sumExpCY(mktNames), revYTD);
        // Total OpEx per SF Agency Reference Guide = non-payroll operating expenses / gross
        // (Payroll, owner comp, payroll taxes/fees/benefits are already broken out in their own tiles.)
        const nonPayrollOpEx       = expYTD - sumExpCY([...allPayroll, ...ownerCompNames]);
        const priorNonPayrollOpEx  = priorYearYTDExp - sumExpPY([...allPayroll, ...ownerCompNames]);
        const totalOpExPct     = pct(nonPayrollOpEx, revYTD);
        const netMarginPct     = pct(revYTD - expYTD, revYTD);

        // SF Agency Reference Guide bands (healthy_ceiling, warning_ceiling) for higher-is-worse,
        // or (healthy_floor, warning_floor) for higher-is-better.
        const healthRatios = {
          teamPayroll:  { pct: teamPayrollPct,  py: pct(sumExpPY(salaries), priorYearYTDRev),      status: statHi(teamPayrollPct, 38, 45),   range: "30–38%",  label: "Team payroll",   hint: "Salaries & wages only / gross income" },
          payrollAllIn: { pct: payrollAllInPct, py: pct(sumExpPY(allPayroll), priorYearYTDRev),    status: statHi(payrollAllInPct, 50, 55),  range: "40–50%",  label: "Payroll all-in", hint: "Salaries + taxes + fees + benefits / gross" },
          ownerComp:    { pct: ownerCompPct,    py: pct(sumExpPY(ownerCompNames), priorYearYTDRev),status: statLo(ownerCompPct, 25, 20),     range: "25–35%",  label: "Owner Comp",     hint: "Officer W-2 / gross income", higherIsBetter: true },
          rent:         { pct: rentPct,         py: pct(sumExpPY(rentNames), priorYearYTDRev),     status: statHi(rentPct, 8, 12),           range: "5–8%",    label: "Rent",           hint: "Rent expense / gross income" },
          marketing:    { pct: marketingPct,    py: pct(sumExpPY(mktNames), priorYearYTDRev),      status: statLo(marketingPct, 5, 3),       range: "5–8%",    label: "Marketing",      hint: "Advertising + co-op / gross income", higherIsBetter: true },
          totalOpEx:    { pct: totalOpExPct,    py: pct(priorNonPayrollOpEx, priorYearYTDRev),     status: statHi(totalOpExPct, 22, 28),     range: "15–22%",  label: "Total OpEx",     hint: "Non-payroll operating expenses / gross income" },
          netMargin:    { pct: netMarginPct,    py: pct(priorYearYTDRev - priorYearYTDExp, priorYearYTDRev), status: statLo(netMarginPct, 25, 20), range: "25–35%", label: "Net margin",   hint: "(Revenue − total expense) / revenue", higherIsBetter: true },
        };

        // Comp recap — group rows into "periods" (e.g. "Apr 2026") and pre-format for the section
        const compRecapsRaw = compRows.data || [];
        const compRecaps = compRecapsRaw.map(r => ({
          period_year:  r.period_year,
          period_month: r.period_month,
          period_label: `${months[r.period_month-1]} ${r.period_year}`,
          comp_type:    r.comp_type,
          comp_category: r.comp_category,
          description:  r.description || `${r.comp_type} — ${r.comp_category}`,
          amount:       parseFloat(r.amount || 0),
          is_aipp_eligible: r.is_aipp_eligible,
          is_scoreboard_eligible: r.is_scoreboard_eligible,
        }));

        // AIPP — alias schema fields + add YoY chain (current → prior → prior-prior)
        const aippRows = Array.isArray(aippRow.data) ? aippRow.data : [];
        const aippCur  = aippRows[0] || null;
        const aippPY1  = aippRows[1] || null;
        const aippPY2  = aippRows[2] || null;
        const aippPriorVal = aippPY1 ? (parseFloat(aippPY1.earned_ytd) || 0) : 0;
        const aippPP2Val   = aippPY2 ? (parseFloat(aippPY2.earned_ytd) || 0) : 0;
        const aipp = aippCur ? {
          year:           aippCur.program_year || currentYear,
          target:         parseFloat(aippCur.target_amount)        || 0,
          earned:         parseFloat(aippCur.earned_ytd)           || 0,
          projected:      parseFloat(aippCur.projected_full_year)  || 0,
          priorYear:      aippPriorVal,
          priorYearLabel: aippPY1?.program_year || null,
          priorPriorYear: aippPP2Val,
          priorPriorYearLabel: aippPY2?.program_year || null,
          yoyDelta:       aippPriorVal && aippPP2Val ? aippPriorVal - aippPP2Val : null,
          yoyPct:         aippPriorVal && aippPP2Val ? ((aippPriorVal - aippPP2Val) / aippPP2Val) * 100 : null,
          monthlyEarned: months.map((m,i) => {
            const mo = i + 1;
            const earned = compRecapsRaw
              .filter(r => r.period_year === currentYear && r.period_month === mo && r.is_aipp_eligible)
              .reduce((s,r) => s + parseFloat(r.amount || 0), 0);
            return { month: m, amount: Math.round(earned) };
          }),
        } : { year: currentYear, target: 0, earned: 0, projected: 0, priorYear: 0, priorYearLabel: null, priorPriorYear: 0, priorPriorYearLabel: null, yoyDelta: null, yoyPct: null, monthlyEarned: months.map(m => ({month:m, amount:0})) };

        // ScoreBoard — alias to {metric, actual, target, pct}
        const scoreboard = (scoreboardRows.data || []).map(s => ({
          metric: s.metric_name,
          actual: parseFloat(s.actual || 0),
          target: parseFloat(s.target || 0),
          pct:    Math.round(parseFloat(s.achievement_percentage || 0)),
        }));

        // Payroll — combine runs + detail, grouped by run
        const detailByRun = {};
        for (const d of (payrollDetailRows.data || [])) {
          (detailByRun[d.payroll_run_id] ||= []).push(d);
        }
        const payroll = (payrollRunsRes.data || []).map(run => {
          const startStr = new Date(run.pay_period_start).toLocaleDateString("en-US", { month:"short", day:"numeric" });
          const endStr   = new Date(run.pay_period_end).toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" });
          const dateStr  = run.pay_date ? new Date(run.pay_date).toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" }) : "";
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

        // Credit accounts — alias to what CreditSection expects
        const creditAccounts = (ccRows.data || []).map(c => ({
          name:    c.account_name,
          balance: parseFloat(c.current_balance || 0),
          asOf:    c.updated_at,
          type:    c.account_type,
          last4:   c.account_number_last4,
          limit:   parseFloat(c.credit_limit || 0) || null,
          rate:    parseFloat(c.interest_rate || 0),
          payment: parseFloat(c.minimum_payment || 0),
          dueDay:  c.payment_due_day,
        }));

        setData({
          summary: {
            revenueMTD:  Math.round(revMTD),  revenueQTD:  Math.round(revQTD),  revenueYTD:  Math.round(revYTD),
            expensesMTD: Math.round(expMTD),  expensesQTD: Math.round(expQTD),  expensesYTD: Math.round(expYTD),
            netIncomeMTD: Math.round(revMTD - expMTD),
            netIncomeQTD: Math.round(revQTD - expQTD),
            netIncomeYTD: Math.round(revYTD - expYTD),
            priorYearYTD:        Math.round(priorYearYTDRev),
            priorYearYTDExpense: Math.round(priorYearYTDExp),
            priorYearNetIncome:  Math.round(priorYearYTDRev - priorYearYTDExp),
          },
          monthlyRevenue,
          pl: { income: incomeLines, expenses: expenseLines, incomePY: incomeLinesPY, expensesPY: expenseLinesPY },
          healthRatios,
          compRecaps,
          benefits: benefitsRows.data || [],
          aipp,
          scoreboard,
          bankAccounts: (bankRows.data || []).map(b => ({
            name: b.account_name,
            balance: parseFloat(b.current_balance||0),
            asOf: b.as_of_date,
            type: b.account_type,
            last4: b.account_number_last4,
            institution: b.institution,
          })),
          creditAccounts,
          glEntries: (glRows.data || []).map(g => ({
            date:        g.txn_date,
            ref:         g.doc_number,
            description: g.memo,
            source:      g.source_layer,           // 'bcc' | 'qbo'
            txn_type:    g.txn_type,               // optional: QBO txn type or BCC entry_type
            account:     g.account_name,
            debit:       parseFloat(g.debit  || 0),
            credit:      parseFloat(g.credit || 0),
          })),
          payroll,
          balanceSheet: (bsRows.data || []).map(b => ({
            period_end:          b.period_end,
            period_start:        b.period_start,
            accounting_method:   b.accounting_method,
            total_assets:        parseFloat(b.total_assets || 0),
            current_assets:      parseFloat(b.current_assets || 0),
            total_liabilities:   parseFloat(b.total_liabilities || 0),
            current_liabilities: parseFloat(b.current_liabilities || 0),
            total_equity:        parseFloat(b.total_equity || 0),
            working_capital:     parseFloat(b.working_capital || 0),
            source_layer:        b.source_layer,
            updated_at:          b.updated_at,
          })),
        });
      } catch(e) {
        console.error("Financials load error:", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  return { data, loading };
}


// ─── Helpers ─────────────────────────────────────────────────
const fmt = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "—";
  const formatted = "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 0 });
  return v < 0 ? "-" + formatted : formatted;
};
// Penny-precision formatter — Balance Sheet snapshots need consistent 2-decimal display
// so adjacent rows don't visually misalign when one value is whole-cent and another isn't.
const fmtCents = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "—";
  const formatted = "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? "-" + formatted : formatted;
};
// Money formatter that shows $0.00 explicitly — use for fields where zero is a real value
// (e.g. credit card paid-in-full balance) rather than "no data" (which fmt and fmtCents suppress).
const fmtMoney = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const formatted = "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? "-" + formatted : formatted;
};
const pct  = (n, t) => t ? Math.round((n / t) * 100) : 0;
const yoy  = (curr, prior) => prior ? (((curr - prior) / prior) * 100).toFixed(1) : null;

// ─── Data Store (populated by Financials component with live data) ────────────
let MOCK = {
  summary: { revenueMTD:0,revenueQTD:0,revenueYTD:0,expensesMTD:0,expensesQTD:0,expensesYTD:0,netIncomeMTD:0,netIncomeQTD:0,netIncomeYTD:0,priorYearYTD:0,priorYearYTDExpense:0,priorYearNetIncome:0 },
  monthlyRevenue: Array(12).fill(0).map((_,i)=>({month:["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][i],revenue:0,expenses:0})),
  pl:{income:[],expenses:[],incomePY:[],expensesPY:[]},
  healthRatios: { teamPayroll:null, payrollAllIn:null, rent:null, marketing:null, netMargin:null },
  compRecaps:[],
  benefits:[],
  aipp: { year: new Date().getFullYear(), target:0, earned:0, projected:0, priorYear:0, monthlyEarned: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map(m=>({month:m,amount:0})) },
  scoreboard: [],
  bankAccounts:[],creditAccounts:[],glEntries:[],payroll:[],
};


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
// ─── Section: Health Ratios (SF Agency Reference Guide benchmarks) ───
const HealthRatioCard = ({ tile }) => {
  if (!tile) return null;
  const colorMap = {
    healthy:  { fg: "#065F46", bg: T.greenLt,  border: T.green,  label: "Healthy" },
    warning:  { fg: "#92400E", bg: T.amberLt,  border: T.amber,  label: "Warning" },
    critical: { fg: "#991B1B", bg: T.redLt,    border: T.red,    label: "Critical" },
  };
  const c = colorMap[tile.status] || colorMap.healthy;
  const delta = (tile.pct ?? 0) - (tile.py ?? 0);
  const showDelta = Number.isFinite(tile.py) && Math.abs(tile.py) > 0.01;
  const isInfoOnly = tile.range === "info";

  return (
    <div style={{
      background: T.white,
      border: `1px solid ${T.slate200}`,
      borderTop: `3px solid ${isInfoOnly ? T.slate400 : c.border}`,
      borderRadius: 12,
      padding: "12px 14px",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ fontSize: 11, color: T.slate500, fontWeight: 500 }}>{tile.label}</div>
        {!isInfoOnly && (
          <span style={{
            display: "inline-flex", alignItems: "center",
            fontSize: 9, fontWeight: 700, letterSpacing: "0.04em",
            padding: "2px 7px", borderRadius: 20,
            background: c.bg, color: c.fg, textTransform: "uppercase",
          }}>{c.label}</span>
        )}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: T.slate900, letterSpacing: "-0.02em", marginBottom: 2 }}>
        {(tile.pct ?? 0).toFixed(1)}%
      </div>
      <div style={{ fontSize: 10, color: T.slate500, lineHeight: 1.45 }}>
        {isInfoOnly ? tile.hint : `Healthy ${tile.range}`}
        {showDelta && (
          <span style={{
            marginLeft: 6,
            color: (tile.higherIsBetter ? delta >= 0 : delta <= 0) ? "#16A34A" : T.red,
            fontWeight: 600,
          }}>
            {delta >= 0 ? "↑" : "↓"} {Math.abs(delta).toFixed(1)}pp YoY
          </span>
        )}
      </div>
    </div>
  );
};

const HealthRatiosSection = ({ data }) => {
  const r = data?.healthRatios || {};
  const tiles = [r.teamPayroll, r.payrollAllIn, r.ownerComp, r.rent, r.marketing, r.totalOpEx, r.netMargin].filter(Boolean);
  if (tiles.length === 0) return null;

  const critCount = tiles.filter(t => t.status === "critical").length;
  const warnCount = tiles.filter(t => t.status === "warning").length;

  const askCtx = `My SF benchmark ratios (YTD vs prior-year same period): ` +
    tiles.map(t => `${t.label} ${t.pct.toFixed(1)}% (PY ${(t.py||0).toFixed(1)}%, ${t.status})`).join(", ") +
    `. Help me prioritize what to fix.`;

  return (
    <Card style={{ marginBottom: 16 }}>
      <CardHeader
        title="Agency Health Ratios — YTD"
        sub={`SF Agency Reference Guide benchmarks · ${critCount} critical · ${warnCount} warning`}
        action={<AskBtn context={askCtx} />}
      />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 10 }}>
        {tiles.map((t,i) => <HealthRatioCard key={i} tile={t} />)}
      </div>
    </Card>
  );
};

const OverviewSection = ({ period, setPeriod, data }) => {
  const d = data?.summary || {};
  const yoyPct = yoy(d.revenueYTD || 0, d.priorYearYTD || 0);
  const niYoyPct = yoy(d.netIncomeYTD || 0, d.priorYearNetIncome || 0);

  // Period-active net income — used to color the Net Income KPI on ALL tabs (not just YTD)
  const niActive = period === "mtd" ? d.netIncomeMTD : period === "qtd" ? d.netIncomeQTD : d.netIncomeYTD;

  // Expense Ratio band — was hardcoded slate. Now bands against SF benchmark "Healthy <75%".
  //   ≥90% critical, 75–90% warning, <75% healthy. Mirrors Total OpEx / Marketing pattern.
  const _ratioRev = period === "mtd" ? d.revenueMTD : period === "qtd" ? d.revenueQTD : d.revenueYTD;
  const _ratioExp = period === "mtd" ? d.expensesMTD : period === "qtd" ? d.expensesQTD : d.expensesYTD;
  const expRatioPct = _ratioRev ? (_ratioExp / _ratioRev) * 100 : null;
  const expRatioBand = expRatioPct === null ? { border: T.slate200 }
    : expRatioPct >= 90 ? { color: T.red, border: T.red }
    : expRatioPct >= 75 ? { color: T.amber, border: T.amber }
    : { color: T.green, border: T.green };

  return (
    <div>
      <HealthRatiosSection data={data} />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <TabBar
          tabs={[{ id:"mtd", label:"This Month" },{ id:"qtd", label:"This Quarter" },{ id:"ytd", label:"Year to Date" }]}
          active={period}
          onChange={setPeriod}
        />
        <AskBtn context={`My agency financials — ${period.toUpperCase()}: Revenue $${period==="mtd"?d.revenueMTD:period==="qtd"?d.revenueQTD:d.revenueYTD}, Expenses $${period==="mtd"?d.expensesMTD:"N/A"}, Net Income $${period==="mtd"?d.netIncomeMTD:d.netIncomeYTD}. YTD is up ${yoyPct}% vs prior year. Help me analyze my financial performance.`} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px,1fr))", gap: 10, marginBottom: 16 }}>
        <KPICard label="Revenue" value={fmt(period==="mtd"?d.revenueMTD:period==="qtd"?d.revenueQTD:d.revenueYTD)} sub={period==="ytd" && yoyPct !== null ? `${parseFloat(yoyPct) >= 0 ? "↑" : "↓"} ${Math.abs(parseFloat(yoyPct))}% vs prior year` : undefined} color={T.blue} border={T.blue} />
        <KPICard label="Expenses" value={fmt(period==="mtd"?d.expensesMTD:period==="qtd"?d.expensesQTD:d.expensesYTD)} sub="Cash basis" border={T.amber} />
        <KPICard label="Net Income" value={fmt(niActive)} sub={period==="ytd" && niYoyPct!==null ? `${niYoyPct >= 0 ? "↑" : "↓"} ${Math.abs(parseFloat(niYoyPct))}% vs prior YTD` : undefined} color={(niActive||0) < 0 ? T.red : T.green} border={(niActive||0) < 0 ? T.red : T.green} />
        <KPICard label="Expense Ratio" value={expRatioPct === null ? "—" : Math.round(expRatioPct) + "%"} sub="Healthy <75%" {...expRatioBand} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)", gap: 12 }}>
        <Card>
          <CardHeader title="Monthly revenue — 2026" sub="Blue bars = revenue · Gray = no data yet" />
          <MiniBarChart data={data.monthlyRevenue} />
        </Card>

        <Card>
          <CardHeader title={`Income breakdown — ${new Date().toLocaleDateString("en-US",{month:"long", year:"numeric"})}`} />
          {(Array.isArray(data?.pl?.income) ? data.pl.income : []).map((item, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                <span style={{ color: T.slate600 }}>{item.name}</span>
                <span style={{ fontWeight: 600, color: T.slate900 }}>{fmt(item.mtd)}</span>
              </div>
              <ProgressBar value={item.mtd || 0} max={data?.summary?.revenueMTD || 1} color={item.code?.startsWith("41") ? T.green : T.blue} />
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
};

// ─── Section: P&L ────────────────────────────────────────────
const PLSection = ({ data }) => {
  const pl = data?.pl || { income: [], expenses: [], incomePY: [], expensesPY: [] };
  const incomeRows    = Array.isArray(pl.income)     ? pl.income     : [];
  const expenseRows   = Array.isArray(pl.expenses)   ? pl.expenses   : [];
  const incomePYRows  = Array.isArray(pl.incomePY)   ? pl.incomePY   : [];
  const expensePYRows = Array.isArray(pl.expensesPY) ? pl.expensesPY : [];
  const totalIncomeMTD  = incomeRows.reduce((s,r) => s + (r?.mtd || 0), 0);
  const totalExpMTD     = expenseRows.reduce((s,r) => s + (r?.mtd || 0), 0);
  const totalIncomeYTD  = incomeRows.reduce((s,r) => s + (r?.ytd || 0), 0);
  const totalExpYTD     = expenseRows.reduce((s,r) => s + (r?.ytd || 0), 0);
  const totalIncomePY   = incomePYRows.reduce((s,r) => s + (r?.ytd || 0), 0);
  const totalExpPY      = expensePYRows.reduce((s,r) => s + (r?.ytd || 0), 0);
  const pyLookup = (rows, name) => (rows.find(r => r?.name === name)?.ytd) || 0;

  const TRow = ({ label, mtd, qtd, ytd, py, bold, indent, isTotal, isNeg, isExpenseRow }) => {
    const cellBase = { padding: "7px 8px", fontSize: 12, textAlign: "right", fontWeight: bold ? 600 : 400 };
    const cellColor = { color: isNeg ? T.red : bold ? T.slate900 : T.slate700 };
    // YoY delta: only show if py exists and ytd exists; for income rows higher is better, expense rows lower is better
    const showDelta = Number.isFinite(py) && Math.abs(py) > 0.5 && Number.isFinite(ytd);
    let deltaStr = "";
    let deltaColor = T.slate400;
    if (showDelta) {
      const diff = (ytd || 0) - py;
      const pctDelta = py ? (diff / py) * 100 : 0;
      const arrow = diff >= 0 ? "↑" : "↓";
      // For totals/expenses row: higher expense = bad (red); higher income = good (green)
      const goodIfUp = !isExpenseRow;
      const isGood = (goodIfUp && diff >= 0) || (!goodIfUp && diff <= 0);
      deltaColor = Math.abs(pctDelta) < 1 ? T.slate400 : isGood ? "#16A34A" : T.red;
      deltaStr = `${arrow} ${Math.abs(pctDelta).toFixed(0)}%`;
    }
    return (
      <tr style={{ background: isTotal ? T.slate50 : "transparent" }}>
        <td style={{ padding: "7px 8px", fontSize: 12, color: indent ? T.slate600 : T.slate800, paddingLeft: indent ? 24 : 8, fontWeight: bold ? 600 : 400 }}>{label}</td>
        <td style={{ ...cellBase, ...cellColor }}>{fmt(mtd)}</td>
        <td style={{ ...cellBase, ...cellColor }}>{fmt(qtd)}</td>
        <td style={{ ...cellBase, ...cellColor }}>{fmt(ytd)}</td>
        <td style={{ ...cellBase, color: T.slate500, fontWeight: bold ? 600 : 400 }}>{Number.isFinite(py) ? fmt(py) : "—"}</td>
        <td style={{ padding: "7px 8px", fontSize: 11, textAlign: "right", fontWeight: 600, color: deltaColor }}>{deltaStr || ""}</td>
      </tr>
    );
  };

  return (
    <Card>
      <CardHeader
        title="Profit & Loss Statement"
        sub="Cash basis · YTD vs prior year same period"
        action={<AskBtn context={`My P&L: YTD Revenue $${totalIncomeYTD}, YTD Expenses $${totalExpYTD}, Net Income $${totalIncomeYTD - totalExpYTD}. Expense ratio ${Math.round((totalExpYTD/totalIncomeYTD)*100)}%. Help me analyze my profitability and identify areas to improve.`} />}
      />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `2px solid ${T.slate200}` }}>
              <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "left" }}>Account</th>
              <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "right" }}>MTD</th>
              <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "right" }}>QTD</th>
              <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "right" }}>YTD</th>
              <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "right" }}>PY YTD</th>
              <th style={{ padding: "8px 8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: "right" }}>YoY</th>
            </tr>
          </thead>
          <tbody>
            <TRow label="INCOME" bold />
            {(() => {
              // Union current-year + prior-year account names so accounts active
              // in either year render (was hiding PY-only accounts like "Salaries & Wages - Officer").
              const map = new Map();
              incomeRows.forEach(r => map.set(r.name, { name: r.name, mtd: r.mtd, qtd: r.qtd, ytd: r.ytd }));
              incomePYRows.forEach(r => { if (!map.has(r.name)) map.set(r.name, { name: r.name, mtd: 0, qtd: 0, ytd: 0 }); });
              const union = [...map.values()].sort((a,b) => {
                const apy = pyLookup(incomePYRows, a.name);
                const bpy = pyLookup(incomePYRows, b.name);
                return (b.ytd || 0) - (a.ytd || 0) || (bpy - apy);
              });
              return union.map((r,i) => (
                <TRow key={i} label={r.name} mtd={r.mtd} qtd={r.qtd} ytd={r.ytd} py={pyLookup(incomePYRows, r.name)} indent />
              ));
            })()}
            <TRow label="Total Income" mtd={totalIncomeMTD} qtd={incomeRows.reduce((s,r)=>s+r.qtd,0)} ytd={totalIncomeYTD} py={totalIncomePY} bold isTotal />

            <tr><td colSpan={6} style={{ padding: "6px 0" }} /></tr>

            <TRow label="EXPENSES" bold isExpenseRow />
            {(() => {
              const map = new Map();
              expenseRows.forEach(r => map.set(r.name, { name: r.name, mtd: r.mtd, qtd: r.qtd, ytd: r.ytd }));
              expensePYRows.forEach(r => { if (!map.has(r.name)) map.set(r.name, { name: r.name, mtd: 0, qtd: 0, ytd: 0 }); });
              const union = [...map.values()].sort((a,b) => {
                const apy = pyLookup(expensePYRows, a.name);
                const bpy = pyLookup(expensePYRows, b.name);
                return (b.ytd || 0) - (a.ytd || 0) || (bpy - apy);
              });
              return union.map((r,i) => (
                <TRow key={i} label={r.name} mtd={r.mtd} qtd={r.qtd} ytd={r.ytd} py={pyLookup(expensePYRows, r.name)} indent isExpenseRow />
              ));
            })()}
            <TRow label="Total Expenses" mtd={totalExpMTD} qtd={expenseRows.reduce((s,r)=>s+r.qtd,0)} ytd={totalExpYTD} py={totalExpPY} bold isTotal isExpenseRow />

            <tr><td colSpan={6} style={{ padding: "2px 0", borderTop: `2px solid ${T.slate800}` }} /></tr>
            <TRow label="NET INCOME" mtd={totalIncomeMTD-totalExpMTD} qtd={incomeRows.reduce((s,r)=>s+r.qtd,0)-expenseRows.reduce((s,r)=>s+r.qtd,0)} ytd={totalIncomeYTD-totalExpYTD} py={totalIncomePY-totalExpPY} bold isTotal />
          </tbody>
        </table>
      </div>
    </Card>
  );
};

// ─── Section: COMP_RECAP ─────────────────────────────────────
// ─── Section: S-Corp Owner Compensation (moved from HR & People 2026-07-16) ──
// Renders as a sub-section INSIDE the COMP_RECAP tab. the agent's owner comp is a
// financial concern (S-Corp reasonable comp, W-2 gross-ups, distributions),
// not an HR concern — so it lives here with the other SF compensation detail.
const OwnerCompensationSection = ({ benefits }) => {
  const [year, setYear] = useState(() => {
    const yrs = (benefits || []).map(b => b?.period_year).filter(y => y != null);
    return yrs.length > 0 ? Math.max(...yrs) : new Date().getFullYear();
  });

  const rows = (benefits || []).filter(b => b?.period_year === year);
  const ytdByType = {};
  for (const r of rows) {
    const t = r?.benefit_type;
    if (!t) continue;
    const ytd = Number(r?.ytd_amount || 0);
    if (!ytdByType[t] || new Date(r?.period_end_date) > new Date(ytdByType[t].date)) {
      ytdByType[t] = { ytd, date: r?.period_end_date };
    }
  }
  const get = (t) => Number(ytdByType[t]?.ytd || 0);
  const medical = get("medical");
  const dental = get("dental");
  const life = get("life");
  const adjustment = get("medical_adjustment");
  const w2Includible = medical + adjustment;
  const totalReportable = medical + dental + life + adjustment;

  const yearsAvailable = Array.from(new Set((benefits || []).map(b => b?.period_year).filter(y => y != null))).sort();
  const isClosedYear = year < new Date().getFullYear();

  const periodMap = {};
  for (const r of rows) {
    const k = r?.period_end_date;
    if (!k) continue;
    if (!periodMap[k]) periodMap[k] = { period_end_date: k, half: r?.period_half, source: r?.source_file_name };
    periodMap[k][r?.benefit_type] = { current: Number(r?.current_amount || 0), ytd: Number(r?.ytd_amount || 0) };
  }
  const periodRows = Object.values(periodMap).sort((a, b) => new Date(b.period_end_date) - new Date(a.period_end_date));

  const usd = (n) => "$" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const askContext = [
    `S-Corp Owner Reportable Benefits — Year ${year}`,
    `Source: SF AGTCOMP RECAP PDFs (sf_reportable_benefits table, ${rows.length} rows)`,
    ``,
    `YTD totals:`,
    `  Medical Insurance:     ${usd(medical)}`,
    `  Medical Adjustment:    ${usd(adjustment)}`,
    `  Group Dental:          ${usd(dental)}`,
    `  Group Life:            ${usd(life)}`,
    `  Total Reportable:      ${usd(totalReportable)}`,
    ``,
    `W-2 Includible (Medical + Adjustment): ${usd(w2Includible)}`,
    `Per IRC \u00A73121(a)(2)(B), S-Corp >2% shareholder must include health premiums in W-2 Box 1 wages.`,
    ``,
    `Action needed for CPA:`,
    `  1. Confirm prior year W-2 included this gross-up (2025 was $7,670.64).`,
    `  2. Add ${usd(w2Includible)} (and any additional periods through year-end) to final ${year} payroll.`,
    `  3. Confirm group dental + life treatment (Section 125 plan? if not, also W-2 includible).`,
  ].join("\n");

  const KpiCard = ({ label, value, accent }) => (
    <Card style={{ flex:"1 1 200px", minWidth:200 }}>
      <div style={{ fontSize:11, color:T.slate500, fontWeight:600, letterSpacing:"0.04em", textTransform:"uppercase" }}>{label}</div>
      <div style={{ fontSize:24, fontWeight:700, color:accent || T.slate900, marginTop:6 }}>{usd(value)}</div>
      <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>YTD {year}</div>
    </Card>
  );

  return (
    <div>
      {/* Header + year selector */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14, flexWrap:"wrap", gap:10 }}>
        <div>
          <div style={{ fontSize:16, fontWeight:700, color:T.slate900 }}>S-Corp Owner Compensation</div>
          <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>
            W-2 reportable benefits · sourced from {rows.length} AGTCOMP RECAP rows
          </div>
        </div>
        <div style={{ display:"flex", gap:6 }}>
          {yearsAvailable.map(y => (
            <button
              key={y}
              onClick={() => setYear(y)}
              style={{
                padding:"6px 14px", fontSize:12, fontWeight: year===y ? 600 : 400,
                background: year===y ? T.navy : T.slate100,
                color: year===y ? T.white : T.slate600,
                border:"none", borderRadius:7, cursor:"pointer"
              }}
            >{y}{y === new Date().getFullYear() ? " YTD" : ""}</button>
          ))}
          <AskBtn context={askContext} />
        </div>
      </div>

      {/* KPI tiles */}
      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:14 }}>
        <KpiCard label="Medical Insurance" value={medical} accent={T.blue} />
        <KpiCard label="Medical Adjustment" value={adjustment} accent={T.purple} />
        <KpiCard label="Group Dental" value={dental} accent={T.slate600} />
        <KpiCard label="Group Life" value={life} accent={T.slate700} />
      </div>

      {/* W-2 Includible callout */}
      <Card style={{
        background: isClosedYear ? T.greenLt : T.amberLt,
        borderColor: isClosedYear ? T.green : T.amber,
        marginBottom:14
      }}>
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:14, flexWrap:"wrap" }}>
          <div style={{ flex:"1 1 320px" }}>
            <div style={{ fontSize:11, fontWeight:600, color:isClosedYear ? T.green : T.amber, letterSpacing:"0.04em", textTransform:"uppercase" }}>
              W-2 Includible (Medical + Adjustment)
            </div>
            <div style={{ fontSize:28, fontWeight:700, color:T.slate900, marginTop:4 }}>{usd(w2Includible)}</div>
            <div style={{ fontSize:12, color:T.slate700, marginTop:6, lineHeight:1.55 }}>
              {isClosedYear ? (
                <>
                  <strong>Closed year.</strong> Verify {year} W-2 Box 1 wages included this gross-up.
                  If not, W-2c amendment may be required. See alert in Alerts module.
                </>
              ) : (
                <>
                  <strong>Action by year-end:</strong> Include {usd(w2Includible)} (and any additional periods
                  through Dec 31) on final {year} payroll per IRC §3121(a)(2)(B). The S-Corp Medical Year-End
                  W-2 Prep recipe runs in Nov–Dec to surface the final number.
                </>
              )}
            </div>
          </div>
          <div style={{ flex:"0 1 220px", textAlign:"right" }}>
            <div style={{ fontSize:11, color:T.slate500, fontWeight:600, letterSpacing:"0.04em", textTransform:"uppercase" }}>Total Reportable</div>
            <div style={{ fontSize:18, fontWeight:700, color:T.slate900, marginTop:4 }}>{usd(totalReportable)}</div>
            <div style={{ fontSize:11, color:T.slate500, marginTop:2 }}>All benefit types · YTD {year}</div>
          </div>
        </div>
      </Card>

      {/* Per-period table */}
      <Card style={{ marginBottom:14 }}>
        <div style={{ fontSize:13, fontWeight:600, color:T.slate900, marginBottom:10 }}>
          Period-by-Period Detail · {year}
        </div>
        {periodRows.length === 0 ? (
          <div style={{ fontSize:12, color:T.slate500, padding:"16px 4px" }}>
            No reportable benefits data for {year}. Backfill from AGTCOMP RECAP PDFs runs from migrations.
          </div>
        ) : (
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
              <thead>
                <tr style={{ background:T.slate50, borderBottom:`1px solid ${T.slate200}` }}>
                  <th style={{ padding:"8px 10px", textAlign:"left", color:T.slate600, fontWeight:600 }}>Period End</th>
                  <th style={{ padding:"8px 10px", textAlign:"right", color:T.slate600, fontWeight:600 }}>Medical</th>
                  <th style={{ padding:"8px 10px", textAlign:"right", color:T.slate600, fontWeight:600 }}>Adjustment</th>
                  <th style={{ padding:"8px 10px", textAlign:"right", color:T.slate600, fontWeight:600 }}>Dental</th>
                  <th style={{ padding:"8px 10px", textAlign:"right", color:T.slate600, fontWeight:600 }}>Life</th>
                  <th style={{ padding:"8px 10px", textAlign:"right", color:T.slate600, fontWeight:600 }}>YTD Medical</th>
                </tr>
              </thead>
              <tbody>
                {periodRows.map((r, idx) => (
                  <tr key={idx} style={{ borderBottom:`1px solid ${T.slate100}` }}>
                    <td style={{ padding:"7px 10px", color:T.slate900 }}>{r.period_end_date}</td>
                    <td style={{ padding:"7px 10px", textAlign:"right", color:T.slate900 }}>{r.medical?.current ? usd(r.medical.current) : "—"}</td>
                    <td style={{ padding:"7px 10px", textAlign:"right", color: r.medical_adjustment?.current ? T.purple : T.slate400 }}>{r.medical_adjustment?.current ? usd(r.medical_adjustment.current) : "—"}</td>
                    <td style={{ padding:"7px 10px", textAlign:"right", color:T.slate900 }}>{r.dental?.current ? usd(r.dental.current) : "—"}</td>
                    <td style={{ padding:"7px 10px", textAlign:"right", color:T.slate900 }}>{r.life?.current ? usd(r.life.current) : "—"}</td>
                    <td style={{ padding:"7px 10px", textAlign:"right", color:T.slate600 }}>{r.medical?.ytd ? usd(r.medical.ytd) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* CPA prep notes */}
      <Card style={{ background:T.slate50 }}>
        <div style={{ fontSize:13, fontWeight:600, color:T.slate900, marginBottom:8 }}>CPA Conversation Prep</div>
        <ul style={{ fontSize:12, color:T.slate700, lineHeight:1.7, margin:"0 0 0 16px", padding:0 }}>
          <li>Verify {year - 1} W-2 Box 1 included the {year - 1} Total Reportable Benefits gross-up.</li>
          <li>Confirm GL coding convention for SF Deductions (account 4050 vs 6115 S-Corp Medical vs 3050 Distributions).</li>
          <li>Group Dental + Life: confirm Section 125 cafeteria plan or also W-2 includible.</li>
          <li>Medical premium doubled 4/30/2026 ($591.84 → $1,227.58/period). Explain.</li>
          <li>One-time Medical Adjustment $482.82 at 4/30/2026 only. Explain.</li>
          <li>Reasonable W-2 comp strategy: no W-2 wages YTD; must take by year-end.</li>
        </ul>
        <div style={{ fontSize:11, color:T.slate500, marginTop:10, paddingTop:10, borderTop:`1px solid ${T.slate200}` }}>
          All 6 items tracked as tasks · due 2026-06-30 CPA meeting · Tasks &amp; Goals module
        </div>
      </Card>
    </div>
  );
};

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

  // qbo_derived_composite rows are bank-deposit roll-ups pulled from QuickBooks GL.
  // They represent the SAME money as the per-product detail rows parsed from AGTCOMP RECAP PDFs
  // — including both in the line items list double-counts. Show detail when available,
  // fall back to composites only if a period has no detail rows (e.g. Jan 2025 OCR PDF in defer).
  const detailRows    = filtered.filter(r => r.comp_category !== "qbo_derived_composite");
  const compositeOnly = detailRows.length === 0 && filtered.length > 0;
  const displayRows   = compositeOnly ? filtered : detailRows;
  const total     = displayRows.reduce((s,r) => s + parseFloat(r.amount || 0), 0);
  const aippTotal = displayRows.filter(r => r.is_aipp_eligible).reduce((s,r) => s + parseFloat(r.amount || 0), 0);

  // ─── Gross → Net walk (SF compensation flow)
  const sumByType = (types) => filtered
    .filter(r => types.includes(r.comp_type))
    .reduce((s,r) => s + parseFloat(r.amount || 0), 0);
  const production    = sumByType(["new_business", "renewal", "service"]);
  const aippPayments  = sumByType(["aipp_payment"]);
  const adjustments   = sumByType(["adjustment", "other"]);
  const grossComp     = production + aippPayments + adjustments;
  const deductions    = sumByType(["deduction"]);
  const aippDeferrals = sumByType(["aipp_deferral", "deferred_comp"]);
  const netDeposit    = grossComp + deductions + aippDeferrals;   // deductions/deferrals are already negative
  const walkRow = (label, amount, sign, isTotal, hint) => ({ label, amount, sign, isTotal, hint });
  const walk = [
    walkRow("Production (new biz + renewal + service)", production,    "+", false, "All P&C, life, health line-item compensation"),
    walkRow("AIPP payments",                            aippPayments,  "+", false, "Annual incentive payouts (typically January only)"),
    walkRow("Adjustments + other",                      adjustments,   "+", false, "Small credits, miscellaneous items"),
    walkRow("Gross compensation",                       grossComp,     "=", true,  null),
    walkRow("Deductions",                               deductions,    "−", false, "Errors, charge-backs, fees"),
    walkRow("AIPP deferrals",                           aippDeferrals, "−", false, "Money held back for next year AIPP base"),
    walkRow("Net deposit to bank",                      netDeposit,    "=", true,  "Should match the SF deposit for this period"),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    <Card>
      <CardHeader
        title="SF COMP_RECAP Detail"
        sub="State Farm compensation breakdown by period"
        action={<AskBtn context={`My SF COMP_RECAP for ${period}: Total $${total}. AIPP eligible: $${aippTotal}. Help me reconcile this to my GL and confirm my AIPP calculation.`} />}
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

      {/* Gross → Net walk */}
      {filtered.length > 0 && (
        <div style={{
          background: T.slate50,
          border: `1px solid ${T.slate200}`,
          borderRadius: 10,
          padding: "12px 14px",
          marginBottom: 16,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: T.slate600, marginBottom: 8, letterSpacing: "0.02em", textTransform: "uppercase" }}>
            Gross → Net walk · {period}
          </div>
          {walk.map((row, i) => (
            <div key={i} style={{
              display: "grid",
              gridTemplateColumns: "18px 1fr auto",
              gap: 10,
              alignItems: "baseline",
              padding: "5px 0",
              borderTop: row.isTotal && i > 0 ? `1px solid ${T.slate200}` : "none",
              marginTop: row.isTotal && i > 0 ? 4 : 0,
              paddingTop: row.isTotal && i > 0 ? 8 : 5,
            }}>
              <span style={{
                fontSize: 13,
                fontWeight: 700,
                color: row.sign === "=" ? T.slate900 : row.sign === "+" ? T.green : T.red,
                textAlign: "center",
              }}>{row.sign}</span>
              <div>
                <div style={{ fontSize: 12, color: row.isTotal ? T.slate900 : T.slate700, fontWeight: row.isTotal ? 700 : 400 }}>
                  {row.label}
                </div>
                {row.hint && (
                  <div style={{ fontSize: 10, color: T.slate400, marginTop: 1 }}>{row.hint}</div>
                )}
              </div>
              <span style={{
                fontSize: row.isTotal ? 14 : 12,
                fontWeight: row.isTotal ? 700 : 500,
                color: row.amount < 0 ? T.red : row.isTotal ? T.slate900 : T.slate700,
                fontVariantNumeric: "tabular-nums",
              }}>
                {row.amount < 0 ? "−" : ""}{fmt(Math.abs(Math.round(row.amount)))}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.slate600, letterSpacing: "0.02em", textTransform: "uppercase" }}>
          Line items · {period}
        </div>
        {compositeOnly && (
          <div style={{ fontSize: 10, color: T.amber, fontWeight: 600 }}>
            ⚠ Showing source deposits — detail PDF not yet parsed
          </div>
        )}
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
          {displayRows.map((r,i) => (
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

      {/* S-Corp Owner Compensation — moved from HR & People 2026-07-16 */}
      <OwnerCompensationSection benefits={data?.benefits} />
    </div>
  );
};

// ─── Section: AIPP & ScoreBoard ──────────────────────────────
const AIPPSection = ({ data }) => {
  const aippData = data?.aipp || {};
  const year             = aippData.year             || new Date().getFullYear();
  const target           = aippData.target           || 0;
  const earned           = aippData.earned           || 0;
  const projected        = aippData.projected        || 0;
  const priorYear        = aippData.priorYear        || 0;
  const priorYearLabel   = aippData.priorYearLabel   || (year - 1);
  const priorPriorYear   = aippData.priorPriorYear   || 0;
  const priorPriorLabel  = aippData.priorPriorYearLabel || (year - 2);
  const yoyDelta         = aippData.yoyDelta;
  const yoyPct           = aippData.yoyPct;
  const monthlyEarned    = Array.isArray(aippData.monthlyEarned) ? aippData.monthlyEarned : [];
  const scoreboard       = Array.isArray(data?.scoreboard) ? data.scoreboard : [];
  const achievement      = pct(earned, target);
  const projPct          = pct(projected, target);
  // YoY status: down >10% is bad
  const yoyStatus        = yoyPct === null ? null : yoyPct < -10 ? "critical" : yoyPct < 0 ? "warning" : "good";
  const yoyColor         = yoyStatus === "critical" ? T.red : yoyStatus === "warning" ? T.amber : T.green;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12 }}>

        {/* AIPP Progress */}
        <Card>
          <CardHeader
            title={`AIPP ${year} — Annual Incentive Progress`}
            action={<AskBtn context={`AIPP ${year}: Target $${target}, Earned YTD $${earned}, Achievement ${achievement}%, Projected $${projected}, Prior Year $${priorYear}. Am I on track? What do I need to focus on?`} />}
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

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
            {[
              { label: "Earned YTD",         value: fmt(earned),         color: T.green },
              { label: "Projected",          value: fmt(projected),      color: projPct >= 95 ? T.green : T.amber },
              { label: `PY ${priorYearLabel}`,  value: fmt(priorYear),      color: T.slate700 },
              { label: `PY ${priorPriorLabel}`, value: fmt(priorPriorYear), color: T.slate500 },
            ].map((s,i) => (
              <div key={i} style={{ background: T.slate50, borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
                <div style={{ fontSize: 10, color: T.slate500, marginBottom: 4 }}>{s.label}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>

          {yoyPct !== null && (
            <div style={{
              marginTop: 14,
              padding: "10px 12px",
              borderRadius: 8,
              fontSize: 11,
              lineHeight: 1.5,
              background: yoyStatus === "good" ? T.greenLt : yoyStatus === "warning" ? T.amberLt : T.redLt,
              borderLeft: `3px solid ${yoyColor}`,
              color: yoyStatus === "good" ? "#065F46" : yoyStatus === "warning" ? "#92400E" : "#991B1B",
            }}>
              <strong>YoY trend:</strong> {priorYearLabel} AIPP {fmt(priorYear)} vs {priorPriorLabel} {fmt(priorPriorYear)} —{" "}
              <strong>{yoyPct >= 0 ? "↑" : "↓"} {Math.abs(yoyPct).toFixed(1)}%</strong>
              {yoyStatus === "critical" && " · production needs Q3/Q4 catch-up plan"}
              {yoyStatus === "warning" && " · monitor closely"}
            </div>
          )}

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
            title="ScoreBoard Metrics — 2026"
            sub="Progress toward performance recognition"
            action={<AskBtn context="My ScoreBoard metrics for 2026: reviewing progress toward SF performance recognition. Help me identify which metrics need the most attention." />}
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
          <div style={{
            marginTop: 16, padding: "10px 12px",
            background: T.slate50, borderRadius: 8,
            fontSize: 11, color: T.slate600,
            borderLeft: `3px solid ${T.amber}`,
          }}>
            Retention rate is above target — excellent. New Business Policies at 48% needs attention to hit ScoreBoard recognition level.
          </div>
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
        sub={`YTD Gross: ${fmt(ytdGross)} · YTD Taxes: ${fmt(ytdTax)}`}
        action={<AskBtn context={`My agency payroll YTD: Gross ${fmt(ytdGross)}, Employer taxes ${fmt(ytdTax)}. Help me review payroll expenses and identify any concerns.`} />}
      />
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
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 10 }}>
        {bankAccounts.map((a, i) => (
          <Card key={i}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.slate700 }}>{a.name}</div>
              <Pill type={a.reconciled ? "success" : "warning"}>
                {a.reconciled ? "Reconciled" : "Pending"}
              </Pill>
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: T.slate900, letterSpacing: "-0.02em" }}>
              {fmt(a.balance)}
            </div>
            <div style={{ fontSize: 10, color: T.slate400, marginTop: 4 }}>
              As of {a.asOf} · ••••{a.last4}
            </div>
          </Card>
        ))}
        <Card style={{ background: T.navy, border: "none" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.7)", marginBottom: 8 }}>Total Cash Position</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: T.textOnColor, letterSpacing: "-0.02em" }}>{fmt(totalCash)}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 4 }}>All accounts combined</div>
        </Card>
      </div>
    </div>
  );
};

// ─── Section: Credit & Debt ───────────────────────────────────
const CreditSection = ({ data }) => {
  const totalDebt = (data.creditAccounts || []).reduce((s,r) => s + r.balance, 0);
  const totalAvailable = (data.creditAccounts || []).filter(a => a.limit).reduce((s,r) => s + (r.limit - r.balance), 0);

  // Next payment due: pick the card with the soonest due day where we actually know the due day + payment amount.
  // Returns null when no card has those fields populated — render a "—" placeholder instead of a fake SBA loan.
  const nextDue = (data.creditAccounts || [])
    .filter(a => a.dueDay && a.payment > 0)
    .sort((x, y) => x.dueDay - y.dueDay)[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 10, marginBottom: 4 }}>
        <KPICard label="Total Debt Exposure" value={fmtMoney(totalDebt)} color={T.red} border={T.red} />
        <KPICard label="Available Credit" value={fmt(totalAvailable)} color={T.green} border={T.green} />
        <KPICard
          label="Next Payment Due"
          value={nextDue ? `Day ${nextDue.dueDay}` : "—"}
          sub={nextDue ? `${nextDue.name} — ${fmt(nextDue.payment)}` : "No payment dates set"}
          border={T.amber}
        />
      </div>

      {(data.creditAccounts || []).map((a, i) => (
        <Card key={i}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.slate800 }}>{a.name}</div>
              <div style={{ fontSize: 11, color: T.slate500, marginTop: 2 }}>
                {(a.type === "credit_card" || a.type === "business_credit_card") ? "Credit Card" : a.type === "loan" ? "Loan" : "Line of Credit"} · ••••{a.last4}{a.rate > 0 ? ` · ${a.rate}% APR` : ""}
              </div>
            </div>
            <AskBtn context={`${a.name}: Balance ${fmt(a.balance)}, Rate ${a.rate}%, Payment due on the ${a.dueDay}. Minimum payment: ${fmt(a.payment)}. Help me think about this debt.`} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px,1fr))", gap: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: T.slate500, marginBottom: 2 }}>Current Balance</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: a.balance > 0 ? T.red : T.slate600 }}>{fmtMoney(a.balance)}</div>
              {a.asOf && (
                <div style={{ fontSize: 9, color: T.slate400, marginTop: 2 }}>
                  as of {new Date(a.asOf).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </div>
              )}
            </div>
            {a.limit && (
              <div>
                <div style={{ fontSize: 10, color: T.slate500, marginBottom: 2 }}>Available Credit</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: T.green }}>{fmt(a.limit - a.balance)}</div>
              </div>
            )}
            <div>
              <div style={{ fontSize: 10, color: T.slate500, marginBottom: 2 }}>Min Payment</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: T.amber }}>{fmt(a.payment)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: T.slate500, marginBottom: 2 }}>Due Date</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: T.slate800 }}>{a.dueDay ? `Day ${a.dueDay} of month` : "—"}</div>
            </div>
          </div>

          {a.limit && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 10, color: T.slate400, marginBottom: 4 }}>Utilization: {pct(a.balance, a.limit)}%</div>
              <ProgressBar value={a.balance} max={a.limit} color={pct(a.balance,a.limit) > 30 ? T.amber : T.green} height={6} />
            </div>
          )}
        </Card>
      ))}
    </div>
  );
};

// ─── Section: General Ledger ──────────────────────────────────
const GLSection = ({ data }) => {
  const [days, setDays] = useState(90);
  const allEntries = Array.isArray(data?.glEntries) ? data.glEntries : [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const filtered = allEntries.filter(r => !r.date || r.date >= cutoffStr);
  const ranges = [
    { label: "30 days",  d: 30 },
    { label: "90 days",  d: 90 },
    { label: "6 months", d: 180 },
    { label: "1 year",   d: 365 },
    { label: "All",      d: 9999 },
  ];
  return (
    <Card>
      <CardHeader
        title="General Ledger"
        sub={`${filtered.length} entries · ${days >= 9999 ? "All time" : `Last ${days} days`} · BCC + QBO mirror`}
        action={<AskBtn context={`I am reviewing my General Ledger — last ${days} days, ${filtered.length} entries showing. Help me verify these entries look correct and identify anything that needs attention.`} />}
      />
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {ranges.map(r => (
          <button key={r.d} onClick={() => setDays(r.d)} style={{
            padding: "4px 10px", fontSize: 11, fontWeight: days === r.d ? 600 : 400,
            color: days === r.d ? T.white : T.slate600,
            background: days === r.d ? T.navy : T.white,
            border: `1px solid ${days === r.d ? T.navy : T.slate200}`,
            borderRadius: 6, cursor: "pointer",
          }}>{r.label}</button>
        ))}
      </div>
      <div style={{ overflowX: "auto", maxHeight: 600, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead style={{ position: "sticky", top: 0, background: T.white, zIndex: 1 }}>
            <tr style={{ borderBottom: `1px solid ${T.slate200}` }}>
              {["Date","Ref","Source","Description","Account","Debit","Credit"].map((h,i) => (
                <th key={i} style={{ padding: "8px", fontSize: 11, fontWeight: 600, color: T.slate500, textAlign: i >= 5 ? "right" : "left" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r,i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${T.slate100}` }}>
                <td style={{ padding: "8px", fontSize: 11, color: T.slate500 }}>{r.date}</td>
                <td style={{ padding: "8px", fontSize: 11, color: T.blue, fontFamily: "monospace" }}>{r.ref}</td>
                <td style={{ padding: "8px", fontSize: 10 }}>
                  <Pill type={r.source === "qbo" ? "purple" : "info"}>{(r.source || "").toUpperCase()}</Pill>
                </td>
                <td style={{ padding: "8px", fontSize: 12, color: T.slate800 }}>{r.description}</td>
                <td style={{ padding: "8px", fontSize: 11, color: T.slate500, fontFamily: "monospace" }}>{r.account}</td>
                <td style={{ padding: "8px", fontSize: 12, textAlign: "right", color: T.slate900, fontWeight: r.debit ? 500 : 400 }}>{r.debit ? fmt(r.debit) : "—"}</td>
                <td style={{ padding: "8px", fontSize: 12, textAlign: "right", color: T.green, fontWeight: r.credit ? 500 : 400 }}>{r.credit ? fmt(r.credit) : "—"}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={7} style={{ padding: "24px 8px", textAlign: "center", color: T.slate400, fontSize: 12 }}>No entries in this window.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
};

// ─── Main Financials Module ───────────────────────────────────
// ─── Section: Balance Sheet ──────────────────────────────────
const BalanceSheetSection = ({ data }) => {
  const bs = data?.balanceSheet || [];
  if (!Array.isArray(bs) || bs.length === 0) {
    return (
      <Card>
        <CardHeader title="Balance Sheet" sub="Cash-basis snapshot · QBO mirror" />
        <div style={{ padding: "32px 16px", textAlign: "center", color: T.slate500, fontSize: 12 }}>
          No balance sheet snapshots loaded yet. v_balance_sheet view exists but is empty —
          QBO mirror refresh is currently blocked (see active alert).
        </div>
      </Card>
    );
  }

  const latest = bs[0];
  const prior  = bs[1] || null;
  const fmtDelta = (cur, prev) => {
    if (prev == null || prev === 0) return null;
    const pct = ((cur - prev) / Math.abs(prev)) * 100;
    return { pct: pct.toFixed(1), positive: pct >= 0 };
  };
  // Delta label shows the actual prior snapshot date (snapshots aren't always month-end).
  const priorDateLabel = prior?.period_end
    ? new Date(prior.period_end + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "prior";

  const assetsDelta = prior ? fmtDelta(latest.total_assets, prior.total_assets) : null;
  const equityDelta = prior ? fmtDelta(latest.total_equity, prior.total_equity) : null;
  const liabDelta   = prior ? fmtDelta(latest.total_liabilities, prior.total_liabilities) : null;

  const currentRatio = latest.current_liabilities > 0
    ? (latest.current_assets / latest.current_liabilities).toFixed(2)
    : null;
  const debtToEquity = latest.total_equity > 0
    ? (latest.total_liabilities / latest.total_equity).toFixed(2)
    : null;

  const dateLabel = latest.period_end
    ? new Date(latest.period_end + "T00:00:00").toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" })
    : "Latest";

  // Map known QBO-derived snapshot sources to a single clean label; surface unknown values for diagnostics.
  const QBO_SOURCES = new Set(["qbo", "manual_refresh_via_mcp", "scheduled_refresh"]);
  const rawSource = latest.source_layer || "qbo";
  const sourceLabel = QBO_SOURCES.has(rawSource) ? "QBO mirror" : `source: ${rawSource}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Headline KPIs */}
      <Card>
        <CardHeader
          title={`Balance Sheet — As of ${dateLabel}`}
          sub={`${latest.accounting_method || "cash"} basis · ${sourceLabel}`}
        />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 12 }}>
          {[
            { label: "Total Assets",      value: latest.total_assets,      delta: assetsDelta, color: T.green },
            { label: "Total Liabilities", value: latest.total_liabilities, delta: liabDelta,   color: T.red, invertDelta: true },
            { label: "Total Equity",      value: latest.total_equity,      delta: equityDelta, color: T.blue },
            { label: "Working Capital",   value: latest.working_capital,                       color: latest.working_capital >= 0 ? T.green : T.red },
          ].map((kpi, i) => (
            <div key={i} style={{ background: T.slate50, borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontSize: 10, color: T.slate500, marginBottom: 4 }}>{kpi.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: kpi.color, letterSpacing: "-0.02em" }}>
                {fmtCents(kpi.value)}
              </div>
              {kpi.delta != null && (
                <div style={{ fontSize: 10, color: (kpi.invertDelta ? !kpi.delta.positive : kpi.delta.positive) ? T.green : T.red, marginTop: 4 }}>
                  {kpi.delta.positive ? "▲" : "▼"} {Math.abs(parseFloat(kpi.delta.pct))}% vs {priorDateLabel}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* Health ratios */}
      <Card>
        <CardHeader title="Health Ratios" sub="Computed from latest snapshot" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 12 }}>
          <div style={{ background: T.slate50, borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ fontSize: 10, color: T.slate500, marginBottom: 4 }}>Current Ratio</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: T.slate900 }}>{currentRatio || "—"}</div>
            <div style={{ fontSize: 10, color: T.slate400, marginTop: 4 }}>current assets ÷ current liabilities · healthy &gt; 1.5</div>
          </div>
          <div style={{ background: T.slate50, borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ fontSize: 10, color: T.slate500, marginBottom: 4 }}>Debt-to-Equity</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: T.slate900 }}>{debtToEquity || "—"}</div>
            <div style={{ fontSize: 10, color: T.slate400, marginTop: 4 }}>total liabilities ÷ total equity · healthy &lt; 0.5</div>
          </div>
          <div style={{ background: T.slate50, borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ fontSize: 10, color: T.slate500, marginBottom: 4 }}>Current Assets</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: T.slate900 }}>{fmtCents(latest.current_assets)}</div>
            <div style={{ fontSize: 10, color: T.slate400, marginTop: 4 }}>cash + AR + inventory + short-term assets</div>
          </div>
          <div style={{ background: T.slate50, borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ fontSize: 10, color: T.slate500, marginBottom: 4 }}>Current Liabilities</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: T.slate900 }}>{fmtCents(latest.current_liabilities)}</div>
            <div style={{ fontSize: 10, color: T.slate400, marginTop: 4 }}>AP + short-term debt + accrued expenses</div>
          </div>
        </div>
      </Card>

      {/* Monthly trend */}
      <Card>
        <CardHeader title="Monthly Snapshot Trend" sub={`Last ${bs.length} period${bs.length === 1 ? "" : "s"}`} />
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead style={{ background: T.slate50 }}>
              <tr>
                <th style={{ padding: "8px 10px", textAlign: "left",  color: T.slate600, fontWeight: 600 }}>Period End</th>
                <th style={{ padding: "8px 10px", textAlign: "right", color: T.slate600, fontWeight: 600 }}>Total Assets</th>
                <th style={{ padding: "8px 10px", textAlign: "right", color: T.slate600, fontWeight: 600 }}>Total Liab.</th>
                <th style={{ padding: "8px 10px", textAlign: "right", color: T.slate600, fontWeight: 600 }}>Total Equity</th>
                <th style={{ padding: "8px 10px", textAlign: "right", color: T.slate600, fontWeight: 600 }}>Working Capital</th>
                <th style={{ padding: "8px 10px", textAlign: "right", color: T.slate600, fontWeight: 600 }}>Source</th>
              </tr>
            </thead>
            <tbody>
              {bs.map((row, i) => (
                <tr key={row.period_end || i} style={{ borderTop: `1px solid ${T.slate100}` }}>
                  <td style={{ padding: "8px 10px", color: T.slate800, fontWeight: i === 0 ? 600 : 400 }}>
                    {row.period_end ? new Date(row.period_end + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: T.slate800 }}>{fmtCents(row.total_assets)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: T.slate800 }}>{fmtCents(row.total_liabilities)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: T.slate800 }}>{fmtCents(row.total_equity)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: row.working_capital >= 0 ? T.green : T.red }}>{fmtCents(row.working_capital)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: T.slate500 }}>
                    <Pill type={(row.source || "").startsWith("qbo") ? "purple" : "info"}>{(row.source || "qbo").startsWith("qbo") ? "QBO" : (row.source || "—").toUpperCase()}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};

export default function Financials() {
  const [section, setSection] = useState("overview");
  const [period, setPeriod] = useState("mtd");
  const { data: liveData, loading } = useFinancialsData();
  // Prefer live data when it arrives; fall back to the MOCK skeleton during the
  // initial fetch. The previous implementation mutated the module-level MOCK
  // during render, which was a React anti-pattern — it worked most of the time
  // but caused the Overview to briefly render with skeleton nulls, and the
  // Health Ratios section silently returned null (invisible in the UI) because
  // tile.filter(Boolean) collapsed to []. Fix: treat MOCK as read-only, pass
  // the effective data source down explicitly, and show a loading indicator
  // during the fetch window. See changelog 2026-07-17.
  const data = liveData ?? MOCK;

  const sections = [
    { id: "overview",  label: "Overview"        },
    { id: "pl",        label: "P&L"             },
    { id: "balance",   label: "Balance Sheet"   },
    { id: "comp",      label: "COMP_RECAP"      },
    { id: "aipp",      label: "AIPP & ScoreBoard"},
    { id: "payroll",   label: "Payroll"         },
    { id: "bank",      label: "Bank Accounts"   },
    { id: "credit",    label: "Credit & Debt"   },
    { id: "gl",        label: "General Ledger"  },
    { id: "report",    label: "📄 Report Package"},
  ];

  return (
    <div>
      {/* Module Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: T.slate900, letterSpacing: "-0.02em" }}>Financials</div>
          <div style={{ fontSize: 12, color: T.slate500, marginTop: 3 }}>
            Cash basis · Calendar year · All figures in USD
          </div>
        </div>
        <AskBtn context="I am reviewing my agency financials. Help me get a complete picture of my financial health, identify any concerns, and suggest what I should focus on." />
      </div>


      {/* Loading indicator — shows during the initial fetch so users see something */}
      {/* instead of an empty ratios section. Once liveData arrives, this hides.    */}
      {loading && !liveData && (
        <div style={{
          padding: "12px 16px", marginBottom: 12,
          background: T.slate50, border: `1px solid ${T.slate200}`,
          borderRadius: 8, fontSize: 12, color: T.slate600,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <div style={{
            width: 12, height: 12, borderRadius: "50%",
            border: `2px solid ${T.slate300}`, borderTopColor: T.slate600,
            animation: "spin 0.8s linear infinite",
          }} />
          Loading financial data…
        </div>
      )}

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
      {section === "overview" && <OverviewSection period={period} setPeriod={setPeriod} data={data} />}
      {section === "pl"       && <PLSection data={data} />}
      {section === "balance"  && <BalanceSheetSection data={data} />}
      {section === "comp"     && <CompRecapSection data={data} />}
      {section === "aipp"     && <AIPPSection data={data} />}
      {section === "payroll"  && <PayrollSection data={data} />}
      {section === "bank"     && <BankSection data={data} />}
      {section === "credit"   && <CreditSection data={data} />}
      {section === "gl"       && <GLSection data={data} />}
      {section === "report"   && <ReportPackage />}
    </div>
  );
}

