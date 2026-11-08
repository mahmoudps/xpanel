import { translator, type Locale, type MessageValues } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

/**
 * Classic cards for WHM Demo Mode, Hooks, Registered Applications, Plugins, Theme Manager and Site Software. The shared
 * whm-extend client fills them from their root APIs; until it has read them they say so, and without root authority
 * every control stays disabled.
 */
export interface WhmExtendCardInput { locale: Locale; canManage: boolean }
const view = (locale: Locale) => {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(locale)(message, values))
  const table = (title: string, headers: readonly string[], hook: string, empty: string): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(title)}"><table class="xp-whm-detail-table"><caption class="xp-sr-only">${t(title)}</caption><thead><tr>${headers.map(header => `<th scope="col">${t(header)}</th>`).join('')}</tr></thead><tbody ${hook}><tr><td colspan="${headers.length}">${t(empty)}</td></tr></tbody></table></div>`
  const button = (label: string, hook: string, primary = false): string => `<button type="button" class="xp-btn${primary ? ' xp-btn--primary' : ''}" ${hook} disabled>${t(label)}</button>`
  const field = (id: string, label: string, control: string, help = ''): string => `<div class="xp-whm-detail-field"><label for="${id}">${t(label)}</label>${control}${help ? `<p class="xp-help">${t(help)}</p>` : ''}</div>`
  const select = (id: string, hook: string, placeholder: string): string => `<select id="${id}" ${hook} disabled><option value="">${t(placeholder)}</option></select>`
  const status = (hook: string, canManage: boolean, unread: string): string => `<p class="xp-whm-detail-status" ${hook} data-state="${canManage ? 'unread' : 'unavailable'}" role="status">${canManage ? t(unread) : t('This page requires an authorized administrator. Nothing was read or changed.')}</p>`
  const card = (key: string, title: string, root: string, body: string): string => `<section class="xp-whm-detail-card" data-whm-detail-section="${key}" aria-labelledby="whm-detail-${key}" ${root}><h2 id="whm-detail-${key}">${t(title)}</h2>${body}</section>`
  return { t, table, button, field, select, status, card }
}

export function renderWhmDemoModeCard(input: WhmExtendCardInput): string {
  const v = view(input.locale)
  return v.card('demo-mode', msgid('Demo mode'), `data-demo-mode-workspace data-demo-mode-can-manage="${input.canManage}"`,
    `<p class="xp-help">${v.t('An account in demo mode works like a showcase: its users can sign in and look at everything, but every change through the panels, the API and the command line is refused. Mail, FTP and SSH keep their own access, so give a showcase account no mailboxes, FTP accounts or shell.')}</p>`
    + v.table(msgid('Accounts in demo mode'), [msgid('Account'), msgid('Domain'), msgid('Status')], 'data-demo-mode-rows', msgid('Not read'))
    + `<div class="xp-whm-detail-fields">${v.field('whm-demo-mode-account', msgid('Account'), v.select('whm-demo-mode-account', 'data-demo-mode-account', msgid('Select an account')))}</div>`
    + `<div class="xp-whm-detail-actions">${v.button(msgid('Turn on demo mode'), 'data-demo-mode-enable', true)}${v.button(msgid('Turn off demo mode'), 'data-demo-mode-disable')}${v.button(msgid('Refresh'), 'data-demo-mode-refresh')}</div>`
    + v.status('data-demo-mode-status', input.canManage, msgid('Nothing has been read yet.')) + `<p class="xp-whm-detail-status" data-demo-mode-result role="status" hidden></p>`)
}

export function renderWhmHooksCard(input: WhmExtendCardInput): string {
  const v = view(input.locale)
  return v.card('hooks', msgid('Hooks'), `data-hooks-workspace data-hooks-can-manage="${input.canManage}"`,
    `<p class="xp-help">${v.t('A hook runs a reviewed program when an account is created, suspended, unsuspended or terminated. It runs as the unprivileged nobody user without a shell, receives the event and the account enhancements as JSON on its input and is stopped at its timeout. A blocking hook that fails before an action stops that action. Each run is written to the audit log.')}</p>`
    + `<dl class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><dt>${v.t('Reviewed hook directory')}</dt><dd><bdi dir="ltr" data-hooks-directory>${v.t('Not read')}</bdi></dd></div></dl>`
    + v.table(msgid('Registered hooks, in run order'), [msgid('Event'), msgid('Hook stage'), msgid('Executable'), msgid('Attributes'), msgid('Review')], 'data-hooks-rows', msgid('Not read'))
    + `<div class="xp-whm-detail-fields">${v.field('whm-hooks-select', msgid('Hook'), v.select('whm-hooks-select', 'data-hooks-select', msgid('Select a hook')))}</div>`
    + `<div class="xp-whm-detail-actions">${v.button(msgid('Enable'), 'data-hooks-action="enable"')}${v.button(msgid('Disable'), 'data-hooks-action="disable"')}${v.button(msgid('Move up'), 'data-hooks-action="up"')}${v.button(msgid('Move down'), 'data-hooks-action="down"')}${v.button(msgid('Delete hook'), 'data-hooks-action="delete"')}${v.button(msgid('Refresh'), 'data-hooks-action="refresh"')}</div>`
    + `<p class="xp-help">${v.t('Register a hook with xwhmapi hooks register: the agent pins the file digest, and a changed file does not run until it is registered again.')}</p>`
    + v.status('data-hooks-status', input.canManage, msgid('Nothing has been read yet.')) + `<p class="xp-whm-detail-status" data-hooks-result role="status" hidden></p>`)
}

export function renderWhmRegisteredAppsCard(input: { locale: Locale; canRead: boolean }): string {
  const v = view(input.locale)
  return v.card('registered-apps', msgid('Registered applications'), `data-registered-apps-workspace data-registered-apps-can-read="${input.canRead}"`,
    `<p class="xp-help">${v.t('Applications registered with this panel by their registration file. Removing a file removes its registration. Nothing here is fetched or run.')}</p>`
    + v.table(msgid('Registered applications'), [msgid('Application'), msgid('Interface'), msgid('Required privileges'), msgid('Entry address'), msgid('Origin'), msgid('State')], 'data-registered-apps-rows', msgid('Not read'))
    + `<div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-registered-apps-refresh${input.canRead ? '' : ' disabled'}>${v.t('Refresh')}</button></div>`
    + v.status('data-registered-apps-status', input.canRead, msgid('Nothing has been read yet.')))
}

export function renderWhmPluginPackagesCard(input: WhmExtendCardInput): string {
  const v = view(input.locale)
  const text = (key: string, label: string, attributes: string, help = ''): string => v.field('whm-plugin-generator-' + key, label, `<input id="whm-plugin-generator-${key}" type="text" ${attributes} autocomplete="off" spellcheck="false" data-plugin-generator-input="${key}" disabled>`, help)
  return v.card('plugin-packages', msgid('Plugins'), `data-plugin-packages-workspace data-plugin-packages-can-manage="${input.canManage}"`,
    `<p class="xp-help">${v.t('A plugin adds icons to the home page of account owners. It is a list of links with a group, a priority and a 48 by 48 icon, and it contains no code. An item with a plan feature shows only to accounts whose plan has that feature.')}</p>`
    + v.table(msgid('Installed plugins'), [msgid('Plugin'), msgid('Items'), msgid('Installed (UTC)'), msgid('State')], 'data-plugin-packages-rows', msgid('Not read'))
    + `<div class="xp-whm-detail-fields">${v.field('whm-plugin-packages-select', msgid('Plugin'), v.select('whm-plugin-packages-select', 'data-plugin-packages-select', msgid('Select a plugin')))}${v.field('whm-plugin-packages-file', msgid('Plugin package file'), `<input id="whm-plugin-packages-file" type="file" accept="application/json,.json,.gz,.tgz" data-plugin-packages-file disabled>`, msgid('An xpanel-plugin-package-v1 JSON file of up to 384 KiB, or a cPanel plugin .tar.gz archive of up to 1 MiB. A link into a cPanel plugin is refused, because this panel runs no plugin code.'))}</div>`
    + `<div class="xp-whm-detail-actions"><label><input type="checkbox" data-plugin-packages-overwrite disabled> ${v.t('Replace a plugin with the same name')}</label>${v.button(msgid('Install package'), 'data-plugin-packages-action="install"', true)}${v.button(msgid('Download'), 'data-plugin-packages-action="download"')}${v.button(msgid('Delete plugin'), 'data-plugin-packages-action="delete"')}${v.button(msgid('Refresh'), 'data-plugin-packages-action="refresh"')}</div>`
    + `<h3>${v.t('Plugin generator')}</h3><p class="xp-help">${v.t('Build a package here, then install it on this server or another one.')}</p>`
    + `<div class="xp-whm-detail-fields">${text('name', msgid('Plugin name'), 'dir="ltr" maxlength="64"', msgid('Lowercase letters, digits, hyphens and underscores.'))}${text('id', msgid('Item id'), 'dir="ltr" maxlength="64"')}${text('item', msgid('Item name'), 'maxlength="80"')}${text('group', msgid('Group'), 'maxlength="40"', msgid('An existing group or a new one.'))}${text('priority', msgid('Priority'), 'dir="ltr" inputmode="numeric" maxlength="2"', msgid('1 to 99. Lower numbers come first.'))}${text('uri', msgid('Address'), 'dir="ltr" maxlength="512"', msgid('A panel path such as /files or an https address.'))}${text('feature', msgid('Plan feature'), 'dir="ltr" maxlength="64"', msgid('Optional. An xPanel tool id, or plugin: and a new key for the Feature Manager.'))}${v.field('whm-plugin-generator-icon', msgid('Icon'), `<input id="whm-plugin-generator-icon" type="file" accept="image/png,image/svg+xml" data-plugin-generator-icon disabled>`, msgid('A PNG or plain SVG of exactly 48 by 48 pixels, up to 16 KiB.'))}</div>`
    + `<div class="xp-whm-detail-actions">${v.button(msgid('Add item'), 'data-plugin-packages-action="add"')}${v.button(msgid('Clear items'), 'data-plugin-packages-action="clear"')}${v.button(msgid('Generate package'), 'data-plugin-packages-action="generate"', true)}</div>`
    + v.table(msgid('Package items'), [msgid('Item id'), msgid('Item name'), msgid('Group'), msgid('Priority'), msgid('Address')], 'data-plugin-generator-rows', msgid('No items have been added.'))
    + v.status('data-plugin-packages-status', input.canManage, msgid('Nothing has been read yet.')) + `<p class="xp-whm-detail-status" data-plugin-packages-result role="status" hidden></p>`)
}

export function renderWhmThemePackagesCard(input: WhmExtendCardInput): string {
  const v = view(input.locale)
  return v.card('theme-packages', msgid('Theme manager'), `data-theme-packages-workspace data-theme-packages-can-manage="${input.canManage}"`,
    `<p class="xp-help">${v.t('A theme package sets colors and corner radii over a built-in theme for the light and dark appearance. It contains no code, styles or files, so layout, spacing and accessibility stay those of its base theme. People choose a theme in their display preferences.')}</p>`
    + v.table(msgid('Installed themes'), [msgid('Theme'), msgid('Base theme'), msgid('Version'), msgid('Installed (UTC)'), msgid('Status')], 'data-theme-packages-rows', msgid('Not read'))
    + `<div class="xp-whm-detail-fields">${v.field('whm-theme-packages-file', msgid('Theme package file'), `<input id="whm-theme-packages-file" type="file" accept="application/json,.json" data-theme-packages-file disabled>`, msgid('An xpanel-theme-package-v1 JSON file of up to 64 KiB.'))}</div>`
    + `<div class="xp-whm-detail-actions">${v.button(msgid('Install package'), 'data-theme-packages-action="upload"', true)}</div>`
    + `<div class="xp-whm-detail-fields">${v.field('whm-theme-packages-select', msgid('Theme'), v.select('whm-theme-packages-select', 'data-theme-packages-select', msgid('Select a theme')))}${v.field('whm-theme-packages-clone-id', msgid('New theme id'), `<input id="whm-theme-packages-clone-id" type="text" dir="ltr" maxlength="32" autocomplete="off" spellcheck="false" data-theme-packages-clone-id disabled>`)}${v.field('whm-theme-packages-clone-name', msgid('New theme name'), `<input id="whm-theme-packages-clone-name" type="text" maxlength="40" autocomplete="off" data-theme-packages-clone-name disabled>`)}</div>`
    + `<div class="xp-whm-detail-actions">${v.button(msgid('Preview'), 'data-theme-packages-action="preview"')}${v.button(msgid('Clone'), 'data-theme-packages-action="clone"')}${v.button(msgid('Download'), 'data-theme-packages-action="download"')}${v.button(msgid('Delete theme'), 'data-theme-packages-action="delete"')}${v.button(msgid('Refresh'), 'data-theme-packages-action="refresh"')}</div>`
    + v.status('data-theme-packages-status', input.canManage, msgid('Nothing has been read yet.')) + `<p class="xp-whm-detail-status" data-theme-packages-result role="status" hidden></p>`)
}

/** Rendered inside the classic store extension frame: stored releases and every installed copy, read by the site instances client. */
export function renderWhmSiteInstancesCard(input: WhmExtendCardInput): string {
  const v = view(input.locale)
  const field = (id: string, label: string, control: string, help = ''): string => `<div class="xp-field"><label for="${id}">${v.t(label)}</label>${control}${help ? `<p class="xp-help">${v.t(help)}</p>` : ''}</div>`
  const button = (label: string, action: string, primary = false): string => `<button type="button" class="xp-btn${primary ? ' xp-btn--primary' : ''}" disabled data-site-instances-action="${action}">${v.t(label)}</button>`
  const table = (label: string, headers: string[], hook: string): string => `<div class="xp-acct-tool__table" role="region" tabindex="0" aria-label="${v.t(label)}"><table class="xp-table"><caption class="xp-sr-only">${v.t(label)}</caption><thead><tr>${headers.map(header => `<th scope="col">${v.t(header)}</th>`).join('')}</tr></thead><tbody ${hook}><tr><td colspan="${headers.length}">${v.t('Not read')}</td></tr></tbody></table></div>`
  return `${ACCOUNT_TOOL_STYLE}<section class="xp-extension__card" aria-labelledby="whm-site-instances-heading" data-site-instances data-site-instances-can-manage="${input.canManage}"><h2 id="whm-site-instances-heading">${v.t('Installed applications')}</h2>`
    + `<p>${v.t('Every copy accounts installed from the signed catalog. Each change runs as a host job as the account, and a failed job restores its recovery copy.')}</p>`
    + table(msgid('Installed applications'), [msgid('Account'), msgid('Site'), msgid('Application'), msgid('Version'), msgid('Database'), msgid('Updated (UTC)')], 'data-site-instances-rows')
    + `<div class="xp-form-group">${field('whm-site-instances-select', msgid('Installation'), `<select id="whm-site-instances-select" class="xp-select" data-site-instances-select disabled><option value="">${v.t('Select an installation')}</option></select>`)}</div>`
    + `<div class="xp-extension__actions">${button(msgid('Update to latest'), 'update')}${button(msgid('Uninstall'), 'remove')}${button(msgid('Refresh'), 'refresh')}</div>`
    + `<h3>${v.t('Stored releases')}</h3><p>${v.t('An application can be installed only after its release file is stored here. The file must match the digest in the signed catalog.')}</p>`
    + table(msgid('Stored releases'), [msgid('Application'), msgid('Version'), msgid('State')], 'data-site-instances-releases')
    + `<div class="xp-form-group">${field('whm-site-instances-release', msgid('Release'), `<select id="whm-site-instances-release" class="xp-select" data-site-instances-release-select disabled><option value="">${v.t('Select a release')}</option></select>`)}${field('whm-site-instances-file', msgid('Release file'), `<input id="whm-site-instances-file" class="xp-input" type="file" data-site-instances-file disabled>`)}</div>`
    + `<div class="xp-extension__actions">${button(msgid('Upload release'), 'upload')}</div>`
    + `<p data-site-instances-status data-state="${input.canManage ? 'unread' : 'unavailable'}" role="status">${input.canManage ? v.t('Nothing has been read yet.') : v.t('This page requires an authorized administrator. Nothing was read or changed.')}</p></section>`
}

/** Rendered inside the classic store extension frame, so it uses that frame's card, field and fact classes. */
export function renderWhmSiteSoftwareCard(input: WhmExtendCardInput): string {
  const v = view(input.locale)
  const fact = (key: string, label: string): string => `<div class="xp-extension__fact"><dt>${v.t(label)}</dt><dd><bdi dir="ltr" data-site-software-fact="${key}">${v.t('Not read')}</bdi></dd></div>`
  const field = (id: string, label: string, control: string, help = ''): string => `<div class="xp-field"><label for="${id}">${v.t(label)}</label>${control}${help ? `<p class="xp-help">${v.t(help)}</p>` : ''}</div>`
  const button = (label: string, action: string, primary = false): string => `<button type="button" class="xp-btn${primary ? ' xp-btn--primary' : ''}" disabled data-site-software-action="${action}">${v.t(label)}</button>`
  const headers = [msgid('Application'), msgid('Versions'), msgid('Offered')]
  return `${ACCOUNT_TOOL_STYLE}<section class="xp-extension__card" aria-labelledby="whm-site-software-heading" data-site-software-workspace data-site-software-can-manage="${input.canManage}"><h2 id="whm-site-software-heading">${v.t('Signed application catalog')}</h2>`
    + `<p>${v.t('Only a catalog signed by the release signing key is accepted, and it is checked again before every install. Choose which of its applications accounts can install. Private signing keys are never on this page.')}</p>`
    + `<dl class="xp-extension__facts">${fact('trust', msgid('Trusted signing keys'))}${fact('keys', msgid('Key ids'))}${fact('sequence', msgid('Catalog sequence and signer'))}${fact('issued', msgid('Issued (UTC)'))}${fact('expires', msgid('Expires (UTC)'))}</dl>`
    + `<div class="xp-form-group">${field('whm-site-software-file', msgid('Signed catalog file'), `<input id="whm-site-software-file" class="xp-input" type="file" accept="application/json,.json" data-site-software-file disabled>`, msgid('The signed catalog the release publisher issued, up to 1 MiB.'))}</div>`
    + `<div class="xp-extension__actions">${button(msgid('Import signed catalog'), 'import', true)}</div>`
    + `<div class="xp-acct-tool__table" role="region" tabindex="0" aria-label="${v.t('Catalog applications')}"><table class="xp-table"><caption class="xp-sr-only">${v.t('Catalog applications')}</caption><thead><tr>${headers.map(header => `<th scope="col">${v.t(header)}</th>`).join('')}</tr></thead><tbody data-site-software-rows><tr><td colspan="3">${v.t('Not read')}</td></tr></tbody></table></div>`
    + `<div class="xp-form-group">${field('whm-site-software-select', msgid('Application'), `<select id="whm-site-software-select" class="xp-select" data-site-software-select disabled><option value="">${v.t('Select an application')}</option></select>`)}</div>`
    + `<div class="xp-extension__actions">${button(msgid('Offer to accounts'), 'offer')}${button(msgid('Stop offering'), 'withdraw')}${button(msgid('Refresh'), 'refresh')}</div>`
    + `<p data-site-software-status data-state="${input.canManage ? 'unread' : 'unavailable'}" role="status">${input.canManage ? v.t('Nothing has been read yet.') : v.t('This page requires an authorized administrator. Nothing was read or changed.')}</p><p data-site-software-result role="status" hidden></p></section>`
}
