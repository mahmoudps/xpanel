import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { DANGEROUS_FUNCTIONS, fail, PHP_EXCEPTION_FUNCTIONS } from '@xpanel/core'
import type { OsProfile } from '@xpanel/core'
import { securityObservationCommands } from '@xpanel/os'
import { system } from '@xpanel/render'
import { atomicWriteJson, readJsonIfExists, type StateStore } from '@xpanel/state'
import type { AgentExecutor } from './executor.ts'
import { readBans } from './firewall-bans.ts'
import { parseSecPanelAccessPolicy, SEC_PANEL_ACCESS_STATE } from './sec-policy.ts'
import { parseSshFailedLogins } from './services/security-observation.ts'

export const PHP_FUNCTIONS_STATE = 'extended/server/php-functions.json'
export const SSH_AUTOBAN_STATE = 'extended/server/ssh-autoban.json'
export const SSH_AUTOBAN_BANS_STATE = 'extended/server/ssh-autoban-bans.json'
export const SSH_AUTOBAN_UNBANS_STATE = 'extended/server/ssh-autoban-unbans.json'
export const SSH_AUTOBAN_FAILURES_STATE = 'extended/server/ssh-autoban-failures.json'

export const SSH_AUTOBAN_LIMITS = {
  maxFailures: 500,
  maxWindowMin: 1440,
  maxBanMin: 10080,
  unbanRetentionMs: 86_400_000,
} as const

export interface SshAutobanPolicy {
  enabled: boolean
  failures: number
  windowMin: number
  banMin: number
}

export interface SshAutobanBanEntry {
  address: string
  since: string | null
  until: string | null
  reason: string
  jail: string
}

export const DEFAULT_SSH_AUTOBAN_POLICY: SshAutobanPolicy = {
  enabled: false,
  failures: 5,
  windowMin: 10,
  banMin: 60,
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const boundedInt = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : null
const isoOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null
const validIso = (value: unknown): boolean =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

async function readStateFile(rootDir: string, relPath: string, label: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(join(rootDir, relPath), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return fail('PRECONDITION_FAILED', `saved ${label} is unreadable; review it before reconciliation`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return fail('PRECONDITION_FAILED', `saved ${label} is invalid; review it before reconciliation`)
  }
}

/** Reads saved global PHP disabled-function policy (`undefined` when absent). */
export async function readGlobalPhpDisabledFunctions(rootDir: string): Promise<readonly string[] | undefined> {
  const raw = await readStateFile(rootDir, PHP_FUNCTIONS_STATE, 'PHP function policy')
  if (raw === null) return undefined
  if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.disabled) || !validIso(raw.updatedAt)) {
    return fail('PRECONDITION_FAILED', 'saved PHP function policy is invalid; review it before reconciliation')
  }
  const seen = new Set<string>()
  for (const item of raw.disabled) {
    if (typeof item !== 'string' || !(PHP_EXCEPTION_FUNCTIONS as readonly string[]).includes(item) || seen.has(item)) {
      return fail('PRECONDITION_FAILED', 'saved PHP function policy contains an unsupported function name')
    }
    seen.add(item)
  }
  return DANGEROUS_FUNCTIONS.filter(fn => seen.has(fn))
}

/** Reads saved SSH auto-ban rule (`DEFAULT_SSH_AUTOBAN_POLICY` when absent). */
export async function readSshAutobanPolicy(rootDir: string): Promise<SshAutobanPolicy> {
  const raw = await readStateFile(rootDir, SSH_AUTOBAN_STATE, 'SSH auto-ban policy')
  if (raw === null) return { ...DEFAULT_SSH_AUTOBAN_POLICY }
  if (!object(raw) || raw.version !== 1 || typeof raw.enabled !== 'boolean' || !validIso(raw.updatedAt)) {
    return fail('PRECONDITION_FAILED', 'saved SSH auto-ban policy is invalid; review it before reconciliation')
  }
  const failures = boundedInt(raw.failures, 1, SSH_AUTOBAN_LIMITS.maxFailures)
  const windowMin = boundedInt(raw.windowMin, 1, SSH_AUTOBAN_LIMITS.maxWindowMin)
  const banMin = boundedInt(raw.banMin, 1, SSH_AUTOBAN_LIMITS.maxBanMin)
  if (failures === null || windowMin === null || banMin === null) {
    return fail('PRECONDITION_FAILED', 'saved SSH auto-ban policy thresholds are out of range')
  }
  return { enabled: raw.enabled, failures, windowMin, banMin }
}

/** Reads unexpired panel-managed SSH ban records from disk. */
export async function readActiveSshAutobanBans(rootDir: string, now: Date = new Date()): Promise<SshAutobanBanEntry[]> {
  let raw: unknown
  try {
    raw = await readJsonIfExists<unknown>(join(rootDir, SSH_AUTOBAN_BANS_STATE))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const nowMs = now.getTime()
  const entries: SshAutobanBanEntry[] = []
  for (const item of raw) {
    if (!object(item) || typeof item.address !== 'string' || isIP(item.address) === 0) continue
    const until = isoOrNull(item.until)
    if (until !== null && Date.parse(until) <= nowMs) continue
    const jail = typeof item.jail === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.jail) ? item.jail : 'sshd'
    const reason = typeof item.reason === 'string' && item.reason.length <= 128 && !/[\u0000-\u001f\u007f]/.test(item.reason) ? item.reason : 'sshd'
    entries.push({ address: item.address, since: isoOrNull(item.since), until, reason, jail })
    if (entries.length >= 500) break
  }
  return entries
}

/** Converts active SSH auto-ban records into nftables rule-generation bans. */
export function toFirewallBans(entries: readonly Pick<SshAutobanBanEntry, 'address' | 'until'>[], now: Date = new Date()): system.FirewallBan[] {
  const nowSec = Math.floor(now.getTime() / 1000)
  const out: system.FirewallBan[] = []
  for (const entry of entries) {
    if (!entry.until) continue
    const expiresAt = Math.floor(Date.parse(entry.until) / 1000)
    if (Number.isSafeInteger(expiresAt) && expiresAt > nowSec) {
      out.push({ ip: entry.address, expiresAt })
    }
  }
  return out
}

async function readAllowlistedCidrs(rootDir: string): Promise<string[]> {
  try {
    const raw = await readJsonIfExists<unknown>(join(rootDir, SEC_PANEL_ACCESS_STATE))
    if (!object(raw) || raw.version !== 1 || !object(raw.policy)) return []
    return parseSecPanelAccessPolicy(raw.policy).listeners.xwhm.map(entry => entry.cidr)
  } catch {
    return []
  }
}

async function withWriterLock<T>(
  getWriterLock: StateStore['getWriterLock'] | undefined,
  fn: (fence?: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (!getWriterLock) return fn()
  const lease = await getWriterLock().acquire()
  try {
    await lease.assertFencingToken()
    return await fn(async () => { await lease.assertFencingToken() })
  } finally {
    await lease.release()
  }
}

function readTimestampMap(source: unknown, minMs: number, maxMs: number): Record<string, number> {
  const out: Record<string, number> = {}
  if (!object(source)) return out
  for (const [address, at] of Object.entries(source)) {
    if (isIP(address) === 0 || typeof at !== 'string' || at.length > 40) continue
    const ms = Date.parse(at)
    if (Number.isFinite(ms) && ms >= minMs && ms <= maxMs) out[address] = ms
  }
  return out
}

function formatBoundedTimestampMap(entries: Readonly<Record<string, number>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).sort((a, b) => b[1] - a[1]).slice(0, 1000).map(([address, ms]) => [address, new Date(ms).toISOString()]),
  )
}

async function readUnbanState(rootDir: string, nowMs: number): Promise<{ cutoffs: Record<string, number>; consumed: Record<string, number> }> {
  let raw: unknown
  try {
    raw = await readJsonIfExists<unknown>(join(rootDir, SSH_AUTOBAN_UNBANS_STATE))
  } catch {
    return { cutoffs: {}, consumed: {} }
  }
  if (!object(raw) || raw.version !== 1) return { cutoffs: {}, consumed: {} }
  const minMs = nowMs - SSH_AUTOBAN_LIMITS.unbanRetentionMs
  const maxMs = nowMs + 300_000
  return {
    cutoffs: readTimestampMap(raw.cutoffs, minMs, maxMs),
    consumed: readTimestampMap(raw.consumed, minMs, maxMs),
  }
}

async function writeMergedUnbanState(
  rootDir: string,
  updates: { cutoffs?: Readonly<Record<string, number>>; consumed?: Readonly<Record<string, number>> },
  now: Date,
  fence?: () => Promise<void>,
): Promise<void> {
  const nowMs = now.getTime()
  const prior = await readUnbanState(rootDir, nowMs)
  const cutoffs = { ...prior.cutoffs }
  for (const [address, ms] of Object.entries(updates.cutoffs ?? {})) {
    if (isIP(address) !== 0 && Number.isFinite(ms)) cutoffs[address] = Math.max(cutoffs[address] ?? -Infinity, ms)
  }
  const consumed = { ...prior.consumed }
  for (const [address, ms] of Object.entries(updates.consumed ?? {})) {
    if (isIP(address) !== 0 && Number.isFinite(ms)) consumed[address] = Math.max(consumed[address] ?? -Infinity, ms)
  }
  const formattedConsumed = formatBoundedTimestampMap(consumed)
  await atomicWriteJson(
    join(rootDir, SSH_AUTOBAN_UNBANS_STATE),
    {
      version: 1,
      cutoffs: formatBoundedTimestampMap(cutoffs),
      ...(Object.keys(formattedConsumed).length ? { consumed: formattedConsumed } : {}),
    },
    0o640,
    fence,
  )
}

function normalizeFailureEvents(
  source: unknown,
  minMs: number,
  maxMs: number,
): Record<string, number[]> {
  if (!object(source)) return {}
  const collected: Array<[string, number[]]> = []
  for (const [address, rawList] of Object.entries(source)) {
    if (isIP(address) === 0 || !Array.isArray(rawList)) continue
    const uniq = new Set<number>()
    for (const ms of rawList) {
      if (typeof ms === 'number' && Number.isSafeInteger(ms) && ms >= minMs && ms <= maxMs) uniq.add(ms)
    }
    if (uniq.size === 0) continue
    const sorted = [...uniq].sort((a, b) => a - b).slice(-SSH_AUTOBAN_LIMITS.maxFailures)
    collected.push([address, sorted])
  }
  collected.sort((a, b) => (b[1].at(-1) ?? 0) - (a[1].at(-1) ?? 0))
  return Object.fromEntries(collected.slice(0, 1000))
}

async function readAccumulatedFailures(rootDir: string, nowMs: number): Promise<Record<string, number[]>> {
  let raw: unknown
  try {
    raw = await readJsonIfExists<unknown>(join(rootDir, SSH_AUTOBAN_FAILURES_STATE))
  } catch {
    return {}
  }
  if (!object(raw) || raw.version !== 1) return {}
  return normalizeFailureEvents(raw.events, nowMs - SSH_AUTOBAN_LIMITS.unbanRetentionMs, nowMs + 300_000)
}

async function writeAccumulatedFailures(
  rootDir: string,
  events: Readonly<Record<string, number[]>>,
  nowMs: number,
  fence?: () => Promise<void>,
): Promise<void> {
  const normalized = normalizeFailureEvents(events, nowMs - SSH_AUTOBAN_LIMITS.unbanRetentionMs, nowMs + 300_000)
  await atomicWriteJson(join(rootDir, SSH_AUTOBAN_FAILURES_STATE), { version: 1, events: normalized }, 0o640, fence)
}

/** Removes manually unbanned addresses from persisted SSH auto-ban state and records their failure cutoffs. */
export async function clearPersistedSshAutobanBans(
  rootDir: string,
  addresses: readonly string[],
  now: Date = new Date(),
  getWriterLock?: StateStore['getWriterLock'],
): Promise<void> {
  const targets = [...new Set(addresses.filter(ip => isIP(ip) !== 0))]
  if (targets.length === 0) return
  const targetSet = new Set(targets)
  const nowMs = now.getTime()
  await withWriterLock(getWriterLock, async fence => {
    const rawBans = await readJsonIfExists<unknown>(join(rootDir, SSH_AUTOBAN_BANS_STATE)).catch(() => null)
    if (Array.isArray(rawBans)) {
      const nextBans = rawBans.filter(item => !object(item) || typeof item.address !== 'string' || !targetSet.has(item.address))
      if (nextBans.length !== rawBans.length) {
        await atomicWriteJson(join(rootDir, SSH_AUTOBAN_BANS_STATE), nextBans, 0o640, fence)
      }
    }
    const cutoffs = Object.fromEntries(targets.map(ip => [ip, nowMs]))
    await writeMergedUnbanState(rootDir, { cutoffs }, now, fence)
    const rawFailures = await readJsonIfExists<unknown>(join(rootDir, SSH_AUTOBAN_FAILURES_STATE)).catch(() => null)
    if (object(rawFailures) && rawFailures.version === 1 && object(rawFailures.events)) {
      const remaining = { ...rawFailures.events }
      let removed = false
      for (const ip of targets) {
        if (Object.hasOwn(remaining, ip)) {
          delete remaining[ip]
          removed = true
        }
      }
      if (removed) await writeAccumulatedFailures(rootDir, remaining as Record<string, number[]>, nowMs, fence)
    }
  })
}

export interface EnforceSshAutobanInput {
  rootDir: string
  executor: Pick<AgentExecutor, 'runCommand'>
  os: Pick<OsProfile, 'family' | 'paths' | 'services'>
  getWriterLock?: StateStore['getWriterLock']
  now?: () => Date
}

export interface EnforceSshAutobanResult {
  enabled: boolean
  banned: string[]
  unbanned: string[]
}

/**
 * Applies the saved SSH auto-ban rule (`extended/server/ssh-autoban.json`) on the host:
 * evaluates trusted sshd failures via `banDecisions` into `xpanel_banned`/`xpanel_banned6`
 * when enabled, and clears panel-managed SSH bans when disabled.
 */
export async function enforceSshAutoban(input: EnforceSshAutobanInput): Promise<EnforceSshAutobanResult> {
  const nowDate = (input.now ?? (() => new Date()))()
  const passStartedMs = nowDate.getTime()
  const nowSec = Math.floor(passStartedMs / 1000)
  const policy = await readSshAutobanPolicy(input.rootDir)
  const run = (argv: string[]) => input.executor.runCommand(argv)
  const prior = await readActiveSshAutobanBans(input.rootDir, nowDate)

  if (!policy.enabled) {
    if (prior.length === 0) return { enabled: false, banned: [], unbanned: [] }
    const liveBefore = await readBans(run, () => nowDate)
    const liveSet = new Set(liveBefore.bans.map(item => item.address))
    const toRemove = prior.map(item => item.address).filter(address => liveSet.has(address))
    for (const action of system.unbanSetActions(toRemove)) {
      if (action.kind === 'exec') await run([...action.argv]).catch(() => null)
    }
    const liveAfter = toRemove.length > 0 ? await readBans(run, () => nowDate) : liveBefore
    const stillSet = liveAfter.state === 'read' ? new Set(liveAfter.bans.map(item => item.address)) : new Set<string>()
    const retained = liveAfter.state === 'read' ? prior.filter(item => stillSet.has(item.address)) : prior
    const unbanned = prior.map(item => item.address).filter(addr => !retained.some(r => r.address === addr))
    if (unbanned.length > 0) {
      const unbannedSet = new Set(unbanned)
      await withWriterLock(input.getWriterLock, async fence => {
        const freshBans = await readActiveSshAutobanBans(input.rootDir, nowDate)
        const nextBans = freshBans.filter(item => !unbannedSet.has(item.address))
        await atomicWriteJson(join(input.rootDir, SSH_AUTOBAN_BANS_STATE), nextBans, 0o640, fence)
        const cutoffs = Object.fromEntries(unbanned.map(address => [address, passStartedMs]))
        await writeMergedUnbanState(input.rootDir, { cutoffs }, nowDate, fence)
        const priorEvents = await readAccumulatedFailures(input.rootDir, passStartedMs)
        const remainingEvents = { ...priorEvents }
        let removedFailure = false
        for (const address of unbanned) {
          if (Object.hasOwn(remainingEvents, address)) {
            delete remainingEvents[address]
            removedFailure = true
          }
        }
        if (removedFailure) await writeAccumulatedFailures(input.rootDir, remainingEvents, passStartedMs, fence)
      })
    }
    return { enabled: false, banned: [], unbanned }
  }

  const commands = securityObservationCommands(input.os as never, '24h')
  const journal = await run(commands.failures)
  if (!journal.ok) return { enabled: true, banned: [], unbanned: [] }

  const rawFailures = parseSshFailedLogins(journal.stdout, commands.unit)
  const [unbanState, priorAccumulated] = await Promise.all([
    readUnbanState(input.rootDir, passStartedMs),
    readAccumulatedFailures(input.rootDir, passStartedMs),
  ])
  const minEventMs = passStartedMs - SSH_AUTOBAN_LIMITS.unbanRetentionMs
  const maxEventMs = passStartedMs + 300_000
  const eventsByIp = new Map<string, Set<number>>()
  const recordFailureMs = (address: string, ms: number): void => {
    if (isIP(address) === 0 || !Number.isSafeInteger(ms) || ms < minEventMs || ms > maxEventMs) return
    const cutoffMs = Math.max(
      unbanState.cutoffs[address] ?? -Infinity,
      unbanState.consumed[address] ?? -Infinity,
    )
    if (ms <= cutoffMs) return
    let set = eventsByIp.get(address)
    if (!set) {
      set = new Set<number>()
      eventsByIp.set(address, set)
    }
    set.add(ms)
  }
  for (const [address, list] of Object.entries(priorAccumulated)) {
    for (const ms of list) recordFailureMs(address, ms)
  }
  for (const item of rawFailures) {
    const ms = Date.parse(item.at)
    if (Number.isFinite(ms)) recordFailureMs(item.address, ms)
  }

  const normalizedEvents: Record<string, number[]> = {}
  const authFailures: system.AuthFailure[] = []
  const latestFailureMsByIp = new Map<string, number>()
  for (const [address, set] of eventsByIp) {
    const sorted = [...set].sort((a, b) => a - b).slice(-SSH_AUTOBAN_LIMITS.maxFailures)
    if (sorted.length === 0) continue
    normalizedEvents[address] = sorted
    latestFailureMsByIp.set(address, sorted.at(-1)!)
    const family: 4 | 6 = address.includes(':') ? 6 : 4
    for (const ms of sorted) {
      authFailures.push({ at: Math.floor(ms / 1000), ip: address, family, user: '', kind: 'failed-password', port: null })
    }
  }

  const live = await readBans(run, () => nowDate)
  const alreadyBanned = [...new Set([...prior.map(item => item.address), ...live.bans.map(item => item.address)])]
  const allowlist = await readAllowlistedCidrs(input.rootDir)
  const decisions = system.banDecisions(authFailures, {
    threshold: policy.failures,
    windowSec: policy.windowMin * 60,
    now: nowSec,
    allowlist,
    alreadyBanned,
  })
  if (decisions.length === 0) {
    if (Object.keys(normalizedEvents).length > 0 || Object.keys(priorAccumulated).length > 0) {
      await withWriterLock(input.getWriterLock, async fence => {
        const freshAccumulated = await readAccumulatedFailures(input.rootDir, passStartedMs)
        const freshUnbans = await readUnbanState(input.rootDir, passStartedMs)
        const mergedEvents: Record<string, number[]> = {}
        for (const [address, list] of Object.entries({ ...freshAccumulated })) {
          const cutoff = Math.max(freshUnbans.cutoffs[address] ?? -Infinity, freshUnbans.consumed[address] ?? -Infinity)
          const kept = new Set<number>([...(normalizedEvents[address] ?? []), ...list].filter(ms => ms > cutoff))
          if (kept.size > 0) mergedEvents[address] = [...kept].sort((a, b) => a - b)
        }
        for (const [address, list] of Object.entries(normalizedEvents)) {
          if (Object.hasOwn(mergedEvents, address)) continue
          const cutoff = Math.max(freshUnbans.cutoffs[address] ?? -Infinity, freshUnbans.consumed[address] ?? -Infinity)
          const kept = list.filter(ms => ms > cutoff)
          if (kept.length > 0) mergedEvents[address] = kept
        }
        if (JSON.stringify(mergedEvents) !== JSON.stringify(freshAccumulated)) {
          await writeAccumulatedFailures(input.rootDir, mergedEvents, passStartedMs, fence)
        }
      })
    }
    return { enabled: true, banned: [], unbanned: [] }
  }

  const banSec = policy.banMin * 60
  const addedIps: string[] = []
  for (const decision of decisions) {
    const actions = system.banSetActions([decision.ip], banSec)
    let ok = true
    for (const action of actions) {
      if (action.kind !== 'exec') continue
      const res = await run([...action.argv]).catch(() => ({ ok: false, stdout: '', stderr: '' }))
      if (!res.ok) ok = false
    }
    if (ok) addedIps.push(decision.ip)
  }

  let persistedIps: string[] = []
  const concurrentlyUnbanned: string[] = []
  if (addedIps.length > 0) {
    const since = nowDate.toISOString()
    const until = new Date(passStartedMs + banSec * 1000).toISOString()
    await withWriterLock(input.getWriterLock, async fence => {
      const freshBans = await readActiveSshAutobanBans(input.rootDir, nowDate)
      const freshState = await readUnbanState(input.rootDir, passStartedMs)
      const keepIps: string[] = []
      for (const ip of addedIps) {
        const cutoff = freshState.cutoffs[ip]
        if (cutoff !== undefined && cutoff >= passStartedMs) concurrentlyUnbanned.push(ip)
        else keepIps.push(ip)
      }
      persistedIps = keepIps
      if (keepIps.length > 0) {
        const keepSet = new Set(keepIps)
        const next = [...freshBans.filter(item => !keepSet.has(item.address)), ...keepIps.map(address => ({
          address, since, until, reason: `ssh-autoban (${policy.failures} failures / ${policy.windowMin}m)`, jail: 'sshd',
        }))]
        await atomicWriteJson(join(input.rootDir, SSH_AUTOBAN_BANS_STATE), next, 0o640, fence)
        const consumed = Object.fromEntries(
          keepIps.map(ip => [ip, Math.min(passStartedMs, latestFailureMsByIp.get(ip) ?? passStartedMs)]),
        )
        await writeMergedUnbanState(input.rootDir, { consumed }, nowDate, fence)
      }
      const freshAccumulated = await readAccumulatedFailures(input.rootDir, passStartedMs)
      const clearedIps = new Set(addedIps)
      const mergedEvents: Record<string, number[]> = {}
      for (const address of new Set([...Object.keys(freshAccumulated), ...Object.keys(normalizedEvents)])) {
        if (clearedIps.has(address)) continue
        const cutoff = Math.max(freshState.cutoffs[address] ?? -Infinity, freshState.consumed[address] ?? -Infinity)
        const kept = [...new Set([...(freshAccumulated[address] ?? []), ...(normalizedEvents[address] ?? [])])].filter(ms => ms > cutoff).sort((a, b) => a - b)
        if (kept.length > 0) mergedEvents[address] = kept
      }
      await writeAccumulatedFailures(input.rootDir, mergedEvents, passStartedMs, fence)
    })
    if (concurrentlyUnbanned.length > 0) {
      for (const action of system.unbanSetActions(concurrentlyUnbanned)) {
        if (action.kind === 'exec') await run([...action.argv]).catch(() => null)
      }
    }
  }
  return { enabled: true, banned: persistedIps, unbanned: [] }
}
