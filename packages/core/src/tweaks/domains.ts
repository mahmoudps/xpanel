import { fail } from '../errors.ts'
import { msgid } from '../i18n/translator.ts'
import type { TweakDefinition } from './index.ts'

/** Tweak Settings of the Domains section (cPanel Tweak Settings > Domains); each key has a real consumer. */
export const DOMAIN_TWEAKS: readonly TweakDefinition[] = [
  // cPanel defaults this on; here it starts off because addon domains live in ~/domains/<name>/public_html by default and owners may choose other roots.
  { key: 'domains.docrootPublicHtml', label: msgid('Restrict document roots to public_html'), help: msgid('A document root chosen for a subdomain or addon domain must sit inside public_html.'),
    consumer: '/whm/domains', kind: 'boolean', default: false },
  { key: 'domains.hostnameSubdomains', label: msgid('Allow subdomains of the server hostname'), help: msgid('Lets users add domains under the server hostname.'),
    consumer: '/whm/domains', kind: 'boolean', default: false },
  { key: 'domains.crossAccountSubdomains', label: msgid('Allow subdomains of other accounts'), help: msgid('Lets a user add a subdomain of a domain another account owns.'),
    consumer: '/whm/domains', kind: 'boolean', default: false },
  { key: 'domains.blockCommon', label: msgid('Block common domains'), help: msgid('Refuses well-known domains that a hosting user cannot own.'),
    consumer: '/whm/domains', kind: 'boolean', default: true },
  // cPanel defaults these two off; here they start on, because a host without outbound DNS could not add any domain otherwise.
  { key: 'domains.allowRemote', label: msgid('Allow domains that point to another server'), help: msgid('Lets users add a domain whose address is not on this server.'),
    consumer: '/whm/domains', kind: 'boolean', default: true },
  { key: 'domains.allowUnregistered', label: msgid('Allow unregistered domains'), help: msgid('Lets users add a domain that does not resolve yet.'),
    consumer: '/whm/domains', kind: 'boolean', default: true },
  { key: 'domains.serviceSubdomains', label: msgid('Add service subdomain records to new zones'), help: msgid('New zones get webmail, cpanel, whm, webdisk, cpcalendars and cpcontacts addresses.'),
    consumer: '/whm/dns', kind: 'boolean', default: false },
  { key: 'domains.autodiscoverRecords', label: msgid('Add autodiscover records to new zones'), help: msgid('New zones get autoconfig and autodiscover addresses and the autodiscover SRV record.'),
    consumer: '/whm/dns', kind: 'boolean', default: true },
  { key: 'domains.nameserverRecords', label: msgid('Add nameserver A records to new zones'), help: msgid('New zones get addresses for nameservers inside the zone.'),
    consumer: '/whm/dns', kind: 'boolean', default: true },
]

/** What Tweak Settings asks of a new default zone. */
export const zoneDefaultsFromTweaks = (values: Readonly<Record<string, unknown>>): { serviceSubdomains: boolean; autodiscover: boolean; nameserverRecords: boolean } =>
  ({ serviceSubdomains: values['domains.serviceSubdomains'] === true, autodiscover: values['domains.autodiscoverRecords'] !== false, nameserverRecords: values['domains.nameserverRecords'] !== false })

// shortcut: a short list of the names abuse reports name most; extend here when a report names another.
const COMMON_DOMAINS: readonly string[] = ['google.com', 'gmail.com', 'youtube.com', 'facebook.com', 'instagram.com', 'microsoft.com', 'outlook.com', 'live.com', 'hotmail.com', 'yahoo.com', 'apple.com', 'icloud.com', 'amazon.com', 'paypal.com', 'cpanel.net']
const covers = (domain: string, parent: string): boolean => domain === parent || domain.endsWith(`.${parent}`)

export interface DomainTweakInput {
  values: Readonly<Record<string, unknown>>
  /** Root may always add any domain; these rules guard what hosting users and resellers add. */
  privileged: boolean
  name: string
  accountId: string
  home: string
  /** The caller's chosen document root; absent or the product default is not a choice. */
  docRoot?: string | undefined
  defaultDocRoot: string
  hostname: string | null
  others: readonly { name: string; accountId: string }[]
  /** Where the name resolves now; absent when neither resolution key is off. */
  resolution?: 'here' | 'elsewhere' | 'unregistered' | 'unknown'
}

/** Tweak Settings > Domains at the one place every new domain passes. */
export const assertDomainTweaks = (input: DomainTweakInput): void => {
  const { values, name } = input, unchanged = { stateChanged: false }
  const chosen = input.docRoot !== undefined && input.docRoot !== input.defaultDocRoot, publicHtml = `${input.home}/public_html`
  if (values['domains.docrootPublicHtml'] === true && chosen && !(input.docRoot === publicHtml || input.docRoot!.startsWith(`${publicHtml}/`))) fail('VALIDATION', 'the document root must sit inside public_html', { ...unchanged, reason: 'DOCROOT_OUTSIDE_PUBLIC_HTML' })
  if (input.privileged) return
  if (values['domains.hostnameSubdomains'] !== true && input.hostname && name !== input.hostname && name.endsWith(`.${input.hostname}`)) fail('FORBIDDEN', 'this server does not allow subdomains of its hostname', { ...unchanged, reason: 'hostname_subdomain' })
  if (values['domains.crossAccountSubdomains'] !== true && input.others.some(other => other.accountId !== input.accountId && name.endsWith(`.${other.name}`))) fail('FORBIDDEN', 'this domain is a subdomain of another account', { ...unchanged, reason: 'cross_account_subdomain' })
  if (values['domains.blockCommon'] === true && COMMON_DOMAINS.some(common => covers(name, common))) fail('FORBIDDEN', 'this domain is blocked on this server', { ...unchanged, reason: 'common_domain' })
  if (values['domains.allowRemote'] === false && input.resolution === 'elsewhere') fail('FORBIDDEN', 'this domain resolves to another server', { ...unchanged, reason: 'remote_domain' })
  if (values['domains.allowUnregistered'] === false && input.resolution === 'unregistered') fail('FORBIDDEN', 'this domain does not resolve', { ...unchanged, reason: 'unregistered_domain' })
}
