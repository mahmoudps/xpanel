import { describe, expect, it } from 'vitest'
import { MAILX_DEFAULTS, MAILX_SECTIONS, isMailxInvalid, parseMailxAdvanced, parseMailxCountry, parseMailxGreylist, parseMailxRouting, parseMailxSpamd, renderMailxMailboxSettings, renderMailxPostfix, renderMailxSpam, renderMailxSpamd } from './mailx-policy.ts'
import type { MailxMailboxSpam, MailxPolicies, MailxSaved, MailxSection } from './mailx-policy.ts'
import { MAILX_COUNTRY_CHECK, MAILX_RECONCILER_KEYS, isMailxAdvancedKey, isMailxCommand, mailxEngineRestartArgv, mailxPostconfSetArgv, mailxPostconfUnsetArgv, mailxRblRestrictions, mailxRblZones } from '../../../packages/os/src/mailx-command.ts'
import { services } from '@xpanel/render'

const at = { updatedAt: '2026-11-07T10:00:00.000Z', updatedBy: 'root' }
const saved = <S extends MailxSection>(section: S, policy: MailxPolicies[S], extra: Partial<MailxSaved['sections']> = {}): MailxSaved =>
  ({ sections: { ...Object.fromEntries(MAILX_SECTIONS.map(name => [name, null])), ...extra, [section]: { section, policy, ...at } } as MailxSaved['sections'], archives: [] })
const invalid = (read: () => unknown, field: string): void => {
  try { read() } catch (error) { expect(isMailxInvalid(error) && error.field).toBe(field); return }
  throw new Error('expected an invalid policy')
}

describe('spamd startup', () => {
  it('rejects 0 child processes and keeps the documented defaults', () => {
    invalid(() => parseMailxSpamd({ ...MAILX_DEFAULTS.spamd, children: 0 }), 'children')
    expect(parseMailxSpamd(MAILX_DEFAULTS.spamd)).toEqual({ allowedIps: ['127.0.0.1', '::1'], maxConnPerChild: 200, children: 1, timeoutTcp: 30, timeoutChild: 300 })
  })
  it('accepts 0 for the TCP timeout, addresses and networks, and refuses anything else', () => {
    expect(parseMailxSpamd({ ...MAILX_DEFAULTS.spamd, timeoutTcp: 0, allowedIps: ['192.0.2.0/24', '2001:db8::/32', '::1'] }).timeoutTcp).toBe(0)
    invalid(() => parseMailxSpamd({ ...MAILX_DEFAULTS.spamd, allowedIps: ['host.example; rm -rf /'] }), 'allowedIps')
    invalid(() => parseMailxSpamd({ ...MAILX_DEFAULTS.spamd, timeoutChild: 0 }), 'timeoutChild')
  })
  it('renders the arguments for both variable names through one drop-in', () => {
    const [env, conf] = renderMailxSpamd({ ...MAILX_DEFAULTS.spamd, children: 3 }, 'spamassassin', 'spamd.service')
    expect(env!.path).toBe('/etc/systemd/system/spamd.service.d/xpanel-startup.env')
    expect(env!.content).toContain('OPTIONS="--create-prefs --helper-home-dir --max-children=3 --max-conn-per-child=200 --timeout-tcp=30 --timeout-child=300 --allowed-ips=127.0.0.1,::1"')
    expect(env!.content).toContain('SPAMDOPTIONS="--create-prefs')
    expect(conf!.content).toContain('EnvironmentFile=-/etc/systemd/system/spamd.service.d/xpanel-startup.env')
  })
  it('reads an empty list as any address', () => {
    expect(renderMailxSpamd({ ...MAILX_DEFAULTS.spamd, allowedIps: [] }, 'spamassassin', 'spamassassin.service')[0]!.content).toContain('--allowed-ips=0.0.0.0/0,::/0')
  })
  it('maps the worker settings for rspamd', () => {
    expect(renderMailxSpamd(MAILX_DEFAULTS.spamd, 'rspamd', 'rspamd.service')[0]).toMatchObject({ path: '/etc/rspamd/local.d/worker-normal.inc', content: expect.stringContaining('count = 1;\nmax_tasks = 200;\ntask_timeout = 300s;\n') })
  })
  it('admits a restart only of a filter unit, as try-restart', () => {
    expect(isMailxCommand(mailxEngineRestartArgv('spamd.service'))).toBe(true)
    expect(isMailxCommand(['/usr/bin/systemctl', 'try-restart', '--', 'nginx.service'])).toBe(false)
  })
})

describe('country filter', () => {
  it('normalizes and refuses codes', () => {
    expect(parseMailxCountry({ blocked: ['RU', 'CN'] }).blocked).toEqual(['CN', 'RU'])
    invalid(() => parseMailxCountry({ blocked: ['cn'] }), 'blocked')
    invalid(() => parseMailxCountry({ blocked: ['CN', 'CN'] }), 'blocked')
  })
  it('checks the table before any DNS blocklist and after trusted clients', () => {
    const value = mailxRblRestrictions(['zen.example.test'], true)
    expect(value).toBe(`permit_mynetworks, permit_sasl_authenticated, ${MAILX_COUNTRY_CHECK}, reject_rbl_client zen.example.test`)
    expect(mailxRblZones(value)).toEqual(['zen.example.test'])
    expect(mailxRblZones(mailxRblRestrictions([], true))).toEqual([])
    expect(isMailxCommand(mailxPostconfSetArgv({ smtpd_client_restrictions: value }))).toBe(true)
  })
  it('keeps the blocklists of the server section and clears the check when nothing is blocked', () => {
    const server = { section: 'server', policy: { ...MAILX_DEFAULTS.server, rbl: ['zen.example.test'] }, ...at } as MailxSaved['sections']['server']
    expect(renderMailxPostfix(saved('country', { blocked: ['RU'] }, { server })).settings.smtpd_client_restrictions).toContain(MAILX_COUNTRY_CHECK)
    expect(renderMailxPostfix(saved('country', { blocked: [] }, { server })).settings.smtpd_client_restrictions).toBe(mailxRblRestrictions(['zen.example.test']))
    expect(renderMailxPostfix(saved('country', { blocked: [] })).settings.smtpd_client_restrictions).toBe('')
  })
})

describe('advanced options', () => {
  it('admits ordinary Postfix parameters and sets them last', () => {
    expect(parseMailxAdvanced({ postfix: { smtp_connect_timeout: '10s' } }).postfix).toEqual({ smtp_connect_timeout: '10s' })
    expect(renderMailxPostfix(saved('advanced', { postfix: { smtp_connect_timeout: '10s' } })).settings.smtp_connect_timeout).toBe('10s')
    expect(isMailxCommand(mailxPostconfSetArgv({ smtp_connect_timeout: '10s' }))).toBe(true)
    expect(isMailxCommand(mailxPostconfUnsetArgv(['smtp_connect_timeout']))).toBe(true)
  })
  it('never reaches a key another section or the reconciler owns, or a privileged one', () => {
    for (const key of ['myhostname', 'relayhost', 'smtpd_milters', 'virtual_transport', 'mailbox_command', 'mailbox_transport', 'default_transport', 'daemon_directory', 'mail_owner', 'default_privs', 'import_environment', 'alias_maps', 'sendmail_path', 'luser_relay', 'multi_instance_wrapper', 'alternate_config_directories', 'maillog_file', 'tls_config_file']) expect(isMailxAdvancedKey(key), key).toBe(false)
    invalid(() => parseMailxAdvanced({ postfix: { mailbox_command: '/bin/sh' } }), 'key')
    expect(isMailxCommand(['/usr/sbin/postconf', '-e', 'mailbox_command=/bin/sh'])).toBe(false)
  })
  it('refuses a value that could start another line', () => {
    invalid(() => parseMailxAdvanced({ postfix: { smtp_connect_timeout: '10s\nmailbox_command=/bin/sh' } }), 'value')
    invalid(() => parseMailxAdvanced({ postfix: { smtp_connect_timeout: ' 10s' } }), 'value')
  })
  it('names every key the reconciler renders into main.cf', () => {
    const os = { family: 'debian', paths: { postfixDir: '/etc/postfix', dovecotDir: '/etc/dovecot' } } as never
    const block = services.localDeliveryMainBlock(os, { tls: { certFile: '/etc/ssl/a.pem', keyFile: '/etc/ssl/a.key' }, outbound: { senderMap: '/etc/postfix/xpanel/sender_transport' } } as never)
    for (const key of block.split('\n').map(line => /^([a-z_]+) =/.exec(line)?.[1]).filter((key): key is string => !!key)) expect(MAILX_RECONCILER_KEYS, key).toContain(key)
  })
})

describe('per-domain greylisting', () => {
  const row: MailxMailboxSpam = { mailbox: 'a@on.test', accountId: 'a', serviceUserId: 'u', inherit: false, enabled: true, addHeaderScore: 6, allowlist: [], blocklist: [], spamBoxEnabled: false, autoDeleteScore: null }
  it('parses and sorts hosted names', () => {
    expect(parseMailxGreylist({ domains: ['b.test', 'a.test'] }).domains).toEqual(['a.test', 'b.test'])
    invalid(() => parseMailxGreylist({ domains: ['not a host'] }), 'domains')
  })
  it('greylists every unknown triplet of an enabled domain and nothing else', () => {
    const content = renderMailxMailboxSettings([], ['on.test']).content
    expect(content).toContain('rcpt = "@on.test";')
    expect(content).toContain('apply { actions { greylist = -100.0; } }')
    expect(renderMailxMailboxSettings([]).content).not.toContain('greylist')
  })
  it('repeats the action in a mailbox rule, because rspamd applies one rule per message', () => {
    expect(renderMailxMailboxSettings([row], ['on.test']).content).toContain('add_header = 6.0; greylist = -100.0;')
    expect(renderMailxMailboxSettings([row], ['off.test']).content).not.toContain('add_header = 6.0; greylist')
  })
  it('enables the rspamd module for a domain even without a server greylist score', () => {
    const policy = { ...MAILX_DEFAULTS.spam, greylistScore: null }
    expect(renderMailxSpam(policy, 'rspamd').find(file => file.path.endsWith('greylist.conf'))!.content).toContain('enabled = false;')
    expect(renderMailxSpam(policy, 'rspamd', undefined, 1).find(file => file.path.endsWith('greylist.conf'))!.content).toContain('enabled = true;')
  })
})

describe('owner routing rows', () => {
  it('stores a detected mode with its origin and keeps plain local as no row', () => {
    expect(parseMailxRouting({ domains: [{ domain: 'a.test', mode: 'local', auto: true }] }).domains).toEqual([{ domain: 'a.test', mode: 'local', auto: true }])
    expect(parseMailxRouting({ domains: [{ domain: 'a.test', mode: 'remote' }] }).domains).toEqual([{ domain: 'a.test', mode: 'remote', auto: false }])
    invalid(() => parseMailxRouting({ domains: [{ domain: 'a.test', mode: 'local', auto: false }] }), 'mode')
  })
})
