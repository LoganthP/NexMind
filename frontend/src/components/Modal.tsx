import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export interface ModalProps {
  open?: boolean
  onClose: () => void
  header?: ReactNode
  title?: ReactNode
  subtitle?: ReactNode
  headerExtra?: ReactNode
  footer?: ReactNode
  children: ReactNode
  maxWidth?: string
  backdropClosable?: boolean
  closeOnBackdrop?: boolean
  showCloseButton?: boolean
  ariaLabel?: string
}

export function Modal({
  open = true,
  onClose,
  header,
  title,
  subtitle,
  headerExtra,
  footer,
  children,
  maxWidth = 'min(680px, calc(100vw - 2rem))',
  backdropClosable = true,
  closeOnBackdrop,
  showCloseButton = true,
  ariaLabel,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const effectiveBackdropClosable = closeOnBackdrop !== undefined ? closeOnBackdrop : backdropClosable

  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement as HTMLElement | null

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }

      if (e.key === 'Tab' && modalRef.current) {
        const focusables = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    // Initial focus trap: focus first interactive element
    requestAnimationFrame(() => {
      if (modalRef.current) {
        const focusables = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        if (focusables.length > 0) {
          focusables[0].focus()
        } else {
          modalRef.current.focus()
        }
      }
    })

    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', handleKeyDown)
      openerRef.current?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      onClick={() => {
        if (effectiveBackdropClosable) onClose()
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : ariaLabel || 'Dialog'}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: maxWidth,
          maxHeight: '90vh',
          backgroundColor: '#081522',
          borderColor: 'rgba(140, 200, 255, 0.14)',
          borderRadius: '16px',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.7)',
        }}
        className="relative flex flex-col overflow-hidden border text-ink outline-none"
      >
        {header ? (
          <header className="sticky top-0 z-10 shrink-0 border-b border-line bg-[#081522] px-6 py-4">
            {header}
          </header>
        ) : (title || showCloseButton || headerExtra) && (
          <header className="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-line bg-[#081522] px-6 py-4">
            <div className="flex-1 pr-3">
              {title && (
                <div className="flex items-center gap-2">
                  {typeof title === 'string' ? (
                    <h2 className="text-lg font-bold tracking-tight text-ink">{title}</h2>
                  ) : (
                    title
                  )}
                  {headerExtra}
                </div>
              )}
              {subtitle && <p className="mt-0.5 text-xs text-mist">{subtitle}</p>}
            </div>
            {showCloseButton && (
              <button
                type="button"
                className="icon-btn !h-8 !w-8 shrink-0 text-mist hover:text-ink"
                onClick={onClose}
                aria-label="Close dialog"
              >
                <X size={16} />
              </button>
            )}
          </header>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>

        {footer && (
          <footer className="sticky bottom-0 z-10 flex shrink-0 items-center justify-between border-t border-line bg-[#081522] px-6 py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}
