import { fail } from '@xpanel/core'

/** Desired-state grammars of the mail, certificate and DNS provider tools, kept beside the service policies that share their file format. */
const invalid = (message: string, extra: Record<string, unknown> = {}): never => fail('VALIDATION', message, { stateChanged: false, ...extra })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, expected: readonly string[]): boolean => Object.keys(value).sort().join() === [...expected].sort().join()
const flag = (value: unknown, what: string): boolean => typeof value === 'boolean' ? value : invalid(`${what} must be true or false`)
const whole = (value: unknown, min: number, max: number, what: string): number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : invalid(`${what} must be a whole number from ${min} to ${max}`)
const list = (value: unknown, max: number, what: string): unknown[] => Array.isArray(value) && value.length <= max ? value : invalid(`${what} must be a list of at most ${max} entries`)
const ACCOUNT = /^[a-z][a-z0-9]{0,15}$/
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
export const MAILBOX = /^[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/

export const AUTOSSL_NOTIFY_LEVELS = ['all', 'problems', 'failures', 'none'] as const
export type AutoSslNotifyLevel = typeof AUTOSSL_NOTIFY_LEVELS[number]
export interface AutoSslPolicy { enabled: boolean; renewDays: number; replaceInvalid: boolean; adminNotify: AutoSslNotifyLevel; userNotify: AutoSslNotifyLevel; excludedAccounts: string[]; excludedDomains: string[] }
// The CA issues 90-day certificates; renewing in the last 30 days keeps the rate limit and leaves time for retries.
export const AUTOSSL_DEFAULT: AutoSslPolicy = { enabled: true, renewDays: 30, replaceInvalid: false, adminNotify: 'problems', userNotify: 'failures', excludedAccounts: [], excludedDomains: [] }
const level = (value: unknown, what: string): AutoSslNotifyLevel => (AUTOSSL_NOTIFY_LEVELS as readonly unknown[]).includes(value) ? value as AutoSslNotifyLevel : invalid(`${what} is not a notification level`)
export function parseAutoSsl(value: unknown): AutoSslPolicy {
  if (!object(value) || !keys(value, Object.keys(AUTOSSL_DEFAULT))) return invalid('unsupported AutoSSL fields')
  return { enabled: flag(value.enabled, 'enabled'), renewDays: whole(value.renewDays, 1, 60, 'renewDays'), replaceInvalid: flag(value.replaceInvalid, 'replaceInvalid'),
    adminNotify: level(value.adminNotify, 'adminNotify'), userNotify: level(value.userNotify, 'userNotify'),
    excludedAccounts: [...new Set(list(value.excludedAccounts, 5000, 'excludedAccounts').map(item => typeof item === 'string' && ACCOUNT.test(item) ? item : invalid('excludedAccounts must be account names')))].sort(),
    excludedDomains: [...new Set(list(value.excludedDomains, 5000, 'excludedDomains').map(item => typeof item === 'string' && DOMAIN.test(item) ? item : invalid('excludedDomains must be domain names')))].sort() }
}

export const WEBDISK_TLS_PROTOCOLS = ['TLSv1.2', 'TLSv1.3'] as const
export interface WebdiskTlsPolicy { protocols: string[]; ciphers: string }
export const WEBDISK_TLS_DEFAULT: WebdiskTlsPolicy = { protocols: [...WEBDISK_TLS_PROTOCOLS], ciphers: 'ECDHE+AESGCM:ECDHE+CHACHA20' }
// OpenSSL cipher string: words joined by : + ! - with no space or quote, so it stays one nginx argument.
const CIPHERS = /^[A-Za-z0-9+!_-]{1,64}(?::[A-Za-z0-9+!_-]{1,64}){0,63}$/
const WEAK_CIPHER = /(?:^|[:+])(?:ALL|DEFAULT|COMPLEMENTOFALL|LOW|EXP|EXPORT|NULL|eNULL|aNULL|RC4|DES|3DES|MD5|SEED|IDEA)(?=$|[:+])/
export function parseWebdiskTls(value: unknown): WebdiskTlsPolicy {
  if (!object(value) || !keys(value, ['protocols', 'ciphers'])) return invalid('exactly protocols and ciphers are required')
  const protocols = list(value.protocols, 2, 'protocols')
  for (const item of protocols) if (!(WEBDISK_TLS_PROTOCOLS as readonly unknown[]).includes(item)) return invalid(`${String(item).slice(0, 16)} is not allowed: only TLSv1.2 and TLSv1.3 are accepted`, { fields: [{ field: 'protocols', code: 'protocol' }] })
  if (!protocols.length || new Set(protocols).size !== protocols.length) return invalid('choose TLSv1.2, TLSv1.3 or both', { fields: [{ field: 'protocols', code: 'protocol' }] })
  if (typeof value.ciphers !== 'string' || !CIPHERS.test(value.ciphers) || WEAK_CIPHER.test(value.ciphers)) return invalid('the cipher list must name modern AEAD or ECDHE ciphers', { fields: [{ field: 'ciphers', code: 'cipher' }] })
  return { protocols: WEBDISK_TLS_PROTOCOLS.filter(item => protocols.includes(item)), ciphers: value.ciphers }
}

export const OUTBOUND_SCOPES = ['plan', 'account', 'domain', 'mailbox'] as const
export type OutboundScope = typeof OUTBOUND_SCOPES[number]
export interface OutboundRule { scope: OutboundScope; target: string; hourly: number; daily: number }
/** Limits count delivered recipients; 0 means no limit. */
export interface OutboundSpamPolicy { enabled: boolean; mailboxHourly: number; mailboxDaily: number; accountHourly: number; accountDaily: number; domainHourly: number; domainDaily: number; rules: OutboundRule[] }
export const OUTBOUND_SPAM_DEFAULT: OutboundSpamPolicy = { enabled: false, mailboxHourly: 200, mailboxDaily: 1000, accountHourly: 500, accountDaily: 5000, domainHourly: 0, domainDaily: 0, rules: [] }
const limit = (value: unknown, what: string): number => whole(value, 0, 1_000_000, what)
export function parseOutboundSpam(value: unknown): OutboundSpamPolicy {
  if (!object(value) || !keys(value, Object.keys(OUTBOUND_SPAM_DEFAULT))) return invalid('unsupported outbound spam fields')
  const rules = list(value.rules, 2000, 'rules').map(item => {
    if (!object(item) || !keys(item, ['scope', 'target', 'hourly', 'daily']) || !(OUTBOUND_SCOPES as readonly unknown[]).includes(item.scope) || typeof item.target !== 'string') return invalid('a limit needs a scope, a target and two numbers')
    const target = item.target.trim().toLowerCase(), scope = item.scope as OutboundScope
    if (scope === 'mailbox' ? !MAILBOX.test(target) : scope === 'account' ? !ACCOUNT.test(target) : scope === 'domain' ? !/^[a-z0-9.-]{1,253}$/.test(target) : !/^[\p{L}\p{N} ._-]{1,64}$/u.test(target)) return invalid(`the ${scope} limit target is not valid`)
    return { scope, target, hourly: limit(item.hourly, 'hourly'), daily: limit(item.daily, 'daily') }
  })
  if (new Set(rules.map(rule => rule.scope + ' ' + rule.target)).size !== rules.length) return invalid('each target takes one limit')
  return { enabled: flag(value.enabled, 'enabled'), mailboxHourly: limit(value.mailboxHourly, 'mailboxHourly'), mailboxDaily: limit(value.mailboxDaily, 'mailboxDaily'), accountHourly: limit(value.accountHourly, 'accountHourly'), accountDaily: limit(value.accountDaily, 'accountDaily'), domainHourly: limit(value.domainHourly, 'domainHourly'), domainDaily: limit(value.domainDaily, 'domainDaily'), rules }
}

export interface AutoDnsPolicy { enabled: boolean; ttl: number; proxied: boolean }
export const AUTO_DNS_DEFAULT: AutoDnsPolicy = { enabled: false, ttl: 3600, proxied: false }
export function parseAutoDns(value: unknown): AutoDnsPolicy {
  if (!object(value) || !keys(value, Object.keys(AUTO_DNS_DEFAULT))) return invalid('unsupported automatic DNS fields')
  const ttl = whole(value.ttl, 1, 86400, 'ttl')
  // Cloudflare: 1 means automatic; any other value starts at 60.
  if (ttl !== 1 && ttl < 60) return invalid('ttl must be 1 (automatic) or at least 60')
  return { enabled: flag(value.enabled, 'enabled'), ttl, proxied: flag(value.proxied, 'proxied') }
}

/** The notices the product sends and the variables each template may use. */
export const NOTIFICATION_TEMPLATE_VARS: Readonly<Record<string, readonly string[]>> = {
  'account.provisioned': ['account', 'domain', 'server'],
  'account.suspended': ['account', 'domain', 'server'],
  'account.unsuspended': ['account', 'domain', 'server'],
  'quota.warning': ['account', 'usedMb', 'limitMb', 'percent', 'server'],
  'ssl.renewal': ['account', 'summary', 'server'],
  'mail.outbound_hold': ['target', 'count', 'limit', 'window', 'server'],
}
export const NOTIFICATION_TEMPLATE_LOCALES = ['en', 'ar'] as const
export type NotificationLocale = typeof NOTIFICATION_TEMPLATE_LOCALES[number]
export interface NotificationText { subject: string; body: string }
export type NotificationTemplate = Record<NotificationLocale, NotificationText>
export interface NotificationTemplatesPolicy { templates: Record<string, NotificationTemplate> }
export const NOTIFICATION_TEMPLATES_DEFAULT: NotificationTemplatesPolicy = { templates: {} }
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/
/** Every {name} must be a listed variable; a brace that opens no variable is refused, so a typo cannot reach a customer. */
export function assertNotificationText(text: string, event: string, field: string): void {
  const known = NOTIFICATION_TEMPLATE_VARS[event] ?? []
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
    const name = match[1]!
    if (!known.includes(name)) return invalid(`unknown variable {${name.slice(0, 40)}} in ${field}`, { reason: 'unknown_variable', variable: name.slice(0, 40), fields: [{ field, code: 'unknown_variable' }] })
  }
  if (/[{}]/.test(text.replace(/\{[^{}]*\}/g, ''))) return invalid(`unbalanced braces in ${field}`, { reason: 'unbalanced_braces', fields: [{ field, code: 'unbalanced_braces' }] })
}
export function parseNotificationTemplate(event: string, value: unknown): NotificationTemplate {
  if (!Object.hasOwn(NOTIFICATION_TEMPLATE_VARS, event)) return invalid('unknown notification event')
  if (!object(value) || !keys(value, NOTIFICATION_TEMPLATE_LOCALES)) return invalid('a template needs its English and Arabic versions')
  const version = (locale: NotificationLocale): NotificationText => {
    const item = value[locale]
    if (!object(item) || !keys(item, ['subject', 'body']) || typeof item.subject !== 'string' || typeof item.body !== 'string') return invalid(`the ${locale} version needs a subject and a body`)
    // A missing translation blocks publishing: an empty version would send an empty notice.
    if (!item.subject.trim() || !item.body.trim()) return invalid(`the ${locale} version is missing`, { reason: 'missing_translation', locale, fields: [{ field: locale, code: 'missing_translation' }] })
    if (item.subject.length > 200 || /[\r\n]/.test(item.subject) || CONTROL.test(item.subject)) return invalid(`the ${locale} subject must be one line of at most 200 characters`)
    if (item.body.length > 20_000 || CONTROL.test(item.body)) return invalid(`the ${locale} body must be text of at most 20000 characters`)
    assertNotificationText(item.subject, event, locale + '.subject'); assertNotificationText(item.body, event, locale + '.body')
    return { subject: item.subject, body: item.body }
  }
  return { en: version('en'), ar: version('ar') }
}
export function parseNotificationTemplates(value: unknown): NotificationTemplatesPolicy {
  if (!object(value) || !keys(value, ['templates']) || !object(value.templates)) return invalid('unsupported template fields')
  return { templates: Object.fromEntries(Object.entries(value.templates).map(([event, item]) => [event, parseNotificationTemplate(event, item)])) }
}
