import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
export type WhmSecurityToolsPage = 'intrusion' | 'antivirus' | 'isolation'
export interface WhmSecurityToolsWorkspaceInput { page: WhmSecurityToolsPage; locale: Locale; canRead: boolean; canManage: boolean }

/** Body for /whm/security/{intrusion,antivirus,isolation}. Values are painted by WHM_SECURITY_TOOLS_CLIENT_BINDING from authorized reads only. */
export function renderWhmSecurityToolsWorkspace({ page, locale, canRead, canManage }: WhmSecurityToolsWorkspaceInput): string {
  const t = (message: string, values?: MessageValues): string => translator(locale)(message, values)
  const off = canRead ? '' : ' disabled'
  const notRead = t('Not read')
  const fact = (key: string, label: string): string => `<div><dt>${label}</dt><dd><bdi dir="ltr" data-whm-security-tools-fact="${key}">${notRead}</bdi></dd></div>`
  const facts = (items: [string, string][]): string => `<dl class="xp-whm-security-tools__facts">${items.map(([key, label]) => fact(key, label)).join('')}</dl>`
  const field = (id: string, label: string, control: string): string => `<div class="xp-whm-security-tools__field"><label for="${id}">${label}</label>${control}</div>`
  const table = (caption: string, headers: string[], rows: string, empty: string): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${caption}"><table class="xp-whm-detail-table"><caption class="sr-only">${caption}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-whm-security-tools-rows="${rows}"><tr><td colspan="${headers.length}">${empty}</td></tr></tbody></table></div>`
  const card = (key: string, title: string, body: string): string => `<section class="xp-whm-security-tools__card" aria-labelledby="whm-security-tools-${key}-heading"><h2 id="whm-security-tools-${key}-heading">${title}</h2>${body}</section>`
  const heading = (key: string, title: string, button: string): string => `<div class="xp-whm-security-tools__heading"><h2 id="whm-security-tools-${key}-heading">${title}</h2>${button}</div>`
  const refresh = `<button type="button" class="xp-btn" data-whm-security-tools-refresh${off}>${t('Refresh')}</button>`
  const status = `<p class="xp-whm-detail-status" data-whm-security-tools-status data-state="${canRead ? 'unread' : 'unavailable'}" role="status">${canRead ? t('Nothing has been read yet.') : t('Security tools require an authorized root administrator. Nothing was read or changed.')}</p>`
  const result = '<p class="xp-whm-detail-status" data-whm-security-tools-result role="status" hidden></p>'
  const accountSelect = (id: string): string => `<select id="${id}" class="xp-select" data-whm-security-tools-account${off}><option value="">${t('Select an account')}</option></select>`
  const install = (name: string): string => `<p class="xp-help" data-whm-security-tools-install hidden>${t('{name} is not installed on this server. It can be installed from the Software center.', { name })} <a href="/whm/software/catalog?lang=${locale}">${t('Open the Software center')}</a></p>`
  const rootOnly = canRead && canManage ? '' : `<p class="xp-help">${t('Changes require root authorization.')}</p>`

  const bodies: Record<WhmSecurityToolsPage, string> = {
    intrusion: `<section class="xp-whm-security-tools__card" aria-labelledby="whm-security-tools-fail2ban-heading">${heading('fail2ban', t('Fail2ban'), refresh)}${status}
        ${facts([['service', t('Service')], ['jails', t('Jails')], ['banned', t('Currently banned')], ['observed-at', t('Observed at (UTC)')]])}${install('Fail2ban')}
        <p class="xp-help" data-whm-security-tools-unsupported hidden>${t('Some jails have names outside the reviewed format and were not read.')}</p></section>
      ${card('jails', t('Jails'), table(t('Fail2ban jails'), [t('Jail'), t('Currently failed'), t('Total failed'), t('Currently banned'), t('Total banned'), t('State')], 'jails', t('No jails have been read.')))}
      ${card('banned', t('Banned addresses'), `<div class="xp-whm-security-tools__fields">
          ${field('whm-security-tools-filter-jail', t('Jail'), `<select id="whm-security-tools-filter-jail" class="xp-select" data-whm-security-tools-filter="jail"${off}><option value="">${t('All jails')}</option></select>`)}
          ${field('whm-security-tools-filter-text', t('Address'), `<input id="whm-security-tools-filter-text" class="xp-input xp-mono" type="search" dir="ltr" maxlength="45" autocomplete="off" data-whm-security-tools-filter="text"${off}>`)}
        </div>
        <p class="xp-help">${t('Unban removes one address from one jail after a fresh read shows it is banned there. Fail2ban bans it again if the failures continue. Subnet entries are shown but cannot be unbanned here.')}</p>${rootOnly}${result}
        <p class="xp-help" data-whm-security-tools-truncated hidden>${t('Only the first 5000 banned addresses were read.')}</p>
        ${table(t('Banned addresses'), [t('Address'), t('Jail'), t('Actions')], 'banned', t('No banned addresses have been read.'))}`)}`,
    antivirus: `<section class="xp-whm-security-tools__card" aria-labelledby="whm-security-tools-engine-heading">${heading('engine', t('ClamAV engine'), refresh)}${status}
        ${facts([['engine', t('Engine version')], ['signatures', t('Signature version')], ['signature-date', t('Signature date')], ['updater', t('Signature updater')], ['observed-at', t('Observed at (UTC)')]])}${install('ClamAV')}
        <div class="xp-whm-security-tools__actions"><button type="button" class="xp-btn" data-whm-security-tools-update disabled>${t('Update signatures')}</button></div>
        <p class="xp-help">${t('The update runs freshclam as a host job. When the clamav-freshclam service is running it already keeps signatures current, and a manual update may fail while it holds the update lock.')}</p></section>
      ${card('scan', t('Scan an account'), `<div class="xp-whm-security-tools__fields">${field('whm-security-tools-scan-account', t('Account'), accountSelect('whm-security-tools-scan-account'))}</div>
        <div class="xp-whm-security-tools__actions"><button type="button" class="xp-btn xp-btn--primary" data-whm-security-tools-scan disabled>${t('Start scan')}</button><a class="xp-btn" href="/whm/jobs?lang=${locale}" data-whm-security-tools-job-link hidden>${t('Open job')}</a></div>
        <p class="xp-help">${t('The scan runs as a host job on the account home only. Symbolic links are not followed, files over 100 MB and archives over 400 MB of content are skipped, and a scan can use about 1 GB of memory.')}</p>
        <p class="xp-help">${t('Infected files are reported only. Quarantine and deletion are not available here.')}</p>${rootOnly}${result}`)}
      ${card('scans', t('Recent scans'), table(t('Recent scans'), [t('Started (UTC)'), t('Account'), t('Result'), t('Scanned files'), t('Infected files'), t('Job')], 'scans', t('No scans have been read.')))}
      ${card('findings', t('Infected files'), `<p class="xp-help" data-whm-security-tools-incomplete hidden>${t('Some scans list only part of their findings. The infected file count comes from the scan summary.')}</p>${table(t('Infected files'), [t('Account'), t('Path'), t('Signature')], 'findings', t('No infected files have been read.'))}`)}
      ${card('updates', t('Signature updates'), table(t('Signature updates'), [t('Started (UTC)'), t('Result'), t('Signature version'), t('Job')], 'updates', t('No signature updates have been read.')))}`,
    isolation: `<section class="xp-whm-security-tools__card" aria-labelledby="whm-security-tools-account-heading">${heading('account', t('Account'), refresh)}${status}
        <div class="xp-whm-security-tools__fields">${field('whm-security-tools-isolation-account', t('Account'), accountSelect('whm-security-tools-isolation-account'))}</div>
        <div class="xp-whm-security-tools__actions"><button type="button" class="xp-btn xp-btn--primary" data-whm-security-tools-inspect disabled>${t('Inspect isolation')}</button></div>
        ${facts([['account', t('Account')], ['uid', t('UID')], ['account-status', t('Account status')], ['state', t('Result')], ['observed-at', t('Observed at (UTC)')]])}
        <p class="xp-help">${t('This view is read-only. It compares the user, home directory, resource slice, cgroup limits and PHP-FPM identity on the host with what xPanel renders for the account and its plan.')}</p></section>
      ${card('checks', t('Isolation checks'), `<p class="xp-help" data-whm-security-tools-drift hidden>${t('Drift means the host differs from the rendered configuration.')} <a href="/whm/monitoring/repair?lang=${locale}">${t('Review drift in the Repair center')}</a></p>${table(t('Isolation checks'), [t('Control'), t('Expected'), t('Observed'), t('State')], 'checks', t('No account has been inspected.'))}`)}`,
  }
  return `<section class="xp-whm-security-tools" data-whm-security-tools-workspace data-security-tools-page="${page}" data-security-tools-can-read="${canRead}" data-security-tools-can-manage="${canRead && canManage}" lang="${locale}" dir="${localeDirection(locale)}">
    <style>
    .xp-whm-security-tools{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-security-tools :is(h2,p,dl,dd){margin:0}.xp-whm-security-tools__card{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface)}
    .xp-whm-security-tools__heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}.xp-whm-security-tools__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:16px}.xp-whm-security-tools__facts>div,.xp-whm-security-tools__field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-security-tools dt{font-weight:600}.xp-whm-security-tools dd{overflow-wrap:anywhere}
    .xp-whm-security-tools__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.xp-whm-security-tools :is(input,select){box-sizing:border-box;inline-size:100%;min-inline-size:0;min-block-size:44px;margin:0}.xp-whm-security-tools[dir=rtl] input[dir=ltr]{text-align:right}
    .xp-whm-security-tools__actions{display:flex;flex-wrap:wrap;align-items:center;gap:16px}.xp-whm-security-tools :is(button,.xp-btn){min-block-size:44px}.xp-whm-security-tools [hidden]{display:none}.xp-whm-security-tools :focus-visible{outline:2px solid var(--xp-accent);outline-offset:2px}.xp-whm-security-tools td bdi{unicode-bidi:isolate;overflow-wrap:anywhere}
    @media(min-width:601px){.xp-whm-security-tools__card{padding:var(--xp-space-card)}}@media(max-width:639px){.xp-whm-security-tools__fields{grid-template-columns:minmax(0,1fr)}.xp-whm-security-tools__actions>:is(button,a){flex:1 1 auto}}
    </style>
    ${bodies[page]}
  </section>`
}
