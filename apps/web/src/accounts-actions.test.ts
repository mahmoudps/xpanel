/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import { tools } from '@xpanel/catalog'
const fixtureCatalog = tools.filter(tool => ['create-account', 'list-accounts'].includes(tool.id)).map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
import { renderWhmSurface } from './surfaces/xwhm.ts'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import { translator } from './i18n.ts'
import { renderV2WhmAccountList } from './themes/v2/pages/xwhm/accounts/list.ts'
const plan = defaultPlan({id:'plan-fixture',name:'Standard',featureListId:'features-fixture'})
const account: Account = {id:'internal-alpha',username:'alpha',uid:20001,gid:20001,home:'/home/alpha',primaryDomain:'alpha.example.test',planId:plan.id,ownerId:null,status:'active',suspendReason:null,contactEmail:'alpha@example.test',ipv4:'192.0.2.10',ipv6:'2001:db8::10',extraIps:['192.0.2.11'],shell:'jailed',createdAt:'2026-10-23T00:00:00Z'}
const second = {...account,id:'internal-beta',username:'beta',status:'suspended' as const,primaryDomain:'beta.example.test'}
const render = (locale:'en'|'ar'='en') => renderWhmSurface({locale,activeRoute:'/whm/accounts',principal:{kind:'root',id:'fixture-root',username:'operator'},accounts:[account,second],plans:[plan],catalog:fixtureCatalog})
const el = <T extends HTMLElement=HTMLElement>(selector:string) => document.querySelector<T>(selector)!
let listeners: [EventTarget,string,EventListenerOrEventListenerObject,boolean|AddEventListenerOptions|undefined][]
beforeEach(()=>{listeners=[];for(const target of [document,window]) {const add=target.addEventListener.bind(target);vi.spyOn(target,'addEventListener').mockImplementation((name,handler,options)=>{listeners.push([target,name,handler,options]);add(name,handler,options)})}document.documentElement.dataset.realtimeEnabled='false';document.documentElement.lang='en';document.body.innerHTML=render()})
afterEach(()=>{for(const [target,name,handler,options] of listeners)target.removeEventListener(name,handler,options);vi.restoreAllMocks();document.body.replaceChildren();delete (window as any).xpanelSessionRequest})
function boot(){ const dialog=el<HTMLDialogElement>('[data-account-dialog]'); dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>{dialog.removeAttribute('open');dialog.dispatchEvent(new Event('close'))}; new Function('window','document',BROWSER_REALTIME_SCRIPT)(window,document);return dialog }
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))
const preferenceRoute = '/api/auth/ui-preferences'
const preferenceView = { state: 'default', uiTheme: 'classic', choices: ['classic'], revision: 'a'.repeat(64), updatedAt: null, application: 'next_navigation' }
function expectedAccountMutation(request: { mock: { calls: readonly (readonly unknown[])[] } }, method: string, path: string): readonly unknown[] {
  const preferenceReads = request.mock.calls.filter(call => call[0] === 'GET' && call[1] === preferenceRoute)
  expect(preferenceReads).toEqual([['GET', preferenceRoute]])
  const mutations = request.mock.calls.filter(call => !(call[0] === 'GET' && call[1] === preferenceRoute))
  expect(mutations).toHaveLength(1)
  expect(mutations[0]!.slice(0, 2)).toEqual([method, path])
  return mutations[0]!
}
describe('account action target and confirmation contracts',()=>{
 it('renders ten approved account columns and one initially closed native dialog',()=>{expect(Array.from(document.querySelectorAll('.xp-accounts__table thead th'), cell => cell.textContent?.trim())).toEqual(['Select','Account','Primary domain','Plan','Owner','IP','Disk','Bandwidth','Status','Actions']);expect(document.querySelectorAll('dialog[data-account-dialog]')).toHaveLength(1);expect(el('dialog').hasAttribute('open')).toBe(false);expect(document.querySelector('form[action="/api/whm/accounts/terminate"]')).toBeNull();expect(el('[data-account-details]').textContent).toContain('xpanel-20001.slice');expect(el('[data-account-details]').textContent).toContain('192.0.2.11')})
 it('binds the second row independently and rejects another username and Enter',async()=>{const dialog=boot(),request=vi.fn();(window as any).xpanelSessionRequest=request;el('[data-account-row="beta"] [data-action="terminate-account"]').click();expect(dialog.open).toBe(true);expect(el('[data-account-dialog-username]').textContent).toBe('beta');const input=el<HTMLInputElement>('[data-type-to-confirm]');input.value='alpha';input.dispatchEvent(new Event('input'));expect(el<HTMLButtonElement>('[data-account-action-submit]').disabled).toBe(true);el('form[data-account-action-form]').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));expect(request).not.toHaveBeenCalled();el('[data-account-action-cancel]').click();el('[data-account-row="alpha"] [data-action="terminate-account"]').click();expect(input.value).toBe('')})
 it('captures immutable row identity, blocks duplicates, and preserves input on 412 refusal',async()=>{let reject!:(error:any)=>void;const request=vi.fn(()=>new Promise((_resolve,rejectPromise)=>{reject=rejectPromise}));(window as any).xpanelSessionRequest=request;boot();el('[data-account-row="beta"] [data-action="terminate-account"]').click();const input=el<HTMLInputElement>('[data-type-to-confirm]');input.value='beta';input.dispatchEvent(new Event('input'));const form=el<HTMLFormElement>('[data-account-action-form]');form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await tick();expect(expectedAccountMutation(request,'DELETE','/api/accounts/internal-beta')[2]).toEqual({confirmUsername:'beta'});expect(request).toHaveBeenCalledWith('DELETE','/api/accounts/internal-beta',{confirmUsername:'beta'});reject(Object.assign(new Error('bounded'),{status:412,details:{verificationRequired:true,stateChanged:false}}));await tick();expect(input.value).toBe('beta');expect(el('[data-account-action-status]').textContent).toMatch(/unavailable/i);expect(document.querySelector('[data-account-row="beta"]')).not.toBeNull();expect(document.querySelector('#xp-toast-region')).toBeNull()})
 it('uses explicit suspend and unsuspend routes and never a generic success toast',async()=>{const request=vi.fn().mockRejectedValue(Object.assign(new Error('bounded'),{status:503,details:{stateChanged:true,verificationRequired:true}}));(window as any).xpanelSessionRequest=request;boot();el('[data-account-row="beta"] [data-action="unsuspend-account"]').click();el('[data-account-action-form]').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await tick();expect(request).toHaveBeenCalledWith('POST','/api/accounts/internal-beta/unsuspend',{});expect(el('[data-account-action-status]').textContent).toMatch(/not be verified/i);expect(el('[data-account-action-status]').getAttribute('data-state')).toBe('failed');expect(document.querySelector('#xp-toast-region')).toBeNull()})
 it('hides mutation actions for a reseller without the corresponding ACL',()=>{document.body.innerHTML=renderWhmSurface({activeRoute:'/whm/accounts',principal:{kind:'reseller',id:'reseller-fixture',username:'reseller'},activeReseller:{id:'reseller-fixture',username:'reseller',acl:['list-accounts'],maxAccounts:5,totalDiskMb:100,totalBandwidthMb:100,oversell:false,nameservers:[],delegatedIps:[]},accounts:[account],plans:[plan]});expect(document.querySelector('[data-action="terminate-account"]')).toBeNull();expect(document.querySelector('[data-action="suspend-account"]')).toBeNull()})
 it('offers a one-time Log in to xPanel only for active accounts the viewer may edit',()=>{const handoff=(row:string)=>document.querySelector<HTMLButtonElement>(`[data-account-row="${row}"] button[data-handoff="xpanel"]`);expect(handoff('alpha')?.dataset.handoffAccount).toBe('internal-alpha');expect(handoff('beta')).toBeNull();expect(document.body.innerHTML).not.toMatch(/data-panel-switch|href="https?:/);document.body.innerHTML=renderWhmSurface({activeRoute:'/whm/accounts',principal:{kind:'reseller',id:'reseller-fixture',username:'reseller'},activeReseller:{id:'reseller-fixture',username:'reseller',acl:['list-accounts'],maxAccounts:5,totalDiskMb:100,totalBandwidthMb:100,oversell:false,nameservers:[],delegatedIps:[]},accounts:[{...account,ownerId:'reseller-fixture'}],plans:[plan]});expect(document.querySelector('[data-handoff]')).toBeNull()})
 it('localizes bounded refusal without raw server messages',async()=>{document.documentElement.lang='ar';document.body.innerHTML=render('ar');(window as any).xpanelSessionRequest=vi.fn().mockRejectedValue(Object.assign(new Error('private-host-output'),{status:412,details:{verificationRequired:true,stateChanged:false}}));boot();el('[data-account-row="alpha"] [data-action="terminate-account"]').click();const input=el<HTMLInputElement>('[data-type-to-confirm]');input.value='alpha';input.dispatchEvent(new Event('input'));el('[data-account-action-form]').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await tick();expect(el('[data-account-action-status]').textContent).toContain('غير متاح');expect(el('[data-account-action-status]').textContent).not.toContain('private-host-output')})
})

describe('account configuration acknowledgements', () => {
  it.each([
    { theme: 'classic', username: 'alpha', verb: 'suspend', state: 'suspended' },
    { theme: 'classic', username: 'beta', verb: 'unsuspend', state: 'active' },
    { theme: 'v2', username: 'alpha', verb: 'suspend', state: 'suspended' },
    { theme: 'v2', username: 'beta', verb: 'unsuspend', state: 'active' },
  ] as const)('uses the theme-owned pending status after $theme $verb acceptance', async ({ theme, username, verb, state }) => {
    if (theme === 'v2') document.body.innerHTML = renderV2WhmAccountList(translator('en'), {
      principal: { kind: 'root', id: 'fixture-root', username: 'operator' },
      accounts: [account, second], plans: [plan], catalog: fixtureCatalog,
    })
    const chosen = username === 'alpha' ? account : second
    const request = vi.fn().mockResolvedValue({ account: { ...chosen, status: state }, reconcile: { status: 'applied' }, execution: { status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true } })
    ;(window as any).xpanelSessionRequest = request
    boot()
    const row = el(`[data-account-row="${username}"]`)
    const template = row.querySelector<HTMLTemplateElement>('template[data-account-status-pending]')!
    const expectedFragment = template.innerHTML
    const initialState = row.querySelector('[data-account-status]')!.getAttribute('data-state')
    expect(initialState).toBe(chosen.status)
    el(`[data-account-row="${username}"] [data-action="${verb}-account"]`).click()
    el('[data-account-action-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    const observedStatus = row.querySelector('[data-account-status]')!
    expect(observedStatus.innerHTML).toBe(expectedFragment)
    expect(observedStatus.getAttribute('data-state')).toBe('verification-required')
    expect(observedStatus.textContent).toBe('Verification required')
    expect(el('[data-account-action-status]').getAttribute('data-state')).toBe('pending')
    expect(el<HTMLButtonElement>('[data-account-action-submit]').disabled).toBe(true)
    expect(row.getAttribute('data-list-state')).toBe(chosen.status)
    expect(request).toHaveBeenCalledWith('POST', `/api/accounts/${chosen.id}/${verb}`, verb === 'suspend' ? { reason: '' } : {})
    expect(BROWSER_REALTIME_SCRIPT).not.toContain("querySelector('[data-account-status] .xp-badge")
  })

  it('keeps a global apply pending instead of claiming verified suspension', async () => {
    const request = vi.fn().mockResolvedValue({ account: { ...account, status: 'suspended' }, reconcile: { status: 'applied' }, execution: { status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true } })
    ;(window as any).xpanelSessionRequest = request
    boot()
    el('[data-account-row="alpha"] [data-action="suspend-account"]').click()
    el('[data-account-action-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    expect(el('[data-account-action-status]').getAttribute('data-state')).toBe('pending')
    expect(el('[data-account-action-status]').textContent).toContain('Hosting verification')
    expect(el<HTMLButtonElement>('[data-account-action-submit]').disabled).toBe(true)
    expect(el('[data-account-row="alpha"] [data-account-status]').textContent).toContain('Verification required')
    el('[data-account-action-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    expectedAccountMutation(request, 'POST', `/api/accounts/${account.id}/suspend`)
  })
  it('creates through the actual API, clears the password, and preserves non-secret drafts on refusal', async () => {
    document.body.innerHTML = renderWhmSurface({ activeRoute: '/whm/accounts/new', principal: { kind: 'root', id: 'fixture-root', username: 'operator' }, plans: [plan], accounts: [], catalog: fixtureCatalog })
    const request = vi.fn().mockRejectedValue(Object.assign(new Error('private-output'), { status: 412, details: { stateChanged: false } }))
    ;(window as any).xpanelSessionRequest = request
    new Function('window', 'document', BROWSER_REALTIME_SCRIPT)(window, document)
    el<HTMLInputElement>('#new-acc-username').value = 'newowner'
    el<HTMLInputElement>('#new-acc-domain').value = 'newowner.example.test'
    el<HTMLInputElement>('#new-acc-password').value = 'fixture-' + 'x'.repeat(16)
    const form = el<HTMLFormElement>('[data-create-account-form]')
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    expectedAccountMutation(request, 'POST', '/api/accounts')
    expect(el<HTMLInputElement>('#new-acc-password').value).toBe('')
    expect(el<HTMLInputElement>('#new-acc-username').value).toBe('newowner')
    expect(el('[data-account-create-status]').textContent).toContain('No changes')
    expect(el('[data-account-create-status]').textContent).not.toContain('private-output')
  })
})
describe('phase-1 write responses', () => {
  const applied = { status: 'applied', generation: { id: 4, status: 'active', checksum: 'a'.repeat(64) }, filesCount: 2, durationMs: 3 }
  const execution = { status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true }
  it.each([
    { status: 500, code: 'INTERNAL_ERROR' },
    { status: 500, code: 'INTERNAL_ERROR', details: { stateChanged: false } },
    { status: 500, code: 'INTERNAL_ERROR', details: { stateChanged: true, verificationRequired: true, unknownOutcome: true, needsAttention: true } },
  ])('keeps the submitted identity and blocks repeat after an injected post-save failure: %j', async failure => {
    document.body.innerHTML = renderWhmSurface({ activeRoute: '/whm/accounts/new', principal: { kind: 'root', id: 'fixture-root', username: 'operator' }, plans: [plan], accounts: [], catalog: fixtureCatalog })
    const stored: { username: string; primaryDomain: string }[] = []
    const request = vi.fn(async (method: string, path: string, body?: { username: string; primaryDomain: string }) => {
      if (method === 'GET' && path === preferenceRoute) return preferenceView
      stored.push({ username: body!.username, primaryDomain: body!.primaryDomain })
      throw Object.assign(new Error('private post-save failure'), failure)
    })
    ;(window as any).xpanelSessionRequest = request
    new Function('window', 'document', BROWSER_REALTIME_SCRIPT)(window, document)
    el<HTMLInputElement>('#new-acc-username').value = 'newowner'
    el<HTMLInputElement>('#new-acc-domain').value = 'newowner.example.test'
    el<HTMLInputElement>('#new-acc-password').value = 'fixture-' + 'x'.repeat(16)
    const form = el<HTMLFormElement>('[data-create-account-form]')
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    expect(stored).toEqual([{ username: 'newowner', primaryDomain: 'newowner.example.test' }])
    expectedAccountMutation(request, 'POST', '/api/accounts')
    const text = el('[data-account-create-status]').textContent ?? ''
    expect(text).toContain('creation outcome is unverified')
    expect(text).toContain('Review accounts before retrying')
    expect(text).not.toContain('No changes were made')
    expect(text).not.toContain('private post-save failure')
    expect(el<HTMLInputElement>('#new-acc-username').value).toBe('newowner')
    expect(el<HTMLInputElement>('#new-acc-domain').value).toBe('newowner.example.test')
    expect(el<HTMLInputElement>('#new-acc-password').value).toBe('')
    expect([...form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')].every(control => control.disabled)).toBe(true)
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    expect(BROWSER_REALTIME_SCRIPT).toContain('Checked on the server after creation.')
    expect(translator('ar')('Checked on the server after creation.')).toBe('يُفحص على الخادم بعد الإنشاء.')
  })
  it('accepts the API create, suspend and terminate bodies', async () => {
    document.body.innerHTML = renderWhmSurface({ activeRoute: '/whm/accounts/new', principal: { kind: 'root', id: 'fixture-root', username: 'operator' }, plans: [plan], accounts: [], catalog: fixtureCatalog })
    ;(window as any).xpanelSessionRequest = vi.fn().mockResolvedValue({ account: { ...account, username: 'submitted', ipv4: '192.0.2.10' }, reconcile: applied, execution })
    new Function('window', 'document', BROWSER_REALTIME_SCRIPT)(window, document)
    el<HTMLInputElement>('#new-acc-username').value = 'submitted'
    el<HTMLInputElement>('#new-acc-domain').value = 'submitted.example.test'
    el<HTMLInputElement>('#new-acc-password').value = 'synthetic-' + 'x'.repeat(16)
    el<HTMLFormElement>('[data-create-account-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    expect(el('[data-account-create-status]').textContent).toContain('Account configuration created')
    document.body.innerHTML = render()
    const dialog = boot()
    ;(window as any).xpanelSessionRequest = vi.fn().mockResolvedValue({ ok: true, purged: true })
    el('[data-account-row="alpha"] [data-action="terminate-account"]').click()
    const input = el<HTMLInputElement>('[data-type-to-confirm]')
    input.value = 'alpha'
    input.dispatchEvent(new Event('input'))
    el('[data-account-action-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    expect(el('[data-account-action-status]').textContent).toContain('Account removed')
    expect(dialog.open).toBe(true)
    document.body.innerHTML = render()
    boot()
    ;(window as any).xpanelSessionRequest = vi.fn().mockResolvedValue({ account: { ...account, status: 'suspended' }, reconcile: applied, execution })
    el('[data-account-row="alpha"] [data-action="suspend-account"]').click()
    el('[data-account-action-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    expect(el('[data-account-action-status]').textContent).toContain('Account suspended')
  })
})
describe('creation request identity and uncertain outcomes', () => {
  function prepare() {
    document.body.innerHTML = renderWhmSurface({ activeRoute: '/whm/accounts/new', principal: { kind: 'root', id: 'fixture-root', username: 'operator' }, plans: [plan], accounts: [], catalog: fixtureCatalog })
    new Function('window', 'document', BROWSER_REALTIME_SCRIPT)(window, document)
    el<HTMLInputElement>('#new-acc-username').value = 'submitted'
    el<HTMLInputElement>('#new-acc-domain').value = 'submitted.example.test'
    el<HTMLInputElement>('#new-acc-password').value = 'synthetic-' + 'x'.repeat(16)
    return el<HTMLFormElement>('[data-create-account-form]')
  }
  it('freezes submitted controls during a delayed request and keeps accepted identity stable', async () => {
    let resolveRequest!: (result: unknown) => void
    ;(window as any).xpanelSessionRequest = vi.fn(() => new Promise(resolve => { resolveRequest = resolve }))
    const form = prepare()
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    const controls = [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')]
    expect(controls).toHaveLength(10)
    expect(controls.filter(control => control.name === 'ownerId')).toHaveLength(1)
    expect(controls.filter(control => control.name === 'shell')).toHaveLength(2)
    expect(controls.every(control => control.disabled)).toBe(true)
    // Scripted DOM mutation cannot silently change the identity shown for an accepted request.
    el<HTMLInputElement>('#new-acc-username').value = 'unsent'
    resolveRequest({ account: { ...account, username: 'submitted' }, reconcile: { status: 'applied' }, execution: { status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true } })
    await tick()
    expect(el<HTMLInputElement>('#new-acc-username').value).toBe('submitted')
    expect(el<HTMLInputElement>('#new-acc-username').readOnly).toBe(true)
    expect(el<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true)
  })
  it('keeps state-changing 409 outcomes locked for review instead of suggesting another username', async () => {
    ;(window as any).xpanelSessionRequest = vi.fn().mockRejectedValue(Object.assign(new Error('bounded'), { status: 409, details: { reason: 'state_changed_during_apply', stateChanged: true, verificationRequired: true } }))
    const form = prepare()
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    const text = el('[data-account-create-status]').textContent
    expect(text).toContain('Review accounts before retrying')
    expect(text).not.toContain('Choose another username')
    expect(el<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true)
    expect(el<HTMLInputElement>('#new-acc-username').disabled).toBe(true)
  })
})
