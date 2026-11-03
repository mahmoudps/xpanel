import { randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WriterLock, acquireExistingWriterMutex } from '@xpanel/state'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDb, type DbHandle } from '../client.ts'
import { migrate } from '../migrate.ts'
import { withReadonlyOperationDatabase, getReadonlyOperationDatabaseOrigin, assertReadonlyOperationDatabaseCurrent } from '../readonly-operation-database.ts'
import { getStrictOperationDatabaseOrigin } from '../sql-runner.ts'
import { ARGON2 } from '../testing.ts'
import { initializeOperationalMetadata } from './official-references.ts'
import { createRootPrincipal } from './principals.ts'
import { createJob } from './jobs.ts'
import { assertOperationIntentReceipt, createRootOperationAuditAuthority, withReadonlyLifecycleIntentObservation,
  assertReadonlyLifecycleIntentObservationCurrent, OPERATION_AUDIT_ANCHOR_NAME, OPERATION_AUDIT_LOG_NAME, OPERATION_AUDIT_PENDING_NAME,
  withReadonlyLifecycleIntentFileObservation, getReadonlyLifecycleIntentFileObservationInfo, assertReadonlyLifecycleIntentFileObservationCurrent,
  type OperationIntentBinding, type OperationIntentReceipt, type ReadonlyLifecycleIntentObservation } from './operation-audit-authority.ts'
import { classifyIssuedLifecycleAppend, normalizeIssuedLifecycleAppendPlan, withReadonlyIssuedLifecycleAppendPrefixObservation,
  withReadonlyIssuedLifecycleAppendDatabaseObservation, assertReadonlyIssuedLifecycleAppendRetainedIntent,
  getReadonlyIssuedLifecycleAppendPrefixInfo, type IssuedLifecycleAppendPlan } from './operation-audit-authority.ts'

// Explicit authority seam for algorithm/crash fixtures only. These cases prove
// no native root-dispatch, stop, EX or closed-reader admission. Native acceptance
// must exercise the real producer separately on the qualification profiles.
const issuedRepairFixture = vi.hoisted(() => ({ plans: new WeakMap<object, unknown>(), unretired: false, afterGate: null as null | (() => Promise<void>) }))
vi.mock('../../../../scripts/lifecycle-root-safety.mjs', () => ({
  assertLifecycleIssuedAuditRepairHeld: async (cap: object) => { if (!issuedRepairFixture.plans.has(cap)) throw new Error('unissued fixture repair') },
  getLifecycleIssuedAuditRepairInfo: (cap: object) => ({ purpose: 'issued-lifecycle-audit-repair', plan: issuedRepairFixture.plans.get(cap) }),
}))

vi.mock('../../../../scripts/lifecycle-issued-audit.mjs', () => ({
  assertNoUnretiredIssuedLifecycleAudit: async () => { if (issuedRepairFixture.unretired) throw new Error('unretired issued native journal'); const hook = issuedRepairFixture.afterGate; issuedRepairFixture.afterGate = null; if (hook) await hook() },
}))

// This lane requires actual Linux root and uses only fresh /root fixtures. No installed paths.
const roots: string[] = [], handles: DbHandle[] = []
beforeAll(() => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new Error('BLOCKED: actual native Linux root is required for read-only audit evidence')
})
afterEach(async () => {
  issuedRepairFixture.unretired = false; issuedRepairFixture.afterGate = null
  for (const handle of handles.splice(0)) await handle.close()
  for (const root of roots.splice(0)) {
    const target = resolve(root)
    if (target !== root || dirname(target) !== '/root' || !target.startsWith('/root/xpanel-readonly-audit-')) throw new Error('Unsafe fixture cleanup path')
    await rm(target, { recursive: true, force: true })
  }
})
const fixture = async () => {
  const root = await mkdtemp('/root/xpanel-readonly-audit-'); roots.push(root); await chmod(root, 0o700)
  const directory = join(root, 'sink'); await mkdir(directory, { mode: 0o700 })
  const dbPath = join(root, 'control.sqlite'), handle = createDb(dbPath, { durability: 'strict' }); handles.push(handle)
  await migrate(handle.db); await initializeOperationalMetadata(handle.db)
  for (const path of [dbPath, dbPath + '-wal', dbPath + '-shm']) await chmod(path, 0o600)
  const principal = await createRootPrincipal(handle.db, { username: 'readonlyauditor', passwordHash: ARGON2, forcePasswordChange: false })
  // Finalization provides the ordinary completed baseline; upgrade/recovery use the issued path below.
  const binding: OperationIntentBinding = { purpose: 'host.lifecycle.intent', jobId: randomUUID(), requestFingerprint: 'a'.repeat(64), action: 'lifecycle.adopt', principalId: principal.id }
  await createJob(handle.db, { id: binding.jobId, kind: binding.action, actor: principal.username, detail: { lifecycleIntent: binding } })
  const authority = await createRootOperationAuditAuthority(handle.db, { directory })
  const receipt = await authority.appendLifecycleIntent(binding)
  return { root, directory, dbPath, handle, binding, authority, receipt,
    log: join(directory, OPERATION_AUDIT_LOG_NAME), anchor: join(directory, OPERATION_AUDIT_ANCHOR_NAME), pending: join(directory, OPERATION_AUDIT_PENDING_NAME) }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const verified = (f: Fixture, receipt: unknown) => f.handle.db.transaction(async tx => assertOperationIntentReceipt(receipt, f.binding, tx))
const observe = <T>(f: Fixture, work: (value: ReadonlyLifecycleIntentObservation) => Promise<T>) =>
  withReadonlyOperationDatabase(f.dbPath, reader => withReadonlyLifecycleIntentObservation(reader, f.binding, work, { directory: f.directory }))
const disk = async (directory: string): Promise<unknown> => {
  const entries: unknown[] = []
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), info = await lstat(path, { bigint: true })
    entries.push({ name, dev: String(info.dev), ino: String(info.ino), mode: String(info.mode), size: String(info.size),
      mtime: String(info.mtimeNs), ctime: String(info.ctimeNs), bytes: info.isFile() && !name.startsWith('.writer-mutex.sqlite') ? (await readFile(path)).toString('base64') : null })
  }
  return entries
}

const issuedFixture = async () => {
  const f = await fixture(), binding: OperationIntentBinding = { ...f.binding, jobId: randomUUID(), action: 'lifecycle.recover', requestFingerprint: 'b'.repeat(64) }
  await createJob(f.handle.db, { id: binding.jobId, kind: binding.action, actor: 'readonlyauditor', detail: { lifecycleIntent: binding } })
  let plan: Readonly<IssuedLifecycleAppendPlan> | undefined
  await expect(f.authority.appendIssuedLifecycleIntent(binding, async value => { plan = value; throw new Error('fixture stops after durable issuance point') })).rejects.toThrow('fixture stops')
  expect(plan).toBeDefined()
  return { ...f, issuedBinding: binding, plan: plan! }
}
const issuedBytes = (plan: IssuedLifecycleAppendPlan) => {
  const line = Buffer.from(JSON.stringify(plan.record) + '\n')
  const pending = Buffer.from(JSON.stringify({ schemaVersion: 1, logIdentity: plan.priorAnchor.logIdentity, priorAnchor: plan.priorAnchor,
    priorBytes: plan.priorAnchor.bytes, priorSeq: plan.priorAnchor.lastSeq, priorHash: plan.priorAnchor.lastHash, record: plan.record }) + '\n')
  const next = Buffer.from(JSON.stringify({ ...plan.priorAnchor, lastSeq: plan.record.seq, lastHash: plan.record.entryHash, bytes: plan.priorAnchor.bytes + line.length }) + '\n')
  return { line, pending, next }
}
const prefix = <T>(f: Awaited<ReturnType<typeof issuedFixture>>, work: Parameters<typeof withReadonlyIssuedLifecycleAppendPrefixObservation<T>>[1]) =>
  withReadonlyIssuedLifecycleAppendPrefixObservation(f.plan, work, { directory: f.directory })

describe('exact issued lifecycle append recovery algorithm; native admission is a separate gate', () => {
  it('issues one immutable event under the original mutex and keeps its lease through index and finish', async () => {
    const f = await fixture(), binding = { ...f.binding, action: 'lifecycle.upgrade', jobId: randomUUID(), requestFingerprint: 'c'.repeat(64) }
    await createJob(f.handle.db, { id: binding.jobId, kind: binding.action, actor: 'readonlyauditor', detail: { lifecycleIntent: binding } })
    let plan: Readonly<IssuedLifecycleAppendPlan> | undefined
    const receipt = await f.authority.appendIssuedLifecycleIntent(binding, async value => {
      plan = value
      expect(Object.isFrozen(value.record)).toBe(true)
      expect((await readdir(f.directory)).includes(OPERATION_AUDIT_PENDING_NAME)).toBe(false)
      expect(await readFile(join(f.directory, '.lock', 'owner.json'), 'utf8')).toBe(value.writer.ownerRaw)
    })
    expect(await readFile(join(f.directory, 'authority.json'), 'utf8')).toBe(plan!.writer.authorityRaw)
    expect((await readdir(f.directory)).includes('.lock')).toBe(false)
    await f.handle.db.transaction(async tx => expect(assertOperationIntentReceipt(receipt, binding, tx).entryHash).toBe(plan!.record.entryHash))
    await withReadonlyOperationDatabase(f.dbPath, reader => withReadonlyLifecycleIntentObservation(reader, binding, async observation => {
      expect(observation.verified.eventUid).toBe(plan!.record.eventUid)
    }, { directory: f.directory }))
  })
  it.each(['issued-not-started', 'issued-pending-prefix', 'issued-log-complete', 'issued-anchor-published'] as const)('repairs only %s once and closes the guard before the full observer', async state => {
    const f = await issuedFixture(), bytes = issuedBytes(f.plan), prior = await readFile(f.log)
    if (state !== 'issued-not-started') await writeFile(f.pending, bytes.pending, { mode: 0o600 })
    if (state === 'issued-pending-prefix') await writeFile(f.log, Buffer.concat([prior, bytes.line.subarray(0, 17)]))
    if (state === 'issued-log-complete' || state === 'issued-anchor-published') await writeFile(f.log, Buffer.concat([prior, bytes.line]))
    if (state === 'issued-log-complete') await writeFile(f.anchor + '.candidate', bytes.next.subarray(0, 25), { mode: 0o600 })
    if (state === 'issued-anchor-published') await writeFile(f.anchor, bytes.next)
    const before = await disk(f.directory)
    await prefix(f, async proof => {
      expect(getReadonlyIssuedLifecycleAppendPrefixInfo(proof).state).toBe(state)
      expect(assertReadonlyIssuedLifecycleAppendRetainedIntent(proof, f.binding).seq).toBe(1)
      await withReadonlyOperationDatabase(f.dbPath, reader => withReadonlyIssuedLifecycleAppendDatabaseObservation(reader, proof, async observed => {
        await observed.assertCurrent(); expect(() => assertOperationIntentReceipt(observed, f.issuedBinding, reader)).toThrow()
      }))
    })
    expect(await disk(f.directory)).toEqual(before)
    const cap = Object.freeze({}); issuedRepairFixture.plans.set(cap, f.plan)
    const result = await f.authority.repairIssuedLifecycleIntent(cap)
    expect(result.entryHash).toBe(f.plan.record.entryHash)
    await f.handle.db.transaction(async tx => expect(() => assertOperationIntentReceipt(result, f.issuedBinding, tx)).toThrow())
    await withReadonlyOperationDatabase(f.dbPath, reader => withReadonlyLifecycleIntentObservation(reader, f.issuedBinding, async proof => {
      expect(proof.verified).toEqual(result)
    }, { directory: f.directory }))
    await expect(f.authority.repairIssuedLifecycleIntent(cap)).rejects.toThrow()
    expect(await f.handle.db.query('SELECT COUNT(*) AS n FROM audit_log WHERE target=$1', ['operation:' + f.issuedBinding.jobId])).toEqual([{ n: 1 }])
  })
  it.each(['partial-pending', 'foreign-pending', 'extra-log', 'candidate-without-pending', 'unknown-owner', 'missing-prior-index'] as const)('preserves refused %s before any repair mutation', async kind => {
    const f = await issuedFixture(), bytes = issuedBytes(f.plan), prior = await readFile(f.log)
    if (kind === 'partial-pending') await writeFile(f.pending, bytes.pending.subarray(0, 25), { mode: 0o600 })
    if (kind === 'foreign-pending') await writeFile(f.pending, bytes.pending.toString().replace(f.plan.record.eventUid, randomUUID()), { mode: 0o600 })
    if (kind === 'extra-log') await writeFile(f.log, Buffer.concat([prior, bytes.line, bytes.line]))
    if (kind === 'candidate-without-pending') await writeFile(f.anchor + '.candidate', bytes.next, { mode: 0o600 })
    if (kind === 'unknown-owner') { const path = join(f.directory, '.lock'); await mkdir(path); await chmod(path, 0o2770); await writeFile(join(path, 'owner.json'), '{}', { mode: 0o640 }) }
    if (kind === 'missing-prior-index') await f.handle.db.query('DELETE FROM audit_log WHERE target=$1', ['operation:' + f.binding.jobId])
    const before = await disk(f.directory), rows = await f.handle.db.query('SELECT * FROM audit_log')
    const cap = {}; issuedRepairFixture.plans.set(cap, f.plan)
    await expect(f.authority.repairIssuedLifecycleIntent(cap)).rejects.toThrow()
    // Taking the real mutex can alter its own SQLite bookkeeping; it must not
    // change any business/audit inode, bytes, owner or authority.
    const withoutMutex = (items: unknown) => (items as { name: string }[]).filter(item => !item.name.startsWith('.writer-mutex.sqlite'))
    expect(withoutMutex(await disk(f.directory))).toEqual(withoutMutex(before))
    expect(await f.handle.db.query('SELECT * FROM audit_log')).toEqual(rows)
  })
  it('refuses synthetic repair authority and expires prefix proofs without a receipt', async () => {
    const f = await issuedFixture(), before = await disk(f.directory)
    await expect(f.authority.repairIssuedLifecycleIntent({ plan: f.plan })).rejects.toThrow()
    const escaped = await prefix(f, async proof => proof)
    await expect(escaped.assertCurrent()).rejects.toThrow()
    expect(() => getReadonlyIssuedLifecycleAppendPrefixInfo({ ...escaped })).toThrow()
    expect(await disk(f.directory)).toEqual(before)
  })
  it.each([true, false])('retires only the exact issued owner in the known finish window, pending retained=%s', async pendingRetained => {
    const f = await issuedFixture(), bytes = issuedBytes(f.plan), prior = await readFile(f.log)
    await writeFile(f.log, Buffer.concat([prior, bytes.line])); await writeFile(f.anchor, bytes.next)
    if (pendingRetained) await writeFile(f.pending, bytes.pending, { mode: 0o600 })
    else {
      const record = f.plan.record
      await f.handle.db.query('INSERT INTO audit_log (at,actor,principal_id,ip,action,target,detail,outcome) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [record.at, record.actor, record.principalId, record.ip, record.action, record.target,
          JSON.stringify({ ...record.detail, _auditEventUid: record.eventUid, _auditSeq: record.seq, _auditPrevHash: record.prevHash, _auditEntryHash: record.entryHash }), record.outcome])
    }
    const owner = join(f.directory, '.lock'); await mkdir(owner); await chmod(owner, 0o2770)
    await writeFile(join(owner, 'owner.json'), f.plan.writer.ownerRaw, { mode: 0o640 })
    const cap = {}; issuedRepairFixture.plans.set(cap, f.plan)
    await f.authority.repairIssuedLifecycleIntent(cap)
    expect((await readdir(f.directory)).includes('.lock')).toBe(false)
    expect(await readFile(join(f.directory, 'authority.json'), 'utf8')).toBe(f.plan.writer.authorityRaw)
    await withReadonlyOperationDatabase(f.dbPath, reader => withReadonlyLifecycleIntentObservation(reader, f.issuedBinding, async proof => {
      expect(proof.verified.entryHash).toBe(f.plan.record.entryHash)
    }, { directory: f.directory }))
  })
  it('does not allocate an epoch or call the issuance hook when retained evidence is unknown', async () => {
    const f = await issuedFixture(); await writeFile(f.pending, '{unrecognized', { mode: 0o600 })
    const before = await readFile(join(f.directory, 'authority.json')), pending = await readFile(f.pending)
    let called = false
    await expect(f.authority.appendIssuedLifecycleIntent(f.issuedBinding, async () => { called = true })).rejects.toThrow()
    expect(called).toBe(false)
    expect(await readFile(join(f.directory, 'authority.json'))).toEqual(before)
    expect(await readFile(f.pending)).toEqual(pending)
  })
  it('blocks generic orphan cleanup before pending/HEAD, then permits ordinary adopt/reconcile after native retirement', async () => {
    const f = await issuedFixture(), owner = join(f.directory, '.lock')
    await mkdir(owner); await chmod(owner, 0o2770); await writeFile(join(owner, 'owner.json'), f.plan.writer.ownerRaw, { mode: 0o640 })
    const before = await readFile(join(f.directory, 'authority.json')), ownerBefore = await readFile(join(owner, 'owner.json'))
    issuedRepairFixture.unretired = true
    for (const run of [() => f.authority.recoverLifecycleIntent(f.binding), () => f.authority.appendReconcileIntent({ ...f.binding, purpose: 'host.reconcile.intent', action: 'host.reconcile', jobId: randomUUID() })]) {
      await expect(run()).rejects.toThrow('unretired issued native journal')
      expect(await readFile(join(owner, 'owner.json'))).toEqual(ownerBefore)
      expect(await readFile(join(f.directory, 'authority.json'))).toEqual(before)
    }
    // This toggle represents the separate native producer's verified retirement,
    // not a production input. The legacy binary fence is tested in integration.
    issuedRepairFixture.unretired = false
    const adopt = { ...f.binding, action: 'lifecycle.adopt', jobId: randomUUID() }
    await createJob(f.handle.db, { id: adopt.jobId, kind: adopt.action, actor: 'readonlyauditor', detail: { lifecycleIntent: adopt } })
    const adopted = await f.authority.appendLifecycleIntent(adopt)
    await f.handle.db.transaction(async tx => expect(assertOperationIntentReceipt(adopted, adopt, tx).seq).toBe(2))
    const reconcile = { ...f.binding, purpose: 'host.reconcile.intent' as const, action: 'host.reconcile', jobId: randomUUID() }
    const reconciled = await f.authority.appendReconcileIntent(reconcile)
    await f.handle.db.transaction(async tx => expect(assertOperationIntentReceipt(reconciled, reconcile, tx).seq).toBe(3))
  })
  it('refuses a changed plan hash, a log inode substitution and anchor ABA', async () => {
    const f = await issuedFixture()
    expect(() => normalizeIssuedLifecycleAppendPlan({ ...f.plan, recordLineSha256: '0'.repeat(64) })).toThrow()
    await expect(prefix(f, async proof => { await rename(f.anchor, f.anchor + '.held'); await rename(f.anchor + '.held', f.anchor); await proof.assertCurrent() })).rejects.toThrow()
    await rename(f.log, f.log + '.held'); await writeFile(f.log, await readFile(f.log + '.held'), { mode: 0o600 })
    await expect(prefix(f, async () => undefined)).rejects.toThrow()
  })
  it('rejects a copied DB in the prefix DB proof despite identical issuer and jobs', async () => {
    const f = await issuedFixture(), copy = join(f.root, 'copy.sqlite')
    await f.handle.db.query('PRAGMA wal_checkpoint(TRUNCATE)'); await copyFile(f.dbPath, copy); await chmod(copy, 0o600)
    const handle = createDb(copy, { durability: 'strict' }); handles.push(handle); await handle.db.query('SELECT COUNT(*) AS n FROM jobs')
    for (const path of [copy, copy + '-wal', copy + '-shm']) await chmod(path, 0o600)
    await expect(prefix(f, proof => withReadonlyOperationDatabase(copy, reader => withReadonlyIssuedLifecycleAppendDatabaseObservation(reader, proof, async () => undefined)))).rejects.toThrow()
  })
  it('rechecks the issued gate under a newly appearing mutex before any orphan cleanup', async () => {
    const f = await fixture(), directory = join(f.root, 'new-audit-sink'); await mkdir(directory, { mode: 0o700 })
    const authority = await createRootOperationAuditAuthority(f.handle.db, { directory })
    expect(await readdir(directory)).toEqual([])
    let ownerBefore = Buffer.alloc(0), intentBefore = Buffer.alloc(0), authorityBefore = Buffer.alloc(0)
    // Interleave after the allowed early gate while the sink had no mutex.
    // A separate producer leaves an exact owner before this caller acquires it.
    // This is a gate algorithm seam, not native journal/old-binary acceptance.
    issuedRepairFixture.afterGate = async () => {
      const lease = await new WriterLock(directory).acquire()
      await lease.recordIntent({ op: 'fixtureIssuedOwner', createdRelPaths: [], backups: [] })
      await lease.release() // retains its uncommitted marker but releases the OS mutex
      ownerBefore = await readFile(join(directory, '.lock', 'owner.json'))
      intentBefore = await readFile(join(directory, '.lock', 'intent.json'))
      authorityBefore = await readFile(join(directory, 'authority.json'))
      issuedRepairFixture.unretired = true
    }
    await expect(authority.appendReconcileIntent({ ...f.binding, purpose: 'host.reconcile.intent', action: 'host.reconcile', jobId: randomUUID() }))
      .rejects.toThrow('unretired issued native journal')
    expect(await readFile(join(directory, '.lock', 'owner.json'))).toEqual(ownerBefore)
    expect(await readFile(join(directory, '.lock', 'intent.json'))).toEqual(intentBefore)
    expect(await readFile(join(directory, 'authority.json'))).toEqual(authorityBefore)
    expect((await readdir(directory)).includes(OPERATION_AUDIT_LOG_NAME)).toBe(false)
  })
  it('classifies exact candidate/log ordering and never accepts an anchor before its log', async () => {
    const f = await issuedFixture(), bytes = issuedBytes(f.plan), log = await readFile(f.log), anchor = await readFile(f.anchor)
    expect(classifyIssuedLifecycleAppend(f.plan, { log, anchor, pending: null, candidate: null })).toBe('issued-not-started')
    expect(() => classifyIssuedLifecycleAppend(f.plan, { log, anchor: bytes.next, pending: bytes.pending, candidate: null })).toThrow()
    expect(() => classifyIssuedLifecycleAppend(f.plan, { log, anchor, pending: bytes.pending, candidate: bytes.next })).toThrow()
  })
  it('requires an existing native mutex and rejects copied or retired unrecovered mutex proofs', async () => {
    const f = await issuedFixture(), lock = new WriterLock(f.directory)
    const missing = join(f.root, 'missing-mutex.sqlite'), before = (await readdir(f.root)).sort()
    await expect(acquireExistingWriterMutex(missing, 10, 1)).rejects.toThrow()
    expect((await readdir(f.root)).sort()).toEqual(before)
    const escaped = await lock.withExistingUnrecoveredMutex(async proof => {
      await expect(lock.acquireCleanFromExistingMutex({ ...proof })).rejects.toThrow()
      await expect(new WriterLock(f.directory).acquireCleanFromExistingMutex(proof)).rejects.toThrow()
      await proof.assertCurrent(); return proof
    })
    await expect(escaped.assertCurrent()).rejects.toThrow()
    await expect(lock.acquireRecoveringFromExistingMutex(escaped)).rejects.toThrow()
  })
})

describe('actual native nonmutating lifecycle audit observation', () => {
  it('finishes lifecycle append and observes the exact root event without repair, index or business writes', async () => {
    const f = await fixture(), before = await disk(f.directory), expected = await verified(f, f.receipt)
    expect((await readdir(f.directory)).includes(OPERATION_AUDIT_PENDING_NAME)).toBe(false)
    expect(await f.handle.db.query('SELECT COUNT(*) AS n FROM audit_log WHERE action=$1', ['host.lifecycle.intent'])).toEqual([{ n: 1 }])
    let escaped: ReadonlyLifecycleIntentObservation | undefined
    const receipt = await observe(f, async observation => {
      escaped = observation
      expect(observation.verified).toEqual(expected)
      await observation.assertCurrent()
      await assertReadonlyLifecycleIntentObservationCurrent(observation)
      return observation.receipt
    })
    expect(await verified(f, receipt)).toEqual(expected)
    expect(await disk(f.directory)).toEqual(before)
    await expect(escaped!.assertCurrent()).rejects.toThrow()
    await expect(assertReadonlyLifecycleIntentObservationCurrent(escaped)).rejects.toThrow()
    for (const copied of [{ ...receipt }, new Proxy(receipt, {}), JSON.parse(JSON.stringify(receipt))]) await expect(verified(f, copied)).rejects.toThrow()
    await withReadonlyOperationDatabase(f.dbPath, async reader => {
      // Copying every property, including the nominal brand, never copies the
      // producer's registered identity or its retained observation scope.
      const copiedReader = Object.freeze(Object.defineProperties({}, Object.getOwnPropertyDescriptors(reader)))
      expect(Reflect.ownKeys(copiedReader)).toEqual(Reflect.ownKeys(reader))
      expect(() => getReadonlyOperationDatabaseOrigin(copiedReader)).toThrow()
      await expect(assertReadonlyOperationDatabaseCurrent(copiedReader)).rejects.toThrow()
      expect(await reader.query('SELECT total_changes() AS n')).toEqual([{ n: 0 }])
      await expect(reader.exec('DELETE FROM audit_log')).rejects.toThrow()
      await expect(reader.query('DELETE FROM audit_log RETURNING *')).rejects.toThrow()
      await reader.transaction(async tx => {
        expect(() => getStrictOperationDatabaseOrigin(tx)).toThrow()
        expect(getReadonlyOperationDatabaseOrigin(tx).file).toBe(f.dbPath)
      })
      expect(await reader.query('SELECT total_changes() AS n')).toEqual([{ n: 0 }])
    })
    expect(await disk(f.directory)).toEqual(before)
  })
  it.each(['pending', 'candidate', 'guard'] as const)('preserves an ambiguous %s without touching files or index', async kind => {
    const f = await fixture(), path = kind === 'pending' ? f.pending : kind === 'candidate' ? f.anchor + '.candidate' : join(f.directory, '.lock')
    if (kind === 'guard') { await mkdir(path, { mode: 0o700 }); await writeFile(join(path, 'owner.json'), '{orphan evidence', { mode: 0o600 }) }
    else await writeFile(path, '{partial untrusted evidence', { mode: 0o600 })
    const before = await disk(f.directory), count = await f.handle.db.query('SELECT COUNT(*) AS n FROM audit_log')
    await expect(observe(f, async observation => observation.receipt)).rejects.toThrow()
    expect(await disk(f.directory)).toEqual(before)
    if (kind === 'guard') expect(await readFile(join(path, 'owner.json'), 'utf8')).toBe('{orphan evidence')
    expect(await f.handle.db.query('SELECT COUNT(*) AS n FROM audit_log')).toEqual(count)
  })
  it.each(['anchor', 'log'] as const)('refuses identical %s bytes on a replacement inode and revokes the in-flight receipt', async field => {
    const f = await fixture(), path = f[field], bytes = await readFile(path)
    let leaked: OperationIntentReceipt | undefined
    await expect(observe(f, async observation => {
      leaked = observation.receipt
      await rename(path, path + '.retained'); await writeFile(path, bytes, { mode: 0o600 })
      await observation.assertCurrent()
    })).rejects.toThrow()
    expect(await readFile(path)).toEqual(bytes)
    await expect(verified(f, leaked)).rejects.toThrow()
  })
  it('refuses anchor rename-away-and-back ABA even when the named inode and bytes return', async () => {
    const f = await fixture(), info = await lstat(f.anchor, { bigint: true })
    await expect(observe(f, async observation => {
      await rename(f.anchor, f.anchor + '.held'); await rename(f.anchor + '.held', f.anchor)
      expect((await lstat(f.anchor, { bigint: true })).ino).toBe(info.ino)
      await observation.assertCurrent()
    })).rejects.toThrow()
  })
  it('never authorizes an observation receipt before final validation or after callback failure', async () => {
    const f = await fixture()
    let leaked: OperationIntentReceipt | undefined
    await expect(observe(f, async observation => {
      leaked = observation.receipt
      await expect(verified(f, observation.receipt)).rejects.toThrow()
      throw new Error('controlled callback refusal')
    })).rejects.toThrow('controlled callback refusal')
    await expect(verified(f, leaked)).rejects.toThrow()
  })
  it('refuses a copied database despite an identical issuer and audit rows', async () => {
    const f = await fixture(), copy = join(f.root, 'copied.sqlite')
    // Checkpoint only fixture setup, before the observer; the observation performs no checkpoint.
    await f.handle.db.query('PRAGMA wal_checkpoint(TRUNCATE)')
    await copyFile(f.dbPath, copy); await chmod(copy, 0o600)
    const copied = createDb(copy, { durability: 'strict' }); handles.push(copied)
    await copied.db.query('SELECT COUNT(*) AS n FROM jobs')
    for (const path of [copy, copy + '-wal', copy + '-shm']) await chmod(path, 0o600)
    await expect(withReadonlyOperationDatabase(copy, reader => withReadonlyLifecycleIntentObservation(reader, f.binding, async value => value.receipt, { directory: f.directory }))).rejects.toThrow()
  })
  it('refuses database inode replacement and WAL commits while retaining the captured reader', async () => {
    const f = await fixture()
    await expect(withReadonlyOperationDatabase(f.dbPath, async reader => {
      await f.handle.db.query('UPDATE jobs SET summary=$1 WHERE id=$2', ['changed while observed', f.binding.jobId])
      await assertReadonlyOperationDatabaseCurrent(reader)
    })).rejects.toThrow()
    await expect(withReadonlyOperationDatabase(f.dbPath, async reader => {
      await rename(f.dbPath, f.dbPath + '.held'); await copyFile(f.dbPath + '.held', f.dbPath)
      await assertReadonlyOperationDatabaseCurrent(reader)
    })).rejects.toThrow()
  })
  it('refuses database rename-away-and-back ABA while the held inode stays alive', async () => {
    const f = await fixture(), initial = await lstat(f.dbPath, { bigint: true })
    await expect(withReadonlyOperationDatabase(f.dbPath, async reader => {
      await rename(f.dbPath, f.dbPath + '.held'); await rename(f.dbPath + '.held', f.dbPath)
      expect((await lstat(f.dbPath, { bigint: true })).ino).toBe(initial.ino)
      await assertReadonlyOperationDatabaseCurrent(reader)
    })).rejects.toThrow()
  })
  it('refuses a cleanly closed WAL database without creating missing sidecars', async () => {
    const f = await fixture()
    handles.splice(handles.indexOf(f.handle), 1); await f.handle.close()
    expect((await readdir(f.root)).filter(name => name.endsWith('-wal') || name.endsWith('-shm'))).toEqual([])
    const before = await disk(f.root)
    let called = false
    await expect(withReadonlyOperationDatabase(f.dbPath, async () => { called = true })).rejects.toThrow()
    expect(called).toBe(false)
    expect(await disk(f.root)).toEqual(before)
  })
  it('refuses a substituted sidecar without following it or modifying its target', async () => {
    const f = await fixture(), path = f.dbPath + '-wal', bytes = await readFile(path)
    await rename(path, path + '.held'); await symlink(path + '.held', path)
    await expect(withReadonlyOperationDatabase(f.dbPath, async () => undefined)).rejects.toThrow()
    expect(await readFile(path + '.held')).toEqual(bytes)
    await rm(path); await rename(path + '.held', path)
  })
  it('observes retained root files while SQLite is closed without granting a DB receipt', async () => {
    const f = await fixture(), origin = await f.handle.db.transaction(async tx => ({ ...getStrictOperationDatabaseOrigin(tx) }))
    handles.splice(handles.indexOf(f.handle), 1); await f.handle.close()
    const before = await disk(f.root), auditBefore = await disk(f.directory)
    const proof = await withReadonlyLifecycleIntentFileObservation(f.binding, origin, async value => {
      const info = getReadonlyLifecycleIntentFileObservationInfo(value)
      expect(info.binding).toEqual(f.binding); expect(info.origin).toEqual(origin); expect(info.verified.seq).toBe(1)
      expect(() => assertOperationIntentReceipt(value, f.binding, {} as never)).toThrow()
      await assertReadonlyLifecycleIntentFileObservationCurrent(value)
      return value
    }, { directory: f.directory })
    await expect(proof.assertCurrent()).rejects.toThrow()
    expect(() => getReadonlyLifecycleIntentFileObservationInfo({ ...proof })).toThrow()
    expect(await disk(f.root)).toEqual(before); expect(await disk(f.directory)).toEqual(auditBefore)
  })
  it('keeps a retained file proof live through a child DB/file scope but never after retirement', async () => {
    const f = await fixture(), origin = await f.handle.db.transaction(async tx => ({ ...getStrictOperationDatabaseOrigin(tx) }))
    await withReadonlyLifecycleIntentFileObservation(f.binding, origin, async parent => {
      await observe(f, async child => { await parent.assertCurrent(); await child.assertCurrent() })
      await parent.assertCurrent()
    }, { directory: f.directory })
  })
  it('checks the actual Node immutable read primitive without claiming a native fence', async () => {
    const f = await fixture()
    handles.splice(handles.indexOf(f.handle), 1); await f.handle.close()
    const before = await disk(f.root)
    // Runtime primitive only: production access additionally requires the branded
    // native EX/stopped capability and is never established by this fixture.
    const db = new DatabaseSync(pathToFileURL(f.dbPath).href + '?mode=ro&immutable=1', { readOnly: true, allowExtension: false })
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()?.n).toBe(1)
      expect(() => db.exec('DELETE FROM audit_log')).toThrow()
      expect(db.prepare('SELECT total_changes() AS n').get()?.n).toBe(0)
    } finally { db.close() }
    expect(await disk(f.root)).toEqual(before)
    expect((await readdir(f.root)).filter(name => /-(?:wal|shm|journal)$/.test(name))).toEqual([])
  })
  it('refuses changed job binding or incomplete lifecycle audit index without reindexing', async () => {
    const f = await fixture(), before = await disk(f.directory)
    await f.handle.db.query('UPDATE jobs SET detail=$1 WHERE id=$2', ['{}', f.binding.jobId])
    await expect(observe(f, async value => value.receipt)).rejects.toThrow()
    await f.handle.db.query('UPDATE jobs SET detail=$1 WHERE id=$2', [JSON.stringify({ lifecycleIntent: f.binding }), f.binding.jobId])
    await f.handle.db.query('DELETE FROM audit_log WHERE action=$1', ['host.lifecycle.intent'])
    await expect(observe(f, async value => value.receipt)).rejects.toThrow()
    expect(await f.handle.db.query('SELECT COUNT(*) AS n FROM audit_log')).toEqual([{ n: 0 }])
    expect(await disk(f.directory)).toEqual(before)
  })
})
