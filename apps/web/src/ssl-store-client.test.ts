// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSslStoreWorkspace } from './board-port/ssl-store-workspace.ts'
import { SSL_STORE_CLIENT_BINDING, sslStoreRefusal } from './ssl-store-client.ts'

const key = { id: 'shop_0a1b2c3d', label: null as string | null, modifiedAt: '2026-11-06T10:00:00.000Z', valid: true, publicKeySha256: 'a'.repeat(64), keyType: 'ec', bits: 256, curve: 'prime256v1' }
const certificate = { id: 'shop_0a1b2c3d', modifiedAt: '2026-11-06T10:00:00.000Z', valid: true, publicKeySha256: 'a'.repeat(64), commonName: 'shop.test', names: ['shop.test'], issuer: null,
  selfSigned: true, notBefore: '2026-11-06T10:00:00.000Z', notAfter: '2027-11-06T10:00:00.000Z', fingerprintSha256: 'b'.repeat(64) }
const view = (keys = [key]) => ({ keys, csrs: [], certificates: [certificate], keyTypes: ['rsa-2048', 'ecdsa-prime256v1'], defaultKeyType: 'ecdsa-prime256v1', limits: { truncated: false }, application: { status: 'read', changed: [] } })
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const bind = (askDialog?: () => Promise<unknown>) => (new Function('return ' + SSL_STORE_CLIENT_BINDING)() as (dialog: unknown) => void)(askDialog)

beforeEach(() => {
  document.body.innerHTML = renderSslStoreWorkspace({ locale: 'en', mode: 'account', canManage: true, username: 'alice' })
  ;(globalThis as { xpT?: unknown }).xpT = (message: string, values?: Record<string, unknown>) => message.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ''))
  ;(globalThis as { msgctxt?: unknown }).msgctxt = (_context: string, message: string) => message
})
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('SSL storage client', () => {
  it('reads metadata, shows a key only on View and deletes with the read revision', async () => {
    const send = vi.fn(async (method: string, path: string, _body?: unknown) => {
      if (method === 'GET' && path === '/api/accounts/alice/ssl') return view()
      if (method === 'GET' && path === '/api/accounts/alice/certificates') return { revision: 4, domains: [{ name: 'shop.test' }] }
      if (method === 'GET') return { kind: 'key', item: key, pem: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' }
      if (method === 'DELETE') return view([])
      return { certificate: { id: 'x' } }
    })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    bind(async () => true); await tick()
    expect(document.body.textContent).toContain('shop_0a1b2c3d')
    expect(document.querySelector('[data-ssl-store-pem]')!.textContent).toBe('')
    expect(document.querySelector<HTMLSelectElement>('select[name="keyType"]')!.value).toBe('ecdsa-prime256v1')
    expect(document.querySelector<HTMLSelectElement>('select[name="domain"]')!.value).toBe('shop.test')
    const keyRow = document.querySelector('tbody[data-ssl-store-keys] tr')!
    ;[...keyRow.querySelectorAll('button')].find(button => button.textContent === 'View')!.click(); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/accounts/alice/ssl/keys/shop_0a1b2c3d')
    expect(document.querySelector('[data-ssl-store-pem]')!.textContent).toContain('BEGIN PRIVATE KEY')
    ;[...keyRow.querySelectorAll('button')].find(button => button.textContent === 'Delete')!.click(); await tick()
    expect(send).toHaveBeenCalledWith('DELETE', '/api/accounts/alice/ssl/keys/shop_0a1b2c3d', { modifiedAt: key.modifiedAt })
  })
  it('installs a stored certificate with the workspace revision and locks after an unknown outcome', async () => {
    const send = vi.fn(async (method: string, path: string, _body?: unknown) => {
      if (method === 'GET' && path === '/api/accounts/alice/ssl') return view()
      if (method === 'GET') return { revision: 4, domains: [{ name: 'shop.test' }] }
      if (path.endsWith('/install')) throw { status: 503, details: { stateChanged: true, unknownOutcome: true } }
      return view()
    })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    bind(); await tick()
    document.querySelector<HTMLFormElement>('form[data-ssl-store-install-form]')!.dispatchEvent(new Event('submit', { cancelable: true })); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/accounts/alice/certificates/install', { domain: 'shop.test', expectedRevision: 4, storeCertificateId: 'shop_0a1b2c3d' })
    expect(document.querySelector('[data-ssl-store-status]')!.getAttribute('data-state')).toBe('uncertain')
    expect(document.querySelector<HTMLButtonElement>('form[data-ssl-store-key-form] button[type="submit"]')!.disabled).toBe(true)
  })
  it('renames an item through the dialog and sends the challenge passphrase once', async () => {
    const send = vi.fn(async (method: string, path: string, _body?: unknown) => {
      if (method === 'GET' && path === '/api/accounts/alice/ssl') return view()
      if (method === 'GET') return { revision: 4, domains: [{ name: 'shop.test' }] }
      if (method === 'PATCH') return view([{ ...key, label: 'Shop' }])
      return view()
    })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    const answers = [' Shop ', '']
    bind(async () => answers.shift()); await tick()
    const rename = () => [...document.querySelectorAll('tbody[data-ssl-store-keys] tr button')].find(button => button.textContent === 'Rename') as HTMLButtonElement
    rename().click(); await tick()
    expect(send).toHaveBeenCalledWith('PATCH', '/api/accounts/alice/ssl/keys/shop_0a1b2c3d', { label: 'Shop' })
    expect(document.querySelector('tbody[data-ssl-store-keys]')!.textContent).toContain('Shop')
    rename().click(); await tick()
    expect(send).toHaveBeenLastCalledWith('PATCH', '/api/accounts/alice/ssl/keys/shop_0a1b2c3d', { label: null })
    const form = document.querySelector<HTMLFormElement>('form[data-ssl-store-csr-form]')!
    ;(form.elements.namedItem('names') as HTMLTextAreaElement).value = 'shop.test'
    ;(form.elements.namedItem('passphrase') as HTMLInputElement).value = 'open sesame'
    form.dispatchEvent(new Event('submit', { cancelable: true })); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/accounts/alice/ssl/csrs', { keyType: 'ecdsa-prime256v1', names: ['shop.test'], subject: {}, passphrase: 'open sesame' })
    expect((form.elements.namedItem('passphrase') as HTMLInputElement).value).toBe('')
  })
  it('reads root\'s server store and installs a stored certificate for the mail services', async () => {
    document.body.innerHTML = renderSslStoreWorkspace({ locale: 'en', mode: 'service', canManage: true })
    const send = vi.fn(async (method: string, path: string, _body?: unknown) => {
      if (method === 'GET' && path === '/api/server/ssl') return view()
      return { certificate: { id: 'saved' }, service: 'mail', mailUses: true }
    })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    bind(); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/ssl')
    const service = document.querySelector<HTMLSelectElement>('select[name="service"]')!
    expect([...service.options].filter(option => !option.disabled).map(option => option.value)).toEqual(['mail'])
    document.querySelector<HTMLFormElement>('form[data-ssl-store-service-form]')!.dispatchEvent(new Event('submit', { cancelable: true })); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/ssl/certificates/shop_0a1b2c3d/install', { service: 'mail' })
    expect(document.querySelector('[data-ssl-store-status]')!.textContent).toBe('The certificate is saved for the mail services (SMTP, IMAP and POP3). Served TLS is not verified here.')
  })
  it('offers root\'s store first in the WHM storage manager and an owned account after it', async () => {
    document.body.innerHTML = renderSslStoreWorkspace({ locale: 'en', mode: 'storage', canManage: true, accounts: [{ username: 'alice' }], server: true })
    const send = vi.fn(async (_method: string, _path: string) => view())
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    bind(); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/ssl')
    const account = document.querySelector<HTMLSelectElement>('select[data-ssl-store-account]')!
    account.value = 'alice'; account.dispatchEvent(new Event('change')); await tick()
    expect(send).toHaveBeenLastCalledWith('GET', '/api/accounts/alice/ssl')
  })
  it('localizes stable refusal reasons and nothing else', () => {
    const t = (message: string) => message
    expect(sslStoreRefusal({ details: { reason: 'service_install_unavailable' } }, t)).toBe('This service does not take a certificate from SSL storage.')
    expect(sslStoreRefusal({ details: { reason: 'key_missing' } }, t)).toBe('No stored private key matches this certificate.')
    expect(sslStoreRefusal({ details: { reason: 'raw stderr' } }, t)).toBe('The request was refused. Nothing was changed.')
  })
})
