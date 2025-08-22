// supabase/functions/gc_sync/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const allow = (req: Request) => ({
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    req.headers.get("access-control-request-headers") ??
    "authorization, content-type, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
})

const BASE = Deno.env.get("GC_BASE")!
const AUTH = "Bearer " + Deno.env.get("GC_SECRET_KEY")!
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: allow(req) })
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", ...allow(req) },
    })
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  })
  const { data: { user } } = await supa.auth.getUser()
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", ...allow(req) },
    })
  }

  try {
    const { bank_account_id, date_from } = await req.json()

    const { data: acct, error } = await supa.from("bank_accounts")
      .select("id, account_id")
      .eq("id", bank_account_id)
      .eq("user_id", user.id)
      .single()
    if (error || !acct) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json", ...allow(req) },
      })
    }

    const qs = new URLSearchParams()
    if (date_from) qs.set("date_from", date_from)

    const txRes = await fetch(`${BASE}/accounts/${acct.account_id}/transactions/?${qs}`, {
      headers: { Authorization: AUTH },
    })
    if (!txRes.ok) {
      const text = await txRes.text()
      return new Response(JSON.stringify({ error: text }), {
        status: txRes.status,
        headers: { "content-type": "application/json", ...allow(req) },
      })
    }
    const txr = await txRes.json()

    const booked = txr.transactions?.booked ?? []
    const pending = txr.transactions?.pending ?? []
    const all = [...booked, ...pending]

    type Tx = {
      internalTransactionId?: string
      transactionId?: string
      transactionAmount?: { amount?: number }
      amount?: { value?: number }
      remittanceInformationUnstructured?: string
      additionalInformation?: string
      creditorName?: string
      debtorName?: string
      bankTransactionCode?: string
      bookingDate?: string
      valueDate?: string
    }

    const rows = all.map((t: Tx) => {
      const txid = t.internalTransactionId ?? t.transactionId ?? crypto.randomUUID()
      const amount = String(t.transactionAmount?.amount ?? t.amount?.value ?? "0")
      const descr =
        t.remittanceInformationUnstructured ??
        t.additionalInformation ??
        t.creditorName ??
        t.debtorName ??
        t.bankTransactionCode ??
        "Transaction"
      const date = t.bookingDate ?? t.valueDate ?? new Date().toISOString().slice(0, 10)
      return { user_id: user.id, bank_account_id, transaction_id: txid, description: descr, amount, category: "Other", date }
    })

    const { error: insErr } = await supa.from("transactions").upsert(rows, {
      onConflict: "user_id,bank_account_id,transaction_id",
      ignoreDuplicates: true,
    })
    if (insErr) {
      return new Response(JSON.stringify({ error: insErr.message }), {
        status: 500,
        headers: { "content-type": "application/json", ...allow(req) },
      })
    }

    await supa.from("bank_accounts").update({ last_synced_at: new Date().toISOString() }).eq("id", bank_account_id)

    return new Response(JSON.stringify({ inserted: rows.length }), {
      headers: { "content-type": "application/json", ...allow(req) },
    })
  } catch (err) {
    console.error("gc_sync failed:", err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json", ...allow(req) },
    })
  }
})
