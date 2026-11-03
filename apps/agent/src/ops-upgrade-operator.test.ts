import { generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signRootOperatorResponse } from './ops-upgrade-operator-protocol.ts'
const seams = vi.hoisted(() => ({ kind: 'recover' as 'upgrade'|'recover', phases: [] as string[], failApply: false }))
const key = generateKeyPairSync('ed25519')
const operationId = '12345678-1234-4234-8234-123456789abc', archiveSha = 'e'.repeat(64)
const identity = { pid: 1234, start: '55', bootId: '11111111-1111-4111-8111-111111111111', receiptSha256: 'a'.repeat(64) }
vi.mock('../../../scripts/coordinator-ownership.mjs', () => ({ withVerifiedCoordinatorOwnership: (work: (scope: unknown) => unknown) => work({}), assertCoordinatorOwnershipCurrent: async () => {} }))
vi.mock('../../../scripts/lifecycle-ownership.mjs', () => ({ requireLinuxRoot: () => {}, withTrustedFile: vi.fn() }))
vi.mock('../../../scripts/lifecycle-root-safety.mjs', () => ({ withNativeClosedDatabaseRecoveryAdmission: vi.fn() }))
vi.mock('./lifecycle/native-runtime.ts', () => ({ runNativeRootOperatorCommand: vi.fn() }))
vi.mock('./peer-identity.ts', () => ({ loadInstalledPeerIdentityAddon: async () => ({}) }))
vi.mock('./ops-upgrade-hosted-qualification.ts', () => ({ createNativeClosedRecoveryHostedUidQualification: vi.fn(), withNativeRootOperatorHostedUidQualification: vi.fn() }))
vi.mock('./ops-upgrade-native-observation.ts', () => ({
  observeLauncher: async () => ({ identity, publicKey: key.publicKey,
    receipt: { helper: { archiveSha256: archiveSha, releaseRoot: '/opt/xpanel/releases/0.2.0' }, nodePath: '/usr/local/bin/node' } }),
  kernelPeer: () => ({ pid: identity.pid, uid: 0, gid: 0 }), socketIdentity: async () => 'fixed-socket-fixture',
  processFacts: async (pid: number) => ({ pid, start: '66', bootId: identity.bootId, exe: '/usr/local/bin/node', argv: [
    '/usr/local/bin/node', '/opt/xpanel/releases/0.2.0/scripts/root-operator-entry.mjs', '--kind=' + seams.kind,
    '--archive-sha256=' + archiveSha, '--operation-id=' + operationId,
  ] }),
}))
vi.mock('node:net', () => ({ createServer: vi.fn(), createConnection: () => {
  const socket = Object.assign(new EventEmitter(), { destroyed: false,
    destroy() { this.destroyed = true; this.emit('close'); return this },
    write(frame: Buffer) {
      const request = JSON.parse(frame.toString('utf8')); seams.phases.push(request.phase)
      queueMicrotask(() => {
        if (seams.failApply && request.phase === 'apply') { this.emit('error', new Error('lost reply')); return }
        const result = signRootOperatorResponse({ phase: request.phase === 'observe' ? 'ready' : 'finished', request,
          identity: { workerId: 'root-operator-22222222-2222-4222-8222-222222222222', ...identity },
          qualification: { digest: 'b'.repeat(64), observedAt: new Date().toISOString() },
          resultDigest: request.phase === 'apply' ? 'c'.repeat(64) : null,
          outcome: request.phase === 'apply' ? { phase: 'succeeded', exitCode: 0 } : null,
        }, key.privateKey)
        this.emit('data', Buffer.from(JSON.stringify(result) + '\n'))
      })
      return true
    },
  })
  queueMicrotask(() => socket.emit('connect')); return socket
} }))
import { dispatchPreparedRootOperation } from './ops-upgrade-operator.ts'

beforeEach(() => { seams.kind = 'recover'; seams.phases = []; seams.failApply = false })
// Signed protocol/client-order tests with explicit process/socket seams; no native transport acceptance.
describe('prepared root operator client dispatch', () => {
  it('sends recover apply directly without fabricating or requiring observe readiness', async () => {
    const result = await dispatchPreparedRootOperation({ operationId, kind: 'recover', expectedArchiveSha256: archiveSha })
    expect(seams.phases).toEqual(['apply']); expect(result.phase).toBe('succeeded')
  })
  it('preserves upgrade observe before apply', async () => {
    seams.kind = 'upgrade'
    await dispatchPreparedRootOperation({ operationId, kind: 'upgrade', expectedArchiveSha256: archiveSha })
    expect(seams.phases).toEqual(['observe', 'apply'])
  })
  it('never retries a lost recover apply response', async () => {
    seams.failApply = true
    await expect(dispatchPreparedRootOperation({ operationId, kind: 'recover', expectedArchiveSha256: archiveSha }))
      .rejects.toMatchObject({ unknownOutcome: true, retryAllowed: false, operationId })
    expect(seams.phases).toEqual(['apply'])
  })
})
