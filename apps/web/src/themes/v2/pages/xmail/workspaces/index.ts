import { MAIL_ORGANIZER_CSS, renderMailCalendarPage, renderMailCalendarSettingsPage, renderMailContactsPage } from './organizer.ts'
import { renderMailFiltersPage, renderMailForwardersPage, renderMailIdentitiesPage, renderMailPreferencesPage, renderMailSpamPage, renderMailVacationPage } from './settings.ts'
import { renderMailConnectDevicesPage, renderMailDiskUsagePage, renderMailFoldersPage, renderMailMailingListsPage, renderMailOverviewPage, renderMailSearchPage, renderMailSecurityPage, renderMailToolsPage, renderMailTrackDeliveryPage } from './tools.ts'
import { MAIL_WORKSPACES_CSS as WORKSPACE_BASE_CSS, type MailWorkspaceInput } from './common.ts'

export type { MailWorkspaceInput } from './common.ts'
export const MAIL_WORKSPACES_CSS = `${WORKSPACE_BASE_CSS.trim()}\n${MAIL_ORGANIZER_CSS.trim()}\n`
export { renderMailCalendarPage, renderMailCalendarSettingsPage, renderMailContactsPage } from './organizer.ts'
export { renderMailFiltersPage, renderMailForwardersPage, renderMailIdentitiesPage, renderMailPreferencesPage, renderMailSpamPage, renderMailVacationPage } from './settings.ts'
export { renderMailConnectDevicesPage, renderMailDiskUsagePage, renderMailFoldersPage, renderMailMailingListsPage, renderMailOverviewPage, renderMailSearchPage, renderMailSecurityPage, renderMailToolsPage, renderMailTrackDeliveryPage } from './tools.ts'

const RENDERERS: Readonly<Record<string, (input: MailWorkspaceInput) => string>> = {
  '/mail/search': renderMailSearchPage,
  '/mail/folders': renderMailFoldersPage,
  '/mail/later': renderMailToolsPage,
  '/mail/calendar': renderMailCalendarPage,
  '/mail/contacts': renderMailContactsPage,
  '/mail/settings/calendars': renderMailCalendarSettingsPage,
  '/mail/settings/filters': renderMailFiltersPage,
  '/mail/settings/spam': renderMailSpamPage,
  '/mail/settings/autoresponder': renderMailVacationPage,
  '/mail/settings/forwarders': renderMailForwardersPage,
  '/mail/overview': renderMailOverviewPage,
  '/mail/tools/disk-usage': renderMailDiskUsagePage,
  '/mail/tools/connect-devices': renderMailConnectDevicesPage,
  '/mail/tools/track-delivery': renderMailTrackDeliveryPage,
  '/mail/tools/mailing-lists': renderMailMailingListsPage,
  '/mail/settings/preferences': renderMailPreferencesPage,
  '/mail/settings/identities': renderMailIdentitiesPage,
  '/mail/settings/security': renderMailSecurityPage,
}

/** Exact workspace documents only. Folder/inbox and compose keep their existing dedicated renderers. */
export const renderV2MailWorkspace = (input: MailWorkspaceInput): string | undefined =>
  Object.hasOwn(RENDERERS, input.route) ? RENDERERS[input.route]!(input) : undefined

export const mailWorkspaceRoutes = Object.freeze(Object.keys(RENDERERS))
