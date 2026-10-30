import { isRecord, requireValue } from './contracts.mjs'

export const SERVER_INFORMATION_ACCEPTANCE = 'The API returns CPU model, core count, total RAM and per-mount disk usage matching the OS values within 1%.'
export const SERVER_INFORMATION_METRIC_IDS = Object.freeze(['SI-CPU-MODEL', 'SI-CPU-CORES', 'SI-RAM-TOTAL', 'SI-MOUNT-INVENTORY', 'SI-MOUNT-USAGE'])
export const SERVER_INFORMATION_HTTP_IDS = Object.freeze(['SI-INSTALLED-IDENTITY', 'SI-OBSERVER-INDEPENDENT', 'SI-OS-PROFILE', 'SI-API-ROOT-READ', ...SERVER_INFORMATION_METRIC_IDS, 'SI-ANONYMOUS-DENIED', 'SI-FORGED-PRINCIPAL-DENIED', 'SI-SESSION-REVOKED'])
export const SERVER_INFORMATION_LINUX_IDS = Object.freeze([...SERVER_INFORMATION_HTTP_IDS])
export const SERVER_INFORMATION_UNIT_IDS = Object.freeze(['SI-UNIT-CRITERION-CONTRACT', 'SI-UNIT-TOLERANCE-BOUNDARY', 'SI-UNIT-CPU-IDENTITY', 'SI-UNIT-ALL-MOUNTS', 'SI-UNIT-ROOT-ONLY-REFUSAL', 'SI-UNIT-TOPOLOGY-STABILITY', 'SI-UNIT-BRACKET-METRICS', 'SI-UNIT-MOUNT-PARSER', 'SI-UNIT-STATFS-ACCOUNTING', 'SI-UNIT-OS-PROFILES', 'SI-UNIT-TLS-ORIGIN', 'SI-UNIT-DNS-LOOKUP', 'SI-UNIT-SESSION-AUDIENCE', 'SI-UNIT-INSTALLED-BINDING', 'SI-UNIT-TWO-SLOT-RECEIPTS'])

/** Inventories for missing environments are declarations, never execution evidence. */
export const SERVER_INFORMATION_REQUIREMENTS = Object.freeze([{
  toolId: 'server-information', acceptance: SERVER_INFORMATION_ACCEPTANCE,
  checks: Object.freeze({
    unit: SERVER_INFORMATION_UNIT_IDS,
    http: SERVER_INFORMATION_HTTP_IDS,
    browser: Object.freeze(['SI-BROWSER-ROOT-METRICS', 'SI-BROWSER-ARABIC-ENGLISH', 'SI-BROWSER-AUTHORIZATION']),
    linux: SERVER_INFORMATION_LINUX_IDS,
    external: Object.freeze(['SI-EXTERNAL-INDEPENDENT-METRICS']),
  }),
}])

const integer = value => Number.isSafeInteger(value) && value >= 0
const model = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 ? value.trim().replace(/\s+/g, ' ') : null
const bytes = value => integer(value) ? value : null

export function withinOnePercent(actual, expected) {
  if (!integer(actual) || !integer(expected)) return false
  const difference = BigInt(actual) >= BigInt(expected) ? BigInt(actual) - BigInt(expected) : BigInt(expected) - BigInt(actual)
  return difference * 100n <= BigInt(expected)
}

function diskIndex(disks) {
  requireValue(Array.isArray(disks) && disks.length > 0 && disks.length <= 4096, 'A complete bounded mount inventory is required')
  const result = new Map()
  for (const disk of disks) {
    requireValue(isRecord(disk) && typeof disk.mount === 'string' && disk.mount.startsWith('/') && disk.mount.length <= 4096 && !result.has(disk.mount) && ['totalBytes', 'usedBytes', 'availableBytes'].every(field => bytes(disk[field]) !== null), 'Mount data is missing, duplicated or invalid')
    requireValue(disk.usedBytes <= disk.totalBytes && disk.availableBytes <= disk.totalBytes, 'Mount byte accounting is invalid')
    result.set(disk.mount, disk)
  }
  return result
}

export function compareServerInformation(payload, before, after) {
  requireValue(isRecord(payload) && isRecord(before) && isRecord(after), 'Fresh API and independent OS observations are required')
  const checks = []
  const add = (id, passed, observed) => checks.push({ id, status: passed ? 'passed' : 'failed', observed })
  const apiModel = model(payload.identity?.model), beforeModel = model(before.cpu?.model), afterModel = model(after.cpu?.model)
  add('SI-CPU-MODEL', apiModel !== null && apiModel === beforeModel && apiModel === afterModel, { api: apiModel, before: beforeModel, after: afterModel, comparison: 'normalized text equality' })
  const cores = payload.identity?.cores
  add('SI-CPU-CORES', integer(cores) && cores > 0 && cores === before.cpu?.cores && cores === after.cpu?.cores, { api: cores ?? null, before: before.cpu?.cores ?? null, after: after.cpu?.cores ?? null, comparison: 'exact online logical processor count' })
  const ram = payload.memory?.totalBytes
  add('SI-RAM-TOTAL', withinOnePercent(ram, before.memory?.totalBytes) && withinOnePercent(ram, after.memory?.totalBytes), { api: ram ?? null, before: before.memory?.totalBytes ?? null, after: after.memory?.totalBytes ?? null, tolerancePercent: 1 })
  let apiDisks, beforeDisks, afterDisks
  try { apiDisks = diskIndex(payload.disks); beforeDisks = diskIndex(before.disks); afterDisks = diskIndex(after.disks) }
  catch {
    add('SI-MOUNT-INVENTORY', false, { reason: 'Missing or invalid all-mount inventory; a legacy root-only disk does not cover this criterion.' })
    add('SI-MOUNT-USAGE', false, { reason: 'Per-mount comparisons were not possible.' })
    return checks
  }
  const expectedMounts = [...beforeDisks.keys()].sort()
  const actualMounts = [...apiDisks.keys()].sort(), afterMounts = [...afterDisks.keys()].sort()
  const coverage = payload.diskCoverage
  const complete = JSON.stringify(actualMounts) === JSON.stringify(expectedMounts) && JSON.stringify(afterMounts) === JSON.stringify(expectedMounts)
    && coverage?.status === 'complete' && coverage?.source === 'df' && coverage?.inventorySource === 'proc-self-mountinfo'
    && Array.isArray(coverage.mounts) && JSON.stringify([...coverage.mounts].sort()) === JSON.stringify(expectedMounts)
    && Array.isArray(coverage.unavailableMounts) && coverage.unavailableMounts.length === 0 && Array.isArray(coverage.unexpectedMounts) && coverage.unexpectedMounts.length === 0
    && typeof before.mountInfoSha256 === 'string' && coverage.mountInfoSha256 === before.mountInfoSha256 && coverage.mountInfoSha256 === after.mountInfoSha256
  add('SI-MOUNT-INVENTORY', complete, { api: actualMounts, before: expectedMounts, after: afterMounts, coverage: coverage?.status ?? 'missing', topologyMatched: coverage?.mountInfoSha256 === before.mountInfoSha256 && coverage?.mountInfoSha256 === after.mountInfoSha256, scope: 'all visible mountpoints from independent mountinfo; no filesystem exclusions' })
  const comparisons = expectedMounts.map(mount => {
    const actual = apiDisks.get(mount), first = beforeDisks.get(mount), last = afterDisks.get(mount)
    const fields = Object.fromEntries(['totalBytes', 'usedBytes', 'availableBytes'].map(field => [field, { api: actual?.[field] ?? null, before: first?.[field] ?? null, after: last?.[field] ?? null, passed: actual !== undefined && last !== undefined && withinOnePercent(actual[field], first[field]) && withinOnePercent(actual[field], last[field]) }]))
    return { mount, fields, passed: Object.values(fields).every(field => field.passed) }
  })
  add('SI-MOUNT-USAGE', complete && comparisons.every(item => item.passed), { tolerancePercent: 1, comparison: 'API must match both bracketing OS observations within tolerance', comparisons })
  return checks
}

export function validateServerInformationOrigin(value) {
  const origin = new URL(value)
  requireValue(origin.protocol === 'https:' && origin.username === '' && origin.password === '' && origin.pathname === '/' && origin.search === '' && origin.hash === '', 'An HTTPS origin without credentials or selectors is required')
  return origin.origin
}

export function pinnedLookup(address, family) {
  requireValue((family === 4 || family === 6) && typeof address === 'string', 'A measured local address is required')
  return (_hostname, options, callback) => options?.all ? callback(null, [{ address, family }]) : callback(null, address, family)
}
