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
  const {
    data: { user },
  } = await supa.auth.getUser()
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", ...allow(req) },
    })
  }

  const url = new URL(req.url)
  const country = url.searchParams.get("country") ?? "SE"

  let r: Response
  try {
    r = await fetch(`${BASE}/institutions/?country=${country}`, {
      headers: { Authorization: AUTH },
    })
  } catch (err) {
    console.error("gc_institutions fetch failed:", err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 502,
      headers: { "content-type": "application/json", ...allow(req) },
    })
  }

  const text = await r.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    console.error("gc_institutions upstream non-json:", text)
    json = { error: text }
  }
  return new Response(JSON.stringify(json), {
    status: r.status,
    headers: { "content-type": "application/json", ...allow(req) },
  })
})
