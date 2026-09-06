import { prisma } from './lib/db.js'
import { reconcile } from './modules/ledger/ledger.service.js'

/**
 * Checks every cached balance against the ledger it is derived from.
 *
 * Exits non-zero when anything disagrees, so it works as a cron job or a
 * deployment gate rather than only as something a human reads. A cache that is
 * never compared against its source of truth is just a second source of truth
 * that nobody has noticed diverging yet.
 *
 * Passes `prisma` directly as the `tx`: this only reads, so it honours the
 * tx-first convention without opening a transaction it does not need.
 */
async function main(): Promise<void> {
  const discrepancies = await reconcile(prisma)

  if (discrepancies.length === 0) {
    const users = await prisma.user.count()
    console.log(`Reconciled ${users} users. No discrepancies.`)
    return
  }

  console.error(`${discrepancies.length} balance(s) disagree with the ledger:\n`)
  for (const row of discrepancies) {
    const sign = row.difference > 0 ? '+' : ''
    console.error(
      `  ${row.displayName} (${row.userId})\n` +
        `    cached: ${row.cachedBalance}, ledger: ${row.ledgerBalance} (${sign}${row.difference})`,
    )
  }

  // The ledger is the source of truth, so the fix is always to rewrite the
  // cache from it — never the other way around. Deliberately not done
  // automatically: a drift means something wrote a balance it should not have,
  // and silently papering over it destroys the evidence of what did.
  console.error('\nThe ledger is authoritative. Investigate before rewriting any balance.')
  process.exitCode = 1
}

main()
  .catch((error: unknown) => {
    console.error('Reconciliation failed:', error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
