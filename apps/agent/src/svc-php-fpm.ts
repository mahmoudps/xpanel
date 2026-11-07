import { open } from 'node:fs/promises'
import { edge } from '@xpanel/render'

const TAIL_BYTES = 64 * 1024
const POOLS_LISTED = 200
const MAX_CHILDREN_LINE = 'server reached pm.max_children setting'
export interface FpmPoolUse { account: string; version: string; maxChildrenHits: number; lastHit: string | null }
export interface FpmPoolsObservation { observedAt: string; pools: number; poolsAtLimit: number; hits: number; items: FpmPoolUse[]; truncated: boolean }

// php-fpm logs "[07-Nov-2026 10:00:00] WARNING: [pool u] server reached pm.max_children setting (4), consider raising it".
export function countMaxChildren(text: string): { hits: number; last: string | null } {
  let hits = 0, last: string | null = null
  for (const line of text.split('\n')) {
    if (!line.includes(MAX_CHILDREN_LINE)) continue
    hits++
    last = /^\[([^\]]{1,32})\]/.exec(line)?.[1] ?? last
  }
  return { hits, last }
}
export const readLogTail = async (path: string): Promise<string | null> => {
  let handle
  try { handle = await open(path, 'r') } catch { return null }
  try {
    const { size } = await handle.stat(), length = Math.min(size, TAIL_BYTES), buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally { await handle.close() }
}

/** Pool count and how often each pool hit Max Children, from the current FPM error logs (rotated logs are not read). */
export async function observePhpFpmPools(input: { pools: readonly { account: string; version: string }[]; now?: () => Date; tail?: (account: string, version: string) => Promise<string | null> }): Promise<FpmPoolsObservation> {
  const tail = input.tail ?? ((account, version) => readLogTail(edge.fpmErrorLog(account, version)))
  const items: FpmPoolUse[] = []
  for (const { account, version } of input.pools) {
    const { hits, last } = countMaxChildren(await tail(account, version) ?? '')
    items.push({ account, version, maxChildrenHits: hits, lastHit: last })
  }
  items.sort((left, right) => right.maxChildrenHits - left.maxChildrenHits || left.account.localeCompare(right.account))
  return { observedAt: (input.now?.() ?? new Date()).toISOString(), pools: items.length, poolsAtLimit: items.filter(item => item.maxChildrenHits > 0).length, hits: items.reduce((sum, item) => sum + item.maxChildrenHits, 0), items: items.slice(0, POOLS_LISTED), truncated: items.length > POOLS_LISTED }
}
