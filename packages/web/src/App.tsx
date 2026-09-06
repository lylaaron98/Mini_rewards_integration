import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'

import { Balance } from './components/Balance'
import { DevPanel } from './components/DevPanel'
import { History } from './components/History'
import { RedeemDialog } from './components/RedeemDialog'
import { Rewards } from './components/Rewards'
import { UserSwitcher } from './components/UserSwitcher'
import { fetchMe, fetchRewards, fetchTransactions, fetchUsers, redeemReward } from './lib/api'
import type { Reward } from './lib/api'
import { describeRedemptionError, describeRedemptionOutcome } from './lib/redemption-copy'
import { useToast } from './lib/toast'
import { useDemoUser } from './lib/use-demo-user'

export function App() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [externalRef, selectUser] = useDemoUser()
  const [pendingReward, setPendingReward] = useState<Reward | null>(null)

  /**
   * One idempotency key per redemption attempt, minted when the dialog opens.
   *
   * A key generated inside the request function would be new on every retry, so
   * a browser replaying a request after a flaky connection — or a user clicking
   * twice — would become two purchases. Held in a ref rather than state because
   * it must not trigger a render, and because the value read at submit time has
   * to be the one minted at open time even if the component re-rendered in
   * between.
   */
  const idempotencyKey = useRef<string | null>(null)

  const users = useQuery({ queryKey: ['users'], queryFn: fetchUsers })

  const me = useQuery({
    queryKey: ['me', externalRef],
    queryFn: () => fetchMe(externalRef ?? ''),
    enabled: externalRef !== null,
  })

  const rewards = useQuery({ queryKey: ['rewards'], queryFn: fetchRewards })

  const transactions = useInfiniteQuery({
    queryKey: ['transactions', externalRef],
    queryFn: ({ pageParam }) => fetchTransactions(externalRef ?? '', pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: externalRef !== null,
  })

  const redeem = useMutation({
    mutationFn: (reward: Reward) =>
      redeemReward({
        externalRef: externalRef ?? '',
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
      toast({ tone: 'error', ...describeRedemptionError(error) })
      closeDialog()
      // The balance may be the reason this failed and may itself be stale.
      void queryClient.invalidateQueries({ queryKey: ['me', externalRef] })
    },
  })

  const openDialog = useCallback((reward: Reward) => {
    idempotencyKey.current = crypto.randomUUID()
    setPendingReward(reward)
  }, [])

  const closeDialog = useCallback(() => {
    setPendingReward(null)
    idempotencyKey.current = null
  }, [])

  const entries = transactions.data?.pages.flatMap((page) => page.items)
  const balance = me.data?.balance ?? 0

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Mini Rewards</h1>
            <p className="text-sm text-slate-500">Earn points from partner activity, spend them on rewards.</p>
          </div>

          <UserSwitcher users={users.data} selected={externalRef} onSelect={selectUser} />
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        {externalRef === null ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <p className="font-medium">Choose a user to begin</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-slate-600">
              Authentication is stubbed for this exercise. Pick someone from the switcher above to
              act as them.
            </p>
          </div>
        ) : (
          <>
            <Balance
              balance={me.data?.balance}
              displayName={me.data?.displayName}
              isLoading={me.isPending}
            />

            {me.isError && (
              <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
                Could not load your balance. Is the API running?
              </p>
            )}

            {/*
              Two columns on desktop, stacked on mobile — and rewards first in
              the source order, so a narrow screen shows what you can do before
              what already happened.
            */}
            <div className="grid gap-6 lg:grid-cols-2">
              <Rewards
                rewards={rewards.data}
                balance={balance}
                isLoading={rewards.isPending}
                pendingRewardId={redeem.isPending ? (pendingReward?.id ?? null) : null}
                onRedeem={openDialog}
              />

              <History
                entries={entries}
                isLoading={transactions.isPending}
                isFetchingMore={transactions.isFetchingNextPage}
                hasMore={transactions.hasNextPage}
                onLoadMore={() => void transactions.fetchNextPage()}
              />
            </div>
          </>
        )}

        <DevPanel userRef={externalRef} />
      </main>

      <RedeemDialog
        reward={pendingReward}
        balance={balance}
        isPending={redeem.isPending}
        onConfirm={() => pendingReward && redeem.mutate(pendingReward)}
        onClose={() => {
          // The native dialog fires `close` on Escape and on backdrop dismissal
          // too, so this runs on every route out. Ignoring it mid-request would
          // strand the key; the mutation's own handlers close it on completion.
          if (!redeem.isPending) closeDialog()
        }}
      />
    </div>
  )
}
