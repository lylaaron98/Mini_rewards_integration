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

export class RewardSkuTakenError extends Error {
  readonly code = 'sku_taken'
  constructor(readonly sku: string) {
    super(`A reward with SKU ${sku} already exists.`)
    this.name = 'RewardSkuTakenError'
  }
}

export type CreateRewardInput = {
  sku: string
  name: string
  description: string
  costPoints: number
  /** Null means unlimited. */
  stock: number | null
}

/**
 * Adds a reward to the catalogue.
 *
 * The SKU is uppercased so `coffee-01` and `COFFEE-01` cannot become two
 * catalogue entries for the same thing. Normalising in one place rather than at
 * the call site is what keeps that true — a second caller that forgot would
 * reintroduce the duplicate the unique index is there to prevent.
 *
 * Duplicates surface as a typed error rather than a raw constraint violation,
 * because "a reward with that SKU already exists" is something an operator can
 * act on and `P2002` is not.
 */
export async function createReward(tx: Tx, input: CreateRewardInput): Promise<RewardSummary> {
  const sku = input.sku.trim().toUpperCase()

  const existing = await tx.reward.findUnique({ where: { sku }, select: { id: true } })
  if (existing) throw new RewardSkuTakenError(sku)

  const reward = await tx.reward.create({
    data: {
      sku,
      name: input.name.trim(),
      description: input.description.trim(),
      costPoints: input.costPoints,
      stock: input.stock,
      active: true,
    },
    select: { id: true, sku: true, name: true, description: true, costPoints: true, stock: true },
  })

  return {
    id: reward.id,
    sku: reward.sku,
    name: reward.name,
    description: reward.description,
    costPoints: reward.costPoints,
    inStock: reward.stock === null || reward.stock > 0,
  }
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
