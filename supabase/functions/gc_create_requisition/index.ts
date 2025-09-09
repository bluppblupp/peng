// supabase/functions/gc_create_requisition/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.0";
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

type CreateBody = { institution_id?: string; redirect_url?: string; bank_name?: string };

Deno.serve(async (req) => {
  const correlationId = crypto.randomUUID();

  if (req.method === "OPTIONS") return new Response("ok", { headers: allow(req) });

  console.log("gc_create_requisition start", {
    method: req.method,
    hasAuth: !!req.headers.get("Authorization"),
    ua: (req.headers.get("User-Agent") || "").slice(0, 60),
    correlationId,
  });

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method Not Allowed", code: "METHOD_NOT_ALLOWED", correlationId }),
        { status: 405, headers: { "content-type": "application/json", ...allow(req) } },
      );
    }

    // ---- Env
    const rawEnv = Deno.env.toObject();
    let baseOk = true;
    try { new URL(rawEnv.GOCARDLESS_BASE_URL || ""); } catch { baseOk = false; }
    if (!baseOk || !rawEnv.GOCARDLESS_SECRET_ID || !rawEnv.GOCARDLESS_SECRET_KEY || !rawEnv.SUPABASE_URL || !rawEnv.SUPABASE_ANON_KEY) {
      return new Response(
        JSON.stringify({ error: "Internal Server Error", code: "CONFIG_MISSING", correlationId }),
        { status: 500, headers: { "content-type": "application/json", ...allow(req) } },
      );
    }

    const env = {
      GOCARDLESS_BASE_URL: normalizeBase(rawEnv.GOCARDLESS_BASE_URL!),
      GOCARDLESS_SECRET_ID: rawEnv.GOCARDLESS_SECRET_ID!,
      GOCARDLESS_SECRET_KEY: rawEnv.GOCARDLESS_SECRET_KEY!,
      SUPABASE_URL: rawEnv.SUPABASE_URL!,
      SUPABASE_ANON_KEY: rawEnv.SUPABASE_ANON_KEY!,
      TIMEOUT_EUA_MS: nint(rawEnv.GC_TIMEOUT_EUA_MS, 15_000),
      TIMEOUT_REQUISITION_MS: nint(rawEnv.GC_TIMEOUT_REQUISITION_MS, 20_000),
    };

    // ---- Auth
    const token = bearerFrom(req);
    const supa = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: token ? `Bearer ${token}` : "" } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await supa.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", code: "AUTH_REQUIRED", correlationId }),
        { status: 401, headers: { "content-type": "application/json", ...allow(req) } },
      );
    }

    // ---- Body
    const raw = await req.text();
    let body: CreateBody | null = null;
    try { body = raw ? (JSON.parse(raw) as CreateBody) : null; } catch {
      return new Response(
        JSON.stringify({ error: "Bad Request", code: "INVALID_JSON", correlationId }),
        { status: 400, headers: { "content-type": "application/json", ...allow(req) } },
      );
    }
    const institution_id = (body?.institution_id || "").trim();
    const redirect_url = (body?.redirect_url || "").trim();
    const bank_name = (body?.bank_name || "Bank").trim();
    if (!institution_id || !redirect_url) {
      return new Response(
        JSON.stringify({ error: "Bad Request", code: "MISSING_FIELDS", correlationId }),
        { status: 400, headers: { "content-type": "application/json", ...allow(req) } },
      );
    }

    // ---- GoCardless access token
    const tokenHolder = { token: await newGcToken(env, correlationId) };

    // ---- Create End-User Agreement (✅ include institution_id)
    const euaRes = await gcFetchRaw(
      env,
      tokenHolder,
      "agreements/enduser/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          institution_id,                 // <-- required by BAD
          max_historical_days: 365,
          access_valid_for_days: 180,
          access_scope: ["balances", "details", "transactions"],
        }),
      },
      correlationId,
      env.TIMEOUT_EUA_MS!,
      (cid) => newGcToken(env, cid),
    );

    if (!euaRes.ok) {
      const t = await euaRes.text().catch(() => "");
      console.error("gc_create_requisition upstream eua error", {
        correlationId, status: euaRes.status, bodySnippet: t.slice(0, 400),
      });
      return new Response(
        JSON.stringify({
          error: "Bad Gateway",
          code: "UPSTREAM_EUA_ERROR",
          correlationId,
          details: { status: euaRes.status, bodySnippet: t.slice(0, 400) },
        }),
        { status: 502, headers: { "content-type": "application/json", ...allow(req) } },
      );
    }

    const euaJson = (await euaRes.json().catch(() => ({}))) as Record<string, unknown>;
    const euaId = getString(euaJson, "id");
    if (!euaId) {
      return new Response(
        JSON.stringify({ error: "Bad Gateway", code: "UPSTREAM_EUA_MALFORMED", correlationId }),
        { status: 502, headers: { "content-type": "application/json", ...allow(req) } },
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
      env.TIMEOUT_REQUISITION_MS!,
      (cid) => newGcToken(env, cid),
    );

    if (!rqRes.ok) {
      const t = await rqRes.text().catch(() => "");
      console.error("gc_create_requisition upstream requisition error", {
        correlationId, status: rqRes.status, bodySnippet: t.slice(0, 400),
      });
      return new Response(
        JSON.stringify({
          error: "Bad Gateway",
          code: "UPSTREAM_REQUISITION_ERROR",
          correlationId,
          details: { status: rqRes.status, bodySnippet: t.slice(0, 400) },
        }),
        { status: 502, headers: { "content-type": "application/json", ...allow(req) } },
      );
    }

    const rqJson = (await rqRes.json().catch(() => ({}))) as Record<string, unknown>;
    const requisitionId = getString(rqJson, "id");
    const link = getString(rqJson, "link");
    if (!requisitionId || !link) {
      return new Response(
        JSON.stringify({ error: "Bad Gateway", code: "UPSTREAM_REQUISITION_MALFORMED", correlationId }),
        { status: 502, headers: { "content-type": "application/json", ...allow(req) } },
      );
    }

    // ---- DB upsert: connected_banks (account_id placeholder = requisitionId)
    const { data: cbRow, error: cbErr } = await supa
      .from("connected_banks")
      .upsert(
        {
          user_id: user.id,
          bank_name,
          account_id: requisitionId, // unique per user (matches unique(user_id,account_id))
          institution_id,
          is_active: true,
          provider: "gocardless",
          link_id: requisitionId,
          country: "SE",
          status: "pending",
        },
        { onConflict: "user_id,account_id" },
      )
      .select("id")
      .single();

    if (cbErr || !cbRow?.id) {
      console.error("gc_create_requisition db upsert failed", {
        correlationId,
        error: cbErr?.message || "unknown",
      });
      return new Response(
        JSON.stringify({ error: "Database Error", code: "DB_UPSERT_FAILED", correlationId }),
        { status: 500, headers: { "content-type": "application/json", ...allow(req) } },
      );
    }

    console.log("gc_create_requisition success", {
      correlationId, userId: user.id, requisitionId, connectedBankId: cbRow.id,
    });

    return new Response(
      JSON.stringify({ link, requisition_id: requisitionId, connected_bank_id: cbRow.id }),
      { status: 200, headers: { "content-type": "application/json", ...allow(req) } },
    );
  } catch (e: unknown) {
    console.error("gc_create_requisition unhandled", { correlationId, message: errMessage(e) });
    return new Response(
      JSON.stringify({
        error: "Internal Server Error",
        code: "GC_CREATE_REQUISITION_FAILURE",
        correlationId,
        details: { message: errMessage(e) },
      }),
      { status: 500, headers: { "content-type": "application/json", ...allow(req) } },
    );
  }
});
