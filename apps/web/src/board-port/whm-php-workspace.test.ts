// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { renderWhmDetailPage } from './approved-xwhm.ts'
import { renderWhmComposerWorkspace } from './whm-composer-workspace.ts'
import { WHM_PHP_CLIENT_BINDING } from '../whm-php-client.ts'

const root = { kind: 'root' as const, id: 'synthetic-root', username: 'operator' }
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
beforeEach(() => { document.body.textContent = ''; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

function semanticTables(): void {
  const tables = [...document.querySelectorAll<HTMLTableElement>('table')]
  expect(tables.length).toBeGreaterThan(0)
  for (const table of tables) {
    // The shared Arabic phone fallback explicitly preserves native table semantics for this canonical class.
    expect(table.classList.contains('xp-table')).toBe(true)
    expect(table.tHead?.rows[0]?.cells.length).toBeGreaterThan(0)
    for (const cell of table.tHead!.rows[0]!.cells) expect(cell.scope).toBe('col')
    const region = table.closest<HTMLElement>('[role="region"]')
    expect(region?.tabIndex).toBe(0); expect(region?.getAttribute('aria-label')).toBeTruthy()
    for (const caption of table.querySelectorAll('caption')) { expect(caption.classList.contains('xp-sr-only')).toBe(true); expect(caption.textContent?.trim()).not.toBe('') }
  }
}

describe('PHP and Composer visual structure regressions', () => {
  it.each(['en', 'ar'] as const)('preserves %s unavailable PHP controls and complete semantic handler rows in a full-width sequence', locale => {
    document.body.innerHTML = renderWhmDetailPage({ activeRoute: '/whm/software/php', locale, principal: root, capabilityUnavailable: true })!
    semanticTables()
    const page = document.querySelector('[data-whm-detail-route="/whm/software/php"]')!
    expect(page.querySelectorAll('h1')).toHaveLength(1); expect(page.querySelector('aside')).toBeNull()
    expect([...page.querySelectorAll<HTMLElement>('[data-whm-detail-section]')].map(section => section.dataset.whmDetailSection)).toEqual(['php-versions', 'php-install', 'php-handlers', 'php-extensions', 'php-configure', 'php-functions'])
    const handlers = page.querySelector<HTMLTableElement>('[data-whm-detail-section="php-handlers"] table')!
    expect([...handlers.tBodies[0]!.rows].map(row => row.cells[0]!.textContent)).toEqual(['PHP-FPM', 'CGI / suexec', 'suPHP', 'lsphp'])
    for (const row of handlers.tBodies[0]!.rows) { expect(row.cells).toHaveLength(4); expect(row.cells[3]!.textContent).toBe(locale === 'ar' ? 'غير مقروء' : 'Not read') }
    expect(page.querySelectorAll('details')).toHaveLength(3)
    for (const details of page.querySelectorAll('details')) { details.open = true; expect(details.querySelector('summary')).not.toBeNull() }
    for (const name of ['php-selected-version', 'php-install-version', 'php-install-request', 'php-extension-version', 'php-version', 'php-ini', 'memory_limit', 'upload_max_filesize', 'post_max_size', 'max_execution_time', 'max_input_vars', 'php-exception-account', 'php-exception-reason']) expect(page.querySelector('[name="' + name + '"]')).not.toBeNull()
    for (const control of page.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')) expect(control.disabled).toBe(true)
    expect(page.querySelector('form')).toBeNull(); expect(page.querySelector('[data-whm-php-source]')!.tagName).toBe('BDI')
    expect(page.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it.each(['en', 'ar'] as const)('keeps actual %s PHP inventory binding functional after the visual markup change without enabling writes', async locale => {
    document.body.innerHTML = renderWhmDetailPage({ activeRoute: '/whm/software/php', locale, principal: root })!
    const paths: string[] = []
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = async (_method: string, path: string) => {
      paths.push(path)
      return path.endsWith('/inventory')
        ? { state: 'read', source: 'dpkg', observedAt: '2026-10-27T00:00:00.000Z', versions: [{ version: '8.3', supported: true, packages: [{ name: 'php8.3-cli', version: '8.3.12-1', component: 'cli' }, { name: 'php8.3-curl', version: '8.3.12-1', component: 'curl' }], binary: { state: 'read', scope: 'cli-without-ini', version: '8.3.12', sapi: 'cli', builtInExtensions: ['Core', 'json'] }, extensionEnablement: 'not-read', fpmRequest: 'not-read' }] }
        : { scope: 'saved-domain-configuration', observedRuntime: false, usage: [{ version: '8.3', domainCount: 1, domains: [{ name: 'example.test', account: 'alpha', handler: 'fpm' }] }] }
    }
    new Function('return ' + WHM_PHP_CLIENT_BINDING)()(); await tick()
    expect(paths).toEqual(['/api/server/php/inventory', '/api/server/php/usage']); semanticTables()
    expect(document.querySelector('[data-whm-php-source]')!.textContent).toBe('dpkg')
    expect(document.querySelector('[data-whm-php-usage]')!.textContent).toContain('example.test')
    for (const name of ['php-selected-version', 'php-extension-version', 'php-version']) { const select = document.querySelector<HTMLSelectElement>('[name="' + name + '"]')!; expect(select.value).toBe('8.3'); expect(select.disabled).toBe(false) }
    for (const button of document.querySelectorAll<HTMLButtonElement>('button:not([data-whm-php-refresh])')) expect(button.disabled).toBe(true)
    for (const control of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')) expect(control.disabled).toBe(true)
    expect(document.querySelector('[data-whm-detail-section="php-extensions"] tbody')!.textContent).toContain('php8.3-curl')
  })

  it.each(['en', 'ar'] as const)('retains %s Composer action, PHP, mirror and log controls while preserving the dependency table on phones', locale => {
    document.body.innerHTML = renderWhmComposerWorkspace({ locale, canRead: false }); semanticTables()
    const target = document.querySelector<HTMLSelectElement>('[data-composer-target]')!; expect(target.classList.contains('xp-select')).toBe(true); expect(target.disabled).toBe(true)
    for (const id of ['composer-action', 'composer-php-binary', 'composer-mirror']) expect(document.querySelector<HTMLInputElement | HTMLSelectElement>('#' + id)!.disabled).toBe(true)
    expect(document.querySelector('h4')!.textContent).toBeTruthy(); expect(document.querySelector('[data-composer-live-log][aria-live="polite"]')!.textContent).toBeTruthy()
    expect(document.querySelector<HTMLTableElement>('table')!.tHead!.rows[0]!.cells).toHaveLength(5)
    expect(document.querySelector('[data-composer-directory]')!.tagName).toBe('BDI'); expect(document.querySelector('[data-composer-directory]')!.getAttribute('dir')).toBe('ltr')
    expect(document.querySelector('form')).toBeNull(); expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})
