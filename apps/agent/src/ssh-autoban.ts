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

async function writeStateJson(rootDir: string, relPath: string, value: unknown, getWriterLock?: StateStore['getWriterLock']): Promise<void> {
  const path = join(rootDir, relPath)
  if (!getWriterLock) {
    await atomicWriteJson(path, value, 0o640)
    return
  }
  const lease = await getWriterLock().acquire()
  try {
    await lease.assertFencingToken()
    await atomicWriteJson(path, value, 0o640, async () => { await lease.assertFencingToken() })
  } finally {
    await lease.release()
  }
}

async function readManualUnbanCutoffs(rootDir: string, nowMs: number): Promise<Record<string, number>> {
  let raw: unknown
  try {
    raw = await readJsonIfExists<unknown>(join(rootDir, SSH_AUTOBAN_UNBANS_STATE))
  } catch {
    return {}
  }
  if (!object(raw) || raw.version !== 1 || !object(raw.cutoffs)) return {}
  const minMs = nowMs - SSH_AUTOBAN_LIMITS.unbanRetentionMs
  const maxMs = nowMs + 300_000
  const cutoffs: Record<string, number> = {}
  for (const [address, at] of Object.entries(raw.cutoffs)) {
    if (isIP(address) === 0 || typeof at !== 'string' || at.length > 40) continue
    const ms = Date.parse(at)
    if (Number.isFinite(ms) && ms >= minMs && ms <= maxMs) cutoffs[address] = ms
  }
  return cutoffs
}

async function recordUnbanCutoffs(rootDir: string, addresses: readonly string[], now: Date, getWriterLock?: StateStore['getWriterLock']): Promise<void> {
  if (addresses.length === 0) return
  const nowMs = now.getTime()
  const prior = await readManualUnbanCutoffs(rootDir, nowMs)
  const entries = new Map<string, number>(Object.entries(prior))
  for (const address of addresses) {
    if (isIP(address) !== 0) entries.set(address, nowMs)
  }
  const bounded = [...entries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1000)
  const cutoffs = Object.fromEntries(bounded.map(([address, ms]) => [address, new Date(ms).toISOString()]))
  await writeStateJson(rootDir, SSH_AUTOBAN_UNBANS_STATE, { version: 1, cutoffs }, getWriterLock)
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
  const nowSec = Math.floor(nowDate.getTime() / 1000)
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
    if (retained.length !== prior.length) {
      await writeStateJson(input.rootDir, SSH_AUTOBAN_BANS_STATE, retained, input.getWriterLock)
      await recordUnbanCutoffs(input.rootDir, unbanned, nowDate, input.getWriterLock)
    }
    return { enabled: false, banned: [], unbanned }
  }

  const commands = securityObservationCommands(input.os as never, '24h')
  const journal = await run(commands.failures)
  if (!journal.ok) return { enabled: true, banned: [], unbanned: [] }

  const rawFailures = parseSshFailedLogins(journal.stdout, commands.unit)
  const unbanCutoffs = await readManualUnbanCutoffs(input.rootDir, nowDate.getTime())
  const authFailures: system.AuthFailure[] = []
  for (const item of rawFailures) {
    const ms = Date.parse(item.at)
    if (!Number.isFinite(ms)) continue
    const cutoffMs = unbanCutoffs[item.address]
    if (cutoffMs !== undefined && ms <= cutoffMs) continue
    const family: 4 | 6 = item.address.includes(':') ? 6 : 4
    authFailures.push({ at: Math.floor(ms / 1000), ip: item.address, family, user: item.username, kind: 'failed-password', port: null })
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
  if (decisions.length === 0) return { enabled: true, banned: [], unbanned: [] }

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

  if (addedIps.length > 0) {
    const since = nowDate.toISOString()
    const until = new Date(nowDate.getTime() + banSec * 1000).toISOString()
    const next = [...prior.filter(item => !addedIps.includes(item.address)), ...addedIps.map(address => ({
      address, since, until, reason: `ssh-autoban (${policy.failures} failures / ${policy.windowMin}m)`, jail: 'sshd',
    }))]
    await writeStateJson(input.rootDir, SSH_AUTOBAN_BANS_STATE, next, input.getWriterLock)
  }
  return { enabled: true, banned: addedIps, unbanned: [] }
}
