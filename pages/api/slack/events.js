// pages/api/slack/events.js
// Slack Events API endpoint for BSP Board.
//
// Slack requires a response within 3 seconds. All slow work (OpenAI parsing,
// Supabase writes, posting back to Slack) runs in the background via
// waitUntil() AFTER the 200 has already been sent.

import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { waitUntil } from '@vercel/functions'
import OpenAI from 'openai'

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://bsp-board-neon.vercel.app'
const AGENCY_NAME = 'Barbell Saves Project'

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function getAgencyId(supabase) {
  const { data, error } = await supabase
    .from('agencies')
    .select('id')
    .eq('name', AGENCY_NAME)
    .single()
  if (error || !data) throw new Error('Agency not found: ' + (error?.message || 'no row'))
  return data.id
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function verifySlackSignature(rawBody, timestamp, signature, signingSecret) {
  const fiveMinAgo = Math.floor(Date.now() / 1000) - 60 * 5
  if (parseInt(timestamp, 10) < fiveMinAgo) return false
  const base = `v0:${timestamp}:${rawBody}`
  const expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}

function getMondayOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  const day = d.getDay()
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day))
  return d.toISOString().split('T')[0]
}

async function postToSlack(channelId, text, threadTs) {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) {
    console.error('[BSP] SLACK_BOT_TOKEN missing — cannot post reply')
    return
  }
  const payload = { channel: channelId, text, mrkdwn: true }
  if (threadTs) payload.thread_ts = threadTs

  try {
    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
    const json = await resp.json()
    if (!json.ok) console.error('[BSP] chat.postMessage failed:', json.error)
  } catch (err) {
    console.error('[BSP] chat.postMessage threw:', err.message)
  }
}

async function parseScheduleWithAI(messageText, today) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const prompt = `You are parsing a peer support appointment message from a house manager at a recovery housing agency.

Today's date is ${today}. Extract all appointments from the message below.

Return a JSON array of appointment objects. Each object must have:
- "day": day of week (Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday)
- "date": date in YYYY-MM-DD format
- "time": time in HH:MM 24-hour format (e.g. "09:00", "14:30")
- "client_name": client first name or full name (string, or null)
- "address": address or location name (string, or null)
- "appointment_type": type of appointment (e.g. "Medical", "Probation", "Court", "DES", "Employment", "Home Visit")
- "purpose": brief description (string, or null)

Rules:
- If the year is not given, assume the nearest upcoming date for that day of week.
- Return ONLY the raw JSON array — no markdown, no explanation, no code fences.
- If no appointments can be parsed, return [].

Message:
${messageText}`

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
  })

  const raw = response.choices[0].message.content.trim()
  try {
    return JSON.parse(raw)
  } catch {
    const stripped = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim()
    return JSON.parse(stripped)
  }
}

// ── Background work (runs after the 200 is sent) ──────────────────────────────

async function processScheduleMessage(event) {
  const channel = event.channel
  const threadTs = event.ts
  const text = event.text.trim()
  const today = new Date().toISOString().split('T')[0]

  let appointments
  try {
    appointments = await parseScheduleWithAI(text, today)
    console.log('[BSP] Parsed', appointments.length, 'appointments')
  } catch (err) {
    console.error('[BSP] OpenAI parse error:', err.message)
    await postToSlack(channel, "⚠️ *BSP Board:* I couldn't parse that appointment. Please check the format.", threadTs)
    return
  }

  if (!Array.isArray(appointments) || appointments.length === 0) {
    console.log('[BSP] No appointments found in message')
    await postToSlack(channel, '⚠️ *BSP Board:* No appointments found. Include a day, a time, and a client.', threadTs)
    return
  }

  const supabase = getSupabase()

  let agencyId
  try {
    agencyId = await getAgencyId(supabase)
  } catch (err) {
    console.error('[BSP] Could not resolve agency_id:', err.message)
    await postToSlack(channel, '⚠️ *BSP Board:* Agency not found in database. Contact your admin.', threadTs)
    return
  }

  const rows = appointments.map((a, i) => {
    const weekOf = a.date ? getMondayOf(a.date) : getMondayOf(today)
    return {
      agency_id: agencyId,
      appointment_type: a.appointment_type || 'Appointment',
      clients: a.client_name ? [a.client_name] : [],
      day: a.day,
      date: a.date,
      time: a.time,
      address: a.address || null,
      purpose: a.purpose || null,
      type: 'individual',
      week_of: weekOf,
      status: 'open',
      slack_message_id: event.ts ? `${event.ts}_${i}` : null,
    }
  })

  const { data: inserted, error } = await supabase.from('appointments').insert(rows).select()

  if (error) {
    // 23505 = unique violation: this Slack message was already ingested.
    if (error.code === '23505') {
      console.log('[BSP] Duplicate message — already ingested, skipping')
      return
    }
    console.error('[BSP] Supabase insert error:', error)
    await postToSlack(channel, '⚠️ *BSP Board:* Parsed but failed to save. Error: ' + error.message, threadTs)
    return
  }

  const count = inserted.length
  const weekOf = rows[0]?.week_of
  const weekLabel = weekOf
    ? new Date(weekOf + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'this week'
  const boardUrl = weekOf ? `${APP_URL}/appointments?week=${weekOf}` : `${APP_URL}/appointments`

  console.log('[BSP] Inserted', count, 'rows for week', weekOf)
  await postToSlack(
    channel,
    `✅ *BSP Board:* ${count} slot${count !== 1 ? 's' : ''} posted for the week of ${weekLabel}!\n👉 *Claim yours:* ${boardUrl}`,
    threadTs
  )
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const rawBody = await getRawBody(req)
  let body
  try {
    body = JSON.parse(rawBody)
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' })
  }

  // Slack Request URL verification handshake
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge })
  }

  // Verify the request really came from Slack
  const signingSecret = process.env.SLACK_SIGNING_SECRET
  const timestamp = req.headers['x-slack-request-timestamp']
  const signature = req.headers['x-slack-signature']

  if (!signingSecret || !timestamp || !signature) {
    console.error('[BSP] Missing signature headers')
    return res.status(401).json({ error: 'Missing Slack signature headers' })
  }
  if (!verifySlackSignature(rawBody, timestamp, signature, signingSecret)) {
    console.error('[BSP] Signature verification failed')
    return res.status(401).json({ error: 'Invalid signature' })
  }

  // Slack retries a delivery it thinks failed — never double-process.
  if (req.headers['x-slack-retry-num']) {
    console.log('[BSP] Ignoring Slack retry')
    return res.status(200).json({ ok: true })
  }

  const event = body.event
  if (!event) return res.status(200).json({ ok: true })

  // Only real human messages
  if (event.type !== 'message' || event.subtype || event.bot_id || !event.text) {
    return res.status(200).json({ ok: true })
  }

  // Only the appointments channel
  const allowedChannel = process.env.SLACK_CHANNEL_ID
  if (allowedChannel && event.channel !== allowedChannel) {
    return res.status(200).json({ ok: true })
  }

  // Only messages that are actually about appointments
  const lower = event.text.toLowerCase()
  if (!lower.includes('appointment') && !lower.includes('appt')) {
    return res.status(200).json({ ok: true })
  }

  console.log('[BSP] Accepted message ts:', event.ts, '| preview:', event.text.slice(0, 80))

  // Hand the slow work to the background, then answer Slack immediately.
  waitUntil(
    processScheduleMessage(event).catch(err => {
      console.error('[BSP] Background processing failed:', err)
    })
  )

  return res.status(200).json({ ok: true })
}
