// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_PGP_CLIENT_BINDING, readPgpView } from './account-pgp-client.ts'
import { renderAccountPgpWorkspace } from './board-port/account-pgp-workspace.ts'
const ID = '11111111-1111-4111-8111-111111111111', FP = 'A'.repeat(40)
const key = { fingerprint: FP, uids: ['Alice <alice@example.test>'], algorithm: 'Ed25519', bits: 255, created: '2023-11-14T22:13:20.000Z', expires: null, hasSecret: true, encryption: true }
const view = (present = true, revision = 'a', status = 'read') => ({ context: { accountId: ID, username: 'alice' }, revision: revision.repeat(64), keys: present ? [key] : [], mailboxes: ['alice@example.test'], application: { status, fingerprint: status === 'read' ? null : FP }, capabilities: { generate: true, import: true, export: present, delete: present }, scope: 'account-keyring', messageEncryption: false })
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
async function mount(send: (method: string, path: string, body?: unknown) => Promise<unknown>, canManage = true) {
  document.body.innerHTML = renderAccountPgpWorkspace({ lang: 'en', accountId: ID, username: 'alice', canManage })
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  ;(new Function('return ' + ACCOUNT_PGP_CLIENT_BINDING)() as (ask: unknown) => void)(async () => true)
  await settle()
}
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); vi.restoreAllMocks() })
describe('OpenPGP client', () => {
  it('keeps bilingual approved components, a masked passphrase and private-file input', () => {
    for (const lang of ['en', 'ar'] as const) { const html = renderAccountPgpWorkspace({ lang, accountId: ID, username: 'alice', canManage: true }); expect(html).toContain('dir="' + (lang === 'ar' ? 'rtl' : 'ltr') + '"'); expect(html).not.toMatch(/[٠-٩۰-۹]/); expect(html).toContain('type="password"'); expect(html).toContain('type="file"'); expect(html).not.toContain('<textarea'); expect(html).toContain('<bdi dir="ltr">~/.gnupg</bdi>') }
    expect(ACCOUNT_PGP_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('does not request or enable controls in an unavailable workspace', async () => {
    const request = vi.fn(async () => view()); await mount(request, false); expect(request).not.toHaveBeenCalled(); expect($<HTMLButtonElement>('[data-pgp-generate]').disabled).toBe(true); expect($('[data-pgp-status]').dataset.state).toBe('unavailable')
  })
  it('rejects secret fields, foreign identities and deceptive encryption promises', () => {
    expect(readPgpView(view(), ID).keys).toHaveLength(1)
    for (const bad of [{ ...view(), privateKey: 'secret' }, { ...view(), messageEncryption: true }, { ...view(), context: { accountId: 'foreign', username: 'bob' } }, { ...view(), keys: [{ ...key, secretArmor: 'secret' }] }, { ...view(), keys: [key, key] }]) expect(() => readPgpView(bad, ID)).toThrow()
  })
  it('renders only a public download link and requires typing the whole fingerprint', async () => {
    await mount(async () => view()); expect($<HTMLAnchorElement>('[data-pgp-rows] a').getAttribute('href')).toBe('/api/account/pgp/' + FP + '/public')
    $<HTMLButtonElement>('[data-pgp-rows] button').click(); $<HTMLInputElement>('[data-pgp-confirm]').value = FP.slice(0, 12); $('[data-pgp-confirm]').dispatchEvent(new Event('input')); expect($<HTMLButtonElement>('[data-pgp-delete]').disabled).toBe(true)
    $<HTMLInputElement>('[data-pgp-confirm]').value = FP; $('[data-pgp-confirm]').dispatchEvent(new Event('input')); expect($<HTMLButtonElement>('[data-pgp-delete]').disabled).toBe(false)
  })
  it('clears a passphrase before sending and acknowledges generation only after a matching readback', async () => {
    let present = false
    const request = vi.fn(async (method: string, _path: string, body?: unknown) => { if (method === 'POST') { expect($<HTMLInputElement>('[data-pgp-passphrase]').value).toBe(''); expect(body).toMatchObject({ op: 'generate', passphrase: 'private passphrase', expectedRevision: 'a'.repeat(64) }); present = true; return view(true, 'b', 'generated') } return view(present, present ? 'b' : 'a') })
    await mount(request); $<HTMLInputElement>('[data-pgp-name]').value = 'Alice'; $<HTMLInputElement>('[data-pgp-passphrase]').value = 'private passphrase'; $<HTMLButtonElement>('[data-pgp-generate]').click(); await settle()
    expect(request.mock.calls.map(call => call[0])).toEqual(['GET', 'POST', 'GET']); expect($('[data-pgp-status]').dataset.state).toBe('saved'); expect(document.body.textContent).not.toContain('private passphrase')
  })
  it('locks after an uncertain mutation and requires a successful fresh read', async () => {
    const request = vi.fn(async (method: string) => { if (method === 'POST') throw Object.assign(new Error('unavailable'), { details: { unknownOutcome: true } }); return view(false) })
    await mount(request); $<HTMLInputElement>('[data-pgp-name]').value = 'Alice'; $<HTMLInputElement>('[data-pgp-passphrase]').value = 'private passphrase'; $<HTMLButtonElement>('[data-pgp-generate]').click(); await settle()
    expect($('[data-pgp-status]').dataset.state).toBe('uncertain'); expect($<HTMLButtonElement>('[data-pgp-generate]').disabled).toBe(true); expect($<HTMLButtonElement>('[data-pgp-refresh]').disabled).toBe(false)
    $<HTMLButtonElement>('[data-pgp-refresh]').click(); await settle(); expect($<HTMLButtonElement>('[data-pgp-generate]').disabled).toBe(false)
  })
  it('refuses generation acknowledgements without the requested identity and encryption subkey', async () => {
    await mount(async method => method === 'POST' ? { ...view(true, 'b', 'generated'), keys: [{ ...key, encryption: false }] } : view(false))
    $<HTMLInputElement>('[data-pgp-name]').value = 'Alice'; $<HTMLInputElement>('[data-pgp-passphrase]').value = 'private passphrase'; $<HTMLButtonElement>('[data-pgp-generate]').click(); await settle()
    expect($('[data-pgp-status]').dataset.state).toBe('uncertain'); expect($<HTMLButtonElement>('[data-pgp-generate]').disabled).toBe(true)
  })
})
