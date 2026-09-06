import { randomUUID } from 'node:crypto'

import { env } from '../../env.js'

/**
 * The third-party fulfilment call, stubbed.
 *
 * Stands in for whatever actually issues the reward — a voucher provider, a
 * shipping system, an internal service. What matters for this exercise is not
 * what it does but its shape: it is a network call that can succeed, fail, or
 * time out, and we do not control any of that.
 *
 * `FULFILLMENT_FAILURE_RATE` exists so the failure path is genuinely reachable.
 * A compensating reversal that has never actually run is a compensating
 * reversal that does not work — the failure branch is the one nobody exercises
 * by clicking around, and it is the one where points go missing.
 */

export type FulfillmentResult =
  | { ok: true; reference: string }
  | { ok: false; reason: string }

export type FulfillmentRequest = {
  redemptionId: string
  rewardSku: string
  userExternalRef: string
}

export async function fulfill(request: FulfillmentRequest): Promise<FulfillmentResult> {
  // Deliberately random rather than deterministic. A failure you can only
  // trigger by editing code is a failure nobody triggers; one that happens on
  // its own while you are clicking around is one you design for.
  if (Math.random() < env.FULFILLMENT_FAILURE_RATE) {
    return {
      ok: false,
      reason: `Fulfilment provider rejected ${request.rewardSku} (simulated failure).`,
    }
  }

  // A real provider returns an identifier for the thing it issued. Recorded on
  // the redemption so a support question — "where is my voucher" — is answerable
  // without asking the provider to search by guesswork.
  return { ok: true, reference: `sim_${randomUUID()}` }
}
