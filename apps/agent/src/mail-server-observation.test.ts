import { describe, expect, it, vi } from 'vitest'
import { handleMailServerObservationRoute, parsePostconfMain, parsePostconfMaster, readMailServerObservation } from './mail-server-observation.ts'
import type { MailServerCommandResult, MailServerObservationRouteContext } from './mail-server-observation.ts'
import { isMailServerCommand } from '../../../packages/os/src/mail-server-command.ts'

const now = () => new Date('2026-10-27T10:00:00Z')
const ok = (stdout: string): MailServerCommandResult => ({ ok: true, code: 0, stdout, stderr: '' })
const MAIN = [
  'alias_maps = hash:/etc/aliases',
  'compatibility_level = 3.6',
  'inet_interfaces = all',
  'mydestination =',
  'myhostname = host.example.test',
  'relayhost = [smtp.relay.example]:587',
  'smtp_sasl_auth_enable = yes',
  'smtp_sasl_password_maps = inline:{ [smtp.relay.example]:587=relayuser:S3cretPass }',
  'smtpd_relay_restrictions = permit_mynetworks,',
  '    permit_sasl_authenticated,',
  '\treject_unauth_destination',
  'virtual_mailbox_domains = texthash:/etc/postfix/xpanel/virtual_domains',
  'message_size_limit = 52428800',
  '',
].join('\n')
const MASTER = [
  'smtp       inet  n       -       y       -       -       smtpd',
  'submission inet  n       -       y       -       -       smtpd -o syslog_name=postfix/submission -o smtpd_tls_security_level=encrypt -o smtpd_sasl_auth_enable=yes -o smtp_sasl_password_maps=hash:/etc/postfix/other',
  '127.0.0.1:587 inet n - n - - smtpd -o { smtpd_client_restrictions = permit_sasl_authenticated, reject } -o {smtpd_tls_auth_only=yes}',
  'pickup     unix  n       -       y       60      1       pickup',
  'dovecot    unix  -       n       n       -       -       pipe flags=DRhu user=vmail argv=/usr/lib/dovecot/deliver -f ${sender} -d ${recipient}',
  '',
].join('\n')
const DOVECOT: Record<string, string> = { protocols: 'imap pop3 lmtp\n', listen: '*, ::\n', ssl: 'required\n', ssl_min_protocol: 'TLSv1.2\n', auth_mechanisms: 'plain login\n' }
const host = (overrides: Record<string, MailServerCommandResult | Error> = {}) => vi.fn(async (argv: string[]) => {
  expect(isMailServerCommand(argv)).toBe(true)
  const key = argv.join(' '), override = overrides[key]
  if (override instanceof Error) throw override
  if (override) return override
  if (key === '/usr/sbin/postconf -n') return ok(MAIN)
  if (key === '/usr/sbin/postconf -M') return ok(MASTER)
  const value = DOVECOT[argv[2]!]
  return value === undefined ? { ok: false, code: 89, stdout: '', stderr: 'doveconf: Fatal: Unknown setting: ' + argv[2] } : ok(value)
})

describe('postconf parsers', () => {
  it('parses name = value lines, empty values and whitespace continuation lines', () => {
    const settings = parsePostconfMain(MAIN)
    expect(settings.get('mydestination')).toBe('')
    expect(settings.get('relayhost')).toBe('[smtp.relay.example]:587')
    expect(settings.get('smtpd_relay_restrictions')).toBe('permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination')
  })
  it('refuses malformed, duplicated, leading-continuation and control-character output', () => {
    for (const text of ['relayhost [x]', '  relayhost = x', 'relayhost = a\nrelayhost = b', 'relay host = x', '# comment = x', 'relayhost = a\u0007b', 'relayhost=x']) expect(() => parsePostconfMain(text)).toThrow()
  })
  it('keeps inet services only, with allowlisted -o overrides including brace groups', () => {
    const services = parsePostconfMaster(MASTER)
    expect(services.map(item => item.service)).toEqual(['smtp', 'submission', '127.0.0.1:587'])
    expect(services[1]).toEqual({ service: 'submission', fields: 'inet n - y - - smtpd', options: { syslog_name: 'postfix/submission', smtpd_tls_security_level: 'encrypt', smtpd_sasl_auth_enable: 'yes' }, otherOptions: 1 })
    expect(services[2]!.options).toEqual({ smtpd_client_restrictions: 'permit_sasl_authenticated, reject', smtpd_tls_auth_only: 'yes' })
    expect(JSON.stringify(services)).not.toMatch(/password|vmail|deliver/)
  })
  it('parses a rendered multi-line master.cf entry the same way', () => {
    expect(parsePostconfMaster('127.0.0.1:587 inet n - n - - smtpd\n  -o syslog_name=postfix/submission\n  -o smtpd_tls_auth_only=yes\n')).toEqual([
      { service: '127.0.0.1:587', fields: 'inet n - n - - smtpd', options: { syslog_name: 'postfix/submission', smtpd_tls_auth_only: 'yes' }, otherOptions: 0 }])
  })
  it('refuses malformed master.cf entries', () => {
    for (const text of ['smtp inet n - y - smtpd', 'smtp tcp n - y - - smtpd', 'smtp inet x - y - - smtpd', 'smtp inet n - y - - smtpd -o', 'smtp inet n - y - - smtpd -o { a = b', 'smtp inet n - y - - smtpd -o =x',
      'smtp inet n - y - - smtpd\nsmtp inet n - y - - smtpd', '  -o a=b', 'sm$tp inet n - y - - smtpd', 'smtp inet n - y abc - smtpd']) expect(() => parsePostconfMaster(text)).toThrow()
    expect(() => parsePostconfMaster(Array.from({ length: 65 }, (_, index) => `${2000 + index} inet n - y - - smtpd`).join('\n'))).toThrow()
  })
})

describe('mail server observation', () => {
  it('returns allowlisted observed values only and never a credential', async () => {
    const view = await readMailServerObservation({ run: host(), now })
    expect(view).toMatchObject({ observedAt: '2026-10-27T10:00:00.000Z', postfix: { state: 'read' }, master: { state: 'read' }, dovecot: { state: 'read' } })
    expect(view.postfix.settings).toEqual({ myhostname: 'host.example.test', inet_interfaces: 'all', compatibility_level: '3.6', smtpd_relay_restrictions: 'permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination',
      relayhost: '[smtp.relay.example]:587', mydestination: '', virtual_mailbox_domains: 'texthash:/etc/postfix/xpanel/virtual_domains', alias_maps: 'hash:/etc/aliases', message_size_limit: '52428800' })
    expect(view.dovecot.settings).toEqual({ protocols: 'imap pop3 lmtp', listen: '*, ::', ssl: 'required', ssl_min_protocol: 'TLSv1.2', mail_location: null, auth_mechanisms: 'plain login' })
    expect(JSON.stringify(view)).not.toMatch(/S3cretPass|relayuser|sasl_password|smtp_sasl_auth_enable/)
  })
  it('marks each failed or malformed source unavailable without inventing values', async () => {
    const failed = await readMailServerObservation({ run: host({ '/usr/sbin/postconf -n': { ok: false, code: 1, stdout: '', stderr: 'fatal' }, '/usr/sbin/postconf -M': ok('garbage') }), now })
    expect(failed.postfix).toEqual({ state: 'unavailable', reason: 'command_failed', settings: {} })
    expect(failed.master).toEqual({ state: 'unavailable', reason: 'malformed_output', services: [] })
    const big = await readMailServerObservation({ run: host({ '/usr/sbin/postconf -n': ok('a = ' + 'x'.repeat(1024 * 1024)), '/usr/sbin/postconf -M': new Error('spawn') }), now })
    expect(big.postfix.reason).toBe('output_limit'); expect(big.master.reason).toBe('command_failed')
    const long = await readMailServerObservation({ run: host({ '/usr/sbin/postconf -n': ok('relayhost = ' + 'x'.repeat(5000)) }), now })
    expect(long.postfix.reason).toBe('malformed_output')
    const none = await readMailServerObservation({ run: async () => { throw new Error('missing') }, now })
    expect(none.dovecot).toEqual({ state: 'unavailable', reason: 'command_failed', settings: { protocols: null, listen: null, ssl: null, ssl_min_protocol: null, mail_location: null, auth_mechanisms: null } })
  })
  it('drops multi-line or control-character doveconf values', async () => {
    const view = await readMailServerObservation({ run: host({ '/usr/bin/doveconf -h protocols': ok('imap\npop3\n'), '/usr/bin/doveconf -h ssl': ok('yes\u001b[0m\n') }), now })
    expect(view.dovecot.settings).toMatchObject({ protocols: null, ssl: null, listen: '*, ::' })
  })
})

describe('agent mail server observation route', () => {
  const call = (path: string, ctx: MailServerObservationRouteContext, method = 'GET') => { const req = new Request('http://agent.local' + path, { method }); return handleMailServerObservationRoute(req, new URL(req.url), method, ctx) }
  const context = (overrides: Partial<MailServerObservationRouteContext> = {}): MailServerObservationRouteContext => ({ run: host(), now, assertRoot: vi.fn(async () => ({ actor: 'root' })), ...overrides })
  it('ignores unrelated paths without authorizing', async () => {
    const ctx = context()
    expect(await call('/host/mail/queue', ctx)).toBeNull()
    expect(ctx.assertRoot).not.toHaveBeenCalled()
  })
  it('serves root a no-store observation', async () => {
    const ctx = context(), response = (await call('/host/mail/server', ctx))!
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ postfix: { state: 'read' }, master: { state: 'read' } })
    expect(ctx.assertRoot).toHaveBeenCalledWith('mail.server.read')
  })
  it('refuses non-root, selectors, other methods and a missing host executor before running anything', async () => {
    const run = host()
    await expect(call('/host/mail/server', context({ run, assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN' }) } }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('/host/mail/server?setting=ssl_key', context({ run }))).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call('/host/mail/server', context({ run }), 'POST'))!.headers.get('allow')).toBe('GET')
    await expect(call('/host/mail/server', context({ run: null }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(run).not.toHaveBeenCalled()
  })
})
