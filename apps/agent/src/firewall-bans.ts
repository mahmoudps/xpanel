import { fail, formatCidr, parseIp } from '@xpanel/core'
import { system } from '@xpanel/render'

/**
 * Live ban sets (xpanel_banned / xpanel_banned6): entries with a timeout, filled by SSH auto-ban
 * and the security advisor. They are host state, not a config generation; an unban removes the
 * element and a fresh read proves it is gone.
 */
export type BanRun = (argv: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>
export interface BanEntry { address: string; timeoutSec: number | null; expiresSec: number | null }
export interface BanObservation { state: 'read' | 'unavailable'; bans: BanEntry[]; observedAt: string }

const SETS = [system.BAN_SET_V4, system.BAN_SET_V6] as const
export const banListArgv = (set: string): string[] => [system.NFT_BINARY, '-j', 'list', 'set', 'inet', system.NFT_TABLE, set]
const MAX_BANS = 10000
const canonical = (value: string): string => { const ip = parseIp(value)!; return formatCidr({ ...ip, prefix: ip.version === 4 ? 32 : 128 }) }

/** Parses `nft -j list set`; elements are bare addresses or { elem: { val, timeout, expires } }. */
export function parseBanSet(stdout: string): BanEntry[] {
  const doc = JSON.parse(stdout) as { nftables?: unknown[] }
  if (!doc || !Array.isArray(doc.nftables)) throw new Error('invalid_ban_set')
  const set = doc.nftables.map(item => (item as { set?: { elem?: unknown[] } }).set).find(Boolean)
  if (!set) throw new Error('invalid_ban_set')
  const out: BanEntry[] = []
  for (const raw of set.elem ?? []) {
    const elem = typeof raw === 'string' ? { val: raw } : (raw as { elem?: { val?: unknown; timeout?: unknown; expires?: unknown } }).elem
    const ip = parseIp(elem?.val)
    if (!elem || !ip) throw new Error('invalid_ban_set')
    const seconds = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
    out.push({ address: canonical(String(elem.val)), timeoutSec: seconds(elem.timeout), expiresSec: seconds(elem.expires) })
    if (out.length > MAX_BANS) throw new Error('invalid_ban_set')
  }
  return out
}

export async function readBans(run: BanRun, now: () => Date = () => new Date()): Promise<BanObservation> {
  const observedAt = now().toISOString()
  const bans: BanEntry[] = []
  for (const set of SETS) {
    const result = await run(banListArgv(set)).catch(() => ({ ok: false, stdout: '', stderr: '' }))
    if (!result.ok) return { state: 'unavailable', bans: [], observedAt }
    try { bans.push(...parseBanSet(result.stdout)) } catch { return { state: 'unavailable', bans: [], observedAt } }
  }
  return { state: 'read', bans: bans.sort((a, b) => a.address.localeCompare(b.address)), observedAt }
}

/** Removes addresses that a fresh read shows banned; the re-read decides the outcome per address. */
export async function unbanAddresses(run: BanRun, addresses: unknown, now?: () => Date): Promise<{ unbanned: string[]; stillBanned: string[]; after: BanObservation }> {
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 64 || addresses.some(item => typeof item !== 'string' || !parseIp(item))) return fail('VALIDATION', '1 to 64 IP addresses are required', { stateChanged: false })
  const wanted = [...new Set((addresses as string[]).map(canonical))]
  const before = await readBans(run, now)
  if (before.state !== 'read') return fail('PRECONDITION_FAILED', 'the live ban sets could not be read; nothing was unbanned', { stateChanged: false })
  const banned = new Set(before.bans.map(item => item.address))
  const missing = wanted.filter(address => !banned.has(address))
  if (missing.length) return fail('CONFLICT', 'these addresses are not banned now; reload before retrying', { stateChanged: false, missing: missing.slice(0, 16) })
  for (const action of system.unbanSetActions(wanted)) if (action.kind === 'exec') await run([...action.argv]).catch(() => null)
  const after = await readBans(run, now)
  const still = new Set(after.bans.map(item => item.address))
  if (after.state !== 'read') return fail('SERVICE_UNAVAILABLE', 'the unban result could not be read back', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  return { unbanned: wanted.filter(address => !still.has(address)), stillBanned: wanted.filter(address => still.has(address)), after }
}
