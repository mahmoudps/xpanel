// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderClassicBoxTrapperSection } from './board-port/boxtrapper-section.ts'
import { BOXTRAPPER_CLIENT_BINDING, boxTrapperLines, readBoxTrapperQueue, readBoxTrapperView } from './boxtrapper-client.ts'
import { v2BoxTrapperSection } from './themes/v2/pages/xpanel/email-tools/boxtrapper.ts'

const tick = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const defaults = { verify: { subject: 'Verify verify#{token}', body: 'Held' }, released: { subject: 'Released', body: 'ok' }, failed: { subject: 'Failed', body: 'no' }, deny: { subject: 'Denied', body: 'no' } }
const config = { enabled: false, extraAddresses: [], displayName: '', retentionDays: 15, spamBypass: -2.5, autoAllowSent: true, allowByAssociation: true, forward: [], templates: { verify: null, released: null, failed: null, deny: null } }
const view = (extra: Record<string, unknown> = {}) => ({ context: { mailbox: 'me@shop.example' }, revision: 'a'.repeat(64), saved: false, config, updatedAt: null, defaults, review: null,
  host: { state: 'connected', ready: true, active: false }, lists: { allow: ['from a@b.example'], ignore: [], deny: [] }, listsRevision: 'b'.repeat(64), ...extra })
const queue = { day: '2026-11-07', days: [{ day: '2026-11-07', count: 1 }], rows: [{ id: `20261107-${'c'.repeat(32)}`, at: '2026-11-07T10:00:00.000Z', from: 'x@y.example', subject: 'Hello <b>', size: 2048 }] }
const mount = (html: string) => { document.body.innerHTML = html }
const boot = (request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: (options: unknown) => Promise<unknown>) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + BOXTRAPPER_CLIENT_BINDING)()(ask)
}
const fake = (over: Record<string, unknown> = {}) => vi.fn(async (method: string, path: string, body?: unknown) => {
  if (method === 'GET' && path === '/api/mail/boxtrapper') return { mailboxes: [{ mailbox: 'me@shop.example', enabled: false }] }
  if (method === 'GET') return view(over)
  if (method === 'PUT') return { ...view(over), config: (body as { config: unknown }).config, nativeApplied: true }
  const op = (body as { op: string }).op
  return op === 'queue' ? queue : op === 'log' ? { day: '2026-11-07', days: ['2026-11-07'], lines: ['2026-11-07T10:00:00Z challenge x@y.example Hello'] }
    : op === 'message' ? { headers: 'From: x@y.example', body: 'hello', truncated: false } : op === 'act' ? { done: 1, failed: 0 } : { lists: { allow: ['from z@y.example'], ignore: [], deny: [] }, listsRevision: 'd'.repeat(64) }
})
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('BoxTrapper client', () => {
  it('reads strictly and splits lines', () => {
    expect(readBoxTrapperView(view()).lists?.allow).toEqual(['from a@b.example'])
    expect(() => readBoxTrapperView({ ...view(), revision: 'short' })).toThrow()
    expect(() => readBoxTrapperView({ ...view(), host: { state: 'invented' } })).toThrow()
    expect(() => readBoxTrapperQueue({ rows: [] })).toThrow()
    expect(boxTrapperLines(' a \n\n b\n')).toEqual(['a', 'b'])
    expect(BOXTRAPPER_CLIENT_BINDING).not.toContain('innerHTML')
  })

  it('renders the same controls in both themes and keeps them closed until qualified', () => {
    const translate = (message: string) => message
    for (const scope of ['owner', 'mailbox'] as const) for (const html of [renderClassicBoxTrapperSection({ locale: 'en', scope, connected: false }), v2BoxTrapperSection(translate, { scope, connected: false })]) {
      mount(html)
      expect(document.querySelector('[data-boxtrapper]')?.getAttribute('data-capability-unavailable')).toBe('true')
      expect(!!document.querySelector('select[data-boxtrapper-mailbox]')).toBe(scope === 'owner')
      expect([...document.querySelectorAll<HTMLInputElement>('[data-boxtrapper-control]')].every(control => control.disabled)).toBe(true)
      for (const list of ['allow', 'ignore', 'deny']) expect(document.querySelector(`textarea[data-boxtrapper-list="${list}"]`)).not.toBeNull()
      for (const act of ['allow', 'deliver', 'delete', 'ignore', 'deny']) expect(document.querySelector(`button[data-boxtrapper-act="${act}"]`)).not.toBeNull()
    }
    expect(renderClassicBoxTrapperSection({ locale: 'ar', scope: 'owner', connected: true })).not.toMatch(/[٠-٩۰-۹]/)
    mount(renderClassicBoxTrapperSection({ locale: 'en', scope: 'mailbox', connected: false }))
    const request = fake()
    boot(request)
    expect(request).not.toHaveBeenCalled()
    expect(document.querySelector('[data-boxtrapper-status]')?.getAttribute('data-state')).toBe('unavailable')
  })

  it('reads a mailbox, shows the queue as text, saves settings and acts on held mail', async () => {
    mount(renderClassicBoxTrapperSection({ locale: 'en', scope: 'owner', connected: true }))
    const request = fake(), ask = vi.fn(async () => true)
    boot(request, ask); await tick()
    expect(request).toHaveBeenCalledWith('GET', '/api/mail/boxtrapper/me%40shop.example')
    expect(document.querySelector<HTMLTextAreaElement>('textarea[data-boxtrapper-list="allow"]')?.value).toBe('from a@b.example')
    expect(document.querySelector<HTMLInputElement>('input[data-boxtrapper-template-subject]')?.value).toBe(defaults.verify.subject)
    expect(document.querySelector('[data-boxtrapper-status]')?.textContent).toContain('BoxTrapper is off')
    const row = document.querySelector('tbody[data-boxtrapper-queue] tr')!
    expect(row.textContent).toContain('Hello <b>')
    expect(row.querySelector('b')).toBeNull()
    expect(document.querySelector('pre[data-boxtrapper-log]')?.textContent).toContain('challenge')
    row.querySelector<HTMLButtonElement>('button')!.click(); await tick()
    expect(document.querySelector('pre[data-boxtrapper-message]')?.textContent).toContain('hello')

    document.querySelector<HTMLInputElement>('input[data-boxtrapper-enabled]')!.checked = true
    document.querySelector<HTMLButtonElement>('button[data-boxtrapper-save]')!.click(); await tick()
    const saved = request.mock.calls.find(call => call[0] === 'PUT')!
    expect(saved[1]).toBe('/api/mail/boxtrapper/me%40shop.example')
    expect(saved[2]).toMatchObject({ expectedRevision: 'a'.repeat(64), config: { enabled: true, retentionDays: 15, spamBypass: -2.5, templates: { verify: null } } })

    document.querySelector<HTMLButtonElement>('button[data-boxtrapper-act="delete"]')!.click(); await tick()
    expect(document.querySelector('[data-boxtrapper-status]')?.textContent).toContain('Select at least one')
    document.querySelector<HTMLInputElement>('tbody[data-boxtrapper-queue] input')!.checked = true
    document.querySelector<HTMLButtonElement>('button[data-boxtrapper-act="delete"]')!.click(); await tick()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('POST', '/api/mail/boxtrapper/me%40shop.example/queue', { op: 'act', args: { action: 'delete', ids: [queue.rows[0]!.id] } })
  })

  it('reads saved settings inside a read-only frame in both themes and never writes there', async () => {
    for (const html of [renderClassicBoxTrapperSection({ locale: 'en', scope: 'mailbox', connected: true }), v2BoxTrapperSection(message => message, { scope: 'mailbox', connected: true })]) {
      mount(`<div data-readonly="true">${html}</div>`)
      const request = fake()
      boot(request); await tick()
      expect(request).toHaveBeenCalledWith('GET', '/api/webmail/boxtrapper')
      expect(document.querySelector<HTMLTextAreaElement>('textarea[data-boxtrapper-list="allow"]')?.value).toBe('from a@b.example')
      expect(document.querySelector<HTMLInputElement>('input[data-boxtrapper-days]')?.value).toBe('15')
      expect([...document.querySelectorAll<HTMLInputElement>('[data-boxtrapper-control]')].every(control => control.disabled)).toBe(true)
      document.querySelector<HTMLButtonElement>('button[data-boxtrapper-save]')!.click(); await tick()
      expect((request.mock.calls as unknown[][]).every(call => call[0] === 'GET')).toBe(true)
    }
  })

  it('says why nothing runs when the host cannot', async () => {
    mount(renderClassicBoxTrapperSection({ locale: 'en', scope: 'mailbox', connected: true }))
    const request = fake({ host: { state: 'connected', ready: false, active: false }, lists: null, listsRevision: null })
    boot(request); await tick()
    expect(request).toHaveBeenCalledWith('GET', '/api/webmail/boxtrapper')
    expect(document.querySelector('[data-boxtrapper-status]')?.textContent).toContain('external programs module')
    expect(document.querySelector<HTMLButtonElement>('button[data-boxtrapper-lists-save]')?.disabled).toBe(true)
    expect(request.mock.calls.some(call => call[0] === 'POST')).toBe(false)
  })
})
