import type { Tx } from '../../lib/db.js'

/**
 * The reward catalogue.
 */

export type RewardSummary = {
  id: string
  sku: string
  name: string
  description: string
  costPoints: number
  /**
   * Whether this reward can be redeemed right now.
   *
   * Computed here rather than sent as a raw stock count, so the client never
   * has to know that `stock === null` means unlimited. Two reasons that matters:
   * a client reimplementing `stock === null || stock > 0` will eventually get it
   * backwards and show an unlimited reward as sold out; and exposing the real
   * count tells anyone watching exactly how much inventory is left, which is
   * commercial information the catalogue has no reason to publish.
   *
   * It is also advisory, not a guarantee. Between this read and a redemption the
   * last unit can go — which is why the redemption path decrements stock with a
   * conditional UPDATE and checks affected rows rather than trusting this flag.
   */
  inStock: boolean
}

export async function listRewards(tx: Tx): Promise<RewardSummary[]> {
  const rewards = await tx.reward.findMany({
    where: { active: true },
    select: {
      id: true,
      sku: true,
      name: true,
      description: true,
      costPoints: true,
      stock: true,
    },
    // Cheapest first, so the catalogue reads as a ladder the user climbs rather
    // than an arbitrary list.
    orderBy: { costPoints: 'asc' },
  })

  return rewards.map((reward) => ({
    id: reward.id,
    sku: reward.sku,
    name: reward.name,
    description: reward.description,
    costPoints: reward.costPoints,
    inStock: reward.stock === null || reward.stock > 0,
  }))
}
