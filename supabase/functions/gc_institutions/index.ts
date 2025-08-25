// supabase/functions/gc_institutions/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.0";

// --- CORS Headers ---
// Use a standard, robust CORS configuration to ensure headers are allowed.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS", // Allow necessary methods
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// --- Main Function Logic ---
Deno.serve(async (req) => {
  // Handle CORS preflight request immediately
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // --- Environment Variables ---
    const { GOCARDLESS_BASE_URL, GOCARDLESS_SECRET_ID, GOCARDLESS_SECRET_KEY, SUPABASE_URL, SUPABASE_ANON_KEY } = Deno.env.toObject();
    
    if (!GOCARDLESS_BASE_URL || !GOCARDLESS_SECRET_ID || !GOCARDLESS_SECRET_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error("Missing one or more required environment variables.");
    }
    
    // --- Supabase User Authentication ---
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
      auth: { persistSession: false },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      console.error("Supabase auth error:", authError?.message || "User not found");
      throw new Error(`Authentication failed: ${authError?.message || "Auth session missing"}`);
    }

    // --- Get Temporary GoCardless Access Token ---
    const tokenResponse = await fetch(`${GOCARDLESS_BASE_URL}/token/new/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
            secret_id: GOCARDLESS_SECRET_ID,
            secret_key: GOCARDLESS_SECRET_KEY,
        }),
    });

    if (!tokenResponse.ok) {
        const errorBody = await tokenResponse.text();
        throw new Error(`GoCardless token exchange failed: ${errorBody}`);
    }

    const { access: accessToken } = await tokenResponse.json();
    if (!accessToken) {
        throw new Error("Did not receive access token from GoCardless.");
    }

    // --- Fetch Institutions ---
    const url = new URL(req.url);
    const country = url.searchParams.get("country") || "SE";
    const institutionsResponse = await fetch(`${GOCARDLESS_BASE_URL}/institutions/?country=${encodeURIComponent(country)}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });

    if (!institutionsResponse.ok) {
        const errorBody = await institutionsResponse.text();
        throw new Error(`Failed to fetch institutions: ${errorBody}`);
    }

    const institutions = await institutionsResponse.json();
    return new Response(JSON.stringify(institutions), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });

  } catch (err) {
    console.error("Error in gc_institutions function:", err.message);
    return new Response(JSON.stringify({ error: "Internal Server Error", details: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
