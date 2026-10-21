import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { startServerWatch, useServer } from '@/lib/server'

const hasSeenServer = () => {
  try {
    return sessionStorage.getItem('nexmind.serverSeen') === '1'
  } catch {
    return false
  }
}

/**
 * AppShell renders immediately without blocking.
 * Server status is tracked in the background via startServerWatch().
 */
export default function AppShell() {
  const status = useServer((s) => s.status)
  const [serverSeen, setServerSeen] = useState<boolean>(() => hasSeenServer())

  useEffect(() => startServerWatch(), [])

  useEffect(() => {
    if (status === 'online') {
      try {
        sessionStorage.setItem('nexmind.serverSeen', '1')
      } catch {
        /* ignore */
      }
      setServerSeen(true)
    }
  }, [status])

  return (
    <>
      {serverSeen && status === 'offline' && (
        <div
          className="fixed left-1/2 top-3 z-[90] -translate-x-1/2 rounded-full border border-coral/50 bg-[#2a0d17]/90 px-4 py-1.5 text-sm text-coral shadow-lg"
          role="alert"
        >
          Lost connection to the NexMind server, reconnecting…
        </div>
      )}
      <Outlet />
    </>
  )
}
