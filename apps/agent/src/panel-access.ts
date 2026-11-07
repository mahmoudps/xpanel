import { X509Certificate } from 'node:crypto'
import { createServer } from 'node:net'
import { fail } from '@xpanel/core'
import type { AgentExecutor } from './executor.ts'
import { PANEL_BINDING_DEFAULT, parsePanelBinding } from './panel-gate-policy.ts'
import type { PanelBinding } from './panel-gate-policy.ts'

/**
 * The root side of Panel access. scripts/management-tls.mjs owns the ingress, api.env and the certificate; this module
 * only writes what it should do next and starts it, so one transaction with one rollback touches them.
 */
export const MANAGEMENT_ACCESS_PATH = '/etc/xpanel/management-access.json'
export const MANAGEMENT_ACCESS_NEXT_PATH = '/etc/xpanel/management-access.next.json'
const MANAGEMENT_CONFIG_PATH = '/etc/xpanel/management-tls.json'
const API_ENV_PATH = '/etc/xpanel/api.env'
const STATUS_PATH = '/var/lib/xpanel-management-tls/status.json'
const TRIAL_MS = 10 * 60_000
const LISTENERS = ['xpanel', 'xwhm', 'xmail'] as const
const ORIGIN_KEYS = { xpanel: 'XPANEL_PANEL_PUBLIC_ORIGIN', xwhm: 'XPANEL_WHM_PUBLIC_ORIGIN', xmail: 'XPANEL_MAIL_PUBLIC_ORIGIN' } as const

export const START_REBIND = ['/usr/bin/systemctl', 'start', '--no-block', 'xpanel-management-tls.service'] as const
export const RELOAD_INGRESS = ['/usr/bin/systemctl', 'reload', 'nginx.service'] as const
// The API answers this very request, so its restart waits a moment in a unit of its own.
export const RESTART_API = ['/usr/bin/systemd-run', '--on-active=2', '--collect', '--unit=xpanel-panel-restart', '/usr/bin/systemctl', 'restart', 'xpanel-api.service'] as const
const same = (argv: readonly string[], fixed: readonly string[]): boolean => argv.length === fixed.length && fixed.every((value, index) => value === argv[index])
export const isPanelAccessCommand = (argv: readonly string[]): boolean => [START_REBIND, RELOAD_INGRESS, RESTART_API].some(fixed => same(argv, fixed))

export interface ManagementAccess extends PanelBinding {
  schemaVersion: 1
  /** Ports that stay open beside the applied ones: the old ports through a trial, the new ones before a switch. */
  open: number[]
  /** Until `deadline` the owner confirms from the new address; otherwise the previous binding returns. */
  trial: { deadline: string; previous: PanelBinding } | null
}
const unchanged = { stateChanged: false }
type Host = Pick<AgentExecutor, 'readFile' | 'writeFile' | 'removePath' | 'runCommand'>
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function parseManagementAccess(text: string | null): ManagementAccess {
  if (text === null) return { schemaVersion: 1, ...structuredClone(PANEL_BINDING_DEFAULT), open: [], trial: null }
  const value: unknown = JSON.parse(text)
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.open) || value.open.some(port => !Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535)) return fail('PRECONDITION_FAILED', 'the management access file requires review', unchanged)
  const trial = value.trial
  if (!(trial === null || object(trial) && typeof trial.deadline === 'string' && Number.isFinite(Date.parse(trial.deadline)))) return fail('PRECONDITION_FAILED', 'the management access file requires review', unchanged)
  return { schemaVersion: 1, ...parsePanelBinding({ ports: value.ports, hosts: value.hosts }), open: value.open as number[], trial: trial === null ? null : { deadline: trial.deadline as string, previous: parsePanelBinding(trial.previous) } }
}
const readAccess = async (host: Pick<Host, 'readFile'>): Promise<ManagementAccess> => parseManagementAccess(await host.readFile(MANAGEMENT_ACCESS_PATH))
const writeAccess = (host: Pick<Host, 'writeFile'>, path: string, access: ManagementAccess): Promise<void> => host.writeFile({ path, content: `${JSON.stringify(access, null, 2)}\n`, mode: 0o600, owner: 'root', group: 'root' })

/** Every port the firewall must accept for the panel right now. */
export const managementFirewallPorts = async (host: Pick<Host, 'readFile'>): Promise<number[]> => {
  const access = await readAccess(host)
  return [...new Set([...Object.values(access.ports), ...access.open])]
}
export const managementWhmPort = async (host: Pick<Host, 'readFile'>): Promise<number> => (await readAccess(host)).ports.xwhm

/** A real exclusive bind: the kernel, not a parsed listing, decides whether the port is free. */
export const portIsFree = (port: number): Promise<boolean> => new Promise(resolve => {
  const server = createServer()
  server.once('error', () => resolve(false))
  server.listen({ port, exclusive: true }, () => server.close(() => resolve(true)))
})

function originsOf(env: string | null): Record<string, string | null> {
  const rows = new Map((env ?? '').split('\n').flatMap(line => { const at = line.indexOf('='); return at > 0 ? [[line.slice(0, at), line.slice(at + 1)] as const] : [] }))
  return Object.fromEntries(LISTENERS.map(name => [name, rows.get(ORIGIN_KEYS[name]) || null]))
}

function certificateFacts(pem: string | null): Record<string, unknown> | null {
  if (!pem) return null
  try {
    const leaf = new X509Certificate(pem)
    return { subject: leaf.subject, issuer: leaf.issuer, names: leaf.subjectAltName?.split(', ').map(name => name.replace(/^DNS:/, '')) ?? [], validFrom: new Date(leaf.validFrom).toISOString(), validTo: new Date(leaf.validTo).toISOString(), fingerprint: leaf.fingerprint256, pem: leaf.toString() }
  } catch { return null }
}

const STATUS_FIELDS = ['phase', 'status', 'reason', 'rollback', 'fingerprint', 'expiresAt'] as const
async function observe(host: Host): Promise<Record<string, unknown>> {
  const [config, env, statusText, access, pending] = await Promise.all([host.readFile(MANAGEMENT_CONFIG_PATH), host.readFile(API_ENV_PATH), host.readFile(STATUS_PATH), readAccess(host), host.readFile(MANAGEMENT_ACCESS_NEXT_PATH)])
  let status: Record<string, unknown> | null = null
  try { const parsed: unknown = statusText ? JSON.parse(statusText) : null; status = object(parsed) ? Object.fromEntries(STATUS_FIELDS.map(key => [key, parsed[key] ?? null])) : null } catch { status = null }
  const fingerprint = typeof status?.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(status.fingerprint) ? status.fingerprint : null
  const pem = fingerprint ? await host.readFile(`/etc/xpanel/management-certificates/${fingerprint}/fullchain.pem`).catch(() => null) : null
  return { available: config !== null, origins: originsOf(env), binding: { ports: access.ports, hosts: access.hosts }, open: access.open, trial: access.trial, applying: pending !== null, lifecycle: status, certificate: certificateFacts(pem) }
}

export const bindingOrigins = (binding: PanelBinding, hostname: string): Record<string, string> => ({
  xpanel: `https://${binding.hosts.xpanel ?? hostname}:${binding.ports.xpanel}`, xwhm: `https://${binding.hosts.xwhm ?? `whm.${hostname}`}:${binding.ports.xwhm}`, xmail: `https://${binding.hosts.xmail ?? `mail.${hostname}`}:${binding.ports.xmail}` })

export interface PanelAccessRouteContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** Native Linux host only; null keeps every route refused instead of simulating a move. */
  executor: Host | null
  probePort?: (port: number) => Promise<boolean>
  now?: () => Date
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

async function bodyBinding(req: Request): Promise<PanelBinding> {
  const body: unknown = await req.json().catch(() => null)
  return object(body) ? parsePanelBinding(body.binding) : fail('VALIDATION', 'a binding is required', unchanged)
}
const ready = async (host: Host): Promise<{ access: ManagementAccess; hostname: string }> => {
  const config = await host.readFile(MANAGEMENT_CONFIG_PATH)
  if (config === null) return fail('PRECONDITION_FAILED', 'management TLS is not prepared on this server', { ...unchanged, reason: 'management_tls_not_prepared' })
  if (await host.readFile(MANAGEMENT_ACCESS_NEXT_PATH) !== null) return fail('CONFLICT', 'a panel address change is already running', { ...unchanged, reason: 'panel_binding_applying' })
  const hostname: unknown = (JSON.parse(config) as Record<string, unknown>).hostname
  return { access: await readAccess(host), hostname: typeof hostname === 'string' ? hostname : '' }
}
const startRebind = async (host: Host, next: ManagementAccess): Promise<void> => {
  await writeAccess(host, MANAGEMENT_ACCESS_NEXT_PATH, next)
  const started = await host.runCommand([...START_REBIND])
  if (!started.ok) { await host.removePath(MANAGEMENT_ACCESS_NEXT_PATH); fail('SERVICE_UNAVAILABLE', 'the panel address change could not start', unchanged) }
}
const revertTo = (access: ManagementAccess): ManagementAccess => ({ schemaVersion: 1, ...(access.trial as NonNullable<ManagementAccess['trial']>).previous, open: [], trial: null })

const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; action: string }>> = {
  '/host/panel-access': { method: 'GET', action: 'panel_access.read' },
  '/host/panel-access/check': { method: 'POST', action: 'panel_access.check' },
  '/host/panel-access/open': { method: 'POST', action: 'panel_access.open' },
  '/host/panel-access/close': { method: 'POST', action: 'panel_access.close' },
  '/host/panel-access/apply': { method: 'POST', action: 'panel_access.apply' },
  '/host/panel-access/confirm': { method: 'POST', action: 'panel_access.confirm' },
  '/host/panel-access/revert': { method: 'POST', action: 'panel_access.revert' },
  '/host/panel-access/service': { method: 'POST', action: 'panel_access.service' },
}

export async function handlePanelAccessHostRoute(req: Request, url: URL, method: string, ctx: PanelAccessRouteContext): Promise<Response | null> {
  const route = ROUTES[url.pathname]
  if (!route) return null
  await ctx.assertRoot(route.action)
  if (method !== route.method) return new Response(null, { status: 405, headers: { allow: route.method } })
  const host = ctx.executor
  if (!host) return fail('PRECONDITION_FAILED', 'panel access needs the native Linux host executor', { ...unchanged, reason: 'native_host_required' })
  if (route.action === 'panel_access.read') return json(await observe(host))
  if (route.action === 'panel_access.service') {
    const body: unknown = await req.json().catch(() => null), action = object(body) ? body.action : null
    if (action !== 'reload' && action !== 'restart') return fail('VALIDATION', 'the action must be reload or restart', unchanged)
    const result = await host.runCommand([...(action === 'reload' ? RELOAD_INGRESS : RESTART_API)])
    return result.ok ? json({ outcome: action === 'reload' ? 'reloaded' : 'restart_scheduled' }) : fail('SERVICE_UNAVAILABLE', 'the service request failed', unchanged)
  }
  if (route.action === 'panel_access.close') {
    const access = await readAccess(host)
    await writeAccess(host, MANAGEMENT_ACCESS_PATH, { ...access, open: access.trial ? access.open : [] })
    return json({ outcome: 'closed' })
  }
  if (route.action === 'panel_access.confirm' || route.action === 'panel_access.revert') {
    const access = await readAccess(host)
    if (!access.trial) return fail('CONFLICT', 'no panel address change is waiting', { ...unchanged, reason: 'no_trial' })
    if (route.action === 'panel_access.revert') { await startRebind(host, revertTo(access)); return json({ outcome: 'reverting' }) }
    await writeAccess(host, MANAGEMENT_ACCESS_PATH, { ...access, open: [], trial: null })
    return json({ outcome: 'confirmed' })
  }
  const binding = await bodyBinding(req), { access, hostname } = await ready(host)
  if (access.trial) return fail('CONFLICT', 'confirm or revert the waiting change first', { ...unchanged, reason: 'trial_active' })
  if (route.action === 'panel_access.check') {
    const ours = new Set(Object.values(access.ports)), probe = ctx.probePort ?? portIsFree
    for (const port of Object.values(binding.ports)) if (!ours.has(port) && !await probe(port)) return fail('CONFLICT', `port ${port} is in use on this server`, { ...unchanged, reason: 'PORT_IN_USE', port })
    return json({ outcome: 'free', origins: bindingOrigins(binding, hostname) })
  }
  if (route.action === 'panel_access.open') {
    await writeAccess(host, MANAGEMENT_ACCESS_PATH, { ...access, open: Object.values(binding.ports).filter(port => !Object.values(access.ports).includes(port)) })
    return json({ outcome: 'opened' })
  }
  const deadline = new Date((ctx.now?.() ?? new Date()).getTime() + TRIAL_MS).toISOString()
  await startRebind(host, { schemaVersion: 1, ...binding, open: Object.values(access.ports), trial: { deadline, previous: { ports: access.ports, hosts: access.hosts } } })
  return json({ outcome: 'applying', deadline, origins: bindingOrigins(binding, hostname) })
}

/**
 * Runs on the agent's minute tick. A missed deadline, such as a reboot during the trial, reverts at the next tick:
 * an address nobody confirmed never becomes permanent.
 */
export async function revertExpiredPanelTrial(host: Host, now: number = Date.now()): Promise<void> {
  const access = await readAccess(host)
  if (access.trial && Date.parse(access.trial.deadline) <= now && await host.readFile(MANAGEMENT_ACCESS_NEXT_PATH) === null) await startRebind(host, revertTo(access))
}
