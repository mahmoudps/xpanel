import { createHash } from 'node:crypto'
import { constants, readdirSync, readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeNode = { kind: 'file' | 'directory' | 'symlink'; bytes: Buffer; mode: number; uid: number; gid: number; nlink: number; inode: bigint; target?: string }

const fake = vi.hoisted(() => ({ nodes: new Map<string, FakeNode>() }))
const stats = (node: FakeNode) => ({ dev: 1n, ino: node.inode, uid: BigInt(node.uid), gid: BigInt(node.gid), mode: BigInt(node.mode), nlink: BigInt(node.nlink), size: BigInt(node.bytes.length),
  mtimeNs: 1n, ctimeNs: 1n, isFile: () => node.kind === 'file', isDirectory: () => node.kind === 'directory', isSymbolicLink: () => node.kind === 'symlink' })
// Paths without an entry are the root-owned ancestor directories every trusted read walks.
const nodeAt = (path: string): FakeNode => fake.nodes.get(path) ?? { kind: 'directory', bytes: Buffer.alloc(0), mode: 0o755, uid: 0, gid: 0, nlink: 2, inode: 1n }

vi.mock('node:fs/promises', async original => ({
  ...await original<typeof import('node:fs/promises')>(),
  lstat: async (path: string) => stats(nodeAt(path)),
  readlink: async (path: string) => nodeAt(path).target,
  realpath: async (path: string) => nodeAt(path).target ?? path,
  open: async (path: string, flags: number) => {
    const node = nodeAt(path)
    if (node.kind === 'symlink' && flags & constants.O_NOFOLLOW) throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' })
    return { fd: 9, close: async () => {}, stat: async () => stats(node),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => ({ bytesRead: node.bytes.copy(buffer, offset, position, position + length) }) }
  },
}))
vi.mock('./prepared-release.mjs', () => ({
  withExistingPreparedRelease: (_input: unknown, callback: (prepared: object) => unknown) => callback({}),
  preparedReleaseInfo: () => ({ ...helper, runtime: { nodePath: '/usr/bin/node', nodeVersion: '26.12.1', nodeSha256: digest('node') } }),
  assertPreparedReleaseCurrent: async () => {}, withVisiblePreparedRelease: (_prepared: unknown, callback: () => unknown) => callback(),
}))

import { COORDINATOR_PATHS as P, coordinatorOwnershipInfo, renderCoordinatorUnit, withVerifiedCoordinatorOwnership } from './coordinator-ownership.mjs'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const sha = 'a'.repeat(64), SYSTEMCTL = '/usr/bin/systemctl'
const helper = { version: '0.1.1', releaseRoot: '/opt/xpanel/releases/0.1.1', archivePath: '/opt/xpanel/downloads/xpanel-release-0.1.1.tar.gz', archiveSha256: sha, manifestSha256: sha,
  sourceFilesDigest: sha, dependencyReceiptPath: `/var/lib/xpanel-lifecycle/prepared/${sha}/dependencies.json`, dependencyReceiptSha256: sha, treeSha256: sha }
const file = (bytes: string | Buffer, mode: number, inode: bigint): FakeNode => ({ kind: 'file', bytes: Buffer.from(bytes), mode, uid: 0, gid: 0, nlink: 1, inode })
const verified = () => withVerifiedCoordinatorOwnership(async capability => coordinatorOwnershipInfo(capability))

beforeEach(() => {
  vi.spyOn(process, 'getuid').mockReturnValue(0); vi.spyOn(process, 'geteuid').mockReturnValue(0)
  fake.nodes.clear()
  fake.nodes.set('/usr/bin/node', file('node', 0o755, 10n))
  fake.nodes.set(SYSTEMCTL, file('systemctl at install time', 0o755, 11n))
  const owned: [string, string, number][] = [[P.unit, renderCoordinatorUnit('/usr/bin/node', helper.releaseRoot), 0o644], [P.privateKey, 'private', 0o600], [P.publicKey, 'public', 0o644], [P.addon, 'addon', 0o755]]
  owned.forEach(([path, bytes, mode], index) => fake.nodes.set(path, file(bytes, mode, BigInt(20 + index))))
  fake.nodes.set(P.enabled, { kind: 'symlink', bytes: Buffer.alloc(0), mode: 0o777, uid: 0, gid: 0, nlink: 1, inode: 30n, target: P.unit })
  const files = [P.unit, P.enabled, P.privateKey, P.publicKey, P.addon].map(path => {
    const node = fake.nodes.get(path)!, link = node.kind === 'symlink'
    return { path, kind: node.kind, device: '1', inode: String(node.inode), size: node.bytes.length, mode: node.mode, sha256: link ? null : digest(node.bytes), target: link ? P.unit : null }
  })
  const receipt = { schemaVersion: 1, product: 'xpanel', unit: 'xpanel-lifecycle.service', createdAt: '2026-11-03T00:00:00.000Z', helper,
    runtime: { nodePath: '/usr/bin/node', nodeVersion: '26.12.1', nodeSha256: digest('node'), systemctlSha256: digest('systemctl at install time') }, files }
  fake.nodes.set(P.receipt, file(JSON.stringify(receipt), 0o600, 12n))
})

describe('systemctl is trusted by file properties, not by a recorded hash', () => {
  it('accepts systemctl replaced by a package update', async () => {
    fake.nodes.set(SYSTEMCTL, file('systemctl after an unattended upgrade', 0o755, 40n))
    expect(await verified()).toMatchObject({ unit: 'xpanel-lifecycle.service', nodeSha256: digest('node') })
  })

  it.each<[string, Partial<FakeNode>]>([
    ['another owner', { uid: 1000 }], ['another group', { gid: 1000 }], ['group write', { mode: 0o775 }], ['world write', { mode: 0o757 }],
    ['setuid', { mode: 0o4755 }], ['a hard link', { nlink: 2 }], ['a directory', { kind: 'directory' }],
  ])('refuses systemctl with %s', async (_name, change) => {
    Object.assign(fake.nodes.get(SYSTEMCTL)!, change)
    await expect(verified()).rejects.toThrow('TRUSTED_FILE_REQUIRED')
  })

  it('refuses a symlink at the systemctl path', async () => {
    Object.assign(fake.nodes.get(SYSTEMCTL)!, { kind: 'symlink', target: '/tmp/systemctl' })
    await expect(verified()).rejects.toThrow('ELOOP')
  })

  it('refuses a path swapped under the held descriptor', async () => {
    await expect(withVerifiedCoordinatorOwnership(async () => { fake.nodes.set(SYSTEMCTL, file('swapped', 0o755, 41n)) })).rejects.toThrow('TRUSTED_FILE_CHANGED')
  })

  it('keeps the hash pin on files the product ships', async () => {
    fake.nodes.get('/usr/bin/node')!.bytes = Buffer.from('nope')
    await expect(verified()).rejects.toThrow('TRUSTED_FILE_HASH_DRIFT')
  })

  it('compares no recorded systemctl or nginx hash anywhere in product code', () => {
    const compared = /\bsha256: *\S*(?:systemctl|nginx)Sha256|[!=]== *\S*(?:systemctl|nginx)Sha256|'\/usr\/bin\/systemctl', (?:\[[^\]]*\], )?\{[^}]*\bsha256:/
    const sources = [new URL('./', import.meta.url), new URL('../apps/agent/src/', import.meta.url)].flatMap(root =>
      readdirSync(root).filter(name => /\.(?:mjs|ts)$/.test(name) && !name.endsWith('.test.ts')).map(name => new URL(name, root)))
    expect(sources.length).toBeGreaterThan(50)
    expect(sources.filter(source => compared.test(readFileSync(source, 'utf8'))).map(String)).toEqual([])
  })
})
