// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translator, type MessageValues } from './i18n.ts'
import { APPROVED_HOST_SERVICES_CLIENT } from './approved-host-services-client.ts'
import { WHM_SERVICE_MANAGER_CLIENT_BINDING } from './whm-service-manager-client.ts'
import { renderApprovedWhmServicesContent } from './board-port/approved-whm-operations-components.ts'
import { renderWhmServiceManagerWorkspace } from './board-port/whm-service-manager-workspace.ts'
import { renderV2WhmServices, renderV2WhmServiceManager, WHM_SERVICES_CSS } from './themes/v2/pages/xwhm/host/services.ts'
import { mapAgentServices } from './board-port/xwhm-dashboard.ts'
import { serviceArea, serviceHealthPresentation } from './service-area.ts'
import { tools } from '@xpanel/catalog'
import { HOST_SERVICES } from '../../agent/src/host-services.ts'
import { renderWhmSurface } from './surfaces/xwhm.ts'
import type { WhmSurfaceProps } from './surfaces/xwhm.ts'

const principal = { kind: 'root' as const, id: 'operator', username: 'operator' }
const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const health = { name: 'Apache label differs from canonical ID', unit: 'apache2.service', role: 'Observed backend', version: '2.4.63', active: true, enabled: null, rssMb: null }
const live = { id: 'apache', label: 'Apache', unit: 'apache2.service', state: 'active' }
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const q = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const render = (theme: string, props: WhmSurfaceProps) => theme === 'classic' ? renderApprovedWhmServicesContent({ ...props, activeRoute: '/whm/services' }) : renderV2WhmServices(props)
const boot = (send?: Send, confirm = vi.fn().mockResolvedValue(true)) => {
  if (send) (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('confirm', '(' + APPROVED_HOST_SERVICES_CLIENT + ')(confirm)')(confirm)
  return confirm
}
const mount = (theme: string, locale: 'en' | 'ar', extra: Partial<WhmSurfaceProps> = {}) => {
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = render(theme, { locale, principal, catalog, services: [health], ...extra })
}
beforeEach(() => { vi.stubGlobal('xpT', (message: string, values?: MessageValues) => translator(document.documentElement.lang === 'ar' ? 'ar' : 'en')(message, values)) })
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest; vi.restoreAllMocks() })

describe('observed service provenance', () => {
  it('keeps absent RSS and boot facts unknown rather than deriving them from active state', () => {
    const rows = mapAgentServices({ services: [live, { ...live, id: 'redis', label: 'Redis', unit: 'redis.service', state: 'inactive' }] })!
    expect(rows).toHaveLength(2)
    expect(rows.map(row => [row.rssMb, row.enabled])).toEqual([[null, null], [null, null]])
    expect(rows[0]!.active).toBe(true)
  })
  it('keeps explicit observed zero distinct from null and discards ambiguous or unchecked telemetry', () => {
    expect(serviceHealthPresentation([{ ...health, rssMb: 0, enabled: false }])[0]).toMatchObject({ rssMb: 0, enabled: false })
    expect(serviceHealthPresentation([{ ...health, rssMb: 50, enabled: true, checked: false }])[0]).toMatchObject({ rssMb: null, enabled: null, version: null, role: null })
    expect(serviceHealthPresentation([health, { ...health, version: 'another' }]).every(row => row.rssMb === null && row.version === null && row.role === null && row.state === 'unchecked')).toBe(true)
    expect(serviceHealthPresentation([{ ...health, unit: 'unidentified.service', rssMb: 10, enabled: true }])[0]).toMatchObject({ state: 'unchecked', version: null, role: null, rssMb: null, enabled: null })
  })
  it('groups only actual canonical identities or exact known units without granting actions', () => {
    for (const spec of HOST_SERVICES) for (const unit of spec.units) expect(serviceArea(spec.id, unit)).not.toBe('unread')
    expect(serviceArea('apache', 'httpd.service')).toBe('web')
    expect(serviceArea('apache', 'nginx.service')).toBe('unread')
    expect(serviceArea(null, 'my-postfix-helper.service')).toBe('unread')
    expect(serviceArea(null, 'dovecot.service')).toBe('mail')
    expect(serviceArea('not-in-the-host-dto', 'apache2.service')).toBe('unread')
  })
})

describe.each(['classic', 'v2'])('%s complete services workspace', theme => {
  it.each(['en', 'ar'] as const)('retains one7-column table, real local selection and all detail states in%s without native admission', async locale => {
    mount(theme, locale, { catalog: [], services: [health, { ...health, name: 'Redis', unit: 'redis.service', role: 'Cache', version: '', active: false }] })
    const send = vi.fn<Send>(); boot(send); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[data-host-service-rows]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-host-service-rows] tr[data-service-key]')).toHaveLength(2)
    expect(document.querySelectorAll('[data-host-service-rows]').item(0)?.closest('table')?.querySelectorAll('thead th')).toHaveLength(7)
    q<HTMLButtonElement>('[data-service-key="snapshot-0"] [data-service-select]').click()
    expect(q('[data-host-detail="name"]').textContent).toBe(health.name)
    expect(q('[data-host-detail="version"]').textContent).toBe(health.version)
    expect(q('[data-host-detail="memory"]').textContent).not.toBe('0 MB')
    const search = q<HTMLInputElement>('[data-host-service-search]'); search.value = 'redis'; search.dispatchEvent(new Event('input'))
    expect(q<HTMLElement>('[data-service-key="snapshot-0"]').hidden).toBe(true)
    expect(q<HTMLElement>('[data-service-key="snapshot-1"]').hidden).toBe(false)
    search.value = ''; search.dispatchEvent(new Event('input')); q<HTMLButtonElement>('[data-service-area="web"]').click()
    expect(q<HTMLElement>('[data-service-key="snapshot-0"]').hidden).toBe(false)
    expect(q<HTMLElement>('[data-service-key="snapshot-1"]').hidden).toBe(true)
    expect([...document.querySelectorAll<HTMLButtonElement>('[data-service-id]')]).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
    const ids = [...document.querySelectorAll<HTMLElement>('[id]')].map(node => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('joins a differently labelled observation only through its exact unique unit', async () => {
    mount(theme, 'en')
    boot(vi.fn<Send>().mockResolvedValue({ services: [live] })); await tick()
    expect(q('[data-host-service-rows]').textContent).toContain('Observed backend')
    q<HTMLButtonElement>('[data-service-select]').click()
    expect(q('[data-host-detail="unit"]').textContent).toBe('apache2.service')
    expect(q('[data-host-detail="version"]').textContent).toBe('2.4.63')
    expect(q('[data-host-detail="boot"]').textContent).toBe('Not read')
  })
  it.each(['missing', 'duplicate'])('does not borrow%s metadata by matching a label or sharing a unit', async kind => {
    mount(theme, 'en', { services: kind === 'duplicate' ? [health, { ...health, version: 'conflict' }] : [{ ...health, unit: 'httpd.service' }] })
    boot(vi.fn<Send>().mockResolvedValue({ services: [live] })); await tick()
    const rows = q('[data-host-service-rows]')
    expect(rows.textContent).not.toContain('2.4.63'); expect(rows.textContent).not.toContain('Observed backend')
    q<HTMLButtonElement>('[data-service-select]').click()
    expect(q('[data-host-detail="version"]').textContent).toBe('Not read')
  })
  it('does not treat duplicated live units as distinct restart targets', async () => {
    mount(theme, 'en')
    const send = vi.fn<Send>().mockResolvedValue({ services: [live, { ...live, id: 'nginx', label: 'Another label' }] }); boot(send); await tick()
    expect(document.querySelectorAll('[data-service-id]')).toHaveLength(0)
    expect([...q('[data-host-service-rows]').querySelectorAll('[data-xp-slot="state"]')].every(node => node.textContent === 'Not read')).toBe(true)
    expect(q('[data-host-service-rows]').textContent).not.toContain('2.4.63')
  })
  it.each(['missing', 'duplicate', 'wrong-root', 'wrong-tag', 'missing-slot', 'duplicate-slot'])('refuses%s prototype before GET, confirmation or effect', async fault => {
    mount(theme, 'en')
    const template = q<HTMLTemplateElement>('template[data-xp-template="host-service-row"]')
    if (fault === 'missing') template.remove()
    if (fault === 'duplicate') template.after(template.cloneNode(true))
    if (fault === 'wrong-root') document.body.append(template)
    if (fault === 'wrong-tag') { const row = template.content.firstElementChild!; const other = document.createElement('div'); other.append(...row.childNodes); row.replaceWith(other) }
    if (fault === 'missing-slot') template.content.querySelector('[data-xp-slot="version"]')!.remove()
    if (fault === 'duplicate-slot') template.content.querySelector('[data-xp-slot="version"]')!.after(template.content.querySelector('[data-xp-slot="version"]')!.cloneNode())
    const send = vi.fn<Send>(), confirm = vi.fn().mockResolvedValue(true); boot(send, confirm); await tick()
    expect(send).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled()
    expect(q<HTMLElement>('[data-host-service-status]').dataset.state).toBe('unavailable')
  })
  it('keeps a duplicated target unit in post-restart readback unverified', async () => {
    mount(theme, 'en')
    const send = vi.fn<Send>().mockResolvedValueOnce({ services: [live] }).mockResolvedValueOnce({ service: live }).mockResolvedValueOnce({ services: [live, { ...live, id: 'nginx' }] })
    boot(send); await tick(); q<HTMLButtonElement>('[data-service-id]').click(); await tick()
    expect(q<HTMLElement>('[data-host-service-status]').dataset.state).toBe('uncertain')
    expect(q<HTMLButtonElement>('[data-service-id]').disabled).toBe(true)
  })
  it.each(['template', 'authority'])('rechecks%s after confirmation and sends no native request', async lost => {
    mount(theme, 'en')
    let resolve!: (value: boolean) => void
    const send = vi.fn<Send>().mockResolvedValue({ services: [live] })
    boot(send, vi.fn().mockImplementation(() => new Promise<boolean>(done => { resolve = done }))); await tick()
    q<HTMLButtonElement>('[data-service-id]').click()
    if (lost === 'template') q('template[data-xp-template="host-service-row"]').remove()
    else q<HTMLElement>('[data-host-services]').dataset.hostCanManage = 'false'
    resolve(true); await tick()
    expect(send.mock.calls.map(call => call[0])).toEqual(['GET'])
  })
  it('does not claim no changes or read back after losing a prototype during an acknowledged restart', async () => {
    mount(theme, 'en')
    let finish!: (value: unknown) => void
    const send = vi.fn<Send>().mockResolvedValueOnce({ services: [live] }).mockImplementationOnce(() => new Promise(done => { finish = done }))
    boot(send); await tick(); q<HTMLButtonElement>('[data-service-id]').click(); await tick()
    q('template[data-xp-template="host-service-row"]').remove(); finish({ service: live }); await tick()
    expect(send.mock.calls.map(call => call[0])).toEqual(['GET','POST'])
    expect(q('[data-host-service-status]').textContent).not.toMatch(/No changes|completed|active\./)
  })
})

describe.each(['classic', 'v2'])('%s auxiliary service details', theme => {
  it.each(['en','ar'] as const)('selects exact observed unit facts in%s without enabling host mutations', async locale => {
    document.documentElement.lang = locale
    document.body.innerHTML = theme === 'classic' ? renderWhmServiceManagerWorkspace({ locale, canRead: true, canManage: false }) : renderV2WhmServiceManager({ locale, principal })
    const revision='a'.repeat(64)
    const view={state:'read',observedAt:'2026-10-30T15:00:00.000Z',revision,bootTime:1793360000,manage:false,units:[{unit:'php8.3-fpm.service',load:'loaded',active:'active',sub:'running',boot:'disabled',restart:true,bootEditable:false},{unit:'dovecot.service',load:'loaded',active:'inactive',sub:'dead',boot:'enabled',restart:false,bootEditable:false}]}
    const send=vi.fn<Send>().mockResolvedValue(view), ask=vi.fn().mockResolvedValue(true)
    ;(window as Window & {xpanelSessionRequest?: Send}).xpanelSessionRequest=send
    new Function('return '+WHM_SERVICE_MANAGER_CLIENT_BINDING)()(ask); await tick()
    q<HTMLButtonElement>('[data-sm-select="php8.3-fpm.service"]').click()
    expect(q('[data-sm-detail="unit"]').textContent).toBe('php8.3-fpm.service')
    expect(q('[data-sm-detail="boot"]').textContent).toBe('disabled')
    q<HTMLButtonElement>('[data-sm-area="mail"]').click()
    expect(q('[data-sm-rows]').textContent).toContain('dovecot.service')
    expect(q('[data-sm-rows]').textContent).not.toContain('php8.3')
    q<HTMLButtonElement>('[data-sm-area="web"]').click()
    const native=q<HTMLButtonElement>('[data-sm-action="restart"]'); expect(native.disabled).toBe(true); native.disabled=false; native.click(); await tick()
    expect(send.mock.calls.map(call=>call[0])).toEqual(['GET']); expect(ask).not.toHaveBeenCalled()
  })
})

describe('complete Classic Services document integration', () => {
  it.each(['en','ar'] as const)('retains one canonical observed/native table in the actual%s document', locale => {
    document.body.innerHTML = renderWhmSurface({ locale, activeRoute: '/whm/services', principal, catalog, services: [health] })
    expect(document.querySelectorAll('[data-host-services]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-host-service-rows]')).toHaveLength(1)
    expect(q('[data-host-service-rows]').closest('table')?.querySelectorAll('thead th')).toHaveLength(7)
    expect(document.querySelectorAll('template[data-xp-template="host-service-row"]')).toHaveLength(1)
  })
})
it('keeps the Services stylesheet confined to its owned workspace selectors',()=>{
  expect(WHM_SERVICES_CSS).toContain('.v2-services__aside')
  expect(WHM_SERVICES_CSS).not.toMatch(/\.v2-host\b|\.xp-whm-ops\b|:root/)
})
