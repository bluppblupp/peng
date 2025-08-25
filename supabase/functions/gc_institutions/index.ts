import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.0";

/** CORS */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, Authorization, x-client-info, apikey, content-type",
};

/** Allowed country codes (must match your UI) */
const ALLOWED_COUNTRIES = new Set([
  "SE", "NO", "DK", "FI", "GB", "DE", "NL", "FR", "ES", "IT", "IE", "PL",
]);

/** Simple in-memory cache (best-effort per warm instance) */
type Institution = { id: string; name: string };
type CacheEntry = { data: Institution[]; expires: number };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const institutionsCache = new Map<string, CacheEntry>();

/** Error helpers */
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  try { return typeof e === "string" ? e : JSON.stringify(e); } catch { return String(e); }
}
function errStack(e: unknown): string | undefined {
  return e instanceof Error ? e.stack : undefined;
}

/** Lightweight retry helper for 429/5xx */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  tries = 2,
  baseDelayMs = 300
): Promise<Response> {
  let attempt = 0;
  let lastBody = "";
  while (attempt <= tries) {
    const res = await fetch(url, init);
    if (res.ok) return res;

    lastBody = await res.text().catch(() => "");
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
      attempt++;
      continue;
    }
    return new Response(lastBody || "", { status: res.status });
  }
  return new Response(lastBody || "Upstream error after retries", { status: 502 });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const correlationId = crypto.randomUUID();

  try {
    const {
      GOCARDLESS_BASE_URL,
      GOCARDLESS_SECRET_ID,
      GOCARDLESS_SECRET_KEY,
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
    } = Deno.env.toObject();

    if (
      !GOCARDLESS_BASE_URL || !GOCARDLESS_SECRET_ID || !GOCARDLESS_SECRET_KEY ||
      !SUPABASE_URL || !SUPABASE_ANON_KEY
    ) {
      console.error("gc_institutions env missing", {
        correlationId,
        have: {
          GOCARDLESS_BASE_URL: !!GOCARDLESS_BASE_URL,
          GOCARDLESS_SECRET_ID: !!GOCARDLESS_SECRET_ID,
          GOCARDLESS_SECRET_KEY: !!GOCARDLESS_SECRET_KEY,
          SUPABASE_URL: !!SUPABASE_URL,
          SUPABASE_ANON_KEY: !!SUPABASE_ANON_KEY,
        },
      });
      return new Response(JSON.stringify({
        error: "Internal Server Error", code: "CONFIG_MISSING", correlationId,
      }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // --- Parse Bearer token from header and call getUser(token) explicitly ---
    const authHdr = req.headers.get("Authorization") || "";
    // Temporary diagnostics (remove when confirmed):
    console.log("gc_institutions Authorization present?", {
      has: !!authHdr,
      preview: authHdr ? authHdr.slice(0, 16) + "…" : "none",
    });
    const token = authHdr.startsWith("Bearer ") ? authHdr.slice(7) : "";

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      // Keeping global header is harmless, but the key change is passing token below.
      global: { headers: { Authorization: authHdr } },
      auth: { persistSession: false },
    });

    // ✅ Pass the token; do NOT rely on internal session in Edge Functions.
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({
        error: "Unauthorized", code: "AUTH_REQUIRED", correlationId,
      }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // --- Determine country (POST body > query param > default) ---
    let country = "SE";
    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (typeof body?.country === "string" && body.country.trim()) country = body.country.trim();
      } catch { /* ignore parse error */ }
    } else if (req.method === "GET") {
      const url = new URL(req.url);
      const qpCountry = url.searchParams.get("country");
      if (qpCountry) country = qpCountry;
    }

    // Validate country
    if (!ALLOWED_COUNTRIES.has(country)) {
      return new Response(JSON.stringify({
        error: "Bad Request", code: "INVALID_COUNTRY", correlationId,
      }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // Cache
    const now = Date.now();
    const cached = institutionsCache.get(country);
    if (cached && cached.expires > now) {
      return new Response(JSON.stringify(cached.data), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Get GoCardless access token (retry)
    const tokenRes = await fetchWithRetry(`${GOCARDLESS_BASE_URL}/token/new/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ secret_id: GOCARDLESS_SECRET_ID, secret_key: GOCARDLESS_SECRET_KEY }),
    }, 2);

    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      console.error("gc_institutions token error", {
        correlationId, status: tokenRes.status, bodySnippet: body.slice(0, 300), userId: user.id,
      });
      return new Response(JSON.stringify({
        error: "Bad Gateway", code: "UPSTREAM_TOKEN_ERROR", correlationId,
      }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const tokenJson = await tokenRes.json().catch(() => ({} as unknown));
    const accessToken = (tokenJson as { access?: string } | null)?.access ?? undefined;
    if (!accessToken) {
      console.error("gc_institutions token missing 'access'", {
        correlationId, tokenJsonSnippet: JSON.stringify(tokenJson).slice(0, 300), userId: user.id,
      });
      return new Response(JSON.stringify({
        error: "Bad Gateway", code: "UPSTREAM_TOKEN_MALFORMED", correlationId,
      }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // Fetch institutions (retry)
    const instRes = await fetchWithRetry(
      `${GOCARDLESS_BASE_URL}/institutions/?country=${encodeURIComponent(country)}`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
      2
    );

    if (!instRes.ok) {
      const body = await instRes.text().catch(() => "");
      console.error("gc_institutions upstream institutions error", {
        correlationId, status: instRes.status, bodySnippet: body.slice(0, 300), userId: user.id, country,
      });
      return new Response(JSON.stringify({
        error: "Bad Gateway", code: "UPSTREAM_INSTITUTIONS_ERROR", correlationId,
      }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // Map upstream payload to DTO
    const rawUnknown = await instRes.json().catch(() => null as unknown);
    let institutions: Institution[] = [];

    if (Array.isArray(rawUnknown)) {
      institutions = rawUnknown
        .map((r) =>
          r && typeof r === "object" && "id" in r && "name" in r
            ? { id: String((r as Record<string, unknown>).id), name: String((r as Record<string, unknown>).name) }
            : null
        )
        .filter((x): x is Institution => !!x && typeof x.id === "string" && typeof x.name === "string");
    } else if (
      rawUnknown && typeof rawUnknown === "object" &&
      Array.isArray((rawUnknown as Record<string, unknown>).results)
    ) {
      const results = (rawUnknown as Record<string, unknown>).results as unknown[];
      institutions = results
        .map((r) =>
          r && typeof r === "object" && "id" in r && "name" in r
            ? { id: String((r as Record<string, unknown>).id), name: String((r as Record<string, unknown>).name) }
            : null
        )
        .filter((x): x is Institution => !!x && typeof x.id === "string" && typeof x.name === "string");
    } else {
      console.error("gc_institutions unexpected upstream shape", {
        correlationId, userId: user.id, country, rawSnippet: JSON.stringify(rawUnknown).slice(0, 300),
      });
      return new Response(JSON.stringify({
        error: "Bad Gateway", code: "UPSTREAM_MALFORMED", correlationId,
      }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // Update cache & return
    institutionsCache.set(country, { data: institutions, expires: now + CACHE_TTL_MS });
    return new Response(JSON.stringify(institutions), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (e: unknown) {
    console.error("gc_institutions unhandled error", {
      correlationId, message: errMessage(e), stack: errStack(e),
    });
    return new Response(JSON.stringify({
      error: "Internal Server Error", code: "GC_INSTITUTIONS_FAILURE", correlationId,
    }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
  }
});
