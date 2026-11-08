import { classicSecClientTemplates } from './sec-client-templates.ts'
import { type Locale, translator } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** Classic body of the authenticated cluster: members, inbound tokens, conflicts and record synchronisation. */
export function renderClassicDnsClusterSection({ locale, canRead, canManage }: { locale: Locale; canRead: boolean; canManage: boolean }): string {
  const t = (message: string): string => escapeHtml(translator(locale)(message))
  const off = ' disabled', notRead = t('Not read')
  const input = (key: string, label: string, max: number, type = 'text', help = ''): string => `<div class="xp-sec__field"><label for="cluster-${key}">${label}</label><input id="cluster-${key}" class="xp-input" type="${type}" dir="ltr" maxlength="${max}" autocomplete="off" spellcheck="false" data-sec-input="${key}"${off}>${help ? `<p class="xp-help">${help}</p>` : ''}</div>`
  const number = (key: string, label: string, min: number, max: number, value: number): string => `<div class="xp-sec__field"><label for="cluster-${key}">${label}</label><input id="cluster-${key}" class="xp-input" type="number" inputmode="numeric" dir="ltr" min="${min}" max="${max}" step="1" value="${value}" data-sec-input="${key}"${off}></div>`
  const select = (key: string, label: string, options: [string, string][]): string => `<div class="xp-sec__field"><label for="cluster-${key}">${label}</label><select id="cluster-${key}" class="xp-select" data-sec-input="${key}"${off}>${options.map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select></div>`
  const check = (key: string, label: string): string => `<label class="xp-sec__check" for="cluster-${key}"><input id="cluster-${key}" type="checkbox" data-sec-input="${key}"${off}><span>${label}</span></label>`
  const button = (action: string, label: string, primary = false): string => `<button type="button" class="xp-btn${primary ? ' xp-btn--primary' : ''}" data-sec-action="${action}"${off}>${label}</button>`
  const fact = (key: string, label: string): string => `<div class="xp-sec__fact"><dt>${label}</dt><dd><bdi dir="ltr" data-sec-field="${key}">${notRead}</bdi></dd></div>`
  const table = (key: string, caption: string, headers: string[], empty: string): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${caption}"><table class="xp-whm-detail-table"><caption class="sr-only">${caption}</caption><thead><tr>${headers.map(item => `<th scope="col">${item}</th>`).join('')}</tr></thead><tbody data-sec-rows="${key}"><tr><td colspan="${headers.length}">${empty}</td></tr></tbody></table></div>`
  const card = (key: string, title: string, body: string, tools = ''): string => `<section class="xp-sec__card" aria-labelledby="cluster-${key}-heading"><div class="xp-sec__heading"><h2 id="cluster-${key}-heading">${title}</h2>${tools}</div>${body}</section>`
  const roleOptions: [string, string][] = [['synchronize', t('Synchronize')], ['write-only', t('Write-only')], ['standalone', t('Standalone')]]
  return `<section class="xp-sec" data-dns-cluster-workspace data-sec-can-read="${canRead}" data-sec-can-manage="${canRead && canManage}">${classicSecClientTemplates()}
    ${card('members-state', t('Authenticated cluster'), `<p class="xp-whm-detail-status" data-sec-status data-state="${canRead ? 'unread' : 'unavailable'}" role="status">${canRead ? t('Nothing has been read yet.') : t('This page requires an authorized administrator. Nothing was read or changed.')}</p><p class="xp-whm-detail-status" data-sec-result role="status" hidden></p>
      <dl class="xp-sec__facts">${fact('cluster-state', t('Clustering'))}${fact('cluster-pin', t('TLS pin of this server'))}</dl>
      <div class="xp-sec__fields">${check('cluster-enabled', t('Turn clustering on'))}${number('cluster-threshold', t('Failed commands before a member is disabled'), 1, 1000, 10)}</div>
      <p class="xp-help">${t('Members talk over HTTPS on port 2087, pinned to the key of the other server, with one token per member. Zone copies are sent when a zone changes, checked every minute.')}</p>
      <div class="xp-sec__actions">${button('cluster-save', t('Save'), true)}</div>`, `<button type="button" class="xp-btn" data-sec-action="cluster-refresh"${canRead ? '' : off}>${t('Refresh')}</button>`)}
    ${card('members', t('Cluster members'), `${table('members', t('Cluster members'), [t('Name'), t('Address'), t('Role'), t('State'), t('Failures'), t('Last success (UTC)'), t('Actions')], t('No members have been read.'))}
      <div class="xp-sec__fields">${input('member-name', t('Member host name'), 253)}${input('member-address', t('Member address'), 45)}${number('member-port', t('Port'), 1, 65535, 2087)}${select('member-role', t('Role'), roleOptions)}${input('member-pin', t('TLS pin of the member'), 64, 'text', t('Copy it from the same page on the member. A key that differs refuses the connection.'))}${input('member-token', t('Token from the member'), 48, 'password', t('It is proved against the member before saving, and never shown again.'))}</div>
      <div class="xp-sec__actions">${button('member-add', t('Add cluster member'), true)}</div>`)}
    ${card('inbound', t('Members allowed to call this server'), `${table('inbound', t('Members allowed to call this server'), [t('Name'), t('Address'), t('Token'), t('Issued (UTC)'), t('Actions')], t('No inbound members have been read.'))}
      <div class="xp-sec__fields">${input('inbound-name', t('Member host name'), 253)}${input('inbound-address', t('Member address'), 45)}</div>
      <dl class="xp-sec__facts">${fact('issued-token', t('New token'))}</dl>
      <div class="xp-sec__actions">${button('inbound-issue', t('Issue token'))}</div>`)}
    ${card('conflicts', t('Zones that need attention'), `${table('conflicts', t('Zones that need attention'), [t('Member'), t('Zone'), t('State'), t('Reason'), t('Serial'), t('Recorded (UTC)'), t('Actions')], t('No zones have been read.'))}
      <p class="xp-help">${t('An account zone or a copy from another server is never overwritten. A DNSSEC-signed zone is not copied, because a member without its keys would answer unsigned.')}</p>`)}
    ${card('sync', t('Synchronize DNS records'), `<div class="xp-sec__fields">${select('sync-mode', t('Mode'), [['all-all', t('All zones to all servers')], ['one-all', t('One zone to all servers')], ['all-here', t('All zones to this server')], ['one-here', t('One zone to this server')]])}${input('sync-zone', t('Zone'), 253)}</div>
      ${check('sync-missing', t('Include zones not configured on this server'))}
      <div class="xp-sec__actions">${button('sync-run', t('Synchronize'), true)}</div>
      ${table('sync', t('Result per member'), [t('Member'), t('Written'), t('Removed'), t('Unchanged'), t('Conflicts'), t('Result')], t('Run a synchronisation to see the result.'))}`)}
  </section>`
}
