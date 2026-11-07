import type { Account, Certificate, DnsRecord, Domain, HostAction, OsProfile, RenderedFile } from '@xpanel/core'
import { system } from '@xpanel/render'
import { parseEnvAssignments } from './agent-origin.ts'
import type { AgentExecutor } from './executor.ts'
import { ownerName } from './services/opendkim-live.ts'

/**
 * Web Disk and calendars and contacts of one account (docs/decisions/2026-11-07-dav-servers.md). The saved
 * logins become units in the account slice and an nginx file on 2078/2080. Radicale runs for every active
 * account, because xMail keeps its calendars and contacts in that store; the edge needs a covering certificate,
 * the management ingress and the plan's feature, and the generation diff stops whatever an earlier one started.
 */

/** The panel listener's public host:port, which the API requires on the edge's verification request. */
export interface DavIngress { panelHost: string }

const API_ENV_PATH = '/etc/xpanel/api.env'

/** Present only once management TLS wrote the panel origin; the ingress credential nginx includes exists from then on. */
export const readDavIngress = async (executor: Pick<AgentExecutor, 'readFile'>): Promise<DavIngress | null> => {
  const api = await executor.readFile(API_ENV_PATH)
  const origin = api === null ? undefined : parseEnvAssignments(api).get('XPANEL_PANEL_PUBLIC_ORIGIN')
  if (!origin) return null
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' && url.origin === origin ? { panelHost: url.host } : null
  } catch {
    return null
  }
}

export const WEBDISK_FEATURE_KEYS: readonly string[] = ['web-disk']
export const CALDAV_FEATURE_KEYS: readonly string[] = ['calendars-contacts-config', 'Calendars and Contacts']

interface DavUser { id: string; services: { email: boolean; webdisk: boolean }; ftpDir: string; webdiskReadOnly?: boolean }

/** The main account login (whole home, read-write) and every User Manager user with Web Disk, as cPanel lists them. */
export const webDiskLogins = (users: readonly DavUser[]): system.WebDiskLogin[] => [
  { subject: 'main', dir: '', readOnly: false },
  ...users.filter(u => u.services.webdisk).map(u => ({ subject: u.id, dir: u.ftpDir, readOnly: u.webdiskReadOnly === true })),
]

export interface CompiledAccountDav {
  files: RenderedFile[]
  preActions: HostAction[]
  postActions: HostAction[]
  units: string[]
  /** the names this generation serves on the calendar port; website redirects and SRV records advertise only these */
  calDavNames: string[]
}

export interface AccountDavInput {
  account: Account
  domains: readonly Domain[]
  users: readonly DavUser[]
  certs: readonly Certificate[]
  os: OsProfile
  ingress: DavIngress | null
  /** saved Web Disk TLS settings; absent keeps the defaults */
  tls?: system.DavTlsSettings
  /** the account plan's disabled feature keys and tool ids */
  disabled: readonly string[]
}

/** The principals with a store: the account login and every mailbox. */
export const davPrincipals = (users: readonly DavUser[]): string[] => [system.CALDAV_MAIN_PRINCIPAL, ...users.filter(u => u.services.email).map(u => u.id)]

export const compileAccountDav = (input: AccountDavInput): CompiledAccountDav => {
  const out: CompiledAccountDav = { files: [], preActions: [], postActions: [], units: [], calDavNames: [] }
  const { account, os } = input
  if (account.status === 'terminating') return out
  out.preActions.push(
    { kind: 'ensure-dir', path: system.RUNTIME_CONFIG_ROOT, mode: 0o711, owner: 'root', group: 'root' },
    { kind: 'ensure-dir', path: system.runtimeConfigDir(account.username), mode: 0o700, owner: 'root', group: 'root' },
  )
  out.files.push(system.renderDavLauncher())
  // Every removal path ends here: mailbox delete, domain removal and turning the mailbox service off all drop the principal.
  out.postActions.push(system.calDavPruneAction(account, davPrincipals(input.users)))
  if (account.status !== 'active') return out
  const start = (sockets: readonly string[]): void => { for (const unit of sockets) out.postActions.push({ kind: 'systemd', verb: 'enable', unit }, { kind: 'systemd', verb: 'start', unit }) }
  const store = system.renderCalDavUnits(account, os)
  out.files.push(...store.files)
  out.units.push(...store.units)
  start(store.sockets)
  const webDisk = !WEBDISK_FEATURE_KEYS.some(key => input.disabled.includes(key))
  const calDav = !CALDAV_FEATURE_KEYS.some(key => input.disabled.includes(key))
  const groups = system.davNamesByCertificate(account, input.domains, input.certs)
  if (!input.ingress || (!webDisk && !calDav) || groups.length === 0) return out
  if (webDisk) {
    const logins = webDiskLogins(input.users), dirs = [...new Set(logins.map(login => login.dir).filter(Boolean))]
    for (const login of logins) {
      const r = system.renderWebDiskUnits(account, login, os)
      out.files.push(...r.files)
      out.units.push(...r.units)
      start(r.sockets)
    }
    if (dirs.length) out.postActions.push(system.webDiskDirsAction(account, dirs))
  }
  if (calDav) out.calDavNames = groups.flatMap(group => group.names).sort()
  out.files.push(
    system.renderDavNginx(account, groups, os, { panelHost: input.ingress.panelHost, webDisk, calDav, ...(input.tls ? { tls: input.tls } : {}) }),
    system.renderDavNginxDefault(os, true, input.tls),
  )
  return out
}

/**
 * RFC 6764 SRV and path records of the names served on the calendar port, rendered with the zone and never saved in
 * it, so they follow the certificate, the plan and the account state. A service the zone already publishes stays as it is.
 */
export const davZoneAdditions = (zoneName: string, records: readonly { name: string; type: string }[], served: readonly string[]): DnsRecord[] => {
  const zone = zoneName.toLowerCase().replace(/\.$/, '')
  const owners = new Set(records.filter(record => record.type === 'SRV').map(record => ownerName(record.name, zone)))
  return served.filter(name => name === zone || name.endsWith(`.${zone}`)).flatMap(name => (['_caldavs._tcp', '_carddavs._tcp'] as const).flatMap(service => {
    const owner = name === zone ? service : `${service}.${name.slice(0, -(zone.length + 1))}`
    return owners.has(owner) ? [] : [
      { id: `xpanel-dav-srv-${owner}.${zone}`, zone, name: owner, type: 'SRV' as const, ttl: 3600, content: `0 ${system.CALDAV_PORT} ${name}.`, priority: 0 },
      { id: `xpanel-dav-path-${owner}.${zone}`, zone, name: owner, type: 'TXT' as const, ttl: 3600, content: 'path=/', priority: null },
    ]
  }))
}

/** Units a terminating account may still have, from its saved logins. */
export const davUnitNames = (account: Pick<Account, 'username' | 'home'>, users: readonly DavUser[]): string[] => {
  const calDav = system.calDavPaths(account)
  return [
    ...webDiskLogins(users).flatMap(login => {
      const p = system.webDiskPaths(account.username, system.webDiskInstance(login))
      return [p.frontSocketUnit, p.proxyService, p.backendSocketUnit, p.service]
    }),
    calDav.socketUnit,
    calDav.service,
  ]
}
