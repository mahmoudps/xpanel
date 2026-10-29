import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleBackupFileRestoreWorkspaceRoute } from './backup-file-restore-workspace.ts'
import type { BackupFileRestoreWorkspacePorts } from './backup-file-restore-workspace.ts'

const FILE = 'xpanel-backup-alice-20261026T100000Z.tar.gz', REVISION = 'a'.repeat(64), SHA = 'b'.repeat(64)
const caller = (kind: string, id = kind + '-1', extra: Record<string, unknown> = {}) => ({ principal: { kind, id, username: kind }, sessionId: 'session-1', apiTokenId: null, scopes: [], ...extra }) as unknown as AuthenticatedCaller
const accountOf = (username: string, status = 'active', id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') => ({ id, username, uid: 20014, home: '/home/' + username, primaryDomain: username + '.example.test', status, ownerId: 'reseller-1' }) as unknown as Account
const alice = accountOf('alice')
const context = { accountId: alice.id, username: 'alice' }
const archive = { file: FILE, bytes: 100, sha256: SHA, createdAt: '2026-10-26T10:00:00Z', integrity: 'verified' }
const replies: Record<string, unknown> = {
  '/accounts/alice/backup-files': { context, archives: [{ file: FILE, bytes: 100, createdAt: '2026-10-26T10:00:00Z', integrity: 'unverified', reason: null }], total: 1, truncated: false },
  '/accounts/alice/backup-files/browse': { context, archive, folder: 'restored-20261026T100000Z', entries: [{ path: 'public_html/index.html', bytes: 3, mode: 0o640 }] },
  '/accounts/alice/backup-files/preview': { context, archive, destination: { mode: 'new-folder', folder: 'restored-20261026T100000Z' }, rows: [{ path: 'public_html/index.html', destination: 'restored-20261026T100000Z/public_html/index.html', bytes: 3, action: 'restore', reason: null, exists: 'no' }], counts: { restore: 1, present: 0, refused: 0 }, revision: REVISION },
  '/accounts/alice/backup-files/restore': { context, archive, destination: { mode: 'new-folder', folder: 'restored-20261026T100000Z' }, results: [{ path: 'public_html/index.html', destination: 'restored-20261026T100000Z/public_html/index.html', bytes: 3, result: 'restored', reason: null, verificationRequired: false }], counts: { restored: 1, 'skipped-exists': 0, failed: 0, 'not-attempted': 0 }, complete: true, verificationRequired: false, revision: REVISION },
}
const ports = (overrides: Partial<BackupFileRestoreWorkspacePorts> = {}) => {
  const forwarded: { path: string; method?: string; body?: unknown }[] = []
  const value: BackupFileRestoreWorkspacePorts = {
    requireCaller: vi.fn(async () => caller('root')),
    getAccountByUsername: vi.fn(async (username: string) => username === 'alice' ? alice : null),
    visibleAccounts: vi.fn(async () => [accountOf('zed', 'active', 'z'), alice, accountOf('sus', 'suspended', 's')]),
    assertCanAccessAccount: vi.fn(async () => undefined),
    callAgent: vi.fn(async (path, options) => { forwarded.push({ path, method: options.method, body: options.body }); return Response.json(replies[path]) }),
    ...overrides,
  }
  return { value, forwarded }
}
const call = (p: BackupFileRestoreWorkspacePorts, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers: Record<string, string> = { 'content-type': 'application/json' }) => {
  const url = new URL('http://localhost' + path)
  return handleBackupFileRestoreWorkspaceRoute(new Request(url, body === undefined ? { method } : { method, headers, body: typeof body === 'string' ? body : JSON.stringify(body) }), url, method, p)
}

describe('WHM file restore API', () => {
  it('lists only active visible accounts in a stable order', async () => {
    const { value } = ports()
    const response = await call(value, '/api/backups/files')
    expect(response!.headers.get('cache-control')).toBe('no-store')
    expect(await response!.json()).toEqual({ accounts: [{ username: 'alice', primaryDomain: 'alice.example.test' }, { username: 'zed', primaryDomain: 'zed.example.test' }] })
    expect(value.callAgent).not.toHaveBeenCalled()
  })
  it('forwards each operation to the account agent route with only the reviewed fields', async () => {
    const { value, forwarded } = ports()
    expect((await (await call(value, '/api/backups/files/alice'))!.json()).archives).toHaveLength(1)
    expect((await (await call(value, '/api/backups/files/alice/browse', { file: FILE }))!.json()).entries).toHaveLength(1)
    expect((await (await call(value, '/api/backups/files/alice/preview', { file: FILE, paths: ['public_html'], destination: 'new-folder' }))!.json()).revision).toBe(REVISION)
    expect((await (await call(value, '/api/backups/files/alice/restore', { file: FILE, paths: ['public_html'], destination: 'new-folder', expectedRevision: REVISION }))!.json()).counts.restored).toBe(1)
    expect(forwarded).toEqual([
      { path: '/accounts/alice/backup-files', method: undefined, body: undefined },
      { path: '/accounts/alice/backup-files/browse', method: 'POST', body: { file: FILE } },
      { path: '/accounts/alice/backup-files/preview', method: 'POST', body: { file: FILE, paths: ['public_html'], destination: 'new-folder' } },
      { path: '/accounts/alice/backup-files/restore', method: 'POST', body: { file: FILE, paths: ['public_html'], destination: 'new-folder', expectedRevision: REVISION } },
    ])
    // The restore re-authenticates and re-authorizes immediately before forwarding.
    expect(value.requireCaller).toHaveBeenCalledTimes(5)
    expect(value.assertCanAccessAccount).toHaveBeenLastCalledWith(expect.anything(), alice, 'backup.files.restore')
  })
  it.each([['user'], ['mailbox']])('returns 403 for %s principals without forwarding', async kind => {
    const { value } = ports({ requireCaller: vi.fn(async () => caller(kind)) })
    await expect(call(value, '/api/backups/files/alice')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(value, '/api/backups/files')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(value.callAgent).not.toHaveBeenCalled()
  })
  it('returns 403 for a reseller that does not own the account', async () => {
    const { value } = ports({ requireCaller: vi.fn(async () => caller('reseller', 'reseller-2')), assertCanAccessAccount: vi.fn(async () => fail('FORBIDDEN', 'account is not visible to this reseller')) })
    await expect(call(value, '/api/backups/files/alice/browse', { file: FILE })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(value.callAgent).not.toHaveBeenCalled()
  })
  it.each([
    [{ file: FILE, paths: ['../etc/passwd'], destination: 'new-folder' }],
    [{ file: FILE, paths: ['/etc/passwd'], destination: 'new-folder' }],
    [{ file: FILE, paths: ['public_html'], destination: 'overwrite' }],
    [{ file: FILE, paths: ['public_html'], destination: 'new-folder', home: '/home/bob' }],
    [{ file: 'xpanel-backup-bob-20261026T100000Z.tar.gz', paths: ['a'], destination: 'new-folder' }],
    [{ file: FILE, paths: [], destination: 'new-folder' }],
  ])('rejects invalid selections before the agent: %j', async body => {
    const { value } = ports()
    await expect(call(value, '/api/backups/files/alice/preview', body)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(value.callAgent).not.toHaveBeenCalled()
  })
  it('rejects query selectors, wrong methods, non-JSON bodies and unknown accounts', async () => {
    const { value } = ports()
    await expect(call(value, '/api/backups/files/alice?username=bob')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call(value, '/api/backups/files/alice/restore'))!.status).toBe(405)
    expect((await call(value, '/api/backups/files/alice', {}))!.status).toBe(405)
    await expect(call(value, '/api/backups/files/alice/browse', JSON.stringify({ file: FILE }), 'POST', { 'content-type': 'text/plain' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(value, '/api/backups/files/alice/browse', '{', 'POST')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(value, '/api/backups/files/bob')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await call(value, '/api/backups/accounts/alice')).toBeNull()
    expect(value.callAgent).not.toHaveBeenCalled()
  })
  it('refuses suspended accounts and a missing agent truthfully', async () => {
    const suspended = ports({ getAccountByUsername: vi.fn(async () => accountOf('alice', 'suspended')) })
    await expect(call(suspended.value, '/api/backups/files/alice')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const offline = ports({ callAgent: undefined })
    await expect(call(offline.value, '/api/backups/files/alice')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: /agent is not connected/ })
  })
  it('stops when the administrator changes before a restore', async () => {
    let calls = 0
    const { value } = ports({ requireCaller: vi.fn(async () => caller('root', ++calls > 1 ? 'root-2' : 'root-1')) })
    await expect(call(value, '/api/backups/files/alice/restore', { file: FILE, paths: ['a'], destination: 'new-folder', expectedRevision: REVISION })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(value.callAgent).not.toHaveBeenCalled()
  })
  it('passes agent problems through and never reports an unverifiable restore as success', async () => {
    const problem = ports({ callAgent: vi.fn(async () => Response.json({ code: 'CONFLICT', message: 'review again' }, { status: 409 })) })
    expect((await call(problem.value, '/api/backups/files/alice/browse', { file: FILE }))!.status).toBe(409)
    const wrong = ports({ callAgent: vi.fn(async () => Response.json({ ...(replies['/accounts/alice/backup-files/restore'] as object), revision: 'c'.repeat(64) })) })
    await expect(call(wrong.value, '/api/backups/files/alice/restore', { file: FILE, paths: ['a'], destination: 'new-folder', expectedRevision: REVISION })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: true, verificationRequired: true } })
    const foreign = ports({ callAgent: vi.fn(async () => Response.json({ ...(replies['/accounts/alice/backup-files'] as object), context: { accountId: 'other', username: 'alice' } })) })
    await expect(call(foreign.value, '/api/backups/files/alice')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    const counts = ports({ callAgent: vi.fn(async () => Response.json({ ...(replies['/accounts/alice/backup-files/restore'] as object), counts: { restored: 0, 'skipped-exists': 1, failed: 0, 'not-attempted': 0 } })) })
    await expect(call(counts.value, '/api/backups/files/alice/restore', { file: FILE, paths: ['a'], destination: 'new-folder', expectedRevision: REVISION })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
