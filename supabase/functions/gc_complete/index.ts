// supabase/functions/gc_complete/index.ts
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
  isRecord,
  getString,
} from "../_shared/gc.ts";

type CompleteBody = { requisition_id?: string; reference?: string };

type GcRequisition = {
  id?: string;
  reference?: string;
  status?: string;
  accounts?: unknown;
};

type GcAccountMeta = {
  account?: unknown;
  iban?: unknown;
  resourceId?: unknown;
  currency?: unknown;
  name?: unknown;
  product?: unknown;
};

type BankAccountInsert = {
  user_id: string;
  connected_bank_id: string;
  provider: "gocardless";
  institution_id: string;
  account_id: string;
  name: string | null;
  iban: string | null;
  currency: string | null;
  type: string | null;
};

type UpsertIdRow = { id: string };

function safeStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function fetchRequisitionRobust(
  env: { GOCARDLESS_BASE_URL: string },
  tokenHolder: { token: string },
  correlationId: string,
  timeoutMs: number,
  refresh: (cid: string) => Promise<string>,
  requisitionId?: string | null,
  reference?: string | null
): Promise<GcRequisition | null> {
  // 1) Try by id
  if (requisitionId) {
    const res = await gcFetchRaw(
      env, tokenHolder,
      `requisitions/${encodeURIComponent(requisitionId)}/`,
      { method: "GET" },
      correlationId, timeoutMs, refresh
    );
    if (res.ok) return (await res.json().catch(() => ({}))) as GcRequisition;

    if (res.status !== 404) {
      const t = await res.text().catch(() => "");
      throw new Response(
        JSON.stringify({
          error: "Bad Gateway",
          code: "UPSTREAM_REQUISITION_ERROR",
          correlationId,
          details: { status: res.status, bodySnippet: t.slice(0, 900) },
        }),
        { status: 502, headers: { "content-type": "application/json" } }
      );
    }
    // fall through on 404
  }

  // 2) Try by listing and matching reference
  if (reference) {
    const list = await gcFetchRaw(
      env, tokenHolder,
      "requisitions/",
      { method: "GET" },
      correlationId, timeoutMs, refresh
    );
    if (!list.ok) {
      const t = await list.text().catch(() => "");
      throw new Response(
        JSON.stringify({
          error: "Bad Gateway",
          code: "UPSTREAM_REQUISITION_LIST_ERROR",
          correlationId,
          details: { status: list.status, bodySnippet: t.slice(0, 900) },
        }),
        { status: 502, headers: { "content-type": "application/json" } }
      );
    }
    const json = (await list.json().catch(() => ({}))) as { results?: GcRequisition[] };
    const match = Array.isArray(json?.results)
      ? json.results!.find(r => (r.reference || "").trim() === reference.trim())
      : undefined;
    if (match) return match;
  }

  return null;
}

Deno.serve(async (req) => {
  const correlationId = crypto.randomUUID();

  if (req.method === "OPTIONS") return new Response("ok", { headers: allow(req) });

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
    if (
      !baseOk ||
      !rawEnv.GOCARDLESS_SECRET_ID ||
      !rawEnv.GOCARDLESS_SECRET_KEY ||
      !rawEnv.SUPABASE_URL ||
      !rawEnv.SUPABASE_ANON_KEY
    ) {
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
      TIMEOUT_REQUISITION_MS: nint(rawEnv.GC_TIMEOUT_REQUISITION_MS, 20_000),
      TIMEOUT_ACCOUNT_MS: nint(rawEnv.GC_TIMEOUT_ACCOUNT_MS, 10_000),
    };

    // ---- Auth (caller’s JWT so RLS applies)
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
    let body: CompleteBody | null = null;
    try { body = raw ? (JSON.parse(raw) as CompleteBody) : null; } catch {
      return new Response(
        JSON.stringify({ error: "Bad Request", code: "INVALID_JSON", correlationId }),
        { status: 400, headers: { "content-type": "application/json", ...allow(req) } },
      );
    }
    const requestedId = (body?.requisition_id || "").trim() || null;
    const requestedRef = (body?.reference || "").trim() || null;
    if (!requestedId && !requestedRef) {
      return new Response(
        JSON.stringify({ error: "Bad Request", code: "MISSING_FIELDS", correlationId }),
        { status: 400, headers: { "content-type": "application/json", ...allow(req) } },
      );
    }

    // ---- BAD token
    const tokenHolder = { token: await newGcToken(env, correlationId) };
    const refresh = (cid: string) => newGcToken(env, cid);

    // ---- Fetch requisition (robust: id then list-by-reference)
    const requisition = await fetchRequisitionRobust(
      env,
      tokenHolder,
      correlationId,
      env.TIMEOUT_REQUISITION_MS!,
      refresh,
      requestedId,
      requestedRef
    );

    if (!requisition?.id) {
      return new Response(
        JSON.stringify({
          error: "Not Found",
          code: "REQUISITION_NOT_FOUND",
          correlationId,
          details: { requestedId, requestedRef },
        }),
        { status: 404, headers: { "content-type": "application/json", ...allow(req) } },
      );
    }

    const reqId = requisition.id;

    // Extract upstream account ids from requisition
    const accountsVal = isRecord(requisition) ? (requisition as Record<string, unknown>).accounts : null;
    const accountIds = Array.isArray(accountsVal)
      ? (accountsVal as unknown[]).map((v) => (typeof v === "string" ? v : null)).filter((v): v is string => v !== null)
      : [];

    // ---- Lookup connected_banks by link_id (reqId first, then reference)
    let connectedBankId: string | null = null;
    let institutionId: string | null = null;

    {
      const tryKeys: string[] = [reqId, requestedRef ?? ""].filter((k) => k.length > 0);
      for (const key of tryKeys) {
        const { data, error } = await supa
          .from("connected_banks")
          .select("id, institution_id")
          .eq("user_id", user.id)
          .eq("link_id", key)
          .limit(1)
          .maybeSingle();

        if (!error && data?.id) {
          connectedBankId = data.id;
          institutionId = data.institution_id;
          break;
        }
      }
    }

    if (!connectedBankId) {
      // Create a stub if the create step didn't persist (shouldn’t usually happen)
      const insertRes = await supa
        .from("connected_banks")
        .insert({
          user_id: user.id,
          bank_name: "Bank",
          account_id: reqId,
          institution_id: "unknown",
          is_active: true,
          provider: "gocardless",
          link_id: reqId,
          country: "SE",
          status: "pending",
        })
        .select("id, institution_id")
        .single();

      if (insertRes.error || !insertRes.data?.id) {
        return new Response(
          JSON.stringify({
            error: "Database Error",
            code: "DB_STUB_FAILED",
            correlationId,
            details: { message: insertRes.error?.message || "failed to create connected_banks stub" },
          }),
          { status: 500, headers: { "content-type": "application/json", ...allow(req) } },
        );
      }
      connectedBankId = insertRes.data.id;
      institutionId = insertRes.data.institution_id;
    }

    // ---- Fetch each account meta and upsert bank_accounts
    const inserts: BankAccountInsert[] = [];
    for (const accId of accountIds) {
      const metaRes = await gcFetchRaw(
        env,
        tokenHolder,
        `accounts/${encodeURIComponent(accId)}/`,
        { method: "GET" },
        correlationId,
        env.TIMEOUT_ACCOUNT_MS!,
        refresh
      );
      if (!metaRes.ok) {
        const t = await metaRes.text().catch(() => "");
        return new Response(
          JSON.stringify({
            error: "Bad Gateway",
            code: "UPSTREAM_ACCOUNT_ERROR",
            correlationId,
            details: { status: metaRes.status, bodySnippet: t.slice(0, 900) },
          }),
          { status: 502, headers: { "content-type": "application/json", ...allow(req) } },
        );
      }

      const meta = (await metaRes.json().catch(() => ({}))) as GcAccountMeta;
      const acctObj = isRecord(meta.account) ? (meta.account as Record<string, unknown>) : {};
      const metaObj = isRecord(meta) ? (meta as Record<string, unknown>) : {};

      const name =
        getString(acctObj, "name") ??
        getString(metaObj, "name") ??
        "Account";

      const currency =
        getString(acctObj, "currency") ??
        getString(metaObj, "currency") ??
        null;

      const iban =
        getString(acctObj, "iban") ??
        getString(metaObj, "iban") ??
        null;

      const type =
        getString(acctObj, "product") ??
        getString(metaObj, "product") ??
        null;

      inserts.push({
        user_id: user.id,
        connected_bank_id: connectedBankId!,
        provider: "gocardless",
        institution_id: institutionId || "unknown",
        account_id: accId,
        name,
        iban,
        currency,
        type,
      });
    }

    let accountRowIds: string[] = [];
    if (inserts.length > 0) {
      // De-dupe by (user_id, provider, institution_id, account_id)
      const uniq = new Map<string, BankAccountInsert>();
      for (const r of inserts) {
        const k = `${r.user_id}|${r.provider}|${r.institution_id}|${r.account_id}`;
        if (!uniq.has(k)) uniq.set(k, r);
      }
      const deduped = Array.from(uniq.values());

      const { data, error } = await supa
        .from("bank_accounts")
        .upsert(deduped as BankAccountInsert[], {
          onConflict: "user_id,provider,institution_id,account_id",
        })
        .select("id")
        .returns<UpsertIdRow[]>();

      if (error) {
        return new Response(
          JSON.stringify({
            error: "Database Error",
            code: "DB_UPSERT_FAILED",
            correlationId,
            details: {
              message: error.message,
              code: error.code,
              details: error.details,
              hint: error.hint,
            },
          }),
          { status: 500, headers: { "content-type": "application/json", ...allow(req) } },
        );
      }
      accountRowIds = Array.isArray(data) ? data.map((r) => r.id) : [];
    }

    // ---- Mark bank active
    await supa
      .from("connected_banks")
      .update({ status: "active", is_active: true })
      .eq("id", connectedBankId!)
      .eq("user_id", user.id);

    // ---- Response (callback expects accounts w/ row_id)
    return new Response(
      JSON.stringify({
        ok: true,
        requisition_id: reqId,
        accounts: accountRowIds.map((row_id, i) => ({
          id: accountIds[i] ?? "",
          row_id,
          name: inserts[i]?.name ?? "Account",
          currency: inserts[i]?.currency ?? null,
          iban: inserts[i]?.iban ?? null,
          type: inserts[i]?.type ?? null,
        })),
      }),
      { status: 200, headers: { "content-type": "application/json", ...allow(req) } },
    );
  } catch (e: unknown) {
    return new Response(
      JSON.stringify({
        error: "Internal Server Error",
        code: "GC_COMPLETE_FAILURE",
        correlationId,
        details: { message: errMessage(e) },
      }),
      { status: 500, headers: { "content-type": "application/json", ...allow(req) } },
    );
  }
});
