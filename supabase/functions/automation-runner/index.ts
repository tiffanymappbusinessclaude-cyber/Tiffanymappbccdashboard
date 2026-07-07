// =========================================================================
// automation-runner  (BCC Master Template)
// =========================================================================
// PURPOSE: Generic executor for any row in the automation_recipes table.
//   Triggered by:
//     (a) pg_cron tick via run_due_automation_recipes() in migration 011, or
//     (b) manual call from the Automations module in the BCC web app via
//         the run_automation_recipe(uuid) RPC.
//
//   For each invocation:
//     1. Load the recipe row by recipe_id (resolves agency_id)
//     2. Auth via shared_secret (matches settings.automation_runner_cron_secret
//        for the recipe's agency)
//     3. Mark the recipe as "running" (sets last_run_at to NOW())
//     4. Resolve Composio credentials from settings (agency-scoped)
//     5. Call the recipe's composio_action with input_config arguments
//     6. If groq_prompt is set, post the result data through Groq's free
//        OpenAI-compatible REST API for structured JSON extraction.
//        Requires GROQ_API_KEY as a Supabase Edge Function secret
//        (free tier from console.groq.com — set via `supabase secrets set`).
//     7. Write parsed records to the recipe's output_table per output_config
//     8. Write a row to automation_run_log
//     9. Update the recipe's last_run_status
//    10. Telegram alert on failure (if Telegram creds present)
//
// PATTERN: Mirrors the Composio call shape in gmail-inbox-archiver and the
//   auth/log/Telegram structure in linkedin-poster from the Imaginary Farms
//   ops project. Same proven pattern, generalized over the recipe row, and
//   adapted for the master template's settings table (key/value, scoped by
//   agency_id) instead of the ops project's brand_kit table.
//
// CREDENTIALS REQUIRED IN public.settings (scoped by agency_id):
//   automation_runner_cron_secret  - random secret, also referenced by mig 011
//   composio_api_key               - Composio API key
//   composio_user_id               - Composio user ID for this agency
//   composio_<conn>_account_id     - one per connection used by recipes;
//                                    e.g. composio_gmail_account_id,
//                                    composio_facebook_account_id, etc.
//   (GROQ_API_KEY is a Supabase Edge Function secret, NOT a settings row.
//    Set via: supabase secrets set GROQ_API_KEY=<your-key>, then redeploy.
//    Required only if any recipe uses groq_prompt. Both IF and IA converged
//    on this pattern 2026-07-02.)
//   telegram_bot_token             - OPTIONAL; failure alerts only
//   telegram_chat_id               - OPTIONAL; failure alerts only
//
// AUTH:
//   verify_jwt = false
//   POST body must contain shared_secret matching the agency's
//   automation_runner_cron_secret in settings. Body must also contain a
//   recipe_id; the function loads that recipe to resolve the agency_id
//   used for the credential lookup.
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
// LLM calls go directly to Groq's OpenAI-compatible REST API.
// Free tier from console.groq.com — set as Edge Function secret via
// `supabase secrets set GROQ_API_KEY=<key>`, then redeploy this function.
const GROQ_API_BASE = "https://api.groq.com/openai/v1/chat/completions";
const LLM_MODEL_DEFAULT = "llama-3.3-70b-versatile";

function stripFences(s: string): string {
  return s.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- helpers ------------------------------------------------------------

/**
 * Read a credential from public.settings, scoped to the given agency.
 * Returns null if no row exists for that (agency_id, setting_key) pair.
 */
async function getSetting(agencyId: string, key: string): Promise<string | null> {
  const { data, error } = await sb
    .from("settings")
    .select("setting_value")
    .eq("agency_id", agencyId)
    .eq("setting_key", key)
    .maybeSingle();
  if (error) {
    throw new Error(`settings read failed for agency ${agencyId} key ${key}: ${error.message}`);
  }
  return data?.setting_value ?? null;
}

async function telegram(agencyId: string | null, text: string): Promise<void> {
  if (!agencyId) return; // no agency context — can't look up creds
  const botToken = await getSetting(agencyId, "telegram_bot_token");
  const chatId = await getSetting(agencyId, "telegram_chat_id");
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (_e) { /* Telegram failures are non-fatal */ }
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// B8b enhancement: connectedAccountId is now optional; authConfigId is a fallback
// (used by orchestrators that resolve settings.composio_<conn>_auth_config_id).
// Callers that only had a connectedAccountId continue to work unchanged.
async function callComposio(opts: {
  apiKey: string;
  userId: string;
  connectedAccountId?: string | null;
  authConfigId?: string | null;
  toolSlug: string;
  toolArguments: Record<string, any>;
}): Promise<{ ok: boolean; data: any; error: string | null; httpStatus: number }> {
  const body: Record<string, any> = {
    user_id: opts.userId,
    arguments: opts.toolArguments,
  };
  if (opts.connectedAccountId) body.connected_account_id = opts.connectedAccountId;
  else if (opts.authConfigId)  body.auth_config_id       = opts.authConfigId;

  const res = await fetch(`${COMPOSIO_BASE}/${opts.toolSlug}`, {
    method: "POST",
    headers: { "x-api-key": opts.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  const ok = res.ok && !!parsed?.successful;
  const data = parsed?.data?.response_data ?? parsed?.data ?? null;
  const error = ok
    ? null
    : (parsed?.error?.message || parsed?.error || text.slice(0, 400));
  return { ok, data, error, httpStatus: res.status };
}

async function callGroqLLM(opts: {
  groqApiKey: string;
  systemPrompt: string;
  userContent: string;
  model?: string;
  maxTokens?: number;
}): Promise<{ ok: boolean; data: any; error: string | null }> {
  // Direct call to Groq's OpenAI-compatible chat completions endpoint.
  // Free tier supports llama-3.3-70b-versatile with generous rate limits.
  // We use response_format json_object (supported by Groq) AND keep the
  // belt-and-suspenders system-prompt instruction + fence stripping as a fallback.
  const body = {
    messages: [
      {
        role: "system",
        content: opts.systemPrompt +
          "\n\nReturn ONLY a raw JSON object. No markdown. No code fences. No prose before or after the JSON.",
      },
      { role: "user", content: opts.userContent },
    ],
    model: opts.model ?? LLM_MODEL_DEFAULT,
    temperature: 0.1,
    max_tokens: opts.maxTokens ?? 4096,
    response_format: { type: "json_object" },
  };

  // Retry on 429/5xx with exponential backoff, max 3 attempts.
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(GROQ_API_BASE, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${opts.groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(500 * Math.pow(2, attempt));
      continue;
    }
    const text = await res.text();
    let parsed: any = {};
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!res.ok) {
      lastErr = parsed?.error?.message || parsed?.error || text.slice(0, 400);
      return { ok: false, data: null, error: lastErr };
    }
    const choice = parsed?.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      return { ok: false, data: null, error: "Groq returned empty content" };
    }
    if (choice?.finish_reason === "length") {
      console.warn("[callGroqLLM] finish_reason=length — output may be truncated");
    }
    const cleaned = stripFences(content);
    let extracted: any;
    try { extracted = JSON.parse(cleaned); }
    catch (e) {
      return {
        ok: false,
        data: null,
        error: `LLM response was not valid JSON after fence-stripping: ${(e as Error).message}`,
      };
    }
    return { ok: true, data: extracted, error: null };
  }
  return { ok: false, data: null, error: `Groq LLM call exhausted retries: ${lastErr}` };
}

/**
 * Resolve the Composio connected_account_id for a given connection slug.
 * Recipes specify composio_connection like "gmail" or "facebook"; this maps
 * to the corresponding settings key for the given agency.
 */
async function getComposioAccountId(agencyId: string, connection: string): Promise<string> {
  const key = `composio_${connection.toLowerCase()}_account_id`;
  const v = await getSetting(agencyId, key);
  if (!v) {
    throw new Error(
      `Missing settings credential: ${key} (agency ${agencyId}). The agent's Composio account for "${connection}" must be authorized and its account ID stored. See docs/AUTOMATIONS_INSTALL.md Step 3.`,
    );
  }
  return v;
}

/**
 * Write a parsed record array to the recipe's output_table, honoring
 * output_config.unique_on (column list for ON CONFLICT) and on_conflict
 * (update | ignore).
 */
async function writeOutput(opts: {
  outputTable: string;
  outputConfig: any;
  records: any[];
  agencyId: string | null;
}): Promise<{ inserted: number; updated: number }> {
  if (!Array.isArray(opts.records) || opts.records.length === 0) {
    return { inserted: 0, updated: 0 };
  }

  // Stamp agency_id on every record if the table has the column and the recipe
  // belongs to an agency. We let the actual insert fail if the column doesn't
  // exist; that surfaces in the error_message in the run log.
  const records = opts.agencyId
    ? opts.records.map((r) => ({ agency_id: opts.agencyId, ...r }))
    : opts.records;

  const uniqueOn: string[] | undefined = opts.outputConfig?.unique_on;
  const onConflict: string = opts.outputConfig?.on_conflict || "ignore";

  if (uniqueOn && uniqueOn.length > 0 && onConflict === "update") {
    const { data, error } = await sb
      .from(opts.outputTable)
      .upsert(records, { onConflict: uniqueOn.join(","), ignoreDuplicates: false })
      .select("id");
    if (error) throw new Error(`upsert to ${opts.outputTable} failed: ${error.message}`);
    return { inserted: data?.length ?? 0, updated: 0 }; // Upsert doesn't distinguish
  }

  if (uniqueOn && uniqueOn.length > 0) {
    // ignore-on-conflict
    const { data, error } = await sb
      .from(opts.outputTable)
      .upsert(records, { onConflict: uniqueOn.join(","), ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`insert to ${opts.outputTable} failed: ${error.message}`);
    return { inserted: data?.length ?? 0, updated: 0 };
  }

  // No unique constraint specified — plain insert
  const { data, error } = await sb
    .from(opts.outputTable)
    .insert(records)
    .select("id");
  if (error) throw new Error(`insert to ${opts.outputTable} failed: ${error.message}`);
  return { inserted: data?.length ?? 0, updated: 0 };
}

// =========================================================================
// B8b — Two-stage orchestrators for internal_handler recipes that can't run
// as pure Postgres (they need Gmail/Drive/Composio API calls).
//
// See migration 030_two_stage_recipe_helpers.sql for the paired SQL bookends.
//
// Handlers implemented here:
//   dispatch_email_archiver     -> runEmailArchiver
//   dispatch_document_processor -> runDocumentProcessor  (v1 flow only —
//     detect + file to Drive + alert; LLM parse "v2 stage C" not shipped
//     in B8b core, migration 030 provides the forward-prep RPCs)
//   instagram_manual_reminder   -> runInstagramManualReminder
//
// All three use the same pattern:
//   1. Call prepare_*_batch RPC -> returns jsonb plan
//   2. Execute the plan (Composio calls)
//   3. Call log_*_result RPC -> records outcome, returns summary
// =========================================================================

// -------------------------------------------------------------------------
// Attachment classification result type (for document processor)
// -------------------------------------------------------------------------
interface ClassifiedAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  docType: "sf_comp_recap" | "paychex_payroll" | "sf_deduction_stmt" | "other";
  needsIngest: boolean;
  periodHint: string | null;     // e.g. "2026-05-second" for Comp Recaps
  driveSubfolder: string;        // category folder name
}

// -------------------------------------------------------------------------
// Kwame-fork helper: resolve settings.composio_<connection>_auth_config_id
// (companion to master's getComposioAccountId).
// -------------------------------------------------------------------------
async function getComposioAuthConfigId(agencyId: string, connection: string): Promise<string | null> {
  return await getSetting(agencyId, `composio_${connection.toLowerCase()}_auth_config_id`);
}

// -------------------------------------------------------------------------
// Ensure a Gmail label exists; return its id. Used to file / archive.
// Resilient to the "Label already exists" race that occurs when
// GMAIL_LIST_LABELS returns labels in a shape the parser doesn't recognize,
// or when the label was created outside this recipe. If agencyId +
// settingsKey are provided, the resolved label id is cached in settings
// for zero-Composio-call lookups on subsequent runs.
// FIXED 2026-07-06: Doc Processor was failing 190x since 2026-07-02 21:11 UTC
// because create-then-throw fired on every run once BCC-Processed existed.
// -------------------------------------------------------------------------
async function ensureGmailLabelId(opts: {
  apiKey: string; userId: string; accountId: string | null; authConfigId: string | null; labelName: string;
  agencyId?: string; settingsKey?: string;
}): Promise<string> {
  // Fast path: settings-cached label id (no Composio calls when populated)
  if (opts.agencyId && opts.settingsKey) {
    const cached = await getSetting(opts.agencyId, opts.settingsKey);
    if (cached) return cached;
  }

  const parseListedLabels = (data: any): any[] => {
    const labels = data?.labels ?? data ?? [];
    const arr = Array.isArray(labels) ? labels : (labels.labels || []);
    return Array.isArray(arr) ? arr : [];
  };
  const matchesLabel = (l: any): boolean =>
    !!l && (l.name === opts.labelName || l.label_name === opts.labelName);

  const persistIfConfigured = async (id: string): Promise<void> => {
    if (opts.agencyId && opts.settingsKey) {
      await sb.from("settings").upsert({
        agency_id: opts.agencyId, setting_key: opts.settingsKey,
        setting_value: id, setting_type: "string",
        updated_by: "automation_runner",
      }, { onConflict: "agency_id,setting_key" });
    }
  };

  // Try list first
  const listRes = await callComposio({
    apiKey: opts.apiKey, userId: opts.userId,
    connectedAccountId: opts.accountId, authConfigId: opts.authConfigId,
    toolSlug: "GMAIL_LIST_LABELS", toolArguments: {},
  });
  if (listRes.ok) {
    const found = parseListedLabels(listRes.data).find(matchesLabel);
    if (found?.id) {
      await persistIfConfigured(found.id);
      return found.id;
    }
  }

  // Create as a fallback
  const createRes = await callComposio({
    apiKey: opts.apiKey, userId: opts.userId,
    connectedAccountId: opts.accountId, authConfigId: opts.authConfigId,
    toolSlug: "GMAIL_CREATE_LABEL",
    toolArguments: { label_name: opts.labelName, name: opts.labelName },
  });
  if (!createRes.ok) {
    // Graceful "already exists" recovery: label existed but list-parse missed it.
    const errStr = String(createRes.error || "").toLowerCase();
    if (errStr.includes("already exists")) {
      const retryRes = await callComposio({
        apiKey: opts.apiKey, userId: opts.userId,
        connectedAccountId: opts.accountId, authConfigId: opts.authConfigId,
        toolSlug: "GMAIL_LIST_LABELS", toolArguments: {},
      });
      if (retryRes.ok) {
        const found = parseListedLabels(retryRes.data).find(matchesLabel);
        if (found?.id) {
          await persistIfConfigured(found.id);
          return found.id;
        }
      }
    }
    throw new Error(`GMAIL_CREATE_LABEL '${opts.labelName}' failed: ${createRes.error}`);
  }
  const id = createRes.data?.id || createRes.data?.label?.id;
  if (!id) throw new Error(`GMAIL_CREATE_LABEL '${opts.labelName}' returned no id`);
  await persistIfConfigured(id);
  return id;
}

// -------------------------------------------------------------------------
// Find or create a Drive folder by path segments; returns folderId.
// -------------------------------------------------------------------------
async function findOrCreateDriveFolder(opts: {
  apiKey: string; userId: string; accountId: string | null; authConfigId: string | null;
  pathSegments: string[];
}): Promise<{ folderId: string; folderPath: string }> {
  let parentId: string | null = null;
  for (const seg of opts.pathSegments) {
    const findArgs: Record<string, any> = { name_exact: seg };
    if (parentId) findArgs.parent_folder_id = parentId;
    const findRes = await callComposio({
      apiKey: opts.apiKey, userId: opts.userId,
      connectedAccountId: opts.accountId, authConfigId: opts.authConfigId,
      toolSlug: "GOOGLEDRIVE_FIND_FOLDER", toolArguments: findArgs,
    });
    let foundId: string | null = null;
    if (findRes.ok) {
      const d = findRes.data || {};
      const candidates = d.files || d.items || d.folders || d.results || [];
      if (Array.isArray(candidates) && candidates.length > 0) {
        foundId = candidates[0].id || candidates[0].file_id || candidates[0].folder_id;
      }
    }
    if (!foundId) {
      const createArgs: Record<string, any> = { folder_name: seg, name: seg };
      if (parentId) { createArgs.parent_id = parentId; createArgs.parent_folder_id = parentId; }
      const createRes = await callComposio({
        apiKey: opts.apiKey, userId: opts.userId,
        connectedAccountId: opts.accountId, authConfigId: opts.authConfigId,
        toolSlug: "GOOGLEDRIVE_CREATE_FOLDER", toolArguments: createArgs,
      });
      if (!createRes.ok) throw new Error(`GOOGLEDRIVE_CREATE_FOLDER for '${seg}' failed: ${createRes.error}`);
      const d = createRes.data || {};
      foundId = d.id || d.file_id || d.folder_id;
      if (!foundId) throw new Error(`GOOGLEDRIVE_CREATE_FOLDER returned no id for '${seg}'`);
    }
    parentId = foundId;
  }
  return { folderId: parentId!, folderPath: opts.pathSegments.join("/") };
}

// -------------------------------------------------------------------------
// Resolve a Drive folder template like 'BCC/{{year}}/{{month}}/{{category}}'
// -------------------------------------------------------------------------
function resolveDriveFolderTemplate(template: string, tz: string, category: string): string[] {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit" });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  const year = parts.year || String(now.getUTCFullYear());
  const month = parts.month || String(now.getUTCMonth() + 1).padStart(2, "0");
  const resolved = template
    .replace(/\{\{year\}\}/g, year)
    .replace(/\{\{month\}\}/g, month)
    .replace(/\{\{category\}\}/g, category);
  return resolved.split("/").filter((s) => s.length > 0);
}

// -------------------------------------------------------------------------
// State-Farm-specific: sniff COMP_RECAP period hint from filename/subject
// (e.g. '2026-Q1', 'January 2026'). Returns null if pattern not matched.
// -------------------------------------------------------------------------
function extractCompRecapPeriodHint(filename: string, subject: string): string | null {
  const haystack = `${filename} ${subject}`;
  // Try YYYY[_-]MM[_-]DD first
  const ymd = haystack.match(/(20\d{2})[_\-\s\.]?(0?[1-9]|1[0-2])[_\-\s\.]?(0?[1-9]|[12]\d|3[01])/);
  if (ymd) {
    const year = ymd[1];
    const month = ymd[2].padStart(2, "0");
    const day = parseInt(ymd[3], 10);
    const half = day <= 15 ? "first" : "second";
    return `${year}-${month}-${half}`;
  }
  // Fall back to YYYY[_-]MM
  const ym = haystack.match(/(20\d{2})[_\-\s\.](0?[1-9]|1[0-2])\b/);
  if (ym) {
    const year = ym[1];
    const month = ym[2].padStart(2, "0");
    return `${year}-${month}-unknown_half`;
  }
  return null;
}

// -------------------------------------------------------------------------
// Drive folder routing by classified doc type (SF-specific categories:
// sf_comp_recap, sf_deduction_stmt, paychex_payroll, other).
// -------------------------------------------------------------------------
function driveFolderForDocType(docType: ClassifiedAttachment["docType"], year: string): string[] {
  const subfolder = {
    sf_comp_recap:    "SF Compensation Recaps",
    paychex_payroll:  "Paychex Payroll",
    sf_deduction_stmt: "SF Deduction Statements",
    other:            "Other",
  }[docType];
  return [
    "BCC Financial Records",
    "Live Documents (May 2026 forward)",
    subfolder,
    year,
  ];
}

// -------------------------------------------------------------------------
// Classify an incoming email attachment by sender + subject + filename.
// Returns { docType, needsIngest, periodHint }.
// -------------------------------------------------------------------------
function classifyAttachment(opts: {
  from: string;
  subject: string;
  filename: string;
  mimeType: string;
}): { docType: ClassifiedAttachment["docType"]; needsIngest: boolean; periodHint: string | null; driveSubfolder: string } {
  const from = (opts.from || "").toLowerCase();
  const subj = (opts.subject || "").toLowerCase();
  const fname = (opts.filename || "").toLowerCase();
  const isPdf = opts.mimeType === "application/pdf" || fname.endsWith(".pdf");

  // SF Comp Recap: from statefarm + (subject OR filename) hints
  if (
    from.includes("statefarm")
    && (
      /comp(ensation)?[\s_\-]*recap/.test(subj)
      || /comp(ensation)?[\s_\-]*recap/.test(fname)
      || /recapitulation/.test(subj)
    )
    && isPdf
  ) {
    return {
      docType: "sf_comp_recap",
      needsIngest: true,
      periodHint: extractCompRecapPeriodHint(fname, subj),
      driveSubfolder: "SF Compensation Recaps",
    };
  }

  // SF Deduction Statement
  if (
    from.includes("statefarm")
    && /deduction[\s_\-]*statement/.test(subj + " " + fname)
    && isPdf
  ) {
    return {
      docType: "sf_deduction_stmt",
      needsIngest: true,
      periodHint: null,
      driveSubfolder: "SF Deduction Statements",
    };
  }

  // Paychex payroll: from paychex + payroll hints
  if (
    from.includes("paychex")
    && (/payroll/.test(subj) || /payroll/.test(fname))
    && (isPdf || /\.(csv|xlsx?)$/.test(fname))
  ) {
    return {
      docType: "paychex_payroll",
      needsIngest: true,
      periodHint: null,
      driveSubfolder: "Paychex Payroll",
    };
  }

  // Generic SF or Paychex doc — file but don't fire ingest alert
  if (from.includes("statefarm") || from.includes("paychex")) {
    return {
      docType: "other",
      needsIngest: false,
      periodHint: null,
      driveSubfolder: "Other",
    };
  }

  // Shouldn't reach here given the Gmail query, but be defensive
  return { docType: "other", needsIngest: false, periodHint: null, driveSubfolder: "Other" };
}

// -------------------------------------------------------------------------
// -------------------------------------------------------------------------
// AA05 prohibited-terms list (State Farm compliance) — canonical word block
// used by checkAA05Compliance. SQL side (has_aa05_prohibited_terms in
// migration 015) applies the same list; TS pre-flight is defense-in-depth.
// -------------------------------------------------------------------------
const AA05_PROHIBITED_TERMS: string[] = [
  "client", "clients",
  "solutions",
  "expert ", " expert", "experts ", " experts",
  "specialist",
  "advisor", "consultant",
  "transfers welcome",
  "financial freedom",
  "wealth accumulation",
  "world-class", "world class",
  "first-class", "first class",
  "cheap", "affordable", "low cost",
  "guarantee", "guaranteed",
  "#1", "greatest",
];

// AA05 (State Farm compliance) pre-flight check for social captions.
// -------------------------------------------------------------------------
function checkAA05Compliance(text: string): { ok: boolean; reason: string | null } {
  if (!text || text.length === 0) return { ok: true, reason: null };
  const lower = text.toLowerCase();
  for (const term of AA05_PROHIBITED_TERMS) {
    if (lower.includes(term)) return { ok: false, reason: `aa05_prohibited_term: '${term.trim()}'` };
  }
  return { ok: true, reason: null };
}

// -------------------------------------------------------------------------
// Send Instagram-post reminder email to the agency owner or bookkeeper.
// -------------------------------------------------------------------------
async function sendInstagramReminderEmail(opts: {
  apiKey: string; userId: string; agencyId: string; to: string; item: any;
}): Promise<{ ok: boolean; error: string | null }> {
  const gmailAccountId    = await getComposioAccountId(opts.agencyId, "gmail").catch(() => null);
  const gmailAuthConfigId = await getComposioAuthConfigId(opts.agencyId, "gmail").catch(() => null);
  const item = opts.item || {};
  const hashtagsArr: string[] = Array.isArray(item.hashtags) ? item.hashtags : [];
  const hashtagsText = hashtagsArr.length > 0
    ? hashtagsArr.slice(0, 25).map((h: string) => h.startsWith("#") ? h : `#${h}`).join(" ")
    : "(no hashtags set)";
  const subject = `[BCC] Instagram post reminder — ${item.scheduled_date || "today"}`;
  const body = [
    "Your Instagram post is ready to post manually.",
    "",
    "(Instagram doesn't allow API auto-posting — only reminders.)",
    "",
    "---",
    "",
    "CAPTION:",
    String(item.caption || "(no caption)"),
    "",
    "HASHTAGS (paste into the first comment, not the caption):",
    hashtagsText,
    "",
    `MEDIA URL: ${item.media_url || "(none — upload manually)"}`,
    `SCHEDULED:  ${item.scheduled_date || "?"} ${item.scheduled_time || ""}`,
    "",
    `content_calendar id: ${item.id}`,
    "",
    "After posting, mark the item 'posted' in BCC Social Media module.",
  ].join("\n");

  const res = await callComposio({
    apiKey: opts.apiKey, userId: opts.userId,
    connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
    toolSlug: "GMAIL_SEND_EMAIL",
    toolArguments: {
      recipient_email: opts.to,
      subject,
      body,
    },
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, error: null };
}

// -------------------------------------------------------------------------
// Orchestrator: runEmailArchiver (internal_handler=dispatch_email_archiver)
// Reads prepare_email_archive_batch plan, executes Gmail archive + Drive
// filing loop, calls log_email_archive_result.
// -------------------------------------------------------------------------
async function runEmailArchiver(recipe: any): Promise<{
  recordsProcessed: number; outputSummary: string;
}> {
  const agencyId = recipe.agency_id as string;
  const input = recipe.input_config || {};
  const olderThanDays = Number(input.older_than_days ?? 30);
  const maxBatch = Math.min(Number(input.max_batch ?? 100), 100);
  const routeAttachments = input.route_attachments_to_drive !== false;
  const preserveStarred = input.preserve_starred !== false;
  const folderTemplate = input.drive_folder_template || "BCC/{{year}}/{{month}}/{{category}}";
  const archiveLabelName = input.archive_label || "BCC/Archived";

  const composioApiKey = Deno.env.get("COMPOSIO_API_KEY") || await getSetting(agencyId, "composio_api_key");
  if (!composioApiKey) throw new Error("Missing Composio API key for email_archiver_orchestrator");
  const composioUserId = await getSetting(agencyId, "composio_user_id");
  if (!composioUserId) throw new Error("Missing settings.composio_user_id for email_archiver_orchestrator");
  const gmailAccountId    = await getComposioAccountId(agencyId, "gmail");
  const gmailAuthConfigId = await getComposioAuthConfigId(agencyId, "gmail");
  const driveAccountId    = await getComposioAccountId(agencyId, "googledrive");
  const driveAuthConfigId = await getComposioAuthConfigId(agencyId, "googledrive");

  const { data: plan, error: planErr } = await sb.rpc("prepare_email_archive_batch", {
    p_agency_id: agencyId,
    p_older_than_days: olderThanDays,
    p_max_batch: maxBatch,
  });
  if (planErr) throw new Error(`prepare_email_archive_batch failed: ${planErr.message}`);
  if (!plan || typeof plan !== "object") throw new Error("prepare_email_archive_batch returned no plan");
  const gmailQuery: string = plan.gmail_query;
  const dedupSet: Set<string> = new Set(Array.isArray(plan.dedup_message_ids) ? plan.dedup_message_ids : []);

  const archiveLabelId = await ensureGmailLabelId({
    apiKey: composioApiKey, userId: composioUserId,
    accountId: gmailAccountId, authConfigId: gmailAuthConfigId,
    labelName: archiveLabelName,
    agencyId, settingsKey: "gmail_archive_label_id",
  });

  const tz = (await getSetting(agencyId, "agency_timezone")) || "America/New_York";
  let driveFolderId: string | null = null;
  let driveFolderPath = "";
  if (routeAttachments) {
    const segments = resolveDriveFolderTemplate(folderTemplate, tz, "email-archive");
    const folder = await findOrCreateDriveFolder({
      apiKey: composioApiKey, userId: composioUserId,
      accountId: driveAccountId, authConfigId: driveAuthConfigId,
      pathSegments: segments,
    });
    driveFolderId = folder.folderId;
    driveFolderPath = folder.folderPath;
  }

  const fetchRes = await callComposio({
    apiKey: composioApiKey, userId: composioUserId,
    connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
    toolSlug: "GMAIL_FETCH_EMAILS",
    toolArguments: {
      query: gmailQuery,
      max_results: maxBatch,
      ids_only: true,
      verbose: false,
    },
  });
  if (!fetchRes.ok) throw new Error(`GMAIL_FETCH_EMAILS failed: ${fetchRes.error}`);
  const messages: any[] = (fetchRes.data?.messages) || (Array.isArray(fetchRes.data) ? fetchRes.data : []);
  const candidateIds: string[] = messages
    .map((m: any) => m?.messageId || m?.id)
    .filter((id: any) => typeof id === "string" && id.length > 0 && !dedupSet.has(id))
    .slice(0, maxBatch);

  if (candidateIds.length === 0) {
    return {
      recordsProcessed: 0,
      outputSummary: `No new messages to archive (query='${gmailQuery}'; ${dedupSet.size} dedup'd; ${messages.length} returned)`,
    };
  }

  const archivedIds: string[] = [];
  const attachmentsFiled: any[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const msgId of candidateIds) {
    try {
      const msgRes = await callComposio({
        apiKey: composioApiKey, userId: composioUserId,
        connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
        toolSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
        toolArguments: { message_id: msgId, format: routeAttachments ? "full" : "metadata" },
      });
      if (!msgRes.ok) { skipped.push({ id: msgId, reason: `fetch_full: ${msgRes.error}` }); continue; }
      const msg: any = msgRes.data || {};

      const labelIds: string[] = msg.labelIds || msg.label_ids || msg.payload?.labelIds || [];
      const isStarred = labelIds.includes("STARRED");
      if (preserveStarred && isStarred) { skipped.push({ id: msgId, reason: "preserve_starred" }); continue; }

      let subject: string = msg.subject || "";
      if (!subject && Array.isArray(msg.payload?.headers)) {
        const h = msg.payload.headers.find((hh: any) => (hh.name || "").toLowerCase() === "subject");
        subject = h?.value || "";
      }

      const attachments: { attachmentId: string; filename: string; mimeType: string }[] = [];
      if (routeAttachments) {
        const walk = (parts: any[]): void => {
          for (const p of parts || []) {
            if (p?.filename && p?.body?.attachmentId) {
              attachments.push({
                attachmentId: p.body.attachmentId,
                filename: p.filename,
                mimeType: p.mimeType || "application/octet-stream",
              });
            }
            if (Array.isArray(p?.parts)) walk(p.parts);
          }
        };
        walk(msg.payload?.parts || []);
        if (attachments.length === 0 && Array.isArray(msg.attachmentList)) {
          for (const a of msg.attachmentList) {
            if (a?.attachmentId && a?.filename) {
              attachments.push({
                attachmentId: a.attachmentId,
                filename: a.filename,
                mimeType: a.mimeType || "application/octet-stream",
              });
            }
          }
        }
      }

      for (const att of attachments) {
        try {
          const getRes = await callComposio({
            apiKey: composioApiKey, userId: composioUserId,
            connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
            toolSlug: "GMAIL_GET_ATTACHMENT",
            toolArguments: { message_id: msgId, attachment_id: att.attachmentId, file_name: att.filename },
          });
          if (!getRes.ok) { console.warn(`[email_archiver] GMAIL_GET_ATTACHMENT failed (${msgId}/${att.filename}): ${getRes.error}`); continue; }
          const file = getRes.data?.file || getRes.data || {};
          const s3url = file.s3url || file.url;
          if (!s3url) { console.warn(`[email_archiver] no s3url for ${msgId}/${att.filename}`); continue; }
          const uploadArgs: Record<string, any> = {
            source_url: s3url,
            name: att.filename,
            mime_type: file.mimetype || att.mimeType,
          };
          if (driveFolderId) uploadArgs.parent_folder_id = driveFolderId;
          const uploadRes = await callComposio({
            apiKey: composioApiKey, userId: composioUserId,
            connectedAccountId: driveAccountId, authConfigId: driveAuthConfigId,
            toolSlug: "GOOGLEDRIVE_UPLOAD_FROM_URL",
            toolArguments: uploadArgs,
          });
          if (!uploadRes.ok) { console.warn(`[email_archiver] GOOGLEDRIVE_UPLOAD_FROM_URL failed for ${att.filename}: ${uploadRes.error}`); continue; }
          const driveFile = uploadRes.data || {};
          const driveFileId: string | null = driveFile.id || driveFile.file_id || driveFile.fileId || null;
          if (!driveFileId) { console.warn(`[email_archiver] upload returned no id for ${att.filename}`); continue; }
          const driveUrl: string = driveFile.webViewLink || driveFile.url
            || `https://drive.google.com/file/d/${driveFileId}/view`;
          attachmentsFiled.push({
            message_id: msgId,
            subject,
            file_name: att.filename,
            file_type: file.mimetype || att.mimeType,
            drive_file_id: driveFileId,
            drive_url: driveUrl,
          });
        } catch (attErr) {
          console.warn(`[email_archiver] attachment crash (${msgId}/${att.filename}): ${attErr instanceof Error ? attErr.message : attErr}`);
        }
      }

      const labelRes = await callComposio({
        apiKey: composioApiKey, userId: composioUserId,
        connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
        toolSlug: "GMAIL_ADD_LABEL_TO_EMAIL",
        toolArguments: {
          message_id: msgId,
          add_label_ids: [archiveLabelId],
          remove_label_ids: ["INBOX"],
        },
      });
      if (!labelRes.ok) { skipped.push({ id: msgId, reason: `label_modify: ${labelRes.error}` }); continue; }
      archivedIds.push(msgId);
    } catch (loopErr) {
      skipped.push({ id: msgId, reason: `loop_crash: ${loopErr instanceof Error ? loopErr.message : loopErr}` });
    }
  }

  const { data: logResult, error: logErr } = await sb.rpc("log_email_archive_result", {
    p_agency_id: agencyId,
    p_recipe_id: recipe.id,
    p_result: { archived_message_ids: archivedIds, attachments_filed: attachmentsFiled },
  });
  if (logErr) throw new Error(`log_email_archive_result failed: ${logErr.message}`);

  if (skipped.length > 0) {
    console.warn(`[email_archiver] skipped detail (first 10): ${JSON.stringify(skipped.slice(0, 10))}`);
  }

  const driveDesc = routeAttachments ? `Drive: ${driveFolderPath}` : "Drive routing disabled";
  const fallback = `${archivedIds.length} archived; ${attachmentsFiled.length} attachments filed (${driveDesc}); ${skipped.length} skipped; ${dedupSet.size} dedup'd`;
  const outputSummary = (logResult?.output_summary as string) || fallback;
  return { recordsProcessed: archivedIds.length, outputSummary };
}

// -------------------------------------------------------------------------
// Orchestrator: runDocumentProcessor (internal_handler=dispatch_document_processor)
// v1 flow only: detect SF/Paychex documents in Gmail, file to Drive, insert
// documents row + fire alert. (v2 "stage C" in-runner LLM parse deliberately
// omitted in B8b core; migration 015 ships the mark_document_parsed and
// run_document_processor_backfill helpers as forward prep for a future v2
// runner update.)
// -------------------------------------------------------------------------
async function runDocumentProcessor(recipe: any): Promise<{
  recordsProcessed: number; outputSummary: string;
}> {
  const agencyId = recipe.agency_id as string;
  const input = recipe.input_config || {};
  const lookbackMinutes = Number(input.lookback_minutes ?? 60);
  const maxBatch = Math.min(Number(input.max_batch ?? 10), 25);
  const processedLabelName = input.processed_label || "BCC-Processed";

  const composioApiKey = Deno.env.get("COMPOSIO_API_KEY") || await getSetting(agencyId, "composio_api_key");
  if (!composioApiKey) throw new Error("Missing Composio API key for document_processor_orchestrator");
  const composioUserId = await getSetting(agencyId, "composio_user_id");
  if (!composioUserId) throw new Error("Missing settings.composio_user_id for document_processor_orchestrator");
  const gmailAccountId    = await getComposioAccountId(agencyId, "gmail");
  const gmailAuthConfigId = await getComposioAuthConfigId(agencyId, "gmail");
  const driveAccountId    = await getComposioAccountId(agencyId, "googledrive");
  const driveAuthConfigId = await getComposioAuthConfigId(agencyId, "googledrive");

  // 1. Plan
  const { data: plan, error: planErr } = await sb.rpc("prepare_document_processor_batch", {
    p_agency_id: agencyId,
    p_lookback_minutes: lookbackMinutes,
    p_max_batch: maxBatch,
  });
  if (planErr) throw new Error(`prepare_document_processor_batch failed: ${planErr.message}`);
  if (!plan || typeof plan !== "object") throw new Error("prepare_document_processor_batch returned no plan");
  const gmailQuery: string = plan.gmail_query;
  const dedupSet: Set<string> = new Set(Array.isArray(plan.dedup_message_ids) ? plan.dedup_message_ids : []);

  // 2. Ensure the processed-marker label exists (settings-cached; see ensureGmailLabelId)
  const processedLabelId = await ensureGmailLabelId({
    apiKey: composioApiKey, userId: composioUserId,
    accountId: gmailAccountId, authConfigId: gmailAuthConfigId,
    labelName: processedLabelName,
    agencyId, settingsKey: "gmail_processed_label_id",
  });

  // 3. Fetch candidate messages
  const fetchRes = await callComposio({
    apiKey: composioApiKey, userId: composioUserId,
    connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
    toolSlug: "GMAIL_FETCH_EMAILS",
    toolArguments: {
      query: gmailQuery,
      max_results: maxBatch,
      ids_only: true,
      verbose: false,
    },
  });
  if (!fetchRes.ok) throw new Error(`GMAIL_FETCH_EMAILS failed: ${fetchRes.error}`);
  const messages: any[] = (fetchRes.data?.messages) || (Array.isArray(fetchRes.data) ? fetchRes.data : []);
  const candidateIds: string[] = messages
    .map((m: any) => m?.messageId || m?.id)
    .filter((id: any) => typeof id === "string" && id.length > 0 && !dedupSet.has(id))
    .slice(0, maxBatch);

  if (candidateIds.length === 0) {
    return {
      recordsProcessed: 0,
      outputSummary: `No new docs to process (query='${gmailQuery}'; ${dedupSet.size} dedup'd; ${messages.length} returned)`,
    };
  }

  // 4. Per-message loop
  const processed: any[] = [];
  const skipped: { message_id: string; reason: string }[] = [];
  const errors: { message_id: string; error: string }[] = [];

  // Cache for resolved Drive folders by (docType, year)
  const driveFolderCache: Map<string, string> = new Map();
  const yearNow = new Date().getUTCFullYear().toString();

  async function getDriveFolder(docType: ClassifiedAttachment["docType"], yearOverride?: string): Promise<string> {
    const year = yearOverride || yearNow;
    const cacheKey = `${docType}|${year}`;
    if (driveFolderCache.has(cacheKey)) return driveFolderCache.get(cacheKey)!;
    const segments = driveFolderForDocType(docType, year);
    const folder = await findOrCreateDriveFolder({
      apiKey: composioApiKey, userId: composioUserId,
      accountId: driveAccountId, authConfigId: driveAuthConfigId,
      pathSegments: segments,
    });
    driveFolderCache.set(cacheKey, folder.folderId);
    return folder.folderId;
  }

  for (const msgId of candidateIds) {
    try {
      const msgRes = await callComposio({
        apiKey: composioApiKey, userId: composioUserId,
        connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
        toolSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
        toolArguments: { message_id: msgId, format: "full" },
      });
      if (!msgRes.ok) { errors.push({ message_id: msgId, error: `fetch_full: ${msgRes.error}` }); continue; }
      const msg: any = msgRes.data || {};

      // Extract subject + from headers
      let subject = msg.subject || "";
      let fromHdr = msg.from || "";
      if (Array.isArray(msg.payload?.headers)) {
        for (const h of msg.payload.headers) {
          const n = (h.name || "").toLowerCase();
          if (n === "subject" && !subject) subject = h.value || "";
          if (n === "from" && !fromHdr) fromHdr = h.value || "";
        }
      }

      // Walk attachments
      const attachments: { attachmentId: string; filename: string; mimeType: string }[] = [];
      const walk = (parts: any[]): void => {
        for (const p of parts || []) {
          if (p?.filename && p?.body?.attachmentId) {
            attachments.push({
              attachmentId: p.body.attachmentId,
              filename: p.filename,
              mimeType: p.mimeType || "application/octet-stream",
            });
          }
          if (Array.isArray(p?.parts)) walk(p.parts);
        }
      };
      walk(msg.payload?.parts || []);
      if (attachments.length === 0 && Array.isArray(msg.attachmentList)) {
        for (const a of msg.attachmentList) {
          if (a?.attachmentId && a?.filename) {
            attachments.push({
              attachmentId: a.attachmentId,
              filename: a.filename,
              mimeType: a.mimeType || "application/octet-stream",
            });
          }
        }
      }

      if (attachments.length === 0) {
        skipped.push({ message_id: msgId, reason: "no_attachments" });
        continue;
      }

      let filedAny = false;
      for (const att of attachments) {
        try {
          // Skip non-PDF/non-CSV/non-XLSX attachments (signatures, banner images, etc.)
          const fn = (att.filename || "").toLowerCase();
          const isFileable = att.mimeType === "application/pdf"
            || fn.endsWith(".pdf") || fn.endsWith(".csv") || fn.endsWith(".xlsx") || fn.endsWith(".xls");
          if (!isFileable) continue;

          const classified = classifyAttachment({
            from: fromHdr, subject, filename: att.filename, mimeType: att.mimeType,
          });

          // Resolve Drive folder for this docType + (year from periodHint if available, else current)
          let folderYear = yearNow;
          if (classified.periodHint) {
            const m = classified.periodHint.match(/^(20\d{2})/);
            if (m) folderYear = m[1];
          }
          const driveFolderId = await getDriveFolder(classified.docType, folderYear);

          // Download attachment from Gmail to Composio S3
          const getRes = await callComposio({
            apiKey: composioApiKey, userId: composioUserId,
            connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
            toolSlug: "GMAIL_GET_ATTACHMENT",
            toolArguments: { message_id: msgId, attachment_id: att.attachmentId, file_name: att.filename },
          });
          if (!getRes.ok) {
            console.warn(`[doc_processor] GMAIL_GET_ATTACHMENT failed (${msgId}/${att.filename}): ${getRes.error}`);
            continue;
          }
          const file = getRes.data?.file || getRes.data || {};
          const s3url = file.s3url || file.url;
          if (!s3url) {
            console.warn(`[doc_processor] no s3url for ${msgId}/${att.filename}`);
            continue;
          }

          // Upload to Drive
          const uploadArgs: Record<string, any> = {
            source_url: s3url,
            name: att.filename,
            mime_type: file.mimetype || att.mimeType,
            parent_folder_id: driveFolderId,
          };
          const uploadRes = await callComposio({
            apiKey: composioApiKey, userId: composioUserId,
            connectedAccountId: driveAccountId, authConfigId: driveAuthConfigId,
            toolSlug: "GOOGLEDRIVE_UPLOAD_FROM_URL",
            toolArguments: uploadArgs,
          });
          if (!uploadRes.ok) {
            console.warn(`[doc_processor] GOOGLEDRIVE_UPLOAD_FROM_URL failed for ${att.filename}: ${uploadRes.error}`);
            continue;
          }
          const driveFile = uploadRes.data || {};
          const driveFileId: string | null = driveFile.id || driveFile.file_id || driveFile.fileId || null;
          if (!driveFileId) {
            console.warn(`[doc_processor] upload returned no id for ${att.filename}`);
            continue;
          }
          const driveUrl: string = driveFile.webViewLink || driveFile.url
            || `https://drive.google.com/file/d/${driveFileId}/view`;

          processed.push({
            message_id: msgId,
            subject,
            from: fromHdr,
            file_name: att.filename,
            file_type: file.mimetype || att.mimeType,
            drive_file_id: driveFileId,
            drive_url: driveUrl,
            doc_type: classified.docType,
            needs_ingest: classified.needsIngest,
            period_hint: classified.periodHint,
          });
          filedAny = true;
        } catch (attErr) {
          console.warn(`[doc_processor] attachment crash (${msgId}/${att.filename}): ${attErr instanceof Error ? attErr.message : attErr}`);
        }
      }

      if (!filedAny) {
        skipped.push({ message_id: msgId, reason: "no_fileable_attachments" });
        continue;
      }

      // Apply the processed-marker label (dedup signal for next run, also lets
      // Email Archiver skip these via "-label:BCC-Processed" — wait, that
      // exclusion is in prepare_document_processor_batch's query, not the
      // Email Archiver's. The label is purely a hint for human + dedup).
      const labelRes = await callComposio({
        apiKey: composioApiKey, userId: composioUserId,
        connectedAccountId: gmailAccountId, authConfigId: gmailAuthConfigId,
        toolSlug: "GMAIL_ADD_LABEL_TO_EMAIL",
        toolArguments: {
          message_id: msgId,
          add_label_ids: [processedLabelId],
        },
      });
      if (!labelRes.ok) {
        // Label failure is non-fatal — file already in Drive + documents row will be inserted
        console.warn(`[doc_processor] label add failed for ${msgId}: ${labelRes.error}`);
      }
    } catch (loopErr) {
      errors.push({ message_id: msgId, error: `loop_crash: ${loopErr instanceof Error ? loopErr.message : loopErr}` });
    }
  }

  // 5. Callback to result_rpc — v1 stage A+B done point.
  const { data: logResult, error: logErr } = await sb.rpc("log_document_processor_result", {
    p_agency_id: agencyId,
    p_recipe_id: recipe.id,
    p_result: { processed, skipped, errors },
  });
  if (logErr) throw new Error(`log_document_processor_result failed: ${logErr.message}`);

  if (skipped.length > 0) {
    console.warn(`[doc_processor] skipped detail (first 10): ${JSON.stringify(skipped.slice(0, 10))}`);
  }
  if (errors.length > 0) {
    console.warn(`[doc_processor] error detail (first 10): ${JSON.stringify(errors.slice(0, 10))}`);
  }
  const fallback = `${processed.length} attachments filed; ${skipped.length} messages skipped; ${errors.length} errors; ${dedupSet.size} dedup'd`;
  const outputSummary = (logResult?.output_summary as string) || fallback;
  return { recordsProcessed: processed.length, outputSummary };
}

// -------------------------------------------------------------------------
// Orchestrator: runInstagramManualReminder (internal_handler=instagram_manual_reminder)
// Meta blocks third-party Instagram posting APIs, so this orchestrator sends
// an email reminder to the agency owner at scheduled post time. Uses AA05
// pre-flight for defense-in-depth (SQL side already filters).
// -------------------------------------------------------------------------

// -------------------------------------------------------------------------
// runInstagramManualReminder — Instagram manual-post reminder orchestrator
// -------------------------------------------------------------------------
// Instagram has no server-side API that supports third-party auto-posting;
// content scheduled to Instagram triggers an email reminder to the agency
// owner (typically the front-desk staffer running social) so they can post
// from the phone at the scheduled time. Reads work plan from
// prepare_instagram_reminder_batch, writes result via log_social_post_result.
// -------------------------------------------------------------------------
async function runInstagramManualReminder(recipe: any): Promise<{
  recordsProcessed: number;
  outputSummary: string;
}> {
  const agencyId = recipe.agency_id as string;
  const input = recipe.input_config || {};

  const composioApiKey = Deno.env.get("COMPOSIO_API_KEY") || await getSetting(agencyId, "composio_api_key");
  if (!composioApiKey) throw new Error("Missing Composio API key for Instagram reminder");
  const composioUserId = await getSetting(agencyId, "composio_user_id");
  if (!composioUserId) throw new Error("Missing settings.composio_user_id for Instagram reminder");

  // 1. Get the plan (posts scheduled for today)
  const tz = (await getSetting(agencyId, "agency_timezone")) || "America/New_York";
  const { data: plan, error: planErr } = await sb.rpc("prepare_instagram_reminder_batch", {
    p_agency_id: agencyId, p_tz: tz,
  });
  if (planErr) throw new Error(`prepare_instagram_reminder_batch failed: ${planErr.message}`);
  if (!plan || typeof plan !== "object") throw new Error("prepare_instagram_reminder_batch returned no plan");
  const items: any[] = Array.isArray(plan.items) ? plan.items : [];
  const skipped: any[] = Array.isArray(plan.skipped) ? plan.skipped : [];

  if (items.length === 0 && skipped.length === 0) {
    return { recordsProcessed: 0, outputSummary: "No Instagram posts due" };
  }

  // 2. Resolve the reminder recipient
  const reminderEmail: string = input.reminder_email
    || (await getSetting(agencyId, "owner_email"))
    || (await getSetting(agencyId, "bookkeeper_email"))
    || "";
  if (!reminderEmail) {
    throw new Error(
      "Instagram reminder needs a recipient: set settings.owner_email or " +
      "recipe.input_config.reminder_email"
    );
  }

  // 3. Send reminder per due item
  const results: any[] = [];
  for (const item of items) {
    try {
      // TS pre-flight AA05 (defensive — SQL belt should have caught these)
      const compliance = checkAA05Compliance(String(item.caption || ""));
      if (!compliance.ok) {
        skipped.push({ id: item.id, reason: compliance.reason });
        continue;
      }
      const sendRes = await sendInstagramReminderEmail({
        apiKey: composioApiKey, userId: composioUserId, agencyId,
        to: reminderEmail, item,
      });
      if (sendRes.ok) {
        results.push({ id: item.id, status: "reminded", reminder_sent: true, platform: "instagram" });
      } else {
        results.push({ id: item.id, status: "failed", error: sendRes.error, platform: "instagram" });
      }
    } catch (itemErr) {
      const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
      results.push({ id: item.id, status: "failed", error: `crash: ${msg}`, platform: "instagram" });
    }
  }

  // 4. Callback to log_social_post_result
  const { data: logResult, error: logErr } = await sb.rpc("log_social_post_result", {
    p_agency_id: agencyId,
    p_recipe_id: recipe.id,
    p_result: { results, skipped },
  });
  if (logErr) throw new Error(`log_social_post_result failed: ${logErr.message}`);

  const fallback = `instagram: ${results.length} reminded, ${skipped.length} skipped`;
  const outputSummary = (logResult?.output_summary as string) || fallback;
  return { recordsProcessed: results.length, outputSummary };
}

// --- core executor ------------------------------------------------------

async function executeRecipe(
  recipe: any,
  triggeredBy: string,
): Promise<any> {
  const started = Date.now();
  const recipeId = recipe.id as string;
  const agencyId = recipe.agency_id as string;

  // Optimistic concurrency lock: stamp last_run_at so the next pg_cron tick
  // won't re-fire this recipe in the same minute.
  await sb
    .from("automation_recipes")
    .update({ last_run_at: new Date().toISOString(), last_run_status: "running" })
    .eq("id", recipeId);

  let runStatus = "success";
  let errorMessage: string | null = null;
  let recordsProcessed = 0;
  let outputSummary = "";

  try {
    // --- INTERNAL recipe branch (no Composio call) ---
    // For recipes whose composio_action is the literal string 'INTERNAL', the
    // work happens entirely inside Postgres via the run_internal_recipe()
    // function defined in migration 012. Used by GL Entry Writer, Monthly
    // Close Monitor, Producer Underperformance Watcher, and any agency-
    // specific INTERNAL recipes added later.
    if (recipe.composio_action === "INTERNAL") {
      // --- Runner-side orchestrators (B8b) ---
      // Some internal_handler values need external API calls (Gmail, Drive,
      // Composio) that Postgres can't make. Short-circuit those to their
      // TypeScript orchestrators; everything else falls through to the
      // pure-SQL run_internal_recipe() path below.
      const handler = recipe.internal_handler as string | null;
      let orchestratorResult: { recordsProcessed: number; outputSummary: string } | null = null;

      if (handler === "dispatch_email_archiver") {
        orchestratorResult = await runEmailArchiver(recipe);
      } else if (handler === "dispatch_document_processor") {
        orchestratorResult = await runDocumentProcessor(recipe);
      } else if (handler === "instagram_manual_reminder") {
        orchestratorResult = await runInstagramManualReminder(recipe);
      }

      if (orchestratorResult) {
        recordsProcessed = orchestratorResult.recordsProcessed;
        outputSummary = orchestratorResult.outputSummary;

        // Write run log + update recipe status, then return early
        const durationSec = Math.round((Date.now() - started) / 1000);
        await sb.from("automation_run_log").insert({
          agency_id: agencyId,
          recipe_id: recipeId,
          status: "success",
          records_processed: recordsProcessed,
          error_message: null,
          duration_seconds: durationSec,
          output_summary: outputSummary,
        });
        await sb
          .from("automation_recipes")
          .update({ last_run_status: "success" })
          .eq("id", recipeId);
        return {
          recipe_id: recipeId,
          recipe_name: recipe.recipe_name,
          status: "success",
          records_processed: recordsProcessed,
          duration_seconds: durationSec,
          triggered_by: triggeredBy,
          error: null,
        };
      }

      // --- Pure-SQL INTERNAL handlers (B8a: bank_gl_writer, cc_gl_writer,
      //     payroll_gl_writer, monthly_close_generator, plus GL Entry Writer,
      //     Monthly Close Monitor, Producer Underperformance Watcher) ---
      const { data: internalResult, error: internalErr } = await sb.rpc(
        "run_internal_recipe",
        { p_recipe_id: recipeId },
      );
      if (internalErr) {
        throw new Error(`run_internal_recipe failed: ${internalErr.message}`);
      }
      // run_internal_recipe returns jsonb { records_processed, output_summary }
      recordsProcessed = (internalResult?.records_processed as number) ?? 0;
      outputSummary = (internalResult?.output_summary as string) ??
        `INTERNAL recipe completed (no summary returned)`;

      // Write run log + update recipe status, then return early
      const durationSec = Math.round((Date.now() - started) / 1000);
      await sb.from("automation_run_log").insert({
        agency_id: agencyId,
        recipe_id: recipeId,
        status: "success",
        records_processed: recordsProcessed,
        error_message: null,
        duration_seconds: durationSec,
        output_summary: outputSummary,
      });
      await sb
        .from("automation_recipes")
        .update({ last_run_status: "success" })
        .eq("id", recipeId);

      return {
        recipe_id: recipeId,
        recipe_name: recipe.recipe_name,
        status: "success",
        records_processed: recordsProcessed,
        duration_seconds: durationSec,
        triggered_by: triggeredBy,
        error: null,
      };
    }

    // --- Resolve credentials ---
    const composioApiKey = await getSetting(agencyId, "composio_api_key");
    if (!composioApiKey) {
      throw new Error(`Missing settings credential: composio_api_key (agency ${agencyId})`);
    }
    const composioUserId = await getSetting(agencyId, "composio_user_id");
    if (!composioUserId) {
      throw new Error(`Missing settings credential: composio_user_id (agency ${agencyId})`);
    }

    const connection = recipe.composio_connection;
    if (!connection) {
      throw new Error(`Recipe ${recipe.recipe_name} has no composio_connection set.`);
    }
    const accountId = await getComposioAccountId(agencyId, connection);

    const action = recipe.composio_action;
    if (!action) {
      throw new Error(`Recipe ${recipe.recipe_name} has no composio_action set.`);
    }

    // --- Call Composio ---
    const inputConfig = recipe.input_config || {};
    // input_config can include keys like gmail_query, attachment_required, etc.
    // Recipes are responsible for using keys that map to the Composio tool's
    // expected arguments. The runner passes them through as-is.
    const composioResult = await callComposio({
      apiKey: composioApiKey,
      userId: composioUserId,
      connectedAccountId: accountId,
      toolSlug: action,
      toolArguments: inputConfig,
    });

    if (!composioResult.ok) {
      throw new Error(`Composio ${action} failed: ${composioResult.error}`);
    }

    let parsedRecords: any[] = [];

    // --- Optional: LLM parsing pass (via direct Groq REST) ---
    if (recipe.groq_prompt && recipe.output_table) {
      // Default expectation: composioResult.data is array-shaped or has a top-level
      // collection (messages, items, results). Recipes that need a different shape
      // can include extraction hints in groq_prompt.
      const inputForLLM = JSON.stringify(composioResult.data).slice(0, 60000);
      const groqApiKey = Deno.env.get("GROQ_API_KEY") ?? "";
      if (!groqApiKey) {
        throw new Error(
          "GROQ_API_KEY secret is not set. Get a free key at https://console.groq.com " +
          "and set via: supabase secrets set GROQ_API_KEY=<your-key>, " +
          "then redeploy: supabase functions deploy automation-runner --no-verify-jwt"
        );
      }
      const llmResult = await callGroqLLM({
        groqApiKey,
        systemPrompt: recipe.groq_prompt +
          '\n\nReturn a JSON object: {"records": [...]} where records is an array of objects ready to insert into the output_table. Return {"records": []} if nothing applicable.',
        userContent: inputForLLM,
      });
      if (!llmResult.ok) {
        throw new Error(`LLM parsing failed: ${llmResult.error}`);
      }
      parsedRecords = Array.isArray(llmResult.data?.records) ? llmResult.data.records : [];
    } else if (recipe.output_table && Array.isArray(composioResult.data)) {
      // No LLM step — write raw composio data if it's already record-shaped
      parsedRecords = composioResult.data;
    }

    // --- Write to output_table ---
    if (recipe.output_table && parsedRecords.length > 0) {
      const writeResult = await writeOutput({
        outputTable: recipe.output_table,
        outputConfig: recipe.output_config || {},
        records: parsedRecords,
        agencyId: agencyId,
      });
      recordsProcessed = writeResult.inserted + writeResult.updated;
      outputSummary = `${recordsProcessed} records written to ${recipe.output_table}`;
    } else if (recipe.output_table) {
      outputSummary = `0 records — Composio returned data but Groq LLM parsing yielded no records to write`;
    } else {
      // No output_table: this is an action-only recipe (e.g. send email,
      // post to social, archive). Composio call success is the result.
      outputSummary = `Action ${action} executed successfully (no output_table)`;
      recordsProcessed = 1;
    }
  } catch (err) {
    runStatus = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    outputSummary = `Failed: ${errorMessage.slice(0, 200)}`;
    await telegram(
      agencyId,
      `🛑 <b>Automation FAILED</b>\n\nRecipe: <b>${recipe.recipe_name}</b>\nError: ${errorMessage.slice(0, 400)}`,
    );
  }

  const durationSec = Math.round((Date.now() - started) / 1000);

  // --- Write run log ---
  await sb.from("automation_run_log").insert({
    agency_id: agencyId,
    recipe_id: recipeId,
    status: runStatus,
    records_processed: recordsProcessed,
    error_message: errorMessage,
    duration_seconds: durationSec,
    output_summary: outputSummary,
  });

  // --- Update recipe status ---
  await sb
    .from("automation_recipes")
    .update({ last_run_status: runStatus })
    .eq("id", recipeId);

  return {
    recipe_id: recipeId,
    recipe_name: recipe.recipe_name,
    status: runStatus,
    records_processed: recordsProcessed,
    duration_seconds: durationSec,
    triggered_by: triggeredBy,
    error: errorMessage,
  };
}

// --- HTTP handler -------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
  }

  let body: any = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const recipeId: string | undefined = body.recipe_id;
  const triggeredBy: string = body.triggered_by || "manual";

  if (!recipeId) {
    return jsonResponse({ error: "Missing recipe_id in body" }, 400);
  }
  if (typeof body.shared_secret !== "string" || body.shared_secret.length === 0) {
    return jsonResponse({ error: "Missing shared_secret in body" }, 401);
  }

  // Load the recipe to resolve agency_id, then auth against that agency's
  // shared secret. Order matters: we cannot look up the secret without an
  // agency_id, and we cannot trust the body's recipe_id without the secret —
  // but the recipe row only contains a UUID + agency_id (no secrets), so
  // reading it before auth leaks nothing.
  const { data: recipe, error: recipeErr } = await sb
    .from("automation_recipes")
    .select("*")
    .eq("id", recipeId)
    .maybeSingle();

  if (recipeErr || !recipe) {
    return jsonResponse(
      { error: `Recipe ${recipeId} not found: ${recipeErr?.message || "no row"}` },
      404,
    );
  }

  if (!recipe.agency_id) {
    return jsonResponse(
      {
        error:
          `Recipe ${recipeId} has no agency_id set. Every recipe must belong to an agency so its credentials can be resolved from settings.`,
      },
      500,
    );
  }

  // Auth — agency-scoped
  let expectedSecret: string | null;
  try {
    expectedSecret = await getSetting(recipe.agency_id, "automation_runner_cron_secret");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: `Auth lookup failed: ${msg}` }, 500);
  }
  if (!expectedSecret) {
    return jsonResponse(
      {
        error:
          `Server missing settings.automation_runner_cron_secret for agency ${recipe.agency_id}`,
      },
      500,
    );
  }
  if (body.shared_secret !== expectedSecret) {
    return jsonResponse({ error: "Unauthorized: invalid shared_secret" }, 401);
  }

  try {
    const result = await executeRecipe(recipe, triggeredBy);
    const status = result.status === "success" ? 200 : 500;
    return jsonResponse({ ok: result.status === "success", ...result }, status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await telegram(
      recipe.agency_id,
      `🛑 <b>automation-runner CRASHED</b>\n${msg.slice(0, 300)}`,
    );
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});
