import { createStrictTestDb } from '../strict-test-db.ts'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { createDb, type DbHandle } from '../client.ts'
import { getStrictOperationDatabaseOrigin } from '../sql-runner.ts'
import type { SqlRunner } from '../sql-runner.ts'
import { createRootPrincipal } from './principals.ts'
import { createJob } from './jobs.ts'
import { randomUUID } from 'node:crypto'
import { ARGON2 } from '../testing.ts'
import {
  assertOperationIntentReceipt as assertRealOperationIntentReceipt,
  createRootOperationAuditAuthority,
  assertPersistedLifecycleIntent,
  LIFECYCLE_INTENT_ACTIONS,
} from './operation-audit-authority.ts'

const binding = Object.freeze({
  purpose: 'host.reconcile.intent' as const,
  jobId: 'e1111111-1111-4111-8111-111111111111',
  requestFingerprint: 'a'.repeat(64),
  action: 'account.update',
  principalId: 'e1111111-1111-4111-8111-111111111112',
})
// Negative-only adapter: unknown objects must fail the private capability lookup
// before any transaction access. It cannot produce an accepted receipt.
const assertOperationIntentReceipt = (receipt: unknown, expected: Parameters<typeof assertRealOperationIntentReceipt>[1]) =>
  assertRealOperationIntentReceipt(receipt, expected, {} as SqlRunner)
const handles: DbHandle[] = []
const directories: string[] = []
const unavailable = (error: unknown): boolean => isXpanelError(error) && error.code === 'PRECONDITION_FAILED'
const freshDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'xpanel-operation-audit-denials-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('operation audit capability boundary: real DB denials, no privileged test producer', () => {
  it('binds every finite lifecycle purpose to an actual persisted job and enabled root without granting a receipt', async () => {
    const handle = await createStrictTestDb(); handles.push(handle)
    const principal = await createRootPrincipal(handle.db, { username: 'lifecyclefixture', passwordHash: ARGON2, forcePasswordChange: false })
    for (const action of LIFECYCLE_INTENT_ACTIONS) {
      const expected = { ...binding, purpose: 'host.lifecycle.intent' as const, jobId: randomUUID(), action, principalId: principal.id }
      await expect(handle.db.transaction(tx => assertPersistedLifecycleIntent(tx, expected))).rejects.toSatisfy(unavailable)
      await createJob(handle.db, { id: expected.jobId, kind: action, actor: principal.username, detail: { lifecycleIntent: expected } })
      await handle.db.transaction(tx => assertPersistedLifecycleIntent(tx, expected))
      expect(() => assertOperationIntentReceipt({ ...expected, durable: true }, expected)).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
      await expect(handle.db.transaction(tx => assertPersistedLifecycleIntent(tx, { ...expected, requestFingerprint: 'b'.repeat(64) }))).rejects.toSatisfy(unavailable)
      await handle.db.query('UPDATE principals SET disabled=1 WHERE id=$1', [principal.id])
      await expect(handle.db.transaction(tx => assertPersistedLifecycleIntent(tx, expected))).rejects.toSatisfy(unavailable)
      await handle.db.query('UPDATE principals SET disabled=0 WHERE id=$1', [principal.id])
    }
  })

  it('refuses unknown lifecycle actions, extra purposes and lifecycle actions disguised as reconcile intents', () => {
    for (const changed of [
      { purpose: 'host.lifecycle.intent', action: 'lifecycle.delete' },
      { purpose: 'host.lifecycle.intent', action: 'account.update' },
      { purpose: 'host.lifecycle.any', action: 'lifecycle.upgrade' },
      { purpose: 'host.reconcile.intent', action: 'lifecycle.upgrade' },
    ]) expect(() => assertOperationIntentReceipt({}, { ...binding, ...changed } as never)).toThrowError(expect.objectContaining({ code: 'VALIDATION' }))
  })

  it('refuses a lifecycle job bound to a different actor or missing its canonical persisted intent', async () => {
    const handle = await createStrictTestDb(); handles.push(handle)
    const principal = await createRootPrincipal(handle.db, { username: 'lifecyclefixture', passwordHash: ARGON2, forcePasswordChange: false })
    const expected = { ...binding, purpose: 'host.lifecycle.intent' as const, jobId: randomUUID(), action: 'lifecycle.adopt', principalId: principal.id }
    await createJob(handle.db, { id: expected.jobId, kind: expected.action, actor: 'different', detail: { lifecycleIntent: expected } })
    await expect(handle.db.transaction(tx => assertPersistedLifecycleIntent(tx, expected))).rejects.toSatisfy(unavailable)
    await handle.db.query('UPDATE jobs SET actor=$1,detail=$2 WHERE id=$3', [principal.username, '{}', expected.jobId])
    await expect(handle.db.transaction(tx => assertPersistedLifecycleIntent(tx, expected))).rejects.toSatisfy(unavailable)
  })

  it.each([
    null,
    undefined,
    true,
    {},
    { durable: true, eventUid: binding.jobId, entryHash: 'b'.repeat(64), seq: 1, ...binding },
    Object.freeze({ durable: true, eventUid: binding.jobId, hash: 'b'.repeat(64) }),
    Object.create(null),
    JSON.parse(JSON.stringify({ ...binding, durable: true, eventUid: binding.jobId, entryHash: 'b'.repeat(64) })),
  ])('rejects a caller-constructed receipt %#', (receipt) => {
    expect(() => assertOperationIntentReceipt(receipt, binding)).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
  })

  it('does not read attacker getters to decide capability identity', () => {
    let read = false
    const forged = Object.defineProperty({}, 'durable', { get() { read = true; throw new Error('untrusted getter') } })
    expect(() => assertOperationIntentReceipt(forged, binding)).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
    expect(read).toBe(false)
  })

  it('does not turn a real SQLite row with forged audit metadata into a receipt', async () => {
    const handle = await createStrictTestDb()
    handles.push(handle)
    const principal = await createRootPrincipal(handle.db, { username: 'auditfixture', passwordHash: ARGON2, forcePasswordChange: false })
    const expected = { ...binding, principalId: principal.id }
    const detail = { ...expected, _auditEventUid: binding.jobId, _auditEntryHash: 'b'.repeat(64), _auditPrevHash: '0'.repeat(64), _auditSeq: 1 }
    const rows = await handle.db.query('INSERT INTO audit_log (at, actor, principal_id, ip, action, target, detail, outcome) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7) RETURNING *', [new Date().toISOString(), principal.username, principal.id, expected.purpose, 'operation:' + expected.jobId, JSON.stringify(detail), 'ok'])
    expect(rows).toHaveLength(1)
    expect(() => assertOperationIntentReceipt(rows[0], expected)).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
    expect(() => assertOperationIntentReceipt({ durable: true, ...detail }, expected)).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
  })

  it('does not treat the second allowed purpose as a metadata authorization path', () => {
    const repair = { ...binding, purpose: 'reference.repair.intent' as const, action: 'job.reference.repair' }
    expect(() => assertOperationIntentReceipt({ ...repair, durable: true, eventUid: binding.jobId, entryHash: 'b'.repeat(64), seq: 1 }, repair)).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
  })

  it('rejects noncanonical fingerprints and extra authorization fields', () => {
    for (const changed of [{ requestFingerprint: 'A'.repeat(64) }, { principalId: '' }, { purpose: 'api.audit' }, { durable: true }]) {
      expect(() => assertOperationIntentReceipt({}, { ...binding, ...changed } as never)).toThrowError(expect.objectContaining({ code: 'VALIDATION' }))
    }
  })

  it('requires a genuine strict transaction rather than a metadata-shaped SQL runner', async () => {
    const directory = await freshDirectory()
    const fake = { query: async () => [], exec: async () => {}, transaction: async (fn: (tx: SqlRunner) => Promise<unknown>) => fn(fake as SqlRunner) }
    await expect(createRootOperationAuditAuthority(fake as SqlRunner, { directory: join(directory, 'must-not-exist') })).rejects.toSatisfy(unavailable)
    expect(await readdir(directory)).toEqual([])
  })

  it('rejects an outer provider that skips the genuine transaction callback and returns a copied strict origin', async () => {
    const directory = await freshDirectory()
    const handle = await createStrictTestDb()
    handles.push(handle)
    const copiedOrigin = await handle.db.transaction(async tx => ({ ...getStrictOperationDatabaseOrigin(tx) }))
    let callbackSkipped = false
    const provider: SqlRunner = {
      query: async () => [],
      exec: async () => {},
      transaction: async () => { callbackSkipped = true; return copiedOrigin as never },
    }
    const error = await createRootOperationAuditAuthority(provider, { directory: join(directory, 'must-not-exist') }).then(() => null, error => error)
    expect(callbackSkipped).toBe(false)
    expect(error).toEqual(expect.objectContaining({ code: 'PRECONDITION_FAILED', message: expect.stringMatching(/registered.*(?:database|runner)/i) }))
    expect(await readdir(directory)).toEqual([])
  })
  it.each(['proxy', 'delegating-wrapper'] as const)('rejects a %s around a genuine public runner before invoking its transaction method', async mode => {
    const directory = await freshDirectory()
    const handle = await createStrictTestDb()
    handles.push(handle)
    let invoked = false
    const transaction = handle.db.transaction.bind(handle.db)
    const provider: SqlRunner = mode === 'proxy'
      ? new Proxy(handle.db, { get(target, key, receiver) {
        if (key === 'transaction') return async <T>(callback: (tx: SqlRunner) => Promise<T>) => { invoked = true; return transaction(callback) }
        return Reflect.get(target, key, receiver)
      } })
      : { ...handle.db, transaction: async callback => { invoked = true; return transaction(callback) } }
    const error = await createRootOperationAuditAuthority(provider, { directory: join(directory, 'must-not-exist') }).then(() => null, error => error)
    expect(invoked).toBe(false)
    expect(error).toEqual(expect.objectContaining({ code: 'PRECONDITION_FAILED', message: expect.stringMatching(/registered.*(?:database|runner)/i) }))
    expect(await readdir(directory)).toEqual([])
  })
  it('rejects a real NORMAL file database before creating sink files', async () => {
    const directory = await freshDirectory()
    const handle = createDb(join(directory, 'normal.sqlite'))
    handles.push(handle)
    await expect(createRootOperationAuditAuthority(handle.db, { directory: join(directory, 'must-not-exist') })).rejects.toSatisfy(unavailable)
    expect((await readdir(directory)).some(name => name === 'must-not-exist')).toBe(false)
  })

  it('rejects a real memory database rather than treating it as durable', async () => {
    const directory = await freshDirectory()
    const handle = createDb(':memory:')
    handles.push(handle)
    await expect(createRootOperationAuditAuthority(handle.db, { directory: join(directory, 'must-not-exist') })).rejects.toSatisfy(unavailable)
    expect(await readdir(directory)).toEqual([])
  })

  it('rejects a passed outer transaction before filesystem effects', async () => {
    const directory = await freshDirectory()
    const handle = await createStrictTestDb()
    handles.push(handle)
    await handle.db.transaction(async tx => {
      await expect(createRootOperationAuditAuthority(tx, { directory: join(directory, 'must-not-exist') })).rejects.toThrow('registered public database runner')
    })
    expect(await readdir(directory)).toEqual([])
  })

  it('rejects use of the outer connection from an active transaction', async () => {
    const directory = await freshDirectory()
    const handle = await createStrictTestDb()
    handles.push(handle)
    await handle.db.transaction(async () => {
      await expect(createRootOperationAuditAuthority(handle.db, { directory: join(directory, 'must-not-exist') })).rejects.toThrow(/active.*transaction/i)
    })
    expect(await readdir(directory)).toEqual([])
  })

  it.each(['different-files', 'same-file'] as const)('rejects any genuine outer transaction across %s connections before audit or DB acquisition', async mode => {
    const directory = await freshDirectory()
    const first = createDb(join(directory, 'first.sqlite'), { durability: 'strict', busyTimeoutMs: 0 })
    const second = createDb(join(directory, mode === 'same-file' ? 'first.sqlite' : 'second.sqlite'), { durability: 'strict', busyTimeoutMs: 0 })
    handles.push(first, second)
    await first.db.transaction(async () => {
      await expect(createRootOperationAuditAuthority(second.db, { directory: join(directory, 'must-not-exist') })).rejects.toThrow(/active.*transaction/i)
    })
    expect((await readdir(directory)).includes('must-not-exist')).toBe(false)
  })

  it('rechecks actual strict SQLite policy after connection creation', async () => {
    const directory = await freshDirectory()
    const handle = await createStrictTestDb()
    handles.push(handle)
    handle.sqlite.exec('PRAGMA synchronous = NORMAL')
    await expect(createRootOperationAuditAuthority(handle.db, { directory: join(directory, 'must-not-exist') })).rejects.toSatisfy(unavailable)
    expect(await readdir(directory)).toEqual([])
  })

  it('has no unknown option allowing a root or durability bypass', async () => {
    const directory = await freshDirectory()
    const handle = await createStrictTestDb()
    handles.push(handle)
    await expect(createRootOperationAuditAuthority(handle.db, { directory, requireRoot: false } as never)).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION' }))
    expect(await readdir(directory)).toEqual([])
  })

  it.skipIf(process.platform === 'linux' && process.getuid?.() === 0)('refuses the actual unsupported platform or nonroot process with a real strict file DB', async () => {
    const directory = await freshDirectory()
    const handle = await createStrictTestDb()
    handles.push(handle)
    await expect(createRootOperationAuditAuthority(handle.db, { directory: join(directory, 'must-not-exist') })).rejects.toSatisfy(unavailable)
    expect(await readdir(directory)).toEqual([])
  })
})
