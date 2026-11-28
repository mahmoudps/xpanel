import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import { ASCII_BYTES_BINDING, formatIsolatedBytes as canonicalFormatTrafficBytes } from './display-format.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatTrafficDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

const formatTrafficBytes = canonicalFormatTrafficBytes
const formatTrafficDateTime = canonicalFormatTrafficDateTime

type TrafficTransport = (method: string, path: string, body?: unknown) => Promise<unknown>
type TrafficAskDialog = (options: Record<string, unknown>) => Promise<unknown>

export interface AccountTrafficMonitorClientView {
  context: { username: string; domain: string | null; domains: string[] }
  state: 'read' | 'no_domains'
  observedAt: string
  summary: {
    totalRequests: number
    uniqueVisitors: number
    totalBytes: number
    error5xx: number
    truncated: boolean
    unparsedLines: number
    fileExists: boolean
  } | null
  dailyVisitors: { date: string; uniqueVisitors: number; requests: number; bytes: number }[]
  recentRequests: { time: string; method: string; path: string; status: number; bytes: number; ip: string; agent: string }[]
  topUserAgents: { agent: string; requests: number; bytes: number }[]
  topClientIps: { ip: string; requests: number; bytes: number; errors: number; blocked: boolean }[]
  ipBlocker: { available: boolean; revision: string; blockedCount: number }
}

/** Strict reader for GET /api/account/traffic-monitor responses. */
export function readAccountTrafficMonitorView(raw: unknown, expectedDomain?: string): AccountTrafficMonitorClientView {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
  const text = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length <= max && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(value)
  const iso = (value: unknown): value is string => text(value, 40) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
  const bad = (): never => { throw new Error('invalid_account_traffic_monitor') }

  if (!object(raw) || !object(raw.context) || !text(raw.context.username, 32) || !Array.isArray(raw.context.domains) || raw.context.domains.length > 500
    || !raw.context.domains.every(item => text(item, 253))
    || !(raw.context.domain === null || text(raw.context.domain, 253))
    || (expectedDomain && raw.context.domain !== null && raw.context.domain.toLowerCase() !== expectedDomain.toLowerCase())
    || !['read', 'no_domains'].includes(String(raw.state))
    || !iso(raw.observedAt)
    || !object(raw.ipBlocker) || typeof raw.ipBlocker.available !== 'boolean'
    || typeof raw.ipBlocker.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.ipBlocker.revision)
    || !integer(raw.ipBlocker.blockedCount)) {
    return bad()
  }
  if (raw.state === 'no_domains') {
    if (raw.summary !== null || !Array.isArray(raw.dailyVisitors) || raw.dailyVisitors.length !== 0
      || !Array.isArray(raw.recentRequests) || raw.recentRequests.length !== 0
      || !Array.isArray(raw.topUserAgents) || raw.topUserAgents.length !== 0
      || !Array.isArray(raw.topClientIps) || raw.topClientIps.length !== 0) return bad()
    return raw as unknown as AccountTrafficMonitorClientView
  }
  if (!object(raw.summary) || !integer(raw.summary.totalRequests) || !integer(raw.summary.uniqueVisitors)
    || !integer(raw.summary.totalBytes) || !integer(raw.summary.error5xx)
    || typeof raw.summary.truncated !== 'boolean' || !integer(raw.summary.unparsedLines)
    || typeof raw.summary.fileExists !== 'boolean') return bad()

  if (!Array.isArray(raw.dailyVisitors) || raw.dailyVisitors.length > 31) return bad()
  for (const row of raw.dailyVisitors) {
    if (!object(row) || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
      || !integer(row.uniqueVisitors) || !integer(row.requests) || !integer(row.bytes)) return bad()
  }
  if (!Array.isArray(raw.recentRequests) || raw.recentRequests.length > 50) return bad()
  for (const row of raw.recentRequests) {
    if (!object(row) || !text(row.time, 64) || !text(row.method, 16) || !text(row.path, 512)
      || !integer(row.status, 100) || row.status > 599 || !integer(row.bytes)
      || !text(row.ip, 64) || !text(row.agent, 256)) return bad()
  }
  if (!Array.isArray(raw.topUserAgents) || raw.topUserAgents.length > 20) return bad()
  for (const row of raw.topUserAgents) {
    if (!object(row) || !text(row.agent, 256) || !integer(row.requests) || !integer(row.bytes)) return bad()
  }
  if (!Array.isArray(raw.topClientIps) || raw.topClientIps.length > 20) return bad()
  for (const row of raw.topClientIps) {
    if (!object(row) || !text(row.ip, 64) || !integer(row.requests) || !integer(row.bytes)
      || !integer(row.errors) || typeof row.blocked !== 'boolean') return bad()
  }
  return raw as unknown as AccountTrafficMonitorClientView
}

function bindAccountTrafficMonitor(
  askDialog: TrafficAskDialog | undefined,
  readView: typeof readAccountTrafficMonitorView,
): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const formatAscii = (value: string): string =>
    value.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, digit => String(digit.charCodeAt(0) - (digit.charCodeAt(0) >= 0x06f0 ? 0x06f0 : 0x0660)))

  document.querySelectorAll<HTMLElement>('[data-account-traffic-monitor]').forEach(root => {
    if (root.dataset.trafficMonitorBound === 'true') return
    root.dataset.trafficMonitorBound = 'true'

    const send = (window as Window & { xpanelSessionRequest?: TrafficTransport }).xpanelSessionRequest
    const refresh = root.querySelector<HTMLButtonElement>('[data-traffic-monitor-refresh]')
    const status = root.querySelector<HTMLElement>('[data-traffic-monitor-status]')
    const dailyBody = root.querySelector<HTMLElement>('[data-traffic-monitor-daily]')
    const requestsBody = root.querySelector<HTMLElement>('[data-traffic-monitor-requests]')
    const agentsBody = root.querySelector<HTMLElement>('[data-traffic-monitor-agents]')
    const ipsBody = root.querySelector<HTMLElement>('[data-traffic-monitor-ips]')
    const factRequests = root.querySelector<HTMLElement>('[data-traffic-monitor-fact="requests"]')
    const factVisitors = root.querySelector<HTMLElement>('[data-traffic-monitor-fact="visitors"]')
    const factErrors = root.querySelector<HTMLElement>('[data-traffic-monitor-fact="errors"]')
    const factBlocked = root.querySelector<HTMLElement>('[data-traffic-monitor-fact="blocked"]')
    if (!refresh || !status || !dailyBody || !requestsBody || !agentsBody || !ipsBody) return

    try {
      cloneClientTemplate(clientTemplate(root, 'traffic-monitor-daily-row'), 'tr', ['date', 'visitors', 'requests'])
      cloneClientTemplate(clientTemplate(root, 'traffic-monitor-daily-empty'), 'tr', ['message'])
      cloneClientTemplate(clientTemplate(root, 'traffic-monitor-request-row'), 'tr', ['time', 'method', 'path', 'status', 'ip', 'agent'])
      cloneClientTemplate(clientTemplate(root, 'traffic-monitor-request-empty'), 'tr', ['message'])
      cloneClientTemplate(clientTemplate(root, 'traffic-monitor-agent-row'), 'tr', ['agent', 'requests', 'bytes'])
      cloneClientTemplate(clientTemplate(root, 'traffic-monitor-agent-empty'), 'tr', ['message'])
      cloneClientTemplate(clientTemplate(root, 'traffic-monitor-ip-row'), 'tr', ['ip', 'requests', 'errors', 'block'])
      cloneClientTemplate(clientTemplate(root, 'traffic-monitor-ip-empty'), 'tr', ['message'])
    } catch {
      root.querySelectorAll<HTMLButtonElement>('button').forEach(control => { control.disabled = true })
      status.dataset.state = 'unavailable'
      status.textContent = t('Live traffic is unavailable here. Nothing was read.')
      return
    }

    const canRead = (): boolean => root.isConnected
      && root.dataset.trafficMonitorCanRead === 'true'
      && typeof send === 'function'
      && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const canManage = (): boolean => canRead() && root.dataset.trafficMonitorManage === 'true'

    let view: AccountTrafficMonitorClientView | null = null
    let busy = false

    const announce = (state: string, message: string): void => {
      status.dataset.state = state
      status.textContent = message
      status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status')
    }

    const syncControls = (): void => {
      const readAllowed = canRead()
      const writeAllowed = canManage() && !busy && !!view?.ipBlocker.available
      refresh.disabled = busy || !readAllowed
      ipsBody.querySelectorAll<HTMLButtonElement>('button[data-ip-value]').forEach(button => {
        button.disabled = !writeAllowed || button.dataset.ipBlocked === 'true'
      })
      root.setAttribute('aria-busy', String(busy))
    }

    const emptyRow = (container: HTMLElement, templateName: string, message: string): void => {
      const tr = cloneClientTemplate(clientTemplate(root, templateName), 'tr', ['message'])
      clientTemplateSlot(tr, 'message').textContent = message
      container.replaceChildren(tr)
    }

    const paint = (next: AccountTrafficMonitorClientView): void => {
      view = next
      if (factRequests) factRequests.textContent = next.summary ? formatAscii(String(next.summary.totalRequests)) : t('Loading...')
      if (factVisitors) factVisitors.textContent = next.summary ? formatAscii(String(next.summary.uniqueVisitors)) : t('Loading...')
      if (factErrors) factErrors.textContent = next.summary ? formatAscii(String(next.summary.error5xx)) : t('Loading...')
      if (factBlocked) factBlocked.textContent = formatAscii(String(next.ipBlocker.blockedCount))

      if (next.dailyVisitors.length) {
        dailyBody.replaceChildren(...next.dailyVisitors.map(row => {
          const tr = cloneClientTemplate(clientTemplate(root, 'traffic-monitor-daily-row'), 'tr', ['date', 'visitors', 'requests'])
          clientTemplateSlot(tr, 'date', 'bdi').textContent = formatAscii(row.date)
          clientTemplateSlot(tr, 'visitors', 'bdi').textContent = formatAscii(String(row.uniqueVisitors))
          clientTemplateSlot(tr, 'requests', 'bdi').textContent = formatAscii(String(row.requests))
          return tr
        }))
      } else {
        emptyRow(dailyBody, 'traffic-monitor-daily-empty', t('No daily visitor records were observed in this bounded log window.'))
      }

      if (next.recentRequests.length) {
        requestsBody.replaceChildren(...next.recentRequests.map(row => {
          const tr = cloneClientTemplate(clientTemplate(root, 'traffic-monitor-request-row'), 'tr', ['time', 'method', 'path', 'status', 'ip', 'agent'])
          clientTemplateSlot(tr, 'time', 'bdi').textContent = formatAscii(formatTrafficDateTime(row.time))
          clientTemplateSlot(tr, 'method', 'bdi').textContent = row.method
          clientTemplateSlot(tr, 'path', 'bdi').textContent = row.path
          clientTemplateSlot(tr, 'status', 'bdi').textContent = formatAscii(String(row.status))
          clientTemplateSlot(tr, 'ip', 'bdi').textContent = formatAscii(row.ip)
          clientTemplateSlot(tr, 'agent', 'bdi').textContent = row.agent
          return tr
        }))
      } else {
        emptyRow(requestsBody, 'traffic-monitor-request-empty', t('No recent requests were observed in this access log.'))
      }

      if (next.topUserAgents.length) {
        agentsBody.replaceChildren(...next.topUserAgents.map(row => {
          const tr = cloneClientTemplate(clientTemplate(root, 'traffic-monitor-agent-row'), 'tr', ['agent', 'requests', 'bytes'])
          clientTemplateSlot(tr, 'agent', 'bdi').textContent = row.agent
          clientTemplateSlot(tr, 'requests', 'bdi').textContent = formatAscii(String(row.requests))
          clientTemplateSlot(tr, 'bytes', 'bdi').textContent = formatAscii(formatTrafficBytes(row.bytes))
          return tr
        }))
      } else {
        emptyRow(agentsBody, 'traffic-monitor-agent-empty', t('No user agents were recorded.'))
      }

      if (next.topClientIps.length) {
        ipsBody.replaceChildren(...next.topClientIps.map(row => {
          const tr = cloneClientTemplate(clientTemplate(root, 'traffic-monitor-ip-row'), 'tr', ['ip', 'requests', 'errors', 'block'])
          clientTemplateSlot(tr, 'ip', 'bdi').textContent = formatAscii(row.ip)
          clientTemplateSlot(tr, 'requests', 'bdi').textContent = formatAscii(String(row.requests))
          clientTemplateSlot(tr, 'errors', 'bdi').textContent = formatAscii(String(row.errors))
          const blockBtn = clientTemplateSlot(tr, 'block', 'button') as HTMLButtonElement
          blockBtn.dataset.ipValue = row.ip
          blockBtn.dataset.ipBlocked = String(row.blocked)
          blockBtn.textContent = row.blocked ? t('Blocked') : t('Block IP')
          blockBtn.addEventListener('click', () => { void blockIp(row.ip) })
          return tr
        }))
      } else {
        emptyRow(ipsBody, 'traffic-monitor-ip-empty', t('No client addresses were recorded.'))
      }
      syncControls()
    }

    const load = async (afterMessage?: string): Promise<void> => {
      if (busy || !canRead()) return
      busy = true
      syncControls()
      announce('reading', t('Reading live traffic telemetry…'))
      const domain = (root.dataset.trafficMonitorDomain ?? '').trim()
      const query = domain ? '?domain=' + encodeURIComponent(domain) : ''
      try {
        const next = readView(await send!('GET', '/api/account/traffic-monitor' + query), domain || undefined)
        if (!canRead()) return
        paint(next)
        if (afterMessage) announce('saved', afterMessage)
        else if (next.state === 'no_domains') announce('empty', t('This account has no domains to observe traffic for.'))
        else announce('read', t('Live traffic telemetry read from the access log.'))
      } catch {
        announce('failed', t('Live traffic telemetry could not be read.'))
      } finally {
        busy = false
        syncControls()
      }
    }

    const blockIp = async (ip: string): Promise<void> => {
      if (busy || !canManage() || !view || !view.ipBlocker.available) return
      if (askDialog) {
        const approved = await askDialog({
          title: t('Block this IP address?'),
          body: ip + '\n' + t('Requests from these addresses get HTTP 403 on every website of this account.'),
          confirm: t('Block IP'),
          danger: true,
        }).catch(() => false)
        if (approved !== true || !canManage()) return
      }
      const capturedRevision = view.ipBlocker.revision
      busy = true
      syncControls()
      announce('saving', t('Blocking client IP address…'))
      try {
        const reply = await send!('POST', '/api/account/traffic-monitor/block-ip', { expectedRevision: capturedRevision, ip })
        if (!reply || typeof reply !== 'object' || (reply as { stateChanged?: unknown }).stateChanged !== true) {
          throw new Error('invalid_block_ack')
        }
        busy = false
        await load(t('Client IP blocked and read back.'))
      } catch (error) {
        const err = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}
        const unchanged = err.details?.stateChanged === false || err.status === 400 || err.status === 403 || err.status === 409 || err.status === 422
        announce(unchanged ? 'failed' : 'uncertain', unchanged
          ? t('The IP block request was refused. Reload live traffic before retrying.')
          : t('The IP block outcome is uncertain. Reload live traffic before retrying.'))
      } finally {
        busy = false
        syncControls()
      }
    }

    if (!canRead()) {
      syncControls()
      announce('unavailable', t('Live traffic is unavailable here. Nothing was read.'))
      return
    }
    refresh.addEventListener('click', () => { void load() })
    void load()
  })
}

export const ACCOUNT_TRAFFIC_MONITOR_CLIENT_BINDING = `(function(askDialog){const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const formatTrafficBytes=${ASCII_BYTES_BINDING};const formatTrafficDateTime=${DISPLAY_DATETIME_BINDING};const readAccountTrafficMonitorView=${readAccountTrafficMonitorView.toString()};return (${bindAccountTrafficMonitor.toString()})(askDialog,readAccountTrafficMonitorView);})`
