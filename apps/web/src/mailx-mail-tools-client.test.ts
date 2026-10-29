// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderMailxMailToolsWorkspace } from './board-port/mailx-mail-tools-workspace.ts'
import { MAILX_MAIL_TOOLS_CLIENT_BINDING, readMailxListDelivery, readMailxMailTools } from './mailx-mail-tools-client.ts'

const tick = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const effects = { allowlist: true, filtering: false, score: true, blocklist: true, spamBox: true }
const view = (extra: Record<string, unknown> = {}) => ({ context: { account: 'alice' }, host: 'connected', observedAt: '2026-10-28T10:00:00.000Z', engine: { engine: 'rspamd', wiring: 'not-wired' },
  compositeRevision: 'a'.repeat(64), capabilities: { learning: true, boxTrapper: false },
  mailboxes: [{ mailbox: 'info@shop.example', preference: 'saved', native: 'pending', effects }, { mailbox: 'sales@shop.example', preference: 'none', native: 'not-saved', effects: null }], ...extra })
const lists = (extra: Record<string, unknown> = {}) => ({ context: { account: 'alice' }, host: 'connected', observedAt: '2026-10-28T10:00:00.000Z', aliases: 'read', compositeRevision: 'b'.repeat(64),
  capabilities: { moderation: false, archive: false }, lists: [{ address: 'team@shop.example', members: 3, state: 'delivering' }, { address: 'mods@shop.example', members: 1, state: 'restricted' }, { address: 'new@shop.example', members: 2, state: 'pending' }], ...extra })
const mount = (section: 'spam' | 'lists' = 'spam', canManage = true) => { document.body.innerHTML = renderMailxMailToolsWorkspace({ locale: 'en', section, canManage }) }
const boot = (request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: (options: unknown) => Promise<unknown>) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + MAILX_MAIL_TOOLS_CLIENT_BINDING)()(ask)
}
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('mail tools client', () => {
  it('parses strictly, accepts the Sieve effects and refuses a claimed BoxTrapper', () => {
    expect(readMailxMailTools(view()).mailboxes[0]!.effects).toEqual(effects)
    for (const bad of [view({ capabilities: { learning: true, boxTrapper: true } }), view({ mailboxes: [{ mailbox: 'a@b.example', preference: 'none', native: 'applied', effects }] }),
      view({ host: 'not-connected' }), view({ engine: { engine: null, wiring: 'unknown' } })]) expect(() => readMailxMailTools(bad)).toThrow()
  })
  it('parses list delivery strictly and never accepts claimed moderation or unread delivery', () => {
    expect(readMailxListDelivery(lists()).lists).toHaveLength(3)
    expect(readMailxListDelivery(lists({ host: 'not-connected', observedAt: null, aliases: null, lists: [] })).host).toBe('not-connected')
    for (const bad of [lists({ capabilities: { moderation: true, archive: false } }), lists({ aliases: 'unavailable' }), lists({ lists: [{ address: 'a@b.example', members: 1, state: 'moderated' }] }),
      lists({ host: 'not-connected' }), lists({ observedAt: null })]) expect(() => readMailxListDelivery(bad)).toThrow()
  })
  it('keeps moderation and BoxTrapper controls disabled and form-free', () => {
    for (const section of ['spam', 'lists'] as const) {
      mount(section)
      expect(document.querySelector('form')).toBeNull()
      expect([...document.querySelectorAll<HTMLInputElement>('input,select,textarea')].every(control => control.disabled)).toBe(true)
    }
    expect(document.body.textContent).toContain('Postfix alias table')
    expect(document.body.textContent).toContain('needs a list manager')
  })
  it('paints native state and submits training only after confirmation', async () => {
    const calls: [string, string, unknown][] = [], ask = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    mount(); boot(async (method, path, body) => { calls.push([method, path, body]); return method === 'GET' ? view() : { job: { id: 'j', status: 'queued' } } }, ask); await tick()
    const row = document.querySelector('[data-mailx-tools-rows] tr')!
    expect(row.textContent).toContain('Not applied yet'); expect(row.textContent).toContain('Allowed senders, Own spam score, Blocked senders to Junk, Spam to Junk')
    expect(document.querySelector('[data-mailx-tools-status]')!.getAttribute('data-state')).toBe('drift')
    const spam = row.querySelector<HTMLButtonElement>('button[data-direction="spam"]')!
    spam.click(); await tick(); expect(calls.some(([method]) => method === 'POST')).toBe(false)
    spam.click(); await tick()
    expect(calls.find(([method]) => method === 'POST')).toEqual(['POST', '/api/account/mailx/mail-tools/learn', { mailbox: 'info@shop.example', direction: 'spam', expectedRevision: 'a'.repeat(64) }])
  })
  it('reports a rolled-back configuration generation as partial', async () => {
    mount(); boot(async method => method === 'GET' ? view() : { application: { outcome: 'applied', verificationRequired: false, spam: null, reconcile: 'failed' } }); await tick()
    document.querySelector<HTMLButtonElement>('[data-mailx-tools-apply]')!.click(); await tick()
    const action = document.querySelector('[data-mailx-tools-action-status]')!
    expect(action.getAttribute('data-state')).toBe('partial'); expect(action.textContent).toContain('rolled back')
  })
  it('disables training when no filter runs', async () => {
    mount(); boot(async () => view({ engine: { engine: null, wiring: 'unknown' }, capabilities: { learning: false, boxTrapper: false } }), async () => true); await tick()
    expect([...document.querySelectorAll<HTMLButtonElement>('[data-mailx-tools-rows] button')].every(button => button.disabled)).toBe(true)
    expect(document.querySelector('[data-mailx-tools-status]')!.getAttribute('data-state')).toBe('partial')
  })
  it('paints list delivery from the host and applies saved lists through the generation', async () => {
    const calls: [string, string, unknown][] = []
    mount('lists'); boot(async (method, path, body) => { calls.push([method, path, body]); return method === 'GET' ? lists() : { application: { outcome: 'nothing', verificationRequired: false, spam: null, reconcile: 'applied' }, ...lists({ lists: [{ address: 'team@shop.example', members: 3, state: 'delivering' }] }) } })
    await tick()
    const rows = [...document.querySelectorAll('[data-mailx-lists-rows] tr')]
    expect(rows.map(row => row.getAttribute('data-state'))).toEqual(['delivering', 'restricted', 'pending'])
    expect(rows[0]!.querySelector('th bdi')!.getAttribute('dir')).toBe('ltr')
    expect(rows[1]!.textContent).toContain('needs a list manager')
    expect(document.querySelector('[data-mailx-tools-fact="delivery"]')!.textContent).toBe('1 of 3 lists deliver')
    expect(document.querySelector('[data-mailx-lists-status]')!.getAttribute('data-state')).toBe('drift')
    document.querySelector<HTMLButtonElement>('[data-mailx-lists-apply]')!.click(); await tick()
    expect(calls.find(([method]) => method === 'POST')).toEqual(['POST', '/api/account/mailx/mail-tools/lists', { expectedRevision: 'b'.repeat(64) }])
    expect(document.querySelector('[data-mailx-lists-action-status]')!.getAttribute('data-state')).toBe('saved')
    expect(document.querySelectorAll('[data-mailx-lists-rows] tr')).toHaveLength(1)
  })
  it('states an unconnected host and keeps apply disabled', async () => {
    mount('lists'); boot(async () => lists({ host: 'not-connected', observedAt: null, aliases: null, lists: [] })); await tick()
    expect(document.querySelector('[data-mailx-lists-status]')!.getAttribute('data-state')).toBe('unavailable')
    expect(document.querySelector<HTMLButtonElement>('[data-mailx-lists-apply]')!.disabled).toBe(true)
    expect(document.querySelector('[data-mailx-lists-rows]')!.textContent).toBe('Nothing has been read.')
  })
})
