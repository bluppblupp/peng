// supabase/functions/gc_sync/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.39.0";
import {
  allow, bearerFrom, errMessage,
  normalizeBase, nint, newGcToken, gcFetchRaw,
  isRecord, getString, getNumber,
} from "../_shared/gc.ts";
import { categorize as fallbackCategorize } from "../_shared/gc_categorize.ts";

type SyncReq = {
  bank_account_id?: string;
  date_from?: string;
  date_to?: string;
  force?: boolean;
};


function normalizeMatchText(s: string): string {
  // Keep letters/digits, collapse other runs to a single space, lowercase
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function first<T>(arr: ReadonlyArray<T>): T | null {
  return arr.length > 0 ? arr[0] : null;
}


type BankAccountDataTx = {
  transactionId?: unknown;
  internalTransactionId?: unknown;
  entryReference?: unknown;

  bookingDate?: unknown;
  valueDate?: unknown;

  transactionAmount?: unknown;              // { amount, currency }
  creditDebitIndicator?: unknown;           // "CRDT" | "DBIT"
  bankTransactionCode?: unknown;
  proprietaryBankTransactionCode?: unknown;

  creditorName?: unknown;
  debtorName?: unknown;

  remittanceInformationUnstructured?: unknown;
  remittanceInformationStructured?: unknown;
  remittanceInformationUnstructuredArray?: unknown; // string[]
  transactionInformation?: unknown;
  additionalInformation?: unknown;
};

type BankAccountDataTxPage = {
  transactions?: { booked?: unknown; pending?: unknown };
  next?: unknown;
};

type TxInsert = {
  user_id: string;
  bank_account_id: string;
  transaction_id: string;
  description: string;
  amount: number;
  category: string;
  date: string;
  category_source: "user_override" | "alias_default" | "rules";
  merchant_key?: string | null;
  merchant_name?: string | null;
};

type BankAccountRow = {
  id: string;
  user_id: string;
  provider: string | null;
  account_id: string | null;
  institution_id: string;
  connected_bank_id: string;
  last_sync_at: string | null;
  next_allowed_sync_at: string | null;
  type: string | null;
};

type ConnectedBankRow = {
  id: string;
  country: string | null;
};

type UpsertIdRow = { id: string };

type MerchantAliasRow = {
  merchant_key: string;
  display_name: string | null;
  default_category: string | null;
  country: string | null;
};

type MerchantPatternRow = {
  pattern: string;
  flags: string;
  merchant_key: string;
  bank: string | null;
  country: string | null;
  priority: number;
  is_enabled: boolean;
};

type UserOverrideRow = {
  merchant_key: string;
  category: string;
};

type CompiledPattern = {
  re: RegExp;
  merchant_key: string;
  priority: number;
};

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

/** Disallow stateful flags that break RegExp.test (like 'g' and 'y'). */
function safeFlags(f: string | null | undefined): string {
  const s = (f || "").toLowerCase();
  const allowed = new Set(["i", "m", "u", "s"]); // no 'g' or 'y'
  let out = "";
  for (const ch of s) if (allowed.has(ch) && !out.includes(ch)) out += ch;
  return out || "i";
}

/** Simpler title-case with no Unicode property escapes. */
function titleCase(s: string): string {
  const cleaned = s
    .replace(/[_-]+/g, " ")   // <— fixed here
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!cleaned) return "";
  return cleaned
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Load merchant overrides/aliases/patterns; filter (bank,country) in code. */
async function loadMerchantData(
  supa: SupabaseClient,
  userId: string,
  institutionId: string,
  country: string | null
): Promise<{
  patterns: CompiledPattern[];
  aliases: Map<string, { display_name: string | null; default_category: string | null }>;
  overrides: Map<string, string>;
}> {
  // Overrides
  const { data: ovRows } = await supa
    .from("user_category_overrides")
    .select("merchant_key, category")
    .eq("user_id", userId)
    .returns<UserOverrideRow[]>();
  const overrides = new Map<string, string>();
  for (const r of ovRows ?? []) if (r.merchant_key && r.category) overrides.set(r.merchant_key, r.category);

  // Aliases
  const { data: aliasRows } = await supa
    .from("merchant_aliases")
    .select("merchant_key, display_name, default_category, country")
    .returns<MerchantAliasRow[]>();
  const aliases = new Map<string, { display_name: string | null; default_category: string | null }>();
  for (const a of aliasRows ?? []) {
    aliases.set(a.merchant_key, { display_name: a.display_name, default_category: a.default_category });
  }

  // Patterns: get all enabled, filter locally by (bank,country)
  const { data: patRows } = await supa
    .from("merchant_patterns")
    .select("pattern, flags, merchant_key, bank, country, priority, is_enabled")
    .eq("is_enabled", true)
    .returns<MerchantPatternRow[]>();

  const patterns: CompiledPattern[] = [];
  for (const p of patRows ?? []) {
    const byBank = !p.bank || (institutionId ? p.bank === institutionId : true);
    const byCountry = !p.country || (country ? p.country === country : true);
    if (!byBank || !byCountry) continue;

    const flags = safeFlags(p.flags);
    try {
      const re = new RegExp(p.pattern, flags);
      patterns.push({ re, merchant_key: p.merchant_key, priority: p.priority });
    } catch {
      // skip invalid regex
    }
  }

  // Deterministic order: priority asc, then longer source first
  patterns.sort((a, b) => (a.priority - b.priority) || (b.re.source.length - a.re.source.length));
  return { patterns, aliases, overrides };
}

function detectMerchant(text: string, compiled: CompiledPattern[]): { merchant_key: string | null } {
  for (const p of compiled) {
    if (p.re.test(text)) return { merchant_key: p.merchant_key };
  }
  return { merchant_key: null };
}

type NormalizedTx = {
  transaction_id: string;
  description: string;
  counterparty: string;
  amount: number;         // sign per indicator/codes
  currency: string | null;
  date: string;           // YYYY-MM-DD
};

async function normalizeTx(
  tx: BankAccountDataTx,
  providerAccountId: string
): Promise<NormalizedTx> {
  // IDs
  const txId  = typeof tx.transactionId === "string" ? tx.transactionId : null;
  const itxId = typeof tx.internalTransactionId === "string" ? tx.internalTransactionId : null;
  const refId = typeof tx.entryReference === "string" ? tx.entryReference : null;
  let transaction_id = (txId || itxId || refId || "").trim();

  // Amount & currency
  const amtObj = isRecord(tx.transactionAmount) ? tx.transactionAmount : null;
  const rawAmount = amtObj ? getNumber(amtObj, "amount") : null;
  const currency = amtObj ? getString(amtObj, "currency") : null;
  const abs = rawAmount !== null && Number.isFinite(rawAmount) ? Math.abs(rawAmount) : 0;

  // Indicators / codes (present in many GC integrations)
  const cdi = typeof (tx as Record<string, unknown>)["creditDebitIndicator"] === "string"
    ? String((tx as Record<string, unknown>)["creditDebitIndicator"]).toUpperCase()
    : null;

  const btc  = typeof (tx as Record<string, unknown>)["bankTransactionCode"] === "string"
    ? String((tx as Record<string, unknown>)["bankTransactionCode"])
    : "";
  const pbtc = typeof (tx as Record<string, unknown>)["proprietaryBankTransactionCode"] === "string"
    ? String((tx as Record<string, unknown>)["proprietaryBankTransactionCode"])
    : "";

  let signed = abs;
  if (cdi === "DBIT") signed = -abs;
  else if (cdi === "CRDT") signed = +abs;
  else if (/DBIT/i.test(btc) || /DBIT/i.test(pbtc)) signed = -abs;
  else if (/CRDT/i.test(btc) || /CRDT/i.test(pbtc)) signed = +abs;
  else signed = rawAmount ?? 0;

  // Description inputs (prefer the “human” ones)
  const riu = typeof (tx as Record<string, unknown>)["remittanceInformationUnstructured"] === "string"
    ? String((tx as Record<string, unknown>)["remittanceInformationUnstructured"]).trim()
    : "";
  const ris = typeof (tx as Record<string, unknown>)["remittanceInformationStructured"] === "string"
    ? String((tx as Record<string, unknown>)["remittanceInformationStructured"]).trim()
    : "";

  const riuArr: string[] = Array.isArray((tx as Record<string, unknown>)["remittanceInformationUnstructuredArray"])
    ? ((tx as Record<string, unknown>)["remittanceInformationUnstructuredArray"] as unknown[])
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
    : [];

  const txnInfo = typeof (tx as Record<string, unknown>)["transactionInformation"] === "string"
    ? String((tx as Record<string, unknown>)["transactionInformation"]).trim()
    : "";
  const addlInfo = typeof (tx as Record<string, unknown>)["additionalInformation"] === "string"
    ? String((tx as Record<string, unknown>)["additionalInformation"]).trim()
    : "";

  const cred = typeof tx.creditorName === "string" ? tx.creditorName.trim() : "";
  const deb  = typeof tx.debtorName   === "string" ? tx.debtorName.trim()   : "";

  const description =
    (riuArr[0] || riu || ris || txnInfo || addlInfo || cred || deb || "Transaction").trim();

  const counterparty = (cred || deb || "").trim();

  // Date
  const date =
    (typeof tx.bookingDate === "string" && tx.bookingDate) ||
    (typeof tx.valueDate   === "string" && tx.valueDate) ||
    ymd(new Date());

  // Fallback transaction_id
  if (!transaction_id) {
    const hint = [date, String(abs), currency ?? "", riu, ris, txnInfo].join("|");
    transaction_id = await sha256Hex(`${providerAccountId}|${hint}`);
  }

  return {
    transaction_id,
    description,
    counterparty,
    amount: Number.isFinite(signed) ? signed : 0,
    currency,
    date,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: allow(req) });
  const correlationId = crypto.randomUUID();

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed", code: "METHOD_NOT_ALLOWED", correlationId }),
        { status: 405, headers: { "content-type": "application/json", ...allow(req) } });
    }

    const rawEnv = Deno.env.toObject();
    let baseOk = true;
    try { new URL(rawEnv.GOCARDLESS_BASE_URL || ""); } catch { baseOk = false; }
    if (!baseOk || !rawEnv.GOCARDLESS_SECRET_ID || !rawEnv.GOCARDLESS_SECRET_KEY || !rawEnv.SUPABASE_URL || !rawEnv.SUPABASE_ANON_KEY) {
      return new Response(JSON.stringify({ error: "Internal Server Error", code: "CONFIG_MISSING", correlationId }),
        { status: 500, headers: { "content-type": "application/json", ...allow(req) } });
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

    const supaJwt = bearerFrom(req);
    const supa: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${supaJwt}` } },
      auth: { persistSession: false },
    });

    const { data: userWrap, error: userErr } = await supa.auth.getUser(supaJwt);
    if (userErr || !userWrap?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized", code: "AUTH_REQUIRED", correlationId }),
        { status: 401, headers: { "content-type": "application/json", ...allow(req) } });
    }
    const userId = userWrap.user.id;

    const raw = await req.text();
    let body: SyncReq | null = null;
    try { body = raw ? (JSON.parse(raw) as SyncReq) : null; } catch {
      return new Response(JSON.stringify({ error: "Bad Request", code: "INVALID_JSON", correlationId }),
        { status: 400, headers: { "content-type": "application/json", ...allow(req) } });
    }
    const bankAccountRowId = (body?.bank_account_id || "").trim();
    if (!bankAccountRowId) {
      return new Response(JSON.stringify({ error: "Bad Request", code: "MISSING_FIELDS", correlationId }),
        { status: 400, headers: { "content-type": "application/json", ...allow(req) } });
    }

    const requestedForce = !!body?.force;
    const allowForce = requestedForce && env.DEV_FORCE_UIDS.includes(userId);

type BankAccountWithCountry = {
  id: string;
  user_id: string;
  provider: string | null;
  account_id: string | null;
  institution_id: string | null;
  connected_bank_id: string;
  last_sync_at: string | null;
  next_allowed_sync_at: string | null;
  type: string | null;
  connected_banks: { id: string; country: string | null } | null;
};

const { data: acctRow, error: acctErr } = await supa
  .from("bank_accounts")
  .select(`
    id, user_id, provider, account_id, institution_id, connected_bank_id,
    last_sync_at, next_allowed_sync_at, type,
    connected_banks:connected_banks!bank_accounts_connected_bank_id_fkey ( id, country )
  `)
  .eq("id", bankAccountRowId)
  .eq("user_id", userId)
  .single<BankAccountWithCountry>();
    if (acctErr || !acctRow) {
      return new Response(JSON.stringify({ error: "Not Found", code: "BANK_ACCOUNT_NOT_FOUND", correlationId }),
        { status: 404, headers: { "content-type": "application/json", ...allow(req) } });
    }
    if (acctRow.provider !== "gocardless") {
      return new Response(JSON.stringify({ error: "Bad Request", code: "UNSUPPORTED_PROVIDER", correlationId }),
        { status: 400, headers: { "content-type": "application/json", ...allow(req) } });
    }
    const providerAccountId = (acctRow.account_id || "").trim();
    if (!providerAccountId) {
      return new Response(JSON.stringify({ error: "Bad Request", code: "ACCOUNT_MISSING_PROVIDER_ID", correlationId }),
        { status: 400, headers: { "content-type": "application/json", ...allow(req) } });
    }

  const country: string | null = acctRow.connected_banks?.country ?? null;



    const now = Date.now();
    if (!allowForce && acctRow.next_allowed_sync_at) {
      const nextMs = new Date(acctRow.next_allowed_sync_at).getTime();
      if (Number.isFinite(nextMs) && now < nextMs) {
        await supa.from("bank_accounts").update({ last_sync_status: "noop-cooldown" })
          .eq("id", bankAccountRowId).eq("user_id", userId);
        return new Response(JSON.stringify({
          ok: true, noop: true, reason: "cooldown",
          next_allowed_sync_at: acctRow.next_allowed_sync_at,
          wait_seconds: Math.max(0, Math.ceil((nextMs - now) / 1000)),
          correlationId,
        }), { status: 200, headers: { "content-type": "application/json", ...allow(req) } });
      }
    }
    if (!allowForce && acctRow.last_sync_at) {
      const age = now - new Date(acctRow.last_sync_at).getTime();
      if (age >= 0 && age < env.MIN_INTERVAL_MIN * 60_000) {
        await supa.from("bank_accounts").update({ last_sync_status: "noop-fresh" })
          .eq("id", bankAccountRowId).eq("user_id", userId);
        return new Response(JSON.stringify({
          ok: true, noop: true, reason: "fresh",
          last_sync_at: acctRow.last_sync_at,
          min_interval_min: env.MIN_INTERVAL_MIN,
          correlationId,
        }), { status: 200, headers: { "content-type": "application/json", ...allow(req) } });
      }
    }

    const tokenHolder = { token: await newGcToken(env, correlationId) };
    const refresh = (cid: string) => newGcToken(env, cid);

    const metaRes = await gcFetchRaw(
      env, tokenHolder,
      `accounts/${encodeURIComponent(providerAccountId)}/`,
      { method: "GET" },
      correlationId, env.TIMEOUT_ACCT_MS ?? 10_000, refresh
    );
    if (!metaRes.ok) {
      const t = await metaRes.text().catch(() => "");
      const code = metaRes.status === 401 ? "UPSTREAM_AUTH_INVALID" : "UPSTREAM_ACCOUNT_ERROR";
      return new Response(JSON.stringify({
        error: "Bad Gateway", code, correlationId,
        details: { status: metaRes.status, bodySnippet: t.slice(0, 600) }
      }), { status: 502, headers: { "content-type": "application/json", ...allow(req) } });
    }

    const today = new Date();
    const defaultFrom = ymd(new Date(today.getTime() - env.DAYS_DEFAULT * 86400000));
    const to = body?.date_to ?? ymd(today);
    let from = body?.date_from ?? defaultFrom;

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
    } catch { /* ignore */ }

    const merch = await loadMerchantData(supa, userId, acctRow.institution_id, country);

    const collected: BankAccountDataTx[] = [];
    let pages = 0;
    let txUrl = `accounts/${encodeURIComponent(providerAccountId)}/transactions/?date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(to)}`;

    while (txUrl && pages < env.MAX_PAGES) {
      const txRes = await gcFetchRaw(env, tokenHolder, txUrl, { method: "GET" }, correlationId, env.TIMEOUT_TX_MS ?? 20_000, refresh);
      if (!txRes.ok) {
        const bodyText = await txRes.text().catch(() => "");
        if (txRes.status === 429) {
          const retrySec = parseRetryAfterSeconds(txRes, bodyText) ?? 3600;
          await supa.from("bank_accounts").update({
            next_allowed_sync_at: new Date(Date.now() + retrySec * 1000).toISOString(),
            last_sync_status: "rate_limited",
          }).eq("id", bankAccountRowId).eq("user_id", userId);
          return new Response(JSON.stringify({
            error: "Rate limited", code: "UPSTREAM_RATE_LIMIT", correlationId,
            details: { status: 429, retryAfterSeconds: retrySec, bodySnippet: bodyText.slice(0, 900) },
          }), { status: 429, headers: { "content-type": "application/json", "Retry-After": String(retrySec), ...allow(req) } });
        }
        const code = txRes.status === 401 ? "UPSTREAM_AUTH_INVALID" : "UPSTREAM_TX_ERROR";
        return new Response(JSON.stringify({
          error: "Bad Gateway", code, correlationId,
          details: { status: txRes.status, bodySnippet: bodyText.slice(0, 900) }
        }), { status: 502, headers: { "content-type": "application/json", ...allow(req) } });
      }

      const json = (await txRes.json().catch(() => ({}))) as BankAccountDataTxPage;
      const txObj = isRecord(json.transactions) ? json.transactions : {};
      const bookedRaw = isRecord(txObj) && Array.isArray((txObj as Record<string, unknown>)["booked"])
        ? ((txObj as Record<string, unknown>)["booked"] as unknown[]) : [];
      const pendingRaw = isRecord(txObj) && Array.isArray((txObj as Record<string, unknown>)["pending"])
        ? ((txObj as Record<string, unknown>)["pending"] as unknown[]) : [];

      for (const t of bookedRaw)  if (isRecord(t)) collected.push(t as unknown as BankAccountDataTx);
      for (const t of pendingRaw) if (isRecord(t)) collected.push(t as unknown as BankAccountDataTx);

      const nextVal = isRecord(json) ? json.next : null;
      txUrl = typeof nextVal === "string" && nextVal.length > 0 ? nextVal : "";
      pages++;
    }

    const rows: TxInsert[] = [];
    for (const t of collected) {
      const n = await normalizeTx(t, providerAccountId);

      const matchText = normalizeMatchText(`${n.description} ${n.counterparty}`);
      const { merchant_key } = detectMerchant(matchText, merch.patterns);

      let merchant_name: string | null = null;
      let alias_default: string | null = null;
      if (merchant_key && merch.aliases.has(merchant_key)) {
        const a = merch.aliases.get(merchant_key)!;
        merchant_name = a.display_name ?? (merchant_key ? titleCase(merchant_key) : null);
        alias_default = a.default_category ?? null;
      }

      let category = "uncategorized";
      let category_source: TxInsert["category_source"] = "rules";
      if (merchant_key && merch.overrides.has(merchant_key)) {
        category = merch.overrides.get(merchant_key)!;
        category_source = "user_override";
      } else if (alias_default && alias_default.trim()) {
        category = alias_default.trim();
        category_source = "alias_default";
      } else {
        try {
          const out = fallbackCategorize({ description: n.description, counterparty: n.counterparty, amount: n.amount });
          if (out && typeof out.category === "string" && out.category.trim()) category = out.category.trim();
        } catch { /* keep default */ }
      }
      let finalAmount = n.amount;
      if (/(^|_)credit/i.test(acctRow.type ?? "")) {
        finalAmount = -finalAmount;
      }


      rows.push({
        user_id: userId,
        bank_account_id: acctRow.id,
        transaction_id: n.transaction_id,
        description: n.description,
        amount: finalAmount,
        category,
        date: n.date,
        category_source,
        merchant_key: merchant_key ?? null,
        merchant_name,
      });
    }

    const uniq = new Map<string, TxInsert>();
    for (const r of rows) {
      const k = `${r.user_id}|${r.bank_account_id}|${r.transaction_id}`;
      if (!uniq.has(k)) uniq.set(k, r);
    }
    const deduped = Array.from(uniq.values());

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
          return new Response(JSON.stringify({
            error: "Database Error", code: "DB_UPSERT_FAILED", correlationId,
            details: { message: String(error.message || error) },
          }), { status: 500, headers: { "content-type": "application/json", ...allow(req) } });
        }
        upserted += Array.isArray(data) ? data.length : 0;
      }
    }

    const nextAllowed = new Date(Date.now() + env.MIN_INTERVAL_MIN * 60_000).toISOString();
    const statusNote = upserted === 0 ? "ok:0" : "ok";
    await supa.from("bank_accounts").update({
      last_sync_at: new Date().toISOString(),
      next_allowed_sync_at: nextAllowed,
      last_sync_status: statusNote,
    }).eq("id", bankAccountRowId).eq("user_id", userId);

    return new Response(JSON.stringify({
      ok: true, noop: false,
      bank_account_id: bankAccountRowId,
      fetched: collected.length,
      upserted,
      next_allowed_sync_at: nextAllowed,
      correlationId,
    }), { status: 200, headers: { "content-type": "application/json", ...allow(req) } });

  } catch (e: unknown) {
    return new Response(JSON.stringify({
      error: "Internal Server Error",
      code: "GC_SYNC_FAILURE",
      correlationId,
      details: { message: errMessage(e) },
    }), { status: 500, headers: { "content-type": "application/json", ...allow(req) } });
  }
});
