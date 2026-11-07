import { DEFAULT_FPM, fail, fpmErrors, sanitizePhpIni } from '@xpanel/core'
import type { FpmSettings, Limit } from '@xpanel/core'
import { edge } from '@xpanel/render'
import { AUTO_DNS_DEFAULT, AUTOSSL_DEFAULT, NOTIFICATION_TEMPLATES_DEFAULT, OUTBOUND_SPAM_DEFAULT, parseAutoDns, parseAutoSsl, parseNotificationTemplates, parseOutboundSpam, parseWebdiskTls, WEBDISK_TLS_DEFAULT } from './mail-cert-policy.ts'

/** Desired-state grammars of the Wave 5 services and security centre tools, kept beside the sec kinds that share their file format. */
export const SVC_STATE_PATHS = {
  traceroute: 'extended/server/traceroute-access.json',
  'smtp-restrictions': 'extended/server/smtp-restrictions.json',
  'fork-bomb': 'extended/server/fork-bomb.json',
  'process-killer': 'extended/server/process-killer.json',
  'antivirus-scope': 'extended/server/antivirus-scope.json',
  'php-fpm-defaults': 'extended/server/php-fpm-defaults.json',
  'waf-rules': 'extended/server/waf-rules.json',
  'waf-vendors': 'extended/server/waf-vendors.json',
  autossl: 'extended/tls/autossl.json',
  'webdisk-tls': 'extended/server/webdisk-tls.json',
  'outbound-spam': 'extended/mail/outbound-spam.json',
  'auto-dns': 'extended/dns/auto-dns.json',
  'notification-templates': 'extended/panel/notification-templates.json',
} as const
export type SvcKind = keyof typeof SVC_STATE_PATHS

/** cPanel's checklist; `comm` is what ps reports, so each name is matched exactly. */
export const FORBIDDEN_PROCESS_NAMES: readonly string[] = ['BitchX', 'bnc', 'eggdrop', 'generic-sniffers', 'guardservices', 'ircd', 'psyBNC', 'ptlink', 'services']
export interface SvcProcessKillerPolicy { enabled: boolean; names: string[]; trustedUsers: string[] }
export interface SvcAntivirusScope { home: boolean; mail: boolean; publicFtp: boolean; publicWeb: boolean }
export interface SvcAntivirusPolicy { global: SvcAntivirusScope; users: Record<string, SvcAntivirusScope> }
export const PHP_LOCKABLE_INI = ['allow_url_fopen', 'short_open_tag', 'log_errors', 'error_reporting'] as const
export type PhpLockableIni = (typeof PHP_LOCKABLE_INI)[number]
export interface SvcPhpFpmDefaults { pool: FpmSettings; ini: Record<PhpLockableIni, { value: string; locked: boolean } | null> }
export interface SvcWafRule { id: number; text: string; note: string; enabled: boolean }
export type SvcWafEngine = 'inherit' | 'On' | 'DetectionOnly'
export interface SvcWafRulesPolicy { engine: SvcWafEngine; deployedEngine: SvcWafEngine; staged: SvcWafRule[]; deployed: SvcWafRule[] }
export interface SvcWafVendor { id: string; name: string; description: string; docsUrl: string | null; metadataUrl: string; archiveSha256: string; version: string; enabled: boolean; autoUpdate: boolean; disabledFiles: string[] }
export interface SvcWafVendorsPolicy { crsDisabledFiles: string[]; vendors: SvcWafVendor[] }

const ALLOW_ALL: SvcAntivirusScope = { home: true, mail: true, publicFtp: true, publicWeb: true }
export const SVC_DEFAULTS = {
  traceroute: { allowed: false },
  'smtp-restrictions': { enabled: false },
  'fork-bomb': { enabled: false },
  'process-killer': { enabled: false, names: [...FORBIDDEN_PROCESS_NAMES], trustedUsers: [] } as SvcProcessKillerPolicy,
  'antivirus-scope': { global: ALLOW_ALL, users: {} } as SvcAntivirusPolicy,
  'php-fpm-defaults': { pool: { ...DEFAULT_FPM }, ini: { allow_url_fopen: null, short_open_tag: null, log_errors: null, error_reporting: null } } as SvcPhpFpmDefaults,
  'waf-rules': { engine: 'inherit', deployedEngine: 'inherit', staged: [], deployed: [] } as SvcWafRulesPolicy,
  'waf-vendors': { crsDisabledFiles: [], vendors: [] } as SvcWafVendorsPolicy,
  autossl: AUTOSSL_DEFAULT, 'webdisk-tls': WEBDISK_TLS_DEFAULT, 'outbound-spam': OUTBOUND_SPAM_DEFAULT, 'auto-dns': AUTO_DNS_DEFAULT, 'notification-templates': NOTIFICATION_TEMPLATES_DEFAULT,
}

const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, expected: readonly string[]): boolean => Object.keys(value).sort().join() === [...expected].sort().join()
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const ACCOUNT = /^[a-z][a-z0-9]{0,15}$/
const SHA = /^[0-9a-f]{64}$/
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.conf$/
const text = (value: unknown, max: number, what: string): string => typeof value === 'string' && value.length <= max && !UNSAFE.test(value) ? value : invalid(`${what} must be text of at most ${max} characters`)
const flag = (value: unknown, what: string): boolean => typeof value === 'boolean' ? value : invalid(`${what} must be true or false`)
const list = (value: unknown, max: number, what: string): unknown[] => Array.isArray(value) && value.length <= max ? value : invalid(`${what} must be a list of at most ${max} entries`)
const onOnly = (key: string) => (value: unknown): { [key: string]: boolean } => {
  if (!object(value) || !keys(value, [key])) return invalid(`exactly ${key} is required`)
  return { [key]: flag(value[key], key) }
}
export const isVendorId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
const fileNames = (value: unknown, what: string): string[] => [...new Set(list(value, 1024, what).map(item => typeof item === 'string' && FILE.test(item) ? item : invalid(`${what} must be rule file names`)))].sort()
const httpsUrl = (value: unknown, what: string): string => {
  const url = typeof value === 'string' && value.length <= 512 && !UNSAFE.test(value) && URL.canParse(value) ? new URL(value) : null
  return url?.protocol === 'https:' && !url.username && !url.password ? value as string : invalid(`${what} must be an https URL`)
}

const parseProcessKiller = (value: unknown): SvcProcessKillerPolicy => {
  if (!object(value) || !keys(value, ['enabled', 'names', 'trustedUsers'])) return invalid('the process killer needs exactly enabled, names and trustedUsers')
  const names = list(value.names, FORBIDDEN_PROCESS_NAMES.length, 'forbidden processes').map(item => typeof item === 'string' && FORBIDDEN_PROCESS_NAMES.includes(item) ? item : invalid('forbidden processes come from the checklist'))
  const trustedUsers = list(value.trustedUsers, 5000, 'trusted users').map(item => typeof item === 'string' && ACCOUNT.test(item) ? item : invalid('trusted users are account usernames'))
  return { enabled: flag(value.enabled, 'enabled'), names: FORBIDDEN_PROCESS_NAMES.filter(name => names.includes(name)), trustedUsers: [...new Set(trustedUsers)].sort() }
}
const scopeOf = (value: unknown): SvcAntivirusScope => {
  if (!object(value) || !keys(value, ['home', 'mail', 'publicFtp', 'publicWeb'])) return invalid('a scan scope needs exactly home, mail, publicFtp and publicWeb')
  return { home: flag(value.home, 'home'), mail: flag(value.mail, 'mail'), publicFtp: flag(value.publicFtp, 'publicFtp'), publicWeb: flag(value.publicWeb, 'publicWeb') }
}
const parseAntivirus = (value: unknown): SvcAntivirusPolicy => {
  if (!object(value) || !keys(value, ['global', 'users']) || !object(value.users) || Object.keys(value.users).length > 5000) return invalid('the scan configuration needs exactly global and users')
  return { global: scopeOf(value.global), users: Object.fromEntries(Object.entries(value.users).sort(([a], [b]) => a.localeCompare(b)).map(([name, scope]) => [ACCOUNT.test(name) ? name : invalid('per-user scopes name account usernames'), scopeOf(scope)])) }
}
const parsePhpFpm = (value: unknown): SvcPhpFpmDefaults => {
  if (!object(value) || !keys(value, ['pool', 'ini']) || !object(value.ini) || !keys(value.ini, PHP_LOCKABLE_INI)) return invalid('PHP-FPM defaults need exactly pool and the lockable INI values')
  const problems = fpmErrors(value.pool)
  if (problems.length) return invalid(problems[0]!)
  const pool = value.pool as unknown as FpmSettings
  if (pool.maxChildren < 1 || pool.maxChildren > 10000) return invalid('max children must be from 1 to 10000')
  if (pool.maxRequests < 1) return invalid('max requests must be from 1 to 10000000')
  if (pool.processIdleTimeoutSec < 1) return invalid('the process idle timeout must be at least 1 second')
  const ini = {} as SvcPhpFpmDefaults['ini']
  for (const key of PHP_LOCKABLE_INI) {
    const item = value.ini[key]
    if (item === null) { ini[key] = null; continue }
    if (!object(item) || !keys(item, ['value', 'locked'])) return invalid('an INI default needs exactly value and locked')
    ini[key] = { value: sanitizePhpIni({ [key]: item.value })[key]!, locked: flag(item.locked, 'locked') }
  }
  return { pool: { mode: pool.mode, maxChildren: pool.maxChildren, startServers: pool.startServers, minSpareServers: pool.minSpareServers, maxSpareServers: pool.maxSpareServers, maxRequests: pool.maxRequests, processIdleTimeoutSec: pool.processIdleTimeoutSec }, ini }
}
const ruleOf = (value: unknown): SvcWafRule => {
  if (!object(value) || !keys(value, ['id', 'text', 'note', 'enabled']) || !Number.isSafeInteger(value.id) || (value.id as number) < 1 || (value.id as number) > 99999) return invalid('a rule needs an id from 1 to 99999, text, a note and enabled')
  if (typeof value.text !== 'string' || value.text.length < 1 || value.text.length > 8192) return invalid('a rule is at most 8192 characters')
  const problem = edge.modsecRuleProblem(value.text)
  if (problem) return fail('VALIDATION', 'this rule cannot be loaded', { stateChanged: false, reason: problem })
  if (edge.modsecRuleIds(value.text).join() !== String(value.id)) return invalid('the rule text must carry exactly its own id')
  return { id: value.id as number, text: value.text, note: text(value.note, 256, 'the note'), enabled: flag(value.enabled, 'enabled') }
}
const rules = (value: unknown, what: string): SvcWafRule[] => {
  const parsed = list(value, 500, what).map(ruleOf)
  return new Set(parsed.map(rule => rule.id)).size === parsed.length ? parsed : invalid('rule ids must be distinct')
}
const parseWafRules = (value: unknown): SvcWafRulesPolicy => {
  if (!object(value) || !keys(value, ['engine', 'deployedEngine', 'staged', 'deployed'])) return invalid('WAF rules need exactly engine, deployedEngine, staged and deployed')
  const engineOf = (item: unknown): SvcWafEngine => item === 'inherit' || item === 'On' || item === 'DetectionOnly' ? item : invalid('the rule engine must be inherit, On or DetectionOnly')
  return { engine: engineOf(value.engine), deployedEngine: engineOf(value.deployedEngine), staged: rules(value.staged, 'staged rules'), deployed: rules(value.deployed, 'deployed rules') }
}
const parseWafVendors = (value: unknown): SvcWafVendorsPolicy => {
  if (!object(value) || !keys(value, ['crsDisabledFiles', 'vendors'])) return invalid('WAF vendors need exactly crsDisabledFiles and vendors')
  const vendors = list(value.vendors, 16, 'vendors').map((item): SvcWafVendor => {
    if (!object(item) || !keys(item, ['id', 'name', 'description', 'docsUrl', 'metadataUrl', 'archiveSha256', 'version', 'enabled', 'autoUpdate', 'disabledFiles'])) return invalid('a vendor has a fixed set of fields')
    if (!isVendorId(item.id) || typeof item.archiveSha256 !== 'string' || !SHA.test(item.archiveSha256)) return invalid('a vendor needs an id and an archive digest')
    return { id: item.id, name: text(item.name, 128, 'the vendor name'), description: text(item.description, 512, 'the vendor description'), docsUrl: item.docsUrl === null ? null : httpsUrl(item.docsUrl, 'the documentation link'), metadataUrl: httpsUrl(item.metadataUrl, 'the metadata URL'),
      archiveSha256: item.archiveSha256, version: text(item.version, 32, 'the version'), enabled: flag(item.enabled, 'enabled'), autoUpdate: flag(item.autoUpdate, 'autoUpdate'), disabledFiles: fileNames(item.disabledFiles, 'disabled files') }
  })
  if (new Set(vendors.map(vendor => vendor.id)).size !== vendors.length) return invalid('vendor ids must be distinct')
  return { crsDisabledFiles: fileNames(value.crsDisabledFiles, 'disabled files'), vendors }
}

export const SVC_PARSERS: Readonly<Record<SvcKind, (value: unknown) => unknown>> = {
  traceroute: onOnly('allowed'), 'smtp-restrictions': onOnly('enabled'), 'fork-bomb': onOnly('enabled'), 'process-killer': parseProcessKiller,
  'antivirus-scope': parseAntivirus, 'php-fpm-defaults': parsePhpFpm, 'waf-rules': parseWafRules, 'waf-vendors': parseWafVendors,
  autossl: parseAutoSsl, 'webdisk-tls': parseWebdiskTls, 'outbound-spam': parseOutboundSpam, 'auto-dns': parseAutoDns, 'notification-templates': parseNotificationTemplates,
}

/** A domain still on the release pool values follows the server defaults, within its plan's worker cap. */
export function effectiveFpm(own: FpmSettings, defaults: SvcPhpFpmDefaults | null, cap: Limit): FpmSettings {
  if (!defaults || JSON.stringify(Object.entries(own).sort()) !== JSON.stringify(Object.entries(DEFAULT_FPM).sort())) return own
  const maxChildren = cap === 'unlimited' ? defaults.pool.maxChildren : Math.min(defaults.pool.maxChildren, cap)
  const maxSpareServers = Math.min(defaults.pool.maxSpareServers, maxChildren), startServers = Math.min(defaults.pool.startServers, maxSpareServers)
  return { ...defaults.pool, maxChildren, maxSpareServers, startServers, minSpareServers: Math.min(defaults.pool.minSpareServers, startServers) }
}
export const fpmIniDefaults = (defaults: SvcPhpFpmDefaults | null): edge.FpmIniDefault[] =>
  defaults ? PHP_LOCKABLE_INI.flatMap(key => { const item = defaults.ini[key]; return item ? [{ key, value: item.value, locked: item.locked }] : [] }) : []
