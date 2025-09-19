// supabase/functions/_shared/gc.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/** CORS (lenient; tighten Origin in prod) */
export const allow = (req: Request): Record<string, string> => ({
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    req.headers.get("access-control-request-headers") ??
    "authorization, Authorization, content-type, x-client-info, apikey",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  Vary: "Origin, Access-Control-Request-Headers",
});

/** Small utils (no any) */
export const bearerFrom = (req: Request): string => {
  const hdr = req.headers.get("Authorization") || "";
  return hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
};

export const errMessage = (e: unknown): string =>
  e instanceof Error
    ? e.message
    : (() => {
        try {
          return typeof e === "string" ? e : JSON.stringify(e);
        } catch {
          return String(e);
        }
      })();

export function normalizeBase(input: string): string {
  const base = (input || "").trim().replace(/\/+$/, "");
  if (/\/api\/v2$/i.test(base)) return base;
  if (/\/api$/i.test(base)) return base + "/v2";
  return base + "/api/v2";
}

export function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base : base + "/";
  const p = path.startsWith("/") ? path.slice(1) : path;
  return b + p;
}

export function nint(v: string | undefined, def: number): number {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Timed fetch */
const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchTimed(
  url: string,
  init?: RequestInit,
  ms: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Safe JSON helpers */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export function getString(o: unknown, key: string): string | null {
  if (!isRecord(o)) return null;
  const v = o[key];
  return typeof v === "string" ? v : null;
}

export function getNumber(o: unknown, key: string): number | null {
  if (!isRecord(o)) return null;
  const v = o[key];
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
export function getStringArray(o: unknown, key: string): string[] | null {
  if (!isRecord(o)) return null;
  const v = o[key];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) if (typeof item === "string" && item.trim()) out.push(item.trim());
  return out.length ? out : null;
}


/** Env + token + upstream */
export type Env = {
  GOCARDLESS_BASE_URL: string;
  GOCARDLESS_SECRET_ID: string;
  GOCARDLESS_SECRET_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;

  /** Optional: if unset, we fall back to DEFAULT_TIMEOUT_MS */
  TIMEOUT_TOKEN_MS?: number;

  /** Optional knobs used by callers */
  TIMEOUT_EUA_MS?: number;
  TIMEOUT_REQUISITION_MS?: number;
  TIMEOUT_ACCT_MS?: number;
  TIMEOUT_TX_MS?: number;
};

export type TokenHolder = { token: string };

/** Acquire short-lived GoCardless token (with safe timeout fallback) */
export async function newGcToken(env: Env, correlationId: string): Promise<string> {
  const res = await fetchTimed(
    joinUrl(env.GOCARDLESS_BASE_URL, "token/new/"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        secret_id: env.GOCARDLESS_SECRET_ID,
        secret_key: env.GOCARDLESS_SECRET_KEY,
      }),
    },
    env.TIMEOUT_TOKEN_MS ?? DEFAULT_TIMEOUT_MS
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GC_TOKEN_ERROR ${res.status} ${t.slice(0, 300)} (${correlationId})`);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const access = getString(json, "access");
  if (!access) throw new Error(`GC_TOKEN_MALFORMED (${correlationId})`);
  return access;
}

/** Merge headers robustly across Headers/arrays/plain objects */
function mergeHeaders(...parts: (HeadersInit | undefined)[]): Headers {
  const h = new Headers();
  for (const p of parts) {
    if (!p) continue;
    const iter = new Headers(p);
    iter.forEach((value, key) => h.set(key, value));
  }
  return h;
}

/**
 * gcFetchRaw:
 *  - Adds Authorization: Bearer <tokenHolder.token>
 *  - On 401: refresh token once and retry
 *  - On 429/5xx: one backoff retry (honors Retry-After seconds)
 */
export async function gcFetchRaw(
  env: Env,
  tokenHolder: TokenHolder,
  path: string,
  init: RequestInit,
  correlationId: string,
  timeoutMs: number,
  tokenRefresh: (cid: string) => Promise<string>
): Promise<Response> {
  const url = /^https?:\/\//i.test(path) ? path : joinUrl(env.GOCARDLESS_BASE_URL, path);

  const doFetch = async (): Promise<Response> => {
    const headers = mergeHeaders(
      { Accept: "application/json" },
      init.headers,
      { Authorization: `Bearer ${tokenHolder.token}` }
    );
    return fetchTimed(url, { ...init, headers }, timeoutMs ?? DEFAULT_TIMEOUT_MS);
  };

  let res = await doFetch();
  if (res.ok) return res;

  if (res.status === 401) {
    try {
      tokenHolder.token = await tokenRefresh(correlationId);
    } catch {
      return res; // bubble original 401
    }
    res = await doFetch();
    if (res.ok) return res;
  }

  if (res.status === 429 || res.status >= 500) {
    const ra = res.headers.get("Retry-After");
    const waitMs = ra && /^\d+$/.test(ra) ? parseInt(ra, 10) * 1000 : 400;
    await new Promise((r) => setTimeout(r, waitMs));
    res = await doFetch();
  }

  return res;
}
