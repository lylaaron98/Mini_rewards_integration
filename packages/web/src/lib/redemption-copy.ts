import { ApiError } from './api'
import type { RedemptionOutcome } from './api'
import { formatPoints } from './format'

/**
 * What to say when a redemption does not simply work.
 *
 * Distinct copy per error code, because these mean genuinely different things to
 * a person. "You need 395 more points" is something they can act on, and it
 * tells them exactly how far off they are. "Someone else took the last one" is
 * not their fault and there is nothing to do about it. Collapsing both into
 * "Redemption failed" throws away the only part of the message that was useful.
 */
export function describeRedemptionError(error: unknown): { title: string; detail: string } {
  if (!(error instanceof ApiError)) {
    return {
      title: 'Could not reach the server',
      detail: 'Check your connection and try again. No points have been taken.',
    }
  }

  switch (error.code) {
    case 'insufficient_points': {
      const balance = typeof error.details.balance === 'number' ? error.details.balance : null
      const required = typeof error.details.required === 'number' ? error.details.required : null
      const shortfall = balance !== null && required !== null ? required - balance : null

      return {
        title: 'Not enough points yet',
        detail:
          shortfall === null
            ? 'You do not have enough points for this reward.'
            : `You need ${formatPoints(shortfall)} more ${shortfall === 1 ? 'point' : 'points'}.`,
      }
    }

    case 'out_of_stock':
      return {
        title: 'That one just sold out',
        detail: 'Someone claimed the last one. Your points have not been touched.',
      }

    case 'reward_inactive':
      return {
        title: 'No longer available',
        detail: 'This reward has been withdrawn. Your points have not been touched.',
      }

    case 'reward_not_found':
      return {
        title: 'Reward not found',
        detail: 'Refresh the page — the catalogue may have changed.',
      }

    case 'unauthenticated':
      return {
        title: 'Pick a user first',
        detail: 'Choose someone from the switcher at the top of the page.',
      }

    default:
      return {
        title: 'Redemption failed',
        detail: error.message,
      }
  }
}

/**
 * What to say when the request SUCCEEDED but the redemption did not.
 *
 * A failed fulfilment is not an error from the API's point of view — the
 * redemption was created, the points were taken, the provider refused, and a
 * compensating reversal already put the points back. Saying "something went
 * wrong" here would be a lie by omission: the user would reasonably assume their
 * points are gone and go looking for them. Stating the refund plainly is the
 * whole reason this case is separated from the error path.
 */
export function describeRedemptionOutcome(outcome: RedemptionOutcome): {
  tone: 'success' | 'error' | 'info'
  title: string
  detail: string
} {
  if (outcome.status === 'FULFILLED') {
    return {
      tone: 'success',
      title: `${outcome.rewardName} redeemed`,
      detail: outcome.replay
        ? 'You had already redeemed this — no extra points were taken.'
        : `${formatPoints(outcome.costPoints)} points spent. New balance ${formatPoints(outcome.balanceAfter)}.`,
    }
  }

  if (outcome.status === 'FAILED') {
    return {
      tone: 'error',
      title: `${outcome.rewardName} could not be issued`,
      detail: `Your ${formatPoints(outcome.costPoints)} points have been returned. Balance is ${formatPoints(outcome.balanceAfter)}.`,
    }
  }

  return {
    tone: 'info',
    title: `${outcome.rewardName} is being issued`,
    detail: 'Your points are reserved. This usually completes in a moment.',
  }
}
