// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import { tools } from '@xpanel/catalog'
import { translator } from './i18n.ts'
import { projectPanelSurface, projectReadOnlyPanelSurface } from './models/theme-surface.ts'
import { renderAccountAnnouncementsBanner, type AccountAnnouncementNotice } from './board-port/account-announcements-banner.ts'
import { ACCOUNT_ANNOUNCEMENTS_CLIENT_BINDING, requireAccountAnnouncementTemplates } from './board-port/account-announcements-banner-client.ts'
import { renderV2AccountAnnouncementsBanner } from './themes/v2/components/account-announcements.ts'
import { renderV2PanelHome, type PanelPageProps } from './themes/v2/pages/xpanel/home.ts'

const id = '77777777-7777-4777-8777-000000000001'
const notice = (): AccountAnnouncementNotice => ({ id, severity: 'warning', title: { en: 'Maintenance', ar: 'صيانة' }, body: { en: 'Observed message', ar: 'رسالة معتمدة' }, startsAt: null, endsAt: '2026-10-30T18:00:00.000Z' })
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const previousTranslate = globalThis.xpT
const settle = async () => { for (let step = 0; step < 5; step++) await new Promise(resolve => setTimeout(resolve, 0)) }
const root = () => document.querySelector<HTMLElement>('[data-account-announcements]')!
const start = (html: string, send: Send, locale: 'en' | 'ar' = 'en') => {
  document.documentElement.lang = locale
  globalThis.xpT = translator(locale)
  document.body.innerHTML = html
  ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + ACCOUNT_ANNOUNCEMENTS_CLIENT_BINDING)()()
}
const banner = (theme: 'classic' | 'v2', locale: 'en' | 'ar' = 'en') => theme === 'classic'
  ? renderAccountAnnouncementsBanner({ locale, announcements: [] }) : renderV2AccountAnnouncementsBanner(translator(locale), true)
const account: Account = { id: '11111111-1111-4111-8111-111111111111', username: 'fixture', uid: 20031, gid: 20031, home: '/home/fixture', primaryDomain: 'fixture.test', planId: '22222222-2222-4222-8222-222222222222', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'fixture@example.test', ipv4: '192.0.2.31', shell: 'none', createdAt: '2026-10-22T00:00:00.000Z' }
const homeProps = (activeRoute = '/home'): PanelPageProps => ({ locale: 'en', activeRoute, account, plan: defaultPlan({ id: account.planId }), catalog: tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } })), visibility: { principal: { kind: 'user', id: '33333333-3333-4333-8333-333333333333', username: account.username, accountId: account.id }, disabledFeatures: new Set() } })

afterEach(() => { document.body.innerHTML = ''; globalThis.xpT = previousTranslate; delete (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest })

describe('real Home announcement component and shared client', () => {
  it('provides complete inert notice templates and truthful unread or unavailable states', () => {
    document.body.innerHTML = renderV2AccountAnnouncementsBanner(translator('en'), true)
    expect(() => requireAccountAnnouncementTemplates(root())).not.toThrow()
    expect(root().querySelectorAll('template')).toHaveLength(3)
    expect(root().dataset.state).toBe('unread')
    expect(root().querySelector('[data-account-announcement]')).toBeNull()
    document.body.innerHTML = renderV2AccountAnnouncementsBanner(translator('en'), false)
    expect(root().dataset.state).toBe('unavailable')
    expect(root().hidden).toBe(false)
    expect(root().querySelector('[data-account-announcements-status]')?.textContent).toBe('Announcements are unavailable here. Nothing was read or changed.')
  })

  it.each(['classic', 'v2'] as const)('reads the authenticated account endpoint once and displays real %s notices', async theme => {
    const send = vi.fn<Send>(async () => ({ announcements: [notice()] }))
    start(banner(theme), send)
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('GET', '/api/account/announcements')
    expect(root().dataset.state).toBe('read')
    expect(root().hidden).toBe(false)
    expect(root().querySelector(`[data-account-announcement="${id}"]`)?.textContent).toContain('Observed message')
    expect(root().querySelector('bdi[dir="ltr"]')?.textContent).toContain('2026-10-30')
  })

  it.each(['classic', 'v2'] as const)('hides only a successful empty %s result', async theme => {
    start(banner(theme), vi.fn<Send>(async () => ({ announcements: [] })))
    await settle()
    expect(root().dataset.state).toBe('read')
    expect(root().hidden).toBe(true)
    expect(root().querySelector('[data-account-announcement]')).toBeNull()
  })

  it.each(['classic', 'v2'] as const)('exposes %s read failure without pretending it was empty', async theme => {
    start(banner(theme), vi.fn<Send>(async () => { throw new Error('read failed') }))
    await settle()
    expect(root().dataset.state).toBe('failed')
    expect(root().hidden).toBe(false)
    const status = root().querySelector<HTMLElement>('[data-account-announcements-status]')!
    expect(status.hidden).toBe(false)
    expect(status.getAttribute('role')).toBe('alert')
    expect(status.textContent).toBe('Announcements could not be read or verified. Nothing was changed.')
    expect(root().querySelector('[data-account-announcement]')).toBeNull()
  })

  it.each(['classic', 'v2'] as const)('dismisses only the verified account notice in %s', async theme => {
    const send = vi.fn<Send>(async method => method === 'GET' ? { announcements: [notice()] } : { dismissed: id, announcements: [] })
    start(banner(theme), send)
    await settle()
    root().querySelector<HTMLButtonElement>('[data-account-announcement-dismiss]')!.click()
    await settle()
    expect(send).toHaveBeenLastCalledWith('POST', `/api/account/announcements/${id}/dismiss`)
    expect(root().dataset.state).toBe('read')
    expect(root().hidden).toBe(true)
  })

  it.each(['classic', 'v2'] as const)('preserves the real %s notice after failed dismissal', async theme => {
    const send = vi.fn<Send>(async method => { if (method === 'GET') return { announcements: [notice()] }; throw new Error('dismiss failed') })
    start(banner(theme), send)
    await settle()
    root().querySelector<HTMLButtonElement>('[data-account-announcement-dismiss]')!.click()
    await settle()
    expect(root().querySelector(`[data-account-announcement="${id}"]`)).not.toBeNull()
    expect(root().querySelector<HTMLElement>('[data-account-announcements-status]')!.hidden).toBe(false)
    expect(root().querySelector('[data-account-announcements-status]')?.textContent).toContain('still shown')
  })

  it.each(['data-readonly="true"', 'data-wiring="unavailable"', 'aria-disabled="true"'])('keeps %s roots at zero transport', async denied => {
    const send = vi.fn<Send>(async () => ({ announcements: [notice()] }))
    start(`<div ${denied}>${banner('v2')}</div>`, send)
    await settle()
    expect(send).not.toHaveBeenCalled()
    expect(root().querySelector('[data-account-announcement]')).toBeNull()
  })

  it('refuses incomplete real V2 templates before GET', async () => {
    const send = vi.fn<Send>(async () => ({ announcements: [] }))
    const broken = banner('v2').replace('data-xp-slot="end"', 'data-xp-slot="wrong"')
    start(broken, send)
    await settle()
    expect(send).not.toHaveBeenCalled()
    expect(root().dataset.state).toBe('unavailable')
  })

  it('renders the real Arabic notice with isolated ASCII expiry and no injected markup', async () => {
    start(banner('v2', 'ar'), vi.fn<Send>(async () => ({ announcements: [notice()] })), 'ar')
    await settle()
    expect(root().dir).toBe('rtl')
    expect(root().textContent).toContain('صيانة')
    expect(root().querySelector('bdi')?.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it('preserves observed Classic notices when its initial refresh fails', async () => {
    start(renderAccountAnnouncementsBanner({ locale: 'en', announcements: [notice()] }), vi.fn<Send>(async () => { throw new Error('offline') }))
    await settle()
    expect(root().dataset.state).toBe('failed')
    expect(root().querySelector(`[data-account-announcement="${id}"]`)).not.toBeNull()
    expect(root().querySelector('[data-account-announcements-status]')?.textContent).toContain('could not be read')
  })

  it('does not reveal results after read authority is lost during GET', async () => {
    let deliver!: (value: unknown) => void
    start(banner('v2'), vi.fn<Send>(() => new Promise(resolve => { deliver = resolve })))
    root().dataset.readonly = 'true'
    deliver({ announcements: [notice()] })
    await settle()
    expect(root().querySelector('[data-account-announcement]')).toBeNull()
    expect(root().hidden).toBe(true)
  })

  it('wires the actual Home only through matching live core authority', async () => {
    const view = projectPanelSurface(homeProps())!
    expect(view).toBeDefined()
    const send = vi.fn<Send>(async () => ({ announcements: [] }))
    start(renderV2PanelHome(view.props, view.authority), send)
    await settle()
    expect(send).toHaveBeenCalledWith('GET', '/api/account/announcements')
  })

  it('retains a truthful zero-transport Home banner for read-only core authority', async () => {
    const view = projectReadOnlyPanelSurface(homeProps())!
    const send = vi.fn<Send>(async () => ({ announcements: [] }))
    start(renderV2PanelHome(view.props, view.authority), send)
    await settle()
    expect(send).not.toHaveBeenCalled()
    expect(root().dataset.state).toBe('unavailable')
  })

  it('does not reuse valid read authority for a different account identity', async () => {
    const props = homeProps(), view = projectPanelSurface(props)!
    const send = vi.fn<Send>(async () => ({ announcements: [] }))
    const changed: PanelPageProps = { ...props, visibility: { principal: { kind: 'user', id: 'foreign-user', username: 'foreign', accountId: 'foreign-account' }, disabledFeatures: new Set() } }
    start(renderV2PanelHome(changed, view.authority), send)
    await settle()
    expect(send).not.toHaveBeenCalled()
    expect(root().dataset.state).toBe('unavailable')
  })

  it('keeps the /panel alias on the same core-projected Home path', async () => {
    const view = projectPanelSurface(homeProps('/panel'))!
    expect(view.route).toBe('/home')
    const send = vi.fn<Send>(async () => ({ announcements: [] }))
    start(renderV2PanelHome(view.props, view.authority), send)
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
  })
})