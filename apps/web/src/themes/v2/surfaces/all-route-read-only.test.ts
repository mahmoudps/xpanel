import { describe, expect, it } from 'vitest'
import { buildDeliveryCatalog, canOpenRegisteredRoute, navigation, registeredDocumentAliases, type VisibilityContext } from '@xpanel/catalog'
import { defaultPlan, type Account, type Domain, type Principal, type Reseller } from '@xpanel/core'
import type { PanelSurfaceProps, WhmSurfaceProps, MailSurfaceProps, ThemeSurface, UnavailableProps } from '../../contract.ts'
import { parseMarkup, type MarkupNode } from '../../markup.ts'
import { projectReadOnlyMailSurface, projectReadOnlyPanelSurface, projectReadOnlyWhmSurface } from '../../../models/theme-surface.ts'
import { renderV2ReadOnlyPage } from './read-only.ts'
import { renderV2AccountSecuritySlot } from './slots.ts'

// Synthetic stored records exercise rendering and authorization boundaries only. The real,
// unchanged catalog remains unaccepted: these fixtures establish no native capability.
const catalog = buildDeliveryCatalog([], null)
const account: Account = { id: 'account-contract', username: 'fixture', uid: 20001, gid: 20001, home: '/home/fixture', primaryDomain: 'owned-reference.example.test', planId: 'plan-contract', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'fixture@example.test', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' }
const plan = defaultPlan({ id: account.planId, name: 'Stored contract plan' })
const owner: Principal = { kind: 'user', id: 'owner-contract', username: account.username, accountId: account.id }
const root: Principal = { kind: 'root', id: 'root-contract', username: 'operator' }
const ownerVisibility: VisibilityContext = { principal: owner, disabledFeatures: new Set() }
const rootVisibility: VisibilityContext = { principal: root }
const domain: Domain = { id: 'domain-contract', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: account.home + '/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', ini: {}, fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 } }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' }
const database = { id: 'database-contract', accountId: account.id, name: 'fixture_owned_data', engine: 'mariadb' as const, trashedAt: null }
const mailbox = 'fixture@owned-reference.example.test'
const message = { uid: 17, folder: 'INBOX', from: 'sender@example.test', to: mailbox, subject: 'Stored message sentinel', preview: 'Stored preview sentinel', body: 'Stored body sentinel', receivedAt: '2026-10-29T12:00:00Z', unread: true }
const fallbackHeading = 'UNEXPECTED GENERIC UNAVAILABLE BODY'
const securityRoutes = new Set(['/security/account', '/whm/security/sign-in', '/mail/settings/security'])
interface DocumentCase { surface: ThemeSurface; route: string; canonical: string; label: string }
const canonicalCases: DocumentCase[] = navigation.flatMap(surface => {
  if (surface.surface !== 'xpanel' && surface.surface !== 'xwhm' && surface.surface !== 'xmail') return []
  const realm = surface.surface
  return surface.sections.flatMap(section => section.pages.map(page => ({ surface: realm, route: page.route, canonical: page.route, label: page.name })))
})
const documents: DocumentCase[] = [...canonicalCases, ...registeredDocumentAliases.map(alias => {
  const parent = canonicalCases.find(page => page.route === alias.parentRoute)
  if (!parent) throw new Error('Registered alias has no document parent: ' + alias.route)
  return { ...parent, route: alias.route }
})]
const visibilityFor = (surface: ThemeSurface): VisibilityContext => surface === 'xwhm' ? rootVisibility : ownerVisibility

function panelFacts(observed: boolean, visibility: VisibilityContext): PanelSurfaceProps {
  return { visibility, catalog, ...(observed ? { account, plan, domains: [domain], databases: [database], databaseUsers: [{ id: 'database-user-contract', accountId: account.id, name: 'fixture_user', grants: [{ databaseId: database.id, privileges: ['SELECT'] }] }], serviceUsers: [{ id: 'service-contract', accountId: account.id, login: mailbox, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 8, ftpDir: '' }] } : {}) }
}
function whmFacts(observed: boolean, visibility: VisibilityContext): WhmSurfaceProps {
  return { principal: visibility.principal, visibility, catalog, ...(observed ? { hostname: 'host-reference.example.test', accounts: [account], plans: [plan], domains: [domain], featureLists: [{ id: 'feature-contract', name: 'Stored features', ownerId: null, disabled: [] }], certificates: [{ accountId: account.id, names: [account.primaryDomain], notAfter: '2027-01-01T00:00:00Z' }] } : {}) }
}
function mailFacts(observed: boolean, visibility: VisibilityContext): MailSurfaceProps {
  return { visibility, catalog, ...(observed ? { mailbox, messages: [message], quotaLimitMb: 8, quotaUsedMb: 1, composeDraft: { to: 'recipient@example.test', cc: '', subject: 'Stored draft sentinel', body: 'Stored draft body sentinel' } } : {}) }
}
function descriptor(document: DocumentCase, observed: boolean, visibility = visibilityFor(document.surface)): UnavailableProps {
  return { surface: document.surface, route: document.route, locale: 'en', theme: 'light', density: 'comfortable', heading: fallbackHeading, admitted: canOpenRegisteredRoute(document.route, visibility), securityPage: securityRoutes.has(document.route), signedIn: true, qualifiedRoutes: new Set(), visibility, catalog,
    readOnlyFacts: document.surface === 'xpanel' ? { surface: 'xpanel', panel: panelFacts(observed, visibility) } : document.surface === 'xwhm' ? { surface: 'xwhm', whm: whmFacts(observed, visibility) } : { surface: 'xmail', mail: mailFacts(observed, visibility) } }
}
function ancestors(nodes: readonly MarkupNode[], index: number): number[] {
  const result: number[] = []
  for (let parent = nodes[index]!.parent; parent >= 0; parent = nodes[parent]!.parent) result.push(parent)
  return result
}
function assertFullReadOnlyDocument(document: DocumentCase, html: string, locale: 'en' | 'ar' = 'en'): void {
  expect(html).not.toContain(fallbackHeading)
  expect(html).not.toContain('v2-unavailable__panel')
  expect(html).not.toContain('data-core-panel-denied')
  expect(html).not.toContain('id="main-content"')
  const body = securityRoutes.has(document.route) ? renderV2AccountSecuritySlot({ bodyHtml: html, security: { locale, totpEnabled: false, principalKind: document.surface === 'xwhm' ? 'root' : 'user', surface: document.surface } }) : html
  const nodes = parseMarkup(body), live = nodes.filter(node => node.template < 0 && node.namespace === 'html')
  expect(live.filter(node => node.tag === 'h1'), document.route).toHaveLength(1)
  // A title/error paragraph alone is not the approved workspace. Require actual
  // facts, editor, table, mailbox pane, or content cards after the page heading.
  expect(live.some(node => ['table', 'dl', 'form', 'fieldset', 'article'].includes(node.tag) || node.tag === 'section' && /(?:^|\s)v2-(?:card|security)(?:\s|$)/.test(node.attrs.get('class') ?? '')), document.route).toBe(true)
  const coreIndices = nodes.flatMap((node, index) => node.attrs.has('data-account-security') ? [index] : [])
  expect(coreIndices, document.route).toHaveLength(securityRoutes.has(document.route) ? 1 : 0)
  const blocked = (index: number): boolean => [index, ...ancestors(nodes, index)].some(parent => nodes[parent]!.attrs.get('data-readonly') === 'true' || nodes[parent]!.attrs.get('data-qualified') === 'false' || nodes[parent]!.tag === 'fieldset' && nodes[parent]!.attrs.has('disabled'))
  for (const core of coreIndices) expect(blocked(core), document.route).toBe(false)
  nodes.forEach((node, index) => {
    if (node.template >= 0 || node.namespace !== 'html') return
    const core = coreIndices.some(parent => index === parent || ancestors(nodes, index).includes(parent))
    if (core) return
    for (const [name, value] of node.attrs) {
      if (/^data-.*(?:-can-(?:read|manage|write|send|save|move|kill|edit|create|delete)|-send-enabled|-draft-enabled|-write-enabled)$/.test(name)) expect(value, `${document.route}: ${name}`).not.toBe('true')
    }
    if (['input', 'select', 'textarea', 'button'].includes(node.tag) || node.attrs.get('contenteditable') === 'true') expect(node.attrs.has('disabled') || blocked(index), `${document.route}: ${node.tag}`).toBe(true)
  })
}

describe('complete registered V2 read-only document contract', () => {
  it('binds all 217 role-admitted documents and every declared alias', () => {
    expect(new Set(documents.map(page => page.route)).size).toBe(217)
    expect(documents).toHaveLength(217)
    expect(documents.filter(page => page.surface === 'xpanel')).toHaveLength(75)
    expect(documents.filter(page => page.surface === 'xwhm')).toHaveLength(119)
    expect(documents.filter(page => page.surface === 'xmail')).toHaveLength(23)
    expect(documents.filter(page => !canOpenRegisteredRoute(page.route, visibilityFor(page.surface))).map(page => page.route)).toEqual([])
    expect(documents.filter(page => page.route !== page.canonical)).toHaveLength(registeredDocumentAliases.length)
  })
  for (const document of documents) {
    for (const locale of ['en', 'ar'] as const) for (const observed of [false, true]) it(`${document.route}: ${locale} full read-only layout with ${observed ? 'supplied stored records' : 'missing rich records'}`, () => {
      const props = { ...descriptor(document, observed), locale }
      expect(props.admitted).toBe(true)
      const html = renderV2ReadOnlyPage(props)
      expect(typeof html).toBe('string')
      assertFullReadOnlyDocument(document, html!, locale)
      if (!observed) {
        for (const secret of [account.id, account.home, account.primaryDomain, plan.name, database.name, mailbox, message.subject, message.body]) expect(html).not.toContain(secret)
      }
    })
  }
})

describe('read-only documents keep collection permission and tenant boundaries', () => {
  it('does not expose stored database names when a team member has no database tool', () => {
    const document = documents.find(page => page.route === '/databases/mariadb')!
    const visibility = { ...ownerVisibility, allowedToolIds: new Set<string>() }
    const html = renderV2ReadOnlyPage(descriptor(document, true, visibility))!
    expect(html).not.toContain(database.name)
    expect(html).not.toContain('fixture_user')
    assertFullReadOnlyDocument(document, html)
  })
  it('rejects an account from another tenant before rendering its facts', () => {
    const document = documents.find(page => page.route === '/resources')!
    const value: UnavailableProps = { ...descriptor(document, true), readOnlyFacts: { surface: 'xpanel', panel: { ...panelFacts(true, ownerVisibility), account: { ...account, id: 'foreign-account-contract' } } } }
    expect(() => renderV2ReadOnlyPage(value)).toThrow('v2_readonly_authority_unavailable:xpanel')
  })
  it('redacts foreign mailbox users and domains even when the owner may read email facts', () => {
    const document = documents.find(page => page.route === '/email/accounts')!
    const value: UnavailableProps = { ...descriptor(document, true), readOnlyFacts: { surface: 'xpanel', panel: { ...panelFacts(true, ownerVisibility), domains: [domain, { ...domain, id: 'foreign-domain', accountId: 'foreign-account', name: 'foreign-hidden.example.test' }], serviceUsers: [{ id: 'foreign-service', accountId: 'foreign-account', login: 'foreign-hidden@example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 8, ftpDir: '' }] } } }
    const html = renderV2ReadOnlyPage(value)!
    expect(html).not.toContain('foreign-hidden')
    assertFullReadOnlyDocument(document, html)
  })
  it.each(['team', 'feature'] as const)('does not expose supplied message bodies through a denied %s capability', mode => {
    const document = documents.find(page => page.route === '/mail/inbox')!
    const visibility: VisibilityContext = { ...ownerVisibility, ...(mode === 'team' ? { allowedToolIds: new Set<string>() } : { disabledFeatures: new Set(catalog.filter(tool => tool.surface === 'xmail').flatMap(tool => tool.featureKey === null ? [] : [tool.featureKey])) }) }
    const html = renderV2ReadOnlyPage(descriptor(document, true, visibility))!
    expect(html).not.toContain(message.subject)
    expect(html).not.toContain(message.body)
    assertFullReadOnlyDocument(document, html)
  })
  it('keeps reseller ACL and ownership independent from the supplied account collection', () => {
    const principal: Principal = { kind: 'reseller', id: 'reseller-contract', username: 'dealer' }
    const reseller: Reseller = { id: principal.id, username: principal.username, acl: ['list-accounts'], maxAccounts: 5, totalDiskMb: 1024, totalBandwidthMb: 1024, oversell: false, nameservers: [], delegatedIps: [] }
    const owned = { ...account, ownerId: principal.id }
    const visibility: VisibilityContext = { principal, reseller }
    const props = { ...whmFacts(true, visibility), activeRoute: '/whm/accounts', activeReseller: reseller, accounts: [owned, { ...account, id: 'foreign-account', username: 'foreignowner', ownerId: 'foreign-reseller' }] }
    const view = projectReadOnlyWhmSurface(props)!
    expect(view.props.accounts).toEqual([owned])
    expect(view.authority).toMatchObject({ canRead: false, canReadAccounts: false, canManage: false, canUseTerminal: false })
    const denied = projectReadOnlyWhmSurface({ ...props, visibility: { principal, reseller: { acl: [] } } })!
    expect(denied.props.accounts).toBeUndefined()
  })
  it('never turns read-only projection into provider or write authority on any realm', () => {
    const panel = projectReadOnlyPanelSurface({ ...panelFacts(true, ownerVisibility), activeRoute: '/resources' })!
    const whm = projectReadOnlyWhmSurface({ ...whmFacts(true, rootVisibility), activeRoute: '/whm/accounts' })!
    const mail = projectReadOnlyMailSurface({ ...mailFacts(true, ownerVisibility), activeRoute: '/mail/inbox' })!
    for (const value of [panel, whm, mail]) expect(value.authority).toMatchObject({ presentation: 'read-only', canRead: false, canReadAccounts: false, canManage: false, canUseTerminal: false, canChangeOwner: false })
  })
})