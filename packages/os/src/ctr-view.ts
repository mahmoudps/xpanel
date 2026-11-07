/** Public grammar of the rootless container workspace, shared by agent, API and browser. */
export type CtrRestart = 'no' | 'on-failure' | 'always'
export interface CtrStatRow { name: string; engine: 'podman' | 'docker'; state: string; cpu: string; memory: string; network: string; id: string }
export interface CtrStackService { name: string; image: string; unit: string; state: string; ports: string[]; restart: CtrRestart }
export interface CtrStackRow { name: string; app: string | null; enabled: boolean; yaml: string; envKeys: string[]; notes: string; folder: string; networks: string[]; updatedAt: string; services: CtrStackService[] }
export interface CtrNetworkRow { name: string; driver: string | null; subnets: string[] }
export interface CtrScopeView {
  scope: 'host' | 'account'; account: string | null; state: 'read' | 'unavailable'; reason: string | null; observedAt: string; revision: string; version: string | null
  stats: CtrStatRow[]; images: { id: string; tags: string[]; size: string | null }[]; networks: CtrNetworkRow[]; volumes: { name: string; driver: string }[]
  stacks: CtrStackRow[]; logins: { host: string; username: string }[]; actions: { write: boolean; jobs: boolean }
}
export interface CtrAccountRow { username: string; available: boolean; reason: string | null; stacks: number; services: number; running: number }
export interface CtrAccountsView { state: 'read' | 'unavailable'; reason: string | null; observedAt: string; version: string | null; accounts: CtrAccountRow[] }
export interface CtrDetailView {
  scope: 'host' | 'account'; account: string | null; id: string; name: string; image: string; state: string; startedAt: string | null; exitCode: number | null
  ips: string[]; ports: string[]; networks: string[]; restart: string | null; mounts: { type: string; source: string; target: string; readOnly: boolean }[]
  managed: { stack: string; service: string; primary: boolean; restart: CtrRestart } | null; logs: string[]
}
export interface CtrLogsView { account: string; stack: string; lines: string[] }
export interface CtrRegistryRow { host: string; namespace: string | null; mirror: string | null }
export interface CtrTemplateRow { name: string; description: string; yaml: string; env: string }
export interface CtrAppRow { id: string; name: string; description: string; version: string; port: number }
export interface CtrCatalogFacts { source: 'bundled' | 'signed'; sequence: number | null; expiresAt: string | null; reason: string | null }
export interface CtrSearchView { registry: string; results: { name: string; description: string; stars: number; official: boolean }[] }
export interface CtrPolicyView { revision: string; registries: CtrRegistryRow[]; templates: CtrTemplateRow[]; apps: CtrAppRow[]; catalog: CtrCatalogFacts; feedUrl: string | null; configPath: string; stackPath: string }
export type CtrViewKind = 'accounts' | 'scope' | 'detail' | 'logs' | 'policy' | 'search'

export type CtrOp =
  | { op: 'image.pull'; image: string } | { op: 'image.remove'; id: string } | { op: 'image.prune' }
  | { op: 'image.push'; id: string; destination: string } | { op: 'image.export'; id: string; path: string } | { op: 'image.import'; path: string } | { op: 'image.build'; tag: string; context: string; containerfile: string | null }
  | { op: 'network.create'; name: string; subnet: string | null; gateway: string | null; range: string | null; ipv6Subnet: string | null; labels: string[] } | { op: 'network.remove'; name: string } | { op: 'network.prune' }
  | { op: 'volume.create'; name: string; options: string[]; labels: string[] } | { op: 'volume.remove'; name: string } | { op: 'volume.prune' }
  | { op: 'engine.repair' } | { op: 'registry.login'; host: string; username: string; password: string } | { op: 'registry.logout'; host: string }
  | { op: 'stack.save'; name: string; yaml: string; env: string | null; notes: string; template: string | null }
  | { op: 'stack.start' | 'stack.stop' | 'stack.restart' | 'stack.update' | 'stack.remove'; name: string }
  | { op: 'stack.restart-policy'; name: string; service: string; restart: CtrRestart } | { op: 'stack.network'; name: string; network: string; connected: boolean }
  | { op: 'app.install'; app: string; name: string; version: string; bind: '127.0.0.1' | '0.0.0.0'; port: number; memoryMb: number | null; cpuPercent: number | null }
  | { op: 'container.commit'; id: string; tag: string }
export interface CtrOpRequest { account: string; expectedRevision: string; action: CtrOp }
export const CTR_OP_NAMES = ['image.pull', 'image.remove', 'image.prune', 'image.push', 'image.export', 'image.import', 'image.build', 'network.create', 'network.remove', 'network.prune', 'volume.create', 'volume.remove', 'volume.prune', 'engine.repair', 'registry.login', 'registry.logout', 'stack.save', 'stack.start', 'stack.stop', 'stack.restart', 'stack.update', 'stack.remove', 'stack.restart-policy', 'stack.network', 'app.install', 'container.commit'] as const

/** Strict shape of one workspace request; the agent checks meaning (trust, ports, compose) afterwards. */
export function readCtrOpRequest(value: unknown): CtrOpRequest {
  const bad = (): never => { throw new Error('invalid_container_operation') }
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item)
  const name = (item: unknown): item is string => typeof item === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(item)
  const words = (item: unknown): item is string[] => Array.isArray(item) && item.length <= 16 && item.every(entry => text(entry, 256))
  const nullable = (item: unknown): item is string | null => item === null || text(item, 64)
  const limit = (item: unknown, max: number): item is number | null => item === null || Number.isSafeInteger(item) && (item as number) >= 1 && (item as number) <= max
  if (!object(value) || Object.keys(value).sort().join() !== 'account,action,expectedRevision' || !/^[a-z][a-z0-9]{0,15}$/.test(String(value.account)) || !/^[0-9a-f]{64}$/.test(String(value.expectedRevision)) || !object(value.action)) return bad()
  const a = value.action, op = a.op
  const shape = (list: string[], ok: boolean): void => { if (!ok || Object.keys(a).sort().join() !== ['op', ...list].sort().join()) bad() }
  const id = /^[0-9a-f]{64}$/.test(String(a.id))
  if (op === 'image.pull') shape(['image'], text(a.image, 255))
  else if (op === 'image.remove') shape(['id'], id)
  else if (['image.prune', 'network.prune', 'volume.prune', 'engine.repair'].includes(op)) shape([], true)
  else if (op === 'image.push') shape(['id', 'destination'], id && text(a.destination, 255))
  else if (op === 'image.export') shape(['id', 'path'], id && text(a.path, 512))
  else if (op === 'image.import') shape(['path'], text(a.path, 512))
  else if (op === 'image.build') shape(['tag', 'context', 'containerfile'], text(a.tag, 255) && text(a.context, 512) && (a.containerfile === null || text(a.containerfile, 70000)))
  else if (op === 'network.create') shape(['name', 'subnet', 'gateway', 'range', 'ipv6Subnet', 'labels'], name(a.name) && nullable(a.subnet) && nullable(a.gateway) && nullable(a.range) && nullable(a.ipv6Subnet) && words(a.labels))
  else if (op === 'network.remove') shape(['name'], name(a.name))
  else if (op === 'volume.create') shape(['name', 'options', 'labels'], text(a.name, 128) && words(a.options) && words(a.labels))
  else if (op === 'volume.remove') shape(['name'], text(a.name, 128))
  else if (op === 'registry.login') shape(['host', 'username', 'password'], text(a.host, 255) && text(a.username, 128) && text(a.password, 4096) && a.password.length > 0)
  else if (op === 'registry.logout') shape(['host'], text(a.host, 255))
  else if (op === 'stack.save') shape(['name', 'yaml', 'env', 'notes', 'template'], name(a.name) && text(a.yaml, 70000) && (a.env === null || text(a.env, 17000)) && text(a.notes, 512) && (a.template === null || text(a.template, 512)))
  else if (['stack.start', 'stack.stop', 'stack.restart', 'stack.update', 'stack.remove'].includes(op)) shape(['name'], name(a.name))
  else if (op === 'stack.restart-policy') shape(['name', 'service', 'restart'], name(a.name) && name(a.service) && ['no', 'on-failure', 'always'].includes(a.restart))
  else if (op === 'stack.network') shape(['name', 'network', 'connected'], name(a.name) && name(a.network) && typeof a.connected === 'boolean')
  else if (op === 'app.install') shape(['app', 'name', 'version', 'bind', 'port', 'memoryMb', 'cpuPercent'], name(a.app) && name(a.name) && text(a.version, 128) && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(a.version) && ['127.0.0.1', '0.0.0.0'].includes(a.bind) && Number.isSafeInteger(a.port) && a.port >= 1024 && a.port <= 65535 && limit(a.memoryMb, 1048576) && limit(a.cpuPercent, 100000))
  else if (op === 'container.commit') shape(['id', 'tag'], id && text(a.tag, 255))
  else return bad()
  return { account: value.account, expectedRevision: value.expectedRevision, action: a as CtrOp }
}

/** Strict public views; self-contained so the browser binding can serialize this function. */
export function readCtrView(kind: CtrViewKind, value: unknown): any {
  const bad = (): never => { throw new Error('invalid_container_view') }
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const keys = (item: unknown, list: string[]): item is Record<string, any> => object(item) && Object.keys(item).sort().join() === [...list].sort().join()
  const text = (item: unknown, max = 512): boolean => typeof item === 'string' && item.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item)
  const opt = (item: unknown, max = 512): boolean => item === null || text(item, max)
  const list = (item: unknown, max: number, each: (entry: any) => boolean): boolean => Array.isArray(item) && item.length <= max && item.every(each)
  const strings = (item: unknown, max = 64, size = 512): boolean => list(item, max, entry => text(entry, size))
  const time = (item: unknown): boolean => typeof item === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item) && Number.isFinite(Date.parse(item))
  const hash = (item: unknown): boolean => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
  const count = (item: unknown): boolean => Number.isSafeInteger(item) && (item as number) >= 0
  const restart = (item: unknown): boolean => item === 'no' || item === 'on-failure' || item === 'always'
  const stat = (row: any): boolean => keys(row, ['name', 'engine', 'state', 'cpu', 'memory', 'network', 'id']) && ['podman', 'docker'].includes(row.engine) && [row.name, row.state, row.cpu, row.memory, row.network].every(item => text(item, 128)) && hash(row.id)
  const image = (row: any): boolean => keys(row, ['id', 'tags', 'size']) && hash(row.id) && strings(row.tags, 32, 255) && opt(row.size, 32)
  const network = (row: any): boolean => keys(row, ['name', 'driver', 'subnets']) && text(row.name, 128) && opt(row.driver, 64) && strings(row.subnets, 8, 64)
  const volume = (row: any): boolean => keys(row, ['name', 'driver']) && text(row.name, 255) && text(row.driver, 64)
  const service = (row: any): boolean => keys(row, ['name', 'image', 'unit', 'state', 'ports', 'restart']) && [row.name, row.image, row.unit, row.state].every(item => text(item, 255)) && strings(row.ports, 32, 64) && restart(row.restart)
  const stack = (row: any): boolean => keys(row, ['name', 'app', 'enabled', 'yaml', 'envKeys', 'notes', 'folder', 'networks', 'updatedAt', 'services']) && text(row.name, 32) && opt(row.app, 32) && typeof row.enabled === 'boolean' && text(row.yaml, 70000) && strings(row.envKeys, 256, 64) && text(row.notes) && text(row.folder) && strings(row.networks, 4, 32) && text(row.updatedAt, 40) && list(row.services, 16, service)
  const login = (row: any): boolean => keys(row, ['host', 'username']) && text(row.host, 255) && text(row.username, 128)
  const mount = (row: any): boolean => keys(row, ['type', 'source', 'target', 'readOnly']) && text(row.type, 32) && text(row.source, 1024) && text(row.target, 1024) && typeof row.readOnly === 'boolean'
  const ok: Record<CtrViewKind, () => boolean> = {
    accounts: () => keys(value, ['state', 'reason', 'observedAt', 'version', 'accounts']) && ['read', 'unavailable'].includes(value.state) && opt(value.reason, 64) && time(value.observedAt) && opt(value.version, 64)
      && list(value.accounts, 5000, row => keys(row, ['username', 'available', 'reason', 'stacks', 'services', 'running']) && text(row.username, 32) && typeof row.available === 'boolean' && opt(row.reason, 64) && count(row.stacks) && count(row.services) && count(row.running)),
    scope: () => keys(value, ['scope', 'account', 'state', 'reason', 'observedAt', 'revision', 'version', 'stats', 'images', 'networks', 'volumes', 'stacks', 'logins', 'actions']) && ['host', 'account'].includes(value.scope) && opt(value.account, 32) && ['read', 'unavailable'].includes(value.state) && opt(value.reason, 64) && time(value.observedAt) && hash(value.revision) && opt(value.version, 64)
      && list(value.stats, 1000, stat) && list(value.images, 1000, image) && list(value.networks, 200, network) && list(value.volumes, 1000, volume) && list(value.stacks, 16, stack) && list(value.logins, 32, login) && keys(value.actions, ['write', 'jobs']) && typeof value.actions.write === 'boolean' && typeof value.actions.jobs === 'boolean',
    detail: () => keys(value, ['scope', 'account', 'id', 'name', 'image', 'state', 'startedAt', 'exitCode', 'ips', 'ports', 'networks', 'restart', 'mounts', 'managed', 'logs']) && ['host', 'account'].includes(value.scope) && opt(value.account, 32) && hash(value.id) && text(value.name, 128) && text(value.image, 255) && text(value.state, 32) && opt(value.startedAt, 64) && (value.exitCode === null || Number.isSafeInteger(value.exitCode))
      && strings(value.ips, 16, 64) && strings(value.ports, 64, 64) && strings(value.networks, 16, 128) && opt(value.restart, 32) && list(value.mounts, 64, mount) && (value.managed === null || keys(value.managed, ['stack', 'service', 'primary', 'restart']) && text(value.managed.stack, 32) && text(value.managed.service, 32) && typeof value.managed.primary === 'boolean' && restart(value.managed.restart)) && strings(value.logs, 400, 2000),
    logs: () => keys(value, ['account', 'stack', 'lines']) && text(value.account, 32) && text(value.stack, 32) && strings(value.lines, 400, 2000),
    search: () => keys(value, ['registry', 'results']) && text(value.registry, 255) && list(value.results, 25, row => keys(row, ['name', 'description', 'stars', 'official']) && text(row.name, 255) && text(row.description, 512) && count(row.stars) && typeof row.official === 'boolean'),
    policy: () => keys(value, ['revision', 'registries', 'templates', 'apps', 'catalog', 'feedUrl', 'configPath', 'stackPath']) && hash(value.revision) && text(value.configPath) && text(value.stackPath) && opt(value.feedUrl, 512)
      && keys(value.catalog, ['source', 'sequence', 'expiresAt', 'reason']) && ['bundled', 'signed'].includes(value.catalog.source) && (value.catalog.sequence === null || count(value.catalog.sequence)) && opt(value.catalog.expiresAt, 40) && opt(value.catalog.reason, 64)
      && list(value.registries, 32, row => keys(row, ['host', 'namespace', 'mirror']) && text(row.host, 255) && opt(row.namespace, 255) && opt(row.mirror, 255))
      && list(value.templates, 50, row => keys(row, ['name', 'description', 'yaml', 'env']) && text(row.name, 32) && text(row.description) && text(row.yaml, 70000) && text(row.env, 17000))
      && list(value.apps, 64, row => keys(row, ['id', 'name', 'description', 'version', 'port']) && text(row.id, 32) && text(row.name, 64) && text(row.description) && text(row.version, 128) && count(row.port)),
  }
  if (!Object.hasOwn(ok, kind) || !ok[kind]()) return bad()
  return value
}
