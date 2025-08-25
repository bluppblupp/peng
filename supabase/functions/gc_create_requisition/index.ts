// supabase/functions/gc_create_requisition/index.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Define CORS headers directly inside the function to remove external dependency
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  // Handle CORS preflight request
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // --- 1. Environment Variables & Auth ---
    const { GOCARDLESS_BASE_URL, GOCARDLESS_SECRET_ID, GOCARDLESS_SECRET_KEY, SUPABASE_URL, SUPABASE_ANON_KEY } = Deno.env.toObject();
    if (!GOCARDLESS_BASE_URL || !GOCARDLESS_SECRET_ID || !GOCARDLESS_SECRET_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error("Missing one or more required environment variables.");
    }
    
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
      auth: { persistSession: false },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      throw new Error("User is not authenticated.");
    }

    const { institution_id, redirect_url, bank_name } = await req.json();
    if (!institution_id || !redirect_url) {
        throw new Error("Missing 'institution_id' or 'redirect_url' in the request body.");
    }

    // --- 2. Get Temporary GoCardless Access Token ---
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
    
    const tempAuthHeader = `Bearer ${accessToken}`;

    // --- 3. Create End-User Agreement ---
    const euaRes = await fetch(`${GOCARDLESS_BASE_URL}/agreements/enduser/`, {
      method: "POST",
      headers: { Authorization: tempAuthHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        max_historical_days: 365,
        access_valid_for_days: 180,
        access_scope: ["balances", "details", "transactions"],
        institution_id: institution_id, // Also required here
      }),
    });
    if (!euaRes.ok) {
      const text = await euaRes.text();
      throw new Error(`Failed to create end-user agreement: ${text}`);
    }
    const eua = await euaRes.json();

    // --- 4. Create Requisition ---
    const reqRes = await fetch(`${GOCARDLESS_BASE_URL}/requisitions/`, {
      method: "POST",
      headers: { Authorization: tempAuthHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ 
          redirect: redirect_url, 
          institution_id, 
          agreement: eua.id, 
          user_language: "en", // Using 'en' for broader compatibility
          reference: user.id // Optional: link requisition to your user ID
      }),
    });
    if (!reqRes.ok) {
      const text = await reqRes.text();
      throw new Error(`Failed to create requisition: ${text}`);
    }
    const rq = await reqRes.json();

    // --- 5. Save Record to Supabase ---
    const { data: cb, error } = await supabase.from("connected_banks").insert({
      user_id: user.id,
      bank_name: bank_name ?? "Bank",
      institution_id,
      provider: "gocardless",
      link_id: rq.id, // This is the requisition ID
      status: "pending",
    }).select().single();

    if (error) {
      throw new Error(`Failed to save connected bank record: ${error.message}`);
    }

    // --- 6. Return Success Response ---
    return new Response(JSON.stringify({ link: rq.link, requisition_id: rq.id, connected_bank_id: cb.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (err) {
    console.error("Error in gc_create_requisition:", err.message);
    return new Response(JSON.stringify({ error: "Internal Server Error", details: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
