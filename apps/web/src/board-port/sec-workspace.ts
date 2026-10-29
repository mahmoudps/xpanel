import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

export type SecPage = 'waf' | 'flood' | 'panel-access' | 'dns-providers' | 'dns-cluster' | 'account-waf' | 'account-cloudflare'
export interface SecWorkspaceInput { page: SecPage; locale: Locale; canRead: boolean; canManage: boolean }

/** Body for the WAF, flood, panel access, DNS provider and DNS cluster pages. Values are painted by the sec client bindings from authorized reads only. */
export function renderSecWorkspace({ page, locale, canRead, canManage }: SecWorkspaceInput): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(locale)(message, values))
  const manage = canRead && canManage, off = ' disabled'
  const notRead = t('Not read')
  const fact = (key: string, label: string): string => `<div class="xp-sec__fact"><dt>${label}</dt><dd><bdi dir="ltr" data-sec-field="${key}">${notRead}</bdi></dd></div>`
  const facts = (items: [string, string][]): string => `<dl class="xp-sec__facts">${items.map(([key, label]) => fact(key, label)).join('')}</dl>`
  const field = (id: string, label: string, control: string, help = ''): string => `<div class="xp-sec__field"><label for="sec-${id}">${label}</label>${control}${help ? `<p class="xp-help" id="sec-${id}-help">${help}</p>` : ''}</div>`
  const number = (id: string, min: number, max: number): string => `<input id="sec-${id}" class="xp-input" type="number" inputmode="numeric" dir="ltr" min="${min}" max="${max}" step="1" data-sec-input="${id}"${off}>`
  const text = (id: string, max: number, type = 'text'): string => `<input id="sec-${id}" class="xp-input" type="${type}" dir="ltr" maxlength="${max}" autocomplete="off" spellcheck="false" data-sec-input="${id}"${off}>`
  const area = (id: string, rows: number, max: number): string => `<textarea id="sec-${id}" class="xp-textarea xp-mono" dir="ltr" rows="${rows}" maxlength="${max}" autocomplete="off" spellcheck="false" data-sec-input="${id}" aria-describedby="sec-${id}-help"${off}></textarea>`
  const check = (id: string, label: string): string => `<label class="xp-sec__check" for="sec-${id}"><input id="sec-${id}" type="checkbox" data-sec-input="${id}"${off}><span>${label}</span></label>`
  const select = (id: string, options: [string, string][]): string => `<select id="sec-${id}" class="xp-select" data-sec-input="${id}"${off}>${options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>`
  const button = (action: string, label: string, primary = false): string => `<button type="button" class="xp-btn${primary ? ' xp-btn--primary' : ''}" data-sec-action="${action}"${off}>${label}</button>`
  const table = (key: string, caption: string, headers: string[], empty: string): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${caption}"><table class="xp-whm-detail-table"><caption class="sr-only">${caption}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-sec-rows="${key}"><tr><td colspan="${headers.length}">${empty}</td></tr></tbody></table></div>`
  const card = (key: string, title: string, body: string, tools = ''): string => `<section class="xp-sec__card" aria-labelledby="sec-${key}-heading"><div class="xp-sec__heading"><h2 id="sec-${key}-heading">${title}</h2>${tools}</div>${body}</section>`
  const actions = (...items: string[]): string => `<div class="xp-sec__actions">${items.join('')}</div>`
  const refresh = `<button type="button" class="xp-btn" data-sec-action="refresh"${canRead ? '' : off}>${t('Refresh')}</button>`
  const status = `<p class="xp-whm-detail-status" data-sec-status data-state="${canRead ? 'unread' : 'unavailable'}" role="status">${canRead ? t('Nothing has been read yet.') : t('This page requires an authorized administrator. Nothing was read or changed.')}</p>`
  const result = '<p class="xp-whm-detail-status" data-sec-result role="status" hidden></p>'
  const rootOnly = manage ? '' : `<p class="xp-help">${t('Changes require root authorization.')}</p>`
  const saveHelp = `<p class="xp-help">${t('Saving stores the policy and asks the server to apply it. The page then reads the running configuration again; only that read shows what is active.')}</p>`
  const unlimited = t('Unlimited')

  const bodies: Record<SecPage, string> = {
    waf: card('waf', t('Nginx web application firewall'), `${status}<p class="xp-help">${t('Our own rules, applied at the edge before any request reaches Apache or an account.')}</p>
      ${facts([['updated', t('Last saved (UTC)')], ['lists-active', t('Deny lists in the running configuration')], ['reconcile', t('Last apply request')]])}
      <h3>${t('Limits')}</h3><div class="xp-sec__fields">${field('rate', t('Requests per address (req/s)'), number('rate', 1, 10000))}${field('burst', t('Burst (req)'), number('burst', 0, 100000))}</div>${check('rate-unlimited', t('Unlimited request rate'))}
      <p class="xp-help">${t('Requests over the burst get 429. Each site gets its own per-address zone.')}</p>
      <div class="xp-sec__fields">${field('body', t('Largest request body (MB)'), number('body', 1, 102400))}${field('denied', t('Answer for denied requests'), select('denied', [['403', t('403 Forbidden')], ['444', t('444 Close the connection')]]))}</div>${check('body-unlimited', t('Unlimited request body'))}
      <p class="xp-help">${t('Larger uploads get 413.')}</p>
      <h3>${t('Deny lists')}</h3><div class="xp-sec__fields xp-sec__fields--wide">${field('deny-ips', t('Addresses and ranges'), area('deny-ips', 5, 50000), t('One address or network per line, up to 1000.'))}${field('deny-paths', t('Path patterns'), area('deny-paths', 5, 26000), t('One PCRE pattern per line. Each pattern is compiled during nginx -t; a bad pattern keeps the previous generation.'))}${field('deny-agents', t('User-agent patterns'), area('deny-agents', 5, 26000), t('One PCRE pattern per line, matched without regard to case.'))}</div>
      ${check('modsecurity', t('Use ModSecurity with the OWASP Core Rule Set when the Nginx connector is installed'))}
      ${saveHelp}${rootOnly}${actions(button('save', t('Save and apply'), true))}${result}`, refresh)
      + card('modsec', t('ModSecurity with OWASP Core Rule Set'), `<p class="xp-sec__pill" data-sec-field="modsec-state" data-tone="neutral">${notRead}</p>
      ${facts([['nginx-connector', t('Nginx connector')], ['apache-module', t('Apache module')], ['rule-engine', t('Rule engine (SecRuleEngine)')], ['crs-version', t('Core Rule Set version')], ['modsec-active', t('Active in the running configuration')], ['observed-at', t('Observed at (UTC)')]])}
      <p class="xp-help">${t('The Core Rule Set is attached automatically once the ModSecurity module for Nginx is present. The rules above work without it.')}</p>
      <p class="xp-help" data-sec-install hidden>${t('ModSecurity for Nginx is not installed on this server.')} <a href="/whm/software/catalog?lang=${locale}">${t('Install ModSecurity')}</a></p>`),
    flood: card('flood', t('Host firewall limits'), `${status}<p class="xp-help">${t('nftables limits on the web ports, applied after established connections are accepted. SSH and the panel ports keep their own sign-in protection.')}</p>
      ${facts([['updated', t('Last saved (UTC)')], ['reconcile', t('Last apply request')]])}
      ${check('enabled', t('Turn on flood protection'))}
      <div class="xp-sec__fields">${field('conn', t('Connections per address'), number('conn', 1, 100000), t('Concurrent connections from one address to ports 80 and 443. Empty means no limit.'))}${field('ping', t('Ping requests per second'), number('ping', 1, 10000), t('All sources together. Empty means no limit.'))}${field('rate', t('New connections per second per address'), number('rate', 1, 100000))}${field('burst', t('Burst (connections)'), number('burst', 1, 100000))}</div>
      <h3>${t('Web server limit')}</h3><div class="xp-sec__fields">${field('web-conn', t('Concurrent requests per address in Nginx'), number('web-conn', 1, 100000), t('Applied to every site with limit_conn. Excess requests get 429.'))}</div>
      ${saveHelp}${rootOnly}${actions(button('save', t('Save and apply'), true))}${result}`, refresh)
      + card('kernel', t('Running firewall'), `${facts([['kernel-state', t('State')], ['observed-at', t('Observed at (UTC)')]])}
      ${table('kernel', t('Flood rules in the kernel'), [t('Limit'), t('Rules'), t('Tracked addresses')], t('The running firewall has not been read.'))}`),
    'panel-access': card('client', t('Your connection'), `${status}${facts([['listener', t('Entry point')], ['address', t('Your address')], ['enforcement', t('Enforcement')], ['updated', t('Last saved (UTC)')]])}
      <p class="xp-help">${t('Allowlists are checked on every request before sign-in, using the socket address or the address from a trusted proxy. An empty list allows every address.')}</p>`, refresh)
      + card('lists', t('IP allowlists'), `<div class="xp-sec__fields xp-sec__fields--wide">${field('xpanel', t('xPanel (port 2083)'), area('xpanel', 5, 30000), t('One address or network per line. Text after # is kept as a note.'))}${field('xwhm', t('xWHM (port 2087)'), area('xwhm', 5, 30000), t('Root and reseller sign-in. A save that removes your current address is refused.'))}${field('xmail', t('xMail (port 2096)'), area('xmail', 5, 30000), t('Webmail sign-in for mailbox users.'))}</div>
      ${rootOnly}${actions(button('save', t('Save allowlists'), true))}${result}`)
      + card('other', t('Other access settings'), `<p class="xp-help">${t('Panel port, secret entrance path, unauthenticated response, basic authentication and temporary sign-in links are not available here. The panel port is shown under Panel security.')}</p>`),
    'dns-providers': card('accounts', t('Provider accounts'), `${status}${table('accounts', t('Provider accounts'), [t('Name'), t('Provider'), t('Token ID'), t('Verified (UTC)'), t('Actions')], t('No provider accounts have been read.'))}
      <h3>${t('Connect provider')}</h3><div class="xp-sec__fields">${field('label', t('Name'), `<input id="sec-label" class="xp-input" type="text" maxlength="64" autocomplete="off" data-sec-input="label"${off}>`)}${field('token', t('Cloudflare API token'), text('token', 40, 'password'), t('The token is checked with Cloudflare before it is saved. It is stored only on this server and is never shown again.'))}</div>
      <p class="xp-help">${t('Only Cloudflare is supported. Other DNS providers are not available.')}</p>${rootOnly}${actions(button('connect', t('Connect provider'), true))}${result}`, refresh)
      + card('links', t('Domains linked to Cloudflare'), `${table('links', t('Domains linked to Cloudflare'), [t('Domain'), t('Zone ID'), t('Account'), t('Linked (UTC)'), t('Actions')], t('No linked domains have been read.'))}
      <div class="xp-sec__fields">${field('link-domain', t('Domain'), select('link-domain', [['', t('Select a domain')]]))}${field('link-account', t('Provider account'), select('link-account', [['', t('Select an account')]]))}</div>
      <p class="xp-help">${t('Linking looks up the zone with exactly this name in the selected Cloudflare account.')}</p>${actions(button('link', t('Link domain')))}`)
      + card('zone', t('Zone details'), zoneBody()),
    'dns-cluster': card('cluster', t('DNS cluster'), `${status}${facts([['application', t('Cluster state')], ['launch', t('PowerDNS backends')], ['primary', t('Sends NOTIFY to peers')], ['include-dir', t('Include directory')], ['axfr', t('Zone transfers allowed from')], ['updated', t('Last saved (UTC)')]])}
      <p class="xp-help">${t('This server is the primary. Peers are secondary nameservers that transfer zones from it; PowerDNS sends them NOTIFY when a serial changes.')}</p>`, refresh)
      + card('peers', t('Peers'), `${table('peers', t('Peers'), [t('Name'), t('Address'), t('Transfer allowed'), t('Notified'), t('Actions')], t('No peers have been read.'))}
      <div class="xp-sec__fields">${field('peer-name', t('Peer name'), text('peer-name', 253))}${field('peer-address', t('Peer address'), text('peer-address', 45))}</div>
      ${rootOnly}${actions(button('add-peer', t('Add peer')), button('apply', t('Apply to PowerDNS'), true))}
      <p class="xp-help">${t('Adding or removing a peer saves the list. Apply writes one PowerDNS settings file, restarts PowerDNS and reads the running settings again; an unconfirmed result is rolled back.')}</p>${result}`)
      + card('transfers', t('Zone transfer status'), `${facts([['verify-peer', t('Peer')], ['verify-counts', t('Result')], ['verify-at', t('Observed at (UTC)')]])}
      ${table('transfers', t('Zone transfer status'), [t('Zone'), t('Serial on this server'), t('Serial on the peer'), t('State')], t('Select Verify for a peer to compare zone serials.'))}`),
    'account-waf': card('protection', t('Protection for your sites'), `${status}${facts([['modsec', t('ModSecurity')], ['crs-version', t('Core Rule Set version')], ['rate', t('Requests per address (req/s)')], ['body', t('Largest request body (MB)')], ['denied', t('Answer for denied requests')], ['lists', t('Server deny lists')]])}
      <p class="xp-help">${t('These limits are set by the server administrator and apply to every site on this server.')}</p>`, refresh)
      + card('domains', t('ModSecurity per domain'), `${table('domains', t('ModSecurity per domain'), [t('Domain'), t('ModSecurity'), t('Actions')], t('No domains have been read.'))}
      <p class="xp-help">${t('Turning ModSecurity off for a domain stops rule checks for its sites. The server deny lists and limits still apply.')}</p>${result}`),
    'account-cloudflare': card('domains', t('Your domains on Cloudflare'), `${status}${table('domains', t('Your domains on Cloudflare'), [t('Domain'), t('Cloudflare'), t('Actions')], t('No domains have been read.'))}
      <p class="xp-help">${t('Your hosting provider connects domains to Cloudflare. For a connected domain you can inspect the zone and purge its cache.')}</p>${result}`, refresh)
      + card('zone', t('Zone details'), zoneBody()),
  }
  function zoneBody(): string {
    return `${facts([['zone-domain', t('Domain')], ['zone-status', t('Zone status')], ['zone-ssl', t('SSL/TLS mode')], ['zone-ns', t('Cloudflare nameservers')], ['zone-at', t('Observed at (UTC)')]])}
      <p class="xp-help" data-sec-zone-truncated hidden>${t('Only the first 500 Cloudflare records were compared.')}</p>
      ${table('records', t('Records compared with this server'), [t('Name'), t('Type'), t('This server'), t('Cloudflare'), t('Proxied'), t('State')], t('Select Inspect for a linked domain.'))}`
  }
  return `<section class="xp-sec" data-sec-workspace data-sec-page="${page}" data-sec-can-read="${canRead}" data-sec-can-manage="${manage}" lang="${locale}" dir="${localeDirection(locale)}">
    <style>
    .xp-sec{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-sec :is(h2,h3,p,dl,dd){margin:0}.xp-sec h3{font-size:16px;line-height:24px}.xp-sec__card{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface)}
    .xp-sec__heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}.xp-sec__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:16px}.xp-sec__fact,.xp-sec__field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-sec dt,.xp-sec label{font-weight:600}.xp-sec dd{overflow-wrap:anywhere}
    .xp-sec__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.xp-sec__fields--wide{grid-template-columns:repeat(3,minmax(0,1fr))}.xp-sec :is(input:not([type=checkbox]),select,textarea){box-sizing:border-box;inline-size:100%;min-inline-size:0;min-block-size:44px;margin:0}.xp-sec[dir=rtl] :is(input,textarea)[dir=ltr]{text-align:right}
    .xp-sec__check{display:flex;align-items:center;gap:8px;min-block-size:44px;font-weight:400}.xp-sec__check input{inline-size:20px;block-size:20px;margin:0}.xp-sec__actions{display:flex;flex-wrap:wrap;align-items:center;gap:16px}.xp-sec :is(button,.xp-btn){min-block-size:44px}
    .xp-sec__pill{align-self:flex-start;padding:4px 12px;border-radius:999px;background:var(--xp-bg-muted,#EEF0F3);font-weight:600}.xp-sec__pill[data-tone=good]{color:var(--xp-success,#067647)}.xp-sec__pill[data-tone=warn]{color:var(--xp-warning,#B54708)}
    .xp-sec [hidden]{display:none!important}.xp-sec :focus-visible{outline:2px solid var(--xp-accent);outline-offset:2px}.xp-sec td bdi{unicode-bidi:isolate;overflow-wrap:anywhere}.xp-sec td .xp-sec__actions{gap:8px}
    @media(min-width:601px){.xp-sec__card{padding:var(--xp-space-card,24px)}}@media(max-width:900px){.xp-sec__fields--wide{grid-template-columns:minmax(0,1fr)}}@media(max-width:639px){.xp-sec__fields{grid-template-columns:minmax(0,1fr)}.xp-sec__actions>:is(button,a){flex:1 1 auto}}
    </style>
    ${bodies[page]}
  </section>`
}
