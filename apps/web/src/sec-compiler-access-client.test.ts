// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmDetailPage } from './board-port/approved-xwhm.ts'
import { renderV2WhmSecurityOverview } from './themes/v2/pages/xwhm/security/overview.ts'
import { AUTHORITATIVE_CONTROLLER_DECLARATIONS } from './themes/controller-hooks.ts'
import { checkControllerDeclarations } from './themes/controller-conformance.ts'
import { parseMarkup } from './themes/markup.ts'
import { readSecSavedView, SEC_SECURITY_CLIENT_BINDING } from './sec-security-client.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
type Theme = 'classic' | 'v2'
const tick = async () => { for (let index = 0; index < 10; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const text = (key: string) => $(`[data-sec-field="${key}"]`).textContent
const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64), PATH = '/api/server/sec/compiler-access'
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333', GONE = '44444444-4444-4444-8444-444444444444'
const accounts = [{ id: A, username: 'alice', jailedShell: false }, { id: B, username: 'bob', jailedShell: true }, { id: C, username: 'carol', jailedShell: false }]
const commands = [{ name: 'gcc', present: true, restricted: true, mode: 0o750 }, { name: 'cc', present: true, restricted: true, mode: 0o750 }, { name: 'c++', present: false, restricted: null, mode: null }, { name: 'as', present: true, restricted: true, mode: 0o750 }]
const debian = (policy: { restricted: boolean; accountIds: string[] }, members: string[]) => ({ observedAt: '2026-11-06T09:30:00.000Z', family: 'debian', state: 'applied', policy, expected: { members, excluded: [] },
  group: { exists: true, gid: 990, members }, commands, hook: { mechanism: 'dpkg-post-invoke', available: true, installed: true } })
const saved = (policy: { restricted: boolean; accountIds: string[] }, revision = R1, extra: Record<string, unknown> = {}) => ({ state: 'saved', policy, updatedAt: '2026-11-06T09:00:00.000Z', revision, accounts, observation: debian(policy, ['alice']), reason: null, ...extra })
const ROOT = { kind: 'root' as const, id: 'synthetic-root', username: 'synthetic-root' }
const markup = (theme: Theme, locale: 'en' | 'ar' = 'en', canRead = true): string => theme === 'classic'
  ? renderWhmDetailPage({ activeRoute: '/whm/security', principal: ROOT, locale })!
  : renderV2WhmSecurityOverview({ activeRoute: '/whm/security', principal: ROOT, locale, observationAuthority: { canRead, canManage: canRead } })
const boot = (theme: Theme, send?: Send, ask?: (options: Record<string, unknown>) => Promise<unknown>, locale: 'en' | 'ar' = 'en', canRead = true) => {
  delete (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest
  document.body.innerHTML = markup(theme, locale, canRead)
  if (send) (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + SEC_SECURITY_CLIENT_BINDING)()(ask)
}
const choose = (id: string) => { const select = $<HTMLSelectElement>('[data-sec-input="account"]'); select.value = id; select.dispatchEvent(new Event('change')) }
const puts = (send: { mock: { calls: readonly (readonly unknown[])[] } }) => send.mock.calls.filter(([method]) => method === 'PUT')
afterEach(() => { document.body.innerHTML = ''; document.documentElement.lang = ''; document.documentElement.dir = '' })

describe('compiler access reader and markup', () => {
  it('accepts only the restricted/accountIds grammar and the granted-account list', () => {
    expect(readSecSavedView(saved({ restricted: true, accountIds: [A] }), 'compiler-access').accounts).toEqual(accounts)
    expect(() => readSecSavedView(saved({ restricted: true, accountIds: [A], extra: 1 } as never), 'compiler-access')).toThrow()
    expect(() => readSecSavedView(saved({ restricted: 'yes', accountIds: [] } as never), 'compiler-access')).toThrow()
    expect(() => readSecSavedView(saved({ restricted: true, accountIds: ['alice'] }), 'compiler-access')).toThrow()
    expect(() => readSecSavedView(saved({ restricted: true, accountIds: [] }, R1, { accounts: [{ id: A, username: 'Alice!', jailedShell: false }] }), 'compiler-access')).toThrow()
  })
  it.each(['classic', 'v2'] as const)('mounts every declared compiler control in the %s Compiler lock card', theme => {
    const declaration = AUTHORITATIVE_CONTROLLER_DECLARATIONS.find(item => item.id === 'sec-kit-compiler-access')!
    const html = markup(theme)
    expect(checkControllerDeclarations(parseMarkup(`<html><body>${html}</body></html>`), [declaration], { route: '/whm/security', surface: 'xwhm', qualified: true })).toEqual([])
    expect(html).toContain('data-sec-page="compiler-access" data-sec-can-read="true" data-sec-can-manage="true"')
    for (const label of ['Compiler lock', 'Restrict compiler access', 'Compiler exceptions', 'Add account', 'Remove exception']) expect(html).toContain(label)
  })
})

describe('compiler access binding', () => {
  it.each(['classic', 'v2'] as const)('stays unavailable without transport or read authority in %s', async theme => {
    boot(theme); await tick()
    expect($('[data-sec-status]').dataset.state).toBe('unavailable')
    expect($<HTMLButtonElement>('[data-sec-action="refresh"]').disabled).toBe(true)
    if (theme === 'v2') {
      const send = vi.fn<Send>(async () => saved({ restricted: true, accountIds: [] }))
      boot(theme, send, undefined, 'en', false); await tick()
      expect(send).not.toHaveBeenCalled()
      expect($('[data-sec-status]').dataset.state).toBe('unavailable')
      expect([...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('[data-sec-workspace] :is(input,select,button)')].every(node => node.disabled)).toBe(true)
    }
    expect(SEC_SECURITY_CLIENT_BINDING).not.toContain('innerHTML')
  })

  it('paints the connected state and grants an account with the read revision and a read-back', async () => {
    let granted = false
    const two = { restricted: true, accountIds: [A, C] }
    const send = vi.fn<Send>(async method => method === 'PUT' ? (granted = true, { ...saved(two, R2), accounts: undefined, observation: undefined, reason: undefined, reconcile: 'requested' })
      : granted ? saved(two, R2) : saved({ restricted: true, accountIds: [A] }))
    boot('classic', send); await tick()
    expect(send).toHaveBeenCalledWith('GET', PATH, undefined)
    expect(text('restriction')).toBe('Restricted to root and the granted accounts')
    expect(text('host-state')).toBe('Applied on this server')
    expect($('[data-sec-field="host-state"]').dataset.tone).toBe('good')
    expect(text('commands')).toBe('3 of 3 installed commands restricted')
    expect(text('group')).toBe('Exists (GID 990)')
    expect(text('hook')).toBe('Installed: dpkg runs it after every package change')
    expect(text('observed-at')).toBe('2026-11-06 09:30 UTC')
    expect($<HTMLInputElement>('[data-sec-input="restricted"]').checked).toBe(true)
    expect($('[data-sec-rows="exceptions"]').textContent).toBe('aliceIn the compiler group')
    const bob = [...$<HTMLSelectElement>('[data-sec-input="account"]').options].find(option => option.value === B)!
    expect([bob.textContent, bob.disabled]).toEqual(['bob (jailed shell)', true])
    choose(B)
    expect($<HTMLButtonElement>('[data-sec-action="grant"]').disabled).toBe(true)
    choose(C)
    expect($<HTMLButtonElement>('[data-sec-action="grant"]').disabled).toBe(false)
    expect($<HTMLButtonElement>('[data-sec-action="revoke"]').disabled).toBe(true)
    $<HTMLButtonElement>('[data-sec-action="grant"]').click(); await tick()
    expect(puts(send)).toEqual([['PUT', PATH, { policy: two, expectedRevision: R1 }]])
    expect(send.mock.calls.at(-1)).toEqual(['GET', PATH, undefined])
    expect($('[data-sec-result]').textContent).toContain('asked to apply')
    expect($('[data-sec-rows="exceptions"]').textContent).toContain('carolNot in the compiler group yet')
  })

  it('shows a jailed grant and the unavailable EL hook truthfully in RTL with ASCII digits', async () => {
    document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl'
    const policy = { restricted: true, accountIds: [A, B] }
    const rhel = { ...debian(policy, []), family: 'rhel', state: 'drift', expected: { members: ['alice'], excluded: [{ username: 'bob', reason: 'jailed_shell' }] }, hook: { mechanism: 'dnf-post-transaction-actions', available: false, installed: false } }
    boot('v2', vi.fn<Send>(async () => saved(policy, R1, { observation: rhel })), undefined, 'ar'); await tick()
    expect(text('hook')).toBe('غير متاح: إضافة post-transaction-actions لـ dnf غير مثبتة. تعيد كل مطابقة تطبيق التقييد.')
    expect($('[data-sec-field="hook"]').dataset.tone).toBe('warn')
    expect(text('host-state')).toBe('غير مطبَّقة: هذا الخادم يختلف عن السياسة المحفوظة')
    expect($('[data-sec-rows="exceptions"]').textContent).toBe('aliceليس ضمن مجموعة المترجمات بعدbobطرفية معزولة: يبقى مقيّدًا')
    choose(B)
    expect($<HTMLButtonElement>('[data-sec-action="grant"]').disabled).toBe(true)
    expect($<HTMLButtonElement>('[data-sec-action="revoke"]').disabled).toBe(false)
    expect($('[data-sec-workspace]').closest('[dir="rtl"]')).not.toBeNull()
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
  })

  it('reports a missing host observation and a never-saved policy without inventing state', async () => {
    const send = vi.fn<Send>(async () => ({ state: 'default', policy: { restricted: false, accountIds: [] }, updatedAt: null, revision: R1, accounts, observation: null, reason: 'host_agent_unavailable' }))
    boot('v2', send); await tick()
    expect($('[data-sec-status]').textContent).toBe('Saved configuration read. The host observation is unavailable.')
    expect(text('restriction')).toBe('Not managed; the distribution permissions are unchanged')
    for (const key of ['host-state', 'commands', 'group', 'hook', 'observed-at']) expect(text(key), key).toBe('Not read')
    expect(text('reconcile')).toBe('No apply request has been made.')
    expect($('[data-sec-rows="exceptions"]').textContent).toBe('No accounts are granted.')
  })

  it.each([
    [{ status: 422, code: 'VALIDATION', details: { stateChanged: false } }, 'invalid'],
    [{ status: 412, code: 'PRECONDITION_FAILED', details: { stateChanged: false } }, 'refused'],
    [{ status: 503, code: 'SERVICE_UNAVAILABLE', details: { stateChanged: true, unknownOutcome: true } }, 'unknown'],
  ])('keeps the saved list when the server refuses a revoke (%o)', async (refusal, outcome) => {
    const send = vi.fn<Send>(async method => { if (method === 'GET') return saved({ restricted: true, accountIds: [A, GONE] }); throw refusal })
    boot('classic', send); await tick()
    expect($('[data-sec-rows="exceptions"]').textContent).toContain(GONE + 'Not a current account; it is dropped with the next change')
    choose(A); $<HTMLButtonElement>('[data-sec-action="revoke"]').click(); await tick()
    expect(puts(send)).toEqual([['PUT', PATH, { policy: { restricted: true, accountIds: [] }, expectedRevision: R1 }]])
    expect($('[data-sec-result]').dataset.outcome).toBe(outcome)
    expect($('[data-sec-rows="exceptions"]').textContent).toContain('alice')
  })

  it('confirms enable-for-all, reports a revision conflict once and restores the saved switch', async () => {
    const send = vi.fn<Send>(async method => { if (method === 'GET') return saved({ restricted: true, accountIds: [A] }); throw { status: 409, code: 'CONFLICT', details: { stateChanged: false } } })
    const ask = vi.fn(async () => true)
    boot('v2', send, ask); await tick()
    $<HTMLInputElement>('[data-sec-input="restricted"]').click(); await tick()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Enable compilers for all users?', confirm: 'Enable for all users' }))
    expect(puts(send)).toEqual([['PUT', PATH, { policy: { restricted: false, accountIds: [A] }, expectedRevision: R1 }]])
    expect($('[data-sec-result]').dataset.outcome).toBe('conflict')
    expect($('[data-sec-result]').textContent).toBe('The saved configuration changed before this action. Nothing was changed; reload and review.')
    expect($<HTMLInputElement>('[data-sec-input="restricted"]').checked).toBe(true)
  })

  it('sends nothing when the restriction change is not confirmed', async () => {
    const send = vi.fn<Send>(async () => ({ ...saved({ restricted: false, accountIds: [] }), state: 'default', updatedAt: null }))
    const ask = vi.fn(async () => false)
    boot('classic', send, ask); await tick()
    $<HTMLInputElement>('[data-sec-input="restricted"]').click(); await tick()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Restrict compilers?' }))
    expect(puts(send)).toEqual([])
    expect($<HTMLInputElement>('[data-sec-input="restricted"]').checked).toBe(false)
  })
})
