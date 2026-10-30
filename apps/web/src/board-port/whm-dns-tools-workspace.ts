import { dnsToolsTemplates } from './data-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
export interface WhmDnsToolsWorkspaceInput { locale: Locale; canRead: boolean; canManage: boolean }

/** Body for /whm/dns/more. Values are painted by WHM_DNS_TOOLS_CLIENT_BINDING from authorized reads only. */
export function renderWhmDnsToolsWorkspace({ locale, canRead, canManage }: WhmDnsToolsWorkspaceInput): string {
  const t = (message: string, values?: MessageValues): string => translator(locale)(message, values)
  const off = canRead ? '' : ' disabled'
  const notRead = t('Not read')
  const facts = (items: [string, string][]): string => `<dl class="xp-whm-dns-tools__facts">${items.map(([key, label]) => `<div><dt>${label}</dt><dd><bdi dir="ltr" data-whm-dns-tools-fact="${key}">${notRead}</bdi></dd></div>`).join('')}</dl>`
  const table = (caption: string, headers: string[], rows: string, empty: string): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${caption}"><table class="xp-whm-detail-table"><caption class="sr-only">${caption}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-whm-dns-tools-rows="${rows}"><tr><td colspan="${headers.length}">${empty}</td></tr></tbody></table></div>`
  const card = (key: string, title: string, body: string, extra = ''): string => `<section class="xp-whm-dns-tools__card" aria-labelledby="whm-dns-tools-${key}-heading"><div class="xp-whm-dns-tools__heading"><h2 id="whm-dns-tools-${key}-heading">${title}</h2>${extra ? `<div class="xp-whm-dns-tools__actions">${extra}</div>` : ''}</div>${body}</section>`
  const button = (attribute: string, label: string, primary = false): string => `<button type="button" class="xp-btn${primary ? ' xp-btn--primary' : ''}" ${attribute} disabled>${label}</button>`
  const status = (key: string, message: string, state = 'unread'): string => `<p class="xp-whm-detail-status" data-whm-dns-tools-status="${key}" data-state="${state}" role="status">${message}</p>`
  const pager = (key: string): string => `<div class="xp-whm-dns-tools__actions">${button(`data-whm-dns-tools-page="${key}" data-direction="previous"`, t('Previous page'))}<p data-whm-dns-tools-page-label="${key}" role="status">${t('Page: not read')}</p>${button(`data-whm-dns-tools-page="${key}" data-direction="next"`, t('Next page'))}</div>`
  const rootOnly = canRead && canManage ? '' : `<p class="xp-help">${t('Checks and changes require root authorization.')}</p>`
  const unread = t('Nothing has been read yet.')

  return `<section class="xp-whm-dns-tools" data-whm-dns-tools-workspace data-dns-tools-can-read="${canRead}" data-dns-tools-can-manage="${canRead && canManage}" lang="${locale}" dir="${localeDirection(locale)}">
    <style>
    .xp-whm-dns-tools{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-dns-tools :is(h2,h3,p,dl,dd){margin:0}.xp-whm-dns-tools__heading>h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}.xp-whm-dns-tools__group>h3{font-size:var(--xp-type-body);line-height:var(--xp-leading-body);font-weight:var(--xp-weight-semibold)}.xp-whm-dns-tools__card{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface)}
    .xp-whm-dns-tools__heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}.xp-whm-dns-tools__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:16px}.xp-whm-dns-tools__facts>div,.xp-whm-dns-tools__field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-dns-tools dt{font-weight:600}.xp-whm-dns-tools dd{overflow-wrap:anywhere}
    .xp-whm-dns-tools__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.xp-whm-dns-tools input:not([type=checkbox]){box-sizing:border-box;inline-size:100%;min-inline-size:0;min-block-size:44px;margin:0}.xp-whm-dns-tools[dir=rtl] input[dir=ltr]{text-align:right}.xp-whm-dns-tools input[type=checkbox]{inline-size:20px;block-size:20px;margin:0}
    .xp-whm-dns-tools__actions{display:flex;flex-wrap:wrap;align-items:center;gap:16px}.xp-whm-dns-tools :is(button,.xp-btn){min-block-size:44px}.xp-whm-dns-tools [hidden]{display:none}.xp-whm-dns-tools :focus-visible{outline:2px solid var(--xp-accent);outline-offset:2px}.xp-whm-dns-tools td bdi{unicode-bidi:isolate;overflow-wrap:anywhere}
    .xp-whm-dns-tools__group{display:flex;flex-direction:column;gap:16px;min-inline-size:0}.xp-whm-dns-tools ul.xp-help{display:flex;flex-direction:column;gap:8px;margin:0;padding-inline-start:24px}
    @media(min-width:601px){.xp-whm-dns-tools__card{padding:24px}}@media(max-width:639px){.xp-whm-dns-tools__fields{grid-template-columns:minmax(0,1fr)}.xp-whm-dns-tools__actions>:is(button,a){flex:1 1 auto}}
    </style>
    ${card('summary', t('Saved zones'), `${status('summary', canRead ? unread : t('DNS tools require an authorized root administrator. Nothing was read or changed.'), canRead ? 'unread' : 'unavailable')}
      ${facts([['zones', t('Saved zones')], ['observed-at', t('Read at (UTC)')]])}
      <p class="xp-help">${t('Every tool here works on this server only: pdnsutil reads the zones PowerDNS serves, and DNS questions go to the local authoritative listener at 127.0.0.1. Public recursion and other name servers are never queried.')}</p>
      <p class="xp-help">${t('To change records of one zone, use the DNS zone editor.')} <a href="/whm/dns?lang=${locale}">${t('Open DNS zones')}</a></p>${rootOnly}`,
      `<button type="button" class="xp-btn" data-whm-dns-tools-refresh${off}>${t('Refresh')}</button>`)}
    ${card('check', t('Check all zones'), `${status('check', t('No check has been read yet.'))}
      <p class="xp-help">${t('Runs pdnsutil check-zone for every saved zone as read-only host jobs of up to 32 zones each. Nothing is changed. Results appear when a job has run.')}</p>
      <p class="xp-whm-detail-status" data-whm-dns-tools-result="check" role="status" hidden></p>
      ${table(t('DNS check jobs'), [t('Job'), t('Zones'), t('Status'), t('Created (UTC)'), t('Finished (UTC)'), t('Results')], 'jobs', t('No check jobs have been read.'))}
      <div class="xp-whm-dns-tools__group"><h3>${t('Zone results')}</h3>${status('results', t('Choose a job to read its zone results.'))}
      ${table(t('Zone check results'), [t('Zone'), t('Result'), t('Records'), t('Errors'), t('Warnings'), t('Messages')], 'results', t('No zone results have been read.'))}
      <a class="xp-btn" href="/whm/jobs?lang=${locale}" data-whm-dns-tools-job-link hidden>${t('Open job')}</a></div>`,
      button('data-whm-dns-tools-run="check"', t('Check all zones'), true) + button('data-whm-dns-tools-load="jobs"', t('Refresh results')))}
    ${card('compare', t('Compare published vs saved'), `${status('compare', t('No comparison has been read yet.'))}
      <p class="xp-help">${t('For 25 zones at a time, the SOA serial and NS set answered by the local authoritative listener are compared with the saved serial, the rendered zone file and the saved apex NS records. xPanel may raise a file serial above the saved value when it rewrites a zone, so only a published serial below the saved one counts as behind.')}</p>
      ${pager('compare')}
      ${table(t('Published and saved zones'), [t('Zone'), t('Saved serial'), t('File serial'), t('Published serial'), t('Saved NS'), t('Published NS'), t(msgctxt('whm-dns-tools-workspace', 'Drift'))], 'compare', unread)}`,
      button('data-whm-dns-tools-load="compare"', t('Compare'), true))}
    ${card('nameservers', t('Nameserver check'), `${status('nameservers', t('No nameserver check has been read yet.'))}
      <ul class="xp-help">
        <li>${t('Each saved apex nameserver is resolved through the local authoritative listener only. A name outside the zones this server hosts cannot be resolved here, because public recursion is out of scope.')}</li>
        <li>${t('A nameserver answers for the zone when one of its addresses is on this server and this server answers the zone SOA. Addresses of other servers are shown but never queried.')}</li>
      </ul>
      ${pager('nameservers')}
      ${table(t('Saved nameservers'), [t('Zone'), t('Local SOA answer'), t('Nameserver'), t('Addresses'), t('Result')], 'nameservers', unread)}`,
      button('data-whm-dns-tools-load="nameservers"', t('Check nameservers'), true))}
    ${card('ttl', t('Bulk TTL change'), `${status('ttl', t('Select zones and a TTL, then preview the change.'))}
      <div class="xp-whm-dns-tools__fields">
        <div class="xp-whm-dns-tools__field"><label for="whm-dns-tools-ttl">${t('New TTL for every record (seconds)')}</label><input id="whm-dns-tools-ttl" class="xp-input xp-mono" type="number" dir="ltr" inputmode="numeric" min="0" max="2147483647" step="1" data-whm-dns-tools-ttl${off}></div>
        <div class="xp-whm-dns-tools__field"><label for="whm-dns-tools-search">${t('Search zones')}</label><input id="whm-dns-tools-search" class="xp-input xp-mono" type="search" dir="ltr" maxlength="253" autocomplete="off" data-whm-dns-tools-search${off}></div>
      </div>
      <p class="xp-help">${t('The TTL of every record in each selected zone is set to the new value. Up to 32 zones per change. Each zone is written only if it is unchanged since the preview, and each write is read back.')}</p>
      <p data-whm-dns-tools-selected role="status">${t('Selected zones: 0 / 32')}</p>
      <p class="xp-help" data-whm-dns-tools-limited hidden>${t('Only the first 200 matching zones are shown. Refine the search to see others.')}</p>
      ${table(t('Zones for the TTL change'), [t('Select'), t('Zone'), t('Records'), t('Current TTL range')], 'zones', t('No zones have been read.'))}
      <div class="xp-whm-dns-tools__actions">${button('data-whm-dns-tools-run="preview"', t('Preview change'))}${button('data-whm-dns-tools-run="apply"', t('Apply to previewed zones'), true)}</div>
      ${table(t('TTL change preview'), [t('Zone'), t('Records'), t('Records that change'), t('Current TTL range'), t(msgctxt('whm-dns-tools-workspace', 'Preview'))], 'preview', t('No preview has been made.'))}
      <p class="xp-whm-detail-status" data-whm-dns-tools-result="ttl" role="status" hidden></p>
      ${table(t('TTL change results'), [t('Zone'), t('Records changed'), t('Result')], 'applied', t('No change has been applied.'))}`)}
  ${dnsToolsTemplates()}</section>`
}
