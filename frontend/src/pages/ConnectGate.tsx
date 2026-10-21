import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeft } from 'lucide-react'
import { Aurora, Logo } from '@/components/ui'
import ServerConnectSteps from '@/components/ServerConnectSteps'

export default function ConnectGate({ connected = false }: { connected?: boolean }) {
  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-abyss px-4 py-10">
      <Aurora />
      <Link
        to="/app"
        className="absolute left-5 top-5 z-10 flex items-center gap-2 text-sm text-mist hover:text-ink"
      >
        <ArrowLeft size={16} /> Back to modes
      </Link>
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
        className="glass relative z-10 w-full max-w-[560px] max-h-[90vh] overflow-y-auto rounded-3xl p-7 sm:p-9"
      >
        <div className="flex flex-col items-center text-center">
          <Logo size={34} />
          <h1 className="mt-5 text-[1.75rem] font-bold leading-tight tracking-tight">
            Start your local server
          </h1>
          <p className="mt-2 max-w-[42ch] text-[0.95rem] text-mist">
            NexMind runs on your computer, so your code and documents stay with you. This page connects the moment the server starts.
          </p>
        </div>

        <div className="mt-6">
          <ServerConnectSteps connected={connected} />
        </div>
      </motion.div>
    </div>
  )
}
