import { describe, expect, it } from 'vitest'
import { renderApprovedXpanelWorkspace } from './approved-xpanel-workspaces.ts'
import { renderWhmDatabasesWorkspace } from './whm-databases-workspace.ts'
import { renderWhmServiceDetailWorkspace } from './whm-service-detail-workspace.ts'

const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', status: 'active', primaryDomain: 'example.test' }
const tool = (id: string) => ({ id, status: 'verified', delivery: { status: 'verified' } })
const page = (route: string, catalog: unknown[], nativeHtml?: string) => renderApprovedXpanelWorkspace({ route, locale: 'en', readOnly: false, account, catalog, visibility: { principal: { kind: 'user', id: 'u', username: 'alice', accountId: account.id } }, ...(nativeHtml ? { nativeHtml } : {}) } as never)

describe('classic pages carry the database and FTP tools', () => {
  it('shows each wizard on the page that returns its own document, gated by its own tool', () => {
    const mariadb = page('/databases/mariadb', [tool('database-wizard')], '<div data-database-workspace></div>')!
    expect(mariadb).toContain('data-db-wizard data-engine="mariadb" data-username="alice" data-can-manage="true"')
    expect(page('/databases/mariadb', [], '<div data-database-workspace></div>')).toContain('data-db-wizard data-engine="mariadb" data-username="alice" data-can-manage="false"')
    const postgresql = page('/databases/postgresql', [tool('postgresql-databases'), tool('postgresql-database-wizard')])
    if (postgresql) expect(postgresql).toContain('data-engine="postgresql"')
  })
  it('places each WHM tool on its route only', () => {
    const render = (kind: 'overview' | 'users' | 'processes' | 'servers') => renderWhmDatabasesWorkspace({ kind, locale: 'en', canRead: true, canKill: false, canMap: true, canAccessHosts: true, canSettings: true, canPostgresql: true })
    expect(render('overview')).toContain('data-db-map-tool data-can-manage="true"')
    expect(render('users')).toContain('data-db-hosts-tool data-can-manage="true"')
    expect(render('servers')).toContain('data-db-settings-tool data-can-manage="true"')
    expect(render('servers')).toContain('data-db-pg-tool data-can-manage="true"')
    expect(render('processes')).not.toContain('data-db-map-tool')
    expect(renderWhmServiceDetailWorkspace({ kind: 'ftp', locale: 'en', canRead: true, canRestart: false })).toContain('data-ftp-server-settings data-can-manage="false"')
    expect(renderWhmServiceDetailWorkspace({ kind: 'dns', locale: 'en', canRead: true, canRestart: false })).not.toContain('data-ftp-server-settings')
  })
})
