import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'mini-rewards.theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * Light and dark, with the system preference as the starting point.
 *
 * Three states collapsed into two controls: there is no explicit "system"
 * option, but the absence of a stored choice *is* system — so a first-time
 * visitor gets whatever their OS is set to, and the moment they disagree with
 * it their choice is remembered and wins from then on.
 *
 * The initial value is read from the class already on <html>, which the inline
 * script in index.html set before the first paint. Recomputing it here would
 * risk the two disagreeing, and a mismatch between what is painted and what
 * React believes is painted is the kind of bug that only shows up as a toggle
 * that needs pressing twice.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  )

  const apply = useCallback((next: Theme) => {
    document.documentElement.classList.toggle('dark', next === 'dark')
    setTheme(next)
  }, [])

  const toggle = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark'
    apply(next)

    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Storage unavailable. The choice still holds for this page view; it just
      // will not survive a reload, which is a better outcome than throwing.
    }
  }, [theme, apply])

  /**
   * Follow the system while the user has not expressed a preference.
   *
   * Someone whose OS switches to dark at sunset should see this switch too —
   * but only if they have never touched the toggle. Once they have, their
   * choice is the answer and the system no longer gets a vote, which is the
   * whole point of having made one.
   */
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return

    let stored: string | null = null
    try {
      stored = window.localStorage.getItem(STORAGE_KEY)
    } catch {
      // Treated as "no preference", which is the safe reading.
    }

    if (stored) return

    const media = window.matchMedia(DARK_QUERY)
    const onChange = (event: MediaQueryListEvent) => apply(event.matches ? 'dark' : 'light')

    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [apply, theme])

  return { theme, toggle }
}
