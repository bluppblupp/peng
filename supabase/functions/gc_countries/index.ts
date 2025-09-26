// supabase/functions/gc_countries/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.39.0";
import { allow, bearerFrom, errMessage } from "../_shared/gc.ts";

type Env = {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  GC_SUPPORTED_COUNTRIES?: string; // optional, comma-separated ISO codes
};

function jsonHeaders(req: Request): HeadersInit {
  // Small cache to avoid hammering (safe: static list)
  return {
    "content-type": "application/json",
    "cache-control": "public, max-age=3600",
    ...allow(req),
  };
}

function parseCountryList(raw: string | undefined): string[] {
  if (!raw) return [];
  const uniq = new Set<string>();
  for (const part of raw.split(",")) {
    const code = part.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) uniq.add(code);
  }
  return Array.from(uniq);
}

// Sensible default if env not provided
const FALLBACK = ["SE", "NO", "DK", "FI", "GB", "DE", "NL", "FR", "ES", "IT", "IE", "PL"];

Deno.serve(async (req) => {
  const correlationId = crypto.randomUUID();

  // CORS preflight
  if (req.method === "OPTIONS") return new Response("ok", { headers: allow(req) });

  try {
    if (req.method !== "GET" && req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method Not Allowed", code: "METHOD_NOT_ALLOWED", correlationId }),
        { status: 405, headers: jsonHeaders(req) },
      );
    }

    // Env
    const rawEnv = Deno.env.toObject();
    const env: Env = {
      SUPABASE_URL: rawEnv.SUPABASE_URL!,
      SUPABASE_ANON_KEY: rawEnv.SUPABASE_ANON_KEY!,
      GC_SUPPORTED_COUNTRIES: rawEnv.GC_SUPPORTED_COUNTRIES,
    };

    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      return new Response(
        JSON.stringify({ error: "Internal Server Error", code: "CONFIG_MISSING", correlationId }),
        { status: 500, headers: jsonHeaders(req) },
      );
    }

    // Auth (keep consistent with other endpoints)
    const jwt = bearerFrom(req);
    const supa: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: jwt ? `Bearer ${jwt}` : "" } },
      auth: { persistSession: false },
    });
    const { data: userWrap, error: userErr } = await supa.auth.getUser(jwt);
    if (userErr || !userWrap?.user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", code: "AUTH_REQUIRED", correlationId }),
        { status: 401, headers: jsonHeaders(req) },
      );
    }

    // Build list
    const envList = parseCountryList(env.GC_SUPPORTED_COUNTRIES);
    const countries = envList.length > 0 ? envList : FALLBACK;

    return new Response(
      JSON.stringify({ countries, correlationId }),
      { status: 200, headers: jsonHeaders(req) },
    );
  } catch (e: unknown) {
    return new Response(
      JSON.stringify({
        error: "Internal Server Error",
        code: "GC_COUNTRIES_FAILURE",
        correlationId,
        details: { message: errMessage(e) },
      }),
      { status: 500, headers: jsonHeaders(req) },
    );
  }
});
