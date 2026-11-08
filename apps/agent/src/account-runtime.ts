import { createHash } from 'node:crypto'
import { readdir, readFile as fsReadFile, rm, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { uptime } from 'node:os'
import { join } from 'node:path'
import { effectivePlan, fail, isAccountHome, isXpanelError } from '@xpanel/core'
import type { Account, Domain, FeatureList, HostAction, Limit, OsProfile, Plan, RenderedFile } from '@xpanel/core'
import { system } from '@xpanel/render'
import type { edge } from '@xpanel/render'
import { atomicWriteJson } from '@xpanel/state'
import type { AgentExecutor, ConfigTestResult } from './executor.ts'
import type { AgentCallerIdentity } from './server.ts'
import { PYTHON_VERSIONS, readRuntimeOp, RUNTIME_LOG_TARGET } from '../../../packages/os/src/account-runtime-command.ts'
import type { AccountRuntimeClientView, AppRuntimeKindName, ProjectFacts, RuntimeOp, RuntimeUnitStateName, SiteCompressionMode } from '../../../packages/os/src/account-runtime-command.ts'
import { accountUnitArgv, assertWebAppConfig, buildDeployCommand, buildStageCommand, deployScript, deployUnitName, isWebAppCommand, readWebAppDetection, stageUnitName, WEB_APPS_FEATURE, webAppRoot, webAppStatus } from './web-apps.ts'
import type { WebAppRecord } from './web-apps.ts'
import { parseComposeServices, parseStackRecord, stackServiceName, stackUnits, stackUnitSpecs } from './ctr-compose.ts'
import type { StackRecord } from './ctr-compose.ts'
import { assertTrustedImage, readCtrPolicy } from './ctr-policy.ts'

/**
 * Runtime apps (Node.js, Python, Ruby), private Redis/Memcached and rootless containers of one account.
 * Desired state is one root-only file per account under the state root; the reconciler renders the units
 * and the Nginx routes from it, so a suspended account or a removed entry loses its units through the
 * normal generation diff. Nothing listens on TCP: apps sit behind root-owned front sockets, caches on a
 * socket in the home, an account's containers publish no port. Stacks root deploys may publish one (ctr-compose).
 */
export const RUNTIME_STATE_DIR = 'extended/runtime'
export const RUNTIME_LIMITS = { apps: 10, containers: 5, envVars: 32, envValue: 1024, pythonEnvs: 16 } as const
export const RUNTIME_FEATURES = { apps: 'application-manager', cache: 'account-cache-services', containers: 'account-containers' } as const
export const CACHE_BINARIES: Readonly<Record<system.CacheService, readonly string[]>> = { redis: ['/usr/bin/redis-server', '/usr/bin/valkey-server'], memcached: ['/usr/bin/memcached'] }
const NPM_BINARY = '/usr/bin/npm'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
const ROUTE_PATH = /^\/(?:[a-z0-9][a-z0-9._-]{0,62}(?:\/[a-z0-9][a-z0-9._-]{0,62}){0,3})?$/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const CONTROL = /[\u0000-\u001f\u007f]/
const RESERVED_ENV = new Set(['PORT', 'BUNDLE_GEMFILE', 'BUNDLE_PATH'])
const JAVA_BINARY = /^\/usr\/lib\/jvm\/[a-z0-9.+_-]{1,64}\/bin\/java$/

/** A Go or Java project; the port is unique on the host. */
export interface ProjectRecord { port: number; openPort: boolean; jdk: '17' | '21' | null; javaBinary: string | null; command: string | null }
export interface RuntimeAppRecord { name: string; runtime: system.RuntimeKind; root: string; startup: string; domainId: string; path: string; env: Record<string, string>; enabled: boolean; updatedAt: string; webapp?: WebAppRecord; project?: ProjectRecord; pythonEnv?: string }
export interface PythonEnvRecord { name: string; version: string; updatedAt: string }
export interface CacheRecord { enabled: boolean; memoryMb: number; binary: string; updatedAt: string }
export interface ContainerRecord { name: string; image: string; env: Record<string, string>; enabled: boolean; updatedAt: string }
export interface CompressionRecord { mode: SiteCompressionMode; types: string[]; updatedAt: string }
export interface RuntimeRegistry { apps: RuntimeAppRecord[]; cache: { redis: CacheRecord | null; memcached: CacheRecord | null }; containers: ContainerRecord[]; compression?: CompressionRecord; pythonEnvs?: PythonEnvRecord[]; stacks?: StackRecord[]; logins?: RegistryLogin[] }
export interface RegistryLogin { host: string; username: string }

export const EMPTY_RUNTIME: RuntimeRegistry = { apps: [], cache: { redis: null, memcached: null }, containers: [] }

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, list: readonly string[]): boolean => Object.keys(v).sort().join() === [...list].sort().join()
const time = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v))
/** Relative path inside the home: plain segments only, never '.', '..' or empty. */
export const isHomeRelativePath = (v: unknown, segments = 8): v is string => typeof v === 'string' && v.length <= 512 && v.split('/').length <= segments && v.split('/').every(s => /^[A-Za-z0-9._+-]{1,128}$/.test(s) && s !== '.' && s !== '..')
const envOf = (v: unknown): Record<string, string> | null => {
  if (!object(v) || Object.keys(v).length > RUNTIME_LIMITS.envVars) return null
  for (const [k, value] of Object.entries(v)) if (!ENV_KEY.test(k) || RESERVED_ENV.has(k) || typeof value !== 'string' || value.length > RUNTIME_LIMITS.envValue || CONTROL.test(value)) return null
  return { ...(v as Record<string, string>) }
}
const invalidState = (): never => fail('PRECONDITION_FAILED', 'saved runtime configuration is invalid; review it before reconciliation', { stateChanged: false })
const shellText = (v: unknown): boolean => v === null || typeof v === 'string' && v.length >= 1 && v.length <= 1024 && !CONTROL.test(v)
const projectOf = (v: unknown): ProjectRecord => {
  if (!object(v) || !keys(v, ['port', 'openPort', 'jdk', 'javaBinary', 'command']) || !system.isAppPort(v.port) || typeof v.openPort !== 'boolean' || !(v.jdk === null || v.jdk === '17' || v.jdk === '21')
    || !(v.javaBinary === null || typeof v.javaBinary === 'string' && JAVA_BINARY.test(v.javaBinary)) || !shellText(v.command)) return invalidState()
  return v as unknown as ProjectRecord
}
const webAppOf = (v: unknown): WebAppRecord => {
  const s = object(v) ? v.source : null
  const source = object(s) && (s.kind === 'git' ? keys(s, ['kind', 'url', 'branch']) && typeof s.url === 'string' && s.url.length <= 512 && !CONTROL.test(s.url) && (s.branch === null || typeof s.branch === 'string' && s.branch.length <= 128 && !CONTROL.test(s.branch))
    : s.kind === 'archive' && keys(s, ['kind', 'path']) && isHomeRelativePath(s.path))
  if (!object(v) || !keys(v, ['source', 'category', 'framework', 'startCommand', 'buildCommand', 'outputDir', 'mode', 'deployedAt']) || !source || !['server', 'static'].includes(v.category as string) || typeof v.framework !== 'string' || !/^[a-z0-9-]{1,32}$/.test(v.framework)
    || !shellText(v.startCommand) || !shellText(v.buildCommand) || !(v.outputDir === null || v.outputDir === '.' || isHomeRelativePath(v.outputDir, 4)) || !['production', 'development'].includes(v.mode as string) || !(v.deployedAt === null || time(v.deployedAt))) return invalidState()
  return v as unknown as WebAppRecord
}

/** Strict reader of the saved file; the same grammar admits a request before it is saved. */
export const parseRuntimeRegistry = (raw: unknown): RuntimeRegistry => {
  if (!object(raw) || !keys(raw, ['apps', 'cache', 'containers', ...['compression', 'pythonEnvs', 'stacks', 'logins'].filter(key => key in raw)]) || !Array.isArray(raw.apps) || raw.apps.length > RUNTIME_LIMITS.apps || !object(raw.cache) || !keys(raw.cache, ['redis', 'memcached'])
    || !Array.isArray(raw.containers) || raw.containers.length > RUNTIME_LIMITS.containers) return invalidState()
  const apps = raw.apps.map((a: unknown): RuntimeAppRecord => {
    const env = object(a) ? envOf(a.env) : null
    if (!object(a) || !keys(a, ['name', 'runtime', 'root', 'startup', 'domainId', 'path', 'env', 'enabled', 'updatedAt', ...('webapp' in a ? ['webapp'] : []), ...('project' in a ? ['project'] : []), ...('pythonEnv' in a ? ['pythonEnv'] : [])]) || typeof a.name !== 'string' || !NAME.test(a.name) || !system.RUNTIME_KINDS.includes(a.runtime as system.RuntimeKind)
      || !isHomeRelativePath(a.root) || !isHomeRelativePath(a.startup, 4) || typeof a.domainId !== 'string' || !UUID.test(a.domainId) || typeof a.path !== 'string' || !ROUTE_PATH.test(a.path) || !env || typeof a.enabled !== 'boolean' || !time(a.updatedAt) || ['go', 'java'].includes(a.runtime as string) !== 'project' in a || 'pythonEnv' in a && (typeof a.pythonEnv !== 'string' || !NAME.test(a.pythonEnv))) return invalidState()
    return { name: a.name, runtime: a.runtime as system.RuntimeKind, root: a.root, startup: a.startup, domainId: a.domainId, path: a.path, env, enabled: a.enabled, updatedAt: a.updatedAt, ...('webapp' in a ? { webapp: webAppOf(a.webapp) } : {}), ...('project' in a ? { project: projectOf(a.project) } : {}), ...('pythonEnv' in a ? { pythonEnv: a.pythonEnv as string } : {}) }
  })
  if (new Set(apps.map(a => a.name)).size !== apps.length || new Set(apps.map(a => a.domainId + a.path)).size !== apps.length) return invalidState()
  const cache = (service: system.CacheService): CacheRecord | null => {
    const c = (raw.cache as Record<string, unknown>)[service]
    if (c === null) return null
    if (!object(c) || !keys(c, ['enabled', 'memoryMb', 'binary', 'updatedAt']) || typeof c.enabled !== 'boolean' || typeof c.memoryMb !== 'number' || !Number.isInteger(c.memoryMb) || c.memoryMb < 8 || c.memoryMb > 4096
      || !CACHE_BINARIES[service].includes(c.binary as string) || !time(c.updatedAt)) return invalidState()
    return { enabled: c.enabled, memoryMb: c.memoryMb, binary: c.binary as string, updatedAt: c.updatedAt }
  }
  const containers = raw.containers.map((c: unknown): ContainerRecord => {
    const env = object(c) ? envOf(c.env) : null
    if (!object(c) || !keys(c, ['name', 'image', 'env', 'enabled', 'updatedAt']) || typeof c.name !== 'string' || !NAME.test(c.name) || !system.isContainerImage(c.image) || !env || typeof c.enabled !== 'boolean' || !time(c.updatedAt)) return invalidState()
    return { name: c.name, image: c.image, env, enabled: c.enabled, updatedAt: c.updatedAt }
  })
  if (new Set(containers.map(c => c.name)).size !== containers.length) return invalidState()
  const z = raw.compression
  if ('compression' in raw && (!object(z) || !keys(z, ['mode', 'types', 'updatedAt']) || !['disabled', 'all', 'types'].includes(z.mode as string) || !Array.isArray(z.types) || !z.types.every(type => typeof type === 'string' && /^[a-z0-9.+*/-]{3,128}$/.test(type)) || !time(z.updatedAt))) return invalidState()
  const pythonEnvs = 'pythonEnvs' in raw ? raw.pythonEnvs : undefined
  if (pythonEnvs !== undefined && (!Array.isArray(pythonEnvs) || pythonEnvs.length > RUNTIME_LIMITS.pythonEnvs || !pythonEnvs.every(e => object(e) && keys(e, ['name', 'version', 'updatedAt']) && typeof e.name === 'string' && NAME.test(e.name) && (PYTHON_VERSIONS as readonly string[]).includes(e.version as string) && time(e.updatedAt)))) return invalidState()
  if ('stacks' in raw && !Array.isArray(raw.stacks) || 'logins' in raw && !(Array.isArray(raw.logins) && raw.logins.every(login => object(login) && keys(login, ['host', 'username']) && typeof login.host === 'string' && typeof login.username === 'string'))) return invalidState()
  const stacks = 'stacks' in raw ? (raw.stacks as unknown[]).map(stack => parseStackRecord(stack, invalidState)) : null
  if (stacks && new Set(stacks.map(stack => stack.name)).size !== stacks.length) return invalidState()
  return { apps, cache: { redis: cache('redis'), memcached: cache('memcached') }, containers, ...('compression' in raw ? { compression: z as unknown as CompressionRecord } : {}), ...(pythonEnvs ? { pythonEnvs: pythonEnvs as PythonEnvRecord[] } : {}), ...(stacks ? { stacks } : {}), ...('logins' in raw ? { logins: raw.logins as RegistryLogin[] } : {}) }
}

export const runtimeRegistryPath = (root: string, accountId: string): string => {
  if (!UUID.test(accountId)) return fail('VALIDATION', 'invalid account id', { stateChanged: false })
  return join(root, RUNTIME_STATE_DIR, accountId + '.json')
}
export const runtimeRevision = (registry: RuntimeRegistry): string => createHash('sha256').update(JSON.stringify(registry)).digest('hex')

export async function readRuntimeRegistry(root: string, accountId: string): Promise<RuntimeRegistry> {
  let text: string
  try { text = await fsReadFile(runtimeRegistryPath(root, accountId), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_RUNTIME
    return fail('PRECONDITION_FAILED', 'saved runtime configuration is unreadable; review it before reconciliation', { stateChanged: false })
  }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return invalidState() }
  return parseRuntimeRegistry(raw)
}

/** Registries of every saved account, for one reconcile pass. */
export async function readRuntimeRegistries(root: string, accounts: readonly Pick<Account, 'id'>[]): Promise<Map<string, RuntimeRegistry>> {
  const out = new Map<string, RuntimeRegistry>()
  for (const account of accounts) out.set(account.id, await readRuntimeRegistry(root, account.id))
  return out
}

/** Cache memory a plan allows: a quarter of the plan memory, at most 1 GiB; 256 MiB when memory is unlimited. */
export const cacheCapMb = (memoryMb: Limit): number => memoryMb === 'unlimited' ? 256 : Math.min(1024, Math.floor(memoryMb / 4))
const servesApps = (account: Pick<Account, 'id'>, domain: Domain): boolean => domain.accountId === account.id && !domain.suspended && domain.kind !== 'alias'

export interface CompiledAccountRuntime {
  files: RenderedFile[]
  preActions: HostAction[]
  postActions: HostAction[]
  /** every unit this account's runtime renders, for termination */
  units: string[]
  routes: Record<string, edge.AppRoute[]>
  python: boolean
  compression?: { mode: SiteCompressionMode; types: string[] }
}

export const PYTHON_ENV_DIR = 'python-envs'
export const pythonEnvPath = (home: string, name: string): string => home + '/' + PYTHON_ENV_DIR + '/' + name

/** Private ports of the running Go and Java apps, for the firewall guard. */
export const runtimeAppPorts = (accounts: readonly Pick<Account, 'id' | 'uid' | 'status'>[], registries: ReadonlyMap<string, RuntimeRegistry> | undefined): { port: number; uid: number; open: boolean }[] =>
  accounts.filter(account => account.status === 'active').flatMap(account => (registries?.get(account.id)?.apps ?? []).flatMap(app => app.enabled && app.project ? [{ port: app.project.port, uid: account.uid, open: app.project.openPort }] : []))

const webAppUnitSpec = (account: Pick<Account, 'home'>, app: RuntimeAppRecord): Partial<system.AppSpec> => {
  const w = app.webapp
  if (app.project) return { port: app.project.port, publicPort: app.project.openPort, ...(app.project.javaBinary ? { javaBinary: app.project.javaBinary } : {}), ...(app.project.command ? { startCommand: app.project.command } : {}) }
  if (app.pythonEnv) return { pythonBinary: pythonEnvPath(account.home, app.pythonEnv) + '/bin/python' }
  if (!w) return {}
  if (w.category === 'static') return { deployStamp: true, mode: w.mode, staticDir: account.home + '/' + app.root + (w.outputDir === '.' ? '' : '/' + w.outputDir), staticPrefix: app.path === '/' ? '' : app.path }
  return { deployStamp: true, mode: w.mode, ...(w.startCommand && app.runtime === 'node' ? { startCommand: w.startCommand } : {}) }
}

/**
 * Units and Nginx routes of one account's enabled entries. A disabled entry or a non-active account renders
 * nothing, so the generation diff stops, disables and removes its units.
 */
export function compileAccountRuntime(account: Account, plan: Plan, domains: readonly Domain[], registry: RuntimeRegistry, os: OsProfile, features: readonly string[] = []): CompiledAccountRuntime {
  const out: CompiledAccountRuntime = { files: [], preActions: [], postActions: [], units: [], routes: {}, python: false }
  const allowed = (key: keyof typeof RUNTIME_FEATURES): boolean => account.status === 'active' && !features.includes(RUNTIME_FEATURES[key])
  const apps = allowed('apps') ? registry.apps.filter(a => a.enabled) : []
  const caches = allowed('cache') ? system.CACHE_SERVICES.flatMap(service => { const c = registry.cache[service]; return c?.enabled ? [{ service, ...c }] : [] }) : []
  const containers = allowed('containers') ? registry.containers.filter(c => c.enabled) : []
  if (registry.compression && !features.includes(OPTIMIZE_FEATURE)) out.compression = { mode: registry.compression.mode, types: registry.compression.types }
  const stacks = allowed('containers') ? (registry.stacks ?? []).filter(stack => stack.enabled) : []
  if (!apps.length && !caches.length && !containers.length && !stacks.length) return out
  out.preActions.push(
    { kind: 'ensure-dir', path: system.RUNTIME_CONFIG_ROOT, mode: 0o711, owner: 'root', group: 'root' },
    { kind: 'ensure-dir', path: system.runtimeConfigDir(account.username), mode: 0o700, owner: 'root', group: 'root' },
  )
  const run = (...units: string[]): void => { for (const unit of units) out.postActions.push({ kind: 'systemd', verb: 'enable', unit }, { kind: 'systemd', verb: 'start', unit }) }
  for (const app of apps) {
    const r = system.renderAppUnits(account, { name: app.name, kind: app.runtime, root: account.home + '/' + app.root, startup: app.startup, env: app.env, ...webAppUnitSpec(account, app) }, os)
    out.files.push(r.envFile, r.service, r.proxySocket, r.proxyService)
    out.units.push(r.paths.service, r.paths.proxySocketUnit, r.paths.proxyService)
    run(r.paths.service, r.paths.proxySocketUnit)
    out.python ||= app.runtime === 'python' || app.webapp?.category === 'static'
    const domain = domains.find(d => d.id === app.domainId)
    if (domain && servesApps(account, domain)) (out.routes[domain.name] ??= []).push({ path: app.path, socket: r.paths.proxySocket })
  }
  const cap = cacheCapMb(plan.resources.memoryMb)
  for (const c of caches) {
    const unit = system.renderCacheUnit(account, { service: c.service, memoryMb: Math.min(c.memoryMb, cap), binary: c.binary }, os)
    out.files.push(unit)
    const name = system.cachePaths(account, c.service).unit
    out.units.push(name)
    run(name)
  }
  for (const c of containers) {
    const r = system.renderContainerUnit(account, { name: c.name, image: c.image, env: c.env }, plan.resources, os)
    out.files.push(r.envFile, r.service)
    out.units.push(r.unit)
    run(r.unit)
  }
  const lower = (saved: number | null, planned: Limit): Limit => saved === null ? planned : planned === 'unlimited' ? saved : Math.min(saved, planned)
  for (const { limits, ...spec } of stacks.flatMap(stack => stackUnitSpecs(stack, account.home))) {
    const r = system.renderContainerUnit(account, spec, { ...plan.resources, memoryMb: lower(limits.memoryMb, plan.resources.memoryMb), cpuPercent: lower(limits.cpuPercent, plan.resources.cpuPercent) }, os)
    out.files.push(r.envFile, r.service)
    out.units.push(r.unit)
    run(r.unit)
  }
  return out
}

/** Units a terminating account may still have, from its saved registry (enabled or not). */
export const runtimeUnitNames = (account: Pick<Account, 'username' | 'home'>, registry: RuntimeRegistry): string[] => [
  ...registry.apps.flatMap(a => { const p = system.appPaths(account.username, a.name); return [p.service, p.proxySocketUnit, p.proxyService] }),
  ...system.CACHE_SERVICES.filter(s => registry.cache[s]).map(s => system.cachePaths(account, s).unit),
  ...registry.containers.map(c => system.containerUnitName(account.username, c.name)),
  ...(registry.stacks ?? []).flatMap(stack => stackUnits(account.username, stack)),
]

// ---------------------------------------------------------------- host facts

export interface UnitState { load: string; active: string; sub: string; since: string | null; memoryBytes: number | null; cpuNs: number | null; restarts: number | null }

export interface RuntimeHost {
  exists(path: string): Promise<boolean>
  run(argv: string[]): Promise<ConfigTestResult>
  systemd(verb: 'restart' | 'stop' | 'reset-failed', unit: string): Promise<void>
  /** HTTP status of GET <path>/ through an app front socket, or null when nothing answered */
  probe(socket: string, host: string, path: string): Promise<number | null>
  readText(path: string): Promise<string | null>
}

const VERSION = /(\d+\.\d+(?:\.\d+)?)/
const versionOf = async (host: RuntimeHost, argv: string[]): Promise<string | null> => {
  const r = await host.run(argv).catch(() => null)
  return r?.ok ? VERSION.exec(r.stdout + ' ' + r.stderr)?.[1] ?? null : null
}

export interface RuntimeHostFacts extends ProjectFacts {
  runtimes: { kind: system.RuntimeKind; available: boolean; version: string | null; reason: null | 'not-installed' | 'proxy-unavailable' | 'bundler-missing' | 'venv-missing' }[]
  cache: { service: system.CacheService; available: boolean; version: string | null; binary: string | null; reason: null | 'not-installed' }[]
  containers: { available: boolean; version: string | null; reason: null | 'not-installed' | 'newuidmap-missing' | 'no-subordinate-ids' }
}

const UNAVAILABLE_FACTS: RuntimeHostFacts = {
  jdks: [], python: [],
  runtimes: system.RUNTIME_KINDS.map(kind => ({ kind, available: false, version: null, reason: 'not-installed' as const })),
  cache: system.CACHE_SERVICES.map(service => ({ service, available: false, version: null, binary: null, reason: 'not-installed' as const })),
  containers: { available: false, version: null, reason: 'not-installed' },
}

/** Debian and Ubuntu name the JVM directory with the architecture, EL with a jre-<n> link. */
export const javaBinaries = (version: '17' | '21'): string[] => [`/usr/lib/jvm/jre-${version}/bin/java`, `/usr/lib/jvm/java-${version}-openjdk-amd64/bin/java`, `/usr/lib/jvm/java-${version}-openjdk-arm64/bin/java`, `/usr/lib/jvm/java-${version}-openjdk/bin/java`]
const hasSubordinateIds = (text: string | null, account: Pick<Account, 'username' | 'uid'>): boolean => (text ?? '').split('\n').some(line => {
  const [owner, , count] = line.trim().split(':')
  return (owner === account.username || owner === String(account.uid)) && Number(count) >= 65536
})

export async function readRuntimeHostFacts(host: RuntimeHost | null, account: Pick<Account, 'username' | 'uid'>): Promise<RuntimeHostFacts> {
  if (!host) return UNAVAILABLE_FACTS
  const proxy = await host.exists(system.SOCKET_PROXYD_BINARY)
  const runtimes = await Promise.all(system.RUNTIME_KINDS.map(async kind => {
    const binary = system.RUNTIME_BINARIES[kind]
    // A Go project runs a built executable, so the toolchain is only reported.
    if (kind === 'go') return { kind, available: proxy, version: await host.exists(binary) ? await versionOf(host, [binary, 'version']) : null, reason: proxy ? null : 'proxy-unavailable' as const }
    if (!await host.exists(binary)) return { kind, available: false, version: null, reason: 'not-installed' as const }
    const version = await versionOf(host, [binary, '--version'])
    // Debian and Ubuntu ship venv/ensurepip separately (python3-venv); without it no app can get its .venv.
    const reason = !proxy ? 'proxy-unavailable' as const : kind === 'ruby' && !await host.exists(system.RUBY_BUNDLE_BINARY) ? 'bundler-missing' as const
      : kind === 'python' && !(await host.run([binary, '-m', 'ensurepip', '--version']).catch(() => null))?.ok ? 'venv-missing' as const : null
    return { kind, available: version !== null && reason === null, version, reason: version === null ? 'not-installed' as const : reason }
  }))
  const cache = await Promise.all(system.CACHE_SERVICES.map(async service => {
    for (const binary of CACHE_BINARIES[service]) {
      if (!await host.exists(binary)) continue
      const version = await versionOf(host, [binary, service === 'redis' ? '--version' : '-V'])
      if (version) return { service, available: true, version, binary, reason: null }
    }
    return { service, available: false, version: null, binary: null, reason: 'not-installed' as const }
  }))
  const jdks = await Promise.all((['17', '21'] as const).map(async version => {
    for (const candidate of javaBinaries(version)) if (await host.exists(candidate)) return { version, binary: candidate }
    return { version, binary: null }
  }))
  const python = await Promise.all(PYTHON_VERSIONS.map(async version => {
    const binary = '/usr/bin/python' + version, installed = await host.exists(binary)
    return { version, binary, installed, full: installed ? await versionOf(host, [binary, '--version']) : null }
  }))
  return { runtimes, cache, containers: containerFacts(await readPodmanEngine(host), account), jdks, python }
}

/** Host facts once, then one pure answer per account: a list of accounts starts no process per account. */
export interface PodmanEngineFacts { version: string | null; newuidmap: boolean; subuid: string | null; subgid: string | null }
export async function readPodmanEngine(host: RuntimeHost | null): Promise<PodmanEngineFacts> {
  if (!host || !await host.exists(system.PODMAN_BINARY)) return { version: null, newuidmap: false, subuid: null, subgid: null }
  return { version: await versionOf(host, [system.PODMAN_BINARY, '--version']), newuidmap: await host.exists('/usr/bin/newuidmap'), subuid: await host.readText('/etc/subuid'), subgid: await host.readText('/etc/subgid') }
}
export const containerFacts = (engine: PodmanEngineFacts, account: Pick<Account, 'username' | 'uid'>): RuntimeHostFacts['containers'] => {
  const version = engine.version
  return !version ? { available: false, version: null, reason: 'not-installed' }
    : !engine.newuidmap ? { available: false, version, reason: 'newuidmap-missing' }
      : !hasSubordinateIds(engine.subuid, account) || !hasSubordinateIds(engine.subgid, account) ? { available: false, version, reason: 'no-subordinate-ids' }
        : { available: true, version, reason: null }
}

// systemd 249 (Ubuntu 22.04) has no --timestamp=unix; the monotonic entry stamp is converted against the uptime.
const STATE_PROPERTIES = ['Id', 'LoadState', 'ActiveState', 'SubState', 'ActiveEnterTimestampMonotonic', 'MemoryCurrent', 'CPUUsageNSec', 'NRestarts']
const numeric = (v: string | undefined): number | null => v !== undefined && /^\d{1,20}$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null

export async function readUnitStates(host: RuntimeHost | null, units: readonly string[], clock = { now: Date.now, uptimeSeconds: uptime }): Promise<Map<string, UnitState>> {
  const out = new Map<string, UnitState>()
  if (!host || units.length === 0) return out
  const r = await host.run(['/usr/bin/systemctl', 'show', ...STATE_PROPERTIES.flatMap(p => ['-p', p]), '--', ...units]).catch(() => null)
  if (!r?.ok) return out
  for (const block of r.stdout.split(/\n\s*\n/)) {
    const v = Object.fromEntries(block.split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    if (!units.includes(v.Id ?? '')) continue
    const enteredUs = numeric(v.ActiveEnterTimestampMonotonic)
    const since = enteredUs ? new Date(Math.round(clock.now() - (clock.uptimeSeconds() * 1000 - enteredUs / 1000))).toISOString() : null
    out.set(v.Id!, { load: v.LoadState ?? 'unknown', active: v.ActiveState ?? 'unknown', sub: v.SubState ?? 'unknown', since,
      memoryBytes: numeric(v.MemoryCurrent), cpuNs: numeric(v.CPUUsageNSec), restarts: numeric(v.NRestarts) })
  }
  return out
}

// ---------------------------------------------------------------- dependency installs

export const depsUnitName = (username: string, app: string): string => `xpanel-deps-${system.assertUsername(username)}-${app}.service`
const PY_DEPS = "import os,subprocess,sys,venv;r=sys.argv[1];v=os.path.join(r,'.venv');os.path.exists(os.path.join(v,'bin','python')) or venv.create(v,with_pip=True);q=os.path.join(r,'requirements.txt');sys.exit(subprocess.call([os.path.join(v,'bin','pip'),'install','--no-input','-r',q]) if os.path.exists(q) else 0)"
const depsCommand = (kind: system.RuntimeKind, root: string, envPython: string | null): string[] => envPython ? [envPython, '-m', 'pip', 'install', '--no-input', '-r', root + '/requirements.txt'] : kind === 'node' ? [NPM_BINARY, 'install', '--omit=dev', '--no-audit', '--no-fund']
  : kind === 'python' ? [system.RUNTIME_BINARIES.python, '-c', PY_DEPS, root] : [system.RUBY_BUNDLE_BINARY, 'install']

/**
 * A background oneshot as the account in its slice and home namespace, with network for package registries.
 * RemainAfterExit keeps the outcome readable after it ends.
 */
export function buildDepsCommand(account: Pick<Account, 'username' | 'uid' | 'gid' | 'home'>, app: Pick<RuntimeAppRecord, 'name' | 'runtime' | 'root' | 'pythonEnv'>): string[] {
  if (!NAME.test(app.name) || !isHomeRelativePath(app.root) || !system.RUNTIME_KINDS.includes(app.runtime)) return fail('VALIDATION', 'invalid application', { stateChanged: false })
  const root = account.home + '/' + app.root
  const env: Record<string, string> = app.runtime === 'ruby' ? { BUNDLE_GEMFILE: root + '/Gemfile', BUNDLE_PATH: root + '/vendor/bundle' } : {}
  const skeleton = system.buildJailedFileOpArgv(account, ['/usr/bin/id'], { cwdRel: app.root, env })
  const delimiter = skeleton.lastIndexOf('--')
  const prefix = skeleton.slice(0, delimiter).filter(v => !['--pipe', '--wait', '--collect', '--quiet'].includes(v))
    .map(v => v === 'User=' + account.username ? 'User=' + account.uid : v === 'Group=' + account.username ? 'Group=' + account.gid : v)
  return [prefix[0]!, '--unit=' + depsUnitName(account.username, app.name), '--no-block', '--quiet', ...prefix.slice(1), '--property', 'Type=oneshot', '--property', 'RemainAfterExit=yes',
    '--property', 'TimeoutStartSec=900s', '--property', 'TasksMax=256', '--', ...depsCommand(app.runtime, root, app.pythonEnv ? pythonEnvPath(account.home, app.pythonEnv) + '/bin/python' : null)]
}

/** Exact outer admission of buildDepsCommand: it cannot approve any other systemd-run, user or command. */
export function isAccountRuntimeCommand(argv: readonly string[]): boolean {
  if (!Array.isArray(argv) || argv.some(v => typeof v !== 'string')) return false
  if (argv[1]?.startsWith('--unit=xpanel-podclean-')) return isPodmanCleanupCommand(argv)
  if (argv[1]?.startsWith('--unit=xpanel-web')) return isWebAppCommand(argv)
  if (argv[1]?.startsWith('--unit=xpanel-pyenv-')) return isPythonEnvCommand(argv)
  const unit = /^--unit=xpanel-deps-([a-z][a-z0-9]{0,15})-([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)\.service$/.exec(argv[1] ?? '')
  const uid = argv.find(v => /^User=[0-9]+$/.test(v))?.slice(5), gid = argv.find(v => /^Group=[0-9]+$/.test(v))?.slice(6)
  const cwd = argv.find(v => /^--working-directory=\/home[1-9]?[0-9]?\//.test(v) && v.split('/')[2] === unit?.[1])?.slice(20)
  const command = argv.slice(argv.lastIndexOf('--') + 1)
  const named = /\/python-envs\/([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)\/bin\/python$/.exec(command[0] ?? '')?.[1]
  const kind = named ? 'python' : command[0] === NPM_BINARY ? 'node' : command[0] === system.RUNTIME_BINARIES.python ? 'python' : command[0] === system.RUBY_BUNDLE_BINARY ? 'ruby' : null
  if (!unit || !uid || !gid || !cwd || !kind) return false
  try {
    const home = cwd.split('/').slice(0, 3).join('/')
    return JSON.stringify(argv) === JSON.stringify(buildDepsCommand({ username: unit[1]!, uid: Number(uid), gid: Number(gid), home }, { name: unit[2]!, runtime: kind, root: cwd.slice(home.length + 1), ...(named ? { pythonEnv: named } : {}) }))
  } catch { return false }
}

// ---------------------------------------------------------------- named Python environments

export const pythonEnvUnitName = (username: string, name: string): string => `xpanel-pyenv-${system.assertUsername(username)}-${name}.service`
/** Creates or removes ~/python-envs/<name> as the account; python -m venv needs no network. */
export function buildPythonEnvCommand(account: Pick<Account, 'username' | 'uid' | 'gid' | 'home'>, name: string, version: string | null): string[] {
  if (!NAME.test(name) || version !== null && !(PYTHON_VERSIONS as readonly string[]).includes(version)) return fail('VALIDATION', 'invalid Python environment', { stateChanged: false })
  const path = pythonEnvPath(account.home, name)
  return accountUnitArgv(account, pythonEnvUnitName(account.username, name), '', version === null ? ['/usr/bin/rm', '-rf', path] : ['/usr/bin/python' + version, '-m', 'venv', path], ['RemainAfterExit=yes'], {})
}
const isPythonEnvCommand = (argv: readonly string[]): boolean => {
  const unit = /^--unit=xpanel-pyenv-([a-z][a-z0-9]{0,15})-([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)\.service$/.exec(argv[1] ?? '')
  const uid = argv.find(v => /^User=[0-9]+$/.test(v))?.slice(5), gid = argv.find(v => /^Group=[0-9]+$/.test(v))?.slice(6), home = argv.find(v => v.startsWith('--working-directory='))?.slice(20)
  const tail = argv.slice(argv.lastIndexOf('--') + 1), version = /^\/usr\/bin\/python(3\.[0-9]{1,2})$/.exec(tail[0] ?? '')?.[1] ?? null
  if (!unit || !uid || !gid || !home || !isAccountHome(home, unit[1]!) || version === null && tail[0] !== '/usr/bin/rm') return false
  try { return JSON.stringify(argv) === JSON.stringify(buildPythonEnvCommand({ username: unit[1]!, uid: Number(uid), gid: Number(gid), home }, unit[2]!, version)) } catch { return false }
}

// ---------------------------------------------------------------- generations and purge

const generationPath = (root: string, genId: number): string => {
  if (!Number.isSafeInteger(genId) || genId < 1) return fail('VALIDATION', 'generation id must be a positive integer')
  return join(root, RUNTIME_STATE_DIR, 'generations', genId + '.json')
}
const EMPTY_TEXT = JSON.stringify(EMPTY_RUNTIME)
/** Registries that hold anything, keyed and ordered by account id, so two sets compare as text. */
export const savedRuntimes = (registries: ReadonlyMap<string, RuntimeRegistry>): Record<string, RuntimeRegistry> =>
  Object.fromEntries([...registries].filter(([, r]) => JSON.stringify(r) !== EMPTY_TEXT).sort(([a], [b]) => a.localeCompare(b)))

/** The registries a generation was compiled from, saved beside its state snapshot so a rollback restores them too. */
export async function saveRuntimeGeneration(root: string, genId: number, registries: ReadonlyMap<string, RuntimeRegistry>): Promise<void> {
  await atomicWriteJson(generationPath(root, genId), savedRuntimes(registries), 0o600)
}

/** null when the generation predates saved runtime registries. */
export async function readRuntimeGeneration(root: string, genId: number): Promise<Map<string, RuntimeRegistry> | null> {
  let text: string
  try { text = await fsReadFile(generationPath(root, genId), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return fail('PRECONDITION_FAILED', 'the saved runtime configuration of the generation is unreadable', { stateChanged: false })
  }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return invalidState() }
  if (!object(raw) || Object.keys(raw).some(id => !UUID.test(id))) return invalidState()
  return new Map(Object.entries(raw).map(([id, value]) => [id, parseRuntimeRegistry(value)]))
}

/** Makes the saved registries exactly the target set: written for its accounts, removed for every other account. */
export async function restoreRuntimeRegistries(root: string, target: ReadonlyMap<string, RuntimeRegistry>): Promise<void> {
  const dir = join(root, RUNTIME_STATE_DIR)
  const present = (await readdir(dir).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(name => name.slice(0, -5))
  for (const id of present) if (!target.has(id)) await removeRuntimeRegistry(root, id)
  for (const [id, registry] of target) await atomicWriteJson(runtimeRegistryPath(root, id), registry, 0o600)
}

/** Called once a purged account has left the desired state. */
export async function removeRuntimeRegistry(root: string, accountId: string): Promise<void> {
  await rm(runtimeRegistryPath(root, accountId), { force: true })
}

// ---------------------------------------------------------------- dependency preflight

export type AppPreflightProblem = 'root-missing' | 'startup-missing' | 'node-modules-missing' | 'venv-missing' | 'gemfile-missing' | 'puma-missing' | 'bundle-missing' | 'not-executable'
/** The account's own files, read through the confined account file runner. */
export interface RuntimeFiles {
  list(path: string, opts?: { showHidden?: boolean }): Promise<readonly { name: string; kind: string; mode?: number }[]>
  readText(path: string): Promise<{ content: string }>
}

/** What an app still needs before it can start, with the fix the page names for each problem. */
export async function preflightApp(files: RuntimeFiles, app: Pick<RuntimeAppRecord, 'runtime' | 'root' | 'startup' | 'pythonEnv'>): Promise<AppPreflightProblem[]> {
  let modes = new Map<string, number>()
  const entries = async (dir: string): Promise<Map<string, string> | null> => {
    try { const listed = await files.list(dir, { showHidden: true }); modes = new Map(listed.map(e => [e.name, e.mode ?? 0])); return new Map(listed.map(e => [e.name, e.kind])) } catch (error) { if (isXpanelError(error) && error.code === 'NOT_FOUND') return null; throw error }
  }
  const root = await entries(app.root)
  if (!root) return ['root-missing']
  const problems: AppPreflightProblem[] = []
  const slash = app.startup.lastIndexOf('/')
  const dir = slash < 0 ? root : await entries(app.root + '/' + app.startup.slice(0, slash))
  const startup = app.startup.slice(slash + 1), present = ['file', 'symlink'].includes(dir?.get(startup) ?? '')
  if (!present) problems.push('startup-missing')
  if (app.runtime === 'go' || app.runtime === 'java') { if (app.runtime === 'go' && present && dir?.get(startup) === 'file' && ((modes.get(startup) ?? 0) & 0o100) === 0) problems.push('not-executable'); return problems }
  if (app.runtime === 'node' && root.get('package.json') === 'file' && root.get('node_modules') !== 'directory') problems.push('node-modules-missing')
  if (app.runtime === 'python' && !app.pythonEnv && root.get('.venv') !== 'directory') problems.push('venv-missing')
  if (app.runtime === 'ruby') {
    if (root.get('Gemfile') !== 'file') return [...problems, 'gemfile-missing']
    const lock = root.get('Gemfile.lock') === 'file' ? (await files.readText(app.root + '/Gemfile.lock')).content : null
    if (!(lock !== null ? /^ {4}puma \(/m.test(lock) : /^\s*gem\s+['"]puma['"]/m.test((await files.readText(app.root + '/Gemfile')).content))) problems.push('puma-missing')
    if ((await entries(app.root + '/vendor'))?.get('bundle') !== 'directory') problems.push('bundle-missing')
  }
  return problems
}

// ---------------------------------------------------------------- container image cleanup

export const podmanCleanupUnitName = (username: string): string => `xpanel-podclean-${system.assertUsername(username)}.service`
export type PodmanCleanup = { image: string } | 'prune'

/**
 * Removes one image (after its last container) or every image no container uses, in the account's own rootless
 * storage, as the account. Podman needs newuidmap and user namespaces here, so this oneshot runs with the
 * container units' isolation rather than the jailed file sandbox.
 */
export function buildPodmanCleanupCommand(account: Pick<Account, 'username' | 'uid' | 'gid' | 'home'>, action: PodmanCleanup): string[] {
  const user = system.assertUsername(account.username), home = account.home
  if (!isAccountHome(home, user) || !Number.isSafeInteger(account.uid) || !Number.isSafeInteger(account.gid) || action !== 'prune' && !system.isContainerImage(action.image)) return fail('VALIDATION', 'invalid image cleanup', { stateChanged: false })
  const runtime = system.containerRuntimeDir(user)
  const property = (value: string): string[] => ['--property', value]
  return [system.SYSTEMD_RUN_BINARY, '--unit=' + podmanCleanupUnitName(user), '--no-block', '--quiet', '--working-directory=' + home,
    ...['User=' + account.uid, 'Group=' + account.gid, 'Slice=' + system.accountSliceName(account.uid), 'Type=oneshot', 'RemainAfterExit=yes', 'TimeoutStartSec=600s',
      'RuntimeDirectory=' + runtime.slice('/run/'.length), 'RuntimeDirectoryMode=0700', 'RuntimeDirectoryPreserve=yes', 'PrivateTmp=yes', 'ProtectHome=tmpfs', 'BindPaths=' + home].flatMap(property),
    '--setenv=HOME=' + home, '--setenv=XDG_RUNTIME_DIR=' + runtime, '--setenv=TMPDIR=' + home + '/tmp', '--',
    system.PODMAN_BINARY, '--cgroup-manager=cgroupfs', 'image', ...(action === 'prune' ? ['prune', '--all', '--force'] : ['rm', '--ignore', action.image])]
}

const isPodmanCleanupCommand = (argv: readonly string[]): boolean => {
  const user = /^--unit=xpanel-podclean-([a-z][a-z0-9]{0,15})\.service$/.exec(argv[1] ?? '')?.[1]
  const uid = argv.find(v => /^User=[0-9]+$/.test(v))?.slice(5), gid = argv.find(v => /^Group=[0-9]+$/.test(v))?.slice(6)
  if (!user || !uid || !gid) return false
  const tail = argv.slice(argv.lastIndexOf('--') + 1)
  const action: PodmanCleanup = tail[3] === 'prune' ? 'prune' : { image: tail[5] ?? '' }
  try { return JSON.stringify(argv) === JSON.stringify(buildPodmanCleanupCommand({ username: user, uid: Number(uid), gid: Number(gid), home: argv.find(value => value.startsWith('--working-directory='))?.slice(20) ?? '' }, action)) } catch { return false }
}

// ---------------------------------------------------------------- account route

export interface AccountRuntimeContext {
  caller: AgentCallerIdentity
  store: {
    rootDir: string
    getAccountByUsername(username: string): Promise<Account | null>
    listDomains(): Promise<Domain[]>
    getPlan(id: string): Promise<Plan | null>
    getFeatureList(id: string): Promise<FeatureList | null>
    withAccountLifecycleLease<T>(id: string, operation: (account: Account) => Promise<T>): Promise<T>
  }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  os: OsProfile
  /** null off a Linux host: everything reads unavailable and no write is admitted */
  host: RuntimeHost | null
  /** Root drives this route for the account named in the path: Go and Java projects and Python environments. */
  asRoot?: boolean
  /** Confined reads of the account's files for the dependency preflight; null leaves it unchecked. */
  files: ((account: Account, plan: Plan) => RuntimeFiles | null) | null
  reconcile: ((actor: string) => Promise<{ status: 'noop' | 'applied' | 'failed' }>) | null
  audit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed'; principalId: string }): Promise<unknown>
}

const OPTIMIZE_FEATURE = 'optimize-website'
const unchanged = { stateChanged: false }
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const limit = (v: Limit): number | null => v === 'unlimited' ? null : v
/** Outcome of a RemainAfterExit oneshot: active means it finished cleanly. */
const oneshot = (u: UnitState | undefined): 'none' | 'running' | 'succeeded' | 'failed' => !u || u.load !== 'loaded' ? 'none' : u.active === 'active' ? 'succeeded' : u.active === 'activating' ? 'running' : u.active === 'failed' ? 'failed' : 'none'
export const runtimeStateName = (host: RuntimeHost | null, u: UnitState | undefined): RuntimeUnitStateName => {
  if (!host) return 'unknown'
  if (!u || u.load !== 'loaded') return 'stopped'
  return u.active === 'active' ? 'running' : u.active === 'activating' || u.active === 'reloading' ? 'starting' : u.active === 'failed' ? 'failed' : u.active === 'inactive' || u.active === 'deactivating' ? 'stopped' : 'unknown'
}

export interface RuntimeOpInput { account: Account; plan: Plan; disabled: readonly string[]; facts: RuntimeHostFacts; domains: readonly Domain[]; now: string; preflight?: AppPreflightProblem[] | null
  /** Ports other apps hold on this host; only root saves a project. */
  usedPorts?: ReadonlySet<number>; root?: boolean }

/** The saved-state effect of one operation; returns the same object when nothing is saved. */
export function applyRuntimeOp(op: RuntimeOp, reg: RuntimeRegistry, input: RuntimeOpInput): RuntimeRegistry {
  const feature = (key: keyof typeof RUNTIME_FEATURES): void => { if (input.disabled.includes(RUNTIME_FEATURES[key])) fail('FORBIDDEN', 'the account plan does not allow this', unchanged) }
  const runtime = (kind: system.RuntimeKind): void => { if (!input.facts.runtimes.find(r => r.kind === kind)?.available) fail('PRECONDITION_FAILED', 'this runtime is not installed on the server', { ...unchanged, reason: 'runtime_unavailable' }) }
  const app = (name: string): RuntimeAppRecord => reg.apps.find(a => a.name === name) ?? fail('NOT_FOUND', 'application not found', unchanged)
  const webApp = (name: string): RuntimeAppRecord => { const a = app(name); return a.webapp ? a : fail('CONFLICT', 'this application is not a web app', { ...unchanged, reason: 'not_web_app' }) }
  const web = (): void => { if (input.disabled.includes(WEB_APPS_FEATURE)) fail('FORBIDDEN', 'the account plan does not allow this', unchanged) }
  const container = (name: string): ContainerRecord => reg.containers.find(c => c.name === name) ?? fail('NOT_FOUND', 'container not found', unchanged)
  const engine = (): void => { if (!input.facts.containers.available) fail('PRECONDITION_FAILED', 'rootless containers are not available for this account on this server', { ...unchanged, reason: input.facts.containers.reason }) }
  switch (op.op) {
    case 'compression.save': {
      if (input.disabled.includes(OPTIMIZE_FEATURE)) return fail('FORBIDDEN', 'the account plan does not allow this', unchanged)
      const { compression: _old, ...rest } = reg
      return op.mode === 'default' ? (reg.compression ? rest : reg) : { ...rest, compression: { mode: op.mode, types: op.types, updatedAt: input.now } }
    }
    case 'webapp.stage': {
      feature('apps'); web()
      const domain = input.domains.find(d => d.id === op.app.domainId)
      if (!domain || !servesApps(input.account, domain)) return fail('NOT_FOUND', 'the domain is not an active site of this account', unchanged)
      if (reg.apps.length >= RUNTIME_LIMITS.apps) return fail('LIMIT_EXCEEDED', 'the application limit is reached', unchanged)
      if (reg.apps.some(a => a.domainId === op.app.domainId && a.path === op.app.path)) return fail('CONFLICT', 'another application already serves this domain path', { ...unchanged, reason: 'domain_in_use' })
      // A name collision gets a -N suffix, as cPanel does; the view names the app it created.
      let name = op.app.name
      for (let n = 2; reg.apps.some(a => a.name === name); n++) name = op.app.name.slice(0, 28) + '-' + n
      const record: RuntimeAppRecord = { name, runtime: 'node', root: webAppRoot(name) + (op.app.subfolder ? '/' + op.app.subfolder : ''), startup: 'server.js', domainId: op.app.domainId, path: op.app.path, env: {}, enabled: false, updatedAt: input.now,
        webapp: { source: op.app.source, category: 'server', framework: 'unknown', startCommand: null, buildCommand: null, outputDir: null, mode: 'production', deployedAt: null } }
      return { ...reg, apps: [...reg.apps, record] }
    }
    case 'webapp.configure': {
      feature('apps'); web(); runtime(op.config.category === 'static' ? 'python' : op.config.runtime); assertWebAppConfig(op.config)
      const a = webApp(op.name), domain = input.domains.find(d => d.id === op.config.domainId)
      if (!domain || !servesApps(input.account, domain)) return fail('NOT_FOUND', 'the domain is not an active site of this account', unchanged)
      if (reg.apps.some(x => x.name !== a.name && x.domainId === op.config.domainId && x.path === op.config.path)) return fail('CONFLICT', 'another application already serves this domain path', { ...unchanged, reason: 'domain_in_use' })
      const { domainId, path, runtime: kind, startup, env, ...rest } = op.config
      return { ...reg, apps: reg.apps.map(x => x.name === a.name ? { ...a, domainId, path, runtime: kind, startup, env, updatedAt: input.now, webapp: { ...a.webapp!, category: rest.category, framework: rest.framework, startCommand: rest.startCommand, buildCommand: rest.buildCommand, outputDir: rest.outputDir } } : x) }
    }
    case 'webapp.deploy': case 'webapp.redeploy': {
      feature('apps'); web()
      const a = webApp(op.name)
      runtime(a.webapp!.category === 'static' ? 'python' : a.runtime)
      if (a.webapp!.category === 'static' && !a.webapp!.outputDir) fail('PRECONDITION_FAILED', 'configure the application before deploying it', { ...unchanged, reason: 'not_configured' })
      return { ...reg, apps: reg.apps.map(x => x.name === a.name ? { ...a, enabled: true, updatedAt: input.now, webapp: { ...a.webapp!, deployedAt: input.now } } : x) }
    }
    case 'webapp.mode': {
      feature('apps'); web()
      const a = webApp(op.name)
      if (a.webapp!.category === 'static') fail('VALIDATION', 'a static application has no run mode', { ...unchanged, reason: 'INVALID_CATEGORY' })
      return a.webapp!.mode === op.mode ? reg : { ...reg, apps: reg.apps.map(x => x.name === a.name ? { ...a, updatedAt: input.now, webapp: { ...a.webapp!, mode: op.mode } } : x) }
    }
    case 'project.save': {
      if (!input.root) return fail('FORBIDDEN', 'only root saves Go and Java projects', unchanged)
      feature('apps'); runtime(op.app.runtime)
      const domain = input.domains.find(d => d.id === op.app.domainId)
      if (!domain || !servesApps(input.account, domain)) return fail('NOT_FOUND', 'the domain is not an active site of this account', unchanged)
      const existing = reg.apps.find(a => a.name === op.app.name)
      if (existing && !existing.project) return fail('CONFLICT', 'another kind of application has this name', { ...unchanged, reason: 'name_in_use' })
      if (!existing && reg.apps.length >= RUNTIME_LIMITS.apps) return fail('LIMIT_EXCEEDED', 'the application limit is reached', unchanged)
      if (reg.apps.some(a => a.name !== op.app.name && a.domainId === op.app.domainId && a.path === op.app.path)) return fail('CONFLICT', 'another application already serves this domain path', { ...unchanged, reason: 'domain_in_use' })
      const javaBinary = op.app.runtime === 'java' && op.app.jdk ? input.facts.jdks.find(j => j.version === op.app.jdk)?.binary ?? null : null
      if (op.app.jdk && !javaBinary) return fail('PRECONDITION_FAILED', 'this JDK is not installed on the server', { ...unchanged, reason: 'RUNTIME_MISSING' })
      const taken = input.usedPorts ?? new Set<number>(), own = existing?.project?.port
      const port = op.app.port ?? own ?? nextAppPort(new Set([...taken, ...reg.apps.flatMap(a => a.project ? [a.project.port] : [])]))
      if (taken.has(port) && port !== own || reg.apps.some(a => a.name !== op.app.name && a.project?.port === port)) return fail('CONFLICT', 'another project holds this port', { ...unchanged, reason: 'port_in_use' })
      const record: RuntimeAppRecord = { name: op.app.name, runtime: op.app.runtime, root: op.app.root, startup: op.app.startup, domainId: op.app.domainId, path: op.app.path, env: { ...op.app.env }, enabled: existing?.enabled ?? false, updatedAt: input.now,
        project: { port, openPort: op.app.openPort, jdk: op.app.jdk, javaBinary, command: op.app.command } }
      return { ...reg, apps: existing ? reg.apps.map(a => a.name === op.app.name ? record : a) : [...reg.apps, record] }
    }
    case 'pyenv.create': {
      if (!input.root) return fail('FORBIDDEN', 'only root creates Python environments', unchanged)
      if (!input.facts.python.find(p => p.version === op.version)?.installed) return fail('PRECONDITION_FAILED', 'this Python version is not installed on the server', { ...unchanged, reason: 'RUNTIME_MISSING' })
      const envs = reg.pythonEnvs ?? []
      if (envs.some(e => e.name === op.name)) return fail('CONFLICT', 'an environment with this name exists', { ...unchanged, reason: 'env_exists' })
      if (envs.length >= RUNTIME_LIMITS.pythonEnvs) return fail('LIMIT_EXCEEDED', 'the environment limit is reached', unchanged)
      return { ...reg, pythonEnvs: [...envs, { name: op.name, version: op.version, updatedAt: input.now }] }
    }
    case 'pyenv.remove': {
      if (!input.root) return fail('FORBIDDEN', 'only root removes Python environments', unchanged)
      if (!reg.pythonEnvs?.some(e => e.name === op.name)) return fail('NOT_FOUND', 'environment not found', unchanged)
      if (reg.apps.some(a => a.pythonEnv === op.name)) return fail('CONFLICT', 'an application uses this environment', { ...unchanged, reason: 'env_in_use' })
      return { ...reg, pythonEnvs: reg.pythonEnvs.filter(e => e.name !== op.name) }
    }
    case 'app.save': {
      feature('apps'); runtime(op.app.runtime)
      if (op.app.pythonEnv && !reg.pythonEnvs?.some(e => e.name === op.app.pythonEnv)) return fail('NOT_FOUND', 'this Python environment does not exist', { ...unchanged, reason: 'env_missing' })
      const domain = input.domains.find(d => d.id === op.app.domainId)
      if (!domain || !servesApps(input.account, domain)) return fail('NOT_FOUND', 'the domain is not an active site of this account', unchanged)
      const existing = reg.apps.find(a => a.name === op.app.name)
      if (existing?.webapp) return fail('CONFLICT', 'a web app is configured through its own settings', { ...unchanged, reason: 'web_app' })
      if (!existing && reg.apps.length >= RUNTIME_LIMITS.apps) return fail('LIMIT_EXCEEDED', 'the application limit is reached', unchanged)
      if (reg.apps.some(a => a.name !== op.app.name && a.domainId === op.app.domainId && a.path === op.app.path)) return fail('CONFLICT', 'another application already serves this domain path', unchanged)
      // A new application is saved stopped: install its dependencies, then start it.
      const { pythonEnv, ...fields } = op.app
      const record: RuntimeAppRecord = { ...fields, env: { ...op.app.env }, enabled: existing?.enabled ?? false, updatedAt: input.now, ...(pythonEnv ? { pythonEnv } : {}) }
      return { ...reg, apps: existing ? reg.apps.map(a => a.name === op.app.name ? record : a) : [...reg.apps, record] }
    }
    case 'app.start': case 'app.stop': {
      const a = app(op.name), enabled = op.op === 'app.start'
      if (enabled && a.webapp && !a.webapp.deployedAt) fail('PRECONDITION_FAILED', 'deploy the application first', { ...unchanged, reason: 'not_deployed' })
      if (enabled) {
        feature('apps'); runtime(a.webapp?.category === 'static' ? 'python' : a.runtime)
        if (input.preflight?.length) fail('PRECONDITION_FAILED', 'the application is not ready to start', { ...unchanged, reason: 'preflight', problems: input.preflight })
      }
      return a.enabled === enabled ? reg : { ...reg, apps: reg.apps.map(x => x.name === a.name ? { ...x, enabled, updatedAt: input.now } : x) }
    }
    case 'app.remove': app(op.name); return { ...reg, apps: reg.apps.filter(a => a.name !== op.name) }
    case 'app.restart': { const a = app(op.name); if (!a.enabled) fail('PRECONDITION_FAILED', 'start the application first', unchanged); return reg }
    case 'app.deps': {
      feature('apps'); runtime(app(op.name).runtime)
      if (app(op.name).project) return fail('PRECONDITION_FAILED', 'a project runs a built file; it has no dependency step', { ...unchanged, reason: 'no_dependency_step' })
      if (input.preflight?.some(p => p === 'root-missing' || p === 'gemfile-missing')) fail('PRECONDITION_FAILED', 'the application files are not ready for a dependency install', { ...unchanged, reason: 'preflight', problems: input.preflight })
      return reg
    }
    case 'cache.save': {
      feature('cache')
      const fact = input.facts.cache.find(c => c.service === op.service)!, existing = reg.cache[op.service]
      if (op.enabled && !fact.available) return fail('PRECONDITION_FAILED', op.service + ' is not installed on the server', { ...unchanged, reason: 'cache_unavailable' })
      const cap = cacheCapMb(input.plan.resources.memoryMb)
      if (op.memoryMb > cap) return fail('LIMIT_EXCEEDED', 'the plan allows at most ' + cap + ' MB of cache memory', { ...unchanged, maxMb: cap })
      const binary = fact.binary ?? existing?.binary ?? CACHE_BINARIES[op.service][0]!
      if (existing && existing.enabled === op.enabled && existing.memoryMb === op.memoryMb && existing.binary === binary) return reg
      return { ...reg, cache: { ...reg.cache, [op.service]: { enabled: op.enabled, memoryMb: op.memoryMb, binary, updatedAt: input.now } } }
    }
    case 'cache.flush': if (!reg.cache[op.service]?.enabled) fail('PRECONDITION_FAILED', 'enable the cache first', unchanged); return reg
    case 'container.run': {
      feature('containers'); engine()
      if (reg.containers.some(c => c.name === op.container.name)) return fail('CONFLICT', 'a container with this name exists', unchanged)
      if (reg.containers.length >= RUNTIME_LIMITS.containers) return fail('LIMIT_EXCEEDED', 'the container limit is reached', unchanged)
      return { ...reg, containers: [...reg.containers, { ...op.container, env: { ...op.container.env }, enabled: true, updatedAt: input.now }] }
    }
    case 'container.start': case 'container.stop': {
      const c = container(op.name), enabled = op.op === 'container.start'
      if (enabled) { feature('containers'); engine() }
      return c.enabled === enabled ? reg : { ...reg, containers: reg.containers.map(x => x.name === c.name ? { ...x, enabled, updatedAt: input.now } : x) }
    }
    case 'container.remove': container(op.name); return { ...reg, containers: reg.containers.filter(c => c.name !== op.name) }
    case 'container.restart': if (!container(op.name).enabled) fail('PRECONDITION_FAILED', 'start the container first', unchanged); return reg
    case 'container.prune': engine(); return reg
  }
}

/** Lowest free private port; every port of the range taken is a host at its limit. */
const nextAppPort = (taken: ReadonlySet<number>): number => {
  for (let port = system.APP_PORT_RANGE.min; port <= system.APP_PORT_RANGE.max; port++) if (!taken.has(port)) return port
  return fail('LIMIT_EXCEEDED', 'every private application port is in use', unchanged)
}
/** Ports saved on the whole host, read from every registry file. */
export async function savedAppPorts(root: string, exceptAccountId: string): Promise<Set<number>> {
  const ports = new Set<number>(), dir = join(root, RUNTIME_STATE_DIR)
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name) || name === exceptAccountId + '.json') continue
    for (const app of (await readRuntimeRegistry(root, name.slice(0, -5))).apps) if (app.project) ports.add(app.project.port)
  }
  return ports
}

async function buildRuntimeView(ctx: AccountRuntimeContext, account: Account, plan: Plan, disabled: readonly string[]): Promise<AccountRuntimeClientView> {
  const reg = await readRuntimeRegistry(ctx.store.rootDir, account.id)
  const facts = await readRuntimeHostFacts(ctx.host, account)
  const sites = (await ctx.store.listDomains()).filter(d => servesApps(account, d)).sort((a, b) => a.name.localeCompare(b.name, 'en')).slice(0, 1000)
  const appUnits = reg.apps.map(a => ({ a, p: system.appPaths(account.username, a.name), deps: depsUnitName(account.username, a.name) }))
  const cacheUnits = system.CACHE_SERVICES.map(s => ({ s, p: system.cachePaths(account, s) }))
  const ctrUnits = reg.containers.map(c => ({ c, unit: system.containerUnitName(account.username, c.name) }))
  const cleanupUnit = podmanCleanupUnitName(account.username)
  const stacks = (reg.stacks ?? []).map(stack => ({ stack, services: parseComposeServices(stack.name, stack.yaml, stack.env) }))
  const stackUnitList = stacks.flatMap(({ stack, services }) => services.map(service => system.containerUnitName(account.username, stackServiceName(stack.name, service.name))))
  const webUnits = reg.apps.filter(a => a.webapp).flatMap(a => [stageUnitName(account.username, a.name), deployUnitName(account.username, a.name)])
  const states = await readUnitStates(ctx.host, [...appUnits.flatMap(x => [x.p.service, x.deps]), ...webUnits, ...cacheUnits.map(x => x.p.unit), ...ctrUnits.map(x => x.unit), ...stackUnitList, cleanupUnit])
  const files = ctx.files?.(account, plan) ?? null
  const cap = cacheCapMb(plan.resources.memoryMb)
  const apps = await Promise.all(appUnits.map(async ({ a, p, deps }) => {
    const s = states.get(p.service), state = runtimeStateName(ctx.host, s), d = states.get(deps), domain = sites.find(x => x.id === a.domainId)
    const health = ctx.host && state === 'running' && domain ? await ctx.host.probe(p.proxySocket, domain.name, a.path === '/' ? '' : a.path).catch(() => null) : null
    const preflight = files && !a.webapp ? await preflightApp(files, a).catch(() => null) : null
    const web = a.webapp ? webAppStatus({ enabled: a.enabled, webapp: a.webapp }, state, oneshot(states.get(stageUnitName(account.username, a.name))), oneshot(states.get(deployUnitName(account.username, a.name)))) : null
    const detected = files && a.webapp && !a.webapp.deployedAt && web?.status !== 'staging' ? await readWebAppDetection(files, a.root).catch(() => null) : null
    return { webapp: a.webapp ? { ...a.webapp, ...web!, detected } : null, name: a.name, runtime: a.runtime, root: a.root, startup: a.startup, domainId: a.domainId, path: a.path, env: Object.entries(a.env).map(([name, value]) => ({ name, value })), enabled: a.enabled, state,
      since: state === 'running' ? s?.since ?? null : null, restarts: s?.restarts ?? null, health,
      deps: oneshot(d), preflight, updatedAt: a.updatedAt, pythonEnv: a.pythonEnv ?? null, project: a.project ? { port: a.project.port, openPort: a.project.openPort, jdk: a.project.jdk, command: a.project.command } : null }
  }))
  return {
    context: { accountId: account.id, username: account.username, home: account.home },
    revision: runtimeRevision(reg),
    plan: { apps: !disabled.includes(RUNTIME_FEATURES.apps), cache: !disabled.includes(RUNTIME_FEATURES.cache) && cap >= 8, containers: !disabled.includes(RUNTIME_FEATURES.containers), cacheMaxMb: cap,
      memoryMb: limit(plan.resources.memoryMb), cpuPercent: limit(plan.resources.cpuPercent), maxProcesses: limit(plan.resources.maxProcesses), maxApps: RUNTIME_LIMITS.apps, maxContainers: RUNTIME_LIMITS.containers },
    host: { runtimes: facts.runtimes.filter((r): r is typeof r & { kind: AppRuntimeKindName } => r.kind !== 'go' && r.kind !== 'java'), cache: facts.cache, containers: facts.containers },
    domains: sites.map(d => ({ id: d.id, name: d.name })),
    apps,
    cache: cacheUnits.map(({ s, p }) => {
      const r = reg.cache[s], u = states.get(p.unit), state = runtimeStateName(ctx.host, u)
      return { service: s, enabled: r?.enabled ?? false, memoryMb: r?.memoryMb ?? null, socket: p.socket, state, since: state === 'running' ? u?.since ?? null : null, memoryBytes: state === 'running' ? u?.memoryBytes ?? null : null, updatedAt: r?.updatedAt ?? null }
    }),
    imageCleanup: oneshot(states.get(cleanupUnit)),
    // No YAML or env here: the env holds what root put there, and the owner only needs what runs under the account.
    stacks: stacks.map(({ stack, services }) => ({ name: stack.name, app: stack.app, enabled: stack.enabled, services: services.map((service, index) => ({ name: service.name, image: service.image, state: runtimeStateName(ctx.host, states.get(system.containerUnitName(account.username, stackServiceName(stack.name, service.name)))), ports: index === 0 ? services.flatMap(s => s.ports).map(p => `${p.bind}:${p.host}->${p.container}/${p.protocol}`) : [] })) })),
    compression: reg.compression ? { mode: reg.compression.mode, types: reg.compression.types } : null,
    containers: ctrUnits.map(({ c, unit }) => {
      const u = states.get(unit), state = runtimeStateName(ctx.host, u)
      return { name: c.name, image: c.image, envKeys: Object.keys(c.env), enabled: c.enabled, state, since: state === 'running' ? u?.since ?? null : null, memoryBytes: state === 'running' ? u?.memoryBytes ?? null : null, cpuNs: u?.cpuNs ?? null, restarts: u?.restarts ?? null, updatedAt: c.updatedAt }
    }),
  }
}

let portWrites: Promise<unknown> = Promise.resolve()
const inPortOrder = <T>(task: () => Promise<T>): Promise<T> => { const run = portWrites.then(task, task); portWrites = run.catch(() => undefined); return run }

export async function handleAccountRuntimeRoute(req: Request, url: URL, method: string, ctx: AccountRuntimeContext): Promise<Response | null> {
  const match = /^\/accounts\/([a-z][a-z0-9]{0,15})\/runtime(\/log)?$/.exec(url.pathname)
  if (!match) return null
  const log = match[2] === '/log'
  if (log ? method !== 'GET' : method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: log ? 'GET' : 'GET, POST' } })
  const caller = ctx.caller
  const asRoot = ctx.asRoot === true
  if (!asRoot && (caller.role !== 'user' || !caller.accountId)) return fail('FORBIDDEN', 'runtime services require the signed-in account owner', unchanged)
  const target = await ctx.store.getAccountByUsername(match[1]!)
  if (!target || !asRoot && target.id !== caller.accountId) return fail('FORBIDDEN', 'the account does not match the current owner', unchanged)
  const assertAuthority = async (): Promise<void> => {
    const principal = await ctx.currentPrincipal()
    if (asRoot) { if (!principal || principal.disabled || principal.kind !== 'root' || principal.id !== caller.principalId) return fail('FORBIDDEN', 'root is not authorized for runtime services', unchanged); return }
    if (!principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== target.id || principal.username !== target.username) return fail('FORBIDDEN', 'current account owner is not authorized for runtime services', unchanged)
  }
  const policy = async (account: Account): Promise<{ plan: Plan; disabled: readonly string[] }> => {
    const plan = await ctx.store.getPlan(account.planId), features = plan ? await ctx.store.getFeatureList(plan.featureListId) : null
    if (account.status !== 'active' || !plan || !features || Object.values(RUNTIME_FEATURES).every(f => features.disabled.includes(f))) return fail('FORBIDDEN', 'this account is not active or its plan allows no runtime services', unchanged)
    return { plan: effectivePlan(plan, account), disabled: features.disabled }
  }
  await assertAuthority()
  const root = ctx.store.rootDir
  if (log) {
    const params = [...url.searchParams.keys()], wanted = url.searchParams.get('target') ?? ''
    const t = RUNTIME_LOG_TARGET.exec(wanted)
    if (params.length !== 1 || params[0] !== 'target' || !t) return fail('VALIDATION', 'choose one application, container or cache log', unchanged)
    const reg = await ctx.store.withAccountLifecycleLease(target.id, async account => { await policy(account); return readRuntimeRegistry(root, account.id) })
    const kind = t[1], name = t[2]
    if ((kind === 'app' || kind === 'deps' || kind === 'stage' || kind === 'deploy') && !reg.apps.some(a => a.name === name) || kind === 'ctr' && !reg.containers.some(c => c.name === name) && !(reg.stacks ?? []).some(stack => parseComposeServices(stack.name, stack.yaml, stack.env).some(service => stackServiceName(stack.name, service.name) === name))) return fail('NOT_FOUND', 'nothing with this name is saved', unchanged)
    const unit = kind === 'app' ? system.appPaths(target.username, name!).service : kind === 'deps' ? depsUnitName(target.username, name!) : kind === 'stage' ? stageUnitName(target.username, name!) : kind === 'deploy' ? deployUnitName(target.username, name!) : kind === 'ctr' ? system.containerUnitName(target.username, name!) : system.cachePaths(target, t[3] as system.CacheService).unit
    if (!ctx.host) return fail('PRECONDITION_FAILED', 'logs are unavailable on this server', unchanged)
    const r = await ctx.host.run(['/usr/bin/journalctl', '--unit=' + unit, '--lines=200', '--no-pager', '--output=short-iso', '--utc', '--quiet'])
    if (!r.ok) return fail('PRECONDITION_FAILED', 'the log could not be read', unchanged)
    await assertAuthority()
    return json(200, { target: wanted, unit, lines: r.stdout.split('\n').filter(Boolean).slice(-200).map(line => line.slice(0, 2000)) })
  }
  if (method === 'GET') {
    if (url.search) return fail('VALIDATION', 'the runtime view takes no selectors', unchanged)
    const view = await ctx.store.withAccountLifecycleLease(target.id, async account => { const p = await policy(account); return buildRuntimeView(ctx, account, p.plan, p.disabled) })
    await assertAuthority()
    return json(200, view)
  }
  if (url.search) return fail('VALIDATION', 'runtime operations take no selectors', unchanged)
  const text = await req.text()
  let raw: unknown
  try { raw = text.length <= 65536 ? JSON.parse(text) : null } catch { raw = null }
  const op = readRuntimeOp(raw)
  if (!ctx.host || !ctx.reconcile) return fail('PRECONDITION_FAILED', 'runtime services need a Linux host with the reconciler', unchanged)
  const host = ctx.host, reconcile = ctx.reconcile
  const facts = await readRuntimeHostFacts(host, target)
  let preflight: AppPreflightProblem[] | null = null
  if (op.op === 'project.save' && ctx.files) {
    const plan = await ctx.store.getPlan(target.planId), files = plan ? ctx.files(target, plan) : null
    const problems = files ? await preflightApp(files, { ...op.app, pythonEnv: undefined as never }).catch(() => [] as AppPreflightProblem[]) : []
    if (problems.includes('not-executable')) return fail('VALIDATION', 'this file has no execute permission', { ...unchanged, reason: 'NOT_EXECUTABLE' })
    if (problems.includes('root-missing') || problems.includes('startup-missing')) return fail('VALIDATION', 'the project file does not exist', { ...unchanged, reason: 'preflight', problems })
  }
  if ((op.op === 'app.start' || op.op === 'app.deps') && ctx.files) {
    const plan = await ctx.store.getPlan(target.planId), saved = (await readRuntimeRegistry(root, target.id)).apps.find(a => a.name === op.name)
    const files = plan ? ctx.files(target, plan) : null
    if (files && saved) preflight = await preflightApp(files, saved)
  }
  const path = runtimeRegistryPath(root, target.id)
  if (op.op === 'webapp.deploy' || op.op === 'webapp.redeploy') {
    const unit = deployUnitName(target.username, op.name)
    if (oneshot((await readUnitStates(host, [unit])).get(unit)) === 'running') return json(202, { op: op.op, revision: runtimeRevision(await readRuntimeRegistry(root, target.id)), changed: false })
  }
  // Ports are unique across accounts, so a save runs one at a time on the whole host.
  const { before, next } = await (op.op === 'project.save' ? inPortOrder : <T>(task: () => Promise<T>) => task())(() => ctx.store.withAccountLifecycleLease(target.id, async account => {
    await assertAuthority()
    const { plan, disabled } = await policy(account)
    const before = await readRuntimeRegistry(root, account.id)
    if (runtimeRevision(before) !== op.expectedRevision) return fail('CONFLICT', 'runtime configuration changed; read it again', unchanged)
    if (op.op === 'container.run') assertTrustedImage(await readCtrPolicy(root), op.container.image)
    const next = applyRuntimeOp(op, before, { account, plan, disabled, facts, domains: await ctx.store.listDomains(), now: new Date().toISOString(), preflight, root: asRoot, ...(op.op === 'project.save' ? { usedPorts: await savedAppPorts(root, account.id) } : {}) })
    if (next !== before) await atomicWriteJson(path, next, 0o600)
    return { before, next }
  }))
  const auditEntry = (outcome: 'ok' | 'failed', detail: Record<string, unknown>) => ctx.audit({ actor: caller.actor, principalId: caller.principalId, action: 'account.runtime.' + op.op, target: 'account:' + target.username, outcome, detail }).catch(() => {})
  const subject = 'name' in op ? op.name : 'service' in op ? op.service : op.op === 'app.save' || op.op === 'webapp.stage' || op.op === 'project.save' ? op.app.name : op.op === 'compression.save' ? op.mode : op.op === 'container.run' ? op.container.name : 'images'
  if (next !== before) {
    const applied = await reconcile(caller.actor).catch(() => ({ status: 'failed' as const }))
    if (applied.status === 'failed') {
      // Restore the saved state so one bad entry can never block every later reconciliation.
      await ctx.store.withAccountLifecycleLease(target.id, async () => { if (runtimeRevision(await readRuntimeRegistry(root, target.id)) === runtimeRevision(next)) await atomicWriteJson(path, before, 0o600) })
      const restored = await reconcile(caller.actor).catch(() => ({ status: 'failed' as const }))
      await auditEntry('failed', { subject, restored: restored.status !== 'failed' })
      return fail('CONFIG_TEST_FAILED', 'the change did not pass the server configuration tests and was undone', restored.status === 'failed' ? { stateChanged: true, verificationRequired: true } : unchanged)
    }
  }
  try {
    if (op.op === 'app.restart' || op.op === 'webapp.mode' && next !== before && next.apps.find(a => a.name === op.name)?.enabled || (op.op === 'app.save' || op.op === 'project.save') && next.apps.find(a => a.name === op.app.name)?.enabled) await host.systemd('restart', system.appPaths(target.username, op.op === 'app.save' || op.op === 'project.save' ? op.app.name : op.name).service)
    if (op.op === 'container.restart') await host.systemd('restart', system.containerUnitName(target.username, op.name))
    if (op.op === 'cache.flush' || op.op === 'cache.save' && next !== before && next.cache[op.service]?.enabled) await host.systemd('restart', system.cachePaths(target, op.service).unit)
    const cleanup = op.op === 'container.prune' ? 'prune' as const
      : op.op === 'container.remove' && next !== before ? (() => { const image = before.containers.find(c => c.name === op.name)!.image; return next.containers.some(c => c.image === image) ? null : { image } })() : null
    if (cleanup) {
      // The removed container's unit stopped in the reconcile above, so its image is no longer in use.
      const unit = podmanCleanupUnitName(target.username)
      await host.systemd('stop', unit).catch(() => {})
      await host.systemd('reset-failed', unit).catch(() => {})
      const started = await host.run(buildPodmanCleanupCommand(target, cleanup))
      if (!started.ok) return fail('PRECONDITION_FAILED', 'the image cleanup could not be started', { stateChanged: next !== before })
    }
    if (op.op === 'webapp.stage') {
      const created = next.apps.at(-1)!
      await host.systemd('reset-failed', stageUnitName(target.username, created.name)).catch(() => {})
      const started = await host.run(buildStageCommand(target, created.name, created.webapp!.source))
      if (!started.ok) return fail('PRECONDITION_FAILED', 'staging could not be started', { stateChanged: true, verificationRequired: true })
    }
    if (op.op === 'webapp.deploy' || op.op === 'webapp.redeploy') {
      const unit = deployUnitName(target.username, op.name), app = next.apps.find(a => a.name === op.name)!
      await host.systemd('stop', system.appPaths(target.username, app.name).service)
      await host.systemd('stop', unit).catch(() => {})
      await host.systemd('reset-failed', unit).catch(() => {})
      const started = await host.run(buildDeployCommand(target, app, deployScript({ ...app, webapp: app.webapp! }, op.op === 'webapp.redeploy')))
      if (!started.ok) return fail('PRECONDITION_FAILED', 'the deployment could not be started', { stateChanged: true, verificationRequired: true })
    }
    if (op.op === 'pyenv.create' || op.op === 'pyenv.remove') {
      const unit = pythonEnvUnitName(target.username, op.name)
      await host.systemd('stop', unit).catch(() => {})
      await host.systemd('reset-failed', unit).catch(() => {})
      const started = await host.run(buildPythonEnvCommand(target, op.name, op.op === 'pyenv.create' ? op.version : null))
      if (!started.ok) return fail('PRECONDITION_FAILED', 'the environment job could not be started', { stateChanged: true, verificationRequired: true })
    }
    if (op.op === 'app.deps') {
      const unit = depsUnitName(target.username, op.name), app = next.apps.find(a => a.name === op.name)!
      await host.systemd('stop', unit).catch(() => {})
      await host.systemd('reset-failed', unit).catch(() => {})
      const started = await host.run(buildDepsCommand(target, app))
      if (!started.ok) return fail('PRECONDITION_FAILED', 'the dependency install could not be started', { stateChanged: false })
    }
  } catch {
    await auditEntry('failed', { subject })
    return fail('SERVICE_UNAVAILABLE', 'the saved change is applied but the service did not restart; read its log', { stateChanged: next !== before, verificationRequired: true })
  }
  await auditEntry('ok', { subject })
  return json(op.op === 'app.deps' || op.op === 'container.prune' || op.op === 'webapp.stage' || op.op === 'webapp.deploy' || op.op === 'webapp.redeploy' || op.op === 'pyenv.create' || op.op === 'pyenv.remove' ? 202 : 200, { op: op.op, revision: runtimeRevision(next), changed: next !== before })
}

/** Production host: commands through the executor's reviewed argv admission, probes over root-owned front sockets only. */
export function createRuntimeHost(executor: Pick<AgentExecutor, 'runCommand' | 'runAction'>): RuntimeHost {
  return {
    exists: async path => { try { await stat(path); return true } catch { return false } },
    run: argv => executor.runCommand(argv),
    systemd: async (verb, unit) => {
      if (verb !== 'reset-failed') return executor.runAction({ kind: 'systemd', verb, unit })
      const r = await executor.runCommand(['/usr/bin/systemctl', 'reset-failed', '--', unit])
      if (!r.ok) fail('CONFIG_TEST_FAILED', 'systemctl reset-failed failed', { unit })
    },
    probe: (socket, host, path) => {
      if (!socket.startsWith(system.APP_PROXY_SOCKET_DIR + '/')) return Promise.resolve(null)
      return new Promise(resolve => {
        let head = ''
        const done = (status: number | null): void => { clearTimeout(timer); client.destroy(); resolve(status) }
        const client = connect(socket, () => client.write('GET ' + path + '/ HTTP/1.1\r\nHost: ' + host + '\r\nUser-Agent: xpanel-health\r\nConnection: close\r\n\r\n'))
        const timer = setTimeout(() => done(null), 3000)
        client.on('data', chunk => { head += chunk.toString('latin1'); const m = /^HTTP\/1\.[01] ([1-5]\d\d)/.exec(head); if (m) done(Number(m[1])); else if (head.length > 64) done(null) })
        client.on('error', () => done(null))
        client.on('end', () => done(null))
      })
    },
    readText: path => fsReadFile(path, 'utf8').catch(() => null),
  }
}
