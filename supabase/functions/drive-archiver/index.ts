// =========================================================================
// drive-archiver
// Finds documents that arrived via Gmail (source_message_id + source_attachment_id
// populated) but are not yet filed in Drive (drive_file_id IS NULL). Fetches the
// attachment from Gmail via Composio (server-side s3url), uploads to the correct
// Drive folder based on document_type + period_year, updates the documents row.
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
const AGENCY_ID = "ed4b4f81-4ec1-4676-9dea-2a9c98e4a065";
const RECIPE_NAME = "Drive Archiver";

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

async function composioExec(
  toolSlug: string, apiKey: string, userId: string,
  accountId: string, args: Record<string, any>,
): Promise<{ ok: boolean; data: any; error: string | null }> {
  const res = await fetch(`${COMPOSIO_BASE}/${toolSlug}`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      connected_account_id: accountId,
      arguments: args,
    }),
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  const ok = res.ok && !!parsed?.successful;
  const error = ok ? null : (parsed?.error?.message || parsed?.error || text.slice(0, 300));
  return { ok, data: parsed?.data ?? null, error };
}

// Map (document_type, period_year) → settings key for destination folder
async function resolveDestFolder(docType: string | null, periodYear: number | null): Promise<string | null> {
  const year = periodYear ?? new Date().getUTCFullYear();
  const yearStr = String(year);

  // Returns settings key based on doc type; year-partitioned where applicable
  const candidates: string[] = (() => {
    switch ((docType || "").toLowerCase()) {
      case "comp_recap":
        return [`drive_sf_comp_${yearStr}_folder_id`, "drive_sf_comp_folder_id"];
      case "deduction_statement":
      case "control_d":
        return [`drive_deductions_${yearStr}_folder_id`, "drive_deductions_folder_id"];
      case "payroll_run":
      case "adp_payroll":
        return [`drive_payroll_${yearStr}_folder_id`, "drive_payroll_folder_id"];
      case "bank_statement":
        return [`drive_bank_${yearStr}_folder_id`, "drive_bank_folder_id"];
      case "credit_card_statement":
      case "cc_statement":
        return [`drive_cc_${yearStr}_folder_id`, "drive_cc_folder_id"];
      case "cpa_pnl":
      case "cpa_balance_sheet":
      case "cpa_general_ledger":
      case "cpa_financials":
        return [`drive_gl_${yearStr}_folder_id`, "drive_gl_folder_id"];
      case "loan_statement":
        return [`drive_bank_${yearStr}_folder_id`, "drive_bank_folder_id", "drive_misc_folder_id"];
      case "compliance":
        return ["drive_compliance_folder_id", "drive_misc_folder_id"];
      case "hr":
        return ["drive_hr_folder_id", "drive_misc_folder_id"];
      case "social":
        return ["drive_social_folder_id", "drive_misc_folder_id"];
      case "report":
        return ["drive_reports_folder_id", "drive_misc_folder_id"];
      default:
        return ["drive_misc_folder_id"];
    }
  })();

  for (const key of candidates) {
    const id = await getSetting(AGENCY_ID, key);
    if (id) return id;
  }
  return null;
}

function buildFilename(doc: any): string {
  if (doc.source_filename) return doc.source_filename;
  if (doc.file_name) return doc.file_name;
  const parts: string[] = [];
  if (doc.document_type) parts.push(doc.document_type);
  if (doc.period_year && doc.period_month) {
    parts.push(`${doc.period_year}-${String(doc.period_month).padStart(2, "0")}`);
  } else if (doc.period_year) {
    parts.push(String(doc.period_year));
  }
  if (doc.period_half) parts.push(doc.period_half);
  const base = parts.length ? parts.join("_") : `doc_${doc.id}`;
  const ext = (doc.file_type || "pdf").toLowerCase().replace(/^\./, "");
  return `${base}.${ext}`;
}

async function run(): Promise<any> {
  const started = Date.now();

  const apiKey = await getSetting(AGENCY_ID, "composio_api_key");
  const userId = await getSetting(AGENCY_ID, "composio_user_id");
  const gmailAccount = await getSetting(AGENCY_ID, "composio_gmail_account_id");
  const driveAccount = await getSetting(AGENCY_ID, "composio_googledrive_account_id");

  if (!apiKey || !userId || !gmailAccount || !driveAccount) {
    throw new Error("Missing required settings: composio_api_key, composio_user_id, composio_gmail_account_id, or composio_googledrive_account_id");
  }

  const { data: pending, error: qErr } = await sb
    .from("documents")
    .select("id, file_name, file_type, source_message_id, source_attachment_id, source_filename, document_type, period_year, period_month, period_half")
    .eq("agency_id", AGENCY_ID)
    .is("drive_file_id", null)
    .not("source_message_id", "is", null)
    .not("source_attachment_id", "is", null)
    .limit(100);
  if (qErr) throw new Error(`Query pending docs failed: ${qErr.message}`);

  const pendingDocs = pending ?? [];
  let archived = 0;
  let failed = 0;
  const errors: Array<{ doc_id: string; stage: string; error: string }> = [];
  const archivedIds: string[] = [];

  for (const doc of pendingDocs) {
    const filename = buildFilename(doc);

    // Step 1: get Gmail attachment s3url
    const attRes = await composioExec("GMAIL_GET_ATTACHMENT", apiKey, userId, gmailAccount, {
      user_id: "me",
      message_id: doc.source_message_id,
      attachment_id: doc.source_attachment_id,
      file_name: filename,
    });
    if (!attRes.ok) {
      failed++;
      errors.push({ doc_id: doc.id, stage: "gmail_get_attachment", error: attRes.error || "unknown" });
      continue;
    }
    const s3url: string | null = attRes.data?.file?.s3url ?? attRes.data?.s3url ?? null;
    const mimeType: string = attRes.data?.file?.mimetype ?? attRes.data?.mimetype ?? "application/octet-stream";
    if (!s3url) {
      failed++;
      errors.push({ doc_id: doc.id, stage: "gmail_get_attachment", error: "No s3url in attachment response" });
      continue;
    }

    // Step 2: resolve destination folder
    const folderId = await resolveDestFolder(doc.document_type, doc.period_year);
    if (!folderId) {
      failed++;
      errors.push({ doc_id: doc.id, stage: "resolve_folder", error: `No folder for document_type=${doc.document_type}` });
      continue;
    }

    // Step 3: upload to Drive
    const upRes = await composioExec("GOOGLEDRIVE_UPLOAD_FROM_URL", apiKey, userId, driveAccount, {
      source_url: s3url,
      name: filename,
      mime_type: mimeType,
      parent_folder_id: folderId,
    });
    if (!upRes.ok) {
      failed++;
      errors.push({ doc_id: doc.id, stage: "drive_upload", error: upRes.error || "unknown" });
      continue;
    }
    const driveFileId: string | null = upRes.data?.id ?? upRes.data?.file?.id ?? null;
    const driveUrl: string | null = upRes.data?.webViewLink ?? upRes.data?.file?.webViewLink ?? null;
    if (!driveFileId) {
      failed++;
      errors.push({ doc_id: doc.id, stage: "drive_upload", error: "Upload succeeded but no file id returned" });
      continue;
    }

    // Step 4: update document row
    const { error: uErr } = await sb.from("documents")
      .update({
        drive_file_id: driveFileId,
        drive_url: driveUrl,
        processing_status: "archived",
        processed_at: new Date().toISOString(),
      })
      .eq("id", doc.id);
    if (uErr) {
      errors.push({ doc_id: doc.id, stage: "db_update", error: `Drive upload OK but DB update failed: ${uErr.message}` });
      // Still count as archived since the file is in Drive; the document row will be reconciled later
    }
    archived++;
    archivedIds.push(doc.id);
  }

  const durationSec = Math.round((Date.now() - started) / 1000);
  const summary = pendingDocs.length === 0
    ? "No pending documents to archive"
    : `Archived ${archived} doc(s) to Drive; ${failed} failed`;

  const recipeId = await getRecipeId(AGENCY_ID, RECIPE_NAME);
  if (recipeId) {
    const status = failed === 0 ? "success" : (archived === 0 ? "failed" : "success");
    await sb.from("automation_run_log").insert({
      agency_id: AGENCY_ID,
      recipe_id: recipeId,
      status,
      records_processed: archived,
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
    archived,
    failed,
    duration_seconds: durationSec,
    archived_ids: archivedIds,
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
