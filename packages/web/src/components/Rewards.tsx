import type { Reward } from '../lib/api'
import { formatPoints } from '../lib/format'
import { EmptyState } from './EmptyState'
import { Skeleton } from './Skeleton'

/**
 * The catalogue.
 *
 * Whether a reward is affordable has to be obvious without reading a number and
 * doing subtraction — so an affordable reward gets a solid, live button, and an
 * unaffordable one says exactly how far away it is.
 */
export function Rewards({
  rewards,
  balance,
  isLoading,
  pendingRewardId,
  onRedeem,
}: {
  rewards: Reward[] | undefined
  balance: number
  isLoading: boolean
  pendingRewardId: string | null
  onRedeem: (reward: Reward) => void
}) {
  return (
    <section aria-labelledby="rewards-heading" aria-busy={isLoading}>
      <h2 id="rewards-heading" className="text-lg font-semibold text-slate-900">
        Rewards
      </h2>

      {isLoading && (
        <ul className="mt-4 space-y-3">
          {Array.from({ length: 4 }, (_, index) => (
            <li key={index} className="rounded-xl border border-slate-200 bg-white p-4">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="mt-2 h-3 w-2/3" />
              <Skeleton className="mt-4 h-9 w-32" />
            </li>
          ))}
        </ul>
      )}

      {!isLoading && rewards?.length === 0 && (
        <EmptyState
          title="No rewards yet"
          detail="The catalogue is empty. Run pnpm db:seed to load the development dataset."
        />
      )}

      {!isLoading && rewards && rewards.length > 0 && (
        <ul className="mt-4 space-y-3">
          {rewards.map((reward) => (
            <RewardCard
              key={reward.id}
              reward={reward}
              balance={balance}
              isPending={pendingRewardId === reward.id}
              onRedeem={onRedeem}
            />
          ))}
        </ul>
      )}
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
  const shortfall = reward.costPoints - balance
  const affordable = shortfall <= 0
  const redeemable = affordable && reward.inStock

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 transition hover:border-slate-300">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-medium text-slate-900">{reward.name}</h3>
          <p className="mt-0.5 text-sm text-slate-600">{reward.description}</p>
        </div>

        <p className="shrink-0 text-right">
          <span className="text-lg font-semibold tabular-nums text-slate-900">
            {formatPoints(reward.costPoints)}
          </span>
          <span className="block text-xs text-slate-500">points</span>
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {redeemable ? (
          <button
            type="button"
            onClick={() => onRedeem(reward)}
            disabled={isPending}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? 'Redeeming…' : 'Redeem'}
          </button>
        ) : (
          /*
            Not a greyed-out button.

            A disabled control tells the user they cannot do something and
            nothing else — they are left to work out why, and whether it is
            permanent. Saying "395 more needed" answers the question they
            actually have, and turns a dead end into a target. It is also
            focusable text rather than an unfocusable disabled control, so it is
            reachable by a screen reader.
          */
          <p className="text-sm font-medium text-slate-500">
            {!reward.inStock
              ? 'Out of stock'
              : `${formatPoints(shortfall)} more ${shortfall === 1 ? 'point' : 'points'} needed`}
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
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
      : 'bg-amber-50 text-amber-800 ring-amber-600/20'

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${classes}`}>
      {children}
    </span>
  )
}
