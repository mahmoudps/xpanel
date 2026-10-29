import type { Account, Domain, Plan, Principal } from '@xpanel/core'
import type { Locale } from '../../i18n.ts'
import '../../i18n.ts'
import { extensionCard, extensionCollection, extensionDisabled, extensionFact, extensionFrame, extensionText, type ExtensionCopy, type ExtensionRouteSpec, type ReadCollection } from './shared.ts'

const accountTitles: readonly (readonly [string, ExtensionCopy])[] = [
  ['/software/store', msgid('App catalog')],
  ['/software/store/app', msgid('Application details')],
  ['/software/store/install', msgid('Install application')],
  ['/software/store/progress', msgid('Installation progress')],
  ['/software/store/installed', msgid('Installed applications')],
  ['/software/store/updates', msgid('Application updates')],
  ['/software/store/error', msgid('Installer status')],
]
const rootTitles: readonly (readonly [string, ExtensionCopy])[] = [
  ['/whm/software/store', msgid('Catalog settings')],
  ['/whm/software/store/extensions', msgid('Server extensions')],
  ['/whm/software/store/activity', msgid('Installer activity')],
]

/** Proposed route metadata only; existing navigation admission must register it. */
export const storeRouteSpecs: readonly ExtensionRouteSpec[] = [
  ...accountTitles.map(([route, title]): ExtensionRouteSpec => ({ route, title, surface: 'xpanel', roles: ['owner'], tools: ['app-installer'] })),
  ...rootTitles.map(([route, title]): ExtensionRouteSpec => ({ route, title, surface: 'xwhm', roles: ['root'], tools: ['site-software-catalog', 'site-software-instances'] })),
]

export interface StoreExtensionInput {
  locale: Locale
  route: string
  principal: Principal
  account?: Pick<Account, 'id' | 'status'>
  domains?: ReadCollection<Pick<Domain, 'accountId' | 'name'>>
  plans?: ReadCollection<Pick<Plan, 'name'>>
  platform?: { state: 'unread' } | { state: 'read'; name: string; version: string }
}

/** Read-only presentation. It has no signed-catalog reader or installer transport. */
export const renderStoreExtension = (input: StoreExtensionInput): string => {
  const { locale, principal } = input
  const route = input.route === '/software/installer' ? '/software/store'
    : input.route === '/whm/software/site-software' ? '/whm/software/store' : input.route
  const spec = storeRouteSpecs.find(item => item.route === route)
  if (!spec) return ''
  const root = spec.surface === 'xwhm'
  const account = input.account
  if (root ? principal.kind !== 'root' : !account || principal.kind !== 'user' || principal.accountId !== account.id || account.status !== 'active') return ''
  const viewNavigation = `<nav class="xp-extension__actions" aria-label="${extensionText(locale, msgid('Store views'))}">${storeRouteSpecs.filter(item => item.surface === spec.surface).map(item => `<a class="xp-btn${item.route === route ? ' xp-btn--primary' : ''}" href="${item.route}" data-nav-route="${item.route}"${item.route === route ? ' aria-current="page"' : ''}>${extensionText(locale, item.title)}</a>`).join('')}</nav>`
  const unavailable = extensionCard(locale, msgid('Installer unavailable'), `<p data-installer-state="unavailable">${extensionText(locale, msgid('A signed catalog and installer are not connected to this view. Installation, update and rollback controls are unavailable; job state has not been read.'))}</p><dl class="xp-extension__facts">${extensionFact(locale, msgid('Catalog'), undefined)}${extensionFact(locale, msgid('Installed applications'), undefined)}${extensionFact(locale, msgid('Platform'), input.platform?.state === 'read' ? input.platform.name : undefined)}${extensionFact(locale, msgid('Platform version'), input.platform?.state === 'read' ? input.platform.version : undefined, true)}</dl>`)
  let details = ''
  if (root) {
    if (route.endsWith('/activity')) {
      details = extensionCard(locale, msgid('Installer activity'), `<p data-collection-state="unread">${extensionText(locale, msgid('Installer activity was not read. General audit events are not installer activity.'))}</p>`)
    } else {
      details = extensionCard(locale, msgid('Catalog authority'), `<dl class="xp-extension__facts">${extensionFact(locale, msgid('Catalog sources'), undefined)}${extensionFact(locale, msgid('Trusted signing keys'), undefined)}${extensionFact(locale, msgctxt('store', 'Extensions'), undefined)}</dl><p>${extensionText(locale, msgid('Private signing keys are never shown here.'))}</p>${extensionCollection(locale, input.plans, msgid('The read returned no plans.'), plan => `<dl class="xp-extension__facts">${extensionFact(locale, msgid('Plan'), plan.name)}${extensionFact(locale, msgid('Application feature key'), undefined)}</dl>`)}<div class="xp-extension__actions">${extensionDisabled(locale, msgid('Add source'))}${extensionDisabled(locale, msgid('Save feature keys'))}${extensionDisabled(locale, msgid('Install extension'))}</div>`)
    }
  } else {
    const domains = input.domains?.state === 'read' ? { state: 'read' as const, items: input.domains.items.filter(domain => domain.accountId === input.account?.id) } : undefined
    details = extensionCard(locale, msgid('Installation target'), extensionCollection(locale, domains, msgid('The read returned no domains.'), domain => `<dl class="xp-extension__facts">${extensionFact(locale, msgid('Domain'), domain.name, true)}</dl>`))
    if (route.endsWith('/app')) details += extensionCard(locale, msgid('Application metadata'), `<dl class="xp-extension__facts">${extensionFact(locale, msgid('Version'), undefined)}${extensionFact(locale, msgid('Requirements'), undefined)}${extensionFact(locale, msgid('Requested permissions'), undefined)}${extensionFact(locale, msgid('Changelog'), undefined)}</dl>`)
    if (route.endsWith('/progress') || route.endsWith('/updates')) details += extensionCard(locale, msgid('Job state'), `<p data-installer-progress="unread">${extensionText(locale, msgid('Job state, progress and logs have not been read.'))}</p>`)
  }
  const actions = extensionCard(locale, msgid('Available actions'), `<div class="xp-extension__actions">${extensionDisabled(locale, msgid('Install'))}${extensionDisabled(locale, msgid('Update'))}${extensionDisabled(locale, msgid('Roll back'))}${extensionDisabled(locale, msgid('Uninstall'))}${extensionDisabled(locale, msgid('Retry'))}</div>`)
  return extensionFrame(locale, spec.title, `${viewNavigation}${unavailable}${details}${actions}`)
}
