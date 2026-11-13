/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account, Reseller, ServerIpEntry } from '@xpanel/core'
import { renderWhmSurface } from './surfaces/xwhm.ts'
import { parseIpMigrationPairs, WHM_NETWORK_CLIENT_BINDING } from './whm-network-client.ts'
import { renderV2WhmServerIps } from './themes/v2/pages/xwhm/server/ips.ts'
import { renderClassicResellerAclLists, renderClassicResellerMore } from './board-port/whm-reseller-tools.ts'
import { translator } from './i18n.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ip = (n: number, patch: Partial<ServerIpEntry> = {}): ServerIpEntry => ({ id: id(n), address: `192.0.2.${n}`, version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'dedicated', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '', ...patch })
const pool = [ip(10, { role: 'shared', isPrimary: true }), ip(11)]
const account = { id: id(40), username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', primaryDomain: 'alice.example.test', planId: id(50), ownerId: null, status: 'active', suspendReason: null, contactEmail: 'a@example.test', ipv4: '192.0.2.11', shell: 'none', createdAt: '2026-11-06T00:00:00.000Z' } as Account
const reseller = { id: id(60), username: 'resone', acl: ['list-accounts'], maxAccounts: 5, totalDiskMb: 1024, totalBandwidthMb: 1024, oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [], contactEmail: 'r@example.test' } as Reseller
const root = { kind: 'root', id: 'fixture-root', username: 'operator' } as const
const tick = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const boot = (html: string, send?: Send, ask: (options: Record<string, unknown>) => Promise<unknown> = async () => true) => {
  document.body.innerHTML = html
  if (send) (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + WHM_NETWORK_CLIENT_BINDING)()(ask)
}
const submit = (selector: string) => $(selector).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
const classicIps = () => renderWhmSurface({ locale: 'en', activeRoute: '/whm/server/ips', principal: root, ipPool: pool, accounts: [account], resellers: [reseller] })
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('IP and reseller tool client', { tags: ['feature'] }, () => {
  it('serializes a closed helper graph and parses migration pairs strictly', () => {
    expect(WHM_NETWORK_CLIENT_BINDING).not.toContain('__vite_ssr_import_')
    expect(parseIpMigrationPairs('192.0.2.10 198.51.100.10\n\n2001:db8::1 2001:db8::2')).toEqual([{ from: '192.0.2.10', to: '198.51.100.10' }, { from: '2001:db8::1', to: '2001:db8::2' }])
    for (const bad of ['', '192.0.2.10', '192.0.2.10 198.51.100.10 extra', 'a;b c']) expect(() => parseIpMigrationPairs(bad)).toThrow()
  })

  it("changes a site's IP only after confirmation and reports the held address from the reply", async () => {
    const send = vi.fn<Send>().mockResolvedValue({ account: { ipv4: '192.0.2.10' }, held: ['192.0.2.11'] })
    const ask = vi.fn(async () => true)
    boot(classicIps(), send, ask)
    const form = $('[data-ip-change-form]') as HTMLFormElement
    ;(form.elements.namedItem('accountId') as HTMLSelectElement).value = account.id
    ;(form.elements.namedItem('ipv4') as HTMLSelectElement).value = '192.0.2.10'
    submit('[data-ip-change-form]'); await tick()
    expect(ask).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledExactlyOnceWith('POST', `/api/accounts/${account.id}/ip`, { ipv4: '192.0.2.10' })
    expect($('[data-ip-change-status]').dataset.state).toBe('saved')
    expect($('[data-ip-change-status]').textContent).toContain('stays held until the agent verifies the new binding')
  })

  it("changes several sites' IPs in one confirmed request and lists each account's result", async () => {
    const send = vi.fn<Send>().mockResolvedValue({ results: [{ accountId: account.id, account: { username: 'alice', ipv4: '192.0.2.10' }, held: ['192.0.2.11'] }] })
    boot(classicIps(), send)
    const form = $('[data-ip-change-many-form]') as HTMLFormElement
    form.querySelector<HTMLInputElement>('[name="accountId"]')!.checked = true
    ;(form.elements.namedItem('ipv4All') as HTMLSelectElement).value = '192.0.2.10'
    submit('[data-ip-change-many-form]'); await tick()
    expect(send).toHaveBeenCalledExactlyOnceWith('POST', '/api/ips/change-many', { changes: [{ accountId: account.id, ipv4: '192.0.2.10' }] })
    expect($('[data-ip-change-many-status]').textContent).toContain('alice: now 192.0.2.10; the old dedicated address stays held')
  })
  it('shows the truthful text of a stable refusal code and nothing on cancel', async () => {
    const send = vi.fn<Send>().mockRejectedValue(Object.assign(new Error('refused'), { status: 403, details: { reason: 'ip_reserved', stateChanged: false } }))
    boot(classicIps(), send)
    const form = $('[data-ip-change-form]') as HTMLFormElement
    ;(form.elements.namedItem('accountId') as HTMLSelectElement).value = account.id
    ;(form.elements.namedItem('ipv4') as HTMLSelectElement).value = '192.0.2.10'
    submit('[data-ip-change-form]'); await tick()
    expect($('[data-ip-change-status]').textContent).toBe(translator('en')('The address is reserved and is never offered for assignment. Nothing was changed.'))
    const cancelled = vi.fn<Send>()
    boot(classicIps(), cancelled, async () => false)
    ;($('[data-ip-change-form]') as HTMLFormElement).querySelector<HTMLSelectElement>('[name="accountId"]')!.value = account.id
    ;($('[data-ip-change-form]') as HTMLFormElement).querySelector<HTMLSelectElement>('[name="ipv4"]')!.value = '192.0.2.10'
    submit('[data-ip-change-form]'); await tick()
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('fills host binding from the usage reply and saves a reservation with readback', async () => {
    const send = vi.fn<Send>(async (method, path) => path === '/api/ips/usage' ? { observed: true, ips: [{ address: '192.0.2.10', binding: 'configured' }, { address: '192.0.2.11', binding: 'missing' }] }
      : { ip: { id: id(11), address: '192.0.2.11', reserved: true, ptrHostname: 'host.example.test' } })
    boot(classicIps(), send)
    $('[data-ip-usage-refresh]').click(); await tick()
    const cells = [...document.querySelectorAll<HTMLElement>('[data-ip-binding]')].map(cell => [cell.dataset.ipBinding, cell.dataset.state])
    expect(cells).toEqual([['192.0.2.10', 'configured'], ['192.0.2.11', 'missing']])
    const reserve = document.querySelector<HTMLFormElement>(`[data-ip-reserve-form][data-ip-reserve-id="${id(11)}"]`)!
    reserve.querySelector<HTMLInputElement>('[name="reserved"]')!.checked = true
    reserve.querySelector<HTMLInputElement>('[name="ptrHostname"]')!.value = 'host.example.test'
    reserve.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick()
    expect(send).toHaveBeenLastCalledWith('PATCH', `/api/ips/${id(11)}`, { reserved: true, ptrHostname: 'host.example.test' })
    expect($('[data-ip-reserve-status]').dataset.state).toBe('saved')
  })

  it('renders the same hooks in the v2 theme and disables every tool without root management', () => {
    const v2 = renderV2WhmServerIps(translator('en'), { locale: 'en', activeRoute: '/whm/server/ips', principal: root, ipPool: pool, accounts: [account], resellers: [reseller] }, { canRead: true, canManage: false })
    boot(v2, vi.fn<Send>())
    for (const hook of ['[data-ip-change-form]', '[data-ip-rebuild]', '[data-ip-migrate-form]', '[data-ip-range-form]', '[data-ip-assign6-form]', '[data-ip-usage-refresh]']) expect(document.querySelector(hook), hook).not.toBeNull()
    expect(($('[data-ip-rebuild]') as HTMLButtonElement).disabled).toBe(true)
    expect($('[data-ip-tools-status]').dataset.state).toBe('unavailable')
  })

  it('resets resellers to a saved list and emails all resellers, reporting skipped contacts', async () => {
    const send = vi.fn<Send>(async (method, path) => path.endsWith('/apply') ? { resellers: [reseller] } : { sent: ['resone'], failed: [], withoutContact: ['restwo'] })
    boot(renderClassicResellerAclLists({ locale: 'en', resellers: [reseller], aclLists: [{ name: 'support', acl: ['list-accounts'] }] }, true, [['list-accounts', 'List accounts']]) + renderClassicResellerMore({ locale: 'en', resellers: [reseller] }, true, true), send)
    ;($('[data-acl-list-apply-form]') as HTMLFormElement).querySelector<HTMLSelectElement>('[name="list"]')!.value = 'support'
    ;($('[data-acl-list-apply-form]') as HTMLFormElement).querySelector<HTMLInputElement>('[name="resellerId"]')!.checked = true
    submit('[data-acl-list-apply-form]'); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/resellers/acl-lists/support/apply', { resellerIds: [reseller.id] })
    const email = $('[data-reseller-email-form]') as HTMLFormElement
    email.querySelector<HTMLInputElement>('[name="subject"]')!.value = 'Maintenance'
    email.querySelector<HTMLTextAreaElement>('[name="body"]')!.value = 'Tonight.'
    submit('[data-reseller-email-form]'); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/resellers/email', { subject: 'Maintenance', body: 'Tonight.' })
    expect($('[data-reseller-email-status]').textContent).toContain('1 reseller has no contact address')
  })
})
