import { classicWhmClientTemplates } from '../themes/classic/whm-client-templates.ts'
import { type Locale, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

export interface WhmSupportPageInput { locale: Locale; canRead: boolean }
type Copy = string

const STYLE = `<style>.xp-whm-support{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-support :is(h2,h3,p,dl,dd,ul){margin:0}.xp-whm-support__group{display:flex;flex-direction:column;gap:16px;min-inline-size:0}.xp-whm-support__list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;padding-inline-start:16px;min-inline-size:0;overflow-wrap:anywhere}.xp-whm-support__list li{line-height:1.6}.xp-whm-support__confirm{display:flex;gap:8px;align-items:flex-start;min-block-size:44px;line-height:1.6}.xp-whm-support__confirm input{flex:none;margin-block-start:4px;inline-size:20px;block-size:20px}.xp-whm-support td{overflow-wrap:anywhere}.xp-whm-support :is(button,a,input,[tabindex]):focus-visible{outline:2px solid var(--xp-accent,#1d5bd6);outline-offset:2px}.xp-whm-support :disabled{cursor:not-allowed;opacity:.75}</style>`

/** /whm/support: observed support facts, the support bundle manifest with a confirmed download, and the owner-configured contact. Read-only. */
export function renderWhmSupportWorkspace(input: WhmSupportPageInput): string {
  const on = input.canRead, disabled = on ? '' : ' disabled'
  const t = (copy: Copy): string => escapeHtml(translator(input.locale)(copy))
  const card = (key: string, title: Copy, body: string): string => `<section class="xp-whm-detail-card" data-whm-support-section="${key}" aria-labelledby="whm-support-${key}"><h2 id="whm-support-${key}">${t(title)}</h2>${body}</section>`
  const help = (copy: Copy): string => `<p class="xp-help">${t(copy)}</p>`
  const status = (marker: string, copy: Copy): string => `<p class="xp-whm-detail-status" data-whm-support-${marker} data-state="${on ? 'unread' : 'unavailable'}" role="status">${t(copy)}</p>`
  const facts = (rows: readonly (readonly [string, Copy])[]): string => `<dl class="xp-whm-detail-fields">${rows.map(([key, label]) => `<div class="xp-whm-detail-field"><dt>${t(label)}</dt><dd data-whm-support-fact="${key}">${t(msgid('Not read'))}</dd></div>`).join('')}</dl>`
  const table = (label: Copy, marker: string, headers: readonly Copy[], empty: Copy): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(label)}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t(label)}</caption><thead><tr>${headers.map(header => `<th scope="col">${t(header)}</th>`).join('')}</tr></thead><tbody data-whm-support-${marker}><tr><td colspan="${headers.length}">${t(empty)}</td></tr></tbody></table></div>`
  const link = (href: string, copy: Copy): string => `<a class="xp-btn" href="${href}">${t(copy)}</a>`
  const list = (marker: string, title: Copy): string => `<div class="xp-whm-support__group"><h3>${t(title)}</h3><ul class="xp-whm-support__list" data-whm-support-${marker}><li>${t(msgid('The manifest has not been read.'))}</li></ul></div>`
  return `<div class="xp-whm-support" data-whm-support-workspace data-support-can-read="${on}" lang="${input.locale}" dir="${localeDirection(input.locale)}">${classicWhmClientTemplates('support')}${STYLE}`
    + card('summary', msgid('Support summary'),
      help(msgid('Facts read from this server for a support request. A value that could not be read is shown as not read or not verified, never assumed.'))
      + `<div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-whm-support-refresh${disabled}>${t(msgctxt('whm-support-workspace', 'Read again'))}</button></div>`
      + status('status', on ? msgid('The support summary has not been read.') : msgid('Support requires an authorized root administrator on a qualified host. Nothing was read.'))
      + facts([['panel-version', msgid('Panel version')], ['release-path', msgid('Release directory')], ['os', msgid('Operating system')], ['os-profile', msgid('OS profile')],
        ['uptime', msgid('Uptime')], ['node', msgid('Agent Node.js runtime')], ['observed-at', msgid('Observed at (UTC)')]]))
    + card('services', msgid('Services'), help(msgid('State of each service the panel manages, from systemctl.'))
      + table(msgid('Services'), 'services', [msgid('Service'), msgid('Unit'), msgid('State')], msgid('No services have been read.')))
    + card('configuration', msgctxt('whm-support-workspace', 'Configuration'), facts([['generation', msgid('Active generation')], ['generation-activated', msgid('Activated at (UTC)')], ['generation-checksum', msgid('File-set checksum')], ['drift', msgid('Configuration drift')]])
      + `<div class="xp-whm-detail-actions">${link('/whm/monitoring/repair', msgid('Open the repair center'))}</div>`)
    + card('jobs', msgid('Recent failed jobs'), help(msgid('The 10 most recent host jobs that failed.'))
      + table(msgid('Recent failed jobs'), 'jobs', [msgid('Job'), msgid('Kind'), msgid('Failure'), msgid('Finished (UTC)'), msgctxt('whm-support-workspace', 'Error')], msgid('No failed jobs have been read.'))
      + `<div class="xp-whm-detail-actions">${link('/whm/jobs', msgid('Open all jobs'))}</div>`)
    + card('bundle', msgid('Support bundle'),
      help(msgid('The bundle is one JSON document generated on demand. It contains only the items below, after the redaction rules below. Review the manifest, confirm, then download. Nothing is sent anywhere; you decide whom to share the file with.'))
      + facts([['manifest-id', msgid('Manifest')]])
      + list('included', msgid('Included')) + list('excluded', msgid('Never included')) + list('redaction', msgid('Redaction rules'))
      + `<p class="xp-help" data-whm-support-hashing>${t(msgid('Hashing is described after the manifest is read.'))}</p>`
      + `<label class="xp-whm-support__confirm" for="whm-support-confirm"><input type="checkbox" id="whm-support-confirm" data-whm-support-confirm disabled><span>${t(msgid('I reviewed this manifest. The download contains only the items it lists.'))}</span></label>`
      + `<div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-whm-support-download disabled>${t(msgid('Download support bundle'))}</button></div>`
      + status('bundle-status', on ? msgid('Read the manifest before downloading.') : msgid('The support bundle is unavailable here. Nothing was generated.')))
    + card('contact', msgid('Contact'), `<div class="xp-whm-support__group" data-whm-support-contact>${help(msgid('The support contact has not been read.'))}</div>`)
    + '</div>'
}
