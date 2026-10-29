import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { createTestStateStore, type TestStateStoreHandle } from './store.ts'
import type { NewCertificate } from './types.ts'

const handles: TestStateStoreHandle[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const handle of handles.splice(0)) await handle.close() })
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const php = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } as const
async function fixture() {
  const handle = await createTestStateStore(); handles.push(handle)
  const features = await handle.store.createFeatureList({ name: 'TLS policy', ownerId: null, disabled: [] })
  const plan = await handle.store.createPlan({ name: 'TLS plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await handle.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const makeAccount = (username: string) => handle.store.createAccount({ username, passwordHash: HASH, primaryDomain: username + '.example.test', planId: plan.id, ownerId: null, contactEmail: username + '@example.test', ipv4: '192.0.2.10', shell: 'none', php })
  const account = await makeAccount('tls9')
  const primary = (await handle.store.listDomains({ accountId: account.id }))[0]!
  const certificate = (patch: Partial<NewCertificate> = {}): NewCertificate => { const id = randomUUID(); return { id, accountId: account.id, names: [primary.name], source: 'upload', challenge: null, notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2028-01-01T00:00:00.000Z', autoRenew: false, certPath: '/etc/xpanel/ssl/' + id + '/fullchain.pem', keyPath: '/etc/xpanel/ssl/' + id + '/privkey.pem', fingerprintSha256: 'a'.repeat(64), ...patch } }
  const domainFile = join(handle.rootDir, 'accounts', account.username, 'domains', primary.name + '.json')
  const certFile = (id: string) => join(handle.rootDir, 'certificates', id + '.json')
  const addDomain = (name: string) => handle.store.createDomain({ accountId: account.id, name, kind: 'subdomain', parentId: primary.id,
    docRoot: account.home + '/domains/' + name + '/public_html', siteType: 'php', upstream: null, redirect: null, php, wildcard: false,
    certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' })
  return { ...handle, account, primary, certificate, domainFile, certFile, makeAccount, addDomain }
}

describe('journaled owned certificate binding state', () => {
  it('saves a certificate and its exact owned binding under one reviewed revision and trusted guard', async () => {
    const f = await fixture(), revision = await f.store.getRevision(), input = f.certificate({ names: [f.primary.name, 'www.' + f.primary.name] })
    const guard = vi.fn(async () => {})
    const saved = await f.store.saveCertificateBinding(input, f.primary.id, { expectedRevision: revision, certificateGuard: guard })
    expect(guard).toHaveBeenCalledOnce()
    expect(guard).toHaveBeenCalledWith(null, expect.arrayContaining([f.primary]))
    expect(await f.store.getCertificate(saved.id)).toEqual(saved)
    expect((await f.store.getDomain(f.primary.id))?.certificateId).toBe(saved.id)
    expect(await f.store.getRevision()).toBe(revision + 1)
  })
  it('refuses a foreign existing certificate identity, foreign SAN, and a wildcard deeper than one label', async () => {
    const f = await fixture(), foreign = await f.makeAccount('tlsforeign9'), foreignDomain = (await f.store.listDomains({ accountId: foreign.id }))[0]!
    const other = await f.store.createCertificate(f.certificate({ accountId: foreign.id, names: [foreignDomain.name] }))
    const original = await readFile(f.certFile(other.id))
    await expect(f.store.saveCertificateBinding(f.certificate({ id: other.id }), f.primary.id)).rejects.toMatchObject({ code: 'NOT_FOUND', detail: { stateChanged: false } })
    await expect(f.store.saveCertificateBinding(f.certificate({ names: [f.primary.name, foreignDomain.name] }), f.primary.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(f.store.saveCertificateBinding(f.certificate({ names: ['*.example.test'] }), f.primary.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const child = await f.addDomain('app.' + f.primary.name), deep = await f.addDomain('deep.app.' + f.primary.name)
    const wildcard = await f.store.saveCertificateBinding(f.certificate({ names: ['*.' + f.primary.name] }), child.id)
    expect((await f.store.getDomain(child.id))?.certificateId).toBe(wildcard.id)
    await expect(f.store.saveCertificateBinding(f.certificate({ names: ['*.' + f.primary.name] }), deep.id)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(await readFile(f.certFile(other.id))).toEqual(original)
    expect((await f.store.getDomain(f.primary.id))?.certificateId).toBeNull()
  })
  it('refuses a stale source revision before invoking its authorization guard or publishing files', async () => {
    const f = await fixture(), stale = await f.store.getRevision(), input = f.certificate()
    await f.store.createCertificate(f.certificate())
    const guard = vi.fn(async () => {})
    await expect(f.store.saveCertificateBinding(input, f.primary.id, { expectedRevision: stale, certificateGuard: guard })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(guard).not.toHaveBeenCalled(); expect(await f.store.getCertificate(input.id!)).toBeNull()
  })
  it('evaluates the trusted guard after a queued policy revocation and leaves both sources unchanged', async () => {
    const f = await fixture(), input = f.certificate(), before = await readFile(f.domainFile)
    const lease = await f.store.getWriterLock().acquire()
    let revoked = false
    const guard = vi.fn(async () => { if (revoked) fail('FORBIDDEN', 'synthetic policy was revoked') })
    let pending!: Promise<unknown>
    try {
      pending = f.store.saveCertificateBinding(input, f.primary.id, { certificateGuard: guard }).then(() => null, error => error)
      expect(guard).not.toHaveBeenCalled(); revoked = true
    } finally { await lease.release() }
    expect(await pending).toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(guard).toHaveBeenCalledOnce(); expect(await readFile(f.domainFile)).toEqual(before)
    expect(await f.store.getCertificate(input.id!)).toBeNull()
  })
  it('refuses installation after the account became suspended while queued', async () => {
    const f = await fixture(), input = f.certificate()
    const lease = await f.store.getWriterLock().acquire()
    let suspended!: Promise<unknown>, pending!: Promise<unknown>
    try {
      suspended = f.store.suspendAccount(f.account.id, 'synthetic suspension').then(() => null, error => error)
      pending = f.store.saveCertificateBinding(input, f.primary.id).then(() => null, error => error)
    } finally { await lease.release() }
    const [suspension, result] = await Promise.all([suspended, pending])
    expect(suspension).toBeNull()
    expect(result).toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(await f.store.getCertificate(input.id!)).toBeNull()
  })
  it('restores exact noncanonical domain bytes and removes the new certificate after a partial publication', async () => {
    const f = await fixture(), input = f.certificate()
    const before = ' \n' + JSON.stringify(JSON.parse(await readFile(f.domainFile, 'utf8')), null, 3) + '\r\n'
    await writeFile(f.domainFile, before)
    const revision = await f.store.getRevision()
    const target = f.store as unknown as { writeStateJson: (...args: unknown[]) => Promise<void> }
    const original = target.writeStateJson.bind(f.store)
    let writes = 0
    vi.spyOn(target, 'writeStateJson').mockImplementation(async (...args) => { await original(...args); if (++writes === 2) throw new Error('synthetic failure after domain publication') })
    await expect(f.store.saveCertificateBinding(input, f.primary.id)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false, verificationRequired: true } })
    expect(await readFile(f.domainFile, 'utf8')).toBe(before)
    expect(await f.store.getCertificate(input.id!)).toBeNull(); expect(await f.store.getRevision()).toBe(revision)
    await expect(readFile(f.store.getWriterLock().intentFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('preserves every existing SAN when replacing metadata for a previously bound certificate', async () => {
    const f = await fixture()
    const alias = await f.addDomain('app.' + f.primary.name)
    const first = await f.store.saveCertificateBinding(f.certificate({ names: [f.primary.name, alias.name] }), f.primary.id)
    await expect(f.store.saveCertificateBinding(f.certificate({ id: first.id, names: [f.primary.name] }), f.primary.id)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect((await f.store.getCertificate(first.id))?.names).toEqual([f.primary.name, alias.name])
  })
  it('removes all bindings together and recovers exact certificate/domain bytes if removal fails after unlink', async () => {
    const f = await fixture(), child = await f.addDomain('app.' + f.primary.name)
    const saved = await f.store.saveCertificateBinding(f.certificate({ names: [f.primary.name, child.name] }), f.primary.id)
    await f.store.updateDomain(child.id, { certificateId: saved.id })
    const childFile = join(f.rootDir, 'accounts', f.account.username, 'domains', child.name + '.json')
    const certBefore = await readFile(f.certFile(saved.id)), domainBefore = await readFile(f.domainFile), childBefore = await readFile(childFile), revision = await f.store.getRevision()
    const target = f.store as unknown as { removeStatePath: (...args: unknown[]) => Promise<boolean> }
    const original = target.removeStatePath.bind(f.store)
    const fault = vi.spyOn(target, 'removeStatePath').mockImplementation(async (...args) => { await original(...args); throw new Error('synthetic failure after certificate unlink') })
    await expect(f.store.deleteCertificate(saved.id, { expectedRevision: revision, certificateGuard: async current => { expect(current?.id).toBe(saved.id) } })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false, verificationRequired: true } })
    expect(await readFile(f.certFile(saved.id))).toEqual(certBefore); expect(await readFile(f.domainFile)).toEqual(domainBefore)
    expect(await readFile(childFile)).toEqual(childBefore)
    expect(await f.store.getRevision()).toBe(revision); fault.mockRestore()
    expect(await f.store.deleteCertificate(saved.id, { expectedRevision: revision })).toBe(true)
    expect(await f.store.getCertificate(saved.id)).toBeNull(); expect((await f.store.getDomain(f.primary.id))?.certificateId).toBeNull()
    expect((await f.store.getDomain(child.id))?.certificateId).toBeNull()
  })
})
