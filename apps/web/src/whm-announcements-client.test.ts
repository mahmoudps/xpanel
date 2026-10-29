// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { renderWhmAnnouncementsWorkspace } from './board-port/whm-announcements-workspace.ts'
import { readWhmAnnouncementsView, WHM_ANNOUNCEMENTS_CLIENT_BINDING } from './whm-announcements-client.ts'

const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64), R3 = 'c'.repeat(64)
const A = '77777777-7777-4777-8777-000000000001', B = '77777777-7777-4777-8777-000000000002'
const PLAN = '33333333-3333-4333-8333-333333333333', RESELLER = '22222222-2222-4222-8222-222222222222'
const choices = { plans: [{ id: PLAN, name: 'Starter' }], resellers: [{ id: RESELLER, username: 'res1' }] }
const record = (overrides: Record<string, unknown> = {}) => ({
  id: A, status: 'active', severity: 'warning', title: { en: 'Disk upgrade', ar: 'ترقية القرص' }, body: { en: 'Tonight.', ar: 'الليلة.' }, audience: { kind: 'plan', planId: PLAN },
  startsAt: null, endsAt: '2026-10-30T18:00:00.000Z', createdAt: '2026-10-26T10:00:00.000Z', createdBy: 'root', updatedAt: '2026-10-26T10:00:00.000Z', updatedBy: 'root', phase: 'live', ...overrides,
})
const view = (overrides: Record<string, unknown> = {}) => ({ state: 'saved', revision: R1, announcements: [record()], choices, ...overrides })
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
type Ask = (options: Record<string, unknown>) => Promise<unknown>
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const boot = (send?: Send, locale: 'en' | 'ar' = 'en', canManage = true, ask?: Ask) => {
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = renderWhmAnnouncementsWorkspace({ locale, canManage })
  if (send) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  new Function('return ' + WHM_ANNOUNCEMENTS_CLIENT_BINDING)()(ask)
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const input = (name: string) => $<HTMLInputElement>(`[data-whm-announcements-input="${name}"]`)
const set = (name: string, value: string) => { const control = input(name); control.value = value; control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) }
const submit = () => $<HTMLFormElement>('[data-whm-announcements-form]').dispatchEvent(new Event('submit', { cancelable: true }))
const fill = () => { set('title-en', 'Mail restart'); set('title-ar', 'إعادة تشغيل البريد'); set('body-en', 'At 22:00 UTC.'); set('body-ar', 'الساعة 22:00 UTC.') }

beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
afterEach(() => { document.body.innerHTML = '' })

describe('WHM announcements client parser', () => {
  it('accepts consistent views only', () => {
    expect(readWhmAnnouncementsView(view()).announcements[0]!.audience).toEqual({ kind: 'plan', planId: PLAN })
    expect(readWhmAnnouncementsView(view({ changed: A })).changed).toBe(A)
    for (const bad of [
      view({ state: 'default' }),
      view({ announcements: [record({ phase: 'archived' })] }),
      view({ announcements: [record({ audience: { kind: 'accounts', usernames: ['Bob'] } })] }),
      view({ announcements: [record({ title: { en: 'x' } })] }),
      view({ announcements: [record(), record()] }),
      view({ choices: { plans: [{ id: 'x', name: 'p' }], resellers: [] } }),
      view({ revision: 'x' }),
      view({ changed: 'x' }),
    ]) expect(() => readWhmAnnouncementsView(bad), JSON.stringify(bad)).toThrow()
  })
})

describe('WHM announcements client binding', () => {
  it('sends nothing without transport or admission', async () => {
    const send = vi.fn<Send>()
    boot(send, 'en', false)
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect($('[data-whm-announcements-status]').dataset.state).toBe('unavailable')
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('button')).every(button => button.disabled)).toBe(true)
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
    boot(undefined)
    await flush()
    expect($('[data-whm-announcements-status]').dataset.state).toBe('unavailable')
    expect(WHM_ANNOUNCEMENTS_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_ANNOUNCEMENTS_CLIENT_BINDING).not.toContain('fetch(')
  })

  it('lists announcements as text with audience names and the UTC window', async () => {
    const hostile = record({ id: B, title: { en: '<img src=x onerror=alert(1)>', ar: 'x' }, audience: { kind: 'accounts', usernames: ['alice', 'bob', 'carol', 'dave'] }, endsAt: null, status: 'archived', phase: 'archived' })
    boot(vi.fn<Send>(async () => view({ announcements: [record(), hostile] })))
    await flush()
    const rows = Array.from(document.querySelectorAll('[data-whm-announcements-rows] tr'))
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Plan: Starter')
    expect(rows[0]!.textContent).toContain('Until 2026-10-30 18:00 UTC')
    expect(rows[0]!.textContent).toContain('Live')
    expect(rows[1]!.textContent).toContain('4 accounts: alice, bob, carol, ...')
    expect(rows[1]!.querySelector('img')).toBeNull()
    expect(rows[1]!.querySelector('button')).toBeNull()
    expect($('[data-whm-announcements-status]').textContent).toBe('Announcements read. Live ones are shown to their audience now.')
    expect(Array.from((input('plan') as unknown as HTMLSelectElement).options).map(option => option.textContent)).toEqual(['Choose a plan', 'Starter'])
  })

  it('previews both languages, creates under the observed revision and repaints', async () => {
    const created = record({ id: B, severity: 'maintenance', title: { en: 'Mail restart', ar: 'إعادة تشغيل البريد' }, audience: { kind: 'accounts', usernames: ['alice', 'bob'] }, endsAt: null })
    const send: Mock<Send> = vi.fn<Send>(async (method) => method === 'GET' ? view({ announcements: [] }) : view({ revision: R2, announcements: [created], changed: B }))
    boot(send)
    await flush()
    expect($('[data-whm-announcements-empty]').hidden).toBe(false)
    expect($('[data-whm-announcements-preview="en"]').hidden).toBe(true)
    fill(); set('severity', 'maintenance'); set('audience', 'accounts')
    expect($('[data-whm-announcements-audience-field="accounts"]').hidden).toBe(false)
    expect($('[data-whm-announcements-audience-field="plan"]').hidden).toBe(true)
    expect($('[data-whm-announcements-preview="en"] .xp-account-announcement__title')!.textContent).toBe('MaintenanceMail restart')
    expect($('[data-whm-announcements-preview="ar"] .xp-account-announcement__title')!.textContent).toBe('صيانةإعادة تشغيل البريد')
    expect($<HTMLButtonElement>('[data-whm-announcements-preview="en"] button').disabled).toBe(true)
    submit(); await flush()
    expect(send.mock.calls.some(([method]) => method === 'POST')).toBe(false)
    expect(input('usernames').getAttribute('aria-invalid')).toBe('true')
    set('usernames', 'alice\nbob'); set('starts', '2026-10-27T09:30')
    submit(); await flush()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/announcements', {
      title: { en: 'Mail restart', ar: 'إعادة تشغيل البريد' }, body: { en: 'At 22:00 UTC.', ar: 'الساعة 22:00 UTC.' }, severity: 'maintenance',
      audience: { kind: 'accounts', usernames: ['alice', 'bob'] }, startsAt: '2026-10-27T09:30:00.000Z', endsAt: null, expectedRevision: R1,
    })
    expect($('[data-whm-announcements-save-status]').textContent).toBe('Announcement created. Its audience sees it on the xPanel home page now.')
    expect(document.querySelectorAll('[data-whm-announcements-rows] tr')).toHaveLength(1)
    expect(input('title-en').value).toBe('')
  })

  it('refuses markup, missing languages and inverted windows locally', async () => {
    const send: Mock<Send> = vi.fn<Send>(async () => view())
    boot(send)
    await flush()
    set('title-en', 'Only English'); submit(); await flush()
    expect(input('body-en').getAttribute('aria-invalid')).toBe('true')
    fill(); set('body-en', '<b>bold</b>'); submit(); await flush()
    expect(input('body-en').getAttribute('aria-invalid')).toBe('true')
    expect($('[data-whm-announcements-save-status]').textContent).toBe('Announcements are plain text. Remove the < and > characters.')
    fill(); set('starts', '2026-11-02T09:00'); set('ends', '2026-11-01T09:00'); submit(); await flush()
    expect(input('ends').getAttribute('aria-invalid')).toBe('true')
    fill(); set('starts', ''); set('ends', ''); set('audience', 'plan'); submit(); await flush()
    expect(input('plan').getAttribute('aria-invalid')).toBe('true')
    expect(send.mock.calls.every(([method]) => method === 'GET')).toBe(true)
  })

  it('edits an announcement with PUT and explains a conflict', async () => {
    const send: Mock<Send> = vi.fn<Send>(async (method) => { if (method === 'GET') return view(); throw Object.assign(new Error('changed'), { status: 409 }) })
    boot(send)
    await flush()
    $<HTMLButtonElement>('[data-whm-announcements-rows] button[data-action="edit"]').click()
    expect($('[data-whm-announcements-editor-heading]').textContent).toBe('Edit announcement')
    expect(input('title-en').value).toBe('Disk upgrade')
    expect((input('plan') as unknown as HTMLSelectElement).value).toBe(PLAN)
    expect(input('ends').value).toBe('2026-10-30T18:00')
    expect($('[data-whm-announcements-cancel]').hidden).toBe(false)
    submit(); await flush()
    expect(send).toHaveBeenLastCalledWith('PUT', '/api/server/announcements/' + A, expect.objectContaining({ audience: { kind: 'plan', planId: PLAN }, endsAt: '2026-10-30T18:00:00.000Z', expectedRevision: R1 }))
    expect($('[data-whm-announcements-save-status]').textContent).toBe('The announcements changed since they were read. Refresh the list, then try again.')
    $<HTMLButtonElement>('[data-whm-announcements-cancel]').click()
    expect($('[data-whm-announcements-editor-heading]').textContent).toBe('Create announcement')
  })

  it('archives only after confirmation and verifies the archived state, in Arabic too', async () => {
    const archived = view({ revision: R3, announcements: [record({ status: 'archived', phase: 'archived' })], changed: A })
    const send: Mock<Send> = vi.fn<Send>(async (method) => method === 'GET' ? view() : archived)
    const ask = vi.fn<Ask>().mockResolvedValueOnce(false).mockResolvedValue(true)
    boot(send, 'ar', true, ask)
    await flush()
    expect($('[data-whm-announcements-rows] tr').textContent).toContain('حتى 2026-10-30 18:00 UTC')
    expect($('[data-whm-announcements-rows] button[data-action="archive"]').getAttribute('aria-label')).toBe('أرشفة: ترقية القرص')
    $<HTMLButtonElement>('[data-whm-announcements-rows] button[data-action="archive"]').click(); await flush()
    expect(send.mock.calls.some(([method]) => method === 'POST')).toBe(false)
    $<HTMLButtonElement>('[data-whm-announcements-rows] button[data-action="archive"]').click(); await flush()
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ danger: true, body: 'يتوقف أصحاب الحسابات عن رؤية "ترقية القرص" فورًا. لا يمكن عرض الإعلانات المؤرشفة مجددًا.' }))
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/announcements/' + A + '/archive', { expectedRevision: R1 })
    expect($('[data-whm-announcements-list-status]').textContent).toBe('أُرشف الإعلان. لم يعد أصحاب الحسابات يرونه.')
    expect(document.querySelector('[data-whm-announcements-rows] button')).toBeNull()
  })

  it('disables archive without a confirmation dialog and reports an invalid file truthfully', async () => {
    boot(vi.fn<Send>(async () => view()))
    await flush()
    expect($<HTMLButtonElement>('[data-whm-announcements-rows] button[data-action="archive"]').disabled).toBe(true)
    expect($<HTMLButtonElement>('[data-whm-announcements-rows] button[data-action="edit"]').disabled).toBe(false)
    boot(vi.fn<Send>(async () => view({ state: 'invalid', announcements: [] })))
    await flush()
    expect($('[data-whm-announcements-status]').dataset.state).toBe('failed')
    expect($('[data-whm-announcements-empty]').hidden).toBe(true)
    boot(vi.fn<Send>(async () => ({ state: 'saved' })))
    await flush()
    expect($('[data-whm-announcements-status]').dataset.state).toBe('failed')
    expect($<HTMLButtonElement>('[data-whm-announcements-save]').disabled).toBe(true)
  })
})

describe('complete administrator announcement timestamps', () => {
  it.each(['en', 'ar'] as const)('preserves complete window and updated instants in %s', async locale => {
    const startsAt = '2026-10-27T09:10:11.123Z', endsAt = '2026-10-30T18:19:20.345Z', updatedAt = '2026-10-27T10:11:12.567Z'
    const send = vi.fn<Send>(async () => view({ announcements: [record({ startsAt, endsAt, updatedAt })] }))
    boot(send, locale); await flush()
    const row = $<HTMLTableRowElement>('[data-whm-announcements-rows] tr')
    expect([...row.cells[3]!.querySelectorAll('bdi')].map(node => node.textContent)).toEqual(['2026-10-27 09:10 UTC', '2026-10-30 18:19 UTC'])
    expect(row.cells[5]!.querySelector('bdi')!.textContent).toBe('2026-10-27 10:11 UTC')
    for (const node of [...row.cells[3]!.querySelectorAll('bdi'), row.cells[5]!.querySelector('bdi')!]) expect(node.getAttribute('dir')).toBe('ltr')
    expect(send.mock.calls).toEqual([['GET', '/api/server/announcements']])
  })
})

describe('announcement edit scheduling precision', () => {
  const startsAt = '2026-10-27T09:10:11.123Z', endsAt = '2026-10-30T18:19:20.345Z'
  const editScheduled = async (locale: 'en' | 'ar') => {
    const send = vi.fn<Send>(async method => { if (method === 'GET') return view({ announcements: [record({ startsAt, endsAt })] }); throw { status: 409 } })
    boot(send, locale); await flush()
    $<HTMLButtonElement>('[data-whm-announcements-rows] button[data-action="edit"]').click()
    return send
  }
  it.each(['en', 'ar'] as const)('preserves both captured instants when only the title changes in %s', async locale => {
    const send = await editScheduled(locale)
    set('title-en', 'Updated without rescheduling'); submit(); await flush()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/announcements/' + A, expect.objectContaining({ title: { en: 'Updated without rescheduling', ar: 'ترقية القرص' }, startsAt, endsAt, expectedRevision: R1 }))
    expect(send.mock.calls.map(([method]) => method)).toEqual(['GET', 'PUT'])
  })
  it.each(['en', 'ar'] as const)('changes the requested minute and preserves the untouched end instant in %s', async locale => {
    const send = await editScheduled(locale)
    set('starts', '2026-10-28T10:20'); submit(); await flush()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/announcements/' + A, expect.objectContaining({ startsAt: '2026-10-28T10:20:00.000Z', endsAt, expectedRevision: R1 }))
    expect(send.mock.calls.map(([method]) => method)).toEqual(['GET', 'PUT'])
  })
  it.each(['en', 'ar'] as const)('clears the requested boundary and preserves the untouched end instant in %s', async locale => {
    const send = await editScheduled(locale)
    set('starts', ''); submit(); await flush()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/announcements/' + A, expect.objectContaining({ startsAt: null, endsAt, expectedRevision: R1 }))
    expect(send.mock.calls.map(([method]) => method)).toEqual(['GET', 'PUT'])
  })
})

describe('announcement edit snapshot safety', () => {
  const startsAt = '2026-10-27T09:10:11.123Z', endsAt = '2026-10-30T18:19:20.345Z'
  const selectEdit = (index = 0) => document.querySelectorAll<HTMLButtonElement>('[data-whm-announcements-rows] button[data-action="edit"]')[index]!.click()
  it.each(['en', 'ar'] as const)('keeps the captured edit revision after a newer refresh in %s', async locale => {
    let reads = 0
    const send = vi.fn<Send>(async method => {
      if (method === 'GET') return reads++ === 0 ? view({ announcements: [record({ startsAt, endsAt })] }) : view({ revision: R2, announcements: [record({ startsAt: '2026-10-27T09:10:55.666Z', endsAt: '2026-10-30T18:19:44.777Z' })] })
      throw { status: 409 }
    })
    boot(send, locale); await flush(); selectEdit(); set('title-en', 'Draft from the first read')
    $<HTMLButtonElement>('[data-whm-announcements-refresh]').click(); await flush()
    expect(input('title-en').value).toBe('Draft from the first read')
    submit(); await flush()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/announcements/' + A, expect.objectContaining({ expectedRevision: R1, startsAt, endsAt }))
    expect(send.mock.calls.map(([method]) => method)).toEqual(['GET', 'GET', 'PUT'])
  })
  it.each(['en', 'ar'] as const)('previews the exact captured end instant without putting a UTC suffix into controls in %s', async locale => {
    const send = vi.fn<Send>(async () => view({ announcements: [record({ startsAt, endsAt })] }))
    boot(send, locale); await flush(); selectEdit()
    expect(input('ends').value).toBe('2026-10-30T18:19')
    for (const preview of ['en', 'ar']) {
      const timestamp = $(`[data-whm-announcements-preview="${preview}"] .xp-account-announcement__text .xp-help bdi`)
      expect(timestamp.textContent).toBe('2026-10-30 18:19 UTC')
      expect(timestamp.getAttribute('dir')).toBe('ltr')
    }
    expect(send.mock.calls.map(([method]) => method)).toEqual(['GET'])
  })
  it.each(['en', 'ar'] as const)('clears captured precision when canceling an edit before creating in %s', async locale => {
    const send = vi.fn<Send>(async method => { if (method === 'GET') return view({ announcements: [record({ startsAt, endsAt })] }); throw { status: 409 } })
    boot(send, locale); await flush(); selectEdit()
    $<HTMLButtonElement>('[data-whm-announcements-cancel]').click()
    fill(); set('starts', '2026-10-27T09:10'); set('ends', '2026-10-30T18:19'); submit(); await flush()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/announcements', expect.objectContaining({ startsAt: '2026-10-27T09:10:00.000Z', endsAt: '2026-10-30T18:19:00.000Z', expectedRevision: R1 }))
    expect(send.mock.calls.map(([method]) => method)).toEqual(['GET', 'POST'])
  })
  it.each(['en', 'ar'] as const)('captures the newly selected record instead of reusing the previous edit in %s', async locale => {
    const nextStartsAt = '2026-10-27T09:10:22.456Z', nextEndsAt = '2026-10-30T18:19:33.567Z'
    const send = vi.fn<Send>(async method => { if (method === 'GET') return view({ announcements: [record({ startsAt, endsAt }), record({ id: B, startsAt: nextStartsAt, endsAt: nextEndsAt })] }); throw { status: 409 } })
    boot(send, locale); await flush(); selectEdit(); selectEdit(1); submit(); await flush()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/announcements/' + B, expect.objectContaining({ startsAt: nextStartsAt, endsAt: nextEndsAt, expectedRevision: R1 }))
    expect(send.mock.calls.map(([method]) => method)).toEqual(['GET', 'PUT'])
  })
})
