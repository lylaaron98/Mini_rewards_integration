import { useEffect, useRef } from 'react'

import type { Reward } from '../lib/api'
import { formatPoints } from '../lib/format'

/**
 * A confirmation step before spending points.
 *
 * Points cannot be un-spent by the user. Redeeming is the only irreversible
 * thing this app lets someone do, so it gets the one interruption in the whole
 * interface — and the interruption earns its place by showing the arithmetic:
 * balance now, cost, balance after. "Are you sure?" without the numbers asks a
 * question the user cannot answer any better than before it appeared.
 *
 * Built on the native `<dialog>` element, which brings focus trapping, Escape to
 * close, inertness of the page behind it, and a backdrop — all correct, all for
 * free. A hand-rolled modal gets the visuals right and the focus management
 * wrong, and the failure is invisible unless you navigate by keyboard.
 */
export function RedeemDialog({
  reward,
  balance,
  isPending,
  onConfirm,
  onClose,
}: {
  reward: Reward | null
  balance: number
  isPending: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (reward && !dialog.open) {
      dialog.showModal()
    } else if (!reward && dialog.open) {
      dialog.close()
    }
  }, [reward])

  /**
   * Escape and the backdrop both fire `close` natively, so the parent's state
   * has to follow the element rather than the other way around — otherwise the
   * dialog shuts while the app still believes it is open, and it can never be
   * reopened for the same reward.
   */
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const handleClose = () => onClose()
    dialog.addEventListener('close', handleClose)
    return () => dialog.removeEventListener('close', handleClose)
  }, [onClose])

  // Escape during an in-flight request would leave the user with no idea
  // whether it completed. The request is idempotent, so nothing breaks — but the
  // uncertainty is worse than a two-second wait.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const blockEscapeWhilePending = (event: Event) => {
      if (isPending) event.preventDefault()
    }

    dialog.addEventListener('cancel', blockEscapeWhilePending)
    return () => dialog.removeEventListener('cancel', blockEscapeWhilePending)
  }, [isPending])

  const balanceAfter = reward ? balance - reward.costPoints : balance

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="redeem-dialog-title"
      className="m-auto w-[calc(100vw-2rem)] max-w-md rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:backdrop-blur-[1px] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      {reward && (
        <div className="p-6">
          <h2 id="redeem-dialog-title" className="text-lg font-semibold">
            Redeem {reward.name}?
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{reward.description}</p>

          <dl className="mt-5 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
            <Row label="Balance now" value={formatPoints(balance)} />
            <Row label="Cost" value={`−${formatPoints(reward.costPoints)}`} />
            <Row label="Balance after" value={formatPoints(balanceAfter)} emphasis />
          </dl>

          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            Redeeming spends your points immediately. This cannot be undone from here.
          </p>

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Cancel
            </button>

            {/*
              Disabled while the request is in flight. The Idempotency-Key makes
              a double submission harmless on the server, but a button that
              still looks clickable invites the user to wonder whether the first
              click registered — and the fix for that is the button saying so.
            */}
            <button
              type="button"
              onClick={onConfirm}
              disabled={isPending}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
            >
              {isPending ? 'Redeeming…' : `Redeem for ${formatPoints(reward.costPoints)}`}
            </button>
          </div>
        </div>
      )}
    </dialog>
  )
}

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <dt className={`text-sm ${emphasis ? 'font-medium text-slate-900 dark:text-slate-100' : 'text-slate-600 dark:text-slate-400'}`}>
        {label}
      </dt>
      <dd
        className={`text-sm tabular-nums ${emphasis ? 'font-semibold text-slate-900 dark:text-slate-100' : 'text-slate-700 dark:text-slate-300'}`}
      >
        {value}
      </dd>
    </div>
  )
}
