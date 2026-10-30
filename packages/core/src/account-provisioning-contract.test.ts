import { describe, expect, it } from 'vitest'
import { assertProvisioningReply, canonicalProvisioningIdentity, parseProvisioningReconcileRequest, type ProvisioningReconcileRequest, type ProvisioningReconcileReply } from './account-provisioning-contract.ts'

const request = (): ProvisioningReconcileRequest => {
  const authority = {
    actor: { id: '10000000-0000-4000-8000-000000000001', kind: 'root' as const, username: 'root' },
    account: { id: '10000000-0000-4000-8000-000000000002', username: 'alice', ownerId: null, planId: '10000000-0000-4000-8000-000000000003', uid: 2001, gid: 2001, home: '/home/alice', primaryDomain: 'alice.example' },
    operation: { id: '10000000-0000-4000-8000-000000000004', workerId: 'worker', fencingToken: 1, leaseExpiresAt: '2026-10-30T00:01:00.000Z', requestFingerprint: 'a'.repeat(64) },
    desired: { revision: 4, checksum: 'b'.repeat(64), preparationReference: '10000000-0000-4000-8000-000000000005', preparationIdentity: 'c'.repeat(64) },
  }
  return { authority, binding: canonicalProvisioningIdentity(authority) }
}
const reply = (r: ProvisioningReconcileRequest) => ({
  binding: r.binding, outcome: 'known',
  reconciliation: { status: 'applied', generation: { id: 7, checksum: 'd'.repeat(64), status: 'active', createdAt: '2026-10-30T00:00:00.000Z', error: null, actor: 'root:root', testedAt: '2026-10-30T00:00:01.000Z', activatedAt: '2026-10-30T00:00:02.000Z' }, filesCount: 12, durationMs: 1.5 },
  execution: { accountId: r.authority.account.id, uid: 2001, gid: 2001, home: '/home/alice', revision: 4, generationId: 7, generationChecksum: 'd'.repeat(64), sourceChecksum: 'b'.repeat(64), cgroup: '/xpanel-2001.slice', services: ['nginx.service', 'php-fpm.service'], quota: { enforced: true, filesystem: 'ext4' }, dns: { zone: 'alice.example', serial: 2026103001, authoritative: true }, php: { status: 200, uid: 2001, cgroup: '/xpanel-2001.slice' } },
})
const assert = (r: ProvisioningReconcileRequest, value: unknown) => assertProvisioningReply(r, value as ProvisioningReconcileReply)

describe('authenticated provisioning reply runtime schema', { tags: ['unit'] }, () => {
  it.each([
    { label: 'array', kind: ['root'] },
    { label: 'object', kind: { toString: () => 'root' } },
  ])('rejects a $label principal kind even with its matching canonical binding', ({ kind }) => {
    const r = request()
    const authority = { ...r.authority, actor: { ...r.authority.actor, kind } }
    expect(() => parseProvisioningReconcileRequest({ authority, binding: canonicalProvisioningIdentity(authority) }))
      .toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })
  it('accepts actual applied and noop result shapes only with complete matching observations', () => {
    const r = request(), value = reply(r)
    expect(assert(r, value)).toEqual(value.execution)
    expect(assert(r, { ...value, reconciliation: { status: 'noop', generation: value.reconciliation.generation, stateChecksum: r.authority.desired.checksum } })).toEqual(value.execution)
  })
  it('retains a well-shaped known failure without treating it as execution evidence', () => {
    const r = request(), value = reply(r)
    expect(assert(r, { binding: r.binding, outcome: 'known', reconciliation: { status: 'failed', generation: { ...value.reconciliation.generation, status: 'failed' }, failedTest: 'nginx -t', error: 'invalid config\nline 2', stateChanged: true, verificationRequired: true } })).toBeUndefined()
  })
  it.each([
    ['unknown status', (v: ReturnType<typeof reply>) => ({ ...v, reconciliation: { ...v.reconciliation, status: 'something' } })],
    ['missing generation identities on both objects', (v: ReturnType<typeof reply>) => ({ ...v, reconciliation: { ...v.reconciliation, generation: { status: 'active' } }, execution: { ...v.execution, generationId: undefined, generationChecksum: undefined } })],
    ['zero generation', (v: ReturnType<typeof reply>) => ({ ...v, reconciliation: { ...v.reconciliation, generation: { ...v.reconciliation.generation, id: 0 } }, execution: { ...v.execution, generationId: 0 } })],
    ['malformed matching checksum', (v: ReturnType<typeof reply>) => ({ ...v, reconciliation: { ...v.reconciliation, generation: { ...v.reconciliation.generation, checksum: 'same' } }, execution: { ...v.execution, generationChecksum: 'same' } })],
    ['inactive generation', (v: ReturnType<typeof reply>) => ({ ...v, reconciliation: { ...v.reconciliation, generation: { ...v.reconciliation.generation, status: 'superseded' } } })],
    ['truthy service object', (v: ReturnType<typeof reply>) => ({ ...v, execution: { ...v.execution, services: { length: 1 } } })],
    ['nonstrings in actual service array', (v: ReturnType<typeof reply>) => ({ ...v, execution: { ...v.execution, services: [{}] } })],
    ['truthy cgroup object', (v: ReturnType<typeof reply>) => ({ ...v, execution: { ...v.execution, cgroup: {}, php: { ...v.execution.php, cgroup: {} } } })],
    ['truthy quota filesystem', (v: ReturnType<typeof reply>) => ({ ...v, execution: { ...v.execution, quota: { enforced: true, filesystem: {} } } })],
    ['string DNS serial', (v: ReturnType<typeof reply>) => ({ ...v, execution: { ...v.execution, dns: { ...v.execution.dns, serial: '2026103001' } } })],
    ['unknown nested observation', (v: ReturnType<typeof reply>) => ({ ...v, execution: { ...v.execution, php: { ...v.execution.php, fake: true } } })],
    ['unknown outcome', (v: ReturnType<typeof reply>) => ({ ...v, outcome: 'unknown' })],
    ['unknown body field', (v: ReturnType<typeof reply>) => ({ ...v, executor: 'fake' })],
    ['invalid applied metrics', (v: ReturnType<typeof reply>) => ({ ...v, reconciliation: { ...v.reconciliation, filesCount: -1 } })],
  ] as const)('rejects %s', (_label, mutate) => {
    const r = request()
    expect(() => assert(r, mutate(reply(r)))).toThrow(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
  })
  it('rejects incomplete expected identity instead of matching undefined to undefined', () => {
    const r = request(), value = reply(r)
    const malformed = { ...r, authority: { ...r.authority, account: { ...r.authority.account, uid: undefined } } }
    expect(() => assert(malformed as unknown as ProvisioningReconcileRequest, { ...value, execution: { ...value.execution, uid: undefined } })).toThrow(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
  })
})
