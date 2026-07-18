// =========================================================================
// qbo-mirror-refresh  (BCC QBO Mirror Refresh)
// =========================================================================
// PURPOSE: Refreshes the qbo_* mirror tables from Composio QuickBooks tools.
//   Replaces manual proxy_execute workflows. Designed to ship before the
//   2026-07-01 GL cutover so dual-write reconciliation works:
//     - Pre-cutover: BCC GL empty, QBO mirror = source of truth for P&L/BS.
//     - Post-cutover: BCC GL takes new transactions; mirror keeps refreshing
//       in parallel. A separate reconciliation script compares the two.
//
// WHAT IT DOES (per invocation):
//   1. Reads composio_api_key / composio_user_id / composio_qbo_account_id
//      from settings table.
//   2. Refreshes qbo_accounts via QUICKBOOKS_QUERY_ACCOUNT
//      (upsert on (agency_id, qbo_id)).
//   3. Refreshes qbo_snapshots for current fiscal YTD, monthly granularity:
//        - profit_loss via QUICKBOOKS_GET_PROFIT_AND_LOSS_REPORT
//        - balance_sheet via QUICKBOOKS_GET_BALANCE_SHEET_REPORT
//      Both pulled cash basis to match existing snapshots
//      (source='qbo_composio', summarize_by='Month'). Delete-then-insert per
//      period because qbo_snapshots has no natural unique key.
//   4. Logs a row to automation_run_log.
//
// WHAT IT DOES NOT DO (yet):
//   - GL journal lines refresh. The historical load (3815 lines through
//     May 2026) already covers the dual-write reconciliation window.
//     v2 will add monthly GL incremental once the agent validates v1 output.
//   - Multi-agency. Single agency (Sunshine State Insurance) for now;
//     trivial to generalize when needed.
//
// INVOCATION:
//   POST /functions/v1/qbo-mirror-refresh
//   Body (optional): { "agency_id": "uuid", "log": true }
//   If agency_id omitted, defaults to Sunshine State Insurance.
//
// AUTH: verify_jwt=false (called by pg_cron + manual ops). Service role key
//   is used internally to write to Supabase.
//
// =========================================================================

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const COMPOSIO_BASE = "https://backend.composio.dev/api/v3/tools/execute";
const DEFAULT_AGENCY_ID = "[AGENCY_UUID]";

// ------------------------- helpers -------------------------

async function getSetting(agencyId: string, key: string): Promise<string | null> {
  const { data, error } = await sb.from("settings").select("setting_value")
    .eq("agency_id", agencyId).eq("setting_key", key).maybeSingle();
  if (error) throw new Error(`settings read failed (${key}): ${error.message}`);
  if (!data?.setting_value) return null;
  // Some settings are JSON-stringified (e.g. gl_cutover_date = "2026-07-01").
  // Strip wrapping double-quotes if present.
  let v = data.setting_value as string;
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1);
  }
  return v;
}

interface ComposioContext {
  apiKey: string;
  userId: string;
  qboAccountId: string;
}

async function loadComposioContext(agencyId: string): Promise<ComposioContext> {
  const apiKey = await getSetting(agencyId, "composio_api_key");
  const userId = await getSetting(agencyId, "composio_user_id");
  const qboAccountId = await getSetting(agencyId, "composio_qbo_account_id");
  if (!apiKey) throw new Error("settings.composio_api_key missing");
  if (!userId) throw new Error("settings.composio_user_id missing");
  if (!qboAccountId) throw new Error("settings.composio_qbo_account_id missing");
  return { apiKey, userId, qboAccountId };
}

async function callComposio(
  ctx: ComposioContext,
  toolSlug: string,
  args: Record<string, any>,
): Promise<any> {
  const url = `${COMPOSIO_BASE}/${toolSlug}`;
  const body = {
    user_id: ctx.userId,
    connected_account_id: ctx.qboAccountId,
    arguments: args,
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": ctx.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`composio ${toolSlug} HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`composio ${toolSlug} returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (parsed?.error) {
    const errStr = typeof parsed.error === "string"
      ? parsed.error
      : JSON.stringify(parsed.error).slice(0, 500);
    throw new Error(`composio ${toolSlug} error: ${errStr}`);
  }
  if (parsed?.successful === false) {
    throw new Error(`composio ${toolSlug} not successful: ${JSON.stringify(parsed).slice(0, 500)}`);
  }
  return parsed?.data ?? parsed;
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ------------------------- qbo report parsers -------------------------

interface ParsedPeriod {
  start: string; // YYYY-MM-DD
  end: string;
  label: string;
}

// Parse QBO report Columns.Column to extract month period boundaries.
// Skips the leading label column and any trailing Total column.
function extractPeriods(columns: any[]): ParsedPeriod[] {
  const periods: ParsedPeriod[] = [];
  for (let i = 1; i < columns.length; i++) {
    const c = columns[i] ?? {};
    const meta = c.MetaData ?? [];
    let start: string | null = null;
    let end: string | null = null;
    for (const m of meta) {
      if (m?.Name === "StartDate") start = m.Value;
      if (m?.Name === "EndDate") end = m.Value;
    }
    const title = String(c.ColTitle ?? "");
    // Skip Total / YTD columns (no MetaData on them).
    if (!start || !end) continue;
    periods.push({ start, end, label: title });
  }
  return periods;
}

// Walk a QBO report's Rows.Row tree, collecting Section name -> Summary ColData[].
// Returns a flat map keyed by lowercased section header.
function collectSectionSummaries(rows: any[]): Map<string, any[]> {
  const out = new Map<string, any[]>();
  function walk(rs: any[]) {
    for (const r of rs ?? []) {
      if (r?.type === "Section") {
        const headerLabel = r?.Header?.ColData?.[0]?.value ?? r?.group ?? "";
        const summary = r?.Summary?.ColData ?? [];
        if (headerLabel) {
          out.set(String(headerLabel).toLowerCase(), summary);
        }
        // Also expose by group name (NetIncome, GrossProfit, NetOperatingIncome, etc).
        if (r?.group) {
          out.set(String(r.group).toLowerCase(), summary);
        }
        walk(r?.Rows?.Row ?? []);
      }
    }
  }
  walk(rows);
  return out;
}

// Extract a single numeric value at the given period column index (1-based, position
// in the original Columns array). Returns null if missing.
function valAt(colData: any[], colIdx: number): number | null {
  const cell = colData?.[colIdx];
  if (!cell) return null;
  return num(cell?.value);
}

interface PLPeriod {
  start: string;
  end: string;
  total_income: number | null;
  cost_of_goods_sold: number | null;
  gross_profit: number | null;
  total_expenses: number | null;
  net_operating_income: number | null;
  net_income: number | null;
}

function parsePLReport(report: any): { periods: PLPeriod[]; raw: any } {
  const columns = report?.Columns?.Column ?? [];
  const rows = report?.Rows?.Row ?? [];
  const periods = extractPeriods(columns);
  const sections = collectSectionSummaries(rows);

  const incomeSum = sections.get("income") ?? sections.get("total income");
  const cogsSum = sections.get("cogs") ?? sections.get("cost of goods sold") ??
    sections.get("total cost of goods sold");
  const grossProfit = sections.get("grossprofit") ?? sections.get("gross profit");
  const expensesSum = sections.get("expenses") ?? sections.get("total expenses");
  const noi = sections.get("netoperatingincome") ?? sections.get("net operating income");
  const netIncome = sections.get("netincome") ?? sections.get("net income");

  const result: PLPeriod[] = periods.map((p, i) => {
    const colIdx = i + 1;
    return {
      start: p.start,
      end: p.end,
      total_income: incomeSum ? valAt(incomeSum, colIdx) : null,
      cost_of_goods_sold: cogsSum ? valAt(cogsSum, colIdx) : null,
      gross_profit: grossProfit ? valAt(grossProfit, colIdx) : null,
      total_expenses: expensesSum ? valAt(expensesSum, colIdx) : null,
      net_operating_income: noi ? valAt(noi, colIdx) : null,
      net_income: netIncome ? valAt(netIncome, colIdx) : null,
    };
  });

  return { periods: result, raw: report };
}

interface BSPeriod {
  end: string;
  total_assets: number | null;
  current_assets: number | null;
  total_liabilities: number | null;
  current_liabilities: number | null;
  total_equity: number | null;
}

function parseBSReport(report: any): { periods: BSPeriod[]; raw: any } {
  const columns = report?.Columns?.Column ?? [];
  const rows = report?.Rows?.Row ?? [];
  const periods = extractPeriods(columns);
  const sections = collectSectionSummaries(rows);

  const totalAssets = sections.get("totalassets") ?? sections.get("total assets") ??
    sections.get("assets");
  const currentAssets = sections.get("currentassets") ?? sections.get("current assets") ??
    sections.get("total current assets");
  const totalLiabilities = sections.get("totalliabilities") ?? sections.get("total liabilities") ??
    sections.get("liabilities");
  const currentLiabilities = sections.get("currentliabilities") ??
    sections.get("current liabilities") ?? sections.get("total current liabilities");
  const totalEquity = sections.get("totalequity") ?? sections.get("total equity") ??
    sections.get("equity");

  const result: BSPeriod[] = periods.map((p, i) => {
    const colIdx = i + 1;
    return {
      end: p.end,
      total_assets: totalAssets ? valAt(totalAssets, colIdx) : null,
      current_assets: currentAssets ? valAt(currentAssets, colIdx) : null,
      total_liabilities: totalLiabilities ? valAt(totalLiabilities, colIdx) : null,
      current_liabilities: currentLiabilities ? valAt(currentLiabilities, colIdx) : null,
      total_equity: totalEquity ? valAt(totalEquity, colIdx) : null,
    };
  });

  return { periods: result, raw: report };
}

// ------------------------- refresh steps -------------------------

interface RefreshSummary {
  accounts_upserted: number;
  pl_periods: number;
  bs_periods: number;
  pl_dates: string[];
  bs_dates: string[];
  errors: string[];
}

async function refreshAccounts(
  agencyId: string,
  ctx: ComposioContext,
  summary: RefreshSummary,
): Promise<void> {
  try {
    const resp = await callComposio(ctx, "QUICKBOOKS_QUERY_ACCOUNT", {
      query: "SELECT * FROM Account MAXRESULTS 1000",
    });
    const qr = resp?.QueryResponse ?? resp?.response?.QueryResponse ?? resp?.response?.data?.QueryResponse;
    const accounts: any[] = qr?.Account ?? [];
    if (!accounts.length) {
      summary.errors.push(`accounts: no Account[] in response (keys=${JSON.stringify(Object.keys(resp ?? {})).slice(0, 200)})`);
      return;
    }

    const now = new Date().toISOString();
    const rows = accounts.map((a) => ({
      agency_id: agencyId,
      qbo_id: String(a.Id),
      account_name: a.Name ?? null,
      fully_qualified_name: a.FullyQualifiedName ?? null,
      account_type: a.AccountType ?? null,
      account_subtype: a.AccountSubType ?? null,
      classification: a.Classification ?? null,
      current_balance: num(a.CurrentBalance),
      active: a.Active ?? null,
      acct_num: a.AcctNum ?? null,
      description: a.Description ?? null,
      is_subaccount: a.SubAccount ?? null,
      parent_qbo_id: a.ParentRef?.value ?? null,
      raw: a,
      pulled_at: now,
      updated_at: now,
    }));

    const { error } = await sb.from("qbo_accounts").upsert(rows, {
      onConflict: "agency_id,qbo_id",
    });
    if (error) {
      summary.errors.push(`accounts upsert: ${error.message}`);
      return;
    }
    summary.accounts_upserted = rows.length;
  } catch (e) {
    summary.errors.push(`accounts: ${(e as Error).message}`);
  }
}

async function refreshPL(
  agencyId: string,
  ctx: ComposioContext,
  summary: RefreshSummary,
): Promise<void> {
  try {
    const resp = await callComposio(ctx, "QUICKBOOKS_GET_PROFIT_AND_LOSS_REPORT", {
      date_macro: "This Fiscal Year-to-date",
      summarize_column_by: "Month",
      accounting_method: "Cash",
    });
    const report = resp?.Header ? resp : (resp?.response?.data ?? resp?.response ?? resp);
    const { periods, raw } = parsePLReport(report);
    summary.pl_periods = periods.length;

    if (!periods.length) {
      summary.errors.push("pl: no periods parsed from report");
      return;
    }

    const ends = periods.map((p) => p.end);
    summary.pl_dates = ends;
    const { error: delErr } = await sb.from("qbo_snapshots").delete()
      .eq("agency_id", agencyId)
      .eq("report_type", "profit_loss")
      .eq("accounting_method", "cash")
      .eq("summarize_by", "Month")
      .in("period_end", ends);
    if (delErr) {
      summary.errors.push(`pl delete: ${delErr.message}`);
      return;
    }

    const now = new Date().toISOString();
    const insertRows = periods.map((p) => ({
      agency_id: agencyId,
      report_type: "profit_loss",
      period_start: p.start,
      period_end: p.end,
      accounting_method: "cash",
      summarize_by: "Month",
      total_income: p.total_income,
      cost_of_goods_sold: p.cost_of_goods_sold,
      gross_profit: p.gross_profit,
      total_expenses: p.total_expenses,
      net_operating_income: p.net_operating_income,
      net_income: p.net_income,
      source: "qbo_composio",
      raw_response: raw,
      created_at: now,
      updated_at: now,
    }));
    const { error: insErr } = await sb.from("qbo_snapshots").insert(insertRows);
    if (insErr) {
      summary.errors.push(`pl insert: ${insErr.message}`);
    }
  } catch (e) {
    summary.errors.push(`pl: ${(e as Error).message}`);
  }
}

async function refreshBS(
  agencyId: string,
  ctx: ComposioContext,
  summary: RefreshSummary,
): Promise<void> {
  try {
    const resp = await callComposio(ctx, "QUICKBOOKS_GET_BALANCE_SHEET_REPORT", {
      date_macro: "This Fiscal Year-to-date",
      summarize_column_by: "Month",
      accounting_method: "Cash",
    });
    const report = resp?.Header ? resp : (resp?.response?.data ?? resp?.response ?? resp);
    const { periods, raw } = parseBSReport(report);
    summary.bs_periods = periods.length;

    if (!periods.length) {
      summary.errors.push("bs: no periods parsed from report");
      return;
    }

    const ends = periods.map((p) => p.end);
    summary.bs_dates = ends;
    const { error: delErr } = await sb.from("qbo_snapshots").delete()
      .eq("agency_id", agencyId)
      .eq("report_type", "balance_sheet")
      .eq("accounting_method", "cash")
      .eq("summarize_by", "Month")
      .in("period_end", ends);
    if (delErr) {
      summary.errors.push(`bs delete: ${delErr.message}`);
      return;
    }

    const now = new Date().toISOString();
    const insertRows = periods.map((p) => {
      const totalAssets = p.total_assets;
      const currentLiab = p.current_liabilities;
      const currentAssets = p.current_assets;
      const workingCapital = (currentAssets !== null && currentLiab !== null)
        ? currentAssets - currentLiab
        : null;
      return {
        agency_id: agencyId,
        report_type: "balance_sheet",
        period_start: null,
        period_end: p.end,
        accounting_method: "cash",
        summarize_by: "Month",
        total_assets: totalAssets,
        current_assets: currentAssets,
        total_liabilities: p.total_liabilities,
        current_liabilities: currentLiab,
        total_equity: p.total_equity,
        working_capital: workingCapital,
        source: "qbo_composio",
        raw_response: raw,
        created_at: now,
        updated_at: now,
      };
    });
    const { error: insErr } = await sb.from("qbo_snapshots").insert(insertRows);
    if (insErr) {
      summary.errors.push(`bs insert: ${insErr.message}`);
    }
  } catch (e) {
    summary.errors.push(`bs: ${(e as Error).message}`);
  }
}

async function logRun(
  agencyId: string,
  status: "success" | "failed",
  summary: RefreshSummary,
  durationMs: number,
): Promise<void> {
  try {
    await sb.from("automation_run_log").insert({
      agency_id: agencyId,
      recipe_id: null,
      status,
      run_at: new Date().toISOString(),
      records_processed: summary.accounts_upserted + summary.pl_periods + summary.bs_periods,
      duration_seconds: Math.round(durationMs / 1000),
      output_summary: JSON.stringify({
        task: "qbo_mirror_refresh",
        accounts_upserted: summary.accounts_upserted,
        pl_periods: summary.pl_periods,
        pl_dates: summary.pl_dates,
        bs_periods: summary.bs_periods,
        bs_dates: summary.bs_dates,
        errors: summary.errors,
        duration_ms: durationMs,
      }),
      error_message: summary.errors.length ? summary.errors.join("; ") : null,
    });
  } catch (_e) { /* best effort */ }
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  let agencyId = DEFAULT_AGENCY_ID;
  let shouldLog = true;

  try {
    if (req.method === "POST") {
      const ct = req.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        try {
          const body = await req.json();
          if (body?.agency_id) agencyId = body.agency_id;
          if (body?.log === false) shouldLog = false;
        } catch { /* no body, fine */ }
      }
    }

    const ctx = await loadComposioContext(agencyId);

    const summary: RefreshSummary = {
      accounts_upserted: 0,
      pl_periods: 0,
      bs_periods: 0,
      pl_dates: [],
      bs_dates: [],
      errors: [],
    };

    await refreshAccounts(agencyId, ctx, summary);
    await refreshPL(agencyId, ctx, summary);
    await refreshBS(agencyId, ctx, summary);

    const durationMs = Date.now() - t0;
    const status: "success" | "failed" = summary.errors.length ? "failed" : "success";

    if (shouldLog) await logRun(agencyId, status, summary, durationMs);

    return new Response(
      JSON.stringify({
        ok: status === "success",
        agency_id: agencyId,
        duration_ms: durationMs,
        accounts_upserted: summary.accounts_upserted,
        pl_periods: summary.pl_periods,
        pl_dates: summary.pl_dates,
        bs_periods: summary.bs_periods,
        bs_dates: summary.bs_dates,
        errors: summary.errors,
      }),
      {
        status: status === "success" ? 200 : 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    const durationMs = Date.now() - t0;
    const msg = (e as Error).message ?? String(e);
    if (shouldLog) {
      try {
        await sb.from("automation_run_log").insert({
          agency_id: agencyId,
          recipe_id: null,
          status: "failed",
          run_at: new Date().toISOString(),
          records_processed: 0,
          duration_seconds: Math.round(durationMs / 1000),
          output_summary: JSON.stringify({ task: "qbo_mirror_refresh" }),
          error_message: msg.slice(0, 2000),
        });
      } catch { /* best effort */ }
    }
    return new Response(
      JSON.stringify({ ok: false, agency_id: agencyId, duration_ms: durationMs, error: msg }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
