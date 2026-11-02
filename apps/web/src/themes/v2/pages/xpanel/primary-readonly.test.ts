import { describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import type { Account } from '@xpanel/core'
import type { SurfaceAuthority } from '../../../../models/theme-surface.ts'
import { v2Messages } from '../../messages.ts'
import { renderV2PanelHome, scopePrimaryPanelFacts } from './home.ts'
import { renderV2PanelResources } from './resources.ts'
import { renderV2FilesPage } from './files/index.ts'
import { renderV2DirectoryPrivacyPage } from './files/privacy.ts'
import { renderV2EmailAccountsPage } from './email/accounts.ts'
import { renderV2EmailForwardersPage } from './email/forwarders.ts'

const account: Account = { id: 'account-a', username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', primaryDomain: 'alice.test', planId: 'plan-a', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'alice@example.test', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' }
const authority = (ids: string[] = []): SurfaceAuthority => ({ presentation: 'read-only', canReadFacts: true, canRead: false, canManage: false, canUseTerminal: false, canReadAccounts: false, canChangeOwner: false, allowUnlimited: false, ownerId: null, relatedRoutes: new Set(), qualifiedTools: new Set(), authorizedTools: new Set(ids), logKinds: [], domainSelectionAvailable: false })
const visibility = { principal: { kind: 'user' as const, id: 'user-a', username: account.username, accountId: account.id }, disabledFeatures: new Set<string>() }
const catalog = tools

describe('primary Panel read-only layouts', () => {
  for (const locale of ['en', 'ar'] as const) {
    it(`retains complete home/resources without inventing an account in ${locale}`, () => {
      const props = { locale, visibility, catalog }
      const home = renderV2PanelHome(props, authority())
      for (const id of ['v2-home-sites-title', 'v2-home-tool-list', 'v2-home-resources-title', 'v2-home-information-title', 'v2-home-changes-title']) expect(home).toContain(id)
      const resource = renderV2PanelResources(props, authority())
      for (const id of ['v2-resource-limits', 'v2-resource-cpu-title', 'v2-resource-memory-title', 'v2-resource-processes-title', 'v2-resource-service-title']) expect(resource).toContain(id)
      expect(home + resource).not.toContain('xpanel-undefined.slice')
      expect(home + resource).not.toContain('data-uid=')
      expect(home + resource).not.toContain(account.username)
    })
    it(`retains disabled file editor, list and privacy controls without an account in ${locale}`, () => {
      const t = v2Messages.translator(locale)
      const files = renderV2FilesPage(t, { surface: {}, canManage: true, authority: authority() })
      expect(files).toContain('data-file-manager-table')
      expect(files).toContain('data-file-upload hidden disabled')
      expect(files).toContain('v2-file-editor')
      expect(files).toContain('data-read-only="true"')
      const privacy = renderV2DirectoryPrivacyPage(t, { surface: {}, canManage: true, authority: authority() })
      expect(privacy).toContain('data-directory-privacy-rows')
      expect(privacy).toContain('data-directory-privacy-save disabled')
      expect(privacy).not.toContain(account.username)
    })
  }
  it('requires matching identity and independent tool authorization before displaying stored collections', () => {
    const database = { id: 'db-a', accountId: account.id, name: 'alice_saved', engine: 'mariadb' as const, trashedAt: null }
    const props = { account, visibility, catalog, databases: [database] }
    expect(scopePrimaryPanelFacts(props, authority()).databases).toBeUndefined()
    expect(scopePrimaryPanelFacts(props, authority(['mysql-databases'])).databases).toEqual([database])
    expect(scopePrimaryPanelFacts({ ...props, visibility: { ...visibility, principal: { ...visibility.principal, accountId: 'foreign' } } }, authority(['mysql-databases'])).databases).toBeUndefined()
    expect(scopePrimaryPanelFacts({ ...props, databases: [] }, authority(['mysql-databases'])).databases).toEqual([])
    expect(scopePrimaryPanelFacts({ ...props, databases: undefined }, authority(['mysql-databases'])).databases).toBeUndefined()
  })
  it('keeps mailbox creation and routing layouts disabled despite stale mutation flags', () => {
    const t = v2Messages.translator('en')
    const email = renderV2EmailAccountsPage(t, { domains: { state: 'unread' }, users: { state: 'unread' }, canManage: true, readOnly: true })
    expect(email).toContain('v2-email-users')
    expect(email).toContain('v2-mailbox-create')
    expect(email).toContain('<fieldset disabled>')
    expect(email).toContain('data-readonly="true"')
    const routing = renderV2EmailForwardersPage(t, { domains: [], domainsObserved: false, mailboxes: [], canManage: true, readOnly: true })
    expect(routing).toContain('data-forwarder-manage="false"')
    expect(routing).toContain('data-forwarder-refresh disabled')
    expect(routing).toContain('data-autoresponder-form')
    expect(routing).toContain('data-default-form')
    expect(routing).toContain('<fieldset disabled>')
    expect(routing).not.toContain('No forwarders.')
  })
})
