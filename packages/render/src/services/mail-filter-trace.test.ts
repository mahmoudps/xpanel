import { describe, expect, it } from 'vitest'
import type { MailFilter } from './mail.ts'
import { traceMailFilters, type SampleMessage } from './mail-filter-trace.ts'

const message = (patch: Partial<SampleMessage> = {}): SampleMessage => ({
  headers: [{ name: 'From', value: 'Atlas Pack <orders@atlas-pack.example>' }, { name: 'To', value: 'info@alice-shop.com' }, { name: 'Subject', value: 'Invoice 42 for October' }],
  body: 'Please find the invoice attached.',
  ...patch,
})
const rule = (patch: Partial<MailFilter>): MailFilter => ({ name: 'Rule', match: 'all', tests: [], actions: [{ kind: 'keep' }], ...patch })

describe('filter dry run', () => {
  it('reports which rule matched, why, and where the message goes', () => {
    const trace = traceMailFilters([
      rule({ name: 'Newsletters', tests: [{ field: 'header', header: 'List-Id', op: 'contains', value: 'news' }], actions: [{ kind: 'fileinto', folder: 'News' }, { kind: 'stop' }] }),
      rule({ name: 'Invoices', tests: [{ field: 'subject', op: 'contains', value: 'INVOICE' }, { field: 'from', op: 'matches', value: '*@atlas-pack.example>' }],
        actions: [{ kind: 'fileinto', folder: 'Invoices' }, { kind: 'mark-read' }, { kind: 'redirect', to: 'books@alice-shop.com' }, { kind: 'stop' }] }),
      rule({ name: 'Never reached', actions: [{ kind: 'discard' }] }),
    ], message())
    expect(trace.rules.map((r) => [r.name, r.matched, r.stopped])).toEqual([['Newsletters', false, false], ['Invoices', true, true]])
    // a missing header never matches
    expect(trace.rules[0]!.tests[0]).toMatchObject({ actual: [], matched: false })
    expect(trace.rules[1]!.tests.map((t) => t.actual)).toEqual([['Invoice 42 for October'], ['Atlas Pack <orders@atlas-pack.example>']])
    expect(trace.outcome).toEqual({ folders: ['Invoices'], redirects: ['books@alice-shop.com'], discarded: false, rejected: null, markedRead: true, stoppedAt: 1 })
  })

  it('keeps the message in INBOX when no rule cancels the implicit keep', () => {
    const trace = traceMailFilters([rule({ match: 'any', tests: [{ field: 'size', op: 'over', bytes: 1_000_000 }, { field: 'body', op: 'is', value: 'nothing' }] })], message())
    expect(trace.rules[0]!.matched).toBe(false)
    expect(typeof trace.rules[0]!.tests[0]!.actual).toBe('number')
    expect(trace.outcome).toMatchObject({ folders: ['INBOX'], stoppedAt: null })
  })

  it('ends at discard or reject without an explicit stop and skips disabled rules', () => {
    const trace = traceMailFilters([
      rule({ name: 'Paused', enabled: false, actions: [{ kind: 'reject', message: 'no' }] }),
      rule({ name: 'Drop', tests: [{ field: 'subject', op: 'matches', value: 'invoice ?? for *' }], actions: [{ kind: 'discard' }] }),
      rule({ name: 'After', actions: [{ kind: 'keep' }] }),
    ], message())
    expect(trace.rules.map((r) => r.name)).toEqual(['Drop'])
    expect(trace.outcome).toMatchObject({ folders: [], discarded: true, stoppedAt: 1 })
  })

  it('treats wildcard metacharacters in a value literally when quoted', () => {
    const trace = traceMailFilters([rule({ tests: [{ field: 'subject', op: 'matches', value: 'deal \\*today\\*' }] })], message({ headers: [{ name: 'Subject', value: 'Deal *today*' }] }))
    expect(trace.rules[0]!.matched).toBe(true)
  })
})
