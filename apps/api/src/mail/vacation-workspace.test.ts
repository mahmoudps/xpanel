import { describe, expect, it } from 'vitest'
import type { WebmailVacationConfig } from '../extended-routes.ts'
import { compileVacationWorkspace, parseVacationWorkspaceRequest, projectVacationWorkspace, vacationWorkspaceRevision, type VacationWorkspaceFields } from './vacation-workspace.ts'

const fields = (patch: Partial<VacationWorkspaceFields> = {}): VacationWorkspaceFields => ({ enabled: true, subject: 'Away from office', body: 'I will reply later.', htmlBody: '', startDate: null, endDate: null, replyIntervalHours: 48, ...patch })
const request = (patch: Record<string, unknown> = {}) => ({ ...fields(), expectedRevision: 'a'.repeat(64), ...patch })
const record = (patch: Partial<WebmailVacationConfig> = {}): WebmailVacationConfig => ({ ...fields(), mailbox: 'inbox@example.test', compiledSieve: '# stored source\n', updatedAt: '2026-10-26T12:00:00.123Z', ...patch })
const compile = (patch: Partial<VacationWorkspaceFields> = {}) => compileVacationWorkspace({ ...fields(patch), mailbox: 'inbox@example.test' })
const rejected = (value: unknown) => expect(() => parseVacationWorkspaceRequest(value)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))

describe('vacation workspace sealed fields', () => {
  it('trims only the subject and preserves raw message whitespace, markup and line endings', () => {
    const body = '  first\n.second\r\nlast\t ', htmlBody = ' <p title="a">raw</p>\n '
    expect(parseVacationWorkspaceRequest(request({ subject: '  Away  ', body, htmlBody }))).toEqual({ ...fields({ subject: 'Away', body, htmlBody }), expectedRevision: 'a'.repeat(64) })
  })
  it('permits a disabled blank draft and enabled HTML-only message', () => {
    expect(parseVacationWorkspaceRequest(request({ enabled: false, subject: '', body: '', htmlBody: '' })).enabled).toBe(false)
    expect(parseVacationWorkspaceRequest(request({ body: '', htmlBody: '<p>Away</p>' })).htmlBody).toBe('<p>Away</p>')
  })
  it.each([null, [], 'settings', 42])('refuses non-object request case %#', value => rejected(value))
  it('requires every explicit key and rejects authority, source and native metadata selectors', () => {
    for (const key of Object.keys(request())) { const value: Record<string, unknown> = request(); delete value[key]; rejected(value) }
    for (const key of ['mailbox', 'owner', 'compiledSieve', 'updatedAt', 'nativeApplied', 'application', 'unexpected']) rejected(request({ [key]: true }))
  })
  it('rejects primitive coercions instead of silently defaulting content', () => {
    for (const [key, value] of [['enabled', 'true'], ['enabled', 1], ['subject', null], ['body', 0], ['htmlBody', []], ['startDate', undefined], ['endDate', false]]) rejected(request({ [key as string]: value }))
  })
  it('requires a nonblank subject and at least one nonblank message when enabled', () => {
    rejected(request({ subject: ' \t ' })); rejected(request({ body: ' \r\n\t ', htmlBody: ' ' }))
  })
  it('rejects header controls before trimming and enforces the trimmed subject limit', () => {
    for (const control of ['\r', '\n', '\u0000', '\t', '\u0085', '\u2028']) rejected(request({ subject: `${control}Away` }))
    expect(parseVacationWorkspaceRequest(request({ subject: ` ${'x'.repeat(256)} ` })).subject).toHaveLength(256)
    rejected(request({ subject: 'x'.repeat(257) }))
  })
  it.each(['body', 'htmlBody'])('bounds %s in UTF-8 bytes and rejects unsafe controls', field => {
    expect(parseVacationWorkspaceRequest(request({ [field]: '\u00e9'.repeat(32768) }))[field as 'body' | 'htmlBody']).toHaveLength(32768)
    rejected(request({ [field]: '\u00e9'.repeat(32769) }))
    for (const control of ['\u0000', '\u0001', '\u000b', '\u007f', '\u0085']) rejected(request({ [field]: `first${control}last` }))
  })
  it.each([0, 8761, 1.5, '24', null, Number.NaN, Number.POSITIVE_INFINITY])('requires an exact bounded integer interval: case %#', value => rejected(request({ replyIntervalHours: value })))
  it('accepts both interval boundaries without rounding', () => {
    expect(parseVacationWorkspaceRequest(request({ replyIntervalHours: 1 })).replyIntervalHours).toBe(1)
    expect(parseVacationWorkspaceRequest(request({ replyIntervalHours: 8760 })).replyIntervalHours).toBe(8760)
  })
  it('accepts independent whole-second UTC bounds and strictly ordered windows', () => {
    for (const bounds of [{ startDate: '2026-11-01T00:00:00.000Z' }, { endDate: '2026-11-02T12:00:01.000Z' }, { startDate: '2026-11-01T00:00:00.000Z', endDate: '2026-11-02T12:00:01.000Z' }]) expect(parseVacationWorkspaceRequest(request(bounds))).toMatchObject(bounds)
    rejected(request({ startDate: '2026-11-01T00:00:00.000Z', endDate: '2026-11-01T00:00:00.000Z' }))
    rejected(request({ startDate: '2026-11-02T00:00:00.000Z', endDate: '2026-11-01T00:00:00.000Z' }))
  })
  it('rejects invalid, fractional, noncanonical or offset schedule values on either boundary', () => {
    for (const value of ['', '2026-11-01', '2026-02-30T00:00:00.000Z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00.001Z', '2026-11-01T00:00:00.000+00:00', '2026-11-01T00:00:00.000Z\n', 42]) {
      rejected(request({ startDate: value })); rejected(request({ endDate: value }))
    }
  })
  it('requires an exact lowercase captured revision without whitespace normalization', () => {
    for (const expectedRevision of [undefined, null, 42, '', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}\n`, ` ${'a'.repeat(64)}`]) rejected(request({ expectedRevision }))
  })
})

describe('vacation projection and current-value revisions', () => {
  it('strips unknown stored properties without inventing any defaults or timestamps', () => {
    const original = record(), projected = projectVacationWorkspace({ ...original, password: 'synthetic-private-marker', nativeApplied: true } as WebmailVacationConfig)
    expect(projected).toEqual(original)
    expect(projected).not.toBe(original)
    expect(projected).not.toHaveProperty('password')
    projected.body = 'Caller mutation'
    expect(original.body).toBe('I will reply later.')
  })
  it('keeps a stable distinct absence sentinel without creating a default record', () => {
    expect(vacationWorkspaceRevision(null)).toMatch(/^[0-9a-f]{64}$/)
    expect(vacationWorkspaceRevision(null)).toBe(vacationWorkspaceRevision(null))
    expect(vacationWorkspaceRevision(null)).not.toBe(vacationWorkspaceRevision(record({ enabled: false, subject: '', body: '' })))
  })
  it('ignores object key order and unknown properties but covers every known stored field', () => {
    const original = record(), revision = vacationWorkspaceRevision(original)
    expect(vacationWorkspaceRevision(Object.fromEntries(Object.entries(original).reverse()) as unknown as WebmailVacationConfig)).toBe(revision)
    expect(vacationWorkspaceRevision({ ...original, ignored: 'extra' } as WebmailVacationConfig)).toBe(revision)
    const changes: Partial<WebmailVacationConfig>[] = [{ mailbox: 'other@example.test' }, { enabled: false }, { subject: 'Changed' }, { body: 'Changed' }, { htmlBody: '<p>Changed</p>' }, { startDate: '2026-11-01T00:00:00.000Z' }, { endDate: '2026-11-02T00:00:00.000Z' }, { replyIntervalHours: 24 }, { compiledSieve: '# different\n' }, { updatedAt: '2026-10-26T12:00:00.124Z' }]
    for (const change of changes) expect(vacationWorkspaceRevision({ ...original, ...change })).not.toBe(revision)
    const reverted = { ...original, body: 'Changed' }
    reverted.body = original.body
    expect(vacationWorkspaceRevision(reverted)).toBe(revision)
  })
})

describe('vacation RFC source compiler (no installed engine qualification)', () => {
  it('generates no active action or extension requirement for a disabled draft', () => {
    expect(compile({ enabled: false, subject: '', body: '' })).toBe('# Vacation responder disabled\n')
  })
  it('retains whole-day intervals and uses exact seconds for other integer hours', () => {
    expect(compile()).toContain('vacation :days 2 ')
    expect(compile()).not.toContain('vacation-seconds')
    for (const hours of [1, 25, 8760]) {
      const script = compile({ replyIntervalHours: hours })
      if (hours % 24 === 0) expect(script).toContain(`:days ${hours / 24}`)
      else { expect(script).toContain(`:seconds ${hours * 3600}`); expect(script).toContain('"vacation-seconds"'); expect(script).not.toContain(':days') }
    }
  })
  it('escapes quoted strings, raw newlines and dot-prefixed lines without script termination', () => {
    const body = 'first\n.\n..second\n"; redirect "attacker@example.test"; #\npath\\folder'
    const script = compile({ subject: 'Away "quoted" \\ subject', body })
    expect(script).toContain(':subject "Away \\"quoted\\" \\\\ subject"')
    expect(script).toContain('first\r\n.\r\n..second\r\n\\"; redirect \\"attacker@example.test\\"; #\r\npath\\\\folder')
    expect(script).not.toContain('text:')
    expect(script.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  })
  it('validates direct compiler calls instead of trusting typed or legacy input', () => {
    expect(() => compileVacationWorkspace({ ...fields(), mailbox: 'inbox@example.test\r\nredirect' })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(() => compile({ subject: 'Unsafe\nheader' })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(() => compile({ replyIntervalHours: 1.5 })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })
  it('generates UTC start-inclusive/end-exclusive tests without comparing optional fractional suffixes', () => {
    const script = compile({ startDate: '2026-11-01T00:00:00.000Z', endDate: '2026-11-02T12:00:01.000Z' })
    expect(script).toContain('"date", "relational"')
    expect(script).toContain('if allof(currentdate :zone "+0000" :comparator "i;octet" :value "ge" "iso8601" "2026-11-01T00:00:00", currentdate :zone "+0000" :comparator "i;octet" :value "lt" "iso8601" "2026-11-02T12:00:01") {')
    for (const suffix of ['Z', '.001Z', '.999999Z']) {
      const prefix = '2026-11-01T00:00:00'
      expect(prefix + suffix >= prefix).toBe(true)
      expect(prefix + suffix < prefix).toBe(false)
    }
    expect(compile({ startDate: '2026-11-01T00:00:00.000Z' })).not.toContain('allof(')
    expect(compile({ endDate: '2026-11-02T12:00:01.000Z' })).toContain(':value "lt"')
  })
  it('encodes both message alternatives as bounded ASCII MIME rather than interpolating HTML', () => {
    const body = 'Plain line\n.dot\n--xpanel-vacation-alternative', htmlBody = '<p title="quote">Unicode \u00e9</p>\n<script>text only</script>'
    const script = compile({ body, htmlBody })
    expect(script).toContain(' :mime ')
    expect(script).toContain('Content-Type: multipart/alternative; boundary=\\"xpanel-vacation-alternative\\"')
    expect(script).toContain('Content-Type: text/plain; charset=UTF-8')
    expect(script).toContain('Content-Type: text/html; charset=UTF-8')
    expect(script.match(/Content-Transfer-Encoding: base64/g)).toHaveLength(2)
    expect(script).toContain(Buffer.from(body.replace(/\n/g, '\r\n')).toString('base64'))
    expect(script).not.toContain('<script>')
    const encoded = script.split('Content-Transfer-Encoding: base64\r\n\r\n').slice(1).map(part => part.split('\r\n--xpanel-vacation-alternative')[0]!)
    expect(encoded.map(part => Buffer.from(part, 'base64').toString('utf8'))).toEqual([body.replace(/\n/g, '\r\n'), htmlBody.replace(/\n/g, '\r\n')])
    for (const part of encoded) for (const line of part.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76)
  })
})
