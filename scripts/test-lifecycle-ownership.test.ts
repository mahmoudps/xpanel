import { describe, expect, it } from 'vitest'
import { OWNED_PANEL_UNITS, isRemovableControlPlanePath, parseInstallationReceipt, preservingUninstallPlan, requireLinuxRoot } from './lifecycle-ownership.mjs'

const sha = 'a'.repeat(64)
const unit = (name: string) => ({ path: `/etc/systemd/system/${name}`, kind: 'file', device: '2049', inode: name === 'xpanel-api.service' ? '101' : '102', size: 100, mode: 0o644, sha256: sha, target: null })
const receipt = () => ({
  schemaVersion: 1, product: 'xpanel', status: 'active', officialReference: null, lastLifecycleReference: null,
  createdAt: '2026-10-23T08:00:00.000Z',
  source: { root: '/opt/xpanel', version: '1.2.3', archiveSha256: sha, manifestSha256: sha, dependencyReceiptSha256: sha, controlDbSchemaVersion: 2 },
  runtime: { nodePath: '/usr/bin/node', nodeVersion: '26.12.1', nodeSha256: sha, systemctlSha256: sha, nginxSha256: sha },
  writerProtocol: 'lifecycle-admission-v1', units: [...OWNED_PANEL_UNITS],
  files: [
    { path: '/usr/local/bin/xpanel-ctl', kind: 'symlink', device: '2049', inode: '100', size: 28, mode: 0o777, sha256: null, target: '/opt/xpanel/bin/xpanel-ctl' },
    { path: '/opt/xpanel/bin/xpanel-ctl', kind: 'file', device: '2049', inode: '103', size: 150, mode: 0o755, sha256: sha, target: null },
    ...OWNED_PANEL_UNITS.map(unit),
    ...['/etc/nginx/conf.d/xpanel-management.conf', '/etc/nginx/conf.d/xpanel-management-challenge.conf', '/etc/nginx/xpanel-management/ingress-secret.conf'].map(path => ({ ...unit('ingress'), path, mode: path.endsWith('ingress-secret.conf') ? 0o600 : 0o644 })),
    ...['/etc/systemd/system/multi-user.target.wants/xpanel-api.service', '/etc/systemd/system/multi-user.target.wants/xpanel-agent.service', '/etc/systemd/system/timers.target.wants/xpanel-management-tls.timer'].map(path => ({ path, kind: 'symlink', device: '2049', inode: '200', size: 100, mode: 0o777, sha256: null, target: `/etc/systemd/system/${path.split('/').at(-1)}` })),
  ],
})

describe('root installation receipt syntax and preserving uninstall plan; not operational proof', () => {
  it('keeps unissued references explicit and freezes the copied finite record', () => {
    const input = receipt()
    const parsed = parseInstallationReceipt(input)
    expect(parsed.officialReference).toBe(null)
    expect(parsed.lastLifecycleReference).toBe(null)
    expect(Object.isFrozen(parsed.files[0])).toBe(true)
    input.files[0]!.path = '/home/alice'
    expect(parsed.files[0].path).toBe('/usr/local/bin/xpanel-ctl')
  })
  it('uses only the persisted official lifecycle reference, never an internal-ID fallback', () => {
    const input = receipt()
    const valid = { ...input, lastLifecycleReference: 'XP-JOB-2026-000123' }
    expect(parseInstallationReceipt(valid).lastLifecycleReference).toBe(valid.lastLifecycleReference)
    expect(parseInstallationReceipt({ ...input, lastLifecycleReference: 'XP-LC-2026-000123' }).lastLifecycleReference).toBe('XP-LC-2026-000123')
    expect(() => parseInstallationReceipt({ ...input, lastLifecycleReference: '11111111-2222-3333-4444-555555555555' })).toThrow(/REFERENCE_INVALID/)
  })
  it.each(['/home/alice', '/var/lib/xpanel/control.db', '/var/lib/xpanel-lifecycle/reference-registry.json', '/etc/xpanel/api.env', '/etc/letsencrypt/live/panel/privkey.pem', '/etc/systemd/system/nginx.service', '/opt/xpanel/../../etc/shadow'])('cannot remove protected or non-owned surface %s', path => {
    expect(isRemovableControlPlanePath(path)).toBe(false)
    const value = receipt(); value.files[0]!.path = path
    expect(() => parseInstallationReceipt(value)).toThrow(/NOT_REMOVABLE/)
  })
  it('preserves source, state, credentials, mail, customer DBs and permanent authority', () => {
    const plan = preservingUninstallPlan(receipt())
    expect(plan.purge).toBe(false)
    expect(plan.restoreHistoricalAuthority).toBe(false)
    expect(plan.retain).toEqual(expect.arrayContaining(['/opt/xpanel', '/var/lib/xpanel', '/etc/xpanel', '/var/vmail', '/var/lib/mysql', '/etc/letsencrypt']))
    expect(plan.removal).not.toContain('/var/lib/xpanel-lifecycle')
    // This plan is intentionally not a complete-uninstall readiness proof. The runtime must
    // additionally demand the full TLS/ingress surface adapter before creating any marker.
  })
  it.each([
    (v: any) => { v.files.push(structuredClone(v.files[0])) },
    (v: any) => { v.files[1].mode = 0o777 },
    (v: any) => { v.files[0].target = '/tmp/attacker' },
    (v: any) => { v.runtime.nodePath = '/tmp/node' },
    (v: any) => { v.source.dependencyReceiptSha256 = '' },
    (v: any) => { v.extra = true },
    (v: any) => { v.files[1].extra = true },
    (v: any) => { v.units.push('nginx.service') },
  ])('rejects unsafe or structurally incomplete ownership metadata', mutate => {
    const input = receipt(); mutate(input)
    expect(() => parseInstallationReceipt(input)).toThrow()
  })
  it('supports a canonical custom runtime path while retaining its exact version/hash requirement', () => {
    const value = receipt(); value.runtime.nodePath = '/opt/node-26/bin/node'
    expect(parseInstallationReceipt(value).runtime.nodePath).toBe('/opt/node-26/bin/node')
    expect(() => parseInstallationReceipt({ ...value, runtime: { ...value.runtime, nodePath: '/usr/bin/../bin/node' } })).toThrow()
  })
  it('rejects coercible versions, hashes and inode claims instead of trusting their string conversion', () => {
    const boxed = receipt(); Object.assign(boxed.source, { version: Object('1.2.3') })
    expect(() => parseInstallationReceipt(boxed)).toThrow('INSTALLATION_SOURCE_INVALID')
    const version = receipt(); Object.assign(version.source, { version: { toString: () => '1.2.3' } })
    expect(() => parseInstallationReceipt(version)).toThrow('INSTALLATION_SOURCE_INVALID')
    const inode = receipt(); Object.assign(inode.files[0]!, { inode: 100 })
    expect(() => parseInstallationReceipt(inode)).toThrow('INSTALLATION_FILE_INVALID')
    const hash = receipt(); Object.assign(hash.runtime, { nodeSha256: { toString: () => sha } })
    expect(() => parseInstallationReceipt(hash)).toThrow('INSTALLATION_RUNTIME_INVALID')
  })
  it('has no fake-platform or caller-provided root bypass', () => {
    if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) expect(() => requireLinuxRoot()).toThrow(/LINUX_ROOT_REQUIRED/)
  })
})
