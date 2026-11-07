import { fail } from '@xpanel/core'
import type { Account, Certificate, Domain, ServiceUser } from '@xpanel/core'
import { system } from '@xpanel/render'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountOwnerPorts } from './account-ssh-workspace.ts'
import { APPLE_PROFILE_TYPE, renderAppleDavProfile } from './mail/device-setup.ts'

/**
 * Connection details of Web Disk and of calendars and contacts (docs/decisions/2026-11-07-dav-servers.md), read
 * from saved state only: the addresses the edge serves (a domain with a covering certificate), the logins and the
 * collection URLs. Web Disk users are created, changed and removed through the User Manager routes
 * (/api/service-users). Whether the host serves them is the catalog's qualification, not this read.
 */
export const WEB_DISK_PATH = '/api/account/web-disk'
export const DAV_CONFIG_PATH = '/api/account/calendars-contacts/connection'
export const WEBMAIL_DAV_CONFIG_PATH = '/api/webmail/dav-config'
export const DAV_PROFILE_PATH = DAV_CONFIG_PATH + '/apple.mobileconfig'
export const WEBMAIL_DAV_PROFILE_PATH = WEBMAIL_DAV_CONFIG_PATH + '/apple.mobileconfig'

export interface DavAddress { domain: string; url: string }
export interface WebDiskLoginView {
  kind: 'main' | 'user'; id: string | null; login: string; directory: string; access: 'read-write' | 'read-only'
  /** other services of this login: removing Web Disk from it keeps them, and a mailbox is never deleted from this page */
  otherServices: ('email' | 'ftp')[]
}
export interface WebDiskView {
  context: { accountId: string; username: string }
  port: number
  addresses: DavAddress[]
  /** account domains without a covering certificate: the edge does not serve them */
  unsecuredDomains: string[]
  logins: WebDiskLoginView[]
  authentication: 'basic-over-tls'
}
export interface DavPrincipalView {
  kind: 'main' | 'mailbox'; login: string; server: string | null; principal: string | null; calendar: string | null; addressBook: string | null
  /** the device profile of this login; null while no name serves it */
  profile: string | null
}
export interface DavConfigView {
  context: { accountId: string; username: string }
  port: number
  addresses: DavAddress[]
  unsecuredDomains: string[]
  principals: DavPrincipalView[]
  authentication: 'basic-over-tls'
  discovery: 'srv-and-well-known'
}

export type DavWorkspacePorts = AccountOwnerPorts

const servedDomains = (account: Account, domains: readonly Domain[], certs: readonly Certificate[]): { served: string[]; unsecured: string[] } => {
  const served = system.davNamesByCertificate(account, domains, certs).flatMap(group => group.names).sort()
  const unsecured = domains.filter(d => d.accountId === account.id && !d.suspended && !served.includes(d.name)).map(d => d.name).sort()
  return { served, unsecured }
}

const address = (domain: string, port: number): DavAddress => ({ domain, url: `https://${domain}:${port}/` })

export const readWebDiskView = (account: Account, domains: readonly Domain[], certs: readonly Certificate[], users: readonly ServiceUser[]): WebDiskView => {
  const { served, unsecured } = servedDomains(account, domains, certs)
  return {
    context: { accountId: account.id, username: account.username },
    port: system.WEBDISK_PORT,
    addresses: served.map(domain => address(domain, system.WEBDISK_PORT)),
    unsecuredDomains: unsecured,
    logins: [
      { kind: 'main', id: null, login: account.username, directory: '', access: 'read-write', otherServices: [] },
      ...users.filter(user => user.services.webdisk).sort((a, b) => a.login.localeCompare(b.login))
        .map((user): WebDiskLoginView => ({ kind: 'user', id: user.id, login: user.login, directory: user.ftpDir, access: user.webdiskReadOnly ? 'read-only' : 'read-write',
          otherServices: [...(user.services.email ? ['email' as const] : []), ...(user.services.ftp ? ['ftp' as const] : [])] })),
    ],
    authentication: 'basic-over-tls',
  }
}

/** Radicale paths: the principal is /<key>/ (main or the service user id), the defaults are calendar/ and addressbook/ (dav.ts DAV_LAUNCHER). */
export const davPrincipal = (kind: DavPrincipalView['kind'], login: string, key: string, served: readonly string[], profile = `${DAV_PROFILE_PATH}?principal=${key}`): DavPrincipalView => {
  const own = login.includes('@') ? login.slice(login.indexOf('@') + 1) : null
  const domain = own !== null && served.includes(own) ? own : served[0]
  if (!domain) return { kind, login, server: null, principal: null, calendar: null, addressBook: null, profile: null }
  const server = `https://${domain}:${system.CALDAV_PORT}/`
  const principal = `${server}${key}/`
  return { kind, login, server, principal, calendar: `${principal}calendar/`, addressBook: `${principal}addressbook/`, profile }
}

export const readDavConfigView = (account: Account, domains: readonly Domain[], certs: readonly Certificate[], users: readonly ServiceUser[]): DavConfigView => {
  const { served, unsecured } = servedDomains(account, domains, certs)
  return {
    context: { accountId: account.id, username: account.username },
    port: system.CALDAV_PORT,
    addresses: served.map(domain => address(domain, system.CALDAV_PORT)),
    unsecuredDomains: unsecured,
    principals: [
      davPrincipal('main', account.username, system.CALDAV_MAIN_PRINCIPAL, served),
      ...users.filter(user => user.services.email).sort((a, b) => a.login.localeCompare(b.login)).map(user => davPrincipal('mailbox', user.login.toLowerCase(), user.id, served)),
    ],
    authentication: 'basic-over-tls',
    discovery: 'srv-and-well-known',
  }
}

/** A profile names no password: the device asks for it once, on install. */
const davProfile = (principal: DavPrincipalView | undefined): Response => {
  if (!principal?.server || !principal.principal) return fail('NOT_FOUND', 'no name serves this login yet', { stateChanged: false, reason: 'dav_not_served' })
  return new Response(renderAppleDavProfile(principal.login, new URL(principal.server).hostname, system.CALDAV_PORT, principal.principal), {
    headers: { 'content-type': APPLE_PROFILE_TYPE, 'content-disposition': 'attachment; filename="calendars-contacts.mobileconfig"', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  })
}

const read = async (ports: DavWorkspacePorts, account: Account) => ({
  domains: await ports.store.listDomains({ accountId: account.id }),
  certs: await ports.store.listCertificates(account.id),
  users: await ports.store.listServiceUsers(account.id),
})

/** GET /api/account/web-disk and /api/account/calendars-contacts/connection for the signed-in account owner. */
export async function handleDavWorkspaceRoute(req: Request, url: URL, method: string, ports: DavWorkspacePorts): Promise<Response | null> {
  if (url.pathname === DAV_PROFILE_PATH) {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const { account } = await authorizeAccountOwner(ports, req, ['calendars-contacts-config'], 'Calendars and Contacts')
    const { domains, certs, users } = await read(ports, account)
    // The selector is only ever one of the links the view gave out.
    return davProfile(readDavConfigView(account, domains, certs, users).principals.find(principal => principal.profile === url.pathname + url.search))
  }
  const kind = url.pathname === WEB_DISK_PATH ? 'webdisk' : url.pathname === DAV_CONFIG_PATH ? 'caldav' : null
  if (!kind) return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'this view accepts no selectors', { stateChanged: false })
  const { account } = await authorizeAccountOwner(ports, req, [kind === 'webdisk' ? 'web-disk' : 'calendars-contacts-config'], kind === 'webdisk' ? 'Web Disk' : 'Calendars and Contacts')
  const { domains, certs, users } = await read(ports, account)
  return workspaceJson(kind === 'webdisk' ? readWebDiskView(account, domains, certs, users) : readDavConfigView(account, domains, certs, users))
}

export interface WebmailDavConfigPorts {
  /** the sealed mailbox of this request (feature webmail-dav-config) */
  open(request: Request): Promise<{ mailbox: string; accountId: string; serviceUserId: string }>
  store: DavWorkspacePorts['store']
}

/** GET /api/webmail/dav-config: the signed-in mailbox's own calendar and address book connection. */
export async function handleWebmailDavConfigRoute(req: Request, url: URL, method: string, ports: WebmailDavConfigPorts): Promise<Response | null> {
  if (url.pathname !== WEBMAIL_DAV_CONFIG_PATH && url.pathname !== WEBMAIL_DAV_PROFILE_PATH) return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'this view accepts no selectors', { stateChanged: false })
  const opened = await ports.open(req)
  const account = await ports.store.getAccount(opened.accountId)
  if (!account) return fail('NOT_FOUND', 'mailbox not found', { stateChanged: false })
  const { served } = servedDomains(account, await ports.store.listDomains({ accountId: account.id }), await ports.store.listCertificates(account.id))
  const principal = davPrincipal('mailbox', opened.mailbox.toLowerCase(), opened.serviceUserId, served, WEBMAIL_DAV_PROFILE_PATH)
  if (url.pathname === WEBMAIL_DAV_PROFILE_PATH) return davProfile(principal)
  return workspaceJson({ mailbox: opened.mailbox, port: system.CALDAV_PORT, ...principal, authentication: 'basic-over-tls', discovery: 'srv-and-well-known' })
}
