import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/** CORS */
function allow(req: Request) {
  const origin = req.headers.get("Origin") ?? "*";
  const acrh =
    req.headers.get("Access-Control-Request-Headers") ??
    "authorization, x-client-info, x-supabase-api-version, apikey, content-type";
  const acrm = req.headers.get("Access-Control-Request-Method") ?? "POST, OPTIONS";
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

type CompleteBody = { requisition_id?: string; reference?: string };
type RequisitionItem = {
  id?: string;
  reference?: string;
  institution_id?: string;
  status?: string;
  accounts?: unknown;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: allow(req) });

  const correlationId = crypto.randomUUID();
  console.log("gc_complete start", {
    method: req.method,
    ua: (req.headers.get("User-Agent") || "").slice(0, 60),
    correlationId,
  });

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed", code: "METHOD_NOT_ALLOWED", correlationId }), {
        status: 405, headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    // Defer heavy imports
    const { createClient } = await import("npm:@supabase/supabase-js@2.39.0");
    const shared = await import("../_shared/gc.ts");
    const {
      bearerFrom, normalizeBase, nint, newGcToken, gcFetchRaw,
    } = shared;

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
      TIMEOUT_REQUISITION_MS: nint(rawEnv.GC_TIMEOUT_REQUISITION_MS, 20_000),
      TIMEOUT_ACCOUNT_MS: nint(rawEnv.GC_TIMEOUT_ACCOUNT_MS, 10_000),
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

    // Body
    const raw = await req.text();
    let body: CompleteBody | null = null;
    try { body = raw ? (JSON.parse(raw) as CompleteBody) : null; } catch {
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

    // Resolve requisition by reference if needed (page up to 5)
    let requisitionFromList: RequisitionItem | null = null;
    if (!requisitionId && reference) {
      let nextUrl: string | null = "requisitions/";
      let pages = 0;
      while (nextUrl && pages < 5) {
        const listRes = await gcFetchRaw(env, tokenHolder, nextUrl, { method: "GET" }, correlationId, 12_000, refresh);
        if (!listRes.ok) break;
        const json = (await listRes.json().catch(() => ({}))) as { results?: RequisitionItem[]; next?: string | null } | RequisitionItem[];
        const items: RequisitionItem[] = Array.isArray(json)
          ? json as RequisitionItem[]
          : Array.isArray(json.results) ? json.results as RequisitionItem[] : [];
        const found = items.find((it) => typeof it.reference === "string" && it.reference === reference);
        if (found && typeof found.id === "string") {
          requisitionId = found.id;
          requisitionFromList = found;
          break;
        }
        const nextLink = Array.isArray(json) ? null : (typeof json.next === "string" ? json.next : null);
        nextUrl = nextLink ? nextLink : null;
        pages++;
      }
      if (!requisitionId) {
        return new Response(JSON.stringify({
          error: "Not Found", code: "UNKNOWN_REQUISITION_BY_REF", correlationId, details: { reference },
        }), { status: 404, headers: { "content-type": "application/json", ...allow(req) } });
      }
    }

    // Fetch requisition details
    const rqRes = await gcFetchRaw(env, tokenHolder, `requisitions/${encodeURIComponent(requisitionId)}/`, { method: "GET" }, correlationId, env.TIMEOUT_REQUISITION_MS, refresh);
    if (!rqRes.ok) {
      const text = await rqRes.text().catch(() => "");
      console.error("gc_complete upstream requisition error", { correlationId, status: rqRes.status, bodySnippet: text.slice(0, 400) });
      return new Response(JSON.stringify({
        error: "Bad Gateway", code: "UPSTREAM_REQUISITION_ERROR", correlationId,
        details: { status: rqRes.status, bodySnippet: text.slice(0, 400) }
      }), { status: 502, headers: { "content-type": "application/json", ...allow(req) } });
    }

    const rqJson = (await rqRes.json().catch(() => ({}))) as RequisitionItem & Record<string, unknown>;
    const statusStr = typeof rqJson.status === "string" ? rqJson.status : "";
    const accounts = Array.isArray(rqJson.accounts) ? (rqJson.accounts as unknown[]).map(String) : [];
    const institutionId = typeof rqJson.institution_id === "string"
      ? rqJson.institution_id
      : (typeof requisitionFromList?.institution_id === "string" ? requisitionFromList.institution_id! : "");

    // Ensure connected_banks row exists (by link_id = requisitionId)
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

    // Not linked / expired
    if (accounts.length === 0) {
      const looksExpired =
        statusStr.toLowerCase().includes("expire") ||
        (typeof (rqJson as Record<string, unknown>).detail === "string" &&
          ((rqJson as Record<string, unknown>).detail as string).toLowerCase().includes("expire"));

      return new Response(JSON.stringify({
        error: "Requisition not linked",
        code: looksExpired ? "REQUISITION_EXPIRED" : "REQUISITION_NOT_LINKED",
        correlationId,
        details: { status: statusStr || "unknown", institution_id: institutionId || null, bank_name: bankRow?.bank_name || null },
      }), { status: 409, headers: { "content-type": "application/json", ...allow(req) } });
    }

    // Fetch account meta/details & upsert bank_accounts
    const metas = await Promise.all(
      accounts.map(async (id) => {
        const metaRes = await gcFetchRaw(env, tokenHolder, `accounts/${encodeURIComponent(id)}/`, { method: "GET" }, correlationId, env.TIMEOUT_ACCOUNT_MS, refresh);
        if (!metaRes.ok) {
          const body = await metaRes.text().catch(() => "");
          throw new Error(`GC_ACCOUNT_META ${metaRes.status} ${body.slice(0, 300)}`);
        }
        const detRes = await gcFetchRaw(env, tokenHolder, `accounts/${encodeURIComponent(id)}/details/`, { method: "GET" }, correlationId, env.TIMEOUT_ACCOUNT_MS, refresh);
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

    console.log("gc_complete success", {
      correlationId, userId: user.id, connectedBankId, accounts: metas.length,
      warnings: 0,
    });

    return new Response(JSON.stringify({ accounts: metas }), {
      status: 200,
      headers: { "content-type": "application/json", ...allow(req) },
    });
  } catch (e: unknown) {
    console.error("gc_complete unhandled error", { correlationId, message: safeMsg(e) });
    return new Response(JSON.stringify({
      error: "Internal Server Error",
      code: "GC_COMPLETE_FAILURE",
      correlationId,
      details: { message: safeMsg(e) },
    }), { status: 500, headers: { "content-type": "application/json", ...allow(req) } });
  }
});
