// =========================================================================
// comp-recap-processor
// Downloads pending comp_recap PDFs from Gmail, OCRs them, parses
// Page 1 line items + Page 2 payment section, writes clean comp_recap rows
// Wipes old bad data on first run, idempotent thereafter
// =========================================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const COMPOSIO_BASE = "https://backend.composio.dev/api/v3/tools/execute";
const AGENCY_ID = "ed4b4f81-4ec1-4676-9dea-2a9c98e4a065";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function getSetting(key: string): Promise<string | null> {
  const { data } = await sb.from("settings").select("setting_value")
    .eq("agency_id", AGENCY_ID).eq("setting_key", key).maybeSingle();
  return data?.setting_value ?? null;
}

async function callComposio(toolSlug: string, args: Record<string, unknown>, accountId: string): Promise<{ ok: boolean; data: unknown; error: string | null }> {
  const apiKey = await getSetting("composio_api_key");
  const userId = await getSetting("composio_user_id");
  const res = await fetch(`${COMPOSIO_BASE}/${toolSlug}`, {
    method: "POST",
    headers: { "x-api-key": apiKey!, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, connected_account_id: accountId, arguments: args }),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  const ok = res.ok && !!(parsed as Record<string, unknown>)?.successful;
  const data = (parsed as Record<string, unknown>)?.data ?? null;
  const error = ok ? null : String((parsed as Record<string, unknown>)?.error || text.slice(0, 300));
  return { ok, data, error };
}

// ---- OCR via Groq vision (llama-4 vision) --------------------------------
async function ocrPdfFromUrl(pdfUrl: string): Promise<string> {
  const apiKey = await getSetting("composio_api_key");
  const userId = await getSetting("composio_user_id");

  // Use Groq via Composio to extract text from the PDF URL
  const res = await fetch(`${COMPOSIO_BASE}/COMPOSIO_SEARCH_GROQ_CHAT`, {
    method: "POST",
    headers: { "x-api-key": apiKey!, "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      arguments: {
        model: "llama-3.3-70b-versatile",
        temperature: 0.0,
        max_tokens: 8192,
        messages: [
          {
            role: "system",
            content: `You are a precise data extractor for State Farm AGTCOMP RECAP documents.
Extract ALL text content from the provided PDF URL exactly as it appears.
Return the raw text, preserving the structure of each section:
- PRODUCTION section (Page 1): all line items with company, description, current amount, YTD amount
- PAYMENT SECTION (Page 2): payable per agreement, AIPP payments, awards/bonuses, other income, deductions, NET PAYABLE
- INFORMATION SECTION (Page 3): reportable benefits, YTD totals by company
Do not summarize. Return all numbers exactly as shown.`,
          },
          {
            role: "user",
            content: `Please extract all text from this State Farm comp recap PDF: ${pdfUrl}`,
          },
        ],
      },
    }),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text); } catch { return ""; }
  const content = (parsed as Record<string, unknown>)?.data as Record<string, unknown>;
  return String((content?.choices as Array<Record<string, unknown>>)?.[0]?.message?.content ?? "");
}

// ---- Parse OCR text into structured data ---------------------------------
function parseCompRecapText(rawText: string, year: number, month: number, half: string): {
  lineItems: Array<{ company: string; description: string; amount: number; ytd: number }>;
  netPayable: number;
  grossComp: number;
  totalDeductions: number;
  aippYtd: number;
  scoreboardYtd: number;
  paymentPeriodEnd: string;
} {
  const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);

  // Determine period end date
  const dayEnd = half === "first" ? 15 : new Date(year, month, 0).getDate();
  const paymentPeriodEnd = `${year}-${String(month).padStart(2, "0")}-${String(dayEnd).padStart(2, "0")}`;

  // Companies we track
  const companies = ["MUTL", "SFL", "FIRE", "SFFL", "GFA"];

  // Skip lines that are subtotals/summaries
  const skipPatterns = [
    /^TOTAL\s+(MUTL|SFL|FIRE|SFFL|GFA|FEDERAL|FLORIDA|PAYABLE|AWARDS|OTHER|REPORTABLE|BENEFITS)/i,
    /^GROSS COMPENSATION/i,
    /^ADJUSTED GROSS/i,
    /^NET PAYABLE/i,
    /^TOTAL FEDERAL/i,
    /^TOTAL SFLORIDA/i,
    /^TOTAL YEAR/i,
  ];

  const lineItems: Array<{ company: string; description: string; amount: number; ytd: number }> = [];
  let currentCompany = "";
  let netPayable = 0;
  let grossComp = 0;
  let totalDeductions = 0;
  let aippYtd = 0;
  let scoreboardYtd = 0;

  // Parse numbers like 18,759.81 or 25,258.39
  function parseNum(s: string): number {
    const cleaned = s.replace(/[,$\s]/g, "").replace(/-$/, "");
    const n = parseFloat(cleaned);
    return isNaN(n) ? 0 : n;
  }

  // Match a line with two dollar amounts at end: DESCRIPTION  12,345.67  67,890.12
  function extractAmounts(line: string): { text: string; current: number; ytd: number } | null {
    const m = line.match(/^(.+?)\s+(\d{1,3}(?:,\d{3})*\.\d{2})\s+(\d{1,3}(?:,\d{3})*\.\d{2})\s*$/);
    if (m) return { text: m[1].trim(), current: parseNum(m[2]), ytd: parseNum(m[3]) };
    // Single amount
    const m2 = line.match(/^(.+?)\s+(\d{1,3}(?:,\d{3})*\.\d{2})\s*$/);
    if (m2) return { text: m2[1].trim(), current: parseNum(m2[2]), ytd: 0 };
    return null;
  }

  let inPaymentSection = false;
  let inProductionSection = false;

  for (const line of lines) {
    // Section detection
    if (/PRODUCTION/i.test(line)) { inProductionSection = true; inPaymentSection = false; continue; }
    if (/PAYMENT SECTION/i.test(line)) { inPaymentSection = true; inProductionSection = false; continue; }
    if (/INFORMATION SECTION/i.test(line)) { inPaymentSection = false; inProductionSection = false; continue; }

    // Company detection in production section
    if (inProductionSection) {
      for (const co of companies) {
        if (new RegExp(`^${co}\\b`, "i").test(line)) {
          currentCompany = co;
          break;
        }
      }

      // Skip TOTAL lines
      if (skipPatterns.some((p) => p.test(line))) continue;
      if (/^TOTAL/i.test(line)) continue;

      const extracted = extractAmounts(line);
      if (extracted && currentCompany && extracted.current > 0) {
        lineItems.push({
          company: currentCompany,
          description: extracted.text,
          amount: extracted.current,
          ytd: extracted.ytd,
        });
      }
    }

    // Payment section parsing
    if (inPaymentSection) {
      const amounts = extractAmounts(line);

      if (/NET PAYABLE/i.test(line) && amounts) {
        netPayable = amounts.current || amounts.ytd;
      }
      if (/GROSS COMPENSATION/i.test(line) && amounts) {
        grossComp = amounts.current || amounts.ytd;
      }
      if (/LESS DEDUCTIONS/i.test(line) && amounts) {
        totalDeductions = amounts.current || amounts.ytd;
      }
      if (/AIPP PAYMENT/i.test(line) && amounts) {
        aippYtd += amounts.ytd;
      }
      if (/SCORECARD BONUS|SCOREBOARD BONUS/i.test(line) && amounts) {
        scoreboardYtd += amounts.ytd;
      }
    }
  }

  return { lineItems, netPayable, grossComp, totalDeductions, aippYtd, scoreboardYtd, paymentPeriodEnd };
}

// ---- Map company + description to comp_type / comp_category --------------
function classifyLine(company: string, description: string): { comp_type: string; comp_category: string } {
  const desc = description.toUpperCase();
  const co = company.toUpperCase();

  let comp_category = "other";
  if (co === "MUTL" || co === "FIRE") {
    if (/FIRE/.test(desc)) comp_category = "fire";
    else comp_category = "auto";
  } else if (co === "SFL") {
    comp_category = "life";
  } else if (co === "SFFL") {
    comp_category = "sffl";
  } else if (co === "GFA") {
    comp_category = "other";
  }

  let comp_type = "other";
  if (/NEW BUSINESS|FIRST YEAR|NEW -/.test(desc)) comp_type = "new_business";
  else if (/RENEWAL|SERVICING|SERVICE/.test(desc)) comp_type = "renewal";
  else if (/AIPP|SCORECARD|SCOREBOARD|S & T|CONTRIBUTION|CREDIT CARD/.test(desc)) comp_type = "other";

  return { comp_type, comp_category };
}

// ---- Main handler --------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);

  const gmailAccountId = await getSetting("composio_gmail_account_id");
  if (!gmailAccountId) return jsonResponse({ error: "composio_gmail_account_id not set in settings" }, 500);

  // Get all pending comp_recap documents
  const { data: pendingDocs, error: docsErr } = await sb
    .from("documents")
    .select("*")
    .eq("agency_id", AGENCY_ID)
    .eq("document_type", "comp_recap")
    .eq("processing_status", "pending")
    .order("period_year", { ascending: true })
    .order("period_month", { ascending: true })
    .order("period_half", { ascending: true });

  if (docsErr) return jsonResponse({ error: docsErr.message }, 500);
  if (!pendingDocs || pendingDocs.length === 0) return jsonResponse({ message: "No pending comp_recap documents", processed: 0 });

  console.log(`Processing ${pendingDocs.length} pending comp_recap PDFs...`);

  // On first run — wipe old bad comp_recap data and journal entries sourced from it
  const { data: existingBadData } = await sb.from("comp_recap").select("id", { count: "exact" }).eq("agency_id", AGENCY_ID).limit(1);
  if (existingBadData && existingBadData.length > 0) {
    console.log("Wiping old comp_recap data and related journal entries...");
    await sb.from("journal_entries").delete().eq("agency_id", AGENCY_ID).eq("source_table", "comp_recap");
    await sb.from("comp_recap").delete().eq("agency_id", AGENCY_ID);
    console.log("Old data wiped.");
  }

  let totalProcessed = 0;
  let totalFailed = 0;
  const results: Array<{ doc: string; status: string; rows?: number; error?: string }> = [];

  for (const doc of pendingDocs) {
    try {
      console.log(`Processing: ${doc.source_filename} (${doc.period_year}-${doc.period_month} ${doc.period_half})`);

      // Mark as processing
      await sb.from("documents").update({ processing_status: "processing" }).eq("id", doc.id);

      // Step 1: Get fresh attachment ID from Gmail
      const fetchResult = await callComposio(
        "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
        { message_id: doc.source_message_id, format: "full", user_id: "me" },
        gmailAccountId
      );

      if (!fetchResult.ok) throw new Error(`Gmail fetch failed: ${fetchResult.error}`);

      const msgData = fetchResult.data as Record<string, unknown>;
      const attachments = (msgData?.attachmentList as Array<Record<string, unknown>>) || [];
      const attachment = attachments.find((a) => a.filename === doc.source_filename);
      if (!attachment) throw new Error(`Attachment not found: ${doc.source_filename}`);

      // Step 2: Download the PDF
      const dlResult = await callComposio(
        "GMAIL_GET_ATTACHMENT",
        { message_id: doc.source_message_id, attachment_id: attachment.attachmentId, file_name: doc.source_filename, user_id: "me" },
        gmailAccountId
      );

      if (!dlResult.ok) throw new Error(`PDF download failed: ${dlResult.error}`);
      const dlData = dlResult.data as Record<string, unknown>;
      const fileData = dlData?.file as Record<string, unknown>;
      const pdfUrl = fileData?.s3url as string;
      if (!pdfUrl) throw new Error("No S3 URL returned for PDF");

      // Step 3: OCR the PDF
      const rawText = await ocrPdfFromUrl(pdfUrl);
      if (!rawText || rawText.length < 100) throw new Error("OCR returned insufficient text");

      // Step 4: Parse the text
      const parsed = parseCompRecapText(rawText, doc.period_year, doc.period_month, doc.period_half);

      // Step 5: Insert clean line items into comp_recap (no TOTAL rows)
      const compRecapRows = parsed.lineItems.map((item) => {
        const { comp_type, comp_category } = classifyLine(item.company, item.description);
        return {
          agency_id: AGENCY_ID,
          period_year: doc.period_year,
          period_month: doc.period_month,
          period_half: doc.period_half,
          comp_type,
          comp_category,
          description: item.description,
          amount: item.amount,
          ytd_amount: item.ytd,
          source_document_id: doc.id,
        };
      });

      // Also add net payable as a summary row for cash reconciliation
      if (parsed.netPayable > 0) {
        compRecapRows.push({
          agency_id: AGENCY_ID,
          period_year: doc.period_year,
          period_month: doc.period_month,
          period_half: doc.period_half,
          comp_type: "net_payable",
          comp_category: "summary",
          description: `Net Payable - ${doc.source_filename}`,
          amount: parsed.netPayable,
          ytd_amount: 0,
          source_document_id: doc.id,
        });
      }

      if (compRecapRows.length > 0) {
        const { error: insertErr } = await sb.from("comp_recap").insert(compRecapRows);
        if (insertErr) throw new Error(`comp_recap insert failed: ${insertErr.message}`);
      }

      // Step 6: Update document record with parsed summary
      await sb.from("documents").update({
        processing_status: "processed",
        processed_at: new Date().toISOString(),
        gross_comp: parsed.grossComp,
        net_payable: parsed.netPayable,
        total_deductions: parsed.totalDeductions,
        aipp_ytd: parsed.aippYtd,
        scoreboard_ytd: parsed.scoreboardYtd,
        records_created: compRecapRows.length,
        parsed_data: rawText.slice(0, 5000),
        notes: `Parsed ${parsed.lineItems.length} line items. Net payable: $${parsed.netPayable}. Gross: $${parsed.grossComp}. Deductions: $${parsed.totalDeductions}.`,
      }).eq("id", doc.id);

      totalProcessed++;
      results.push({ doc: doc.source_filename, status: "ok", rows: compRecapRows.length });
      console.log(`✅ ${doc.source_filename}: ${compRecapRows.length} rows, net payable $${parsed.netPayable}`);

      // Small delay to avoid rate limits
      await new Promise((r) => setTimeout(r, 500));

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ ${doc.source_filename}: ${msg}`);
      await sb.from("documents").update({
        processing_status: "failed",
        notes: `Error: ${msg.slice(0, 500)}`,
      }).eq("id", doc.id);
      totalFailed++;
      results.push({ doc: doc.source_filename, status: "failed", error: msg.slice(0, 200) });
    }
  }

  // Run GL Entry Writer on the fresh clean data
  if (totalProcessed > 0) {
    console.log("Running GL Entry Writer on clean data...");
    await sb.rpc("write_comp_recap_gl_entries", { p_agency_id: AGENCY_ID });
  }

  return jsonResponse({
    processed: totalProcessed,
    failed: totalFailed,
    total: pendingDocs.length,
    results,
  });
});
