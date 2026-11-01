import type { PanelSurfaceProps } from '../../../../contract.ts'
import { alternateLocales, languageName, localeDirection } from '../../../../../i18n.ts'
import { tabs, tabPanel } from '../../../components/tabs.ts'
import { actions, button, deniedPage, esc, facts, field, fields, input, link, note, page, section, settingsContext, split, status, table, technical, unreadRow, NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from './common.ts'

function accountPreferencesBody(props: PanelSurfaceProps, authority: PanelSettingsAuthority, interactive: boolean): string {
  const c = settingsContext(props, authority), { t } = c
  const form = `<${interactive ? 'form' : 'div'} class="v2-panel-settings__groups"${interactive ? ' data-contact-form' : ''}${!c.editable ? ' data-readonly="true"' : ''}>${field('v2-contact-email', t(msgid('Contact email')), input('v2-contact-email', 'contactEmail', 'text', ' inputmode="email" autocomplete="email" dir="ltr" maxlength="254" required', true), t(msgid('Update the email address in your account contact details.')))}${actions(`<button type="submit" class="v2-btn v2-btn--primary"${interactive ? ' data-contact-save' : ''} disabled>${esc(t(msgid('Save contact email')))}</button>` + button(t(msgid('Reload saved details')), interactive ? { 'data-contact-reload': true } : undefined))}</${interactive ? 'form' : 'div'}>`
  const contact = section('v2-account-contact', t(msgid('Contact email')), `<div class="v2-panel-settings__groups"${interactive ? ` data-account-contact data-contact-account="${esc((c.account?.id ?? ''))}" data-contact-manage="${c.editable}"` : ' data-v2-contact-preview data-readonly="true" data-qualified="false"'}>${facts([{ label: t(msgid('Saved contact email')), valueHtml: `<span${interactive ? ' data-contact-saved' : ''}>${esc(t(msgid('Not read')))}</span>` }])}${actions(button(t(msgid('Refresh saved details')), interactive ? { 'data-contact-refresh': true } : undefined, !c.readable))}<p role="status" aria-live="polite"${interactive ? ' data-contact-status' : ''} data-state="unread">${esc(t(msgid('Saved contact details have not been read.')))}</p>${form}</div>`)
  const appearance = section('v2-preferences-appearance', t(msgid('Appearance')), facts([{ label: t(msgid('Appearance')), valueHtml: esc(props.theme === undefined ? t(msgid('Not read')) : t(props.theme === 'dark' ? msgid('Dark') : msgid('Light'))) }, { label: t(msgid('Current language')), valueHtml: esc(languageName(c.locale, c.locale)) }, { label: t(msgid('Digits')), valueHtml: technical('0-9') }])
    + note(t(msgctxt('theme:v2', 'Use the workspace language, color scheme and theme controls to change presentation. Contact changes do not change those preferences.'))))
  return split(contact, appearance)
}

function accountLanguageBody(props: PanelSurfaceProps, authority: PanelSettingsAuthority, linksAllowed: boolean): string {
  const c = settingsContext(props, authority), { t } = c
  const choices = section('v2-language-choice', t(msgid('Current language')), facts([{ label: t(msgid('Language')), valueHtml: esc(languageName(c.locale, c.locale)) }, { label: t(msgid('Direction')), valueHtml: technical(localeDirection(c.locale).toUpperCase()) }, { label: t(msgid('Digits')), valueHtml: technical('0-9') }])
    + note(t(msgid('Use the workspace language control to change the interface language.'))), actions(alternateLocales(c.locale).map(locale => linksAllowed ? link(locale.name, '/preferences/language?' + new URLSearchParams({ lang: locale.tag, ...(props.theme ? { theme: props.theme } : {}) })) : button(locale.name)).join('')))
  const example = section('v2-language-values', t(msgctxt('theme:v2', 'Text and technical values')), facts([{ label: t(msgid('Domain')), valueHtml: technical(c.account?.primaryDomain ?? t(msgid('Not read'))) }, { label: t(msgid('Username')), valueHtml: technical(c.account?.username ?? t(msgid('Not read'))) }]) + note(t(msgctxt('theme:v2', 'Names, dates, references and numbers remain aligned beneath their labels. Technical values keep their own reading direction.'))))
  return split(choices, example)
}

/** Local tabs never grant a second route's contact authority or mount its transport. */
function preferencePage(props: PanelSurfaceProps, authority: PanelSettingsAuthority, selected: 'account' | 'language'): string {
  const c = settingsContext(props, authority), { t } = c
  const accountActive = selected === 'account'
  const route = accountActive ? '/preferences' : '/preferences/language'
  const title = t(accountActive ? msgid('Preferences') : msgid('Language'))
  const description = accountActive ? t(msgctxt('theme:v2', 'Keep account contact details and workspace presentation separate.'))
    : t(msgctxt('theme:v2', 'Choose the language for this workspace while keeping technical values readable.'))
  const nav = tabs({ label: t(msgid('Preferences')), tabs: [
    { id: 'v2-preferences-tab-account', label: t(msgid('Account')), panelId: 'v2-preferences-panel-account', selected: accountActive, hooks: { 'data-presentation-tab': 'account' } },
    { id: 'v2-preferences-tab-language', label: t(msgid('Language')), panelId: 'v2-preferences-panel-language', selected: !accountActive, hooks: { 'data-presentation-tab': 'language' } },
  ] })
  const accountBody = accountPreferencesBody(props, accountActive ? authority : NO_SETTINGS_AUTHORITY, accountActive)
  const accountHref = '/preferences?' + new URLSearchParams({ lang: c.locale, ...(props.theme ? { theme: props.theme } : {}) })
  const accountRoute = authority.relatedRoutes?.has('/preferences') === true
  const preview = accountActive ? '' : accountRoute
    ? note(t(msgctxt('theme:v2', 'Use the account preferences page to refresh or change saved contact details.')))
      + actions(link(t(msgctxt('theme:v2', 'Open account preferences')), accountHref))
    : note(t(msgid('Unavailable')))
  const languageBody = accountLanguageBody(props, authority, !accountActive || authority.relatedRoutes?.has('/preferences/language') === true)
  const content = nav
    + tabPanel({ id: 'v2-preferences-panel-account', tabId: 'v2-preferences-tab-account', hidden: !accountActive, sectionSpacing: true, bodyHtml: accountBody + preview })
    + tabPanel({ id: 'v2-preferences-panel-language', tabId: 'v2-preferences-tab-language', hidden: accountActive, sectionSpacing: true, bodyHtml: languageBody })
  return page(props, authority, route, title, description, `<div class="v2-panel-settings" data-v2-preferences-tabs data-presentation-tabs="panels">${content}</div>`)
}

export function renderV2AccountPreferencesPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  return preferencePage(props, authority, 'account')
}

export function renderV2AccountLanguagePage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  return preferencePage(props, authority, 'language')
}

export function renderV2ServiceUsersPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c, title = t(msgid('Service users')), description = t(msgctxt('theme:v2', 'Review account-owned logins and the services enabled for each login.'))
  const users = c.account ? props.serviceUsers?.filter(user => user.accountId === c.account!.id) : undefined
  const yes = t(msgid('Yes')), no = t(msgid('No'))
  const rows = users?.map(user => `<tr><td>${technical(user.login)}</td><td>${esc(user.services.email ? yes : no)}</td><td>${esc(user.services.ftp ? yes : no)}</td><td>${esc(user.services.webdisk ? yes : no)}</td></tr>`).join('')
    || unreadRow(4, users ? t(msgid('The read returned no service users.')) : t(msgctxt('theme:v2', 'Service users have not been read.')))
  const list = section('v2-service-users-list', title, table('v2-service-users-table', title, [t(msgid('Login')), t(msgid('Email enabled')), 'FTP', t(msgid('Web Disk'))], rows), authority.relatedRoutes?.has('/email/accounts') ? actions(link(t(msgctxt('theme:v2', 'Manage service users')), '/email/accounts')) : undefined)
  const help = section('v2-service-user-access', t(msgctxt('theme:v2', 'Service access')), note(t(msgctxt('theme:v2', 'Service users are separate from the account team. Use the email and service-user workspace to review credentials and access changes.')))
    + fields(field('v2-service-user-login', t(msgid('Username')), input('v2-service-user-login', '', 'text', ' dir="ltr" autocomplete="off"')) + field('v2-service-user-password', t(msgid('Password')), input('v2-service-user-password', '', 'password', ' dir="ltr" autocomplete="new-password"'))), actions(button(t(msgid('Create user')), undefined, true, true)))
  return page(props, authority, '/preferences/users', title, description, split(list, help))
}
