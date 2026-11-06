import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan, isXpanelError } from '@xpanel/core'
import { createTestDb, createUserPrincipal, listAudit } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { ACCOUNT_FILE_HELPER_PROTOCOL_VERSION, ARCHIVE_HELPER_TIMEOUT_MS, DEFAULT_HELPER_TIMEOUT_MS, MAX_ACTIVE_ARCHIVE_OPERATIONS } from './account-file-runner.ts'
import type { HelperProcessSpawnInput, HelperProcessSpawnResult } from './account-file-runner.ts'
import { JailedFileManager, NativeAccountFileRunner } from './file-manager.ts'
import type { AccountFileRequest, AccountFileRunner, FileEntry } from './file-manager.ts'
import { agentRouteTimeoutMs } from './peer-identity.ts'
import { agentCallerHeaders, createAgentApp } from './server.ts'

// Public PHC-format fixture only; never a credential.
const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const account = { username: 'alice', uid: 29101, gid: 29101, home: '/home/alice' }
const entry = (path: string, patch: Partial<FileEntry> = {}): FileEntry => ({
  name: path.split('/').at(-1)!, path, kind: 'file', sizeBytes: 3, mode: 0o640, mtime: '2026-10-22T08:00:00.000Z', ...patch,
})
const code = (expected: string) => (error: unknown): boolean => isXpanelError(error) && error.code === expected

const manager = (reply: (request: Readonly<AccountFileRequest>) => unknown) => {
  const calls: AccountFileRequest[] = []
  const runner: AccountFileRunner = { async run(_context, request) { calls.push(request); return reply(request) } }
  return { files: new JailedFileManager('/srv/homes/alice', 'unlimited', { account, runner }), calls }
}

describe('confined compress and extract requests', { tags: ['unit'] }, () => {
  it('sends exactly the source and destination and returns the archive entry or the extraction counts', async () => {
    const compressed = manager(request => entry((request as { destination: string }).destination))
    assert.deepEqual(await compressed.files.compress('public_html', 'backups/site.tar.gz'), entry('backups/site.tar.gz'))
    const extracted = manager(request => ({ destination: (request as { destination: string }).destination, entries: 12, bytes: 4096 }))
    assert.deepEqual(await extracted.files.extract('backups/site.tar.gz', ''), { destination: '', entries: 12, bytes: 4096 })
    assert.deepEqual(await extracted.files.extract('backups/site.zip', 'restore'), { destination: 'restore', entries: 12, bytes: 4096 })
    assert.deepEqual([...compressed.calls, ...extracted.calls], [
      { op: 'compress', path: 'public_html', destination: 'backups/site.tar.gz' },
      { op: 'extract', path: 'backups/site.tar.gz', destination: '' },
      { op: 'extract', path: 'backups/site.zip', destination: 'restore' },
    ])
  })

  it.each([
    ['public_html', '../site.zip'], ['public_html', '/tmp/site.zip'], ['public_html', '.trash/site.zip'], ['public_html', 'public_html/site.zip'],
    ['public_html', 'site.rar'], ['public_html', 'site.gz'], ['public_html', 'site'], ['.trash/x', 'site.zip'],
  ])('refuses to compress %j into %j before the runner', async (path, destination) => {
    const { files, calls } = manager(() => entry(destination))
    await assert.rejects(() => files.compress(path, destination), (error: unknown) => isXpanelError(error) && ['VALIDATION', 'FORBIDDEN'].includes(error.code))
    assert.equal(calls.length, 0)
  })

  it.each([['', 'out'], ['../a.zip', 'out'], ['a.zip', '../out'], ['a.zip', '/out'], ['a.zip', '.trash'], ['.trash/a.zip', 'out']])('refuses to extract %j into %j before the runner', async (path, destination) => {
    const { files, calls } = manager(() => ({ destination, entries: 0, bytes: 0 }))
    await assert.rejects(() => files.extract(path, destination), (error: unknown) => isXpanelError(error) && ['VALIDATION', 'FORBIDDEN'].includes(error.code))
    assert.equal(calls.length, 0)
  })

  it('treats an acknowledgement for another target, a folder archive or out-of-ceiling counts as invalid', async () => {
    for (const reply of [entry('other.zip'), entry('site.zip', { kind: 'directory', sizeBytes: 0, mode: 0o750 }), entry('site.zip', { mode: 0o644 }), null]) {
      await assert.rejects(() => manager(() => reply).files.compress('public_html', 'site.zip'), code('CONFIG_TEST_FAILED'))
    }
    for (const reply of [{ destination: 'elsewhere', entries: 1, bytes: 1 }, { destination: 'out', entries: 10_001, bytes: 1 }, { destination: 'out', entries: 1, bytes: 512 * 1024 * 1024 + 1 },
      { destination: 'out', entries: -1, bytes: 1 }, { destination: 'out', entries: 1, bytes: 1, extra: true }, entry('out')]) {
      await assert.rejects(() => manager(() => reply).files.extract('site.zip', 'out'), code('CONFIG_TEST_FAILED'))
    }
  })
})

describe('confined runner for archive operations', { tags: ['unit'] }, () => {
  const operation = (stdinPayload: string): AccountFileRequest['op'] => (JSON.parse(stdinPayload) as { request: AccountFileRequest }).request.op
  const answer = (stdinPayload: string, body: Record<string, unknown>): HelperProcessSpawnResult => ({ exitCode: 0, signal: null, pid: 100, stderr: '', stdout: JSON.stringify({
    protocolVersion: ACCOUNT_FILE_HELPER_PROTOCOL_VERSION, op: operation(stdinPayload), worker: { pid: 100, uid: account.uid, gid: account.gid, cgroup: '/' }, ...body,
  }) })
  const files = (spawner: (input: HelperProcessSpawnInput) => Promise<HelperProcessSpawnResult>) =>
    new JailedFileManager('/srv/homes/alice', 'unlimited', { account, runner: new NativeAccountFileRunner({ binaryPath: '/opt/xpanel/bin/xpanel-account-files', spawner }) })

  it('marks helper refusals as unchanged and keeps only a well-formed stable reason', async () => {
    const refusing = files(async ({ stdinPayload }) => answer(stdinPayload, {
      ok: false, error: { code: 'PRECONDITION_FAILED', errno: 38, errnoName: 'ENOSYS', message: 'unavailable', reason: 'archive_format_unavailable' } }))
    await assert.rejects(() => refusing.compress('public_html', 'site.tar.zst'), (error: unknown) => isXpanelError(error) && error.code === 'PRECONDITION_FAILED' &&
      error.detail?.stateChanged === false && error.detail?.reason === 'archive_format_unavailable')
    const partial = files(async ({ stdinPayload }) => answer(stdinPayload, {
      ok: false, error: { code: 'SERVICE_UNAVAILABLE', errno: 5, errnoName: 'EIO', message: 'partly published', reason: 'Not A Reason!' } }))
    await assert.rejects(() => partial.extract('site.zip', 'out'), (error: unknown) => isXpanelError(error) && error.code === 'SERVICE_UNAVAILABLE' &&
      error.detail?.stateChanged === undefined && error.detail?.reason === undefined)
  })

  it('gives archive work the long worker budget and lets only a bounded number run at once', async () => {
    const budgets: Array<[string, number]> = []
    const releases: Array<() => void> = []
    const slow = files(input => {
      const op = operation(input.stdinPayload)
      budgets.push([op, input.timeoutMs])
      const reply = answer(input.stdinPayload, { ok: true, result: op === 'list' ? [] : { destination: 'out', entries: 1, bytes: 1 } })
      return op === 'list' ? Promise.resolve(reply) : new Promise(resolve => releases.push(() => resolve(reply)))
    })
    const running = Array.from({ length: MAX_ACTIVE_ARCHIVE_OPERATIONS }, () => slow.extract('site.zip', 'out'))
    while (releases.length < MAX_ACTIVE_ARCHIVE_OPERATIONS) await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(() => slow.extract('site.zip', 'out'), (error: unknown) => isXpanelError(error) && error.code === 'SERVICE_UNAVAILABLE' &&
      error.detail?.stateChanged === false && error.detail?.reason === 'archive_capacity_busy')
    assert.deepEqual(await slow.list(''), [])
    for (const release of releases) release()
    assert.equal((await Promise.all(running)).length, MAX_ACTIVE_ARCHIVE_OPERATIONS)
    assert.deepEqual(budgets, [...Array<[string, number]>(MAX_ACTIVE_ARCHIVE_OPERATIONS).fill(['extract', ARCHIVE_HELPER_TIMEOUT_MS]), ['list', DEFAULT_HELPER_TIMEOUT_MS]])
  })

  it('lets the agent socket wait for the archive worker on the account file route only', () => {
    assert.ok((agentRouteTimeoutMs('/accounts/alice/files') ?? 0) > ARCHIVE_HELPER_TIMEOUT_MS)
    assert.equal(agentRouteTimeoutMs('/accounts/alice/files/extra'), undefined)
    assert.equal(agentRouteTimeoutMs('/accounts/Alice/files'), undefined)
    assert.equal(agentRouteTimeoutMs('/host/account-provisioning'), 180_000)
  })
})

describe('agent file route compress and extract', { tags: ['feature'] }, () => {
  it('admits only the exact wire fields, runs the helper operation and audits source and destination', async () => {
    const state = await createTestStateStore(), db = await createTestDb()
    try {
      const features = await state.store.createFeatureList({ name: 'Standard', ownerId: null, disabled: [] })
      const plan = await state.store.createPlan({ ...defaultPlan({ id: 'unused', name: 'Pro', featureListId: features.id }), ownerId: null })
      await state.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
      const stored = await state.store.createAccount({ username: 'alice', passwordHash: ARGON2, primaryDomain: 'alice.example.com', planId: plan.id, ownerId: null, contactEmail: 'alice@example.com', ipv4: '203.0.113.10', shell: 'none',
        php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} } })
      const principal = await createUserPrincipal(db.db, { username: 'alice', passwordHash: ARGON2, accountId: stored.id })
      const calls: AccountFileRequest[] = []
      const runner: AccountFileRunner = { async run(_context, request) {
        calls.push(request)
        const destination = (request as { destination: string }).destination
        return request.op === 'compress' ? entry(destination) : { destination, entries: 2, bytes: 10 }
      } }
      const token = 'a'.repeat(64)
      const app = createAgentApp({ store: state.store, db: db.db, agentToken: token, os: { id: 'ubuntu', versionId: '24.04', family: 'debian' }, accountFileRunner: runner } as Parameters<typeof createAgentApp>[0])
      const post = (body: unknown) => app.fetch(new Request('http://agent.local/accounts/alice/files', { method: 'POST', headers: { ...agentCallerHeaders({ principalId: principal.id, token }), 'content-type': 'application/json' }, body: JSON.stringify(body) }))
      for (const bad of [{ op: 'compress', path: 'a', destination: 'a.zip', format: 'zip' }, { op: 'extract', path: 'a.zip', destination: 7 }, { op: 'extract', path: 'a.zip', target: 'out' }]) assert.equal((await post(bad)).status, 422)
      assert.equal(calls.length, 0)
      const compressed = await post({ op: 'compress', path: 'public_html', destination: 'site.zip' })
      assert.equal(compressed.status, 200)
      assert.deepEqual(await compressed.json(), entry('site.zip'))
      const extracted = await post({ op: 'extract', path: 'site.zip', destination: '' })
      assert.equal(extracted.status, 200)
      assert.deepEqual(await extracted.json(), { destination: '', entries: 2, bytes: 10 })
      const audit = await listAudit(db.db, { limit: 10 })
      for (const [action, op, path, destination] of [['file.compress', 'compress', 'public_html', 'site.zip'], ['file.extract', 'extract', 'site.zip', '']]) {
        const row = audit.find(item => item.action === action)
        assert.equal(row?.outcome, 'ok')
        assert.deepEqual(row?.detail, { op, path, destination })
      }
    } finally { await state.close(); await db.close() }
  })
})
