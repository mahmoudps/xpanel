import { siteHealthClientTemplates } from './account-diagnostic-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

/** Owner site checks: DNS, local website answer, saved certificate and saved PHP version. */
export function renderSiteHealthWorkspace(input: { lang: Locale; accountId: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values), off = input.canManage ? '' : ' disabled', unread = t('Not checked')
  return `<div class="xp-acct-tool" data-site-health data-account="${escapeHtml(input.accountId)}" data-health-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}
    <style>[data-site-health] .xp-acct-tool__table{min-inline-size:0;max-inline-size:100%;overflow-x:auto;overscroll-behavior-inline:contain}[data-site-health] .xp-acct-tool__table>.xp-table{table-layout:auto;min-inline-size:min-content}[data-site-health] .xp-acct-tool__table :is(th,td){overflow-wrap:normal;word-break:normal}[data-site-health] .xp-acct-tool__table :is(th,td:nth-child(2)){white-space:nowrap}[data-site-health].xp-acct-tool .xp-acct-tool__table .xp-table>tbody>tr>td>bdi[dir="ltr"]{overflow-wrap:normal!important;word-break:normal}[data-site-health].xp-acct-tool .xp-acct-tool__table .xp-table>tbody>tr>td:first-child>bdi[dir="ltr"]{white-space:nowrap!important}[data-site-health] .xp-acct-tool__table td:last-child>a.xp-btn{inline-size:max-content;white-space:nowrap;overflow-wrap:normal;word-break:normal}[data-site-health] .xp-acct-tool__table:focus-visible{outline:var(--xp-focus-width,2px) solid var(--xp-border-focus);outline-offset:var(--xp-focus-offset,2px)}@media(min-width:601px){[data-site-health] .xp-acct-tool__card{padding:var(--xp-space-card,24px)}}</style>
    <section class="xp-acct-tool__card" aria-labelledby="site-health-summary"><h2 id="site-health-summary">${t('Health checks')}</h2>
      <p>${t('Checks every site you own and explains each problem with a link to the page that fixes it. Nothing is changed by a check.')}</p>
      <dl class="xp-acct-tool__facts"><div><dt>${t('Checked at (UTC)')}</dt><dd><bdi dir="ltr" data-health-at>${unread}</bdi></dd></div><div><dt>${t('Domains checked')}</dt><dd><bdi dir="ltr" data-health-count>${unread}</bdi></dd></div><div><dt>${t('Problems found')}</dt><dd><bdi dir="ltr" data-health-problems>${unread}</bdi></dd></div></dl>
      <p data-health-status role="status" data-state="unread">${t('Checks have not run.')}</p>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn xp-btn--primary" data-health-run${off}>${t('Run checks')}</button></div></section>
    <section class="xp-acct-tool__card" aria-labelledby="site-health-findings"><h2 id="site-health-findings">${t('Findings')}</h2>
      <div class="xp-acct-tool__table" tabindex="0" role="region" aria-label="${t('Findings')}"><table class="xp-table"><thead><tr>${[t('Domain'), t('Check'), t('Result'), t('Details'), t(msgctxt('site-health-workspace', 'Fix'))].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-health-rows><tr><td colspan="5">${t('Checks have not run.')}</td></tr></tbody></table></div></section>
    <section class="xp-acct-tool__card" role="note" aria-labelledby="site-health-scope"><h2 id="site-health-scope">${t('What is checked')}</h2><ul>
      <li>${t("DNS: the A and AAAA records the server's resolver sees, compared with the addresses saved for the site.")}</li>
      <li>${t('Website: the home page through the local web server, not from the internet. Only the status code is read.')}</li>
      <li>${t('Certificate: the expiry of the saved certificate that covers the name. The certificate the server presents is not fetched.')}</li>
      <li>${t('PHP: the saved PHP version against the versions this server supports. At most 20 domains are checked at a time.')}</li></ul></section>
  ${siteHealthClientTemplates()}</div>`
}
