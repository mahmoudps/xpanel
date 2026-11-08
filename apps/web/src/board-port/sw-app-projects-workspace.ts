import { classicSoftwareClientTemplates } from './software-client-templates.ts'
import { type Locale, type MessageValues, SOURCE_LOCALE, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { renderToolCard } from './tool-card-view.ts'
import { projectsCard } from '../models/tool-cards.ts'

/**
 * /whm/software/application-projects: Go and Java runtimes observed from the package database, and the
 * projects themselves: one service each, in the account slice, driven by the shared panel-tools client.
 */
export function renderSwAppProjectsWorkspace(input: { locale: Locale; canRead: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const lang = input.locale === SOURCE_LOCALE ? '' : '?lang=' + encodeURIComponent(input.locale)
  const table = (label: string, headers: string[], key: string, empty: string): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${label}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${label}</caption><thead><tr>${headers.map(item => `<th scope="col">${item}</th>`).join('')}</tr></thead><tbody data-sw-projects-${key}><tr><td colspan="${headers.length}">${empty}</td></tr></tbody></table></div>`
  return `<div class="xp-sw-projects" data-sw-projects data-sw-can-read="${input.canRead}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <style>.xp-sw-projects{display:flex;flex-direction:column;gap:var(--xp-space-section,32px);min-inline-size:0}.xp-sw-projects :is(h2,p){margin:0}.xp-sw-projects .xp-whm-detail-table{min-inline-size:36rem}.xp-sw-projects .xp-whm-detail-table th{white-space:nowrap}.xp-sw-projects bdi{font-family:var(--xp-font-mono);font-size:var(--xp-type-label);line-height:var(--xp-leading-label)}.xp-sw-projects [data-state=failed]{color:var(--xp-status-critical-fg);background:var(--xp-status-critical-bg);border-color:var(--xp-status-critical-border)}.xp-sw-projects :focus-visible{outline:var(--xp-focus-width) solid var(--xp-border-focus);outline-offset:var(--xp-focus-offset)}</style>
  <section class="xp-whm-detail-card" aria-labelledby="sw-projects-runtimes"><h2 id="sw-projects-runtimes">${t('Go and Java runtimes')}</h2>
    <p class="xp-help">${t('Installed state comes from the package database through the software center. Runtimes install and update there as verified host jobs.')}</p>
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-sw-projects-refresh${input.canRead ? '' : ' disabled'}>${t('Read runtimes')}</button><a class="xp-btn" href="/whm/software/runtimes${lang}">${t('Manage runtimes')}</a></div>
    <p class="xp-whm-detail-status" role="status" data-sw-projects-status data-state="unread">${t('Runtimes have not been read.')}</p>
    ${table(t('Go and Java runtimes'), [t('Runtime'), t('State'), t('Installed version')], 'runtimes', t('No runtimes have been read.'))}
  </section>
  ${renderToolCard({ locale: input.locale, canManage: input.canRead }, projectsCard)}
${classicSoftwareClientTemplates('projects')}
</div>`
}
