// supabase/functions/gc_complete/index.ts
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
  isRecord,
  getString,
} from "../_shared/gc.ts";

/** Env we read from Deno.env */
type Env = {
  GOCARDLESS_BASE_URL: string;
  GOCARDLESS_SECRET_ID: string;
  GOCARDLESS_SECRET_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  TIMEOUT_REQUISITION_MS: number;
  TIMEOUT_ACCT_MS: number;
};

type CompleteBody = {
  /** GoCardless requisition id (we stored as connected_banks.link_id) */
  requisition_id?: string;
};

type RowId = { id: string };

/* ---------- small helpers (no side effects, no any) ---------- */

function jsonHeaders(req: Request): HeadersInit {
  return { "content-type": "application/json", ...allow(req) };
}

/** Cheap last4 for PAN/IBAN (safe if shorter) */
function last4(s: string | null): string | null {
  if (!s) return null;
  const m = s.match(/(\d{4})$/);
  return m ? m[1] : s.slice(-4);
}

/** Normalize account type: credit_card | deposit | other */
function normalizeTypeFromMeta(
  meta: Record<string, unknown>,
  details: Record<string, unknown>
): "credit_card" | "deposit" | "other" {
  const product =
    (getString(details, "product") ?? getString(meta, "product") ?? "").toLowerCase();
  const cashType =
    (getString(details, "cashAccountType") ?? getString(meta, "cashAccountType") ?? "").toLowerCase();
  const maskedPan = getString(details, "maskedPan") ?? getString(meta, "maskedPan");

  const looksCard = product.includes("credit") || cashType.includes("card") || !!maskedPan;
  if (looksCard) return "credit_card";
  if (cashType.includes("loan")) return "other";
  return "deposit";
}

/** Build a human-friendly default name without overwriting user renames later */
function buildNiceAccountName(
  institutionName: string,
  providerAccountId: string,
  meta: Record<string, unknown>,
  details: Record<string, unknown>
): string {
  const bank = (institutionName || "Bank").trim();
  const display = getString(details, "name") ?? getString(meta, "display_name");
  const product = getString(details, "product") ?? getString(meta, "product");
  const maskedPan = getString(details, "maskedPan");
  const iban = getString(details, "iban");
  const tail = (maskedPan ?? iban ?? providerAccountId).slice(-4);

  if (display && display.trim()) return display.trim();
  if (product && product.trim()) return `${bank} · ${product.trim()} •••• ${tail}`;
  return `${bank} •••• ${tail}`;
}

/** Fetch account meta with one soft retry for transient errors */
async function fetchAccountMetaSafe(
  env: Env,
  tokenHolder: { token: string },
  providerAccountId: string,
  correlationId: string,
  refresh: (cid: string) => Promise<string>
): Promise<Response | null> {
  const doOnce = async () =>
    gcFetchRaw(
      env,
      tokenHolder,
      `accounts/${encodeURIComponent(providerAccountId)}/`,
      { method: "GET" },
      correlationId,
      env.TIMEOUT_ACCT_MS,
      refresh
    );

  try {
    let res = await doOnce();
    if (res.ok) return res;

    // Retry for transient categories
    if (res.status >= 500 || res.status === 429 || res.status === 408) {
      res = await doOnce();
      if (res.ok) return res;
    }
    return res; // non-ok is returned for caller to handle
  } catch (e: unknown) {
    console.error(
      "gc_complete meta fetch threw",
      JSON.stringify({ correlationId, message: errMessage(e) })
    );
    return null;
  }
}

/* -------------------------- main handler -------------------------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: allow(req) });
  const correlationId = crypto.randomUUID();

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method Not Allowed", code: "METHOD_NOT_ALLOWED", correlationId }),
        { status: 405, headers: jsonHeaders(req) }
      );
    }

    // Env
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
        { status: 500, headers: jsonHeaders(req) }
      );
    }

    const env: Env = {
      GOCARDLESS_BASE_URL: normalizeBase(rawEnv.GOCARDLESS_BASE_URL!),
      GOCARDLESS_SECRET_ID: rawEnv.GOCARDLESS_SECRET_ID!,
      GOCARDLESS_SECRET_KEY: rawEnv.GOCARDLESS_SECRET_KEY!,
      SUPABASE_URL: rawEnv.SUPABASE_URL!,
      SUPABASE_ANON_KEY: rawEnv.SUPABASE_ANON_KEY!,
      TIMEOUT_REQUISITION_MS: nint(rawEnv.GC_TIMEOUT_REQUISITION_MS, 20_000),
      TIMEOUT_ACCT_MS: nint(rawEnv.GC_TIMEOUT_ACCT_MS, 15_000),
    };

    // Auth
    const jwt = bearerFrom(req);
    const supa: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: jwt ? `Bearer ${jwt}` : "" } },
      auth: { persistSession: false },
    });

    const { data: userWrap, error: userErr } = await supa.auth.getUser(jwt);
    if (userErr || !userWrap?.user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", code: "AUTH_REQUIRED", correlationId }),
        { status: 401, headers: jsonHeaders(req) }
      );
    }
    const userId = userWrap.user.id;

    // Body
    const raw = await req.text();
    let body: CompleteBody | null = null;
    try {
      body = raw ? (JSON.parse(raw) as CompleteBody) : null;
    } catch {
      return new Response(
        JSON.stringify({ error: "Bad Request", code: "INVALID_JSON", correlationId }),
        { status: 400, headers: jsonHeaders(req) }
      );
    }
    const requisitionId = (body?.requisition_id || "").trim();
    if (!requisitionId) {
      return new Response(
        JSON.stringify({ error: "Bad Request", code: "MISSING_FIELDS", correlationId }),
        { status: 400, headers: jsonHeaders(req) }
      );
    }

    // connected_banks row for this requisition
    const { data: cbRow, error: cbErr } = await supa
      .from("connected_banks")
      .select("id, user_id, provider, link_id, institution_id, bank_name")
      .eq("user_id", userId)
      .eq("provider", "gocardless")
      .eq("link_id", requisitionId)
      .maybeSingle<{ id: string; user_id: string; provider: string; link_id: string; institution_id: string; bank_name: string | null }>();

    if (cbErr || !cbRow) {
      return new Response(
        JSON.stringify({ error: "Not Found", code: "CONNECTED_BANK_NOT_FOUND", correlationId }),
        { status: 404, headers: jsonHeaders(req) }
      );
    }

    // Upstream token
    const tokenHolder = { token: await newGcToken(env, correlationId) };
    const refresh = (cid: string) => newGcToken(env, cid);

    // Requisition details -> accounts[]
    const rqRes = await gcFetchRaw(
      env,
      tokenHolder,
      `requisitions/${encodeURIComponent(requisitionId)}/`,
      { method: "GET" },
      correlationId,
      env.TIMEOUT_REQUISITION_MS,
      refresh
    );
    if (!rqRes.ok) {
      const t = await rqRes.text().catch(() => "");
      console.error(
        "gc_complete requisition fetch failed",
        JSON.stringify({ correlationId, status: rqRes.status, bodySnippet: t.slice(0, 400) })
      );
      return new Response(
        JSON.stringify({
          error: "Bad Gateway",
          code: "UPSTREAM_REQUISITION_ERROR",
          correlationId,
          details: { status: rqRes.status },
        }),
        { status: 502, headers: jsonHeaders(req) }
      );
    }

    const rqJson = (await rqRes.json().catch(() => ({}))) as Record<string, unknown>;
    const accounts = Array.isArray(rqJson.accounts)
      ? (rqJson.accounts as unknown[]).map((x) => String(x || "")).filter(Boolean)
      : [];

    if (accounts.length === 0) {
      // Nothing yet (user may not have finished). Keep connection pending so UI can retry.
      await supa
        .from("connected_banks")
        .update({ status: "pending", last_sync_note: "No accounts yet" })
        .eq("id", cbRow.id)
        .eq("user_id", userId);

      return new Response(
        JSON.stringify({ ok: true, accounts: [], connected_bank_id: cbRow.id, correlationId }),
        { status: 200, headers: jsonHeaders(req) }
      );
    }

    // For each upstream account: fetch meta, compute name/type, upsert bank_accounts
    const createdIds: string[] = [];
    let firstProviderAccountId = "";

    for (const providerAccountId of accounts) {
      if (!firstProviderAccountId) firstProviderAccountId = providerAccountId;

      const metaRes = await fetchAccountMetaSafe(env, tokenHolder, providerAccountId, correlationId, refresh);
      if (!metaRes) {
        console.error(
          "gc_complete meta fetch failed (threw)",
          JSON.stringify({ correlationId, providerAccountId })
        );
        continue;
      }
      if (!metaRes.ok) {
        const t = await metaRes.text().catch(() => "");
        console.error(
          "gc_complete meta non-ok",
          JSON.stringify({
            correlationId,
            providerAccountId,
            status: metaRes.status,
            bodySnippet: t.slice(0, 300),
          })
        );
        continue; // skip this account only
      }

      const metaObj = (await metaRes.json().catch(() => ({}))) as Record<string, unknown>;
      const details = isRecord(metaObj.account) ? (metaObj.account as Record<string, unknown>) : {};

      const nameComputed = buildNiceAccountName(
        cbRow.bank_name ?? "Bank",
        providerAccountId,
        metaObj,
        details
      );
      const iban = getString(details, "iban") ?? null;
      const currency = getString(details, "currency") ?? getString(metaObj, "currency") ?? null;
      const typeNorm = normalizeTypeFromMeta(metaObj, details);

      // Read existing to avoid clobbering a user rename; only backfill type if missing
      type ExistingBA = { id: string; name: string | null; type: string | null };
      const { data: existing } = await supa
        .from("bank_accounts")
        .select("id, name, type")
        .eq("user_id", userId)
        .eq("provider", "gocardless")
        .eq("account_id", providerAccountId)
        .maybeSingle<ExistingBA>();

      // Payload: set name only on first insert; type only if not present
      const payload: {
        user_id: string;
        connected_bank_id: string;
        provider: "gocardless";
        institution_id: string;
        account_id: string;
        name?: string;
        iban?: string | null;
        currency?: string | null;
        type?: string;
        is_active: boolean;
        is_selected?: boolean;
      } = {
        user_id: userId,
        connected_bank_id: cbRow.id,
        provider: "gocardless",
        institution_id: cbRow.institution_id,
        account_id: providerAccountId,
        iban,
        currency,
        is_active: true,
      };

      if (!existing?.id) {
        payload.name = nameComputed;
        // Preselect the very first created account to improve UX
        if (createdIds.length === 0) payload.is_selected = true;
      }
      if (!existing?.type) {
        payload.type = typeNorm;
      }

      const { data: upData, error: upErr } = await supa
        .from("bank_accounts")
        .upsert(payload, { onConflict: "user_id,provider,account_id" })
        .select("id")
        .returns<RowId[]>();

      if (upErr || !upData || upData.length === 0) {
        // Try to find existing row in case of unique/RLS races
        const { data: found } = await supa
          .from("bank_accounts")
          .select("id")
          .eq("user_id", userId)
          .eq("provider", "gocardless")
          .eq("account_id", providerAccountId)
          .maybeSingle<RowId>();
        if (found?.id) createdIds.push(found.id);
      } else {
        createdIds.push(upData[0].id);
      }
    }

    // Activate the connection even if some accounts failed; surface that via last_error
    await supa
      .from("connected_banks")
      .update({
        status: "active",
        account_id: firstProviderAccountId || null,
        last_error: createdIds.length === 0 ? "No accounts could be saved" : null,
      })
      .eq("id", cbRow.id)
      .eq("user_id", userId);

    return new Response(
      JSON.stringify({
        ok: true,
        connected_bank_id: cbRow.id,
        bank_account_ids: createdIds,
        correlationId,
      }),
      { status: 200, headers: jsonHeaders(req) }
    );
  } catch (e: unknown) {
    console.error("gc_complete unhandled", JSON.stringify({ correlationId, message: errMessage(e) }));
    return new Response(
      JSON.stringify({
        error: "Internal Server Error",
        code: "GC_COMPLETE_FAILURE",
        correlationId,
        details: { message: errMessage(e) },
      }),
      { status: 500, headers: jsonHeaders(req) }
    );
  }
});
