import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Isolated dispatch seams only: these tests cannot create native authority or host effects.
const seams = vi.hoisted(() => ({
  root: vi.fn(), barrier: vi.fn(), status: vi.fn(), finalize: vi.fn(), legacy: vi.fn(),
}))
vi.mock('./lifecycle-admission.mjs', () => ({ readLifecyclePublicStatus: seams.status, readLifecycleBarrier: seams.barrier }))
vi.mock('./lifecycle-ownership.mjs', () => ({ requireLinuxRoot: seams.root, readInstallationReceipt: vi.fn(), readTrustedFile: vi.fn() }))
vi.mock('./release-verifier.mjs', () => ({ verifyAuthenticatedReleaseArchive: vi.fn(), verifyAuthenticatedReleaseTree: vi.fn() }))
vi.mock('./lifecycle-services.mjs', () => ({ observeOwnedControlPlaneUnits: vi.fn() }))
vi.mock('./install-bootstrap.mjs', () => ({ finalizePreparedInstallation: seams.finalize }))
vi.mock('./lifecycle-root-safety.mjs', () => ({ executeNativeLifecycleCommand: seams.legacy }))

import { runLifecycleRuntime } from './lifecycle-runtime.mjs'

const request = { schemaVersion: 1, command: 'install', mode: 'apply', json: true, assumeYes: true,
  artifact: { path: '/opt/xpanel/downloads/release.tar.gz', expectedArchiveSha256: 'a'.repeat(64), signingKeyPath: '/etc/xpanel/release-hmac.key', keyId: 'release-2026' } }
const completed = { exitCode: 0, code: 'INSTALL_OWNERSHIP_ACTIVE', outcome: 'committed',
  details: { installationActive: true, installReady: false, nativeQualified: false, officialReference: 'XP-JOB-2026-000001' } }
const refused = { exitCode: 3, code: 'LEGACY_NATIVE_REFUSED', outcome: 'blocked', details: {} }

beforeEach(() => {
  vi.clearAllMocks()
  seams.root.mockImplementation(() => undefined)
  seams.barrier.mockResolvedValue(null)
  seams.finalize.mockResolvedValue(completed)
  seams.legacy.mockResolvedValue(refused)
  vi.stubEnv('NODE_OPTIONS', '')
  vi.stubEnv('NODE_PATH', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('fixed prepared-install dispatch; isolated source contract only', () => {
  it('keeps an install plan free of privileged reads and native dispatch', async () => {
    expect(await runLifecycleRuntime({ ...request, mode: 'plan', assumeYes: false })).toMatchObject({ exitCode: 0, outcome: 'planned', details: { ready: false } })
    expect(seams.root).not.toHaveBeenCalled()
    expect(seams.barrier).not.toHaveBeenCalled()
    expect(seams.finalize).not.toHaveBeenCalled()
    expect(seams.legacy).not.toHaveBeenCalled()
  })

  it('passes the validated frozen install request only to the fixed bootstrap entry', async () => {
    expect(await runLifecycleRuntime(request)).toEqual(completed)
    expect(seams.root).toHaveBeenCalledOnce()
    expect(seams.barrier).toHaveBeenCalledOnce()
    expect(seams.finalize).toHaveBeenCalledOnce()
    const forwarded = seams.finalize.mock.calls[0]![0]
    expect(forwarded).toEqual(request)
    expect(Object.isFrozen(forwarded)).toBe(true)
    expect(seams.legacy).not.toHaveBeenCalled()
  })

  it.each(['update', 'upgrade', 'adopt', 'recover'])('preserves %s on the existing native bridge', async command => {
    const input = { ...request, command }
    expect(await runLifecycleRuntime(input)).toEqual(refused)
    expect(seams.legacy).toHaveBeenCalledOnce()
    expect(seams.legacy.mock.calls[0]![0]).toEqual(input)
    expect(seams.finalize).not.toHaveBeenCalled()
  })

  it('retains a pending lifecycle barrier before any fresh install finalization', async () => {
    seams.barrier.mockResolvedValue({ phase: 'pending' })
    expect(await runLifecycleRuntime(request)).toMatchObject({ exitCode: 6, code: 'LIFECYCLE_RETAINED_ATTENTION', outcome: 'attention' })
    expect(seams.finalize).not.toHaveBeenCalled()
    expect(seams.legacy).not.toHaveBeenCalled()
  })

  it.each(['NODE_OPTIONS', 'NODE_PATH'])('refuses untrusted %s before barrier or finalizer work', async key => {
    vi.stubEnv(key, 'untrusted')
    expect(await runLifecycleRuntime(request)).toMatchObject({ exitCode: 3, code: 'LIFECYCLE_PINNED_RUNTIME_REQUIRED' })
    expect(seams.barrier).not.toHaveBeenCalled()
    expect(seams.finalize).not.toHaveBeenCalled()
  })

  it('preserves the Linux-root refusal before the new dispatch', async () => {
    seams.root.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'ROOT_LINUX_REQUIRED' }) })
    expect(await runLifecycleRuntime(request)).toMatchObject({ exitCode: 3, code: 'ROOT_LINUX_REQUIRED' })
    expect(seams.barrier).not.toHaveBeenCalled()
    expect(seams.finalize).not.toHaveBeenCalled()
  })

  it('rejects caller-selected runtime fields before privileged admission', async () => {
    expect(await runLifecycleRuntime({ ...request, runtime: '/tmp/foreign.mjs' })).toMatchObject({ exitCode: 3, code: 'LIFECYCLE_REQUEST_INVALID' })
    expect(seams.root).not.toHaveBeenCalled()
    expect(seams.finalize).not.toHaveBeenCalled()
  })

  it('does not turn a finalizer uncertainty into an install success', async () => {
    seams.finalize.mockRejectedValue(Object.assign(new Error('private path'), { code: 'INSTALL_FINALIZATION_UNCERTAIN' }))
    const result = await runLifecycleRuntime(request)
    expect(result).toMatchObject({ exitCode: 6, code: 'INSTALL_FINALIZATION_UNCERTAIN', outcome: 'attention' })
    expect(result.details).toEqual({})
    expect(seams.legacy).not.toHaveBeenCalled()
  })
})
