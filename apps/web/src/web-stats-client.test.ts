/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAllowedDraft, parseHoursDraft, WEB_STATS_CLIENT_BINDING } from './web-stats-client.ts'
import { renderV2WhmWebStatsEngines } from './themes/v2/pages/xwhm/monitoring/web-stats-engines.ts'
import { renderApprovedWhmAccountBulkControls } from './board-port/approved-whm-account-components.ts'
import { renderV2WhmAccountList } from './themes/v2/pages/xwhm/accounts/list.ts'
import { tools } from '@xpanel/catalog'
import { renderWhmMonitoringLogs } from './board-port/whm-monitoring-workspace.ts'
import { translator } from './i18n.ts'

const REVISION = 'b'.repeat(64)
const policy = { engines: { analog: { available: false, byDefault: false }, awstats: { available: true, byDefault: true }, webalizer: { available: true, byDefault: false } }, allowInclude: false, reverseDns: false, users: 'listed', allowed: { alice: ['awstats'] }, intervalHours: 24, bandwidthIntervalMinutes: 15, blackoutHours: [2, 3], avoidBackups: true }
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
const boot = (transport: (method: string, path: string, body?: unknown) => Promise<unknown>, html: string) => {
  document.body.innerHTML = html
  ;(window as unknown as Record<string, unknown>).xpT = (message: string, values?: Record<string, string>) => Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{${key}}`, value), message)
  ;(window as unknown as Record<string, unknown>).xpanelSessionRequest = transport
  new Function('return ' + WEB_STATS_CLIENT_BINDING)()()
}
afterEach(() => { document.body.innerHTML = '' })

describe('web statistics drafts', () => {
  it('reads the allow list and refuses a malformed line', () => {
    expect(parseAllowedDraft('alice awstats\n\nbob webalizer awstats\ncarol')).toEqual({ alice: ['awstats'], bob: ['webalizer', 'awstats'], carol: [] })
    expect(parseAllowedDraft('alice goaccess')).toBeNull()
    expect(parseAllowedDraft('alice analog')).toEqual({ alice: ['analog'] })
    expect(parseAllowedDraft('alice awstats\nalice webalizer')).toBeNull()
    expect(parseAllowedDraft('Bad awstats')).toBeNull()
  })
  it('reads blackout hours and refuses a value that is not an hour', () => {
    expect(parseHoursDraft('')).toEqual([])
    expect(parseHoursDraft('2, 3')).toEqual([2, 3])
    expect(parseHoursDraft('24')).toBeNull()
    expect(parseHoursDraft('2,2')).toBeNull()
    expect(parseHoursDraft('x')).toBeNull()
  })
  it('stays free of direct fetches and markup injection', () => {
    expect(WEB_STATS_CLIENT_BINDING).not.toMatch(/fetch\(|innerHTML/)
  })
})

describe('Metrics Editor controller', () => {
  const html = (enabled: boolean) => `<section data-web-stats-metrics data-web-stats-enabled="${enabled}" data-web-stats-revision="${REVISION}">
    <input type="checkbox" data-web-stats-choice data-site="alice.test" data-engine="awstats" data-locked="false" checked disabled>
    <input type="checkbox" data-web-stats-choice data-site="alice.test" data-engine="webalizer" data-locked="true" checked disabled>
    <button data-web-stats-metrics-save disabled></button><p data-web-stats-metrics-status></p></section>`
  const box = (engine: string) => document.querySelector<HTMLInputElement>(`[data-engine="${engine}"]`)!

  it('keeps locked engines closed, saves a real change with its revision and reports the outcome', async () => {
    const transport = vi.fn(async () => ({ revision: 'c'.repeat(64) }))
    boot(transport, html(true))
    const save = document.querySelector<HTMLButtonElement>('[data-web-stats-metrics-save]')!
    expect(box('webalizer').disabled).toBe(true)
    expect(save.disabled).toBe(true)
    box('awstats').checked = false; box('awstats').dispatchEvent(new Event('change'))
    expect(save.disabled).toBe(false)
    save.click(); await flush()
    expect(transport).toHaveBeenCalledWith('PUT', '/api/account/web-stats', { revision: REVISION, sites: { 'alice.test': ['webalizer'] } })
    expect(document.querySelector<HTMLElement>('[data-web-stats-metrics-status]')!.dataset.state).toBe('saved')
    expect(save.disabled).toBe(true)
  })

  it('stays closed until the tool is verified, and shows a refusal as nothing saved', async () => {
    const transport = vi.fn(async () => { throw { details: { stateChanged: false } } })
    boot(transport, html(false))
    expect(box('awstats').disabled).toBe(true)
    boot(transport, html(true))
    box('awstats').checked = false; box('awstats').dispatchEvent(new Event('change'))
    document.querySelector<HTMLButtonElement>('[data-web-stats-metrics-save]')!.click(); await flush()
    expect(document.querySelector('[data-web-stats-metrics-status]')!.textContent).toContain('nothing was saved')
  })
})

describe.each([
  ['classic', (enabled: boolean) => renderWhmMonitoringLogs({ locale: 'en', canRead: true, webStatsEnginesEnabled: enabled })],
  ['v2', (enabled: boolean) => renderV2WhmWebStatsEngines(translator('en'), true, enabled)],
] as const)('Statistics Software Configuration controller on the %s card', (_, render) => {
  const reply = { policy, revision: REVISION, host: { engines: { awstats: true, webalizer: true }, geoip: { installed: false, month: null }, lastRunAt: '2026-11-06T01:00:00.000Z', nextRunAt: '2026-11-07T01:00:00.000Z', running: false, bandwidth: { lastCollectedAt: '2026-11-06T02:00:00.000Z', pendingBytes: 0 }, behind: [{ username: 'alice', minutes: 90, pendingBytes: 2048 }] }, actions: { save: true } }
  const policyField = (name: string) => document.querySelector<HTMLInputElement>(`[data-web-stats-policy="${name}"]`)!

  it('fills the saved policy and status, then saves the edited policy with its revision', async () => {
    const transport = vi.fn(async (method: string) => method === 'GET' ? reply : { revision: 'c'.repeat(64) })
    boot(transport, render(true)); await flush()
    expect(policyField('intervalHours').value).toBe('24')
    expect(policyField('bandwidthIntervalMinutes').value).toBe('15')
    expect(policyField('blackoutHours').value).toBe('2, 3')
    expect(policyField('allowed').value).toBe('alice awstats')
    expect(policyField('webalizer.byDefault').checked).toBe(false)
    expect(document.querySelector('[data-web-stats-summary]')!.textContent).toBe('Last run 2026-11-06 01:00 UTC. Next run 2026-11-07 01:00 UTC. Bandwidth last processed 2026-11-06 02:00 UTC.')
    expect(document.querySelector('[data-web-stats-behind]')!.textContent).toBe('alice902048')
    policyField('intervalHours').value = '48'
    document.querySelector<HTMLButtonElement>('[data-web-stats-save]')!.click(); await flush()
    expect(transport).toHaveBeenLastCalledWith('PUT', '/api/server/web-stats', { revision: REVISION, policy: { ...policy, intervalHours: 48 } })
  })

  it('starts one account in the background', async () => {
    const transport = vi.fn(async (method: string) => method === 'GET' ? reply : { username: 'alice', state: 'started' })
    boot(transport, render(true)); await flush()
    const user = document.querySelector<HTMLInputElement>('[data-web-stats-process-user]')!, run = document.querySelector<HTMLButtonElement>('[data-web-stats-process]')!
    expect(run.disabled).toBe(true)
    user.value = 'alice'; user.dispatchEvent(new Event('input'))
    run.click(); await flush()
    expect(transport).toHaveBeenLastCalledWith('POST', '/api/server/web-stats/process', { username: 'alice' })
    expect(document.querySelector<HTMLElement>('[data-web-stats-status]')!.dataset.state).toBe('saved')
  })

  it('keeps changes closed for an unverified tool and sends nothing before admission', async () => {
    const transport = vi.fn(async () => ({ ...reply, actions: { save: false } }))
    boot(transport, render(true)); await flush()
    expect(policyField('intervalHours').disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-web-stats-save]')!.disabled).toBe(true)
    const none = vi.fn()
    boot(none, render(false)); await flush()
    expect(none).not.toHaveBeenCalled()
  })
})

const lockProps = (kind: string) => ({ locale: 'en', accounts: [], plans: [], resellers: [], featureLists: [], activeReseller: { id: 'r1', acl: ['list-accounts', 'edit-account'] },
  catalog: tools.filter(tool => tool.id === 'metrics-editor' || tool.id === 'list-accounts').map(tool => ({ ...tool, status: 'verified', delivery: { ...tool.delivery, status: 'verified' } })),
  principal: { kind, id: 'r1', username: 'one' }, visibility: { principal: { kind, id: 'r1', username: 'one' }, reseller: { id: 'r1', acl: ['list-accounts', 'edit-account'] } } }) as never
describe.each([
  ['classic', (kind: string) => renderApprovedWhmAccountBulkControls(lockProps(kind))],
  ['v2', (kind: string) => renderV2WhmAccountList(translator('en'), lockProps(kind))],
] as const)('reseller statistics locks on the %s accounts page', (_, render) => {
  const lock = (engine: string) => document.querySelector<HTMLSelectElement>(`[data-web-stats-lock="${engine}"]`)!
  it('shows the card to a reseller only', () => {
    expect(render('root')).not.toContain('data-web-stats-locks')
    expect(render('reseller')).toContain('data-web-stats-locks')
  })
  it('reads the saved locks, keeps an unavailable engine closed and saves the change with its revision', async () => {
    const transport = vi.fn(async (method: string) => method === 'GET' ? { locks: { awstats: true }, revision: REVISION, available: ['awstats', 'webalizer'], actions: { save: true } } : { revision: 'c'.repeat(64) })
    boot(transport, render('reseller'))
    await flush()
    expect(lock('awstats').value).toBe('on')
    expect(lock('analog').disabled).toBe(true)
    lock('webalizer').value = 'off'
    document.querySelector<HTMLButtonElement>('[data-web-stats-locks-save]')!.click()
    await flush()
    expect(transport).toHaveBeenLastCalledWith('PUT', '/api/resellers/web-stats', { revision: REVISION, locks: { awstats: true, webalizer: false } })
    expect(document.querySelector('[data-web-stats-locks-status]')!.textContent).toBe('Saved. The next statistics run applies these locks.')
  })
  it('stays closed when the tool is not verified or the read fails', async () => {
    boot(async () => ({ locks: {}, revision: REVISION, available: ['awstats'], actions: { save: false } }), render('reseller'))
    await flush()
    expect(lock('awstats').disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-web-stats-locks-save]')!.disabled).toBe(true)
    boot(async () => { throw new Error('offline') }, render('reseller'))
    await flush()
    expect(document.querySelector('[data-web-stats-locks-status]')!.textContent).toBe('The statistics locks could not be read.')
  })
})
