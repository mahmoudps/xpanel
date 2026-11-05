import { createHash } from 'node:crypto'

/**
 * Canonical identity of the host effects a generation will apply.
 *
 * File checksums identify rendered configuration. Some desired-state changes (databases,
 * quotas, runtime units) only produce host actions, so the reconciler must compare the
 * action list as well; otherwise such a generation looks unchanged and is reported `noop`.
 *
 * This module imports only a Node builtin so its canonicalization is testable with the pinned
 * Node runtime without a workspace install.
 */

export interface HostEffectLike {
  readonly kind: string
  readonly [field: string]: unknown
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]))
  }
  return value
}

/** Stable JSON for one action; object key order never changes the identity. */
export const canonicalHostEffect = (action: HostEffectLike): string => JSON.stringify(canonical(action))

/**
 * SHA-256 over the ordered action list. Order is part of the identity because it is the
 * execution order (timers stop before units, user deletion after quota clearing, and so on).
 */
export const hostEffectsChecksum = (actions: readonly HostEffectLike[]): string =>
  createHash('sha256').update(actions.map(action => canonicalHostEffect(action)).join('\n')).digest('hex')
