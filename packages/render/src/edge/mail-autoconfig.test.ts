import { describe, expect, it } from 'vitest'
import { renderAutoconfigXml, renderAutodiscoverXml } from './mail-autoconfig.ts'
import { renderNginxSite } from './nginx.ts'
import { account, cert, codeOf, domain, serverBlocks, settings } from './testkit.ts'

const option = { hostname: 'host.example.net', domains: ['example.com'] }

describe('mail client autoconfiguration at the edge', { tags: ['unit'] }, () => {
  it('sends a device that asks the website to the calendar port, only for a served name', () => {
    const text = renderNginxSite(account(), [domain()], settings(), [cert()], { calDavNames: ['example.com'] })
    expect(text).toContain('location = /.well-known/caldav { return 301 https://example.com:2080/; }')
    expect(text).toContain('location = /.well-known/carddav { return 301 https://example.com:2080/; }')
    expect(renderNginxSite(account(), [domain()], settings(), [cert()], { calDavNames: [] })).not.toContain('.well-known/caldav')
  })

  it('describes the rendered IMAP and SMTP listeners with the client filling in the address', () => {
    const thunderbird = renderAutoconfigXml(option)
    expect(thunderbird).toContain('<domain>example.com</domain>')
    expect(thunderbird).toContain('<incomingServer type="imap"><hostname>host.example.net</hostname><port>993</port><socketType>SSL</socketType>')
    expect(thunderbird).toContain('<outgoingServer type="smtp"><hostname>host.example.net</hostname><port>465</port><socketType>SSL</socketType>')
    expect(thunderbird).toContain('<username>%EMAILADDRESS%</username>')
    expect(thunderbird).not.toContain('pop3')
    const outlook = renderAutodiscoverXml(option)
    expect(outlook).toMatch(/<Type>IMAP<\/Type><Server>host\.example\.net<\/Server><Port>993<\/Port>.*<SSL>on<\/SSL>/)
    expect(outlook).toMatch(/<Type>SMTP<\/Type><Server>host\.example\.net<\/Server><Port>465<\/Port>/)
    expect(codeOf(() => renderAutoconfigXml({ hostname: 'bad host', domains: ['example.com'] }))).toBe('VALIDATION')
  })
  it('answers the well-known paths on the site and serves autoconfig and autodiscover names with their covering certificate', () => {
    const text = renderNginxSite(account(), [domain()], settings(), [cert()], { mailAutoconfig: option })
    const blocks = serverBlocks(text)
    const site443 = blocks.find(block => block.includes('listen 443') && block.includes('server_name example.com'))!
    expect(site443).toContain('location = /.well-known/autoconfig/mail/config-v1.1.xml {')
    expect(site443).toContain('location ~* ^/autodiscover/autodiscover\\.xml$ {')
    expect(site443).toContain('return 200 "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?><clientConfig')
    const hosts = blocks.filter(block => block.includes('server_name autoconfig.example.com autodiscover.example.com;'))
    expect(hosts).toHaveLength(2)
    expect(hosts.find(block => block.includes('listen 443'))).toContain('ssl_certificate /')
    expect(hosts[0]).toContain('location = /mail/config-v1.1.xml {')
    expect(hosts[0]).toContain('access_log off;')
    expect(text).not.toMatch(/return 200 "[^"]*\$/m)
  })
  it('keeps plain HTTP only for names no certificate covers, and adds nothing without a mail domain', () => {
    const text = renderNginxSite(account(), [domain()], settings(), [cert({ names: ['example.com'] })], { mailAutoconfig: option })
    expect(serverBlocks(text).filter(block => block.includes('server_name autoconfig.example.com')).map(block => block.includes('listen 443'))).toEqual([false])
    const none = renderNginxSite(account(), [domain()], settings(), [cert()], { mailAutoconfig: { ...option, domains: ['other.example'] } })
    expect(none).not.toContain('autoconfig')
    expect(renderNginxSite(account(), [domain()], settings(), [cert()])).not.toContain('autodiscover')
  })
  it('leaves an autoconfig name the account serves as its own site to that site', () => {
    const text = renderNginxSite(account(), [domain(), domain({ id: 'd2', name: 'autoconfig.example.com', kind: 'subdomain', parentId: 'd1' })], settings(), [], { mailAutoconfig: option })
    expect(serverBlocks(text).filter(block => block.includes('# mail client') || block.includes('server_name autodiscover.example.com;'))).toHaveLength(1)
  })
})
