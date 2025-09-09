import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/** CORS (inline, so preflight never imports anything heavy) */
function allow(req: Request) {
  const origin = req.headers.get("Origin") ?? "*";
  const acrh =
    req.headers.get("Access-Control-Request-Headers") ??
    "authorization, x-client-info, x-supabase-api-version, apikey, content-type";
  const acrm = req.headers.get("Access-Control-Request-Method") ?? "GET, POST, OPTIONS";
  return {
    "Access-Control-Allow-Origin": origin === "null" ? "*" : origin,
    "Access-Control-Allow-Headers": acrh,
    "Access-Control-Allow-Methods": acrm,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  };
}
function safeMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  try { return typeof e === "string" ? e : JSON.stringify(e); } catch { return String(e); }
}
function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
function getString(r: Record<string, unknown>, k: string): string | null {
  return typeof r[k] === "string" ? (r[k] as string) : null;
}

type Body = { country?: string };
type Institution = { id: string; name: string };

Deno.serve(async (req) => {
  // Fast CORS preflight
  if (req.method === "OPTIONS") return new Response("ok", { headers: allow(req) });

  const correlationId = crypto.randomUUID();
  console.log("gc_institutions start", {
    method: req.method,
    ua: (req.headers.get("User-Agent") || "").slice(0, 60),
    hasAuth: !!req.headers.get("Authorization"),
    correlationId,
  });

  try {
    if (req.method !== "GET" && req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed", code: "METHOD_NOT_ALLOWED", correlationId }), {
        status: 405, headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    // Defer heavy imports until after OPTIONS
    const { createClient } = await import("npm:@supabase/supabase-js@2.39.0");
    const shared = await import("../_shared/gc.ts");
    const { bearerFrom, normalizeBase, nint, newGcToken, gcFetchRaw } = shared;

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

    // Auth
    const token = bearerFrom(req);
    const supa = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data: { user } } = await supa.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized", code: "AUTH_REQUIRED", correlationId }), {
        status: 401, headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    // Inputs: GET ?country=XX or POST { country }
    let country = "SE";
    if (req.method === "GET") {
      country = new URL(req.url).searchParams.get("country") || "SE";
    } else {
      const raw = await req.text();
      if (raw) {
        try { country = (JSON.parse(raw) as Body).country || "SE"; } catch {/* ignore */ }
      }
    }

    // GC call
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
      ? json
          .map((r) => {
            if (!isRecord(r)) return null;
            const id = getString(r, "id");
            const name = getString(r, "name") || getString(r, "full_name") || getString(r, "official_name");
            return id && name ? { id, name } : null;
          })
          .filter((x): x is Institution => !!x)
      : [];

    return new Response(JSON.stringify(list), {
      status: 200, headers: { "content-type": "application/json", ...allow(req) },
    });
  } catch (e: unknown) {
    console.error("gc_institutions unhandled", { correlationId, message: safeMsg(e) });
    return new Response(JSON.stringify({
      error: "Internal Server Error", code: "GC_INSTITUTIONS_FAILURE", correlationId,
      details: { message: safeMsg(e) },
    }), { status: 500, headers: { "content-type": "application/json", ...allow(req) } });
  }
});
