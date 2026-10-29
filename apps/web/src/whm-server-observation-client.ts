/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
type Section<T> = { state: 'read' | 'unavailable'; reason: string | null; truncated: boolean; items: T[] }
type Fact<T> = { state: 'read' | 'absent' | 'unavailable'; reason: string | null; value: T }
export type ServerTimerView = { unit: string; activates: string[]; next: string | null; last: string | null; owner: { kind: 'account-cron'; username: string; jobId: string } | { kind: 'panel' } | { kind: 'system' } }
export type ServerTimersView = { observedAt: string; timers: Section<ServerTimerView>; cronDirectory: { state: 'read' | 'absent' | 'unavailable'; reason: string | null; truncated: boolean; unlisted: number; items: { name: string; kind: 'file' | 'other' }[] } }
export type ServerInterfaceView = { name: string; operstate: string; mtu: number | null; loopback: boolean; addresses: { family: 4 | 6; address: string; prefixLength: number; scope: string; dynamic: boolean }[] }
export type ServerRouteView = { family: 4 | 6; destination: string; gateway: string | null; device: string | null; protocol: string | null; metric: number | null; type: string | null; nexthops: { gateway: string | null; device: string | null }[] }
export type ServerNetworkView = {
  observedAt: string; hostname: Fact<string | null>; resolvers: Fact<string[]> & { truncated: boolean }; interfaces: Section<ServerInterfaceView>; routes4: Section<ServerRouteView>; routes6: Section<ServerRouteView>
  saved: { state: 'read' | 'not-set-up'; hostname: string | null }; hostnameComparison: 'match' | 'short-name' | 'differs' | 'unverified'
  pool: { address: string; interfaceName: string; role: string; isPrimary: boolean; status: 'configured' | 'other-interface' | 'missing' | 'unverified'; observedInterface: string | null }[]
  unpooled: { address: string; prefixLength: number; interface: string }[] | null
}
export type ServerRoleView = {
  observedAt: string; services: Section<{ id: string; label: string; unit: string | null; state: string }>
  saved: { state: 'read' | 'not-set-up'; hostname: string | null; engine: string | null; apacheMpm: string | null; setupCompletedAt: string | null; phpVersions: string[]; counts: Record<'accounts' | 'domains' | 'phpDomains' | 'mailboxes' | 'databases' | 'zones', number> }
  components: { id: string; value: string | null; count: number | null; services: string[] }[]
}

// Serialized into the page binding by name; keep them free of outer references.
function soObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function soFail(): never { throw new Error('invalid_server_observation') }
function soText(value: unknown, max = 255): string { return typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/.test(value) ? value : soFail() }
function soNullable<T>(value: unknown, read: (raw: unknown) => T): T | null { return value === null ? null : read(value) }
function soIso(value: unknown): string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : soFail() }
function soCount(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : soFail() }
function soList<T>(value: unknown, limit: number, item: (raw: unknown) => T): T[] { return Array.isArray(value) && value.length <= limit ? value.map(item) : soFail() }
function soOneOf<T extends string>(value: unknown, allowed: readonly T[]): T { return allowed.includes(value as T) ? value as T : soFail() }
function soSection<T>(value: unknown, limit: number, item: (raw: unknown) => T): Section<T> {
  if (!soObject(value) || typeof value.truncated !== 'boolean') return soFail()
  const state = soOneOf(value.state, ['read', 'unavailable'] as const), items = soList(value.items, limit, item)
  if (state === 'read' ? value.reason !== null : typeof value.reason !== 'string' || items.length || value.truncated) return soFail()
  return { state, reason: value.reason as string | null, truncated: value.truncated, items }
}

/** Strict reader for GET /api/server/server-observation/timers; unknown fields are dropped. */
export function readServerTimersView(value: unknown): ServerTimersView {
  if (!soObject(value) || !soObject(value.cronDirectory) || typeof value.cronDirectory.truncated !== 'boolean') return soFail()
  const timers = soSection(value.timers, 2000, raw => {
    if (!soObject(raw) || !soObject(raw.owner)) return soFail()
    const kind = soOneOf(raw.owner.kind, ['account-cron', 'panel', 'system'] as const)
    const owner = kind === 'account-cron' ? { kind, username: soText(raw.owner.username, 16), jobId: soText(raw.owner.jobId, 32) } : { kind }
    return { unit: soText(raw.unit), activates: soList(raw.activates, 16, item => soText(item)), next: soNullable(raw.next, soIso), last: soNullable(raw.last, soIso), owner } as ServerTimerView
  })
  const cron = value.cronDirectory, state = soOneOf(cron.state, ['read', 'absent', 'unavailable'] as const)
  const items = soList(cron.items, 512, raw => soObject(raw) ? { name: soText(raw.name, 128), kind: soOneOf(raw.kind, ['file', 'other'] as const) } : soFail())
  if (state !== 'read' && items.length) return soFail()
  return { observedAt: soIso(value.observedAt), timers, cronDirectory: { state, reason: cron.reason === null ? null : soText(cron.reason, 32), truncated: cron.truncated as boolean, unlisted: soCount(cron.unlisted), items } }
}

/** Strict reader for GET /api/server/server-observation/network including the saved-pool comparison. */
export function readServerNetworkView(value: unknown): ServerNetworkView {
  if (!soObject(value) || !soObject(value.hostname) || !soObject(value.resolvers) || typeof value.resolvers.truncated !== 'boolean' || !soObject(value.saved)) return soFail()
  const fact = <T>(raw: Record<string, unknown>, read: (item: unknown) => T): Fact<T> => ({ state: soOneOf(raw.state, ['read', 'absent', 'unavailable'] as const), reason: raw.reason === null ? null : soText(raw.reason, 32), value: read(raw.value) })
  const route = (family: 4 | 6) => (raw: unknown): ServerRouteView => {
    if (!soObject(raw) || raw.family !== family) return soFail()
    const device = (item: unknown) => soNullable(item, entry => soText(entry, 15))
    return { family, destination: soText(raw.destination, 64), gateway: soNullable(raw.gateway, item => soText(item, 64)), device: device(raw.device), protocol: soNullable(raw.protocol, item => soText(item, 32)),
      metric: soNullable(raw.metric, soCount), type: soNullable(raw.type, item => soText(item, 32)), nexthops: soList(raw.nexthops, 16, hop => soObject(hop) ? { gateway: soNullable(hop.gateway, item => soText(item, 64)), device: device(hop.device) } : soFail()) }
  }
  return {
    observedAt: soIso(value.observedAt), hostname: fact(value.hostname, raw => soNullable(raw, item => soText(item, 253))),
    resolvers: { ...fact(value.resolvers, raw => soList(raw, 16, item => soText(item, 64))), truncated: value.resolvers.truncated },
    interfaces: soSection(value.interfaces, 256, raw => soObject(raw) && typeof raw.loopback === 'boolean' ? { name: soText(raw.name, 15), operstate: soText(raw.operstate, 24), mtu: soNullable(raw.mtu, soCount), loopback: raw.loopback,
      addresses: soList(raw.addresses, 256, item => soObject(item) && typeof item.dynamic === 'boolean' ? { family: soOneOf(String(item.family), ['4', '6'] as const) === '4' ? 4 as const : 6 as const, address: soText(item.address, 64), prefixLength: soCount(item.prefixLength), scope: soText(item.scope, 32), dynamic: item.dynamic } : soFail()) } : soFail()),
    routes4: soSection(value.routes4, 2048, route(4)), routes6: soSection(value.routes6, 2048, route(6)),
    saved: { state: soOneOf(value.saved.state, ['read', 'not-set-up'] as const), hostname: soNullable(value.saved.hostname, item => soText(item, 253)) },
    hostnameComparison: soOneOf(value.hostnameComparison, ['match', 'short-name', 'differs', 'unverified'] as const),
    pool: soList(value.pool, 4096, raw => soObject(raw) && typeof raw.isPrimary === 'boolean' ? { address: soText(raw.address, 64), interfaceName: soText(raw.interfaceName, 64), role: soText(raw.role, 32), isPrimary: raw.isPrimary,
      status: soOneOf(raw.status, ['configured', 'other-interface', 'missing', 'unverified'] as const), observedInterface: soNullable(raw.observedInterface, item => soText(item, 15)) } : soFail()),
    unpooled: soNullable(value.unpooled, raw => soList(raw, 65536, item => soObject(item) ? { address: soText(item.address, 64), prefixLength: soCount(item.prefixLength), interface: soText(item.interface, 15) } : soFail())),
  }
}

/** Strict reader for GET /api/server/server-observation/role; desired and observed parts stay separate. */
export function readServerRoleView(value: unknown): ServerRoleView {
  if (!soObject(value) || !soObject(value.saved) || !soObject(value.saved.counts)) return soFail()
  const saved = value.saved, counts = saved.counts as Record<string, unknown>
  return {
    observedAt: soIso(value.observedAt),
    services: soSection(value.services, 64, raw => soObject(raw) ? { id: soText(raw.id, 32), label: soText(raw.label, 64), unit: soNullable(raw.unit, item => soText(item)), state: soOneOf(raw.state, ['active', 'inactive', 'failed', 'not-installed', 'unchecked'] as const) } : soFail()),
    saved: { state: soOneOf(saved.state, ['read', 'not-set-up'] as const), hostname: soNullable(saved.hostname, item => soText(item, 253)), engine: soNullable(saved.engine, item => soText(item, 32)), apacheMpm: soNullable(saved.apacheMpm, item => soText(item, 32)),
      setupCompletedAt: soNullable(saved.setupCompletedAt, soIso), phpVersions: soList(saved.phpVersions, 64, item => soText(item, 16)),
      counts: { accounts: soCount(counts.accounts), domains: soCount(counts.domains), phpDomains: soCount(counts.phpDomains), mailboxes: soCount(counts.mailboxes), databases: soCount(counts.databases), zones: soCount(counts.zones) } },
    components: soList(value.components, 16, raw => soObject(raw) ? { id: soText(raw.id, 32), value: soNullable(raw.value, item => soText(item, 255)), count: soNullable(raw.count, soCount), services: soList(raw.services, 8, item => soText(item, 32)) } : soFail()),
  }
}

function bindWhmServerObservation(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
  const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const reasons: Record<string, string> = {
    host_unavailable: t('The host agent cannot read this on this server.'), command_failed: t('The host command did not return a result.'),
    output_limit: t('The host output exceeded the bounded read size.'), malformed_output: t('The host output could not be parsed, so nothing is shown.'),
    unreadable: t('The host file could not be read.'),
  }
  const reason = (code: string | null): string => reasons[code ?? ''] ?? reasons.command_failed!
  document.querySelectorAll<HTMLElement>('[data-whm-server-observation]').forEach(root => {
    if (root.dataset.serverObservationBound === 'true') return
    root.dataset.serverObservationBound = 'true'
    const kind = root.dataset.whmServerObservation ?? ''
    const status = root.querySelector<HTMLElement>('[data-whm-server-observation-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-whm-server-observation-refresh]')
    if (!status || !refresh || !['timers', 'network', 'role'].includes(kind)) return
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.serverObservationCanRead === 'true' && !root.closest(denied)
    const note = (state: string, message: string, target: HTMLElement | null = status): void => { if (!target) return; target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    if (!admitted()) {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button').forEach(control => { control.disabled = true })
      note('unavailable', t('Server observation is unavailable here. Nothing was read or changed.'))
      return
    }
    const fact = (name: string, value: string): void => { const node = root.querySelector('[data-whm-server-observation-' + name + ']'); if (node) node.textContent = value }
    const body = (marker: string): HTMLElement | null => root.querySelector<HTMLElement>('[data-whm-server-observation-' + marker + ']')
    const technical = (value: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; return bdi }
    const row = (target: HTMLElement, cells: (string | Node | (string | Node)[])[], numeric: number[] = []): HTMLTableRowElement => {
      const tr = document.createElement('tr')
      cells.forEach((content, index) => { const td = document.createElement('td'); if (numeric.includes(index)) td.dataset.numeric = ''; td.append(...(Array.isArray(content) ? content : [content])); tr.append(td) })
      target.append(tr); return tr
    }
    const fill = (marker: string, empty: string, paint: (target: HTMLElement) => number): void => {
      const target = body(marker)
      if (!target) return
      target.replaceChildren()
      if (paint(target) === 0) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = target.closest('table')?.querySelectorAll('thead th').length ?? 1; td.textContent = empty; tr.append(td); target.append(tr) }
    }
    const path = '/api/server/server-observation/' + kind
    let busy = false, timers: ServerTimersView | null = null
    const owner = root.querySelector<HTMLSelectElement>('[data-whm-server-observation-owner]'), search = root.querySelector<HTMLInputElement>('[data-whm-server-observation-search]')
    const paintTimers = (): void => {
      const view = timers
      if (!view) return
      const filter = owner?.value ?? '', needle = (search?.value ?? '').trim().toLowerCase(), owners: Record<string, string> = { system: t('System'), panel: t('Panel'), 'account-cron': t('Account cron') }
      fact('observed-at', formatDisplayDateTime(view.observedAt))
      fact('timer-total', view.timers.state === 'read' ? String(view.timers.items.length) + (view.timers.truncated ? '+' : '') : t('Not read'))
      fact('timer-panel', view.timers.state === 'read' ? String(view.timers.items.filter(item => item.owner.kind === 'panel').length) : t('Not read'))
      fact('timer-account', view.timers.state === 'read' ? String(view.timers.items.filter(item => item.owner.kind === 'account-cron').length) : t('Not read'))
      fill('timer-rows', view.timers.state !== 'read' ? reason(view.timers.reason) : view.timers.items.length ? t('No timers match the filters.') : t('No timers are loaded.'), target => {
        const shown = view.timers.items.filter(item => (!filter || item.owner.kind === filter) && (!needle || item.unit.toLowerCase().includes(needle) || item.activates.some(unit => unit.toLowerCase().includes(needle))))
        for (const item of shown) row(target, [technical(item.unit), item.owner.kind === 'account-cron' ? [owners['account-cron']! + ' · ', technical(item.owner.username)] : owners[item.owner.kind]!, item.activates.length ? technical(item.activates.join(', ')) : t(msgctxt('whm-server-observation-client', 'None reported')),
          technical(item.next ? formatDisplayDateTime(item.next) : '-'), technical(item.last ? formatDisplayDateTime(item.last) : t('Never'))])
        return shown.length
      })
      const cron = view.cronDirectory
      note(cron.state === 'read' ? 'read' : cron.state, cron.state === 'read' ? cron.truncated && cron.unlisted ? t('Entries listed: {count} (more not shown); entries with unsupported names: {unlisted}', { count: cron.items.length, unlisted: cron.unlisted })
        : cron.truncated ? t('Entries listed: {count} (more not shown)', { count: cron.items.length }) : cron.unlisted ? t('Entries listed: {count}; entries with unsupported names: {unlisted}', { count: cron.items.length, unlisted: cron.unlisted }) : t('Entries listed: {count}', { count: cron.items.length })
        : cron.state === 'absent' ? t('/etc/cron.d does not exist on this host.') : reason(cron.reason), body('cron-status'))
      fill('cron-rows', cron.state === 'read' ? t('The directory is empty.') : t('No entries are shown.'), target => { for (const item of cron.items) row(target, [technical(item.name), item.kind === 'file' ? t('Regular file') : t('Other entry')]); return cron.items.length })
    }
    const paintNetwork = (view: ServerNetworkView): void => {
      const comparison: Record<string, string> = { match: t('Matches the saved hostname'), 'short-name': t('Short form of the saved hostname'), differs: t('Differs from the saved hostname'), unverified: t('Not compared') }
      const drift: Record<string, string> = { configured: t('Configured on the saved interface'), 'other-interface': t('Configured on another interface'), missing: t('Not configured on any interface (drift)'), unverified: t(msgctxt('whm-server-observation-client', 'Not verified')) }
      fact('observed-at', formatDisplayDateTime(view.observedAt))
      fact('static-hostname', view.hostname.state === 'read' ? view.hostname.value ?? t('Empty') : view.hostname.state === 'absent' ? t('File absent') : reason(view.hostname.reason))
      fact('saved-hostname', view.saved.hostname ?? t('Not saved'))
      fact('hostname-comparison', comparison[view.hostnameComparison]!)
      fact('resolvers', view.resolvers.state === 'read' ? view.resolvers.value.length ? view.resolvers.value.join(', ') + (view.resolvers.truncated ? ' +' : '') : t('None listed') : view.resolvers.state === 'absent' ? t('File absent') : reason(view.resolvers.reason))
      fill('interface-rows', view.interfaces.state === 'read' ? t('No interfaces were reported.') : reason(view.interfaces.reason), target => {
        for (const item of view.interfaces.items) row(target, [technical(item.name), technical(item.operstate + (item.loopback ? ' · loopback' : '')), technical(item.mtu === null ? '-' : String(item.mtu)),
          item.addresses.length ? technical(item.addresses.map(entry => entry.address + '/' + entry.prefixLength + ' ' + entry.scope).join(', ')) : t('No addresses')], [2])
        return view.interfaces.items.length
      })
      fill('pool-rows', view.saved.state === 'read' || view.pool.length ? t('The saved IP pool is empty.') : t('Server setup has not been saved.'), target => {
        for (const item of view.pool) row(target, [technical(item.address), technical(item.interfaceName), [technical(item.role), ...(item.isPrimary ? [' · ' + t('Primary')] : [])], item.observedInterface ? technical(item.observedInterface) : '-', drift[item.status]!]).dataset.whmServerObservationDrift = item.status
        return view.pool.length
      })
      fill('unpooled-rows', view.unpooled === null ? reason(view.interfaces.reason) : t('Every global address is in the pool.'), target => {
        for (const item of view.unpooled ?? []) row(target, [technical(item.address), technical(item.interface), technical(String(item.prefixLength))], [2])
        return view.unpooled?.length ?? 0
      })
      const routes = [view.routes4, view.routes6]
      fill('route-rows', routes.every(item => item.state === 'read') ? t('No routes were reported.') : routes.map(item => item.state === 'read' ? '' : reason(item.reason)).filter(Boolean).join(' '), target => {
        for (const item of routes.flatMap(section => section.items)) {
          const gateways = item.nexthops.length ? item.nexthops.map(hop => (hop.gateway ?? '-') + (hop.device ? ' ' + hop.device : '')).join(', ') : item.gateway ?? '-'
          row(target, [technical('IPv' + item.family), technical(item.destination + (item.type ? ' (' + item.type + ')' : '')), technical(gateways), technical(item.device ?? '-'), technical(item.protocol ?? '-'), technical(item.metric === null ? '-' : String(item.metric))], [5])
        }
        return routes.reduce((sum, section) => sum + section.items.length, 0)
      })
    }
    const paintRole = (view: ServerRoleView): void => {
      const states: Record<string, string> = { active: t(msgctxt('whm-server-observation-client', 'Running')), inactive: t('Stopped'), failed: t(msgctxt('whm-server-observation-client', 'Failed')), 'not-installed': t('Not installed'), unchecked: t(msgctxt('whm-server-observation-client', 'Not checked')) }
      const components: Record<string, string> = { 'web-edge': t('Web edge'), 'web-backend': t('Web backend'), php: 'PHP', mail: t('Mail'), dns: 'DNS', database: t('Databases') }
      const counted: Record<string, string> = { php: msgid('PHP domains: {count}'), mail: msgid('Mailboxes: {count}'), dns: msgid('DNS zones: {count}'), database: msgid('Databases: {count}') }
      const saved = view.saved, none = t('Not saved')
      fact('saved-hostname', saved.hostname ?? none)
      fact('engine', saved.engine ? saved.engine + (saved.apacheMpm ? ' mpm-' + saved.apacheMpm : '') : none)
      fact('setup-completed', saved.setupCompletedAt ? formatDisplayDateTime(saved.setupCompletedAt) : t('Not completed'))
      fact('php-versions', saved.phpVersions.length ? saved.phpVersions.join(', ') : t('None in use'))
      for (const key of ['accounts', 'domains', 'mailboxes', 'databases', 'zones'] as const) fact('count-' + key, String(saved.counts[key]))
      fact('observed-at', formatDisplayDateTime(view.observedAt))
      const observed = new Map(view.services.items.map(item => [item.id, item]))
      fill('component-rows', t('No components were returned.'), target => {
        for (const item of view.components) {
          const desired: (string | Node)[] = [...(item.value ? [technical(item.value)] : []), ...(item.count !== null ? [(item.value ? ' · ' : '') + (counted[item.id] ? t(counted[item.id]!, { count: item.count }) : String(item.count))] : [])]
          const services = view.services.state !== 'read' ? t(msgctxt('whm-server-observation-client', 'Not observed')) : !item.services.length ? t('No reviewed service probe')
            : item.services.map(id => { const service = observed.get(id); return (service?.label ?? id) + ': ' + (service ? states[service.state] ?? service.state : t(msgctxt('whm-server-observation-client', 'Not observed'))) }).join('; ')
          row(target, [components[item.id] ?? item.id, desired.length ? desired : none, services])
        }
        return view.components.length
      })
      fill('service-rows', view.services.state === 'read' ? t('No services were reported.') : reason(view.services.reason), target => {
        for (const item of view.services.items) row(target, [item.label, item.unit ? technical(item.unit) : '-', states[item.state] ?? item.state])
        return view.services.items.length
      })
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; refresh.disabled = true; root.setAttribute('aria-busy', 'true')
      note('reading', t('Reading from the host…'))
      try {
        const raw = await transport!('GET', path)
        if (!admitted()) return
        if (kind === 'timers') {
          timers = readServerTimersView(raw); paintTimers()
          note(timers.timers.state === 'read' ? 'read' : 'unavailable', timers.timers.state === 'read' ? t('Timers read from systemd.') : reason(timers.timers.reason))
        } else if (kind === 'network') {
          const view = readServerNetworkView(raw); paintNetwork(view)
          const parts = [view.hostname.state === 'unavailable', view.resolvers.state === 'unavailable', view.interfaces.state !== 'read', view.routes4.state !== 'read', view.routes6.state !== 'read']
          note(parts.every(Boolean) ? 'unavailable' : parts.some(Boolean) ? 'partial' : 'read', parts.every(Boolean) ? reason(view.interfaces.reason) : parts.some(Boolean) ? t('Some sections could not be read; they are marked unavailable.') : t('Network configuration read from the host.'))
        } else {
          const view = readServerRoleView(raw); paintRole(view)
          note(view.services.state === 'read' ? 'read' : 'partial', view.services.state === 'read' ? t('Saved role and observed services read.') : t('Saved role read. Observed services: {reason}', { reason: reason(view.services.reason) }))
        }
      } catch { if (admitted()) note('failed', t('The observation could not be read. Any values shown are from the last successful read.')) }
      finally { busy = false; refresh.disabled = !admitted(); root.setAttribute('aria-busy', 'false') }
    }
    owner?.addEventListener('change', paintTimers)
    search?.addEventListener('input', paintTimers)
    refresh.addEventListener('click', () => { void load() })
    void load()
  })
}

export const WHM_SERVER_OBSERVATION_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};${[soObject, soFail, soText, soNullable, soIso, soCount, soList, soOneOf, soSection].map(helper => helper.toString()).join(';')};const readServerTimersView=${readServerTimersView.toString()};const readServerNetworkView=${readServerNetworkView.toString()};const readServerRoleView=${readServerRoleView.toString()};return ${bindWhmServerObservation.toString()};})()`
