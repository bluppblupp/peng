// supabase/functions/test_auth/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  console.log('=== AUTH TEST FUNCTION ===')
  console.log('Request method:', req.method)
  console.log('Request URL:', req.url)

  try {
    // Get the authorization header
    const authHeader = req.headers.get("Authorization")
    console.log('Authorization header present:', !!authHeader)
    console.log('Authorization header value:', authHeader ? `${authHeader.substring(0, 20)}...` : 'null')

    if (!authHeader) {
      return new Response(JSON.stringify({ 
        error: "No authorization header",
        headers: Object.fromEntries(req.headers.entries())
      }), {
        status: 401,
        headers: { ...corsHeaders, "content-type": "application/json" },
      })
    }

    // Create Supabase client
    const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    
    console.log('Created Supabase client')

    // Try to get the user
    const { data: { user }, error: userError } = await supa.auth.getUser()
    
    console.log('User lookup result:')
    console.log('- User ID:', user?.id)
    console.log('- User email:', user?.email)
    console.log('- Error:', userError)

    if (userError) {
      return new Response(JSON.stringify({ 
        error: "User lookup failed", 
        details: userError.message,
        code: userError.status
      }), {
        status: 401,
        headers: { ...corsHeaders, "content-type": "application/json" },
      })
    }
    
    if (!user) {
      return new Response(JSON.stringify({ 
        error: "No user found in token",
        authHeader: authHeader ? `${authHeader.substring(0, 20)}...` : null
      }), {
        status: 401,
        headers: { ...corsHeaders, "content-type": "application/json" },
      })
    }

    // Success!
    return new Response(JSON.stringify({ 
      success: true,
      user: {
        id: user.id,
        email: user.email,
        created_at: user.created_at
      },
      timestamp: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, "content-type": "application/json" },
    })

  } catch (error) {
    console.error("Test function error:", error)
    return new Response(JSON.stringify({ 
      error: "Function error", 
      details: error.message,
      stack: error.stack
    }), {
      status: 500,
      headers: { ...corsHeaders, "content-type": "application/json" },
    })
  }
})