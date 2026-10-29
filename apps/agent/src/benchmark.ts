import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fail, msgid } from '@xpanel/core'
import { BENCHMARK_BYTES, BENCHMARK_DIRECTORY, BENCHMARK_FILE, BENCHMARK_KIND, benchmarkCommands, isBenchmarkCommand, parseBenchmarkCpu, parseBenchmarkDisk } from '../../../packages/os/src/benchmark-command.ts'
import type { HostJobCommandStep, HostJobPlan, HostJobView } from './host-job-contract.ts'
export interface BenchmarkResult { startedAt: string; finishedAt: string; state: 'measured' | 'partial' | 'unavailable'; cpuBytesPerSecond: number | null; diskWriteBytesPerSecond: number | null; diskReadBytesPerSecond: number | null; cleanup: 'verified' | 'unknown'; network: 'not_measured' }
export interface BenchmarkHistory { state: 'read' | 'unavailable'; results: BenchmarkResult[] }
export interface BenchmarkStore { prepare(): Promise<void>; removed(): Promise<boolean>; read(): Promise<BenchmarkHistory>; append(result: BenchmarkResult): Promise<void> }
export interface BenchmarkContext {
  assertRoot(action: string): Promise<{ actor: string }>
  store: BenchmarkStore | null
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  listJobs: (() => Promise<HostJobView[]>) | null
  now?: () => Date
}
export const BENCHMARK_HISTORY_LIMIT = 20
const HISTORY = BENCHMARK_DIRECTORY + '/history.json'
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const instant = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))
const rate = (v: unknown): v is number | null => v === null || typeof v === 'number' && Number.isSafeInteger(v) && v > 0
export const isBenchmarkResult = (v: unknown): v is BenchmarkResult => object(v) && instant(v.startedAt) && instant(v.finishedAt) && Date.parse(v.finishedAt) >= Date.parse(v.startedAt) && ['measured', 'partial', 'unavailable'].includes(String(v.state)) && rate(v.cpuBytesPerSecond) && rate(v.diskWriteBytesPerSecond) && rate(v.diskReadBytesPerSecond) && ['verified', 'unknown'].includes(String(v.cleanup)) && v.network === 'not_measured' && (v.state !== 'measured' || v.cleanup === 'verified' && v.cpuBytesPerSecond !== null && v.diskWriteBytesPerSecond !== null && v.diskReadBytesPerSecond !== null)

/** Native only: fixed root-owned private directory, no-follow file reads, exclusive atomic history replacement. */
export function createNativeBenchmarkStore(): BenchmarkStore {
  const directory = async (create = false): Promise<void> => {
    if (create) await mkdir(BENCHMARK_DIRECTORY, { recursive: true, mode: 0o700 })
    for (const path of [BENCHMARK_DIRECTORY, '/var/lib/xpanel-agent', '/var/lib', '/var']) {
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return fail('PRECONDITION_FAILED', 'the benchmark directory is not protected', { stateChanged: false })
    }
  }
  const removed = async (): Promise<boolean> => { try { await lstat(BENCHMARK_FILE); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' } }
  const read = async (): Promise<BenchmarkHistory> => {
    try {
      await directory()
      let handle
      try { handle = await open(HISTORY, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'read', results: [] }; throw error }
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw new Error('invalid_history')
        const raw: unknown = JSON.parse(await handle.readFile('utf8'))
        if (!Array.isArray(raw) || raw.length > BENCHMARK_HISTORY_LIMIT || !raw.every(isBenchmarkResult)) throw new Error('invalid_history')
        return { state: 'read', results: raw }
      } finally { await handle.close() }
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'read', results: [] } : { state: 'unavailable', results: [] } }
  }
  return {
    prepare: async () => { await directory(true); if (!(await removed())) return fail('PRECONDITION_FAILED', 'a benchmark temporary file remains and requires review', { stateChanged: false, verificationRequired: true }) },
    removed, read,
    append: async result => {
      if (!isBenchmarkResult(result)) throw new Error('invalid_benchmark_result')
      const previous = await read(); if (previous.state !== 'read') throw new Error('history_unavailable')
      const path = BENCHMARK_DIRECTORY + '/history-' + randomUUID() + '.tmp'
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(JSON.stringify([result, ...previous.results].slice(0, BENCHMARK_HISTORY_LIMIT)) + '\n'); await handle.sync() } finally { await handle.close() }
      try { await rename(path, HISTORY) } catch (error) { await unlink(path).catch(() => undefined); throw error }
    },
  }
}
const step = (id: string, title: string, argv: string[], timeoutMs: number, mutates: boolean): HostJobCommandStep => ({ id, title, argv, timeoutMs, mutates, env: { LC_ALL: 'C' } })
/** 35 seconds of command deadlines plus at most 20 seconds of runner kill grace; no external network request. */
export function createBenchmarkPlan(ctx: BenchmarkContext, store: BenchmarkStore): HostJobPlan {
  const commands = benchmarkCommands(); let startedAt = (ctx.now?.() ?? new Date()).toISOString(), began = false
  return {
    kind: BENCHMARK_KIND, summary: 'Bounded low-priority CPU and 64 MiB disk benchmark', accountId: null,
    fingerprint: { benchmark: 1, bytes: BENCHMARK_BYTES }, detail: { seconds: 5, diskBytes: BENCHMARK_BYTES, commandDeadlineMs: 35000, network: 'not_measured' },
    policy: isBenchmarkCommand,
    steps: [step('cpu', msgid('SHA-256 throughput'), commands.cpu, 8000, false), step('write', msgid('Write 64 MiB'), commands.write, 12000, true), step('read', msgid('Read 64 MiB'), commands.read, 12000, false)],
    beforeStep: async () => { await ctx.assertRoot('server.benchmark.run'); if (!began) { began = true; startedAt = (ctx.now?.() ?? new Date()).toISOString() } },
    finalize: async (run, results) => {
      let cleanup = false
      try { const removed = await run(step('cleanup', msgid('Remove temporary file'), commands.cleanup, 3000, true)); cleanup = removed.ok && !removed.timedOut && await store.removed() } catch { cleanup = false }
      const output = (id: string): string | null => { const value = results.find(row => row.id === id)?.result; return value?.ok && !value.timedOut && value.code === 0 ? value.stdout + '\n' + value.stderr : null }
      const cpu = output('cpu'), write = output('write'), read = output('read')
      const values = { cpuBytesPerSecond: cpu === null ? null : parseBenchmarkCpu(cpu), diskWriteBytesPerSecond: write === null ? null : parseBenchmarkDisk(write), diskReadBytesPerSecond: read === null ? null : parseBenchmarkDisk(read) }
      const measured = Object.values(values).filter(value => value !== null).length
      const result: BenchmarkResult = { startedAt, finishedAt: (ctx.now?.() ?? new Date()).toISOString(), state: cleanup && measured === 3 ? 'measured' : measured ? 'partial' : 'unavailable', ...values, cleanup: cleanup ? 'verified' : 'unknown', network: 'not_measured' }
      let saved = false; try { await store.append(result); saved = true } catch { saved = false }
      const commandsCompleted = results.length === 3 && results.every(row => row.result?.ok && !row.result.timedOut && row.result.code === 0)
      return { ok: cleanup && saved && (!commandsCompleted || result.state === 'measured'), detail: { result, historySaved: saved, cleanupVerified: cleanup } }
    },
  }
}
let admission: Promise<unknown> = Promise.resolve()
export async function handleBenchmarkRoute(req: Request, url: URL, method: string, ctx: BenchmarkContext): Promise<Response | null> {
  if (url.pathname !== '/host/monitoring/benchmark' && url.pathname !== '/host/monitoring/benchmark/jobs') return null
  const reading = url.pathname.endsWith('/benchmark'), action = reading ? 'server.benchmark.read' : 'server.benchmark.run'
  await ctx.assertRoot(action)
  if (method !== (reading ? 'GET' : 'POST')) return new Response(null, { status: 405, headers: { allow: reading ? 'GET' : 'POST' } })
  if (url.search || reading && req.body !== null) return fail('VALIDATION', 'benchmark accepts no selectors', { stateChanged: false })
  if (reading) {
    const history = ctx.store ? await ctx.store.read() : { state: 'unavailable', results: [] }
    await ctx.assertRoot(action)
    return Response.json({ history, jobsAvailable: !!ctx.store && !!ctx.submitJob && !!ctx.listJobs, limits: { cpuSeconds: 5, diskBytes: BENCHMARK_BYTES, maxRuntimeSeconds: 60 }, network: 'not_measured' }, { headers: { 'cache-control': 'no-store' } })
  }
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', { stateChanged: false })
  const raw = await req.text(); let body: unknown
  try { body = raw.length <= 256 ? JSON.parse(raw) : null } catch { body = null }
  if (!object(body) || Object.keys(body).length !== 1 || body.confirm !== 'RUN') return fail('VALIDATION', 'confirm RUN is required', { stateChanged: false })
  if (!ctx.store || !ctx.submitJob || !ctx.listJobs) return fail('PRECONDITION_FAILED', 'native benchmark jobs are unavailable', { stateChanged: false })
  const store = ctx.store, submit = ctx.submitJob, list = ctx.listJobs
  const work = admission.then(async () => {
    const active = (await list()).find(job => job.kind === BENCHMARK_KIND && ['queued', 'running'].includes(job.status))
    const actor = await ctx.assertRoot(action)
    if (active) return active
    await store.prepare()
    await ctx.assertRoot(action)
    return submit(createBenchmarkPlan(ctx, store), actor.actor)
  }); admission = work.catch(() => undefined)
  const job = await work
  return Response.json({ job: { id: job.id, kind: job.kind, status: job.status } }, { status: 202, headers: { 'cache-control': 'no-store' } })
}
