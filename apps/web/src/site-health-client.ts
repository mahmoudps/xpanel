import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
const HEALTH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEALTH_CHECKS: Record<string, { fix: string; causes: string[] }> = {
  dns: { fix: '/domains/zone-editor', causes: ['matches', 'name_not_found', 'no_address', 'no_ipv4', 'points_elsewhere', 'ipv6_unexpected', 'ipv6_points_elsewhere', 'no_ipv6', 'extra_addresses', 'lookup_failed'] },
  http: { fix: '/metrics/logs', causes: ['reachable', 'client_error', 'server_error', 'redirect_site', 'site_unresolved', 'inactive_site', 'engine', 'probe_failed'] },
  certificate: { fix: '/security/ssl', causes: ['valid', 'expiring', 'expired', 'missing', 'invalid_record'] },
  php: { fix: '/software/php', causes: ['supported', 'unsupported', 'not_php', 'site_unresolved'] },
}
export interface SiteHealthCheck { id: string; state: 'ok' | 'problem' | 'unavailable'; cause: string; fix: string; detail: { status?: number; notAfter?: string; daysLeft?: number; version?: string | null; found?: { ipv4: string[]; ipv6: string[] }; expected?: { ipv4: string; ipv6: string | null } } }
export interface SiteHealthClientView { checkedAt: string; total: number; truncated: boolean; domains: { domainId: string; name: string; checks: SiteHealthCheck[] }[] }
export function healthObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
const healthText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const healthAddresses = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 64 && value.every(item => healthText(item, 64) && /^[0-9a-f.:]+$/i.test(item))
export function readSiteHealthView(value: unknown, accountId: string): SiteHealthClientView {
  if (!HEALTH_ID.test(accountId) || !healthObject(value) || !healthObject(value.context) || value.context.accountId !== accountId || !healthText(value.checkedAt, 64) || !Number.isFinite(Date.parse(value.checkedAt)) || !Array.isArray(value.domains) || value.domains.length > 20
    || typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < value.domains.length || typeof value.truncated !== 'boolean' || value.truncated !== value.total > value.domains.length) throw new Error('invalid_health_scope')
  const ids = new Set<string>()
  const domains = value.domains.map(raw => {
    if (!healthObject(raw) || typeof raw.domainId !== 'string' || !HEALTH_ID.test(raw.domainId) || ids.has(raw.domainId) || !healthText(raw.name, 253) || !/^[a-z0-9.-]+$/.test(raw.name) || !Array.isArray(raw.checks) || raw.checks.length !== 4) throw new Error('invalid_health_domain')
    ids.add(raw.domainId)
    const checks = raw.checks.map((check, index) => {
      const spec = HEALTH_CHECKS[Object.keys(HEALTH_CHECKS)[index]!]!
      if (!healthObject(check) || check.id !== Object.keys(HEALTH_CHECKS)[index] || !['ok', 'problem', 'unavailable'].includes(check.state as string) || !spec.causes.includes(check.cause as string) || check.fix !== spec.fix || !healthObject(check.detail)) throw new Error('invalid_health_check')
      const detail = check.detail, out: SiteHealthCheck['detail'] = {}
      if (detail.status !== undefined) { if (typeof detail.status !== 'number' || !Number.isInteger(detail.status) || detail.status < 100 || detail.status > 599) throw new Error('invalid_health_status'); out.status = detail.status }
      if (detail.notAfter !== undefined) { if (!healthText(detail.notAfter, 64) || !Number.isFinite(Date.parse(detail.notAfter)) || typeof detail.daysLeft !== 'number' || !Number.isSafeInteger(detail.daysLeft)) throw new Error('invalid_health_certificate'); out.notAfter = detail.notAfter; out.daysLeft = detail.daysLeft }
      if (detail.version !== undefined) { if (!(detail.version === null || healthText(detail.version, 16))) throw new Error('invalid_health_php'); out.version = detail.version as string | null }
      if (detail.found !== undefined) {
        const found = detail.found, expected = detail.expected
        if (!healthObject(found) || !healthAddresses(found.ipv4) || !healthAddresses(found.ipv6) || !healthObject(expected) || !healthText(expected.ipv4, 64) || !(expected.ipv6 === null || healthText(expected.ipv6, 64))) throw new Error('invalid_health_dns')
        out.found = { ipv4: found.ipv4, ipv6: found.ipv6 }; out.expected = { ipv4: expected.ipv4, ipv6: expected.ipv6 as string | null }
      }
      return { id: check.id as string, state: check.state as SiteHealthCheck['state'], cause: check.cause as string, fix: spec.fix, detail: out }
    })
    return { domainId: raw.domainId, name: raw.name, checks }
  })
  return { checkedAt: value.checkedAt, total: value.total, truncated: value.truncated, domains }
}

function bindSiteHealth(_askDialog: unknown): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-site-health]').forEach(root => {
    if (root.dataset.healthBound === 'true') return
    root.dataset.healthBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
    const accountId = root.dataset.account ?? ''
    const eligible = (): boolean => root.isConnected && root.dataset.healthManage === 'true' && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const find = <T extends HTMLElement>(key: string): T => root.querySelector<T>('[data-health-' + key + ']')!
    const run = find<HTMLButtonElement>('run'), rows = find('rows'), status = find('status')
    if (!run || !rows || !status || !find('at') || !find('count') || !find('problems')) return
    try {
      const preview = cloneClientTemplate(clientTemplate(root, 'site-health-result'), 'tr', ['domain', 'kind', 'state', 'detail', 'fix'])
      for (const [slot, tag] of [['domain', 'bdi'], ['kind', 'td'], ['state', 'span'], ['detail', 'td'], ['fix', 'td']]) clientTemplateSlot(preview, slot!, tag!)
      cloneClientTemplate(clientTemplate(root, 'site-health-fix'), 'a', ['label'])
      cloneClientTemplate(clientTemplate(root, 'site-health-empty'), 'tr', ['message'])
      cloneClientTemplate(clientTemplate(root, 'site-health-instant'), 'bdi', [])
    } catch {
      run.disabled = true; status.dataset.state = 'unavailable'; status.textContent = t('Site health checks are unavailable here. Nothing was checked.'); return
    }
    let busy = false
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const label = (id: string): string => ({ dns: t('DNS'), http: t('Website'), certificate: t('Certificate'), php: t('PHP') } as Record<string, string>)[id] ?? id
    const stateText = (state: string): string => state === 'ok' ? t('OK') : state === 'problem' ? t('Problem') : t('Not checked')
    const explain = (check: SiteHealthCheck): string | DocumentFragment => {
      const d = check.detail, http = d.status === undefined ? null : { status: d.status }, found = d.found ? [...d.found.ipv4, ...d.found.ipv6].join(', ') : ''
      if (check.id === 'certificate' && ['valid', 'expiring', 'expired'].includes(check.cause)) {
        const fragment = document.createDocumentFragment(), instant = cloneClientTemplate(clientTemplate(root, 'site-health-instant'), 'bdi', [])
         instant.textContent = formatDisplayDateTime(d.notAfter)
        const [before, after] = (check.cause === 'expiring' ? t('Expires in {days} days ({time}).', { days: d.daysLeft ?? '' }) : check.cause === 'valid' ? t('Valid until {time}.') : t('Expired on {time}.')).split('{time}')
        fragment.append(before ?? '', instant, after ?? '')
        return fragment
      }
      const text: Record<string, string> = {
        matches: t('Points to the address saved for this site.'), name_not_found: t('The name does not exist in DNS. Check the registration and nameservers.'),
        no_address: t('No A or AAAA record is published.'), no_ipv4: t('No A (IPv4) record is published.'),
        points_elsewhere: t('The A record points to another address: {addresses}', { addresses: found }), ipv6_unexpected: t('An AAAA record points to an address this site does not use, so IPv6 visitors reach another server: {addresses}', { addresses: found }),
        ipv6_points_elsewhere: t('The AAAA record points to another address: {addresses}', { addresses: found }), no_ipv6: t("No AAAA record is published for the site's IPv6 address."),
        extra_addresses: t('More addresses are published than this site uses; some visitors may reach another server: {addresses}', { addresses: found }), lookup_failed: t('The DNS lookup failed or timed out.'),
        reachable: http ? t('The home page answers (HTTP {status}).', http) : t('The home page answers.'),
        client_error: http ? t('The home page returns an error (HTTP {status}). Check the error log.', http) : t('The home page returns an error. Check the error log.'),
        server_error: http ? t('The site returns a server error (HTTP {status}). Check the error log.', http) : t('The site returns a server error. Check the error log.'),
        redirect_site: t('This domain redirects; the target is not checked here.'), site_unresolved: t('The saved site configuration could not be resolved.'),
        inactive_site: t('Only active PHP or static sites are checked.'), engine: t('The local check needs the Apache backend.'), probe_failed: t('The local check could not reach the site.'),

        missing: t('No saved certificate covers this name; visitors over HTTPS see a warning.'), invalid_record: t('The saved certificate has no readable expiry date.'),
        supported: t('PHP {version} is supported.', { version: d.version ?? '' }), unsupported: t('PHP {version} is not supported by this server. Choose a supported version.', { version: d.version ?? '' }), not_php: t('This site does not run PHP.'),
      }
      return text[check.cause] ?? ''
    }
    const paint = (view: SiteHealthClientView): void => {
      rows.textContent = ''
      let problems = 0
      for (const domain of view.domains) for (const check of domain.checks) {
        if (check.state === 'problem') problems++
        const row = cloneClientTemplate(clientTemplate(root, 'site-health-result'), 'tr', ['domain', 'kind', 'state', 'detail', 'fix'])
        clientTemplateSlot(row, 'domain', 'bdi').textContent = domain.name
        clientTemplateSlot(row, 'kind', 'td').textContent = label(check.id)
        const chip = clientTemplateSlot(row, 'state', 'span'); chip.dataset.stateChip = check.state; chip.textContent = stateText(check.state)
        clientTemplateSlot(row, 'detail', 'td').append(explain(check))
        const fix = clientTemplateSlot(row, 'fix', 'td')
        if (check.state === 'problem') { const link = cloneClientTemplate(clientTemplate(root, 'site-health-fix'), 'a', ['label']) as HTMLAnchorElement; link.href = check.fix + '?lang=' + document.documentElement.lang; clientTemplateSlot(link, 'label').textContent = t(msgctxt('site-health-client', 'Open')); link.setAttribute('aria-label', t('Fix {check}: {domain}', { check: label(check.id), domain: domain.name })); link.removeAttribute('aria-disabled'); link.removeAttribute('tabindex'); fix.append(link) } else fix.textContent = '-'
        rows.append(row)
      }
      if (!view.domains.length) { const row = cloneClientTemplate(clientTemplate(root, 'site-health-empty'), 'tr', ['message']); clientTemplateSlot(row, 'message', 'td').textContent = t('This account has no domains to check.'); rows.append(row) }
      find('at').textContent = formatDisplayDateTime(view.checkedAt); find('count').textContent = String(view.domains.length) + (view.truncated ? ' / ' + String(view.total) : ''); find('problems').textContent = String(problems)
    }
    async function check(): Promise<void> {
      if (!eligible() || busy || !send) return
      busy = true; run.disabled = true; root.setAttribute('aria-busy', 'true'); note('reading', t('Running checks…'))
      try { const view = readSiteHealthView(await send('GET', '/api/account/site-health'), accountId); paint(view); note('read', view.truncated ? t('Checks finished for the first 20 domains.') : t('Checks finished.')) }
      catch { note('failed', t('The checks could not be completed. Nothing was changed.')) }
      finally { busy = false; run.disabled = !eligible(); root.setAttribute('aria-busy', 'false') }
    }
    if (!send || !eligible() || !HEALTH_ID.test(accountId)) { run.disabled = true; note('unavailable', t('Site health checks are unavailable here. Nothing was checked.')); return }
    run.addEventListener('click', () => { void check() })
  })
}

export const SITE_HEALTH_CLIENT_BINDING = `(()=>{const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const HEALTH_ID=${HEALTH_ID.toString()};const HEALTH_CHECKS=${JSON.stringify(HEALTH_CHECKS)};const healthObject=${healthObject.toString()};const healthText=${healthText.toString()};const healthAddresses=${healthAddresses.toString()};const readSiteHealthView=${readSiteHealthView.toString()};return ${bindSiteHealth.toString()};})()`
