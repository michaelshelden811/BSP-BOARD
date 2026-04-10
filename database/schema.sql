-- ============================================================
-- BSP Board — Supabase Schema
-- Run this in your NEW Supabase project SQL Editor
-- ============================================================

-- AGENCIES table (one row per organization)
CREATE TABLE IF NOT EXISTS public.agencies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert Barbell Saves Project
INSERT INTO public.agencies (name) VALUES ('Barbell Saves Project');

-- USERS table (linked to auth.users)
CREATE TABLE IF NOT EXISTS public.users (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  agency_id   UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'specialist' CHECK (role IN ('admin', 'specialist')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- APPOINTMENTS table
CREATE TABLE IF NOT EXISTS public.appointments (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id         UUID        NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  appointment_type  TEXT        NOT NULL,
  clients           TEXT[]      NOT NULL DEFAULT '{}',
  day               TEXT        NOT NULL,
  date              DATE        NOT NULL,
  time              TIME        NOT NULL,
  address           TEXT,
  purpose           TEXT,
  type              TEXT        NOT NULL CHECK (type IN ('individual', 'group')),
  week_of           DATE        NOT NULL,
  slack_message_id  TEXT        UNIQUE,
  status            TEXT        NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open', 'committed', 'completed', 'cancelled')),
  committed_by      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  committed_at      TIMESTAMPTZ,
  uncommit_deadline TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- COMPLETION LOG table (immutable audit trail)
CREATE TABLE IF NOT EXISTS public.completion_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id       UUID        NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  appointment_id  UUID        NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  completed_by    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  completed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note_type       TEXT        NOT NULL CHECK (note_type IN ('individual', 'group')),
  completion_notes TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Trigger: auto-set uncommit_deadline ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_uncommit_deadline()
RETURNS TRIGGER AS $$
BEGIN
  NEW.uncommit_deadline := (NEW.date + NEW.time)::TIMESTAMP
                           AT TIME ZONE 'America/Phoenix'
                           - INTERVAL '24 hours';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER appointments_set_uncommit_deadline
  BEFORE INSERT OR UPDATE OF date, time
  ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.set_uncommit_deadline();

-- ── Trigger: auto-update updated_at ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER appointments_updated_at
  BEFORE UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_appointments_agency_week   ON public.appointments (agency_id, week_of);
CREATE INDEX IF NOT EXISTS idx_appointments_agency_status ON public.appointments (agency_id, status);
CREATE INDEX IF NOT EXISTS idx_appointments_agency_date   ON public.appointments (agency_id, date);
CREATE INDEX IF NOT EXISTS idx_appointments_committed_by  ON public.appointments (committed_by);
CREATE INDEX IF NOT EXISTS idx_completion_log_appointment ON public.completion_log (appointment_id);
CREATE INDEX IF NOT EXISTS idx_completion_log_peer        ON public.completion_log (completed_by);

-- ── RLS: agencies ─────────────────────────────────────────────────────────────
ALTER TABLE public.agencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agencies_select_members" ON public.agencies FOR SELECT
  USING (id = (SELECT agency_id FROM public.users WHERE id = auth.uid()));

-- ── RLS: users ───────────────────────────────────────────────────────────────
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_select_same_agency" ON public.users FOR SELECT
  USING (agency_id = (SELECT agency_id FROM public.users WHERE id = auth.uid()));

-- ── RLS: appointments ────────────────────────────────────────────────────────
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "appointments_select" ON public.appointments FOR SELECT
  USING (agency_id = (SELECT agency_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY "appointments_update" ON public.appointments FOR UPDATE
  USING (agency_id = (SELECT agency_id FROM public.users WHERE id = auth.uid()))
  WITH CHECK (agency_id = (SELECT agency_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY "appointments_delete_admin" ON public.appointments FOR DELETE
  USING ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin');

-- Note: INSERT is handled by the service role client (ingest API) — no INSERT policy needed for anon/user role

-- ── RLS: completion_log ──────────────────────────────────────────────────────
ALTER TABLE public.completion_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "completion_log_select" ON public.completion_log FOR SELECT
  USING (agency_id = (SELECT agency_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY "completion_log_insert_own" ON public.completion_log FOR INSERT
  WITH CHECK (
    agency_id = (SELECT agency_id FROM public.users WHERE id = auth.uid())
    AND completed_by = auth.uid()
  );
