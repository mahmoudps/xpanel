// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import type { Account, Plan } from '@xpanel/core'
import { renderWhmSurface, type WhmSurfaceProps } from './surfaces/xwhm.ts'
import { readAccountBulkResult, WHM_ACCOUNT_BULK_CLIENT_BINDING } from './whm-account-bulk-client.ts'

const operationId = '50000000-0000-4000-8000-000000000001'
const account = (n: number): Account => ({ id: `20000000-0000-4000-8000-00000000000${n}`, username: `owner${n}`, uid: 1000 + n, gid: 1000 + n, home: `/home/owner${n}`, primaryDomain: `owner${n}.example.test`,
  planId: '30000000-0000-4000-8000-000000000001', ownerId: null, status: 'active', suspendReason: null, contactEmail: `owner${n}@example.test`, ipv4: '192.0.2.7', shell: 'none', createdAt: '2026-10-25T00:00:00.000Z' })
const accounts = [account(1), account(2), account(3)]
const plan: Plan = { id: '30000000-0000-4000-8000-000000000001', name: 'Bulk plan', ownerId: null, featureListId: '40000000-0000-4000-8000-000000000001', resources: { diskMb: 512, bandwidthMbMonth: 2048, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 }, caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 }, dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 128 }
const catalog = tools.map(tool => ['list-accounts', 'modify-account'].includes(tool.id) ? { ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } } : tool)
const props: WhmSurfaceProps = { principal: { kind: 'root', id: 'root-id', username: 'root' }, catalog, accounts, resellers: [], plans: [plan], activeRoute: '/whm/accounts' }
const reply = (results: { accountId: string; outcome: string; code?: string | null; reason?: string | null }[], id = operationId) => ({ operation: { id, reference: 'XP-JOB-000001', status: 'completed', replay: false }, action: 'suspend',
  results: results.map(item => ({ code: null, reason: null, ...item })), summary: {} })
const tick = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const bar = () => document.querySelector<HTMLElement>('[data-approved-account-bulk]')!
const control = (name: string) => bar().querySelector<HTMLButtonElement>(`[data-account-bulk-control="${name}"]`)!
const box = (n: number) => document.querySelector<HTMLInputElement>(`[data-account-row="owner${n}"] [data-account-selection]`)!
const pick = (...rows: number[]) => { for (const n of rows) { box(n).checked = true; box(n).dispatchEvent(new Event('change', { bubbles: true })) } }
const boot = (request: (method: string, path: string, body?: unknown) => Promise<unknown>, ask: (options: Record<string, unknown>) => Promise<unknown>) => {
  (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_ACCOUNT_BULK_CLIENT_BINDING)()(ask)
}

describe('bulk account result reader', { tags: ['unit'] }, () => {
  it('accepts exactly the submitted accounts in order and refuses anything else', () => {
    const ids = accounts.map(item => item.id)
    expect(readAccountBulkResult(reply([{ accountId: ids[0]!, outcome: 'applied' }, { accountId: ids[1]!, outcome: 'refused', code: 'CONFLICT' }, { accountId: ids[2]!, outcome: 'not-attempted' }]), ids, operationId).results.map(item => item.outcome)).toEqual(['applied', 'refused', 'not-attempted'])
    for (const bad of [
      reply([{ accountId: ids[1]!, outcome: 'applied' }, { accountId: ids[0]!, outcome: 'applied' }, { accountId: ids[2]!, outcome: 'applied' }]),
      reply([{ accountId: ids[0]!, outcome: 'applied' }, { accountId: ids[1]!, outcome: 'applied' }]),
      reply([{ accountId: ids[0]!, outcome: 'done' }, { accountId: ids[1]!, outcome: 'applied' }, { accountId: ids[2]!, outcome: 'applied' }]),
      reply([{ accountId: ids[0]!, outcome: 'applied', code: 'CONFLICT' }, { accountId: ids[1]!, outcome: 'applied' }, { accountId: ids[2]!, outcome: 'applied' }]),
      { ...reply([]), operation: { id: 'other', status: 'completed', replay: false } },
    ]) expect(() => readAccountBulkResult(bad, ids, operationId)).toThrow()
  })
})

describe('bulk account bar', { tags: ['feature'] }, () => {
  beforeEach(() => { document.body.innerHTML = renderWhmSurface(props) })
  it('enables the server-permitted actions and submits the selected accounts once with a typed reason', async () => {
    const calls: { method: string; path: string; body: Record<string, unknown> }[] = []
    boot(async (method, path, body) => {
      calls.push({ method, path, body: body as Record<string, unknown> })
      return reply([{ accountId: accounts[0]!.id, outcome: 'applied' }, { accountId: accounts[2]!.id, outcome: 'refused', code: 'CONFLICT' }], (body as { operationId: string }).operationId)
    }, async options => options.input ? 'Unpaid invoice' : true)
    expect(control('suspend').disabled).toBe(true)
    pick(1, 3)
    expect(bar().querySelector('[data-account-selected-count]')!.textContent).toBe('2 selected')
    expect(control('suspend').disabled).toBe(false)
    expect(control('plan').disabled).toBe(false)
    control('suspend').click()
    await tick()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/accounts/bulk-actions/suspend', body: { accounts: [{ id: accounts[0]!.id }, { id: accounts[2]!.id }], reason: 'Unpaid invoice' } })
    expect(calls[0]!.body.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const items = [...bar().querySelectorAll('[data-account-bulk-results] li')].map(item => [item.getAttribute('data-outcome'), item.textContent])
    expect(items).toEqual([['applied', 'owner1 Changed. Hosting verification is still required.'], ['refused', 'owner3 Not changed: the account is not in a state for this change.']])
    expect(document.querySelector('[data-account-row="owner1"] [data-account-status]')!.getAttribute('data-state')).toBe('verification-required')
    expect(document.querySelector('[data-account-row="owner3"] [data-account-status]')!.getAttribute('data-state')).toBe('active')
    expect(box(1).checked).toBe(false)
    expect(box(3).checked).toBe(true)
  })

  it('keeps a clicked row checked, counts it, and select-all checks and clears every loaded row', () => {
    boot(async () => reply([]), async () => true)
    const count = () => bar().querySelector('[data-account-selected-count]')!.textContent
    const all = document.querySelector<HTMLInputElement>('[data-account-select-all]')!
    box(1).click()
    expect(box(1).checked).toBe(true)
    expect(count()).toBe('1 selected')
    expect(control('suspend').disabled).toBe(false)
    box(1).click()
    expect(box(1).checked).toBe(false)
    expect(control('suspend').disabled).toBe(true)
    all.click()
    expect([1, 2, 3].map(n => box(n).checked)).toEqual([true, true, true])
    expect(all.checked).toBe(true)
    expect(count()).toBe('3 selected')
    all.click()
    expect([1, 2, 3].map(n => box(n).checked)).toEqual([false, false, false])
    expect(control('suspend').disabled).toBe(true)
  })

  it('locks the bar for review when the reply cannot be verified and sends nothing without confirmation', async () => {
    let calls = 0
    let confirmed = false
    boot(async () => { calls++; return { operation: { id: operationId } } }, async () => confirmed)
    pick(2)
    control('unsuspend').click()
    await tick()
    expect(calls).toBe(0)
    confirmed = true
    control('unsuspend').click()
    await tick()
    expect(calls).toBe(1)
    expect(bar().querySelector('[data-account-bulk-status]')!.textContent).toContain('could not be verified')
    expect([control('suspend'), control('unsuspend'), control('plan'), box(1)].every(item => item.disabled)).toBe(true)
  })
})
