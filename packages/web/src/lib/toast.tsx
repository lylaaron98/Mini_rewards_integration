import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * A minimal toast system.
 *
 * Hand-rolled rather than pulled in, because the requirement is narrow — show a
 * short message, distinguish success from failure, let it be dismissed — and a
 * library would bring animation and positioning opinions that then have to be
 * argued with over `prefers-reduced-motion`.
 */

export type ToastTone = 'success' | 'error' | 'info'

export type Toast = {
  id: string
  tone: ToastTone
  title: string
  /** Optional second line. Used to say what to do next, or what already happened. */
  detail?: string
}

type ToastContextValue = {
  toast: (toast: Omit<Toast, 'id'>) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const DISMISS_AFTER_MS = 6000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((entry) => entry.id !== id))
  }, [])

  const toast = useCallback(
    (input: Omit<Toast, 'id'>) => {
      const id = crypto.randomUUID()
      setToasts((current) => [...current, { ...input, id }])

      // Six seconds: long enough to read two lines, short enough not to stack
      // up. Errors auto-dismiss too — they are all repeated in the UI state
      // itself, so a toast is a notification rather than the only record.
      window.setTimeout(() => dismiss(id), DISMISS_AFTER_MS)
    },
    [dismiss],
  )

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/*
        `role="status"` with `aria-live="polite"` announces new toasts to a
        screen reader without interrupting whatever it is currently reading.
        `assertive` would cut across the user mid-sentence, which is the wrong
        trade for a message that is also visible on screen.
      */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts.map((entry) => (
          <div
            key={entry.id}
            className={`pointer-events-auto w-full max-w-sm rounded-lg border p-4 shadow-lg motion-safe:animate-[toast-in_150ms_ease-out] ${toneClasses[entry.tone]}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">{entry.title}</p>
                {entry.detail && <p className="mt-1 text-sm opacity-90">{entry.detail}</p>}
              </div>

              <button
                type="button"
                onClick={() => dismiss(entry.id)}
                className="-m-1 rounded p-1 text-lg leading-none opacity-60 transition hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                aria-label="Dismiss notification"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

const toneClasses: Record<ToastTone, string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  error: 'border-red-200 bg-red-50 text-red-900',
  info: 'border-slate-200 bg-white text-slate-900',
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside a ToastProvider')
  return context
}
