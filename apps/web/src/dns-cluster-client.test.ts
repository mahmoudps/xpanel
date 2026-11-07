import { describe, expect, it } from 'vitest'
import { readDnsClusterView } from './dns-cluster-client.ts'
import { readDbProfilesView } from './whm-db-profiles-client.ts'
import { renderClassicDbProfilesCard } from './board-port/db-profiles-card.ts'
import { renderClassicDnsClusterSection } from './board-port/dns-cluster-section.ts'
import { renderV2DnsClusterMembers } from './themes/v2/pages/xwhm/dns/cluster-members.ts'
import type { Translate } from './i18n.ts'

const member = { name: 'ns2.beta.test', address: '192.0.2.2', port: 2087, pin: 'a'.repeat(64), role: 'synchronize', runtime: null }
const view = { state: 'saved', revision: 'r'.repeat(64), enabled: true, failureThreshold: 10, members: [member], inbound: [], conflicts: [], pin: null, observation: 'read' }
const hooks = ['data-sec-input="member-token"', 'data-sec-input="member-pin"', 'data-sec-rows="members"', 'data-sec-rows="conflicts"', 'data-sec-field="issued-token"', 'data-sec-action="sync-run"', 'data-sec-action="inbound-issue"', 'data-sec-field="cluster-pin"']

describe('dns cluster views', () => {
  it('refuses any row that carries a token', () => {
    expect(readDnsClusterView(view).members[0]!.name).toBe('ns2.beta.test')
    expect(() => readDnsClusterView({ ...view, members: [{ ...member, token: 'x' }] })).toThrow()
    expect(() => readDnsClusterView({ ...view, inbound: [{ name: 'a.test', address: '192.0.2.1', hint: 'abcd', createdAt: 'now', tokenHash: 'x' }] })).toThrow()
    expect(() => readDnsClusterView({ state: 'other' })).toThrow()
  })
  it('renders the same hooks in both themes, with write controls closed until the tool is qualified', () => {
    const t = ((message: string) => message) as Translate
    for (const closed of [renderClassicDnsClusterSection({ locale: 'en', canRead: true, canManage: false }), renderV2DnsClusterMembers(t, true, false)]) {
      for (const hook of hooks) expect(closed).toContain(hook)
      expect(closed).toContain('data-sec-can-manage="false"')
      expect(closed).toContain('data-xp-template="sec-action"')
      expect(/<input[^>]*data-sec-input="member-token"[^>]*>/.exec(closed)?.[0]).toMatch(/\bdisabled\b/)
    }
    expect(renderClassicDnsClusterSection({ locale: 'en', canRead: true, canManage: true })).toContain('data-sec-can-manage="true"')
    expect(renderClassicDnsClusterSection({ locale: 'en', canRead: false, canManage: true })).toContain('data-sec-can-manage="false"')
  })
})

describe('database profile views', () => {
  const profile = { name: 'remote1', host: '192.0.2.50', port: 3306, user: 'u', description: '', tls: true, validation: null }
  it('refuses a row that carries a password', () => {
    expect(readDbProfilesView({ active: 'localhost', localProfile: 'localhost', profiles: [profile] }).profiles).toHaveLength(1)
    expect(() => readDbProfilesView({ active: 'localhost', localProfile: 'localhost', profiles: [{ ...profile, password: 'x' }] })).toThrow()
  })
  it('renders closed controls and asks for a new password field', () => {
    const html = renderClassicDbProfilesCard('en', true, false)
    expect(html).toContain('data-sec-can-manage="false"')
    expect(html).toContain('autocomplete="new-password"')
    expect(html).toContain('data-sec-rows="profiles"')
  })
})
