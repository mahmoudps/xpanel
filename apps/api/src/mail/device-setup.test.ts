import { describe, expect, it } from 'vitest'
import type { OsProfile } from '@xpanel/core'
import { services } from '@xpanel/render'
import { MAIL_CLIENT_ENDPOINTS, handleMailDeviceSetupRoute, renderAppleMailProfile, renderMailAutoconfig } from './device-setup.ts'
import type { DeviceSetupPorts } from './device-setup.ts'

const MAILBOX = 'alice@example.test', HOST = 'server1.example.test'
const call = async (path: string, ports: Partial<DeviceSetupPorts> = {}, method = 'GET') => {
  const request = new Request('http://xpanel.test' + path, { method })
  return (await handleMailDeviceSetupRoute(request, new URL(request.url), method, { open: async () => ({ mailbox: MAILBOX }), readHostname: async () => HOST, ...ports }))!
}

describe('mail client settings from trusted configuration', () => {
  it('returns the sealed mailbox as username, rendered ports and no password', async () => {
    const response = await call('/api/webmail/connect-devices'), body = await response.json()
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(body).toEqual({ mailbox: MAILBOX, username: MAILBOX, hostname: HOST,
      incoming: [{ protocol: 'imap', port: 993, security: 'implicit-tls' }, { protocol: 'imap', port: 143, security: 'starttls' }],
      outgoing: [{ protocol: 'smtp', port: 465, security: 'implicit-tls' }, { protocol: 'smtp', port: 587, security: 'starttls' }],
      pop3: 'not-offered', authentication: 'password', passwordIncluded: false, certificate: 'not-verified-by-this-page',
      downloads: [{ kind: 'autoconfig', path: '/api/webmail/connect-devices/autoconfig.xml', filename: 'config-v1.1.xml', contentType: 'application/xml; charset=utf-8' },
        { kind: 'apple', path: '/api/webmail/connect-devices/apple.mobileconfig', filename: 'mail-account.mobileconfig', contentType: 'application/x-apple-aspen-config' }] })
    expect(JSON.stringify(body)).not.toMatch(/sealed|secret/i)
  })
  it('keeps submission ports equal to the rendered Postfix client services', () => {
    const profile = { family: 'debian', paths: { postfixDir: '/etc/postfix', dovecotDir: '/etc/dovecot' } } as unknown as OsProfile
    const argv = services.postfixClientServices(profile).flatMap(action => action.kind === 'exec' ? action.argv : [])
    expect(argv).toContain('587/inet=587 inet n - n - - smtpd'); expect(argv).toContain('465/inet=465 inet n - n - - smtpd')
    expect(argv).toContain('465/inet/smtpd_tls_wrappermode=yes'); expect(argv.some(item => item.startsWith('587/inet/smtpd_tls_wrappermode'))).toBe(false)
    expect(MAIL_CLIENT_ENDPOINTS.outgoing).toEqual([{ protocol: 'smtp', port: 465, security: 'implicit-tls' }, { protocol: 'smtp', port: 587, security: 'starttls' }])
  })
  it.each([null, '', 'localhost', '-bad.example', 'a..b', 'x'.repeat(64) + '.example'])('reports an unsaved or invalid hostname %j and refuses downloads', async hostname => {
    const body = await (await call('/api/webmail/connect-devices', { readHostname: async () => hostname })).json()
    expect(body).toMatchObject({ hostname: null, downloads: [] })
    await expect(call('/api/webmail/connect-devices/apple.mobileconfig', { readHostname: async () => hostname })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'hostname_unavailable' } })
  })
  it('accepts no mailbox, host or other selector and only GET', async () => {
    await expect(call('/api/webmail/connect-devices?mailbox=bob@example.test')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/api/webmail/connect-devices/autoconfig.xml?emailaddress=bob@example.test')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call('/api/webmail/connect-devices', {}, 'POST')).status).toBe(405)
  })
  it('refuses an unusable sealed mailbox', async () => {
    await expect(call('/api/webmail/connect-devices', { open: async () => ({ mailbox: 'not-an-address' }) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})

describe('generated setup files', () => {
  it('serves Thunderbird config-v1.1 autoconfig as an XML attachment', async () => {
    const response = await call('/api/webmail/connect-devices/autoconfig.xml'), text = await response.text()
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="config-v1.1.xml"')
    expect(text).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<clientConfig version="1.1">/)
    expect(text).toContain('<emailProvider id="example.test">')
    expect([...text.matchAll(/<incomingServer type="imap">[\s\S]*?<port>(\d+)<\/port>\s*<socketType>(\w+)<\/socketType>/g)].map(match => match[1] + ' ' + match[2])).toEqual(['993 SSL', '143 STARTTLS'])
    expect([...text.matchAll(/<outgoingServer type="smtp">[\s\S]*?<port>(\d+)<\/port>\s*<socketType>(\w+)<\/socketType>/g)].map(match => match[1] + ' ' + match[2])).toEqual(['465 SSL', '587 STARTTLS'])
    expect(text.match(/<username>alice@example.test<\/username>/g)).toHaveLength(4)
    expect(text.match(/<hostname>server1.example.test<\/hostname>/g)).toHaveLength(4)
    expect(text).not.toMatch(/<password|pop3/i)
  })
  it('serves an unsigned Apple profile without any password key and with a mailbox-derived identifier', async () => {
    const response = await call('/api/webmail/connect-devices/apple.mobileconfig'), text = await response.text()
    expect(response.headers.get('content-type')).toBe('application/x-apple-aspen-config')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="mail-account.mobileconfig"')
    expect(text).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"')
    expect(text).toMatch(/<key>IncomingMailServerPortNumber<\/key>\s*<integer>993<\/integer>/)
    expect(text).toMatch(/<key>OutgoingMailServerPortNumber<\/key>\s*<integer>465<\/integer>/)
    expect(text).toMatch(/<key>IncomingMailServerUsername<\/key>\s*<string>alice@example.test<\/string>/)
    expect(text).toMatch(/<key>PayloadType<\/key>\s*<string>com.apple.mail.managed<\/string>/)
    expect(text).not.toMatch(/<key>(?:IncomingPassword|OutgoingPassword|Password)<\/key>|<data>|Signature/)
    const id = /<key>PayloadIdentifier<\/key>\s*<string>(xpanel\.mail\.[0-9a-f]{32})<\/string>\s*<key>PayloadRemovalDisallowed/.exec(text)?.[1]
    expect(id).toBeDefined()
    expect(renderAppleMailProfile(MAILBOX, HOST)).toBe(text)
    expect(renderAppleMailProfile('bob@example.test', HOST)).not.toContain(id!)
    expect(text.match(/<key>PayloadUUID<\/key>\s*<string>([0-9A-F]{8}-[0-9A-F]{4}-8[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12})<\/string>/g)).toHaveLength(2)
  })
  it('escapes XML text from configuration', () => {
    expect(renderMailAutoconfig("o'neil&<x>@b.test", 'h.test')).toContain('<username>o&apos;neil&amp;&lt;x&gt;@b.test</username>')
    expect(renderAppleMailProfile('a"b@b.test', 'h.test')).toContain('<string>Mail: a&quot;b@b.test</string>')
  })
})
