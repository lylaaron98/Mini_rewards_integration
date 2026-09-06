import { describe, expect, it } from 'vitest'

import { REPLAY_WINDOW_MS, sign, verifySignature } from './signature.js'

const secret = 'test-webhook-signing-secret'
const rawBody = '{"event_id":"evt_1","user_ref":"u1"}'
const now = new Date('2026-09-06T12:00:00.000Z')
const timestamp = String(Math.floor(now.getTime() / 1000))

const valid = () => ({
  secret,
  rawBody,
  timestamp,
  signature: sign(secret, timestamp, rawBody),
  now,
})

describe('verifySignature', () => {
  it('accepts a correctly signed request', () => {
    expect(verifySignature(valid())).toEqual({ valid: true })
  })

  it('rejects a missing signature', () => {
    expect(verifySignature({ ...valid(), signature: undefined })).toEqual({
      valid: false,
      reason: 'missing_signature',
    })
  })

  it('rejects a missing timestamp', () => {
    expect(verifySignature({ ...valid(), timestamp: undefined })).toEqual({
      valid: false,
      reason: 'missing_timestamp',
    })
  })

  it('rejects a timestamp that is not a number', () => {
    expect(verifySignature({ ...valid(), timestamp: 'yesterday' })).toEqual({
      valid: false,
      reason: 'malformed_timestamp',
    })
  })

  /**
   * The property that matters most: the signature covers the body, so changing
   * a single character of it invalidates the request. Without this, an attacker
   * who captured one signed request could rewrite the user reference and credit
   * points to whoever they liked.
   */
  it('rejects a body that has been altered after signing', () => {
    const tampered = rawBody.replace('u1', 'u2')

    expect(verifySignature({ ...valid(), rawBody: tampered })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    })
  })

  /**
   * The timestamp is inside the signed string, so moving it forward to defeat
   * the replay window breaks the signature. This is what makes the freshness
   * check meaningful rather than advisory.
   */
  it('rejects a replayed request whose timestamp was moved forward', () => {
    const original = valid()
    const movedForward = String(Math.floor(now.getTime() / 1000) + 600)

    expect(
      verifySignature({ ...original, timestamp: movedForward, now: new Date(now.getTime() + 600_000) }),
    ).toEqual({ valid: false, reason: 'signature_mismatch' })
  })

  it('rejects a correctly signed request that is too old', () => {
    const staleAt = new Date(now.getTime() + REPLAY_WINDOW_MS + 1_000)

    expect(verifySignature({ ...valid(), now: staleAt })).toEqual({
      valid: false,
      reason: 'timestamp_outside_window',
    })
  })

  it('rejects a correctly signed request dated too far in the future', () => {
    const skewed = new Date(now.getTime() - REPLAY_WINDOW_MS - 1_000)

    expect(verifySignature({ ...valid(), now: skewed })).toEqual({
      valid: false,
      reason: 'timestamp_outside_window',
    })
  })

  it('accepts a request at the edge of the window', () => {
    const edge = new Date(now.getTime() + REPLAY_WINDOW_MS)

    expect(verifySignature({ ...valid(), now: edge })).toEqual({ valid: true })
  })

  it('rejects a signature produced with a different secret', () => {
    expect(
      verifySignature({ ...valid(), signature: sign('a-different-secret', timestamp, rawBody) }),
    ).toEqual({ valid: false, reason: 'signature_mismatch' })
  })

  /**
   * A short signature must not throw. `timingSafeEqual` raises on buffers of
   * unequal length, so the length check has to happen first — otherwise a
   * one-character signature is a 500 rather than a 401.
   */
  it('rejects a signature of the wrong length without throwing', () => {
    expect(verifySignature({ ...valid(), signature: 'ab' })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    })
  })
})
