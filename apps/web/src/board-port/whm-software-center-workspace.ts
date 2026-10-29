import { type Locale, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/**
 * Software center workspaces. One engine serves three pages; rows, states and previews are filled
 * only from observed package data by the client binding. Nothing here claims an installed state.
 */
type Page = 'catalog' | 'module' | 'runtime'
type Copy = string
interface SoftwareCenterInput { locale: Locale; canRead: boolean; canManage: boolean }

const categories: Readonly<Record<Page, readonly (readonly [string, Copy])[]>> = {
  catalog: [['cache', msgid('Caching')], ['media', msgid('Media')], ['security', msgid('Security')], ['developer', msgid('Developer tools')], ['utilities', msgid('Utilities')]],
  module: [['php', msgid('PHP extensions')], ['perl', msgid('Perl modules')]],
  runtime: [['nodejs', 'Node.js'], ['python', 'Python'], ['go', 'Go'], ['java', 'Java']],
}
const intro: Readonly<Record<Page, Copy>> = {
  catalog: msgid('Reviewed free components installed through this server’s package manager. Install and remove run as host jobs and succeed only after the package database confirms the result.'),
  module: msgid('PHP extensions for each installed PHP version and Perl modules, as distribution packages. Rows appear only for PHP versions observed on this host.'),
  runtime: msgid('Application runtimes from your distribution repositories. Versions are the ones the repositories provide; installed versions come from the package database.'),
}
const css = `<style>
.xp-whm-software{display:flex;flex-direction:column;gap:var(--xp-space-section);min-inline-size:0}.xp-whm-software :is(h3,h4,p,ul,dl,dd){margin:0}.xp-whm-software h3{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:600}.xp-whm-software h4{font-size:var(--xp-type-label);line-height:var(--xp-leading-label);font-weight:600}.xp-whm-software ul{padding-inline-start:0;list-style:none;display:flex;flex-direction:column;gap:var(--xp-space-sm)}
.xp-whm-software__panel{display:flex;flex-direction:column;gap:var(--xp-space-group);padding:var(--xp-space-field);border:1px solid var(--xp-border);border-radius:var(--xp-radius-md);background:var(--xp-bg-surface);min-inline-size:0}.xp-whm-software__panel>ul{gap:var(--xp-space-field)}
.xp-whm-software__source{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--xp-space-sm)}.xp-whm-software__filters,.xp-whm-software__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--xp-space-field);min-inline-size:0}.xp-whm-software__filters{align-items:end}.xp-whm-software__facts{align-items:start}
.xp-whm-software__field,.xp-whm-software__facts>div{display:flex;flex-direction:column;gap:var(--xp-space-sm);min-inline-size:0}.xp-whm-software__field label,.xp-whm-software__facts dt{font-size:var(--xp-type-label);line-height:var(--xp-leading-label);font-weight:500;color:var(--xp-text-secondary)}.xp-whm-software__field :is(input,select){min-block-size:var(--xp-hit-target);min-inline-size:0}.xp-whm-software__facts dd{overflow-wrap:anywhere}
.xp-whm-software__groups{display:flex;flex-direction:column;gap:var(--xp-space-section);min-inline-size:0}.xp-whm-software__group{display:flex;flex-direction:column;gap:var(--xp-space-group);min-inline-size:0}
.xp-whm-software__item{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-software__item p{color:var(--xp-text-secondary,#344054);overflow-wrap:anywhere}
.xp-whm-software__changes{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:24px}.xp-whm-software__changes>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}
.xp-whm-software__extra{display:flex;flex-direction:column;gap:16px;padding:16px;border:1px solid var(--xp-status-warn-border,#fedf89);border-inline-start-width:4px;border-radius:8px;background:var(--xp-status-warn-bg,#fffaeb);color:var(--xp-status-warn-fg,#93370d)}
.xp-whm-software__accept{display:flex;gap:8px;align-items:center}
.xp-whm-software .xp-whm-detail-scroll{min-inline-size:0}.xp-whm-software .xp-whm-detail-table{min-inline-size:48rem}.xp-whm-software :focus-visible{outline:var(--xp-focus-width) solid var(--xp-border-focus);outline-offset:var(--xp-focus-offset)}
.xp-whm-software [data-sc-status][data-state=failed]{color:var(--xp-status-critical-fg);background:var(--xp-status-critical-bg);border-color:var(--xp-status-critical-border)}.xp-whm-software [data-sc-status][data-state=uncertain]{color:var(--xp-status-warn-fg);background:var(--xp-status-warn-bg);border-color:var(--xp-status-warn-border)}
@media(min-width:601px){.xp-whm-software__panel{padding:var(--xp-space-group)}}
</style>`

function renderPage(page: Page, input: SoftwareCenterInput): string {
  const t = (copy: Copy): string => escapeHtml(translator(input.locale)(copy))
  const id = 'whm-sc-' + page
  const options = categories[page].map(([value, label]) => `<option value="${value}">${t(label)}</option>`).join('')
  const columns: Copy[] = [msgid('Component'), msgid('State'), msgid('Installed version'), msgid('Repository version'), msgid('Estimate'), msgid('Relations'), msgid('Action')]
  return `<div class="xp-whm-software" data-whm-software-center data-sc-page="${page}" data-sc-can-read="${input.canRead}" data-sc-can-manage="${input.canRead && input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}">${css}
    <p class="xp-help">${t(intro[page])}</p>
    <section class="xp-whm-software__panel" aria-labelledby="${id}-sources"><h3 id="${id}-sources">${t(msgctxt('whm-software-center-workspace', 'Catalog sources'))}</h3>
      <ul><li class="xp-whm-software__source" data-sc-source="shipped"><span class="xp-badge xp-badge--ok">${t(msgid('Trusted'))}</span><span>${t(msgid('Shipped reviewed catalog: part of this xPanel release. Packages come only from the distribution repositories already configured on this server.'))}</span></li>
      <li class="xp-whm-software__source" data-sc-source="external"><span class="xp-badge xp-badge--suspended">${t(msgid('Unavailable'))}</span><span>${t(msgid('External catalogs: signed third-party catalogs are not supported in this release. Nothing is downloaded from other URLs.'))}</span></li></ul>
      <p class="xp-help">${t(msgid('Panel stack packages (web servers, PHP-FPM, MariaDB, PostgreSQL, mail, DNS, Redis, nftables and SSH) are managed by server setup and are never removed here.'))}</p>
    </section>
    <div class="xp-whm-software__filters">
      <div class="xp-whm-software__field"><label class="xp-label" for="${id}-category">${t(msgid('Category'))}</label><select class="xp-select" id="${id}-category" data-sc-category disabled><option value="">${t(msgid('All categories'))}</option>${options}</select></div>
      <div class="xp-whm-software__field"><label class="xp-label" for="${id}-search">${t(msgid('Search components'))}</label><input class="xp-input" id="${id}-search" type="search" data-sc-search autocomplete="off" disabled></div>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-sc-refresh${input.canRead ? '' : ' disabled'}>${t(msgid('Read installed packages'))}</button></div>
    </div>
    <p class="xp-whm-detail-status" data-sc-status data-state="unread" role="status">${t(msgid('Installed packages have not been read. No component is shown as installed or available.'))}</p>
    <dl class="xp-whm-software__facts"><div><dt>${t(msgid('Package database'))}</dt><dd data-sc-family>${t(msgid('Not read'))}</dd></div><div><dt>${t(msgid('Observed at (UTC)'))}</dt><dd><bdi dir="ltr" data-sc-observed-at>${t(msgid('Not read'))}</bdi></dd></div>${page === 'module' ? `<div><dt>${t(msgid('Installed PHP versions'))}</dt><dd data-sc-php-versions>${t(msgid('Not read'))}</dd></div>` : ''}</dl>
    <div class="xp-whm-software__groups" data-sc-groups data-sc-columns="${escapeHtml(JSON.stringify(columns.map(copy => translator(input.locale)(copy))))}">
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(msgid('Components'))}"><table class="xp-whm-detail-table xp-table"><thead><tr>${columns.map(copy => `<th scope="col">${t(copy)}</th>`).join('')}</tr></thead><tbody><tr><td colspan="${columns.length}">${t(msgid('No components have been read.'))}</td></tr></tbody></table></div>
    </div>
    <section class="xp-whm-software__panel" data-sc-preview aria-labelledby="${id}-preview" hidden><h3 id="${id}-preview">${t(msgid('Change preview'))}</h3>
      <p data-sc-preview-summary role="status"></p>
      <dl class="xp-whm-software__facts"><div><dt>${t(msgid('Estimated memory'))}</dt><dd><bdi dir="ltr" data-sc-preview-memory></bdi></dd></div><div><dt>${t(msgid('Estimated disk'))}</dt><dd><bdi dir="ltr" data-sc-preview-disk></bdi></dd></div><div><dt>${t(msgid('Download (simulated)'))}</dt><dd data-sc-preview-download></dd></div><div><dt>${t(msgid('Disk change (simulated)'))}</dt><dd data-sc-preview-size></dd></div></dl>
      <div class="xp-whm-software__changes"><div><h4>${t(msgid('Packages to install'))}</h4><ul data-sc-preview-install></ul></div><div><h4>${t(msgid('Packages to upgrade'))}</h4><ul data-sc-preview-upgrade></ul></div><div><h4>${t(msgid('Packages to remove'))}</h4><ul data-sc-preview-remove></ul></div></div>
      <div class="xp-whm-software__extra" data-sc-preview-extra role="alert" hidden><h4>${t(msgid('Extra removals'))}</h4><p>${t(msgid('These packages are not part of the selected components and will also be removed.'))}</p><ul data-sc-preview-extra-list></ul><label class="xp-whm-software__accept"><input type="checkbox" data-sc-accept-extra disabled><span>${t(msgid('I reviewed these extra removals'))}</span></label></div>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-sc-confirm disabled>${t(msgid('Submit host job'))}</button><button type="button" class="xp-btn" data-sc-cancel>${t(msgid('Discard preview'))}</button></div>
    </section>
    <p class="xp-help" data-sc-job hidden><a data-sc-job-link href="/whm/jobs">${t(msgid('Open the submitted job'))}</a></p>
  </div>`
}

export const renderWhmSoftwareCatalog = (input: SoftwareCenterInput): string => renderPage('catalog', input)
export const renderWhmModuleInstallers = (input: SoftwareCenterInput): string => renderPage('module', input)
export const renderWhmRuntimes = (input: SoftwareCenterInput): string => renderPage('runtime', input)
