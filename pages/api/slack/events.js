// pages/api/slack/events.js
// Receives Slack event subscriptions.
// Supervisor posts a schedule message in the designated channel →
// OpenAI parses it into appointments → saved to Supabase → bot posts link back.

import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

// Disable Next.js body parsing so we can read raw bytes for signature verification
export const config = { api: { bodyParser: false } }

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
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
  // Reject if timestamp is more than 5 minutes old (replay attack prevention)
  const fiveMinAgo = Math.floor(Date.now() / 1000) - 60 * 5
  if (parseInt(timestamp, 10) < fiveMinAgo) return false

  const base = `v0:${timestamp}:${rawBody}`
  const expected = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(base)
    .digest('hex')

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
  if (!token) return
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel: channelId, text }),
  })
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
  try {
    return JSON.parse(raw)
  } catch {
    // Try stripping markdown fences if model ignored instructions
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

  // ── Slack URL verification challenge (one-time setup) ──────────────────────
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge })
  }

  // ── Verify Slack signature ─────────────────────────────────────────────────
  const signingSecret = process.env.SLACK_SIGNING_SECRET
  const timestamp = req.headers['x-slack-request-timestamp']
  const signature = req.headers['x-slack-signature']

  if (!signingSecret || !timestamp || !signature) {
    return res.status(401).json({ error: 'Missing Slack signature headers' })
  }

  if (!verifySlackSignature(rawBody, timestamp, signature, signingSecret)) {
    return res.status(401).json({ error: 'Invalid signature' })
  }

  // ── Ignore Slack retries (already processing) ──────────────────────────────
  if (req.headers['x-slack-retry-num']) {
    return res.status(200).json({ ok: true })
  }

  const event = body.event
  if (!event) return res.status(200).json({ ok: true })

  // ── Only handle real user messages ─────────────────────────────────────────
  if (
    event.type !== 'message' ||
    event.subtype === 'bot_message' ||
    event.bot_id ||
    !event.text
  ) {
    return res.status(200).json({ ok: true })
  }

  // ── Only process messages in the designated channel ────────────────────────
  const allowedChannel = process.env.SLACK_CHANNEL_ID
  if (allowedChannel && event.channel !== allowedChannel) {
    return res.status(200).json({ ok: true })
  }

  const text = event.text.trim()

  // ── Keyword check — must look like a schedule post ─────────────────────────
  const lower = text.toLowerCase()
  const isSchedule =
    lower.includes('schedule') ||
    lower.includes('appt') ||
    lower.includes('appointment') ||
    lower.includes('visit') ||
    lower.includes('week of') ||
    lower.includes('next week')

  if (!isSchedule) {
    return res.status(200).json({ ok: true })
  }

  // ── Parse with OpenAI ──────────────────────────────────────────────────────
  const today = new Date().toISOString().split('T')[0]
  let appointments
  try {
    appointments = await parseScheduleWithAI(text, today)
  } catch (err) {
    console.error('OpenAI parse error:', err)
    await postToSlack(event.channel, '⚠️ BSP Board: I couldn\'t parse that schedule. Please check the format and try again.')
    return res.status(200).json({ ok: true })
  }

  if (!Array.isArray(appointments) || appointments.length === 0) {
    await postToSlack(event.channel, '⚠️ BSP Board: No appointments found in that message. Make sure to include days, times, and at least one appointment.')
    return res.status(200).json({ ok: true })
  }

  // ── Save to Supabase ───────────────────────────────────────────────────────
  const supabase = getSupabase()
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bsp-board.vercel.app'

  const rows = appointments.map(a => {
    const weekOf = a.date ? getMondayOf(a.date) : getMondayOf(today)
    return {
      appointment_type: a.appointment_type || 'Visit',
      day: a.day,
      date: a.date,
      time: a.time,
      address: a.address || null,
      purpose: a.purpose || null,
      clients: a.client_name ? [a.client_name] : [],
      week_of: weekOf,
      status: 'open',
      slack_message_id: event.ts || null,
      type: 'peer_support',
    }
  })

  const { data: inserted, error } = await supabase
    .from('appointments')
    .insert(rows)
    .select()

  if (error) {
    console.error('Supabase insert error:', error)
    await postToSlack(event.channel, '⚠️ BSP Board: Schedule parsed but failed to save. Please try again or contact admin.')
    return res.status(200).json({ ok: true })
  }

  // ── Post confirmation back to Slack ────────────────────────────────────────
  const count = inserted.length
  const weekOf = rows[0]?.week_of
  const weekLabel = weekOf
    ? new Date(weekOf + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'this week'

  const boardUrl = `${appUrl}/appointments?week=${weekOf || ''}`

  await postToSlack(
    event.channel,
    `✅ *BSP Board:* ${count} slot${count !== 1 ? 's' : ''} posted for the week of ${weekLabel}!\n👉 *Claim your slots here:* ${boardUrl}`
  )

  return res.status(200).json({ ok: true, inserted: count })
}
