# Slack Setup for BSP Board

This connects your Slack workspace to BSP Board so supervisors can post a schedule and it automatically appears on the board for peers to claim.

---

## How It Works

1. Supervisor types the weekly schedule in the `#scheduling` Slack channel
2. BSP Board reads the message, parses it with AI, and creates the appointment slots
3. Bot posts back a link: **"✅ 8 slots posted! Claim yours → [link]"**
4. Peers click the link, enter their name, and commit to slots

---

## Step 1 — Create the Slack App

1. Go to **https://api.slack.com/apps** (sign in with your BSP Slack account)
2. Click **"Create New App"**
3. Choose **"From scratch"**
4. App Name: `BSP Board`
5. Workspace: Select your BSP workspace
6. Click **"Create App"**

---

## Step 2 — Get Your Signing Secret

1. In the left sidebar, click **"Basic Information"**
2. Scroll down to **"App Credentials"**
3. Copy the **"Signing Secret"**
4. Paste it into `.env.local`:
   ```
   SLACK_SIGNING_SECRET=paste_here
   ```

---

## Step 3 — Add Bot Permissions

1. In the left sidebar, click **"OAuth & Permissions"**
2. Scroll down to **"Bot Token Scopes"**
3. Click **"Add an OAuth Scope"** and add these three:
   - `channels:history` — read messages in channels
   - `chat:write` — post messages back
   - `channels:read` — see channel info
4. Scroll back up and click **"Install to Workspace"**
5. Click **"Allow"**
6. Copy the **"Bot User OAuth Token"** (starts with `xoxb-`)
7. Paste it into `.env.local`:
   ```
   SLACK_BOT_TOKEN=xoxb-paste-here
   ```

---

## Step 4 — Deploy to Vercel (needed for Slack to reach your app)

1. Push your code to GitHub
2. Go to **vercel.com** → New Project → import your repo
3. Add all your `.env.local` variables in the Vercel Environment Variables section
4. Deploy
5. Your app URL will be something like `https://bsp-board.vercel.app`
6. Update `.env.local` (and Vercel env vars):
   ```
   NEXT_PUBLIC_APP_URL=https://bsp-board.vercel.app
   ```

---

## Step 5 — Enable Event Subscriptions

1. In your Slack App, click **"Event Subscriptions"** in the left sidebar
2. Toggle **"Enable Events"** to ON
3. In the **"Request URL"** box, paste:
   ```
   https://bsp-board.vercel.app/api/slack/events
   ```
4. Slack will send a test request — it should show **"Verified ✓"** automatically
5. Scroll down to **"Subscribe to bot events"**
6. Click **"Add Bot User Event"** and add: `message.channels`
7. Click **"Save Changes"**

---

## Step 6 — Invite the Bot to Your Channel

1. In Slack, go to your `#scheduling` channel (or whatever channel supervisors use)
2. Type: `/invite @BSP Board`
3. The bot is now listening in that channel

---

## Step 7 — Get the Channel ID

1. In Slack, right-click your scheduling channel name → **"View channel details"**
2. Scroll to the bottom — the Channel ID is a string like `C0123ABCDEF`
3. Paste it into `.env.local`:
   ```
   SLACK_CHANNEL_ID=C0123ABCDEF
   ```
4. Add this to Vercel environment variables too

---

## Step 8 — Add Your OpenAI Key

1. Go to **https://platform.openai.com/api-keys**
2. Create a new secret key
3. Paste it into `.env.local` and Vercel:
   ```
   OPENAI_API_KEY=sk-paste-here
   ```

---

## How Supervisors Post a Schedule

The bot triggers on any message in the designated channel that contains words like "schedule", "appointment", "visit", or "next week". Format can be flexible. Example:

```
Next week's schedule (week of April 14):

Monday 4/14 9:00am - Maria Rodriguez - 123 W Oak St - Home visit
Monday 4/14 2:00pm - James Turner - Office check-in
Tuesday 4/15 10:00am - Sandra Hill - 789 E Main Ave - Transport to court
Wednesday 4/16 1:00pm - David Chen - 456 N 3rd St - Home visit
Thursday 4/17 11:00am - Lisa Park - Medical appointment at Banner Health
Friday 4/18 3:00pm - Open slot - community resource navigation
```

The bot will respond in the same channel:

> ✅ **BSP Board:** 6 slots posted for the week of Apr 14!
> 👉 **Claim your slots here:** https://bsp-board.vercel.app/appointments?week=2026-04-13

---

## Troubleshooting

- **Bot doesn't respond** — Make sure you invited `@BSP Board` to the channel with `/invite @BSP Board`
- **"⚠️ No appointments found"** — Make sure the message includes a day name and time (e.g., "Monday 9am")
- **Slots not showing on board** — Check that `SLACK_CHANNEL_ID` matches the channel you're posting in
- **Verification failed** — Double-check `SLACK_SIGNING_SECRET` in your Vercel env vars
