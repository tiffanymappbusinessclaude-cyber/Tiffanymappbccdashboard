// =========================================================================
// dashboard-emails-needing-attention
// =========================================================================
// PURPOSE: On-demand Gmail fetch for the BCC Dashboard "Emails Needing
//   Attention" widget. Returns a small list of unread + unlabeled + recent
//   emails the agent should see. NOT scheduled — called by the webapp on
//   Dashboard mount.
// CACHE: 60-second module-scoped TTL. Repeat Dashboard loads within 60s
//   for the same agency+limit serve from memory; protects Gmail API quota.
//   Cache survives within a hot Deno instance; cold starts naturally reset it.
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

// ─── Response cache (module-scoped) ───────────────────────────────────
const CACHE_TTL_MS = 60_000;
type CacheEntry = { expiresAt: number; payload: any };
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): any | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.payload;
}

function cacheSet(key: string, payload: any): void {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
  // Light cleanup: if map grows beyond 50 entries, sweep expired.
  if (cache.size > 50) {
    const now = Date.now();
    for (const [k, v] of cache.entries()) {
      if (now > v.expiresAt) cache.delete(k);
    }
  }
}

async function getSetting(agencyId: string, key: string): Promise<string | null> {
  const { data } = await sb
    .from("settings")
    .select("setting_value")
    .eq("agency_id", agencyId)
    .eq("setting_key", key)
    .maybeSingle();
  return data?.setting_value ?? null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  let body: any = {};
  try {
    const txt = await req.text();
    body = txt ? JSON.parse(txt) : {};
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const agencyId: string | undefined = body.agency_id;
  if (!agencyId) {
    return jsonResponse({ ok: false, error: "Missing agency_id" }, 400);
  }

  const limit = Math.min(Math.max(parseInt(body.limit) || 8, 1), 20);
  const bypassCache = body.bypass_cache === true;

  // Cache check
  const cacheKey = `emails:${agencyId}:${limit}`;
  if (!bypassCache) {
    const hit = cacheGet(cacheKey);
    if (hit) {
      return jsonResponse({ ...hit, cached: true, cache_ttl_ms: CACHE_TTL_MS });
    }
  }

  const apiKey = await getSetting(agencyId, "composio_api_key");
  const userId = await getSetting(agencyId, "composio_user_id");
  const acctId = await getSetting(agencyId, "composio_gmail_account_id");
  if (!apiKey || !userId || !acctId) {
    return jsonResponse({
      ok: false,
      error: "Missing Composio Gmail credentials in settings",
    }, 500);
  }

  const query = [
    "is:unread",
    "-label:BCC/Processed",
    "in:inbox",
    "newer_than:7d",
    "-from:noreply@supabase.io",
    "-from:no-reply@vercel.com",
    "-from:noreply@github.com",
    "-from:no-reply@accounts.google.com",
    "-subject:(security alert)",
  ].join(" ");

  try {
    const gmailRes = await fetch(`${COMPOSIO_BASE}/GMAIL_FETCH_EMAILS`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: userId,
        connected_account_id: acctId,
        arguments: {
          user_id: "me",
          query,
          max_results: limit,
        },
      }),
    });
    const text = await gmailRes.text();
    let parsed: any = {};
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!gmailRes.ok || !parsed?.successful) {
      const err = parsed?.error?.message || parsed?.error || text.slice(0, 300);
      return jsonResponse({ ok: false, error: `Gmail fetch failed: ${err}` }, 500);
    }

    const raw = parsed?.data?.response_data ?? parsed?.data ?? {};
    const rawMsgs = Array.isArray(raw?.messages) ? raw.messages : [];

    const now = Date.now();
    const messages = rawMsgs.map((m: any) => {
      let received: Date;
      if (m.internalDate) {
        received = new Date(parseInt(m.internalDate));
      } else if (m.date) {
        received = new Date(m.date);
      } else {
        received = new Date();
      }
      const ageHours = Math.max(0, Math.round((now - received.getTime()) / (1000 * 60 * 60)));

      const sender: string = m.sender || m.from || "Unknown";
      const senderMatch = sender.match(/^([^<]+?)\s*<([^>]+)>$/);
      const displayFrom = senderMatch
        ? (senderMatch[1].replace(/^["']|["']$/g, "").trim() || senderMatch[2])
        : sender;

      const labels: string[] = Array.isArray(m.labelIds) ? m.labelIds : [];
      const hasAttachment = labels.includes("HAS_ATTACHMENT") ||
        !!(m.payload?.parts?.some?.((p: any) => p.filename && p.filename.length > 0));

      return {
        id: m.messageId || m.id,
        thread_id: m.threadId,
        sender: displayFrom,
        subject: (m.subject || "(no subject)").slice(0, 120),
        snippet: (m.preview?.body || m.snippet || "").slice(0, 140),
        received_at: received.toISOString(),
        age_hours: ageHours,
        has_attachment: hasAttachment,
      };
    });

    const payload = {
      ok: true,
      count: messages.length,
      fetched_at: new Date().toISOString(),
      messages,
    };
    cacheSet(cacheKey, payload);
    return jsonResponse({ ...payload, cached: false, cache_ttl_ms: CACHE_TTL_MS });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ ok: false, error: `Unexpected: ${msg}` }, 500);
  }
});
