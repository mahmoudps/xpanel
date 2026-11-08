import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assertOwnedFile, ownedFileDriftField } from './lifecycle-ownership.mjs'
import { ACTIVATION_KIND, ACTIVATION_PATH } from './management-tls-activation.mjs'

// Modeled root-owned tree: assertOwnedFile runs unchanged over it. No native host, nginx or certificate proof.
const tree = vi.hoisted(() => ({ nodes: new Map<string, { dir: boolean, bytes: Buffer, mode: number, uid: number, gid: number, nlink: number, ino: bigint }>(), inode: 100n }))
vi.mock('node:fs/promises', async original => {
  const node = (path: string) => tree.nodes.get(path) ?? (() => { throw Object.assign(new Error('missing model path'), { code: 'ENOENT' }) })()
  const stat = (held: ReturnType<typeof node>) => ({ dev: 2049n, ino: held.ino, uid: BigInt(held.uid), gid: BigInt(held.gid), nlink: BigInt(held.nlink),
    mode: BigInt((held.dir ? 0o40000 : 0o100000) | held.mode), size: BigInt(held.bytes.length), mtimeNs: held.ino, ctimeNs: held.ino,
    isFile: () => !held.dir, isDirectory: () => held.dir, isSymbolicLink: () => false })
  return { ...await original<typeof import('node:fs/promises')>(),
    lstat: async (path: string) => stat(node(path)),
    open: async (path: string) => { const held = node(path); return { fd: 3, stat: async () => stat(held), close: async () => {},
      read: async (buffer: Buffer, offset: number, length: number, position: number) => ({ bytesRead: held.bytes.copy(buffer, offset, position, position + length), buffer }) } },
  }
})

const PATH = { ingress: '/etc/nginx/conf.d/xpanel-management.conf', challenge: '/etc/nginx/conf.d/xpanel-management-challenge.conf',
  include: '/etc/nginx/xpanel-management/ingress-secret.conf', unit: '/etc/systemd/system/xpanel-management-tls.service' }
const MODE = { ingress: 0o644, challenge: 0o644, include: 0o600, unit: 0o644 }
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const directory = (path: string, mode = 0o755) => tree.nodes.set(path, { dir: true, bytes: Buffer.alloc(0), mode, uid: 0, gid: 0, nlink: 2, ino: tree.inode++ })
// An atomic replace, as management-tls replaceFile publishes: always a new inode.
const put = (path: string, bytes: string, mode: number, owner = 0) => tree.nodes.set(path, { dir: false, bytes: Buffer.from(bytes), mode, uid: owner, gid: owner, nlink: 1, ino: tree.inode++ })
const bytes = (name: keyof typeof PATH) => tree.nodes.get(PATH[name])!.bytes
const record = (files: Record<string, string>, mode = 0o600, kind = ACTIVATION_KIND) => put(ACTIVATION_PATH, JSON.stringify({ schemaVersion: 1, kind, phase: 'renew',
  files: { managementConfigSha256: sha('config'), nginxConfigurationSha256: sha('nginx -T'), ...files } }, null, 2) + '\n', mode)
/** One management TLS lifecycle: replace what changed, then publish the activation record over the files it serves. */
function managementTls(next: Partial<Record<'ingress' | 'challenge' | 'include', string>>, { challengeInRecord = true } = {}) {
  for (const [name, text] of Object.entries(next)) put(PATH[name as keyof typeof PATH], text, MODE[name as keyof typeof MODE])
  record({ ingressSha256: sha(bytes('ingress')), includeSha256: sha(bytes('include')), ...challengeInRecord ? { challengeSha256: sha(bytes('challenge')) } : {} })
}
/** The receipt fields captureInstallOwnership records for a regular file. */
const capture = (name: keyof typeof PATH) => { const held = tree.nodes.get(PATH[name])!; return { path: PATH[name], kind: 'file', device: '2049', inode: String(held.ino), size: held.bytes.length, mode: held.mode, sha256: sha(held.bytes), target: null } }
/** Upgrade admission: every receipt file passes assertOwnedFile, as initialInstallationValue and prepareInstallationTransition require. */
const admit = async (receipt: ReturnType<typeof capture>[]) => { for (const entry of receipt) await assertOwnedFile(entry) }
const generation = (fingerprint: string) => `# Managed by xPanel management TLS lifecycle v1.\nserver { listen 443 ssl http2; ssl_certificate /etc/xpanel/management-certificates/${fingerprint}/fullchain.pem; }\n`

let receipt: ReturnType<typeof capture>[]
beforeEach(() => {
  tree.nodes.clear()
  for (const path of ['/', '/etc', '/etc/nginx', '/etc/nginx/conf.d', '/etc/systemd', '/etc/systemd/system', '/var', '/var/lib', '/var/lib/xpanel-management-tls']) directory(path)
  directory('/etc/nginx/xpanel-management', 0o700)
  put(PATH.unit, '[Service]\nExecStart=/opt/xpanel/bin/node /opt/xpanel/releases/0.1.34/scripts/management-tls.mjs renew\n', MODE.unit)
  // install.sh runs management-tls prepare, then install-bootstrap capture.
  managementTls({ ingress: generation('a'.repeat(64)), challenge: '# Managed by xPanel management TLS lifecycle v1.\nserver { listen 80; server_name panel.example.test; }\n',
    include: '# Managed by xPanel management TLS lifecycle v1.\nproxy_set_header X-XPanel-Ingress-Secret "model";\n' })
  receipt = (['ingress', 'challenge', 'include', 'unit'] as const).map(capture)
})

describe('upgrade admission after a legitimate management TLS write (modeled tree, no native proof)', () => {
  it('admits the ingress a renewal rewrote with the next certificate generation', async () => {
    await admit(receipt)
    managementTls({ ingress: generation('b'.repeat(64)) })
    await expect(admit(receipt)).resolves.toBeUndefined()
  })
  it('admits a rebind challenge and a rollback that restored identical bytes on a new inode', async () => {
    managementTls({ challenge: '# Managed by xPanel management TLS lifecycle v1.\nserver { listen 80; server_name panel.other.test; }\n', include: bytes('include').toString() })
    await expect(admit(receipt)).resolves.toBeUndefined()
  })
  it('binds the challenge to its install-time bytes when the activation record predates challengeSha256', async () => {
    managementTls({ ingress: generation('c'.repeat(64)), challenge: bytes('challenge').toString() }, { challengeInRecord: false })
    await expect(admit(receipt)).resolves.toBeUndefined()
    managementTls({ challenge: '# Managed by xPanel management TLS lifecycle v1.\nserver { listen 80; server_name rebound.example.test; }\n' }, { challengeInRecord: false })
    await expect(admit(receipt)).rejects.toMatchObject({ code: 'TRUSTED_FILE_HASH_DRIFT' })
  })
})

describe('upgrade admission still refuses a foreign write of a management TLS file', () => {
  it('refuses ingress bytes the activation record does not name', async () => {
    put(PATH.ingress, generation('d'.repeat(64)), MODE.ingress)
    await expect(admit(receipt)).rejects.toMatchObject({ code: 'TRUSTED_FILE_HASH_DRIFT' })
  })
  it('refuses a named image with a foreign owner, mode or link count', async () => {
    const named = bytes('ingress').toString()
    put(PATH.ingress, named, MODE.ingress, 1000)
    await expect(admit(receipt)).rejects.toMatchObject({ code: 'OWNED_FILE_DRIFT', entryPath: PATH.ingress, field: 'owner' })
    put(PATH.ingress, named, 0o640)
    await expect(admit(receipt)).rejects.toMatchObject({ code: 'OWNED_FILE_DRIFT', field: 'mode' })
    put(PATH.ingress, named, MODE.ingress); tree.nodes.get(PATH.ingress)!.nlink = 2
    await expect(admit(receipt)).rejects.toMatchObject({ code: 'OWNED_FILE_DRIFT', field: 'kind' })
  })
  it('refuses when the activation record is missing, not private or not this lifecycle kind', async () => {
    managementTls({ ingress: generation('e'.repeat(64)) })
    const files = JSON.parse(tree.nodes.get(ACTIVATION_PATH)!.bytes.toString()).files
    record(files, 0o644)
    await expect(admit(receipt)).rejects.toMatchObject({ code: 'OWNED_ACTIVATION_RECORD_INVALID' })
    record(files, 0o600, 'other-record')
    await expect(admit(receipt)).rejects.toMatchObject({ code: 'OWNED_ACTIVATION_RECORD_INVALID' })
    tree.nodes.delete(ACTIVATION_PATH)
    await expect(admit(receipt)).rejects.toMatchObject({ code: 'OWNED_ACTIVATION_RECORD_INVALID' })
  })
  it('keeps the renewal units pinned to the recorded inode: management TLS writes them only before capture', async () => {
    put(PATH.unit, bytes('unit').toString(), MODE.unit)
    await expect(admit(receipt)).rejects.toMatchObject({ code: 'OWNED_FILE_DRIFT', entryPath: PATH.unit, field: 'inode' })
  })
  it('ignores inode and size only for the three management TLS paths', () => {
    const named = (path: keyof typeof PATH, patch = {}) => ({ dev: 2049n, ino: 999n, size: 1n, mode: BigInt(0o100000 | MODE[path]), uid: 0n, gid: 0n, nlink: 1n, isFile: () => true, isSymbolicLink: () => false, ...patch })
    expect(ownedFileDriftField(receipt[0], named('ingress'))).toBeNull()
    expect(ownedFileDriftField(receipt[0], named('ingress', { dev: 2050n }))).toBe('device')
    expect(ownedFileDriftField(receipt[3], named('unit'))).toBe('inode')
  })
})
