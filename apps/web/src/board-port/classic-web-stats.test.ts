/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { Locale } from '../i18n.ts'
import { translator } from '../i18n.ts'
import { renderApprovedXpanelWorkspace, type ApprovedXpanelWorkspaceProps } from './approved-xpanel-workspaces.ts'
import { WEB_STATS_FIXTURE } from '../../../../tests/fixtures/web-stats-view.ts'

const { account, view } = WEB_STATS_FIXTURE
const props = (locale: Locale, patch: Partial<ApprovedXpanelWorkspaceProps> = {}): ApprovedXpanelWorkspaceProps => ({
  route: '/metrics/web-stats', locale, readOnly: false, theme: 'dark', density: 'compact', account, webStats: view,
  visibility: { principal: { kind: 'user', id: '77777777-7777-4777-8777-777777777777', username: account.username, accountId: account.id } },
  ...patch,
})
const render = (input: ApprovedXpanelWorkspaceProps): HTMLElement => {
  document.documentElement.lang = input.locale
  document.documentElement.dir = input.locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = renderApprovedXpanelWorkspace(input)!
  return document.body
}
const cells = (root: HTMLElement, table: string): string[][] => [...root.querySelectorAll(`[data-workspace-table="${table}"] tbody tr`)].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent ?? ''))
afterEach(() => { document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('classic web statistics', () => {
  it.each(['en', 'ar'] as const)('shows the AWStats month with each section and GET selection controls in %s', locale => {
    const root = render(props(locale))
    expect(root.querySelectorAll('h1')).toHaveLength(1)
    expect(root.querySelectorAll('[data-workspace-section="web-stats-scope"]')).toHaveLength(1)
    expect([...root.querySelectorAll('form')].every(form => form.method === 'get' && form.getAttribute('action') === '/metrics/web-stats')).toBe(true)
    expect([...root.querySelectorAll<HTMLButtonElement>('button[name="month"]')].map(button => button.value)).toEqual(['2026-11', '2026-10'])
    expect(root.querySelector('button[name="scheme"][aria-pressed="true"]')?.getAttribute('value')).toBe('http')
    expect(cells(root, 'web-stats-days')).toEqual([['2026-11-05', '3', '10', '20', '20.0\u00a0KiB'], ['2026-11-06', '9', '30', '70', '60.0\u00a0KiB']])
    expect(cells(root, 'web-stats-pages')[0]![0]).toBe('/shop/')
    expect(cells(root, 'web-stats-countries').map(row => row[0])).toEqual(['de', 'ip'])
    expect(root.querySelector('[data-workspace-table="web-stats-pages"] tbody [data-technical-value] bdi[dir="ltr"]')).not.toBeNull()
    expect(cells(root, 'web-stats-sites')[1]).toEqual(['alice.example', translator(locale)('SSL (https)'), translator(locale)('Not generated yet'), translator(locale)('Last run failed')])
    expect(root.querySelector('a[href="/api/account/web-stats/webalizer/http/alice.example/index.html"]')?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(root.querySelector('a[href="https://db-ip.com"]')).not.toBeNull()
    expect(root.textContent).not.toMatch(/[٠-٩۰-۹]/)
    const editor = root.querySelector<HTMLElement>('[data-web-stats-metrics]')!
    expect(editor.dataset.webStatsRevision).toBe(view.choice.revision)
    expect(editor.dataset.webStatsEnabled).toBe('false')
    expect([...editor.querySelectorAll<HTMLInputElement>('input[data-web-stats-choice]')].map(box => [box.dataset.site, box.dataset.engine, box.checked, box.dataset.locked])).toEqual([['alice.example', 'analog', true, 'false'], ['alice.example', 'awstats', true, 'false'], ['alice.example', 'webalizer', true, 'false']])
  })

  it('opens the Metrics Editor only for a verified tool, and locks what the administrator controls', () => {
    const verified = [{ id: 'metrics-editor', status: 'verified', delivery: { status: 'verified' } }] as unknown as ApprovedXpanelWorkspaceProps['catalog']
    const locked = { ...view, choice: { ...view.choice, choosable: ['webalizer' as const] } }
    const editor = render(props('en', { catalog: verified, webStats: locked })).querySelector<HTMLElement>('[data-web-stats-metrics]')!
    expect(editor.dataset.webStatsEnabled).toBe('true')
    expect(editor.querySelector<HTMLInputElement>('[data-engine="awstats"]')!.dataset.locked).toBe('true')
    expect(editor.querySelector<HTMLInputElement>('[data-engine="webalizer"]')!.dataset.locked).toBe('false')
    expect(editor.textContent).toContain('The server administrator controls at least one engine')
    expect(render(props('en', { catalog: verified, webStats: undefined, webStatsUnavailable: true })).querySelector<HTMLElement>('[data-web-stats-metrics]')!.dataset.webStatsEnabled).toBe('false')
  })

  it('shows no totals and no report link for an unavailable or foreign read', () => {
    for (const patch of [{ webStats: undefined, webStatsUnavailable: true }, { webStats: { ...view, context: { ...view.context, accountId: 'other' } } }]) {
      const root = render(props('en', patch))
      expect(cells(root, 'web-stats-days')).toEqual([['These records have not been read.']])
      expect(root.querySelector('a[href^="/api/account/web-stats/webalizer/"]')).toBeNull()
      expect(root.textContent).not.toContain('/shop/')
    }
  })
})
