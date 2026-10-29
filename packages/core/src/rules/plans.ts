import type { Limit, Plan, PlanCapKey, Principal, Reseller, ResourceLimits } from '../types.ts'
import { fail } from '../errors.ts'
import { assertFits, isUnlimited, limitLte } from '../limits.ts'
import { invalid, isInt, isLimit, isRecord, throwIfErrors } from './check.ts'
import { MAX_DISK_MB } from './quota.ts'

interface FieldRule {
  label: string
  /** smallest finite value that still leaves the account usable */
  min: number
  max: number
}

const MAX = Number.MAX_SAFE_INTEGER
const MIB = 1024 * 1024

export const RESOURCE_RULES: Readonly<Record<keyof ResourceLimits, FieldRule>> = {
  diskMb: { label: 'disk space (MB)', min: 1, max: MAX_DISK_MB },
  bandwidthMbMonth: { label: 'monthly bandwidth (MB)', min: 1, max: MAX },
  ioReadBps: { label: 'I/O read bandwidth (bytes/s)', min: MIB, max: MAX },
  ioWriteBps: { label: 'I/O write bandwidth (bytes/s)', min: MIB, max: MAX },
  ioReadIops: { label: 'I/O read operations/s', min: 10, max: MAX },
  ioWriteIops: { label: 'I/O write operations/s', min: 10, max: MAX },
  memoryMb: { label: 'memory (MB)', min: 64, max: MAX },
  maxProcesses: { label: 'processes', min: 10, max: 4_194_304 },
  cpuPercent: { label: 'CPU (% of one core)', min: 1, max: 100 * 4096 },
}

export const PLAN_CAP_RULES: Readonly<Record<PlanCapKey, FieldRule>> = {
  addonDomains: { label: 'addon domains', min: 0, max: MAX },
  aliasDomains: { label: 'alias domains', min: 0, max: MAX },
  subdomains: { label: 'subdomains', min: 0, max: MAX },
  mailboxes: { label: 'mailboxes', min: 0, max: MAX },
  forwarders: { label: 'forwarders', min: 0, max: MAX },
  mailingLists: { label: 'mailing lists', min: 0, max: MAX },
  ftpAccounts: { label: 'FTP accounts', min: 0, max: MAX },
  databases: { label: 'databases', min: 0, max: MAX },
  phpWorkers: { label: 'PHP workers per domain', min: 1, max: 1024 },
}

export const RESOURCE_KEYS = Object.keys(RESOURCE_RULES) as (keyof ResourceLimits)[]
export const PLAN_CAP_KEYS = Object.keys(PLAN_CAP_RULES) as PlanCapKey[]

const PLAN_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_.-])?$/

/** A conservative finite plan; a fresh object on every call. */
export const defaultPlan = (
  overrides: Partial<Pick<Plan, 'id' | 'name' | 'ownerId' | 'featureListId'>> = {},
): Plan => ({
  id: overrides.id ?? 'default',
  name: overrides.name ?? 'default',
  ownerId: overrides.ownerId ?? null,
  featureListId: overrides.featureListId ?? 'default',
  resources: {
    diskMb: 5120,
    bandwidthMbMonth: 51200,
    ioReadBps: 50 * MIB,
    ioWriteBps: 25 * MIB,
    ioReadIops: 1000,
    ioWriteIops: 500,
    memoryMb: 1024,
    maxProcesses: 100,
    cpuPercent: 100,
  },
  caps: {
    addonDomains: 5,
    aliasDomains: 10,
    subdomains: 25,
    mailboxes: 25,
    forwarders: 50,
    mailingLists: 5,
    ftpAccounts: 5,
    databases: 10,
    phpWorkers: 8,
  },
  dedicatedIp: false,
  shell: 'none',
  defaultMailboxQuotaMb: 1024,
})

const fieldErrors = <K extends string>(
  scope: string,
  rules: Readonly<Record<K, FieldRule>>,
  value: unknown,
): string[] => {
  if (!isRecord(value)) return [`${scope} must be an object`]
  const errors: string[] = []
  for (const key of Object.keys(rules) as K[]) {
    const rule = rules[key]
    const v = value[key]
    if (!isLimit(v)) errors.push(`${scope}.${key} must be a non-negative integer or "unlimited"`)
    else if (!isUnlimited(v) && (v < rule.min || v > rule.max)) {
      errors.push(`${scope}.${key} (${rule.label}) must be between ${rule.min} and ${rule.max}`)
    }
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(rules, key)) errors.push(`${scope}.${key} is not a known field`)
  }
  return errors
}

const PLAN_KEYS: readonly string[] = ['id', 'name', 'ownerId', 'featureListId', 'resources', 'caps', 'dedicatedIp', 'shell', 'defaultMailboxQuotaMb', 'enforceBandwidth']

/** Structural problems only; no authorization. Empty array means the plan is well-formed. */
export const planErrors = (plan: unknown): string[] => {
  if (!isRecord(plan)) return ['plan must be an object']
  const errors = Object.keys(plan).filter((k) => !PLAN_KEYS.includes(k)).map((k) => `${k.slice(0, 64)} is not a known field`)
  if (typeof plan.id !== 'string' || plan.id.length === 0 || plan.id.length > 128) errors.push('id is required')
  if (typeof plan.name !== 'string' || !PLAN_NAME_RE.test(plan.name)) {
    errors.push('name must be 1-64 characters of letters, digits, space, "_", "." or "-"')
  }
  if (plan.ownerId !== null && (typeof plan.ownerId !== 'string' || plan.ownerId.length === 0)) {
    errors.push('ownerId must be a reseller id or null')
  }
  if (typeof plan.featureListId !== 'string' || plan.featureListId.length === 0) errors.push('featureListId is required')
  errors.push(...fieldErrors('resources', RESOURCE_RULES, plan.resources))
  errors.push(...fieldErrors('caps', PLAN_CAP_RULES, plan.caps))
  if (typeof plan.dedicatedIp !== 'boolean') errors.push('dedicatedIp must be a boolean')
  if (plan.enforceBandwidth !== undefined && typeof plan.enforceBandwidth !== 'boolean') errors.push('enforceBandwidth must be a boolean')
  if (plan.shell !== 'none' && plan.shell !== 'jailed') errors.push('shell must be "none" or "jailed"')
  const mq = plan.defaultMailboxQuotaMb
  if (!isLimit(mq, 1) || (!isUnlimited(mq) && mq > MAX_DISK_MB)) {
    errors.push(`defaultMailboxQuotaMb must be an integer between 1 and ${MAX_DISK_MB} or "unlimited"`)
  }
  else if (!isUnlimited(mq) && isRecord(plan.resources) && isLimit(plan.resources.diskMb) && !limitLte(mq, plan.resources.diskMb)) {
    // an unlimited mailbox quota is still bounded by the account's disk quota
    errors.push('defaultMailboxQuotaMb may not exceed the disk quota')
  }
  return errors
}

/** Dotted paths of every field set to unlimited. */
export const unlimitedFields = (plan: Plan): string[] => [
  ...RESOURCE_KEYS.filter((k) => isUnlimited(plan.resources[k])).map((k) => `resources.${k}`),
  ...PLAN_CAP_KEYS.filter((k) => isUnlimited(plan.caps[k])).map((k) => `caps.${k}`),
  ...(isUnlimited(plan.defaultMailboxQuotaMb) ? ['defaultMailboxQuotaMb'] : []),
]

const clonePlan = (p: Plan): Plan => ({
  id: p.id,
  name: p.name,
  ownerId: p.ownerId,
  featureListId: p.featureListId,
  resources: { ...p.resources },
  caps: { ...p.caps },
  dedicatedIp: p.dedicatedIp,
  shell: p.shell,
  defaultMailboxQuotaMb: p.defaultMailboxQuotaMb,
  ...(p.enforceBandwidth !== undefined && { enforceBandwidth: p.enforceBandwidth }),
})

const holdsAcl = (reseller: Reseller, acl: Reseller['acl'][number]): boolean => Array.isArray(reseller.acl) && reseller.acl.includes(acl)

/** Root manages every plan, a reseller only the plans it owns, an account user none. */
export const canManagePlan = (principal: Principal, plan: Pick<Plan, 'ownerId'>): boolean =>
  principal.kind === 'root' || (principal.kind === 'reseller' && plan.ownerId !== null && plan.ownerId === principal.id)

/** NOT_FOUND rather than FORBIDDEN so plan ids cannot be probed across owners. Call it on the stored plan before an edit. */
export const assertCanManagePlan = (principal: Principal, plan: Pick<Plan, 'id' | 'ownerId'>): void => {
  if (!canManagePlan(principal, plan)) fail('NOT_FOUND', 'plan not found', { planId: plan.id })
}

/**
 * Validates a plan someone is creating or editing. Users never manage plans. A reseller
 * needs `manage-plans`, may only own the plan itself, and needs `allow-unlimited-plans`
 * before any field may be unlimited. `reseller` must be the acting reseller's record.
 * This only sees the submitted plan: on an edit, check the stored one with assertCanManagePlan.
 */
export const validatePlan = (plan: Plan, principal: Principal, reseller?: Reseller | null): Plan => {
  const kind: unknown = isRecord(principal) ? principal.kind : undefined
  if (kind !== 'root' && kind !== 'reseller') return fail('FORBIDDEN', 'only root and resellers manage plans')
  if (!isRecord(plan)) return invalid('plan must be an object')
  if (principal.kind === 'reseller') {
    if (!reseller || reseller.id !== principal.id) return fail('FORBIDDEN', 'reseller record does not match the acting principal')
    if (!holdsAcl(reseller, 'manage-plans')) return fail('FORBIDDEN', 'reseller lacks the manage-plans privilege', { acl: 'manage-plans' })
    if (plan.ownerId !== reseller.id) return fail('FORBIDDEN', 'resellers may only manage plans they own')
  }
  throwIfErrors('plan', planErrors(plan))
  if (principal.kind === 'reseller' && !holdsAcl(reseller!, 'allow-unlimited-plans')) {
    const unlimited = unlimitedFields(plan)
    if (unlimited.length > 0) {
      return fail('FORBIDDEN', `reseller may not create unlimited resources: ${unlimited.join(', ')}`, { unlimited, acl: 'allow-unlimited-plans' })
    }
  }
  return clonePlan(plan)
}

export type CapCounts = Partial<Record<PlanCapKey, number>>

/**
 * Throws LIMIT_EXCEEDED when creating `adding` more of `key` would break the plan cap.
 * The current count is required: a missing count fails closed instead of reading as 0.
 */
export const assertCapAvailable = (plan: Plan, counts: CapCounts, key: PlanCapKey, adding = 1): void => {
  if (!Object.hasOwn(PLAN_CAP_RULES, key)) invalid(`unknown plan cap "${String(key)}"`)
  const used = counts[key]
  if (!isInt(used)) invalid(`current ${PLAN_CAP_RULES[key].label} count is required`, { key })
  if (!isInt(adding, 1)) invalid('adding must be a positive integer', { adding })
  if (!isLimit(plan.caps?.[key])) invalid(`plan cap ${key} is malformed`, { key })
  assertFits(PLAN_CAP_RULES[key].label, plan.caps[key], used as number, adding)
}

export interface PlanUsage {
  /** current counts; for `phpWorkers` the highest pm.max_children any domain uses */
  caps: CapCounts
  diskMb?: number
  bandwidthMbMonth?: number
}

export interface LimitViolation {
  scope: 'cap' | 'resource'
  key: string
  label: string
  used: number
  limit: number
}

export interface LimitReduction {
  scope: 'cap' | 'resource' | 'mailbox'
  key: string
  label: string
  from: Limit
  to: Limit
}

export interface PlanImpact {
  /** usage the new plan is already below; the change is a downgrade the operator must confirm */
  violations: LimitViolation[]
  /** every limit that gets smaller (including unlimited to finite) */
  reductions: LimitReduction[]
  losesDedicatedIp: boolean
  losesShell: boolean
}

const reduced = (from: Limit, to: Limit): boolean => !limitLte(from, to)

// Only the fields the comparison reads: a stored row with a non-limit value must not compare as a string.
const limitShapeErrors = (scope: string, plan: unknown): string[] => {
  if (!isRecord(plan) || !isRecord(plan.resources) || !isRecord(plan.caps)) return [`${scope} must be a plan with resources and caps`]
  const { resources, caps } = plan
  return [
    ...RESOURCE_KEYS.filter((k) => !isLimit(resources[k])).map((k) => `${scope}.resources.${k} is malformed`),
    ...PLAN_CAP_KEYS.filter((k) => !isLimit(caps[k])).map((k) => `${scope}.caps.${k} is malformed`),
    ...(isLimit(plan.defaultMailboxQuotaMb) ? [] : [`${scope}.defaultMailboxQuotaMb is malformed`]),
    ...(typeof plan.dedicatedIp === 'boolean' ? [] : [`${scope}.dedicatedIp is malformed`]),
    ...(plan.shell === 'none' || plan.shell === 'jailed' ? [] : [`${scope}.shell is malformed`]),
  ]
}

/** What switching an account from `oldPlan` to `newPlan` does to its current usage. */
export const changePlanImpact = (oldPlan: Plan, newPlan: Plan, usage: PlanUsage): PlanImpact => {
  throwIfErrors('plan change', [...limitShapeErrors('oldPlan', oldPlan), ...limitShapeErrors('newPlan', newPlan)])
  if (!isRecord(usage) || !isRecord(usage.caps)) invalid('usage.caps must be an object of current counts')
  const violations: LimitViolation[] = []
  const reductions: LimitReduction[] = []
  for (const key of PLAN_CAP_KEYS) {
    const label = PLAN_CAP_RULES[key].label
    const limit = newPlan.caps[key]
    const used = usage.caps[key]
    if (used !== undefined) {
      if (!isInt(used)) invalid(`usage.caps.${key} must be a non-negative integer`)
      if (!isUnlimited(limit) && used > limit) violations.push({ scope: 'cap', key, label, used, limit })
    }
    if (reduced(oldPlan.caps[key], limit)) reductions.push({ scope: 'cap', key, label, from: oldPlan.caps[key], to: limit })
  }
  for (const key of RESOURCE_KEYS) {
    const label = RESOURCE_RULES[key].label
    const limit = newPlan.resources[key]
    const used = key === 'diskMb' ? usage.diskMb : key === 'bandwidthMbMonth' ? usage.bandwidthMbMonth : undefined
    if (used !== undefined) {
      if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) invalid(`usage.${key} must be a non-negative number`)
      if (!isUnlimited(limit) && used > limit) violations.push({ scope: 'resource', key, label, used, limit })
    }
    if (reduced(oldPlan.resources[key], limit)) {
      reductions.push({ scope: 'resource', key, label, from: oldPlan.resources[key], to: limit })
    }
  }
  if (reduced(oldPlan.defaultMailboxQuotaMb, newPlan.defaultMailboxQuotaMb)) {
    reductions.push({
      scope: 'mailbox',
      key: 'defaultMailboxQuotaMb',
      label: 'default mailbox quota (MB)',
      from: oldPlan.defaultMailboxQuotaMb,
      to: newPlan.defaultMailboxQuotaMb,
    })
  }
  return {
    violations,
    reductions,
    losesDedicatedIp: oldPlan.dedicatedIp && !newPlan.dedicatedIp,
    losesShell: oldPlan.shell !== 'none' && newPlan.shell === 'none',
  }
}

export const planCapLabel = (key: PlanCapKey): string => PLAN_CAP_RULES[key].label

