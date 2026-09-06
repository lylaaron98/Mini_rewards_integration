import { Writable } from 'node:stream'

import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'

/**
 * The protections that are easy to configure and easy to never verify.
 *
 * A rate limit nobody has watched refuse a request is a number in a config
 * file. These run against a real app instance, built with a deliberately tiny
 * limit, so the plugin, the ordering and the error envelope are all exercised.
 *
 * No database needed: every assertion is about what the server does before a
 * handler touches one.
 */

let app: FastifyInstance | null = null

afterEach(async () => {
  await app?.close()
  app = null
})

describe('rate limiting', () => {
  it('refuses the request after the limit and says when to retry', async () => {
    app = await buildApp({ rateLimit: { max: 2, timeWindow: '1 minute' } })

    const first = await app.inject({ method: 'GET', url: '/api/health/live' })
    const second = await app.inject({ method: 'GET', url: '/api/health/live' })
    const third = await app.inject({ method: 'GET', url: '/api/health/live' })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)

    expect(third.statusCode).toBe(429)
    expect(third.json()).toMatchObject({ error: 'rate_limited' })

    /**
     * 429 is a TRANSIENT signal, and `retry-after` is what makes it actionable.
     * Without it a partner has to guess how long to back off, and the usual
     * guess is "immediately", which is how a rate limit turns into a tight loop.
     */
    expect(third.headers['retry-after']).toBeDefined()
  })

  /**
   * The webhook is keyed by partner rather than by IP, and gets a much larger
   * allowance. A partner catching up after an outage bursts legitimately, and
   * throttling them there converts our protection into their lost events.
   */
  it('gives the webhook its own budget, separate from the rest of the API', async () => {
    app = await buildApp({ rateLimit: { max: 1, timeWindow: '1 minute' } })

    await app.inject({ method: 'GET', url: '/api/health/live' })
    const throttled = await app.inject({ method: 'GET', url: '/api/health/live' })
    expect(throttled.statusCode).toBe(429)

    // The webhook still answers — refusing on signature, which means it reached
    // the handler rather than being turned away by the global limit.
    const webhook = await app.inject({
      method: 'POST',
      url: '/api/webhooks/acme',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    })

    expect(webhook.statusCode).toBe(401)
  })
})

describe('request size', () => {
  /**
   * Fastify's 1 MB default is an invitation to buffer megabytes from an
   * unauthenticated caller. Every legitimate payload here is a few hundred
   * bytes.
   */
  it('refuses a body larger than the cap', async () => {
    app = await buildApp()

    const oversized = await app.inject({
      method: 'POST',
      url: '/api/webhooks/acme',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ event_id: 'x'.repeat(64 * 1024) }),
    })

    expect(oversized.statusCode).toBe(413)
  })
})

describe('logging', () => {
  /**
   * Headers are logged deliberately — debugging a partner integration comes down
   * to what they actually sent — and that is only safe because the signature and
   * any credentials are censored on the way out.
   *
   * Asserted by reading what was actually written, not by checking that the
   * configuration mentions redaction. A secret leaking into a log aggregator is
   * a real incident, and the only evidence that it cannot happen is the output.
   */
  it('never writes the signature or credential headers to the log', async () => {
    const written: string[] = []
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        written.push(chunk.toString())
        callback()
      },
    })

    app = await buildApp({ loggerDestination: destination })

    const secretSignature = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
    const secretToken = 'Bearer super-secret-token'

    await app.inject({
      method: 'GET',
      url: '/api/health/live',
      headers: {
        'x-webhook-signature': secretSignature,
        authorization: secretToken,
        'x-webhook-timestamp': '1788700000',
      },
    })

    const output = written.join('')

    expect(output).not.toContain(secretSignature)
    expect(output).not.toContain('super-secret-token')
    expect(output).toContain('[redacted]')

    // The non-sensitive headers still come through, which is the whole point of
    // logging them: a censored log that also hides the useful fields would have
    // been better off logging nothing.
    expect(output).toContain('1788700000')
  })
})
