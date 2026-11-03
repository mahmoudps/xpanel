import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'vitest'
import { assertInstallOwnershipCompletionProof } from './install-finalization-native.mjs'
import { installAdoptionSubjectDigest, installFinalizationSubjectDigest } from './install-finalization.mjs'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown): string => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
function fixture(kind: 'install' | 'adopt') {
  const context = { source: { root: '/opt/xpanel', version: '0.1.0', archiveSha256: sha('archive'), manifestSha256: sha('manifest'),
    dependencyReceiptSha256: sha('dependencies'), controlDbSchemaVersion: 6 },
    runtime: { nodePath: '/usr/bin/node', nodeVersion: '26.12.1', nodeSha256: sha('node'), systemctlSha256: sha('systemctl'), nginxSha256: sha('nginx') },
    database: { file: '/var/lib/xpanel/control.db', device: '1', inode: '2', issuerId: id(1) }, rootPrincipalId: id(2),
    state: { revision: 3, checksum: sha('state'), accountCount: kind === 'adopt' ? 2 : 0,
      ...(kind === 'adopt' ? { accountLifetimeDigest: sha('same account lifetimes') } : {}) },
    admissionFingerprint: sha('admission'), ...(kind === 'adopt' ? { helperIdentity: { version: '0.1.1', archiveSha256: sha('helper'),
      manifestSha256: sha('helper manifest'), dependencyReceiptSha256: sha('helper dependencies'), sourceFilesDigest: sha('helper files') } } : {}),
  }
  const intent = { previousReceiptSha256: sha('old receipt'), expectedActiveSha256: sha('active receipt') }
  const subject = (kind === 'adopt' ? installAdoptionSubjectDigest : installFinalizationSubjectDigest)(context as never, intent.previousReceiptSha256)
  // Persisted-proof validator hashes evidence; native readiness validation remains separate.
  const observation = { subjectDigest: subject, observedAt: '2026-11-03T00:00:00.000Z' }
  const proof = { receiptSha256: intent.expectedActiveSha256, observationDigest: sha(canonical(observation)) }
  const job = { detail: { installFinalization: proof }, checkpointData: { installFinalization: { subjectDigest: subject, ...proof }, installFinalizationEvidence: { context, observation } } }
  return { context, intent, subject, job }
}

describe('persisted ownership completion proof uses the private entry kind', () => {
  for (const kind of ['install', 'adopt'] as const) {
    it('accepts the intact ' + kind + ' checkpoint without changing it', () => {
      const f = fixture(kind), before = canonical(f)
      assert.doesNotThrow(() => assertInstallOwnershipCompletionProof(kind, f.subject, f.intent, f.job))
      assert.equal(canonical(f), before)
    })
    it('rejects a ' + kind + ' proof replayed through the other entry kind', () => {
      const f = fixture(kind)
      assert.throws(() => assertInstallOwnershipCompletionProof(kind === 'install' ? 'adopt' : 'install', f.subject, f.intent, f.job))
    })
    it('binds ' + kind + ' completion to receipt, subject, checkpoint and evidence bytes', () => {
      const mutators = [
        (f: ReturnType<typeof fixture>) => { f.intent.expectedActiveSha256 = sha('other receipt') },
        (f: ReturnType<typeof fixture>) => { f.job.checkpointData.installFinalization.subjectDigest = sha('other subject') },
        (f: ReturnType<typeof fixture>) => { f.job.checkpointData.installFinalizationEvidence.context.state.revision++ },
        (f: ReturnType<typeof fixture>) => { f.job.checkpointData.installFinalizationEvidence.observation.observedAt = '2026-11-03T00:00:01.000Z' },
        (f: ReturnType<typeof fixture>) => { f.job.detail.installFinalization.observationDigest = sha('other observation') },
      ]
      for (const mutate of mutators) {
        const f = fixture(kind); mutate(f)
        assert.throws(() => assertInstallOwnershipCompletionProof(kind, f.subject, f.intent, f.job))
      }
    })
  }
  it('keeps fresh completion restricted to zero accounts and adoption to its helper and populated census', () => {
    const fresh = fixture('install'); fresh.context.state.accountCount = 2
    assert.throws(() => assertInstallOwnershipCompletionProof('install', fresh.subject, fresh.intent, fresh.job))
    const adopted = fixture('adopt'); adopted.context.state.accountCount = 0
    assert.throws(() => assertInstallOwnershipCompletionProof('adopt', adopted.subject, adopted.intent, adopted.job))
    const changed = fixture('adopt'); assert(changed.context.helperIdentity); changed.context.helperIdentity.archiveSha256 = sha('different helper')
    assert.throws(() => assertInstallOwnershipCompletionProof('adopt', changed.subject, changed.intent, changed.job))
  })
})
