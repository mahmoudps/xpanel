import { actions, area, button, check, context, esc, facts, field, fields, help, inputControl, page, section, select, status, table, type WhmObservationInput } from '../monitoring/common.ts'

type PolicyPage = 'waf' | 'flood' | 'panel-access'
export function renderV2WhmSecurityPolicy(input: WhmObservationInput, kind: PolicyPage): string {
  const { t, canRead, canManage } = context(input)
  const number = (key: string, label: string, min: number, max: number) => field(t, `sec-${key}`, label, inputControl(`sec-${key}`, { 'data-sec-input': key }, false, ` dir="ltr" inputmode="numeric" min="${min}" max="${max}" step="1"`, 'number'))
  const textArea = (key: string, label: string, max: number, note: string) => field(t, `sec-${key}`, label, area(`sec-${key}`, { 'data-sec-input': key }, ` dir="ltr" rows="5" maxlength="${max}" autocomplete="off" spellcheck="false"`), note)
  const refresh = actions(button(t, msgid('Refresh'), { 'data-sec-action': 'refresh' }, canRead))
  const unread = status(t, canRead ? msgid('Nothing has been read yet.') : msgid('This page requires an authorized administrator. Nothing was read or changed.'), { 'data-sec-status': true }, canRead ? 'unread' : 'unavailable')
  const result = status(t, '', { 'data-sec-result': true }, 'unread', true)
  const save = actions(button(t, kind === 'panel-access' ? msgid('Save allowlists') : msgid('Save and apply'), { 'data-sec-action': 'save' }, false, true)) + result
  const saveHelp = help(t, msgid('Saving stores the policy and asks the server to apply it. The page then reads the running configuration again; only that read shows what is active.'))
  const body = kind === 'waf'
    ? section(t, 'waf-limits', msgid('Nginx web application firewall'), unread + refresh + help(t, msgid('Our own rules, applied at the edge before any request reaches Apache or an account.'))
      + facts(t, [['updated', msgid('Last saved (UTC)')], ['lists-active', msgid('Deny lists in the running configuration')], ['reconcile', msgid('Last apply request')]], 'data-sec-field')
      + fields(number('rate', msgid('Requests per address (req/s)'), 1, 10000) + number('burst', msgid('Burst (req)'), 0, 100000)) + check(t, msgid('Unlimited request rate'), { 'data-sec-input': 'rate-unlimited' })
      + help(t, msgid('Requests over the burst get 429. Each site gets its own per-address zone.'))
      + fields(number('body', msgid('Largest request body (MB)'), 1, 102400) + field(t, 'sec-denied', msgid('Answer for denied requests'), select(t, 'sec-denied', { 'data-sec-input': 'denied' }, [['403', msgid('403 Forbidden')], ['444', msgid('444 Close the connection')]])))
      + check(t, msgid('Unlimited request body'), { 'data-sec-input': 'body-unlimited' }) + help(t, msgid('Larger uploads get 413.'))
      + fields(textArea('deny-ips', msgid('Addresses and ranges'), 50000, msgid('One address or network per line, up to 1000.')) + textArea('deny-paths', msgid('Path patterns'), 26000, msgid('One PCRE pattern per line. Each pattern is compiled during nginx -t; a bad pattern keeps the previous generation.')) + textArea('deny-agents', msgid('User-agent patterns'), 26000, msgid('One PCRE pattern per line, matched without regard to case.')))
      + check(t, msgid('Use ModSecurity with the OWASP Core Rule Set when the Nginx connector is installed'), { 'data-sec-input': 'modsecurity' }) + saveHelp + save)
      + section(t, 'waf-modsecurity', msgid('ModSecurity with OWASP Core Rule Set'), status(t, msgid('Not read'), { 'data-sec-field': 'modsec-state', 'data-tone': 'neutral' })
        + facts(t, [['nginx-connector', msgid('Nginx connector')], ['apache-module', msgid('Apache module')], ['rule-engine', msgid('Rule engine (SecRuleEngine)')], ['crs-version', msgid('Core Rule Set version')], ['modsec-active', msgid('Active in the running configuration')], ['observed-at', msgid('Observed at (UTC)')]], 'data-sec-field')
        + help(t, msgid('The Core Rule Set is attached automatically once the ModSecurity module for Nginx is present. The rules above work without it.'))
        + `<p class="v2-muted" data-sec-install hidden>${esc(t(msgid('ModSecurity for Nginx is not installed on this server.')))} <a href="/whm/software/catalog">${esc(t(msgid('Install ModSecurity')))}</a></p>`)
    : kind === 'flood'
      ? section(t, 'flood-limits', msgid('Host firewall limits'), unread + refresh + help(t, msgid('nftables limits on the web ports, applied after established connections are accepted. SSH and the panel ports keep their own sign-in protection.'))
        + facts(t, [['updated', msgid('Last saved (UTC)')], ['reconcile', msgid('Last apply request')]], 'data-sec-field') + check(t, msgid('Turn on flood protection'), { 'data-sec-input': 'enabled' })
        + fields(number('conn', msgid('Connections per address'), 1, 100000) + number('ping', msgid('Ping requests per second'), 1, 10000) + number('rate', msgid('New connections per second per address'), 1, 100000) + number('burst', msgid('Burst (connections)'), 1, 100000))
        + help(t, msgid('Concurrent connections from one address to ports 80 and 443. Empty means no limit.')) + fields(number('web-conn', msgid('Concurrent requests per address in Nginx'), 1, 100000))
        + help(t, msgid('Applied to every site with limit_conn. Excess requests get 429.')) + saveHelp + save)
        + section(t, 'flood-kernel', msgid('Running firewall'), facts(t, [['kernel-state', msgid('State')], ['observed-at', msgid('Observed at (UTC)')]], 'data-sec-field')
          + table(t, msgid('Flood rules in the kernel'), [msgid('Limit'), msgid('Rules'), msgid('Tracked addresses')], { 'data-sec-rows': 'kernel' }, msgid('The running firewall has not been read.')))
      : section(t, 'access-connection', msgid('Your connection'), unread + refresh + facts(t, [['listener', msgid('Entry point')], ['address', msgid('Your address')], ['enforcement', msgid('Enforcement')], ['updated', msgid('Last saved (UTC)')]], 'data-sec-field')
        + help(t, msgid('Allowlists are checked on every request before sign-in, using the socket address or the address from a trusted proxy. An empty list allows every address.')))
        + section(t, 'access-lists', msgid('IP allowlists'), fields(textArea('xpanel', msgid('xPanel (port 2083)'), 30000, msgid('One address or network per line. Text after # is kept as a note.'))
          + textArea('xwhm', msgid('xWHM (port 2087)'), 30000, msgid('Root and reseller sign-in. A save that removes your current address is refused.'))
          + textArea('xmail', msgid('xMail (port 2096)'), 30000, msgid('Webmail sign-in for mailbox users.'))) + save)
        + section(t, 'access-other', msgid('Other access settings'), help(t, msgid('Panel port, secret entrance path, unauthenticated response, basic authentication and temporary sign-in links are not available here. The panel port is shown under Panel security.')))
  const titles = { waf: msgid('Web application firewall'), flood: msgid('Flood protection'), 'panel-access': msgid('Panel access') }
  return page(input, `/whm/security/${kind}`, titles[kind], msgctxt('theme:v2', 'Saved policy and its running host readback remain separate sources.'), body, { 'data-sec-workspace': true, 'data-sec-page': kind, 'data-sec-can-read': String(canRead), 'data-sec-can-manage': String(canManage) })
}
