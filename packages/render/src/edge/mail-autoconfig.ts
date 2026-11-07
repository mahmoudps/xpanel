import { invalid, normalizeHostname } from '../services/validate.ts'
import type { Certificate, Domain } from '@xpanel/core'
import { block } from './nginx-syntax.ts'
import { nginxQuote } from './quote.ts'
import { certForName, type SiteGroup } from './sites.ts'
import { certPaths } from './paths.ts'

/**
 * Mail client autoconfiguration served by the nginx edge, as cPanel serves it for account domains: the
 * Thunderbird autoconfig document (config-v1.1) at autoconfig.<domain> and /.well-known/autoconfig, and the
 * Outlook POX autodiscover reply at autodiscover.<domain> and /autodiscover/autodiscover.xml. Both are static:
 * Thunderbird fills %EMAILADDRESS% itself, and Outlook signs in with the address the user typed.
 */
export interface MailClientEndpoint { protocol: 'imap' | 'smtp'; port: number; security: 'implicit-tls' | 'starttls' }
// What xPanel renders: Dovecot imap 143 (STARTTLS, ssl = required) and imaps 993, Postfix 465 and 587 (RFC 8314).
export const MAIL_CLIENT_ENDPOINTS: { incoming: readonly MailClientEndpoint[]; outgoing: readonly MailClientEndpoint[] } = Object.freeze({
  incoming: Object.freeze([{ protocol: 'imap', port: 993, security: 'implicit-tls' }, { protocol: 'imap', port: 143, security: 'starttls' }] as const),
  outgoing: Object.freeze([{ protocol: 'smtp', port: 465, security: 'implicit-tls' }, { protocol: 'smtp', port: 587, security: 'starttls' }] as const),
})
/** The mail server name clients use and the account domains that receive mail. */
export interface MailAutoconfigOption { hostname: string; domains: readonly string[] }
export const AUTOCONFIG_LABELS = ['autoconfig', 'autodiscover'] as const

/** Thunderbird clientConfig 1.1 for every mail domain of one account. */
export function renderAutoconfigXml(option: MailAutoconfigOption): string {
  const host = normalizeHostname(option.hostname, 'mail hostname')
  const domains = option.domains.map(name => normalizeHostname(name, 'mail domain'))
  if (!domains.length) return invalid('mail domains', domains, 'need at least one domain')
  const server = (kind: 'incomingServer' | 'outgoingServer', type: string, endpoint: MailClientEndpoint) =>
    `<${kind} type="${type}"><hostname>${host}</hostname><port>${endpoint.port}</port><socketType>${endpoint.security === 'implicit-tls' ? 'SSL' : 'STARTTLS'}</socketType><authentication>password-cleartext</authentication><username>%EMAILADDRESS%</username></${kind}>`
  return `<?xml version="1.0" encoding="UTF-8"?><clientConfig version="1.1"><emailProvider id="${domains[0]}">${domains.map(name => `<domain>${name}</domain>`).join('')}<displayName>${domains[0]}</displayName><displayShortName>${domains[0]}</displayShortName>`
    + [...MAIL_CLIENT_ENDPOINTS.incoming.map(item => server('incomingServer', 'imap', item)), ...MAIL_CLIENT_ENDPOINTS.outgoing.map(item => server('outgoingServer', 'smtp', item))].join('')
    + '</emailProvider></clientConfig>'
}

/** Outlook POX autodiscover reply (MS-OXDSCLI) with the implicit-TLS IMAP and SMTP endpoints. */
export function renderAutodiscoverXml(option: MailAutoconfigOption): string {
  const host = normalizeHostname(option.hostname, 'mail hostname')
  const protocol = (type: 'IMAP' | 'SMTP', port: number) => `<Protocol><Type>${type}</Type><Server>${host}</Server><Port>${port}</Port><DomainRequired>off</DomainRequired><SPA>off</SPA><SSL>on</SSL><AuthRequired>on</AuthRequired>${type === 'SMTP' ? '<UsePOPAuth>on</UsePOPAuth><SMTPLast>off</SMTPLast>' : ''}</Protocol>`
  return '<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006"><Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a"><Account><AccountType>email</AccountType><Action>settings</Action>'
    + protocol('IMAP', MAIL_CLIENT_ENDPOINTS.incoming[0]!.port) + protocol('SMTP', MAIL_CLIENT_ENDPOINTS.outgoing[0]!.port) + '</Account></Response></Autodiscover>'
}

const documentLocation = (head: string, xml: string): string[] =>
  block(head, ['default_type application/xml;', 'add_header Cache-Control "no-cache" always;', `return 200 ${nginxQuote(xml, 'mail client document')};`])

/** The two well-known paths every site of an account with mail answers itself; Outlook POSTs to the second. */
export function mailAutoconfigLocations(option: MailAutoconfigOption | undefined, group: SiteGroup): string[] {
  const mine = mailDomains(option, group)
  if (!option || !mine.length) return []
  return [...documentLocation('location = /.well-known/autoconfig/mail/config-v1.1.xml', renderAutoconfigXml(option)),
    ...documentLocation('location ~* ^/autodiscover/autodiscover\\.xml$', renderAutodiscoverXml(option))]
}
const mailDomains = (option: MailAutoconfigOption | undefined, group: SiteGroup): Domain[] =>
  option ? [group.main, ...group.aliases].filter(domain => option.domains.includes(domain.name)) : []

/**
 * Server blocks for autoconfig.<domain> and autodiscover.<domain> of every mail domain: port 80 always, 443
 * for the names a certificate covers. A name the account already serves as its own site is left to that site.
 */
export function renderMailAutoconfigServers(option: MailAutoconfigOption | undefined, groups: readonly SiteGroup[], certs: Certificate[], listen: (port: 80 | 443) => string[]): string[] {
  if (!option) return []
  const served = new Set(groups.flatMap(group => [...group.names, ...group.wildcards]))
  const hosts = groups.flatMap(group => mailDomains(option, group).flatMap(domain => AUTOCONFIG_LABELS.map(label => ({ name: `${label}.${domain.name}`, domain, main: group.main }))))
    .filter(host => !served.has(host.name))
  if (!hosts.length) return []
  const body = [...documentLocation('location = /mail/config-v1.1.xml', renderAutoconfigXml(option)), ...documentLocation('location = /.well-known/autoconfig/mail/config-v1.1.xml', renderAutoconfigXml(option)),
    ...documentLocation('location ~* ^/autodiscover/autodiscover\\.xml$', renderAutodiscoverXml(option)), ...block('location /', ['return 404;'])]
  const server = (port: 80 | 443, names: string[], tls: string[] = []) => block('server', [...listen(port), `server_name ${names.join(' ')};`, 'access_log off;', ...tls, ...body])
  const out = ['# mail client autoconfiguration', ...server(80, hosts.map(host => host.name))]
  const byCert = new Map<string, { cert: Certificate; names: string[] }>()
  for (const host of hosts) {
    const cert = certForName(host.name, host.domain, host.main, certs)
    if (cert) byCert.set(cert.id, { cert, names: [...byCert.get(cert.id)?.names ?? [], host.name] })
  }
  for (const { cert, names } of byCert.values()) {
    const files = certPaths(cert.id)
    out.push(...server(443, names, [`ssl_certificate ${files.cert};`, `ssl_certificate_key ${files.key};`]))
  }
  return out
}
