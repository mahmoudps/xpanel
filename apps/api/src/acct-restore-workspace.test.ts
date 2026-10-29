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
  mailSettings: { state: 'not-restorable', files: 0 }, databases: { state: 'not-in-archive' }, dns: { state: 'not-in-archive' } }
const replies: Record<string, unknown> = {
  inventory: { context, archive, components },
  preview: { context, archive, mailboxes: [BOX], rows: [{ path: MESSAGE, bytes: 11 }], counts: { messages: 1, present: 0, batch: 1, remaining: 0, refused: 0 }, quota: { limitMb: 'unlimited', plannedBytes: 11, fits: true }, writer: 'available', limits: {}, revision: REVISION },
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
      { ...replies.inventory as object, components: { ...components, databases: { state: 'available' } } }])
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
})
