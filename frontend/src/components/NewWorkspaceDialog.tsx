import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, BookOpen, Code2, Terminal, X } from 'lucide-react'
import { Modal } from './Modal'
import { AnalyzePanel } from './AnalyzePanel'
import { ConnectPanel } from './ConnectPanel'
import ServerConnectSteps from './ServerConnectSteps'
import { useServer } from '@/lib/server'

export type WorkspaceMode = 'code' | 'docs' | 'live'

interface Props {
  initialMode?: WorkspaceMode | null
  onClose: () => void
}

interface ModeCard {
  id: WorkspaceMode
  keyNum: string
  title: string
  desc: string
  icon: typeof Code2
  color: string
  chipCls: string
}

const MODES: ModeCard[] = [
  {
    id: 'code',
    keyNum: '1',
    title: 'Projects',
    desc: 'Analyze a codebase from GitHub, GitLab, Azure DevOps, a project zip or a folder.',
    icon: Code2,
    color: 'text-plankton bg-plankton/10 border-plankton/30',
    chipCls: 'text-plankton border-plankton/40 bg-plankton/10',
  },
  {
    id: 'docs',
    keyNum: '2',
    title: 'Documents',
    desc: 'Study from PDFs, Word files, notes or zipped folders of documents.',
    icon: BookOpen,
    color: 'text-amber bg-amber/10 border-amber/30',
    chipCls: 'text-amber border-amber/40 bg-amber/10',
  },
  {
    id: 'live',
    keyNum: '3',
    title: 'Live connect',
    desc: 'Connect the project open in VS Code with one command. The graph updates as you edit.',
    icon: Terminal,
    color: 'text-coral bg-coral/10 border-coral/30',
    chipCls: 'text-coral border-coral/40 bg-coral/10',
  },
]

export function NewWorkspaceDialog({ initialMode = null, onClose }: Props) {
  const nav = useNavigate()
  const serverConnected = useServer((s) => s.connected || s.status === 'online')
  const justConnected = useServer((s) => s.justConnected)

  const [openedFromCard, setOpenedFromCard] = useState<boolean>(() => Boolean(initialMode))
  const [step, setStep] = useState<'choose' | 'connect' | 'form'>(() => {
    if (!initialMode) return 'choose'
    return serverConnected ? 'form' : 'connect'
  })
  const [mode, setMode] = useState<WorkspaceMode>(() => initialMode || 'code')
  const [focusedIndex, setFocusedIndex] = useState(() => {
    if (!initialMode) return 0
    const idx = MODES.findIndex((m) => m.id === initialMode)
    return idx >= 0 ? idx : 0
  })

  const cardRefs = useRef<(HTMLDivElement | null)[]>([])
  const containerRef = useRef<HTMLDivElement>(null)

  const chooseMode = (m: WorkspaceMode) => {
    setMode(m)
    if (serverConnected) {
      setStep('form')
    } else {
      setStep('connect')
    }
  }

  // Derive state from initialMode prop on open / prop change
  useEffect(() => {
    if (initialMode) {
      setOpenedFromCard(true)
      setMode(initialMode)
      const isConn = useServer.getState().connected || useServer.getState().status === 'online'
      setStep(isConn ? 'form' : 'connect')
    } else {
      setOpenedFromCard(false)
      setStep('choose')
    }
  }, [initialMode])

  // Pre-focus active card on mount for choose step
  useEffect(() => {
    if (step === 'choose') {
      cardRefs.current[focusedIndex]?.focus()
    }
  }, [step, focusedIndex])

  // Auto-advance from connect step once server is detected
  useEffect(() => {
    if (step === 'connect' && serverConnected) {
      const timer = setTimeout(() => {
        setStep('form')
      }, 800)
      return () => clearTimeout(timer)
    }
  }, [step, serverConnected, justConnected])

  // Autofocus the first input of that mode on form step
  useEffect(() => {
    if (step === 'form') {
      const timer = setTimeout(() => {
        if (!containerRef.current) return
        if (mode === 'code') {
          const repoInput =
            containerRef.current.querySelector<HTMLInputElement>(
              'input[placeholder*="github.com"], input[placeholder*="owner/repo"]'
            ) || containerRef.current.querySelector<HTMLInputElement>('input:not([disabled])')
          repoInput?.focus()
        } else if (mode === 'docs') {
          const buttons = Array.from(
            containerRef.current.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
          )
          const chooseBtn = buttons.find((b) => b.textContent?.includes('Choose files'))
          ;(chooseBtn || buttons[0])?.focus()
        } else if (mode === 'live') {
          const copyBtn =
            containerRef.current.querySelector<HTMLButtonElement>('button[aria-label^="Copy command"]') ||
            containerRef.current.querySelector<HTMLButtonElement>('button:not([disabled])')
          copyBtn?.focus()
        }
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [step, mode])

  // Keyboard navigation for choose step: 1/2/3, Arrow keys, Enter
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (step !== 'choose') return

    if (e.key === '1') {
      e.preventDefault()
      chooseMode('code')
    } else if (e.key === '2') {
      e.preventDefault()
      chooseMode('docs')
    } else if (e.key === '3') {
      e.preventDefault()
      chooseMode('live')
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusedIndex((prev) => {
        const next = (prev + 1) % MODES.length
        cardRefs.current[next]?.focus()
        return next
      })
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusedIndex((prev) => {
        const next = (prev - 1 + MODES.length) % MODES.length
        cardRefs.current[next]?.focus()
        return next
      })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      chooseMode(MODES[focusedIndex].id)
    }
  }

  const handleBack = () => {
    if (step === 'connect') {
      if (openedFromCard) {
        onClose()
      } else {
        setStep('choose')
      }
    } else if (step === 'form') {
      setStep('choose')
    }
  }

  const currentMeta = MODES.find((m) => m.id === mode)!

  return (
    <Modal
      onClose={onClose}
      closeOnBackdrop={step === 'choose'}
      header={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            {step !== 'choose' && (
              <button
                type="button"
                className="btn btn-ghost btn-sm !h-7 !px-2 text-xs flex items-center gap-1 text-mist hover:text-ink"
                onClick={handleBack}
                aria-label={step === 'connect' && openedFromCard ? 'Back' : 'Back to choices'}
              >
                <ArrowLeft size={14} /> Back
              </button>
            )}
            <h2 className="text-base font-semibold tracking-tight text-ink">
              {step === 'choose' ? 'What do you want to explore?' : `New ${currentMeta.title}`}
            </h2>
            {step !== 'choose' && (
              <span className={`chip text-xs ${currentMeta.chipCls}`}>
                {currentMeta.title}
              </span>
            )}
          </div>
          <button
            type="button"
            className="icon-btn !h-8 !w-8 text-mist hover:text-ink"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={16} />
          </button>
        </div>
      }
    >
      <div ref={containerRef} onKeyDown={handleKeyDown} className="max-h-[75vh] overflow-y-auto pr-1">
        {step === 'choose' ? (
          <div className="py-2 space-y-4">
            <p className="text-sm text-mist">
              Choose the kind of workspace to create. You can explore source code, read documents, or connect live from your editor.
            </p>
            <div className="grid gap-3.5 sm:grid-cols-3 pt-1">
              {MODES.map((item, idx) => {
                const Icon = item.icon
                const isFocused = focusedIndex === idx
                return (
                  <div
                    key={item.id}
                    ref={(el) => {
                      cardRefs.current[idx] = el
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`${item.title}: ${item.desc}`}
                    onClick={() => chooseMode(item.id)}
                    onFocus={() => setFocusedIndex(idx)}
                    className={`relative flex flex-col justify-between rounded-2xl border p-5 text-left transition-all cursor-pointer outline-none ${
                      isFocused
                        ? 'border-plankton/60 bg-white/[0.07] ring-2 ring-plankton/30'
                        : 'border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.05]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-xl border ${item.color}`}>
                        <Icon size={20} />
                      </div>
                      <span className="mono rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-[0.68rem] text-mist">
                        {item.keyNum}
                      </span>
                    </div>

                    <div className="mt-4 flex-1">
                      <h3 className="text-base font-semibold text-ink">{item.title}</h3>
                      <p className="mt-1.5 text-xs leading-relaxed text-mist">{item.desc}</p>
                    </div>

                    <div className="mt-5 pt-3 border-t border-white/5 flex items-center justify-between text-xs font-medium text-plankton">
                      <span>Select</span>
                      <span className="text-[0.65rem] text-mist/60">Press {item.keyNum}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : step === 'connect' ? (
          <div className="py-2">
            <div className="mb-4">
              <div className="text-sm font-semibold text-ink">
                Step 1 of 2: connect the NexMind server on this computer
              </div>
              <p className="mt-1 text-xs text-mist">
                {mode === 'code'
                  ? 'Projects are analyzed on your computer, so your code stays with you.'
                  : mode === 'docs'
                    ? 'Documents are processed on your computer, so your files stay with you.'
                    : 'NexMind connects directly to your editor on your computer, so your work stays with you.'}
              </p>
            </div>
            <ServerConnectSteps connected={serverConnected} />
          </div>
        ) : (
          <div className="py-2">
            {mode === 'code' && (
              <AnalyzePanel
                kind="code"
                onStarted={(_jobId, wsId) => {
                  onClose()
                  nav(`/app/w/${wsId}`)
                }}
              />
            )}
            {mode === 'docs' && (
              <AnalyzePanel
                kind="docs"
                onStarted={(_jobId, wsId) => {
                  onClose()
                  nav(`/app/w/${wsId}`)
                }}
              />
            )}
            {mode === 'live' && (
              <ConnectPanel
                onSuccess={(wsId) => {
                  onClose()
                  nav(`/app/w/${wsId}`)
                }}
                onClose={onClose}
              />
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
