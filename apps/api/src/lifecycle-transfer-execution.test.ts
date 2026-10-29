import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestStateStore } from '@xpanel/state'
import { buildReview, createTransferSession, transition } from '@xpanel/lifecycle'
import type { TransferEvent } from '@xpanel/lifecycle'
import { createTransferExecution, renamePrefixed, transferZoneRecords } from './lifecycle-transfer-execution.ts'
import type { TransferExecutionDeps } from './lifecycle-transfer-execution.ts'
import { signTransferManifest } from './acct-transfer-source.ts'
import type { TransferAccountBundle } from './acct-transfer-source.ts'
import type { TransferSourceRequest } from './acct-transfer-discovery.ts'
import type { AuthenticatedCaller } from './auth.ts'

// Feature layer: a real StateStore receives the desired state; the source channel and the host agent are synthetic.
const TOKEN = 'xp_' + 'a'.repeat(43), TOKEN_ID = randomUUID(), PKG = '0f0f0f0f-0000-4000-8000-000000000001'
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const PHP = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } as const
const auth = { kind: 'api-token' as const, url: 'https://source.example.test', tokenId: TOKEN_ID, tlsFingerprint: null }
const caller = { principal: { kind: 'root', id: randomUUID(), username: 'root' } } as unknown as AuthenticatedCaller
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

const bundleOf = (username: string): TransferAccountBundle => ({
  account: { username, home: '/home/' + username, primaryDomain: username + '.example.test', contactEmail: 'owner@example.test', shell: 'jailed', ipv4: '203.0.113.5' },
  plan: { name: 'gold', resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 100 } as never,
  domains: [
    { name: username + '.example.test', kind: 'primary', parent: null, docRoot: '/home/' + username + '/public_html', siteType: 'php', upstream: null, redirect: null, php: { ...PHP, version: '8.2' } as never, wildcard: false },
    { name: 'blog.' + username + '.example.test', kind: 'subdomain', parent: username + '.example.test', docRoot: '/home/' + username + '/public_html/blog', siteType: 'php', upstream: null, redirect: null, php: { ...PHP, version: '5.6' } as never, wildcard: false },
  ],
  databases: [{ name: username + '_wp', artifact: 'db-' + username + '_wp.sql' }],
  databaseUsers: [{ name: username + '_wpuser', authPlugin: 'mysql_native_password', authString: '*' + 'A'.repeat(40), grants: [{ database: username + '_wp', privileges: ['SELECT', 'INSERT'] }] }],
  mailboxes: [{ login: 'info@' + username + '.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: HASH }],
  zones: [{ name: username + '.example.test', records: [{ name: '@', type: 'A', ttl: 300, content: '203.0.113.5', priority: null }, { name: '@', type: 'NS', ttl: 86400, content: 'ns1.source.example.', priority: null }, { name: '@', type: 'MX', ttl: 300, content: 'mail.' + username + '.example.test.', priority: 10 }] }],
  cron: [{ schedule: '@daily', command: 'php /home/' + username + '/public_html/cron.php', comment: 'nightly', enabled: true }],
  certificates: [{ names: [username + '.example.test'], cert: 'cert-0.pem', key: 'key-0.pem' }],
})
const artifacts = (username: string) => ['home.tar.gz', 'db-' + username + '_wp.sql', 'cert-0.pem', 'key-0.pem'].map(name => ({ name, bytes: 10, sha256: 'c'.repeat(64) }))
const signed = (username: string, token = TOKEN) => {
  const manifest = { source: 'source.example.test', username, package: PKG, createdAt: '2026-10-29T01:00:00.000Z', artifacts: artifacts(username), bundle: bundleOf(username) }
  return { state: 'ready', manifest, signature: signTransferManifest(token, manifest) }
}
const inventoryOf = (username: string) => ({ username, uid: 20001, primaryDomain: username + '.example.test', domains: [username + '.example.test', 'blog.' + username + '.example.test'], plan: 'gold', diskBytes: 100, databases: [username + '_wp'], mailboxes: 1, phpVersions: ['8.2', '5.6'] })
const sessionFor = (names: string[], local: { usernames: string[]; plans: string[] }, rename?: [string, string]) => {
  let s = createTransferSession({ id: randomUUID(), actor: 'root', now: '2026-10-29T00:00:00.000Z', auth })
  s = transition(s, { type: 'connected', source: { hostname: 'source.example.test', version: '1.0.0' } }, '2026-10-29T00:00:01.000Z')
  s = transition(s, { type: 'inventory', accounts: names.map(inventoryOf), plans: [{ name: 'gold' }] }, '2026-10-29T00:00:02.000Z')
  s = transition(s, { type: 'select', accounts: names, plans: local.plans.includes('gold') ? [] : ['gold'], local: { usernames: local.usernames, domains: [], uids: [], plans: local.plans } }, '2026-10-29T00:00:03.000Z')
  if (rename) s = transition(s, { type: 'resolve', conflictId: 'username:' + rename[0], resolution: { action: 'rename', to: rename[1] } }, '2026-10-29T00:00:04.000Z')
  s = transition(s, { type: 'review' }, '2026-10-29T00:00:05.000Z')
  return transition(s, { type: 'confirm', digest: s.reviewDigest! }, '2026-10-29T00:00:06.000Z')
}

const fixture = async (options: { withPlan?: boolean; failTask?: string; badSignature?: string; existing?: string[] } = {}) => {
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const store = state.store
  const features = await store.createFeatureList({ name: 'default', ownerId: null, disabled: [] })
  if (options.withPlan !== false) await store.createPlan({ ...bundleOf('x').plan, name: 'gold', ownerId: null, featureListId: features.id })
  await store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const calls: string[] = [], tasks = new Map<string, Record<string, unknown>>()
  let applied = 0
  const deps: TransferExecutionDeps = {
    store, readToken: async id => id === TOKEN_ID ? TOKEN : null, pollMs: 0, defaultPhp: async () => PHP as never,
    transport: async (input: TransferSourceRequest) => {
      calls.push((input.method ?? 'GET') + ' ' + input.url.replace('https://source.example.test', ''))
      const user = /accounts\/([a-z0-9]+)\/package/.exec(input.url)![1]!
      const body = input.method === 'POST' ? { package: PKG } : input.method === 'DELETE' ? { discarded: true } : signed(user, options.badSignature === user ? 'xp_' + 'z'.repeat(43) : TOKEN)
      return { status: input.method === 'POST' ? 202 : 200, contentType: 'application/json', body: JSON.stringify(body) }
    },
    agent: async (_caller, path, init = {}) => {
      if (path === '/transfers/tasks' && init.method === 'POST') {
        const body = init.body as Record<string, unknown>, id = randomUUID()
        calls.push('task ' + String(body.kind) + ' ' + JSON.stringify({ ...body, token: body.token ? '<token>' : undefined }))
        const failed = options.failTask === body.kind
        tasks.set(id, { id, kind: body.kind, state: failed ? 'failed' : 'succeeded', error: failed ? 'synthetic ' + String(body.kind) + ' failure' : null,
          result: body.kind === 'restore' ? { home: { compared: true }, databases: (body.databases as { target: string }[]).map(db => ({ name: db.target, tables: 3 })),
            certificates: (body.certificates as { domain: string }[]).map(cert => ({ id: randomUUID(), names: [cert.domain], certPath: '/var/lib/xpanel/certs/x/fullchain.pem', keyPath: '/var/lib/xpanel/certs/x/privkey.pem', notBefore: '2026-10-01T00:00:00.000Z', notAfter: '2027-10-01T00:00:00.000Z', fingerprintSha256: null, domain: cert.domain })) } : { artifacts: body.artifacts } })
        return Response.json({ task: { id } }, { status: 202 })
      }
      if (init.method === 'DELETE') { calls.push('discard task'); return Response.json({ discarded: true }) }
      return Response.json({ task: tasks.get(path.split('/').at(-1)!) })
    },
    createAccount: async (_caller, input) => store.createAccount({ username: input.username, passwordHash: HASH, primaryDomain: input.primaryDomain, planId: input.planId, ownerId: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.10', shell: 'jailed', php: PHP as never }),
    applyAccount: async () => { applied++ },
    removeAccount: async (_caller, account) => { calls.push('remove ' + account.username); await store.deleteAccount((await store.markTerminating(account.id)).id) },
    audit: async (_caller, action) => { calls.push('audit ' + action) },
  }
  const events: TransferEvent[] = [], results: Record<string, unknown> = {}
  const execution = createTransferExecution(deps)
  const run = async (s: ReturnType<typeof sessionFor>, stopAfter = Infinity) => {
    let done = 0
    await execution.run(caller, s, buildReview(s), async (event, result) => { events.push(event); if (result) results[event.account] = result; if (event.phase === 'done' || event.phase === 'failed') done++ }, async () => done >= stopAfter)
  }
  for (const name of options.existing ?? []) await deps.createAccount(caller, { username: name, primaryDomain: name + '.local.test', planId: (await store.listPlans())[0]!.id })
  return { store, calls, events, results, run, execution, applied: () => applied }
}

describe('server-to-server transfer execution', () => {
  it('rebuilds a renamed account with its domains, PHP, databases, users, mailboxes, zone, cron and certificate', async () => {
    const f = await fixture({ existing: ['alice'] })
    await f.run(sessionFor(['alice'], { usernames: ['alice'], plans: ['gold'] }, ['alice', 'alice2']))
    expect(f.events.map(event => event.type === 'progress' ? event.phase : event.type)).toEqual(['exporting', 'copying', 'importing', 'reconciling', 'done'])
    const account = (await f.store.getAccountByUsername('alice2'))!
    const domains = (await f.store.listDomains()).filter(domain => domain.accountId === account.id)
    expect(domains.map(domain => [domain.name, domain.docRoot, domain.php.version]).sort()).toEqual([['alice.example.test', '/home/alice2/public_html', '8.2'], ['blog.alice.example.test', '/home/alice2/public_html/blog', '8.3']])
    const snapshot = await f.store.readSnapshot()
    expect(snapshot.databases.filter(db => db.accountId === account.id).map(db => db.name)).toEqual(['alice2_wp'])
    expect(snapshot.databaseUsers.filter(user => user.accountId === account.id)).toMatchObject([{ name: 'alice2_wpuser', authString: '*' + 'A'.repeat(40), grants: [{ privileges: ['INSERT', 'SELECT'] }] }])
    expect(snapshot.serviceUsers.filter(user => user.accountId === account.id)).toMatchObject([{ login: 'info@alice.example.test', passwordHash: HASH }])
    const zone = (await f.store.getDnsZone('alice.example.test'))!
    expect(zone.records.map(record => [record.type, record.content])).toEqual(expect.arrayContaining([['A', '192.0.2.10'], ['MX', 'mail.alice.example.test.']]))
    expect((await f.store.listCronJobs(account.id))).toMatchObject([{ schedule: '@daily', command: 'php /home/alice2/public_html/cron.php', enabled: true }])
    expect(snapshot.certificates.filter(cert => cert.accountId === account.id)).toHaveLength(1)
    expect(f.calls).toEqual(expect.arrayContaining([
      'POST /api/transfers/source/accounts/alice/package', 'GET /api/transfers/source/accounts/alice/package/' + PKG,
      expect.stringMatching(/^task fetch .*"username":"alice2".*"token":"<token>"/),
      expect.stringMatching(/^task restore .*"databases":\[\{"artifact":"db-alice_wp.sql","target":"alice2_wp"\}\].*"domain":"alice.example.test"/),
      'DELETE /api/transfers/source/accounts/alice/package/' + PKG, 'audit transfer.account.imported']))
    expect(f.results.alice).toMatchObject({ domains: ['alice.example.test', 'blog.alice.example.test'], databases: ['alice2_wp'], mailboxes: 1, zones: ['alice.example.test'], cronJobs: 1, certificates: 1, rolledBack: false, home: { compared: true } })
    expect(f.applied()).toBe(2)
  })
  it('removes the partial account when the host restore fails and goes on with the next account', async () => {
    const f = await fixture({ failTask: 'restore' })
    await f.run(sessionFor(['alice', 'bob'], { usernames: [], plans: ['gold'] }))
    const failed = f.events.filter(event => event.type === 'progress' && event.phase === 'failed') as Extract<TransferEvent, { type: 'progress' }>[]
    expect(failed.map(event => event.account)).toEqual(['alice', 'bob'])
    expect(failed[0]!.error).toMatch(/synthetic restore failure\. The partial account was removed; nothing of it remains here\./)
    expect(f.calls).toEqual(expect.arrayContaining(['remove alice', 'remove bob', 'audit transfer.account.rolled_back', 'discard task']))
    expect(await f.store.getAccountByUsername('alice')).toBeNull()
    expect(f.results.alice).toEqual({ rolledBack: true, rollbackFailed: false })
  })
  it('never removes an existing account that only shares the target username', async () => {
    const f = await fixture({ existing: ['alice'] })
    const kept = (await f.store.getAccountByUsername('alice'))!
    // the account appeared after the review, so the review saw no conflict
    await f.run(sessionFor(['alice'], { usernames: [], plans: ['gold'] }))
    expect(f.events.at(-1)).toMatchObject({ phase: 'failed', error: expect.stringMatching(/already has an account named alice/) })
    expect(f.calls.some(call => call.startsWith('remove'))).toBe(false)
    expect((await f.store.getAccountByUsername('alice'))?.id).toBe(kept.id)
    // restart recovery removes only the identity this run recorded, never an account found by name
    expect(await f.execution.recover(caller, { targetUsername: 'alice' } as never, undefined)).toBe(false)
    expect((await f.store.getAccountByUsername('alice'))?.id).toBe(kept.id)
    expect(await f.execution.recover(caller, { targetUsername: 'alice' } as never, { createdAccountId: kept.id })).toBe(true)
  })
  it('changes nothing for an account whose package manifest is not signed with the stored token', async () => {
    const f = await fixture({ badSignature: 'alice' })
    await f.run(sessionFor(['alice'], { usernames: [], plans: ['gold'] }))
    const last = f.events.at(-1) as Extract<TransferEvent, { type: 'progress' }>
    expect(last).toMatchObject({ phase: 'failed', error: expect.stringMatching(/invalid or unsigned package manifest\. Nothing was changed here\./) })
    expect(f.calls.some(call => call.startsWith('remove') || call.startsWith('task'))).toBe(false)
    expect(await f.store.listAccounts()).toEqual([])
  })
  it('stops after the current account when asked and creates a reviewed source plan here', async () => {
    const f = await fixture({ withPlan: false })
    await f.run(sessionFor(['alice', 'bob'], { usernames: [], plans: [] }), 1)
    expect(f.events.filter(event => event.type === 'progress' && event.phase === 'done').map(event => (event as { account: string }).account)).toEqual(['alice'])
    expect(f.events.some(event => event.type === 'progress' && event.account === 'bob')).toBe(false)
    expect((await f.store.listPlans()).map(plan => plan.name)).toEqual(['gold'])
  })
  it('maps names and zone records for this server', () => {
    expect(renamePrefixed('alice_wp', 'alice', 'alice2')).toBe('alice2_wp')
    expect(() => renamePrefixed('other_wp', 'alice', 'bob')).toThrow(/account prefix/)
    expect(() => renamePrefixed('a_' + 'x'.repeat(62), 'a', 'abcdefgh')).toThrow(/name limit/)
    const records = transferZoneRecords('a.test', [{ name: '@', type: 'A', ttl: 60, content: '203.0.113.5', priority: null }, { name: '@', type: 'NS', ttl: 60, content: 'old.', priority: null }, { name: 'x', type: 'A', ttl: 60, content: '198.51.100.1', priority: null }], { from: '203.0.113.5', to: '192.0.2.10' }, ['ns1.here.test'])
    expect(records.map(record => [record.name, record.type, record.content])).toEqual([['@', 'A', '192.0.2.10'], ['x', 'A', '198.51.100.1'], ['@', 'NS', 'ns1.here.test.']])
  })
})
