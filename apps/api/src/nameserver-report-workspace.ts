import { fail } from '@xpanel/core'
import type { Domain } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export interface NameserverReportHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot'> {
  store: Pick<StateStore, 'readSnapshot'>
  now?: () => Date
}

export type NameserverDelegationStatus = 'matched' | 'custom' | 'missing'

export interface NameserverReportRow {
  zone: string
  domainId: string | null
  domainKind: Domain['kind'] | null
  accountId: string | null
  accountUsername: string | null
  resellerId: string | null
  resellerUsername: string | null
  nameservers: string[]
  expectedNameservers: string[]
  expectedSource: 'reseller' | 'server' | 'none'
  status: NameserverDelegationStatus
}

export interface NameserverReportResult {
  observedAt: string
  serverNameservers: string[]
  totalZones: number
  matchedZones: number
  customZones: number
  missingZones: number
  rows: NameserverReportRow[]
}

const ROUTE = '/api/server/dns/nameserver-report'
const unchanged = { stateChanged: false }
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const normalizeHost = (value: string): string => value.trim().toLowerCase().replace(/\.+$/, '')
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const uniqueSortedHosts = (values: readonly string[]): string[] =>
  [...new Set(values.map(normalizeHost).filter(Boolean))].sort(byName)
const sameHostSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((host, index) => host === b[index])

/**
 * Root-only cross-zone nameserver delegation report (`GET /api/server/dns/nameserver-report`).
 * Computes apex NS targets per saved DNS zone and compares them against expected reseller or server nameservers.
 */
export async function handleNameserverReportRoute(
  request: Request,
  url: URL,
  method: string,
  helpers: NameserverReportHelpers,
): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.dns.read')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'nameserver report accepts no query parameters', unchanged)

  const snapshot = await helpers.store.readSnapshot()
  const serverNameservers = uniqueSortedHosts(snapshot.server?.settings.nameservers ?? [])
  const domainByName = new Map(snapshot.domains.map(d => [normalizeHost(d.name), d]))
  const accountById = new Map(snapshot.accounts.map(a => [a.id, a]))
  const resellerById = new Map(snapshot.resellers.map(r => [r.id, r]))

  const sortedZones = [...snapshot.zones].sort((a, b) => byName(normalizeHost(a.name), normalizeHost(b.name)))
  let matchedZones = 0
  let customZones = 0
  let missingZones = 0

  const rows: NameserverReportRow[] = sortedZones.map(zone => {
    const zoneName = normalizeHost(zone.name)
    const domain = domainByName.get(zoneName) ?? null
    const accountId = zone.accountId ?? domain?.accountId ?? null
    const account = accountId ? accountById.get(accountId) ?? null : null
    const resellerId = account?.ownerId ?? null
    const reseller = resellerId ? resellerById.get(resellerId) ?? null : null

    const nameservers = uniqueSortedHosts(
      zone.records
        .filter(record => record.type === 'NS' && (record.name === '@' || normalizeHost(record.name) === zoneName))
        .map(record => record.content),
    )

    const resellerNameservers = reseller ? uniqueSortedHosts(reseller.nameservers) : []
    const expectedSource: NameserverReportRow['expectedSource'] = resellerNameservers.length > 0
      ? 'reseller'
      : serverNameservers.length > 0
        ? 'server'
        : 'none'
    const expectedNameservers = expectedSource === 'reseller' ? resellerNameservers : expectedSource === 'server' ? serverNameservers : []

    let status: NameserverDelegationStatus
    if (nameservers.length === 0) {
      status = 'missing'
      missingZones++
    } else if (expectedNameservers.length > 0 && sameHostSet(nameservers, expectedNameservers)) {
      status = 'matched'
      matchedZones++
    } else {
      status = 'custom'
      customZones++
    }

    return {
      zone: zoneName,
      domainId: domain?.id ?? null,
      domainKind: domain?.kind ?? null,
      accountId: account?.id ?? accountId,
      accountUsername: account?.username ?? null,
      resellerId: reseller?.id ?? resellerId,
      resellerUsername: reseller?.username ?? null,
      nameservers,
      expectedNameservers,
      expectedSource,
      status,
    }
  })

  const result: NameserverReportResult = {
    observedAt: (helpers.now?.() ?? new Date()).toISOString(),
    serverNameservers,
    totalZones: rows.length,
    matchedZones,
    customZones,
    missingZones,
    rows,
  }
  return json(result)
}
