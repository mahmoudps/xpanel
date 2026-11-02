/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultPlan, planErrors, validatePlan, type Plan } from '@xpanel/core'
import { renderV2PlanEditor } from './themes/v2/pages/xwhm/plans/editor.ts'
import { v2Messages } from './themes/v2/messages.ts'
import { PRESENTATION_TABS_CLIENT_BINDING } from './presentation-tabs-client.ts'
import { PLAN_CAP_FIELDS, PLAN_EDITOR_CLIENT_SCRIPT, PLAN_QUOTA_FIELD, PLAN_RESOURCE_FIELDS, planEditorPayload, planEditorRequest, planEditorReceiptMatches, renderPlanEditor, type PlanEditorValues } from './plan-editor.ts'

const id = '10000000-0000-4000-8000-000000000001'
const featureList = { id: '20000000-0000-4000-8000-000000000001', name: 'Standard tools' }
const plan = defaultPlan({ id, name: 'Standard', featureListId: featureList.id })
type Request = (method: string, path: string, body: unknown) => Promise<unknown>
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
const form = () => document.querySelector<HTMLFormElement>('[data-native-plan-editor]')!
const save = () => form().querySelector<HTMLButtonElement>('[data-native-plan-save]')!
const field = (name: string) => form().elements.namedItem(name) as HTMLInputElement
const values = (p: Plan = plan): PlanEditorValues => ({
  name: p.name, featureListId: p.featureListId, shell: p.shell, dedicatedIp: p.dedicatedIp,
  ...Object.fromEntries([...PLAN_RESOURCE_FIELDS, ...PLAN_CAP_FIELDS, PLAN_QUOTA_FIELD].flatMap(item => {
    const amounts = { ...p.resources, ...p.caps, defaultMailboxQuotaMb: p.defaultMailboxQuotaMb }
    const amount = amounts[item.key as keyof typeof amounts]
    return [[item.key, amount === 'unlimited' ? '' : String(Number(amount) / item.scale)], [`unlimited.${item.key}`, amount === 'unlimited']]
  })),
})
const boot = (existing: Plan | null = plan) => {
  document.body.innerHTML = renderPlanEditor({ locale: document.documentElement.lang === 'ar' ? 'ar' : 'en', ...(existing ? { plan: existing } : {}), featureLists: [featureList], ownerId: null, canManage: true, allowUnlimited: true })
  new Function(PLAN_EDITOR_CLIENT_SCRIPT)()
}
const edit = (name: string, value: string) => { field(name).value = value; field(name).dispatchEvent(new Event('input', { bubbles: true })) }
const submit = () => form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
let listeners: [string, EventListenerOrEventListenerObject][]
beforeEach(() => {
  listeners = []
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, listener, options) => { listeners.push([name, listener]); add(name, listener, options) })
  document.documentElement.lang = 'en'
})
afterEach(() => { listeners.forEach(([name, listener]) => window.removeEventListener(name, listener)); document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest; vi.restoreAllMocks() })
const request = (fn: Request) => { (window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest = fn }

describe('native plan values', () => {
  it('reads every visible resource, cap and mailbox value without synthetic payload defaults', () => {
    const raw = values()
    raw.ioReadBps = '8.5'; raw.ioWriteBps = '4'; raw.databases = '17'; raw.phpWorkers = '13'
    raw.defaultMailboxQuotaMb = '2048'; raw.diskMb = '4096'; raw.name = 'Changed plan'
    const body = planEditorPayload(raw, null)
    expect(body.resources.ioReadBps).toBe(8.5 * 1024 * 1024)
    expect(body.resources.ioWriteBps).toBe(4 * 1024 * 1024)
    expect(body.caps.databases).toBe(17); expect(body.caps.phpWorkers).toBe(13)
    expect(body.defaultMailboxQuotaMb).toBe(2048)
    expect(body.enforceBandwidth).toBe(false)
    expect(planEditorPayload({ ...raw, enforceBandwidth: true }, null).enforceBandwidth).toBe(true)
    expect(planErrors({ id, ...body })).toEqual([])
    expect(validatePlan({ id, ...body }, { kind: 'root', id: 'root', username: 'operator' }).resources.ioReadBps).toBe(8.5 * 1024 * 1024)
    expect(body).not.toHaveProperty('id')
  })
  it.each(['', ' ', 'garbage', 'Infinity', '1e4', '-1', '1.000000000000001', '٤'])('rejects invalid resource %j instead of changing it to unlimited', invalid => {
    expect(() => planEditorPayload({ ...values(), ioReadBps: invalid }, null)).toThrow('ioReadBps')
  })
  it('uses explicit unlimited switches, preserves zero caps, and rejects quota above disk', () => {
    expect(planEditorPayload({ ...values(), addonDomains: '0', 'unlimited.ioReadBps': true, ioReadBps: '' }, null)).toMatchObject({ resources: { ioReadBps: 'unlimited' }, caps: { addonDomains: 0 } })
    expect(() => planEditorPayload({ ...values(), diskMb: '64', defaultMailboxQuotaMb: '65' }, null)).toThrow('defaultMailboxQuotaMb')
    const incomplete = values(); delete incomplete.mailboxes
    expect(() => planEditorPayload(incomplete, null)).toThrow('mailboxes')
  })
  it('accepts only a matching persisted receipt, independently of object key order', () => {
    const payload = planEditorPayload(values(), null)
    const reordered = { ...plan, resources: Object.fromEntries(Object.entries(plan.resources).reverse()) as Plan['resources'] }
    expect(planEditorReceiptMatches(reordered, payload, id)).toBe(true)
    expect(planEditorReceiptMatches({ ...plan, id: '30000000-0000-4000-8000-000000000001' }, payload, id)).toBe(false)
    expect(planEditorReceiptMatches({ ...plan, caps: { ...plan.caps, databases: 99 } }, payload, id)).toBe(false)
  })
  it('uses registered PATCH without an owner field and never turns a missing saved ID into an edit', () => {
    const payload = planEditorPayload(values(), null)
    expect(planEditorRequest(payload)).toMatchObject({ method: 'POST', path: '/api/plans', body: { ownerId: null } })
    expect(planEditorRequest(payload, id)).toMatchObject({ method: 'PATCH', path: '/api/plans/' + id })
    expect(planEditorRequest(payload, id).body).not.toHaveProperty('ownerId')
    expect(() => planEditorRequest(payload, 'not-a-saved-id')).toThrow('id')
  })
  it('preserves the stored owner on edit even when the caller owns the create defaults', () => {
    document.body.innerHTML = renderPlanEditor({ plan: { ...plan, ownerId: 'stored-owner' }, featureLists: [featureList], ownerId: null, canManage: true, allowUnlimited: true })
    expect(form().dataset.planOwner).toBe('stored-owner')
  })
  it('keeps actual feature names visible and fails closed when metadata is unread', () => {
    const html = renderPlanEditor({ plan, featureLists: [], ownerId: null, canManage: true, allowUnlimited: false })
    document.body.innerHTML = html
    expect(form().dataset.planEditable).toBe('false')
    expect(form().textContent).toContain('feature list is unavailable')
    expect(form().textContent).not.toContain(featureList.id)
    for (const item of [...PLAN_RESOURCE_FIELDS, ...PLAN_CAP_FIELDS, PLAN_QUOTA_FIELD]) {
      expect(form().elements.namedItem(item.key)).not.toBeNull()
      expect(form().elements.namedItem('unlimited.' + item.key)).not.toBeNull()
    }
    expect(document.querySelector('[data-plan-delete]')).toBeNull()
  })
  it('uses a browser-valid name pattern with the same accepted punctuation as the core rule', () => {
    boot()
    const pattern = new RegExp('^(?:' + field('name').pattern + ')$', 'v')
    for (const name of ['A', 'My plan', 'Small-plan_2.0']) {
      expect(pattern.test(name)).toBe(true)
      expect(planErrors({ ...plan, name })).toEqual([])
    }
    expect(pattern.test('bad/name')).toBe(false)
  })
})

describe('native plan request and dirty-state controller', () => {
  it('enables Save only for actual changes, submits PATCH with visible IO and prevents duplicates', async () => {
    let resolve!: (value: unknown) => void
    const send = vi.fn<Request>(() => new Promise(done => { resolve = done }))
    request(send); boot(); expect(save().disabled).toBe(true)
    edit('ioReadBps', '8'); expect(save().disabled).toBe(false)
    edit('ioReadBps', '50'); expect(save().disabled).toBe(true)
    edit('ioReadBps', '8'); edit('databases', '17'); submit(); submit(); await tick()
    expect(send).toHaveBeenCalledTimes(1)
    const payload = send.mock.calls[0]![2] as ReturnType<typeof planEditorPayload>
    expect(send.mock.calls[0]!.slice(0, 2)).toEqual(['PATCH', '/api/plans/' + id])
    expect(payload.resources.ioReadBps).toBe(8 * 1024 * 1024); expect(payload.caps.databases).toBe(17)
    expect(payload).not.toHaveProperty('ownerId')
    resolve({ plan: { ...plan, ...payload }, reconcile: { status: 'applied' } }); await tick()
    expect(form().querySelector('[data-native-plan-status]')?.textContent).toContain('Hosting verification is not confirmed')
    expect(save().disabled).toBe(true); expect(field('name').disabled).toBe(false)
    edit('name', 'Another name'); expect(save().disabled).toBe(false)
  })
  it('creates with POST without a generated identity, then edits the returned persisted ID', async () => {
    const send = vi.fn<Request>(async (_method, _path, body) => ({ plan: { ...plan, ...(body as ReturnType<typeof planEditorPayload>) } }))
    request(send); boot(null)
    expect(form().dataset.planId).toBeUndefined(); edit('name', 'New plan'); submit(); await tick()
    expect(send.mock.calls[0]!.slice(0, 2)).toEqual(['POST', '/api/plans'])
    expect(send.mock.calls[0]![2]).not.toHaveProperty('id')
    expect(form().dataset.planId).toBe(id)
    edit('name', 'Renamed'); submit(); await tick()
    expect(send.mock.calls[1]!.slice(0, 2)).toEqual(['PATCH', '/api/plans/' + id])
  })
  it('preserves native validity and does not send invalid numbers or missing transport', async () => {
    const send = vi.fn<Request>(); request(send); boot()
    edit('name', ''); submit(); await tick(); expect(send).not.toHaveBeenCalled()
    edit('name', 'Valid'); edit('memoryMb', '1'); submit(); await tick(); expect(send).not.toHaveBeenCalled()
    edit('memoryMb', '1024'); delete (window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest
    submit(); expect(form().querySelector('[data-native-plan-status]')?.textContent).toContain('No changes were sent')
  })
  it('preserves values after a definite refusal and permits a corrected retry', async () => {
    const send = vi.fn<Request>().mockRejectedValue({ status: 403, details: { stateChanged: false } })
    request(send); boot(); edit('name', 'Refused name'); submit(); await tick()
    expect(field('name').value).toBe('Refused name'); expect(save().disabled).toBe(false)
    expect(form().querySelector('[data-native-plan-status]')?.textContent).toContain('refused')
  })
  it.each([null, { plan: { ...plan, name: 'Wrong saved name' } }])('locks retry after an unverifiable acknowledgement %j', async result => {
    const send = vi.fn<Request>().mockResolvedValue(result); request(send); boot(); edit('name', 'Requested'); submit(); await tick()
    expect(save().disabled).toBe(true); submit(); await tick(); expect(send).toHaveBeenCalledTimes(1)
    expect(form().querySelector('[data-native-plan-status]')?.textContent).toContain('could not be verified')
  })
  it('locks retry after an uncertain transport failure and never exposes raw server output', async () => {
    document.documentElement.lang = 'ar'
    const send = vi.fn<Request>().mockRejectedValue(Object.assign(new Error('private-output'), { status: 503 })); request(send); boot()
    edit('name', 'Requested'); submit(); await tick()
    expect(save().disabled).toBe(true)
    const status = form().querySelector('[data-native-plan-status]')!
    expect(status.textContent).toContain('غير مؤكدة'); expect(status.textContent).not.toContain('private-output')
  })
})


const bootV2Plan = (existing: Plan | null = plan, locale: 'en' | 'ar' = 'en', canRead = true, canManage = true): void => {
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = renderV2PlanEditor(v2Messages.translator(locale), { locale, principal: { kind: 'root', id, username: 'operator' }, featureLists: [{ ...featureList, ownerId: null, disabled: [] }] }, { canRead, canManage, allowUnlimited: true, ownerId: null }, existing ?? undefined, canManage)
  new Function('(' + PRESENTATION_TABS_CLIENT_BINDING + ')()')()
  new Function(PLAN_EDITOR_CLIENT_SCRIPT)()
}
const review = () => form().querySelector<HTMLElement>('[data-native-plan-review]')!
const reviewOpen = () => form().querySelector<HTMLButtonElement>('[data-plan-review-open]')!
const reviewBack = () => form().querySelector<HTMLButtonElement>('[data-plan-review-back]')!
const reviewRow = (key: string) => review().querySelector<HTMLElement>('[data-plan-review-key="' + key + '"]')!
const reviewValue = (key: string, side: 'from' | 'to') => reviewRow(key).querySelector<HTMLElement>('[data-plan-review-' + side + ']')!.textContent
const summary = () => form().querySelector<HTMLElement>('[data-plan-review-summary]')!
const selectPlanTab = (key: string) => form().querySelector<HTMLButtonElement>('[data-presentation-tab="' + key + '"]')!.click()

describe('v2 plan local tabs and canonical draft review', () => {
  it.each(['en', 'ar'] as const)('changes %s tabs without replacing fields, dirtying the form or sending requests', locale => {
    const send = vi.fn<Request>(); request(send); bootV2Plan(plan, locale)
    const editor = form(), io = field('ioReadBps'), originalName = field('name')
    expect(document.querySelectorAll('[data-native-plan-editor]')).toHaveLength(1)
    expect(editor.querySelectorAll('button[type="submit"]')).toHaveLength(1)
    selectPlanTab('services'); expect(editor.querySelector<HTMLElement>('#v2-plan-panel-services')!.hidden).toBe(false)
    selectPlanTab('features'); expect(editor.querySelector<HTMLElement>('#v2-plan-panel-features')!.hidden).toBe(false)
    const tabs = [...editor.querySelectorAll<HTMLButtonElement>('[data-presentation-tab]')]
    tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    expect(tabs[locale === 'ar' ? 2 : 1]!.getAttribute('aria-selected')).toBe('true')
    expect(form()).toBe(editor); expect(field('ioReadBps')).toBe(io); expect(field('name')).toBe(originalName)
    expect(reviewOpen().disabled).toBe(true); expect(save().disabled).toBe(true)
    const leave = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(leave); expect(leave.defaultPrevented).toBe(false)
    expect(send).not.toHaveBeenCalled(); expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('shows live canonical Current and Proposed values and keeps one control set through review and back', () => {
    const send = vi.fn<Request>(); request(send); bootV2Plan()
    const controls = [...form().querySelectorAll('input[name],select[name]')], originalIo = field('ioReadBps').value
    edit('name', 'Requested plan'); edit('ioReadBps', '8.5'); edit('databases', '17')
    expect(summary().textContent).toBe('Unsaved changes'); expect(reviewOpen().disabled).toBe(false)
    reviewOpen().click()
    expect(review().hidden).toBe(false); expect(form().querySelector<HTMLElement>('[data-plan-review-editor]')!.hidden).toBe(true)
    expect(reviewValue('name', 'from')).toBe(plan.name); expect(reviewValue('name', 'to')).toBe('Requested plan')
    expect(reviewValue('ioReadBps', 'from')).toBe(originalIo); expect(reviewValue('ioReadBps', 'to')).toBe('8.5')
    expect(reviewValue('databases', 'to')).toBe('17'); expect(reviewRow('featureListId').hidden).toBe(true)
    expect(save().disabled).toBe(false); expect([...form().querySelectorAll('input[name],select[name]')]).toEqual(controls)
    reviewBack().click(); expect(review().hidden).toBe(true); expect(field('ioReadBps').value).toBe('8.5')
    expect([...form().querySelectorAll('input[name],select[name]')]).toEqual(controls); expect(send).not.toHaveBeenCalled()
  })
  it('clears draft differences on exact reversion without inventing a host application', () => {
    request(vi.fn<Request>()); bootV2Plan(); edit('name', 'Changed'); reviewOpen().click(); reviewBack().click(); edit('name', plan.name)
    expect(review().dataset.dirty).toBe('false'); expect(reviewOpen().disabled).toBe(true)
    expect(summary().textContent).toBe('Saved'); expect(review().querySelector('[data-plan-review-key]:not([hidden])')).toBeNull()
    const leave = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(leave); expect(leave.defaultPrevented).toBe(false)
    expect(form().querySelector('[data-native-plan-status]')!.textContent).not.toContain('applied')
  })
  it.each(['range', 'quota'] as const)('does not promote invalid %s values to a proposed saved plan', async fault => {
    const send = vi.fn<Request>(); request(send); bootV2Plan()
    if (fault === 'range') edit('memoryMb', '1'); else { edit('diskMb', '1024'); edit('defaultMailboxQuotaMb', '2048') }
    expect(review().dataset.state).toBe('invalid'); expect(summary().textContent).toContain('Check the plan values')
    reviewOpen().disabled = false; reviewOpen().click(); save().disabled = false; submit(); await tick()
    expect(send).not.toHaveBeenCalled(); expect(review().hidden).toBe(true); expect(summary().textContent).not.toBe('Saved')
  })
  it('keeps unread data out of the comparison and prevents a forced save', async () => {
    const send = vi.fn<Request>(); request(send); bootV2Plan({ ...plan, name: 'PRIVATE-SAVED-PLAN' }, 'en', false, false)
    expect(document.body.textContent).not.toContain('PRIVATE-SAVED-PLAN'); expect(review().dataset.state).toBe('unread')
    expect(summary().textContent).toBe('Not read'); expect(reviewValue('ioReadBps', 'from')).toBe('Not read')
    save().disabled = false; submit(); await tick(); expect(send).not.toHaveBeenCalled()
  })
  it('invalidates an approved review when the current draft changes and preserves the exact PATCH payload', async () => {
    const send = vi.fn<Request>(async (_method, _path, body) => ({ plan: { ...plan, ...(body as ReturnType<typeof planEditorPayload>) } }))
    request(send); bootV2Plan(); edit('name', 'Requested'); reviewOpen().click(); edit('databases', '17')
    expect(review().hidden).toBe(true); expect(reviewOpen().disabled).toBe(false)
    submit(); await tick(); expect(send).not.toHaveBeenCalled()
    reviewOpen().click(); submit(); await tick()
    expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0]!.slice(0, 2)).toEqual(['PATCH', '/api/plans/' + id])
    const body = send.mock.calls[0]![2] as ReturnType<typeof planEditorPayload>
    expect(body.name).toBe('Requested'); expect(body.caps.databases).toBe(17); expect(body).not.toHaveProperty('ownerId')
    expect(form().querySelector('[data-native-plan-status]')!.textContent).toContain('Hosting verification is not confirmed')
    expect(summary().textContent).toBe('Saved')
  })
  it('does not authorize silently changed DOM values with an older review signature', async () => {
    const send = vi.fn<Request>(); request(send); bootV2Plan(); edit('name', 'Requested'); reviewOpen().click()
    field('ioReadBps').value = '9'; submit(); await tick()
    expect(send).not.toHaveBeenCalled(); expect(review().hidden).toBe(true); expect(summary().textContent).toBe('Unsaved changes')
    expect(reviewValue('ioReadBps', 'to')).toBe('9')
  })
  it('keeps captured accepted values Current while later DOM edits remain an unsaved Proposed draft', async () => {
    let resolve!: (value: unknown) => void
    const send = vi.fn<Request>(() => new Promise(yes => { resolve = yes }))
    request(send); bootV2Plan(); edit('name', 'Submitted'); reviewOpen().click(); submit(); await tick()
    expect(review().dataset.state).toBe('loading'); expect(summary().textContent).toBe('Saving…')
    const body = send.mock.calls[0]![2] as ReturnType<typeof planEditorPayload>
    field('name').value = 'Unsent'; field('name').dispatchEvent(new Event('input', { bubbles: true }))
    resolve({ plan: { ...plan, ...body } }); await tick()
    expect(summary().textContent).toBe('Unsaved changes'); expect(reviewValue('name', 'from')).toBe('Submitted'); expect(reviewValue('name', 'to')).toBe('Unsent')
    expect(reviewOpen().disabled).toBe(false); expect(send).toHaveBeenCalledOnce()
  })
  it.each([null, { plan: { ...plan, name: 'Wrong receipt' } }])('keeps uncertain acknowledgement %j separate from a saved comparison', async reply => {
    const send = vi.fn<Request>().mockResolvedValue(reply); request(send); bootV2Plan(); edit('name', 'Requested'); reviewOpen().click(); submit(); await tick()
    expect(review().dataset.state).toBe('unverified'); expect(summary().textContent).toContain('could not be verified')
    expect(reviewValue('name', 'from')).toBe(plan.name); expect(reviewValue('name', 'to')).toBe('Requested')
    save().disabled = false; submit(); await tick(); expect(send).toHaveBeenCalledOnce()
  })
  it('preserves a definite refusal and permits a corrected, freshly reviewed retry', async () => {
    const send = vi.fn<Request>().mockRejectedValueOnce({ status: 403, details: { stateChanged: false } }).mockImplementation(async (_method, _path, body) => ({ plan: { ...plan, ...(body as ReturnType<typeof planEditorPayload>) } }))
    request(send); bootV2Plan(); edit('name', 'Refused'); reviewOpen().click(); submit(); await tick()
    expect(reviewValue('name', 'from')).toBe(plan.name); expect(summary().textContent).toBe('Unsaved changes')
    edit('name', 'Allowed'); submit(); await tick(); expect(send).toHaveBeenCalledOnce()
    reviewOpen().click(); submit(); await tick(); expect(send).toHaveBeenCalledTimes(2); expect(summary().textContent).toBe('Saved')
  })
  it('reveals the actual invalid field panel before native validity feedback', () => {
    request(vi.fn<Request>()); bootV2Plan(); edit('name', 'Requested')
    field('databases').setCustomValidity('fixture-invalid')
    reviewOpen().click()
    expect(review().hidden).toBe(true); expect(form().querySelector<HTMLElement>('#v2-plan-panel-services')!.hidden).toBe(false)
    expect(form().querySelector('[data-presentation-tab="services"]')!.getAttribute('aria-selected')).toBe('true')
    field('databases').setCustomValidity('')
  })
  it('compares a new draft against unread Current values, then uses the acknowledged identity for later edits', async () => {
    const send = vi.fn<Request>(async (_method, _path, body) => ({ plan: { ...plan, ...(body as ReturnType<typeof planEditorPayload>) } }))
    request(send); bootV2Plan(null); edit('name', 'New plan'); reviewOpen().click()
    expect(reviewValue('name', 'from')).toBe('Not read'); expect(reviewValue('name', 'to')).toBe('New plan')
    submit(); await tick(); expect(send.mock.calls[0]!.slice(0, 2)).toEqual(['POST', '/api/plans']); expect(send.mock.calls[0]![2]).not.toHaveProperty('id')
    edit('name', 'Renamed'); reviewOpen().click(); submit(); await tick(); expect(send.mock.calls[1]!.slice(0, 2)).toEqual(['PATCH', '/api/plans/' + id])
  })
  it.each(['missing-row', 'duplicate-row', 'wrong-value-tag'] as const)('fails closed for %s only on an editor that actually mounts review', async fault => {
    const send = vi.fn<Request>(); request(send); bootV2Plan(); edit('name', 'Requested')
    const row = reviewRow('ioReadBps')
    if (fault === 'missing-row') row.remove()
    if (fault === 'duplicate-row') row.after(row.cloneNode(true))
    if (fault === 'wrong-value-tag') { const cell = row.querySelector('[data-plan-review-to]')!; const span = document.createElement('span'); span.setAttribute('data-plan-review-to', ''); cell.replaceWith(span) }
    field('name').dispatchEvent(new Event('input', { bubbles: true })); reviewOpen().disabled = false; reviewOpen().click(); save().disabled = false; submit(); await tick()
    expect(send).not.toHaveBeenCalled(); expect(review().dataset.state).toBe('unavailable'); expect(summary().textContent).toBe('Unavailable')
  })
})
