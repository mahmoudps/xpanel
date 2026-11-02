import { networkDiagnosticClientTemplates } from './account-diagnostic-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

/** Owner network diagnostics run from the server: DNS lookup, ping, traceroute and TCP port check. */
export function renderAccountNetworkToolsWorkspace(input: { lang: Locale; accountId: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values), off = input.canManage ? '' : ' disabled', unread = t('Not run')
  const tools = [['dns', t('DNS lookup')], ['ping', t('Ping')], ['traceroute', t('Traceroute')], ['port', t('Port check')]]
  const fact = (key: string, label: string): string => `<div><dt>${label}</dt><dd><bdi dir="ltr" data-nettools-${key}>${unread}</bdi></dd></div>`
  return `<div class="xp-acct-tool" data-account-network-tools data-account="${escapeHtml(input.accountId)}" data-nettools-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}<style>[data-account-network-tools] .xp-acct-tool__card{border-radius:var(--xp-radius-md)}[data-account-network-tools] .xp-acct-tool__card>h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}@media(min-width:601px){[data-account-network-tools] .xp-acct-tool__card{padding:var(--xp-space-card)}}</style>
    <section class="xp-acct-tool__card" aria-labelledby="account-nettools-run"><h2 id="account-nettools-run">${t('Run a diagnostic')}</h2>
      <div class="xp-acct-tool__fields"><div class="xp-field"><label for="account-nettools-tool">${t('Tool')}</label><select id="account-nettools-tool" class="xp-select" data-nettools-tool${off}>${tools.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div>
      <div class="xp-field"><label for="account-nettools-host">${t('Host name or IP address')}</label><input id="account-nettools-host" class="xp-input xp-mono" dir="ltr" type="text" inputmode="url" maxlength="253" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="example.com" data-nettools-host${off}></div>
      <div class="xp-field" data-nettools-field="type"><label for="account-nettools-type">${t('Record type')}</label><select id="account-nettools-type" class="xp-select" dir="ltr" data-nettools-type${off}>${['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SOA', 'CAA'].map(type => `<option value="${type}">${type}</option>`).join('')}</select></div>
      <div class="xp-field" data-nettools-field="port" hidden><label for="account-nettools-port">${t('Port')}</label><input id="account-nettools-port" class="xp-input" dir="ltr" type="number" min="1" max="65535" step="1" inputmode="numeric" placeholder="443" data-nettools-port${off}></div></div>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn xp-btn--primary" data-nettools-run${off}>${t(msgctxt('account-network-tools-workspace', 'Run'))}</button></div>
      <p class="xp-help">${t('Runs from this server, not from your computer. Only public internet addresses are tested: private, loopback, link-local and reserved addresses, and names that resolve to them, are refused. DNS lookup takes a domain name. At most 10 runs per minute, one at a time.')}</p></section>
    <section class="xp-acct-tool__card" aria-labelledby="account-nettools-result"><h2 id="account-nettools-result">${t('Result')}</h2>
      <dl class="xp-acct-tool__facts">${fact('target', t('Target'))}${fact('address', t('Address used'))}${fact('at', t('Ran at (UTC)'))}</dl>
      <p class="xp-help" data-nettools-summary>${t('No diagnostic has run.')}</p>
      <div class="xp-acct-tool__table" tabindex="0" role="region" aria-label="${t('Result details')}"><table class="xp-table"><thead data-nettools-head><tr><th scope="col">${t('Details')}</th></tr></thead><tbody data-nettools-rows><tr><td>${t('No diagnostic has run.')}</td></tr></tbody></table></div>
      <p data-nettools-status role="status" data-state="unread">${input.canManage ? t('Choose a tool, enter a target and run it.') : t('Network tools are unavailable here. Nothing was run.')}</p></section>
  ${networkDiagnosticClientTemplates()}</div>`
}
