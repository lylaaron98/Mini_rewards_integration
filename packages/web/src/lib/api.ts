/**
 * The single place the frontend talks to the API.
 *
 * `fetch` resolves successfully on a 4xx or 5xx, which means the naive version
 * of this function hands a parsed error body to a component as if it were data.
 * Everything downstream — TanStack Query's `isError`, error boundaries, the
 * "redeem failed" message — depends on a failed request actually rejecting, so
 * that translation happens here, once, rather than in every caller.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST'
  body?: unknown
  /** Extra headers — this is how the redemption call will pass Idempotency-Key. */
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
        ? (payload as { error?: string; message?: string })
        : {}

    throw new ApiError(
      response.status,
      details.error ?? 'unknown_error',
      details.message ?? `Request failed with status ${response.status}`,
    )
  }

  return payload as T
}

export type HealthReport = {
  status: 'ok' | 'degraded'
  database: 'up' | 'down'
  error?: string
}

export function fetchHealth(): Promise<HealthReport> {
  return apiRequest<HealthReport>('/api/health/ready')
}
