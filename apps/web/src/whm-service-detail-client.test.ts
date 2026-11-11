// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmServiceDetailWorkspace } from './board-port/whm-service-detail-workspace.ts'
import { renderV2WhmServiceDetail } from './themes/v2/pages/xwhm/service-tools/details.ts'
import { isolateClientValues, translator } from './i18n.ts'
import type { WhmServiceDetailKind } from './board-port/whm-service-detail-workspace.ts'
import { readServiceDetailView, readZoneCheckView, WHM_SERVICE_DETAIL_CLIENT_BINDING } from './whm-service-detail-client.ts'

const tick = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const at = '2026-10-27T10:00:00.000Z'
const service = (id: string, state = 'active') => ({ id, label: id, unit: id + '.service', state })
const dns = (overrides: Record<string, unknown> = {}) => ({ kind: 'dns', observedAt: at, service: service('pdns'), control: { state: 'reachable', version: '4.8.3' }, zoneDir: '/var/lib/powerdns/zones', directory: 'read', savedState: 'read', otherEntries: 0, truncated: false,
  zones: [{ zone: 'example.com', desired: true, stateSerial: 2026102701, file: 'parsed', fileSerial: 2026102702, sizeBytes: 2048 }, { zone: 'missing.org', desired: true, stateSerial: 7, file: 'missing', fileSerial: null, sizeBytes: null },
    { zone: 'stray.net', desired: false, stateSerial: null, file: 'malformed', fileSerial: null, sizeBytes: 12 }], ...overrides })
const ftp = () => ({ kind: 'ftp', observedAt: at, service: service('pure-ftpd'), confDir: '/etc/pure-ftpd/conf', ftpAccounts: 3,
  settings: [{ name: 'TLS', desired: '2', observed: '2', state: 'match' }, { name: 'PassivePortRange', desired: '30000 35000', observed: '30000 35000', state: 'match' }, { name: 'NoAnonymous', desired: 'yes', observed: 'no', state: 'drift' }, { name: 'PureDB', desired: '/etc/pure-ftpd/pureftpd.pdb', observed: null, state: 'missing' }] })
const cert = { subject: 'CN=panel.example.test', issuer: 'CN=Test CA', names: ['panel.example.test', 'whm.panel.example.test'], notBefore: '2026-10-01T00:00:00.000Z', notAfter: '2026-11-10T00:00:00.000Z', daysLeft: 13, fingerprint256: Array.from({ length: 32 }, () => 'AB').join(':'), chainLength: 1, coversHostname: true }
const certificates = () => ({ kind: 'certificates', observedAt: at, hostname: 'panel.example.test', endpoints: [
  { id: 'panel', ports: [443, 2083, 2087, 2096], configPath: '/etc/nginx/conf.d/xpanel-management.conf', state: 'observed', reason: null, certPath: '/etc/xpanel/management-certificates/' + 'a'.repeat(64) + '/fullchain.pem', keyPath: '/etc/xpanel/management-certificates/' + 'a'.repeat(64) + '/privkey.pem', keyPresent: true, certificate: cert, warnings: ['expiring'] },
  { id: 'postfix', ports: [], configPath: null, state: 'not-rendered', reason: null, certPath: null, keyPath: null, keyPresent: null, certificate: null, warnings: [] }] })
const views: Record<WhmServiceDetailKind, () => unknown> = { dns, ftp, certificates }
const status = () => document.querySelector<HTMLElement>('[data-whm-service-detail-status]')!
const banner = () => document.querySelector<HTMLElement>('[data-whm-service-detail-result]')!
const fact = (key: string) => document.querySelector(`[data-whm-service-detail-fact="${key}"]`)!.textContent
const rows = () => [...document.querySelectorAll<HTMLTableRowElement>('[data-whm-service-detail-rows] tr')]
const mount = (kind: WhmServiceDetailKind = 'dns', locale: 'en' | 'ar' = 'en', canRead = true, canRestart = true, capability = 'authorized') => { document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'; document.body.innerHTML = `<section data-whm-detail-route="/whm/services/${kind}" data-capability-state="${capability}">${renderWhmServiceDetailWorkspace({ kind, locale, canRead, canRestart })}</section>` }
const boot = (request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: (options: Record<string, unknown>) => Promise<unknown>) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_SERVICE_DETAIL_CLIENT_BINDING)()(ask)
}
beforeEach(() => { mount(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('service detail client parsers', () => {
  it('accepts projected views and drops unknown fields', () => {
    expect(JSON.stringify(readServiceDetailView('dns', { ...dns(), extra: 'x', zones: dns().zones.map(row => ({ ...row, content: 'zone body' })) }))).not.toMatch(/zone body|extra/)
    expect(readServiceDetailView('ftp', ftp()).kind).toBe('ftp')
    expect(JSON.stringify(readServiceDetailView('certificates', { ...certificates(), pem: 'BEGIN' }))).not.toContain('BEGIN')
    expect(readZoneCheckView({ zone: 'example.com', state: 'failed', records: 3, errors: 1, warnings: 0, messages: ['[Error] x'] }, 'example.com').errors).toBe(1)
  })
  it('refuses inconsistent views and zone checks', () => {
    const row = dns().zones[0]!
    for (const [kind, bad] of [['ftp', dns()], ['dns', dns({ savedState: 'unavailable' })], ['dns', dns({ zones: [{ ...row, fileSerial: null }] })], ['dns', dns({ zones: [row, row] })], ['dns', dns({ control: { state: 'unreachable', version: '1.2.3' } })],
      ['dns', dns({ service: { ...service('pdns'), unit: null } })], ['ftp', { ...ftp(), settings: [{ name: 'TLS', desired: '2', observed: '1', state: 'match' }] }],
      ['certificates', { ...certificates(), endpoints: [{ ...certificates().endpoints[0]!, certificate: null }] }], ['certificates', { ...certificates(), endpoints: [{ ...certificates().endpoints[0]!, warnings: ['ok'] }] }]] as const) {
      expect(() => readServiceDetailView(kind, bad)).toThrow()
    }
    for (const bad of [{ zone: 'other.net', state: 'passed', records: 1, errors: 0, warnings: 0, messages: [] }, { zone: 'example.com', state: 'passed', records: 1, errors: 2, warnings: 0, messages: [] }, { zone: 'example.com', state: 'unavailable', records: 1, errors: 0, warnings: 0, messages: [] }]) {
      expect(() => readZoneCheckView(bad, 'example.com')).toThrow()
    }
  })
})

describe('service detail client binding', () => {
  it('sends no unsafe method and keeps every control inert without transport, root or a qualified host', async () => {
    boot(); expect(status().dataset.state).toBe('unavailable')
    for (const [canRead, capability] of [[false, 'authorized'], [true, 'unavailable']] as const) {
      for (const kind of ['dns', 'ftp', 'certificates'] as const) {
        mount(kind, 'en', canRead, true, capability); const send = vi.fn(); boot(send); await tick()
        // A read-only frame may read saved values; it never sends an unsafe method.
        if (canRead) expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
        else { expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable') }
        for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, textarea, button')) expect(control.disabled).toBe(true)
        expect(document.querySelector('form')).toBeNull()
      }
    }
    expect(WHM_SERVICE_DETAIL_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_SERVICE_DETAIL_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('paints the DNS service, zone rows and filters with technical values isolated', async () => {
    const send = vi.fn(async () => dns())
    boot(send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/services/dns')
    expect(status().dataset.state).toBe('read')
    expect([fact('unit'), fact('state'), fact('control'), fact('version'), fact('zone-dir'), fact('rendered'), fact('present'), fact('observed-at')]).toEqual(['pdns.service', 'Running', 'Answering (rping)', '4.8.3', '/var/lib/powerdns/zones', '2', '2', '2026-10-27 10:00 UTC'])
    expect(rows()).toHaveLength(3)
    expect(rows()[0]!.querySelector('bdi[dir="ltr"]')!.textContent).toBe('example.com')
    expect(rows()[0]!.textContent).toContain('2026102702')
    expect(rows()[0]!.textContent).toContain('\u20662.00\u00a0KiB\u2069')
    expect(rows()[2]!.textContent).toContain('Not in saved state')
    expect(rows()[2]!.textContent).toContain('Not rendered by xPanel')
    expect(document.querySelectorAll('[data-whm-service-detail-check-zone]')).toHaveLength(2)
    expect(document.querySelector<HTMLButtonElement>('[data-whm-service-detail-restart]')!.disabled).toBe(false)
    const state = document.querySelector<HTMLSelectElement>('[data-whm-service-detail-filter="state"]')!
    state.value = 'attention'; state.dispatchEvent(new Event('change')); expect(rows().map(row => row.querySelector('bdi')!.textContent)).toEqual(['missing.org', 'stray.net'])
    state.value = 'unmanaged'; state.dispatchEvent(new Event('change')); expect(rows()).toHaveLength(1)
    state.value = ''; state.dispatchEvent(new Event('change'))
    const text = document.querySelector<HTMLInputElement>('[data-whm-service-detail-filter="text"]')!
    text.value = 'nomatch'; text.dispatchEvent(new Event('input')); expect(rows()[0]!.textContent).toContain('No zones match the filters.')
  })
  it('runs a read-only zone check and reports failures and refusals truthfully', async () => {
    let reply: () => unknown = () => ({ zone: 'example.com', observedAt: at, state: 'failed', records: 3, errors: 1, warnings: 0, messages: ['[Error] CNAME at apex'] })
    const send = vi.fn(async (_method: string, path: string) => path.includes('zone-check') ? reply() : dns())
    boot(send); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-service-detail-check-zone="example.com"]')!.click(); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/services/dns/zone-check?zone=example.com')
    const check = document.querySelector<HTMLElement>('[data-whm-service-detail-check]')!
    expect(check.dataset.outcome).toBe('failed'); expect(check.textContent).toBe('example.com failed pdnsutil check-zone: 3 records, 1 errors, 0 warnings.')
    expect(document.querySelector('[data-whm-service-detail-check-messages]')!.textContent).toBe('[Error] CNAME at apex')
    reply = () => ({ zone: 'example.com', observedAt: at, state: 'passed', records: 3, errors: 0, warnings: 0, messages: [] })
    document.querySelector<HTMLButtonElement>('[data-whm-service-detail-check-zone="example.com"]')!.click(); await tick()
    expect(check.dataset.outcome).toBe('passed'); expect(document.querySelector<HTMLElement>('[data-whm-service-detail-check-messages]')!.hidden).toBe(true)
    reply = () => { throw Object.assign(new Error('missing'), { status: 404 }) }
    document.querySelector<HTMLButtonElement>('[data-whm-service-detail-check-zone="example.com"]')!.click(); await tick()
    expect(check.textContent).toContain('not rendered by xPanel; nothing was checked')
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
  it('paints the FTP policy against host files and the saved account count', async () => {
    mount('ftp'); boot(async () => ftp()); await tick()
    expect([fact('tls'), fact('passive'), fact('accounts'), fact('conf-dir')]).toEqual(['Required / Required', '30000-35000 / 30000-35000', '3', '/etc/pure-ftpd/conf'])
    expect(rows().map(row => row.lastElementChild!.textContent)).toEqual(['Matches', 'Matches', 'Differs', 'Not present'])
    expect(rows()[2]!.querySelectorAll('bdi[dir="ltr"]')).toHaveLength(3)
  })
  it('paints certificate endpoints, warnings and key presence without key contents', async () => {
    mount('certificates'); boot(async () => certificates()); await tick()
    expect([fact('hostname'), fact('observed'), fact('warnings')]).toEqual(['panel.example.test', '1 / 1', '1'])
    const panel = document.querySelector<HTMLTableRowElement>('tr[data-endpoint="panel"]')!
    expect(panel.textContent).toContain('443, 2083, 2087, 2096')
    expect(panel.textContent).toContain('panel.example.test, whm.panel.example.test')
    expect(panel.textContent).toContain('Present (not read)')
    expect(panel.textContent).toContain('Expires within 30 days')
    expect(panel.textContent).toContain('2026-11-10 00:00 UTC')
    expect(document.querySelector('tr[data-endpoint="postfix"]')!.textContent).toContain('xPanel does not render a certificate path for this service.')
    expect(document.querySelector('[data-whm-service-detail-restart]')).toBeNull()
  })
  it('restarts only after confirmation and confirms only from a fresh read', async () => {
    let state = 'active'
    const send = vi.fn(async (method: string, path: string) => method === 'POST' ? { service: service('pdns', state) } : path === '/api/server/services/dns' ? dns({ service: service('pdns', state) }) : null)
    const ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-service-detail-restart]')!.click(); await tick()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ danger: true, body: expect.stringContaining('DNS answers stop until it is back') }))
    expect(send).toHaveBeenCalledWith('POST', '/api/server/services/pdns/restart', {})
    expect(banner().dataset.outcome).toBe('confirmed')
    state = 'failed'
    document.querySelector<HTMLButtonElement>('[data-whm-service-detail-restart]')!.click(); await tick()
    expect(banner().dataset.outcome).toBe('unknown'); expect(banner().getAttribute('role')).toBe('alert')
  })
  it('sends nothing when the restart is cancelled or no dialog exists, and reports refusals', async () => {
    mount('ftp'); const send = vi.fn(async (_method: string, _path: string) => ftp()); boot(send, async () => false); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-service-detail-restart="pure-ftpd"]')!.click(); await tick()
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true); expect(banner().dataset.outcome).toBe('cancelled')
    mount('ftp'); const second = vi.fn(async (_method: string, _path: string) => ftp()); boot(second); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-service-detail-restart]')!.click(); await tick()
    expect(second.mock.calls.every(call => call[0] === 'GET')).toBe(true); expect(banner().textContent).toContain('confirmation is unavailable')
    mount('ftp'); boot(async (method: string) => method === 'POST' ? Promise.reject(Object.assign(new Error('nope'), { status: 412, details: { stateChanged: false } })) : ftp(), async () => true); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-service-detail-restart]')!.click(); await tick()
    expect(banner().dataset.outcome).toBe('refused')
    mount('ftp'); boot(async (method: string) => method === 'POST' ? Promise.reject(Object.assign(new Error('lost'), { status: 503 })) : ftp(), async () => true); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-service-detail-restart]')!.click(); await tick()
    expect(banner().dataset.outcome).toBe('unknown')
  })
  it('shows a failed read without inventing values', async () => {
    boot(async () => { throw new Error('down') }); await tick()
    expect(status().dataset.state).toBe('failed'); expect(status().getAttribute('role')).toBe('alert')
    expect(fact('state')).toBe('Not read')
    expect(document.querySelector<HTMLButtonElement>('[data-whm-service-detail-restart]')!.disabled).toBe(true)
    mount(); boot(async () => ({ ...dns(), kind: 'ftp' })); await tick()
    expect(status().dataset.state).toBe('failed')
  })
  it('renders Arabic copy with ASCII digits', async () => {
    for (const kind of ['dns', 'ftp', 'certificates'] as const) {
      mount(kind, 'ar'); boot(async () => views[kind]()); await tick()
      expect(status().textContent).toBe('قُرئت من المضيف. لم يُغيّر شيء.')
      expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    }
    expect(document.querySelector('tr[data-endpoint="panel"]')!.textContent).toContain('موجود (لم يُقرأ)')
    mount('dns', 'ar'); boot(async (_method: string, path: string) => path.includes('zone-check') ? { zone: 'example.com', observedAt: at, state: 'failed', records: 3, errors: 1, warnings: 0, messages: [] } : dns()); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-service-detail-check-zone="example.com"]')!.click(); await tick()
    expect(document.querySelector('[data-whm-service-detail-check]')!.textContent).toBe('لم تجتز المنطقة \u2066example.com\u2069 فحص pdnsutil check-zone: السجلات 3، الأخطاء 1، التحذيرات 0.')
  })
})

describe('service detail full timestamp display', () => {
  it.each(['en', 'ar'] as const)('preserves complete observation and certificate expiry instants in %s', async locale => {
    const observedAt = '2026-10-27T10:00:09.987Z', notAfter = '2026-11-10T00:00:08.654Z'
    const payload = { ...certificates(), observedAt, endpoints: certificates().endpoints.map(endpoint => endpoint.id === 'panel' ? { ...endpoint, certificate: { ...cert, notAfter } } : endpoint) }
    const canonicalPayload = JSON.stringify(payload)
    const send = vi.fn(async (_method: string, _path: string) => payload)
    mount('certificates', locale); boot(send); await tick()
    expect(status().dataset.state).toBe('read')
    expect(fact('observed-at')).toBe('2026-10-27 10:00 UTC')
    const observation = document.querySelector('[data-whm-service-detail-fact="observed-at"]')!
    expect(observation.getAttribute('dir')).toBe('ltr')
    const expiry = document.querySelector('tr[data-endpoint="panel"] td:nth-child(6) bdi')!
    expect(expiry.textContent).toBe('2026-11-10 00:00 UTC')
    expect(expiry.getAttribute('dir')).toBe('ltr')
    expect(JSON.stringify(payload)).toBe(canonicalPayload)
    expect(send.mock.calls.map(([method]) => method)).toEqual(['GET'])
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})


type ServiceTheme = 'classic' | 'v2'
const mountServiceTheme = (theme: ServiceTheme, kind: WhmServiceDetailKind = 'dns', locale: 'en' | 'ar' = 'en', canRead = true, canRestart = true): void => {
  if (theme === 'classic') { mount(kind, locale, canRead, canRestart); return }
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = renderV2WhmServiceDetail({ locale, principal: { kind: 'root', id: 'fixture-root', username: 'operator' }, dataAuthority: { canRead, canManage: canRestart } }, kind)
}
const dnsPrototype = (): HTMLTemplateElement => document.querySelector<HTMLTemplateElement>('template[data-xp-template="whm-service-check-zone"]')!
const servicePrototypeFaults = ['missing', 'duplicate', 'wrong-root', 'missing-slot', 'duplicate-slot', 'unknown-slot', 'wrong-slot-tag', 'enabled', 'submit'] as const
const damageDnsPrototype = (fault: typeof servicePrototypeFaults[number]): void => {
  const template = dnsPrototype(); expect(template).not.toBeNull()
  const button = template.content.firstElementChild as HTMLButtonElement
  if (fault === 'missing') { template.remove(); return }
  if (fault === 'duplicate') { template.after(template.cloneNode(true)); return }
  if (fault === 'wrong-root') { const span = document.createElement('span'); span.dataset.xpSlot = 'content'; button.replaceWith(span); return }
  if (fault === 'missing-slot') button.removeAttribute('data-xp-slot')
  if (fault === 'duplicate-slot') { const span = document.createElement('span'); span.dataset.xpSlot = 'content'; button.append(span) }
  if (fault === 'unknown-slot') button.dataset.xpSlot = 'unreviewed'
  if (fault === 'wrong-slot-tag') { button.removeAttribute('data-xp-slot'); const span = document.createElement('span'); span.dataset.xpSlot = 'content'; button.append(span) }
  if (fault === 'enabled') button.disabled = false
  if (fault === 'submit') button.type = 'submit'
}

describe.each(['classic', 'v2'] as const)('%s DNS finite button contract', theme => {
  it.each(['en', 'ar'] as const)('clones the selected %s theme button and preserves the read-only check payload', async locale => {
    mountServiceTheme(theme, 'dns', locale)
    const prototype = dnsPrototype().content.firstElementChild as HTMLButtonElement
    expect(prototype.type).toBe('button'); expect(prototype.disabled).toBe(true)
    expect(prototype.classList.contains(theme === 'classic' ? 'xp-btn' : 'v2-btn')).toBe(true)
    expect(document.querySelector('[data-whm-service-detail-check-zone]')).toBeNull()
    const send = vi.fn(async (_method: string, path: string) => path.includes('zone-check') ? { zone: 'example.com', observedAt: at, state: 'passed', records: 3, errors: 0, warnings: 0, messages: [] } : dns())
    boot(send); await tick()
    const button = document.querySelector<HTMLButtonElement>('[data-whm-service-detail-check-zone="example.com"]')!
    expect(button.className).toBe(prototype.className)
    expect(button.textContent).toBe(translator(locale)('Check zone'))
    expect(button.getAttribute('aria-label')).toBe(translator(locale)('Check zone {zone}', isolateClientValues(locale, { zone: 'example.com' })))
    expect(button.type).toBe('button'); expect(button.disabled).toBe(false); expect(prototype.disabled).toBe(true)
    if (theme === 'v2') expect(button.classList.contains('xp-btn')).toBe(false)
    button.click(); await tick()
    expect(send.mock.calls).toEqual([['GET', '/api/server/services/dns'], ['GET', '/api/server/services/dns/zone-check?zone=example.com']])
    expect(document.querySelector<HTMLElement>('[data-whm-service-detail-check]')!.dataset.outcome).toBe('passed')
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it.each(servicePrototypeFaults)('blocks the initial GET for a %s prototype', async fault => {
    mountServiceTheme(theme); damageDnsPrototype(fault)
    const send = vi.fn(), ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    expect(send).not.toHaveBeenCalled(); expect(ask).not.toHaveBeenCalled()
    expect(status().dataset.state).toBe('unavailable')
    expect([...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')].every(control => control.disabled)).toBe(true)
    expect(fact('state')).toBe('Not read')
  })
  it('retains independent read authority without restart authority', async () => {
    mountServiceTheme(theme, 'dns', 'en', true, false)
    const send = vi.fn(async (_method: string, _path: string) => dns()), ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    const restart = document.querySelector<HTMLButtonElement>('[data-whm-service-detail-restart]')!
    expect(restart.disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-whm-service-detail-check-zone]')!.disabled).toBe(false)
    restart.disabled = false; restart.click(); await tick()
    expect(ask).not.toHaveBeenCalled(); expect(send.mock.calls).toEqual([['GET', '/api/server/services/dns']])
  })
  it.each(['resolved', 'rejected'] as const)('locks a prototype lost during a %s initial read', async settlement => {
    mountServiceTheme(theme)
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void
    const send = vi.fn((_method: string, _path: string) => new Promise<unknown>((yes, no) => { resolve = yes; reject = no }))
    boot(send); await tick(); expect(send).toHaveBeenCalledOnce()
    dnsPrototype().remove()
    if (settlement === 'resolved') resolve(dns()); else reject(new Error('unavailable'))
    await tick()
    expect(status().dataset.state).toBe('unavailable'); expect(fact('state')).toBe('Not read')
    expect(document.querySelector('[data-whm-service-detail-check-zone]')).toBeNull()
    const refresh = document.querySelector<HTMLButtonElement>('[data-whm-service-detail-refresh]')!
    expect(refresh.disabled).toBe(true); refresh.disabled = false; refresh.click(); await tick()
    expect(send).toHaveBeenCalledOnce()
  })
  it('refuses a late zone result and further checks after prototype loss', async () => {
    mountServiceTheme(theme)
    let resolve!: (value: unknown) => void
    const send = vi.fn(async (_method: string, path: string) => path.includes('zone-check') ? new Promise<unknown>(yes => { resolve = yes }) : dns())
    boot(send); await tick()
    const button = document.querySelector<HTMLButtonElement>('[data-whm-service-detail-check-zone="example.com"]')!
    button.click(); await tick(); expect(send).toHaveBeenCalledTimes(2)
    dnsPrototype().remove(); resolve({ zone: 'example.com', observedAt: at, state: 'passed', records: 3, errors: 0, warnings: 0, messages: [] }); await tick()
    expect(status().dataset.state).toBe('unavailable')
    expect(document.querySelector<HTMLElement>('[data-whm-service-detail-check]')!.dataset.outcome).not.toBe('passed')
    expect(button.disabled).toBe(true)
    button.disabled = false; button.click(); await tick(); expect(send).toHaveBeenCalledTimes(2)
  })
  it('sends no restart or readback after prototype loss while confirmation is pending', async () => {
    mountServiceTheme(theme)
    let confirm!: (value: boolean) => void
    const ask = vi.fn(() => new Promise<boolean>(yes => { confirm = yes }))
    const send = vi.fn(async (_method: string, _path: string) => dns())
    boot(send, ask); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-service-detail-restart]')!.click(); await tick()
    expect(ask).toHaveBeenCalledOnce(); dnsPrototype().remove(); confirm(true); await tick()
    expect(send.mock.calls).toEqual([['GET', '/api/server/services/dns']])
    expect(status().dataset.state).toBe('unavailable')
    expect(document.querySelector<HTMLButtonElement>('[data-whm-service-detail-restart]')!.disabled).toBe(true)
  })
  it.each(['ftp', 'certificates'] as const)('keeps %s independent of the DNS-only prototype', async kind => {
    mountServiceTheme(theme, kind); expect(dnsPrototype()).toBeNull()
    document.querySelector('[data-whm-service-detail-workspace]')!.insertAdjacentHTML('beforeend', '<template data-xp-template="whm-service-check-zone"><div>unrelated malformed prototype</div></template>')
    const send = vi.fn(async (_method: string, _path: string) => views[kind]())
    boot(send); await tick()
    expect(status().dataset.state).toBe('read'); expect(send.mock.calls).toEqual([['GET', '/api/server/services/' + kind]])
    expect(document.querySelector('[data-whm-service-detail-check-zone]')).toBeNull()
  })
})
