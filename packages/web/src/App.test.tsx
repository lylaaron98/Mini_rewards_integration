import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from './App'
import { ToastProvider } from './lib/toast'

/**
 * The UI, driven the way a person drives it.
 *
 * `fetch` is stubbed at the boundary rather than the API module being mocked, so
 * the real client — including its 4xx-to-rejection translation, which everything
 * downstream depends on — runs in every test.
 */

const USERS = [
  { id: 'u1', externalRef: 'acme-user-001', displayName: 'Ada Lovelace', role: 'USER' },
  { id: 'u3', externalRef: 'acme-user-003', displayName: 'Alan Turing', role: 'USER' },
]

const ADMIN = { id: 'a1', externalRef: 'local:seed-admin', displayName: 'Dev Admin', role: 'ADMIN' }

const REWARDS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    sku: 'COFFEE',
    name: 'Coffee Voucher',
    description: 'One free coffee.',
    costPoints: 250,
    inStock: true,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    sku: 'GETAWAY',
    name: 'Weekend Getaway',
    description: 'Two nights away.',
    costPoints: 25_000,
    inStock: true,
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    sku: 'SOLDOUT',
    name: 'Wireless Headphones',
    description: 'Noise cancelling.',
    costPoints: 100,
    inStock: false,
  },
]

const TRANSACTIONS = {
  items: [
    {
      id: 't1',
      delta: 500,
      type: 'EARN' as const,
      description: 'Referred a friend',
      source: 'partner:acme',
      createdAt: '2026-09-01T10:00:00.000Z',
    },
    {
      id: 't2',
      delta: -250,
      type: 'REDEEM' as const,
      description: 'Redeemed Coffee Voucher',
      source: 'redemption',
      createdAt: '2026-09-02T10:00:00.000Z',
    },
  ],
  nextCursor: null,
}

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown }

let handlers: Handler[] = []

function respond(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)

      for (const handler of handlers) {
        const result = handler(url, init)
        if (result) return respond(result.status ?? 200, result.body)
      }

      if (url.startsWith('/api/demo/users')) return respond(200, USERS)

      // The session is the root of the app: without it nothing personal
      // renders, so every test that exercises the signed-in UI needs one.
      if (url.startsWith('/api/auth/me')) return respond(200, USERS[0])
      if (url.startsWith('/api/rewards')) return respond(200, REWARDS)
      if (url.startsWith('/api/me/transactions')) return respond(200, TRANSACTIONS)
      if (url.startsWith('/api/me')) {
        return respond(200, {
          id: 'u1',
          externalRef: 'acme-user-001',
          displayName: 'Ada Lovelace',
          email: 'ada@example.com',
          balance: 355,
        })
      }
      /*
        The two developer endpoints have different shapes, and one stub for both
        handed the reconciliation card a delivery list: `healthy` came back
        undefined, which reads as "balances disagree", and the component then
        went looking for the discrepancy list it had been promised and threw.

        The bug was in the fixture rather than the app — the real endpoint always
        answers with both fields — but a stub that cannot represent a healthy
        ledger cannot test one either.
      */
      if (url.startsWith('/api/dev/reconcile')) {
        return respond(200, { healthy: true, discrepancies: [] })
      }
      if (url.startsWith('/api/dev/')) {
        return respond(200, {
          deliveries: [],
          summary: { total: 0, unmatched: 0, noRule: 0, unknownUser: 0 },
        })
      }

      throw new Error(`Unhandled request: ${url}`)
    }),
  )
})

afterEach(() => {
  handlers = []
  window.location.hash = ''
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

function renderApp(route: 'overview' | 'rewards' | 'activity' | 'developer' = 'overview') {
  // The hash is set before render because the router reads it on mount — the
  // same path a pasted link takes.
  window.location.hash = `/${route}`

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>,
  )
}

describe('the balance', () => {
  it('shows the balance with its unit', async () => {
    renderApp()

    // Scoped to the balance region: "points" also appears beside every reward
    // price, and a bare getByText would match whichever came first.
    //
    // The region resolves immediately, while the skeleton is still showing, so
    // the number itself has to be awaited rather than read synchronously.
    const balance = await screen.findByRole('region', { name: /your balance/i })

    // Scoped to the live region: the figure also appears in the chart's table
    // view, which is the point of that table existing.
    expect(
      await within(balance).findByText('355', { selector: '[aria-live="polite"]' }),
    ).toBeInTheDocument()
    expect(within(balance).getByText('points')).toBeInTheDocument()
    expect(within(balance).getByText(/Ada Lovelace/)).toBeInTheDocument()
  })

  it('announces the balance politely rather than interrupting', async () => {
    renderApp()

    const balance = await screen.findByRole('region', { name: /your balance/i })
    expect(
      await within(balance).findByText('355', { selector: '[aria-live="polite"]' }),
    ).toHaveAttribute('aria-live', 'polite')
  })
})

describe('the balance chart', () => {
  /**
   * The chart is derived from the loaded history, so it can never disagree with
   * the list underneath it.
   */
  it('plots the balance and labels what it shows', async () => {
    renderApp()

    const chart = await screen.findByRole('img', { name: /balance over time/i })
    expect(chart).toBeInTheDocument()

    // Named in the accessible label rather than left to the visual alone.
    expect(chart.getAttribute('aria-label')).toContain('355')
  })

  /**
   * A tooltip must never be the only way to read a value. The table view is what
   * makes that true for a screen reader, for print, and for anyone not using a
   * pointer.
   */
  it('offers a table view of the same figures', async () => {
    renderApp()

    expect(await screen.findByText('Table view')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: /balance after each transaction/i })).toBeInTheDocument()
  })

  /**
   * Two points are the minimum that can show a trend. One transaction drawn as a
   * line would be a chart of nothing.
   */
  it('says so rather than drawing a line through a single point', async () => {
    handlers = [
      (url) =>
        url.startsWith('/api/me/transactions')
          ? { body: { items: [], nextCursor: null } }
          : (undefined as never),
    ]

    renderApp()

    expect(await screen.findByText(/at least two transactions/i)).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /balance over time/i })).not.toBeInTheDocument()
  })
})

describe('the rewards shop', () => {
  it('offers a redeem button only for rewards the user can afford', async () => {
    renderApp('rewards')

    // Three rewards are listed, and exactly one is both affordable and in
    // stock — so exactly one live Redeem button should exist.
    expect(await screen.findByText('Coffee Voucher')).toBeInTheDocument()
    expect(screen.getByText('Weekend Getaway')).toBeInTheDocument()
    expect(screen.getByText('Wireless Headphones')).toBeInTheDocument()

    expect(screen.getAllByRole('button', { name: 'Redeem' })).toHaveLength(1)
  })

  /**
   * The requirement that an unaffordable reward is not a dead disabled button.
   * 25,000 − 355 = 24,645.
   */
  it('tells the user exactly how many more points they need', async () => {
    renderApp('rewards')

    // The meter states the shortfall in words beside the bar, so the number is
    // never carried by the bar alone.
    expect(await screen.findByText('24,645 more')).toBeInTheDocument()
    expect(screen.getByText(/1% of the way there/)).toBeInTheDocument()
  })

  it('marks a sold-out reward rather than offering it', async () => {
    renderApp('rewards')

    expect(await screen.findByText('Out of stock')).toBeInTheDocument()
    expect(screen.getByText('Sold out')).toBeInTheDocument()
  })
})

describe('redeeming', () => {
  it('shows the arithmetic before spending anything', async () => {
    const user = userEvent.setup()
    renderApp('rewards')

    await user.click(await screen.findByRole('button', { name: 'Redeem' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Redeem Coffee Voucher?')).toBeInTheDocument()

    // Balance now, cost, balance after — the numbers that make the confirmation
    // worth interrupting for.
    expect(within(dialog).getByText('355')).toBeInTheDocument()
    expect(within(dialog).getByText('−250')).toBeInTheDocument()
    expect(within(dialog).getByText('105')).toBeInTheDocument()
  })

  it('sends exactly one idempotency key and reports success', async () => {
    const user = userEvent.setup()

    handlers = [
      (url, init) =>
        url === '/api/redemptions' && init?.method === 'POST'
          ? {
              status: 201,
              body: {
                redemptionId: 'r1',
                status: 'FULFILLED',
                rewardName: 'Coffee Voucher',
                costPoints: 250,
                balanceAfter: 105,
                fulfillmentRef: 'sim_1',
                failureReason: null,
                replay: false,
              },
            }
          : (undefined as never),
    ]

    renderApp('rewards')
    await user.click(await screen.findByRole('button', { name: 'Redeem' }))
    await user.click(await screen.findByRole('button', { name: /Redeem for/ }))

    expect(await screen.findByText('Coffee Voucher redeemed')).toBeInTheDocument()

    const call = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url) === '/api/redemptions')
    const headers = (call?.[1]?.headers ?? {}) as Record<string, string>

    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  })

  /**
   * The case the copy requirement exists for.
   *
   * A failed fulfilment is a SUCCESSFUL request reporting a failed outcome, and
   * the compensating reversal has already run. A generic "something went wrong"
   * would leave the user believing their points are gone.
   */
  it('says the points were returned when fulfilment fails', async () => {
    const user = userEvent.setup()

    handlers = [
      (url, init) =>
        url === '/api/redemptions' && init?.method === 'POST'
          ? {
              status: 201,
              body: {
                redemptionId: 'r2',
                status: 'FAILED',
                rewardName: 'Coffee Voucher',
                costPoints: 250,
                balanceAfter: 355,
                fulfillmentRef: null,
                failureReason: 'Provider returned 503.',
                replay: false,
              },
            }
          : (undefined as never),
    ]

    renderApp('rewards')
    await user.click(await screen.findByRole('button', { name: 'Redeem' }))
    await user.click(await screen.findByRole('button', { name: /Redeem for/ }))

    expect(await screen.findByText('Coffee Voucher could not be issued')).toBeInTheDocument()
    expect(screen.getByText(/points have been returned/)).toBeInTheDocument()
  })

  it('reads insufficient points and out of stock differently', async () => {
    const user = userEvent.setup()

    handlers = [
      (url, init) =>
        url === '/api/redemptions' && init?.method === 'POST'
          ? {
              status: 409,
              body: {
                error: 'insufficient_points',
                message: 'Not enough points for this reward.',
                balance: 355,
                required: 750,
              },
            }
          : (undefined as never),
    ]

    renderApp('rewards')
    await user.click(await screen.findByRole('button', { name: 'Redeem' }))
    await user.click(await screen.findByRole('button', { name: /Redeem for/ }))

    // Scoped to the toast: the same phrase labels any unaffordable card, and
    // the assertion is about what the failed request said.
    const toast = await screen.findByRole('status')
    expect(within(toast).getByText('Not enough points yet')).toBeInTheDocument()
    expect(within(toast).getByText('You need 395 more points.')).toBeInTheDocument()
  })

  it('says something different when the reward sold out mid-flight', async () => {
    const user = userEvent.setup()

    handlers = [
      (url, init) =>
        url === '/api/redemptions' && init?.method === 'POST'
          ? { status: 409, body: { error: 'out_of_stock', message: 'Out of stock.' } }
          : (undefined as never),
    ]

    renderApp('rewards')
    await user.click(await screen.findByRole('button', { name: 'Redeem' }))
    await user.click(await screen.findByRole('button', { name: /Redeem for/ }))

    expect(await screen.findByText('That one just sold out')).toBeInTheDocument()
    expect(screen.getByText(/points have not been touched/)).toBeInTheDocument()
  })
})

describe('the activity list', () => {
  it('shows one row per ledger entry with a signed amount', async () => {
    renderApp()

    expect(await screen.findByText('Referred a friend')).toBeInTheDocument()
    expect(screen.getByText('+500')).toBeInTheDocument()

    // The spend is shown as its own row rather than netted against anything.
    expect(screen.getByText('Redeemed Coffee Voucher')).toBeInTheDocument()
    expect(screen.getByText('−250')).toBeInTheDocument()
  })

  it('tells a user with no history what to do next', async () => {
    handlers = [
      (url) =>
        url.startsWith('/api/me/transactions')
          ? { body: { items: [], nextCursor: null } }
          : (undefined as never),
    ]

    renderApp()

    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument()
    expect(screen.getByText(/simulate some/)).toBeInTheDocument()
  })
})

describe('navigation', () => {
  /**
   * Real links with real hrefs, so they can be middle-clicked, opened in a new
   * tab and copied — none of which a button calling navigate() supports.
   */
  it('links to each section and marks the current one', async () => {
    renderApp()

    const nav = await screen.findByRole('navigation', { name: /sections/i })
    const links = within(nav).getAllByRole('link')

    /*
      Asserted by href rather than by accessible name. Each item's name includes
      its hint — "Overview, Balance and recent activity" — so a name regex like
      /activity/i matches two of them. The href is the unambiguous identity.
    */
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '#/overview',
      '#/rewards',
      '#/activity',
    ])

    // aria-current is what tells a screen reader which page it is on; the active
    // styling alone is visible only to people who can see it.
    expect(links[0]).toHaveAttribute('aria-current', 'page')
    expect(links[1]).not.toHaveAttribute('aria-current')
  })

  it('shows the page named by the URL', async () => {
    renderApp('rewards')

    expect(await screen.findByRole('heading', { name: 'Rewards', level: 2 })).toBeInTheDocument()
  })

  /**
   * An unknown hash is not an error worth showing anyone — it falls back to the
   * landing page rather than rendering nothing at all.
   */
  it('falls back to the overview for an unknown route', async () => {
    window.location.hash = '/not-a-page'
    renderApp()

    expect(await screen.findByRole('region', { name: /your balance/i })).toBeInTheDocument()
  })

  /**
   * The drawer's state is announced through aria-expanded rather than inferred
   * from a class name, because that attribute is the whole contract: it is what
   * a screen reader reads out, and asserting on styling instead would let the
   * announcement break while the test still passed.
   *
   * jsdom applies no CSS, so this exercises the narrow-screen behaviour — the
   * stubbed matchMedia reports "not wide", which is the layout where closing
   * actually matters.
   */
  it('opens and closes the navigation drawer', async () => {
    const user = userEvent.setup()
    renderApp()

    const toggle = await screen.findByRole('button', { name: 'Navigation menu' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await user.click(screen.getByRole('button', { name: 'Close navigation menu' }))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // Focus returns to the control that opened it, rather than being left on a
    // button that has just slid off the screen.
    expect(toggle).toHaveFocus()
  })

  /**
   * On a narrow screen the drawer covers the page it navigates to, so a link
   * that left it open would hide the result of following it.
   */
  it('closes the drawer after following a link on a narrow screen', async () => {
    const user = userEvent.setup()
    renderApp()

    const toggle = await screen.findByRole('button', { name: 'Navigation menu' })
    await user.click(toggle)

    const nav = screen.getByRole('navigation', { name: /sections/i })
    await user.click(within(nav).getByRole('link', { name: /rewards/i }))

    expect(await screen.findByRole('heading', { name: 'Rewards', level: 2 })).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('the activity page', () => {
  /**
   * Filtering and ordering are server-side. Filtering the loaded page in the
   * browser would report a count drawn from the most recent fifteen entries
   * while ignoring every older one — an answer that looks precise and is wrong.
   */
  it('asks the server for the filtered, ordered list', async () => {
    const user = userEvent.setup()
    renderApp('activity')

    await screen.findByRole('heading', { name: 'Activity', level: 2 })

    await user.click(screen.getByRole('button', { name: 'Spent' }))

    await waitFor(() => {
      const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url))
      expect(urls.some((url) => url.includes('type=REDEEM'))).toBe(true)
    })
  })

  it('reorders through the server rather than reversing what is loaded', async () => {
    const user = userEvent.setup()
    renderApp('activity')

    await screen.findByRole('heading', { name: 'Activity', level: 2 })

    await user.selectOptions(screen.getByLabelText('Order'), 'oldest')

    await waitFor(() => {
      const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url))
      expect(urls.some((url) => url.includes('order=oldest'))).toBe(true)
    })
  })

  /**
   * A cursor is only meaningful for the query that issued it, so changing a
   * filter has to start a new list rather than resume an old one. The filters
   * being part of the query key is what guarantees that.
   */
  it('starts a new list rather than reusing a cursor from the old one', async () => {
    const user = userEvent.setup()
    renderApp('activity')

    await screen.findByRole('heading', { name: 'Activity', level: 2 })
    await user.click(screen.getByRole('button', { name: 'Earned' }))

    await waitFor(() => {
      const filtered = vi
        .mocked(fetch)
        .mock.calls.map(([url]) => String(url))
        .filter((url) => url.includes('type=EARN'))

      expect(filtered.length).toBeGreaterThan(0)
      // No cursor on the first request of a newly filtered list.
      expect(filtered[0]).not.toContain('cursor=')
    })
  })

  it('says what a filtered empty list means', async () => {
    const user = userEvent.setup()

    handlers = [
      (url) =>
        url.includes('type=REVERSAL')
          ? { body: { items: [], nextCursor: null } }
          : (undefined as never),
    ]

    renderApp('activity')
    await screen.findByRole('heading', { name: 'Activity', level: 2 })

    await user.click(screen.getByRole('button', { name: 'Refunded' }))

    expect(await screen.findByText(/No entries of that kind yet/i)).toBeInTheDocument()
  })
})

describe('the developer section', () => {
  /**
   * Hidden from ordinary users. Presentation only — the endpoints enforce the
   * same rule server-side, which is what actually protects them.
   */
  it('is not offered in the navigation to an ordinary user', async () => {
    renderApp()

    const nav = await screen.findByRole('navigation', { name: /sections/i })
    expect(within(nav).queryByRole('link', { name: /developer/i })).not.toBeInTheDocument()
  })

  /**
   * A URL is typed, pasted and bookmarked, so hiding the link is not the same as
   * refusing the page.
   */
  it('refuses the page to an ordinary user who navigates to it directly', async () => {
    renderApp('developer')

    expect(await screen.findByText(/for administrator accounts/i)).toBeInTheDocument()
  })

  it('is available to an administrator', async () => {
    handlers = [
      (url) =>
        url.startsWith('/api/auth/me') ? { status: 200, body: ADMIN } : (undefined as never),
    ]

    renderApp('developer')

    expect(await screen.findByRole('heading', { name: /developer panel/i })).toBeInTheDocument()
  })

  /**
   * Allocation is a bulk operation, and the recipients control has to both be
   * and look like a multiple choice.
   *
   * Asserted through the checkbox role rather than by clicking styled elements:
   * the previous pills were checkboxes too, under an appearance that read as a
   * single-choice tab strip, so "is it announced as a checkbox and does it hold
   * more than one" is exactly the property worth pinning down.
   */
  it('lets an administrator pick several recipients at once', async () => {
    const user = userEvent.setup()

    handlers = [
      (url) =>
        url.startsWith('/api/auth/me') ? { status: 200, body: ADMIN } : (undefined as never),
    ]

    renderApp('developer')

    const ada = await screen.findByRole('checkbox', { name: /Ada Lovelace/ })
    const alan = screen.getByRole('checkbox', { name: /Alan Turing/ })

    await user.click(ada)
    await user.click(alan)

    // The second choice adds to the first rather than replacing it.
    expect(ada).toBeChecked()
    expect(alan).toBeChecked()
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    await user.click(ada)

    expect(ada).not.toBeChecked()
    expect(alan).toBeChecked()
    expect(screen.getByText('1 selected')).toBeInTheDocument()
  })
})

describe('signing in', () => {
  /**
   * A 401 from the session endpoint is the ordinary signed-out state, not a
   * failure — the app has to read it that way rather than surfacing an error.
   */
  it('shows the sign-in form when there is no session', async () => {
    handlers = [
      (url) =>
        url.startsWith('/api/auth/me')
          ? { status: 401, body: { error: 'unauthenticated', message: 'Sign in to continue.' } }
          : (undefined as never),
    ]

    renderApp()

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()

    // Nothing personal is rendered before the session is known.
    await waitFor(() => {
      expect(screen.queryByText('Your balance')).not.toBeInTheDocument()
    })
  })

  /** The demo accounts are listed where they are needed, not in a README. */
  it('lists the demo accounts on the sign-in screen', async () => {
    handlers = [
      (url) =>
        url.startsWith('/api/auth/me')
          ? { status: 401, body: { error: 'unauthenticated', message: 'Sign in to continue.' } }
          : (undefined as never),
    ]

    renderApp()

    expect(await screen.findByText('Demo accounts')).toBeInTheDocument()
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
  })

  it('signs out and returns to the sign-in form', async () => {
    const user = userEvent.setup()
    let signedIn = true

    handlers = [
      (url, init) => {
        if (url.startsWith('/api/auth/logout') && init?.method === 'POST') {
          signedIn = false
          return { status: 204, body: null }
        }
        if (url.startsWith('/api/auth/me')) {
          return signedIn
            ? { status: 200, body: USERS[0] }
            : { status: 401, body: { error: 'unauthenticated', message: 'Sign in to continue.' } }
        }
        return undefined as never
      },
    ]

    renderApp()

    await user.click(await screen.findByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })
})
