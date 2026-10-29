import { system } from '@xpanel/render'
import { SEC_NFT, SEC_NFT_LIST_ARGV } from '../../../packages/os/src/sec-host-command.ts'
import type { ConfigTestResult } from './executor.ts'
import type { SecPresent } from './sec-waf.ts'

export type SecRun = (argv: string[]) => Promise<ConfigTestResult>
export type SecFloodLimit = 'connections' | 'rate' | 'ping'
export interface SecFloodObservation {
  observedAt: string
  state: 'read' | 'not_installed' | 'not_applied' | 'unavailable'
  reason: 'command_failed' | 'malformed_output' | null
  /** rules carrying our flood comment in the live xpanel table, per limit */
  rules: Record<SecFloodLimit, number>
  /** dynamic sets: number of source addresses currently tracked */
  tracked: { set: string; elements: number }[]
}
const LIMITS: readonly SecFloodLimit[] = ['connections', 'rate', 'ping']
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** libnftables-json(5): {"nftables":[{"metainfo":…},{"table":…},{"set":…},{"rule":…}]}, one object key per item. */
export function parseSecNftFlood(stdout: string): Pick<SecFloodObservation, 'rules' | 'tracked'> | null {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 8 * 1024 * 1024) return null
  let doc: unknown
  try { doc = JSON.parse(stdout) } catch { return null }
  if (!object(doc) || !Array.isArray(doc.nftables)) return null
  const rules: Record<SecFloodLimit, number> = { connections: 0, rate: 0, ping: 0 }, tracked: SecFloodObservation['tracked'] = []
  const ours = new Set<string>(Object.values(system.FLOOD_SETS))
  for (const item of doc.nftables) {
    if (!object(item) || Object.keys(item).length !== 1) return null
    const rule = item.rule, set = item.set
    if (object(rule) && rule.table === system.NFT_TABLE && typeof rule.comment === 'string' && rule.comment.startsWith(system.FLOOD_COMMENT_PREFIX)) {
      const limit = rule.comment.slice(system.FLOOD_COMMENT_PREFIX.length).trim()
      if (!(LIMITS as readonly string[]).includes(limit)) return null
      rules[limit as SecFloodLimit]++
    }
    if (object(set) && set.table === system.NFT_TABLE && typeof set.name === 'string' && ours.has(set.name)) {
      if (set.elem !== undefined && (!Array.isArray(set.elem) || set.elem.length > system.BAN_SET_SIZE)) return null
      tracked.push({ set: set.name, elements: Array.isArray(set.elem) ? set.elem.length : 0 })
    }
  }
  return { rules, tracked: tracked.sort((a, b) => a.set.localeCompare(b.set)) }
}

export async function observeSecFlood(input: { run: SecRun; present: SecPresent; now?: () => Date }): Promise<SecFloodObservation> {
  const observedAt = (input.now?.() ?? new Date()).toISOString(), none = { rules: { connections: 0, rate: 0, ping: 0 }, tracked: [] }
  if (await input.present(SEC_NFT, 'file').catch(() => null) === false) return { observedAt, state: 'not_installed', reason: null, ...none }
  let result: ConfigTestResult | null
  try { result = await input.run([...SEC_NFT_LIST_ARGV]) } catch { result = null }
  // nft(8) exits 1 with "No such file or directory" when the table does not exist: the firewall was never applied.
  if (result && result.code !== 0 && /No such file or directory/.test(result.stderr ?? '')) return { observedAt, state: 'not_applied', reason: null, ...none }
  if (!result || !result.ok || result.code !== 0) return { observedAt, state: 'unavailable', reason: 'command_failed', ...none }
  const parsed = parseSecNftFlood(result.stdout)
  return parsed ? { observedAt, state: 'read', reason: null, ...parsed } : { observedAt, state: 'unavailable', reason: 'malformed_output', ...none }
}
