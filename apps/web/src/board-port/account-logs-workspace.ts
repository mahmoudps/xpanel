import { logsClientTemplates } from './team-logs-client-templates.ts'
import type { Domain } from '@xpanel/core'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

export type AccountLogPageKind = 'access' | 'error'
/** Bounded edge log tails for the owner's domains; filters run in the page over the read tail. */
export function renderAccountLogsWorkspace(input: { lang: Locale; accountId: string; domains: readonly Pick<Domain, 'id' | 'accountId' | 'name'>[]; selectedDomainId?: string; kinds: readonly AccountLogPageKind[]; rawAccess?: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values)
  const domains = input.domains.filter(domain => domain.accountId === input.accountId), kinds = (['access', 'error'] as const).filter(kind => input.kinds.includes(kind))
  const off = kinds.length && domains.length ? '' : ' disabled'
  const select = (key: string, label: string, options: readonly (readonly [string, string, boolean?])[], hidden = false) => `<div class="xp-field" data-logs-field="${key}"${hidden ? ' hidden' : ''}><label for="account-logs-${key}">${label}</label><select id="account-logs-${key}" class="xp-select" data-logs-${key}${off}>${options.map(([value, text, technical]) => `<option value="${escapeHtml(value)}">${technical ? escapeHtml(text) : text}</option>`).join('')}</select></div>`
  return `<div class="xp-acct-tool" data-account-logs data-account="${escapeHtml(input.accountId)}" data-logs-kinds="${kinds.join(' ')}" data-logs-manage="${kinds.length > 0}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}<style>[data-account-logs][dir="ltr"] [data-logs-text]{text-align:left}[data-account-logs][dir="rtl"] [data-logs-text]{text-align:right}@media(min-width:601px){[data-account-logs] .xp-acct-tool__card{padding:var(--xp-space-card,24px)}}</style>
    <section class="xp-acct-tool__card" aria-labelledby="account-logs-choose"><h2 id="account-logs-choose">${t('Choose a log')}</h2>
      <div class="xp-acct-tool__fields"><div class="xp-field"><label for="account-logs-domain">${t('Domain')}</label><select id="account-logs-domain" class="xp-select" dir="ltr" data-logs-domain${off}>${domains.map(domain => `<option value="${escapeHtml(domain.id)}"${domain.id === input.selectedDomainId ? ' selected' : ''}>${escapeHtml(domain.name)}</option>`).join('')}</select></div>
      ${select('kind', t('Log'), kinds.map(kind => [kind, kind === 'access' ? t('Access log') : t('Error log')] as const))}</div>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn xp-btn--primary" data-logs-read${off}>${t('Read log')}</button></div>
      <p class="xp-help">${t("Shows the last 256 KiB, at most 2000 lines, of the log the web server writes for the site. An alias shares its main site's log. Rotated older logs are not shown.")}</p></section>
    <section class="xp-acct-tool__card" aria-labelledby="account-logs-entries"><h2 id="account-logs-entries">${t('Log entries')}</h2>
      <div class="xp-acct-tool__fields">${select('class', t('Status'), [['all', t('All responses')], ['2', '2xx', true], ['3', '3xx', true], ['4', '4xx', true], ['5', '5xx', true]])}
      ${select('level', t('Level'), [['all', t('All levels')], ['error', t('Errors and worse')], ['warn', t('Warnings and worse')]], true)}
      <div class="xp-field"><label for="account-logs-text">${t('Contains text')}</label><input id="account-logs-text" class="xp-input" dir="auto" type="search" maxlength="200" autocomplete="off" data-logs-text${off}></div></div>
      <p class="xp-help" data-logs-summary>${t('No log has been read.')}</p>
      <div class="xp-acct-tool__table" tabindex="0" role="region" aria-label="${t('Log entries')}"><table class="xp-table"><thead data-logs-head><tr><th scope="col">${t('Entries')}</th></tr></thead><tbody data-logs-rows><tr><td>${t('No log has been read.')}</td></tr></tbody></table></div>
      <p data-logs-status role="status" data-state="unread">${kinds.length ? domains.length ? t('Choose a domain and read its log.') : t('This account has no domains to read logs for.') : t('Site logs are unavailable here. Nothing was read.')}</p></section>
    <section class="xp-acct-tool__card" aria-labelledby="account-raw-access" data-account-raw-access data-account="${escapeHtml(input.accountId)}" data-raw-access-manage="${input.rawAccess}"><h2 id="account-raw-access">${t('Raw access archives')}</h2>
      <p class="xp-help">${t('Each site access log is rotated once per UTC day after its traffic is counted. With archiving on it is kept in ~/logs as a gzip file named after the site and day; otherwise it is deleted.')}</p>
      <div class="xp-acct-tool__fields" data-raw-access-form>
        <label class="xp-field"><span><input type="checkbox" data-raw-access="archive"${input.rawAccess ? '' : ' disabled'}> ${t('Archive logs in ~/logs after their traffic is counted')}</span></label>
        <label class="xp-field"><span><input type="checkbox" data-raw-access="removePreviousMonthArchive"${input.rawAccess ? '' : ' disabled'}> ${t("Remove the previous month's archives when a new UTC month starts")}</span></label>
        <div class="xp-field"><label for="account-raw-access-days">${t('Keep archives (days)')}</label><input id="account-raw-access-days" class="xp-input" type="text" inputmode="numeric" dir="ltr" autocomplete="off" data-raw-access="retentionDays" placeholder="${t('Until removed')}"${input.rawAccess ? '' : ' disabled'}></div>
        <p class="xp-help" data-raw-access-source>${t('Settings have not been read.')}</p>
        <div class="xp-acct-tool__actions"><button type="button" class="xp-btn xp-btn--primary" data-raw-access-save${input.rawAccess ? '' : ' disabled'}>${t('Save settings')}</button><button type="button" class="xp-btn" data-raw-access-defaults${input.rawAccess ? '' : ' disabled'}>${t('Use server defaults')}</button></div>
        <p data-raw-access-status role="status" data-state="unread">${input.rawAccess ? t('Settings have not been read.') : t('Raw access archives are unavailable here. Nothing was read.')}</p>
      </div>
      <div class="xp-acct-tool__table" tabindex="0" role="region" aria-label="${t('Current access logs')}"><table class="xp-table"><thead><tr><th scope="col">${t('Domain')}</th><th scope="col">${t('Current access log')}</th></tr></thead><tbody data-raw-access-current>${domains.map(domain => `<tr><td><bdi dir="ltr">${escapeHtml(domain.name)}</bdi></td><td>${input.rawAccess ? `<a class="xp-btn" href="/api/account/logs/${escapeHtml(domain.id)}/access/download" download>${t('Download as gzip')}</a>` : t('Unavailable')}</td></tr>`).join('') || `<tr><td colspan="2">${t('This account has no domains to read logs for.')}</td></tr>`}</tbody></table></div>
      <p class="xp-help">${t('The current log is the part not yet rotated today. It is compressed while it downloads; an alias shares its main site\'s log.')}</p>
      <div class="xp-acct-tool__table" tabindex="0" role="region" aria-label="${t('Archives in ~/logs')}"><table class="xp-table"><thead><tr><th scope="col">${t('Archive')}</th><th scope="col">${t('Day (UTC)')}</th><th scope="col">${t('Size')}</th><th scope="col">${t('Download')}</th></tr></thead><tbody data-raw-access-rows><tr><td colspan="4">${t('Archives have not been read.')}</td></tr></tbody></table></div>
      <p data-raw-access-list-status role="status" data-state="unread" hidden></p>
      <p data-raw-access-pending role="status" data-state="unread" hidden></p></section>
${logsClientTemplates(t)}  </div>`
}
