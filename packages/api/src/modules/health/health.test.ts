import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'

describe('health', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  /**
   * Asserts the property that matters, not just the status code: liveness must
   * not depend on the database. This test runs with no database reachable, so
   * if someone later "improves" the probe by adding a connectivity check, this
   * fails — which is the whole point of it existing in Phase 0.
   */
  it('reports liveness without touching the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health/live' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  /**
   * Pins the error envelope, not just the status. Every failure in this API
   * answers with `{ error, message }` where `error` is a machine-readable code,
   * because the web client branches on it. Fastify's default 404 does not use
   * that shape, so this asserts the override is still in place.
   */
  it('returns the standard error envelope for an unknown route', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health/nope' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: 'not_found' })
  })
})
