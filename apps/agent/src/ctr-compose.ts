import { fail, isXpanelError } from '@xpanel/core'
import { parseYaml } from '@xpanel/lifecycle'
import { system } from '@xpanel/render'

/**
 * Compose subset compiled to one rootless unit per service. Every key is either honoured or refused by name,
 * so nothing is silently dropped; privileged, host network, devices and capabilities have no accepted key.
 * All services of a stack share the first service's network namespace, the way a pod does, which needs no
 * bridge network or DNS plugin and works on every Podman the supported systems ship.
 */
export const STACK_LIMITS = { stacks: 16, services: 16, yaml: 64 * 1024, env: 16 * 1024, notes: 512, ports: 16, mounts: 16, command: 32 } as const
export const STACK_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
export type StackRestart = system.ContainerRestart
export interface StackService { name: string; image: string; env: Record<string, string>; command: string[]; ports: system.ContainerPublish[]; mounts: { kind: 'bind' | 'volume'; source: string; target: string; readOnly: boolean }[]; restart: StackRestart; dependsOn: string[]; memoryMb: number | null; cpuPercent: number | null }
export interface StackRecord {
  name: string; yaml: string; env: string; notes: string; app: string | null; enabled: boolean; updatedAt: string
  /** Operator choices over the parsed file, kept beside it so an edit of the YAML does not lose them. */
  restart: Record<string, StackRestart>; networks: string[]; limits: { memoryMb: number | null; cpuPercent: number | null }
}
const unchanged = { stateChanged: false }
const refuse = (message: string, field?: string): never => fail('VALIDATION', message, { ...unchanged, reason: 'invalid_compose', ...(field ? { field } : {}) })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const SERVICE_KEYS = new Set(['image', 'command', 'environment', 'ports', 'volumes', 'restart', 'depends_on', 'mem_limit', 'cpus'])

export function parseStackEnv(text: string): Record<string, string> {
  if (typeof text !== 'string' || text.length > STACK_LIMITS.env || CONTROL.test(text)) return refuse('env content is too large or holds control characters', 'env')
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim()
    if (!line || line.startsWith('#')) continue
    const at = line.indexOf('='), key = line.slice(0, at), value = line.slice(at + 1)
    if (at < 1 || !ENV_KEY.test(key)) return refuse('each env line must be NAME=value', 'env')
    out[key] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value
  }
  return out
}
const interpolate = (value: string, vars: Readonly<Record<string, string>>): string => value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]{0,63})(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]{0,63})/g, (match, braced, fallback, bare) => {
  if (match === '$$') return '$'
  const name = (braced ?? bare) as string, found = vars[name]
  return found !== undefined && found !== '' ? found : fallback !== undefined ? fallback as string : refuse(`variable ${name} has no value`, 'env')
})
const resolve = (value: unknown, vars: Readonly<Record<string, string>>): unknown => typeof value === 'string' ? interpolate(value, vars)
  : Array.isArray(value) ? value.map(item => resolve(item, vars))
    : object(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, vars)])) : value

const qualify = (image: string): string => {
  const first = image.split('/')[0]!
  return first.includes('.') ? image : 'docker.io/' + (image.includes('/') ? image : 'library/' + image)
}
const port = (value: string, min: number, what: string): number => /^[0-9]{1,5}$/.test(value) && Number(value) >= min && Number(value) <= 65535 ? Number(value) : refuse(`${what} ${value} must be a number from ${min} to 65535`, 'ports')
function parsePort(raw: unknown): system.ContainerPublish {
  if (typeof raw !== 'string' && typeof raw !== 'number') return refuse('ports must use the short form [address:]host:container[/protocol]', 'ports')
  const [spec = '', protocol = 'tcp', ...more] = String(raw).split('/')
  const parts = spec.split(':')
  if (more.length || parts.length < 2 || parts.length > 3 || !['tcp', 'udp'].includes(protocol)) return refuse('ports must use the short form [address:]host:container[/protocol]', 'ports')
  const bind = parts.length === 3 ? parts[0]! : '127.0.0.1'
  if (bind !== '127.0.0.1' && bind !== '0.0.0.0') return refuse('a port binds to 127.0.0.1 or 0.0.0.0', 'ports')
  // Rootless Podman cannot bind a privileged port.
  return { bind, host: port(parts.at(-2)!, 1024, 'host port'), container: port(parts.at(-1)!, 1, 'container port'), protocol: protocol as 'tcp' | 'udp' }
}
function parseMount(raw: unknown, declared: ReadonlySet<string>, stack: string): StackService['mounts'][number] {
  const [source = '', target = '', mode, ...more] = typeof raw === 'string' ? raw.split(':') : []
  if (more.length || !/^\/[A-Za-z0-9._/-]{1,240}$/.test(target) || target.split('/').includes('..') || mode !== undefined && mode !== 'ro' && mode !== 'rw') return refuse('volumes must use the short form source:target[:ro]', 'volumes')
  const readOnly = mode === 'ro'
  if (source.startsWith('./')) {
    const rel = source.slice(2).replace(/\/+$/, '')
    if (!rel || rel.split('/').some(part => !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(part))) return refuse('a bind mount must stay inside the stack folder', 'volumes')
    return { kind: 'bind', source: rel, target, readOnly }
  }
  if (!declared.has(source)) return refuse('a mount source is ./folder or a volume declared at the top level; host paths are refused', 'volumes')
  return { kind: 'volume', source: stack + '_' + source, target, readOnly }
}
const memoryOf = (raw: unknown): number | null => {
  if (raw === undefined) return null
  const m = /^([0-9]{1,7})\s?([mg])b?$/i.exec(String(raw))
  return m && Number(m[1]) * (m[2]!.toLowerCase() === 'g' ? 1024 : 1) >= 16 ? Number(m[1]) * (m[2]!.toLowerCase() === 'g' ? 1024 : 1) : refuse('mem_limit must look like 512m or 1g', 'mem_limit')
}
const cpusOf = (raw: unknown): number | null => {
  if (raw === undefined) return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0.01 && value <= 1024 ? Math.round(value * 100) : refuse('cpus must be a number such as 0.5', 'cpus')
}
const commandOf = (raw: unknown): string[] => {
  if (raw === undefined || raw === null) return []
  const list = typeof raw === 'string' ? raw.trim().split(/\s+/) : Array.isArray(raw) && raw.every(item => typeof item === 'string') ? raw as string[] : refuse('command must be a string or a list of strings', 'command')
  return list.length <= STACK_LIMITS.command && list.every(item => item.length <= 512 && !CONTROL.test(item)) ? list : refuse('command is too long', 'command')
}
const environmentOf = (raw: unknown): Record<string, string> => {
  const pairs: [string, unknown][] = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw.map(item => { const text = String(item), at = text.indexOf('='); return at < 1 ? refuse('environment entries must be NAME=value', 'environment') : [text.slice(0, at), text.slice(at + 1)] as [string, unknown] }) : object(raw) ? Object.entries(raw) : refuse('environment must be a map or a list', 'environment')
  if (pairs.length > 32) return refuse('a service has at most 32 environment entries', 'environment')
  return Object.fromEntries(pairs.map(([key, value]) => {
    const text = value === null ? '' : String(value)
    return ENV_KEY.test(key) && text.length <= 1024 && !CONTROL.test(text) ? [key, text] : refuse(`environment entry ${key} is invalid`, 'environment')
  }))
}
const restartOf = (raw: unknown): StackRestart => raw === undefined || raw === 'on-failure' ? 'on-failure' : raw === 'always' || raw === 'unless-stopped' ? 'always' : raw === 'no' || raw === false ? 'no' : refuse('restart must be no, on-failure, always or unless-stopped', 'restart')

/** A template is a draft: its values are filled at deployment, when the full check runs. */
export function assertComposeSyntax(yaml: string): void {
  let document: unknown
  try { document = typeof yaml === 'string' && Buffer.byteLength(yaml) <= STACK_LIMITS.yaml ? parseYaml(yaml, { maxAliasCount: 16 }) : null } catch { document = null }
  if (!object(document) || !object(document.services)) refuse('the compose file is not valid YAML', 'yaml')
}

/** Parses and validates one stack; the services come back with dependencies first. */
export function parseComposeServices(stack: string, yaml: string, envText: string): StackService[] {
  if (typeof stack !== 'string' || !STACK_NAME.test(stack)) return refuse('stack name must be 1-32 chars of a-z, 0-9 and inner dashes', 'name')
  if (typeof yaml !== 'string' || Buffer.byteLength(yaml) > STACK_LIMITS.yaml) return refuse('the compose file is too large', 'yaml')
  const vars = parseStackEnv(envText)
  let document: unknown
  try { document = parseYaml(yaml, { maxAliasCount: 16 }) } catch { return refuse('the compose file is not valid YAML', 'yaml') }
  if (!object(document) || !object(document.services)) return refuse('the compose file needs a services map', 'services')
  for (const key of Object.keys(document)) if (!['version', 'name', 'services', 'volumes'].includes(key)) return refuse(`top-level key ${key} is not supported`, key)
  const resolved = resolve(document, vars) as { services: Record<string, unknown>; volumes?: unknown }
  const declared = new Set(resolved.volumes === undefined || resolved.volumes === null ? [] : object(resolved.volumes) ? Object.keys(resolved.volumes) : refuse('volumes must be a map', 'volumes'))
  for (const name of declared) if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(name)) return refuse(`volume name ${name} is invalid`, 'volumes')
  const entries = Object.entries(resolved.services)
  if (entries.length < 1 || entries.length > STACK_LIMITS.services) return refuse(`a stack has 1 to ${STACK_LIMITS.services} services`, 'services')
  const services = entries.map(([name, raw]): StackService => {
    if (!STACK_NAME.test(name) || stack.length + name.length + 1 > 32) return refuse(`service name ${name} must fit 32 chars together with the stack name`, 'services')
    if (!object(raw)) return refuse(`service ${name} must be a map`, 'services')
    for (const key of Object.keys(raw)) if (!SERVICE_KEYS.has(key)) return refuse(`service key ${key} is not supported`, key)
    const image = typeof raw.image === 'string' ? qualify(raw.image) : refuse(`service ${name} needs an image`, 'image')
    if (system.containerImageHost(image) === null) return refuse(`image of ${name} must name a tag or a digest`, 'image')
    const ports = raw.ports === undefined ? [] : Array.isArray(raw.ports) && raw.ports.length <= STACK_LIMITS.ports ? raw.ports.map(parsePort) : refuse('ports must be a short list', 'ports')
    const mounts = raw.volumes === undefined ? [] : Array.isArray(raw.volumes) && raw.volumes.length <= STACK_LIMITS.mounts ? raw.volumes.map(item => parseMount(item, declared, stack)) : refuse('volumes must be a short list', 'volumes')
    const dependsOn = raw.depends_on === undefined ? [] : Array.isArray(raw.depends_on) ? raw.depends_on.map(String) : object(raw.depends_on) ? Object.keys(raw.depends_on) : refuse('depends_on must be a list or a map', 'depends_on')
    return { name, image, env: environmentOf(raw.environment), command: commandOf(raw.command), ports, mounts, restart: restartOf(raw.restart), dependsOn, memoryMb: memoryOf(raw.mem_limit), cpuPercent: cpusOf(raw.cpus) }
  })
  const seen = new Set<string>()
  for (const p of services.flatMap(service => service.ports)) {
    // One shared network namespace: a port number is unique across the whole stack.
    const host = 'h' + p.host + '/' + p.protocol, inner = 'c' + p.container + '/' + p.protocol
    if (seen.has(host) || seen.has(inner)) return refuse(`port ${p.host} or ${p.container} is listed twice`, 'ports')
    seen.add(host); seen.add(inner)
  }
  const ordered: StackService[] = [], visiting = new Set<string>(), byName = new Map(services.map(service => [service.name, service]))
  const visit = (service: StackService): void => {
    if (ordered.includes(service)) return
    if (visiting.has(service.name)) refuse('depends_on has a cycle', 'depends_on')
    visiting.add(service.name)
    for (const dep of service.dependsOn) visit(byName.get(dep) ?? refuse(`depends_on names unknown service ${dep}`, 'depends_on'))
    ordered.push(service)
  }
  services.forEach(visit)
  return ordered
}

export const stackFolder = (home: string, stack: string): string => `${home}/containers/${stack}`
export const stackServiceName = (stack: string, service: string): string => `${stack}-${service}`
export const stackUnits = (username: string, stack: Pick<StackRecord, 'name' | 'yaml' | 'env'>): string[] => parseComposeServices(stack.name, stack.yaml, stack.env).map(service => system.containerUnitName(username, stackServiceName(stack.name, service.name)))
export const stackPorts = (stack: Pick<StackRecord, 'name' | 'yaml' | 'env'>): system.ContainerPublish[] => parseComposeServices(stack.name, stack.yaml, stack.env).flatMap(service => service.ports)

/** Render input of each service, dependencies first; the first one owns the shared network namespace. */
export function stackUnitSpecs(stack: StackRecord, home: string): (system.ContainerSpec & { limits: StackRecord['limits'] })[] {
  const services = parseComposeServices(stack.name, stack.yaml, stack.env), primary = services[0]!, folder = stackFolder(home, stack.name)
  const lower = (a: number | null, b: number | null): number | null => a === null ? b : b === null ? a : Math.min(a, b)
  return services.map(service => ({
    name: stackServiceName(stack.name, service.name), image: service.image, env: service.env, command: service.command, restart: stack.restart[service.name] ?? service.restart,
    trustedRegistry: system.containerImageHost(service.image)!,
    mounts: service.mounts.map(m => ({ source: m.kind === 'bind' ? folder + '/' + m.source : m.source, target: m.target, readOnly: m.readOnly })),
    dataDirs: service.mounts.filter(m => m.kind === 'bind').map(m => folder + '/' + m.source),
    ...(service === primary ? { publish: services.flatMap(s => s.ports), networks: stack.networks, ...(services.length > 1 ? { hosts: services.map(s => s.name) } : {}) } : { shareNetworkOf: stackServiceName(stack.name, primary.name) }),
    limits: { memoryMb: lower(service.memoryMb, stack.limits.memoryMb), cpuPercent: lower(service.cpuPercent, stack.limits.cpuPercent) },
  }))
}

/** Strict read of a saved stack; a file that no longer parses stops the reconcile instead of half applying. */
export function parseStackRecord(raw: unknown, invalid: () => never): StackRecord {
  const v = raw as StackRecord
  const keys = ['name', 'yaml', 'env', 'notes', 'app', 'enabled', 'updatedAt', 'restart', 'networks', 'limits']
  if (!object(raw) || Object.keys(raw).sort().join() !== [...keys].sort().join() || typeof v.notes !== 'string' || v.notes.length > STACK_LIMITS.notes || !(v.app === null || typeof v.app === 'string' && STACK_NAME.test(v.app)) || typeof v.enabled !== 'boolean'
    || typeof v.updatedAt !== 'string' || !Number.isFinite(Date.parse(v.updatedAt)) || !object(v.restart) || !Object.values(v.restart).every(item => item === 'no' || item === 'on-failure' || item === 'always')
    || !Array.isArray(v.networks) || v.networks.length > 4 || !v.networks.every(item => typeof item === 'string' && STACK_NAME.test(item))
    || !object(v.limits) || ![v.limits.memoryMb, v.limits.cpuPercent].every(item => item === null || Number.isSafeInteger(item) && item > 0)) return invalid()
  try { parseComposeServices(v.name, v.yaml, v.env) } catch (error) { if (isXpanelError(error)) return invalid(); throw error }
  return { name: v.name, yaml: v.yaml, env: v.env, notes: v.notes, app: v.app, enabled: v.enabled, updatedAt: v.updatedAt, restart: { ...v.restart }, networks: [...v.networks], limits: { memoryMb: v.limits.memoryMb, cpuPercent: v.limits.cpuPercent } }
}

/** Loopback ports of active accounts; the firewall lets only the owner among hosting accounts connect. */
export const containerLoopbackPorts = (accounts: readonly { id: string; uid: number; status: string }[], runtime: ReadonlyMap<string, { stacks?: StackRecord[] }> | undefined): { port: number; protocol: 'tcp' | 'udp'; uid: number }[] =>
  accounts.filter(account => account.status === 'active').flatMap(account => (runtime?.get(account.id)?.stacks ?? []).filter(stack => stack.enabled).flatMap(stack => stackPorts(stack).filter(p => p.bind === '127.0.0.1').map(p => ({ port: p.host, protocol: p.protocol, uid: account.uid }))))
