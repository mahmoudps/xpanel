import assert from 'node:assert/strict'
import { computeTotpCode } from './auth.ts'

export const TEST_AGENT_TOKEN = 'a'.repeat(64)
export const TEST_SERVER_SECRET = 'integration-test-server-secret-at-least-32-bytes'

interface EnrollmentClient {
  request(path: string, options: { method: string; body: unknown }): Promise<Response>
}

/** Enroll through the real HTTP contract; fixtures must not bypass mandatory root MFA. */
export const enrollRootSession = async (client: EnrollmentClient, password: string): Promise<string[]> => {
  const setup = await client.request('/api/auth/2fa/setup', { method: 'POST', body: { password } })
  assert.equal(setup.status, 200)
  const enrollment = await setup.json() as { secret: string; recoveryCodes: string[] }
  assert.equal(enrollment.recoveryCodes.length, 8)
  const enable = await client.request('/api/auth/2fa/enable', {
    method: 'POST', body: { code: computeTotpCode(enrollment.secret) },
  })
  assert.equal(enable.status, 200)
  assert.deepEqual(await enable.json(), { ok: true, totpEnabled: true })
  return enrollment.recoveryCodes
}
