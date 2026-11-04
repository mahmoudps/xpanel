import { describe, expect, it } from 'vitest'
import { AsyncResource } from 'node:async_hooks'
import { COORDINATOR_PATHS as P, assertCoordinatorOwnershipCurrent, coordinatorOwnershipInfo, parseCoordinatorOwnership, renderCoordinatorUnit, withVisibleCoordinatorOwnership } from './coordinator-ownership.mjs'
import { OWNED_PANEL_UNITS } from './lifecycle-ownership.mjs'

const sha = 'a'.repeat(64)
const receipt = () => ({ schemaVersion: 1, product: 'xpanel', unit: 'xpanel-lifecycle.service', createdAt: '2026-11-03T00:00:00.000Z',
  helper: { version: '0.1.1', releaseRoot: '/opt/xpanel/releases/0.1.1', archivePath: '/opt/xpanel/downloads/xpanel-release-0.1.1.tar.gz', archiveSha256: sha, manifestSha256: sha,
    sourceFilesDigest: sha, dependencyReceiptPath: `/var/lib/xpanel-lifecycle/prepared/${sha}/dependencies.json`, dependencyReceiptSha256: sha, treeSha256: sha },
  runtime: { nodePath: '/usr/bin/node', nodeVersion: '26.12.1', nodeSha256: sha, systemctlSha256: sha },
  files: [P.unit, P.enabled, P.privateKey, P.publicKey, P.addon].map((path, index) => ({ path, kind: path === P.enabled ? 'symlink' : 'file', device: '2049', inode: String(index + 100), size: 100,
    mode: path === P.enabled ? 0o777 : path === P.privateKey ? 0o600 : path === P.addon ? 0o755 : 0o644, sha256: path === P.enabled ? null : sha, target: path === P.enabled ? P.unit : null })) })

describe('fixed root coordinator ownership; portable syntax only', () => {
  it('pins immutable absolute source and remains outside the drained panel units', () => {
    const unit = renderCoordinatorUnit('/usr/bin/node', '/opt/xpanel/releases/0.1.1')
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/xpanel/releases/0.1.1/apps/agent/src/ops-upgrade-native.ts\n')
    expect(unit).toContain('User=root\nGroup=root\n')
    expect(unit).toContain('RuntimeDirectoryMode=0700\n')
    expect(unit).not.toContain('/current/')
    expect(OWNED_PANEL_UNITS).not.toContain('xpanel-lifecycle.service')
  })
  it.each(['/opt/xpanel/current', '/opt/xpanel/releases/../0.1.1', '/tmp/0.1.1'])('rejects mutable or escaped helper source %s', source => {
    expect(() => renderCoordinatorUnit('/usr/bin/node', source)).toThrow()
  })
  it('freezes a copied finite receipt and keeps signing keys separate from archive trust', () => {
    const source = receipt(), parsed = parseCoordinatorOwnership(source)
    source.helper.version = '9.9.9'
    expect(parsed.helper.version).toBe('0.1.1')
    expect(Object.isFrozen(parsed.files[0])).toBe(true)
    expect(parsed.files.map(file => file.path)).toContain('/etc/xpanel/lifecycle-launcher.key')
    expect(parsed.files.map(file => file.path)).not.toContain('/etc/xpanel/release-trust.json')
  })
  it.each([
    (v: any) => { v.helper.version = Object('0.1.1') },
    (v: any) => { v.runtime.nodeSha256 = Object(sha) },
    (v: any) => { v.files[0].inode = 100 },
    (v: any) => { v.files[2].mode = 0o644 },
    (v: any) => { v.files[0].path = '/etc/systemd/system/sshd.service' },
    (v: any) => { v.helper.releaseRoot = '/opt/xpanel/current' },
    (v: any) => { v.files.push(v.files[0]) },
  ])('rejects coercible metadata and foreign ownership', mutate => { const value = receipt(); mutate(value); expect(() => parseCoordinatorOwnership(value)).toThrow() })
  it('does not turn a parsed receipt or copied object into a live authority', async () => {
    const parsed = parseCoordinatorOwnership(receipt())
    await expect(assertCoordinatorOwnershipCurrent(parsed)).rejects.toThrow('COORDINATOR_OWNERSHIP_SCOPE_REQUIRED')
    expect(() => coordinatorOwnershipInfo(parsed)).toThrow('COORDINATOR_OWNERSHIP_SCOPE_REQUIRED')
  })
  it('does not restore coordinator scope for a native callback without a live ownership capability', async () => {
    const parsed = parseCoordinatorOwnership(receipt())
    const resource = new AsyncResource('xpanel-native-listener')
    await resource.runInAsyncScope(async () => {
      await expect(withVisibleCoordinatorOwnership(parsed, async () => 'restored')).rejects.toThrow('COORDINATOR_OWNERSHIP_SCOPE_REQUIRED')
    })
    resource.emitDestroy()
  })
})
