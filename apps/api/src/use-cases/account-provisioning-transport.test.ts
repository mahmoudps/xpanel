import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalProvisioningIdentity, type ProvisioningAuthority } from './account-provisioning-port.ts'
import { createAuthenticatedProvisioningPort } from './account-provisioning-transport.ts'

const authority: ProvisioningAuthority = {
  actor: { id: '11111111-1111-4111-8111-111111111111', kind: 'root', username: 'root' },
  account: { id: '22222222-2222-4222-8222-222222222222', username: 'tenant', ownerId: null, planId: '33333333-3333-4333-8333-333333333333',
    uid: 20000, gid: 20000, home: '/home/tenant', primaryDomain: 'tenant.example.test' },
  operation: { id: '44444444-4444-4444-8444-444444444444', workerId: 'worker-7', fencingToken: 4, leaseExpiresAt: '2099-01-01T00:00:00.000Z', requestFingerprint: 'a'.repeat(64) },
  desired: { revision: 8, checksum: 'b'.repeat(64), preparationReference: '55555555-5555-4555-8555-555555555555', preparationIdentity: 'c'.repeat(64) },
}
const request = { authority, binding: canonicalProvisioningIdentity(authority) }
const reply = { binding: request.binding, outcome: 'known', reconciliation: { status: 'failed', generation: { id: 3, checksum: 'e'.repeat(64), status: 'failed' },
  failedTest: 'nginx', error: 'nginx test failed', stateChanged: false } }

describe('account provisioning transport', { tags: ['unit'] }, () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('sets no total deadline on host work that the agent keeps alive', async () => {
    // Model the former 180 s budget as already spent: a total deadline would abort this slow reply.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError')))
    const port = createAuthenticatedProvisioningPort({ token: 'a'.repeat(64), fetch: async sent => {
      if (sent.signal.aborted) throw sent.signal.reason
      return new Response(`    ${JSON.stringify(reply)}`, { status: 200 })
    } })
    await expect(port.reconcile(request, { signal: new AbortController().signal, assertAuthority: async () => undefined })).resolves.toEqual(reply)
  })

  it('ends the request when the job lease is lost', async () => {
    const lease = new AbortController()
    const port = createAuthenticatedProvisioningPort({ token: 'a'.repeat(64), fetch: sent => new Promise((_resolve, reject) => {
      sent.signal.addEventListener('abort', () => reject(sent.signal.reason))
      lease.abort(new Error('lease lost'))
    }) })
    await expect(port.reconcile(request, { signal: lease.signal, assertAuthority: async () => undefined }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: true, verificationRequired: true } })
  })
})
