import { describe, expect, it } from 'vitest'
import { parseAuditFilters } from './audit-filters.ts'

const parse = (values: Record<string, string>) => parseAuditFilters(new URLSearchParams(values))

describe('audit URL query contract', () => {
  it('returns bounded exact fields, exclusive cursor, page size and normalized inclusive UTC bounds', () => {
    expect(parse({ actor: ' root ', action: 'account.create', target: 'account:owner', before: '50', limit: '51', outcome: 'denied', from: '2026-10-25T09:30', to: '2026-10-25T12:30:00.000+03:00' })).toEqual({
      actor: 'root', action: 'account.create', target: 'account:owner', beforeId: '50', limit: 51, outcome: 'denied', from: '2026-10-25T09:30:00.000Z', to: '2026-10-25T09:30:00.000Z',
    })
  })

  it('treats cleared form controls as absent and ignores unrelated presentation parameters', () => {
    expect(parse({ actor: ' ', action: '', target: '', before: '', limit: '', outcome: '', from: '', to: '', lang: 'ar', theme: 'dark' })).toEqual({})
    expect(parse({ limit: '1000' })).toEqual({ limit: 1000 })
  })

  it('keeps SQL metacharacters literal in bounded actor and target fields', () => {
    const value = "x' OR 1=1 --_%"
    expect(parse({ actor: value, target: value })).toEqual({ actor: value, target: value })
  })

  const invalidQueryCases: Record<string, string>[] = [
    { from: '2025-02-29T09:30' }, { from: '2026-02-30T09:30' },
    { from: '2026-13-01T00:00' }, { from: '2026-10-25T24:00' },
    { from: '2026-10-25T09:60' }, { from: '2026-10-25T09:30:60' },
    { from: '0000-01-01T00:00' }, { from: '2026-10-25' },
    { from: '2026-10-25T09:30:00.1234Z' }, { from: '2026-10-25T09:30+03:60' },
    { from: '2026-10-26T09:30', to: '2026-10-25T09:30' },
    { outcome: 'success' }, { outcome: "ok'--" },
    { limit: '0' }, { limit: '-1' }, { limit: '1001' }, { limit: '1.5' }, { limit: '1e2' },
    { before: '0' }, { before: '1 OR 1=1' }, { before: '1234567890123456' },
    { actor: 'a'.repeat(129) }, { target: 'a'.repeat(481) },
    { action: "account.test' OR 1=1" }, { actor: 'line\nbreak' },
  ]
  it.each(invalidQueryCases)('rejects malformed or unbounded query %j', values => {
    expect(() => parse(values)).toThrowError(expect.objectContaining({ code: 'VALIDATION' }))
  })

  it.each(['actor', 'action', 'target', 'before', 'limit', 'outcome', 'from', 'to'])('rejects duplicate %s parameters', name => {
    expect(() => parseAuditFilters(new URLSearchParams([[name, ''], [name, '']]))).toThrowError(expect.objectContaining({ code: 'VALIDATION' }))
  })
})
