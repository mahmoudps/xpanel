import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MAX_AUDIT_DETAIL_BYTES } from '@xpanel/core'
import { createDb, type DbHandle } from '../client.ts'
import { migrate } from '../migrate.ts'
import { appendAudit, replayAuditLogToIndex, rotateAuditLog, verifyAuditChain } from './audit.ts'

let base: string
let template: string
const handles: DbHandle[] = []
const directories: string[] = []
const children: (() => Promise<void>)[] = []

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'xpanel-audit-concurrency-'))
  template = join(base, 'template.sqlite')
  const handle = createDb(template)
  try { await migrate(handle.db) } finally { await handle.close() }
})
afterEach(async () => {
  for (const close of children.splice(0)) await close()
  for (const handle of handles.splice(0)) await handle.close()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
afterAll(async () => { await rm(base, { recursive: true, force: true }) })

const fixture = async () => {
  const directory = await mkdtemp(join(base, 'case-'))
  directories.push(directory)
  const file = join(directory, 'index.sqlite')
  await copyFile(template, file)
  const first = createDb(file), second = createDb(file)
  handles.push(first, second)
  return { directory, first, second, log: join(directory, 'audit.jsonl') }
}
const entry = (target: string) => ({ actor: 'root', action: 'account.test', target, outcome: 'ok' as const })
const missing = (path: string) => expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })

describe('durable audit admission across append, verification, rotation and replay', () => {
  it('serializes concurrent appends across connections into one contiguous chain', async () => {
    const f = await fixture()
    const entries = await Promise.all(Array.from({ length: 8 }, (_, i) => appendAudit(i % 2 ? f.first.db : f.second.db, entry(String(i)), { auditLogFilePath: f.log })))
    expect(new Set(entries.map(item => item.seq)).size).toBe(8)
    expect(await verifyAuditChain(f.log)).toMatchObject({ valid: true, entriesVerified: 8, lastSeq: 8 })
    expect(await f.first.db.query('SELECT COUNT(*) AS count FROM audit_log')).toEqual([{ count: 8 }])
  })

  it('serializes append with rotation without losing either side of the chain', async () => {
    const f = await fixture()
    await appendAudit(f.first.db, entry('before'), { auditLogFilePath: f.log })
    const [rotation] = await Promise.all([
      rotateAuditLog(f.log),
      appendAudit(f.second.db, entry('during'), { auditLogFilePath: f.log }),
    ])
    expect(await verifyAuditChain(f.log, { archivePaths: [rotation.archivePath] })).toMatchObject({ valid: true, entriesVerified: 2, lastSeq: 2 })
    await expect(rotateAuditLog(f.log, { archivePath: rotation.archivePath })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('serializes replay with append and another replay without duplicate index rows', async () => {
    const f = await fixture()
    await appendAudit(f.first.db, entry('spooled'), { auditLogFilePath: f.log, simulateIndexError: new Error('index offline'), allowSpoolOnIndexFailure: true })
    await Promise.all([
      replayAuditLogToIndex(f.first.db, { auditLogFilePath: f.log }),
      appendAudit(f.second.db, entry('concurrent'), { auditLogFilePath: f.log }),
      replayAuditLogToIndex(f.second.db, { auditLogFilePath: f.log }),
    ])
    expect(await f.first.db.query('SELECT COUNT(*) AS count FROM audit_log')).toEqual([{ count: 2 }])
    expect(await verifyAuditChain(f.log)).toMatchObject({ valid: true, entriesVerified: 2 })
  })

  it('quarantines a truncated tail before a subsequent append', async () => {
    const f = await fixture()
    await appendAudit(f.first.db, entry('before'), { auditLogFilePath: f.log })
    const content = await readFile(f.log, 'utf8')
    await writeFile(f.log, content + '{"incomplete":')
    await verifyAuditChain(f.log, { quarantineTruncatedTail: true })
    await appendAudit(f.second.db, entry('after'), { auditLogFilePath: f.log })
    expect(await verifyAuditChain(f.log)).toMatchObject({ valid: true, entriesVerified: 2 })
    expect(await readFile(f.log + '.quarantine', 'utf8')).toBe('{"incomplete":\n')
  })

  it('rejects durable operations in an outer DB transaction and preserves DB-only transactional audit', async () => {
    const f = await fixture()
    await f.first.db.transaction(async tx => {
      await expect(appendAudit(tx, entry('file'), { auditLogFilePath: f.log })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      await appendAudit(tx, entry('db-only'))
    })
    await missing(f.log)
    expect(await f.first.db.query('SELECT target FROM audit_log')).toEqual([{ target: 'db-only' }])
  })

  it('releases admission after sink failure and never assigns unconfirmed chain metadata to a fallback row', async () => {
    const f = await fixture()
    await expect(appendAudit(f.first.db, entry('failed'), { auditLogFilePath: f.log, simulateSinkError: new Error('sink offline') })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    const fallback = await appendAudit(f.first.db, entry('fallback'), { auditLogFilePath: f.log, simulateSinkError: new Error('sink offline'), failClosed: false })
    expect(fallback).not.toHaveProperty('seq')
    expect(fallback).not.toHaveProperty('entryHash')
    expect(await appendAudit(f.second.db, entry('next'), { auditLogFilePath: f.log })).toMatchObject({ seq: 1 })
    expect(await verifyAuditChain(f.log)).toMatchObject({ valid: true, entriesVerified: 1 })
  })

  it('rejects invalid detail before publication, bounds legitimate detail and rejects hardlink aliases', async () => {
    const f = await fixture()
    await expect(appendAudit(f.first.db, { ...entry('invalid'), detail: [] as unknown as Record<string, unknown> }, { auditLogFilePath: f.log })).rejects.toMatchObject({ code: 'VALIDATION' })
    await missing(f.log)
    const detail = Object.fromEntries(Array.from({ length: 96 }, (_, i) => ['field' + i, 'x'.repeat(1024)]))
    const normalized = await appendAudit(f.first.db, { ...entry('large'), detail }, { auditLogFilePath: f.log })
    expect(Buffer.byteLength(JSON.stringify(normalized.detail))).toBeLessThanOrEqual(MAX_AUDIT_DETAIL_BYTES)
    expect(JSON.parse(await readFile(f.log, 'utf8')).detail).toEqual(normalized.detail)
    const alias = join(f.directory, 'alias.jsonl')
    await link(f.log, alias)
    await expect(appendAudit(f.second.db, entry('alias'), { auditLogFilePath: alias })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await readFile(f.log, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('waits for an independent process and resumes after its guard is killed', async () => {
    const f = await fixture()
    await appendAudit(f.first.db, entry('before'), { auditLogFilePath: f.log })
    const name = process.platform === 'win32' ? basename(f.log).toLowerCase() : basename(f.log)
    const mutex = join(f.directory, '.audit-' + createHash('sha256').update(name).digest('hex') + '.mutex.sqlite')
    const module = pathToFileURL(resolve('packages/state/src/index.ts')).href
    const script = `import {acquireWriterMutex} from ${JSON.stringify(module)}; globalThis.guard=await acquireWriterMutex(${JSON.stringify(mutex)},3000,5); process.send({ready:true}); setInterval(()=>{},1000);`
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { cwd: resolve('.'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let diagnostics = ''
    child.stderr?.on('data', value => { diagnostics += String(value) })
    const exited = new Promise<void>(done => child.once('close', () => done()))
    const close = async () => { if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited }
    children.push(close)
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('audit holder timeout: ' + diagnostics)) }, 5000)
      child.once('message', () => { clearTimeout(timeout); done() })
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('audit holder exited: ' + diagnostics)) })
    })
    let completed = false
    const pending = appendAudit(f.second.db, entry('after'), { auditLogFilePath: f.log }).then(value => { completed = true; return value })
    await new Promise(done => setTimeout(done, 20))
    expect(completed).toBe(false)
    await close()
    expect(await pending).toMatchObject({ seq: 2 })
    expect(await verifyAuditChain(f.log)).toMatchObject({ valid: true, entriesVerified: 2 })
  })
})
