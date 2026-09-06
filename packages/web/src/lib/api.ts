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
    /**
     * The session lives in an httpOnly cookie, which JavaScript cannot read —
     * so the browser has to be told to attach it.
     *
     * `same-origin` rather than `include`: everything reaches the API through
     * the Vite proxy on a single origin, and `include` would attach credentials
     * to any cross-origin request a future change happened to introduce.
     */
    credentials: 'same-origin',
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

export type UserRole = 'USER' | 'ADMIN'

export type UserSummary = {
  id: string
  externalRef: string
  displayName: string
  role: UserRole
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

export function fetchHealth(): Promise<HealthReport> {
  return apiRequest<HealthReport>('/api/health/ready')
}

/**
 * A seeded demo account, as the sign-in screen lists it.
 *
 * No : the endpoint deliberately does not publish which account is
 * privileged, so this type must not claim it does.
 */
export type DemoAccount = {
  id: string
  externalRef: string
  displayName: string
  email: string | null
}

/**
 * The demo accounts, listed on the sign-in screen so a reviewer can get in
 * without hunting for credentials. Available without a session, which is the
 * point — it is what you read before you have one.
 */
export function fetchUsers(): Promise<DemoAccount[]> {
  return apiRequest<DemoAccount[]>('/api/demo/users')
}

export function login(email: string, password: string): Promise<UserSummary> {
  return apiRequest<UserSummary>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  })
}

export function registerAccount(input: {
  email: string
  password: string
  displayName: string
}): Promise<UserSummary> {
  return apiRequest<UserSummary>('/api/auth/register', { method: 'POST', body: input })
}

export function logout(): Promise<void> {
  return apiRequest<void>('/api/auth/logout', { method: 'POST' })
}

/** Who the session belongs to, for restoring state on load. */
export function fetchSession(): Promise<UserSummary> {
  return apiRequest<UserSummary>('/api/auth/me')
}

export function fetchMe(): Promise<Me> {
  return apiRequest<Me>('/api/me')
}

export function fetchRewards(): Promise<Reward[]> {
  return apiRequest<Reward[]>('/api/rewards')
}

export function fetchTransactions(cursor?: string): Promise<TransactionPage> {
  const query = new URLSearchParams({ limit: '15' })
  if (cursor) query.set('cursor', cursor)

  return apiRequest<TransactionPage>(`/api/me/transactions?${query.toString()}`)
}

export function redeemReward(input: {
  rewardId: string
  idempotencyKey: string
}): Promise<RedemptionOutcome> {
  return apiRequest<RedemptionOutcome>('/api/redemptions', {
    method: 'POST',
    body: { rewardId: input.rewardId },
    headers: {
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

export type AllocationOutcome = {
  userId: string
  displayName: string
  status: 'ALLOCATED' | 'FAILED'
  reason?: string
}

export type AllocationResult = {
  allocated: number
  failed: number
  outcomes: AllocationOutcome[]
}

export function createReward(input: {
  sku: string
  name: string
  description: string
  costPoints: number
  stock: number | null
}): Promise<Reward> {
  return apiRequest<Reward>('/api/dev/rewards', { method: 'POST', body: input })
}

export function allocateReward(input: {
  rewardId: string
  userIds: string[]
  /**
   * Minted once per allocation attempt by the caller, never here — the same
   * reason the redemption call does not mint its own. A key generated inside
   * this function would be new on every retry, so a double-click would allocate
   * twice.
   */
  allocationKey: string
}): Promise<AllocationResult> {
  return apiRequest<AllocationResult>('/api/dev/allocate', { method: 'POST', body: input })
}

export function fetchDeliveries(): Promise<DeliveriesResponse> {
  return apiRequest<DeliveriesResponse>('/api/dev/deliveries')
}

export function fetchReconcile(): Promise<ReconcileResponse> {
  return apiRequest<ReconcileResponse>('/api/dev/reconcile')
}
