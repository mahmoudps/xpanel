import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import { createApiToken, createTestDb, createUserPrincipal } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { sha256Hex } from '../auth.ts'
import { createApiApp } from '../server.ts'
import type { MailboxTransport } from './inbox.ts'

const SECRET = 'mailbox-scope-synthetic-server-secret-32'
const ORIGIN = 'https://mail.example.test'
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SERVICE_HASH = '{SHA512-CRYPT}$6$mailboxfixture$abcdefghijklmnopqrstuvwxyz0123456789'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const transport: MailboxTransport = {
  async verify(mailbox, password) {
    if (mailbox !== 'inbox@alpha.example.test' || password !== 'alpha-secret') fail('UNAUTHENTICATED', 'imap rejected the password')
  },
  async list() { return [] },
  async read() { return fail('NOT_FOUND', 'message not found') },
  async remove() {},
  async move() { return { uid: 1 } },
  async send() { return { messageId: '<sent@alpha.example.test>' } },
}

describe('mailbox websocket scope', () => {
  it('fails closed when the mailbox session is missing and does not fall back to the account', async () => {
    const database = await createTestDb()
    const state = await createTestStateStore()
    cleanup.push(() => database.close(), () => state.close())
    const features = await state.store.createFeatureList({ name: 'Mail features', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({
      name: 'Mail plan', ownerId: null, featureListId: features.id,
      resources: { diskMb: 1024, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
      caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 2, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 2 },
      dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
    })
    await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const php = { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
    const alpha = await state.store.createAccount({ username: 'alpha', passwordHash: HASH, primaryDomain: 'alpha.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@alpha.example.test', ipv4: '192.0.2.10', shell: 'none', php })
    const inbox = await state.store.createServiceUser({ accountId: alpha.id, login: 'inbox@alpha.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: SERVICE_HASH })
    const app = createApiApp({
      db: database.db, store: state.store, serverSecret: SECRET, entryPoint: 'xmail',
      publicOrigin: ORIGIN, allowedOrigins: [ORIGIN], secureCookies: true, mailboxTransport: transport,
    })
    const logged = await app.fetch(new Request(`${ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'inbox@alpha.example.test', password: 'alpha-secret' }),
    }))
    expect(logged.status).toBe(200)
    const cookie = (logged.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const upgrade = {
      url: '/api/ws',
      headers: { host: 'mail.example.test', cookie, origin: ORIGIN },
      socket: { remoteAddress: '192.0.2.5' },
    } as unknown as Parameters<typeof app.authenticateUpgrade>[0]
    const opened = await app.authenticateUpgrade(upgrade)
    expect(opened).toMatchObject({
      kind: 'user',
      accountId: alpha.id,
      mailboxLogin: 'inbox@alpha.example.test',
    })
    await database.db.query('DELETE FROM mailbox_sessions')
    expect(await app.authenticateUpgrade(upgrade)).toBeNull()

    const owner = await createUserPrincipal(database.db, { username: 'alpha', passwordHash: HASH, accountId: alpha.id })
    const raw = `xp_${randomBytes(32).toString('hex')}`
    await createApiToken(database.db, {
      principalId: owner.id,
      name: 'mailbox-scope',
      tokenHash: sha256Hex(raw),
      scopes: ['events:read', `mailbox:${inbox.id}`],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    const tokenApp = createApiApp({
      db: database.db, store: state.store, serverSecret: SECRET, allowedOrigins: [ORIGIN],
    })
    const tokenUpgrade = {
      url: '/api/ws',
      headers: { host: 'mail.example.test', authorization: `Bearer ${raw}`, origin: ORIGIN },
      socket: { remoteAddress: '192.0.2.5' },
    } as unknown as Parameters<typeof tokenApp.authenticateUpgrade>[0]
    expect(await tokenApp.authenticateUpgrade(tokenUpgrade)).toBeNull()
  })
})
