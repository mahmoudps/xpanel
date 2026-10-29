// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderApprovedXpanelWorkspace } from './board-port/approved-xpanel-workspaces.ts'
import { ACCOUNT_SSL_CLIENT_BINDING, accountSslRefusal } from './account-ssl-client.ts'

const id = (value: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(value).padStart(12, '0')
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const acme = { id: id(3), accountId: id(1), username: 'alice', names: ['alice.test'], source: 'acme', challenge: 'http-01' as string | null, notBefore: null,
  notAfter: '2027-01-01T00:00:00.000Z', autoRenew: true, fingerprintSha256: 'a'.repeat(64), renewedAt: null, assignedDomains: ['alice.test'] }
const view = () => ({ revision: 7, accounts: [{ id: id(1), username: 'alice', status: 'active' }],
  domains: [{ id: id(2), accountId: id(1), name: 'alice.test', certificateId: id(3) as string | null }],
  certificates: [clone(acme)], capabilities: { issue: true, renew: true, install: true, remove: true },
  renewalScheduler: { state: 'unavailable' } })
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const hook = <T extends HTMLElement = HTMLElement>(key: string) => document.querySelector<T>('[data-account-ssl-' + key + ']')!
const button = (label: string) => [...hook('rows').querySelectorAll('button')].find(item => item.textContent === label)!

beforeEach(() => {
  const owner = { principal: { kind: 'user', id: id(8), username: 'alice', accountId: id(1) } }
  document.body.innerHTML = renderApprovedXpanelWorkspace({ route: '/security/ssl', locale: 'en', readOnly: false,
    account: { id: id(1), username: 'alice', status: 'active', primaryDomain: 'alice.test' }, domains: [{ id: id(2), accountId: id(1), name: 'alice.test', certificateId: id(3) }],
    certificates: [acme], visibility: owner, catalog: [{ id: 'ssl-certificates', status: 'verified' }] } as never)!
  ;(globalThis as { xpT?: unknown }).xpT = (message: string, values?: Record<string, unknown>) => message.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? '')).replace(/\{days, plural.*\}$/, String(values?.days) + ' days left')
})
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

const model = () => {
  let workspace = view()
  const send = vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
    if (method === 'GET') return clone(workspace)
    if (body?.privateKeyPem === 'mismatch') throw { status: 422, details: { stateChanged: false, reason: 'key_mismatch' } }
    workspace.revision++
    if (method === 'DELETE') { workspace.certificates = []; workspace.domains[0]!.certificateId = null; return { ok: true, removedCertificateId: id(3) } }
    if (path.endsWith('/install')) {
      const saved = { ...clone(acme), id: id(5), source: 'upload', challenge: null, autoRenew: false }
      workspace.certificates = [saved]; workspace.domains[0]!.certificateId = id(5)
      return { certificate: saved }
    }
    workspace.certificates[0]!.notAfter = '2027-04-01T00:00:00.000Z'
    return { certificate: workspace.certificates[0] }
  })
  const ask = vi.fn(async (_options: Record<string, unknown>) => true)
  const boot = async () => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + ACCOUNT_SSL_CLIENT_BINDING)()(ask); await tick() }
  return { send, ask, boot, writes: () => send.mock.calls.filter(call => call[0] !== 'GET') }
}

describe('account SSL/TLS page client', () => {
  it('is a self-contained text-only controller that reads only its own account', async () => {
    expect(ACCOUNT_SSL_CLIENT_BINDING).not.toContain('innerHTML')
    expect(ACCOUNT_SSL_CLIENT_BINDING).not.toContain('fetch(')
    const f = model(); await f.boot()
    expect(f.send).toHaveBeenCalledWith('GET', '/api/accounts/alice/certificates')
    expect(hook('autossl-chip').textContent).toBe('AutoSSL not connected')
    expect(hook('rows').textContent).toContain('Not scheduled on this server. Use Renew now.')
    expect(button('Renew now').disabled).toBe(false)
  })
  it('refuses to bind controls to a response for another account', async () => {
    const f = model(); f.send.mockImplementationOnce(async () => ({ ...view(), accounts: [{ id: id(1), username: 'bobby', status: 'active' }] }))
    await f.boot()
    expect(hook('status').textContent).toContain('could not be read')
    expect(hook<HTMLButtonElement>('install').disabled).toBe(true)
  })
  it('removes only after a danger confirmation naming the fallback, then verifies the readback', async () => {
    const f = model(); await f.boot()
    f.ask.mockResolvedValueOnce(false); button('Remove').click(); await tick()
    expect(f.writes()).toEqual([])
    button('Remove').click(); await tick()
    expect(f.ask.mock.calls[1]![0]).toMatchObject({ danger: true })
    expect(String(f.ask.mock.calls[1]![0].body)).toContain('server default certificate')
    expect(f.writes()).toEqual([['DELETE', '/api/accounts/alice/certificates/' + id(3), { expectedRevision: 7 }]])
    expect(hook('status').dataset.state).toBe('saved')
    expect(hook('rows').textContent).toContain('No certificates are installed')
  })
  it('renews an installed ACME certificate in place with its identity and revision', async () => {
    const f = model(); await f.boot()
    button('Renew now').click(); await tick()
    expect(f.writes()).toEqual([['POST', '/api/accounts/alice/certificates', { domain: 'alice.test', certificateId: id(3), expectedRevision: 7 }]])
    expect(hook('status').dataset.state).toBe('saved')
  })
  it('uploads key, certificate and bundle as one chain, clears the key, and maps refusals without key text', async () => {
    const f = model(); await f.boot()
    hook<HTMLTextAreaElement>('key').value = 'mismatch'; hook<HTMLTextAreaElement>('cert').value = 'LEAF'; hook<HTMLTextAreaElement>('bundle').value = 'INTERMEDIATE'
    hook<HTMLButtonElement>('install').click(); await tick()
    expect(hook('status').textContent).toBe('The private key does not match the certificate.')
    expect(hook<HTMLTextAreaElement>('key').value).toBe('')
    hook<HTMLTextAreaElement>('key').value = 'KEY'
    hook<HTMLButtonElement>('install').click(); await tick()
    expect(f.writes()[1]).toEqual(['POST', '/api/accounts/alice/certificates/install', { domain: 'alice.test', expectedRevision: 7, fullchainPem: 'LEAF\nINTERMEDIATE\n', privateKeyPem: 'KEY' }])
    expect(hook('status').dataset.state).toBe('saved')
    expect([hook<HTMLTextAreaElement>('key').value, hook<HTMLTextAreaElement>('cert').value]).toEqual(['', ''])
    expect(button('Renew now').disabled).toBe(true)
  })
  it('falls back to a generic refusal for unknown reasons', () => {
    expect(accountSslRefusal({ details: { reason: 'other' } }, message => message)).toBe('The request was refused. Nothing was changed.')
    expect(accountSslRefusal({ details: { reason: 'chain_order' } }, message => message)).toMatch(/out of order/)
  })
})
