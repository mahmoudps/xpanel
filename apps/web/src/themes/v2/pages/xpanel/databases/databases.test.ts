import { describe, expect, it } from 'vitest'
import { DB_PRIVILEGES, type Account, type Database } from '@xpanel/core'
import { parseMarkup, type MarkupNode } from '../../../../markup.ts'
import {
  renderV2DatabaseInsightsPage, renderV2DatabaseRemotePage, renderV2MariaDbPage, renderV2PanelDatabasePage,
  renderV2PhpMyAdminPage, renderV2PhpPgAdminPage, renderV2PostgreSqlPage, V2_DATABASE_ROUTES, PANEL_DATABASES_CSS,
  type DatabasePageAuthority, type DatabasePageProps,
} from './index.ts'
import { technical } from './common.ts'

const account: Account = {
  id: '10000000-0000-4000-8000-000000000001', username: 'alice', uid: 20014, gid: 20014,
  home: '/home/alice', primaryDomain: 'alice.example', planId: 'plan', ownerId: null, status: 'active',
  suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z',
}
const database: Database = { id: '20000000-0000-4000-8000-000000000001', accountId: account.id, name: 'alice_shop', engine: 'mariadb', trashedAt: null }
const write: DatabasePageAuthority = { canRead: true, canManage: true }
const read: DatabasePageAuthority = { canRead: true, canManage: false }
const renderers = [renderV2MariaDbPage, renderV2DatabaseInsightsPage, renderV2DatabaseRemotePage,
  renderV2PhpMyAdminPage, renderV2PostgreSqlPage, renderV2PhpPgAdminPage]
const by = (nodes: readonly MarkupNode[], key: string, value?: string): MarkupNode | undefined =>
  nodes.find(node => node.namespace === 'html' && node.template < 0 && node.attrs.has(key) && (value === undefined || node.attrs.get(key) === value))
const childrenOf = (nodes: readonly MarkupNode[], ancestor: MarkupNode): MarkupNode[] => {
  const index = nodes.indexOf(ancestor)
  return nodes.filter(node => {
    for (let parent = node.parent; parent >= 0; parent = nodes[parent]!.parent) if (parent === index) return true
    return false
  })
}

describe('v2 account database family', () => {
  it('dispatches exactly the six canonical database documents', () => {
    expect(V2_DATABASE_ROUTES).toHaveLength(6)
    for (const route of V2_DATABASE_ROUTES) expect(renderV2PanelDatabasePage({ account, activeRoute: route }, write)).toContain('<h1>')
    for (const route of ['/home', '/whm/databases', '/databases/mariadb/unknown', '/databases/mariadb?accountId=foreign']) {
      expect(renderV2PanelDatabasePage({ account, activeRoute: route }, write)).toBeUndefined()
    }
  })

  it('preserves full unknown-account layouts without exposing supplied names or admitting native reads', () => {
    for (const render of renderers) {
      const html = render({ databases: [database] }, write)
      const nodes = parseMarkup(html)
      expect(html).toContain('<h1>')
      expect(html).toContain('class="v2-db-workspace"')
      expect(html).toContain('data-capability-unavailable="true"')
      expect(html).not.toContain('alice_shop')
      expect(html).not.toContain(account.id)
      expect(nodes.filter(node => node.tag === 'button').every(node => node.attrs.has('disabled'))).toBe(true)
    }
    const main = renderV2MariaDbPage({}, write)
    for (const title of ['Create a database', 'Database users', 'Privileges', 'Remote access', 'Import and export']) expect(main).toContain(title)
    expect(main).toContain('data-db-username=""')
    expect(main).not.toContain('No saved databases.')
  })

  it('blocks automatic database reads when authority is absent, without hiding the approved sections', () => {
    const html = renderV2MariaDbPage({ account, databases: [database] })
    expect(html).toContain('data-db-manage="false" data-capability-unavailable="true"')
    expect(html).not.toContain('alice_shop')
    for (const heading of ['Create a database', 'Database users', 'Privileges', 'Remote access', 'Import and export']) expect(html).toContain(heading)
    const nodes = parseMarkup(html)
    expect(by(nodes, 'data-db-refresh')?.attrs.has('disabled')).toBe(true)
  })

  it('keeps authorized MariaDB reads available without granting writes', () => {
    const html = renderV2MariaDbPage({ account }, read)
    expect(html).toContain('data-db-manage="false"')
    expect(html).not.toContain('data-capability-unavailable')
    const nodes = parseMarkup(html)
    expect(by(nodes, 'data-db-refresh')?.attrs.has('disabled')).toBe(false)
    expect(by(nodes, 'data-db-create-submit')?.attrs.has('disabled')).toBe(true)
    expect(by(nodes, 'data-db-grant-save')?.attrs.has('disabled')).toBe(true)
  })

  it('does not infer measured zeroes, a server version or a successful connection from unread props', () => {
    const html = renderV2MariaDbPage({ account }, write)
    expect(html).toContain('Records have not been read.')
    expect(html).toContain('Database service, grants and connections remain unverified.')
    expect(html).not.toContain('No saved databases.')
    expect(html).not.toContain('MariaDB 10.')
    expect(html).not.toContain('Connection verified')
  })

  it('distinguishes an observed empty metadata collection from an unread collection', () => {
    const html = renderV2MariaDbPage({ account, databases: [], databaseUsers: [] }, read)
    expect(html).toContain('No saved databases. Create a database configuration to begin.')
    expect(html).toContain('No saved database users.')
    expect(html).toContain('No databases are in the saved trash.')
    expect(html).toContain('Size on disk')
    expect(html).not.toContain('0 B')
  })

  it('does not call supplied database users empty when their database observation is still unread', () => {
    const html = renderV2MariaDbPage({ account, databaseUsers: [{ id: 'user', name: 'alice_app', grants: [{ databaseId: database.id, privileges: ['SELECT'] }] }] }, read)
    expect(html).not.toContain('No saved database users.')
    const nodes = parseMarkup(html)
    expect(childrenOf(nodes, by(nodes, 'data-dbu-rows')!).find(node => node.tag === 'td')?.attrs.get('colspan')).toBe('4')
    expect(html).toContain('Records have not been read.')
  })

  it('has one live count container so reads and accepted changes cannot leave duplicate stale KPIs', () => {
    const nodes = parseMarkup(renderV2MariaDbPage({ account, databases: [database], databaseUsers: [] }, read))
    const counts = nodes.filter(node => node.attrs.has('data-db-counts'))
    expect(counts).toHaveLength(1)
    expect(counts[0]?.tag).toBe('dl')
    expect(childrenOf(nodes, counts[0]!).filter(node => node.tag === 'dd')).toHaveLength(4)
  })

  it('shows only account-scoped MariaDB names and user grants backed by that metadata', () => {
    const html = renderV2MariaDbPage({ account, databases: [database,
      { ...database, id: 'pg', name: 'alice_pg', engine: 'postgresql' },
      { ...database, id: 'foreign', accountId: 'another-account', name: 'bob_secret' }],
    databaseUsers: [
      { id: 'owned-user', name: 'alice_app', grants: [{ databaseId: database.id, privileges: ['SELECT'] }] },
      { id: 'foreign-user', name: 'bob_app', grants: [] },
      { id: 'foreign-grant', name: 'alice_foreign_grant', grants: [{ databaseId: 'foreign', privileges: ['SELECT'] }] },
    ] }, read)
    expect(html).toContain('alice_shop')
    expect(html).toContain('alice_app')
    expect(html).not.toContain('alice_pg')
    expect(html).not.toContain('bob_secret')
    expect(html).not.toContain('bob_app')
    expect(html).not.toContain('alice_foreign_grant')
  })

  it('escapes stored names and renders dates with actual instants rather than invented retention', () => {
    const name = 'alice_<script>alert(1)</script>'
    const html = renderV2MariaDbPage({ account, databases: [{ ...database, name, trashedAt: '2026-10-29T14:23:15Z' }], databaseUsers: [] }, read)
    expect(html).toContain('alice_&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('datetime="2026-10-29T14:23:15Z"')
    expect(html).toContain('2026-10-29 14:23 UTC')
    expect(html).not.toContain('in 7 days')
    expect(html).toContain('no retention deadline is inferred')
  })

  it('preserves the full main controller form, named-field and action contract', () => {
    const nodes = parseMarkup(renderV2MariaDbPage({ account }, write))
    for (const attribute of ['data-db-create', 'data-dbu-create', 'data-db-grant-form']) expect(by(nodes, attribute)?.tag).toBe('form')
    const user = by(nodes, 'data-dbu-create')!
    const userFields = childrenOf(nodes, user)
    const password = by(userFields, 'name', 'password')!
    expect(password.tag).toBe('input')
    expect(password.attrs.get('type')).toBe('password')
    expect(password.attrs.get('minlength')).toBe('8')
    expect(password.attrs.get('maxlength')).toBe('256')
    expect(password.attrs.get('autocomplete')).toBe('new-password')
    expect(by(userFields, 'name', 'databaseId')?.tag).toBe('select')
    const grant = childrenOf(nodes, by(nodes, 'data-db-grant-form')!)
    for (const name of ['userId', 'databaseId']) expect(by(grant, 'name', name)?.tag).toBe('select')
    for (const key of ['db-refresh', 'db-reload', 'db-create-submit', 'db-clear', 'dbu-create-submit', 'dbu-clear', 'dbu-generate', 'dbu-reveal', 'db-grant-save', 'db-grant-discard', 'db-grant-advanced-toggle']) expect(by(nodes, `data-${key}`)?.tag).toBe('button')
    for (const key of ['db-status', 'db-application', 'db-counts', 'db-full-name', 'dbu-secret-note', 'dbu-initial-privileges', 'db-grant-current', 'db-grant-preview', 'db-grant-advanced']) expect(by(nodes, `data-${key}`)).toBeDefined()
  })

  it('retains every canonical grant and preserves collapsed advanced controls', () => {
    const nodes = parseMarkup(renderV2MariaDbPage({ account }, write))
    const grant = childrenOf(nodes, by(nodes, 'data-db-grant-form')!)
    const values = grant.filter(node => node.tag === 'input' && node.attrs.get('name') === 'privileges').map(node => node.attrs.get('value'))
    expect([...values].sort()).toEqual([...DB_PRIVILEGES].sort())
    expect(by(nodes, 'data-db-grant-advanced')?.attrs.has('hidden')).toBe(true)
    expect(by(nodes, 'data-db-grant-advanced-toggle')?.attrs.get('aria-expanded')).toBe('false')
  })

  it('keeps all three main tables shaped for the existing row painter', () => {
    const nodes = parseMarkup(renderV2MariaDbPage({ account }, write))
    for (const [attribute, count] of [['data-db-rows', '7'], ['data-dbu-rows', '4'], ['data-db-trash-rows', '4']]) {
      const body = by(nodes, attribute!)!
      expect(body.tag).toBe('tbody')
      expect(childrenOf(nodes, body).find(node => node.tag === 'td')?.attrs.get('colspan')).toBe(count)
    }
  })

  it('retains unsupported approved controls without claiming or enabling native effects', () => {
    const html = renderV2MariaDbPage({ account }, write)
    const nodes = parseMarkup(html)
    for (const id of ['v2-db-rename-name', 'v2-dbu-reset-password', 'v2-db-import-file', 'v2-db-import-target']) expect(by(nodes, 'id', id)?.attrs.has('disabled')).toBe(true)
    expect(html).toContain('No database has been renamed.')
    expect(html).toContain('No dump has been read, imported or exported.')
    expect(by(nodes, 'data-db-overview-database')?.attrs.has('disabled')).toBe(true)
    expect(by(nodes, 'data-db-overview-rows')?.tag).toBe('tbody')
    expect(nodes.filter(node => node.attrs.has('data-v2-db-sql-preview'))).toHaveLength(2)
    expect(html).toContain('No generated SQL preview has been read.')
    const matrix = by(nodes, 'id', 'v2-db-privilege-overview')!
    const headers = childrenOf(nodes, matrix).filter(node => node.tag === 'th')
    expect(headers).toHaveLength(8)
    const matrixHtml = html.slice(html.indexOf('<table id="v2-db-privilege-overview"'), html.indexOf('</table>', html.indexOf('<table id="v2-db-privilege-overview"')))
    expect([...matrixHtml.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map(match => match[1])).toEqual(['User', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'Other'])
    expect(html).toContain('aria-label="Legend"')
    expect(html).toContain('Granted</li>')
    expect(html).toContain('Not granted</li>')
    expect(html).toContain('Other counts DROP, INDEX, REFERENCES and 9 advanced privileges.')
  })

  it('uses related-route authority instead of assuming availability of other database tools', () => {
    const denied = renderV2MariaDbPage({ account }, write)
    expect(denied).not.toContain('href="/databases/phpmyadmin"')
    const allowed = renderV2MariaDbPage({ account }, { ...write, relatedRoutes: new Set(['/databases/phpmyadmin']) })
    expect(allowed).toContain('href="/databases/phpmyadmin"')
    expect(allowed).not.toContain('href="/databases/remote-access"')
  })

  it('keeps remote inputs and exact confirmation unavailable until a real policy read', () => {
    const html = renderV2DatabaseRemotePage({ account }, write)
    const nodes = parseMarkup(html)
    expect(html).toContain('data-remote-manage="true"')
    for (const key of ['host', 'comment', 'confirmation']) expect(by(nodes, `data-remote-${key}`)?.tag).toBe('input')
    expect(by(nodes, 'data-remote-host')?.attrs.get('maxlength')).toBe('64')
    expect(by(nodes, 'data-remote-comment')?.attrs.get('maxlength')).toBe('200')
    expect(by(nodes, 'data-remote-selected-panel')?.attrs.has('hidden')).toBe(true)
    for (const key of ['save', 'remove']) expect(by(nodes, `data-remote-${key}`)?.attrs.has('disabled')).toBe(true)
    expect(by(nodes, 'data-remote-refresh')?.attrs.has('disabled')).toBe(false)
    expect(html).toContain('No host policy has been read.')
  })

  it('does not turn a remote read permission into a write permission through its combined client flag', () => {
    const html = renderV2DatabaseRemotePage({ account }, read)
    expect(html).toContain('data-remote-manage="false"')
    expect(by(parseMarkup(html), 'data-remote-refresh')?.attrs.has('disabled')).toBe(true)
    expect(html).toContain('No policy has been read or changed.')
  })

  it('allows the read-only insights controller independently of mutation permission', () => {
    const html = renderV2DatabaseInsightsPage({ account }, read)
    const nodes = parseMarkup(html)
    expect(html).toContain('data-insights-manage="true"')
    expect(by(nodes, 'data-insights-read')?.attrs.has('disabled')).toBe(false)
    for (const key of ['databases', 'size', 'tables', 'users', 'at']) expect(by(nodes, 'data-insights-fact', key)).toBeDefined()
    expect(by(nodes, 'data-insights-database')?.tag).toBe('select')
    for (const [key, columns] of [['databases', '7'], ['tables', '6'], ['users', '3']]) {
      const body = by(nodes, `data-insights-${key}`)!
      expect(body.tag).toBe('tbody')
      expect(childrenOf(nodes, body).find(node => node.tag === 'td')?.attrs.get('colspan')).toBe(columns)
    }
    expect(html).not.toContain('0 B')
  })

  it('requires a server-read sign-on result before enabling phpMyAdmin', () => {
    const html = renderV2PhpMyAdminPage({ account }, write)
    const nodes = parseMarkup(html)
    expect(html).toContain('data-db-can-read="true" data-db-can-manage="true"')
    expect(by(nodes, 'data-db-action', 'open')?.attrs.has('disabled')).toBe(true)
    expect(by(nodes, 'data-db-action', 'refresh')?.attrs.has('disabled')).toBe(false)
    for (const key of ['account', 'installed', 'databases', 'signon', 'session', 'ticket']) expect(by(nodes, 'data-db-fact', key)).toBeDefined()
    expect(by(nodes, 'data-db-checks')?.tag).toBe('ol')
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('ticket=')
  })

  it('cannot use the phpMyAdmin read flag to bypass its existing single-sign-on launch authority', () => {
    const html = renderV2PhpMyAdminPage({ account }, read)
    const nodes = parseMarkup(html)
    expect(html).toContain('data-db-can-read="false" data-db-can-manage="false"')
    expect(by(nodes, 'data-db-action', 'refresh')?.attrs.has('disabled')).toBe(true)
    expect(by(nodes, 'data-db-action', 'open')?.attrs.has('disabled')).toBe(true)
  })

  it('preserves PostgreSQL form admission and required field constraints', () => {
    for (const [authority, tag] of [[write, 'form'], [read, 'div']] as const) {
      const nodes = parseMarkup(renderV2PostgreSqlPage({ account }, authority))
      for (const kind of ['database', 'user', 'password']) expect(by(nodes, 'data-db-pg-form', kind)?.tag).toBe(tag)
      expect(by(nodes, 'id', 'db-pg-owner')?.attrs.get('name')).toBe('owner')
      expect(by(nodes, 'id', 'db-pg-password-user')?.attrs.get('name')).toBe('user')
      const user = childrenOf(nodes, by(nodes, 'data-db-pg-form', 'user')!)
      expect(by(user, 'name', 'name')?.attrs.get('maxlength')).toBe('32')
      const password = by(user, 'name', 'password')!
      expect(password.attrs.get('minlength')).toBe('8')
      expect(password.attrs.get('maxlength')).toBe('256')
      expect(password.attrs.has('disabled')).toBe(true)
    }
  })

  it('does not permit PostgreSQL mutations from a suspended account', () => {
    const html = renderV2PostgreSqlPage({ account: { ...account, status: 'suspended' } }, write)
    expect(html).toContain('data-db-can-manage="false"')
    expect(by(parseMarkup(html), 'data-db-pg-form', 'database')?.tag).toBe('div')
  })

  it('keeps phpPgAdmin explicitly unsupported without a fake sign-on endpoint', () => {
    const html = renderV2PhpPgAdminPage({ account }, write)
    const nodes = parseMarkup(html)
    expect(html).toContain('no documented single sign-on method')
    expect(by(nodes, 'data-db-action', 'open')).toBeUndefined()
    expect(nodes.filter(node => node.tag === 'button').every(node => node.attrs.has('disabled') || node.attrs.get('data-db-action') === 'refresh')).toBe(true)
  })

  it('keeps every rendered field label linked to one control and every table header aligned structurally', () => {
    for (const render of renderers) {
      const nodes = parseMarkup(render({ account }, write))
      const ids = nodes.flatMap(node => node.attrs.has('id') ? [node.attrs.get('id')!] : [])
      expect(new Set(ids).size).toBe(ids.length)
      for (const label of nodes.filter(node => node.tag === 'label' && node.attrs.has('for'))) expect(nodes.filter(node => node.attrs.get('id') === label.attrs.get('for'))).toHaveLength(1)
      expect(nodes.filter(node => node.tag === 'th').every(node => node.attrs.get('scope') === 'col')).toBe(true)
    }
  })

  it('isolates technical values with ASCII digits and contains no classic style aliases', () => {
    expect(technical('\u0662\u0660\u0662\u0666-\u06f1\u06f0-29')).toBe('<bdi dir="ltr" class="v2-mono">2026-10-29</bdi>')
    for (const render of renderers) {
      const html = render({ account, locale: 'ar' }, write)
      expect(html).toContain('dir="rtl"')
      expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/u)
      expect(html).not.toMatch(/class="[^"]*\bxp-/)
    }
    expect(PANEL_DATABASES_CSS).not.toMatch(/(?:^|[;{\s])(?:left|right)\s*:/)
    expect(PANEL_DATABASES_CSS).not.toMatch(/text-align:(?:left|right)/)
    expect(PANEL_DATABASES_CSS).toContain('gap:var(--space-1)')
    expect(PANEL_DATABASES_CSS).toContain('text-align:var(--v2-control-align,start)')
  })

  it('displays authorized stored MariaDB facts without enabling refresh or mutations', () => {
    const authority: DatabasePageAuthority = { canRead: false, canManage: false, canReadFacts: true, authorizedTools: new Set(['mysql-databases', 'mysql-users']) }
    const visibility = { principal: { kind: 'user' as const, id: 'member', username: account.username, accountId: account.id }, disabledFeatures: new Set<string>() }
    const html = renderV2MariaDbPage({ account, visibility, databases: [database], databaseUsers: [
      { id: 'own', accountId: account.id, name: 'alice_saved_user', grants: [{ databaseId: database.id, privileges: ['SELECT'] }] },
      { id: 'foreign', accountId: 'foreign-account', name: 'alice_foreign_user', grants: [{ databaseId: database.id, privileges: ['SELECT'] }] },
    ] }, authority)
    expect(html).toContain('alice_shop')
    expect(html).toContain('alice_saved_user')
    expect(html).not.toContain('alice_foreign_user')
    expect(html).toContain('data-capability-unavailable="true"')
    const nodes = parseMarkup(html)
    expect(by(nodes, 'data-db-refresh')?.attrs.has('disabled')).toBe(true)
    expect(by(nodes, 'data-db-create-submit')?.attrs.has('disabled')).toBe(true)
    expect(by(nodes, 'data-db-grant-save')?.attrs.has('disabled')).toBe(true)
  })

  it('requires the independent saved-user permission and does not turn unread facts into empty collections', () => {
    const visibility = { principal: { kind: 'user' as const, id: 'member', username: account.username, accountId: account.id }, disabledFeatures: new Set<string>() }
    const authority: DatabasePageAuthority = { canRead: false, canManage: false, canReadFacts: true, authorizedTools: new Set(['mysql-databases']) }
    const props: DatabasePageProps = { account, visibility, databases: [database], databaseUsers: [{ id: 'own', name: 'alice_saved_user', grants: [{ databaseId: database.id, privileges: ['SELECT'] }] }] }
    const html = renderV2MariaDbPage(props, authority)
    expect(html).toContain('alice_shop')
    expect(html).not.toContain('alice_saved_user')
    expect(html).not.toContain('No saved database users.')
    const unread = renderV2MariaDbPage({ account, visibility }, authority)
    const empty = renderV2MariaDbPage({ account, visibility, databases: [] }, authority)
    expect(unread).toContain('Records have not been read.')
    expect(unread).not.toContain('No saved databases.')
    expect(empty).toContain('No saved databases.')
  })

  it('does not expose saved facts from a boolean grant without matching identity and explicit tool authority', () => {
    const visibility = { principal: { kind: 'user' as const, id: 'member', username: 'other', accountId: 'foreign-account' }, disabledFeatures: new Set<string>() }
    const facts = { canRead: false, canManage: false, canReadFacts: true }
    const cases: [DatabasePageProps, DatabasePageAuthority][] = [
      [{ account, databases: [database] }, { ...facts, authorizedTools: new Set(['mysql-databases']) }],
      [{ account, visibility, databases: [database] }, { ...facts, authorizedTools: new Set(['mysql-databases']) }],
      [{ account, databases: [database] }, facts],
    ]
    for (const [props, authority] of cases) {
      const html = renderV2MariaDbPage(props, authority)
      expect(html).not.toContain('alice_shop')
      expect(html).toContain('data-capability-unavailable="true"')
    }
  })

  it('keeps PostgreSQL stored-name authority separate from MariaDB and native provider access', () => {
    const visibility = { principal: { kind: 'user' as const, id: 'member', username: account.username, accountId: account.id }, disabledFeatures: new Set<string>() }
    const props: DatabasePageProps = { account, visibility, databases: [{ ...database, engine: 'postgresql', name: 'alice_saved_pg' }] }
    const facts: DatabasePageAuthority = { canRead: false, canManage: false, canReadFacts: true, authorizedTools: new Set(['postgresql-databases']) }
    const allowed = renderV2PostgreSqlPage(props, facts)
    expect(allowed).toContain('alice_saved_pg')
    expect(allowed).toContain('data-db-can-read="false" data-db-can-manage="false"')
    expect(by(parseMarkup(allowed), 'data-db-action', 'refresh')?.attrs.has('disabled')).toBe(true)
    expect(renderV2PostgreSqlPage(props, { ...facts, authorizedTools: new Set(['mysql-databases']) })).not.toContain('alice_saved_pg')
    expect(by(parseMarkup(allowed), 'data-db-pg-form', 'database')?.tag).toBe('div')
  })

})
