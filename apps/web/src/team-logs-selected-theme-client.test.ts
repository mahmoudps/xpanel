import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account, Domain } from '@xpanel/core'
import { translator } from './i18n.ts'
import { msgid, msgctxt } from '@xpanel/core'
import { ACCOUNT_TEAM_CLIENT_BINDING } from './acct-team-client.ts'
import { ACCOUNT_LOGS_CLIENT_BINDING } from './account-logs-client.ts'
import { renderAccountTeamWorkspace } from './board-port/acct-team-workspace.ts'
import { renderAccountLogsWorkspace } from './board-port/account-logs-workspace.ts'
import { renderV2AccountTeamPage } from './themes/v2/pages/xpanel/settings/team.ts'
import { renderV2PanelLogs } from './themes/v2/pages/xpanel/observations/logs.ts'

type TestDom = { window: Window & typeof globalThis }
const harnessRequire = createRequire(createRequire(import.meta.url).resolve('vitest'))
const { JSDOM } = harnessRequire('jsdom') as { JSDOM: new (html: string, options: { url: string; runScripts: 'outside-only' }) => TestDom }
const doms: TestDom[] = []
const accountId = '11111111-1111-4111-8111-111111111111', domainId = '22222222-2222-4222-8222-222222222222'
const account: Account = { id: accountId, username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', primaryDomain: 'alice.test', planId: 'plan-a', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'alice@example.test', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' }
const domain: Domain = { id: domainId, accountId, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: account.home + '/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', ini: {}, fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 } }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' }
const memberId = '77777777-7777-4777-8777-000000000001'
const teamView = { state: 'saved', revision: 'a'.repeat(64), account: { username: account.username, primaryDomain: account.primaryDomain }, limits: { roleHolders: 7, members: 100, roleHoldersUsed: 1 }, members: [{ id: memberId, username: 'sam', roles: ['email'], contactEmail: 'sam@example.test', notes: '', expiresAt: null, expiryReason: null, status: 'active', suspendReason: null, phase: 'active', toolCount: 24, signIn: { password: 'not-set', linkExpiresAt: null, lastLoginAt: null } }], signIn: { available: false } }
const logsView = { context: { accountId, domainId, domainName: domain.name, site: domain.name, kind: 'access' }, file: { exists: true, sizeBytes: 900, truncated: false }, limits: { maxLines: 2000, maxBytes: 262144, linesDropped: 0 }, observedAt: '2026-10-27T02:00:00.000Z', entries: [{ time: '2026-10-27T01:00:00+00:00', host: domain.name, ip: '192.0.2.9', method: 'GET', uri: '/<img src=x>', status: 200, bytes: 10, referer: '', agent: 'curl/8' }], unparsedLines: 0 }
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
function mount(html: string, binding: string, send: (method: string, path: string, body?: unknown) => Promise<unknown>, prepare?: (document: Document) => void) {
  const dom = new JSDOM(html, { url: 'https://panel.example.test/preferences/team', runScripts: 'outside-only' }); doms.push(dom)
  Object.assign(dom.window, { msgid, msgctxt, xpT: translator('en'), xpanelSessionRequest: send })
  prepare?.(dom.window.document)
  dom.window.Function('return ' + binding)()(async () => true, false)
  return dom.window.document
}
afterEach(() => { for (const dom of doms.splice(0)) dom.window.close() })

describe.each(['classic', 'v2'] as const)('%s team and log templates', theme => {
  const teamHtml = () => theme === 'classic' ? renderAccountTeamWorkspace({ lang: 'en', accountId, canManage: true }) : renderV2AccountTeamPage({ locale: 'en', account, activeRoute: '/preferences/team' }, { canRead: true, canManage: true })
  const logsHtml = () => theme === 'classic' ? renderAccountLogsWorkspace({ lang: 'en', accountId, domains: [domain], selectedDomainId: domainId, kinds: ['access', 'error'] }) : renderV2PanelLogs({ locale: 'en', account, domains: [domain], activeRoute: '/metrics/logs', activeDomain: domain.name }, { canRead: true, canManage: true, logKinds: ['access', 'error'] })
  it('renders actual team data and retains the edit workflow without exposing its storage key', async () => {
    const send = vi.fn(async () => teamView), document = mount(teamHtml(), ACCOUNT_TEAM_CLIENT_BINDING, send)
    await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/account/team')
    const row = document.querySelector('[data-acct-team-rows] tr')!
    expect(row.textContent).toContain('sam@alice.test'); expect(row.textContent).toContain('sam@example.test'); expect(row.textContent).not.toContain(memberId)
    const edit = row.querySelector<HTMLButtonElement>('[data-action="edit"]')!
    expect(edit.classList.contains(theme === 'classic' ? 'xp-btn' : 'v2-btn')).toBe(true)
    edit.click()
    expect(document.querySelector<HTMLInputElement>('[data-acct-team-input="contactEmail"]')!.value).toBe('sam@example.test')
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('reads only the selected owned log and treats untrusted content as literal text', async () => {
    const send = vi.fn(async () => logsView), document = mount(logsHtml(), ACCOUNT_LOGS_CLIENT_BINDING, send)
    document.querySelector<HTMLButtonElement>('[data-logs-read]')!.click(); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/account/logs/' + domainId + '/access')
    const rows = document.querySelector('[data-logs-rows]')!
    expect(rows.textContent).toContain('GET alice.test/<img src=x>'); expect(rows.querySelector('img')).toBeNull()
    expect(rows.querySelector('bdi')?.classList.contains(theme === 'classic' ? 'xp-mono' : 'v2-mono')).toBe(true)
    expect(document.querySelectorAll('[data-logs-head] th')).toHaveLength(7)
  })
  for (const family of ['team', 'logs'] as const) for (const mode of ['missing', 'duplicate', 'missing-slot'] as const) {
    it('does not dispatch ' + family + ' requests for a ' + mode + ' template', async () => {
      const send = vi.fn(), name = family === 'team' ? 'acct-team-member' : 'account-logs-access'
      const document = mount(family === 'team' ? teamHtml() : logsHtml(), family === 'team' ? ACCOUNT_TEAM_CLIENT_BINDING : ACCOUNT_LOGS_CLIENT_BINDING, send, document => {
        const template = document.querySelector<HTMLTemplateElement>('template[data-xp-template="' + name + '"]')!
        if (mode === 'missing') template.remove()
        else if (mode === 'duplicate') template.after(template.cloneNode(true))
        else template.content.querySelector('[data-xp-slot]')!.remove()
      })
      document.querySelector<HTMLButtonElement>(family === 'team' ? '[data-acct-team-refresh]' : '[data-logs-read]')!.click(); await tick()
      expect(send).not.toHaveBeenCalled()
      expect([...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')].every(control => control.disabled)).toBe(true)
    })
  }
  for (const family of ['team', 'logs'] as const) it('keeps ' + family + ' inert inside a read-only boundary', async () => {
    const send = vi.fn(), document = mount('<div data-readonly="true">' + (family === 'team' ? teamHtml() : logsHtml()) + '</div>', family === 'team' ? ACCOUNT_TEAM_CLIENT_BINDING : ACCOUNT_LOGS_CLIENT_BINDING, send)
    document.querySelector<HTMLButtonElement>(family === 'team' ? '[data-acct-team-refresh]' : '[data-logs-read]')!.click(); await tick()
    expect(send).not.toHaveBeenCalled()
  })
})
