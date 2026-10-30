// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import type { Account, Domain } from '@xpanel/core'
import { translator } from './i18n.ts'
import { ACCOUNT_SSH_CLIENT_BINDING } from './account-ssh-client.ts'
import { ACCOUNT_SESSIONS_CLIENT_BINDING } from './account-sessions-client.ts'
import { ACCOUNT_VIRUS_SCAN_CLIENT_BINDING } from './account-virus-scan-client.ts'
import { ACCOUNT_GIT_CLIENT_BINDING } from './account-git-client.ts'
import { renderAccountSshWorkspace } from './board-port/account-ssh-workspace.ts'
import { renderAccountVirusScanWorkspace } from './board-port/account-virus-scan-workspace.ts'
import { renderAccountGitWorkspace } from './board-port/account-git-workspace.ts'
import { renderConnectedPanelSessions } from './board-port/approved-xpanel-bindings.ts'
import { renderV2AccountSshPage, renderV2VirusScannerPage } from './themes/v2/pages/xpanel/security/tools.ts'
import { renderV2AccountSecurityPage } from './themes/v2/pages/xpanel/security/account.ts'
import { renderV2AccountGitPage } from './themes/v2/pages/xpanel/operations/git.ts'

const account: Account = { id: '10000000-0000-4000-8000-000000000001', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test', planId: 'plan', ownerId: null, status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' }
const domain: Domain = { id: '20000000-0000-4000-8000-000000000001', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 0, processIdleTimeoutSec: 10 }, ini: {} }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' }
const props = { account, domains: [domain], locale: 'en' as const }
const allowed = { canRead: true, canManage: true }
const fp = 'SHA256:' + 'A'.repeat(43), instant = '2026-10-29T00:00:00Z', currentId = '30000000-0000-4000-8000-000000000001', otherId = '30000000-0000-4000-8000-000000000002'
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const install = (html: string, source: string, request: (method: string, path: string, body?: unknown) => Promise<unknown>, confirmation: unknown = async () => false) => {
  document.body.innerHTML = html
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  ;(new Function('return ' + source)() as (confirmation: unknown) => void)(confirmation)
}
const noClassicPaint = (root: Element, theme: string) => {
  if (theme === 'v2') expect([...root.querySelectorAll<HTMLElement>('[class]')].filter(node => [...node.classList].some(name => name.startsWith('xp-')))).toEqual([])
  expect(root.querySelector('[style]')).toBeNull()
}
let testDom: EnvironmentReturn | undefined
beforeEach(async () => {
  testDom = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://panel.example.test/', runScripts: 'outside-only' } })
  document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; vi.stubGlobal('xpT', translator('en'))
})
afterEach(async () => {
  try { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; vi.unstubAllGlobals(); vi.restoreAllMocks() }
  finally { await testDom?.teardown(globalThis); testDom = undefined }
})

describe('account utility theme-owned dynamic markup', () => {
  it.each(['classic', 'v2'])('keeps SSH row values and actions inside the selected %s templates', async theme => {
    const html = theme === 'classic' ? renderAccountSshWorkspace({ lang: 'en', accountId: account.id, username: account.username, canManage: true }) : renderV2AccountSshPage(props, allowed)
    const request = vi.fn(async () => ({ context: { accountId: account.id, username: account.username }, file: { path: '.ssh/authorized_keys', exists: true, sizeBytes: 90, mtime: instant, revision: 'a'.repeat(64), directory: { exists: true, kind: 'directory', mode: 0o700 } }, keys: [{ line: 1, type: 'ssh-ed25519', fingerprint: fp, comment: '<img src=x>', bits: 256, hasOptions: false, allowed: true }], unrecognizedLines: [], capacity: { maxKeys: 100, used: 1 }, login: { enabled: true, accountShell: 'jailed', planShell: 'jailed', port: 22, source: 'saved-configuration' }, capabilities: { canAdd: true, canRemove: true, reason: null }, application: { status: 'read', nativeQualified: false } }))
    install(html, ACCOUNT_SSH_CLIENT_BINDING, request); await tick()
    const rows = $('[data-ssh-rows]')
    expect(rows.querySelectorAll('td')).toHaveLength(5)
    expect(rows.querySelector('[data-xp-slot="fingerprint"]')?.textContent).toBe(fp)
    expect(rows.querySelector('[data-xp-slot="comment"]')?.textContent).toBe('<img src=x>')
    expect(rows.querySelector('img')).toBeNull()
    expect(rows.querySelector('button')?.classList.contains(theme === 'v2' ? 'v2-btn' : 'xp-btn')).toBe(true)
    noClassicPaint(rows, theme)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each(['missing', 'duplicate', 'wrong-slot'])('refuses %s SSH templates before an authenticated request', async defect => {
    document.body.innerHTML = renderAccountSshWorkspace({ lang: 'en', accountId: account.id, username: account.username, canManage: true })
    const row = $<HTMLTemplateElement>('template[data-xp-template="ssh-key-row"]')
    if (defect === 'missing') row.remove()
    if (defect === 'duplicate') row.after(row.cloneNode(true))
    if (defect === 'wrong-slot') row.content.querySelector('[data-xp-slot="fingerprint"]')!.removeAttribute('data-xp-slot')
    const request = vi.fn(async () => ({}))
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
    ;(new Function('return ' + ACCOUNT_SSH_CLIENT_BINDING)() as (dialog: unknown) => void)(async () => true)
    await tick()
    expect(request).not.toHaveBeenCalled()
    expect($('[data-ssh-status]').getAttribute('data-state')).toBe('unavailable')
    expect([...document.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true)
  })

  it.each(['classic', 'v2'])('keeps session facts under their named labels in %s and never uses a raw ID in confirmation', async theme => {
    const html = theme === 'classic' ? renderConnectedPanelSessions({ route: '/security/account', locale: 'en', readOnly: false } as never)! : renderV2AccountSecurityPage(props, allowed)
    const record = { id: currentId, current: true, ip: null, userAgent: null, mfaVerified: false, createdAt: instant, lastSeenAt: instant, expiresAt: '2026-10-30T00:00:00Z' }
    const request = vi.fn(async () => ({ sessions: [record, { ...record, id: otherId, current: false }], currentSessionId: currentId }))
    const confirmation = vi.fn(async () => false)
    install(html, ACCOUNT_SESSIONS_CLIENT_BINDING, request, confirmation); await tick()
    const rows = $('[data-sessions-rows]')
    expect(rows.querySelectorAll('article')).toHaveLength(2)
    expect(rows.querySelector('[data-xp-slot="network-label"]')?.textContent).toBe('Network')
    expect(rows.querySelector('[data-xp-slot="last-active"]')?.getAttribute('datetime')).toBe(instant)
    expect(rows.querySelectorAll('article:first-child button')).toHaveLength(0)
    $<HTMLButtonElement>('[data-sessions-rows] button').click(); await tick()
    expect(confirmation).toHaveBeenCalledWith(expect.objectContaining({ body: 'Unknown client' }))
    expect(JSON.stringify(confirmation.mock.calls)).not.toContain(otherId)
    noClassicPaint(rows, theme)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each(['classic', 'v2'])('preserves scan results, incomplete findings and escaped paths in %s', async theme => {
    const html = theme === 'classic' ? renderAccountVirusScanWorkspace({ lang: 'en', accountId: account.id, canManage: true }) : renderV2VirusScannerPage(props, allowed)
    const request = vi.fn(async () => ({ context: { accountId: account.id, username: account.username }, observedAt: instant, jobsAvailable: true, engine: { state: 'read', version: '1.0.7', signatureVersion: 27440, signatureDate: 'Thu Oct 29 00:00:00 2026' }, limits: { history: 10, cooldownMinutes: 15, findingsPerScan: 50 }, start: { allowed: true, reason: null, availableAt: null }, scans: [{ jobId: '40000000-0000-4000-8000-000000000001', status: 'succeeded', result: 'infected', createdAt: instant, finishedAt: '2026-10-29T00:01:00Z', listComplete: false, summary: { knownViruses: 1, engineVersion: '1.0.7', scannedDirectories: 2, scannedFiles: 312, infectedFiles: 1, dataScanned: '1 MB', time: '1 sec' }, infected: [{ path: 'public_html/<img src=x>.php', signature: 'Php.Webshell-1' }] }], started: null }))
    install(html, ACCOUNT_VIRUS_SCAN_CLIENT_BINDING, request); await tick()
    const rows = $('[data-vscan-rows]')
    expect(rows.querySelector('[data-xp-slot="infected"]')?.textContent).toBe('1')
    expect(rows.querySelector('[data-xp-slot="path"]')?.textContent).toBe('~/public_html/<img src=x>.php')
    expect(rows.querySelector('[data-xp-slot="notice"]')?.textContent).toBe('This list may be incomplete.')
    expect(rows.querySelector('[data-xp-slot="notice"]')?.hasAttribute('hidden')).toBe(false)
    expect(rows.querySelector('img')).toBeNull()
    noClassicPaint(rows, theme)
  })

  it.each(['classic', 'v2'])('fills Git history by name rather than column ordinal in %s', async theme => {
    const html = theme === 'classic' ? renderAccountGitWorkspace({ lang: 'en', accountId: account.id, canManage: true }) : renderV2AccountGitPage(props, allowed)
    const hash = 'a'.repeat(40)
    const request = vi.fn(async (method: string) => ({ context: { accountId: account.id, username: account.username }, revision: 'a'.repeat(64), repositories: ['repo'], nativeAvailable: true, selected: method === 'GET' ? null : { path: 'repo', branch: 'main', head: hash, dirty: false, changedFiles: 0, remote: null, branches: [{ name: 'main', hash, current: true }], commits: [{ hash, at: instant, subject: '<img src=x> release 1' }] }, application: { op: method === 'GET' ? 'list' : 'inspect', state: 'read', verificationRequired: false } }))
    install(html, ACCOUNT_GIT_CLIENT_BINDING, request); await tick()
    $<HTMLButtonElement>('[data-git-inspect]').click(); await tick()
    const rows = $('[data-git-history]')
    expect(rows.querySelector('[data-xp-slot="hash"]')?.textContent).toBe(hash)
    expect(rows.querySelector('[data-xp-slot="at"]')?.getAttribute('datetime')).toBe(instant)
    expect(rows.querySelector('[data-xp-slot="subject"]')?.textContent).toBe('<img src=x> release 1')
    expect(rows.querySelector('img')).toBeNull()
    noClassicPaint(rows, theme)
    expect(ACCOUNT_GIT_CLIENT_BINDING).not.toContain('row.cells[')
  })
})
