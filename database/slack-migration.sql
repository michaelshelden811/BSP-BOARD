-- slack-migration.sql
-- Run this in Supabase SQL Editor to allow the Slack bot to insert appointments
-- without requiring auth (uses public RLS policy)

-- Allow anonymous inserts into appointments (secured at the API layer by Slack signature verification)
DROP POLICY IF EXISTS "appointments_public_insert" ON public.appointments;
CREATE POLICY "appointments_public_insert"
  ON public.appointments
  FOR INSERT
  WITH CHECK (true);

-- Make sure slack_message_id column exists (for deduplication)
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS slack_message_id TEXT;

-- Optional: add a unique constraint to prevent duplicate Slack messages
-- (comment out if it causes issues on existing data)
-- CREATE UNIQUE INDEX IF NOT EXISTS appointments_slack_msg_id_idx
--   ON public.appointments (slack_message_id)
--   WHERE slack_message_id IS NOT NULL;
