import { describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import { decodeImapMailboxName, encodeImapMailboxName } from './imap.ts'
import type { ImapCommandOutcome, ImapMailboxEntry, ImapMailboxStatus } from './imap.ts'
import { handleMailFolderAdminRoute, mailFolderLeafName } from './folder-admin.ts'
import type { MailFolderAdminClient, SealedImapPorts, SealedMailboxSession } from './folder-admin.ts'

const MAILBOX = 'alice@example.test'
const session = (mailbox = MAILBOX): SealedMailboxSession => ({ record: { sessionId: 's1', mailbox, accountId: 'a1', serviceUserId: 'u1' }, password: 'sealed-secret' })
const ARABIC = encodeImapMailboxName('مشاريع')

class FakeFolders implements MailFolderAdminClient {
  folders = new Map<string, { attributes: string[]; messages: number; unseen: number }>([
    ['INBOX', { attributes: ['\\HasChildren'], messages: 3, unseen: 1 }], ['Sent', { attributes: ['\\Sent'], messages: 2, unseen: 0 }],
    ['Trash', { attributes: ['\\Trash'], messages: 0, unseen: 0 }], ['Projects', { attributes: [], messages: 4, unseen: 2 }],
    ['Projects.' + ARABIC, { attributes: [], messages: 0, unseen: 0 }], ['Old', { attributes: ['\\Archive'], messages: 0, unseen: 0 }], ['Empty', { attributes: [], messages: 0, unseen: 0 }],
  ])
  subscribed = new Set(['INBOX', 'Sent', 'Projects'])
  calls: string[] = []
  loggedIn = ''
  lsub = true
  respond?: ImapCommandOutcome
  skipEffect = false
  throwAfterCommand = false
  async connect(): Promise<string> { return 'OK' }
  async login(mailbox: string): Promise<void> { this.loggedIn = mailbox }
  async logout(): Promise<void> {}
  async listMailboxes(): Promise<{ entries: ImapMailboxEntry[]; subscriptionsObserved: boolean }> {
    return { subscriptionsObserved: this.lsub, entries: [...this.folders].map(([name, item]) => ({ name, displayName: decodeImapMailboxName(name), delimiter: '.', attributes: [...item.attributes], subscribed: this.lsub ? this.subscribed.has(name) : null })) }
  }
  async mailboxStatus(name: string): Promise<ImapMailboxStatus> {
    const item = this.folders.get(name) ?? fail('PRECONDITION_FAILED', 'the mail folder status was not observed', { stateChanged: false, reason: 'imap_status_unavailable' })
    return { messages: item.messages, unseen: item.unseen }
  }
  private effect(command: string, apply: () => void): ImapCommandOutcome {
    this.calls.push(command)
    if (this.throwAfterCommand) throw new Error('IMAP socket closed unexpectedly')
    if (!this.skipEffect) apply()
    return this.respond ?? { ok: true, code: null }
  }
  async createMailbox(name: string): Promise<ImapCommandOutcome> { return this.effect('CREATE ' + name, () => this.folders.set(name, { attributes: [], messages: 0, unseen: 0 })) }
  async renameMailbox(from: string, to: string): Promise<ImapCommandOutcome> {
    return this.effect('RENAME ' + from + ' ' + to, () => {
      for (const [name, item] of [...this.folders]) if (name === from || name.startsWith(from + '.')) { this.folders.delete(name); this.folders.set(to + name.slice(from.length), item) }
    })
  }
  async deleteMailbox(name: string): Promise<ImapCommandOutcome> { return this.effect('DELETE ' + name, () => this.folders.delete(name)) }
  async setMailboxSubscription(name: string, subscribed: boolean): Promise<ImapCommandOutcome> {
    return this.effect((subscribed ? 'SUBSCRIBE ' : 'UNSUBSCRIBE ') + name, () => { if (subscribed) this.subscribed.add(name); else this.subscribed.delete(name) })
  }
}

function harness(options: { sessions?: Array<SealedMailboxSession>; audit?: SealedImapPorts<MailFolderAdminClient>['audit'] } = {}) {
  const fake = new FakeFolders(), opened: string[] = []
  let call = 0
  const ports: SealedImapPorts<MailFolderAdminClient> = {
    open: async () => { const value = options.sessions?.[Math.min(call, options.sessions.length - 1)] ?? session(); call++; opened.push(value.record.mailbox); return value },
    clientFactory: () => fake, env: { XPANEL_IMAP_HOST: '127.0.0.1', XPANEL_IMAP_PORT: '143' }, now: () => new Date('2026-10-27T12:00:00.000Z'),
    ...(options.audit ? { audit: options.audit } : {}),
  }
  const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const req = new Request('http://xpanel.test' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
    return handleMailFolderAdminRoute(req, new URL(req.url), method, ports).then(async response => ({ response: response!, body: response!.status === 405 ? {} : await response!.json() as Record<string, any> }))
  }
  return { fake, request, opened }
}

describe('mail folder leaf grammar', () => {
  it.each(['Reports', 'تقارير 2026', 'Café & Co', 'a'.repeat(64)])('accepts %s', name => { expect(mailFolderLeafName(name, '.')).toBe(name.normalize('NFC')) })
  it.each(['', ' lead', 'trail ', 'a.b', 'a/b', 'wild*', 'per%', 'quo"te', 'back\\slash', '.hidden', '~home', 'inbox', 'x\u202Ey', 'tab\tname', 'a'.repeat(65), 'bad\ud800'])('refuses %j', name => {
    expect(() => mailFolderLeafName(name, '.')).toThrow(/folder names/)
  })
})

describe('/api/webmail/folders list', () => {
  it('lists the sealed mailbox with special-use protection, hierarchy, counts and subscriptions', async () => {
    const f = harness(), { response, body } = await f.request('/api/webmail/folders')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(f.fake.loggedIn).toBe(MAILBOX); expect(body.mailbox).toBe(MAILBOX)
    expect(body.folders.map((item: any) => item.folder)).toEqual(['INBOX', 'Empty', 'Old', 'Projects', 'Projects.' + ARABIC, 'Sent', 'Trash'])
    const by = (folder: string) => body.folders.find((item: any) => item.folder === folder)
    expect(by('INBOX')).toMatchObject({ system: true, messages: 3, unseen: 1, subscribed: true })
    expect(by('Sent')).toMatchObject({ system: true, specialUse: '\\Sent' })
    expect(by('Old')).toMatchObject({ system: true, specialUse: '\\Archive' })
    expect(by('Projects')).toMatchObject({ system: false, children: 1, subscribed: true })
    expect(by('Projects.' + ARABIC)).toMatchObject({ name: 'Projects.مشاريع', leaf: 'مشاريع', parent: 'Projects', depth: 1, subscribed: false })
  })
  it.each([['/api/webmail/folders?mailbox=bob@example.test', undefined], ['/api/webmail/folders', { name: 'X', parent: null, mailbox: 'bob@example.test' }], ['/api/webmail/folders/delete?mailbox=bob@example.test', { folder: 'Empty' }]])('never accepts a mailbox selector %s', async (path, body) => {
    const f = harness()
    await expect(f.request(path, body)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(f.fake.calls).toEqual([])
  })
  it('refuses unsupported methods and ignores unrelated paths', async () => {
    const f = harness()
    expect((await f.request('/api/webmail/folders/rename', undefined, 'GET')).response.status).toBe(405)
    const other = new Request('http://xpanel.test/api/webmail/inbox')
    expect(await handleMailFolderAdminRoute(other, new URL(other.url), 'GET', { open: async () => session() })).toBeNull()
  })
})

describe('/api/webmail/folders mutations', () => {
  it('creates an encoded personal subfolder and confirms it from the re-read', async () => {
    const f = harness(), { body } = await f.request('/api/webmail/folders', { name: 'تقارير', parent: 'Projects' })
    const wire = 'Projects.' + encodeImapMailboxName('تقارير')
    expect(f.fake.calls).toEqual(['CREATE ' + wire])
    expect(body).toMatchObject({ operation: 'create', folder: wire, outcome: 'confirmed', stateChanged: true })
    expect(body.view.folders.some((item: any) => item.folder === wire)).toBe(true)
  })
  it.each([
    [{ name: 'Projects', parent: null }, 'CONFLICT', 'folder_exists'], [{ name: 'sent', parent: null }, 'CONFLICT', 'protected_folder'],
    [{ name: 'Trash', parent: 'INBOX' }, 'CONFLICT', 'protected_folder'], [{ name: 'x', parent: 'Missing' }, 'NOT_FOUND', 'mail_folder_missing'],
    [{ name: 'a.b', parent: null }, 'VALIDATION', 'mail_folder_name_invalid'], [{ name: 'x' }, 'VALIDATION', undefined],
  ])('refuses create %j before any command', async (input, code, reason) => {
    const f = harness()
    await expect(f.request('/api/webmail/folders', input)).rejects.toMatchObject({ code, detail: { stateChanged: false, ...(reason ? { reason } : {}) } })
    expect(f.fake.calls).toEqual([])
  })
  it('renames a personal folder with its subfolders', async () => {
    const f = harness(), { body } = await f.request('/api/webmail/folders/rename', { folder: 'Projects', name: 'Clients' })
    expect(f.fake.calls).toEqual(['RENAME Projects Clients'])
    expect(body).toMatchObject({ operation: 'rename', folder: 'Clients', outcome: 'confirmed' })
    expect([...f.fake.folders.keys()]).toContain('Clients.' + ARABIC)
  })
  it.each(['INBOX', 'Sent', 'Trash', 'Old'])('protects system or special-use folder %s from rename and delete', async folder => {
    const f = harness()
    await expect(f.request('/api/webmail/folders/rename', { folder, name: 'Renamed' })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'protected_folder' } })
    await expect(f.request('/api/webmail/folders/delete', { folder })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'protected_folder' } })
    expect(f.fake.calls).toEqual([])
  })
  it('deletes an empty folder without confirmation and confirms absence', async () => {
    const f = harness(), { body } = await f.request('/api/webmail/folders/delete', { folder: 'Empty' })
    expect(f.fake.calls).toEqual(['DELETE Empty']); expect(body).toMatchObject({ outcome: 'confirmed', folder: 'Empty' })
  })
  it('requires the observed message count for a non-empty folder and refuses changed counts', async () => {
    const f = harness()
    f.fake.folders.delete('Projects.' + ARABIC)
    await expect(f.request('/api/webmail/folders/delete', { folder: 'Projects' })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'folder_not_empty', messages: 4 } })
    await expect(f.request('/api/webmail/folders/delete', { folder: 'Projects', confirm: { folder: 'Projects', messages: 3 } })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'folder_changed', messages: 4 } })
    await expect(f.request('/api/webmail/folders/delete', { folder: 'Projects', confirm: { folder: 'Empty', messages: 4 } })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'folder_changed' } })
    expect(f.fake.calls).toEqual([])
    expect((await f.request('/api/webmail/folders/delete', { folder: 'Projects', confirm: { folder: 'Projects', messages: 4 } })).body).toMatchObject({ outcome: 'confirmed' })
  })
  it('refuses to delete a folder that still has subfolders', async () => {
    const f = harness()
    await expect(f.request('/api/webmail/folders/delete', { folder: 'Projects', confirm: { folder: 'Projects', messages: 4 } })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'folder_has_children' } })
  })
  it('changes subscriptions and reports unknown when LSUB cannot confirm them', async () => {
    const f = harness()
    expect((await f.request('/api/webmail/folders/subscription', { folder: 'Projects', subscribed: false })).body).toMatchObject({ operation: 'unsubscribe', outcome: 'confirmed' })
    f.fake.lsub = false
    expect((await f.request('/api/webmail/folders/subscription', { folder: 'Empty', subscribed: true })).body).toMatchObject({ outcome: 'unknown', verificationRequired: true })
  })
  it('reports a proven server refusal as unchanged, and an unproven OK as unknown', async () => {
    const f = harness()
    f.fake.skipEffect = true; f.fake.respond = { ok: false, code: 'LIMIT' }
    await expect(f.request('/api/webmail/folders', { name: 'New', parent: null })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, reason: 'mail_folder_refused', serverCode: 'LIMIT' } })
    f.fake.respond = { ok: true, code: null }
    expect((await f.request('/api/webmail/folders', { name: 'New', parent: null })).body).toMatchObject({ outcome: 'unknown', stateChanged: true, verificationRequired: true })
  })
  it('turns a connection loss after the command into an unknown outcome', async () => {
    const f = harness()
    f.fake.throwAfterCommand = true
    await expect(f.request('/api/webmail/folders/delete', { folder: 'Empty' })).rejects.toMatchObject({ detail: { stateChanged: true, unknownOutcome: true, verificationRequired: true } })
  })
  it('re-checks sealed authority right before the mutation', async () => {
    const f = harness({ sessions: [session(), session(), { ...session(), password: 'rotated' }] })
    await expect(f.request('/api/webmail/folders/delete', { folder: 'Empty' })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(f.fake.calls).toEqual([])
  })
  it('never reports a changed session after a mutation as unchanged', async () => {
    const f = harness({ sessions: [session(), session(), session(), session('mallory@example.test')] })
    await expect(f.request('/api/webmail/folders/delete', { folder: 'Empty' })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { unknownOutcome: true } })
    expect(f.fake.calls).toEqual(['DELETE Empty'])
  })
  it('records confirmed changes and flags an unrecorded change for review', async () => {
    const events: unknown[] = []
    const f = harness({ audit: async (_request, event) => { events.push(event) } })
    await f.request('/api/webmail/folders/delete', { folder: 'Empty' })
    expect(events).toEqual([{ action: 'webmail.folder.delete', mailbox: MAILBOX, detail: { folder: 'Empty', outcome: 'confirmed' } }])
    const g = harness({ audit: async () => { throw new Error('audit down') } })
    await expect(g.request('/api/webmail/folders/delete', { folder: 'Empty' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true } })
  })
})
