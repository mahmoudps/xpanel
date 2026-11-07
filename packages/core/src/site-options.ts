// Per-site web settings beyond the site type: what the edge, the backend and PHP honour for one site.
// Each key is stored only when it differs from the default, so an unconfigured site renders as before.
import { fail } from './errors.ts'
import { hasControlChars, isInt, isRecord } from './rules/check.ts'
import { assertEmail } from './schemas.ts'

/** Requests for these extensions at or below the directory get 403. */
export interface SiteDenyRule { name: string; directory: string; extensions: string[] }
/** A null limit is off; at least one limit is set. */
export interface SiteTraffic { siteConnections: number | null; ipConnections: number | null; rateKbPerConnection: number | null }
export interface SiteExpiryReminder { address: string; days: number }

export interface SiteOptions {
  /** subfolder of the document root the site serves, e.g. `public` */
  runDirectory?: string
  /** PHP of this site reaches only its own document root and the account tmp */
  isolated?: true
  /** requests are counted but the visitor's address, URL, referrer and agent are not recorded */
  visitorLogOff?: true
  denyRules?: SiteDenyRule[]
  traffic?: SiteTraffic
  /** one line shown on the stopped page */
  stoppedMessage?: string
  /** the owner stopped the site; a stop by an administrator stays theirs to lift */
  stoppedByOwner?: true
  expiryReminder?: SiteExpiryReminder
  /** free label for grouping sites in the server list */
  category?: string
}

export const SITE_DENY_RULES_MAX = 20
export const SITE_STOPPED_MESSAGE_MAX = 1000
const NAME = /^[A-Za-z0-9_-]{1,32}$/
const SEGMENT = '[A-Za-z0-9_-][A-Za-z0-9._~-]*'
const RUN_DIRECTORY = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`)
const DENY_DIRECTORY = new RegExp(`^/(?:${SEGMENT}(?:/${SEGMENT})*)?$`)
const EXTENSION = /^[a-z0-9]{1,16}$/
const CATEGORY = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,31}$/u

const refuse = (field: string, message: string): never => fail('VALIDATION', message, { stateChanged: false, fields: [{ field, code: 'invalid' }] })
const limit = (field: string, value: unknown, max: number): number | null =>
  value === null ? null : isInt(value, 1, max) ? value : refuse(field, `${field} must be off or between 1 and ${max}`)

const denyRule = (value: unknown): SiteDenyRule => {
  if (!isRecord(value) || Object.keys(value).sort().join() !== 'directory,extensions,name') return refuse('denyRules', 'a deny rule takes name, directory and extensions')
  const { name, directory, extensions } = value
  if (typeof name !== 'string' || !NAME.test(name)) return refuse('denyRules.name', 'a rule name uses letters, digits, "-" and "_"')
  if (typeof directory !== 'string' || directory.length > 256 || !DENY_DIRECTORY.test(directory)) return refuse('denyRules.directory', 'a directory is a site path such as /uploads')
  if (!Array.isArray(extensions) || !extensions.length || extensions.length > 16) return refuse('denyRules.extensions', 'a rule lists 1 to 16 extensions')
  const lowered = extensions.map(item => typeof item === 'string' ? item.toLowerCase() : '')
  if (lowered.some(item => !EXTENSION.test(item))) return refuse('denyRules.extensions', 'an extension uses letters and digits only')
  return { name, directory, extensions: [...new Set(lowered)] }
}

const traffic = (value: unknown): SiteTraffic => {
  if (!isRecord(value) || Object.keys(value).sort().join() !== 'ipConnections,rateKbPerConnection,siteConnections') return refuse('traffic', 'traffic control takes siteConnections, ipConnections and rateKbPerConnection')
  const out = { siteConnections: limit('siteConnections', value.siteConnections, 1_000_000), ipConnections: limit('ipConnections', value.ipConnections, 100_000), rateKbPerConnection: limit('rateKbPerConnection', value.rateKbPerConnection, 10_485_760) }
  return Object.values(out).some(item => item !== null) ? out : refuse('traffic', 'set at least one limit, or remove traffic control')
}

const KEYS: readonly (keyof SiteOptions)[] = ['runDirectory', 'isolated', 'visitorLogOff', 'denyRules', 'traffic', 'stoppedMessage', 'stoppedByOwner', 'expiryReminder', 'category']

/** Canonical options; refuses anything the renderers could not express safely. */
export const assertSiteOptions = (value: unknown): SiteOptions => {
  if (!isRecord(value) || Object.keys(value).some(key => !KEYS.includes(key as keyof SiteOptions))) return refuse('site', 'unsupported site option')
  const { runDirectory, isolated, visitorLogOff, denyRules, stoppedMessage, stoppedByOwner, expiryReminder, category } = value
  if (runDirectory !== undefined && (typeof runDirectory !== 'string' || runDirectory.length > 128 || !RUN_DIRECTORY.test(runDirectory))) return refuse('runDirectory', 'the run directory is a subfolder of the document root')
  if (denyRules !== undefined && (!Array.isArray(denyRules) || !denyRules.length || denyRules.length > SITE_DENY_RULES_MAX)) return refuse('denyRules', `a site keeps 1 to ${SITE_DENY_RULES_MAX} deny rules`)
  const rules = (denyRules as unknown[] | undefined)?.map(denyRule)
  if (rules && new Set(rules.map(rule => rule.name)).size !== rules.length) return refuse('denyRules.name', 'each deny rule needs its own name')
  if (stoppedMessage !== undefined && (typeof stoppedMessage !== 'string' || !stoppedMessage.trim() || stoppedMessage.length > SITE_STOPPED_MESSAGE_MAX || hasControlChars(stoppedMessage))) return refuse('stoppedMessage', `the stopped page message is one line of up to ${SITE_STOPPED_MESSAGE_MAX} characters`)
  if (category !== undefined && (typeof category !== 'string' || !CATEGORY.test(category))) return refuse('category', 'a category is a short label')
  for (const [key, flag] of [['isolated', isolated], ['visitorLogOff', visitorLogOff], ['stoppedByOwner', stoppedByOwner]] as const) if (flag !== undefined && flag !== true) return refuse(key, `${key} is stored only when true`)
  let reminder: SiteExpiryReminder | undefined
  if (expiryReminder !== undefined) {
    if (!isRecord(expiryReminder) || Object.keys(expiryReminder).sort().join() !== 'address,days' || !isInt(expiryReminder.days, 1, 90)) return refuse('expiryReminder', 'an expiry reminder takes an address and 1 to 90 days')
    try { reminder = { address: assertEmail(expiryReminder.address, 'expiry reminder address'), days: expiryReminder.days } } catch { return refuse('expiryReminder.address', 'the reminder address is not valid') }
  }
  return {
    ...(runDirectory !== undefined && { runDirectory: runDirectory as string }), ...(isolated === true && { isolated }), ...(visitorLogOff === true && { visitorLogOff }),
    ...(rules && { denyRules: rules }), ...(value.traffic !== undefined && { traffic: traffic(value.traffic) }), ...(stoppedMessage !== undefined && { stoppedMessage: stoppedMessage as string }),
    ...(stoppedByOwner === true && { stoppedByOwner }), ...(reminder && { expiryReminder: reminder }), ...(category !== undefined && { category: category as string }),
  }
}

/** The directory the web server serves; the document root stays the site's project root. */
export const servedDocRoot = (domain: { docRoot: string; site?: Pick<SiteOptions, 'runDirectory'> }): string =>
  domain.site?.runDirectory ? `${domain.docRoot}/${domain.site.runDirectory}` : domain.docRoot
