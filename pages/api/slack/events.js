// pages/api/slack/events.js
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

export const config = { api: { bodyParser: false } }

const AGENCY_ID = '2fa5f554-7a8e-4a18-8167-aaff152890f3'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
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

async function postToSlack(channelId, text) {
  const token = process.env.SLACK_BOT_TOKEN
  console.log('[BSP] postToSlack — token present:', !!token, '— channel:', channelId)
  if (!token) {
    console.error('[BSP] SLACK_BOT_TOKEN is missing — cannot post reply')
    return
  }
  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel: channelId, text }),
  })
  const json = await resp.json()
  console.log('[BSP] Slack postMessage result:', JSON.stringify(json))
}

async function parseScheduleWithAI(messageText, today) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const prompt = `You are parsing a peer support scheduling message from a supervisor at a recovery housing agency.

Today's date is ${today}. Extract all appointments from the message below.

Return a JSON array of appointment objects. Each object must have:
- "day": day of week (Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday)
- "date": date in YYYY-MM-DD format
- "time": time in HH:MM 24-hour format (e.g. "09:00", "14:30")
- "client_name": client's name (string, or null if not specified)
- "address": address or location (string, or null)
- "appointment_type": type of visit (e.g. "Home Visit", "Check-in", "Transport", "Office Visit", "Court", "Medical")
- "purpose": brief description of purpose (string, or null)

Rules:
- If the year is not given, assume the nearest upcoming date for that day of week.
- If only a week is referenced (e.g. "next week" or "week of April 14"), use dates accordingly.
- Return ONLY the raw JSON array — no markdown, no explanation, no code fences.
- If no appointments can be parsed, return an empty array [].

Message:
${messageText}`

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
  })
  const raw = response.choices[0].message.content.trim()
  console.log('[BSP] OpenAI raw response:', raw.slice(0, 200))
  try {
    return JSON.parse(raw)
  } catch {
    const stripped = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim()
    return JSON.parse(stripped)
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const rawBody = await getRawBody(req)
  let body
  try {
    body = JSON.parse(rawBody)
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' })
  }

  // Slack URL verification challenge
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge })
  }

  // Verify signature
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

  // Ignore Slack retries
  if (req.headers['x-slack-retry-num']) {
    console.log('[BSP] Ignoring Slack retry')
    return res.status(200).json({ ok: true })
  }

  const event = body.event
  if (!event) return res.status(200).json({ ok: true })

  console.log('[BSP] Event type:', event.type, '| subtype:', event.subtype, '| bot_id:', event.bot_id, '| channel:', event.channel)

  // Only handle real user messages
  if (event.type !== 'message' || event.subtype === 'bot_message' || event.bot_id || !event.text) {
    console.log('[BSP] Skipping — not a user message')
    return res.status(200).json({ ok: true })
  }

  // Channel filter
  const allowedChannel = process.env.SLACK_CHANNEL_ID
  console.log('[BSP] allowedChannel:', allowedChannel, '| event.channel:', event.channel, '| match:', event.channel === allowedChannel)
  if (allowedChannel && event.channel !== allowedChannel) {
    console.log('[BSP] Skipping — wrong channel')
    return res.status(200).json({ ok: true })
  }

  const text = event.text.trim()
  console.log('[BSP] Message text preview:', text.slice(0, 100))

  // Keyword check
  const lower = text.toLowerCase()
  const isSchedule =
    lower.includes('schedule') ||
    lower.includes('appt') ||
    lower.includes('appointment') ||
    lower.includes('visit') ||
    lower.includes('week of') ||
    lower.includes('next week')

  console.log('[BSP] isSchedule:', isSchedule)
  if (!isSchedule) {
    console.log('[BSP] Skipping — no schedule keywords')
    return res.status(200).json({ ok: true })
  }

  // Parse with OpenAI
  const today = new Date().toISOString().split('T')[0]
  let appointments
  try {
    appointments = await parseScheduleWithAI(text, today)
    console.log('[BSP] Parsed', appointments.length, 'appointments')
  } catch (err) {
    console.error('[BSP] OpenAI parse error:', err.message)
    await postToSlack(event.channel, "⚠️ BSP Board: I couldn't parse that schedule. Please check the format and try again.")
    return res.status(200).json({ ok: true })
  }

  if (!Array.isArray(appointments) || appointments.length === 0) {
    console.log('[BSP] No appointments found in message')
    await postToSlack(event.channel, '⚠️ BSP Board: No appointments found in that message. Make sure to include days, times, and at least one appointment.')
    return res.status(200).json({ ok: true })
  }

  // Save to Supabase
  const supabase = getSupabase()
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bsp-board-neon.vercel.app'

  const rows = appointments.map((a, i) => {
    const weekOf = a.date ? getMondayOf(a.date) : getMondayOf(today)
    return {
      agency_id: AGENCY_ID,
      appointment_type: a.appointment_type || 'Visit',
      day: a.day,
      date: a.date,
      time: a.time,
      address: a.address || null,
      purpose: a.purpose || null,
      clients: a.client_name ? [a.client_name] : [],
      week_of: weekOf,
      status: 'open',
      slack_message_id: event.ts ? `${event.ts}_${i}` : null,
      type: 'peer_support',
    }
  })

  const { data: inserted, error } = await supabase.from('appointments').insert(rows).select()
  if (error) {
    console.error('[BSP] Supabase insert error:', error)
    await postToSlack(event.channel, '⚠️ BSP Board: Schedule parsed but failed to save. Error: ' + error.message)
    return res.status(200).json({ ok: true })
  }

  const count = inserted.length
  const weekOf = rows[0]?.week_of
  const weekLabel = weekOf
    ? new Date(weekOf + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'this week'
  const boardUrl = `${appUrl}/appointments?week=${weekOf || ''}`

  console.log('[BSP] Inserted', count, 'rows. Posting reply to channel', event.channel)
  await postToSlack(event.channel, `✅ *BSP Board:* ${count} slot${count !== 1 ? 's' : ''} posted for the week of ${weekLabel}!\n👉 *C