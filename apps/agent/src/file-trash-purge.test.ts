import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan, isXpanelError } from '@xpanel/core'
import { createTestDb, createUserPrincipal, listAudit } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { JailedFileManager } from './file-manager.ts'
import type { AccountFileRequest, AccountFileRunner, TrashItem } from './file-manager.ts'
import { agentCallerHeaders, createAgentApp } from './server.ts'

// Public PHC-format fixture only; never a credential.
const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const account = { username: 'alice', uid: 29101, gid: 29101, home: '/home/alice' }
const item: TrashItem = { id: 'b12c4154-4e6c-4b2c-a2bc-aad60d40705e', originalPath: 'public_html/old.txt', name: 'old.txt', sizeBytes: 3, deletedAt: '2026-10-22T08:00:00.000Z' }
const revision = { originalPath: item.originalPath, deletedAt: item.deletedAt }
const refused = (code: string) => (error: unknown): boolean => isXpanelError(error) && error.code === code && error.detail?.stateChanged === false

const manager = (listed: TrashItem[], purge: (request: Readonly<AccountFileRequest>) => unknown = () => ({ ...item })) => {
  const calls: AccountFileRequest[] = []
  const runner: AccountFileRunner = { async run(_context, request) { calls.push(request); return request.op === 'list-trash' ? listed : purge(request) } }
  return { files: new JailedFileManager('/srv/homes/alice', 'unlimited', { account, runner }), calls }
}

describe('permanent deletion of one trash item', () => {
  it('reads the current item, then asks the confined runner to purge exactly the reviewed revision', async () => {
    const { files, calls } = manager([item])
    assert.deepEqual(await files.purgeTrash(item.id, revision), item)
    assert.deepEqual(calls, [{ op: 'list-trash' }, { op: 'purge-trash', trashId: item.id, originalPath: item.originalPath, deletedAt: item.deletedAt }])
  })

  it('refuses a missing or changed item unchanged, before any purge reaches the runner', async () => {
    const missing = manager([])
    await assert.rejects(() => missing.files.purgeTrash(item.id, revision), refused('NOT_FOUND'))
    for (const changed of [{ ...item, deletedAt: '2026-10-23T08:00:00.000Z' }, { ...item, originalPath: 'other/old.txt' }]) {
      const stale = manager([changed])
      await assert.rejects(() => stale.files.purgeTrash(item.id, revision), refused('CONFLICT'))
      assert.deepEqual(stale.calls.map(call => call.op), ['list-trash'])
    }
    assert.deepEqual(missing.calls.map(call => call.op), ['list-trash'])
  })

  it.each([
    ['../x', revision], [item.id, { ...revision, originalPath: '.trash/old.txt' }], [item.id, { ...revision, originalPath: '/etc/passwd' }],
    [item.id, { ...revision, deletedAt: '2026-02-31T00:00:00Z' }], [item.id, { ...revision, deletedAt: 'yesterday' }],
  ])('rejects malformed input %j without runner access', async (id, expected) => {
    const { files, calls } = manager([item])
    await assert.rejects(() => files.purgeTrash(id, expected), (error: unknown) => isXpanelError(error) && ['VALIDATION', 'FORBIDDEN'].includes(error.code))
    assert.equal(calls.length, 0)
  })

  it.each([
    { ...item, id: 'c12c4154-4e6c-4b2c-a2bc-aad60d40705e' }, { ...item, deletedAt: '2026-10-23T08:00:00.000Z' },
    { ...item, originalPath: 'other/old.txt', name: 'old.txt' }, { ...item, extra: true }, 1,
  ])('treats a runner acknowledgement for another item as invalid %#', async (reply) => {
    const { files } = manager([item], () => reply)
    await assert.rejects(() => files.purgeTrash(item.id, revision), (error: unknown) => isXpanelError(error) && error.code === 'CONFIG_TEST_FAILED')
  })

  it('fails closed without a confined runner', async () => {
    const files = new JailedFileManager('/srv/homes/alice', 'unlimited', { account })
    await assert.rejects(() => files.purgeTrash(item.id, revision), (error: unknown) => isXpanelError(error) && error.code === 'PRECONDITION_FAILED' && error.detail?.stateChanged === false)
  })

  it('admits the exact agent wire fields, purges through the runner and audits the original path', async () => {
    const state = await createTestStateStore(), db = await createTestDb()
    try {
      const features = await state.store.createFeatureList({ name: 'Standard', ownerId: null, disabled: [] })
      const plan = await state.store.createPlan({ ...defaultPlan({ id: 'unused', name: 'Pro', featureListId: features.id }), ownerId: null })
      await state.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
      const stored = await state.store.createAccount({ username: 'alice', passwordHash: ARGON2, primaryDomain: 'alice.example.com', planId: plan.id, ownerId: null, contactEmail: 'alice@example.com', ipv4: '203.0.113.10', shell: 'none',
        php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} } })
      const principal = await createUserPrincipal(db.db, { username: 'alice', passwordHash: ARGON2, accountId: stored.id })
      const calls: AccountFileRequest[] = [], runner: AccountFileRunner = { async run(_context, request) { calls.push(request); return request.op === 'list-trash' ? [item] : { ...item } } }
      const token = 'a'.repeat(64)
      const app = createAgentApp({ store: state.store, db: db.db, agentToken: token, os: { id: 'ubuntu', versionId: '24.04', family: 'debian' }, accountFileRunner: runner } as Parameters<typeof createAgentApp>[0])
      const post = (body: unknown) => app.fetch(new Request('http://agent.local/accounts/alice/files', { method: 'POST', headers: { ...agentCallerHeaders({ principalId: principal.id, token }), 'content-type': 'application/json' }, body: JSON.stringify(body) }))
      const wire = { op: 'purge-trash', trashId: item.id, ...revision }
      for (const bad of [{ ...wire, path: item.originalPath }, { ...wire, deletedAt: 1 }, { ...wire, overwrite: true }]) assert.equal((await post(bad)).status, 422)
      assert.equal(calls.length, 0)
      const reply = await post(wire)
      assert.equal(reply.status, 200)
      assert.deepEqual(await reply.json(), item)
      assert.deepEqual(calls.map(call => call.op), ['list-trash', 'purge-trash'])
      const audit = (await listAudit(db.db, { limit: 10 })).find(entry => entry.action === 'file.purge_trash')
      assert.equal(audit?.outcome, 'ok'); assert.equal(audit?.actor, 'alice')
      assert.deepEqual(audit?.detail, { op: 'purge-trash', path: item.originalPath, trashId: item.id })
    } finally { await state.close(); await db.close() }
  })
})
