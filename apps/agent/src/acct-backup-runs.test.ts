import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { backupDestinationProofDigest, backupDestinationTargetDigest } from '../../../packages/core/src/backup-destination.ts'
import type { BackupDestinationTarget } from '../../../packages/core/src/backup-destination.ts'
import { backupRunLedgerRevision, parseBackupArchiveName, planBackupRetention, readBackupRunLedger, readBackupRunsView } from './acct-backup-plan.ts'
import { createBackupRunController, handleBackupRunsRoute, readSavedBackupConfig } from './acct-backup-runs.ts'
import type { BackupRunDeps } from './acct-backup-runs.ts'
import type { BackupTransferProvider, BackupTransferSession } from './acct-backup-s3.ts'

const ID = '11111111-1111-4111-8111-111111111111', REVISION = 'c'.repeat(64)
const target: BackupDestinationTarget = { id: ID, name: 'Offsite', kind: 's3', endpoint: 'https://s3.example.test', bucket: 'tenant-backups', region: 'us-east-1', pathPrefix: '/xpanel', username: null, retentionDays: 30, createdAt: '2026-10-01T00:00:00.000Z', credentialRef: 'offsite' }
const proofFields = { targetDigest: backupDestinationTargetDigest(target), credentialRef: 'offsite', credentialRevision: REVISION, verifiedAt: '2026-10-02T00:00:00.000Z', probeDigest: 'd'.repeat(64) }
const savedDestination = { ...target, enabled: true, verification: { ...proofFields, proofDigest: backupDestinationProofDigest(proofFields) } }
const schedule = { enabled: true, frequency: 'daily', cron: '0 2 * * *', retentionCount: 1, compress: 'gzip', includeDatabases: true, includeMail: true, selectedAccounts: 'all', destinationIds: [ID], updatedAt: '2026-10-27T00:00:00.000Z' }
const FILE = 'xpanel-backup-alice-20261028T020000Z.tar.gz', BYTES = new Uint8Array([1, 2, 3]), SHA = createHash('sha256').update(BYTES).digest('hex')
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const setup = (overrides: Partial<BackupRunDeps> = {}, config: { destinations: unknown; schedule: unknown } = { destinations: [savedDestination], schedule }) => {
  const objects = new Map<string, Uint8Array>(), stored = new Map<string, Uint8Array>()
  let ledger: unknown = null, clock = new Date('2026-10-28T02:00:30.000Z')
  const session: BackupTransferSession = {
    binding: { destinationId: ID, targetDigest: backupDestinationTargetDigest(target), credentialRef: 'offsite', credentialRevision: REVISION, remote: true, confined: true, pinnedPeer: true, redirects: false },
    writeProbe: async () => {}, readProbe: async () => null, deleteProbe: async () => {}, closeAndDrain: async () => {},
    putArchive: vi.fn(async (name, source) => { const parts: Uint8Array[] = []; for await (const chunk of source.chunks()) parts.push(chunk); objects.set(name, Buffer.concat(parts)) }),
    readArchive: vi.fn(async name => { const bytes = objects.get(name); return bytes ? (async function* () { yield bytes })() : null }),
    listArchives: vi.fn(async () => [...objects].map(([name, bytes]) => ({ name, bytes: bytes.byteLength, lastModified: '2026-10-28T02:00:00.000Z' }))),
    deleteArchive: vi.fn(async name => { objects.delete(name) }),
  }
  const provider: BackupTransferProvider = { profiles: async () => [{ ref: 'offsite', label: 'Offsite key', kinds: ['s3'], revision: REVISION }], open: vi.fn(async () => session) }
  const deps: BackupRunDeps = {
    readConfig: async () => config, provider,
    listAccounts: async () => [{ id: '22222222-2222-4222-8222-222222222222', username: 'alice', home: '/home/alice', uid: 20001, status: 'active' }],
    createBackup: vi.fn(async () => ({ file: FILE, bytes: 3 })),
    readLocalArchive: async () => ({ bytes: 3, sha256: SHA, chunks: async function* () { yield BYTES } }),
    storeRecovered: vi.fn(async (_account, file, chunks, expected) => { const parts: Uint8Array[] = []; for await (const chunk of chunks) parts.push(chunk); const bytes = Buffer.concat(parts); if (sha(bytes) !== expected.sha256) return 'mismatch'; if (stored.has(file)) return 'exists'; stored.set(file, bytes); return 'recovered' }),
    readLedger: async () => ledger, writeLedger: async value => { ledger = structuredClone(value) },
    now: () => clock, ...overrides,
  }
  return { deps, objects, stored, session, provider, controller: createBackupRunController(deps), ledger: () => ledger, setLedger: (value: unknown) => { ledger = value }, setClock: (value: string) => { clock = new Date(value) } }
}

describe('remote archive names and retention plan', () => {
  it('admits only account-owned xPanel archive names', () => {
    expect(parseBackupArchiveName('alice/' + FILE)).toEqual({ username: 'alice', file: FILE, createdAt: '2026-10-28T02:00:00.000Z' })
    for (const name of ['bob/' + FILE, FILE, 'alice/../' + FILE, 'alice/' + FILE + '/x', '.xpanel-probe/x', 'Alice/' + FILE]) expect(parseBackupArchiveName(name)).toBeNull()
  })
  it('keeps the newest, protected and counted archives and deletes only expired extras', () => {
    const name = (day: string) => `alice/xpanel-backup-alice-202610${day}T020000Z.tar.gz`
    const archives = ['01', '02', '03', '27'].map(day => ({ name: name(day), bytes: 1, lastModified: 'x' }))
    const plan = planBackupRetention({ archives: [...archives, { name: 'notes.txt', bytes: 1, lastModified: 'x' }], retentionDays: 7, retentionCount: 2, protectedNames: new Set([name('01')]), now: new Date('2026-10-28T00:00:00.000Z') })
    expect(plan.rows.map(row => [row.name.slice(-19, -12), row.action, row.reason])).toEqual([['1027T02', 'keep', 'newest'], ['1003T02', 'keep', 'within_count'], ['1002T02', 'delete', 'expired'], ['1001T02', 'keep', 'protected']])
    expect(planBackupRetention({ archives, retentionDays: 30, retentionCount: 1, protectedNames: new Set(), now: new Date('2026-10-28T00:00:00.000Z') }).rows.every(row => row.action === 'keep')).toBe(true)
  })
  it('refuses a corrupt ledger instead of showing it empty', () => {
    const run = { id: ID, trigger: 'manual', actor: 'root', startedAt: '2026-10-28T00:00:00.000Z', finishedAt: '2026-10-28T00:01:00.000Z', state: 'succeeded', destinationIds: [ID], accounts: 1, mailIncluded: true, databasesIncluded: false, retention: [],
      entries: [{ username: 'alice', destinationId: ID, file: FILE, bytes: 3, sha256: SHA, outcome: 'verified', reason: null }] }
    expect(readBackupRunLedger({ version: 1, lastScheduledAt: null, runs: [run], recoveries: [] }).runs).toHaveLength(1)
    for (const runs of [[{ ...run, entries: [{ ...run.entries[0], outcome: 'failed', reason: 'readback_mismatch' }] }], [{ ...run, entries: [{ ...run.entries[0], file: 'xpanel-backup-bob-20261028T020000Z.tar.gz' }] }], [{ ...run, databasesIncluded: true }], [{ ...run, extra: 1 }]])
      expect(() => readBackupRunLedger({ version: 1, lastScheduledAt: null, runs, recoveries: [] })).toThrow()
  })
})

describe('scheduled backup controller', () => {
  it('reports each missing prerequisite without starting anything', async () => {
    expect((await setup({ createBackup: null }).controller.view()).reason).toBe('no_executor')
    expect((await setup({ provider: null }).controller.view()).reason).toBe('no_provider')
    expect((await setup({}, { destinations: [savedDestination], schedule: null }).controller.view()).reason).toBe('no_schedule')
    expect((await setup({}, { destinations: [{ ...savedDestination, enabled: false }], schedule }).controller.view()).reason).toBe('no_destination')
    expect((await setup({}, { destinations: [{ ...savedDestination, verification: { ...savedDestination.verification, credentialRevision: 'e'.repeat(64) } }], schedule }).controller.view()).reason).toBe('invalid_configuration')
    const t = setup({ createBackup: null })
    await expect(t.controller.start('root', (await t.controller.view()).revision)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(t.ledger()).toBeNull()
  })
  it('succeeds only after the uploaded copy is re-read with the same size and sha256', async () => {
    const t = setup(), before = await t.controller.view()
    expect(before).toMatchObject({ available: true, schedule: { enabled: true, nextRunAt: '2026-10-28T02:00:00.000Z' } })
    await expect(t.controller.start('root', 'f'.repeat(64))).rejects.toMatchObject({ code: 'CONFLICT' })
    const run = await t.controller.start('root', before.revision)
    await expect(t.controller.start('root', before.revision)).rejects.toMatchObject({ code: 'CONFLICT' })
    await t.controller.idle()
    const view = readBackupRunsView(JSON.parse(JSON.stringify(await t.controller.view())))
    expect(view.runs[0]).toMatchObject({ id: run.id, state: 'succeeded', entries: [{ username: 'alice', file: FILE, sha256: SHA, outcome: 'verified', reason: null }], databasesIncluded: false })
    expect(t.objects.get('alice/' + FILE)).toEqual(Buffer.from(BYTES))
  })
  it('keeps mismatched readback failed and interrupted uploads unknown', async () => {
    const corrupt = setup()
    corrupt.session.readArchive = async () => (async function* () { yield new Uint8Array([9, 9, 9]) })()
    await corrupt.controller.start('root', (await corrupt.controller.view()).revision); await corrupt.controller.idle()
    expect((await corrupt.controller.view()).runs[0]).toMatchObject({ state: 'failed', entries: [{ outcome: 'failed', reason: 'readback_mismatch' }] })
    const lost = setup()
    lost.session.putArchive = async () => { throw new Error('socket closed') }
    await lost.controller.start('root', (await lost.controller.view()).revision); await lost.controller.idle()
    expect((await lost.controller.view()).runs[0]).toMatchObject({ state: 'unknown', entries: [{ outcome: 'unknown', reason: 'upload_unknown' }] })
  })
  it('runs a due schedule once per coalesced window and applies retention after a fully verified run', async () => {
    const t = setup({}, { destinations: [savedDestination], schedule: { ...schedule, updatedAt: '2026-10-28T00:00:00.000Z' } })
    t.objects.set('alice/xpanel-backup-alice-20260901T020000Z.tar.gz', new Uint8Array([7]))
    t.setClock('2026-10-28T01:30:00.000Z')
    expect(await t.controller.tick()).toEqual({ skipped: 'not_due' })
    t.setClock('2026-10-28T02:00:30.000Z')
    const started = await t.controller.tick()
    expect(started).toHaveProperty('started')
    expect(await t.controller.tick()).toEqual({ skipped: 'busy' })
    await t.controller.idle()
    expect(await t.controller.tick()).toEqual({ skipped: 'not_due' })
    const view = await t.controller.view()
    expect(view.schedule?.lastScheduledAt).toBe('2026-10-28T02:00:30.000Z')
    expect(view.runs[0]).toMatchObject({ trigger: 'schedule', state: 'succeeded', retention: [{ destinationId: ID, deleted: 1, outcome: 'verified' }] })
    expect([...t.objects.keys()]).toEqual(['alice/' + FILE])
  })
  it('shows a running record from another process as unknown', async () => {
    const t = setup()
    t.setLedger({ version: 1, lastScheduledAt: null, recoveries: [], runs: [{ id: ID, trigger: 'manual', actor: 'root', startedAt: '2026-10-28T00:00:00.000Z', finishedAt: null, state: 'running', destinationIds: [ID], accounts: 1, mailIncluded: true, databasesIncluded: false, entries: [], retention: [] }] })
    const view = await t.controller.view()
    expect(view).toMatchObject({ activeId: null, runs: [{ state: 'unknown', finishedAt: null }] })
    expect(() => readBackupRunsView(JSON.parse(JSON.stringify(view)))).not.toThrow()
  })
  it('applies retention only for the reviewed plan digest and verifies by re-listing', async () => {
    const t = setup(), old = 'alice/xpanel-backup-alice-20260901T020000Z.tar.gz'
    t.objects.set(old, new Uint8Array([7])); t.objects.set('alice/' + FILE, BYTES)
    const plan = await t.controller.retentionPreview(ID)
    expect(plan.rows.filter(row => row.action === 'delete').map(row => row.name)).toEqual([old])
    await expect(t.controller.retentionApply(ID, 'f'.repeat(64))).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(t.objects.has(old)).toBe(true)
    expect(await t.controller.retentionApply(ID, plan.planDigest)).toEqual({ destinationId: ID, deleted: [old], outcome: 'verified' })
    const stuck = setup(); stuck.objects.set(old, new Uint8Array([7])); stuck.objects.set('alice/' + FILE, BYTES); stuck.session.deleteArchive = async () => {}
    expect((await stuck.controller.retentionApply(ID, (await stuck.controller.retentionPreview(ID)).planDigest)).outcome).toBe('unknown')
  })
  it('recovers only a ledger-verified copy and checks its digest before publishing', async () => {
    const t = setup()
    const run = await t.controller.start('root', (await t.controller.view()).revision); await t.controller.idle()
    const revision = (await t.controller.view()).revision
    await expect(t.controller.recover(ID, { runId: run.id, username: 'alice', file: 'xpanel-backup-alice-20261027T020000Z.tar.gz' }, 'root', revision)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(t.controller.recover(ID, { runId: run.id, username: 'alice', file: FILE }, 'root', 'f'.repeat(64))).rejects.toMatchObject({ code: 'CONFLICT' })
    const recovery = await t.controller.recover(ID, { runId: run.id, username: 'alice', file: FILE }, 'root', revision); await t.controller.idle()
    expect((await t.controller.view()).recoveries[0]).toMatchObject({ id: recovery.id, state: 'recovered', reason: null })
    expect(t.stored.get(FILE)).toEqual(Buffer.from(BYTES))
    t.objects.set('alice/' + FILE, new Uint8Array([5, 5, 5]))
    await t.controller.recover(ID, { runId: run.id, username: 'alice', file: FILE }, 'root', (await t.controller.view()).revision); await t.controller.idle()
    expect((await t.controller.view()).recoveries[0]).toMatchObject({ state: 'failed', reason: 'mismatch' })
  })
  it('reads saved destination files strictly', () => {
    expect(readSavedBackupConfig({ destinations: [savedDestination], schedule }).schedule?.destinationIds).toEqual([ID])
    for (const raw of [{ destinations: {}, schedule }, { destinations: [savedDestination], schedule: { ...schedule, cron: '0 25 * * *' } }, { destinations: [{ ...savedDestination, credentialRef: '/root/key' }], schedule }])
      expect(() => readSavedBackupConfig(raw)).toThrow()
  })
})

describe('host backup runs route', () => {
  const request = (path: string, method = 'GET', body?: unknown) => [new Request('http://agent' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://agent' + path), method] as const
  it('re-checks root authority before a mutation and refuses selectors, extra keys and other methods', async () => {
    const t = setup(), authorize = vi.fn(async () => ({ actor: 'root' })), ctx = { authorize, controller: t.controller }
    expect(await handleBackupRunsRoute(...request('/host/backups/other'), ctx)).toBeNull()
    const read = await handleBackupRunsRoute(...request('/host/backups/runs'), ctx)
    const revision = (await read!.json() as { revision: string }).revision
    await expect(handleBackupRunsRoute(...request('/host/backups/runs?x=1'), ctx)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(handleBackupRunsRoute(...request('/host/backups/runs', 'POST', { expectedRevision: revision, accounts: ['bob'] }), ctx)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await handleBackupRunsRoute(...request('/host/backups/destinations/' + ID + '/recover'), ctx))!.status).toBe(405)
    authorize.mockClear()
    const started = await handleBackupRunsRoute(...request('/host/backups/runs', 'POST', { expectedRevision: revision }), ctx)
    expect(started!.status).toBe(202)
    expect(authorize).toHaveBeenCalledTimes(2)
    await t.controller.idle()
    await expect(handleBackupRunsRoute(...request('/host/backups/destinations/' + ID + '/recover', 'POST', { expectedRevision: revision, runId: ID, username: 'alice', file: 'xpanel-backup-bob-20261028T020000Z.tar.gz' }), ctx)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('reports unavailable execution when no controller exists', async () => {
    await expect(handleBackupRunsRoute(...request('/host/backups/runs'), { authorize: async () => ({ actor: 'root' }), controller: null })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const denied = vi.fn(async () => { throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }) })
    await expect(handleBackupRunsRoute(...request('/host/backups/runs'), { authorize: denied, controller: setup().controller })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('keeps the view revision consistent with the stored ledger', async () => {
    const t = setup()
    await t.controller.start('root', (await t.controller.view()).revision); await t.controller.idle()
    expect((await t.controller.view()).revision).toBe(backupRunLedgerRevision(readBackupRunLedger(t.ledger())))
  })
})
