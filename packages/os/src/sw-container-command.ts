/**
 * Reviewed container-engine grammar. Reads use the engines' documented machine formats; the only
 * mutation is start/stop/restart of one observed full container id. No image, registry, run or exec.
 * podman(1) subcommands document `--format json`; docker(1) documents `--format '{{json .}}'` (one JSON value per line).
 */
export type SwContainerEngine = 'podman' | 'docker'
export type SwContainerRead = 'version' | 'containers' | 'images' | 'networks' | 'volumes' | 'info'
export type SwContainerAction = 'start' | 'stop' | 'restart'
export const SW_CONTAINER_ENGINES: readonly SwContainerEngine[] = ['podman', 'docker']
export const SW_CONTAINER_BINARY: Readonly<Record<SwContainerEngine, string>> = Object.freeze({ podman: '/usr/bin/podman', docker: '/usr/bin/docker' })
export const SW_CONTAINER_ID = /^[0-9a-f]{64}$/
/** podman-stop(1)/docker-stop(1) --time: seconds to wait before SIGKILL. */
export const SW_CONTAINER_STOP_SECONDS = 30
const JSON_LINE = '{{json .}}'
const READS: Readonly<Record<SwContainerEngine, Readonly<Record<SwContainerRead, readonly string[]>>>> = {
  podman: { version: ['version', '--format', 'json'], containers: ['ps', '--all', '--format', 'json'], images: ['images', '--format', 'json'], networks: ['network', 'ls', '--format', 'json'], volumes: ['volume', 'ls', '--format', 'json'], info: ['info', '--format', 'json'] },
  docker: { version: ['version', '--format', JSON_LINE], containers: ['ps', '--all', '--no-trunc', '--format', JSON_LINE], images: ['images', '--no-trunc', '--format', JSON_LINE], networks: ['network', 'ls', '--no-trunc', '--format', JSON_LINE], volumes: ['volume', 'ls', '--format', JSON_LINE], info: ['info', '--format', JSON_LINE] },
}
const isEngine = (value: unknown): value is SwContainerEngine => value === 'podman' || value === 'docker'
export const isSwContainerAction = (value: unknown): value is SwContainerAction => value === 'start' || value === 'stop' || value === 'restart'

export function swContainerReadArgv(engine: SwContainerEngine, read: SwContainerRead): string[] {
  if (!isEngine(engine) || !Object.hasOwn(READS[engine], read)) throw new Error('unsupported_container_read')
  return [SW_CONTAINER_BINARY[engine], ...READS[engine][read]]
}
export function swContainerActionArgv(engine: SwContainerEngine, action: SwContainerAction, id: string): string[] {
  if (!isEngine(engine) || !isSwContainerAction(action) || typeof id !== 'string' || !SW_CONTAINER_ID.test(id)) throw new Error('unsupported_container_action')
  return [SW_CONTAINER_BINARY[engine], action, ...(action === 'start' ? [] : ['--time', String(SW_CONTAINER_STOP_SECONDS)]), '--', id]
}
export function isSwContainerCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.length < 2 || argv.some(value => typeof value !== 'string')) return false
  const engine = SW_CONTAINER_ENGINES.find(item => SW_CONTAINER_BINARY[item] === argv[0])
  if (!engine) return false
  const same = (expected: readonly string[]): boolean => expected.length === argv.length && expected.every((value, index) => value === argv[index])
  if ((Object.keys(READS[engine]) as SwContainerRead[]).some(read => same(swContainerReadArgv(engine, read)))) return true
  const id = argv.at(-1) as string
  return SW_CONTAINER_ID.test(id) && (['start', 'stop', 'restart'] as const).some(action => same(swContainerActionArgv(engine, action, id)))
}

export interface SwContainerRow { id: string; name: string; image: string; state: string; status: string; ports: string[] }
export interface SwContainerEngineRow { engine: SwContainerEngine; state: 'read' | 'absent' | 'unavailable'; reason: null | 'engine-absent' | 'engine-unreachable' | 'invalid-engine-output'; version: string | null; revision: string | null; containers: SwContainerRow[] }
export interface SwContainersView { scope: 'host-engines'; state: 'read' | 'unavailable'; reason: null | 'unsupported-host' | 'no-engine' | 'engine-unavailable'; observedAt: string; engines: SwContainerEngineRow[]; rootlessAccounts: 'not-read'; actions: { lifecycle: boolean } }
export interface SwEngineFacts { runtime: string | null; storageDriver: string | null; cgroupVersion: '1' | '2' | null; rootless: boolean | null; registries: string[] }
export interface SwContainerEngineDetail { engine: SwContainerEngine; state: 'read' | 'absent' | 'unavailable'; reason: SwContainerEngineRow['reason']; version: string | null; facts: SwEngineFacts | null; images: { id: string; tags: string[]; size: string | null }[]; networks: { id: string; name: string; driver: string }[]; volumes: { name: string; driver: string }[] }
export interface SwContainerEngineView { scope: 'host-engines'; state: 'read' | 'unavailable'; reason: SwContainersView['reason']; observedAt: string; engines: SwContainerEngineDetail[]; actions: { pull: false; registryWrite: false; daemonWrite: false; networkWrite: false; volumeWrite: false } }

/** Strict public view grammar shared by API and browser; self-contained so the browser binding can serialize it. */
export function readSwContainersView(value: unknown): SwContainersView {
  const bad = (): never => { throw new Error('invalid_container_view') }
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const keys = (item: Record<string, unknown>, list: string[]): boolean => Object.keys(item).sort().join() === [...list].sort().join()
  if (!object(value) || !keys(value, ['scope', 'state', 'reason', 'observedAt', 'engines', 'rootlessAccounts', 'actions']) || value.scope !== 'host-engines' || !['read', 'unavailable'].includes(value.state) || ![null, 'unsupported-host', 'no-engine', 'engine-unavailable'].includes(value.reason)
    || typeof value.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) || value.rootlessAccounts !== 'not-read'
    || !object(value.actions) || !keys(value.actions, ['lifecycle']) || typeof value.actions.lifecycle !== 'boolean' || !Array.isArray(value.engines) || value.engines.length > 2) return bad()
  const seen = new Set<string>()
  const engines = value.engines.map((raw: unknown) => {
    if (!object(raw) || !keys(raw, ['engine', 'state', 'reason', 'version', 'revision', 'containers']) || !['podman', 'docker'].includes(raw.engine) || seen.has(raw.engine) || !['read', 'absent', 'unavailable'].includes(raw.state)
      || ![null, 'engine-absent', 'engine-unreachable', 'invalid-engine-output'].includes(raw.reason) || (raw.state === 'read') !== (raw.reason === null) || raw.state === 'absent' && raw.reason !== 'engine-absent'
      || !(raw.version === null || typeof raw.version === 'string' && /^[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[-+~][A-Za-z0-9.+~-]{1,40})?$/.test(raw.version)) || !(raw.revision === null || typeof raw.revision === 'string' && /^[0-9a-f]{64}$/.test(raw.revision))
      || (raw.state === 'read') !== (raw.revision !== null) || !Array.isArray(raw.containers) || raw.containers.length > 500 || raw.state !== 'read' && raw.containers.length) return bad()
    seen.add(raw.engine)
    const ids = new Set<string>()
    const containers = raw.containers.map((row: unknown) => {
      if (!object(row) || !keys(row, ['id', 'name', 'image', 'state', 'status', 'ports']) || typeof row.id !== 'string' || !/^[0-9a-f]{64}$/.test(row.id) || ids.has(row.id) || typeof row.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(row.name)
        || typeof row.image !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(row.image) || !['created', 'configured', 'initialized', 'running', 'paused', 'restarting', 'stopping', 'stopped', 'exited', 'removing', 'dead', 'unknown'].includes(row.state)
        || typeof row.status !== 'string' || !/^[A-Za-z0-9 ():.,+-]{1,80}$/.test(row.status) || !Array.isArray(row.ports) || row.ports.length > 64 || row.ports.some((port: unknown) => typeof port !== 'string' || !/^(?:[0-9A-Fa-f.:[\]]{0,45}:)?(?:[0-9]{1,5}(?:-[0-9]{1,5})?->)?[0-9]{1,5}(?:-[0-9]{1,5})?\/(?:tcp|udp|sctp)$/.test(port))) return bad()
      ids.add(row.id)
      return { id: row.id, name: row.name, image: row.image, state: row.state, status: row.status, ports: [...row.ports] }
    })
    return { engine: raw.engine, state: raw.state, reason: raw.reason, version: raw.version, revision: raw.revision, containers }
  })
  if (value.state === 'read' !== engines.some((item: { state: string }) => item.state === 'read') || value.state === 'read' && value.reason !== null || value.state === 'unavailable' && value.reason === null || value.actions.lifecycle && value.state !== 'read') return bad()
  return { scope: 'host-engines', state: value.state, reason: value.reason, observedAt: value.observedAt, engines, rootlessAccounts: 'not-read', actions: { lifecycle: value.actions.lifecycle } }
}

export function readSwContainerEngineView(value: unknown): SwContainerEngineView {
  const bad = (): never => { throw new Error('invalid_container_engine_view') }
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const keys = (item: Record<string, unknown>, list: string[]): boolean => Object.keys(item).sort().join() === [...list].sort().join()
  const word = (item: unknown, max = 64): item is string => typeof item === 'string' && item.length >= 1 && item.length <= max && /^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/.test(item)
  if (!object(value) || !keys(value, ['scope', 'state', 'reason', 'observedAt', 'engines', 'actions']) || value.scope !== 'host-engines' || !['read', 'unavailable'].includes(value.state) || ![null, 'unsupported-host', 'no-engine', 'engine-unavailable'].includes(value.reason)
    || typeof value.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt))
    || !object(value.actions) || !keys(value.actions, ['pull', 'registryWrite', 'daemonWrite', 'networkWrite', 'volumeWrite']) || Object.values(value.actions).some(item => item !== false) || !Array.isArray(value.engines) || value.engines.length > 2) return bad()
  const seen = new Set<string>()
  const engines = value.engines.map((raw: unknown) => {
    if (!object(raw) || !keys(raw, ['engine', 'state', 'reason', 'version', 'facts', 'images', 'networks', 'volumes']) || !['podman', 'docker'].includes(raw.engine) || seen.has(raw.engine) || !['read', 'absent', 'unavailable'].includes(raw.state)
      || ![null, 'engine-absent', 'engine-unreachable', 'invalid-engine-output'].includes(raw.reason) || (raw.state === 'read') !== (raw.reason === null) || !(raw.version === null || typeof raw.version === 'string' && /^[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[-+~][A-Za-z0-9.+~-]{1,40})?$/.test(raw.version))
      || !Array.isArray(raw.images) || raw.images.length > 1000 || !Array.isArray(raw.networks) || raw.networks.length > 200 || !Array.isArray(raw.volumes) || raw.volumes.length > 1000 || raw.state !== 'read' && (raw.facts !== null || raw.images.length || raw.networks.length || raw.volumes.length)) return bad()
    seen.add(raw.engine)
    let facts: SwEngineFacts | null = null
    if (raw.facts !== null) {
      const f = raw.facts
      if (!object(f) || !keys(f, ['runtime', 'storageDriver', 'cgroupVersion', 'rootless', 'registries']) || !(f.runtime === null || word(f.runtime)) || !(f.storageDriver === null || word(f.storageDriver)) || ![null, '1', '2'].includes(f.cgroupVersion) || ![null, true, false].includes(f.rootless)
        || !Array.isArray(f.registries) || f.registries.length > 32 || f.registries.some((item: unknown) => !word(item, 253))) return bad()
      facts = { runtime: f.runtime, storageDriver: f.storageDriver, cgroupVersion: f.cgroupVersion, rootless: f.rootless, registries: [...f.registries] }
    } else if (raw.state === 'read') return bad()
    const imageIds = new Set<string>(), networkIds = new Set<string>(), volumeNames = new Set<string>()
    const images = raw.images.map((row: unknown) => {
      if (!object(row) || !keys(row, ['id', 'tags', 'size']) || typeof row.id !== 'string' || !/^[0-9a-f]{64}$/.test(row.id) || imageIds.has(row.id) || !Array.isArray(row.tags) || row.tags.length > 32 || row.tags.some((tag: unknown) => !word(tag, 255))
        || !(row.size === null || typeof row.size === 'string' && /^[0-9]+(?:\.[0-9]+)?\s?[kKMGT]?B$/.test(row.size))) return bad()
      imageIds.add(row.id); return { id: row.id, tags: [...row.tags], size: row.size }
    })
    const networks = raw.networks.map((row: unknown) => {
      if (!object(row) || !keys(row, ['id', 'name', 'driver']) || typeof row.id !== 'string' || !/^[0-9a-f]{12,64}$/.test(row.id) || networkIds.has(row.id) || !word(row.name, 128) || !word(row.driver)) return bad()
      networkIds.add(row.id); return { id: row.id, name: row.name, driver: row.driver }
    })
    const volumes = raw.volumes.map((row: unknown) => {
      if (!object(row) || !keys(row, ['name', 'driver']) || !word(row.name, 255) || volumeNames.has(row.name) || !word(row.driver)) return bad()
      volumeNames.add(row.name); return { name: row.name, driver: row.driver }
    })
    return { engine: raw.engine, state: raw.state, reason: raw.reason, version: raw.version, facts, images, networks, volumes }
  })
  if (value.state === 'read' !== engines.some((item: { state: string }) => item.state === 'read') || value.state === 'read' && value.reason !== null || value.state === 'unavailable' && value.reason === null) return bad()
  return { scope: 'host-engines', state: value.state, reason: value.reason, observedAt: value.observedAt, engines, actions: { pull: false, registryWrite: false, daemonWrite: false, networkWrite: false, volumeWrite: false } }
}
