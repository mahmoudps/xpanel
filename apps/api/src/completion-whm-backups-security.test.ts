import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiToken, createResellerPrincipal, createRootPrincipal, createSession, createTestDb } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import { deriveCsrfToken, sha256Hex } from './auth.ts'
import { createApiApp, listenApiServer } from './server.ts'
import { validateBackupCron, validateBackupDestination, validateBackupSchedule } from './backup-workspace.ts'

// Real loopback HTTP and temporary stores. Snapshot fixture content is explicit synthetic metadata;
// no remote connection, scheduler, native capture, archive integrity or restoration is exercised.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'test-backup'.repeat(4)
const cleanup: Array<() => Promise<unknown>> = []
const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  const reseller = await state.store.createReseller({ username: 'backupseller', passwordHash: HASH, acl: ['list-accounts'], maxAccounts: 5, totalDiskMb: 10000, totalBandwidthMb: 100000, oversell: false, nameservers: [], delegatedIps: [] })
  await createResellerPrincipal(database.db, { id: reseller.id, username: reseller.username, passwordHash: HASH })
  const token = async (principalId: string, scopes = ['*']) => {
    const raw = 'xp_' + randomUUID()
    await createApiToken(database.db, { principalId, name: 'Synthetic backup metadata', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const rootToken = await token(root.id), resellerToken = await token(reseller.id)
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET })
  const server = await listenApiServer(app); cleanup.push(() => server.close())
  const request = (path = '/api/backups/workspace', method = 'GET', body?: unknown, bearer: string | null = rootToken, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${server.port}` + path, { method, headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const view = async () => { const response = await request(); expect(response.status).toBe(200); return await response.json() as { revision: string; destinations: Array<{ id: string; name: string; enabled: boolean }>; schedule: Record<string, unknown> | null; snapshots: Record<string, unknown>[]; application: Record<string, unknown> } }
  const bytes = (key: string) => readFile(join(state.rootDir, 'extended', 'backups', key + '.json'), 'utf8').catch(() => '')
  return { database, state, root, rootToken, resellerToken, request, view, bytes }
}
const destination = (name = 'Local backup configuration') => ({ name, kind: 'local', endpoint: '/var/backups/xpanel', pathPrefix: '/var/backups/xpanel/daily', bucket: null, region: null, username: null, retentionDays: 30, enabled: false })

describe('backup policy validation', () => {
  it('validates bounded cron fields and refuses command/environment forms', () => {
    expect(validateBackupCron('0 2,14 * * *')).toBe('0 2,14 * * *')
    for (const value of ['@daily', '0 2 * * * root echo x', '60 2 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '1-0 * * * *', '0 2 * * *\nrun']) expect(() => validateBackupCron(value)).toThrow()
  })
  it('rejects secrets, path traversal, unknown fields and malformed scalar types', () => {
    expect(validateBackupDestination(destination()).kind).toBe('local')
    for (const draft of [{ ...destination(), password: 'synthetic-never-stored' }, { ...destination(), enabled: 'yes' }, { ...destination(), endpoint: '/var/../etc' }, { ...destination(), kind: 'sftp', endpoint: 'sftp://user:synthetic@backup.example.test' }, { ...destination(), retentionDays: 0 }]) expect(() => validateBackupDestination(draft)).toThrow()
    for (const draft of [{ retentionCount: 0 }, { includeMail: 'yes' }, { selectedAccounts: ['repeated', 'repeated'] }, { destinationIds: ['bad-id'] }, { unsupported: true }]) expect(() => validateBackupSchedule(draft)).toThrow()
  })
})

describe('WHM backup configuration loopback HTTP security', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    const outcomes = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const errors = outcomes.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Backup fixture cleanup failed')
  })
  const create = async (name?: string) => {
    const response = await f.request('/api/backups/workspace/destinations', 'POST', { ...destination(name), expectedRevision: (await f.view()).revision })
    expect(response.status).toBe(201)
    return await response.json() as { destination: { id: string; name: string }; revision: string }
  }

  it('reads a stable absent configuration without creating backup files or claiming execution', async () => {
    const first = await f.view(), second = await f.view()
    expect(first).toMatchObject({ destinations: [], schedule: null, snapshots: [], application: { status: 'configuration_only', nativeApplied: false, schedulerVerified: false, remoteConnectionVerified: false } })
    expect(second.revision).toBe(first.revision)
    expect(await f.bytes('destinations')).toBe(''); expect(await f.bytes('schedule')).toBe('')
  })
  it('creates, edits and reads back destination configuration with an audit', async () => {
    const created = await create()
    const response = await f.request('/api/backups/workspace/destinations/' + created.destination.id, 'PATCH', { ...destination('Edited backup destination'), expectedRevision: created.revision })
    expect(response.status).toBe(200)
    const body = await response.json() as { destination: { id: string; name: string }; revision: string }
    expect(body.destination.id).toBe(created.destination.id)
    expect((await f.view()).revision).toBe(body.revision)
    expect(JSON.parse(await f.bytes('destinations'))[0].name).toBe('Edited backup destination')
    const audit = await f.database.db.query('SELECT action FROM audit_log WHERE action = $1', ['backup.destination.updated'])
    expect(audit.length).toBe(1)
  })
  it('stores a validated requested schedule and refuses deletion of a selected destination', async () => {
    const created = await create()
    const input = { enabled: true, frequency: 'daily', cron: '0 2 * * *', retentionCount: 7, compress: 'zstd', includeDatabases: true, includeMail: false, selectedAccounts: 'all', destinationIds: [created.destination.id], expectedRevision: created.revision }
    const response = await f.request('/api/backups/workspace/schedule', 'PUT', input)
    expect(response.status).toBe(422)
    const disabled = await f.request('/api/backups/workspace/schedule', 'PUT', { ...input, enabled: false })
    expect(disabled.status).toBe(200)
    expect(JSON.parse(await f.bytes('schedule'))).toMatchObject({ cron: '0 2 * * *', includeMail: false })
    const before = await f.bytes('destinations'), current = await f.view()
    expect((await f.request('/api/backups/workspace/destinations/' + created.destination.id, 'DELETE', { expectedRevision: current.revision })).status).toBe(409)
    expect(await f.bytes('destinations')).toBe(before)
  })
  it('refuses stale revisions and serializes concurrent destination writes', async () => {
    const expectedRevision = (await f.view()).revision
    const responses = await Promise.all(['First destination', 'Second destination'].map(name => f.request('/api/backups/workspace/destinations', 'POST', { ...destination(name), expectedRevision })))
    expect(responses.map(response => response.status).sort()).toEqual([201, 409])
    const before = await f.bytes('destinations')
    expect((await f.request('/api/backups/workspace/schedule', 'PUT', { enabled: false, expectedRevision })).status).toBe(409)
    expect(await f.bytes('destinations')).toBe(before)
  })
  it.each([{ privateKey: 'synthetic-never-stored' }, { id: randomUUID() }, { retentionDays: -1 }, { kind: 'unsupported' }, { enabled: 'yes' }])('refuses invalid destination fields without writing: %s', async patch => {
    const before = await f.bytes('destinations')
    const response = await f.request('/api/backups/workspace/destinations', 'POST', { ...destination(), ...patch, expectedRevision: (await f.view()).revision })
    expect(response.status).toBe(422); expect(await f.bytes('destinations')).toBe(before)
  })
  it('keeps the legacy destination/schedule grammar on the same revision authority', async () => {
    const original = await f.view()
    expect((await f.request('/api/backups/destinations', 'POST', destination())).status).toBe(201)
    const updated = await f.view(); expect(updated.revision).not.toBe(original.revision)
    expect((await f.request('/api/backups/schedule', 'PUT', { enabled: false, cron: '15 3 * * *', retentionCount: 14 })).status).toBe(200)
    expect((await f.view()).schedule).toMatchObject({ cron: '15 3 * * *', retentionCount: 14 })
    const before = await f.bytes('destinations')
    expect((await f.request('/api/backups/destinations/not-an-id', 'DELETE', {})).status).toBe(422)
    expect(await f.bytes('destinations')).toBe(before)
  })
  it('removes an unused exact destination and audits the absence', async () => {
    const created = await create()
    expect((await f.request('/api/backups/workspace/destinations/' + created.destination.id, 'DELETE', { expectedRevision: created.revision })).status).toBe(200)
    expect((await f.view()).destinations).toEqual([])
    expect((await f.database.db.query('SELECT action FROM audit_log WHERE action = $1', ['backup.destination.deleted'])).length).toBe(1)
  })
  it('strips stored file contents from snapshot metadata and never asserts archive integrity', async () => {
    await atomicWriteJson(join(f.state.rootDir, 'extended', 'backups', 'snapshots.json'), [{ id: randomUUID(), accountId: randomUUID(), username: 'syntheticowner', destinationId: null, sizeBytes: 24, checksumSha256: 'a'.repeat(64), files: [{ path: 'public_html/config.php', content: 'SYNTHETIC_PRIVATE_FILE_CONTENT', sizeBytes: 24, mode: 0o640 }], databases: [], createdAt: '2026-10-26T00:00:00.000Z' }])
    const view = await f.view()
    expect(JSON.stringify(view)).not.toContain('SYNTHETIC_PRIVATE_FILE_CONTENT')
    expect(view.snapshots[0]).toMatchObject({ username: 'syntheticowner', application: { status: 'recorded_metadata', archiveVerified: false, restoreAvailable: false }, files: [{ path: 'public_html/config.php', sizeBytes: 24, mode: 0o640 }] })
  })
  it('requires authenticated root access and session CSRF without changing data', async () => {
    expect((await f.request('/api/backups/workspace', 'GET', undefined, null)).status).toBe(401)
    expect((await f.request('/api/backups/workspace', 'GET', undefined, f.resellerToken)).status).toBe(403)
    expect((await f.request('/api/backups/workspace/destinations', 'POST', { ...destination(), expectedRevision: (await f.view()).revision }, f.resellerToken)).status).toBe(403)
    const raw = randomUUID() + randomUUID()
    await createSession(f.database.db, { principalId: f.root.id, tokenHash: sha256Hex(raw), expiresAt: new Date(Date.now() + 60000).toISOString() })
    const body = { ...destination(), expectedRevision: (await f.view()).revision }, cookie = { cookie: 'xpanel_session=' + raw }
    expect((await f.request('/api/backups/workspace/destinations', 'POST', body, null, cookie)).status).toBe(403)
    expect(await f.bytes('destinations')).toBe('')
    expect((await f.request('/api/backups/workspace/destinations', 'POST', body, null, { ...cookie, 'x-csrf-token': deriveCsrfToken(raw, SECRET) })).status).toBe(201)
  })
})
