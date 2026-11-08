import { createHash, randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { effectivePlan, fail, isXpanelError, msgid } from '@xpanel/core'
import type { Account, FeatureList, Plan } from '@xpanel/core'
import { system } from '@xpanel/render'
import { atomicWriteJson } from '@xpanel/state'
import { readCtrOpRequest } from '../../../packages/os/src/ctr-view.ts'
import type { CtrAccountsView, CtrDetailView, CtrNetworkRow, CtrOp, CtrPolicyView, CtrScopeView, CtrSearchView, CtrStackRow, CtrStatRow } from '../../../packages/os/src/ctr-view.ts'
import { SW_CONTAINER_ENGINES, SW_CONTAINER_ID, swContainerFollowArgv, swContainerInspectArgv, swContainerLogsArgv, swContainerReadArgv } from '../../../packages/os/src/sw-container-command.ts'
import type { SwContainerEngine, SwContainerRow } from '../../../packages/os/src/sw-container-command.ts'
import { containerFacts, readPodmanEngine, readRuntimeRegistries, readRuntimeRegistry, readUnitStates, RUNTIME_FEATURES, runtimeRegistryPath, runtimeRevision, runtimeStateName } from './account-runtime.ts'
import type { RuntimeHost, RuntimeRegistry } from './account-runtime.ts'
import { fetchCtrCatalog } from './ctr-catalog.ts'
import type { CtrCatalog } from './ctr-catalog.ts'
import type { LogFollower } from './ctr-logs.ts'
import { parseComposeServices, parseStackEnv, STACK_LIMITS, stackFolder, stackPorts, stackServiceName, stackUnits } from './ctr-compose.ts'
import type { StackRecord } from './ctr-compose.ts'
import { CTR_COMMIT_TAG, CTR_HOME_PATH, CTR_ID, CTR_LOGIN, CTR_NETWORK, CTR_READS, CTR_REGISTRY, CTR_SEARCH_TERM, CTR_VOLUME, ctrJournalArgv, ctrLoginUnit, ctrPodmanArgv, ctrRestartArgv, ctrTail, isCtrArchive, isCtrCidr, isCtrLabel, isCtrVolumeOption } from './ctr-command.ts'
import type { CtrRead } from './ctr-command.ts'
import { assertTrustedImage, CTR_REGISTRIES_CONF, CTR_STATE_DIR, ctrPolicyRevision, isTrustedImage, parseCtrPolicy, readCtrPolicy, writeCtrPolicy } from './ctr-policy.ts'
import type { HostJobPlan, HostJobRun, HostJobView, HostJobVerification } from './host-job-contract.ts'
import { parseEngineContainers, parseEngineDocuments, parseEngineImages, parseEngineVolumes, readSwContainers } from './sw-containers.ts'
import type { SwContainerRouteContext } from './sw-containers.ts'

export interface CtrRouteContext extends Pick<SwContainerRouteContext, 'assertRoot' | 'run' | 'binaryPresent' | 'submitJob' | 'audit' | 'now'> {
  store: { rootDir: string; listAccounts(): Promise<Account[]>; getAccountByUsername(username: string): Promise<Account | null>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; withAccountLifecycleLease<T>(id: string, operation: (account: Account) => Promise<T>): Promise<T> }
  host: RuntimeHost | null
  reconcile: ((actor: string) => Promise<{ status: 'noop' | 'applied' | 'failed' }>) | null
  catalog: CtrCatalog
  /** null off a Linux host. */
  follow: LogFollower | null
}

const unchanged = { stateChanged: false }
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = (): never => { throw new Error('invalid_engine_output') }
const STAT = /^[A-Za-z0-9 .,/%:+()-]{1,64}$/
const statText = (value: unknown, zero: string): string => typeof value === 'string' && STAT.test(value) && !/^-+( \/ -+)?$/.test(value.trim()) ? value : zero

/** podman-stats(1) JSON and docker-stats(1) JSON lines; a stopped container reports zero use, never its last sample. */
export function parseEngineStats(engine: SwContainerEngine, stdout: string, containers: readonly SwContainerRow[]): CtrStatRow[] {
  const rows = parseEngineDocuments(engine, stdout, 1000)
  const byName = new Map(rows.map(row => [String(row.name ?? row.Name), row]))
  return containers.map(container => {
    const row = container.state === 'running' ? byName.get(container.name) : undefined
    return { name: container.name, engine, state: container.state, id: container.id, cpu: statText(row?.cpu_percent ?? row?.CPUPerc, '0.00%'), memory: statText(row?.mem_usage ?? row?.MemUsage, '0B'), network: statText(row?.net_io ?? row?.NetIO, '0B / 0B') }
  })
}
const idleStats = (engine: SwContainerEngine, containers: readonly SwContainerRow[]): CtrStatRow[] => containers.map(row => ({ name: row.name, engine, state: row.state, id: row.id, cpu: row.state === 'running' ? 'Not read' : '0.00%', memory: row.state === 'running' ? 'Not read' : '0B', network: row.state === 'running' ? 'Not read' : '0B / 0B' }))

/** inspect has the same shape in both engines where it matters; the environment is never read, it can hold secrets. */
export function parseEngineInspect(stdout: string): Omit<CtrDetailView, 'scope' | 'account' | 'managed' | 'logs'> {
  let parsed: unknown
  try { parsed = JSON.parse(stdout) } catch { return invalid() }
  const row = Array.isArray(parsed) && parsed.length === 1 && object(parsed[0]) ? parsed[0] : invalid()
  const state = object(row.State) ? row.State : invalid(), net = object(row.NetworkSettings) ? row.NetworkSettings : {}, host = object(row.HostConfig) ? row.HostConfig : {}, config = object(row.Config) ? row.Config : {}
  if (typeof row.Id !== 'string' || !SW_CONTAINER_ID.test(row.Id)) return invalid()
  const networks = object(net.Networks) ? Object.entries(net.Networks) : []
  const portMap = object(net.Ports) ? Object.entries(net.Ports) : []
  const ports = portMap.flatMap(([inner, bindings]) => Array.isArray(bindings) && bindings.length ? bindings.filter(object).map(b => `${String(b.HostIp || b.HostIP || '0.0.0.0')}:${String(b.HostPort)}->${inner}`) : [inner])
  const ips = [...new Set([net.IPAddress, ...networks.map(([, item]) => object(item) ? item.IPAddress : null)].filter((item): item is string => typeof item === 'string' && item !== ''))]
  const mounts = (Array.isArray(row.Mounts) ? row.Mounts : []).filter(object).slice(0, 64).map(m => ({ type: String(m.Type ?? 'bind').slice(0, 32), source: String(m.Name ?? m.Source ?? '').slice(0, 1024), target: String(m.Destination ?? '').slice(0, 1024), readOnly: m.RW === false }))
  const policy = object(host.RestartPolicy) && typeof host.RestartPolicy.Name === 'string' && host.RestartPolicy.Name !== '' ? host.RestartPolicy.Name : null
  return { id: row.Id, name: String(row.Name ?? '').replace(/^\//, '').slice(0, 128), image: String(row.ImageName ?? config.Image ?? row.Image ?? '').slice(0, 255), state: String(state.Status ?? 'unknown').slice(0, 32),
    startedAt: typeof state.StartedAt === 'string' ? state.StartedAt.slice(0, 64) : null, exitCode: Number.isSafeInteger(state.ExitCode) ? state.ExitCode as number : null, ips: ips.slice(0, 16), ports: ports.slice(0, 64).map(item => item.slice(0, 64)), networks: networks.map(([name]) => name.slice(0, 128)).slice(0, 16), restart: policy, mounts }
}
/** Podman 3 reports CNI configs and Podman 4 netavark ones: only the name and subnets are common. */
export function parseScopeNetworks(stdout: string): CtrNetworkRow[] {
  return parseEngineDocuments('podman', stdout, 200).map(row => {
    const name = row.name ?? row.Name, subnets = Array.isArray(row.subnets) ? row.subnets.filter(object).map(item => item.subnet).filter((item): item is string => typeof item === 'string') : []
    return { name: typeof name === 'string' && name.length <= 128 ? name : invalid(), driver: typeof row.driver === 'string' ? row.driver.slice(0, 64) : null, subnets: subnets.slice(0, 8) }
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'))
}
const ipValue = (ip: string): bigint => {
  if (ip.includes('.')) return ip.split('.').reduce((total, part) => total * 256n + BigInt(part), 0n)
  const [head = '', tail] = ip.split('::'), a = head ? head.split(':') : [], b = tail ? tail.split(':') : []
  return [...a, ...Array(ip.includes('::') ? 8 - a.length - b.length : 0).fill('0'), ...b].reduce((total, part) => total * 65536n + BigInt('0x' + part), 0n)
}
/** Two networks overlap when one prefix contains the other. */
export function subnetsOverlap(a: string, b: string): boolean {
  const [ipA = '', bitsA = '0'] = a.split('/'), [ipB = '', bitsB = '0'] = b.split('/')
  if (ipA.includes(':') !== ipB.includes(':')) return false
  const width = ipA.includes(':') ? 128 : 32, shift = BigInt(width - Math.min(Number(bitsA), Number(bitsB)))
  return ipValue(ipA) >> shift === ipValue(ipB) >> shift
}
/** Ports held on any address, from the kernel tables; the row's fourth field is the socket state. */
export function listeningPorts(text: string, listenState: string): Set<number> {
  const out = new Set<number>()
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/), local = fields[1]?.split(':')[1]
    if (local && fields[3] === listenState) out.add(parseInt(local, 16))
  }
  return out
}

const stackRows = async (host: RuntimeHost | null, account: Account, stacks: readonly StackRecord[]): Promise<CtrStackRow[]> => {
  const units = stacks.flatMap(stack => stackUnits(account.username, stack))
  const states = await readUnitStates(host, units)
  return stacks.map(stack => {
    const services = parseComposeServices(stack.name, stack.yaml, stack.env), ports = services.flatMap(service => service.ports)
    return { name: stack.name, app: stack.app, enabled: stack.enabled, yaml: stack.yaml, envKeys: Object.keys(parseStackEnv(stack.env)), notes: stack.notes, folder: stackFolder(account.home, stack.name), networks: stack.networks, updatedAt: stack.updatedAt,
      services: services.map((service, index) => {
        const unit = system.containerUnitName(account.username, stackServiceName(stack.name, service.name))
        return { name: service.name, image: service.image, unit, state: runtimeStateName(host, states.get(unit)), ports: index === 0 ? ports.map(p => `${p.bind}:${p.host}->${p.container}/${p.protocol}`) : [], restart: stack.restart[service.name] ?? service.restart }
      }) }
  })
}

interface ScopeRead { view: CtrScopeView; containers: SwContainerRow[]; usedImageIds: Set<string>; dangling: string[]; registry: RuntimeRegistry }
async function readAccountScope(ctx: CtrRouteContext, account: Account): Promise<ScopeRead> {
  const observedAt = (ctx.now?.() ?? new Date()).toISOString()
  const registry = await readRuntimeRegistry(ctx.store.rootDir, account.id), stacks = registry.stacks ?? []
  const facts = containerFacts(await readPodmanEngine(ctx.host), account), rows = await stackRows(ctx.host, account, stacks)
  const empty = { stats: [], images: [], networks: [], volumes: [] }, base = { scope: 'account' as const, account: account.username, observedAt, stacks: rows, logins: (registry.logins ?? []).map(login => ({ host: login.host, username: login.username })), version: facts.version }
  const unavailable = (reason: string | null): ScopeRead => ({ view: { ...base, ...empty, state: 'unavailable', reason, revision: sha([runtimeRevision(registry)]), actions: { write: false, jobs: false } }, containers: [], usedImageIds: new Set(), dangling: [], registry })
  if (!ctx.host) return unavailable('unsupported-host')
  if (!facts.available) return unavailable(facts.reason)
  const read = async (name: CtrRead): Promise<string | null> => { const r = await ctx.host!.run(ctrPodmanArgv(account, CTR_READS[name])).catch(() => null); return r?.ok ? r.stdout : null }
  // One at a time: each read starts a Podman process on a 1 vCPU host.
  const list = await read('containers'), images = await read('images'), networks = await read('networks'), volumes = await read('volumes'), stats = await read('stats'), dangling = await read('dangling')
  if (list === null || images === null || networks === null || volumes === null || dangling === null) return unavailable('engine-unreachable')
  try {
    const containers = parseEngineContainers('podman', list)
    const view: CtrScopeView = { ...base, state: 'read', reason: null, revision: '', stats: stats === null ? idleStats('podman', containers) : parseEngineStats('podman', stats, containers), images: parseEngineImages('podman', images), networks: parseScopeNetworks(networks), volumes: parseEngineVolumes('podman', volumes), actions: { write: true, jobs: ctx.submitJob !== null } }
    view.revision = sha([runtimeRevision(registry), containers.map(row => [row.id, row.name, row.image]), view.images.map(row => [row.id, row.tags]), view.networks, view.volumes])
    return { view, containers, usedImageIds: new Set(parseEngineDocuments('podman', list, 500).map(row => String(row.ImageID ?? ''))), dangling: parseEngineVolumes('podman', dangling).map(row => row.name), registry }
  } catch { return unavailable('invalid-engine-output') }
}
async function readHostScope(ctx: CtrRouteContext): Promise<CtrScopeView> {
  const list = await readSwContainers(ctx, false)
  const stats: CtrStatRow[] = []
  for (const engine of list.engines.filter(item => item.state === 'read')) {
    const r = await ctx.run!(swContainerReadArgv(engine.engine, 'stats')).catch(() => null)
    try { stats.push(...(r?.ok ? parseEngineStats(engine.engine, r.stdout, engine.containers) : idleStats(engine.engine, engine.containers))) } catch { stats.push(...idleStats(engine.engine, engine.containers)) }
  }
  return { scope: 'host', account: null, state: list.state, reason: list.reason, observedAt: list.observedAt, revision: sha(list.engines.map(item => item.revision)), version: list.engines.find(item => item.version)?.version ?? null, stats, images: [], networks: [], volumes: [], stacks: [], logins: [], actions: { write: false, jobs: false } }
}
async function readAccounts(ctx: CtrRouteContext): Promise<CtrAccountsView> {
  const observedAt = (ctx.now?.() ?? new Date()).toISOString(), accounts = (await ctx.store.listAccounts()).filter(account => account.status === 'active').sort((a, b) => a.username.localeCompare(b.username, 'en'))
  const registries = await readRuntimeRegistries(ctx.store.rootDir, accounts)
  const units = accounts.flatMap(account => (registries.get(account.id)?.stacks ?? []).flatMap(stack => stackUnits(account.username, stack)))
  const states = await readUnitStates(ctx.host, units)
  const engine = await readPodmanEngine(ctx.host)
  const rows = accounts.map(account => {
    const stacks = registries.get(account.id)?.stacks ?? [], facts = containerFacts(engine, account), mine = stacks.flatMap(stack => stackUnits(account.username, stack))
    return { username: account.username, available: facts.available, reason: facts.reason, stacks: stacks.length, services: mine.length, running: mine.filter(unit => runtimeStateName(ctx.host, states.get(unit)) === 'running').length }
  })
  return { state: ctx.host ? 'read' : 'unavailable', reason: ctx.host ? null : 'unsupported-host', observedAt, version: engine.version, accounts: rows }
}

const TITLES = {
  pull: msgid('Pull image {name}'), imageRemove: msgid('Remove image {name}'), imagePrune: msgid('Remove unused images'), networkCreate: msgid('Create network {name}'), networkRemove: msgid('Remove network {name}'), networkPrune: msgid('Remove unused networks'),
  volumeCreate: msgid('Create volume {name}'), volumeRemove: msgid('Remove volume {name}'), repair: msgid('Repair container storage'), commit: msgid('Save container {name} as an image'), restart: msgid('Restart stack {name}'),
  push: msgid('Push image to {name}'), exportImage: msgid('Export image to {name}'), importImage: msgid('Import images from {name}'), build: msgid('Build image {name}'),
} as const
interface CtrStep { id: string; title: string; name: string; argv: string[]; timeoutMs?: number }
function buildCtrJob(input: { kind: string; summary: string; account: Account; expectedRevision: string; steps: readonly CtrStep[]; reads?: readonly string[][]; verify: (run: HostJobRun) => Promise<HostJobVerification>; assertActor(): Promise<void>; finalize?: () => Promise<void> }): HostJobPlan {
  const reviewed = new Set([...input.steps.map(step => step.argv), ...(input.reads ?? [])].map(argv => JSON.stringify(argv)))
  return { kind: input.kind, summary: input.summary, accountId: null, fingerprint: { account: input.account.username, kind: input.kind, expectedRevision: input.expectedRevision, steps: input.steps.map(step => step.argv) }, detail: { account: input.account.username, summary: input.summary },
    steps: input.steps.map(step => ({ id: step.id, title: step.title, titleValues: { name: step.name }, argv: step.argv, timeoutMs: step.timeoutMs ?? 120_000, mutates: true })),
    policy: candidate => reviewed.has(JSON.stringify(candidate)), beforeStep: async () => { await input.assertActor() }, verify: input.verify,
    ...(input.finalize ? { finalize: async () => { await input.finalize!(); return { ok: true, detail: {} } } } : {}) }
}

async function scopeAccount(ctx: CtrRouteContext, username: string): Promise<{ account: Account; plan: Plan; features: FeatureList }> {
  const account = await ctx.store.getAccountByUsername(username)
  if (!account) return fail('NOT_FOUND', 'account not found', unchanged)
  const plan = await ctx.store.getPlan(account.planId), features = plan ? await ctx.store.getFeatureList(plan.featureListId) : null
  if (account.status !== 'active' || !plan || !features) return fail('PRECONDITION_FAILED', 'containers run only under an active account', { ...unchanged, reason: 'account_not_active' })
  return { account, plan: effectivePlan(plan, account), features }
}
const params = (url: URL, allowed: readonly string[]): void => { for (const key of url.searchParams.keys()) if (!allowed.includes(key)) fail('VALIDATION', 'this selector is not accepted', unchanged) }
const stackOf = (registry: RuntimeRegistry, name: string): StackRecord => registry.stacks?.find(stack => stack.name === name) ?? fail('NOT_FOUND', 'stack not found', unchanged)
const replaceStack = (registry: RuntimeRegistry, stack: StackRecord): RuntimeRegistry => ({ ...registry, stacks: (registry.stacks ?? []).map(item => item.name === stack.name ? stack : item) })

async function mutateRuntime(ctx: CtrRouteContext, account: Account, actor: string, change: (registry: RuntimeRegistry) => RuntimeRegistry): Promise<{ before: RuntimeRegistry; next: RuntimeRegistry }> {
  const root = ctx.store.rootDir, path = runtimeRegistryPath(root, account.id)
  const { before, next } = await ctx.store.withAccountLifecycleLease(account.id, async current => {
    const before = await readRuntimeRegistry(root, current.id), next = change(before)
    if (next !== before) await atomicWriteJson(path, next, 0o600)
    return { before, next }
  })
  if (next === before) return { before, next }
  const applied = await ctx.reconcile!(actor).catch(() => ({ status: 'failed' as const }))
  if (applied.status === 'failed') {
    // Restore the saved state so one bad stack can never block every later reconciliation.
    await ctx.store.withAccountLifecycleLease(account.id, async () => { if (runtimeRevision(await readRuntimeRegistry(root, account.id)) === runtimeRevision(next)) await atomicWriteJson(path, before, 0o600) })
    const restored = await ctx.reconcile!(actor).catch(() => ({ status: 'failed' as const }))
    return fail('CONFIG_TEST_FAILED', 'the change did not pass the server configuration tests and was undone', restored.status === 'failed' ? { stateChanged: true, verificationRequired: true } : unchanged)
  }
  return { before, next }
}

async function assertPortsFree(ctx: CtrRouteContext, account: Account, name: string, ports: readonly system.ContainerPublish[]): Promise<void> {
  if (!ports.length) return
  const accounts = await ctx.store.listAccounts(), registries = await readRuntimeRegistries(ctx.store.rootDir, accounts)
  const own = new Set((registries.get(account.id)?.stacks ?? []).filter(stack => stack.name === name).flatMap(stackPorts).map(p => p.host + '/' + p.protocol))
  const saved = new Set([...registries.entries()].flatMap(([id, registry]) => (registry.stacks ?? []).filter(stack => id !== account.id || stack.name !== name).flatMap(stackPorts)).map(p => p.host + '/' + p.protocol))
  const read = async (file: string, state: string): Promise<Set<number>> => listeningPorts(await ctx.host!.readText(file) ?? '', state)
  const live = { tcp: new Set([...await read('/proc/net/tcp', '0A'), ...await read('/proc/net/tcp6', '0A')]), udp: new Set([...await read('/proc/net/udp', '07'), ...await read('/proc/net/udp6', '07')]) }
  for (const port of ports) {
    const key = port.host + '/' + port.protocol
    if (saved.has(key) || !own.has(key) && live[port.protocol].has(port.host)) fail('CONFLICT', `host port ${port.host} is already in use`, { ...unchanged, reason: 'PORT_IN_USE', port: port.host })
  }
}
async function saveStack(ctx: CtrRouteContext, scope: { account: Account; features: FeatureList }, actor: string, input: { name: string; yaml: string; env: string | null; notes: string; app: string | null; limits: StackRecord['limits'] }): Promise<boolean> {
  const { account } = scope, current = (await readRuntimeRegistry(ctx.store.rootDir, account.id)).stacks?.find(stack => stack.name === input.name) ?? null
  const env = input.env ?? current?.env ?? '', services = parseComposeServices(input.name, input.yaml, env), policy = await readCtrPolicy(ctx.store.rootDir)
  for (const service of services) assertTrustedImage(policy, service.image)
  await assertPortsFree(ctx, account, input.name, services.flatMap(service => service.ports))
  const updatedAt = (ctx.now?.() ?? new Date()).toISOString()
  const record: StackRecord = { name: input.name, yaml: input.yaml, env, notes: input.notes, app: input.app ?? current?.app ?? null, enabled: current?.enabled ?? true, updatedAt, restart: current?.restart ?? {}, networks: current?.networks ?? [], limits: input.limits }
  await mutateRuntime(ctx, account, actor, registry => {
    const stacks = registry.stacks ?? []
    if (!current && stacks.length >= STACK_LIMITS.stacks) return fail('LIMIT_EXCEEDED', 'the stack limit is reached', unchanged)
    return { ...registry, stacks: current ? stacks.map(item => item.name === record.name ? record : item) : [...stacks, record] }
  })
  return current !== null
}
const restartStack = async (ctx: CtrRouteContext, account: Account, stack: StackRecord): Promise<void> => {
  // A service joined to the first one restarts with it through BindsTo=.
  await ctx.host!.systemd('restart', stackUnits(account.username, stack)[0]!)
}

async function loginRegistry(ctx: CtrRouteContext, account: Account, actor: string, action: Extract<CtrOp, { op: 'registry.login' }>): Promise<void> {
  if (!CTR_REGISTRY.test(action.host) || !CTR_LOGIN.test(action.username)) return fail('VALIDATION', 'a registry host and a user name are required', unchanged)
  if (!(await readCtrPolicy(ctx.store.rootDir)).registries.some(item => item.host === action.host)) return fail('PRECONDITION_FAILED', 'add this registry to the trust policy first', { ...unchanged, reason: 'untrusted_registry' })
  const file = join(ctx.store.rootDir, CTR_STATE_DIR, 'login-' + account.username)
  await mkdir(join(ctx.store.rootDir, CTR_STATE_DIR), { recursive: true, mode: 0o700 })
  await writeFile(file, action.password, { mode: 0o600 })
  try {
    const result = await ctx.host!.run(ctrPodmanArgv(account, ctrTail.login(action.host, action.username, account.home), file))
    if (!result.ok) {
      const log = await ctx.host!.run(ctrJournalArgv([ctrLoginUnit(account.username)])).catch(() => null)
      if (/unauthorized|denied|incorrect|invalid username|401|403/i.test(log?.stdout ?? '')) return fail('PRECONDITION_FAILED', 'the registry refused these credentials', { ...unchanged, reason: 'AUTH_FAILED' })
      return fail('SERVICE_UNAVAILABLE', 'the registry could not be reached', { ...unchanged, reason: 'registry_unreachable' })
    }
  } finally { await rm(file, { force: true }) }
  await mutateRuntime(ctx, account, actor, registry => ({ ...registry, logins: [...(registry.logins ?? []).filter(item => item.host !== action.host), { host: action.host, username: action.username }] }))
}

/** Engine changes run as host jobs that re-read the store; saved stacks change desired state and reconcile. */
async function applyOp(ctx: CtrRouteContext, read: ScopeRead, scope: { account: Account; plan: Plan; features: FeatureList }, action: CtrOp, expectedRevision: string, actor: string, assertActor: () => Promise<void>): Promise<Response> {
  const { account } = scope, { view, registry } = read, root = ctx.store.rootDir, name = 'name' in action ? action.name : account.username
  const job = async (kind: string, summary: string, steps: CtrStep[], check: (run: HostJobRun) => Promise<HostJobVerification>, reads: string[][] = [], finalize?: () => Promise<void>): Promise<Response> => {
    if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable; nothing was submitted', unchanged)
    if (!steps.length) return json(200, { op: action.op, changed: false })
    const plan = buildCtrJob({ kind: 'software.container.' + kind, summary, account, expectedRevision, steps, reads, verify: check, assertActor, ...(finalize ? { finalize } : {}) })
    await assertActor()
    let submitted: HostJobView
    try { submitted = await ctx.submitJob(plan, actor) } catch (error) {
      if (isXpanelError(error) && error.detail?.stateChanged === false) throw error
      return fail('SERVICE_UNAVAILABLE', 'container job submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    }
    return json(202, { job: submitted })
  }
  const podman = (tail: readonly string[]): string[] => ctrPodmanArgv(account, tail)
  const listed = (kind: 'images' | 'networks' | 'volumes', present: (stdout: string) => boolean, wanted: boolean) => async (run: HostJobRun): Promise<HostJobVerification> => {
    const result = await run(podman(CTR_READS[kind]))
    const ok = result.ok && present(result.stdout) === wanted
    return { ok, detail: { verificationRequired: !ok } }
  }
  const stillReads = async (run: HostJobRun): Promise<HostJobVerification> => { const result = await run(podman(CTR_READS.info)); return { ok: result.ok, detail: { verificationRequired: !result.ok } } }
  const reads = (kind: CtrRead): string[][] => [podman(CTR_READS[kind])]
  switch (action.op) {
    case 'image.pull': {
      if (system.containerImageHost(action.image) === null) return fail('VALIDATION', 'an image needs a registry, a name and a tag or digest', unchanged)
      assertTrustedImage(await readCtrPolicy(root), action.image)
      return job('image.pull', 'pull ' + action.image + ' for ' + account.username, [{ id: 'pull', title: TITLES.pull, name: action.image, argv: podman(ctrTail.pull(action.image)), timeoutMs: 900_000 }], listed('images', stdout => parseEngineImages('podman', stdout).some(row => row.tags.includes(action.image)), true), reads('images'))
    }
    case 'image.remove': {
      const image = view.images.find(row => row.id === action.id) ?? fail('NOT_FOUND', 'the image is not in the observed store', unchanged)
      const saved = (registry.stacks ?? []).flatMap(stack => parseComposeServices(stack.name, stack.yaml, stack.env).map(service => service.image)), wanted = [...saved, ...registry.containers.map(row => row.image), ...read.containers.map(row => row.image)]
      if (read.usedImageIds.has(image.id) || image.tags.some(tag => wanted.includes(tag))) return fail('CONFLICT', 'a container uses this image', { ...unchanged, reason: 'IN_USE' })
      return job('image.remove', 'remove image ' + image.id.slice(0, 12) + ' of ' + account.username, [{ id: 'remove', title: TITLES.imageRemove, name: image.tags[0] ?? image.id.slice(0, 12), argv: podman(ctrTail.imageRemove(image.id)) }], listed('images', stdout => parseEngineImages('podman', stdout).some(row => row.id === image.id), false), reads('images'))
    }
    case 'image.prune': return job('image.prune', 'remove unused images of ' + account.username, [{ id: 'prune', title: TITLES.imagePrune, name: account.username, argv: podman(ctrTail.imagePrune()), timeoutMs: 600_000 }], stillReads, reads('info'))
    case 'image.push': {
      const image = view.images.find(row => row.id === action.id) ?? fail('NOT_FOUND', 'the image is not in the observed store', unchanged)
      if (system.containerImageHost(action.destination) === null) return fail('VALIDATION', 'a destination needs a registry, a name and a tag or digest', unchanged)
      assertTrustedImage(await readCtrPolicy(root), action.destination)
      return job('image.push', 'push ' + image.id.slice(0, 12) + ' of ' + account.username + ' to ' + action.destination, [{ id: 'push', title: TITLES.push, name: action.destination, argv: podman(ctrTail.push(image.id, action.destination)), timeoutMs: 900_000 }], stillReads, reads('info'))
    }
    case 'image.export': {
      const image = view.images.find(row => row.id === action.id) ?? fail('NOT_FOUND', 'the image is not in the observed store', unchanged)
      if (!isCtrArchive(action.path)) return fail('VALIDATION', 'the archive must be a .tar path inside the account home', unchanged)
      return job('image.export', 'export ' + image.id.slice(0, 12) + ' of ' + account.username, [{ id: 'export', title: TITLES.exportImage, name: action.path, argv: podman(ctrTail.save(image.id, action.path, account.home)), timeoutMs: 900_000 }], stillReads, reads('info'))
    }
    case 'image.import': {
      if (!isCtrArchive(action.path)) return fail('VALIDATION', 'the archive must be a .tar path inside the account home', unchanged)
      return job('image.import', 'import images for ' + account.username, [{ id: 'import', title: TITLES.importImage, name: action.path, argv: podman(ctrTail.load(action.path, account.home)), timeoutMs: 900_000 }], stillReads, reads('info'))
    }
    case 'image.build': {
      if (!CTR_COMMIT_TAG.test(action.tag) || !CTR_HOME_PATH.test(action.context)) return fail('VALIDATION', 'a build needs localhost/<name>:<tag> and a folder inside the account home', unchanged)
      const pasted = action.containerfile !== null && action.containerfile.trim() !== ''
      if (pasted && Buffer.byteLength(action.containerfile!) > STACK_LIMITS.yaml) return fail('VALIDATION', 'the build file is too large', unchanged)
      const file = join(root, CTR_STATE_DIR, 'build-' + account.username)
      const argv = pasted ? ctrPodmanArgv(account, ctrTail.build(action.tag, action.context, account.home, true), file) : podman(ctrTail.build(action.tag, action.context, account.home, false))
      if (pasted) { await mkdir(join(root, CTR_STATE_DIR), { recursive: true, mode: 0o700 }); await writeFile(file, action.containerfile!, { mode: 0o600 }) }
      return job('image.build', 'build ' + action.tag + ' for ' + account.username, [{ id: 'build', title: TITLES.build, name: action.tag, argv, timeoutMs: 1_800_000 }], listed('images', stdout => parseEngineImages('podman', stdout).some(row => row.tags.includes(action.tag)), true), reads('images'), pasted ? () => rm(file, { force: true }) : undefined)
    }
    case 'network.create': {
      if (!CTR_NETWORK.test(action.name) || action.subnet !== null && !isCtrCidr(action.subnet, 4) || action.range !== null && !isCtrCidr(action.range, 4) || action.ipv6Subnet !== null && !isCtrCidr(action.ipv6Subnet, 6) || !action.labels.every(isCtrLabel)) return fail('VALIDATION', 'the network name, subnets or labels are invalid', unchanged)
      if (view.networks.some(row => row.name === action.name)) return fail('CONFLICT', 'a network with this name exists', unchanged)
      for (const subnet of [action.subnet, action.ipv6Subnet]) if (subnet && view.networks.some(row => row.subnets.some(item => subnetsOverlap(item, subnet)))) return fail('CONFLICT', 'this subnet overlaps an existing network', { ...unchanged, reason: 'subnet_overlap' })
      const argv = podman(ctrTail.networkCreate(action))
      return job('network.create', 'create network ' + action.name + ' of ' + account.username, [{ id: 'create', title: TITLES.networkCreate, name: action.name, argv }], listed('networks', stdout => parseScopeNetworks(stdout).some(row => row.name === action.name), true), reads('networks'))
    }
    case 'network.remove': {
      if (!view.networks.some(row => row.name === action.name) || action.name === 'podman') return fail('NOT_FOUND', 'the network is not in the observed store', unchanged)
      if ((registry.stacks ?? []).some(stack => stack.networks.includes(action.name))) return fail('CONFLICT', 'a stack uses this network', { ...unchanged, reason: 'IN_USE' })
      return job('network.remove', 'remove network ' + action.name + ' of ' + account.username, [{ id: 'remove', title: TITLES.networkRemove, name: action.name, argv: podman(ctrTail.networkRemove(action.name)) }], listed('networks', stdout => parseScopeNetworks(stdout).some(row => row.name === action.name), false), reads('networks'))
    }
    case 'network.prune':
      // A stopped stack has no container holding its network, so the engine would count that network as unused.
      if ((registry.stacks ?? []).some(stack => !stack.enabled && stack.networks.length)) return fail('CONFLICT', 'a stopped stack still uses a network', { ...unchanged, reason: 'IN_USE' })
      return job('network.prune', 'remove unused networks of ' + account.username, [{ id: 'prune', title: TITLES.networkPrune, name: account.username, argv: podman(ctrTail.networkPrune()) }], stillReads, reads('info'))
    case 'volume.create': {
      if (!CTR_VOLUME.test(action.name) || !action.options.every(isCtrVolumeOption) || !action.labels.every(isCtrLabel)) return fail('VALIDATION', 'the volume name, options or labels are invalid', unchanged)
      if (view.volumes.some(row => row.name === action.name)) return fail('CONFLICT', 'a volume with this name exists', unchanged)
      return job('volume.create', 'create volume ' + action.name + ' of ' + account.username, [{ id: 'create', title: TITLES.volumeCreate, name: action.name, argv: podman(ctrTail.volumeCreate(action.name, action.options, action.labels)) }], listed('volumes', stdout => parseEngineVolumes('podman', stdout).some(row => row.name === action.name), true), reads('volumes'))
    }
    case 'volume.remove': {
      if (!CTR_VOLUME.test(action.name) || !view.volumes.some(row => row.name === action.name)) return fail('NOT_FOUND', 'the volume is not in the observed store', unchanged)
      if ((registry.stacks ?? []).some(stack => parseComposeServices(stack.name, stack.yaml, stack.env).some(service => service.mounts.some(m => m.kind === 'volume' && m.source === action.name)))) return fail('CONFLICT', 'a stack uses this volume', { ...unchanged, reason: 'IN_USE' })
      return job('volume.remove', 'remove volume ' + action.name + ' of ' + account.username, [{ id: 'remove', title: TITLES.volumeRemove, name: action.name, argv: podman(ctrTail.volumeRemove(action.name)) }], listed('volumes', stdout => parseEngineVolumes('podman', stdout).some(row => row.name === action.name), false), reads('volumes'))
    }
    case 'volume.prune': {
      // Stack volumes outlive their stopped containers; podman would count them as unused and destroy the data.
      const saved = new Set((registry.stacks ?? []).flatMap(stack => parseComposeServices(stack.name, stack.yaml, stack.env).flatMap(service => service.mounts.filter(m => m.kind === 'volume').map(m => m.source))))
      const targets = read.dangling.filter(item => !saved.has(item)).slice(0, 32)
      return job('volume.prune', 'remove unused volumes of ' + account.username, targets.map((item, index) => ({ id: 'remove-' + index, title: TITLES.volumeRemove, name: item, argv: podman(ctrTail.volumeRemove(item)) })), listed('volumes', stdout => parseEngineVolumes('podman', stdout).some(row => targets.includes(row.name)), false), reads('volumes'))
    }
    case 'engine.repair': return job('engine.repair', 'repair container storage of ' + account.username, [{ id: 'repair', title: TITLES.repair, name: account.username, argv: podman(ctrTail.migrate()), timeoutMs: 300_000 }], stillReads, reads('info'))
    case 'container.commit': {
      const container = read.containers.find(row => row.id === action.id) ?? fail('NOT_FOUND', 'the container is not in the observed list', unchanged)
      if (!CTR_ID.test(action.id) || !CTR_COMMIT_TAG.test(action.tag)) return fail('VALIDATION', 'the image name must be localhost/<name>:<tag>', unchanged)
      return job('container.commit', 'save ' + container.name + ' as ' + action.tag, [{ id: 'commit', title: TITLES.commit, name: container.name, argv: podman(ctrTail.commit(action.id, action.tag)), timeoutMs: 600_000 }], listed('images', stdout => parseEngineImages('podman', stdout).some(row => row.tags.includes(action.tag)), true), reads('images'))
    }
    case 'registry.login': await loginRegistry(ctx, account, actor, action); return json(200, { op: action.op, changed: true })
    case 'registry.logout': {
      if (!CTR_REGISTRY.test(action.host)) return fail('VALIDATION', 'a registry host is required', unchanged)
      if (!(registry.logins ?? []).some(item => item.host === action.host)) return fail('NOT_FOUND', 'no login is saved for this registry', unchanged)
      // Without the engine the auth file stays, but it is the account's own file and no pull uses it.
      await ctx.host!.run(podman(ctrTail.logout(action.host, account.home))).catch(() => null)
      await mutateRuntime(ctx, account, actor, current => ({ ...current, logins: (current.logins ?? []).filter(item => item.host !== action.host) }))
      return json(200, { op: action.op, changed: true })
    }
    case 'stack.save': {
      const limits = stackLimits(registry, action.name), existed = await saveStack(ctx, scope, actor, { name: action.name, yaml: action.yaml, env: action.env, notes: action.notes, app: null, limits })
      if (action.template !== null) {
        const policy = await readCtrPolicy(root), env = (await readRuntimeRegistry(root, account.id)).stacks?.find(stack => stack.name === action.name)?.env ?? ''
        await writeCtrPolicy(root, parseCtrPolicy({ ...policy, templates: [...policy.templates.filter(item => item.name !== action.name), { name: action.name, description: action.template, yaml: action.yaml, env: env.replace(/^([A-Za-z_][A-Za-z0-9_]*)=.*$/gm, '$1=') }] }))
      }
      if (existed) { const saved = stackOf(await readRuntimeRegistry(root, account.id), action.name); if (saved.enabled) await restartStack(ctx, account, saved) }
      return json(200, { op: action.op, changed: true })
    }
    case 'app.install': {
      const app = (await ctx.catalog.read()).apps.find(item => item.id === action.app) ?? fail('NOT_FOUND', 'this app is not in the catalog', unchanged)
      if (registry.stacks?.some(stack => stack.name === action.name)) return fail('CONFLICT', 'a stack with this name exists', unchanged)
      const secrets = app.secrets.map(key => key + '=' + randomBytes(18).toString('hex'))
      await saveStack(ctx, scope, actor, { name: action.name, yaml: app.yaml, env: ['VERSION=' + action.version, 'BIND=' + action.bind, 'HOST_PORT=' + action.port, ...secrets, ''].join('\n'), notes: '', app: app.id, limits: { memoryMb: action.memoryMb, cpuPercent: action.cpuPercent } })
      return json(200, { op: action.op, changed: true })
    }
    case 'stack.start': case 'stack.stop': {
      const enabled = action.op === 'stack.start'
      stackOf(registry, action.name)
      await mutateRuntime(ctx, account, actor, current => { const stack = stackOf(current, action.name); return stack.enabled === enabled ? current : replaceStack(current, { ...stack, enabled, updatedAt: (ctx.now?.() ?? new Date()).toISOString() }) })
      return json(200, { op: action.op, changed: true })
    }
    case 'stack.remove': {
      stackOf(registry, action.name)
      await mutateRuntime(ctx, account, actor, current => ({ ...current, stacks: (current.stacks ?? []).filter(stack => stack.name !== action.name) }))
      return json(200, { op: action.op, changed: true })
    }
    case 'stack.restart': {
      const stack = stackOf(registry, action.name)
      if (!stack.enabled) return fail('PRECONDITION_FAILED', 'start the stack first', unchanged)
      await restartStack(ctx, account, stack)
      return json(200, { op: action.op, changed: true })
    }
    case 'stack.update': {
      const stack = stackOf(registry, action.name), services = parseComposeServices(stack.name, stack.yaml, stack.env), units = stackUnits(account.username, stack), images = [...new Set(services.map(service => service.image))], policy = await readCtrPolicy(root)
      const untrusted = images.find(image => !isTrustedImage(policy, image))
      if (untrusted) assertTrustedImage(policy, untrusted)
      const steps: CtrStep[] = images.slice(0, 16).map((image, index) => ({ id: 'pull-' + index, title: TITLES.pull, name: image, argv: podman(ctrTail.pull(image)), timeoutMs: 900_000 }))
      if (stack.enabled) steps.push({ id: 'restart', title: TITLES.restart, name: stack.name, argv: ctrRestartArgv(units[0]!) })
      return job('stack.update', 'update images of ' + stack.name + ' for ' + account.username, steps, async () => {
        const states = await readUnitStates(ctx.host, units), ok = !stack.enabled || units.every(unit => ['running', 'starting'].includes(runtimeStateName(ctx.host, states.get(unit))))
        return { ok, detail: { verificationRequired: !ok } }
      })
    }
    case 'stack.restart-policy': {
      const stack = stackOf(registry, action.name)
      if (!parseComposeServices(stack.name, stack.yaml, stack.env).some(service => service.name === action.service)) return fail('NOT_FOUND', 'service not found', unchanged)
      await mutateRuntime(ctx, account, actor, current => { const item = stackOf(current, action.name); return replaceStack(current, { ...item, restart: { ...item.restart, [action.service]: action.restart }, updatedAt: (ctx.now?.() ?? new Date()).toISOString() }) })
      return json(200, { op: action.op, changed: true })
    }
    case 'stack.network': {
      const stack = stackOf(registry, action.name)
      if (action.connected && !view.networks.some(row => row.name === action.network)) return fail('NOT_FOUND', 'the network is not in the observed store', unchanged)
      const networks = [...new Set(action.connected ? [...stack.networks, action.network] : stack.networks.filter(item => item !== action.network))]
      if (networks.length > 4) return fail('LIMIT_EXCEEDED', 'a stack joins at most 4 networks', unchanged)
      const { next } = await mutateRuntime(ctx, account, actor, current => { const item = stackOf(current, action.name); return replaceStack(current, { ...item, networks, updatedAt: (ctx.now?.() ?? new Date()).toISOString() }) })
      const saved = stackOf(next, action.name)
      if (saved.enabled) await restartStack(ctx, account, saved)
      return json(200, { op: action.op, changed: true })
    }
  }
}
const stackLimits = (registry: RuntimeRegistry, name: string): StackRecord['limits'] => registry.stacks?.find(stack => stack.name === name)?.limits ?? { memoryMb: null, cpuPercent: null }

async function readDetail(ctx: CtrRouteContext, url: URL): Promise<CtrDetailView> {
  const id = url.searchParams.get('id') ?? '', username = url.searchParams.get('account'), engine = url.searchParams.get('engine') as SwContainerEngine | null
  if (!SW_CONTAINER_ID.test(id) || !username === !engine || engine && !SW_CONTAINER_ENGINES.includes(engine)) return fail('VALIDATION', 'one observed container and one scope are required', unchanged)
  if (engine) {
    if (!ctx.run) return fail('PRECONDITION_FAILED', 'container details require a supported native Linux host engine', unchanged)
    const inspect = await ctx.run(swContainerInspectArgv(engine, id)).catch(() => null), logs = await ctx.run(swContainerLogsArgv(engine, id)).catch(() => null)
    if (!inspect?.ok) return fail('NOT_FOUND', 'the container could not be inspected', unchanged)
    return { scope: 'host', account: null, ...parseEngineInspect(inspect.stdout), managed: null, logs: lines(logs ? logs.stdout + logs.stderr : '') }
  }
  const { account } = await scopeAccount(ctx, username!)
  if (!ctx.host) return fail('PRECONDITION_FAILED', 'container details require a supported native Linux host', unchanged)
  const inspect = await ctx.host.run(ctrPodmanArgv(account, ctrTail.inspect(id))).catch(() => null)
  if (!inspect?.ok) return fail('NOT_FOUND', 'the container could not be inspected', unchanged)
  const info = parseEngineInspect(inspect.stdout), stacks = (await readRuntimeRegistry(ctx.store.rootDir, account.id)).stacks ?? []
  const match = stacks.flatMap(stack => parseComposeServices(stack.name, stack.yaml, stack.env).map((service, index) => ({ stack, service, primary: index === 0 }))).find(item => stackServiceName(item.stack.name, item.service.name) === info.name)
  const log = match ? await ctx.host.run(ctrJournalArgv([system.containerUnitName(account.username, info.name)])).catch(() => null) : await ctx.host.run(ctrPodmanArgv(account, ctrTail.logs(id))).catch(() => null)
  return { scope: 'account', account: account.username, ...info, restart: match ? match.stack.restart[match.service.name] ?? match.service.restart : info.restart, managed: match ? { stack: match.stack.name, service: match.service.name, primary: match.primary, restart: match.stack.restart[match.service.name] ?? match.service.restart } : null, logs: lines(log ? log.stdout + log.stderr : '') }
}
const lines = (text: string): string[] => text.split('\n').filter(Boolean).slice(-400).map(line => line.slice(0, 2000).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' '))

async function readPolicyView(ctx: Pick<CtrRouteContext, 'store' | 'catalog'>): Promise<CtrPolicyView> {
  const policy = await readCtrPolicy(ctx.store.rootDir), { apps, ...catalog } = await ctx.catalog.read()
  return { revision: ctrPolicyRevision(policy), registries: policy.registries, templates: policy.templates, apps: apps.map(({ id, name, description, version, port }) => ({ id, name, description, version, port })), catalog, feedUrl: policy.feedUrl, configPath: CTR_REGISTRIES_CONF, stackPath: '~/containers/<stack>' }
}
/** podman-search(1) JSON; only names the trust policy admits reach the operator. */
export function parseEngineSearch(stdout: string, trusted: (name: string) => boolean): CtrSearchView['results'] {
  return parseEngineDocuments('podman', stdout, 100).flatMap(row => {
    const name = String(row.Name ?? '').slice(0, 255)
    return name && trusted(name) ? [{ name, description: String(row.Description ?? '').replace(/\s+/g, ' ').slice(0, 512), stars: Number.isSafeInteger(row.Stars) ? row.Stars as number : 0, official: row.Official === '[OK]' }] : []
  }).slice(0, 25)
}
async function logArgv(ctx: CtrRouteContext, url: URL): Promise<string[]> {
  const username = url.searchParams.get('account'), id = url.searchParams.get('id') ?? '', engine = url.searchParams.get('engine') as SwContainerEngine | null, stack = url.searchParams.get('stack')
  if (engine) { if (username || !SW_CONTAINER_ENGINES.includes(engine) || !SW_CONTAINER_ID.test(id)) return fail('VALIDATION', 'one observed container and one scope are required', unchanged); return swContainerFollowArgv(engine, id) }
  const { account } = await scopeAccount(ctx, username ?? ''), registry = await readRuntimeRegistry(ctx.store.rootDir, account.id)
  if (stack !== null) return ctrJournalArgv(stackUnits(account.username, stackOf(registry, stack)), true)
  if (!SW_CONTAINER_ID.test(id)) return fail('VALIDATION', 'one observed container is required', unchanged)
  const inspect = await ctx.host?.run(ctrPodmanArgv(account, ctrTail.inspect(id))).catch(() => null)
  if (!inspect?.ok) return fail('NOT_FOUND', 'the container could not be inspected', unchanged)
  const name = parseEngineInspect(inspect.stdout).name
  // Stack services log to their unit's journal; podman logs has nothing for them.
  return (registry.stacks ?? []).some(item => parseComposeServices(item.name, item.yaml, item.env).some(service => stackServiceName(item.name, service.name) === name)) ? ctrJournalArgv([system.containerUnitName(account.username, name)], true) : ctrPodmanArgv(account, ctrTail.follow(id))
}
/** Root opens a shell in a container of one account: the id must be in that account's own store. */
export async function resolveContainerTerminal(ctx: Pick<CtrRouteContext, 'store' | 'host'>, username: string, id: string): Promise<Account> {
  const { account } = await scopeAccount(ctx as CtrRouteContext, username)
  if (!CTR_ID.test(id) || !ctx.host) return fail('VALIDATION', 'one observed container is required', unchanged)
  const inspect = await ctx.host.run(ctrPodmanArgv(account, ctrTail.inspect(id))).catch(() => null)
  return inspect?.ok ? account : fail('NOT_FOUND', 'the container is not in this account store', unchanged)
}
const ROUTES: Readonly<Record<string, 'accounts' | 'scope' | 'detail' | 'logs' | 'stream' | 'search' | 'op' | 'policy' | 'catalog'>> = { '/host/software/containers/accounts': 'accounts', '/host/software/containers/scope': 'scope', '/host/software/containers/detail': 'detail', '/host/software/containers/stack-logs': 'logs', '/host/software/containers/log-stream': 'stream', '/host/software/containers/search': 'search', '/host/software/containers/op': 'op', '/host/software/containers/policy': 'policy', '/host/software/containers/catalog': 'catalog' }

export async function handleCtrRoute(req: Request, url: URL, method: string, ctx: CtrRouteContext): Promise<Response | null> {
  const route = ROUTES[url.pathname]
  if (!route) return null
  const action = 'software.containers.' + route, first = await ctx.assertRoot(action), allowed = route === 'op' || route === 'catalog' ? ['POST'] : route === 'policy' ? ['GET', 'POST'] : ['GET']
  if (!allowed.includes(method)) return new Response(null, { status: 405, headers: { allow: allowed.join(', ') } })
  const fresh = async (): Promise<string> => { const now = await ctx.assertRoot(action); if (now.actor !== first.actor) return fail('FORBIDDEN', 'container authority changed', unchanged); return now.actor }
  const body = async (limit: number): Promise<unknown> => {
    if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
    const text = await req.text()
    if (text.length > limit) return fail('VALIDATION', 'the request is too large', unchanged)
    try { return JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  }
  if (route === 'accounts') { params(url, []); const view = await readAccounts(ctx); await fresh(); return json(200, view) }
  if (route === 'scope') {
    params(url, ['account'])
    const username = url.searchParams.get('account')
    if (username === null) { if (!ctx.run || !ctx.binaryPresent) return fail('PRECONDITION_FAILED', 'container engines cannot be read on this host', unchanged); const view = await readHostScope(ctx); await fresh(); return json(200, view) }
    const { account } = await scopeAccount(ctx, username), { view } = await readAccountScope(ctx, account)
    await fresh()
    return json(200, view)
  }
  if (route === 'detail') { params(url, ['account', 'engine', 'id']); const view = await readDetail(ctx, url); await fresh(); return json(200, view) }
  if (route === 'stream') {
    params(url, ['account', 'engine', 'id', 'stack'])
    if (!ctx.follow) return fail('PRECONDITION_FAILED', 'live logs need a supported native Linux host', unchanged)
    const argv = await logArgv(ctx, url)
    await fresh()
    return new Response(ctx.follow(argv), { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
  }
  if (route === 'search') {
    params(url, ['account', 'registry', 'term'])
    const { account } = await scopeAccount(ctx, url.searchParams.get('account') ?? ''), registry = url.searchParams.get('registry') ?? '', term = url.searchParams.get('term') ?? '', policy = await readCtrPolicy(ctx.store.rootDir)
    if (!CTR_SEARCH_TERM.test(term) || !policy.registries.some(item => item.host === registry)) return fail('VALIDATION', 'choose a trusted registry and a search term', unchanged)
    const result = await ctx.host?.run(ctrPodmanArgv(account, ctrTail.search(registry, term))).catch(() => null)
    if (!result?.ok) return fail('SERVICE_UNAVAILABLE', 'this registry did not answer the search', { ...unchanged, reason: 'registry_search_unavailable' })
    const view: CtrSearchView = { registry, results: parseEngineSearch(result.stdout, name => isTrustedImage(policy, name + ':latest')) }
    await fresh()
    return json(200, view)
  }
  if (route === 'catalog') {
    const input = await body(2 * 1024 * 1024)
    if (!object(input) || Object.keys(input).sort().join() !== 'envelope,url' || !(input.envelope === null || typeof input.envelope === 'string') || !(input.url === null || typeof input.url === 'string') || (input.envelope === null) === (input.url === null)) return fail('VALIDATION', 'one signed envelope or one feed URL is required', unchanged)
    const text = input.envelope === null ? await fetchCtrCatalog(input.url as string) : input.envelope as string, root = ctx.store.rootDir
    const actor = await fresh()
    await ctx.catalog.import(text)
    if (input.url !== null) await writeCtrPolicy(root, parseCtrPolicy({ ...await readCtrPolicy(root), feedUrl: input.url }))
    await ctx.audit({ actor, action: 'software.container.catalog', target: 'containers', outcome: 'ok', detail: {} })
    return json(200, await readPolicyView(ctx))
  }
  if (route === 'logs') {
    params(url, ['account', 'stack'])
    const { account } = await scopeAccount(ctx, url.searchParams.get('account') ?? ''), stack = stackOf(await readRuntimeRegistry(ctx.store.rootDir, account.id), url.searchParams.get('stack') ?? '')
    const result = await ctx.host?.run(ctrJournalArgv(stackUnits(account.username, stack))).catch(() => null)
    if (!result?.ok) return fail('PRECONDITION_FAILED', 'the log could not be read', unchanged)
    await fresh()
    return json(200, { account: account.username, stack: stack.name, lines: lines(result.stdout) })
  }
  if (route === 'policy') {
    const root = ctx.store.rootDir
    if (method === 'GET') { const view = await readPolicyView(ctx); await fresh(); return json(200, view) }
    const input = await body(4 * 1024 * 1024)
    if (!object(input) || Object.keys(input).sort().join() !== 'expectedRevision,policy') return fail('VALIDATION', 'the observed revision and a policy are required', unchanged)
    const next = parseCtrPolicy(input.policy), current = await readCtrPolicy(root)
    if (ctrPolicyRevision(current) !== input.expectedRevision) return fail('CONFLICT', 'the container policy changed since it was read', { ...unchanged, currentRevision: ctrPolicyRevision(current) })
    if (!ctx.reconcile) return fail('PRECONDITION_FAILED', 'the container policy can be changed only on a supported Linux host', unchanged)
    const actor = await fresh()
    await writeCtrPolicy(root, next)
    const applied = await ctx.reconcile(actor).catch(() => ({ status: 'failed' as const }))
    if (applied.status === 'failed') {
      await writeCtrPolicy(root, current)
      const restored = await ctx.reconcile(actor).catch(() => ({ status: 'failed' as const }))
      return fail('CONFIG_TEST_FAILED', 'the policy did not pass the server configuration tests and was undone', restored.status === 'failed' ? { stateChanged: true, verificationRequired: true } : unchanged)
    }
    await ctx.audit({ actor, action: 'software.container.policy', target: 'containers', outcome: 'ok', detail: { registries: next.registries.length, templates: next.templates.length } })
    return json(200, await readPolicyView(ctx))
  }
  let request
  try { request = readCtrOpRequest(await body(100_000)) } catch (error) { if (isXpanelError(error)) throw error; return fail('VALIDATION', 'the container operation is invalid', unchanged) }
  if (!ctx.host || !ctx.reconcile) return fail('PRECONDITION_FAILED', 'container changes require a supported native Linux host', unchanged)
  const scope = await scopeAccount(ctx, request.account)
  if (scope.features.disabled.includes(RUNTIME_FEATURES.containers)) return fail('FORBIDDEN', 'the account plan does not allow containers', unchanged)
  const read = await readAccountScope(ctx, scope.account), op = request.action.op
  if (read.view.revision !== request.expectedRevision) return fail('CONFLICT', 'containers changed since they were read', { ...unchanged, currentRevision: read.view.revision })
  if (read.view.state !== 'read' && !['stack.stop', 'stack.remove', 'registry.logout'].includes(op)) return fail('PRECONDITION_FAILED', 'rootless containers are not available for this account on this server', { ...unchanged, reason: read.view.reason })
  const actor = await fresh()
  const target = 'account:' + scope.account.username
  try {
    const response = await applyOp(ctx, read, scope, request.action, request.expectedRevision, actor, async () => { await fresh() })
    await ctx.audit({ actor, action: 'software.container.op', target, outcome: 'ok', detail: { op } })
    return response
  } catch (error) {
    await ctx.audit({ actor, action: 'software.container.op', target, outcome: 'failed', detail: { op } }).catch(() => {})
    throw error
  }
}
