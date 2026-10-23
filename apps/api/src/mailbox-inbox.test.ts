import { afterEach, describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import { createTestDb } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { createApiApp } from './server.ts'
import type { InboxMessage, MailboxSendInput, MailboxTransport } from './mail/inbox.ts'
import { createLocalMailboxTransport } from './mail/inbox.ts'

const SECRET = 'mailbox-inbox-synthetic-server-secret-32b'
const ORIGIN = 'https://mail.example.test'
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SERVICE_HASH = '{SHA512-CRYPT}$6$mailboxfixture$abcdefghijklmnopqrstuvwxyz0123456789'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

interface Box {
  password: string
  messages: InboxMessage[]
  sent: MailboxSendInput[]
}

const message = (uid: number, subject: string, body: string): InboxMessage => ({
  uid, from: 'sender@example.test', to: 'inbox@alpha.example.test', subject, receivedAt: '2026-10-23T12:00:00.000Z', unread: true, sizeBytes: body.length, body,
})

const harness = async (transport: MailboxTransport) => {
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
  const beta = await state.store.createAccount({ username: 'beta', passwordHash: HASH, primaryDomain: 'beta.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@beta.example.test', ipv4: '192.0.2.10', shell: 'none', php })
  await state.store.createServiceUser({ accountId: alpha.id, login: 'inbox@alpha.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: SERVICE_HASH })
  await state.store.createServiceUser({ accountId: beta.id, login: 'other@beta.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: SERVICE_HASH })
  await state.store.createServiceUser({ accountId: alpha.id, login: 'closed@alpha.example.test', services: { email: false, ftp: true, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: SERVICE_HASH })
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET, entryPoint: 'xmail', publicOrigin: ORIGIN, allowedOrigins: [ORIGIN], secureCookies: true, mailboxTransport: transport })
  const call = async (method: string, path: string, body?: unknown, session?: { cookie: string; csrf: string }) => {
    const response = await app.fetch(new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), { remoteAddress: '192.0.2.5' })
    const payload = await response.json() as { detail?: string; mailbox?: string; messages?: InboxMessage[]; message?: InboxMessage; messageId?: string; csrfToken?: string }
    const setCookie = response.headers.get('set-cookie') ?? ''
    const cookie = setCookie.split(';')[0] ?? ''
    return { status: response.status, payload, cookie, csrf: payload.csrfToken ?? '' }
  }
  const login = (username: string, password: string) => call('POST', '/api/auth/login', { username, password })
  const sessionOf = (logged: Awaited<ReturnType<typeof login>>) => ({ cookie: logged.cookie, csrf: logged.csrf })
  return { database, state, alpha, beta, call, login, sessionOf }
}

describe('xMail mailbox inbox', () => {
  it('signs in with the mailbox password and lists, reads, sends and deletes only that mailbox', async () => {
    const boxes = new Map<string, Box>([
      ['inbox@alpha.example.test', { password: 'alpha-secret', messages: [message(7, 'Alpha note', 'Hello from alpha')], sent: [] }],
      ['other@beta.example.test', { password: 'beta-secret', messages: [message(9, 'Beta note', 'Hello from beta')], sent: [] }],
    ])
    let verifies = 0
    const transport: MailboxTransport = {
      async verify(mailbox, password) {
        verifies += 1
        const box = boxes.get(mailbox)
        if (!box || box.password !== password) fail('UNAUTHENTICATED', 'imap rejected the password')
      },
      async list(mailbox, password) {
        await this.verify(mailbox, password)
        return boxes.get(mailbox)!.messages.map(({ body: _body, ...summary }) => summary)
      },
      async read(mailbox, password, uid) {
        await this.verify(mailbox, password)
        const found = boxes.get(mailbox)!.messages.find(item => item.uid === uid)
        if (!found) return fail('NOT_FOUND', 'message not found')
        found.unread = false
        return { ...found }
      },
      async remove(mailbox, password, uid) {
        await this.verify(mailbox, password)
        const box = boxes.get(mailbox)!
        const next = box.messages.filter(item => item.uid !== uid)
        if (next.length === box.messages.length) fail('NOT_FOUND', 'message not found')
        box.messages = next
      },
      async send(mailbox, password, input) {
        await this.verify(mailbox, password)
        boxes.get(mailbox)!.sent.push(input)
        return { messageId: '<sent@alpha.example.test>' }
      },
    }
    const { database, state, alpha, call, login, sessionOf } = await harness(transport)
    const wrong = await login('inbox@alpha.example.test', 'nope')
    expect(wrong.status).toBe(401)
    expect(wrong.payload.detail).toBe('invalid username or password')
    expect(wrong.cookie).toBe('')
    expect(await database.db.query('SELECT session_id FROM mailbox_sessions')).toEqual([])

    const missing = await login('nobody@alpha.example.test', 'alpha-secret')
    expect(missing.status).toBe(401)
    expect(missing.payload.detail).toBe('invalid username or password')

    const closed = await login('closed@alpha.example.test', 'alpha-secret')
    expect(closed.status).toBe(401)
    const verifiesBeforeSuspend = verifies
    await state.store.suspendAccount(alpha.id, 'billing')
    const suspended = await login('inbox@alpha.example.test', 'alpha-secret')
    expect(suspended.status).toBe(401)
    expect(suspended.payload.detail).toBe('invalid username or password')
    expect(verifies).toBe(verifiesBeforeSuspend)
    await state.store.unsuspendAccount(alpha.id)

    const logged = await login('inbox@alpha.example.test', 'alpha-secret')
    expect(logged.status).toBe(200)
    expect(logged.payload.mailbox).toBe('inbox@alpha.example.test')
    expect(logged.cookie.startsWith('__Host-xmail_session=')).toBe(true)
    const rows = await database.db.query<{ mailbox: string }>('SELECT mailbox FROM mailbox_sessions')
    expect(rows.map(row => row.mailbox)).toEqual(['inbox@alpha.example.test'])
    const session = sessionOf(logged)

    const listed = await call('GET', '/api/webmail/inbox', undefined, session)
    expect(listed.status).toBe(200)
    expect(listed.payload.messages?.map(item => item.subject)).toEqual(['Alpha note'])
    expect(listed.payload.messages?.[0]?.body).toBeUndefined()

    const foreign = await call('GET', '/api/webmail/inbox/9', undefined, session)
    expect(foreign.status).toBe(404)

    const read = await call('GET', '/api/webmail/inbox/7', undefined, session)
    expect(read.status).toBe(200)
    expect(read.payload.message?.body).toBe('Hello from alpha')
    expect(read.payload.message?.unread).toBe(false)

    const sent = await call('POST', '/api/webmail/send', { to: 'other@beta.example.test', subject: 'Hello', text: 'A real message' }, session)
    expect(sent.status).toBe(201)
    expect(sent.payload.messageId).toBe('<sent@alpha.example.test>')
    expect(boxes.get('inbox@alpha.example.test')!.sent).toEqual([expect.objectContaining({ to: 'other@beta.example.test', subject: 'Hello', text: 'A real message' })])

    const invalid = await call('POST', '/api/webmail/send', { to: 'not-an-address', subject: 'Hello', text: 'A real message' }, session)
    expect(invalid.status).toBe(422)

    const removed = await call('DELETE', '/api/webmail/inbox/7', undefined, session)
    expect(removed.status).toBe(200)
    const empty = await call('GET', '/api/webmail/inbox', undefined, session)
    expect(empty.payload.messages).toEqual([])

    const other = await login('other@beta.example.test', 'beta-secret')
    const otherList = await call('GET', '/api/webmail/inbox', undefined, sessionOf(other))
    expect(otherList.payload.messages?.map(item => item.subject)).toEqual(['Beta note'])
    const stillEmpty = await call('GET', '/api/webmail/inbox', undefined, session)
    expect(stillEmpty.payload.messages).toEqual([])
  })

  it('reports an unreachable mail server without treating it as a bad password', async () => {
    const down: MailboxTransport = {
      async verify() { fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
      async list() { return fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
      async read() { return fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
      async remove() { return fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
      async send() { return fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
    }
    const { login } = await harness(down)
    const response = await login('inbox@alpha.example.test', 'alpha-secret')
    expect(response.status).toBe(412)
    expect(response.payload.detail).toMatch(/the mail server could not be reached/)
  })

  it('turns a refused local IMAP connection into a mail-server error', async () => {
    const transport = createLocalMailboxTransport({
      XPANEL_IMAP_HOST: '127.0.0.1',
      XPANEL_IMAP_PORT: '1',
      XPANEL_IMAP_TIMEOUT_MS: '1000',
    })
    await expect(transport.verify('inbox@alpha.example.test', 'alpha-secret')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/the mail server could not be reached/),
    })
  })
})
