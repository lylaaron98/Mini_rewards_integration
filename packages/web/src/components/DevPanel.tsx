import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { fetchDeliveries, fetchReconcile, simulateActivity } from '../lib/api'
import type { Delivery } from '../lib/api'
import { formatTimestamp } from '../lib/format'
import { useToast } from '../lib/toast'

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
export function DevPanel({ userRef }: { userRef: string | null }) {
  const [open, setOpen] = useState(false)

  return (
    <section aria-labelledby="dev-heading" className="rounded-xl border border-slate-200 bg-white">
      <h2 id="dev-heading">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-4 p-4 text-left"
        >
          <span>
            <span className="font-semibold text-slate-900">Developer panel</span>
            <span className="mt-0.5 block text-sm text-slate-500">
              Send signed partner events and inspect what the service did with them
            </span>
          </span>
          <span aria-hidden="true" className="text-slate-400">
            {open ? '−' : '+'}
          </span>
        </button>
      </h2>

      {open && (
        <div className="space-y-6 border-t border-slate-100 p-4">
          <Simulator userRef={userRef} />
          <Deliveries />
          <Reconcile />
        </div>
      )}
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

function Simulator({ userRef }: { userRef: string | null }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [lastEventId, setLastEventId] = useState<string | null>(null)

  const send = useMutation({
    mutationFn: (input: { activityType: string; eventId?: string }) =>
      simulateActivity({
        userRef: userRef ?? '',
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
      <h3 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
        Simulate partner activity
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        Signs a real payload with the partner secret and posts it to the webhook, exactly as the
        partner would.
      </p>

      {!userRef && (
        <p className="mt-3 text-sm text-amber-800">Choose a user above before sending events.</p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {ACTIVITIES.map((activity) => (
          <button
            key={activity.type}
            type="button"
            title={activity.hint}
            disabled={!userRef || send.isPending}
            onClick={() => send.mutate({ activityType: activity.type })}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
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
          className="mt-3 rounded-lg border border-dashed border-slate-400 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
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
      <h3 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
        Recent deliveries
      </h3>

      {deliveries.data && (
        <p className="mt-1 text-sm text-slate-600">
          {deliveries.data.summary.unmatched} of {deliveries.data.summary.total} parked as
          unmatched
          {deliveries.data.summary.noRule > 0 && ` · ${deliveries.data.summary.noRule} with no rule`}
          {deliveries.data.summary.unknownUser > 0 &&
            ` · ${deliveries.data.summary.unknownUser} for unknown users`}
        </p>
      )}

      <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-200">
        <ul className="divide-y divide-slate-100">
          {deliveries.data?.deliveries.map((delivery) => (
            <DeliveryRow key={delivery.id} delivery={delivery} />
          ))}
        </ul>

        {deliveries.data?.deliveries.length === 0 && (
          <p className="p-4 text-sm text-slate-500">No deliveries yet.</p>
        )}
      </div>
    </div>
  )
}

function DeliveryRow({ delivery }: { delivery: Delivery }) {
  return (
    <li className="flex items-start justify-between gap-3 p-3 text-sm">
      <div className="min-w-0">
        <p className="truncate font-mono text-xs text-slate-500">{delivery.externalEventId}</p>
        <p className="mt-0.5 text-slate-700">
          {delivery.activityType ?? 'unknown activity'}
          {delivery.userRef && <span className="text-slate-500"> · {delivery.userRef}</span>}
        </p>
        {delivery.error && <p className="mt-0.5 text-xs text-slate-500">{delivery.error}</p>}
        <p className="mt-0.5 text-xs text-slate-400">
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
    PROCESSED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
    UNMATCHED: 'bg-amber-50 text-amber-800 ring-amber-600/20',
    REJECTED: 'bg-red-50 text-red-700 ring-red-600/20',
    FAILED: 'bg-red-50 text-red-700 ring-red-600/20',
    RECEIVED: 'bg-slate-100 text-slate-600 ring-slate-500/20',
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
      <h3 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
        Ledger reconciliation
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        Every cached balance compared against the sum of its ledger. Empty is healthy.
      </p>

      {reconcile.data && (
        <p
          className={`mt-3 rounded-lg border p-3 text-sm ${
            reconcile.data.healthy
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-900'
          }`}
        >
          {reconcile.data.healthy
            ? 'All balances agree with the ledger.'
            : `${reconcile.data.discrepancies.length} balance(s) disagree with the ledger.`}
        </p>
      )}

      {reconcile.data && !reconcile.data.healthy && (
        <ul className="mt-2 space-y-1 text-sm text-slate-700">
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
