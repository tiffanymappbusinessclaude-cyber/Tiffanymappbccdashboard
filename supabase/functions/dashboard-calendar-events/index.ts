// =========================================================================
// dashboard-calendar-events
// =========================================================================
// PURPOSE: On-demand Google Calendar fetch for the BCC Dashboard "Upcoming
//   Events" widget. Returns events from now through the next 7 days.
//   Called by the webapp on Dashboard mount (verify_jwt=true).
// CACHE: 60-second module-scoped TTL. Repeat Dashboard loads within 60s
//   for the same agency+limit+days_ahead serve from memory; protects
//   Calendar API quota.
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

// Try multiple Composio tool slugs (the naming varies between Composio versions)
const CANDIDATE_TOOLS = [
  "GOOGLECALENDAR_EVENTS_LIST",
  "GOOGLECALENDAR_LIST_EVENTS",
  "GOOGLECALENDAR_FIND_EVENT",
];

async function callCalendar(
  apiKey: string,
  userId: string,
  acctId: string,
  args: Record<string, any>,
): Promise<{ data: any; usedSlug: string | null; error: string | null }> {
  for (const slug of CANDIDATE_TOOLS) {
    const res = await fetch(`${COMPOSIO_BASE}/${slug}`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: userId,
        connected_account_id: acctId,
        arguments: args,
      }),
    });
    const text = await res.text();
    let parsed: any = {};
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (res.ok && parsed?.successful) {
      return { data: parsed?.data?.response_data ?? parsed?.data ?? {}, usedSlug: slug, error: null };
    }
    const errMsg = (parsed?.error?.message || parsed?.error || text.slice(0, 200)).toString().toLowerCase();
    if (res.status === 404 || errMsg.includes("not found") || errMsg.includes("unknown tool")) {
      continue;
    }
    return { data: null, usedSlug: slug, error: parsed?.error?.message || parsed?.error || text.slice(0, 300) };
  }
  return { data: null, usedSlug: null, error: "No matching Google Calendar tool slug worked" };
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

  const limit = Math.min(Math.max(parseInt(body.limit) || 8, 1), 25);
  const daysAhead = Math.min(Math.max(parseInt(body.days_ahead) || 7, 1), 30);
  const bypassCache = body.bypass_cache === true;

  // Cache check
  const cacheKey = `calendar:${agencyId}:${limit}:${daysAhead}`;
  if (!bypassCache) {
    const hit = cacheGet(cacheKey);
    if (hit) {
      return jsonResponse({ ...hit, cached: true, cache_ttl_ms: CACHE_TTL_MS });
    }
  }

  const apiKey = await getSetting(agencyId, "composio_api_key");
  const userId = await getSetting(agencyId, "composio_user_id");
  const acctId = await getSetting(agencyId, "composio_googlecalendar_account_id");
  if (!apiKey || !userId || !acctId) {
    return jsonResponse({
      ok: false,
      error: "Missing Composio Google Calendar credentials in settings",
    }, 500);
  }

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data, usedSlug, error } = await callCalendar(apiKey, userId, acctId, {
      calendar_id: "primary",
      time_min: timeMin,
      time_max: timeMax,
      max_results: limit,
      single_events: true,
      order_by: "startTime",
      timeMin,
      timeMax,
      maxResults: limit,
      singleEvents: true,
      orderBy: "startTime",
      calendarId: "primary",
    });

    if (error) {
      return jsonResponse({ ok: false, error: `Calendar fetch failed: ${error}`, usedSlug }, 500);
    }

    const rawItems = Array.isArray(data?.items) ? data.items
      : Array.isArray(data?.events) ? data.events
      : Array.isArray(data) ? data
      : [];

    const events = rawItems.map((e: any) => {
      const startObj = e.start || {};
      const endObj = e.end || {};
      const startStr = startObj.dateTime || startObj.date || e.start_time || e.startTime || null;
      const endStr = endObj.dateTime || endObj.date || e.end_time || e.endTime || null;
      const isAllDay = !!(startObj.date && !startObj.dateTime);
      const start = startStr ? new Date(startStr) : null;
      const end = endStr ? new Date(endStr) : null;
      const durationMin = (start && end) ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000)) : null;

      return {
        id: e.id || e.eventId,
        title: (e.summary || e.title || "(no title)").slice(0, 100),
        location: (e.location || "").slice(0, 80),
        start: startStr,
        end: endStr,
        is_all_day: isAllDay,
        duration_min: durationMin,
        html_link: e.htmlLink || e.html_link || null,
        attendee_count: Array.isArray(e.attendees) ? e.attendees.length : 0,
      };
    }).filter((e: any) => e.start);

    const payload = {
      ok: true,
      count: events.length,
      fetched_at: new Date().toISOString(),
      window_start: timeMin,
      window_end: timeMax,
      tool_slug_used: usedSlug,
      events,
    };
    cacheSet(cacheKey, payload);
    return jsonResponse({ ...payload, cached: false, cache_ttl_ms: CACHE_TTL_MS });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ ok: false, error: `Unexpected: ${msg}` }, 500);
  }
});
