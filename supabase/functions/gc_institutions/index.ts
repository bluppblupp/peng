// supabase/functions/gc_institutions/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.0";
import {
  allow, bearerFrom, errMessage,
  normalizeBase, nint, newGcToken, gcFetchRaw, isRecord, getString
} from "../_shared/gc.ts";

type Institution = { id: string; name: string };
type Body = { country?: string };

Deno.serve(async (req) => {
  
  const correlationId = crypto.randomUUID();

  // ✅ req is in scope here
  if (req.method === "OPTIONS") return new Response("ok", { headers: allow(req) });
  console.log("gc_institutions start", {
    method: req.method,
    hasAuth: !!req.headers.get("Authorization"),
    ua: (req.headers.get("User-Agent") || "").slice(0, 60),
    correlationId,
  });

  try {
    if (req.method !== "GET" && req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed", code: "METHOD_NOT_ALLOWED", correlationId }), {
        status: 405, headers: { "content-type": "application/json", ...allow(req) },
      });
    }
    // Env
    const rawEnv = Deno.env.toObject();
    let baseOk = true;
    try { new URL(rawEnv.GOCARDLESS_BASE_URL || ""); } catch { baseOk = false; }
    if (!baseOk || !rawEnv.GOCARDLESS_SECRET_ID || !rawEnv.GOCARDLESS_SECRET_KEY || !rawEnv.SUPABASE_URL || !rawEnv.SUPABASE_ANON_KEY) {
      return new Response(JSON.stringify({ error: "Internal Server Error", code: "CONFIG_MISSING", correlationId }), {
        status: 500, headers: { "content-type": "application/json", ...allow(req) },
      });
    }
    const env = {
      GOCARDLESS_BASE_URL: normalizeBase(rawEnv.GOCARDLESS_BASE_URL!),
      GOCARDLESS_SECRET_ID: rawEnv.GOCARDLESS_SECRET_ID!,
      GOCARDLESS_SECRET_KEY: rawEnv.GOCARDLESS_SECRET_KEY!,
      SUPABASE_URL: rawEnv.SUPABASE_URL!,
      SUPABASE_ANON_KEY: rawEnv.SUPABASE_ANON_KEY!,
      TIMEOUT_TOKEN_MS: nint(rawEnv.GC_TIMEOUT_TOKEN_MS, 10_000),
    };

    // Auth (Supabase)
    const token = bearerFrom(req);
    const supa = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await supa.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized", code: "AUTH_REQUIRED", correlationId }), {
        status: 401, headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    const country = new URL(req.url).searchParams.get("country") || "SE";

    // GoCardless call
    const tokenHolder = { token: await newGcToken(env, correlationId) };
    const refresh = (cid: string) => newGcToken(env, cid);

    const res = await gcFetchRaw(
      env, tokenHolder,
      `institutions/?country=${encodeURIComponent(country)}`,
      { method: "GET" },
      correlationId,
      12_000,
      refresh
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return new Response(JSON.stringify({
        error: "Bad Gateway", code: "UPSTREAM_INSTITUTIONS_ERROR", correlationId,
        details: { status: res.status, bodySnippet: body.slice(0, 400) },
      }), { status: 502, headers: { "content-type": "application/json", ...allow(req) } });
    }

    const json = (await res.json().catch(() => ([]))) as unknown;
    const list: Institution[] = Array.isArray(json)
      ? (json as unknown[]).map((r) => {
          const id = isRecord(r) ? getString(r, "id") : null;
          const name = isRecord(r) ? (getString(r, "name") || getString(r, "full_name") || getString(r, "official_name")) : null;
          if (id && name) return { id, name };
          return null;
        }).filter((x): x is Institution => !!x)
      : [];

    return new Response(JSON.stringify(list), {
      status: 200, headers: { "content-type": "application/json", ...allow(req) },
    });
  } catch (e: unknown) {
    console.error("gc_institutions unhandled", { correlationId, message: errMessage(e) });
    return new Response(JSON.stringify({
      error: "Internal Server Error", code: "GC_INSTITUTIONS_FAILURE", correlationId,
      details: { message: errMessage(e) },
    }), { status: 500, headers: { "content-type": "application/json", ...allow(req) } });
  }
});
