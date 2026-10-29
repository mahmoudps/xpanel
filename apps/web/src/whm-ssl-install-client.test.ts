// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmSslInstallChoices, renderWhmSslInstallWorkspace } from './board-port/whm-ssl-install-workspace.ts'
import { readSslInstallResult, readSslInstallWorkspace, sslInstallStructure, WHM_SSL_INSTALL_CLIENT_BINDING } from './whm-ssl-install-client.ts'

const id = (value: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(value).padStart(12, '0')
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const block = (label: string) => `-----BEGIN ${label}-----\nMIIBportable\n-----END ${label}-----\n`
const view = () => ({ revision: 7, accounts: [{ id: id(1), username: 'alice', status: 'active' }, { id: id(2), username: 'bob', status: 'active' }],
  domains: [{ id: id(11), accountId: id(1), name: 'example.test', certificateId: null as string | null }, { id: id(12), accountId: id(1), name: 'shop.test', certificateId: null as string | null },
    { id: id(13), accountId: id(2), name: 'bob.test', certificateId: null as string | null }],
  certificates: [] as Record<string, unknown>[], capabilities: { issue: true, renew: true, install: true, remove: true } })
const saved = { id: id(5), accountId: id(1), username: 'alice', names: ['example.test', 'www.example.test'], source: 'upload', challenge: null, notBefore: '2026-01-01T00:00:00.000Z',
  notAfter: '2027-12-31T00:00:00.000Z', autoRenew: false, fingerprintSha256: 'b'.repeat(64), renewedAt: null, assignedDomains: ['example.test'] }
const tick = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const control = <T extends HTMLElement = HTMLButtonElement>(key: string) => document.querySelector<T>('[data-ssl-install-' + key + ']')!
const type = (key: string, value: string) => { const area = control<HTMLTextAreaElement>(key); area.value = value; area.dispatchEvent(new Event('input')) }
let unload: EventListener[]
const page = (locale: 'en' | 'ar' = 'en', canManage = true) => { document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'; document.body.innerHTML = `<section data-whm-detail-route="/whm/ssl/install">${renderWhmSslInstallWorkspace({ locale, canManage })}${renderWhmSslInstallChoices({ locale })}</section>` }

beforeEach(() => {
  unload = []
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, listener, options) => { if (name === 'beforeunload') unload.push(listener as EventListener); add(name, listener, options) })
  page()
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})
afterEach(() => { for (const listener of unload) window.removeEventListener('beforeunload', listener); vi.restoreAllMocks(); document.body.replaceChildren() })
const model = (resultCertificate = saved) => {
  let workspace = view(), mode = 'normal', keyAtSend: string | null = null
  const send = vi.fn(async (method: string, _path: string, _body?: unknown) => {
    if (method === 'GET') return clone(workspace)
    keyAtSend = control<HTMLTextAreaElement>('key').value
    if (mode === 'refused') throw Object.assign(new Error('the private key does not match the site certificate'), { status: 422, code: 'VALIDATION', details: { stateChanged: false, reason: 'key_mismatch' } })
    if (mode === 'unknown') throw Object.assign(new Error('certificate files or configuration require verification'), { status: 503, details: { stateChanged: true, unknownOutcome: true } })
    workspace.revision++; workspace.certificates = [clone(resultCertificate)]; workspace.domains[0]!.certificateId = resultCertificate.id
    return { certificate: mode === 'foreign-ack' ? { ...resultCertificate, accountId: id(2) } : clone(resultCertificate), reconcile: { status: 'applied', scope: 'global_configuration', targetVerified: false, generation: { id: 3, status: 'active', checksum: 'c'.repeat(64) } },
      application: { scope: 'stored_configuration', servedTlsVerified: false } }
  })
  const ask = vi.fn(async (_options: Record<string, unknown>) => true)
  const boot = () => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + WHM_SSL_INSTALL_CLIENT_BINDING)()(ask) }
  return { send, ask, boot, writes: () => send.mock.calls.filter(call => call[0] !== 'GET'), setMode: (value: string) => { mode = value }, setWorkspace: (value: ReturnType<typeof view>) => { workspace = value }, keyAtSend: () => keyAtSend }
}
const fill = (key = block('PRIVATE KEY')) => {
  const select = control<HTMLSelectElement>('domain'); select.value = id(11); select.dispatchEvent(new Event('change'))
  type('certificate', block('CERTIFICATE')); type('chain', block('CERTIFICATE')); type('key', key)
}

describe('WHM manual certificate installation client', () => {
  it('builds a self-contained text-only controller', () => {
    expect(() => new Function('return ' + WHM_SSL_INSTALL_CLIENT_BINDING)()).not.toThrow()
    expect(WHM_SSL_INSTALL_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_SSL_INSTALL_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('stays inert without a transport or management capability', async () => {
    new Function('return ' + WHM_SSL_INSTALL_CLIENT_BINDING)()(undefined)
    expect(control('status').dataset.state).toBe('unavailable')
    page('en', false)
    const f = model(); f.boot(); await tick()
    expect(f.send).not.toHaveBeenCalled(); expect(control('submit').disabled).toBe(true); expect(control<HTMLTextAreaElement>('key').disabled).toBe(true)
  })
  it('lists authorized domains by account and the www and alias names to require', async () => {
    const f = model(); f.boot(); await tick()
    expect(control('status').dataset.state).toBe('read')
    expect(Array.from(control<HTMLSelectElement>('domain').querySelectorAll('optgroup')).map(group => group.label)).toEqual(['alice', 'bob'])
    const select = control<HTMLSelectElement>('domain'); select.value = id(11); select.dispatchEvent(new Event('change'))
    expect(Array.from(control('names').querySelectorAll<HTMLInputElement>('input')).map(input => input.value)).toEqual(['www.example.test', 'shop.test'])
    expect(document.querySelector('[data-ssl-install-step="2"]')!.getAttribute('aria-current')).toBe('step')
    expect(document.querySelector('[data-ssl-install-choice="domain"]')!.textContent).toBe('example.test (alice)')
  })
  it('keeps installation unavailable when the host adapter is not connected', async () => {
    const f = model(), workspace = view(); workspace.capabilities.install = false; f.setWorkspace(workspace); f.boot(); await tick()
    expect(control('status').dataset.state).toBe('unavailable')
    expect(control<HTMLSelectElement>('domain').disabled).toBe(true); expect(control<HTMLTextAreaElement>('certificate').disabled).toBe(true); expect(control('submit').disabled).toBe(true)
  })
  it('shows structural problems live and enables installation only for complete material', async () => {
    const f = model(); f.boot(); await tick()
    fill(block('ENCRYPTED PRIVATE KEY'))
    expect(control('checks').textContent).toContain('passphrase'); expect(control('submit').disabled).toBe(true)
    type('key', block('PRIVATE KEY') + block('PRIVATE KEY'))
    expect(control('checks').textContent).toContain('exactly one'); expect(control('submit').disabled).toBe(true)
    type('key', block('RSA PRIVATE KEY'))
    expect(control('checks').textContent).toContain('Structure is complete'); expect(control('submit').disabled).toBe(false)
    expect(document.querySelector('[data-ssl-install-choice="certificates"]')!.textContent).toBe('2')
    expect(document.querySelector('[data-ssl-install-choice="key"]')!.textContent).toBe('RSA')
    expect(f.writes()).toHaveLength(0)
  })
  it.each(['en', 'ar'] as const)('renders human SSL installation expiry in %s without changing its acknowledgement', async locale => {
    page(locale)
    const notAfter = '2028-11-01T10:13:14.567Z', resultCertificate = { ...saved, notAfter }, rawBefore = JSON.stringify(resultCertificate)
    const f = model(resultCertificate); f.boot(); await tick(); fill(); control('submit').click(); await tick()
    expect(control('status').dataset.state).toBe('saved')
    const expiry = [...control('facts').querySelectorAll('dt')].find(node => node.textContent === (locale === 'ar' ? 'الانتهاء (UTC)' : 'Expires (UTC)'))?.nextElementSibling?.querySelector('bdi[dir="ltr"]')
    expect(expiry?.textContent).toBe('2028-11-01 10:13 UTC')
    const posted = f.send.mock.calls.findIndex(([method]) => method === 'POST'), acknowledgement = await f.send.mock.results[posted]!.value
    expect(acknowledgement).toMatchObject({ certificate: { notAfter } })
    expect(JSON.stringify(resultCertificate)).toBe(rawBefore)
    expect(f.writes()).toHaveLength(1)
    expect(f.writes()[0]!.slice(0, 2)).toEqual(['POST', '/api/certificate-workspace/install'])
    expect(f.keyAtSend()).toBe('')
    expect(control('facts').textContent).toContain(locale === 'ar' ? 'غير متحققة' : 'Not verified')
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('confirms, clears the key before sending, verifies readback and reports stored versus applied state', async () => {
    const f = model(); f.boot(); await tick()
    fill(); control<HTMLInputElement>('names').querySelector<HTMLInputElement>('input[value="www.example.test"]')!.click()
    control('submit').click(); await tick()
    expect(f.ask).toHaveBeenCalledOnce()
    const [method, path, body] = f.writes()[0]!
    expect([method, path]).toEqual(['POST', '/api/certificate-workspace/install'])
    expect(body).toEqual({ username: 'alice', domain: 'example.test', expectedRevision: 7, fullchainPem: block('CERTIFICATE').trim() + '\n' + block('CERTIFICATE'), privateKeyPem: block('PRIVATE KEY'), requiredNames: ['www.example.test'] })
    expect(f.keyAtSend()).toBe('')
    expect(control('status').dataset.state).toBe('saved')
    expect(control('result').hidden).toBe(false)
    expect(control('facts').textContent).toContain('#3'); expect(control('facts').textContent).toContain('Not verified'); expect(control('facts').textContent).toContain('2027-12-31 00:00 UTC')
    expect(control<HTMLTextAreaElement>('certificate').value).toBe(''); expect(control<HTMLTextAreaElement>('chain').value).toBe('')
    expect(document.querySelector('[data-ssl-install-step="3"]')!.getAttribute('aria-current')).toBe('step')
  })
  it('shows a localized server refusal, clears the key and allows a corrected retry', async () => {
    const f = model(); f.setMode('refused'); f.boot(); await tick()
    fill(); control('submit').click(); await tick()
    expect(control('status').dataset.state).toBe('failed')
    expect(control('status').textContent).toContain('does not match the site certificate')
    expect(control<HTMLTextAreaElement>('key').value).toBe('')
    type('key', block('PRIVATE KEY')); expect(control('submit').disabled).toBe(false)
  })
  it('locks into review after an unknown outcome, a stale revision or a mismatched acknowledgement', async () => {
    for (const mode of ['unknown', 'foreign-ack']) {
      page(); const f = model(); f.setMode(mode); f.boot(); await tick()
      fill(); control('submit').click(); await tick()
      expect(control('status').dataset.state).toBe('uncertain'); expect(control('submit').disabled).toBe(true); expect(control<HTMLTextAreaElement>('certificate').disabled).toBe(true)
    }
    page(); const stale = model(); stale.boot(); await tick()
    fill(); const changed = view(); changed.revision = 8; stale.setWorkspace(changed)
    control('submit').click(); await tick()
    expect(control('status').dataset.state).toBe('stale'); expect(stale.writes()).toHaveLength(0)
    control('refresh').click(); await tick()
    expect(control('status').dataset.state).toBe('read')
  })
  it('renders Arabic status copy with ASCII digits only', async () => {
    page('ar'); const f = model(); f.boot(); await tick()
    expect(control('status').textContent).toContain('قُرئت النطاقات المستضافة')
    fill(); control('submit').click(); await tick()
    expect(control('status').textContent).toContain('حُفظت الشهادة')
    expect(control('facts').textContent).toContain('طُبّق في الجيل #3')
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
  })
  it('parses only authorized workspace data and truthful upload acknowledgements', () => {
    const foreign = view(); foreign.domains[0]!.accountId = id(9)
    expect(() => readSslInstallWorkspace(foreign)).toThrow(/foreign/)
    const ack = { certificate: saved, reconcile: { status: 'applied', generation: { id: 3, status: 'active' } }, application: { scope: 'stored_configuration', servedTlsVerified: false } }
    expect(readSslInstallResult(ack, { accountId: id(1), names: ['example.test', 'www.example.test'] }).reconcile).toEqual({ status: 'applied', generationId: 3 })
    expect(readSslInstallResult({ ...ack, reconcile: { status: 'noop' } }, { accountId: id(1), names: ['example.test'] }).reconcile.generationId).toBeNull()
    expect(() => readSslInstallResult({ ...ack, application: { scope: 'stored_configuration', servedTlsVerified: true } }, { accountId: id(1), names: ['example.test'] })).toThrow()
    expect(() => readSslInstallResult({ ...ack, reconcile: { status: 'applied' } }, { accountId: id(1), names: ['example.test'] })).toThrow()
    expect(() => readSslInstallResult(ack, { accountId: id(1), names: ['shop.test'] })).toThrow(/mismatch/)
    expect(() => readSslInstallResult({ ...ack, certificate: { ...saved, source: 'acme' } }, { accountId: id(1), names: ['example.test'] })).toThrow(/mismatch/)
  })
  it('checks PEM structure without cryptography', () => {
    expect(sslInstallStructure('', '', '').reasons).toEqual(['certificate_missing', 'key_missing'])
    expect(sslInstallStructure(block('CERTIFICATE'), '', block('EC PRIVATE KEY'))).toEqual({ reasons: [], certificates: 1, key: 'EC PRIVATE KEY' })
    expect(sslInstallStructure(block('CERTIFICATE'), block('PRIVATE KEY'), block('PRIVATE KEY')).reasons).toEqual(['certificate_format'])
    expect(sslInstallStructure('junk ' + block('CERTIFICATE'), '', block('PRIVATE KEY')).reasons).toEqual(['certificate_format'])
    expect(sslInstallStructure(block('CERTIFICATE').repeat(11), '', block('PRIVATE KEY')).reasons).toEqual(['too_large'])
    expect(sslInstallStructure(block('CERTIFICATE'), '', '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nMIIB\n-----END RSA PRIVATE KEY-----').reasons).toEqual(['key_encrypted'])
  })
})
