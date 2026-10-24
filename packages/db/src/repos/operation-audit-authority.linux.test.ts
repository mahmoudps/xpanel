import { createStrictTestDb } from '../strict-test-db.ts'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, chown, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type DbHandle } from '../client.ts'
import { migrate } from '../migrate.ts'
import { initializeOperationalMetadata } from './official-references.ts'
import { ARGON2 } from '../testing.ts'
import { createRootPrincipal } from './principals.ts'
import { createJob } from './jobs.ts'
import { computeAuditEntryHash } from './audit.ts'
import type { AuditFileRecord } from './audit.ts'
import { assertOperationIntentReceipt, createRootOperationAuditAuthority, MAX_OPERATION_AUDIT_RECORDS, OPERATION_AUDIT_ANCHOR_NAME, OPERATION_AUDIT_LOG_NAME, OPERATION_AUDIT_PENDING_NAME } from './operation-audit-authority.ts'
import type { OperationIntentBinding } from './operation-audit-authority.ts'

// New root-private file/SQLite fixtures only: no users, services or installed state.
const directories: string[] = []
const handles: DbHandle[] = []
const children = new Set<ReturnType<typeof spawn>>()
beforeAll(() => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) {
    throw new Error('BLOCKED: actual native Linux root is required; no test-authorized receipt is available')
  }
})
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    await exited
  }
  children.clear()
  for (const handle of handles.splice(0)) await handle.close()
  for (const directory of directories.splice(0)) {
    if (!directory.startsWith('/root/xpanel-operation-audit-')) throw new Error('Unsafe native fixture cleanup path')
    await rm(directory, { recursive: true, force: true })
  }
})
const fixture = async () => {
  const root = await mkdtemp('/root/xpanel-operation-audit-')
  directories.push(root)
  await chmod(root, 0o700)
  const directory = join(root, 'sink')
  await mkdir(directory, { mode: 0o700 })
  const dbPath = join(root, 'control.sqlite')
  const handle = createDb(dbPath, { durability: 'strict' })
  handles.push(handle)
  await migrate(handle.db)
  await initializeOperationalMetadata(handle.db)
  const principal = await createRootPrincipal(handle.db, { username: 'auditor', passwordHash: ARGON2, forcePasswordChange: false })
  const authority = await createRootOperationAuditAuthority(handle.db, { directory })
  const binding: OperationIntentBinding = { purpose: 'host.reconcile.intent', jobId: randomUUID(), requestFingerprint: 'a'.repeat(64), action: 'account.update', principalId: principal.id }
  return { root, directory, dbPath, handle, principal, authority, binding, log: join(directory, OPERATION_AUDIT_LOG_NAME), pending: join(directory, OPERATION_AUDIT_PENDING_NAME), anchor: join(directory, OPERATION_AUDIT_ANCHOR_NAME) }
}
const verified = (f: Awaited<ReturnType<typeof fixture>>, receipt: unknown, binding: OperationIntentBinding) =>
  f.handle.db.transaction(async tx => assertOperationIntentReceipt(receipt, binding, tx))
const records = async (path: string): Promise<AuditFileRecord[]> =>
  (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as AuditFileRecord)
const indexed = async (handle: DbHandle): Promise<number> => Number((await handle.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM audit_log'))[0]!.count)
const launch = (script: string, args: string[], gid?: number) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env }, ...(gid === undefined ? {} : { gid }) })
  children.add(child)
  let stdout = '', stderr = ''
  child.stdout!.on('data', chunk => { stdout += String(chunk) })
  child.stderr!.on('data', chunk => { stderr += String(chunk) })
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }) })
  })
  return { child, done, output: () => stdout }
}
const childProgram = "\nimport fs from 'node:fs/promises'\nimport { syncBuiltinESMExports } from 'node:module'\nconst [moduleUrl,clientUrl,directory,dbPath,bindingJson,mode]=process.argv.slice(1)\nconst binding=JSON.parse(bindingJson),log=directory+'/operation-intents.jsonl'\nconst originalOpen=fs.open.bind(fs)\nlet signalled=false\nconst hold=async()=>{process.stdout.write('AUDIT_BOUNDARY_READY\\n');await new Promise(()=>{})}\nif(mode!=='normal'){\n fs.open=async(...args)=>{\n  const handle=await originalOpen(...args)\n  if(String(args[0])===(mode.startsWith('anchor-')?directory+'/operation-audit-authority.json.candidate':log)){\n   const originalWrite=handle.writeFile.bind(handle),originalSync=handle.sync.bind(handle)\n   handle.writeFile=async(data,...rest)=>{\n    if((mode==='partial'||mode==='anchor-partial')&&!signalled&&Buffer.isBuffer(data)&&data.length>1){signalled=true;await originalWrite(data.subarray(0,Math.floor(data.length/2)));await hold();return}\n    return originalWrite(data,...rest)\n   }\n   handle.sync=async()=>{\n    await originalSync()\n    if(!signalled&&(await handle.stat()).size>0&&(mode==='complete'||mode==='eio'||mode==='anchor-complete')){\n     signalled=true\n     if(mode==='eio')throw Object.assign(new Error('controlled post-sync uncertainty'),{code:'EIO'})\n     await hold()\n    }\n   }\n  }\n  return handle\n }\n syncBuiltinESMExports()\n}\nconst{createDb}=await import(clientUrl)\nconst{createRootOperationAuditAuthority,assertOperationIntentReceipt}=await import(moduleUrl)\nconst handle=createDb(dbPath,{durability:'strict'})\ntry{\n const authority=await createRootOperationAuditAuthority(handle.db,{directory})\n if(mode==='contender')process.stdout.write('AUDIT_ATTEMPT_STARTED\\n')\n const receipt=await authority.appendReconcileIntent(binding)\n process.stdout.write(JSON.stringify({receipt:await handle.db.transaction(async tx=>assertOperationIntentReceipt(receipt,binding,tx))})+'\\n')\n}catch(error){process.stdout.write(JSON.stringify({rejected:true,code:error.code??null})+'\\n');process.exitCode=2}\nfinally{await handle.close()}\n"
const childArgs = (f: Awaited<ReturnType<typeof fixture>>, binding: OperationIntentBinding, mode = 'normal') => [
  pathToFileURL(join(import.meta.dirname, 'operation-audit-authority.ts')).href,
  pathToFileURL(join(import.meta.dirname, '../client.ts')).href,
  f.directory, f.dbPath, JSON.stringify(binding), mode,
]
const killAtBoundary = async (f: Awaited<ReturnType<typeof fixture>>, mode: 'partial' | 'complete' | 'anchor-partial' | 'anchor-complete') => {
  const worker = launch(childProgram, childArgs(f, f.binding, mode))
  const deadline = Date.now() + 10_000
  while (!worker.output().includes('AUDIT_BOUNDARY_READY')) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) throw new Error('Child exited before the actual audit boundary')
    if (Date.now() >= deadline) throw new Error('Actual audit boundary timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  worker.child.kill('SIGKILL')
  expect((await worker.done).signal).toBe('SIGKILL')
}
describe('actual native root operation audit authority', () => {
  it('issues and recovers a distinct lifecycle intent only for its persisted root job and rejects cross-purpose receipts', async () => {
    const f = await fixture()
    const binding: OperationIntentBinding = { ...f.binding, purpose: 'host.lifecycle.intent', action: 'lifecycle.upgrade' }
    await expect(f.authority.appendLifecycleIntent(binding)).rejects.toThrow()
    await createJob(f.handle.db, { id: binding.jobId, kind: binding.action, actor: f.principal.username, detail: { lifecycleIntent: binding } })
    const receipt = await f.authority.appendLifecycleIntent(binding)
    const first = await verified(f, receipt, binding)
    const reopened = await createRootOperationAuditAuthority(f.handle.db, { directory: f.directory })
    expect(await verified(f, await reopened.recoverLifecycleIntent(binding), binding)).toEqual(first)
    expect(await records(f.log)).toHaveLength(1)
    await expect(verified(f, receipt, f.binding)).rejects.toThrow()
    await expect(f.authority.appendReconcileIntent(binding)).rejects.toThrow()
    await expect(f.authority.appendLifecycleIntent(f.binding)).rejects.toThrow()
    await expect(f.authority.appendLifecycleIntent({ ...binding, requestFingerprint: 'b'.repeat(64) })).rejects.toThrow()
    expect(await records(f.log)).toHaveLength(1)
  })
  it('syncs a real chain/index and remints the same event after reopening without accepting copies', async () => {
    const f = await fixture(), receipt = await f.authority.appendReconcileIntent(f.binding)
    const first = await verified(f, receipt, f.binding)
    expect(first.seq).toBe(1)
    expect(await indexed(f.handle)).toBe(1)
    expect((await records(f.log))[0]!.entryHash).toBe(first.entryHash)
    expect((await readdir(f.directory)).includes(OPERATION_AUDIT_PENDING_NAME)).toBe(false)
    for (const copied of [{ ...receipt }, JSON.parse(JSON.stringify(receipt)), new Proxy(receipt, {})]) await expect(verified(f, copied, f.binding)).rejects.toThrow()
    const reopened = await createRootOperationAuditAuthority(f.handle.db, { directory: f.directory })
    expect(await verified(f, await reopened.recoverReconcileIntent(f.binding), f.binding)).toEqual(first)
    expect(await verified(f, await reopened.appendReconcileIntent(f.binding), f.binding)).toEqual(first)
    expect(await records(f.log)).toHaveLength(1)
    expect(await indexed(f.handle)).toBe(1)
  })
  it('checks every field and purpose of a real receipt and rejects changed request replay', async () => {
    const f = await fixture(), receipt = await f.authority.appendReconcileIntent(f.binding)
    for (const changed of [
      { jobId: randomUUID() }, { requestFingerprint: 'b'.repeat(64) }, { action: 'account.suspend' },
      { principalId: randomUUID() }, { purpose: 'reference.repair.intent' as const, action: 'job.reference.repair' },
    ]) await expect(verified(f, receipt, { ...f.binding, ...changed })).rejects.toThrow()
    await expect(f.authority.appendReconcileIntent({ ...f.binding, requestFingerprint: 'b'.repeat(64) })).rejects.toThrow()
    expect(await records(f.log)).toHaveLength(1)
  })
  it('keeps the two allowed purposes distinct and reference repair replay idempotent', async () => {
    const f = await fixture(), reconcile = await f.authority.appendReconcileIntent(f.binding)
    const repair: OperationIntentBinding = { ...f.binding, purpose: 'reference.repair.intent', action: 'job.reference.repair', requestFingerprint: 'c'.repeat(64) }
    const repaired = await f.authority.appendReferenceRepairIntent(repair)
    expect((await verified(f, repaired, repair)).seq).toBe(2)
    await expect(verified(f, reconcile, repair)).rejects.toThrow()
    await expect(verified(f, repaired, f.binding)).rejects.toThrow()
    expect(await verified(f, await f.authority.recoverReferenceRepairIntent(repair), repair)).toEqual(await verified(f, repaired, repair))
    await expect(f.authority.appendReconcileIntent(repair)).rejects.toThrow()
    await expect(f.authority.appendReferenceRepairIntent(f.binding)).rejects.toThrow()
    expect(await records(f.log)).toHaveLength(2)
  })
  it('preserves a durable event on real SQLite insert failure and replays exactly once', async () => {
    const f = await fixture()
    await f.handle.db.exec("CREATE TRIGGER test_audit_outage BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'controlled_index_failure'); END")
    await expect(f.authority.appendReconcileIntent(f.binding)).rejects.toThrow()
    const first = (await records(f.log))[0]!
    expect(await indexed(f.handle)).toBe(0)
    expect((await readdir(f.directory)).includes(OPERATION_AUDIT_PENDING_NAME)).toBe(true)
    await f.handle.db.exec('DROP TRIGGER test_audit_outage')
    const recovered = await verified(f, await f.authority.recoverReconcileIntent(f.binding), f.binding)
    expect(recovered.eventUid).toBe(first.eventUid)
    expect(recovered.entryHash).toBe(first.entryHash)
    expect(await indexed(f.handle)).toBe(1)
    expect(await records(f.log)).toHaveLength(1)
  })
  it.each(['partial', 'complete'] as const)('recovers the same event after SIGKILL at an actual %s append boundary', async mode => {
    const f = await fixture()
    await killAtBoundary(f, mode)
    const pending = JSON.parse(await readFile(f.pending, 'utf8')) as { record: AuditFileRecord }
    expect(await indexed(f.handle)).toBe(0)
    const receipt = await f.authority.recoverReconcileIntent(f.binding)
    expect((await verified(f, receipt, f.binding)).eventUid).toBe(pending.record.eventUid)
    expect(await records(f.log)).toHaveLength(1)
    expect(await indexed(f.handle)).toBe(1)
  })
  it.each(['anchor-partial', 'anchor-complete'] as const)('recovers only the exact pending highwater after SIGKILL at %s publication', async mode => {
    const f = await fixture()
    await killAtBoundary(f, mode)
    const pending = JSON.parse(await readFile(f.pending, 'utf8')) as { record: AuditFileRecord; priorAnchor: unknown }
    const before = (await records(f.log))[0]!
    const candidate = f.anchor + '.candidate'
    expect((await readFile(candidate)).length).toBeGreaterThan(0)
    expect(await indexed(f.handle)).toBe(0)
    const receipt = await f.authority.recoverReconcileIntent(f.binding)
    expect((await verified(f, receipt, f.binding)).eventUid).toBe(pending.record.eventUid)
    expect((await records(f.log))[0]!.entryHash).toBe(before.entryHash)
    expect(await indexed(f.handle)).toBe(1)
    await expect(lstat(candidate)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(f.pending)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['conflicting', 'exact-but-log-rewound'] as const)('preserves partial log and candidate on %s highwater evidence', async mode => {
    const f = await fixture()
    await killAtBoundary(f, 'anchor-partial')
    const candidate = f.anchor + '.candidate'
    const completeLog = await readFile(f.log)
    await writeFile(f.log, completeLog.subarray(0, Math.floor(completeLog.length / 2)))
    if (mode === 'conflicting') await writeFile(candidate, Buffer.concat([await readFile(candidate), Buffer.from('CONFLICT')]))
    const beforeLog = await readFile(f.log), beforeCandidate = await readFile(candidate)
    const beforePending = await readFile(f.pending), beforeAnchor = await readFile(f.anchor)
    await expect(f.authority.recoverReconcileIntent(f.binding)).rejects.toThrow()
    expect((await readFile(f.log)).equals(beforeLog)).toBe(true)
    expect((await readFile(candidate)).equals(beforeCandidate)).toBe(true)
    expect((await readFile(f.pending)).equals(beforePending)).toBe(true)
    expect((await readFile(f.anchor)).equals(beforeAnchor)).toBe(true)
    expect(await indexed(f.handle)).toBe(0)
  })
  it('denies acknowledgment on controlled post-sync EIO and remints without a second event', async () => {
    const f = await fixture(), result = await launch(childProgram, childArgs(f, f.binding, 'eio')).done
    expect(result.code).toBe(2)
    expect(result.stdout).toContain('"rejected":true')
    const before = JSON.parse(await readFile(f.pending, 'utf8')) as { record: AuditFileRecord }
    expect((await verified(f, await f.authority.recoverReconcileIntent(f.binding), f.binding)).eventUid).toBe(before.record.eventUid)
    expect(await records(f.log)).toHaveLength(1)
  })
  it('serializes actual concurrent processes without duplicate sequence or events', async () => {
    const f = await fixture(), second = { ...f.binding, jobId: randomUUID(), requestFingerprint: 'd'.repeat(64) }
    const outcomes = await Promise.all([launch(childProgram, childArgs(f, f.binding)).done, launch(childProgram, childArgs(f, second)).done])
    for (const outcome of outcomes) expect(outcome.code, outcome.stderr).toBe(0)
    const log = await records(f.log)
    expect(log.map(record => record.seq)).toEqual([1, 2])
    expect(new Set(log.map(record => record.eventUid)).size).toBe(2)
    expect(log[1]!.prevHash).toBe(log[0]!.entryHash)
    expect(await indexed(f.handle)).toBe(2)
  })
  it('cannot take a paused live process guard and recovers only after real kernel release', async () => {
    const f = await fixture()
    const holder = launch(childProgram, childArgs(f, f.binding, 'complete'))
    const deadline = Date.now() + 10_000
    while (!holder.output().includes('AUDIT_BOUNDARY_READY')) {
      if (holder.child.exitCode !== null || Date.now() >= deadline) throw new Error('Holder did not reach actual durable boundary')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const prepared = JSON.parse(await readFile(f.pending, 'utf8')) as { record: AuditFileRecord }
    const heldBytes = await readFile(f.log), heldPending = await readFile(f.pending)
    const contender = launch(childProgram, childArgs(f, f.binding, 'contender'))
    const attemptedBy = Date.now() + 10_000
    while (!contender.output().includes('AUDIT_ATTEMPT_STARTED')) {
      if (contender.child.exitCode !== null || contender.child.signalCode !== null || Date.now() >= attemptedBy) throw new Error('Contender did not reach its actual method-call boundary')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(holder.child.exitCode).toBeNull()
    expect(holder.child.signalCode).toBeNull()
    expect(contender.child.exitCode).toBeNull()
    expect(contender.child.signalCode).toBeNull()
    expect(contender.output()).not.toContain('"receipt":')
    expect((await readFile(f.log)).equals(heldBytes)).toBe(true)
    expect((await readFile(f.pending)).equals(heldPending)).toBe(true)
    expect(await indexed(f.handle)).toBe(0)
    holder.child.kill('SIGKILL')
    expect((await holder.done).signal).toBe('SIGKILL')
    const completed = await contender.done
    expect(completed.code, completed.stderr).toBe(0)
    expect(JSON.parse(completed.stdout.trim().split('\n').at(-1)!).receipt.eventUid).toBe(prepared.record.eventUid)
    expect(await records(f.log)).toHaveLength(1)
    expect(await indexed(f.handle)).toBe(1)
  })

  it('rejects a replaced root-only directory before creating a new sink', async () => {
    const f = await fixture()
    await f.authority.appendReconcileIntent(f.binding)
    await rename(f.directory, join(f.root, 'previous-sink'))
    await mkdir(f.directory, { mode: 0o700 })
    await expect(f.authority.appendReconcileIntent(f.binding)).rejects.toThrow()
    expect(await readdir(f.directory)).toEqual([])
  })

  it('never truncates or replaces a log when prepared bytes conflict', async () => {
    const f = await fixture()
    await killAtBoundary(f, 'partial')
    const before = await readFile(f.log), pending = await readFile(f.pending)
    await writeFile(f.log, Buffer.concat([before, Buffer.from('CONFLICT')]))
    const corrupted = await readFile(f.log), inode = (await lstat(f.log, { bigint: true })).ino
    await expect(f.authority.recoverReconcileIntent(f.binding)).rejects.toThrow()
    expect((await readFile(f.log)).equals(corrupted)).toBe(true)
    expect((await readFile(f.pending)).equals(pending)).toBe(true)
    expect((await lstat(f.log, { bigint: true })).ino).toBe(inode)
    expect(await indexed(f.handle)).toBe(0)
  })
  it('refuses corrupt complete history and an unexplained partial tail without modifying either', async () => {
    const f = await fixture()
    await f.authority.appendReconcileIntent(f.binding)
    const original = await readFile(f.log, 'utf8')
    for (const changed of [original.replace('account.update', 'account.delete'), original + '{"unexpected":']) {
      await writeFile(f.log, changed)
      await expect(f.authority.recoverReconcileIntent(f.binding)).rejects.toThrow()
      expect(await readFile(f.log, 'utf8')).toBe(changed)
    }
  })
  it('requires exact index binding rather than only matching UID or hash', async () => {
    const f = await fixture()
    await f.handle.db.exec("CREATE TRIGGER test_audit_outage BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'controlled_index_failure'); END")
    await expect(f.authority.appendReconcileIntent(f.binding)).rejects.toThrow()
    await f.handle.db.exec('DROP TRIGGER test_audit_outage')
    const record = (await records(f.log))[0]!
    await f.handle.db.query('INSERT INTO audit_log (at,actor,principal_id,ip,action,target,detail,outcome) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7)', [
      record.at, record.actor, record.principalId, record.action, 'different-target',
      JSON.stringify({ ...record.detail, _auditEventUid: record.eventUid, _auditEntryHash: record.entryHash, _auditPrevHash: record.prevHash, _auditSeq: record.seq }), record.outcome,
    ])
    await expect(f.authority.recoverReconcileIntent(f.binding)).rejects.toThrow()
    expect(await records(f.log)).toHaveLength(1)
    expect((await readdir(f.directory)).includes(OPERATION_AUDIT_PENDING_NAME)).toBe(true)
  })
  it('refuses unsafe directory/file modes, symlinks and hardlinks', async () => {
    const f = await fixture()
    await chmod(f.directory, 0o750)
    await expect(createRootOperationAuditAuthority(f.handle.db, { directory: f.directory })).rejects.toThrow()
    await chmod(f.directory, 0o700)
    const outside = join(f.root, 'outside')
    await writeFile(outside, '', { mode: 0o600 })
    await symlink(outside, f.log)
    await expect(f.authority.appendReconcileIntent(f.binding)).rejects.toThrow()
    await rm(f.log)
    await link(outside, f.log)
    await expect(f.authority.appendReconcileIntent(f.binding)).rejects.toThrow()
    await rm(f.log)
    await f.authority.appendReconcileIntent(f.binding)
    await chmod(f.log, 0o640)
    await expect(f.authority.recoverReconcileIntent(f.binding)).rejects.toThrow()
  })
  it('uses fd root:root ownership with a different actual root service primary gid', async () => {
    const f = await fixture()
    const result = await launch(childProgram, childArgs(f, f.binding), 65534).done
    expect(result.code, result.stderr).toBe(0)
    for (const path of [f.log, f.anchor]) {
      const info = await lstat(path)
      expect(info.uid).toBe(0)
      expect(info.gid).toBe(0)
      expect(info.mode & 0o777).toBe(0o600)
    }
    await chown(f.directory, 0, 65534)
    await expect(createRootOperationAuditAuthority(f.handle.db, { directory: f.directory })).rejects.toThrow()
  })
  it('binds genuine receipts and restart recovery to the actual issuer and physical DB file', async () => {
    const a = await fixture(), b = await fixture()
    const receipt = await a.authority.appendReconcileIntent(a.binding)
    await expect(b.handle.db.transaction(async tx => assertOperationIntentReceipt(receipt, a.binding, tx))).rejects.toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
    // Give B its own synthetic identity under the same ID, without copying credentials.
    await b.handle.db.query('UPDATE principals SET id = $1 WHERE id = $2', [a.principal.id, b.principal.id])
    const foreign = await createRootOperationAuditAuthority(b.handle.db, { directory: a.directory })
    await expect(foreign.recoverReconcileIntent(a.binding)).rejects.toThrow()
    expect(await records(a.log)).toHaveLength(1)
    expect(await indexed(b.handle)).toBe(0)
  })
  it.each(['missing', 'prefix-truncation', 'old-file-replacement', 'old-log-and-anchor'] as const)('refuses %s rollback with surviving SQLite history and preserves evidence', async mode => {
    const f = await fixture()
    await f.authority.appendReconcileIntent(f.binding)
    const oldBytes = await readFile(f.log), oldAnchor = await readFile(f.anchor)
    await f.authority.appendReconcileIntent({ ...f.binding, jobId: randomUUID(), requestFingerprint: 'e'.repeat(64) })
    if (mode === 'missing') await rm(f.log)
    else if (mode === 'old-file-replacement') {
      await rename(f.log, f.log + '.previous')
      await writeFile(f.log, oldBytes, { mode: 0o600 })
    } else {
      await writeFile(f.log, oldBytes)
      if (mode === 'old-log-and-anchor') await writeFile(f.anchor, oldAnchor)
    }
    const before = mode === 'missing' ? null : await readFile(f.log)
    const anchor = await readFile(f.anchor)
    const recovered = await createRootOperationAuditAuthority(f.handle.db, { directory: f.directory })
    await expect(recovered.recoverReconcileIntent(f.binding)).rejects.toThrow()
    await expect(recovered.appendReconcileIntent({ ...f.binding, jobId: randomUUID() })).rejects.toThrow()
    if (before === null) await expect(lstat(f.log)).rejects.toMatchObject({ code: 'ENOENT' })
    else expect((await readFile(f.log)).equals(before)).toBe(true)
    expect((await readFile(f.anchor)).equals(anchor)).toBe(true)
    expect((await readdir(f.directory)).includes(OPERATION_AUDIT_PENDING_NAME)).toBe(false)
    expect(await indexed(f.handle)).toBe(2)
  })
  it('fails visibly at capacity without a new chain, journal or false index receipt', async () => {
    const f = await fixture()
    await f.authority.appendReconcileIntent(f.binding)
    const first = (await records(f.log))[0]!, lines = [JSON.stringify(first) + '\n']
    let prevHash = first.entryHash
    for (let i = 1; i < MAX_OPERATION_AUDIT_RECORDS; i++) {
      const record: AuditFileRecord = {
        seq: i + 1, eventUid: randomUUID(), id: String(i + 1), at: new Date().toISOString(), actor: 'auditor',
        principalId: f.principal.id, ip: null, action: 'host.reconcile.intent', target: '',
        detail: { schemaVersion: 1, kind: 'host.reconcile', jobId: randomUUID(), requestFingerprint: 'a'.repeat(64), action: 'account.update', principalId: f.principal.id },
        outcome: 'ok', prevHash, entryHash: '',
      }
      record.target = 'operation:' + record.detail.jobId
      record.entryHash = computeAuditEntryHash(record)
      prevHash = record.entryHash
      lines.push(JSON.stringify(record) + '\n')
    }
    const bytes = lines.join('')
    await writeFile(f.log, bytes)
    const anchor = JSON.parse(await readFile(f.anchor, 'utf8'))
    anchor.lastSeq = MAX_OPERATION_AUDIT_RECORDS; anchor.lastHash = prevHash; anchor.bytes = Buffer.byteLength(bytes)
    await writeFile(f.anchor, JSON.stringify(anchor) + '\n')
    const before = await lstat(f.log, { bigint: true })
    await expect(f.authority.appendReconcileIntent({ ...f.binding, jobId: randomUUID() })).rejects.toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
    const after = await lstat(f.log, { bigint: true })
    expect(after.size).toBe(before.size)
    expect(after.ino).toBe(before.ino)
    expect((await readdir(f.directory)).includes(OPERATION_AUDIT_PENDING_NAME)).toBe(false)
    expect(await indexed(f.handle)).toBe(1)
  })
})
