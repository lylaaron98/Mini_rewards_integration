import type { Tx } from '../../lib/db.js'

/**
 * Reading users and their balances.
 *
 * No writes here — users arrive with the seed, and points are written only by
 * the ledger.
 */

export type UserSummary = {
  id: string
  externalRef: string
  displayName: string
}

/**
 * A seeded account as the sign-in screen lists it.
 *
 * Includes the email so the screen can fill the form exactly rather than
 * guessing it from a display name — which broke the moment an account was
 * called "Dev Admin".
 *
 * Deliberately excludes the role. Publishing which account is privileged tells
 * an attacker which password is worth guessing, and the screen has no use for
 * it.
 */
export type DemoAccount = UserSummary & { email: string | null }

export type MeResponse = UserSummary & {
  email: string | null
  balance: number
}

/**
 * The acting user and their current balance.
 *
 * The balance is read from `user_balances`, not summed from the ledger. That is
 * the entire reason the cache exists: this is the most frequently hit read in
 * the application, and `SUM(delta)` over an append-only ledger gets slower every
 * time the user earns anything. One indexed row lookup does not.
 *
 * The cache is written in the same transaction as the ledger row that moves it,
 * and `reconcile()` proves the two agree — so reading it here is not a
 * correctness compromise, it is the payoff for having paid that cost on write.
 */
export async function getMe(tx: Tx, userId: string): Promise<MeResponse | null> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      externalRef: true,
      displayName: true,
      email: true,
      balance: { select: { balance: true } },
    },
  })

  if (!user) return null

  return {
    id: user.id,
    externalRef: user.externalRef,
    displayName: user.displayName,
    email: user.email,
    // A user who has never earned anything has no balance row at all. That is
    // zero, not missing data — the seeded dataset deliberately contains one, so
    // this path is exercised rather than theoretical.
    balance: user.balance?.balance ?? 0,
  }
}

/**
 * Every user, for the demo switcher.
 *
 * Exists only because authentication is stubbed. Real sessions would delete this
 * endpoint outright rather than adding authorisation to it — an endpoint that
 * lists every user in the system is not something to secure, it is something to
 * remove.
 */
export async function listUsers(tx: Tx): Promise<DemoAccount[]> {
  return tx.user.findMany({
    select: { id: true, externalRef: true, displayName: true, email: true },
    orderBy: { displayName: 'asc' },
  })
}
