import { classicWhmClientTemplates } from './whm-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** Labels for the API scope resources; the API (panel-tokens-workspace.ts) owns the accepted list and a test keeps both equal. */
export const PANEL_TOKEN_SCOPE_LABELS: Readonly<Record<string, string>> = {
  accounts: msgid('Accounts'),
  'account-preferences': msgid('Account preferences'),
  analytics: msgid('Analytics'),
  apps: msgid('Web apps'),
  audit: msgid('Audit log'),
  auth: msgid('Authentication'),
  backups: msgid('Backups'),
  branding: msgid('Branding'),
  cache: msgid('Cache services'),
  catalog: msgid('Tool catalog'),
  cluster: msgid('DNS cluster'),
  containers: msgid('Containers'),
  cron: msgctxt('whm-panel-tokens-workspace', 'Cron jobs'),
  databases: msgid('Databases'),
  dns: msgid('DNS zones'),
  domains: msgid('Domains'),
  events: msgid('Live events'),
  'feature-lists': msgid('Feature lists'),
  files: msgid('Files and web directives'),
  firewall: msgid('Firewall'),
  generations: msgid('Configuration generations'),
  git: msgid('Git repositories'),
  ips: msgid('IP addresses'),
  jobs: msgid('Host jobs'),
  languages: msgid('Languages'),
  lifecycle: msgid('Transfers and lifecycle'),
  mail: msgid('Email'),
  plans: msgid('Plans'),
  reconcile: msgid('Reconciliation'),
  resellers: msgid('Resellers'),
  search: msgctxt('whm-panel-tokens-workspace', 'Search'),
  security: msgid('Security'),
  server: msgid('Server administration'),
  'service-users': msgctxt('whm-panel-tokens-workspace', 'Service users'),
  shell: msgid('Shell'),
  tls: msgid('SSL/TLS certificates'),
  webmail: msgid('Webmail'),
  whmcs: 'WHMCS',
}

const EXPIRY_DAYS = [1, 30, 90, 180, 365] as const

const styles = `<style>.xp-whm-tokens :is(h3,p,code,fieldset){margin:0}.xp-whm-tokens__group{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-whm-tokens__heading{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between}.xp-whm-tokens__loading,.xp-whm-tokens__empty{display:flex;flex-direction:column;gap:8px;align-items:flex-start}.xp-whm-tokens__loading{align-items:stretch}.xp-whm-tokens__reveal{display:flex;flex-direction:column;gap:16px;padding:16px;border:1px solid var(--xp-border-strong,#d0d5dd);border-radius:8px;background:var(--xp-bg-elevated,#f7f8fa)}.xp-whm-tokens__secret{display:block;padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;background:var(--xp-bg-surface,#fff);font-family:var(--xp-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:14px;line-height:1.6;overflow-wrap:anywhere;text-align:left;user-select:all}.xp-whm-tokens__scopes{display:flex;flex-direction:column;gap:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;padding:16px;min-inline-size:0}.xp-whm-tokens__scopes legend{padding-inline:8px;font-weight:600}.xp-whm-tokens .xp-whm-detail-table th{white-space:nowrap}.xp-whm-tokens__scopes td input{inline-size:20px;block-size:20px;margin:0}.xp-whm-tokens__list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}.xp-whm-tokens__warning{padding:16px;border:1px solid var(--xp-border-critical,#f04438);border-radius:8px;color:var(--xp-text-critical,#b42318)}.xp-whm-tokens__revoke-note{display:block;color:var(--xp-text-secondary,#344054)}</style>`

/** Complete /whm/panel/api-tokens page body: root's own API listener tokens, one-time reveal, create and revoke. */
export function renderWhmPanelTokensWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const disabled = input.canManage ? '' : ' disabled'
  const container = input.canManage ? 'form' : 'div'
  const headers = [t('Name'), t(msgctxt('whm-panel-tokens-workspace', 'Scopes')), t(msgctxt('whm-panel-tokens-workspace', 'Allowed from')), t('Created (UTC)'), t('Expires (UTC)'), t('Last used (UTC)'), t('State'), t('Action')]
  const scopeRows = Object.entries(PANEL_TOKEN_SCOPE_LABELS).map(([resource, label]) => {
    const box = (access: 'read' | 'write', label: string): string => `<td><input type="checkbox" name="scope" value="${resource}:${access}" aria-label="${label}: ${t(label)}" data-whm-tokens-scope${disabled}></td>`
    return `<tr><th scope="row">${t(label)}</th><td><bdi dir="ltr">${resource}</bdi></td>${box('read', t('Read'))}${box('write', t('Write'))}</tr>`
  }).join('')
  return `${styles}<section class="xp-whm-detail xp-whm-tokens" data-whm-detail-route="/whm/panel/api-tokens" data-whm-panel-tokens-workspace data-tokens-can-manage="${input.canManage}" data-capability-state="${input.canManage ? 'authorized' : 'unavailable'}" lang="${input.locale}" dir="${localeDirection(input.locale)}">${classicWhmClientTemplates('tokens')}
  <header class="xp-whm-detail-heading"><h1>${t('API tokens')}</h1><p>${t('Scoped, expiring tokens for scripts and automation that act as root on the API listener. Only a hash of each token is stored.')}</p></header>
  <div class="xp-whm-detail-column">
    <section class="xp-whm-detail-card" data-whm-detail-section="api-tokens-list" aria-labelledby="whm-tokens-list-heading">
      <div class="xp-whm-tokens__heading"><h2 id="whm-tokens-list-heading">${t('Your tokens')}</h2><span class="xp-help">${t('Times in UTC')}</span></div>
      <p>${t('Send a token as')} <bdi dir="ltr"><code>Authorization: Bearer &lt;token&gt;</code></bdi> ${t('(RFC 6750) to the API listener. The xWHM, xPanel and xMail sign-in listeners refuse bearer tokens by design, so a token never works in this browser.')}</p>
      <div class="xp-whm-tokens__reveal" data-whm-tokens-reveal role="status" hidden>
        <p data-whm-tokens-reveal-text></p>
        <code class="xp-whm-tokens__secret" dir="ltr" data-whm-tokens-secret></code>
        <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-whm-tokens-copy${disabled}>${t('Copy token')}</button><button type="button" class="xp-btn" data-whm-tokens-done${disabled}>${t('Done')}</button></div>
        <p class="xp-help" data-whm-tokens-copy-status role="status" hidden></p>
      </div>
      <p class="xp-whm-detail-status" data-whm-tokens-status data-state="unread" role="status">${t('Your API tokens have not been read. No token is assumed to exist or to be active.')}</p>
      <div class="xp-whm-tokens__loading" data-whm-tokens-loading aria-busy="true" aria-label="${t('Loading tokens')}" hidden><span class="xp-skeleton-line"></span><span class="xp-skeleton-line"></span><span class="xp-skeleton-line xp-skeleton-line--short"></span></div>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('API tokens')}"><table class="xp-whm-detail-table"><caption class="sr-only">${t('API tokens, newest first')}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-whm-tokens-rows><tr><td colspan="8">${t('No tokens have been read.')}</td></tr></tbody></table></div>
      <div class="xp-whm-tokens__empty" data-whm-tokens-empty hidden><h3>${t('No API tokens yet')}</h3><p>${t('Create a token below when a script needs API access. Nothing can use the API as root until then.')}</p></div>
      <p class="xp-help">${t('Newest first, up to 200 tokens. This version does not record when a token is used, so last use shows Not recorded.')}</p>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-tokens-refresh${disabled}>${t('Refresh')}</button></div>
      <p class="xp-whm-detail-status" data-whm-tokens-revoke-status role="status" hidden></p>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="api-tokens-create" aria-labelledby="whm-tokens-create-heading">
      <h2 id="whm-tokens-create-heading">${t('Create a token')}</h2>
      <${container} class="xp-whm-tokens__group" data-whm-tokens-create aria-labelledby="whm-tokens-create-heading"${input.canManage ? ' novalidate' : ''}>
        <div class="xp-whm-detail-fields">
          <div class="xp-whm-detail-field"><label for="whm-tokens-name">${t('Name')}</label><input id="whm-tokens-name" name="name" type="text" dir="ltr" maxlength="64" autocomplete="off" spellcheck="false" placeholder="stock-sync" aria-describedby="whm-tokens-name-help" data-whm-tokens-name${disabled}><p class="xp-help" id="whm-tokens-name-help">${t('Lowercase letters, digits and dashes, up to 64 characters.')}</p></div>
          <div class="xp-whm-detail-field"><label for="whm-tokens-expiry">${t('Expires after')}</label><select id="whm-tokens-expiry" name="expiresInDays" aria-describedby="whm-tokens-expiry-help" data-whm-tokens-expiry${disabled}>${EXPIRY_DAYS.map(days => `<option value="${days}"${days === 90 ? ' selected' : ''}>${days === 1 ? t('1 day') : days === 365 ? t('1 year (365 days)') : t('{count} days', { count: days })}</option>`).join('')}</select><p class="xp-help" id="whm-tokens-expiry-help">${t('Tokens always expire. The longest is one year.')}</p></div>
          <div class="xp-whm-detail-field"><label for="whm-tokens-ips">${t('Allowed addresses (optional)')}</label><input id="whm-tokens-ips" name="allowedIps" type="text" dir="ltr" maxlength="1024" autocomplete="off" spellcheck="false" placeholder="198.51.100.24, 2001:db8::/32" aria-describedby="whm-tokens-ips-help" data-whm-tokens-ips${disabled}><p class="xp-help" id="whm-tokens-ips-help">${t('IPv4 or IPv6 addresses or CIDR ranges, comma-separated, up to 16. Empty allows any address.')}</p></div>
        </div>
        <fieldset class="xp-whm-tokens__scopes" aria-describedby="whm-tokens-scopes-help"${disabled}>
          <legend>${t(msgctxt('whm-panel-tokens-workspace', 'Scopes'))}</legend>
          <p class="xp-help" id="whm-tokens-scopes-help">${t('Choose at least one scope. A token can do only what its scopes allow. Write does not include read.')}</p>
          <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(msgctxt('whm-panel-tokens-workspace', 'Scopes'))}"><table class="xp-whm-detail-table"><thead><tr><th scope="col">${t('Area')}</th><th scope="col">${t('Key')}</th><th scope="col">${t('Read')}</th><th scope="col">${t('Write')}</th></tr></thead><tbody>${scopeRows}</tbody></table></div>
          <label class="xp-whm-detail-choice"><input type="checkbox" name="scope" value="*" data-whm-tokens-all${disabled}><span>${t('Full access to every API operation')} (<bdi dir="ltr">*</bdi>)</span></label>
          <p class="xp-whm-tokens__warning" data-whm-tokens-all-warning>${t('Full access lets the token do anything root can do through the API, including operations added later. Use it only when no narrower set works. It cannot be combined with other scopes.')}</p>
        </fieldset>
        <div class="xp-whm-detail-actions"><button type="${input.canManage ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-whm-tokens-create-submit${disabled}>${t('Create token')}</button><button type="button" class="xp-btn" data-whm-tokens-clear${disabled}>${t('Clear')}</button></div>
        <p class="xp-whm-detail-status" data-whm-tokens-create-status role="status" hidden></p>
      </${container}>
    </section>
  </div>
</section>`
}
