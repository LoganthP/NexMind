import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
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

/** Everything under /app needs the local NexMind server. Until it is detected we show the connect screen. */
export default function AppShell() {
  const status = useServer((s) => s.status)
  const [serverSeen, setServerSeen] = useState<boolean>(() => hasSeenServer())
  const [gateShown, setGateShown] = useState(false)
  const [released, setReleased] = useState<boolean>(() => hasSeenServer())

  useEffect(() => startServerWatch(), [])

  useEffect(() => {
    if (status === 'online') {
      try {
        sessionStorage.setItem('nexmind.serverSeen', '1')
      } catch { /* ignore */ }
      setServerSeen(true)

      if (gateShown) {
        const t = setTimeout(() => {
          setReleased(true)
        }, 900)
        return () => clearTimeout(t)
      } else {
        setReleased(true)
      }
    }
  }, [status, gateShown])

  useEffect(() => {
    if (status !== 'offline' || gateShown || serverSeen || released) return
    const t = setTimeout(() => {
      setGateShown(true)
    }, 1500)
    return () => clearTimeout(t)
  }, [status, gateShown, serverSeen, released])

  if (!released) {
    if (gateShown) {
      return <ConnectGate connected={status === 'online'} />
    }
    return (
      <div className="grid min-h-screen place-items-center bg-abyss">
        <div className="flex flex-col items-center gap-4">
          <Logo size={34} />
          <Spinner size={20} />
        </div>
      </div>
    )
  }

  return (
    <>
      {status === 'offline' && (
        <div className="fixed left-1/2 top-3 z-[90] -translate-x-1/2 rounded-full border border-coral/50 bg-[#2a0d17]/90 px-4 py-1.5 text-sm text-coral" role="alert">
          Lost connection to the NexMind server — reconnecting…
        </div>
      )}
      <Outlet />
    </>
  )
}
