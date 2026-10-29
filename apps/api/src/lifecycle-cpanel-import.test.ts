import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestStateStore } from '@xpanel/state'
import { readCpanelArchive } from '@xpanel/lifecycle'
import { buildTar } from '../../../packages/lifecycle/src/testing/tar.ts'
import { cpmoveEntries } from '../../../packages/lifecycle/src/testing/cpanel-fixture.ts'
import { createCpanelImportPorts } from './lifecycle-cpanel-import.ts'
import type { CpanelImportRecord } from './transfer-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'

// Feature layer: the reviewed plan is the real parser's output for the public cpmove fixture; a real StateStore
// receives the account; the host restore task is synthetic.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const PHP = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } as const
const caller = { principal: { kind: 'root', id: randomUUID(), username: 'root' } } as unknown as AuthenticatedCaller
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

const reviewed = async (): Promise<CpanelImportRecord> => {
  const plan = await readCpanelArchive((async function* () { yield await buildTar(cpmoveEntries(), { gzip: true }) })(), { now: new Date('2027-01-01T00:00:00Z') })
  // what the host returns for review: no staging references
  const publicPlan = JSON.parse(JSON.stringify({ ...plan, databases: plan.databases.map(db => ({ sourceName: db.sourceName, name: db.name, bytes: db.sql.size })), certificates: plan.certificates.map(cert => ({ names: cert.names, notAfter: cert.notAfter, hasKey: cert.key !== null })) }))
  return { id: randomUUID(), origin: 'upload', filename: 'cpmove-bob.tar.gz', source: null, actor: 'r', createdAt: '', updatedAt: '', state: 'importing', task: null, targetUsername: null, bytes: 10, sha256: 'a'.repeat(64), plan: publicPlan, conflicts: [], unmapped: [], result: null, error: null }
}

const fixture = async (failRestore = false) => {
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const store = state.store
  const features = await store.createFeatureList({ name: 'default', ownerId: null, disabled: [] })
  const plan = await store.createPlan({ name: 'gold', ownerId: null, featureListId: features.id, dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 100,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 10, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 } })
  await store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  await store.saveServerSettings({ ...(await store.getServerSettings() ?? {}), nameservers: ['ns1.here.test', 'ns2.here.test'] } as never).catch(() => undefined)
  const tasks: Record<string, unknown>[] = [], removed: string[] = []
  const ports = createCpanelImportPorts({
    store, uploadDir: '/unused', maxBytes: 1024, pollMs: 0, defaultPhp: async () => PHP as never, serviceHash: async () => HASH,
    createAccount: async (_caller, input) => store.createAccount({ username: input.username, passwordHash: HASH, primaryDomain: input.primaryDomain, planId: input.planId, ownerId: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.10', shell: 'jailed', php: PHP as never }),
    applyAccount: async () => undefined,
    removeAccount: async (_caller, account) => { removed.push(account.username); await store.deleteAccount((await store.markTerminating(account.id)).id) },
    agent: async (_caller, path, init = {}) => {
      if (init.method === 'POST') { tasks.push(init.body as Record<string, unknown>); return Response.json({ task: { id: randomUUID() } }, { status: 202 }) }
      const body = tasks.at(-1)!
      return Response.json({ task: failRestore ? { state: 'failed', error: 'synthetic restore failure' } : { state: 'succeeded', result: { home: { compared: true }, databases: (body.databases as { target: string }[]).map(db => ({ name: db.target, tables: 1 })), certificates: [] } } })
    },
  })
  return { store, ports, tasks, removed, planId: plan.id }
}

describe('cPanel import apply', () => {
  it('builds the reviewed account with domains, databases, reset-required users and mailboxes, zones and paused cron, then restores its data', async () => {
    const f = await fixture(), record = await reviewed()
    const result = await f.ports.apply(caller, record, { planId: f.planId })
    const account = (await f.store.getAccountByUsername('bob'))!
    const snapshot = await f.store.readSnapshot()
    const domains = snapshot.domains.filter(domain => domain.accountId === account.id)
    expect(domains.find(domain => domain.name === 'bob.example')).toMatchObject({ kind: 'primary', docRoot: '/home/bob/public_html' })
    expect(domains.every(domain => domain.docRoot.startsWith('/home/bob/'))).toBe(true)
    expect(snapshot.databases.filter(db => db.accountId === account.id).map(db => db.name)).toEqual(expect.arrayContaining(['bob_wp']))
    expect(snapshot.databaseUsers.filter(user => user.accountId === account.id).every(user => /^\*[0-9A-F]{40}$/.test(user.authString))).toBe(true)
    expect(snapshot.serviceUsers.filter(user => user.accountId === account.id).length).toBeGreaterThan(0)
    expect(await f.store.listCronJobs(account.id)).toMatchObject([{ schedule: '* * * * *', command: '/home/bob/x.sh', enabled: false }])
    expect(f.tasks[0]).toMatchObject({ kind: 'cpanel-restore', username: 'bob', archive: record.id, sha256: 'a'.repeat(64), databases: expect.arrayContaining([{ sourceName: 'bob_wp', target: 'bob_wp' }]) })
    expect(result).toMatchObject({ username: 'bob', cronJobsPaused: 1, passwordResetRequired: true, home: { compared: true } })
  })
  it('removes the partial account when the host restore fails', async () => {
    const f = await fixture(true), record = await reviewed()
    await expect(f.ports.apply(caller, record, { planId: f.planId })).rejects.toThrow(/synthetic restore failure; the partial account was removed/)
    expect(f.removed).toEqual(['bob'])
    expect(await f.store.getAccountByUsername('bob')).toBeNull()
  })
})
