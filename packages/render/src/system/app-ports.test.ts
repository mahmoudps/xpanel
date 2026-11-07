import { describe, expect, it } from 'vitest'
import { defaultFirewallRules } from '@xpanel/core'
import { renderNftables } from './nftables.ts'

const os = { paths: { nftablesConf: '/etc/nftables.conf' } } as never
const settings = { panelPort: 2087, sshPort: 22, backendPorts: [8080], banTimeoutSec: 60 }
const render = (extra: Record<string, unknown>) => renderNftables(defaultFirewallRules({ panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 }), { ...settings, ...extra } as never, os).content

describe('private app ports in the firewall', () => {
  it('lets only the owning uid reach a private port and answer on it', () => {
    const text = render({ appPorts: [{ port: 20000, uid: 20001, open: false }] })
    expect(text).toContain('oif "lo" tcp dport 20000 meta skuid != 20001 reject with tcp reset comment "xpanel: app port"')
    expect(text).toContain('oif "lo" tcp sport 20000 meta skuid != 20001 drop comment "xpanel: app port"')
    expect(text).not.toContain('tcp dport 20000 accept')
  })
  it('accepts the port from outside only when root opened it', () => {
    expect(render({ appPorts: [{ port: 20000, uid: 20001, open: true }] })).toContain('tcp dport 20000 accept comment "xpanel: app port"')
  })
  it('keeps the guards ahead of the loopback accept of outbound SMTP restrictions', () => {
    const text = render({ appPorts: [{ port: 20000, uid: 20001, open: false }], smtpRestricted: true })
    expect(text.indexOf('tcp dport 20000 meta skuid')).toBeLessThan(text.indexOf('oif "lo" accept'))
  })
  it('renders no output chain without an app or a restriction', () => {
    expect(render({})).not.toContain('hook output')
  })
})
