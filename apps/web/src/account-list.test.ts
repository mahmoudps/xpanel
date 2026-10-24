/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPlan, validateUsername, type Account, type Reseller } from '@xpanel/core'
import { renderWhmSurface } from './surfaces/xwhm.ts'
import { ACCOUNT_LIST_CLIENT_SCRIPT, accountListModel, accountListRowAttributes, accountPlanPreviewModel, renderAccountListControls, renderAccountPlanPreview } from './account-list.ts'

const root = { kind: 'root' as const, id: 'root', username: 'operator' }
const reseller: Reseller = { id: 'owner-one', username: 'Owner One', acl: ['list-accounts'], maxAccounts: 100, totalDiskMb: 1000000, totalBandwidthMb: 1000000, oversell: false, nameservers: [], delegatedIps: [] }
const plan = defaultPlan({ id: 'plan-one', name: 'FirstPlan', featureListId: 'features-one' })
const row = (n: number, patch: Partial<Account> = {}): Account => ({ id: 'internal-' + n, username: 'user' + n, uid: 20000 + n, gid: 20000 + n, home: '/home/user' + n, primaryDomain: 'user' + n + '.example.test', planId: plan.id, ownerId: reseller.id, status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-10-23T00:00:00Z', ...patch })
afterEach(() => { document.body.replaceChildren(); document.documentElement.lang = 'en' })
const boot = (accounts: Account[], locale: 'en' | 'ar' = 'en') => {
  const model = accountListModel({ principal: root, accounts, plans: [plan], resellers: [reseller] })
  document.documentElement.lang = locale
  document.body.innerHTML = `<section data-accounts-workspace>${renderAccountListControls(model, locale)}<table><tbody>${model.accounts.map(account => `<tr data-account-row="${account.username}" ${accountListRowAttributes(account)}><td>${account.username}<button type="button" data-action="terminate-account">Delete</button><details data-account-details><summary>Details</summary>2001:db8::10</details></td></tr>`).join('')}</tbody></table></section>`
  new Function(ACCOUNT_LIST_CLIENT_SCRIPT)()
}
const visible = () => Array.from(document.querySelectorAll<HTMLElement>('[data-account-row]')).filter(row => !row.hidden)
const filter = (selector: string, value: string) => { const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!; input.value = value; input.dispatchEvent(new Event(input.tagName === 'INPUT' ? 'input' : 'change', { bubbles: true })) }

describe('native username authority alignment', () => {
  it('accepts core-valid lengths 1/2/3/16 on the actual visible create control without dropping the 7 native fields', () => {
    document.body.innerHTML = renderWhmSurface({ activeRoute: '/whm/accounts/new', principal: root, accounts: [], plans: [plan] })
    const form = document.querySelector<HTMLFormElement>('[data-create-account-form]')!
    const username = form.querySelector<HTMLInputElement>('[name="username"]')!
    expect(form.querySelectorAll('input[name],select[name]')).toHaveLength(7)
    expect(form.querySelector('label[for="new-acc-username"]')).not.toBeNull()
    for (const value of ['a', 'ab', 'abc', 'abcdefghijklmnop']) {
      expect(validateUsername(value)).toBe(value)
      username.value = value; expect(username.checkValidity()).toBe(true)
    }
    for (const value of ['', 'abcdefghijklmnopq', 'A', 'a_', 'a-b', '../a']) { username.value = value; expect(username.checkValidity()).toBe(false) }
    // Reserved-name authority stays on the server; the syntax pattern is not authorization.
    expect(() => validateUsername('root')).toThrow()
  })
})

describe('scoped loaded account list projection', () => {
  it('excludes neighboring accounts and their owner/plan metadata before projecting filters', () => {
    const neighborPlan = { ...plan, id: 'neighbor-plan', name: 'Private neighbor plan' }
    const accounts = [row(1), row(2, { ownerId: 'neighbor-owner', planId: neighborPlan.id })]
    const before = JSON.stringify(accounts)
    const model = accountListModel({ principal: { kind: 'reseller', id: reseller.id, username: reseller.username }, activeReseller: reseller, accounts, plans: [plan, neighborPlan], resellers: [reseller, { ...reseller, id: 'neighbor-owner', username: 'Private neighbor owner' }] })
    expect(model.accounts.map(account => account.id)).toEqual(['internal-1'])
    expect(model.owners).toEqual([{ value: reseller.id, label: reseller.username }])
    expect(model.plans).toEqual([{ value: plan.id, label: 'First Plan' }])
    expect(JSON.stringify(model)).not.toContain('Private neighbor')
    expect(JSON.stringify(accounts)).toBe(before)
  })
  it('distinguishes denied, unread and genuinely empty states without invented counts', () => {
    expect(accountListModel({ principal: { kind: 'user', id: 'account-user', username: 'user', accountId: 'internal-1' }, accounts: [row(1)] }).state).toBe('forbidden')
    expect(accountListModel({ principal: { kind: 'reseller', id: reseller.id, username: reseller.username }, activeReseller: { ...reseller, acl: [] }, accounts: [row(1)] }).state).toBe('forbidden')
    const missing = accountListModel({ principal: root })
    expect(missing.state).toBe('unavailable'); expect(renderAccountListControls(missing)).toContain('unavailable')
    expect(renderAccountListControls(missing)).not.toContain('data-list-count')
    expect(accountListModel({ principal: root, accounts: [] }).state).toBe('empty')
  })
  it('sorts newest first with deterministic username fallback without mutating supplied rows', () => {
    const accounts = [row(2), row(1), row(3, { createdAt: '2026-10-24T00:00:00Z' }), row(4, { createdAt: 'unread' })]
    expect(accountListModel({ principal: root, accounts }).accounts.map(account => account.username)).toEqual(['user3', 'user1', 'user2', 'user4'])
    expect(accounts.map(account => account.username)).toEqual(['user2', 'user1', 'user3', 'user4'])
  })
  it('escapes technical filter keys and labels without inventing readable references', () => {
    expect(accountListRowAttributes(row(1, { primaryDomain: '"><script>alert(1)</script>' }))).not.toContain('<script>')
    const model = accountListModel({ principal: root, accounts: [row(1)], plans: [{ ...plan, name: '<img src=x>' }], resellers: [reseller] })
    expect(renderAccountListControls(model)).toContain('&lt;img src=x&gt;')
  })
})

describe('loaded-list native controls', () => {
  it('pages only supplied rows and preserves the same action and Details elements', () => {
    boot(Array.from({ length: 25 }, (_, i) => row(i + 1)))
    const firstAction = document.querySelector('[data-action="terminate-account"]')
    expect(visible()).toHaveLength(20)
    document.querySelector<HTMLButtonElement>('[data-list-next]')!.click(); expect(visible()).toHaveLength(5)
    expect(document.querySelector('[data-list-page]')?.textContent).toBe('2 / 2')
    document.querySelector<HTMLButtonElement>('[data-list-previous]')!.click(); expect(visible()).toHaveLength(20)
    expect(document.querySelector('[data-action="terminate-account"]')).toBe(firstAction)
    expect(document.querySelectorAll('[data-account-details]')).toHaveLength(25)
  })
  it('filters by real search/owner/plan/state and resets to a clamped page', () => {
    boot([...Array.from({ length: 24 }, (_, i) => row(i + 1)), row(99, { ownerId: null, status: 'suspended' })])
    document.querySelector<HTMLButtonElement>('[data-list-next]')!.click()
    filter('[data-list-search-input]', 'user99.example.test'); expect(visible()).toHaveLength(1)
    expect(document.querySelector('[data-list-page]')?.textContent).toBe('1 / 1')
    filter('[data-list-search-input]', ''); filter('[data-list-owner-filter]', 'root'); expect(visible()).toHaveLength(1)
    filter('[data-list-owner-filter]', ''); filter('[data-list-plan-filter]', plan.id); filter('[data-list-state-filter]', 'suspended')
    expect(visible().map(row => row.dataset.accountRow)).toEqual(['user99'])
    filter('[data-list-search-input]', 'absent'); expect(visible()).toHaveLength(0)
    expect(document.querySelector<HTMLElement>('[data-list-empty]')!.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-list-pages]')!.hidden).toBe(true)
  })
  it('renders truthful loaded counts using ASCII digits in Arabic', () => {
    boot([row(1), row(2)], 'ar')
    const count = document.querySelector('[data-list-count]')!.textContent!
    expect(count).toContain('1-2'); expect(count).not.toMatch(/[٠-٩۰-۹]/)
    expect(document.querySelector('[data-list-previous]')?.textContent).toBe('السابق')
  })
})

describe('readonly native create-plan preview', () => {
  it('distinguishes absent capacity from fit/refusal and excludes neighboring accounts from the calculation', () => {
    const principal = { kind: 'reseller' as const, id: reseller.id, username: reseller.username }
    const actor = { ...reseller, acl: ['create-account', 'list-accounts'] as Reseller['acl'] }
    expect(accountPlanPreviewModel({ principal, activeReseller: actor, plans: [plan] }).plans[0]?.capacity).toBe('unavailable')
    expect(accountPlanPreviewModel({ principal, activeReseller: actor, plans: [plan], accounts: [row(1, { ownerId: 'neighbor' })] }).plans[0]?.capacity).toBe('fits')
    expect(accountPlanPreviewModel({ principal, activeReseller: { ...actor, maxAccounts: 0 }, plans: [plan], accounts: [] }).plans[0]?.capacity).toBe('exceeds')
    expect(accountPlanPreviewModel({ principal, activeReseller: actor, plans: [plan], accounts: [row(1, { planId: 'unread-plan' })] }).plans[0]?.capacity).toBe('unavailable')
  })
  it('does not infer fit from an empty account list when the actor cannot read accounts', () => {
    const actor = { ...reseller, acl: ['create-account'] as Reseller['acl'] }
    expect(accountPlanPreviewModel({ principal: { kind: 'reseller', id: actor.id, username: actor.username }, activeReseller: actor, plans: [plan], accounts: [] }).plans[0]?.capacity).toBe('unavailable')
  })
  it('updates only readonly text on native selection and escapes serialized display names', () => {
    const hostile = { ...plan, id: 'second-plan', name: '</script><img src=x>', resources: { ...plan.resources, diskMb: 8192 } }
    const model = accountPlanPreviewModel({ principal: root, plans: [plan, hostile], accounts: [] })
    const html = renderAccountPlanPreview(model)
    expect(html).not.toContain('</script><img')
    document.body.innerHTML = `<form data-create-account-form><label for="native-plan">Plan</label><select id="native-plan" name="planId"><option value="${plan.id}">First</option><option value="second-plan">Second</option></select>${html}</form>`
    const select = document.querySelector('select')!
    new Function(ACCOUNT_LIST_CLIENT_SCRIPT)()
    expect(document.querySelector('[data-preview-plan-name]')?.textContent).toBe('First Plan')
    select.value = 'second-plan'; select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(document.querySelector('[data-preview-plan-name]')?.textContent).toBe(hostile.name)
    expect(document.querySelector('[data-preview-plan-disk]')?.textContent).toBe('8192')
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelectorAll('input,select')).toHaveLength(1)
    expect(select.disabled).toBe(false)
  })
})
