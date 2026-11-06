import { describe, expect, it } from 'vitest'
import { assertProvisioningReply, canonicalProvisioningIdentity, createProvisioningCheckpointObservation, parseProvisioningCheckpointObservation, parseProvisioningReconcileRequest, type ProvisioningCheckpointObservation, type ProvisioningReconcileRequest, type ProvisioningReconcileReply } from './account-provisioning-contract.ts'
import { redactSecrets } from './rules/audit.ts'

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

describe('nonsecret durable provisioning receipt codec', { tags: ['unit'] }, () => {
  it('round-trips the full receipt through repeated journal redaction without credentials or missing DNS/PHP/quota facts', () => {
    const r = request(), execution = assert(r, reply(r))!
    const observedContext = createProvisioningCheckpointObservation(r, execution)
    // The previous field name caused real saveJobCheckpoint writes to discard the entire authority.
    expect(redactSecrets({ observedAuthority: r.authority }).observedAuthority).toBe('[REDACTED]')
    const persisted = redactSecrets(redactSecrets({ observedContext }))
    expect(persisted.observedContext).toEqual(observedContext)
    expect(parseProvisioningCheckpointObservation(persisted.observedContext)).toEqual({ request: r, execution })
    expect(JSON.stringify(persisted)).not.toContain('[REDACTED]')
    expect(observedContext.context.operation).not.toHaveProperty('fencingToken')
    expect(observedContext.execution.dns.authoritative).toBe(true)
    expect(observedContext.execution.php).toEqual(execution.php)
    expect(observedContext.execution.quota).toEqual(execution.quota)
  })

  it.each([
    ['missing context', () => undefined],
    ['redacted legacy context', () => '[REDACTED]'],
    ['raw legacy authority', () => request().authority],
    ['unsupported version', (v: ProvisioningCheckpointObservation) => ({ ...v, version: 2 })],
    ['unknown credential field', (v: ProvisioningCheckpointObservation) => ({ ...v, authorizationRef: { tokenHash: 'fixture-only' } })],
    ['changed receipt digest', (v: ProvisioningCheckpointObservation) => ({ ...v, identity: '0'.repeat(64) })],
    ['changed original request binding', (v: ProvisioningCheckpointObservation) => ({ ...v, binding: '0'.repeat(64) })],
    ['changed original fence', (v: ProvisioningCheckpointObservation) => ({ ...v, context: { ...v.context, operation: { ...v.context.operation, fence: 2 } } })],
    ['changed account observation', (v: ProvisioningCheckpointObservation) => ({ ...v, execution: { ...v.execution, uid: v.execution.uid + 1 } })],
  ] as const)('rejects %s without reconstructing missing authority', (_label, mutate) => {
    const r = request(), v = createProvisioningCheckpointObservation(r, assert(r, reply(r))!)
    expect(() => parseProvisioningCheckpointObservation(mutate(v))).toThrow()
  })

  it('rejects invalid observation facts even when a new envelope digest matches those altered facts', () => {
    const r = request(), v = createProvisioningCheckpointObservation(r, assert(r, reply(r))!)
    const { identity: _identity, ...data } = { ...v, execution: { ...v.execution, dns: { ...v.execution.dns, authoritative: false } } }
    expect(() => parseProvisioningCheckpointObservation({ ...data, identity: canonicalProvisioningIdentity(data) }))
      .toThrow(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
  })
})

describe('authenticated provisioning reply runtime schema', { tags: ['unit'] }, () => {
  it.each([
    { label: 'array', kind: ['root'] },
    { label: 'object', kind: { toString: (): string => 'root' } },
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
  it('accepts the observed kernel host name on every result and refuses a malformed one', () => {
    const r = request(), value = reply(r)
    for (const kernelHostname of ['host.example.test', null]) {
      expect(assert(r, { ...value, reconciliation: { ...value.reconciliation, kernelHostname } })).toEqual(value.execution)
      expect(assert(r, { ...value, reconciliation: { status: 'noop', generation: value.reconciliation.generation, stateChecksum: r.authority.desired.checksum, kernelHostname } })).toEqual(value.execution)
    }
    for (const kernelHostname of ['', ' ', 'x'.repeat(254), 7, {}]) {
      expect(() => assert(r, { ...value, reconciliation: { ...value.reconciliation, kernelHostname } })).toThrow()
    }
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
