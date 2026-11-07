import { describe, expect, it } from 'vitest'
import { validateRemoteServiceIps } from '@xpanel/core'
import { services } from '@xpanel/render'
import { profileFor } from '@xpanel/os'
import { renderAllowAxfrIps } from './remote-service-ips.ts'
import { renderSecDnsClusterDropIn } from './sec-dns-cluster.ts'
import { MAILX_SECTIONS, renderMailxPostfix } from './mailx-policy.ts'

describe('Remote Service IPs', { tags: ['unit'] }, () => {
  it('validates bounded canonical address and network lists', () => {
    expect(validateRemoteServiceIps({ smtp: ['192.0.2.20', '198.51.100.0/24', '192.0.2.20'], nameservers: ['2001:DB8::53'] })).toEqual({ smtp: ['192.0.2.20', '198.51.100.0/24'], nameservers: ['2001:db8::53'] })
    for (const bad of [{ smtp: [] }, { smtp: ['mail.example.test'], nameservers: [] }, { smtp: ['0.0.0.0/0'], nameservers: [] }, { smtp: Array.from({ length: 65 }, (_, i) => `192.0.2.${i}`), nameservers: [] }]) {
      expect(() => validateRemoteServiceIps(bad), JSON.stringify(bad).slice(0, 60)).toThrow()
    }
  })
  it('admits zone transfers from the union of cluster peers and remote nameservers, peers first, once each', () => {
    expect(renderAllowAxfrIps([], [])).toBe('allow-axfr-ips=127.0.0.0/8,::1')
    expect(renderAllowAxfrIps(['203.0.113.2', '203.0.113.1'], ['203.0.113.9', '203.0.113.1'])).toBe('allow-axfr-ips=127.0.0.0/8,::1,203.0.113.2,203.0.113.1,203.0.113.9')
    expect(renderSecDnsClusterDropIn([{ name: 'ns2', address: '203.0.113.2' }], ['198.51.100.53'])).toContain('allow-axfr-ips=127.0.0.0/8,::1,203.0.113.2,198.51.100.53\nalso-notify=203.0.113.2')
  })
  it('exempts remote SMTP servers from the client limits without touching relay permission', () => {
    const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
    const settings = services.postfixMainSettings(os, { limitExceptions: ['192.0.2.20', '198.51.100.0/24'] })
    expect(settings.smtpd_client_event_limit_exceptions).toBe('$mynetworks, 192.0.2.20, 198.51.100.0/24')
    expect(settings).not.toHaveProperty('mynetworks')
    expect(services.postfixMainSettings(os, {})).not.toHaveProperty('smtpd_client_event_limit_exceptions')
  })
  it('renders one limit exception value: $mynetworks, the mail policy entries, then the remote servers not listed', () => {
    expect(services.renderClientLimitExceptions(undefined, [])).toBe('$mynetworks')
    expect(services.renderClientLimitExceptions('$mynetworks, 192.0.2.0/24 203.0.113.5', ['203.0.113.5', '198.51.100.7'])).toBe('$mynetworks, 192.0.2.0/24, 203.0.113.5, 198.51.100.7')
    expect(services.renderClientLimitExceptions('203.0.113.5', [])).toBe('$mynetworks, 203.0.113.5')
  })
  it('keeps the remote servers when the mail policy page applies, and the policy entries when the reconcile applies', () => {
    const saved = { sections: { ...Object.fromEntries(MAILX_SECTIONS.map(name => [name, null])), server: { policy: { postfix: { smtpd_client_event_limit_exceptions: '192.0.2.0/24' }, rbl: null, certificates: { smtp: null } } } }, archives: [] } as never
    expect(renderMailxPostfix(saved, new Map(), ['198.51.100.7']).settings.smtpd_client_event_limit_exceptions).toBe('$mynetworks, 192.0.2.0/24, 198.51.100.7')
    const os = profileFor('ID=ubuntu' + String.fromCharCode(10) + 'VERSION_ID="24.04"' + String.fromCharCode(10))
    expect(services.postfixMainSettings(os, { limitExceptions: ['198.51.100.7'], limitPolicy: '192.0.2.0/24' }).smtpd_client_event_limit_exceptions).toBe('$mynetworks, 192.0.2.0/24, 198.51.100.7')
  })
})
