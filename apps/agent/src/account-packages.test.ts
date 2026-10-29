import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, Plan } from '@xpanel/core'
import type { FileEntry, FileText } from './file-manager.ts'
import { ACCOUNT_PEAR_LIBRARY as LIBRARY, ACCOUNT_PEAR_REGISTRY as REGISTRY, ACCOUNT_PEAR_TRANSACTION as TRANSACTION } from '../../../packages/os/src/account-package-command.ts'
import { handleAccountPackagesRoute, parseAccountPackageRequest, runAccountPackageRequest, verifyPearCatalog } from './account-packages.ts'
import type { AccountPackageFiles, AccountPackageRequest, AccountPackageRouteDeps, PearArtifact } from './account-packages.ts'

const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', status: 'active', planId: 'plan', uid: 1001, gid: 1001, home: '/home/alice' } as Account
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const artifact = (name = 'Config_Lite', requires: { name: string; version: string }[] = []): PearArtifact => { const content = '<?php\n// reviewed ' + name + '\n'; return { name, version: '1.0.0', source: 'https://pear.php.net/get/' + name + '-1.0.0.tgz', archiveSha256: 'c'.repeat(64), summary: 'Reviewed library', requires, files: [{ path: name + '.php', content, sha256: sha(content) }] } }
const catalog = (...packages: PearArtifact[]) => { const payload = JSON.stringify({ schema: 1, channel: 'pear.php.net', packages }); return verifyPearCatalog(payload, sha(payload)) }
function memory() {
  let tick = 0, lost = '', persistent = '', foreign = false, stopped = false
  const directories = new Set(['']), documents = new Map<string, FileText>(), modes = new Map<string, number>()
  const put = (path: string, content: string): FileText => { const file = { path, content, sizeBytes: Buffer.byteLength(content), mtime: new Date(++tick * 1000).toISOString() }; documents.set(path, file); return file }
  const entry = (path: string, kind: FileEntry['kind']): FileEntry => ({ path, name: path.split('/').at(-1)!, kind, mode: modes.get(path) ?? (kind === 'directory' ? 0o750 : 0o640), sizeBytes: documents.get(path)?.sizeBytes ?? 0, mtime: documents.get(path)?.mtime ?? new Date(0).toISOString() })
  const files: AccountPackageFiles = {
    list: vi.fn(async (parent: string) => { if (!directories.has(parent)) return fail('NOT_FOUND', 'missing directory'); const child = (path: string): boolean => path !== '' && path.split('/').slice(0, -1).join('/') === parent; return [...[...directories].filter(child).map(path => entry(path, 'directory')), ...[...documents.keys()].filter(child).map(path => entry(path, 'file'))] }),
    readText: vi.fn(async (path: string) => documents.has(path) ? { ...documents.get(path)! } : fail('NOT_FOUND', 'missing file')),
    mkdir: vi.fn(async (path: string, mode: number) => { if (directories.has(path) || documents.has(path)) return fail('CONFLICT', 'exists', { stateChanged: false }); directories.add(path); modes.set(path, mode); return entry(path, 'directory') }),
    writeTextChecked: vi.fn(async (path: string, content: string | null, expected: FileText | null, mode?: number) => {
      if (stopped || persistent === path) { stopped = true; throw new Error('worker unavailable') }
      if (JSON.stringify(documents.get(path) ?? null) !== JSON.stringify(expected)) return fail('CONFLICT', 'preimage changed', { stateChanged: false })
      if (content === null) documents.delete(path); else put(path, content)
      modes.set(path, mode ?? 0o640)
      if (lost === path) { lost = ''; if (foreign) put(path, '<?php // externally edited'); throw new Error('ack lost after write') }
      return content === null ? null : entry(path, 'file')
    }),
  }
  return { files, documents, directories, put, dropAck: (path: string, edited = false) => { lost = path; foreign = edited }, failPath: (path: string) => { persistent = path }, clearFailure: () => { persistent = ''; stopped = false } }
}
function setup(artifacts = [artifact()]) {
  const fs = memory(), verified = catalog(...artifacts), authorize = vi.fn(async () => undefined), admitMutation = vi.fn(async () => undefined)
  const run = (request: AccountPackageRequest, qualified = true) => runAccountPackageRequest({ account, files: fs.files, catalog: verified, request, authorize, ...(qualified ? { admitMutation } : {}) })
  return { ...fs, run, authorize, admitMutation, verified }
}
describe('private PEAR package catalog and transaction', () => {
  it('pins exact artifact bytes, channel, file digest, dependency graph and release source', () => {
    const good = artifact(), payload = JSON.stringify({ schema: 1, channel: 'pear.php.net', packages: [good] })
    expect(catalog(good).packages[0]!.name).toBe('Config_Lite'); expect(Object.isFrozen(catalog(good).packages[0]!.files)).toBe(true)
    expect(() => verifyPearCatalog(payload, '0'.repeat(64))).toThrow()
    for (const changed of [{ ...good, source: 'https://example.com/evil.tgz' }, { ...good, files: [{ ...good.files[0]!, path: '../outside.php' }] }, { ...good, files: [{ ...good.files[0]!, sha256: '0'.repeat(64) }] }, { ...good, requires: [{ name: good.name, version: good.version }] }]) expect(() => catalog(changed)).toThrow()
    expect(() => catalog(artifact('Feature', [{ name: 'Missing', version: '1.0.0' }]))).toThrow()
  })
  it('rejects request-selected account/path/source/artifact and malformed names before any writes', () => {
    expect(parseAccountPackageRequest('GET')).toEqual({ op: 'read' })
    for (const raw of [{ op: 'install', name: '../bad', expectedRevision: 'a'.repeat(64) }, { op: 'install', name: 'Config_Lite', expectedRevision: 'a'.repeat(64), source: 'https://example.com' }, { op: 'remove', name: 'Config_Lite', expectedRevision: 'bad' }, { op: 'recover', expectedRevision: 'a'.repeat(64), accountId: account.id }]) expect(() => parseAccountPackageRequest('POST', raw)).toThrow()
    expect(() => parseAccountPackageRequest('DELETE', {})).toThrow()
  })
  it('disables mutations with an unqualified provider and never fabricates inventory when files are unavailable', async () => {
    const t = setup(), read = await t.run({ op: 'read' }, false)
    expect(read.capabilities).toEqual({ install: false, remove: false, recover: false })
    await expect(t.run({ op: 'install', name: 'Config_Lite', expectedRevision: read.revision }, false)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } }); expect(t.files.writeTextChecked).not.toHaveBeenCalled()
    ;(t.files.list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('confined runner missing'))
    await expect(t.run({ op: 'read' })).rejects.toThrow('confined runner missing')
  })
  it('persists a preimage before package files, verifies installation and removes without touching system paths', async () => {
    const t = setup(), read = await t.run({ op: 'read' }), installed = await t.run({ op: 'install', name: 'Config_Lite', expectedRevision: read.revision })
    expect(installed.packages).toMatchObject([{ name: 'Config_Lite', version: '1.0.0' }]); expect(installed.recovery).toBe('committed'); expect(installed.revision).not.toBe(read.revision)
    expect(t.documents.get(LIBRARY + '/Config_Lite.php')?.content).toBe(artifact().files[0]!.content)
    const writes = (t.files.writeTextChecked as ReturnType<typeof vi.fn>).mock.calls
    expect(writes[0]![0]).toBe(TRANSACTION); expect(JSON.parse(writes[0]![1]).phase).toBe('prepared')
    expect(writes.every(call => String(call[0]).startsWith('.xpanel-packages/pear/'))).toBe(true)
    const removed = await t.run({ op: 'remove', name: 'Config_Lite', expectedRevision: installed.revision }); expect(removed.packages).toEqual([]); expect(t.documents.has(LIBRARY + '/Config_Lite.php')).toBe(false)
  })
  it('requires pinned dependencies and refuses removing a required package or overwriting unmanaged files', async () => {
    const base = artifact('Base'), dependent = artifact('Feature', [{ name: 'Base', version: '1.0.0' }]), t = setup([base, dependent]), read = await t.run({ op: 'read' })
    await expect(t.run({ op: 'install', name: 'Feature', expectedRevision: read.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    const first = await t.run({ op: 'install', name: 'Base', expectedRevision: read.revision }), second = await t.run({ op: 'install', name: 'Feature', expectedRevision: first.revision })
    await expect(t.run({ op: 'remove', name: 'Base', expectedRevision: second.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    const other = setup(), before = await other.run({ op: 'read' }); other.directories.add('.xpanel-packages'); other.directories.add('.xpanel-packages/pear'); other.directories.add(LIBRARY); other.put(LIBRARY + '/Config_Lite.php', '<?php // mine')
    await expect(other.run({ op: 'install', name: 'Config_Lite', expectedRevision: before.revision })).rejects.toMatchObject({ code: 'CONFLICT' }); expect(other.documents.get(LIBRARY + '/Config_Lite.php')!.content).toBe('<?php // mine')
  })
  it('restores the exact content preimage after a lost native acknowledgement, recording verified rollback', async () => {
    const t = setup(), read = await t.run({ op: 'read' }); t.dropAck(LIBRARY + '/Config_Lite.php')
    await expect(t.run({ op: 'install', name: 'Config_Lite', expectedRevision: read.revision })).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', detail: { rollbackVerified: true } })
    expect(t.documents.has(LIBRARY + '/Config_Lite.php')).toBe(false); expect(t.documents.has(REGISTRY)).toBe(false); expect(JSON.parse(t.documents.get(TRANSACTION)!.content).phase).toBe('rolled-back')
    expect((await t.run({ op: 'read' })).packages).toEqual([])
  })
  it('keeps failed partial work recovery-required and recovers only the saved namespace preimages', async () => {
    const t = setup(), read = await t.run({ op: 'read' }); t.failPath(REGISTRY)
    await expect(t.run({ op: 'install', name: 'Config_Lite', expectedRevision: read.revision })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { verificationRequired: true } })
    const pending = await t.run({ op: 'read' }); expect(pending.inventory).toBe('recovery-required'); expect(pending.capabilities).toEqual({ install: false, remove: false, recover: true })
    t.clearFailure(); const restored = await t.run({ op: 'recover', expectedRevision: pending.revision }); expect(restored.inventory).toBe('verified'); expect(restored.packages).toEqual([]); expect(t.documents.has(LIBRARY + '/Config_Lite.php')).toBe(false)
  })
  it('refuses recovery over externally changed contents and reports digest drift as unavailable', async () => {
    const t = setup(), read = await t.run({ op: 'read' }); t.dropAck(LIBRARY + '/Config_Lite.php', true)
    await expect(t.run({ op: 'install', name: 'Config_Lite', expectedRevision: read.revision })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    const pending = await t.run({ op: 'read' }); await expect(t.run({ op: 'recover', expectedRevision: pending.revision })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' }); expect(t.documents.get(LIBRARY + '/Config_Lite.php')!.content).toContain('externally edited')
    const other = setup(), initial = await other.run({ op: 'read' }); await other.run({ op: 'install', name: 'Config_Lite', expectedRevision: initial.revision }); other.put(LIBRARY + '/Config_Lite.php', '<?php // changed')
    await expect(other.run({ op: 'read' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('requires fresh current owner and feature authorization under the account lifecycle lease', async () => {
    const t = setup(), principal = { kind: 'user', id: 'principal', accountId: account.id, username: 'alice', disabled: false }; let disabled: string[] = [], leases = 0
    const deps: AccountPackageRouteDeps = { caller: { role: 'user', actor: 'user:alice', principalId: 'principal', accountId: account.id, resellerId: null }, store: { getAccountByUsername: async () => account, getPlan: async () => ({ id: 'plan', featureListId: 'features' }) as Plan, getFeatureList: async () => ({ id: 'features', name: 'features', ownerId: null, disabled }), withAccountLifecycleLease: async (_id, action) => { leases++; return action(account) } }, currentPrincipal: async () => principal, files: () => t.files, catalog: null, audit: vi.fn(async () => undefined) }
    const url = new URL('http://agent/accounts/alice/packages'), route = () => handleAccountPackagesRoute(new Request(url), url, 'GET', deps)
    expect((await route())!.status).toBe(200); expect(leases).toBe(1)
    for (const id of ['php-pear-packages', 'modules-php-pear']) { disabled = [id]; await expect(route()).rejects.toMatchObject({ code: 'FORBIDDEN' }) }
    disabled = []; principal.disabled = true; await expect(route()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(t.files.writeTextChecked).not.toHaveBeenCalled()
  })
  it('rechecks authority after an awaited admission before writing even the recovery snapshot', async () => {
    const t = setup(), read = await t.run({ op: 'read' }); let revoked = false
    t.admitMutation.mockImplementation(async () => { revoked = true })
    t.authorize.mockImplementation(async () => { if (revoked) return fail('FORBIDDEN', 'revoked during qualification', { stateChanged: false }) })
    await expect(t.run({ op: 'install', name: 'Config_Lite', expectedRevision: read.revision })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(t.files.writeTextChecked).not.toHaveBeenCalled(); expect(t.files.mkdir).not.toHaveBeenCalled()
  })
})
