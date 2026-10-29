import { type Locale, type MessageValues, SOURCE_LOCALE, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** /whm/software/deployments: account Git repositories deployed by fast-forward pulls through the isolated account runner. */
export function renderSwDeploymentsWorkspace(input: { locale: Locale; canRead: boolean; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const lang = input.locale === SOURCE_LOCALE ? '' : '?lang=' + encodeURIComponent(input.locale)
  const fact = (key: string, label: string): string => `<div class="xp-whm-detail-field"><dt>${label}</dt><dd><bdi dir="ltr" data-human data-sw-dep-${key}>${t('Not read')}</bdi></dd></div>`
  const table = (label: string, headers: string[], key: string, empty: string): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${label}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${label}</caption><thead><tr>${headers.map(item => `<th scope="col">${item}</th>`).join('')}</tr></thead><tbody data-sw-dep-${key}><tr><td colspan="${headers.length}">${empty}</td></tr></tbody></table></div>`
  return `<div class="xp-sw-deployments" data-sw-deployments data-sw-can-read="${input.canRead}" data-sw-can-manage="${input.canRead && input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <style>.xp-sw-deployments{display:flex;flex-direction:column;gap:var(--xp-space-section,32px);min-inline-size:0}.xp-sw-deployments :is(h2,p,dl,dd){margin:0}.xp-sw-deployments .xp-whm-detail-table{min-inline-size:36rem}.xp-sw-deployments .xp-whm-detail-table th{white-space:nowrap}.xp-sw-deployments bdi:not([data-human]){font-family:var(--xp-font-mono);font-size:var(--xp-type-label);line-height:var(--xp-leading-label)}.xp-sw-deployments [data-state=failed]{color:var(--xp-status-critical-fg);background:var(--xp-status-critical-bg);border-color:var(--xp-status-critical-border)}.xp-sw-deployments [data-state=uncertain]{color:var(--xp-status-warn-fg);background:var(--xp-status-warn-bg);border-color:var(--xp-status-warn-border)}.xp-sw-deployments :focus-visible{outline:var(--xp-focus-width) solid var(--xp-border-focus);outline-offset:var(--xp-focus-offset)}</style>
  <section class="xp-whm-detail-card" aria-labelledby="sw-dep-accounts"><h2 id="sw-dep-accounts">${t('Account repositories')}</h2>
    <p class="xp-help">${t('Repositories are the ones each account registered on its Git page. A deployment fast-forwards one repository from its HTTPS origin through the account’s isolated Git runner, never as root inside the home.')}</p>
    <div class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><label for="sw-dep-account">${t('Account')}</label><select id="sw-dep-account" class="xp-select" data-sw-dep-account disabled><option value="">${t('Read accounts first')}</option></select></div></div>
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-sw-dep-refresh${input.canRead ? '' : ' disabled'}>${t('Read deployments')}</button></div>
    <p class="xp-whm-detail-status" role="status" data-sw-dep-status data-state="unread">${t('Deployments have not been read.')}</p>
    <dl class="xp-whm-detail-fields">${fact('native', t('Isolated Git runner'))}${fact('files', t('Account file runner'))}</dl>
    ${table(t('Registered repositories'), [t('Repository'), t('Actions')], 'repositories', t('No account has been selected.'))}
  </section>
  <section class="xp-whm-detail-card" aria-labelledby="sw-dep-selected"><h2 id="sw-dep-selected">${t('Selected repository')}</h2>
    <dl class="xp-whm-detail-fields">${fact('path', t('Repository'))}${fact('branch', t('Branch'))}${fact('head', t('Deployed commit'))}${fact('remote', t('Origin'))}${fact('tree', t('Working tree'))}</dl>
    ${table(t('Recent commits'), [t('Commit'), t('Date (UTC)'), t('Subject')], 'commits', t('No repository has been inspected.'))}
    <p class="xp-help">${t('Deploying refuses uncommitted changes, a moved commit or a changed repository list, and reports success only after Git confirms the new commit.')}</p>
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-sw-dep-pull disabled>${t('Deploy latest from origin')}</button><a class="xp-btn" href="/whm/audit${lang}">${t('Audit log')}</a></div>
  </section>
</div>`
}
