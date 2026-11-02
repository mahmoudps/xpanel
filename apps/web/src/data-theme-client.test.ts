/// <reference lib="dom" />
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultPlan, msgctxt, msgid, type Account, type Domain } from '@xpanel/core'
import { translator } from './i18n.ts'
import { DATABASE_WORKSPACE_CLIENT_BINDING } from './database-workspace-client.ts'
import { ACCOUNT_DATABASE_INSIGHTS_CLIENT_BINDING } from './account-database-insights-client.ts'
import { ACCOUNT_DATABASE_REMOTE_CLIENT_BINDING } from './account-database-remote-client.ts'
import { DB_ENGINES_CLIENT_BINDING } from './db-engines-client.ts'
import { ZONE_EDITOR_CLIENT_BINDING } from './zone-editor-client.ts'
import { ACCOUNT_SSL_CLIENT_BINDING } from './account-ssl-client.ts'
import { ACCOUNT_CRON_CLIENT_BINDING } from './account-cron-client.ts'
import { WHM_DNS_CLIENT_BINDING } from './whm-dns-client.ts'
import { WHM_DNS_TOOLS_CLIENT_BINDING } from './whm-dns-tools-client.ts'
import { WHM_SSL_CLIENT_BINDING } from './whm-ssl-client.ts'
import { WHM_SSL_INSTALL_CLIENT_BINDING } from './whm-ssl-install-client.ts'
import { WHM_DATABASES_CLIENT_BINDING } from './whm-databases-client.ts'
import { DB_TUNING_VARIABLES, DB_TUNING_STATUS, WHM_DATABASE_TUNING_CLIENT_BINDING } from './whm-database-tuning-client.ts'
import { buildDatabaseTuningView, type DatabaseTuningVariables, type DatabaseTuningStatus } from '../../agent/src/database-tuning.ts'
import { renderAccountDatabases } from './board-port/extensions/account-databases.ts'
import { renderAccountDatabaseInsightsWorkspace } from './board-port/account-database-insights-workspace.ts'
import { renderAccountDatabaseRemoteWorkspace } from './board-port/account-database-remote-workspace.ts'
import { renderAccountDbEngineWorkspace } from './board-port/db-engines-workspace.ts'
import { renderApprovedXpanelWorkspace } from './board-port/approved-xpanel-workspaces.ts'
import { renderAccountCronWorkspace } from './board-port/account-cron-workspace.ts'
import { renderWhmDnsWorkspace } from './board-port/whm-dns-workspace.ts'
import { renderWhmDnsToolsWorkspace } from './board-port/whm-dns-tools-workspace.ts'
import { renderWhmSslWorkspace } from './board-port/whm-ssl-workspace.ts'
import { renderWhmSslInstallWorkspace, renderWhmSslInstallChoices } from './board-port/whm-ssl-install-workspace.ts'
import { renderWhmDatabasesWorkspace } from './board-port/whm-databases-workspace.ts'
import { renderWhmDatabaseTuningWorkspace } from './board-port/whm-database-tuning-workspace.ts'
import { renderV2MariaDbPage, renderV2DatabaseInsightsPage, renderV2DatabaseRemotePage, renderV2PostgreSqlPage } from './themes/v2/pages/xpanel/databases/index.ts'
import { renderV2DnsPage } from './themes/v2/pages/xpanel/services/dns.ts'
import { renderV2TlsPage } from './themes/v2/pages/xpanel/services/tls.ts'
import { renderV2CronPage } from './themes/v2/pages/xpanel/services/cron.ts'
import { renderV2WhmDnsPage } from './themes/v2/pages/xwhm/dns/index.ts'
import { renderV2WhmDnsToolsPage } from './themes/v2/pages/xwhm/dns/tools.ts'
import { renderV2WhmTlsPage } from './themes/v2/pages/xwhm/tls/index.ts'
import { renderV2WhmTlsInstallPage } from './themes/v2/pages/xwhm/tls/install.ts'
import { renderV2WhmDatabasePage } from './themes/v2/pages/xwhm/databases/index.ts'

const id = (value: number): string => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(value).padStart(12, '0')
const at = '2026-10-29T10:00:00.000Z', revision = 'a'.repeat(64)
const account: Account = { id: id(1), username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'example.test', planId: 'plan', ownerId: null, status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'none', createdAt: at }
const domain: Domain = { id: id(2), accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' }
const plan = defaultPlan({ id: account.planId, name: 'Standard', featureListId: 'features' })
const props = { account, domains: [domain], plan }
const authority = { canRead: true, canManage: true }
const whm = { accounts: [account], domains: [domain], dataAuthority: { ...authority, canKill: true } }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
type TestDom = { window: Window & typeof globalThis }
const requireFromHarness = createRequire(createRequire(import.meta.url).resolve('vitest'))
const { JSDOM } = requireFromHarness('jsdom') as { JSDOM: new (html: string, options: { url: string; runScripts: 'outside-only' }) => TestDom }
const doms: TestDom[] = []
const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
function mount(html: string, binding: string, send: (method: string, path: string, body?: unknown) => Promise<unknown>, ask: (options: Record<string, unknown>) => Promise<unknown> = async () => false, before?: (document: Document) => void) {
  const dom = new JSDOM(html, { url: 'https://panel.example.test/', runScripts: 'outside-only' }); doms.push(dom)
  Object.assign(dom.window, { msgid, msgctxt, xpT: translator('en'), xpanelSessionRequest: send })
  before?.(dom.window.document)
  const boot = dom.window.Function('return ' + binding)() as (ask: unknown, rtl?: boolean) => void
  boot(ask, false)
  return { dom, document: dom.window.document, boot }
}
afterEach(() => { for (const dom of doms.splice(0)) dom.window.close() })
const certificate = { id: id(3), accountId: account.id, username: account.username, names: [domain.name, 'www.' + domain.name], source: 'acme', challenge: 'http-01', notBefore: null, notAfter: '2028-01-01T00:00:00.000Z', autoRenew: true, fingerprintSha256: 'a'.repeat(64), renewedAt: null, assignedDomains: [domain.name] }
const sslView = () => ({ revision: 7, accounts: [{ id: account.id, username: account.username, status: 'active' }], domains: [{ id: domain.id, accountId: account.id, name: domain.name, certificateId: certificate.id }], certificates: [clone(certificate)], capabilities: { issue: true, renew: true, install: true, remove: true }, renewalScheduler: { state: 'unavailable' } })
const zone = () => ({ id: id(4), accountId: account.id, name: domain.name, serial: 7, records: [{ id: id(5), name: '@', type: 'A', ttl: 0, content: '192.0.2.10', priority: null }], revision })
const classicPanel = (route: '/domains/zone-editor' | '/security/ssl') => renderApprovedXpanelWorkspace({ route, locale: 'en', readOnly: false, account, domains: [domain], certificates: [certificate], visibility: { principal: { kind: 'user', id: id(9), username: account.username, accountId: account.id } }, catalog: [{ id: route === '/security/ssl' ? 'ssl-certificates' : 'dns-zone-records', status: 'verified' }] } as never)!

describe.each(['classic', 'v2'] as const)('%s database and service controller templates', theme => {
  const v2 = theme === 'v2'
  const choose = (modern: string, classic: string): string => v2 ? modern : classic
  const ownButton = (button: Element): void => { expect(button.classList.contains(v2 ? 'v2-btn' : 'xp-btn')).toBe(true); expect(button.classList.contains(v2 ? 'xp-btn' : 'v2-btn')).toBe(false) }

  it('targets MariaDB trash and restore by semantic slots even after action order changes', async () => {
    const databases = [{ id: id(10), accountId: account.id, engine: 'mariadb', name: 'alice_shop', trashedAt: null }, { id: id(11), accountId: account.id, engine: 'mariadb', name: 'alice_old', trashedAt: at }]
    const send = vi.fn(async (_method: string, path: string) => path === '/api/databases?includeTrashed=true' ? { context: { accountId: account.id }, databases: clone(databases) } : { context: { accountId: account.id }, users: [{ id: id(12), name: 'alice_reader', grants: [{ databaseId: id(10), privileges: ['SELECT'] }] }] })
    const ask = vi.fn(async (_options: Record<string, unknown>) => false)
    const { document } = mount(choose(renderV2MariaDbPage(props, authority), renderAccountDatabases({ lang: 'en', expectedAccountId: account.id, username: account.username, home: account.home, canManage: true })), DATABASE_WORKSPACE_CLIENT_BINDING, send, ask, doc => {
      for (const name of ['database-row', 'database-trash-row']) { const template = doc.querySelector<HTMLTemplateElement>(`template[data-xp-template="${name}"]`)!; const action = template.content.querySelector('[data-xp-slot="trash"],[data-xp-slot="restore"]')!; action.parentElement!.prepend(action) }
    })
    await settle()
    const trash = document.querySelector<HTMLButtonElement>('[data-db-trash-action]')!, restore = document.querySelector<HTMLButtonElement>('[data-db-restore-action]')!
    expect(trash.dataset.dbTrashAction).toBe(id(10)); expect(restore.dataset.dbRestoreAction).toBe(id(11)); ownButton(trash)
    expect(document.querySelector('[data-db-trash-rows] [data-xp-slot="trashed"]')?.getAttribute('datetime')).toBe(at)
    trash.click(); await settle(); expect(ask.mock.calls[0]?.[0]).toMatchObject({ title: 'Move database to trash?' })
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
    expect(document.querySelector('[data-db-rows] tr')?.children).toHaveLength(7)
  })

  it('loads database insights into independently named database, table and user cells', async () => {
    const send = vi.fn(async () => ({ context: { accountId: account.id, username: account.username }, state: 'read', observedAt: at, limits: { maxDatabases: 50, maxUsers: 200, tablesPerDatabase: 20 }, omitted: { databases: 0, users: 0 }, databases: [{ name: 'alice_shop', server: 'present', characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci', tables: 1, dataBytes: 1024, indexBytes: 0, freeBytes: 0, largestTables: [{ name: 'orders', engine: 'InnoDB', rows: 3, dataBytes: 1024, indexBytes: 0, freeBytes: 0 }] }], users: [{ name: 'alice_reader', server: 'present', hosts: 1 }] }))
    const { document } = mount(choose(renderV2DatabaseInsightsPage(props, authority), renderAccountDatabaseInsightsWorkspace({ lang: 'en', accountId: account.id, canManage: true })), ACCOUNT_DATABASE_INSIGHTS_CLIENT_BINDING, send)
    document.querySelector<HTMLButtonElement>('[data-insights-read]')!.click(); await settle()
    expect(document.querySelector('[data-insights-databases] tr')?.children).toHaveLength(7)
    expect(document.querySelector('[data-insights-tables] [data-xp-slot="name"]')?.textContent).toBe('orders')
    expect(document.querySelector('[data-insights-users] [data-xp-slot="name"]')?.textContent).toBe('alice_reader')
    expect(document.querySelector('[data-insights-databases] [data-state-chip]')?.getAttribute('data-state-chip')).toBe('ok')
  })

  it('keeps unqualified remote host changes disabled after loading their six-column view', async () => {
    const send = vi.fn(async () => ({ context: { accountId: account.id, username: account.username }, revision, entries: [{ host: '192.0.2.0/24', comment: 'Office', createdAt: at, firewall: 'unavailable', grants: 'unavailable' }], limit: 100, users: 1, databases: 1, capability: { canChange: false, reason: 'native_provider_unavailable' }, application: { status: 'read', nativeQualified: false } }))
    const { document } = mount(choose(renderV2DatabaseRemotePage(props, authority), renderAccountDatabaseRemoteWorkspace({ lang: 'en', accountId: account.id, username: account.username, canManage: true })), ACCOUNT_DATABASE_REMOTE_CLIENT_BINDING, send)
    await settle()
    const row = document.querySelector('[data-remote-rows] tr')!
    expect(row.children).toHaveLength(6); expect(row.querySelector('[data-xp-slot="host"]')?.getAttribute('dir')).toBe('ltr')
    const manage = row.querySelector<HTMLButtonElement>('[data-xp-slot="manage"]')!; ownButton(manage); expect(manage.disabled).toBe(true)
    expect(send.mock.calls).toHaveLength(1)
  })

  it('renders PostgreSQL action groups with the selected theme and keeps saved IDs out of labels', async () => {
    const send = vi.fn(async () => ({ context: { accountId: account.id, username: account.username }, observedAt: at, state: 'read', version: '16.4', provisioning: 'available', databases: [{ name: 'alice_shop', owner: 'alice_reader', sizeBytes: 1024 }], roles: [{ name: 'alice_reader', login: true }], saved: { databases: [{ id: id(10), name: 'alice_shop', owner: 'alice_reader', trashedAt: null }], users: [{ id: id(12), name: 'alice_reader' }], limit: { used: 1, max: 5 } } }))
    const { document } = mount(choose(renderV2PostgreSqlPage(props, authority), renderAccountDbEngineWorkspace({ page: 'postgresql', lang: 'en', accountId: account.id, username: account.username, canManage: true })), DB_ENGINES_CLIENT_BINDING, send)
    await settle()
    const row = document.querySelector('[data-db-rows="databases"] tr')!
    expect(row.children).toHaveLength(5); ownButton(row.querySelector('button')!)
    expect(row.textContent).toContain('alice_shop'); expect(row.textContent).not.toContain(id(10))
    expect(row.querySelector('[data-db-pg-act="trash"]')?.getAttribute('data-id')).toBe(id(10))
  })

  it('keeps account DNS editor values and numeric bounds in theme-owned editable columns', async () => {
    const send = vi.fn(async (_method: string, _path: string) => ({ zones: [zone()] }))
    const { document, dom } = mount(choose(renderV2DnsPage(props, { canManage: true }), classicPanel('/domains/zone-editor')), ZONE_EDITOR_CLIENT_BINDING, send)
    await settle()
    const row = document.querySelector('[data-dns-records] tr')!
    expect(row.children).toHaveLength(6)
    const ttl = row.querySelector<HTMLInputElement>('[data-zone-field="ttl"]')!
    expect(ttl.value).toBe('0'); expect(ttl.max).toBe('2147483647')
    const content = row.querySelector<HTMLInputElement>('[data-zone-field="content"]')!; content.value = '192.0.2.11'; content.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    expect(document.querySelector<HTMLButtonElement>('[data-dns-save]')?.disabled).toBe(false)
    ownButton(row.querySelector('button')!); expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })

  it('keeps certificate details and three actions inside the six account TLS columns', async () => {
    const send = vi.fn(async () => sslView())
    const { document } = mount(choose(renderV2TlsPage(props, { canManage: true }), classicPanel('/security/ssl')), ACCOUNT_SSL_CLIENT_BINDING, send)
    await settle()
    const row = document.querySelector('[data-account-ssl-rows] tr')!
    expect(row.children).toHaveLength(6)
    const buttons = [...row.querySelectorAll<HTMLButtonElement>('button')]; expect(buttons).toHaveLength(3); buttons.forEach(ownButton)
    buttons[0]!.click(); expect(document.querySelector<HTMLElement>('[data-account-ssl-detail]')?.hidden).toBe(false)
    expect(document.querySelector('[data-account-ssl-facts]')?.textContent).toContain(certificate.fingerprintSha256)
    expect(row.textContent).not.toContain(certificate.id); expect(send.mock.calls).toHaveLength(1)
  })

  it('loads a cron command without changing its whitespace or inventing last-run observations', async () => {
    const command = '  printf "%s" "one two"  '
    const send = vi.fn(async () => ({ context: { accountId: account.id, username: account.username, home: account.home }, revision, jobs: [{ id: id(13), accountId: account.id, schedule: '*/5 * * * *', command, comment: 'Scheduled work', enabled: true, maxRuntimeSec: 300, onCalendar: ['*-*-* *:00/5:00'], unitPreview: null }], capacity: { maxJobs: 1000, used: 1, maxRuntimeSec: 604800 }, application: { status: 'configuration_only', nativeApplied: false } }))
    const { document } = mount(choose(renderV2CronPage(props, { canManage: true }), renderAccountCronWorkspace({ lang: 'en', expectedAccountId: account.id, canManage: true })), ACCOUNT_CRON_CLIENT_BINDING, send)
    await settle()
    const row = document.querySelector('[data-cron-jobs] tr')!
    expect(row.children).toHaveLength(7); expect(row.querySelector('[data-xp-slot="command"]')?.textContent).toBe(command)
    expect(row.querySelector('[data-xp-slot="last-run"]')?.textContent).toBe('Not observed')
    ownButton(row.querySelector('button')!); expect(send.mock.calls).toHaveLength(1)
  })

  it('links WHM DNS labels to editable controls while preserving a zero TTL', async () => {
    const classic = `<div data-whm-dns-workspace>${renderWhmDnsWorkspace({ locale: 'en', title: 'DNS zones', principal: { kind: 'root', id: id(9), username: 'root' }, accounts: [account] })}<table><tbody data-whm-dns-zone-rows></tbody></table></div>`
    const send = vi.fn(async () => ({ zones: [zone()] }))
    const { document, dom } = mount(choose(renderV2WhmDnsPage(whm, authority), classic), WHM_DNS_CLIENT_BINDING, send)
    await settle()
    const row = document.querySelector('[data-dns-records] tr')!
    expect(row.children).toHaveLength(6)
    const ttl = row.querySelector<HTMLInputElement>('[data-field="ttl"]')!
    expect(ttl.value).toBe('0'); expect(row.querySelector('label[for="' + ttl.id + '"]')?.textContent).toBe('TTL')
    ttl.value = '60'; ttl.dispatchEvent(new dom.window.Event('input'))
    expect(document.querySelector<HTMLButtonElement>('[data-dns-save]')?.disabled).toBe(false)
    ownButton(row.querySelector('button')!)
  })

  it('keeps DNS tools selection and preview actions on the actual zone name', async () => {
    const send = vi.fn(async () => ({ observedAt: at, zones: [{ zone: domain.name, revision, records: 1, minTtl: 300, maxTtl: 300 }] }))
    const { document, dom } = mount(choose(renderV2WhmDnsToolsPage(whm, authority), `<section data-whm-detail-route="/whm/dns/more" data-capability-state="authorized">${renderWhmDnsToolsWorkspace({ locale: 'en', canRead: true, canManage: true })}</section>`), WHM_DNS_TOOLS_CLIENT_BINDING, send)
    await settle()
    const row = document.querySelector('[data-whm-dns-tools-rows="zones"] tr')!
    expect(row.children).toHaveLength(4)
    const box = row.querySelector<HTMLInputElement>('[data-whm-dns-tools-pick]')!; expect(box.dataset.whmDnsToolsPick).toBe(domain.name)
    box.checked = true; box.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    const ttl = document.querySelector<HTMLInputElement>('[data-whm-dns-tools-ttl]')!; ttl.value = '600'; ttl.dispatchEvent(new dom.window.Event('input'))
    expect(document.querySelector<HTMLButtonElement>('[data-whm-dns-tools-run="preview"]')?.disabled).toBe(false)
    expect(send.mock.calls).toHaveLength(1)
  })

  it('keeps WHM TLS actions in eight columns and follows saved certificate facts', async () => {
    const send = vi.fn(async () => sslView())
    const { document } = mount(choose(renderV2WhmTlsPage(whm, authority), `<section data-whm-detail-route="/whm/ssl">${renderWhmSslWorkspace({ locale: 'en', canManage: true })}</section>`), WHM_SSL_CLIENT_BINDING, send)
    await settle()
    const row = document.querySelector('[data-ssl-rows] tr')!
    expect(row.children).toHaveLength(8); const buttons = [...row.querySelectorAll<HTMLButtonElement>('button')]; expect(buttons).toHaveLength(3); buttons.forEach(ownButton)
    buttons[0]!.click(); expect(document.querySelector('[data-ssl-facts]')?.textContent).toContain(certificate.fingerprintSha256)
    expect(send.mock.calls).toHaveLength(1)
  })

  it('preserves scope and empty column counts when the renewal observation is empty', async () => {
    const observation = { scope: 'authorized_saved_certificate_ids', inventoryComplete: false, accounts: [{ accountId: account.id, username: account.username, state: 'observed', observation: { scope: 'authorized_saved_certificate_ids', inventoryComplete: false, rows: [{ certificateId: certificate.id, state: 'missing' }] } }], managementTls: { state: 'unavailable', status: null, timer: { state: 'unavailable' } } }
    const send = vi.fn(async (_method: string, path: string) => path.endsWith('/observations') ? observation : sslView())
    const classic = `<section data-whm-detail-route="/whm/ssl">${renderWhmSslWorkspace({ locale: 'en', canManage: true })}<button type="button" data-ssl-observations-refresh>Read observations</button><table><tbody data-ssl-queue-rows></tbody></table><p data-ssl-queue-status></p><table><tbody data-ssl-order-log-rows></tbody></table><p data-ssl-order-log-status></p><p data-ssl-management-status></p></section>`
    const { document } = mount(choose(renderV2WhmTlsPage(whm, authority), classic), WHM_SSL_CLIENT_BINDING, send)
    await settle(); document.querySelector<HTMLButtonElement>('[data-ssl-observations-refresh]')!.click(); await settle()
    expect(document.querySelector('[data-ssl-queue-rows] td')?.getAttribute('colspan')).toBe('6')
    expect(document.querySelector('[data-ssl-order-log-rows] td')?.getAttribute('colspan')).toBe('5')
    expect(document.querySelector('[data-ssl-queue-status]')?.textContent).toContain('Missing records: 1')
    expect(send.mock.calls.map(call => call[1])).toEqual(['/api/certificate-workspace', '/api/certificate-workspace', '/api/certificate-workspace/observations', '/api/certificate-workspace'])
  })

  it('clones certificate-name choices without dispatching any certificate material', async () => {
    const send = vi.fn(async (_method: string, _path: string) => ({ ...sslView(), certificates: [], domains: [{ id: domain.id, accountId: account.id, name: domain.name, certificateId: null }] }))
    const classic = `<section data-whm-detail-route="/whm/ssl/install">${renderWhmSslInstallWorkspace({ locale: 'en', canManage: true })}${renderWhmSslInstallChoices({ locale: 'en' })}</section>`
    const { document } = mount(choose(renderV2WhmTlsInstallPage(whm, authority), classic), WHM_SSL_INSTALL_CLIENT_BINDING, send)
    await settle()
    const domainChoice = document.querySelector<HTMLSelectElement>('[data-ssl-install-domain]')!
    domainChoice.value = domain.id
    domainChoice.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }))
    const box = document.querySelector<HTMLInputElement>('[data-ssl-install-names] input')!
    expect(box.value).toBe('www.' + domain.name); expect(box.nextElementSibling?.getAttribute('dir')).toBe('ltr')
    expect(document.querySelector<HTMLButtonElement>('[data-ssl-install-submit]')?.disabled).toBe(true)
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })

  it('keeps database process protection separate from the two explicit kill actions', async () => {
    const process = { id: 5, user: 'alice_reader', host: 'localhost', db: 'alice_shop', command: 'Query', timeSeconds: 12, threadState: 'Sending data', protected: false, protectedReason: null, account: account.username }
    const send = vi.fn(async () => ({ scope: { observed: 'host-observation' }, observed: { state: 'read', observedAt: at }, queryText: 'not-read', processes: [process, { ...process, id: 7, user: 'root', protected: true, protectedReason: 'system-account', account: null }] }))
    const { document } = mount(choose(renderV2WhmDatabasePage({ ...whm, activeRoute: '/whm/databases/processes' })!, `<section data-whm-detail-route="/whm/databases/processes" data-capability-state="authorized">${renderWhmDatabasesWorkspace({ kind: 'processes', locale: 'en', canRead: true, canKill: true })}</section>`), WHM_DATABASES_CLIENT_BINDING, send)
    await settle()
    const rows = [...document.querySelectorAll('[data-whm-db-rows="processes"] tr')]
    expect(rows.map(row => row.children.length)).toEqual([9, 9])
    const buttons = [...rows[0]!.querySelectorAll('button')]; expect(buttons.map(button => button.getAttribute('data-whm-db-kill'))).toEqual(['query', 'connection']); buttons.forEach(ownButton)
    expect(rows[1]!.querySelector('button')).toBeNull(); expect(rows[1]!.textContent).toContain('Protected')
    expect(send.mock.calls).toHaveLength(1)
  })

  it('renders tuning evidence as a read-only advisory plan without creating apply controls', async () => {
    const variables = Object.fromEntries(DB_TUNING_VARIABLES.map(name => [name, name === 'slow_query_log' ? 'OFF' : name === 'long_query_time' ? 0.5 : 128])) as DatabaseTuningVariables
    const counters = Object.fromEntries(DB_TUNING_STATUS.map(name => [name, 12])) as DatabaseTuningStatus
    const payload = buildDatabaseTuningView({ engine: 'mariadb', state: 'read', observedAt: at, version: '10.11.8-MariaDB', variables, status: counters })
    const send = vi.fn(async () => payload)
    const { document } = mount(choose(renderV2WhmDatabasePage({ ...whm, activeRoute: '/whm/databases/tuning' })!, renderWhmDatabaseTuningWorkspace({ locale: 'en', canRead: true })), WHM_DATABASE_TUNING_CLIENT_BINDING, send)
    await settle()
    expect(document.querySelectorAll('[data-db-tuning-rows="variables"] tr')).toHaveLength(DB_TUNING_VARIABLES.length)
    expect(document.querySelectorAll('[data-db-tuning-plan] article[data-check]')).toHaveLength(payload.plan.checks.length)
    expect(document.querySelector('[data-db-tuning-plan] input,[data-db-tuning-plan] button')).toBeNull()
    expect(document.querySelector('[data-db-tuning-plan] [data-xp-slot="evidence"] dt')).not.toBeNull()
    expect(send.mock.calls).toHaveLength(1)
  })
})
