import { describe, expect, it } from 'vitest'
import { qualifyHostTools, tools } from '@xpanel/catalog'
import type { Account, Plan, Reseller } from '@xpanel/core'
import { renderApprovedWhmResellers, resellerDetailAnchor } from './approved-whm-resellers.ts'
import { renderWhmSurface } from '../surfaces/xwhm.ts'
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

  it.each(['en', 'ar'] as const)('labels stored reseller capacity in MiB without changing values or inventing use in %s', locale => {
    const html = renderApprovedWhmResellers({ ...base(), locale, accounts: undefined, plans: undefined, resellers: [reseller, { ...other, totalDiskMb: 'unlimited', totalBandwidthMb: 'unlimited' }] })
    const visible = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    expect(visible).toContain(locale === 'ar' ? 'إجمالي القرص (MiB)' : 'Total disk (MiB)')
    expect(visible).toContain(locale === 'ar' ? 'إجمالي النقل الشهري (MiB)' : 'Total bandwidth per month (MiB)')
    expect(html).toMatch(/name="totalDiskMb"[^>]*value="8192"/)
    expect(html).toMatch(/name="totalBandwidthMb"[^>]*value="32768"/)
    expect(visible).toContain(locale === 'ar' ? 'غير متاح / 8,192 MiB' : 'Unavailable / 8,192 MiB')
    expect(visible).toContain(locale === 'ar' ? 'غير متاح / 32,768 MiB' : 'Unavailable / 32,768 MiB')
    expect(visible).toContain(locale === 'ar' ? 'غير متاح / غير محدود MiB' : 'Unavailable / Unlimited MiB')
    expect(html).not.toMatch(/role="meter"|xp-meter__fill|Total disk \(MB\)|Total bandwidth per month \(MB\)/)
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

  it('follows the approved list-then-detail selection: Open links in the native list select one detail section', () => {
    const html = renderWhmSurface({ ...base(), principal: { kind: 'root', id: 'root-private-marker', username: 'administrator7' }, activeRoute: '/whm/resellers' })
    expect(html).not.toMatch(/<details[^>]*data-reseller-detail=|class="xp-reseller-select"/)
    for (const [index, item] of [reseller, other].entries()) {
      const anchor = resellerDetailAnchor(item.id)
      expect(html).toContain(`<section class="xp-reseller-detail" id="${anchor}" data-reseller-detail="${index}"${index === 0 ? ' data-reseller-default' : ''} aria-labelledby="whm-reseller-detail-${index}-heading">`)
      const row = html.match(new RegExp(`<tr data-reseller-row="${item.username}">[\\s\\S]*?<\\/tr>`))![0]
      expect(row).toContain(`href="#${anchor}" data-reseller-open="${anchor}" aria-label="Open ${item.username}"`)
      expect(row).toContain(`data-reseller-viewing="${anchor}"`)
      expect(row).toContain('Open below')
    }
    expect(html).toContain('.xp-reseller-reference:not(:has(.xp-reseller-detail:target,.xp-reseller-detail :target)) .xp-reseller-detail:not([data-reseller-default]){display:none}')
    // A target inside a detail (its Change ownership section) keeps that detail selected.
    expect(html).toContain('.xp-reseller-reference:has(.xp-reseller-detail:target,.xp-reseller-detail :target) .xp-reseller-detail:not(:target):not(:has(:target))')
    const otherAnchor = resellerDetailAnchor(other.id)
    expect(html).toContain(`.xp-reseller-reference:has(#${otherAnchor}:target,#${otherAnchor} :target) [data-reseller-viewing="${otherAnchor}"]{display:inline-flex}`)
    expect(html).toMatch(/class="xp-reseller-header"/)
  })

  it('renders Change ownership as the approved non-disclosure section reached from the detail header', () => {
    const html = renderApprovedWhmResellers(base())
    const first = html.slice(html.indexOf('data-reseller-detail="0"'), html.indexOf('data-reseller-detail="1"'))
    expect(first).not.toMatch(/<details\b|<summary\b/)
    expect(first).toContain('<section class="xp-reseller-ownership" id="whm-reseller-detail-0-ownership" data-reseller-ownership aria-labelledby="whm-reseller-detail-0-ownership-heading"><div class="xp-reseller-ownership__head"><h4 id="whm-reseller-detail-0-ownership-heading">Change ownership</h4>')
    const header = first.slice(first.indexOf('<header class="xp-reseller-header">'), first.indexOf('</header>'))
    expect(header).toMatch(/<a class="xp-btn" href="#whm-reseller-detail-0-ownership"><svg aria-hidden="true"[^>]*>[\s\S]*?<\/svg>Change ownership<\/a>/)
    expect(header).not.toContain('Suspend reseller')
    const section = first.slice(first.indexOf('data-reseller-ownership'), first.indexOf('</section>', first.indexOf('data-reseller-ownership')))
    expect(section).toContain('data-reseller-owner-form="true" data-account-username="owner7"')
    expect(section).toMatch(/<button type="submit" class="xp-btn">Change owner<\/button>/)
    expect(first.indexOf('data-reseller-ownership')).toBeLessThan(first.indexOf('<table class="xp-table">'))
    const scoped = renderApprovedWhmResellers({ ...base(), catalog: catalog.map(tool => tool.id === 'modify-account' ? { ...tool, status: 'researched' as const } : tool) })
    const headerStart = scoped.indexOf('<header class="xp-reseller-header">'), unavailable = scoped.slice(headerStart, scoped.indexOf('</header>', headerStart))
    expect(unavailable).toMatch(/<button class="xp-btn" type="button" disabled data-wiring="soon"><svg[\s\S]*?<\/svg>Change ownership<\/button>/)
    expect(unavailable).not.toContain('href="#whm-reseller-detail-0-ownership"')
    expect(scoped).toMatch(/data-reseller-ownership[\s\S]*?<select id="whm-reseller-detail-0-owner-account" class="xp-input" disabled data-wiring="soon">/)
  })

  it('renders the approved save bar card with Suspend first and status, Discard and Save at the end', () => {
    const html = renderApprovedWhmResellers(base())
    const form = html.slice(html.indexOf('data-reseller-update-form="true"'), html.indexOf('</form>', html.indexOf('data-reseller-update-form="true"')))
    expect(form).toContain('<div class="xp-reseller-savebar" data-reseller-savebar><button class="xp-btn" type="button" disabled data-wiring="soon">Suspend reseller</button><div class="xp-reseller-actions"><p class="xp-help" data-reseller-update-status role="status"></p><button type="reset" class="xp-btn">Discard changes</button><button type="submit" class="xp-btn xp-btn--primary">Save reseller</button></div></div>')
    expect(form.trimEnd().endsWith('</div></div>')).toBe(true)
    expect(html).toContain('.xp-reseller-reference .xp-reseller-savebar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--xp-space-field,16px);padding:var(--xp-space-field,16px) var(--xp-space-card,24px);border:1px solid var(--xp-border);border-radius:var(--xp-radius-lg,12px);background:var(--xp-bg-surface)}')
    const readOnly = renderApprovedWhmResellers({ ...base(), capabilityUnavailable: true })
    expect(readOnly).toContain('<div class="xp-reseller-savebar" data-reseller-savebar><button class="xp-btn" type="button" disabled data-wiring="soon">Suspend reseller</button><div class="xp-reseller-actions"><button class="xp-btn" type="button" disabled data-wiring="soon">Discard changes</button><button class="xp-btn" type="button" disabled data-wiring="soon">Save reseller</button></div></div>')
  })

  it('keeps reseller anchors CSS-safe and distinct for any stored id', () => {
    expect(resellerDetailAnchor(reseller.id)).toBe('whm-reseller-' + reseller.id)
    expect(resellerDetailAnchor('a.b')).not.toBe(resellerDetailAnchor('a-b'))
    expect(resellerDetailAnchor('a_2e_b')).not.toBe(resellerDetailAnchor('a.b'))
    expect(resellerDetailAnchor('"]}</style><x')).toMatch(/^whm-reseller-[A-Za-z0-9_-]+$/)
  })
})
