// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderOpsTerminalWorkspace } from './board-port/ops-terminal-workspace.ts'
import { OPS_TERMINAL_CLIENT_BINDING, readTerminalSession } from './ops-terminal-client.ts'

const tick = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const session = () => ({ session: { id: '0f9c3c1e-2b9a-4f43-9d55-8f1b7d0b3a11', openedAt: '2026-10-28T09:00:00.000Z' }, execution: { state: 'unavailable', reason: 'no_qualified_root_terminal_execution_path' } })
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const boot = (send?: Send, canUse = true, locale: 'en' | 'ar' = 'en') => {
  document.body.innerHTML = `<section data-whm-detail-route="/whm/server/terminal" data-capability-state="authorized">${renderOpsTerminalWorkspace({ locale, canUse })}</section>`
  if (send) (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  new Function('return ' + OPS_TERMINAL_CLIENT_BINDING)()()
}
const status = () => document.querySelector<HTMLElement>('[data-ops-terminal-status]')!
const submit = () => document.querySelector<HTMLFormElement>('[data-ops-terminal-reauth]')!.dispatchEvent(new Event('submit', { cancelable: true }))
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('server terminal client', () => {
  it('validates the session contract and the unavailable execution reason', () => {
    expect(readTerminalSession(session()).session.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(() => readTerminalSession({ ...session(), execution: { state: 'available', reason: 'x' } })).toThrow()
    expect(() => readTerminalSession({ session: { id: 'short', openedAt: '2026-10-28T09:00:00.000Z' }, execution: session().execution })).toThrow()
  })
  it('opens a session after re-authentication and shows the honest no-execution state', async () => {
    const send = vi.fn(async () => session())
    boot(send)
    ;(document.querySelector<HTMLInputElement>('[data-ops-terminal-password]')!).value = 'correct-horse'
    submit(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/terminal', { password: 'correct-horse' })
    expect(status().dataset.state).toBe('open')
    expect(document.querySelector<HTMLElement>('[data-ops-terminal-screen-card]')!.hidden).toBe(false)
    expect(document.querySelector('[data-ops-terminal-screen]')!.textContent).toContain('0f9c3c1e')
    expect(document.querySelector('[data-ops-terminal-execution]')!.getAttribute('data-ops-terminal-execution')).toBe('unavailable')
    expect((document.querySelector<HTMLInputElement>('[data-ops-terminal-password]')!).value).toBe('')
  })
  it('reports a wrong password and a lockout without opening a session', async () => {
    boot(vi.fn(async () => { throw Object.assign(new Error('x'), { status: 401, details: {} }) }))
    ;(document.querySelector<HTMLInputElement>('[data-ops-terminal-password]')!).value = 'wrong'
    submit(); await tick()
    expect(status().dataset.state).toBe('denied')
    expect(document.querySelector<HTMLElement>('[data-ops-terminal-screen-card]')!.hidden).toBe(true)
    boot(vi.fn(async () => { throw Object.assign(new Error('x'), { status: 403, details: { lockedOut: true } }) }))
    ;(document.querySelector<HTMLInputElement>('[data-ops-terminal-password]')!).value = 'correct-horse'
    submit(); await tick()
    expect(status().textContent).toContain('Too many failed attempts')
  })
  it('stays unavailable without an authorized interactive session', async () => {
    const send = vi.fn(async () => session())
    boot(send, false)
    expect(status().dataset.state).toBe('unavailable')
    expect(document.querySelector('form')).toBeNull()
    expect([...document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[data-ops-terminal-workspace] :is(input,button.xp-btn--primary)')].every(control => control.disabled)).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('unavailable-mode structure for every ops workspace', () => {
  it('renders no form and only disabled controls when the capability is unavailable (en/ar)', async () => {
    const { renderOpsFileSharingWorkspace } = await import('./board-port/ops-file-sharing-workspace.ts')
    const { renderOpsNodesWorkspace } = await import('./board-port/ops-nodes-workspace.ts')
    const { renderOpsIntegrationsWorkspace } = await import('./board-port/ops-integrations-workspace.ts')
    for (const locale of ['en', 'ar'] as const) {
      for (const html of [renderOpsTerminalWorkspace({ locale, canUse: false }), renderOpsFileSharingWorkspace({ locale, canRead: false, canManage: false }), renderOpsNodesWorkspace({ locale, canRead: false, canManage: false }), renderOpsIntegrationsWorkspace({ locale, canRead: false, canManage: false })]) {
        expect(html).not.toMatch(/<form\b/)
        for (const control of html.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)) expect(control[0]).toMatch(/\bdisabled\b/)
        expect(html).not.toMatch(/[٠-٩۰-۹]/)
      }
    }
  })
})
