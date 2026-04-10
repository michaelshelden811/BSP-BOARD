// Deprecated — commits are handled client-side directly to Supabase.
export default function handler(req, res) {
  res.status(410).json({ error: 'Deprecated.' })
}
