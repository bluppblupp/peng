// supabase/functions/gc_sync/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.0";
import {
  allow, bearerFrom, errMessage,
  normalizeBase, nint,
  newGcToken, gcFetchRaw, isRecord, getString, getNumber
} from "../_shared/gc.ts";

/** Incoming body */
type SyncReq = {
  bank_account_id?: string;      // DB row id
  date_from?: string;            // YYYY-MM-DD
  date_to?: string;              // YYYY-MM-DD
};

/** BAD transaction subset */
type BadTx = {
  transactionId?: unknown;
  internalTransactionId?: unknown;
  entryReference?: unknown;
  bookingDate?: unknown;
  valueDate?: unknown;
  transactionAmount?: unknown;
  creditorName?: unknown;
  debtorName?: unknown;
  remittanceInformationUnstructured?: unknown;
  remittanceInformationStructured?: unknown;
};
type BadTxPage = {
  transactions?: { booked?: unknown; pending?: unknown };
  next?: unknown;
};

/** Dates + deterministic id */
function ymd(d: Date) { return d.toISOString().slice(0, 10); }
async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Normalize BAD -> your columns */
async function normalizeTx(
  tx: BadTx,
  providerAccountId: string
): Promise<{ transaction_id: string; description: string; amount: number; date: string; category: string | null; }> {
  const txId = typeof tx.transactionId === "string" ? tx.transactionId : null;
  const itxId = typeof tx.internalTransactionId === "string" ? tx.internalTransactionId : null;
  const entryRef = typeof tx.entryReference === "string" ? tx.entryReference : null;

  let transaction_id = (txId || itxId || entryRef || "").trim();
  if (!transaction_id) {
    const amtObj = isRecord(tx.transactionAmount) ? tx.transactionAmount : null;
    const amount = amtObj ? getNumber(amtObj, "amount") : null;
    const currency = amtObj ? getString(amtObj, "currency") : null;
    const hint = [
      typeof tx.bookingDate === "string" ? tx.bookingDate : "",
      amount !== null ? String(amount) : "",
      currency ?? "",
      typeof tx.remittanceInformationUnstructured === "string" ? tx.remittanceInformationUnstructured : "",
    ].join("|");
    transaction_id = await sha256Hex(providerAccountId + "|" + hint);
  }

  const amtObj = isRecord(tx.transactionAmount) ? tx.transactionAmount : null;
  const amountNum = amtObj ? getNumber(amtObj, "amount") : null;

  const description =
    (typeof tx.remittanceInformationUnstructured === "string" && tx.remittanceInformationUnstructured) ||
    (typeof tx.remittanceInformationStructured === "string" && tx.remittanceInformationStructured) ||
    (typeof tx.creditorName === "string" && tx.creditorName) ||
    (typeof tx.debtorName === "string" && tx.debtorName) ||
    "Transaction";

  const date =
    (typeof tx.bookingDate === "string" && tx.bookingDate) ||
    (typeof tx.valueDate === "string" && tx.valueDate) ||
    ymd(new Date());

  return {
    transaction_id,
    description,
    amount: amountNum !== null && Number.isFinite(amountNum) ? amountNum : 0,
    date,
    category: null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: allow(req) });

  const correlationId = crypto.randomUUID();
  console.log("gc_sync start", {
    method: req.method, ua: (req.headers.get("User-Agent") || "").slice(0, 60), correlationId,
  });

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
      console.error("gc_sync env missing/invalid", { correlationId });
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
      TIMEOUT_ACCT_MS: nint(rawEnv.GC_TIMEOUT_ACCOUNT_MS, 10_000),
      TIMEOUT_TX_MS: nint(rawEnv.GC_TIMEOUT_TX_MS, 20_000),
      UPSERT_BATCH_SIZE: nint(rawEnv.GC_SYNC_BATCH_SIZE, 200),
    };

    // Auth
    const supaJwt = bearerFrom(req);
    const supa = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${supaJwt}` } }, auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await supa.auth.getUser(supaJwt);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized", code: "AUTH_REQUIRED", correlationId }), {
        status: 401, headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    // Body
    const raw = await req.text();
    let body: SyncReq | null = null;
    try { body = raw ? (JSON.parse(raw) as SyncReq) : null; } catch {
      console.error("gc_sync invalid json", { correlationId, rawPreview: raw.slice(0, 120) });
      return new Response(JSON.stringify({ error: "Bad Request", code: "INVALID_JSON", correlationId }), {
        status: 400, headers: { "content-type": "application/json", ...allow(req) },
      });
    }
    const bankAccountRowId = (body?.bank_account_id || "").trim();
    if (!bankAccountRowId) {
      return new Response(JSON.stringify({ error: "Bad Request", code: "MISSING_FIELDS", correlationId }), {
        status: 400, headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    // DB lookup → provider account id
    const { data: acctRow, error: acctErr } = await supa
      .from("bank_accounts")
      .select("id, user_id, provider, account_id")
      .eq("id", bankAccountRowId)
      .eq("user_id", user.id)
      .single();

    if (acctErr || !acctRow) {
      console.error("gc_sync bank account not found", { correlationId, bankAccountRowId, err: acctErr?.message });
      return new Response(JSON.stringify({ error: "Not Found", code: "BANK_ACCOUNT_NOT_FOUND", correlationId }), {
        status: 404, headers: { "content-type": "application/json", ...allow(req) },
      });
    }
    if (acctRow.provider !== "gocardless") {
      return new Response(JSON.stringify({ error: "Bad Request", code: "UNSUPPORTED_PROVIDER", correlationId }), {
        status: 400, headers: { "content-type": "application/json", ...allow(req) },
      });
    }
    const providerAccountId = (acctRow.account_id || "").trim();
    if (!providerAccountId) {
      return new Response(JSON.stringify({ error: "Bad Request", code: "ACCOUNT_MISSING_PROVIDER_ID", correlationId }), {
        status: 400, headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    // BAD token + meta sanity
    const tokenHolder = { token: await newGcToken(env, correlationId) };
    const refresh = (cid: string) => newGcToken(env, cid);

    const metaRes = await gcFetchRaw(env, tokenHolder, `accounts/${encodeURIComponent(providerAccountId)}/`, { method: "GET" }, correlationId, env.TIMEOUT_ACCT_MS, refresh);
    if (!metaRes.ok) {
      const t = await metaRes.text().catch(() => "");
      console.error("gc_sync upstream account meta error", { correlationId, status: metaRes.status, bodySnippet: t.slice(0, 400) });
      const code = metaRes.status === 401 ? "UPSTREAM_AUTH_INVALID" : "UPSTREAM_ACCOUNT_ERROR";
      return new Response(JSON.stringify({ error: "Bad Gateway", code, correlationId }), {
        status: 502, headers: { "content-type": "application/json", ...allow(req) },
      });
    }

    // Date range default 90 days
    const today = new Date();
    const from = body?.date_from ?? ymd(new Date(today.getTime() - 90 * 86400000));
    const to = body?.date_to ?? ymd(today);

    // Fetch & collect
    let txUrl = `accounts/${encodeURIComponent(providerAccountId)}/transactions/?date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(to)}`;
    const collected: BadTx[] = [];
    let pages = 0;

    while (txUrl && pages < 20) {
      const txRes = await gcFetchRaw(env, tokenHolder, txUrl, { method: "GET" }, correlationId, env.TIMEOUT_TX_MS, refresh);
      if (!txRes.ok) {
        const t = await txRes.text().catch(() => "");
        console.error("gc_sync upstream tx error", { correlationId, status: txRes.status, bodySnippet: t.slice(0, 450) });
        const code = txRes.status === 401 ? "UPSTREAM_AUTH_INVALID" : "UPSTREAM_TX_ERROR";
        return new Response(JSON.stringify({ error: "Bad Gateway", code, correlationId }), {
          status: 502, headers: { "content-type": "application/json", ...allow(req) },
        });
      }

      const json = (await txRes.json().catch(() => ({}))) as BadTxPage;
      const txObj = isRecord(json.transactions) ? json.transactions : {};
      const bookedRaw = isRecord(txObj) && Array.isArray((txObj as Record<string, unknown>)["booked"])
        ? ((txObj as Record<string, unknown>)["booked"] as unknown[])
        : [];
      const pendingRaw = isRecord(txObj) && Array.isArray((txObj as Record<string, unknown>)["pending"])
        ? ((txObj as Record<string, unknown>)["pending"] as unknown[])
        : [];

      for (const t of bookedRaw) if (isRecord(t)) collected.push(t as unknown as BadTx);
      for (const t of pendingRaw) if (isRecord(t)) collected.push(t as unknown as BadTx);

      const nextVal = isRecord(json) ? json.next : null;
      txUrl = typeof nextVal === "string" && nextVal.length > 0 ? nextVal : "";
      pages++;
    }

    // Normalize -> rows
    const rows: Array<Record<string, unknown>> = [];
    for (const t of collected) {
      const n = await normalizeTx(t, providerAccountId);
      rows.push({
        user_id: user.id,
        bank_account_id: acctRow.id,
        transaction_id: n.transaction_id,
        description: n.description,
        amount: n.amount,
        category: n.category,
        date: n.date,
      });
    }

    // Upsert (needs unique index on (user_id, bank_account_id, transaction_id))
    let affected = 0;
    if (rows.length > 0) {
      const size = Math.max(1, Math.min(env.UPSERT_BATCH_SIZE ?? 200, 500));
      for (let i = 0; i < rows.length; i += size) {
        const chunk = rows.slice(i, i + size);
        const { data, error } = await supa
          .from("transactions")
          .upsert(chunk, { onConflict: "user_id,bank_account_id,transaction_id" })
          .select("id");
        if (error) {
          console.error("gc_sync upsert error", { correlationId, i, size: chunk.length, error: String(error.message || error) });
          return new Response(JSON.stringify({ error: "Database Error", code: "DB_UPSERT_FAILED", correlationId }), {
            status: 500, headers: { "content-type": "application/json", ...allow(req) },
          });
        }
        affected += Array.isArray(data) ? data.length : 0;
      }
    }

    console.log("gc_sync success", {
      correlationId, userId: user.id, bankAccountRowId, providerAccountId, pages,
      fetched: collected.length, upserted: affected,
    });

    return new Response(JSON.stringify({
      ok: true, bank_account_id: bankAccountRowId,
      date_from: from, date_to: to, fetched: collected.length, upserted: affected,
    }), { status: 200, headers: { "content-type": "application/json", ...allow(req) } });
  } catch (e: unknown) {
    console.error("gc_sync unhandled error", { correlationId, message: errMessage(e) });
    return new Response(JSON.stringify({
      error: "Internal Server Error", code: "GC_SYNC_FAILURE", correlationId,
      details: { message: errMessage(e) },
    }), { status: 500, headers: { "content-type": "application/json", ...allow(req) } });
  }
});
