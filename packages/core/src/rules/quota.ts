// Upload gate. Filesystem quotas apply when the disk supports them; the panel refuses
// uploads past the plan cap either way.
import type { Limit } from '../types.ts'
import { fail } from '../errors.ts'
import { isUnlimited } from '../limits.ts'
import { invalid, isInt, isLimit } from './check.ts'

export const BYTES_PER_MB = 1024 * 1024
/** Largest finite disk cap (8 PiB): its byte count is still an exact JavaScript integer. */
export const MAX_DISK_MB = Math.floor(Number.MAX_SAFE_INTEGER / BYTES_PER_MB)

const assertBytes = (what: string, v: unknown): number => {
  if (!isInt(v)) return invalid(`${what} must be a non-negative integer number of bytes`, { [what]: typeof v === 'number' ? v : String(v) })
  return v
}

const assertDiskLimit = (diskMb: unknown): Limit => {
  if (!isLimit(diskMb) || (!isUnlimited(diskMb) && diskMb > MAX_DISK_MB)) {
    return invalid(`disk limit must be an integer of MB between 0 and ${MAX_DISK_MB}, or "unlimited"`)
  }
  return diskMb
}

export const quotaBytes = (diskMb: Limit): number | null => {
  const limit = assertDiskLimit(diskMb)
  return isUnlimited(limit) ? null : limit * BYTES_PER_MB
}

/** Bytes still free under the cap (never negative); null when unlimited. */
export const remainingBytes = (usedBytes: number, diskMb: Limit): number | null => {
  const used = assertBytes('usedBytes', usedBytes)
  const cap = quotaBytes(diskMb)
  return cap === null ? null : Math.max(0, cap - used)
}

/** LIMIT_EXCEEDED when `used + incoming` would pass the cap. Exactly reaching it is allowed. */
export const assertUploadWithinQuota = (usedBytes: number, incomingBytes: number, diskMb: Limit): void => {
  const used = assertBytes('usedBytes', usedBytes)
  const incoming = assertBytes('incomingBytes', incomingBytes)
  const cap = quotaBytes(diskMb)
  if (cap === null) return
  // the sum of two safe integers can pass 2^53, where doubles stop counting single bytes
  if (BigInt(used) + BigInt(incoming) > BigInt(cap)) {
    fail('LIMIT_EXCEEDED', `upload of ${incoming} bytes exceeds the disk quota (${used} of ${cap} bytes used)`, {
      what: 'disk',
      usedBytes: used,
      incomingBytes: incoming,
      limitBytes: cap,
      remainingBytes: Math.max(0, cap - used),
    })
  }
}

/**
 * Usage as a percentage with two decimals, not clamped (an over-quota account reads above
 * 100). Null for unlimited. A zero cap reads 0 when empty and 100 otherwise.
 */
export const usagePercent = (usedBytes: number, diskMb: Limit): number | null => {
  const used = assertBytes('usedBytes', usedBytes)
  const cap = quotaBytes(diskMb)
  if (cap === null) return null
  if (cap === 0) return used === 0 ? 0 : 100
  return Math.round((used / cap) * 10000) / 100
}
