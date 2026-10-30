import { alternateLocales } from '../../../i18n.ts'
import { projectActionState } from '../../../models/action-state.ts'
import type { PanelSurfaceView, ReadOnlyPanelSurfaceView } from '../../../models/theme-surface.ts'
import type { PanelSurfaceProps, ThemeViewProps, UiTheme } from '../../contract.ts'
import { actionState } from '../components/action-state.ts'
import { v2Messages } from '../messages.ts'
import { renderV2PanelHome, scopePrimaryPanelFacts } from '../pages/xpanel/home.ts'
import { renderV2PanelResources } from '../pages/xpanel/resources.ts'
import { renderV2EmailAccountsPage } from '../pages/xpanel/email/accounts.ts'
import { renderV2EmailForwardersPage } from '../pages/xpanel/email/forwarders.ts'
import { renderV2DirectoryPrivacyPage, renderV2FilesPage } from '../pages/xpanel/files/index.ts'
import { renderV2PanelDatabasePage, V2_DATABASE_ROUTES } from '../pages/xpanel/databases/index.ts'
import { renderV2DomainPage } from '../pages/xpanel/domains/index.ts'
import { renderV2PanelServicePage } from '../pages/xpanel/services/index.ts'
import { renderV2PanelOperationsPage } from '../pages/xpanel/operations/index.ts'
import { renderV2PanelEmailTool } from '../pages/xpanel/email-tools/index.ts'
import { renderV2PanelObservation } from '../pages/xpanel/observations/index.ts'
import { renderV2PanelSettingsPage } from '../pages/xpanel/settings/remaining.ts'
import { renderV2Shell } from '../shell/shell.ts'

export type V2PanelProjector = (props: PanelSurfaceProps & ThemeViewProps) => PanelSurfaceView | undefined

/** Bodies consume only core-scoped facts and capabilities. A missing body is an implementation gap. */
export function renderV2PanelBody(view: PanelSurfaceView | ReadOnlyPanelSurfaceView): string | undefined {
  const a = view.authority
  const primary = ['/home', '/resources', '/email/accounts', '/email/forwarders', '/files/manager', '/files/trash', '/files/directory-privacy'].includes(view.route)
  const props = primary ? scopePrimaryPanelFacts(view.props, a) : view.props
  const t = v2Messages.translator(props.locale ?? 'en')
  switch (view.route) {
    case '/home': return renderV2PanelHome(props, a)
    case '/resources': return renderV2PanelResources(props, a)
    case '/email/accounts': return renderV2EmailAccountsPage(t, {
      account: props.account,
      ...(props.plan ? { plan: props.plan } : {}),
      domains: props.domains === undefined ? { state: 'unread' } : { state: 'read', items: props.domains },
      users: props.serviceUsers === undefined ? { state: 'unread' } : { state: 'read', items: props.serviceUsers },
      canManage: a.canManage, readOnly: a.presentation === 'read-only',
    })
    case '/email/forwarders': return renderV2EmailForwardersPage(t, {
      readOnly: a.presentation === 'read-only', domainsObserved: props.domains !== undefined, mailboxesObserved: props.serviceUsers !== undefined,
      domains: props.domains ?? [], mailboxes: props.serviceUsers?.filter(user => user.services.email).map(user => user.login) ?? [],
      canManage: a.canManage && props.domains !== undefined,
    })
    case '/files/manager':
    case '/files/trash': return renderV2FilesPage(t, { surface: props, canManage: a.canManage, authority: a })
    case '/files/directory-privacy': return renderV2DirectoryPrivacyPage(t, { surface: props, canManage: a.canManage, authority: a })
    default: return renderV2PanelDatabasePage(props, { presentation: a.presentation, canReadFacts: a.canReadFacts, authorizedTools: a.authorizedTools, canRead: a.canRead, canManage: a.canManage, relatedRoutes: new Set(V2_DATABASE_ROUTES.filter(route => a.relatedRoutes.has(route))) })
      ?? renderV2DomainPage(props, a) ?? renderV2PanelServicePage(props, a) ?? renderV2PanelOperationsPage(props, a)
      ?? renderV2PanelEmailTool(props, a) ?? renderV2PanelObservation(props, a) ?? renderV2PanelSettingsPage(props, a)
  }
}

/** Core provides the projector and the real denied/unavailable path; qualified missing pages fail explicitly. */
export function createV2PanelSurface(project: V2PanelProjector, unavailable: UiTheme['renderPanel']): UiTheme['renderPanel'] {
  return input => {
    const view = project(input)
    if (view === undefined) return unavailable(input)
    const props = view.props, account = props.account, locale = props.locale ?? 'en', scheme = props.theme ?? 'light'
    const t = v2Messages.translator(locale), content = renderV2PanelBody(view)
    if (content === undefined) throw new Error('v2_panel_implementation_gap:' + view.route)
    const query = (changes: Record<string, string>): string => {
      const values = new URLSearchParams({ lang: locale, theme: scheme, ...(props.density ? { density: props.density } : {}), ...(props.activeDomain ? { domain: props.activeDomain } : {}),
        ...((view.route === '/metrics/traffic' || view.route === '/metrics/web-stats') && props.websiteAnalyticsWindow ? { window: props.websiteAnalyticsWindow } : {}), ...changes })
      return view.route + '?' + values.toString()
    }
    const feedback = props.actionState ? actionState(projectActionState({ ...props.actionState, locale })) : ''
    const status = account.status === 'active' ? t('Active') : account.status === 'suspended' ? t('Suspended') : t('Terminating')
    return renderV2Shell(t, {
      surface: 'xpanel', activeRoute: view.route, homeHref: '/home', visibility: view.visibility, catalog: view.catalog,
      ...(props.branding ? { branding: props.branding } : {}),
      context: { label: t('Account'), title: account.username, initial: account.username.charAt(0),
        ...(props.plan ? { badge: props.plan.name } : {}), detail: account.primaryDomain,
        status: { tone: account.status === 'active' ? 'info' : account.status === 'suspended' ? 'warn' : 'bad', label: status } },
      realtimeEnabled: props.realtimeEnabled === true,
      languages: alternateLocales(locale).map(info => ({ tag: info.tag, href: query({ lang: info.tag }) })),
      scheme: { current: scheme, toggleHref: query({ theme: scheme === 'dark' ? 'light' : 'dark' }) },
      account: { signedIn: true, username: view.visibility.principal.username,
        ...(view.authority.relatedRoutes.has('/security/account') ? { securityHref: '/security/account' } : {}) },
      hooks: { 'data-account-username': account.username, 'data-account-id': account.id },
      contentHtml: feedback + content,
    })
  }
}
