// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmSslWorkspace } from './board-port/whm-ssl-workspace.ts'
import { WHM_SSL_CLIENT_BINDING } from './whm-ssl-client.ts'
import type { SslWorkspaceView } from './whm-ssl-client.ts'
import { readSslObservationView } from './whm-ssl-observations-client.ts'

const id = (value: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(value).padStart(12, '0')
const workspace = (): SslWorkspaceView => ({ revision: 7, accounts: [{ id: id(1), username: 'alice', status: 'active' }],
  domains: [{ id: id(2), accountId: id(1), name: 'example.test', certificateId: id(3) }], certificates: [{ id: id(3), accountId: id(1), username: 'alice',
    names: ['example.test', 'www.example.test'], source: 'acme', challenge: 'http-01', notBefore: null, notAfter: '2028-01-01T00:00:00.000Z', autoRenew: true, fingerprintSha256: null, renewedAt: null, assignedDomains: ['example.test'] }],
  capabilities: { issue: true, renew: true, install: true, remove: true } })
const observation = () => ({ scope: 'authorized_saved_certificate_ids', inventoryComplete: false, accounts: [{ accountId: id(1), username: 'alice', state: 'observed', observation: {
  scope: 'authorized_saved_certificate_ids', inventoryComplete: false, rows: [{ certificateId: id(3), state: 'observed', order: { certificateId: id(3), names: ['example.test', 'www.example.test'], challenge: 'http-01', phase: 'issued', attempts: 2, nextRetryAt: '2026-10-26T12:20:00.000Z', updatedAt: '2026-10-26T12:00:00.000Z', failureRecorded: true, servedTlsVerified: false, lastError: '<img src=x onerror=alert(1)>PRIVATE-DIAGNOSTIC' } }] } }],
  managementTls: { state: 'observed', status: { recordedAt: '2026-10-26T12:00:00.000Z', status: 'tls-ready', expiresAt: '2027-01-01T00:00:00.000Z', historical: true, servedTlsVerified: false, renewalQualified: false, privateKeyPem: 'PRIVATE-KEY' }, timer: { state: 'observed', observation: { active: true, enabled: true, renewalQualified: false } } } })
const tick = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
let unload: EventListener[] = []
afterEach(() => { for (const listener of unload) window.removeEventListener('beforeunload', listener); unload = []; vi.restoreAllMocks(); document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
function model(options: { revisionDrift?: boolean; unavailable?: boolean; dnsOnly?: boolean; locale?: 'en' | 'ar'; observations?: () => unknown } = {}) {
  const view = workspace(); if (options.dnsOnly) view.certificates[0]!.challenge = 'dns-01'
  document.body.innerHTML = '<section data-whm-detail-route="/whm/ssl"' + (options.unavailable ? ' data-wiring="soon"' : '') + '>' + renderWhmSslWorkspace({ locale: options.locale ?? 'en', canManage: true })
    + '<button type="button" data-ssl-observations-refresh disabled>Read observations</button><table><tbody data-ssl-queue-rows></tbody></table><p data-ssl-queue-status></p><table><tbody data-ssl-order-log-rows></tbody></table><p data-ssl-order-log-status></p><p data-ssl-management-status></p></section>'
  let observationsRead = false
  const transport = vi.fn(async (_method: string, path: string) => { if (path.endsWith('/observations')) { observationsRead = true; return options.observations ? options.observations() : observation() }; return structuredClone({ ...view, revision: options.revisionDrift && observationsRead ? 8 : view.revision }) })
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, listener, args) => { if (name === 'beforeunload') unload.push(listener as EventListener); add(name, listener, args) })
  document.documentElement.lang = options.locale ?? 'en'; document.documentElement.dir = options.locale === 'ar' ? 'rtl' : 'ltr'
  new Function('return ' + WHM_SSL_CLIENT_BINDING)()(async () => true)
  return { transport, button: document.querySelector<HTMLButtonElement>('[data-ssl-observations-refresh]')! }
}

describe('WHM certificate observation client portable DOM contract', () => {
  it('projects only matching owned checkpoints and excludes arbitrary diagnostics or key fields', () => {
    const result = readSslObservationView(observation(), workspace())
    expect(result).toMatchObject({ inventoryComplete: false, inspected: 1, orders: [{ names: ['example.test', 'www.example.test'], nextRetryAt: '2026-10-26T12:20:00.000Z' }], management: { timer: { active: true, enabled: true } } })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-|lastError|privateKeyPem|<img/)
  })
  it('refuses foreign observations, changed SANs and fake served-TLS acknowledgements', () => {
    for (const mutate of [
      (value: ReturnType<typeof observation>) => { value.accounts[0]!.accountId = id(8) },
      (value: ReturnType<typeof observation>) => { value.accounts[0]!.observation.rows[0]!.certificateId = id(8) },
      (value: ReturnType<typeof observation>) => { value.accounts[0]!.observation.rows[0]!.order.names = ['foreign.test'] },
      (value: ReturnType<typeof observation>) => { value.accounts[0]!.observation.rows[0]!.order.servedTlsVerified = true },
    ]) { const value = observation(); mutate(value); expect(() => readSslObservationView(value, workspace())).toThrow() }
  })
  it.each(['en', 'ar'] as const)('renders human SSL observation dates in %s while retaining raw checkpoints and null states', async locale => {
    const value = observation(), order = value.accounts[0]!.observation.rows[0]!.order
    order.nextRetryAt = '2026-10-27T12:13:14.987Z'; order.updatedAt = '2026-10-27T10:11:12.456Z'
    value.managementTls.status.recordedAt = '2026-10-27T09:08:07.123Z'; value.managementTls.status.expiresAt = '2028-11-01T10:00:00.000Z'
    const rawBefore = JSON.stringify(value); let data: unknown = value
    const f = model({ locale, observations: () => data }); await tick(); f.button.click(); await tick()
    expect(document.querySelector('[data-ssl-queue-rows] tr:first-child td:nth-child(2) bdi')!.textContent).toBe('2026-10-27 12:13 UTC')
    expect(document.querySelector('[data-ssl-order-log-rows] tr:first-child td:first-child bdi')!.textContent).toBe('2026-10-27 10:11 UTC')
    const management = document.querySelector('[data-ssl-management-status]')!
    expect([...management.querySelectorAll('bdi[dir="ltr"]')].map(node => node.textContent)).toEqual(['2026-10-27 09:08 UTC', '2028-11-01 10:00 UTC'])
    expect(management.textContent).toContain(locale === 'ar' ? 'غير متحققين' : 'remain unverified')
    expect(management.textContent).toBe(locale === 'ar' ? 'سجل تاريخي لدورة إدارة TLS: سُجّلت جاهزية TLS، 2026-10-27 09:08 UTC؛ الانتهاء المحفوظ: 2028-11-01 10:00 UTC المؤقت نشط: نعم؛ مفعّل: نعم تبقى خدمة TLS الحالية ونجاح التجديد التلقائي غير متحققين.'
      : 'Historical management lifecycle record: TLS readiness reported, 2026-10-27 09:08 UTC; saved expiry: 2028-11-01 10:00 UTC Timer active: Yes; enabled: Yes Current served TLS and successful automatic renewal remain unverified.')
    expect(readSslObservationView(value, workspace()).orders[0]).toMatchObject({ nextRetryAt: order.nextRetryAt, updatedAt: order.updatedAt })
    expect(JSON.stringify(value)).toBe(rawBefore)
    const account = value.accounts[0]!, snapshot = account.observation, checkpoint = snapshot.rows[0]!
    const nullValue = { ...value, accounts: [{ ...account, observation: { ...snapshot, rows: [{ ...checkpoint, order: { ...checkpoint.order, nextRetryAt: null } }] } }], managementTls: { ...value.managementTls, status: { ...value.managementTls.status, expiresAt: null } } }
    data = nullValue; const nullBefore = JSON.stringify(nullValue); f.button.click(); await tick()
    expect(document.querySelector('[data-ssl-queue-rows] tr:first-child td:nth-child(2)')!.textContent).toBe(locale === 'ar' ? 'غير مسجل' : 'Not recorded')
    expect([...management.querySelectorAll('bdi[dir="ltr"]')].map(node => node.textContent)).toEqual(['2026-10-27 09:08 UTC'])
    expect(readSslObservationView(nullValue, workspace()).management.status?.expiresAt).toBeNull()
    expect(JSON.stringify(nullValue)).toBe(nullBefore)
    expect(f.transport.mock.calls.every(([method]) => method === 'GET')).toBe(true)
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('reads actual scoped checkpoints into preserved cards and only prepares renewal review', async () => {
    const f = model(); await tick(); f.button.click(); await tick()
    expect(document.querySelector('[data-ssl-queue-rows]')!.textContent).toContain('example.test')
    expect(document.querySelector('[data-ssl-queue-rows]')!.textContent).toContain('2026-10-26 12:20 UTC')
    expect(document.querySelector('[data-ssl-queue-status]')!.textContent).toContain('Partial inventory')
    expect(document.querySelector('[data-ssl-order-log-status]')!.textContent).toContain('not a complete renewal history')
    expect(document.querySelector('[data-ssl-management-status]')!.textContent).toContain('Historical management lifecycle record')
    expect(document.querySelector('[data-ssl-management-status]')!.textContent).toContain('remain unverified')
    expect(document.querySelector('img')).toBeNull(); expect(document.body.textContent).not.toContain('PRIVATE-')
    document.querySelector<HTMLButtonElement>('[data-ssl-queue-rows] button')!.click()
    expect(document.querySelector<HTMLSelectElement>('[data-ssl-renewal]')!.value).toBe(id(3))
    expect(f.transport.mock.calls.every(call => call[0] === 'GET')).toBe(true)
    expect(document.querySelector('[data-ssl-queue-rows]')!.textContent).not.toContain(id(3))
  })
  it('clears changed-scope observations and never retries an operation after revision drift', async () => {
    const f = model({ revisionDrift: true }); await tick(); f.button.click(); await tick()
    expect(document.querySelector('[data-ssl-queue-rows]')!.children).toHaveLength(0)
    expect(document.querySelector('[data-ssl-queue-status]')!.textContent).toContain('authorization changed')
    expect(f.transport.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
  it('keeps observation reads disabled under the same unavailable route admission', async () => {
    const f = model({ unavailable: true }); await tick(); expect(f.button.disabled).toBe(true)
    f.button.click(); await tick(); expect(f.transport).not.toHaveBeenCalled()
  })
  it('does not offer DNS-01 renewal through an endpoint that only connects HTTP-01', async () => {
    model({ dnsOnly: true }); await tick()
    expect(document.querySelector<HTMLButtonElement>('[data-ssl-renew]')!.disabled).toBe(true)
    expect(Array.from(document.querySelector<HTMLSelectElement>('[data-ssl-renewal]')!.options).map(option => option.value)).toEqual([''])
  })
})
