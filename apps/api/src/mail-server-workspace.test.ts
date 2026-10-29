import { describe, expect, it, vi } from 'vitest'
import { profileFor } from '@xpanel/os'
import { services as render } from '@xpanel/render'
import type { AuthenticatedCaller } from './auth.ts'
import { buildMailServerView, handleMailServerWorkspaceRoute, projectMailServerObservation, renderedMailServerDesired } from './mail-server-workspace.ts'
import type { MailServerSaved, MailServerWorkspaceHelpers } from './mail-server-workspace.ts'
import { readMailServerObservation } from '../../agent/src/mail-server-observation.ts'
import { MAIL_SERVER_PAGE_KEYS, MASTER_OBSERVED_OPTIONS, POSTFIX_OBSERVED_KEYS } from '../../../packages/os/src/mail-server-command.ts'

const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const root = { principal: { kind: 'root', id: 'root-1', username: 'root' } } as AuthenticatedCaller
const now = () => new Date('2026-10-27T10:00:00Z')
const DOVECOT: Record<string, string> = { protocols: 'imap pop3 lmtp\n', listen: '*, ::\n', ssl: 'required\n', ssl_min_protocol: 'TLSv1.2\n', auth_mechanisms: 'plain login\n' }
const observe = (main = render.localDeliveryMainBlock(os) + '\nmyhostname = host.example.test\nmessage_size_limit = 52428800\nrelayhost =\n',
  master = 'smtp inet n - y - - smtpd\n' + render.localSubmissionMasterBlock(os).replace('smtpd_client_restrictions=permit_sasl_authenticated,reject', '{ smtpd_client_restrictions = permit_sasl_authenticated, reject }') + '\n465 inet n - y - - smtpd -o smtpd_tls_wrappermode=yes\n') =>
  readMailServerObservation({ now, run: async argv => argv[0] === '/usr/sbin/postconf' ? { ok: true, code: 0, stdout: argv[1] === '-n' ? main : master, stderr: '' }
    : DOVECOT[argv[2]!] ? { ok: true, code: 0, stdout: DOVECOT[argv[2]!]!, stderr: '' } : { ok: false, code: 89, stdout: '', stderr: 'Unknown setting' } })
const saved = {
  accounts: [{ id: 'a1', username: 'alice', status: 'active' }, { id: 'a2', username: 'gone', status: 'terminating' }],
  domains: [{ id: 'd1', accountId: 'a1', name: 'example.test' }, { id: 'd2', accountId: 'a1', name: 'shop.example.test' }, { id: 'd3', accountId: 'a1', name: 'nomail.test' },
    { id: 'd4', accountId: 'a1', name: 'nozone.test' }, { id: 'd5', accountId: 'a2', name: 'old.test' }],
  serviceUsers: [{ domainId: 'd1', services: { email: true } }, { domainId: 'd1', services: { email: true } }, { domainId: 'd2', services: { email: true } }, { domainId: 'd3', services: { email: false } },
    { domainId: 'd4', services: { email: true } }, { domainId: 'd5', services: { email: true } }],
  zones: [{ name: 'example.test', records: [{ name: '@', type: 'MX', priority: 10, content: 'mail.example.test' }, { name: 'shop', type: 'A', priority: null, content: '192.0.2.1' }] },
    { name: 'old.test', records: [{ name: '@', type: 'MX', priority: 10, content: 'mail.old.test' }] }],
} as unknown as MailServerSaved
const call = (path: string, helpers: MailServerWorkspaceHelpers, method = 'GET') => { const req = new Request('http://localhost' + path, { method }); return handleMailServerWorkspaceRoute(req, new URL(req.url), method, helpers) }
const helpers = (overrides: Partial<MailServerWorkspaceHelpers> = {}) => {
  const events: string[] = []
  const value: MailServerWorkspaceHelpers = { os, requireCaller: vi.fn(async () => { events.push('auth'); return root }), assertRoot: vi.fn(async (_caller, action: string) => { events.push('root:' + action) }),
    readObservation: vi.fn(async () => { events.push('agent:read'); return JSON.parse(JSON.stringify(await observe())) }), readSaved: vi.fn(async () => { events.push('saved'); return saved }), ...overrides }
  return { value, events }
}
const row = (body: { settings: { key: string }[] }, key: string) => body.settings.find(item => item.key === key)

describe('mail server desired state', () => {
  it('parses the reconciler-rendered main.cf block, submission service and Dovecot auth settings', () => {
    const desired = renderedMailServerDesired(os)!
    expect(desired.main.get('virtual_transport')).toBe('lmtp:unix:private/dovecot-lmtp')
    expect(desired.main.get('smtpd_sasl_auth_enable')).toBe('no')
    expect(desired.master).toEqual([expect.objectContaining({ service: '127.0.0.1:587', fields: 'inet n - n - - smtpd', otherOptions: 0 })])
    expect(desired.dovecot.get('auth_mechanisms')).toBe('plain login')
    expect(renderedMailServerDesired(undefined)).toBeNull()
  })
  it('shows every rendered parameter and override on some page', () => {
    const desired = renderedMailServerDesired(os)!
    for (const key of desired.main.keys()) expect(POSTFIX_OBSERVED_KEYS).toContain(key)
    for (const key of Object.keys(desired.master[0]!.options)) expect(MASTER_OBSERVED_OPTIONS).toContain(key)
    expect(Object.values(MAIL_SERVER_PAGE_KEYS).flat().length).toBe(POSTFIX_OBSERVED_KEYS.length)
  })
})

describe('API mail server workspace', () => {
  it('leaves unrelated routes untouched', async () => {
    const { value } = helpers()
    for (const path of ['/api/server/mail-server', '/api/server/mail-server/relay', '/api/server/mail-queue']) expect(await call(path, value)).toBeNull()
    expect(value.requireCaller).not.toHaveBeenCalled()
  })
  it('returns 403 for non-root and rejects other methods and selectors before contacting the agent', async () => {
    const denied = helpers({ assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN', status: 403 }) } })
    await expect(call('/api/server/mail-server/server', denied.value)).rejects.toMatchObject({ status: 403 })
    const { value } = helpers()
    expect((await call('/api/server/mail-server/server', value, 'POST'))!.headers.get('allow')).toBe('GET')
    await expect(call('/api/server/mail-server/server?key=smtp_sasl_password_maps', value)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(value.readObservation).not.toHaveBeenCalled(); expect(denied.value.readObservation).not.toHaveBeenCalled()
  })
  it('compares observed and rendered settings on the server page and re-checks root after the reads', async () => {
    const { value, events } = helpers()
    const response = (await call('/api/server/mail-server/server', value))!
    const body = await response.json()
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(events).toEqual(['auth', 'root:server.mail-server.read', 'agent:read', 'auth', 'root:server.mail-server.read'])
    expect(body).toMatchObject({ page: 'server', host: 'connected', observedAt: '2026-10-27T10:00:00.000Z', editable: true, sources: { postfix: 'read', master: 'read', dovecot: 'read', desired: 'rendered' }, domains: [] })
    expect(row(body, 'smtpd_milters')).toEqual({ source: 'postfix', key: 'smtpd_milters', observed: 'local:opendkim/opendkim.sock', desired: 'local:opendkim/opendkim.sock', state: 'match' })
    expect(row(body, 'myhostname')).toMatchObject({ observed: 'host.example.test', desired: null, state: 'not-managed' })
    expect(row(body, 'smtpd_banner')).toMatchObject({ observed: null, desired: null, state: 'not-managed' })
    expect(body.settings.filter((item: { source: string }) => item.source === 'dovecot')).toEqual([
      { source: 'dovecot', key: 'protocols', observed: 'imap pop3 lmtp', desired: null, state: 'not-managed' }, { source: 'dovecot', key: 'listen', observed: '*, ::', desired: null, state: 'not-managed' },
      { source: 'dovecot', key: 'ssl', observed: 'required', desired: null, state: 'not-managed' }, { source: 'dovecot', key: 'ssl_min_protocol', observed: 'TLSv1.2', desired: null, state: 'not-managed' },
      ...['ssl_cipher_list', 'ssl_prefer_server_ciphers', 'ssl_server_prefer_ciphers', 'ssl_cert', 'ssl_key', 'ssl_server_cert_file', 'ssl_server_key_file'].map(key => ({ source: 'dovecot', key, observed: null, desired: null, state: 'not-managed' })),
      { source: 'dovecot', key: 'mail_location', observed: null, desired: null, state: 'not-managed' }, { source: 'dovecot', key: 'auth_mechanisms', observed: 'plain login', desired: 'plain login', state: 'match' }])
    expect(body.services.map((item: { service: string; state: string }) => [item.service, item.state])).toEqual([['127.0.0.1:587', 'match'], ['smtp', 'not-managed'], ['465', 'not-managed']])
    expect(body.services[0].options.find((item: { key: string }) => item.key === 'smtpd_client_restrictions')).toEqual({ key: 'smtpd_client_restrictions', observed: 'permit_sasl_authenticated, reject', desired: 'permit_sasl_authenticated,reject', state: 'match' })
  })
  it('reports drift for changed, missing and altered managed values', async () => {
    const main = render.localDeliveryMainBlock(os).replace('milter_default_action = accept', 'milter_default_action = tempfail').replace(/^smtpd_sasl_path = .*$/m, '')
    const { value } = helpers({ readObservation: async () => JSON.parse(JSON.stringify(await observe(main, render.localSubmissionMasterBlock(os).replace('smtpd_tls_auth_only=yes', 'smtpd_tls_auth_only=no')))) })
    const body = await (await call('/api/server/mail-server/server', value))!.json()
    expect(row(body, 'milter_default_action')).toMatchObject({ observed: 'tempfail', desired: 'accept', state: 'drift' })
    expect(row(body, 'smtpd_sasl_path')).toMatchObject({ observed: null, desired: 'private/auth', state: 'drift' })
    expect(body.services[0]).toMatchObject({ service: '127.0.0.1:587', state: 'drift' })
    const missing = helpers({ readObservation: async () => JSON.parse(JSON.stringify(await observe(undefined, 'smtp inet n - y - - smtpd\n'))) })
    const services = (await (await call('/api/server/mail-server/server', missing.value))!.json()).services
    expect(services[0]).toMatchObject({ service: '127.0.0.1:587', observed: null, state: 'drift' })
  })
  it('keeps desired and saved data truthful without a host agent or with an unverifiable observation', async () => {
    const offline = await (await call('/api/server/mail-server/server', helpers({ readObservation: undefined }).value))!.json()
    expect(offline).toMatchObject({ host: 'not-connected', observedAt: null, sources: { postfix: 'unavailable', master: 'unavailable', dovecot: 'unavailable', desired: 'rendered' } })
    expect(row(offline, 'smtpd_milters')).toMatchObject({ observed: null, state: 'unknown' })
    expect(row(offline, 'myhostname')).toMatchObject({ state: 'not-managed' })
    const leaked = helpers({ readObservation: async () => { const view = JSON.parse(JSON.stringify(await observe())); view.postfix.settings.smtp_sasl_password_maps = 'inline:{ relay=user:S3cret }'; return view } })
    const body = await (await call('/api/server/mail-server/server', leaked.value))!.json()
    expect(body.host).toBe('unverified'); expect(JSON.stringify(body)).not.toContain('S3cret')
    const thrown = await (await call('/api/server/mail-server/routing', helpers({ readObservation: async () => { throw Object.assign(new Error('refused'), { code: 'PRECONDITION_FAILED' }) } }).value))!.json()
    expect(thrown).toMatchObject({ host: 'unverified', domains: expect.arrayContaining([expect.objectContaining({ domain: 'example.test' })]) })
    const undesired = await (await call('/api/server/mail-server/server', helpers({ os: undefined }).value))!.json()
    expect(undesired.sources.desired).toBe('unavailable')
    expect(undesired.settings.every((item: { state: string; desired: unknown }) => item.state === 'unknown' && item.desired === null)).toBe(true)
  })
  it('lists hosted mail domains with saved MX expectations on the routing page', async () => {
    const { value, events } = helpers()
    const body = await (await call('/api/server/mail-server/routing', value))!.json()
    expect(events).toContain('saved')
    expect(body.services).toEqual([])
    expect(row(body, 'virtual_mailbox_domains')).toMatchObject({ desired: 'texthash:/etc/postfix/xpanel/virtual_domains', state: 'match' })
    expect(row(body, 'relayhost')).toMatchObject({ observed: '', desired: null, state: 'not-managed' })
    expect(body.domains).toEqual([
      { domain: 'example.test', account: 'alice', mailboxes: 2, zone: 'example.test', mx: [{ priority: 10, host: 'mail.example.test' }], state: 'mx-saved', mode: 'local' },
      { domain: 'nomail.test', account: 'alice', mailboxes: 0, zone: null, mx: [], state: 'no-mailboxes', mode: 'local' },
      { domain: 'nozone.test', account: 'alice', mailboxes: 1, zone: null, mx: [], state: 'zone-missing', mode: 'local' },
      { domain: 'old.test', account: 'gone', mailboxes: 0, zone: 'old.test', mx: [{ priority: 10, host: 'mail.old.test' }], state: 'no-mailboxes', mode: 'local' },
      { domain: 'shop.example.test', account: 'alice', mailboxes: 1, zone: 'example.test', mx: [], state: 'mx-missing', mode: 'local' }])
    const many = { ...saved, domains: Array.from({ length: 2001 }, (_, index) => ({ id: 'x' + index, accountId: 'a1', name: `d${String(index).padStart(4, '0')}.test` })) } as unknown as MailServerSaved
    const view = buildMailServerView('routing', null, 'not-connected', null, many)
    expect(view.domains).toHaveLength(2000); expect(view.truncated).toBe(true)
  })
  it('shows limits and submission services only on the outbound page', async () => {
    const body = await (await call('/api/server/mail-server/outbound', helpers().value))!.json()
    expect(body.settings.map((item: { key: string }) => item.key)).toEqual([...MAIL_SERVER_PAGE_KEYS.outbound])
    expect(row(body, 'message_size_limit')).toMatchObject({ observed: '52428800', desired: null, state: 'not-managed' })
    expect(body.services.map((item: { service: string }) => item.service)).toEqual(['127.0.0.1:587', '465'])
    expect(body.domains).toEqual([])
  })
  it('compares the saved server mail policy and shows each domain route, or no rendered column when the policy needs review', async () => {
    const at = { updatedAt: '2026-10-28T09:00:00.000Z', updatedBy: 'root' }
    const none = { spam: null, relay: null, bcc: null, marketing: null, server: null, routing: null }
    const policy = { sections: { ...none, server: { section: 'server' as const, ...at, policy: { postfix: { myhostname: 'host.example.test', message_size_limit: '104857600' }, dovecot: { ssl_min_protocol: 'TLSv1.3' }, rbl: ['zen.spamhaus.org'], certificates: { smtp: 'c1', submission: null, imap: null } } },
      routing: { section: 'routing' as const, ...at, policy: { domains: [{ domain: 'nozone.test', mode: 'remote' as const }] } } }, archives: [] }
    const server = await (await call('/api/server/mail-server/server', helpers({ readMailPolicy: async () => policy }).value))!.json()
    expect(row(server, 'myhostname')).toMatchObject({ observed: 'host.example.test', desired: 'host.example.test', state: 'match' })
    expect(row(server, 'smtpd_client_restrictions')).toMatchObject({ observed: null, desired: 'permit_mynetworks, permit_sasl_authenticated, reject_rbl_client zen.spamhaus.org', state: 'drift' })
    expect(row(server, 'ssl_min_protocol')).toMatchObject({ observed: 'TLSv1.2', desired: 'TLSv1.3', state: 'drift' })
    expect(server.services.find((item: { service: string }) => item.service === 'smtp').options).toContainEqual({ key: 'smtpd_tls_cert_file', observed: null, desired: '/etc/xpanel/ssl/c1/fullchain.pem', state: 'drift' })
    const outbound = await (await call('/api/server/mail-server/outbound', helpers({ readMailPolicy: async () => policy }).value))!.json()
    expect(row(outbound, 'message_size_limit')).toMatchObject({ observed: '52428800', desired: '104857600', state: 'drift' })
    const routing = await (await call('/api/server/mail-server/routing', helpers({ readMailPolicy: async () => policy }).value))!.json()
    expect(routing.domains.find((item: { domain: string }) => item.domain === 'nozone.test').mode).toBe('remote')
    const review = await (await call('/api/server/mail-server/server', helpers({ readMailPolicy: async () => { throw new Error('saved_policy_review') } }).value))!.json()
    // The chosen mail-client certificate is compared on main.cf and, without an IMAP choice, on Dovecot in the host dialect.
    const client = { ...policy, sections: { ...policy.sections, server: { ...policy.sections.server, policy: { ...policy.sections.server.policy, certificates: { smtp: null, submission: 'c2', imap: null } } } } }
    const older = await (await call('/api/server/mail-server/server', helpers({ readMailPolicy: async () => client }).value))!.json()
    expect(row(older, 'smtpd_tls_cert_file')).toMatchObject({ desired: '/etc/xpanel/ssl/c2/fullchain.pem', state: 'drift' })
    expect(row(older, 'ssl_cert')).toMatchObject({ desired: '</etc/xpanel/ssl/c2/fullchain.pem', state: 'drift' })
    expect(row(older, 'ssl_key')).toMatchObject({ desired: '</etc/xpanel/ssl/c2/privkey.pem' })
    expect(row(older, 'ssl_server_cert_file')).toMatchObject({ desired: null, state: 'not-managed' })
    const v24 = async () => { const view = JSON.parse(JSON.stringify(await observe())); view.dovecot.settings.ssl_server_cert_file = '/etc/xpanel/ssl/c2/fullchain.pem'; return view }
    const newer = await (await call('/api/server/mail-server/server', helpers({ readMailPolicy: async () => client, readObservation: v24 }).value))!.json()
    expect(row(newer, 'ssl_server_cert_file')).toMatchObject({ observed: '/etc/xpanel/ssl/c2/fullchain.pem', desired: '/etc/xpanel/ssl/c2/fullchain.pem', state: 'match' })
    expect(row(newer, 'ssl_cert')).toMatchObject({ desired: null, state: 'not-managed' })
    expect(review.sources.desired).toBe('unavailable')
  })
  it('refuses to return data when root authority changes during the read', async () => {
    let calls = 0
    const { value } = helpers({ requireCaller: async () => (++calls === 1 ? root : { principal: { kind: 'root', id: 'root-2', username: 'other' } }) as AuthenticatedCaller })
    await expect(call('/api/server/mail-server/routing', value)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('mail server observation projection', () => {
  it('accepts the agent shape and refuses anything outside the allowlist or bounds', async () => {
    const good = JSON.parse(JSON.stringify(await observe()))
    expect(projectMailServerObservation(good)).toEqual(good)
    const variants: ((view: Record<string, any>) => void)[] = [
      view => { view.postfix.settings.smtp_sasl_password_maps = 'hash:/etc/postfix/sasl_passwd' }, view => { view.postfix.settings.relayhost = 'x'.repeat(4097) },
      view => { view.postfix.settings.relayhost = 'a\u0007b' }, view => { view.postfix.state = 'unavailable'; view.postfix.reason = 'command_failed' }, view => { view.postfix.reason = 'command_failed' },
      view => { delete view.dovecot.settings.ssl }, view => { view.dovecot.settings.ssl_key = '-----BEGIN PRIVATE KEY-----' }, view => { view.dovecot.settings.extra_key = '/etc/ssl/key.pem' }, view => { view.master.services[0].fields = 'unix n - y - - smtpd' },
      view => { view.master.services.push(view.master.services[0]) }, view => { view.master.services[0].options.smtp_sasl_password_maps = 'x' }, view => { view.observedAt = 'yesterday' },
      view => { view.master.services = Array.from({ length: 65 }, (_, index) => ({ ...view.master.services[0], service: String(1000 + index) })) },
    ]
    for (const change of variants) { const view = JSON.parse(JSON.stringify(good)); change(view); expect(() => projectMailServerObservation(view)).toThrow() }
  })
})
