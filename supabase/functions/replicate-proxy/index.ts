import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Get the authorization header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      throw new Error('Missing authorization header')
    }

    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    )

    // Verify the user is authenticated
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token)
    
    if (authError || !user) {
      console.error('Authentication failed:', authError)
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }), 
        { 
          status: 401, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // Check if user email is from @cloudwalk.io domain
    if (!user.email?.endsWith('@cloudwalk.io')) {
      console.error('Access denied - not a Cloudwalk email:', user.email)
      return new Response(
        JSON.stringify({ error: 'Access denied - Cloudwalk employees only' }), 
        { 
          status: 403, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    console.log('✅ Authenticated user:', user.email)

    // Get Replicate API key from environment
    const replicateApiKey = Deno.env.get('REPLICATE_API_TOKEN')
    if (!replicateApiKey) {
      console.error('❌ REPLICATE_API_TOKEN environment variable not set')
      return new Response(
        JSON.stringify({ error: 'Replicate API key not configured' }), 
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // Get the request body
    const requestBody = await req.json()
    console.log('🔄 Proxying Replicate request for user:', user.email)
    console.log('📝 Model:', requestBody.model)

    // Build the Replicate API URL
    const replicateUrl = `https://api.replicate.com/v1/models/${requestBody.model}/predictions`

    // Make request to Replicate
    const response = await fetch(replicateUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${replicateApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: requestBody.input
      }),
    })

    const responseData = await response.json()

    if (!response.ok) {
      console.error('❌ Replicate API error:', response.status, responseData)
      return new Response(
        JSON.stringify(responseData), 
        { 
          status: response.status, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    console.log('✅ Replicate request successful, prediction ID:', responseData.id)

    // Poll for completion if this is a prediction that needs polling
    if (responseData.status === 'starting' || responseData.status === 'processing') {
      const predictionId = responseData.id
      console.log('🔄 Polling for prediction completion:', predictionId)
      
      // Poll every 2 seconds for up to 2 minutes
      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000))
        
        const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
          headers: {
            'Authorization': `Bearer ${replicateApiKey}`,
          },
        })
        
        const pollData = await pollResponse.json()
        console.log(`⏳ Poll ${i + 1}/60 - Status: ${pollData.status}`)
        
        if (pollData.status === 'succeeded') {
          console.log('✅ Prediction completed successfully')
          console.log('📸 Output URLs:', pollData.output)
          return new Response(
            JSON.stringify(pollData), 
            { 
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
          )
        } else if (pollData.status === 'failed' || pollData.status === 'canceled') {
          console.error('❌ Prediction failed:', pollData.error)
          return new Response(
            JSON.stringify(pollData), 
            { 
              status: 500, 
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
          )
        }
      }
      
      // Timeout after 2 minutes
      console.error('⏰ Prediction timed out after 2 minutes')
      return new Response(
        JSON.stringify({ error: 'Prediction timed out' }), 
        { 
          status: 408, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // Return immediate result if no polling needed
    console.log('✅ Immediate response (no polling needed)')
    console.log('📸 Immediate output:', responseData.output)
    return new Response(
      JSON.stringify(responseData), 
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('❌ Error in replicate-proxy:', error)
    return new Response(
      JSON.stringify({ error: error.message }), 
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})
