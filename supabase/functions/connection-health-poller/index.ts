// =========================================================================
// connection-health-poller
// Polls Composio /api/v3/connected_accounts and writes status to the
// connection_health table so the BCC Settings → Connections page can
// display real-time health instead of mock data.
//
// Auth: shared_secret in POST body (matches automation-runner pattern).
// =========================================================================
// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const COMPOSIO_BASE = "https://backend.composio.dev/api/v3";
const AGENCY_ID = "ed4b4f81-4ec1-4676-9dea-2a9c98e4a065";

// Display names + categorization for known toolkits
const TOOLKIT_META: Record<string, { name: string; category: string }> = {
  gmail:          { name: "Gmail",            category: "Google Workspace" },
  googledocs:     { name: "Google Docs",      category: "Google Workspace" },
  googledrive:    { name: "Google Drive",     category: "Google Workspace" },
  googlesheets:   { name: "Google Sheets",    category: "Google Workspace" },
  googlecalendar: { name: "Google Calendar",  category: "Google Workspace" },
  supabase:       { name: "Supabase",         category: "Infrastructure" },
  github:         { name: "GitHub",           category: "Infrastructure" },
  composio:       { name: "Composio",         category: "Infrastructure" },
  facebook:       { name: "Facebook",         category: "Social Media" },
  linkedin:       { name: "LinkedIn",         category: "Social Media" },
  instagram:      { name: "Instagram",        category: "Social Media" },
  slack:          { name: "Slack",            category: "Communication" },
};

// Status → visual color
function statusColor(status: string): string {
  const s = (status || "").toUpperCase();
  if (s === "ACTIVE") return "green";
  if (s === "EXPIRED" || s === "FAILED" || s === "INACTIVE") return "red";
  if (s === "INITIALIZING" || s === "INITIATED") return "amber";
  return "gray";
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function getSetting(key: string): Promise<string | null> {
  const { data, error } = await sb
    .from("settings").select("setting_value")
    .eq("agency_id", AGENCY_ID).eq("setting_key", key).maybeSingle();
  if (error) throw new Error(`settings read ${key}: ${error.message}`);
  return data?.setting_value ?? null;
}

async function run(): Promise<any> {
  const started = Date.now();
  const apiKey = await getSetting("composio_api_key");
  if (!apiKey) throw new Error("composio_api_key not configured");

  // Fetch up to 100 connected accounts
  const res = await fetch(`${COMPOSIO_BASE}/connected_accounts?limit=100`, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Composio API ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  const items: any[] = body?.items ?? [];

  // Snapshot current rows for diff (we'll soft-mark stale ones as gone)
  const seenAccountIds = new Set<string>();

  const upserts = items.map((c) => {
    const slug = c?.toolkit?.slug || "unknown";
    const meta = TOOLKIT_META[slug] || { name: slug, category: "Other" };
    const status = c?.status || "UNKNOWN";
    const accountId = c?.id || null;
    if (accountId) seenAccountIds.add(accountId);
    return {
      agency_id: AGENCY_ID,
      toolkit_slug: slug,
      display_name: meta.name,
      status,
      status_color: statusColor(status),
      connected_account_id: accountId,
      auth_config_id: c?.auth_config?.id || null,
      composio_user_id: c?.user_id || null,
      status_reason: c?.status_reason || null,
      word_id: c?.word_id || null,
      account_created_at: c?.created_at || null,
      account_updated_at: c?.updated_at || null,
      last_checked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  });

  // Upsert
  if (upserts.length > 0) {
    const { error: upErr } = await sb
      .from("connection_health")
      .upsert(upserts, { onConflict: "agency_id,connected_account_id" });
    if (upErr) throw new Error(`Upsert failed: ${upErr.message}`);
  }

  // Any rows in the table not seen in this poll → mark status='GONE'
  let removed = 0;
  if (seenAccountIds.size > 0) {
    const { data: existing } = await sb
      .from("connection_health")
      .select("id, connected_account_id, status")
      .eq("agency_id", AGENCY_ID);
    const toMarkGone = (existing || []).filter(
      (r) => r.connected_account_id && !seenAccountIds.has(r.connected_account_id) && r.status !== "GONE"
    );
    for (const r of toMarkGone) {
      await sb.from("connection_health")
        .update({ status: "GONE", status_color: "gray", last_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", r.id);
      removed++;
    }
  }

  const durationSec = Math.round((Date.now() - started) / 1000);

  // Count by status for summary
  const byStatus: Record<string, number> = {};
  for (const u of upserts) byStatus[u.status] = (byStatus[u.status] || 0) + 1;

  const summary = `Polled ${items.length} connections: ` +
    Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(", ") +
    (removed > 0 ? `; ${removed} marked GONE` : "");

  // Log to automation_run_log if there's a recipe row
  const { data: recipeRow } = await sb
    .from("automation_recipes").select("id")
    .eq("agency_id", AGENCY_ID).eq("recipe_name", "Connection Health Poller").maybeSingle();
  if (recipeRow?.id) {
    await sb.from("automation_run_log").insert({
      agency_id: AGENCY_ID,
      recipe_id: recipeRow.id,
      status: "success",
      records_processed: items.length,
      duration_seconds: durationSec,
      output_summary: summary,
    });
    await sb.from("automation_recipes")
      .update({ last_run_at: new Date().toISOString(), last_run_status: "success" })
      .eq("id", recipeRow.id);
  }

  return {
    ok: true,
    connections_polled: items.length,
    by_status: byStatus,
    marked_gone: removed,
    duration_seconds: durationSec,
    summary,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: any = {};
  if (req.method === "POST") {
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
  }

  // Custom auth: shared_secret in body must match settings.automation_runner_cron_secret
  try {
    const expectedSecret = await getSetting("automation_runner_cron_secret");
    if (!expectedSecret) return jsonResponse({ error: "Server missing cron secret" }, 500);
    if (body.shared_secret !== expectedSecret) {
      return jsonResponse({ error: "Unauthorized: missing or invalid shared_secret" }, 401);
    }
  } catch (err) {
    return jsonResponse({ error: `Auth check failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }

  try {
    const result = await run();
    return jsonResponse(result, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});
