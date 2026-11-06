import assert from 'node:assert/strict'
import { beforeEach, describe, it, vi } from 'vitest'
import { finalizationReason, parseNativeInstallFinalizationRequest, installFinalizationMetadataTarget, assertInstallFinalizationNativeScope, installFinalizationNativeInfo, runNativeInstallFinalization, withInstallFinalizationStateDirectories } from './install-finalization-native.mjs'
import { withInstallFinalizationExclusiveAdmission, verifyInstallFinalizationParticipants } from './lifecycle-admission.mjs'


const directoryModel = vi.hoisted(() => ({
  rows: new Map<string, { dev: bigint; ino: bigint; uid: bigint; gid: bigint; mode: bigint; link: boolean }>(),
  opened: [] as string[], closed: [] as string[], parentCurrent: true,
}))
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  const stat = (row: { dev: bigint; ino: bigint; uid: bigint; gid: bigint; mode: bigint; link: boolean }) =>
    ({ ...row, isDirectory: () => !row.link, isSymbolicLink: () => row.link })
  const row = (path: string) => { const value = directoryModel.rows.get(path); if (!value) throw new Error('unexpected filesystem target'); return value }
  return { ...original,
    lstat: async (path: string) => stat(row(path)),
    realpath: async (path: string) => row(path).link ? '/foreign/state' : path,
    open: async (path: string) => {
      const captured = { ...row(path) }; directoryModel.opened.push(path)
      return { stat: async () => stat(captured), close: async () => { directoryModel.closed.push(path) } }
    },
  }
})
vi.mock('./lifecycle-ownership.mjs', async importOriginal => {
  const original = await importOriginal<typeof import('./lifecycle-ownership.mjs')>()
  return { ...original, withTrustedDirectory: async (path: string, run: (value: { verify(): Promise<void> }) => Promise<unknown>) => {
    if (path !== '/var/lib') throw new Error('unexpected trusted ancestor')
    const verify = async () => { if (!directoryModel.parentCurrent) throw new Error('trusted ancestor changed') }
    await verify()
    return run({ verify })
  } }
})
beforeEach(() => {
  directoryModel.rows = new Map([
    ['/var/lib/xpanel', { dev: 1n, ino: 10n, uid: 1000n, gid: 1000n, mode: 0o2770n, link: false }],
    ['/var/lib/xpanel/state', { dev: 1n, ino: 11n, uid: 1000n, gid: 1000n, mode: 0o2750n, link: false }],
  ])
  directoryModel.opened = []; directoryModel.closed = []; directoryModel.parentCurrent = true
})

const request = { schemaVersion: 1, command: 'install', mode: 'apply', json: true, assumeYes: true,
  artifact: { path: '/root/releases/xpanel-0.1.0.tar.gz', expectedArchiveSha256: 'a'.repeat(64), keyId: 'release-key', signingKeyPath: '/etc/xpanel/release-hmac.key' } }
const jobId = '12345678-1234-4234-8234-123456789abc'

describe('native install finalization boundaries; no platform spoof or native effects', () => {
  it('reports the innermost stable code behind the archive lifetime wrapper', () => {
    const inner = Object.assign(new Error('x'), { code: 'INSTALL_FINALIZATION_STATE_CHANGED' })
    const wrapped = Object.assign(new Error('y', { cause: Object.assign(new Error('z', { cause: inner }), { code: 'PRECONDITION_FAILED' }) }), { code: 'ARCHIVE_USE_UNCERTAIN' })
    assert.equal(finalizationReason(wrapped, 'ARCHIVE_USE_UNCERTAIN'), 'INSTALL_FINALIZATION_STATE_CHANGED')
    assert.equal(finalizationReason(Object.assign(new Error('w', { cause: new Error('raw message') }), { code: 'ARCHIVE_USE_UNCERTAIN' }), 'ARCHIVE_USE_UNCERTAIN'), 'ARCHIVE_USE_UNCERTAIN')
    assert.equal(finalizationReason({ code: 'lower_case' }, 'INSTALL_FINALIZATION_NATIVE_UNVERIFIED'), 'INSTALL_FINALIZATION_NATIVE_UNVERIFIED')
  })
  it('accepts only the finite install/apply grammar without a caller-selected provider', () => {
    const parsed = parseNativeInstallFinalizationRequest(request)
    assert(Object.isFrozen(parsed)); assert.deepEqual(parsed, request)
    for (const input of [{ ...request, command: 'adopt' }, { ...request, mode: 'plan' }, { ...request, assumeYes: false }, { ...request, provider: {} }, { ...request, dependencyReceipt: {} }]) {
      assert.throws(() => parseNativeInstallFinalizationRequest(input))
    }
  })
  it('rejects unsafe source locations and malformed artifact identities', () => {
    for (const path of ['/tmp/source.tar.gz', '/home/root/source.tar.gz', '/root/../root/source.tar.gz', 'relative.tar.gz', '/root/source\n.tar.gz']) {
      assert.throws(() => parseNativeInstallFinalizationRequest({ ...request, artifact: { ...request.artifact, path } }))
    }
    assert.throws(() => parseNativeInstallFinalizationRequest({ ...request, artifact: { ...request.artifact, expectedArchiveSha256: 'invalid' } }))
  })
  it('admits only fixed metadata and operation-bound temporary names', () => {
    assert.equal(installFinalizationMetadataTarget('/var/lib/xpanel-lifecycle/HEAD', null)?.temporary, false)
    assert.equal(installFinalizationMetadataTarget('/var/lib/xpanel-lifecycle/HEAD.install-' + jobId + '-' + 'a'.repeat(64) + '.tmp', jobId)?.temporary, true)
    for (const path of ['/etc/passwd', '/var/lib/xpanel-lifecycle/../HEAD', '/var/lib/xpanel-lifecycle/other', '/var/lib/xpanel-lifecycle/HEAD.install-' + jobId + '-bad.tmp']) {
      assert.equal(installFinalizationMetadataTarget(path, jobId), null)
    }
    assert.equal(installFinalizationMetadataTarget('/var/lib/xpanel-lifecycle/HEAD.install-' + jobId + '-' + 'a'.repeat(64) + '.tmp', '00000000-0000-4000-8000-000000000000'), null)
  })
  it('rejects forged or copied structural capabilities before native access', async () => {
    for (const capability of [null, true, {}, { root: true, phase: 'held' }, Object.freeze({})]) {
      await assert.rejects(assertInstallFinalizationNativeScope(capability, 'held'), /INSTALL_FINALIZATION_NATIVE_SCOPE_REQUIRED/)
      assert.throws(() => installFinalizationNativeInfo(capability), /INSTALL_FINALIZATION_NATIVE_SCOPE_REQUIRED/)
    }
  })
  it('does not invoke an EX callback or participant probe for a fake capability', async () => {
    let calls = 0
    await assert.rejects(withInstallFinalizationExclusiveAdmission({}, async () => { calls++ }), /INSTALL_FINALIZATION_NATIVE_SCOPE_REQUIRED/)
    await assert.rejects(verifyInstallFinalizationParticipants({}), /INSTALL_FINALIZATION_EXCLUSIVE_REQUIRED/)
    assert.equal(calls, 0)
  })
  it.runIf(process.platform !== 'linux')('uses the actual platform and refuses before the native factory opens resources', async () => {
    const result = await runNativeInstallFinalization(request)
    assert.equal(result.exitCode, 3); assert.equal(result.code, 'LINUX_ROOT_REQUIRED'); assert.equal(result.outcome, 'blocked')
    assert.equal(result.details.changed, false)
  })
})

describe('fixed service directory pins with isolated filesystem ports', () => {
  it('retains the exact two service directories and retires both descriptors', async () => {
    const result = await withInstallFinalizationStateDirectories(1000, 1000, async pins => { await pins.verify(); return 'observed' })
    assert.equal(result, 'observed')
    assert.deepEqual(directoryModel.opened, ['/var/lib/xpanel', '/var/lib/xpanel/state'])
    assert.deepEqual(directoryModel.closed, ['/var/lib/xpanel/state', '/var/lib/xpanel'])
  })
  it('rejects a state symlink before the snapshot callback and closes the parent descriptor', async () => {
    const row = directoryModel.rows.get('/var/lib/xpanel/state'); assert(row); row.link = true
    let calls = 0
    await assert.rejects(withInstallFinalizationStateDirectories(1000, 1000, async () => { calls++ }), /INSTALL_STATE_DIRECTORY_UNSAFE/)
    assert.equal(calls, 0); assert.deepEqual(directoryModel.closed, directoryModel.opened)
  })
  it('rejects same-mode directory replacement before any source-dependent effect', async () => {
    let effects = 0
    await assert.rejects(withInstallFinalizationStateDirectories(1000, 1000, async pins => {
      const row = directoryModel.rows.get('/var/lib/xpanel/state'); assert(row); row.ino = 99n
      await pins.verify(); effects++
    }), /INSTALL_STATE_DIRECTORY_CHANGED/)
    assert.equal(effects, 0); assert.equal(directoryModel.closed.length, 2)
  })
  it('rejects changed service UID, GID or mode before capture', async () => {
    for (const field of ['uid', 'gid', 'mode'] as const) {
      const row = directoryModel.rows.get('/var/lib/xpanel'); assert(row)
      const original = row[field]; row[field] = field === 'mode' ? 0o2777n : 2000n
      await assert.rejects(withInstallFinalizationStateDirectories(1000, 1000, async () => { throw new Error('capture must not run') }), /INSTALL_STATE_DIRECTORY_UNSAFE/)
      row[field] = original
    }
    assert.equal(directoryModel.opened.length, 0)
  })
  it('refuses a changed protected ancestor while the descriptors are retained', async () => {
    await assert.rejects(withInstallFinalizationStateDirectories(1000, 1000, async pins => {
      directoryModel.parentCurrent = false; await pins.verify()
    }), /trusted ancestor changed/)
    assert.equal(directoryModel.closed.length, 2)
  })
  it('retires all opened descriptors when capture fails', async () => {
    await assert.rejects(withInstallFinalizationStateDirectories(1000, 1000, async () => { throw new Error('capture denied') }), /capture denied/)
    assert.equal(directoryModel.closed.length, 2)
  })
})
