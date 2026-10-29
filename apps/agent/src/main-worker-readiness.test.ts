import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { isXpanelError } from '@xpanel/core'

const harness = vi.hoisted(() => ({
  options: undefined as { incidentDir?: string; onRecoveryRequired?: () => void | Promise<void> } | undefined,
  factoryFatal: false,
  runnerClose: vi.fn(async (): Promise<void> => undefined),
  listenerClose: vi.fn(async (): Promise<void> => undefined),
  dbClose: vi.fn(async (): Promise<void> => undefined),
  pipelineStart: vi.fn(async (): Promise<void> => undefined),
  pipelinePause: vi.fn(async (): Promise<void> => undefined),
  pipelineStop: vi.fn(async (): Promise<void> => undefined),
  metricsStart: vi.fn(),
  metricsStop: vi.fn(async (): Promise<void> => undefined),
  recordMetrics: vi.fn(async () => undefined),
  metricOptions: undefined as { write: (observation: Record<string, number | null>, at: string) => Promise<unknown> } | undefined,
  lifecycleManaged: false,
  onFence: undefined as (() => Promise<void>) | undefined,
  writerEntries: 0,
  pipelines: 0,
  listens: 0,
  chmods: [] as Array<[string, number]>,
}))

// Exercise the actual daemon composition and lifetime; host/DB/socket boundaries
// are isolated. These tests do not qualify the Linux daemon or systemd itself.
// chmod joined the isolated boundary when the runtime directory became traverse-only 0711 (fa7748a).
vi.mock('node:fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs/promises')>(), mkdir: async () => undefined, chown: async () => undefined, chmod: async (path: string, mode: number) => { harness.chmods.push([path, mode]) } }))
vi.mock('@xpanel/db', () => ({ createDb: () => ({ db: {}, runner: {}, close: harness.dbClose }), migrate: async () => undefined, initializeOperationalMetadata: async () => undefined, recordHostMetricsSample: harness.recordMetrics }))
vi.mock('@xpanel/os', () => ({ XPANEL_FPM_SOCKET_DIR: '/run/xpanel-fpm', detectOs: async () => ({ id: 'ubuntu', versionId: '24.04', family: 'debian', paths: { nginxUser: 'nginx' } }) }))
vi.mock('@xpanel/state', () => ({ StateStore: class {} }))
vi.mock('./production-file-runner.ts', () => ({
  DEFAULT_FILE_WORKER_INCIDENT_DIR: '/var/lib/xpanel-agent/file-worker-incidents',
  createProductionAccountFileRunner: async (_binaryPath: string, options: NonNullable<typeof harness.options>) => {
    harness.options = options
    if (harness.factoryFatal) void options.onRecoveryRequired?.()
    return { close: harness.runnerClose }
  },
}))
vi.mock('./analytics.ts', () => ({
  IoAnalyticsEngine: class {}, WebsiteAnalyticsEngine: class {},
  CanonicalIoResourcePipeline: class {
    constructor() { harness.pipelines++ }
    start = harness.pipelineStart
    pause = harness.pipelinePause
    stop = harness.pipelineStop
  },
}))
vi.mock('./host-metrics.ts', () => ({ createHostMetricsCollector: (options: NonNullable<typeof harness.metricOptions>) => {
  harness.metricOptions = options
  return { start: harness.metricsStart, stop: harness.metricsStop }
} }))
// Modeled absent lifecycle namespace for composition diagnostics only. The actual
// production admission/participant producers are not replaced by runtime options.
vi.mock('../../../scripts/lifecycle-admission.mjs', () => ({
  awaitLifecycleWriterDrain: async () => undefined,
  createLifecycleBackgroundResources: <T>(callback: () => T): T => callback(),
  isLifecycleManaged: async () => harness.lifecycleManaged,
  readLifecyclePublicStatus: async () => ({ active: false, reference: null, phase: 'normal' }),
  startLifecycleWriterParticipant: async (_role: string, options: { onFence: () => Promise<void> }) => { harness.onFence = options.onFence; return { close: async () => undefined } },
  withLifecycleWriterAdmission: async <T>(callback: () => Promise<T>): Promise<T> => { harness.writerEntries++; return callback() },
}))
vi.mock('./agent-origin.ts', () => ({ syncRuntimePublicOrigin: async () => undefined }))
vi.mock('./host-access.ts', () => ({ ensureAcmeWebRoot: async () => undefined }))
vi.mock('./services/local-mail.ts', () => ({ ensureInstalledMail: async () => undefined }))
vi.mock('./services/mail-websocket.ts', () => ({ enableMailWebsocketProxy: async () => undefined }))
vi.mock('./services/opendkim-live.ts', () => ({ readOpenDkimPublished: async () => undefined, writeOpenDkimPublished: async () => undefined }))
vi.mock('./executor.ts', () => ({ createProductionHostTargetMatcher: () => ({}), LinuxHostExecutor: class {} }))
vi.mock('./reconciler.ts', () => ({ HostReconciler: class { async recoverInterruptedReconciliation() {} } }))
vi.mock('./server.ts', () => ({
  createAgentApp: () => ({}),
  listenAgentSocket: async () => { harness.listens++; return { close: harness.listenerClose } },
  loadAgentCredentialFile: async () => 'isolated-test-service-credential',
}))
vi.mock('./services/mariadb.ts', () => ({ DEFAULT_MARIADB_ADMIN_CNF: '/etc/xpanel/test.cnf', createMariaDbSqlRunner: () => async () => undefined, MariaDbServiceAdapter: class {} }))

import { AGENT_SHUTDOWN_TIMEOUT_MS, attachAgentProcessLifecycle, startAgentDaemon } from './main.ts'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalGetuid = Object.getOwnPropertyDescriptor(process, 'getuid')
const deferred = () => { let resolve!: () => void; let reject!: (error: unknown) => void; const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej }); return { promise, resolve, reject } }
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
const start = (incidentDir?: string) => startAgentDaemon({ dbPath: ':memory:', stateDir: '/lab/shared/state', socketPath: '/lab/run/agent.sock', socketGid: 42000, ...(incidentDir ? { fileWorkerIncidentDir: incidentDir } : {}) })

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' })
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 0 })
  harness.options = undefined
  harness.factoryFatal = false
  harness.listens = 0
  harness.chmods = []
  harness.pipelines = 0
  harness.runnerClose.mockReset().mockResolvedValue(undefined)
  harness.listenerClose.mockReset().mockResolvedValue(undefined)
  harness.dbClose.mockReset().mockResolvedValue(undefined)
  harness.pipelineStart.mockReset().mockResolvedValue(undefined)
  harness.pipelinePause.mockReset().mockResolvedValue(undefined)
  harness.pipelineStop.mockReset().mockResolvedValue(undefined)
  harness.metricsStart.mockReset()
  harness.metricsStop.mockReset().mockResolvedValue(undefined)
  harness.recordMetrics.mockReset().mockResolvedValue(undefined)
  harness.metricOptions = undefined
  harness.lifecycleManaged = false
  harness.onFence = undefined
  harness.writerEntries = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', originalPlatform)
  if (originalGetuid) Object.defineProperty(process, 'getuid', originalGetuid)
  else Reflect.deleteProperty(process, 'getuid')
})

describe('privileged worker readiness in actual agent composition', () => {
  it('uses the root-only persistent sibling independently of the shared state path', async () => {
    const daemon = await start()
    assert.equal(harness.options?.incidentDir, '/var/lib/xpanel-agent/file-worker-incidents')
    assert.deepEqual(harness.chmods, [['/lab/run', 0o711], ['/run/xpanel-fpm', 0o711]])
    await daemon.close()
  })

  it('passes the explicitly reviewed private operational path', async () => {
    const daemon = await start('/lab/root-private/worker-incidents')
    assert.equal(harness.options?.incidentDir, '/lab/root-private/worker-incidents')
    await daemon.close()
  })

  it('closes listener, workers and DB once for concurrent shutdown requests', async () => {
    const daemon = await start()
    const first = daemon.close()
    const second = daemon.close()
    assert.equal(first, second)
    await first
    assert.equal(harness.listenerClose.mock.calls.length, 1)
    assert.equal(harness.runnerClose.mock.calls.length, 1)
    assert.equal(harness.dbClose.mock.calls.length, 1)
    assert.equal(harness.pipelines, 1)
    assert.equal(harness.pipelineStart.mock.calls.length, 1)
    assert.equal(harness.pipelineStop.mock.calls.length, 1)
    assert.equal(harness.metricsStart.mock.calls.length, 1)
    assert.equal(harness.metricsStop.mock.calls.length, 1)
    assert.ok(harness.metricsStop.mock.invocationCallOrder[0]! < harness.dbClose.mock.invocationCallOrder[0]!)
  })

  it('drains an in-flight host sample before the database closes', async () => {
    const stopped = deferred()
    harness.metricsStop.mockImplementation(() => stopped.promise)
    const daemon = await start(), closing = daemon.close()
    await flush()
    assert.equal(harness.metricsStop.mock.calls.length, 1)
    assert.equal(harness.dbClose.mock.calls.length, 0)
    stopped.resolve(); await closing
    assert.equal(harness.dbClose.mock.calls.length, 1)
  })

  it('fences the native host collector and admits each sample through the writer boundary', async () => {
    harness.lifecycleManaged = true
    const daemon = await start(), entries = harness.writerEntries
    await harness.metricOptions!.write({ load1: 1 }, '2026-10-27T00:00:00.000Z')
    assert.equal(harness.writerEntries, entries + 1)
    assert.equal(harness.recordMetrics.mock.calls.length, 1)
    await harness.onFence!()
    assert.equal(harness.metricsStop.mock.calls.length, 1)
    assert.equal(harness.pipelinePause.mock.calls.length, 1)
    assert.ok(harness.metricsStop.mock.invocationCallOrder[0]! < harness.pipelinePause.mock.invocationCallOrder[0]!)
    await daemon.close()
  })

  it('stops IPC admission on recovery failure without awaiting its reporting operation', async () => {
    const operation = deferred()
    harness.runnerClose.mockImplementation(() => operation.promise)
    const daemon = await start()
    assert.equal(harness.options?.onRecoveryRequired?.(), undefined)
    assert.equal(harness.options?.onRecoveryRequired?.(), undefined)
    await flush()
    assert.equal(harness.listenerClose.mock.calls.length, 1)
    assert.equal(harness.runnerClose.mock.calls.length, 1)
    await daemon.recoveryRequired
    operation.resolve()
    await daemon.close()
    assert.equal(harness.dbClose.mock.calls.length, 1)
  })

  it('refuses startup if readiness fails before IPC admission', async () => {
    harness.factoryFatal = true
    await assert.rejects(() => start(), (error) => isXpanelError(error) && error.code === 'PRECONDITION_FAILED')
    assert.equal(harness.listens, 0)
    assert.equal(harness.runnerClose.mock.calls.length, 1)
    assert.equal(harness.dbClose.mock.calls.length, 1)
  })

  it('never reports a clean close when privileged worker recovery is unresolved', async () => {
    harness.runnerClose.mockRejectedValue(new Error('inspected recovery required'))
    const daemon = await start()
    harness.options?.onRecoveryRequired?.()
    await daemon.recoveryRequired
    await assert.rejects(() => daemon.close(), AggregateError)
    assert.equal(harness.listenerClose.mock.calls.length, 1)
    assert.equal(harness.dbClose.mock.calls.length, 1)
  })
})

const processHarness = () => {
  const signals = new Map<string, () => void>()
  const exitCodes: number[] = []
  const originalOnce = process.once.bind(process)
  vi.spyOn(process, 'once').mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
    if (event === 'SIGINT' || event === 'SIGTERM') signals.set(event, listener)
    else originalOnce(event, listener)
    return process
  }) as typeof process.once)
  vi.spyOn(process, 'exit').mockImplementation((code) => { exitCodes.push(Number(code)); return undefined as never })
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return { signals, exitCodes, stderr }
}

describe('standalone agent process recovery lifetime', () => {
  it('waits for cleanup then exits 1 for a fatal readiness signal, even when close resolves', async () => {
    const processState = processHarness()
    const recovery = deferred()
    const closed = deferred()
    const close = vi.fn(() => closed.promise)
    attachAgentProcessLifecycle({ close, recoveryRequired: recovery.promise })
    recovery.resolve()
    await flush()
    assert.equal(close.mock.calls.length, 1)
    assert.deepEqual(processState.exitCodes, [])
    closed.resolve()
    await flush()
    assert.deepEqual(processState.exitCodes, [1])
    assert.equal(processState.stderr.mock.calls.length, 1)
  })

  it('uses nonzero exit for unresolved cleanup during ordinary SIGTERM', async () => {
    const processState = processHarness()
    const close = vi.fn(async () => { throw new Error('unknown cleanup') })
    attachAgentProcessLifecycle({ close, recoveryRequired: deferred().promise })
    processState.signals.get('SIGTERM')!()
    await flush()
    assert.deepEqual(processState.exitCodes, [1])
    assert.equal(close.mock.calls.length, 1)
  })

  it('uses one bounded shutdown for repeated signals and exits 0 only after clean ordinary close', async () => {
    const processState = processHarness()
    const close = vi.fn(async (): Promise<void> => undefined)
    attachAgentProcessLifecycle({ close, recoveryRequired: deferred().promise })
    processState.signals.get('SIGTERM')!()
    processState.signals.get('SIGINT')!()
    await flush()
    assert.equal(close.mock.calls.length, 1)
    assert.deepEqual(processState.exitCodes, [0])
  })

  it('exits 1 after the explicit shutdown deadline instead of silently abandoning a hung close', async () => {
    vi.useFakeTimers()
    const processState = processHarness()
    const close = vi.fn(() => deferred().promise)
    attachAgentProcessLifecycle({ close, recoveryRequired: deferred().promise })
    processState.signals.get('SIGTERM')!()
    await vi.advanceTimersByTimeAsync(AGENT_SHUTDOWN_TIMEOUT_MS)
    assert.deepEqual(processState.exitCodes, [1])
    assert.equal(processState.stderr.mock.calls.length, 1)
  })
})
