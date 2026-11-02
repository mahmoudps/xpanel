import type { ServerSettings } from '@xpanel/core'
import { escapeHtml, renderLtrValue } from '../tokens.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
/** Mount inside the existing backend card, preserving the settings form and detail cards. */
export function renderWhmWebServerReadback(input: { locale: Locale; canRead: boolean; canRollback?: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  return `<div class="xp-whm-web-readback" data-whm-web-readback data-web-can-read="${input.canRead}" data-web-can-rollback="${input.canRollback === true}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
    <style>.xp-whm-web-readback{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-whm-web-readback :is(p,dl,dd){margin:0}.xp-whm-web-readback__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:16px}.xp-whm-web-readback__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-web-readback__facts dd{overflow-wrap:anywhere}.xp-whm-web-readback .xp-whm-detail-table{min-inline-size:480px!important}.xp-whm-web-readback .xp-whm-detail-table :is(th,td){overflow-wrap:normal;word-break:normal}.xp-whm-web-readback .xp-whm-detail-scroll{min-inline-size:0;max-inline-size:100%;overflow-x:auto}</style>
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-web-refresh${input.canRead ? '' : ' disabled'}>${t('Read saved and observed state')}</button></div>
    <p class="xp-whm-detail-status" data-whm-web-status data-state="unread" role="status">${t('Saved settings, services and generations have not been read.')}</p>
    <dl class="xp-whm-web-readback__facts"><div><dt>${t('Saved engine')}</dt><dd><bdi dir="ltr" data-whm-web-engine>${t('Not read')}</bdi></dd></div><div><dt>${t('Active generation')}</dt><dd><bdi dir="ltr" data-whm-web-current>${t('Not read')}</bdi></dd></div></dl>
    <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Observed web services')}"><table class="xp-table xp-whm-detail-table"><caption class="xp-sr-only">${t('Observed web services')}</caption><thead><tr>${[t('Service'), t('Unit'), t('Observed state')].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-whm-web-services><tr><td colspan="3">${t('Service observations have not been read.')}</td></tr></tbody></table></div>
    <p class="xp-help">${t('A saved engine and an active service do not verify served requests, listener ownership, tenant UID or application health. Suggested tuning needs measured host resources; generation restore needs a qualified guarded adapter.')}</p>
  </div>`
}

/** Replace the existing disabled generation selector/action, retaining their purpose. */
export function renderWhmWebGenerationControls(input: { locale: Locale; canRead: boolean; canRollback?: boolean }): string {
  const rtl = localeDirection(input.locale) === 'rtl', t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  return `<div class="xp-whm-detail-field"><label for="whm-web-restore-generation">${t('Generation to restore')}</label><select id="whm-web-restore-generation" name="web-restore-generation" data-whm-web-generation dir="ltr" style="text-align:${rtl ? 'right' : 'left'}" disabled><option value="">${t('Not read')}</option></select></div><div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-web-rollback disabled>${t('Restore selected generation')}</button></div><p class="xp-whm-detail-status" data-whm-web-rollback-admission role="status">${input.canRead && input.canRollback === true ? t('Restore requires fresh current/target checks and typing the persisted target generation number.') : t('Guarded generation restore is unavailable until the server supplies qualified admission. Reading history does not qualify restoration.')}</p>`
}


interface WhmWebSnapshotInput { locale: Locale; canRead: boolean; settings?: ServerSettings }

/** Explanatory architecture, bound only to the authorized page-load settings snapshot. */
export function renderWhmWebRequestFlow(input: WhmWebSnapshotInput): string {
  const t = translator(input.locale), text = (message: string, values?: MessageValues) => escapeHtml(t(message, values))
  const saved = input.canRead ? input.settings : undefined
  const runtime = t(msgid('Runtime not observed')), unread = t(msgid('Not read'))
  const hops = [
    { name: 'Nginx', via: 'HTTP / TLS', role: t(msgid('Edge and reverse proxy')), detail: t(msgid('The intended edge forwards site requests to the loopback backend. Public listeners and generated configuration have not been observed here.')), value: runtime },
    { name: saved ? saved.engine === 'apache' ? 'Apache' : 'OpenLiteSpeed' : unread, via: 'proxy_pass', role: t(msgid('Saved backend engine')), detail: saved?.engine === 'apache' ? t(msgid('Saved Apache MPM: {mpm}. The saved choice does not verify the identity of a serving process.'), { mpm: saved.apacheMpm }) : saved?.engine === 'openlitespeed' ? t(msgid('OpenLiteSpeed is the saved engine. Its listener and per-site execution identity have not been observed.')) : t(msgid('Saved settings have not been read.')), value: saved ? `127.0.0.1:${saved.backendPort}` : unread },
    { name: t(msgid('Site application')), via: t(msgid('Per-site handler')), role: t(msgid('Account execution boundary')), detail: t(msgid('The domain handler, PHP pool or application process, account UID and served response require separate runtime evidence.')), value: runtime },
  ]
  return `<div class="xp-whm-web-reference" data-whm-web-snapshot="page-load">
    <style>.xp-whm-detail[data-whm-detail-route="/whm/services/web"] .xp-whm-web-reference{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-whm-detail[data-whm-detail-route="/whm/services/web"] .xp-whm-web-reference :is(ol,h3,p){margin:0}.xp-whm-detail[data-whm-detail-route="/whm/services/web"] .xp-whm-web-reference__flow{list-style:none;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.xp-whm-detail[data-whm-detail-route="/whm/services/web"] .xp-whm-web-reference__hop{display:flex;flex-direction:column;gap:16px;padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;background:var(--xp-bg-elevated);min-inline-size:0}.xp-whm-detail[data-whm-detail-route="/whm/services/web"] .xp-whm-web-reference__hop :is(p,bdi){overflow-wrap:anywhere}.xp-whm-detail[data-whm-detail-route="/whm/services/web"] .xp-whm-web-reference__via{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;color:var(--xp-text-secondary,#344054)}.xp-whm-detail[data-whm-detail-route="/whm/services/web"] .xp-whm-web-reference__state{display:inline-flex;align-items:center;gap:8px;align-self:flex-start;padding:4px 8px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;font-size:12px;color:var(--xp-text-secondary,#344054)}.xp-whm-detail[data-whm-detail-route="/whm/services/web"] .xp-whm-web-reference__code{margin:0;padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;background:var(--xp-bg-elevated);font:12px/1.7 var(--xp-font-mono,'IBM Plex Mono',monospace);max-inline-size:100%;overflow-x:auto;white-space:pre;text-align:start}.xp-whm-detail[data-whm-detail-route="/whm/services/web"] .xp-whm-web-reference__comparison{min-inline-size:760px}.xp-whm-detail[data-whm-detail-route="/whm/services/web"] .xp-whm-web-reference__comparison :is(th,td){overflow-wrap:normal;word-break:normal}.xp-whm-detail[data-whm-detail-route="/whm/services/web"] .xp-whm-web-reference__gate{padding-inline-start:24px;display:flex;flex-direction:column;gap:16px}html[dir="rtl"] .xp-whm-detail[data-whm-detail-route="/whm/services/web"] .xp-whm-web-reference__arrow{transform:scaleX(-1)}@media(max-width:1200px){.xp-whm-detail[data-whm-detail-route="/whm/services/web"] .xp-whm-web-reference__flow{grid-template-columns:minmax(0,1fr)}}</style>
    <p>${text(msgid('Saved configuration when this page opened. Reload after changes to refresh this reference.'))}</p>
    <ol class="xp-whm-web-reference__flow" aria-label="${text(msgid('Request path'))}" data-whm-web-flow>${hops.map((hop, index) => `<li class="xp-whm-web-reference__hop" data-whm-web-hop><span class="xp-whm-web-reference__via"><bdi dir="ltr">${escapeHtml(hop.via)}</bdi>${index ? '<span aria-hidden="true" class="xp-whm-web-reference__arrow">→</span>' : ''}</span><h3>${escapeHtml(hop.name)}</h3><span class="xp-whm-web-reference__state"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v4l2 2"></path></svg>${escapeHtml(runtime)}</span><strong>${escapeHtml(hop.role)}</strong><p>${escapeHtml(hop.detail)}</p>${renderLtrValue(hop.value)}</li>`).join('')}</ol>
    <div class="xp-whm-detail-actions"><a class="xp-btn" href="/whm/services">${text(msgid('Manage services'))}</a></div>
  </div>`
}

export function renderWhmWebProxyReference(input: WhmWebSnapshotInput): string {
  const t = translator(input.locale), saved = input.canRead ? input.settings : undefined
  const code = saved ? `location / {
    proxy_pass http://127.0.0.1:${saved.backendPort};
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Forwarded "";
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Port $server_port;
    proxy_set_header Proxy "";
}` : t(msgid('Saved settings have not been read.'))
  return `<div class="xp-whm-web-reference" data-whm-web-snapshot="page-load"><p>${escapeHtml(t(msgid('Illustrative proxy block using the page-load saved HTTP port. This is not a read of a generated file or a verified listener.')))}</p><pre class="xp-whm-web-reference__code" tabindex="0" aria-labelledby="whm-detail-web-proxy" dir="ltr" data-whm-web-proxy-reference data-state="${saved ? 'saved' : 'unread'}"><code>${escapeHtml(code)}</code></pre><p class="xp-help">${escapeHtml(t(msgid('Forwarded client headers are overwritten at the edge. The complete generated configuration includes additional guarded directives.')))}</p></div>`
}

export function renderWhmWebConfigurationComparison(input: WhmWebSnapshotInput): string {
  const t = translator(input.locale), saved = input.canRead ? input.settings : undefined, unread = t(msgid('Not read'))
  const rows: readonly (readonly [string, string | number | boolean | undefined])[] = [
    ['engine', saved?.engine], ['apacheMpm', saved?.apacheMpm], ['backendPort', saved?.backendPort], ['backendTlsPort', saved?.backendTlsPort],
    ['worker_processes', saved?.nginx.workerProcesses], ['worker_connections', saved?.nginx.workerConnections], ['worker_rlimit_nofile', saved?.nginx.workerRlimitNofile], ['multi_accept', saved?.nginx.multiAccept], ['keepalive_timeout', saved?.nginx.keepaliveTimeoutSec],
    ['StartServers', saved?.apache.startServers], ['MinSpareServers', saved?.apache.minSpareServers], ['MaxSpareServers', saved?.apache.maxSpareServers], ['MaxRequestWorkers', saved?.apache.maxRequestWorkers], ['ServerLimit', saved?.apache.serverLimit], ['MaxConnectionsPerChild', saved?.apache.maxConnectionsPerChild],
  ]
  return `<div class="xp-whm-web-reference" data-whm-web-snapshot="page-load"><p>${escapeHtml(t(msgid('Saved configuration when this page opened. Reload after changes to refresh this reference.')))}</p><p>${escapeHtml(t(msgid('A host-specific default baseline has not been supplied. Saved values are not proof of active configuration; draft differences appear in Pending change.')))}</p><div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${escapeHtml(t(msgid('Saved configuration comparison')))}"><table class="xp-table xp-whm-detail-table xp-whm-web-reference__comparison"><caption class="xp-sr-only">${escapeHtml(t(msgid('Saved configuration comparison')))}</caption><thead><tr>${[t(msgid('Setting')), t(msgid('Default baseline')), t(msgid('Saved configuration')), t(msgid('Proposed')), t(msgid('State'))].map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${rows.map(([key, value]) => `<tr><th scope="row">${renderLtrValue(key)}</th><td>${escapeHtml(unread)}</td><td data-whm-web-snapshot-setting="${escapeHtml(key)}">${value === undefined ? escapeHtml(unread) : renderLtrValue(typeof value === 'boolean' ? value ? 'on' : 'off' : value)}</td><td>${escapeHtml(t(msgid('Not reviewed')))}</td><td>${escapeHtml(value === undefined ? unread : t(msgid('Saved configuration')))}</td></tr>`).join('')}</tbody></table></div><a href="#whm-detail-web-pending">${escapeHtml(t(msgid('Review pending change')))}</a></div>`
}

export function renderWhmWebTestGate(input: Pick<WhmWebSnapshotInput, 'locale'>): string {
  const t = translator(input.locale)
  return `<div class="xp-whm-web-reference"><p>${escapeHtml(t(msgid('Required change workflow. No step is marked passed by this explanatory reference.')))}</p><ol class="xp-whm-web-reference__gate" data-whm-web-test-gate>${[
    t(msgid('Read the complete saved settings and review the draft difference.')),
    t(msgid('Validate the candidate and test syntax before applying.')),
    t(msgid('Read the actual reconcile result and resulting generation.')),
  ].map(label => `<li>${escapeHtml(label)}</li>`).join('')}</ol></div>`
}
