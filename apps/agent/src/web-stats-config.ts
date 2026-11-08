import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'
import { BANDWIDTH_INTERVAL_MAX_MS, BANDWIDTH_INTERVAL_MS } from './metering.ts'
import { WEB_STATS_GENERATORS } from './web-stats-format.ts'
import type { WebStatsGenerator } from './web-stats-format.ts'

/** Statistics Software Configuration and the owners' Metrics Editor choices, below the state root. */
export const WEB_STATS_CONFIG_STATE = 'extended/server/web-stats.json'
export const WEB_STATS_INTERVAL_MAX_HOURS = 168
const USERNAME = /^[a-z][a-z0-9]{0,15}$/

export interface WebStatsPolicy {
  engines: Record<WebStatsGenerator, { available: boolean; byDefault: boolean }>
  /** AWStats reads the account's own ~/tmp/awstats/awstats.conf.include. */
  allowInclude: boolean
  reverseDns: boolean
  /** 'listed' locks every user to the engines named for it in `allowed`. */
  users: 'all' | 'listed'
  allowed: Record<string, WebStatsGenerator[]>
  intervalHours: number
  /** The bandwidth meter's spacing of collections: it reads this value, and no other timer exists. */
  bandwidthIntervalMinutes: number
  /** UTC hours in which no scheduled run starts. */
  blackoutHours: number[]
  avoidBackups: boolean
}
export interface WebStatsConfig {
  policy: WebStatsPolicy
  /** Metrics Editor: account id to site to the engines the owner keeps on. */
  choices: Record<string, Record<string, WebStatsGenerator[]>>
  /** Reseller id to the engines it holds on (true) or off (false) for its own accounts. */
  resellerLocks: Record<string, WebStatsLocks>
}
export type WebStatsLocks = Partial<Record<WebStatsGenerator, boolean>>
interface StatsAccount { id: string; username: string; ownerId?: string | null }
const BANDWIDTH_STEP_MINUTES = BANDWIDTH_INTERVAL_MS / 60_000, BANDWIDTH_MAX_MINUTES = BANDWIDTH_INTERVAL_MAX_MS / 60_000

// A backup and a statistics run on one vCPU would compete for the same disk, so they stay apart unless root decides otherwise.
export const defaultWebStatsPolicy = (): WebStatsPolicy => ({ engines: { analog: { available: true, byDefault: true }, awstats: { available: true, byDefault: true }, webalizer: { available: true, byDefault: true } }, allowInclude: false, reverseDns: false,
  users: 'all', allowed: {}, intervalHours: 24, bandwidthIntervalMinutes: BANDWIDTH_STEP_MINUTES, blackoutHours: [], avoidBackups: true })

const unchanged = { stateChanged: false }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const engineList = (v: unknown): v is WebStatsGenerator[] => Array.isArray(v) && new Set(v).size === v.length && v.every(e => (WEB_STATS_GENERATORS as readonly unknown[]).includes(e))
const hour = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23

/** The whole policy or a VALIDATION failure naming the field; nothing is coerced. */
export function validateWebStatsPolicy(raw: unknown): WebStatsPolicy {
  const refuse = (field: string, message: string): never => fail('VALIDATION', message, { ...unchanged, field })
  if (!object(raw)) return refuse('policy', 'a statistics policy object is required')
  const known = new Set(['engines', 'allowInclude', 'reverseDns', 'users', 'allowed', 'intervalHours', 'bandwidthIntervalMinutes', 'blackoutHours', 'avoidBackups'])
  const extra = Object.keys(raw).find(key => !known.has(key))
  if (extra !== undefined) return refuse(extra.slice(0, 32), 'unknown statistics policy field')
  const { engines, allowInclude, reverseDns, users, allowed, intervalHours, bandwidthIntervalMinutes, blackoutHours, avoidBackups } = raw
  if (!object(engines) || Object.keys(engines).length !== WEB_STATS_GENERATORS.length || !WEB_STATS_GENERATORS.every(engine => { const row = engines[engine]; return object(row) && Object.keys(row).length === 2 && typeof row.available === 'boolean' && typeof row.byDefault === 'boolean' })) return refuse('engines', 'each engine needs available and byDefault switches')
  for (const [field, value] of Object.entries({ allowInclude, reverseDns, avoidBackups })) if (typeof value !== 'boolean') return refuse(field, 'a true or false value is required')
  if (users !== 'all' && users !== 'listed') return refuse('users', 'users must be all or listed')
  if (!object(allowed) || Object.keys(allowed).length > 2000 || !Object.entries(allowed).every(([name, list]) => USERNAME.test(name) && engineList(list))) return refuse('allowed', 'allowed must map account usernames to engines')
  if (typeof intervalHours !== 'number' || !Number.isInteger(intervalHours * 4) || intervalHours < 0.25 || intervalHours > WEB_STATS_INTERVAL_MAX_HOURS) return refuse('intervalHours', `the log processing interval must be a multiple of 0.25 hours, from 0.25 to ${WEB_STATS_INTERVAL_MAX_HOURS}`)
  if (typeof bandwidthIntervalMinutes !== 'number' || !Number.isInteger(bandwidthIntervalMinutes / BANDWIDTH_STEP_MINUTES) || bandwidthIntervalMinutes < BANDWIDTH_STEP_MINUTES || bandwidthIntervalMinutes > BANDWIDTH_MAX_MINUTES) return refuse('bandwidthIntervalMinutes', `the bandwidth interval is a multiple of ${BANDWIDTH_STEP_MINUTES} minutes, up to ${BANDWIDTH_MAX_MINUTES}`)
  if (!Array.isArray(blackoutHours) || !blackoutHours.every(hour) || new Set(blackoutHours).size !== blackoutHours.length || blackoutHours.length > 23) return refuse('blackoutHours', 'blackout hours must be distinct hours from 0 to 23 and leave one hour free')
  return raw as unknown as WebStatsPolicy
}

/** A reseller's locks, each engine held on or off; nothing is coerced. */
export function validateWebStatsLocks(raw: unknown): WebStatsLocks {
  if (!object(raw) || !Object.entries(raw).every(([engine, on]) => (WEB_STATS_GENERATORS as readonly string[]).includes(engine) && typeof on === 'boolean')) return fail('VALIDATION', 'locks map statistics engines to true or false', unchanged)
  return raw as WebStatsLocks
}

/** The saved file, the defaults when nothing is saved, or null when it needs review: a run never guesses. */
export function parseWebStatsConfig(raw: unknown): WebStatsConfig | null {
  if (raw === null) return { policy: defaultWebStatsPolicy(), choices: {}, resellerLocks: {} }
  if (!object(raw) || !object(raw.choices) || !object(raw.resellerLocks)) return null
  try { validateWebStatsPolicy(raw.policy); Object.values(raw.resellerLocks).forEach(validateWebStatsLocks) } catch { return null }
  for (const sites of Object.values(raw.choices)) if (!object(sites) || !Object.values(sites).every(engineList)) return null
  return raw as unknown as WebStatsConfig
}
export const webStatsRevision = (raw: unknown): string => createHash('sha256').update('xpanel-web-stats\0' + JSON.stringify(raw)).digest('hex')

const locksOf = (config: WebStatsConfig, account: StatsAccount): WebStatsLocks => account.ownerId ? config.resellerLocks[account.ownerId] ?? {} : {}
/** Engines this user may switch for its sites: root offers them, and the owning reseller has not locked them. */
export const choosableEngines = (config: WebStatsConfig, account: StatsAccount): WebStatsGenerator[] => {
  const { policy } = config, locks = locksOf(config, account)
  return WEB_STATS_GENERATORS.filter(engine => policy.engines[engine].available && locks[engine] === undefined && (policy.users === 'all' || policy.allowed[account.username]?.includes(engine) === true))
}
/** A lock outranks the owner's choice and the default, and root's availability outranks a lock; a saved choice counts only for engines the user may still choose. */
export const selectedEngines = (config: WebStatsConfig, account: StatsAccount, site: string): WebStatsGenerator[] => {
  const choice = config.choices[account.id]?.[site], choosable = choosableEngines(config, account), locks = locksOf(config, account)
  return WEB_STATS_GENERATORS.filter(engine => config.policy.engines[engine].available && (locks[engine] ?? (choice && choosable.includes(engine) ? choice.includes(engine) : config.policy.engines[engine].byDefault)))
}
/** A scheduled run waits out a blackout hour or a backup; the 15 minute tick then starts it at the first allowed moment. */
export const statsRunDue = (policy: WebStatsPolicy, lastRunAt: string | null, now: Date, backupBusy: boolean): boolean =>
  !policy.blackoutHours.includes(now.getUTCHours()) && !(policy.avoidBackups && backupBusy) && (lastRunAt === null || now.getTime() - Date.parse(lastRunAt) >= policy.intervalHours * 3_600_000)
