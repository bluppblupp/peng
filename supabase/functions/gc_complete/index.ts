// supabase/functions/gc_complete/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.0";
import {
  allow, bearerFrom, errMessage,
  normalizeBase, nint,
  newGcToken, gcFetchRaw, isRecord, getString
} from "../_shared/gc.ts";

type CompleteReq = { requisition_id?: string; reference?: string };

type Requisition = {
  id?: string;
  status?: string;
  institution_id?: string;
  accounts?: unknown;
};

type AccountMeta = { id: string; name: string; row_id?: string };

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
      TIMEOUT_REQUISITION_MS: nint(rawEnv.GC_TIMEOUT_REQUISITION_MS, 20_000),
      TIMEOUT_ACCT_MS: nint(rawEnv.GC_TIMEOUT_ACCOUNT_MS, 10_000),
    };

    // Auth
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

    // Body
    const raw = await req.text();
    let body: CompleteReq | null = null;
    try { body = raw ? (JSON.parse(raw) as CompleteReq) : null; } catch {
      return new Response(JSON.stringify({ error: "Bad Request", code: "INVALID_JSON", correlationId }), {
        status: 400, headers: { "content-type": "application/json", ...allow(req) },
      });
    }
    let requisitionId = (body?.requisition_id || "").trim();
    const reference = (body?.reference || "").trim();

    if (!requisitionId && !reference) {
      return new Response(JSON.stringify({ error: "Bad Request", code: "MISSING_FIELDS", correlationId }), {
        status: 400, headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    // GC token
    const tokenHolder = { token: await newGcToken(env, correlationId) };
    const refresh = (cid: string) => newGcToken(env, cid);

    // If only reference present, we could list and find. For now, assume requisitionId provided by callback.
    // Fetch requisition
    const rqRes = await gcFetchRaw(env, tokenHolder, `requisitions/${encodeURIComponent(requisitionId || reference)}/`, {
      method: "GET",
    }, correlationId, env.TIMEOUT_REQUISITION_MS, refresh);

    if (!rqRes.ok) {
      const t = await rqRes.text().catch(() => "");
      return new Response(JSON.stringify({
        error: "Bad Gateway", code: "UPSTREAM_REQUISITION_ERROR", correlationId,
        details: { status: rqRes.status, bodySnippet: t.slice(0, 400) },
      }), { status: 502, headers: { "content-type": "application/json", ...allow(req) } });
    }

    const rqJson = (await rqRes.json().catch(() => ({}))) as Record<string, unknown>;
    const rq: Requisition = {
      id: getString(rqJson, "id") || undefined,
      status: getString(rqJson, "status") || undefined,
      institution_id: getString(rqJson, "institution_id") || undefined,
      accounts: isRecord(rqJson) ? rqJson["accounts"] : undefined,
    };
    if (!requisitionId) requisitionId = rq.id || "";

    const accounts = Array.isArray(rq.accounts) ? rq.accounts.map(String).filter(Boolean) : [];
    if (accounts.length === 0) {
      return new Response(JSON.stringify({
        error: "Requisition not linked",
        code: "REQUISITION_NOT_LINKED",
        correlationId,
        details: { status: rq.status || "unknown", institution_id: rq.institution_id || null },
      }), { status: 409, headers: { "content-type": "application/json", ...allow(req) } });
    }

    // Ensure connected_banks row exists/updated
    const { data: bankRow } = await supa
      .from("connected_banks")
      .select("id")
      .eq("link_id", requisitionId)
      .eq("user_id", user.id)
      .single();

    let connectedBankId = bankRow?.id ?? "";

    if (!connectedBankId) {
      const { data: cb, error: cbErr } = await supa
        .from("connected_banks")
        .upsert({
          user_id: user.id,
          bank_name: "Bank",
          account_id: requisitionId,      // placeholder unique
          institution_id: rq.institution_id || null,
          is_active: true,
          provider: "gocardless",
          link_id: requisitionId,
          country: "SE",
          status: rq.status || "pending",
        }, { onConflict: "user_id,account_id" })
        .select("id")
        .single();

      if (cbErr || !cb?.id) {
        return new Response(JSON.stringify({ error: "Database Error", code: "DB_UPSERT_FAILED", correlationId }), {
          status: 500, headers: { "content-type": "application/json", ...allow(req) },
        });
      }
      connectedBankId = cb.id;
    }

    // Upsert minimal bank_accounts rows (no details -> avoid rate limits)
    const metas: AccountMeta[] = [];
    for (const acctId of accounts) {
      // name placeholder
      const name = "Account";
      const { data, error } = await supa
        .from("bank_accounts")
        .upsert({
          user_id: user.id,
          connected_bank_id: connectedBankId,
          provider: "gocardless",
          institution_id: rq.institution_id || null,
          account_id: acctId,
          name,
          is_selected: false,
        }, { onConflict: "user_id,provider,account_id" })
        .select("id")
        .single();

      if (error) {
        console.error("gc_complete bank_accounts upsert failed", { correlationId, message: error.message });
        return new Response(JSON.stringify({ error: "Database Error", code: "DB_UPSERT_FAILED", correlationId }), {
          status: 500, headers: { "content-type": "application/json", ...allow(req) },
        });
      }

      metas.push({ id: acctId, name, row_id: data?.id });
    }

    console.log("gc_complete success", {
      correlationId, userId: user.id, connectedBankId, accounts: metas.length,
    });

    return new Response(JSON.stringify({ accounts: metas }), {
      status: 200, headers: { "content-type": "application/json", ...allow(req) },
    });
  } catch (e: unknown) {
    console.error("gc_complete unhandled error", { correlationId, message: errMessage(e) });
    return new Response(JSON.stringify({
      error: "Internal Server Error", code: "GC_COMPLETE_FAILURE", correlationId,
      details: { message: errMessage(e) },
    }), { status: 500, headers: { "content-type": "application/json", ...allow(req) } });
  }
});
