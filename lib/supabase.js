// lib/supabase.js
import { createClient } from '@supabase/supabase-js'

// Browser singleton — used in client components
let _client = null
export function createSupabaseClient() {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )
  }
  return _client
}

// Server-side client — used in getServerSideProps and API routes
// Passes the user's JWT so RLS applies correctly. No service role key needed.
export function createServerClient(token) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      global: {
        headers: { Authorization: 'Bearer ' + token }
      },
      auth: { persistSession: false }
    }
  )
}
