import { beforeEach, describe, expect, it, vi } from 'vitest'

// Isolated source ports only. No native capability, Linux authority or effects
// are established by this fixture. Keep the archive's real { report, value }
// contract so a native result cannot be confused with the verification envelope.
const fixture = vi.hoisted(() => ({
  finalize: vi.fn(), archive: vi.fn(), startup: vi.fn(), closed: [] as string[],
  report: { archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) },
}))
vi.mock('node:fs/promises', () => {
  const stat = (path: string) => ({
    dev: 1n, ino: path.endsWith('/state') ? 11n : 10n,
    uid: 1000n, gid: 1000n, nlink: 1n,
    mode: path.endsWith('control.db') ? 0o660n : path.endsWith('/state') ? 0o2750n : 0o2770n,
    isFile: () => path.endsWith('control.db'), isDirectory: () => !path.endsWith('control.db'), isSymbolicLink: () => false,
  })
  return {
    readFile: async (path: string) => {
      if (path === '/proc/self/status') return 'Uid:\t0\t0\t0\t0\n'
      if (path === '/proc/self/stat') { const fields = Array(21).fill('0'); fields[19] = '100'; return '123 (node) ' + fields.join(' ') }
      throw new Error('unexpected source port')
    },
    readlink: async (path: string) => path === '/proc/self' ? String(process.pid) : '/opt/node-v26.12.1/bin/node',
    realpath: async (path: string) => path.endsWith('install-finalization-native.mjs')
      ? '/opt/xpanel/releases/0.1.1/scripts/install-finalization-native.mjs' : path === process.execPath ? '/opt/node-v26.12.1/bin/node' : path,
    lstat: async (path: string) => stat(path),
    open: async (path: string) => ({ stat: async () => stat(path), close: async () => { fixture.closed.push(path) } }),
    rename: vi.fn(),
  }
})
vi.mock('./lifecycle-ownership.mjs', () => ({
  requireLinuxRoot: vi.fn(), assertOwnedFile: vi.fn(), readInstallationReceipt: vi.fn(),
  readTrustedFile: async (path: string) => {
    if (path === '/etc/passwd') return { bytes: Buffer.from('xpanel:x:1000:1000::/var/lib/xpanel:/usr/sbin/nologin\n') }
    throw new Error('unexpected trusted read')
  },
  withTrustedDirectory: async (_path: string, run: (pin: unknown) => unknown) => run({ verify: async () => {} }),
  withTrustedFile: async (path: string, _options: unknown, run: (pin: unknown) => unknown) => run({
    bytes: path.endsWith('release-hmac.key') ? Buffer.alloc(32) : Buffer.from('{}'), verify: async () => {},
  }),
}))
vi.mock('./lifecycle-admission.mjs', () => ({
  withLifecycleWriterAdmission: async (run: () => unknown) => run(), assertLifecycleWriterAdmissionHeld: vi.fn(),
  withInstallFinalizationExclusiveAdmission: vi.fn(), assertInstallFinalizationExclusivePhysicalHeld: vi.fn(),
  assertInstallFinalizationExclusiveHeld: vi.fn(), verifyInstallFinalizationParticipants: vi.fn(),
}))
vi.mock('./install-bootstrap.mjs', () => ({
  observePreparedInstallFinalization: async () => ({
    runtime: { nodePath: '/opt/node-v26.12.1/bin/node', nodeSha256: 'c'.repeat(64) },
    bootstrap: { status: 'active', releaseRoot: '/opt/xpanel/releases/0.1.1', archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) },
  }),
  parseBootstrapTrust: () => ({ signingKeyPath: '/etc/xpanel/release-hmac.key', keyId: 'test-key' }),
  parseBootstrapKeys: vi.fn(), verifyBootstrapPublisher: vi.fn(),
}))
vi.mock('./release-verifier.mjs', () => ({ withAuthenticatedReleaseArchive: fixture.archive }))
vi.mock('./install-startup.mjs', () => ({
  verifyPreparedInstallStartupSources: vi.fn(), ensurePreparedInstallParticipants: fixture.startup, settlePreparedInstallReadiness: vi.fn(),
}))
vi.mock('../packages/db/src/index.ts', () => ({}))
vi.mock('../packages/state/src/index.ts', () => ({ StateStore: class {} }))
vi.mock('./install-finalization-readiness.mjs', () => ({}))
vi.mock('./install-finalization.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('./install-finalization.mjs')>(),
  runPreparedInstallFinalization: fixture.finalize,
}))

import { runNativeInstallFinalization } from './install-finalization-native.mjs'

const request = { schemaVersion: 1, command: 'install', mode: 'apply', json: true, assumeYes: true,
  artifact: { path: '/root/release.tar.gz', expectedArchiveSha256: 'a'.repeat(64), keyId: 'test-key', signingKeyPath: '/etc/xpanel/release-hmac.key' } }

beforeEach(() => {
  vi.clearAllMocks(); fixture.closed = []
  fixture.archive.mockImplementation(async (_path, _options, callback) => ({ report: fixture.report, value: await callback({ report: fixture.report }) }))
})

describe('finalization archive result contract through isolated source ports', () => {
  it.each([
    { exitCode: 0, code: 'INSTALL_OWNERSHIP_ACTIVE', outcome: 'committed', details: { installationActive: true } },
    { exitCode: 3, code: 'INSTALL_FINALIZATION_NOT_READY', outcome: 'blocked', details: { changed: false } },
  ])('returns the finalizer result without an archive envelope ($outcome)', async result => {
    fixture.finalize.mockResolvedValue(result)
    expect(await runNativeInstallFinalization(request)).toEqual(result)
    expect(fixture.finalize).toHaveBeenCalledOnce()
    expect(fixture.archive).toHaveBeenCalledOnce()
    expect(fixture.startup).not.toHaveBeenCalled()
    expect(fixture.closed).toEqual(['/var/lib/xpanel/state', '/var/lib/xpanel', '/var/lib/xpanel/control.db'])
  })

  it('preserves archive lifetime uncertainty before a finalizer result', async () => {
    fixture.archive.mockRejectedValue(Object.assign(new Error('withheld'), { code: 'ARCHIVE_USE_UNCERTAIN' }))
    expect(await runNativeInstallFinalization(request)).toMatchObject({ exitCode: 3, code: 'ARCHIVE_USE_UNCERTAIN', outcome: 'blocked', details: { changed: false } })
    expect(fixture.finalize).not.toHaveBeenCalled()
    expect(fixture.closed).toEqual([])
  })
})
