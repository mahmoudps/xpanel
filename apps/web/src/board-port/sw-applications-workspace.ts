import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

/** /software/apps: signed-catalog applications per owned domain through the verified installer, plus runtime apps. */
export function renderSwApplicationsWorkspace(input: { lang: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values)
  const fact = (key: string, label: string): string => `<div><dt>${label}</dt><dd><bdi dir="ltr" data-human data-sw-apps-${key}>${t('Not read')}</bdi></dd></div>`
  const select = (key: string, label: string, empty: string): string => `<div class="xp-field"><label class="xp-label" for="sw-apps-${key}">${label}</label><select id="sw-apps-${key}" class="xp-select" data-sw-apps-${key}-select disabled><option value="">${empty}</option></select></div>`
  const action = (key: string, label: string, primary = false): string => `<button type="button" class="xp-btn${primary ? ' xp-btn--primary' : ''}" data-sw-apps-action="${key}" disabled>${label}</button>`
  return `<div class="xp-acct-tool" data-sw-apps data-sw-can-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}<style>[data-sw-apps] bdi:not([data-human]){font-family:var(--xp-font-mono);font-size:var(--xp-type-label);line-height:var(--xp-leading-label)}@media(min-width:601px){[data-sw-apps] .xp-acct-tool__card{padding:var(--xp-space-card)}}</style>
  <section class="xp-acct-tool__card" aria-labelledby="sw-apps-catalog"><h2 id="sw-apps-catalog">${t('Application catalog')}</h2>
    <p>${t('Applications come only from the signed catalog your provider configured. Each change runs as a host job that saves a recovery copy first and is shown as done only after the account files are verified.')}</p>
    <dl class="xp-acct-tool__facts">${fact('catalog', t('Catalog'))}${fact('sequence', t('Catalog sequence'))}${fact('expires', t('Valid until (UTC)'))}</dl>
    <p data-sw-apps-status role="status" data-state="unread">${t('Applications have not been read.')}</p>
    <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-sw-apps-refresh${input.canManage ? '' : ' disabled'}>${t('Read applications')}</button></div>
  </section>
  <section class="xp-acct-tool__card" aria-labelledby="sw-apps-install"><h2 id="sw-apps-install">${t('Applications on a domain')}</h2>
    <div class="xp-acct-tool__fields">${select('domain', t('Domain'), t('Read applications first'))}${select('app', t('Application'), t('Choose an application'))}${select('version', t('Version'), t('Choose a version'))}</div>
    <dl class="xp-acct-tool__facts">${fact('installed', t('Installed application'))}${fact('version', t('Installed version'))}${fact('previous', t('Previous version'))}${fact('recovery', t('Recovery state'))}</dl>
    <div class="xp-acct-tool__actions">${action('install', t('Install'), true)}${action('update', t('Update'))}${action('rollback', t('Roll back'))}${action('remove', t('Remove'))}</div>
    <p class="xp-help" data-sw-apps-capability>${t('Writes need an admitted descriptor-confined artifact provider for account files. Until one is connected, nothing can be installed and nothing is reported as installed.')}</p>
  </section>
  <section class="xp-acct-tool__card" aria-labelledby="sw-apps-runtime"><h2 id="sw-apps-runtime">${t('Node.js, Python and Ruby applications')}</h2>
    <p>${t('Runtime applications are unavailable: they need a confined per-account application service runner with plan limits and a domain binding, which is not connected. No application is created or started here.')}</p>
    <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" disabled>${t('Create application')}</button></div>
  </section>
</div>`
}
