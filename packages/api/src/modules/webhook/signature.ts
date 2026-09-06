import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * HMAC-SHA256 request signing, shared by the webhook route and the dev
 * simulator.
 *
 * `sign` is exported so the simulator produces genuine signatures rather than
 * being waved past verification. A test double that skips the check tests a
 * code path that does not exist in production — and the signature check is
 * exactly the part where a mistake is invisible until someone forges a request.
 */

export const SIGNATURE_HEADER = 'x-webhook-signature'
export const TIMESTAMP_HEADER = 'x-webhook-timestamp'

/**
 * How far a request timestamp may be from our clock, in either direction.
 *
 * This bounds how long a captured request stays replayable. It is a different
 * defence from event-id deduplication and both are needed: the window limits
 * the usefulness of a stolen request, while dedupe makes a *legitimate* retry
 * inside the window harmless.
 */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000

/**
 * The signed string is `${timestamp}.${rawBody}`.
 *
 * The timestamp is inside the signature rather than alongside it, which is what
 * makes the freshness check meaningful — an attacker replaying a captured
 * request cannot move its timestamp forward without invalidating the signature.
 * Signing the body alone would leave the timestamp as an unauthenticated field
 * that anyone could rewrite.
 */
export function sign(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
}

export type SignatureFailure =
  | 'missing_signature'
  | 'missing_timestamp'
  | 'malformed_timestamp'
  | 'timestamp_outside_window'
  | 'signature_mismatch'

export type VerificationResult = { valid: true } | { valid: false; reason: SignatureFailure }

export type VerifyInput = {
  secret: string
  /** The exact bytes received. Anything re-serialised will not verify. */
  rawBody: string
  signature: string | undefined
  /** Unix seconds, as sent. */
  timestamp: string | undefined
  /** Injectable so the freshness check is testable without waiting five minutes. */
  now?: Date
}

export function verifySignature(input: VerifyInput): VerificationResult {
  const { secret, rawBody, signature, timestamp } = input
  const now = input.now ?? new Date()

  if (!signature) return { valid: false, reason: 'missing_signature' }
  if (!timestamp) return { valid: false, reason: 'missing_timestamp' }

  const sentAtSeconds = Number(timestamp)
  if (!Number.isFinite(sentAtSeconds)) {
    return { valid: false, reason: 'malformed_timestamp' }
  }

  const expected = sign(secret, timestamp, rawBody)

  /**
   * Length is checked first because `timingSafeEqual` throws on buffers of
   * different lengths rather than returning false. Both values are hex SHA-256
   * digests, so a length difference means the input was not even the right
   * shape and reveals nothing about the secret.
   */
  const expectedBuffer = Buffer.from(expected, 'utf8')
  const providedBuffer = Buffer.from(signature, 'utf8')

  if (expectedBuffer.length !== providedBuffer.length) {
    return { valid: false, reason: 'signature_mismatch' }
  }

  // Constant time. A byte-by-byte comparison that returns early leaks how much
  // of a guess was correct, which is enough to recover a signature one byte at
  // a time given enough attempts.
  if (!timingSafeEqual(expectedBuffer, providedBuffer)) {
    return { valid: false, reason: 'signature_mismatch' }
  }

  /**
   * Freshness is checked *after* authenticity, deliberately.
   *
   * The timestamp is only trustworthy once the signature over it has been
   * verified. Checking the window first would mean rejecting or accepting based
   * on a number an attacker controls, and would also spend the decision on
   * unauthenticated input.
   *
   * Both directions matter. A timestamp far in the future is as suspicious as
   * one far in the past, and clock skew cuts both ways.
   */
  const ageMs = Math.abs(now.getTime() - sentAtSeconds * 1000)
  if (ageMs > REPLAY_WINDOW_MS) {
    return { valid: false, reason: 'timestamp_outside_window' }
  }

  return { valid: true }
}
