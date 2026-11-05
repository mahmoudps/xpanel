import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan, isXpanelError } from '@xpanel/core'
import { createTestDb, createUserPrincipal, listAudit } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { ACCOUNT_FILE_HELPER_PROTOCOL_VERSION } from './account-file-runner.ts'
import { JailedFileManager, NativeAccountFileRunner } from './file-manager.ts'
import type { AccountFileRequest, AccountFileRunner, FileEntry } from './file-manager.ts'
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

describe('confined move and copy requests', { tags: ['unit'] }, () => {
  it('sends exactly the source and destination and returns the destination entry', async () => {
    const moved = manager(request => entry((request as { destination: string }).destination, { mode: 0o644 }))
    assert.deepEqual(await moved.files.move('public_html/a.txt', 'archive/b.txt'), entry('archive/b.txt', { mode: 0o644 }))
    const copied = manager(request => entry((request as { destination: string }).destination, { kind: 'directory', sizeBytes: 0, mode: 0o750 }))
    assert.deepEqual(await copied.files.copy('public_html/theme', 'archive/theme'), entry('archive/theme', { kind: 'directory', sizeBytes: 0, mode: 0o750 }))
    assert.deepEqual([...moved.calls, ...copied.calls], [
      { op: 'move', path: 'public_html/a.txt', destination: 'archive/b.txt' },
      { op: 'copy', path: 'public_html/theme', destination: 'archive/theme' },
    ])
  })

  it.each([
    ['public_html/a.txt', '../outside'], ['public_html/a.txt', '/etc/passwd'], ['public_html/a.txt', '.trash/a.txt'], ['.trash/x', 'a'],
    ['public_html', 'public_html'], ['public_html', 'public_html/inner'], ['public_html/a.txt', 'a//b'], ['public_html/a.txt', ''],
  ])('refuses %j to %j before the runner', async (path, destination) => {
    for (const op of ['move', 'copy'] as const) {
      const { files, calls } = manager(() => entry(destination))
      await assert.rejects(() => files[op](path, destination), (error: unknown) => isXpanelError(error) && ['VALIDATION', 'FORBIDDEN'].includes(error.code))
      assert.equal(calls.length, 0)
    }
  })

  it('treats an acknowledgement for another target, a symlink or an out-of-ceiling copy as invalid', async () => {
    for (const reply of [entry('archive/other.txt'), entry('archive/b.txt', { kind: 'symlink' }), { ...entry('archive/b.txt'), extra: true }, null]) {
      await assert.rejects(() => manager(() => reply).files.move('public_html/a.txt', 'archive/b.txt'), code('CONFIG_TEST_FAILED'))
    }
    for (const reply of [entry('archive/b.txt', { mode: 0o644 }), entry('archive/b.txt', { kind: 'directory', mode: 0o750, sizeBytes: 4096 }), entry('archive/b.txt', { kind: 'symlink' })]) {
      await assert.rejects(() => manager(() => reply).files.copy('public_html/a.txt', 'archive/b.txt'), code('CONFIG_TEST_FAILED'))
    }
  })

  it('fails closed without a confined runner', async () => {
    const files = new JailedFileManager('/srv/homes/alice', 'unlimited', { account })
    for (const op of ['move', 'copy'] as const) {
      await assert.rejects(() => files[op]('public_html/a.txt', 'archive/b.txt'), (error: unknown) => isXpanelError(error) && error.code === 'PRECONDITION_FAILED' && error.detail?.stateChanged === false)
    }
  })
})

describe('confined runner refusal outcome for move and copy', { tags: ['unit'] }, () => {
  const refusing = (code: string) => new JailedFileManager('/srv/homes/alice', 'unlimited', { account, runner: new NativeAccountFileRunner({
    binaryPath: '/opt/xpanel/bin/xpanel-account-files',
    spawner: async ({ stdinPayload }) => ({ exitCode: 0, signal: null, pid: 100, stderr: '', stdout: JSON.stringify({
      protocolVersion: ACCOUNT_FILE_HELPER_PROTOCOL_VERSION, ok: false, op: (JSON.parse(stdinPayload) as { request: AccountFileRequest }).request.op,
      worker: { pid: 100, uid: account.uid, gid: account.gid, cgroup: '/' }, error: { code, errno: 17, errnoName: 'EEXIST', message: 'refused' },
    }) }),
  }) })

  it('marks helper refusals before the publishing rename as unchanged, and nothing after it', async () => {
    for (const op of ['move', 'copy'] as const) {
      for (const refusal of ['VALIDATION', 'CONFLICT', 'FORBIDDEN', 'NOT_FOUND', 'LIMIT_EXCEEDED', 'PRECONDITION_FAILED']) {
        await assert.rejects(() => refusing(refusal)[op]('public_html/a.txt', 'archive/b.txt'), (error: unknown) => isXpanelError(error) && error.code === refusal && error.detail?.stateChanged === false)
      }
      for (const outcome of ['SERVICE_UNAVAILABLE', 'CONFIG_TEST_FAILED']) {
        await assert.rejects(() => refusing(outcome)[op]('public_html/a.txt', 'archive/b.txt'), (error: unknown) => isXpanelError(error) && error.code === outcome && error.detail?.stateChanged === undefined)
      }
    }
  })
})

describe('agent file route move and copy', { tags: ['feature'] }, () => {
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
      const runner: AccountFileRunner = { async run(_context, request) { calls.push(request); return entry((request as { destination: string }).destination) } }
      const token = 'a'.repeat(64)
      const app = createAgentApp({ store: state.store, db: db.db, agentToken: token, os: { id: 'ubuntu', versionId: '24.04', family: 'debian' }, accountFileRunner: runner } as Parameters<typeof createAgentApp>[0])
      const post = (body: unknown) => app.fetch(new Request('http://agent.local/accounts/alice/files', { method: 'POST', headers: { ...agentCallerHeaders({ principalId: principal.id, token }), 'content-type': 'application/json' }, body: JSON.stringify(body) }))
      for (const bad of [{ op: 'move', path: 'a.txt', destination: 'b.txt', overwrite: true }, { op: 'copy', path: 'a.txt', destination: 7 }, { op: 'move', path: 'a.txt', target: 'b.txt' }]) assert.equal((await post(bad)).status, 422)
      assert.equal(calls.length, 0)
      for (const op of ['move', 'copy']) {
        const reply = await post({ op, path: 'public_html/a.txt', destination: 'archive/a.txt' })
        assert.equal(reply.status, 200)
        assert.deepEqual(await reply.json(), entry('archive/a.txt'))
      }
      assert.deepEqual(calls.map(call => call.op), ['move', 'copy'])
      const audit = await listAudit(db.db, { limit: 10 })
      for (const [action, op] of [['file.move', 'move'], ['file.copy', 'copy']]) {
        const row = audit.find(item => item.action === action)
        assert.equal(row?.outcome, 'ok')
        assert.deepEqual(row?.detail, { op, path: 'public_html/a.txt', destination: 'archive/a.txt' })
      }
    } finally { await state.close(); await db.close() }
  })
})
