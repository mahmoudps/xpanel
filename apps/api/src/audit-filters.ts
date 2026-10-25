import { fail } from '@xpanel/core'
import { normalizeAuditFilters, type AuditQuery } from '@xpanel/db'

/**
 * GET /api/audit and the audit form share this contract. Empty values mean no filter;
 * duplicate keys and malformed values fail validation. before is an exclusive id
 * cursor; from/to are inclusive instants, normalized to ISO UTC. A datetime-local
 * without a timezone is UTC, never the browser/server local timezone.
 */
export const parseAuditFilters = (params: URLSearchParams): AuditQuery => {
  const single = (name: string, max: number): string | undefined => {
    const values = params.getAll(name)
    if (values.length > 1) return fail('VALIDATION', `${name} must occur once`)
    const value = values[0]?.trim()
    if (!value) return undefined
    if (value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
      return fail('VALIDATION', `${name} is invalid or too long`)
    }
    return value
  }
  const actor = single('actor', 128)
  const action = single('action', 128)
  const target = single('target', 480)
  const beforeId = single('before', 15)
  const rawLimit = single('limit', 4)
  const outcome = single('outcome', 6)
  const from = single('from', 29)
  const to = single('to', 29)
  if (action !== undefined && !/^[a-z][a-z0-9_.:-]{0,127}$/.test(action)) {
    return fail('VALIDATION', 'action must be an audit action name')
  }
  if (beforeId !== undefined && !/^[1-9][0-9]{0,14}$/.test(beforeId)) {
    return fail('VALIDATION', 'before must be an entry id')
  }
  if (rawLimit !== undefined && (!/^[1-9][0-9]{0,3}$/.test(rawLimit) || Number(rawLimit) > 1000)) {
    return fail('VALIDATION', 'limit must be an integer in 1..1000')
  }
  const bounds = normalizeAuditFilters({
    ...(outcome !== undefined ? { outcome: outcome as AuditQuery['outcome'] } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  })
  return {
    ...(actor !== undefined ? { actor } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(beforeId !== undefined ? { beforeId } : {}),
    ...(rawLimit !== undefined ? { limit: Number(rawLimit) } : {}),
    ...bounds,
  }
}
