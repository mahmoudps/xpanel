import { classicSoftwareClientTemplates } from './software-client-templates.ts'
import { type Locale, type MessageValues, SOURCE_LOCALE, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** /whm/software/addon-services: memory cache, message broker and search services with verified service jobs. */
export function renderSwAddonServicesWorkspace(input: { locale: Locale; canRead: boolean; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const lang = input.locale === SOURCE_LOCALE ? '' : '?lang=' + encodeURIComponent(input.locale)
  const headers = [t('Service'), t('Type'), t('Package'), t('Unit'), t('State'), t('Start at boot'), t('Actions')]
  return `<div class="xp-sw-addons" data-sw-addons data-sw-can-read="${input.canRead}" data-sw-can-manage="${input.canRead && input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <style>.xp-sw-addons{display:flex;flex-direction:column;gap:var(--xp-space-section,32px);min-inline-size:0}.xp-sw-addons :is(h2,p){margin:0}.xp-sw-addons .xp-whm-detail-table{min-inline-size:52rem}.xp-sw-addons .xp-whm-detail-table th{white-space:nowrap}.xp-sw-addons bdi:not([data-human]){font-family:var(--xp-font-mono);font-size:var(--xp-type-label);line-height:var(--xp-leading-label)}.xp-sw-addons [data-state=failed]{color:var(--xp-status-critical-fg);background:var(--xp-status-critical-bg);border-color:var(--xp-status-critical-border)}.xp-sw-addons [data-state=uncertain]{color:var(--xp-status-warn-fg);background:var(--xp-status-warn-bg);border-color:var(--xp-status-warn-border)}.xp-sw-addons :focus-visible{outline:var(--xp-focus-width) solid var(--xp-border-focus);outline-offset:var(--xp-focus-offset)}</style>
  <section class="xp-whm-detail-card" aria-labelledby="sw-addons-list"><h2 id="sw-addons-list">${t('Add-on services')}</h2>
    <p class="xp-help">${t('Unit states come from systemd. Packages install and remove through the software center, which previews every change with the package manager.')}</p>
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-sw-addons-refresh${input.canRead ? '' : ' disabled'}>${t('Read services')}</button><a class="xp-btn xp-btn--primary" href="/whm/software/catalog${lang}">${t('Install service')}</a></div>
    <p class="xp-whm-detail-status" role="status" data-sw-addons-status data-state="unread">${t('Add-on services have not been read.')}</p>
    <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Add-on services')}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t('Add-on services')}</caption><thead><tr>${headers.map(item => `<th scope="col">${item}</th>`).join('')}</tr></thead><tbody data-sw-addons-rows><tr><td colspan="${headers.length}">${t('No services have been read.')}</td></tr></tbody></table></div>
    <p class="xp-help">${t('Elasticsearch and OpenSearch have no reviewed distribution package. If an administrator installed one, its unit is still shown and can be controlled here.')}</p>
    <p class="xp-help" data-sw-addons-job hidden>${t('A host job was submitted. Its result is verified on the jobs page.')} <a data-sw-addons-job-link href="/whm/jobs${lang}">${t('Open host jobs')}</a></p>
  </section>
  <section class="xp-whm-detail-card" aria-labelledby="sw-addons-config"><h2 id="sw-addons-config">${t('Service configuration')}</h2>
    <p class="xp-whm-detail-status" role="status">${t('Memory limits, listeners and users are not edited here: a reviewed configuration writer with a restart check is not connected. Nothing is changed.')}</p>
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" disabled>${t('Edit configuration')}</button></div>
  </section>
${classicSoftwareClientTemplates('addons')}
</div>`
}
