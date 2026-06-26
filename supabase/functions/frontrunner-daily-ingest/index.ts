// =========================================================================
// frontrunner-daily-ingest
// Pulls FrontRunner Daily Agency Summary emails from Gmail (via Composio),
// parses producer activity deterministically, upserts to producer_activity_daily.
// Triggered daily by pg_cron at 14:30 UTC (10:30 ET, ~30 min after FrontRunner sends).
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

const AGENCY_ID = "ed4b4f81-4ec1-4676-9dea-2a9c98e4a065";

const PRODUCERS = [
  "Michelle Jackson", "Devin Walker", "Tim Mapp", "Patti Nottingham",
  "Catherine Harrison", "Jenna Silva", "Eva Serrano Tellado", "Carson Rich"
];

async function getSetting(key: string): Promise<string | null> {
  const { data } = await sb.from("settings").select("setting_value")
    .eq("agency_id", AGENCY_ID).eq("setting_key", key).maybeSingle();
  return data?.setting_value ?? null;
}

async function callComposio(opts: {
  apiKey: string; userId: string; connectedAccountId: string;
  toolSlug: string; toolArguments: Record<string, any>;
}): Promise<{ ok: boolean; data: any; error: string | null }> {
  const res = await fetch(`${COMPOSIO_BASE}/${opts.toolSlug}`, {
    method: "POST",
    headers: { "x-api-key": opts.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: opts.toolArguments,
    }),
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  const ok = res.ok && !!parsed?.successful;
  const data = parsed?.data ?? null;
  const error = ok ? null : (parsed?.error?.message || parsed?.error || text.slice(0, 400));
  return { ok, data, error };
}

function stripHtml(html: string): string[] {
  let h = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<\/p>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "");
  // Unescape common entities
  h = h.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  return h.split("\n").map((l: string) => l.replace(/[ \t]+/g, " ").trim()).filter((l: string) => l.length > 0);
}

function hoursToDecimal(h: string): number {
  if (!h || h === "0") return 0;
  const m = h.match(/(\d+)h(?:\s+(\d+)m)?/);
  if (m) return parseFloat(m[1]) + (parseFloat(m[2] || "0") / 60);
  return 0;
}

type ProducerStats = {
  hours: number; written: number; issued: number;
  outbound: number; auto_quotes: number; dev: number; fs_pivots: number;
  form_conv: number; google_reviews: number; walk_ins: number;
  inbound: number; onboarding: number;
};

function emptyStats(): ProducerStats {
  return { hours: 0, written: 0, issued: 0, outbound: 0, auto_quotes: 0,
    dev: 0, fs_pivots: 0, form_conv: 0, google_reviews: 0, walk_ins: 0,
    inbound: 0, onboarding: 0 };
}

function parseActivityBlock(lines: string[], start: number, end: number, out: Record<string, ProducerStats>): void {
  let i = start;
  while (i < end) {
    if (lines[i] === "Name" && i + 1 < end) {
      const header = lines[i + 1];
      let j = i + 2;
      while (j < end && lines[j] !== "Name") {
        if (PRODUCERS.includes(lines[j]) && j + 1 < end) {
          const p = lines[j];
          const numsLine = lines[j + 1];
          const nums = (numsLine.match(/\d+/g) || []).map((n: string) => parseInt(n, 10));
          const colPatterns: [string, keyof ProducerStats][] = [
            ["Outbound Calls", "outbound"],
            ["Auto Quotes", "auto_quotes"],
            ["Development", "dev"],
            ["Financial Services Pivots", "fs_pivots"],
            ["FORM Conversation", "form_conv"],
            ["Google Reviews", "google_reviews"],
            ["Walk-Ins", "walk_ins"],
            ["Inbound Calls", "inbound"],
            ["Onboarding Appts", "onboarding"]
          ];
          const appearances: [number, keyof ProducerStats][] = [];
          for (const [pat, key] of colPatterns) {
            const pos = header.indexOf(pat);
            if (pos !== -1) appearances.push([pos, key]);
          }
          appearances.sort((a, b) => a[0] - b[0]);
          if (!out[p]) out[p] = emptyStats();
          for (let k = 0; k < appearances.length && k < nums.length; k++) {
            (out[p][appearances[k][1]] as number) += nums[k];
          }
          j += 2;
        } else {
          j++;
        }
      }
      i = j;
    } else {
      i++;
    }
  }
}

function parseReport(text: string): { dataDate: string | null; stats: Record<string, ProducerStats> } {
  const lines = stripHtml(text);
  const stats: Record<string, ProducerStats> = {};
  for (const p of PRODUCERS) stats[p] = emptyStats();

  // Find data date
  let dataDate: string | null = null;
  const dateMatch = lines.join("\n").match(/Daily Agency Summary:\s*([A-Za-z]+ \d{1,2},\s*\d{4})/);
  if (dateMatch) {
    const parsed = new Date(dateMatch[1] + " UTC");
    if (!isNaN(parsed.getTime())) {
      dataDate = parsed.toISOString().split("T")[0];
    }
  }

  // Section indices
  const sectionStarts: Record<string, number> = {};
  const activityStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "Logged Hours") sectionStarts["hours"] = i;
    else if (lines[i] === "Written Sales") sectionStarts["written"] = i;
    else if (lines[i] === "Issued Sales") sectionStarts["issued"] = i;
    else if (lines[i].startsWith("Activity Logs for Daily Goals")) activityStarts.push(i);
  }

  const boundaries = [
    ...Object.values(sectionStarts),
    ...activityStarts,
    lines.length
  ].sort((a, b) => a - b);

  function sectionEnd(s: number): number {
    for (const b of boundaries) if (b > s) return b;
    return lines.length;
  }

  // Logged Hours
  if (sectionStarts["hours"] !== undefined) {
    const s = sectionStarts["hours"]; const e = sectionEnd(s);
    let i = s + 1;
    while (i < e) {
      if (PRODUCERS.includes(lines[i])) {
        const p = lines[i];
        if (i + 1 < e) {
          const hr = lines[i + 1];
          if (/^(\d+h(\s+\d+m)?|0)$/.test(hr) || hr === "0") {
            stats[p].hours = hoursToDecimal(hr);
          }
        }
      }
      i++;
    }
  }

  // Written Sales
  if (sectionStarts["written"] !== undefined) {
    const s = sectionStarts["written"]; const e = sectionEnd(s);
    let i = s + 1;
    while (i < e) {
      if (PRODUCERS.includes(lines[i]) && i + 1 < e && /^\d+$/.test(lines[i + 1])) {
        stats[lines[i]].written = parseInt(lines[i + 1], 10);
        i += 2;
      } else i++;
    }
  }

  // Issued Sales
  if (sectionStarts["issued"] !== undefined) {
    const s = sectionStarts["issued"]; const e = sectionEnd(s);
    let i = s + 1;
    while (i < e) {
      if (PRODUCERS.includes(lines[i]) && i + 1 < e && /^\d+$/.test(lines[i + 1])) {
        stats[lines[i]].issued = parseInt(lines[i + 1], 10);
        i += 2;
      } else i++;
    }
  }

  // Activity blocks
  for (const start of activityStarts) {
    parseActivityBlock(lines, start, sectionEnd(start), stats);
  }

  return { dataDate, stats };
}

async function logRun(status: string, recordsProcessed: number, errorMessage: string | null, summary: string, durationSec: number, recipeId: string | null) {
  const nowIso = new Date().toISOString();
  await sb.from("automation_run_log").insert({
    agency_id: AGENCY_ID,
    recipe_id: recipeId,
    status,
    records_processed: recordsProcessed,
    error_message: errorMessage,
    duration_seconds: durationSec,
    output_summary: summary
  });
  // Write back to the recipe row so the dashboard sees the latest run
  if (recipeId) {
    await sb.from("automation_recipes")
      .update({ last_run_at: nowIso, last_run_status: status, updated_at: nowIso })
      .eq("id", recipeId);
  }
}

Deno.serve(async (req: Request) => {
  const started = Date.now();
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });

  let body: any = {};
  try { const t = await req.text(); body = t ? JSON.parse(t) : {}; }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 }); }

  const expectedSecret = await getSetting("automation_runner_cron_secret");
  if (!expectedSecret || body.shared_secret !== expectedSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  // Find recipe id for logging
  const { data: recipe } = await sb.from("automation_recipes")
    .select("id").eq("agency_id", AGENCY_ID).eq("recipe_name", "FrontRunner Daily Ingest").maybeSingle();
  const recipeId = recipe?.id ?? null;

  try {
    const apiKey = await getSetting("composio_api_key");
    const userId = await getSetting("composio_user_id");
    const gmailAcct = await getSetting("composio_gmail_account_id");
    if (!apiKey || !userId || !gmailAcct) throw new Error("Missing Composio settings");

    // Step 1: fetch recent FrontRunner emails (last 7 days)
    const fetchRes = await callComposio({
      apiKey, userId, connectedAccountId: gmailAcct,
      toolSlug: "GMAIL_FETCH_EMAILS",
      toolArguments: {
        user_id: "me",
        max_results: 10,
        query: "from:support@imafrontrunner.com newer_than:7d",
        include_payload: false
      }
    });
    if (!fetchRes.ok) throw new Error(`Gmail fetch failed: ${fetchRes.error}`);
    const messages = (fetchRes.data?.response_data?.messages || fetchRes.data?.messages || []) as any[];
    if (messages.length === 0) {
      const duration = Math.round((Date.now() - started) / 1000);
      await logRun("success", 0, null, "No FrontRunner emails in last 7 days", duration, recipeId);
      return new Response(JSON.stringify({ ok: true, processed: 0, message: "No emails" }), { status: 200 });
    }

    // Step 2: check which message_ids we've already processed
    const allMids = messages.map((m: any) => m.messageId).filter(Boolean);
    const { data: existing } = await sb.from("producer_activity_daily")
      .select("source_message_id")
      .eq("agency_id", AGENCY_ID)
      .in("source_message_id", allMids);
    const processedSet = new Set((existing || []).map((r: any) => r.source_message_id));
    const toProcess = messages.filter((m: any) => !processedSet.has(m.messageId));

    if (toProcess.length === 0) {
      const duration = Math.round((Date.now() - started) / 1000);
      await logRun("success", 0, null, `${messages.length} FrontRunner emails found, all already processed`, duration, recipeId);
      return new Response(JSON.stringify({ ok: true, processed: 0, found: messages.length, message: "All already processed" }), { status: 200 });
    }

    // Step 3: fetch + parse + upsert each
    let totalRows = 0;
    const perEmail: any[] = [];
    for (const m of toProcess) {
      const fullRes = await callComposio({
        apiKey, userId, connectedAccountId: gmailAcct,
        toolSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
        toolArguments: { user_id: "me", message_id: m.messageId, format: "full" }
      });
      if (!fullRes.ok) {
        perEmail.push({ mid: m.messageId, error: fullRes.error });
        continue;
      }
      const payload = fullRes.data?.response_data ?? fullRes.data;
      const html = payload?.messageText || payload?.preview?.body || "";
      const { dataDate, stats } = parseReport(html);
      if (!dataDate) {
        perEmail.push({ mid: m.messageId, error: "Could not detect data_date" });
        continue;
      }
      // Build upsert rows
      const rows = PRODUCERS.map((p: string) => ({
        agency_id: AGENCY_ID,
        producer_name: p,
        activity_date: dataDate,
        hours: Math.round(stats[p].hours * 100) / 100,
        written_sales: stats[p].written,
        issued_sales: stats[p].issued,
        outbound_calls: stats[p].outbound,
        auto_quotes: stats[p].auto_quotes,
        development: stats[p].dev,
        fs_pivots: stats[p].fs_pivots,
        form_conversations: stats[p].form_conv,
        google_reviews: stats[p].google_reviews,
        walk_ins: stats[p].walk_ins,
        inbound_calls: stats[p].inbound,
        onboarding_appts: stats[p].onboarding,
        source: "frontrunner_daily_summary",
        source_message_id: m.messageId,
        updated_at: new Date().toISOString()
      }));
      const { error: upErr } = await sb.from("producer_activity_daily")
        .upsert(rows, { onConflict: "agency_id,producer_name,activity_date", ignoreDuplicates: false });
      if (upErr) {
        perEmail.push({ mid: m.messageId, error: upErr.message });
      } else {
        totalRows += rows.length;
        perEmail.push({ mid: m.messageId, data_date: dataDate, rows: rows.length });
      }
    }

    const duration = Math.round((Date.now() - started) / 1000);
    const summary = `Processed ${perEmail.filter((e: any) => !e.error).length}/${toProcess.length} FrontRunner emails, ${totalRows} producer-day rows upserted`;
    await logRun("success", totalRows, null, summary, duration, recipeId);
    return new Response(JSON.stringify({ ok: true, processed: totalRows, details: perEmail }), { status: 200 });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const duration = Math.round((Date.now() - started) / 1000);
    await logRun("failed", 0, msg, `Failed: ${msg.slice(0, 200)}`, duration, recipeId);
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500 });
  }
});
