// pages/api/cron/heartbeat.js
// Daily freshness check for the appointment pipeline.
//
// Why this exists: in June 2026 the Slack ingestion path died and nothing was
// written to the appointments table for twelve weeks. Nobody found out. This
// job asks one question daily — "when did we last receive an appointment?" —
// and DMs Michael when the answer is too old.
//
// It is deliberately silent when healthy, so an alert always means something.
//
// It also pings an external dead-man's-switch service on every successful run.
// That service alerts when the pings STOP, which is the only way to catch this
// job itself failing to run.

import { createClient } from '@supabase/supabase-js'

const STALE_DAYS = parseInt(process.env.HEARTBEAT_STALE_DAYS || '4', 10)
const ALERT_USER_ID = process.env.SLACK_ALERT_USER_ID || 'U09DXKUCLH2'
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://bsp-board-neon.vercel.app'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function sendDM(userId, text) {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) {
    console.error('[BSP heartbeat] SLACK_BOT_TOKEN missing — cannot alert')
    return false
  }

  const openResp = await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ users: userId }),
  })
  const openJson = await openResp.json()
  if (!openJson.ok) {
    console.error('[BSP heartbeat] conversations.open failed:', openJson.error)
    return false
  }

  const msgResp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel: openJson.channel.id, text, mrkdwn: true }),
  })
  const msgJson = await msgResp.json()
  if (!msgJson.ok) {
    console.error('[BSP heartbeat] chat.postMessage failed:', msgJson.error)
    return false
  }
  return true
}

// Dead-man's switch: the external service alerts when these pings stop arriving.
async function pingDeadMansSwitch() {
  const url = process.env.HEARTBEAT_PING_URL
  if (!url) {
    console.log('[BSP heartbeat] HEARTBEAT_PING_URL not set — skipping external ping')
    return
  }
  try {
    await fetch(url, { method: 'GET' })
    console.log('[BSP heartbeat] External ping sent')
  } catch (err) {
    console.error('[BSP heartbeat] External ping failed:', err.message)
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end()

  // Vercel Cron sends: Authorization: Bearer <CRON_SECRET>
  // Refuse to run unprotected — an open endpoint here is an alert-spam channel.
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[BSP heartbeat] CRON_SECRET is not configured — refusing to run')
    return res.status(500).json({ error: 'CRON_SECRET not configured' })
  }
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('appointments')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(1)

  if (error) {
    console.error('[BSP heartbeat] Supabase query failed:', error.message)
    await sendDM(
      ALERT_USER_ID,
      `🚨 *BSP Board heartbeat failed.*\nCould not read the appointments table: ${error.message}\n\nThe board may be down. Check Supabase.`
    )
    return res.status(500).json({ error: error.message })
  }

  const newest = data && data.length > 0 ? data[0].created_at : null

  if (!newest) {
    console.warn('[BSP heartbeat] appointments table is empty')
    await sendDM(
      ALERT_USER_ID,
      `⚠️ *BSP Board:* the appointments table is completely empty. Nothing has ever been ingested. Check the Slack connection.`
    )
    await pingDeadMansSwitch()
    return res.status(200).json({ ok: true, healthy: false, reason: 'empty table' })
  }

  const ageMs = Date.now() - new Date(newest).getTime()
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24))
  const healthy = ageDays < STALE_DAYS

  console.log('[BSP heartbeat] Newest appointment:', newest, '| age (days):', ageDays, '| healthy:', healthy)

  if (!healthy) {
    const lastSeen = new Date(newest).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    })
    await sendDM(
      ALERT_USER_ID,
      `⚠️ *BSP Board — no new appointments in ${ageDays} days.*\n` +
        `Last one received: *${lastSeen}*\n\n` +
        `Either nobody has posted a schedule, or the Slack pipeline is broken again.\n` +
        `Quick check: post an appointment in the channel and see if the bot replies.\n` +
        `Board: ${APP_URL}/appointments`
    )
  }

  // Ping last: reaching here means the job itself ran end to end.
  await pingDeadMansSwitch()

  return res.status(200).json({ ok: true, healthy, ageDays, newest })
}
