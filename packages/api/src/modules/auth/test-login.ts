import type { FastifyInstance } from 'fastify'

import { SESSION_COOKIE } from './auth.service.js'

/**
 * Logs a test in through the real login route and returns the cookie header.
 *
 * Tests authenticate the way a browser does — POST credentials, receive a
 * session cookie, send it back — rather than injecting a user object or setting
 * a header a middleware trusts. A test that fabricates its own authentication
 * proves nothing about the code that grants it, and the login path is exactly
 * where a mistake matters most.
 */
export async function loginAs(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<{ cookie: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  })

  if (response.statusCode !== 200) {
    throw new Error(
      `loginAs(${email}) failed with ${response.statusCode}: ${response.body}`,
    )
  }

  const token = response.cookies.find((entry) => entry.name === SESSION_COOKIE)?.value

  if (!token) {
    throw new Error(`loginAs(${email}) succeeded but set no ${SESSION_COOKIE} cookie`)
  }

  return { cookie: `${SESSION_COOKIE}=${token}` }
}
