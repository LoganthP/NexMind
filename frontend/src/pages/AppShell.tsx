import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { startServerWatch, useServer } from '@/lib/server'
import { Logo, Spinner } from '@/components/ui'
import ConnectGate from './ConnectGate'

const hasSeenServer = () => {
  try {
    return sessionStorage.getItem('nexmind.serverSeen') === '1'
  } catch {
    return false
  }
}

/**
 * AppShell handles server background probing and deep link gates.
 * The /app index route (Hub) is never blocked behind a splash or ConnectGate.
 * ConnectGate is only shown on deep links (/app/w/:id) when the server is unreachable.
 */
export default function AppShell() {
  const location = useLocation()
  const status = useServer((s) => s.status)
  const connected = useServer((s) => s.connected || s.status === 'online')
  const [serverSeen, setServerSeen] = useState<boolean>(() => hasSeenServer())
  const [deepLinkWaitDone, setDeepLinkWaitDone] = useState(false)

  useEffect(() => startServerWatch(), [])

  useEffect(() => {
    if (connected) {
      try {
        sessionStorage.setItem('nexmind.serverSeen', '1')
      } catch { /* ignore */ }
      setServerSeen(true)
    }
  }, [connected])

  const isDeepLink = location.pathname.startsWith('/app/w/')

  useEffect(() => {
    if (!isDeepLink || serverSeen || connected) return
    const t = setTimeout(() => {
      setDeepLinkWaitDone(true)
    }, 300)
    return () => clearTimeout(t)
  }, [isDeepLink, serverSeen, connected])

  // /app index route is NEVER blocked behind splash or full-page gate.
  // Render Hub immediately!
  if (!isDeepLink) {
    return (
      <>
        {serverSeen && status === 'offline' && (
          <div
            className="fixed left-1/2 top-3 z-[90] -translate-x-1/2 rounded-full border border-coral/50 bg-[#2a0d17]/90 px-4 py-1.5 text-sm text-coral"
            role="alert"
          >
            Lost connection to the NexMind server — reconnecting…
          </div>
        )}
        <Outlet />
      </>
    )
  }

  // Deep links (/app/w/:id):
  // If the server was connected previously or is currently connected, stay on the page with banner if offline
  if (serverSeen || connected) {
    return (
      <>
        {status === 'offline' && (
          <div
            className="fixed left-1/2 top-3 z-[90] -translate-x-1/2 rounded-full border border-coral/50 bg-[#2a0d17]/90 px-4 py-1.5 text-sm text-coral"
            role="alert"
          >
            Lost connection to the NexMind server — reconnecting…
          </div>
        )}
        <Outlet />
      </>
    )
  }

  // For deep link when server is still checking and hasn't timed out (up to 300ms)
  if (status === 'checking' && !deepLinkWaitDone) {
    return (
      <div className="grid min-h-screen place-items-center bg-abyss">
        <div className="flex flex-col items-center gap-4">
          <Logo size={34} />
          <Spinner size={20} />
        </div>
      </div>
    )
  }

  // Deep link with unreachable server
  return <ConnectGate connected={connected} />
}
