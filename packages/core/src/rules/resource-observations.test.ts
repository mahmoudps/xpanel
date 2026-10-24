import { describe, expect, it, vi } from 'vitest'
import { XpanelError } from '../errors.ts'
import {
  RESOURCE_LIVE_STALE_AFTER_MS, RESOURCE_OBSERVATION_FIELDS, RESOURCE_OBSERVATION_LIMITS, RESOURCE_SAMPLE_INTERVAL_MS,
  assertResourceConfigurationBinding, parseResourceObservationSnapshot,
  projectResourceObservationForLive, resourceRateUnavailability,
} from './resource-observations.ts'

const EPOCH = '11111111-1111-4111-8111-111111111111'
const OTHER_EPOCH = '22222222-2222-4222-8222-222222222222'
const BOOT = '33333333-3333-4333-8333-333333333333'
const OTHER_BOOT = '44444444-4444-4444-8444-444444444444'
const ACCOUNT = '55555555-5555-4555-8555-555555555555'
const MISSING_ACCOUNT = '66666666-6666-4666-8666-666666666666'
const DELETED_ACCOUNT = '77777777-7777-4777-8777-777777777777'
const REVISION = 'a'.repeat(64)

const known = (value: number, unit: string, basis: string) => ({ value, availability: 'known', unit, basis })
const unavailable = (availability: string, unit: string, basis: string) => ({ value: null, availability, unit, basis })
const accountFields = () => ({
  cpuPercent: known(150.125, 'percent', 'cgroup-usage-of-one-core'),
  memoryCurrentBytes: known(4_096, 'bytes', 'cgroup-memory-current'),
  pidsCurrent: known(3, 'count', 'cgroup-pids-current'),
  readBytesPerSec: known(0, 'bytes/second', 'cgroup-read-byte-delta'),
  writeBytesPerSec: known(0.000_000_1, 'bytes/second', 'cgroup-write-byte-delta'),
  readIops: known(0.25, 'operations/second', 'cgroup-read-operation-delta'),
  writeIops: known(0, 'operations/second', 'cgroup-write-operation-delta'),
})

/** Diagnostic inputs only; no fixture is exported or loaded by a production producer. */
const sample = () => {
  const hostIdentity = () => ({ bootId: BOOT, onlineCpuIds: [0, 1, 2, 3], cgroup: null, ioDevices: null })
  const accountIdentity = () => ({
    bootId: BOOT, onlineCpuIds: [0, 1, 2, 3],
    cgroup: { device: '29', inode: '18446744073709551615' }, ioDevices: ['253:0', '8:0'],
  })
  return {
    version: 1,
    observedAt: '2026-10-23T05:30:00.123Z',
    producer: { epoch: EPOCH, sequence: 2, intervalMs: 5_000, staleAfterMs: 15_000 },
    readSpan: { startedMonotonicUs: 10_000_000, finishedMonotonicUs: 10_100_000 },
    configuration: { revision: REVISION, accountIds: [ACCOUNT, MISSING_ACCOUNT] },
    host: {
      readSpan: { startedMonotonicUs: 10_000_000, finishedMonotonicUs: 10_010_000 },
      identity: hostIdentity(),
      previous: { producerEpoch: EPOCH, monotonicUs: 4_000_000, identity: hostIdentity() },
      fields: {
        cpuBusyPercent: known(12.345_678, 'percent', 'whole-host-excluding-idle-and-iowait'),
        memoryUsedBytes: known(1_024, 'bytes', 'host-memtotal-minus-memavailable'),
        memoryTotalBytes: known(8_192, 'bytes', 'host-memtotal'),
        loadAvg1m: known(0, 'load', 'host-loadavg-1m'),
        ioPressureSomeAvg10: known(0, 'percent', 'host-io-psi-some-avg10'),
        ioPressureFullAvg10: unavailable('unsupported', 'percent', 'host-io-psi-full-avg10'),
      },
    },
    accounts: [
      {
        accountId: ACCOUNT, cgroupAvailability: 'present',
        readSpan: { startedMonotonicUs: 10_020_000, finishedMonotonicUs: 10_040_000 },
        identity: accountIdentity(),
        previous: { producerEpoch: EPOCH, monotonicUs: 4_000_000, identity: accountIdentity() },
        fields: accountFields(),
      },
      {
        accountId: MISSING_ACCOUNT, cgroupAvailability: 'missing',
        readSpan: { startedMonotonicUs: 10_050_000, finishedMonotonicUs: 10_060_000 },
        identity: { bootId: BOOT, onlineCpuIds: [0, 1, 2, 3], cgroup: null, ioDevices: null },
        previous: null,
        fields: Object.fromEntries(Object.entries(accountFields()).map(([key, field]) => [key, { ...field, value: null, availability: 'missing' }])),
      },
    ],
    deferred: {
      diskUsedBytes: unavailable('unsupported', 'bytes', 'disk-provider-not-integrated'),
      bandwidthBytesPerSec: unavailable('unsupported', 'bytes/second', 'bandwidth-provider-not-integrated'),
      mailboxUsedBytes: unavailable('unsupported', 'bytes', 'mail-provider-not-integrated'),
      aggregateAwaitMs: unavailable('unsupported', 'milliseconds', 'device-latency-provider-not-integrated'),
    },
  }
}

// Deliberately mutable diagnostic payloads test untrusted values outside their TypeScript types.
type Payload = Record<string, any>
const payload = (): Payload => sample()
const rejects = (value: unknown, expectedPath?: string) => {
  try {
    parseResourceObservationSnapshot(value)
    expect.fail('malformed observation was accepted')
  } catch (error) {
    expect(error).toBeInstanceOf(XpanelError)
    const failure = error as XpanelError
    expect(failure.code).toBe('VALIDATION')
    expect(failure.message).toBe('invalid resource observation')
    if (expectedPath !== undefined) expect(failure.detail.path).toBe(expectedPath)
  }
}
const makeAccountRatesUnavailable = (input: Payload, reason: string) => {
  for (const key of ['cpuPercent', 'readBytesPerSec', 'writeBytesPerSec', 'readIops', 'writeIops']) {
    input.accounts[0].fields[key].value = null
    input.accounts[0].fields[key].availability = reason
  }
}

const diagnosticId = (index: number): string => `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`
const oversizedArray = (length: number) => {
  let enumerations = 0
  const value = new Proxy(new Array(length), { ownKeys() { enumerations++; throw new Error('must refuse before enumeration') } })
  return { value, enumerations: () => enumerations }
}

/** Shared scalar arrays keep diagnostic allocation small while counting every serialized occurrence. */
const budgetSample = (lastCpuCount: number): Payload => {
  const input = payload()
  const cpuIds = Array.from({ length: 8_192 }, (_, index) => index)
  const devices = Array.from({ length: 4_096 }, (_, index) => `8:${index}`).sort()
  const template = input.accounts[0]
  const missing = input.accounts[1]
  input.accounts = Array.from({ length: 10 }, (_, index) => {
    const identity = { ...template.identity, cgroup: { device: '29', inode: String(index + 1) }, onlineCpuIds: cpuIds, ioDevices: devices }
    return { ...template, accountId: diagnosticId(index), identity, previous: { ...template.previous, identity } }
  })
  input.accounts.push({ ...missing, accountId: diagnosticId(10), identity: { ...missing.identity, onlineCpuIds: Array.from({ length: lastCpuCount }, (_, index) => index) } })
  input.configuration.accountIds = input.accounts.map((account: Payload) => account.accountId)
  return input
}

describe('strict resource observation contract', () => {
  it('preserves actual zero, tiny positive rates, fractional IOPS and account CPU above 100 without rounding', () => {
    const input = sample()
    const result = parseResourceObservationSnapshot(input)
    expect(result.accounts[0]!.fields.cpuPercent.value).toBe(150.125)
    expect(result.accounts[0]!.fields.readBytesPerSec).toMatchObject({ value: 0, availability: 'known' })
    expect(result.accounts[0]!.fields.writeBytesPerSec.value).toBe(0.000_000_1)
    expect(result.accounts[0]!.fields.readIops.value).toBe(0.25)
    expect(result.host.fields.cpuBusyPercent.value).toBe(12.345_678)
    expect(result.host.fields.loadAvg1m).toMatchObject({ value: 0, availability: 'known' })
    expect(result.host.fields.ioPressureFullAvg10).toMatchObject({ value: null, availability: 'unsupported' })
    expect(result.accounts[0]!.identity.cgroup!.inode).toBe('18446744073709551615')
    expect(result).toEqual(input)
    expect(result).not.toBe(input)
    expect(result.accounts[0]!.fields).not.toBe(input.accounts[0]!.fields)
  })

  it('retains actual unequal per-subject intervals and non-atomic read spans instead of assuming 5 seconds', () => {
    const result = parseResourceObservationSnapshot(sample())
    expect(RESOURCE_SAMPLE_INTERVAL_MS).toBe(5_000)
    expect(RESOURCE_LIVE_STALE_AFTER_MS).toBe(15_000)
    expect(result.host.readSpan.finishedMonotonicUs - result.host.previous!.monotonicUs).toBe(6_010_000)
    expect(result.accounts[0]!.readSpan.finishedMonotonicUs - result.accounts[0]!.previous!.monotonicUs).toBe(6_040_000)
    expect(result.readSpan.finishedMonotonicUs - result.readSpan.startedMonotonicUs).toBe(100_000)
  })

  it('freezes field definitions so a consumer cannot change the numeric basis or unit', () => {
    expect(Object.isFrozen(RESOURCE_OBSERVATION_FIELDS.account.cpuPercent)).toBe(true)
    expect(() => { (RESOURCE_OBSERVATION_FIELDS.account.cpuPercent as Payload).basis = 'whole-host' }).toThrow(TypeError)
  })

  it.each(['not-sampled', 'warming-up', 'counter-reset', 'missing', 'invalid', 'unsupported', 'stale'])(
    'keeps null availability %s distinct from measured 0', reason => {
      const input = payload()
      input.accounts[0].fields.readBytesPerSec = unavailable(reason, 'bytes/second', 'cgroup-read-byte-delta')
      expect(parseResourceObservationSnapshot(input).accounts[0]!.fields.readBytesPerSec).toMatchObject({ value: null, availability: reason })
    },
  )

  it.each([null, undefined, '0', 'unlimited', false, Number.NaN, Infinity, -Infinity, -1, -0])(
    'rejects a known non-value %j rather than repairing it', value => {
      const input = payload()
      input.accounts[0].fields.readBytesPerSec.value = value
      rejects(input, '$.accounts.0.fields.readBytesPerSec')
    },
  )

  it.each(['missing', 'invalid', 'warming-up', 'counter-reset', 'unsupported', 'stale', 'not-sampled'])(
    'rejects non-null values attached to %s', reason => {
      const input = payload()
      input.accounts[0].fields.readBytesPerSec.availability = reason
      rejects(input, '$.accounts.0.fields.readBytesPerSec')
    },
  )

  it.each(['', 'healthy', 'measured', 'unlimited', 'no-latency-sample', null, 0])('rejects unknown availability %j', reason => {
    const input = payload()
    input.accounts[0].fields.readBytesPerSec = { ...input.accounts[0].fields.readBytesPerSec, value: null, availability: reason }
    rejects(input, '$.accounts.0.fields.readBytesPerSec')
  })

  it.each([
    ['memoryCurrentBytes', 1.5], ['memoryCurrentBytes', Number.MAX_SAFE_INTEGER + 1],
    ['pidsCurrent', 0.1], ['pidsCurrent', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects inexact integer measurement %s=%s', (key, value) => {
    const input = payload()
    input.accounts[0].fields[key].value = value
    rejects(input, `$.accounts.0.fields.${key}`)
  })

  it.each(['cpuBusyPercent', 'ioPressureSomeAvg10', 'ioPressureFullAvg10'])('bounds whole-host percentage %s without clipping', key => {
    const input = payload()
    input.host.fields[key].value = 100.000_001
    input.host.fields[key].availability = 'known'
    rejects(input, `$.host.fields.${key}`)
    input.host.fields[key].value = 100
    expect(parseResourceObservationSnapshot(input).host.fields[key as 'cpuBusyPercent'].value).toBe(100)
  })

  it('cannot substitute the whole-host CPU basis for account CPU or bytes for IOPS', () => {
    const input = payload()
    input.accounts[0].fields.cpuPercent.basis = 'whole-host-excluding-idle-and-iowait'
    rejects(input, '$.accounts.0.fields.cpuPercent')
    input.accounts[0].fields.cpuPercent.basis = 'cgroup-usage-of-one-core'
    input.accounts[0].fields.readIops.unit = 'bytes/second'
    rejects(input, '$.accounts.0.fields.readIops')
  })

  it('rejects host used memory above total without silently clamping', () => {
    const input = payload()
    input.host.fields.memoryUsedBytes.value = 8_193
    rejects(input, '$.host.fields.memoryUsedBytes')
    input.host.fields.memoryTotalBytes = unavailable('missing', 'bytes', 'host-memtotal')
    expect(parseResourceObservationSnapshot(input).host.fields.memoryUsedBytes.value).toBe(8_193)
  })

  it.each(['warming-up', 'counter-reset', 'no-operations'])('rejects rate-only reason %s on absolute memory', reason => {
    const input = payload()
    input.accounts[0].fields.memoryCurrentBytes = unavailable(reason, 'bytes', 'cgroup-memory-current')
    rejects(input, '$.accounts.0.fields.memoryCurrentBytes')
  })

  it('uses no-operations only for unavailable latency and never substitutes 0 ms', () => {
    const input = payload()
    input.deferred.aggregateAwaitMs.availability = 'no-operations'
    expect(parseResourceObservationSnapshot(input).deferred.aggregateAwaitMs).toMatchObject({ value: null, availability: 'no-operations' })
    input.accounts[0].fields.readIops = unavailable('no-operations', 'operations/second', 'cgroup-read-operation-delta')
    rejects(input, '$.accounts.0.fields.readIops')
  })

  it.each(['diskUsedBytes', 'bandwidthBytesPerSec', 'mailboxUsedBytes', 'aggregateAwaitMs'])(
    'cannot promote deferred provider %s to a measured 0', key => {
      const input = payload()
      input.deferred[key].value = 0
      input.deferred[key].availability = 'known'
      rejects(input, `$.deferred.${key}`)
    },
  )
})

describe('identity-bound baselines and complete account membership', () => {
  it('keeps valid absolute readings during first-sample rate warm-up', () => {
    const input = payload()
    input.accounts[0].previous = null
    makeAccountRatesUnavailable(input, 'warming-up')
    const result = parseResourceObservationSnapshot(input)
    expect(result.accounts[0]!.fields.memoryCurrentBytes.value).toBe(4_096)
    expect(result.accounts[0]!.fields.pidsCurrent.value).toBe(3)
    expect(resourceRateUnavailability(EPOCH, result.accounts[0]!, 'cpu', 'account')).toBe('warming-up')
    input.accounts[0].fields.cpuPercent = known(0, 'percent', 'cgroup-usage-of-one-core')
    rejects(input, '$.accounts.0.fields.cpuPercent')
  })

  it.each([
    ['producer restart', (input: Payload) => { input.accounts[0].previous.producerEpoch = OTHER_EPOCH }],
    ['boot change', (input: Payload) => { input.accounts[0].previous.identity.bootId = OTHER_BOOT }],
    ['cgroup recreation', (input: Payload) => { input.accounts[0].previous.identity.cgroup.inode = '123' }],
    ['cgroup filesystem change', (input: Payload) => { input.accounts[0].previous.identity.cgroup.device = '30' }],
  ] as const)('invalidates all rates on %s', (_label, change) => {
    const input = payload()
    change(input)
    rejects(input, '$.accounts.0.fields.cpuPercent')
    makeAccountRatesUnavailable(input, 'counter-reset')
    const result = parseResourceObservationSnapshot(input)
    expect(resourceRateUnavailability(EPOCH, result.accounts[0]!, 'cpu', 'account')).toBe('counter-reset')
    expect(resourceRateUnavailability(EPOCH, result.accounts[0]!, 'io', 'account')).toBe('counter-reset')
    expect(result.accounts[0]!.fields.memoryCurrentBytes.value).toBe(4_096)
  })

  it('invalidates CPU after an online-set change while retaining the independent IO interval', () => {
    const input = payload()
    input.accounts[0].previous.identity.onlineCpuIds = [0, 1]
    rejects(input, '$.accounts.0.fields.cpuPercent')
    input.accounts[0].fields.cpuPercent = unavailable('counter-reset', 'percent', 'cgroup-usage-of-one-core')
    const result = parseResourceObservationSnapshot(input)
    expect(resourceRateUnavailability(EPOCH, result.accounts[0]!, 'cpu', 'account')).toBe('counter-reset')
    expect(resourceRateUnavailability(EPOCH, result.accounts[0]!, 'io', 'account')).toBeNull()
    expect(result.accounts[0]!.fields.readIops).toMatchObject({ value: 0.25, availability: 'known' })
  })

  it('invalidates IO after a device-set change without erasing independent account CPU', () => {
    const input = payload()
    input.accounts[0].previous.identity.ioDevices = ['8:0']
    rejects(input, '$.accounts.0.fields.readBytesPerSec')
    for (const key of ['readBytesPerSec', 'writeBytesPerSec', 'readIops', 'writeIops']) {
      input.accounts[0].fields[key] = { ...input.accounts[0].fields[key], value: null, availability: 'counter-reset' }
    }
    const result = parseResourceObservationSnapshot(input)
    expect(resourceRateUnavailability(EPOCH, result.accounts[0]!, 'io', 'account')).toBe('counter-reset')
    expect(resourceRateUnavailability(EPOCH, result.accounts[0]!, 'cpu', 'account')).toBeNull()
    expect(result.accounts[0]!.fields.cpuPercent.value).toBe(150.125)
  })

  it.each(['bootId', 'onlineCpuIds'])('invalidates whole-host CPU when previous %s changes', key => {
    const input = payload()
    input.host.previous.identity[key] = key === 'bootId' ? OTHER_BOOT : [0, 1]
    rejects(input, '$.host.fields.cpuBusyPercent')
    input.host.fields.cpuBusyPercent = unavailable('counter-reset', 'percent', 'whole-host-excluding-idle-and-iowait')
    const result = parseResourceObservationSnapshot(input)
    expect(resourceRateUnavailability(EPOCH, result.host, 'cpu', 'host')).toBe('counter-reset')
    expect(result.host.fields.memoryUsedBytes.value).toBe(1_024)
  })

  it.each(['bootId', 'onlineCpuIds'])('rejects known CPU without current %s evidence', key => {
    const input = payload()
    input.accounts[0].identity[key] = null
    rejects(input, '$.accounts.0.fields.cpuPercent')
  })

  it('rejects known IO without device identity, while an actually empty observed device set can measure 0', () => {
    const input = payload()
    input.accounts[0].identity.ioDevices = null
    rejects(input, '$.accounts.0.fields.readBytesPerSec')
    input.accounts[0].identity.ioDevices = []
    input.accounts[0].previous.identity.ioDevices = []
    for (const key of ['readBytesPerSec', 'writeBytesPerSec', 'readIops', 'writeIops']) input.accounts[0].fields[key].value = 0
    expect(parseResourceObservationSnapshot(input).accounts[0]!.fields.readIops).toMatchObject({ value: 0, availability: 'known' })
  })

  it('rejects positive IO attributed to an explicitly observed empty device set', () => {
    const input = payload()
    input.accounts[0].identity.ioDevices = []
    input.accounts[0].previous.identity.ioDevices = []
    rejects(input, '$.accounts.0.fields.writeBytesPerSec')
  })

  it('rejects a previous baseline overlapping the current read span instead of fabricating a short interval', () => {
    const input = payload()
    input.accounts[0].previous.monotonicUs = 10_030_000
    rejects(input, '$.accounts.0.fields.cpuPercent')
    makeAccountRatesUnavailable(input, 'invalid')
    const result = parseResourceObservationSnapshot(input)
    expect(resourceRateUnavailability(EPOCH, result.accounts[0]!, 'cpu', 'account')).toBe('invalid')
  })

  it.each([10_040_000, 10_040_001])('rejects known rates for a non-positive interval starting %s', time => {
    const input = payload()
    input.accounts[0].previous.monotonicUs = time
    rejects(input, '$.accounts.0.fields.cpuPercent')
    makeAccountRatesUnavailable(input, 'invalid')
    const result = parseResourceObservationSnapshot(input)
    expect(resourceRateUnavailability(EPOCH, result.accounts[0]!, 'io', 'account')).toBe('invalid')
  })

  it('keeps a configured account whose cgroup disappeared, with all readings unavailable and baselines cleared', () => {
    const result = parseResourceObservationSnapshot(sample())
    const absent = result.accounts.find(account => account.accountId === MISSING_ACCOUNT)!
    expect(absent.cgroupAvailability).toBe('missing')
    expect(absent.previous).toBeNull()
    expect(Object.values(absent.fields).every(field => field.value === null && field.availability === 'missing')).toBe(true)
    const input = payload()
    input.accounts[1].fields.memoryCurrentBytes = known(0, 'bytes', 'cgroup-memory-current')
    rejects(input, '$.accounts.1.fields.memoryCurrentBytes')
  })

  it('rejects a retained baseline after cgroup disappearance', () => {
    const input = payload()
    input.accounts[1].previous = input.accounts[0].previous
    rejects(input, '$.accounts.1')
  })

  it('requires an explicit unsupported state and null readings when the cgroup provider is unsupported', () => {
    const input = payload()
    input.accounts[1].cgroupAvailability = 'unsupported'
    for (const field of Object.values(input.accounts[1].fields) as Payload[]) field.availability = 'unsupported'
    expect(parseResourceObservationSnapshot(input).accounts[1]!.cgroupAvailability).toBe('unsupported')
  })

  it.each(['omitted configured account', 'duplicate row', 'deleted account retained', 'duplicate configured id'])(
    'rejects an incomplete current full snapshot: %s', condition => {
      const input = payload()
      if (condition === 'omitted configured account') input.accounts.pop()
      if (condition === 'duplicate row') input.accounts.push(input.accounts[0])
      if (condition === 'deleted account retained') input.accounts[1].accountId = DELETED_ACCOUNT
      if (condition === 'duplicate configured id') input.configuration.accountIds.push(ACCOUNT)
      rejects(input)
    },
  )

  it('accepts deleted-account removal from the new snapshot while preserving its historical original', () => {
    const historical = parseResourceObservationSnapshot(sample())
    const input = payload()
    input.configuration.revision = 'b'.repeat(64)
    input.configuration.accountIds.pop()
    input.accounts.pop()
    input.producer.sequence++
    const current = parseResourceObservationSnapshot(input)
    expect(current.accounts.map(account => account.accountId)).toEqual([ACCOUNT])
    expect(historical.accounts.map(account => account.accountId)).toEqual([ACCOUNT, MISSING_ACCOUNT])
    expect(historical.configuration.revision).toBe(REVISION)
  })

  it('binds to an independent configuration revision and exact account set without allocating public references', () => {
    const result = parseResourceObservationSnapshot(sample())
    expect(() => assertResourceConfigurationBinding(result, { revision: REVISION, accountIds: [MISSING_ACCOUNT, ACCOUNT] })).not.toThrow()
    expect(() => assertResourceConfigurationBinding(result, { revision: 'b'.repeat(64), accountIds: [ACCOUNT, MISSING_ACCOUNT] })).toThrow(XpanelError)
    expect(() => assertResourceConfigurationBinding(result, { revision: REVISION, accountIds: [ACCOUNT] })).toThrow(XpanelError)
    expect(result).not.toHaveProperty('publicReference')
    expect(result).not.toHaveProperty('verified')
  })
})

describe('strict structure and time validation', () => {
  it.each([
    ['version', (input: Payload) => { input.version = 2 }],
    ['extra field', (input: Payload) => { input.healthy = true }],
    ['missing field', (input: Payload) => { delete input.host.fields.loadAvg1m }],
    ['host scope pollution', (input: Payload) => { input.host.identity.cgroup = { device: '1', inode: '2' } }],
    ['interval cadence', (input: Payload) => { input.producer.intervalMs = 1_000 }],
    ['freshness extension', (input: Payload) => { input.producer.staleAfterMs = 60_000 }],
    ['sequence 0', (input: Payload) => { input.producer.sequence = 0 }],
    ['inexact sequence', (input: Payload) => { input.producer.sequence = Number.MAX_SAFE_INTEGER + 1 }],
    ['backwards read span', (input: Payload) => { input.readSpan.startedMonotonicUs = 10_100_001 }],
    ['subject read outside span', (input: Payload) => { input.accounts[0].readSpan.finishedMonotonicUs = 10_100_001 }],
    ['negative clock', (input: Payload) => { input.host.readSpan.startedMonotonicUs = -1 }],
    ['fractional clock', (input: Payload) => { input.host.previous.monotonicUs = 0.5 }],
    ['duplicate CPU', (input: Payload) => { input.host.identity.onlineCpuIds = [0, 0] }],
    ['unsorted CPU', (input: Payload) => { input.host.identity.onlineCpuIds = [1, 0] }],
    ['empty CPU set', (input: Payload) => { input.host.identity.onlineCpuIds = [] }],
    ['duplicate device', (input: Payload) => { input.accounts[0].identity.ioDevices = ['8:0', '8:0'] }],
    ['noncanonical device', (input: Payload) => { input.accounts[0].identity.ioDevices = ['08:0'] }],
    ['overflow device', (input: Payload) => { input.accounts[0].identity.ioDevices = ['4294967296:0'] }],
    ['overflow inode', (input: Payload) => { input.accounts[0].identity.cgroup.inode = '18446744073709551616' }],
    ['numeric inode', (input: Payload) => { input.accounts[0].identity.cgroup.inode = 12 }],
    ['noncanonical uuid', (input: Payload) => { input.producer.epoch = 'EPOCH' }],
    ['malformed revision', (input: Payload) => { input.configuration.revision = 'current' }],
  ] as const)('rejects %s', (_label, change) => {
    const input = payload()
    change(input)
    rejects(input)
  })

  it.each(['2026-02-30T05:30:00.123Z', '2026-10-23T05:30:00Z', '2026-10-23T08:30:00.123+03:00', 'now', 0])(
    'rejects invalid or noncanonical observation time %j', observedAt => {
      const input = payload()
      input.observedAt = observedAt
      rejects(input, '$.observedAt')
    },
  )

  it('rejects accessor fields without invoking their getters', () => {
    const input = payload()
    let calls = 0
    Object.defineProperty(input.host.fields.memoryUsedBytes, 'value', { enumerable: true, get: () => { calls++; return 0 } })
    rejects(input, '$.host.fields.memoryUsedBytes')
    expect(calls).toBe(0)
  })

  it.each(['inherited', 'symbol', 'sparse array', 'array extra', 'array accessor'])(
    'rejects non-JSON own data: %s', condition => {
      const input = payload()
      if (condition === 'inherited') input.host.fields.memoryUsedBytes = Object.create(input.host.fields.memoryUsedBytes)
      if (condition === 'symbol') input.host.fields.memoryUsedBytes[Symbol('extra')] = true
      if (condition === 'sparse array') delete input.configuration.accountIds[0]
      if (condition === 'array extra') input.configuration.accountIds.extra = 'extra'
      if (condition === 'array accessor') Object.defineProperty(input.configuration.accountIds, '0', { enumerable: true, get: () => { throw new Error('must not read') } })
      rejects(input)
    },
  )
})

describe('protocol bounds and current-frame consistency', () => {
  it('declares frozen protocol budgets without treating them as capacities or quotas', () => {
    expect(RESOURCE_OBSERVATION_LIMITS).toEqual({ accounts: 10_000, cpuIdsPerIdentity: 8_192, ioDevicesPerIdentity: 4_096, totalArrayEntries: 250_000 })
    expect(Object.isFrozen(RESOURCE_OBSERVATION_LIMITS)).toBe(true)
  })

  it('allows exact account/configuration length through to separate element validation without allocating account objects', () => {
    const input = payload()
    input.configuration.accountIds = Array.from({ length: 10_000 }, (_, index) => diagnosticId(index))
    input.accounts = new Array(10_000).fill(null)
    // The configured IDs and row length passed their bounds; the first malformed row still fails.
    rejects(input, '$.accounts.0')
  })

  it('accepts the exact per-identity CPU boundary', () => {
    const input = payload()
    const cpus = Array.from({ length: 8_192 }, (_, index) => index)
    input.host.identity.onlineCpuIds = cpus
    input.host.previous.identity.onlineCpuIds = cpus
    expect(parseResourceObservationSnapshot(input).host.identity.onlineCpuIds).toHaveLength(8_192)
  })

  it('accepts the exact per-identity device boundary', () => {
    const input = payload()
    const devices = Array.from({ length: 4_096 }, (_, index) => `8:${index}`).sort()
    input.accounts[0].identity.ioDevices = devices
    input.accounts[0].previous.identity.ioDevices = devices
    expect(parseResourceObservationSnapshot(input).accounts[0]!.identity.ioDevices).toHaveLength(4_096)
  })

  it('accepts exactly 250000 cumulative array entries using shared scalar diagnostic inputs', () => {
    const result = parseResourceObservationSnapshot(budgetSample(4_210))
    expect(result.accounts).toHaveLength(11)
    expect(result.accounts[10]!.identity.onlineCpuIds).toHaveLength(4_210)
  })

  it.each([
    ['accounts', 10_001, (input: Payload, value: unknown) => { input.accounts = value }, '$.accounts.length'],
    ['configured ids', 10_001, (input: Payload, value: unknown) => { input.configuration.accountIds = value }, '$.configuration.accountIds.length'],
    ['CPU ids', 8_193, (input: Payload, value: unknown) => { input.host.identity.onlineCpuIds = value }, '$.host.identity.onlineCpuIds.length'],
    ['IO devices', 4_097, (input: Payload, value: unknown) => { input.accounts[0].identity.ioDevices = value }, '$.accounts.0.identity.ioDevices.length'],
  ] as const)('refuses excess %s length before enumerating the collection', (_name, length, change, path) => {
    const input = payload()
    const probe = oversizedArray(length)
    change(input, probe.value)
    let failure: unknown
    try { parseResourceObservationSnapshot(input) } catch (error) { failure = error }
    expect(probe.enumerations()).toBe(0)
    expect(failure).toBeInstanceOf(XpanelError)
    expect((failure as XpanelError).detail.path).toBe(path)
  })

  it('refuses cumulative array budget overflow before enumerating the last individually bounded collection', () => {
    const input = budgetSample(4_211)
    const probe = oversizedArray(4_211)
    input.accounts[10].identity.onlineCpuIds = probe.value
    let failure: unknown
    try { parseResourceObservationSnapshot(input) } catch (error) { failure = error }
    expect(probe.enumerations()).toBe(0)
    expect(failure).toBeInstanceOf(XpanelError)
    expect((failure as XpanelError).detail.path).toBe('$.accounts.10.identity.onlineCpuIds.budget')
  })

  it.each(['10000000000:0', '10000000000:1000000000'])(
    'refuses oversized device token %s before numeric conversion', device => {
      const input = payload()
      input.accounts[0].identity.ioDevices = [device]
      const spy = vi.spyOn(globalThis, 'BigInt')
      try {
        rejects(input, '$.accounts.0.identity.ioDevices.0')
        expect(spy.mock.calls.filter(([value]) => typeof value === 'string' && value.length > 10 && value !== '18446744073709551615')).toHaveLength(0)
      } finally { spy.mockRestore() }
    },
  )

  it('accepts the exact 21 character device token with each U32 component at its maximum', () => {
    const input = payload()
    input.accounts[0].identity.ioDevices = ['4294967295:4294967295']
    input.accounts[0].previous.identity.ioDevices = ['4294967295:4294967295']
    expect(parseResourceObservationSnapshot(input).accounts[0]!.identity.ioDevices).toEqual(['4294967295:4294967295'])
  })

  it('rejects different present accounts sharing one current cgroup identity', () => {
    const input = payload()
    input.accounts[1] = { ...input.accounts[0], accountId: MISSING_ACCOUNT }
    rejects(input, '$.accounts.1.identity.cgroup')
  })

  it('rejects conflicting current nonnull boot identities within one host batch', () => {
    const input = payload()
    input.accounts[0].identity.bootId = OTHER_BOOT
    input.accounts[0].previous.identity.bootId = OTHER_BOOT
    rejects(input, '$.accounts.0.identity.bootId')
  })

  it('permits null current boot evidence while retaining independent absolute readings', () => {
    const input = payload()
    input.host.identity.bootId = null
    input.host.fields.cpuBusyPercent = unavailable('missing', 'percent', 'whole-host-excluding-idle-and-iowait')
    const result = parseResourceObservationSnapshot(input)
    expect(result.host.fields.memoryUsedBytes).toMatchObject({ value: 1_024, availability: 'known' })
    expect(result.accounts[0]!.fields.cpuPercent.value).toBe(150.125)
  })
})

describe('immutable live freshness projection', () => {
  it('keeps an observation fresh just before 15 seconds and preserves its original time', () => {
    const original = parseResourceObservationSnapshot(sample())
    const result = projectResourceObservationForLive(original, { producerEpoch: EPOCH, monotonicUs: 25_009_999 })
    expect(result.freshness).toBe('fresh')
    expect(result.ageMs).toBe(14_909.999)
    expect(result.snapshot.observedAt).toBe(original.observedAt)
    expect(result.snapshot.accounts[0]!.fields.readBytesPerSec).toMatchObject({ value: 0, availability: 'known' })
  })

  it('expires the earlier host reading at its own 15 second boundary while later account readings remain known', () => {
    const result = projectResourceObservationForLive(sample(), { producerEpoch: EPOCH, monotonicUs: 25_010_000 })
    expect(result.freshness).toBe('stale')
    expect(result.ageMs).toBe(14_910)
    expect(result.snapshot.host.fields.cpuBusyPercent).toMatchObject({ value: null, availability: 'stale' })
    expect(result.snapshot.accounts[0]!.fields.cpuPercent).toMatchObject({ value: 150.125, availability: 'known' })
    expect(result.snapshot.accounts[0]!.readSpan.finishedMonotonicUs).toBe(10_040_000)
  })

  it('marks live known fields stale at 15 seconds without mutating history or refreshing the timestamp', () => {
    const original = parseResourceObservationSnapshot(sample())
    const before = JSON.stringify(original)
    const result = projectResourceObservationForLive(original, { producerEpoch: EPOCH, monotonicUs: 25_100_000 })
    expect(result.freshness).toBe('stale')
    expect(result.ageMs).toBe(15_000)
    expect(result.snapshot.observedAt).toBe(original.observedAt)
    expect(result.snapshot.readSpan).toEqual(original.readSpan)
    expect(result.snapshot.host.fields.cpuBusyPercent).toMatchObject({ value: null, availability: 'stale' })
    expect(result.snapshot.accounts[0]!.fields.readBytesPerSec).toMatchObject({ value: null, availability: 'stale' })
    expect(result.snapshot.accounts[1]!.fields.readBytesPerSec).toMatchObject({ value: null, availability: 'missing' })
    expect(result.snapshot.deferred.aggregateAwaitMs).toMatchObject({ value: null, availability: 'unsupported' })
    expect(JSON.stringify(original)).toBe(before)
    expect(original.host.fields.cpuBusyPercent).toMatchObject({ value: 12.345_678, availability: 'known' })
    expect(Object.isFrozen(original.accounts[0]!.fields.readBytesPerSec)).toBe(true)
    expect(Object.isFrozen(result.snapshot.accounts[0]!.fields.readBytesPerSec)).toBe(true)
    expect(() => { (original.host.fields.cpuBusyPercent as Payload).value = 0 }).toThrow(TypeError)
  })

  it('does not compare monotonic time across producer epochs and never calls it fresh', () => {
    const result = projectResourceObservationForLive(sample(), { producerEpoch: OTHER_EPOCH, monotonicUs: 1 })
    expect(result.freshness).toBe('stale')
    expect(result.ageMs).toBeNull()
    expect(result.snapshot.host.fields.memoryUsedBytes).toMatchObject({ value: null, availability: 'stale' })
  })

  it('cannot revive an already stale projection by changing the presentation clock', () => {
    const stale = projectResourceObservationForLive(sample(), { producerEpoch: EPOCH, monotonicUs: 25_100_000 })
    const replay = projectResourceObservationForLive(stale.snapshot, { producerEpoch: EPOCH, monotonicUs: 30_100_000 })
    expect(replay.freshness).toBe('stale')
    expect(replay.snapshot.host.fields.cpuBusyPercent.value).toBeNull()
  })

  it.each([10_099_999, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid same-epoch live clock %s', monotonicUs => {
    expect(() => projectResourceObservationForLive(sample(), { producerEpoch: EPOCH, monotonicUs })).toThrow(XpanelError)
  })

  it('rejects a clock accessor without reading it', () => {
    let reads = 0
    const clock = { producerEpoch: EPOCH, get monotonicUs() { reads++; return 10_100_000 } }
    expect(() => projectResourceObservationForLive(sample(), clock)).toThrow(XpanelError)
    expect(reads).toBe(0)
  })
})
