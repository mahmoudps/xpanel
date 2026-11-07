import { VIEW_RECORD_HELPERS, cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction } from './workspace-view-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction
/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

export interface NginxProxyRuleRow { path: string; target: string; websocket: boolean; hostHeader: 'client' | 'upstream'; refusal: string | null }
export interface NginxProxyDomainView { domain: { name: string; account: string; siteType: string }; state: 'default' | 'saved' | 'invalid'; revision: string; limit: number; updatedAt: string | null; rules: NginxProxyRuleRow[]; reconcile?: string }
export interface NginxProxyAccountRow { id: string; username: string; primaryDomain: string; rules: number | null; cache: { state: string; revision: string; enabled: boolean | null; purgedAt: string | null } }
export interface NginxProxyOverview { accounts: NginxProxyAccountRow[]; domains: { name: string; account: string }[]; changed?: number; reconcile?: string | null }

/** Shape checks of the manager's replies; the API owns the rule grammar. */
export function readNginxProxyView(raw: unknown, kind: 'overview' | 'domain', expected = ''): NginxProxyOverview | NginxProxyDomainView {
  const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
  const bad = (): never => { throw new Error('invalid_nginx_proxy_view') }
  const revision = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
  const iso = (value: unknown): boolean => value === null || typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
  if (!object(raw)) return bad()
  if (kind === 'domain') {
    if (!object(raw.domain) || raw.domain.name !== expected || typeof raw.domain.account !== 'string' || typeof raw.domain.siteType !== 'string' || !['default', 'saved', 'invalid'].includes(raw.state) || !revision(raw.revision) || !iso(raw.updatedAt)
      || !Number.isSafeInteger(raw.limit) || !Array.isArray(raw.rules) || raw.rules.length > raw.limit || raw.rules.some((rule: unknown) => !object(rule) || typeof rule.path !== 'string' || typeof rule.target !== 'string'
        || typeof rule.websocket !== 'boolean' || !['client', 'upstream'].includes(rule.hostHeader) || !(rule.refusal === null || typeof rule.refusal === 'string'))) return bad()
    return raw as unknown as NginxProxyDomainView
  }
  if (!Array.isArray(raw.accounts) || !Array.isArray(raw.domains) || raw.domains.length > 100000 || raw.domains.some((item: unknown) => !object(item) || typeof item.name !== 'string' || typeof item.account !== 'string')
    || raw.accounts.some((item: unknown) => !object(item) || typeof item.username !== 'string' || typeof item.primaryDomain !== 'string' || !(item.rules === null || Number.isSafeInteger(item.rules)) || !object(item.cache) || !revision(item.cache.revision)
      || !(item.cache.enabled === null || typeof item.cache.enabled === 'boolean') || !iso(item.cache.purgedAt))) return bad()
  return raw as unknown as NginxProxyOverview
}

function bindWhmNginxProxy(askDialog: unknown, parse: typeof readNginxProxyView): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const confirm = typeof askDialog === 'function' ? askDialog as (options: Record<string, unknown>) => Promise<unknown> : null
  const REFUSED: Record<string, string> = {
    invalid: msgid('Use http:// or https://, a host and an optional port, without a path.'), loopback: msgid('A rule cannot reach this server through loopback.'),
    own_address: msgid('A rule cannot reach this server through its own address.'), panel_port: msgid('A rule cannot reach a panel or web backend port.'),
    forbidden_range: msgid('Link-local, multicast and mapped addresses are not available.'), resolver_unavailable: msgid('This server has no DNS resolver for named targets. Use the IP address.'),
    unresolved: msgid('The target host name could not be resolved.'), resolves_internal: msgid('The target host name resolves to this server or to an address that is not available.'),
    duplicate: msgid('This path already has a rule.'), too_many: msgid('This account has reached its rule limit.'), not_found: msgid('This rule is no longer saved. Read the rules again.'),
    domain_redirect: msgid('This domain redirects, and its redirect takes precedence over a proxy rule.'),
  }
  const APPLIED: Record<string, string> = {
    requested: msgid('Saved. The server is testing the configuration and applying it.'), failed: msgid('Saved, but the configuration test or apply failed; the previous configuration stays active.'),
    not_connected: msgid('Saved. No host agent is connected, so nothing is applied yet.'), unknown: msgid('Saved. Whether the server applied the change is unknown; read again later.'),
  }
  const note = (status: HTMLElement, state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
  const details = (error: unknown): Record<string, any> => { const value = error && typeof error === 'object' ? (error as Record<string, any>).details : null; return value && typeof value === 'object' ? value : {} }
  document.querySelectorAll<HTMLElement>('[data-nginx-proxy]').forEach(root => {
    if (root.dataset.npBound === 'true') return
    root.dataset.npBound = 'true'
    const domain = root.querySelector<HTMLSelectElement>('[data-np-domain]'), path = root.querySelector<HTMLInputElement>('[data-np-path]'), target = root.querySelector<HTMLInputElement>('[data-np-target]')
    const host = root.querySelector<HTMLSelectElement>('[data-np-host]'), websocket = root.querySelector<HTMLInputElement>('[data-np-websocket]'), add = root.querySelector<HTMLButtonElement>('[data-np-add]'), refresh = root.querySelector<HTMLButtonElement>('[data-np-refresh]')
    const error = root.querySelector<HTMLElement>('[data-np-error]'), status = root.querySelector<HTMLElement>('[data-np-status]'), rows = root.querySelector<HTMLElement>('[data-np-rows]'), count = root.querySelector<HTMLElement>('[data-np-count]')
    const filter = root.querySelector<HTMLInputElement>('[data-np-filter]'), accounts = root.querySelector<HTMLElement>('[data-np-accounts]'), cacheStatus = root.querySelector<HTMLElement>('[data-np-cache-status]')
    const allOn = root.querySelector<HTMLButtonElement>('[data-np-all-enable]'), allOff = root.querySelector<HTMLButtonElement>('[data-np-all-disable]'), allPurge = root.querySelector<HTMLButtonElement>('[data-np-all-purge]')
    if (!domain || !path || !target || !host || !websocket || !add || !refresh || !error || !status || !rows || !count || !filter || !accounts || !cacheStatus || !allOn || !allOff || !allPurge) return
    const admitted = (): boolean => root.isConnected && root.dataset.npManage === 'true' && !root.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled') && typeof transport === 'function'
    let overview: NginxProxyOverview | null = null, view: NginxProxyDomainView | null = null, busy = false, review = false
    const stamp = (iso: string): string => iso.slice(0, 10) + ' ' + iso.slice(11, 16) + ' UTC'
    const shown = (): NginxProxyAccountRow[] => {
      const query = filter.value.trim().toLowerCase()
      return (overview?.accounts ?? []).filter(row => !query || row.username.includes(query) || row.primaryDomain.includes(query))
    }
    const paint = (): void => {
      const ready = !busy && !review && admitted(), editable = ready && view !== null && view.state !== 'invalid'
      domain.disabled = !ready || !overview?.domains.length; refresh.disabled = busy || !admitted(); filter.disabled = !ready
      path.disabled = target.disabled = host.disabled = websocket.disabled = add.disabled = !editable
      for (const button of [allOn, allOff, allPurge]) button.disabled = !ready || !shown().length
      rows.textContent = ''
      for (const rule of view?.rules ?? []) {
        const row = cloneViewRecord(root, 'nginx-proxy-rule', 'tr', { path: rule.path, target: rule.target, host: rule.hostHeader === 'client' ? t('Visitor host name') : t('Target host name'), websocket: rule.websocket ? t('Yes') : t('No'),
          state: rule.refusal ? t(REFUSED[rule.refusal] ?? REFUSED.invalid!) : t('Admitted'), 'remove-label': t('Remove') })
        const remove = viewAction(row, 'remove'); remove.disabled = !editable
        remove.addEventListener('click', () => { void removeRule(rule.path) })
        rows.append(row)
      }
      if (!rows.childElementCount) rows.append(cloneViewRecord(root, 'nginx-proxy-empty', 'tr', { message: view ? t('This domain has no reverse proxy rules.') : t('Not read.') }))
      count.textContent = view ? t('{count, plural, one {# rule} other {# rules}} on this domain; {limit} per account', { count: view.rules.length, limit: view.limit }) : t('Not read')
      accounts.textContent = ''
      for (const item of shown()) {
        const cache = item.cache, on = cache.enabled
        const row = cloneViewRecord(root, 'nginx-proxy-account', 'tr', { account: item.username, domain: item.primaryDomain, rules: item.rules === null ? t('Needs review') : item.rules, cache: on === null ? t('Needs review') : on ? t('On') : t('Off'), purged: cache.purgedAt ? stamp(cache.purgedAt) : t('Never'), 'toggle-label': on === false ? t('Turn on') : t('Turn off'), 'purge-label': t('Purge') })
        const toggle = viewAction(row, 'toggle'), purge = viewAction(row, 'purge')
        toggle.disabled = !ready || on === null; purge.disabled = !ready || on !== true
        toggle.addEventListener('click', () => { void cacheChange(on === false ? 'enable' : 'disable', [item]) })
        purge.addEventListener('click', () => { void cacheChange('purge', [item]) })
        accounts.append(row)
      }
      if (!accounts.childElementCount) accounts.append(cloneViewRecord(root, 'nginx-proxy-empty', 'tr', { message: overview ? t('No accounts match.') : t('Not read.') }))
    }
    const loadDomain = async (name: string): Promise<void> => {
      view = parse(await transport!('GET', '/api/server/nginx-proxy/domains/' + encodeURIComponent(name)), 'domain', name) as NginxProxyDomainView
      note(status, view.state === 'invalid' ? 'failed' : 'read', view.state === 'invalid' ? t('The saved rules need review before they can change.') : t('The saved rules were read.'))
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; paint(); note(status, 'reading', t('Reading the reverse proxy rules…'))
      try {
        const next = parse(await transport!('GET', '/api/server/nginx-proxy'), 'overview') as NginxProxyOverview
        const keep = domain.value
        overview = next; review = false
        domain.replaceChildren()
        for (const item of next.domains) { const option = document.createElement('option'); option.value = item.name; option.textContent = item.name; domain.append(option) }
        if (next.domains.some(item => item.name === keep)) domain.value = keep
        note(cacheStatus, 'read', t('The cache settings were read.'))
        if (domain.value) await loadDomain(domain.value)
        else { view = null; note(status, 'empty', t('No domains are available.')) }
      } catch { view = null; note(status, 'failed', t('The reverse proxy rules could not be read. Nothing was changed.')) }
      finally { busy = false; paint() }
    }
    const refused = (reason: unknown, out: HTMLElement): void => {
      const info = details(reason), code = Array.isArray(info.fields) && typeof info.fields[0]?.code === 'string' ? info.fields[0].code as string : typeof info.reason === 'string' ? info.reason : null
      if (code && out === status) { error.textContent = t(REFUSED[code] ?? REFUSED.invalid!); error.hidden = false; note(out, 'fields', t('The change was refused. Nothing was saved.')) }
      else if ((reason as Record<string, any>)?.status === 409 || info.stateChanged !== false) { review = true; note(out, 'uncertain', t('The outcome needs review. No retry was sent. Read the page again before continuing.')) }
      else note(out, 'failed', t('The change was refused. Nothing was saved.'))
    }
    const save = async (body: Record<string, unknown>): Promise<void> => {
      if (busy || review || !view || !admitted()) return
      const name = view.domain.name
      busy = true; error.hidden = true; paint(); note(status, 'saving', t('Saving…'))
      try {
        view = parse(await transport!('POST', '/api/server/nginx-proxy/domains/' + encodeURIComponent(name), { expectedRevision: view.revision, ...body }), 'domain', name) as NginxProxyDomainView
        if ('add' in body) { path.value = ''; target.value = '' }
        note(status, view.reconcile === 'requested' ? 'saved' : 'warning', t(APPLIED[view.reconcile ?? 'unknown'] ?? APPLIED.unknown!))
      } catch (reason) { refused(reason, status) }
      finally { busy = false; paint() }
    }
    const removeRule = async (rulePath: string): Promise<void> => {
      if (confirm && await confirm({ title: t('Remove this rule?'), body: rulePath + '\n' + t('Requests for this path return to the site after the server applies the change.'), confirm: t('Remove'), danger: true }) !== true) return
      await save({ remove: rulePath })
    }
    const cacheChange = async (op: 'enable' | 'disable' | 'purge', items: NginxProxyAccountRow[]): Promise<void> => {
      if (busy || review || !overview || !items.length || !admitted()) return
      if (confirm && await confirm({ title: op === 'purge' ? t('Purge the cache?') : op === 'enable' ? t('Turn the cache on?') : t('Turn the cache off?'), body: t('{count, plural, one {# account} other {# accounts}}: {names}', { count: items.length, names: items.slice(0, 8).map(item => item.username).join(', ') }), confirm: op === 'purge' ? t('Purge') : op === 'enable' ? t('Turn on') : t('Turn off') }) !== true) return
      busy = true; paint(); note(cacheStatus, 'saving', t('Saving…'))
      try {
        const next = parse(await transport!('POST', '/api/server/nginx-proxy/cache', { op, accounts: items.map(item => ({ username: item.username, expectedRevision: item.cache.revision })) }), 'overview') as NginxProxyOverview
        overview = next
        note(cacheStatus, next.reconcile === 'requested' || next.changed === 0 ? 'saved' : 'warning', next.changed === 0 ? t('These accounts already have this setting.') : t(APPLIED[next.reconcile ?? 'unknown'] ?? APPLIED.unknown!))
      } catch (reason) { refused(reason, cacheStatus) }
      finally { busy = false; paint() }
    }
    if (!admitted()) { paint(); refresh.disabled = true; note(status, 'unavailable', t('The reverse proxy manager is unavailable here. Nothing was read or changed.')); return }
    websocket.checked = true
    domain.addEventListener('change', () => {
      if (busy || !domain.value) return
      busy = true; error.hidden = true; paint()
      void loadDomain(domain.value).catch(() => { view = null; note(status, 'failed', t('The reverse proxy rules could not be read. Nothing was changed.')) }).finally(() => { busy = false; paint() })
    })
    add.addEventListener('click', () => {
      if (!path.value.trim() || !target.value.trim()) { error.textContent = t('Enter a path and a target.'); error.hidden = false; return }
      void save({ add: { path: path.value.trim(), target: target.value.trim(), websocket: websocket.checked, hostHeader: host.value } })
    })
    refresh.addEventListener('click', () => { review = false; void load() })
    filter.addEventListener('input', paint)
    allOn.addEventListener('click', () => { void cacheChange('enable', shown()) })
    allOff.addEventListener('click', () => { void cacheChange('disable', shown()) })
    allPurge.addEventListener('click', () => { void cacheChange('purge', shown()) })
    void load()
  })
}
export const WHM_NGINX_PROXY_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const parse=${readNginxProxyView.toString()};const bind=${bindWhmNginxProxy.toString()};return (askDialog)=>bind(askDialog,parse);})()`
