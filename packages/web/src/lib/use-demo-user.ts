import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'mini-rewards.demo-user'

/**
 * Which user the demo is acting as, remembered across reloads.
 *
 * Persisted so that simulating an event, reloading, and checking the balance
 * does not silently switch identity halfway through — which would make the
 * numbers look wrong for a reason that has nothing to do with the service.
 *
 * `localStorage` throws in a few real situations (a browser configured to block
 * site data, some private modes), and losing a demo preference is not worth
 * taking the page down for, so both directions are guarded.
 */
export function useDemoUser(): [string | null, (externalRef: string) => void] {
  const [externalRef, setExternalRef] = useState<string | null>(null)

  useEffect(() => {
    try {
      setExternalRef(window.localStorage.getItem(STORAGE_KEY))
    } catch {
      // Storage unavailable. The switcher still works for this session.
    }
  }, [])

  const select = useCallback((next: string) => {
    setExternalRef(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Same again: remembering is a convenience, not a requirement.
    }
  }, [])

  return [externalRef, select]
}
