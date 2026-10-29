// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_SSH_CLIENT_BINDING, readAccountSshView } from './account-ssh-client.ts'
import { renderAccountSshWorkspace } from './board-port/account-ssh-workspace.ts'

const accountId = '11111111-1111-4111-8111-111111111111', FP = 'SHA256:' + 'A'.repeat(43), FP2 = 'SHA256:' + 'B'.repeat(43)
const key = (fingerprint: string, line: number) => ({ line, type: 'ssh-ed25519', fingerprint, comment: 'laptop', bits: 256, hasOptions: false, allowed: true })
const view = (keys = [key(FP, 1)], extra: Record<string, unknown> = {}, revision = 'a') => ({ context: { accountId, username: 'alice' }, file: { path: '.ssh/authorized_keys', exists: keys.length > 0, sizeBytes: keys.length ? 90 : 0, mtime: keys.length ? '2026-10-27T00:00:00.000Z' : null, revision: revision.repeat(64), directory: { exists: true, kind: 'directory', mode: 0o700 } },
  keys, unrecognizedLines: [], capacity: { maxKeys: 100, used: keys.length }, login: { enabled: true, accountShell: 'jailed', planShell: 'jailed', port: 22, source: 'saved-configuration' }, capabilities: { canAdd: true, canRemove: keys.length > 0, reason: null }, application: { status: 'read', nativeQualified: false }, ...extra })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); vi.restoreAllMocks() })
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
async function bind(html: string, request?: (method: string, path: string, body?: unknown) => Promise<unknown>, confirm: unknown = async () => true) {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = html
  ;(new Function('return ' + ACCOUNT_SSH_CLIENT_BINDING)() as (confirm: unknown) => void)(confirm)
  await settle(); await settle()
}
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!

describe('account SSH access page', () => {
  it('renders bilingual markup with isolated technical values, ASCII digits and no form', () => {
    for (const lang of ['en', 'ar'] as const) {
      const html = renderAccountSshWorkspace({ lang, accountId, username: 'alice', canManage: true })
      expect(html).toContain(`dir="${lang === 'ar' ? 'rtl' : 'ltr'}"`); expect(html).not.toMatch(/[٠-٩۰-۹]/); expect(html).not.toContain('<form')
      for (const part of ['data-ssh-rows', 'data-ssh-key', 'data-ssh-add', 'data-ssh-refresh', 'data-ssh-status', '<bdi dir="ltr">~/.ssh/authorized_keys</bdi>', '<bdi dir="ltr">alice</bdi>']) expect(html).toContain(part)
    }
    expect(renderAccountSshWorkspace({ lang: 'ar', accountId, username: 'alice', canManage: true })).toContain('المفاتيح المصرّح بها')
    expect(ACCOUNT_SSH_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('keeps the read-only page inert: every control disabled and nothing requested', async () => {
    const request = vi.fn(async () => clone(view()))
    await bind(renderAccountSshWorkspace({ lang: 'en', accountId, username: 'alice', canManage: false }), request)
    expect(request).not.toHaveBeenCalled(); expect([...document.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button,textarea')].every(control => control.disabled)).toBe(true)
    expect($('[data-ssh-status]').getAttribute('data-state')).toBe('unavailable')
  })
  it('strictly rejects foreign, uncertain or malformed replies', () => {
    expect(readAccountSshView(clone(view()), accountId).keys).toHaveLength(1)
    for (const bad of [{ ...view(), context: { accountId: '22222222-2222-4222-8222-222222222222', username: 'bob' } }, { ...view(), keys: [{ ...key(FP, 1), fingerprint: 'MD5:aa' }] }, { ...view(), keys: [{ ...key(FP, 1), type: 'ssh-rsa1' }] },
      { ...view(), capacity: { maxKeys: 100, used: 3 } }, { ...view(), application: { status: 'read', nativeQualified: true } }, { ...view(), details: { unknownOutcome: true } }, { ...view(), file: { ...view().file, path: '../../root/.ssh/authorized_keys' } }, { ...view(), keys: [key(FP, 1), key(FP2, 1)], capacity: { maxKeys: 100, used: 2 } }])
      expect(() => readAccountSshView(clone(bad), accountId)).toThrow()
  })
  it.each(['en', 'ar'] as const)('describes the key file and labels removal as whole messages in %s', async lang => {
    document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
    try {
      await bind(renderAccountSshWorkspace({ lang, accountId, username: 'alice', canManage: true }), vi.fn(async () => clone(view([key(FP, 1)], { unrecognizedLines: [2, 3, 4] }))))
      expect($('[data-ssh-file]').textContent).toBe(lang === 'ar' ? 'ملف المفاتيح موجود (90 بايت). 3 أسطر ليست مفاتيح تستطيع هذه الصفحة قراءتها؛ تبقى دون تغيير.' : 'The key file exists (90 bytes). 3 lines are not keys this page can read; they are kept unchanged.')
      expect($('[data-ssh-rows] button').getAttribute('aria-label')).toBe((lang === 'ar' ? 'إزالة: ' : 'Remove: ') + FP)
    } finally { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' }
  })
  it('adds with the captured revision, requires an exact acknowledgement and readback, and removes by fingerprint', async () => {
    let current = view()
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      expect(path).toBe('/api/account/ssh/keys')
      if (method === 'POST') { expect(body).toEqual({ expectedRevision: 'a'.repeat(64), key: 'ssh-ed25519 AAAA new' }); current = view([key(FP, 1), key(FP2, 2)], {}, 'b'); return { ...clone(current), application: { status: 'added', nativeQualified: false } } }
      if (method === 'DELETE') { expect(body).toEqual({ expectedRevision: 'b'.repeat(64), fingerprint: FP }); current = view([key(FP2, 1)], {}, 'c'); return { ...clone(current), application: { status: 'removed', nativeQualified: false, removedLines: 1 } } }
      return clone(current)
    })
    await bind(renderAccountSshWorkspace({ lang: 'en', accountId, username: 'alice', canManage: true }), request)
    expect(document.querySelectorAll('[data-ssh-rows] tr')).toHaveLength(1); expect($('[data-ssh-port]').textContent).toBe('22')
    $<HTMLTextAreaElement>('[data-ssh-key]').value = '  ssh-ed25519 AAAA new '; $('[data-ssh-key]').dispatchEvent(new Event('input'))
    $<HTMLButtonElement>('[data-ssh-add]').click(); await settle(); await settle(); await settle()
    expect(request.mock.calls.map(call => call[0])).toEqual(['GET', 'POST', 'GET']); expect($('[data-ssh-status]').getAttribute('data-state')).toBe('saved'); expect($<HTMLTextAreaElement>('[data-ssh-key]').value).toBe('')
    $<HTMLButtonElement>('[data-ssh-rows] button').click(); await settle(); await settle(); await settle()
    expect(request.mock.calls.map(call => call[0])).toEqual(['GET', 'POST', 'GET', 'DELETE', 'GET']); expect(document.querySelectorAll('[data-ssh-rows] tr')).toHaveLength(1); expect($('[data-ssh-rows]').textContent).toContain(FP2)
  })
  it('shows field refusals, locks on stale revisions and on acknowledgements that do not match', async () => {
    const refused = vi.fn(async (method: string) => { if (method === 'POST') throw Object.assign(new Error('refused'), { status: 422, details: { stateChanged: false, fields: [{ field: 'key', code: 'options_refused' }] } }); return clone(view()) })
    await bind(renderAccountSshWorkspace({ lang: 'en', accountId, username: 'alice', canManage: true }), refused)
    $<HTMLTextAreaElement>('[data-ssh-key]').value = 'command="sh" ssh-ed25519 AAAA'; $('[data-ssh-key]').dispatchEvent(new Event('input')); $<HTMLButtonElement>('[data-ssh-add]').click(); await settle(); await settle()
    expect($('[data-ssh-status]').getAttribute('data-state')).toBe('fields'); expect($('[data-ssh-status]').textContent).toContain('command='); expect($<HTMLButtonElement>('[data-ssh-add]').disabled).toBe(false)
    document.body.replaceChildren()
    const stale = vi.fn(async (method: string) => { if (method === 'DELETE') throw Object.assign(new Error('changed'), { status: 409, details: { stateChanged: false } }); return clone(view()) })
    await bind(renderAccountSshWorkspace({ lang: 'en', accountId, username: 'alice', canManage: true }), stale)
    $<HTMLButtonElement>('[data-ssh-rows] button').click(); await settle(); await settle()
    expect($('[data-ssh-status]').getAttribute('data-state')).toBe('stale'); expect($<HTMLButtonElement>('[data-ssh-rows] button').disabled).toBe(true); expect($<HTMLButtonElement>('[data-ssh-refresh]').disabled).toBe(false)
    document.body.replaceChildren()
    const lying = vi.fn(async (method: string) => method === 'POST' ? { ...clone(view()), application: { status: 'added', nativeQualified: false } } : clone(view()))
    await bind(renderAccountSshWorkspace({ lang: 'en', accountId, username: 'alice', canManage: true }), lying)
    $<HTMLTextAreaElement>('[data-ssh-key]').value = 'ssh-ed25519 AAAA'; $('[data-ssh-key]').dispatchEvent(new Event('input')); $<HTMLButtonElement>('[data-ssh-add]').click(); await settle(); await settle()
    expect($('[data-ssh-status]').getAttribute('data-state')).toBe('uncertain'); expect(lying.mock.calls.map(call => call[0])).toEqual(['GET', 'POST'])
    const declined = vi.fn(async () => clone(view())); document.body.replaceChildren()
    await bind(renderAccountSshWorkspace({ lang: 'en', accountId, username: 'alice', canManage: true }), declined, async () => false)
    $<HTMLButtonElement>('[data-ssh-rows] button').click(); await settle(); expect(declined).toHaveBeenCalledTimes(1)
  })
})
