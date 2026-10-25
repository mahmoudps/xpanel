import { describe, expect, it } from 'vitest'
import { qualifyHostTools, tools } from '@xpanel/catalog'
import type { Account, Plan, Reseller } from '@xpanel/core'
import { renderApprovedWhmResellers } from './approved-whm-resellers.ts'
import type { WhmSurfaceProps } from '../surfaces/xwhm.ts'

const reseller: Reseller = {
  id: '10000000-0000-4000-8000-000000000001', username: 'provider7',
  acl: ['list-accounts', 'create-account', 'manage-dns'], maxAccounts: 9,
  totalDiskMb: 8192, totalBandwidthMb: 32768, oversell: false,
  nameservers: ['ns1.provider7.example.test', 'ns2.provider7.example.test'], delegatedIps: ['192.0.2.77'],
}
const other: Reseller = { ...reseller, id: '10000000-0000-4000-8000-000000000002', username: 'provider8', delegatedIps: [] }
const account: Account = {
  id: '20000000-0000-4000-8000-000000000001', username: 'owner7', uid: 1007, gid: 1007,
  home: '/home/owner7', primaryDomain: 'owner7.example.test', planId: '30000000-0000-4000-8000-000000000001',
  ownerId: reseller.id, status: 'active', suspendReason: null, contactEmail: 'owner7@example.test',
  ipv4: '192.0.2.77', shell: 'none', createdAt: '2026-01-01T00:00:00.000Z',
}
const foreign: Account = { ...account, id: '20000000-0000-4000-8000-000000000002', username: 'foreign7', primaryDomain: 'foreign7.example.test', ownerId: other.id }
const plan: Plan = {
  id: account.planId, name: 'Configured plan7', ownerId: reseller.id, featureListId: 'feature7',
  resources: { diskMb: 2048, bandwidthMbMonth: 4096, ioReadBps: 1048576, ioWriteBps: 1048576,
    ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
  caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1,
    ftpAccounts: 1, databases: 1, phpWorkers: 1 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
}
const catalog = qualifyHostTools(tools, { executor: 'linux', probes: { 'control-plane': 'passed' } })
const base = (): WhmSurfaceProps => ({
  locale: 'en', activeRoute: '/whm/resellers', catalog,
  visibility: { principal: { kind: 'root', id: 'root-private-marker', username: 'administrator7' } },
  resellers: [reseller, other], accounts: [account, foreign], plans: [plan],
})

describe('detailed reseller administration', () => {
  it('retains the native list and create controls exactly once while adding every detail group', () => {
    const native = '<section data-native-reseller-list="true"><form data-reseller-create-form="true"></form></section>'
    const html = renderApprovedWhmResellers(base(), native)
    expect(html.match(/data-native-reseller-list=/g)).toHaveLength(1)
    expect(html.match(/data-reseller-create-form=/g)).toHaveLength(1)
    for (const label of ['Privileges', 'Owned accounts', 'Change ownership', 'Capacity and usage', 'Maximum accounts',
      'Total disk', 'Total bandwidth per month', 'Overselling', 'Nameservers', 'Delegated IP addresses', 'Last sign-in', 'Save reseller', 'Discard changes']) expect(html).toContain(label)
    expect(html).toContain('data-reseller-update-form="true"')
    expect(html).toContain('data-reseller-owner-form="true"')
    expect(html).toContain('name="maxAccountsUnlimited"')
    expect(html).not.toMatch(/reseller1\.test|studio9\.media|Saved at|can take omar|198\.51\.100\.34/)
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps each reseller account list scoped and labels plan allocation separately from actual use', () => {
    const html = renderApprovedWhmResellers(base())
    const first = html.slice(html.indexOf('data-reseller-detail="0"'), html.indexOf('data-reseller-detail="1"'))
    expect(first).toContain(account.primaryDomain)
    expect(first).not.toContain(foreign.primaryDomain)
    expect(first).toContain('Configured plan7')
    expect(first).toContain('Assigned plan limits')
    expect(first).toContain('Actual use not read')
    expect(first).toContain('Resolution has not been probed')
    expect(first).not.toContain('Resolves to')
    expect(first).not.toContain('data-host-success')
    const textOnly = first.replace(/<[^>]*>/g, '')
    for (const id of [account.id, account.planId, reseller.id]) expect(textOnly).not.toContain(id)
  })

  it('keeps missing measurements unknown instead of substituting zero utilization', () => {
    const html = renderApprovedWhmResellers({ ...base(), accounts: undefined, plans: undefined })
    expect(html).toContain('Not read')
    expect(html).toContain('Actual disk use and current-month traffic have not been read')
    expect(html).not.toContain('data-reseller-owner-form=')
    expect(html).not.toContain('0 accounts')
    expect(html).not.toContain('aria-valuenow="0"')
  })

  it('retains the full read-only layout without forwarding supplied data or native actions', () => {
    const html = renderApprovedWhmResellers({ ...base(), capabilityUnavailable: true }, '<form data-private-native="true"></form>')
    expect(html).toContain('data-workspace-mode="read-only"')
    for (const label of ['Privileges', 'Owned accounts', 'Capacity and usage', 'Overselling', 'Nameservers', 'Delegated IP addresses']) expect(html).toContain(label)
    expect(html).not.toMatch(/<form\b|data-reseller-update-form=|data-reseller-owner-form=/)
    for (const privateValue of [reseller.username, account.primaryDomain, reseller.id, reseller.nameservers[0]!, 'data-private-native']) expect(html).not.toContain(privateValue)
    expect(html).toMatch(/<button\b[^>]*disabled[^>]*data-wiring="soon"/)
  })

  it.each(['user', 'reseller', 'missing'] as const)('does not admit a qualified %s actor from supplied DTOs', kind => {
    const visibility = kind === 'missing' ? undefined : kind === 'user'
      ? { principal: { kind, id: 'owner-id', username: 'owner7', accountId: account.id } }
      : { principal: { kind, id: reseller.id, username: reseller.username }, reseller }
    const html = renderApprovedWhmResellers({ ...base(), visibility })
    expect(html).toContain('data-reseller-admission="denied"')
    expect(html).not.toMatch(/<form\b|data-reseller-detail=/)
    expect(html).not.toContain(account.primaryDomain)
    expect(html).not.toContain(reseller.username)
  })

  it('prefers the authorized visibility actor over a conflicting root-looking principal prop', () => {
    const html = renderApprovedWhmResellers({ ...base(), principal: { kind: 'root', id: 'root-private-marker', username: 'administrator7' },
      visibility: { principal: { kind: 'user', id: 'owner-id', username: 'owner7', accountId: account.id } } })
    expect(html).toContain('data-reseller-admission="denied"')
    expect(html).not.toContain('data-reseller-update-form=')
  })

  it('does not infer readiness from metadata alone or qualify ownership from reseller editing', () => {
    const unread = renderApprovedWhmResellers({ ...base(), catalog: tools })
    expect(unread).toContain('data-workspace-mode="read-only"')
    expect(unread).not.toContain(account.primaryDomain)
    expect(unread).not.toMatch(/<form\b/)
    const resellerOnly = catalog.map(tool => tool.id === 'modify-account' ? { ...tool, status: 'researched' as const } : tool)
    const scoped = renderApprovedWhmResellers({ ...base(), catalog: resellerOnly })
    expect(scoped).toContain('data-reseller-update-form="true"')
    expect(scoped).not.toContain('data-reseller-owner-form="true"')
    expect(scoped).toContain('Change ownership')
  })

  it('preserves unlimited limits, Arabic labels, isolated technical values and truthful states', () => {
    const html = renderApprovedWhmResellers({ ...base(), locale: 'ar', resellers: [{ ...reseller, maxAccounts: 'unlimited', totalDiskMb: 'unlimited', oversell: true }] })
    expect(html).toContain('dir="rtl"')
    expect(html).toMatch(/name="maxAccountsUnlimited"[^>]*checked/)
    expect(html).toMatch(/name="maxAccounts"[^>]*disabled/)
    expect(html).toContain('الصلاحيات')
    expect(html).toContain('حالة تسجيل الدخول غير مقروءة')
    expect(html).toContain('<bdi dir="ltr">owner7.example.test</bdi>')
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
  })

  it('escapes values and keeps unsupported suspend action unavailable', () => {
    const html = renderApprovedWhmResellers({ ...base(), resellers: [{ ...reseller, username: '<script>secret</script>', nameservers: ['"><img onerror=attack>'] }] })
    expect(html).toContain('&lt;script&gt;secret&lt;/script&gt;')
    expect(html).not.toContain('<script>secret')
    expect(html).not.toContain('<img onerror')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Suspend reseller<\/button>/)
    expect(html).not.toContain('Resolves to')
  })
})
