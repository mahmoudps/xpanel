import { describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import { defaultPlan, type Account, type Reseller } from '@xpanel/core'
import { translator } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { renderV2WhmResellers, type WhmResellerAuthority } from './index.ts'
import { renderV2WhmResellerRecords } from './records.ts'

const operator = { kind: 'root' as const, id: '10000000-0000-4000-8000-000000000001', username: 'operator' }
const reseller: Reseller = { id: '20000000-0000-4000-8000-000000000001', username: 'provider', acl: ['list-accounts', 'manage-dns'], maxAccounts: 4, totalDiskMb: 10240, totalBandwidthMb: 'unlimited', oversell: false, nameservers: ['ns1.provider.example.test'], delegatedIps: ['192.0.2.9'] }
const plan = defaultPlan({ id: '30000000-0000-4000-8000-000000000001', ownerId: reseller.id, name: 'Provider plan' })
const account: Account = { id: '40000000-0000-4000-8000-000000000001', username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', primaryDomain: 'alice.example.test', planId: plan.id, ownerId: reseller.id, status: 'active', suspendReason: null, contactEmail: 'alice@example.test', ipv4: '192.0.2.1', shell: 'none', createdAt: '2026-01-01T00:00:00Z' }
const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const authority: WhmResellerAuthority = { canRead: true, canManage: true, canChangeOwner: true }
const props = (overrides: Partial<WhmSurfaceProps> = {}): WhmSurfaceProps => ({ principal: operator, locale: 'en', catalog, activeRoute: '/whm/resellers', resellers: [reseller], plans: [plan], accounts: [account], ...overrides })
const t = translator('en')

describe('v2 reseller family', () => {
  it('retains native create, update and ownership contracts with all 14 ACL choices', () => {
    const html = renderV2WhmResellers(t, props(), authority)
    for (const hook of ['data-reseller-create-form', 'data-reseller-update-form', 'data-reseller-owner-form', 'data-reseller-status', 'data-reseller-update-status', 'data-reseller-owner-status']) expect(html).toContain(hook)
    for (const name of ['maxAccounts', 'totalDiskMb', 'totalBandwidthMb']) {
      expect(html).toContain(`name="${name}"`)
      expect(html).toMatch(new RegExp(`name="${name}Unlimited"[^>]*data-reseller-unlimited-field="${name}"`))
    }
    expect(html.match(/name="acl"/g)).toHaveLength(28)
    expect(html).toContain('name="ownerId"')
    expect(html).toContain('name="nameservers"')
    expect(html).toContain('name="delegatedIps"')
  })
  it('never forwards supplied DTOs or mounts forms when the native workspace is not readable', () => {
    const html = renderV2WhmResellers(t, props())
    for (const text of ['provider', 'alice.example.test', 'Provider plan', '192.0.2.9']) expect(html).not.toContain(text)
    expect(html).not.toContain('<form')
    expect(html).toContain('data-workspace-mode="read-only"')
  })
  it('shows configured caps and assigned plan limits separately from unmeasured resource use', () => {
    const html = renderV2WhmResellers(t, props(), authority)
    expect(html).toContain('5120 MiB')
    expect(html).toContain('Actual disk use and current-month traffic have not been read.')
    expect(html).toMatch(/name="totalBandwidthMbUnlimited"[^>]*data-reseller-unlimited-field="totalBandwidthMb" checked/)
    expect(html).not.toContain('Within capacity')
    expect(html).toContain('v2-meter')
  })
  it('does not treat unread account or plan collections as zero usage', () => {
    const html = renderV2WhmResellers(t, props({ accounts: undefined, plans: undefined }), authority)
    expect(html).toContain('Not read')
    expect(html).not.toContain('data-reseller-owner-form')
    expect(html).not.toContain('>0 MiB</bdi>')
  })
  it('shows delegated address assignments only from the loaded owned-account facts', () => {
    const assigned = renderV2WhmResellers(t, props({ accounts: [{ ...account, ipv4: '192.0.2.9' }] }), authority)
    expect(assigned).toContain('192.0.2.9</bdi></td><td><bdi class="v2-mono v2-num" dir="ltr">alice</bdi>')
    const recorded = renderV2WhmResellers(t, props({ ipPool: [{ id: 'ip-record', address: '192.0.2.9', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '' }] }), authority)
    expect(recorded).toContain('No owned account assignment is recorded')
    const unread = renderV2WhmResellers(t, props(), authority)
    expect(unread).not.toContain('No owned account assignment is recorded')
  })
  it('never infers contact, created, last sign-in or suspension from a reseller record', () => {
    const html = renderV2WhmResellers(t, props(), authority)
    expect(html).toContain('Sign-in state not read')
    expect(html).toContain('Suspend reseller</button>')
    expect(html).toMatch(/type="button" disabled>Suspend reseller<\/button>/)
  })
  it('supports the privileges document with the same real controls and escaped stored values', () => {
    const html = renderV2WhmResellers(t, props({ activeRoute: '/whm/resellers/privileges', resellers: [{ ...reseller, username: '<script>bad()</script>' }] }), authority)
    expect(html).toContain('Reseller privileges')
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).not.toContain('<script>bad()')
    expect(html).toContain('data-reseller-update-form')
  })
  it.each(['/whm/resellers/more', '/whm/resellers/ips-nameservers'])('renders %s as a stored-record document without inventing mutation controls', route => {
    const html = renderV2WhmResellerRecords(t, props({ activeRoute: route }), authority)!
    expect(html).toContain('provider')
    expect(html).toContain('ns1.provider.example.test')
    expect(html).toContain('data-wiring="unavailable"')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('192.0.2.9')
  })
  it('keeps unrelated reseller rows outside a delegated reader snapshot', () => {
    const foreign = { ...reseller, id: '20000000-0000-4000-8000-000000000002', username: 'foreign-owner' }
    const html = renderV2WhmResellerRecords(t, props({ principal: { kind: 'reseller', id: reseller.id, username: reseller.username }, activeReseller: reseller, activeRoute: '/whm/resellers/ips-nameservers', resellers: [reseller, foreign] }), authority)!
    expect(html).toContain('provider')
    expect(html).not.toContain('foreign-owner')
  })
  it('keeps numeric values in isolated inline content for Arabic without moving their field edge', () => {
    const html = renderV2WhmResellers(translator('ar'), props({ locale: 'ar' }), authority)
    expect(html).toContain('dir="ltr"')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})
