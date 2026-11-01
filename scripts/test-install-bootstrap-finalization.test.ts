import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Protected filesystem and protocol ports are isolated test doubles, never host qualification.
const fixture = vi.hoisted(() => ({
  files: new Map<string, Buffer>(), calls: [] as string[], bootstrapReads: 0, driftOnRecheck: false,
  current: '/opt/xpanel/releases/0.1.0', root: vi.fn(), inspect: vi.fn(), native: vi.fn(), effects: vi.fn(),
}))
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const root = '/opt/xpanel/releases/0.1.0'
const bootstrapPath = '/var/lib/xpanel-lifecycle/bootstrap.json'
const receiptPath = '/var/lib/xpanel-lifecycle/installation.json'
const headPath = '/var/lib/xpanel-lifecycle/HEAD'
const nodePath = '/usr/bin/node'
const failure = (code: string): never => { throw Object.assign(new Error(code), { code }) }

vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => { fixture.effects(...args); return failure('UNEXPECTED_HOST_EFFECT') } }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  const noEffect = (...args: unknown[]) => { fixture.effects(...args); return failure('UNEXPECTED_HOST_EFFECT') }
  return { ...actual, chmod: noEffect, mkdir: noEffect, open: noEffect, rename: noEffect, symlink: noEffect,
    readlink: async (path: string) => {
      if (path === '/proc/self') return String(process.pid)
      if (path === `/proc/${process.pid}/exe`) return '/usr/bin/node'
      if (path === '/opt/xpanel/current') return fixture.current
      return failure('UNEXPECTED_READLINK')
    },
    realpath: async (path: string) => {
      if (path === process.execPath) return '/usr/bin/node'
      if (path.replaceAll('\\', '/').endsWith('/scripts/install-bootstrap.mjs')) return join('/opt/xpanel/releases/0.1.0', 'scripts/install-bootstrap.mjs')
      if (path === '/opt/xpanel/current') return fixture.current
      if (path === '/opt/xpanel/releases/0.1.0') return path
      return failure('UNEXPECTED_REALPATH')
    },
    lstat: async (path: string) => {
      if (path !== '/opt/xpanel/releases/0.1.0') return failure('UNEXPECTED_LSTAT')
      return { uid: 0n, gid: 0n, nlink: 1n, mode: 0o755n, size: 0n, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }
    },
    readdir: async (path: string) => path === '/opt/xpanel/releases/0.1.0' ? [] : failure('UNEXPECTED_READDIR'),
    readFile: async () => failure('UNEXPECTED_READFILE'),
  }
})
vi.mock('./lifecycle-ownership.mjs', async original => {
  const actual = await original<typeof import('./lifecycle-ownership.mjs')>()
  return { ...actual, requireLinuxRoot: fixture.root, assertTrustedDirectory: vi.fn(async () => undefined),
    withTrustedFile: async (path: string, _options: unknown, callback: (value: object) => unknown) => {
      if (!path.replaceAll('\\', '/').endsWith('/scripts/install-bootstrap.mjs')) return failure('UNEXPECTED_TRUSTED_FILE')
      return callback({})
    },
    readTrustedFile: async (path: string, options: { sha256?: string } = {}) => {
      fixture.calls.push(path)
      const bytes = fixture.files.get(path)
      if (!bytes) return failure('ENOENT')
      if (path === '/var/lib/xpanel-lifecycle/bootstrap.json') {
        fixture.bootstrapReads++
        if (fixture.driftOnRecheck && fixture.bootstrapReads > 1) return failure('TRUSTED_FILE_DIGEST')
      }
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (options.sha256 && options.sha256 !== digest) return failure('TRUSTED_FILE_DIGEST')
      return { bytes, sha256: digest, info: { mode: 0o755n, size: BigInt(bytes.length) } }
    },
  }
})
vi.mock('./install-finalization.mjs', () => ({ inspectInstallFinalizationRecovery: fixture.inspect }))
vi.mock('./install-finalization-native.mjs', () => ({ runNativeInstallFinalization: fixture.native }))

import { captureInstallOwnership, finalizePreparedInstallation, observePreparedInstallFinalization } from './install-bootstrap.mjs'

const bootstrap = (status = 'bootstrap_pending', marker = false) => ({ schemaVersion: 1, status, createdAt: '2026-10-30T00:00:00.000Z', version: '0.1.0',
  releaseRoot: root, archiveSha256: 'a'.repeat(64), manifestSha256: hash(JSON.stringify(manifest())), controlDbSchemaVersion: 6,
  dependencyReceiptSha256: hash(JSON.stringify(dependencies())), runtime: { nodePath, nodeSha256: hash('node') },
  ...(marker ? { finalization: { phase: 'complete', subjectDigest: 'c'.repeat(64) } } : {}) })
const manifest = () => ({ version: '0.1.0', controlDbSchemaVersion: 6, runtime: { nodeVersion: '26.12.1', packageManager: 'pnpm@12.15.0' }, lockfileSha256: hash('lock') })
const dependencies = () => ({ schemaVersion: 1, kind: 'xpanel-installed-dependencies', root, archiveSha256: 'a'.repeat(64),
  manifestSha256: hash(JSON.stringify(manifest())), controlDbSchemaVersion: 6, nodeVersion: '26.12.1', nodePath, nodeSha256: hash('node'),
  packageManager: 'pnpm@12.15.0', packageManagerPath: '/usr/bin/pnpm', packageManagerSha256: hash('pnpm'), lockfileSha256: hash('lock'), tree: { treeSha256: hash('[]') } })
const setBootstrap = (value: unknown) => fixture.files.set(bootstrapPath, Buffer.from(JSON.stringify(value)))

beforeEach(() => {
  vi.clearAllMocks(); fixture.calls.length = 0; fixture.bootstrapReads = 0; fixture.driftOnRecheck = false; fixture.current = root; fixture.files.clear()
  vi.stubEnv('NODE_OPTIONS', ''); vi.stubEnv('NODE_PATH', '')
  fixture.root.mockImplementation(() => undefined)
  fixture.inspect.mockImplementation((input: { bootstrapBytes: string; receiptBytes: string; headBytes: string }) => {
    const value = JSON.parse(input.bootstrapBytes)
    if (!value.finalization) return failure('INSTALL_FINALIZATION_MARKER_REQUIRED')
    return { bootstrap: value, receipt: JSON.parse(input.receiptBytes), head: JSON.parse(input.headBytes), intent: value.finalization }
  })
  fixture.native.mockResolvedValue({ exitCode: 3, code: 'NATIVE_FIXTURE_REFUSAL', outcome: 'blocked', details: {} })
  fixture.files.set(nodePath, Buffer.from('node')); fixture.files.set('/usr/bin/pnpm', Buffer.from('pnpm'))
  fixture.files.set(join(root, 'release-manifest.json'), Buffer.from(JSON.stringify(manifest())))
  fixture.files.set('/var/lib/xpanel-lifecycle/install-dependencies.json', Buffer.from(JSON.stringify(dependencies())))
  fixture.files.set(join(root, 'pnpm-lock.yaml'), Buffer.from('lock'))
  fixture.files.set('/etc/xpanel/release-trust.json', Buffer.from(JSON.stringify({ keyId: 'archive-anchor', signingKeyPath: '/etc/xpanel/release-hmac.key', packageManagerPath: '/usr/bin/pnpm', packageManagerSha256: hash('pnpm') })))
  fixture.files.set(receiptPath, Buffer.from('{"schemaVersion":1,"fixture":"receipt"}'))
  fixture.files.set(headPath, Buffer.from('{"schemaVersion":1,"fixture":"head"}'))
  setBootstrap(bootstrap())
})
afterEach(() => { expect(fixture.effects).not.toHaveBeenCalled(); vi.unstubAllEnvs() })

describe('prepared bootstrap observation; isolated read-only adapter contract', () => {
  it('retains actual source/runtime/dependency checks for a pending observation without minting authority', async () => {
    const result = await observePreparedInstallFinalization()
    expect(result.bootstrap).toEqual(bootstrap())
    expect(result.runtime).toEqual({ nodePath, nodeSha256: hash('node') })
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.bootstrap)).toBe(true)
    expect(fixture.inspect).not.toHaveBeenCalled(); expect(fixture.native).not.toHaveBeenCalled()
    expect(fixture.bootstrapReads).toBe(2)
  })

  it.each(['prepared', 'admission_ready', 'uninstalled'])('refuses %s before finalization source admission', async status => {
    setBootstrap(bootstrap(status))
    await expect(observePreparedInstallFinalization()).rejects.toThrow('INSTALL_FINALIZATION_PREPARATION_REQUIRED')
    expect(fixture.inspect).not.toHaveBeenCalled(); expect(fixture.native).not.toHaveBeenCalled()
  })

  it('passes exact protected bootstrap/receipt/HEAD bytes to the shared recovery parser', async () => {
    setBootstrap(bootstrap('bootstrap_pending', true))
    const value = await observePreparedInstallFinalization()
    expect(fixture.inspect).toHaveBeenCalledExactlyOnceWith({ bootstrapBytes: fixture.files.get(bootstrapPath)!.toString(), receiptBytes: fixture.files.get(receiptPath)!.toString(), headBytes: fixture.files.get(headPath)!.toString() })
    expect(value.bootstrap.status).toBe('bootstrap_pending')
    expect(fixture.calls.filter(path => path === receiptPath)).toHaveLength(2)
    expect(fixture.calls.filter(path => path === headPath)).toHaveLength(2)
  })

  it.each(['INSTALL_FINALIZATION_MARKER_INVALID', 'INSTALL_FINALIZATION_RECEIPT_CHANGED', 'INSTALL_FINALIZATION_HEAD_CHANGED'])('propagates shared recovery refusal %s without declaring source ready', async code => {
    setBootstrap(bootstrap('bootstrap_pending', true))
    fixture.inspect.mockImplementation(() => failure(code))
    await expect(observePreparedInstallFinalization()).rejects.toThrow(code)
    expect(fixture.calls).not.toContain(join(root, 'release-manifest.json'))
    expect(fixture.native).not.toHaveBeenCalled()
  })

  it('requires the recovery parser for an active retry while ordinary ownership capture still refuses active', async () => {
    setBootstrap(bootstrap('active'))
    await expect(observePreparedInstallFinalization()).rejects.toThrow('INSTALL_FINALIZATION_MARKER_REQUIRED')
    setBootstrap(bootstrap('active', true))
    expect((await observePreparedInstallFinalization()).bootstrap.status).toBe('active')
    await expect(captureInstallOwnership()).rejects.toThrow('INSTALL_BOOTSTRAP_INVALID')
    expect(fixture.native).not.toHaveBeenCalled()
  })

  it('rejects a changed current release before returning an observation', async () => {
    fixture.current = '/opt/xpanel/releases/other'
    await expect(observePreparedInstallFinalization()).rejects.toThrow('INSTALL_CURRENT_CHANGED')
  })

  it('retains the dependency lockfile digest check', async () => {
    fixture.files.set(join(root, 'pnpm-lock.yaml'), Buffer.from('changed'))
    await expect(observePreparedInstallFinalization()).rejects.toThrow('TRUSTED_FILE_DIGEST')
  })

  it('rejects bootstrap drift during the awaited source verification', async () => {
    fixture.driftOnRecheck = true
    await expect(observePreparedInstallFinalization()).rejects.toThrow('TRUSTED_FILE_DIGEST')
    expect(fixture.bootstrapReads).toBe(2)
  })

  it('rejects invalid UTF-8 before treating bootstrap bytes as a source record', async () => {
    fixture.files.set(bootstrapPath, Buffer.from([0xff]))
    await expect(observePreparedInstallFinalization()).rejects.toThrow('INSTALL_JSON_INVALID')
  })

  it('forwards only to the fixed native factory and preserves its refusal', async () => {
    const request = Object.freeze({ schemaVersion: 1, command: 'install', mode: 'apply', json: true, assumeYes: true })
    expect(await finalizePreparedInstallation(request)).toMatchObject({ exitCode: 3, code: 'NATIVE_FIXTURE_REFUSAL', outcome: 'blocked' })
    expect(fixture.native).toHaveBeenCalledExactlyOnceWith(request)
    expect(fixture.calls).toEqual([]); expect(fixture.root).not.toHaveBeenCalled()
  })
})
