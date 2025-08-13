// supabase/functions/gc_institutions/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const allow = (req: Request) => ({
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    req.headers.get("access-control-request-headers") ??
    "authorization, content-type, x-client-info",
  "access-control-allow-methods": "GET, OPTIONS",
})

const BASE = Deno.env.get("GC_BASE")!
const AUTH = "Bearer " + Deno.env.get("GC_SECRET_KEY")!
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: allow(req) })

  const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  })
  const { data: { user } } = await supa.auth.getUser()
  if (!user) return new Response("Unauthorized", { status: 401, headers: allow(req) })

  const url = new URL(req.url)
  const country = url.searchParams.get("country") ?? "SE"

  const r = await fetch(`${BASE}/institutions/?country=${country}`, { headers: { Authorization: AUTH } })
  if (!r.ok) return new Response(await r.text(), { status: r.status, headers: allow(req) })
  const json = await r.json()

  return new Response(JSON.stringify(json), { headers: { "content-type": "application/json", ...allow(req) }})
})
