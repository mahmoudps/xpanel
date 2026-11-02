import type { WebsiteAnalyticsSnapshot, WebsiteTopEntry, WebsiteTrafficBucket } from '@xpanel/core'

/** Accepted account-scoped traffic read windows; the same values the agent route accepts. */
export type WebsiteAnalyticsWindow = '1h' | '24h' | '7d' | '30d'

export const WEBSITE_ANALYTICS_WINDOWS: readonly WebsiteAnalyticsWindow[] = ['1h', '24h', '7d', '30d']

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null

const suppliedCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER

const suppliedInstant = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value))

const bucketKeys = [
  'requests', 'bytes', 'status2xx', 'status3xx', 'status4xx', 'status5xx',
  'cacheHit', 'cacheMiss', 'cacheBypass', 'avgRequestTimeMs', 'p95RequestTimeMs', 'avgUpstreamTimeMs',
] as const

const parseTrafficBucket = (value: unknown): WebsiteTrafficBucket | null => {
  const row = asRecord(value)
  if (!row || !suppliedInstant(row.at) || !bucketKeys.every(key => suppliedCount(row[key]))) return null
  return {
    at: row.at,
    requests: row.requests as number, bytes: row.bytes as number,
    status2xx: row.status2xx as number, status3xx: row.status3xx as number,
    status4xx: row.status4xx as number, status5xx: row.status5xx as number,
    cacheHit: row.cacheHit as number, cacheMiss: row.cacheMiss as number, cacheBypass: row.cacheBypass as number,
    avgRequestTimeMs: row.avgRequestTimeMs as number, p95RequestTimeMs: row.p95RequestTimeMs as number,
    avgUpstreamTimeMs: row.avgUpstreamTimeMs as number,
  }
}

const parseTopEntries = (value: unknown): WebsiteTopEntry[] | null => {
  if (!Array.isArray(value) || value.length > 500) return null
  const entries: WebsiteTopEntry[] = []
  for (const item of value) {
    const row = asRecord(item)
    if (!row || typeof row.key !== 'string' || row.key.length === 0 || row.key.length > 2048) return null
    if (!suppliedCount(row.requests) || !suppliedCount(row.bytes)) return null
    if (row.errors5xx !== undefined && !suppliedCount(row.errors5xx)) return null
    entries.push({ key: row.key, requests: row.requests, bytes: row.bytes, ...(row.errors5xx !== undefined ? { errors5xx: row.errors5xx } : {}) })
  }
  return entries
}

const totalKeys = [
  'requests', 'bytes', 'uniqueVisitors', 'cacheHitRatioPercent', 'errorRatePercent',
  'avgRequestTimeMs', 'p95RequestTimeMs', 'avgUpstreamTimeMs',
  'status2xx', 'status3xx', 'status4xx', 'status5xx',
] as const

/**
 * Strictly validates an account-scoped website analytics observation.
 * A malformed, foreign-account or partial response is unavailable, never repaired,
 * and an empty series stays an explicit empty observation rather than synthetic samples.
 */
export const parseWebsiteAnalyticsSnapshot = (
  input: unknown,
  expected: { domain?: string; accountId?: string } = {},
): WebsiteAnalyticsSnapshot | null => {
  const row = asRecord(input)
  if (!row || typeof row.domain !== 'string' || row.domain.length === 0 || row.domain.length > 253) return null
  if (row.accountId !== null && typeof row.accountId !== 'string') return null
  if (expected.domain !== undefined && row.domain !== expected.domain) return null
  if (expected.accountId !== undefined && row.accountId !== expected.accountId) return null
  if (!suppliedInstant(row.at)) return null
  const totals = asRecord(row.totals)
  if (!totals || !totalKeys.every(key => suppliedCount(totals[key]))) return null
  if ((totals.cacheHitRatioPercent as number) > 100 || (totals.errorRatePercent as number) > 100) return null
  if (!Array.isArray(row.series) || row.series.length > 2000) return null
  const series: WebsiteTrafficBucket[] = []
  for (const item of row.series) {
    const bucket = parseTrafficBucket(item)
    if (!bucket) return null
    series.push(bucket)
  }
  const topPaths = parseTopEntries(row.topPaths)
  const topReferrers = parseTopEntries(row.topReferrers)
  const topClientIps = parseTopEntries(row.topClientIps)
  if (topPaths === null || topReferrers === null || topClientIps === null) return null
  return {
    domain: row.domain, accountId: row.accountId as string | null, at: row.at,
    totals: Object.fromEntries(totalKeys.map(key => [key, totals[key]])) as WebsiteAnalyticsSnapshot['totals'],
    series, topPaths, topReferrers, topClientIps,
  }
}

