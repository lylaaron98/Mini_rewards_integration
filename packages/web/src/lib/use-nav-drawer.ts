import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'mini-rewards.nav'

/**
 * Tailwind's `lg` breakpoint — the width at which the drawer stops covering the
 * page and becomes a column beside it.
 *
 * Duplicated from the class names in `Sidebar.tsx` because CSS breakpoints are
 * not readable from JavaScript. The two have to agree, so they are both spelled
 * `1024px`/`lg` and named in each other's comments.
 */
const WIDE_QUERY = '(min-width: 1024px)'

export function isWideViewport(): boolean {
  // Assumed wide when matchMedia is missing, because the side-by-side layout is
  // the one that still reads correctly if the guess turns out to be wrong.
  if (typeof window.matchMedia !== 'function') return true
  return window.matchMedia(WIDE_QUERY).matches
}

function readInitialState(): boolean {
  let stored: string | null = null
  try {
    stored = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    // Storage unavailable. Treated as "no preference", which is the safe
    // reading — the viewport decides instead.
  }

  if (stored === 'open') return true
  if (stored === 'closed') return false

  // No choice on record: open where there is room for it, closed where it would
  // land on top of the page the moment it renders.
  return isWideViewport()
}

export type NavDrawer = {
  open: boolean
  /** The explicit user choice, made from the header button, and remembered. */
  toggle: () => void
  /**
   * Close, but only where the drawer covers the page.
   *
   * This is the incidental close — a backdrop click, Escape, following a link —
   * so it is deliberately a no-op on a wide screen, where none of those mean
   * "put the navigation away", and it is not remembered: dismissing a drawer on
   * a phone should not decide how the app opens on a laptop.
   */
  dismiss: () => void
  /** Attach to the header toggle, so focus can be handed back to it. */
  buttonRef: React.RefObject<HTMLButtonElement>
}

/**
 * Open/closed state for the navigation drawer.
 *
 * State lives here rather than in `Sidebar` because two components need it: the
 * drawer itself, and the header button that reports its state through
 * `aria-expanded`.
 */
export function useNavDrawer(): NavDrawer {
  const [open, setOpen] = useState(readInitialState)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const toggle = useCallback(() => {
    setOpen((previous) => {
      const next = !previous

      try {
        window.localStorage.setItem(STORAGE_KEY, next ? 'open' : 'closed')
      } catch {
        // The choice still holds for this page view; it just will not survive a
        // reload, which beats throwing.
      }

      return next
    })
  }, [])

  const dismiss = useCallback(() => {
    if (isWideViewport()) return

    setOpen(false)
    // Focus goes back to the control that opened it. Left where it was, it would
    // sit on a link that has just slid off-screen — the keyboard equivalent of
    // being dropped nowhere.
    buttonRef.current?.focus()
  }, [])

  /**
   * Escape closes the drawer while it is covering the page.
   *
   * Bound only while it is open, so the app is not listening to every keystroke
   * for a state it is not in. `dismiss` is the guard for the wide layout: there
   * Escape does nothing, because the drawer is not in anyone's way.
   */
  useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, dismiss])

  return { open, toggle, dismiss, buttonRef }
}
