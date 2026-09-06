import { useCallback, useEffect, useState } from 'react'

/**
 * Hash-based routing, hand-rolled.
 *
 * Four flat routes, no parameters, no nesting, no data loaders. A router library
 * would bring an API surface and a dependency to solve a problem that is
 * genuinely this small — and the parts that actually matter for a router are the
 * parts a naive implementation drops, so they are all here: the URL is the source
 * of truth, the back button works, and a pasted link opens the right page.
 *
 * Hash rather than path segments because the API and the app share an origin
 * through the Vite proxy. Real paths would need the dev server and any static
 * host to rewrite unknown routes to `index.html`, and getting that wrong shows
 * up as a 404 on refresh — a broken-looking app for a configuration reason.
 */

export const ROUTES = ['overview', 'rewards', 'activity', 'developer'] as const

export type Route = (typeof ROUTES)[number]

const DEFAULT_ROUTE: Route = 'overview'

function readRoute(): Route {
  const candidate = window.location.hash.replace(/^#\/?/, '')
  return (ROUTES as readonly string[]).includes(candidate) ? (candidate as Route) : DEFAULT_ROUTE
}

export function useRoute(): { route: Route; navigate: (next: Route) => void } {
  const [route, setRoute] = useState<Route>(readRoute)

  useEffect(() => {
    // `hashchange` covers the back and forward buttons as well as a link click,
    // which is the whole reason the URL holds the state rather than a useState
    // that the browser knows nothing about.
    const onHashChange = () => setRoute(readRoute())

    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useCallback((next: Route) => {
    // Assigning the hash pushes a history entry, so back returns to the previous
    // page rather than leaving the app.
    window.location.hash = `/${next}`
  }, [])

  return { route, navigate }
}
