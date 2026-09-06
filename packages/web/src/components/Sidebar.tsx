import type { Route } from '../lib/use-route'

/**
 * The primary navigation.
 *
 * A column on desktop, a scrollable row on mobile — one list rendered once, so
 * the two layouts cannot drift apart in content the way a duplicated mobile menu
 * always eventually does.
 *
 * Real links with real `href`s, not buttons. A link can be middle-clicked,
 * opened in a new tab, copied, and read by a screen reader as a link — none of
 * which a `<button>` that calls `navigate()` can do, and all of which people
 * expect from navigation.
 */

type Item = {
  route: Route
  label: string
  hint: string
  icon: JSX.Element
  adminOnly?: boolean
}

const ITEMS: Item[] = [
  {
    route: 'overview',
    label: 'Overview',
    hint: 'Balance and recent activity',
    icon: (
      <path d="M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6V11h-6v9Zm0-16v5h6V4h-6Z" />
    ),
  },
  {
    route: 'rewards',
    label: 'Rewards',
    hint: 'Browse and redeem',
    icon: (
      <path d="M20 8h-2.2a3 3 0 0 0-4.3-4L12 5.2 10.5 4a3 3 0 0 0-4.3 4H4a1 1 0 0 0-1 1v3h9V9h2v3h9V9a1 1 0 0 0-1-1ZM4 14v6a1 1 0 0 0 1 1h6v-7H4Zm9 7h6a1 1 0 0 0 1-1v-6h-7v7Z" />
    ),
  },
  {
    route: 'activity',
    label: 'Activity',
    hint: 'Every ledger entry',
    icon: <path d="M3 12h4l3 8 4-16 3 8h4" fill="none" strokeWidth="2" stroke="currentColor" />,
  },
  {
    route: 'developer',
    label: 'Developer',
    hint: 'Simulate and inspect',
    adminOnly: true,
    icon: (
      <path d="M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4Zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4Z" />
    ),
  },
]

export function Sidebar({
  route,
  isAdmin,
  onNavigate,
}: {
  route: Route
  isAdmin: boolean
  onNavigate: (next: Route) => void
}) {
  const items = ITEMS.filter((item) => !item.adminOnly || isAdmin)

  return (
    <nav
      aria-label="Sections"
      className="border-b border-slate-200 bg-white lg:sticky lg:top-0 lg:h-screen lg:w-56 lg:shrink-0 lg:border-r lg:border-b-0 dark:border-slate-800 dark:bg-slate-900"
    >
      <ul className="flex gap-1 overflow-x-auto p-2 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:p-3">
        {items.map((item) => {
          const current = route === item.route

          return (
            <li key={item.route} className="shrink-0 lg:shrink">
              <a
                href={`#/${item.route}`}
                /*
                  aria-current tells a screen reader which page it is on. Without
                  it the active state is colour and weight only — visible to
                  people who can see it and invisible to everyone else.
                */
                aria-current={current ? 'page' : undefined}
                onClick={(event) => {
                  // Let the browser handle modified clicks so "open in new tab"
                  // keeps working; only take over the plain one.
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                  event.preventDefault()
                  onNavigate(item.route)
                }}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  current
                    ? 'bg-slate-900 font-medium text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="currentColor" aria-hidden="true">
                  {item.icon}
                </svg>

                <span className="whitespace-nowrap">
                  {item.label}
                  {/* The hint is desktop-only: on a mobile row it would wrap the
                      items into something unreadable. */}
                  <span className="hidden text-xs font-normal opacity-70 lg:block">
                    {item.hint}
                  </span>
                </span>
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
