import { describe, expect, it } from 'vitest'
import { nativeLifecyclePathAllowed, releaseInfoFromAuthenticatedReport, runNativeLifecycleCommand, validateNativeLifecycleRequest } from './native-runtime.ts'

const artifact = { path: '/opt/xpanel/downloads/release.tar.gz', expectedArchiveSha256: 'a'.repeat(64), keyId: 'release-key', signingKeyPath: '/tmp/caller-key' }
const input = (command = 'upgrade') => ({ schemaVersion: 1, command, mode: 'apply', json: true, assumeYes: true, artifact })

describe('native lifecycle composition boundary', () => {
  it('projects syntax without preserving a caller trust path or success callbacks', () => {
    const value = validateNativeLifecycleRequest(input())
    expect(value).toEqual({ command: 'upgrade', artifact: { path: artifact.path, expectedArchiveSha256: artifact.expectedArchiveSha256, keyId: artifact.keyId } })
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.artifact)).toBe(true)
    expect(value.artifact).not.toHaveProperty('signingKeyPath')
    expect(() => validateNativeLifecycleRequest({ ...input(), readiness: async () => true })).toThrow('LIFECYCLE_REQUEST_INVALID')
    expect(() => validateNativeLifecycleRequest({ ...input(), actor: { kind: 'root' } })).toThrow('LIFECYCLE_REQUEST_INVALID')
    expect(() => validateNativeLifecycleRequest({ ...input(), dbPath: '/tmp/other.db' })).toThrow('LIFECYCLE_REQUEST_INVALID')
  })

  it('does not evaluate accessor claims, trust a receipt, or accept an alternate artifact directory', () => {
    let touched = false
    const accessor = Object.defineProperty({}, 'schemaVersion', { get() { touched = true; return 1 } })
    expect(() => validateNativeLifecycleRequest(accessor)).toThrow('LIFECYCLE_REQUEST_INVALID')
    expect(touched).toBe(false)
    expect(() => validateNativeLifecycleRequest({ ...input(), dependencyReceipt: { ready: true } })).toThrow('LIFECYCLE_RECEIPT_NOT_AUTHORITY')
    for (const path of ['/tmp/release.tar.gz', '/opt/xpanel/downloads/../release.tar.gz', '/opt/xpanel/downloads/sub/release.tar.gz', '/home/user/release.tar.gz']) {
      expect(() => validateNativeLifecycleRequest({ ...input(), artifact: { ...artifact, path } })).toThrow('LIFECYCLE_ARTIFACT_INVALID')
    }
  })

  it('requires explicit apply confirmation and supports no caller-selected rollback pointers', () => {
    expect(validateNativeLifecycleRequest({ schemaVersion: 1, command: 'recover', mode: 'apply', json: false, assumeYes: true })).toEqual({ command: 'recover' })
    for (const change of [{ assumeYes: false }, { mode: 'plan' }, { targetRelease: '1.0.0' }, { command: 'install' }, { command: 'uninstall' }, { command: 'rollback-release' }]) expect(() => validateNativeLifecycleRequest({ ...input(), ...change })).toThrow()
    expect(() => validateNativeLifecycleRequest({ ...input('recover') })).toThrow('LIFECYCLE_REQUEST_INVALID')
  })

  it('projects authenticated source metadata without making installReady or callback claims authoritative', () => {
    const report = { ok: true, scope: 'source-artifact', archiveSha256: artifact.expectedArchiveSha256, totalUnpackedBytes: 1024, installReady: false, manifest: { version: '2.0.0', controlDbSchemaVersion: 3 } }
    expect(releaseInfoFromAuthenticatedReport(report, artifact)).toEqual({ version: '2.0.0', schemaVersion: 3, archivePath: artifact.path, sha256: artifact.expectedArchiveSha256, bytes: 1024 })
    for (const change of [{ ok: false }, { archiveSha256: 'b'.repeat(64) }, { totalUnpackedBytes: 0 }, { totalUnpackedBytes: Number.MAX_SAFE_INTEGER + 1 }, { scope: 'runtime-ready' }, { manifest: { version: '2.0.0', controlDbSchemaVersion: -1 } }]) expect(() => releaseInfoFromAuthenticatedReport({ ...report, ...change }, artifact)).toThrow('LIFECYCLE_ARTIFACT_REPORT_INVALID')
  })

  it('keeps filesystem policy limited to engine-owned leaves and prevents authority/data deletion', () => {
    expect(nativeLifecyclePathAllowed('/opt/xpanel/.current-20261024', 'link')).toBe(true)
    expect(nativeLifecyclePathAllowed('/var/lib/xpanel/upgrade.lock.20261024.tmp', 'write')).toBe(true)
    expect(nativeLifecyclePathAllowed('/var/lib/xpanel/upgrade.lock.20261024.tmp', 'read')).toBe(true)
    expect(nativeLifecyclePathAllowed('/var/lib/xpanel-lifecycle/backups/retirement-attention.json', 'write')).toBe(true)
    expect(nativeLifecyclePathAllowed('/var/lib/xpanel-lifecycle/backups', 'directory')).toBe(true)
    for (const path of ['/home/user', '/var/lib/mysql/db', '/var/lib/xpanel/state', '/var/lib/xpanel/control.db', '/var/lib/xpanel-lifecycle/HEAD', '/opt/xpanel/releases', '/opt/xpanel/current', '/var/lib/xpanel/upgrade.lock', '/var/lib/xpanel-lifecycle/backups/retirement-attention.json']) expect(nativeLifecyclePathAllowed(path, 'remove')).toBe(false)
    // Rewind renames the live state tree and its per-record trees; retention removes only the sealed set-aside and empty scratch trees.
    expect(nativeLifecyclePathAllowed('/var/lib/xpanel/.rewind-8a6f0c1e-2b7d-4c55-9a1e-0d2f4b6c8e10', 'directory')).toBe(true)
    for (const path of ['/var/lib/xpanel/state', '/var/lib/xpanel/.rewind-8a6f0c1e/state', '/var/lib/xpanel/.pre-rewind-8a6f0c1e']) expect(nativeLifecyclePathAllowed(path, 'write')).toBe(true)
    for (const path of ['/var/lib/xpanel/.pre-rewind-8a6f0c1e', '/var/lib/xpanel/.rewind-8a6f0c1e', '/var/lib/xpanel-lifecycle/backups/upgrade-8a6f0c1e.rewind.json.tmp']) expect(nativeLifecyclePathAllowed(path, 'remove')).toBe(true)
    for (const path of ['/var/lib/xpanel/state', '/var/lib/xpanel/.rewind-8a6f0c1e/state', '/var/lib/xpanel-lifecycle/backups/upgrade-8a6f0c1e.receipt.json', '/var/lib/xpanel-lifecycle/backups/20261022T013500Z.tar.gz']) expect(nativeLifecyclePathAllowed(path, 'remove')).toBe(false)
    for (const path of ['/var/lib/xpanel/state/accounts', '/var/lib/xpanel/.rewind-../state', '/var/lib/xpanel/.pre-rewind-', '/var/lib/xpanel/control.db']) expect(nativeLifecyclePathAllowed(path, 'write')).toBe(false)
    for (const path of ['/opt/xpanel/staging/../../etc/passwd','/var/lib/xpanel/maintenance.json/child', '/opt/xpanel/current/child', 'C:/tmp/release']) expect(nativeLifecyclePathAllowed(path, 'write')).toBe(false)
  })

  it.skipIf(process.platform === 'linux' && process.getuid?.() === 0 && process.geteuid?.() === 0)('denies on the actual non-root/non-Linux runtime before opening native state', async () => {
    // Deliberately no mocked positive safety, filesystem, database or platform providers.
    await expect(runNativeLifecycleCommand(input())).rejects.toMatchObject({ code: 'LIFECYCLE_ROOT_LINUX_REQUIRED' })
    await expect(runNativeLifecycleCommand({ schemaVersion: 1, command: 'recover', mode: 'apply', json: true, assumeYes: true })).rejects.toMatchObject({ code: 'LIFECYCLE_ROOT_LINUX_REQUIRED' })
  })
})
