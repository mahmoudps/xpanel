import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { posix } from 'node:path'

const ports = vi.hoisted(() => ({
  nowUs: 10_000_000, open: vi.fn(), statfs: vi.fn(), readlink: vi.fn(),
}))
vi.mock('node:fs/promises', () => ({ open: ports.open, statfs: ports.statfs, readlink: ports.readlink }))
vi.mock('node:process', async importOriginal => ({
  ...await importOriginal<typeof import('node:process')>(), platform: 'linux', pid: 4_321,
  geteuid: () => 0, hrtime: { bigint: () => BigInt(ports.nowUs) * 1_000n },
}))
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, constants: { ...original.constants, O_RDONLY: 0, O_DIRECTORY: 65_536, O_NOFOLLOW: 131_072, O_NONBLOCK: 2_048 } }
})

type Module = typeof import('./resource-observations.ts')
type Sampler = InstanceType<Module['LinuxResourceObservationSampler']>
type NodeEntry = { kind: 'dir' | 'file' | 'fifo' | 'symlink'; ino: bigint; dev: bigint; magic: bigint; data: Buffer; uid: bigint; mode: bigint; nlink: bigint }
type DiagnosticHandle = { fd: number; path: string; entry: NodeEntry; offset: number; closed: boolean; pending: boolean }
const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const ACCOUNT2 = '22222222-2222-4222-8222-222222222222'
const BOOT = '33333333-3333-4333-8333-333333333333'
const REVISION = 'a'.repeat(64)
const configuration = () => ({ revision: REVISION, accounts: [{ accountId: ACCOUNT, uid: 20_001 }] })
const procStat = (user = 100, idle = 800, guest = 0) => `cpu ${user} 0 100 ${idle} 0 0 0 0 ${guest} 0\ncpu0 1 0 1 1 0 0 0 0 0 0\ncpu1 1 0 1 1 0 0 0 0 0 0\nintr 1 2 3\n`
const ioStat = (rbytes = 100, wbytes = 200, rios = 4, wios = 2) => `8:0 rbytes=${rbytes} wbytes=${wbytes} rios=${rios} wios=${wios} dbytes=0 dios=0\n`
const sourcePath = '/sys/fs/cgroup/xpanel.slice/xpanel-20001.slice'

/** Scoped diagnostic kernel/file-handle model. It never enters production imports or host qualification. */
class KernelFixture {
  readonly nodes = new Map<string, NodeEntry>()
  readonly handles = new Map<number, DiagnosticHandle>()
  readonly log: { op: string; path: string; fd?: number; flags?: number; bytes?: number; pending?: boolean }[] = []
  nextFd = 3
  peak = 0
  readBytes = 0
  readHook: ((handle: DiagnosticHandle, buffer: Buffer, length: number) => Promise<{ bytesRead: number; buffer: Buffer }> | null) | null = null
  statHook: ((handle: DiagnosticHandle) => void) | null = null
  closeHook: ((handle: DiagnosticHandle) => void | Promise<void>) | null = null
  constructor() {
    this.dir('/', 1n, 1n, 0n)
    for (const path of ['/proc', '/proc/4321', '/proc/4321/fd', '/proc/sys', '/proc/sys/kernel', '/proc/sys/kernel/random', '/proc/pressure']) this.dir(path, 2n, BigInt(this.nodes.size + 1), 0x9fa0n)
    for (const path of ['/sys', '/sys/devices', '/sys/devices/system', '/sys/devices/system/cpu', '/sys/fs']) this.dir(path, 3n, BigInt(this.nodes.size + 1), 0x62656572n)
    this.dir('/sys/fs/cgroup', 4n, 30n, 0x63677270n)
    this.dir('/sys/fs/cgroup/xpanel.slice', 4n, 31n, 0x63677270n)
    this.file('/proc/sys/kernel/random/boot_id', `${BOOT}\n`, 2n, 0x9fa0n)
    this.file('/sys/devices/system/cpu/online', '0-1\n', 3n, 0x62656572n)
    this.file('/proc/stat', procStat(), 2n, 0x9fa0n)
    this.file('/proc/meminfo', 'MemTotal: 8192 kB\nMemAvailable: 6144 kB\nHugePages_Total: 0\n', 2n, 0x9fa0n)
    this.file('/proc/loadavg', '0.25 0.20 0.10 1/100 4321\n', 2n, 0x9fa0n)
    this.file('/proc/pressure/io', 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n', 2n, 0x9fa0n)
    this.account(20_001, 100n)
  }
  dir(path: string, dev: bigint, ino: bigint, magic: bigint): void { this.nodes.set(path, { kind: 'dir', dev, ino, magic, data: Buffer.alloc(0), uid: 0n, mode: 0o755n, nlink: 2n }) }
  file(path: string, data: string | Buffer, dev: bigint, magic: bigint): void { this.nodes.set(path, { kind: 'file', dev, ino: BigInt(this.nodes.size + 1_000), magic, data: Buffer.isBuffer(data) ? data : Buffer.from(data), uid: 0n, mode: 0o444n, nlink: 1n }) }
  account(uid: number, inode: bigint): void {
    const path = `/sys/fs/cgroup/xpanel.slice/xpanel-${uid}.slice`
    this.dir(path, 4n, inode, 0x63677270n)
    this.file(`${path}/cpu.stat`, 'usage_usec 1000000\nuser_usec 900000\nsystem_usec 100000\n', 4n, 0x63677270n)
    this.file(`${path}/memory.current`, '4096\n', 4n, 0x63677270n)
    this.file(`${path}/pids.current`, '3\n', 4n, 0x63677270n)
    this.file(`${path}/io.stat`, ioStat(), 4n, 0x63677270n)
  }
  set(path: string, data: string | Buffer): void { this.nodes.get(path)!.data = Buffer.isBuffer(data) ? data : Buffer.from(data) }
  resolve(path: string): { path: string; entry: NodeEntry } {
    const match = /^\/proc\/4321\/fd\/(\d+)(?:\/([^/]+))?$/.exec(path)
    if (match) {
      const handle = this.handles.get(Number(match[1]))
      if (!handle || handle.closed) throw Object.assign(new Error('retired FD'), { code: 'ENOENT' })
      if (match[2] === undefined) return { path: handle.path, entry: handle.entry }
      path = posix.join(handle.path, match[2])
    }
    const entry = this.nodes.get(path)
    if (!entry) throw Object.assign(new Error('absent fixture entry'), { code: 'ENOENT' })
    return { path, entry }
  }
  install(): void {
    ports.readlink.mockImplementation(async (path: string) => { this.log.push({ op: 'readlink', path }); ports.nowUs += 10; return '4321' })
    ports.statfs.mockImplementation(async (path: string) => { this.log.push({ op: 'statfs', path }); ports.nowUs += 10; return { type: this.resolve(path).entry.magic } })
    ports.open.mockImplementation(async (path: string, flags: number) => {
      this.log.push({ op: 'open', path, flags }); ports.nowUs += 10
      const target = this.resolve(path)
      if (target.entry.kind === 'symlink') throw Object.assign(new Error('symlink'), { code: 'ELOOP' })
      if ((flags & 65_536) && target.entry.kind !== 'dir') throw Object.assign(new Error('not directory'), { code: 'ENOTDIR' })
      const handle: DiagnosticHandle = { fd: this.nextFd++, ...target, offset: 0, closed: false, pending: false }
      this.handles.set(handle.fd, handle)
      this.peak = Math.max(this.peak, [...this.handles.values()].filter(value => !value.closed).length)
      return {
        get fd() { return handle.closed ? -1 : handle.fd },
        stat: async () => {
          this.log.push({ op: 'stat', path: handle.path, fd: handle.fd }); ports.nowUs += 10; this.statHook?.(handle)
          return { ...handle.entry, size: 0n, isFile: () => handle.entry.kind === 'file', isDirectory: () => handle.entry.kind === 'dir' }
        },
        read: async (buffer: Buffer, offset: number, length: number) => {
          this.log.push({ op: 'read', path: handle.path, fd: handle.fd, bytes: length }); ports.nowUs += 10
          const hooked = this.readHook?.(handle, buffer, length)
          if (hooked) return await hooked
          const bytesRead = Math.min(length, handle.entry.data.length - handle.offset)
          handle.entry.data.copy(buffer, offset, handle.offset, handle.offset + bytesRead)
          handle.offset += bytesRead; this.readBytes += bytesRead
          return { bytesRead, buffer }
        },
        close: async () => {
          this.log.push({ op: 'close', path: handle.path, fd: handle.fd, pending: handle.pending }); ports.nowUs += 10
          await this.closeHook?.(handle); handle.closed = true
        },
      }
    })
  }
}

let mod: Module, fixture: KernelFixture
const samplers: Sampler[] = []
const sampler = (config = configuration()): Sampler => {
  const value = new mod.LinuxResourceObservationSampler(config); samplers.push(value); return value
}
const flush = async (condition: () => boolean): Promise<void> => {
  for (let count = 0; count < 4_000 && !condition(); count++) await Promise.resolve()
  expect(condition()).toBe(true)
}
const next = async (value: Sampler) => {
  ports.nowUs += 5_000_000
  vi.advanceTimersByTime(5_000)
  // Capture the actually admitted promise before its asynchronous physical settlement.
  return await value.waitForCurrentCapture()
}

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T06:00:00.000Z'))
  ports.nowUs = 10_000_000; ports.open.mockReset(); ports.statfs.mockReset(); ports.readlink.mockReset()
  fixture = new KernelFixture(); fixture.install(); mod = await import('./resource-observations.ts')
})
afterEach(async () => {
  for (const value of samplers.splice(0)) await value.stop().catch(() => undefined)
  vi.clearAllTimers(); vi.useRealTimers()
})

describe('strict kernel text diagnostics', () => {
  it('parses real units and unsigned counters without converting cumulative counts to rates', () => {
    expect(mod.parseProcMemory('MemTotal: 8192 kB\nMemAvailable: 6144 kB\n')).toEqual({ totalKiB: 8192n, availableKiB: 6144n })
    expect(mod.parseOnlineCpuIds('0-2,4,7-8\n')).toEqual([0, 1, 2, 4, 7, 8])
    expect(mod.parseCgroupCpuUsage('usage_usec 18446744073709551615\n')).toBe(18_446_744_073_709_551_615n)
    expect(mod.parseCgroupIoCounters('')).toEqual([])
    expect(mod.parseCgroupIoCounters(ioStat())[0]).toEqual({ device: '8:0', rbytes: 100n, wbytes: 200n, rios: 4n, wios: 2n })
    expect(mod.parseProcLoad('0.25 0.20 0.10 1/100 4321\n')).toBe(0.25)
    expect(mod.parseIoPressure('some avg10=1.25 avg60=0.00 avg300=0.00 total=123\n')).toEqual({ some: 1.25, full: null })
  })

  it('excludes guest counters from the host total without changing user/nice', () => {
    expect(mod.parseProcCpuCounters(procStat(100, 800, 90)).counters).toEqual([100n, 0n, 100n, 800n, 0n, 0n, 0n, 0n])
  })

  it.each(['0-8192\n', '0-2,2\n', '2-0\n', '01\n', '4294967296\n', '0,,1\n', '0\n1\n', ''])('rejects invalid/oversized CPU set %j', input => {
    expect(() => mod.parseOnlineCpuIds(input)).toThrow(mod.ResourceCaptureError)
  })

  it.each(['-1\n', '1.5\n', 'max\n', '01\n', '18446744073709551616\n', '1\n2\n', '1\0\n'])('rejects malformed cgroup integer %j', input => {
    expect(() => mod.parseCgroupInteger(input)).toThrow(mod.ResourceCaptureError)
  })

  it.each([
    ['CPU duplicate', () => mod.parseCgroupCpuUsage('usage_usec 1\nusage_usec 2\n')],
    ['CPU missing', () => mod.parseCgroupCpuUsage('user_usec 1\n')],
    ['IO missing operations', () => mod.parseCgroupIoCounters('8:0 rbytes=1 wbytes=2\n')],
    ['IO duplicate device', () => mod.parseCgroupIoCounters(ioStat() + ioStat())],
    ['IO duplicate counter', () => mod.parseCgroupIoCounters(ioStat().trim() + ' rios=3\n')],
    ['IO oversized device', () => mod.parseCgroupIoCounters('10000000000:0 rbytes=1 wbytes=2 rios=1 wios=1\n')],
    ['IO U32 overflow', () => mod.parseCgroupIoCounters('4294967296:0 rbytes=1 wbytes=2 rios=1 wios=1\n')],
    ['memory unit', () => mod.parseProcMemory('MemTotal: 8 MB\n')],
    ['memory duplicate', () => mod.parseProcMemory('MemTotal: 8 kB\nMemTotal: 9 kB\n')],
    ['load task mismatch', () => mod.parseProcLoad('0.0 0.0 0.0 2/1 5\n')],
    ['PSI above100', () => mod.parseIoPressure('some avg10=100.01 avg60=0 avg300=0 total=0\n')],
    ['PSI duplicate', () => mod.parseIoPressure('some avg10=0 avg60=0 avg300=0 total=0\nsome avg10=0 avg60=0 avg300=0 total=0\n')],
  ] as const)('rejects %s without a zero fallback', (_name, run) => expect(run).toThrow(mod.ResourceCaptureError))
})

describe('bounded real-reader call flow with diagnostic filesystem', () => {
  it('takes no I/O in the constructor and retains absolute values while first rates warm up', async () => {
    const value = sampler()
    expect(fixture.log).toHaveLength(0)
    expect(value.readLatest().observation).toBeNull()
    value.start()
    const result = await value.waitForCurrentCapture()
    expect(result.host.fields.memoryTotalBytes.value).toBe(8_388_608)
    expect(result.host.fields.memoryUsedBytes.value).toBe(2_097_152)
    expect(result.host.fields.cpuBusyPercent).toMatchObject({ value: null, availability: 'warming-up' })
    expect(result.accounts[0]!.fields.cpuPercent).toMatchObject({ value: null, availability: 'warming-up' })
    expect(result.accounts[0]!.fields.memoryCurrentBytes.value).toBe(4_096)
    expect(result.accounts[0]!.fields.pidsCurrent.value).toBe(3)
    expect(result.accounts[0]!.fields.readIops.value).toBeNull()
    expect(Object.values(result.deferred).every(field => field.value === null && field.availability === 'unsupported')).toBe(true)
    expect(fixture.peak).toBeLessThanOrEqual(mod.RESOURCE_READER_LIMITS.openHandles)
    expect([...fixture.handles.values()].every(handle => handle.closed)).toBe(true)
    expect(fixture.log.filter(entry => entry.op === 'open').every(entry => (entry.flags! & 131_072) !== 0 && (entry.flags! & 2_048) !== 0)).toBe(true)
  })

  it('uses actual subject intervals, real operations and unclipped account CPU above100', async () => {
    const value = sampler(); value.start(); const first = await value.waitForCurrentCapture()
    fixture.set(`${sourcePath}/cpu.stat`, 'usage_usec 9000000\n')
    fixture.set(`${sourcePath}/io.stat`, ioStat(5_100, 10_200, 14, 7))
    fixture.set('/proc/stat', procStat(200, 900, 90))
    const second = await next(value)
    const interval = second.accounts[0]!.readSpan.finishedMonotonicUs - first.accounts[0]!.readSpan.finishedMonotonicUs
    expect(interval).not.toBe(5_000_000)
    expect(second.accounts[0]!.fields.cpuPercent.value).toBe(8_000_000 / interval * 100)
    expect(second.accounts[0]!.fields.cpuPercent.value).toBeGreaterThan(100)
    expect(second.accounts[0]!.fields.readBytesPerSec.value).toBe(5_000 / interval * 1_000_000)
    expect(second.accounts[0]!.fields.readIops.value).toBe(10 / interval * 1_000_000)
    expect(second.host.fields.cpuBusyPercent.value).toBe(50)
    expect(second.accounts[0]!.previous!.monotonicUs).toBe(first.accounts[0]!.readSpan.finishedMonotonicUs)
    expect(second.accounts[0]!.readSpan.startedMonotonicUs).toBe(second.host.readSpan.startedMonotonicUs)
  })

  it('keeps observed zero after a valid unchanged-counter interval', async () => {
    const value = sampler(); value.start(); await value.waitForCurrentCapture()
    const result = await next(value)
    expect(result.accounts[0]!.fields.cpuPercent).toMatchObject({ value: 0, availability: 'known' })
    expect(result.accounts[0]!.fields.readBytesPerSec).toMatchObject({ value: 0, availability: 'known' })
    expect(result.accounts[0]!.fields.readIops).toMatchObject({ value: 0, availability: 'known' })
    expect(result.host.fields.cpuBusyPercent).toMatchObject({ value: null, availability: 'not-sampled' })
  })

  it('does not issue per-consumer reads or reset the shared baseline', async () => {
    const value = sampler(); value.start()
    expect(value.waitForCurrentCapture()).toBe(value.waitForCurrentCapture())
    await value.waitForCurrentCapture(); const before = fixture.log.length
    const views = await Promise.all(Array.from({ length: 64 }, async () => value.readLatest()))
    expect(fixture.log).toHaveLength(before)
    expect(new Set(views.map(view => view.observation!.snapshot.producer.sequence))).toEqual(new Set([1]))
    expect(() => sampler().start()).toThrow('already active')
    expect(fixture.log).toHaveLength(before)
  })

  it('rejects oversized configuration and invalid/repeated UIDs before any kernel effect', () => {
    const oversized = new Proxy(new Array(257), { ownKeys() { throw new Error('must not enumerate oversized config') } })
    expect(() => sampler({ revision: REVISION, accounts: oversized })).toThrow(mod.ResourceCaptureError)
    for (const uid of [0, 999, 60_001, 20_001.5, Number.NaN]) expect(() => sampler({ revision: REVISION, accounts: [{ accountId: ACCOUNT, uid }] })).toThrow(mod.ResourceCaptureError)
    expect(() => sampler({ revision: REVISION, accounts: [{ accountId: ACCOUNT, uid: 20_001 }, { accountId: ACCOUNT2, uid: 20_001 }] })).toThrow(mod.ResourceCaptureError)
    expect(fixture.log).toHaveLength(0)
  })

  it('keeps actual absent cgroups in the full configured snapshot with no baseline or manufactured0', async () => {
    const value = sampler({ revision: REVISION, accounts: [{ accountId: ACCOUNT, uid: 20_001 }, { accountId: ACCOUNT2, uid: 20_002 }] })
    value.start(); const result = await value.waitForCurrentCapture()
    const absent = result.accounts.find(account => account.accountId === ACCOUNT2)!
    expect(absent.cgroupAvailability).toBe('missing')
    expect(absent.previous).toBeNull()
    expect(Object.values(absent.fields).every(field => field.value === null && field.availability === 'missing')).toBe(true)
  })

  it.each(['cpu.stat', 'memory.current', 'pids.current', 'io.stat'])('keeps missing %s unavailable instead of0', async filename => {
    fixture.nodes.delete(`${sourcePath}/${filename}`)
    const value = sampler(); value.start(); const result = await value.waitForCurrentCapture()
    const field = filename === 'cpu.stat' ? 'cpuPercent' : filename === 'memory.current' ? 'memoryCurrentBytes' : filename === 'pids.current' ? 'pidsCurrent' : 'readIops'
    expect(result.accounts[0]!.fields[field]).toMatchObject({ value: null, availability: 'missing' })
  })

  it('rejects untrusted sysfs and a wrong own-proc namespace before account reads', async () => {
    fixture.nodes.get('/sys')!.magic = 0x9fa0n
    const value = sampler(); value.start()
    await expect(value.waitForCurrentCapture()).rejects.toThrow('filesystem')
    expect(fixture.log.some(entry => entry.path.includes('xpanel-20001'))).toBe(false)
    await value.stop()
    fixture.install(); ports.readlink.mockResolvedValue('99')
    const second = sampler(); second.start()
    await expect(second.waitForCurrentCapture()).rejects.toThrow('namespace')
  })
})

describe('rate reset, identity and configuration cutover diagnostics', () => {
  it('rejects a non-positive global interval before starting another kernel read set', async () => {
    const value = sampler(); value.start(); const first = await value.waitForCurrentCapture()
    const before = fixture.log.length
    ports.nowUs = first.readSpan.finishedMonotonicUs
    vi.advanceTimersByTime(5_000)
    await expect(value.waitForCurrentCapture()).rejects.toThrow('non-positive capture interval')
    expect(fixture.log).toHaveLength(before)
    expect(value.readLatest().state).toBe('failed')
  })

  it('clears a decreased CPU/IO baseline and recovers from the new actual counters', async () => {
    const value = sampler(); value.start(); await value.waitForCurrentCapture()
    fixture.set(`${sourcePath}/cpu.stat`, 'usage_usec 1\n')
    fixture.set(`${sourcePath}/io.stat`, ioStat(1, 1, 1, 1))
    const reset = await next(value)
    expect(reset.accounts[0]!.fields.cpuPercent).toMatchObject({ value: null, availability: 'counter-reset' })
    expect(reset.accounts[0]!.fields.readBytesPerSec).toMatchObject({ value: null, availability: 'counter-reset' })
    expect(reset.accounts[0]!.fields.memoryCurrentBytes.value).toBe(4_096)
    const recovered = await next(value)
    expect(recovered.accounts[0]!.fields.cpuPercent).toMatchObject({ value: 0, availability: 'known' })
    expect(recovered.accounts[0]!.fields.readIops).toMatchObject({ value: 0, availability: 'known' })
  })

  it('does not bridge a missing counter interval and keeps independent absolute data', async () => {
    const value = sampler(); value.start(); await value.waitForCurrentCapture()
    const saved = fixture.nodes.get(`${sourcePath}/cpu.stat`)!
    fixture.nodes.delete(`${sourcePath}/cpu.stat`)
    const missing = await next(value)
    expect(missing.accounts[0]!.fields.cpuPercent).toMatchObject({ value: null, availability: 'missing' })
    expect(missing.accounts[0]!.fields.readIops).toMatchObject({ value: 0, availability: 'known' })
    fixture.nodes.set(`${sourcePath}/cpu.stat`, saved)
    const prime = await next(value)
    expect(prime.accounts[0]!.fields.cpuPercent).toMatchObject({ value: null, availability: 'warming-up' })
    expect((await next(value)).accounts[0]!.fields.cpuPercent).toMatchObject({ value: 0, availability: 'known' })
  })

  it('handles an actually empty IO device set as warm-up then measured zero', async () => {
    fixture.set(`${sourcePath}/io.stat`, '')
    const value = sampler(); value.start(); const first = await value.waitForCurrentCapture()
    expect(first.accounts[0]!.identity.ioDevices).toEqual([])
    expect(first.accounts[0]!.fields.readIops.value).toBeNull()
    expect((await next(value)).accounts[0]!.fields.readIops).toMatchObject({ value: 0, availability: 'known' })
  })

  it('invalidates changed device identity independently of CPU', async () => {
    const value = sampler(); value.start(); await value.waitForCurrentCapture()
    fixture.set(`${sourcePath}/io.stat`, ioStat().replace('8:0', '8:1'))
    const result = await next(value)
    expect(result.accounts[0]!.fields.readIops).toMatchObject({ value: null, availability: 'counter-reset' })
    expect(result.accounts[0]!.fields.cpuPercent).toMatchObject({ value: 0, availability: 'known' })
  })

  it('invalidates boot/cgroup identities between frames without inferring a continuous rate', async () => {
    const value = sampler(); value.start(); await value.waitForCurrentCapture()
    fixture.set('/proc/sys/kernel/random/boot_id', '44444444-4444-4444-8444-444444444444\n')
    fixture.nodes.get(sourcePath)!.ino = 101n
    const result = await next(value)
    expect(result.accounts[0]!.fields.cpuPercent).toMatchObject({ value: null, availability: 'counter-reset' })
    expect(result.accounts[0]!.fields.readBytesPerSec).toMatchObject({ value: null, availability: 'counter-reset' })
    expect(result.host.fields.cpuBusyPercent).toMatchObject({ value: null, availability: 'counter-reset' })
  })

  it('rejects replacement of a cgroup during its read set, with no partial current snapshot', async () => {
    fixture.statHook = handle => {
      if (handle.path === `${sourcePath}/io.stat`) fixture.nodes.set(sourcePath, { ...fixture.nodes.get(sourcePath)!, ino: 999n })
    }
    const value = sampler(); value.start()
    await expect(value.waitForCurrentCapture()).rejects.toThrow('replaced')
    expect(value.readLatest().observation).toBeNull()
    expect([...fixture.handles.values()].every(handle => handle.closed)).toBe(true)
  })

  it('retains disappeared cgroups with cleared baselines after a completed read set', async () => {
    fixture.statHook = handle => { if (handle.path === `${sourcePath}/io.stat`) fixture.nodes.delete(sourcePath) }
    const value = sampler(); value.start(); const result = await value.waitForCurrentCapture()
    expect(result.accounts[0]!.cgroupAvailability).toBe('missing')
    expect(result.accounts[0]!.previous).toBeNull()
    expect(Object.values(result.accounts[0]!.fields).every(field => field.value === null && field.availability === 'missing')).toBe(true)
  })

  it('removes deleted accounts from current views immediately on configuration cutover while history remains immutable', async () => {
    const value = sampler(); value.start(); const historical = await value.waitForCurrentCapture()
    value.setConfiguration({ revision: 'b'.repeat(64), accounts: [] })
    expect(value.readLatest().observation).toBeNull()
    expect(value.readLatest().state).toBe('not-sampled')
    const current = await next(value)
    expect(current.accounts).toEqual([])
    expect(historical.accounts[0]!.accountId).toBe(ACCOUNT)
    expect(Object.isFrozen(historical.accounts[0]!.fields)).toBe(true)
    expect(() => value.setConfiguration({ revision: 'b'.repeat(64), accounts: configuration().accounts })).toThrow('revision reused')
  })

  it.each(['symlink', 'fifo'] as const)('refuses a%s final metric file without reading it', async kind => {
    fixture.nodes.get(`${sourcePath}/memory.current`)!.kind = kind
    const value = sampler(); value.start(); const result = await value.waitForCurrentCapture()
    expect(result.accounts[0]!.fields.memoryCurrentBytes).toMatchObject({ value: null, availability: 'invalid' })
    expect(fixture.log.some(entry => entry.op === 'read' && entry.path === `${sourcePath}/memory.current`)).toBe(false)
  })

  it('rejects an untrusted account directory rather than calling it missing', async () => {
    fixture.nodes.get(sourcePath)!.uid = 20_001n
    const value = sampler(); value.start()
    await expect(value.waitForCurrentCapture()).rejects.toThrow('untrusted kernel directory')
    expect(value.readLatest().observation).toBeNull()
    expect(fixture.log.some(entry => entry.op === 'read' && entry.path.startsWith(sourcePath))).toBe(false)
  })

  it('keeps malformed and overflowing memory unavailable instead of manufacturing0', async () => {
    fixture.set(`${sourcePath}/memory.current`, '18446744073709551615\n')
    fixture.set(`${sourcePath}/pids.current`, 'broken\n')
    const value = sampler(); value.start(); const result = await value.waitForCurrentCapture()
    expect(result.accounts[0]!.fields.memoryCurrentBytes).toMatchObject({ value: null, availability: 'invalid' })
    expect(result.accounts[0]!.fields.pidsCurrent).toMatchObject({ value: null, availability: 'invalid' })
  })

  it('invalidates CPU when online evidence changes inside a frame while retaining independent IO', async () => {
    const value = sampler(); value.start(); await value.waitForCurrentCapture()
    let checks = 0
    fixture.statHook = handle => {
      if (handle.path === '/sys/devices/system/cpu/online' && ++checks === 3) fixture.set(handle.path, '0-2\n')
    }
    const result = await next(value)
    expect(result.host.fields.cpuBusyPercent).toMatchObject({ value: null, availability: 'counter-reset' })
    expect(result.accounts[0]!.identity.onlineCpuIds).toBeNull()
    expect(result.accounts[0]!.fields.cpuPercent).toMatchObject({ value: null, availability: 'counter-reset' })
    expect(result.accounts[0]!.fields.readIops).toMatchObject({ value: 0, availability: 'known' })
  })

  it('rejects boot evidence changing during a frame without refreshing the retained original', async () => {
    const value = sampler(); value.start(); const original = await value.waitForCurrentCapture()
    let checks = 0
    fixture.statHook = handle => {
      if (handle.path === '/proc/sys/kernel/random/boot_id' && ++checks === 3) fixture.set(handle.path, '44444444-4444-4444-8444-444444444444\n')
    }
    await expect(next(value)).rejects.toThrow('boot source changed')
    expect(value.readLatest().observation!.snapshot.observedAt).toBe(original.observedAt)
    expect(value.readLatest().observation!.snapshot.producer.sequence).toBe(original.producer.sequence)
  })

  it('rejects a metric whose ownership changes while reading instead of accepting it as known', async () => {
    fixture.readHook = handle => { if (handle.path === `${sourcePath}/memory.current`) handle.entry.uid = 20_001n; return null }
    const value = sampler(); value.start(); const result = await value.waitForCurrentCapture()
    expect(result.accounts[0]!.fields.memoryCurrentBytes).toMatchObject({ value: null, availability: 'invalid' })
  })

  it.each(['/sys', '/proc/4321/fd'])('rejects canonical%s retirement around the read set', async path => {
    fixture.statHook = handle => { if (handle.path === `${sourcePath}/io.stat`) fixture.nodes.set(path, { ...fixture.nodes.get(path)!, ino: 999_999n }) }
    const value = sampler(); value.start()
    await expect(value.waitForCurrentCapture()).rejects.toThrow('retired')
    expect(value.readLatest().observation).toBeNull()
    expect([...fixture.handles.values()].every(handle => handle.closed)).toBe(true)
  })
})

describe('watchdog, retirement and workload backpressure diagnostics', () => {
  it('rejects a result crossing the final monotonic deadline even without watchdog timer delivery', async () => {
    fixture.closeHook = handle => { if (handle.path === '/') ports.nowUs += 2_000_000 }
    const value = sampler(); value.start()
    await expect(value.waitForCurrentCapture()).rejects.toThrow('late capture result refused')
    expect(value.readLatest().observation).toBeNull()
    expect([...fixture.handles.values()].every(handle => handle.closed)).toBe(true)
    fixture.closeHook = null
    const recovered = await next(value)
    expect(recovered.accounts[0]!.fields.cpuPercent).toMatchObject({ value: null, availability: 'warming-up' })
  })

  it('retires a settled accessor while preserving the separate cached snapshot API', async () => {
    const value = sampler(); value.start(); const original = await value.waitForCurrentCapture()
    const before = fixture.log.length
    await expect(value.waitForCurrentCapture()).rejects.toThrow('no current capture')
    expect(value.readLatest().observation!.snapshot.observedAt).toBe(original.observedAt)
    expect(fixture.log).toHaveLength(before)
  })

  it('does not replay settled cohort A after configuration B before the next timer tick', async () => {
    const value = sampler(); value.start(); const original = await value.waitForCurrentCapture()
    value.setConfiguration({ revision: 'b'.repeat(64), accounts: [] })
    const before = fixture.log.length
    await expect(value.waitForCurrentCapture()).rejects.toThrow('no current capture')
    expect(fixture.log).toHaveLength(before)
    expect(value.readLatest().observation).toBeNull()
    expect(original.accounts[0]!.accountId).toBe(ACCOUNT)
    expect((await next(value)).accounts).toEqual([])
  })

  it('retires a settled accessor on stop', async () => {
    const value = sampler(); value.start(); await value.waitForCurrentCapture(); await value.stop()
    await expect(value.waitForCurrentCapture()).rejects.toThrow('no current capture')
    expect(value.readLatest().state).toBe('stopped')
  })

  it.each(['configuration change', 'stop'] as const)('retires visibility on%s without releasing a pending physical FD', async action => {
    let settle: (() => void) | null = null
    let pending: DiagnosticHandle | null = null
    fixture.readHook = (handle, buffer) => {
      if (handle.path !== '/proc/stat') return null
      handle.pending = true; pending = handle
      return new Promise(resolve => { settle = () => { handle.pending = false; fixture.readHook = null; resolve({ bytesRead: 0, buffer }) } })
    }
    const value = sampler(); value.start(); const original = value.waitForCurrentCapture()
    const originalDenial = expect(original).rejects.toThrow('retired')
    await flush(() => settle !== null)
    let stopping: Promise<void> | null = null
    if (action === 'configuration change') value.setConfiguration({ revision: 'b'.repeat(64), accounts: [] })
    else stopping = value.stop()
    const before = fixture.log.length
    let accessorFailure: unknown = null
    void value.waitForCurrentCapture().catch(error => { accessorFailure = error })
    try {
      await flush(() => accessorFailure !== null)
      expect(accessorFailure).toBeInstanceOf(mod.ResourceCaptureError)
      expect((accessorFailure as Error).message).toContain('no current capture')
      expect(fixture.log).toHaveLength(before)
      expect(fixture.log.some(entry => entry.op === 'close' && entry.fd === pending!.fd)).toBe(false)
      expect(() => sampler().start()).toThrow('already active')
    } finally {
      settle!()
      await originalDenial
      if (stopping) await stopping
    }
    expect(fixture.log.filter(entry => entry.op === 'close').every(entry => entry.pending === false)).toBe(true)
    if (action === 'configuration change') expect((await next(value)).accounts).toEqual([])
  })

  it('rejects an already-built result if descriptor cleanup only settles after the watchdog', async () => {
    let settle: (() => void) | null = null
    fixture.closeHook = handle => {
      if (handle.path !== '/') return
      return new Promise<void>(resolve => { settle = resolve })
    }
    const value = sampler(); value.start()
    const denial = expect(value.waitForCurrentCapture()).rejects.toThrow('watchdog')
    await flush(() => settle !== null)
    ports.nowUs += 2_000_000; await vi.advanceTimersByTimeAsync(2_000); await denial
    expect(value.readLatest().state).toBe('blocked')
    expect(value.readLatest().observation).toBeNull()
    settle!()
    await flush(() => value.readLatest().state === 'failed')
    expect(value.readLatest().observation).toBeNull()
    expect([...fixture.handles.values()].every(handle => handle.closed)).toBe(true)
  })

  it('projects stale original readings without making cached reads trigger sampling', async () => {
    const value = sampler(); value.start(); const original = await value.waitForCurrentCapture()
    const before = fixture.log.length
    ports.nowUs = original.readSpan.finishedMonotonicUs + 15_000_000
    const current = value.readLatest()
    expect(fixture.log).toHaveLength(before)
    expect(current.observation!.freshness).toBe('stale')
    expect(current.observation!.snapshot.host.fields.memoryUsedBytes).toMatchObject({ value: null, availability: 'stale' })
    expect(current.observation!.snapshot.observedAt).toBe(original.observedAt)
    expect(original.host.fields.memoryUsedBytes.value).toBe(2_097_152)
  })

  it('keeps a pending read FD alive, blocks all new I/O after expiry and rejects its late result', async () => {
    let pending: DiagnosticHandle | null = null
    let settle: (() => void) | null = null
    fixture.readHook = (handle, buffer) => {
      if (handle.path !== '/proc/stat') return null
      handle.pending = true; pending = handle
      return new Promise(resolve => { settle = () => { handle.pending = false; fixture.readHook = null; resolve({ bytesRead: 0, buffer }) } })
    }
    const value = sampler(); value.start(); const visible = value.waitForCurrentCapture()
    const denial = expect(visible).rejects.toThrow('watchdog')
    await flush(() => pending !== null)
    ports.nowUs += 2_000_000; await vi.advanceTimersByTimeAsync(2_000); await denial
    expect(value.readLatest().state).toBe('blocked')
    const atExpiry = fixture.log.length
    ports.nowUs += 15_000_000; await vi.advanceTimersByTimeAsync(15_000)
    expect(fixture.log).toHaveLength(atExpiry)
    expect(fixture.log.some(entry => entry.op === 'close' && entry.fd === pending!.fd)).toBe(false)
    expect(() => sampler().start()).toThrow('already active')
    let stopped = false
    const stop = value.stop().then(() => { stopped = true })
    await Promise.resolve(); expect(stopped).toBe(false)
    settle!(); await stop
    expect(fixture.log.filter(entry => entry.op === 'close').every(entry => entry.pending === false)).toBe(true)
    expect([...fixture.handles.values()].every(handle => handle.closed)).toBe(true)
    expect(value.readLatest().observation).toBeNull()
    expect(value.readLatest().state).toBe('stopped')
  })

  it('latches uncertain close failure without retrying or releasing admission to another sampler', async () => {
    fixture.closeHook = handle => { if (handle.path === '/proc/stat') throw new Error('diagnostic close uncertainty') }
    const value = sampler(); value.start()
    await expect(value.waitForCurrentCapture()).rejects.toThrow('not proven retired')
    expect(value.readLatest().state).toBe('blocked')
    const afterFailure = fixture.log.length
    ports.nowUs += 15_000_000; await vi.advanceTimersByTimeAsync(15_000)
    expect(fixture.log).toHaveLength(afterFailure)
    expect(fixture.log.filter(entry => entry.op === 'close' && entry.path === '/proc/stat')).toHaveLength(1)
    await expect(value.stop()).rejects.toThrow('process recovery')
    expect(() => sampler().start()).toThrow('already active')
  })

  it('enforces the total byte budget before an excess read and returns no partial frame', async () => {
    const accounts = Array.from({ length: 18 }, (_, index) => ({ accountId: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`, uid: 21_000 + index }))
    const content = Buffer.alloc(mod.RESOURCE_READER_LIMITS.ioStatBytes - 1, 120)
    for (const account of accounts) {
      fixture.account(account.uid, BigInt(account.uid))
      fixture.set(`/sys/fs/cgroup/xpanel.slice/xpanel-${account.uid}.slice/io.stat`, content)
    }
    const value = sampler({ revision: REVISION, accounts }); value.start()
    await expect(value.waitForCurrentCapture()).rejects.toThrow('byte budget')
    expect(fixture.readBytes).toBeLessThanOrEqual(mod.RESOURCE_READER_LIMITS.totalBytes)
    expect(value.readLatest().observation).toBeNull()
    expect([...fixture.handles.values()].every(handle => handle.closed)).toBe(true)
  })

  it('admits the exact256account workload and preserves all rows within open/FD limits', async () => {
    const accounts = Array.from({ length: 256 }, (_, index) => ({ accountId: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`, uid: 22_000 + index }))
    for (const account of accounts) fixture.account(account.uid, BigInt(account.uid))
    const value = sampler({ revision: REVISION, accounts }); value.start()
    const result = await value.waitForCurrentCapture()
    expect(result.accounts).toHaveLength(256)
    expect(fixture.log.filter(entry => entry.op === 'open').length).toBeLessThanOrEqual(mod.RESOURCE_READER_LIMITS.fileOpens)
    expect(fixture.peak).toBeLessThanOrEqual(mod.RESOURCE_READER_LIMITS.openHandles)
    expect([...fixture.handles.values()].every(handle => handle.closed)).toBe(true)
  })
})
