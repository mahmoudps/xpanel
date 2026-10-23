import { describe, expect, it } from 'vitest'
import { XpanelError } from '../errors.ts'
import type { AuditEntry, Principal } from '../types.ts'
import { MAX_AUDIT_DETAIL_BYTES, REDACTED, auditEntry, redactSecrets } from './audit.ts'

const code = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof XpanelError) return e.code
    throw e
  }
}

const root: Principal = { kind: 'root', id: 'r', username: 'root' }
const reseller: Principal = { kind: 'reseller', id: 'rs1', username: 'acme' }

describe('auditEntry', () => {
  it('builds a complete entry with deterministic id and time when given', () => {
    const e = auditEntry(reseller, 'account.create', 'bob', { plan: 'gold' }, 'ok', { id: 'e1', now: new Date('2026-10-22T10:00:00Z') })
    expect(e).toEqual<AuditEntry>({
      id: 'e1',
      at: '2026-10-22T10:00:00.000Z',
      actor: 'reseller:acme',
      action: 'account.create',
      target: 'bob',
      detail: { plan: 'gold' },
      outcome: 'ok',
    })
  })

  it('generates a uuid and ISO timestamp by default', () => {
    const e = auditEntry(root, 'plan.delete', 'p1', {}, 'denied')
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(Number.isNaN(Date.parse(e.at))).toBe(false)
    expect(auditEntry(root, 'plan.delete', 'p1', {}, 'denied').id).not.toBe(e.id)
  })

  it('redacts secrets anywhere in the detail', () => {
    const id = '27ee9b5f-23d4-4e7e-abc1-c8311fc5da23'
    const e = auditEntry(root, 'account.create', 'bob', {
      username: 'bob',
      password: 'hunter2',
      nested: { apiToken: 't0k', db: { rootPass: 'x', host: 'localhost' } },
      list: [{ secretKey: 'abc', ok: 1 }, 'plain'],
      SSH_KEY: 'ssh-ed25519 AAAA',
      Passphrase: 'p',
      clientSecret: { deep: 'value' },
    }, 'ok', { id })
    expect(e.id).toBe(id)
    expect(e.detail).toEqual({
      username: 'bob',
      password: REDACTED,
      nested: { apiToken: REDACTED, db: { rootPass: REDACTED, host: 'localhost' } },
      list: [{ secretKey: REDACTED, ok: 1 }, 'plain'],
      SSH_KEY: REDACTED,
      Passphrase: REDACTED,
      clientSecret: REDACTED,
    })
    expect(JSON.stringify(e.detail)).not.toMatch(/hunter2|t0k|AAAA|abc/)
  })

  it('masks credentials carried inside values', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----'
    const e = auditEntry(root, 'database.import', 'mysql://bob:hunter2@db.local/wp', {
      dsn: 'postgres://app:p@ss@10.0.0.2:5432/app',
      clone: 'https://ghp_abc123@github.com/acme/site.git',
      argv: ['mysql', 'mysql://u:pw@h/db', 'https://example.com/a@b'],
      note: `uploaded ${pem} for bob`,
      blob: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow',
    }, 'ok')
    const json = JSON.stringify(e)
    expect(json).not.toMatch(/hunter2|p@ss|ss@10|ghp_abc123|b3BlbnNz|MIIEow|u:pw/)
    expect(e.target).toBe(`mysql://${REDACTED}@db.local/wp`)
    expect(e.detail.dsn).toBe(`postgres://${REDACTED}@10.0.0.2:5432/app`)
    expect(e.detail.argv).toEqual(['mysql', `mysql://${REDACTED}@h/db`, 'https://example.com/a@b'])
    expect(e.detail.note).toBe(`uploaded ${REDACTED} for bob`)
  })

  it('escapes bidi controls so a value cannot reorder what an operator reads', () => {
    const e = auditEntry(root, 'domain.create', 'evil\u202ecom.txt', { note: 'a\u2066b' }, 'ok')
    expect(e.target).toBe('evil\\u202ecom.txt')
    expect(e.detail.note).toBe('a\\u2066b')
  })

  it('stays fast on hostile long strings', () => {
    const started = Date.now()
    redactSecrets({
      a: 'a'.repeat(200_000),
      b: 'a:'.repeat(100_000),
      c: 'x://'.repeat(50_000),
      d: '-----BEGIN PRIVATE KEY-----'.repeat(5000),
      e: 'pass'.repeat(50_000),
      f: 'Bearer '.repeat(30_000),
    })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('rejects an invalid time or id instead of throwing a RangeError', () => {
    expect(code(() => auditEntry(root, 'a.b', 't', {}, 'ok', { now: new Date('nope') }))).toBe('VALIDATION')
    expect(code(() => auditEntry(root, 'a.b', 't', {}, 'ok', { id: 'x\ny' }))).toBe('VALIDATION')
    expect(code(() => auditEntry(root, 'a.b', 't', {}, 'ok', { id: '' }))).toBe('VALIDATION')
  })

  it('does not mutate the caller’s detail', () => {
    const detail = { password: 'x', inner: { token: 'y' } }
    auditEntry(root, 'a.b', 't', detail, 'ok')
    expect(detail).toEqual({ password: 'x', inner: { token: 'y' } })
  })

  it('escapes control characters so values cannot forge log lines', () => {
    const e = auditEntry(root, 'domain.create', 'evil.com\n2026-10-22 root deleted everything', { note: 'a\r\nb\u0000' }, 'failed')
    expect(e.target).not.toMatch(/[\n\r]/)
    expect(e.target).toContain('\\u000a')
    expect(e.detail.note).toBe('a\\u000d\\u000ab\\u0000')
  })

  it('survives cycles, deep nesting, odd values and prototype keys', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 20; i++) deep = { child: deep }
    const out = redactSecrets({
      cyclic,
      deep,
      big: 10n,
      when: new Date('2026-01-01T00:00:00Z'),
      bad: new Date('nope'),
      err: new Error('boom'),
      fn: () => 1,
      undef: undefined,
      inf: Number.POSITIVE_INFINITY,
      bytes: new Uint8Array(16),
      set: new Set([1, 2]),
      map: new Map<string, unknown>([['token', 'x'], ['ok', 'y']]),
      ...JSON.parse('{"__proto__": {"polluted": true}}'),
    })
    expect((out.cyclic as Record<string, unknown>).self).toBe('[Circular]')
    expect(JSON.stringify(out.deep)).toContain('[Truncated]')
    expect(out.big).toBe('10')
    expect(out.when).toBe('2026-01-01T00:00:00.000Z')
    expect(out.bad).toBe('Invalid Date')
    expect(out.err).toEqual({ name: 'Error', message: 'boom' })
    expect('fn' in out).toBe(false)
    expect('undef' in out).toBe(false)
    expect(out.inf).toBe('Infinity')
    expect(out.bytes).toBe('[Binary 16 bytes]')
    expect(out.set).toEqual([1, 2])
    expect(out.map).toEqual({ token: REDACTED, ok: 'y' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })

  it('truncates huge strings and arrays', () => {
    const out = redactSecrets({ s: 'x'.repeat(10_000), a: Array.from({ length: 500 }, (_, i) => i) })
    expect((out.s as string).length).toBeLessThan(2100)
    expect((out.a as unknown[]).length).toBe(201)
  })

  it('shares references without calling them cycles', () => {
    const shared = { v: 1 }
    expect(redactSecrets({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } })
  })

  it('rejects malformed actions and outcomes', () => {
    expect(code(() => auditEntry(root, 'Account Create', 't', {}, 'ok'))).toBe('VALIDATION')
    expect(code(() => auditEntry(root, '', 't', {}, 'ok'))).toBe('VALIDATION')
    expect(code(() => auditEntry(root, 'a.b\nc', 't', {}, 'ok'))).toBe('VALIDATION')
    expect(code(() => auditEntry(root, 'a.b', 't', {}, 'maybe' as 'ok'))).toBe('VALIDATION')
  })

  it('redacts other names credentials travel under but keeps boolean flags', () => {
    const out = redactSecrets({
      Authorization: 'Bearer abc',
      cookie: 'sid=1',
      pwd: 'x',
      otp: 123456,
      credentials: ['a'],
      jwtClaims: { sub: 'u' },
      passwordChanged: true,
      twoFactorAuth: false,
      apiKey: null,
    })
    expect(out).toEqual({
      Authorization: REDACTED,
      cookie: REDACTED,
      pwd: REDACTED,
      otp: REDACTED,
      credentials: REDACTED,
      jwtClaims: REDACTED,
      passwordChanged: true,
      twoFactorAuth: false,
      apiKey: null,
    })
  })

  it('masks auth headers and credential assignments inside free text', () => {
    const out = redactSecrets({
      header: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      basic: 'Basic YWxhZGRpbjpvcGVuc2VzYW1l',
      argv: ['mysqldump', '--password=hunter2', '--user=bob'],
      log: 'connect host=db password=s3cr3t user=bob',
      json: '{"apiKey": "zzz-123", "name": "ok"}',
      callback: 'https://example.com/cb?state=1&access_token=tok123&x=2',
      yaml: "client_secret: 'abc def'",
      prose: 'Basic plan upgraded to the Gold tier',
    })
    expect(JSON.stringify(out)).not.toMatch(/eyJhbGci|YWxhZGRp|hunter2|s3cr3t|zzz-123|tok123|abc def/)
    expect(out.argv).toEqual(['mysqldump', `--password=${REDACTED}`, '--user=bob'])
    expect(out.log).toBe(`connect host=db password=${REDACTED} user=bob`)
    expect(out.callback).toBe(`https://example.com/cb?state=1&access_token=${REDACTED}&x=2`)
    expect(out.prose).toBe('Basic plan upgraded to the Gold tier')
  })

  it('escapes lone surrogates, which Postgres jsonb refuses, and never splits a pair when truncating', () => {
    const out = redactSecrets({ lone: 'a\ud800b', low: '\udc00', pair: '😀', ['k\ud800']: 1 })
    expect(out.lone).toBe('a\\ud800b')
    expect(out.low).toBe('\\udc00')
    expect(out.pair).toBe('😀')
    expect(Object.keys(out)).toContain('k\\ud800')
    const emoji = '😀'.repeat(1500)
    const cutText = redactSecrets({ e: emoji }).e as string
    expect(cutText).toMatch(/\.\.\.\[truncated\]$/)
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(cutText)).toBe(false)
  })

  it('keeps the serialized detail within what the audit table accepts, quickly', () => {
    const size = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length
    const long = 'x'.repeat(5000)
    const huge = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, Array.from({ length: 300 }, () => long)]))
    const started = Date.now()
    const out = redactSecrets(huge)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(size(out)).toBeLessThanOrEqual(MAX_AUDIT_DETAIL_BYTES)
    expect(Object.keys(out).length).toBeGreaterThan(1)
    expect(size(auditEntry(root, 'a.b', 't', huge, 'ok').detail)).toBeLessThanOrEqual(MAX_AUDIT_DETAIL_BYTES)
    // multi-byte text is measured in UTF-8 bytes, not characters
    const arabic = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 'ب'.repeat(2000)]))
    expect(size(redactSecrets(arabic))).toBeLessThanOrEqual(MAX_AUDIT_DETAIL_BYTES)
    // a detail that fits is left whole
    expect(redactSecrets({ a: 'x'.repeat(1000), b: [1, 2, 3] })).toEqual({ a: 'x'.repeat(1000), b: [1, 2, 3] })
  })

  it('survives a throwing getter', () => {
    const detail = { ok: 1 }
    Object.defineProperty(detail, 'boom', { enumerable: true, get: () => { throw new Error('no') } })
    expect(redactSecrets(detail)).toEqual({ ok: 1, boom: '[Unreadable]' })
  })

  it('refuses a malformed principal instead of crashing', () => {
    expect(code(() => auditEntry(null as unknown as Principal, 'a.b', 't', {}, 'ok'))).toBe('VALIDATION')
    expect(code(() => auditEntry({ kind: 'admin', id: 'x', username: 'x' } as unknown as Principal, 'a.b', 't', {}, 'ok'))).toBe('VALIDATION')
    expect(code(() => auditEntry({ kind: 'root', id: 'x', username: '' } as Principal, 'a.b', 't', {}, 'ok'))).toBe('VALIDATION')
    expect(auditEntry({ kind: 'user', id: 'u', username: 'bob\nroot', accountId: 'a' }, 'a.b', 't', {}, 'ok').actor).toBe('user:bob\\u000aroot')
  })

  it('tolerates a missing detail', () => {
    expect(auditEntry(root, 'a.b', 't', undefined as unknown as Record<string, unknown>, 'ok').detail).toEqual({})
  })
})
