import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { fetchDeliveries, fetchReconcile, fetchUsers, simulateActivity } from '../lib/api'
import type { Delivery } from '../lib/api'
import { formatTimestamp } from '../lib/format'
import { useToast } from '../lib/toast'
import { RewardAdmin } from './RewardAdmin'

/**
 * The developer panel.
 *
 * Without it, the most interesting behaviour in this service is invisible.
 * Ingestion, deduplication, unmatched parking and reconciliation all sit behind
 * a webhook that requires a valid HMAC — so a reviewer would otherwise have to
 * hand-craft a signature in a terminal before they could see any of it work, and
 * most reasonably would not bother.
 *
 * The buttons post to `/api/dev/simulate-activity`, which SIGNS a real payload
 * and sends it through the real webhook route. Nothing here bypasses
 * verification; it is the partner's request, made from a button.
 */
export function DevPanel({ defaultUserRef }: { defaultUserRef: string }) {
  /**
   * Which user the simulated events are credited to.
   *
   * An administrator has no history of their own, so sending events to
   * themselves would demonstrate nothing. Choosing a target is also what the
   * tool actually is — an operator acting on behalf of a user — rather than a
   * shortcut that only works when you happen to be the person you are testing.
   */
  const [targetRef, setTargetRef] = useState(defaultUserRef)

  return (
    <section aria-labelledby="dev-heading">
      <h2 id="dev-heading" className="text-2xl font-semibold tracking-tight">
        Developer panel
      </h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Send signed partner events and inspect what the service did with them. Every button here
        goes through the real webhook, signature and all.
      </p>

      {/* No longer collapsible: it was a section competing for space on a shared
          page, and a page that opens collapsed is a page asking to be clicked
          before it does anything. */}
      <div className="mt-6 space-y-8">
        <Simulator targetRef={targetRef} onTargetChange={setTargetRef} />
        <RewardAdmin />
        <Deliveries />
        <Reconcile />
      </div>
    </section>
  )
}

/**
 * The activity types are chosen to demonstrate the three distinct outcomes a
 * partner event can have, which is more useful than a list of things that all
 * work.
 */
const ACTIVITIES = [
  { type: 'PURCHASE', label: 'Purchase', hint: 'Credits 15 points at the current rule' },
  { type: 'REFERRAL', label: 'Referral', hint: 'Credits 500 points' },
  { type: 'APP_REVIEW', label: 'App review', hint: 'Credits 50 points' },
  {
    type: 'SURVEY_COMPLETED',
    label: 'Survey (no rule)',
    hint: 'Parked as UNMATCHED / NO_RULE — accepted, credited nothing',
  },
]

function Simulator({
  targetRef,
  onTargetChange,
}: {
  targetRef: string
  onTargetChange: (ref: string) => void
}) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [lastEventId, setLastEventId] = useState<string | null>(null)
  const users = useQuery({ queryKey: ['demo-users'], queryFn: fetchUsers })

  const send = useMutation({
    mutationFn: (input: { activityType: string; eventId?: string }) =>
      simulateActivity({
        userRef: targetRef,
        activityType: input.activityType,
        ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      }),
    onSuccess: (result) => {
      setLastEventId(result.sentEventId)

      const status = result.webhookResponse.status
      const duplicate = result.webhookResponse.duplicate === true

      if (duplicate) {
        toast({
          tone: 'info',
          title: 'Duplicate ignored',
          detail: `The webhook answered ${result.webhookStatus}. No points moved — that is the dedupe constraint working.`,
        })
      } else if (status === 'UNMATCHED') {
        toast({
          tone: 'info',
          title: 'Parked as unmatched',
          detail: 'Accepted with 202 and credited nothing. It is listed below with its reason.',
        })
      } else if (status === 'PROCESSED') {
        toast({ tone: 'success', title: 'Event credited', detail: 'Balance and activity updated.' })
      } else {
        toast({
          tone: 'error',
          title: 'Event rejected',
          detail: `The webhook answered ${result.webhookStatus}.`,
        })
      }

      // Everything on the page can have changed: the balance, the ledger, the
      // deliveries list. Invalidating broadly is right here — the alternative is
      // enumerating dependencies that a reviewer clicking around will outgrow.
      void queryClient.invalidateQueries()
    },
    onError: (error: unknown) => {
      toast({
        tone: 'error',
        title: 'Could not send the event',
        detail: error instanceof Error ? error.message : 'Unknown error',
      })
    },
  })

  return (
    <div>
      <h3 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
        Simulate partner activity
      </h3>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Signs a real payload with the partner secret and posts it to the webhook, exactly as the
        partner would.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <label htmlFor="sim-target" className="text-sm text-slate-600 dark:text-slate-400">
          Credit to
        </label>
        <select
          id="sim-target"
          value={targetRef}
          onChange={(event) => onTargetChange(event.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        >
          {users.data?.map((user) => (
            <option key={user.id} value={user.externalRef}>
              {user.displayName}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {ACTIVITIES.map((activity) => (
          <button
            key={activity.type}
            type="button"
            title={activity.hint}
            disabled={send.isPending}
            onClick={() => send.mutate({ activityType: activity.type })}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {activity.label}
          </button>
        ))}
      </div>

      {/*
        Replaying the previous event id is the single most illuminating button
        here: the same event sent twice is answered 200 with duplicate: true and
        moves no points, which is the at-least-once guarantee made visible.
      */}
      {lastEventId && (
        <button
          type="button"
          disabled={send.isPending}
          onClick={() => send.mutate({ activityType: 'PURCHASE', eventId: lastEventId })}
          className="mt-3 rounded-lg border border-dashed border-slate-400 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          Replay the last event id (should credit nothing)
        </button>
      )}
    </div>
  )
}

function Deliveries() {
  const deliveries = useQuery({ queryKey: ['deliveries'], queryFn: fetchDeliveries })

  return (
    <div>
      <h3 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
        Recent deliveries
      </h3>

      {deliveries.data && (
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {deliveries.data.summary.unmatched} of {deliveries.data.summary.total} parked as
          unmatched
          {deliveries.data.summary.noRule > 0 && ` · ${deliveries.data.summary.noRule} with no rule`}
          {deliveries.data.summary.unknownUser > 0 &&
            ` · ${deliveries.data.summary.unknownUser} for unknown users`}
        </p>
      )}

      <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {deliveries.data?.deliveries.map((delivery) => (
            <DeliveryRow key={delivery.id} delivery={delivery} />
          ))}
        </ul>

        {deliveries.data?.deliveries.length === 0 && (
          <p className="p-4 text-sm text-slate-500 dark:text-slate-400">No deliveries yet.</p>
        )}
      </div>
    </div>
  )
}

function DeliveryRow({ delivery }: { delivery: Delivery }) {
  return (
    <li className="flex items-start justify-between gap-3 p-3 text-sm">
      <div className="min-w-0">
        <p className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">{delivery.externalEventId}</p>
        <p className="mt-0.5 text-slate-700 dark:text-slate-300">
          {delivery.activityType ?? 'unknown activity'}
          {delivery.userRef && <span className="text-slate-500 dark:text-slate-400"> · {delivery.userRef}</span>}
        </p>
        {delivery.error && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{delivery.error}</p>}
        <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
          {formatTimestamp(delivery.receivedAt)}
          {delivery.attempts > 1 && ` · seen ${delivery.attempts} times`}
        </p>
      </div>

      <StatusBadge delivery={delivery} />
    </li>
  )
}

function StatusBadge({ delivery }: { delivery: Delivery }) {
  const tone: Record<Delivery['status'], string> = {
    PROCESSED:
      'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25',
    UNMATCHED:
      'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/25',
    REJECTED:
      'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/25',
    FAILED:
      'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/25',
    RECEIVED:
      'bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-400/25',
  }

  // The reason is shown, not just the status: NO_RULE and UNKNOWN_USER are fixed
  // differently, and that distinction is the entire reason the column exists.
  const label = delivery.unmatchedReason
    ? `${delivery.status} · ${delivery.unmatchedReason}`
    : delivery.status

  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone[delivery.status]}`}
    >
      {label}
    </span>
  )
}

function Reconcile() {
  const reconcile = useQuery({ queryKey: ['reconcile'], queryFn: fetchReconcile })

  return (
    <div>
      <h3 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
        Ledger reconciliation
      </h3>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Every cached balance compared against the sum of its ledger. Empty is healthy.
      </p>

      {reconcile.data && (
        <p
          className={`mt-3 rounded-lg border p-3 text-sm ${
            reconcile.data.healthy
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950 dark:text-emerald-100'
              : 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950 dark:text-red-100'
          }`}
        >
          {reconcile.data.healthy
            ? 'All balances agree with the ledger.'
            : `${reconcile.data.discrepancies.length} balance(s) disagree with the ledger.`}
        </p>
      )}

      {reconcile.data && !reconcile.data.healthy && (
        <ul className="mt-2 space-y-1 text-sm text-slate-700 dark:text-slate-300">
          {reconcile.data.discrepancies.map((row) => (
            <li key={row.userId}>
              {row.displayName}: cached {row.cachedBalance}, ledger {row.ledgerBalance}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
