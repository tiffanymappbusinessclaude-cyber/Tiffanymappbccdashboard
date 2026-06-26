// =========================================================================
// mail-labeler
// Finds documents that have been processed but whose source Gmail message
// has not yet been tagged with the BCC/Processed label, then applies the
// label via Composio and marks the docs as labeled.
//
// Idempotent: safe to call repeatedly; only acts on docs where
// gmail_label_applied_at IS NULL.
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

const COMPOSIO_BASE = "https://backend.composio.dev/api/v3/tools/execute";
const LABEL_TOOL = "GMAIL_ADD_LABEL_TO_EMAIL";
const AGENCY_ID = "ed4b4f81-4ec1-4676-9dea-2a9c98e4a065";
const RECIPE_NAME = "Mail Labeler";

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function getSetting(agencyId: string, key: string): Promise<string | null> {
  const { data, error } = await sb
    .from("settings").select("setting_value")
    .eq("agency_id", agencyId).eq("setting_key", key).maybeSingle();
  if (error) throw new Error(`settings read ${key}: ${error.message}`);
  return data?.setting_value ?? null;
}

async function getRecipeId(agencyId: string, name: string): Promise<string | null> {
  const { data } = await sb.from("automation_recipes").select("id")
    .eq("agency_id", agencyId).eq("recipe_name", name).maybeSingle();
  return data?.id ?? null;
}

async function applyGmailLabel(opts: {
  apiKey: string; userId: string; accountId: string;
  messageId: string; labelId: string;
}): Promise<{ ok: boolean; error: string | null }> {
  const res = await fetch(`${COMPOSIO_BASE}/${LABEL_TOOL}`, {
    method: "POST",
    headers: { "x-api-key": opts.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.accountId,
      arguments: {
        user_id: "me",
        message_id: opts.messageId,
        add_label_ids: [opts.labelId],
      },
    }),
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  const ok = res.ok && !!parsed?.successful;
  const error = ok ? null : (parsed?.error?.message || parsed?.error || text.slice(0, 300));
  return { ok, error };
}

async function run(): Promise<any> {
  const started = Date.now();

  const labelId = await getSetting(AGENCY_ID, "gmail_processed_label_id");
  const apiKey = await getSetting(AGENCY_ID, "composio_api_key");
  const userId = await getSetting(AGENCY_ID, "composio_user_id");
  const accountId = await getSetting(AGENCY_ID, "composio_gmail_account_id");

  if (!labelId || !apiKey || !userId || !accountId) {
    throw new Error("Missing required settings: gmail_processed_label_id, composio_api_key, composio_user_id, or composio_gmail_account_id");
  }

  const { data: pending, error: qErr } = await sb
    .from("documents")
    .select("id, source_message_id")
    .eq("agency_id", AGENCY_ID)
    .eq("processing_status", "processed")
    .is("gmail_label_applied_at", null)
    .not("source_message_id", "is", null)
    .limit(500);
  if (qErr) throw new Error(`Query pending docs failed: ${qErr.message}`);

  const pendingDocs = pending ?? [];
  const byMessage = new Map<string, string[]>();
  for (const d of pendingDocs) {
    const mid = d.source_message_id as string;
    if (!byMessage.has(mid)) byMessage.set(mid, []);
    byMessage.get(mid)!.push(d.id as string);
  }

  let labeledMessages = 0;
  let labeledDocs = 0;
  let failedMessages = 0;
  const errors: Array<{ message_id: string; error: string }> = [];
  const successMessageIds: string[] = [];

  for (const [messageId, docIds] of byMessage) {
    const r = await applyGmailLabel({ apiKey, userId, accountId, messageId, labelId });
    if (r.ok) {
      labeledMessages++;
      labeledDocs += docIds.length;
      successMessageIds.push(messageId);
      const { error: uErr } = await sb
        .from("documents")
        .update({ gmail_label_applied_at: new Date().toISOString() })
        .in("id", docIds);
      if (uErr) {
        errors.push({ message_id: messageId, error: `Label applied but DB update failed: ${uErr.message}` });
      }
    } else {
      failedMessages++;
      errors.push({ message_id: messageId, error: r.error || "unknown" });
    }
  }

  const durationSec = Math.round((Date.now() - started) / 1000);
  const summary = byMessage.size === 0
    ? "No pending documents to label"
    : `Labeled ${labeledMessages} source email(s) covering ${labeledDocs} doc(s); ${failedMessages} failed`;

  const recipeId = await getRecipeId(AGENCY_ID, RECIPE_NAME);
  if (recipeId) {
    const status = failedMessages === 0 ? "success" : (labeledMessages === 0 ? "failed" : "success");
    await sb.from("automation_run_log").insert({
      agency_id: AGENCY_ID,
      recipe_id: recipeId,
      status,
      records_processed: labeledDocs,
      error_message: errors.length ? JSON.stringify(errors).slice(0, 800) : null,
      duration_seconds: durationSec,
      output_summary: summary,
    });
    await sb.from("automation_recipes")
      .update({ last_run_at: new Date().toISOString(), last_run_status: status })
      .eq("id", recipeId);
  }

  return {
    ok: true,
    labeled_messages: labeledMessages,
    labeled_docs: labeledDocs,
    failed_messages: failedMessages,
    duration_seconds: durationSec,
    success_message_ids: successMessageIds,
    errors,
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
    const expectedSecret = await getSetting(AGENCY_ID, "automation_runner_cron_secret");
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
