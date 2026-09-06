import { useEffect, useRef } from 'react'

import type { Route } from '../lib/use-route'

/**
 * The primary navigation, as a drawer.
 *
 * One panel, two behaviours, decided by width alone: below `lg` it is fixed to
 * the left edge and slides over the page with a backdrop behind it; from `lg` up
 * it is a column in the layout that collapses to nothing when closed. Both are
 * the same markup — a second, mobile-only menu is the thing that eventually
 * drifts out of sync with the real one.
 *
 * Closed means `invisible`, not merely translated or clipped. An off-screen link
 * is still in the tab order, so a keyboard user would tab into a menu nobody can
 * see; `visibility: hidden` takes it out of the tab order and the accessibility
 * tree, and still animates, because visibility only flips at the end of a
 * transition rather than halfway through it.
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

/** The id the header button points `aria-controls` at. */
export const NAV_PANEL_ID = 'primary-nav'

export function Sidebar({
  route,
  isAdmin,
  open,
  onNavigate,
  onDismiss,
}: {
  route: Route
  isAdmin: boolean
  open: boolean
  onNavigate: (next: Route) => void
  onDismiss: () => void
}) {
  const items = ITEMS.filter((item) => !item.adminOnly || isAdmin)

  const closeRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(open)

  /**
   * Opening moves focus into the drawer, so the next Tab continues from the menu
   * rather than from wherever the page had got to.
   *
   * Only on a transition into open, never on the first render: a drawer that was
   * already open when the page loaded has not been opened by anyone, and
   * stealing focus on load is disorienting. The close button is `lg:hidden`, so
   * on a wide screen this is a no-op — `focus()` on a `display: none` element
   * does nothing — and focus correctly stays on the header button there.
   */
  useEffect(() => {
    if (open && !wasOpen.current) closeRef.current?.focus()
    wasOpen.current = open
  }, [open])

  return (
    <>
      {/*
        The backdrop, which is what makes the narrow layout read as a drawer over
        the page rather than a panel wedged beside it. Kept mounted so it can
        fade, and made click-through when closed so it cannot swallow taps.

        aria-hidden with no keyboard handler: this is a shortcut for pointers,
        and Escape is the keyboard's way out. A screen reader announcing "close"
        twice would be noise, not access.
      */}
      <div
        aria-hidden="true"
        onClick={onDismiss}
        className={`fixed inset-0 z-30 bg-slate-900/40 transition-opacity duration-200 lg:hidden dark:bg-slate-950/70 ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      <nav
        id={NAV_PANEL_ID}
        aria-label="Sections"
        className={`fixed inset-y-0 left-0 z-40 w-64 overflow-x-hidden overflow-y-auto border-r border-slate-200 bg-white transition-[transform,visibility,width] duration-200 lg:sticky lg:top-0 lg:bottom-auto lg:z-auto lg:h-screen lg:shrink-0 lg:translate-x-0 dark:border-slate-800 dark:bg-slate-900 ${
          open ? 'visible translate-x-0 lg:w-56' : 'invisible -translate-x-full lg:w-0'
        }`}
      >
        {/* A fixed inner width, so the list does not reflow into narrower and
            narrower columns while the panel collapses beside it. */}
        <div className="w-64 lg:w-56">
          {/*
            The close button only exists where the drawer covers something. From
            `lg` up the header's toggle is always visible and does the same job,
            and a second control for it would just be another thing to explain.
          */}
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2.5 lg:hidden dark:border-slate-800">
            <span className="text-sm font-semibold tracking-tight">Menu</span>

            <button
              ref={closeRef}
              type="button"
              onClick={onDismiss}
              aria-label="Close navigation menu"
              className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M6 6 18 18M18 6 6 18" />
              </svg>
            </button>
          </div>

          <ul className="flex flex-col gap-0.5 p-3">
            {items.map((item) => {
              const current = route === item.route

              return (
                <li key={item.route}>
                  <a
                    href={`#/${item.route}`}
                    /*
                      aria-current tells a screen reader which page it is on.
                      Without it the active state is colour and weight only —
                      visible to people who can see it and invisible to everyone
                      else.
                    */
                    aria-current={current ? 'page' : undefined}
                    onClick={(event) => {
                      // Let the browser handle modified clicks so "open in new
                      // tab" keeps working; only take over the plain one.
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                      event.preventDefault()
                      onNavigate(item.route)

                      // On a narrow screen the drawer is standing on top of the
                      // page it has just navigated to, so following a link has
                      // to put it away. On a wide one this does nothing.
                      onDismiss()
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
                      <span className="block text-xs font-normal opacity-70">{item.hint}</span>
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        </div>
      </nav>
    </>
  )
}

/**
 * The control that opens and closes the drawer.
 *
 * Lives here beside the panel it operates rather than in the shell, so the two
 * halves of one widget — the button, its `aria-controls` target, and the panel's
 * id — are read together.
 *
 * The label does not change with the state. `aria-expanded` already announces
 * collapsed or expanded, and a name that flips between "Open" and "Close" says
 * the same thing a second time in a way that can contradict it.
 */
export function NavToggle({
  open,
  onToggle,
  buttonRef,
}: {
  open: boolean
  onToggle: () => void
  buttonRef: React.RefObject<HTMLButtonElement>
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onToggle}
      aria-label="Navigation menu"
      aria-expanded={open}
      aria-controls={NAV_PANEL_ID}
      className="shrink-0 rounded-lg border border-slate-300 bg-white p-2 text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
    >
      <svg
        viewBox="0 0 24 24"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    </button>
  )
}
