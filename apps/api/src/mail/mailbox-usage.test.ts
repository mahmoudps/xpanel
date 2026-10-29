import { describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import type { ImapMailboxEntry, ImapMailboxStatus, ImapQuotaResource, ImapSearchCriteria, ImapStatusItem } from './imap.ts'
import { handleMailboxUsageRoute, parseCleanupCriteria } from './mailbox-usage.ts'
import type { MailboxUsageClient } from './mailbox-usage.ts'
import type { SealedImapPorts, SealedMailboxSession } from './folder-admin.ts'

const MAILBOX = 'alice@example.test', NOW = new Date('2026-10-27T12:00:00.000Z'), DAY = 86_400_000
const session = (mailbox = MAILBOX): SealedMailboxSession => ({ record: { sessionId: 's1', mailbox, accountId: 'a1', serviceUserId: 'u1' }, password: 'sealed-secret' })
interface Message { size: number; seen: boolean; date: number }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const imapDate = (value: string): number => { const [day, month, year] = value.split('-'); return Date.UTC(Number(year), MONTHS.indexOf(month!), Number(day)) }

class FakeUsage implements MailboxUsageClient {
  caps = new Set(['IMAP4REV1', 'MOVE', 'UIDPLUS', 'STATUS=SIZE', 'QUOTA'])
  folders = new Map<string, { attributes: string[]; validity: number; messages: Map<number, Message> }>([
    ['INBOX', { attributes: [], validity: 17, messages: new Map([[1, { size: 100, seen: true, date: NOW.getTime() - 400 * DAY }], [2, { size: 3 * 1048576, seen: false, date: NOW.getTime() - 400 * DAY }], [3, { size: 300, seen: true, date: NOW.getTime() - DAY }]]) }],
    ['Trash', { attributes: ['\\Trash'], validity: 41, messages: new Map([[9, { size: 50, seen: true, date: NOW.getTime() - 10 * DAY }]]) }],
    ['Shared', { attributes: ['\\Noselect'], validity: 1, messages: new Map() }],
  ])
  calls: string[] = []
  quota: { roots: string[]; resources: ImapQuotaResource[] } | 'NO' = { roots: ['User quota'], resources: [{ root: 'User quota', resource: 'STORAGE', usage: 2048, limit: 1048576 }, { root: 'User quota', resource: 'MESSAGE', usage: 4, limit: 0 }] }
  moveOnly?: number[]
  refuseMove = false
  loggedIn = ''
  async connect(): Promise<string> { return 'OK' }
  async login(mailbox: string): Promise<void> { this.loggedIn = mailbox }
  async logout(): Promise<void> {}
  async capabilities(): Promise<ReadonlySet<string>> { return this.caps }
  async listMailboxes(): Promise<{ entries: ImapMailboxEntry[]; subscriptionsObserved: boolean }> {
    return { subscriptionsObserved: true, entries: [...this.folders].map(([name, item]) => ({ name, displayName: name, delimiter: '.', attributes: item.attributes, subscribed: true })) }
  }
  private box(name: string, expected?: number) {
    const box = this.folders.get(name) ?? fail('NOT_FOUND', 'no folder')
    if (expected !== undefined && expected !== box.validity) fail('CONFLICT', 'the mailbox identity changed before the operation', { stateChanged: false })
    return box
  }
  async mailboxStatus(name: string, items: readonly ImapStatusItem[]): Promise<ImapMailboxStatus> {
    this.calls.push('STATUS ' + name + ' ' + items.join(' '))
    const messages = [...this.box(name).messages.values()]
    return { messages: messages.length, unseen: messages.filter(item => !item.seen).length, ...(items.includes('SIZE') ? { size: messages.reduce((sum, item) => sum + item.size, 0) } : {}) }
  }
  async mailboxMessageSizes(name: string, max: number, _mailbox?: string, expected?: number) {
    this.calls.push('SIZES ' + name)
    const box = this.box(name, expected)
    return { uidValidity: box.validity, exists: box.messages.size, sizes: box.messages.size > max ? null : new Map([...box.messages].map(([uid, item]) => [uid, item.size])) }
  }
  async searchMailboxUids(name: string, criteria: ImapSearchCriteria, expected: number | undefined) {
    this.calls.push('SEARCH ' + name + ' ' + JSON.stringify(criteria))
    const box = this.box(name, expected)
    return { uidValidity: box.validity, uids: [...box.messages].filter(([, item]) => (!criteria.before || item.date < imapDate(criteria.before)) && (criteria.largerThan === undefined || item.size > criteria.largerThan) && (!criteria.seen || item.seen)).map(([uid]) => uid) }
  }
  async moveUidSet(source: string, uids: readonly number[], target: string, expected: number) {
    this.calls.push('MOVE ' + uids.join(',') + ' ' + target)
    const from = this.box(source, expected), to = this.box(target)
    if (!this.refuseMove) for (const uid of uids) if (!this.moveOnly || this.moveOnly.includes(uid)) { to.messages.set(uid + 100, from.messages.get(uid)!); from.messages.delete(uid) }
    const remaining = uids.filter(uid => from.messages.has(uid))
    return { moved: uids.filter(uid => !from.messages.has(uid)), remaining, accepted: !this.refuseMove }
  }
  async expungeUidSet(folder: string, uids: readonly number[], expected: number) {
    this.calls.push('EXPUNGE ' + folder + ' ' + uids.join(','))
    const box = this.box(folder, expected)
    for (const uid of uids) box.messages.delete(uid)
    return { removed: [...uids], remaining: [], accepted: true }
  }
  async quotaRootResources() {
    if (this.quota === 'NO') return fail('PRECONDITION_FAILED', 'the mailbox quota was not observed', { stateChanged: false, reason: 'imap_quota_unavailable' })
    return this.quota
  }
}

function harness() {
  const fake = new FakeUsage()
  const ports: SealedImapPorts<MailboxUsageClient> = { open: async () => session(), clientFactory: () => fake, env: { XPANEL_IMAP_HOST: '127.0.0.1', XPANEL_IMAP_PORT: '143' }, now: () => NOW }
  const request = async (path: string, body?: unknown) => {
    const method = body === undefined ? 'GET' : 'POST'
    const req = new Request('http://xpanel.test' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const response = (await handleMailboxUsageRoute(req, new URL(req.url), method, ports))!
    return { response, body: response.status === 405 ? {} : await response.json() as Record<string, any> }
  }
  return { fake, request, effects: () => fake.calls.filter(call => /^(?:MOVE|EXPUNGE) /.test(call)) }
}

describe('cleanup criteria grammar', () => {
  it('maps age, size and read state to RFC 3501 search keys', () => {
    expect(parseCleanupCriteria({ olderThanDays: 30, largerThanMb: 2, seen: true }, NOW)).toEqual({ criteria: { olderThanDays: 30, largerThanMb: 2, seen: true }, search: { before: '27-Sep-2026', largerThan: 2097152, seen: true } })
  })
  it.each([{}, { olderThanDays: 0 }, { olderThanDays: 1.5 }, { largerThanMb: 10241 }, { seen: false }, { query: 'ALL' }, null])('refuses %j', value => {
    expect(() => parseCleanupCriteria(value, NOW)).toThrow()
  })
})

describe('/api/webmail/disk-usage', () => {
  it('reads RFC 8438 STATUS SIZE and RFC 9208 quota for the sealed mailbox only', async () => {
    const f = harness(), { body } = await f.request('/api/webmail/disk-usage')
    expect(f.fake.loggedIn).toBe(MAILBOX)
    expect(body).toMatchObject({ mailbox: MAILBOX, trash: 'Trash', capabilities: { statusSize: true, quota: true, move: true, uidPlus: true },
      quota: { state: 'read', root: 'User quota', usedBytes: 2048 * 1024, limitBytes: 1048576 * 1024, messages: { used: 4, limit: null } } })
    expect(body.folders).toEqual([
      { folder: 'INBOX', name: 'INBOX', specialUse: null, messages: 3, unseen: 1, size: { state: 'measured', bytes: 3 * 1048576 + 400, method: 'status-size' } },
      { folder: 'Trash', name: 'Trash', specialUse: '\\Trash', messages: 1, unseen: 0, size: { state: 'measured', bytes: 50, method: 'status-size' } },
    ])
    expect(f.fake.calls.some(call => call.startsWith('SIZES'))).toBe(false)
  })
  it('falls back to summed RFC822.SIZE without STATUS=SIZE and labels unadvertised or unanswered quota', async () => {
    const f = harness()
    f.fake.caps = new Set(['IMAP4REV1'])
    const { body } = await f.request('/api/webmail/disk-usage')
    expect(body.folders[0].size).toEqual({ state: 'measured', bytes: 3 * 1048576 + 400, method: 'message-sizes' })
    expect(body.quota).toEqual({ state: 'not-advertised' })
    expect(f.fake.calls).toContain('STATUS INBOX MESSAGES UNSEEN')
    const g = harness(); g.fake.quota = 'NO'
    expect((await g.request('/api/webmail/disk-usage')).body.quota).toEqual({ state: 'unavailable' })
    const h = harness(); h.fake.quota = { roots: ['User quota'], resources: [] }
    expect((await h.request('/api/webmail/disk-usage')).body.quota).toEqual({ state: 'no-storage-limit' })
  })
  it('refuses query selectors, including a mailbox selector', async () => {
    const f = harness()
    await expect(f.request('/api/webmail/disk-usage?mailbox=bob@example.test')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.request('/api/webmail/disk-usage/preview?folder=INBOX&seen=true&mailbox=bob@example.test')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('cleanup preview and actions', () => {
  it('previews count, total size and the bounded action batch', async () => {
    const f = harness(), { body } = await f.request('/api/webmail/disk-usage/preview?folder=INBOX&olderThanDays=365')
    expect(body).toMatchObject({ folder: 'INBOX', uidValidity: 17, matched: 2, matchedBytes: 3 * 1048576 + 100, batch: { uids: [1, 2], count: 2, bytes: 3 * 1048576 + 100 }, actionLimit: 5000, trash: 'Trash', isTrash: false })
    expect((await f.request('/api/webmail/disk-usage/preview?folder=INBOX&largerThanMb=2&seen=true')).body).toMatchObject({ matched: 0, batch: { uids: [] } })
  })
  it.each(['/api/webmail/disk-usage/preview?folder=INBOX', '/api/webmail/disk-usage/preview?folder=INBOX&seen=false', '/api/webmail/disk-usage/preview?folder=INBOX&olderThanDays=07', '/api/webmail/disk-usage/preview?seen=true', '/api/webmail/disk-usage/preview?folder=INBOX&seen=true&seen=true'])('refuses an empty or malformed preview %s', async path => {
    await expect(harness().request(path)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('refuses unselectable or missing folders and folders above the measurement bound', async () => {
    const f = harness()
    await expect(f.request('/api/webmail/disk-usage/preview?folder=Shared&seen=true')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    for (let uid = 10; uid < 50011; uid++) f.fake.folders.get('INBOX')!.messages.set(uid, { size: 1, seen: true, date: NOW.getTime() })
    await expect(f.request('/api/webmail/disk-usage/preview?folder=INBOX&seen=true')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'folder_too_large' } })
  })
  it('moves exactly the previewed set to Trash and re-reads both folders', async () => {
    const f = harness(), { body } = await f.request('/api/webmail/disk-usage/cleanup', { folder: 'INBOX', uidValidity: 17, criteria: { olderThanDays: 365 }, uids: [1, 2] })
    expect(f.effects()).toEqual(['MOVE 1,2 Trash'])
    expect(body).toMatchObject({ operation: 'move-to-trash', outcome: 'confirmed', requested: 2, completed: 2, stateChanged: true, folders: [{ folder: 'INBOX', messages: 1 }, { folder: 'Trash', messages: 3 }] })
    expect(body.verificationRequired).toBeUndefined()
  })
  it.each([
    [{ folder: 'INBOX', uidValidity: 18, criteria: { olderThanDays: 365 }, uids: [1] }, 'CONFLICT'],
    [{ folder: 'INBOX', uidValidity: 17, criteria: { olderThanDays: 365 }, uids: [1, 3] }, 'CONFLICT'],
    [{ folder: 'Trash', uidValidity: 41, criteria: { seen: true }, uids: [9] }, 'VALIDATION'],
    [{ folder: 'INBOX', uidValidity: 17, criteria: {}, uids: [1] }, 'VALIDATION'],
    [{ folder: 'INBOX', uidValidity: 17, criteria: { seen: true }, uids: Array.from({ length: 5001 }, (_, index) => index + 1) }, 'VALIDATION'],
    [{ folder: 'INBOX', uidValidity: 17, criteria: { seen: true }, uids: [1, 1] }, 'VALIDATION'],
    [{ folder: 'INBOX', uidValidity: 17, criteria: { seen: true }, uids: [1], mailbox: 'bob@example.test' }, 'VALIDATION'],
  ])('refuses a stale, changed or unsupported cleanup %# before moving anything', async (input, code) => {
    const f = harness()
    await expect(f.request('/api/webmail/disk-usage/cleanup', input)).rejects.toMatchObject({ code, detail: { stateChanged: false } })
    expect(f.effects()).toEqual([])
  })
  it('reports a partial move for review and a proven refusal as unchanged', async () => {
    const f = harness(); f.fake.moveOnly = [1]
    expect((await f.request('/api/webmail/disk-usage/cleanup', { folder: 'INBOX', uidValidity: 17, criteria: { olderThanDays: 365 }, uids: [1, 2] })).body).toMatchObject({ outcome: 'partial', completed: 1, remaining: [2], verificationRequired: true })
    const g = harness(); g.fake.refuseMove = true
    await expect(g.request('/api/webmail/disk-usage/cleanup', { folder: 'INBOX', uidValidity: 17, criteria: { olderThanDays: 365 }, uids: [1, 2] })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, reason: 'cleanup_refused' } })
  })
  it('deletes permanently only from Trash with a confirmation naming folder and count', async () => {
    const f = harness(), input = { folder: 'Trash', uidValidity: 41, criteria: { seen: true }, uids: [9] }
    await expect(f.request('/api/webmail/disk-usage/purge', input)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.request('/api/webmail/disk-usage/purge', { ...input, confirm: { folder: 'Trash', count: 2 } })).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'confirmation_required' } })
    await expect(f.request('/api/webmail/disk-usage/purge', { folder: 'INBOX', uidValidity: 17, criteria: { seen: true }, uids: [1], confirm: { folder: 'INBOX', count: 1 } })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(f.effects()).toEqual([])
    const { body } = await f.request('/api/webmail/disk-usage/purge', { ...input, confirm: { folder: 'Trash', count: 1 } })
    expect(f.effects()).toEqual(['EXPUNGE Trash 9'])
    expect(body).toMatchObject({ operation: 'delete-permanently', outcome: 'confirmed', completed: 1, folders: [{ folder: 'Trash', messages: 0 }] })
  })
})
