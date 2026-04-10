// pages/appointments.js — no auth required
import { useState, useEffect } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )
}

function getMondayOf(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T12:00:00') : new Date()
  const day = d.getDay()
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day))
  return d.toISOString().split('T')[0]
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}

function formatWeekRange(mondayStr) {
  const start = new Date(mondayStr + 'T12:00:00')
  const end = new Date(mondayStr + 'T12:00:00')
  end.setDate(end.getDate() + 6)
  const opts = { month: 'short', day: 'numeric' }
  return start.toLocaleDateString('en-US', opts) + ' – ' + end.toLocaleDateString('en-US', { ...opts, year: 'numeric' })
}

function formatTime(t) {
  if (!t) return ''
  const [h, m] = t.split(':')
  const hour = parseInt(h, 10)
  return (hour % 12 || 12) + ':' + m + ' ' + (hour >= 12 ? 'PM' : 'AM')
}

function canUncommit(appt) {
  if (!appt.uncommit_deadline) return true
  return new Date() < new Date(appt.uncommit_deadline)
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

// ── Name Modal ────────────────────────────────────────────────────────────────
function NameModal({ onSave }) {
  const [name, setName] = useState('')
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
      <div className="bg-gray-800 rounded-xl p-6 w-full max-w-sm shadow-2xl">
        <h2 className="text-white font-bold text-lg mb-1">Welcome to BSP Board</h2>
        <p className="text-gray-400 text-sm mb-4">Enter your name so your teammates know who claimed a slot.</p>
        <input
          autoFocus
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && name.trim() && onSave(name.trim())}
          placeholder="Your full name"
          className="w-full bg-gray-700 border border-gray-600 text-white rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:border-indigo-500"
        />
        <button
          onClick={() => name.trim() && onSave(name.trim())}
          disabled={!name.trim()}
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 rounded-lg text-sm disabled:opacity-40"
        >
          Continue
        </button>
      </div>
    </div>
  )
}

// ── Appointment Card ──────────────────────────────────────────────────────────
function AppointmentCard({ appt, myName, onCommit, onUncommit, loadingId }) {
  const isOpen = appt.status === 'open'
  const isCommitted = appt.status === 'committed'
  const isCompleted = appt.status === 'completed'
  const isMyCommitment = isCommitted && appt.committed_name === myName
  const busy = loadingId === appt.id

  return (
    <div className={'rounded-xl border p-4 mb-3 shadow-sm ' + (isOpen ? 'border-red-500/50 bg-red-950/20' : 'border-gray-700 bg-gray-800')}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={'text-xs font-semibold px-2 py-0.5 rounded-full ' + (appt.type === 'group' ? 'bg-purple-900 text-purple-300' : 'bg-blue-900 text-blue-300')}>
            {appt.type === 'group' ? 'Group' : '1-on-1'}
          </span>
          <span className="text-xs text-gray-400">{formatTime(appt.time)}</span>
        </div>
        {isOpen && <span className="text-xs font-bold text-red-400 uppercase tracking-wide">Open</span>}
        {isCompleted && <span className="text-xs font-bold text-green-400 uppercase">✓ Done</span>}
      </div>

      <p className="font-semibold text-white text-sm mb-1">{appt.appointment_type}</p>
      {appt.clients?.length > 0 && (
        <p className="text-xs text-gray-400 mb-1"><span className="text-gray-500">Clients:</span> {appt.clients.join(', ')}</p>
      )}
      {appt.purpose && <p className="text-xs text-gray-500 italic mb-1">{appt.purpose}</p>}
      {appt.address && <p className="text-xs text-gray-400 mb-2">📍 {appt.address}</p>}

      <div className="pt-2 border-t border-gray-700 mt-2">
        {isOpen && (
          <button onClick={() => onCommit(appt.id)} disabled={busy}
            className="w-full bg-green-600 hover:bg-green-500 text-white text-sm font-semibold py-1.5 rounded-lg disabled:opacity-50">
            {busy ? 'Committing…' : 'Commit'}
          </button>
        )}
        {isCommitted && (
          <div className="flex items-center justify-between">
            <span className="text-sm">
              {isMyCommitment
                ? <span className="font-semibold text-indigo-400">You ({myName})</span>
                : <span className="text-gray-300">{appt.committed_name || 'A peer'}</span>}
            </span>
            {isMyCommitment && canUncommit(appt) && (
              <button onClick={() => onUncommit(appt.id)} disabled={busy}
                className="text-xs text-red-400 hover:text-red-300 underline disabled:opacity-50">
                {busy ? '…' : 'Uncommit'}
              </button>
            )}
          </div>
        )}
        {isCompleted && <p className="text-xs text-gray-500">{appt.committed_name || '—'}</p>}
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function AppointmentsPage() {
  const router = useRouter()
  const { week } = router.query

  const [myName, setMyName] = useState(null)
  const [showNameModal, setShowNameModal] = useState(false)
  const [appointments, setAppointments] = useState([])
  const [weekOf, setWeekOf] = useState(getMondayOf(null))
  const [loadingId, setLoadingId] = useState(null)
  const [pageLoading, setPageLoading] = useState(true)
  const [error, setError] = useState(null)

  // Load name from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('bsp_name')
    if (saved) {
      setMyName(saved)
    } else {
      setShowNameModal(true)
    }
  }, [])

  // Load appointments when week changes or on mount
  useEffect(() => {
    if (!router.isReady) return
    const target = getMondayOf(week || null)
    setWeekOf(target)
    loadAppointments(target)
  }, [week, router.isReady])

  async function loadAppointments(target) {
    setPageLoading(true)
    const supabase = getSupabase()
    const { data, error: err } = await supabase
      .from('appointments')
      .select('*')
      .eq('week_of', target)
      .order('date', { ascending: true })
      .order('time', { ascending: true })

    if (err) setError(err.message)
    setAppointments(data || [])
    setPageLoading(false)
  }

  function handleNameSave(name) {
    localStorage.setItem('bsp_name', name)
    setMyName(name)
    setShowNameModal(false)
  }

  async function handleCommit(apptId) {
    if (!myName) { setShowNameModal(true); return }
    setLoadingId(apptId); setError(null)
    const supabase = getSupabase()
    const { data, error: err } = await supabase
      .from('appointments')
      .update({ status: 'committed', committed_name: myName, committed_at: new Date().toISOString() })
      .eq('id', apptId)
      .eq('status', 'open')
      .select()
      .single()
    if (err) setError(err.message)
    else setAppointments(prev => prev.map(a => a.id === apptId ? data : a))
    setLoadingId(null)
  }

  async function handleUncommit(apptId) {
    setLoadingId(apptId); setError(null)
    const supabase = getSupabase()
    const { data, error: err } = await supabase
      .from('appointments')
      .update({ status: 'open', committed_name: null, committed_at: null })
      .eq('id', apptId)
      .select()
      .single()
    if (err) setError(err.message)
    else setAppointments(prev => prev.map(a => a.id === apptId ? data : a))
    setLoadingId(null)
  }

  const total = appointments.length
  const committed = appointments.filter(a => a.status !== 'open').length
  const pct = total > 0 ? Math.round((committed / total) * 100) : 0
  const prevWeek = addDays(weekOf, -7)
  const nextWeek = addDays(weekOf, 7)

  const byDay = DAYS.reduce((acc, day) => {
    acc[day] = appointments.filter(a => a.day === day)
    return acc
  }, {})

  return (
    <>
      <Head><title>BSP Board</title></Head>
      {showNameModal && <NameModal onSave={handleNameSave} />}

      <div className="min-h-screen bg-gray-900 text-white">
        {/* Header */}
        <div className="bg-gray-800 border-b border-gray-700 sticky top-0 z-10">
          <div className="max-w-7xl mx-auto px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-base font-bold">BSP Board</h1>
                <p className="text-xs text-gray-400">{formatWeekRange(weekOf)}</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <button onClick={() => router.push('/appointments?week=' + prevWeek)}
                  className="px-3 py-1.5 text-xs border border-gray-600 rounded-lg hover:bg-gray-700 text-gray-300">← Prev</button>
                <button onClick={() => router.push('/appointments?week=' + getMondayOf(null))}
                  className="px-3 py-1.5 text-xs border border-gray-600 rounded-lg hover:bg-gray-700 text-gray-300">This Week</button>
                <button onClick={() => router.push('/appointments?week=' + nextWeek)}
                  className="px-3 py-1.5 text-xs border border-gray-600 rounded-lg hover:bg-gray-700 text-gray-300">Next →</button>
                {myName && (
                  <button onClick={() => { localStorage.removeItem('bsp_name'); setMyName(null); setShowNameModal(true) }}
                    className="px-3 py-1.5 text-xs text-gray-500 hover:text-white">
                    {myName} ✎
                  </button>
                )}
              </div>
            </div>

            {total > 0 && (
              <div className="flex items-center gap-3 mt-2">
                <div className="flex-1 bg-gray-700 rounded-full h-1.5">
                  <div className={'h-1.5 rounded-full ' + (pct === 100 ? 'bg-green-500' : pct >= 60 ? 'bg-yellow-400' : 'bg-red-500')}
                    style={{ width: pct + '%' }} />
                </div>
                <span className="text-xs text-gray-400 whitespace-nowrap">{committed}/{total} covered ({pct}%)</span>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="max-w-7xl mx-auto px-4 pt-3">
            <div className="bg-red-900/50 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2">{error}</div>
          </div>
        )}

        <div className="max-w-7xl mx-auto px-4 py-4">
          {pageLoading ? (
            <div className="text-center py-20 text-gray-600 text-sm">Loading…</div>
          ) : total === 0 ? (
            <div className="text-center py-20 text-gray-600">
              <p className="text-lg">No appointments this week.</p>
              <p className="text-sm mt-1">Check back after the schedule is posted in Slack.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-7 gap-3">
              {DAYS.map(day => (
                <div key={day}>
                  <h2 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3 pb-1 border-b border-gray-700">
                    {day.slice(0, 3)}
                  </h2>
                  {byDay[day].length === 0
                    ? <p className="text-xs text-gray-700 italic">—</p>
                    : byDay[day].map(appt => (
                      <AppointmentCard key={appt.id} appt={appt} myName={myName}
                        onCommit={handleCommit} onUncommit={handleUncommit} loadingId={loadingId} />
                    ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
