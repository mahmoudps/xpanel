import { fail } from '../errors.ts'

export const RESOURCE_SAMPLE_INTERVAL_MS = 5_000
export const RESOURCE_LIVE_STALE_AFTER_MS = 15_000

/** An unavailable live numeric chart is never represented by fabricated zero samples. */
export interface CanonicalIoAnalyticsUnavailable {
  readonly available: false
  readonly snapshot: null
  readonly reason: 'not-sampled' | 'paused' | 'stale' | 'configuration-changed' | 'invalid' | 'incomplete'
  readonly fieldReasons: Readonly<Record<string, string>>
  /** Original capture completion time; null when there is no accepted observation. */
  readonly observedAt: string | null
}

/** Protocol budgets only. They are neither measured host capacities nor hosting quotas. */
export const RESOURCE_OBSERVATION_LIMITS = Object.freeze({
  accounts: 10_000,
  cpuIdsPerIdentity: 8_192,
  ioDevicesPerIdentity: 4_096,
  totalArrayEntries: 250_000,
})

export type ResourceUnavailableReason =
  | 'not-sampled' | 'warming-up' | 'counter-reset' | 'missing'
  | 'invalid' | 'unsupported' | 'no-operations' | 'stale'

interface FieldDefinition {
  readonly unit: string
  readonly basis: string
  readonly integer?: true
  readonly maximum?: number
  readonly rate?: 'cpu' | 'io'
  readonly deferred?: true
  readonly latency?: true
}

/** Units and bases are part of the contract, not caller-selected display labels. */
export const RESOURCE_OBSERVATION_FIELDS = {
  host: {
    cpuBusyPercent: { unit: 'percent', basis: 'whole-host-excluding-idle-and-iowait', maximum: 100, rate: 'cpu' },
    memoryUsedBytes: { unit: 'bytes', basis: 'host-memtotal-minus-memavailable', integer: true },
    memoryTotalBytes: { unit: 'bytes', basis: 'host-memtotal', integer: true },
    loadAvg1m: { unit: 'load', basis: 'host-loadavg-1m' },
    ioPressureSomeAvg10: { unit: 'percent', basis: 'host-io-psi-some-avg10', maximum: 100 },
    ioPressureFullAvg10: { unit: 'percent', basis: 'host-io-psi-full-avg10', maximum: 100 },
  },
  account: {
    cpuPercent: { unit: 'percent', basis: 'cgroup-usage-of-one-core', rate: 'cpu' },
    memoryCurrentBytes: { unit: 'bytes', basis: 'cgroup-memory-current', integer: true },
    pidsCurrent: { unit: 'count', basis: 'cgroup-pids-current', integer: true },
    readBytesPerSec: { unit: 'bytes/second', basis: 'cgroup-read-byte-delta', rate: 'io' },
    writeBytesPerSec: { unit: 'bytes/second', basis: 'cgroup-write-byte-delta', rate: 'io' },
    readIops: { unit: 'operations/second', basis: 'cgroup-read-operation-delta', rate: 'io' },
    writeIops: { unit: 'operations/second', basis: 'cgroup-write-operation-delta', rate: 'io' },
  },
  deferred: {
    diskUsedBytes: { unit: 'bytes', basis: 'disk-provider-not-integrated', integer: true, deferred: true },
    bandwidthBytesPerSec: { unit: 'bytes/second', basis: 'bandwidth-provider-not-integrated', deferred: true },
    mailboxUsedBytes: { unit: 'bytes', basis: 'mail-provider-not-integrated', integer: true, deferred: true },
    aggregateAwaitMs: { unit: 'milliseconds', basis: 'device-latency-provider-not-integrated', deferred: true, latency: true },
  },
} as const satisfies Record<string, Record<string, FieldDefinition>>

type FieldUnavailableReason<D extends FieldDefinition> =
  | Exclude<ResourceUnavailableReason, 'warming-up' | 'counter-reset' | 'no-operations'>
  | (D extends { rate: 'cpu' | 'io' } ? 'warming-up' | 'counter-reset' : never)
  | (D extends { latency: true } ? 'no-operations' : never)

type FieldObservation<D extends FieldDefinition> = {
  readonly unit: D['unit']
  readonly basis: D['basis']
} & (
  | (D extends { deferred: true } ? never : { readonly value: number; readonly availability: 'known' })
  | { readonly value: null; readonly availability: FieldUnavailableReason<D> }
)

type FieldSet<D extends Record<string, FieldDefinition>> = { readonly [K in keyof D]: FieldObservation<D[K]> }
export type HostResourceFields = FieldSet<typeof RESOURCE_OBSERVATION_FIELDS.host>
export type AccountResourceFields = FieldSet<typeof RESOURCE_OBSERVATION_FIELDS.account>
export type DeferredResourceFields = FieldSet<typeof RESOURCE_OBSERVATION_FIELDS.deferred>

/** Internal evidence only. These identifiers confer neither authority nor provenance. */
export interface ResourceSourceIdentity {
  readonly bootId: string | null
  readonly onlineCpuIds: readonly number[] | null
  readonly cgroup: { readonly device: string; readonly inode: string } | null
  readonly ioDevices: readonly string[] | null
}

export interface ResourceReadSpan {
  readonly startedMonotonicUs: number
  readonly finishedMonotonicUs: number
}

/** The actual interval is never replaced with the configured 5-second cadence. */
export interface ResourceRateBaseline {
  readonly producerEpoch: string
  readonly monotonicUs: number
  readonly identity: ResourceSourceIdentity
}

interface ResourceSubject {
  readonly readSpan: ResourceReadSpan
  readonly identity: ResourceSourceIdentity
  readonly previous: ResourceRateBaseline | null
}

export interface HostResourceObservation extends ResourceSubject {
  readonly fields: HostResourceFields
}

export interface AccountResourceObservation extends ResourceSubject {
  readonly accountId: string
  readonly cgroupAvailability: 'present' | 'missing' | 'unsupported'
  readonly fields: AccountResourceFields
}

export interface ResourceConfigurationBinding {
  /** Digest of the exact desired-state snapshot; not an official/public reference. */
  readonly revision: string
  readonly accountIds: readonly string[]
}

/** An internal full snapshot. A separately authorized public projection is still required. */
export interface ResourceObservationSnapshot {
  readonly version: 1
  readonly observedAt: string
  readonly producer: {
    readonly epoch: string
    readonly sequence: number
    readonly intervalMs: typeof RESOURCE_SAMPLE_INTERVAL_MS
    readonly staleAfterMs: typeof RESOURCE_LIVE_STALE_AFTER_MS
  }
  readonly readSpan: ResourceReadSpan
  readonly configuration: ResourceConfigurationBinding
  readonly host: HostResourceObservation
  readonly accounts: readonly AccountResourceObservation[]
  readonly deferred: DeferredResourceFields
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DIGEST = /^[0-9a-f]{64}$/
const UINT64 = /^(0|[1-9][0-9]{0,19})$/
const DEVICE = /^(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$/
const UNAVAILABLE: readonly ResourceUnavailableReason[] = [
  'not-sampled', 'warming-up', 'counter-reset', 'missing', 'invalid', 'unsupported', 'no-operations', 'stale',
]

const invalid = (path: string): never => fail('VALIDATION', 'invalid resource observation', { path })

/** Only own JSON data is read; accessors, symbols, inherited fields and extra keys are rejected. */
const record = (input: unknown, keys: readonly string[], path: string): Record<string, unknown> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid(path)
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) return invalid(path)
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => {
    const descriptor = descriptors[key]
    return !descriptor || !('value' in descriptor) || !descriptor.enumerable
  })) return invalid(path)
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]))
}

interface ArrayBudget { remaining: number }

const list = (input: unknown, path: string, maximum: number, budget: ArrayBudget): unknown[] => {
  if (!Array.isArray(input)) return invalid(path)
  // Check length and the cumulative budget before descriptor enumeration or copying.
  const length = input.length
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return invalid(`${path}.length`)
  if (length > budget.remaining) return invalid(`${path}.budget`)
  budget.remaining -= length
  if (Object.getPrototypeOf(input) !== Array.prototype) return invalid(path)
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(descriptors).length !== length + 1) return invalid(path)
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid(path)
    return descriptor.value
  })
}

const natural = (input: unknown, path: string, minimum = 0): number => {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum || Object.is(input, -0)) return invalid(path)
  return input
}

const uuid = (input: unknown, path: string): string => {
  if (typeof input !== 'string' || !UUID.test(input)) return invalid(path)
  return input
}

const uint64 = (input: unknown, path: string): string => {
  if (typeof input !== 'string' || !UINT64.test(input) || BigInt(input) > 18_446_744_073_709_551_615n) return invalid(path)
  return input
}

const readSpan = (input: unknown, path: string): ResourceReadSpan => {
  const value = record(input, ['startedMonotonicUs', 'finishedMonotonicUs'], path)
  const startedMonotonicUs = natural(value.startedMonotonicUs, `${path}.startedMonotonicUs`)
  const finishedMonotonicUs = natural(value.finishedMonotonicUs, `${path}.finishedMonotonicUs`)
  if (finishedMonotonicUs < startedMonotonicUs) return invalid(path)
  return { startedMonotonicUs, finishedMonotonicUs }
}

const sourceIdentity = (input: unknown, path: string, budget: ArrayBudget): ResourceSourceIdentity => {
  const value = record(input, ['bootId', 'onlineCpuIds', 'cgroup', 'ioDevices'], path)
  const bootId = value.bootId === null ? null : uuid(value.bootId, `${path}.bootId`)
  let onlineCpuIds: number[] | null = null
  if (value.onlineCpuIds !== null) {
    onlineCpuIds = list(value.onlineCpuIds, `${path}.onlineCpuIds`, RESOURCE_OBSERVATION_LIMITS.cpuIdsPerIdentity, budget)
      .map((id, index) => natural(id, `${path}.onlineCpuIds.${index}`))
    if (onlineCpuIds.length === 0 || onlineCpuIds.some((id, index) => index > 0 && id <= onlineCpuIds![index - 1]!)) {
      return invalid(`${path}.onlineCpuIds`)
    }
  }
  let cgroup: ResourceSourceIdentity['cgroup'] = null
  if (value.cgroup !== null) {
    const group = record(value.cgroup, ['device', 'inode'], `${path}.cgroup`)
    cgroup = { device: uint64(group.device, `${path}.cgroup.device`), inode: uint64(group.inode, `${path}.cgroup.inode`) }
  }
  let ioDevices: string[] | null = null
  if (value.ioDevices !== null) {
    ioDevices = list(value.ioDevices, `${path}.ioDevices`, RESOURCE_OBSERVATION_LIMITS.ioDevicesPerIdentity, budget).map((device, index) => {
      if (typeof device !== 'string' || device.length > 21 || !DEVICE.test(device)) return invalid(`${path}.ioDevices.${index}`)
      const [major, minor] = device.split(':')
      if (BigInt(major!) > 4_294_967_295n || BigInt(minor!) > 4_294_967_295n) return invalid(`${path}.ioDevices.${index}`)
      return device
    })
    if (ioDevices.some((device, index) => index > 0 && device <= ioDevices![index - 1]!)) return invalid(`${path}.ioDevices`)
  }
  return { bootId, onlineCpuIds, cgroup, ioDevices }
}

const baseline = (input: unknown, path: string, budget: ArrayBudget): ResourceRateBaseline | null => {
  if (input === null) return null
  const value = record(input, ['producerEpoch', 'monotonicUs', 'identity'], path)
  return {
    producerEpoch: uuid(value.producerEpoch, `${path}.producerEpoch`),
    monotonicUs: natural(value.monotonicUs, `${path}.monotonicUs`),
    identity: sourceIdentity(value.identity, `${path}.identity`, budget),
  }
}

const field = (input: unknown, definition: FieldDefinition, path: string): unknown => {
  const value = record(input, ['value', 'availability', 'unit', 'basis'], path)
  if (value.unit !== definition.unit || value.basis !== definition.basis) return invalid(path)
  if (value.availability === 'known') {
    if (definition.deferred || typeof value.value !== 'number' || !Number.isFinite(value.value)
      || value.value < 0 || Object.is(value.value, -0)
      || (definition.integer && !Number.isSafeInteger(value.value))
      || (definition.maximum !== undefined && value.value > definition.maximum)) return invalid(path)
  } else {
    if (value.value !== null || !UNAVAILABLE.includes(value.availability as ResourceUnavailableReason)) return invalid(path)
    if (value.availability === 'no-operations' && !definition.latency) return invalid(path)
    if ((value.availability === 'warming-up' || value.availability === 'counter-reset') && !definition.rate) return invalid(path)
  }
  return { value: value.value, availability: value.availability, unit: definition.unit, basis: definition.basis }
}

const fields = <D extends Record<string, FieldDefinition>>(input: unknown, definitions: D, path: string): FieldSet<D> => {
  const value = record(input, Object.keys(definitions), path)
  return Object.fromEntries(Object.entries(definitions).map(([key, definition]) => [key, field(value[key], definition, `${path}.${key}`)])) as FieldSet<D>
}

const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

/** Structural compatibility only; the producer must also detect counter decreases and failed reads. */
export const resourceRateUnavailability = (
  producerEpoch: string, subject: ResourceSubject, kind: 'cpu' | 'io', scope: 'host' | 'account',
): 'warming-up' | 'counter-reset' | 'missing' | 'invalid' | null => {
  const current = subject.identity
  if (current.bootId === null || (kind === 'cpu' && current.onlineCpuIds === null)
    || (scope === 'account' && current.cgroup === null) || (kind === 'io' && current.ioDevices === null)) return 'missing'
  const previous = subject.previous
  if (previous === null) return 'warming-up'
  if (previous.producerEpoch !== producerEpoch || previous.identity.bootId !== current.bootId
    || (scope === 'account' && !equal(previous.identity.cgroup, current.cgroup))
    || (kind === 'cpu' && !equal(previous.identity.onlineCpuIds, current.onlineCpuIds))
    || (kind === 'io' && !equal(previous.identity.ioDevices, current.ioDevices))) return 'counter-reset'
  if (previous.monotonicUs > subject.readSpan.startedMonotonicUs
    || previous.monotonicUs >= subject.readSpan.finishedMonotonicUs) return 'invalid'
  return null
}

const subject = (input: unknown, path: string, account: boolean, budget: ArrayBudget): HostResourceObservation | AccountResourceObservation => {
  const keys = ['readSpan', 'identity', 'previous', 'fields', ...(account ? ['accountId', 'cgroupAvailability'] : [])]
  const value = record(input, keys, path)
  const common = {
    readSpan: readSpan(value.readSpan, `${path}.readSpan`),
    identity: sourceIdentity(value.identity, `${path}.identity`, budget),
    previous: baseline(value.previous, `${path}.previous`, budget),
  }
  if (!account) {
    if (common.identity.cgroup !== null || common.identity.ioDevices !== null
      || common.previous?.identity.cgroup != null || common.previous?.identity.ioDevices != null) return invalid(path)
    return { ...common, fields: fields(value.fields, RESOURCE_OBSERVATION_FIELDS.host, `${path}.fields`) }
  }
  if (!['present', 'missing', 'unsupported'].includes(value.cgroupAvailability as string)) return invalid(`${path}.cgroupAvailability`)
  const present = value.cgroupAvailability === 'present'
  if (present !== (common.identity.cgroup !== null) || (!present && (common.previous !== null || common.identity.ioDevices !== null))) return invalid(path)
  return {
    ...common, accountId: uuid(value.accountId, `${path}.accountId`),
    cgroupAvailability: value.cgroupAvailability as AccountResourceObservation['cgroupAvailability'],
    fields: fields(value.fields, RESOURCE_OBSERVATION_FIELDS.account, `${path}.fields`),
  }
}

const configuration = (input: unknown, path: string, budget: ArrayBudget): ResourceConfigurationBinding => {
  const value = record(input, ['revision', 'accountIds'], path)
  if (typeof value.revision !== 'string' || !DIGEST.test(value.revision)) return invalid(`${path}.revision`)
  const accountIds = list(value.accountIds, `${path}.accountIds`, RESOURCE_OBSERVATION_LIMITS.accounts, budget)
    .map((id, index) => uuid(id, `${path}.accountIds.${index}`))
  if (new Set(accountIds).size !== accountIds.length) return invalid(`${path}.accountIds`)
  return { revision: value.revision, accountIds }
}

const freeze = <T>(input: T): T => {
  if (typeof input === 'object' && input !== null) {
    for (const child of Object.values(input)) freeze(child)
    Object.freeze(input)
  }
  return input
}

const validateSubject = (
  value: HostResourceObservation | AccountResourceObservation, parent: ResourceReadSpan, epoch: string, path: string, scope: 'host' | 'account',
): void => {
  if (value.readSpan.startedMonotonicUs < parent.startedMonotonicUs || value.readSpan.finishedMonotonicUs > parent.finishedMonotonicUs) invalid(`${path}.readSpan`)
  for (const [key, definition] of Object.entries(scope === 'host' ? RESOURCE_OBSERVATION_FIELDS.host : RESOURCE_OBSERVATION_FIELDS.account)) {
    const observation = (value.fields as Record<string, { value: number | null; availability: string }>)[key]!
    if (scope === 'account' && (value as AccountResourceObservation).cgroupAvailability !== 'present') {
      const reason = (value as AccountResourceObservation).cgroupAvailability
      if (observation.availability !== reason || observation.value !== null) invalid(`${path}.fields.${key}`)
    }
    if ('rate' in definition && observation.availability === 'known'
      && resourceRateUnavailability(epoch, value, definition.rate, scope) !== null) invalid(`${path}.fields.${key}`)
    if ('rate' in definition && definition.rate === 'io' && value.identity.ioDevices?.length === 0
      && observation.availability === 'known' && observation.value !== 0) invalid(`${path}.fields.${key}`)
  }
}

/**
 * Strictly validates supplied data, not its kernel origin or the caller's authorization.
 * Historical records retain this original snapshot; no timestamp or number is repaired.
 */
export const parseResourceObservationSnapshot = (input: unknown): ResourceObservationSnapshot => {
  const budget = { remaining: RESOURCE_OBSERVATION_LIMITS.totalArrayEntries }
  const value = record(input, ['version', 'observedAt', 'producer', 'readSpan', 'configuration', 'host', 'accounts', 'deferred'], '$')
  if (value.version !== 1) return invalid('$.version')
  if (typeof value.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt)
    || !Number.isFinite(Date.parse(value.observedAt)) || new Date(value.observedAt).toISOString() !== value.observedAt) return invalid('$.observedAt')
  const producer = record(value.producer, ['epoch', 'sequence', 'intervalMs', 'staleAfterMs'], '$.producer')
  if (producer.intervalMs !== RESOURCE_SAMPLE_INTERVAL_MS || producer.staleAfterMs !== RESOURCE_LIVE_STALE_AFTER_MS) return invalid('$.producer')
  const result: ResourceObservationSnapshot = {
    version: 1, observedAt: value.observedAt,
    producer: { epoch: uuid(producer.epoch, '$.producer.epoch'), sequence: natural(producer.sequence, '$.producer.sequence', 1), intervalMs: RESOURCE_SAMPLE_INTERVAL_MS, staleAfterMs: RESOURCE_LIVE_STALE_AFTER_MS },
    readSpan: readSpan(value.readSpan, '$.readSpan'),
    configuration: configuration(value.configuration, '$.configuration', budget),
    host: subject(value.host, '$.host', false, budget) as HostResourceObservation,
    accounts: list(value.accounts, '$.accounts', RESOURCE_OBSERVATION_LIMITS.accounts, budget)
      .map((account, index) => subject(account, `$.accounts.${index}`, true, budget) as AccountResourceObservation),
    deferred: fields(value.deferred, RESOURCE_OBSERVATION_FIELDS.deferred, '$.deferred'),
  }
  const actualIds = result.accounts.map(account => account.accountId)
  if (new Set(actualIds).size !== actualIds.length || !equal([...actualIds].sort(), [...result.configuration.accountIds].sort())) return invalid('$.accounts')
  let bootId = result.host.identity.bootId
  const currentCgroups = new Set<string>()
  result.accounts.forEach((account, index) => {
    const currentBoot = account.identity.bootId
    if (currentBoot !== null && bootId !== null && currentBoot !== bootId) invalid(`$.accounts.${index}.identity.bootId`)
    if (currentBoot !== null) bootId = currentBoot
    if (account.cgroupAvailability === 'present') {
      const group = account.identity.cgroup!
      const tuple = `${group.device}:${group.inode}`
      if (currentCgroups.has(tuple)) invalid(`$.accounts.${index}.identity.cgroup`)
      currentCgroups.add(tuple)
    }
  })
  validateSubject(result.host, result.readSpan, result.producer.epoch, '$.host', 'host')
  result.accounts.forEach((account, index) => validateSubject(account, result.readSpan, result.producer.epoch, `$.accounts.${index}`, 'account'))
  const memory = result.host.fields
  if (memory.memoryUsedBytes.availability === 'known' && memory.memoryTotalBytes.availability === 'known'
    && memory.memoryUsedBytes.value > memory.memoryTotalBytes.value) return invalid('$.host.fields.memoryUsedBytes')
  return freeze(result)
}

/** Bind a parsed full snapshot to the independently authorized desired-state snapshot. */
export const assertResourceConfigurationBinding = (snapshot: ResourceObservationSnapshot, expected: ResourceConfigurationBinding): void => {
  const binding = configuration(expected, '$.expectedConfiguration', { remaining: RESOURCE_OBSERVATION_LIMITS.totalArrayEntries })
  if (snapshot.configuration.revision !== binding.revision
    || !equal([...snapshot.configuration.accountIds].sort(), [...binding.accountIds].sort())) invalid('$.configuration')
}

export interface LiveResourceObservation {
  /** Fresh only while every subject's original read is younger than 15 seconds. */
  readonly freshness: 'fresh' | 'stale'
  /** Batch-completion age, not each subject's age. Null across incomparable producer epochs. */
  readonly ageMs: number | null
  readonly snapshot: ResourceObservationSnapshot
}

/** A new live view only. Historical known values and the original observation time are immutable. */
export const projectResourceObservationForLive = (
  input: unknown, clock: { readonly producerEpoch: string; readonly monotonicUs: number },
): LiveResourceObservation => {
  const snapshot = parseResourceObservationSnapshot(input)
  const clockValue = record(clock, ['producerEpoch', 'monotonicUs'], '$.clock')
  const epoch = uuid(clockValue.producerEpoch, '$.clock.producerEpoch')
  const now = natural(clockValue.monotonicUs, '$.clock.monotonicUs')
  const sameEpoch = epoch === snapshot.producer.epoch
  if (sameEpoch && now < snapshot.readSpan.finishedMonotonicUs) return invalid('$.clock.monotonicUs')
  const ageMs = sameEpoch ? (now - snapshot.readSpan.finishedMonotonicUs) / 1_000 : null
  const expired = (subject: ResourceSubject): boolean => !sameEpoch
    || now - subject.readSpan.finishedMonotonicUs >= RESOURCE_LIVE_STALE_AFTER_MS * 1_000
  const hostExpired = expired(snapshot.host)
  const accountExpired = snapshot.accounts.map(expired)
  if (!hostExpired && !accountExpired.some(Boolean)) return freeze({ freshness: 'fresh', ageMs, snapshot })
  const staleFields = <T>(inputFields: T): T => Object.fromEntries(Object.entries(inputFields as Record<string, { availability: string }>).map(([key, observation]) => [
    key, observation.availability === 'known' ? { ...observation, value: null, availability: 'stale' } : { ...observation },
  ])) as T
  return freeze({
    freshness: 'stale', ageMs,
    snapshot: {
      ...snapshot,
      host: { ...snapshot.host, fields: hostExpired ? staleFields(snapshot.host.fields) : snapshot.host.fields },
      accounts: snapshot.accounts.map((account, index) => ({ ...account, fields: accountExpired[index] ? staleFields(account.fields) : account.fields })),
      deferred: staleFields(snapshot.deferred),
    },
  })
}

freeze(RESOURCE_OBSERVATION_FIELDS)
