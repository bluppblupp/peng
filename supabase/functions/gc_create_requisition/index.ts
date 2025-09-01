// supabase/functions/gc_create_requisition/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.0";

/** CORS */
const allow = (req: Request) => ({
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    req.headers.get("access-control-request-headers") ??
    "authorization, Authorization, content-type, x-client-info, apikey",
  "access-control-allow-methods": "POST, OPTIONS",
  Vary: "Origin, Access-Control-Request-Headers",
});

/** Helpers */
const errMessage = (e: unknown) =>
  e instanceof Error ? e.message : (() => { try { return typeof e === "string" ? e : JSON.stringify(e); } catch { return String(e); } })();
const errStack = (e: unknown) => (e instanceof Error ? e.stack : undefined);
const bearerFrom = (req: Request) => {
  const hdr = req.headers.get("Authorization") || "";
  return hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
};
const joinUrl = (base: string, path: string) => {
  const b = base.endsWith("/") ? base : base + "/";
  const p = path.startsWith("/") ? path.slice(1) : path;
  return b + p;
};

/** Timed fetch + retry */
const DEFAULT_TIMEOUT_MS = 15000;
async function fetchTimed(url: string, init?: RequestInit, ms = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function fetchWithRetry(
  url: string,
  init: RequestInit | undefined,
  tries = 2,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  let attempt = 0;
  let lastBody = "";
  while (attempt <= tries) {
    const res = await fetchTimed(url, init, timeoutMs);
    if (res.ok) return res;
    lastBody = await res.text().catch(() => "");
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      attempt++;
      continue;
    }
    return new Response(lastBody || "", { status: res.status });
  }
  return new Response(lastBody || "Upstream error after retries", { status: 502 });
}

/** Types */
type CreateReqBody = {
  institution_id?: string;
  redirect_url?: string;
  bank_name?: string;
  country?: string;
};
type GcTokenJson = { access?: string };
type GcAgreement = { id: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: allow(req) });

  const correlationId = crypto.randomUUID();
  console.log("gc_create_requisition start", {
    method: req.method,
    ua: (req.headers.get("User-Agent") || "").slice(0, 60),
    correlationId,
  });

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed", code: "METHOD_NOT_ALLOWED", correlationId }), {
        status: 405,
        headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    const {
      GOCARDLESS_BASE_URL,
      GOCARDLESS_SECRET_ID,
      GOCARDLESS_SECRET_KEY,
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
    } = Deno.env.toObject();

    let baseOk = true;
    try { new URL(GOCARDLESS_BASE_URL || ""); } catch { baseOk = false; }
    if (!baseOk || !GOCARDLESS_SECRET_ID || !GOCARDLESS_SECRET_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.error("gc_create_requisition env missing/invalid", {
        correlationId,
        have: {
          GOCARDLESS_BASE_URL: !!GOCARDLESS_BASE_URL,
          GOCARDLESS_SECRET_ID: !!GOCARDLESS_SECRET_ID,
          GOCARDLESS_SECRET_KEY: !!GOCARDLESS_SECRET_KEY,
          SUPABASE_URL: !!SUPABASE_URL,
          SUPABASE_ANON_KEY: !!SUPABASE_ANON_KEY,
        },
      });
      return new Response(JSON.stringify({ error: "Internal Server Error", code: "CONFIG_MISSING", correlationId }), {
        status: 500,
        headers: { "content-type": "application/json", ...allow(req) },
      });
    }
    console.log("gc_create_requisition gate: env ok", { correlationId });

    // --- Auth
    const token = bearerFrom(req);
    console.log("gc_create_requisition gate: auth header", { hasAuth: !!token, correlationId });
    const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await supa.auth.getUser(token);
    if (authError || !user) {
      console.error("gc_create_requisition auth failed", { correlationId, authError: authError?.message });
      return new Response(JSON.stringify({ error: "Unauthorized", code: "AUTH_REQUIRED", correlationId }), {
        status: 401,
        headers: { "content-type": "application/json", ...allow(req) },
      });
    }
    console.log("gc_create_requisition gate: auth ok", { correlationId, userId: user.id });

    // --- Body
    const ct = req.headers.get("content-type") || "";
    const rawBody = await req.text();
    console.log("gc_create_requisition gate: body headers", {
      correlationId,
      contentType: ct,
      hasBody: rawBody.length > 0,
      preview: rawBody.slice(0, 80),
    });

    let parsed: unknown;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      console.error("gc_create_requisition bad json", { correlationId, rawPreview: rawBody.slice(0, 200) });
      return new Response(JSON.stringify({ error: "Bad Request", code: "INVALID_JSON", correlationId }), {
        status: 400,
        headers: { "content-type": "application/json", ...allow(req) },
      });
    }
    const { institution_id, redirect_url, bank_name, country }: CreateReqBody = (parsed as CreateReqBody) ?? {};
    console.log("gc_create_requisition gate: body fields", {
      correlationId,
      hasInstitution: !!institution_id,
      hasRedirect: !!redirect_url,
    });
    if (!institution_id || !redirect_url) {
      return new Response(JSON.stringify({ error: "Bad Request", code: "MISSING_FIELDS", correlationId }), {
        status: 400,
        headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    // Validate redirect URL is absolute
    try { new URL(redirect_url); } catch {
      return new Response(JSON.stringify({
        error: "Bad Request",
        code: "MISSING_FIELDS_REDIRECT",
        correlationId,
      }), { status: 400, headers: { "content-type": "application/json", ...allow(req) } });
    }

    // Accept-Language → user_language
    const acceptLang = (req.headers.get("accept-language") || "").split(",")[0]?.slice(0, 2) || "en";

    // --- Token exchange
    console.log("gc_create_requisition step: token/new", { correlationId });
    const tokenRes = await fetchWithRetry(
      joinUrl(GOCARDLESS_BASE_URL, "token/new/"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ secret_id: GOCARDLESS_SECRET_ID, secret_key: GOCARDLESS_SECRET_KEY }),
      },
      2,
      10_000
    );
    if (!tokenRes.ok) {
      const t = await tokenRes.text().catch(() => "");
      console.error("gc_create_requisition token error", {
        correlationId, status: tokenRes.status, bodySnippet: t.slice(0, 300), userId: user.id,
      });
      return new Response(JSON.stringify({
        error: "Bad Gateway",
        code: "UPSTREAM_TOKEN_ERROR",
        correlationId,
        details: { status: tokenRes.status, bodySnippet: t.slice(0, 300) },
      }), { status: 502, headers: { "content-type": "application/json", ...allow(req) } });
    }
    const tokenJson = (await tokenRes.json().catch(() => ({}))) as GcTokenJson;
    const accessToken = tokenJson.access ?? "";
    if (!accessToken) {
      console.error("gc_create_requisition token missing 'access'", {
        correlationId, tokenJsonSnippet: JSON.stringify(tokenJson).slice(0, 300), userId: user.id,
      });
      return new Response(JSON.stringify({
        error: "Bad Gateway", code: "UPSTREAM_TOKEN_MALFORMED", correlationId,
      }), { status: 502, headers: { "content-type": "application/json", ...allow(req) } });
    }

    // --- EUA (requires institution_id)
    console.log("gc_create_requisition step: agreements/enduser", { correlationId });
    const euaRes = await fetchWithRetry(
      joinUrl(GOCARDLESS_BASE_URL, "agreements/enduser/"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          institution_id,
          max_historical_days: 365,
          access_valid_for_days: 180,
          access_scope: ["balances", "details", "transactions"],
        }),
      },
      2,
      15_000
    );
    if (!euaRes.ok) {
      const text = await euaRes.text().catch(() => "");
      console.error("gc_create_requisition eua error", {
        correlationId, status: euaRes.status, bodySnippet: text.slice(0, 400), userId: user.id,
      });
      return new Response(JSON.stringify({
        error: "Bad Gateway",
        code: "UPSTREAM_EUA_ERROR",
        correlationId,
        details: { status: euaRes.status, bodySnippet: text.slice(0, 400) },
      }), { status: 502, headers: { "content-type": "application/json", ...allow(req) } });
    }
    const eua = (await euaRes.json().catch(() => ({}))) as GcAgreement;
    if (!eua?.id) {
      return new Response(JSON.stringify({ error: "Bad Gateway", code: "UPSTREAM_EUA_MALFORMED", correlationId }), {
        status: 502, headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    // --- Create requisition
    console.log("gc_create_requisition step: requisitions", { correlationId });
    const reqRes = await fetchWithRetry(
      joinUrl(GOCARDLESS_BASE_URL, "requisitions/"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          redirect: redirect_url,
          institution_id,
          agreement: eua.id,
          user_language: acceptLang,
          reference: crypto.randomUUID(),
        }),
      },
      2,
      20_000
    );
    if (!reqRes.ok) {
      const text = await reqRes.text().catch(() => "");
      console.error("gc_create_requisition upstream requisition error", {
        correlationId, status: reqRes.status, bodySnippet: text.slice(0, 500), userId: user.id, institution_id,
      });
      return new Response(JSON.stringify({
        error: "Bad Gateway",
        code: "UPSTREAM_REQUISITION_ERROR",
        correlationId,
        details: { status: reqRes.status, bodySnippet: text.slice(0, 500) },
      }), { status: 502, headers: { "content-type": "application/json", ...allow(req) } });
    }

    const rqJson = (await reqRes.json().catch(() => ({}))) as Record<string, unknown>;
    const link = typeof rqJson?.link === "string" ? rqJson.link : undefined;
    const requisitionId = typeof rqJson?.id === "string" ? rqJson.id : undefined;
    if (!link || !requisitionId) {
      console.error("gc_create_requisition missing link/id", {
        correlationId, userId: user.id, rqSnippet: JSON.stringify(rqJson).slice(0, 400),
      });
      return new Response(JSON.stringify({ error: "Bad Gateway", code: "UPSTREAM_MALFORMED", correlationId }), {
        status: 502, headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    // --- DB: UPSERT to avoid duplicate key on (user_id, account_id)
    // Use requisitionId as a temporary UNIQUE account_id (placeholder)
    console.log("gc_create_requisition step: DB upsert", { correlationId });
    const { data: cb, error } = await supa
      .from("connected_banks")
      .upsert(
        {
          user_id: user.id,
          bank_name: bank_name ?? "Bank",
          account_id: requisitionId,      // << placeholder to satisfy (user_id, account_id) uniqueness
          institution_id,
          is_active: true,
          provider: "gocardless",
          link_id: requisitionId,
          country: country ?? "SE",
          status: "pending",
        },
        { onConflict: "user_id,account_id" }
      )
      .select("id")
      .single();

    if (error) {
      console.error("gc_create_requisition DB upsert error", { correlationId, userId: user.id, msg: error.message });
      return new Response(JSON.stringify({ error: "Database Error", code: "DB_UPSERT_FAILED", correlationId }), {
        status: 500,
        headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    console.log("gc_create_requisition success", { correlationId, userId: user.id, requisitionId });
    return new Response(JSON.stringify({ link, requisition_id: requisitionId, connected_bank_id: cb.id }), {
      status: 200,
      headers: { "content-type": "application/json", ...allow(req) },
    });
  } catch (e: unknown) {
    const isAbort = e instanceof Error && e.name === "AbortError";
    console.error("gc_create_requisition unhandled error", {
      correlationId,
      aborted: isAbort,
      message: errMessage(e),
      stack: errStack(e),
    });
    return new Response(
      JSON.stringify({ error: "Internal Server Error", code: "GC_CREATE_REQUISITION_FAILURE", correlationId }),
      { status: 500, headers: { "content-type": "application/json", ...allow(req) } }
    );
  }
});
