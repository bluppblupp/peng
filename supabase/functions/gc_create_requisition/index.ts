// supabase/functions/gc_create_requisition/index.ts
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

  const { institution_id, redirect_url, bank_name } = await req.json()

  const euaRes = await fetch(`${BASE}/agreements/enduser/`, {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({
      max_historical_days: 365,
      access_valid_for_days: 180, // EEA
      access_scope: ["balances", "details", "transactions"],
    }),
  })
  if (!euaRes.ok) return new Response(await euaRes.text(), { status: euaRes.status, headers: allow(req) })
  const eua = await euaRes.json()

  const reqRes = await fetch(`${BASE}/requisitions/`, {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ redirect: redirect_url, institution_id, agreement: eua.id, user_language: "sv" }),
  })
  if (!reqRes.ok) return new Response(await reqRes.text(), { status: reqRes.status, headers: allow(req) })
  const rq = await reqRes.json()

  const { data: cb, error } = await supa.from("connected_banks").insert({
    user_id: user.id,
    bank_name: bank_name ?? "Bank",
    account_id: "",
    institution_id,
    is_active: true,
    provider: "gocardless",
    link_id: rq.id,        // we’ll use this on the callback
    country: "SE",
    status: "pending",
  }).select().single()
  if (error) return new Response(error.message, { status: 500, headers: allow(req) })

  return new Response(JSON.stringify({ link: rq.link, requisition_id: rq.id, connected_bank_id: cb.id }), {
    headers: { "content-type": "application/json", ...allow(req) },
  })
})
