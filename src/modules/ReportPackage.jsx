import { useState, useEffect } from "react";
import { supabase, AGENCY_ID } from "../lib/supabase.js";

// ============================================================
// REPORT PACKAGE MODULE v1.0
// CPA / Lender-ready Financial Report Package
// 10 print-styled pages with auto-generated narrative
// Built by Imaginary Farms LLC · imaginary-farms.com
// ============================================================

// ─── Design Tokens (matches BCCApp + Financials) ─────────────
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

// ─── SF Agency Reference Guide Benchmarks ────────────────────
const BENCHMARKS = {
  payrollPctGross:     { healthy: [40, 50], warning: [51, 55], critical: 55, direction: "lower",  label: "Payroll + Taxes / Gross" },
  teamPayrollPctGross: { healthy: [30, 38], warning: [39, 45], critical: 45, direction: "lower",  label: "Team Payroll / Gross" },
  ownerCompPctGross:   { healthy: [25, 35], warning: [20, 24], critical: 20, direction: "higher", label: "Owner Comp / Gross" },
  rentPctGross:        { healthy: [5, 8],   warning: [9, 12],  critical: 12, direction: "lower",  label: "Rent / Gross" },
  opexPctGross:        { healthy: [15, 22], warning: [23, 28], critical: 28, direction: "lower",  label: "Operating Expenses / Gross" },
  netMarginPct:        { healthy: [25, 35], warning: [20, 24], critical: 20, direction: "higher", label: "Net Profit Margin" },
};

function classifyRatio(value, key) {
  const b = BENCHMARKS[key];
  if (!b || !Number.isFinite(Number(value))) return "unknown";
  const v = Number(value);
  if (b.direction === "lower") {
    if (v <= b.healthy[1]) return "healthy";
    if (v <= b.warning[1]) return "warning";
    return "critical";
  } else {
    if (v >= b.healthy[0]) return "healthy";
    if (v >= b.warning[0]) return "warning";
    return "critical";
  }
}

const BAND_COLORS = {
  healthy:  { bg: T.greenLt,  text: "#065F46", border: T.green  },
  warning:  { bg: T.amberLt,  text: "#92400E", border: T.amber  },
  critical: { bg: T.redLt,    text: "#991B1B", border: T.red    },
  unknown:  { bg: T.slate100, text: T.slate500, border: T.slate200 },
};

// ─── Formatters ──────────────────────────────────────────────
function fmtMoney(n, opts = {}) {
  if (n == null || !Number.isFinite(Number(n))) return opts.dash || "—";
  const v = Number(n);
  if (opts.cents) {
    return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtPct(n, decimals = 1) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `${Number(n).toFixed(decimals)}%`;
}

function pctChange(curr, prior) {
  if (!Number.isFinite(Number(curr)) || !Number.isFinite(Number(prior)) || Number(prior) === 0) return null;
  return ((Number(curr) - Number(prior)) / Math.abs(Number(prior))) * 100;
}

function monthName(m) {
  return ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m] || "";
}

function monthShort(m) {
  return ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m] || "";
}

// ─── Period Preset Resolution ────────────────────────────────
// Returns { fromYear, fromMonth, toYear, toMonth, label, short, compareMode }
// compareMode: "prior_period" (same range prior year) or "prior_ytd" (Jan-to-current prior year)
function resolvePreset(preset, now, customFrom, customTo) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const lastMonth = m === 1 ? 12 : m - 1;
  const lastMonthYear = m === 1 ? y - 1 : y;
  const thisQ = Math.ceil(m / 3);
  const thisQStart = (thisQ - 1) * 3 + 1;
  const prevQ = thisQ === 1 ? 4 : thisQ - 1;
  const prevQYear = thisQ === 1 ? y - 1 : y;
  const prevQStart = (prevQ - 1) * 3 + 1;
  const prevQEnd = prevQ * 3;
  let t12sm = m - 11, t12sy = y;
  while (t12sm <= 0) { t12sm += 12; t12sy -= 1; }

  switch (preset) {
    case "this_month":
      return { fromYear: y, fromMonth: m, toYear: y, toMonth: m,
        label: `${monthName(m)} ${y}`, short: `${monthShort(m)} ${y}`, compareMode: "prior_period" };
    case "last_month":
      return { fromYear: lastMonthYear, fromMonth: lastMonth, toYear: lastMonthYear, toMonth: lastMonth,
        label: `${monthName(lastMonth)} ${lastMonthYear}`, short: `${monthShort(lastMonth)} ${lastMonthYear}`, compareMode: "prior_period" };
    case "mtd":
      return { fromYear: y, fromMonth: m, toYear: y, toMonth: m,
        label: `Month-to-Date · ${monthName(m)} ${y}`, short: `MTD ${monthShort(m)} ${y}`, compareMode: "prior_period" };
    case "this_quarter":
      return { fromYear: y, fromMonth: thisQStart, toYear: y, toMonth: m,
        label: `Q${thisQ} ${y} · Quarter-to-Date through ${monthName(m)}`, short: `Q${thisQ} ${y}`, compareMode: "prior_period" };
    case "last_quarter":
      return { fromYear: prevQYear, fromMonth: prevQStart, toYear: prevQYear, toMonth: prevQEnd,
        label: `Q${prevQ} ${prevQYear}`, short: `Q${prevQ} ${prevQYear}`, compareMode: "prior_period" };
    case "ytd":
      return { fromYear: y, fromMonth: 1, toYear: y, toMonth: m,
        label: `Year-to-Date through ${monthName(m)} ${y}`, short: `YTD ${y}`, compareMode: "prior_ytd" };
    case "last_year_ytd":
      return { fromYear: y - 1, fromMonth: 1, toYear: y - 1, toMonth: m,
        label: `${y - 1} Year-to-Date through ${monthName(m)}`, short: `${y - 1} YTD`, compareMode: "prior_ytd" };
    case "last_year_full":
      return { fromYear: y - 1, fromMonth: 1, toYear: y - 1, toMonth: 12,
        label: `Full Year ${y - 1}`, short: `FY ${y - 1}`, compareMode: "prior_period" };
    case "trailing_12":
      return { fromYear: t12sy, fromMonth: t12sm, toYear: y, toMonth: m,
        label: `Trailing 12 Months · ${monthName(t12sm)} ${t12sy} – ${monthName(m)} ${y}`,
        short: `T12 ${monthShort(m)} ${y}`, compareMode: "prior_period" };
    case "custom": {
      const fy = customFrom?.year ?? y;
      const fm = customFrom?.month ?? 1;
      const ty = customTo?.year ?? y;
      const tm = customTo?.month ?? m;
      const single = (fy === ty && fm === tm);
      return { fromYear: fy, fromMonth: fm, toYear: ty, toMonth: tm,
        label: single
          ? `${monthName(fm)} ${fy}`
          : `${monthName(fm)} ${fy} – ${monthName(tm)} ${ty}`,
        short: single
          ? `${monthShort(fm)} ${fy}`
          : `${monthShort(fm)} ${fy}–${monthShort(tm)} ${ty}`,
        compareMode: "prior_period" };
    }
    default:
      return { fromYear: y, fromMonth: 1, toYear: y, toMonth: m,
        label: `Year-to-Date through ${monthName(m)} ${y}`, short: `YTD ${y}`, compareMode: "prior_ytd" };
  }
}

// ─── Live Data Hook ──────────────────────────────────────────
function useReportPackageData(spec) {
  const [data, setData] = useState({ loading: true });

  useEffect(() => {
    (async () => {
      try {
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;

        const p = resolvePreset(spec.preset, now, spec.customFrom, spec.customTo);

        // Report scope flags — determine which datasets to fetch
        const rt = spec.reportType || "full_package";
        const needIS   = rt === "full_package" || rt === "pl";
        const needBS   = rt === "full_package" || rt === "bs";
        const needComp = rt === "full_package" || rt === "pl";
        const needPay  = rt === "full_package";
        const needAipp = rt === "full_package";
        const needGL   = rt === "full_package" || rt === "gl";

        // Date range for GL entry filtering
        const fromDate = `${p.fromYear}-${String(p.fromMonth).padStart(2, "0")}-01`;
        const toLastDay = new Date(p.toYear, p.toMonth, 0).getDate();
        const toDate = `${p.toYear}-${String(p.toMonth).padStart(2, "0")}-${String(toLastDay).padStart(2, "0")}`;

        const promises = [
          supabase.from("agency").select("*").eq("id", AGENCY_ID).maybeSingle(),
          needIS ? supabase
            .from("qbo_income_statement_monthly")
            .select("*")
            .eq("agency_id", AGENCY_ID)
            .order("period_year", { ascending: false })
            .order("period_month", { ascending: false })
            : Promise.resolve({ data: [], error: null }),
          needComp ? supabase
            .from("comp_recap")
            .select("period_year, period_month, comp_type, comp_category, description, amount, is_aipp_eligible, is_scoreboard_eligible")
            .eq("agency_id", AGENCY_ID)
            .gte("period_year", currentYear - 1)
            .order("period_year", { ascending: false })
            .order("period_month", { ascending: false })
            : Promise.resolve({ data: [], error: null }),
          needPay ? supabase
            .from("payroll_runs")
            .select("pay_date, gross_payroll, employer_taxes, net_payroll, employees_paid")
            .eq("agency_id", AGENCY_ID)
            .order("pay_date", { ascending: false })
            : Promise.resolve({ data: [], error: null }),
          needBS ? supabase
            .from("qbo_snapshots")
            .select("*")
            .eq("agency_id", AGENCY_ID)
            .eq("report_type", "balance_sheet")
            .order("period_end", { ascending: false })
            : Promise.resolve({ data: [], error: null }),
          needAipp ? supabase
            .from("aipp_tracking")
            .select("*")
            .eq("agency_id", AGENCY_ID)
            .eq("program_year", currentYear)
            .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          needAipp ? supabase
            .from("goals")
            .select("*")
            .eq("agency_id", AGENCY_ID)
            .eq("goal_type", "aipp_target")
            .eq("year", currentYear)
            .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          needGL ? supabase
            .from("journal_entries")
            .select("id, entry_date, entry_type, reference_number, description, memo, source")
            .eq("agency_id", AGENCY_ID)
            .gte("entry_date", fromDate)
            .lte("entry_date", toDate)
            .order("entry_date", { ascending: true })
            .order("reference_number", { ascending: true })
            : Promise.resolve({ data: [], error: null }),
          needGL ? supabase
            .from("chart_of_accounts")
            .select("id, account_code, account_name, account_type, account_subtype")
            .eq("agency_id", AGENCY_ID)
            .eq("is_active", true)
            : Promise.resolve({ data: [], error: null }),
        ];

        const [agencyRes, isRes, compRes, payRes, bsRes, aippRes, goalRes, jeRes, coaRes] = await Promise.all(promises);

        // GL: fetch lines for the fetched entries (in-memory join)
        let glRows = [];
        let glAccountTotals = [];
        if (needGL && (jeRes.data || []).length > 0) {
          const entries = jeRes.data || [];
          const entryIds = entries.map(e => e.id);
          const accounts = coaRes.data || [];
          const acctById = new Map(accounts.map(a => [a.id, a]));
          const entryById = new Map(entries.map(e => [e.id, e]));

          // Batch fetch lines (in chunks of 200 for safety)
          const linesAll = [];
          for (let i = 0; i < entryIds.length; i += 200) {
            const chunk = entryIds.slice(i, i + 200);
            const { data: linesChunk } = await supabase
              .from("journal_lines")
              .select("id, journal_entry_id, account_id, debit, credit, description")
              .eq("agency_id", AGENCY_ID)
              .in("journal_entry_id", chunk);
            if (linesChunk) linesAll.push(...linesChunk);
          }

          // Build joined rows for GL table
          glRows = linesAll.map(l => {
            const e = entryById.get(l.journal_entry_id) || {};
            const a = acctById.get(l.account_id) || {};
            return {
              entry_date: e.entry_date,
              reference_number: e.reference_number || "",
              entry_desc: e.description || "",
              entry_memo: e.memo || "",
              source: e.source || "",
              account_code: a.account_code || "",
              account_name: a.account_name || "(unknown)",
              account_type: a.account_type || "",
              line_desc: l.description || "",
              debit: Number(l.debit) || 0,
              credit: Number(l.credit) || 0,
            };
          }).sort((a, b) => {
            if (a.entry_date !== b.entry_date) return a.entry_date < b.entry_date ? -1 : 1;
            if (a.reference_number !== b.reference_number) return a.reference_number < b.reference_number ? -1 : 1;
            return (a.account_code || "").localeCompare(b.account_code || "");
          });

          // Aggregate per account for summary page
          const acctAgg = new Map();
          for (const r of glRows) {
            const k = r.account_code + "|" + r.account_name;
            if (!acctAgg.has(k)) acctAgg.set(k, { account_code: r.account_code, account_name: r.account_name, account_type: r.account_type, debit: 0, credit: 0, count: 0 });
            const v = acctAgg.get(k);
            v.debit += r.debit;
            v.credit += r.credit;
            v.count += 1;
          }
          glAccountTotals = Array.from(acctAgg.values()).sort((a, b) => (a.account_code || "").localeCompare(b.account_code || ""));
        }

        setData({
          loading: false,
          agency: agencyRes.data || null,
          isRows: isRes.data || [],
          compRows: compRes.data || [],
          payrollRows: payRes.data || [],
          qboBS: bsRes.data || [],
          aipp: aippRes.data || null,
          aippGoal: goalRes.data || null,
          glRows,
          glAccountTotals,
          period: {
            preset: spec.preset,
            reportType: rt,
            fromYear: p.fromYear,
            fromMonth: p.fromMonth,
            toYear: p.toYear,
            toMonth: p.toMonth,
            compareMode: p.compareMode,
            label: p.label,
            short: p.short,
            currentYear,
            currentMonth,
          },
        });
      } catch (err) {
        console.error("useReportPackageData error:", err);
        setData({ loading: false, error: err.message });
      }
    })();
  }, [spec.preset, spec.reportType, spec.customFrom?.year, spec.customFrom?.month, spec.customTo?.year, spec.customTo?.month]);

  return data;
}

function summarizeIncomeStatement(rows, year, monthStart, monthEnd) {
  const filtered = (rows || []).filter(r => r?.year === year && r?.month >= monthStart && r?.month <= monthEnd);
  const groups = {
    revenue: 0,
    cogs: 0,
    operating_expense: 0,
    rent: 0,
    ownerComp: 0,
    payroll: 0,
    byAccount: {},
    bySubtype: {},
  };
  for (const r of filtered) {
    const amt = Number(r?.amount) || 0;
    const type = (r?.account_type || "").toLowerCase();
    const sub = (r?.account_subtype || "").toLowerCase();
    const name = (r?.account_name || "").toLowerCase();

    if (type === "revenue" || type === "income") groups.revenue += amt;
    else if (type === "cogs" || type === "cost_of_goods_sold") groups.cogs += amt;
    else if (type === "expense" || type === "operating_expense") {
      groups.operating_expense += amt;
      if (sub.includes("rent") || name.includes("rent")) groups.rent += amt;
      if (sub.includes("payroll") || name.includes("payroll") || name.includes("salaries") || name.includes("wages")) groups.payroll += amt;
      if (name.includes("officer") || name.includes("owner")) groups.ownerComp += amt;
    }

    const key = r?.account_name || "Unknown";
    groups.byAccount[key] = (groups.byAccount[key] || 0) + amt;
    if (sub) groups.bySubtype[sub] = (groups.bySubtype[sub] || 0) + amt;
  }
  groups.grossProfit = groups.revenue - groups.cogs;
  groups.netIncome = groups.revenue - groups.cogs - groups.operating_expense;
  return groups;
}

// ─── COMP_RECAP Grouper ──────────────────────────────────────
function summarizeCompRecap(rows, year, monthStart, monthEnd) {
  const filtered = (rows || []).filter(r => r?.period_year === year && r?.period_month >= monthStart && r?.period_month <= monthEnd);
  const byType = {};
  let total = 0;
  let aippEligible = 0;
  let scoreboardEligible = 0;
  for (const r of filtered) {
    const amt = Number(r?.amount) || 0;
    const type = r?.comp_type || "other";
    byType[type] = (byType[type] || 0) + amt;
    total += amt;
    if (r?.is_aipp_eligible) aippEligible += amt;
    if (r?.is_scoreboard_eligible) scoreboardEligible += amt;
  }
  return { byType, total, aippEligible, scoreboardEligible, rowCount: filtered.length };
}

// ─── Auto-Narrative Builder ──────────────────────────────────
function buildNarrative({ ytdCurrIS, ytdPriorIS, ratios, aipp, currentMonth }) {
  const highlights = [];
  const concerns = [];
  const recommendations = [];

  const revChange = pctChange(ytdCurrIS.revenue, ytdPriorIS.revenue);
  if (revChange != null) {
    if (revChange >= 5) highlights.push(`Revenue YTD of ${fmtMoney(ytdCurrIS.revenue)} is up ${fmtPct(revChange)} versus prior year same period.`);
    else if (revChange <= -5) concerns.push(`Revenue YTD of ${fmtMoney(ytdCurrIS.revenue)} is down ${fmtPct(Math.abs(revChange))} versus prior year same period.`);
    else highlights.push(`Revenue YTD of ${fmtMoney(ytdCurrIS.revenue)} is essentially flat (${fmtPct(revChange)}) versus prior year same period.`);
  }

  if (ytdCurrIS.netIncome > 0) {
    highlights.push(`Net income YTD: ${fmtMoney(ytdCurrIS.netIncome)} on ${fmtMoney(ytdCurrIS.revenue)} of revenue.`);
  } else if (ytdCurrIS.netIncome < 0) {
    concerns.push(`Net loss YTD: ${fmtMoney(ytdCurrIS.netIncome)}. Review expense categories.`);
  }

  if (Number.isFinite(ratios.netMarginPct) && ytdCurrIS.revenue > 0) {
    const cls = classifyRatio(ratios.netMarginPct, "netMarginPct");
    if (cls === "healthy") highlights.push(`Net profit margin of ${fmtPct(ratios.netMarginPct)} is in the healthy 25–35% range.`);
    else if (cls === "warning") concerns.push(`Net profit margin of ${fmtPct(ratios.netMarginPct)} is below the healthy range (target 25–35%).`);
    else if (cls === "critical") concerns.push(`Net profit margin of ${fmtPct(ratios.netMarginPct)} is in critical territory (below 20%). Immediate expense review recommended.`);
  }

  if (Number.isFinite(ratios.payrollPctGross) && ratios.payrollPctGross > 0) {
    const cls = classifyRatio(ratios.payrollPctGross, "payrollPctGross");
    if (cls === "warning") concerns.push(`Total payroll as a percentage of gross revenue (${fmtPct(ratios.payrollPctGross)}) is in the warning band (51–55%).`);
    else if (cls === "critical") concerns.push(`Total payroll as a percentage of gross revenue (${fmtPct(ratios.payrollPctGross)}) exceeds 55% — critical band.`);
  }

  if (aipp) {
    const earned = Number(aipp.earned_ytd) || 0;
    const projected = Number(aipp.projected_full_year) || 0;
    const target = Number(aipp.target_amount) || 0;
    if (earned > 0) highlights.push(`AIPP earnings YTD: ${fmtMoney(earned)} (5% of qualifying new P&C premium).`);
    if (projected > 0 && target > 0) {
      const pace = (projected / target) * 100;
      if (pace >= 95) highlights.push(`AIPP full-year projection of ${fmtMoney(projected)} is on pace against the ${fmtMoney(target)} target (${fmtPct(pace)}).`);
      else if (pace < 80) concerns.push(`AIPP full-year projection of ${fmtMoney(projected)} is behind pace; target is ${fmtMoney(target)} (${fmtPct(pace)}).`);
    }
  }

  // Q3 ScoreBoard reminder (June–September window)
  if (currentMonth >= 6 && currentMonth <= 9) {
    recommendations.push("Q3 is the critical window for Life & Health production — the ScoreBoard multiplier for next year is set by Q3-Q4 L&H performance. Verify L&H pace versus prior year same period.");
  }

  // S-Corp comp note (from the agent's CPA brief context)
  if (ytdCurrIS.ownerComp === 0 && ytdCurrIS.revenue > 100000) {
    recommendations.push("No W-2 officer compensation detected in the period. S-Corp owners are required to take reasonable W-2 compensation. Flag for CPA review.");
  }

  if (concerns.length === 0 && highlights.length === 0) {
    highlights.push("Reporting period data is being aggregated. Detailed narrative will populate as the period progresses.");
  }

  return { highlights, concerns, recommendations };
}

// ─── Reusable Print-Page Wrapper ─────────────────────────────
function ReportPage({ children, pageNumber, totalPages }) {
  return (
    <div className="report-page" style={{
      width: "100%",
      minHeight: "9.5in",
      padding: "0.6in 0.6in 0.4in 0.6in",
      boxSizing: "border-box",
      background: T.white,
      color: T.slate900,
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      pageBreakAfter: "always",
      breakAfter: "page",
      position: "relative",
      marginBottom: 24,
      border: `1px solid ${T.slate200}`,
      boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
    }}>
      {children}
      <div style={{
        position: "absolute",
        bottom: "0.25in",
        right: "0.6in",
        fontSize: 10,
        color: T.slate400,
      }}>
        Page {pageNumber}{totalPages ? ` of ${totalPages}` : ""}
      </div>
    </div>
  );
}

// ─── PAGE 1: Cover ───────────────────────────────────────────
function CoverPage({ agency, periodLabel, generatedAt }) {
  return (
    <ReportPage pageNumber={1} totalPages={10}>
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", minHeight: "8.5in", textAlign: "center" }}>
        <div style={{ fontSize: 14, color: T.slate500, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 24 }}>
          Financial Report Package
        </div>
        <div style={{ fontSize: 36, fontWeight: 800, color: T.navy, letterSpacing: "-0.025em", marginBottom: 8 }}>
          {agency?.name || "Agency"}
        </div>
        <div style={{ fontSize: 16, color: T.slate600, marginBottom: 6 }}>
          {agency?.owner_name || ""}, Agent · State Farm Agent Code {agency?.state_farm_agent_code || "—"}
        </div>
        <div style={{ fontSize: 13, color: T.slate500, marginBottom: 60 }}>
          {agency?.entity_type || ""} · {agency?.address || ""}
        </div>

        <div style={{ height: 1, width: 280, background: T.slate200, margin: "0 auto 48px" }} />

        <div style={{ fontSize: 22, fontWeight: 600, color: T.slate800, marginBottom: 8 }}>
          {periodLabel}
        </div>
        <div style={{ fontSize: 13, color: T.slate500, marginBottom: 80 }}>
          Cash basis · All figures in USD
        </div>

        <div style={{ marginTop: 60, fontSize: 12, color: T.slate500 }}>
          Generated {generatedAt}
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: T.slate400, fontStyle: "italic" }}>
          Compiled by the Business Command Center · Not audited · Not reviewed
        </div>
      </div>
    </ReportPage>
  );
}

// ─── PAGE 2: Executive Summary ───────────────────────────────
function KPICard({ label, value, sublabel, tone = "default" }) {
  const palette = {
    default: { bg: T.slate50,  border: T.slate200, value: T.slate900, label: T.slate500 },
    good:    { bg: T.greenLt,  border: T.green,    value: "#065F46",  label: "#047857"  },
    warn:    { bg: T.amberLt,  border: T.amber,    value: "#92400E",  label: "#B45309"  },
    bad:     { bg: T.redLt,    border: T.red,      value: "#991B1B",  label: "#B91C1C"  },
  }[tone] || { bg: T.slate50, border: T.slate200, value: T.slate900, label: T.slate500 };

  return (
    <div style={{
      background: palette.bg,
      border: `1px solid ${palette.border}`,
      borderRadius: 8,
      padding: 14,
      minHeight: 92,
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: palette.label, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: palette.value, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
        {value}
      </div>
      {sublabel && (
        <div style={{ fontSize: 11, color: palette.label, marginTop: 6 }}>
          {sublabel}
        </div>
      )}
    </div>
  );
}

function NarrativeBlock({ title, items, tone }) {
  const palette = {
    good: { bg: T.greenLt,  border: T.green,  title: "#065F46", text: "#064E3B", icon: "✓" },
    warn: { bg: T.amberLt,  border: T.amber,  title: "#92400E", text: "#78350F", icon: "⚠" },
    rec:  { bg: T.blueLt,   border: T.blue,   title: "#1E40AF", text: "#1E3A8A", icon: "→" },
  }[tone];

  if (!items || items.length === 0) {
    return (
      <div style={{ background: T.slate50, border: `1px solid ${T.slate200}`, borderRadius: 8, padding: 14, color: T.slate500, fontSize: 12, fontStyle: "italic" }}>
        {title}: none for this period.
      </div>
    );
  }

  return (
    <div style={{ background: palette.bg, border: `1px solid ${palette.border}`, borderRadius: 8, padding: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: palette.title, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
        {title}
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {items.map((it, i) => (
          <li key={i} style={{ fontSize: 12, color: palette.text, marginBottom: 6, paddingLeft: 18, position: "relative", lineHeight: 1.45 }}>
            <span style={{ position: "absolute", left: 0, top: 0, fontWeight: 700 }}>{palette.icon}</span>
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExecSummaryPage({ ytdCurrIS, ytdPriorIS, ratios, narrative, aipp, payrollYTD, latestBS, periodShort }) {
  const revChange = pctChange(ytdCurrIS.revenue, ytdPriorIS.revenue);
  const netClass = classifyRatio(ratios.netMarginPct, "netMarginPct");
  const payClass = classifyRatio(ratios.payrollPctGross, "payrollPctGross");

  const aippProj = aipp ? Number(aipp.projected_full_year) || 0 : 0;
  const aippTarget = aipp ? Number(aipp.target_amount) || 0 : 0;
  const aippPace = aippTarget > 0 ? (aippProj / aippTarget) * 100 : null;

  const cashOnHand = latestBS ? Number(latestBS.current_assets) || 0 : null;

  return (
    <ReportPage pageNumber={2} totalPages={10}>
      <PageHeader title="Executive Summary" subtitle={periodShort} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
        <KPICard
          label="Revenue YTD"
          value={fmtMoney(ytdCurrIS.revenue)}
          sublabel={revChange != null ? `${revChange >= 0 ? "▲" : "▼"} ${fmtPct(Math.abs(revChange))} vs PY` : "PY data unavailable"}
          tone={revChange != null && revChange >= 5 ? "good" : revChange != null && revChange <= -5 ? "bad" : "default"}
        />
        <KPICard
          label="Net Income YTD"
          value={fmtMoney(ytdCurrIS.netIncome)}
          sublabel={`${fmtPct(ratios.netMarginPct)} margin`}
          tone={netClass === "healthy" ? "good" : netClass === "warning" ? "warn" : netClass === "critical" ? "bad" : "default"}
        />
        <KPICard
          label="Payroll % Gross"
          value={fmtPct(ratios.payrollPctGross)}
          sublabel={`${fmtMoney(payrollYTD)} YTD`}
          tone={payClass === "healthy" ? "good" : payClass === "warning" ? "warn" : payClass === "critical" ? "bad" : "default"}
        />
        <KPICard
          label="AIPP Pace"
          value={aippPace != null ? fmtPct(aippPace) : "—"}
          sublabel={aipp ? `${fmtMoney(Number(aipp.earned_ytd) || 0)} earned` : "No AIPP record"}
          tone={aippPace == null ? "default" : aippPace >= 95 ? "good" : aippPace < 80 ? "bad" : "warn"}
        />
        <KPICard
          label="Owner Comp YTD"
          value={fmtMoney(ytdCurrIS.ownerComp)}
          sublabel={ytdCurrIS.revenue > 0 ? `${fmtPct((ytdCurrIS.ownerComp / ytdCurrIS.revenue) * 100)} of gross` : ""}
          tone={ytdCurrIS.ownerComp === 0 && ytdCurrIS.revenue > 100000 ? "warn" : "default"}
        />
        <KPICard
          label="Cash on Hand"
          value={fmtMoney(cashOnHand, { dash: "—" })}
          sublabel={latestBS ? `As of ${latestBS.period_end}` : "QBO snapshot unavailable"}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <NarrativeBlock title="Highlights" items={narrative.highlights} tone="good" />
        <NarrativeBlock title="Concerns" items={narrative.concerns} tone="warn" />
        <NarrativeBlock title="Recommendations" items={narrative.recommendations} tone="rec" />
      </div>
    </ReportPage>
  );
}

function PageHeader({ title, subtitle }) {
  return (
    <div style={{ borderBottom: `2px solid ${T.navy}`, paddingBottom: 10, marginBottom: 18 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: T.navy, letterSpacing: "-0.02em" }}>
        {title}
      </div>
      {subtitle && (
        <div style={{ fontSize: 12, color: T.slate500, marginTop: 4 }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

// ─── PAGES 3 & 4: Income Statement Tables ────────────────────
function IncomeStatementPage({ pageNumber, title, subtitle, curr, prior, currLabel, priorLabel }) {
  const lines = [
    { label: "Revenue",                 curr: curr.revenue,          prior: prior.revenue,          bold: true,  group: "income" },
    { label: "Cost of Goods Sold",      curr: curr.cogs,             prior: prior.cogs,             group: "cogs" },
    { label: "Gross Profit",            curr: curr.grossProfit,      prior: prior.grossProfit,      bold: true,  separator: true, group: "subtotal" },
    { label: "Operating Expenses",      curr: curr.operating_expense, prior: prior.operating_expense, bold: true, group: "expense_header" },
  ];

  // Subtype-level expense breakdown
  const expenseSubtypes = Object.keys(curr.bySubtype || {}).sort();
  for (const sub of expenseSubtypes) {
    if (Math.abs(curr.bySubtype[sub] || 0) < 1) continue;
    lines.push({
      label: `   ${sub.charAt(0).toUpperCase() + sub.slice(1).replace(/_/g, " ")}`,
      curr: curr.bySubtype[sub] || 0,
      prior: (prior.bySubtype || {})[sub] || 0,
      indent: true,
      group: "expense_detail",
    });
  }

  lines.push({ label: "Net Income", curr: curr.netIncome, prior: prior.netIncome, bold: true, separator: true, group: "total" });

  return (
    <ReportPage pageNumber={pageNumber} totalPages={10}>
      <PageHeader title={title} subtitle={subtitle} />

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: `2px solid ${T.slate800}` }}>
            <th style={{ textAlign: "left", padding: "8px 6px", color: T.slate600, fontWeight: 600, width: "40%" }}></th>
            <th style={{ textAlign: "right", padding: "8px 6px", color: T.slate600, fontWeight: 600 }}>{currLabel}</th>
            <th style={{ textAlign: "right", padding: "8px 6px", color: T.slate600, fontWeight: 600 }}>{priorLabel}</th>
            <th style={{ textAlign: "right", padding: "8px 6px", color: T.slate600, fontWeight: 600 }}>$ Change</th>
            <th style={{ textAlign: "right", padding: "8px 6px", color: T.slate600, fontWeight: 600 }}>% Change</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => {
            const delta = (Number(line.curr) || 0) - (Number(line.prior) || 0);
            const pct = pctChange(line.curr, line.prior);
            const bgColor = line.separator ? T.slate50 : "transparent";
            return (
              <tr key={i} style={{
                borderTop: line.separator ? `1px solid ${T.slate400}` : `1px solid ${T.slate100}`,
                background: bgColor,
              }}>
                <td style={{
                  padding: line.bold ? "8px 6px" : "5px 6px",
                  fontWeight: line.bold ? 700 : 400,
                  color: line.bold ? T.slate900 : T.slate700,
                  paddingLeft: line.indent ? 24 : 6,
                  fontSize: line.indent ? 11 : 12,
                }}>
                  {line.label}
                </td>
                <td style={{
                  padding: line.bold ? "8px 6px" : "5px 6px",
                  textAlign: "right",
                  fontWeight: line.bold ? 700 : 400,
                  color: line.bold ? T.slate900 : T.slate700,
                  fontVariantNumeric: "tabular-nums",
                  fontSize: line.indent ? 11 : 12,
                }}>
                  {fmtMoney(line.curr)}
                </td>
                <td style={{
                  padding: line.bold ? "8px 6px" : "5px 6px",
                  textAlign: "right",
                  fontWeight: line.bold ? 700 : 400,
                  color: T.slate500,
                  fontVariantNumeric: "tabular-nums",
                  fontSize: line.indent ? 11 : 12,
                }}>
                  {fmtMoney(line.prior)}
                </td>
                <td style={{
                  padding: line.bold ? "8px 6px" : "5px 6px",
                  textAlign: "right",
                  color: delta >= 0 ? T.green : T.red,
                  fontWeight: line.bold ? 700 : 400,
                  fontVariantNumeric: "tabular-nums",
                  fontSize: line.indent ? 11 : 12,
                }}>
                  {fmtMoney(delta)}
                </td>
                <td style={{
                  padding: line.bold ? "8px 6px" : "5px 6px",
                  textAlign: "right",
                  color: pct == null ? T.slate400 : pct >= 0 ? T.green : T.red,
                  fontWeight: line.bold ? 700 : 400,
                  fontVariantNumeric: "tabular-nums",
                  fontSize: line.indent ? 11 : 12,
                }}>
                  {pct != null ? fmtPct(pct) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ marginTop: 18, fontSize: 10, color: T.slate400, fontStyle: "italic" }}>
        Source: v_income_statement (Supabase) · Cash basis · Subtype detail shown where expense rows are coded with account_subtype.
      </div>
    </ReportPage>
  );
}

// ─── PAGE 5: COMP_RECAP Comparative ──────────────────────────
function CompRecapPage({ compRows, currentYear, currentMonth, periodMonthStart, periodMonthEnd, periodShort }) {
  const currYTD = summarizeCompRecap(compRows, currentYear, 1, currentMonth);
  const priorYTD = summarizeCompRecap(compRows, currentYear - 1, 1, currentMonth);
  const currPeriod = summarizeCompRecap(compRows, currentYear, periodMonthStart, periodMonthEnd);
  const priorPeriod = summarizeCompRecap(compRows, currentYear - 1, periodMonthStart, periodMonthEnd);

  // Collect all comp_types observed in either period for stable table rows
  const allTypes = Array.from(new Set([
    ...Object.keys(currYTD.byType || {}),
    ...Object.keys(priorYTD.byType || {}),
  ])).sort();

  return (
    <ReportPage pageNumber={5} totalPages={10}>
      <PageHeader title="State Farm Compensation Recap" subtitle={`${periodShort} · comp_recap by comp_type`} />

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 18 }}>
        <thead>
          <tr style={{ borderBottom: `2px solid ${T.slate800}` }}>
            <th style={{ textAlign: "left", padding: "8px 6px", color: T.slate600, fontWeight: 600 }}>Compensation Type</th>
            <th style={{ textAlign: "right", padding: "8px 6px", color: T.slate600, fontWeight: 600 }}>{currentYear} YTD</th>
            <th style={{ textAlign: "right", padding: "8px 6px", color: T.slate600, fontWeight: 600 }}>{currentYear - 1} YTD</th>
            <th style={{ textAlign: "right", padding: "8px 6px", color: T.slate600, fontWeight: 600 }}>$ Change</th>
            <th style={{ textAlign: "right", padding: "8px 6px", color: T.slate600, fontWeight: 600 }}>% Change</th>
          </tr>
        </thead>
        <tbody>
          {allTypes.map((t, i) => {
            const curr = currYTD.byType[t] || 0;
            const prior = priorYTD.byType[t] || 0;
            const delta = curr - prior;
            const pct = pctChange(curr, prior);
            const label = t.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
            return (
              <tr key={i} style={{ borderTop: `1px solid ${T.slate100}` }}>
                <td style={{ padding: "6px 6px", color: T.slate700 }}>{label}</td>
                <td style={{ padding: "6px 6px", textAlign: "right", color: T.slate900, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(curr)}</td>
                <td style={{ padding: "6px 6px", textAlign: "right", color: T.slate500, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(prior)}</td>
                <td style={{ padding: "6px 6px", textAlign: "right", color: delta >= 0 ? T.green : T.red, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(delta)}</td>
                <td style={{ padding: "6px 6px", textAlign: "right", color: pct == null ? T.slate400 : pct >= 0 ? T.green : T.red, fontVariantNumeric: "tabular-nums" }}>{pct != null ? fmtPct(pct) : "—"}</td>
              </tr>
            );
          })}
          <tr style={{ borderTop: `2px solid ${T.slate800}`, background: T.slate50 }}>
            <td style={{ padding: "10px 6px", fontWeight: 700, color: T.slate900 }}>Total Compensation</td>
            <td style={{ padding: "10px 6px", textAlign: "right", fontWeight: 700, color: T.slate900, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(currYTD.total)}</td>
            <td style={{ padding: "10px 6px", textAlign: "right", fontWeight: 700, color: T.slate700, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(priorYTD.total)}</td>
            <td style={{ padding: "10px 6px", textAlign: "right", fontWeight: 700, color: (currYTD.total - priorYTD.total) >= 0 ? T.green : T.red, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(currYTD.total - priorYTD.total)}</td>
            <td style={{ padding: "10px 6px", textAlign: "right", fontWeight: 700, color: pctChange(currYTD.total, priorYTD.total) >= 0 ? T.green : T.red, fontVariantNumeric: "tabular-nums" }}>{pctChange(currYTD.total, priorYTD.total) != null ? fmtPct(pctChange(currYTD.total, priorYTD.total)) : "—"}</td>
          </tr>
        </tbody>
      </table>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
        <KPICard
          label="AIPP-Eligible YTD"
          value={fmtMoney(currYTD.aippEligible)}
          sublabel={`vs ${fmtMoney(priorYTD.aippEligible)} PY YTD`}
        />
        <KPICard
          label="ScoreBoard-Eligible YTD"
          value={fmtMoney(currYTD.scoreboardEligible)}
          sublabel={`vs ${fmtMoney(priorYTD.scoreboardEligible)} PY YTD`}
        />
      </div>

      <div style={{ marginTop: 18, fontSize: 10, color: T.slate400, fontStyle: "italic" }}>
        Source: comp_recap (Supabase) · {currYTD.rowCount} current-year rows · {priorYTD.rowCount} prior-year same-period rows.
      </div>
    </ReportPage>
  );
}

// ─── PAGE 6: Key Ratios ──────────────────────────────────────
function RatiosPage({ ratios }) {
  const ratioRows = [
    { key: "payrollPctGross",     value: ratios.payrollPctGross },
    { key: "teamPayrollPctGross", value: ratios.teamPayrollPctGross },
    { key: "ownerCompPctGross",   value: ratios.ownerCompPctGross },
    { key: "rentPctGross",        value: ratios.rentPctGross },
    { key: "opexPctGross",        value: ratios.opexPctGross },
    { key: "netMarginPct",        value: ratios.netMarginPct },
  ];

  return (
    <ReportPage pageNumber={6} totalPages={10}>
      <PageHeader title="Key Financial Ratios" subtitle="Against State Farm Agency Reference Guide benchmarks" />

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {ratioRows.map((r, i) => {
          const b = BENCHMARKS[r.key];
          const cls = classifyRatio(r.value, r.key);
          const palette = BAND_COLORS[cls];
          const healthyRange = b.direction === "lower"
            ? `≤ ${b.healthy[1]}%`
            : `≥ ${b.healthy[0]}%`;
          const warningRange = b.direction === "lower"
            ? `${b.warning[0]}–${b.warning[1]}%`
            : `${b.warning[0]}–${b.warning[1]}%`;
          const criticalRange = b.direction === "lower"
            ? `> ${b.critical}%`
            : `< ${b.critical}%`;
          return (
            <div key={i} style={{
              border: `1px solid ${palette.border}`,
              borderLeft: `4px solid ${palette.border}`,
              borderRadius: 8,
              padding: 14,
              background: palette.bg,
              display: "grid",
              gridTemplateColumns: "1fr auto auto",
              gap: 16,
              alignItems: "center",
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.slate900 }}>{b.label}</div>
                <div style={{ fontSize: 10, color: T.slate500, marginTop: 4 }}>
                  Healthy: {healthyRange} · Warning: {warningRange} · Critical: {criticalRange}
                </div>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: palette.text, fontVariantNumeric: "tabular-nums" }}>
                {fmtPct(r.value)}
              </div>
              <div style={{
                background: palette.border,
                color: T.textOnColor,
                fontSize: 10,
                fontWeight: 700,
                textTransform: "uppercase",
                padding: "4px 10px",
                borderRadius: 12,
                letterSpacing: "0.05em",
              }}>
                {cls}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 24, padding: 14, background: T.slate50, border: `1px solid ${T.slate200}`, borderRadius: 8, fontSize: 11, color: T.slate600, lineHeight: 1.55 }}>
        <strong style={{ color: T.slate900 }}>Methodology.</strong> Ratios computed against gross income (revenue) from v_income_statement YTD. Benchmark ranges drawn from State Farm Agency Reference Guide. Owner Compensation captures officer/owner-coded payroll accounts. Operating Expenses excludes COGS. Net Margin = (Revenue − COGS − Operating Expenses) / Revenue.
      </div>
    </ReportPage>
  );
}

// ─── PAGE 7: Balance Sheet from QBO Mirror ───────────────────
function BalanceSheetPage({ bs }) {
  if (!bs) {
    return (
      <ReportPage pageNumber={7} totalPages={10}>
        <PageHeader title="Balance Sheet" subtitle="QBO Mirror" />
        <div style={{ padding: 40, textAlign: "center", color: T.slate500, fontSize: 13 }}>
          No QBO balance sheet snapshot available. Run qbo-mirror-refresh Edge Function to populate.
        </div>
      </ReportPage>
    );
  }

  const totalAssets = Number(bs.total_assets) || 0;
  const currentAssets = Number(bs.current_assets) || 0;
  const totalLiabilities = Number(bs.total_liabilities) || 0;
  const currentLiabilities = Number(bs.current_liabilities) || 0;
  const totalEquity = Number(bs.total_equity) || 0;
  const workingCapital = Number(bs.working_capital) || (currentAssets - currentLiabilities);
  const currentRatio = currentLiabilities > 0 ? currentAssets / currentLiabilities : null;
  const debtToEquity = totalEquity > 0 ? totalLiabilities / totalEquity : null;
  const nonCurrentAssets = totalAssets - currentAssets;
  const nonCurrentLiabilities = totalLiabilities - currentLiabilities;

  const rows = [
    { label: "ASSETS",                       value: null,              header: true },
    { label: "Current Assets",                value: currentAssets,     bold: true },
    { label: "Non-Current Assets",            value: nonCurrentAssets,  bold: true },
    { label: "Total Assets",                  value: totalAssets,       bold: true, separator: true },
    { label: "LIABILITIES",                   value: null,              header: true },
    { label: "Current Liabilities",           value: currentLiabilities, bold: true },
    { label: "Non-Current Liabilities",       value: nonCurrentLiabilities, bold: true },
    { label: "Total Liabilities",             value: totalLiabilities,  bold: true, separator: true },
    { label: "EQUITY",                        value: null,              header: true },
    { label: "Total Equity",                  value: totalEquity,       bold: true, separator: true },
    { label: "Total Liabilities + Equity",    value: totalLiabilities + totalEquity, bold: true },
  ];

  return (
    <ReportPage pageNumber={7} totalPages={10}>
      <PageHeader title="Balance Sheet" subtitle={`As of ${bs.period_end} · ${bs.accounting_method || "cash"} basis · QBO mirror`} />

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 20 }}>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{
              borderTop: row.separator ? `2px solid ${T.slate800}` : row.header ? `2px solid ${T.navy}` : `1px solid ${T.slate100}`,
              background: row.header ? T.slate50 : "transparent",
            }}>
              <td style={{
                padding: row.header ? "10px 6px" : row.bold ? "8px 6px" : "6px 6px",
                fontWeight: row.header || row.bold ? 700 : 400,
                color: row.header ? T.navy : T.slate900,
                fontSize: row.header ? 11 : 12,
                letterSpacing: row.header ? "0.05em" : "normal",
                textTransform: row.header ? "uppercase" : "none",
              }}>
                {row.label}
              </td>
              <td style={{
                padding: row.header ? "10px 6px" : row.bold ? "8px 6px" : "6px 6px",
                textAlign: "right",
                fontWeight: row.bold ? 700 : 400,
                color: T.slate900,
                fontVariantNumeric: "tabular-nums",
              }}>
                {row.value != null ? fmtMoney(row.value) : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <KPICard label="Working Capital"  value={fmtMoney(workingCapital)} sublabel="Current Assets − Current Liab." />
        <KPICard label="Current Ratio"    value={currentRatio != null ? currentRatio.toFixed(2) : "—"} sublabel="CA / CL" tone={currentRatio == null ? "default" : currentRatio >= 1.5 ? "good" : currentRatio >= 1 ? "warn" : "bad"} />
        <KPICard label="Debt-to-Equity"   value={debtToEquity != null ? debtToEquity.toFixed(2) : "—"} sublabel="Total Liab. / Equity" tone={debtToEquity == null ? "default" : debtToEquity <= 1 ? "good" : debtToEquity <= 2 ? "warn" : "bad"} />
      </div>

      <div style={{ marginTop: 18, fontSize: 10, color: T.slate400, fontStyle: "italic" }}>
        Source: qbo_snapshots (Supabase) · Snapshot date: {bs.period_end} · Pulled via qbo-mirror-refresh Edge Function.
      </div>
    </ReportPage>
  );
}

// ─── PAGE 8: AIPP & ScoreBoard ───────────────────────────────
function AIPPPage({ aipp, aippGoal, compRows, currentYear, currentMonth }) {
  const earned = aipp ? Number(aipp.earned_ytd) || 0 : 0;
  const projected = aipp ? Number(aipp.projected_full_year) || 0 : 0;
  const target = aipp ? Number(aipp.target_amount) || 0 : (aippGoal ? Number(aippGoal.target_value) || 0 : 0);
  const pace = target > 0 && projected > 0 ? (projected / target) * 100 : null;

  const currScoreboard = summarizeCompRecap(compRows, currentYear, 1, currentMonth).scoreboardEligible;
  const priorScoreboard = summarizeCompRecap(compRows, currentYear - 1, 1, currentMonth).scoreboardEligible;

  return (
    <ReportPage pageNumber={8} totalPages={10}>
      <PageHeader title="AIPP & ScoreBoard" subtitle="Agency Incentive & Performance Programs" />

      <div style={{ background: T.blueLt, border: `1px solid ${T.blue}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.navy, marginBottom: 4 }}>AIPP — Agent Incentive Pay Plan</div>
        <div style={{ fontSize: 11, color: T.slate600, marginBottom: 14 }}>
          5% of qualifying NEW P&C production earnings · Paid each January · Requires 60+ months service · Continues up to 240 months
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <KPICard label="Earned YTD"          value={fmtMoney(earned)} />
          <KPICard label="Target (Full Year)"  value={fmtMoney(target)} />
          <KPICard label="Projected Full Year" value={fmtMoney(projected)} />
          <KPICard
            label="Pace vs Target"
            value={pace != null ? fmtPct(pace) : "—"}
            tone={pace == null ? "default" : pace >= 95 ? "good" : pace < 80 ? "bad" : "warn"}
          />
        </div>

        {!aipp && (
          <div style={{ marginTop: 14, fontSize: 11, color: T.slate500, fontStyle: "italic" }}>
            No aipp_tracking row for program year {currentYear}. The AIPP refresher recipe populates this from comp_recap and producer_production.
          </div>
        )}
      </div>

      <div style={{ background: T.purpleLt, border: `1px solid ${T.purple}`, borderRadius: 8, padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#5B21B6", marginBottom: 4 }}>ScoreBoard — Auto / Fire Bonus</div>
        <div style={{ fontSize: 11, color: T.slate600, marginBottom: 14 }}>
          Life & Health production multiplies the Auto/Fire ScoreBoard bonus. Q3-Q4 L&H performance sets next year's multiplier — strategic agents maximize L&H late in the year.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
          <KPICard
            label={`${currentYear} YTD ScoreBoard-Eligible`}
            value={fmtMoney(currScoreboard)}
            sublabel={`Through ${monthShort(currentMonth)}`}
          />
          <KPICard
            label={`${currentYear - 1} YTD (Same Period)`}
            value={fmtMoney(priorScoreboard)}
            sublabel="From comp_recap"
          />
        </div>

        {currentMonth >= 6 && currentMonth <= 9 && (
          <div style={{ marginTop: 14, padding: 10, background: T.amberLt, border: `1px solid ${T.amber}`, borderRadius: 6, fontSize: 11, color: "#92400E", fontWeight: 600 }}>
            ⚠ Q3 Strategic Reminder · The L&H multiplier window is active. Verify L&H pace and push the L&H production curve through year-end.
          </div>
        )}
      </div>
    </ReportPage>
  );
}

// ─── PAGE 9: Payroll Summary ─────────────────────────────────
function PayrollPage({ payrollRows, currentYear, currentMonth, grossYTD }) {
  const cutoffPriorYTD = `${currentYear - 1}-${String(currentMonth).padStart(2, "0")}-31`;
  const currYTDRuns = (payrollRows || []).filter(r => r?.pay_date >= `${currentYear}-01-01` && r?.pay_date <= `${currentYear}-12-31`);
  const priorYTDRuns = (payrollRows || []).filter(r => r?.pay_date >= `${currentYear - 1}-01-01` && r?.pay_date <= cutoffPriorYTD);

  const currTotalGross = currYTDRuns.reduce((a, r) => a + (Number(r?.gross_payroll) || 0), 0);
  const currTotalTaxes = currYTDRuns.reduce((a, r) => a + (Number(r?.employer_taxes) || 0), 0);
  const currTotalNet = currYTDRuns.reduce((a, r) => a + (Number(r?.net_payroll) || 0), 0);
  const priorTotalGross = priorYTDRuns.reduce((a, r) => a + (Number(r?.gross_payroll) || 0), 0);
  const priorTotalTaxes = priorYTDRuns.reduce((a, r) => a + (Number(r?.employer_taxes) || 0), 0);

  const payrollPctGross = grossYTD > 0 ? ((currTotalGross + currTotalTaxes) / grossYTD) * 100 : 0;
  const avgRunCost = currYTDRuns.length > 0 ? (currTotalGross + currTotalTaxes) / currYTDRuns.length : 0;

  return (
    <ReportPage pageNumber={9} totalPages={10}>
      <PageHeader title="Payroll Summary" subtitle={`${currentYear} YTD through ${monthShort(currentMonth)}`} />

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 20 }}>
        <thead>
          <tr style={{ borderBottom: `2px solid ${T.slate800}` }}>
            <th style={{ textAlign: "left", padding: "8px 6px", color: T.slate600, fontWeight: 600 }}></th>
            <th style={{ textAlign: "right", padding: "8px 6px", color: T.slate600, fontWeight: 600 }}>{currentYear} YTD</th>
            <th style={{ textAlign: "right", padding: "8px 6px", color: T.slate600, fontWeight: 600 }}>{currentYear - 1} YTD</th>
            <th style={{ textAlign: "right", padding: "8px 6px", color: T.slate600, fontWeight: 600 }}>$ Change</th>
            <th style={{ textAlign: "right", padding: "8px 6px", color: T.slate600, fontWeight: 600 }}>% Change</th>
          </tr>
        </thead>
        <tbody>
          {[
            { label: "Gross Payroll", curr: currTotalGross, prior: priorTotalGross },
            { label: "Employer Taxes (FICA/FUTA/SUTA)", curr: currTotalTaxes, prior: priorTotalTaxes },
            { label: "Total Fully-Loaded Payroll", curr: currTotalGross + currTotalTaxes, prior: priorTotalGross + priorTotalTaxes, bold: true, separator: true },
          ].map((row, i) => {
            const delta = row.curr - row.prior;
            const pct = pctChange(row.curr, row.prior);
            return (
              <tr key={i} style={{
                borderTop: row.separator ? `2px solid ${T.slate400}` : `1px solid ${T.slate100}`,
                background: row.separator ? T.slate50 : "transparent",
              }}>
                <td style={{ padding: row.bold ? "10px 6px" : "6px 6px", fontWeight: row.bold ? 700 : 400, color: T.slate900 }}>{row.label}</td>
                <td style={{ padding: row.bold ? "10px 6px" : "6px 6px", textAlign: "right", fontWeight: row.bold ? 700 : 400, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(row.curr)}</td>
                <td style={{ padding: row.bold ? "10px 6px" : "6px 6px", textAlign: "right", fontWeight: row.bold ? 700 : 400, color: T.slate500, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(row.prior)}</td>
                <td style={{ padding: row.bold ? "10px 6px" : "6px 6px", textAlign: "right", fontWeight: row.bold ? 700 : 400, color: delta >= 0 ? T.red : T.green, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(delta)}</td>
                <td style={{ padding: row.bold ? "10px 6px" : "6px 6px", textAlign: "right", fontWeight: row.bold ? 700 : 400, color: pct == null ? T.slate400 : pct >= 0 ? T.red : T.green, fontVariantNumeric: "tabular-nums" }}>{pct != null ? fmtPct(pct) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <KPICard label="Payroll Runs YTD"      value={String(currYTDRuns.length)} sublabel={`vs ${priorYTDRuns.length} PY YTD`} />
        <KPICard label="Avg Fully-Loaded / Run" value={fmtMoney(avgRunCost)} />
        <KPICard
          label="Payroll % of Gross Revenue"
          value={fmtPct(payrollPctGross)}
          tone={(() => { const c = classifyRatio(payrollPctGross, "payrollPctGross"); return c === "healthy" ? "good" : c === "warning" ? "warn" : c === "critical" ? "bad" : "default"; })()}
        />
      </div>

      <div style={{ marginTop: 18, fontSize: 10, color: T.slate400, fontStyle: "italic" }}>
        Source: payroll_runs (Supabase) · Fully-loaded = gross + employer taxes. Used by SF Reference Guide payroll ratios.
      </div>
    </ReportPage>
  );
}

// ─── PAGE 10: Footnotes & Disclosures ────────────────────────

function GLSummaryPage({ pageNumber, glAccountTotals, periodLabel }) {
  const totalDebit  = glAccountTotals.reduce((a, r) => a + r.debit, 0);
  const totalCredit = glAccountTotals.reduce((a, r) => a + r.credit, 0);
  const totalLines  = glAccountTotals.reduce((a, r) => a + r.count, 0);
  return (
    <ReportPage pageNumber={pageNumber}>
      <PageHeader title="General Ledger · Account Summary" subtitle={`Debits and credits by account for the period · ${periodLabel}`} />
      <div style={{ marginBottom: 10, padding: "10px 12px", background: T.slate50, borderRadius: 8, border: `1px solid ${T.slate200}`, display: "flex", gap: 24, fontSize: 11, color: T.slate700 }}>
        <div><strong style={{ color: T.slate900 }}>{glAccountTotals.length}</strong> accounts</div>
        <div><strong style={{ color: T.slate900 }}>{totalLines.toLocaleString()}</strong> journal lines</div>
        <div>Total Debits: <strong style={{ color: T.slate900 }}>{fmtMoney(totalDebit, { decimals: 2 })}</strong></div>
        <div>Total Credits: <strong style={{ color: T.slate900 }}>{fmtMoney(totalCredit, { decimals: 2 })}</strong></div>
        <div>Difference: <strong style={{ color: Math.abs(totalDebit - totalCredit) < 0.01 ? T.green : T.red }}>{fmtMoney(Math.abs(totalDebit - totalCredit), { decimals: 2 })}</strong></div>
      </div>
      <table style={{ width: "100%", fontSize: 10, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: `2px solid ${T.slate700}`, background: T.slate100 }}>
            <th style={{ textAlign: "left",  padding: "6px 8px", color: T.slate700, fontSize: 9, textTransform: "uppercase" }}>Code</th>
            <th style={{ textAlign: "left",  padding: "6px 8px", color: T.slate700, fontSize: 9, textTransform: "uppercase" }}>Account Name</th>
            <th style={{ textAlign: "left",  padding: "6px 8px", color: T.slate700, fontSize: 9, textTransform: "uppercase" }}>Type</th>
            <th style={{ textAlign: "right", padding: "6px 8px", color: T.slate700, fontSize: 9, textTransform: "uppercase" }}>Lines</th>
            <th style={{ textAlign: "right", padding: "6px 8px", color: T.slate700, fontSize: 9, textTransform: "uppercase" }}>Debits</th>
            <th style={{ textAlign: "right", padding: "6px 8px", color: T.slate700, fontSize: 9, textTransform: "uppercase" }}>Credits</th>
            <th style={{ textAlign: "right", padding: "6px 8px", color: T.slate700, fontSize: 9, textTransform: "uppercase" }}>Net</th>
          </tr>
        </thead>
        <tbody>
          {glAccountTotals.map((r, i) => {
            const net = r.debit - r.credit;
            return (
              <tr key={i} style={{ borderBottom: `1px solid ${T.slate100}` }}>
                <td style={{ padding: "5px 8px", color: T.slate600, fontFamily: "monospace", fontSize: 9 }}>{r.account_code}</td>
                <td style={{ padding: "5px 8px", color: T.slate900 }}>{r.account_name}</td>
                <td style={{ padding: "5px 8px", color: T.slate500, fontSize: 9 }}>{r.account_type}</td>
                <td style={{ padding: "5px 8px", color: T.slate600, textAlign: "right" }}>{r.count}</td>
                <td style={{ padding: "5px 8px", color: T.slate900, textAlign: "right" }}>{r.debit ? fmtMoney(r.debit, { decimals: 2 }) : "—"}</td>
                <td style={{ padding: "5px 8px", color: T.slate900, textAlign: "right" }}>{r.credit ? fmtMoney(r.credit, { decimals: 2 }) : "—"}</td>
                <td style={{ padding: "5px 8px", color: net >= 0 ? T.slate900 : T.red, textAlign: "right", fontWeight: 500 }}>{fmtMoney(net, { decimals: 2 })}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: `2px solid ${T.slate700}`, background: T.slate100 }}>
            <td colSpan={3} style={{ padding: "7px 8px", color: T.slate900, fontWeight: 700 }}>TOTAL</td>
            <td style={{ padding: "7px 8px", color: T.slate900, fontWeight: 700, textAlign: "right" }}>{glAccountTotals.reduce((a,r)=>a+r.count,0)}</td>
            <td style={{ padding: "7px 8px", color: T.slate900, fontWeight: 700, textAlign: "right" }}>{fmtMoney(totalDebit, { decimals: 2 })}</td>
            <td style={{ padding: "7px 8px", color: T.slate900, fontWeight: 700, textAlign: "right" }}>{fmtMoney(totalCredit, { decimals: 2 })}</td>
            <td style={{ padding: "7px 8px", color: T.slate900, fontWeight: 700, textAlign: "right" }}>{fmtMoney(totalDebit - totalCredit, { decimals: 2 })}</td>
          </tr>
        </tfoot>
      </table>
    </ReportPage>
  );
}

function GLDetailPage({ pageNumber, rows, pageIndex, totalPages, periodLabel }) {
  return (
    <ReportPage pageNumber={pageNumber}>
      <PageHeader title={`General Ledger · Detail (page ${pageIndex + 1} of ${totalPages})`} subtitle={`Line-by-line journal entries · ${periodLabel}`} />
      <table style={{ width: "100%", fontSize: 9, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: `2px solid ${T.slate700}`, background: T.slate100 }}>
            <th style={{ textAlign: "left",  padding: "5px 6px", color: T.slate700, fontSize: 8, textTransform: "uppercase" }}>Date</th>
            <th style={{ textAlign: "left",  padding: "5px 6px", color: T.slate700, fontSize: 8, textTransform: "uppercase" }}>Ref</th>
            <th style={{ textAlign: "left",  padding: "5px 6px", color: T.slate700, fontSize: 8, textTransform: "uppercase" }}>Account</th>
            <th style={{ textAlign: "left",  padding: "5px 6px", color: T.slate700, fontSize: 8, textTransform: "uppercase" }}>Description</th>
            <th style={{ textAlign: "right", padding: "5px 6px", color: T.slate700, fontSize: 8, textTransform: "uppercase" }}>Debit</th>
            <th style={{ textAlign: "right", padding: "5px 6px", color: T.slate700, fontSize: 8, textTransform: "uppercase" }}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${T.slate100}` }}>
              <td style={{ padding: "4px 6px", color: T.slate600, whiteSpace: "nowrap" }}>{r.entry_date}</td>
              <td style={{ padding: "4px 6px", color: T.slate600, fontFamily: "monospace", fontSize: 8 }}>{r.reference_number}</td>
              <td style={{ padding: "4px 6px", color: T.slate900 }}>
                <div style={{ fontSize: 8, color: T.slate500 }}>{r.account_code}</div>
                <div>{r.account_name}</div>
              </td>
              <td style={{ padding: "4px 6px", color: T.slate700 }}>{r.line_desc || r.entry_desc}</td>
              <td style={{ padding: "4px 6px", color: T.slate900, textAlign: "right" }}>{r.debit ? fmtMoney(r.debit, { decimals: 2 }) : ""}</td>
              <td style={{ padding: "4px 6px", color: T.slate900, textAlign: "right" }}>{r.credit ? fmtMoney(r.credit, { decimals: 2 }) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ReportPage>
  );
}

function GeneralLedgerPages({ glRows, glAccountTotals, periodLabel, startPageNumber }) {
  const ROWS_PER_PAGE = 32;
  if (!glRows || glRows.length === 0) {
    return (
      <ReportPage pageNumber={startPageNumber}>
        <PageHeader title="General Ledger" subtitle={`No journal entries in period · ${periodLabel}`} />
        <div style={{ padding: 60, textAlign: "center", color: T.slate500, fontSize: 13 }}>
          No journal entries exist in this period. Run the GL Entry Writer to post transactions.
        </div>
      </ReportPage>
    );
  }
  const totalDetailPages = Math.ceil(glRows.length / ROWS_PER_PAGE);
  const pages = [];
  pages.push(
    <GLSummaryPage key="gl-summary" pageNumber={startPageNumber} glAccountTotals={glAccountTotals} periodLabel={periodLabel} />
  );
  for (let i = 0; i < totalDetailPages; i++) {
    const chunk = glRows.slice(i * ROWS_PER_PAGE, (i + 1) * ROWS_PER_PAGE);
    pages.push(
      <GLDetailPage
        key={`gl-detail-${i}`}
        pageNumber={startPageNumber + 1 + i}
        rows={chunk}
        pageIndex={i}
        totalPages={totalDetailPages}
        periodLabel={periodLabel}
      />
    );
  }
  return <>{pages}</>;
}

function FootnotesPage({ agency, generatedAt }) {
  const notes = [
    {
      title: "1 · Accounting Basis",
      body: "All figures presented in this report are on a cash basis. Revenue is recognized when funds are received and expenses are recognized when paid. The agency does not use accrual accounting for management reporting purposes.",
    },
    {
      title: "2 · Reporting Currency",
      body: "All amounts are in United States Dollars (USD).",
    },
    {
      title: "3 · Data Sources",
      body: "Income statement detail is sourced from v_income_statement, the unified view that combines BCC-native journal entries with the QBO mirror layer. Compensation detail is sourced from comp_recap, ingested from State Farm AGTCOMP RECAP statements. Payroll is sourced from payroll_runs, ingested from ADP payroll provider files. Balance sheet figures are sourced from qbo_snapshots (QuickBooks Online mirror). AIPP and ScoreBoard projections derive from comp_recap and producer_production where available.",
    },
    {
      title: "4 · State Farm Policy Financing Arrangement (PFA)",
      body: "The Policy Financing Arrangement balance is a State Farm compliance tracking item and is not presented as a business asset on the balance sheet. PFA balances are intentionally excluded from this report.",
    },
    {
      title: "5 · S-Corp Compensation",
      body: "The agency is organized as a Subchapter S corporation. Owner draws and shareholder distributions are equity transactions and do not appear as expenses on the income statement. The IRS requires S-Corp owners who provide services to the business to take reasonable W-2 compensation; this report flags owner W-2 levels for CPA review.",
    },
    {
      title: "6 · Benchmark Source",
      body: "Ratio classifications (Healthy / Warning / Critical) are drawn from the State Farm Agency Reference Guide. Categories: Payroll & Taxes, Team Payroll, Owner Comp, Rent, Operating Expenses, Net Margin.",
    },
    {
      title: "7 · No Assurance Given",
      body: "This report is compiled by management of Sunshine State Insurance State Farm Agency Inc. from internal records and third-party feeds. It has not been audited, reviewed, or compiled by an independent CPA in accordance ssars (AICPA). The information presented is intended for internal management use, lender review, and CPA preparation.",
    },
  ];

  return (
    <ReportPage pageNumber={10} totalPages={10}>
      <PageHeader title="Footnotes & Disclosures" subtitle="Notes to the Financial Report Package" />

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {notes.map((n, i) => (
          <div key={i}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.navy, marginBottom: 4 }}>{n.title}</div>
            <div style={{ fontSize: 11, color: T.slate700, lineHeight: 1.55 }}>{n.body}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 30, padding: 16, background: T.slate50, border: `1px solid ${T.slate200}`, borderRadius: 8 }}>
        <div style={{ fontSize: 11, color: T.slate600, lineHeight: 1.5 }}>
          <div><strong>Prepared by:</strong> {agency?.name || "Agency"}</div>
          <div><strong>State Farm Agent Code:</strong> {agency?.state_farm_agent_code || "—"}</div>
          <div><strong>Entity Type:</strong> {agency?.entity_type || "—"}</div>
          <div><strong>Address:</strong> {agency?.address || "—"}</div>
          <div style={{ marginTop: 8 }}><strong>Report Generated:</strong> {generatedAt}</div>
          <div><strong>System:</strong> Business Command Center v1.0 · Imaginary Farms LLC</div>
        </div>
      </div>
    </ReportPage>
  );
}

// ─── MAIN COMPONENT ──────────────────────────────────────────
export default function ReportPackage() {
  const [reportType, setReportType] = useState("full_package");
  const [preset, setPreset] = useState("ytd");

  const now = new Date();
  const curYear  = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  const [customFromYear,  setCustomFromYear]  = useState(curYear);
  const [customFromMonth, setCustomFromMonth] = useState(1);
  const [customToYear,    setCustomToYear]    = useState(curYear);
  const [customToMonth,   setCustomToMonth]   = useState(curMonth);

  const spec = {
    preset,
    reportType,
    customFrom: preset === "custom" ? { year: customFromYear, month: customFromMonth } : undefined,
    customTo:   preset === "custom" ? { year: customToYear,   month: customToMonth   } : undefined,
  };
  const data = useReportPackageData(spec);

  if (data.loading) {
    return (
      <div style={{ padding: 40, color: T.slate500, fontSize: 13, textAlign: "center" }}>
        Loading report data…
      </div>
    );
  }
  if (data.error) {
    return (
      <div style={{ padding: 40, color: T.red, fontSize: 13 }}>
        Failed to load report data: {data.error}
      </div>
    );
  }

  const { agency, isRows, compRows, payrollRows, qboBS, aipp, aippGoal, glRows, glAccountTotals, period: p } = data;

  // Period summaries (current period vs comparison period)
  const currIS = summarizeIncomeStatement(isRows, p.fromYear, p.fromMonth, p.toMonth);
  // For multi-year custom ranges, summarizeIncomeStatement handles fromYear only.
  // We use fromYear for now; multi-year custom ranges aggregate month-by-month via qbo_income_statement_monthly directly.

  // Comparison period
  const compareYear  = p.fromYear - 1;
  const priorIS = summarizeIncomeStatement(isRows, compareYear, p.fromMonth, p.toMonth);

  // YTD (always calendar-YTD relative to the report end)
  const ytdCurrIS  = summarizeIncomeStatement(isRows, p.toYear, 1, p.toMonth);
  const ytdPriorIS = summarizeIncomeStatement(isRows, p.toYear - 1, 1, p.toMonth);

  // Payroll YTD (calendar YTD relative to today)
  const payrollYTD = (payrollRows || [])
    .filter(r => r?.pay_date >= `${p.currentYear}-01-01`)
    .reduce((acc, r) => acc + (Number(r?.gross_payroll) || 0) + (Number(r?.employer_taxes) || 0), 0);

  // Ratios (computed off YTD)
  const grossYTD = ytdCurrIS.revenue || 0;
  const ratios = {
    payrollPctGross:     grossYTD > 0 ? (payrollYTD / grossYTD) * 100 : 0,
    teamPayrollPctGross: grossYTD > 0 ? ((payrollYTD - ytdCurrIS.ownerComp) / grossYTD) * 100 : 0,
    ownerCompPctGross:   grossYTD > 0 ? (ytdCurrIS.ownerComp / grossYTD) * 100 : 0,
    rentPctGross:        grossYTD > 0 ? (ytdCurrIS.rent / grossYTD) * 100 : 0,
    opexPctGross:        grossYTD > 0 ? (ytdCurrIS.operating_expense / grossYTD) * 100 : 0,
    netMarginPct:        grossYTD > 0 ? (ytdCurrIS.netIncome / grossYTD) * 100 : 0,
  };

  const narrative = buildNarrative({ ytdCurrIS, ytdPriorIS, ratios, aipp, currentMonth: p.currentMonth });

  const latestBS = (qboBS || [])[0] || null;

  const generatedAt = new Date().toLocaleString("en-US", {
    year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

  // Comparison labels
  const currLabel  = p.short;
  const priorLabel = p.compareMode === "prior_ytd" ? `${p.toYear - 1} YTD` : `${p.short.replace(String(p.fromYear), String(p.fromYear - 1)).replace(String(p.toYear), String(p.toYear - 1))}`;

  // Report type labels
  const REPORT_TYPES = [
    { value: "full_package", label: "Full CPA Package (all pages)" },
    { value: "pl",           label: "Profit & Loss (income statement + ratios)" },
    { value: "bs",           label: "Balance Sheet only" },
    { value: "gl",           label: "General Ledger only" },
  ];

  // Preset labels
  const PRESETS = [
    { value: "this_month",     label: "This month (calendar)" },
    { value: "last_month",     label: "Last month" },
    { value: "mtd",            label: "Month-to-date" },
    { value: "this_quarter",   label: "This quarter (QTD)" },
    { value: "last_quarter",   label: "Last quarter" },
    { value: "ytd",            label: "Year-to-date" },
    { value: "last_year_ytd",  label: "Last year YTD (same window)" },
    { value: "last_year_full", label: "Last full year" },
    { value: "trailing_12",    label: "Trailing 12 months" },
    { value: "custom",         label: "Custom range…" },
  ];

  const MONTHS = [
    { v: 1, l: "January" }, { v: 2, l: "February" }, { v: 3, l: "March" }, { v: 4, l: "April" },
    { v: 5, l: "May" }, { v: 6, l: "June" }, { v: 7, l: "July" }, { v: 8, l: "August" },
    { v: 9, l: "September" }, { v: 10, l: "October" }, { v: 11, l: "November" }, { v: 12, l: "December" },
  ];
  const YEARS = [curYear, curYear - 1, curYear - 2, curYear - 3, curYear - 4];

  // ─── Assemble pages by report type ───────────────────────
  const pages = [];
  let pageNum = 1;

  // Cover always
  pages.push(<CoverPage key="cover" agency={agency} periodLabel={p.label} generatedAt={generatedAt} />);
  pageNum = 2;

  if (reportType === "full_package" || reportType === "pl") {
    pages.push(
      <ExecSummaryPage key="exec" ytdCurrIS={ytdCurrIS} ytdPriorIS={ytdPriorIS} ratios={ratios} narrative={narrative} aipp={aipp} payrollYTD={payrollYTD} latestBS={latestBS} periodShort={p.short} />
    );
    pageNum++;
    pages.push(
      <IncomeStatementPage key="is-period" pageNumber={pageNum} title={`Income Statement · ${p.short}`} subtitle={`Selected period vs prior-year same period`} curr={currIS} prior={priorIS} currLabel={currLabel} priorLabel={`${p.fromYear - 1} same period`} />
    );
    pageNum++;
    if (p.compareMode === "prior_ytd" || reportType === "full_package") {
      pages.push(
        <IncomeStatementPage key="is-ytd" pageNumber={pageNum} title="Year-to-Date Income Statement" subtitle={`Through ${monthName(p.toMonth)} ${p.toYear} · vs prior-year YTD`} curr={ytdCurrIS} prior={ytdPriorIS} currLabel={`${p.toYear} YTD`} priorLabel={`${p.toYear - 1} YTD`} />
      );
      pageNum++;
    }
    if (reportType === "full_package") {
      pages.push(
        <CompRecapPage key="comp" compRows={compRows} currentYear={p.toYear} currentMonth={p.toMonth} periodMonthStart={p.fromMonth} periodMonthEnd={p.toMonth} periodShort={p.short} />
      );
      pageNum++;
    }
    pages.push(<RatiosPage key="ratios" ratios={ratios} />);
    pageNum++;
  }

  if (reportType === "full_package" || reportType === "bs") {
    pages.push(<BalanceSheetPage key="bs" bs={latestBS} />);
    pageNum++;
  }

  if (reportType === "full_package") {
    pages.push(
      <AIPPPage key="aipp" aipp={aipp} aippGoal={aippGoal} compRows={compRows} currentYear={p.currentYear} currentMonth={p.currentMonth} />
    );
    pageNum++;
    pages.push(
      <PayrollPage key="payroll" payrollRows={payrollRows} currentYear={p.currentYear} currentMonth={p.currentMonth} grossYTD={grossYTD} />
    );
    pageNum++;
  }

  if (reportType === "full_package" || reportType === "gl") {
    pages.push(
      <GeneralLedgerPages key="gl" glRows={glRows} glAccountTotals={glAccountTotals} periodLabel={p.label} startPageNumber={pageNum} />
    );
    // GL includes multiple pages; leave pageNum accounting best-effort
    pageNum += 1 + Math.max(1, Math.ceil((glRows || []).length / 32));
  }

  pages.push(<FootnotesPage key="footnotes" agency={agency} generatedAt={generatedAt} />);

  const selectStyle = { padding: "8px 10px", fontSize: 13, borderRadius: 6, border: `1px solid ${T.slate200}`, background: T.white, color: T.slate900, minWidth: 0 };
  const labelStyle  = { fontSize: 11, fontWeight: 600, color: T.slate700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, display: "block" };

  return (
    <div>
      {/* Print Styles */}
      <style>{`
        @media print {
          @page { size: letter; margin: 0; }
          body * { visibility: hidden; }
          #report-package-print-area, #report-package-print-area * { visibility: visible; }
          #report-package-print-area { position: absolute; left: 0; top: 0; width: 100%; }
          .no-print { display: none !important; }
          .report-page {
            page-break-after: always;
            break-after: page;
            width: 100%;
            min-height: 9.5in;
            padding: 0.6in 0.6in 0.4in 0.6in;
            box-sizing: border-box;
            background: white;
            margin-bottom: 0 !important;
            border: none !important;
            box-shadow: none !important;
          }
          .report-page:last-child { page-break-after: auto; break-after: auto; }
        }
      `}</style>

      {/* Controls (no-print) */}
      <div className="no-print" style={{
        marginBottom: 18, padding: 16,
        background: T.slate50, borderRadius: 10,
        border: `1px solid ${T.slate200}`,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.slate900, marginBottom: 12 }}>
          🖨 Print Package Builder
        </div>

        {/* Row 1: report type + preset */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>What to print</label>
            <select value={reportType} onChange={e => setReportType(e.target.value)} style={{ ...selectStyle, width: "100%" }}>
              {REPORT_TYPES.map(rt => <option key={rt.value} value={rt.value}>{rt.label}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Reporting period</label>
            <select value={preset} onChange={e => setPreset(e.target.value)} style={{ ...selectStyle, width: "100%" }}>
              {PRESETS.map(pr => <option key={pr.value} value={pr.value}>{pr.label}</option>)}
            </select>
          </div>
        </div>

        {/* Row 2: custom range (conditional) */}
        {preset === "custom" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 12, padding: 12, background: T.blueLt, borderRadius: 8, border: `1px solid ${T.blue}` }}>
            <div>
              <label style={labelStyle}>From month</label>
              <div style={{ display: "flex", gap: 6 }}>
                <select value={customFromMonth} onChange={e => setCustomFromMonth(Number(e.target.value))} style={{ ...selectStyle, flex: 1 }}>
                  {MONTHS.map(mo => <option key={mo.v} value={mo.v}>{mo.l}</option>)}
                </select>
                <select value={customFromYear} onChange={e => setCustomFromYear(Number(e.target.value))} style={selectStyle}>
                  {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label style={labelStyle}>To month (inclusive)</label>
              <div style={{ display: "flex", gap: 6 }}>
                <select value={customToMonth} onChange={e => setCustomToMonth(Number(e.target.value))} style={{ ...selectStyle, flex: 1 }}>
                  {MONTHS.map(mo => <option key={mo.v} value={mo.v}>{mo.l}</option>)}
                </select>
                <select value={customToYear} onChange={e => setCustomToYear(Number(e.target.value))} style={selectStyle}>
                  {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>
          </div>
        )}

        {/* Row 3: status + print */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, fontSize: 12, color: T.slate600 }}>
            <span style={{ color: T.slate900, fontWeight: 600 }}>Preview:</span> {p.label} · {REPORT_TYPES.find(r => r.value === reportType)?.label}
          </div>
          <button
            onClick={() => window.print()}
            style={{
              padding: "10px 22px", fontSize: 13, fontWeight: 600,
              color: T.textOnColor, background: T.navy,
              border: "none", borderRadius: 8, cursor: "pointer",
              boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
              whiteSpace: "nowrap",
            }}
          >
            🖨 Print to PDF
          </button>
        </div>
      </div>

      {/* Print Area */}
      <div id="report-package-print-area">
        {pages}
      </div>
    </div>
  );
}
