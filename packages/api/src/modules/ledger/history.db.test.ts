import { randomUUID } from 'node:crypto'

import { TransactionType } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'

import { prisma } from '../../lib/db.js'
import { appendEntry, listTransactions } from './ledger.service.js'

/**
 * Cursor pagination, and specifically the property offset pagination lacks.
 *
 * Run with `pnpm db:up && pnpm test:db`.
 */

const TEST_PREFIX = 'test-history-'

async function createUserWithEntries(count: number): Promise<string> {
  const user = await prisma.user.create({
    data: { externalRef: `${TEST_PREFIX}${randomUUID()}`, displayName: 'History Test User' },
    select: { id: true },
  })

  for (let index = 0; index < count; index += 1) {
    await prisma.$transaction((tx) =>
      appendEntry(tx, {
        userId: user.id,
        delta: 10,
        type: TransactionType.EARN,
        source: 'partner:test',
        externalEventId: `evt-${randomUUID()}`,
        description: `Entry ${index}`,
        // Explicit, increasing timestamps so "newest first" is deterministic
        // rather than dependent on how fast the loop runs.
        createdAt: new Date(Date.now() - (count - index) * 60_000),
      }),
    )
  }

  return user.id
}

afterAll(async () => {
  const testUsers = { user: { externalRef: { startsWith: TEST_PREFIX } } }
  await prisma.pointTransaction.deleteMany({ where: testUsers })
  await prisma.userBalance.deleteMany({ where: testUsers })
  await prisma.user.deleteMany({ where: { externalRef: { startsWith: TEST_PREFIX } } })
  await prisma.$disconnect()
})

describe('listTransactions', () => {
  it('returns the newest entries first and reports another page', async () => {
    const userId = await createUserWithEntries(7)

    const page = await listTransactions(prisma, { userId, limit: 3 })

    expect(page.items).toHaveLength(3)
    expect(page.nextCursor).not.toBeNull()
    expect(page.items.map((entry) => entry.description)).toEqual([
      'Entry 6',
      'Entry 5',
      'Entry 4',
    ])
  })

  it('walks the whole ledger without repeating or skipping an entry', async () => {
    const userId = await createUserWithEntries(10)

    const seen: string[] = []
    let cursor: string | undefined

    for (let page = 0; page < 10; page += 1) {
      const result = await listTransactions(prisma, { userId, limit: 3, cursor })
      seen.push(...result.items.map((entry) => entry.description))

      if (result.nextCursor === null) break
      cursor = result.nextCursor
    }

    expect(seen).toHaveLength(10)
    expect(new Set(seen).size).toBe(10)
  })

  /**
   * The reason this is cursor-based rather than offset-based.
   *
   * A transaction history is a feed being appended to. With `OFFSET 3`, an entry
   * inserted between page one and page two pushes everything down by one, and
   * page two starts with a row the reader has already seen — while the row that
   * should have been there is silently skipped on a later page. Nothing errors.
   * The list just quietly lies, on the one screen whose entire purpose is that a
   * user can audit their own balance.
   *
   * A cursor says "strictly older than this exact entry", which is unaffected by
   * anything inserted since.
   */
  it('is unaffected by entries added between pages', async () => {
    const userId = await createUserWithEntries(6)

    const first = await listTransactions(prisma, { userId, limit: 3 })
    expect(first.nextCursor).not.toBeNull()

    // Three new entries land while the user is reading page one — exactly what
    // a webhook credit does.
    for (let index = 0; index < 3; index += 1) {
      await prisma.$transaction((tx) =>
        appendEntry(tx, {
          userId,
          delta: 5,
          type: TransactionType.EARN,
          source: 'partner:test',
          externalEventId: `evt-${randomUUID()}`,
          description: `Landed mid-scroll ${index}`,
        }),
      )
    }

    const second = await listTransactions(prisma, {
      userId,
      limit: 3,
      cursor: first.nextCursor ?? undefined,
    })

    // Page two continues exactly where page one stopped. With an offset it would
    // have started at "Entry 5" again.
    expect(second.items.map((entry) => entry.description)).toEqual([
      'Entry 2',
      'Entry 1',
      'Entry 0',
    ])

    // And none of the newly inserted entries leaked into a page that predates
    // them.
    for (const entry of second.items) {
      expect(entry.description).not.toContain('Landed mid-scroll')
    }
  })

  it('filters by type without breaking the cursor', async () => {
    const userId = await createUserWithEntries(4)

    await prisma.$transaction((tx) =>
      appendEntry(tx, {
        userId,
        delta: -10,
        type: TransactionType.REDEEM,
        source: 'redemption',
        description: 'A spend',
      }),
    )

    const spends = await listTransactions(prisma, {
      userId,
      limit: 10,
      type: TransactionType.REDEEM,
    })

    expect(spends.items).toHaveLength(1)
    expect(spends.items[0]?.description).toBe('A spend')
    expect(spends.nextCursor).toBeNull()
  })

  /**
   * A cursor that no longer decodes — an old link, a truncated copy-paste, a
   * changed sort key — starts from the beginning rather than erroring. There is
   * nothing a user could do with "invalid cursor", and showing them the top of
   * their own history is a better answer than showing them a failure.
   */
  it('treats an undecodable cursor as the start of the list', async () => {
    const userId = await createUserWithEntries(3)

    const page = await listTransactions(prisma, { userId, limit: 10, cursor: 'not-a-cursor' })

    expect(page.items).toHaveLength(3)
  })

  it('returns an empty page for a user with no history', async () => {
    const user = await prisma.user.create({
      data: { externalRef: `${TEST_PREFIX}${randomUUID()}`, displayName: 'Quiet User' },
      select: { id: true },
    })

    const page = await listTransactions(prisma, { userId: user.id, limit: 10 })

    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
  })
})
