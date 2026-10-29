/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultPlan, planErrors, validatePlan, type Plan } from '@xpanel/core'
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
