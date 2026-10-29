import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiToken, createResellerPrincipal, createTestDb, createUserPrincipal } from '@xpanel/db'
import * as dbApi from '@xpanel/db'
import { XpanelError } from '@xpanel/core'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const route = '/api/mail/filters'
const application = { generationId: null }
const cleanup: Array<() => Promise<unknown>> = []
type Scope = 'global' | 'mailbox'
interface FilterRecord {
  id: string; accountId: string | null; scope: Scope; mailbox: string | null; name: string
  priority: number; enabled: boolean; matchAll: boolean
  conditions: Array<{ field: string; comparator: string; value: string; headerName?: string }>
  actions: Array<{ type: string; target?: string }>; compiledSieve: string; createdAt: string
}
interface FilterView {
  filters: FilterRecord[]; context: { accountId: string; scope: Scope; mailbox: string | null }
  revision: string; application: typeof application
  compilation: { status: 'ready' | 'blocked' | 'selection_required'; reason?: string }
  compiledSieve: string | null
}

const draft = (patch: Record<string, unknown> = {}) => ({
  scope: 'global', name: 'Invoice routing', conditions: [{ field: 'subject', comparator: 'contains', value: 'invoice' }],
  actions: [{ type: 'fileinto', target: 'Billing' }], ...patch,
})

const fixture = async () => {
  const database = await createTestDb()
  cleanup.push(() => database.close())
  const state = await createTestStateStore()
  cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Filter policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Filter plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = async (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null,
    contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.10', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const owner = await account('owner8')
  const other = await account('other8')
  const inbox = await state.store.createServiceUser({ accountId: owner.id, login: `inbox@${owner.primaryDomain}`, passwordHash: HASH,
    services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const sibling = await state.store.createServiceUser({ accountId: owner.id, login: `support@${owner.primaryDomain}`, passwordHash: HASH,
    services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const foreignMailbox = await state.store.createServiceUser({ accountId: other.id, login: `inbox@${other.primaryDomain}`, passwordHash: HASH,
    services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const principal = await createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: 'filter-synthetic-server-secret-at-least-32-bytes' })
  const token = async (scopes: string[], principalId = principal.id) => {
    const raw = `xp_${randomUUID()}`
    await createApiToken(database.db, { principalId, name: 'Synthetic filter test', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const credential = await token(['mail:read', 'mail:write'])
  const mailboxToken = await token([`mailbox:${inbox.id}`, 'mail:read', 'mail:write'])
  const siblingToken = await token([`mailbox:${sibling.id}`, 'mail:read', 'mail:write'])
  const request = (path: string, method = 'GET', body?: unknown, raw = credential) => app.fetch(new Request(`http://localhost${path}`, { method,
    headers: { authorization: `Bearer ${raw}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  const path = join(state.rootDir, 'extended', 'mail', 'filters.json')
  const bytes = async () => { try { return await readFile(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error } }
  const record = (patch: Partial<FilterRecord> = {}): FilterRecord => ({ id: randomUUID(), accountId: owner.id, scope: 'global', mailbox: null,
    name: 'Seeded rule', priority: 1, enabled: true, matchAll: true, conditions: [{ field: 'subject', comparator: 'contains', value: 'invoice' }],
    actions: [{ type: 'keep' }], compiledSieve: '', createdAt: '2026-01-01T00:00:00.000Z', ...patch })
  return { database, state, features, owner, other, inbox, sibling, foreignMailbox, principal, token, request, credential, mailboxToken, siblingToken, path, bytes, record }
}

describe('mail-filter configuration HTTP security acceptance with disposable state', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    vi.restoreAllMocks()
    const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Synthetic filter fixture cleanup failed')
  })
  const query = (scope: Scope = 'global', mailbox?: string) => `${route}?scope=${scope}${mailbox ? `&mailbox=${encodeURIComponent(mailbox)}` : ''}`
  const view = async (scope: Scope = 'global', mailbox?: string, token = f.credential) => {
    const response = await f.request(query(scope, mailbox), 'GET', undefined, token)
    expect(response.status).toBe(200)
    const body = await response.json() as FilterView
    expect(body.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(body.application).toEqual(application)
    return body
  }
  const create = async (body: unknown = draft(), token = f.credential) => {
    const response = await f.request(route, 'POST', body, token)
    expect(response.status).toBe(201)
    const result = await response.json() as FilterView & { filter: FilterRecord }
    expect(result.application).toEqual(application)
    return result
  }
  const persisted = async () => JSON.parse(await f.bytes() ?? '[]') as FilterRecord[]

  it('edits and toggles a stable record before deleting it with fresh scope revisions', async () => {
    const created = await create()
    const initial = created.filter
    let current = await view()
    const edited = await f.request(`${route}/${initial.id}`, 'PATCH', { name: 'Edited invoice rule', enabled: false, expectedRevision: current.revision })
    expect(edited.status).toBe(200)
    expect(await edited.json()).toMatchObject({ application, filter: { id: initial.id, createdAt: initial.createdAt, accountId: f.owner.id, scope: 'global', mailbox: null, enabled: false, name: 'Edited invoice rule' } })
    current = await view()
    expect(current.compiledSieve).not.toContain('Edited invoice rule')
    expect((await f.request(`${route}/${initial.id}`, 'PATCH', { enabled: true, expectedRevision: current.revision })).status).toBe(200)
    current = await view()
    expect(current.filters[0]).toMatchObject({ id: initial.id, createdAt: initial.createdAt, enabled: true })
    const removed = await f.request(`${route}/${initial.id}`, 'DELETE', { expectedRevision: current.revision })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ application, ok: true })
    expect((await view()).filters).toEqual([])
  })

  it('dry-runs a sample message through account-wide then mailbox rules without writing, hiding rules the caller may not read', async () => {
    await create(draft({ name: 'Copy invoices to the bookkeeper', actions: [{ type: 'redirect', target: 'books@ledger.example.test' }] }))
    const mailboxRule = draft({ scope: 'mailbox', mailbox: f.inbox.login, name: 'File invoices',
      conditions: [{ field: 'subject', comparator: 'contains', value: 'invoice' }, { field: 'from', comparator: 'contains', value: '@supplier.example' }],
      actions: [{ type: 'fileinto', target: 'Invoices' }, { type: 'mark-read' }, { type: 'stop' }] })
    await create(mailboxRule)
    await create(draft({ scope: 'mailbox', mailbox: f.inbox.login, name: 'Never reached', conditions: [], actions: [{ type: 'discard' }] }))
    const before = await f.bytes()
    const message = { from: 'Billing <ar@supplier.example>', to: f.inbox.login, subject: 'Invoice 42', body: 'Attached.' }
    const test = (body: unknown, token = f.credential) => f.request(`${route}/test`, 'POST', body, token)

    const owner = await test({ scope: 'mailbox', mailbox: f.inbox.login, message })
    expect(owner.status).toBe(200)
    const trace = await owner.json() as { rules: Array<Record<string, unknown>>; notRun: number; outcome: Record<string, unknown> }
    expect(trace.rules.map(rule => [rule.name, rule.scope, rule.matched, rule.stopped])).toEqual([
      ['Copy invoices to the bookkeeper', 'global', true, false], ['File invoices', 'mailbox', true, true]])
    expect(trace.rules[1]!.tests).toEqual([
      { field: 'subject', comparator: 'contains', value: 'invoice', actual: ['Invoice 42'], matched: true },
      { field: 'from', comparator: 'contains', value: '@supplier.example', actual: ['Billing <ar@supplier.example>'], matched: true }])
    expect(trace.notRun).toBe(1)
    expect(trace.outcome).toEqual({ folders: ['Invoices'], redirects: ['books@ledger.example.test'], discarded: false, rejected: null, markedRead: true, stopped: true })

    // the mailbox owner sees that an account-wide rule ran, never its name, values or address
    const own = await (await test({ message }, f.mailboxToken)).json() as typeof trace
    expect(own.rules[0]).toEqual({ id: null, name: null, scope: 'global', hidden: true, matched: true, stopped: false, tests: [], actions: [{ type: 'redirect' }] })
    expect(own.outcome.redirects).toEqual([null])
    expect(JSON.stringify(own)).not.toContain('ledger')

    expect((await test({ scope: 'mailbox', mailbox: f.inbox.login, message }, f.siblingToken)).status).toBe(404)
    expect((await test({ scope: 'mailbox', mailbox: f.inbox.login, message: { subject: 'a\nBcc: x' } })).status).toBe(422)
    expect((await test({ scope: 'global', message, extra: true })).status).toBe(422)
    expect(await f.bytes()).toBe(before)
  })

  it('reads deterministic revisions without allocating state and binds even empty revisions to their context', async () => {
    const before = await f.bytes()
    const first = await view()
    expect((await view()).revision).toBe(first.revision)
    const mailbox = await view('mailbox', f.inbox.login)
    const sibling = await view('mailbox', f.sibling.login)
    expect(new Set([first.revision, mailbox.revision, sibling.revision]).size).toBe(3)
    expect(first.context).toMatchObject({ accountId: f.owner.id, scope: 'global', mailbox: null })
    expect(mailbox.context).toMatchObject({ accountId: f.owner.id, scope: 'mailbox', mailbox: f.inbox.login })
    expect(await f.bytes()).toBe(before)
  })

  it('keeps global, selected mailbox, sibling, foreign and server records out of each other previews', async () => {
    const global = f.record({ name: 'OWN_GLOBAL' })
    const mailbox = f.record({ name: 'OWN_INBOX', scope: 'mailbox', mailbox: f.inbox.login })
    const sibling = f.record({ name: 'SIBLING_PRIVATE', scope: 'mailbox', mailbox: f.sibling.login })
    const foreign = f.record({ name: 'FOREIGN_PRIVATE', accountId: f.other.id })
    const server = f.record({ name: 'SERVER_PRIVATE', accountId: null })
    await atomicWriteJson(f.path, [global, mailbox, sibling, foreign, server])
    const wide = await view()
    expect(wide.filters.map(item => item.id)).toEqual([global.id])
    const selected = await view('mailbox', f.inbox.login)
    expect(selected.filters.map(item => item.id)).toEqual([mailbox.id])
    for (const marker of ['OWN_GLOBAL', 'SIBLING_PRIVATE', 'FOREIGN_PRIVATE', 'SERVER_PRIVATE']) expect(selected.compiledSieve).not.toContain(marker)
    expect(JSON.stringify(wide)).not.toMatch(/FOREIGN_PRIVATE|SERVER_PRIVATE/)
    const inventory = await f.request(route)
    expect(inventory.status).toBe(200)
    expect(await inventory.json()).toMatchObject({ application, compilation: { status: 'selection_required' }, compiledSieve: null })
  })

  it('binds mailbox legacy records by account as well as scope and normalized address', async () => {
    const foreign = f.record({ name: 'FOREIGN_SAME_ADDRESS', accountId: f.other.id, scope: 'mailbox', mailbox: f.inbox.login })
    const own = f.record({ name: 'OWN_MAILBOX', scope: 'mailbox', mailbox: f.inbox.login })
    await atomicWriteJson(f.path, [foreign, own])
    const selected = await view('mailbox', f.inbox.login, f.mailboxToken)
    expect(selected.filters.map(item => item.id)).toEqual([own.id])
    expect(JSON.stringify(selected)).not.toContain('FOREIGN_SAME_ADDRESS')
    const before = await f.bytes()
    expect((await f.request(`${route}/${foreign.id}`, 'DELETE', {}, f.mailboxToken)).status).toBe(404)
    expect(await f.bytes()).toBe(before)
    expect((await f.request(`${route}/${own.id}`, 'DELETE', { expectedRevision: selected.revision }, f.mailboxToken)).status).toBe(200)
    expect(await persisted()).toEqual([foreign])
  })

  it('denies foreign record mutation before revealing a revision or requiring one', async () => {
    const foreign = f.record({ accountId: f.other.id, name: 'FOREIGN_REVISION_MARKER' })
    await atomicWriteJson(f.path, [foreign])
    const before = await f.bytes()
    for (const method of ['PATCH', 'DELETE']) {
      const response = await f.request(`${route}/${foreign.id}`, method, {})
      expect([403, 404]).toContain(response.status)
      expect(await response.text()).not.toMatch(/FOREIGN_REVISION_MARKER|expectedRevision/)
    }
    expect([403, 404]).toContain((await f.request(route, 'POST', draft({ accountId: f.other.id }))).status)
    expect([403, 404]).toContain((await f.request(route, 'POST', draft({ scope: 'mailbox', mailbox: f.foreignMailbox.login }))).status)
    expect(await f.bytes()).toBe(before)
  })

  it('confines mailbox tokens to their own mailbox and cannot switch into global or sibling contexts', async () => {
    const own = await create(draft({ scope: 'mailbox', mailbox: f.inbox.login }), f.mailboxToken)
    expect((await f.request(query('mailbox', f.inbox.login), 'GET', undefined, f.siblingToken)).status).toBe(404)
    expect((await f.request(route, 'POST', draft({ scope: 'global' }), f.mailboxToken)).status).toBe(403)
    expect((await f.request(route, 'POST', draft({ scope: 'mailbox', mailbox: f.sibling.login }), f.mailboxToken)).status).toBe(404)
    expect((await f.request(`${route}/${own.filter.id}`, 'DELETE', {}, f.siblingToken)).status).toBe(404)
  })

  it('requires mutation scopes for every write family despite a valid selected-scope revision', async () => {
    const created = await create()
    const selected = await view()
    const readonly = await f.token(['mail:read'])
    const before = await f.bytes()
    const attempts: Array<[string, string, unknown]> = [
      [route, 'POST', draft()], [`${route}/${created.filter.id}`, 'PATCH', { enabled: false, expectedRevision: selected.revision }],
      [`${route}/${created.filter.id}`, 'DELETE', { expectedRevision: selected.revision }],
      [`${route}/reorder`, 'POST', { scope: 'global', orderedIds: [created.filter.id], expectedRevision: selected.revision }],
    ]
    for (const [path, method, body] of attempts) expect((await f.request(path, method, body, readonly)).status).toBe(403)
    expect(await f.bytes()).toBe(before)
    expect((await f.request(query(), 'GET', undefined, await f.token(['mail:write']))).status).toBe(403)
  })

  it.each(['global', 'mailbox'] as const)('rechecks the %s filter feature after a previously permitted view', async scope => {
    const mailbox = scope === 'mailbox' ? f.inbox.login : undefined
    await view(scope, mailbox)
    await f.state.store.updateFeatureList(f.features.id, { disabled: [scope === 'global' ? 'global-email-filters' : 'email-filters'] })
    const before = await f.bytes()
    expect((await f.request(query(scope, mailbox))).status).toBe(403)
    expect((await f.request(route, 'POST', draft({ scope, ...(mailbox ? { mailbox } : {}) }))).status).toBe(403)
    expect(await f.bytes()).toBe(before)
  })

  it.each(['suspended', 'email-disabled', 'mailbox-deleted'] as const)('revokes a mailbox token after %s without saving another rule', async state => {
    await view('mailbox', f.inbox.login, f.mailboxToken)
    if (state === 'suspended') await f.state.store.suspendAccount(f.owner.id, 'Synthetic filter hold')
    if (state === 'email-disabled') await f.state.store.updateServiceUser(f.inbox.id, { services: { email: false, ftp: true, webdisk: false } })
    if (state === 'mailbox-deleted') await f.state.store.deleteServiceUser(f.inbox.id)
    const before = await f.bytes()
    expect([403, 404]).toContain((await f.request(route, 'POST', draft({ scope: 'mailbox', mailbox: f.inbox.login }), f.mailboxToken)).status)
    expect(await f.bytes()).toBe(before)
  })

  it('rechecks reseller ACL after a permitted account-scoped write', async () => {
    const reseller = await f.state.store.createReseller({ username: 'reseller8', passwordHash: HASH, acl: ['list-accounts', 'edit-account'], maxAccounts: 10,
      totalDiskMb: 10000, totalBandwidthMb: 'unlimited', oversell: false, nameservers: [], delegatedIps: [] })
    await f.state.store.changeOwner(f.owner.id, reseller.id)
    const principal = await createResellerPrincipal(f.database.db, { id: reseller.id, username: reseller.username, passwordHash: HASH })
    const raw = await f.token(['mail:read', 'mail:write'], principal.id)
    await create(draft({ accountId: f.owner.id }), raw)
    await f.state.store.updateReseller(reseller.id, { acl: ['list-accounts'] })
    const before = await f.bytes()
    expect((await f.request(route, 'POST', draft({ accountId: f.owner.id }), raw)).status).toBe(403)
    expect(await f.bytes()).toBe(before)
  })

  const invalidDrafts = [null, [], 'rule', { name: 'Name-only must not invent spam filtering' },
    draft({ conditions: null }), draft({ conditions: [null] }), draft({ enabled: 'false' }), draft({ matchAll: 1 }), draft({ priority: 1.5 }),
    draft({ scope: 'mailbox', mailbox: null }), draft({ scope: 'unknown' }), draft({ name: 'comment\nkeep; #' }),
    draft({ conditions: [{ field: 'size', comparator: 'over', value: '0; } discard; #' }] }),
    draft({ conditions: [{ field: 'size', comparator: 'contains', value: '100' }] }),
    draft({ conditions: [{ field: 'header', headerName: 'X-Test"; discard; #', comparator: 'is', value: 'yes' }] }),
    draft({ conditions: [{ field: 'header', headerName: 'X-Test\r\nInjected', comparator: 'is', value: 'yes' }] }),
    draft({ conditions: [{ field: 'unknown', comparator: 'is', value: 'yes' }] }),
    draft({ actions: [{ type: 'redirect', target: '|command' }] }), draft({ actions: [{ type: 'fileinto', target: 'Folder\u0085Injected' }] }),
    draft({ actions: [{ type: 'discard', target: 'unexpected' }] }), draft({ actions: [{ type: 'unknown' }] }),
    draft({ actions: [{ type: 'keep' }, { type: 'discard' }] }), draft({ actions: [] }), draft({ actions: undefined, action: { type: 'keep' } }),
  ]
  it.each(invalidDrafts.map((body, index) => ({ index, body })))('rejects unsafe or malformed draft $index before persistence', async ({ body }) => {
    await atomicWriteJson(f.path, [f.record()])
    const before = await f.bytes()
    const response = await f.request(route, 'POST', body)
    expect.soft(response.status).toBe(422)
    expect(await f.bytes()).toBe(before)
  })

  it('preserves quoted text, deliberate unconditional matching, several actions and the field alias', async () => {
    const text = 'Invoice "quoted" \\ archive'
    const created = await create(draft({ conditions: [{ field: 'Subject', comparator: 'contains', value: text }],
      actions: [{ type: 'fileinto', target: 'Orders.2026 priority & archive' }, { type: 'mark-read' }, { type: 'stop' }] }))
    expect(created.filter.conditions[0]).toMatchObject({ field: 'subject', value: text })
    expect(created.filter.actions).toEqual([{ type: 'fileinto', target: 'Orders.2026 priority & archive' }, { type: 'mark-read' }, { type: 'stop' }])
    expect(created.compilation.status).toBe('ready')
    expect(created.compiledSieve).toContain('\\"quoted\\"')
    expect(created.compiledSieve).toContain('\\\\ archive')
    const unconditional = await create(draft({ name: 'Deliberate unconditional keep', conditions: [], actions: [{ type: 'keep' }] }))
    expect(unconditional.filter.conditions).toEqual([])
    expect(unconditional.compiledSieve).toContain('if true')
  })

  it('retains body comparator meaning and parses size before emitting numeric syntax', async () => {
    const created = await create(draft({ conditions: [{ field: 'body', comparator: 'is', value: 'exact body' }, { field: 'size', comparator: 'under', value: '1K' }] }))
    expect(created.compiledSieve).toMatch(/body[^\n]*:is/)
    expect(created.compiledSieve).toContain('size :under 1024')
    expect(created.compiledSieve).not.toContain('size :under 1K')
  })

  it('derives default priority from the selected scope rather than unrelated collection length', async () => {
    await atomicWriteJson(f.path, Array.from({ length: 8 }, (_, index) => f.record({ accountId: f.other.id, name: `Foreign ${index}` })))
    const created = await create()
    expect(created.filter.priority).toBe(1)
    expect((await persisted()).filter(item => item.accountId === f.other.id)).toHaveLength(8)
  })

  it.each(['PATCH', 'DELETE', 'reorder'] as const)('requires a revision for %s after authorizing the target', async operation => {
    const created = await create()
    const before = await f.bytes()
    const response = operation === 'reorder'
      ? await f.request(`${route}/reorder`, 'POST', { scope: 'global', orderedIds: [created.filter.id] })
      : await f.request(`${route}/${created.filter.id}`, operation, operation === 'PATCH' ? { enabled: false } : {})
    expect(response.status).toBe(412)
    expect(await response.json()).toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await f.bytes()).toBe(before)
  })

  it.each(['POST', 'PATCH', 'DELETE', 'reorder'] as const)('rejects a stale revision for %s without replacing current state', async operation => {
    const created = await create()
    const stale = (await view()).revision
    await create(draft({ name: 'A later rule' }))
    const before = await f.bytes()
    const response = operation === 'POST' ? await f.request(route, 'POST', draft({ expectedRevision: stale }))
      : operation === 'reorder' ? await f.request(`${route}/reorder`, 'POST', { scope: 'global', orderedIds: (await view()).filters.map(item => item.id), expectedRevision: stale })
        : await f.request(`${route}/${created.filter.id}`, operation, { ...(operation === 'PATCH' ? { enabled: false } : {}), expectedRevision: stale })
    expect(response.status).toBe(409)
    expect(await f.bytes()).toBe(before)
  })

  it('cannot use another empty scope revision as a version or an access grant', async () => {
    const mailbox = await view('mailbox', f.inbox.login)
    const before = await f.bytes()
    expect((await f.request(route, 'POST', draft({ expectedRevision: mailbox.revision }))).status).toBe(409)
    expect(await f.bytes()).toBe(before)
  })

  it('reorders the exact selected scope atomically while preserving identity and unrelated data', async () => {
    const owned = [f.record({ name: 'First', priority: 1 }), f.record({ name: 'Second', priority: 2 }), f.record({ name: 'Third', priority: 3 })]
    const unrelated = f.record({ accountId: f.other.id, name: 'Unrelated priority', priority: 7 })
    await atomicWriteJson(f.path, [...owned, unrelated])
    const selected = await view()
    const ids = owned.map(item => item.id).reverse()
    const response = await f.request(`${route}/reorder`, 'POST', { scope: 'global', orderedIds: ids, expectedRevision: selected.revision })
    expect(response.status).toBe(200)
    const reordered = await view()
    expect(reordered.filters.map(item => item.id)).toEqual(ids)
    expect(reordered.filters.map(item => item.priority)).toEqual([1, 2, 3])
    for (const item of reordered.filters) expect(item.createdAt).toBe(owned.find(original => original.id === item.id)!.createdAt)
    expect((await persisted()).find(item => item.id === unrelated.id)).toEqual(unrelated)
  })

  it.each(['duplicate', 'omitted', 'unknown', 'foreign'] as const)('refuses an invalid %s reorder ID set without touching any record', async kind => {
    const owned = [f.record(), f.record({ name: 'Second', priority: 2 })]
    const foreign = f.record({ accountId: f.other.id, name: 'FOREIGN_ORDER_MARKER' })
    await atomicWriteJson(f.path, [...owned, foreign])
    const selected = await view()
    const ids = kind === 'duplicate' ? [owned[0]!.id, owned[0]!.id] : kind === 'omitted' ? [owned[0]!.id]
      : [owned[0]!.id, kind === 'foreign' ? foreign.id : randomUUID()]
    const before = await f.bytes()
    const response = await f.request(`${route}/reorder`, 'POST', { scope: 'global', orderedIds: ids, expectedRevision: selected.revision })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(await response.text()).not.toContain('FOREIGN_ORDER_MARKER')
    expect(await f.bytes()).toBe(before)
  })

  it('preserves independent concurrent creates and rejects one concurrent edit of a stale shared revision', async () => {
    const writes = await Promise.all(['First', 'Second'].map(name => f.request(route, 'POST', draft({ name }))))
    expect(writes.map(response => response.status)).toEqual([201, 201])
    let selected = await view()
    expect(selected.filters.map(item => item.name).sort()).toEqual(['First', 'Second'])
    const target = selected.filters[0]!
    const changes = await Promise.all(['Winner A', 'Winner B'].map(name => f.request(`${route}/${target.id}`, 'PATCH', { name, expectedRevision: selected.revision })))
    expect(changes.map(response => response.status).sort()).toEqual([200, 409])
    selected = await view()
    expect(selected.filters).toHaveLength(2)
    expect(['Winner A', 'Winner B']).toContain(selected.filters.find(item => item.id === target.id)!.name)
  })

  it('blocks an invalid selected legacy preview while preserving raw data and excluding malformed foreign rules', async () => {
    const invalid = f.record({ name: 'Legacy\nInjected rule' })
    const foreign = f.record({ accountId: f.other.id, name: 'FOREIGN_LEGACY\nInjected' })
    await atomicWriteJson(f.path, [invalid, foreign])
    const before = await f.bytes()
    const selected = await view()
    expect(selected.compilation.status).toBe('blocked')
    expect(selected.compiledSieve).toBeNull()
    expect(JSON.stringify(selected)).not.toContain('FOREIGN_LEGACY')
    expect(await f.bytes()).toBe(before)
    expect((await f.request(`${route}/${invalid.id}`, 'DELETE', { expectedRevision: selected.revision })).status).toBe(200)
    const clean = await view()
    expect(clean.compilation.status).toBe('ready')
    expect(await persisted()).toEqual([foreign])
  })

  it('authorizes each inventory mailbox context independently of preceding record order', async () => {
    const own = f.record({ name: 'VISIBLE_INBOX', scope: 'mailbox', mailbox: f.inbox.login })
    const invalid = f.record({ name: 'FOREIGN_MAILBOX_IN_WRONG_ACCOUNT', scope: 'mailbox', mailbox: f.foreignMailbox.login })
    for (const rows of [[own, invalid], [invalid, own]]) {
      await atomicWriteJson(f.path, rows)
      const response = await f.request(route)
      expect(response.status).toBe(200)
      const body = await response.json() as FilterView
      expect(body.filters.map(item => item.id)).toEqual([own.id])
      expect(JSON.stringify(body)).not.toContain('FOREIGN_MAILBOX_IN_WRONG_ACCOUNT')
    }
  })

  it('bounds and sanitizes invalid legacy metadata in a mixed inventory without returning raw extra fields', async () => {
    const invalid = { ...f.record({ name: 'Broken\nlegacy name' }), diagnostic: 'RAW_LEGACY_DIAGNOSTIC', rawScript: 'RAW_LEGACY_SCRIPT' }
    const mailbox = f.record({ scope: 'mailbox', mailbox: f.inbox.login, name: 'Mailbox rule' })
    await atomicWriteJson(f.path, [invalid, mailbox])
    const before = await f.bytes()
    const response = await f.request(route)
    expect(response.status).toBe(200)
    const body = await response.json() as FilterView
    expect(body.compilation.status).toBe('selection_required')
    expect(body.compiledSieve).toBeNull()
    expect(JSON.stringify(body)).not.toMatch(/RAW_LEGACY_DIAGNOSTIC|RAW_LEGACY_SCRIPT/)
    const metadata = body.filters.find(item => item.id === invalid.id)
    expect(metadata).toBeDefined()
    if (metadata!.name !== null) {
      expect(metadata!.name.length).toBeLessThanOrEqual(128)
      expect(metadata!.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u)
    }
    for (const item of body.filters) expect(item.compiledSieve).toBeNull()
    expect(await f.bytes()).toBe(before)
  })

  it('preserves persisted execution order for equal priorities until an explicit reorder', async () => {
    const first = f.record({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'First existing', actions: [{ type: 'fileinto', target: 'FIRST_FOLDER' }] })
    const second = f.record({ id: '00000000-0000-4000-8000-000000000001', name: 'Second existing', actions: [{ type: 'fileinto', target: 'SECOND_FOLDER' }] })
    await atomicWriteJson(f.path, [first, second])
    const selected = await view()
    expect(selected.filters.map(item => item.id)).toEqual([first.id, second.id])
    expect(selected.compiledSieve).toContain('FIRST_FOLDER')
    expect(selected.compiledSieve).toContain('SECOND_FOLDER')
    expect(selected.compiledSieve!.indexOf('FIRST_FOLDER')).toBeLessThan(selected.compiledSieve!.indexOf('SECOND_FOLDER'))
    expect(await persisted()).toEqual([first, second])
  })

  it.each(['\u0085', '\u2028', '\u2029'])('rejects raw control-bearing mailbox selectors before trimming: %j', async control => {
    const before = await f.bytes()
    const response = await f.request(query('mailbox', control + f.inbox.login + control))
    expect(response.status).toBe(422)
    expect(await f.bytes()).toBe(before)
  })

  it.each(['token', 'principal'] as const)('revalidates queued %s credentials after acquiring the writer lease', async kind => {
    const before = await f.bytes()
    const lock = f.state.store.getWriterLock()
    const held = await lock.acquire()
    const acquire = lock.acquire.bind(lock)
    let queued!: () => void
    const reached = new Promise<void>(resolve => { queued = resolve })
    // This hook observes the real router's acquisition after its initial authentication.
    const spy = vi.spyOn(lock, 'acquire').mockImplementation((...args) => { queued(); return acquire(...args) })
    let timer: ReturnType<typeof setTimeout> | undefined
    let released = false
    const pending = f.request(route, 'POST', draft())
    try {
      await Promise.race([reached, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Filter request did not reach the queued writer checkpoint')), 5000) })])
      if (kind === 'token') await dbApi.revokeAllApiTokensForPrincipal(f.database.db, f.principal.id)
      else await dbApi.setPrincipalDisabled(f.database.db, f.principal.id, true)
      await held.release(); released = true
      const response = await pending
      expect(response.status).toBe(401)
      expect(await f.bytes()).toBe(before)
      expect((await dbApi.listAudit(f.database.db, { limit: 50 })).some(item => item.action === 'mail.filter.created' && item.outcome === 'ok')).toBe(false)
    } finally {
      if (timer) clearTimeout(timer)
      if (!released) await held.release()
      spy.mockRestore()
      await pending.catch(() => undefined)
    }
  })

  it('reports persisted configuration as uncertain when the later audit raises a known conflict', async () => {
    vi.spyOn(dbApi, 'appendAudit').mockRejectedValueOnce(new XpanelError('CONFLICT', 'Synthetic post-save audit conflict'))
    const response = await f.request(route, 'POST', draft({ name: 'Persisted before audit error' }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ details: { stateChanged: true, verificationRequired: true } })
    expect((await persisted()).map(item => item.name)).toEqual(['Persisted before audit error'])
    expect((await dbApi.listAudit(f.database.db, { limit: 50 })).some(item => item.action === 'mail.filter.created' && item.outcome === 'ok')).toBe(false)
  })
})
