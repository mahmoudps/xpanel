import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { createBackupRunsWorkspaceRoutes, readBackupRetentionPreview } from './acct-backup-runs-workspace.ts'
import type { BackupDestinationsWorkspacePorts } from './backup-destinations-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'

const ID = '11111111-1111-4111-8111-111111111111', RUN = '33333333-3333-4333-8333-333333333333', REV = 'a'.repeat(64), RUNS = 'b'.repeat(64)
const FILE = 'xpanel-backup-alice-20261028T020000Z.tar.gz'
const root = { principal: { id: 'root-id', kind: 'root', username: 'root' }, sessionId: 'session', apiTokenId: null } as AuthenticatedCaller
const view = { available: false, reason: 'no_provider', revision: RUNS, schedule: null, activeId: null, runs: [], recoveries: [], nativeQualified: false }
const setup = (host?: BackupDestinationsWorkspacePorts['destinationHost']) => {
  let caller: AuthenticatedCaller = root
  const audit = vi.fn(async () => {}), assertRoot = vi.fn(async (c: AuthenticatedCaller) => { if (c.principal.kind !== 'root') fail('FORBIDDEN', 'root access is required') })
  const ports = { requireCaller: vi.fn(async () => caller), assertRoot, emitAudit: audit, load: async () => ({ destinations: [], schedule: null, revision: REV }), ...(host ? { destinationHost: host } : {}) } as unknown as BackupDestinationsWorkspacePorts
  const route = createBackupRunsWorkspaceRoutes(ports)
  const call = (path: string, method = 'GET', body?: unknown) => route(new Request('http://api' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://api' + path), method)
  return { call, audit, ports, swap: (next: AuthenticatedCaller) => { caller = next } }
}

describe('backup runs workspace API', () => {
  it('reads a strictly checked agent view and refuses selectors or unknown paths', async () => {
    const host = vi.fn(async () => view), t = setup(host)
    expect(await t.call('/api/backups/workspace/other')).toBeNull()
    expect(await (await t.call('/api/backups/workspace/runs'))!.json()).toEqual(view)
    await expect(t.call('/api/backups/workspace/runs?all=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    host.mockResolvedValueOnce({ ...view, available: true } as never)
    await expect(t.call('/api/backups/workspace/runs')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await expect(setup().call('/api/backups/workspace/runs')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('denies non-root callers before any host call', async () => {
    const host = vi.fn(async () => view), t = setup(host)
    t.swap({ ...root, principal: { id: 'u', kind: 'user', username: 'alice', accountId: 'x' } } as AuthenticatedCaller)
    await expect(t.call('/api/backups/workspace/runs')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(host).not.toHaveBeenCalled()
  })
  it('requires the saved configuration revision, exact keys and the same authority before run now', async () => {
    const host = vi.fn(async (_c: AuthenticatedCaller, _path: string, body?: unknown) => body ? { runId: RUN, state: 'running' } : view), t = setup(host)
    await expect(t.call('/api/backups/workspace/runs', 'POST', { expectedRevision: REV })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(t.call('/api/backups/workspace/runs', 'POST', { expectedRevision: 'f'.repeat(64), expectedRunsRevision: RUNS })).rejects.toMatchObject({ code: 'CONFLICT' })
    const response = await t.call('/api/backups/workspace/runs', 'POST', { expectedRevision: REV, expectedRunsRevision: RUNS })
    expect(response!.status).toBe(202)
    expect(host).toHaveBeenLastCalledWith(root, '/host/backups/runs', { expectedRevision: RUNS })
    expect(t.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'backup.run.requested', outcome: 'ok' }))
  })
  it('passes definite agent refusals through and marks lost replies unknown', async () => {
    const refused = setup(async () => fail('CONFLICT', 'busy'))
    await expect(refused.call('/api/backups/workspace/runs', 'POST', { expectedRevision: REV, expectedRunsRevision: RUNS })).rejects.toMatchObject({ code: 'CONFLICT' })
    const lost = setup(async () => { throw new Error('socket hang up') })
    await expect(lost.call('/api/backups/workspace/runs', 'POST', { expectedRevision: REV, expectedRunsRevision: RUNS })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    expect(lost.audit).not.toHaveBeenCalled()
  })
  it('validates recovery names and records retention outcomes truthfully', async () => {
    const host = vi.fn(async (_c: AuthenticatedCaller, path: string) => path.endsWith('/recover') ? { recoveryId: RUN, state: 'running' } : { destinationId: ID, deleted: [], outcome: 'unknown' }), t = setup(host)
    const base = '/api/backups/workspace/destinations/' + ID
    await expect(t.call(base + '/recover', 'POST', { expectedRevision: REV, expectedRunsRevision: RUNS, runId: RUN, username: 'alice', file: 'xpanel-backup-bob-20261028T020000Z.tar.gz' })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await t.call(base + '/recover'))!.status).toBe(405)
    expect((await t.call(base + '/recover', 'POST', { expectedRevision: REV, expectedRunsRevision: RUNS, runId: RUN, username: 'alice', file: FILE }))!.status).toBe(202)
    const applied = await (await t.call(base + '/retention', 'POST', { expectedRevision: REV, expectedPlanDigest: 'c'.repeat(64) }))!.json()
    expect(applied).toEqual({ destinationId: ID, deleted: [], outcome: 'unknown', verificationRequired: true })
    expect(t.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'backup.retention.applied', outcome: 'failed' }))
  })
  it('checks retention preview rows against the archive grammar', () => {
    const row = { name: 'alice/' + FILE, username: 'alice', createdAt: '2026-10-28T02:00:00.000Z', bytes: 3, action: 'keep', reason: 'newest' }
    const plan = { destinationId: ID, retentionDays: 30, retentionCount: 7, planDigest: 'c'.repeat(64), rows: [row] }
    expect(readBackupRetentionPreview(plan, ID).rows).toHaveLength(1)
    for (const rows of [[{ ...row, action: 'delete' }], [{ ...row, name: 'alice/notes.txt' }], [{ ...row, username: 'bob' }]]) expect(() => readBackupRetentionPreview({ ...plan, rows }, ID)).toThrow()
    expect(() => readBackupRetentionPreview(plan, '22222222-2222-4222-8222-222222222222')).toThrow()
  })
})
