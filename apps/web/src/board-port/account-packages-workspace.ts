import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

const PACKAGE_STYLE = `<style>
[data-account-packages] .xp-acct-tool__card{border-radius:var(--xp-radius-md)}
[data-account-packages] .xp-acct-tool__card h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:600}
[data-account-packages] .xp-acct-tool__facts dt{font-size:var(--xp-type-label);line-height:var(--xp-leading-label);font-weight:500;color:var(--xp-text-secondary)}
[data-account-packages] .xp-acct-tool__table{min-inline-size:0}
[data-account-packages] .xp-acct-tool__table table{min-inline-size:40rem}
[data-account-packages] .xp-acct-tool__table:focus-visible{outline:var(--xp-focus-width) solid var(--xp-border-focus);outline-offset:var(--xp-focus-offset)}
@media(min-width:601px){[data-account-packages] .xp-acct-tool__card{padding:var(--xp-space-group)}}
</style>`

/** Approved Software table, account scope and unavailable module sections remain explicit. */
export function renderAccountPackagesWorkspace(input: { lang: Locale; accountId: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values), off = input.canManage ? '' : ' disabled'
  const table = (kind: 'installed' | 'available', columns: string[]): string => `<div class="xp-acct-tool__table" role="region" tabindex="0" aria-label="${kind === 'installed' ? t('Installed private packages') : t('Reviewed package catalog')}"><table class="xp-table"><thead><tr>${columns.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-packages-${kind}><tr><td colspan="${columns.length}">${t('Not read.')}</td></tr></tbody></table></div>`
  return `<div class="xp-acct-tool" data-account-packages data-account="${escapeHtml(input.accountId)}" data-packages-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}${PACKAGE_STYLE}
    <section class="xp-acct-tool__card" aria-labelledby="packages-scope"><h2 id="packages-scope">${t('Private PHP PEAR library')}</h2><p>${t('Manage reviewed pure-PHP packages in this account library. Package source files are copied as data; install scripts and extensions are excluded.')}</p>
      <dl class="xp-acct-tool__facts"><div><dt>${t('Library relative to home')}</dt><dd><bdi dir="ltr">.xpanel-packages/pear/library</bdi></dd></div><div><dt>${t('Inventory')}</dt><dd data-packages-inventory>${t(msgctxt('account-packages-workspace', 'Not read'))}</dd></div><div><dt>${t('Catalog channel')}</dt><dd><bdi dir="ltr">pear.php.net</bdi></dd></div></dl>
      <p class="xp-help">${t('Add this library to your application’s PHP include_path. Only files managed by this page appear here. Other account and system libraries are not inventoried.')}</p>
      <p data-packages-status role="status">${t('Packages have not been read.')}</p><div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-packages-refresh${off}>${t('Read packages')}</button><button type="button" class="xp-btn" data-packages-recover disabled>${t('Recover pending operation')}</button></div></section>
    <section class="xp-acct-tool__card" aria-labelledby="packages-installed"><h2 id="packages-installed">${t('Installed private packages')}</h2>${table('installed', [t('Package'), t('Version'), t('Required packages'), t('Actions')])}<p class="xp-help">${t('Removal is refused while another installed package depends on it. A recovery snapshot is saved before every library change.')}</p></section>
    <section class="xp-acct-tool__card" aria-labelledby="packages-available"><h2 id="packages-available">${t('Reviewed package catalog')}</h2><div class="xp-field"><label class="xp-label" for="packages-search">${t('Filter the reviewed catalog')}</label><input id="packages-search" class="xp-input" type="search" maxlength="100" data-packages-search${off}></div>${table('available', [t('Package'), t('Version'), t('Description'), t('Required packages'), t('Actions')])}<p class="xp-help" data-packages-capability>${t('Installation requires a pinned reviewed catalog and a qualified account-confined provider. Free URLs and package scripts are never accepted.')}</p></section>
    <section class="xp-acct-tool__card" aria-labelledby="packages-other"><h2 id="packages-other">${t('Other modules and libraries')}</h2><p>${t('Perl modules, system package inventory, package updates and reinstall are unavailable in this workspace.')}</p><div class="xp-acct-tool__actions"><button type="button" class="xp-btn" disabled>${t('Perl modules')}</button><button type="button" class="xp-btn" disabled>${t('System packages')}</button><button type="button" class="xp-btn" disabled>${t('Update or reinstall')}</button></div></section>
    <template data-xp-template="packages-installed-row"><tr><td><bdi dir="ltr" data-xp-slot="name"></bdi></td><td><bdi dir="ltr" data-xp-slot="version"></bdi></td><td><bdi dir="ltr" data-xp-slot="requires"></bdi></td><td><button type="button" class="xp-btn xp-btn--danger" data-xp-slot="action" disabled></button></td></tr></template>
    <template data-xp-template="packages-available-row"><tr><td><bdi dir="ltr" data-xp-slot="name"></bdi></td><td><bdi dir="ltr" data-xp-slot="version"></bdi></td><td data-xp-slot="summary"></td><td><bdi dir="ltr" data-xp-slot="requires"></bdi></td><td><button type="button" class="xp-btn" data-xp-slot="action" disabled></button></td></tr></template>
    <template data-xp-template="packages-installed-empty"><tr><td colspan="4" data-xp-slot="message"></td></tr></template><template data-xp-template="packages-available-empty"><tr><td colspan="5" data-xp-slot="message"></td></tr></template>
  </div>`
}
