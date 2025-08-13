// supabase/functions/gc_complete/index.ts
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
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: allow(req) })

  const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  })
  const { data: { user } } = await supa.auth.getUser()
  if (!user) return new Response("Unauthorized", { status: 401, headers: allow(req) })

  const { requisition_id } = await req.json()

  // Find our connected_banks row by link_id (stateless callback)
  const { data: bankRow, error: bankErr } = await supa
    .from("connected_banks")
    .select("id, institution_id")
    .eq("link_id", requisition_id)
    .eq("user_id", user.id)
    .single()
  if (bankErr || !bankRow) return new Response("Unknown requisition", { status: 404, headers: allow(req) })

  const rqRes = await fetch(`${BASE}/requisitions/${requisition_id}/`, { headers: { Authorization: AUTH } })
  if (!rqRes.ok) return new Response(await rqRes.text(), { status: rqRes.status, headers: allow(req) })
  const rq = await rqRes.json()

  const accounts: string[] = rq.accounts ?? []

  // update status + consent window (we know we requested 180d)
  await supa.from("connected_banks")
    .update({
      status: rq.status ?? "active",
      consent_expires_at: new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString(),
    })
    .eq("id", bankRow.id)
    .eq("user_id", user.id)

  // Fetch account meta + details and upsert bank_accounts
  const metas = await Promise.all(accounts.map(async (id) => {
    const [metaRes, detRes] = await Promise.all([
      fetch(`${BASE}/accounts/${id}/`, { headers: { Authorization: AUTH } }),
      fetch(`${BASE}/accounts/${id}/details/`, { headers: { Authorization: AUTH } }),
    ])
    if (!metaRes.ok) throw new Error(await metaRes.text())
    if (!detRes.ok) throw new Error(await detRes.text())
    const meta = await metaRes.json()
    const details = await detRes.json()

    const name = details.account?.name ?? meta.account?.name ?? details.account?.displayName ?? "Account"
    const iban = details.account?.iban ?? meta.account?.iban ?? null
    const currency = details.account?.currency ?? meta.account?.currency ?? null
    const type = details.account?.type ?? meta.account?.product ?? null

    const { data: row } = await supa.from("bank_accounts").upsert({
      user_id: user.id,
      connected_bank_id: bankRow.id,
      provider: "gocardless",
      institution_id: bankRow.institution_id,
      account_id: id,
      name, iban, currency, type,
      is_selected: false,
    }, { onConflict: "user_id,provider,account_id" }).select("id").single()

    return { id, name, currency, iban, type, row_id: row?.id }
  }))

  return new Response(JSON.stringify({ accounts: metas }), {
    headers: { "content-type": "application/json", ...allow(req) },
  })
})
