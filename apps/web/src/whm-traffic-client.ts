import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
import type { TrafficReport } from '../../agent/src/traffic-monitor.ts'
export function readWhmTrafficView(raw: unknown): TrafficReport {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  const instant = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))
  const state = (v: unknown): boolean => ['read', 'partial', 'unavailable'].includes(String(v))
  const counts = (v: Record<string, unknown>): boolean => ['requests', 'receivedBytes', 'sentBytes', 'errors'].every(key => integer(v[key])) && Number(v.errors) <= Number(v.requests)
  const bad = (): never => { throw new Error('invalid_traffic_response') }
  if (!object(raw) || raw.scope !== 'server' || !instant(raw.observedAt) || !object(raw.interfaces) || !object(raw.http) || !object(raw.history) || raw.history.state !== 'unavailable' || raw.history.reason !== 'network_counters_not_recorded') return bad()
  const net = raw.interfaces, http = raw.http
  if (!state(net.state) || !integer(net.intervalMs) || net.intervalMs > 10000 || !integer(net.skipped) || !Array.isArray(net.items) || net.items.length > 256 || !state(http.state) || !Array.isArray(http.rows) || http.rows.length > 100 || !Array.isArray(http.accounts) || http.accounts.length > 32 || !['readSites', 'omittedRows', 'omittedSites', 'unavailableSites', 'skippedLines'].every(key => integer(http[key])) || typeof http.truncated !== 'boolean') return bad()
  for (const v of net.items) if (!object(v) || typeof v.name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(v.name) || (v.state === 'read' ? !integer(v.receivedBps) || !integer(v.sentBps) : v.state !== 'counter_reset' || v.receivedBps !== null || v.sentBps !== null)) return bad()
  if (net.state === 'unavailable' ? net.intervalMs !== 0 || net.skipped !== 0 || net.items.length > 0 : net.intervalMs < 500 || net.items.length === 0) return bad()
  if (net.state === 'read' && (net.skipped !== 0 || net.items.some(v => v.state !== 'read'))) return bad()
  for (const v of [...http.rows, ...http.accounts]) if (!object(v) || typeof v.account !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(v.account) || !counts(v)) return bad()
  for (const v of http.rows) if (typeof v.domain !== 'string' || v.domain.length > 253 || !/^[a-z0-9.-]+$/.test(v.domain)) return bad()
  if (http.from !== null && !instant(http.from) || http.to !== null && !instant(http.to) || (http.from === null) !== (http.to === null) || http.from !== null && Date.parse(String(http.from)) > Date.parse(String(http.to))) return bad()
  if (new Set(net.items.map(v => v.name)).size !== net.items.length || new Set(http.rows.map(v => v.domain)).size !== http.rows.length || new Set(http.accounts.map(v => v.account)).size !== http.accounts.length) return bad()
  if (net.state === 'unavailable' && net.items.length || http.state === 'unavailable' && (http.rows.length || http.accounts.length)) return bad()
  return raw as unknown as TrafficReport
}
function bindWhmTraffic(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
  document.querySelectorAll<HTMLElement>('[data-whm-traffic]').forEach(root => {
    if (root.dataset.canRead !== 'true' || root.closest('[data-readonly="true"],[data-wiring="unavailable"],fieldset:disabled')) return
    const refresh = root.querySelector<HTMLButtonElement>('[data-traffic-refresh]'), status = root.querySelector<HTMLElement>('[data-traffic-status]')
    if (!send || !refresh || !status) return
    let busy = false
    const table = (key: string, values: (string | number | null)[][], count: number): void => {
      const body = root.querySelector<HTMLTableSectionElement>('[data-traffic-table="' + key + '"]'); if (!body) return
      body.replaceChildren()
      if (!values.length) { const row = body.insertRow(), cell = row.insertCell(); cell.colSpan = count; cell.textContent = t('No observed rows'); return }
      for (const valuesRow of values) { const row = body.insertRow(); for (const value of valuesRow) { const cell = row.insertCell(), bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value === null ? t('Unavailable') : String(value); cell.append(bdi) } }
    }
    const load = async (): Promise<void> => {
      if (busy) return; busy = true; refresh.disabled = true; root.setAttribute('aria-busy', 'true'); status.textContent = t('Reading the network sample and logs…')
      try {
        const value = readWhmTrafficView(await send('GET', '/api/server/monitoring/traffic'))
        const observed = root.querySelector('[data-traffic-observed]'), interval = root.querySelector('[data-traffic-interval]'), coverage = root.querySelector('[data-traffic-coverage]')
        if (observed) observed.textContent = formatDisplayDateTime(value.observedAt)
        if (interval) interval.textContent = value.interfaces.state === 'unavailable' ? t('Unavailable') : value.interfaces.intervalMs + ' ms'
        table('interfaces', value.interfaces.items.map(v => [v.name, v.receivedBps, v.sentBps, v.state === 'read' ? t(msgctxt('whm-traffic-client', 'Observed')) : t('Counter reset')]), 4)
        table('domains', value.http.rows.map(v => [v.domain, v.account, v.requests, v.receivedBytes, v.sentBytes, v.errors]), 6)
        table('accounts', value.http.accounts.map(v => [v.account, v.requests, v.receivedBytes, v.sentBytes, v.errors]), 5)
        const h = value.http
        if (coverage) {
          const counts = { read: h.readSites, unavailable: h.unavailableSites, sites: h.omittedSites, rows: h.omittedRows, lines: h.skippedLines }
          coverage.textContent = h.truncated ? t('Read sites: {read}; unavailable: {unavailable}; omitted sites: {sites}; omitted rows: {rows}; skipped lines: {lines}; bounded tail, older entries omitted.', counts) : t('Read sites: {read}; unavailable: {unavailable}; omitted sites: {sites}; omitted rows: {rows}; skipped lines: {lines}.', counts)
          if (h.from && h.to) {
            const from = document.createElement('bdi'), to = document.createElement('bdi')
            from.dir = 'ltr'; to.dir = 'ltr'
            from.textContent = formatDisplayDateTime(h.from); to.textContent = formatDisplayDateTime(h.to)
            coverage.append(' ', from, ' — ', to)
          }
        }
        status.dataset.state = value.interfaces.state === 'read' && h.state === 'read' ? 'read' : 'partial'
        status.textContent = value.interfaces.state === 'unavailable' && h.state === 'unavailable' ? t('Traffic observations are unavailable.') : status.dataset.state === 'read' ? t('Traffic observations updated.') : t('Partial observation. Review unavailable interfaces and log coverage.')
      } catch { status.dataset.state = 'error'; status.textContent = t('Traffic could not be read. Retry when the host is available.') }
      finally { busy = false; refresh.disabled = false; root.removeAttribute('aria-busy') }
    }
    refresh.addEventListener('click', () => { void load() }); void load()
  })
}
export const WHM_TRAFFIC_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readWhmTrafficView=${readWhmTrafficView.toString()};return ${bindWhmTraffic.toString()};})()`
