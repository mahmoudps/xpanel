// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmSslWorkspace } from './board-port/whm-ssl-workspace.ts'
import { readSslWorkspace, sslCoversHost, WHM_SSL_CLIENT_BINDING } from './whm-ssl-client.ts'

const id = (value: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(value).padStart(12, '0')
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const view = () => ({ revision: 7, accounts: [{ id: id(1), username: 'alice', status: 'active' }],
  domains: [{ id: id(2), accountId: id(1), name: 'example.test', certificateId: id(3) as string | null }, { id: id(4), accountId: id(1), name: 'www.example.test', certificateId: id(3) as string | null }],
  certificates: [{ id: id(3), accountId: id(1), username: 'alice', names: ['example.test', 'www.example.test'], source: 'acme', challenge: 'http-01' as 'http-01' | null, notBefore: null, notAfter: '2028-01-01T00:00:00.000Z', autoRenew: true, fingerprintSha256: null, renewedAt: null, assignedDomains: ['example.test', 'www.example.test'] }],
  capabilities: { issue: true, renew: true, install: true, remove: true } })
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const control = <T extends HTMLElement = HTMLButtonElement>(key: string) => document.querySelector<T>('[data-ssl-' + key + ']')!
let unload: EventListener[]

beforeEach(() => {
  unload = []
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, listener, options) => { if (name === 'beforeunload') unload.push(listener as EventListener); add(name, listener, options) })
  document.body.innerHTML = renderWhmSslWorkspace({ locale: 'en', canManage: true })
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})
afterEach(() => { for (const listener of unload) window.removeEventListener('beforeunload', listener); vi.restoreAllMocks(); document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })
const model = () => {
  let workspace = view(), mode = 'normal', keyWasCleared = false
  const send = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === 'GET') return clone(workspace)
    if (mode === 'denied') throw { status: 422, details: { stateChanged: false } }
    if (mode === 'unknown') throw { status: 503, details: { unknownOutcome: true } }
    workspace.revision++
    if (method === 'DELETE') {
      workspace.certificates = workspace.certificates.filter(certificate => certificate.id !== id(3)); workspace.domains.forEach(domain => { if (domain.certificateId === id(3)) domain.certificateId = null })
      return { ok: true, removedCertificateId: id(3) }
    }
    const input = body as Record<string, unknown>, manual = path.endsWith('/install')
    if (manual) keyWasCleared = control<HTMLTextAreaElement>('key').value === ''
    const saved = { ...view().certificates[0]!, id: manual || !input.certificateId ? id(5) : id(3), names: manual || !input.certificateId ? ['example.test'] : ['example.test', 'www.example.test'], notAfter: '2029-01-01T00:00:00.000Z', source: manual ? 'upload' : 'acme', challenge: manual ? null : 'http-01' as 'http-01' | null, autoRenew: !manual }
    workspace.certificates = [...workspace.certificates.filter(certificate => certificate.id !== saved.id), saved]; workspace.domains[0]!.certificateId = saved.id
    workspace.certificates.forEach(certificate => { certificate.assignedDomains = workspace.domains.filter(domain => domain.certificateId === certificate.id).map(domain => domain.name) })
    return { certificate: mode === 'wrong-ack' ? { ...saved, accountId: id(9) } : clone(saved) }
  })
  const ask = vi.fn(async (_options: Record<string, unknown>) => true)
  const boot = () => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + WHM_SSL_CLIENT_BINDING)()(ask) }
  return { send, ask, boot, writes: () => send.mock.calls.filter(call => call[0] !== 'GET'), setMode: (value: string) => { mode = value }, setWorkspace: (value: ReturnType<typeof view>) => { workspace = value }, keyWasCleared: () => keyWasCleared }
}

describe('WHM certificate workspace', () => {
  it('builds a self-contained text-only controller and retains all functional controls', () => {
    expect(() => new Function('return ' + WHM_SSL_CLIENT_BINDING)()).not.toThrow()
    expect(WHM_SSL_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_SSL_CLIENT_BINDING).not.toContain('fetch(')
    for (const key of ['search', 'account-filter', 'status-filter', 'refresh', 'account', 'domain', 'renewal', 'chain', 'key', 'issue', 'install']) expect(control(key)).not.toBeNull()
  })
  it('keeps controls disabled without a transport or when admission is unavailable', async () => {
    new Function('return ' + WHM_SSL_CLIENT_BINDING)()(undefined)
    expect(control('status').dataset.state).toBe('unavailable')
    document.querySelector<HTMLElement>('[data-whm-ssl]')!.removeAttribute('data-ssl-bound')
    document.querySelector<HTMLElement>('[data-whm-ssl]')!.dataset.sslCanManage = 'false'
    const f = model(); f.boot(); await tick()
    expect(f.send).not.toHaveBeenCalled(); expect(control<HTMLButtonElement>('issue').disabled).toBe(true)
  })
  it('validates scope, certificate identity, dates and explicit wildcard coverage', () => {
    expect(readSslWorkspace(view()).certificates[0]!.names).toEqual(['example.test', 'www.example.test'])
    expect(sslCoversHost(['*.example.test'], 'www.example.test')).toBe(true)
    expect(sslCoversHost(['*.example.test'], 'a.b.example.test')).toBe(false)
    const foreign = view(); foreign.certificates[0]!.accountId = id(9)
    expect(() => readSslWorkspace(foreign)).toThrow(/foreign/)
    const malformed = view(); malformed.certificates[0]!.names = ['<img src=x>']
    expect(() => readSslWorkspace(malformed)).toThrow(/names/)
    malformed.certificates[0]!.names = []
    expect(() => readSslWorkspace(malformed)).toThrow(/names/)
  })
  it.each(['en', 'ar'] as const)('renders human SSL inventory dates in %s while retaining raw validity data', async locale => {
    document.body.innerHTML = renderWhmSslWorkspace({ locale, canManage: true })
    const notBefore = '2026-10-27T10:11:12.123456Z', notAfter = '2028-11-01T10:13:14.567890Z', base = view()
    const payload = { ...base, certificates: [{ ...base.certificates[0]!, notBefore, notAfter }] }, rawBefore = JSON.stringify(payload)
    const send = vi.fn(async (_method: string, _path: string) => payload), ask = vi.fn(async () => false)
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    new Function('return ' + WHM_SSL_CLIENT_BINDING)()(ask); await tick()
    expect(control('rows').querySelector('tr:first-child td:nth-child(5) bdi')!.textContent).toBe('2028-11-01 10:13 UTC')
    const filter = control<HTMLSelectElement>('status-filter'); filter.value = 'later'; filter.dispatchEvent(new Event('change'))
    expect(control('rows').querySelectorAll('[data-ssl-renew]')).toHaveLength(1)
    filter.value = 'expired'; filter.dispatchEvent(new Event('change'))
    expect(control('rows').querySelectorAll('[data-ssl-renew]')).toHaveLength(0)
    filter.value = 'all'; filter.dispatchEvent(new Event('change'))
    control('rows').querySelector<HTMLButtonElement>('tr:first-child td:last-child button')!.click()
    const fact = (label: string) => [...control('facts').querySelectorAll('dt')].find(node => node.textContent === label)?.nextElementSibling?.querySelector('bdi[dir="ltr"]')
    expect(fact(locale === 'ar' ? 'بداية الصلاحية (UTC)' : 'Not before (UTC)')?.textContent).toBe('2026-10-27 10:11 UTC')
    expect(fact(locale === 'ar' ? 'الانتهاء (UTC)' : 'Expires (UTC)')?.textContent).toBe('2028-11-01 10:13 UTC')
    expect(readSslWorkspace(payload).certificates[0]).toMatchObject({ notBefore, notAfter })
    expect(JSON.stringify(payload)).toBe(rawBefore)
    expect(send.mock.calls.map(([method, path]) => [method, path])).toEqual([['GET', '/api/certificate-workspace']])
    expect(ask).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('reads saved metadata, filters rows and shows safe details without internal references', async () => {
    const f = model(); f.boot(); await tick()
    expect(control('status').dataset.state).toBe('read')
    expect(control('rows').textContent).toContain('alice')
    expect(control('rows').textContent).not.toContain(id(3))
    expect(control('rows').textContent).toContain('served TLS unverified')
    control<HTMLInputElement>('search').value = 'absent'; control('search').dispatchEvent(new Event('input'))
    expect(control('rows').textContent).toContain('No stored certificates')
    control<HTMLButtonElement>('clear-filters').click()
    Array.from(control('rows').querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Details')!.click()
    expect(control('detail').hidden).toBe(false); expect(control('facts').textContent).toContain('www.example.test')
    expect(control('facts').textContent).not.toContain(id(3))
  })
  it('renews through the actual account route while retaining every SAN and verifying saved binding', async () => {
    const f = model(); f.boot(); await tick()
    control<HTMLButtonElement>('renew').click(); control<HTMLButtonElement>('issue').click(); await tick(); await tick()
    expect(f.writes()).toHaveLength(1)
    expect(f.writes()[0]).toEqual(['POST', '/api/accounts/alice/certificates', { domain: 'example.test', expectedRevision: 7, certificateId: id(3) }])
    expect(control('status').dataset.state).toBe('saved')
    expect(control('rows').textContent).toContain('www.example.test')
  })
  it('installs through the real host-adapter contract and clears the submitted private key', async () => {
    const f = model(); f.boot(); await tick()
    control<HTMLTextAreaElement>('chain').value = 'synthetic-certificate-pem'
    control<HTMLTextAreaElement>('key').value = 'synthetic-private-key-pem'
    control<HTMLButtonElement>('install').click(); await tick(); await tick()
    expect(f.writes()[0]).toEqual(['POST', '/api/certificate-workspace/install', { username: 'alice', domain: 'example.test', expectedRevision: 7, fullchainPem: 'synthetic-certificate-pem', privateKeyPem: 'synthetic-private-key-pem' }])
    expect(f.keyWasCleared()).toBe(true)
    expect(control<HTMLTextAreaElement>('key').value).toBe('')
    expect(control('status').dataset.state).toBe('saved')
  })
  it('removes only the reviewed stored certificate after confirmation and verifies absence', async () => {
    const f = model(); f.boot(); await tick()
    control<HTMLButtonElement>('remove').click(); await tick(); await tick()
    expect(f.writes()[0]).toEqual(['DELETE', '/api/certificate-workspace/' + id(3), { expectedRevision: 7 }])
    expect(control('status').dataset.state).toBe('saved'); expect(control('rows').textContent).toContain('No stored certificates')
    expect(f.ask.mock.calls[0]![0]).toMatchObject({ danger: true })
  })
  it('cancels issue, remove and install without another read, write or lost upload draft', async () => {
    const f = model(); f.ask.mockResolvedValue(false); f.boot(); await tick()
    control<HTMLTextAreaElement>('chain').value = 'synthetic-certificate-pem'; control<HTMLTextAreaElement>('key').value = 'synthetic-private-key-pem'
    const initialCalls = f.send.mock.calls.length
    for (const key of ['issue', 'remove', 'install']) { control<HTMLButtonElement>(key).click(); await tick() }
    expect(f.ask).toHaveBeenCalledTimes(3); expect(f.send.mock.calls).toHaveLength(initialCalls)
    expect(control<HTMLTextAreaElement>('key').value).toBe('synthetic-private-key-pem')
  })
  it('preserves and locks a stale upload draft until an explicit reload', async () => {
    const f = model(); f.boot(); await tick()
    control<HTMLTextAreaElement>('chain').value = 'synthetic-certificate-pem'; control<HTMLTextAreaElement>('key').value = 'synthetic-private-key-pem'
    f.setWorkspace({ ...view(), revision: 8 }); control<HTMLButtonElement>('install').click(); await tick(); await tick()
    expect(f.writes()).toHaveLength(0); expect(control('status').dataset.state).toBe('stale')
    expect(control<HTMLTextAreaElement>('key').value).toBe('synthetic-private-key-pem')
    expect(control<HTMLButtonElement>('issue').disabled).toBe(true)
    f.ask.mockResolvedValue(false); control<HTMLButtonElement>('refresh').click(); await tick()
    expect(control('status').dataset.state).toBe('stale')
    f.ask.mockResolvedValue(true); control<HTMLButtonElement>('refresh').click(); await tick(); await tick()
    expect(control('status').dataset.state).toBe('read'); expect(control<HTMLTextAreaElement>('key').value).toBe('')
  })
  it.each(['unknown', 'wrong-ack'])('locks after %s without retrying or erasing an unrelated upload draft', async mode => {
    const f = model(); f.boot(); await tick(); f.setMode(mode)
    control<HTMLTextAreaElement>('chain').value = 'unrelated-upload-draft'
    control<HTMLButtonElement>('issue').click(); await tick(); await tick()
    expect(control('status').dataset.state).toBe('uncertain'); expect(f.writes()).toHaveLength(1)
    expect(control<HTMLButtonElement>('issue').disabled).toBe(true)
    expect(control<HTMLTextAreaElement>('chain').value).toBe('unrelated-upload-draft')
  })
  it('keeps a definite refusal editable without automatic retry', async () => {
    const f = model(); f.boot(); await tick(); f.setMode('denied')
    control<HTMLButtonElement>('issue').click(); await tick(); await tick()
    expect(control('status').dataset.state).toBe('failed'); expect(control<HTMLButtonElement>('issue').disabled).toBe(false)
    expect(f.writes()).toHaveLength(1)
  })
})
