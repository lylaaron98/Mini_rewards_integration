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
  { id: 'u1', externalRef: 'acme-user-001', displayName: 'Ada Lovelace' },
  { id: 'u3', externalRef: 'acme-user-003', displayName: 'Alan Turing' },
]

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
  window.localStorage.setItem('mini-rewards.demo-user', 'acme-user-001')

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)

      for (const handler of handlers) {
        const result = handler(url, init)
        if (result) return respond(result.status ?? 200, result.body)
      }

      if (url.startsWith('/api/demo/users')) return respond(200, USERS)
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
      if (url.startsWith('/api/dev/')) return respond(200, { deliveries: [], summary: {} })

      throw new Error(`Unhandled request: ${url}`)
    }),
  )
})

afterEach(() => {
  handlers = []
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

function renderApp() {
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

    expect(await within(balance).findByText('355')).toBeInTheDocument()
    expect(within(balance).getByText('points')).toBeInTheDocument()
    expect(within(balance).getByText(/Ada Lovelace/)).toBeInTheDocument()
  })

  it('announces the balance politely rather than interrupting', async () => {
    renderApp()

    const balance = await screen.findByRole('region', { name: /your balance/i })
    expect(await within(balance).findByText('355')).toHaveAttribute('aria-live', 'polite')
  })
})

describe('the reward catalogue', () => {
  it('offers a redeem button only for rewards the user can afford', async () => {
    renderApp()

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
    renderApp()

    expect(await screen.findByText('24,645 more points needed')).toBeInTheDocument()
  })

  it('marks a sold-out reward rather than offering it', async () => {
    renderApp()

    expect(await screen.findByText('Out of stock')).toBeInTheDocument()
    expect(screen.getByText('Sold out')).toBeInTheDocument()
  })
})

describe('redeeming', () => {
  it('shows the arithmetic before spending anything', async () => {
    const user = userEvent.setup()
    renderApp()

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

    renderApp()
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

    renderApp()
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

    renderApp()
    await user.click(await screen.findByRole('button', { name: 'Redeem' }))
    await user.click(await screen.findByRole('button', { name: /Redeem for/ }))

    expect(await screen.findByText('Not enough points yet')).toBeInTheDocument()
    expect(screen.getByText('You need 395 more points.')).toBeInTheDocument()
  })

  it('says something different when the reward sold out mid-flight', async () => {
    const user = userEvent.setup()

    handlers = [
      (url, init) =>
        url === '/api/redemptions' && init?.method === 'POST'
          ? { status: 409, body: { error: 'out_of_stock', message: 'Out of stock.' } }
          : (undefined as never),
    ]

    renderApp()
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

describe('choosing a user', () => {
  it('asks for a user before showing anything personal', async () => {
    window.localStorage.clear()
    renderApp()

    expect(await screen.findByText('Choose a user to begin')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByText('Your balance')).not.toBeInTheDocument()
    })
  })
})
