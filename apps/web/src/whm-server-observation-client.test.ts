// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmServerNetwork, renderWhmServerRole, renderWhmServerTimers } from './board-port/whm-server-observation-workspace.ts'
import { readServerNetworkView, readServerRoleView, readServerTimersView, WHM_SERVER_OBSERVATION_CLIENT_BINDING } from './whm-server-observation-client.ts'

const tick = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const at = '2026-10-27T10:00:00.000Z'
const read = <T>(items: T[]) => ({ state: 'read', reason: null, truncated: false, items })
const off = (reason = 'host_unavailable') => ({ state: 'unavailable', reason, truncated: false, items: [] })
const timers = () => ({ observedAt: at, timers: read([
  { unit: 'logrotate.timer', activates: ['logrotate.service'], next: '2026-10-28T00:00:00.000Z', last: '2026-10-27T00:00:00.123Z', owner: { kind: 'system' } },
  { unit: 'xpanel-cron-alice-backup.timer', activates: ['xpanel-cron-alice-backup.service'], next: '2026-10-27T11:00:00.000Z', last: null, owner: { kind: 'account-cron', username: 'alice', jobId: 'backup' } },
  { unit: 'xpanel-metrics.timer', activates: [], next: null, last: null, owner: { kind: 'panel' } },
]), cronDirectory: { state: 'read', reason: null, truncated: false, unlisted: 1, items: [{ name: 'e2scrub_all', kind: 'file' }] } })
const network = () => ({
  observedAt: at, hostname: { state: 'read', reason: null, value: 'web1' }, resolvers: { state: 'read', reason: null, value: ['192.0.2.53'], truncated: false },
  interfaces: read([{ name: 'eth0', operstate: 'UP', mtu: 1500, loopback: false, addresses: [{ family: 4, address: '192.0.2.10', prefixLength: 24, scope: 'global', dynamic: false }] }]),
  routes4: read([{ family: 4, destination: 'default', gateway: '192.0.2.1', device: 'eth0', protocol: 'dhcp', scope: null, source: null, metric: 100, type: null, nexthops: [] }]), routes6: off('command_failed'),
  saved: { state: 'read', hostname: 'web1.example.test' }, hostnameComparison: 'short-name',
  pool: [{ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', isPrimary: true, status: 'configured', observedInterface: 'eth0', observedPrefixLength: 24 },
    { address: '192.0.2.20', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'dedicated', isPrimary: false, status: 'missing', observedInterface: null, observedPrefixLength: null }],
  unpooled: [{ address: '198.51.100.7', family: 4, prefixLength: 32, interface: 'eth0' }],
})
const role = () => ({
  observedAt: at, services: read([{ id: 'nginx', label: 'nginx', unit: 'nginx.service', state: 'active' }, { id: 'postfix', label: 'Postfix', unit: null, state: 'not-installed' }]),
  saved: { state: 'read', hostname: 'web1.example.test', engine: 'apache', apacheMpm: 'itk', setupCompletedAt: '2026-10-01T00:00:00.000Z', phpVersions: ['8.3'], counts: { accounts: 2, domains: 3, phpDomains: 2, mailboxes: 1, databases: 0, zones: 1 } },
  components: [{ id: 'web-edge', value: 'nginx', count: null, services: ['nginx'] }, { id: 'web-backend', value: 'openlitespeed', count: null, services: [] }, { id: 'mail', value: null, count: 1, services: ['postfix', 'dovecot'] }],
})
const responses: Record<string, () => unknown> = { timers, network, role }
const renderers = { timers: renderWhmServerTimers, network: renderWhmServerNetwork, role: renderWhmServerRole }
const mount = (kind: keyof typeof renderers, locale: 'en' | 'ar' = 'en', canRead = true, wrapper = 'data-capability-state="authorized"') => {
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = `<section ${wrapper}>${renderers[kind]({ locale, canRead })}</section>`
}
const boot = (request?: (method: string, path: string) => Promise<unknown>) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_SERVER_OBSERVATION_CLIENT_BINDING)()()
}
const status = () => document.querySelector<HTMLElement>('[data-whm-server-observation-status]')!
const rows = (marker: string) => [...document.querySelectorAll<HTMLTableRowElement>(`[data-whm-server-observation-${marker}] tr`)]
const fact = (name: string) => document.querySelector(`[data-whm-server-observation-${name}]`)!.textContent
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('server observation client parsers', () => {
  it('accept projected observations and drop unknown fields', () => {
    expect(JSON.stringify(readServerTimersView({ ...timers(), secret: 'x' }))).not.toContain('secret')
    expect(readServerNetworkView(network()).pool[1]!.status).toBe('missing')
    expect(readServerRoleView(role()).components).toHaveLength(3)
  })
  it('refuse inconsistent sections, unsafe text and unknown states', () => {
    for (const bad of [{ ...timers(), timers: { ...off(), items: [{}] } }, { ...timers(), timers: { ...read([]), reason: 'x' } }, { ...timers(), observedAt: 'now' },
      { ...timers(), timers: read([{ ...timers().timers.items[0], owner: { kind: 'root' } }]) }, { ...timers(), cronDirectory: { ...timers().cronDirectory, state: 'absent' } }]) expect(() => readServerTimersView(bad)).toThrow()
    for (const bad of [{ ...network(), hostnameComparison: 'close' }, { ...network(), pool: [{ ...network().pool[0], status: 'ok' }] }, { ...network(), routes4: read([{ ...network().routes4.items[0], family: 6 }]) },
      { ...network(), interfaces: read([{ ...network().interfaces.items[0], name: 'eth0\u202e' }]) }]) expect(() => readServerNetworkView(bad)).toThrow()
    for (const bad of [{ ...role(), services: read([{ id: 'nginx', label: 'nginx', unit: null, state: 'running' }]) }, { ...role(), saved: { ...role().saved, counts: { ...role().saved.counts, zones: -1 } } }]) expect(() => readServerRoleView(bad)).toThrow()
  })
})

describe('server observation client binding', () => {
  it('makes no request and disables every control without transport or admission', async () => {
    mount('timers'); boot(); await tick()
    expect(status().dataset.state).toBe('unavailable')
    for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) expect(control.disabled).toBe(true)
    for (const [canRead, wrapper] of [[false, 'data-capability-state="authorized"'], [true, 'data-capability-state="unavailable"'], [true, 'data-wiring="soon"']] as const) {
      mount('network', 'en', canRead, wrapper); const send = vi.fn(); boot(send); await tick()
      expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable')
      expect(document.querySelector('form')).toBeNull()
      for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,textarea,button')) expect(control.disabled).toBe(true)
    }
    expect(WHM_SERVER_OBSERVATION_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_SERVER_OBSERVATION_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('paints timers with owners, filters client-side and lists cron.d names', async () => {
    mount('timers'); const send = vi.fn(async (_method: string, path: string) => responses[path.split('/').pop()!]!())
    boot(send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/server-observation/timers')
    expect(status().dataset.state).toBe('read')
    expect([fact('timer-total'), fact('timer-panel'), fact('timer-account'), fact('observed-at')]).toEqual(['3', '1', '1', '2026-10-27 10:00 UTC'])
    expect(rows('timer-rows').map(row => row.cells[1]!.textContent)).toEqual(['System', 'Account cron · alice', 'Panel'])
    expect(rows('timer-rows')[0]!.querySelector('bdi[dir="ltr"]')!.textContent).toBe('logrotate.timer')
    expect(rows('timer-rows')[1]!.cells[4]!.textContent).toBe('Never')
    const owner = document.querySelector<HTMLSelectElement>('[data-whm-server-observation-owner]')!
    owner.value = 'account-cron'; owner.dispatchEvent(new Event('change'))
    expect(rows('timer-rows')).toHaveLength(1)
    owner.value = ''; owner.dispatchEvent(new Event('change'))
    const search = document.querySelector<HTMLInputElement>('[data-whm-server-observation-search]')!
    search.value = 'LOGROTATE.SERVICE'; search.dispatchEvent(new Event('input'))
    expect(rows('timer-rows')).toHaveLength(1)
    search.value = 'nothing'; search.dispatchEvent(new Event('input'))
    expect(rows('timer-rows')[0]!.textContent).toBe('No timers match the filters.')
    expect(rows('cron-rows').map(row => row.textContent)).toEqual(['e2scrub_allRegular file'])
    expect(document.querySelector('[data-whm-server-observation-cron-status]')!.textContent).toBe('Entries listed: 1; entries with unsupported names: 1')
  })
  it('paints network drift, informational unpooled addresses and partial sections in Arabic with ASCII digits', async () => {
    mount('network', 'ar'); boot(async () => network()); await tick()
    expect(status().dataset.state).toBe('partial')
    expect(fact('hostname-comparison')).toBe('صيغة مختصرة لاسم المضيف المحفوظ')
    expect(fact('static-hostname')).toBe('web1')
    const pool = rows('pool-rows')
    expect(pool.map(row => row.dataset.whmServerObservationDrift)).toEqual(['configured', 'missing'])
    expect(pool[1]!.textContent).toContain('(انحراف)')
    expect(rows('unpooled-rows')[0]!.querySelector('bdi')!.textContent).toBe('198.51.100.7')
    expect(rows('route-rows').map(row => row.cells[1]!.textContent)).toEqual(['default'])
    expect(rows('interface-rows')[0]!.textContent).toContain('192.0.2.10/24 global')
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
  })
  it('keeps the saved role apart from observed services and never claims an unprobed engine', async () => {
    mount('role'); boot(async () => role()); await tick()
    expect(status().dataset.state).toBe('read')
    expect([fact('engine'), fact('php-versions'), fact('count-mailboxes'), fact('setup-completed')]).toEqual(['apache mpm-itk', '8.3', '1', '2026-10-01 00:00 UTC'])
    const components = rows('component-rows').map(row => [...row.cells].map(cell => cell.textContent))
    expect(components).toEqual([['Web edge', 'nginx', 'nginx: Running'], ['Web backend', 'openlitespeed', 'No reviewed service probe'], ['Mail', 'Mailboxes: 1', 'Postfix: Not installed; dovecot: Not observed']])
    expect(rows('service-rows').map(row => row.cells[2]!.textContent)).toEqual(['Running', 'Not installed'])
    mount('role'); boot(async () => ({ ...role(), services: off() })); await tick()
    expect(status().dataset.state).toBe('partial')
    expect(rows('component-rows')[0]!.cells[2]!.textContent).toBe('Not observed')
    expect(fact('count-accounts')).toBe('2')
  })
  it('reports refused or malformed reads without painting values', async () => {
    mount('network'); boot(async () => { throw Object.assign(new Error('refused'), { status: 412 }) }); await tick()
    expect(status().dataset.state).toBe('failed')
    expect(fact('static-hostname')).toBe('Not read')
    mount('timers'); boot(async () => ({ ...timers(), timers: { state: 'read', reason: null, truncated: false, items: [{ unit: 'x.timer' }] } })); await tick()
    expect(status().dataset.state).toBe('failed')
    expect(rows('timer-rows')[0]!.textContent).toBe('No timers have been read.')
    mount('timers'); boot(async () => ({ ...timers(), timers: off('malformed_output') })); await tick()
    expect(status().dataset.state).toBe('unavailable')
    expect(rows('timer-rows')[0]!.textContent).toBe('The host output could not be parsed, so nothing is shown.')
  })
})

describe('complete server observation timestamps', () => {
  it.each(['en', 'ar'] as const)('preserves timer observation, next and last instants in %s', async locale => {
    const observedAt = '2026-10-27T10:11:12.345Z', next = '2026-10-28T01:02:03.456Z', last = '2026-10-27T02:03:04.567Z'
    const reply = { ...timers(), observedAt }
    reply.timers.items[0]!.next = next; reply.timers.items[0]!.last = last
    const send = vi.fn(async () => reply)
    mount('timers', locale); boot(send); await tick()
    expect(fact('observed-at')).toBe('2026-10-27 10:11 UTC')
    expect([rows('timer-rows')[0]!.cells[3]!.textContent, rows('timer-rows')[0]!.cells[4]!.textContent]).toEqual(['2026-10-28 01:02 UTC', '2026-10-27 02:03 UTC'])
    for (const index of [3, 4]) expect(rows('timer-rows')[0]!.cells[index]!.querySelector('bdi')!.getAttribute('dir')).toBe('ltr')
    expect(document.querySelector('[data-whm-server-observation-cron-status]')!.textContent).toBe(locale === 'ar' ? 'المدخلات المعروضة: 1؛ مدخلات بأسماء غير مدعومة: 1' : 'Entries listed: 1; entries with unsupported names: 1')
    expect(send.mock.calls).toEqual([['GET', '/api/server/server-observation/timers']])
  })
  it.each(['en', 'ar'] as const)('preserves the complete network observation instant in %s', async locale => {
    const observedAt = '2026-10-27T10:11:12.345Z', send = vi.fn(async () => ({ ...network(), observedAt }))
    mount('network', locale); boot(send); await tick()
    expect(fact('observed-at')).toBe('2026-10-27 10:11 UTC')
    expect(document.querySelector('bdi[data-whm-server-observation-observed-at]')!.getAttribute('dir')).toBe('ltr')
    expect(send.mock.calls).toEqual([['GET', '/api/server/server-observation/network']])
  })
  it.each(['en', 'ar'] as const)('preserves role observation and setup completion instants in %s', async locale => {
    const observedAt = '2026-10-27T10:11:12.345Z', setupCompletedAt = '2026-10-01T00:01:02.345Z'
    const reply = { ...role(), observedAt, saved: { ...role().saved, setupCompletedAt } }, send = vi.fn(async () => reply)
    mount('role', locale); boot(send); await tick()
    expect([fact('observed-at'), fact('setup-completed')]).toEqual(['2026-10-27 10:11 UTC', '2026-10-01 00:01 UTC'])
    for (const name of ['observed-at', 'setup-completed']) expect(document.querySelector(`bdi[data-whm-server-observation-${name}]`)!.getAttribute('dir')).toBe('ltr')
    expect(send.mock.calls).toEqual([['GET', '/api/server/server-observation/role']])
  })
})
