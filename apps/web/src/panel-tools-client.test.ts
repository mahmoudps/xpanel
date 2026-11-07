// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { PANEL_TOOLS_CLIENT_BINDING } from './panel-tools-client.ts'
import { renderToolCard } from './board-port/tool-card-view.ts'
import { apiShellCard, configAsCodeCard, metricsExportCard, panelBackupsCard, pearPackagesCard, projectsCard, pythonRuntimesCard } from './models/tool-cards.ts'
import type { ToolCard } from './models/tool-cards.ts'
import { renderV2ToolCard } from './themes/v2/tool-card-view.ts'
import { translator } from './i18n.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const tick = async () => { for (let index = 0; index < 12; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const boot = async (card: ToolCard, theme: 'classic' | 'v2', send: Send, canManage = true) => {
  document.body.innerHTML = theme === 'classic' ? renderToolCard({ locale: 'en', canManage }, card) : renderV2ToolCard(translator('en'), card, canManage)
  ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + PANEL_TOOLS_CLIENT_BINDING)()(async () => true)
  await tick()
}

describe.each(['classic', 'v2'] as const)('panel tool controllers in %s', theme => {
  it('reads and saves the metrics settings against the revision', async () => {
    const view = { config: { enabled: false, allow: [] }, invalid: false, revision: 'r1', path: '/api/metrics', scope: 'metrics:read' }
    const send = vi.fn<Send>(async (method, _path, body) => method === 'GET' ? view : { ...view, config: (body as { config: unknown }).config, revision: 'r2' })
    await boot(metricsExportCard, theme, send)
    expect($('[data-metrics-fact="path"]').textContent).toBe('/api/metrics')
    $<HTMLInputElement>('[data-metrics-enabled]').checked = true; $<HTMLTextAreaElement>('[data-metrics-allow]').value = '192.0.2.1\n'
    $('[data-metrics-save]').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('PUT', '/api/server/metrics-export', { config: { enabled: true, allow: ['192.0.2.1'] }, expectedRevision: 'r1' })
    expect($('[data-metrics-status]').textContent).toBe('The endpoint is on.')
  })
  it('stays disabled and reads nothing without authority', async () => {
    const send = vi.fn<Send>(async () => ({}))
    await boot(metricsExportCard, theme, send, false)
    expect(send).not.toHaveBeenCalled(); expect($<HTMLButtonElement>('[data-metrics-save]').disabled).toBe(true)
  })
  it('previews a config import and applies against the previewed revision', async () => {
    const send = vi.fn<Send>(async (_method, path) => path.endsWith('preview') ? { revision: 'r', applicable: true, changes: [{ path: 'plans/a.yaml', kind: 'changed', reason: null, fields: [{ field: 'resources.diskMb', from: 1, to: 2 }] }] } : { applied: 1 })
    await boot(configAsCodeCard, theme, send)
    const input = $<HTMLInputElement>('[data-config-file]')
    Object.defineProperty(input, 'files', { value: [new File(['# xpanel-file: plans/a.yaml\nname: a\n'], 'c.yaml')] })
    $('[data-config-preview]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/config-as-code/preview', { files: { 'plans/a.yaml': 'name: a\n' } })
    expect($('[data-config-changes]').textContent).toContain('resources.diskMb')
    $('[data-config-apply]').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/config-as-code/apply', { files: { 'plans/a.yaml': 'name: a\n' }, expectedRevision: 'r' })
  })
  it('restores a snapshot and lists what it skipped', async () => {
    const send = vi.fn<Send>(async (method) => method === 'GET' ? { folder: '/b/_control', backups: [{ file: 'xpanel-control-20261107T000000Z.tar.gz', bytes: 2048, createdAt: '2026-11-07T00:00:00.000Z' }] } : { restored: 1, skipped: 1, skippedItems: ['plans/a.json'], reconcile: 'applied' })
    await boot(panelBackupsCard, theme, send)
    expect($('[data-panel-backup-rows]').textContent).toContain('2026-11-07 00:00')
    $<HTMLSelectElement>('[data-panel-backup-select]').value = 'xpanel-control-20261107T000000Z.tar.gz'
    $('[data-panel-backup-action="restore"]').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/panel-backups', { op: 'restore', file: 'xpanel-control-20261107T000000Z.tar.gz', overwrite: false })
    expect($('[data-panel-backup-report]').textContent).toBe('plans/a.json'); expect($('[data-panel-backup-status]').textContent).toBe('1 restored, 1 skipped.')
  })
  it('runs a shell call and shows tree, table and raw apart from the headers', async () => {
    const send = vi.fn<Send>(async (method) => method === 'GET' ? { command: 'xwhmapi', functions: [{ module: 'plans', fn: 'list', method: 'GET', path: '/api/plans', params: [] }] } : { status: 200, headers: [['content-type', 'application/json']], json: { plans: [{ id: 'a' }] }, raw: '{"plans":[{"id":"a"}]}', pagination: { start: 0, limit: 1, total: 3, returned: 1 } })
    await boot(apiShellCard('administrator'), theme, send)
    const fn = $<HTMLSelectElement>('[data-shell-function]'); fn.value = 'plans.list'; fn.dispatchEvent(new Event('change'))
    expect($('[data-shell-cli]').textContent).toBe('xwhmapi plans list')
    $<HTMLInputElement>('[data-shell-limit]').value = '1'
    $('[data-shell-run]').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/panel/developer/call', { module: 'plans', fn: 'list', params: {}, shape: { start: 0, limit: 1 } })
    expect($('[data-shell-status]').textContent).toBe('HTTP 200: 1 of 3 records.')
    expect($('[data-shell-tree]').textContent).toContain('id: a'); expect($('[data-shell-table]').textContent).toBe('a')
    const view = $<HTMLSelectElement>('[data-shell-view]'); view.value = 'raw'; view.dispatchEvent(new Event('change'))
    expect($('[data-shell-headers]').hidden).toBe(false); expect($('[data-shell-headers]').textContent).toContain('content-type: application/json'); expect($('[data-shell-raw]').textContent).toContain('"plans"')
  })
  it('saves a project for the chosen account and names a refusal', async () => {
    const view = { available: true, jdks: [], python: [], accounts: [{ account: 'alpha', revision: 'r', domains: [{ id: 'd', name: 'a.test' }], projects: [], environments: [] }] }
    const send = vi.fn<Send>(async method => { if (method === 'GET') return view; throw { details: { reason: 'NOT_EXECUTABLE' } } })
    await boot(projectsCard, theme, send)
    const account = $<HTMLSelectElement>('[data-sw-project-account]'); account.value = 'alpha'; account.dispatchEvent(new Event('change'))
    $<HTMLInputElement>('[data-sw-project-name]').value = 'svc'; $<HTMLSelectElement>('[data-sw-project-domain]').value = 'd'; $<HTMLInputElement>('[data-sw-project-root]').value = 'apps/svc'; $<HTMLInputElement>('[data-sw-project-startup]').value = 'server'
    $('[data-sw-project-save]').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/application-projects', { account: 'alpha', op: { op: 'project.save', expectedRevision: 'r', app: { name: 'svc', runtime: 'go', root: 'apps/svc', startup: 'server', domainId: 'd', path: '/', env: {}, port: null, openPort: false, jdk: null, command: null } } })
    expect($('[data-sw-project-status]').textContent).toBe('This file has no execute permission.')
  })
  it('creates a named Python environment from an installed version', async () => {
    const view = { available: true, python: [{ version: '3.12', installed: true, full: '3.12.1' }, { version: '3.11', installed: false, full: null }], accounts: [{ account: 'alpha', revision: 'r', domains: [], projects: [], environments: [] }] }
    const send = vi.fn<Send>(async () => view)
    await boot(pythonRuntimesCard, theme, send)
    expect([...$<HTMLSelectElement>('[data-python-env-version]').options].map(item => item.value)).toEqual(['', '3.12'])
    $<HTMLSelectElement>('[data-python-env-account]').value = 'alpha'; $<HTMLSelectElement>('[data-python-env-version]').value = '3.12'; $<HTMLInputElement>('[data-python-env-name]').value = 'web'
    $('[data-python-env-create]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/application-projects', { account: 'alpha', op: { op: 'pyenv.create', expectedRevision: 'r', name: 'web', version: '3.12' } })
  })
  it('installs a PEAR package and paints the answer', async () => {
    const base = { library: '/home/a/php', phpVersion: '8.3', includeSnippet: "ini_set('x')", engine: true, requiredPackage: 'php-pear', revision: 'r', system: [{ name: 'PEAR', version: null }], results: [] }
    const send = vi.fn<Send>(async method => method === 'GET' ? { ...base, packages: [] } : { ...base, revision: 'q', packages: [{ name: 'Config_Lite', version: '0.2.6' }] })
    await boot(pearPackagesCard('a'), theme, send)
    expect($('[data-packages-library]').textContent).toBe('/home/a/php'); expect($('[data-packages-system]').textContent).toContain('PEAR')
    $<HTMLInputElement>('[data-packages-name]').value = 'Config_Lite'
    $('[data-package-op="install"]').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/account/packages', { op: 'install', name: 'Config_Lite', expectedRevision: 'r' })
    expect($('[data-packages-installed]').textContent).toContain('Config_Lite')
  })
})
