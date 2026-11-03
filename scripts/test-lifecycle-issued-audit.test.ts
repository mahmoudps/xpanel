import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseIssuedLifecycleAuditJournal } from './lifecycle-issued-audit.mjs'
import { assertLifecycleAuditIssuanceHeld, assertLifecycleIssuedAuditRepairHeld, assertLifecycleIssuedAuditCompletionHeld } from './lifecycle-root-safety.mjs'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const id = '11111111-1111-4111-8111-111111111111', previous = '22222222-2222-4222-8222-222222222222'
const image = (value: unknown) => { const bytes = JSON.stringify(value) + '\n'; return { value, bytes, sha256: hash(bytes) } }
const fixture = () => {
  const origin = { file: '/var/lib/xpanel/control.db', device: '1', inode: '2', issuerId: previous }
  const intentBinding = { purpose: 'host.lifecycle.intent', jobId: id, requestFingerprint: 'a'.repeat(64), action: 'lifecycle.upgrade', principalId: previous }
  return {
    schemaVersion: 1, kind: 'xpanel-issued-lifecycle-audit', job: { id, reference: 'XP-JOB-2026-000001' }, origin, intentBinding,
    // The journal grammar is not the independent audit plan verifier. These diagnostic fields cannot mint authority.
    plan: { schemaVersion: 1, purpose: 'issued-lifecycle-append', binding: intentBinding, origin },
    parentHead: image({ sequence: 3, phase: 'retired', operationId: previous }), parentBarrier: null,
    fence: image({ schemaVersion: 1, operationId: id, reference: 'XP-JOB-2026-000001', kind: 'upgrade', phase: 'attention',
      requestFingerprint: intentBinding.requestFingerprint, sequence: 4, createdAt: '2026-11-03T00:00:00.000Z' }),
    baseline: { operationId: id, path: '/var/lib/xpanel-lifecycle/admission-' + id + '.json', sha256: 'b'.repeat(64) },
    helper: { releaseRoot: '/opt/xpanel/releases/0.2.0', archiveSha256: 'c'.repeat(64) }, coordinatorReceiptSha256: 'd'.repeat(64),
    issuer: { pid: 123, start: '456', bootId: previous, coordinatorUnit: 'xpanel-lifecycle.service' }, accountLifetimeSha256: 'e'.repeat(64),
    sourceImages: [{ path: '/var/lib/xpanel-lifecycle/installation.json' }], issuedAt: '2026-11-03T00:00:00.000Z',
  }
}

describe('root issued audit journal selectors', () => {
  it('binds the pre-HEAD denial and exact baseline to the issued event without inventing a pending HEAD', () => {
    const value = fixture()
    expect(parseIssuedLifecycleAuditJournal(value, id)).toBe(value)
    expect(value.parentHead.value.phase).toBe('retired')
    expect(value.parentHead.value.operationId).toBe(previous)
    expect(value.fence.value.operationId).toBe(id)
  })
  it.each(['head-bytes', 'fence-sequence', 'fence-operation', 'baseline', 'foreign-plan', 'foreign-field'])('rejects %s', change => {
    const value = fixture()
    if (change === 'head-bytes') value.parentHead.bytes += ' '
    if (change === 'fence-sequence') value.fence = image({ ...value.fence.value, sequence: 3 })
    if (change === 'fence-operation') value.fence = image({ ...value.fence.value, operationId: previous })
    if (change === 'baseline') value.baseline.operationId = previous
    if (change === 'foreign-plan') value.plan = { ...value.plan, binding: { ...value.intentBinding, principalId: id } }
    if (change === 'foreign-field') Object.assign(value, { authorized: true })
    expect(() => parseIssuedLifecycleAuditJournal(value, id)).toThrow()
  })
  it('refuses parsed journals, plans and supplied assertions as issuance, repair or completion capabilities', async () => {
    let invoked = false
    const fake = { ...fixture(), assertCurrent() { invoked = true }, purpose: 'issued-lifecycle-audit-repair' }
    await expect(assertLifecycleAuditIssuanceHeld(fake, fake.plan)).rejects.toThrow('LIFECYCLE_AUDIT_ISSUANCE_REQUIRED')
    await expect(assertLifecycleIssuedAuditRepairHeld(fake)).rejects.toThrow('LIFECYCLE_ISSUED_AUDIT_REPAIR_REQUIRED')
    await expect(assertLifecycleIssuedAuditCompletionHeld(fake)).rejects.toThrow('LIFECYCLE_BOOTSTRAP_SCOPE_REQUIRED')
    expect(invoked).toBe(false)
  })
})
