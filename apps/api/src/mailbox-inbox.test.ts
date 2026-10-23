import { afterEach, describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import { createRootPrincipal, createTestDb } from '@xpanel/db'
import { createTestStateStore, ExtendedFeaturesStore } from '@xpanel/state'
import { hashPasswordArgon2id } from './auth.ts'
import { createApiApp } from './server.ts'
import { loadMailDocument } from './mail/document.ts'
import type { InboxMessage, MailboxSendInput, MailboxTransport } from './mail/inbox.ts'
import { createLocalMailboxTransport, imapHumanCopy, mailboxPrincipalUsername, mailReceivedAtUtc } from './mail/inbox.ts'

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
      async move(mailbox, password, uid) {
        await this.remove(mailbox, password, uid)
        return { uid: uid + 40 }
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
    expect(listed.payload).toMatchObject({ folder: 'INBOX', complete: true })
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

  it('moves a delete into Trash and expunges only after confirmation', async () => {
    const boxes = new Map<string, Box>([
      ['inbox@alpha.example.test', { password: 'alpha-secret', messages: [message(7, 'Alpha note', 'Hello from alpha')], sent: [] }],
    ])
    let removed = 0
    let movedTo = ''
    const transport: MailboxTransport = {
      async verify() { return undefined },
      async list(mailbox) { return boxes.get(mailbox)!.messages },
      async read() { return fail('NOT_FOUND', 'message not found') },
      async remove() { removed += 1 },
      async move(_mailbox, _password, uid, _from, to) {
        movedTo = to
        boxes.get('inbox@alpha.example.test')!.messages = []
        return { uid: uid + 9 }
      },
      async send() { return { messageId: '<x>' } },
    }
    const { call, login, sessionOf } = await harness(transport)
    const session = sessionOf(await login('inbox@alpha.example.test', 'alpha-secret'))
    const trashed = await call('DELETE', '/api/webmail/inbox/7?folder=INBOX', undefined, session)
    expect(trashed.status).toBe(200)
    expect(movedTo).toBe('Trash')
    expect(removed).toBe(0)
    expect(trashed.payload).toMatchObject({ uid: 16, folder: 'Trash' })
    const blocked = await call('DELETE', '/api/webmail/inbox/7?folder=Trash', undefined, session)
    expect(blocked.status).toBe(412)
    expect(blocked.payload.detail).toBe('Deleting a message from Trash removes it permanently.')
    expect(removed).toBe(0)
    const gone = await call('DELETE', '/api/webmail/inbox/7?folder=Trash&confirm=delete', undefined, session)
    expect(gone.status).toBe(200)
    expect(removed).toBe(1)
    expect(imapHumanCopy('IMAP UID MOVE/COPY failed: NO [TRYCREATE] Mailbox does not exist').en).toBe('That folder is not on this mailbox yet.')
  })

  it('converts a mail date to UTC and keeps text that is not a date', () => {
    expect(mailReceivedAtUtc('22-Oct-2026 14:30:00 +0300')).toBe('2026-10-22T11:30:00.000Z')
    expect(mailReceivedAtUtc('Thu, 23 Oct 2026 12:00:00 +0000')).toBe('2026-10-23T12:00:00.000Z')
    expect(mailReceivedAtUtc('not a date')).toBe('not a date')
    expect(mailReceivedAtUtc('')).toBe('')
  })

  it('binds the mailbox document to the stored quota and only the settings that were written', async () => {
    const boxes = new Map<string, Box>([
      ['inbox@alpha.example.test', { password: 'alpha-secret', messages: [message(7, 'Alpha note', 'Hello from alpha')], sent: [] }],
    ])
    const transport: MailboxTransport = {
      async verify(mailbox, password) {
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
        return { ...found, unread: false }
      },
      async remove() { return undefined },
      async send() { return { messageId: '<sent@alpha.example.test>' } },
    }
    const { database, state, alpha, login } = await harness(transport)
    const logged = await login('inbox@alpha.example.test', 'alpha-secret')
    expect(logged.status).toBe(200)
    const rows = await database.db.query<{ session_id: string }>('SELECT session_id FROM mailbox_sessions')
    const sessionId = rows[0]?.session_id ?? ''
    const read = async () => loadMailDocument({
      db: database.db, store: state.store, serverSecret: SECRET, sessionId, transport,
    })
    const before = await read()
    expect(before.mailbox).toBe('inbox@alpha.example.test')
    expect(before.quotaLimitMb).toBe(100)
    expect(before).not.toHaveProperty('quotaUsedMb')
    expect(before.messages?.map(item => [item.subject, item.body, item.bodyPending, item.unread])).toEqual([['Alpha note', 'Hello from alpha', false, false]])
    expect(before.vacationEnabled).toBe(false)
    expect(before.sieveRules).toEqual([])
    expect(before.identityDkim).toBeUndefined()
    expect(before.identitySize).toBeUndefined()
    expect(before.mailListFailed).toBeUndefined()

    const extended = new ExtendedFeaturesStore(state.store.rootDir)
    await extended.saveVacationResponder('inbox@alpha.example.test', { enabled: true, subject: 'Away', body: 'Out of office' })
    await extended.saveEmailFilter({
      accountId: alpha.id, mailbox: 'inbox@alpha.example.test', name: 'Orders',
      rules: [{ field: 'subject', operator: 'contains', value: 'invoice' }], action: 'folder', actionTarget: 'Orders', enabled: false,
    })
    await extended.provisionBatchEmailAuth(['alpha.example.test'], '192.0.2.10')
    const { updatedAt: _updatedAt, ...settings } = await extended.getServerFineSettings()
    await extended.saveServerFineSettings({ ...settings, mtaMaxMsgSizeMb: 25 })
    const after = await read()
    expect(after.vacationEnabled).toBe(true)
    expect(after.sieveRules).toEqual([expect.objectContaining({ name: 'Orders', condition: 'Subject contains invoice', action: 'File into Orders', enabled: false })])
    expect(after.identityDkim).toBe('Selector default is stored for alpha.example.test')
    expect(after.identitySpf).toBe('SPF record stored · DMARC record stored')
    expect(after.identitySize).toBe('25 MiB per message')
  })

  it('keeps the stored quota when the mail server cannot be listed', async () => {
    const transport: MailboxTransport = {
      async verify() { return undefined },
      async list() { return fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
      async read() { return fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
      async remove() { return undefined },
      async send() { return fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
    }
    const { database, state, login } = await harness(transport)
    const logged = await login('inbox@alpha.example.test', 'alpha-secret')
    expect(logged.status).toBe(200)
    const rows = await database.db.query<{ session_id: string }>('SELECT session_id FROM mailbox_sessions')
    const loaded = await loadMailDocument({
      db: database.db, store: state.store, serverSecret: SECRET, sessionId: rows[0]?.session_id ?? '', transport,
    })
    expect(loaded.quotaLimitMb).toBe(100)
    expect(loaded.messages).toBeUndefined()
    expect(loaded.mailListFailed).toBe(true)
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

  it('reads the postfix size limit and an empty milter as unsigned mail', async () => {
    const transport: MailboxTransport = {
      async verify() { return undefined },
      async list() { return [] },
      async read() { return fail('NOT_FOUND', 'message not found') },
      async remove() { return undefined },
      async send() { return { messageId: '<sent@alpha.example.test>' } },
    }
    const { database, state, login } = await harness(transport)
    const logged = await login('inbox@alpha.example.test', 'alpha-secret')
    expect(logged.status).toBe(200)
    const rows = await database.db.query<{ session_id: string }>('SELECT session_id FROM mailbox_sessions')
    const postfixMain = [
      'message_size_limit = 10240000',
      'smtpd_milters =',
    ].join('\n')
    const loaded = await loadMailDocument({
      db: database.db, store: state.store, serverSecret: SECRET, sessionId: rows[0]?.session_id ?? '', transport, postfixMain,
    })
    expect(loaded.identitySize).toBe('10 MB')
    expect(loaded.identityDkim).toBe('not signed')
    expect(loaded.identitySpf).toBe('SPF record missing · DMARC record missing')
  })

  it('removes the mailbox login and its sessions when the mailbox is deleted', async () => {
    const transport: MailboxTransport = {
      async verify(mailbox, password) {
        const accepted = mailbox === 'inbox@alpha.example.test' ? 'alpha-secret' : mailbox === 'other@beta.example.test' ? 'beta-secret' : ''
        if (password !== accepted) fail('UNAUTHENTICATED', 'imap rejected the password')
      },
      async list() { return [] },
      async read() { return fail('NOT_FOUND', 'message not found') },
      async remove() { return undefined },
      async send() { return { messageId: '<sent@alpha.example.test>' } },
    }
    const { database, state, login } = await harness(transport)
    const inbox = await login('inbox@alpha.example.test', 'alpha-secret')
    const other = await login('other@beta.example.test', 'beta-secret')
    expect(inbox.status).toBe(200)
    expect(other.status).toBe(200)
    const names = async () => (await database.db.query<{ username: string }>('SELECT username FROM principals ORDER BY username')).map(row => row.username)
    const inboxName = mailboxPrincipalUsername('inbox@alpha.example.test')
    const otherName = mailboxPrincipalUsername('other@beta.example.test')
    const before = await names()
    expect(before).toEqual(expect.arrayContaining([inboxName, otherName]))
    expect(await database.db.query('SELECT session_id FROM mailbox_sessions')).toHaveLength(2)

    await createRootPrincipal(database.db, {
      username: 'root',
      passwordHash: await hashPasswordArgon2id('RootPassword!2026'),
      forcePasswordChange: false,
    })
    const origin = 'https://whm.example.test'
    const whm = createApiApp({
      db: database.db, store: state.store, serverSecret: SECRET, entryPoint: 'xwhm',
      publicOrigin: origin, allowedOrigins: [origin], secureCookies: true,
    })
    const rootLogin = await whm.fetch(new Request(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPassword!2026' }),
    }), { remoteAddress: '192.0.2.5' })
    expect(rootLogin.status).toBe(200)
    const rootBody = await rootLogin.json() as { csrfToken?: string }
    const cookie = (rootLogin.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const serviceUser = await state.store.getServiceUserByLogin('inbox@alpha.example.test')
    expect(serviceUser?.id).toBeTruthy()
    const removed = await whm.fetch(new Request(`${origin}/api/service-users/${serviceUser!.id}`, {
      method: 'DELETE',
      headers: { cookie, 'x-csrf-token': rootBody.csrfToken ?? '' },
    }), { remoteAddress: '192.0.2.5' })
    expect(removed.status).toBe(200)

    const after = await names()
    expect(after).not.toContain(inboxName)
    expect(after).toContain(otherName)
    expect(after.filter(name => name.startsWith('mbx'))).toHaveLength(1)
    const sessions = await database.db.query<{ mailbox: string }>('SELECT mailbox FROM mailbox_sessions')
    expect(sessions.map(row => row.mailbox)).toEqual(['other@beta.example.test'])
    expect(await state.store.getServiceUserByLogin('inbox@alpha.example.test')).toBeNull()
    expect(await state.store.getServiceUserByLogin('other@beta.example.test')).not.toBeNull()
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
