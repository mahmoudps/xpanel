import { describe, expect, it } from 'vitest'
import { FILTER_COMPILATION_BUDGET_BYTES, MAX_FILTER_RULES, assertFilterContext, compileValidatedFilters, filterRevision, validateFilterCondition, validateFilterDraft, validateFilterPatch, validateSampleMessage, validateStoredFilterRule, type FilterScopeContext } from './filter-validation.ts'

const context: FilterScopeContext = { accountId: 'account-a', scope: 'global', mailbox: null }
const mailboxContext: FilterScopeContext = { accountId: 'account-a', scope: 'mailbox', mailbox: 'inbox@example.test' }
const draft = (patch: Record<string, unknown> = {}) => ({ name: 'Invoice rule', conditions: [{ field: 'subject', comparator: 'contains', value: 'Invoice' }], actions: [{ type: 'fileinto', target: 'Billing' }, { type: 'stop' }], ...patch })
const content = (patch: Record<string, unknown> = {}) => validateFilterDraft(draft(patch), { priority: 3 })
const stored = (patch: object = {}) => ({ id: 'filter-a', ...context, ...content(), createdAt: '2026-10-25T00:00:00.000Z', compiledSieve: 'UNTRUSTED_CACHE', ...patch })
const invalid = (operation: () => unknown) => expect(operation).toThrowError(expect.objectContaining({ code: 'VALIDATION' }))

describe('pure filter input contract', () => {
  it('requires explicit content and never returns authority or revision metadata', () => {
    expect(validateFilterDraft(draft({ name: '  فواتير  ', accountId: 'account-a', scope: 'global', mailbox: null, expectedRevision: 'a'.repeat(64) }), { priority: 7 })).toEqual({ name: 'فواتير', priority: 7, enabled: true, matchAll: true, conditions: [{ field: 'subject', comparator: 'contains', value: 'Invoice' }], actions: [{ type: 'fileinto', target: 'Billing' }, { type: 'stop' }] })
    invalid(() => validateFilterDraft({ name: 'No invented spam' }, { priority: 1 }))
    expect(content({ conditions: [] }).conditions).toEqual([])
    expect(content({ actions: [{ type: 'fileinto', target: 'Archive.الفواتير' }] }).actions).toEqual([{ type: 'fileinto', target: 'Archive.الفواتير' }])
  })
  it('accepts up to ten ordered actions in the one representation', () => {
    const actions = [{ type: 'mark-read' }, { type: 'fileinto', target: 'Billing' }, { type: 'redirect', target: 'Books@Example.TEST' }, { type: 'keep' }, { type: 'stop' }]
    expect(content({ actions }).actions).toEqual([{ type: 'mark-read' }, { type: 'fileinto', target: 'Billing' }, { type: 'redirect', target: 'books@example.test' }, { type: 'keep' }, { type: 'stop' }])
    invalid(() => content({ actions: [] }))
    invalid(() => content({ actions: Array(11).fill({ type: 'keep' }) }))
    invalid(() => content({ action: { type: 'keep' } }))
    invalid(() => content({ actions: [{ type: 'fileinto', argument: 'Junk' }] }))
  })
  it('refuses action mixes the mail server cannot run', () => {
    invalid(() => content({ actions: [{ type: 'reject', target: 'No' }, { type: 'keep' }] }))
    invalid(() => content({ actions: [{ type: 'discard' }, { type: 'fileinto', target: 'Junk' }] }))
    invalid(() => content({ actions: [{ type: 'stop' }, { type: 'keep' }] }))
    expect(content({ actions: [{ type: 'discard' }] }).actions).toEqual([{ type: 'discard' }])
  })
  it.each([null, [], 42, { name: 'Only name' }, draft({ name: '' }), draft({ name: ' ' }), draft({ name: 'a'.repeat(129) }), draft({ conditions: null }), draft({ conditions: [null] }), draft({ conditions: Array(51).fill({ field: 'subject', comparator: 'is', value: 'x' }) }), draft({ conditions: Array(1) }), draft({ id: 'forged' }), draft({ compiledSieve: 'keep;' }), draft({ createdAt: 'forged' }), draft({ scope: ['global'] }), draft({ scope: 'unknown' }), draft({ scope: 'global', mailbox: 'inbox@example.test' }), draft({ scope: 'mailbox', mailbox: null }), draft({ actions: null }), draft({ actions: [{ type: 'pipe', target: '/bin/sh' }] }), draft({ enabled: 'false' }), draft({ enabled: undefined }), draft({ matchAll: 0 }), draft({ matchAll: undefined }), draft({ priority: undefined }), draft({ expectedRevision: 'bad' })])('rejects malformed drafts without fallback: %j', input => invalid(() => validateFilterDraft(input, { priority: 1 })))
  it.each([0, -1, 1.5, 10001, '1', true, NaN, Infinity])('rejects invalid priority: %j', priority => invalid(() => content({ priority })))
  it('bounds names as the Sieve renderer does (UTF-16 units) and rejects lone surrogates', () => {
    expect(content({ name: '😀'.repeat(64) }).name).toHaveLength(128)
    invalid(() => content({ name: '😀'.repeat(65) }))
    invalid(() => content({ name: '\ud800' }))
    invalid(() => content({ conditions: [{ field: 'subject', comparator: 'is', value: 'a'.repeat(1025) }] }))
  })
  it.each(['\n', '\r', '\0', '\t', '\u0085', '\u007f'])('rejects control characters before trim: %j', character => {
    invalid(() => content({ name: character + 'name' }))
    invalid(() => content({ conditions: [{ field: 'body', comparator: 'contains', value: 'a' + character }] }))
    invalid(() => content({ actions: [{ type: 'fileinto', target: character + 'Spam' }] }))
  })
  it.each(['from', 'to', 'subject', 'header', 'body'])('emits every supported string comparator exactly for %s', field => {
    for (const comparator of ['contains', 'is', 'matches']) {
      const condition = validateFilterCondition({ field, comparator, value: ' *invoice?\\* ', ...(field === 'header' ? { headerName: 'X-Project-Tag' } : {}) })
      const source = compileValidatedFilters([stored({ conditions: [condition] })], context)
      expect(source).toContain((field === 'body' ? 'body :text' : 'header') + ' :' + comparator)
      expect(source).toContain('" *invoice?\\\\* "')
    }
  })
  it('refuses a value or header name the mail server cannot render', () => {
    invalid(() => content({ conditions: [{ field: 'subject', comparator: 'is', value: '' }] }))
    invalid(() => content({ conditions: [{ field: 'header', headerName: 'X_Underscore', comparator: 'is', value: 'x' }] }))
    invalid(() => content({ conditions: [{ field: 'size', comparator: 'over', value: '0' }] }))
  })
  it.each([{ field: 'unknown', comparator: 'is', value: '' }, { field: ' subject ', comparator: 'is', value: '' }, { field: 'body', comparator: 'over', value: '1' }, { field: 'subject', comparator: 'regex', value: 'x' }, { field: 'from', comparator: 'is', value: 'x', headerName: 'X-Extra' }, { field: 'header', comparator: 'is', value: 'x' }, { field: 'header', comparator: 'is', value: 'x', headerName: 'X:Bad' }, { field: 'header', comparator: 'is', value: 'x', headerName: 'X"; reject "bad' }, { field: 'header', comparator: 'is', value: 'x', headerName: 'x'.repeat(79) }, { field: 'subject', comparator: 'is', value: 12 }, { field: 'subject', comparator: 'is', value: 'x', raw: 'keep;' }])('rejects unsupported condition grammar: %j', value => invalid(() => validateFilterCondition(value)))
  it.each([['1', '1'], ['1K', '1024'], ['2m', '2097152'], ['1G', '1073741824'], ['2147483647', '2147483647'], ['0000000000001K', '1024']])('normalizes size %s to %s', (value, bytes) => {
    for (const comparator of ['over', 'under']) {
      const condition = validateFilterCondition({ field: 'size', comparator, value })
      expect(condition.value).toBe(bytes)
      expect(compileValidatedFilters([stored({ conditions: [condition] })], context)).toContain('size :' + comparator + ' ' + bytes)
    }
  })
  it.each(['-1', '1.5', '1e3', '2G', '2147483648', '1K; redirect "out@example.test";', '', 'NaN', '١', '1 K'])('rejects executable or out-of-range size: %s', value => invalid(() => validateFilterCondition({ field: 'size', comparator: 'over', value })))
  it.each(['contains', 'is', 'matches'])('rejects size comparator substitution: %s', comparator => invalid(() => validateFilterCondition({ field: 'size', comparator, value: '1' })))
  it.each([{ type: 'fileinto' }, { type: 'reject' }, { type: 'redirect' }, { type: 'redirect', target: '|command@example.test' }, { type: 'redirect', target: 'a@@example.test' }, { type: 'keep', target: 'unexpected' }, { type: 'stop', target: 'x' }, { type: 'discard', target: 42 }, { type: 'fileinto', target: 'x'.repeat(256) }, { type: 'fileinto', target: '../etc' }, { type: 'reject', target: 'x'.repeat(1025) }, { type: 'keep', hidden: 'pipe' }])('rejects unsupported action: %j', action => invalid(() => content({ actions: [action] })))
  it('emits each action as the mail server runs it and canonicalizes redirect addresses', () => {
    const source = (actions: unknown[]) => compileValidatedFilters([stored(content({ actions }))], context)
    expect(source([{ type: 'keep' }])).toContain('  keep;')
    expect(source([{ type: 'discard' }])).toContain('  discard;\n  stop;')
    expect(source([{ type: 'fileinto', target: 'Archive.الفواتير' }])).toContain('  fileinto :create "Archive.الفواتير";')
    expect(source([{ type: 'redirect', target: 'OUT@Example.TEST' }])).toContain('  redirect "out@example.test";')
    expect(source([{ type: 'mark-read' }, { type: 'keep' }])).toContain('  addflag "\\\\Seen";\n  keep;')
    expect(source([{ type: 'reject', target: 'Quoted "reason"\\literal' }])).toContain('  reject "Quoted \\"reason\\"\\\\literal";\n  stop;')
  })
  it('returns only editable PATCH fields and strips revision without adding defaults', () => {
    expect(validateFilterPatch({ enabled: false, expectedRevision: 'a'.repeat(64) })).toEqual({ enabled: false })
    expect(validateFilterPatch({ conditions: [] })).toEqual({ conditions: [] })
    expect(validateFilterPatch({ actions: [{ type: 'keep', target: '' }] })).toEqual({ actions: [{ type: 'keep' }] })
    for (const value of [{}, { expectedRevision: 'a'.repeat(64) }, { priority: 1 }, { id: 'forged' }, { scope: 'global' }, { mailbox: null }, { accountId: 'a' }, { enabled: undefined }, { action: { type: 'keep' } }]) invalid(() => validateFilterPatch(value))
  })
})

describe('selected-scope Sieve compiler', () => {
  it('quotes literals and ignores untrusted cached source', () => {
    const literal = '\\"; discard; #'
    const source = compileValidatedFilters([stored({ conditions: [{ field: 'subject', comparator: 'is', value: literal }], actions: [{ type: 'reject', target: literal }] })], context)
    expect(source).toContain('header :is "subject" "\\\\\\"; discard; #"')
    expect(source).toContain('reject "\\\\\\"; discard; #";')
    expect(source).not.toContain('UNTRUSTED_CACHE')
  })
  it('uses exact grouping/order, unconditional semantics and only used extensions', () => {
    const source = compileValidatedFilters([stored({ id: 'late', name: 'Late', priority: 9, conditions: [] }), stored({ id: 'disabled', priority: 1, enabled: false, actions: [{ type: 'reject', target: 'Never emitted' }] }), stored({ id: 'early', name: 'Early', priority: 2, matchAll: false, conditions: [{ field: 'subject', comparator: 'is', value: 'A' }, { field: 'body', comparator: 'matches', value: 'B*' }], actions: [{ type: 'keep' }] })], context)
    expect(source).toContain('anyof(header :is "subject" "A", body :text :matches "B*")')
    expect(source.indexOf('# rule: Early')).toBeLessThan(source.indexOf('# rule: Late'))
    expect(source).toContain('if true')
    expect(source).not.toContain('Never emitted')
    expect(source).not.toContain('relational')
    expect(source).not.toContain('envelope')
    expect(compileValidatedFilters([stored({ matchAll: true, conditions: [{ field: 'to', comparator: 'contains', value: 'A' }, { field: 'from', comparator: 'is', value: 'B' }] })], context)).toContain('if allof(')
  })
  it('validates all stored rules and the empty trusted context before any output', () => {
    expect(validateStoredFilterRule(stored(), context)).toMatchObject(context)
    expect(compileValidatedFilters([], context)).toBe('# managed by xPanel\nkeep;\n')
    const ownMailbox = stored({ ...mailboxContext })
    expect(compileValidatedFilters([ownMailbox], mailboxContext)).toContain('fileinto')
    const invalidRules = [stored({ accountId: 'foreign' }), stored({ accountId: null }), { ...ownMailbox, accountId: 'foreign' }, { ...ownMailbox, mailbox: 'sibling@example.test' }, stored({ mailbox: 'inbox@example.test' }), stored({ name: 'Injected\nkeep;' }), stored({ enabled: false, conditions: [null] }), stored({ createdAt: 'invalid' }), stored({ compiledSieve: 42 }), stored({ unknownMetadata: true }), stored({ actions: [{ type: 'fileinto', target: '../x' }] })]
    for (const rule of invalidRules) invalid(() => compileValidatedFilters([rule], 'scope' in rule && rule.scope === 'mailbox' ? mailboxContext : context))
    invalid(() => compileValidatedFilters([], { ...context, accountId: null } as unknown as FilterScopeContext))
    invalid(() => assertFilterContext(ownMailbox, context))
    invalid(() => compileValidatedFilters(Array(1), context))
  })
  it('enforces finite rule/input/output budgets even for disabled data', () => {
    invalid(() => compileValidatedFilters(Array(MAX_FILTER_RULES + 1).fill(stored()), context))
    invalid(() => compileValidatedFilters(Array.from({ length: 200 }, (_, index) => stored({ id: String(index), enabled: false, conditions: Array(50).fill({ field: 'subject', comparator: 'contains', value: 'a'.repeat(1024) }) })), context))
    expect(Buffer.byteLength(compileValidatedFilters([stored()], context))).toBeLessThanOrEqual(FILTER_COMPILATION_BUDGET_BYTES)
  })
})

describe('filter test message', () => {
  it('takes From, To and Subject before other headers and bounds every part', () => {
    expect(validateSampleMessage({ from: 'a@example.test', subject: 'Invoice', headers: [{ name: 'List-Id', value: '<news.example.test>' }], body: 'line one\nline two', size: 2048 }))
      .toEqual({ headers: [{ name: 'From', value: 'a@example.test' }, { name: 'Subject', value: 'Invoice' }, { name: 'List-Id', value: '<news.example.test>' }], body: 'line one\nline two', size: 2048 })
    for (const message of [null, { raw: 'x' }, { subject: 'a\nBcc: x' }, { headers: [{ name: 'Bad:Name', value: 'x' }] }, { headers: Array(51).fill({ name: 'X', value: 'y' }) }, { body: 'x'.repeat(65537) }, { size: -1 }, { size: 1.5 }]) invalid(() => validateSampleMessage(message))
  })
})

describe('pure filter revision', () => {
  it('binds context and raw content with stable keys, ignoring only derived cached source', () => {
    const first = stored(), equivalent = Object.fromEntries(Object.entries(first).reverse())
    expect(filterRevision(context, [first])).toMatch(/^[a-f0-9]{64}$/)
    expect(filterRevision(context, [first])).toBe(filterRevision(context, [equivalent]))
    expect(filterRevision(context, [first])).toBe(filterRevision(context, [{ ...first, compiledSieve: 'Different cache' }]))
    expect(filterRevision(context, [first])).not.toBe(filterRevision(context, [{ ...first, enabled: false }]))
    expect(filterRevision(context, [first])).not.toBe(filterRevision({ ...context, accountId: 'other' }, [first]))
    const malformed = { ...first, conditions: [null] }
    expect(filterRevision(context, [malformed])).toMatch(/^[a-f0-9]{64}$/)
    invalid(() => compileValidatedFilters([malformed], context))
    expect(malformed.conditions).toEqual([null])
  })
  it('preserves array ordering and rejects non-JSON or excessive projections', () => {
    const a = stored(), b = stored({ id: 'b' })
    expect(filterRevision(context, [a, b])).not.toBe(filterRevision(context, [b, a]))
    invalid(() => filterRevision(context, Array(MAX_FILTER_RULES + 1).fill(a)))
    invalid(() => filterRevision(context, [stored({ name: 'x'.repeat(FILTER_COMPILATION_BUDGET_BYTES + 1) })]))
    invalid(() => filterRevision(context, [stored({ extra: undefined })]))
    invalid(() => filterRevision(context, [stored({ conditions: Array(1) })]))
  })
})
