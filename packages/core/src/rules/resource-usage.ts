/** Values share one resource and base unit. Only an explicit literal removes a cap. */
export type ResourceQuantity = number | 'unlimited'
export type ResourceThreshold = 'ok' | 'warn' | 'critical'

export interface ResourceQuantityState {
  readonly value: ResourceQuantity | null
  readonly availability: 'known' | 'missing' | 'invalid'
}

interface ResourceUsageParts {
  readonly used: ResourceQuantityState
  readonly limit: ResourceQuantityState
}

export type ResourceUsage = ResourceUsageParts & (
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unlimited' }
  | { readonly kind: 'unbounded-allocation'; readonly threshold: 'critical' }
  | { readonly kind: 'zero-limit'; readonly exceeded: boolean }
  | {
      readonly kind: 'bounded'
      readonly usedValue: number
      readonly limitValue: number
      /** Null only when the mathematical ratio exceeds finite number representation. */
      readonly percent: number | null
      readonly fillPercent: number
      readonly threshold: ResourceThreshold
    }
)

const quantityState = (input: unknown): ResourceQuantityState => {
  if (input === undefined || input === null) return { value: null, availability: 'missing' }
  if (input === 'unlimited') return { value: input, availability: 'known' }
  if (typeof input === 'number' && Number.isFinite(input) && input >= 0 && input <= Number.MAX_SAFE_INTEGER) {
    return { value: Object.is(input, -0) ? 0 : input, availability: 'known' }
  }
  return { value: null, availability: 'invalid' }
}

/**
 * Classifies utilization without assigning meaning to unknown data or inventing a denominator.
 * This describes supplied values; it does not attest their origin or enforcement on a host.
 */
export const resolveResourceUsage = (usedInput: unknown, limitInput: unknown): ResourceUsage => {
  const used = quantityState(usedInput), limit = quantityState(limitInput)
  const parts = { used, limit }
  if (used.availability !== 'known' || limit.availability !== 'known') return { ...parts, kind: 'unavailable' }
  if (limit.value === 'unlimited') return { ...parts, kind: 'unlimited' }
  if (used.value === 'unlimited') return { ...parts, kind: 'unbounded-allocation', threshold: 'critical' }
  // Known numeric parts are narrowed explicitly; missing values never become zero.
  if (typeof used.value !== 'number' || typeof limit.value !== 'number') return { ...parts, kind: 'unavailable' }
  if (limit.value === 0) return { ...parts, kind: 'zero-limit', exceeded: used.value > 0 }
  const ratio = used.value / limit.value
  const percent = ratio * 100
  return {
    ...parts,
    kind: 'bounded',
    usedValue: used.value,
    limitValue: limit.value,
    percent: Number.isFinite(percent) ? percent : null,
    fillPercent: Math.min(100, ratio * 100),
    threshold: ratio >= 0.95 ? 'critical' : ratio >= 0.8 ? 'warn' : 'ok',
  }
}
