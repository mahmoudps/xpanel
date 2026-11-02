import { databaseRemoteTemplates } from './data-client-templates.ts'
import { localeDirection, translator, type Locale, type MessageValues } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

export function renderAccountDatabaseRemoteWorkspace(input: { lang: Locale; accountId: string; username: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues) => translator(input.lang)(message, values), off = input.canManage ? '' : ' disabled'
  return `<div class="xp-acct-tool" data-account-database-remote data-account="${escapeHtml(input.accountId)}" data-username="${escapeHtml(input.username)}" data-remote-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}
    <style>[data-account-database-remote] [hidden]{display:none!important}[data-account-database-remote] .remote-selected{display:grid;gap:24px}[data-account-database-remote] .remote-note{overflow-wrap:anywhere}[data-account-database-remote] .xp-acct-tool__card{padding:24px}[data-account-database-remote] .xp-acct-tool__card h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card)}[data-account-database-remote] .xp-acct-tool__table{min-inline-size:0}[data-account-database-remote] .xp-acct-tool__table th{white-space:nowrap}[data-account-database-remote] .xp-acct-tool__table :is(th,td){overflow-wrap:normal;word-break:normal}[data-account-database-remote] .xp-acct-tool__table bdi[dir="ltr"]{white-space:nowrap!important;overflow-wrap:normal!important;word-break:normal!important}@media(max-width:600px){[data-account-database-remote] .xp-acct-tool__card{padding:16px}}</style>
    <section class="xp-acct-tool__card" aria-labelledby="remote-hosts-title"><h2 id="remote-hosts-title">${t('Remote database access')}</h2>
      <p class="xp-help">${t('Choose outside addresses that may connect to your MariaDB databases. Each allowed host receives the saved grants for all your database users. Localhost is implicit and cannot be removed here.')}</p>
      <p data-remote-status role="status">${t('The remote-host policy has not been read.')}</p>
      <dl class="xp-acct-tool__facts"><div><dt>${t('Account')}</dt><dd><bdi dir="ltr">${escapeHtml(input.username)}</bdi></dd></div><div><dt>${t('Applies to')}</dt><dd data-remote-scope>${t(msgctxt('account-database-remote-workspace', 'Not read'))}</dd></div><div><dt>${t('Remote hosts')}</dt><dd><bdi dir="ltr" data-remote-count>— / 100</bdi></dd></div></dl>
      <div class="xp-acct-tool__table" tabindex="0" role="region" aria-label="${t('Remote database hosts')}"><table class="xp-table"><thead><tr>${[t('Host'), t(msgctxt('account-database-remote-workspace', 'Comment')), t('Added (UTC)'), t('Firewall'), t(msgctxt('account-database-remote-workspace', 'Grants')), t('Actions')].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-remote-rows><tr><td colspan="6">${t('No host policy has been read.')}</td></tr></tbody></table></div>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-remote-refresh${off}>${t('Refresh')}</button></div>
    </section>
    <section class="xp-acct-tool__card" aria-labelledby="remote-edit-title"><h2 id="remote-edit-title">${t('Add or edit a host')}</h2>
      <div class="remote-selected" data-remote-selected-panel hidden><dl class="xp-acct-tool__facts"><div><dt>${t('Selected host')}</dt><dd><bdi dir="ltr" data-remote-selected></bdi></dd></div></dl>
        <div class="xp-field"><label for="remote-confirmation">${t('Type the selected host to confirm a change or removal')}</label><input class="xp-input" id="remote-confirmation" data-remote-confirmation dir="ltr" autocomplete="off" autocapitalize="off" spellcheck="false"${off}></div></div>
      <div class="xp-acct-tool__fields"><div class="xp-field"><label for="remote-host">${t('Host or IPv4 network')}</label><input class="xp-input" id="remote-host" data-remote-host dir="ltr" maxlength="64" aria-describedby="remote-host-help" placeholder="192.0.2.0/24" autocomplete="off" autocapitalize="off" spellcheck="false"${off}></div>
        <div class="xp-field"><label for="remote-comment">${t('Comment (optional)')}</label><input class="xp-input" id="remote-comment" data-remote-comment maxlength="200"${off}></div></div>
      <p class="xp-help" id="remote-host-help">${t('Use an exact IPv4 or IPv6 address, or an IPv4 CIDR with zero host bits. A range such as 192.0.2.% is saved as 192.0.2.0/24. DNS names, any-host %, /0 and IPv6 subnets are refused.')}</p>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn xp-btn--primary" data-remote-save${off}>${t('Add host')}</button><button type="button" class="xp-btn xp-btn--danger" data-remote-remove disabled>${t('Remove selected host')}</button><button type="button" class="xp-btn" data-remote-cancel${off}>${t('Cancel selection')}</button></div>
      <p class="xp-help remote-note">${t('Changes require fresh account authorization, exact grant and source-scoped TCP/3306 firewall readback, and verified recovery. An unavailable or unverified provider keeps changes disabled. Removing one host preserves every other host and all localhost grants.')}</p>
    </section>
  ${databaseRemoteTemplates(t)}</div>`
}
