import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Account, PhpSettings } from '@xpanel/core'
import { createResellerPrincipal, createRootPrincipal, createTestDb, createUserPrincipal, listAudit, setPrincipalDisabled } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { hashPasswordArgon2id } from '../auth.ts'
import { createApiApp } from '../server.ts'
import { runCliApi, socketTransport, type CliCall } from './client.ts'
import { CLI_API_FEATURE } from './identity.ts'
import { listenCliApiSocket } from './socket.ts'

const SECRET = 'test-only-cli-api-security-secret-at-least-32-bytes'
const INGRESS = 'test-only-cli-api-ingress-secret-at-least-32-bytes'
const PANEL = 'https://panel.cli.example.test:2083'
const WHM = 'https://whm.cli.example.test:2087'
const php: PhpSettings = {
  version: '8.3', handler: 'fpm', ini: {},
  fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 },
}
const socketPath = (name: string): string =>
  process.platform === 'win32' ? `\\\\.\\pipe\\xpanel-${name}-${randomUUID()}` : join(tmpdir(), `xpanel-${name}-${randomUUID()}.sock`)

describe('xuapi / xwhmapi act as the kernel-named caller through the panel authorization', { tags: ['feature'] }, () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle
  let alice: Account
  let bob: Account
  let alicePrincipalId: string
  let featureListId: string
  let peerUid = 0
  const sockets: { close: () => Promise<void> }[] = []
  const paths = { xuapi: socketPath('xuapi'), xwhmapi: socketPath('xwhmapi') }

  beforeAll(async () => {
    db = await createTestDb()
    state = await createTestStateStore()
    const passwordHash = await hashPasswordArgon2id('CliApiFixturePassword!2026')
    await createRootPrincipal(db.db, { username: 'root', passwordHash, forcePasswordChange: false })
    for (const [username, acl] of [['resellerone', ['list-accounts', 'manage-feature-lists']], ['resellertwo', []]] as const) {
      const reseller = await state.store.createReseller({
        username, passwordHash, acl: [...acl], maxAccounts: 10, totalDiskMb: 50000, totalBandwidthMb: 500000,
        oversell: false, nameservers: [], delegatedIps: [],
      })
      await createResellerPrincipal(db.db, { id: reseller.id, username, passwordHash })
    }
    const resellerOne = (await state.store.listResellers()).find(reseller => reseller.username === 'resellerone')!
    featureListId = (await state.store.createFeatureList({ name: 'CLI features', ownerId: null, disabled: [] })).id
    const plan = await state.store.createPlan({
      name: 'CLI plan', ownerId: null, featureListId,
      resources: { diskMb: 5000, bandwidthMbMonth: 50000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
      caps: { addonDomains: 10, aliasDomains: 10, subdomains: 10, mailboxes: 10, forwarders: 10, mailingLists: 10, ftpAccounts: 10, databases: 10, phpWorkers: 8 },
      dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 250,
    })
    await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const account = (username: string, ownerId: string | null) => state.store.createAccount({
      username, passwordHash, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId,
      contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.10', shell: 'jailed', php,
    })
    alice = await account('alice', resellerOne.id)
    bob = await account('bobby', null)
    alicePrincipalId = (await createUserPrincipal(db.db, { username: alice.username, accountId: alice.id, passwordHash })).id
    await createUserPrincipal(db.db, { username: bob.username, accountId: bob.id, passwordHash })
    const app = (entryPoint: 'xpanel' | 'xwhm', origin: string) => createApiApp({
      db: db.db, store: state.store, serverSecret: SECRET, entryPoint, publicOrigin: origin, allowedOrigins: [origin],
      ingressSecret: INGRESS, requireSecureCookies: true, requireOriginHeader: true,
    })
    sockets.push(await listenCliApiSocket(app('xpanel', PANEL), { socketPath: paths.xuapi, origin: PANEL, peerUid: () => peerUid }))
    sockets.push(await listenCliApiSocket(app('xwhm', WHM), { socketPath: paths.xwhmapi, origin: WHM, peerUid: () => peerUid }))
  })

  afterAll(async () => {
    for (const socket of sockets) await socket.close()
    await state?.close()
    await db?.close()
  })

  /** Runs the real client over the socket as kernel UID `uid`. */
  const run = async (uid: number, command: 'xuapi' | 'xwhmapi', ...argv: string[]): Promise<{ code: number; status: number; body: any }> => {
    peerUid = uid
    let stdout = ''
    const code = await runCliApi(command, argv, { stdout: text => { stdout += String(text) }, stderr: () => undefined, readStdin: () => '' }, socketTransport(paths[command]))
    const parsed = stdout ? JSON.parse(stdout) as { status: number; data?: unknown; error?: unknown } : { status: 0 }
    return { code, status: parsed.status, body: parsed.data ?? parsed.error }
  }
  const usernames = (body: { accounts: Account[] }): string[] => body.accounts.map(account => account.username).sort()

  it('lets a hosting account act only as itself', async () => {
    const me = await run(alice.uid, 'xuapi', 'auth', 'me')
    expect(me).toMatchObject({ code: 0, status: 200 })
    expect(me.body.principal).toMatchObject({ kind: 'user', username: 'alice', accountId: alice.id })
    expect(usernames((await run(alice.uid, 'xuapi', 'accounts', 'list')).body)).toEqual(['alice'])
    expect(await run(alice.uid, 'xuapi', 'accounts', 'get', `id=${alice.id}`)).toMatchObject({ code: 0, status: 200 })
    const foreign = await run(alice.uid, 'xuapi', 'accounts', 'get', `id=${bob.id}`)
    expect(foreign.code).toBe(2)
    expect([403, 404]).toContain(foreign.status)
  })

  it('keeps the kernel peer when a route re-checks the caller on a copy of the request', async () => {
    // The file route authenticates again after reading the body; without a host agent it then stops at 412.
    expect(await run(alice.uid, 'xuapi', 'POST', '/api/accounts/alice/files', 'op=list')).toMatchObject({ code: 2, status: 412 })
    expect(await run(0, 'xuapi', '--user=alice', 'POST', '/api/accounts/alice/files', 'op=list')).toMatchObject({ code: 2, status: 412 })
    const foreign = await run(alice.uid, 'xuapi', 'POST', '/api/accounts/bobby/files', 'op=list')
    expect([403, 404]).toContain(foreign.status)
  })

  it('re-checks the kernel peer, not a session, when an account retires its own mailbox', async () => {
    const mailbox = (account: Account) => state.store.createServiceUser({ accountId: account.id, login: `retire@${account.primaryDomain}`,
      passwordHash: '{SHA512-CRYPT}$6$clifixture$abcdefghijklmnopqrstuvwxyz0123456789', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
    const own = await mailbox(alice), other = await mailbox(bob)
    expect([403, 404]).toContain((await run(alice.uid, 'xuapi', 'DELETE', `/api/service-users/${other.id}`)).status)
    // Admission passes as alice; without a host agent the native deletion then stays unverified.
    expect(await run(alice.uid, 'xuapi', 'DELETE', `/api/service-users/${own.id}`))
      .toMatchObject({ code: 2, status: 412, body: { details: { reason: 'mailbox_retirement_native_unverified' } } })
    expect(await db.db.query<{ actor: string }>("SELECT actor FROM jobs WHERE kind='mailbox.retire'")).toEqual([{ actor: 'user:alice' }])
  })

  it('refuses every attempt of an account to raise its privileges', async () => {
    expect(await run(alice.uid, 'xuapi', '--user=bobby', 'accounts', 'list')).toMatchObject({ code: 2, status: 403 })
    const asReseller: CliCall = { command: 'xuapi', actAs: { kind: 'reseller', name: 'resellerone' }, method: 'GET', path: '/api/accounts', body: null }
    peerUid = alice.uid
    expect((await socketTransport(paths.xuapi)(asReseller)).status).toBe(403)
    expect(await run(alice.uid, 'xwhmapi', 'accounts', 'list')).toMatchObject({ code: 2, status: 403 })
    expect(await run(54321, 'xuapi', 'auth', 'me')).toMatchObject({ code: 2, status: 401 })
  })

  it('limits root acting with --user to that account', async () => {
    expect(await run(0, 'xuapi', 'accounts', 'list')).toMatchObject({ code: 2, status: 403 })
    expect(usernames((await run(0, 'xuapi', '--user=alice', 'accounts', 'list')).body)).toEqual(['alice'])
    expect(usernames((await run(0, 'xwhmapi', 'accounts', 'list')).body)).toEqual(['alice', 'bobby'])
    expect((await run(0, 'xuapi', '--user=alice', 'auth', 'me')).body.principal).toMatchObject({ kind: 'user', username: 'alice' })
    const foreign = await run(0, 'xuapi', '--user=alice', 'accounts', 'get', `id=${bob.id}`)
    expect([403, 404]).toContain(foreign.status)
    // Like a WHM handoff, root acting as the account cannot change its sign-in identity.
    const preferences = await run(0, 'xuapi', '--user=alice', 'preferences', 'update', 'contactEmail=root@example.test')
    expect(preferences).toMatchObject({ code: 2, status: 403 })
    expect(preferences.body.detail).toMatch(/cannot change the sign-in identity/)
  })

  it('refuses every call when the plan disables the feature, the account is suspended or the principal is disabled', async () => {
    await state.store.updateFeatureList(featureListId, { disabled: [CLI_API_FEATURE] })
    try {
      expect(await run(alice.uid, 'xuapi', 'auth', 'me')).toMatchObject({ code: 2, status: 403 })
      expect(await run(0, 'xuapi', '--user=alice', 'auth', 'me')).toMatchObject({ code: 2, status: 403 })
    } finally { await state.store.updateFeatureList(featureListId, { disabled: [] }) }
    await state.store.suspendAccount(alice.id, 'command-line API test')
    try {
      expect(await run(alice.uid, 'xuapi', 'accounts', 'list')).toMatchObject({ code: 2, status: 403 })
    } finally { await state.store.unsuspendAccount(alice.id) }
    await setPrincipalDisabled(db.db, alicePrincipalId, true)
    try {
      expect(await run(alice.uid, 'xuapi', 'auth', 'me')).toMatchObject({ code: 2, status: 401 })
    } finally { await setPrincipalDisabled(db.db, alicePrincipalId, false) }
    expect(await run(alice.uid, 'xuapi', 'auth', 'me')).toMatchObject({ code: 0, status: 200 })
  })

  it('limits root acting as a reseller to its ACL and own accounts, and audits both identities', async () => {
    expect(usernames((await run(0, 'xwhmapi', '--reseller=resellerone', 'accounts', 'list')).body)).toEqual(['alice'])
    expect(await run(0, 'xwhmapi', '--reseller=resellertwo', 'feature-lists', 'create', 'name=Refused', 'disabled:=[]')).toMatchObject({ code: 2, status: 403 })
    const created = await run(0, 'xwhmapi', '--reseller=resellerone', 'feature-lists', 'create', 'name=Reseller CLI list', 'disabled:=[]')
    expect(created).toMatchObject({ code: 0, status: 201 })
    const audit = (await listAudit(db.db, { limit: 50 })).find(entry => entry.action === 'feature_list.created' && entry.target === `feature-list:${created.body.featureList.id}`)
    expect(audit).toMatchObject({ actor: 'resellerone', detail: { impersonator: { login: 'root via xwhmapi' } } })
  })

  it('accepts no credentials, no sign-in and no page on the socket, and the public listener still refuses tokens', async () => {
    const raw = (path: string, headers: Record<string, string>, method = 'GET') => new Promise<number>((resolve, reject) => {
      peerUid = alice.uid
      const req = httpRequest({ socketPath: paths.xuapi, agent: false, method, path, headers }, res => { res.resume(); resolve(res.statusCode ?? 0) })
      req.once('error', reject)
      req.end()
    })
    expect(await raw('/api/auth/me', { cookie: 'xpanel_session=forged' })).toBe(403)
    expect(await raw('/api/auth/me', { authorization: 'Bearer xp_forged' })).toBe(403)
    expect(await raw('/panel', {})).toBe(404)
    expect(await raw('/api/auth/login', {}, 'POST')).toBe(404)
    expect(await raw('/api/auth/me', { 'x-xpanel-act-as': 'root' })).toBe(422)
    const panel = createApiApp({ db: db.db, store: state.store, serverSecret: SECRET, entryPoint: 'xpanel', publicOrigin: PANEL, allowedOrigins: [PANEL], ingressSecret: INGRESS, requireSecureCookies: true, requireOriginHeader: true })
    const bearer = await panel.fetch(new Request(`${PANEL}/api/auth/me`, { headers: { authorization: 'Bearer xp_anything', 'x-forwarded-proto': 'https', 'x-xpanel-ingress-secret': INGRESS } }), { remoteAddress: '127.0.0.1', trustedIngress: true })
    expect(bearer.status).toBe(401)
  })
})
