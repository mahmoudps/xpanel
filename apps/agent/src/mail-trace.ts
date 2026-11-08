import { Socket } from 'node:net'
import { Resolver } from 'node:dns/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import { readJsonIfExists } from '@xpanel/state'
import { isMailxAddress } from '../../../packages/os/src/mailx-command.ts'
import { mailTraceDigArgv } from '../../../packages/os/src/mail-trace-command.ts'
import { mailxRoutingModes } from './mailx-policy.ts'
import type { MailxSaved } from './mailx-policy.ts'
import { readMailForwardingConfiguration } from './mailfx-render.ts'
import type { MailxSnapshot } from './mailfx-render.ts'

export type MailTraceRoute = 'local-mailbox' | 'forwarder' | 'mailing-list' | 'domain-forwarder' | 'default-address' | 'not-accepted' | 'remote' | 'relay-host'
export type MailTraceStepName = 'address' | 'local-route' | 'remote-domain-lookup' | 'remote-host-address' | 'remote-host-connect'
export interface MailTraceStep { step: MailTraceStepName; state: 'passed' | 'failed'; reason: string | null }
export interface MailTraceHost { host: string; priority: number; addresses: string[]; connected: boolean | null }
export type MailTraceDnssec = 'validated' | 'not-validated' | 'unknown'
export interface MailTraceResult { address: string; route: MailTraceRoute; deliverable: boolean; failedStep: MailTraceStepName | null; dnssec: MailTraceDnssec; hosts: MailTraceHost[]; relayHost: string | null; destination: string | null; steps: MailTraceStep[]; observedAt: string }

export interface MailTraceDns { mx(domain: string): Promise<{ exchange: string; priority: number }[]>; v4(host: string): Promise<string[]>; v6(host: string): Promise<string[]> }
export interface MailTracePorts {
  dns: MailTraceDns
  /** Reads the server greeting on port 25 and closes; nothing is sent. */
  connect: (address: string) => Promise<boolean>
  run: ((argv: string[]) => Promise<{ ok: boolean; code: number | null; stdout: string }>) | null
  saved: MailxSaved
  snapshot: MailxSnapshot
  stateRoot: string
  now?: () => Date
}

const LOOKUP_TIMEOUT_MS = 3000, CONNECT_TIMEOUT_MS = 4000
const HOSTS_MAX = 5, CONNECTS_MAX = 3
const dnsCode = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? ''
const answered = async (read: Promise<string[]>): Promise<string[]> => read.catch(error => ['ENODATA', 'ENOTFOUND'].includes(dnsCode(error)) ? [] : Promise.reject(error))

export const nodeMailTraceDns = (): MailTraceDns => {
  const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 })
  return { mx: domain => resolver.resolveMx(domain), v4: host => resolver.resolve4(host), v6: host => resolver.resolve6(host) }
}
export const smtpGreeting = (address: string): Promise<boolean> => new Promise(resolve => {
  const socket = new Socket(), done = (value: boolean): void => { socket.destroy(); resolve(value) }
  socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false))
  socket.once('error', () => done(false))
  // RFC 5321 4.2: a 220 reply opens the session; anything else refuses it.
  socket.once('data', chunk => done(String(chunk).startsWith('220')))
  socket.connect(25, address)
})
/** dig(1) +adflag asks the resolver to validate; the ad flag in its reply is that resolver's answer, so a non-validating resolver reads as not validated. */
export const readDnssecFlag = (stdout: string): MailTraceDnssec => {
  const flags = /^;; flags: ([a-z ]*);/m.exec(stdout)?.[1]
  return flags === undefined ? 'unknown' : flags.split(' ').includes('ad') ? 'validated' : 'not-validated'
}

async function localRoute(address: string, domain: string, ports: MailTracePorts): Promise<{ route: MailTraceRoute; destination: string | null } | null> {
  const { snapshot } = ports, hosted = snapshot.domains.some(item => item.name.toLowerCase() === domain)
  if (!hosted || mailxRoutingModes(ports.saved).get(domain) === 'remote') return null
  if (snapshot.serviceUsers.some(user => user.services.email && user.login.toLowerCase() === address)) return { route: 'local-mailbox', destination: null }
  const forwarding = await readMailForwardingConfiguration(ports.stateRoot, snapshot)
  const forwarder = forwarding.forwarders.find(item => item.sourceAddress.toLowerCase() === address)
  if (forwarder) return { route: 'forwarder', destination: forwarder.destinations.slice(0, 5).join(', ') }
  if (forwarding.rejects.some(item => item.sourceAddress.toLowerCase() === address)) return { route: 'not-accepted', destination: null }
  if (forwarding.lists.some(item => item.address.toLowerCase() === address)) return { route: 'mailing-list', destination: null }
  const domainForwarder = forwarding.domainForwarders.find(item => item.sourceDomain === domain)
  if (domainForwarder) return { route: 'domain-forwarder', destination: domainForwarder.targetDomain }
  const defaults = await readJsonIfExists<{ domain: string; kind: string; destination: string | null }[]>(join(ports.stateRoot, 'extended', 'mail', 'default-addresses.json')).catch(() => null)
  const fallback = Array.isArray(defaults) ? defaults.find(item => item.domain === domain) : undefined
  return fallback && fallback.kind !== 'reject' ? { route: 'default-address', destination: fallback.destination } : { route: 'not-accepted', destination: null }
}

/** Follows the route Postfix would take from saved state and live DNS, and names the step that fails. No message is sent. */
export async function traceMailRoute(address: string, ports: MailTracePorts): Promise<MailTraceResult> {
  const observedAt = (ports.now?.() ?? new Date()).toISOString(), steps: MailTraceStep[] = []
  const finish = (fields: Pick<MailTraceResult, 'route' | 'deliverable' | 'failedStep'> & Partial<MailTraceResult>): MailTraceResult =>
    ({ address, dnssec: 'unknown', hosts: [], relayHost: null, destination: null, steps, observedAt, ...fields })
  const stop = (route: MailTraceRoute, step: MailTraceStepName, reason: string, extra: Partial<MailTraceResult> = {}): MailTraceResult => {
    steps.push({ step, state: 'failed', reason })
    return finish({ route, deliverable: false, failedStep: step, ...extra })
  }
  if (!isMailxAddress(address)) return stop('remote', 'address', 'invalid_address')
  steps.push({ step: 'address', state: 'passed', reason: null })
  const domain = address.slice(address.indexOf('@') + 1), local = await localRoute(address, domain, ports)
  if (local?.route === 'not-accepted') return stop('not-accepted', 'local-route', 'unknown_recipient')
  if (local) { steps.push({ step: 'local-route', state: 'passed', reason: null }); return finish({ route: local.route, deliverable: true, failedStep: null, destination: local.destination }) }
  const relay = ports.saved.sections.relay?.policy, relayHost = relay?.enabled && relay.host ? relay.host : null, route: MailTraceRoute = relayHost ? 'relay-host' : 'remote'
  let dnssec: MailTraceDnssec = 'unknown'
  if (ports.run) try { const result = await ports.run(mailTraceDigArgv(domain)); if (result.ok && result.code === 0) dnssec = readDnssecFlag(result.stdout) } catch { /* the check stays unknown */ }
  let records: { exchange: string; priority: number }[]
  try { records = await ports.dns.mx(domain).catch(error => ['ENODATA', 'ENOTFOUND'].includes(dnsCode(error)) ? [] : Promise.reject(error)) } catch { return stop(route, 'remote-domain-lookup', 'lookup_failed', { dnssec, relayHost }) }
  // RFC 7505: a single "0 ." record says the domain accepts no mail.
  if (records.length === 1 && records[0]!.exchange === '') return stop(route, 'remote-domain-lookup', 'null_mx', { dnssec, relayHost })
  // RFC 5321 5.1: without MX records the domain itself is the mail host.
  const list = records.length ? [...records].sort((a, b) => a.priority - b.priority).slice(0, HOSTS_MAX) : [{ exchange: domain, priority: 0 }]
  const hosts: MailTraceHost[] = []
  for (const record of list) {
    const addresses = (await Promise.all([answered(ports.dns.v4(record.exchange)).catch(() => []), answered(ports.dns.v6(record.exchange)).catch(() => [])])).flat().slice(0, 8)
    hosts.push({ host: record.exchange.toLowerCase(), priority: record.priority, addresses, connected: null })
  }
  if (!hosts.some(host => host.addresses.length)) return stop(route, records.length ? 'remote-host-address' : 'remote-domain-lookup', records.length ? 'host_has_no_address' : 'no_mx_or_address', { dnssec, relayHost, hosts })
  steps.push({ step: 'remote-domain-lookup', state: 'passed', reason: null }, { step: 'remote-host-address', state: 'passed', reason: null })
  // A smart host carries the mail, so the destination's own port 25 says nothing about this server.
  if (relayHost) return finish({ route, deliverable: true, failedStep: null, dnssec, relayHost, hosts })
  let tried = 0
  for (const host of hosts) for (const item of host.addresses) {
    if (tried >= CONNECTS_MAX) continue
    tried++
    if (host.connected !== true) host.connected = await ports.connect(item).catch(() => false)
    if (host.connected) { steps.push({ step: 'remote-host-connect', state: 'passed', reason: null }); return finish({ route, deliverable: true, failedStep: null, dnssec, hosts }) }
  }
  return stop(route, 'remote-host-connect', 'no_smtp_greeting', { dnssec, hosts })
}

export interface MailTraceRouteContext extends Omit<MailTracePorts, 'run' | 'saved' | 'snapshot'> {
  assertRoot: (action: string) => Promise<{ actor: string }>
  run: MailTracePorts['run']
  readSaved: () => Promise<MailxSaved>
  readSnapshot: () => Promise<MailxSnapshot>
}
/** POST /host/mail/trace with one address, root only. */
export async function handleMailTraceRoute(req: Request, url: URL, method: string, ctx: MailTraceRouteContext): Promise<Response | null> {
  if (url.pathname !== '/host/mail/trace') return null
  const { actor } = await ctx.assertRoot('mail.trace')
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'mail trace accepts no selectors', { stateChanged: false })
  const text = await req.text()
  let body: unknown
  try { body = text.length > 1024 ? null : JSON.parse(text) } catch { body = null }
  const address = body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 ? (body as Record<string, unknown>).address : undefined
  if (typeof address !== 'string' || address.length > 254) return fail('VALIDATION', 'one destination address is required', { stateChanged: false })
  const result = await traceMailRoute(address.toLowerCase(), { ...ctx, saved: await ctx.readSaved(), snapshot: await ctx.readSnapshot() })
  if ((await ctx.assertRoot('mail.trace')).actor !== actor) return fail('FORBIDDEN', 'mail trace authority changed', { stateChanged: false })
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
