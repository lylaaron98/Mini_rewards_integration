import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useRef, useState } from 'react'

import { EmptyState } from '../components/EmptyState'
import { RedeemDialog } from '../components/RedeemDialog'
import { RewardProgress } from '../components/RewardProgress'
import { Skeleton } from '../components/Skeleton'
import { ApiError, fetchRewards, redeemReward } from '../lib/api'
import type { Reward } from '../lib/api'
import { formatPoints } from '../lib/format'
import { describeRedemptionError, describeRedemptionOutcome } from '../lib/redemption-copy'
import { useToast } from '../lib/toast'

/**
 * The rewards shop.
 *
 * A catalogue is a browsing screen, so it gets the two things browsing screens
 * need: a way to search by name, and a way to narrow by the question the reader
 * actually has — which here is almost always "what can I get right now".
 */

type QuickFilter = 'all' | 'affordable' | 'almost' | 'in-stock'

const QUICK_FILTERS: Array<{ id: QuickFilter; label: string; hint: string }> = [
  { id: 'all', label: 'Everything', hint: 'Every reward in the catalogue' },
  { id: 'affordable', label: 'Can redeem now', hint: 'You have enough points and it is in stock' },
  {
    id: 'almost',
    label: 'Almost there',
    hint: 'More than halfway to affording it',
  },
  { id: 'in-stock', label: 'In stock', hint: 'Excludes anything sold out' },
]

export function RewardsPage({ balance }: { balance: number }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [search, setSearch] = useState('')
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all')
  const [pendingReward, setPendingReward] = useState<Reward | null>(null)

  /**
   * One idempotency key per redemption attempt, minted when the dialog opens.
   *
   * A key generated inside the request function would be new on every retry, so
   * a browser replaying a request after a flaky connection — or a user clicking
   * twice — would become two purchases. Held in a ref because it must not
   * trigger a render, and because the value read at submit time has to be the
   * one minted at open time.
   */
  const idempotencyKey = useRef<string | null>(null)

  const rewards = useQuery({ queryKey: ['rewards'], queryFn: fetchRewards })

  const closeDialog = useCallback(() => {
    setPendingReward(null)
    idempotencyKey.current = null
  }, [])

  const redeem = useMutation({
    mutationFn: (reward: Reward) =>
      redeemReward({
        rewardId: reward.id,
        idempotencyKey: idempotencyKey.current ?? crypto.randomUUID(),
      }),

    onSuccess: (outcome) => {
      // A 2xx does not mean the redemption succeeded — a failed fulfilment is a
      // successful request reporting a failed outcome, and it has already been
      // refunded. Saying so plainly is the difference between a user trusting
      // the balance and going looking for lost points.
      toast(describeRedemptionOutcome(outcome))
      closeDialog()
      void queryClient.invalidateQueries()
    },

    onError: (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        queryClient.clear()
        closeDialog()
        toast({ tone: 'error', title: 'Session expired', detail: 'Sign in again to continue.' })
        return
      }

      toast({ tone: 'error', ...describeRedemptionError(error) })
      closeDialog()
      void queryClient.invalidateQueries({ queryKey: ['me'] })
    },
  })

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase()

    return (rewards.data ?? []).filter((reward) => {
      // Searches the fields a person would actually type: the name they
      // remember, a word from the description, or the SKU if they have it from
      // somewhere else.
      const matchesSearch =
        term === '' ||
        reward.name.toLowerCase().includes(term) ||
        reward.description.toLowerCase().includes(term) ||
        reward.sku.toLowerCase().includes(term)

      if (!matchesSearch) return false

      switch (quickFilter) {
        case 'affordable':
          return reward.inStock && balance >= reward.costPoints
        case 'almost':
          // Halfway or better, but not yet affordable — the shelf of things
          // worth saving for, which is the question "almost there" asks.
          return balance < reward.costPoints && balance / reward.costPoints >= 0.5
        case 'in-stock':
          return reward.inStock
        default:
          return true
      }
    })
  }, [rewards.data, search, quickFilter, balance])

  const openDialog = (reward: Reward) => {
    idempotencyKey.current = crypto.randomUUID()
    setPendingReward(reward)
  }

  return (
    <section aria-labelledby="rewards-heading" aria-busy={rewards.isPending}>
      <header>
        <h2 id="rewards-heading" className="text-2xl font-semibold tracking-tight">
          Rewards
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          You have{' '}
          <span className="font-medium text-slate-900 dark:text-slate-100">
            {formatPoints(balance)} points
          </span>{' '}
          to spend.
        </p>
      </header>

      {/* Filters in one row above the results, so the controls and what they
          control never get separated by scrolling. */}
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="sm:max-w-xs sm:flex-1">
          <label
            htmlFor="reward-search"
            className="block text-sm font-medium text-slate-700 dark:text-slate-300"
          >
            Search
          </label>
          <input
            id="reward-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Coffee, tote, headphones…"
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Quick filters">
          {QUICK_FILTERS.map((filter) => {
            const active = quickFilter === filter.id

            return (
              <button
                key={filter.id}
                type="button"
                title={filter.hint}
                // aria-pressed, because these are toggles rather than links —
                // the state has to be announced, not just coloured.
                aria-pressed={active}
                onClick={() => setQuickFilter(filter.id)}
                className={`rounded-full border px-3 py-1.5 text-sm transition ${
                  active
                    ? 'border-slate-900 bg-slate-900 font-medium text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                    : 'border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                {filter.label}
              </button>
            )
          })}
        </div>
      </div>

      {/*
        The result count, announced politely. Someone typing into the search box
        gets no visual feedback that anything happened until they look at the
        grid; a live region tells a screen reader user the same thing.
      */}
      {!rewards.isPending && (
        <p aria-live="polite" className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          {visible.length === (rewards.data?.length ?? 0)
            ? `${visible.length} ${visible.length === 1 ? 'reward' : 'rewards'}`
            : `${visible.length} of ${rewards.data?.length ?? 0} rewards`}
        </p>
      )}

      {rewards.isPending && (
        <ul className="mt-4 grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, index) => (
            <li key={index} className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="mt-2 h-3 w-3/4" />
              <Skeleton className="mt-4 h-1.5 w-full" />
              <Skeleton className="mt-4 h-9 w-32" />
            </li>
          ))}
        </ul>
      )}

      {!rewards.isPending && visible.length === 0 && (
        <EmptyState
          title="Nothing matches"
          detail={
            search.trim() === ''
              ? 'Try a different filter — “Everything” shows the whole catalogue.'
              : `No reward matches “${search.trim()}”. Try a shorter search, or clear the filters.`
          }
        />
      )}

      {!rewards.isPending && visible.length > 0 && (
        <ul className="mt-4 grid gap-4 sm:grid-cols-2">
          {visible.map((reward) => (
            <RewardCard
              key={reward.id}
              reward={reward}
              balance={balance}
              isPending={redeem.isPending && pendingReward?.id === reward.id}
              onRedeem={openDialog}
            />
          ))}
        </ul>
      )}

      <RedeemDialog
        reward={pendingReward}
        balance={balance}
        isPending={redeem.isPending}
        onConfirm={() => pendingReward && redeem.mutate(pendingReward)}
        onClose={() => {
          if (!redeem.isPending) closeDialog()
        }}
      />
    </section>
  )
}

function RewardCard({
  reward,
  balance,
  isPending,
  onRedeem,
}: {
  reward: Reward
  balance: number
  isPending: boolean
  onRedeem: (reward: Reward) => void
}) {
  const affordable = balance >= reward.costPoints
  const redeemable = affordable && reward.inStock

  return (
    <li className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 transition hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-medium text-slate-900 dark:text-slate-100">{reward.name}</h3>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">{reward.description}</p>
        </div>

        <p className="shrink-0 text-right">
          <span className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {formatPoints(reward.costPoints)}
          </span>
          <span className="block text-xs text-slate-500 dark:text-slate-400">points</span>
        </p>
      </div>

      <RewardProgress balance={balance} costPoints={reward.costPoints} name={reward.name} />

      {/* mt-auto pins the action to the bottom, so cards of different description
          lengths still line their buttons up across the grid. */}
      <div className="mt-auto flex flex-wrap items-center gap-3 pt-4">
        {redeemable ? (
          <button
            type="button"
            onClick={() => onRedeem(reward)}
            disabled={isPending}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            {isPending ? 'Redeeming…' : 'Redeem'}
          </button>
        ) : (
          /*
            Not a greyed-out button. A disabled control says "you cannot do this"
            and nothing else; the progress bar above already says how far off the
            reader is, and this says why the button is absent.
          */
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
            {!reward.inStock ? 'Out of stock' : 'Not enough points yet'}
          </p>
        )}

        {reward.inStock && affordable && <Badge tone="ready">Ready to redeem</Badge>}
        {!reward.inStock && <Badge tone="warn">Sold out</Badge>}
      </div>
    </li>
  )
}

function Badge({ tone, children }: { tone: 'ready' | 'warn'; children: string }) {
  const classes =
    tone === 'ready'
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25'
      : 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/25'

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${classes}`}>
      {children}
    </span>
  )
}
