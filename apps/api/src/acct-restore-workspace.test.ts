import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleComponentRestoreWorkspaceRoute } from './acct-restore-workspace.ts'
import type { ComponentRestoreWorkspacePorts } from './acct-restore-workspace.ts'

const FILE = 'xpanel-backup-alice-20261026T100000Z.tar.gz', REVISION = 'a'.repeat(64), SHA = 'b'.repeat(64), BOX = 'info@alice.example.test'
const MESSAGE = 'mail/alice.example.test/info/new/1700000001.M2.host'
const caller = (kind: string, extra: Record<string, unknown> = {}) => ({ principal: { kind, id: kind + '-1', username: kind }, sessionId: 'session-1', apiTokenId: null, scopes: [], ...extra }) as unknown as AuthenticatedCaller
const alice = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alice', uid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test', status: 'active', ownerId: 'reseller-1' } as unknown as Account
const context = { accountId: alice.id, username: 'alice' }
const archive = { file: FILE, bytes: 100, sha256: SHA, createdAt: '2026-10-26T10:00:00Z', integrity: 'verified' }
const components = { files: { state: 'available', files: 1, bytes: 3 }, mail: { state: 'available', truncated: false, mailboxes: [{ address: BOX, messages: 1, bytes: 11, current: 'exists' }] },
  mailSettings: { state: 'not-restorable', files: 0 }, databases: { state: 'not-in-archive', databases: [], restores: [] }, dns: { state: 'not-in-archive', zones: [] } }
const RESTORE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const replies: Record<string, unknown> = {
  inventory: { context, archive, components },
  preview: { context, archive, mailboxes: [BOX], rows: [{ path: MESSAGE, bytes: 11 }], counts: { messages: 1, present: 0, batch: 1, remaining: 0, refused: 0 }, quota: { limitMb: 'unlimited', plannedBytes: 11, fits: true }, writer: 'available', limits: {}, revision: REVISION },
  parts: { context, archive: { file: FILE, sha256: SHA }, restoreId: RESTORE_ID, state: 'running', databases: ['alice_wp'], zones: ['alice.example.test'] },
  restore: { context, archive, mailboxes: [BOX], results: [{ path: MESSAGE, bytes: 11, result: 'restored', reason: null, verificationRequired: false }], counts: { restored: 1, 'skipped-exists': 0, failed: 0, 'not-attempted': 0 }, createdDirectories: 0, complete: true, remaining: 0, verificationRequired: false, revision: REVISION },
}
const ports = (overrides: Partial<ComponentRestoreWorkspacePorts> = {}, reply: (op: string) => unknown = op => replies[op]) => {
  const forwarded: { path: string; body?: unknown }[] = []
  const value: ComponentRestoreWorkspacePorts = {
    requireCaller: vi.fn(async () => caller('root')),
    getAccountByUsername: vi.fn(async (username: string) => username === 'alice' ? alice : null),
    assertCanAccessAccount: vi.fn(async () => undefined),
    callAgent: vi.fn(async (path, options) => { forwarded.push({ path, body: options.body }); return Response.json(reply(path.split('/').at(-1)!)) }),
    ...overrides,
  }
  return { value, forwarded }
}
const call = (p: ComponentRestoreWorkspacePorts, op: string, body: unknown, method = 'POST', search = '') => {
  const url = new URL('http://localhost/api/backups/components/alice/' + op + search)
  return handleComponentRestoreWorkspaceRoute(new Request(url, method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method }), url, method, p)
}
const code = async (promise: Promise<unknown>): Promise<string> => promise.then(() => 'ok', (error: { code?: string; detail?: Record<string, unknown> }) => error.code ?? 'error')

describe('WHM component restore API', () => {
  it('forwards a strict request and returns a verified inventory', async () => {
    const { value, forwarded } = ports()
    const response = await call(value, 'inventory', { file: FILE })
    expect(response?.status).toBe(200)
    expect((await response!.json()).components).toEqual(components)
    expect(forwarded).toEqual([{ path: '/accounts/alice/backup-components/inventory', body: { file: FILE } }])
  })
  it('refuses other methods, selectors, mailbox principals, owners and unknown keys before the agent', async () => {
    const { value, forwarded } = ports()
    expect((await call(value, 'inventory', {}, 'GET'))?.status).toBe(405)
    expect(await code(call(value, 'inventory', { file: FILE }, 'POST', '?x=1'))).toBe('VALIDATION')
    expect(await code(call(value, 'inventory', { file: FILE, path: '/etc' }))).toBe('VALIDATION')
    expect(await code(call(ports({ requireCaller: vi.fn(async () => caller('user')) }).value, 'inventory', { file: FILE }))).toBe('FORBIDDEN')
    expect(await code(call(ports({ requireCaller: vi.fn(async () => caller('root', { principalKind: 'mailbox' })) }).value, 'inventory', { file: FILE }))).toBe('FORBIDDEN')
    expect(await code(call(ports({ callAgent: undefined }).value, 'inventory', { file: FILE }))).toBe('PRECONDITION_FAILED')
    expect(forwarded).toEqual([])
  })
  it('rejects agent replies bound to another account, archive or mailbox', async () => {
    for (const reply of [{ ...replies.inventory as object, context: { ...context, username: 'bob' } }, { ...replies.inventory as object, archive: { ...archive, file: 'xpanel-backup-alice-20261027T100000Z.tar.gz' } },
      { ...replies.inventory as object, components: { ...components, databases: { state: 'available' } } },
      { ...replies.inventory as object, components: { ...components, databases: { state: 'available', databases: [{ name: 'bob_wp', bytes: 1, current: 'exists' }], restores: [] } } },
      { ...replies.inventory as object, components: { ...components, databases: { state: 'available', databases: [{ name: 'alice_wp', bytes: 1, current: 'exists' }], restores: [{ id: RESTORE_ID, actor: 'root', username: 'bob', file: 'xpanel-backup-bob-20261026T100000Z.tar.gz', startedAt: '2026-10-26T10:00:00.000Z', finishedAt: null, state: 'running', items: [{ database: 'bob_wp', bytes: null, result: 'not-attempted', reason: 'interrupted' }] }] } } }])
      expect(await code(call(ports({}, () => reply).value, 'inventory', { file: FILE }))).toBe('PRECONDITION_FAILED')
    const other = { ...replies.preview as object, rows: [{ path: 'mail/alice.example.test/other/cur/1', bytes: 1 }] }
    expect(await code(call(ports({}, () => other).value, 'preview', { file: FILE, mailboxes: [BOX] }))).toBe('PRECONDITION_FAILED')
  })
  it('re-checks authority before the restore and marks an unverifiable outcome as requiring review', async () => {
    const { value } = ports()
    expect((await call(value, 'restore', { file: FILE, mailboxes: [BOX], expectedRevision: REVISION }))?.status).toBe(200)
    expect(value.requireCaller).toHaveBeenCalledTimes(2)
    const stale = { ...replies.restore as object, revision: 'c'.repeat(64) }
    const error = await call(ports({}, () => stale).value, 'restore', { file: FILE, mailboxes: [BOX], expectedRevision: REVISION }).catch(failure => failure)
    expect(error).toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: true, verificationRequired: true } })
  })
  it('forwards a part restore with fresh authority and accepts only a reply bound to the reviewed archive, databases and zones', async () => {
    const dumps = { state: 'available', databases: [{ name: 'alice_wp', bytes: 10, current: 'exists' }], restores: [{ id: RESTORE_ID, actor: 'root', username: 'alice', file: FILE, startedAt: '2026-10-26T10:00:00.000Z', finishedAt: '2026-10-26T10:01:00.000Z', state: 'finished', items: [{ part: 'database', name: 'alice_wp', bytes: 10, result: 'restored', reason: null }] }] }
    expect((await (await call(ports({}, () => ({ ...replies.inventory as object, components: { ...components, databases: dumps } })).value, 'inventory', { file: FILE }))!.json()).components.databases).toEqual(dumps)
    const zones = { state: 'available', zones: [{ name: 'alice.example.test', bytes: 50, current: 'exists' }] }
    expect((await (await call(ports({}, () => ({ ...replies.inventory as object, components: { ...components, dns: zones } })).value, 'inventory', { file: FILE }))!.json()).components.dns).toEqual(zones)
    await expect(call(ports({}, () => ({ ...replies.inventory as object, components: { ...components, dns: { state: 'available', zones: [{ name: '../x', bytes: 1, current: 'exists' }] } } })).value, 'inventory', { file: FILE })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const { value, forwarded } = ports()
    const request = { file: FILE, databases: ['alice_wp'], zones: ['alice.example.test'], expectedArchiveSha256: SHA }
    expect(await (await call(value, 'parts', request))!.json()).toMatchObject({ restoreId: RESTORE_ID, state: 'running' })
    expect(forwarded).toEqual([{ path: '/accounts/alice/backup-components/parts', body: request }])
    expect(value.requireCaller).toHaveBeenCalledTimes(2)
    expect(await code(call(value, 'parts', { ...request, databases: ['bob_wp'] }))).toBe('VALIDATION')
    for (const reply of [{ ...replies.parts as object, archive: { file: FILE, sha256: 'c'.repeat(64) } }, { ...replies.parts as object, databases: ['alice_shop'] }, { ...replies.parts as object, zones: [] }, { ...replies.parts as object, state: 'finished' }]) {
      const error = await call(ports({}, () => reply).value, 'parts', request).catch(failure => failure)
      expect(error).toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: true, verificationRequired: true } })
    }
  })
})
