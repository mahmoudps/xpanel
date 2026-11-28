import { tools, type CatalogTool, type VisibilityContext } from '../../packages/catalog/src/index.ts'
import { defaultPlan, type Account, type Principal } from '../../packages/core/src/index.ts'
import type { Locale } from '../../apps/web/src/i18n.ts'
import type { MailSurfaceProps } from '../../apps/web/src/surfaces/xmail.ts'
import type { PanelSurfaceProps, WhmSurfaceProps } from '../../apps/web/src/themes/contract.ts'
import { projectMailSurfaceView, projectReadOnlyMailSurfaceView } from '../../apps/web/src/models/mail.ts'
import { projectPanelSurface, projectReadOnlyPanelSurface, projectReadOnlyWhmSurface, projectWhmSurface } from '../../apps/web/src/models/theme-surface.ts'
import { v2Messages } from '../../apps/web/src/themes/v2/messages.ts'
import { renderV2MailCompose } from '../../apps/web/src/themes/v2/pages/xmail/compose.ts'
import { renderV2MailInbox } from '../../apps/web/src/themes/v2/pages/xmail/inbox.ts'
import { renderV2MailWorkspace } from '../../apps/web/src/themes/v2/pages/xmail/workspaces/index.ts'
import { renderV2PanelBody } from '../../apps/web/src/themes/v2/surfaces/xpanel.ts'
import { renderV2WhmBody } from '../../apps/web/src/themes/v2/surfaces/xwhm.ts'

export function verifiedTestCatalog(): readonly CatalogTool[] {
  return tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
}

export function fixtureAccount(overrides: Partial<Account> = {}): Account {
  const id = overrides.id ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const username = overrides.username ?? 'owner'
  return {
    id,
    username,
    uid: 20001,
    gid: 20001,
    home: `/home/${username}`,
    primaryDomain: `${username}.example.test`,
    planId: '11111111-1111-4111-8111-111111111111',
    ownerId: null,
    status: 'active',
    suspendReason: null,
    contactEmail: `${username}@example.test`,
    ipv4: '192.0.2.10',
    shell: 'jailed',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export function renderPanelRoute(
  activeRoute: string,
  overrides: Partial<PanelSurfaceProps> & { readonly canManage?: boolean; readonly readOnly?: boolean } = {},
): string {
  const { canManage = true, readOnly = false, ...rest } = overrides
  const account = fixtureAccount({ ...(rest.account ?? {}), status: canManage ? (rest.account?.status ?? 'active') : 'suspended' })
  const catalog = rest.catalog ?? verifiedTestCatalog()
  const plan = rest.plan ?? { ...defaultPlan({ id: account.planId, name: 'Standard' }), shell: 'jailed' as const }
  const visibility: VisibilityContext = rest.visibility ?? {
    principal: { kind: 'user', id: 'principal-panel-fixture', username: account.username, accountId: account.id },
    disabledFeatures: new Set(),
  }
  const input: PanelSurfaceProps = { locale: 'en', ...rest, account, plan, visibility, catalog, activeRoute }
  const view = readOnly ? projectReadOnlyPanelSurface(input) : projectPanelSurface(input)
  if (!view) throw new Error(`panel_route_unprojected:${activeRoute}`)
  const body = renderV2PanelBody(view)
  if (body === undefined) throw new Error(`panel_route_missing:${activeRoute}`)
  return body
}

export function renderWhmRoute(
  activeRoute: string,
  overrides: Partial<WhmSurfaceProps> & { readonly readOnly?: boolean } = {},
): string {
  const { readOnly = false, ...rest } = overrides
  const principal: Principal = rest.principal ?? { kind: 'root', id: 'root-fixture', username: 'operator' }
  const catalog = rest.catalog ?? verifiedTestCatalog()
  const visibility: VisibilityContext = rest.visibility ?? { principal, disabledFeatures: new Set() }
  const input: WhmSurfaceProps = { locale: 'en', ...rest, principal, visibility, catalog, activeRoute }
  const view = readOnly ? projectReadOnlyWhmSurface(input) : projectWhmSurface(input)
  if (!view) throw new Error(`whm_route_unprojected:${activeRoute}`)
  const body = renderV2WhmBody(view)
  if (body === undefined) throw new Error(`whm_route_missing:${activeRoute}`)
  return body
}

export function renderMailRoute(
  activeRoute: string,
  overrides: Partial<MailSurfaceProps> & { readonly readOnly?: boolean; readonly canRead?: boolean; readonly canManage?: boolean } = {},
): string {
  const { readOnly = false, canRead, canManage, ...rest } = overrides
  const locale: Locale = rest.locale ?? 'en'
  const mailbox = rest.mailbox ?? 'owner@example.test'
  const catalog = rest.catalog ?? verifiedTestCatalog()
  const visibility: VisibilityContext = rest.visibility ?? {
    principal: { kind: 'user', id: 'mail-owner-fixture', username: 'owner', accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    disabledFeatures: new Set(),
  }
  const input: MailSurfaceProps = { ...rest, locale, mailbox, visibility, catalog, activeRoute }
  if (readOnly) {
    const view = projectReadOnlyMailSurfaceView(input, {
      presentation: 'read-only',
      canReadFacts: true,
      canRead: false,
      canManage: false,
      canUseTerminal: false,
      canReadAccounts: false,
      canChangeOwner: false,
      allowUnlimited: false,
      ownerId: null,
      relatedRoutes: new Set(),
      qualifiedTools: new Set(),
      authorizedTools: new Set(catalog.filter(t => t.surface === 'xmail').map(t => t.id)),
      logKinds: [],
      domainSelectionAvailable: false,
    })
    if (!view || view.kind !== 'workspace') throw new Error(`mail_readonly_unprojected:${activeRoute}`)
    const html = renderV2MailWorkspace({ ...view, locale })
    if (html === undefined) throw new Error(`mail_route_missing:${activeRoute}`)
    return html
  }
  const view = projectMailSurfaceView(input)
  if (!view || view.kind !== 'workspace') throw new Error(`mail_route_unprojected:${activeRoute}`)
  const html = renderV2MailWorkspace({
    ...view,
    locale,
    ...(canRead === undefined ? {} : { canRead }),
    ...(canManage === undefined ? {} : { canManage }),
  })
  if (html === undefined) throw new Error(`mail_route_missing:${activeRoute}`)
  return html
}

export function renderMailInboxRoute(overrides: Partial<MailSurfaceProps> & { readonly readOnly?: boolean } = {}): string {
  const { readOnly = false, ...rest } = overrides
  const locale: Locale = rest.locale ?? 'en'
  const mailbox = rest.mailbox ?? 'owner@example.test'
  const catalog = rest.catalog ?? verifiedTestCatalog()
  const visibility: VisibilityContext = rest.visibility ?? {
    principal: { kind: 'user', id: 'mail-owner-fixture', username: 'owner', accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    disabledFeatures: new Set(),
  }
  const view = projectMailSurfaceView({ activeRoute: '/mail/inbox', ...rest, locale, mailbox, visibility, catalog })
  if (!view || view.kind !== 'inbox') throw new Error('mail_inbox_unprojected')
  return renderV2MailInbox(v2Messages.translator(locale), { ...view, ...(readOnly ? { readOnly: true } : {}) })
}

export function renderMailComposeRoute(overrides: Partial<MailSurfaceProps> & { readonly readOnly?: boolean } = {}): string {
  const { readOnly = false, ...rest } = overrides
  const locale: Locale = rest.locale ?? 'en'
  const mailbox = rest.mailbox ?? 'owner@example.test'
  const catalog = rest.catalog ?? verifiedTestCatalog()
  const visibility: VisibilityContext = rest.visibility ?? {
    principal: { kind: 'user', id: 'mail-owner-fixture', username: 'owner', accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    disabledFeatures: new Set(),
  }
  const view = projectMailSurfaceView({ activeRoute: '/mail/compose', ...rest, locale, mailbox, visibility, catalog })
  if (!view || view.kind !== 'compose') throw new Error('mail_compose_unprojected')
  return renderV2MailCompose(v2Messages.translator(locale), { ...view, ...(readOnly ? { readOnly: true } : {}) })
}
