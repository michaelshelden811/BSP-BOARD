// Deprecated — no login required. Redirects to board.
import { useEffect } from 'react'
import { useRouter } from 'next/router'

export default function LoginPage() {
  const router = useRouter()
  useEffect(() => { router.replace('/appointments') }, [])
  return null
}
