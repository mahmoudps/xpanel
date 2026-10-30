import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, area, button, check, deniedPage, esc, facts, field, fields, input, link, note, page, section, select, settingsContext, split, status, table, technical, unreadRow, NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from '../settings/common.ts'

const ROUTES = [
  ['/software/store', msgid('App catalog')], ['/software/store/app', msgid('Application details')], ['/software/store/install', msgid('Install application')], ['/software/store/progress', msgid('Installation progress')], ['/software/store/installed', msgid('Installed applications')], ['/software/store/updates', msgid('Application updates')], ['/software/store/error', msgid('Installer status')],
] as const
export const V2_PANEL_STORE_ROUTES: readonly string[] = Object.freeze(['/software/installer', ...ROUTES.map(([route]) => route)])

/** Catalog metadata is not invented when no signed catalog reader or installer transport is supplied. */
export function renderV2PanelStorePage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string | undefined {
  const route = props.activeRoute
  if (!route || !V2_PANEL_STORE_ROUTES.includes(route)) return undefined
  const c = settingsContext(props, authority), { t } = c, canonical = route === '/software/installer' ? '/software/store' : route
  const title = t(ROUTES.find(([candidate]) => candidate === canonical)![1]), description = t(msgctxt('theme:v2', 'Review application sources, installation choices and current operation state.'))
  if (!c.readable) return deniedPage(props, authority, route, title, description)
  const nav = `<nav class="v2-panel-settings__tabs" aria-label="${esc(t(msgid('Store views')))}">${ROUTES.filter(([candidate]) => candidate === canonical || authority.relatedRoutes?.has(candidate)).map(([candidate, copy]) => `<a class="v2-btn" href="${esc(candidate)}"${candidate === canonical ? ' aria-current="page"' : ''}>${esc(t(copy))}</a>`).join('')}</nav>`
  const admission = section('v2-store-authority', t(msgid('Installer unavailable')), `<p data-installer-state="unavailable" role="status">${esc(t(msgid('A signed catalog and installer are not connected to this view. Installation, update and rollback controls are unavailable; job state has not been read.')))}</p>`
    + facts([{ label: t(msgid('Catalog')), valueHtml: esc(t(msgid('Not read'))) }, { label: t(msgid('Installed applications')), valueHtml: esc(t(msgid('Not read'))) }, { label: t(msgid('Platform')), valueHtml: esc(t(msgid('Not read'))) }, { label: t(msgid('Platform version')), valueHtml: esc(t(msgid('Not read'))) }]))
  const target = section('v2-store-target', t(msgid('Installation target')), c.domains === undefined ? status(t(msgctxt('theme:v2', 'Installation domains have not been read.')))
    : c.domains.length === 0 ? status(t(msgid('The read returned no domains.')))
      : facts(c.domains.map(domain => ({ label: t(msgid('Domain')), valueHtml: technical(domain.name) }))))
  const actionsCard = section('v2-store-actions', t(msgid('Available actions')), note(t(msgctxt('theme:v2', 'These actions require a verified signed catalog, an authorized target and a connected installer.'))), actions([msgid('Install'), msgid('Update'), msgid('Roll back'), msgid('Uninstall'), msgid('Retry')].map(copy => button(t(copy))).join('')))
  let body: string
  if (canonical === '/software/store/app') {
    body = section('v2-store-application', t(msgid('Application metadata')), facts([msgid('Name'), msgid('Version'), msgid('Requirements'), msgid('Requested permissions'), msgid('Changelog')].map(copy => ({ label: t(copy), valueHtml: esc(t(msgid('Not read'))) }))))
      + section('v2-store-application-permissions', t(msgid('Requested permissions')), table('v2-store-permissions', t(msgid('Requested permissions')), [t(msgid('Permission')), t(msgctxt('theme:v2', 'Purpose')), t(msgid('State'))], unreadRow(3, t(msgctxt('theme:v2', 'Signed application permissions have not been read.')))))
  } else if (canonical === '/software/store/install') {
    const steps = `<ol class="v2-panel-settings__steps">${[msgctxt('theme:v2', 'Application'), msgid('Installation target'), msgid('Review'), msgid('Result')].map((copy, i) => `<li><b>${i + 1}</b><span>${esc(t(copy))}</span></li>`).join('')}</ol>`
    body = steps + section('v2-store-install-target', t(msgid('Installation target')), fields(field('v2-store-domain', t(msgid('Domain')), select('v2-store-domain', '', (c.domains ?? []).map(domain => [domain.name, domain.name])))
      + field('v2-store-directory', t(msgid('Directory')), input('v2-store-directory', '', 'text', ' dir="ltr" maxlength="512"'))
      + field('v2-store-database', t(msgid('Database')), input('v2-store-database', '', 'text', ' dir="ltr" maxlength="64"')))
      + fields(field('v2-store-admin', t(msgctxt('theme:v2', 'Application administrator')), input('v2-store-admin', '', 'text', ' dir="ltr" autocomplete="off"')) + field('v2-store-password', t(msgid('Password')), input('v2-store-password', '', 'password', ' dir="ltr" autocomplete="new-password"'))))
      + section('v2-store-install-review', t(msgid('Review')), facts([msgid('Application'), msgid('Version'), msgid('Domain'), msgid('Directory'), msgid('Database')].map(copy => ({ label: t(copy), valueHtml: esc(t(msgid('Not read'))) })))
        + check('v2-store-install-ack', t(msgctxt('theme:v2', 'I reviewed the target and requested permissions.'))), actions(button(t(msgid('Cancel'))) + button(t(msgid('Install application')), undefined, true, true)))
  } else if (canonical === '/software/store/progress') {
    body = section('v2-store-progress', t(msgid('Installation progress')), facts([{ label: t(msgid('Job Ref')), valueHtml: esc(t(msgid('Unnumbered'))) }, { label: t(msgid('Status')), valueHtml: esc(t(msgid('Not read'))) }, { label: t(msgid('Progress')), valueHtml: esc(t(msgid('Not read'))) }])
      + `<ol class="v2-panel-settings__steps">${[msgctxt('theme:v2', 'Verify package'), msgctxt('theme:v2', 'Prepare target'), msgid('Install'), msgctxt('theme:v2', 'Check application')].map((copy, i) => `<li><b>${i + 1}</b><span>${esc(t(copy))}</span></li>`).join('')}</ol>`
      + `<p data-installer-progress="unread">${esc(t(msgid('Job state, progress and logs have not been read.')))}</p><pre class="v2-panel-settings__preview v2-mono" dir="ltr">${esc(t(msgctxt('theme:v2', 'No installer output was supplied.')))}</pre>`)
  } else if (canonical === '/software/store/installed' || canonical === '/software/store/updates') {
    body = section('v2-store-installed', title, table('v2-store-installed-table', title, [t(msgid('Application')), t(msgid('Domain')), t(msgid('Directory')), t(msgid('Version')), t(msgid('Status')), t(msgid('Actions'))], unreadRow(6, t(msgctxt('theme:v2', 'Installed application records have not been read.')))))
      + (canonical.endsWith('/updates') ? section('v2-store-update-review', t(msgctxt('theme:v2', 'Update review')), facts([{ label: t(msgctxt('theme:v2', 'Installed version')), valueHtml: esc(t(msgid('Not read'))) }, { label: t(msgctxt('theme:v2', 'Available version')), valueHtml: esc(t(msgid('Not read'))) }]) + note(t(msgctxt('theme:v2', 'No update comparison or backup verification has run.')))) : '')
  } else if (canonical === '/software/store/error') {
    body = section('v2-store-result', t(msgid('Installer status')), status(t(msgctxt('theme:v2', 'No installer result was supplied. A failed job is not assumed.')))
      + facts([{ label: t(msgid('Job Ref')), valueHtml: esc(t(msgid('Unnumbered'))) }, { label: t(msgctxt('theme:v2', 'Recovery state')), valueHtml: esc(t(msgid('Not read'))) }])
      + `<pre class="v2-panel-settings__preview v2-mono" dir="ltr">${esc(t(msgctxt('theme:v2', 'No diagnostic output was supplied.')))}</pre>`)
  } else {
    body = section('v2-store-catalog', t(msgid('App catalog')), fields(field('v2-store-search', t(msgid('Search')), input('v2-store-search', '', 'search', ' dir="auto" autocomplete="off"')) + field('v2-store-category', t(msgid('Category')), select('v2-store-category', '', [['', t(msgctxt('theme:v2', 'Categories have not been read.'))]])))
      + table('v2-store-catalog-table', t(msgid('App catalog')), [t(msgid('Application')), t(msgid('Version')), t(msgid('Requirements')), t(msgid('Actions'))], unreadRow(4, t(msgctxt('theme:v2', 'No signed catalog has been read.')))))
  }
  return page(props, authority, route, title, description, nav + admission + split(body + actionsCard, target), { 'data-wiring': 'unavailable' })
}
