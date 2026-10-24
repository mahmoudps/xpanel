import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readlink, statfs } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import * as nodeProcess from 'node:process'
import {
  RESOURCE_LIVE_STALE_AFTER_MS, RESOURCE_OBSERVATION_FIELDS, RESOURCE_OBSERVATION_LIMITS,
  RESOURCE_SAMPLE_INTERVAL_MS, parseResourceObservationSnapshot, projectResourceObservationForLive,
  resourceRateUnavailability,
} from '../../../packages/core/src/rules/resource-observations.ts'
import type {
  AccountResourceFields, AccountResourceObservation, DeferredResourceFields, HostResourceFields,
  HostResourceObservation, LiveResourceObservation, ResourceObservationSnapshot, ResourceRateBaseline,
  ResourceReadSpan, ResourceSourceIdentity, ResourceUnavailableReason,
} from '../../../packages/core/src/rules/resource-observations.ts'

// Unix-only properties may be absent before the sampler's platform admission check.
const { geteuid, hrtime, pid, platform } = nodeProcess

/** Reader workload ceilings, not hosting quotas or measured capacities. */
export const RESOURCE_READER_LIMITS = Object.freeze({
  accounts: 256, fileOpens: 2_048, ioOperations: 16_384, openHandles: 16,
  totalBytes: 8 * 1_024 * 1_024, procStatBytes: 1_024 * 1_024,
  normalFileBytes: 64 * 1_024, ioStatBytes: 512 * 1_024,
  chunkBytes: 4_096, captureDeadlineMs: 2_000,
})

type FailureReason = Exclude<ResourceUnavailableReason, 'warming-up' | 'counter-reset' | 'no-operations' | 'stale' | 'not-sampled'>

export class ResourceCaptureError extends Error {
  readonly reason: FailureReason
  readonly fatal: boolean
  constructor(reason: FailureReason, message: string, fatal = false) {
    super(message); this.name = 'ResourceCaptureError'; this.reason = reason; this.fatal = fatal
  }
}

const refused = (message: string, reason: FailureReason = 'invalid'): never => { throw new ResourceCaptureError(reason, message) }
const U64_MAX = 18_446_744_073_709_551_615n
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const natural = (input: string): bigint => {
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(input)) return refused('invalid unsigned kernel counter')
  const value = BigInt(input)
  if (value > U64_MAX) return refused('kernel counter exceeds unsigned64')
  return value
}
const scalar = (input: string, maximum = Number.MAX_VALUE): number => {
  if (input.length > 32 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(input)) return refused('invalid kernel decimal')
  const value = Number(input)
  if (!Number.isFinite(value) || value > maximum) return refused('kernel decimal out of range')
  return value
}

const lines = (input: unknown, maxBytes: number, maxLines: number): string[] => {
  if (typeof input !== 'string' || Buffer.byteLength(input) > maxBytes || /[^\x09\x0a\x20-\x7e]/.test(input)) return refused('invalid kernel text')
  const result = input.split('\n')
  if (result.at(-1) === '') result.pop()
  if (result.length > maxLines || result.some(line => line === '')) return refused('invalid kernel line count')
  return result
}

export const parseOnlineCpuIds = (input: unknown): readonly number[] => {
  const rows = lines(input, RESOURCE_READER_LIMITS.normalFileBytes, 1)
  if (rows.length !== 1) return refused('CPU online set missing', 'missing')
  const ids: number[] = []
  for (const part of rows[0]!.split(',')) {
    const match = /^(0|[1-9][0-9]{0,9})(?:-(0|[1-9][0-9]{0,9}))?$/.exec(part)
    if (!match) return refused('invalid CPU online range')
    const start = Number(match[1]), end = match[2] === undefined ? start : Number(match[2])
    if (end < start || end > 0xffff_ffff || (ids.length > 0 && start <= ids.at(-1)!)
      || end - start + 1 > RESOURCE_OBSERVATION_LIMITS.cpuIdsPerIdentity - ids.length) return refused('CPU online range exceeds protocol')
    for (let id = start; id <= end; id++) ids.push(id)
  }
  return ids
}

export interface ProcCpuCounters { readonly counters: readonly bigint[]; readonly cpuIds: readonly number[] }
export const parseProcCpuCounters = (input: unknown): ProcCpuCounters => {
  const rows = lines(input, RESOURCE_READER_LIMITS.procStatBytes, 16_384)
  let counters: bigint[] | null = null
  const cpuIds: number[] = []
  for (const row of rows) {
    if (!/^cpu(?:\s|[0-9])/.test(row)) continue
    const tokens = row.trim().split(/\s+/)
    if (!/^cpu(?:0|[1-9][0-9]{0,9})?$/.test(tokens[0]!) || tokens.length !== 11) return refused('invalid proc CPU row')
    const values = tokens.slice(1).map(natural)
    if (tokens[0] === 'cpu') {
      if (counters !== null) return refused('duplicate aggregate CPU counters')
      // guest and guest_nice are already included in user/nice. Never sum them twice.
      counters = values.slice(0, 8)
    } else {
      const id = Number(tokens[0]!.slice(3))
      if (id > 0xffff_ffff || cpuIds.length >= RESOURCE_OBSERVATION_LIMITS.cpuIdsPerIdentity
        || (cpuIds.length > 0 && id <= cpuIds.at(-1)!)) return refused('invalid proc CPU identities')
      cpuIds.push(id)
    }
  }
  if (counters === null || cpuIds.length === 0) return refused('proc CPU counters missing', 'missing')
  return { counters, cpuIds }
}

export const parseProcMemory = (input: unknown): { readonly totalKiB: bigint | null; readonly availableKiB: bigint | null } => {
  const values = new Map<string, { value: bigint; unit: string | undefined }>()
  for (const row of lines(input, RESOURCE_READER_LIMITS.normalFileBytes, 256)) {
    const match = /^([A-Za-z_][A-Za-z_0-9()]*):\s+(\d+)(?:\s+(kB))?$/.exec(row)
    if (!match || values.has(match[1]!)) return refused('invalid meminfo row')
    values.set(match[1]!, { value: natural(match[2]!), unit: match[3] })
  }
  const read = (key: string): bigint | null => {
    const value = values.get(key)
    if (!value) return null
    if (value.unit !== 'kB') return refused('meminfo unit mismatch')
    return value.value
  }
  return { totalKiB: read('MemTotal'), availableKiB: read('MemAvailable') }
}

export const parseProcLoad = (input: unknown): number => {
  const rows = lines(input, RESOURCE_READER_LIMITS.normalFileBytes, 1)
  if (rows.length !== 1) return refused('loadavg missing', 'missing')
  const tokens = rows[0]!.split(' ')
  if (tokens.length !== 5 || tokens.some(token => token.length === 0)) return refused('invalid loadavg row')
  const loads = tokens.slice(0, 3).map(token => scalar(token))
  const tasks = /^(\d+)\/(\d+)$/.exec(tokens[3]!)
  if (!tasks || natural(tasks[1]!) > natural(tasks[2]!)) return refused('invalid loadavg task counts')
  natural(tokens[4]!)
  return loads[0]!
}

export const parseIoPressure = (input: unknown): { readonly some: number | null; readonly full: number | null } => {
  let some: number | null = null, full: number | null = null
  for (const row of lines(input, RESOURCE_READER_LIMITS.normalFileBytes, 2)) {
    const match = /^(some|full) avg10=(\S+) avg60=(\S+) avg300=(\S+) total=(\S+)$/.exec(row)
    if (!match) return refused('invalid IO pressure row')
    const value = scalar(match[2]!, 100)
    scalar(match[3]!, 100); scalar(match[4]!, 100); natural(match[5]!)
    if (match[1] === 'some') { if (some !== null) return refused('duplicate IO pressure some'); some = value }
    else { if (full !== null) return refused('duplicate IO pressure full'); full = value }
  }
  return { some, full }
}

export const parseCgroupCpuUsage = (input: unknown): bigint => {
  const values = new Map<string, bigint>()
  for (const row of lines(input, RESOURCE_READER_LIMITS.normalFileBytes, 256)) {
    const match = /^([a-z][a-z0-9_]*) (\d+)$/.exec(row)
    if (!match || values.has(match[1]!)) return refused('invalid cgroup CPU row')
    values.set(match[1]!, natural(match[2]!))
  }
  const usage = values.get('usage_usec')
  if (usage === undefined) return refused('cgroup CPU usage missing', 'missing')
  return usage
}

export const parseCgroupInteger = (input: unknown): bigint => {
  const rows = lines(input, RESOURCE_READER_LIMITS.normalFileBytes, 1)
  if (rows.length !== 1) return refused('cgroup scalar missing', 'missing')
  return natural(rows[0]!)
}

export interface CgroupIoCounters {
  readonly device: string
  readonly rbytes: bigint
  readonly wbytes: bigint
  readonly rios: bigint
  readonly wios: bigint
}
export const parseCgroupIoCounters = (input: unknown): readonly CgroupIoCounters[] => {
  const devices = new Map<string, CgroupIoCounters>()
  for (const row of lines(input, RESOURCE_READER_LIMITS.ioStatBytes, RESOURCE_OBSERVATION_LIMITS.ioDevicesPerIdentity)) {
    const tokens = row.split(' '), device = tokens.shift()!
    if (device.length > 21 || !/^(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$/.test(device)
      || device.split(':').some(part => BigInt(part) > 0xffff_ffffn) || devices.has(device)) return refused('invalid cgroup IO device')
    const values = new Map<string, bigint>()
    for (const token of tokens) {
      const match = /^([a-z][a-z0-9_]*)=(\d+)$/.exec(token)
      if (!match || values.has(match[1]!)) return refused('invalid cgroup IO counter')
      values.set(match[1]!, natural(match[2]!))
    }
    if (['rbytes', 'wbytes', 'rios', 'wios'].some(key => !values.has(key))) return refused('cgroup IO counter missing', 'missing')
    devices.set(device, { device, rbytes: values.get('rbytes')!, wbytes: values.get('wbytes')!, rios: values.get('rios')!, wios: values.get('wios')! })
  }
  return [...devices.values()].sort((left, right) => left.device < right.device ? -1 : left.device > right.device ? 1 : 0)
}

const monotonicUs = (): number => {
  const value = hrtime.bigint() / 1_000n
  if (value < 0 || value > SAFE_MAX) return refused('monotonic clock is not exactly representable')
  return Number(value)
}
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
const PROC_MAGIC = 0x9fa0n, SYS_MAGIC = 0x62656572n, CGROUP_MAGIC = 0x63677270n
interface PinnedDirectory { readonly handle: FileHandle; readonly device: bigint; readonly inode: bigint; readonly magic: bigint | null }
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

/** Actual Linux I/O only. Diagnostic providers exist solely in the scoped test module. */
class KernelCapture {
  readonly started = monotonicUs()
  readonly handles = new Set<FileHandle>()
  readonly closeAttempted = new WeakSet<FileHandle>()
  cleanupUncertain = false
  bytes = 0
  opens = 0
  operations = 0
  aborted = false
  root!: PinnedDirectory
  proc!: PinnedDirectory
  ownProc!: PinnedDirectory
  fdAnchor!: PinnedDirectory
  sys!: PinnedDirectory
  cpu!: PinnedDirectory
  cgroup!: PinnedDirectory

  abort(): void { this.aborted = true }

  async operation<T>(work: () => Promise<T>, cleanup = false): Promise<T> {
    if (!cleanup && this.aborted) throw new ResourceCaptureError('invalid', 'capture retired', true)
    const elapsed = cleanup ? 0 : monotonicUs() - this.started
    if (!cleanup && (elapsed < 0 || elapsed >= RESOURCE_READER_LIMITS.captureDeadlineMs * 1_000)) {
      this.aborted = true
      throw new ResourceCaptureError('invalid', 'capture deadline expired', true)
    }
    if (!cleanup && this.operations >= RESOURCE_READER_LIMITS.ioOperations) throw new ResourceCaptureError('invalid', 'capture operation budget exceeded', true)
    this.operations++
    return await work()
  }

  async opened(path: string, directory: boolean): Promise<FileHandle> {
    if (this.opens >= RESOURCE_READER_LIMITS.fileOpens || this.handles.size >= RESOURCE_READER_LIMITS.openHandles) {
      throw new ResourceCaptureError('invalid', 'capture open budget exceeded', true)
    }
    this.opens++
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0)
    const handle = await this.operation(() => open(path, flags))
    // Late opens remain owned until real settlement; the watchdog never closes/reuses them.
    this.handles.add(handle)
    return handle
  }

  fdPath(handle: FileHandle): string {
    if (!this.handles.has(handle) || !Number.isSafeInteger(handle.fd) || handle.fd < 0) {
      throw new ResourceCaptureError('invalid', 'retired descriptor refused', true)
    }
    return `/proc/${pid}/fd/${handle.fd}`
  }

  async close(handle: FileHandle): Promise<void> {
    if (!this.handles.has(handle)) return
    if (this.closeAttempted.has(handle)) throw new ResourceCaptureError('invalid', 'uncertain descriptor retirement requires process recovery', true)
    this.closeAttempted.add(handle)
    try { await this.operation(() => handle.close(), true); this.handles.delete(handle) }
    catch { this.cleanupUncertain = true; throw new ResourceCaptureError('invalid', 'descriptor retirement failed', true) }
  }

  async pin(path: string, magic: bigint | null): Promise<PinnedDirectory> {
    const handle = await this.opened(path, true)
    try {
      const value = await this.operation(() => handle.stat({ bigint: true }))
      if (!value.isDirectory() || value.uid !== 0n || (value.mode & 0o022n) !== 0n || value.nlink === 0n) {
        throw new ResourceCaptureError('invalid', 'untrusted kernel directory', true)
      }
      const fs = magic === null ? null : await this.operation(() => statfs(this.fdAnchor ? this.fdPath(handle) : path, { bigint: true }))
      if (fs !== null && fs.type !== magic) throw new ResourceCaptureError('unsupported', 'unexpected kernel filesystem', true)
      const result = { handle, device: value.dev, inode: value.ino, magic }
      return result
    } catch (error) { await this.close(handle); throw error }
  }

  component(parent: PinnedDirectory, name: string): string {
    const fixed = ['sys', 'kernel', 'random', 'boot_id', 'stat', 'meminfo', 'loadavg', 'pressure', 'io', 'devices', 'system', 'cpu', 'online', 'fs', 'cgroup', 'xpanel.slice', 'cpu.stat', 'memory.current', 'pids.current', 'io.stat']
    if (!fixed.includes(name) && !/^xpanel-(?:[1-9][0-9]{3,4})\.slice$/.test(name)) {
      throw new ResourceCaptureError('invalid', 'noncanonical kernel component', true)
    }
    return `${this.fdPath(parent.handle)}/${name}`
  }

  async child(parent: PinnedDirectory, name: string, magic = parent.magic): Promise<PinnedDirectory> {
    return await this.pin(this.component(parent, name), magic)
  }

  async descend(parent: PinnedDirectory, names: readonly string[], magic: bigint): Promise<PinnedDirectory> {
    let current = parent
    const intermediates: PinnedDirectory[] = []
    try {
      for (let index = 0; index < names.length; index++) {
        const next = await this.child(current, names[index]!, index === names.length - 1 ? magic : current.magic)
        if (current !== parent) intermediates.push(current)
        current = next
      }
      return current
    } finally { for (const directory of intermediates.reverse()) await this.close(directory.handle) }
  }

  async initialize(): Promise<void> {
    if (platform !== 'linux' || typeof geteuid !== 'function' || geteuid() !== 0
      || !constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK || !Number.isSafeInteger(pid) || pid <= 0) {
      throw new ResourceCaptureError('unsupported', 'Linux root kernel reader required', true)
    }
    this.root = await this.pin('/', null)
    this.proc = await this.pin('/proc', PROC_MAGIC)
    if (await this.operation(() => readlink('/proc/self')) !== String(pid)) throw new ResourceCaptureError('invalid', 'proc namespace does not identify this process', true)
    this.ownProc = await this.pin(`/proc/${pid}`, PROC_MAGIC)
    this.fdAnchor = await this.pin(`/proc/${pid}/fd`, PROC_MAGIC)
    // From here every descendant is reached through the verified own-proc FD anchor.
    this.sys = await this.child(this.root, 'sys', SYS_MAGIC)
    this.cpu = await this.descend(this.sys, ['devices', 'system', 'cpu'], SYS_MAGIC)
    this.cgroup = await this.descend(this.sys, ['fs', 'cgroup'], CGROUP_MAGIC)
  }

  async revalidate(directory: PinnedDirectory): Promise<void> {
    const value = await this.operation(() => directory.handle.stat({ bigint: true }))
    if (!value.isDirectory() || value.dev !== directory.device || value.ino !== directory.inode || value.nlink === 0n
      || value.uid !== 0n || (value.mode & 0o022n) !== 0n) throw new ResourceCaptureError('invalid', 'kernel directory identity changed', true)
  }

  async sameCanonical(parent: PinnedDirectory, name: string, directory: PinnedDirectory): Promise<boolean> {
    const current = await this.child(parent, name, directory.magic)
    try { return current.device === directory.device && current.inode === directory.inode }
    finally { await this.close(current.handle) }
  }

  async verifyRoots(): Promise<void> {
    await this.revalidate(this.root)
    await this.revalidate(this.proc)
    await this.revalidate(this.ownProc)
    await this.revalidate(this.fdAnchor)
    await this.revalidate(this.sys)
    await this.revalidate(this.cpu)
    await this.revalidate(this.cgroup)
    const proc = await this.pin('/proc', PROC_MAGIC)
    try {
      if (proc.device !== this.proc.device || proc.inode !== this.proc.inode
        || !await this.sameCanonical(this.root, 'sys', this.sys)) throw new ResourceCaptureError('invalid', 'kernel root retired', true)
    } finally { await this.close(proc.handle) }
    const own = await this.pin(`/proc/${pid}/fd`, PROC_MAGIC)
    try {
      if (own.device !== this.fdAnchor.device || own.inode !== this.fdAnchor.inode) throw new ResourceCaptureError('invalid', 'own proc fd anchor retired', true)
    } finally { await this.close(own.handle) }
    const cpu = await this.descend(this.sys, ['devices', 'system', 'cpu'], SYS_MAGIC)
    try { if (cpu.device !== this.cpu.device || cpu.inode !== this.cpu.inode) throw new ResourceCaptureError('invalid', 'CPU source retired', true) }
    finally { await this.close(cpu.handle) }
    const cgroup = await this.descend(this.sys, ['fs', 'cgroup'], CGROUP_MAGIC)
    try { if (cgroup.device !== this.cgroup.device || cgroup.inode !== this.cgroup.inode) throw new ResourceCaptureError('invalid', 'cgroup root retired', true) }
    finally { await this.close(cgroup.handle) }
  }

  async text(parent: PinnedDirectory, name: string, maximum = RESOURCE_READER_LIMITS.normalFileBytes): Promise<string> {
    const handle = await this.opened(this.component(parent, name), false)
    try {
      const before = await this.operation(() => handle.stat({ bigint: true }))
      if (!before.isFile() || before.uid !== 0n || (before.mode & 0o022n) !== 0n || before.dev !== parent.device || before.nlink === 0n) {
        throw new ResourceCaptureError('invalid', 'untrusted kernel file')
      }
      if (before.size > BigInt(maximum)) return refused('kernel file exceeds read ceiling')
      const chunks: Buffer[] = []
      let count = 0
      for (;;) {
        const remaining = Math.min(maximum - count, RESOURCE_READER_LIMITS.totalBytes - this.bytes)
        if (remaining <= 0) {
          if (this.bytes >= RESOURCE_READER_LIMITS.totalBytes) throw new ResourceCaptureError('invalid', 'capture byte budget exhausted', true)
          return refused('kernel file completeness exceeds read ceiling')
        }
        const buffer = Buffer.alloc(Math.min(RESOURCE_READER_LIMITS.chunkBytes, remaining))
        const { bytesRead } = await this.operation(() => handle.read(buffer, 0, buffer.length, null))
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length) return refused('invalid native read length')
        count += bytesRead; this.bytes += bytesRead
        if (bytesRead === 0) break
        chunks.push(buffer.subarray(0, bytesRead))
      }
      const after = await this.operation(() => handle.stat({ bigint: true }))
      if (!after.isFile() || after.uid !== 0n || (after.mode & 0o022n) !== 0n
        || after.dev !== before.dev || after.ino !== before.ino || after.nlink === 0n) return refused('kernel file trust changed while reading')
      try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, count)) }
      catch { return refused('invalid kernel UTF-8') }
    } finally { await this.close(handle) }
  }

  async finish(): Promise<void> {
    // Cleanup waits for each real operation. No timeout path retires an in-flight FD.
    for (const handle of [...this.handles].reverse()) {
      if (this.closeAttempted.has(handle)) continue
      try { await this.close(handle) } catch { this.cleanupUncertain = true }
    }
    if (this.handles.size !== 0 || this.cleanupUncertain) throw new ResourceCaptureError('invalid', 'kernel descriptors not proven retired', true)
  }
}

export interface ResourceSamplerAccount { readonly accountId: string; readonly uid: number }
export interface ResourceSamplerConfiguration { readonly revision: string; readonly accounts: readonly ResourceSamplerAccount[] }
interface Outcome<T> { readonly value: T | null; readonly reason: FailureReason | null }
interface RawAccount { readonly cpu: bigint | null; readonly io: readonly CgroupIoCounters[] | null }
interface CaptureResult {
  readonly snapshot: ResourceObservationSnapshot
  readonly hostCpu: readonly bigint[] | null
  readonly accounts: ReadonlyMap<string, RawAccount>
}
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const ownRecord = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return refused('invalid sampler configuration')
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !descriptors[key] || !('value' in descriptors[key]!) || !descriptors[key]!.enumerable)) return refused('invalid sampler configuration fields')
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]))
}
const samplerConfiguration = (input: unknown): ResourceSamplerConfiguration => {
  const value = ownRecord(input, ['revision', 'accounts'])
  if (typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || !Array.isArray(value.accounts)
    || value.accounts.length > RESOURCE_READER_LIMITS.accounts) return refused('sampler configuration exceeds workload ceiling')
  const descriptors = Object.getOwnPropertyDescriptors(value.accounts)
  if (Reflect.ownKeys(descriptors).length !== value.accounts.length + 1) return refused('invalid configured account collection')
  const ids = new Set<string>(), uids = new Set<number>()
  const accounts = Array.from({ length: value.accounts.length }, (_, index) => {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return refused('invalid configured account entry')
    const account = ownRecord(descriptor.value, ['accountId', 'uid'])
    if (typeof account.accountId !== 'string' || !UUID.test(account.accountId) || typeof account.uid !== 'number'
      || !Number.isSafeInteger(account.uid) || account.uid < 1_000 || account.uid > 60_000
      || ids.has(account.accountId) || uids.has(account.uid)) return refused('invalid configured account identity')
    ids.add(account.accountId); uids.add(account.uid)
    return Object.freeze({ accountId: account.accountId, uid: account.uid })
  }).sort((left, right) => left.accountId < right.accountId ? -1 : left.accountId > right.accountId ? 1 : 0)
  return Object.freeze({ revision: value.revision, accounts: Object.freeze(accounts) })
}

const outcome = async <T>(read: () => Promise<string>, parse: (text: string) => T): Promise<Outcome<T>> => {
  try { return { value: parse(await read()), reason: null } }
  catch (error) {
    if (error instanceof ResourceCaptureError) {
      if (error.fatal) throw error
      return { value: null, reason: error.reason }
    }
    return { value: null, reason: errno(error) === 'ENOENT' ? 'missing' : ['EOPNOTSUPP', 'ENOTSUP'].includes(errno(error) ?? '') ? 'unsupported' : 'invalid' }
  }
}
const measurement = (definition: { readonly unit: string; readonly basis: string }, value: number | null, reason: ResourceUnavailableReason = 'missing') =>
  ({ unit: definition.unit, basis: definition.basis, value, availability: value === null ? reason : 'known' })
const safeInteger = (value: bigint | null): number | null => value === null || value < 0 || value > SAFE_MAX ? null : Number(value)
const baselineOf = (epoch: string, value: HostResourceObservation | AccountResourceObservation | undefined): ResourceRateBaseline | null =>
  value === undefined || ('cgroupAvailability' in value && value.cgroupAvailability !== 'present') ? null
    : { producerEpoch: epoch, monotonicUs: value.readSpan.finishedMonotonicUs, identity: value.identity }
const emptyDeferred = (): DeferredResourceFields => Object.fromEntries(Object.entries(RESOURCE_OBSERVATION_FIELDS.deferred)
  .map(([key, definition]) => [key, measurement(definition, null, 'unsupported')])) as DeferredResourceFields
const missingAccount = (account: ResourceSamplerAccount, span: ResourceReadSpan, bootId: string | null, cpuIds: readonly number[] | null): Mutable<AccountResourceObservation> => ({
  accountId: account.accountId, cgroupAvailability: 'missing', readSpan: span,
  identity: { bootId, onlineCpuIds: cpuIds, cgroup: null, ioDevices: null }, previous: null,
  fields: Object.fromEntries(Object.entries(RESOURCE_OBSERVATION_FIELDS.account).map(([key, definition]) => [key, measurement(definition, null, 'missing')])) as AccountResourceFields,
})
const rateReason = (
  epoch: string, subject: HostResourceObservation | AccountResourceObservation,
  kind: 'cpu' | 'io', rawAvailable: boolean,
): ResourceUnavailableReason | null => resourceRateUnavailability(epoch, subject, kind, 'accountId' in subject ? 'account' : 'host')
  ?? (rawAvailable ? null : 'warming-up')

const hostCpuRate = (current: readonly bigint[], previous: readonly bigint[]): { value: number | null; reason: ResourceUnavailableReason } => {
  const deltas = current.map((value, index) => value - previous[index]!)
  if (deltas.some(value => value < 0)) return { value: null, reason: 'counter-reset' }
  const total = deltas.reduce((sum, value) => sum + value, 0n)
  if (total === 0n) return { value: null, reason: 'not-sampled' }
  const busy = total - deltas[3]! - deltas[4]!
  if (total > SAFE_MAX || busy < 0n || busy > total) return { value: null, reason: 'invalid' }
  return { value: Number(busy) / Number(total) * 100, reason: 'invalid' }
}
const accountCpuRate = (current: bigint, previous: bigint, intervalUs: number): { value: number | null; reason: ResourceUnavailableReason } => {
  const delta = current - previous
  if (delta < 0n) return { value: null, reason: 'counter-reset' }
  if (delta > SAFE_MAX) return { value: null, reason: 'invalid' }
  return { value: Number(delta) / intervalUs * 100, reason: 'invalid' }
}
const ioRates = (current: readonly CgroupIoCounters[], previous: readonly CgroupIoCounters[], intervalUs: number) => {
  const sums = { rbytes: 0n, wbytes: 0n, rios: 0n, wios: 0n }
  for (let index = 0; index < current.length; index++) {
    if (current[index]!.device !== previous[index]?.device) return { values: null, reason: 'counter-reset' as const }
    for (const key of ['rbytes', 'wbytes', 'rios', 'wios'] as const) {
      const delta = current[index]![key] - previous[index]![key]
      if (delta < 0n) return { values: null, reason: 'counter-reset' as const }
      sums[key] += delta
    }
  }
  if (current.length !== previous.length) return { values: null, reason: 'counter-reset' as const }
  if (Object.values(sums).some(value => value > SAFE_MAX)) return { values: null, reason: 'invalid' as const }
  return { values: Object.fromEntries(Object.entries(sums).map(([key, value]) => [key, Number(value) / intervalUs * 1_000_000])) as Record<keyof typeof sums, number>, reason: 'invalid' as const }
}

const readBoot = (context: KernelCapture): Promise<Outcome<string>> => outcome(async () => {
  const directory = await context.descend(context.proc, ['sys', 'kernel', 'random'], PROC_MAGIC)
  try { return await context.text(directory, 'boot_id') }
  finally { await context.close(directory.handle) }
}, text => {
  const rows = lines(text, RESOURCE_READER_LIMITS.normalFileBytes, 1)
  if (rows.length !== 1 || !UUID.test(rows[0]!)) return refused('invalid boot identity')
  return rows[0]!
})

const capture = async (
  context: KernelCapture, configuration: ResourceSamplerConfiguration, epoch: string, sequence: number, previous: CaptureResult | null,
): Promise<CaptureResult> => {
  if (previous !== null && context.started <= previous.snapshot.readSpan.finishedMonotonicUs) {
    throw new ResourceCaptureError('invalid', 'non-positive capture interval', true)
  }
  await context.initialize()
  // Shared identity reads are part of every subject's conservative, non-atomic read span.
  const hostStart = monotonicUs()
  const boot = await readBoot(context)
  const online = await outcome(() => context.text(context.cpu, 'online'), parseOnlineCpuIds)
  const cpu = await outcome(() => context.text(context.proc, 'stat', RESOURCE_READER_LIMITS.procStatBytes), parseProcCpuCounters)
  const memory = await outcome(() => context.text(context.proc, 'meminfo'), parseProcMemory)
  const load = await outcome(() => context.text(context.proc, 'loadavg'), parseProcLoad)
  const pressure = await outcome(async () => {
    const directory = await context.child(context.proc, 'pressure')
    try { return await context.text(directory, 'io') } finally { await context.close(directory.handle) }
  }, parseIoPressure)
  const hostSpan = { startedMonotonicUs: hostStart, finishedMonotonicUs: monotonicUs() }
  const hostIdentity: ResourceSourceIdentity = { bootId: boot.value, onlineCpuIds: online.value, cgroup: null, ioDevices: null }
  const H = RESOURCE_OBSERVATION_FIELDS.host
  const totalBytes = memory.value?.totalKiB === null || memory.value === null ? null : memory.value.totalKiB * 1_024n
  const availableBytes = memory.value?.availableKiB === null || memory.value === null ? null : memory.value.availableKiB * 1_024n
  const usedBytes = totalBytes === null || availableBytes === null || availableBytes > totalBytes ? null : totalBytes - availableBytes
  const host = {
    identity: hostIdentity, readSpan: hostSpan, previous: baselineOf(epoch, previous?.snapshot.host),
    fields: {
      cpuBusyPercent: measurement(H.cpuBusyPercent, null, cpu.reason ?? 'warming-up'),
      memoryTotalBytes: measurement(H.memoryTotalBytes, safeInteger(totalBytes), memory.reason ?? (totalBytes === null ? 'missing' : 'invalid')),
      memoryUsedBytes: measurement(H.memoryUsedBytes, safeInteger(usedBytes), memory.reason ?? (availableBytes === null || totalBytes === null ? 'missing' : 'invalid')),
      loadAvg1m: measurement(H.loadAvg1m, load.value, load.reason ?? 'missing'),
      ioPressureSomeAvg10: measurement(H.ioPressureSomeAvg10, pressure.value?.some ?? null, pressure.reason ?? 'missing'),
      ioPressureFullAvg10: measurement(H.ioPressureFullAvg10, pressure.value?.full ?? null, pressure.reason ?? 'missing'),
    },
  } as Mutable<HostResourceObservation>
  let hostCounters = cpu.value?.counters ?? null
  const hostUnavailable = boot.reason ?? online.reason ?? cpu.reason
    ?? (cpu.value && !equal(cpu.value.cpuIds, online.value) ? 'counter-reset' : rateReason(epoch, host, 'cpu', previous?.hostCpu != null))
  if (hostUnavailable !== null || cpu.value === null) host.fields = { ...host.fields, cpuBusyPercent: measurement(H.cpuBusyPercent, null, hostUnavailable ?? 'invalid') } as HostResourceFields
  else {
    const rate = hostCpuRate(cpu.value.counters, previous!.hostCpu!)
    host.fields = { ...host.fields, cpuBusyPercent: measurement(H.cpuBusyPercent, rate.value, rate.reason) } as HostResourceFields
  }
  if (boot.value === null || online.value === null || cpu.value === null || !equal(cpu.value.cpuIds, online.value)) hostCounters = null

  // Repeated CPU identities are counted in the protocol; refuse impossible frame size before account reads.
  const cpuEntries = online.value?.length ?? 0
  const previousEntries = previous?.snapshot.accounts.reduce((sum, account) => sum + (account.identity.onlineCpuIds?.length ?? 0), 0) ?? 0
  if (configuration.accounts.length * cpuEntries + previousEntries + 2 * configuration.accounts.length
    + cpuEntries + (host.previous?.identity.onlineCpuIds?.length ?? 0) > RESOURCE_OBSERVATION_LIMITS.totalArrayEntries) {
    throw new ResourceCaptureError('invalid', 'capture cannot fit protocol array budget', true)
  }
  let parent: PinnedDirectory | null = null
  const parentSpanStart = hostStart
  try { parent = await context.child(context.cgroup, 'xpanel.slice') }
  catch (error) { if (errno(error) !== 'ENOENT') throw error }
  const parentSpan = { startedMonotonicUs: parentSpanStart, finishedMonotonicUs: monotonicUs() }
  const accounts: Mutable<AccountResourceObservation>[] = []
  const raw = new Map<string, RawAccount>()
  const priorAccounts = new Map(previous?.snapshot.accounts.map(account => [account.accountId, account]) ?? [])
  for (const account of configuration.accounts) {
    const startedMonotonicUs = hostStart
    if (parent === null) { accounts.push(missingAccount(account, parentSpan, boot.value, online.value)); continue }
    let directory: PinnedDirectory
    try { directory = await context.child(parent, `xpanel-${account.uid}.slice`) }
    catch (error) {
      if (errno(error) !== 'ENOENT') throw error
      accounts.push(missingAccount(account, { startedMonotonicUs, finishedMonotonicUs: monotonicUs() }, boot.value, online.value))
      continue
    }
    try {
      const accountCpu = await outcome(() => context.text(directory, 'cpu.stat'), parseCgroupCpuUsage)
      const accountMemory = await outcome(() => context.text(directory, 'memory.current'), parseCgroupInteger)
      const pids = await outcome(() => context.text(directory, 'pids.current'), parseCgroupInteger)
      const io = await outcome(() => context.text(directory, 'io.stat', RESOURCE_READER_LIMITS.ioStatBytes), parseCgroupIoCounters)
      let stable = false
      try { stable = await context.sameCanonical(parent, `xpanel-${account.uid}.slice`, directory) }
      catch (error) {
        if (errno(error) !== 'ENOENT') throw error
        accounts.push(missingAccount(account, { startedMonotonicUs, finishedMonotonicUs: monotonicUs() }, boot.value, online.value))
        continue
      }
      if (!stable) throw new ResourceCaptureError('invalid', 'account cgroup replaced during capture', true)
      await context.revalidate(directory)
      const A = RESOURCE_OBSERVATION_FIELDS.account
      const subject = {
        accountId: account.accountId, cgroupAvailability: 'present',
        readSpan: { startedMonotonicUs, finishedMonotonicUs: monotonicUs() },
        identity: { bootId: boot.value, onlineCpuIds: online.value, cgroup: { device: String(directory.device), inode: String(directory.inode) }, ioDevices: io.value?.map(value => value.device) ?? null },
        previous: baselineOf(epoch, priorAccounts.get(account.accountId)),
        fields: {
          cpuPercent: measurement(A.cpuPercent, null, 'warming-up'),
          memoryCurrentBytes: measurement(A.memoryCurrentBytes, safeInteger(accountMemory.value), accountMemory.reason ?? 'invalid'),
          pidsCurrent: measurement(A.pidsCurrent, safeInteger(pids.value), pids.reason ?? 'invalid'),
          readBytesPerSec: measurement(A.readBytesPerSec, null, 'warming-up'), writeBytesPerSec: measurement(A.writeBytesPerSec, null, 'warming-up'),
          readIops: measurement(A.readIops, null, 'warming-up'), writeIops: measurement(A.writeIops, null, 'warming-up'),
        },
      } as Mutable<AccountResourceObservation>
      const oldRaw = previous?.accounts.get(account.accountId)
      const cpuReason = boot.reason ?? online.reason ?? accountCpu.reason ?? rateReason(epoch, subject, 'cpu', oldRaw?.cpu != null)
      if (cpuReason !== null || accountCpu.value === null) subject.fields = { ...subject.fields, cpuPercent: measurement(A.cpuPercent, null, cpuReason ?? 'invalid') } as AccountResourceFields
      else {
        const rate = accountCpuRate(accountCpu.value, oldRaw!.cpu!, subject.readSpan.finishedMonotonicUs - subject.previous!.monotonicUs)
        subject.fields = { ...subject.fields, cpuPercent: measurement(A.cpuPercent, rate.value, rate.reason) } as AccountResourceFields
      }
      const ioReason = boot.reason ?? io.reason ?? rateReason(epoch, subject, 'io', oldRaw?.io != null)
      const rates = ioReason === null && io.value !== null ? ioRates(io.value, oldRaw!.io!, subject.readSpan.finishedMonotonicUs - subject.previous!.monotonicUs) : { values: null, reason: ioReason ?? 'invalid' }
      for (const [field, counter] of [['readBytesPerSec', 'rbytes'], ['writeBytesPerSec', 'wbytes'], ['readIops', 'rios'], ['writeIops', 'wios']] as const) {
        subject.fields = { ...subject.fields, [field]: measurement(A[field], rates.values?.[counter] ?? null, rates.reason) } as AccountResourceFields
      }
      accounts.push(subject)
      raw.set(account.accountId, { cpu: boot.value !== null && online.value !== null ? accountCpu.value : null, io: boot.value !== null ? io.value : null })
    } finally { await context.close(directory.handle) }
  }
  if (parent !== null) {
    await context.revalidate(parent)
    if (!await context.sameCanonical(context.cgroup, 'xpanel.slice', parent)) throw new ResourceCaptureError('invalid', 'account parent retired', true)
  }
  const finalBoot = await readBoot(context)
  const finalOnline = await outcome(() => context.text(context.cpu, 'online'), parseOnlineCpuIds)
  if (boot.value !== finalBoot.value || boot.reason !== finalBoot.reason) throw new ResourceCaptureError('invalid', 'boot source changed during capture', true)
  if (!equal(online, finalOnline)) {
    const reason = finalOnline.reason ?? online.reason ?? 'counter-reset'
    hostCounters = null
    host.identity = { ...host.identity, onlineCpuIds: null }
    host.fields = { ...host.fields, cpuBusyPercent: measurement(H.cpuBusyPercent, null, reason) } as HostResourceFields
    accounts.forEach(account => {
      account.identity = { ...account.identity, onlineCpuIds: null }
      if (account.cgroupAvailability === 'present') account.fields = { ...account.fields, cpuPercent: measurement(RESOURCE_OBSERVATION_FIELDS.account.cpuPercent, null, reason) } as AccountResourceFields
      const counters = raw.get(account.accountId)
      if (counters) raw.set(account.accountId, { ...counters, cpu: null })
    })
  }
  await context.verifyRoots()
  const finishedMonotonicUs = monotonicUs()
  if (context.aborted || finishedMonotonicUs - context.started >= RESOURCE_READER_LIMITS.captureDeadlineMs * 1_000) throw new ResourceCaptureError('invalid', 'late capture result refused', true)
  const snapshot = parseResourceObservationSnapshot({
    version: 1, observedAt: new Date().toISOString(),
    producer: { epoch, sequence, intervalMs: RESOURCE_SAMPLE_INTERVAL_MS, staleAfterMs: RESOURCE_LIVE_STALE_AFTER_MS },
    readSpan: { startedMonotonicUs: context.started, finishedMonotonicUs },
    configuration: { revision: configuration.revision, accountIds: configuration.accounts.map(account => account.accountId) },
    host, accounts, deferred: emptyDeferred(),
  })
  return { snapshot, hostCpu: hostCounters, accounts: raw }
}

export type ResourceSamplerState = 'stopped' | 'stopping' | 'not-sampled' | 'sampling' | 'ready' | 'failed' | 'blocked'
export interface ResourceSamplerReading {
  readonly state: ResourceSamplerState
  readonly failure: FailureReason | null
  readonly observation: LiveResourceObservation | null
}
let activeSampler: LinuxResourceObservationSampler | null = null

/** One explicit agent-owned sampler. Reading a cached observation never performs kernel I/O. */
export class LinuxResourceObservationSampler {
  readonly #epoch = randomUUID()
  #configuration: ResourceSamplerConfiguration
  #generation = 0
  #sequence = 0
  #running = false
  #state: ResourceSamplerState = 'stopped'
  #failure: FailureReason | null = null
  #timer: ReturnType<typeof setInterval> | null = null
  #physical: Promise<CaptureResult> | null = null
  #visible: Promise<ResourceObservationSnapshot> | null = null
  #visibleGeneration: number | null = null
  #visibleRevision: string | null = null
  #context: KernelCapture | null = null
  #uncertain: KernelCapture | null = null
  #previous: CaptureResult | null = null
  #latest: ResourceObservationSnapshot | null = null

  constructor(configuration: ResourceSamplerConfiguration) { this.#configuration = samplerConfiguration(configuration) }

  setConfiguration(configuration: ResourceSamplerConfiguration): void {
    const next = samplerConfiguration(configuration)
    if (equal(next, this.#configuration)) return
    if (next.revision === this.#configuration.revision) return refused('configuration revision reused with different account bindings')
    this.#configuration = next
    this.#generation++
    this.#previous = null
    this.#retireVisible()
    this.#context?.abort()
    if (this.#running && this.#physical === null && this.#uncertain === null) {
      this.#state = 'not-sampled'
      this.#failure = null
    }
  }

  start(): void {
    if (this.#running || this.#physical !== null || activeSampler !== null) return refused('resource sampler is already active')
    activeSampler = this
    this.#running = true
    this.#state = 'not-sampled'
    this.#timer = setInterval(() => this.#begin(), RESOURCE_SAMPLE_INTERVAL_MS)
    this.#timer.unref?.()
    this.#begin()
  }

  readLatest(): ResourceSamplerReading {
    const current = this.#latest?.configuration.revision === this.#configuration.revision ? this.#latest : null
    return {
      state: this.#state, failure: this.#failure,
      observation: current === null ? null : projectResourceObservationForLive(current, { producerEpoch: this.#epoch, monotonicUs: monotonicUs() }),
    }
  }

  /** Only the admitted, unsettled current-generation pass. Cached snapshots use readLatest(). */
  waitForCurrentCapture(): Promise<ResourceObservationSnapshot> {
    if (!this.#running || this.#physical === null || this.#visible === null
      || this.#visibleGeneration !== this.#generation || this.#visibleRevision !== this.#configuration.revision) {
      return Promise.reject(new ResourceCaptureError('missing', 'no current capture'))
    }
    return this.#visible
  }

  async stop(): Promise<void> {
    this.#running = false
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
    this.#previous = null
    this.#retireVisible()
    this.#context?.abort()
    this.#state = this.#physical === null ? 'stopped' : 'stopping'
    // May remain pending on a stuck kernel operation; no hard cancellation or quiescence claim.
    if (this.#physical !== null) await this.#physical.then(() => undefined, () => undefined)
    if (this.#uncertain !== null) {
      this.#state = 'blocked'
      throw new ResourceCaptureError('invalid', 'uncertain descriptor retirement requires process recovery', true)
    }
    if (activeSampler === this) activeSampler = null
    this.#state = 'stopped'
  }

  #retireVisible(): void {
    this.#visible = null
    this.#visibleGeneration = null
    this.#visibleRevision = null
    // Physical operation/FD/uncertain-close admission is deliberately separate.
  }

  #begin(): void {
    if (!this.#running || this.#physical !== null || this.#uncertain !== null) return // No queued/catch-up passes.
    if (this.#sequence >= Number.MAX_SAFE_INTEGER) { this.#state = 'failed'; this.#failure = 'invalid'; return }
    const generation = this.#generation, configuration = this.#configuration
    const context = new KernelCapture()
    this.#context = context
    this.#state = 'sampling'
    const physical = capture(context, configuration, this.#epoch, ++this.#sequence, this.#previous).finally(() => context.finish())
    this.#physical = physical
    this.#visibleGeneration = generation
    this.#visibleRevision = configuration.revision
    this.#visible = new Promise<ResourceObservationSnapshot>((resolve, reject) => {
      const watchdog = setTimeout(() => {
        context.abort()
        this.#previous = null
        this.#state = this.#running ? 'blocked' : 'stopping'
        this.#failure = 'invalid'
        this.#retireVisible()
        reject(new ResourceCaptureError('invalid', 'capture watchdog expired; real settlement pending', true))
      }, RESOURCE_READER_LIMITS.captureDeadlineMs)
      watchdog.unref?.()
      const finish = (): void => {
        clearTimeout(watchdog)
        this.#physical = null
        this.#context = null
        this.#retireVisible()
        if (context.cleanupUncertain || context.handles.size !== 0) {
          this.#uncertain = context
          this.#state = 'blocked'
          this.#failure = 'invalid'
          return // Keep the process-wide gate and handles alive; never retry an uncertain close.
        }
        if (!this.#running) { this.#state = 'stopped'; if (activeSampler === this) activeSampler = null }
      }
      physical.then(result => {
        // This runs after DTO validation AND actual descriptor cleanup. Timer delivery can lag.
        let publicationExpired = true
        try {
          const elapsed = monotonicUs() - context.started
          publicationExpired = elapsed < 0 || elapsed >= RESOURCE_READER_LIMITS.captureDeadlineMs * 1_000
        } catch { /* An invalid clock cannot authorize publication. */ }
        if (publicationExpired) context.abort()
        if (context.aborted || generation !== this.#generation || !this.#running) {
          this.#previous = null
          this.#state = this.#running ? 'failed' : 'stopped'
          this.#failure = 'invalid'
          reject(new ResourceCaptureError('invalid', publicationExpired ? 'late capture result refused' : 'retired capture result refused', true))
        } else {
          this.#previous = result
          this.#latest = result.snapshot
          this.#state = 'ready'
          this.#failure = null
          resolve(result.snapshot)
        }
        finish()
      }, error => {
        this.#previous = null
        this.#state = this.#running ? 'failed' : 'stopped'
        this.#failure = error instanceof ResourceCaptureError ? error.reason : 'invalid'
        reject(error instanceof ResourceCaptureError ? error : new ResourceCaptureError('invalid', 'kernel capture failed', true))
        finish()
      })
    })
    // Public callers may choose cached reads only. Handle rejection without fabricating a result.
    void this.#visible.catch(() => undefined)
  }
}
