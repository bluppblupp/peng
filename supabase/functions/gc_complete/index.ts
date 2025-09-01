// supabase/functions/gc_complete/index.ts
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

/** Timed fetch */
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

/** Env & token holder */
type Env = {
  GOCARDLESS_BASE_URL: string;
  GOCARDLESS_SECRET_ID: string;
  GOCARDLESS_SECRET_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
};
type TokenHolder = { token: string };

/** Exchange a short-lived GC access token */
async function newGcToken(env: Env, correlationId: string): Promise<string> {
  const res = await fetchTimed(
    joinUrl(env.GOCARDLESS_BASE_URL, "token/new/"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ secret_id: env.GOCARDLESS_SECRET_ID, secret_key: env.GOCARDLESS_SECRET_KEY }),
    },
    10_000
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GC_TOKEN_ERROR ${res.status} ${t.slice(0, 300)} (${correlationId})`);
  }
  const json = (await res.json().catch(() => ({}))) as { access?: string };
  if (!json.access) throw new Error(`GC_TOKEN_MALFORMED (${correlationId})`);
  return json.access;
}

/**
 * GC fetch that:
 *  - adds Authorization: Bearer <tokenHolder.token>
 *  - on 401 once: refresh token and retry
 *  - on 429/5xx: one backoff retry
 */
async function gcFetchRaw(
  env: Env,
  tokenHolder: TokenHolder,
  path: string,
  init: RequestInit = {},
  correlationId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const url = joinUrl(env.GOCARDLESS_BASE_URL, path);

  const doFetch = async () =>
    fetchTimed(
      url,
      {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.headers || {}),
          Authorization: `Bearer ${tokenHolder.token}`,
        },
      },
      timeoutMs
    );

  // First attempt
  let res = await doFetch();
  if (res.ok) return res;

  // If 401 — refresh token once and retry the request
  if (res.status === 401) {
    try {
      tokenHolder.token = await newGcToken(env, correlationId);
    } catch {
      return res; // return original 401; caller will wrap it
    }
    res = await doFetch();
    if (res.ok) return res;
  }

  // If 429/5xx — small retry once
  if (res.status === 429 || res.status >= 500) {
    await new Promise((r) => setTimeout(r, 400));
    res = await doFetch();
  }
  return res;
}

/** Types */
type CompleteReqBody = { requisition_id?: string; reference?: string };
type RequisitionItem = {
  id?: string;
  reference?: string;
  institution_id?: string;
  status?: string;
  accounts?: unknown;
};
type RequisitionList = { results?: RequisitionItem[]; next?: string | null } | RequisitionItem[];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: allow(req) });

  const correlationId = crypto.randomUUID();

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed", code: "METHOD_NOT_ALLOWED", correlationId }), {
        status: 405, headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    // Env
    const rawEnv = Deno.env.toObject();
    const env: Env = {
      GOCARDLESS_BASE_URL: rawEnv.GOCARDLESS_BASE_URL || "",
      GOCARDLESS_SECRET_ID: rawEnv.GOCARDLESS_SECRET_ID || "",
      GOCARDLESS_SECRET_KEY: rawEnv.GOCARDLESS_SECRET_KEY || "",
      SUPABASE_URL: rawEnv.SUPABASE_URL || "",
      SUPABASE_ANON_KEY: rawEnv.SUPABASE_ANON_KEY || "",
    };
    let baseOk = true;
    try { new URL(env.GOCARDLESS_BASE_URL); } catch { baseOk = false; }
    if (!baseOk || !env.GOCARDLESS_SECRET_ID || !env.GOCARDLESS_SECRET_KEY || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      return new Response(JSON.stringify({ error: "Internal Server Error", code: "CONFIG_MISSING", correlationId }), {
        status: 500, headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    // Auth
    const token = bearerFrom(req);
    const supa = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await supa.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized", code: "AUTH_REQUIRED", correlationId }), {
        status: 401, headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    // Body
    const raw = await req.text();
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {
      return new Response(JSON.stringify({ error: "Bad Request", code: "INVALID_JSON", correlationId }), {
        status: 400, headers: { "content-type": "application/json", ...allow(req) },
      });
    }
    const { requisition_id: rqFromClient, reference: refFromClient }: CompleteReqBody = (parsed as CompleteReqBody) ?? {};
    if (!rqFromClient && !refFromClient) {
      return new Response(JSON.stringify({ error: "Bad Request", code: "MISSING_FIELDS", correlationId }), {
        status: 400, headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    // initial GC token
    const tokenHolder: TokenHolder = { token: await newGcToken(env, correlationId) };

    // Resolve requisition id via reference if needed
    let requisitionId = rqFromClient?.trim() || "";
    let requisitionFromList: RequisitionItem | null = null;

    if (!requisitionId && refFromClient) {
      let nextUrl: string | null = "requisitions/";
      let pages = 0;
      while (nextUrl && pages < 5) {
        const listRes = await gcFetchRaw(env, tokenHolder, nextUrl, { method: "GET" }, correlationId, 12_000);
        if (!listRes.ok) break;

        const json = (await listRes.json().catch(() => ({}))) as RequisitionList;
        const items: RequisitionItem[] = Array.isArray(json)
          ? (json as RequisitionItem[])
          : Array.isArray(json.results) ? (json.results as RequisitionItem[]) : [];

        const found = items.find((it) => typeof it.reference === "string" && it.reference === refFromClient);
        if (found && typeof found.id === "string") {
          requisitionId = found.id;
          requisitionFromList = found;
          break;
        }

        const nextLink = Array.isArray(json) ? null : (typeof json.next === "string" ? json.next : null);
        // If GC returns absolute URL for next, pass full; else pass relative
        nextUrl = nextLink ? (nextLink.startsWith("http") ? nextLink : nextLink) : null;
        pages++;
      }

      if (!requisitionId) {
        return new Response(JSON.stringify({
          error: "Not Found",
          code: "UNKNOWN_REQUISITION_BY_REF",
          correlationId,
          details: { reference: refFromClient },
        }), { status: 404, headers: { "content-type": "application/json", ...allow(req) } });
      }
    }

    // Fetch requisition details
    const rqRes = await gcFetchRaw(env, tokenHolder, `requisitions/${encodeURIComponent(requisitionId)}/`, { method: "GET" }, correlationId, 15_000);
    if (!rqRes.ok) {
      const text = await rqRes.text().catch(() => "");
      return new Response(JSON.stringify({
        error: "Bad Gateway", code: "UPSTREAM_REQUISITION_ERROR", correlationId,
        details: { status: rqRes.status, bodySnippet: text.slice(0, 400) }
      }), { status: 502, headers: { "content-type": "application/json", ...allow(req) } });
    }

    const rqJson = (await rqRes.json().catch(() => ({}))) as RequisitionItem & Record<string, unknown>;
    const statusStr = typeof rqJson.status === "string" ? rqJson.status : "";
    const accounts: string[] = Array.isArray(rqJson.accounts) ? (rqJson.accounts as unknown[]).map(String) : [];
    const institutionId = typeof rqJson.institution_id === "string"
      ? rqJson.institution_id
      : (typeof requisitionFromList?.institution_id === "string" ? requisitionFromList.institution_id : "");

    // Ensure connected_banks row exists
    const { data: bankRow } = await supa
      .from("connected_banks")
      .select("id, institution_id, bank_name")
      .eq("link_id", requisitionId)
      .eq("user_id", user.id)
      .single();

    let connectedBankId = bankRow?.id ?? "";
    if (!connectedBankId) {
      const { data: inserted, error: insErr } = await supa
        .from("connected_banks")
        .upsert(
          {
            user_id: user.id,
            bank_name: bankRow?.bank_name ?? "Bank",
            account_id: requisitionId, // placeholder unique per user
            institution_id: institutionId || bankRow?.institution_id || null,
            is_active: true,
            provider: "gocardless",
            link_id: requisitionId,
            country: "SE",
            status: statusStr || "pending",
          },
          { onConflict: "user_id,account_id" }
        )
        .select("id")
        .single();

      if (insErr || !inserted?.id) {
        return new Response(JSON.stringify({
          error: "Database Error", code: "DB_REPAIR_FAILED", correlationId
        }), { status: 500, headers: { "content-type": "application/json", ...allow(req) } });
      }
      connectedBankId = inserted.id;
    }

    // Update status (best effort)
    await supa
      .from("connected_banks")
      .update({
        status: accounts.length > 0 ? (statusStr || "active") : (statusStr || "pending"),
        consent_expires_at: new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString(),
      })
      .eq("id", connectedBankId)
      .eq("user_id", user.id);

    // Not linked yet (expired/cancelled)
    if (accounts.length === 0) {
      const looksExpired =
        statusStr.toLowerCase().includes("expire") ||
        (typeof (rqJson as Record<string, unknown>).detail === "string" &&
          ((rqJson as Record<string, unknown>).detail as string).toLowerCase().includes("expire"));

      return new Response(JSON.stringify({
        error: "Requisition not linked",
        code: looksExpired ? "REQUISTION_EXPIRED" : "REQUISTION_NOT_LINKED",
        correlationId,
        details: { status: statusStr || "unknown", institution_id: institutionId || null },
      }), { status: 409, headers: { "content-type": "application/json", ...allow(req) } });
    }

    // Fetch accounts meta/details (with token auto-refresh)
    const metas = await Promise.all(
      accounts.map(async (id) => {
        const metaRes = await gcFetchRaw(env, tokenHolder, `accounts/${encodeURIComponent(id)}/`, { method: "GET" }, correlationId, 10_000);
        if (!metaRes.ok) {
          const body = await metaRes.text().catch(() => "");
          throw new Error(`GC_ACCOUNT_META ${metaRes.status} ${body.slice(0, 300)}`);
        }

        const detRes = await gcFetchRaw(env, tokenHolder, `accounts/${encodeURIComponent(id)}/details/`, { method: "GET" }, correlationId, 10_000);
        if (!detRes.ok) {
          const body = await detRes.text().catch(() => "");
          throw new Error(`GC_ACCOUNT_DETAILS ${detRes.status} ${body.slice(0, 300)}`);
        }

        const meta = (await metaRes.json().catch(() => ({}))) as Record<string, unknown>;
        const details = (await detRes.json().catch(() => ({}))) as Record<string, unknown>;

        const dAcc = (details.account as Record<string, unknown> | undefined) ?? {};
        const mAcc = (meta.account as Record<string, unknown> | undefined) ?? {};

        const name =
          (typeof dAcc.name === "string" && dAcc.name) ||
          (typeof mAcc.name === "string" && mAcc.name) ||
          (typeof (dAcc as Record<string, unknown>).displayName === "string" &&
            ((dAcc as Record<string, unknown>).displayName as string)) ||
          "Account";

        const iban =
          (typeof dAcc.iban === "string" && dAcc.iban) ||
          (typeof mAcc.iban === "string" && mAcc.iban) ||
          null;

        const currency =
          (typeof dAcc.currency === "string" && dAcc.currency) ||
          (typeof mAcc.currency === "string" && mAcc.currency) ||
          null;

        const type =
          (typeof dAcc.type === "string" && dAcc.type) ||
          (typeof mAcc.product === "string" && mAcc.product) ||
          null;

        const { data: row, error } = await supa
          .from("bank_accounts")
          .upsert(
            {
              user_id: user.id,
              connected_bank_id: connectedBankId,
              provider: "gocardless",
              institution_id: institutionId || null,
              account_id: id,
              name, iban, currency, type,
              is_selected: false,
            },
            { onConflict: "user_id,provider,account_id" }
          )
          .select("id")
          .single();

        if (error) throw new Error(`DB upsert failed: ${error.message}`);

        return { id, name, currency, iban, type, row_id: row?.id };
      })
    );

    return new Response(JSON.stringify({ accounts: metas }), {
      status: 200,
      headers: { "content-type": "application/json", ...allow(req) },
    });
  } catch (e: unknown) {
    const correlationId = ""; // don't leak from outer scope if it threw before defined (defensive)
    return new Response(
      JSON.stringify({
        error: "Internal Server Error",
        code: "GC_COMPLETE_FAILURE",
        // Not including correlationId here because if we threw before it was defined, it would be empty.
        details: { message: errMessage(e) },
      }),
      { status: 500, headers: { "content-type": "application/json", ...allow(req) } }
    );
  }
});
