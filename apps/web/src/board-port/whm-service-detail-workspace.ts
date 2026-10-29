import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
export type WhmServiceDetailKind = 'dns' | 'ftp' | 'certificates'
export interface WhmServiceDetailWorkspaceInput { kind: WhmServiceDetailKind; locale: Locale; canRead: boolean; canRestart: boolean }

/** /whm/services/{dns,ftp,certificates}. Values are painted only from an authorized fresh host read; restarts reuse /api/server/services/<id>/restart. */
export function renderWhmServiceDetailWorkspace({ kind, locale, canRead, canRestart }: WhmServiceDetailWorkspaceInput): string {
  const t = (message: string, values?: MessageValues): string => translator(locale)(message, values), off = canRead ? '' : ' disabled'
  const notRead = t('Not read')
  const fact = (key: string, label: string): string => `<div><dt>${label}</dt><dd><bdi dir="ltr" data-whm-service-detail-fact="${key}">${notRead}</bdi></dd></div>`
  const field = (id: string, label: string, control: string): string => `<div class="xp-whm-service-detail__field"><label for="${id}">${label}</label>${control}</div>`
  const table = (label: string, headers: string[]): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${label}"><table class="xp-table xp-whm-detail-table"><caption class="xp-sr-only">${label}</caption><thead><tr>${headers.map(header => `<th scope="col">${header}</th>`).join('')}</tr></thead><tbody data-whm-service-detail-rows><tr><td colspan="${headers.length}">${t('Nothing has been read yet.')}</td></tr></tbody></table></div>`
  const restart = kind === 'certificates' ? '' : `<button type="button" class="xp-btn xp-btn--danger" data-whm-service-detail-restart="${kind === 'dns' ? 'pdns' : 'pure-ftpd'}" disabled>${kind === 'dns' ? t('Restart PowerDNS') : t('Restart pure-ftpd')}</button>`
  const facts: Record<WhmServiceDetailKind, [string, string][]> = {
    dns: [['unit', t('Service unit')], ['state', t('Service state')], ['control', t('Control socket')], ['version', t('Running version')],
      ['zone-dir', t('Zone directory')], ['rendered', t('Zones in saved state')], ['present', t('Zone files present')], ['observed-at', t('Observed at (UTC)')]],
    ftp: [['unit', t('Service unit')], ['state', t('Service state')], ['tls', t('TLS: policy / host')], ['passive', t('Passive ports: policy / host')],
      ['accounts', t('FTP accounts in saved state')], ['conf-dir', t('Configuration directory')], ['observed-at', t('Observed at (UTC)')]],
    certificates: [['hostname', t(msgctxt('whm-service-detail-workspace', 'Server hostname'))], ['observed', t('Certificates read')], ['warnings', t('Endpoints with warnings')], ['observed-at', t('Observed at (UTC)')]],
  }
  const heading = { dns: t('PowerDNS service'), ftp: t('pure-ftpd service'), certificates: t('Certificate summary') }[kind]
  const detail = kind === 'dns' ? `<section class="xp-whm-service-detail__card" aria-labelledby="whm-service-detail-zones-heading">
      <h2 id="whm-service-detail-zones-heading">${t('Zone files')}</h2>
      <div class="xp-whm-service-detail__fields">
        ${field('whm-service-detail-filter-state', t(msgctxt('whm-service-detail-workspace', 'Show')), `<select id="whm-service-detail-filter-state" class="xp-select" data-whm-service-detail-filter="state"${off}><option value="">${t('All zones')}</option><option value="attention">${t('Needs attention')}</option><option value="rendered">${t(msgctxt('whm-service-detail-workspace', 'Rendered by xPanel'))}</option><option value="unmanaged">${t('Not in saved state')}</option></select>`)}
        ${field('whm-service-detail-filter-text', t('Zone name'), `<input id="whm-service-detail-filter-text" class="xp-input xp-mono" type="search" dir="ltr" maxlength="253" autocomplete="off" data-whm-service-detail-filter="text"${off}>`)}
      </div>
      <p class="xp-help" data-whm-service-detail-truncated hidden>${t('Only the first zones were read. Counts cover the shown zones only.')}</p>
      ${table(t('Zone files'), [t('Zone'), t('Saved state'), t('Zone file'), t('State serial'), t('File serial (SOA)'), t('Size'), t('Check')])}
      <p class="xp-help">${t('Serials are parsed from the SOA record of each file. xPanel may raise a file serial above the saved value when it rewrites a zone. Check zone runs pdnsutil check-zone and changes nothing.')}</p>
      <p class="xp-whm-detail-status" data-whm-service-detail-check role="status" hidden></p>
      <ol class="xp-whm-service-detail__messages" data-whm-service-detail-check-messages hidden></ol>
    </section>` : kind === 'ftp' ? `<section class="xp-whm-service-detail__card" aria-labelledby="whm-service-detail-settings-heading">
      <h2 id="whm-service-detail-settings-heading">${t('Daemon settings')}</h2>
      ${table(t('pure-ftpd settings'), [t('Setting'), t('xPanel policy'), t('Host file'), t('Result')])}
      <p class="xp-help">${t('The policy column is the pure-ftpd configuration xPanel renders. Host values are read from one file per setting in the configuration directory, which the pure-ftpd wrapper turns into daemon flags. The running process flags are not read here.')}</p>
    </section>` : `<section class="xp-whm-service-detail__card" aria-labelledby="whm-service-detail-endpoints-heading">
      <div class="xp-whm-service-detail__heading"><h2 id="whm-service-detail-endpoints-heading">${t('Service endpoints')}</h2><a class="xp-btn" href="/whm/ssl?lang=${locale}">${t('Replace or renew in SSL/TLS')}</a></div>
      ${table(t('Service certificates'), [t('Service'), t('Ports'), t('Certificate file'), t('Names'), t(msgctxt('whm-service-detail-workspace', 'Issuer')), t('Valid until (UTC)'), t('Days left'), t('Hostname covered'), t('Private key'), t('Warnings')])}
      <p class="xp-help">${t('Certificate paths come from the configuration xPanel renders. Only certificate files are read; private keys are checked for presence and never opened. Mail and FTP daemons keep their distribution TLS settings, which are not read here.')}</p>
    </section>`
  return `<section class="xp-whm-service-detail" data-whm-service-detail-workspace="${kind}" data-service-detail-can-read="${canRead}" data-service-detail-can-restart="${canRead && canRestart && kind !== 'certificates'}" lang="${locale}" dir="${localeDirection(locale)}" aria-labelledby="whm-service-detail-summary-heading">
    <style>
    .xp-whm-service-detail{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-service-detail :is(h2,p,dl,dd,ol){margin:0}.xp-whm-service-detail__card{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface)}
    .xp-whm-service-detail__heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}.xp-whm-service-detail__actions{display:flex;flex-wrap:wrap;gap:16px}.xp-whm-service-detail__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:16px}
    .xp-whm-service-detail__facts>div,.xp-whm-service-detail__field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-service-detail dt{font-weight:600}.xp-whm-service-detail dd{overflow-wrap:anywhere}
    .xp-whm-service-detail__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.xp-whm-service-detail :is(input,select){box-sizing:border-box;inline-size:100%;min-inline-size:0;min-block-size:44px;margin:0}.xp-whm-service-detail[dir=rtl] input[dir=ltr]{text-align:right}
    .xp-whm-service-detail button,.xp-whm-service-detail a.xp-btn{min-block-size:44px}.xp-whm-service-detail__messages{display:flex;flex-direction:column;gap:8px;padding-inline-start:24px}.xp-whm-service-detail [hidden]{display:none}.xp-whm-service-detail :focus-visible{outline:2px solid var(--xp-accent);outline-offset:2px}
    .xp-whm-service-detail td bdi{unicode-bidi:isolate;overflow-wrap:anywhere}
    .xp-whm-service-detail__card h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-body);font-weight:var(--xp-weight-semibold)}.xp-whm-service-detail .xp-whm-detail-table :is(th,td){overflow-wrap:normal;word-break:normal}.xp-whm-service-detail[data-whm-service-detail-workspace=dns] .xp-whm-detail-table{min-inline-size:1040px!important}.xp-whm-service-detail[data-whm-service-detail-workspace=ftp] .xp-whm-detail-table{min-inline-size:640px!important}.xp-whm-service-detail[data-whm-service-detail-workspace=certificates] .xp-whm-detail-table{min-inline-size:1440px!important}.xp-whm-service-detail .xp-whm-detail-scroll{min-inline-size:0;max-inline-size:100%;overflow-x:auto}
    @media(min-width:601px){.xp-whm-service-detail__card{padding:24px}}@media(max-width:639px){.xp-whm-service-detail__fields{grid-template-columns:minmax(0,1fr)}.xp-whm-service-detail__actions>*{flex:1 1 auto}}
    </style>
    <section class="xp-whm-service-detail__card" aria-labelledby="whm-service-detail-summary-heading">
      <div class="xp-whm-service-detail__heading"><h2 id="whm-service-detail-summary-heading">${heading}</h2><div class="xp-whm-service-detail__actions"><button type="button" class="xp-btn" data-whm-service-detail-refresh${off}>${t('Refresh')}</button>${restart}</div></div>
      <p class="xp-whm-detail-status" data-whm-service-detail-status data-state="unread" role="status">${t('This service has not been read.')}</p>
      <p class="xp-whm-detail-status" data-whm-service-detail-result role="status" hidden></p>
      <dl class="xp-whm-service-detail__facts">${facts[kind].map(([key, label]) => fact(key, label)).join('')}</dl>
      ${kind === 'certificates' || canRead && canRestart ? '' : `<p class="xp-help">${t('Restarting this service requires root authorization.')}</p>`}
    </section>
    ${detail}
  </section>`
}
