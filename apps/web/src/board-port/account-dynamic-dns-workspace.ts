import { localeDirection, translator, type Locale, type MessageValues } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'
import { dynamicDnsClientTemplates } from './domain-client-templates.ts'

export function renderAccountDynamicDnsWorkspace(input: { lang: Locale; accountId: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues) => translator(input.lang)(message, values), off = input.canManage ? '' : ' disabled'
  return `<div class="xp-acct-tool" data-account-dynamic-dns data-account="${escapeHtml(input.accountId)}" data-ddns-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}
    <style>@media(min-width:601px){[data-account-dynamic-dns] .xp-acct-tool__card{padding:24px}}[data-account-dynamic-dns] .xp-acct-tool__card>h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}[data-account-dynamic-dns] [hidden]{display:none!important}[data-account-dynamic-dns] .ddns-secret{overflow-wrap:anywhere;user-select:all}[data-account-dynamic-dns] .ddns-confirm{display:grid;gap:24px}[data-account-dynamic-dns] .ddns-guide{display:grid;gap:16px;margin:0;padding-inline-start:24px}[data-account-dynamic-dns] .ddns-guide li{padding:0}</style>
    <section class="xp-acct-tool__card" aria-labelledby="ddns-list-title"><h2 id="ddns-list-title">${t('Dynamic DNS hostnames')}</h2>
      <p class="xp-help">${t('Keep a hostname pointed at a changing IP address using a router or ddclient. Each credential controls one A or AAAA record in a DNS zone owned by your account.')}</p>
      <p data-ddns-status role="status">${t('The hostname list has not been read.')}</p>
      <p class="xp-help" data-ddns-count></p>
      <div class="xp-acct-tool__table" tabindex="0" role="region" aria-label="${t('Dynamic DNS hostnames')}"><table class="xp-table"><thead><tr>${[t('Hostname'), t('Type'), t('Description'), t('Last update (UTC)'), t('State'), t('Actions')].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-ddns-rows><tr><td colspan="6">${t('No hostname list has been read.')}</td></tr></tbody></table></div>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-ddns-refresh${off}>${t('Refresh')}</button></div>
    </section>
    <section class="xp-acct-tool__card" aria-labelledby="ddns-create-title"><h2 id="ddns-create-title">${t('Add a hostname')}</h2>
      <div class="xp-acct-tool__fields"><div class="xp-field"><label for="ddns-zone">${t('Owned DNS zone')}</label><select class="xp-select" id="ddns-zone" data-ddns-zone${off}><option value="">${t('Read the hostname list first')}</option></select></div>
      <div class="xp-field"><label for="ddns-hostname">${t('Full hostname')}</label><input class="xp-input" id="ddns-hostname" data-ddns-hostname type="text" dir="ltr" maxlength="253" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="home.example.com"${off}></div>
      <div class="xp-field"><label for="ddns-type">${t('Record type')}</label><select class="xp-select" id="ddns-type" data-ddns-type dir="ltr"${off}><option value="A">A (IPv4)</option><option value="AAAA">AAAA (IPv6)</option></select></div>
      <div class="xp-field"><label for="ddns-description">${t('Description (optional)')}</label><input class="xp-input" id="ddns-description" data-ddns-description type="text" maxlength="200"${off}></div></div>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn xp-btn--primary" data-ddns-create${off}>${t('Create credential')}</button></div>
      <p class="xp-help">${t('Use lowercase DNS names. Existing single address records keep their TTL; new records use 300 seconds. The first update creates or changes the address record. At most 25 credentials per account.')}</p>
    </section>
    <section class="xp-acct-tool__card" data-ddns-confirm hidden aria-labelledby="ddns-confirm-title"><h2 id="ddns-confirm-title">${t('Manage selected hostname')}</h2>
      <dl class="xp-acct-tool__facts"><div><dt>${t('Hostname')}</dt><dd><bdi dir="ltr" data-ddns-selected></bdi></dd></div></dl>
      <div class="xp-field"><label for="ddns-confirm-name">${t('Type the hostname to confirm')}</label><input class="xp-input" id="ddns-confirm-name" data-ddns-confirm-name type="text" dir="ltr" autocomplete="off" autocapitalize="off" spellcheck="false"${off}></div>
      <p class="xp-help">${t('Rotating immediately invalidates the previous password. Removing a credential stops its updates and preserves the DNS record.')}</p>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-ddns-rotate${off}>${t('Rotate password')}</button><button type="button" class="xp-btn xp-btn--danger" data-ddns-delete${off}>${t('Remove credential')}</button><button type="button" class="xp-btn" data-ddns-cancel>${t('Cancel')}</button></div>
    </section>
    <section class="xp-acct-tool__card" data-ddns-issued hidden aria-labelledby="ddns-issued-title"><h2 id="ddns-issued-title">${t('Save this password now')}</h2>
      <p>${t('This password is shown once. Save it in your router or password manager before closing this section. It cannot be retrieved later.')}</p>
      <dl class="xp-acct-tool__facts"><div><dt>${t('Update username')}</dt><dd><bdi dir="ltr" data-ddns-username></bdi></dd></div><div><dt>${t('Password')}</dt><dd><bdi dir="ltr" class="ddns-secret" data-ddns-secret></bdi></dd></div></dl>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-ddns-copy>${t('Copy password')}</button><button type="button" class="xp-btn" data-ddns-hide>${t('I saved it — hide password')}</button></div>
    </section>
    <section class="xp-acct-tool__card" aria-labelledby="ddns-setup-title"><h2 id="ddns-setup-title">${t('Router / ddclient setup')}</h2>
      <dl class="xp-acct-tool__facts"><div><dt>${t('Protocol')}</dt><dd><bdi dir="ltr">dyndns2</bdi></dd></div><div><dt>${t('Update endpoint (HTTPS)')}</dt><dd><bdi dir="ltr" data-ddns-endpoint>/nic/update</bdi></dd></div></dl>
      <ol class="ddns-guide"><li>${t('Use the update username and one-time password as HTTP Basic credentials. Enable HTTPS in the client. Do not put the password in a URL.')}</li>
      <li>${t('Set hostname to the exact name above. Send myip with the matching IPv4 or IPv6 address. Without myip, the direct connection address is used; forwarded headers are ignored.')}</li>
      <li>${t('Allow at least 60 seconds between changed addresses. A good or nochg reply confirms the accepted address. A 911 reply means publication needs retry or review; do not treat it as success.')}</li></ol>
      <p class="xp-help">${t('Credentials stop working when removed, rotated, the owner is disabled, the account is suspended, the plan disables this feature, or the DNS zone is no longer owned by this account.')}</p>
    </section>
  ${dynamicDnsClientTemplates(t)}</div>`
}
