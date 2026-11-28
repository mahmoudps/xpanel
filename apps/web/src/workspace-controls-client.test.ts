// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FPM, defaultPlan, type Account, type Database, type Domain } from '@xpanel/core'
import { tools } from '@xpanel/catalog'
import { nonliteralSelectorSites } from '../../../scripts/theme-controller-audit.mjs'
import { renderV2WhmPhp } from './themes/v2/pages/xwhm/host/php.ts'
import { renderV2PanelPhpPage } from './themes/v2/pages/xpanel/software/php.ts'
import { renderV2PanelResources } from './themes/v2/pages/xpanel/resources.ts'
import { renderV2CronPage } from './themes/v2/pages/xpanel/services/cron.ts'
import { renderV2DomainsPage } from './themes/v2/pages/xpanel/domains/domains.ts'
import { renderV2MariaDbPage } from './themes/v2/pages/xpanel/databases/mariadb.ts'
import { renderV2WhmIo, renderV2WhmTraffic } from './themes/v2/pages/xwhm/monitoring/resources.ts'
import { renderV2WhmAddonServices } from './themes/v2/pages/xwhm/software/containers.ts'
import { renderV2WhmSecurityTool } from './themes/v2/pages/xwhm/security/tools.ts'
import { WORKSPACE_CONTROLS_CLIENT_BINDING } from './workspace-controls-client.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const account: Account = {
  id: '10000000-0000-4000-8000-000000000001',
  username: 'alice',
  uid: 20014,
  gid: 20014,
  home: '/home/alice',
  primaryDomain: 'alice.example',
  planId: 'plan-1',
  ownerId: null,
  status: 'active',
  suspendReason: null,
  contactEmail: 'alice@alice.example',
  ipv4: '192.0.2.10',
  shell: 'jailed',
  createdAt: '2026-10-29T00:00:00Z',
}

const domain: Domain = {
  id: '20000000-0000-4000-8000-000000000002',
  accountId: account.id,
  name: 'alice.example',
  kind: 'primary',
  parentId: null,
  docRoot: '/home/alice/public_html',
  siteType: 'php',
  upstream: null,
  redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { ...DEFAULT_FPM }, ini: { memory_limit: '128M' } },
  wildcard: false,
  certificateId: null,
  suspended: false,
  expiresAt: null,
  pathQuotaMb: 'unlimited',
}

const database: Database = {
  id: '30000000-0000-4000-8000-000000000003',
  accountId: account.id,
  name: 'alice_app',
  engine: 'mariadb',
  trashedAt: null,
}

const plan = defaultPlan({ id: 'plan-1', name: 'Starter' })
const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const rootPrincipal = { kind: 'root' as const, id: '40000000-0000-4000-8000-000000000004', username: 'root' }
const rootAuthority = { canRead: true, canManage: true }

const mount = () => {
  new Function('return ' + WORKSPACE_CONTROLS_CLIENT_BINDING)()()
}

beforeEach(() => {
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
  document.documentElement.dir = 'ltr'
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  })
})

describe('workspace controls client hygiene and selectors', () => {
  it('uses zero dynamic selectors, zero innerHTML, zero style attributes, and clean naming', () => {
    const clientSource = readFileSync(join(HERE, 'workspace-controls-client.ts'), 'utf8')
    const routeSource = readFileSync(join(HERE, '../../api/src/workspace-controls-routes.ts'), 'utf8')
    expect(nonliteralSelectorSites(clientSource)).toEqual([])
    expect(clientSource).not.toContain('innerHTML')
    expect(clientSource).not.toMatch(/\bstyle=/)
    expect(clientSource).not.toMatch(/Not read|Not observed/)
    const forbidden = /(?:^|[_-])(smart|legacy|hero|magic|super|v[0-9]+)(?:$|[_-])/i
    for (const src of [clientSource, routeSource]) {
      for (const m of src.matchAll(/\bexport\s+(?:const|function|class|type|interface)\s+([A-Za-z0-9_]+)/g)) {
        expect(forbidden.test(m[1]!)).toBe(false)
      }
    }
  })
})

describe('workspace controls client DOM bindings', () => {
  it('wires WHM and account PHP INI preview, apply, and copy controls', async () => {
    const req = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/api/server/php/ini') {
        return { version: '8.3', ini: { memory_limit: '256M' }, previewText: '[PHP]\nmemory_limit = 256M', revision: 'a'.repeat(64) }
      }
      if (method === 'POST' && path === '/api/server/php/ini/preview') {
        return { version: '8.3', ini: { display_errors: 'Off' }, previewText: '[PHP]\ndisplay_errors = Off', revision: 'a'.repeat(64) }
      }
      if (method === 'POST' && path === '/api/server/php/ini/apply') {
        return { version: '8.3', ini: { display_errors: 'Off' }, previewText: '[PHP]\ndisplay_errors = Off', revision: 'b'.repeat(64) }
      }
      if (method === 'POST' && path.startsWith('/api/account/php/ini/')) {
        return { previewText: '[PHP]\nmax_input_vars = 3000\ndisplay_errors = Off' }
      }
      return {}
    })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = req

    document.body.innerHTML = renderV2WhmPhp({ principal: rootPrincipal, catalog, locale: 'en' })
    mount()
    await Promise.resolve()

    document.querySelector<HTMLInputElement>('[data-wc-whm-php-ini="display_errors"]')!.value = 'Off'
    document.querySelector<HTMLButtonElement>('[data-wc-whm-php-preview-btn]')!.click()
    await vi.waitFor(() => expect(req).toHaveBeenCalledWith('POST', '/api/server/php/ini/preview', expect.any(Object)))
    expect(document.querySelector('[data-wc-whm-php-preview-region]')!.textContent).toContain('display_errors = Off')
    const copyBtn = document.querySelector<HTMLButtonElement>('[data-php-ini-copy]')!
    expect(copyBtn.disabled).toBe(false)
    copyBtn.click()
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled())

    document.querySelector<HTMLButtonElement>('[data-wc-whm-php-apply-btn]')!.click()
    await vi.waitFor(() => expect(req).toHaveBeenCalledWith('POST', '/api/server/php/ini/apply', expect.objectContaining({ expectedRevision: 'a'.repeat(64) })))

    document.body.innerHTML = renderV2PanelPhpPage({ account, domains: [domain], activeRoute: '/software/php' }, rootAuthority)
    mount()
    document.querySelector<HTMLInputElement>('#v2-php-max-input')!.value = '3000'
    document.querySelector<HTMLButtonElement>('[data-wc-panel-php-preview-btn]')!.click()
    await vi.waitFor(() => expect(req).toHaveBeenCalledWith('POST', '/api/account/php/ini/preview', expect.any(Object)))
    expect(document.querySelector('[data-wc-panel-php-preview-region]')!.textContent).toContain('max_input_vars = 3000')
    document.querySelector<HTMLButtonElement>('[data-wc-panel-php-apply-btn]')!.click()
    await vi.waitFor(() => expect(req).toHaveBeenCalledWith('POST', '/api/account/php/ini/apply', expect.any(Object)))
  })

  it('wires account resource folder scan, IO toggles, and cron preview/MAILTO controls', async () => {
    const req = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/api/account/resources/folders') {
        return { state: 'read', totalBytes: 2048, truncated: false, folders: [{ path: '~/public_html', sizeBytes: 2048, sharePercent: 100, itemCount: 2 }] }
      }
      if (method === 'GET' && path === '/api/account/cron/mailto') {
        return { mailto: 'ops@alice.example', mode: 'failures', revision: 'c'.repeat(64) }
      }
      if (method === 'POST' && path === '/api/account/cron/preview') {
        return { nextRuns: ['2026-11-20T12:05:00.000Z', '2026-11-20T12:10:00.000Z'] }
      }
      if (method === 'PUT' && path === '/api/account/cron/mailto') {
        return { mailto: null, mode: 'never', revision: 'd'.repeat(64) }
      }
      return {}
    })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = req

    document.body.innerHTML = renderV2PanelResources({ account, plan, liveResourcesAvailable: true })
    mount()
    document.querySelector<HTMLButtonElement>('[data-wc-resource-folders-refresh]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-wc-resource-folders-rows]')!.textContent).toContain('~/public_html'))
    const readBtn = document.querySelector<HTMLButtonElement>('[data-wc-resource-io-dir="read"]')!
    readBtn.click()
    expect(readBtn.getAttribute('aria-pressed')).toBe('true')

    document.body.innerHTML = renderV2CronPage({ account }, { canManage: true })
    mount()
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[data-wc-cron-mailto-input]')!.value).toBe('ops@alice.example'))
    document.querySelector<HTMLButtonElement>('[data-wc-cron-preview-btn]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-wc-cron-next-runs]')!.textContent).toContain('2026-11-20T12:05:00.000Z'))
    document.querySelector<HTMLButtonElement>('[data-wc-cron-mailto-clear]')!.click()
    await vi.waitFor(() => expect(req).toHaveBeenCalledWith('PUT', '/api/account/cron/mailto', expect.objectContaining({ mailto: null })))
  })

  it('wires domain controls, MariaDB inspection/SQL preview, monitoring history, add-on config, and antivirus remediation', async () => {
    const req = vi.fn(async (method: string, path: string) => {
      if (path.endsWith('/certificate')) return { covered: true, forceHttps: false, certificate: { issuer: 'LE', notAfter: '2027-12-31T00:00:00.000Z' } }
      if (path === '/api/account/domains/rename-primary') return { primaryDomain: 'alice-next.example' }
      if (path === '/api/account/databases/inspect') return { databases: [{ id: database.id, name: database.name, charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', tableCount: 4, sizeBytes: 4096 }] }
      if (path === '/api/account/databases/sql-preview') return { sqlPreview: 'CREATE DATABASE `alice_shop` CHARACTER SET utf8mb4;', connectionSnippet: '$pdo = new PDO(...);' }
      if (path.endsWith('/charset')) return { sqlPreview: 'ALTER DATABASE `alice_app` CHARACTER SET = utf8mb4 COLLATE = utf8mb4_general_ci;' }
      if (path === '/api/server/monitoring/history?kind=traffic') return { samples: [{ observedAt: '2026-11-20T12:00:00.000Z', rxBps: 500, txBps: 900, summary: 'eth0' }] }
      if (path === '/api/server/monitoring/history?kind=io') return { samples: [{ observedAt: '2026-11-20T12:00:00.000Z', readBps: 100, writeBps: 200, iops: 5, summary: 'nvme0n1' }] }
      if (method === 'GET' && path === '/api/server/software/addon-services/config') {
        return { revision: 'e'.repeat(64), services: [{ serviceId: 'memcached', memoryLimitMb: 512, bindAddress: '127.0.0.1', maxConnections: 1024, previewText: '[Service]\nMemoryMax=512M' }] }
      }
      if (method === 'POST' && path === '/api/server/software/addon-services/config') {
        return { revision: 'f'.repeat(64), previewText: '[Service]\nMemoryMax=768M' }
      }
      if (path.startsWith('/api/server/security-tools/antivirus/')) return { account: 'alice', path: 'public_html/bad.php' }
      return {}
    })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = req

    // Domains
    document.body.innerHTML = renderV2DomainsPage({ account, domains: [domain] }, rootAuthority)
    mount()
    const rowSwitch = document.querySelector<HTMLInputElement>('[data-wc-domain-row-https]')!
    rowSwitch.checked = true
    rowSwitch.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(req).toHaveBeenCalledWith('POST', `/api/account/domains/${domain.id}/force-https`, { enabled: true }))

    document.querySelector<HTMLElement>('[data-domain-selected-name]')!.textContent = 'alice.example'
    document.querySelector<HTMLButtonElement>('[data-wc-domain-cert-inspect]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-wc-domain-cert-status]')!.textContent).toContain('LE'))
    document.querySelector<HTMLInputElement>('[data-wc-domain-redirect-to]')!.value = 'https://target.example/'
    document.querySelector<HTMLButtonElement>('[data-wc-domain-redirect-save]')!.click()
    await vi.waitFor(() => expect(req).toHaveBeenCalledWith('PUT', `/api/account/domains/${domain.id}/redirect`, { to: 'https://target.example/', code: 301 }))

    document.querySelector<HTMLInputElement>('[data-wc-domain-rename-new]')!.value = 'alice-next.example'
    document.querySelector<HTMLInputElement>('[data-wc-domain-rename-confirm]')!.value = 'alice.example'
    document.querySelector<HTMLButtonElement>('[data-wc-domain-rename-submit]')!.click()
    await vi.waitFor(() => expect(req).toHaveBeenCalledWith('POST', '/api/account/domains/rename-primary', expect.objectContaining({ newDomain: 'alice-next.example' })))

    // MariaDB
    document.body.innerHTML = renderV2MariaDbPage({ account, databases: [database] }, rootAuthority)
    mount()
    document.querySelector<HTMLButtonElement>('[data-wc-db-inspect-btn]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-wc-db-inspect-status]')!.textContent).toContain('1'))
    document.querySelector<HTMLButtonElement>('[data-wc-db-create-sql-btn]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-wc-db-create-sql-preview]')!.textContent).toContain('CREATE DATABASE'))
    document.querySelector<HTMLButtonElement>('[data-wc-dbu-sql-preview-btn]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-v2-db-sql-preview="create-user"]')!.textContent).toContain('CREATE DATABASE'))
    document.querySelector<HTMLSelectElement>('[data-wc-db-inspect-select]')!.value = database.id
    document.querySelector<HTMLButtonElement>('[data-wc-db-alter-apply-btn]')!.click()
    await vi.waitFor(() => expect(req).toHaveBeenCalledWith('PUT', `/api/account/databases/${database.id}/charset`, expect.any(Object)))

    // Monitoring traffic & IO
    document.body.innerHTML = renderV2WhmTraffic({ principal: rootPrincipal, catalog, observationAuthority: rootAuthority })
    mount()
    document.querySelector<HTMLButtonElement>('[data-wc-history-refresh="traffic"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-wc-history-rows="traffic"]')!.textContent).toContain('eth0'))

    document.body.innerHTML = renderV2WhmIo({ principal: rootPrincipal, catalog, observationAuthority: rootAuthority })
    mount()
    document.querySelector<HTMLButtonElement>('[data-wc-history-refresh="io"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-wc-history-rows="io"]')!.textContent).toContain('nvme0n1'))

    // Add-on services config
    document.body.innerHTML = renderV2WhmAddonServices({ principal: rootPrincipal, catalog, dataAuthority: rootAuthority })
    mount()
    document.querySelector<HTMLButtonElement>('[data-wc-addon-config-read]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-wc-addon-config-output]')!.textContent).toContain('MemoryMax=512M'))
    document.querySelector<HTMLInputElement>('[data-wc-addon-memory]')!.value = '768'
    document.querySelector<HTMLButtonElement>('[data-wc-addon-config-apply]')!.click()
    await vi.waitFor(() => expect(req).toHaveBeenCalledWith('POST', '/api/server/software/addon-services/config', expect.objectContaining({ mode: 'apply', memoryLimitMb: 768 })))

    // Antivirus remediation
    document.body.innerHTML = renderV2WhmSecurityTool({ principal: rootPrincipal, catalog, observationAuthority: rootAuthority }, 'antivirus')
    mount()
    document.querySelector<HTMLInputElement>('[data-wc-av-account]')!.value = 'alice'
    document.querySelector<HTMLInputElement>('[data-wc-av-path]')!.value = 'public_html/bad.php'
    document.querySelector<HTMLButtonElement>('[data-wc-av-quarantine]')!.click()
    await vi.waitFor(() => expect(req).toHaveBeenCalledWith('POST', '/api/server/security-tools/antivirus/quarantine', { account: 'alice', path: 'public_html/bad.php' }))
    document.querySelector<HTMLButtonElement>('[data-wc-av-delete]')!.click()
    await vi.waitFor(() => expect(req).toHaveBeenCalledWith('POST', '/api/server/security-tools/antivirus/delete', { account: 'alice', path: 'public_html/bad.php' }))
  })

  it('refuses write requests when mounted inside a read-only frame', async () => {
    const req = vi.fn(async () => ({}))
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = req

    document.body.innerHTML = renderV2CronPage({ account }, { canManage: false, presentation: 'read-only' })
    mount()
    document.querySelector<HTMLButtonElement>('[data-wc-cron-preview-btn]')?.click()
    await Promise.resolve()
    expect(req).not.toHaveBeenCalled()
  })
})
