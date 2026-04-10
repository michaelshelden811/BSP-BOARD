# BSP Board

Appointment scheduling dashboard for Barbell Saves Project peer support specialists.

## How It Works

1. Supervisor posts the weekly schedule in the `#scheduling` Slack channel
2. BSP Board parses it automatically with AI and posts back a link
3. Peers open the link, enter their name, and claim appointment slots

No login required. Identity is stored locally by name.

## Stack

- Next.js (Pages Router)
- Supabase (PostgreSQL)
- Tailwind CSS v4
- OpenAI (schedule parsing)
- Slack Events API (inbound messages + bot replies)

## Setup

See `SLACK_SETUP.md` for full Slack and Vercel setup instructions.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SLACK_SIGNING_SECRET` | Slack app signing secret |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (xoxb-...) |
| `SLACK_CHANNEL_ID` | Slack channel to monitor |
| `OPENAI_API_KEY` | OpenAI API key |
| `NEXT_PUBLIC_APP_URL` | Your deployed app URL |
| `INGEST_WEBHOOK_SECRET` | Secret for the n8n ingest webhook |

## Dev

```bash
npm install
npm run dev
```
