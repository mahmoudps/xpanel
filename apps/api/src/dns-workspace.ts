import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { DnsZoneState } from '@xpanel/state'

/** DNS files are validated/canonicalized by StateStore before revision calculation. */
export const dnsZoneRevision = (zone: DnsZoneState | null): string | null =>
  zone === null ? null : createHash('sha256').update(JSON.stringify(zone)).digest('hex')

export const dnsExpectedRevision = (body: unknown, method: 'PUT' | 'DELETE'): string | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION', 'DNS workspace body must be an object', { stateChanged: false })
  const value = body as Record<string, unknown>
  const allowed = method === 'PUT' ? ['records', 'accountId', 'expectedZoneRevision'] : ['expectedZoneRevision']
  if (Object.keys(value).some(key => !allowed.includes(key))) return fail('VALIDATION', 'unsupported DNS workspace field', { stateChanged: false })
  const expected = value.expectedZoneRevision
  if (expected !== null && (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected))) return fail('VALIDATION', 'expectedZoneRevision must be a saved revision or null', { stateChanged: false })
  if (method === 'DELETE' && expected === null) return fail('VALIDATION', 'deleting a DNS zone requires its saved revision', { stateChanged: false })
  if (method === 'PUT' && !Array.isArray(value.records)) return fail('VALIDATION', 'DNS records must be an array', { stateChanged: false })
  return expected as string | null
}

export const assertDnsZoneRevision = (current: DnsZoneState | null, expected: string | null): void => {
  if (dnsZoneRevision(current) !== expected) fail('CONFLICT', 'DNS zone changed; reload and review before retrying', { stateChanged: false })
}
