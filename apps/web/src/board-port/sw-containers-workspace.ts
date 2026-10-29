import { type Locale, type MessageValues, SOURCE_LOCALE, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

type Input = { locale: Locale; canRead: boolean; canManage: boolean }
const css = `<style>.xp-sw-containers{display:flex;flex-direction:column;gap:var(--xp-space-section,32px);min-inline-size:0}.xp-sw-containers :is(h2,h3,p,dl,dd,ul){margin:0}.xp-sw-containers__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--xp-space-field,16px)}.xp-sw-containers__facts>div{display:flex;flex-direction:column;gap:var(--xp-space-label,8px);min-inline-size:0}.xp-sw-containers__facts dt{font-size:var(--xp-type-label);line-height:var(--xp-leading-label);color:var(--xp-text-muted)}.xp-sw-containers__facts dd{overflow-wrap:anywhere}.xp-sw-containers .xp-whm-detail-table{min-inline-size:44rem}.xp-sw-containers .xp-whm-detail-table th{white-space:nowrap}.xp-sw-containers bdi:not([data-human]){font-family:var(--xp-font-mono);font-size:var(--xp-type-label);line-height:var(--xp-leading-label)}.xp-sw-containers [data-state=failed]{color:var(--xp-status-critical-fg);background:var(--xp-status-critical-bg);border-color:var(--xp-status-critical-border)}.xp-sw-containers [data-state=uncertain]{color:var(--xp-status-warn-fg);background:var(--xp-status-warn-bg);border-color:var(--xp-status-warn-border)}.xp-sw-containers :focus-visible{outline:var(--xp-focus-width) solid var(--xp-border-focus);outline-offset:var(--xp-focus-offset)}</style>`
const translate = (locale: Locale) => (message: string, values?: MessageValues): string => escapeHtml(translator(locale)(message, values))
const tableHtml = (label: string, headers: string[], key: string, empty: string): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${label}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${label}</caption><thead><tr>${headers.map(item => `<th scope="col">${item}</th>`).join('')}</tr></thead><tbody data-sw-${key}><tr><td colspan="${headers.length}">${empty}</td></tr></tbody></table></div>`
const engineFacts = (t: ReturnType<typeof translate>): string => `<dl class="xp-sw-containers__facts">${(['podman', 'docker'] as const).map(engine => `<div><dt>${engine === 'podman' ? 'Podman' : 'Docker'}</dt><dd><bdi dir="ltr" data-human data-sw-engine-state="${engine}">${t('Not read')}</bdi></dd></div>`).join('')}<div><dt>${t('Observed at (UTC)')}</dt><dd><bdi dir="ltr" data-human data-sw-observed>${t('Not read')}</bdi></dd></div></dl>`
const jobNote = (t: ReturnType<typeof translate>, lang: string): string => `<p class="xp-help" data-sw-job hidden>${t('A host job was submitted. Its result is verified on the jobs page.')} <a data-sw-job-link href="/whm/jobs${lang}">${t('Open host jobs')}</a></p>`

/** /whm/software/containers: observed host engines and containers; lifecycle changes run as verified host jobs. */
export function renderSwContainersWorkspace(input: Input): string {
  const t = translate(input.locale), lang = input.locale === SOURCE_LOCALE ? '' : '?lang=' + encodeURIComponent(input.locale)
  return `<div class="xp-sw-containers" data-sw-containers data-sw-can-read="${input.canRead}" data-sw-can-manage="${input.canRead && input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}">${css}
  <section class="xp-whm-detail-card" aria-labelledby="sw-containers-engines"><h2 id="sw-containers-engines">${t('Container engines')}</h2>
    <p class="xp-help">${t('Podman and Docker are detected from their fixed executables and read with their documented JSON formats. Nothing is pulled, created or executed here.')}</p>
    ${engineFacts(t)}
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-sw-refresh${input.canRead ? '' : ' disabled'}>${t('Read containers')}</button><a class="xp-btn" href="/whm/software/catalog${lang}">${t('Install an engine')}</a><a class="xp-btn" href="/whm/software/containers/engine${lang}">${t('Engine settings')}</a></div>
    <p class="xp-whm-detail-status" role="status" data-sw-status data-state="unread">${t('Containers have not been read.')}</p>
    <p class="xp-help">${t('Rootless containers that accounts run under their own users are managed by each account on its Containers page and are not listed here.')}</p>
  </section>
  <section class="xp-whm-detail-card" aria-labelledby="sw-containers-list"><h2 id="sw-containers-list">${t('Containers')}</h2>
    <div class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><label for="sw-containers-engine">${t('Engine')}</label><select id="sw-containers-engine" class="xp-select" data-sw-filter-engine disabled><option value="">${t('All engines')}</option><option value="podman">Podman</option><option value="docker">Docker</option></select></div><div class="xp-whm-detail-field"><label for="sw-containers-search">${t('Search containers')}</label><input id="sw-containers-search" class="xp-input" type="search" dir="ltr" data-sw-filter-search disabled></div></div>
    ${tableHtml(t('Containers'), [t('Container'), t('Engine'), t('Image'), t('State'), t('Status'), t('Ports'), t('Actions')], 'containers', t('No containers have been read.'))}
    <p class="xp-help">${t('Stop sends SIGTERM and waits 30 seconds before the engine kills the container. A job succeeds only after the engine reports the new state.')}</p>
    ${jobNote(t, lang)}
  </section>
  <section class="xp-whm-detail-card" aria-labelledby="sw-containers-stacks"><h2 id="sw-containers-stacks">${t('Compose stacks and container apps')}</h2>
    <p class="xp-whm-detail-status" role="status">${t('Compose stacks, one-click container apps and new containers are unavailable: no reviewed compose runner or container app catalog is connected. Nothing is created here.')}</p>
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" disabled>${t('Create container')}</button><button type="button" class="xp-btn" disabled>${t('Deploy compose stack')}</button></div>
  </section>
</div>`
}

/** /whm/software/containers/engine: images, networks, volumes, registries and daemon facts; all writes stay unavailable. */
export function renderSwContainerEngineWorkspace(input: Input): string {
  const t = translate(input.locale), lang = input.locale === SOURCE_LOCALE ? '' : '?lang=' + encodeURIComponent(input.locale)
  const disabled = (label: string): string => `<button type="button" class="xp-btn" disabled>${label}</button>`
  return `<div class="xp-sw-containers" data-sw-container-engine data-sw-can-read="${input.canRead}" lang="${input.locale}" dir="${localeDirection(input.locale)}">${css}
  <section class="xp-whm-detail-card" aria-labelledby="sw-engine-daemon"><h2 id="sw-engine-daemon">${t('Engine settings')}</h2>
    ${engineFacts(t)}
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-sw-refresh${input.canRead ? '' : ' disabled'}>${t('Read engine')}</button><a class="xp-btn" href="/whm/software/containers${lang}">${t('Containers')}</a></div>
    <p class="xp-whm-detail-status" role="status" data-sw-status data-state="unread">${t('The container engine has not been read.')}</p>
    ${tableHtml(t('Engine facts'), [t('Engine'), t('OCI runtime'), t('Storage driver'), t('Cgroup version'), t('Rootless')], 'facts', t('No engine facts have been read.'))}
    <p class="xp-help">${t('Daemon settings are read only. Changing them needs a reviewed configuration writer with a restart check, which is not connected.')}</p>
    <div class="xp-whm-detail-actions">${disabled(t('Edit daemon settings'))}</div>
  </section>
  <section class="xp-whm-detail-card" aria-labelledby="sw-engine-images"><h2 id="sw-engine-images">${t('Images')}</h2>
    ${tableHtml(t('Images'), [t('Image ID'), t('Tags'), t('Size'), t('Engine')], 'images', t('No images have been read.'))}
    <p class="xp-help">${t('Pulling and removing images is unavailable until a registry trust policy and image job are reviewed.')}</p>
    <div class="xp-whm-detail-actions">${disabled(t('Pull image'))}</div>
  </section>
  <section class="xp-whm-detail-card" aria-labelledby="sw-engine-registries"><h2 id="sw-engine-registries">${t('Registries')}</h2>
    ${tableHtml(t('Registries'), [t('Registry'), t('Engine')], 'registries', t('No registries have been read.'))}
    <div class="xp-whm-detail-actions">${disabled(t('Add registry'))}</div>
  </section>
  <section class="xp-whm-detail-card" aria-labelledby="sw-engine-networks"><h2 id="sw-engine-networks">${t('Networks')}</h2>
    ${tableHtml(t('Networks'), [t('Network'), t('Driver'), t('Network ID'), t('Engine')], 'networks', t('No networks have been read.'))}
    <div class="xp-whm-detail-actions">${disabled(t('Create network'))}</div>
  </section>
  <section class="xp-whm-detail-card" aria-labelledby="sw-engine-volumes"><h2 id="sw-engine-volumes">${t('Volumes')}</h2>
    ${tableHtml(t('Volumes'), [t('Volume'), t('Driver'), t('Engine')], 'volumes', t('No volumes have been read.'))}
    <div class="xp-whm-detail-actions">${disabled(t('Create volume'))}</div>
  </section>
</div>`
}
