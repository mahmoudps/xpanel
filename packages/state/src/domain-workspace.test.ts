import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { domainWorkspaceRevision, fail, type Account, type Domain, type DomainWorkspaceTransition } from '@xpanel/core'
import { createTestStateStore, type TestStateStoreHandle } from './store.ts'
import type { DomainMutationGuard, DomainMutationOptions, NewDomain } from './types.ts'

const fixtures: TestStateStoreHandle[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const php = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } as const

const fixture = async () => {
  const handle = await createTestStateStore()
  fixtures.push(handle)
  const features = await handle.store.createFeatureList({ name: 'Domain policy', ownerId: null, disabled: [] })
  const plan = await handle.store.createPlan({
    name: 'Domain plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 },
    dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  await handle.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const makeAccount = (username: string) => handle.store.createAccount({
    username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null,
    contactEmail: 'Alice@example.test', ipv4: '192.0.2.10', shell: 'none', php,
  })
  const account = await makeAccount('domain9')
  const primary = (await handle.store.listDomains({ accountId: account.id })).find(row => row.kind === 'primary')!
  const input = (name: string, patch: Partial<NewDomain> = {}): NewDomain => ({
    accountId: account.id, name, kind: 'addon', parentId: null, docRoot: `${account.home}/domains/${name}/public_html`,
    siteType: 'php', upstream: null, redirect: null, php, wildcard: false, certificateId: null, suspended: false,
    expiresAt: null, pathQuotaMb: 'unlimited', ...patch,
  })
  const options = (revision: string, patch: Partial<DomainMutationGuard> = {}): DomainMutationOptions => ({
    domainGuard: { accountId: account.id, expectedRevision: revision, authorize: async () => {}, safeLeaf: true, ...patch },
  })
  const domainPath = (row: Domain) => join(handle.rootDir, 'accounts', account.username, 'domains', `${row.name}.json`)
  return { ...handle, account, primary, plan, input, options, domainPath, makeAccount }
}

const noncanonicalBytes = async (path: string): Promise<string> => {
  const raw = ' \n' + JSON.stringify(JSON.parse(await readFile(path, 'utf8')), null, 3) + '\r\n\n'
  await writeFile(path, raw)
  return raw
}

describe('guarded domain workspace state; isolated desired state and projection callbacks', () => {
  it('reads a coherent owner-only source and raw core representation without exposing credentials', async () => {
    const f = await fixture()
    const foreign = await f.makeAccount('foreign9')
    const view = await f.store.readDomainWorkspace(f.account.id)
    expect(view.revision).toBe(domainWorkspaceRevision(view.source))
    expect(view.source.account).toEqual(f.account)
    expect(view.source.account).not.toHaveProperty('passwordHash')
    expect(view.source.plan.id).toBe(f.plan.id)
    expect(view.source.domains.map(row => row.id)).toContain(f.primary.id)
    expect(view.source.domains.every(row => row.accountId === f.account.id)).toBe(true)
    expect(view.source.domains.some(row => row.accountId === foreign.id)).toBe(false)
    expect(view.source.dependencies.find(row => row.domainId === f.primary.id)).toMatchObject({ childCount: 0, serviceUserCount: 0 })
  })

  it('creates with trusted authorization and a same-account projection before acknowledging commit', async () => {
    const f = await fixture(), view = await f.store.readDomainWorkspace(f.account.id)
    const authorize = vi.fn(async () => {})
    let transition: DomainWorkspaceTransition | undefined
    let applied = false, committed = false
    const created = await f.store.createDomain(f.input('created.example.test'), f.options(view.revision, {
      authorize,
      prepareProjection: async value => {
        transition = value
        return { apply: async () => { applied = true }, rollback: async () => { applied = false } }
      },
      onCommitted: () => { expect(applied).toBe(true); committed = true },
    }))
    expect(authorize).toHaveBeenCalledWith(f.account, null)
    expect(transition?.before).toEqual([])
    expect(transition?.after).toEqual([created])
    expect(transition?.affectedIds).toEqual([created.id])
    expect(transition?.account.id).toBe(f.account.id)
    expect(committed).toBe(true)
    expect((await f.store.readDomainWorkspace(f.account.id)).source.domains).toContainEqual(created)
  })

  it('reauthorizes fresh account state while queued before stale-CAS or projection effects', async () => {
    const f = await fixture(), view = await f.store.readDomainWorkspace(f.account.id)
    const raw = await readFile(f.domainPath(f.primary))
    const authorize = vi.fn(async (current: Account) => {
      expect(current.status).toBe('suspended')
      fail('FORBIDDEN', 'synthetic queued policy revocation')
    })
    const prepareProjection = vi.fn(async () => ({ apply: async () => {}, rollback: async () => {} }))
    const lease = await f.store.getWriterLock().acquire()
    let suspended: ReturnType<typeof f.store.suspendAccount>
    let pending: Promise<{ error: unknown }>
    try {
      suspended = f.store.suspendAccount(f.account.id, 'synthetic queued suspension')
      pending = f.store.updateDomain(f.primary.id, { docRoot: `${f.account.home}/changed` }, f.options(view.revision, { authorize, prepareProjection }))
        .then(() => ({ error: null }), error => ({ error }))
      expect(authorize).not.toHaveBeenCalled()
    } finally { await lease.release() }
    await suspended!
    expect((await pending!).error).toMatchObject({ code: 'FORBIDDEN' })
    expect(authorize).toHaveBeenCalledOnce()
    expect(prepareProjection).not.toHaveBeenCalled()
    expect(await readFile(f.domainPath(f.primary))).toEqual(raw)
  })

  it('rejects stale representation before preparing a projection or creating another record', async () => {
    const f = await fixture(), stale = await f.store.readDomainWorkspace(f.account.id)
    await f.store.createDomain(f.input('first.example.test'))
    const authorize = vi.fn(async () => {})
    const prepareProjection = vi.fn(async () => ({ apply: async () => {}, rollback: async () => {} }))
    await expect(f.store.createDomain(f.input('stale.example.test'), f.options(stale.revision, { authorize, prepareProjection })))
      .rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(authorize).toHaveBeenCalledWith(f.account, null)
    expect(prepareProjection).not.toHaveBeenCalled()
    expect(await f.store.getDomainByName('stale.example.test')).toBeNull()
  })

  it('updates an owned parent and alias together in the prospective projection and readback', async () => {
    const f = await fixture()
    const parentView = await f.store.readDomainWorkspace(f.account.id)
    const alias = await f.store.createDomain(f.input('alias.example.test', {
      kind: 'alias', parentId: f.primary.id, docRoot: f.primary.docRoot,
      siteType: 'proxy', upstream: 'http://127.0.0.1:3000', redirect: { to: 'https://stale.example.test/', code: 302 },
      php: { ...php, fpm: { ...php.fpm, maxChildren: 1 } },
    }), f.options(parentView.revision))
    expect({ siteType: alias.siteType, upstream: alias.upstream, redirect: alias.redirect, php: alias.php })
      .toEqual({ siteType: f.primary.siteType, upstream: f.primary.upstream, redirect: f.primary.redirect, php: f.primary.php })
    const view = await f.store.readDomainWorkspace(f.account.id)
    let transition: DomainWorkspaceTransition | undefined
    let applied = false
    const root = `${f.account.home}/new-root`
    await f.store.updateDomain(f.primary.id, { docRoot: root }, f.options(view.revision, {
      prepareProjection: async value => {
        transition = value
        return { apply: async () => { applied = true }, rollback: async () => { applied = false } }
      },
    }))
    expect(applied).toBe(true)
    expect(transition?.affectedIds).toEqual(expect.arrayContaining([f.primary.id, alias.id]))
    expect(transition?.affectedIds).toHaveLength(2)
    expect(transition?.before.every(row => row.accountId === f.account.id)).toBe(true)
    expect(transition?.after.every(row => row.accountId === f.account.id && row.docRoot === root)).toBe(true)
    const after = await f.store.readDomainWorkspace(f.account.id)
    expect(after.source.domains.find(row => row.id === f.primary.id)?.docRoot).toBe(root)
    expect(after.source.domains.find(row => row.id === alias.id)?.docRoot).toBe(root)
  })

  it('rejects a legacy foreign incoming alias without touching either tenant file', async () => {
    const f = await fixture()
    const leaf = await f.store.createDomain(f.input('leaf.example.test'))
    const foreign = await f.makeAccount('foreign9')
    const foreignPrimary = (await f.store.listDomains({ accountId: foreign.id }))[0]!
    const view = await f.store.readDomainWorkspace(f.account.id)
    const foreignPath = join(f.rootDir, 'accounts', foreign.username, 'domains', `${foreignPrimary.name}.json`)
    await writeFile(foreignPath, JSON.stringify({ ...foreignPrimary, kind: 'alias', parentId: leaf.id }))
    const ownRaw = await readFile(f.domainPath(leaf)), foreignRaw = await readFile(foreignPath)
    const authorize = vi.fn(async () => {})
    const prepareProjection = vi.fn(async () => ({ apply: async () => {}, rollback: async () => {} }))
    await expect(f.store.updateDomain(leaf.id, { docRoot: `${f.account.home}/changed` }, f.options(view.revision, { authorize, prepareProjection })))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'domain_graph_invalid', stateChanged: false } })
    expect(authorize).toHaveBeenCalledOnce()
    expect(prepareProjection).not.toHaveBeenCalled()
    expect(await readFile(f.domainPath(leaf))).toEqual(ownRaw)
    expect(await readFile(foreignPath)).toEqual(foreignRaw)
  })

  it.each(['child', 'service-user'] as const)('refuses safe leaf removal with a %s dependency before effects', async dependency => {
    const f = await fixture()
    const leaf = await f.store.createDomain(f.input('leaf.example.test'))
    if (dependency === 'child') {
      await f.store.createDomain(f.input('child.leaf.example.test', { kind: 'subdomain', parentId: leaf.id }))
    } else {
      await f.store.createServiceUser({ accountId: f.account.id, login: 'mail@leaf.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 10, ftpDir: 'public_html', passwordHash: '{ARGON2ID}abc' })
    }
    const view = await f.store.readDomainWorkspace(f.account.id)
    const counts = view.source.dependencies.find(row => row.domainId === leaf.id)
    expect(counts?.childCount).toBe(dependency === 'child' ? 1 : 0)
    expect(counts?.serviceUserCount).toBe(dependency === 'service-user' ? 1 : 0)
    const raw = await readFile(f.domainPath(leaf))
    const prepareProjection = vi.fn(async () => ({ apply: async () => {}, rollback: async () => {} }))
    await expect(f.store.deleteDomain(leaf.id, f.options(view.revision, { prepareProjection })))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(prepareProjection).not.toHaveBeenCalled()
    expect(await readFile(f.domainPath(leaf))).toEqual(raw)
  })

  it('keeps primary removal within the account lifecycle', async () => {
    const f = await fixture(), view = await f.store.readDomainWorkspace(f.account.id)
    const raw = await readFile(f.domainPath(f.primary))
    await expect(f.store.deleteDomain(f.primary.id, f.options(view.revision))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await readFile(f.domainPath(f.primary))).toEqual(raw)
  })

  it('removes an authorized nonprimary leaf and returns coherent absence without deleting its neighbor', async () => {
    const f = await fixture()
    const leaf = await f.store.createDomain(f.input('leaf.example.test'))
    const view = await f.store.readDomainWorkspace(f.account.id)
    const neighbor = await readFile(f.domainPath(f.primary))
    expect(await f.store.deleteDomain(leaf.id, f.options(view.revision))).toBe(true)
    const after = await f.store.readDomainWorkspace(f.account.id)
    expect(after.source.domains.some(row => row.id === leaf.id)).toBe(false)
    expect(after.revision).not.toBe(view.revision)
    expect(await readFile(f.domainPath(f.primary))).toEqual(neighbor)
    await expect(readFile(f.domainPath(leaf))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores exact parent/alias bytes and the prepared projection after a fanout apply failure', async () => {
    const f = await fixture()
    const alias = await f.store.createDomain(f.input('alias.example.test', { kind: 'alias', parentId: f.primary.id, docRoot: f.primary.docRoot }))
    const rootRaw = await noncanonicalBytes(f.domainPath(f.primary)), aliasRaw = await noncanonicalBytes(f.domainPath(alias))
    const view = await f.store.readDomainWorkspace(f.account.id)
    const original = structuredClone(view.source.domains)
    let projected = structuredClone(original), rollback = 0
    await expect(f.store.updateDomain(f.primary.id, { docRoot: `${f.account.home}/changed` }, f.options(view.revision, {
      prepareProjection: async transition => ({
        apply: async () => { projected = [...transition.after]; throw new Error('synthetic fanout projection failure') },
        rollback: async () => { rollback++; projected = structuredClone(original) },
      }),
    }))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false, verificationRequired: true } })
    expect(rollback).toBe(1)
    expect(projected).toEqual(original)
    expect(await readFile(f.domainPath(f.primary), 'utf8')).toBe(rootRaw)
    expect(await readFile(f.domainPath(alias), 'utf8')).toBe(aliasRaw)
    await expect(readFile(f.store.getWriterLock().intentFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores exact owned userdata and domain bytes when leaf removal projection fails', async () => {
    const f = await fixture()
    const leaf = await f.store.createDomain(f.input('leaf.example.test'))
    const path = join(f.rootDir, 'accounts', f.account.username, 'userdata', `${leaf.id}.json`)
    await mkdir(dirname(path), { recursive: true })
    const userdata = ' ' + JSON.stringify({ domainId: leaf.id, accountId: f.account.id, domainName: leaf.name, nginxInclude: '', apacheInclude: '', userIni: {}, customHeaders: {}, cacheBypassPaths: [], updatedAt: '2026-10-26T00:00:00.000Z', updatedBy: 'user' }, null, 4) + '\n\n'
    await writeFile(path, userdata)
    const domainRaw = await noncanonicalBytes(f.domainPath(leaf))
    const view = await f.store.readDomainWorkspace(f.account.id)
    expect(view.source.managedConfigDigests[leaf.id]).toMatch(/^[0-9a-f]{64}$/)
    let present = true
    await expect(f.store.deleteDomain(leaf.id, f.options(view.revision, {
      prepareProjection: async () => ({
        apply: async () => { present = false; throw new Error('synthetic removal projection failure') },
        rollback: async () => { present = true },
      }),
    }))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false, verificationRequired: true } })
    expect(present).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(userdata)
    expect(await readFile(f.domainPath(leaf), 'utf8')).toBe(domainRaw)
    await expect(readFile(f.store.getWriterLock().intentFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains recovery intent and reports unknown state if prepared projection restoration fails', async () => {
    const f = await fixture(), view = await f.store.readDomainWorkspace(f.account.id)
    const raw = await readFile(f.domainPath(f.primary))
    await expect(f.store.updateDomain(f.primary.id, { docRoot: `${f.account.home}/changed` }, f.options(view.revision, {
      prepareProjection: async () => ({
        apply: async () => { throw new Error('synthetic projection apply failure') },
        rollback: async () => { throw new Error('synthetic projection rollback failure') },
      }),
    }))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    const intent = JSON.parse(await readFile(f.store.getWriterLock().intentFilePath, 'utf8')) as {
      backups: { relPath: string; existed: boolean; contentBase64: string }[]
    }
    const backup = intent.backups.find(row => row.relPath.endsWith(`/domains/${f.primary.name}.json`))
    expect(backup?.existed).toBe(true)
    expect(Buffer.from(backup!.contentBase64, 'base64')).toEqual(raw)
  })
})
