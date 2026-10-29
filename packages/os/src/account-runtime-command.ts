import { fail } from '@xpanel/core'

/** Public grammar of the account runtime view (apps, caches, containers) and its operations, shared by agent, API and browser. */
export type RuntimeKindName = 'node' | 'python' | 'ruby'
export type CacheServiceName = 'redis' | 'memcached'
export type RuntimeUnitStateName = 'running' | 'starting' | 'stopped' | 'failed' | 'unknown'
export type RuntimeOneshotState = 'none' | 'running' | 'succeeded' | 'failed'
export type AppPreflightProblemName = 'root-missing' | 'startup-missing' | 'node-modules-missing' | 'venv-missing' | 'gemfile-missing' | 'puma-missing' | 'bundle-missing'
export interface AccountRuntimeClientView {
  context: { accountId: string; username: string; home: string }
  revision: string
  plan: { apps: boolean; cache: boolean; containers: boolean; cacheMaxMb: number; memoryMb: number | null; cpuPercent: number | null; maxProcesses: number | null; maxApps: number; maxContainers: number }
  host: {
    runtimes: { kind: RuntimeKindName; available: boolean; version: string | null; reason: null | 'not-installed' | 'proxy-unavailable' | 'bundler-missing' | 'venv-missing' }[]
    cache: { service: CacheServiceName; available: boolean; version: string | null; binary: string | null; reason: null | 'not-installed' }[]
    containers: { available: boolean; version: string | null; reason: null | 'not-installed' | 'newuidmap-missing' | 'no-subordinate-ids' }
  }
  domains: { id: string; name: string }[]
  apps: { name: string; runtime: RuntimeKindName; root: string; startup: string; domainId: string; path: string; env: { name: string; value: string }[]; enabled: boolean; state: RuntimeUnitStateName; since: string | null; restarts: number | null; health: number | null; deps: RuntimeOneshotState; preflight: AppPreflightProblemName[] | null; updatedAt: string }[]
  cache: { service: CacheServiceName; enabled: boolean; memoryMb: number | null; socket: string; state: RuntimeUnitStateName; since: string | null; memoryBytes: number | null; updatedAt: string | null }[]
  imageCleanup: RuntimeOneshotState
  containers: { name: string; image: string; envKeys: string[]; enabled: boolean; state: RuntimeUnitStateName; since: string | null; memoryBytes: number | null; cpuNs: number | null; restarts: number | null; updatedAt: string }[]
}

export type RuntimeOp =
  | { op: 'app.save'; expectedRevision: string; app: { name: string; runtime: RuntimeKindName; root: string; startup: string; domainId: string; path: string; env: Record<string, string> } }
  | { op: 'app.start' | 'app.stop' | 'app.restart' | 'app.remove' | 'app.deps'; expectedRevision: string; name: string }
  | { op: 'cache.save'; expectedRevision: string; service: CacheServiceName; enabled: boolean; memoryMb: number }
  | { op: 'cache.flush'; expectedRevision: string; service: CacheServiceName }
  | { op: 'container.run'; expectedRevision: string; container: { name: string; image: string; env: Record<string, string> } }
  | { op: 'container.start' | 'container.stop' | 'container.restart' | 'container.remove'; expectedRevision: string; name: string }
  | { op: 'container.prune'; expectedRevision: string }

export const RUNTIME_LOG_TARGET = /^(app|deps|ctr):([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)$|^cache:(redis|memcached)$/

/** Strict request grammar; the agent re-checks every value against the account, plan and host. */
export function readRuntimeOp(value: unknown): RuntimeOp {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const keys = (item: Record<string, unknown>, list: string[]): boolean => Object.keys(item).sort().join() === [...list].sort().join()
  const bad = (): never => fail('VALIDATION', 'invalid runtime operation', { stateChanged: false })
  const name = (item: unknown): item is string => typeof item === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(item)
  const rel = (item: unknown, max: number): item is string => typeof item === 'string' && item.length <= 512 && item.split('/').length <= max && item.split('/').every(s => /^[A-Za-z0-9._+-]{1,128}$/.test(s) && s !== '.' && s !== '..')
  const env = (item: unknown): Record<string, string> => {
    if (!object(item) || Object.keys(item).length > 32) return bad()
    for (const [k, v] of Object.entries(item)) if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) || ['PORT', 'BUNDLE_GEMFILE', 'BUNDLE_PATH'].includes(k) || typeof v !== 'string' || v.length > 1024 || /[\u0000-\u001f\u007f]/.test(v)) return bad()
    return { ...item }
  }
  if (!object(value) || typeof value.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedRevision) || typeof value.op !== 'string') return bad()
  const r = value.expectedRevision, op = value.op
  if (op === 'app.save') {
    const a = value.app
    if (!keys(value, ['op', 'expectedRevision', 'app']) || !object(a) || !keys(a, ['name', 'runtime', 'root', 'startup', 'domainId', 'path', 'env']) || !name(a.name) || !['node', 'python', 'ruby'].includes(a.runtime) || !rel(a.root, 8) || !rel(a.startup, 4)
      || typeof a.domainId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a.domainId) || typeof a.path !== 'string' || !/^\/(?:[a-z0-9][a-z0-9._-]{0,62}(?:\/[a-z0-9][a-z0-9._-]{0,62}){0,3})?$/.test(a.path)) return bad()
    return { op, expectedRevision: r, app: { name: a.name, runtime: a.runtime, root: a.root, startup: a.startup, domainId: a.domainId, path: a.path, env: env(a.env) } }
  }
  if (['app.start', 'app.stop', 'app.restart', 'app.remove', 'app.deps', 'container.start', 'container.stop', 'container.restart', 'container.remove'].includes(op)) {
    if (!keys(value, ['op', 'expectedRevision', 'name']) || !name(value.name)) return bad()
    return { op, expectedRevision: r, name: value.name } as RuntimeOp
  }
  if (op === 'cache.save') {
    if (!keys(value, ['op', 'expectedRevision', 'service', 'enabled', 'memoryMb']) || !['redis', 'memcached'].includes(value.service) || typeof value.enabled !== 'boolean' || !Number.isInteger(value.memoryMb) || value.memoryMb < 8 || value.memoryMb > 4096) return bad()
    return { op, expectedRevision: r, service: value.service, enabled: value.enabled, memoryMb: value.memoryMb }
  }
  if (op === 'container.prune') {
    if (!keys(value, ['op', 'expectedRevision'])) return bad()
    return { op, expectedRevision: r }
  }
  if (op === 'cache.flush') {
    if (!keys(value, ['op', 'expectedRevision', 'service']) || !['redis', 'memcached'].includes(value.service)) return bad()
    return { op, expectedRevision: r, service: value.service }
  }
  if (op === 'container.run') {
    const c = value.container
    if (!keys(value, ['op', 'expectedRevision', 'container']) || !object(c) || !keys(c, ['name', 'image', 'env']) || !name(c.name) || typeof c.image !== 'string' || c.image.length > 255
      || !/^(?:docker\.io|quay\.io|ghcr\.io)\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*){0,3}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$/.test(c.image)) return bad()
    return { op, expectedRevision: r, container: { name: c.name, image: c.image, env: env(c.env) } }
  }
  return bad()
}

/** Verifies an agent reply before it reaches the page; self-contained so the browser can carry it as text. */
export function readAccountRuntimeView(value: unknown): AccountRuntimeClientView {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const keys = (item: Record<string, unknown>, list: string[]): boolean => Object.keys(item).sort().join() === [...list].sort().join()
  const bad = (): never => { throw new Error('invalid_runtime_view') }
  const uuid = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)
  const name = (item: unknown): item is string => typeof item === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(item)
  const rel = (item: unknown): item is string => typeof item === 'string' && item.length <= 512 && item.split('/').every(s => /^[A-Za-z0-9._+-]{1,128}$/.test(s) && s !== '.' && s !== '..')
  const time = (item: unknown): item is string => typeof item === 'string' && item.length <= 40 && Number.isFinite(Date.parse(item))
  const optTime = (item: unknown): boolean => item === null || time(item)
  const count = (item: unknown): boolean => item === null || Number.isSafeInteger(item) && (item as number) >= 0
  const version = (item: unknown): boolean => item === null || typeof item === 'string' && /^\d+\.\d+(?:\.\d+)?$/.test(item)
  const state = (item: unknown): boolean => ['running', 'starting', 'stopped', 'failed', 'unknown'].includes(item as string)
  if (!object(value) || !keys(value, ['context', 'revision', 'plan', 'host', 'domains', 'apps', 'cache', 'imageCleanup', 'containers']) || !['none', 'running', 'succeeded', 'failed'].includes(value.imageCleanup)) return bad()
  const c = value.context, p = value.plan, h = value.host
  if (!object(c) || !keys(c, ['accountId', 'username', 'home']) || !uuid(c.accountId) || typeof c.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(c.username) || typeof c.home !== 'string' || !/^\/[A-Za-z0-9._/-]{1,255}$/.test(c.home)
    || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)) return bad()
  if (!object(p) || !keys(p, ['apps', 'cache', 'containers', 'cacheMaxMb', 'memoryMb', 'cpuPercent', 'maxProcesses', 'maxApps', 'maxContainers']) || ![p.apps, p.cache, p.containers].every(v => typeof v === 'boolean')
    || !Number.isSafeInteger(p.cacheMaxMb) || ![p.memoryMb, p.cpuPercent, p.maxProcesses].every(count) || !Number.isSafeInteger(p.maxApps) || !Number.isSafeInteger(p.maxContainers)) return bad()
  if (!object(h) || !keys(h, ['runtimes', 'cache', 'containers']) || !Array.isArray(h.runtimes) || h.runtimes.length !== 3 || !Array.isArray(h.cache) || h.cache.length !== 2 || !object(h.containers)) return bad()
  const runtimes = h.runtimes.map((r: unknown, i: number) => {
    if (!object(r) || !keys(r, ['kind', 'available', 'version', 'reason']) || r.kind !== ['node', 'python', 'ruby'][i] || typeof r.available !== 'boolean' || !version(r.version) || ![null, 'not-installed', 'proxy-unavailable', 'bundler-missing', 'venv-missing'].includes(r.reason) || r.available !== (r.reason === null)) return bad()
    return { kind: r.kind, available: r.available, version: r.version, reason: r.reason }
  })
  const hostCache = h.cache.map((r: unknown, i: number) => {
    if (!object(r) || !keys(r, ['service', 'available', 'version', 'binary', 'reason']) || r.service !== ['redis', 'memcached'][i] || typeof r.available !== 'boolean' || !version(r.version) || !(r.binary === null || typeof r.binary === 'string' && /^\/usr\/bin\/[a-z-]+$/.test(r.binary))
      || ![null, 'not-installed'].includes(r.reason) || r.available !== (r.reason === null)) return bad()
    return { service: r.service, available: r.available, version: r.version, binary: r.binary, reason: r.reason }
  })
  const hc = h.containers
  if (!keys(hc, ['available', 'version', 'reason']) || typeof hc.available !== 'boolean' || !version(hc.version) || ![null, 'not-installed', 'newuidmap-missing', 'no-subordinate-ids'].includes(hc.reason) || hc.available !== (hc.reason === null)) return bad()
  if (!Array.isArray(value.domains) || value.domains.length > 1000) return bad()
  const domainIds = new Set<string>()
  const domains = value.domains.map((d: unknown) => { if (!object(d) || !keys(d, ['id', 'name']) || !uuid(d.id) || domainIds.has(d.id) || typeof d.name !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(d.name)) return bad(); domainIds.add(d.id); return { id: d.id, name: d.name } })
  if (!Array.isArray(value.apps) || value.apps.length > p.maxApps || !Array.isArray(value.cache) || value.cache.length !== 2 || !Array.isArray(value.containers) || value.containers.length > p.maxContainers) return bad()
  const apps = value.apps.map((a: unknown) => {
    if (!object(a) || !keys(a, ['name', 'runtime', 'root', 'startup', 'domainId', 'path', 'env', 'enabled', 'state', 'since', 'restarts', 'health', 'deps', 'preflight', 'updatedAt']) || !name(a.name) || !['node', 'python', 'ruby'].includes(a.runtime) || !rel(a.root) || !rel(a.startup)
      || !uuid(a.domainId) || typeof a.path !== 'string' || !/^\/[a-z0-9._/-]{0,255}$/.test(a.path) || !Array.isArray(a.env) || a.env.length > 32 || typeof a.enabled !== 'boolean' || !state(a.state) || !optTime(a.since) || !count(a.restarts)
      || !(a.health === null || Number.isInteger(a.health) && a.health >= 100 && a.health <= 599) || !['none', 'running', 'succeeded', 'failed'].includes(a.deps) || !(a.preflight === null || Array.isArray(a.preflight) && a.preflight.length <= 7
      && a.preflight.every((p: unknown) => ['root-missing', 'startup-missing', 'node-modules-missing', 'venv-missing', 'gemfile-missing', 'puma-missing', 'bundle-missing'].includes(p as string))) || !time(a.updatedAt)) return bad()
    const env = a.env.map((e: unknown) => { if (!object(e) || !keys(e, ['name', 'value']) || typeof e.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(e.name) || typeof e.value !== 'string' || e.value.length > 1024) return bad(); return { name: e.name, value: e.value } })
    return { name: a.name, runtime: a.runtime, root: a.root, startup: a.startup, domainId: a.domainId, path: a.path, env, enabled: a.enabled, state: a.state, since: a.since, restarts: a.restarts, health: a.health, deps: a.deps, preflight: a.preflight === null ? null : [...a.preflight], updatedAt: a.updatedAt }
  })
  const cache = value.cache.map((k: unknown, i: number) => {
    if (!object(k) || !keys(k, ['service', 'enabled', 'memoryMb', 'socket', 'state', 'since', 'memoryBytes', 'updatedAt']) || k.service !== ['redis', 'memcached'][i] || typeof k.enabled !== 'boolean' || !(k.memoryMb === null || Number.isInteger(k.memoryMb) && k.memoryMb >= 8)
      || k.socket !== c.home + '/.xpanel-cache/' + k.service + '.sock' || !state(k.state) || !optTime(k.since) || !count(k.memoryBytes) || !optTime(k.updatedAt)) return bad()
    return { service: k.service, enabled: k.enabled, memoryMb: k.memoryMb, socket: k.socket, state: k.state, since: k.since, memoryBytes: k.memoryBytes, updatedAt: k.updatedAt }
  })
  const containers = value.containers.map((k: unknown) => {
    if (!object(k) || !keys(k, ['name', 'image', 'envKeys', 'enabled', 'state', 'since', 'memoryBytes', 'cpuNs', 'restarts', 'updatedAt']) || !name(k.name) || typeof k.image !== 'string' || !/^(?:docker\.io|quay\.io|ghcr\.io)\/[A-Za-z0-9._:@/-]{1,250}$/.test(k.image)
      || !Array.isArray(k.envKeys) || k.envKeys.length > 32 || !k.envKeys.every((e: unknown) => typeof e === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(e)) || typeof k.enabled !== 'boolean' || !state(k.state) || !optTime(k.since) || !count(k.memoryBytes) || !count(k.cpuNs) || !count(k.restarts) || !time(k.updatedAt)) return bad()
    return { name: k.name, image: k.image, envKeys: [...k.envKeys], enabled: k.enabled, state: k.state, since: k.since, memoryBytes: k.memoryBytes, cpuNs: k.cpuNs, restarts: k.restarts, updatedAt: k.updatedAt }
  })
  return { context: { accountId: c.accountId, username: c.username, home: c.home }, revision: value.revision, plan: { apps: p.apps, cache: p.cache, containers: p.containers, cacheMaxMb: p.cacheMaxMb, memoryMb: p.memoryMb, cpuPercent: p.cpuPercent, maxProcesses: p.maxProcesses, maxApps: p.maxApps, maxContainers: p.maxContainers },
    host: { runtimes, cache: hostCache, containers: { available: hc.available, version: hc.version, reason: hc.reason } }, domains, apps, cache, imageCleanup: value.imageCleanup, containers }
}
