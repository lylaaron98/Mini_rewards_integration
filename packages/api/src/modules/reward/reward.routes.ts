import type { FastifyInstance } from 'fastify'

import { prisma } from '../../lib/db.js'
import { listRewards } from './reward.service.js'

export async function rewardRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The catalogue. Readable without an acting user — what is on offer is not
   * personal to anyone, and the UI shows it while the user is still being
   * chosen.
   */
  app.get('/', async () => listRewards(prisma))
}
