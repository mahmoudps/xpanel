import { SERVICE_MANAGER_SYSTEMCTL, serviceManagerShow } from './service-manager-command.ts'

/**
 * Optional shared add-on services. Units are fixed here; systemctl(1) start/stop/restart take one
 * literal unit after `--`. Packages come only from the shipped software center catalog (componentId);
 * null means no reviewed distribution package exists for that service.
 */
export type SwAddonServiceId = 'memcached' | 'rabbitmq' | 'elasticsearch' | 'opensearch'
export type SwAddonAction = 'start' | 'stop' | 'restart'
export interface SwAddonService { id: SwAddonServiceId; kind: 'cache' | 'broker' | 'search'; name: string; unit: string; componentId: string | null }
export const SW_ADDON_SERVICES: readonly SwAddonService[] = Object.freeze([
  { id: 'memcached', kind: 'cache', name: 'Memcached', unit: 'memcached.service', componentId: 'memcached' },
  { id: 'rabbitmq', kind: 'broker', name: 'RabbitMQ', unit: 'rabbitmq-server.service', componentId: 'rabbitmq' },
  { id: 'elasticsearch', kind: 'search', name: 'Elasticsearch', unit: 'elasticsearch.service', componentId: null },
  { id: 'opensearch', kind: 'search', name: 'OpenSearch', unit: 'opensearch.service', componentId: null },
] as const)
export const isSwAddonAction = (value: unknown): value is SwAddonAction => value === 'start' || value === 'stop' || value === 'restart'
export const swAddonService = (id: unknown): SwAddonService | null => SW_ADDON_SERVICES.find(item => item.id === id) ?? null
/** Read uses the already reviewed service-manager show grammar. */
export const swAddonShowArgv = (service: SwAddonService): string[] => serviceManagerShow(service.unit)
export function swAddonActionArgv(action: SwAddonAction, service: SwAddonService): string[] {
  if (!isSwAddonAction(action) || !SW_ADDON_SERVICES.includes(service)) throw new Error('unsupported_addon_action')
  return [SERVICE_MANAGER_SYSTEMCTL, action, '--', service.unit]
}
export function isSwAddonServiceCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.length !== 4 || argv.some(value => typeof value !== 'string')) return false
  return SW_ADDON_SERVICES.some(service => (['start', 'stop', 'restart'] as const).some(action => swAddonActionArgv(action, service).every((value, index) => value === argv[index])))
}

export interface SwAddonServiceRow { id: SwAddonServiceId; unit: string; componentId: string | null; state: 'read' | 'unavailable'; load: string | null; active: string | null; sub: string | null; boot: string | null; revision: string | null }
export interface SwAddonServicesView { scope: 'host-addon-services'; state: 'read' | 'unavailable'; reason: null | 'unsupported-host'; observedAt: string; services: SwAddonServiceRow[]; actions: { control: boolean; configure: false } }

/** Strict public view grammar shared by API and browser; self-contained for serialization. */
export function readSwAddonServicesView(value: unknown): SwAddonServicesView {
  const bad = (): never => { throw new Error('invalid_addon_view') }
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const keys = (item: Record<string, unknown>, list: string[]): boolean => Object.keys(item).sort().join() === [...list].sort().join()
  const fixed: Record<string, [string, string | null]> = { memcached: ['memcached.service', 'memcached'], rabbitmq: ['rabbitmq-server.service', 'rabbitmq'], elasticsearch: ['elasticsearch.service', null], opensearch: ['opensearch.service', null] }
  const token = (item: unknown): boolean => item === null || typeof item === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(item)
  if (!object(value) || !keys(value, ['scope', 'state', 'reason', 'observedAt', 'services', 'actions']) || value.scope !== 'host-addon-services' || !['read', 'unavailable'].includes(value.state) || ![null, 'unsupported-host'].includes(value.reason) || (value.state === 'read') !== (value.reason === null)
    || typeof value.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) || !object(value.actions) || !keys(value.actions, ['control', 'configure']) || typeof value.actions.control !== 'boolean' || value.actions.configure !== false
    || value.actions.control && value.state !== 'read' || !Array.isArray(value.services) || value.services.length !== (value.state === 'read' ? 4 : 0)) return bad()
  const services = value.services.map((raw: unknown, index: number) => {
    const id = Object.keys(fixed)[index]! as SwAddonServiceId
    if (!object(raw) || !keys(raw, ['id', 'unit', 'componentId', 'state', 'load', 'active', 'sub', 'boot', 'revision']) || raw.id !== id || raw.unit !== fixed[id]![0] || raw.componentId !== fixed[id]![1] || !['read', 'unavailable'].includes(raw.state)
      || ![raw.load, raw.active, raw.sub, raw.boot].every(token) || !(raw.revision === null || typeof raw.revision === 'string' && /^[0-9a-f]{64}$/.test(raw.revision)) || (raw.state === 'read') !== (raw.revision !== null && raw.load !== null && raw.active !== null && raw.sub !== null)
      || raw.state === 'unavailable' && [raw.load, raw.active, raw.sub, raw.boot].some(item => item !== null)) return bad()
    return { id, unit: raw.unit, componentId: raw.componentId, state: raw.state, load: raw.load, active: raw.active, sub: raw.sub, boot: raw.boot, revision: raw.revision }
  })
  return { scope: 'host-addon-services', state: value.state, reason: value.reason, observedAt: value.observedAt, services, actions: { control: value.actions.control, configure: false } }
}
