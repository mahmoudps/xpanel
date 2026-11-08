import { describe, expect, it } from 'vitest'
import { AUTOSSL_DEFAULT, OUTBOUND_SPAM_DEFAULT, parseAutoDns, parseAutoSsl, parseNotificationTemplate, parseOutboundSpam, parseWebdiskTls, WEBDISK_TLS_DEFAULT } from './mail-cert-policy.ts'
import { MAILX_DEFAULTS, parseMailxOutbound, renderMailxPostfix } from './mailx-policy.ts'
import type { MailxSaved } from './mailx-policy.ts'
import { MAILX_MAPS, MAILX_POSTCONF_KEYS } from '../../../packages/os/src/mailx-command.ts'

describe('Web Disk TLS policy', { tags: ['unit'] }, () => {
  it('keeps the defaults and orders the protocols', () => {
    expect(parseWebdiskTls(WEBDISK_TLS_DEFAULT)).toEqual(WEBDISK_TLS_DEFAULT)
    expect(parseWebdiskTls({ protocols: ['TLSv1.3', 'TLSv1.2'], ciphers: 'ECDHE+AESGCM' }).protocols).toEqual(['TLSv1.2', 'TLSv1.3'])
  })
  it.each(['TLSv1', 'TLSv1.1', 'SSLv3'])('refuses %s as VALIDATION', protocol => {
    expect(() => parseWebdiskTls({ protocols: [protocol], ciphers: 'ECDHE+AESGCM' })).toThrowError(expect.objectContaining({ code: 'VALIDATION' }))
  })
  it.each(['ECDHE+AESGCM;include /etc/passwd', 'ALL', 'RC4-SHA:RC4', 'with space'])('refuses the cipher list %s', ciphers => {
    expect(() => parseWebdiskTls({ protocols: ['TLSv1.2'], ciphers })).toThrowError(expect.objectContaining({ code: 'VALIDATION' }))
  })
  it('refuses an empty protocol list', () => expect(() => parseWebdiskTls({ protocols: [], ciphers: 'ECDHE+AESGCM' })).toThrow())
})

describe('notification template grammar', { tags: ['unit'] }, () => {
  const version = { subject: 'Hello {account}', body: 'On {server}' }
  it('accepts listed variables in both languages', () => expect(parseNotificationTemplate('account.suspended', { en: version, ar: version }).ar.subject).toBe('Hello {account}'))
  it('refuses an unknown variable and names it', () => {
    expect(() => parseNotificationTemplate('account.suspended', { en: { subject: 'x', body: 'Hi {nickname}' }, ar: version })).toThrowError(expect.objectContaining({ code: 'VALIDATION', message: expect.stringContaining('{nickname}'), detail: expect.objectContaining({ variable: 'nickname' }) }))
  })
  it('blocks a missing translation', () => {
    expect(() => parseNotificationTemplate('account.suspended', { en: version, ar: { subject: ' ', body: '' } })).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ reason: 'missing_translation', locale: 'ar' }) }))
  })
  it('refuses a stray brace, a header line break and an unknown event', () => {
    expect(() => parseNotificationTemplate('account.suspended', { en: { subject: 'x', body: 'a } b' }, ar: version })).toThrow()
    expect(() => parseNotificationTemplate('account.suspended', { en: { subject: 'x\r\nBcc: a@b', body: 'b' }, ar: version })).toThrow()
    expect(() => parseNotificationTemplate('nope', { en: version, ar: version })).toThrow()
  })
})

describe('saved policies', { tags: ['unit'] }, () => {
  it('reads the defaults back and refuses other fields', () => {
    expect(parseAutoSsl(AUTOSSL_DEFAULT)).toEqual(AUTOSSL_DEFAULT)
    expect(parseOutboundSpam(OUTBOUND_SPAM_DEFAULT)).toEqual(OUTBOUND_SPAM_DEFAULT)
    expect(() => parseAutoSsl({ ...AUTOSSL_DEFAULT, extra: 1 })).toThrow()
    expect(() => parseAutoSsl({ ...AUTOSSL_DEFAULT, renewDays: 0 })).toThrow()
  })
  it('normalises a limit target and refuses a duplicate', () => {
    const rule = { scope: 'mailbox', target: 'Sales@Example.com', hourly: 10, daily: 0 }
    expect(parseOutboundSpam({ ...OUTBOUND_SPAM_DEFAULT, rules: [rule] }).rules[0]!.target).toBe('sales@example.com')
    expect(() => parseOutboundSpam({ ...OUTBOUND_SPAM_DEFAULT, rules: [rule, rule] })).toThrow()
    expect(() => parseOutboundSpam({ ...OUTBOUND_SPAM_DEFAULT, rules: [{ ...rule, target: 'not an address' }] })).toThrow()
  })
  it('takes the Cloudflare TTL values', () => {
    expect(parseAutoDns({ enabled: true, ttl: 1, proxied: false }).ttl).toBe(1)
    expect(() => parseAutoDns({ enabled: true, ttl: 30, proxied: false })).toThrow()
  })
})

describe('outbound hold section', { tags: ['unit'] }, () => {
  const saved = (policy: { senders: string[]; uids: number[] }): MailxSaved => ({ sections: { outbound: { section: 'outbound', policy, updatedAt: '', updatedBy: 'x' } } as unknown as MailxSaved['sections'], archives: [] })
  it('renders HOLD tables and the two parameters, each admitted by the reviewed grammar', () => {
    const plan = renderMailxPostfix(saved({ senders: ['alice.test', 'sales@bob.test'], uids: [1001] }))
    expect(plan.settings.smtpd_data_restrictions).toBe(`check_sender_access texthash:${MAILX_MAPS.outboundHold}`)
    expect(plan.settings.header_checks).toBe(`regexp:${MAILX_MAPS.outboundHoldLocal}`)
    for (const [key, value] of Object.entries(plan.settings)) expect(MAILX_POSTCONF_KEYS[key]!(value)).toBe(true)
    expect(plan.files.find(file => file.path === MAILX_MAPS.outboundHold)!.content).toContain('sales@bob.test HOLD\n')
    expect(plan.files.find(file => file.path === MAILX_MAPS.outboundHoldLocal)!.content).toContain('/^Received: by [^ ]+ \\(Postfix, from userid 1001\\)/ HOLD\n')
  })
  it('leaves Postfix alone while the section is not saved', () => {
    expect(renderMailxPostfix({ sections: {} as MailxSaved['sections'], archives: [] }).settings.header_checks).toBeUndefined()
  })
  it('refuses a system uid and an unsafe sender', () => {
    expect(parseMailxOutbound(MAILX_DEFAULTS.outbound)).toEqual({ senders: [], uids: [] })
    expect(() => parseMailxOutbound({ senders: [], uids: [0] })).toThrow()
    expect(() => parseMailxOutbound({ senders: ['a b HOLD'], uids: [] })).toThrow()
  })
})
