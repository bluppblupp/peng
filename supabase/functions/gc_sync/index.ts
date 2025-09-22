// supabase/functions/gc_sync/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.39.0";
import {
  allow, bearerFrom, errMessage,
  normalizeBase, nint,
  newGcToken, gcFetchRaw,
  isRecord, getString, getNumber,
} from "../_shared/gc.ts";

/** Request body coming from the client */
type SyncReq = {
  bank_account_id?: string;
  date_from?: string; // YYYY-MM-DD
  date_to?: string;   // YYYY-MM-DD
  /** dev/test only: bypass local cooldown/fresh checks if caller is allow-listed */
  force?: boolean;
};

/** Subset of upstream BAD (GoCardless Bank Account Data) transaction fields we care about */
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

/** Target DB row shape for public.transactions (DB triggers will set category) */
type TxInsert = {
  user_id: string;
  bank_account_id: string;
  transaction_id: string;
  description: string;
  amount: number;
  date: string;     // YYYY-MM-DD
  merchant_key?: string | null;
  merchant_name?: string | null;
};

/** Minimal bank_accounts row we read/write */
type BankAccountRow = {
  id: string;
  user_id: string;
  provider: string | null;
  account_id: string | null;
  last_sync_at: string | null;
  next_allowed_sync_at: string | null;
};

/** Upsert .select("id") */
type UpsertIdRow = { id: string };

/** Utils */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseRetryAfterSeconds(res: Response, bodyText: string): number | null {
  const hdr = res.headers.get("Retry-After");
  if (hdr) {
    const sec = Number.parseInt(hdr, 10);
    if (Number.isFinite(sec) && sec > 0) return sec;
  }
  const m = bodyText.match(/try again in\s+(\d+)\s+seconds/i);
  if (m) {
    const sec = Number.parseInt(m[1], 10);
    if (Number.isFinite(sec) && sec > 0) return sec;
  }
  return null;
}

/** Normalize BAD -> (id, description, counterparty, amount, date) (except user/bank ids) */
async function normalizeTx(
  tx: BadTx,
  providerAccountId: string
): Promise<{ transaction_id: string; description: string; counterparty: string; amount: number; date: string }> {
  const txId  = typeof tx.transactionId === "string" ? tx.transactionId : null;
  const itxId = typeof tx.internalTransactionId === "string" ? tx.internalTransactionId : null;
  const refId = typeof tx.entryReference === "string" ? tx.entryReference : null;

  let transaction_id = (txId || itxId || refId || "").trim();

  const amtObj = isRecord(tx.transactionAmount) ? tx.transactionAmount : null;
  const amountNum = amtObj ? getNumber(amtObj, "amount") : null;

  const description =
    (typeof tx.remittanceInformationUnstructured === "string" && tx.remittanceInformationUnstructured) ||
    (typeof tx.remittanceInformationStructured   === "string" && tx.remittanceInformationStructured)   ||
    (typeof tx.creditorName === "string" && tx.creditorName) ||
    (typeof tx.debtorName   === "string" && tx.debtorName)   ||
    "Transaction";

  const counterparty =
    (typeof tx.creditorName === "string" && tx.creditorName) ||
    (typeof tx.debtorName   === "string" && tx.debtorName) ||
    "";

  const date =
    (typeof tx.bookingDate === "string" && tx.bookingDate) ||
    (typeof tx.valueDate   === "string" && tx.valueDate) ||
    ymd(new Date());

  if (!transaction_id) {
    // Build a stable id from some stable fields
    const currency = amtObj ? getString(amtObj, "currency") : null;
    const hint = [
      typeof tx.bookingDate === "string" ? tx.bookingDate : "",
      amountNum !== null ? String(amountNum) : "",
      currency ?? "",
      typeof tx.remittanceInformationUnstructured === "string" ? tx.remittanceInformationUnstructured : "",
    ].join("|");
    transaction_id = await sha256Hex(`${providerAccountId}|${hint}`);
  }

  return {
    transaction_id,
    description,
    counterparty,
    amount: amountNum !== null && Number.isFinite(amountNum) ? amountNum : 0,
    date,
  };
}

/** Heuristic: is this account a credit card? We probe /details and look for "card" signals */
function looksLikeCardString(s: string): boolean {
  const t = s.toLowerCase();
  return /\bcard\b/.test(t) || /\bcredit\b/.test(t) || /visa|mastercard|amex/.test(t);
}
function findCardFlagDeep(x: unknown): boolean {
  if (typeof x === "string") return looksLikeCardString(x);
  if (Array.isArray(x)) return x.some(findCardFlagDeep);
  if (isRecord(x)) {
    for (const v of Object.values(x)) if (findCardFlagDeep(v)) return true;
  }
  return false;
}

/** Normalize amount sign for credit cards: purchases should be negative */
function normalizeCardSign(amount: number, isCreditCard: boolean): number {
  return isCreditCard ? (amount > 0 ? -amount : amount) : amount;
}

/** Merchant helpers for triggers */
function simpleMerchantKey(description: string, counterparty: string): string | null {
  const base = (counterparty || description).trim().toLowerCase();
  if (!base) return null;
  // collapse whitespace & strip obvious noise; keep it conservative (triggers can refine)
  const cleaned = base
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")         // remove diacritics
    .replace(/[^a-z0-9 äöå]/gi, " ")         // keep letters/digits/basic spaces
    .replace(/\s{2,}/g, " ")                 // collapse spaces
    .trim();
  return cleaned || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: allow(req) });

  const correlationId = crypto.randomUUID();

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method Not Allowed", code: "METHOD_NOT_ALLOWED", correlationId }),
        { status: 405, headers: { "content-type": "application/json", ...allow(req) } }
      );
    }

    // Env
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
        { status: 500, headers: { "content-type": "application/json", ...allow(req) } }
      );
    }

    const env = {
      GOCARDLESS_BASE_URL: normalizeBase(rawEnv.GOCARDLESS_BASE_URL!),
      GOCARDLESS_SECRET_ID: rawEnv.GOCARDLESS_SECRET_ID!,
      GOCARDLESS_SECRET_KEY: rawEnv.GOCARDLESS_SECRET_KEY!,
      SUPABASE_URL: rawEnv.SUPABASE_URL!,
      SUPABASE_ANON_KEY: rawEnv.SUPABASE_ANON_KEY!,
      TIMEOUT_ACCT_MS:   nint(rawEnv.GC_TIMEOUT_ACCOUNT_MS, 10_000),
      TIMEOUT_TX_MS:     nint(rawEnv.GC_TIMEOUT_TX_MS, 20_000),
      UPSERT_BATCH_SIZE: nint(rawEnv.GC_SYNC_BATCH_SIZE, 200),
      DAYS_DEFAULT:      nint(rawEnv.GC_SYNC_DAYS, 30),
      OVERLAP_DAYS:      nint(rawEnv.GC_SYNC_OVERLAP_DAYS, 2),
      MAX_PAGES:         nint(rawEnv.GC_SYNC_MAX_PAGES, 12),
      MIN_INTERVAL_MIN:  nint(rawEnv.GC_SYNC_MIN_INTERVAL_MINUTES, 180),
      DEV_FORCE_UIDS:    (rawEnv.GC_DEV_FORCE_UIDS || "").split(",").map((s) => s.trim()).filter(Boolean),
    };

    // Auth
    const supaJwt = bearerFrom(req);
    const supa: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${supaJwt}` } },
      auth: { persistSession: false },
    });

    const { data: userWrap, error: userErr } = await supa.auth.getUser(supaJwt);
    if (userErr || !userWrap?.user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", code: "AUTH_REQUIRED", correlationId }),
        { status: 401, headers: { "content-type": "application/json", ...allow(req) } }
      );
    }
    const userId = userWrap.user.id;

    // Body
    const raw = await req.text();
    let body: SyncReq | null = null;
    try { body = raw ? (JSON.parse(raw) as SyncReq) : null; } catch {
      return new Response(
        JSON.stringify({ error: "Bad Request", code: "INVALID_JSON", correlationId }),
        { status: 400, headers: { "content-type": "application/json", ...allow(req) } }
      );
    }
    const bankAccountRowId = (body?.bank_account_id || "").trim();
    if (!bankAccountRowId) {
      return new Response(
        JSON.stringify({ error: "Bad Request", code: "MISSING_FIELDS", correlationId }),
        { status: 400, headers: { "content-type": "application/json", ...allow(req) } }
      );
    }
    const requestedForce = !!body?.force;
    const allowForce = requestedForce && env.DEV_FORCE_UIDS.includes(userId);

    // Load account row (with cooldown fields)
    const { data: acctRow, error: acctErr } = await supa
      .from("bank_accounts")
      .select("id, user_id, provider, account_id, last_sync_at, next_allowed_sync_at")
      .eq("id", bankAccountRowId)
      .eq("user_id", userId)
      .single<BankAccountRow>();

    if (acctErr || !acctRow) {
      return new Response(
        JSON.stringify({ error: "Not Found", code: "BANK_ACCOUNT_NOT_FOUND", correlationId }),
        { status: 404, headers: { "content-type": "application/json", ...allow(req) } }
      );
    }
    if (acctRow.provider !== "gocardless") {
      return new Response(
        JSON.stringify({ error: "Bad Request", code: "UNSUPPORTED_PROVIDER", correlationId }),
        { status: 400, headers: { "content-type": "application/json", ...allow(req) } }
      );
    }
    const providerAccountId = (acctRow.account_id || "").trim();
    if (!providerAccountId) {
      return new Response(
        JSON.stringify({ error: "Bad Request", code: "ACCOUNT_MISSING_PROVIDER_ID", correlationId }),
        { status: 400, headers: { "content-type": "application/json", ...allow(req) } }
      );
    }

    // Cooldown / freshness guards (skipped if allowForce)
    const now = Date.now();
    if (!allowForce && acctRow.next_allowed_sync_at) {
      const nextMs = new Date(acctRow.next_allowed_sync_at).getTime();
      if (Number.isFinite(nextMs) && now < nextMs) {
        await supa
          .from("bank_accounts")
          .update({ last_sync_status: "noop-cooldown" })
          .eq("id", bankAccountRowId)
          .eq("user_id", userId);

        return new Response(
          JSON.stringify({
            ok: true, noop: true, reason: "cooldown",
            next_allowed_sync_at: acctRow.next_allowed_sync_at,
            wait_seconds: Math.max(0, Math.ceil((nextMs - now) / 1000)),
            correlationId,
          }),
          { status: 200, headers: { "content-type": "application/json", ...allow(req) } }
        );
      }
    }
    if (!allowForce && acctRow.last_sync_at) {
      const age = now - new Date(acctRow.last_sync_at).getTime();
      if (age >= 0 && age < env.MIN_INTERVAL_MIN * 60_000) {
        await supa
          .from("bank_accounts")
          .update({ last_sync_status: "noop-fresh" })
          .eq("id", bankAccountRowId)
          .eq("user_id", userId);

        return new Response(
          JSON.stringify({
            ok: true, noop: true, reason: "fresh",
            last_sync_at: acctRow.last_sync_at,
            min_interval_min: env.MIN_INTERVAL_MIN,
            correlationId,
          }),
          { status: 200, headers: { "content-type": "application/json", ...allow(req) } }
        );
      }
    }

    // Upstream token
    const tokenHolder = { token: await newGcToken(env, correlationId) };
    const refresh = (cid: string) => newGcToken(env, cid);

    // Sanity: account meta
    const metaRes = await gcFetchRaw(
      env, tokenHolder,
      `accounts/${encodeURIComponent(providerAccountId)}/`,
      { method: "GET" },
      correlationId, env.TIMEOUT_ACCT_MS ?? 10_000, refresh
    );
    if (!metaRes.ok) {
      const t = await metaRes.text().catch(() => "");
      const code = metaRes.status === 401 ? "UPSTREAM_AUTH_INVALID" : "UPSTREAM_ACCOUNT_ERROR";
      return new Response(
        JSON.stringify({ error: "Bad Gateway", code, correlationId, details: { status: metaRes.status, bodySnippet: t.slice(0, 600) } }),
        { status: 502, headers: { "content-type": "application/json", ...allow(req) } }
      );
    }

    // Try to detect credit-card from /details (best-effort)
    let isCreditCard = false;
    try {
      const detRes = await gcFetchRaw(
        env, tokenHolder,
        `accounts/${encodeURIComponent(providerAccountId)}/details/`,
        { method: "GET" },
        correlationId, env.TIMEOUT_ACCT_MS ?? 10_000, refresh
      );
      if (detRes.ok) {
        const det = await detRes.json().catch(() => ({} as unknown));
        isCreditCard = findCardFlagDeep(det);
      }
    } catch {
      // ignore; default false
    }

    // Determine fetch window
    const today = new Date();
    const defaultFrom = ymd(new Date(today.getTime() - env.DAYS_DEFAULT * 86400000));
    const to = body?.date_to ?? ymd(today);
    let from = body?.date_from ?? defaultFrom;

    // Overlap a bit behind the last known tx
    try {
      const { data: last } = await supa
        .from("transactions")
        .select("date")
        .eq("user_id", userId)
        .eq("bank_account_id", bankAccountRowId)
        .order("date", { ascending: false })
        .limit(1)
        .returns<{ date: string }[]>();

      if (Array.isArray(last) && last.length > 0 && last[0]?.date) {
        const lastDate = new Date(last[0].date);
        const back = new Date(lastDate.getTime() - env.OVERLAP_DAYS * 86400000);
        const overlapFrom = ymd(back);
        if (!body?.date_from || overlapFrom < from) from = overlapFrom;
      }
    } catch {
      // ignore
    }

    // Fetch transactions (paged)
    const collected: BadTx[] = [];
    let pages = 0;
    let txUrl = `accounts/${encodeURIComponent(providerAccountId)}/transactions/?date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(to)}`;

    while (txUrl && pages < env.MAX_PAGES) {
      const txRes = await gcFetchRaw(env, tokenHolder, txUrl, { method: "GET" }, correlationId, env.TIMEOUT_TX_MS ?? 20_000, refresh);
      if (!txRes.ok) {
        const bodyText = await txRes.text().catch(() => "");
        if (txRes.status === 429) {
          const retrySec = parseRetryAfterSeconds(txRes, bodyText) ?? 3600;
          await supa
            .from("bank_accounts")
            .update({
              next_allowed_sync_at: new Date(Date.now() + retrySec * 1000).toISOString(),
              last_sync_status: "rate_limited",
            })
            .eq("id", bankAccountRowId)
            .eq("user_id", userId);

          return new Response(
            JSON.stringify({
              error: "Rate limited", code: "UPSTREAM_RATE_LIMIT", correlationId,
              details: { status: 429, retryAfterSeconds: retrySec, bodySnippet: bodyText.slice(0, 900) },
            }),
            { status: 429, headers: { "content-type": "application/json", "Retry-After": String(retrySec), ...allow(req) } }
          );
        }
        const code = txRes.status === 401 ? "UPSTREAM_AUTH_INVALID" : "UPSTREAM_TX_ERROR";
        return new Response(
          JSON.stringify({ error: "Bad Gateway", code, correlationId, details: { status: txRes.status, bodySnippet: bodyText.slice(0, 900) } }),
          { status: 502, headers: { "content-type": "application/json", ...allow(req) } }
        );
      }

      const json = (await txRes.json().catch(() => ({}))) as BadTxPage;
      const txObj = isRecord(json.transactions) ? json.transactions : {};
      const bookedRaw = isRecord(txObj) && Array.isArray((txObj as Record<string, unknown>)["booked"])
        ? ((txObj as Record<string, unknown>)["booked"] as unknown[]) : [];
      const pendingRaw = isRecord(txObj) && Array.isArray((txObj as Record<string, unknown>)["pending"])
        ? ((txObj as Record<string, unknown>)["pending"] as unknown[]) : [];

      for (const t of bookedRaw)  if (isRecord(t)) collected.push(t as unknown as BadTx);
      for (const t of pendingRaw) if (isRecord(t)) collected.push(t as unknown as BadTx);

      const nextVal = isRecord(json) ? json.next : null;
      txUrl = typeof nextVal === "string" && nextVal.length > 0 ? nextVal : "";
      pages++;
    }

    // Map -> rows (DB triggers will categorize)
    const rows: TxInsert[] = [];
    for (const t of collected) {
      const n = await normalizeTx(t, providerAccountId);

      // (C) Fix sign for credit cards & enrich description
      const amount = normalizeCardSign(n.amount, isCreditCard);
      const description = (n.description || n.counterparty || "Transaction").trim();

      // Compute merchant hints for triggers
      const merchant_key = simpleMerchantKey(description, n.counterparty);
      const merchant_name = merchant_key ? description : null;

      rows.push({
        user_id: userId,
        bank_account_id: acctRow.id,
        transaction_id: n.transaction_id,
        description,
        amount,
        date: n.date,
        merchant_key,
        merchant_name,
      });
    }

    // De-duplicate by the upsert key: user_id + bank_account_id + transaction_id
    const uniq = new Map<string, TxInsert>();
    for (const r of rows) {
      const k = `${r.user_id}|${r.bank_account_id}|${r.transaction_id}`;
      if (!uniq.has(k)) uniq.set(k, r); // keep first (booked before pending in collection order)
    }
    const deduped = Array.from(uniq.values());

    // Upsert batched
    let upserted = 0;
    if (deduped.length > 0) {
      const size = Math.max(1, Math.min(env.UPSERT_BATCH_SIZE ?? 200, 500));
      for (let i = 0; i < deduped.length; i += size) {
        const chunk: ReadonlyArray<TxInsert> = deduped.slice(i, i + size);
        const { data, error } = await supa
          .from("transactions")
          .upsert(chunk as TxInsert[], { onConflict: "user_id,bank_account_id,transaction_id" })
          .select("id")
          .returns<UpsertIdRow[]>();

        if (error) {
          return new Response(
            JSON.stringify({
              error: "Database Error", code: "DB_UPSERT_FAILED", correlationId,
              details: { message: String((error as { message?: string }).message || error) },
            }),
            { status: 500, headers: { "content-type": "application/json", ...allow(req) } }
          );
        }
        upserted += Array.isArray(data) ? data.length : 0;
      }
    }

    // Mark account as synced and set next allowed time
    const nextAllowed = new Date(Date.now() + env.MIN_INTERVAL_MIN * 60_000).toISOString();
    const statusNote = upserted === 0 ? "ok:0" : "ok";
    await supa
      .from("bank_accounts")
      .update({
        last_sync_at: new Date().toISOString(),
        next_allowed_sync_at: nextAllowed,
        last_sync_status: statusNote,
      })
      .eq("id", bankAccountRowId)
      .eq("user_id", userId);

    return new Response(
      JSON.stringify({
        ok: true,
        noop: false,
        bank_account_id: bankAccountRowId,
        fetched: collected.length,
        upserted,
        next_allowed_sync_at: nextAllowed,
        correlationId,
      }),
      { status: 200, headers: { "content-type": "application/json", ...allow(req) } }
    );

  } catch (e: unknown) {
    return new Response(
      JSON.stringify({
        error: "Internal Server Error",
        code: "GC_SYNC_FAILURE",
        correlationId,
        details: { message: errMessage(e) },
      }),
      { status: 500, headers: { "content-type": "application/json", ...allow(req) } }
    );
  }
});
