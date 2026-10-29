import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SealedMailboxSession } from './folder-admin.ts'
import { forwardsBackTo, handleMailboxForwardersRoute, mailboxForwardersRevision, MAILBOX_FORWARD_LIMIT } from './mailbox-forwarders.ts'
import type { MailboxForwardersPorts } from './mailbox-forwarders.ts'

const MAILBOX = 'alice@example.test', ACCOUNT = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222'
const session = (over: Partial<SealedMailboxSession['record']> = {}): SealedMailboxSession => ({ record: { sessionId: 's1', mailbox: MAILBOX, accountId: ACCOUNT, serviceUserId: 'u1', ...over }, password: 'sealed' })
const record = (id: string, sourceAddress: string, destinations: string[], accountId: string | null = ACCOUNT) => ({ id, accountId, sourceAddress, destinations, createdAt: '2026-10-27T10:00:00.000Z' })
let root = ''
const path = (name = 'forwarders.json') => join(root, 'extended', 'mail', name)
const seed = async (list: unknown, name = 'forwarders.json') => { await mkdir(join(root, 'extended', 'mail'), { recursive: true }); await writeFile(path(name), JSON.stringify(list)) }
const saved = async () => JSON.parse(await readFile(path(), 'utf8')) as Array<Record<string, unknown>>

function harness(options: { sessions?: SealedMailboxSession[]; cap?: number | 'unlimited'; audit?: MailboxForwardersPorts['audit']; status?: string } = {}) {
  let call = 0
  const audit = vi.fn(options.audit ?? (async () => undefined))
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const ports: MailboxForwardersPorts = {
    open: async () => options.sessions?.[Math.min(call++, options.sessions.length - 1)] ?? session(),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }),
      getAccount: async (id: string) => id === ACCOUNT ? { id, status: options.status ?? 'active', planId: 'p1' } : null,
      getPlan: async () => ({ caps: { forwarders: options.cap ?? 'unlimited' } }) } as unknown as MailboxForwardersPorts['store'],
    audit, now: () => new Date('2026-10-27T12:00:00.000Z'),
  }
  const send = (method = 'GET', body?: unknown, query = '') => handleMailboxForwardersRoute(new Request('http://api.test/api/webmail/forwarders' + query, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    new URL('http://api.test/api/webmail/forwarders' + query), method, ports)
  const read = async () => (await (await send())!.json()) as Record<string, any>
  return { ports, audit, lease, send, read }
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-mbx-fwd-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('mailbox forwarders view', () => {
  it('shows only the sealed mailbox record and never another mailbox or account', async () => {
    await seed([record('r1', 'bob@example.test', ['x@remote.test']), record('r2', 'ALICE@example.test', ['a@remote.test', 'b@remote.test'])])
    const view = await harness().read()
    expect(view).toMatchObject({ context: { mailbox: MAILBOX }, forwarding: { id: 'r2', destinations: ['a@remote.test', 'b@remote.test'], keepCopy: true }, limit: MAILBOX_FORWARD_LIMIT, review: null,
      application: { status: 'configuration_only', nativeApplied: false } })
    expect(view.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(view)).not.toContain('bob@example.test')
  })
  it('reports another account record for the address as managed elsewhere and refuses writes', async () => {
    await seed([record('r1', MAILBOX, ['x@remote.test'], OTHER)])
    const h = harness(), view = await h.read()
    expect(view).toMatchObject({ forwarding: null, review: 'managed_elsewhere' })
    await expect(h.send('PUT', { destinations: ['y@remote.test'], keepCopy: true, expectedRevision: view.revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'managed_elsewhere', stateChanged: false } })
    expect(await saved()).toEqual([record('r1', MAILBOX, ['x@remote.test'], OTHER)])
  })
  it('refuses selectors, other methods and a malformed shared file', async () => {
    const h = harness()
    await expect(h.send('GET', undefined, '?mailbox=bob@example.test')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await h.send('POST', {}))!.status).toBe(405)
    await seed({ not: 'a list' })
    await expect(h.read()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'forwarders_unreadable' } })
  })
})

describe('mailbox forwarder writes', () => {
  it('creates, updates and deletes only the record whose source is the sealed mailbox', async () => {
    const neighbor = record('n1', 'bob@example.test', ['bob@remote.test'])
    await seed([neighbor])
    const h = harness()
    const created = await (await h.send('PUT', { destinations: ['Ext@Remote.test'], keepCopy: true, expectedRevision: (await h.read()).revision }))!.json()
    expect(created).toMatchObject({ stateChanged: true, operation: 'created', forwarding: { destinations: ['ext@remote.test'], keepCopy: true }, application: { nativeApplied: false } })
    let list = await saved()
    expect(list[0]).toEqual(neighbor)
    expect(list[1]).toMatchObject({ accountId: ACCOUNT, sourceAddress: MAILBOX, destinations: ['ext@remote.test'], createdAt: '2026-10-27T12:00:00.000Z' })
    const updated = await (await h.send('PUT', { destinations: ['ext@remote.test', 'two@remote.test'], keepCopy: true, expectedRevision: created.revision }))!.json()
    expect(updated).toMatchObject({ operation: 'updated', forwarding: { id: created.forwarding.id, destinations: ['ext@remote.test', 'two@remote.test'] } })
    const deleted = await (await h.send('PUT', { destinations: [], keepCopy: true, expectedRevision: updated.revision }))!.json()
    expect(deleted).toMatchObject({ operation: 'deleted', forwarding: null })
    list = await saved()
    expect(list).toEqual([neighbor])
    expect(h.audit.mock.calls.map(([, event]) => event.action)).toEqual(['webmail.forwarder.created', 'webmail.forwarder.updated', 'webmail.forwarder.deleted'])
    expect(h.audit.mock.calls[0]![1]).toMatchObject({ mailbox: MAILBOX, detail: { destinations: ['ext@remote.test'], keepCopy: true } })
    expect(h.lease.release).toHaveBeenCalledTimes(3)
  })
  it('returns an unchanged view without writing or auditing when nothing differs', async () => {
    await seed([record('r1', MAILBOX, ['ext@remote.test'])])
    const h = harness(), view = await h.read()
    expect(await (await h.send('PUT', { destinations: ['ext@remote.test'], keepCopy: true, expectedRevision: view.revision }))!.json()).toMatchObject({ stateChanged: false })
    expect(h.audit).not.toHaveBeenCalled()
  })
  it('refuses forwarding to itself or to an address that forwards back on this server', async () => {
    await seed([record('b1', 'bob@example.test', ['alice@example.test']), record('c1', 'carol@example.test', ['dave@other.test'])])
    await seed([{ id: 'd1', accountId: ACCOUNT, sourceDomain: 'mirror.test', targetDomain: 'example.test', createdAt: '2026-10-27T10:00:00.000Z' }], 'domain-forwarders.json')
    const h = harness(), revision = (await h.read()).revision, before = await saved()
    for (const target of ['alice@example.test', 'bob@example.test', 'alice@mirror.test']) {
      await expect(h.send('PUT', { destinations: ['ok@remote.test', target], keepCopy: true, expectedRevision: revision })).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'FORWARD_LOOP', destination: target, stateChanged: false } })
    }
    expect(await saved()).toEqual(before)
    expect((await (await h.send('PUT', { destinations: ['carol@example.test'], keepCopy: true, expectedRevision: revision }))!.json()).operation).toBe('created')
  })
  it('enforces the address limit, grammar, keep-a-copy, exact keys and the plan cap', async () => {
    const h = harness({ cap: 1 }), revision = (await h.read()).revision
    const put = (body: Record<string, unknown>) => h.send('PUT', { destinations: ['ext@remote.test'], keepCopy: true, expectedRevision: revision, ...body })
    await expect(put({ destinations: Array.from({ length: MAILBOX_FORWARD_LIMIT + 1 }, (_, i) => `u${i}@remote.test`) })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', detail: { reason: 'forward_limit' } })
    for (const destinations of [['|/bin/sh@remote.test'], ['a b@remote.test'], ['ext@remote.test', 'EXT@remote.test'], ['no-at-sign'], 'ext@remote.test'])
      await expect(put({ destinations })).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    await expect(put({ keepCopy: false })).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'keep_copy_required' } })
    await expect(put({ mailbox: 'bob@example.test' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(put({ expectedRevision: 'A'.repeat(64) })).rejects.toMatchObject({ code: 'VALIDATION' })
    await seed([record('r9', 'zed@example.test', ['z@remote.test'])])
    await expect(h.send('PUT', { destinations: ['ext@remote.test'], keepCopy: true, expectedRevision: (await h.read()).revision })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'account_forwarder_limit' } })
    expect(await saved()).toHaveLength(1)
  })
  it('returns 409 for a stale revision and leaves the file unchanged', async () => {
    await seed([record('r1', MAILBOX, ['ext@remote.test'])])
    const h = harness(), stale = mailboxForwardersRevision(MAILBOX, ACCOUNT, [])
    await expect(h.send('PUT', { destinations: ['new@remote.test'], keepCopy: true, expectedRevision: stale })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(await saved()).toEqual([record('r1', MAILBOX, ['ext@remote.test'])])
  })
  it('re-checks the sealed session before the write and refuses an inactive account', async () => {
    const changed = harness({ sessions: [session(), session(), session(), session({ serviceUserId: 'u2' })] })
    const revision = (await changed.read()).revision
    await expect(changed.send('PUT', { destinations: ['ext@remote.test'], keepCopy: true, expectedRevision: revision })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    await expect(readFile(path(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(harness({ status: 'suspended' }).send('PUT', { destinations: ['ext@remote.test'], keepCopy: true, expectedRevision: revision })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('reports an unrecorded change as requiring verification', async () => {
    const h = harness({ audit: async () => { throw new Error('audit down') } })
    await expect(h.send('PUT', { destinations: ['ext@remote.test'], keepCopy: true, expectedRevision: (await h.read()).revision })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true } })
    expect((await saved())[0]).toMatchObject({ sourceAddress: MAILBOX })
  })
})

describe('forwarding loop graph', () => {
  it('follows exact entries before domain forwarders and stops at cycles', () => {
    const forwarders = [record('1', 'x@a.test', ['y@b.test']), record('2', 'y@b.test', ['x@a.test']), record('3', 'z@c.test', ['q@remote.test'])]
    const domains = [{ id: 'd', accountId: null, sourceDomain: 'c.test', targetDomain: 'example.test', createdAt: '' }]
    expect(forwardsBackTo('x@a.test', MAILBOX, forwarders, domains)).toBe(false)
    expect(forwardsBackTo('alice@c.test', MAILBOX, forwarders, domains)).toBe(true)
    expect(forwardsBackTo('z@c.test', 'z@example.test', forwarders, domains)).toBe(false)
  })
})
