import { alternateLocales } from '../../../i18n.ts'
import { projectActionState } from '../../../models/action-state.ts'
import type { WhmSurfaceView } from '../../../models/theme-surface.ts'
import type { ThemeViewProps, UiTheme, WhmSurfaceProps } from '../../contract.ts'
import { actionState } from '../components/action-state.ts'
import { v2Messages } from '../messages.ts'
import { renderV2WhmOverview } from '../pages/xwhm/overview/index.ts'
import { renderV2WhmAccountList } from '../pages/xwhm/accounts/list.ts'
import { renderV2WhmAccountCreate } from '../pages/xwhm/accounts/create.ts'
import { renderV2WhmAccountToolsPage } from '../pages/xwhm/account-tools/index.ts'
import { renderV2WhmRecoveryToolsPage } from '../pages/xwhm/recovery-tools/index.ts'
import { renderV2WhmPlanPage } from '../pages/xwhm/plans/index.ts'
import { renderV2WhmResellerPage } from '../pages/xwhm/resellers/index.ts'
import { renderV2WhmNetworkPage } from '../pages/xwhm/domains/routes.ts'
import { renderV2WhmFirewall, renderV2WhmPhp, renderV2WhmServiceManager, renderV2WhmServices } from '../pages/xwhm/host/index.ts'
import { renderV2BackupsPage, renderV2BackupDestinationsPage, renderV2TransferPage, renderV2UpgradePage } from '../pages/xwhm/lifecycle/index.ts'
import { renderV2WhmMailPage } from '../pages/xwhm/mail/index.ts'
import { renderV2WhmMonitoringPage } from '../pages/xwhm/monitoring/index.ts'
import { renderV2WhmSecurityPage } from '../pages/xwhm/security/index.ts'
import { renderV2WhmActivityPage } from '../pages/xwhm/activity/index.ts'
import { renderV2WhmDatabasePage } from '../pages/xwhm/databases/index.ts'
import { renderV2WhmSoftwarePage } from '../pages/xwhm/software/index.ts'
import { renderV2WhmServiceToolPage } from '../pages/xwhm/service-tools/index.ts'
import { renderV2WhmServerPage } from '../pages/xwhm/server/index.ts'
import { renderV2WhmPanelPage } from '../pages/xwhm/panel/index.ts'
import { renderV2Shell } from '../shell/shell.ts'

export type V2WhmProjector = (props: WhmSurfaceProps & ThemeViewProps) => WhmSurfaceView | undefined

/** Every dispatch branch is a real body. Unknown or unfinished qualified documents stay explicit gaps. */
export function renderV2WhmBody(view: WhmSurfaceView): string | undefined {
  const props = view.props, a = view.authority, locale = props.locale ?? 'en', t = v2Messages.translator(locale)
  const root = props.principal.kind === 'root'
  const access = { locale, presentation: a.presentation, canReadFacts: a.canReadFacts, authorizedTools: a.authorizedTools, canRead: a.canRead, canManage: a.canManage }
  switch (view.route) {
    case '/whm': return renderV2WhmOverview(t, props)
    case '/whm/accounts': return renderV2WhmAccountList(t, props, a)
    case '/whm/accounts/new': return renderV2WhmAccountCreate(t, props, a)
    case '/whm/services': return renderV2WhmServices(props)
    case '/whm/services/more': return renderV2WhmServiceManager(props)
    case '/whm/security/firewall': return renderV2WhmFirewall(props)
    case '/whm/software/php': return renderV2WhmPhp(props)
    case '/whm/backups':
    case '/whm/backups/restore': return renderV2BackupsPage({ ...access, activeRoute: view.route, ...(props.accounts ? { accounts: props.accounts } : {}) })
    case '/whm/backups/destinations': return renderV2BackupDestinationsPage(access)
    case '/whm/transfers':
    case '/whm/transfers/server': return renderV2TransferPage({ ...access, scope: view.route === '/whm/transfers/server' ? 'server' : 'accounts' })
    case '/whm/server/upgrade': return renderV2UpgradePage({ ...access, ...(props.hostname ? { hostname: props.hostname } : {}) })
    default: {
      const observation = { ...props, observationAuthority: a,
        monitoringLogUnits: view.monitoringLogUnits, monitoringLogDefaultLines: view.monitoringLogDefaultLines, monitoringLogMaxLines: view.monitoringLogMaxLines }
      const data = { ...props, dataAuthority: { presentation: a.presentation, canReadFacts: a.canReadFacts, authorizedTools: a.authorizedTools, canRead: a.canRead, canManage: a.canManage,
        canKill: root && a.canManage && view.route === '/whm/databases/processes' && a.qualifiedTools.has('db-process-list') } }
      return renderV2WhmPlanPage(t, props, a) ?? renderV2WhmResellerPage(t, props, a) ?? renderV2WhmNetworkPage(props, a)
        ?? renderV2WhmMailPage({ ...props, mailAuthority: a })
        ?? renderV2WhmMonitoringPage(observation) ?? renderV2WhmSecurityPage(observation) ?? renderV2WhmActivityPage(observation)
        ?? renderV2WhmDatabasePage(data) ?? renderV2WhmSoftwarePage(data) ?? renderV2WhmServiceToolPage(data)
        ?? renderV2WhmAccountToolsPage(props, { ...a, root }) ?? renderV2WhmRecoveryToolsPage(props, { ...a, root })
        ?? renderV2WhmServerPage(t, props, a) ?? renderV2WhmPanelPage(t, props, { ...a, ...(props.themePackages ? { themePackages: props.themePackages } : {}) })
    }
  }
}

export function createV2WhmSurface(project: V2WhmProjector, unavailable: UiTheme['renderWhm']): UiTheme['renderWhm'] {
  return input => {
    const view = project(input)
    if (view === undefined) return unavailable(input)
    const props = view.props, principal = props.principal, locale = props.locale ?? 'en', scheme = props.theme ?? 'light'
    const t = v2Messages.translator(locale), content = renderV2WhmBody(view)
    if (content === undefined) throw new Error('v2_whm_implementation_gap:' + view.route)
    const query = (changes: Record<string, string>): string => {
      const values = new URLSearchParams({ lang: locale, theme: scheme, ...(props.density ? { density: props.density } : {}), ...changes })
      if (props.planEditorState?.kind === 'edit') values.set('planId', props.planEditorState.plan.id)
      if (view.route === '/whm/audit' && props.auditList) {
        for (const key of ['actor', 'action', 'target', 'before', 'outcome', 'from', 'to'] as const) {
          const value = props.auditList[key]
          if (value) values.set(key, value)
        }
      }
      return view.route + '?' + values.toString()
    }
    const feedback = props.actionState ? actionState(projectActionState({ ...props.actionState, locale })) : ''
    const role = principal.kind === 'root' ? t('Root') : t('Reseller')
    const generation = props.generationId !== undefined && Number.isSafeInteger(props.generationId) && props.generationId > 0 ? props.generationId : undefined
    return renderV2Shell(t, {
      surface: 'xwhm', activeRoute: view.route, homeHref: '/whm', visibility: view.visibility, catalog: view.catalog,
      ...(props.branding ? { branding: props.branding } : {}),
      context: { label: t('Server'), title: props.hostname ?? t('Server'), badge: role,
        ...(props.version ? { meta: [props.version] } : {}) },
      ...(props.hostname ? { server: { name: props.hostname, ...(generation === undefined ? {} : { generationId: generation }) } } : {}),
      realtimeEnabled: props.realtimeEnabled === true,
      languages: alternateLocales(locale).map(info => ({ tag: info.tag, href: query({ lang: info.tag }) })),
      scheme: { current: scheme, toggleHref: query({ theme: scheme === 'dark' ? 'light' : 'dark' }) },
      account: { signedIn: true, username: principal.username, roleLabel: role,
        ...(view.authority.relatedRoutes.has('/whm/security/sign-in') ? { securityHref: '/whm/security/sign-in' } : {}) },
      contentHtml: feedback + content,
    })
  }
}
