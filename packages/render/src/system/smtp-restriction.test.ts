import { describe, expect, it } from 'vitest'
import { defaultFirewallRules } from '@xpanel/core'
import { nftSettingsFromServer, renderNftables, SMTP_RESTRICTION_COMMENT } from './nftables.ts'

const os = { paths: { nftablesConf: '/etc/nftables.conf' } } as Parameters<typeof renderNftables>[2]
const ports = { panelPort: 2087, sshPort: 22, backendPort: 8081, backendTlsPort: 8444 }
const settings = (smtpRestricted: boolean) => nftSettingsFromServer(ports, { banTimeoutSec: 600, smtpRestricted })

describe('outbound SMTP restrictions', { tags: ['unit'] }, () => {
  it('adds no output chain while off', () => {
    expect(renderNftables(defaultFirewallRules(ports), settings(false), os).content).not.toContain('hook output')
  })
  it('resets account connections to remote SMTP and leaves loopback open first', () => {
    const content = renderNftables(defaultFirewallRules(ports), settings(true), os).content
    const chain = content.slice(content.indexOf('chain output'))
    expect(chain).toContain('type filter hook output priority filter; policy accept;')
    expect(chain.indexOf('oif "lo" accept')).toBeLessThan(chain.indexOf('meta skuid'))
    expect(chain).toContain(`meta skuid 1000-60000 tcp dport { 25, 465, 587 } reject with tcp reset comment "${SMTP_RESTRICTION_COMMENT}"`)
  })
})
