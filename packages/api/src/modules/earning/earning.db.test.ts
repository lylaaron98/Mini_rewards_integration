import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import { prisma } from '../../lib/db.js'

/**
 * Proves the database refuses overlapping rule windows.
 *
 * The unit test next door proves the *seed data* satisfies the property. This
 * proves the property is enforced rather than merely observed — a rule inserted
 * by a future admin endpoint, a migration, or someone at a psql prompt is held
 * to it too. That is the difference between "our data happens to be correct"
 * and "incorrect data cannot be stored".
 *
 * Requires a running database: `pnpm db:up && pnpm test:db`.
 */

// A unique activity type per run, so these rows cannot collide with the seed's
// rules or with a concurrent run of this same suite.
const activityType = `TEST_OVERLAP_${randomUUID()}`

const rule = (from: string, to: string | null, active = true) => ({
  activityType,
  points: 10,
  effectiveFrom: new Date(from),
  effectiveTo: to === null ? null : new Date(to),
  active,
})

describe('earning_rules_no_overlapping_windows', () => {
  afterAll(async () => {
    await prisma.earningRule.deleteMany({ where: { activityType: { startsWith: 'TEST_OVERLAP_' } } })
    await prisma.$disconnect()
  })

  it('accepts windows that meet exactly, with no gap and no overlap', async () => {
    await prisma.earningRule.create({ data: rule('2030-01-01', '2030-06-01') })

    await expect(
      prisma.earningRule.create({ data: rule('2030-06-01', null) }),
    ).resolves.toMatchObject({ activityType })
  })

  it('rejects a second active rule whose window overlaps the first', async () => {
    const overlapping = rule('2030-03-01', '2030-04-01')

    // The existing open-ended rule from the previous test covers 2030-06-01
    // onwards; this one overlaps the closed rule that precedes it.
    await expect(prisma.earningRule.create({ data: overlapping })).rejects.toThrow(
      /earning_rules_no_overlapping_windows/,
    )
  })

  /**
   * The constraint is partial, on `active`. A superseded rule stays in the table
   * forever so the ledger entries it priced remain explicable, and it must not
   * block the rule that replaced it.
   */
  it('allows an inactive rule to overlap an active one', async () => {
    await expect(
      prisma.earningRule.create({ data: rule('2030-02-01', '2030-05-01', false) }),
    ).resolves.toMatchObject({ active: false })
  })

  /**
   * A backwards window would otherwise fail inside the range expression with
   * "range lower bound must be less than or equal to range upper bound", which
   * names PostgreSQL internals rather than the mistake.
   */
  it('rejects a window that ends before it starts', async () => {
    await expect(
      prisma.earningRule.create({ data: rule('2030-09-01', '2030-08-01') }),
    ).rejects.toThrow(/earning_rules_window_ordered/)
  })
})
