import { createHash } from 'node:crypto'
import { fail, isXpanelError, msgid } from '@xpanel/core'
import { isSwContainerAction, SW_CONTAINER_BINARY, SW_CONTAINER_ENGINES, SW_CONTAINER_ID, swContainerActionArgv, swContainerReadArgv } from '../../../packages/os/src/sw-container-command.ts'
import type { SwContainerAction, SwContainerEngine, SwContainerEngineDetail, SwContainerEngineRow, SwContainerEngineView, SwContainerRow, SwContainersView, SwEngineFacts } from '../../../packages/os/src/sw-container-command.ts'
import type { HostJobPlan, HostJobRun, HostJobView } from './host-job-contract.ts'

export type SwContainerRun = (argv: readonly string[]) => Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }>
export interface SwContainerRouteContext {
  /** Re-authenticates the current caller and requires root; returns the fresh actor. */
  assertRoot(action: string): Promise<{ actor: string }>
  /** null off a qualified native Linux host. */
  run: SwContainerRun | null
  /** Fixed engine executable presence (regular file); distinguishes absent from unreachable. */
  binaryPresent: ((path: string) => Promise<boolean>) | null
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  audit(entry: { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }): Promise<void>
  now?: () => Date
}

const MAX_OUTPUT = 2 * 1024 * 1024
const unchanged = { stateChanged: false }
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = (): never => { throw new Error('invalid_engine_output') }
const STATES = new Set(['created', 'configured', 'initialized', 'running', 'paused', 'restarting', 'stopping', 'stopped', 'exited', 'removing', 'dead', 'unknown'])
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/
const STATUS = /^[A-Za-z0-9 ():.,+-]{1,80}$/
const PORT = /^(?:[0-9A-Fa-f.:[\]]{0,45}:)?(?:[0-9]{1,5}(?:-[0-9]{1,5})?->)?[0-9]{1,5}(?:-[0-9]{1,5})?\/(?:tcp|udp|sctp)$/
const WORD = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/
const VERSION = /^[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[-+~][A-Za-z0-9.+~-]{1,40})?$/
const word = (value: unknown, max = 64): string => typeof value === 'string' && value.length >= 1 && value.length <= max && WORD.test(value) ? value : invalid()

/** podman emits one JSON array; docker emits one JSON object per line. */
export function parseEngineDocuments(engine: SwContainerEngine, stdout: string, limit: number): Record<string, unknown>[] {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_OUTPUT || /\u0000/.test(stdout)) return invalid()
  let rows: unknown[]
  try { rows = engine === 'podman' ? (stdout.trim() === '' ? [] : JSON.parse(stdout)) : stdout.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line)) } catch { return invalid() }
  if (!Array.isArray(rows) || rows.length > limit || rows.some(row => !object(row))) return invalid()
  return rows as Record<string, unknown>[]
}
const single = (engine: SwContainerEngine, stdout: string): Record<string, unknown> => {
  const rows = engine === 'podman' ? [(() => { try { return JSON.parse(stdout) } catch { return invalid() } })()] : parseEngineDocuments(engine, stdout, 1)
  if (Buffer.byteLength(stdout) > MAX_OUTPUT || rows.length !== 1 || !object(rows[0])) return invalid()
  return rows[0]
}
export function parseEngineVersion(engine: SwContainerEngine, stdout: string): string {
  const value = single(engine, stdout), client = value.Client, server = value.Server
  // docker-version(1): a missing Server section means the daemon is unreachable; podman is daemonless locally.
  const source = engine === 'docker' ? server : client
  if (!object(source) || typeof source.Version !== 'string' || !VERSION.test(source.Version)) return invalid()
  return source.Version
}
const ports = (engine: SwContainerEngine, raw: unknown): string[] => {
  if (engine === 'docker') {
    if (raw === undefined || raw === '') return []
    if (typeof raw !== 'string' || raw.length > 4096) return invalid()
    const list = raw.split(', ')
    if (list.length > 64 || list.some(item => !PORT.test(item))) return invalid()
    return list
  }
  if (raw === null || raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 64) return invalid()
  return raw.map(item => {
    if (!object(item)) return invalid()
    const host = item.host_ip === undefined || item.host_ip === '' ? '0.0.0.0' : item.host_ip, range = item.range === undefined ? 1 : item.range
    const int = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 65535 ? value : invalid()
    if (typeof host !== 'string' || !/^[0-9A-Fa-f.:]{1,45}$/.test(host) || !['tcp', 'udp', 'sctp'].includes(String(item.protocol)) || typeof range !== 'number' || !Number.isSafeInteger(range) || range < 1 || range > 65535) return invalid()
    const span = (start: number): string => range === 1 ? String(start) : start + '-' + (start + range - 1)
    const text = (int(item.host_port) ? (host.includes(':') ? '[' + host + ']' : host) + ':' + span(int(item.host_port)) + '->' : '') + span(int(item.container_port)) + '/' + item.protocol
    return PORT.test(text) ? text : invalid()
  })
}
export function parseEngineContainers(engine: SwContainerEngine, stdout: string): SwContainerRow[] {
  const ids = new Set<string>()
  return parseEngineDocuments(engine, stdout, 500).map(row => {
    const id = engine === 'podman' ? row.Id : row.ID
    const names = engine === 'podman' ? (Array.isArray(row.Names) ? row.Names : invalid()) : (typeof row.Names === 'string' ? row.Names.split(',') : invalid())
    const state = typeof row.State === 'string' ? row.State.toLowerCase() : invalid()
    if (typeof id !== 'string' || !SW_CONTAINER_ID.test(id) || ids.has(id) || typeof names[0] !== 'string' || !NAME.test(names[0]) || typeof row.Image !== 'string' || !IMAGE.test(row.Image) || !STATES.has(state) || typeof row.Status !== 'string' || !STATUS.test(row.Status)) return invalid()
    ids.add(id)
    return { id, name: names[0], image: row.Image, state, status: row.Status, ports: ports(engine, row.Ports) }
  }).sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id))
}
export function parseEngineImages(engine: SwContainerEngine, stdout: string): SwContainerEngineDetail['images'] {
  const byId = new Map<string, { id: string; tags: string[]; size: string | null }>()
  for (const row of parseEngineDocuments(engine, stdout, 1000)) {
    const rawId = engine === 'podman' ? row.Id : row.ID, id = typeof rawId === 'string' ? rawId.replace(/^sha256:/, '') : ''
    if (!SW_CONTAINER_ID.test(id)) return invalid()
    let tags: string[], size: string | null
    if (engine === 'podman') {
      tags = row.RepoTags === null || row.RepoTags === undefined ? [] : Array.isArray(row.RepoTags) ? row.RepoTags.map(tag => word(tag, 255)) : invalid()
      size = typeof row.Size === 'number' && Number.isSafeInteger(row.Size) && row.Size >= 0 ? (row.Size / 1e6).toFixed(1) + ' MB' : null
      if (byId.has(id)) return invalid()
    } else {
      // docker-images(1): untagged images report <none> for repository and tag.
      tags = row.Repository === '<none>' || row.Tag === '<none>' ? [] : [word(String(row.Repository) + ':' + String(row.Tag), 255)]
      size = typeof row.Size === 'string' && /^[0-9]+(?:\.[0-9]+)?\s?[kKMGT]?B$/.test(row.Size) ? row.Size : null
    }
    const current = byId.get(id) ?? { id, tags: [], size }
    for (const tag of tags) if (!current.tags.includes(tag)) current.tags.push(tag)
    if (current.tags.length > 32) return invalid()
    byId.set(id, current)
  }
  return [...byId.values()].sort((a, b) => Number(!a.tags.length) - Number(!b.tags.length) || (a.tags[0] ?? '').localeCompare(b.tags[0] ?? '', 'en') || a.id.localeCompare(b.id))
}
export function parseEngineNetworks(engine: SwContainerEngine, stdout: string): SwContainerEngineDetail['networks'] {
  const ids = new Set<string>()
  return parseEngineDocuments(engine, stdout, 200).map(row => {
    const id = engine === 'podman' ? row.id : row.ID, name = engine === 'podman' ? row.name : row.Name, driver = engine === 'podman' ? row.driver : row.Driver
    if (typeof id !== 'string' || !/^[0-9a-f]{12,64}$/.test(id) || ids.has(id)) return invalid()
    ids.add(id)
    return { id, name: word(name, 128), driver: word(driver) }
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'))
}
export function parseEngineVolumes(engine: SwContainerEngine, stdout: string): SwContainerEngineDetail['volumes'] {
  const names = new Set<string>()
  return parseEngineDocuments(engine, stdout, 1000).map(row => {
    const name = word(row.Name, 255)
    if (names.has(name)) return invalid()
    names.add(name)
    return { name, driver: word(row.Driver) }
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'))
}
export function parseEngineInfo(engine: SwContainerEngine, stdout: string): SwEngineFacts {
  const value = single(engine, stdout)
  const optional = (item: unknown): string | null => item === undefined || item === null || item === '' ? null : word(item)
  if (engine === 'podman') {
    const host = object(value.host) ? value.host : invalid(), store = object(value.store) ? value.store : invalid()
    const runtime = object(host.ociRuntime) ? optional(host.ociRuntime.name) : null, cgroup = host.cgroupVersion
    const rootless = object(host.security) && typeof host.security.rootless === 'boolean' ? host.security.rootless : null
    const search = object(value.registries) && Array.isArray(value.registries.search) ? value.registries.search : []
    if (search.length > 32) return invalid()
    return { runtime, storageDriver: optional(store.graphDriverName), cgroupVersion: cgroup === 'v2' ? '2' : cgroup === 'v1' ? '1' : null, rootless, registries: search.map(item => word(item, 253)) }
  }
  const security = Array.isArray(value.SecurityOptions) ? value.SecurityOptions : []
  const indexes = object(value.RegistryConfig) && object(value.RegistryConfig.IndexConfigs) ? Object.keys(value.RegistryConfig.IndexConfigs) : []
  if (security.length > 32 || indexes.length > 32) return invalid()
  return { runtime: optional(value.DefaultRuntime), storageDriver: optional(value.Driver), cgroupVersion: value.CgroupVersion === '2' ? '2' : value.CgroupVersion === '1' ? '1' : null, rootless: security.some(item => item === 'name=rootless'), registries: indexes.map(item => word(item, 253)) }
}

const read = async (run: SwContainerRun, argv: readonly string[]): Promise<string | null> => {
  try { const result = await run(argv); return result.ok && result.code === 0 ? result.stdout : null } catch { return null }
}
type EnginePresence = { engine: SwContainerEngine; state: 'present' | 'absent' }
async function presence(ctx: Pick<SwContainerRouteContext, 'binaryPresent'>): Promise<EnginePresence[]> {
  return Promise.all(SW_CONTAINER_ENGINES.map(async engine => ({ engine, state: await ctx.binaryPresent!(SW_CONTAINER_BINARY[engine]).catch(() => false) ? 'present' as const : 'absent' as const })))
}
const engineRevision = (engine: SwContainerEngine, containers: readonly SwContainerRow[]): string => sha(JSON.stringify([engine, containers.map(row => [row.id, row.name, row.image, row.state])]))

export async function readSwContainers(ctx: Pick<SwContainerRouteContext, 'run' | 'binaryPresent' | 'now'>, lifecycle: boolean): Promise<SwContainersView> {
  const observedAt = (ctx.now?.() ?? new Date()).toISOString()
  if (!ctx.run || !ctx.binaryPresent) return { scope: 'host-engines', state: 'unavailable', reason: 'unsupported-host', observedAt, engines: [], rootlessAccounts: 'not-read', actions: { lifecycle: false } }
  const run = ctx.run
  const engines: SwContainerEngineRow[] = await Promise.all((await presence(ctx)).map(async ({ engine, state }): Promise<SwContainerEngineRow> => {
    if (state === 'absent') return { engine, state: 'absent', reason: 'engine-absent', version: null, revision: null, containers: [] }
    const [version, list] = await Promise.all([read(run, swContainerReadArgv(engine, 'version')), read(run, swContainerReadArgv(engine, 'containers'))])
    if (version === null || list === null) return { engine, state: 'unavailable', reason: 'engine-unreachable', version: null, revision: null, containers: [] }
    try {
      const containers = parseEngineContainers(engine, list)
      return { engine, state: 'read', reason: null, version: parseEngineVersion(engine, version), revision: engineRevision(engine, containers), containers }
    } catch { return { engine, state: 'unavailable', reason: 'invalid-engine-output', version: null, revision: null, containers: [] } }
  }))
  const any = engines.some(item => item.state === 'read')
  return { scope: 'host-engines', state: any ? 'read' : 'unavailable', reason: any ? null : engines.every(item => item.state === 'absent') ? 'no-engine' : 'engine-unavailable', observedAt, engines, rootlessAccounts: 'not-read', actions: { lifecycle: lifecycle && any } }
}
export async function readSwContainerEngine(ctx: Pick<SwContainerRouteContext, 'run' | 'binaryPresent' | 'now'>): Promise<SwContainerEngineView> {
  const observedAt = (ctx.now?.() ?? new Date()).toISOString(), actions = { pull: false, registryWrite: false, daemonWrite: false, networkWrite: false, volumeWrite: false } as const
  if (!ctx.run || !ctx.binaryPresent) return { scope: 'host-engines', state: 'unavailable', reason: 'unsupported-host', observedAt, engines: [], actions }
  const run = ctx.run
  const engines: SwContainerEngineDetail[] = await Promise.all((await presence(ctx)).map(async ({ engine, state }): Promise<SwContainerEngineDetail> => {
    const empty = { facts: null, images: [], networks: [], volumes: [], version: null }
    if (state === 'absent') return { engine, state: 'absent', reason: 'engine-absent', ...empty }
    const outputs = await Promise.all((['version', 'info', 'images', 'networks', 'volumes'] as const).map(item => read(run, swContainerReadArgv(engine, item))))
    if (outputs.some(item => item === null)) return { engine, state: 'unavailable', reason: 'engine-unreachable', ...empty }
    const [version, info, images, networks, volumes] = outputs as string[]
    try { return { engine, state: 'read', reason: null, version: parseEngineVersion(engine, version!), facts: parseEngineInfo(engine, info!), images: parseEngineImages(engine, images!), networks: parseEngineNetworks(engine, networks!), volumes: parseEngineVolumes(engine, volumes!) } }
    catch { return { engine, state: 'unavailable', reason: 'invalid-engine-output', ...empty } }
  }))
  const any = engines.some(item => item.state === 'read')
  return { scope: 'host-engines', state: any ? 'read' : 'unavailable', reason: any ? null : engines.every(item => item.state === 'absent') ? 'no-engine' : 'engine-unavailable', observedAt, engines, actions }
}

const TITLES: Readonly<Record<SwContainerAction, string>> = { start: msgid('Start container {name}'), stop: msgid('Stop container {name}'), restart: msgid('Restart container {name}') }
/** The job verifies by re-reading the engine; a stopped container must not run and a started one must run. */
export function buildSwContainerJobPlan(input: { engine: SwContainerEngine; action: SwContainerAction; container: SwContainerRow; expectedRevision: string; revalidate: { run: SwContainerRun; assertActor(): Promise<void> } }): HostJobPlan {
  const { engine, action, container } = input, argv = swContainerActionArgv(engine, action, container.id), list = swContainerReadArgv(engine, 'containers')
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index])
  const current = async (run: HostJobRun | SwContainerRun): Promise<SwContainerRow | null> => {
    const result = await run(list)
    if (!result.ok || result.code !== 0) throw new Error('container_readback_unavailable')
    return parseEngineContainers(engine, result.stdout).find(row => row.id === container.id) ?? null
  }
  return {
    kind: 'software.container.' + action, summary: action + ' ' + engine + ' container ' + container.name, accountId: null,
    fingerprint: { engine, containerId: container.id, name: container.name, action, expectedRevision: input.expectedRevision },
    detail: { engine, container: container.name, image: container.image, action, stopSeconds: action === 'start' ? null : 30 },
    steps: [{ id: 'container-' + action, title: TITLES[action], titleValues: { name: container.name }, argv, timeoutMs: 90_000, mutates: true }],
    policy: candidate => same(candidate, argv) || same(candidate, list),
    beforeStep: async () => {
      await input.revalidate.assertActor()
      const fresh = await current(input.revalidate.run)
      if (!fresh || fresh.name !== container.name || fresh.image !== container.image) return fail('CONFLICT', 'the container changed after review', unchanged)
      await input.revalidate.assertActor()
    },
    verify: async run => {
      const after = await current(run)
      const ok = !!after && (action === 'stop' ? ['exited', 'stopped', 'created', 'configured'].includes(after.state) : after.state === 'running')
      return { ok, detail: { observedState: after?.state ?? 'missing', verificationRequired: !ok } }
    },
  }
}

async function readBody(req: Request): Promise<{ engine: SwContainerEngine; containerId: string; action: SwContainerAction; expectedRevision: string }> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const text = await req.text()
  if (text.length > 1024) return fail('VALIDATION', 'container request is too large', unchanged)
  let value: unknown
  try { value = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  if (!object(value) || Object.keys(value).sort().join() !== 'action,containerId,engine,expectedRevision' || !SW_CONTAINER_ENGINES.includes(value.engine as SwContainerEngine) || typeof value.containerId !== 'string' || !SW_CONTAINER_ID.test(value.containerId)
    || !isSwContainerAction(value.action) || typeof value.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedRevision)) return fail('VALIDATION', 'an engine, one observed full container id, start/stop/restart and the observed revision are required', unchanged)
  return { engine: value.engine as SwContainerEngine, containerId: value.containerId, action: value.action, expectedRevision: value.expectedRevision }
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export async function handleSwContainersRoute(req: Request, url: URL, method: string, ctx: SwContainerRouteContext): Promise<Response | null> {
  const operation = url.pathname === '/host/software/containers' ? 'read' : url.pathname === '/host/software/containers/engine' ? 'engine' : url.pathname === '/host/software/containers/action' ? 'action' : null
  if (!operation) return null
  const action = 'software.containers.' + operation, first = await ctx.assertRoot(action), expected = operation === 'action' ? 'POST' : 'GET'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search) return fail('VALIDATION', 'container requests do not accept selectors', unchanged)
  const fresh = async (): Promise<string> => { const now = await ctx.assertRoot(action); if (now.actor !== first.actor) return fail('FORBIDDEN', 'container authority changed', unchanged); return now.actor }
  if (operation === 'read') { const view = await readSwContainers(ctx, ctx.submitJob !== null); await fresh(); return json(200, view) }
  if (operation === 'engine') { const view = await readSwContainerEngine(ctx); await fresh(); return json(200, view) }
  const input = await readBody(req)
  if (!ctx.run || !ctx.binaryPresent) return fail('PRECONDITION_FAILED', 'container changes require a supported native Linux host engine', unchanged)
  if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable; no container change was submitted', unchanged)
  const view = await readSwContainers(ctx, true), engine = view.engines.find(item => item.engine === input.engine)
  if (!engine || engine.state !== 'read') return fail('PRECONDITION_FAILED', 'the selected container engine could not be observed', unchanged)
  if (engine.revision !== input.expectedRevision) return fail('CONFLICT', 'containers changed since they were read', { ...unchanged, currentRevision: engine.revision })
  const container = engine.containers.find(row => row.id === input.containerId)
  if (!container) return fail('NOT_FOUND', 'the container is not in the observed list', unchanged)
  if (input.action === 'start' && container.state === 'running' || input.action === 'stop' && container.state !== 'running') return fail('PRECONDITION_FAILED', 'the container is already in the requested state', unchanged)
  const run = ctx.run, assertActor = async (): Promise<void> => { await fresh() }
  const plan = buildSwContainerJobPlan({ engine: input.engine, action: input.action, container, expectedRevision: input.expectedRevision, revalidate: { run, assertActor } })
  const actor = await fresh()
  await ctx.audit({ actor, action: 'software.container.change_requested', target: input.engine + ':' + container.name, outcome: 'ok', detail: { action: input.action, containerId: container.id } })
  let job: HostJobView
  try { job = await ctx.submitJob(plan, actor) }
  catch (error) {
    if (isXpanelError(error) && error.detail?.stateChanged === false) throw error
    return fail('SERVICE_UNAVAILABLE', 'container job submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  }
  if (!job || typeof job.id !== 'string' || job.kind !== plan.kind) return fail('SERVICE_UNAVAILABLE', 'container job submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  return json(202, { job })
}
