import { PrismaClient } from '@prisma/client'
import type { ITXClientDenyList } from '@prisma/client/runtime/library'

import { env } from '../env.js'

/**
 * The transaction client every service function accepts as its first argument.
 *
 * WHY THIS TYPE EXISTS
 * --------------------
 * Two rules in this codebase pull in opposite directions:
 *
 *   1. A redemption must debit the balance, write the ledger row and decrement
 *      reward stock atomically — one transaction or none.
 *   2. Modules are self-contained. Redemption may not reach into the ledger's
 *      tables; it may only call an exported ledger service function.
 *
 * If each service opened its own `prisma.$transaction`, rule 2 would hold and
 * rule 1 would quietly break: three independent transactions, three
 * independent commit points, and a crash in the middle leaves points debited
 * for a reward that was never reserved.
 *
 * The resolution is that *the caller owns the transaction boundary*. A service
 * never opens one; it accepts an open one. So the redemption service opens a
 * single transaction and threads it through `ledger.appendEntry(tx, ...)`, and
 * both rules hold at once.
 *
 * `ITXClientDenyList` is Prisma's list of members that do not exist on a
 * transaction client — `$transaction`, `$connect`, `$disconnect`, and friends.
 * Omitting them is what makes the convention enforceable by the compiler rather
 * than by discipline: inside a service, `tx.$transaction(...)` is a type error,
 * so nobody can accidentally nest a second boundary.
 */
export type Tx = Omit<PrismaClient, ITXClientDenyList>

/**
 * The one long-lived client. Everything that opens a transaction opens it here.
 *
 * Note that `PrismaClient` is structurally assignable to `Tx` — it has every
 * member `Tx` has, plus the omitted ones. That is deliberate and useful: a
 * read-only path with nothing to make atomic can pass `prisma` directly as the
 * `tx` argument and satisfy the convention without paying for a transaction it
 * does not need. Anything that *writes* points opens a real one.
 */
export const prisma = new PrismaClient({
  // Query logging in development only. In production these lines would carry
  // user references and point amounts into the log aggregator, which is a data
  // exposure problem rather than an observability win.
  //
  // Silent under test. Several integration tests assert that a constraint
  // rejects a bad write, and logging those expected errors buries a passing
  // run in what looks like a stack of failures.
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : env.NODE_ENV === 'test' ? [] : ['error'],
})
