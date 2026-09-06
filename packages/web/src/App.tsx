import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { DevPanel } from './components/DevPanel'
import { NavToggle, Sidebar } from './components/Sidebar'
import { SignIn } from './components/SignIn'
import { ThemeToggle } from './components/ThemeToggle'
import { fetchMe, fetchSession, logout } from './lib/api'
import { useToast } from './lib/toast'
import { useNavDrawer } from './lib/use-nav-drawer'
import { useRoute } from './lib/use-route'
import { useTheme } from './lib/use-theme'
import { ActivityPage } from './pages/ActivityPage'
import { OverviewPage } from './pages/OverviewPage'
import { RewardsPage } from './pages/RewardsPage'

/**
 * The shell: navigation, session, and whichever page the URL names.
 *
 * Each page owns its own data. The alternative — fetching everything here and
 * threading it down — makes the shell grow a prop for every screen and couples
 * pages that have nothing to do with each other. TanStack Query dedupes and
 * caches by key, so two pages asking for the same thing cost one request.
 */
export function App() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { theme, toggle: toggleTheme } = useTheme()
  const { route, navigate } = useRoute()
  const drawer = useNavDrawer()

  /**
   * The session is the root of everything else.
   *
   * A 401 here is the normal signed-out state, not an error worth retrying — so
   * retry is off and the failure is read as "nobody is signed in" rather than
   * surfaced as something broken.
   */
  const session = useQuery({ queryKey: ['session'], queryFn: fetchSession, retry: false })
  const signedIn = session.isSuccess
  const isAdmin = session.data?.role === 'ADMIN'

  // The balance is needed by the shop as well as the overview, so it is fetched
  // here where both can reach it through the shared cache rather than twice.
  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe, enabled: signedIn })

  const signOut = useMutation({
    mutationFn: logout,
    onSettled: () => {
      /**
       * Everything cached belongs to the person who just left. Clearing rather
       * than invalidating means the next user cannot see a flash of the previous
       * one's balance while fresh data loads — a privacy failure, not a
       * rendering artefact.
       */
      queryClient.clear()
      toast({ tone: 'info', title: 'Signed out', detail: 'Your session has been ended.' })
    },
  })

  if (session.isPending) {
    // Nothing renders until the session is known. Showing the signed-in shell
    // and swapping it for a sign-in form is a flicker that reads as a bug.
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
        <p className="py-24 text-center text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      </div>
    )
  }

  if (!signedIn) {
    return (
      <div className="min-h-screen bg-slate-50 px-4 py-16 dark:bg-slate-950">
        <SignIn onSignedIn={() => void queryClient.invalidateQueries()} />
      </div>
    )
  }

  const balance = me.data?.balance ?? 0

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 lg:flex dark:bg-slate-950 dark:text-slate-100">
      <Sidebar
        route={route}
        isAdmin={isAdmin}
        open={drawer.open}
        onNavigate={navigate}
        onDismiss={drawer.dismiss}
      />

      {/* min-w-0 so a wide child — a long description, a table — shrinks inside
          the flex row instead of pushing the layout sideways. */}
      <div className="min-w-0 flex-1">
        <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              {/* The toggle leads the header, beside the edge the drawer comes
                  out of, and it stays there at every width — a control that
                  changes place between layouts is one people have to find
                  twice. */}
              <NavToggle open={drawer.open} onToggle={drawer.toggle} buttonRef={drawer.buttonRef} />

              <div className="min-w-0">
                <h1 className="text-lg font-semibold tracking-tight">Mini Rewards</h1>
                <p className="truncate text-sm text-slate-500 dark:text-slate-400">
                  Earn points from partner activity, spend them on rewards.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <span className="hidden text-sm text-slate-600 sm:inline dark:text-slate-400">
                {session.data.displayName}
              </span>
              <button
                type="button"
                onClick={() => signOut.mutate()}
                disabled={signOut.isPending}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {signOut.isPending ? 'Signing out…' : 'Sign out'}
              </button>
              <ThemeToggle theme={theme} onToggle={toggleTheme} />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
          {route === 'overview' && <OverviewPage onNavigate={navigate} />}
          {route === 'rewards' && <RewardsPage balance={balance} />}
          {route === 'activity' && <ActivityPage />}

          {/*
            Guarded here as well as in the nav. A URL is typed, pasted and
            bookmarked, so hiding the link is not the same as refusing the page —
            and the endpoints behind it enforce the same rule again on the
            server, which is what actually protects them.
          */}
          {route === 'developer' &&
            (isAdmin ? (
              <DevPanel defaultUserRef={session.data.externalRef} />
            ) : (
              <p className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
                This area is for administrator accounts.
              </p>
            ))}
        </main>
      </div>
    </div>
  )
}
