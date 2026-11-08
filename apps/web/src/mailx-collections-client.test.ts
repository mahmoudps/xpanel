// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderMailxCollectionsWorkspace } from './board-port/mailx-collections-workspace.ts'
import { MAILX_COLLECTIONS_CLIENT_BINDING, readMailxCollections } from './mailx-collections-client.ts'

const tick = async () => { for (let index = 0; index < 10; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const CAL = 'a'.repeat(32), BOOK = 'b'.repeat(32)
const collections = (extra: Record<string, unknown> = {}) => ({ context: { account: 'alice' },
  application: { status: 'dav_store', davServed: true }, limits: {},
  mailboxes: [{ mailbox: 'inbox@shop.example', revision: 'c'.repeat(64), defaultCalendar: CAL, calendars: [{ id: CAL, name: 'Work', description: 'Team' }],
    addressBooks: [{ id: BOOK, name: 'Clients', description: '', isDefault: true, removable: true }], taskLists: [] }], ...extra })
const collaboration = { context: { account: 'alice' }, mailboxes: [{ mailbox: 'inbox@shop.example', revision: 'd'.repeat(64), calendars: [{ id: CAL, name: 'Work', color: '#4f6bed', timezone: 'UTC', eventCount: 0, shares: [] }] }] }
const mount = (canManage = true) => { document.body.innerHTML = renderMailxCollectionsWorkspace({ locale: 'en', canManage }) }
const boot = (request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: (options: unknown) => Promise<unknown>) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + MAILX_COLLECTIONS_CLIENT_BINDING)()(ask)
}
const el = <T extends HTMLElement>(key: string) => document.querySelector<T>(`[data-mailx-${key}]`)!
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
const transport = (calls: [string, string, unknown][]) => vi.fn(async (method: string, path: string, body?: unknown) => {
  calls.push([method, path, body])
  return path === '/api/account/collaboration' ? collaboration : method === 'GET' ? collections() : { stateChanged: true }
})

describe('mail collections client', () => {
  it('parses strictly and refuses a claimed DAV service or two defaults', () => {
    expect((readMailxCollections(collections(), 'collections') as { mailboxes: unknown[] }).mailboxes).toHaveLength(1)
    for (const bad of [collections({ application: { davServed: false } }),
      collections({ mailboxes: [{ ...collections().mailboxes[0], addressBooks: [{ id: BOOK, name: 'A', description: '', isDefault: true }, { id: 'e'.repeat(32), name: 'B', description: '', isDefault: true }] }] }),
      collections({ mailboxes: [{ ...collections().mailboxes[0], defaultCalendar: 'f'.repeat(32) }] })]) expect(() => readMailxCollections(bad, 'collections')).toThrow()
    expect(() => readMailxCollections({ ...collaboration, mailboxes: [{ ...collaboration.mailboxes[0], calendars: [{ ...collaboration.mailboxes[0]!.calendars[0], id: 'internal-uuid' }] }] }, 'calendars')).toThrow()
  })
  it('names the oversized mailbox and keeps the others', async () => {
    const { mailboxes, ...rest } = collections(), rows = [...mailboxes, { mailbox: 'large@owner.example.test', refused: 'dav_store_too_large' }]
    const read = readMailxCollections({ ...rest, mailboxes: rows }, 'collections')
    expect(read.refused).toEqual(['large@owner.example.test']); expect(read.mailboxes).toHaveLength(1)
    expect(() => readMailxCollections({ ...rest, mailboxes: { length: 0 } }, 'collections')).toThrow()
    expect(() => readMailxCollections({ ...rest, mailboxes: [{ mailbox: 'large@owner.example.test', refused: 'other' }] }, 'collections')).toThrow()
    mount(); boot(vi.fn(async (_method: string, path: string) => path === '/api/account/collaboration' ? collaboration : { ...rest, mailboxes: rows })); await tick()
    expect(el('collections-status').dataset.state).toBe('failed'); expect(el('collections-status').textContent).toContain('large@owner.example.test')
    expect(el<HTMLSelectElement>('collections-mailbox').disabled).toBe(false)
  })
  it('renders no form and only disabled controls without manage authority', async () => {
    const send = vi.fn(); mount(false); boot(send); await tick()
    expect(document.querySelector('form')).toBeNull()
    expect([...document.querySelectorAll<HTMLInputElement>('input,select,textarea')].every(control => control.disabled)).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })
  it('edits and deletes a calendar by its public id only after confirmation', async () => {
    const calls: [string, string, unknown][] = [], ask = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    mount(); boot(transport(calls), ask); await tick()
    expect(el<HTMLInputElement>('calendar-name').value).toBe('Work')
    el<HTMLInputElement>('calendar-name').value = 'Renamed'; el<HTMLInputElement>('calendar-name').dispatchEvent(new Event('input'))
    el<HTMLButtonElement>('calendar-save').click(); await tick()
    expect(calls.find(([method]) => method === 'PATCH')).toEqual(['PATCH', `/api/account/collaboration/calendars/${CAL}`, { mailbox: 'inbox@shop.example', name: 'Renamed', color: '#4f6bed', timezone: 'UTC', expectedRevision: 'd'.repeat(64) }])
    expect(el('calendar-status').textContent).toContain('saved and read back')
    el<HTMLButtonElement>('calendar-delete').click(); await tick()
    expect(ask.mock.calls[1]![0]).toMatchObject({ danger: true })
    expect(calls.some(([method]) => method === 'DELETE')).toBe(false)
  })
  it('saves defaults, descriptions and new collections without inventing ids', async () => {
    const calls: [string, string, unknown][] = []
    mount(); boot(transport(calls)); await tick()
    expect(el<HTMLSelectElement>('collections-default').value).toBe(CAL)
    document.querySelector<HTMLTextAreaElement>(`textarea[data-calendar-id="${CAL}"]`)!.value = 'Meetings'
    el<HTMLButtonElement>('add="task-lists"').click()
    const row = el('task-lists').querySelector<HTMLTableRowElement>('tr[data-item-id]')!
    row.querySelector<HTMLInputElement>('[data-item-name]')!.value = 'Follow-ups'
    document.querySelector<HTMLFormElement>('[data-mailx-collections-form]')!.requestSubmit(); await tick()
    expect(calls.find(([method]) => method === 'PUT')![2]).toEqual({ mailbox: 'inbox@shop.example', expectedRevision: 'c'.repeat(64), defaultCalendar: CAL, descriptions: { [CAL]: 'Meetings' },
      addressBooks: [{ id: BOOK, name: 'Clients', description: '', isDefault: true }], taskLists: [{ id: null, name: 'Follow-ups', description: '', isDefault: true }] })
    expect(el('collections-status').textContent).toContain('saved and read back')
  })
})
