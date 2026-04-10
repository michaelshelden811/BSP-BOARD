// pages/api/appointments/ingest.js
// Optional: called by n8n if you want an alternative to the Slack bot.
// Secured by x-webhook-secret header.

import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Verify webhook secret
  const secret = req.headers['x-webhook-secret']
  if (!secret || secret !== process.env.INGEST_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid webhook secret' })
  }

  const {
    appointment_type,
    clients,
    day,
    date,
    time,
    address,
    purpose,
    type,
    week_of,
    slack_message_id,
  } = req.body

  // Validate required fields
  const missing = []
  if (!appointment_type) missing.push('appointment_type')
  if (!day) missing.push('day')
  if (!date) missing.push('date')
  if (!time) missing.push('time')
  if (!week_of) missing.push('week_of')

  if (missing.length > 0) {
    return res.status(400).json({ error: 'Missing required fields: ' + missing.join(', ') })
  }

  const supabase = getSupabase()

  // Deduplicate by slack_message_id if provided
  if (slack_message_id) {
    const { data: existing } = await supabase
      .from('appointments')
      .select('id')
      .eq('slack_message_id', slack_message_id)
      .single()

    if (existing) {
      return res.status(200).json({ message: 'Duplicate — already ingested', id: existing.id })
    }
  }

  const { data: inserted, error } = await supabase
    .from('appointments')
    .insert({
      appointment_type,
      clients: clients || [],
      day,
      date,
      time,
      address: address || null,
      purpose: purpose || null,
      type: type || 'peer_support',
      week_of,
      slack_message_id: slack_message_id || null,
      status: 'open',
    })
    .select()
    .single()

  if (error) {
    console.error('ingest error:', error)
    return res.status(500).json({ error: 'Failed to save appointment' })
  }

  return res.status(201).json({ message: 'Appointment saved', appointment: inserted })
}
