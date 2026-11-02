import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { posix } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { RenderedFile } from '@xpanel/core'
import { services } from '@xpanel/render'
import type { AgentExecutor, ConfigTestResult } from '../executor.ts'
import {
  AuthoritativeDnsServiceAdapter, DEFAULT_DNS_ZONE_DIR, DEFAULT_NAMED_ZONES_CONF,
  renderNamedZonesConfig,
} from './dns.ts'

/** Generation reconciliation remains the only publication authority. This port only validates and observes. */
export interface DnsReconcileProvider {
  validate(files: readonly RenderedFile[], removedPaths: readonly string[]): Promise<void>
  verify(files: readonly RenderedFile[], removedPaths: readonly string[]): Promise<void>
}

export interface NativeDnsOptions {
  executor: AgentExecutor
  family: 'debian' | 'rhel'
  /** Trusted startup injection for portable tests; never selected by an RPC request. */
  inspectExecutable?: (path: string) => Promise<boolean>
  /** Trusted test runner; production uses owned argv-only children with a shared 60 s deadline. */
  runCommand?: (argv: string[], timeoutMs: number) => Promise<ConfigTestResult>
  clock?: () => number
  /** Exact files already owned by an accepted generation; existing unrelated data is never adopted implicitly. */
  readOwnedPaths?: () => Promise<ReadonlySet<string>>
}

const canonicalRecord = (record: services.ZoneRecord): string => JSON.stringify([record.name, record.type, record.content, record.priority, record.ttl])
const canonicalRrsets = (records: readonly services.ZoneRecord[]): string[] => {
  const ttl = new Map<string, number>()
  for (const record of records) {
    const key = `${record.name}:${record.type}`
    ttl.set(key, Math.min(ttl.get(key) ?? record.ttl, record.ttl))
  }
  return records.map(record => canonicalRecord({ ...record, ttl: ttl.get(`${record.name}:${record.type}`)! })).sort()
}
export const MAX_DNS_OBSERVATION_BYTES = 4 * 1024 * 1024
export const MAX_DNS_OBSERVATION_RECORDS = 50_000
const OBSERVATION_BUDGET_MS = 60_000

/** Only distribution-owned, non-writable executable files below protected system binary directories. */
const trustedExecutable = async (path: string): Promise<boolean> => {
  if (process.platform !== 'linux') return false
  try {
    const resolved = await realpath(path)
    if (!resolved.startsWith('/usr/bin/') && !resolved.startsWith('/usr/sbin/')) return false
    const file = await lstat(resolved)
    if (!file.isFile() || file.uid !== 0 || (file.mode & 0o022) !== 0 || (file.mode & 0o111) === 0) return false
    for (let parent = posix.dirname(resolved);; parent = posix.dirname(parent)) {
      const entry = await lstat(parent)
      if (!entry.isDirectory() || entry.uid !== 0 || (entry.mode & 0o022) !== 0) return false
      if (parent === '/') break
    }
    return true
  } catch { return false }
}

/** Read only selected effective settings; never retain or report other output, which can contain secrets. */
export const effectiveBindBackend = (text: string): boolean => {
  const selected = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(launch|bind-config|local-address|local-port)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    if (selected.has(match[1]!)) return false
    selected.set(match[1]!, match[2]!)
  }
  if (selected.get('launch') !== 'bind' || selected.get('bind-config') !== DEFAULT_NAMED_ZONES_CONF) return false
  if (selected.has('local-port') && selected.get('local-port') !== '53') return false
  const addresses = selected.get('local-address')
  return addresses === undefined || addresses.split(/[\s,]+/).some(value => ['127.0.0.1', '127.0.0.1:53', '0.0.0.0', '0.0.0.0:53'].includes(value))
}

const zoneFromPath = (path: string): string | null => {
  if (!path.endsWith('.zone')) return null
  if (!path.startsWith(DEFAULT_DNS_ZONE_DIR + '/')) fail('PRECONDITION_FAILED', 'DNS candidate uses an unsupported zone directory', { stateChanged: false })
  const zone = path.slice(DEFAULT_DNS_ZONE_DIR.length + 1, -'.zone'.length)
  if (services.normalizeZone(zone) !== zone || path !== `${DEFAULT_DNS_ZONE_DIR}/${zone}.zone`) {
    fail('VALIDATION', 'DNS candidate must use one canonical managed zone path', { stateChanged: false })
  }
  return zone
}

/** Managed catalogs contain only the exact generated primary zone/file bindings. */
const managedCatalogNames = (content: string): string[] => {
  const source = content.replace(/^\s*(?:#|\/\/).*$/gm, '').trim()
  const entry = /\s*zone\s+"([^"]+)"\s*(?:IN\s*)?\{\s*type\s+master\s*;\s*file\s+"([^"]+)"\s*;\s*\}\s*;/giy
  const names: string[] = []
  let offset = 0
  while (offset < source.length) {
    entry.lastIndex = offset
    const match = entry.exec(source)
    if (!match) return fail('PRECONDITION_FAILED', 'managed DNS catalog contains unsupported configuration', { stateChanged: false })
    const zone = services.normalizeZone(match[1])
    if (match[1] !== zone || match[2] !== `${DEFAULT_DNS_ZONE_DIR}/${zone}.zone` || names.includes(zone)) {
      fail('PRECONDITION_FAILED', 'managed DNS catalog has an unexpected zone/file binding', { stateChanged: false })
    }
    names.push(zone)
    offset = entry.lastIndex
    if (!source.slice(offset).trim()) break
  }
  return names.sort((a, b) => a.localeCompare(b))
}

const zoneCandidates = (files: readonly RenderedFile[]) => {
  const zones = files.flatMap(file => {
    const name = zoneFromPath(file.path)
    if (name === null) return []
    const parsed = services.parseBindZone(file.content, { origin: name })
    if (parsed.skipped.length > 0) fail('VALIDATION', 'DNS candidate contains records which cannot be verified', { stateChanged: false })
    const records = services.validateZone(parsed.records, { requireSoa: true })
    if (!records.some(record => record.type === 'SOA' && record.name === '@')) fail('VALIDATION', 'DNS candidate has no apex SOA', { stateChanged: false })
    return [{ name, file, records }]
  })
  if (new Set(zones.map(zone => zone.name)).size !== zones.length) fail('VALIDATION', 'duplicate DNS zone candidates', { stateChanged: false })
  const config = files.find(file => file.path === DEFAULT_NAMED_ZONES_CONF)
  if (files.filter(file => file.path === DEFAULT_NAMED_ZONES_CONF).length > 1 || zones.length > 0 && config === undefined) {
    fail('VALIDATION', 'DNS generation must contain one managed catalog for its zone files', { stateChanged: false })
  }
  if (config && JSON.stringify(managedCatalogNames(config.content)) !== JSON.stringify(zones.map(zone => zone.name).sort((a, b) => a.localeCompare(b)))) {
    fail('VALIDATION', 'DNS generation catalog differs from its managed zone files', { stateChanged: false })
  }
  if (zones.some(zone => zone.records.length > MAX_DNS_OBSERVATION_RECORDS)) {
    fail('PRECONDITION_FAILED', 'DNS candidate exceeds the bounded native observation capacity', { stateChanged: false })
  }
  return zones
}

/** Full TCP transfer requires a matching opening/closing SOA and the complete reported record count. */
export const parseObservedAxfr = (stdout: string, zone: string): services.ZoneRecord[] => {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_DNS_OBSERVATION_BYTES) fail('PRECONDITION_FAILED', 'DNS transfer exceeded the bounded observation size')
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith(';'))
  const footers = [...stdout.matchAll(/^;; XFR size: (\d+) records \(messages \d+, bytes (\d+)\)\s*$/gm)]
  if (lines.length < 2 || lines.length > MAX_DNS_OBSERVATION_RECORDS + 1 || footers.length !== 1 ||
      Number(footers[0]![1]) !== lines.length || Number(footers[0]![2]) > MAX_DNS_OBSERVATION_BYTES) {
    fail('CONFIG_TEST_FAILED', 'DNS transfer is incomplete or exceeds the observation bounds')
  }
  const opening = services.parseBindZone(lines[0]! + '\n', { origin: zone })
  const closing = services.parseBindZone(lines[lines.length - 1]! + '\n', { origin: zone })
  if (opening.skipped.length || closing.skipped.length || opening.records.length !== 1 || closing.records.length !== 1 ||
      opening.records[0]?.type !== 'SOA' || opening.records[0].name !== '@' ||
      closing.records[0]?.type !== 'SOA' || closing.records[0].name !== '@' ||
      canonicalRecord(opening.records[0]) !== canonicalRecord(closing.records[0])) {
    fail('CONFIG_TEST_FAILED', 'DNS transfer does not have a complete matching SOA envelope')
  }
  const parsed = services.parseBindZone(lines.slice(0, -1).join('\n') + '\n', { origin: zone })
  if (parsed.skipped.length > 0) fail('CONFIG_TEST_FAILED', 'DNS transfer contains unrecognized records')
  return parsed.records
}

export const createNativeDnsReconcileProvider = (options: NativeDnsOptions): DnsReconcileProvider => {
  const inspect = options.inspectExecutable ?? trustedExecutable
  const executor = options.executor
  const checkerPaths = options.family === 'rhel'
    ? ['/usr/sbin/named-checkzone', '/usr/bin/named-checkzone']
    : ['/usr/bin/named-checkzone', '/usr/sbin/named-checkzone']
  const clock = options.clock ?? Date.now
  const assertCommand = (argv: readonly string[]): void => {
    if (argv[0] === '/usr/bin/pdns_control' && argv.length === 3 && argv[1] === 'current-config' && argv[2] === 'diff') return
    if (checkerPaths.includes(argv[0]!) && argv.length === 3 && services.normalizeZone(argv[1]) === argv[1] &&
        argv[2]?.startsWith(`/var/lib/powerdns/staging/${argv[1]}.zone.`) && /^[a-f0-9-]{36}\.stage$/.test(argv[2].slice(`/var/lib/powerdns/staging/${argv[1]}.zone.`.length))) return
    if (argv[0] === '/usr/bin/dig' && argv.length === 8 && argv[1] === '@127.0.0.1' && services.normalizeZone(argv[2]) === argv[2] &&
        ['SOA', 'AXFR'].includes(argv[3]!) && argv[4] === '+norecurse' && argv[5] === '+time=2' && argv[6] === '+tries=1' &&
        (argv[7] === '+tcp' || argv[3] === 'SOA' && argv[7] === '+notcp')) return
    fail('PRECONDITION_FAILED', 'DNS observation command is outside the fixed local contract')
  }
  const nativeRun = (argv: string[], timeoutMs: number): Promise<ConfigTestResult> => new Promise(resolve => {
    const [binary, ...args] = argv
    execFile(binary!, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_DNS_OBSERVATION_BYTES, windowsHide: true,
      env: { PATH: '/usr/bin:/usr/sbin:/bin', LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      const code = error?.killed || error?.signal ? 124 : !error ? 0 : typeof error.code === 'number' ? error.code : 127
      resolve({ ok: code === 0, code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
  const boundedExecutor = (deadline: number): AgentExecutor => {
    const run = async (argv: string[]): Promise<ConfigTestResult> => {
      assertCommand(argv)
      const remaining = Math.floor(deadline - clock())
      if (remaining <= 0) fail('SERVICE_UNAVAILABLE', 'native DNS observation exceeded its total deadline')
      const result = await (options.runCommand ?? nativeRun)(argv, remaining)
      if (clock() > deadline) fail('SERVICE_UNAVAILABLE', 'native DNS observation exceeded its total deadline')
      return result
    }
    return {
      preflight: plan => executor.preflight(plan), readFile: path => executor.readFile(path), writeFile: file => executor.writeFile(file),
      removePath: path => executor.removePath(path), runAction: action => executor.runAction(action), readSliceMetrics: uid => executor.readSliceMetrics(uid),
      runCommand: run, runTest: test => run([...test.argv]),
    }
  }
  const ready = async (scoped: AgentExecutor): Promise<AuthoritativeDnsServiceAdapter> => {
    const checker = (await Promise.all(checkerPaths.map(async path => await inspect(path) ? path : null))).find(path => path !== null)
    if (!checker || !await inspect('/usr/bin/pdns_control') || !await inspect('/usr/bin/dig')) {
      fail('PRECONDITION_FAILED', 'trusted native DNS binaries are unavailable', { stateChanged: false, reason: 'dns_binaries_unavailable' })
    }
    const config = await scoped.runCommand(['/usr/bin/pdns_control', 'current-config', 'diff'])
    if (!config.ok || !effectiveBindBackend(config.stdout)) {
      fail('PRECONDITION_FAILED', 'the running DNS daemon is not the configured managed BIND backend', { stateChanged: false, reason: 'dns_backend_unavailable' })
    }
    return new AuthoritativeDnsServiceAdapter({ executor: scoped, namedCheckzoneBinary: checker })
  }
  const relevant = (files: readonly RenderedFile[], removedPaths: readonly string[]) =>
    files.some(file => file.path.endsWith('.zone') || file.path === DEFAULT_NAMED_ZONES_CONF) ||
    removedPaths.some(path => path.endsWith('.zone') || path === DEFAULT_NAMED_ZONES_CONF)

  return {
    async validate(files, removedPaths) {
      if (!relevant(files, removedPaths)) return
      const deadline = clock() + OBSERVATION_BUDGET_MS
      const candidates = zoneCandidates(files)
      const removed = removedPaths.map(zoneFromPath).filter(name => name !== null)
      if (removed.some(name => candidates.some(zone => zone.name === name))) fail('VALIDATION', 'a DNS zone cannot be present and removed in the same generation', { stateChanged: false })
      const adapter = await ready(boundedExecutor(deadline))
      const owned = await options.readOwnedPaths?.() ?? new Set<string>()
      const currentCatalog = await executor.readFile(DEFAULT_NAMED_ZONES_CONF)
      if (currentCatalog !== null && !owned.has(DEFAULT_NAMED_ZONES_CONF) && currentCatalog !== renderNamedZonesConfig([])) {
        fail('PRECONDITION_FAILED', 'existing DNS catalog is not owned by an accepted generation or the reviewed empty bootstrap', { stateChanged: false })
      }
      if (currentCatalog !== null && managedCatalogNames(currentCatalog).some(name => !candidates.some(zone => zone.name === name) && !removed.includes(name))) {
        fail('PRECONDITION_FAILED', 'existing DNS catalog contains zones outside this generation', { stateChanged: false })
      }
      for (const zone of candidates) {
        const current = await executor.readFile(zone.file.path)
        if (current !== null && !owned.has(zone.file.path)) {
          fail('PRECONDITION_FAILED', 'existing DNS zone is not owned by an accepted generation', { stateChanged: false })
        }
      }
      for (const name of removed) if (!owned.has(`${DEFAULT_DNS_ZONE_DIR}/${name}.zone`)) {
        fail('PRECONDITION_FAILED', 'DNS removal requires ownership by the previous generation', { stateChanged: false })
      }
      for (const zone of candidates) await adapter.validateCandidateZone(zone.name, zone.file.content)
      if (clock() > deadline) fail('SERVICE_UNAVAILABLE', 'native DNS validation exceeded its total deadline')
    },
    async verify(files, removedPaths) {
      try {
      if (!relevant(files, removedPaths)) return
      const deadline = clock() + OBSERVATION_BUDGET_MS
      const candidates = zoneCandidates(files)
      const scoped = boundedExecutor(deadline)
      const adapter = await ready(scoped)
      const assertCatalog = async () => {
        const expected = files.find(file => file.path === DEFAULT_NAMED_ZONES_CONF)
        if (expected && await executor.readFile(DEFAULT_NAMED_ZONES_CONF) !== expected.content ||
            !expected && removedPaths.includes(DEFAULT_NAMED_ZONES_CONF) && await executor.readFile(DEFAULT_NAMED_ZONES_CONF) !== null) {
          fail('CONFIG_TEST_FAILED', 'active DNS catalog differs from the selected generation')
        }
      }
      await assertCatalog()
      if (clock() > deadline) fail('SERVICE_UNAVAILABLE', 'native DNS observation exceeded its total deadline')
      for (const zone of candidates) {
        await adapter.observeCandidateZone(zone.name, zone.file.content)
        const transfer = await scoped.runCommand(['/usr/bin/dig', '@127.0.0.1', zone.name, 'AXFR', '+norecurse', '+time=2', '+tries=1', '+tcp'])
        if (!transfer.ok) fail('PRECONDITION_FAILED', 'local DNS transfer observation is unavailable; existing transfer permissions were not changed', { reason: 'dns_local_transfer_unavailable' })
        const observed = parseObservedAxfr(transfer.stdout, zone.name)
        if (JSON.stringify(canonicalRrsets(observed)) !== JSON.stringify(canonicalRrsets(zone.records))) {
          fail('CONFIG_TEST_FAILED', 'active DNS records differ from the complete selected generation', { zone: zone.name })
        }
        if (await executor.readFile(zone.file.path) !== zone.file.content) fail('CONFIG_TEST_FAILED', 'DNS generation changed during RRset observation', { zone: zone.name })
      }
      for (const path of removedPaths) {
        const zone = zoneFromPath(path)
        if (zone !== null) await adapter.observeDeletedZone(zone)
      }
      await assertCatalog()
      if (clock() > deadline) fail('SERVICE_UNAVAILABLE', 'native DNS observation exceeded its total deadline')
      } catch (error) {
        // Observation also runs after activation/rollback. It cannot assert that no host state changed.
        if (isXpanelError(error)) {
          const { stateChanged: _stateChanged, ...detail } = error.detail
          return fail(error.code, error.message, { ...detail, verificationRequired: true, unknownOutcome: true })
        }
        return fail('SERVICE_UNAVAILABLE', 'native DNS observation could not be completed', { verificationRequired: true, unknownOutcome: true })
      }
    },
  }
}
