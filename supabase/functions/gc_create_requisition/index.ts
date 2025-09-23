// supabase/functions/gc_create_requisition/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.39.0";
import {
  allow,
  bearerFrom,
  errMessage,
  normalizeBase,
  nint,
  newGcToken,
  gcFetchRaw,
  getString,
} from "../_shared/gc.ts";

/** Body expected from the client */
type CreateBody = {
  institution_id?: string;
  redirect_url?: string;
  bank_name?: string;
  country?: string; // optional; defaults to 'SE' if omitted
};

/** Row id shape for select-after-upsert */
type RowId = { id: string };

/** Required env config (no any) */
type Env = {
  GOCARDLESS_BASE_URL: string;
  GOCARDLESS_SECRET_ID: string;
  GOCARDLESS_SECRET_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  TIMEOUT_EUA_MS: number;
  TIMEOUT_REQUISITION_MS: number;
};

function jsonHeaders(req: Request): HeadersInit {
  return { "content-type": "application/json", ...allow(req) };
}

function parseUpstreamDown(bodyText: string): { summary?: string } {
  try {
    const obj = JSON.parse(bodyText) as Record<string, unknown>;
    const summary = typeof obj.summary === "string" ? obj.summary : undefined;
    return { summary };
  } catch {
    return {};
  }
}

Deno.serve(async (req: Request) => {
  const correlationId = crypto.randomUUID();

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: allow(req) });
  }

  console.log(
    "gc_create_requisition start",
    JSON.stringify({
      method: req.method,
      hasAuth: !!req.headers.get("Authorization"),
      ua: (req.headers.get("User-Agent") || "").slice(0, 60),
      correlationId,
    }),
  );

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method Not Allowed", code: "METHOD_NOT_ALLOWED", correlationId }),
        { status: 405, headers: jsonHeaders(req) },
      );
    }

    // ---- Env
    const rawEnv = Deno.env.toObject();
    let baseOk = true;
    try {
      new URL(rawEnv.GOCARDLESS_BASE_URL || "");
    } catch {
      baseOk = false;
    }

    if (
      !baseOk ||
      !rawEnv.GOCARDLESS_SECRET_ID ||
      !rawEnv.GOCARDLESS_SECRET_KEY ||
      !rawEnv.SUPABASE_URL ||
      !rawEnv.SUPABASE_ANON_KEY
    ) {
      return new Response(
        JSON.stringify({ error: "Internal Server Error", code: "CONFIG_MISSING", correlationId }),
        { status: 500, headers: jsonHeaders(req) },
      );
    }

    const env: Env = {
      GOCARDLESS_BASE_URL: normalizeBase(rawEnv.GOCARDLESS_BASE_URL!),
      GOCARDLESS_SECRET_ID: rawEnv.GOCARDLESS_SECRET_ID!,
      GOCARDLESS_SECRET_KEY: rawEnv.GOCARDLESS_SECRET_KEY!,
      SUPABASE_URL: rawEnv.SUPABASE_URL!,
      SUPABASE_ANON_KEY: rawEnv.SUPABASE_ANON_KEY!,
      TIMEOUT_EUA_MS: nint(rawEnv.GC_TIMEOUT_EUA_MS, 15_000),
      TIMEOUT_REQUISITION_MS: nint(rawEnv.GC_TIMEOUT_REQUISITION_MS, 20_000),
    };

    // ---- Auth
    const jwt = bearerFrom(req);
    const supa: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: jwt ? `Bearer ${jwt}` : "" } },
      auth: { persistSession: false },
    });

    const userWrap = await supa.auth.getUser(jwt);
    if (userWrap.error || !userWrap.data?.user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", code: "AUTH_REQUIRED", correlationId }),
        { status: 401, headers: jsonHeaders(req) },
      );
    }
    const userId = userWrap.data.user.id;

    // ---- Body
    const raw = await req.text();
    let body: CreateBody | null = null;
    try {
      body = raw ? (JSON.parse(raw) as CreateBody) : null;
    } catch {
      return new Response(
        JSON.stringify({ error: "Bad Request", code: "INVALID_JSON", correlationId }),
        { status: 400, headers: jsonHeaders(req) },
      );
    }

    const institution_id = (body?.institution_id || "").trim();
    const redirect_url = (body?.redirect_url || "").trim();
    const bank_name = (body?.bank_name || "Bank").trim();
    const country = (body?.country || "SE").trim().toUpperCase();

    if (!institution_id || !redirect_url) {
      return new Response(
        JSON.stringify({ error: "Bad Request", code: "MISSING_FIELDS", correlationId }),
        { status: 400, headers: jsonHeaders(req) },
      );
    }

    // ---- GoCardless access token
    const tokenHolder = { token: await newGcToken(env, correlationId) };
    const refresh = (cid: string) => newGcToken(env, cid);

    // ---- Create End-User Agreement (requires institution_id)
    const euaRes = await gcFetchRaw(
      env,
      tokenHolder,
      "agreements/enduser/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          institution_id,
          max_historical_days: 365,
          access_valid_for_days: 180,
          access_scope: ["balances", "details", "transactions"],
        }),
      },
      correlationId,
      env.TIMEOUT_EUA_MS,
      refresh,
    );

    if (!euaRes.ok) {
      const t = await euaRes.text().catch(() => "");
      if (euaRes.status === 503) {
        const { summary } = parseUpstreamDown(t);
        console.error(
          "gc_create_requisition upstream eua error",
          JSON.stringify({ correlationId, status: euaRes.status, bodySnippet: t.slice(0, 400) }),
        );
        return new Response(
          JSON.stringify({
            error: "Upstream institution down",
            code: "UPSTREAM_INSTITUTION_DOWN",
            correlationId,
            details: { status: euaRes.status, summary: summary ?? undefined },
          }),
          { status: 502, headers: jsonHeaders(req) },
        );
      }
      console.error(
        "gc_create_requisition upstream eua error",
        JSON.stringify({ correlationId, status: euaRes.status, bodySnippet: t.slice(0, 400) }),
      );
      return new Response(
        JSON.stringify({
          error: "Bad Gateway",
          code: "UPSTREAM_EUA_ERROR",
          correlationId,
          details: { status: euaRes.status, bodySnippet: t.slice(0, 400) },
        }),
        { status: 502, headers: jsonHeaders(req) },
      );
    }

    const euaJson = (await euaRes.json().catch(() => ({}))) as Record<string, unknown>;
    const euaId = getString(euaJson, "id");
    if (!euaId) {
      return new Response(
        JSON.stringify({ error: "Bad Gateway", code: "UPSTREAM_EUA_MALFORMED", correlationId }),
        { status: 502, headers: jsonHeaders(req) },
      );
    }

    // ---- Create requisition
    const rqRes = await gcFetchRaw(
      env,
      tokenHolder,
      "requisitions/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect: redirect_url,
          institution_id,
          agreement: euaId,
          user_language: "sv",
        }),
      },
      correlationId,
      env.TIMEOUT_REQUISITION_MS,
      refresh,
    );

    if (!rqRes.ok) {
      const t = await rqRes.text().catch(() => "");
      if (rqRes.status === 503) {
        const { summary } = parseUpstreamDown(t);
        console.error(
          "gc_create_requisition upstream requisition error",
          JSON.stringify({ correlationId, status: rqRes.status, bodySnippet: t.slice(0, 400) }),
        );
        return new Response(
          JSON.stringify({
            error: "Upstream institution down",
            code: "UPSTREAM_INSTITUTION_DOWN",
            correlationId,
            details: { status: rqRes.status, summary: summary ?? undefined },
          }),
          { status: 502, headers: jsonHeaders(req) },
        );
      }
      console.error(
        "gc_create_requisition upstream requisition error",
        JSON.stringify({ correlationId, status: rqRes.status, bodySnippet: t.slice(0, 400) }),
      );
      return new Response(
        JSON.stringify({
          error: "Bad Gateway",
          code: "UPSTREAM_REQUISITION_ERROR",
          correlationId,
          details: { status: rqRes.status, bodySnippet: t.slice(0, 400) },
        }),
        { status: 502, headers: jsonHeaders(req) },
      );
    }

    const rqJson = (await rqRes.json().catch(() => ({}))) as Record<string, unknown>;
    const requisitionId = getString(rqJson, "id");
    const link = getString(rqJson, "link");
    if (!requisitionId || !link) {
      return new Response(
        JSON.stringify({ error: "Bad Gateway", code: "UPSTREAM_REQUISITION_MALFORMED", correlationId }),
        { status: 502, headers: jsonHeaders(req) },
      );
    }

    // ---- DB upsert: connected_banks on (user_id, provider, link_id)
    // NOTE:
    //  - account_id is NOT known yet; real account rows are created in gc_complete.
    //  - If your schema still requires NOT NULL account_id, either relax it (recommended) or
    //    set a placeholder here (e.g., requisitionId). Code below assumes account_id is nullable.
   const upsertPayload = {
      user_id: userId,
      bank_name,
      account_id: requisitionId,     // temporary placeholder
      institution_id,
      is_active: true,
      provider: "gocardless",
      link_id: requisitionId,        // unique key piece
      country: "SE",
      status: "pending",
    };

    const { data: upData, error: upErr } = await supa
    .from("connected_banks")
    .upsert(upsertPayload, { onConflict: "user_id,provider,link_id" }) // <-- matches the index
    .select("id");

    let connectedBankId: string | null =
      Array.isArray(upData) && upData.length > 0 && typeof upData[0]?.id === "string"
        ? upData[0].id
        : null;

    // Fallback select if upsert+select didn’t return the row (RLS can sometimes block returning)
    if (!connectedBankId) {
      const { data: found, error: selErr } = await supa
        .from("connected_banks")
        .select("id")
        .eq("user_id", userId)
        .eq("provider", "gocardless")
        .eq("link_id", requisitionId)
        .maybeSingle<RowId>();

      if (selErr) {
        console.error(
          "gc_create_requisition select-after-upsert failed",
          JSON.stringify({
            correlationId,
            message: selErr.message,
            code: (selErr as { code?: string } | null)?.code,
            details: (selErr as { details?: unknown } | null)?.details,
            hint: (selErr as { hint?: string } | null)?.hint,
          }),
        );
      }
      connectedBankId = found?.id ?? null;
    }

    if (!connectedBankId) {
      console.error(
        "gc_create_requisition upsert failed",
        JSON.stringify({
          correlationId,
          message: upErr?.message ?? "no row returned after upsert/select",
          code: (upErr as { code?: string } | null)?.code,
          details: (upErr as { details?: unknown } | null)?.details,
          hint: (upErr as { hint?: string } | null)?.hint,
        }),
      );
      return new Response(
        JSON.stringify({
          error: "Database Error",
          code: "DB_UPSERT_FAILED",
          correlationId,
          details: { message: upErr?.message ?? "connected_banks upsert/select failed" },
        }),
        { status: 500, headers: jsonHeaders(req) },
      );
    }

    console.log(
      "gc_create_requisition success",
      JSON.stringify({ correlationId, userId, requisitionId, connectedBankId }),
    );

    return new Response(
      JSON.stringify({ link, requisition_id: requisitionId, connected_bank_id: connectedBankId }),
      { status: 200, headers: jsonHeaders(req) },
    );
  } catch (e: unknown) {
    console.error("gc_create_requisition unhandled", JSON.stringify({ correlationId, message: errMessage(e) }));
    return new Response(
      JSON.stringify({
        error: "Internal Server Error",
        code: "GC_CREATE_REQUISITION_FAILURE",
        correlationId,
        details: { message: errMessage(e) },
      }),
      { status: 500, headers: jsonHeaders(req) },
    );
  }
});