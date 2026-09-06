/**
 * The single place the frontend talks to the API.
 *
 * `fetch` resolves successfully on a 4xx or 5xx, which means the naive version
 * of this function hands a parsed error body to a component as if it were data.
 * Everything downstream — TanStack Query's `isError`, the toasts, the redeem
 * dialog — depends on a failed request actually rejecting, so that translation
 * happens here, once, rather than in every caller.
 */
export class ApiError extends Error {
  readonly status: number
  /** Machine-readable code from the API envelope. Toast copy branches on this. */
  readonly code: string
  /** Extra fields the API attached, such as `balance` and `required`. */
  readonly details: Record<string, unknown>

  constructor(status: number, code: string, message: string, details: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST'
  body?: unknown
  /** Extra headers — how the demo user and the idempotency key travel. */
  headers?: Record<string, string>
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {} } = options

  const response = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  // A 503 from the readiness probe has a JSON body worth reading; a crashed
  // process or a proxy error may return HTML. Parsing defensively keeps the
  // second case from throwing a confusing SyntaxError over the real failure.
  const payload: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const details =
      payload !== null && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {}

    throw new ApiError(
      response.status,
      typeof details.error === 'string' ? details.error : 'unknown_error',
      typeof details.message === 'string'
        ? details.message
        : `Request failed with status ${response.status}`,
      details,
    )
  }

  return payload as T
}

// ---------------------------------------------------------------------------
// Types, mirroring the API responses
// ---------------------------------------------------------------------------

export type HealthReport = {
  status: 'ok' | 'degraded'
  database: 'up' | 'down'
  error?: string
}

export type UserSummary = {
  id: string
  externalRef: string
  displayName: string
}

export type Me = UserSummary & {
  email: string | null
  balance: number
}

export type Reward = {
  id: string
  sku: string
  name: string
  description: string
  costPoints: number
  inStock: boolean
}

export type TransactionType = 'EARN' | 'REDEEM' | 'REVERSAL' | 'ADJUSTMENT'

export type LedgerEntry = {
  id: string
  delta: number
  type: TransactionType
  description: string
  source: string
  createdAt: string
}

export type TransactionPage = {
  items: LedgerEntry[]
  nextCursor: string | null
}

export type RedemptionStatus = 'RESERVED' | 'FULFILLED' | 'FAILED'

export type RedemptionOutcome = {
  redemptionId: string
  status: RedemptionStatus
  rewardName: string
  costPoints: number
  balanceAfter: number
  fulfillmentRef: string | null
  failureReason: string | null
  replay: boolean
}

export type Delivery = {
  id: string
  partner: string
  externalEventId: string
  status: 'RECEIVED' | 'PROCESSED' | 'UNMATCHED' | 'REJECTED' | 'FAILED'
  unmatchedReason: 'UNKNOWN_USER' | 'NO_RULE' | null
  userRef: string | null
  activityType: string | null
  error: string | null
  attempts: number
  receivedAt: string
  processedAt: string | null
}

export type DeliveriesResponse = {
  deliveries: Delivery[]
  summary: { total: number; unmatched: number; noRule: number; unknownUser: number }
}

export type ReconcileResponse = {
  healthy: boolean
  discrepancies: Array<{
    userId: string
    displayName: string
    cachedBalance: number
    ledgerBalance: number
    difference: number
  }>
}

export type SimulateResponse = {
  sentEventId: string
  webhookStatus: number
  webhookResponse: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** The stubbed auth seam. See plugins/auth.ts on the server. */
const DEMO_USER_HEADER = 'X-Demo-User'

const asUser = (externalRef: string) => ({ [DEMO_USER_HEADER]: externalRef })

export function fetchHealth(): Promise<HealthReport> {
  return apiRequest<HealthReport>('/api/health/ready')
}

export function fetchUsers(): Promise<UserSummary[]> {
  return apiRequest<UserSummary[]>('/api/demo/users')
}

export function fetchMe(externalRef: string): Promise<Me> {
  return apiRequest<Me>('/api/me', { headers: asUser(externalRef) })
}

export function fetchRewards(): Promise<Reward[]> {
  return apiRequest<Reward[]>('/api/rewards')
}

export function fetchTransactions(
  externalRef: string,
  cursor?: string,
): Promise<TransactionPage> {
  const query = new URLSearchParams({ limit: '15' })
  if (cursor) query.set('cursor', cursor)

  return apiRequest<TransactionPage>(`/api/me/transactions?${query.toString()}`, {
    headers: asUser(externalRef),
  })
}

export function redeemReward(input: {
  externalRef: string
  rewardId: string
  idempotencyKey: string
}): Promise<RedemptionOutcome> {
  return apiRequest<RedemptionOutcome>('/api/redemptions', {
    method: 'POST',
    body: { rewardId: input.rewardId },
    headers: {
      ...asUser(input.externalRef),
      /**
       * Generated once per redemption attempt by the caller, never here. If this
       * function minted the key, every retry would carry a fresh one and each
       * would be a separate purchase — which is precisely the failure the header
       * exists to prevent.
       */
      'Idempotency-Key': input.idempotencyKey,
    },
  })
}

export function simulateActivity(input: {
  userRef: string
  activityType: string
  occurredAt?: string
  eventId?: string
}): Promise<SimulateResponse> {
  return apiRequest<SimulateResponse>('/api/dev/simulate-activity', {
    method: 'POST',
    body: input,
  })
}

export function fetchDeliveries(): Promise<DeliveriesResponse> {
  return apiRequest<DeliveriesResponse>('/api/dev/deliveries')
}

export function fetchReconcile(): Promise<ReconcileResponse> {
  return apiRequest<ReconcileResponse>('/api/dev/reconcile')
}
