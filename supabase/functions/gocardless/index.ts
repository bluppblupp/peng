const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const GOCARDLESS_BASE_URL = 'https://bankaccountdata.gocardless.com/api/v2'

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { action, ...params } = await req.json()
    
    // Check if we need to generate access token first
    const secretId = Deno.env.get('GOCARDLESS_SECRET_ID')
    const secretKey = Deno.env.get('GOCARDLESS_SECRET_KEY')
    let accessToken = Deno.env.get('GOCARDLESS_ACCESS_TOKEN')

    // If we have secret_id and secret_key but no access token, generate one
    if (secretId && secretKey && !accessToken) {
      console.log('Generating new access token...')
      const tokenResponse = await fetch(`${GOCARDLESS_BASE_URL}/token/new/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          secret_id: secretId,
          secret_key: secretKey
        })
      })
      
      if (!tokenResponse.ok) {
        console.error('Failed to generate access token:', await tokenResponse.text())
        throw new Error('Failed to generate GoCardless access token')
      }
      
      const tokenData = await tokenResponse.json()
      accessToken = tokenData.access
      console.log('Generated new access token successfully')
    }

    if (!accessToken) {
      throw new Error('GoCardless access token not available. Please provide either GOCARDLESS_ACCESS_TOKEN or GOCARDLESS_SECRET_ID/GOCARDLESS_SECRET_KEY')
    }

    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    }

    console.log(`GoCardless API call: ${action}`, params)

    switch (action) {
      case 'getInstitutions': {
        const { country = 'GB' } = params
        console.log(`Fetching institutions for country: ${country}`)
        const response = await fetch(`${GOCARDLESS_BASE_URL}/institutions/?country=${country}`, {
          headers
        })
        
        if (!response.ok) {
          console.error('GoCardless API error:', response.status, await response.text())
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }
        
        const data = await response.json()
        console.log('Institutions response:', data)
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      case 'createRequisition': {
  const { institutionId, redirectUrl } = params
  if (!institutionId) {
    return new Response(JSON.stringify({ error: 'institutionId is required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  if (!redirectUrl) {
    return new Response(JSON.stringify({ error: 'redirectUrl is required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const response = await fetch(`${GOCARDLESS_BASE_URL}/requisitions/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      institution_id: institutionId,
      redirect: redirectUrl,          // ✅ do not use window.location in Deno
      reference: `req_${Date.now()}`,
    })
  })

  if (!response.ok) {
    const text = await response.text()
    console.error('Requisition create failed:', response.status, text)
    return new Response(JSON.stringify({ error: `HTTP ${response.status}: ${text}` }), {
      status: response.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const data = await response.json()
  // data.link is the bank-auth URL you must send the user to
  return new Response(JSON.stringify({
    id: data.id,
    link: data.link,                  // ✅ bank-auth URL
    redirect: data.redirect,          // your return URL (FYI, not for navigation now)
    status: data.status
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

      case 'getRequisition': {
  const { requisitionId } = params
  const response = await fetch(`${GOCARDLESS_BASE_URL}/requisitions/${requisitionId}/`, { headers })
  if (!response.ok) {
    const text = await response.text()
    return new Response(JSON.stringify({ error: `HTTP ${response.status}: ${text}` }), {
      status: response.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  const data = await response.json()
  return new Response(JSON.stringify({
    id: data.id,
    institution_id: data.institution_id || data.institution?.id,
    accounts: data.accounts || [],
    redirect: data.redirect,
    status: data.status
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}


      case 'getAccountDetails': {
        const { accountId } = params
        const response = await fetch(`${GOCARDLESS_BASE_URL}/accounts/${accountId}/details/`, {
          headers
        })
        const data = await response.json()
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      case 'getAccountBalances': {
        const { accountId } = params
        const response = await fetch(`${GOCARDLESS_BASE_URL}/accounts/${accountId}/balances/`, {
          headers
        })
        const data = await response.json()
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      case 'getTransactions': {
        const { accountId, dateFrom, dateTo } = params
        let url = `${GOCARDLESS_BASE_URL}/accounts/${accountId}/transactions/`
        
        const queryParams = new URLSearchParams()
        if (dateFrom) queryParams.append('date_from', dateFrom)
        if (dateTo) queryParams.append('date_to', dateTo)
        
        if (queryParams.toString()) {
          url += `?${queryParams.toString()}`
        }

        const response = await fetch(url, { headers })
        const data = await response.json()
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      default:
        throw new Error(`Unknown action: ${action}`)
    }
  } catch (error) {
    console.error('GoCardless API error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})